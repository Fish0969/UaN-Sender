---
name: UaN
description: Peer-to-peer chat for a circle of friends; two floating panels on the theme's ground, media laid out as prints.
colors:
  accent: "#005fb8"
  accent-dark: "#60cdff"
  ground: "#e8eaed"
  ground-dark: "#121212"
  side-panel: "#f6f6f7"
  side-panel-dark: "#1c1c1c"
  panel: "#ffffff"
  panel-dark: "#222222"
  card: "#ffffff"
  card-dark: "#2b2b2b"
  theirs: "#f1f2f4"
  theirs-dark: "#2e2e2e"
  mine: "#005fb8"
  mine-dark: "#0f4a73"
  text: "#1a1a1a"
  text-dark: "#f0f0f0"
  muted: "#5f5f5f"
  muted-dark: "#a8a8a8"
  hairline: "rgba(0, 0, 0, .09)"
  hairline-dark: "rgba(255, 255, 255, .08)"
  danger: "#c42b1c"
  ok: "#0f7b0f"
typography:
  headline:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.45
  title:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.45
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum"
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.45
    fontFeature: "tnum"
  code:
    fontFamily: "Cascadia Mono, Consolas, ui-monospace, monospace"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.08em"
rounded:
  print: "6px"
  control: "9px"
  row: "12px"
  card: "14px"
  panel: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "14px"
  xxl: "20px"
components:
  button:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "30px"
  button-accent:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.panel}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "30px"
  button-icon:
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    size: "30px"
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "0 11px"
    height: "32px"
  composer:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.pill}"
    padding: "5px"
  send-button:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.panel}"
    rounded: "{rounded.pill}"
    size: "34px"
  channel-pill:
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "28px"
  list-row:
    textColor: "{colors.text}"
    rounded: "{rounded.row}"
    padding: "0 8px"
    height: "48px"
  bubble-mine:
    backgroundColor: "{colors.mine}"
    textColor: "{colors.panel}"
    rounded: "{rounded.panel}"
    padding: "7px 12px"
  bubble-theirs:
    backgroundColor: "{colors.theirs}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "7px 12px"
  print:
    rounded: "{rounded.print}"
  folder-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: "10px 14px 10px 10px"
    width: "320px"
  panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.panel}"
  dialog:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "22px"
  toast:
    backgroundColor: "{colors.text}"
    textColor: "{colors.panel}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
---

# Design System: UaN

## Overview

**Creative North Star: "The Shared Album on the Table"**

UaN is a chat whose real material is what friends send each other: photos, films, whole folders. The interface lays two floating panels on whatever ground the active theme paints (people on the left, the conversation on the right) and keeps the text around them quiet, so that a set of photos arrives as a contact sheet of prints rather than a stack of equal-weight bubbles. It is a quiet companion for evenings next to a game or a film: compact, system-native type, soft lift, no ornament that competes with the media.

The system is split cleanly in two. Themes own colour and nothing else: seventeen named themes, and any theme the user adds, set only the ground, panel, card, bubble, dialog, accent and "mine" colours (some as gradients with see-through glass panels). Everything else (corner radii, spacing, type, shadows, motion) is theme-independent and lives in one layer, so every theme keeps working and a new surface inherits all of them for free.

The owner rejected a Discord-style server rail; the two-panel layout with a people list on the left is the confirmed shape. No emojis appear anywhere in the interface, and all copy is English.

**Key Characteristics:**
- Two floating panels on the theme's ground, 16px corners, hairline borders, a soft ambient lift.
- Media as prints: a frame of the panel colour, a 6px corner, a lift on hover; photos sent together form one contact-sheet grid.
- System UI type on a short scale (12 / 13.5 / 15, 17 for dialog titles); weight carries rank; tabular numerals everywhere.
- Colour comes from the theme; the accent marks selection, unread, focus and the send action.
- Pill-shaped composer, channel pills and toasts; rounded-square controls.
- Every person and group keeps a fixed identity hue on its avatar.

## Colors

The palette is not one palette but a contract: themes supply a small set of colour roles, and every surface draws only from those roles. The frontmatter records the default Light and Dark (Auto follows the OS) values; the full theme catalogue lives in the sidecar.

### Primary
- **Windows Accent Blue** (light / dark values in frontmatter `accent`, `accent-dark`): selection tint, unread time and badge, focus rings, the caret, the send button, the composer's focus glow, quote author names, the folder and file-type tiles. A user can override it with six accent swatches (Blue, Purple, Green, Orange, Pink, Red), each with a light and a dark value; most themes also carry their own accent.
- **Mine** (`mine`, `mine-dark`): the background of your own message bubbles. On light bases it equals the accent; on dark bases it is the accent mixed 45% into near-black (`color-mix(in srgb, accent 45%, #1c1c1c)`) unless the theme names its own.

### Neutral
- **Ground** (`ground`): the window behind the two panels; gradient themes replace it with an image (`--bg-image`).
- **Side Panel** (`side-panel`): the people panel.
- **Panel** (`panel`): the conversation panel and the default dialog surface.
- **Card** (`card`): buttons, inputs, the composer, file and folder cards, lists inside dialogs.
- **Theirs** (`theirs`): other people's bubbles, always with a hairline border.
- **Text / Muted** (`text`, `muted`): body text; secondary lines, times, sizes, icons at rest.
- **Hairline** (`hairline`): every border and divider in the system, at 8 to 9% of the opposite tone.
- **Danger / Ok** (`danger`, `ok`): destructive actions and errors; presence dot and finished transfers.
- **Identity Hue**: every avatar is `hsl(h 45% 48%)` with white initials, where `h` is a stable hash of the person's or group's id. It is not a theme colour and never changes with the theme.

### Named Rules
**The Theme Owns Colour Rule.** A theme may set only `--bg`, `--bg-image`, `--side`, `--panel`, `--card`, `--theirs`, `--dialog`, `--accent` and `--mine`. Shape, space and type never vary by theme, and no component hard-codes a surface colour.

**The Living Ground Rule.** A theme may also draw its ground as a scene behind the two panels: Christmas has snowfall, and a user's own theme a video (muted unless turned on), a picture or an .html page. A scene sits at z-index 0, takes no pointer events, animates only transforms and opacity, pauses while the window is hidden and stops under reduced motion. A theme with a bright ground may also set four optional colour roles, which default to nothing: `--head-bg` (behind the header and channel pills), `--composer-bg` (the composer and reply bar), `--transfers-bg` (the transfer list) and `--text-shade` (a shadow for text that sits straight on the glass). Its card role is then dense (about 80% dark) so file and folder cards stay readable over the brightest part. The panels' shape never changes, and no theme moves a layout element.

**The Accent Means Something Rule.** The accent marks selection (as a 16% tint, `--accent-soft`), unread, focus and the send action. It is not used for decoration or for section headings.

## Typography

**Body Font:** Segoe UI Variable Text (with Segoe UI, system-ui, sans-serif)
**Mono Font:** Cascadia Mono (with Consolas, ui-monospace) for friend and link codes only

**Character:** The operating system's own UI face, set small and dense like a Windows 11 utility, so the app sits beside a game without announcing itself. Hierarchy comes from weight inside a short scale, not from size jumps.

### Hierarchy
- **Headline** (600, 17px): dialog titles (16px on the phone's full-screen settings).
- **Title** (600, 15px): your name in the panel, the open chat's name.
- **Body** (400, 13.5px, 1.45): messages, list names (500), folder rows, form text. Bubbles cap at min(520px, 76%) wide.
- **Label** (600 or 400, 12px): list section captions ("Groups", "Friends") and day separators at 600; times, sizes, sub-lines, metadata, badges at 400 or 600. Sentence case, no letter-spacing.
- **Code** (600, 26px mono, 0.08em tracking): the one-time link code; the join-code field uses the same face at 18px, uppercase.

### Named Rules
**The Weight Carries Rank Rule.** Unread rows go to 700, names to 500 to 600, metadata stays at 400; size changes are reserved for the four steps above.

**The Tabular Numerals Rule.** `font-variant-numeric: tabular-nums` is set on the body, so every time, size, count and duration aligns in columns.

## Layout

The desktop window is a two-column grid: a 288px people panel and a fluid conversation panel, separated and surrounded by an 8px gap so the theme's ground shows around both. The people panel stacks your profile row (36px avatar, search, settings), the add-friend field with a round add button, captioned Groups and Friends lists of 48px rows, and a dock at the bottom (friend-code buttons, Send to several). The conversation panel stacks a 58px header, a row of channel pills (groups only), the message stream (padding 12px 20px), the transfer list, and a floating composer pill 14px from the panel's edges.

Messages from others in a group sit beside a 34px avatar column; only the first message of a run shows the avatar and sender name, later ones keep an equal gap. A run of messages shows its time only on the last one; earlier times appear beside the message on hover.

Spacing steps are 4, 6, 8, 12, 14 and 20px; 8px is the structural gap.

**Responsive.** At 700px and below the grid collapses to one column with no gap and no outer padding: the people list and the conversation are separate screens with a back button, panels lose their borders, corners and shadow, and bubbles widen to 88% (92% in groups). The phone build (`html.phone`) additionally pads the body below the status bar (safe-area inset, at least 26px), raises every button and input to 44px and icon buttons to 48px, hides hover-only message actions in favour of press-and-hold, and turns Settings into a full-screen sheet with a sticky Save bar.

## Elevation & Depth

A hybrid: surfaces are separated by hairline borders and tonal steps, and lifted by soft, wide ambient shadows that never read as hard edges. On glass themes the panels are translucent over the gradient ground, so depth is partly the ground showing through.

### Shadow Vocabulary
- **Panel Lift** (`box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 12px 32px -16px rgba(0,0,0,.32)`): the two main panels.
- **Composer Float** (`box-shadow: 0 8px 24px -16px rgba(0,0,0,.5)`): the composer pill; with focus it adds a 3px accent glow at 14%.
- **Print Lift** (`box-shadow: 0 0 0 1px hairline, 0 14px 26px -12px rgba(0,0,0,.55)` plus `translateY(-2px)`): a print or contact-sheet tile on hover.
- **Dialog** (`box-shadow: 0 2px 6px rgba(0,0,0,.12), 0 30px 70px -20px rgba(0,0,0,.55)`): modal dialogs over a 42% black backdrop.
- **Focus Ring** (`outline: 2px solid accent at 75%, offset 2px`; inputs use a 3px accent glow at 18% instead).

### Named Rules
**The Soft Lift Rule.** Shadows are always blurred and negatively spread; there are no hard offset shadows. Lift on hover is reserved for prints.

## Shapes

Corners scale with the size of the thing: 16px for panels, dialogs and bubbles; 14px for cards (files, folders, reply bar, drop zone); 12px for list rows, menus and inner lists; 9px for controls; 6px for prints and tiny buttons. Free-floating, single-line things are full pills: the composer, the send and attach buttons, channel pills, the add-friend field, toasts, the offline notice, the Send to several button. People's avatars are circles; group avatars are 9px rounded squares. Avatars carry an inner 1px white hairline at 14%, like a print's frame.

## Components

### Buttons
Small, quiet and rounded, in the Windows 11 manner.
- **Shape:** rounded rectangle (9px), 30px tall; small variant 26px with 8px corners; tiny 22px with 6px corners.
- **Default:** card background, hairline border, text colour; hover darkens with the shared hover tint.
- **Accent:** accent background, `--on-accent` text (black on dark bases, white on light), 600 weight, a faint inset top highlight.
- **Icon:** transparent, 30px square, muted icon that turns text-coloured on hover. Icons are 16px stroked line SVGs (1.8 stroke, round caps).
- **Motion:** background, colour and border transitions at 0.15s; transforms at 0.25s on `cubic-bezier(.16, 1, .3, 1)`. Send presses down to 94%.

### Chips (Channel Pills)
- **Style:** 28px pills with a hairline border and muted text; hover fills with the hover tint.
- **State:** the active channel takes the 16% accent tint and a 45% accent border. Locked channels show a lock icon, text channels a hash.

### Cards / Containers
- **Corner Style:** 14px for file and folder cards; 16px for the panels themselves.
- **Background:** card colour on the panel colour.
- **Shadow Strategy:** none at rest; see Elevation for the panels.
- **Border:** one hairline.
- **Internal Padding:** 10px rows; a 38 to 42px accent-tinted tile on the left carries the file type or the folder icon.

### Inputs / Fields
- **Style:** 32px, 9px corners, hairline border, card background, accent caret.
- **Focus:** border turns 70% accent with a 3px accent glow at 18%; no outline.
- **Pill fields:** the add-friend field and the lock password field are full pills.

### Navigation
The people panel is the navigation. Rows are 48px (54px on the phone) with 12px corners: a 34px avatar, the name over a muted sub-line, the last-activity time right-aligned in 12px. Hover takes the hover tint; the open chat takes the accent tint. Unread rows set the name in bold, colour the time with the accent, and show a 20px accent count badge. On narrow screens the list and the chat become two screens joined by a back button.

### Composer
A floating pill (999px) in card colour with a hairline border and the Composer Float shadow: attach button, borderless input, and a round 34px accent send button. On focus the whole pill takes an accent border and glow. On the phone the buttons grow to 48px and an image button appears.

### Message Bubbles
- **Shape:** 16px corners, 7px 12px padding.
- **Mine:** right-aligned, mine colour, white text.
- **Theirs:** left-aligned, theirs colour, hairline border; in groups, preceded by the sender's 34px avatar and a 12px/600 name on the first message of a run.
- **Meta:** 12px time with stacked 15px seen-heads to its left; reply, edit, pin and delete actions as 22px ghost buttons on hover (press-and-hold menu on the phone). A mention of you rings the bubble.

### Contact Sheet (signature)
Photos and videos sent together render as one grid of prints, 400px wide (300px on narrow screens), 6px gaps, two columns up to four items and three beyond; with three items the first print spans two rows. Each print is square, framed by a 3px border of the panel colour and a hairline, 6px corners, cover-cropped. Videos carry a centred 40px dark play disc and a duration tag. Hover lifts the print 2px with the Print Lift shadow; click opens the viewer.

### Folder Card
A whole folder reads as one 320px card: an accent-tinted folder tile, the folder name over "N files · size", and a chevron. It opens a dialog listing the contents as hairline-divided rows: a 44px print-framed preview tile (the picture, the video's preview with a play mark, or the file type), the name over its size, and one action per file (Download, progress, Open; Play or Open for the sender), with tick boxes for several at once and Download folder as the primary action. Opening a picture or film from the folder shows it in the viewer with round previous and next buttons and a "1 / 4" counter; closing the viewer returns to the folder. On a film the arrow keys seek and Shift+arrows step; on the phone a swipe steps. The viewer is solid black and covers the whole window.

### Media and files
A dialog with pill tabs (Photos & videos, Files). Photos and videos form a grid of prints (16:10, 176px minimum, panel-colour frame and hairline, lift on hover), each with its name (13.5) and size, sender and date (12, muted) underneath; films carry a play disc and their length. Month captions in 12/600.

### Invitations
A watch-together invitation is a floating card at the top right of the window (dialog surface, panel radius, dialog shadow): the host's picture, "X invited you to watch together", the film and group, and Join (accent), Download first, Not now on one line.

### Dialogs, Menus, Toasts
Dialogs are 16px-cornered panel-coloured sheets with 22px padding that rise 8px and scale from 98.5% over 0.28s. Context menus and the mention picker are 12px-cornered with 8px-cornered 30px items. Toasts and the offline notice are pills; the toast inverts the panel (text-coloured background, panel-coloured text). All motion is removed under `prefers-reduced-motion`.

## Do's and Don'ts

### Do:
- **Do** let the theme supply every colour through its roles; a new surface uses `--panel`, `--card`, `--border`, `--text`, `--muted` and `--accent`, never literal colours.
- **Do** keep the two-panel layout: a 288px people panel and the conversation, 8px apart on the theme's ground.
- **Do** render several photos or videos sent together as one contact sheet of prints, and a folder as one card.
- **Do** stay on the type scale (12 / 13.5 / 15, 17 for dialog titles) and rank with weight.
- **Do** use the hairline border for every divider and container edge.
- **Do** give every touch target 44px (48px for icon buttons) on the phone.
- **Do** keep icons as 16px stroked line SVGs.

### Don't:
- **Don't** use emojis anywhere in the interface.
- **Don't** bring back a Discord-style server rail.
- **Don't** let a theme change radii, spacing, type or shadows.
- **Don't** use the accent for decoration; it marks selection, unread, focus and send.
- **Don't** use hard offset shadows; lift is soft and negatively spread.
- **Don't** rely on hover alone on the phone; hover-only controls get a press-and-hold or visible equivalent there.
