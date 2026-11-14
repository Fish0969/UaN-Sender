# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

(Desktop app for Windows and Linux plus an Android app, one HTML/CSS/JS interface inside Tauri. The phone gets its own compact layout; there is no separate native design language.)

## Users

A small circle of friends (the owner, a Hungarian gamer, and his friends). They chat in direct messages and groups, send each other big files and films, and watch films together, mostly in the evening, often next to a game. Inferred from the conversation history; the owner skipped the confirmation round.

## Product Purpose

Discord-like chat where everything runs on the users' own PCs: messages and files go straight from one device to another (peer to peer), with no account and no server. Success: sending a 20 GB film or a photo to a friend is as easy as a chat message, and a film plays inside the app without downloading.

## Positioning

No account, no server, no size limit: your friend code is your identity, files of any size (up to 4 TB) stream straight from your PC, and watch-together keeps everyone in sync. An encrypted mailbox carries messages while a friend is offline.

## Operating Context

- Used next to games and films; the app must not steal focus or get in the way.
- Desktop window ~820x540 and larger; phone portrait.
- 18 themes (light, dark, gradient themes, Christmas with snowfall, Horizon with a black hole), plus themes the user adds (an .html page, a video or a picture) and accent colours, all built on CSS custom properties; every theme must keep working.
- UI language: English. The owner talks in Hungarian.

## Capabilities and Constraints

Friends by friend code; groups with channels (text channels, password-locked channels whose messages are encrypted with the password); DMs; replies, edits, pins, deletes, @mentions, typing and seen indicators; any-size file sending, folders, photo/video previews, gallery, search; in-app player with subtitles, VLC fallback; watch together with chat and playlist; automatic downloads (off by default); backup/restore; presence (online/away/do not disturb); mute; themes, app icons, ready-made profile pictures; Android app.

Decided for this round (owner skipped the questions, assumptions stated, then corrected by the owner): a phone signs in to the PC account once, with a short code shown on the PC; after that it is a second device of the same account and keeps working while the PC is off (the owner asked for this). A locked channel asks for its password every time it is opened.

## Brand Commitments

- Name: UaN. App icon: white paper plane on a blue rounded square.
- No emojis anywhere in the interface (the owner asked).
- English UI copy.
- The owner disliked a Discord-style rail layout (1.6.0) and asked to return to the classic one; then asked for an entirely new, modern, clean look. Group messages should show the sender's picture beside the message (owner's reference: Discord).

## Evidence on Hand

No marketing claims, testimonials or metrics. Product truth lives in README.md and the code.

## Product Principles

1. Sending something is one action, whatever its size.
2. Your PC is the server: nothing depends on an account.
3. Quiet companion: never interrupt a game or a film.
4. Every feature works on PC and phone, adapted, not removed.
