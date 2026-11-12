'use strict';

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/i;
const PLAYABLE = /^(video|audio)\//i;
const INLINE_IMAGE_LIMIT = 32 * 1024 * 1024;
const $ = (id) => document.getElementById(id);

const S = {
  me: null, // { id, code, name, profile, autostart }
  friends: [],
  incoming: [],
  outgoing: [],
  groups: [],
  active: null, // chat id: friend id, or "g:<group id>"
  msgs: new Map(),
  unread: new Map(),
  transfers: [],
  parties: new Map(),
};

// ---------- Helpers ----------
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
}
function svg(inner) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.innerHTML = inner;
  return s;
}
const ICON = {
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m7 4 13 8-13 8Z"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  open: '<path d="M14 3h7v7M21 3l-9 9M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  bigplay: '<path d="M8 5v14l11-7Z"/>',
};
const iconBtn = (name, title, onclick) => el('button', { class: 'icon', type: 'button', title, onclick }, svg(ICON[name]));

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i && n < 100 ? 1 : 0)} ${u[i]}`;
}
function fmtDur(s) {
  if (!isFinite(s) || s <= 0) return '';
  if (s < 60) return `${Math.ceil(s)}s`;
  if (s < 3600) return `${Math.ceil(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.ceil((s % 3600) / 60)} min`;
}
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', month: 'long', day: 'numeric' });

function hue(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function avatar(name, { online = false, group = false, seed, src } = {}) {
  const a = el('div', { class: 'avatar' + (online ? ' online' : '') + (group ? ' group' : '') + (src ? ' has-img' : '') });
  if (src) a.append(el('img', { src, alt: '' }));
  else a.textContent = (name || '?')[0];
  a.style.setProperty('--h', hue(seed || name || '?'));
  return a;
}
function setAvatar(node, name, opts = {}) {
  node.replaceWith(Object.assign(avatar(name, opts), { id: node.id }));
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = String(msg);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 5000);
}
function ask(text, ok = 'OK') {
  return new Promise((resolve) => {
    const d = $('askDlg');
    $('askText').textContent = text;
    $('askOk').textContent = ok;
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
    d.showModal();
  });
}

const friendById = (id) => S.friends.find((f) => f.id === id);
const groupById = (id) => S.groups.find((g) => g.id === id);
const isGroup = (chat) => chat?.startsWith('g:');

function chatInfo(chat) {
  if (isGroup(chat)) {
    const g = groupById(chat.slice(2));
    return g && { name: g.name, group: g };
  }
  const f = friendById(chat);
  return f && { name: f.name, friend: f };
}

function mediaUrl(file) {
  const base = S.me?.mediaBase || convertFileSrc('', 'media').replace(/\/$/, '');
  return `${base}/${file.owner}/${file.id}/${file.size}/${encodeURIComponent(file.mime)}`;
}

// Feels like an app, not a web page.
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, .bubble, .code-box')) e.preventDefault();
});
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'f' && S.me?.name) { e.preventDefault(); openSearch(); return; }
  if (e.key === 'F5' || (e.ctrlKey && ['r', 'p', 'g', 'u'].includes(e.key.toLowerCase()))) e.preventDefault();
  if (e.key === 'Escape' && !$('viewer').classList.contains('hidden')) closeViewer();
});

// ---------- Start ----------
async function boot() {
  S.me = await invoke('state');
  if (!S.me.name) {
    $('setup').classList.remove('hidden');
    $('setupName').focus();
    return;
  }
  enterMain();
}

$('setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await invoke('set_name', { name: $('setupName').value });
    S.me = await invoke('state');
    $('setup').classList.add('hidden');
    enterMain();
  } catch (err) {
    $('setupError').textContent = err;
  }
});

async function enterMain() {
  $('main').classList.remove('hidden');
  renderMe();
  S.transfers = await invoke('transfers');
  renderTransfers();
  await loadContacts();
  for (const p of await invoke('parties')) S.parties.set(p.id, p);
  renderInviteBar();
}

function renderMe() {
  $('meName').textContent = S.me.name;
  setAvatar($('meAvatar'), S.me.name, { seed: S.me.id, src: S.me.profile?.avatar });
  $('meStatus').textContent = S.me.profile?.status || '';
  $('meProfile').classList.toggle('hidden', !S.me.profileName);
  $('meProfile').textContent = S.me.profileName ? `Test profile: ${S.me.profileName}` : '';
  $('codeText').textContent = S.me.code;
}

// The code is hidden by default (e.g. while you stream your screen), but you can still copy it.
$('copyCode').addEventListener('click', async () => {
  const b = $('copyCode');
  try {
    await navigator.clipboard.writeText(S.me.code);
    b.textContent = 'Copied ✓';
  } catch {
    b.textContent = 'Couldn’t copy';
  }
  setTimeout(() => { b.textContent = 'Copy friend code'; }, 2500);
});
let codeTimer;
function toggleCode(force) {
  const box = $('codeText');
  const show = force ?? box.classList.contains('hidden');
  box.classList.toggle('hidden', !show);
  $('showCode').textContent = show ? 'Hide friend code' : 'Show friend code';
  clearTimeout(codeTimer);
  if (show) codeTimer = setTimeout(() => toggleCode(false), 20000);
}
$('showCode').addEventListener('click', () => toggleCode());

// ---------- Live events ----------
listen('message', ({ payload: m }) => onMessage(m));
listen('contacts', () => loadContacts());
listen('presence', ({ payload }) => {
  const f = friendById(payload.id);
  if (f) f.online = payload.online;
  for (const g of S.groups) for (const m of g.members) if (m.id === payload.id) m.online = payload.online;
  renderLists();
  renderChatHead();
});
listen('transfers', ({ payload }) => {
  S.transfers = payload;
  renderTransfers();
});

// ---------- Contacts ----------
async function loadContacts() {
  const c = await invoke('contacts');
  Object.assign(S, c);
  if (S.active && !chatInfo(S.active)) closeChat();
  renderLists();
  renderChatHead();
}

function renderLists() {
  const byRecent = (a, b) => (b.lastAt || 0) - (a.lastAt || 0) || a.name.localeCompare(b.name);
  const badge = (chat) => {
    const n = S.unread.get(chat) || 0;
    return n ? el('span', { class: 'badge', text: n > 99 ? '99+' : String(n) }) : null;
  };

  $('groupList').replaceChildren(...[...S.groups].sort(byRecent).map((g) => {
    const chat = `g:${g.id}`;
    return el('li', { class: 'friend' + (S.active === chat ? ' active' : ''), onclick: () => openChat(chat) },
      avatar(g.name, { group: true, seed: g.id }),
      el('span', { class: 'grow ellipsis', text: g.name }),
      badge(chat));
  }));
  $('noGroups').classList.toggle('hidden', S.groups.length > 0);

  $('friendList').replaceChildren(...[...S.friends].sort(byRecent).map((f) => el('li', {
    class: 'friend' + (S.active === f.id ? ' active' : ''), onclick: () => openChat(f.id),
    title: f.status || '',
  }, avatar(f.name, { online: f.online, seed: f.id, src: f.avatar }),
  el('div', { class: 'grow' }, el('div', { class: 'ellipsis', text: f.name }), f.status ? el('div', { class: 'sub ellipsis', text: f.status }) : null),
  badge(f.id))));
  $('noFriends').classList.toggle('hidden', S.friends.length > 0);

  $('reqSec').classList.toggle('hidden', !S.incoming.length);
  $('reqList').replaceChildren(...S.incoming.map((u) => el('li', {},
    avatar(u.name, { seed: u.id, src: u.avatar }),
    el('span', { class: 'grow ellipsis', text: u.name }),
    el('span', { class: 'actions' },
      iconBtn('check', 'Accept', () => friendAction(u.id, 'accept')),
      iconBtn('x', 'Decline', () => friendAction(u.id, 'remove'))))));

  $('outSec').classList.toggle('hidden', !S.outgoing.length);
  $('outList').replaceChildren(...S.outgoing.map((u) => el('li', {},
    avatar(u.name, { seed: u.id }),
    el('span', { class: 'grow ellipsis', text: u.name === 'Pending…' ? `${u.id.slice(0, 8)}…` : u.name }),
    iconBtn('x', 'Cancel request', () => friendAction(u.id, 'remove')))));

  const total = [...S.unread.values()].reduce((a, b) => a + b, 0);
  document.title = total ? `(${total}) UaN` : 'UaN';
}

async function friendAction(id, action) {
  try {
    await invoke('friend_action', { id, action });
    await loadContacts();
  } catch (err) { toast(err); }
}

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('addMsg');
  msg.classList.remove('hidden');
  try {
    msg.textContent = await invoke('add_friend', { code: $('addInput').value });
    msg.style.color = '';
    $('addInput').value = '';
    loadContacts();
  } catch (err) {
    msg.textContent = err;
    msg.style.color = 'var(--danger)';
  }
  clearTimeout(msg._t);
  msg._t = setTimeout(() => msg.classList.add('hidden'), 7000);
});

// ---------- Chat ----------
async function openChat(chat, focusId) {
  S.active = chat;
  S.unread.delete(chat);
  $('empty').classList.add('hidden');
  $('chat').classList.remove('hidden');
  renderChatHead();
  renderLists();
  renderInviteBar();
  let list = await invoke('messages', { chat, limit: 300 });
  if (focusId && !list.some((m) => m.id === focusId)) list = await invoke('messages', { chat, limit: 20000 });
  S.msgs.set(chat, list);
  if (S.active !== chat) return;
  renderMessages();
  if (focusId) {
    const node = document.querySelector(`.msg[data-id="${focusId}"]`);
    if (node) {
      node.scrollIntoView({ block: 'center' });
      node.classList.add('flash');
      setTimeout(() => node.classList.remove('flash'), 2500);
    }
  } else {
    $('msgInput').focus();
  }
}

function closeChat() {
  S.active = null;
  $('chat').classList.add('hidden');
  $('empty').classList.remove('hidden');
}

function renderChatHead() {
  const info = S.active && chatInfo(S.active);
  if (!info) return;
  $('chatName').textContent = info.name;
  if (info.group) {
    const online = info.group.members.filter((m) => m.online && m.id !== S.me.id).length;
    $('chatStatus').textContent = `${info.group.members.length} members${online ? ` · ${online} online` : ''}`;
    setAvatar($('chatAvatar'), info.name, { group: true, seed: info.group.id });
  } else {
    const mood = info.friend.status ? ` · ${info.friend.status}` : '';
    $('chatStatus').textContent = (info.friend.online ? 'Online' : 'Offline · messages wait for them') + mood;
    setAvatar($('chatAvatar'), info.name, { online: info.friend.online, seed: info.friend.id, src: info.friend.avatar });
  }
}

function renderMessages() {
  const box = $('msgs');
  const list = S.msgs.get(S.active) || [];
  const nodes = [];
  let lastDay = '';
  let lastSender = '';
  for (const m of list) {
    const day = dayFmt.format(m.ts);
    if (day !== lastDay) { nodes.push(el('div', { class: 'day', text: day })); lastDay = day; lastSender = ''; }
    nodes.push(messageNode(m, m.sender !== lastSender));
    lastSender = m.sender;
  }
  box.replaceChildren(...nodes);
  box.scrollTop = box.scrollHeight;
}

function messageNode(m, showSender = true) {
  return el('div', { class: 'msg ' + (m.mine ? 'mine' : 'theirs'), 'data-id': m.id },
    isGroup(m.chat) && !m.mine && showSender ? el('div', { class: 'sender', text: m.senderName }) : null,
    m.file ? fileCard(m.file, m.chat) : null,
    m.text ? el('div', { class: 'bubble', text: m.text }) : null,
    el('span', { class: 'time', text: timeFmt.format(m.ts) }));
}

function fileCard(file, chat) {
  let preview = null;
  if (IMAGE.test(file.mime) && file.size <= INLINE_IMAGE_LIMIT) {
    preview = el('img', { src: mediaUrl(file), alt: '', loading: 'lazy', onclick: () => openViewer(file), onload: keepBottom, onerror: (e) => e.target.remove() });
  } else if (PLAYABLE.test(file.mime)) {
    preview = el('button', { class: 'play', type: 'button', title: 'Play here without downloading', onclick: () => openViewer(file) },
      svg(ICON.bigplay), el('span', { text: file.mime.startsWith('audio') ? 'Listen' : 'Watch now' }));
  }
  const ext = (file.name.includes('.') ? file.name.split('.').pop() : 'file').slice(0, 4);
  const btn = el('button', { class: 'small', type: 'button', 'data-file': file.id });
  updateFileButton(btn, file, chat);
  const together = isGroup(chat) && /^video\//i.test(file.mime)
    ? el('button', { class: 'watch', type: 'button', title: 'Watch this with others in the group, in sync', onclick: () => openPartySetup(file, chat.slice(2)) }, svg(ICON.bigplay), 'Watch together')
    : null;
  return el('div', { class: 'file' },
    preview,
    el('div', { class: 'file-row' },
      el('div', { class: 'ext', text: ext }),
      el('div', { class: 'grow' },
        el('div', { class: 'file-name', title: file.name, text: file.name }),
        el('div', { class: 'sub', text: fmtBytes(file.size) })),
      el('div', { class: 'file-btns' }, btn)),
    together);
}

function downloadOf(fileId) {
  return S.transfers.filter((t) => t.file.id === fileId).pop();
}

function updateFileButton(btn, file, chat) {
  if (file.owner === S.me.id) {
    btn.textContent = 'Sent';
    btn.disabled = true;
    return;
  }
  const t = downloadOf(file.id);
  btn.disabled = false;
  if (t && t.status === 'done') {
    btn.textContent = 'Open';
    btn.onclick = () => invoke('transfer_action', { id: t.id, action: 'open' }).catch(toast);
  } else if (t && t.status === 'running') {
    btn.textContent = `${Math.floor((t.done / Math.max(t.size, 1)) * 100)}%`;
    btn.onclick = null;
  } else {
    btn.textContent = 'Download';
    btn.onclick = () => startDownload(file, chat);
  }
}

function startDownload(file, chat) {
  invoke('download', { file, chat: chat || S.active || '' }).catch(toast);
}

let wasNearBottom = true;
$('msgs').addEventListener('scroll', () => {
  const b = $('msgs');
  wasNearBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 80;
});
function keepBottom() {
  if (wasNearBottom) $('msgs').scrollTop = $('msgs').scrollHeight;
}

function onMessage(m) {
  const list = S.msgs.get(m.chat);
  const isNew = list && !list.some((x) => x.id === m.id);
  if (isNew) list.push(m);
  if (isGroup(m.chat)) {
    const g = groupById(m.chat.slice(2));
    if (g) g.lastAt = m.ts;
  } else {
    const f = friendById(m.chat);
    if (f) f.lastAt = m.ts;
  }
  if (m.chat === S.active) {
    if (isNew) {
      const box = $('msgs');
      const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
      const prev = list[list.length - 2];
      const day = dayFmt.format(m.ts);
      if (!prev || dayFmt.format(prev.ts) !== day) box.append(el('div', { class: 'day', text: day }));
      box.append(messageNode(m, !prev || prev.sender !== m.sender));
      if (near || m.mine) box.scrollTop = box.scrollHeight;
    }
  } else if (!m.mine) {
    S.unread.set(m.chat, (S.unread.get(m.chat) || 0) + 1);
  }
  renderLists();
}

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('msgInput');
  const text = input.value.trim();
  if (!text || !S.active) return;
  input.value = '';
  try {
    await invoke('send_text', { chats: [S.active], text });
  } catch (err) {
    input.value = text;
    toast(err);
  }
});

$('attachBtn').addEventListener('click', () => {
  if (S.active) invoke('pick_and_send', { chats: [S.active], text: '' }).catch(toast);
});

listen('tauri://drag-enter', () => { if (S.active) $('drop').classList.remove('hidden'); });
listen('tauri://drag-leave', () => $('drop').classList.add('hidden'));
listen('tauri://drag-drop', ({ payload }) => {
  $('drop').classList.add('hidden');
  if (!S.active || !payload.paths?.length) return;
  invoke('send_paths', { paths: payload.paths, chats: [S.active], text: '' }).catch(toast);
});

// ---------- Player: our own controls at the bottom (seek bar, volume, CC, full screen) ----------
const PICON = {
  play: '<path d="M8 5v14l11-7Z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/>',
  vol: '<path d="M4 9v6h4l5 4V5L8 9Z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9Z"/><path d="m17 9 4 6M21 9l-4 6"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  exitfull: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  subs: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 9v6M9 12h6"/>',
};
function fmtTime(t) {
  if (!isFinite(t) || t < 0) return '0:00';
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
}
let activePlayer = null;

// Where you stopped watching a film, per file (kept on this PC).
function loadPos(id) {
  try { return Number(localStorage.getItem('uan.pos.' + id)) || 0; } catch { return 0; }
}
function savePos(id, t, d) {
  try {
    if (!d || !isFinite(d) || t < 10 || t > d - 30) localStorage.removeItem('uan.pos.' + id);
    else localStorage.setItem('uan.pos.' + id, String(Math.floor(t)));
  } catch {}
}

function makePlayer(container, { file, chat, autoplay = true, stream = false, resume = true }) {
  const video = el('video', { src: mediaUrl(file), preload: 'auto' });
  video.autoplay = autoplay;
  let savedVol = 1;
  try { savedVol = Number(localStorage.getItem('uan.vol') ?? 1); } catch {}
  video.volume = isFinite(savedVol) ? Math.min(1, Math.max(0, savedVol)) : 1;

  const btn = (title, icon, cls = '') => el('button', { class: `pl-btn ${cls}`, type: 'button', title }, svg(icon));
  const playBtn = btn('Play / pause (Space)', PICON.play);
  const time = el('span', { class: 'pl-time', text: '0:00 / 0:00' });
  const seek = el('input', { type: 'range', class: 'pl-seek', min: 0, max: 1000, step: 1, value: 0, title: 'Seek (← →)' });
  const muteBtn = btn('Mute (M)', PICON.vol);
  const vol = el('input', { type: 'range', class: 'pl-vol', min: 0, max: 100, value: Math.round(video.volume * 100), title: 'Volume' });
  const cc = el('button', { class: 'pl-btn pl-cc', type: 'button', text: 'CC' });
  const load = el('button', { class: 'pl-btn pl-text', type: 'button', title: 'Load a subtitle file from your PC (.srt or .vtt)', text: '+ Subtitles' });
  const fsBtn = btn('Full screen (F)', PICON.full, 'pl-fs');
  const spinner = el('div', { class: 'pl-spin hidden' });
  const bar = el('div', { class: 'pl-bar' }, playBtn, time, seek, muteBtn, vol, cc, load, fsBtn);
  const root = el('div', { class: 'player' }, video, spinner, bar);
  container.replaceChildren(root);

  let dragging = false;
  const setIcon = (b, icon) => b.replaceChildren(svg(icon));
  const refresh = () => {
    const d = video.duration || 0;
    if (!dragging) seek.value = d ? Math.round((video.currentTime / d) * 1000) : 0;
    const shown = dragging && d ? (seek.value / 1000) * d : video.currentTime;
    time.textContent = `${fmtTime(shown)} / ${fmtTime(d)}`;
    let buf = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime + 1) buf = Math.max(buf, video.buffered.end(i));
    }
    const p = d ? seek.value / 10 : 0;
    const b = d ? Math.max(p, Math.min(100, (buf / d) * 100)) : 0;
    seek.style.background = `linear-gradient(to right, var(--accent) ${p}%, rgba(255,255,255,.5) ${p}%, rgba(255,255,255,.5) ${b}%, rgba(255,255,255,.18) ${b}%)`;
    setIcon(playBtn, video.paused ? PICON.play : PICON.pause);
  };
  for (const e of ['timeupdate', 'progress', 'loadedmetadata', 'durationchange', 'play', 'pause', 'seeked']) video.addEventListener(e, refresh);
  video.addEventListener('waiting', () => spinner.classList.remove('hidden'));
  for (const e of ['playing', 'canplay', 'seeked', 'pause']) {
    video.addEventListener(e, () => { if (video.readyState >= 3 || video.paused) spinner.classList.add('hidden'); });
  }

  const toggle = () => (video.paused ? video.play().catch(() => {}) : video.pause());
  playBtn.onclick = toggle;
  video.addEventListener('click', toggle);
  video.addEventListener('dblclick', () => fullscreen());
  seek.addEventListener('input', () => { dragging = true; refresh(); });
  seek.addEventListener('change', () => {
    dragging = false;
    if (video.duration) video.currentTime = (seek.value / 1000) * video.duration;
    refresh();
  });
  const volIcon = () => setIcon(muteBtn, video.muted || video.volume === 0 ? PICON.mute : PICON.vol);
  vol.addEventListener('input', () => {
    video.volume = vol.value / 100;
    video.muted = video.volume === 0;
    volIcon();
    try { localStorage.setItem('uan.vol', String(video.volume)); } catch {}
  });
  muteBtn.onclick = () => { video.muted = !video.muted; volIcon(); };
  video.addEventListener('volumechange', volIcon);

  // Full screen: the player fills the screen and the window goes full screen too.
  async function fullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    else await root.requestFullscreen().catch(() => {});
  }
  const onFs = () => {
    const on = document.fullscreenElement === root;
    setIcon(fsBtn, on ? PICON.exitfull : PICON.full);
    window.__TAURI__.window?.getCurrentWindow?.().setFullscreen(on).catch(() => {});
  };
  document.addEventListener('fullscreenchange', onFs);
  fsBtn.onclick = fullscreen;

  // The bar hides itself while the film plays; moving the mouse brings it back.
  let idleTimer;
  const wake = () => {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!video.paused) root.classList.add('idle'); }, 2500);
  };
  root.addEventListener('mousemove', wake);
  video.addEventListener('play', wake);
  video.addEventListener('pause', wake);

  // Streaming: tell UaN where we are, so it fetches what comes next first.
  let lastFocus = 0;
  const focus = () => {
    if (!stream || !video.duration) return;
    const now = performance.now();
    if (!video.seeking && now - lastFocus < 800) return;
    lastFocus = now;
    invoke('stream_focus', { fileId: file.id, position: Math.floor(file.size * (video.currentTime / video.duration)) }).catch(() => {});
  };
  video.addEventListener('timeupdate', focus);
  video.addEventListener('seeking', focus);

  setupSubs(video, file, cc, load, chat);

  // Remember where we are, and offer to continue from there next time.
  let lastSave = 0;
  video.addEventListener('timeupdate', () => {
    const now = performance.now();
    if (now - lastSave > 4000) { lastSave = now; savePos(file.id, video.currentTime, video.duration); }
  });
  video.addEventListener('ended', () => savePos(file.id, 0, video.duration));
  if (resume) {
    video.addEventListener('loadedmetadata', () => {
      const t = loadPos(file.id);
      if (t > 10 && t < video.duration - 30) {
        video.currentTime = t;
        const note = el('div', { class: 'pl-resume' },
          el('span', { text: `Continuing from ${fmtTime(t)}` }),
          el('button', { type: 'button', class: 'small', text: 'Start over', onclick: () => { video.currentTime = 0; note.remove(); } }));
        root.append(note);
        setTimeout(() => note.remove(), 8000);
      }
    }, { once: true });
  }

  const player = {
    video,
    root,
    fullscreen,
    destroy() {
      savePos(file.id, video.currentTime, video.duration);
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
      clearTimeout(idleTimer);
      video.pause();
      video.removeAttribute('src');
      video.load();
      container.replaceChildren();
      if (activePlayer === player) activePlayer = null;
    },
  };
  activePlayer = player;
  refresh();
  wake();
  return player;
}

document.addEventListener('keydown', (e) => {
  if (!activePlayer || !activePlayer.root.isConnected || e.target.closest('input:not([type=range]), textarea, select')) return;
  if (document.querySelector('dialog[open]')) return;
  const v = activePlayer.video;
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'k') { e.preventDefault(); v.paused ? v.play().catch(() => {}) : v.pause(); }
  else if (k === 'arrowright') { e.preventDefault(); v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); }
  else if (k === 'arrowleft') { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 10); }
  else if (k === 'f') activePlayer.fullscreen();
  else if (k === 'm') v.muted = !v.muted;
  else if (k === 'c') activePlayer.root.querySelector('.pl-cc').click();
});

// ---------- Viewer: watch films without downloading ----------
let viewerPlayer = null;
function openViewer(file) {
  const body = $('viewerBody');
  viewerPlayer?.destroy();
  viewerPlayer = null;
  const note = $('viewerNote');
  note.classList.add('hidden');
  const showError = () => {
    note.textContent = file.owner === S.me.id
      ? 'This format can’t be played inside UaN. Open it from your own disk instead.'
      : 'Can’t play this here. The sender may be offline, or the format isn’t supported (e.g. some AVI files). Download it to watch it in your own player.';
    note.classList.remove('hidden');
  };
  if (/^video\//i.test(file.mime)) {
    viewerPlayer = makePlayer(body, { file, chat: S.active });
    viewerPlayer.video.addEventListener('error', showError);
  } else {
    const src = mediaUrl(file);
    const node = IMAGE.test(file.mime) ? el('img', { src, alt: file.name }) : el('audio', { src, controls: true, autoplay: true });
    node.addEventListener('error', showError);
    body.replaceChildren(node);
  }
  $('viewerName').textContent = `${file.name} · ${fmtBytes(file.size)}`;
  $('viewerDl').classList.toggle('hidden', file.owner === S.me.id);
  $('viewerDl').onclick = () => { startDownload(file, S.active); toast('Download started. It saves to your Downloads folder.'); };
  $('viewer').classList.remove('hidden');
}
function closeViewer() {
  viewerPlayer?.destroy();
  viewerPlayer = null;
  $('viewer').classList.add('hidden');
  $('viewerBody').replaceChildren(); // stops playback and network reads
}
$('viewerClose').addEventListener('click', closeViewer);

// ---------- Picking friends: send to several / new group / add to group ----------
let pickMode = null;
let pickGroup = null;

function openPick(mode, group) {
  pickMode = mode;
  pickGroup = group;
  let choices = S.friends;
  if (mode === 'add') choices = S.friends.filter((f) => !group.members.some((m) => m.id === f.id));
  if (!choices.length) return toast(mode === 'add' ? 'All your friends are already in this group.' : 'Add a friend first.');
  $('pickTitle').textContent = { multi: 'Send to several', group: 'Create a group', add: `Add to ${group?.name}` }[mode];
  $('pickNote').textContent = {
    multi: 'Pick friends and groups. A file is sent once and lands in every chat.',
    group: 'Pick the friends to put in the group. Everyone sees everything posted there.',
    add: 'Pick friends to add.',
  }[mode];
  $('pickName').classList.toggle('hidden', mode !== 'group');
  $('pickText').classList.toggle('hidden', mode !== 'multi');
  $('pickAlt').classList.toggle('hidden', mode !== 'multi');
  $('pickAlt').textContent = 'Send message only';
  $('pickOk').textContent = { multi: 'Choose files…', group: 'Create group', add: 'Add' }[mode];
  $('pickName').value = '';
  $('pickText').value = '';
  $('pickError').textContent = '';
  const rows = choices.map((f) => el('label', {}, el('input', { type: 'checkbox', value: f.id, checked: f.id === S.active }), avatar(f.name, { online: f.online, seed: f.id, src: f.avatar }), el('span', { text: f.name })));
  if (mode === 'multi') {
    rows.unshift(...S.groups.map((g) => el('label', {}, el('input', { type: 'checkbox', value: `g:${g.id}`, checked: S.active === `g:${g.id}` }), avatar(g.name, { group: true, seed: g.id }), el('span', { text: g.name }))));
  }
  $('pickList').replaceChildren(...rows);
  renderRecent(mode);
  $('pickDlg').showModal();
  (mode === 'group' ? $('pickName') : $('pickOk')).focus();
}
const picked = () => [...$('pickList').querySelectorAll('input:checked')].map((b) => b.value);

// Remember who you sent to, so you can pick the same people again with one click.
function recentSends() {
  try { return JSON.parse(localStorage.getItem('uan.recent') || '[]'); } catch { return []; }
}
function saveRecent(chats) {
  const key = [...chats].sort().join(',');
  const list = recentSends().filter((c) => [...c].sort().join(',') !== key);
  list.unshift(chats);
  try { localStorage.setItem('uan.recent', JSON.stringify(list.slice(0, 5))); } catch {}
}
function renderRecent(mode) {
  const box = $('pickRecent');
  const sets = mode === 'multi' ? recentSends().map((c) => c.filter((id) => chatInfo(id))).filter((c) => c.length) : [];
  box.classList.toggle('hidden', !sets.length);
  box.replaceChildren(el('span', { class: 'note', text: 'Recent:' }), ...sets.slice(0, 4).map((c, i) => el('button', {
    type: 'button',
    class: 'chip',
    title: 'Select these again',
    onclick: () => {
      for (const b of $('pickList').querySelectorAll('input')) b.checked = c.includes(b.value);
    },
  }, (i === 0 ? 'Last time: ' : '') + c.map((id) => chatInfo(id)?.name).join(', '))));
}

$('multiBtn').addEventListener('click', () => openPick('multi'));
$('newGroupBtn').addEventListener('click', () => openPick('group'));
$('pickCancel').addEventListener('click', () => $('pickDlg').close());
$('pickAll').addEventListener('click', () => {
  const boxes = [...$('pickList').querySelectorAll('input')];
  const all = boxes.every((b) => b.checked);
  boxes.forEach((b) => { b.checked = !all; });
});
$('pickAlt').addEventListener('click', async () => {
  const chats = picked();
  const text = $('pickText').value.trim();
  if (!chats.length) return void ($('pickError').textContent = 'Pick at least one.');
  if (!text) return void ($('pickError').textContent = 'Write a message first.');
  try {
    await invoke('send_text', { chats, text });
    saveRecent(chats);
    $('pickDlg').close();
  } catch (err) { $('pickError').textContent = err; }
});
$('pickForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ids = picked();
  try {
    if (pickMode === 'multi') {
      if (!ids.length) return void ($('pickError').textContent = 'Pick at least one.');
      const n = await invoke('pick_and_send', { chats: ids, text: $('pickText').value.trim() });
      if (n > 0) { saveRecent(ids); $('pickDlg').close(); }
    } else if (pickMode === 'group') {
      const id = await invoke('create_group', { name: $('pickName').value, members: ids });
      $('pickDlg').close();
      await loadContacts();
      openChat(`g:${id}`);
    } else if (pickMode === 'add') {
      if (!ids.length) return void ($('pickError').textContent = 'Pick at least one.');
      await invoke('group_action', { group: pickGroup.id, action: 'add', ids, name: '' });
      $('pickDlg').close();
      await loadContacts();
      openGroupInfo();
    }
  } catch (err) { $('pickError').textContent = err; }
});

// ---------- Chat details ----------
$('chatInfoBtn').addEventListener('click', async () => {
  const info = chatInfo(S.active);
  if (!info) return;
  if (info.group) return openGroupInfo();
  if (await ask(`Remove ${info.name} from your friends? You won’t be able to message each other until one of you adds the other again.`, 'Remove friend')) {
    friendAction(info.friend.id, 'remove');
  }
});

function openGroupInfo() {
  const g = groupById(S.active?.slice(2));
  if (!g) return;
  const owner = g.owner === S.me.id;
  $('gTitle').textContent = g.name;
  $('gRenameRow').classList.toggle('hidden', !owner);
  $('gName').value = g.name;
  $('gCount').textContent = `${g.members.length} members`;
  $('gError').textContent = '';
  $('gMembers').replaceChildren(...g.members.map((m) => el('li', {},
    avatar(m.name, { online: m.online, seed: m.id, src: m.id === S.me.id ? S.me.profile?.avatar : m.avatar }),
    el('span', { class: 'grow ellipsis', text: m.id === S.me.id ? `${m.name} (you)` : m.name + (m.status ? ` · ${m.status}` : '') }),
    m.id === g.owner ? el('span', { class: 'tag', text: 'creator' }) : null,
    owner && m.id !== S.me.id ? iconBtn('x', 'Remove from group', () => groupAct(g, 'remove', [m.id])) : null)));
  $('gAdd').classList.toggle('hidden', !owner);
  $('gLeave').textContent = owner ? 'Delete group' : 'Leave group';
  if (!$('groupDlg').open) $('groupDlg').showModal();
}

async function groupAct(g, action, ids = [], name = '') {
  try {
    await invoke('group_action', { group: g.id, action, ids, name });
    await loadContacts();
    if (groupById(g.id)) openGroupInfo();
    else $('groupDlg').close();
  } catch (err) { $('gError').textContent = err; }
}
$('gRename').addEventListener('click', () => groupAct(groupById(S.active.slice(2)), 'rename', [], $('gName').value));
$('gAdd').addEventListener('click', () => {
  const g = groupById(S.active.slice(2));
  $('groupDlg').close();
  openPick('add', g);
});
$('gClose').addEventListener('click', () => $('groupDlg').close());
$('gLeave').addEventListener('click', async () => {
  const g = groupById(S.active.slice(2));
  const owner = g.owner === S.me.id;
  $('groupDlg').close();
  if (await ask(owner ? `Delete “${g.name}” for everyone?` : `Leave “${g.name}”?`, owner ? 'Delete' : 'Leave')) {
    await groupAct(g, owner ? 'delete' : 'leave');
    closeChat();
  }
});

// ---------- Downloads ----------
$('trHead').addEventListener('click', () => $('transfers').classList.toggle('collapsed'));

function renderTransfers() {
  const list = S.transfers;
  $('transfers').classList.toggle('hidden', !list.length);
  const running = list.filter((t) => t.status === 'running').length;
  $('trTitle').textContent = running ? `Downloads · ${running} active` : 'Downloads';
  $('trList').replaceChildren(...[...list].reverse().map((t) => {
    const pct = t.size ? (t.done / t.size) * 100 : 100;
    let info;
    if (t.status === 'running') {
      info = t.error || [`${fmtBytes(t.done)} of ${fmtBytes(t.size)}`, t.speed ? `${fmtBytes(t.speed)}/s` : '', t.speed ? `${fmtDur((t.size - t.done) / t.speed)} left` : ''].filter(Boolean).join(' · ');
    } else if (t.status === 'paused') info = t.error || `Paused · ${Math.floor(pct)}%`;
    else if (t.status === 'error') info = t.error || 'Failed';
    else info = 'Saved to Downloads';
    const btns = [];
    if (t.status === 'running') btns.push(iconBtn('pause', 'Pause', () => act(t, 'pause')));
    if (t.status === 'paused' || t.status === 'error') btns.push(iconBtn('play', 'Resume', () => act(t, 'resume')));
    if (t.status === 'done') {
      btns.push(iconBtn('open', 'Open', () => act(t, 'open')));
      btns.push(iconBtn('folder', 'Show in folder', () => act(t, 'reveal')));
      btns.push(iconBtn('x', 'Remove from list', () => act(t, 'dismiss')));
    } else {
      btns.push(iconBtn('x', 'Cancel download', async () => {
        if (await ask(`Cancel downloading “${t.name}”?`, 'Cancel download')) act(t, 'cancel');
      }));
    }
    const bar = el('div');
    bar.style.width = `${pct}%`;
    return el('div', { class: `tr ${t.status}` },
      el('div', { class: 'tr-name', title: t.path, text: t.name }),
      el('div', { class: 'tr-btns' }, btns),
      el('div', { class: 'bar' }, bar),
      el('div', { class: 'tr-info', title: info, text: info }));
  }));
  document.querySelectorAll('button[data-file]').forEach((btn) => {
    const m = (S.msgs.get(S.active) || []).find((x) => x.file?.id === btn.dataset.file);
    if (m) updateFileButton(btn, m.file, m.chat);
  });
}
function act(t, action) {
  invoke('transfer_action', { id: t.id, action }).catch(toast);
}

// ---------- Settings ----------
let pendingAvatar = null; // null = unchanged, '' = remove, data URL = new picture

function renderAvatarPick() {
  const btn = $('sAvatarBtn');
  const src = pendingAvatar === null ? S.me.profile?.avatar : pendingAvatar;
  btn.style.background = `hsl(${hue(S.me.id)} 45% 48%)`;
  btn.replaceChildren(src ? el('img', { src, alt: '' }) : ($('sName').value || S.me.name || '?')[0].toUpperCase());
}

$('settingsBtn').addEventListener('click', async () => {
  S.me = await invoke('state');
  pendingAvatar = null;
  $('sName').value = S.me.name;
  $('sStatus').value = S.me.profile?.status || '';
  renderAvatarPick();
  $('sTheme').value = theme.mode;
  renderSwatches();
  $('sMailbox').value = S.me.mailbox || '';
  $('sAuto').checked = S.me.autostart;
  $('sAutoRow').classList.toggle('hidden', !!S.me.profileName);
  $('sCode').textContent = S.me.code;
  $('sCode').classList.add('hidden');
  $('sShowCode').textContent = 'Show friend code';
  $('sError').textContent = '';
  $('settingsDlg').showModal();
});
$('sCancel').addEventListener('click', () => $('settingsDlg').close());
$('sShowCode').addEventListener('click', () => {
  const hidden = $('sCode').classList.toggle('hidden');
  $('sShowCode').textContent = hidden ? 'Show friend code' : 'Hide friend code';
});
$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const status = $('sStatus').value.trim();
    if ($('sName').value.trim() !== S.me.name || status !== (S.me.profile?.status || '') || pendingAvatar !== null) {
      await invoke('set_profile', { name: $('sName').value, status, avatar: pendingAvatar });
    }
    if ($('sMailbox').value.trim() !== (S.me.mailbox || '')) {
      await invoke('set_mailbox', { url: $('sMailbox').value });
      invoke('check_mailbox').catch(() => {});
    }
    if (!S.me.profileName && $('sAuto').checked !== S.me.autostart) await invoke('set_autostart', { enabled: $('sAuto').checked });
    S.me = await invoke('state');
    renderMe();
    $('settingsDlg').close();
  } catch (err) { $('sError').textContent = err; }
});

// ---------- Search ----------
function chatLabel(chat) {
  return chatInfo(chat)?.name || (isGroup(chat) ? 'Old group' : 'Former friend');
}

function openSearch() {
  const people = new Map();
  for (const f of S.friends) people.set(f.id, f.name);
  for (const g of S.groups) for (const m of g.members) if (m.id !== S.me.id) people.set(m.id, m.name);
  $('sFrom').replaceChildren(
    el('option', { value: '', text: 'From anyone' }),
    el('option', { value: S.me.id, text: 'From me' }),
    ...[...people].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => el('option', { value: id, text: `From ${name}` })),
  );
  $('sChat').replaceChildren(
    el('option', { value: '', text: 'In all chats' }),
    ...S.groups.map((g) => el('option', { value: `g:${g.id}`, text: `In ${g.name}` })),
    ...S.friends.map((f) => el('option', { value: f.id, text: `With ${f.name}` })),
  );
  $('sChat').value = S.active || '';
  $('searchDlg').showModal();
  $('sq').focus();
  $('sq').select();
  runSearch();
}

let searchTimer;
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 200);
}

function highlight(text, q) {
  const span = el('span', { class: 'result-text' });
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) {
    span.textContent = text;
    return span;
  }
  const start = Math.max(0, i - 40);
  span.append((start ? '…' : '') + text.slice(start, i), el('mark', { text: text.slice(i, i + q.length) }), text.slice(i + q.length));
  return span;
}

async function runSearch() {
  const q = $('sq').value.trim();
  const days = Number($('sSince').value);
  const since = days === 1 ? new Date().setHours(0, 0, 0, 0) : days ? Date.now() - days * 86400000 : 0;
  const results = await invoke('search', { query: q, kind: $('sKind').value, from: $('sFrom').value, chat: $('sChat').value, since });
  $('sCount').textContent = results.length >= 300 ? 'Showing the newest 300 matches' : `${results.length} match${results.length === 1 ? '' : 'es'}`;
  $('sResults').replaceChildren(...results.map((m) => {
    const ext = m.file ? (m.file.name.includes('.') ? m.file.name.split('.').pop() : 'file').slice(0, 4) : '💬';
    const main = m.file
      ? el('div', { class: 'result-text' }, highlight(m.file.name, q), el('span', { class: 'sub', text: `  ·  ${fmtBytes(m.file.size)}` }))
      : highlight(m.text || '', q);
    return el('div', {
      class: 'result',
      onclick: () => { $('searchDlg').close(); openChat(m.chat, m.id); },
    },
    el('div', { class: 'ext', text: ext }),
    el('div', { class: 'grow' },
      el('div', { class: 'result-meta', text: `${chatLabel(m.chat)} · ${m.mine ? 'You' : m.senderName} · ${dayFmt.format(m.ts)} ${timeFmt.format(m.ts)}` }),
      main,
      m.file && m.text ? el('div', { class: 'sub ellipsis', text: m.text }) : null));
  }));
}

$('searchBtn').addEventListener('click', openSearch);
$('searchClose').addEventListener('click', () => $('searchDlg').close());
$('searchForm').addEventListener('submit', (e) => e.preventDefault());
$('sq').addEventListener('input', scheduleSearch);
for (const id of ['sKind', 'sFrom', 'sChat', 'sSince']) $(id).addEventListener('change', runSearch);

// ---------- Watch together ----------
const mbps = (bps) => (bps == null ? null : (bps * 8) / 1e6);
let partySetup = null; // { file, group, speeds }

async function openPartySetup(file, groupId) {
  const g = groupById(groupId);
  if (!g) return;
  partySetup = { file, group: g, speeds: null };
  $('pFile').textContent = `${file.name} · ${fmtBytes(file.size)}`;
  $('pError').textContent = '';
  $('pBest').textContent = 'Testing everyone’s connection…';
  const others = g.members.filter((m) => m.id !== S.me.id);
  $('pList').replaceChildren(...others.map((m) => el('label', { 'data-id': m.id },
    el('input', { type: 'checkbox', value: m.id, checked: m.online }),
    avatar(m.name, { online: m.online, seed: m.id, src: m.avatar }),
    el('span', { text: m.name }),
    el('span', { class: 'speed', text: '…' }))));
  $('partyDlg').showModal();
  const speeds = await invoke('party_probe', { members: g.members.map((m) => m.id) }).catch(() => ({}));
  if (partySetup?.file.id !== file.id) return;
  partySetup.speeds = speeds;
  for (const row of $('pList').querySelectorAll('label')) {
    const v = mbps(speeds[row.dataset.id]);
    row.querySelector('.speed').textContent = v == null ? 'offline' : `${v.toFixed(0)} Mbit/s up`;
  }
  updateBest();
}

function bestHost() {
  if (!partySetup) return null;
  const invited = new Set([S.me.id, ...[...$('pList').querySelectorAll('input:checked')].map((b) => b.value)]);
  const speeds = partySetup.speeds || {};
  let best = null;
  for (const id of invited) {
    const v = speeds[id];
    if (v != null && (!best || v > best.v)) best = { id, v };
  }
  return best;
}

function nameOf(id) {
  if (id === S.me.id) return 'You';
  const m = partySetup?.group.members.find((x) => x.id === id) || S.friends.find((f) => f.id === id);
  return m?.name || 'Someone';
}

function updateBest() {
  if (!partySetup?.speeds) return;
  const best = bestHost();
  $('pBest').textContent = best
    ? `⭐ ${nameOf(best.id)} ${best.id === S.me.id ? 'have' : 'has'} the fastest connection (${mbps(best.v).toFixed(0)} Mbit/s up), so ${best.id === S.me.id ? 'your' : 'their'} PC will share the film with everyone. Nobody downloads it: it streams, and it only starts (and keeps going) when everyone has enough loaded, so it won’t stutter even on slow internet.`
    : 'Couldn’t measure anyone’s connection (are they online?). The film will be shared from the sender.';
}
$('pList').addEventListener('change', updateBest);
$('pAll').addEventListener('click', () => {
  const boxes = [...$('pList').querySelectorAll('input')];
  const all = boxes.every((b) => b.checked);
  boxes.forEach((b) => { b.checked = !all; });
  updateBest();
});
$('pCancel').addEventListener('click', () => { partySetup = null; $('partyDlg').close(); });
$('partyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const members = [...$('pList').querySelectorAll('input:checked')].map((b) => b.value);
  if (!members.length) return void ($('pError').textContent = 'Invite at least one person.');
  try {
    const seeder = bestHost()?.id || partySetup.file.owner;
    const id = await invoke('party_create', { group: partySetup.group.id, file: partySetup.file, members, seeder });
    $('partyDlg').close();
    S.parties.set(id, (await invoke('parties')).find((p) => p.id === id));
    openParty(id);
  } catch (err) { $('pError').textContent = err; }
});

// Invitations show up as a bar in the group chat.
function renderInviteBar() {
  const bar = $('inviteBar');
  const p = [...S.parties.values()].find((x) => S.active === `g:${x.group}` && x.state !== 'ended' && x.members.some((m) => m.id === S.me.id && !m.joined && !m.left));
  bar.classList.toggle('hidden', !p);
  if (!p) return;
  const host = p.members.find((m) => m.id === p.leader)?.name || 'Someone';
  bar.replaceChildren(
    svg(ICON.bigplay),
    el('span', { class: 'grow ellipsis', text: `${host} invited you to watch “${p.file.name}” together` }),
    el('button', { class: 'accent small', type: 'button', text: 'Join', onclick: async () => { await invoke('party_join', { id: p.id }).catch(toast); openParty(p.id); } }),
    el('button', { class: 'small', type: 'button', text: 'Not now', onclick: () => { invoke('party_leave', { id: p.id }); S.parties.delete(p.id); renderInviteBar(); } }));
}

const READY_AHEAD = 48 * 1024 * 1024; // same as the app core
let openPartyId = null;
let partyPlayer = null;
let heartbeat = null;
let autoPaused = false;
let bufferTimer = null;
// Changes we make ourselves (to follow the host) must not be sent back as if the user did them.
const expect = { play: 0, pause: 0, seek: 0 };
const expecting = (k) => performance.now() < expect[k];

function openParty(id) {
  const p = S.parties.get(id);
  if (!p) return;
  partyPlayer?.destroy();
  openPartyId = id;
  autoPaused = false;
  partyPlayer = makePlayer($('partyStage'), { file: p.file, chat: `g:${p.group}`, autoplay: false, stream: true, resume: false });
  const v = partyPlayer.video;
  v.addEventListener('play', () => { if (expecting('play')) { expect.play = 0; return; } userControl(); });
  v.addEventListener('pause', () => { if (expecting('pause')) { expect.pause = 0; return; } if (!v.ended) userControl(); });
  v.addEventListener('seeked', () => { if (expecting('seek')) { expect.seek = 0; return; } userControl(); });
  // Tell the host when our video is stuck loading, so everyone waits for us.
  v.addEventListener('waiting', () => {
    clearTimeout(bufferTimer);
    bufferTimer = setTimeout(() => invoke('party_buffering', { id, buffering: true }).catch(() => {}), 1200);
  });
  const fine = () => {
    clearTimeout(bufferTimer);
    invoke('party_buffering', { id, buffering: false }).catch(() => {});
  };
  v.addEventListener('playing', fine);
  v.addEventListener('canplaythrough', fine);
  $('party').classList.remove('hidden');
  renderParty(p);
  clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    const cur = S.parties.get(openPartyId);
    if (cur && cur.leader === S.me.id && cur.state === 'playing' && !v.paused && !v.seeking && v.readyState >= 3) {
      invoke('party_control', { id: cur.id, state: 'playing', position: v.currentTime }).catch(() => {});
    }
  }, 3000);
}

function closeParty() {
  clearInterval(heartbeat);
  clearTimeout(bufferTimer);
  openPartyId = null;
  partyPlayer?.destroy();
  partyPlayer = null;
  $('party').classList.add('hidden');
}

// Leaving keeps the party going for the others (if you were the host, someone else takes over).
// Your spot in the film is saved, so you can carry on later from the chat.
async function leaveParty(end) {
  const p = S.parties.get(openPartyId);
  if (!p) return closeParty();
  const leader = p.leader === S.me.id;
  const others = p.members.filter((m) => m.id !== S.me.id && m.joined && !m.left);
  if (end) {
    if (!(await ask('End the watch party for everyone?', 'End for everyone'))) return;
  } else if (leader && others.length) {
    if (!(await ask(`Leave the watch party? The others keep watching and ${others[0].name} becomes the host. You can continue the film later from where you stopped.`, 'Leave'))) return;
  }
  invoke('party_leave', { id: p.id, end: !!end || (leader && !others.length) });
  S.parties.delete(openPartyId);
  closeParty();
  renderInviteBar();
}
$('partyLeave').addEventListener('click', () => leaveParty(false));
$('partyEnd').addEventListener('click', () => leaveParty(true));

const joinedOf = (p) => p.members.filter((m) => m.joined && !m.left);
function partyReady(p) {
  const j = joinedOf(p);
  return j.length >= 2 && j.every((m) => m.ready);
}

function control(p, state, position) {
  return invoke('party_control', { id: p.id, state, position }).catch(() => {});
}

function renderParty(p) {
  const leader = p.leader === S.me.id;
  const leaderName = p.members.find((m) => m.id === p.leader)?.name || '';
  const v = partyPlayer?.video;
  $('partyTitle').textContent = `Watching together: ${p.file.name}${leader ? '' : ` · hosted by ${leaderName}`}`;
  $('partyMembers').replaceChildren(...p.members.filter((m) => !m.left).map((m) => {
    const full = m.have >= p.file.size;
    const status = !m.joined ? 'invited'
      : m.buffering ? 'loading…'
      : m.ready ? (full ? 'ready ✓' : `ready ✓ · ${fmtBytes(m.have)} ahead`)
      : `buffering ${fmtBytes(m.have)}`;
    const bar = el('div');
    bar.style.width = `${m.joined ? Math.min(100, (m.have / Math.min(READY_AHEAD, p.file.size || 1)) * 100) : 0}%`;
    return el('div', { class: 'pm' + (m.ready && m.joined && !m.buffering ? ' ready' : '') },
      el('div', { class: 'strong ellipsis', text: (m.id === S.me.id ? 'You' : m.name) + (m.id === p.seeder ? ' ⭐' : '') }),
      el('div', { class: 'sub', text: status + (m.id === p.seeder ? ' · shares the film' : '') }),
      el('div', { class: 'bar' }, bar));
  }));

  const wait = $('partyWait');
  const stuck = joinedOf(p).filter((m) => m.buffering || (p.state !== 'playing' && !m.ready));
  if (p.state === 'loading') {
    wait.textContent = partyReady(p)
      ? 'Everyone is ready. Starting…'
      : `Getting the film ready for everyone. Nothing is downloaded, it streams.\nIt starts as soon as everyone has enough loaded${stuck.length ? ` (waiting for ${stuck.map((m) => (m.id === S.me.id ? 'you' : m.name)).join(', ')})` : ''}.`;
    wait.classList.remove('hidden');
  } else if (p.state === 'paused' && stuck.length) {
    wait.textContent = `Waiting for ${stuck.map((m) => (m.id === S.me.id ? 'you' : m.name)).join(', ')} to catch up…\nThe film continues for everyone automatically.`;
    wait.classList.remove('hidden');
  } else {
    wait.classList.add('hidden');
  }
  $('partyStart').classList.toggle('hidden', !(leader && p.state === 'loading'));
  $('partyEnd').classList.toggle('hidden', !leader);

  // The host keeps everyone together: start when all are ready, pause while someone is loading.
  if (leader && v) {
    const j = joinedOf(p);
    if (p.state === 'loading' && partyReady(p)) control(p, 'playing', v.currentTime || 0);
    else if (p.state === 'playing' && j.some((m) => m.buffering)) { autoPaused = true; control(p, 'paused', v.currentTime); }
    else if (p.state === 'paused' && autoPaused && j.every((m) => m.ready && !m.buffering)) { autoPaused = false; control(p, 'playing', v.currentTime); }
  }
  applyPartyState(p);
}

$('partyStart').addEventListener('click', () => {
  const p = S.parties.get(openPartyId);
  if (p) control(p, 'playing', partyPlayer?.video.currentTime || 0);
});

function applyPartyState(p) {
  const v = partyPlayer?.video;
  if (!v) return;
  const soon = performance.now() + 2500;
  if (p.state === 'loading' || p.state === 'paused') {
    if (!v.paused) { expect.pause = soon; v.pause(); }
    if (p.state === 'paused' && Math.abs(v.currentTime - p.position) > 0.5 && !v.seeking) { expect.seek = soon; v.currentTime = p.position; }
    return;
  }
  // Playing: only jump if we are clearly off (someone seeked), never while we are still loading a jump.
  if (Math.abs(v.currentTime - p.position) > 2 && !v.seeking) { expect.seek = soon; v.currentTime = p.position; }
  if (v.paused) { expect.play = soon; v.play().catch(() => {}); }
}

// Anyone in the party can play, pause or seek; it goes through the host to everyone.
function userControl() {
  const p = S.parties.get(openPartyId);
  const v = partyPlayer?.video;
  if (!p || !v) return;
  if (p.state === 'loading' && p.leader !== S.me.id) {
    expect.pause = performance.now() + 1500;
    v.pause();
    return toast('Waiting for the host to start the film.');
  }
  if (p.leader === S.me.id) autoPaused = false;
  control(p, v.paused ? 'paused' : 'playing', v.currentTime);
}

listen('party', ({ payload: p }) => {
  if (p.state === 'ended') {
    S.parties.delete(p.id);
    if (openPartyId === p.id) {
      closeParty();
      toast('The watch party has ended.');
    }
  } else {
    const isNew = !S.parties.has(p.id);
    S.parties.set(p.id, p);
    if (openPartyId === p.id) renderParty(p);
    if (isNew && p.leader !== S.me.id) toast(`You were invited to watch “${p.file.name}” together. Open the group to join.`);
  }
  renderInviteBar();
});

// ---------- Profile picture ----------
async function pickAvatar() {
  $('avatarFile').value = '';
  $('avatarFile').click();
}
$('sAvatarBtn').addEventListener('click', pickAvatar);
$('sAvatarPick').addEventListener('click', pickAvatar);
$('sAvatarRemove').addEventListener('click', () => { pendingAvatar = ''; renderAvatarPick(); });
$('sName').addEventListener('input', renderAvatarPick);
$('avatarFile').addEventListener('change', async () => {
  const file = $('avatarFile').files[0];
  if (!file) return;
  try {
    // Crop to a square and shrink to 160 px, so it is small enough to send to friends.
    const img = await createImageBitmap(file);
    const side = Math.min(img.width, img.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 160;
    canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 160, 160);
    pendingAvatar = canvas.toDataURL('image/jpeg', 0.85);
    renderAvatarPick();
  } catch {
    $('sError').textContent = 'That file isn’t a picture UaN can read.';
  }
});

// ---------- Themes ----------
const ACCENTS = [
  { name: 'Blue', light: '#005fb8', dark: '#60cdff' },
  { name: 'Purple', light: '#7a3ec8', dark: '#c4a3ff' },
  { name: 'Green', light: '#107c41', dark: '#6ccb8f' },
  { name: 'Orange', light: '#c25400', dark: '#ffb36b' },
  { name: 'Pink', light: '#bf0077', dark: '#ff8ccf' },
  { name: 'Red', light: '#c42b1c', dark: '#ff8a80' },
];
const theme = (() => {
  try { return { mode: localStorage.getItem('uan.theme') || 'system', accent: Number(localStorage.getItem('uan.accent') || 0) }; } catch { return { mode: 'system', accent: 0 }; }
})();

function isDark() {
  return theme.mode === 'dark' || (theme.mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}
function applyTheme() {
  const root = document.documentElement;
  if (theme.mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme.mode;
  const a = ACCENTS[theme.accent] || ACCENTS[0];
  const dark = isDark();
  const color = dark ? a.dark : a.light;
  root.style.setProperty('--accent', color);
  root.style.setProperty('--accent-hover', color);
  root.style.setProperty('--on-accent', dark ? '#000' : '#fff');
  root.style.setProperty('--mine', dark ? `color-mix(in srgb, ${a.dark} 45%, #1c1c1c)` : a.light);
  root.style.setProperty('--on-mine', '#fff');
}
function renderSwatches() {
  $('sAccent').replaceChildren(...ACCENTS.map((a, i) => {
    const b = el('button', { type: 'button', class: 'swatch' + (i === theme.accent ? ' on' : ''), title: a.name, onclick: () => {
      theme.accent = i;
      try { localStorage.setItem('uan.accent', String(i)); } catch {}
      applyTheme();
      renderSwatches();
    } });
    b.style.background = isDark() ? a.dark : a.light;
    return b;
  }));
}
$('sTheme').addEventListener('change', () => {
  theme.mode = $('sTheme').value;
  try { localStorage.setItem('uan.theme', theme.mode); } catch {}
  applyTheme();
  renderSwatches();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();

// ---------- Subtitles: off by default, one click to turn on ----------
let subsOn = (() => { try { return localStorage.getItem('uan.subs') === '1'; } catch { return false; } })();
let subTarget = null; // { video, cc }

function srtToVtt(text) {
  const body = text.replace(/\r/g, '').replace(/^\uFEFF/, '');
  if (body.startsWith('WEBVTT')) return body;
  return 'WEBVTT\n\n' + body.replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
}

function attachSubs(video, text, cc) {
  video.querySelectorAll('track').forEach((t) => t.remove());
  const url = URL.createObjectURL(new Blob([srtToVtt(text)], { type: 'text/vtt' }));
  const track = el('track', { kind: 'subtitles', label: 'Subtitles', srclang: 'en', src: url, default: true });
  video.append(track);
  setTimeout(() => updateCC(video, cc), 50);
}

function updateCC(video, cc) {
  const tracks = [...video.textTracks];
  for (const t of tracks) t.mode = subsOn ? 'showing' : 'hidden';
  cc.textContent = 'CC';
  cc.classList.toggle('on', subsOn && tracks.length > 0);
  cc.classList.toggle('dim', !tracks.length);
  cc.title = tracks.length ? 'Turn subtitles on or off' : 'No subtitles loaded yet. Use “Load subtitles…”, or send the .srt file into the chat.';
}

// Finds a subtitle file with the same name sent in the same chat (film.mkv → film.srt).
async function findSubsInChat(file, chat) {
  if (!chat) return null;
  let list = S.msgs.get(chat);
  if (!list) list = await invoke('messages', { chat, limit: 2000 }).catch(() => []);
  const base = file.name.replace(/\.[^.]+$/, '').toLowerCase();
  const sub = list.map((m) => m.file).filter(Boolean).find((f) => /\.(srt|vtt)$/i.test(f.name) && f.name.replace(/\.[^.]+$/, '').toLowerCase() === base);
  if (!sub) return null;
  const r = await fetch(mediaUrl(sub)).catch(() => null);
  return r && r.ok ? r.text() : null;
}

function setupSubs(video, file, cc, loadBtn, chat) {
  video.querySelectorAll('track').forEach((t) => t.remove());
  updateCC(video, cc);
  cc.onclick = () => {
    if (!video.textTracks.length) return toast('No subtitles yet. Click “Load subtitles…” to pick a .srt file.');
    subsOn = !subsOn;
    try { localStorage.setItem('uan.subs', subsOn ? '1' : '0'); } catch {}
    updateCC(video, cc);
  };
  loadBtn.onclick = () => {
    subTarget = { video, cc };
    $('subFile').value = '';
    $('subFile').click();
  };
  findSubsInChat(file, chat).then((text) => {
    if (text && video.isConnected) attachSubs(video, text, cc);
  });
}

$('subFile').addEventListener('change', async () => {
  const f = $('subFile').files[0];
  if (!f || !subTarget) return;
  const text = await f.text();
  subsOn = true;
  try { localStorage.setItem('uan.subs', '1'); } catch {}
  attachSubs(subTarget.video, text, subTarget.cc);
});

// ---------- Gallery: every photo, video and file in a chat ----------
let galleryTab = 'media';
async function openGallery() {
  if (!S.active) return;
  $('galleryTitle').textContent = `${chatLabel(S.active)} · media and files`;
  $('galleryDlg').showModal();
  renderGallery();
}
const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
async function renderGallery() {
  document.querySelectorAll('.gtabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === galleryTab));
  const body = $('galleryBody');
  const chat = S.active;
  if (galleryTab === 'media') {
    const [imgs, vids] = await Promise.all([
      invoke('search', { query: '', kind: 'image', from: '', chat, since: 0 }),
      invoke('search', { query: '', kind: 'video', from: '', chat, since: 0 }),
    ]);
    const items = [...imgs, ...vids].sort((a, b) => b.ts - a.ts);
    body.className = 'results gallery grid';
    if (!items.length) {
      body.replaceChildren(el('div', { class: 'empty-note', text: 'No photos or videos in this chat yet.' }));
      return;
    }
    const nodes = [];
    let lastMonth = '';
    let videoThumbs = 0;
    for (const m of items) {
      const month = monthFmt.format(m.ts);
      if (month !== lastMonth) { nodes.push(el('div', { class: 'g-month', text: month })); lastMonth = month; }
      const isImg = IMAGE.test(m.file.mime) && m.file.size <= INLINE_IMAGE_LIMIT;
      const isVideo = /^video\//i.test(m.file.mime);
      let thumb;
      let badge = null;
      if (isImg) {
        thumb = el('img', { src: mediaUrl(m.file), alt: '', loading: 'lazy' });
      } else if (isVideo && videoThumbs++ < 24) {
        // A frame from a few seconds in, as a preview picture.
        thumb = el('video', { src: `${mediaUrl(m.file)}#t=3`, preload: 'metadata', muted: true });
        badge = el('span', { class: 'tile-badge' });
        thumb.addEventListener('loadedmetadata', () => { badge.textContent = fmtTime(thumb.duration); });
      } else {
        thumb = el('div', { class: 'tile-blank' });
      }
      nodes.push(el('button', {
        type: 'button',
        class: 'tile',
        title: `${m.file.name}\n${fmtBytes(m.file.size)} · ${m.mine ? 'You' : m.senderName} · ${dayFmt.format(m.ts)}`,
        onclick: () => { $('galleryDlg').close(); openViewer(m.file); },
      },
      thumb,
      isVideo ? el('span', { class: 'tile-play' }, svg(ICON.bigplay)) : null,
      badge,
      el('span', { class: 'tile-info' },
        el('span', { class: 'tile-name', text: m.file.name }),
        el('span', { class: 'tile-meta', text: `${fmtBytes(m.file.size)} · ${m.mine ? 'You' : m.senderName}` }))));
    }
    body.replaceChildren(...nodes);
  } else {
    const all = await invoke('search', { query: '', kind: 'files', from: '', chat, since: 0 });
    const files = all.filter((m) => !IMAGE.test(m.file.mime) && !/^video\//i.test(m.file.mime));
    body.className = 'results gallery';
    body.replaceChildren(...(files.length ? files.map((m) => {
      const ext = (m.file.name.includes('.') ? m.file.name.split('.').pop() : 'file').slice(0, 4);
      const btn = el('button', { class: 'small', type: 'button', 'data-file': m.file.id });
      updateFileButton(btn, m.file, m.chat);
      return el('div', { class: 'result' },
        el('div', { class: 'ext', text: ext }),
        el('div', { class: 'grow' },
          el('div', { class: 'result-text', text: m.file.name }),
          el('div', { class: 'result-meta', text: `${fmtBytes(m.file.size)} · ${m.mine ? 'You' : m.senderName} · ${dayFmt.format(m.ts)}` })),
        btn);
    }) : [el('div', { class: 'empty-note', text: 'No files in this chat yet.' })]));
  }
}
document.querySelectorAll('.gtabs .tab').forEach((t) => t.addEventListener('click', () => { galleryTab = t.dataset.tab; renderGallery(); }));
$('galleryBtn').addEventListener('click', openGallery);
$('galleryClose').addEventListener('click', () => $('galleryDlg').close());

boot();
