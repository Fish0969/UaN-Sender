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
- **Previews.** Photos and videos show a preview picture (and the video's length) in the chat, even
  when the sender's PC is off.
- **Offline friends.** Messages, previews and small files (photos, short clips up to 24 MB) wait
  encrypted in a free mailbox, so they arrive even if you have turned your PC off by the time your
  friend comes online.
- **Automatic downloads.** Files friends send are downloaded in the background (up to 10 GB each by
  default, change it in Settings) to `Downloads/UaN`, so they still open later when the sender is offline.
- **Search** (Ctrl+F), a **gallery** of each chat's photos, videos and files, **subtitles**
  (send `film.srt` next to `film.mp4`, or **+ Subtitles** in the player; **CC** turns them on or off),
  **profile picture, status, themes**.

## Good to know

- **Big files need both PCs on at the same time once**: the sender's PC must be on, with UaN running,
  until the friend has watched or downloaded it (automatic downloads take care of this in the
  background). That's why UaN starts with your PC and stays in the tray when you close the window.
  Quit it from the tray icon menu.
- If two PCs can't connect directly, traffic goes through a public relay, which is slower.
- Some video formats (e.g. some AVI files) can't be played inside UaN; download those instead.

For developers: see [BUILDING.md](BUILDING.md).

My friend code: UAN-NQJXKXMKX2UBRRHH7EC6X2NEZJR3EHUSLVUCHPM4FOEOOHSOXQCA

