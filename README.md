# UaN

Chat, send files of any size (up to 4 TB) and watch films together with friends anywhere, a bit
like Discord, but with **no server**: everything runs on each person's own PC, and files go straight
from one PC to another. Works on **Windows and Linux**, and Windows and Linux users can talk to each
other normally.

## Download

Get the latest version from the [Releases page](../../releases/latest):

| System | File | How to install |
|---|---|---|
| Windows | `UaN_x.y.z_x64-setup.exe` | Run it. (Or use `UaN.exe` directly, no install.) |
| Linux (Ubuntu, Mint, Debian…) | `UaN_x.y.z_amd64.deb` | `sudo apt install ./UaN_*.deb` |
| Linux (any) | `UaN_x.y.z_amd64.AppImage` | `chmod +x UaN_*.AppImage` and run it |

Windows may warn that the app is from an unknown publisher (it isn't code-signed): click
*More info → Run anyway*. On first start, allow it through the firewall.

## How it works

- **No account.** On first start you pick a name. Your identity is a key stored on your PC
  (`%APPDATA%\UaN\identity.key` on Windows, `~/.local/share/UaN/identity.key` on Linux).
  Back it up if you want to keep it; lose it and you get a new one.
- **Friend code.** Since there is no central user list, you add friends with a code (`UAN-…`).
  It is hidden by default (handy while streaming your screen): use **Copy friend code**, or
  **Show friend code** to see it. Your friend pastes it in *Paste a friend code* and you accept.
- **Anywhere in the world.** UaN uses [iroh](https://iroh.computer): PCs find each other by key,
  connect directly through routers when they can (hole punching), and otherwise go through free
  public relay servers. Everything is end-to-end encrypted.
- **Groups.** Click **+** next to *Groups*, name it, pick friends. Everyone in a group sees
  everything posted there, even members who aren't friends with each other.
- **Files.** Drag files into a chat or use the paperclip. Nothing is uploaded anywhere: your friends
  stream it from your PC. Films can be **watched inside UaN** (with seeking) without downloading,
  or downloaded with the Download button. Downloads resume if the connection drops.
- **Remembers where you stopped.** Close a film (or leave a watch party) and it continues from
  the same spot next time you open it.
- **Watch together.** In a group, every video has a *Watch together* button. UaN tests everyone's
  connection and the fastest PC shares the film. Nobody downloads it: it streams, starts when
  everyone has enough loaded, and pauses for everyone if someone falls behind. Play, pause and seek
  happen for everyone at once. If the host leaves, someone else takes over and the rest keep watching.
- **Offline friends.** With the free **offline mailbox** (below) messages arrive even if you have
  turned your PC off by the time your friend comes online.
- **Faster downloads.** Files arrive in 8 MB pieces, 6 at a time, from everyone in the group who has them.
- **Search** (Ctrl+F) by text, file name or extension, type, sender, chat and date.
  The **gallery** button in a chat shows all its photos, videos and files.
- **Subtitles.** Send `film.srt` next to `film.mp4`, or use **+ Subtitles** in the player.
  The **CC** button turns them on or off.
- **Profile picture, status, theme and accent colour** in Settings.

## Things to know

- **The sender's PC must be on, with UaN running**, for friends to watch or download what they sent.
  That's why UaN starts with your PC and stays in the tray when you close the window.
  Quit it from the tray icon menu.
- If two PCs can't connect directly, traffic goes through the public relay, which is slower.
- In-app playback works for formats the built-in player supports (MP4/H.264, WebM, most MKV,
  MP3, etc.). Others (e.g. some AVI) need downloading first. On Linux, playback uses GStreamer;
  install `gstreamer1.0-plugins-good`, `-bad` and `-libav` if a video won't play.

## Offline mailbox (free, Cloudflare)

`mailbox/` is a tiny Cloudflare Worker with a D1 database. The free tier is always on, never deletes
data on its own, and handles about 100,000 messages a day. Messages are encrypted for the recipient
before they leave your PC, so the mailbox can't read them, and every request is signed with the
user's UaN key. Files are never stored there; they still come from the sender's PC.

```bash
cd mailbox
npm install
npx wrangler login
npx wrangler d1 create uan-mailbox
npx wrangler deploy
```

Put the database id from `d1 create` into `wrangler.toml` before deploying, then set the address as
`DEFAULT_MAILBOX` in `desktop/src/node.rs` (or paste it in UaN → Settings → Offline mailbox).

## Testing on your own

Start menu → **UaN (test friend)** opens a second, separate UaN identity on the same PC
(`UaN --profile tester` on Linux). Copy the code from one window, paste it into the other, accept,
and try messages, files and groups.

## Building

The [Build workflow](.github/workflows/build.yml) builds Windows and Linux versions on every push;
tagging `vX.Y.Z` publishes them on the Releases page.

Locally you need Rust, plus the Visual Studio C++ Build Tools on Windows, or on Linux:
`libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev`.

```bash
cd desktop
npx @tauri-apps/cli@2 build
```

`--profile NAME` runs an extra identity with its own data; `--hidden` starts in the tray.
