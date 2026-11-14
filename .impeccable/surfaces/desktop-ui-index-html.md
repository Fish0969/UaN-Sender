---
version: 1
slug: "desktop-ui-index-html"
primary_target: "desktop/ui/index.html"
related_targets: ["desktop/ui/style.css","desktop/ui/app.js"]
---

# Surface: UaN app window (desktop/ui/index.html)

Mode: operate. Audience: a circle of friends chatting, sending big files and watching films together, often next to a game. Task: read and answer conversations, send anything, open what friends sent. Constraints: 17 existing themes and accent colours (CSS custom properties) must keep working; English UI; no emojis; phone layout from the same code. Owner skipped the question round; direction assigned by the roll and built unattended.

## Direction contract

THESIS: What friends send is the conversation's main material, so media lands as a contact sheet of prints laid on the table, while the text around it stays quiet. Refuses the category default: a grey Discord slab with a server rail and bubbles of equal weight.

OWN-WORLD: Two floating panels on the theme's ground (people on the left, the conversation on the right), 16px corners, soft offset shadows, hairline borders. Avatars and media are prints: a thin frame of the panel colour, a 6px corner, a lift on hover. System UI type, three sizes (12, 13.5, 15), weight carries rank, tabular numerals for every time and size. Colour comes from the active theme; the accent marks selection, unread and the send action only.

STORY: The visitor sees who is around and what is new, opens a chat, reads who said what by face and name, and sends text, photos, files or a whole folder from one composer. Photos sent together read as one set; a folder reads as one item to open and pick from.

FIRST VIEWPORT: Left panel 288px: profile row with search and settings on top, the add-friend field, then Groups and Friends as 44px rows with print avatars, unread counts and last-activity times; friend code and Send to several docked at the bottom. Right panel: 56px header (print avatar, name, status, pins, gallery), channel pills under it in groups, the message stream (in groups an avatar column with name and time on the first line), and a floating composer pill at the bottom with attach and send as the primary action.

FORM: candidate 6 of the grounded list (photo album / contact sheet). seed:e4602c56788716ab. Raises from declined challengers: one hairline border system everywhere (Japanese high-density); times and sizes set right-aligned in tabular numerals (cassette j-card); rank by weight inside a short type scale (timetable rack); each group keeps its own hue as its identity colour (transit map); every person keeps the same fixed chip, a print avatar with presence dot, wherever they appear (character catalog).

Signature move: the contact sheet. Several photos or videos sent together render as one grid of prints (one large plus smaller ones, as in a shared album); each print lifts on hover and opens in the viewer.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
