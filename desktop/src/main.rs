// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod node;

use node::{FileMeta, Node, Party, Transfer};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, Wry,
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt;

type CmdResult<T> = Result<T, String>;

/// `--profile NAME` runs a separate identity with its own data (handy for testing on one PC).
struct Profile {
    name: Option<String>,
    dir: PathBuf,
}

/// Base URL of the local player server (Linux), or None to use the media:// scheme (Windows).
struct MediaBase(Option<String>);

/// Built-in playback self-test (local and CI builds only): a video to play on start-up.
struct SelfTest(Option<FileMeta>);

struct TrayItems {
    autostart: CheckMenuItem<Wry>,
}

fn arg_value(flag: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let profile = app.state::<Profile>();
    let title = match &profile.name {
        Some(p) => format!("UaN ({p})"),
        None => "UaN".to_string(),
    };
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(820.0, 540.0)
        .min_inner_size(560.0, 400.0)
        .center();
    if profile.name.is_some() {
        builder = builder.data_directory(profile.dir.join("webview"));
    }
    let _ = builder.build();
}

pub fn sync_tray(app: &AppHandle) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.autostart.set_checked(app.autolaunch().is_enabled().unwrap_or(false));
    }
}

// ---------- Commands ----------

#[tauri::command]
fn state(node: State<'_, Arc<Node>>, profile: State<'_, Profile>, media: State<'_, MediaBase>, selftest: State<'_, SelfTest>, app: AppHandle) -> Value {
    json!({
        "id": node.id(),
        "code": node.friend_code(),
        "name": node.my_name(),
        "profile": node.my_profile(),
        "mailbox": node.mailbox_url(),
        "profileName": profile.name,
        "autostart": app.autolaunch().is_enabled().unwrap_or(false),
        "mediaBase": media.0,
        "platform": std::env::consts::OS,
        "version": app.package_info().version.to_string(),
        "selftest": selftest.0,
    })
}

#[tauri::command]
fn set_name(node: State<'_, Arc<Node>>, name: String) -> CmdResult<()> {
    node.set_name(&name)
}

#[tauri::command]
fn set_profile(node: State<'_, Arc<Node>>, name: String, status: String, avatar: Option<String>) -> CmdResult<()> {
    node.set_profile(&name, Some(&status), avatar.as_deref())
}

#[tauri::command]
fn set_mailbox(node: State<'_, Arc<Node>>, url: String) -> CmdResult<()> {
    node.set_mailbox(&url)
}

#[tauri::command]
async fn check_mailbox(node: State<'_, Arc<Node>>) -> CmdResult<()> {
    node.mailbox_poll().await;
    Ok(())
}

const RELEASES_API: &str = "https://api.github.com/repos/Fish0969/UaN-Sender/releases/latest";

fn version_tuple(v: &str) -> (u64, u64, u64) {
    let mut it = v.trim_start_matches('v').split('.').map(|p| p.parse::<u64>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

/// Which download fits this install: Windows installer, AppImage, or .deb.
fn update_kind() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if std::env::var_os("APPIMAGE").is_some() {
        "appimage"
    } else {
        "deb"
    }
}

/// Looks for a newer release on GitHub. Returns null when up to date.
#[tauri::command]
async fn check_update(app: AppHandle) -> CmdResult<Value> {
    let client = reqwest::Client::builder().user_agent("UaN-updater").timeout(std::time::Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let rel: Value = client.get(RELEASES_API).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let tag = rel["tag_name"].as_str().unwrap_or_default().to_string();
    let current = app.package_info().version.to_string();
    if tag.is_empty() || version_tuple(&tag) <= version_tuple(&current) {
        return Ok(Value::Null);
    }
    let suffix = match update_kind() {
        "windows" => "_x64-setup.exe",
        "appimage" => ".AppImage",
        _ => ".deb",
    };
    let asset = rel["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"].as_str().map(|n| n.ends_with(suffix)).unwrap_or(false))).cloned();
    Ok(json!({
        "version": tag.trim_start_matches('v'),
        "page": rel["html_url"],
        "url": asset.as_ref().map(|a| a["browser_download_url"].clone()),
        "name": asset.as_ref().map(|a| a["name"].clone()),
    }))
}

/// Downloads the new version and replaces this one (the installer/package manager removes the old version).
#[tauri::command]
async fn install_update(app: AppHandle, url: String, name: String) -> CmdResult<()> {
    if !url.starts_with("https://github.com/Fish0969/UaN-Sender/releases/download/") {
        return Err("Unexpected download address.".into());
    }
    let client = reqwest::Client::builder().user_agent("UaN-updater").build().map_err(|e| e.to_string())?;
    let bytes = client.get(&url).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?.bytes().await.map_err(|e| e.to_string())?;
    let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || "._-".contains(*c)).collect();
    let tmp = std::env::temp_dir().join(if safe.is_empty() { "uan-update".to_string() } else { safe });
    std::fs::write(&tmp, &bytes).map_err(|e| format!("Couldn't save the update: {e}"))?;
    match update_kind() {
        "windows" => {
            // The installer replaces the installed version; we quit so it can.
            std::process::Command::new(&tmp).spawn().map_err(|e| format!("Couldn't start the installer: {e}"))?;
            app.exit(0);
        }
        "appimage" => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let target = std::path::PathBuf::from(std::env::var_os("APPIMAGE").unwrap());
                let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
                std::fs::copy(&tmp, target.with_extension("new")).map_err(|e| e.to_string())?;
                std::fs::rename(target.with_extension("new"), &target).map_err(|e| e.to_string())?;
                let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
                std::process::Command::new(&target).spawn().map_err(|e| e.to_string())?;
                app.exit(0);
            }
        }
        _ => {
            // .deb: install with the system's password prompt, then restart.
            let ok = std::process::Command::new("pkexec").args(["apt-get", "install", "-y"]).arg(&tmp).status().map(|s| s.success()).unwrap_or(false);
            if ok {
                let _ = std::process::Command::new("uan").spawn();
                app.exit(0);
            } else {
                let _ = std::process::Command::new("xdg-open").arg(&tmp).spawn();
            }
        }
    }
    Ok(())
}

/// Self-test result: written to UAN_SELFTEST_OUT, then the app exits (0 = ok).
#[tauri::command]
fn selftest_result(app: AppHandle, ok: bool, detail: String) {
    if let Ok(out) = std::env::var("UAN_SELFTEST_OUT") {
        let _ = std::fs::write(out, format!("{} {}\n", if ok { "ok" } else { "fail" }, detail));
        app.exit(if ok { 0 } else { 1 });
    }
}

#[tauri::command]
fn contacts(node: State<'_, Arc<Node>>) -> Value {
    node.contacts()
}

#[tauri::command]
fn add_friend(node: State<'_, Arc<Node>>, code: String) -> CmdResult<String> {
    node.add_friend(&code)
}

#[tauri::command]
fn friend_action(node: State<'_, Arc<Node>>, id: String, action: String) -> CmdResult<()> {
    node.friend_action(&id, &action)
}

#[tauri::command]
fn messages(node: State<'_, Arc<Node>>, chat: String, limit: Option<usize>) -> Vec<Value> {
    node.messages(&chat, limit.unwrap_or(300))
}

#[tauri::command]
fn search(node: State<'_, Arc<Node>>, query: String, kind: String, from: String, chat: String, since: i64) -> Vec<Value> {
    node.search(&query, &kind, &from, &chat, since)
}

#[tauri::command]
fn send_text(node: State<'_, Arc<Node>>, chats: Vec<String>, text: String) -> CmdResult<()> {
    node.send(&chats, Some(text), None)
}

#[tauri::command]
async fn pick_and_send(app: AppHandle, node: State<'_, Arc<Node>>, chats: Vec<String>, text: String) -> CmdResult<usize> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title("Choose files to send").pick_files(move |files| {
        let _ = tx.send(files);
    });
    let Some(files) = rx.await.ok().flatten() else { return Ok(0) };
    let paths: Vec<PathBuf> = files.into_iter().filter_map(|f| f.into_path().ok()).collect();
    node.share_files(paths, &chats, Some(text))
}

#[tauri::command]
fn send_paths(node: State<'_, Arc<Node>>, paths: Vec<String>, chats: Vec<String>, text: String) -> CmdResult<usize> {
    node.share_files(paths.into_iter().map(PathBuf::from).collect(), &chats, Some(text))
}

#[tauri::command]
fn create_group(node: State<'_, Arc<Node>>, name: String, members: Vec<String>) -> CmdResult<String> {
    node.create_group(&name, &members)
}

#[tauri::command]
fn group_action(node: State<'_, Arc<Node>>, group: String, action: String, ids: Vec<String>, name: String) -> CmdResult<()> {
    node.group_action(&group, &action, &ids, &name)
}

#[tauri::command]
fn download(node: State<'_, Arc<Node>>, file: FileMeta, chat: Option<String>) -> CmdResult<String> {
    node.download(file, chat.unwrap_or_default())
}

#[tauri::command]
async fn party_probe(node: State<'_, Arc<Node>>, members: Vec<String>) -> CmdResult<Value> {
    Ok(node.probe_members(members).await)
}

#[tauri::command]
fn party_create(node: State<'_, Arc<Node>>, group: String, file: FileMeta, members: Vec<String>, seeder: String) -> CmdResult<String> {
    node.create_party(&group, file, members, seeder)
}

#[tauri::command]
fn party_join(node: State<'_, Arc<Node>>, id: String) -> CmdResult<()> {
    node.join_party(&id)
}

#[tauri::command]
fn party_leave(node: State<'_, Arc<Node>>, id: String, end: Option<bool>) {
    node.leave_party(&id, end.unwrap_or(false))
}

#[tauri::command]
fn party_control(node: State<'_, Arc<Node>>, id: String, state: String, position: f64) -> CmdResult<()> {
    node.control_party(&id, &state, position)
}

#[tauri::command]
fn stream_focus(node: State<'_, Arc<Node>>, file_id: String, position: u64) {
    node.stream_focus(&file_id, position)
}

#[tauri::command]
fn party_buffering(node: State<'_, Arc<Node>>, id: String, buffering: bool) {
    node.set_buffering(&id, buffering)
}

#[tauri::command]
fn parties(node: State<'_, Arc<Node>>) -> Vec<Party> {
    node.parties()
}

#[tauri::command]
fn transfers(node: State<'_, Arc<Node>>) -> Vec<Transfer> {
    node.snapshot()
}

#[tauri::command]
async fn transfer_action(node: State<'_, Arc<Node>>, id: String, action: String) -> CmdResult<()> {
    node.transfer_action(&id, &action).await
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> CmdResult<bool> {
    let al = app.autolaunch();
    let r = if enabled { al.enable() } else { al.disable() };
    r.map_err(|e| format!("Couldn't change the startup setting: {e}"))?;
    sync_tray(&app);
    Ok(al.is_enabled().unwrap_or(false))
}

fn main() {
    let start_hidden = std::env::args().any(|a| a == "--hidden");
    // Side-by-side test identities only exist in local builds made with --features test-profiles.
    let profile_name = (if cfg!(feature = "test-profiles") { arg_value("--profile") } else { None }).map(|p| p.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect::<String>()).filter(|p| !p.is_empty());
    let base = std::env::var_os("UAN_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("UaN"));
    let dir = match &profile_name {
        Some(p) => base.join("profiles").join(p),
        None => base,
    };

    let mut builder = tauri::Builder::default();
    if profile_name.is_none() {
        // Only one main UaN at a time; test profiles can run side by side.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)));
    }
    builder
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .register_asynchronous_uri_scheme_protocol("media", |ctx, request, responder| {
            let node = ctx.app_handle().state::<Arc<Node>>().inner().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(node::media(node, request).await);
            });
        })
        .setup(move |app| {
            let node = tauri::async_runtime::block_on(Node::start(app.handle().clone(), dir.clone()))?;
            node.resume_downloads();
            // WebKitGTK (Linux) can't stream video from custom schemes, so the player uses a local HTTP server there.
            let use_http = cfg!(target_os = "linux") || std::env::var("UAN_HTTP_MEDIA").is_ok();
            let media_base = if use_http { tauri::async_runtime::block_on(node::start_media_server(node.clone())).ok() } else { None };
            app.manage(MediaBase(media_base));
            let selftest = if cfg!(feature = "test-profiles") {
                std::env::var("UAN_SELFTEST_VIDEO").ok().and_then(|p| node.selftest_file(&p).ok())
            } else {
                None
            };
            app.manage(SelfTest(selftest));
            app.manage(node);
            let is_profile = profile_name.is_some();
            app.manage(Profile { name: profile_name.clone(), dir });

            let tooltip = match &profile_name {
                Some(p) => format!("UaN ({p})"),
                None => "UaN".into(),
            };
            let open = MenuItemBuilder::with_id("open", "Open UaN").build(app)?;
            let autostart = CheckMenuItemBuilder::with_id("autostart", "Start with Windows")
                .checked(app.autolaunch().is_enabled().unwrap_or(false))
                .enabled(!is_profile)
                .build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit UaN").build(app)?;
            let menu = MenuBuilder::new(app).item(&open).item(&autostart).separator().item(&quit).build()?;
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip(tooltip)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "autostart" => {
                        let al = app.autolaunch();
                        let _ = if al.is_enabled().unwrap_or(false) { al.disable() } else { al.enable() };
                        sync_tray(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            app.manage(TrayItems { autostart });
            if !is_profile && app.autolaunch().is_enabled().unwrap_or(false) {
                let _ = app.autolaunch().enable(); // refresh the path after an update
            }

            if !start_hidden {
                show_main(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            state,
            set_name,
            set_profile,
            set_mailbox,
            check_mailbox,
            contacts,
            add_friend,
            friend_action,
            messages,
            search,
            party_probe,
            party_create,
            party_join,
            party_leave,
            party_control,
            parties,
            stream_focus,
            party_buffering,
            send_text,
            pick_and_send,
            send_paths,
            create_group,
            group_action,
            download,
            transfers,
            transfer_action,
            set_autostart,
            check_update,
            install_update,
            selftest_result,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start UaN")
        .run(|_app, event| {
            // Closing the window keeps UaN running in the tray, so friends can still reach you.
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
