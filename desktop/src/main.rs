// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod node;
mod vlc;

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

/// The local player server (always on): external players like VLC stream from here.
struct HttpBase(String);

/// Built-in playback self-test (local and CI builds only): a video to play on start-up.
struct SelfTest(Option<FileMeta>);

struct TrayItems {
    autostart: CheckMenuItem<Wry>,
}

fn arg_value(flag: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

/// Tests set UAN_INVISIBLE: the window lives off-screen, with no taskbar button, tray icon or notifications.
fn invisible() -> bool {
    std::env::var_os("UAN_INVISIBLE").is_some()
}

const ICON_SIDE: u32 = 128;

/// The app icon the user picked in Settings (raw RGBA, ICON_SIDE x ICON_SIDE), if any.
fn custom_icon(dir: &std::path::Path) -> Option<tauri::image::Image<'static>> {
    let rgba = std::fs::read(dir.join("appicon.rgba")).ok()?;
    (rgba.len() == (ICON_SIDE * ICON_SIDE * 4) as usize).then(|| tauri::image::Image::new_owned(rgba, ICON_SIDE, ICON_SIDE))
}

fn apply_icon(app: &AppHandle) {
    let dir = app.state::<Profile>().dir.clone();
    let Some(icon) = custom_icon(&dir).or_else(|| app.default_window_icon().cloned().map(|i| i.to_owned())) else { return };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_icon(icon.clone());
    }
    if let Some(t) = app.tray_by_id("tray") {
        let _ = t.set_icon(Some(icon));
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if invisible() {
            return;
        }
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
        .min_inner_size(560.0, 400.0);
    builder = if invisible() { builder } else { builder.center() };
    if profile.name.is_some() {
        builder = builder.data_directory(profile.dir.join("webview"));
    }
    if invisible() {
        builder = builder.position(-30000.0, -30000.0).skip_taskbar(true).focused(false);
    }
    if let Ok(w) = builder.build() {
        if invisible() {
            // Windows may pull a new window back onto the screen; push it away again.
            let _ = w.set_position(tauri::PhysicalPosition::new(-32000, -32000));
        }
    }
    apply_icon(app);
}

pub fn sync_tray(app: &AppHandle) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.autostart.set_checked(app.autolaunch().is_enabled().unwrap_or(false));
    }
}

// ---------- Commands ----------

#[tauri::command]
fn state(node: State<'_, Arc<Node>>, profile: State<'_, Profile>, media: State<'_, MediaBase>, http: State<'_, HttpBase>, selftest: State<'_, SelfTest>, app: AppHandle) -> Value {
    json!({
        "id": node.id(),
        "code": node.friend_code(),
        "name": node.my_name(),
        "profile": node.my_profile(),
        "mailbox": node.mailbox_url(),
        "profileName": profile.name,
        "autostart": app.autolaunch().is_enabled().unwrap_or(false),
        "mediaBase": media.0,
        "httpBase": http.0,
        "vlc": vlc::find().is_some(),
        "selftestVlc": std::env::var("UAN_SELFTEST_VLC").is_ok(),
        "platform": std::env::consts::OS,
        "version": app.package_info().version.to_string(),
        "selftest": selftest.0,
        "autodl": node.autodl().0,
        "autodlGb": node.autodl().1,
        "typing": node.privacy().0,
        "receipts": node.privacy().1,
        "customIcon": profile.dir.join("appicon.rgba").exists(),
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

/// Small updates for the AppImage: the AppImage carries big libraries (video, WebKit) that rarely change,
/// so an update only downloads the new UaN program (a few MB) into this folder. The AppImage starts the
/// newest one found here, with its own libraries.
#[cfg_attr(not(unix), allow(dead_code))]
fn delta_dir() -> PathBuf {
    dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("UaN").join("bin")
}

/// The UaN program in `delta_dir` newer than this one, if any (and removes older ones).
#[cfg(target_os = "linux")]
fn newest_delta() -> Option<(PathBuf, (u64, u64, u64))> {
    let own = version_tuple(env!("CARGO_PKG_VERSION"));
    let mut best: Option<(PathBuf, (u64, u64, u64))> = None;
    for e in std::fs::read_dir(delta_dir()).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(v) = name.strip_prefix("uan-").filter(|v| !v.ends_with(".tmp")) else { continue };
        let v = version_tuple(v);
        if v <= own {
            let _ = std::fs::remove_file(e.path());
        } else if best.as_ref().map(|b| v > b.1).unwrap_or(true) {
            best = Some((e.path(), v));
        }
    }
    best
}

/// Inside the AppImage: hand over to a newer UaN program downloaded by a small update.
#[cfg(target_os = "linux")]
fn run_newer_delta() {
    if std::env::var_os("APPIMAGE").is_none() {
        return;
    }
    let Some((path, v)) = newest_delta() else { return };
    let expect = format!("{}.{}.{}", v.0, v.1, v.2);
    if !program_works(&path, &expect) {
        let _ = std::fs::remove_file(&path);
        return;
    }
    use std::os::unix::process::CommandExt;
    let err = std::process::Command::new(&path).args(std::env::args_os().skip(1)).exec();
    eprintln!("Couldn't start the updated UaN: {err}");
}

/// Starts UaN again after an update, with the same arguments (but showing the window: you just clicked
/// Update). The new copy waits a moment (--after-update) so this one has quit by then.
fn relaunch_later(program: &std::path::Path) {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).filter(|a| a != "--hidden" && a != "--after-update").collect();
    let _ = std::process::Command::new(program).args(&args).arg("--after-update").spawn();
}

/// Does the program at `path` start, and is it version `expect`? Runs it with --uan-version.
fn program_works(path: &std::path::Path, expect: &str) -> bool {
    let mut cmd = std::process::Command::new(path);
    cmd.arg("--uan-version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // no console window
    }
    cmd.output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == expect)
        .unwrap_or(false)
}

/// Windows: replaces the running program with the new one, in place. Windows lets a running program be
/// renamed (not overwritten), so: uan.exe -> uan.exe.old, new -> uan.exe. No installer, no uninstaller;
/// settings, friends and messages stay where they are. The old file is deleted at the next start.
#[cfg(windows)]
fn replace_self(program: &[u8], version: &str) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("No program folder.")?;
    let new = dir.join("uan-update.tmp");
    let old = exe.with_extension("exe.old");
    std::fs::write(&new, program).map_err(|_| "no-write".to_string())?;
    if !program_works(&new, version) {
        let _ = std::fs::remove_file(&new);
        return Err("The downloaded update doesn't start. Nothing was changed.".into());
    }
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&exe, &old).map_err(|e| {
        let _ = std::fs::remove_file(&new);
        format!("Couldn't replace UaN: {e}")
    })?;
    if let Err(e) = std::fs::rename(&new, &exe) {
        let _ = std::fs::rename(&old, &exe); // put the old one back
        return Err(format!("Couldn't replace UaN: {e}"));
    }
    // Keep "Installed apps" in Windows Settings showing the right version (not for local test builds).
    if cfg!(feature = "test-profiles") {
        return Ok(());
    }
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("reg")
        .args(["add", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\UaN", "/v", "DisplayVersion", "/d", version, "/f"])
        .creation_flags(0x0800_0000)
        .status();
    Ok(())
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
async fn check_update(app: AppHandle, profile: State<'_, Profile>) -> CmdResult<Value> {
    if profile.name.is_some() {
        return Ok(Value::Null); // side-by-side test identities never replace the real UaN
    }
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
    let find = |pred: &dyn Fn(&str) -> bool| rel["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"].as_str().map(pred).unwrap_or(false))).cloned();
    let mut asset = find(&|n: &str| n.ends_with(suffix));
    let installer = asset.clone();
    // Only the new program file is needed (a few MB), not a whole installer or package.
    let small = match update_kind() {
        "appimage" => find(&|n: &str| n == "uan-linux-x86_64.gz"),
        "windows" => find(&|n: &str| n == "uan-windows-x86_64.exe.gz"),
        _ => None,
    };
    if small.is_some() {
        asset = small;
    }
    Ok(json!({
        "version": tag.trim_start_matches('v'),
        "page": rel["html_url"],
        "url": asset.as_ref().map(|a| a["browser_download_url"].clone()),
        "name": asset.as_ref().map(|a| a["name"].clone()),
        "size": asset.as_ref().map(|a| a["size"].clone()),
        "installer": installer.as_ref().map(|a| a["browser_download_url"].clone()),
        "installerName": installer.as_ref().map(|a| a["name"].clone()),
    }))
}

/// Downloads the new version and replaces this one (the installer/package manager removes the old version).
#[tauri::command]
async fn install_update(app: AppHandle, url: String, name: String) -> CmdResult<()> {
    // Local test builds can also update from a file (file:///…/v1.2.3/name), to test this without a release.
    let local = cfg!(feature = "test-profiles") && url.starts_with("file:///");
    if !url.starts_with("https://github.com/Fish0969/UaN-Sender/releases/download/") && !local {
        return Err("Unexpected download address.".into());
    }
    let bytes: Vec<u8> = if local {
        std::fs::read(url.trim_start_matches("file:///")).map_err(|e| e.to_string())?
    } else {
        let client = reqwest::Client::builder().user_agent("UaN-updater").build().map_err(|e| e.to_string())?;
        client.get(&url).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?.bytes().await.map_err(|e| e.to_string())?.to_vec()
    };
    let version = url.rsplit('/').nth(1).unwrap_or_default().trim_start_matches('v').to_string();
    let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || "._-".contains(*c)).collect();
    let tmp = std::env::temp_dir().join(if safe.is_empty() { "uan-update".to_string() } else { safe.clone() });
    std::fs::write(&tmp, &bytes).map_err(|e| format!("Couldn't save the update: {e}"))?;
    match update_kind() {
        #[cfg(windows)]
        "windows" if safe == "uan-windows-x86_64.exe.gz" => {
            use std::io::Read;
            let mut program = Vec::new();
            flate2::read::GzDecoder::new(&bytes[..]).read_to_end(&mut program).map_err(|e| format!("The update is damaged: {e}"))?;
            match replace_self(&program, &version) {
                Ok(()) => {
                    relaunch_later(&std::env::current_exe().map_err(|e| e.to_string())?);
                    app.exit(0);
                }
                // The program folder isn't writable (installed for all users): use the installer.
                Err(e) if e == "no-write" => return Err("no-write".into()),
                Err(e) => return Err(e),
            }
        }
        "windows" => {
            // The installer replaces the installed version; we quit so it can.
            std::process::Command::new(&tmp).spawn().map_err(|e| format!("Couldn't start the installer: {e}"))?;
            app.exit(0);
        }
        "appimage" if safe == "uan-linux-x86_64.gz" => {
            #[cfg(target_os = "linux")]
            {
                use std::io::Read;
                use std::os::unix::fs::PermissionsExt;
                let mut program = Vec::new();
                flate2::read::GzDecoder::new(&bytes[..]).read_to_end(&mut program).map_err(|e| format!("The update is damaged: {e}"))?;
                let dir = delta_dir();
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let tmp_bin = dir.join(format!("uan-{version}.tmp"));
                std::fs::write(&tmp_bin, &program).map_err(|e| format!("Couldn't save the update: {e}"))?;
                let _ = std::fs::set_permissions(&tmp_bin, std::fs::Permissions::from_mode(0o755));
                if !program_works(&tmp_bin, &version) {
                    let _ = std::fs::remove_file(&tmp_bin);
                    return Err("This update needs the full download. Get the new AppImage from the website.".into());
                }
                std::fs::rename(&tmp_bin, dir.join(format!("uan-{version}"))).map_err(|e| e.to_string())?;
                relaunch_later(&PathBuf::from(std::env::var_os("APPIMAGE").unwrap()));
                app.exit(0);
            }
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
                // The full package contains the newest program itself; older small updates are dropped.
                let _ = std::fs::remove_dir_all(delta_dir());
                relaunch_later(&target);
                app.exit(0);
            }
        }
        _ => {
            // .deb: install with the system's password prompt, then restart.
            let ok = std::process::Command::new("pkexec").args(["apt-get", "install", "-y"]).arg(&tmp).status().map(|s| s.success()).unwrap_or(false);
            if ok {
                relaunch_later(std::path::Path::new("/usr/bin/uan"));
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
fn set_thumb(node: State<'_, Arc<Node>>, file_id: String, data: String) -> CmdResult<()> {
    node.set_thumb(&file_id, &data)
}

#[tauri::command]
fn set_autodl(node: State<'_, Arc<Node>>, on: bool, gb: u64) {
    node.set_autodl(on, gb)
}

// ---------- VLC ----------

#[tauri::command]
fn vlc_open(http: State<'_, HttpBase>, vlc: State<'_, vlc::Vlc>, url: String, title: String, paused: bool) -> CmdResult<String> {
    // Only films served by UaN itself.
    if http.0.is_empty() || !url.starts_with(&format!("{}/", http.0)) {
        return Err("Unexpected address.".into());
    }
    let title: String = title.chars().filter(|c| !c.is_control()).take(120).collect();
    vlc.open(&url, &title, paused)
}

#[tauri::command]
async fn vlc_status(vlc: State<'_, vlc::Vlc>, id: String) -> CmdResult<Value> {
    Ok(vlc.status(&id).await)
}

#[tauri::command]
async fn vlc_command(vlc: State<'_, vlc::Vlc>, id: String, cmd: String, value: f64) -> CmdResult<()> {
    vlc.command(&id, &cmd, value).await
}

/// Opens the VLC download page in the browser.
#[tauri::command]
fn open_vlc_site() {
    let url = "https://www.videolan.org/vlc/";
    let opener = if cfg!(windows) { "explorer" } else { "xdg-open" };
    let _ = std::process::Command::new(opener).arg(url).spawn();
}

#[tauri::command]
fn clear_chat(node: State<'_, Arc<Node>>, chat: String, everyone: bool) -> CmdResult<()> {
    node.clear_chat(&chat, everyone)
}

#[tauri::command]
fn set_privacy(node: State<'_, Arc<Node>>, typing: bool, receipts: bool) {
    node.set_privacy(typing, receipts)
}

#[tauri::command]
fn typing(node: State<'_, Arc<Node>>, chat: String) {
    node.typing(&chat)
}

#[tauri::command]
fn read_upto(node: State<'_, Arc<Node>>, chat: String, id: String) {
    node.read_upto(&chat, &id)
}

#[tauri::command]
fn reads(node: State<'_, Arc<Node>>, chat: String) -> Value {
    node.reads(&chat)
}

/// Sets the app icon (window, taskbar and tray) to a picture drawn by the window: base64 of raw RGBA,
/// 128 x 128. None goes back to the built-in icon.
#[tauri::command]
fn set_app_icon(app: AppHandle, profile: State<'_, Profile>, rgba: Option<String>, png: Option<String>) -> CmdResult<()> {
    let path = profile.dir.join("appicon.rgba");
    let ico = profile.dir.join("appicon.ico");
    match rgba {
        Some(b64) => {
            let raw = data_encoding::BASE64.decode(b64.as_bytes()).map_err(|e| e.to_string())?;
            if raw.len() != (ICON_SIDE * ICON_SIDE * 4) as usize {
                return Err("Unexpected icon size.".into());
            }
            std::fs::write(&path, raw).map_err(|e| e.to_string())?;
            // A 256 px .ico for the shortcuts (desktop, Start menu, pinned on the taskbar).
            if let Some(png) = png.and_then(|p| data_encoding::BASE64.decode(p.as_bytes()).ok()).filter(|p| p.starts_with(b"\x89PNG")) {
                let mut f = vec![0u8, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 32, 0];
                f.extend((png.len() as u32).to_le_bytes());
                f.extend(22u32.to_le_bytes());
                f.extend(&png);
                let _ = std::fs::write(&ico, f);
            }
        }
        None => {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(&ico);
        }
    }
    apply_icon(&app);
    // The taskbar shows the icon of the shortcut UaN is pinned with, so change the shortcuts too.
    if profile.name.is_none() {
        set_shortcut_icons(ico.exists().then_some(ico.as_path()));
    }
    Ok(())
}

/// Points UaN's shortcuts (desktop, Start menu, pinned on the taskbar) at `ico`, or back at the program.
#[cfg(windows)]
fn set_shortcut_icons(ico: Option<&std::path::Path>) {
    use std::os::windows::process::CommandExt;
    let Ok(exe) = std::env::current_exe() else { return };
    let q = |p: &std::path::Path| p.to_string_lossy().replace('\'', "''");
    let icon = match ico {
        Some(i) => format!("{},0", q(i)),
        None => format!("{},0", q(&exe)),
    };
    let script = format!(
        "$sh = New-Object -ComObject WScript.Shell; $exe = '{exe}'; \
         foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('Programs'), \"$env:APPDATA\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar\")) {{ \
           Get-ChildItem -LiteralPath $d -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {{ \
             $l = $sh.CreateShortcut($_.FullName); if ($l.TargetPath -ieq $exe) {{ $l.IconLocation = '{icon}'; $l.Save() }} }} }}; \
         ie4uinit.exe -show",
        exe = q(&exe),
    );
    let _ = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(0x0800_0000)
        .spawn();
}

#[cfg(not(windows))]
fn set_shortcut_icons(_ico: Option<&std::path::Path>) {}

/// The secret theme's picture, kept on this PC only (secret.jpg/.webp/.png in UaN's data folder).
#[tauri::command]
fn secret_picture(profile: State<'_, Profile>) -> Option<String> {
    for (ext, mime) in [("jpg", "image/jpeg"), ("webp", "image/webp"), ("png", "image/png")] {
        if let Ok(b) = std::fs::read(profile.dir.join(format!("secret.{ext}"))) {
            return Some(format!("data:{mime};base64,{}", data_encoding::BASE64.encode(&b)));
        }
    }
    None
}

#[tauri::command]
fn set_secret_picture(profile: State<'_, Profile>, jpeg: String) -> CmdResult<()> {
    let b = data_encoding::BASE64.decode(jpeg.as_bytes()).map_err(|e| e.to_string())?;
    if b.len() > 4_000_000 || !b.starts_with(&[0xff, 0xd8]) {
        return Err("That picture can't be used.".into());
    }
    for ext in ["webp", "png"] {
        let _ = std::fs::remove_file(profile.dir.join(format!("secret.{ext}")));
    }
    std::fs::write(profile.dir.join("secret.jpg"), b).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_channel(node: State<'_, Arc<Node>>, group: String, name: String, password: Option<String>) -> CmdResult<String> {
    node.create_channel(&group, &name, password.as_deref())
}

#[tauri::command]
fn channel_action(node: State<'_, Arc<Node>>, group: String, channel: String, action: String, name: String) -> CmdResult<()> {
    node.channel_action(&group, &channel, &action, &name)
}

#[tauri::command]
fn unlock_channel(node: State<'_, Arc<Node>>, chat: String, password: String) -> CmdResult<()> {
    node.unlock_channel(&chat, &password)
}

#[tauri::command]
fn forget_channel(node: State<'_, Arc<Node>>, chat: String) {
    node.forget_channel(&chat)
}

#[tauri::command]
fn links(node: State<'_, Arc<Node>>) -> Value {
    node.links()
}

#[tauri::command]
fn delete_message(node: State<'_, Arc<Node>>, id: String, everyone: bool) -> CmdResult<()> {
    node.delete_message(&id, everyone)
}

/// Does the film have a sound track? (Checked when the built-in player plays it silently.)
#[tauri::command]
async fn audio_track(node: State<'_, Arc<Node>>, file: FileMeta) -> CmdResult<bool> {
    const PART: u64 = 4 * 1024 * 1024;
    let head = file.size.min(PART);
    let mut data = node.read_range(&file, 0, head).await?;
    if file.size > head {
        let tail = (file.size - head).min(PART);
        data.extend(node.read_range(&file, file.size - tail, tail).await?);
    }
    Ok(node::has_audio_track(&data))
}

#[tauri::command]
async fn install_vlc() -> bool {
    tauri::async_runtime::spawn_blocking(vlc::install).await.unwrap_or(false)
}

#[tauri::command]
fn vlc_close(vlc: State<'_, vlc::Vlc>, id: String) {
    vlc.close(&id)
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
fn party_join(node: State<'_, Arc<Node>>, id: String, full: Option<bool>) -> CmdResult<()> {
    node.join_party(&id, full.unwrap_or(false))
}

#[tauri::command]
fn party_full(node: State<'_, Arc<Node>>, id: String, full: bool) -> CmdResult<()> {
    node.party_full(&id, full)
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

/// Size and modification time of our own program file, to notice when an update replaced it.
fn exe_stamp() -> Option<(u64, std::time::SystemTime)> {
    let m = std::env::current_exe().ok().and_then(|p| std::fs::metadata(p).ok())?;
    Some((m.len(), m.modified().ok()?))
}

fn main() {
    // Used by small updates to check that a downloaded program starts.
    if std::env::args().nth(1).as_deref() == Some("--uan-version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if std::env::args().any(|a| a == "--after-update") {
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }
    #[cfg(target_os = "linux")]
    run_newer_delta();
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::fs::remove_file(exe.with_extension("exe.old"));
        let _ = std::fs::remove_file(exe.with_file_name("uan-update.tmp"));
    }
    // On some Linux graphics setups (NVIDIA, virtual machines, some laptops) WebKitGTK's GPU paths
    // leave the window blank/grey. The fallback renderer works everywhere, so use it unless the user
    // set these themselves. Must happen before any threads start.
    #[cfg(target_os = "linux")]
    for var in ["WEBKIT_DISABLE_DMABUF_RENDERER", "WEBKIT_DISABLE_COMPOSITING_MODE"] {
        if std::env::var_os(var).is_none() {
            std::env::set_var(var, "1");
        }
    }
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
        // If UaN was updated while this copy kept running in the tray, opening it again restarts into
        // the new version instead of showing the old window.
        let started_exe = exe_stamp();
        builder = builder.plugin(tauri_plugin_single_instance::init(move |app, _args, _cwd| {
            #[cfg(target_os = "linux")]
            if let (Some(_), Some(appimage)) = (newest_delta(), std::env::var_os("APPIMAGE")) {
                relaunch_later(std::path::Path::new(&appimage));
                app.exit(0);
                return;
            }
            if exe_stamp() != started_exe {
                app.restart();
            }
            show_main(app);
        }));
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
            let http_base = tauri::async_runtime::block_on(node::start_media_server(node.clone())).unwrap_or_default();
            let use_http = cfg!(target_os = "linux") || std::env::var("UAN_HTTP_MEDIA").is_ok();
            app.manage(MediaBase(if use_http && !http_base.is_empty() { Some(http_base.clone()) } else { None }));
            app.manage(HttpBase(http_base));
            app.manage(vlc::Vlc::default());
            // Playback self-test, used by the automatic build checks on the real downloadable packages.
            let selftest = std::env::var("UAN_SELFTEST_VIDEO").ok().and_then(|p| node.selftest_file(&p).ok());
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
            if invisible() {
                if let Some(t) = app.tray_by_id("tray") {
                    let _ = t.set_visible(false);
                }
            }
            apply_icon(app.handle());
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
            vlc_open,
            vlc_status,
            vlc_command,
            vlc_close,
            open_vlc_site,
            install_vlc,
            audio_track,
            delete_message,
            links,
            secret_picture,
            create_channel,
            channel_action,
            unlock_channel,
            forget_channel,
            set_secret_picture,
            set_privacy,
            clear_chat,
            typing,
            read_upto,
            reads,
            set_app_icon,
            party_full,
            set_thumb,
            set_autodl,
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
