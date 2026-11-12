//! UaN peer-to-peer node. Every user runs one; there is no central server.
//!
//! - Identity is an Ed25519 key stored on this PC. The public key is your "friend code".
//! - iroh connects two keys anywhere on the internet (hole punching, relay fallback).
//! - Messages are stored locally; if a friend is offline they wait in an outbox.
//! - Files never leave the sender's disk until someone streams or downloads them.

use crypto_box::{
    aead::{Aead, AeadCore, OsRng},
    SalsaBox,
};
use data_encoding::{BASE32_NOPAD, BASE64, HEXLOWER};
use sha2::{Digest, Sha256, Sha512};
use iroh::{
    endpoint::{presets, Connection, RecvStream, SendStream},
    Endpoint, EndpointId, SecretKey,
};
use rusqlite::{params, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::SeekFrom,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::sync::CancellationToken;

const ALPN: &[u8] = b"uan/1";
const MAX_FRAME: usize = 1 << 20;
const MEDIA_CHUNK: u64 = 8 * 1024 * 1024;
const MEDIA_WHOLE_LIMIT: u64 = 32 * 1024 * 1024;
const ONLINE_WINDOW: Duration = Duration::from_secs(150);
pub const MAX_FILE_SIZE: u64 = 4 * 1024 * 1024 * 1024 * 1024; // 4 TB
// Watch together streams instead of downloading: keep a window of pieces around the playhead.
const STREAM_AHEAD_BLOCKS: u64 = 96; // ~768 MB ahead of the playhead
const STREAM_BEHIND_BLOCKS: u64 = 8; // keep a little behind for small rewinds
const STREAM_MAX_BLOCKS: usize = 256; // never more than ~2 GB of cache per film
const STREAM_WORKERS: usize = 4;
const READY_AHEAD: u64 = 48 * 1024 * 1024; // buffered ahead before someone counts as ready
const BLOCK: u64 = 8 * 1024 * 1024; // download piece size
/// Offline mailbox (Cloudflare Worker). Empty = only direct delivery. Settings or UAN_MAILBOX override it.
pub const DEFAULT_MAILBOX: &str = "https://uan-mailbox.uan-mailbox.workers.dev";
const WORKERS: usize = 6; // pieces fetched at the same time
const PROBE_BYTES: u64 = 8 * 1024 * 1024; // speed test size

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL, member_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (group_id, member_id));
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, chat TEXT NOT NULL, sender TEXT NOT NULL,
  sender_name TEXT NOT NULL, text TEXT, file TEXT, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat, seq);
CREATE TABLE IF NOT EXISTS shared_files (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS file_access (file_id TEXT NOT NULL, who TEXT NOT NULL, PRIMARY KEY (file_id, who));
CREATE TABLE IF NOT EXISTS downloads (file_id TEXT PRIMARY KEY, path TEXT NOT NULL, chat TEXT);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT '', avatar TEXT, pv INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY, peer TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
";

// ---------- Wire format ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileMeta {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub owner: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Member {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WireGroup {
    pub id: String,
    pub name: String,
    pub owner: String,
    pub version: i64,
    pub members: Vec<Member>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WireMsg {
    pub id: String,
    pub group: Option<String>,
    pub name: String,
    pub text: Option<String>,
    pub file: Option<FileMeta>,
    pub ts: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Req {
    Ping {
        name: String,
        #[serde(default)]
        status: String,
        #[serde(default)]
        pv: i64,
    },
    Profile,
    FriendRequest { name: String },
    FriendAccept { name: String },
    FriendRemove,
    Msg { msg: WireMsg },
    Group { group: WireGroup },
    GroupLeave { group_id: String },
    FileGet { file_id: String, offset: u64, len: Option<u64> },
    Probe { bytes: u64 },
    ProbeMe,
    Party { party: Party },
    PartyReport {
        party_id: String,
        have: u64,
        joined: bool,
        left: bool,
        #[serde(default)]
        ready: bool,
        #[serde(default)]
        buffering: bool,
    },
    PartyControl { party_id: String, state: String, position: f64 },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PartyMember {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub have: u64,
    #[serde(default)]
    pub joined: bool,
    #[serde(default)]
    pub left: bool,
    #[serde(default)]
    pub ready: bool,
    #[serde(default)]
    pub buffering: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Party {
    pub id: String,
    pub group: String,
    pub file: FileMeta,
    pub leader: String,
    pub seeder: String,
    pub members: Vec<PartyMember>,
    pub state: String, // loading | playing | paused | ended
    pub position: f64,
    pub version: i64,
}

#[allow(dead_code)]
enum ReqError {
    Offline(String),
    Refused(String),
}

fn e2s(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn parse_id(s: &str) -> Result<EndpointId, String> {
    EndpointId::from_str(s).map_err(|_| "Invalid user id.".to_string())
}

pub fn parse_code(code: &str) -> Result<EndpointId, String> {
    let upper = code.trim().to_uppercase();
    let body = upper.strip_prefix("UAN-").unwrap_or(&upper);
    let clean: String = body.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let bad = || "That friend code isn't valid. It looks like UAN-XXXX… (52 characters after UAN-).".to_string();
    let bytes = BASE32_NOPAD.decode(clean.as_bytes()).map_err(|_| bad())?;
    let arr: [u8; 32] = bytes.try_into().map_err(|_| bad())?;
    EndpointId::from_bytes(&arr).map_err(|_| bad())
}

async fn write_frame(send: &mut SendStream, v: &impl Serialize) -> Result<(), String> {
    let data = serde_json::to_vec(v).map_err(e2s)?;
    send.write_all(&(data.len() as u32).to_be_bytes()).await.map_err(e2s)?;
    send.write_all(&data).await.map_err(e2s)
}

async fn read_frame<T: DeserializeOwned>(recv: &mut RecvStream) -> Result<T, String> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len).await.map_err(e2s)?;
    let n = u32::from_be_bytes(len) as usize;
    if n > MAX_FRAME {
        return Err("Frame too large.".into());
    }
    let mut buf = vec![0u8; n];
    recv.read_exact(&mut buf).await.map_err(e2s)?;
    serde_json::from_slice(&buf).map_err(e2s)
}

pub fn guess_mime(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

// ---------- Transfers (downloads) ----------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub done: u64,
    pub status: String, // running | paused | error | done
    pub error: Option<String>,
    #[serde(default)]
    pub speed: f64,
    pub path: String,
    pub file: FileMeta,
    #[serde(default)]
    pub chat: String,
}

struct Running {
    live: Arc<AtomicU64>,
    cancel: CancellationToken,
}

/// A download in progress: which 8 MB pieces we already have (others in the group can get those from us).
pub struct Partial {
    part: PathBuf,
    size: u64,
    chat: String,
    bits: Mutex<Vec<u8>>,
    bits_path: PathBuf,
}

impl Partial {
    fn has_range(&self, start: u64, len: u64) -> bool {
        if len == 0 {
            return true;
        }
        let a = (start / BLOCK) as usize;
        let b = ((start + len - 1) / BLOCK) as usize;
        let bits = self.bits.lock().unwrap();
        (a..=b).all(|i| bits.get(i).copied() == Some(1))
    }
    fn done_bytes(&self) -> u64 {
        let bits = self.bits.lock().unwrap();
        bits.iter().enumerate().filter(|(_, b)| **b == 1).map(|(i, _)| BLOCK.min(self.size - i as u64 * BLOCK)).sum()
    }
    fn missing(&self) -> Vec<usize> {
        self.bits.lock().unwrap().iter().enumerate().filter(|(_, b)| **b == 0).map(|(i, _)| i).collect()
    }
    fn mark(&self, i: usize) {
        let mut bits = self.bits.lock().unwrap();
        if let Some(b) = bits.get_mut(i) {
            *b = 1;
        }
        let _ = std::fs::write(&self.bits_path, &*bits);
    }
}

enum Source {
    Whole(PathBuf, u64),
    Partial(Arc<Partial>),
    Cache(Arc<StreamCache>),
}

/// Watch-together cache: one small file per 8 MB piece, only around the playhead, deleted afterwards.
pub struct StreamCache {
    file: FileMeta,
    chat: String,
    dir: PathBuf,
    have: Mutex<HashSet<u64>>,
    focus: AtomicU64,
    cancel: CancellationToken,
}

impl StreamCache {
    fn nblocks(&self) -> u64 {
        self.file.size.div_ceil(BLOCK)
    }
    fn block_path(&self, b: u64) -> PathBuf {
        self.dir.join(format!("{b}.bin"))
    }
    fn has_range(&self, start: u64, len: u64) -> bool {
        if len == 0 {
            return true;
        }
        let have = self.have.lock().unwrap();
        (start / BLOCK..=(start + len - 1) / BLOCK).all(|b| have.contains(&b))
    }
    fn read_range(&self, start: u64, len: u64) -> std::io::Result<Vec<u8>> {
        let mut out = Vec::with_capacity(len as usize);
        let mut pos = start;
        let end = start + len;
        while pos < end {
            let b = pos / BLOCK;
            let data = std::fs::read(self.block_path(b))?;
            let from = (pos - b * BLOCK) as usize;
            let to = ((end - b * BLOCK).min(data.len() as u64)) as usize;
            if from >= to {
                return Err(std::io::Error::other("short piece"));
            }
            out.extend_from_slice(&data[from..to]);
            pos = b * BLOCK + to as u64;
        }
        Ok(out)
    }
    /// Bytes buffered without a gap from the playhead onwards.
    fn ahead(&self) -> u64 {
        let focus = self.focus.load(Ordering::Relaxed).min(self.file.size);
        let have = self.have.lock().unwrap();
        let mut b = focus / BLOCK;
        while b < self.nblocks() && have.contains(&b) {
            b += 1;
        }
        (b * BLOCK).min(self.file.size).saturating_sub(focus)
    }
    fn ready(&self) -> bool {
        let focus = self.focus.load(Ordering::Relaxed).min(self.file.size);
        self.ahead() >= READY_AHEAD.min(self.file.size - focus)
    }
}

/// Opens a file with its default app, or shows it in the file manager.
fn open_in_system(path: &str, reveal: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let arg = if reveal { format!("/select,\"{path}\"") } else { format!("\"{path}\"") };
        std::process::Command::new("explorer").raw_arg(arg).spawn().map_err(|_| "Couldn't open the file.")?;
    }
    #[cfg(not(windows))]
    {
        // Linux file managers can't reliably select a file, so open its folder instead.
        let target = if reveal {
            Path::new(path).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
        } else {
            path.to_string()
        };
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(opener).arg(target).spawn().map_err(|_| "Couldn't open the file.")?;
    }
    Ok(())
}

fn blocks_path(part: &Path) -> PathBuf {
    let mut s = part.as_os_str().to_owned();
    s.push(".blocks");
    PathBuf::from(s)
}

fn part_path(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

fn safe_file_name(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    let s = s.trim().trim_end_matches(['.', ' ']).to_string();
    if s.is_empty() { "file".into() } else { s }
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let p = Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("file").to_string();
    let ext = p.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    let mut candidate = dir.join(name);
    let mut n = 1;
    while candidate.exists() || part_path(&candidate).exists() {
        candidate = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    candidate
}

// ---------- Node ----------

pub struct Node {
    app: AppHandle,
    dir: PathBuf,
    endpoint: Endpoint,
    me: EndpointId,
    me_s: String,
    db: Mutex<rusqlite::Connection>,
    conns: Mutex<HashMap<EndpointId, Connection>>,
    seen: Mutex<HashMap<String, Instant>>,
    flushing: Mutex<HashSet<String>>,
    transfers: Mutex<Vec<Transfer>>,
    running: Mutex<HashMap<String, Running>>,
    partials: Mutex<HashMap<String, Arc<Partial>>>,
    parties: Mutex<HashMap<String, Party>>,
    caches: Mutex<HashMap<String, Arc<StreamCache>>>,
    buffering: Mutex<HashSet<String>>,
    // Speed tests requested by peers run on a separate task (keeps the async call graph acyclic).
    probe_tx: tokio::sync::mpsc::UnboundedSender<(String, tokio::sync::oneshot::Sender<Option<f64>>)>,
    secret: SecretKey,
    http: reqwest::Client,
    mailbox: Mutex<String>,
}

impl Node {
    pub async fn start(app: AppHandle, dir: PathBuf) -> Result<Arc<Node>, String> {
        std::fs::create_dir_all(&dir).map_err(e2s)?;
        let key_path = dir.join("identity.key");
        let secret = match std::fs::read(&key_path) {
            Ok(b) if b.len() == 32 => SecretKey::from_bytes(&b.try_into().unwrap()),
            _ => {
                let k = SecretKey::generate();
                std::fs::write(&key_path, k.to_bytes()).map_err(e2s)?;
                k
            }
        };
        let db = rusqlite::Connection::open(dir.join("uan.db")).map_err(e2s)?;
        db.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(())).map_err(e2s)?;
        db.execute_batch(SCHEMA).map_err(e2s)?;
        let _ = db.execute("ALTER TABLE downloads ADD COLUMN chat TEXT", []); // older databases

        let endpoint = Endpoint::builder(presets::N0)
            .secret_key(secret.clone())
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .map_err(|e| format!("Couldn't start networking: {e}"))?;
        let me = endpoint.id();

        let mut transfers: Vec<Transfer> =
            std::fs::read(dir.join("transfers.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        for t in &mut transfers {
            if t.status == "running" {
                t.status = "paused".into();
            }
        }

        let mailbox = std::env::var("UAN_MAILBOX").ok().or_else(|| {
            db.query_row("SELECT v FROM kv WHERE k = 'mailbox'", [], |r| r.get::<_, String>(0)).optional().ok().flatten()
        }).unwrap_or_else(|| DEFAULT_MAILBOX.to_string());
        let http = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().map_err(e2s)?;
        let (probe_tx, mut probe_rx) = tokio::sync::mpsc::unbounded_channel();
        let node = Arc::new(Node {
            app,
            dir,
            endpoint,
            me,
            me_s: me.to_string(),
            db: Mutex::new(db),
            conns: Mutex::new(HashMap::new()),
            seen: Mutex::new(HashMap::new()),
            flushing: Mutex::new(HashSet::new()),
            transfers: Mutex::new(transfers),
            running: Mutex::new(HashMap::new()),
            partials: Mutex::new(HashMap::new()),
            parties: Mutex::new(HashMap::new()),
            caches: Mutex::new(HashMap::new()),
            buffering: Mutex::new(HashSet::new()),
            probe_tx,
            secret,
            http,
            mailbox: Mutex::new(mailbox),
        });
        let prober = node.clone();
        tauri::async_runtime::spawn(async move {
            while let Some((peer, reply)) = probe_rx.recv().await {
                let _ = reply.send(prober.measure_upload(&peer).await);
            }
        });

        let n2 = node.clone();
        tauri::async_runtime::spawn(async move {
            n2.log(&format!("started as {}", n2.me_s));
            n2.endpoint.online().await;
            n2.log(&format!("online: {:?}", n2.endpoint.addr()));
        });
        tauri::async_runtime::spawn(node.clone().accept_loop());
        tauri::async_runtime::spawn(node.clone().background_loop());
        Ok(node)
    }

    pub fn log(&self, msg: &str) {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(self.dir.join("net.log")) {
            let _ = writeln!(f, "{} {}", now(), msg);
        }
    }

    pub fn id(&self) -> String {
        self.me_s.clone()
    }

    pub fn friend_code(&self) -> String {
        format!("UAN-{}", BASE32_NOPAD.encode(self.me.as_bytes()))
    }

    pub fn my_name(&self) -> String {
        self.db
            .lock()
            .unwrap()
            .query_row("SELECT v FROM kv WHERE k = 'name'", [], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
            .unwrap_or_default()
    }

    fn kv(&self, k: &str) -> Option<String> {
        self.db.lock().unwrap().query_row("SELECT v FROM kv WHERE k = ?1", [k], |r| r.get(0)).optional().ok().flatten()
    }

    fn set_kv(&self, k: &str, v: &str) {
        let _ = self.db.lock().unwrap().execute("INSERT OR REPLACE INTO kv (k, v) VALUES (?1, ?2)", [k, v]);
    }

    pub fn my_profile(&self) -> Value {
        json!({ "status": self.kv("status").unwrap_or_default(), "avatar": self.kv("avatar"), "pv": self.my_pv() })
    }

    fn my_pv(&self) -> i64 {
        self.kv("pv").and_then(|v| v.parse().ok()).unwrap_or(0)
    }

    fn ping_req(&self) -> Req {
        Req::Ping { name: self.my_name(), status: self.kv("status").unwrap_or_default(), pv: self.my_pv() }
    }

    pub fn set_name(self: &Arc<Self>, name: &str) -> Result<(), String> {
        self.set_profile(name, None, None)
    }

    /// Name, status line ("Gaming 🎮") and profile picture (a small data: URL made by the window).
    pub fn set_profile(self: &Arc<Self>, name: &str, status: Option<&str>, avatar: Option<&str>) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 32 {
            return Err("Pick a name of 1–32 characters.".into());
        }
        self.set_kv("name", name);
        if let Some(st) = status {
            let st: String = st.trim().chars().take(60).collect();
            self.set_kv("status", &st);
        }
        if let Some(a) = avatar {
            if a.is_empty() {
                let _ = self.db.lock().unwrap().execute("DELETE FROM kv WHERE k = 'avatar'", []);
            } else {
                if !a.starts_with("data:image/") || a.len() > 200_000 {
                    return Err("That picture is too big.".into());
                }
                self.set_kv("avatar", a);
            }
        }
        self.set_kv("pv", &now().to_string());
        // Let everyone know.
        let req = self.ping_req();
        for p in self.known_peers() {
            let me = self.clone();
            let req = req.clone();
            tauri::async_runtime::spawn(async move {
                let _ = me.request(&p, &req).await;
            });
        }
        Ok(())
    }

    /// Someone told us their status and profile version; fetch the picture if it changed.
    fn note_profile(self: &Arc<Self>, peer: &str, status: &str, pv: i64) {
        let known: i64 = self
            .db
            .lock()
            .unwrap()
            .query_row("SELECT pv FROM profiles WHERE id = ?1", [peer], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
            .unwrap_or(-1);
        if pv <= known {
            return;
        }
        let status: String = status.chars().take(60).collect();
        let _ = self.db.lock().unwrap().execute(
            "INSERT INTO profiles (id, status, pv) VALUES (?1, ?2, 0) ON CONFLICT(id) DO UPDATE SET status = excluded.status",
            params![peer, status],
        );
        self.emit("contacts", Value::Null);
        let me = self.clone();
        let peer = peer.to_string();
        tauri::async_runtime::spawn(async move {
            if let Ok(v) = me.request(&peer, &Req::Profile).await {
                let avatar = v["avatar"].as_str().filter(|a| a.starts_with("data:image/") && a.len() <= 200_000);
                let _ = me.db.lock().unwrap().execute(
                    "INSERT INTO profiles (id, status, avatar, pv) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(id) DO UPDATE SET status = excluded.status, avatar = excluded.avatar, pv = excluded.pv",
                    params![peer, v["status"].as_str().unwrap_or(""), avatar, v["pv"].as_i64().unwrap_or(pv)],
                );
                if let Some(n) = v["name"].as_str() {
                    me.update_name(&peer, n);
                }
                me.emit("contacts", Value::Null);
            }
        });
    }

    // ----- Offline mailbox: encrypted, so only the recipient can read it -----

    pub fn mailbox_url(&self) -> String {
        self.mailbox.lock().unwrap().clone()
    }

    pub fn set_mailbox(&self, url: &str) -> Result<(), String> {
        let url = url.trim().trim_end_matches('/');
        if !url.is_empty() && !url.starts_with("https://") && !url.starts_with("http://127.0.0.1") && !url.starts_with("http://localhost") {
            return Err("The mailbox address must start with https://".into());
        }
        self.set_kv("mailbox", url);
        *self.mailbox.lock().unwrap() = url.to_string();
        Ok(())
    }

    fn sign_hex(&self, msg: &str) -> String {
        HEXLOWER.encode(&self.secret.sign(msg.as_bytes()).to_bytes())
    }

    /// Our Ed25519 identity, converted for encryption (X25519).
    fn box_for(&self, peer: &str) -> Result<SalsaBox, String> {
        let id = parse_id(peer)?;
        let their = curve25519_dalek::edwards::CompressedEdwardsY(*id.as_bytes())
            .decompress()
            .ok_or("Bad key.")?
            .to_montgomery()
            .to_bytes();
        let hash = Sha512::digest(self.secret.to_bytes());
        let mut mine = [0u8; 32];
        mine.copy_from_slice(&hash[..32]);
        Ok(SalsaBox::new(&crypto_box::PublicKey::from(their), &crypto_box::SecretKey::from(mine)))
    }

    fn seal(&self, peer: &str, req: &Req) -> Result<String, String> {
        let b = self.box_for(peer)?;
        let nonce = SalsaBox::generate_nonce(&mut OsRng);
        let ct = b.encrypt(&nonce, serde_json::to_vec(req).map_err(e2s)?.as_slice()).map_err(|_| "Encryption failed.".to_string())?;
        let mut out = nonce.to_vec();
        out.extend_from_slice(&ct);
        Ok(BASE64.encode(&out))
    }

    fn open_box(&self, peer: &str, sealed: &str) -> Result<Req, String> {
        let raw = BASE64.decode(sealed.as_bytes()).map_err(e2s)?;
        if raw.len() < 24 {
            return Err("Too short.".into());
        }
        let b = self.box_for(peer)?;
        let nonce = crypto_box::Nonce::from_slice(&raw[..24]);
        let plain = b.decrypt(nonce, &raw[24..]).map_err(|_| "Can't decrypt.".to_string())?;
        serde_json::from_slice(&plain).map_err(e2s)
    }

    fn mailbox_ok(req: &Req) -> bool {
        matches!(req, Req::Msg { .. } | Req::FriendRequest { .. } | Req::FriendAccept { .. } | Req::FriendRemove | Req::Group { .. } | Req::GroupLeave { .. })
    }

    async fn mailbox_post(&self, path: &str, body: Value) -> Result<Value, String> {
        let url = self.mailbox_url();
        if url.is_empty() {
            return Err("No mailbox.".into());
        }
        let r = self.http.post(format!("{url}{path}")).json(&body).send().await.map_err(e2s)?;
        let v: Value = r.json().await.map_err(e2s)?;
        if v["ok"].as_bool() == Some(true) { Ok(v) } else { Err(v["error"].as_str().unwrap_or("Mailbox error.").to_string()) }
    }

    async fn mailbox_send(&self, peer: &str, req: &Req) -> Result<(), String> {
        let sealed = self.seal(peer, req)?;
        let ts = now();
        let digest = HEXLOWER.encode(&Sha256::digest(sealed.as_bytes()));
        let sig = self.sign_hex(&format!("send:{peer}:{ts}:{digest}"));
        self.mailbox_post("/send", json!({ "from": self.me_s, "to": peer, "box": sealed, "ts": ts, "sig": sig })).await?;
        self.log(&format!("mailbox: left a message for {}", &peer[..8]));
        Ok(())
    }

    /// Picks up anything friends left while we were offline.
    pub async fn mailbox_poll(self: &Arc<Self>) {
        if self.mailbox_url().is_empty() {
            return;
        }
        loop {
            let ts = now();
            let sig = self.sign_hex(&format!("fetch:{}:{ts}", self.me_s));
            let Ok(v) = self.mailbox_post("/fetch", json!({ "who": self.me_s, "ts": ts, "sig": sig })).await else { return };
            let mail = v["mail"].as_array().cloned().unwrap_or_default();
            if mail.is_empty() {
                return;
            }
            let mut ids = Vec::new();
            for m in &mail {
                let (Some(id), Some(from), Some(sealed)) = (m["id"].as_i64(), m["sender"].as_str(), m["box"].as_str()) else { continue };
                ids.push(id);
                match self.open_box(from, sealed) {
                    Ok(req) if Self::mailbox_ok(&req) => {
                        if let Err(e) = self.on_request(from, req) {
                            self.log(&format!("mailbox: message from {} refused: {e}", &from[..from.len().min(8)]));
                        }
                    }
                    _ => self.log(&format!("mailbox: dropped an unreadable message from {}", &from[..from.len().min(8)])),
                }
            }
            self.log(&format!("mailbox: picked up {} message(s)", ids.len()));
            let ts = now();
            let list = ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
            let sig = self.sign_hex(&format!("ack:{}:{ts}:{list}", self.me_s));
            if self.mailbox_post("/ack", json!({ "who": self.me_s, "ts": ts, "ids": ids, "sig": sig })).await.is_err() {
                return;
            }
            if mail.len() < 200 {
                return;
            }
        }
    }

    fn emit(&self, event: &str, payload: Value) {
        let _ = self.app.emit(event, payload);
    }

    fn window_focused(&self) -> bool {
        self.app
            .get_webview_window("main")
            .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
            .unwrap_or(false)
    }

    fn notify(&self, title: &str, body: &str) {
        if !self.window_focused() {
            let _ = self.app.notification().builder().title(title).body(body).show();
        }
    }

    // ----- Presence -----

    fn is_online(&self, peer: &str) -> bool {
        self.seen.lock().unwrap().get(peer).map(|t| t.elapsed() < ONLINE_WINDOW).unwrap_or(false)
    }

    fn mark_seen(&self, peer: &str) {
        let was = self.is_online(peer);
        self.seen.lock().unwrap().insert(peer.to_string(), Instant::now());
        if !was {
            self.emit("presence", json!({ "id": peer, "online": true }));
        }
    }

    fn known_peers(&self) -> Vec<String> {
        let db = self.db.lock().unwrap();
        let mut stmt = db
            .prepare(
                "SELECT id FROM contacts WHERE status = 'friend'
                 UNION SELECT member_id FROM group_members",
            )
            .unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.filter_map(Result::ok).filter(|p| *p != self.me_s).collect()
    }

    // ----- Connections -----

    async fn conn(self: &Arc<Self>, peer: EndpointId) -> Result<Connection, String> {
        if let Some(c) = self.conns.lock().unwrap().get(&peer) {
            if c.close_reason().is_none() {
                return Ok(c.clone());
            }
        }
        let c = tokio::time::timeout(Duration::from_secs(20), self.endpoint.connect(peer, ALPN))
            .await
            .map_err(|_| { self.log(&format!("connect {} timed out", peer.fmt_short())); "offline".to_string() })?
            .map_err(|e| { self.log(&format!("connect {} failed: {e:?}", peer.fmt_short())); e2s(e) })?;
        self.log(&format!("connected to {}", peer.fmt_short()));
        self.conns.lock().unwrap().insert(peer, c.clone());
        // The other side may open streams on this connection too.
        tauri::async_runtime::spawn(self.clone().serve_conn(c.clone()));
        Ok(c)
    }

    async fn request(self: &Arc<Self>, peer: &str, req: &Req) -> Result<Value, ReqError> {
        let id = parse_id(peer).map_err(ReqError::Refused)?;
        if id == self.me {
            return Err(ReqError::Refused("That's you.".into()));
        }
        // A cached connection can be stale (e.g. they restarted UaN); if it fails, retry once with a fresh one.
        for attempt in 0..2 {
            let cached = self.conns.lock().unwrap().get(&id).map(|c| c.close_reason().is_none()).unwrap_or(false);
            let conn = self.conn(id).await.map_err(ReqError::Offline)?;
            let exchange = async {
                let (mut send, mut recv) = conn.open_bi().await.map_err(e2s)?;
                write_frame(&mut send, req).await?;
                send.finish().map_err(e2s)?;
                read_frame::<Value>(&mut recv).await
            };
            let limit = Duration::from_secs(if cached && attempt == 0 { 10 } else { 30 });
            let failure = match tokio::time::timeout(limit, exchange).await {
                Ok(Ok(v)) => {
                    self.mark_seen(peer);
                    return if v["ok"].as_bool() == Some(true) {
                        Ok(v)
                    } else {
                        Err(ReqError::Refused(v["error"].as_str().unwrap_or("Refused.").to_string()))
                    };
                }
                Ok(Err(e)) => e,
                Err(_) => "timeout".to_string(),
            };
            self.conns.lock().unwrap().remove(&id);
            if !(cached && attempt == 0) {
                return Err(ReqError::Offline(failure));
            }
        }
        Err(ReqError::Offline("unreachable".into()))
    }

    async fn accept_loop(self: Arc<Self>) {
        while let Some(incoming) = self.endpoint.accept().await {
            let me = self.clone();
            tauri::async_runtime::spawn(async move {
                let Ok(conn) = incoming.await else { return };
                let peer = conn.remote_id();
                me.conns.lock().unwrap().insert(peer, conn.clone());
                let p = peer.to_string();
                me.mark_seen(&p);
                tauri::async_runtime::spawn(me.clone().flush(p));
                me.serve_conn(conn).await;
            });
        }
    }

    async fn serve_conn(self: Arc<Self>, conn: Connection) {
        let peer = conn.remote_id().to_string();
        while let Ok((send, recv)) = conn.accept_bi().await {
            let me = self.clone();
            let p = peer.clone();
            tauri::async_runtime::spawn(async move { me.handle(p, send, recv).await });
        }
    }

    async fn handle(self: Arc<Self>, peer: String, mut send: SendStream, mut recv: RecvStream) {
        let Ok(req) = read_frame::<Req>(&mut recv).await else { return };
        self.mark_seen(&peer);
        if let Req::FileGet { file_id, offset, len } = req {
            self.serve_file(&peer, &file_id, offset, len, send).await;
            return;
        }
        if let Req::Probe { bytes } = req {
            self.serve_probe(&peer, bytes, send).await;
            return;
        }
        if let Req::ProbeMe = req {
            let rate = if self.known_peers().iter().any(|p| *p == peer) {
                let (tx, rx) = tokio::sync::oneshot::channel();
                let _ = self.probe_tx.send((peer.clone(), tx));
                rx.await.ok().flatten()
            } else {
                None
            };
            let _ = write_frame(&mut send, &json!({ "ok": true, "rate": rate })).await;
            let _ = send.finish();
            return;
        }
        let resp = match self.on_request(&peer, req) {
            Ok(v) => v,
            Err(e) => json!({ "ok": false, "error": e }),
        };
        let _ = write_frame(&mut send, &resp).await;
        let _ = send.finish();
    }

    // ----- Outbox: everything we send goes through here so nothing is lost while a friend is offline -----

    fn deliver(self: &Arc<Self>, peer: &str, req: &Req) {
        if peer == self.me_s {
            return;
        }
        let payload = serde_json::to_string(req).unwrap();
        let _ = self.db.lock().unwrap().execute(
            "INSERT INTO outbox (peer, payload, created_at) VALUES (?1, ?2, ?3)",
            params![peer, payload, now()],
        );
        tauri::async_runtime::spawn(self.clone().flush(peer.to_string()));
    }

    async fn flush(self: Arc<Self>, peer: String) {
        if !self.flushing.lock().unwrap().insert(peer.clone()) {
            return;
        }
        loop {
            let row: Option<(i64, String)> = self
                .db
                .lock()
                .unwrap()
                .query_row("SELECT seq, payload FROM outbox WHERE peer = ?1 ORDER BY seq LIMIT 1", [&peer], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .optional()
                .unwrap_or(None);
            let Some((seq, payload)) = row else { break };
            let delivered = match serde_json::from_str::<Req>(&payload) {
                Ok(req) => match self.request(&peer, &req).await {
                    Err(ReqError::Offline(_)) => Self::mailbox_ok(&req) && self.mailbox_send(&peer, &req).await.is_ok(),
                    _ => true,
                },
                Err(_) => true,
            };
            if !delivered {
                break;
            }
            let _ = self.db.lock().unwrap().execute("DELETE FROM outbox WHERE seq = ?1", [seq]);
        }
        self.flushing.lock().unwrap().remove(&peer);
    }

    async fn background_loop(self: Arc<Self>) {
        let mut tick: u64 = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            tick += 1;
            if !self.running.lock().unwrap().is_empty() {
                self.emit_transfers();
            }
            if tick % 30 == 5 {
                // Retry anything waiting in the outbox.
                let peers: Vec<String> = {
                    let db = self.db.lock().unwrap();
                    let mut stmt = db.prepare("SELECT DISTINCT peer FROM outbox").unwrap();
                    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
                    rows.filter_map(Result::ok).collect()
                };
                for p in peers {
                    tauri::async_runtime::spawn(self.clone().flush(p));
                }
            }
            if tick == 3 || tick % 30 == 15 {
                let me = self.clone();
                tauri::async_runtime::spawn(async move { me.mailbox_poll().await });
            }
            if tick % 60 == 2 {
                // Ping friends and group members to show who is online.
                let ping = self.ping_req();
                for p in self.known_peers() {
                    let me = self.clone();
                    let ping = ping.clone();
                    tauri::async_runtime::spawn(async move {
                        let was = me.is_online(&p);
                        match me.request(&p, &ping).await {
                            Ok(v) => {
                                if let Some(n) = v["name"].as_str() {
                                    me.update_name(&p, n);
                                }
                                me.note_profile(&p, v["status"].as_str().unwrap_or(""), v["pv"].as_i64().unwrap_or(0));
                            }
                            Err(_) => {
                                if was && !me.is_online(&p) {
                                    me.emit("presence", json!({ "id": p, "online": false }));
                                }
                            }
                        }
                    });
                }
            }
        }
    }

    fn update_name(&self, peer: &str, name: &str) {
        let name: String = name.trim().chars().take(32).collect();
        if name.is_empty() {
            return;
        }
        let db = self.db.lock().unwrap();
        let a = db.execute("UPDATE contacts SET name = ?2 WHERE id = ?1 AND name <> ?2", params![peer, name]).unwrap_or(0);
        let b = db.execute("UPDATE group_members SET name = ?2 WHERE member_id = ?1 AND name <> ?2", params![peer, name]).unwrap_or(0);
        drop(db);
        if a + b > 0 {
            self.emit("contacts", Value::Null);
        }
    }

    // ----- Incoming requests -----

    fn contact_status(&self, peer: &str) -> Option<String> {
        self.db
            .lock()
            .unwrap()
            .query_row("SELECT status FROM contacts WHERE id = ?1", [peer], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    fn is_member(&self, group: &str, who: &str) -> bool {
        self.db
            .lock()
            .unwrap()
            .query_row("SELECT 1 FROM group_members WHERE group_id = ?1 AND member_id = ?2", [group, who], |_| Ok(()))
            .optional()
            .ok()
            .flatten()
            .is_some()
    }

    fn on_request(self: &Arc<Self>, peer: &str, req: Req) -> Result<Value, String> {
        let ok = json!({ "ok": true });
        match req {
            Req::Ping { name, status, pv } => {
                self.update_name(peer, &name);
                self.note_profile(peer, &status, pv);
                Ok(json!({ "ok": true, "name": self.my_name(), "status": self.kv("status").unwrap_or_default(), "pv": self.my_pv() }))
            }
            Req::Profile => {
                if !self.known_peers().iter().any(|p| p == peer) {
                    return Err("Not allowed.".into());
                }
                let p = self.my_profile();
                Ok(json!({ "ok": true, "name": self.my_name(), "status": p["status"], "avatar": p["avatar"], "pv": p["pv"] }))
            }
            Req::FriendRequest { name } => {
                match self.contact_status(peer).as_deref() {
                    Some("friend") => {
                        self.deliver(peer, &Req::FriendAccept { name: self.my_name() });
                    }
                    Some("outgoing") => {
                        // We both asked: that's a yes.
                        self.set_contact(peer, &name, "friend");
                        self.deliver(peer, &Req::FriendAccept { name: self.my_name() });
                        self.notify(&name, "You are now friends on UaN.");
                    }
                    _ => {
                        self.set_contact(peer, &name, "incoming");
                        self.notify(&name, "wants to be your friend on UaN.");
                    }
                }
                Ok(ok)
            }
            Req::FriendAccept { name } => {
                match self.contact_status(peer).as_deref() {
                    Some("outgoing") | Some("friend") => {
                        self.set_contact(peer, &name, "friend");
                        Ok(ok)
                    }
                    _ => Err("No friend request to accept.".into()),
                }
            }
            Req::FriendRemove => {
                let _ = self.db.lock().unwrap().execute("DELETE FROM contacts WHERE id = ?1", [peer]);
                self.emit("contacts", Value::Null);
                Ok(ok)
            }
            Req::Msg { msg } => {
                if let Some(f) = &msg.file {
                    if f.owner != peer || f.size > MAX_FILE_SIZE {
                        return Err("Invalid file.".into());
                    }
                }
                let text = msg.text.as_ref().map(|t| t.chars().take(5000).collect::<String>());
                let chat = match &msg.group {
                    Some(g) => {
                        if !self.is_member(g, peer) || !self.is_member(g, &self.me_s) {
                            return Err("You are not in that group.".into());
                        }
                        format!("g:{g}")
                    }
                    None => {
                        if self.contact_status(peer).as_deref() != Some("friend") {
                            return Err("You are not friends.".into());
                        }
                        peer.to_string()
                    }
                };
                let name: String = msg.name.chars().take(32).collect();
                let inserted = self.store_message(&msg.id, &chat, peer, &name, text.as_deref(), msg.file.as_ref(), msg.ts);
                if inserted {
                    self.update_name(peer, &name);
                    let body = match (&msg.file, &text) {
                        (Some(f), _) => format!("Sent a file: {}", f.name),
                        (None, Some(t)) => t.chars().take(120).collect(),
                        _ => "New message".into(),
                    };
                    let title = match &msg.group {
                        Some(g) => format!("{} · {}", name, self.group_name(g)),
                        None => name.clone(),
                    };
                    self.notify(&title, &body);
                }
                Ok(ok)
            }
            Req::Group { group } => {
                let existing: Option<(String, i64)> = self
                    .db
                    .lock()
                    .unwrap()
                    .query_row("SELECT owner, version FROM groups WHERE id = ?1", [&group.id], |r| Ok((r.get(0)?, r.get(1)?)))
                    .optional()
                    .map_err(e2s)?;
                let allowed = match &existing {
                    Some((owner, version)) => owner == peer && group.version > *version,
                    None => group.owner == peer,
                };
                if !allowed {
                    return Ok(ok); // stale or not from the owner: ignore quietly
                }
                if group.members.iter().any(|m| m.id == self.me_s) {
                    let is_new = existing.is_none();
                    self.save_group(&group);
                    if is_new {
                        self.notify(&group.name, "You were added to a group on UaN.");
                    }
                } else if existing.is_some() {
                    self.delete_group_local(&group.id);
                }
                Ok(ok)
            }
            Req::GroupLeave { group_id } => {
                if self.is_member(&group_id, peer) {
                    let _ = self
                        .db
                        .lock()
                        .unwrap()
                        .execute("DELETE FROM group_members WHERE group_id = ?1 AND member_id = ?2", [&group_id, peer]);
                    if self.group_owner(&group_id).as_deref() == Some(self.me_s.as_str()) {
                        self.bump_and_broadcast(&group_id, &[]);
                    }
                    self.emit("contacts", Value::Null);
                }
                Ok(ok)
            }
            Req::Party { party } => {
                // Updates come from the host; when the host leaves, its last update names the new host.
                let stored_leader = self.parties.lock().unwrap().get(&party.id).map(|p| p.leader.clone());
                let from_host = party.leader == peer || stored_leader.as_deref() == Some(peer);
                if !from_host
                    || !party.members.iter().any(|m| m.id == self.me_s)
                    || !self.is_member(&party.group, peer)
                    || !self.is_member(&party.group, &self.me_s)
                {
                    return Err("Not allowed.".into());
                }
                let (is_new, newer) = {
                    let parties = self.parties.lock().unwrap();
                    match parties.get(&party.id) {
                        Some(p) => (false, party.version > p.version),
                        None => (true, true),
                    }
                };
                if !newer {
                    return Ok(ok);
                }
                if party.state == "ended" {
                    self.parties.lock().unwrap().remove(&party.id);
                    self.stop_stream(&party.file.id);
                } else {
                    self.parties.lock().unwrap().insert(party.id.clone(), party.clone());
                }
                let _ = self.app.emit("party", &party);
                if is_new && party.state != "ended" {
                    let from = party.members.iter().find(|m| m.id == peer).map(|m| m.name.clone()).unwrap_or_default();
                    self.notify(&format!("{} · {}", from, self.group_name(&party.group)), &format!("Invited you to watch {} together", party.file.name));
                }
                Ok(ok)
            }
            Req::PartyReport { party_id, have, joined, left, ready, buffering } => {
                let leads = self.parties.lock().unwrap().get(&party_id).map(|p| p.leader == self.me_s).unwrap_or(false);
                if !leads {
                    return Err("Not the host.".into());
                }
                self.apply_report(&party_id, peer, have, joined, left, ready, buffering);
                Ok(ok)
            }
            Req::PartyControl { party_id, state, position } => {
                let allowed = self
                    .parties
                    .lock()
                    .unwrap()
                    .get(&party_id)
                    .map(|p| p.leader == self.me_s && p.members.iter().any(|m| m.id == peer && m.joined && !m.left))
                    .unwrap_or(false);
                if !allowed || !matches!(state.as_str(), "playing" | "paused") {
                    return Err("Not allowed.".into());
                }
                self.apply_control(&party_id, &state, position);
                Ok(ok)
            }
            Req::FileGet { .. } | Req::Probe { .. } | Req::ProbeMe => Err("Unexpected.".into()),
        }
    }

    fn set_contact(&self, peer: &str, name: &str, status: &str) {
        let name: String = name.trim().chars().take(32).collect();
        let name = if name.is_empty() { "Unknown".to_string() } else { name };
        let _ = self.db.lock().unwrap().execute(
            "INSERT INTO contacts (id, name, status, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status",
            params![peer, name, status, now()],
        );
        self.emit("contacts", Value::Null);
    }

    fn store_message(&self, id: &str, chat: &str, sender: &str, name: &str, text: Option<&str>, file: Option<&FileMeta>, ts: i64) -> bool {
        let file_json = file.map(|f| serde_json::to_string(f).unwrap());
        let n = self
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT OR IGNORE INTO messages (id, chat, sender, sender_name, text, file, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, chat, sender, name, text, file_json, ts],
            )
            .unwrap_or(0);
        if n > 0 {
            self.emit(
                "message",
                json!({ "id": id, "chat": chat, "sender": sender, "senderName": name, "text": text, "file": file, "ts": ts, "mine": sender == self.me_s }),
            );
        }
        n > 0
    }

    // ----- Groups -----

    fn group_owner(&self, g: &str) -> Option<String> {
        self.db.lock().unwrap().query_row("SELECT owner FROM groups WHERE id = ?1", [g], |r| r.get(0)).optional().ok().flatten()
    }

    fn group_name(&self, g: &str) -> String {
        self.db.lock().unwrap().query_row("SELECT name FROM groups WHERE id = ?1", [g], |r| r.get(0)).optional().ok().flatten().unwrap_or_default()
    }

    fn load_group(&self, g: &str) -> Option<WireGroup> {
        let db = self.db.lock().unwrap();
        let (name, owner, version): (String, String, i64) = db
            .query_row("SELECT name, owner, version FROM groups WHERE id = ?1", [g], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()
            .ok()
            .flatten()?;
        let mut stmt = db.prepare("SELECT member_id, name FROM group_members WHERE group_id = ?1 ORDER BY name").ok()?;
        let members = stmt
            .query_map([g], |r| Ok(Member { id: r.get(0)?, name: r.get(1)? }))
            .ok()?
            .filter_map(Result::ok)
            .collect();
        Some(WireGroup { id: g.to_string(), name, owner, version, members })
    }

    fn save_group(&self, g: &WireGroup) {
        {
            let db = self.db.lock().unwrap();
            let _ = db.execute(
                "INSERT INTO groups (id, name, owner, version) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, owner = excluded.owner, version = excluded.version",
                params![g.id, g.name, g.owner, g.version],
            );
            let _ = db.execute("DELETE FROM group_members WHERE group_id = ?1", [&g.id]);
            for m in &g.members {
                let name: String = m.name.chars().take(32).collect();
                let _ = db.execute("INSERT OR REPLACE INTO group_members (group_id, member_id, name) VALUES (?1, ?2, ?3)", params![g.id, m.id, name]);
            }
        }
        self.emit("contacts", Value::Null);
    }

    fn delete_group_local(&self, g: &str) {
        {
            let db = self.db.lock().unwrap();
            let _ = db.execute("DELETE FROM group_members WHERE group_id = ?1", [g]);
            let _ = db.execute("DELETE FROM groups WHERE id = ?1", [g]);
        }
        self.emit("contacts", Value::Null);
    }

    /// Owner only: bump the version and send the group to current members plus `also` (e.g. removed people).
    fn bump_and_broadcast(self: &Arc<Self>, g: &str, also: &[String]) {
        let Some(mut group) = self.load_group(g) else { return };
        group.version += 1;
        self.save_group(&group);
        let req = Req::Group { group: group.clone() };
        let mut targets: Vec<String> = group.members.iter().map(|m| m.id.clone()).collect();
        targets.extend(also.iter().cloned());
        for t in targets {
            self.deliver(&t, &req);
        }
    }

    pub fn create_group(self: &Arc<Self>, name: &str, friend_ids: &[String]) -> Result<String, String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 40 {
            return Err("Give the group a name (up to 40 characters).".into());
        }
        let mut members = vec![Member { id: self.me_s.clone(), name: self.my_name() }];
        for id in friend_ids {
            let n = self.friend_name(id).ok_or("You can only add your friends.")?;
            members.push(Member { id: id.clone(), name: n });
        }
        let group = WireGroup { id: new_id(), name: name.to_string(), owner: self.me_s.clone(), version: 1, members };
        self.save_group(&group);
        let req = Req::Group { group: group.clone() };
        for m in &group.members {
            self.deliver(&m.id, &req);
        }
        Ok(group.id)
    }

    pub fn group_action(self: &Arc<Self>, g: &str, action: &str, ids: &[String], name: &str) -> Result<(), String> {
        let group = self.load_group(g).ok_or("That group no longer exists.")?;
        let owner = group.owner == self.me_s;
        match action {
            "add" | "remove" | "rename" | "delete" if !owner => Err("Only the group's creator can do that.".into()),
            "add" => {
                let db_names: Vec<(String, String)> = ids
                    .iter()
                    .filter_map(|id| self.friend_name(id).map(|n| (id.clone(), n)))
                    .collect();
                {
                    let db = self.db.lock().unwrap();
                    for (id, n) in &db_names {
                        let _ = db.execute("INSERT OR REPLACE INTO group_members (group_id, member_id, name) VALUES (?1, ?2, ?3)", params![g, id, n]);
                    }
                }
                self.bump_and_broadcast(g, &[]);
                Ok(())
            }
            "remove" => {
                {
                    let db = self.db.lock().unwrap();
                    for id in ids.iter().filter(|id| **id != self.me_s) {
                        let _ = db.execute("DELETE FROM group_members WHERE group_id = ?1 AND member_id = ?2", [g, id]);
                    }
                }
                self.bump_and_broadcast(g, ids);
                Ok(())
            }
            "rename" => {
                let name = name.trim();
                if name.is_empty() || name.chars().count() > 40 {
                    return Err("Give the group a name (up to 40 characters).".into());
                }
                let _ = self.db.lock().unwrap().execute("UPDATE groups SET name = ?2 WHERE id = ?1", [g, name]);
                self.bump_and_broadcast(g, &[]);
                Ok(())
            }
            "delete" => {
                let everyone: Vec<String> = group.members.iter().map(|m| m.id.clone()).collect();
                let _ = self.db.lock().unwrap().execute("DELETE FROM group_members WHERE group_id = ?1", [g]);
                self.bump_and_broadcast(g, &everyone);
                self.delete_group_local(g);
                Ok(())
            }
            "leave" => {
                for m in &group.members {
                    self.deliver(&m.id, &Req::GroupLeave { group_id: g.to_string() });
                }
                self.delete_group_local(g);
                Ok(())
            }
            _ => Err("Unknown action.".into()),
        }
    }

    // ----- Friends -----

    fn friend_name(&self, id: &str) -> Option<String> {
        self.db
            .lock()
            .unwrap()
            .query_row("SELECT name FROM contacts WHERE id = ?1 AND status = 'friend'", [id], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn add_friend(self: &Arc<Self>, code: &str) -> Result<String, String> {
        let peer = parse_code(code)?;
        if peer == self.me {
            return Err("That's your own code. Send it to a friend instead.".into());
        }
        let p = peer.to_string();
        match self.contact_status(&p).as_deref() {
            Some("friend") => return Err("You are already friends.".into()),
            Some("incoming") => {
                self.friend_action(&p, "accept")?;
                return Ok("You are now friends.".into());
            }
            _ => {}
        }
        self.set_contact(&p, "Pending…", "outgoing");
        self.deliver(&p, &Req::FriendRequest { name: self.my_name() });
        Ok("Friend request sent. It arrives as soon as they are online.".into())
    }

    pub fn friend_action(self: &Arc<Self>, peer: &str, action: &str) -> Result<(), String> {
        match action {
            "accept" => {
                let name = self
                    .db
                    .lock()
                    .unwrap()
                    .query_row("SELECT name FROM contacts WHERE id = ?1 AND status = 'incoming'", [peer], |r| r.get::<_, String>(0))
                    .optional()
                    .map_err(e2s)?
                    .ok_or("That request is gone.")?;
                self.set_contact(peer, &name, "friend");
                self.deliver(peer, &Req::FriendAccept { name: self.my_name() });
                Ok(())
            }
            "remove" => {
                let _ = self.db.lock().unwrap().execute("DELETE FROM contacts WHERE id = ?1", [peer]);
                let _ = self.db.lock().unwrap().execute("DELETE FROM outbox WHERE peer = ?1", [peer]);
                self.deliver(peer, &Req::FriendRemove);
                self.emit("contacts", Value::Null);
                Ok(())
            }
            _ => Err("Unknown action.".into()),
        }
    }

    pub fn contacts(&self) -> Value {
        let db = self.db.lock().unwrap();
        let mut stmt = db
            .prepare("SELECT c.id, c.name, c.status, (SELECT MAX(ts) FROM messages WHERE chat = c.id), p.avatar, p.status FROM contacts c LEFT JOIN profiles p ON p.id = c.id ORDER BY c.name")
            .unwrap();
        let rows: Vec<(String, String, String, Option<i64>, Option<String>, Option<String>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        let (mut friends, mut incoming, mut outgoing) = (vec![], vec![], vec![]);
        for (id, name, status, last, avatar, mood) in rows {
            let item = json!({ "id": id, "name": name, "online": self.is_online(&id), "lastAt": last, "avatar": avatar, "status": mood.unwrap_or_default() });
            match status.as_str() {
                "friend" => friends.push(item),
                "incoming" => incoming.push(item),
                "outgoing" => outgoing.push(item),
                _ => {}
            }
        }
        let mut stmt = db.prepare("SELECT id, name, owner, (SELECT MAX(ts) FROM messages WHERE chat = 'g:' || groups.id) FROM groups").unwrap();
        let groups_raw: Vec<(String, String, String, Option<i64>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        let mut groups = vec![];
        for (id, name, owner, last) in groups_raw {
            let mut ms = db
                .prepare("SELECT m.member_id, m.name, p.avatar, p.status FROM group_members m LEFT JOIN profiles p ON p.id = m.member_id WHERE m.group_id = ?1 ORDER BY m.name")
                .unwrap();
            let members: Vec<Value> = ms
                .query_map([&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?)))
                .unwrap()
                .filter_map(Result::ok)
                .map(|(mid, mname, avatar, mood)| json!({ "id": mid, "name": mname, "online": mid == self.me_s || self.is_online(&mid), "avatar": avatar, "status": mood.unwrap_or_default() }))
                .collect();
            groups.push(json!({ "id": id, "name": name, "owner": owner, "members": members, "lastAt": last }));
        }
        json!({ "friends": friends, "incoming": incoming, "outgoing": outgoing, "groups": groups })
    }

    // ----- Messages -----

    pub fn messages(&self, chat: &str, limit: usize) -> Vec<Value> {
        let db = self.db.lock().unwrap();
        let mut stmt = db
            .prepare("SELECT id, chat, sender, sender_name, text, file, ts FROM messages WHERE chat = ?1 ORDER BY seq DESC LIMIT ?2")
            .unwrap();
        let mut rows: Vec<Value> = stmt
            .query_map(params![chat, limit.clamp(1, 20000) as i64], |r| {
                let sender: String = r.get(2)?;
                let file: Option<String> = r.get(5)?;
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "chat": r.get::<_, String>(1)?,
                    "sender": sender,
                    "senderName": r.get::<_, String>(3)?,
                    "text": r.get::<_, Option<String>>(4)?,
                    "file": file.and_then(|f| serde_json::from_str::<Value>(&f).ok()),
                    "ts": r.get::<_, i64>(6)?,
                    "mine": sender == self.me_s,
                }))
            })
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        rows.reverse();
        rows
    }

    /// Recipients of a chat id: a friend's id, or "g:<group>" for everyone in the group.
    fn chat_targets(&self, chat: &str) -> Result<(Option<String>, Vec<String>), String> {
        if let Some(g) = chat.strip_prefix("g:") {
            let group = self.load_group(g).ok_or("That group no longer exists.")?;
            if !group.members.iter().any(|m| m.id == self.me_s) {
                return Err("You are not in that group.".into());
            }
            Ok((Some(g.to_string()), group.members.into_iter().map(|m| m.id).filter(|id| *id != self.me_s).collect()))
        } else {
            if self.contact_status(chat).as_deref() != Some("friend") {
                return Err("You can only message your friends.".into());
            }
            Ok((None, vec![chat.to_string()]))
        }
    }

    pub fn send(self: &Arc<Self>, chats: &[String], text: Option<String>, file: Option<FileMeta>) -> Result<(), String> {
        let text = text.map(|t| t.trim().chars().take(5000).collect::<String>()).filter(|t| !t.is_empty());
        if text.is_none() && file.is_none() {
            return Err("Nothing to send.".into());
        }
        let name = self.my_name();
        for chat in chats {
            let (group, targets) = self.chat_targets(chat)?;
            let msg = WireMsg { id: new_id(), group, name: name.clone(), text: text.clone(), file: file.clone(), ts: now() };
            if let Some(f) = &file {
                let _ = self.db.lock().unwrap().execute("INSERT OR IGNORE INTO file_access (file_id, who) VALUES (?1, ?2)", [&f.id, chat]);
            }
            self.store_message(&msg.id, chat, &self.me_s, &name, msg.text.as_deref(), msg.file.as_ref(), msg.ts);
            let req = Req::Msg { msg };
            for t in targets {
                self.deliver(&t, &req);
            }
        }
        Ok(())
    }

    /// Self-test only: registers a local video as if we had sent it, so the player can be tested on this PC.
    pub fn selftest_file(&self, path: &str) -> Result<FileMeta, String> {
        let p = PathBuf::from(path);
        let size = std::fs::metadata(&p).map_err(e2s)?.len();
        let file = FileMeta { id: new_id(), name: p.file_name().and_then(|n| n.to_str()).unwrap_or("test").to_string(), size, mime: guess_mime(&p).to_string(), owner: self.me_s.clone() };
        self.db.lock().unwrap().execute(
            "INSERT INTO shared_files (id, path, name, size, mime, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![file.id, path, file.name, size as i64, file.mime, now()],
        ).map_err(e2s)?;
        Ok(file)
    }

    pub fn share_files(self: &Arc<Self>, paths: Vec<PathBuf>, chats: &[String], text: Option<String>) -> Result<usize, String> {
        for chat in chats {
            self.chat_targets(chat)?;
        }
        let mut errors = vec![];
        let mut sent = 0;
        let mut note = text;
        for path in paths {
            let meta = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => {
                    errors.push(format!("{}: can't be read.", path.display()));
                    continue;
                }
            };
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
            if meta.is_dir() {
                errors.push(format!("{name}: folders can't be sent, only files."));
                continue;
            }
            if meta.len() > MAX_FILE_SIZE {
                errors.push(format!("{name}: too big, the limit is 4 TB."));
                continue;
            }
            let file = FileMeta { id: new_id(), name: name.clone(), size: meta.len(), mime: guess_mime(&path).to_string(), owner: self.me_s.clone() };
            let _ = self.db.lock().unwrap().execute(
                "INSERT INTO shared_files (id, path, name, size, mime, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![file.id, path.to_string_lossy(), file.name, file.size as i64, file.mime, now()],
            );
            self.send(chats, note.take(), Some(file))?;
            sent += 1;
        }
        if errors.is_empty() { Ok(sent) } else { Err(errors.join("\n")) }
    }

    // ----- Serving files: our own files, and in groups also what we downloaded (even partly) -----

    fn in_group_chat(&self, chat: &str, peer: &str) -> bool {
        chat.strip_prefix("g:").map(|g| self.is_member(g, peer)).unwrap_or(false)
    }

    fn source_for(&self, peer: &str, file_id: &str) -> Option<Source> {
        let (own, dl): (Option<(String, i64)>, Option<(String, String)>) = {
            let db = self.db.lock().unwrap();
            let own = db
                .query_row(
                    "SELECT f.path, f.size FROM shared_files f WHERE f.id = ?1 AND EXISTS (
                       SELECT 1 FROM file_access a WHERE a.file_id = f.id AND (
                         a.who = ?2 OR EXISTS (SELECT 1 FROM group_members m WHERE 'g:' || m.group_id = a.who AND m.member_id = ?2)))",
                    params![file_id, peer],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .ok()
                .flatten();
            let dl = db
                .query_row("SELECT path, COALESCE(chat, '') FROM downloads WHERE file_id = ?1", [file_id], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()
                .ok()
                .flatten();
            (own, dl)
        };
        if let Some((p, s)) = own {
            return Some(Source::Whole(PathBuf::from(p), s as u64));
        }
        if let Some((p, chat)) = dl {
            if self.in_group_chat(&chat, peer) {
                if let Ok(m) = std::fs::metadata(&p) {
                    return Some(Source::Whole(PathBuf::from(p), m.len()));
                }
            }
        }
        let partial = self.partials.lock().unwrap().get(file_id).cloned();
        if let Some(pt) = partial {
            if self.in_group_chat(&pt.chat, peer) {
                return Some(Source::Partial(pt));
            }
        }
        let cache = self.caches.lock().unwrap().get(file_id).cloned();
        match cache {
            Some(c) if self.in_group_chat(&c.chat, peer) => Some(Source::Cache(c)),
            _ => None,
        }
    }

    async fn serve_file(&self, peer: &str, file_id: &str, offset: u64, len: Option<u64>, mut send: SendStream) {
        let fail = |e: &str| json!({ "ok": false, "error": e });
        let (path, size) = match self.source_for(peer, file_id) {
            Some(Source::Whole(p, s)) => (p, s),
            Some(Source::Partial(pt)) => {
                let off = offset.min(pt.size);
                let l = len.unwrap_or(u64::MAX).min(pt.size - off);
                if !pt.has_range(off, l) {
                    let _ = write_frame(&mut send, &fail("I don't have that part yet.")).await;
                    let _ = send.finish();
                    return;
                }
                (pt.part.clone(), pt.size)
            }
            Some(Source::Cache(c)) => {
                let off = offset.min(c.file.size);
                let l = len.unwrap_or(u64::MAX).min(c.file.size - off).min(64 * 1024 * 1024);
                let data = if c.has_range(off, l) { c.read_range(off, l).ok() } else { None };
                let Some(data) = data else {
                    let _ = write_frame(&mut send, &fail("I don't have that part yet.")).await;
                    let _ = send.finish();
                    return;
                };
                if write_frame(&mut send, &json!({ "ok": true, "size": c.file.size, "len": data.len() })).await.is_ok() {
                    let _ = send.write_all(&data).await;
                }
                let _ = send.finish();
                return;
            }
            None => {
                let _ = write_frame(&mut send, &fail("You don't have access to this file.")).await;
                let _ = send.finish();
                return;
            }
        };
        let file = match tokio::fs::File::open(&path).await {
            Ok(f) => f,
            Err(_) => {
                let _ = write_frame(&mut send, &fail("The sender moved or deleted this file.")).await;
                let _ = send.finish();
                return;
            }
        };
        let offset = offset.min(size);
        let len = len.unwrap_or(u64::MAX).min(size - offset);
        if write_frame(&mut send, &json!({ "ok": true, "size": size, "len": len })).await.is_err() {
            return;
        }
        let mut file = file;
        if file.seek(SeekFrom::Start(offset)).await.is_err() {
            return;
        }
        let mut left = len;
        let mut buf = vec![0u8; 256 * 1024];
        while left > 0 {
            let want = (buf.len() as u64).min(left) as usize;
            let n = match file.read(&mut buf[..want]).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            if send.write_all(&buf[..n]).await.is_err() {
                return;
            }
            left -= n as u64;
        }
        let _ = send.finish();
    }

    /// Opens a stream of `file` from peer `from`, starting at `offset`.
    async fn open_remote(self: &Arc<Self>, from: &str, file: &FileMeta, offset: u64, len: Option<u64>) -> Result<(u64, RecvStream), ReqError> {
        let id = parse_id(from).map_err(ReqError::Refused)?;
        let conn = self.conn(id).await.map_err(ReqError::Offline)?;
        let open = async {
            let (mut send, mut recv) = conn.open_bi().await.map_err(e2s)?;
            write_frame(&mut send, &Req::FileGet { file_id: file.id.clone(), offset, len }).await?;
            send.finish().map_err(e2s)?;
            let head: Value = read_frame(&mut recv).await?;
            Ok::<_, String>((head, recv))
        };
        match tokio::time::timeout(Duration::from_secs(30), open).await {
            Ok(Ok((head, recv))) => {
                self.mark_seen(from);
                if head["ok"].as_bool() == Some(true) {
                    Ok((head["size"].as_u64().unwrap_or(file.size), recv))
                } else {
                    Err(ReqError::Refused(head["error"].as_str().unwrap_or("Refused.").to_string()))
                }
            }
            Ok(Err(e)) => {
                self.conns.lock().unwrap().remove(&id);
                Err(ReqError::Offline(e))
            }
            Err(_) => Err(ReqError::Offline("timeout".into())),
        }
    }

    fn local_copy(&self, file: &FileMeta) -> Option<PathBuf> {
        let db = self.db.lock().unwrap();
        let p: Option<String> = if file.owner == self.me_s {
            db.query_row("SELECT path FROM shared_files WHERE id = ?1", [&file.id], |r| r.get(0)).optional().ok().flatten()
        } else {
            db.query_row("SELECT path FROM downloads WHERE file_id = ?1", [&file.id], |r| r.get(0)).optional().ok().flatten()
        };
        p.map(PathBuf::from).filter(|p| std::fs::metadata(p).map(|m| m.len() == file.size).unwrap_or(false))
    }

    /// Who might have `file`: a watch-party seeder first, then the sender, then other group members.
    fn sources(&self, file: &FileMeta, chat: &str) -> Vec<String> {
        let mut v: Vec<String> = Vec::new();
        let push = |id: String, v: &mut Vec<String>| {
            if id != self.me_s && !v.contains(&id) {
                v.push(id);
            }
        };
        let party_group = {
            let parties = self.parties.lock().unwrap();
            parties.values().find(|p| p.file.id == file.id).map(|p| (p.seeder.clone(), p.group.clone()))
        };
        if let Some((seeder, _)) = &party_group {
            push(seeder.clone(), &mut v);
        }
        push(file.owner.clone(), &mut v);
        let group = chat.strip_prefix("g:").map(str::to_string).or(party_group.map(|(_, g)| g));
        if let Some(g) = group {
            if let Some(group) = self.load_group(&g) {
                for m in group.members {
                    if self.is_online(&m.id) {
                        push(m.id, &mut v);
                    }
                }
            }
        }
        v
    }

    /// Reads a byte range for the in-app viewer: from disk if we have it, otherwise from whoever has it.
    pub async fn read_range(self: &Arc<Self>, file: &FileMeta, start: u64, len: u64) -> Result<Vec<u8>, String> {
        let len = len.min(file.size.saturating_sub(start));
        let local = self.local_copy(file).or_else(|| {
            self.partials.lock().unwrap().get(&file.id).filter(|p| p.has_range(start, len)).map(|p| p.part.clone())
        });
        let cache = self.caches.lock().unwrap().get(&file.id).cloned();
        if let Some(c) = cache {
            if c.has_range(start, len) {
                if let Ok(v) = c.read_range(start, len) {
                    return Ok(v);
                }
            }
        }
        if let Some(path) = local {
            let mut f = tokio::fs::File::open(&path).await.map_err(e2s)?;
            f.seek(SeekFrom::Start(start)).await.map_err(e2s)?;
            let mut buf = vec![0u8; len as usize];
            f.read_exact(&mut buf).await.map_err(e2s)?;
            return Ok(buf);
        }
        let mut last = "The sender is offline.".to_string();
        for src in self.sources(file, "") {
            match self.open_remote(&src, file, start, Some(len)).await {
                Ok((_, mut recv)) => match recv.read_to_end(len as usize + 16).await {
                    Ok(v) if v.len() as u64 == len => return Ok(v),
                    _ => last = "Connection lost.".into(),
                },
                Err(ReqError::Refused(e)) => last = e,
                Err(ReqError::Offline(_)) => {}
            }
        }
        Err(last)
    }

    // ----- Downloads: 8 MB pieces, several at once, from several people at once -----

    fn save_transfers(&self) {
        let list: Vec<Transfer> = self.transfers.lock().unwrap().iter().filter(|t| t.status != "done").cloned().collect();
        let _ = std::fs::write(self.dir.join("transfers.json"), serde_json::to_vec(&list).unwrap());
    }

    pub fn snapshot(&self) -> Vec<Transfer> {
        let running = self.running.lock().unwrap();
        self.transfers
            .lock()
            .unwrap()
            .iter()
            .map(|t| {
                let mut t = t.clone();
                if let Some(r) = running.get(&t.id) {
                    t.done = r.live.load(Ordering::Relaxed).min(t.size);
                }
                t
            })
            .collect()
    }

    pub fn emit_transfers(&self) {
        let _ = self.app.emit("transfers", self.snapshot());
    }

    fn update(&self, id: &str, f: impl FnOnce(&mut Transfer)) {
        if let Some(t) = self.transfers.lock().unwrap().iter_mut().find(|t| t.id == id) {
            f(t);
        }
    }

    fn get(&self, id: &str) -> Option<Transfer> {
        self.transfers.lock().unwrap().iter().find(|t| t.id == id).cloned()
    }

    fn finish(&self, id: &str, status: &str, error: Option<String>) {
        if let Some(r) = self.running.lock().unwrap().remove(id) {
            let live = r.live.load(Ordering::Relaxed);
            self.update(id, |t| t.done = live.min(t.size));
        }
        self.update(id, |t| {
            t.status = status.to_string();
            t.error = error;
            t.speed = 0.0;
            if status == "done" {
                t.done = t.size;
            }
        });
        self.save_transfers();
        self.emit_transfers();
    }

    pub fn download(self: &Arc<Self>, file: FileMeta, chat: String) -> Result<String, String> {
        if let Some(t) = self.transfers.lock().unwrap().iter().find(|t| t.file.id == file.id && t.status != "error") {
            let id = t.id.clone();
            let paused = t.status == "paused";
            if paused {
                let me = self.clone();
                let id2 = id.clone();
                tauri::async_runtime::spawn(async move { me.start_download(&id2) });
            }
            return Ok(id);
        }
        let dir = dirs::download_dir().or_else(dirs::home_dir).ok_or("Couldn't find your Downloads folder.")?;
        let path = unique_path(&dir, &safe_file_name(&file.name));
        let id = new_id();
        self.transfers.lock().unwrap().push(Transfer {
            id: id.clone(),
            name: path.file_name().and_then(|n| n.to_str()).unwrap_or(&file.name).to_string(),
            size: file.size,
            done: 0,
            status: "paused".into(),
            error: None,
            speed: 0.0,
            path: path.to_string_lossy().into_owned(),
            file,
            chat,
        });
        self.start_download(&id);
        Ok(id)
    }

    pub fn start_download(self: &Arc<Self>, id: &str) {
        let Some(t) = self.get(id) else { return };
        if self.running.lock().unwrap().contains_key(id) || t.status == "done" {
            return;
        }
        let live = Arc::new(AtomicU64::new(t.done));
        let cancel = CancellationToken::new();
        self.running.lock().unwrap().insert(id.to_string(), Running { live: live.clone(), cancel: cancel.clone() });
        self.update(id, |t| {
            t.status = "running".into();
            t.error = None;
        });
        self.save_transfers();
        self.emit_transfers();
        let me = self.clone();
        let id = id.to_string();
        tauri::async_runtime::spawn(async move { me.download_loop(&id, live, cancel).await });
    }

    pub fn resume_downloads(self: &Arc<Self>) {
        let ids: Vec<String> = self.transfers.lock().unwrap().iter().filter(|t| t.status == "paused").map(|t| t.id.clone()).collect();
        for id in ids {
            self.start_download(&id);
        }
    }

    async fn fetch_block(self: &Arc<Self>, from: &str, file: &FileMeta, off: u64, len: u64, live: &AtomicU64, cancel: &CancellationToken) -> Result<Vec<u8>, ReqError> {
        let (_, mut recv) = self.open_remote(from, file, off, Some(len)).await?;
        let mut data: Vec<u8> = Vec::with_capacity(len as usize);
        let mut buf = vec![0u8; 256 * 1024];
        let undo = |n: usize| {
            live.fetch_sub(n as u64, Ordering::Relaxed);
        };
        loop {
            let r = tokio::select! {
                r = recv.read(&mut buf) => r,
                _ = cancel.cancelled() => { undo(data.len()); return Err(ReqError::Offline("cancelled".into())); }
            };
            match r {
                Ok(Some(n)) => {
                    data.extend_from_slice(&buf[..n]);
                    live.fetch_add(n as u64, Ordering::Relaxed);
                }
                Ok(None) => break,
                Err(e) => {
                    undo(data.len());
                    return Err(ReqError::Offline(e2s(e)));
                }
            }
        }
        if data.len() as u64 != len {
            undo(data.len());
            return Err(ReqError::Offline("Connection lost".into()));
        }
        Ok(data)
    }

    async fn write_block(pt: &Arc<Partial>, b: usize, off: u64, data: Vec<u8>) -> Result<(), String> {
        let path = pt.part.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let f = std::fs::OpenOptions::new().write(true).open(&path)?;
            #[cfg(windows)]
            {
                use std::os::windows::fs::FileExt;
                let mut written = 0;
                while written < data.len() {
                    written += f.seek_write(&data[written..], off + written as u64)?;
                }
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::FileExt;
                f.write_all_at(&data, off)?;
            }
            Ok::<_, std::io::Error>(())
        })
        .await
        .map_err(e2s)?
        .map_err(e2s)?;
        pt.mark(b);
        Ok(())
    }

    async fn download_loop(self: Arc<Self>, id: &str, live: Arc<AtomicU64>, cancel: CancellationToken) {
        let Some(t) = self.get(id) else { return };
        let final_path = PathBuf::from(&t.path);
        let part = part_path(&final_path);
        let bits_path = blocks_path(&part);
        let nblocks = t.size.div_ceil(BLOCK) as usize;

        // Reserve the space up front and remember which pieces are done, so we can resume.
        let fresh = std::fs::metadata(&part).map(|m| m.len() != t.size).unwrap_or(true);
        let bits = if fresh {
            let ok = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&part)
                .and_then(|f| f.set_len(t.size));
            if ok.is_err() {
                return self.finish(id, "error", Some("Couldn't reserve space. Is the disk full?".into()));
            }
            vec![0u8; nblocks]
        } else {
            std::fs::read(&bits_path).ok().filter(|b| b.len() == nblocks).unwrap_or_else(|| vec![0u8; nblocks])
        };
        let pt = Arc::new(Partial { part: part.clone(), size: t.size, chat: t.chat.clone(), bits: Mutex::new(bits), bits_path: bits_path.clone() });
        let _ = std::fs::write(&bits_path, &*pt.bits.lock().unwrap());
        self.partials.lock().unwrap().insert(t.file.id.clone(), pt.clone());
        live.store(pt.done_bytes(), Ordering::Relaxed);
        let start_bytes = pt.done_bytes();
        let started = Instant::now();
        let mut fails = 0u32;

        loop {
            if cancel.is_cancelled() {
                return;
            }
            let missing = pt.missing();
            if missing.is_empty() {
                break;
            }
            let sources = Arc::new(self.sources(&t.file, &t.chat));
            let queue = Arc::new(Mutex::new(std::collections::VecDeque::from(missing)));
            let dead: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
            let refused: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            let disk_error = Arc::new(Mutex::new(false));
            let progressed = Arc::new(AtomicU64::new(0));
            let mut workers = Vec::new();
            for w in 0..WORKERS {
                let (me, sources, queue, dead, refused, disk_error, progressed, live, cancel, pt, file, id) = (
                    self.clone(), sources.clone(), queue.clone(), dead.clone(), refused.clone(), disk_error.clone(), progressed.clone(),
                    live.clone(), cancel.clone(), pt.clone(), t.file.clone(), id.to_string(),
                );
                workers.push(tauri::async_runtime::spawn(async move {
                    let n = sources.len();
                    let mut si = w;
                    'blocks: loop {
                        let next = queue.lock().unwrap().pop_front();
                        let Some(b) = next else { break };
                        let off = b as u64 * BLOCK;
                        let len = BLOCK.min(file.size - off);
                        for _ in 0..n {
                            if cancel.is_cancelled() {
                                return;
                            }
                            let src = sources[si % n].clone();
                            si += 1;
                            if dead.lock().unwrap().contains(&src) {
                                continue;
                            }
                            match me.fetch_block(&src, &file, off, len, &live, &cancel).await {
                                Ok(data) => {
                                    if Node::write_block(&pt, b, off, data).await.is_err() {
                                        *disk_error.lock().unwrap() = true;
                                        return;
                                    }
                                    progressed.fetch_add(1, Ordering::Relaxed);
                                    let secs = started.elapsed().as_secs_f64();
                                    if secs > 0.5 {
                                        let rate = (live.load(Ordering::Relaxed).saturating_sub(start_bytes)) as f64 / secs;
                                        me.update(&id, |t| {
                                            t.speed = rate;
                                            t.error = None;
                                        });
                                    }
                                    continue 'blocks;
                                }
                                // Someone who only has part of the file: just try another source for this piece.
                                Err(ReqError::Refused(e)) => {
                                    if src == file.owner {
                                        *refused.lock().unwrap() = Some(e);
                                        dead.lock().unwrap().insert(src);
                                    }
                                }
                                Err(ReqError::Offline(_)) => {
                                    dead.lock().unwrap().insert(src);
                                }
                            }
                        }
                        // Nobody could give us this piece right now.
                        queue.lock().unwrap().push_back(b);
                        break;
                    }
                }));
            }
            for w in workers {
                let _ = w.await;
            }
            if cancel.is_cancelled() {
                return;
            }
            if *disk_error.lock().unwrap() {
                return self.finish(id, "error", Some("Couldn't write the file. Is the disk full?".into()));
            }
            if progressed.load(Ordering::Relaxed) > 0 {
                fails = 0;
                continue;
            }
            let others_alive = sources.iter().any(|s| *s != t.file.owner && !dead.lock().unwrap().contains(s));
            if let Some(e) = refused.lock().unwrap().clone() {
                if !others_alive {
                    self.partials.lock().unwrap().remove(&t.file.id);
                    return self.finish(id, "error", Some(e));
                }
            }
            fails += 1;
            self.update(id, |t| {
                t.error = Some("Nobody who has this file is online, retrying…".into());
                t.speed = 0.0;
            });
            self.emit_transfers();
            let wait = Duration::from_secs((1u64 << fails.min(5)).min(30));
            tokio::select! {
                _ = tokio::time::sleep(wait) => {},
                _ = cancel.cancelled() => return,
            }
        }

        match tokio::fs::rename(&part, &final_path).await {
            Ok(_) => {
                let _ = std::fs::remove_file(&bits_path);
                let _ = self.db.lock().unwrap().execute(
                    "INSERT OR REPLACE INTO downloads (file_id, path, chat) VALUES (?1, ?2, ?3)",
                    [&t.file.id, &t.path, &t.chat],
                );
                self.partials.lock().unwrap().remove(&t.file.id);
                self.finish(id, "done", None)
            }
            Err(_) => self.finish(id, "error", Some("Couldn't save the file.".into())),
        }
    }

    // ----- Connection speed test (for picking the best watch-party host) -----

    async fn serve_probe(&self, peer: &str, bytes: u64, mut send: SendStream) {
        if !self.known_peers().iter().any(|p| p == peer) {
            let _ = write_frame(&mut send, &json!({ "ok": false, "error": "Not allowed." })).await;
            let _ = send.finish();
            return;
        }
        if write_frame(&mut send, &json!({ "ok": true })).await.is_err() {
            return;
        }
        let chunk = vec![0u8; 256 * 1024];
        let mut left = bytes.min(PROBE_BYTES);
        while left > 0 {
            let n = (chunk.len() as u64).min(left) as usize;
            if send.write_all(&chunk[..n]).await.is_err() {
                return;
            }
            left -= n as u64;
        }
        let _ = send.finish();
    }

    /// Measures how fast `peer` can send to us (their upload, as seen from here), in bytes per second.
    pub async fn measure_upload(self: &Arc<Self>, peer: &str) -> Option<f64> {
        let id = parse_id(peer).ok()?;
        let conn = self.conn(id).await.ok()?;
        let run = async {
            let (mut send, mut recv) = conn.open_bi().await.ok()?;
            write_frame(&mut send, &Req::Probe { bytes: PROBE_BYTES }).await.ok()?;
            send.finish().ok()?;
            let head: Value = read_frame(&mut recv).await.ok()?;
            if head["ok"].as_bool() != Some(true) {
                return None;
            }
            let t0 = Instant::now();
            let mut got = 0u64;
            let mut buf = vec![0u8; 256 * 1024];
            while let Ok(Some(n)) = recv.read(&mut buf).await {
                got += n as u64;
            }
            Some(got as f64 / t0.elapsed().as_secs_f64().max(0.01))
        };
        tokio::time::timeout(Duration::from_secs(25), run).await.ok().flatten()
    }

    /// Speeds for a watch party: each member's upload to us, and ours measured by one of them.
    pub async fn probe_members(self: &Arc<Self>, members: Vec<String>) -> Value {
        let mut handles = Vec::new();
        for m in members.iter().filter(|m| **m != self.me_s).cloned() {
            let me = self.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                let r = me.measure_upload(&m).await;
                (m, r)
            }));
        }
        let mut out = serde_json::Map::new();
        let mut helper: Option<String> = None;
        for h in handles {
            if let Ok((m, r)) = h.await {
                if r.is_some() && helper.is_none() {
                    helper = Some(m.clone());
                }
                out.insert(m, json!(r));
            }
        }
        let mine = match helper {
            Some(h) => self.request(&h, &Req::ProbeMe).await.ok().and_then(|v| v["rate"].as_f64()),
            None => None,
        };
        out.insert(self.me_s.clone(), json!(mine));
        Value::Object(out)
    }

    // ----- Watch together -----

    pub fn parties(&self) -> Vec<Party> {
        self.parties.lock().unwrap().values().cloned().collect()
    }

    fn broadcast_party(self: &Arc<Self>, party: &Party) {
        let _ = self.app.emit("party", party);
        let req = Req::Party { party: party.clone() };
        for m in party.members.iter().filter(|m| m.id != self.me_s && !m.left) {
            let me = self.clone();
            let req = req.clone();
            let to = m.id.clone();
            tauri::async_runtime::spawn(async move {
                let _ = me.request(&to, &req).await;
            });
        }
    }

    // ----- Streaming for watch together (no download, no Downloads folder) -----

    /// (bytes buffered ahead of the playhead, ready to play without stutter)
    fn buffer_state(&self, file: &FileMeta) -> (u64, bool) {
        if file.owner == self.me_s || self.local_copy(file).is_some() {
            return (file.size, true);
        }
        if let Some(c) = self.caches.lock().unwrap().get(&file.id).cloned() {
            return (c.ahead(), c.ready());
        }
        if let Some(p) = self.partials.lock().unwrap().get(&file.id).cloned() {
            let done = p.done_bytes();
            return (done, done >= file.size);
        }
        (0, false)
    }

    pub fn start_stream(self: &Arc<Self>, file: FileMeta, chat: String) -> Result<(), String> {
        if file.owner == self.me_s || self.local_copy(&file).is_some() || self.caches.lock().unwrap().contains_key(&file.id) {
            return Ok(());
        }
        let dir = self.dir.join("cache").join(&file.id);
        std::fs::create_dir_all(&dir).map_err(e2s)?;
        // Pieces left over from an earlier session can be reused.
        let mut have = HashSet::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if let Some(b) = name.strip_suffix(".bin").and_then(|n| n.parse::<u64>().ok()) {
                    let expect = BLOCK.min(file.size.saturating_sub(b * BLOCK));
                    if e.metadata().map(|m| m.len() == expect).unwrap_or(false) {
                        have.insert(b);
                    }
                }
            }
        }
        let cache = Arc::new(StreamCache { file: file.clone(), chat, dir, have: Mutex::new(have), focus: AtomicU64::new(0), cancel: CancellationToken::new() });
        self.caches.lock().unwrap().insert(file.id.clone(), cache.clone());
        tauri::async_runtime::spawn(self.clone().stream_loop(cache));
        Ok(())
    }

    pub fn stop_stream(&self, file_id: &str) {
        if let Some(c) = self.caches.lock().unwrap().remove(file_id) {
            c.cancel.cancel();
            let dir = c.dir.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let _ = tokio::fs::remove_dir_all(dir).await;
            });
        }
    }

    /// The player tells us where it is, so we fetch what comes next first.
    pub fn stream_focus(&self, file_id: &str, position: u64) {
        if let Some(c) = self.caches.lock().unwrap().get(file_id) {
            c.focus.store(position.min(c.file.size), Ordering::Relaxed);
        }
    }

    async fn stream_loop(self: Arc<Self>, c: Arc<StreamCache>) {
        let dummy = AtomicU64::new(0);
        let mut idle_rounds = 0u32;
        while !c.cancel.is_cancelled() {
            let nblocks = c.nblocks();
            let fb = c.focus.load(Ordering::Relaxed) / BLOCK;
            // Forget pieces far from the playhead so the cache stays small.
            {
                let mut have = c.have.lock().unwrap();
                if have.len() > STREAM_MAX_BLOCKS {
                    let keep_from = fb.saturating_sub(STREAM_BEHIND_BLOCKS);
                    let keep_to = fb + STREAM_AHEAD_BLOCKS;
                    let drop: Vec<u64> = have.iter().copied().filter(|b| *b < keep_from || *b >= keep_to).collect();
                    for b in drop {
                        have.remove(&b);
                        let _ = std::fs::remove_file(c.block_path(b));
                    }
                }
            }
            let wanted: Vec<u64> = {
                let have = c.have.lock().unwrap();
                (fb..(fb + STREAM_AHEAD_BLOCKS).min(nblocks)).filter(|b| !have.contains(b)).take(STREAM_WORKERS).collect()
            };
            if wanted.is_empty() {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(400)) => {},
                    _ = c.cancel.cancelled() => break,
                }
                continue;
            }
            let sources = self.sources(&c.file, &c.chat);
            if sources.is_empty() {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            let jobs = wanted.iter().enumerate().map(|(i, b)| {
                let (me, c, sources, dummy) = (self.clone(), c.clone(), &sources, &dummy);
                let b = *b;
                async move {
                    let off = b * BLOCK;
                    let len = BLOCK.min(c.file.size - off);
                    for k in 0..sources.len() {
                        let src = &sources[(i + k) % sources.len()];
                        if let Ok(data) = me.fetch_block(src, &c.file, off, len, dummy, &c.cancel).await {
                            if tokio::fs::write(c.block_path(b), &data).await.is_ok() {
                                c.have.lock().unwrap().insert(b);
                                return true;
                            }
                        }
                    }
                    false
                }
            });
            let results = futures_util::future::join_all(jobs).await;
            if results.iter().any(|ok| *ok) {
                idle_rounds = 0;
            } else {
                idle_rounds += 1;
                let wait = Duration::from_secs((idle_rounds as u64).min(10));
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {},
                    _ = c.cancel.cancelled() => break,
                }
            }
        }
    }

    pub fn set_buffering(self: &Arc<Self>, party_id: &str, buffering: bool) {
        let changed = {
            let mut b = self.buffering.lock().unwrap();
            if buffering { b.insert(party_id.to_string()) } else { b.remove(party_id) }
        };
        if changed {
            self.party_report(party_id, None, false);
        }
    }

    pub fn create_party(self: &Arc<Self>, group: &str, file: FileMeta, invite: Vec<String>, seeder: String) -> Result<String, String> {
        let g = self.load_group(group).ok_or("That group no longer exists.")?;
        let (have, ready) = self.buffer_state(&file);
        let mut members = vec![PartyMember { id: self.me_s.clone(), name: self.my_name(), have, joined: true, left: false, ready, buffering: false }];
        for id in invite {
            if let Some(m) = g.members.iter().find(|m| m.id == id && m.id != self.me_s) {
                members.push(PartyMember { id: m.id.clone(), name: m.name.clone(), have: 0, joined: false, left: false, ready: false, buffering: false });
            }
        }
        if members.len() < 2 {
            return Err("Invite at least one person.".into());
        }
        let seeder = if members.iter().any(|m| m.id == seeder) { seeder } else { file.owner.clone() };
        let party = Party {
            id: new_id(),
            group: group.to_string(),
            file,
            leader: self.me_s.clone(),
            seeder,
            members,
            state: "loading".into(),
            position: 0.0,
            version: 1,
        };
        self.parties.lock().unwrap().insert(party.id.clone(), party.clone());
        self.broadcast_party(&party);
        self.join_party(&party.id)?;
        Ok(party.id)
    }

    pub fn join_party(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let party = self.parties.lock().unwrap().get(id).cloned().ok_or("That watch party has ended.")?;
        // Stream it: pieces around the playhead are fetched ahead of time (no download needed).
        self.start_stream(party.file.clone(), format!("g:{}", party.group))?;
        self.party_report(id, Some(true), false);
        let me = self.clone();
        let id = id.to_string();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let still = me.parties.lock().unwrap().get(&id).map(|p| p.members.iter().any(|m| m.id == me.me_s && m.joined && !m.left));
                if still != Some(true) {
                    break;
                }
                me.party_report(&id, None, false);
            }
        });
        Ok(())
    }

    /// Leave a watch party. If the host leaves without ending it, someone else becomes the host and the others keep watching.
    pub fn leave_party(self: &Arc<Self>, id: &str, end: bool) {
        let leader = self.parties.lock().unwrap().get(id).map(|p| p.leader.clone());
        if let Some(fid) = self.parties.lock().unwrap().get(id).map(|p| p.file.id.clone()) {
            self.stop_stream(&fid);
        }
        self.buffering.lock().unwrap().remove(id);
        if leader.as_deref() == Some(self.me_s.as_str()) {
            let ended = {
                let mut parties = self.parties.lock().unwrap();
                parties.remove(id).map(|mut p| {
                    let next = p.members.iter().find(|m| m.id != self.me_s && m.joined && !m.left).map(|m| m.id.clone());
                    match next {
                        Some(n) if !end => {
                            p.leader = n.clone();
                            if p.seeder == self.me_s {
                                p.seeder = n;
                            }
                            if let Some(me) = p.members.iter_mut().find(|m| m.id == self.me_s) {
                                me.left = true;
                            }
                        }
                        _ => p.state = "ended".into(),
                    }
                    p.version += 1;
                    p
                })
            };
            if ended.as_ref().map(|p| p.state != "ended").unwrap_or(false) {
                let _ = self.app.emit("party", json!({ "id": id, "state": "ended" }));
            }
            if let Some(p) = ended {
                self.broadcast_party(&p);
            }
        } else {
            self.party_report(id, Some(false), true);
            self.parties.lock().unwrap().remove(id);
            let _ = self.app.emit("party", json!({ "id": id, "state": "ended" }));
        }
    }

    /// Tells the leader how much of the film we have (the leader just updates itself).
    fn party_report(self: &Arc<Self>, id: &str, joined: Option<bool>, left: bool) {
        let Some(party) = self.parties.lock().unwrap().get(id).cloned() else { return };
        let (have, ready) = self.buffer_state(&party.file);
        let buffering = self.buffering.lock().unwrap().contains(id);
        let joined = joined.unwrap_or(true);
        if party.leader == self.me_s {
            self.apply_report(id, &self.me_s.clone(), have, joined, left, ready, buffering);
        } else {
            let me = self.clone();
            let req = Req::PartyReport { party_id: id.to_string(), have, joined, left, ready, buffering };
            tauri::async_runtime::spawn(async move {
                let _ = me.request(&party.leader, &req).await;
            });
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_report(self: &Arc<Self>, id: &str, who: &str, have: u64, joined: bool, left: bool, ready: bool, buffering: bool) {
        let updated = {
            let mut parties = self.parties.lock().unwrap();
            let Some(p) = parties.get_mut(id) else { return };
            let Some(m) = p.members.iter_mut().find(|m| m.id == who) else { return };
            if m.have == have && m.joined == joined && m.left == left && m.ready == ready && m.buffering == buffering {
                return;
            }
            m.have = have.min(p.file.size);
            m.joined = joined;
            m.left = left;
            m.ready = ready;
            m.buffering = buffering;
            p.version += 1;
            p.clone()
        };
        self.broadcast_party(&updated);
    }

    pub fn control_party(self: &Arc<Self>, id: &str, state: &str, position: f64) -> Result<(), String> {
        let party = self.parties.lock().unwrap().get(id).cloned().ok_or("That watch party has ended.")?;
        if !matches!(state, "playing" | "paused") {
            return Err("Unknown action.".into());
        }
        if party.leader == self.me_s {
            self.apply_control(id, state, position);
        } else {
            let me = self.clone();
            let req = Req::PartyControl { party_id: id.to_string(), state: state.to_string(), position };
            tauri::async_runtime::spawn(async move {
                let _ = me.request(&party.leader, &req).await;
            });
        }
        Ok(())
    }

    fn apply_control(self: &Arc<Self>, id: &str, state: &str, position: f64) {
        let updated = {
            let mut parties = self.parties.lock().unwrap();
            let Some(p) = parties.get_mut(id) else { return };
            p.state = state.to_string();
            p.position = position.max(0.0);
            p.version += 1;
            p.clone()
        };
        self.broadcast_party(&updated);
    }

    // ----- Search -----

    pub fn search(&self, q: &str, kind: &str, from: &str, chat: &str, since: i64) -> Vec<Value> {
        use rusqlite::types::Value as Sql;
        let mut sql = String::from(
            "SELECT id, chat, sender, sender_name, text, file, ts FROM messages WHERE 1 = 1",
        );
        let mut args: Vec<Sql> = Vec::new();
        let q = q.trim();
        if !q.is_empty() {
            let pat = format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
            sql += " AND (text LIKE ?1 ESCAPE '\\' OR json_extract(file, '$.name') LIKE ?1 ESCAPE '\\' OR sender_name LIKE ?1 ESCAPE '\\')";
            args.push(Sql::Text(pat));
        }
        let name = "lower(json_extract(file, '$.name'))";
        let mime = "json_extract(file, '$.mime')";
        let cond = match kind {
            "text" => "file IS NULL".to_string(),
            "files" => "file IS NOT NULL".to_string(),
            "image" => format!("{mime} LIKE 'image/%'"),
            "video" => format!("{mime} LIKE 'video/%'"),
            "audio" => format!("{mime} LIKE 'audio/%'"),
            "document" => format!(
                "({mime} IN ('application/pdf', 'text/plain') OR {name} GLOB '*.doc' OR {name} GLOB '*.docx' OR {name} GLOB '*.xls' OR {name} GLOB '*.xlsx' OR {name} GLOB '*.ppt' OR {name} GLOB '*.pptx' OR {name} GLOB '*.odt' OR {name} GLOB '*.rtf' OR {name} GLOB '*.csv' OR {name} GLOB '*.md' OR {name} GLOB '*.txt')"
            ),
            "archive" => format!("({name} GLOB '*.zip' OR {name} GLOB '*.rar' OR {name} GLOB '*.7z' OR {name} GLOB '*.tar' OR {name} GLOB '*.gz' OR {name} GLOB '*.iso')"),
            _ => String::new(),
        };
        if !cond.is_empty() {
            sql += &format!(" AND {cond}");
        }
        if !from.is_empty() {
            args.push(Sql::Text(from.to_string()));
            sql += &format!(" AND sender = ?{}", args.len());
        }
        if !chat.is_empty() {
            args.push(Sql::Text(chat.to_string()));
            sql += &format!(" AND chat = ?{}", args.len());
        }
        if since > 0 {
            args.push(Sql::Integer(since));
            sql += &format!(" AND ts >= ?{}", args.len());
        }
        sql += " ORDER BY ts DESC LIMIT 300";
        let db = self.db.lock().unwrap();
        let Ok(mut stmt) = db.prepare(&sql) else { return vec![] };
        let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| {
            let sender: String = r.get(2)?;
            let file: Option<String> = r.get(5)?;
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "chat": r.get::<_, String>(1)?,
                "sender": sender,
                "senderName": r.get::<_, String>(3)?,
                "text": r.get::<_, Option<String>>(4)?,
                "file": file.and_then(|f| serde_json::from_str::<Value>(&f).ok()),
                "ts": r.get::<_, i64>(6)?,
                "mine": sender == self.me_s,
            }))
        });
        match rows {
            Ok(r) => r.filter_map(Result::ok).collect(),
            Err(_) => vec![],
        }
    }

    pub async fn transfer_action(self: &Arc<Self>, id: &str, action: &str) -> Result<(), String> {
        let t = self.get(id).ok_or("That download is gone.")?;
        match action {
            "pause" => {
                if let Some(r) = self.running.lock().unwrap().remove(id) {
                    r.cancel.cancel();
                    let live = r.live.load(Ordering::Relaxed);
                    self.update(id, |t| t.done = live.min(t.size));
                }
                self.update(id, |t| {
                    t.status = "paused".into();
                    t.speed = 0.0;
                });
                self.save_transfers();
                self.emit_transfers();
            }
            "resume" => self.start_download(id),
            "cancel" | "dismiss" => {
                if let Some(r) = self.running.lock().unwrap().remove(id) {
                    r.cancel.cancel();
                }
                if t.status != "done" {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    let part = part_path(Path::new(&t.path));
                    let _ = tokio::fs::remove_file(blocks_path(&part)).await;
                    let _ = tokio::fs::remove_file(&part).await;
                    self.partials.lock().unwrap().remove(&t.file.id);
                }
                self.transfers.lock().unwrap().retain(|x| x.id != id);
                self.save_transfers();
                self.emit_transfers();
            }
            "open" | "reveal" => open_in_system(&t.path, action == "reveal")?,
            _ => return Err("Unknown action.".into()),
        }
        Ok(())
    }


}

// ---------- In-app viewer (images, video with seeking) ----------

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The type label the built-in player sees. Players are picky about labels, not just contents:
/// UAN_MKV_MIME lets the automatic tests try other labels for .mkv files.
fn player_mime(mime: &str) -> String {
    if mime == "video/x-matroska" {
        if let Ok(m) = std::env::var("UAN_MKV_MIME") {
            return m;
        }
    }
    mime.to_string()
}

/// Shared by both ways of serving the in-app player. Path: <owner>/<file id>/<size>/<mime>
/// Returns (status, headers, body).
async fn media_core(node: &Arc<Node>, path: &str, range: Option<&str>) -> (u16, Vec<(&'static str, String)>, Vec<u8>) {
    let cors = vec![("Access-Control-Allow-Origin", "*".to_string()), ("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges".to_string())];
    let parts: Vec<String> = path.trim_start_matches('/').split('/').map(pct_decode).collect();
    if parts.len() < 4 {
        return (400, cors, Vec::new());
    }
    let Ok(size) = parts[2].parse::<u64>() else { return (400, cors, Vec::new()) };
    let file = FileMeta { owner: parts[0].clone(), id: parts[1].clone(), size, mime: parts[3].clone(), name: String::new() };
    let mut headers = cors;
    headers.push(("Content-Type", player_mime(&file.mime)));
    headers.push(("Accept-Ranges", "bytes".to_string()));
    if size == 0 {
        return (200, headers, Vec::new());
    }
    let range = range
        .and_then(|r| r.trim().strip_prefix("bytes="))
        .and_then(|r| r.split_once('-'))
        .map(|(a, b)| (a.parse::<u64>().unwrap_or(0), b.parse::<u64>().ok()));
    let (start, end, partial) = match range {
        Some((s, e)) => {
            let s = s.min(size - 1);
            let e = e.unwrap_or(size - 1).min(size - 1).min(s + MEDIA_CHUNK - 1);
            (s, e, true)
        }
        None if size <= MEDIA_WHOLE_LIMIT => (0, size - 1, false),
        None => (0, MEDIA_CHUNK - 1, true),
    };
    match node.read_range(&file, start, end - start + 1).await {
        Ok(bytes) => {
            if partial {
                headers.push(("Content-Range", format!("bytes {}-{}/{}", start, start + bytes.len() as u64 - 1, size)));
            }
            (if partial { 206 } else { 200 }, headers, bytes)
        }
        Err(_) => (503, headers, Vec::new()),
    }
}

/// URL: media://localhost/<owner>/<file id>/<size>/<mime>  (Windows)
pub async fn media(node: Arc<Node>, req: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let range = req.headers().get(tauri::http::header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let (status, headers, body) = media_core(&node, req.uri().path(), range.as_deref()).await;
    let mut r = tauri::http::Response::builder().status(status);
    for (k, v) in headers {
        r = r.header(k, v);
    }
    r.body(body).unwrap_or_default()
}

/// A tiny HTTP server on 127.0.0.1 for the player. Linux's WebKitGTK can't stream video from custom
/// schemes, so there the player uses http://127.0.0.1:<port>/<secret>/<owner>/<id>/<size>/<mime>.
pub async fn start_media_server(node: Arc<Node>) -> Result<String, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(e2s)?;
    let port = listener.local_addr().map_err(e2s)?.port();
    let secret = new_id();
    let base = format!("http://127.0.0.1:{port}/{secret}");
    tauri::async_runtime::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else { continue };
            let (node, secret) = (node.clone(), secret.clone());
            tauri::async_runtime::spawn(async move {
                let _ = serve_media_http(node, sock, &secret).await;
            });
        }
    });
    Ok(base)
}

async fn serve_media_http(node: Arc<Node>, mut sock: tokio::net::TcpStream, secret: &str) -> std::io::Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (r, mut w) = sock.split();
    let mut reader = BufReader::new(r);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await? == 0 {
            return Ok(());
        }
        let mut it = line.split_whitespace();
        let method = it.next().unwrap_or("").to_string();
        let target = it.next().unwrap_or("").to_string();
        let mut range: Option<String> = None;
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h).await? == 0 {
                return Ok(());
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                if k.trim().eq_ignore_ascii_case("range") {
                    range = Some(v.trim().to_string());
                }
            }
        }
        let path = target.split('?').next().unwrap_or("");
        let (status, headers, body) = match path.strip_prefix(&format!("/{secret}/")) {
            Some(rest) if method == "GET" || method == "HEAD" => media_core(&node, rest, range.as_deref()).await,
            Some(_) if method == "OPTIONS" => (204, vec![("Access-Control-Allow-Origin", "*".to_string()), ("Access-Control-Allow-Headers", "Range".to_string())], Vec::new()),
            _ => (403, Vec::new(), Vec::new()),
        };
        let mut head = format!("HTTP/1.1 {status} {}\r\n", if status < 300 { "OK" } else { "Error" });
        for (k, v) in &headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str(&format!("Content-Length: {}\r\nConnection: keep-alive\r\n\r\n", body.len()));
        w.write_all(head.as_bytes()).await?;
        if method != "HEAD" {
            w.write_all(&body).await?;
        }
        w.flush().await?;
    }
}
