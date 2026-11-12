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
