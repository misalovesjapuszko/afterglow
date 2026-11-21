//! Spotify's own web-player API ("pathfinder", persisted GraphQL queries) for the logins that
//! use one of Spotify's own client IDs: "Sign in with Spotify" (web player) and "Sign in with
//! browser" (desktop app). Since July 2026 the public Web API (api.spotify.com) has a small
//! daily quota per client ID, and those client IDs are shared by everyone who uses them, so the
//! Web API answers 429 QUOTA_EXCEEDED to them for a whole day. The web player's own API has no
//! such quota.
//!
//! The UI keeps talking Web API: [call] takes the same method + URL, asks pathfinder, and
//! reshapes the answer into the Web API's JSON. Requests it doesn't know return None and go to
//! the Web API as before (playback control, creating and renaming playlists).
//!
//! Query hashes change when Spotify ships a new web player. Built-in ones are used first; a
//! stale one (HTTP 412) makes us read the current ones from the web player's public scripts.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{json, Value};

const PF_URL: &str = "https://api-partner.spotify.com/pathfinder/v2/query";
const SPCLIENT: &str = "https://spclient.wg.spotify.com";
const WEB_PLAYER: &str = "https://open.spotify.com/";
const CDN: &str = "https://open.spotifycdn.com/cdn/build/web-player/";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const WEB_API: &str = "https://api.spotify.com/v1";

/// Hashes as of web player 2026-11-21. Refreshed at run time when Spotify changes them.
const BUILTIN: &[(&str, &str)] = &[
    ("profileAttributes", "08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0"),
    ("fetchLibraryTracks", "087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240"),
    ("libraryV3", "390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455"),
    ("fetchPlaylist", "21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf"),
    ("fetchPlaylistContents", "21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf"),
    ("getAlbum", "0b6ce3511e1b02e4a40fa95440f992acbe85080eb308af9194322d708fc1914f"),
    ("queryArtistOverview", "eafb1620d783ece118e72fbfede2b0064483e029d3c1aafafa1c2de0e25a89e7"),
    ("queryArtistDiscographyAlbums", "5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599"),
    ("queryArtistDiscographySingles", "5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599"),
    ("queryArtistDiscographyCompilations", "5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599"),
    ("searchDesktop", "eef7cc54888d91bdd6802623477873caa3948ae173a0c34fd86827b267e94c03"),
    ("searchTracks", "b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751"),
    ("userTopContent", "61b7353d3625780022dbc63d459eb64cd609e7e5e2a820f9160d65030efe2e15"),
    ("areEntitiesInLibrary", "134337999233cc6fdd6b1e6dbf94841409f04a946c5c7b744b09ba0dfe5a85ed"),
    ("addToLibrary", "896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148"),
    ("removeFromLibrary", "896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148"),
    ("addToPlaylist", "b907ad6b088d5bf7680fa81198996d58398c2d55dfcdf59fcc959e0be98a418a"),
    ("removeFromPlaylist", "b907ad6b088d5bf7680fa81198996d58398c2d55dfcdf59fcc959e0be98a418a"),
    ("fetchEntitiesForRecentlyPlayed", "cf5d2e94ffd82788470788ae1f6090cc3e9e774fb8fd383580634c6e6f50f7be"),
    ("decorateContextTracks", "383de00240775c39a6afe0b1055dc562b2a3930894201f9762f3fc32a74971c7"),
];

/// What the UI gets back: the same fields the Web API path returns.
pub struct Reply {
    pub status: u16,
    pub body: Value,
    pub retry_after: Option<u64>,
}

impl Reply {
    fn ok(body: Value) -> Self {
        Reply { status: 200, body, retry_after: None }
    }
}

enum Fail {
    /// Spotify said no with this status (429 keeps its Retry-After).
    Http(u16, String, Option<u64>),
    /// The query hash is out of date.
    Stale,
    Other(String),
}

impl From<String> for Fail {
    fn from(e: String) -> Self {
        Fail::Other(e)
    }
}

type R<T> = Result<T, Fail>;

static CACHE_FILE: OnceLock<PathBuf> = OnceLock::new();
static HASHES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
static LAST_REFRESH: Mutex<Option<Instant>> = Mutex::new(None);
/// The signed-in user's username, keyed by the token it was read with.
static USER: Mutex<Option<(String, String)>> = Mutex::new(None);

/// Where fresh query hashes are kept between launches.
pub fn init(data_dir: PathBuf) {
    let _ = CACHE_FILE.set(data_dir.join("pathfinder.json"));
}

/// Forget the cached user (after a logout).
pub fn forget() {
    *USER.lock().unwrap() = None;
}

/// One shared agent, so connections to Spotify are kept open and reused between requests.
fn agent() -> ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT
        .get_or_init(|| ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(20))).http_status_as_error(false).build().into())
        .clone()
}

fn hash_of(op: &str) -> Option<String> {
    let mut g = HASHES.lock().unwrap();
    let map = g.get_or_insert_with(|| {
        let mut m: HashMap<String, String> = BUILTIN.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        if let Some(saved) = CACHE_FILE.get().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
            if let Some(o) = saved["ops"].as_object() {
                for (k, v) in o {
                    if let Some(h) = v.as_str() {
                        m.insert(k.clone(), h.to_string());
                    }
                }
            }
        }
        m
    });
    map.get(op).cloned()
}

fn get_text(url: &str) -> Result<String, String> {
    let mut res = agent().get(url).header("User-Agent", UA).call().map_err(|e| e.to_string())?;
    if res.status().as_u16() >= 400 {
        return Err(format!("HTTP {} for {url}", res.status().as_u16()));
    }
    res.body_mut().with_config().limit(32 * 1024 * 1024).read_to_string().map_err(|e| e.to_string())
}

/// Reads the current query hashes from the web player's public scripts.
fn refresh_hashes() -> Result<(), String> {
    {
        let mut last = LAST_REFRESH.lock().unwrap();
        if last.is_some_and(|t| t.elapsed() < Duration::from_secs(600)) {
            return Err("query hashes were refreshed a moment ago".into());
        }
        *last = Some(Instant::now());
    }
    let op_re = Regex::new(r#""([A-Za-z0-9]+)","(?:query|mutation)","([0-9a-f]{64})""#).unwrap();
    let wanted: HashSet<&str> = BUILTIN.iter().map(|(k, _)| *k).collect();
    let mut found: HashMap<String, String> = HashMap::new();
    let scan = |js: &str, found: &mut HashMap<String, String>| {
        for c in op_re.captures_iter(js) {
            found.entry(c[1].to_string()).or_insert_with(|| c[2].to_string());
        }
    };
    let html = get_text(WEB_PLAYER)?;
    let script_re = Regex::new(r#"https://open\.spotifycdn\.com/cdn/build/web-player/[A-Za-z0-9._-]+\.js"#).unwrap();
    let mains: Vec<String> = script_re.find_iter(&html).map(|m| m.as_str().to_string()).collect::<HashSet<_>>().into_iter().collect();
    let mut chunks = Vec::new();
    for url in &mains {
        let js = get_text(url)?;
        scan(&js, &mut found);
        chunks.extend(chunk_files(&js));
    }
    // most queries live in lazily loaded chunks
    for file in chunks {
        if wanted.iter().all(|w| found.contains_key(*w)) {
            break;
        }
        if let Ok(js) = get_text(&format!("{CDN}{file}")) {
            scan(&js, &mut found);
        }
    }
    if found.is_empty() {
        return Err("no queries found in the web player".into());
    }
    let mut g = HASHES.lock().unwrap();
    let map = g.get_or_insert_with(HashMap::new);
    let mut saved = serde_json::Map::new();
    for (k, v) in found.iter().filter(|(k, _)| wanted.contains(k.as_str())) {
        map.insert(k.clone(), v.clone());
        saved.insert(k.clone(), json!(v));
    }
    if let Some(p) = CACHE_FILE.get() {
        let _ = std::fs::write(p, json!({ "ops": saved }).to_string());
    }
    Ok(())
}

/// The webpack chunk files a web-player script can load ("name.hash.js").
fn chunk_files(js: &str) -> Vec<String> {
    let Some(end) = js.find(")[e]+\".js\"") else { return Vec::new() };
    let seg = &js[end.saturating_sub(80_000)..end];
    let map_re = Regex::new(r#"\{((?:\d+:"[^"]+",?)+)\}"#).unwrap();
    let pair_re = Regex::new(r#"(\d+):"([^"]+)""#).unwrap();
    let hex8 = Regex::new(r"^[0-9a-f]{8}$").unwrap();
    let maps: Vec<&str> = map_re.captures_iter(seg).map(|c| c.get(1).unwrap().as_str()).collect();
    let Some((hashes, rest)) = maps.split_last() else { return Vec::new() };
    let mut names = HashMap::new();
    for m in rest {
        for c in pair_re.captures_iter(m) {
            if !hex8.is_match(&c[2]) {
                names.insert(c[1].to_string(), c[2].to_string());
            }
        }
    }
    pair_re
        .captures_iter(hashes)
        .map(|c| format!("{}.{}.js", names.get(&c[1]).cloned().unwrap_or_else(|| c[1].to_string()), &c[2]))
        .collect()
}

fn retry_after(res: &ureq::http::Response<ureq::Body>) -> Option<u64> {
    res.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok())
}

fn query_once(token: &str, op: &str, vars: &Value) -> R<Value> {
    let hash = hash_of(op).ok_or_else(|| Fail::Other(format!("unknown query {op}")))?;
    let body = json!({
        "variables": vars,
        "operationName": op,
        "extensions": { "persistedQuery": { "version": 1, "sha256Hash": hash } },
    });
    let mut res = agent()
        .post(PF_URL)
        .header("Authorization", &format!("Bearer {token}"))
        .header("User-Agent", UA)
        .header("app-platform", "WebPlayer")
        .header("Accept", "application/json")
        .content_type("application/json;charset=UTF-8")
        .send(body.to_string().as_str())
        .map_err(|e| Fail::Other(e.to_string()))?;
    let status = res.status().as_u16();
    let retry = retry_after(&res);
    let text = res.body_mut().with_config().limit(32 * 1024 * 1024).read_to_string().unwrap_or_default();
    if status == 412 || text.contains("PersistedQueryNotFound") {
        return Err(Fail::Stale);
    }
    if status >= 400 {
        return Err(Fail::Http(status, text, retry));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| Fail::Other(e.to_string()))?;
    if v["data"].is_null() {
        let msg = v["errors"][0]["message"].as_str().unwrap_or("Spotify sent nothing back").to_string();
        return Err(Fail::Other(msg));
    }
    Ok(v["data"].clone())
}

fn query(token: &str, op: &str, vars: Value) -> R<Value> {
    match query_once(token, op, &vars) {
        Err(Fail::Stale) => {
            refresh_hashes().map_err(|e| Fail::Other(format!("Spotify changed its web player ({e})")))?;
            match query_once(token, op, &vars) {
                Err(Fail::Stale) => Err(Fail::Other("Spotify changed its web player; update Afterglow".into())),
                r => r,
            }
        }
        r => r,
    }
}

fn spclient_get(token: &str, path: &str) -> R<Value> {
    let mut res = agent()
        .get(&format!("{SPCLIENT}{path}"))
        .header("Authorization", &format!("Bearer {token}"))
        .header("User-Agent", UA)
        .header("app-platform", "WebPlayer")
        .header("Accept", "application/json")
        .call()
        .map_err(|e| Fail::Other(e.to_string()))?;
    let status = res.status().as_u16();
    let retry = retry_after(&res);
    let text = res.body_mut().with_config().limit(8 * 1024 * 1024).read_to_string().unwrap_or_default();
    if status >= 400 {
        return Err(Fail::Http(status, text, retry));
    }
    serde_json::from_str(&text).map_err(|e| Fail::Other(e.to_string()))
}

// ---- reshaping into Web API objects

fn id_of(uri: &str) -> String {
    uri.rsplit(':').next().unwrap_or("").to_string()
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn images(sources: &Value) -> Value {
    let mut out: Vec<Value> = sources
        .as_array()
        .map(|a| a.iter().filter(|x| x["url"].is_string()).map(|x| json!({ "url": x["url"], "width": x["width"], "height": x["height"] })).collect())
        .unwrap_or_default();
    // the Web API lists the largest first
    out.sort_by_key(|x| std::cmp::Reverse(x["width"].as_u64().unwrap_or(0)));
    Value::Array(out)
}

fn artist_obj(a: &Value) -> Value {
    let uri = s(&a["uri"]);
    let mut o = json!({ "name": a["profile"]["name"], "uri": uri, "id": id_of(&uri), "type": "artist" });
    if a["visuals"]["avatarImage"]["sources"].is_array() {
        o["images"] = images(&a["visuals"]["avatarImage"]["sources"]);
    }
    o
}

fn artists(list: &Value) -> Value {
    Value::Array(list["items"].as_array().map(|a| a.iter().map(artist_obj).collect()).unwrap_or_default())
}

fn release_date(d: &Value) -> String {
    let iso = s(&d["isoString"]);
    match d["precision"].as_str() {
        Some("YEAR") => iso.get(..4).unwrap_or("").to_string(),
        Some("MONTH") => iso.get(..7).unwrap_or("").to_string(),
        _ if !iso.is_empty() => iso.get(..10).unwrap_or("").to_string(),
        _ => d["year"].as_u64().map(|y| y.to_string()).unwrap_or_default(),
    }
}

fn album_obj(a: &Value) -> Value {
    let uri = s(&a["uri"]);
    let kind = match a["type"].as_str().unwrap_or("ALBUM") {
        "SINGLE" | "EP" => "single",
        "COMPILATION" => "compilation",
        _ => "album",
    };
    json!({
        "name": a["name"],
        "uri": uri,
        "id": id_of(&uri),
        "type": "album",
        "album_type": kind,
        "images": images(&a["coverArt"]["sources"]),
        "artists": artists(&a["artists"]),
        "release_date": release_date(&a["date"]),
        "total_tracks": a["tracks"]["totalCount"].as_u64().or(a["tracksV2"]["totalCount"].as_u64()),
    })
}

/// A Track object; [uri] is used when the track data itself has none.
fn track_obj(t: &Value, uri: &str, album: Option<&Value>) -> Value {
    let uri = t["uri"].as_str().unwrap_or(uri).to_string();
    let ms = t["duration"]["totalMilliseconds"].as_u64().or(t["trackDuration"]["totalMilliseconds"].as_u64()).unwrap_or(0);
    json!({
        "name": t["name"],
        "uri": uri,
        "id": id_of(&uri),
        "type": "track",
        "duration_ms": ms,
        "explicit": t["contentRating"]["label"].as_str() == Some("EXPLICIT"),
        "track_number": t["trackNumber"],
        "disc_number": t["discNumber"],
        "is_playable": t["playability"]["playable"].as_bool().unwrap_or(true),
        "is_local": false,
        "artists": artists(&t["artists"]),
        "album": album.cloned().unwrap_or_else(|| album_obj(&t["albumOfTrack"])),
    })
}

fn playlist_obj(p: &Value) -> Value {
    let uri = s(&p["uri"]);
    let owner = &p["ownerV2"]["data"];
    let owner_id = owner["username"].as_str().or(owner["id"].as_str()).unwrap_or("").to_string();
    let imgs = p["images"]["items"].as_array().and_then(|a| a.first()).map(|i| images(&i["sources"])).unwrap_or(json!([]));
    json!({
        "name": p["name"],
        "uri": uri,
        "id": id_of(&uri),
        "type": "playlist",
        "description": p["description"],
        "images": imgs,
        "owner": { "id": owner_id, "display_name": owner["name"], "uri": owner["uri"] },
        "snapshot_id": p["revisionId"],
        "collaborative": false,
    })
}

/// A playlist row: {added_at, track, item, uid}, or None for rows the UI can't show.
fn playlist_row(it: &Value) -> Option<Value> {
    let w = &it["itemV2"];
    let t = match w["__typename"].as_str() {
        Some("TrackResponseWrapper") => track_obj(&w["data"], &s(&w["_uri"]), None),
        Some("LocalTrackResponseWrapper") => json!({ "uri": w["data"]["uri"], "name": w["data"]["name"], "is_local": true }),
        _ => return None,
    };
    Some(json!({ "added_at": it["addedAt"]["isoString"], "track": t, "item": t, "uid": it["uid"] }))
}

// ---- URLs

pub fn percent_decode(v: &str) -> String {
    let b = v.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%' && i + 2 < b.len())
            .then(|| std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()))
            .flatten();
        match (b[i], hex) {
            (b'+', _) => out.push(b' '),
            (b'%', Some(x)) => {
                out.push(x);
                i += 2;
            }
            (c, _) => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn encode(v: &str) -> String {
    v.bytes()
        .map(|c| match c {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (c as char).to_string(),
            _ => format!("%{c:02X}"),
        })
        .collect()
}

struct Req {
    segs: Vec<String>,
    q: HashMap<String, String>,
}

impl Req {
    fn num(&self, k: &str, default: u64, max: u64) -> u64 {
        self.q.get(k).and_then(|v| v.parse().ok()).unwrap_or(default).min(max)
    }
    fn get(&self, k: &str) -> &str {
        self.q.get(k).map(|s| s.as_str()).unwrap_or("")
    }
    fn list(&self, k: &str) -> Vec<String> {
        self.get(k).split(',').map(str::trim).filter(|x| !x.is_empty()).map(String::from).collect()
    }
}

fn parse(url: &str) -> Option<Req> {
    let rest = url.strip_prefix(WEB_API)?;
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let segs = path.split('/').filter(|x| !x.is_empty()).map(String::from).collect();
    let q = query
        .split('&')
        .filter_map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (!k.is_empty()).then(|| (percent_decode(k), percent_decode(v)))
        })
        .collect();
    Some(Req { segs, q })
}

/// A Web API style paging block whose `next` comes back to us.
fn page(items: Vec<Value>, path: &str, offset: u64, limit: u64, total: u64, extra: &str) -> Value {
    let next = (offset + limit < total && !items.is_empty()).then(|| format!("{WEB_API}{path}?offset={}&limit={limit}{extra}", offset + limit));
    json!({ "items": items, "offset": offset, "limit": limit, "total": total, "next": next })
}

// ---- endpoints

fn username(token: &str) -> R<String> {
    if let Some((t, u)) = USER.lock().unwrap().as_ref() {
        if t == token {
            return Ok(u.clone());
        }
    }
    let me = me(token)?;
    Ok(s(&me["id"]))
}

fn me(token: &str) -> R<Value> {
    let d = query(token, "profileAttributes", json!({}))?;
    let p = &d["me"]["profile"];
    let user = p["username"].as_str().map(String::from).unwrap_or_else(|| id_of(&s(&p["uri"])));
    *USER.lock().unwrap() = Some((token.to_string(), user.clone()));
    Ok(json!({
        "id": user,
        "uri": p["uri"],
        "display_name": p["name"],
        "images": images(&p["avatar"]["sources"]),
        "type": "user",
    }))
}

fn liked(token: &str, r: &Req) -> R<Value> {
    let (offset, limit) = (r.num("offset", 0, 100_000), r.num("limit", 20, 50));
    let user = username(token)?;
    let d = query(token, "fetchLibraryTracks", json!({ "uri": format!("spotify:user:{user}:collection"), "offset": offset, "limit": limit }))?;
    let block = &d["me"]["library"]["tracks"];
    let items: Vec<Value> = block["items"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|x| x["track"]["data"]["__typename"].as_str() == Some("Track"))
                .map(|x| json!({ "added_at": x["addedAt"]["isoString"], "track": track_obj(&x["track"]["data"], &s(&x["track"]["_uri"]), None) }))
                .collect()
        })
        .unwrap_or_default();
    let total = block["totalCount"].as_u64().unwrap_or(0);
    Ok(page(items, "/me/tracks", offset, limit, total, ""))
}

/// Your Library, one kind at a time ("Playlists", "Albums", "Artists").
fn library(token: &str, kind: &str, offset: u64, limit: u64) -> R<(Vec<Value>, u64)> {
    let d = query(
        token,
        "libraryV3",
        json!({
            "filters": [kind], "order": null, "textFilter": "", "features": [],
            "limit": limit, "offset": offset,
            // playlists inside folders are listed too, without the folders themselves
            "flatten": kind == "Playlists", "expandedFolders": [], "folderUri": null, "includeFoldersWhenFlattening": false,
        }),
    )?;
    let lib = &d["me"]["libraryV3"];
    let total = lib["totalCount"].as_u64().unwrap_or(0);
    let items = lib["items"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    let data = &x["item"]["data"];
                    let obj = match data["__typename"].as_str()? {
                        "Playlist" if kind == "Playlists" => playlist_obj(data),
                        "Album" if kind == "Albums" => json!({ "added_at": x["addedAt"]["isoString"], "album": album_obj(data) }),
                        "Artist" if kind == "Artists" => artist_obj(data),
                        _ => return None,
                    };
                    Some(obj)
                })
                .collect()
        })
        .unwrap_or_default();
    Ok((items, total))
}

fn my_playlists(token: &str, r: &Req) -> R<Value> {
    let (offset, limit) = (r.num("offset", 0, 100_000), r.num("limit", 20, 50));
    let (mut items, total) = library(token, "Playlists", offset, limit)?;
    // the library list trails a removal by a few seconds; the rootlist is right at once
    if let Ok(mine) = rootlist_uris(token) {
        items.retain(|p| p["uri"].as_str().is_some_and(|u| mine.contains(u)));
    }
    Ok(page(items, "/me/playlists", offset, limit, total, ""))
}

fn my_albums(token: &str, r: &Req) -> R<Value> {
    let (offset, limit) = (r.num("offset", 0, 100_000), r.num("limit", 20, 50));
    let (items, total) = library(token, "Albums", offset, limit)?;
    Ok(page(items, "/me/albums", offset, limit, total, ""))
}

fn following(token: &str, r: &Req) -> R<Value> {
    // the Web API pages artists with an "after" cursor; ours is just the offset
    let (offset, limit) = (r.num("after", r.num("offset", 0, 100_000), 100_000), r.num("limit", 20, 50));
    let (items, total) = library(token, "Artists", offset, limit)?;
    let next = (offset + limit < total && !items.is_empty()).then(|| format!("{WEB_API}/me/following?type=artist&limit={limit}&after={}", offset + limit));
    Ok(json!({ "artists": { "items": items, "total": total, "limit": limit, "next": next, "cursors": { "after": next.as_ref().map(|_| (offset + limit).to_string()) } } }))
}

fn playlist(token: &str, id: &str) -> R<Value> {
    let limit = 100;
    let d = query(token, "fetchPlaylist", json!({ "uri": format!("spotify:playlist:{id}"), "offset": 0, "limit": limit, "enableWatchFeedEntrypoint": false }))?;
    let p = &d["playlistV2"];
    if p["__typename"].as_str() != Some("Playlist") {
        return Err(Fail::Http(404, json!({ "error": { "status": 404, "message": "Playlist not found" } }).to_string(), None));
    }
    let mut out = playlist_obj(p);
    let c = &p["content"];
    let rows: Vec<Value> = c["items"].as_array().map(|a| a.iter().filter_map(playlist_row).collect()).unwrap_or_default();
    let total = c["totalCount"].as_u64().unwrap_or(rows.len() as u64);
    let block = page(rows, &format!("/playlists/{id}/items"), 0, limit, total, "");
    out["items"] = block.clone();
    out["tracks"] = block;
    Ok(out)
}

fn playlist_rows(token: &str, id: &str, offset: u64, limit: u64) -> R<(Vec<Value>, u64)> {
    let d = query(token, "fetchPlaylistContents", json!({ "uri": format!("spotify:playlist:{id}"), "offset": offset, "limit": limit }))?;
    let c = &d["playlistV2"]["content"];
    let rows = c["items"].as_array().map(|a| a.iter().filter_map(playlist_row).collect()).unwrap_or_default();
    Ok((rows, c["totalCount"].as_u64().unwrap_or(0)))
}

fn playlist_items(token: &str, id: &str, r: &Req) -> R<Value> {
    let (offset, limit) = (r.num("offset", 0, 1_000_000), r.num("limit", 100, 100));
    let (rows, total) = playlist_rows(token, id, offset, limit)?;
    Ok(page(rows, &format!("/playlists/{id}/items"), offset, limit, total, ""))
}

fn playlist_add(token: &str, id: &str, r: &Req, body: &Value) -> R<Value> {
    let mut uris: Vec<String> = body["uris"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    if uris.is_empty() {
        uris = r.list("uris");
    }
    let top = body["position"].as_u64() == Some(0) || r.get("position") == "0";
    let pos = if top { "TOP_OF_PLAYLIST" } else { "BOTTOM_OF_PLAYLIST" };
    query(
        token,
        "addToPlaylist",
        json!({ "playlistUri": format!("spotify:playlist:{id}"), "playlistItemUris": uris, "newPosition": { "moveType": pos, "fromUid": null }, "interactionId": null }),
    )?;
    Ok(json!({ "snapshot_id": "" }))
}

fn playlist_remove(token: &str, id: &str, body: &Value) -> R<Value> {
    let list = body["items"].as_array().or(body["tracks"].as_array()).cloned().unwrap_or_default();
    let gone: HashSet<String> = list.iter().filter_map(|x| x["uri"].as_str().map(String::from)).collect();
    // pathfinder removes rows by their uid; the Web API removes every row of a song
    let mut uids = Vec::new();
    let mut offset = 0;
    loop {
        let (rows, total) = playlist_rows(token, id, offset, 100)?;
        let n = rows.len() as u64;
        uids.extend(rows.iter().filter(|x| x["track"]["uri"].as_str().is_some_and(|u| gone.contains(u))).filter_map(|x| x["uid"].as_str().map(String::from)));
        offset += 100;
        if n == 0 || offset >= total || offset >= 20_000 {
            break;
        }
    }
    if !uids.is_empty() {
        query(token, "removeFromPlaylist", json!({ "playlistUri": format!("spotify:playlist:{id}"), "uids": uids }))?;
    }
    Ok(json!({ "snapshot_id": "" }))
}

fn album(token: &str, id: &str) -> R<Value> {
    let d = query(token, "getAlbum", json!({ "uri": format!("spotify:album:{id}"), "locale": "", "offset": 0, "limit": 300 }))?;
    let a = &d["albumUnion"];
    if a["__typename"].as_str() != Some("Album") {
        return Err(Fail::Http(404, json!({ "error": { "status": 404, "message": "Album not found" } }).to_string(), None));
    }
    let mut out = album_obj(a);
    let short = json!({ "name": out["name"], "uri": out["uri"], "id": out["id"], "images": out["images"] });
    let tracks: Vec<Value> = a["tracksV2"]["items"].as_array().map(|x| x.iter().map(|t| track_obj(&t["track"], "", Some(&short))).collect()).unwrap_or_default();
    let total = a["tracksV2"]["totalCount"].as_u64().unwrap_or(tracks.len() as u64);
    out["label"] = a["label"].clone();
    out["total_tracks"] = json!(total);
    out["tracks"] = json!({ "items": tracks, "total": total, "offset": 0, "limit": 300, "next": null });
    Ok(out)
}

fn artist(token: &str, id: &str) -> R<Value> {
    let d = query(token, "queryArtistOverview", json!({ "uri": format!("spotify:artist:{id}"), "locale": "", "includePrerelease": false }))?;
    let a = &d["artistUnion"];
    if a["__typename"].as_str() != Some("Artist") {
        return Err(Fail::Http(404, json!({ "error": { "status": 404, "message": "Artist not found" } }).to_string(), None));
    }
    let mut out = artist_obj(a);
    out["images"] = images(&a["visuals"]["avatarImage"]["sources"]);
    out["followers"] = json!({ "total": a["stats"]["followers"] });
    out["genres"] = json!([]);
    Ok(out)
}

fn artist_albums(token: &str, id: &str, r: &Req) -> R<Value> {
    let (offset, limit) = (r.num("offset", 0, 10_000), r.num("limit", 20, 50));
    let group = r.get("include_groups").split(',').next().unwrap_or("album").to_string();
    let (op, key) = match group.as_str() {
        "single" => ("queryArtistDiscographySingles", "singles"),
        "compilation" => ("queryArtistDiscographyCompilations", "compilations"),
        "appears_on" => return Ok(page(Vec::new(), "", 0, limit, 0, "")),
        _ => ("queryArtistDiscographyAlbums", "albums"),
    };
    let d = query(token, op, json!({ "uri": format!("spotify:artist:{id}"), "offset": offset, "limit": limit, "order": "DATE_DESC" }))?;
    let block = &d["artistUnion"]["discography"][key];
    let me_artist = json!([{ "uri": format!("spotify:artist:{id}"), "id": id, "name": d["artistUnion"]["profile"]["name"] }]);
    let items: Vec<Value> = block["items"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x["releases"]["items"].get(0))
                .map(|rel| {
                    let mut o = album_obj(rel);
                    if o["artists"].as_array().is_none_or(|a| a.is_empty()) && !d["artistUnion"]["profile"]["name"].is_null() {
                        o["artists"] = me_artist.clone();
                    }
                    o
                })
                .collect()
        })
        .unwrap_or_default();
    let total = block["totalCount"].as_u64().unwrap_or(0);
    Ok(page(items, &format!("/artists/{id}/albums"), offset, limit, total, &format!("&include_groups={}", encode(&group))))
}

fn search(token: &str, r: &Req) -> R<Value> {
    let mut q = r.get("q").trim().to_string();
    // field filters (artist:"Name") aren't understood here; search the name itself
    if let Some(rest) = q.strip_prefix("artist:") {
        q = rest.trim_matches('"').to_string();
    }
    let types = r.list("type");
    let limit = r.num("limit", 20, 50);
    let wrap = |list: &Value, f: &dyn Fn(&Value) -> Option<Value>| -> Vec<Value> { list["items"].as_array().map(|a| a.iter().filter_map(f).collect()).unwrap_or_default() };
    let track_of = |x: &Value| {
        let w = &x["item"];
        (w["data"]["__typename"].as_str() == Some("Track")).then(|| track_obj(&w["data"], &s(&w["_uri"]), None))
    };
    if types.len() == 1 && types[0] == "track" {
        let offset = r.num("offset", 0, 1000);
        let d = query(
            token,
            "searchTracks",
            json!({ "searchTerm": q, "offset": offset, "limit": limit, "numberOfTopResults": 20, "includeAudiobooks": false, "includePreReleases": false, "includeAuthors": false }),
        )?;
        let t = &d["searchV2"]["tracksV2"];
        let items = wrap(t, &track_of);
        let total = t["totalCount"].as_u64().unwrap_or(0);
        let block = page(items, "/search", offset, limit, total, &format!("&type=track&q={}", encode(r.get("q"))));
        return Ok(json!({ "tracks": block }));
    }
    let d = query(
        token,
        "searchDesktop",
        json!({
            "searchTerm": q, "offset": 0, "limit": limit, "numberOfTopResults": 5,
            "includeAudiobooks": false, "includeArtistHasConcertsField": false, "includePreReleases": false,
            "includeLocalConcertsField": false, "includeAuthors": false,
        }),
    )?;
    let sv = &d["searchV2"];
    let data_of = |kind: &'static str, f: fn(&Value) -> Value| move |x: &Value| (x["data"]["__typename"].as_str() == Some(kind)).then(|| f(&x["data"]));
    let mut out = json!({});
    let want = |t: &str| types.is_empty() || types.iter().any(|x| x == t);
    if want("track") {
        out["tracks"] = json!({ "items": wrap(&sv["tracksV2"], &track_of), "total": sv["tracksV2"]["totalCount"] });
    }
    if want("artist") {
        out["artists"] = json!({ "items": wrap(&sv["artists"], &data_of("Artist", artist_obj)), "total": sv["artists"]["totalCount"] });
    }
    if want("album") {
        out["albums"] = json!({ "items": wrap(&sv["albumsV2"], &data_of("Album", album_obj)), "total": sv["albumsV2"]["totalCount"] });
    }
    if want("playlist") {
        out["playlists"] = json!({ "items": wrap(&sv["playlists"], &data_of("Playlist", playlist_obj)), "total": sv["playlists"]["totalCount"] });
    }
    Ok(out)
}

fn top_tracks(token: &str, r: &Req) -> R<Value> {
    let (offset, limit) = (r.num("offset", 0, 1000), r.num("limit", 20, 50));
    let range = match r.get("time_range") {
        "long_term" => "LONG_TERM",
        "medium_term" => "MID_TERM",
        _ => "SHORT_TERM",
    };
    let d = query(
        token,
        "userTopContent",
        json!({
            "includeTopArtists": false, "topArtistsInput": { "offset": 0, "limit": 10, "sortBy": "AFFINITY", "timeRange": range },
            "includeTopTracks": true, "topTracksInput": { "offset": offset, "limit": limit, "sortBy": "AFFINITY", "timeRange": range },
        }),
    )?;
    let t = &d["me"]["profile"]["topTracks"];
    let items: Vec<Value> =
        t["items"].as_array().map(|a| a.iter().filter(|x| x["data"]["__typename"].as_str() == Some("Track")).map(|x| track_obj(&x["data"], "", None)).collect()).unwrap_or_default();
    let total = t["totalCount"].as_u64().unwrap_or(items.len() as u64);
    Ok(page(items, "/me/top/tracks", offset, limit, total, &format!("&time_range={}", r.get("time_range"))))
}

/// Recently played albums (the home page only shows their albums).
fn recently_played(token: &str) -> R<Value> {
    let user = username(token)?;
    let d = spclient_get(token, &format!("/recently-played/v3/user/{}/recently-played?format=json&offset=0&limit=50&filter=default,collection-new-episodes&market=from_token", encode(&user)))?;
    let ctx: Vec<(String, Value)> = d["playContexts"]
        .as_array()
        .map(|a| a.iter().filter_map(|c| c["uri"].as_str().filter(|u| u.starts_with("spotify:album:")).map(|u| (u.to_string(), c["lastPlayedTime"].clone()))).take(20).collect())
        .unwrap_or_default();
    if ctx.is_empty() {
        return Ok(json!({ "items": [] }));
    }
    let uris: Vec<&String> = ctx.iter().map(|(u, _)| u).collect();
    let e = query(token, "fetchEntitiesForRecentlyPlayed", json!({ "uris": uris }))?;
    let items: Vec<Value> = e["lookup"]
        .as_array()
        .map(|a| {
            a.iter()
                .zip(ctx.iter())
                .filter(|(x, _)| x["data"]["__typename"].as_str() == Some("Album"))
                .map(|(x, (_, at))| json!({ "played_at": at, "track": { "album": album_obj(&x["data"]) } }))
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({ "items": items }))
}

// ---- playlists in Your Library: the "rootlist" of Spotify's playlist service. The library
// queries above don't take playlists (removeLibraryItems refuses them).

fn spclient_post(token: &str, path: &str, body: &Value) -> R<Value> {
    let mut res = agent()
        .post(&format!("{SPCLIENT}{path}"))
        .header("Authorization", &format!("Bearer {token}"))
        .header("User-Agent", UA)
        .header("app-platform", "WebPlayer")
        .header("Accept", "application/json")
        .content_type("application/json;charset=UTF-8")
        .send(body.to_string().as_str())
        .map_err(|e| Fail::Other(e.to_string()))?;
    let status = res.status().as_u16();
    let retry = retry_after(&res);
    let text = res.body_mut().with_config().limit(8 * 1024 * 1024).read_to_string().unwrap_or_default();
    if status >= 400 {
        return Err(Fail::Http(status, text, retry));
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn rootlist_uris(token: &str) -> R<HashSet<String>> {
    let user = username(token)?;
    let d = spclient_get(token, &format!("/playlist/v2/user/{}/rootlist?decorate=revision,length,attributes,timestamp,owner,capabilities&bustCache={}", encode(&user), now_ms()))?;
    Ok(d["contents"]["items"].as_array().map(|a| a.iter().filter_map(|x| x["uri"].as_str().map(String::from)).collect()).unwrap_or_default())
}

/// One change to a list, as the web player sends it.
fn list_changes(op: Value) -> Value {
    json!({ "deltas": [{ "ops": [op], "info": { "source": { "client": "WEBPLAYER" } } }], "wantResultingRevisions": false, "wantSyncResult": false, "nonces": [] })
}

fn rootlist_change(token: &str, uris: &[String], add: bool) -> R<()> {
    let user = username(token)?;
    let op = if add {
        let ts = now_ms().to_string();
        let items: Vec<Value> = uris.iter().map(|u| json!({ "uri": u, "attributes": { "timestamp": ts, "formatAttributes": [], "availableSignals": [] } })).collect();
        json!({ "kind": "ADD", "add": { "addFirst": true, "items": items } })
    } else {
        let items: Vec<Value> = uris.iter().map(|u| json!({ "uri": u })).collect();
        json!({ "kind": "REM", "rem": { "itemsAsKey": true, "items": items } })
    };
    spclient_post(token, &format!("/playlist/v2/user/{}/rootlist/changes", encode(&user)), &list_changes(op))?;
    Ok(())
}

fn is_playlist(uri: &str) -> bool {
    uri.starts_with("spotify:playlist:")
}

fn contains(token: &str, uris: Vec<String>) -> R<Value> {
    if uris.is_empty() {
        return Ok(json!([]));
    }
    let others: Vec<&String> = uris.iter().filter(|u| !is_playlist(u)).collect();
    let mut saved: HashMap<&str, bool> = HashMap::new();
    if !others.is_empty() {
        let d = query(token, "areEntitiesInLibrary", json!({ "uris": others }))?;
        for (u, x) in others.iter().zip(d["lookup"].as_array().cloned().unwrap_or_default()) {
            saved.insert(u.as_str(), x["data"]["saved"].as_bool().unwrap_or(false));
        }
    }
    if uris.iter().any(|u| is_playlist(u)) {
        let mine = rootlist_uris(token)?;
        for u in uris.iter().filter(|u| is_playlist(u)) {
            saved.insert(u.as_str(), mine.contains(u));
        }
    }
    Ok(json!(uris.iter().map(|u| saved.get(u.as_str()).copied().unwrap_or(false)).collect::<Vec<_>>()))
}

fn save(token: &str, uris: Vec<String>, on: bool) -> R<Value> {
    let (lists, others): (Vec<String>, Vec<String>) = uris.into_iter().partition(|u| is_playlist(u));
    if !others.is_empty() {
        query(token, if on { "addToLibrary" } else { "removeFromLibrary" }, json!({ "libraryItemUris": others }))?;
    }
    if !lists.is_empty() {
        rootlist_change(token, &lists, on)?;
    }
    Ok(Value::Null)
}

fn list_attributes(name: Option<&str>, description: Option<&str>) -> Value {
    let mut values = json!({ "formatAttributes": [], "pictureSize": [] });
    let mut no_value = Vec::new();
    if let Some(n) = name.filter(|n| !n.trim().is_empty()) {
        values["name"] = json!(n.trim());
    }
    match description {
        Some(d) if !d.trim().is_empty() => values["description"] = json!(d.trim()),
        Some(_) => no_value.push("LIST_DESCRIPTION"),
        None => {}
    }
    json!({ "kind": "UPDATE_LIST_ATTRIBUTES", "updateListAttributes": { "newAttributes": { "values": values, "noValue": no_value } } })
}

fn create_playlist(token: &str, body: &Value) -> R<Value> {
    let name = body["name"].as_str().filter(|n| !n.trim().is_empty()).unwrap_or("New playlist");
    // a new list takes just its first ops (no "info", unlike changes to an existing one)
    let delta = json!({ "ops": [list_attributes(Some(name), body["description"].as_str().filter(|d| !d.is_empty()))] });
    let made = spclient_post(token, "/playlist/v2/playlist", &delta)?;
    let uri = made["uri"].as_str().ok_or_else(|| Fail::Other("Spotify didn't make the playlist".into()))?.to_string();
    rootlist_change(token, std::slice::from_ref(&uri), true)?;
    let user = username(token)?;
    Ok(json!({
        "id": id_of(&uri), "uri": uri, "type": "playlist", "name": name, "description": body["description"],
        "images": [], "owner": { "id": user, "uri": format!("spotify:user:{user}") },
        "public": body["public"], "collaborative": false, "snapshot_id": made["revision"],
    }))
}

fn update_playlist(token: &str, id: &str, body: &Value) -> R<Value> {
    let op = list_attributes(body["name"].as_str(), body["description"].as_str());
    if op["updateListAttributes"]["newAttributes"]["values"].as_object().is_some_and(|v| v.len() > 2) || !op["updateListAttributes"]["newAttributes"]["noValue"].as_array().unwrap().is_empty() {
        spclient_post(token, &format!("/playlist/v2/playlist/{id}/changes"), &list_changes(op))?;
    }
    Ok(Value::Null)
}

/// Full Track objects for a list of track URIs (the player's now playing and queue).
pub fn decorate_tracks(token: &str, uris: &[&String]) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for chunk in uris.chunks(50) {
        let d = query(token, "decorateContextTracks", json!({ "uris": chunk })).map_err(|e| match e {
            Fail::Http(s, t, _) => format!("HTTP {s}: {t}"),
            Fail::Stale => "stale query".into(),
            Fail::Other(m) => m,
        })?;
        out.extend(d["tracks"].as_array().into_iter().flatten().filter(|t| t["__typename"].as_str() == Some("Track")).map(|t| track_obj(t, "", None)));
    }
    Ok(out)
}

fn track_uris(r: &Req) -> Vec<String> {
    r.list("ids").into_iter().map(|id| format!("spotify:track:{id}")).collect()
}

/// Answers a Web API request from the web player's API, or None if it isn't one we handle.
pub fn call(token: &str, method: &str, url: &str, body: Option<&str>) -> Option<Reply> {
    let r = parse(url)?;
    let body: Value = body.and_then(|b| serde_json::from_str(b).ok()).unwrap_or(Value::Null);
    let seg: Vec<&str> = r.segs.iter().map(|x| x.as_str()).collect();
    let res = match (method, seg.as_slice()) {
        ("GET", ["me"]) => me(token),
        ("GET", ["me", "tracks"]) => liked(token, &r),
        ("GET", ["me", "tracks", "contains"]) => contains(token, track_uris(&r)),
        ("GET", ["me", "library", "contains"]) => contains(token, r.list("uris")),
        ("PUT", ["me", "tracks"]) => save(token, track_uris(&r), true),
        ("DELETE", ["me", "tracks"]) => save(token, track_uris(&r), false),
        ("PUT", ["me", "library"]) => save(token, r.list("uris"), true),
        ("DELETE", ["me", "library"]) => save(token, r.list("uris"), false),
        ("GET", ["me", "playlists"]) => my_playlists(token, &r),
        ("POST", ["me", "playlists"] | ["users", _, "playlists"]) => create_playlist(token, &body),
        ("PUT", ["playlists", id]) if body.is_object() && (body.get("name").is_some() || body.get("description").is_some()) => update_playlist(token, id, &body),
        ("GET", ["me", "albums"]) => my_albums(token, &r),
        ("GET", ["me", "following"]) if r.get("type") == "artist" => following(token, &r),
        ("GET", ["me", "top", "tracks"]) => top_tracks(token, &r),
        ("GET", ["me", "player", "recently-played"]) => recently_played(token),
        ("GET", ["search"]) => search(token, &r),
        ("GET", ["playlists", id]) => playlist(token, id),
        ("GET", ["playlists", id, "items" | "tracks"]) => playlist_items(token, id, &r),
        ("POST", ["playlists", id, "items" | "tracks"]) => playlist_add(token, id, &r, &body),
        ("DELETE", ["playlists", id, "items" | "tracks"]) => playlist_remove(token, id, &body),
        ("GET", ["albums", id]) => album(token, id),
        ("GET", ["artists", id]) => artist(token, id),
        ("GET", ["artists", id, "albums"]) => artist_albums(token, id, &r),
        _ => return None,
    };
    Some(match res {
        Ok(v) => Reply::ok(v),
        Err(Fail::Http(status, text, retry)) => {
            let body = serde_json::from_str::<Value>(&text).ok().filter(|v| v["error"]["message"].is_string()).unwrap_or_else(|| json!({ "error": { "status": status, "message": format!("Spotify said {status}") } }));
            Reply { status, body, retry_after: retry }
        }
        Err(Fail::Stale) => Reply { status: 502, body: json!({ "error": { "status": 502, "message": "Spotify changed its web player; update Afterglow" } }), retry_after: None },
        Err(Fail::Other(msg)) => Reply { status: 502, body: json!({ "error": { "status": 502, "message": msg } }), retry_after: None },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_web_api_urls() {
        let r = parse("https://api.spotify.com/v1/search?q=artist%3A%22Taco+Hemingway%22&type=track&limit=10").unwrap();
        assert_eq!(r.segs, vec!["search"]);
        assert_eq!(r.get("q"), "artist:\"Taco Hemingway\"");
        assert_eq!(r.num("limit", 20, 50), 10);
        assert!(parse("https://example.com/v1/me").is_none());
    }

    #[test]
    fn decodes_percent_edge_cases() {
        assert_eq!(percent_decode("a%2Cb"), "a,b");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%C5%BC"), "ż");
    }

    #[test]
    fn next_page_only_when_more() {
        let p = page(vec![json!(1)], "/me/tracks", 0, 50, 120, "");
        assert_eq!(p["next"], json!("https://api.spotify.com/v1/me/tracks?offset=50&limit=50"));
        let p = page(vec![json!(1)], "/me/tracks", 100, 50, 120, "");
        assert!(p["next"].is_null());
    }
}

/// Live checks against Spotify: `AFTERGLOW_TEST_TOKEN=… cargo test --lib live -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;

    fn token() -> String {
        std::env::var("AFTERGLOW_TEST_TOKEN").expect("set AFTERGLOW_TEST_TOKEN")
    }

    fn get(url: &str) -> Value {
        let r = call(&token(), "GET", &format!("{WEB_API}{url}"), None).expect("handled");
        assert_eq!(r.status, 200, "{url}: {}", r.body);
        r.body
    }

    #[test]
    #[ignore]
    fn every_read_endpoint() {
        let me = get("/me");
        println!("me: {} {}", me["id"], me["display_name"]);
        let liked = get("/me/tracks?limit=50");
        println!("liked: {} of {}, next {}", liked["items"].as_array().unwrap().len(), liked["total"], liked["next"]);
        let t = &liked["items"][0]["track"];
        assert!(t["uri"].as_str().unwrap().starts_with("spotify:track:") && t["duration_ms"].as_u64().unwrap() > 0 && !t["album"]["images"].as_array().unwrap().is_empty());
        let pls = get("/me/playlists?limit=50");
        println!("playlists: {} of {}", pls["items"].as_array().unwrap().len(), pls["total"]);
        let p = &pls["items"][0];
        println!("  first: {} by {} ({})", p["name"], p["owner"]["display_name"], p["owner"]["id"]);
        let full = get(&format!("/playlists/{}", p["id"].as_str().unwrap()));
        println!("  rows: {} of {}", full["items"]["items"].as_array().unwrap().len(), full["items"]["total"]);
        let big = get("/playlists/37i9dQZF1DXcBWIGoYBM5M/items?offset=25&limit=10");
        assert_eq!(big["items"].as_array().unwrap().len(), 10);
        let albums = get("/me/albums?limit=50");
        println!("albums: {} of {}", albums["items"].as_array().unwrap().len(), albums["total"]);
        let fol = get("/me/following?type=artist&limit=50");
        println!("artists: {} of {}", fol["artists"]["items"].as_array().unwrap().len(), fol["artists"]["total"]);
        let al = get("/albums/4yP0hdKOZPNshxUOjY0cZj");
        println!("album: {} {} {} tracks, first #{} {}", al["name"], al["release_date"], al["tracks"]["items"].as_array().unwrap().len(), al["tracks"]["items"][0]["track_number"], al["tracks"]["items"][0]["name"]);
        let ar = get("/artists/3TVXtAsR1Inumwj472S9r4");
        println!("artist: {} {} followers", ar["name"], ar["followers"]["total"]);
        let aa = get("/artists/3TVXtAsR1Inumwj472S9r4/albums?include_groups=album&limit=10");
        let sg = get("/artists/3TVXtAsR1Inumwj472S9r4/albums?include_groups=single&limit=10");
        println!("  albums {} (next {}), singles {}", aa["items"].as_array().unwrap().len(), aa["next"], sg["items"].as_array().unwrap().len());
        let s = get("/search?q=drake&type=track%2Cartist%2Calbum%2Cplaylist&limit=10");
        println!("search: {} tracks, {} artists, {} albums, {} playlists", s["tracks"]["items"].as_array().unwrap().len(), s["artists"]["items"].as_array().unwrap().len(), s["albums"]["items"].as_array().unwrap().len(), s["playlists"]["items"].as_array().unwrap().len());
        let st = get("/search?q=artist%3A%22Drake%22&type=track&limit=10&offset=10");
        println!("search tracks page 2: {}", st["tracks"]["items"].as_array().unwrap().len());
        let top = get("/me/top/tracks?limit=10&time_range=short_term");
        println!("top: {}", top["items"].as_array().unwrap().len());
        let rp = get("/me/player/recently-played?limit=40");
        println!("recent albums: {}", rp["items"].as_array().unwrap().len());
        let c = get(&format!("/me/library/contains?uris={}%2Cspotify%3Atrack%3A4uLU6hMCjMI75M1A2tKUQC", encode(t["uri"].as_str().unwrap())));
        assert_eq!(c, json!([true, false]));
        assert!(call(&token(), "GET", "https://api.spotify.com/v1/me/player", None).is_none());
    }

    /// Makes a throwaway playlist, renames it, and removes it from the library again.
    #[test]
    #[ignore]
    fn playlist_lifecycle() {
        let t = token();
        let made = call(&t, "POST", &format!("{WEB_API}/me/playlists"), Some(r#"{"name":"Afterglow test","description":"","public":false}"#)).unwrap();
        assert_eq!(made.status, 200, "{}", made.body);
        let id = made.body["id"].as_str().unwrap().to_string();
        let uri = format!("spotify:playlist:{id}");
        println!("made {uri}");
        let r = call(&t, "PUT", &format!("{WEB_API}/playlists/{id}"), Some(r#"{"name":"Afterglow test 2","description":"hi"}"#)).unwrap();
        assert_eq!(r.status, 200, "{}", r.body);
        std::thread::sleep(Duration::from_secs(2));
        let p = get(&format!("/playlists/{id}"));
        println!("renamed: {} / {}", p["name"], p["description"]);
        assert_eq!(get(&format!("/me/library/contains?uris={}", encode(&uri))), json!([true]));
        let r = call(&t, "DELETE", &format!("{WEB_API}/me/library?uris={}", encode(&uri)), None).unwrap();
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(get(&format!("/me/library/contains?uris={}", encode(&uri))), json!([false]));
        println!("removed again");
    }

    #[test]
    #[ignore]
    fn reads_hashes_from_web_player() {
        refresh_hashes().unwrap();
        let g = HASHES.lock().unwrap();
        let m = g.as_ref().unwrap();
        for (k, _) in BUILTIN {
            assert!(m.contains_key(*k), "missing {k}");
        }
        println!("all {} queries found", BUILTIN.len());
    }
}
