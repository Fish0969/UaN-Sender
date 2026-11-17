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
/// The About picture travels in one message of its own, so it must stay under the frame size.
const BIOIMG_MAX: usize = 950_000;
/// Version of the peer-to-peer protocol. 2: History, GroupInvite, Typing, Seen. Those are only sent to
/// peers known to understand them (older versions drop the connection on unknown requests).
const PROTO: u32 = 3;
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
/// Files up to this size also travel through the mailbox when the friend is offline.
const BLOB_MAX: u64 = 24 * 1024 * 1024;
pub const DEFAULT_MAILBOX: &str = "https://uan-mailbox.uan-mailbox.workers.dev";
const WORKERS: usize = 6; // pieces fetched at the same time
const PROBE_BYTES: u64 = 8 * 1024 * 1024; // speed test size

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices (dev TEXT PRIMARY KEY, acct TEXT NOT NULL, cert TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', added INTEGER NOT NULL DEFAULT 0);
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
CREATE TABLE IF NOT EXISTS thumbs (file_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT '', avatar TEXT, pv INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY, peer TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pins (chat TEXT NOT NULL, msg_id TEXT NOT NULL, by TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (chat, msg_id));
CREATE TABLE IF NOT EXISTS reactions (chat TEXT NOT NULL, msg_id TEXT NOT NULL, by TEXT NOT NULL, emoji TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (msg_id, by));
CREATE TABLE IF NOT EXISTS reads (chat TEXT NOT NULL, who TEXT NOT NULL, msg_id TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (chat, who));
";

// ---------- Wire format ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileMeta {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub owner: String,
    /// The device that has the file, when it is not the owner's PC (e.g. their phone).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev: Option<String>,
}

/// One more device of an account (a phone signed in to a PC's account), with the account's signature.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DevCert {
    pub id: String,
    pub cert: String,
    #[serde(default)]
    pub name: String,
}

fn verify_dev(acct: &str, dev: &str, cert: &str) -> bool {
    let (Ok(pk), Ok(bytes)) = (parse_id(acct), HEXLOWER.decode(cert.as_bytes())) else { return false };
    let Ok(arr) = <[u8; 64]>::try_from(bytes) else { return false };
    pk.verify(format!("uan-dev:{dev}").as_bytes(), &iroh::Signature::from_bytes(&arr)).is_ok()
}

/// The key a pairing code stands for (both the PC and the phone can make it from the code).
fn link_key(code: &str) -> SecretKey {
    let norm: String = code.to_uppercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let h: [u8; 32] = Sha256::digest(format!("uan-link-v1:{norm}").as_bytes()).into();
    SecretKey::from_bytes(&h)
}

fn sign_with(key: &SecretKey, msg: &str) -> String {
    HEXLOWER.encode(&key.sign(msg.as_bytes()).to_bytes())
}

/// A phone being signed in to this PC's account.
struct LinkSession {
    key: SecretKey,
    expires: i64,
    dev: Option<String>,
    snapshot: Option<Vec<u8>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Member {
    pub id: String,
    pub name: String,
}

/// An earlier group message, sent to someone who was just added to the group.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HistMsg {
    pub id: String,
    pub sender: String,
    pub name: String,
    pub text: Option<String>,
    pub file: Option<FileMeta>,
    pub ts: i64,
    #[serde(default)]
    pub thumb: Option<String>,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub sealed: Option<String>,
    #[serde(default)]
    pub reply: Option<ReplyRef>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WireGroup {
    pub id: String,
    pub name: String,
    pub owner: String,
    pub version: i64,
    pub members: Vec<Member>,
    /// Extra channels besides the main one ("general"). Older versions don't know them.
    #[serde(default)]
    pub channels: Vec<Channel>,
    /// Co-owners: can do what the owner does, except deleting the group and naming co-owners.
    #[serde(default)]
    pub admins: Vec<String>,
    /// The group's picture (a small data: URL).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
}

impl WireGroup {
    /// The owner or a co-owner.
    fn manager(&self, who: &str) -> bool {
        self.owner == who || self.admins.iter().any(|a| a == who)
    }
}

/// A channel in a group. `check` is set for password-locked channels: their messages are encrypted
/// with a key made from the password, so only people who know it can read them.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Channel {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub check: Option<String>,
}

/// "g:<group>" -> (group, None); "g:<group>#<channel>" -> (group, Some(channel)).
pub fn split_chat(chat: &str) -> Option<(&str, Option<&str>)> {
    let g = chat.strip_prefix("g:")?;
    Some(match g.split_once('#') {
        Some((g, c)) => (g, Some(c)),
        None => (g, None),
    })
}

fn chat_id(group: &str, channel: Option<&str>) -> String {
    match channel {
        Some(c) => format!("g:{group}#{c}"),
        None => format!("g:{group}"),
    }
}

/// The key of a locked channel, made from its password (slow on purpose, against guessing).
fn channel_key(group: &str, channel: &str, password: &str) -> [u8; 32] {
    let mut h: [u8; 32] = Sha256::digest(format!("uan-channel:{group}#{channel}:{password}").as_bytes()).into();
    for _ in 0..100_000 {
        h = Sha256::digest(h).into();
    }
    h
}

fn key_check(key: &[u8; 32]) -> String {
    let mut d = Sha256::new();
    d.update(b"uan-check:");
    d.update(key);
    HEXLOWER.encode(&d.finalize()[..12])
}

fn channel_box(key: &[u8; 32]) -> SalsaBox {
    let sk = crypto_box::SecretKey::from(*key);
    SalsaBox::new(&sk.public_key(), &sk)
}

fn seal_with(key: &[u8; 32], plain: &[u8]) -> Result<String, String> {
    let nonce = SalsaBox::generate_nonce(&mut OsRng);
    let ct = channel_box(key).encrypt(&nonce, plain).map_err(|_| "Encryption failed.".to_string())?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(BASE64.encode(&out))
}

fn open_with(key: &[u8; 32], sealed: &str) -> Option<Vec<u8>> {
    let raw = BASE64.decode(sealed.as_bytes()).ok()?;
    if raw.len() < 24 {
        return None;
    }
    channel_box(key).decrypt(crypto_box::Nonce::from_slice(&raw[..24]), &raw[24..]).ok()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WireMsg {
    pub id: String,
    pub group: Option<String>,
    pub name: String,
    pub text: Option<String>,
    pub file: Option<FileMeta>,
    pub ts: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// Locked channels: text and file, encrypted with the channel's key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sealed: Option<String>,
    /// The message this one answers (in locked channels it is inside `sealed`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<ReplyRef>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ReplyRef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub text: String,
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
        /// What the sender's UaN understands (see PROTO). Older versions send nothing (0).
        #[serde(default)]
        proto: u32,
        /// online | away | dnd
        #[serde(default)]
        mode: String,
        /// What the sender is watching together right now ({"film", "with"} as JSON, or empty).
        #[serde(default)]
        watching: String,
        /// The sender's other devices (a phone signed in to the same account).
        #[serde(default)]
        devs: Vec<DevCert>,
    },
    Profile,
    /// The picture or GIF in someone's About (asked for on its own: it can be up to ~1 MB).
    BioImage,
    /// Sent by a device that isn't the account's PC: who it is, with the account's signature.
    Dev { acct: String, cert: String, req: Box<Req> },
    /// Between your own devices: something that happened on the other one (`from` is who did it).
    Mirror {
        from: String,
        #[serde(default)]
        chat: String,
        req: Box<Req>,
    },
    /// Your friend's devices changed (they signed in on a phone).
    Devices { devs: Vec<DevCert> },
    /// Between your own devices: your name, status and picture.
    MyProfile {
        name: String,
        #[serde(default)]
        status: String,
        #[serde(default)]
        avatar: Option<String>,
        #[serde(default)]
        bio: Option<String>,
        #[serde(default)]
        banner: Option<String>,
        #[serde(default)]
        look: Option<String>,
        pv: i64,
    },
    /// A phone asks the PC for a copy of the account (with proof that it knows the pairing code).
    LinkGet {
        proof: String,
        #[serde(default)]
        name: String,
        part: u32,
    },
    FriendRequest { name: String },
    FriendAccept { name: String },
    FriendRemove,
    Msg { msg: WireMsg },
    Group { group: WireGroup },
    GroupLeave { group_id: String },
    /// The sender deleted one of their messages for everyone.
    Unsend { msg_id: String },
    /// Earlier messages of a group for a newly added member (from the group's creator).
    History { group_id: String, msgs: Vec<HistMsg> },
    /// A member asks the group's creator to add people.
    GroupInvite { group_id: String, members: Vec<Member> },
    /// The group's creator cleared the group's messages for everyone (those sent until `before`).
    ClearGroup {
        group_id: String,
        before: i64,
        #[serde(default)]
        channel: Option<String>,
    },
    /// The sender changed one of their messages.
    Edit {
        msg_id: String,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        sealed: Option<String>,
    },
    /// Someone pinned (or unpinned) a message in a chat you share.
    Pin {
        #[serde(default)]
        group: Option<String>,
        #[serde(default)]
        channel: Option<String>,
        msg_id: String,
        pinned: bool,
    },
    /// Someone reacted to a message with an emoji (an empty emoji takes their reaction back).
    React {
        #[serde(default)]
        group: Option<String>,
        #[serde(default)]
        channel: Option<String>,
        msg_id: String,
        emoji: String,
    },
    /// A member asks the watch party's host to add a film to the playlist.
    PartyQueue { party_id: String, file: FileMeta },
    /// A member asks the group's creator to add a channel.
    ChannelAdd { group_id: String, channel: Channel },
    /// The group's owner or a co-owner deleted someone's message for everyone.
    ModDelete { group_id: String, msg_id: String },
    /// "… is typing" (never stored; only sent while both are online).
    Typing {
        #[serde(default)]
        group: Option<String>,
        #[serde(default)]
        channel: Option<String>,
    },
    /// The sender has seen the chat up to this message.
    Seen {
        #[serde(default)]
        group: Option<String>,
        #[serde(default)]
        channel: Option<String>,
        msg_id: String,
    },
    /// A small preview picture for a photo or video someone sent.
    Thumb { file_id: String, data: String },
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
        /// Downloads the whole film before watching (instead of streaming around the playhead).
        #[serde(default)]
        full: bool,
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
    #[serde(default)]
    pub full: bool,
    /// (host only) the invitation reached one of their devices
    #[serde(default)]
    pub reached: bool,
    /// (host only) why the invitation hasn't reached them yet
    #[serde(default)]
    pub note: String,
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
    /// Films to play next, in order (the host plays the next one when a film ends).
    #[serde(default)]
    pub queue: Vec<FileMeta>,
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
        "weba" => "audio/webm",
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
    /// This device's network id.
    me: EndpointId,
    /// The account id: who you are to your friends (on a PC, the same as its network id).
    me_s: String,
    /// This device's network id as text (mailbox address).
    dev_s: String,
    /// The account's key (a phone signed in to a PC has a copy; its own network key is `secret`).
    acct_secret: SecretKey,
    /// The account's signature for this device (only on a phone signed in to a PC).
    cert: Option<String>,
    /// Device -> account, for the devices we know.
    devmap: Mutex<HashMap<String, String>>,
    /// When we last heard from each device.
    dev_seen: Mutex<HashMap<String, Instant>>,
    link: Mutex<Option<LinkSession>>,
    db: Mutex<rusqlite::Connection>,
    conns: Mutex<HashMap<EndpointId, Connection>>,
    seen: Mutex<HashMap<String, Instant>>,
    flushing: Mutex<HashSet<String>>,
    /// Each peer's presence mode (online | away | dnd).
    modes: Mutex<HashMap<String, String>>,
    /// What each peer is watching together right now (JSON), and what we last told them about ourselves.
    watching: Mutex<HashMap<String, String>>,
    watching_told: Mutex<String>,
    /// Protocol version of each peer, learned from pings.
    protos: Mutex<HashMap<String, u32>>,
    /// The last "seen" mark each peer got from us, per chat (so it is sent once, and again after they were offline).
    reads_sent: Mutex<HashMap<(String, String), String>>,
    transfers: Mutex<Vec<Transfer>>,
    running: Mutex<HashMap<String, Running>>,
    partials: Mutex<HashMap<String, Arc<Partial>>>,
    parties: Mutex<HashMap<String, Party>>,
    caches: Mutex<HashMap<String, Arc<StreamCache>>>,
    buffering: Mutex<HashSet<String>>,
    /// Watch parties where we download the whole film first.
    full_parties: Mutex<HashSet<String>>,
    // Speed tests requested by peers run on a separate task (keeps the async call graph acyclic).
    probe_tx: tokio::sync::mpsc::UnboundedSender<(String, tokio::sync::oneshot::Sender<Option<f64>>)>,
    secret: SecretKey,
    http: reqwest::Client,
    mailbox: Mutex<String>,
}

impl Node {
    pub async fn start(app: AppHandle, dir: PathBuf) -> Result<Arc<Node>, String> {
        std::fs::create_dir_all(&dir).map_err(e2s)?;
        // A restored backup waits next to the live files until the next start.
        if dir.join("identity.key.import").exists() && dir.join("uan.db.import").exists() {
            for f in ["uan.db-wal", "uan.db-shm"] {
                let _ = std::fs::remove_file(dir.join(f));
            }
            let _ = std::fs::rename(dir.join("uan.db.import"), dir.join("uan.db"));
            let _ = std::fs::rename(dir.join("identity.key.import"), dir.join("identity.key"));
        }
        // A phone that was just signed in to a PC's account: the account and its copy of the data.
        if dir.join("account.key.import").exists() && dir.join("uan.db.import").exists() {
            for f in ["uan.db-wal", "uan.db-shm"] {
                let _ = std::fs::remove_file(dir.join(f));
            }
            let _ = std::fs::rename(dir.join("uan.db.import"), dir.join("uan.db"));
            let _ = std::fs::rename(dir.join("account.key.import"), dir.join("account.key"));
        }
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
        let _ = db.execute("ALTER TABLE groups ADD COLUMN channels TEXT", []);
        let _ = db.execute("ALTER TABLE messages ADD COLUMN sealed TEXT", []);
        let _ = db.execute("ALTER TABLE messages ADD COLUMN reply TEXT", []);
        let _ = db.execute("ALTER TABLE messages ADD COLUMN edited INTEGER", []);
        let _ = db.execute("ALTER TABLE profiles ADD COLUMN bio TEXT", []);
        let _ = db.execute("ALTER TABLE profiles ADD COLUMN joined INTEGER", []);
        let _ = db.execute("ALTER TABLE profiles ADD COLUMN banner TEXT", []);
        let _ = db.execute("ALTER TABLE profiles ADD COLUMN bioimg TEXT", []);
        let _ = db.execute("ALTER TABLE profiles ADD COLUMN bioimg_v INTEGER", []);
        let _ = db.execute("ALTER TABLE profiles ADD COLUMN look TEXT", []);
        let _ = db.execute("DELETE FROM kv WHERE k = 'badge'", []);
        // When this account began: the earliest thing we know of (older versions never wrote it down).
        let _ = db.execute(
            "INSERT OR IGNORE INTO kv (k, v) SELECT 'joined', CAST(COALESCE((SELECT MIN(t) FROM (SELECT MIN(ts) AS t FROM messages UNION ALL SELECT MIN(created_at) FROM contacts)), strftime('%s','now') * 1000) AS TEXT)",
            [],
        );
        let _ = db.execute("ALTER TABLE groups ADD COLUMN admins TEXT", []);
        let _ = db.execute("ALTER TABLE groups ADD COLUMN avatar TEXT", []);
        // Locked channels ask for their password every time: no channel key survives a restart.
        let _ = db.execute("DELETE FROM kv WHERE k LIKE 'chkey:%'", []);

        // Bigger flow-control windows than the defaults (sized for ~100 Mbit/s at 100 ms), so films
        // also go fast between far-away PCs with high latency.
        let transport = iroh::endpoint::QuicTransportConfig::builder()
            .stream_receive_window(iroh::endpoint::VarInt::from_u32(16 * 1024 * 1024))
            .send_window(128 * 1024 * 1024)
            .build();
        let endpoint = Endpoint::builder(presets::N0)
            .transport_config(transport)
            .secret_key(secret.clone())
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .map_err(|e| format!("Couldn't start networking: {e}"))?;
        let me = endpoint.id();
        let acct_secret = match std::fs::read(dir.join("account.key")) {
            Ok(b) if b.len() == 32 => SecretKey::from_bytes(&b.try_into().unwrap()),
            _ => secret.clone(),
        };
        let me_s = acct_secret.public().to_string();
        let dev_s = me.to_string();
        let cert = (me_s != dev_s).then(|| sign_with(&acct_secret, &format!("uan-dev:{dev_s}")));
        let devmap: HashMap<String, String> = {
            let mut stmt = db.prepare("SELECT dev, acct FROM devices").map_err(e2s)?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e2s)?;
            rows.filter_map(Result::ok).collect()
        };

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
            me_s,
            dev_s,
            acct_secret,
            cert,
            devmap: Mutex::new(devmap),
            dev_seen: Mutex::new(HashMap::new()),
            link: Mutex::new(None),
            db: Mutex::new(db),
            conns: Mutex::new(HashMap::new()),
            seen: Mutex::new(HashMap::new()),
            flushing: Mutex::new(HashSet::new()),
            protos: Mutex::new(HashMap::new()),
            modes: Mutex::new(HashMap::new()),
            watching: Mutex::new(HashMap::new()),
            watching_told: Mutex::new(String::new()),
            reads_sent: Mutex::new(HashMap::new()),
            transfers: Mutex::new(transfers),
            running: Mutex::new(HashMap::new()),
            partials: Mutex::new(HashMap::new()),
            parties: Mutex::new(HashMap::new()),
            caches: Mutex::new(HashMap::new()),
            buffering: Mutex::new(HashSet::new()),
            full_parties: Mutex::new(HashSet::new()),
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
        format!("UAN-{}", BASE32_NOPAD.encode(self.acct_secret.public().as_bytes()))
    }

    // ----- Devices: one account on a PC and a phone -----

    /// Remembers that `dev` belongs to `acct` (if the account's signature is right).
    fn learn_dev(&self, acct: &str, dev: &str, cert: &str, name: &str) -> bool {
        if acct == dev {
            return true;
        }
        if self.devmap.lock().unwrap().get(dev).is_some_and(|a| a == acct) && name.is_empty() {
            return true;
        }
        if !verify_dev(acct, dev, cert) {
            return false;
        }
        let _ = self.db.lock().unwrap().execute(
            "INSERT INTO devices (dev, acct, cert, name, added) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(dev) DO UPDATE SET acct = excluded.acct, cert = excluded.cert, name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE devices.name END",
            params![dev, acct, cert, name, now()],
        );
        self.devmap.lock().unwrap().insert(dev.to_string(), acct.to_string());
        true
    }

    fn learn_devs(&self, acct: &str, list: &Value) {
        let Some(arr) = list.as_array() else { return };
        for d in arr.iter().take(8) {
            if let (Some(id), Some(cert)) = (d["id"].as_str(), d["cert"].as_str()) {
                if parse_id(id).is_ok() {
                    self.learn_dev(acct, id, cert, d["name"].as_str().unwrap_or(""));
                }
            }
        }
    }

    /// The account a device belongs to (a PC is its own account).
    fn account_of(&self, dev: &str) -> String {
        self.devmap.lock().unwrap().get(dev).cloned().unwrap_or_else(|| dev.to_string())
    }

    /// Every device of an account except this one, the ones heard from most recently first.
    fn devices_of(&self, acct: &str) -> Vec<String> {
        let mut v = vec![acct.to_string()];
        v.extend(self.devmap.lock().unwrap().iter().filter(|(d, a)| *a == acct && *d != acct).map(|(d, _)| d.clone()));
        v.retain(|d| *d != self.dev_s);
        let seen = self.dev_seen.lock().unwrap();
        v.sort_by(|a, b| seen.get(b).cmp(&seen.get(a)));
        v
    }

    /// Our account's devices with their signatures (told to friends so they reach all of them).
    fn my_certs(&self) -> Vec<DevCert> {
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare("SELECT dev, cert, name FROM devices WHERE acct = ?1 ORDER BY added").unwrap();
        let rows = stmt.query_map([&self.me_s], |r| Ok(DevCert { id: r.get(0)?, cert: r.get(1)?, name: r.get(2)? })).unwrap();
        rows.filter_map(Result::ok).collect()
    }

    pub fn devices(&self) -> Value {
        let seen = self.dev_seen.lock().unwrap().clone();
        let mut out = vec![json!({ "id": self.me_s, "name": "PC", "primary": true, "here": self.me_s == self.dev_s, "online": self.me_s == self.dev_s || seen.get(&self.me_s).is_some_and(|t| t.elapsed() < ONLINE_WINDOW) })];
        for d in self.my_certs() {
            let online = d.id == self.dev_s || seen.get(&d.id).is_some_and(|t| t.elapsed() < ONLINE_WINDOW);
            out.push(json!({ "id": d.id, "name": if d.name.is_empty() { "Phone".to_string() } else { d.name }, "primary": false, "here": d.id == self.dev_s, "online": online }));
        }
        json!(out)
    }

    /// What this device sends: phones say which account they belong to.
    fn wrap(&self, req: &Req) -> Req {
        match &self.cert {
            Some(c) => Req::Dev { acct: self.me_s.clone(), cert: c.clone(), req: Box::new(req.clone()) },
            None => req.clone(),
        }
    }

    /// Unwraps what a device sent: (the account it speaks for, the request).
    fn open_dev(&self, dev: &str, req: Req) -> Result<(String, Req), String> {
        self.dev_seen.lock().unwrap().insert(dev.to_string(), Instant::now());
        match req {
            Req::Dev { acct, cert, req } => {
                if matches!(*req, Req::Dev { .. }) || !self.learn_dev(&acct, dev, &cert, "") {
                    return Err("Unknown device.".into());
                }
                Ok((acct, *req))
            }
            other => Ok((self.account_of(dev), other)),
        }
    }

    /// Things a friend sends that our other devices should get too (in case the friend doesn't know them yet).
    fn mirrorable(req: &Req) -> bool {
        matches!(req, Req::Msg { .. } | Req::FriendRequest { .. } | Req::FriendAccept { .. } | Req::FriendRemove | Req::Group { .. } | Req::GroupLeave { .. } | Req::Unsend { .. } | Req::Edit { .. } | Req::Pin { .. } | Req::React { .. } | Req::Thumb { .. } | Req::ClearGroup { .. })
    }

    /// Passes something to our other devices (directly, or through the mailbox while they are off).
    fn mirror(self: &Arc<Self>, from: &str, chat: &str, req: &Req) {
        let devs = self.devices_of(&self.me_s);
        if devs.is_empty() {
            return;
        }
        let m = Req::Mirror { from: from.to_string(), chat: chat.to_string(), req: Box::new(req.clone()) };
        let payload = serde_json::to_string(&m).unwrap();
        for d in devs {
            let _ = self.db.lock().unwrap().execute("INSERT INTO outbox (peer, payload, created_at) VALUES (?1, ?2, ?3)", params![d, payload, now()]);
            tauri::async_runtime::spawn(self.clone().flush(d));
        }
    }

    /// Something we did on our other device.
    fn apply_own(self: &Arc<Self>, chat: &str, req: Req) -> Result<Value, String> {
        let ok = json!({ "ok": true, "proto": PROTO });
        let me = self.me_s.clone();
        match req {
            Req::Msg { msg } => {
                let chat = match &msg.group {
                    Some(g) => {
                        if !self.is_member(g, &me) {
                            return Err("later".into());
                        }
                        chat_id(g, msg.channel.as_deref())
                    }
                    None => chat.to_string(),
                };
                if chat.is_empty() || msg.file.as_ref().is_some_and(|f| f.size > MAX_FILE_SIZE) {
                    return Err("Invalid message.".into());
                }
                let text = msg.text.as_ref().map(|t| t.chars().take(5000).collect::<String>());
                self.store_message(&msg.id, &chat, &me, &msg.name, text.as_deref(), msg.file.as_ref(), msg.ts, msg.sealed.as_deref(), msg.reply.as_ref());
                Ok(ok)
            }
            Req::Edit { msg_id, text, sealed } => {
                let chat: Option<String> = self.db.lock().unwrap().query_row("SELECT chat FROM messages WHERE id = ?1 AND sender = ?2", [&msg_id, &me], |r| r.get(0)).optional().ok().flatten();
                if let Some(chat) = chat {
                    self.apply_edit(&chat, &msg_id, text.as_deref(), sealed.as_deref());
                }
                Ok(ok)
            }
            Req::Unsend { msg_id } => {
                self.remove_message(&msg_id, Some(&me));
                Ok(ok)
            }
            Req::Pin { msg_id, pinned, .. } => {
                if !chat.is_empty() {
                    self.apply_pin(chat, &msg_id, &me, pinned);
                }
                Ok(ok)
            }
            Req::React { msg_id, emoji, .. } => {
                if !chat.is_empty() {
                    self.apply_react(chat, &msg_id, &me, &emoji);
                }
                Ok(ok)
            }
            Req::Thumb { file_id, data } => {
                if data.len() <= 300_000 && data.starts_with('{') {
                    let _ = self.db.lock().unwrap().execute("INSERT OR REPLACE INTO thumbs (file_id, data) VALUES (?1, ?2)", [&file_id, &data]);
                    self.emit("thumb", json!({ "fileId": file_id, "thumb": serde_json::from_str::<Value>(&data).unwrap_or(Value::Null) }));
                }
                Ok(ok)
            }
            Req::Group { group } => {
                let version: Option<i64> = self.db.lock().unwrap().query_row("SELECT version FROM groups WHERE id = ?1", [&group.id], |r| r.get(0)).optional().ok().flatten();
                if version.is_none_or(|v| group.version > v) {
                    if group.members.iter().any(|m| m.id == me) {
                        self.save_group(&group);
                    } else if version.is_some() {
                        self.delete_group_local(&group.id);
                    }
                }
                Ok(ok)
            }
            Req::GroupLeave { group_id } => {
                self.delete_group_local(&group_id);
                Ok(ok)
            }
            Req::ModDelete { msg_id, .. } => {
                if let Some((_, from, Some(f))) = self.remove_message(&msg_id, None) {
                    if from != me {
                        self.forget_file(&f.id);
                    }
                }
                Ok(ok)
            }
            Req::FriendRequest { name } => {
                if !chat.is_empty() && parse_id(chat).is_ok() && self.contact_status(chat).as_deref() != Some("friend") {
                    self.set_contact(chat, &name, "outgoing");
                }
                Ok(ok)
            }
            Req::FriendAccept { name } => {
                if !chat.is_empty() && parse_id(chat).is_ok() {
                    self.set_contact(chat, &name, "friend");
                }
                Ok(ok)
            }
            Req::FriendRemove => {
                let _ = self.db.lock().unwrap().execute("DELETE FROM contacts WHERE id = ?1", [chat]);
                self.emit("contacts", Value::Null);
                Ok(ok)
            }
            Req::ClearGroup { group_id, before, channel } => {
                self.clear_local(&chat_id(&group_id, channel.as_deref()), before);
                Ok(ok)
            }
            Req::MyProfile { name, status, avatar, bio, banner, look, pv } => {
                if pv > self.my_pv() && !name.trim().is_empty() {
                    self.set_kv("name", &name.chars().take(32).collect::<String>());
                    self.set_kv("status", &status.chars().take(60).collect::<String>());
                    if let Some(b) = bio {
                        self.set_kv("bio", &b.chars().take(500).collect::<String>());
                    }
                    if let Some(l) = look {
                        self.set_kv("look", &clean_look(&l));
                    }
                    if let Some(b) = banner {
                        match clean_banner(&b) {
                            Some(v) => self.set_kv("banner", &v),
                            None => {
                                let _ = self.db.lock().unwrap().execute("DELETE FROM kv WHERE k = 'banner'", []);
                            }
                        }
                    }
                    match avatar.filter(|a| is_pic(a) && a.len() <= 200_000) {
                        Some(a) => self.set_kv("avatar", &a),
                        None => {
                            let _ = self.db.lock().unwrap().execute("DELETE FROM kv WHERE k = 'avatar'", []);
                        }
                    }
                    self.set_kv("pv", &pv.to_string());
                    self.emit("me", Value::Null);
                }
                Ok(ok)
            }
            _ => Err("Not allowed.".into()),
        }
    }

    // ----- Signing a phone in to this PC's account -----

    /// Makes a pairing code for the phone and leaves this PC's address in the mailbox under it.
    pub async fn link_start(self: &Arc<Self>) -> Result<String, String> {
        if self.cert.is_some() {
            return Err("Do this on your PC: this device is already signed in to it.".into());
        }
        const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let raw = Sha256::digest(format!("{}{}{}", new_id(), new_id(), now()).as_bytes());
        let code: String = raw.iter().take(10).map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char).collect();
        let key = link_key(&code);
        let rid = key.public().to_string();
        let note = json!({ "pc": self.dev_s }).to_string();
        let ts = now();
        let digest = HEXLOWER.encode(&Sha256::digest(note.as_bytes()));
        let sig = self.sign_hex(&format!("send:{rid}:{ts}:{digest}"));
        self.mailbox_post("/send", json!({ "from": self.dev_s, "to": rid, "box": note, "ts": ts, "sig": sig }))
            .await
            .map_err(|e| format!("Couldn't reach the mailbox ({e}). Check the internet connection."))?;
        *self.link.lock().unwrap() = Some(LinkSession { key, expires: now() + 15 * 60 * 1000, dev: None, snapshot: None });
        Ok(format!("{}-{}-{}", &code[..4], &code[4..8], &code[8..]))
    }

    /// A phone (or second PC) signed in to another PC's account.
    pub fn is_linked_device(&self) -> bool {
        self.cert.is_some()
    }

    pub fn link_cancel(&self) {
        *self.link.lock().unwrap() = None;
    }

    /// The PC's side: hands a copy of the account to the phone that knows the code, in parts.
    fn link_serve(self: &Arc<Self>, dev: &str, proof: &str, name: &str, part: u32) -> Result<Value, String> {
        const PART: usize = 600 * 1024;
        let (chunk, parts, first) = {
            let mut guard = self.link.lock().unwrap();
            let s = guard.as_mut().ok_or("No phone is being signed in on that PC right now. Make a new code.")?;
            if now() > s.expires {
                *guard = None;
                return Err("That code has expired. Make a new one on your PC.".into());
            }
            let ok_proof = HEXLOWER
                .decode(proof.as_bytes())
                .ok()
                .and_then(|b| <[u8; 64]>::try_from(b).ok())
                .is_some_and(|arr| s.key.public().verify(format!("uan-link:{dev}").as_bytes(), &iroh::Signature::from_bytes(&arr)).is_ok());
            if !ok_proof || parse_id(dev).is_err() {
                return Err("Wrong code.".into());
            }
            if s.dev.as_deref().is_some_and(|d| d != dev) {
                return Err("Another device is already using this code.".into());
            }
            if s.snapshot.is_none() {
                s.dev = Some(dev.to_string());
                // Register the phone first, so its copy already knows it belongs to the account.
                let cert = sign_with(&self.acct_secret, &format!("uan-dev:{dev}"));
                let label: String = name.trim().chars().take(32).collect();
                self.learn_dev(&self.me_s, dev, &cert, if label.is_empty() { "Phone" } else { &label });
                let tmp = self.dir.join("link.tmp.db");
                let _ = std::fs::remove_file(&tmp);
                self.db.lock().unwrap().execute("VACUUM INTO ?1", [tmp.to_string_lossy()]).map_err(e2s)?;
                {
                    // Only what makes sense on the phone: no PC paths, nothing waiting to be sent from here.
                    let c = rusqlite::Connection::open(&tmp).map_err(e2s)?;
                    for q in [
                        "DELETE FROM outbox",
                        "DELETE FROM shared_files",
                        "DELETE FROM downloads",
                        "DELETE FROM kv WHERE k LIKE 'chkey:%' OR k IN ('autostart', 'icon')",
                    ] {
                        let _ = c.execute(q, []);
                    }
                    let _ = c.execute("VACUUM", []);
                }
                let bytes = std::fs::read(&tmp).map_err(e2s)?;
                let _ = std::fs::remove_file(&tmp);
                s.snapshot = Some(bytes);
            }
            let snap = s.snapshot.as_ref().unwrap();
            let parts = snap.len().div_ceil(PART).max(1);
            let i = part as usize;
            if i >= parts {
                return Err("Bad part.".into());
            }
            let chunk = snap[i * PART..((i + 1) * PART).min(snap.len())].to_vec();
            if i + 1 == parts {
                *guard = None;
            }
            (chunk, parts, i == 0)
        };
        let mut v = json!({ "ok": true, "proto": PROTO, "parts": parts, "data": BASE64.encode(&chunk) });
        if first {
            v["account"] = json!(HEXLOWER.encode(&self.acct_secret.to_bytes()));
        }
        if part as usize + 1 == parts {
            // Tell friends about the new device, so they send to it too.
            let req = Req::Devices { devs: self.my_certs() };
            for p in self.known_peers() {
                self.deliver(&p, &req);
            }
            self.emit("linked", json!({ "name": name }));
        }
        Ok(v)
    }

    /// The phone's side: finds the PC by the code, takes a copy of the account. It takes effect after a restart.
    pub async fn link_join(self: &Arc<Self>, code: &str, name: &str) -> Result<(), String> {
        let norm: String = code.to_uppercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        if norm.len() != 10 {
            return Err("The code has 10 letters and numbers, like ABCD-EFGH-JK.".into());
        }
        let key = link_key(&norm);
        let rid = key.public().to_string();
        let ts = now();
        let v = self
            .mailbox_post("/fetch", json!({ "who": rid, "ts": ts, "sig": sign_with(&key, &format!("fetch:{rid}:{ts}")) }))
            .await
            .map_err(|e| format!("Couldn't reach the mailbox ({e}). Check the internet connection."))?;
        let mut pc = None;
        let mut ids = Vec::new();
        for m in v["mail"].as_array().cloned().unwrap_or_default() {
            if let Some(id) = m["id"].as_i64() {
                ids.push(id);
            }
            let note: Value = serde_json::from_str(m["box"].as_str().unwrap_or("")).unwrap_or(Value::Null);
            if let (Some(p), Some(sender)) = (note["pc"].as_str(), m["sender"].as_str()) {
                if p == sender && parse_id(p).is_ok() {
                    pc = Some(p.to_string());
                }
            }
        }
        let pc = pc.ok_or("No PC is waiting with this code. Check the code, or make a new one on your PC.")?;
        if pc == self.dev_s {
            return Err("That code is from this device. Type it on your phone.".into());
        }
        let proof = sign_with(&key, &format!("uan-link:{}", self.dev_s));
        let mut data = Vec::new();
        let mut account = None;
        let mut part = 0u32;
        loop {
            let v = self.request_dev(&pc, &Req::LinkGet { proof: proof.clone(), name: name.to_string(), part }).await.map_err(|e| match e {
                ReqError::Offline(_) => "Couldn't reach your PC. Make sure UaN is running on it, then try again.".to_string(),
                ReqError::Refused(e) => e,
            })?;
            if part == 0 {
                account = v["account"].as_str().map(str::to_string);
            }
            data.extend(BASE64.decode(v["data"].as_str().unwrap_or("").as_bytes()).map_err(e2s)?);
            let parts = v["parts"].as_u64().unwrap_or(1) as u32;
            part += 1;
            if part >= parts {
                break;
            }
            self.emit("link-progress", json!({ "done": part, "parts": parts }));
        }
        let acct = account
            .and_then(|a| HEXLOWER.decode(a.as_bytes()).ok())
            .and_then(|b| <[u8; 32]>::try_from(b).ok())
            .map(|b| SecretKey::from_bytes(&b))
            .ok_or("The PC didn't send the account.")?;
        if acct.public().to_string() != pc || data.len() < 1024 {
            return Err("That didn't work. Make a new code on your PC and try again.".into());
        }
        if !ids.is_empty() {
            let ts = now();
            let list = ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
            let _ = self.mailbox_post("/ack", json!({ "who": rid, "ts": ts, "ids": ids, "sig": sign_with(&key, &format!("ack:{rid}:{ts}:{list}")) })).await;
        }
        std::fs::write(self.dir.join("uan.db.import"), &data).map_err(e2s)?;
        std::fs::write(self.dir.join("account.key.import"), acct.to_bytes()).map_err(e2s)?;
        Ok(())
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
        json!({ "status": self.kv("status").unwrap_or_default(), "avatar": self.kv("avatar"), "pv": self.my_pv(), "bio": self.kv("bio").unwrap_or_default(), "banner": self.kv("banner"), "look": self.kv("look").unwrap_or_default(), "bioimgV": self.kv("bioimg_v").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0), "joined": self.kv("joined").and_then(|j| j.parse::<i64>().ok()) })
    }

    fn my_pv(&self) -> i64 {
        self.kv("pv").and_then(|v| v.parse().ok()).unwrap_or(0)
    }

    fn ping_req(&self) -> Req {
        Req::Ping { name: self.my_name(), status: self.kv("status").unwrap_or_default(), pv: self.my_pv(), proto: PROTO, mode: self.my_mode(), watching: self.my_watching(), devs: self.my_certs() }
    }

    pub fn set_name(self: &Arc<Self>, name: &str) -> Result<(), String> {
        self.set_profile(name, None, None, None, None, None, None)
    }

    /// Name, status line ("Gaming 🎮") and profile picture (a small data: URL made by the window).
    pub fn set_profile(self: &Arc<Self>, name: &str, status: Option<&str>, avatar: Option<&str>, bio: Option<&str>, banner: Option<&str>, bioimg: Option<&str>, look: Option<&str>) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 32 {
            return Err("Pick a name of 1–32 characters.".into());
        }
        self.set_kv("name", name);
        if let Some(st) = status {
            let st: String = st.trim().chars().take(60).collect();
            self.set_kv("status", &st);
        }
        if let Some(b) = bio {
            let b: String = b.trim().chars().take(500).collect();
            self.set_kv("bio", &b);
        }
        if let Some(l) = look {
            self.set_kv("look", &clean_look(l));
        }
        if let Some(b) = bioimg {
            if b.is_empty() {
                let _ = self.db.lock().unwrap().execute("DELETE FROM kv WHERE k IN ('bioimg', 'bioimg_v')", []);
            } else {
                if !(b.starts_with("data:image/") || b.starts_with("data:video/webm")) || b.len() > BIOIMG_MAX {
                    return Err("That picture is too big (about 700 KB at most).".into());
                }
                self.set_kv("bioimg", b);
                self.set_kv("bioimg_v", &now().to_string());
            }
        }
        if let Some(b) = banner {
            if b.is_empty() {
                let _ = self.db.lock().unwrap().execute("DELETE FROM kv WHERE k = 'banner'", []);
            } else {
                match clean_banner(b) {
                    Some(v) => self.set_kv("banner", &v),
                    None => return Err("That background is not allowed or too big.".into()),
                }
            }
        }
        if let Some(a) = avatar {
            if a.is_empty() {
                let _ = self.db.lock().unwrap().execute("DELETE FROM kv WHERE k = 'avatar'", []);
            } else {
                if !is_pic(a) || a.len() > 200_000 {
                    return Err("That picture is too big.".into());
                }
                self.set_kv("avatar", a);
            }
        }
        self.set_kv("pv", &now().to_string());
        self.mirror(&self.me_s.clone(), "", &Req::MyProfile { name: name.to_string(), status: self.kv("status").unwrap_or_default(), avatar: self.kv("avatar"), bio: self.kv("bio"), banner: Some(self.kv("banner").unwrap_or_default()), look: Some(self.kv("look").unwrap_or_default()), pv: self.my_pv() });
        // Let everyone know.
        let req = self.ping_req();
        for p in self.known_peers() {
            let me = self.clone();
            let req = req.clone();
            tauri::async_runtime::spawn(async move {
                let _ = me.request_all(&p, &req).await;
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
                let avatar = v["avatar"].as_str().filter(|a| is_pic(a) && a.len() <= 200_000);
                let bio: Option<String> = v["bio"].as_str().map(|b| b.chars().take(500).collect());
                let joined = v["joined"].as_i64();
                let banner = v["banner"].as_str().and_then(clean_banner);
                let look = v["look"].as_str().map(clean_look);
                let _ = me.db.lock().unwrap().execute(
                    "INSERT INTO profiles (id, status, avatar, pv, bio, joined, banner, look) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(id) DO UPDATE SET status = excluded.status, avatar = excluded.avatar, pv = excluded.pv, bio = COALESCE(excluded.bio, bio), joined = COALESCE(excluded.joined, joined), banner = excluded.banner, look = excluded.look",
                    params![peer, v["status"].as_str().unwrap_or(""), avatar, v["pv"].as_i64().unwrap_or(pv), bio, joined, banner, look],
                );
                if let Some(n) = v["name"].as_str() {
                    me.update_name(&peer, n);
                }
                let iv = v["bioimg_v"].as_i64().unwrap_or(0);
                let known_iv: i64 = me.db.lock().unwrap().query_row("SELECT COALESCE(bioimg_v, 0) FROM profiles WHERE id = ?1", [&peer], |r| r.get(0)).unwrap_or(0);
                if iv == 0 && known_iv != 0 {
                    let _ = me.db.lock().unwrap().execute("UPDATE profiles SET bioimg = NULL, bioimg_v = 0 WHERE id = ?1", [&peer]);
                } else if iv != 0 && iv != known_iv {
                    if let Ok(r) = me.request(&peer, &Req::BioImage).await {
                        let img = r["img"].as_str().filter(|b| (b.starts_with("data:image/") || b.starts_with("data:video/webm")) && b.len() <= BIOIMG_MAX);
                        let _ = me.db.lock().unwrap().execute("UPDATE profiles SET bioimg = ?2, bioimg_v = ?3 WHERE id = ?1", params![peer, img, iv]);
                    }
                }
                me.emit("contacts", Value::Null);
            }
        });
    }

    // ----- Previews -----

    /// The sender's window makes a small preview (picture + video length) right after sending.
    pub fn set_thumb(self: &Arc<Self>, file_id: &str, data: &str) -> Result<(), String> {
        if data.len() > 300_000 || !data.starts_with('{') {
            return Err("Preview too big.".into());
        }
        let chats: Vec<String> = {
            let db = self.db.lock().unwrap();
            let mine = db.query_row("SELECT 1 FROM shared_files WHERE id = ?1", [file_id], |_| Ok(())).optional().ok().flatten().is_some();
            if !mine {
                return Err("Not your file.".into());
            }
            let _ = db.execute("INSERT OR REPLACE INTO thumbs (file_id, data) VALUES (?1, ?2)", [file_id, data]);
            drop(db);
            self.mirror(&self.me_s.clone(), "", &Req::Thumb { file_id: file_id.to_string(), data: data.to_string() });
            let db = self.db.lock().unwrap();
            // Files sent only in locked channels keep their preview here (it would not be encrypted).
            let open = db
                .query_row("SELECT 1 FROM messages WHERE json_extract(file, '$.id') = ?1 LIMIT 1", [file_id], |_| Ok(()))
                .optional()
                .ok()
                .flatten()
                .is_some();
            if !open {
                return Ok(());
            }
            let mut stmt = db.prepare("SELECT who FROM file_access WHERE file_id = ?1").map_err(e2s)?;
            let rows = stmt.query_map([file_id], |r| r.get::<_, String>(0)).map_err(e2s)?;
            rows.filter_map(Result::ok).collect()
        };
        self.emit("thumb", json!({ "fileId": file_id, "thumb": serde_json::from_str::<Value>(data).unwrap_or(Value::Null) }));
        let mut targets = HashSet::new();
        for chat in chats {
            if let Ok((_, t)) = self.chat_targets(&chat) {
                targets.extend(t);
            }
        }
        let req = Req::Thumb { file_id: file_id.to_string(), data: data.to_string() };
        for t in targets {
            self.deliver(&t, &req);
        }
        Ok(())
    }

    // ----- Automatic downloads -----

    /// (on, max size in GB). Off unless you turn it on in Settings: films stream, nothing is downloaded by itself.
    /// (A new key: the old "autodl" setting was on by default and is ignored.)
    pub fn autodl(&self) -> (bool, u64) {
        (self.kv("auto_download").map(|v| v == "1").unwrap_or(false), self.kv("autodl_gb").and_then(|v| v.parse().ok()).unwrap_or(10))
    }

    pub fn set_autodl(&self, on: bool, gb: u64) {
        self.set_kv("auto_download", if on { "1" } else { "0" });
        self.set_kv("autodl_gb", &gb.clamp(1, 4096).to_string());
    }

    // ----- Small files through the mailbox (sender may be off by the time the friend comes online) -----

    fn seal_bytes(&self, peer: &str, data: &[u8]) -> Result<Vec<u8>, String> {
        let b = self.box_for(peer)?;
        let nonce = SalsaBox::generate_nonce(&mut OsRng);
        let ct = b.encrypt(&nonce, data).map_err(|_| "Encryption failed.".to_string())?;
        let mut out = nonce.to_vec();
        out.extend_from_slice(&ct);
        Ok(out)
    }

    fn open_bytes(&self, peer: &str, raw: &[u8]) -> Result<Vec<u8>, String> {
        if raw.len() < 24 {
            return Err("Too short.".into());
        }
        let b = self.box_for(peer)?;
        b.decrypt(crypto_box::Nonce::from_slice(&raw[..24]), &raw[24..]).map_err(|_| "Can't decrypt.".to_string())
    }

    async fn blob_send(&self, peer: &str, req: &Req) {
        let Req::Msg { msg } = req else { return };
        let Some(file) = msg.file.as_ref().filter(|f| f.owner == self.me_s && f.dev.is_none() && f.size <= BLOB_MAX) else { return };
        let url = self.mailbox_url();
        let path: Option<String> = self.db.lock().unwrap().query_row("SELECT path FROM shared_files WHERE id = ?1", [&file.id], |r| r.get(0)).optional().ok().flatten();
        let (Some(path), false) = (path, url.is_empty()) else { return };
        let Ok(data) = tokio::fs::read(&path).await else { return };
        let Ok(sealed) = self.seal_bytes(peer, &data) else { return };
        let ts = now();
        let sig = self.sign_hex(&format!("blobput:{peer}:{}:{ts}:{}", file.id, sealed.len()));
        let res = self
            .http
            .post(format!("{url}/blob/put?from={}&to={peer}&id={}&ts={ts}&sig={sig}", self.dev_s, file.id))
            .timeout(Duration::from_secs(600))
            .body(sealed)
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => self.log(&format!("mailbox: left {} for {}", file.name, &peer[..8])),
            Ok(r) => self.log(&format!("mailbox: couldn't leave a file: {}", r.status())),
            Err(e) => self.log(&format!("mailbox: couldn't leave a file: {e}")),
        }
    }

    async fn blob_fetch(&self, from: &str, file: &FileMeta, chat: &str) -> bool {
        if self.local_copy(file).is_some() {
            return true;
        }
        let url = self.mailbox_url();
        let ts = now();
        let sig = self.sign_hex(&format!("blobget:{}:{}:{ts}", self.dev_s, file.id));
        let Ok(r) = self.http.post(format!("{url}/blob/get")).timeout(Duration::from_secs(600)).json(&json!({ "who": self.dev_s, "id": file.id, "ts": ts, "sig": sig })).send().await else { return false };
        if !r.status().is_success() {
            return false;
        }
        let Ok(raw) = r.bytes().await else { return false };
        let Ok(plain) = self.open_bytes(from, &raw) else {
            self.log("mailbox: a file couldn't be decrypted");
            return false;
        };
        if plain.len() as u64 != file.size {
            return false;
        }
        let Ok(dir) = Self::auto_dir() else { return false };
        let path = unique_path(&dir, &safe_file_name(&file.name));
        if tokio::fs::write(&path, &plain).await.is_err() {
            return false;
        }
        let p = path.to_string_lossy().into_owned();
        let _ = self.db.lock().unwrap().execute("INSERT OR REPLACE INTO downloads (file_id, path, chat) VALUES (?1, ?2, ?3)", [&file.id, &p, chat]);
        self.transfers.lock().unwrap().push(Transfer {
            id: new_id(),
            name: path.file_name().and_then(|n| n.to_str()).unwrap_or(&file.name).to_string(),
            size: file.size,
            done: file.size,
            status: "done".into(),
            error: None,
            speed: 0.0,
            path: p,
            file: file.clone(),
            chat: chat.to_string(),
        });
        self.emit_transfers();
        let ts = now();
        let sig = self.sign_hex(&format!("blobdel:{}:{}:{ts}", self.dev_s, file.id));
        let _ = self.http.post(format!("{url}/blob/del")).json(&json!({ "who": self.dev_s, "id": file.id, "ts": ts, "sig": sig })).send().await;
        self.log(&format!("mailbox: picked up file {}", file.name));
        true
    }

    /// Throws away a file waiting for us in the mailbox (its message was deleted).
    async fn blob_drop(&self, file_id: &str) {
        let url = self.mailbox_url();
        if url.is_empty() {
            return;
        }
        let ts = now();
        let sig = self.sign_hex(&format!("blobdel:{}:{}:{ts}", self.dev_s, file_id));
        let _ = self.http.post(format!("{url}/blob/del")).json(&json!({ "who": self.dev_s, "id": file_id, "ts": ts, "sig": sig })).send().await;
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

    // ----- Theme workshop (on the mailbox's server): signed with the account key, so it is the same "you" on every device -----

    fn ws_base(&self) -> Result<String, String> {
        let url = self.mailbox_url();
        if url.is_empty() {
            return Err("The theme workshop lives on the mailbox: set one in Settings → Offline mailbox.".into());
        }
        Ok(url)
    }

    fn ws_sign(&self, msg: &str) -> String {
        HEXLOWER.encode(&self.acct_secret.sign(msg.as_bytes()).to_bytes())
    }

    async fn ws_answer(r: reqwest::Response) -> Result<Value, String> {
        let status = r.status();
        let v: Value = r.json().await.map_err(|_| format!("The theme workshop did not answer properly ({status})."))?;
        if v["ok"].as_bool() == Some(true) { Ok(v) } else { Err(v["error"].as_str().unwrap_or("Theme workshop error.").to_string()) }
    }

    pub async fn ws_list(&self, q: &str, sort: &str) -> Result<Value, String> {
        let base = self.ws_base()?;
        let ts = now().to_string();
        // Signed, so the server shows you your own waiting themes and likes (and nobody can ask for them with just your key).
        let sig = self.ws_sign(&format!("wslist:{}:{ts}", self.me_s));
        let r = self.http.get(format!("{base}/ws/list")).query(&[("q", q), ("sort", sort), ("who", self.me_s.as_str()), ("ts", ts.as_str()), ("sig", sig.as_str())]).send().await.map_err(|_| "Can't reach the theme workshop. Check your internet.".to_string())?;
        let mut v = Self::ws_answer(r).await.map_err(|e| if e == "Not found." { "The theme workshop is not switched on yet on this mailbox.".to_string() } else { e })?;
        v["base"] = json!(base);
        Ok(v)
    }

    /// Uploads a theme file; the description goes in the address (small), the picture for the list afterwards.
    pub async fn ws_publish(&self, path: &std::path::Path, mut meta: Value, thumb: Option<String>) -> Result<String, String> {
        let base = self.ws_base()?;
        let bytes = tokio::fs::read(path).await.map_err(e2s)?;
        if bytes.len() > 50 * 1024 * 1024 {
            return Err("A theme can be 50 MB at most.".into());
        }
        meta["author"] = json!(self.my_name());
        let meta_s = meta.to_string();
        let ts = now();
        let sig = self.ws_sign(&format!("wsput:{}:{ts}:{}:{meta_s}", self.me_s, bytes.len()));
        let r = self
            .http
            .put(format!("{base}/ws/upload"))
            .query(&[("owner", self.me_s.as_str()), ("ts", &ts.to_string()), ("sig", &sig), ("meta", &meta_s)])
            .timeout(Duration::from_secs(1800))
            .body(bytes)
            .send()
            .await
            .map_err(|_| "The upload stopped. Check your internet and try again.".to_string())?;
        let v = Self::ws_answer(r).await?;
        let id = v["id"].as_str().ok_or("The theme workshop did not answer properly.")?.to_string();
        if let Some(t) = thumb.filter(|t| t.starts_with("data:image/") && t.len() <= 40_000) {
            let _ = self.ws_act("thumb", &id, json!({ "thumb": t })).await;
        }
        Ok(id)
    }

    /// like (extra.on), report, delete, unhide, thumb (extra.thumb)
    pub async fn ws_act(&self, what: &str, id: &str, extra: Value) -> Result<Value, String> {
        let base = self.ws_base()?;
        let ts = now();
        let me = &self.me_s;
        let msg = match what {
            "like" => format!("wslike:{me}:{id}:{}:{ts}", if extra["on"].as_bool() == Some(true) { 1 } else { 0 }),
            "report" => format!("wsreport:{me}:{id}:{ts}"),
            "delete" => format!("wsdel:{me}:{id}:{ts}"),
            "unhide" => format!("wsunhide:{me}:{id}:{ts}"),
            "thumb" => format!("wsthumb:{me}:{id}:{ts}:{}", HEXLOWER.encode(&Sha256::digest(extra["thumb"].as_str().unwrap_or("").as_bytes()))),
            _ => return Err("Unknown action.".into()),
        };
        let mut body = json!({ "who": me, "id": id, "ts": ts, "sig": self.ws_sign(&msg) });
        if let Some(o) = extra.as_object() {
            for (k, v) in o {
                body[k] = v.clone();
            }
        }
        let r = self.http.post(format!("{base}/ws/{what}")).json(&body).send().await.map_err(|_| "Can't reach the theme workshop. Check your internet.".to_string())?;
        Self::ws_answer(r).await
    }

    /// The dev panel (a web page on the workshop's server), signed in with the account key for a few hours. Only where it was switched on.
    pub fn dev_panel_on(&self) -> bool {
        self.kv("devpanel").is_some()
    }

    pub fn dev_panel_url(&self) -> Result<String, String> {
        if !self.dev_panel_on() {
            return Err("The dev panel is not on this PC.".into());
        }
        let base = self.ws_base()?;
        let ts = now();
        let sig = self.ws_sign(&format!("wsadmin:{}:{ts}", self.me_s));
        Ok(format!("{base}/admin?who={}&ts={ts}&sig={sig}", self.me_s))
    }

    /// A suggestion for UaN, for the admin's dev panel.
    pub async fn ws_suggest(&self, text: &str) -> Result<(), String> {
        let base = self.ws_base()?;
        let text = text.trim();
        if text.is_empty() {
            return Err("Write something first.".into());
        }
        if text.encode_utf16().count() > 1000 {
            return Err("1000 characters at most.".into());
        }
        let ts = now();
        let sig = self.ws_sign(&format!("wssuggest:{}:{ts}:{}", self.me_s, HEXLOWER.encode(&Sha256::digest(text.as_bytes()))));
        let body = json!({ "who": self.me_s, "author": self.my_name(), "text": text, "ts": ts, "sig": sig });
        let r = self.http.post(format!("{base}/ws/suggest")).json(&body).send().await.map_err(|_| "Can't reach the server. Check your internet.".to_string())?;
        Self::ws_answer(r).await.map(|_| ())
    }

    pub async fn ws_download(&self, id: &str) -> Result<Vec<u8>, String> {
        let base = self.ws_base()?;
        let r = self.http.get(format!("{base}/ws/file/{id}")).timeout(Duration::from_secs(1800)).send().await.map_err(|_| "Can't reach the theme workshop. Check your internet.".to_string())?;
        if !r.status().is_success() {
            return Err("That theme is gone from the workshop.".into());
        }
        let b = r.bytes().await.map_err(|_| "The download stopped. Try again.".to_string())?;
        Ok(b.to_vec())
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
        match req {
            Req::Dev { req, .. } => Self::mailbox_ok(req),
            Req::Mirror { req, .. } => Self::mailbox_ok(req) || matches!(**req, Req::MyProfile { .. } | Req::ClearGroup { .. }),
            _ => matches!(req, Req::Msg { .. } | Req::FriendRequest { .. } | Req::FriendAccept { .. } | Req::FriendRemove | Req::Group { .. } | Req::GroupLeave { .. } | Req::Thumb { .. } | Req::Unsend { .. } | Req::Edit { .. } | Req::Pin { .. } | Req::React { .. } | Req::Devices { .. } | Req::ClearGroup { .. } | Req::ModDelete { .. }),
        }
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
        let sealed = self.seal(peer, &self.wrap(req))?;
        let ts = now();
        let digest = HEXLOWER.encode(&Sha256::digest(sealed.as_bytes()));
        let sig = self.sign_hex(&format!("send:{peer}:{ts}:{digest}"));
        self.mailbox_post("/send", json!({ "from": self.dev_s, "to": peer, "box": sealed, "ts": ts, "sig": sig })).await?;
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
            let sig = self.sign_hex(&format!("fetch:{}:{ts}", self.dev_s));
            let Ok(v) = self.mailbox_post("/fetch", json!({ "who": self.dev_s, "ts": ts, "sig": sig })).await else { return };
            let mail = v["mail"].as_array().cloned().unwrap_or_default();
            if mail.is_empty() {
                return;
            }
            let mut ids = Vec::new();
            let mut batch = Vec::new();
            for m in &mail {
                let (Some(id), Some(dev), Some(sealed)) = (m["id"].as_i64(), m["sender"].as_str(), m["box"].as_str()) else { continue };
                ids.push(id);
                batch.push((dev.to_string(), self.open_box(dev, sealed).and_then(|req| self.open_dev(dev, req))));
            }
            // Messages deleted later in the same pick-up (e.g. a folder sent, then deleted while we were off)
            // are never shown, and their files are not fetched.
            let mut unsent: HashSet<(String, String)> = HashSet::new();
            let mut clears: Vec<(String, String, Option<String>, i64)> = Vec::new();
            for (_, r) in &batch {
                match r {
                    Ok((from, Req::Unsend { msg_id })) => {
                        unsent.insert((from.clone(), msg_id.clone()));
                    }
                    Ok((from, Req::ClearGroup { group_id, before, channel })) => clears.push((from.clone(), group_id.clone(), channel.clone(), *before)),
                    _ => {}
                }
            }
            for (dev, opened) in batch {
                let dev = dev.as_str();
                match opened {
                    Ok((from, Req::Msg { msg }))
                        if unsent.contains(&(from.clone(), msg.id.clone()))
                            || clears.iter().any(|(by, g, c, before)| msg.group.as_deref() == Some(g.as_str()) && msg.channel == *c && msg.ts <= *before && self.group_owner(g).as_deref() == Some(by.as_str())) =>
                    {
                        if let Some(f) = &msg.file {
                            self.blob_drop(&f.id).await;
                        }
                    }
                    Ok((from, req)) if Self::mailbox_ok(&req) => {
                        let from = from.as_str();
                        if let Req::Msg { msg } = &req {
                            if let Some(file) = msg.file.as_ref().filter(|f| f.owner == from && f.dev.is_none() && f.size <= BLOB_MAX) {
                                let chat = msg.group.as_ref().map(|g| format!("g:{g}")).unwrap_or_else(|| from.to_string());
                                self.blob_fetch(dev, file, &chat).await;
                            }
                        }
                        let copy = (from != self.me_s && Self::mirrorable(&req)).then(|| req.clone());
                        match self.on_request(from, req) {
                            Ok(_) => {
                                if let Some(r) = copy {
                                    self.mirror(from, "", &r);
                                }
                            }
                            Err(e) => self.log(&format!("mailbox: message from {} refused: {e}", &from[..from.len().min(8)])),
                        }
                    }
                    _ => self.log(&format!("mailbox: dropped an unreadable message from {}", &dev[..dev.len().min(8)])),
                }
            }
            self.log(&format!("mailbox: picked up {} message(s)", ids.len()));
            let ts = now();
            let list = ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
            let sig = self.sign_hex(&format!("ack:{}:{ts}:{list}", self.dev_s));
            if self.mailbox_post("/ack", json!({ "who": self.dev_s, "ts": ts, "ids": ids, "sig": sig })).await.is_err() {
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
        if self.my_mode() == "dnd" {
            return; // Do not disturb
        }
        if !self.window_focused() && std::env::var_os("UAN_INVISIBLE").is_none() {
            let _ = self.app.notification().builder().title(title).body(body).show();
        }
    }

    // ----- Presence -----

    /// How each connected peer is reached right now: directly, or through a relay server (slower).
    pub fn links(&self) -> Value {
        let conns: Vec<(EndpointId, Connection)> = self.conns.lock().unwrap().iter().map(|(k, v)| (*k, v.clone())).collect();
        let mut out = serde_json::Map::new();
        for (id, c) in conns {
            if c.close_reason().is_some() {
                continue;
            }
            let paths = c.paths();
            let Some(p) = paths.iter().find(|p| p.is_selected()) else { continue };
            out.insert(id.to_string(), json!({ "direct": p.is_ip(), "rtt": p.rtt().as_millis() as u64 }));
        }
        Value::Object(out)
    }

    fn speaks(&self, peer: &str, proto: u32) -> bool {
        self.protos.lock().unwrap().get(&self.account_of(peer)).copied().unwrap_or(0) >= proto
    }

    /// Remembers what a peer's UaN understands; the first time, sends what was waiting for that.
    fn note_proto(self: &Arc<Self>, peer: &str, proto: u32) {
        let before = self.protos.lock().unwrap().insert(peer.to_string(), proto);
        if proto >= 2 {
            if before != Some(proto) {
                tauri::async_runtime::spawn(self.clone().flush(peer.to_string()));
            }
            self.sync_reads(peer);
        }
    }

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

    /// Asks someone: their devices in turn (the one heard from last first) until one answers.
    async fn request(self: &Arc<Self>, peer: &str, req: &Req) -> Result<Value, ReqError> {
        let mut last = ReqError::Offline("unreachable".into());
        for d in self.devices_of(peer) {
            match self.request_dev(&d, req).await {
                Err(ReqError::Offline(e)) => last = ReqError::Offline(e),
                other => return other,
            }
        }
        Err(last)
    }

    /// Tells every device of someone (their PC and their phone), at the same time. Ok if any of them took it.
    async fn request_all(self: &Arc<Self>, peer: &str, req: &Req) -> Result<Value, ReqError> {
        let devs = self.devices_of(peer);
        if devs.len() <= 1 {
            return self.request(peer, req).await;
        }
        let tasks: Vec<_> = devs
            .into_iter()
            .map(|d| {
                let (me, req) = (self.clone(), req.clone());
                tauri::async_runtime::spawn(async move { me.request_dev(&d, &req).await })
            })
            .collect();
        let mut out = Err(ReqError::Offline("unreachable".into()));
        for t in tasks {
            match (t.await, &out) {
                (_, Ok(_)) => {}
                (Ok(Ok(v)), _) => out = Ok(v),
                (Ok(Err(ReqError::Refused(e))), _) => out = Err(ReqError::Refused(e)),
                _ => {}
            }
        }
        out
    }

    /// Asks one device.
    async fn request_dev(self: &Arc<Self>, peer: &str, req: &Req) -> Result<Value, ReqError> {
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
                write_frame(&mut send, &self.wrap(req)).await?;
                send.finish().map_err(e2s)?;
                read_frame::<Value>(&mut recv).await
            };
            let limit = Duration::from_secs(if cached && attempt == 0 { 10 } else { 30 });
            let failure = match tokio::time::timeout(limit, exchange).await {
                Ok(Ok(v)) => {
                    self.dev_seen.lock().unwrap().insert(peer.to_string(), Instant::now());
                    let acct = self.account_of(peer);
                    self.mark_seen(&acct);
                    if let Some(p) = v["proto"].as_u64() {
                        self.note_proto(&acct, p as u32);
                    }
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
                me.dev_seen.lock().unwrap().insert(p.clone(), Instant::now());
                me.mark_seen(&me.account_of(&p));
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

    async fn handle(self: Arc<Self>, dev: String, mut send: SendStream, mut recv: RecvStream) {
        let Ok(raw) = read_frame::<Value>(&mut recv).await else { return };
        let Ok(req) = serde_json::from_value::<Req>(raw) else {
            // Something a newer UaN sent: say so, so the sender doesn't keep retrying.
            let _ = write_frame(&mut send, &json!({ "ok": false, "error": "This needs a newer version of UaN." })).await;
            let _ = send.finish();
            return;
        };
        let (peer, req) = match self.open_dev(&dev, req) {
            Ok(x) => x,
            Err(e) => {
                let _ = write_frame(&mut send, &json!({ "ok": false, "error": e })).await;
                let _ = send.finish();
                return;
            }
        };
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
        if let Req::LinkGet { proof, name, part } = &req {
            let resp = self.link_serve(&dev, proof, name, *part).unwrap_or_else(|e| json!({ "ok": false, "error": e }));
            let _ = write_frame(&mut send, &resp).await;
            let _ = send.finish();
            return;
        }
        let copy = (peer != self.me_s && Self::mirrorable(&req)).then(|| req.clone());
        let resp = match self.on_request(&peer, req) {
            Ok(v) => {
                // Our other devices get it too, in case this friend doesn't know them yet.
                if let Some(r) = copy {
                    self.mirror(&peer, "", &r);
                }
                v
            }
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
        // To each of their devices (their PC, their phone), so it arrives wherever they are.
        for d in self.devices_of(peer) {
            let _ = self.db.lock().unwrap().execute(
                "INSERT INTO outbox (peer, payload, created_at) VALUES (?1, ?2, ?3)",
                params![d, payload, now()],
            );
            tauri::async_runtime::spawn(self.clone().flush(d));
        }
    }

    async fn flush(self: Arc<Self>, peer: String) {
        if !self.flushing.lock().unwrap().insert(peer.clone()) {
            return;
        }
        let mut after = i64::MIN;
        loop {
            let row: Option<(i64, String, i64)> = self
                .db
                .lock()
                .unwrap()
                .query_row("SELECT seq, payload, created_at FROM outbox WHERE peer = ?1 AND seq > ?2 ORDER BY seq LIMIT 1", params![peer, after], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .optional()
                .unwrap_or(None);
            let Some((seq, payload, created)) = row else { break };
            after = seq;
            let delivered = match serde_json::from_str::<Req>(&payload) {
                Ok(req) if Self::mailbox_ok(&req) => match self.request_dev(&peer, &req).await {
                    // Too big for the mailbox: wait until they are online, without holding up the rest.
                    Err(ReqError::Offline(_)) if payload.len() > 200_000 => false,
                    Err(ReqError::Offline(_)) => {
                        self.blob_send(&peer, &req).await;
                        if self.mailbox_send(&peer, &req).await.is_err() {
                            break; // keep the order of messages: try again later
                        }
                        true
                    }
                    // Their UaN is older and can't take it yet: keep it until they update.
                    Err(ReqError::Refused(e)) if e.contains("newer version") => false,
                    _ => true,
                },
                // Things only a direct connection can carry (group history, …): wait until the peer is online
                // with a version that understands them, without holding up the messages behind.
                Ok(req) => {
                    if now() - created > 7 * 24 * 3600 * 1000 {
                        true
                    } else if !self.speaks(&peer, 2) && {
                        // Don't know their version yet: ask (the answer tells us).
                        let _ = self.request_dev(&peer, &self.ping_req()).await;
                        !self.speaks(&peer, 2)
                    } {
                        false
                    } else {
                        match self.request_dev(&peer, &req).await {
                            Err(ReqError::Offline(_)) => false,
                            Err(ReqError::Refused(e)) if e == "later" => false,
                            _ => true,
                        }
                    }
                }
                Err(_) => true,
            };
            if delivered {
                let _ = self.db.lock().unwrap().execute("DELETE FROM outbox WHERE seq = ?1", [seq]);
            }
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
            if tick % 10 == 7 {
                // Watch together: keep inviting until the person has joined or said no (an invite that got
                // lost on the way, or reached only one of their devices, would otherwise never arrive).
                let mine: Vec<Party> = self.parties.lock().unwrap().values().filter(|p| p.leader == self.me_s && p.state != "ended").cloned().collect();
                for p in mine {
                    for m in p.members.iter().filter(|m| m.id != self.me_s && !m.joined && !m.left) {
                        self.send_party(&p, &m.id);
                    }
                }
            }
            if tick == 3 || tick % 30 == 15 {
                let me = self.clone();
                tauri::async_runtime::spawn(async move { me.mailbox_poll().await });
            }
            if tick % 3 == 1 {
                self.tell_watching();
            }
            if tick % 60 == 2 {
                // Ping friends and group members (each of their devices) to show who is online,
                // and our own other devices.
                let ping = self.ping_req();
                let mut targets: Vec<(String, String)> = Vec::new();
                for p in self.known_peers() {
                    for d in self.devices_of(&p) {
                        targets.push((p.clone(), d));
                    }
                }
                for d in self.devices_of(&self.me_s) {
                    targets.push((self.me_s.clone(), d));
                }
                for (p, d) in targets {
                    let me = self.clone();
                    let ping = ping.clone();
                    tauri::async_runtime::spawn(async move {
                        let was = me.is_online(&p);
                        match me.request_dev(&d, &ping).await {
                            Ok(v) => {
                                me.learn_devs(&p, &v["devs"]);
                                if p == me.me_s {
                                    return;
                                }
                                if let Some(n) = v["name"].as_str() {
                                    me.update_name(&p, n);
                                }
                                me.note_profile(&p, v["status"].as_str().unwrap_or(""), v["pv"].as_i64().unwrap_or(0));
                                me.note_proto(&p, v["proto"].as_u64().unwrap_or(0) as u32);
                                me.note_mode(&p, v["mode"].as_str().unwrap_or(""));
                            }
                            Err(_) => {
                                if was && !me.is_online(&p) && p != me.me_s {
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
        let ok = json!({ "ok": true, "proto": PROTO });
        let pong = || json!({ "ok": true, "name": self.my_name(), "status": self.kv("status").unwrap_or_default(), "pv": self.my_pv(), "proto": PROTO, "mode": self.my_mode(), "devs": self.my_certs() });
        // From our own other device (the PC this phone is signed in to, or the other way round).
        if peer == self.me_s {
            return match req {
                Req::Ping { devs, .. } => {
                    for d in devs.iter().take(8) {
                        self.learn_dev(&self.me_s, &d.id, &d.cert, &d.name);
                    }
                    Ok(pong())
                }
                Req::Mirror { from, chat, req } => {
                    if matches!(*req, Req::Mirror { .. } | Req::Dev { .. } | Req::LinkGet { .. }) {
                        Err("Not allowed.".into())
                    } else if from == self.me_s {
                        self.apply_own(&chat, *req)
                    } else {
                        self.on_request(&from, *req)
                    }
                }
                Req::Devices { devs } => {
                    for d in devs.iter().take(8) {
                        self.learn_dev(&self.me_s, &d.id, &d.cert, &d.name);
                    }
                    Ok(ok)
                }
                Req::BioImage => Ok(json!({ "ok": true, "img": self.kv("bioimg") })),
                Req::Profile => {
                    let p = self.my_profile();
                    Ok(json!({ "ok": true, "name": self.my_name(), "status": p["status"], "avatar": p["avatar"], "pv": p["pv"], "bio": p["bio"], "banner": p["banner"], "look": p["look"], "bioimg_v": p["bioimgV"], "joined": p["joined"] }))
                }
                _ => Err("Not allowed.".into()),
            };
        }
        match req {
            Req::Ping { name, status, pv, proto, mode, watching, devs } => {
                self.note_watching(peer, &watching);
                for d in devs.iter().take(8) {
                    self.learn_dev(peer, &d.id, &d.cert, &d.name);
                }
                self.update_name(peer, &name);
                self.note_profile(peer, &status, pv);
                self.note_proto(peer, proto);
                self.note_mode(peer, &mode);
                Ok(pong())
            }
            Req::Devices { devs } => {
                for d in devs.iter().take(8) {
                    self.learn_dev(peer, &d.id, &d.cert, &d.name);
                }
                Ok(ok)
            }
            Req::Dev { .. } | Req::Mirror { .. } | Req::MyProfile { .. } | Req::LinkGet { .. } => Err("Not allowed.".into()),
            Req::BioImage => {
                if !self.known_peers().iter().any(|p| p == peer) {
                    return Err("Not allowed.".into());
                }
                Ok(json!({ "ok": true, "img": self.kv("bioimg") }))
            }
            Req::Profile => {
                if !self.known_peers().iter().any(|p| p == peer) {
                    return Err("Not allowed.".into());
                }
                let p = self.my_profile();
                Ok(json!({ "ok": true, "name": self.my_name(), "status": p["status"], "avatar": p["avatar"], "pv": p["pv"], "bio": p["bio"], "banner": p["banner"], "look": p["look"], "bioimg_v": p["bioimgV"], "joined": p["joined"] }))
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
                if msg.reply.as_ref().is_some_and(|r| r.id.len() > 64) {
                    return Err("Invalid message.".into());
                }
                if msg.sealed.as_ref().is_some_and(|s| s.len() > 200_000) || msg.channel.as_ref().is_some_and(|c| c.len() > 64 || c.contains('#')) {
                    return Err("Invalid message.".into());
                }
                let chat = match &msg.group {
                    Some(g) => {
                        if !self.is_member(g, peer) || !self.is_member(g, &self.me_s) {
                            return Err("You are not in that group.".into());
                        }
                        chat_id(g, msg.channel.as_deref())
                    }
                    None => {
                        if self.contact_status(peer).as_deref() != Some("friend") {
                            return Err("You are not friends.".into());
                        }
                        peer.to_string()
                    }
                };
                let name: String = msg.name.chars().take(32).collect();
                let reply = msg.reply.as_ref().map(|r| ReplyRef { id: r.id.chars().take(64).collect(), name: r.name.chars().take(32).collect(), text: r.text.chars().take(200).collect() });
                let inserted = self.store_message(&msg.id, &chat, peer, &name, text.as_deref(), msg.file.as_ref(), msg.ts, msg.sealed.as_deref(), reply.as_ref());
                if inserted {
                    self.update_name(peer, &name);
                    if let Some(f) = &msg.file {
                        let (on, gb) = self.autodl();
                        if on && f.size <= gb.saturating_mul(1024 * 1024 * 1024) && self.local_copy(f).is_none() {
                            let _ = self.download_into(f.clone(), chat.clone(), true);
                        }
                    }
                    let body = match (&msg.file, &text) {
                        (Some(f), _) => format!("Sent a file: {}", f.name),
                        (None, Some(t)) => t.chars().take(120).collect(),
                        _ => "New message".into(),
                    };
                    let title = match &msg.group {
                        Some(g) => format!("{} · {}", name, self.group_name(g)),
                        None => name.clone(),
                    };
                    // Muted chats stay quiet, unless you are @mentioned (or someone answers you).
                    let mentioned = text.as_deref().is_some_and(|t| self.mentions_me(t) || (msg.group.is_some() && mentions_everyone(t))) || msg.reply.as_ref().is_some_and(|r| self.is_my_message(&r.id));
                    if !self.is_muted(&chat) || mentioned {
                        self.notify(if mentioned && msg.group.is_some() { &title } else { &title }, &body);
                    }
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
                // The owner changes anything; a co-owner changes members, name, channels and picture,
                // but not who owns the group or who the co-owners are.
                let stored = existing.as_ref().and_then(|_| self.load_group(&group.id));
                let allowed = match (&existing, &stored) {
                    (Some((owner, version)), Some(old)) => {
                        group.version > *version
                            && group.owner == *owner
                            && (owner == peer || (old.admins.iter().any(|a| a == peer) && group.admins == old.admins))
                    }
                    (Some((owner, version)), None) => owner == peer && group.version > *version,
                    (None, _) => group.owner == peer,
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
            Req::Edit { msg_id, text, sealed } => {
                if text.as_ref().is_some_and(|t| t.chars().count() > 5000) || sealed.as_ref().is_some_and(|s| s.len() > 200_000) {
                    return Err("Invalid edit.".into());
                }
                let chat: Option<String> = self
                    .db
                    .lock()
                    .unwrap()
                    .query_row("SELECT chat FROM messages WHERE id = ?1 AND sender = ?2", [&msg_id, peer], |r| r.get(0))
                    .optional()
                    .ok()
                    .flatten();
                if let Some(chat) = chat {
                    self.apply_edit(&chat, &msg_id, text.as_deref(), sealed.as_deref());
                }
                Ok(ok)
            }
            Req::React { group, channel, msg_id, emoji } => {
                let chat = self.chat_of(peer, group.as_deref())?;
                let chat = match (&group, &channel) {
                    (Some(g), Some(c)) => chat_id(g, Some(c)),
                    _ => chat,
                };
                self.apply_react(&chat, &msg_id, peer, &emoji);
                Ok(ok)
            }
            Req::Pin { group, channel, msg_id, pinned } => {
                let chat = self.chat_of(peer, group.as_deref())?;
                let chat = match (&group, &channel) {
                    (Some(g), Some(c)) => chat_id(g, Some(c)),
                    _ => chat,
                };
                self.apply_pin(&chat, &msg_id, peer, pinned);
                Ok(ok)
            }
            Req::PartyQueue { party_id, file } => {
                let ok_member = self.parties.lock().unwrap().get(&party_id).is_some_and(|p| p.leader == self.me_s && p.members.iter().any(|m| m.id == peer));
                if !ok_member || file.size > MAX_FILE_SIZE {
                    return Err("Not allowed.".into());
                }
                self.queue_local(&party_id, file);
                Ok(ok)
            }
            Req::Unsend { msg_id } => {
                // Only the person who sent a message can delete it for everyone.
                if let Some((_, _, Some(f))) = self.remove_message(&msg_id, Some(peer)) {
                    self.forget_file(&f.id);
                }
                Ok(ok)
            }
            Req::History { group_id, msgs } => {
                match self.load_group(&group_id) {
                    None => return Err("later".into()), // the group itself hasn't arrived yet
                    Some(g) if !g.manager(peer) => return Err("Not allowed.".into()),
                    _ => {}
                }
                if !self.is_member(&group_id, &self.me_s) || msgs.len() > 200 {
                    return Err("Not allowed.".into());
                }
                let chat = format!("g:{group_id}");
                {
                    // Earlier messages go before everything we already have (chunks arrive newest first).
                    let db = self.db.lock().unwrap();
                    let min: i64 = db.query_row("SELECT COALESCE(MIN(seq), 1) FROM messages", [], |r| r.get(0)).unwrap_or(1);
                    let base = min.min(1) - msgs.len() as i64 - 1;
                    for (i, m) in msgs.iter().enumerate() {
                        if m.file.as_ref().is_some_and(|f| f.size > MAX_FILE_SIZE) {
                            continue;
                        }
                        let text = m.text.as_ref().map(|t| t.chars().take(5000).collect::<String>());
                        let name: String = m.name.chars().take(32).collect();
                        let file_json = m.file.as_ref().map(|f| serde_json::to_string(f).unwrap());
                        let reply_json = m.reply.as_ref().map(|r| serde_json::to_string(r).unwrap());
                        let _ = db.execute(
                            "INSERT OR IGNORE INTO messages (seq, id, chat, sender, sender_name, text, file, ts, sealed, reply) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                            params![base + i as i64, m.id, chat_id(&group_id, m.channel.as_deref()), m.sender, name, text, file_json, m.ts, m.sealed, reply_json],
                        );
                        if m.sealed.as_ref().is_some_and(|s| s.len() > 200_000) || m.channel.as_ref().is_some_and(|c| c.len() > 64 || c.contains('#')) {
                            continue;
                        }
                        if let (Some(f), Some(t)) = (&m.file, &m.thumb) {
                            if t.len() <= 300_000 && t.starts_with('{') {
                                let _ = db.execute("INSERT OR IGNORE INTO thumbs (file_id, data) VALUES (?1, ?2)", [&f.id, t]);
                            }
                        }
                    }
                }
                self.emit("history", json!({ "chat": chat }));
                Ok(ok)
            }
            Req::ModDelete { group_id, msg_id } => {
                if !self.load_group(&group_id).is_some_and(|g| g.manager(peer)) {
                    return Err("Not allowed.".into());
                }
                let in_group: Option<String> = self.db.lock().unwrap().query_row("SELECT chat FROM messages WHERE id = ?1", [&msg_id], |r| r.get(0)).optional().ok().flatten();
                if in_group.as_deref().and_then(split_chat).is_some_and(|(g, _)| g == group_id) {
                    if let Some((_, from, Some(f))) = self.remove_message(&msg_id, None) {
                        if from != self.me_s {
                            self.forget_file(&f.id);
                        }
                    }
                }
                Ok(ok)
            }
            Req::ClearGroup { group_id, before, channel } => {
                if !self.load_group(&group_id).is_some_and(|g| g.manager(peer)) {
                    return Err("Not allowed.".into());
                }
                let chat = chat_id(&group_id, channel.as_deref());
                let files: Vec<String> = {
                    let db = self.db.lock().unwrap();
                    let mut stmt = db
                        .prepare("SELECT json_extract(file, '$.id') FROM messages WHERE chat = ?1 AND ts <= ?2 AND file IS NOT NULL AND sender <> ?3")
                        .map_err(e2s)?;
                    let rows = stmt.query_map(params![chat, before, self.me_s], |r| r.get::<_, Option<String>>(0)).map_err(e2s)?;
                    rows.filter_map(Result::ok).flatten().collect()
                };
                self.clear_local(&chat, before);
                for f in files {
                    self.forget_file(&f);
                }
                Ok(ok)
            }
            Req::ChannelAdd { group_id, channel } => {
                if self.group_owner(&group_id).as_deref() != Some(self.me_s.as_str()) || !self.is_member(&group_id, peer) {
                    return Err("Not allowed.".into());
                }
                self.add_channel_local(&group_id, channel)?;
                Ok(ok)
            }
            Req::GroupInvite { group_id, members } => {
                if self.group_owner(&group_id).as_deref() != Some(self.me_s.as_str()) || !self.is_member(&group_id, peer) {
                    return Err("Not allowed.".into());
                }
                let current = self.load_group(&group_id).map(|g| g.members).unwrap_or_default();
                let fresh: Vec<Member> = members
                    .into_iter()
                    .filter(|m| parse_id(&m.id).is_ok() && !current.iter().any(|c| c.id == m.id))
                    .take(100usize.saturating_sub(current.len()))
                    .collect();
                self.add_members(&group_id, &fresh);
                Ok(ok)
            }
            Req::Typing { group, channel } => {
                let chat = self.chat_of(peer, group.as_deref())?;
                let chat = match (&group, &channel) {
                    (Some(g), Some(c)) => chat_id(g, Some(c)),
                    _ => chat,
                };
                let name = self.peer_name(peer);
                self.emit("typing", json!({ "chat": chat, "who": peer, "name": name }));
                Ok(ok)
            }
            Req::Seen { group, channel, msg_id } => {
                let chat = self.chat_of(peer, group.as_deref())?;
                let chat = match (&group, &channel) {
                    (Some(g), Some(c)) => chat_id(g, Some(c)),
                    _ => chat,
                };
                if msg_id.len() > 64 {
                    return Err("Bad message.".into());
                }
                let _ = self.db.lock().unwrap().execute(
                    "INSERT OR REPLACE INTO reads (chat, who, msg_id, ts) VALUES (?1, ?2, ?3, ?4)",
                    params![chat, peer, msg_id, now()],
                );
                self.emit("seen", json!({ "chat": chat, "who": peer, "msgId": msg_id }));
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
                let why = if !from_host {
                    Some("it isn't from the host")
                } else if !party.members.iter().any(|m| m.id == self.me_s) {
                    Some("you aren't invited")
                } else if !self.is_member(&party.group, &self.me_s) {
                    Some("you aren't in that group on this PC")
                } else if !self.is_member(&party.group, peer) {
                    Some("the host isn't in that group on this PC")
                } else {
                    None
                };
                if let Some(why) = why {
                    self.log(&format!("party {} from {}: refused, {why}", &party.id[..party.id.len().min(8)], &peer[..peer.len().min(8)]));
                    return Err(format!("Not allowed: {why}."));
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
                let old_file = self.parties.lock().unwrap().get(&party.id).map(|p| p.file.id.clone());
                if party.state == "ended" {
                    self.parties.lock().unwrap().remove(&party.id);
                    self.stop_stream(&party.file.id);
                } else {
                    self.parties.lock().unwrap().insert(party.id.clone(), party.clone());
                    // Next film of the playlist: load it the same way (stream, or download first).
                    if old_file.as_ref().is_some_and(|f| *f != party.file.id) && party.members.iter().any(|m| m.id == self.me_s && m.joined && !m.left) {
                        if let Some(f) = &old_file {
                            self.stop_stream(f);
                        }
                        let full = self.full_parties.lock().unwrap().contains(&party.id);
                        let chat = format!("g:{}", party.group);
                        if full {
                            let _ = self.download_into(party.file.clone(), chat, true);
                        } else {
                            let _ = self.start_stream(party.file.clone(), chat);
                        }
                        self.party_report(&party.id, None, false);
                    }
                }
                let _ = self.app.emit("party", &party);
                if is_new && party.state != "ended" {
                    let from = party.members.iter().find(|m| m.id == peer).map(|m| m.name.clone()).unwrap_or_default();
                    self.notify(&format!("{} · {}", from, self.group_name(&party.group)), &format!("Invited you to watch {} together", party.file.name));
                }
                Ok(ok)
            }
            Req::PartyReport { party_id, have, joined, left, ready, buffering, full } => {
                let leads = self.parties.lock().unwrap().get(&party_id).map(|p| p.leader == self.me_s).unwrap_or(false);
                if !leads {
                    return Err("Not the host.".into());
                }
                self.apply_report(&party_id, peer, have, joined, left, ready, buffering, full);
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
            Req::Thumb { file_id, data } => {
                if data.len() > 300_000 || !data.starts_with('{') {
                    return Err("Bad preview.".into());
                }
                let theirs = self
                    .db
                    .lock()
                    .unwrap()
                    .query_row(
                        "SELECT 1 FROM messages WHERE json_extract(file, '$.id') = ?1 AND json_extract(file, '$.owner') = ?2 LIMIT 1",
                        [&file_id, peer],
                        |_| Ok(()),
                    )
                    .optional()
                    .ok()
                    .flatten()
                    .is_some();
                if theirs {
                    let _ = self.db.lock().unwrap().execute("INSERT OR REPLACE INTO thumbs (file_id, data) VALUES (?1, ?2)", [&file_id, &data]);
                    self.emit("thumb", json!({ "fileId": file_id, "thumb": serde_json::from_str::<Value>(&data).unwrap_or(Value::Null) }));
                }
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

    #[allow(clippy::too_many_arguments)]
    fn store_message(&self, id: &str, chat: &str, sender: &str, name: &str, text: Option<&str>, file: Option<&FileMeta>, ts: i64, sealed: Option<&str>, reply: Option<&ReplyRef>) -> bool {
        let file_json = file.map(|f| serde_json::to_string(f).unwrap());
        let reply_json = reply.map(|r| serde_json::to_string(r).unwrap());
        let n = self
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT OR IGNORE INTO messages (id, chat, sender, sender_name, text, file, ts, sealed, reply) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![id, chat, sender, name, text, file_json, ts, sealed, reply_json],
            )
            .unwrap_or(0);
        if n > 0 {
            let mut m = json!({ "id": id, "chat": chat, "sender": sender, "senderName": name, "text": text, "file": file, "ts": ts, "mine": sender == self.me_s, "reply": reply });
            if let Some(sl) = sealed {
                self.open_sealed(chat, sl, &mut m);
            }
            self.emit("message", m);
        }
        n > 0
    }

    /// Fills in text/file of a locked-channel message if we know the channel's password, else marks it locked.
    fn open_sealed(&self, chat: &str, sealed: &str, m: &mut Value) {
        let key = self.kv(&format!("chkey:{chat}")).and_then(|k| HEXLOWER.decode(k.as_bytes()).ok()).and_then(|k| <[u8; 32]>::try_from(k).ok());
        match key.and_then(|k| open_with(&k, sealed)).and_then(|p| serde_json::from_slice::<Value>(&p).ok()) {
            Some(inner) => {
                m["text"] = inner["text"].clone();
                m["file"] = inner["file"].clone();
                if !inner["reply"].is_null() {
                    m["reply"] = inner["reply"].clone();
                }
            }
            None => m["locked"] = json!(true),
        }
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
        let (name, owner, version, channels, admins, avatar): (String, String, i64, Option<String>, Option<String>, Option<String>) = db
            .query_row("SELECT name, owner, version, channels, admins, avatar FROM groups WHERE id = ?1", [g], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
            .optional()
            .ok()
            .flatten()?;
        let channels: Vec<Channel> = channels.and_then(|c| serde_json::from_str(&c).ok()).unwrap_or_default();
        let admins: Vec<String> = admins.and_then(|c| serde_json::from_str(&c).ok()).unwrap_or_default();
        let mut stmt = db.prepare("SELECT member_id, name FROM group_members WHERE group_id = ?1 ORDER BY name").ok()?;
        let members = stmt
            .query_map([g], |r| Ok(Member { id: r.get(0)?, name: r.get(1)? }))
            .ok()?
            .filter_map(Result::ok)
            .collect();
        Some(WireGroup { id: g.to_string(), name, owner, version, members, channels, admins, avatar })
    }

    fn save_group(&self, g: &WireGroup) {
        {
            let db = self.db.lock().unwrap();
            let _ = db.execute(
                "INSERT INTO groups (id, name, owner, version, channels, admins, avatar) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, owner = excluded.owner, version = excluded.version, channels = excluded.channels,
                   admins = excluded.admins, avatar = excluded.avatar",
                params![
                    g.id,
                    g.name,
                    g.owner,
                    g.version,
                    serde_json::to_string(&g.channels).unwrap(),
                    serde_json::to_string(&g.admins).unwrap(),
                    g.avatar.as_deref().filter(|a| a.starts_with("data:image/") && a.len() <= 160_000)
                ],
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
        self.mirror(&self.me_s.clone(), "", &req);
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
        let group = WireGroup { id: new_id(), name: name.to_string(), owner: self.me_s.clone(), version: 1, members, channels: vec![], admins: vec![], avatar: None };
        self.save_group(&group);
        let req = Req::Group { group: group.clone() };
        self.mirror(&self.me_s.clone(), "", &req);
        for m in &group.members {
            self.deliver(&m.id, &req);
        }
        Ok(group.id)
    }

    pub fn group_action(self: &Arc<Self>, g: &str, action: &str, ids: &[String], name: &str) -> Result<(), String> {
        let group = self.load_group(g).ok_or("That group no longer exists.")?;
        let owner = group.owner == self.me_s;
        let manager = group.manager(&self.me_s);
        match action {
            "delete" | "admin" | "unadmin" if !owner => Err("Only the group's owner can do that.".into()),
            "remove" | "rename" | "picture" if !manager => Err("Only the group's owner or a co-owner can do that.".into()),
            "admin" | "unadmin" => {
                let mut group = group;
                for id in ids.iter().filter(|id| **id != group.owner && group.members.iter().any(|m| m.id == **id)) {
                    group.admins.retain(|a| a != id);
                    if action == "admin" {
                        group.admins.push(id.clone());
                    }
                }
                self.save_group(&group);
                self.bump_and_broadcast(g, &[]);
                Ok(())
            }
            "picture" => {
                let pic = name.trim();
                if !pic.is_empty() && (!pic.starts_with("data:image/") || pic.len() > 160_000) {
                    return Err("That picture is too big.".into());
                }
                let mut group = group;
                group.avatar = (!pic.is_empty()).then(|| pic.to_string());
                self.save_group(&group);
                self.bump_and_broadcast(g, &[]);
                Ok(())
            }
            "add" => {
                let fresh: Vec<Member> = ids
                    .iter()
                    .filter(|id| !group.members.iter().any(|m| m.id == **id))
                    .filter_map(|id| self.friend_name(id).map(|n| Member { id: id.clone(), name: n }))
                    .collect();
                if fresh.is_empty() {
                    return Ok(());
                }
                if manager {
                    self.add_members(g, &fresh);
                } else {
                    // The creator's PC keeps the member list: it adds them as soon as it is online.
                    self.deliver(&group.owner, &Req::GroupInvite { group_id: g.to_string(), members: fresh });
                }
                Ok(())
            }
            "remove" => {
                {
                    let db = self.db.lock().unwrap();
                    // A co-owner can't remove the owner or another co-owner.
                    for id in ids.iter().filter(|id| **id != self.me_s && **id != group.owner && (owner || !group.admins.contains(id))) {
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
                self.mirror(&self.me_s.clone(), "", &Req::GroupLeave { group_id: g.to_string() });
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
        if peer.to_string() == self.me_s || peer == self.me {
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
        self.mirror(&self.me_s.clone(), &p, &Req::FriendRequest { name: "Pending…".into() });
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
                self.mirror(&self.me_s.clone(), peer, &Req::FriendAccept { name: name.clone() });
                self.deliver(peer, &Req::FriendAccept { name: self.my_name() });
                Ok(())
            }
            "remove" => {
                let _ = self.db.lock().unwrap().execute("DELETE FROM contacts WHERE id = ?1", [peer]);
                for d in self.devices_of(peer) {
                    let _ = self.db.lock().unwrap().execute("DELETE FROM outbox WHERE peer = ?1", [&d]);
                }
                self.mirror(&self.me_s.clone(), peer, &Req::FriendRemove);
                self.deliver(peer, &Req::FriendRemove);
                self.emit("contacts", Value::Null);
                Ok(())
            }
            _ => Err("Unknown action.".into()),
        }
    }

    pub fn contacts(&self) -> Value {
        let my_mode = self.my_mode(); // (reads the database, so before it is locked below)
        let db = self.db.lock().unwrap();
        let mut stmt = db
            .prepare("SELECT c.id, c.name, c.status, (SELECT MAX(ts) FROM messages WHERE chat = c.id), p.avatar, p.status, p.bio, p.joined, c.created_at, p.banner, p.look FROM contacts c LEFT JOIN profiles p ON p.id = c.id ORDER BY c.name")
            .unwrap();
        #[allow(clippy::type_complexity)]
        let rows: Vec<(String, String, String, Option<i64>, Option<String>, Option<String>, Option<String>, Option<i64>, Option<i64>, Option<String>, Option<String>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        let (mut friends, mut incoming, mut outgoing) = (vec![], vec![], vec![]);
        for (id, name, status, last, avatar, mood, bio, joined, since, banner, look) in rows {
            let item = json!({ "id": id, "name": name, "online": self.is_online(&id), "mode": self.mode_of(&id), "lastAt": last, "avatar": avatar, "status": mood.unwrap_or_default(), "bio": bio.unwrap_or_default(), "joined": joined, "since": since, "banner": banner, "look": look.unwrap_or_default(), "watching": self.watching_of(&id) });
            match status.as_str() {
                "friend" => friends.push(item),
                "incoming" => incoming.push(item),
                "outgoing" => outgoing.push(item),
                _ => {}
            }
        }
        let mut stmt = db
            .prepare("SELECT id, name, owner, (SELECT MAX(ts) FROM messages WHERE chat = 'g:' || groups.id OR chat LIKE 'g:' || groups.id || '#%'), channels, admins, avatar FROM groups")
            .unwrap();
        #[allow(clippy::type_complexity)]
        let groups_raw: Vec<(String, String, String, Option<i64>, Option<String>, Option<String>, Option<String>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        let mut groups = vec![];
        for (id, name, owner, last, channels, admins, gavatar) in groups_raw {
            let admins: Vec<String> = admins.and_then(|a| serde_json::from_str(&a).ok()).unwrap_or_default();
            let channels: Vec<Channel> = channels.and_then(|c| serde_json::from_str(&c).ok()).unwrap_or_default();
            let channels: Vec<Value> = channels
                .iter()
                .map(|c| {
                    let chat = chat_id(&id, Some(&c.id));
                    // (the database is already locked here, so read the key through it)
                    let unlocked = c.check.is_some()
                        && db.query_row("SELECT 1 FROM kv WHERE k = ?1", [format!("chkey:{chat}")], |_| Ok(())).optional().ok().flatten().is_some();
                    json!({ "id": c.id, "name": c.name, "chat": chat, "locked": c.check.is_some(), "unlocked": unlocked })
                })
                .collect();
            let mut ms = db
                .prepare("SELECT m.member_id, m.name, p.avatar, p.status, p.bio, p.joined, p.banner, p.look FROM group_members m LEFT JOIN profiles p ON p.id = m.member_id WHERE m.group_id = ?1 ORDER BY m.name")
                .unwrap();
            let members: Vec<Value> = ms
                .query_map([&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, Option<i64>>(5)?, r.get::<_, Option<String>>(6)?, r.get::<_, Option<String>>(7)?)))
                .unwrap()
                .filter_map(Result::ok)
                .map(|(mid, mname, avatar, mood, bio, joined, banner, look)| json!({ "id": mid, "name": mname, "online": mid == self.me_s || self.is_online(&mid), "mode": if mid == self.me_s { my_mode.clone() } else { self.mode_of(&mid) }, "avatar": avatar, "status": mood.unwrap_or_default(), "bio": bio.unwrap_or_default(), "joined": joined, "banner": banner, "look": look.unwrap_or_default(), "watching": self.watching_of(&mid) }))
                .collect();
            groups.push(json!({ "id": id, "name": name, "owner": owner, "admins": admins, "avatar": gavatar, "members": members, "lastAt": last, "channels": channels }));
        }
        json!({ "friends": friends, "incoming": incoming, "outgoing": outgoing, "groups": groups })
    }

    // ----- Messages -----

    pub fn messages(&self, chat: &str, limit: usize) -> Vec<Value> {
        let db = self.db.lock().unwrap();
        let mut stmt = db
            .prepare("SELECT id, chat, sender, sender_name, text, file, ts, (SELECT data FROM thumbs WHERE thumbs.file_id = json_extract(messages.file, '$.id')), sealed, reply, edited, EXISTS (SELECT 1 FROM pins WHERE pins.chat = messages.chat AND pins.msg_id = messages.id) FROM messages WHERE chat = ?1 ORDER BY seq DESC LIMIT ?2")
            .unwrap();
        let mut rows: Vec<(Value, Option<String>)> = stmt
            .query_map(params![chat, limit.clamp(1, 20000) as i64], |r| {
                let sender: String = r.get(2)?;
                let file: Option<String> = r.get(5)?;
                Ok((json!({
                    "id": r.get::<_, String>(0)?,
                    "chat": r.get::<_, String>(1)?,
                    "sender": sender,
                    "senderName": r.get::<_, String>(3)?,
                    "text": r.get::<_, Option<String>>(4)?,
                    "file": file.and_then(|f| serde_json::from_str::<Value>(&f).ok()),
                    "ts": r.get::<_, i64>(6)?,
                    "thumb": r.get::<_, Option<String>>(7)?.and_then(|t| serde_json::from_str::<Value>(&t).ok()),
                    "mine": sender == self.me_s,
                    "reply": r.get::<_, Option<String>>(9)?.and_then(|t| serde_json::from_str::<Value>(&t).ok()),
                    "edited": r.get::<_, Option<i64>>(10)?.unwrap_or(0) == 1,
                    "pinned": r.get::<_, bool>(11)?,
                }), r.get::<_, Option<String>>(8)?))
            })
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        drop(stmt);
        drop(db);
        rows.reverse();
        rows.into_iter()
            .map(|(mut m, sealed)| {
                if let Some(sl) = sealed {
                    self.open_sealed(chat, &sl, &mut m);
                }
                m
            })
            .collect()
    }

    /// Adds a channel to a group we created and tells everyone.
    fn add_channel_local(self: &Arc<Self>, g: &str, channel: Channel) -> Result<(), String> {
        let mut group = self.load_group(g).ok_or("That group no longer exists.")?;
        let name: String = channel.name.trim().trim_start_matches('#').chars().take(32).collect();
        if name.is_empty() || channel.id.is_empty() || channel.id.len() > 40 || channel.id.contains('#') {
            return Err("Give the channel a name.".into());
        }
        if group.channels.len() >= 50 || group.channels.iter().any(|c| c.id == channel.id) {
            return Ok(());
        }
        group.channels.push(Channel { id: channel.id, name, check: channel.check.filter(|c| c.len() <= 64) });
        self.save_group(&group);
        self.bump_and_broadcast(g, &[]);
        Ok(())
    }

    /// Creates a channel (the group's creator adds it; others ask the creator). With a password, it is locked.
    pub fn create_channel(self: &Arc<Self>, g: &str, name: &str, password: Option<&str>) -> Result<String, String> {
        let group = self.load_group(g).ok_or("That group no longer exists.")?;
        if !group.members.iter().any(|m| m.id == self.me_s) {
            return Err("You are not in that group.".into());
        }
        let name = name.trim().trim_start_matches('#').trim();
        if name.is_empty() || name.chars().count() > 32 {
            return Err("Give the channel a name (up to 32 characters).".into());
        }
        let id = new_id()[..12].to_string();
        let mut check = None;
        if let Some(pw) = password.map(str::trim).filter(|p| !p.is_empty()) {
            let key = channel_key(g, &id, pw);
            check = Some(key_check(&key));
            self.set_kv(&format!("chkey:{}", chat_id(g, Some(&id))), &HEXLOWER.encode(&key));
        }
        let channel = Channel { id: id.clone(), name: name.to_string(), check };
        if group.manager(&self.me_s) {
            self.add_channel_local(g, channel)?;
        } else {
            self.deliver(&group.owner, &Req::ChannelAdd { group_id: g.to_string(), channel });
        }
        Ok(chat_id(g, Some(&id)))
    }

    /// Renames or deletes a channel (the group's creator only).
    pub fn channel_action(self: &Arc<Self>, g: &str, channel: &str, action: &str, name: &str) -> Result<(), String> {
        let mut group = self.load_group(g).ok_or("That group no longer exists.")?;
        if !group.manager(&self.me_s) {
            return Err("Only the group's owner or a co-owner can do that.".into());
        }
        match action {
            "rename" => {
                let name: String = name.trim().trim_start_matches('#').trim().chars().take(32).collect();
                if name.is_empty() {
                    return Err("Give the channel a name.".into());
                }
                if let Some(c) = group.channels.iter_mut().find(|c| c.id == channel) {
                    c.name = name;
                }
            }
            "delete" => group.channels.retain(|c| c.id != channel),
            _ => return Err("Unknown action.".into()),
        }
        self.save_group(&group);
        self.bump_and_broadcast(g, &[]);
        Ok(())
    }

    /// Enters a locked channel: checks the password and remembers the key on this PC.
    pub fn unlock_channel(&self, chat: &str, password: &str) -> Result<(), String> {
        let (g, c) = split_chat(chat).ok_or("Not a channel.")?;
        let c = c.ok_or("Not a channel.")?;
        let group = self.load_group(g).ok_or("That group no longer exists.")?;
        let ch = group.channels.iter().find(|x| x.id == c).ok_or("That channel no longer exists.")?;
        let check = ch.check.as_deref().ok_or("This channel isn't locked.")?;
        let key = channel_key(g, c, password.trim());
        if key_check(&key) != check {
            return Err("Wrong password.".into());
        }
        self.set_kv(&format!("chkey:{chat}"), &HEXLOWER.encode(&key));
        self.emit("contacts", Value::Null);
        Ok(())
    }

    /// Locks a channel again on this PC (forgets its key).
    pub fn forget_channel(&self, chat: &str) {
        let _ = self.db.lock().unwrap().execute("DELETE FROM kv WHERE k = ?1", [format!("chkey:{chat}")]);
        self.emit("contacts", Value::Null);
    }

    // ----- Presence mode: online / away / do not disturb -----

    pub fn my_mode(&self) -> String {
        self.kv("mode").filter(|m| m == "away" || m == "dnd").unwrap_or_else(|| "online".into())
    }

    pub fn set_mode(self: &Arc<Self>, mode: &str) {
        let mode = if mode == "away" || mode == "dnd" { mode } else { "online" };
        self.set_kv("mode", mode);
        let req = self.ping_req();
        for p in self.known_peers() {
            if self.is_online(&p) {
                let (me, req) = (self.clone(), req.clone());
                tauri::async_runtime::spawn(async move {
                    let _ = me.request_all(&p, &req).await;
                });
            }
        }
    }

    fn note_mode(&self, peer: &str, mode: &str) {
        let mode = if mode == "away" || mode == "dnd" { mode } else { "online" };
        let before = self.modes.lock().unwrap().insert(peer.to_string(), mode.to_string());
        if before.as_deref() != Some(mode) {
            self.emit("presence", json!({ "id": peer, "online": self.is_online(peer), "mode": mode }));
        }
    }

    /// What we are watching together right now, for our friends' profile cards.
    fn my_watching(&self) -> String {
        let parties = self.parties.lock().unwrap();
        for p in parties.values() {
            if p.state == "ended" {
                continue;
            }
            let in_it = p.members.iter().any(|m| m.id == self.me_s && !m.left && (m.joined || p.leader == self.me_s));
            if !in_it {
                continue;
            }
            let film = p.file.name.rsplit(['/', '\\']).next().unwrap_or(&p.file.name).chars().take(120).collect::<String>();
            let with: Vec<String> = p.members.iter().filter(|m| m.id != self.me_s && !m.left && (m.joined || m.id == p.leader)).map(|m| m.name.chars().take(32).collect()).take(5).collect();
            return json!({ "film": film, "with": with }).to_string();
        }
        String::new()
    }

    fn note_watching(&self, peer: &str, w: &str) {
        let w: String = if w.len() <= 600 && (w.is_empty() || w.starts_with('{')) { w.to_string() } else { String::new() };
        let before = self.watching.lock().unwrap().insert(peer.to_string(), w.clone());
        if before.unwrap_or_default() != w {
            self.emit("contacts", Value::Null);
        }
    }

    pub fn watching_of(&self, peer: &str) -> String {
        if peer == self.me_s {
            return self.my_watching();
        }
        if !self.is_online(peer) {
            return String::new();
        }
        self.watching.lock().unwrap().get(peer).cloned().unwrap_or_default()
    }

    /// When what we watch changes, tell the friends who are online at once (not only at the next ping).
    fn tell_watching(self: &Arc<Self>) {
        let now_w = self.my_watching();
        {
            let mut told = self.watching_told.lock().unwrap();
            if *told == now_w {
                return;
            }
            *told = now_w;
        }
        let req = self.ping_req();
        for p in self.known_peers() {
            if self.is_online(&p) {
                let (me, req) = (self.clone(), req.clone());
                tauri::async_runtime::spawn(async move {
                    let _ = me.request_all(&p, &req).await;
                });
            }
        }
    }

    pub fn mode_of(&self, peer: &str) -> String {
        self.modes.lock().unwrap().get(peer).cloned().unwrap_or_else(|| "online".into())
    }

    // ----- Mute, @mentions -----

    pub fn is_muted(&self, chat: &str) -> bool {
        // Muting a group mutes its channels too.
        self.kv(&format!("mute:{chat}")).is_some()
            || split_chat(chat).is_some_and(|(g, c)| c.is_some() && self.kv(&format!("mute:g:{g}")).is_some())
    }

    pub fn set_mute(&self, chat: &str, on: bool) {
        if on {
            self.set_kv(&format!("mute:{chat}"), "1");
        } else {
            let _ = self.db.lock().unwrap().execute("DELETE FROM kv WHERE k = ?1", [format!("mute:{chat}")]);
        }
    }

    pub fn mutes(&self) -> Vec<String> {
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare("SELECT substr(k, 6) FROM kv WHERE k LIKE 'mute:%'").unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.filter_map(Result::ok).collect()
    }

    /// "@Name" anywhere in the text (not part of a longer word).
    fn mentions_me(&self, text: &str) -> bool {
        let me = format!("@{}", self.my_name().to_lowercase());
        let t = text.to_lowercase();
        let mut from = 0;
        while let Some(i) = t[from..].find(&me) {
            let end = from + i + me.len();
            if t[end..].chars().next().is_none_or(|c| !c.is_alphanumeric()) {
                return true;
            }
            from = end;
        }
        false
    }

    fn is_my_message(&self, id: &str) -> bool {
        self.db.lock().unwrap().query_row("SELECT 1 FROM messages WHERE id = ?1 AND sender = ?2", [id, &self.me_s], |_| Ok(())).optional().ok().flatten().is_some()
    }

    // ----- Editing -----

    fn channel_key_of(&self, chat: &str) -> Option<[u8; 32]> {
        self.kv(&format!("chkey:{chat}")).and_then(|k| HEXLOWER.decode(k.as_bytes()).ok()).and_then(|k| <[u8; 32]>::try_from(k).ok())
    }

    fn apply_edit(&self, chat: &str, id: &str, text: Option<&str>, sealed: Option<&str>) {
        let _ = self.db.lock().unwrap().execute(
            "UPDATE messages SET text = ?2, sealed = COALESCE(?3, sealed), edited = 1 WHERE id = ?1",
            params![id, text, sealed],
        );
        let mut m = json!({ "id": id, "chat": chat, "text": text, "edited": true });
        if let Some(sl) = sealed {
            self.open_sealed(chat, sl, &mut m);
        }
        self.emit("edited", m);
    }

    /// Changes the text of one of your messages, here and for everyone in the chat.
    pub fn edit_message(self: &Arc<Self>, id: &str, text: &str) -> Result<(), String> {
        let text: String = text.trim().chars().take(5000).collect();
        if text.is_empty() {
            return Err("Write something, or delete the message instead.".into());
        }
        let row: Option<(String, String, Option<String>)> = self
            .db
            .lock()
            .unwrap()
            .query_row("SELECT chat, sender, sealed FROM messages WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()
            .map_err(e2s)?;
        let Some((chat, sender, old_sealed)) = row else { return Err("That message is gone.".into()) };
        if sender != self.me_s {
            return Err("You can only edit your own messages.".into());
        }
        let (new_text, new_sealed) = match old_sealed {
            Some(old) => {
                let key = self.channel_key_of(&chat).ok_or("Unlock this channel with its password first.")?;
                let mut inner: Value = open_with(&key, &old).and_then(|p| serde_json::from_slice(&p).ok()).unwrap_or(json!({}));
                inner["text"] = json!(text);
                (None, Some(seal_with(&key, &serde_json::to_vec(&inner).map_err(e2s)?)?))
            }
            None => (Some(text), None),
        };
        self.apply_edit(&chat, id, new_text.as_deref(), new_sealed.as_deref());
        self.mirror(&self.me_s.clone(), &chat, &Req::Edit { msg_id: id.to_string(), text: new_text.clone(), sealed: new_sealed.clone() });
        if let Ok((_, targets)) = self.chat_targets(&chat) {
            let req = Req::Edit { msg_id: id.to_string(), text: new_text, sealed: new_sealed };
            for t in targets {
                self.deliver(&t, &req);
            }
        }
        Ok(())
    }

    // ----- Pins -----

    fn apply_pin(&self, chat: &str, id: &str, by: &str, pinned: bool) {
        {
            let db = self.db.lock().unwrap();
            if pinned {
                let _ = db.execute("INSERT OR REPLACE INTO pins (chat, msg_id, by, ts) VALUES (?1, ?2, ?3, ?4)", params![chat, id, by, now()]);
            } else {
                let _ = db.execute("DELETE FROM pins WHERE chat = ?1 AND msg_id = ?2", [chat, id]);
            }
        }
        self.emit("pins", json!({ "chat": chat, "id": id, "pinned": pinned }));
    }

    /// Pins a message to the top of its chat, for everyone in it.
    pub fn pin_message(self: &Arc<Self>, chat: &str, id: &str, pinned: bool) -> Result<(), String> {
        let (group, targets) = self.chat_targets(chat)?;
        let channel = split_chat(chat).and_then(|(_, c)| c).map(str::to_string);
        self.apply_pin(chat, id, &self.me_s.clone(), pinned);
        let req = Req::Pin { group, channel, msg_id: id.to_string(), pinned };
        self.mirror(&self.me_s.clone(), chat, &req);
        for t in targets {
            self.deliver(&t, &req);
        }
        Ok(())
    }

    // ----- Reactions: one emoji per person per message -----

    fn apply_react(&self, chat: &str, id: &str, by: &str, emoji: &str) {
        let emoji: String = emoji.trim().chars().take(8).collect();
        {
            let db = self.db.lock().unwrap();
            let exists: bool = db.query_row("SELECT 1 FROM messages WHERE id = ?1 AND chat = ?2", [id, chat], |_| Ok(())).optional().ok().flatten().is_some();
            if !exists {
                return;
            }
            if emoji.is_empty() {
                let _ = db.execute("DELETE FROM reactions WHERE msg_id = ?1 AND by = ?2", [id, by]);
            } else {
                let _ = db.execute("INSERT OR REPLACE INTO reactions (chat, msg_id, by, emoji, ts) VALUES (?1, ?2, ?3, ?4, ?5)", params![chat, id, by, emoji, now()]);
            }
        }
        self.emit("reaction", json!({ "chat": chat, "id": id, "by": by, "emoji": emoji }));
    }

    /// Reacts to a message (or, with an empty emoji, takes your reaction back), for everyone in the chat.
    pub fn react_message(self: &Arc<Self>, chat: &str, id: &str, emoji: &str) -> Result<(), String> {
        let (group, targets) = self.chat_targets(chat)?;
        let channel = split_chat(chat).and_then(|(_, c)| c).map(str::to_string);
        self.apply_react(chat, id, &self.me_s.clone(), emoji);
        let req = Req::React { group, channel, msg_id: id.to_string(), emoji: emoji.trim().chars().take(8).collect() };
        self.mirror(&self.me_s.clone(), chat, &req);
        for t in targets {
            self.deliver(&t, &req);
        }
        Ok(())
    }

    /// The picture or GIF in someone's About (yours too), if there is one.
    pub fn bio_image(&self, id: &str) -> Option<String> {
        if id == self.me_s {
            return self.kv("bioimg");
        }
        self.db.lock().unwrap().query_row("SELECT bioimg FROM profiles WHERE id = ?1", [id], |r| r.get::<_, Option<String>>(0)).optional().ok().flatten().flatten()
    }

    pub fn reactions(&self, chat: &str) -> Vec<Value> {
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare("SELECT msg_id, by, emoji FROM reactions WHERE chat = ?1").unwrap();
        let rows = stmt.query_map([chat], |r| Ok(json!({ "id": r.get::<_, String>(0)?, "by": r.get::<_, String>(1)?, "emoji": r.get::<_, String>(2)? }))).unwrap();
        rows.filter_map(Result::ok).collect()
    }

    pub fn pins(&self, chat: &str) -> Vec<String> {
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare("SELECT msg_id FROM pins WHERE chat = ?1 ORDER BY ts DESC").unwrap();
        let rows = stmt.query_map([chat], |r| r.get::<_, String>(0)).unwrap();
        rows.filter_map(Result::ok).collect()
    }

    // ----- Backup: your identity and messages in one password-protected file -----

    /// Makes the backup (encrypted with `password`).
    pub fn export_backup(&self, password: &str) -> Result<Vec<u8>, String> {
        if password.trim().chars().count() < 4 {
            return Err("Use a password of at least 4 characters.".into());
        }
        let tmp = self.dir.join("backup.tmp.db");
        let _ = std::fs::remove_file(&tmp);
        self.db.lock().unwrap().execute("VACUUM INTO ?1", [tmp.to_string_lossy()]).map_err(e2s)?;
        let db = std::fs::read(&tmp).map_err(e2s)?;
        let _ = std::fs::remove_file(&tmp);
        // The account's key (on a phone signed in to a PC, that is the PC's identity).
        let identity = self.acct_secret.to_bytes().to_vec();
        let salt = new_id();
        let key = channel_key("backup", &salt, password.trim());
        let inner = serde_json::to_vec(&json!({ "identity": BASE64.encode(&identity), "db": BASE64.encode(&db) })).map_err(e2s)?;
        let out = json!({ "uan_backup": 1, "salt": salt, "check": key_check(&key), "data": seal_with(&key, &inner)? });
        serde_json::to_vec(&out).map_err(e2s)
    }

    /// Checks a backup and puts it in place for the next start. Returns the backed-up name.
    pub fn import_backup(&self, bytes: &[u8], password: &str) -> Result<(), String> {
        let v: Value = serde_json::from_slice(bytes).map_err(|_| "That isn't a UaN backup file.".to_string())?;
        if v["uan_backup"].as_i64() != Some(1) {
            return Err("That isn't a UaN backup file.".into());
        }
        let key = channel_key("backup", v["salt"].as_str().unwrap_or_default(), password.trim());
        if v["check"].as_str() != Some(key_check(&key).as_str()) {
            return Err("Wrong password.".into());
        }
        let inner: Value = open_with(&key, v["data"].as_str().unwrap_or_default())
            .and_then(|p| serde_json::from_slice(&p).ok())
            .ok_or("The backup file is damaged.")?;
        let identity = BASE64.decode(inner["identity"].as_str().unwrap_or_default().as_bytes()).map_err(e2s)?;
        let db = BASE64.decode(inner["db"].as_str().unwrap_or_default().as_bytes()).map_err(e2s)?;
        if identity.len() != 32 || !db.starts_with(b"SQLite format 3") {
            return Err("The backup file is damaged.".into());
        }
        std::fs::write(self.dir.join("uan.db.import"), db).map_err(e2s)?;
        std::fs::write(self.dir.join("identity.key.import"), identity).map_err(e2s)?;
        Ok(())
    }

    /// The chat a request from `peer` belongs to: their direct chat, or a group both of us are in.
    fn chat_of(&self, peer: &str, group: Option<&str>) -> Result<String, String> {
        match group {
            Some(g) => {
                if !self.is_member(g, peer) || !self.is_member(g, &self.me_s) {
                    return Err("You are not in that group.".into());
                }
                Ok(format!("g:{g}"))
            }
            None => {
                if self.contact_status(peer).as_deref() != Some("friend") {
                    return Err("You are not friends.".into());
                }
                Ok(peer.to_string())
            }
        }
    }

    fn peer_name(&self, peer: &str) -> String {
        let db = self.db.lock().unwrap();
        db.query_row(
            "SELECT name FROM contacts WHERE id = ?1 UNION SELECT name FROM group_members WHERE member_id = ?1 LIMIT 1",
            [peer],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
        .unwrap_or_default()
    }

    /// Deletes the messages of a chat on this PC (up to `before`, a time in ms).
    fn clear_local(&self, chat: &str, before: i64) {
        {
            let db = self.db.lock().unwrap();
            let _ = db.execute("DELETE FROM messages WHERE chat = ?1 AND ts <= ?2", params![chat, before]);
            let _ = db.execute("DELETE FROM reads WHERE chat = ?1", [chat]);
        }
        self.emit("cleared", json!({ "chat": chat }));
    }

    /// Clears a chat's messages: for you, or (the group's creator) for everyone in the group.
    pub fn clear_chat(self: &Arc<Self>, chat: &str, everyone: bool) -> Result<(), String> {
        let before = now();
        if everyone {
            let (g, channel) = split_chat(chat).ok_or("Only groups can be cleared for everyone.")?;
            let group = self.load_group(g).ok_or("That group no longer exists.")?;
            if group.owner != self.me_s {
                return Err("Only the group's creator can clear it for everyone.".into());
            }
            let ch = channel.map(str::to_string);
            self.purge_outbox(|r| matches!(r, Req::Msg { msg } if msg.group.as_deref() == Some(g) && msg.channel == ch && msg.ts <= before));
            let req = Req::ClearGroup { group_id: g.to_string(), before, channel: channel.map(str::to_string) };
            self.mirror(&self.me_s.clone(), chat, &req);
            for m in &group.members {
                self.deliver(&m.id, &req);
            }
        }
        self.clear_local(chat, before);
        Ok(())
    }

    /// (show others when I'm typing, tell others when I've seen their messages)
    pub fn privacy(&self) -> (bool, bool) {
        (self.kv("typing_on").map(|v| v != "0").unwrap_or(true), self.kv("receipts_on").map(|v| v != "0").unwrap_or(true))
    }

    pub fn set_privacy(&self, typing: bool, receipts: bool) {
        self.set_kv("typing_on", if typing { "1" } else { "0" });
        self.set_kv("receipts_on", if receipts { "1" } else { "0" });
    }

    /// Tells the people in a chat that you are typing (if you allow it). Nothing is stored or queued.
    pub fn typing(self: &Arc<Self>, chat: &str) {
        if !self.privacy().0 {
            return;
        }
        let Ok((group, targets)) = self.chat_targets(chat) else { return };
        let channel = split_chat(chat).and_then(|(_, c)| c).map(str::to_string);
        let req = Req::Typing { group, channel };
        for t in targets {
            if self.is_online(&t) && self.speaks(&t, 2) {
                let (me, req) = (self.clone(), req.clone());
                tauri::async_runtime::spawn(async move {
                    let _ = me.request_all(&t, &req).await;
                });
            }
        }
    }

    /// You have seen `chat` up to `msg_id`: tell the others (if you allow it).
    pub fn read_upto(self: &Arc<Self>, chat: &str, msg_id: &str) {
        if !self.privacy().1 {
            return;
        }
        let Ok((_, targets)) = self.chat_targets(chat) else { return };
        let changed = self
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO reads (chat, who, msg_id, ts) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (chat, who) DO UPDATE SET msg_id = excluded.msg_id, ts = excluded.ts WHERE msg_id <> excluded.msg_id",
                params![chat, self.me_s, msg_id, now()],
            )
            .unwrap_or(0);
        if changed > 0 {
            for t in targets {
                self.sync_reads(&t);
            }
        }
    }

    /// Sends `peer` our latest "seen" marks for the chats we share, unless they already have them.
    fn sync_reads(self: &Arc<Self>, peer: &str) {
        if !self.privacy().1 || !self.speaks(peer, 2) || !self.is_online(peer) {
            return;
        }
        let mine: Vec<(String, String)> = {
            let db = self.db.lock().unwrap();
            let mut stmt = db.prepare("SELECT chat, msg_id FROM reads WHERE who = ?1").unwrap();
            let rows = stmt.query_map([&self.me_s], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
            rows.filter_map(Result::ok).collect()
        };
        for (chat, msg_id) in mine {
            let (group, channel) = match split_chat(&chat) {
                Some((g, c)) => (Some(g.to_string()), c.map(str::to_string)),
                None => (None, None),
            };
            let shared = match &group {
                Some(g) => self.is_member(g, peer) && self.is_member(g, &self.me_s),
                None => chat == peer,
            };
            let key = (peer.to_string(), chat.clone());
            if !shared || self.reads_sent.lock().unwrap().get(&key) == Some(&msg_id) {
                continue;
            }
            // Marked as sent right away, so quick repeats don't send it twice; forgotten again if it fails.
            self.reads_sent.lock().unwrap().insert(key.clone(), msg_id.clone());
            let (me, peer) = (self.clone(), peer.to_string());
            tauri::async_runtime::spawn(async move {
                if me.request_all(&peer, &Req::Seen { group, channel, msg_id: msg_id.clone() }).await.is_err() {
                    let mut sent = me.reads_sent.lock().unwrap();
                    if sent.get(&key) == Some(&msg_id) {
                        sent.remove(&key);
                    }
                }
            });
        }
    }

    /// Who has seen `chat` up to which message: { peer id: message id }.
    pub fn reads(&self, chat: &str) -> Value {
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare("SELECT who, msg_id FROM reads WHERE chat = ?1 AND who <> ?2").unwrap();
        let rows = stmt.query_map([chat, &self.me_s], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).unwrap();
        Value::Object(rows.filter_map(Result::ok).map(|(k, v)| (k, Value::String(v))).collect())
    }

    /// Adds people to a group we created, tells everyone, and sends the newcomers the earlier messages.
    fn add_members(self: &Arc<Self>, g: &str, members: &[Member]) {
        if members.is_empty() {
            return;
        }
        {
            let db = self.db.lock().unwrap();
            for m in members {
                let name: String = m.name.trim().chars().take(32).collect();
                let _ = db.execute("INSERT OR REPLACE INTO group_members (group_id, member_id, name) VALUES (?1, ?2, ?3)", params![g, m.id, name]);
            }
        }
        self.bump_and_broadcast(g, &[]);
        for m in members {
            self.send_history(g, &m.id);
        }
    }

    /// Queues the group's earlier messages (latest 300, with previews) for a new member, newest chunk first.
    fn send_history(self: &Arc<Self>, g: &str, to: &str) {
        let chat = format!("g:{g}");
        let mut all: Vec<HistMsg> = {
            let db = self.db.lock().unwrap();
            let mut stmt = db
                .prepare(
                    "SELECT id, sender, sender_name, text, file, ts, (SELECT data FROM thumbs WHERE thumbs.file_id = json_extract(messages.file, '$.id'))
                     , chat, sealed, reply FROM messages WHERE chat = ?1 OR chat LIKE ?1 || '#%' ORDER BY seq DESC LIMIT 300",
                )
                .unwrap();
            let rows = stmt
                .query_map([&chat], |r| {
                    Ok(HistMsg {
                        id: r.get(0)?,
                        sender: r.get(1)?,
                        name: r.get(2)?,
                        text: r.get(3)?,
                        file: r.get::<_, Option<String>>(4)?.and_then(|f| serde_json::from_str(&f).ok()),
                        ts: r.get(5)?,
                        thumb: r.get(6)?,
                        channel: split_chat(&r.get::<_, String>(7)?).and_then(|(_, c)| c).map(str::to_string),
                        sealed: r.get(8)?,
                        reply: r.get::<_, Option<String>>(9)?.and_then(|t| serde_json::from_str(&t).ok()),
                    })
                })
                .unwrap();
            rows.filter_map(Result::ok).collect()
        };
        // `all` is newest first. Cut it into chunks that fit a frame; inside a chunk, oldest first.
        while !all.is_empty() {
            let mut size = 0usize;
            let mut n = 0usize;
            for m in &all {
                let add = 300 + m.text.as_ref().map(|t| t.len()).unwrap_or(0) + m.thumb.as_ref().map(|t| t.len()).unwrap_or(0);
                if n > 0 && (size + add > 500_000 || n >= 40) {
                    break;
                }
                size += add;
                n += 1;
            }
            let mut chunk: Vec<HistMsg> = all.drain(..n).collect();
            chunk.reverse();
            self.deliver(to, &Req::History { group_id: g.to_string(), msgs: chunk });
        }
    }

    /// Deletes a message here. With `sender`, only if that person sent it. Returns (chat, sender, file).
    fn remove_message(&self, id: &str, sender: Option<&str>) -> Option<(String, String, Option<FileMeta>)> {
        let found: Option<(String, String, Option<String>)> = {
            let db = self.db.lock().unwrap();
            db.query_row("SELECT chat, sender, file FROM messages WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()
                .ok()
                .flatten()
        };
        let (chat, from, file) = found?;
        if sender.is_some_and(|s| s != from) {
            return None;
        }
        let file: Option<FileMeta> = file.and_then(|f| serde_json::from_str(&f).ok());
        {
            let db = self.db.lock().unwrap();
            let _ = db.execute("DELETE FROM messages WHERE id = ?1", [id]);
            let _ = db.execute("DELETE FROM reactions WHERE msg_id = ?1", [id]);
            if let Some(f) = &file {
                // Keep the preview while another message still shows the same file (sent to several chats).
                let still: i64 = db
                    .query_row("SELECT COUNT(*) FROM messages WHERE json_extract(file, '$.id') = ?1", [&f.id], |r| r.get(0))
                    .unwrap_or(0);
                if still == 0 {
                    let _ = db.execute("DELETE FROM thumbs WHERE file_id = ?1", [&f.id]);
                }
            }
        }
        self.emit("unsent", json!({ "id": id, "chat": chat }));
        Some((chat, from, file))
    }

    /// Deletes a message: just here, or (your own messages) for everyone in the chat.
    /// A file you delete for everyone can no longer be watched or downloaded from your PC by that chat.
    pub fn delete_message(self: &Arc<Self>, id: &str, everyone: bool) -> Result<(), String> {
        let mine: Option<String> = self
            .db
            .lock()
            .unwrap()
            .query_row("SELECT sender FROM messages WHERE id = ?1", [id], |r| r.get(0))
            .optional()
            .map_err(e2s)?;
        let Some(sender) = mine else { return Ok(()) };
        if everyone && sender != self.me_s {
            // The group's owner or a co-owner may delete anyone's message in the group.
            let chat: Option<String> = self.db.lock().unwrap().query_row("SELECT chat FROM messages WHERE id = ?1", [id], |r| r.get(0)).optional().ok().flatten();
            let group = chat.as_deref().and_then(split_chat).map(|(g, _)| g.to_string()).and_then(|g| self.load_group(&g));
            let Some(group) = group.filter(|g| g.manager(&self.me_s)) else {
                return Err("You can only delete your own messages for everyone.".into());
            };
            let req = Req::ModDelete { group_id: group.id.clone(), msg_id: id.to_string() };
            self.purge_outbox(|r| matches!(r, Req::Msg { msg } if msg.id == id));
            if let Some((_, _, Some(f))) = self.remove_message(id, None) {
                self.forget_file(&f.id);
            }
            self.mirror(&self.me_s.clone(), "", &req);
            for m in group.members.iter().filter(|m| m.id != self.me_s) {
                self.deliver(&m.id, &req);
            }
            return Ok(());
        }
        let Some((chat, _, file)) = self.remove_message(id, None) else { return Ok(()) };
        if everyone {
            // Not delivered yet: then it never will be.
            let fid = file.as_ref().map(|f| f.id.clone());
            self.purge_outbox(|r| match r {
                Req::Msg { msg } => msg.id == id,
                Req::Thumb { file_id, .. } => fid.as_deref() == Some(file_id.as_str()),
                _ => false,
            });
            self.mirror(&self.me_s.clone(), &chat, &Req::Unsend { msg_id: id.to_string() });
            if let Ok((_, targets)) = self.chat_targets(&chat) {
                let req = Req::Unsend { msg_id: id.to_string() };
                for t in targets {
                    self.deliver(&t, &req);
                }
            }
            if let Some(f) = file.filter(|f| f.owner == self.me_s) {
                let db = self.db.lock().unwrap();
                let _ = db.execute("DELETE FROM file_access WHERE file_id = ?1 AND who = ?2", [&f.id, &chat]);
                let left: i64 = db.query_row("SELECT COUNT(*) FROM file_access WHERE file_id = ?1", [&f.id], |r| r.get(0)).unwrap_or(0);
                if left == 0 {
                    let _ = db.execute("DELETE FROM shared_files WHERE id = ?1", [&f.id]);
                }
            }
        }
        Ok(())
    }

    /// Recipients of a chat id: a friend's id, or "g:<group>" for everyone in the group.
    fn chat_targets(&self, chat: &str) -> Result<(Option<String>, Vec<String>), String> {
        if let Some((g, _)) = split_chat(chat) {
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
        self.send_reply(chats, text, file, None)
    }

    pub fn send_reply(self: &Arc<Self>, chats: &[String], text: Option<String>, file: Option<FileMeta>, reply_to: Option<String>) -> Result<(), String> {
        let text = text.map(|t| t.trim().chars().take(5000).collect::<String>()).filter(|t| !t.is_empty());
        if text.is_none() && file.is_none() {
            return Err("Nothing to send.".into());
        }
        let name = self.my_name();
        for chat in chats {
            let (group, targets) = self.chat_targets(chat)?;
            let channel = split_chat(chat).and_then(|(_, c)| c).map(str::to_string);
            // The message being answered: who wrote it and the start of it (shown above the reply).
            let reply = reply_to.as_ref().and_then(|rid| {
                let m = self.messages(chat, 20000).into_iter().find(|m| m["id"].as_str() == Some(rid))?;
                let text = m["text"].as_str().map(str::to_string).or_else(|| m["file"]["name"].as_str().map(|n| format!("File: {n}"))).unwrap_or_default();
                Some(ReplyRef { id: rid.clone(), name: m["senderName"].as_str().unwrap_or_default().to_string(), text: text.chars().take(200).collect() })
            });
            let mut msg = WireMsg { id: new_id(), group: group.clone(), name: name.clone(), text: text.clone(), file: file.clone(), ts: now(), channel: channel.clone(), sealed: None, reply: reply.clone() };
            // Locked channel: text and file are encrypted with the channel's key.
            if let (Some(g), Some(c)) = (&group, &channel) {
                let locked = self.load_group(g).and_then(|gr| gr.channels.into_iter().find(|x| x.id == *c)).and_then(|x| x.check).is_some();
                if locked {
                    let key = self
                        .kv(&format!("chkey:{chat}"))
                        .and_then(|k| HEXLOWER.decode(k.as_bytes()).ok())
                        .and_then(|k| <[u8; 32]>::try_from(k).ok())
                        .ok_or("Unlock this channel with its password first.")?;
                    let plain = serde_json::to_vec(&json!({ "text": msg.text, "file": msg.file, "reply": msg.reply })).map_err(e2s)?;
                    msg.sealed = Some(seal_with(&key, &plain)?);
                    msg.text = None;
                    msg.file = None;
                    msg.reply = None;
                }
            }
            if let Some(f) = &file {
                let base = group.as_ref().map(|g| format!("g:{g}")).unwrap_or_else(|| chat.clone());
                let _ = self.db.lock().unwrap().execute("INSERT OR IGNORE INTO file_access (file_id, who) VALUES (?1, ?2)", [&f.id, &base]);
            }
            self.store_message(&msg.id, chat, &self.me_s, &name, msg.text.as_deref(), msg.file.as_ref(), msg.ts, msg.sealed.as_deref(), msg.reply.as_ref());
            let req = Req::Msg { msg };
            self.mirror(&self.me_s.clone(), chat, &req);
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
        let file = FileMeta { id: new_id(), name: p.file_name().and_then(|n| n.to_str()).unwrap_or("test").to_string(), size, mime: guess_mime(&p).to_string(), owner: self.me_s.clone(), dev: self.my_dev() };
        self.db.lock().unwrap().execute(
            "INSERT INTO shared_files (id, path, name, size, mime, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![file.id, path, file.name, size as i64, file.mime, now()],
        ).map_err(e2s)?;
        Ok(file)
    }

    /// What is in a folder, by file type (shown before sending it, to pick which types go).
    pub fn scan_folder(&self, path: &str) -> Result<Value, String> {
        let dir = PathBuf::from(path);
        if !dir.is_dir() {
            return Err("Not a folder.".into());
        }
        let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("folder").to_string();
        let mut found = Vec::new();
        collect_files(&dir, &name, &mut found, 0);
        let mut by: HashMap<String, (u64, u64)> = HashMap::new();
        for (p, _, len) in &found {
            let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
            let e = by.entry(ext).or_insert((0, 0));
            e.0 += 1;
            e.1 += len;
        }
        let mut exts: Vec<Value> = by.into_iter().map(|(ext, (count, size))| json!({ "ext": ext, "count": count, "size": size })).collect();
        exts.sort_by(|a, b| b["size"].as_u64().cmp(&a["size"].as_u64()));
        Ok(json!({ "path": path, "name": name, "count": found.len(), "size": found.iter().map(|f| f.2).sum::<u64>(), "exts": exts, "tooMany": found.len() > 1000 }))
    }

    /// Sends a folder, only the files of the chosen types ("" = files without an extension).
    pub fn share_folder(self: &Arc<Self>, path: &str, chats: &[String], exts: &[String]) -> Result<usize, String> {
        for chat in chats {
            self.chat_targets(chat)?;
        }
        let dir = PathBuf::from(path);
        let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("folder").to_string();
        let mut found = Vec::new();
        collect_files(&dir, &name, &mut found, 0);
        if found.len() > 1000 {
            return Err(format!("{name}: too many files (over 1000). Zip it, or send part of it."));
        }
        let want: HashSet<String> = exts.iter().map(|e| e.to_lowercase()).collect();
        let mut sent = 0;
        for (p, rel, len) in found {
            let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
            if !want.contains(&ext) || len > MAX_FILE_SIZE {
                continue;
            }
            let file = FileMeta { id: new_id(), name: rel, size: len, mime: guess_mime(&p).to_string(), owner: self.me_s.clone(), dev: self.my_dev() };
            let _ = self.db.lock().unwrap().execute(
                "INSERT INTO shared_files (id, path, name, size, mime, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![file.id, p.to_string_lossy(), file.name, file.size as i64, file.mime, now()],
            );
            self.send(chats, None, Some(file))?;
            sent += 1;
        }
        if sent == 0 {
            return Err("Nothing to send: none of the files are of the chosen types.".into());
        }
        Ok(sent)
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
                // A folder: every file in it (and in its subfolders) is sent, named "Folder/sub/file".
                let mut found = Vec::new();
                collect_files(&path, &name, &mut found, 0);
                if found.is_empty() {
                    errors.push(format!("{name}: the folder is empty."));
                }
                if found.len() > 1000 {
                    errors.push(format!("{name}: too many files (over 1000). Zip it, or send part of it."));
                    continue;
                }
                for (p, rel, len) in found {
                    if len > MAX_FILE_SIZE {
                        errors.push(format!("{rel}: too big, the limit is 4 TB."));
                        continue;
                    }
                    let file = FileMeta { id: new_id(), name: rel, size: len, mime: guess_mime(&p).to_string(), owner: self.me_s.clone(), dev: self.my_dev() };
                    let _ = self.db.lock().unwrap().execute(
                        "INSERT INTO shared_files (id, path, name, size, mime, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![file.id, p.to_string_lossy(), file.name, file.size as i64, file.mime, now()],
                    );
                    self.send(chats, note.take(), Some(file))?;
                    sent += 1;
                }
                continue;
            }
            if meta.len() > MAX_FILE_SIZE {
                errors.push(format!("{name}: too big, the limit is 4 TB."));
                continue;
            }
            let file = FileMeta { id: new_id(), name: name.clone(), size: meta.len(), mime: guess_mime(&path).to_string(), owner: self.me_s.clone(), dev: self.my_dev() };
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
        peer == self.me_s || split_chat(chat).map(|(g, _)| self.is_member(g, peer)).unwrap_or(false)
    }

    /// Set on files this device shares when it isn't the account's PC: friends fetch them from here.
    fn my_dev(&self) -> Option<String> {
        (self.dev_s != self.me_s).then(|| self.dev_s.clone())
    }

    fn source_for(&self, peer: &str, file_id: &str) -> Option<Source> {
        let (own, dl): (Option<(String, i64)>, Option<(String, String)>) = {
            let db = self.db.lock().unwrap();
            let own = db
                .query_row(
                    "SELECT f.path, f.size FROM shared_files f WHERE f.id = ?1 AND (?3 OR EXISTS (
                       SELECT 1 FROM file_access a WHERE a.file_id = f.id AND (
                         a.who = ?2 OR EXISTS (SELECT 1 FROM group_members m WHERE 'g:' || m.group_id = a.who AND m.member_id = ?2))))",
                    params![file_id, peer, peer == self.me_s],
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
            write_frame(&mut send, &self.wrap(&Req::FileGet { file_id: file.id.clone(), offset, len })).await?;
            send.finish().map_err(e2s)?;
            let head: Value = read_frame(&mut recv).await?;
            Ok::<_, String>((head, recv))
        };
        match tokio::time::timeout(Duration::from_secs(30), open).await {
            Ok(Ok((head, recv))) => {
                self.mark_seen(&self.account_of(from));
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
        // The device that has it (their phone), then the owner's PC.
        if let Some(d) = file.dev.clone().filter(|d| *d != self.dev_s && parse_id(d).is_ok()) {
            if !v.contains(&d) {
                v.push(d);
            }
        }
        if file.owner == self.me_s {
            // Our own file, on our other device.
            if self.dev_s != self.me_s && !v.contains(&file.owner) {
                v.push(file.owner.clone());
            }
        } else {
            push(file.owner.clone(), &mut v);
        }
        let group = split_chat(chat).map(|(g, _)| g.to_string()).or(party_group.map(|(_, g)| g));
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
        if file.owner == "_theme" {
            // A video or picture of one of your own themes (UaN's data folder, themes/).
            let sub = ["Workshop/", "Staging/"].into_iter().find_map(|p| file.id.strip_prefix(p).map(|rest| (p.trim_end_matches('/'), rest)));
            let rel = if let Some((folder, rest)) = sub {
                let ok = !rest.is_empty() && !rest.starts_with('.') && rest.chars().all(|c| c.is_alphanumeric() || " .-_()'".contains(c));
                if !ok {
                    return Err("No such theme file.".into());
                }
                std::path::PathBuf::from(folder).join(rest)
            } else {
                let name: String = file.id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.').collect();
                if name.is_empty() || name.starts_with('.') {
                    return Err("No such theme file.".into());
                }
                std::path::PathBuf::from(name)
            };
            let mut f = tokio::fs::File::open(self.dir.join("themes").join(rel)).await.map_err(e2s)?;
            f.seek(SeekFrom::Start(start)).await.map_err(e2s)?;
            let mut buf = vec![0u8; len as usize];
            let mut got = 0;
            while got < buf.len() {
                let n = f.read(&mut buf[got..]).await.map_err(e2s)?;
                if n == 0 {
                    break;
                }
                got += n;
            }
            buf.truncate(got);
            return Ok(buf);
        }
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
        self.download_into(file, chat, false)
    }

    /// Files saved automatically go to Downloads/UaN.
    /// Drops things still waiting in the outbox (to anyone, also inside copies for our other devices).
    fn purge_outbox(&self, hit: impl Fn(&Req) -> bool) {
        let db = self.db.lock().unwrap();
        let rows: Vec<(i64, String)> = {
            let Ok(mut stmt) = db.prepare("SELECT seq, payload FROM outbox") else { return };
            let Ok(rows) = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))) else { return };
            rows.filter_map(Result::ok).collect()
        };
        for (seq, payload) in rows {
            let Ok(req) = serde_json::from_str::<Req>(&payload) else { continue };
            let inner = match &req {
                Req::Mirror { req, .. } => req.as_ref(),
                other => other,
            };
            if hit(inner) {
                let _ = db.execute("DELETE FROM outbox WHERE seq = ?1", [seq]);
            }
        }
    }

    /// The sender deleted a file for everyone: stop downloading it, and remove the copies UaN fetched by
    /// itself (automatic downloads, mailbox pick-ups). Files you downloaded and finished on purpose stay.
    fn forget_file(self: &Arc<Self>, file_id: &str) {
        self.stop_stream(file_id);
        self.partials.lock().unwrap().remove(file_id);
        let auto = Self::auto_dir().ok();
        let is_auto = |p: &str| auto.as_ref().is_some_and(|d| Path::new(p).starts_with(d));
        let gone: Vec<Transfer> = {
            let mut list = self.transfers.lock().unwrap();
            let gone: Vec<Transfer> = list.iter().filter(|t| t.file.id == file_id && (t.status != "done" || is_auto(&t.path))).cloned().collect();
            list.retain(|t| !gone.iter().any(|g| g.id == t.id));
            gone
        };
        if gone.is_empty() {
            return;
        }
        for t in &gone {
            if let Some(r) = self.running.lock().unwrap().remove(&t.id) {
                r.cancel.cancel();
            }
        }
        let _ = self.db.lock().unwrap().execute("DELETE FROM downloads WHERE file_id = ?1", [file_id]);
        self.save_transfers();
        self.emit_transfers();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            for t in gone {
                let part = part_path(Path::new(&t.path));
                let _ = tokio::fs::remove_file(blocks_path(&part)).await;
                let _ = tokio::fs::remove_file(&part).await;
                if t.status == "done" {
                    let _ = tokio::fs::remove_file(&t.path).await;
                }
            }
        });
    }

    fn auto_dir() -> Result<PathBuf, String> {
        // UAN_DOWNLOADS: tests keep their files out of the real Downloads folder.
        let dir = match std::env::var_os("UAN_DOWNLOADS") {
            Some(d) => PathBuf::from(d),
            None => dirs::download_dir().or_else(dirs::home_dir).ok_or("Couldn't find your Downloads folder.")?.join("UaN"),
        };
        std::fs::create_dir_all(&dir).map_err(e2s)?;
        Ok(dir)
    }

    pub fn download_into(self: &Arc<Self>, file: FileMeta, chat: String, auto: bool) -> Result<String, String> {
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
        let dir = if auto || std::env::var_os("UAN_DOWNLOADS").is_some() { Self::auto_dir()? } else { dirs::download_dir().or_else(dirs::home_dir).ok_or("Couldn't find your Downloads folder.")? };
        // Files from a folder ("Folder/sub/file.txt") keep their folders on disk.
        let parts: Vec<String> = file
            .name
            .split(['/', '\\'])
            .filter(|p| !p.is_empty() && *p != "." && *p != "..")
            .map(safe_file_name)
            .collect();
        let mut dir = dir;
        for p in parts.iter().take(parts.len().saturating_sub(1)) {
            dir.push(p);
        }
        if parts.len() > 1 {
            std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create the folder {}: {e}", dir.display()))?;
        }
        let leaf = parts.last().cloned().unwrap_or_else(|| safe_file_name(&file.name));
        let path = unique_path(&dir, &leaf);
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
            write_frame(&mut send, &self.wrap(&Req::Probe { bytes: PROBE_BYTES })).await.ok()?;
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
        for m in party.members.iter().filter(|m| m.id != self.me_s && !m.left) {
            self.send_party(party, &m.id);
        }
    }

    /// Sends the party to one person (all their devices). The host keeps track of whether the invitation
    /// got through, and why not, so the party window can say so; the background loop sends it again.
    fn send_party(self: &Arc<Self>, party: &Party, to: &str) {
        let (me, req, to, pid) = (self.clone(), Req::Party { party: party.clone() }, to.to_string(), party.id.clone());
        let host = party.leader == self.me_s;
        tauri::async_runtime::spawn(async move {
            let res = me.request_all(&to, &req).await;
            let short = &to[..to.len().min(8)];
            let (reached, note) = match &res {
                Ok(_) => (true, String::new()),
                Err(ReqError::Offline(e)) => (false, format!("can't reach their PC ({e})")),
                Err(ReqError::Refused(e)) => (false, format!("their UaN refused it: {e}")),
            };
            me.log(&format!("party {}: to {short} {}", &pid[..pid.len().min(8)], if reached { "delivered".to_string() } else { note.clone() }));
            if !host {
                return;
            }
            let changed = {
                let mut parties = me.parties.lock().unwrap();
                parties.get_mut(&pid).and_then(|p| p.members.iter_mut().find(|m| m.id == to)).map(|m| {
                    let changed = m.reached != (reached || m.reached) || (!m.reached && m.note != note);
                    m.reached |= reached;
                    if !m.reached {
                        m.note = note.clone();
                    } else {
                        m.note.clear();
                    }
                    changed
                })
            };
            if changed == Some(true) {
                if let Some(p) = me.parties.lock().unwrap().get(&pid).cloned() {
                    let _ = me.app.emit("party", &p);
                }
            }
        });
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
            let trash = c.dir.with_file_name(format!("old-{}", new_id()));
            let dir = if std::fs::rename(&c.dir, &trash).is_ok() { trash } else { c.dir.clone() };
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

    fn queue_local(self: &Arc<Self>, id: &str, file: FileMeta) {
        let updated = {
            let mut parties = self.parties.lock().unwrap();
            let Some(p) = parties.get_mut(id) else { return };
            if p.queue.len() >= 50 || p.file.id == file.id || p.queue.iter().any(|f| f.id == file.id) {
                return;
            }
            p.queue.push(file);
            p.version += 1;
            p.clone()
        };
        self.broadcast_party(&updated);
    }

    /// Adds a film to the party's playlist (the host keeps it; others ask the host).
    pub fn party_queue(self: &Arc<Self>, id: &str, file: FileMeta) -> Result<(), String> {
        let party = self.parties.lock().unwrap().get(id).cloned().ok_or("That watch party has ended.")?;
        if party.leader == self.me_s {
            self.queue_local(id, file);
        } else {
            let me = self.clone();
            let req = Req::PartyQueue { party_id: id.to_string(), file };
            tauri::async_runtime::spawn(async move {
                let _ = me.request_all(&party.leader, &req).await;
            });
        }
        Ok(())
    }

    /// The host moves the party on to the next film of the playlist (or removes one with `remove`).
    pub fn party_next(self: &Arc<Self>, id: &str, remove: Option<String>) -> Result<(), String> {
        let updated = {
            let mut parties = self.parties.lock().unwrap();
            let p = parties.get_mut(id).ok_or("That watch party has ended.")?;
            if p.leader != self.me_s {
                return Err("Only the host can do that.".into());
            }
            if let Some(r) = remove {
                p.queue.retain(|f| f.id != r);
            } else {
                if p.queue.is_empty() {
                    return Ok(());
                }
                p.file = p.queue.remove(0);
                p.state = "loading".into();
                p.position = 0.0;
                for m in p.members.iter_mut() {
                    m.have = 0;
                    m.ready = false;
                    m.buffering = false;
                }
                if p.members.iter().any(|m| m.id == p.file.owner && m.joined && !m.left) {
                    p.seeder = p.file.owner.clone();
                }
            }
            p.version += 1;
            p.clone()
        };
        // The host loads the next film too.
        let full = self.full_parties.lock().unwrap().contains(id);
        let chat = format!("g:{}", updated.group);
        if full {
            let _ = self.download_into(updated.file.clone(), chat, true);
        } else {
            let _ = self.start_stream(updated.file.clone(), chat);
        }
        self.broadcast_party(&updated);
        self.party_report(id, None, false);
        Ok(())
    }

    pub fn create_party(self: &Arc<Self>, group: &str, file: FileMeta, invite: Vec<String>, seeder: String) -> Result<String, String> {
        let g = self.load_group(group).ok_or("That group no longer exists.")?;
        let (have, ready) = self.buffer_state(&file);
        let mut members = vec![PartyMember { id: self.me_s.clone(), name: self.my_name(), have, joined: true, left: false, ready, buffering: false, full: false, reached: true, note: String::new() }];
        for id in invite {
            if let Some(m) = g.members.iter().find(|m| m.id == id && m.id != self.me_s) {
                members.push(PartyMember { id: m.id.clone(), name: m.name.clone(), have: 0, joined: false, left: false, ready: false, buffering: false, full: false, reached: false, note: String::new() });
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
            queue: vec![],
        };
        self.parties.lock().unwrap().insert(party.id.clone(), party.clone());
        self.broadcast_party(&party);
        self.join_party(&party.id, false)?;
        Ok(party.id)
    }

    pub fn join_party(self: &Arc<Self>, id: &str, full: bool) -> Result<(), String> {
        let party = self.parties.lock().unwrap().get(id).cloned().ok_or("That watch party has ended.")?;
        if full {
            self.full_parties.lock().unwrap().insert(id.to_string());
            self.download_into(party.file.clone(), format!("g:{}", party.group), true)?;
        } else {
            // Stream it: pieces around the playhead are fetched ahead of time (no download needed).
            self.start_stream(party.file.clone(), format!("g:{}", party.group))?;
        }
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

    /// Your own choice in a watch party: download the whole film first (smoothest, kept in Downloads/UaN),
    /// or just stream it around the playhead (nothing is kept). The party waits until you are ready.
    pub fn party_full(self: &Arc<Self>, id: &str, full: bool) -> Result<(), String> {
        let party = self.parties.lock().unwrap().get(id).cloned().ok_or("That watch party has ended.")?;
        let chat = format!("g:{}", party.group);
        let have_it = party.file.owner == self.me_s || self.local_copy(&party.file).is_some();
        if full {
            self.full_parties.lock().unwrap().insert(id.to_string());
            if !have_it {
                self.stop_stream(&party.file.id);
                self.download_into(party.file.clone(), chat, true)?;
            }
        } else {
            self.full_parties.lock().unwrap().remove(id);
            if !have_it {
                let tid = self.transfers.lock().unwrap().iter().find(|t| t.file.id == party.file.id && t.status != "done").map(|t| t.id.clone());
                if let Some(tid) = tid {
                    self.pause_download(&tid);
                }
                self.start_stream(party.file.clone(), chat)?;
            }
        }
        self.party_report(id, None, false);
        Ok(())
    }

    /// Leave a watch party. If the host leaves without ending it, someone else becomes the host and the others keep watching.
    pub fn leave_party(self: &Arc<Self>, id: &str, end: bool) {
        let leader = self.parties.lock().unwrap().get(id).map(|p| p.leader.clone());
        if let Some(fid) = self.parties.lock().unwrap().get(id).map(|p| p.file.id.clone()) {
            self.stop_stream(&fid);
        }
        self.buffering.lock().unwrap().remove(id);
        self.full_parties.lock().unwrap().remove(id);
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
        let full = self.full_parties.lock().unwrap().contains(id);
        let joined = joined.unwrap_or(true);
        if party.leader == self.me_s {
            self.apply_report(id, &self.me_s.clone(), have, joined, left, ready, buffering, full);
        } else {
            let me = self.clone();
            let req = Req::PartyReport { party_id: id.to_string(), have, joined, left, ready, buffering, full };
            tauri::async_runtime::spawn(async move {
                let _ = me.request_all(&party.leader, &req).await;
            });
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_report(self: &Arc<Self>, id: &str, who: &str, have: u64, joined: bool, left: bool, ready: bool, buffering: bool, full: bool) {
        let updated = {
            let mut parties = self.parties.lock().unwrap();
            let Some(p) = parties.get_mut(id) else { return };
            let Some(m) = p.members.iter_mut().find(|m| m.id == who) else { return };
            if m.have == have && m.joined == joined && m.left == left && m.ready == ready && m.buffering == buffering && m.full == full {
                return;
            }
            m.full = full;
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
                let _ = me.request_all(&party.leader, &req).await;
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
            "SELECT id, chat, sender, sender_name, text, file, ts, (SELECT data FROM thumbs WHERE thumbs.file_id = json_extract(messages.file, '$.id')) FROM messages WHERE 1 = 1",
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
                "thumb": r.get::<_, Option<String>>(7)?.and_then(|t| serde_json::from_str::<Value>(&t).ok()),
                "mine": sender == self.me_s,
            }))
        });
        match rows {
            Ok(r) => r.filter_map(Result::ok).collect(),
            Err(_) => vec![],
        }
    }

    fn pause_download(&self, id: &str) {
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

    pub async fn transfer_action(self: &Arc<Self>, id: &str, action: &str) -> Result<(), String> {
        let t = self.get(id).ok_or("That download is gone.")?;
        match action {
            "pause" => self.pause_download(id),
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
    let cors = vec![("Access-Control-Allow-Origin", "*".to_string()), ("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, X-UaN-Error".to_string())];
    let parts: Vec<String> = path.trim_start_matches('/').split('/').map(pct_decode).collect();
    if parts.len() < 4 {
        return (400, cors, Vec::new());
    }
    let Ok(size) = parts[2].parse::<u64>() else { return (400, cors, Vec::new()) };
    let (owner, dev) = match parts[0].split_once('~') { Some((o, d)) => (o.to_string(), Some(d.to_string())), None => (parts[0].clone(), None) };
    let file = FileMeta { owner, id: parts[1].clone(), size, mime: parts[3].clone(), name: String::new(), dev };
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
        Err(e) => {
            // Lets the player tell "sender unreachable" apart from "format not supported".
            let mut h = headers;
            h.push(("X-UaN-Error", e.chars().filter(|c| c.is_ascii() && !c.is_control()).collect()));
            (503, h, Vec::new())
        }
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

/// Streams a whole byte range in one response, reading 8 MB at a time (from disk, the watch-party
/// cache, or the sender). External players like VLC seek by opening a new request with a Range.
async fn stream_media<W: tokio::io::AsyncWrite + Unpin>(node: &Arc<Node>, path: &str, range: Option<&str>, w: &mut W) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let parts: Vec<String> = path.trim_start_matches('/').split('/').map(pct_decode).collect();
    let size = parts.get(2).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    if parts.len() < 4 || size == 0 {
        w.write_all(b"HTTP/1.1 404 Error\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n").await?;
        return w.flush().await;
    }
    let (owner, dev) = match parts[0].split_once('~') { Some((o, d)) => (o.to_string(), Some(d.to_string())), None => (parts[0].clone(), None) };
    let file = FileMeta { owner, id: parts[1].clone(), size, mime: parts[3].clone(), name: String::new(), dev };
    let wanted = range
        .and_then(|r| r.trim().strip_prefix("bytes="))
        .and_then(|r| r.split_once('-'))
        .map(|(a, b)| (a.parse::<u64>().unwrap_or(0), b.parse::<u64>().ok()));
    let (start, end) = match wanted {
        Some((s, e)) => (s.min(size - 1), e.unwrap_or(size - 1).min(size - 1)),
        None => (0, size - 1),
    };
    // Make sure the first piece is reachable before promising a response.
    let first_len = (end - start + 1).min(MEDIA_CHUNK);
    let first = match node.read_range(&file, start, first_len).await {
        Ok(b) => b,
        Err(e) => {
            let msg: String = e.chars().filter(|c| c.is_ascii() && !c.is_control()).collect();
            w.write_all(format!("HTTP/1.1 503 Error\r\nX-UaN-Error: {msg}\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n").as_bytes()).await?;
            return w.flush().await;
        }
    };
    let mut head = if wanted.is_some() { "HTTP/1.1 206 Partial Content\r\n".to_string() } else { "HTTP/1.1 200 OK\r\n".to_string() };
    head.push_str(&format!("Content-Type: {}\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\n", player_mime(&file.mime), end - start + 1));
    if wanted.is_some() {
        head.push_str(&format!("Content-Range: bytes {start}-{end}/{size}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    w.write_all(head.as_bytes()).await?;
    w.write_all(&first).await?;
    let mut pos = start + first.len() as u64;
    while pos <= end {
        let n = (end - pos + 1).min(MEDIA_CHUNK);
        let bytes = node.read_range(&file, pos, n).await.map_err(std::io::Error::other)?;
        if bytes.is_empty() {
            break;
        }
        w.write_all(&bytes).await?;
        pos += bytes.len() as u64;
    }
    w.flush().await?;
    // "Connection: close": end this connection so the player starts a fresh request for the next seek.
    Err(std::io::Error::other("stream done"))
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
        // ?stream=1: one continuous response (for VLC and other external players), fetched piece by piece.
        if method == "GET" && target.contains("stream=1") {
            if let Some(rest) = path.strip_prefix(&format!("/{secret}/")) {
                stream_media(&node, rest, range.as_deref(), &mut w).await?;
                continue;
            }
        }
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

/// The sound tracks of an MKV/WebM film, read from its first MB: (number, language, name, codec, is default).
pub fn mkv_audio_tracks(data: &[u8]) -> Vec<(u64, String, String, String, bool)> {
    // An element id: 1 to 4 bytes, the marker bits stay in.
    fn id_at(d: &[u8], p: usize) -> Option<(u32, usize)> {
        let b = *d.get(p)?;
        let len = b.leading_zeros() as usize + 1;
        if len > 4 || p + len > d.len() {
            return None;
        }
        Some((d[p..p + len].iter().fold(0u32, |a, &x| (a << 8) | x as u32), len))
    }
    // A size: 1 to 8 bytes, the marker bit comes off. None = unknown size.
    fn size_at(d: &[u8], p: usize) -> Option<(Option<u64>, usize)> {
        let b = *d.get(p)?;
        let len = b.leading_zeros() as usize + 1;
        if len > 8 || p + len > d.len() {
            return None;
        }
        let mut v = (b as u64) & ((1u64 << (8 - len)) - 1);
        let mut all_ones = v == (1u64 << (8 - len)) - 1;
        for &x in &d[p + 1..p + len] {
            v = (v << 8) | x as u64;
            all_ones &= x == 0xff;
        }
        Some((if all_ones { None } else { Some(v) }, len))
    }
    fn uint(d: &[u8]) -> u64 {
        d.iter().fold(0u64, |a, &x| (a << 8) | x as u64)
    }
    fn text(d: &[u8]) -> String {
        String::from_utf8_lossy(d).trim_end_matches('\0').trim().to_string()
    }
    // Walks the children of one element: calls `f(id, body)` for each; stops at the end or at what doesn't fit.
    fn children(d: &[u8], f: &mut dyn FnMut(u32, &[u8]) -> bool) {
        let mut p = 0;
        while p < d.len() {
            let Some((id, il)) = id_at(d, p) else { return };
            let Some((size, sl)) = size_at(d, p + il) else { return };
            let start = p + il + sl;
            let end = match size {
                Some(s) => start.saturating_add(s as usize).min(d.len()),
                None => d.len(),
            };
            if start > d.len() || !f(id, &d[start..end]) {
                return;
            }
            p = end;
        }
    }
    const SEGMENT: u32 = 0x18538067;
    const TRACKS: u32 = 0x1654AE6B;
    const CLUSTER: u32 = 0x1F43B675;
    const ENTRY: u32 = 0xAE;
    let mut out = Vec::new();
    if !data.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return out;
    }
    children(data, &mut |id, body| {
        if id == SEGMENT {
            children(body, &mut |id, body| {
                if id == CLUSTER {
                    return false; // the tracks come before the first cluster
                }
                if id == TRACKS {
                    children(body, &mut |id, body| {
                        if id == ENTRY {
                            let (mut number, mut kind, mut lang, mut name, mut codec, mut default) = (0u64, 0u64, String::new(), String::new(), String::new(), true);
                            children(body, &mut |id, v| {
                                match id {
                                    0xD7 => number = uint(v),
                                    0x83 => kind = uint(v),
                                    0x86 => codec = text(v),
                                    0x22B59C => { if lang.is_empty() { lang = text(v) } }
                                    0x22B59D => lang = text(v),
                                    0x536E => name = text(v),
                                    0x88 => default = uint(v) != 0,
                                    _ => {}
                                }
                                true
                            });
                            if kind == 2 {
                                out.push((number, lang, name, codec, default));
                            }
                        }
                        true
                    });
                    return false;
                }
                true
            });
            return false;
        }
        true
    });
    out
}

/// Whether a film's container lists a sound track, from its first and last few MB (MKV/WebM, MP4/MOV, AVI).
/// Used when the built-in player shows the picture but decodes no sound (e.g. AC3/DTS sound in many films).
pub fn has_audio_track(data: &[u8]) -> bool {
    let find_all = |pat: &[u8]| data.windows(pat.len()).enumerate().filter(|(_, w)| *w == pat).map(|(i, _)| i).collect::<Vec<_>>();
    // MKV/WebM: a CodecID element (0x86, one-byte size) whose value starts with "A_" (A_AC3, A_DTS, A_AAC, …).
    if data.windows(4).any(|w| w[0] == 0x86 && (0x81..=0x9f).contains(&w[1]) && &w[2..4] == b"A_") {
        return true;
    }
    // …also when the muxer wrote the size in a longer form: look for the codec names themselves.
    const MKV_AUDIO: [&[u8]; 12] = [b"A_AC3", b"A_EAC3", b"A_DTS", b"A_TRUEHD", b"A_AAC", b"A_OPUS", b"A_VORBIS", b"A_FLAC", b"A_MPEG/", b"A_PCM/", b"A_MLP", b"A_ALAC"];
    if data.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) && MKV_AUDIO.iter().any(|c| data.windows(c.len()).any(|w| w == *c)) {
        return true;
    }
    // MP4/MOV: a sound sample description inside an "stsd" box.
    const SOUND: [&[u8; 4]; 18] = [
        b"mp4a", b"ac-3", b"ec-3", b"ac-4", b"dtsc", b"dtsh", b"dtsl", b"dtse", b"dtsx", b"Opus", b"fLaC", b"mlpa", b"alac", b".mp3", b"sowt", b"twos", b"lpcm", b"samr",
    ];
    for i in find_all(b"stsd") {
        let end = (i + 64).min(data.len());
        if SOUND.iter().any(|f| data[i..end].windows(4).any(|w| w == &f[..])) {
            return true;
        }
    }
    // AVI: a stream header of type "auds".
    find_all(b"strh").into_iter().any(|i| data.get(i + 8..i + 12) == Some(b"auds"))
}

/// All files in `dir` and its subfolders: (path, "Folder/sub/name", size). Stops after 1001 files.
fn collect_files(dir: &Path, rel: &str, out: &mut Vec<(PathBuf, String, u64)>, depth: usize) {
    if depth > 20 || out.len() > 1000 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        let r = format!("{rel}/{name}");
        if meta.is_dir() {
            collect_files(&e.path(), &r, out, depth + 1);
        } else if meta.is_file() {
            out.push((e.path(), r, meta.len()));
            if out.len() > 1000 {
                return;
            }
        }
    }
}

/// A profile background: a small picture (data: URL), a ready-made one ("g:name") or a colour ("c:#rrggbb").
fn clean_banner(b: &str) -> Option<String> {
    let ok = if b.starts_with("data:image/") {
        b.len() <= 200_000
    } else if let Some(id) = b.strip_prefix("g:") {
        !id.is_empty() && id.len() <= 24 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    } else if let Some(hex) = b.strip_prefix("c:#") {
        hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit())
    } else {
        false
    };
    ok.then(|| b.to_string())
}

/// "@everyone" in a group message notifies all the members, also in muted chats.
fn mentions_everyone(text: &str) -> bool {
    let t = text.to_lowercase();
    let key = "@everyone";
    let mut from = 0;
    while let Some(i) = t[from..].find(key) {
        let end = from + i + key.len();
        if t[end..].chars().next().is_none_or(|c| !c.is_alphanumeric()) {
            return true;
        }
        from = end;
    }
    false
}

/// A profile picture: a still picture, a GIF, or a short clip UaN made from a big GIF.
fn is_pic(a: &str) -> bool {
    a.starts_with("data:image/") || a.starts_with("data:video/webm")
}

/// A profile's colour and aura: "#rrggbb|aura" (either part may be empty).
fn clean_look(l: &str) -> String {
    let (c, a) = l.split_once('|').unwrap_or((l, ""));
    let c = if c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit()) { c } else { "" };
    let a = if ["glow", "spin", "rainbow", "pulse"].contains(&a) { a } else { "" };
    if c.is_empty() && a.is_empty() { String::new() } else { format!("{c}|{a}") }
}
