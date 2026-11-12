//! Plays films in VLC when the built-in player can't handle a format. VLC streams from UaN's local
//! player server (nothing is downloaded) and is remote-controlled through VLC's own web interface on
//! 127.0.0.1, so watch together stays in sync both ways.

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::{Child, Command},
    sync::Mutex,
    time::Duration,
};

pub struct Session {
    child: Child,
    port: u16,
    password: String,
}

#[derive(Default)]
pub struct Vlc {
    sessions: Mutex<HashMap<String, Session>>,
}

/// Program and arguments that start VLC on this system, if it is installed.
pub fn find() -> Option<(PathBuf, Vec<String>)> {
    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Some(base) = std::env::var_os(var) {
                candidates.push(PathBuf::from(base).join("VideoLAN").join("VLC").join("vlc.exe"));
            }
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join("Programs").join("VideoLAN").join("VLC").join("vlc.exe"));
        }
        candidates.into_iter().find(|p| p.exists()).map(|p| (p, Vec::new()))
    }
    #[cfg(not(windows))]
    {
        let path = std::env::var_os("PATH").unwrap_or_default();
        for dir in std::env::split_paths(&path).chain([PathBuf::from("/snap/bin"), PathBuf::from("/usr/bin")]) {
            let p = dir.join("vlc");
            if p.exists() {
                return Some((p, Vec::new()));
            }
        }
        for flatpak in ["/var/lib/flatpak/exports/bin/org.videolan.VLC"] {
            if std::path::Path::new(flatpak).exists() {
                return Some((PathBuf::from(flatpak), Vec::new()));
            }
        }
        if let Some(home) = dirs::home_dir() {
            let p = home.join(".local/share/flatpak/exports/bin/org.videolan.VLC");
            if p.exists() {
                return Some((p, Vec::new()));
            }
        }
        None
    }
}

fn free_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0").ok()?.local_addr().ok().map(|a| a.port())
}

impl Vlc {
    /// Starts VLC on `url`. With `paused`, it waits for watch together to start the film.
    pub fn open(&self, url: &str, title: &str, paused: bool) -> Result<String, String> {
        let (program, mut args) = find().ok_or("VLC isn't installed on this computer.")?;
        let port = free_port().ok_or("No free port for VLC.")?;
        let password = uuid::Uuid::new_v4().simple().to_string();
        args.extend([
            "--no-one-instance".to_string(),
            "--no-qt-privacy-ask".to_string(),
            "--extraintf=http".to_string(),
            "--http-host=127.0.0.1".to_string(),
            format!("--http-port={port}"),
            format!("--http-password={password}"),
            format!("--meta-title={title}"),
            "--no-video-title-show".to_string(),
        ]);
        if paused {
            args.push("--start-paused".to_string());
        }
        // Tests can run VLC without a window (e.g. "--intf=dummy --vout=dummy --aout=dummy").
        if let Ok(extra) = std::env::var("UAN_VLC_EXTRA") {
            args.extend(extra.split_whitespace().map(String::from));
        }
        args.push(url.to_string());
        let child = Command::new(&program).args(&args).spawn().map_err(|e| format!("Couldn't start VLC: {e}"))?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        self.sessions.lock().unwrap().insert(id.clone(), Session { child, port, password });
        Ok(id)
    }

    fn endpoint(&self, id: &str) -> Option<(u16, String, bool)> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions.get_mut(id)?;
        let alive = matches!(s.child.try_wait(), Ok(None));
        Some((s.port, s.password.clone(), alive))
    }

    async fn get(&self, id: &str, query: &str) -> Result<Value, String> {
        let (port, password, alive) = self.endpoint(id).ok_or("VLC session ended.")?;
        if !alive {
            return Err("closed".into());
        }
        let client = reqwest::Client::builder().timeout(Duration::from_secs(3)).build().map_err(|e| e.to_string())?;
        let url = format!("http://127.0.0.1:{port}/requests/status.json{query}");
        let r = client.get(url).basic_auth("", Some(password)).send().await.map_err(|e| e.to_string())?;
        r.json::<Value>().await.map_err(|e| e.to_string())
    }

    /// {running, ready, state: playing|paused|stopped, time (seconds, precise), length}
    pub async fn status(&self, id: &str) -> Value {
        match self.get(id, "").await {
            Ok(v) => {
                let length = v["length"].as_f64().unwrap_or(0.0);
                let pos = v["position"].as_f64().unwrap_or(0.0);
                let time = if length > 0.0 { pos * length } else { v["time"].as_f64().unwrap_or(0.0) };
                json!({ "running": true, "ready": true, "state": v["state"], "time": time, "length": length })
            }
            Err(e) if e == "closed" || e == "VLC session ended." => json!({ "running": false }),
            // VLC is still starting up its web interface.
            Err(_) => json!({ "running": true, "ready": false }),
        }
    }

    pub async fn command(&self, id: &str, cmd: &str, value: f64) -> Result<(), String> {
        let q = match cmd {
            "play" => "?command=pl_forceresume".to_string(),
            "pause" => "?command=pl_forcepause".to_string(),
            "seek" => format!("?command=seek&val={}", value.max(0.0).round() as u64),
            _ => return Err("Unknown VLC command.".into()),
        };
        self.get(id, &q).await.map(|_| ())
    }

    pub fn close(&self, id: &str) {
        if let Some(mut s) = self.sessions.lock().unwrap().remove(id) {
            let _ = s.child.kill();
        }
    }
}
