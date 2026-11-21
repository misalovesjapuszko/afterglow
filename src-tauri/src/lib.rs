use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(not(target_os = "ios"))]
use librespot_core::authentication::Credentials;
#[cfg(not(target_os = "ios"))]
use librespot_core::config::SessionConfig;
#[cfg(not(target_os = "ios"))]
use librespot_core::session::Session;
#[cfg(not(target_os = "ios"))]
use librespot_core::{SpotifyId, SpotifyUri};
#[cfg(not(target_os = "ios"))]
use librespot_metadata::image::ImageSize;
#[cfg(not(target_os = "ios"))]
use librespot_metadata::{Metadata, Playlist, Track as MTrack};
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

// Optional local-only extras (not in the public repo); build.rs sets the cfg when present.
#[cfg(local_extras)]
mod local;

const LR_CLIENT: &str = "65b708073fc0480ea92a077233ca87bd";
const LR_PORT: u16 = 8898;
const SCOPES: &str = "streaming user-read-email user-read-private user-library-read user-library-modify playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-follow-read user-follow-modify user-read-playback-state user-modify-playback-state user-read-currently-playing user-read-recently-played user-top-read";
const DEVICE: &str = "Afterglow";
const SOLOIST_URL: &str = "https://soloist-builds.spotifycdn.com/soloist_release_x86_64.tar.gz";
const DONE_PAGE: &str = "<!doctype html><html><body style=\"margin:0;height:100vh;display:grid;place-items:center;background:#0b0b10;color:#fff;font:600 22px system-ui\"><div style=\"text-align:center\"><div style=\"font-size:48px\">♪</div>Afterglow is connected.<div style=\"opacity:.6;font-size:15px;margin-top:8px\">You can close this tab.</div></div></body></html>";

const EXAMPLES: &[(&str, &str)] = &[
    ("sleep-timer.js", include_str!("../plugins-examples/sleep-timer.js")),
    ("now-playing-title.js", include_str!("../plugins-examples/now-playing-title.js")),
    ("theme-midnight.css", include_str!("../plugins-examples/theme-midnight.css")),
    ("theme-sakura.css", include_str!("../plugins-examples/theme-sakura.css")),
    ("theme-oled.css", include_str!("../plugins-examples/theme-oled.css")),
    ("theme-forest.css", include_str!("../plugins-examples/theme-forest.css")),
    ("theme-vaporwave.css", include_str!("../plugins-examples/theme-vaporwave.css")),
    ("theme-mono.css", include_str!("../plugins-examples/theme-mono.css")),
    ("theme-sunset.css", include_str!("../plugins-examples/theme-sunset.css")),
];
const EXAMPLES_VERSION: u32 = 2;

struct AppState {
    cfg: Mutex<Value>,
    web_refresh: Mutex<()>,
    soloist: Mutex<Option<Child>>,
    #[cfg(not(target_os = "ios"))]
    session: tokio::sync::Mutex<Option<Session>>,
    media: Mutex<Option<tokio::sync::mpsc::UnboundedSender<Value>>>,
    tray: Mutex<bool>,
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        #[cfg(desktop)]
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn quit(app: &AppHandle) {
    kill_soloist(app);
    app.exit(0);
}

fn media_action(app: &AppHandle, action: &str) {
    let _ = app.emit("media", action);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    quit(&app);
}

#[tauri::command]
fn media_update(app: AppHandle, state: Value) {
    #[cfg(desktop)]
    if let Some(tray) = app.tray_by_id("main") {
        let tip = match (state["title"].as_str(), state["artist"].as_str()) {
            (Some(t), Some(a)) if !t.is_empty() => format!("{t} · {a}"),
            _ => "Afterglow".to_string(),
        };
        let _ = tray.set_tooltip(Some(tip));
    }
    if let Some(tx) = app.state::<AppState>().media.lock().unwrap().as_ref() {
        let _ = tx.send(state);
    }
}

#[cfg(target_os = "linux")]
fn start_mpris(app: AppHandle) -> Option<tokio::sync::mpsc::UnboundedSender<Value>> {
    use mpris_server::{LoopStatus, Metadata, PlaybackStatus, Player, Time, TrackId};
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    std::thread::spawn(move || {
        let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() else { return };
        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async move {
            let player = match Player::builder("afterglow")
                .identity("Afterglow")
                .desktop_entry("dev.misalovesjapuszko.afterglow")
                .can_play(true)
                .can_pause(true)
                .can_go_next(true)
                .can_go_previous(true)
                .can_seek(true)
                .can_raise(true)
                .can_quit(true)
                .build()
                .await
            {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("mpris: {e}");
                    return;
                }
            };
            for (name, act) in [("play_pause", "playpause"), ("play", "play"), ("pause", "pause"), ("next", "next"), ("previous", "previous"), ("stop", "pause")] {
                let a = app.clone();
                let f = move |_: &Player| media_action(&a, act);
                match name {
                    "play_pause" => player.connect_play_pause(f),
                    "play" => player.connect_play(f),
                    "pause" => player.connect_pause(f),
                    "next" => player.connect_next(f),
                    "previous" => player.connect_previous(f),
                    _ => player.connect_stop(f),
                }
            }
            let a = app.clone();
            player.connect_seek(move |_, off| {
                let _ = a.emit("media-seek", off.as_millis());
            });
            let a = app.clone();
            player.connect_set_position(move |_, _, pos| {
                let _ = a.emit("media-position", pos.as_millis());
            });
            let a = app.clone();
            player.connect_raise(move |_| show_main(&a));
            let a = app.clone();
            player.connect_quit(move |_| quit(&a));
            let a = app.clone();
            player.connect_set_volume(move |_, v| {
                let _ = a.emit("media-volume", v);
            });
            let a = app.clone();
            player.connect_set_shuffle(move |_, on| {
                let _ = a.emit("media-shuffle", on);
            });
            tokio::task::spawn_local(player.run());
            let mut last_uri = String::new();
            while let Some(v) = rx.recv().await {
                let uri = v["uri"].as_str().unwrap_or("").to_string();
                if uri != last_uri {
                    last_uri = uri.clone();
                    let id = uri.rsplit(':').next().unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>();
                    let mut m = Metadata::builder()
                        .title(v["title"].as_str().unwrap_or(""))
                        .artist(v["artists"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>()).unwrap_or_default())
                        .album(v["album"].as_str().unwrap_or(""))
                        .length(Time::from_millis(v["duration"].as_i64().unwrap_or(0)));
                    if let Some(art) = v["art"].as_str().filter(|s| !s.is_empty()) {
                        m = m.art_url(art);
                    }
                    if let Ok(t) = TrackId::try_from(format!("/dev/misalovesjapuszko/afterglow/track/{}", if id.is_empty() { "none".into() } else { id })) {
                        m = m.trackid(t);
                    }
                    let _ = player.set_metadata(m.build()).await;
                }
                let status = if uri.is_empty() {
                    PlaybackStatus::Stopped
                } else if v["playing"].as_bool().unwrap_or(false) {
                    PlaybackStatus::Playing
                } else {
                    PlaybackStatus::Paused
                };
                let _ = player.set_playback_status(status).await;
                let pos = Time::from_millis(v["position"].as_i64().unwrap_or(0));
                player.set_position(pos);
                if v["seeked"].as_bool().unwrap_or(false) {
                    let _ = player.seeked(pos).await;
                }
                if let Some(vol) = v["volume"].as_f64() {
                    let _ = player.set_volume(vol).await;
                }
                if let Some(sh) = v["shuffle"].as_bool() {
                    let _ = player.set_shuffle(sh).await;
                }
                let lp = match v["repeat"].as_str() {
                    Some("track") => LoopStatus::Track,
                    Some("context") => LoopStatus::Playlist,
                    _ => LoopStatus::None,
                };
                let _ = player.set_loop_status(lp).await;
            }
        });
    });
    Some(tx)
}

#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Afterglow", true, None::<&str>)?;
    let pp = MenuItem::with_id(app, "playpause", "Play / Pause", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "previous", "Previous", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Afterglow", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &sep1, &pp, &next, &prev, &sep2, &quit_item])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Afterglow")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "show" => show_main(app),
            "quit" => quit(app),
            other => media_action(app, other),
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn env_path(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn home() -> PathBuf {
    env_path("HOME").or_else(|| env_path("USERPROFILE")).unwrap_or_default()
}

fn config_dir() -> PathBuf {
    if cfg!(windows) {
        env_path("APPDATA").unwrap_or_else(home).join("Afterglow")
    } else if cfg!(target_os = "ios") {
        // iOS: $HOME is the app sandbox; only Library/ and Documents/ are writable
        home().join("Library/Application Support/Afterglow")
    } else {
        env_path("XDG_CONFIG_HOME").unwrap_or_else(|| home().join(".config")).join("afterglow")
    }
}

fn data_dir() -> PathBuf {
    if cfg!(windows) {
        env_path("LOCALAPPDATA").unwrap_or_else(home).join("Afterglow")
    } else if cfg!(target_os = "ios") {
        home().join("Library/Application Support/Afterglow/data")
    } else {
        env_path("XDG_DATA_HOME").unwrap_or_else(|| home().join(".local/share")).join("afterglow")
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn load_cfg() -> Value {
    std::fs::read_to_string(config_dir().join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .filter(|v: &Value| v.is_object())
        .unwrap_or_else(|| json!({}))
}

fn save_cfg(v: &Value) {
    let dir = config_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("config.json");
    let _ = std::fs::write(&path, serde_json::to_string_pretty(v).unwrap_or_default());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .build()
        .into()
}

fn token_request(form: &[(&str, &str)]) -> Result<Value, String> {
    let mut res = agent()
        .post("https://accounts.spotify.com/api/token")
        .send_form(form.iter().copied())
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.body_mut().read_to_string().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if status >= 400 {
        return Err(v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("token error").to_string());
    }
    Ok(v)
}

fn store_tokens(app: &AppHandle, v: &Value, prefix: &str) {
    let state = app.state::<AppState>();
    let mut cfg = state.cfg.lock().unwrap();
    cfg[format!("{prefix}access_token").as_str()] = v["access_token"].clone();
    if let Some(rt) = v["refresh_token"].as_str().filter(|s| !s.is_empty()) {
        cfg[format!("{prefix}refresh_token").as_str()] = json!(rt);
    }
    cfg[format!("{prefix}expires_at").as_str()] = json!(now() + v["expires_in"].as_u64().unwrap_or(3600));
    if let Some(sc) = v["scope"].as_str() {
        cfg[format!("{prefix}scope").as_str()] = json!(sc);
    }
    save_cfg(&cfg);
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn query_param(path: &str, key: &str) -> Option<String> {
    let q = path.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let start = Instant::now();
    loop {
        if start.elapsed() > Duration::from_secs(300) {
            return Err("login timed out".into());
        }
        let mut stream = match listener.accept() {
            Ok((s, _)) => s,
            Err(_) => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let path = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("").to_string();
        if !path.starts_with("/login") {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            continue;
        }
        let _ = stream.write_all(
            format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", DONE_PAGE.len(), DONE_PAGE).as_bytes(),
        );
        if query_param(&path, "state").as_deref() != Some(state) {
            return Err("login state mismatch".into());
        }
        if let Some(err) = query_param(&path, "error") {
            return Err(err);
        }
        return query_param(&path, "code").ok_or_else(|| "no code".to_string());
    }
}

#[tauri::command]
fn js_log(level: String, msg: String) {
    let line = format!("[{}] {}: {}\n", now(), level, msg.chars().take(2000).collect::<String>());
    eprint!("{line}");
    let path = data_dir().join("afterglow.log");
    let _ = std::fs::create_dir_all(data_dir());
    if std::fs::metadata(&path).map(|m| m.len() > 512 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

#[tauri::command]
fn platform() -> &'static str {
    std::env::consts::OS
}

#[tauri::command]
fn get_config(app: AppHandle) -> Value {
    let state = app.state::<AppState>();
    let cfg = state.cfg.lock().unwrap();
    let mut out = cfg.clone();
    if let Some(o) = out.as_object_mut() {
        o.remove("access_token");
        o.remove("refresh_token");
        o.remove("expires_at");
        let has_lr = o.get("lr_refresh_token").and_then(|v| v.as_str()).is_some();
        for k in ["lr_access_token", "lr_refresh_token", "lr_expires_at"] {
            o.remove(k);
        }
        o.insert("has_full_access".into(), json!(has_lr));
        let has_key = o.get("soloist_key").and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty());
        o.remove("soloist_key");
        o.insert("has_soloist_key".into(), json!(has_key));
        o.remove("web_token");
        o.remove("web_expires_at");
        o.insert("logged_in".into(), json!(cfg["refresh_token"].as_str().is_some() || cfg["auth"].as_str() == Some("web")));
        o.insert("config_dir".into(), json!(config_dir().to_string_lossy()));
    }
    out
}

#[tauri::command]
fn set_config(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    if key.contains("token") || key.ends_with("expires_at") || key == "auth" {
        return Err("read only".into());
    }
    let state = app.state::<AppState>();
    let mut cfg = state.cfg.lock().unwrap();
    cfg[key.as_str()] = value;
    save_cfg(&cfg);
    Ok(())
}

// Desktop: open the login page in the browser. iOS: Safari would suspend the app (and its
// local redirect listener), so the login page is loaded in the app's own webview instead.
fn open_auth(app: &AppHandle, url: &str) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let w = app.get_webview_window("main").ok_or("no window")?;
        let u = tauri::Url::parse(url).map_err(|e| e.to_string())?;
        w.navigate(u).map_err(|e| e.to_string())
    }
    #[cfg(desktop)]
    {
        let _ = app;
        open::that_detached(url).map_err(|e| e.to_string())
    }
}

/// After an in-app login (iOS), load the app UI again.
fn back_to_app(app: &AppHandle) {
    #[cfg(mobile)]
    if let Some(w) = app.get_webview_window("main") {
        let home = if cfg!(target_os = "ios") { "tauri://localhost" } else { "http://tauri.localhost" };
        if let Ok(u) = tauri::Url::parse(home) {
            let _ = w.navigate(u);
        }
    }
    #[cfg(desktop)]
    let _ = app;
}

fn pkce_login(app: &AppHandle, client_id: &str, port: u16, scopes: &str) -> Result<Value, String> {
    let redirect = format!("http://127.0.0.1:{port}/login");
    let mut raw = [0u8; 64];
    getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
    let verifier = b64(&raw);
    let challenge = b64(&Sha256::digest(verifier.as_bytes()));
    let mut st = [0u8; 16];
    getrandom::fill(&mut st).map_err(|e| e.to_string())?;
    let state = b64(&st);
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("port {port} busy: {e}"))?;
    let url = format!(
        "https://accounts.spotify.com/authorize?response_type=code&client_id={client_id}&scope={}&redirect_uri={}&code_challenge_method=S256&code_challenge={challenge}&state={state}",
        scopes.replace(' ', "%20"),
        redirect.replace(':', "%3A").replace('/', "%2F")
    );
    open_auth(app, &url)?;
    let code = wait_for_code(&listener, &state)?;
    token_request(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", &redirect),
        ("client_id", client_id),
        ("code_verifier", &verifier),
    ])
}

#[tauri::command]
async fn login(app: AppHandle, client_id: String) -> Result<(), String> {
    let client_id = client_id.trim().to_string();
    if client_id.len() < 16 {
        return Err("That client ID looks wrong".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let v = pkce_login(&app, &client_id, 8899, SCOPES).inspect_err(|_| back_to_app(&app))?;
        {
            let s = app.state::<AppState>();
            let mut cfg = s.cfg.lock().unwrap();
            cfg["client_id"] = json!(client_id);
        }
        store_tokens(&app, &v, "");
        if let Ok(v) = pkce_login(&app, LR_CLIENT, LR_PORT, "streaming") {
            store_tokens(&app, &v, "lr_");
        }
        back_to_app(&app);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn login_extra(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let v = pkce_login(&app, LR_CLIENT, LR_PORT, "streaming");
        back_to_app(&app);
        store_tokens(&app, &v?, "lr_");
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn lr_token(app: &AppHandle) -> Result<String, String> {
    let (access, refresh, exp) = {
        let s = app.state::<AppState>();
        let cfg = s.cfg.lock().unwrap();
        (
            cfg["lr_access_token"].as_str().unwrap_or("").to_string(),
            cfg["lr_refresh_token"].as_str().unwrap_or("").to_string(),
            cfg["lr_expires_at"].as_u64().unwrap_or(0),
        )
    };
    if refresh.is_empty() {
        return Err("LR_LOGIN".into());
    }
    if !access.is_empty() && exp > now() + 120 {
        return Ok(access);
    }
    let v = token_request(&[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", LR_CLIENT)])
        .map_err(|e| if e.contains("invalid_grant") { "LR_LOGIN".to_string() } else { e })?;
    store_tokens(app, &v, "lr_");
    Ok(v["access_token"].as_str().unwrap_or("").to_string())
}

#[cfg(not(target_os = "ios"))]
async fn session(app: &AppHandle) -> Result<Session, String> {
    let st = app.state::<AppState>();
    let mut guard = st.session.lock().await;
    if let Some(s) = guard.as_ref().filter(|s| !s.is_invalid()) {
        return Ok(s.clone());
    }
    let a = app.clone();
    let tok = tauri::async_runtime::spawn_blocking(move || lr_token(&a)).await.map_err(|e| e.to_string())??;
    let s = Session::new(SessionConfig::default(), None);
    s.connect(Credentials::with_access_token(tok), false).await.map_err(|e| e.to_string())?;
    *guard = Some(s.clone());
    Ok(s)
}

// ---- Audio visualizer: capture what the speakers play (PipeWire/Pulse monitor), FFT it,
// and emit 64 log-spaced bands (0..255) to the UI about 60 times a second.
// A running capture: the parec process on Linux, a WASAPI loopback thread on Windows.
enum Capture {
    #[allow(dead_code)]
    Proc(Child),
    #[allow(dead_code)]
    Thread(std::sync::Arc<std::sync::atomic::AtomicBool>),
}
impl Capture {
    fn alive(&mut self) -> bool {
        match self {
            Capture::Proc(c) => matches!(c.try_wait(), Ok(None)),
            Capture::Thread(stop) => !stop.load(std::sync::atomic::Ordering::Relaxed),
        }
    }
    fn stop(self) {
        match self {
            Capture::Proc(mut c) => {
                let _ = c.kill();
                let _ = c.wait();
            }
            Capture::Thread(stop) => stop.store(true, std::sync::atomic::Ordering::Relaxed),
        }
    }
}
static VIZ: Mutex<Option<Capture>> = Mutex::new(None);

fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f32::consts::PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
        len <<= 1;
    }
}

// Turns mono samples into 64 log-spaced bands (0..255), one frame about every 1/60 s.
struct Analyzer {
    win: Vec<f32>,
    edges: Vec<usize>,
    ring: Vec<f32>,
    pos: usize,
    pending: usize,
    hop: usize,
    re: Vec<f32>,
    im: Vec<f32>,
    smooth: Vec<f32>,
}
impl Analyzer {
    const N: usize = 2048;
    const BANDS: usize = 64;
    fn new(rate: f32) -> Self {
        let n = Self::N;
        Analyzer {
            win: (0..n).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (n - 1) as f32).cos()).collect(),
            edges: (0..=Self::BANDS)
                .map(|b| {
                    let f = 45.0 * (14000.0f32 / 45.0).powf(b as f32 / Self::BANDS as f32);
                    ((f / rate * n as f32) as usize).clamp(1, n / 2 - 1)
                })
                .collect(),
            ring: vec![0f32; n],
            pos: 0,
            pending: 0,
            hop: ((rate / 60.0) as usize).max(64),
            re: vec![0f32; n],
            im: vec![0f32; n],
            smooth: vec![0f32; Self::BANDS],
        }
    }
    /// Feed samples; calls `emit` for every finished frame. `emit` returns false to stop.
    fn push(&mut self, samples: &[f32], emit: &mut dyn FnMut(Vec<u8>) -> bool) -> bool {
        let n = Self::N;
        for &x in samples {
            // circular buffer: `pos` is the oldest sample
            self.ring[self.pos] = x;
            self.pos = (self.pos + 1) % n;
            self.pending += 1;
            if self.pending < self.hop {
                continue;
            }
            self.pending = 0;
            for i in 0..n {
                self.re[i] = self.ring[(self.pos + i) % n] * self.win[i];
                self.im[i] = 0.0;
            }
            fft(&mut self.re, &mut self.im);
            let mut bands: Vec<u8> = Vec::with_capacity(Self::BANDS);
            for b in 0..Self::BANDS {
                let (lo, hi) = (self.edges[b], self.edges[b + 1].max(self.edges[b] + 1));
                let mut m = 0f32;
                for k in lo..hi {
                    m = m.max((self.re[k] * self.re[k] + self.im[k] * self.im[k]).sqrt());
                }
                // dB relative to a full-scale sine, tilted up for the highs
                let db = 20.0 * (m / (n as f32 / 4.0) + 1e-9).log10() + (b as f32 / Self::BANDS as f32) * 16.0;
                let v = ((db + 62.0) / 56.0).clamp(0.0, 1.0);
                let s = &mut self.smooth[b];
                *s += (v - *s) * if v > *s { 0.65 } else { 0.16 };
                bands.push((*s * 255.0) as u8);
            }
            if !emit(bands) {
                return false;
            }
        }
        true
    }
}

#[tauri::command]
fn viz_start(app: AppHandle) -> Result<(), String> {
    let mut g = VIZ.lock().unwrap();
    if let Some(c) = g.as_mut() {
        if c.alive() {
            return Ok(());
        }
    }
    *g = Some(start_capture(app)?);
    Ok(())
}

#[cfg(target_os = "linux")]
fn start_capture(app: AppHandle) -> Result<Capture, String> {
    let mut child = Command::new("parec")
        .args(["--device=@DEFAULT_MONITOR@", "--format=s16le", "--rate=44100", "--channels=1", "--latency-msec=15", "--client-name=Afterglow", "--stream-name=Visualizer"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("NO_CAPTURE {e}"))?;
    let mut out = child.stdout.take().ok_or("NO_CAPTURE")?;
    std::thread::spawn(move || {
        let mut an = Analyzer::new(44100.0);
        let mut buf = vec![0u8; 1470];
        let mut samples = Vec::with_capacity(735);
        let mut emit = |bands: Vec<u8>| app.emit("viz", bands).is_ok();
        while out.read_exact(&mut buf).is_ok() {
            samples.clear();
            samples.extend(buf.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0));
            if !an.push(&samples, &mut emit) {
                break;
            }
        }
    });
    Ok(Capture::Proc(child))
}

// Windows: WASAPI loopback. Opening an *input* stream on the default *output* device
// records exactly what the speakers play (Spotify, the web player, anything).
#[cfg(windows)]
fn start_capture(app: AppHandle) -> Result<Capture, String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let stop2 = stop.clone();
    // cpal streams can't move between threads, so one thread owns the stream for its whole life
    std::thread::spawn(move || {
        let fail = |e: String| {
            let _ = ready_tx.send(Err(format!("NO_CAPTURE {e}")));
        };
        let host = cpal::default_host();
        let Some(dev) = host.default_output_device() else { return fail("no output device".into()) };
        let cfg = match dev.default_output_config() {
            Ok(c) => c,
            Err(e) => return fail(e.to_string()),
        };
        let ch = cfg.channels().max(1) as usize;
        let rate = cfg.sample_rate() as f32;
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(64);
        let err_fn = |e| eprintln!("viz capture error: {e}");
        macro_rules! stream {
            ($t:ty, $conv:expr) => {
                dev.build_input_stream(
                    cfg.config(),
                    move |data: &[$t], _: &cpal::InputCallbackInfo| {
                        let mono: Vec<f32> = data.chunks(ch).map(|f| f.iter().map(|&x| $conv(x)).sum::<f32>() / ch as f32).collect();
                        let _ = tx.try_send(mono);
                    },
                    err_fn,
                    None,
                )
            };
        }
        let stream = match cfg.sample_format() {
            cpal::SampleFormat::F32 => stream!(f32, |x: f32| x),
            cpal::SampleFormat::I16 => stream!(i16, |x: i16| x as f32 / 32768.0),
            cpal::SampleFormat::I32 => stream!(i32, |x: i32| x as f32 / 2147483648.0),
            f => return fail(format!("unsupported sample format {f:?}")),
        };
        let stream = match stream {
            Ok(s) => s,
            Err(e) => return fail(e.to_string()),
        };
        if let Err(e) = stream.play() {
            return fail(e.to_string());
        }
        let _ = ready_tx.send(Ok(()));
        let mut an = Analyzer::new(rate);
        let mut emit = |bands: Vec<u8>| app.emit("viz", bands).is_ok();
        while !stop2.load(Ordering::Relaxed) {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(chunk) => {
                    if !an.push(&chunk, &mut emit) {
                        break;
                    }
                }
                // silence: WASAPI loopback sends nothing while nothing plays, so decay the ring
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if !an.push(&vec![0f32; (rate / 4.0) as usize], &mut emit) {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        stop2.store(true, Ordering::Relaxed);
        drop(stream);
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "NO_CAPTURE timeout".to_string())??;
    Ok(Capture::Thread(stop))
}

#[cfg(not(any(target_os = "linux", windows)))]
fn start_capture(_app: AppHandle) -> Result<Capture, String> {
    Err("NO_CAPTURE".into())
}

#[tauri::command]
fn viz_stop() {
    if let Some(c) = VIZ.lock().unwrap().take() {
        c.stop();
    }
}

// Spotify's own lyrics (Musixmatch etc.) from the same endpoint the Spotify web player uses.
fn lyrics_http(token: &str, id: &str) -> Result<Value, String> {
    let url = format!("https://spclient.wg.spotify.com/color-lyrics/v2/track/{id}?format=json&vocalRemoval=false&market=from_token");
    let mut res = agent()
        .get(&url)
        .header("Authorization", &format!("Bearer {token}"))
        .header("app-platform", "WebPlayer")
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36")
        .call()
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    if status == 404 {
        return Err("NO_LYRICS".into());
    }
    if status != 200 {
        return Err(format!("lyrics HTTP {status}"));
    }
    let body = res.body_mut().read_to_string().map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

#[tauri::command]
async fn spotify_lyrics(app: AppHandle, id: String) -> Result<Value, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("bad id".into());
    }
    let (a, i) = (app.clone(), id.clone());
    let http = tauri::async_runtime::spawn_blocking(move || {
        let token = if is_web(&a) { ensure_token(&a, false)?.0 } else { lr_token(&a)? };
        lyrics_http(&token, &i)
    })
    .await
    .map_err(|e| e.to_string())?;
    match http {
        Ok(v) => return Ok(v),
        Err(e) if e == "NO_LYRICS" || e.contains("LOGIN") || is_web(&app) => return Err(e),
        #[cfg(target_os = "ios")]
        Err(e) => return Err(e),
        #[cfg(not(target_os = "ios"))]
        Err(e) => eprintln!("lyrics over https failed ({e}), trying the librespot session"),
    }
    #[cfg(target_os = "ios")]
    unreachable!();
    #[cfg(not(target_os = "ios"))]
    {
        let sess = session(&app).await?;
        let tid = SpotifyId::from_base62(&id).map_err(|e| e.to_string())?;
        let bytes = sess.spclient().get_lyrics(&tid).await.map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn playlist_full(app: AppHandle, id: String) -> Result<Value, String> {
    // iOS has no librespot; the UI falls back to the Web API playlist pages
    #[cfg(target_os = "ios")]
    {
        let _ = (app, id);
        return Err("playlist_full is not available on iOS".into());
    }
    #[cfg(not(target_os = "ios"))]
    playlist_full_librespot(app, id).await
}

#[cfg(not(target_os = "ios"))]
async fn playlist_full_librespot(app: AppHandle, id: String) -> Result<Value, String> {
    let sess = session(&app).await?;
    let uri = SpotifyUri::from_uri(&format!("spotify:playlist:{id}")).map_err(|e| e.to_string())?;
    let pl = Playlist::get(&sess, &uri).await.map_err(|e| e.to_string())?;
    let uris: Vec<SpotifyUri> = pl.tracks().filter(|u| matches!(u, SpotifyUri::Track { .. })).take(3000).cloned().collect();
    let mut out: Vec<Value> = vec![Value::Null; uris.len()];
    for (ci, chunk) in uris.chunks(32).enumerate() {
        let mut set = tokio::task::JoinSet::new();
        for (k, u) in chunk.iter().enumerate() {
            let (sess, u) = (sess.clone(), u.clone());
            set.spawn(async move { (ci * 32 + k, MTrack::get(&sess, &u).await.ok().map(|t| (u, t))) });
        }
        while let Some(Ok((i, r))) = set.join_next().await {
            let Some((u, t)) = r else { continue };
            let images: Vec<Value> = t
                .album
                .covers
                .iter()
                .filter_map(|c| {
                    let w = match c.size {
                        ImageSize::SMALL => 64,
                        ImageSize::LARGE => 640,
                        ImageSize::XLARGE => 1000,
                        _ => 300,
                    };
                    c.id.to_base16().ok().map(|h| json!({"url": format!("https://i.scdn.co/image/{h}"), "width": w, "height": w}))
                })
                .collect();
            let uri_s = u.to_uri().unwrap_or_default();
            let album_uri = t.album.id.to_uri().unwrap_or_default();
            out[i] = json!({
                "uri": uri_s,
                "id": uri_s.rsplit(':').next().unwrap_or(""),
                "name": t.name,
                "duration_ms": t.duration.max(0),
                "explicit": t.is_explicit,
                "artists": t.artists.iter().map(|a| {
                    let au = a.id.to_uri().unwrap_or_default();
                    json!({"name": a.name, "uri": au, "id": au.rsplit(':').next().unwrap_or("")})
                }).collect::<Vec<_>>(),
                "album": {"name": t.album.name, "uri": album_uri, "id": album_uri.rsplit(':').next().unwrap_or(""), "images": images},
            });
        }
    }
    Ok(Value::Array(out.into_iter().filter(|v| !v.is_null()).collect()))
}

// ---- One-click login ("Sign in with Spotify").
// Spotify's own login page opens in a small window. Once signed in, the official web player
// (open.spotify.com) asks its server for an access token; a tiny hook in that page hands the
// token to us by "navigating" to a fake host, which on_navigation catches and cancels.
// Later refreshes load the web player in a hidden window with the same browser session.
const TOKEN_HOST: &str = "afterglow-token.invalid";
const WEB_LOGIN_URL: &str = "https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F";
const WEB_HOOK: &str = r#"(() => {
  if (!/(^|\.)spotify\.com$/.test(location.hostname)) return;
  const f = window.fetch;
  window.fetch = async function (...a) {
    const r = await f.apply(this, a);
    try {
      const u = String((a[0] && a[0].url) || a[0]);
      if (u.includes('/api/token')) {
        r.clone().json().then((j) => {
          if (!j || !j.accessToken) return;
          const q = new URLSearchParams({ t: j.accessToken, e: String(j.accessTokenExpirationTimestampMs || 0), a: j.isAnonymous ? '1' : '0' });
          location.href = 'https://afterglow-token.invalid/?' + q;
        }).catch(() => {});
      }
    } catch (e) {}
    return r;
  };
})();"#;

struct WebTok {
    token: String,
    exp_ms: u64,
    anon: bool,
}

fn close_window(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.destroy();
    }
}

fn web_window(app: &AppHandle, label: &str, url: &str, visible: bool) -> Result<std::sync::mpsc::Receiver<WebTok>, String> {
    close_window(app, label);
    let (tx, rx) = std::sync::mpsc::channel::<WebTok>();
    let tx = Mutex::new(tx);
    let u = tauri::Url::parse(url).map_err(|e| e.to_string())?;
    let b = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::External(u))
        .initialization_script(WEB_HOOK)
        .visible(visible)
        .on_navigation(move |url| {
            if url.host_str() != Some(TOKEN_HOST) {
                return true;
            }
            let q: std::collections::HashMap<String, String> = url.query_pairs().into_owned().collect();
            if let Some(t) = q.get("t").filter(|t| !t.is_empty()) {
                let _ = tx.lock().unwrap().send(WebTok {
                    token: t.clone(),
                    exp_ms: q.get("e").and_then(|e| e.parse().ok()).unwrap_or(0),
                    anon: q.get("a").map(|a| a == "1").unwrap_or(true),
                });
            }
            false
        });
    #[cfg(desktop)]
    let b = b.title("Sign in to Spotify").inner_size(480.0, 740.0).center();
    b.build().map_err(|e| e.to_string())?;
    Ok(rx)
}

fn store_web(app: &AppHandle, t: &WebTok) {
    let s = app.state::<AppState>();
    let mut cfg = s.cfg.lock().unwrap();
    cfg["auth"] = json!("web");
    cfg["web_token"] = json!(t.token);
    cfg["web_expires_at"] = json!(if t.exp_ms > 0 { t.exp_ms / 1000 } else { now() + 3000 });
    save_cfg(&cfg);
}

fn is_web(app: &AppHandle) -> bool {
    app.state::<AppState>().cfg.lock().unwrap()["auth"].as_str() == Some("web")
}

#[tauri::command]
async fn web_login(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rx = web_window(&app, "spotify-login", WEB_LOGIN_URL, true)?;
        let start = Instant::now();
        loop {
            match rx.recv_timeout(Duration::from_millis(400)) {
                Ok(t) if !t.anon => {
                    store_web(&app, &t);
                    close_window(&app, "spotify-login");
                    return Ok(());
                }
                Ok(_) => {} // the logged-out web player; keep waiting for the real login
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if app.get_webview_window("spotify-login").is_none() {
                        return Err("CANCELLED".into());
                    }
                    if start.elapsed() > Duration::from_secs(900) {
                        close_window(&app, "spotify-login");
                        return Err("login timed out".into());
                    }
                }
                Err(_) => return Err("CANCELLED".into()),
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn web_token(app: &AppHandle, force: bool) -> Result<(String, u64), String> {
    let valid = |app: &AppHandle| {
        let s = app.state::<AppState>();
        let cfg = s.cfg.lock().unwrap();
        let (tok, exp) = (cfg["web_token"].as_str().unwrap_or("").to_string(), cfg["web_expires_at"].as_u64().unwrap_or(0));
        (!tok.is_empty() && exp > now() + 120).then_some((tok, exp))
    };
    if !force {
        if let Some(v) = valid(app) {
            return Ok(v);
        }
    }
    let st = app.state::<AppState>();
    let _one_at_a_time = st.web_refresh.lock().unwrap();
    if let Some(v) = valid(app).filter(|_| !force) {
        return Ok(v);
    }
    let rx = web_window(app, "spotify-web", "https://open.spotify.com/", false)?;
    let got = rx.recv_timeout(Duration::from_secs(30));
    close_window(app, "spotify-web");
    match got {
        Ok(t) if !t.anon => {
            store_web(app, &t);
            Ok((t.token, t.exp_ms / 1000))
        }
        Ok(_) => {
            // the Spotify web session ended (logged out or expired): back to the sign-in screen
            let mut cfg = st.cfg.lock().unwrap();
            if let Some(o) = cfg.as_object_mut() {
                o.remove("auth");
                o.remove("web_token");
                o.remove("web_expires_at");
            }
            save_cfg(&cfg);
            Err("LOGIN".into())
        }
        Err(_) => Err("Spotify did not answer. Check your internet connection.".into()),
    }
}

fn ensure_token(app: &AppHandle, force: bool) -> Result<(String, u64), String> {
    if is_web(app) {
        return web_token(app, force);
    }
    ensure_app_token(app, force)
}

fn ensure_app_token(app: &AppHandle, force: bool) -> Result<(String, u64), String> {
    let (access, refresh, exp, client, granted) = {
        let s = app.state::<AppState>();
        let cfg = s.cfg.lock().unwrap();
        (
            cfg["access_token"].as_str().unwrap_or("").to_string(),
            cfg["refresh_token"].as_str().unwrap_or("").to_string(),
            cfg["expires_at"].as_u64().unwrap_or(0),
            cfg["client_id"].as_str().unwrap_or("").to_string(),
            cfg["scope"].as_str().unwrap_or("").to_string(),
        )
    };
    if refresh.is_empty() || client.is_empty() {
        return Err("LOGIN".to_string());
    }
    if SCOPES.split(' ').any(|sc| !granted.split(' ').any(|g| g == sc)) {
        return Err("SCOPES".to_string());
    }
    if !force && !access.is_empty() && exp > now() + 120 {
        return Ok((access, exp));
    }
    let v = token_request(&[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", &client)])
        .map_err(|e| if e.contains("invalid_grant") || e.contains("revoked") { "LOGIN".to_string() } else { e })?;
    store_tokens(app, &v, "");
    let s = app.state::<AppState>();
    let cfg = s.cfg.lock().unwrap();
    Ok((cfg["access_token"].as_str().unwrap_or("").to_string(), cfg["expires_at"].as_u64().unwrap_or(0)))
}

#[tauri::command]
async fn get_token(app: AppHandle, force: Option<bool>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (token, exp) = ensure_token(&app, force == Some(true))?;
        Ok(json!({"token": token, "expires_at": exp}))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn spotify(app: AppHandle, method: String, url: String, body: Option<String>) -> Result<Value, String> {
    if !url.starts_with("https://api.spotify.com/") {
        return Err("bad url".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut force = false;
        for _ in 0..2 {
            let (token, _) = ensure_token(&app, force)?;
            let auth = format!("Bearer {token}");
            let a = agent();
            let res = match (method.as_str(), &body) {
                ("GET", _) => a.get(&url).header("Authorization", &auth).call(),
                ("DELETE", None) => a.delete(&url).header("Authorization", &auth).call(),
                ("DELETE", Some(b)) => a.delete(&url).header("Authorization", &auth).force_send_body().content_type("application/json").send(b.as_str()),
                ("PUT", Some(b)) => a.put(&url).header("Authorization", &auth).content_type("application/json").send(b.as_str()),
                ("PUT", None) => a.put(&url).header("Authorization", &auth).send_empty(),
                ("POST", Some(b)) => a.post(&url).header("Authorization", &auth).content_type("application/json").send(b.as_str()),
                (_, _) => a.post(&url).header("Authorization", &auth).send_empty(),
            };
            let mut res = res.map_err(|e| e.to_string())?;
            let status = res.status().as_u16();
            if status == 401 && !force {
                force = true;
                continue;
            }
            let retry = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
            let text = res.body_mut().with_config().limit(32 * 1024 * 1024).read_to_string().unwrap_or_default();
            return Ok(json!({"status": status, "text": text, "retry_after": retry}));
        }
        Err("unauthorized".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn logout(app: AppHandle) {
    if is_web(&app) {
        let a = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if web_window(&a, "spotify-web", "https://www.spotify.com/logout/", false).is_ok() {
                std::thread::sleep(Duration::from_secs(4));
                close_window(&a, "spotify-web");
            }
        })
        .await;
    }
    let s = app.state::<AppState>();
    let mut cfg = s.cfg.lock().unwrap();
    if let Some(o) = cfg.as_object_mut() {
        o.remove("auth");
        o.remove("web_token");
        o.remove("web_expires_at");
        o.remove("access_token");
        o.remove("refresh_token");
        o.remove("expires_at");
        o.remove("lr_access_token");
        o.remove("lr_refresh_token");
        o.remove("lr_expires_at");
        o.remove("scope");
    }
    save_cfg(&cfg);
}

fn plugins_dir() -> PathBuf {
    config_dir().join("plugins")
}

#[tauri::command]
fn list_plugins() -> Value {
    let dir = plugins_dir();
    let _ = std::fs::create_dir_all(&dir);
    let marker = dir.join(".examples-version");
    let have: u32 = std::fs::read_to_string(&marker).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    if have < EXAMPLES_VERSION {
        for (name, body) in EXAMPLES {
            let p = dir.join(name);
            if !p.exists() && !dir.join(format!("{name}.off")).exists() {
                let _ = std::fs::write(p, body);
            }
        }
        let _ = std::fs::write(&marker, EXAMPLES_VERSION.to_string());
    }
    let mut scripts = Vec::new();
    let mut styles = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let Ok(body) = std::fs::read_to_string(&p) else { continue };
        if name.ends_with(".js") {
            scripts.push(json!({"name": name, "code": body}));
        } else if name.ends_with(".css") {
            styles.push(json!({"name": name, "css": body}));
        }
    }
    json!({"scripts": scripts, "styles": styles, "dir": dir.to_string_lossy()})
}

#[tauri::command]
fn open_plugins_dir() -> Result<(), String> {
    let dir = plugins_dir();
    let _ = std::fs::create_dir_all(&dir);
    open::that_detached(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https links".into());
    }
    open::that_detached(&url).map_err(|e| e.to_string())
}

#[tauri::command]
async fn http_get(url: String) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("only https".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut res = agent().get(&url).header("User-Agent", "Afterglow/1.0").call().map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let body = res.body_mut().with_config().limit(8 * 1024 * 1024).read_to_string().map_err(|e| e.to_string())?;
        if status >= 400 {
            return Err(format!("HTTP {status}"));
        }
        Ok(body)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn find_soloist() -> Option<PathBuf> {
    let mut candidates = vec![
        data_dir().join("soloist"),
        home().join(".local/bin/soloist"),
        home().join(".local/share/pixelspot/soloist"),
    ];
    for dir in std::env::var("PATH").unwrap_or_default().split(':') {
        candidates.push(PathBuf::from(dir).join("soloist"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn download_soloist() -> Result<PathBuf, String> {
    let dir = data_dir();
    let tmp = dir.join("dl");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let tar = tmp.join("soloist.tar.gz");
    let ok = Command::new("curl").args(["--fail", "-sL", "-o"]).arg(&tar).arg(SOLOIST_URL).status().map(|s| s.success()).unwrap_or(false)
        && Command::new("tar").arg("-xzf").arg(&tar).arg("-C").arg(&tmp).arg("soloist").status().map(|s| s.success()).unwrap_or(false);
    if !ok {
        return Err("could not download Soloist".into());
    }
    let dest = dir.join("soloist");
    std::fs::rename(tmp.join("soloist"), &dest).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(dest)
}

#[cfg_attr(not(unix), allow(unused_variables))]
fn kill_stale_soloist(state: &std::path::Path) {
    #[cfg(unix)]
    {
        let Some(pid) = std::fs::read_to_string(state.join("soloist.pid")).ok().and_then(|s| s.trim().parse::<i32>().ok()) else { return };
        let cmd = std::fs::read_to_string(format!("/proc/{pid}/cmdline")).unwrap_or_default();
        if !cmd.contains("soloist") || !cmd.contains(&*state.to_string_lossy()) {
            return;
        }
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        for _ in 0..30 {
            if !std::path::Path::new(&format!("/proc/{pid}")).exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn kill_soloist(app: &AppHandle) {
    if let Some(mut c) = app.state::<AppState>().soloist.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

#[tauri::command]
async fn soloist_start(app: AppHandle) -> Result<u16, String> {
    if !cfg!(target_os = "linux") {
        return Err("UNSUPPORTED".into());
    }
    let key = {
        let s = app.state::<AppState>();
        let cfg = s.cfg.lock().unwrap();
        cfg["soloist_key"].as_str().unwrap_or("").trim().to_string()
    };
    if key.is_empty() {
        return Err("NO_KEY".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        kill_soloist(&app);
        let mut updated = false;
        let mut bin = match find_soloist() {
            Some(b) => b,
            None => download_soloist()?,
        };
        loop {
            let state = data_dir().join("soloist-data");
            std::fs::create_dir_all(&state).map_err(|e| e.to_string())?;
            kill_stale_soloist(&state);
            let _ = std::fs::remove_file(state.join("ws.port"));
            let log = std::fs::File::create(data_dir().join("soloist.log")).ok();
            let mut cmd = Command::new(&bin);
            cmd.args(["-n", DEVICE, "-k", &key, "-w", "127.0.0.1:0", "-z", "300", "-D"]).arg(&state).stdin(Stdio::null());
            match log.and_then(|f| f.try_clone().ok().map(|g| (f, g))) {
                Some((f, g)) => {
                    cmd.stdout(f).stderr(g);
                }
                None => {
                    cmd.stdout(Stdio::null()).stderr(Stdio::null());
                }
            }
            let child = cmd.spawn().map_err(|e| e.to_string())?;
            *app.state::<AppState>().soloist.lock().unwrap() = Some(child);
            let start = Instant::now();
            loop {
                let exited = {
                    let s = app.state::<AppState>();
                    let mut g = s.soloist.lock().unwrap();
                    g.as_mut().and_then(|c| c.try_wait().ok().flatten()).map(|st| st.code())
                };
                if let Some(code) = exited {
                    if code == Some(10) && !updated {
                        updated = true;
                        bin = download_soloist()?;
                        break;
                    }
                    return Err(format!("Soloist exited ({})", code.map(|c| c.to_string()).unwrap_or("?".into())));
                }
                if let Some(p) = std::fs::read_to_string(state.join("ws.port")).ok().and_then(|s| s.trim().parse::<u16>().ok()) {
                    return Ok(p);
                }
                if start.elapsed() > Duration::from_secs(25) {
                    kill_soloist(&app);
                    return Err("Soloist did not start".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

type Handler = Box<dyn Fn(tauri::ipc::Invoke) -> bool + Send + Sync>;

#[cfg(not(local_extras))]
fn handlers() -> Handler {
    Box::new(tauri::generate_handler![
        platform,
        js_log,
        quit_app,
        media_update,
        get_config,
        set_config,
        login,
        login_extra,
        web_login,
        playlist_full,
        spotify_lyrics,
        viz_start,
        viz_stop,
        get_token,
        spotify,
        logout,
        list_plugins,
        open_plugins_dir,
        open_url,
        http_get,
        soloist_start
    ])
}

#[cfg(local_extras)]
fn handlers() -> Handler {
    local::handlers()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_glassbar::init());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)));
    let app = builder
        .manage(AppState {
            cfg: Mutex::new(load_cfg()),
            web_refresh: Mutex::new(()),
            soloist: Mutex::new(None),
            #[cfg(not(target_os = "ios"))]
            session: tokio::sync::Mutex::new(None),
            media: Mutex::new(None),
            tray: Mutex::new(false),
        })
        .setup(|app| {
            // Flatpak's runtime has no tray library, and loading a missing one aborts
            #[cfg(desktop)]
            if std::env::var_os("FLATPAK_ID").is_none() {
                let ok = setup_tray(app).map_err(|e| eprintln!("tray: {e}")).is_ok();
                *app.state::<AppState>().tray.lock().unwrap() = ok;
            }
            #[cfg(target_os = "linux")]
            {
                let tx = start_mpris(app.handle().clone());
                *app.state::<AppState>().media.lock().unwrap() = tx;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let st = app.state::<AppState>();
                let keep = st.cfg.lock().unwrap()["close_to_tray"].as_bool().unwrap_or(true);
                if keep && *st.tray.lock().unwrap() {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    kill_soloist(app);
                }
            }
        })
        .invoke_handler(handlers())
        .build(tauri::generate_context!())
        .expect("failed to start Afterglow");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            kill_soloist(handle);
            viz_stop();
        }
    });
}
