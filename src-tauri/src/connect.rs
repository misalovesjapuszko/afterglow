//! Spotify Connect remote control without the public Web API, for the logins that use one of
//! Spotify's own client IDs (see pathfinder.rs for why). Afterglow joins the account's Connect
//! session as a hidden remote, the way the web player does:
//!
//! 1. a websocket to Spotify's "dealer" gives us a connection id (and stays open, pinged);
//! 2. PUT connect-state/v1/devices/hobs_<id> registers a hidden, non-playing device and answers
//!    with the whole cluster: every device, the player state, the queue;
//! 3. commands go to POST connect-state/v1/player/command/from/<us>/to/<device>.
//!
//! [call] takes the UI's Web API player requests (/me/player/...) and answers them from that,
//! in Web API shapes, so the player code doesn't change.

use std::collections::HashMap;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::Message;

use crate::pathfinder::{self, Reply};

const DEALER_HOST: &str = "dealer.spotify.com";
const CS: &str = "https://spclient.wg.spotify.com/connect-state/v1";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const WEB_API: &str = "https://api.spotify.com/v1";

struct Link {
    conn_id: String,
    token: String,
    alive: Arc<AtomicBool>,
}

static LINK: Mutex<Option<Link>> = Mutex::new(None);
static CLUSTER: Mutex<Option<(Instant, Value)>> = Mutex::new(None);
/// Full track objects by URI (Connect itself only sends title, album and cover).
static TRACKS: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);

/// Our hidden remote's device id, new for each launch.
fn device_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        let mut b = [0u8; 20];
        let _ = getrandom::fill(&mut b);
        b.iter().map(|x| format!("{x:02x}")).collect()
    })
}

fn http_err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Opens the dealer websocket and returns its connection id. A thread keeps it alive.
fn open_link(token: &str) -> Result<Link, String> {
    let mut req = format!("wss://{DEALER_HOST}/?access_token={token}").into_client_request().map_err(http_err)?;
    req.headers_mut().insert("Origin", "https://open.spotify.com".parse().unwrap());
    req.headers_mut().insert("User-Agent", UA.parse().unwrap());
    let tcp = TcpStream::connect((DEALER_HOST, 443)).map_err(http_err)?;
    tcp.set_read_timeout(Some(Duration::from_secs(15))).map_err(http_err)?;
    let (mut ws, _) = tungstenite::client_tls(req, tcp).map_err(|e| format!("dealer: {e}"))?;
    // the first message carries the connection id in its headers
    let conn_id = loop {
        match ws.read().map_err(|e| format!("dealer: {e}"))? {
            Message::Text(t) => {
                let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
                if let Some(id) = v["headers"]["Spotify-Connection-Id"].as_str() {
                    break id.to_string();
                }
            }
            Message::Close(_) => return Err("dealer closed".into()),
            _ => {}
        }
    };
    // short reads from now on, so the thread can ping in between
    match ws.get_ref() {
        MaybeTlsStream::Plain(s) => s.set_read_timeout(Some(Duration::from_millis(500))).map_err(http_err)?,
        MaybeTlsStream::Rustls(s) => s.get_ref().set_read_timeout(Some(Duration::from_millis(500))).map_err(http_err)?,
        _ => {}
    }
    let alive = Arc::new(AtomicBool::new(true));
    let flag = alive.clone();
    std::thread::spawn(move || {
        let mut last_ping = Instant::now();
        while flag.load(Ordering::Relaxed) {
            match ws.read() {
                Ok(Message::Text(t)) => {
                    // the player or the device list changed somewhere: next read is fresh
                    if t.as_str().contains("hm://connect-state/v1/") {
                        *CLUSTER.lock().unwrap() = None;
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(_) => break,
            }
            if last_ping.elapsed() > Duration::from_secs(30) {
                last_ping = Instant::now();
                if ws.send(Message::text(r#"{"type":"ping"}"#)).is_err() {
                    break;
                }
            }
        }
        flag.store(false, Ordering::Relaxed);
        let _ = ws.close(None);
    });
    Ok(Link { conn_id, token: token.to_string(), alive })
}

/// The connection id of a live dealer link for [token], opening one when needed.
fn conn_id(token: &str, fresh: bool) -> Result<String, String> {
    let mut g = LINK.lock().unwrap();
    let usable = g.as_ref().is_some_and(|l| l.alive.load(Ordering::Relaxed) && !fresh && l.token == token);
    if !usable {
        if let Some(old) = g.take() {
            old.alive.store(false, Ordering::Relaxed);
        }
        *g = Some(open_link(token)?);
    }
    Ok(g.as_ref().unwrap().conn_id.clone())
}

/// Forget the link (after a logout).
pub fn forget() {
    if let Some(l) = LINK.lock().unwrap().take() {
        l.alive.store(false, Ordering::Relaxed);
    }
    *CLUSTER.lock().unwrap() = None;
}

fn agent() -> ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT
        .get_or_init(|| ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(15))).http_status_as_error(false).build().into())
        .clone()
}

struct Res {
    status: u16,
    body: String,
    retry: Option<u64>,
}

fn send(token: &str, method: &str, url: &str, body: &Value, conn: Option<&str>) -> Result<Res, String> {
    let a = agent();
    let auth = format!("Bearer {token}");
    let text = body.to_string();
    let mut b = match method {
        "PUT" => a.put(url),
        _ => a.post(url),
    }
    .header("Authorization", &auth)
    .header("User-Agent", UA)
    .header("app-platform", "WebPlayer")
    .header("Accept", "application/json");
    if let Some(c) = conn {
        b = b.header("X-Spotify-Connection-Id", c);
    }
    let mut res = b.content_type("application/json").send(text.as_str()).map_err(http_err)?;
    let status = res.status().as_u16();
    let retry = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
    let body = res.body_mut().with_config().limit(16 * 1024 * 1024).read_to_string().unwrap_or_default();
    Ok(Res { status, body, retry })
}

/// The account's Connect cluster (devices + player state), at most [max_age] old. The dealer
/// link drops the cached copy as soon as Spotify says something changed.
fn cluster(token: &str, max_age: Duration) -> Result<Value, Res> {
    if let Some((at, c)) = CLUSTER.lock().unwrap().as_ref() {
        if at.elapsed() < max_age {
            return Ok(c.clone());
        }
    }
    let url = format!("{CS}/devices/hobs_{}", device_id());
    let body = json!({
        "member_type": "CONNECT_STATE",
        "device": { "device_info": { "capabilities": { "can_be_player": false, "hidden": true, "needs_full_player_state": true } } },
    });
    let mut res = Res { status: 0, body: String::new(), retry: None };
    for attempt in 0..2 {
        let conn = conn_id(token, attempt > 0).map_err(|e| Res { status: 502, body: e, retry: None })?;
        res = send(token, "PUT", &url, &body, Some(&conn)).map_err(|e| Res { status: 502, body: e, retry: None })?;
        if res.status < 400 || res.status == 429 || res.status == 401 {
            break;
        }
        // the dealer link went stale: open a new one and register again
    }
    if res.status >= 400 {
        return Err(res);
    }
    let c: Value = serde_json::from_str(&res.body).map_err(|e| Res { status: 502, body: e.to_string(), retry: None })?;
    *CLUSTER.lock().unwrap() = Some((Instant::now(), c.clone()));
    Ok(c)
}

fn n(v: &Value) -> u64 {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap_or(0)
}

fn image(meta: &Value, key: &str) -> Option<String> {
    meta[key].as_str().map(|u| u.strip_prefix("spotify:image:").map(|id| format!("https://i.scdn.co/image/{id}")).unwrap_or_else(|| u.to_string()))
}

/// Full Track objects for these URIs: from the cache, or one pathfinder call for the rest.
fn tracks(token: &str, items: &[&Value]) -> Vec<Value> {
    let uris: Vec<String> = items.iter().filter_map(|t| t["uri"].as_str().map(String::from)).collect();
    let missing: Vec<&String> = {
        let g = TRACKS.lock().unwrap();
        uris.iter().filter(|u| u.starts_with("spotify:track:") && !g.as_ref().is_some_and(|m| m.contains_key(*u))).collect()
    };
    if !missing.is_empty() {
        if let Ok(list) = pathfinder::decorate_tracks(token, &missing) {
            let mut g = TRACKS.lock().unwrap();
            let m = g.get_or_insert_with(HashMap::new);
            if m.len() > 2000 {
                m.clear();
            }
            for t in list {
                if let Some(u) = t["uri"].as_str() {
                    m.insert(u.to_string(), t);
                }
            }
        }
    }
    let g = TRACKS.lock().unwrap();
    items
        .iter()
        .map(|t| {
            let uri = t["uri"].as_str().unwrap_or("");
            g.as_ref().and_then(|m| m.get(uri)).cloned().unwrap_or_else(|| fallback_track(t))
        })
        .collect()
}

/// A Track object from Connect's own metadata (no artist names in there).
fn fallback_track(t: &Value) -> Value {
    let m = &t["metadata"];
    let uri = t["uri"].as_str().unwrap_or("");
    let images: Vec<Value> = [("image_large_url", 640), ("image_url", 300), ("image_small_url", 64)]
        .iter()
        .filter_map(|(k, w)| image(m, k).map(|u| json!({ "url": u, "width": w, "height": w })))
        .collect();
    let album_uri = m["album_uri"].as_str().unwrap_or("");
    json!({
        "uri": uri, "id": uri.rsplit(':').next().unwrap_or(""), "name": m["title"], "type": "track", "is_local": false,
        "artists": m["artist_uri"].as_str().map(|a| vec![json!({ "uri": a, "id": a.rsplit(':').next().unwrap_or(""), "name": m["artist_name"].as_str().unwrap_or("") })]).unwrap_or_default(),
        "album": { "uri": album_uri, "id": album_uri.rsplit(':').next().unwrap_or(""), "name": m["album_title"], "images": images },
        "duration_ms": n(&m["duration"]),
    })
}

fn device_obj(d: &Value, active: &str) -> Value {
    let id = d["device_id"].as_str().unwrap_or("");
    json!({
        "id": id,
        "name": d["name"],
        "type": d["device_type"].as_str().map(|t| t[..1].to_uppercase() + &t[1..].to_lowercase()).unwrap_or_default(),
        "is_active": id == active,
        "is_restricted": false,
        "volume_percent": (n(&d["volume"]) * 100 + 32767) / 65535,
        "supports_volume": true,
    })
}

fn devices(c: &Value) -> Vec<&Value> {
    let mut v: Vec<&Value> = c["devices"].as_object().map(|o| o.values().filter(|d| d["device_id"].as_str() != Some(device_id())).collect()).unwrap_or_default();
    v.sort_by_key(|d| d["name"].as_str().unwrap_or("").to_lowercase());
    v
}

fn player(token: &str, c: &Value) -> Option<Value> {
    let ps = &c["player_state"];
    let track = &ps["track"];
    track["uri"].as_str().filter(|u| !u.is_empty())?;
    let active = c["active_device_id"].as_str().unwrap_or("");
    let playing = ps["is_playing"].as_bool().unwrap_or(false) && !ps["is_paused"].as_bool().unwrap_or(false);
    let duration = n(&ps["duration"]);
    let mut pos = n(&ps["position_as_of_timestamp"]);
    if playing {
        let speed = ps["playback_speed"].as_f64().unwrap_or(1.0);
        let elapsed = n(&c["server_timestamp_ms"]).saturating_sub(n(&ps["timestamp"]));
        pos += (elapsed as f64 * speed) as u64;
    }
    if duration > 0 {
        pos = pos.min(duration);
    }
    let mut item = tracks(token, &[track]).remove(0);
    if duration > 0 {
        item["duration_ms"] = json!(duration);
    }
    let o = &ps["options"];
    let repeat = if o["repeating_track"].as_bool() == Some(true) {
        "track"
    } else if o["repeating_context"].as_bool() == Some(true) {
        "context"
    } else {
        "off"
    };
    let device = c["devices"][active].clone();
    Some(json!({
        "is_playing": playing,
        "progress_ms": pos,
        "item": item,
        "currently_playing_type": "track",
        "device": if device.is_object() { device_obj(&device, active) } else { Value::Null },
        "shuffle_state": o["shuffling_context"].as_bool().unwrap_or(false),
        "repeat_state": repeat,
        "context": ps["context_uri"].as_str().filter(|u| !u.is_empty()).map(|u| json!({ "uri": u })),
        "timestamp": n(&c["server_timestamp_ms"]),
    }))
}

fn queue(token: &str, c: &Value) -> Value {
    let ps = &c["player_state"];
    let next: Vec<&Value> = ps["next_tracks"]
        .as_array()
        .map(|a| a.iter().filter(|t| t["uri"].as_str().is_some_and(|u| u.starts_with("spotify:track:"))).take(30).collect())
        .unwrap_or_default();
    let current = ps["track"]["uri"].as_str().filter(|u| !u.is_empty()).map(|_| tracks(token, &[&ps["track"]]).remove(0));
    json!({ "currently_playing": current, "queue": tracks(token, &next) })
}

/// Which device a command goes to: the one asked for, else the active one, else this app's.
fn target(c: &Value, asked: Option<&str>) -> Option<String> {
    if let Some(id) = asked.filter(|s| !s.is_empty()) {
        return Some(id.to_string());
    }
    if let Some(a) = c["active_device_id"].as_str().filter(|s| !s.is_empty()) {
        return Some(a.to_string());
    }
    let list = devices(c);
    list.iter().find(|d| d["name"].as_str() == Some("Afterglow")).or(list.first()).and_then(|d| d["device_id"].as_str()).map(String::from)
}

fn no_device() -> Reply {
    Reply { status: 404, body: json!({ "error": { "status": 404, "message": "No active device found", "reason": "NO_ACTIVE_DEVICE" } }), retry_after: None }
}

fn fail(r: Res) -> Reply {
    let body = serde_json::from_str::<Value>(&r.body)
        .ok()
        .filter(|v| v["error"]["message"].is_string())
        .unwrap_or_else(|| json!({ "error": { "status": r.status, "message": if r.body.is_empty() || r.body.starts_with('{') { format!("Spotify said {}", r.status) } else { r.body.clone() } } }));
    Reply { status: r.status, body, retry_after: r.retry }
}

fn done() -> Reply {
    *CLUSTER.lock().unwrap() = None;
    Reply { status: 204, body: Value::Null, retry_after: None }
}

fn command(token: &str, to: &str, cmd: Value) -> Reply {
    let url = format!("{CS}/player/command/from/{}/to/{to}", device_id());
    match send(token, "POST", &url, &json!({ "command": cmd }), None) {
        Ok(r) if r.status < 300 => done(),
        Ok(r) => fail(r),
        Err(e) => fail(Res { status: 502, body: e, retry: None }),
    }
}

fn play(token: &str, to: &str, body: &Value) -> Reply {
    let offset = &body["offset"];
    let skip = if let Some(u) = offset["uri"].as_str() {
        json!({ "track_uri": u })
    } else if let Some(i) = offset["position"].as_u64() {
        json!({ "track_index": i })
    } else {
        json!({})
    };
    let context = if let Some(ctx) = body["context_uri"].as_str() {
        json!({ "uri": ctx, "url": format!("context://{ctx}"), "metadata": {} })
    } else if let Some(list) = body["uris"].as_array() {
        // a plain list of songs plays as a context made of one page of them
        let tracks: Vec<Value> = list.iter().filter_map(|u| u.as_str()).map(|u| json!({ "uri": u, "uid": "" })).collect();
        json!({ "uri": "", "url": "", "metadata": {}, "pages": [{ "tracks": tracks }] })
    } else {
        return command(token, to, json!({ "endpoint": "resume" }));
    };
    let mut options = json!({ "license": "tft", "skip_to": skip, "player_options_override": {} });
    if let Some(ms) = body["position_ms"].as_u64() {
        options["seek_to"] = json!(ms);
    }
    command(
        token,
        to,
        json!({
            "context": context,
            "play_origin": { "feature_identifier": "afterglow", "feature_version": env!("CARGO_PKG_VERSION") },
            "options": options,
            "endpoint": "play",
        }),
    )
}

fn transfer(token: &str, to: &str, play: bool) -> Reply {
    let url = format!("{CS}/connect/transfer/from/{}/to/{to}", device_id());
    match send(token, "POST", &url, &json!({ "transfer_options": { "restore_paused": if play { "resume" } else { "restore" } } }), None) {
        Ok(r) if r.status < 300 => done(),
        Ok(r) => fail(r),
        Err(e) => fail(Res { status: 502, body: e, retry: None }),
    }
}

fn volume(token: &str, to: &str, pct: u64) -> Reply {
    let url = format!("{CS}/connect/volume/from/{}/to/{to}", device_id());
    match send(token, "PUT", &url, &json!({ "volume": pct.min(100) * 65535 / 100 }), None) {
        Ok(r) if r.status < 300 => done(),
        Ok(r) => fail(r),
        Err(e) => fail(Res { status: 502, body: e, retry: None }),
    }
}

fn query_map(url: &str) -> HashMap<String, String> {
    url.split_once('?')
        .map(|(_, q)| {
            q.split('&')
                .filter_map(|kv| {
                    let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
                    Some((k.to_string(), pathfinder::percent_decode(v)))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Answers a Web API player request through Spotify Connect, or None if it isn't one.
pub fn call(token: &str, method: &str, url: &str, body: Option<&str>) -> Option<Reply> {
    let rest = url.strip_prefix(WEB_API)?;
    let path = rest.split('?').next().unwrap_or("");
    let path = path.strip_prefix("/me/player")?;
    if path == "/recently-played" {
        return None;
    }
    let q = query_map(url);
    let body: Value = body.and_then(|b| serde_json::from_str(b).ok()).unwrap_or(Value::Null);
    // reads want the latest state; commands only need to know where to send, so a recent copy does
    let max_age = Duration::from_millis(if method == "GET" { 1200 } else { 10_000 });
    let c = match cluster(token, max_age) {
        Ok(c) => c,
        Err(r) => return Some(fail(r)),
    };
    let asked = q.get("device_id").map(|s| s.as_str());
    let to = || target(&c, asked);
    Some(match (method, path) {
        ("GET", "") => match player(token, &c) {
            Some(p) => Reply { status: 200, body: p, retry_after: None },
            None => Reply { status: 204, body: Value::Null, retry_after: None },
        },
        ("GET", "/currently-playing") => match player(token, &c) {
            Some(p) => Reply { status: 200, body: p, retry_after: None },
            None => Reply { status: 204, body: Value::Null, retry_after: None },
        },
        ("GET", "/devices") => {
            let active = c["active_device_id"].as_str().unwrap_or("");
            Reply { status: 200, body: json!({ "devices": devices(&c).iter().map(|d| device_obj(d, active)).collect::<Vec<_>>() }), retry_after: None }
        }
        ("GET", "/queue") => Reply { status: 200, body: queue(token, &c), retry_after: None },
        ("PUT", "") => match body["device_ids"].as_array().and_then(|a| a.first()).and_then(|v| v.as_str()) {
            Some(id) => transfer(token, id, body["play"].as_bool().unwrap_or(false)),
            None => Reply { status: 400, body: json!({ "error": { "status": 400, "message": "device_ids missing" } }), retry_after: None },
        },
        _ => {
            let Some(to) = to() else { return Some(no_device()) };
            match (method, path) {
                ("PUT", "/play") => {
                    // resuming on a device that isn't playing anything: move playback there
                    if body.is_null() && c["active_device_id"].as_str() != Some(to.as_str()) && c["active_device_id"].as_str().is_some() {
                        transfer(token, &to, true)
                    } else {
                        play(token, &to, &body)
                    }
                }
                ("PUT", "/pause") => command(token, &to, json!({ "endpoint": "pause" })),
                ("POST", "/next") => command(token, &to, json!({ "endpoint": "skip_next" })),
                ("POST", "/previous") => command(token, &to, json!({ "endpoint": "skip_prev" })),
                ("PUT", "/seek") => command(token, &to, json!({ "endpoint": "seek_to", "value": q.get("position_ms").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) })),
                ("PUT", "/shuffle") => command(token, &to, json!({ "endpoint": "set_shuffling_context", "value": q.get("state").map(|s| s == "true").unwrap_or(false) })),
                ("PUT", "/repeat") => {
                    let st = q.get("state").map(|s| s.as_str()).unwrap_or("off");
                    command(token, &to, json!({ "endpoint": "set_options", "repeating_context": st != "off", "repeating_track": st == "track" }))
                }
                ("PUT", "/volume") => volume(token, &to, q.get("volume_percent").and_then(|v| v.parse().ok()).unwrap_or(50)),
                ("POST", "/queue") => match q.get("uri") {
                    Some(u) => command(token, &to, json!({ "endpoint": "add_to_queue", "track": { "uri": u, "metadata": { "is_queued": "true" }, "provider": "queue" } })),
                    None => Reply { status: 400, body: json!({ "error": { "status": 400, "message": "uri missing" } }), retry_after: None },
                },
                _ => Reply { status: 404, body: json!({ "error": { "status": 404, "message": "not supported" } }), retry_after: None },
            }
        }
    })
}

/// Live checks against a real Connect device named "Afterglow":
/// `AFTERGLOW_TEST_TOKEN=… cargo test --lib connect::live -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;

    fn token() -> String {
        std::env::var("AFTERGLOW_TEST_TOKEN").expect("set AFTERGLOW_TEST_TOKEN")
    }

    fn req(method: &str, path: &str, body: Option<Value>) -> Reply {
        let b = body.map(|b| b.to_string());
        let r = call(&token(), method, &format!("{WEB_API}{path}"), b.as_deref()).expect("handled");
        assert!(r.status < 300, "{method} {path}: {} {}", r.status, r.body);
        r
    }

    fn now() -> Value {
        std::thread::sleep(Duration::from_millis(2500));
        *CLUSTER.lock().unwrap() = None;
        req("GET", "/me/player", None).body
    }

    #[test]
    #[ignore]
    fn plays_and_controls() {
        let devs = req("GET", "/me/player/devices", None).body;
        println!("devices: {}", devs["devices"].as_array().unwrap().iter().map(|d| format!("{} ({})", d["name"], d["type"])).collect::<Vec<_>>().join(", "));
        let dev = devs["devices"].as_array().unwrap().iter().find(|d| d["name"] == "Afterglow").expect("Afterglow device")["id"].as_str().unwrap().to_string();
        let q = format!("?device_id={dev}");

        // a public playlist, started at its 5th song
        let rows = crate::pathfinder::call(&token(), "GET", &format!("{WEB_API}/playlists/37i9dQZF1DXcBWIGoYBM5M/items?offset=4&limit=1"), None).unwrap().body;
        let pick = rows["items"][0]["track"]["uri"].as_str().unwrap().to_string();
        req("PUT", &format!("/me/player/play{q}"), Some(json!({ "context_uri": "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", "offset": { "uri": pick } })));
        let p = now();
        println!("playlist at song: {} - {} (playing {}, shuffle {})", p["item"]["name"], p["item"]["artists"][0]["name"], p["is_playing"], p["shuffle_state"]);
        assert_eq!(p["item"]["uri"], json!(pick));
        assert!(p["item"]["artists"][0]["name"].as_str().is_some_and(|n| !n.is_empty()));

        let qu = req("GET", "/me/player/queue", None).body;
        println!("up next: {} songs, first {} - {}", qu["queue"].as_array().unwrap().len(), qu["queue"][0]["name"], qu["queue"][0]["artists"][0]["name"]);

        let list = ["spotify:track:4uLU6hMCjMI75M1A2tKUQC", "spotify:track:6b5P51m8xx2XA6U7sdNZ5E", "spotify:track:5tOVc7CGhjt5KsuDIreM5B"];
        req("PUT", &format!("/me/player/play{q}"), Some(json!({ "uris": list, "offset": { "position": 1 } })));
        let p = now();
        println!("song list at #2: {} (context {})", p["item"]["name"], p["context"]);
        assert_eq!(p["item"]["uri"], json!(list[1]));

        // Liked Songs plays as a song list (above); devices can't open "spotify:collection:tracks"
        req("PUT", "/me/player/pause", None);
        assert_eq!(now()["is_playing"], json!(false));
        req("PUT", "/me/player/play", None);
        assert_eq!(now()["is_playing"], json!(true));
        req("PUT", "/me/player/seek?position_ms=60000", None);
        let p = now();
        println!("after seek: {} ms", p["progress_ms"]);
        assert!(p["progress_ms"].as_u64().unwrap() >= 59_000);
        req("POST", &format!("/me/player/queue?uri={}", crate::pathfinder::percent_decode(list[0])), None);
        std::thread::sleep(Duration::from_millis(1500));
        *CLUSTER.lock().unwrap() = None;
        let qu = req("GET", "/me/player/queue", None).body;
        println!("queued first: {}", qu["queue"][0]["name"]);
        assert_eq!(qu["queue"][0]["uri"], json!(list[0]));
        req("POST", "/me/player/next", None);
        assert_eq!(now()["item"]["uri"], json!(list[0]));
        req("PUT", "/me/player/shuffle?state=true", None);
        req("PUT", "/me/player/repeat?state=context", None);
        let p = now();
        println!("shuffle {} repeat {}", p["shuffle_state"], p["repeat_state"]);
        req("PUT", "/me/player/pause", None);
    }

    #[test]
    #[ignore]
    fn volume_and_transfer() {
        req("PUT", "/me/player/volume?volume_percent=40", None);
        let v = now()["device"]["volume_percent"].clone();
        println!("volume now {v}");
        req("PUT", "/me/player/volume?volume_percent=100", None);
        assert_eq!(v, json!(40));
        let dev = now()["device"]["id"].as_str().unwrap().to_string();
        req("PUT", "/me/player", Some(json!({ "device_ids": [dev], "play": false })));
        println!("transfer to the same device: ok");
    }
}
