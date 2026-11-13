# UaN

Chat, send files of any size (up to 4 TB) and watch films together with friends anywhere, a bit
like Discord, but with **no server**: everything runs on each person's own PC, and files go straight
from one PC to another. Works on **Windows and Linux**, and Windows and Linux users can chat, send
files and watch together normally.

## Download

Get the newest version from the **[Releases page](../../releases/latest)**. Everything UaN needs is
included; there is nothing else to install.

**Windows:** download `UaN_…_x64-setup.exe` and run it.
Windows may say the app is from an unknown publisher: click *More info → Run anyway*.
On first start, allow it through the firewall.

**Linux (Ubuntu, Mint, Debian, Pop!_OS…):** download `UaN_…_amd64.deb` and double-click it to open
it in the software installer, then click *Install*. Or in a terminal:

```bash
sudo apt install ./UaN_*_amd64.deb
```

**Linux (any other distribution):** download `UaN_…_amd64.AppImage`, right-click it →
*Properties → Allow executing as program*, then double-click it.

## How it works

- **No account.** On first start you pick a name. Your identity is a key stored on your PC.
- **Friend code.** You add friends with a code (`UAN-…`). It is hidden by default (handy while
  streaming your screen): use **Copy friend code**, or **Show friend code** to see it. Send it to a
  friend however you like; they paste it in *Paste a friend code* and you accept.
- **Anywhere in the world.** PCs find each other by their key and connect directly through routers
  when they can, otherwise through free public relays. Everything is end-to-end encrypted.
- **Groups.** Click **+** next to *Groups*, name it, pick friends. Everyone in a group sees
  everything posted there.
- **Files.** Drag files into a chat or use the paperclip. Nothing is uploaded anywhere: your friends
  stream it from your PC. Films can be **watched inside UaN** without downloading, or downloaded.
- **Remembers where you stopped.** Close a film (or leave a watch party) and it continues from
  the same spot next time.
- **Watch together.** In a group, every video has a *Watch together* button. The PC with the fastest
  connection shares the film, it streams for everyone, starts when everyone has enough loaded, and
  pauses for everyone if someone falls behind. If the host leaves, someone else takes over.
  Everyone chooses for themselves: just stream it, or **download the whole film first** (smoothest;
  the party waits for you, and a copy is kept in `Downloads/UaN`).
- **Open in VLC.** If a film's format or sound can't play inside UaN (picture but no sound, e.g. AC3/DTS
  sound), it opens in VLC by itself, streamed without downloading. If VLC is missing, UaN offers to
  install it with one click. *Open in VLC* does it anytime. In a watch party, *Watch in VLC* keeps VLC in
  sync with everyone (play, pause, seek both ways); close VLC and you're back in UaN's own player.
- **Delete messages.** Hover a message and click ×: delete it just for you, or (your own) for everyone.
  Deleting a file for everyone also stops sharing it.
- **New look.** Groups sit on a rail on the left (like Discord), their channels and members next to it, your
  profile at the bottom. Prefer the old look? Settings → Layout → Legacy. All themes work with both.
- **Channels.** Groups can have channels besides *general*. A channel can be locked with a password: its
  messages are encrypted with that password, so only people who know it can read them.
- **GIFs.** The GIF button in the message bar searches GIPHY or KLIPY (Tenor closed its service in 2026).
- **Groups.** Click a group's name (or right-click it in the list) for members, adding people and more.
  Anyone in the group can add their friends; new members see the earlier messages too. Clear a chat's
  messages for yourself, or (the group's creator) for everyone.
- **Typing and seen.** "… is typing", and small profile pictures under the last message each person has
  seen, like in Messenger. Both can be turned off in Settings.
- **Previews.** Photos and videos show a preview picture (and the video's length) in the chat, even
  when the sender's PC is off.
- **Offline friends.** Messages, previews and small files (photos, short clips up to 24 MB) wait
  encrypted in a free mailbox, so they arrive even if you have turned your PC off by the time your
  friend comes online.
- **Automatic downloads** (off by default, turn on in Settings): files friends send are downloaded in
  the background to `Downloads/UaN`, so they still open later when the sender is offline.
- **Search** (Ctrl+F), a **gallery** of each chat's photos, videos and files, **subtitles**
  (send `film.srt` next to `film.mp4`, or **+ Subtitles** in the player; **CC** turns them on or off),
  **profile picture** (upload one or pick a ready-made one), **status**, **17 themes** (including a Christmas one with falling snow), and a choice of
  **app icons**.
- **Small updates.** One click on *Update* in the app: it downloads only the new program (a few MB) and
  switches over by itself, no installer, no uninstaller, everything stays. On Linux, the AppImage also only downloads the new program
  (a few MB), not the whole 150 MB package.

## Good to know

- **Big files need both PCs on at the same time once**: the sender's PC must be on, with UaN running,
  until the friend has watched or downloaded it (turn on automatic downloads in Settings if you
  want this to happen in the background). That's why UaN starts with your PC and stays in the tray when you close the window.
  Quit it from the tray icon menu.
- If two PCs can't connect directly, traffic goes through a public relay, which is much slower. The chat
  header shows which one you have ("direct connection" or "through a relay server"). Speed is also limited by
  the sender's upload speed.
- Some video formats (e.g. some AVI files) can't be played inside UaN; those open in VLC
  automatically (free, [videolan.org](https://www.videolan.org)).

For developers: see [BUILDING.md](BUILDING.md).

My friend code: UAN-NQJXKXMKX2UBRRHH7EC6X2NEZJR3EHUSLVUCHPM4FOEOOHSOXQCA

