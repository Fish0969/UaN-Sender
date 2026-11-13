# Building UaN

You only need this to change UaN itself. To use it, download it from the Releases page.

The [Build workflow](.github/workflows/build.yml) builds the Windows installer and the Linux
`.deb` / `.AppImage` on every push. Pushing a tag like `v1.2.0` publishes them on the Releases page.

## Building locally

- **Windows:** Rust and the Visual Studio C++ Build Tools.
- **Linux:** Rust and
  `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev`
  (plus the GStreamer packages listed in the workflow to bundle the AppImage).

```bash
cd desktop
npx @tauri-apps/cli@2 build
```

`--hidden` starts UaN in the tray (used for start-up with the computer).

## Layout

- `desktop/src/node.rs`: the peer-to-peer node (iroh): friends, groups, messages, file streaming,
  downloads, watch together, mailbox client, search.
- `desktop/src/vlc.rs`: "Open in VLC": starts VLC on UaN's local player server (`?stream=1`, nothing is
  downloaded) and controls it through VLC's web interface on 127.0.0.1, so watch together stays in sync.
  Self-test: `UAN_SELFTEST_VIDEO=film.mkv UAN_SELFTEST_VLC=1 UAN_SELFTEST_OUT=r.txt`
  (`UAN_VLC_EXTRA="--intf=dummy --vout=dummy --aout=dummy"` runs VLC without a window).
  Tests can set `UAN_DOWNLOADS` to keep automatic downloads out of the real Downloads folder, and
  `UAN_INVISIBLE=1` to run with the window off-screen and no taskbar button, tray icon or notifications.
- Small AppImage updates: releases include `uan-linux-x86_64.gz` (just the program). The updater saves it
  as `~/.local/share/UaN/bin/uan-<version>`; the AppImage checks it with `--uan-version` and starts it.
- `desktop/src/main.rs`: the window, tray icon, autostart and commands for the UI.
- `desktop/ui/`: the interface (plain HTML, CSS and JavaScript).
- `mailbox/`: the offline mailbox, a Cloudflare Worker with a D1 database (free tier).

## Offline mailbox

Messages are encrypted for the recipient before they leave the PC, and every request is signed with
the user's UaN key, so the mailbox can't read or tamper with anything. Files are never stored there.

```bash
cd mailbox
npm install
npx wrangler login
npx wrangler d1 create uan-mailbox
npx wrangler deploy
```

Put the database id from `d1 create` into `wrangler.toml` before deploying, then set the address as
`DEFAULT_MAILBOX` in `desktop/src/node.rs`.

## GIF search (KLIPY)

The app calls KLIPY directly (their rules: requests from the user's app, results in their order, "Search KLIPY" in the box).
The API key is not in this repository: release builds get it from the `UAN_KLIPY_KEY` GitHub secret at compile
time; local builds can set `UAN_KLIPY_KEY` when building or running. The key is in testing mode (100 searches
per hour for everyone together) until production access is requested in the KLIPY Partner Panel.
