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
  reads: new Map(), // chat -> { peer id: id of the last message they have seen }
  mutes: new Set(),
  pins: new Map(), // chat -> [message id]
  replyTo: null, // { id, name, text }
  editing: null, // message id
  view: 'home', // new layout: 'home' (friends) or a group id
  lastChan: {}, // group id -> last opened channel chat
  lastDm: null,
  typing: new Map(), // chat -> Map(peer id -> { name, until })
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
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  reply: '<path d="M10 9 5 13l5 4"/><path d="M5 13h9a5 5 0 0 1 5 5v1"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16Z"/>',
  pin: '<path d="M9 4h6l-1 6 4 4H6l4-4Z"/><path d="M12 14v6"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9Z"/><path d="m17 9 4 6M21 9l-4 6"/>',
  hash: '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>',
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
function avatar(name, { online = false, group = false, seed, src, mode } = {}) {
  const a = el('div', { class: 'avatar' + (online ? ' online' : '') + (group ? ' group' : '') + (src ? ' has-img' : '') + (mode && mode !== 'online' ? ` mode-${mode}` : '') });
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
const groupIdOf = (chat) => (isGroup(chat) ? chat.slice(2).split('#')[0] : null);
const groupOf = (chat) => groupById(groupIdOf(chat));
const channelOf = (chat) => {
  const g = groupOf(chat);
  const cid = chat?.split('#')[1];
  return g && cid ? (g.channels || []).find((c) => c.id === cid) || { id: cid, name: 'channel', chat } : null;
};

function chatInfo(chat) {
  if (isGroup(chat)) {
    const g = groupOf(chat);
    if (!g) return null;
    const ch = channelOf(chat);
    if (chat.includes('#') && !(g.channels || []).some((c) => c.chat === chat)) return null; // deleted channel
    return { name: g.name, group: g, channel: ch, channelName: ch ? ch.name : 'general' };
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
  if (S.me.platform === 'android' || S.me.platform === 'ios') document.documentElement.classList.add('phone');
  if (S.me.selftest) return runSelfTest(S.me.selftest);
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
  checkUpdate();
  setInterval(checkUpdate, 6 * 3600 * 1000);
}

// ---------- Updates: one click replaces the installed version ----------
async function checkUpdate() {
  const u = await invoke('check_update').catch(() => null);
  const bar = $('updateBar');
  bar.classList.toggle('hidden', !u);
  if (!u) return;
  const btn = el('button', { type: 'button', text: 'Update' });
  btn.onclick = async () => {
    if (!u.url) return toast('No download for this system in that release yet.');
    const size = u.size ? ` (${fmtBytes(u.size)})` : '';
    if (!(await ask(`Update to UaN ${u.version}${size}? It downloads the new version and switches over by itself, nothing to install. UaN restarts in a few seconds.`, 'Update'))) return;
    btn.disabled = true;
    btn.textContent = 'Downloading…';
    try {
      await invoke('install_update', { url: u.url, name: u.name });
    } catch (err) {
      if (String(err) === 'no-write' && u.installer) {
        btn.textContent = 'Downloading…';
        try { await invoke('install_update', { url: u.installer, name: u.installerName }); return; } catch (e2) { err = e2; }
      }
      btn.disabled = false;
      btn.textContent = 'Update';
      toast(err);
    }
  };
  bar.replaceChildren(el('span', { text: `UaN ${u.version} is available` }), btn);
}

// ---------- Built-in playback self-test (used by the automatic Linux/Windows build checks) ----------
async function runSelfTest(file) {
  const report = (ok, detail) => invoke('selftest_result', { ok, detail });
  if (S.me.selftestVlc) {
    if (!S.me.vlc) return report(false, 'VLC not found');
    const v = new VlcVideo(file);
    const wait = async (cond, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, 300)); } return false; };
    try { await v.start(false); } catch (e) { return report(false, `VLC start failed: ${e}`); }
    const ready = await wait(() => v.ready, 45000);
    v.play();
    const played = ready && await wait(() => v.currentTime > 2 && !v.paused, 45000);
    if (!played) { v.close(); return report(false, `VLC did not play: ready=${ready} t=${v.currentTime} paused=${v.paused}`); }
    v.currentTime = 15;
    await new Promise((r) => setTimeout(r, 4000));
    const afterSeek = v.currentTime;
    v.pause();
    await new Promise((r) => setTimeout(r, 2500));
    const t1 = v.currentTime;
    await new Promise((r) => setTimeout(r, 1500));
    const stillPaused = v.paused && Math.abs(v.currentTime - t1) < 0.5;
    v.close();
    return report(afterSeek >= 14.5 && afterSeek < 25 && stillPaused, `VLC streamed: seek→${afterSeek.toFixed(1)}s, paused=${stillPaused}, duration=${v.duration}`);
  }
  const v = el('video', { src: mediaUrl(file) });
  v.muted = true;
  document.body.append(v);
  const t0 = Date.now();
  v.addEventListener('error', () => report(false, `error code ${v.error?.code}: ${v.error?.message || ''} src=${v.src}`));
  v.play().catch(() => {});
  const played = await new Promise((res) => {
    const iv = setInterval(() => {
      if (v.currentTime > 2) { clearInterval(iv); res(true); }
      if (Date.now() - t0 > 45000) { clearInterval(iv); res(false); }
    }, 250);
  });
  if (!played) return report(false, `timeout: readyState=${v.readyState} networkState=${v.networkState} t=${v.currentTime} err=${v.error?.code} src=${v.src}`);
  v.currentTime = 12;
  await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); setTimeout(r, 15000); });
  await new Promise((r) => setTimeout(r, 2000));
  let thumbInfo = 'no preview';
  try {
    const t = await makeThumb(file);
    thumbInfo = t?.img?.startsWith('data:image/jpeg') ? `preview ${t.w}x${t.h} ${Math.round(t.img.length / 1024)}KB dur=${Math.round(t.dur)}` : 'preview missing';
  } catch (e) {
    thumbInfo = `preview failed: ${e}`;
  }
  report(v.currentTime > 12.5 && thumbInfo.startsWith('preview '), `played and seeked: t=${v.currentTime.toFixed(2)} duration=${v.duration} via ${S.me.mediaBase ? 'http' : 'media scheme'}; ${thumbInfo}; sound bytes reported=${v.webkitAudioDecodedByteCount}`);
}

const MODE_NAMES = { online: 'Online', away: 'Away', dnd: 'Do not disturb (no notifications)' };
function modeMenu(e) {
  e?.stopPropagation?.();
  const r = $('meAvatar').getBoundingClientRect();
  const pick = async (mode) => {
    await invoke('set_mode', { mode }).catch(toast);
    S.me.mode = mode;
    renderMe();
  };
  showMenu(r.left, r.bottom + 4, ['online', 'away', 'dnd'].map((m) => ({ label: (S.me.mode === m ? '\u2022 ' : '') + MODE_NAMES[m], run: () => pick(m) })));
}

function renderMe() {
  $('meName').textContent = S.me.name;
  setAvatar($('meAvatar'), S.me.name, { seed: S.me.id, src: S.me.profile?.avatar, online: true, mode: S.me.mode });
  $('meAvatar').title = MODE_NAMES[S.me.mode] || 'Online';
  $('meAvatar').onclick = modeMenu;
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
    b.textContent = 'Copied';
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
// Connection type per friend (direct or relay), refreshed every few seconds.
S.links = {};
setInterval(async () => {
  try {
    const l = await invoke('links');
    const changed = JSON.stringify(l) !== JSON.stringify(S.links);
    S.links = l;
    if (changed && S.active && !isGroup(S.active)) renderChatHead();
    if (changed && S.transfers.some((t) => t.status === 'running')) renderTransfers();
  } catch {}
}, 4000);
listen('unsent', ({ payload }) => removeMessage(payload.id, payload.chat));
listen('contacts', () => loadContacts());
listen('presence', ({ payload }) => {
  const f = friendById(payload.id);
  if (f) { f.online = payload.online; if (payload.mode) f.mode = payload.mode; }
  for (const g of S.groups) for (const m of g.members) if (m.id === payload.id) { m.online = payload.online; if (payload.mode) m.mode = payload.mode; }
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
  try { S.mutes = new Set(await invoke('mutes')); } catch {}
  if (S.active && !chatInfo(S.active)) {
    const g = groupOf(S.active);
    if (g) openChat(`g:${g.id}`);
    else closeChat();
  }
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
    const n = unreadIn(g.id);
    return el('li', { class: 'friend' + (groupIdOf(S.active) === g.id ? ' active' : ''), onclick: () => openGroup(g.id), oncontextmenu: (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, groupMenu(g)); } },
      avatar(g.name, { group: true, seed: g.id }),
      el('span', { class: 'grow ellipsis', text: g.name }),
      S.mutes.has(`g:${g.id}`) ? svg(ICON.mute) : null,
      n ? el('span', { class: 'badge', text: n > 99 ? '99+' : String(n) }) : null);
  }));
  $('noGroups').classList.toggle('hidden', S.groups.length > 0);

  $('friendList').replaceChildren(...[...S.friends].sort(byRecent).map((f) => el('li', {
    class: 'friend' + (S.active === f.id ? ' active' : ''), onclick: () => openChat(f.id),
    oncontextmenu: (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, friendMenu(f)); },
    title: f.status || '',
  }, avatar(f.name, { online: f.online, seed: f.id, src: f.avatar, mode: f.mode }),
  el('div', { class: 'grow' }, el('div', { class: 'ellipsis', text: f.name }), f.status ? el('div', { class: 'sub ellipsis', text: f.status }) : null),
  S.mutes.has(f.id) ? svg(ICON.mute) : null,
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
  renderRail();
  renderChannels();
}

// ---------- New layout: rail of groups, channels ----------
const unreadIn = (gid) => [...S.unread.entries()].filter(([k]) => groupIdOf(k) === gid).reduce((a, [, n]) => a + n, 0);

function renderRail() {
  const home = S.view === 'home' || !groupById(S.view);
  if (!home && S.view && !groupById(S.view)) S.view = 'home';
  $('railHome').classList.toggle('active', home);
  const dmUnread = [...S.unread.entries()].filter(([k]) => !isGroup(k)).reduce((a, [, n]) => a + n, 0);
  $('railHome').classList.toggle('unread', dmUnread > 0);
  $('railGroups').replaceChildren(...[...S.groups].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0) || a.name.localeCompare(b.name)).map((g) => {
    const n = unreadIn(g.id);
    const b = el('button', { type: 'button', class: 'rail-btn group' + (S.view === g.id ? ' active' : '') + (n ? ' unread' : ''), title: g.name,
      onclick: () => openGroup(g.id),
      oncontextmenu: (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, groupMenu(g)); } },
    (g.name || '?').slice(0, 2), n ? el('span', { class: 'badge', text: n > 99 ? '99+' : String(n) }) : null);
    b.style.setProperty('--h', hue(g.id));
    return b;
  }));
  $('side').classList.toggle('group-view', !home);
  $('side').classList.toggle('home-view', home);
}

function openGroup(gid) {
  const g = groupById(gid);
  if (!g) return;
  S.view = gid;
  const last = S.lastChan[gid];
  openChat(last && chatInfo(last) ? last : `g:${gid}`);
}
$('railHome').addEventListener('click', () => {
  S.view = 'home';
  if (S.lastDm && friendById(S.lastDm)) openChat(S.lastDm);
  else { closeChat(); renderLists(); }
});
$('railAdd').addEventListener('click', () => openPick('group'));

function channelsOf(g) {
  return [{ id: '', name: 'general', chat: `g:${g.id}` }, ...(g.channels || [])];
}
function channelItem(g, ch, tag) {
  const unread = S.unread.get(ch.chat) || 0;
  const icon = ch.locked ? (ch.unlocked ? ICON.lock : ICON.lock) : ICON.hash;
  const menu = (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, channelMenu(g, ch)); };
  if (tag === 'tab') {
    return el('button', { type: 'button', class: S.active === ch.chat ? 'on' : '', onclick: () => openChat(ch.chat), oncontextmenu: menu, title: ch.locked ? 'Locked with a password' : '' },
      svg(icon), ch.name, unread ? el('span', { class: 'badge', text: String(unread) }) : null);
  }
  return el('li', { class: 'friend' + (S.active === ch.chat ? ' active' : '') + (unread ? ' unread' : ''), onclick: () => openChat(ch.chat), oncontextmenu: menu, title: ch.locked ? 'Locked with a password' : '' },
    svg(icon), el('span', { class: 'grow ellipsis', text: ch.name }), unread ? el('span', { class: 'badge', text: String(unread) }) : null);
}
function renderChannels() {
  // New layout: the side column shows the open group's channels and members.
  const g = groupById(S.view);
  if (g) {
    $('sideGroupText').textContent = g.name;
    $('chanList').replaceChildren(...channelsOf(g).map((ch) => channelItem(g, ch)));
    $('memberList').replaceChildren(...g.members.map((m) => el('li', {},
      avatar(m.name, { online: m.online, seed: m.id, src: m.id === S.me.id ? S.me.profile?.avatar : m.avatar }),
      el('span', { class: 'grow ellipsis', text: m.id === S.me.id ? `${m.name} (you)` : m.name }))));
  }
  // Legacy layout: tabs above the messages.
  const ag = groupOf(S.active);
  const tabs = !document.body.classList.contains('modern') && ag;
  $('chanTabs').classList.toggle('hidden', !tabs);
  if (tabs) {
    $('chanTabs').replaceChildren(...channelsOf(ag).map((ch) => channelItem(ag, ch, 'tab')),
      el('button', { type: 'button', title: 'Create a channel', onclick: () => openChanDlg(ag) }, svg('<path d="M12 5v14M5 12h14"/>')));
  }
}
$('sideGroupName').addEventListener('click', () => {
  const g = groupById(S.view);
  if (!g) return;
  const r = $('sideGroupName').getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, groupMenu(g));
});
$('addChanBtn').addEventListener('click', () => { const g = groupById(S.view); if (g) openChanDlg(g); });

function channelMenu(g, ch) {
  const owner = g.owner === S.me.id;
  return [
    { label: 'Open', run: () => openChat(ch.chat) },
    ch.id ? muteItem(ch.chat) : null,
    ch.locked && ch.unlocked ? { label: 'Lock again on this PC', run: async () => { await invoke('forget_channel', { chat: ch.chat }); await loadContacts(); if (S.active === ch.chat) openChat(ch.chat); } } : null,
    { label: 'Clear messages for me', run: () => clearChat(ch.chat, false) },
    owner ? { label: 'Clear messages for everyone', danger: true, run: () => clearChat(ch.chat, true) } : null,
    owner && ch.id ? '-' : null,
    owner && ch.id ? { label: 'Rename channel…', run: async () => {
      const name = prompt('New name for the channel', ch.name);
      if (name && name.trim()) invoke('channel_action', { group: g.id, channel: ch.id, action: 'rename', name }).then(loadContacts).catch(toast);
    } } : null,
    owner && ch.id ? { label: 'Delete channel', danger: true, run: async () => {
      if (await ask(`Delete # ${ch.name} for everyone?`, 'Delete')) {
        await invoke('channel_action', { group: g.id, channel: ch.id, action: 'delete', name: '' }).catch(toast);
        await loadContacts();
        if (S.active === ch.chat) openChat(`g:${g.id}`);
      }
    } } : null,
  ];
}

let chanDlgGroup = null;
function openChanDlg(g) {
  chanDlgGroup = g;
  $('chanName').value = '';
  $('chanPw').value = '';
  $('chanLock').checked = false;
  $('chanPw').classList.add('hidden');
  $('chanErr').textContent = '';
  $('chanNote').textContent = g.owner === S.me.id ? 'Everyone in the group can see and use it.' : 'It appears for everyone as soon as the group creator’s PC is online.';
  $('chanDlg').showModal();
  setTimeout(() => $('chanName').focus(), 30);
}
$('chanLock').addEventListener('change', () => {
  $('chanPw').classList.toggle('hidden', !$('chanLock').checked);
  if ($('chanLock').checked) {
    $('chanNote').textContent = 'Only people who know the password can read or write in it: messages are encrypted with it. Tell it to the others yourself.';
    $('chanPw').focus();
  }
});
$('chanCancel').addEventListener('click', () => $('chanDlg').close());
$('chanForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('chanLock').checked ? $('chanPw').value : null;
  if ($('chanLock').checked && pw.trim().length < 3) return void ($('chanErr').textContent = 'Use a password of at least 3 characters.');
  try {
    const chat = await invoke('create_channel', { group: chanDlgGroup.id, name: $('chanName').value, password: pw });
    $('chanDlg').close();
    await loadContacts();
    if (chatInfo(chat)) openChat(chat);
  } catch (err) { $('chanErr').textContent = err; }
});
$('lockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const chat = S.active;
  try {
    await invoke('unlock_channel', { chat, password: $('lockPw').value });
    await loadContacts();
    openChat(chat);
  } catch (err) { $('lockErr').textContent = err; }
});

// ---------- Layout: new or legacy ----------
// The classic layout (the rail layout of 1.6.0 was dropped; its code stays switched off).
function currentLayout() {
  return 'legacy';
}
function applyLayout() {
  document.body.classList.toggle('modern', currentLayout() === 'modern');
  document.querySelectorAll('#sLayout button').forEach((b) => b.classList.toggle('on', b.dataset.layout === currentLayout()));
  if (S.me) renderLists();
}
document.querySelectorAll('#sLayout button').forEach((b) => b.addEventListener('click', () => {
  try { localStorage.setItem('uan.layout', b.dataset.layout); } catch {}
  applyLayout();
}));
applyLayout();



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
  if (S.active !== chat) cancelReply();
  S.active = chat;
  S.unread.delete(chat);
  if (isGroup(chat)) {
    S.view = groupIdOf(chat);
    S.lastChan[S.view] = chat;
  } else {
    S.view = 'home';
    S.lastDm = chat;
  }
  $('empty').classList.add('hidden');
  $('chat').classList.remove('hidden');
  if (innerWidth <= 700 && !$('main').classList.contains('in-chat')) { try { history.pushState({ chat }, ''); } catch {} }
  $('main').classList.add('in-chat');
  const ch = channelOf(chat);
  const gated = !!(ch && ch.locked && !ch.unlocked);
  $('lockGate').classList.toggle('hidden', !gated);
  $('msgs').classList.toggle('hidden', gated);
  $('composer').classList.toggle('hidden', gated);
  if (gated) {
    $('lockTitle').textContent = `# ${ch.name} is locked`;
    $('lockErr').textContent = '';
    $('lockPw').value = '';
    renderChatHead();
    renderLists();
    $('typingBar').classList.add('hidden');
    setTimeout(() => $('lockPw').focus(), 50);
    return;
  }
  renderChatHead();
  renderLists();
  renderInviteBar();
  let list = await invoke('messages', { chat, limit: 300 });
  if (focusId && !list.some((m) => m.id === focusId)) list = await invoke('messages', { chat, limit: 20000 });
  S.msgs.set(chat, list);
  try { S.reads.set(chat, await invoke('reads', { chat })); } catch {}
  try { if (S.active === chat) renderPins(await invoke('pins', { chat })); } catch {}
  if (S.active !== chat) return;
  renderMessages();
  renderTyping();
  markRead();
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
  $('main').classList.remove('in-chat');
  $('chat').classList.add('hidden');
  $('empty').classList.remove('hidden');
}

function renderChatHead() {
  const info = S.active && chatInfo(S.active);
  if (!info) return;
  $('chatName').textContent = info.group ? `# ${info.channelName}` : info.name;
  if (info.group) {
    const online = info.group.members.filter((m) => m.online && m.id !== S.me.id).length;
    $('chatStatus').textContent = `${info.name} · ${info.group.members.length} members${online ? ` · ${online} online` : ''}`;
    setAvatar($('chatAvatar'), info.name, { group: true, seed: info.group.id });
  } else {
    const mood = info.friend.status ? ` · ${info.friend.status}` : '';
    const link = S.links?.[info.friend.id];
    const how = !info.friend.online || !link ? ''
      : link.direct ? ` · direct connection (${link.rtt} ms)`
      : ' · through a relay server (slower)';
    $('chatStatus').textContent = (info.friend.online ? 'Online' : 'Offline · messages wait for them') + how + mood;
    $('chatStatus').title = link && !link.direct
      ? 'Your PCs could not connect directly yet, so data goes through a public relay server, which is slow. UaN keeps trying to connect directly; this usually works within a minute. If it never does, a router or firewall blocks it.'
      : '';
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

// **bold**, *italic*, ~~strike~~, `code`, and @mentions; everything else stays plain text.
function formatText(text) {
  const frag = document.createDocumentFragment();
  const re = /(\*\*[^*\n]+?\*\*|\*[^*\s][^*\n]*?\*|~~[^~\n]+?~~|`[^`\n]+?`|@[\p{L}\p{N}_.-]+)/gu;
  let last = 0;
  for (const mt of text.matchAll(re)) {
    if (mt.index > last) frag.append(text.slice(last, mt.index));
    const t = mt[0];
    if (t.startsWith('**')) frag.append(el('b', { text: t.slice(2, -2) }));
    else if (t.startsWith('~~')) frag.append(el('s', { text: t.slice(2, -2) }));
    else if (t.startsWith('`')) frag.append(el('code', { text: t.slice(1, -1) }));
    else if (t.startsWith('*')) frag.append(el('i', { text: t.slice(1, -1) }));
    else frag.append(el('span', { class: 'mention', text: t }));
    last = mt.index + t.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}
function mentionsMe(text) {
  if (!text || !S.me?.name) return false;
  const me = '@' + S.me.name.toLowerCase();
  const t = text.toLowerCase();
  let i = t.indexOf(me);
  while (i >= 0) {
    const next = t[i + me.length];
    if (!next || !/[\p{L}\p{N}]/u.test(next)) return true;
    i = t.indexOf(me, i + 1);
  }
  return false;
}

function messageNode(m, showSender = true) {
  const quote = m.reply ? el('button', { type: 'button', class: 'quote', title: 'Show the message', onclick: () => jumpTo(m.reply.id) },
    el('b', { text: m.reply.name }), m.reply.text || '') : null;
  const bubble = m.locked ? el('div', { class: 'bubble locked-msg', text: 'Locked message. Unlock the channel to read it.' })
    : m.text ? el('div', { class: 'bubble' }, formatText(m.text)) : null;
  const acts = m.locked ? [] : [
    el('button', { type: 'button', class: 'msg-act', title: 'Reply', onclick: () => startReply(m) }, svg(ICON.reply)),
    m.mine && m.text ? el('button', { type: 'button', class: 'msg-act', title: 'Edit', onclick: () => startEdit(m) }, svg(ICON.edit)) : null,
    el('button', { type: 'button', class: 'msg-act', title: m.pinned ? 'Unpin' : 'Pin to the top of the chat', onclick: () => togglePin(m) }, svg(ICON.pin)),
  ];
  const node = el('div', { class: 'msg ' + (m.mine ? 'mine' : 'theirs') + (!m.mine && isGroup(m.chat) && mentionsMe(m.text) ? ' mentions-me' : ''), 'data-id': m.id },
    isGroup(m.chat) && !m.mine && showSender ? el('div', { class: 'sender', text: m.senderName }) : null,
    quote,
    m.file ? fileCard(m.file, m.chat, m.thumb) : null,
    bubble,
    el('div', { class: 'meta' },
      el('span', { class: 'time', text: timeFmt.format(m.ts) }),
      m.edited ? el('span', { class: 'edited', text: 'edited' }) : null,
      m.pinned ? el('span', { class: 'pin-mark', title: 'Pinned' }, svg(ICON.pin)) : null,
      acts,
      el('button', { type: 'button', class: 'msg-del', title: 'Delete message', onclick: () => deleteMessage(m) }, svg(ICON.x))),
    seenRow(m));
  return node;
}

function jumpTo(id) {
  const node = document.querySelector(`#msgs .msg[data-id="${id}"]`);
  if (!node) return toast('That message is no longer here.');
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 2000);
}

function startReply(m) {
  S.editing = null;
  S.replyTo = { id: m.id, name: m.senderName, text: m.text || (m.file ? `File: ${m.file.name}` : '') };
  $('replyTitle').textContent = `Replying to ${m.mine ? 'yourself' : m.senderName}`;
  $('replyText').textContent = S.replyTo.text;
  $('replyBar').classList.remove('hidden');
  $('msgInput').focus();
}
function startEdit(m) {
  S.replyTo = null;
  S.editing = m.id;
  $('replyTitle').textContent = 'Editing your message';
  $('replyText').textContent = 'Enter saves, Esc cancels';
  $('replyBar').classList.remove('hidden');
  $('msgInput').value = m.text;
  $('msgInput').focus();
}
function cancelReply() {
  if (S.editing) $('msgInput').value = '';
  S.replyTo = null;
  S.editing = null;
  $('replyBar').classList.add('hidden');
}
$('replyCancel').addEventListener('click', cancelReply);
$('backBtn').addEventListener('click', () => { closeChat(); renderLists(); });
// Android's back button / gesture: back to the list instead of leaving the app.
window.addEventListener('popstate', () => { if (S.active && innerWidth <= 700) { closeChat(); renderLists(); } });
$('msgInput').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (S.replyTo || S.editing)) { e.preventDefault(); cancelReply(); }
});

async function togglePin(m) {
  try {
    await invoke('pin_message', { chat: m.chat, id: m.id, pinned: !m.pinned });
  } catch (e) { toast(e); }
}
function updateMessage(chat, id, fn) {
  const m = (S.msgs.get(chat) || []).find((x) => x.id === id);
  if (!m) return;
  fn(m);
  if (chat === S.active) {
    const old = document.querySelector(`#msgs .msg[data-id="${id}"]`);
    if (old) old.replaceWith(messageNode(m, !!old.querySelector('.sender')));
  }
}
listen('edited', ({ payload }) => {
  updateMessage(payload.chat, payload.id, (m) => {
    m.text = payload.text;
    m.edited = true;
    if (payload.locked) m.locked = true;
  });
});
listen('pins', async ({ payload }) => {
  updateMessage(payload.chat, payload.id, (m) => { m.pinned = payload.pinned; });
  if (payload.chat === S.active) renderPins(await invoke('pins', { chat: S.active }).catch(() => []));
});
function renderPins(list) {
  S.pins.set(S.active, list);
  $('pinsBtn').classList.toggle('hidden', !list.length);
  $('pinsCount').textContent = list.length ? String(list.length) : '';
}
$('pinsBtn').addEventListener('click', async () => {
  const ids = S.pins.get(S.active) || [];
  const all = await invoke('messages', { chat: S.active, limit: 20000 });
  const byId = new Map(all.map((m) => [m.id, m]));
  $('pinsList').replaceChildren(...ids.map((id) => byId.get(id)).filter(Boolean).map((m) => el('button', { type: 'button', class: 'pin-item', onclick: () => { $('pinsDlg').close(); jumpTo(m.id); } },
    el('span', { class: 'sub', text: `${m.senderName} · ${dayFmt.format(m.ts)} ${timeFmt.format(m.ts)}` }),
    m.text ? el('span', {}, formatText(m.text)) : el('span', { text: m.file ? `File: ${m.file.name}` : '' }))));
  if (!$('pinsList').children.length) $('pinsList').append(el('div', { class: 'note', text: 'Pinned messages that are no longer in this chat are not shown.' }));
  $('pinsDlg').showModal();
});

// ---------- @mentions: suggestions while typing in a group ----------
let mentionSel = 0;
function mentionCandidates() {
  const input = $('msgInput');
  const g = groupOf(S.active);
  if (!g) return null;
  const upto = input.value.slice(0, input.selectionStart);
  const mt = upto.match(/(^|\s)@([\p{L}\p{N}_.-]*)$/u);
  if (!mt) return null;
  const q = mt[2].toLowerCase();
  const list = g.members.filter((x) => x.id !== S.me.id && x.name.toLowerCase().startsWith(q)).slice(0, 8);
  return list.length ? { list, start: upto.length - mt[2].length - 1 } : null;
}
function renderMentions() {
  const c = mentionCandidates();
  $('mentionPop').classList.toggle('hidden', !c);
  if (!c) return;
  mentionSel = Math.min(mentionSel, c.list.length - 1);
  $('mentionPop').replaceChildren(...c.list.map((x, i) => el('button', { type: 'button', class: i === mentionSel ? 'on' : '', onmousedown: (e) => { e.preventDefault(); insertMention(x.name); } },
    avatar(x.name, { seed: x.id, src: x.avatar }), el('span', { text: x.name }))));
}
function insertMention(name) {
  const c = mentionCandidates();
  if (!c) return;
  const input = $('msgInput');
  const after = input.value.slice(input.selectionStart);
  input.value = input.value.slice(0, c.start) + '@' + name + ' ' + after;
  const pos = c.start + name.length + 2;
  input.setSelectionRange(pos, pos);
  $('mentionPop').classList.add('hidden');
}
$('msgInput').addEventListener('input', () => { mentionSel = 0; renderMentions(); });
$('msgInput').addEventListener('keydown', (e) => {
  if ($('mentionPop').classList.contains('hidden')) return;
  const c = mentionCandidates();
  if (!c) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    mentionSel = (mentionSel + (e.key === 'ArrowDown' ? 1 : c.list.length - 1)) % c.list.length;
    renderMentions();
  } else if (e.key === 'Tab' || e.key === 'Enter') {
    e.preventDefault();
    insertMention(c.list[mentionSel].name);
  } else if (e.key === 'Escape') {
    $('mentionPop').classList.add('hidden');
  }
});
$('msgInput').addEventListener('blur', () => setTimeout(() => $('mentionPop').classList.add('hidden'), 150));

// Like in Messenger: small pictures under the last message each person has seen.
function seenRow(m) {
  const reads = S.reads.get(m.chat) || {};
  const who = Object.keys(reads).filter((id) => reads[id] === m.id && id !== S.me.id);
  if (!who.length) return null;
  const group = isGroup(m.chat) ? groupOf(m.chat) : null;
  const person = (id) => (group ? group.members.find((x) => x.id === id) : friendById(id)) || friendById(id);
  const known = who.map(person).filter(Boolean);
  if (!known.length) return null;
  const row = el('div', { class: 'seen-row', title: `Seen by ${known.map((p) => p.name).join(', ')}` },
    known.slice(0, 8).map((p) => avatar(p.name, { seed: p.id, src: p.avatar })));
  if (known.length > 8) row.append(el('span', { class: 'more', text: `+${known.length - 8}` }));
  return row;
}

function renderSeen() {
  const box = $('msgs');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.querySelectorAll('.seen-row').forEach((n) => n.remove());
  for (const m of S.msgs.get(S.active) || []) {
    const row = seenRow(m);
    if (row) box.querySelector(`.msg[data-id="${m.id}"]`)?.append(row);
  }
  if (near) box.scrollTop = box.scrollHeight;
}

// Tell the others we have seen the chat (only while the window is really in front of you).
const readSent = new Map();
function markRead() {
  const chat = S.active;
  if (!chat || !S.me?.receipts || !document.hasFocus() || document.hidden || $('chat').classList.contains('hidden')) return;
  const list = S.msgs.get(chat) || [];
  const last = list[list.length - 1];
  if (!last || readSent.get(chat) === last.id) return;
  readSent.set(chat, last.id);
  invoke('read_upto', { chat, id: last.id }).catch(() => {});
}
window.addEventListener('focus', markRead);
document.addEventListener('visibilitychange', markRead);

listen('seen', ({ payload }) => {
  const r = S.reads.get(payload.chat) || {};
  r[payload.who] = payload.msgId;
  S.reads.set(payload.chat, r);
  if (payload.chat === S.active) renderSeen();
});

// Earlier messages arrived (you were added to a group): show them.
listen('history', async ({ payload }) => {
  if (payload.chat !== S.active) return;
  const list = await invoke('messages', { chat: payload.chat, limit: 300 });
  S.msgs.set(payload.chat, list);
  if (S.active === payload.chat) renderMessages();
});

// ---------- "… is typing" ----------
function renderTyping() {
  const now = Date.now();
  const m = S.typing.get(S.active);
  const names = m ? [...m.values()].filter((t) => t.until > now).map((t) => t.name || 'Someone') : [];
  $('typingBar').classList.toggle('hidden', !names.length);
  if (names.length) {
    $('typingText').textContent = names.length === 1 ? `${names[0]} is typing`
      : names.length === 2 ? `${names[0]} and ${names[1]} are typing`
      : 'Several people are typing';
  }
}
listen('typing', ({ payload }) => {
  if (!S.typing.has(payload.chat)) S.typing.set(payload.chat, new Map());
  S.typing.get(payload.chat).set(payload.who, { name: payload.name, until: Date.now() + 5000 });
  if (payload.chat === S.active) renderTyping();
  setTimeout(() => { if (payload.chat === S.active) renderTyping(); }, 5100);
});
let typingSent = 0;
$('msgInput').addEventListener('input', () => {
  if (!S.active || !S.me?.typing || !$('msgInput').value.trim()) return;
  if (Date.now() - typingSent < 2500) return;
  typingSent = Date.now();
  invoke('typing', { chat: S.active }).catch(() => {});
});

// Delete a message: just for you, or (your own) for everyone in the chat.
function deleteMessage(m) {
  const d = $('delDlg');
  $('delAll').classList.toggle('hidden', !m.mine);
  $('delText').textContent = m.mine
    ? (m.file ? 'Delete for everyone also stops sharing this file: nobody in this chat can watch or download it from your PC any more.' : 'Delete for everyone removes it for everyone in this chat, also for those who are offline now.')
    : 'This removes it only on this computer.';
  d.returnValue = '';
  d.addEventListener('close', async () => {
    if (d.returnValue !== 'me' && d.returnValue !== 'all') return;
    try {
      await invoke('delete_message', { id: m.id, everyone: d.returnValue === 'all' });
    } catch (e) {
      toast(e);
    }
  }, { once: true });
  d.showModal();
}

function removeMessage(id, chat) {
  const list = S.msgs.get(chat);
  if (list) {
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list.splice(i, 1);
  }
  if (chat === S.active) {
    const box = $('msgs');
    const top = box.scrollTop;
    renderMessages();
    box.scrollTop = Math.min(top, box.scrollHeight);
  }
}

function fileCard(file, chat, thumb) {
  let preview = null;
  if (thumb?.img && (IMAGE.test(file.mime) || /^video\//i.test(file.mime))) {
    // The sender's preview: shows instantly, even when the sender's PC is off.
    const video = /^video\//i.test(file.mime);
    preview = el('button', { class: 'thumb', type: 'button', title: video ? 'Play here without downloading' : 'Open', onclick: () => openViewer(file) },
      el('img', { src: thumb.img, alt: '', onload: keepBottom }),
      video ? el('span', { class: 'play-badge' }, svg(ICON.bigplay)) : null,
      video && thumb.dur ? el('span', { class: 'dur', text: fmtTime(thumb.dur) }) : null);
  } else if (IMAGE.test(file.mime) && file.size <= INLINE_IMAGE_LIMIT) {
    preview = el('img', { src: mediaUrl(file), alt: '', loading: 'lazy', onclick: () => openViewer(file), onload: keepBottom, onerror: (e) => e.target.remove() });
  } else if (PLAYABLE.test(file.mime)) {
    preview = el('button', { class: 'play', type: 'button', title: 'Play here without downloading', onclick: () => openViewer(file) },
      svg(ICON.bigplay), el('span', { text: file.mime.startsWith('audio') ? 'Listen' : 'Watch now' }));
  }
  const ext = (file.name.includes('.') ? file.name.split('.').pop() : 'file').slice(0, 4);
  const btn = el('button', { class: 'small', type: 'button', 'data-file': file.id });
  updateFileButton(btn, file, chat);
  const together = isGroup(chat) && /^video\//i.test(file.mime)
    ? el('button', { class: 'watch', type: 'button', title: 'Watch this with others in the group, in sync', onclick: () => openPartySetup(file, groupIdOf(chat)) }, svg(ICON.bigplay), 'Watch together')
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

const thumbPending = new Set();

// Draws a small JPEG preview of a photo or a frame of a video (plus its length).
async function makeThumb(file) {
  const MAX = 360;
  const draw = (src, w, h) => {
    const scale = Math.min(1, MAX / Math.max(w, h));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * scale));
    cv.height = Math.max(1, Math.round(h * scale));
    cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.72);
  };
  const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms));
  if (IMAGE.test(file.mime)) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = mediaUrl(file);
    await Promise.race([img.decode(), timeout(20000, 'image timeout')]);
    return { img: draw(img, img.naturalWidth, img.naturalHeight), w: img.naturalWidth, h: img.naturalHeight };
  }
  if (/^video\//i.test(file.mime)) {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true;
    v.preload = 'auto';
    v.src = mediaUrl(file);
    try {
      await Promise.race([new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('video error')); }), timeout(25000, 'metadata timeout')]);
      const dur = v.duration;
      v.currentTime = Math.min(isFinite(dur) ? dur * 0.1 : 5, 60);
      await Promise.race([new Promise((res) => { v.onseeked = res; }), timeout(25000, 'seek timeout')]);
      await new Promise((r) => setTimeout(r, 150));
      return { img: draw(v, v.videoWidth, v.videoHeight), dur: isFinite(dur) ? dur : null, w: v.videoWidth, h: v.videoHeight };
    } finally {
      v.removeAttribute('src');
      v.load();
    }
  }
  return null;
}

async function ensureThumb(m) {
  if (!m.mine || !m.file || m.thumb || thumbPending.has(m.file.id)) return;
  if (!IMAGE.test(m.file.mime) && !/^video\//i.test(m.file.mime)) return;
  thumbPending.add(m.file.id);
  try {
    const t = await makeThumb(m.file);
    if (t?.img && t.img.length < 280000) await invoke('set_thumb', { fileId: m.file.id, data: JSON.stringify(t) });
  } catch {
    // No preview for this one (e.g. a format the built-in player can't decode); the card still works.
  }
}

listen('thumb', ({ payload }) => {
  let visible = false;
  for (const list of S.msgs.values()) {
    for (const m of list) {
      if (m.file?.id === payload.fileId) {
        m.thumb = payload.thumb;
        if (m.chat === S.active) visible = true;
      }
    }
  }
  if (visible) {
    const box = $('msgs');
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const top = box.scrollTop;
    renderMessages();
    if (!near) box.scrollTop = top;
  }
});

function onMessage(m) {
  ensureThumb(m);
  const party = openPartyId && S.parties.get(openPartyId);
  if (party && m.chat === partyChatOf(party)) {
    $('partyMsgs').append(partyLine(m));
    $('partyMsgs').scrollTop = $('partyMsgs').scrollHeight;
  }
  if (S.typing.get(m.chat)?.delete(m.sender) && m.chat === S.active) renderTyping();
  const list = S.msgs.get(m.chat);
  const isNew = list && !list.some((x) => x.id === m.id);
  if (isNew) list.push(m);
  if (isGroup(m.chat)) {
    const g = groupOf(m.chat);
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
      markRead();
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
  const editing = S.editing, reply = S.replyTo;
  cancelReply();
  try {
    typingSent = 0;
    if (editing) await invoke('edit_message', { id: editing, text });
    else await invoke('send_text', { chats: [S.active], text, reply: reply?.id || null });
  } catch (err) {
    input.value = text;
    toast(err);
  }
});

async function sendPhoneFiles(files) {
  const chat = S.active;
  const paths = [];
  for (const f of files) {
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const CH = 2 * 1024 * 1024;
    let path = '';
    for (let off = 0; off < f.size || off === 0; off += CH) {
      const buf = new Uint8Array(await f.slice(off, off + CH).arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      path = await invoke('upload_part', { id, name: f.name || 'file', offset: off, data: btoa(bin) });
      if (f.size > CH * 4) toast(`Preparing ${f.name}: ${Math.min(100, Math.round(((off + CH) / f.size) * 100))}%`);
      if (f.size === 0) break;
    }
    paths.push(path);
  }
  if (paths.length) await invoke('send_paths', { paths, chats: [chat], text: '' });
}
$('phoneFiles').addEventListener('change', () => {
  const files = [...$('phoneFiles').files];
  $('phoneFiles').value = '';
  if (files.length) sendPhoneFiles(files).catch(toast);
});

$('attachBtn').addEventListener('click', () => {
  if (!S.active) return;
  if (document.documentElement.classList.contains('phone')) return $('phoneFiles').click();
  const r = $('attachBtn').getBoundingClientRect();
  showMenu(r.left, r.top - 70, [
    { label: 'Send files…', run: () => invoke('pick_and_send', { chats: [S.active], text: '' }).catch(toast) },
    { label: 'Send a folder…', run: () => invoke('pick_folder_and_send', { chats: [S.active] }).then((n) => n && toast(`${n} files sent.`)).catch(toast) },
  ]);
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

// ---------- VLC: for formats the built-in player can't play (streams, nothing is downloaded) ----------
function httpUrl(file) {
  return `${S.me.httpBase}/${file.owner}/${file.id}/${file.size}/${encodeURIComponent(file.mime)}?stream=1`;
}

// Makes sure VLC is on this computer: offers to install it (free) with one click.
async function ensureVlc(why = 'This needs VLC (free), which isn’t on this computer yet.') {
  if (S.me.vlc) return true;
  if (!(await ask(`${why} Install VLC now? It takes a minute or two.`, 'Install VLC'))) return false;
  toast(S.me.platform === 'windows' ? 'Installing VLC… Windows may ask for permission.' : 'Installing VLC… your password may be asked.');
  try {
    S.me.vlc = await invoke('install_vlc');
  } catch {
    S.me.vlc = false;
  }
  if (S.me.vlc) {
    toast('VLC is installed.');
  } else if (await ask('VLC couldn’t be installed automatically. Open the VLC website to get it?', 'Open website')) {
    invoke('open_vlc_site');
  }
  return S.me.vlc;
}

// Is the film reachable? 'ok', or the reason it isn't (then a player error is not a format problem).
async function reachability(file) {
  try {
    const r = await fetch(mediaUrl(file), { headers: { Range: 'bytes=0-0' } });
    return r.ok ? 'ok' : (r.headers.get('X-UaN-Error') || `error ${r.status}`);
  } catch (x) {
    return String(x);
  }
}

const isFormatError = (err) => err?.code === 3 || err?.code === 4;

// Only where the player reliably reports decoded sound (Windows). On Linux the count can stay 0 even
// while sound plays, so there we never guess: VLC is only used when the player itself fails.
function watchSound(video, file, onSilent) {
  if (!/^video\//i.test(file.mime) || S.me.platform !== 'windows') return;
  let done = false;
  let timer;
  video.addEventListener('playing', () => {
    if (done) return;
    const start = video.currentTime;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (done || video.paused || video.muted || video.volume === 0 || video.currentTime - start < 2) return;
      const decoded = video.webkitAudioDecodedByteCount;
      if (typeof decoded !== 'number') return;
      done = true;
      if (decoded > 0) return;
      let has = false;
      try { has = await invoke('audio_track', { file }); } catch { return; }
      if (has && video.isConnected) onSilent();
    }, 4000);
  });
}

async function openInVlc(file, why) {
  if (!(await ensureVlc(why))) return false;
  try {
    await invoke('vlc_open', { url: httpUrl(file), title: file.name, paused: false });
    toast('Opening in VLC… (it streams from UaN, nothing is downloaded)');
    return true;
  } catch (e) {
    toast(e);
    return false;
  }
}

// Looks like a <video> element to the watch-together code, but drives VLC through its remote control.
class VlcVideo extends EventTarget {
  constructor(file) {
    super();
    this.file = file;
    this.id = null;
    this.paused = true;
    this.seeking = false;
    this.ended = false;
    this.ready = false;
    this.readyState = 0;
    this.duration = NaN;
    this._t = 0;
    this._at = performance.now();
    this._cmdAt = 0;
    this.wantSeek = null;
    this.wantState = null;
  }
  async start(paused) {
    this.id = await invoke('vlc_open', { url: httpUrl(this.file), title: this.file.name, paused });
    this.timer = setInterval(() => this.poll(), 500);
  }
  get currentTime() {
    return this.paused ? this._t : this._t + (performance.now() - this._at) / 1000;
  }
  set currentTime(t) {
    this._t = t;
    this._at = performance.now();
    this.cmd('seek', t);
    setTimeout(() => this.dispatchEvent(new Event('seeked')), 200);
  }
  play() {
    this._t = this.currentTime;
    this._at = performance.now();
    this.paused = false;
    this.cmd('play', 0);
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }
  pause() {
    this._t = this.currentTime;
    this._at = performance.now();
    this.paused = true;
    this.cmd('pause', 0);
    this.dispatchEvent(new Event('pause'));
  }
  cmd(cmd, value) {
    this._cmdAt = performance.now();
    if (!this.ready) {
      if (cmd === 'seek') this.wantSeek = value;
      else this.wantState = cmd;
      return;
    }
    invoke('vlc_command', { id: this.id, cmd, value }).catch(() => {});
  }
  async poll() {
    if (!this.id) return;
    const st = await invoke('vlc_status', { id: this.id }).catch(() => null);
    if (!st) return;
    if (!st.running) {
      this.stop();
      this.dispatchEvent(new Event('vlcclosed'));
      return;
    }
    if (!st.ready) return;
    const now = performance.now();
    if (st.length) this.duration = st.length;
    if (!this.ready) {
      // VLC's remote control is up: apply what was asked for while it was starting.
      this.ready = true;
      this.readyState = 4;
      this._cmdAt = now;
      if (this.wantSeek != null) await invoke('vlc_command', { id: this.id, cmd: 'seek', value: this.wantSeek }).catch(() => {});
      if (this.wantState) await invoke('vlc_command', { id: this.id, cmd: this.wantState, value: 0 }).catch(() => {});
      this.wantSeek = this.wantState = null;
      this.dispatchEvent(new Event('canplaythrough'));
      return;
    }
    const playing = st.state === 'playing';
    // Changes made in VLC by the user become play/pause/seek events; our own commands get a moment to land.
    if (now - this._cmdAt > 1500) {
      if (playing && this.paused) {
        this.paused = false;
        this._t = st.time;
        this._at = now;
        this.dispatchEvent(new Event('play'));
      } else if (!playing && !this.paused && st.state === 'paused') {
        this.paused = true;
        this._t = st.time;
        this._at = now;
        this.dispatchEvent(new Event('pause'));
      } else if (Math.abs(st.time - this.currentTime) > 2.5) {
        this._t = st.time;
        this._at = now;
        this.dispatchEvent(new Event('seeked'));
      } else {
        this._t = st.time;
        this._at = now;
      }
    }
    this.ended = st.state === 'stopped';
    this.dispatchEvent(new Event('timeupdate'));
    if (this.duration > 0) {
      invoke('stream_focus', { fileId: this.file.id, position: Math.floor(this.file.size * Math.min(1, this.currentTime / this.duration)) }).catch(() => {});
    }
  }
  stop() {
    clearInterval(this.timer);
  }
  close() {
    this.stop();
    if (this.id) invoke('vlc_close', { id: this.id });
  }
}

// The watch-together stage while the film plays in VLC.
function makeVlcPlayer(container, { file, onBack }) {
  const video = new VlcVideo(file);
  const status = el('div', { class: 'sub', text: 'Starting VLC…' });
  const toggle = el('button', { type: 'button', class: 'small', text: 'Play / Pause', onclick: () => (video.paused ? video.play() : video.pause()) });
  const back = el('button', { type: 'button', class: 'small', text: 'Watch here instead', onclick: () => onBack?.() });
  const root = el('div', { class: 'vlc-panel' },
    el('div', { class: 'vlc-cone' }, svg(ICON.bigplay)),
    el('div', { class: 'strong', text: `Playing in VLC: ${file.name}` }),
    el('div', { class: 'sub', text: 'Play, pause and seek in VLC or here. Everyone stays in sync.' }),
    status,
    el('div', { class: 'row' }, toggle, back));
  container.replaceChildren(root);
  video.addEventListener('timeupdate', () => {
    status.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)} · ${video.paused ? 'paused' : 'playing'}`;
  });
  video.start(true).catch((e) => { status.textContent = String(e); });
  const player = {
    video,
    root,
    fullscreen() {},
    destroy() {
      video.close();
      container.replaceChildren();
    },
  };
  return player;
}

// ---------- Viewer: watch films without downloading ----------
let viewerPlayer = null;
let viewerToken = 0;
function openViewer(file) {
  const token = ++viewerToken;
  let autoVlc = false;
  const body = $('viewerBody');
  viewerPlayer?.destroy();
  viewerPlayer = null;
  const note = $('viewerNote');
  note.classList.add('hidden');
  const showError = async (e) => {
    const err = e?.target?.error;
    // A failed load looks like "unsupported format" to the player, so first check whether the film is reachable.
    const reach = await reachability(file);
    if (token !== viewerToken) return; // the viewer was closed or shows something else now
    const code = err?.code ? ` (code ${err.code}${err.message ? `: ${err.message}` : ''})` : '';
    if (err && !isFormatError(err)) {
      if (err.code === 1) return; // stopped on purpose
      note.textContent = `The connection dropped while loading this film${code}.`;
      note.append(el('div', { class: 'note-actions' },
        el('button', { type: 'button', class: 'small', text: 'Try again', onclick: () => openViewer(file) })));
      note.classList.remove('hidden');
      return;
    }
    if (reach !== 'ok') {
      note.textContent = file.owner === S.me.id
        ? `UaN can’t read this file from your disk any more (moved or deleted?). ${reach}`
        : `Can’t reach this film right now: the sender’s PC is off, or UaN isn’t running on it. Try again when they are online. (${reach})`;
    } else {
      const video = /^video\//i.test(file.mime);
      note.textContent = video
        ? `This video’s format can’t be played inside UaN on this computer${code}, so it plays in VLC instead (nothing is downloaded).`
        : `This file’s format can’t be played inside UaN on this computer${code}.`;
      note.append(el('div', { class: 'note-actions' },
        video ? el('button', { type: 'button', class: 'small', text: 'Open in VLC (no download)', onclick: () => { viewerPlayer?.video.pause(); openInVlc(file); } }) : '',
        el('button', { type: 'button', class: 'small', text: 'Download', onclick: () => startDownload(file, S.active) })));
    }
    note.classList.remove('hidden');
    if (reach === 'ok' && /^video\//i.test(file.mime) && !autoVlc) {
      autoVlc = true;
      openInVlc(file, 'This video’s format can’t be played inside UaN on this computer, but VLC can play it without downloading.');
    }
  };
  if (/^video\//i.test(file.mime)) {
    viewerPlayer = makePlayer(body, { file, chat: S.active });
    viewerPlayer.video.addEventListener('error', showError);
    watchSound(viewerPlayer.video, file, () => {
      if (token !== viewerToken || autoVlc) return;
      autoVlc = true;
      viewerPlayer?.video.pause();
      note.textContent = 'This film’s sound can’t be played inside UaN on this computer, so it plays in VLC instead (nothing is downloaded).';
      note.append(el('div', { class: 'note-actions' },
        el('button', { type: 'button', class: 'small', text: 'Open in VLC (no download)', onclick: () => { viewerPlayer?.video.pause(); openInVlc(file); } })));
      note.classList.remove('hidden');
      openInVlc(file, 'This film’s sound can’t be played inside UaN on this computer, but VLC can play it without downloading.');
    });
  } else {
    const src = mediaUrl(file);
    const node = IMAGE.test(file.mime) ? el('img', { src, alt: file.name }) : el('audio', { src, controls: true, autoplay: true });
    node.addEventListener('error', showError);
    body.replaceChildren(node);
  }
  $('viewerName').textContent = `${file.name} · ${fmtBytes(file.size)}`;
  $('viewerDl').classList.toggle('hidden', file.owner === S.me.id);
  $('viewerVlc').classList.toggle('hidden', !/^video\//i.test(file.mime));
  $('viewerVlc').onclick = () => { viewerPlayer?.video.pause(); openInVlc(file); };
  $('viewerDl').onclick = () => { startDownload(file, S.active); toast('Download started. It saves to your Downloads folder.'); };
  $('viewer').classList.remove('hidden');
}
function closeViewer() {
  viewerToken++;
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
    add: 'Pick friends to add. They will see the earlier messages too.',
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
      if (pickGroup.owner === S.me.id) {
        toast('Added. They can see the earlier messages too.');
      } else {
        const creator = pickGroup.members.find((m) => m.id === pickGroup.owner)?.name || 'the group’s creator';
        toast(`They join as soon as ${creator}’s PC is online (it keeps the member list).`);
      }
    }
  } catch (err) { $('pickError').textContent = err; }
});

// Dialogs close when you click outside them (on the dimmed area around them).
document.addEventListener('mousedown', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDialogElement) || !d.open) return;
  const r = d.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inside) d.close();
});

// ---------- Menus ----------
function showMenu(x, y, items) {
  const m = $('ctxMenu');
  m.replaceChildren(...items.filter(Boolean).map((it) => (it === '-'
    ? el('hr')
    : el('button', { type: 'button', class: it.danger ? 'danger-text' : '', text: it.label, onclick: () => { hideMenu(); it.run(); } }))));
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
}
function hideMenu() { $('ctxMenu').classList.add('hidden'); }
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#ctxMenu')) hideMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
window.addEventListener('blur', hideMenu);

function muteItem(chat) {
  const on = S.mutes.has(chat);
  return { label: on ? 'Unmute notifications' : 'Mute notifications', run: async () => {
    await invoke('set_mute', { chat, on: !on }).catch(toast);
    if (on) S.mutes.delete(chat); else S.mutes.add(chat);
    renderLists();
    toast(on ? 'Notifications are on again.' : 'Muted. You still get a notification if someone @mentions you or answers you.');
  } };
}

function groupMenu(g) {
  const owner = g.owner === S.me.id;
  return [
    { label: 'Add people…', run: () => openPick('add', g) },
    muteItem(`g:${g.id}`),
    { label: 'Members and details', run: () => openGroupInfo(g.id) },
    '-',
    { label: 'Clear messages for me', run: () => clearChat(`g:${g.id}`, false) },
    owner ? { label: 'Clear messages for everyone', danger: true, run: () => clearChat(`g:${g.id}`, true) } : null,
    { label: owner ? 'Delete group' : 'Leave group', danger: true, run: () => leaveGroup(g) },
  ];
}
function friendMenu(f) {
  return [
    { label: 'Open chat', run: () => openChat(f.id) },
    muteItem(f.id),
    '-',
    { label: 'Clear messages for me', run: () => clearChat(f.id, false) },
    { label: 'Remove friend', danger: true, run: async () => {
      if (await ask(`Remove ${f.name} from your friends? You won’t be able to message each other until one of you adds the other again.`, 'Remove friend')) friendAction(f.id, 'remove');
    } },
  ];
}
async function clearChat(chat, everyone) {
  const name = chatInfo(chat)?.name || 'this chat';
  const text = everyone
    ? `Clear all messages in “${name}” for everyone? They disappear on every member’s PC. This can’t be undone.`
    : `Clear all messages in “${name}” on this computer? The others keep theirs. This can’t be undone.`;
  if (!(await ask(text, 'Clear messages'))) return;
  try {
    await invoke('clear_chat', { chat, everyone });
  } catch (e) {
    toast(e);
  }
}
listen('cleared', ({ payload }) => {
  S.msgs.set(payload.chat, []);
  S.reads.delete(payload.chat);
  S.unread.delete(payload.chat);
  if (payload.chat === S.active) renderMessages();
  renderLists();
});

async function leaveGroup(g) {
  const owner = g.owner === S.me.id;
  if (await ask(owner ? `Delete “${g.name}” for everyone?` : `Leave “${g.name}”?`, owner ? 'Delete' : 'Leave')) {
    await groupAct(g, owner ? 'delete' : 'leave');
    if (S.active === `g:${g.id}`) closeChat();
  }
}

// ---------- Chat details: click the chat's name ----------
$('chatTitle').addEventListener('click', () => {
  const info = chatInfo(S.active);
  if (!info) return;
  if (info.group) return openGroupInfo(info.group.id);
  const r = $('chatTitle').getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, friendMenu(info.friend).slice(2));
});

let groupDlgId = null;
function openGroupInfo(id = groupDlgId) {
  const g = groupById(id);
  if (!g) return;
  groupDlgId = g.id;
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
  $('gLeave').textContent = owner ? 'Delete group' : 'Leave group';
  if (!$('groupDlg').open) $('groupDlg').showModal();
}

async function groupAct(g, action, ids = [], name = '') {
  try {
    await invoke('group_action', { group: g.id, action, ids, name });
    await loadContacts();
    if (!groupById(g.id)) $('groupDlg').close();
    else if ($('groupDlg').open) openGroupInfo(g.id);
  } catch (err) {
    if ($('groupDlg').open) $('gError').textContent = err;
    else toast(err);
  }
}
$('gRename').addEventListener('click', () => groupAct(groupById(groupDlgId), 'rename', [], $('gName').value));
$('gAdd').addEventListener('click', () => {
  const g = groupById(groupDlgId);
  $('groupDlg').close();
  openPick('add', g);
});
$('gClose').addEventListener('click', () => $('groupDlg').close());
$('gLeave').addEventListener('click', () => {
  const g = groupById(groupDlgId);
  $('groupDlg').close();
  leaveGroup(g);
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
      const relay = S.links?.[t.file.owner] && !S.links[t.file.owner].direct;
      info = t.error || [`${fmtBytes(t.done)} of ${fmtBytes(t.size)}`, t.speed ? `${fmtBytes(t.speed)}/s` : '', t.speed ? `${fmtDur((t.size - t.done) / t.speed)} left` : '', relay ? 'through a relay (slower)' : ''].filter(Boolean).join(' · ');
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
  $('sTyping').checked = S.me.typing;
  $('sReceipts').checked = S.me.receipts;
  renderThemeTiles();
  renderIconTiles();
  renderAvatarTiles();
  $('sAutoDl').checked = S.me.autodl;
  $('sAutoDlGb').value = S.me.autodlGb;
  $('sAutoRow').classList.toggle('hidden', !!S.me.profileName);
  $('sCode').textContent = S.me.code;
  $('sCode').classList.add('hidden');
  $('sShowCode').textContent = 'Show friend code';
  $('sError').textContent = '';
  $('settingsDlg').showModal();
});
$('sCancel').addEventListener('click', () => $('settingsDlg').close());

function askPassword({ title, note, ok, twice }) {
  return new Promise((resolve) => {
    $('pwTitle').textContent = title;
    $('pwNote').textContent = note;
    $('pwOk').textContent = ok;
    $('pwInput').value = '';
    $('pwInput2').value = '';
    $('pwInput2').classList.toggle('hidden', !twice);
    $('pwErr').textContent = '';
    const d = $('pwDlg');
    const done = (v) => { d.close(); resolve(v); };
    $('pwCancel').onclick = () => done(null);
    $('pwForm').onsubmit = (e) => {
      e.preventDefault();
      const p = $('pwInput').value;
      if (p.trim().length < 4) return void ($('pwErr').textContent = 'Use a password of at least 4 characters.');
      if (twice && p !== $('pwInput2').value) return void ($('pwErr').textContent = 'The two passwords are different.');
      done(p);
    };
    d.addEventListener('close', () => resolve(null), { once: true });
    d.showModal();
    setTimeout(() => $('pwInput').focus(), 30);
  });
}
$('sBackup').addEventListener('click', async () => {
  const password = await askPassword({ title: 'Save a backup', ok: 'Save…', twice: true,
    note: 'Choose a password for the backup file. You need it to restore it, and nobody can use the file without it. Keep it somewhere safe.' });
  if (!password) return;
  try {
    if (await invoke('export_backup', { password })) toast('Backup saved. Keep the file and the password safe.');
  } catch (e) { toast(e); }
});
$('sRestore').addEventListener('click', async () => {
  if (!(await ask('Restoring a backup replaces the friend code, friends, groups and messages on this PC with the ones in the backup. UaN restarts afterwards.', 'Choose backup…'))) return;
  const password = await askPassword({ title: 'Restore from backup', ok: 'Choose file…', note: 'The password you chose when you saved the backup.' });
  if (!password) return;
  try {
    await invoke('import_backup', { password });
  } catch (e) { toast(e); }
});
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
    await invoke('set_autodl', { on: $('sAutoDl').checked, gb: Math.max(1, Number($('sAutoDlGb').value) || 10) });
    await invoke('set_privacy', { typing: $('sTyping').checked, receipts: $('sReceipts').checked });
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
    const ext = m.file ? (m.file.name.includes('.') ? m.file.name.split('.').pop() : 'file').slice(0, 4) : 'msg';
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
    ? `${nameOf(best.id)} ${best.id === S.me.id ? 'have' : 'has'} the fastest connection (${mbps(best.v).toFixed(0)} Mbit/s up), so ${best.id === S.me.id ? 'your' : 'their'} PC will share the film with everyone. Nobody downloads it: it streams, and it only starts (and keeps going) when everyone has enough loaded, so it won’t stutter even on slow internet.`
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
  const p = [...S.parties.values()].find((x) => groupIdOf(S.active) === x.group && x.state !== 'ended' && x.members.some((m) => m.id === S.me.id && !m.joined && !m.left));
  bar.classList.toggle('hidden', !p);
  if (!p) return;
  const host = p.members.find((m) => m.id === p.leader)?.name || 'Someone';
  bar.replaceChildren(
    svg(ICON.bigplay),
    el('span', { class: 'grow ellipsis', text: `${host} invited you to watch “${p.file.name}” together` }),
    el('button', { class: 'accent small', type: 'button', text: 'Join', title: 'Streams the film, nothing is downloaded', onclick: async () => { await invoke('party_join', { id: p.id, full: false }).catch(toast); openParty(p.id); } }),
    el('button', { class: 'small', type: 'button', text: 'Join, download first', title: 'Downloads the whole film before it starts (smoothest; kept in Downloads/UaN)', onclick: async () => { await invoke('party_join', { id: p.id, full: true }).catch(toast); openParty(p.id); } }),
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

let partyMode = 'app'; // 'app' = built-in player, 'vlc' = VLC kept in sync
const noAutoVlc = new Set(); // parties where you went back from VLC yourself

let partyFileId = null;
function partyChatOf(p) { return `g:${p.group}`; }
function partyLine(m) {
  return el('div', { class: 'pm-line', 'data-id': m.id }, el('b', { text: m.mine ? 'You' : m.senderName }),
    m.locked ? 'Locked message' : m.text ? formatText(m.text) : m.file ? `sent ${m.file.name}` : '');
}
async function loadPartyChat(p) {
  const list = await invoke('messages', { chat: partyChatOf(p), limit: 100 }).catch(() => []);
  $('partyMsgs').replaceChildren(...list.map(partyLine));
  $('partyMsgs').scrollTop = $('partyMsgs').scrollHeight;
}
$('partySideBtn').addEventListener('click', () => {
  const hidden = $('partySide').classList.toggle('hidden');
  try { localStorage.setItem('uan.partySide', hidden ? '0' : '1'); } catch {}
});
document.querySelectorAll('.party-tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.party-tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('partyChatTab').classList.toggle('hidden', b.dataset.tab !== 'chat');
  $('partyQueueTab').classList.toggle('hidden', b.dataset.tab !== 'queue');
}));
$('partyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = S.parties.get(openPartyId);
  const text = $('partyInput').value.trim();
  if (!p || !text) return;
  $('partyInput').value = '';
  try { await invoke('send_text', { chats: [partyChatOf(p)], text }); } catch (err) { $('partyInput').value = text; toast(err); }
});
function renderQueue(p) {
  const leader = p.leader === S.me.id;
  const q = p.queue || [];
  $('partyQueue').replaceChildren(
    el('div', { class: 'pq-item' }, el('span', { class: 'grow ellipsis', text: p.file.name }), el('span', { class: 'pq-now', text: 'now' })),
    ...q.map((f, i) => el('div', { class: 'pq-item' },
      el('span', { class: 'grow ellipsis', text: `${i + 1}. ${f.name}` }),
      leader && i === 0 ? el('button', { type: 'button', class: 'small', text: 'Play now', onclick: () => invoke('party_next', { id: p.id, remove: null }).catch(toast) }) : null,
      leader ? el('button', { type: 'button', class: 'small', text: 'Remove', onclick: () => invoke('party_next', { id: p.id, remove: f.id }).catch(toast) }) : null)),
    q.length ? '' : el('div', { class: 'note', text: 'Nothing queued. Add films, and the next one starts by itself when this one ends.' }));
}
$('partyAdd').addEventListener('click', async () => {
  const p = S.parties.get(openPartyId);
  if (!p) return;
  const list = await invoke('messages', { chat: partyChatOf(p), limit: 5000 }).catch(() => []);
  const seen = new Set();
  const films = list.filter((m) => m.file && /^video\//i.test(m.file.mime)).map((m) => m.file).reverse()
    .filter((f) => !seen.has(f.id) && seen.add(f.id) && f.id !== p.file.id && !(p.queue || []).some((x) => x.id === f.id));
  $('queueList').replaceChildren(...films.map((f) => el('button', { type: 'button', class: 'pin-item', onclick: async () => {
    $('queueDlg').close();
    try { await invoke('party_queue', { id: p.id, file: f }); toast(`Added “${f.name}” to the playlist.`); } catch (e) { toast(e); }
  } }, el('span', { text: f.name }), el('span', { class: 'sub', text: fmtBytes(f.size) }))));
  if (!films.length) $('queueList').append(el('div', { class: 'note', text: 'No other films in this group yet. Send one to the group first.' }));
  $('queueDlg').showModal();
});

function openParty(id, mode = partyMode) {
  const p = S.parties.get(id);
  if (!p) return;
  partyFileId = p.file.id;
  try { $('partySide').classList.toggle('hidden', localStorage.getItem('uan.partySide') !== '1'); } catch {}
  loadPartyChat(p);
  renderQueue(p);
  partyPlayer?.destroy();
  openPartyId = id;
  autoPaused = false;
  partyMode = mode;
  partyPlayer = mode === 'vlc'
    ? makeVlcPlayer($('partyStage'), { file: p.file, onBack: () => { noAutoVlc.add(id); openParty(id, 'app'); } })
    : makePlayer($('partyStage'), { file: p.file, chat: `g:${p.group}`, autoplay: false, stream: true, resume: false });
  $('partyVlc').classList.toggle('hidden', mode === 'vlc');
  const v = partyPlayer.video;
  // Closing VLC brings you back to the built-in player, still in the party.
  v.addEventListener('vlcclosed', () => {
    if (openPartyId === id) {
      noAutoVlc.add(id);
      toast('VLC was closed. Back to the built-in player.');
      openParty(id, 'app');
    }
  });
  if (mode === 'app') {
    const toVlc = async (what) => {
      if (openPartyId !== id || partyPlayer?.video !== v) return;
      if (noAutoVlc.has(id)) return toast(`This film’s ${what} can’t play inside UaN here. Press “Watch in VLC” to watch it in sync.`);
      toast(`This film’s ${what} can’t play inside UaN here, so it plays in VLC, still in sync with everyone.`);
      if (await ensureVlc(`This film’s ${what} can’t play inside UaN on this computer, but VLC can play it in sync with everyone, without downloading.`)) {
        if (openPartyId === id && partyMode === 'app') openParty(id, 'vlc');
      } else {
        noAutoVlc.add(id);
      }
    };
    v.addEventListener('error', async () => {
      if (openPartyId !== id || partyPlayer?.video !== v) return;
      if (!isFormatError(v.error)) {
        // A dropped connection: reload the film where we were, still in the party.
        const at = v.currentTime;
        toast('The connection dropped. Reloading the film…');
        setTimeout(() => {
          if (openPartyId === id && partyPlayer?.video === v && v.error) {
            v.src = v.src;
            v.currentTime = at;
          }
        }, 1500);
        return;
      }
      if ((await reachability(p.file)) !== 'ok') return;
      toVlc('format');
    });
    watchSound(v, p.file, () => toVlc('sound'));
  }
  v.addEventListener('ended', () => {
    const cur = S.parties.get(id);
    if (cur && cur.leader === S.me.id && (cur.queue || []).length) invoke('party_next', { id, remove: null }).catch(() => {});
  });
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
    const pct = Math.floor((m.have / (p.file.size || 1)) * 100);
    const status = !m.joined ? 'invited'
      : m.buffering ? 'loading…'
      : m.full && !full ? `downloading the whole film · ${pct}%`
      : m.ready ? (full ? 'ready' : `ready · ${fmtBytes(m.have)} ahead`)
      : `buffering ${fmtBytes(m.have)}`;
    const bar = el('div');
    const target = m.full ? p.file.size : Math.min(READY_AHEAD, p.file.size);
    bar.style.width = `${m.joined ? Math.min(100, (m.have / (target || 1)) * 100) : 0}%`;
    return el('div', { class: 'pm' + (m.ready && m.joined && !m.buffering ? ' ready' : '') },
      el('div', { class: 'strong ellipsis', text: (m.id === S.me.id ? 'You' : m.name) }),
      el('div', { class: 'sub', text: status + (m.id === p.seeder ? ' · shares the film' : '') }),
      el('div', { class: 'bar' }, bar));
  }));

  const wait = $('partyWait');
  const stuck = joinedOf(p).filter((m) => m.buffering || (p.state !== 'playing' && !m.ready));
  if (p.state === 'loading') {
    wait.textContent = partyReady(p)
      ? 'Everyone is ready. Starting…'
      : `Getting the film ready for everyone. It streams, unless someone chose to download it first.\nIt starts as soon as everyone has enough loaded${stuck.length ? ` (waiting for ${stuck.map((m) => (m.id === S.me.id ? 'you' : m.name) + (m.full ? ` to download it, ${Math.floor((m.have / (p.file.size || 1)) * 100)}%` : '')).join(', ')})` : ''}.`;
    wait.classList.remove('hidden');
  } else if (p.state === 'paused' && stuck.length) {
    wait.textContent = `Waiting for ${stuck.map((m) => (m.id === S.me.id ? 'you' : m.name)).join(', ')} to catch up…\nThe film continues for everyone automatically.`;
    wait.classList.remove('hidden');
  } else {
    wait.classList.add('hidden');
  }
  const mine = p.members.find((m) => m.id === S.me.id);
  // Nothing to choose once you have the whole film (you sent it, or your download is finished).
  const haveAll = p.file.owner === S.me.id || (mine?.full && mine.have >= p.file.size);
  $('partyFull').classList.toggle('hidden', !mine || haveAll);
  $('partyFull').textContent = mine?.full ? 'Just stream instead' : 'Download whole film first';
  $('partyFull').title = mine?.full
    ? 'Stop downloading and stream the film like the others (what is downloaded so far is kept)'
    : 'Download the whole film before watching: smoothest playback, the party waits for you. A copy is kept in Downloads/UaN.';
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

$('partyVlc').addEventListener('click', async () => {
  if (!(await ensureVlc())) return;
  if (openPartyId) openParty(openPartyId, 'vlc');
});

$('partyFull').addEventListener('click', async () => {
  const p = S.parties.get(openPartyId);
  const mine = p?.members.find((m) => m.id === S.me.id);
  if (!p || !mine) return;
  try {
    await invoke('party_full', { id: p.id, full: !mine.full });
    toast(mine.full ? 'Streaming the film again.' : 'Downloading the whole film. The party waits until you have it.');
  } catch (e) {
    toast(e);
  }
});

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
    if (openPartyId === p.id) {
      if (partyFileId && p.file.id !== partyFileId) {
        toast(`Next film: ${p.file.name}`);
        openParty(p.id);
      } else {
        renderParty(p);
        renderQueue(p);
      }
    }
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
// Extra themes. "image" is a background gradient; the panels over it are see-through.
const GLASS_DARK = { side: 'rgba(0, 0, 0, .30)', panel: 'rgba(0, 0, 0, .16)', card: 'rgba(255, 255, 255, .10)', theirs: 'rgba(255, 255, 255, .12)' };
const GLASS_LIGHT = { side: 'rgba(255, 255, 255, .45)', panel: 'rgba(255, 255, 255, .55)', card: 'rgba(255, 255, 255, .85)', theirs: '#ffffff' };
const THEMES = [
  { id: 'system', name: 'Auto' },
  { id: 'light', name: 'Light', preview: ['#ebebeb', '#fbfbfb'] },
  { id: 'dark', name: 'Dark', preview: ['#1c1c1c', '#272727'] },
  { id: 'ash', name: 'Ash', base: 'dark', bg: '#2c2f36', side: '#24272d', panel: '#32353d', card: '#3a3e47', theirs: '#3a3e47', accent: '#8ea1ff', mine: '#4b5bd6' },
  { id: 'onyx', name: 'Onyx', base: 'dark', bg: '#000000', side: '#070707', panel: '#0d0d0d', card: '#171717', theirs: '#171717', accent: '#e6e6e6', mine: '#2b2b2b' },
  { id: 'midnight', name: 'Midnight', base: 'dark', bg: '#0f1424', side: '#0b0f1c', panel: '#141a2e', card: '#1b2340', theirs: '#1b2340', accent: '#7aa2ff', mine: '#2f4fb0' },
  { id: 'forest', name: 'Forest', base: 'dark', bg: '#10201a', side: '#0c1814', panel: '#152a22', card: '#1c362c', theirs: '#1c362c', accent: '#6ad19a', mine: '#1f7a52' },
  { id: 'coffee', name: 'Coffee', base: 'dark', bg: '#241c17', side: '#1d1612', panel: '#2c221c', card: '#362a22', theirs: '#362a22', accent: '#e0b07a', mine: '#8a5a2b' },
  { id: 'sunset', name: 'Sunset', base: 'dark', image: 'linear-gradient(135deg, #2a1338 0%, #5a1f3e 55%, #a8452a 100%)', bg: '#3a1838', ...GLASS_DARK, dialog: '#3a1a35', accent: '#ffb36b', mine: '#b0522e' },
  { id: 'ocean', name: 'Ocean', base: 'dark', image: 'linear-gradient(135deg, #06283d 0%, #0b5c73 60%, #13836b 100%)', bg: '#0a3c50', ...GLASS_DARK, dialog: '#0b3346', accent: '#6ee7d2', mine: '#0f7f78' },
  { id: 'aurora', name: 'Aurora', base: 'dark', image: 'linear-gradient(135deg, #1b1040 0%, #3a2a8c 50%, #0f7a6c 100%)', bg: '#2a1e68', ...GLASS_DARK, dialog: '#241a58', accent: '#9ef0c0', mine: '#5a48c8' },
  { id: 'neon', name: 'Neon', base: 'dark', image: 'linear-gradient(135deg, #0d0221 0%, #3a0ca3 60%, #b5179e 100%)', bg: '#22085e', ...GLASS_DARK, dialog: '#1e0a52', accent: '#4cc9f0', mine: '#7209b7' },
  { id: 'crimson', name: 'Crimson', base: 'dark', image: 'linear-gradient(135deg, #1a0508 0%, #4a0d18 55%, #7a1524 100%)', bg: '#3a0a12', ...GLASS_DARK, dialog: '#330a11', accent: '#ff9a9a', mine: '#9c1f30' },
  { id: 'christmas', name: 'Christmas', base: 'dark', snow: true, image: 'radial-gradient(ellipse at 50% 120%, #1f5e3a 0%, rgba(31, 94, 58, 0) 60%), linear-gradient(160deg, #3b0a12 0%, #6b0f1d 45%, #0f3d26 100%)', bg: '#4a0e18', ...GLASS_DARK, side: '#2e070d', card: '#43121b', theirs: 'rgba(30, 6, 10, .78)', dialog: '#3d0d16', accent: '#f2c14e', mine: '#b3202f' },
  { id: 'sakura', name: 'Sakura', base: 'light', image: 'linear-gradient(135deg, #ffe3ec 0%, #ffd0e0 50%, #e9d5ff 100%)', bg: '#ffdbe8', ...GLASS_LIGHT, dialog: '#fff3f7', accent: '#c2255c', mine: '#c2255c' },
  { id: 'mint', name: 'Mint', base: 'light', image: 'linear-gradient(135deg, #e3fff3 0%, #c9f2ff 100%)', bg: '#d8f8f8', ...GLASS_LIGHT, dialog: '#f2fffb', accent: '#0b7a5c', mine: '#0b7a5c' },
  { id: 'lavender', name: 'Lavender', base: 'light', image: 'linear-gradient(135deg, #efe7ff 0%, #dfe7ff 100%)', bg: '#e8e6ff', ...GLASS_LIGHT, dialog: '#f7f4ff', accent: '#6741d9', mine: '#6741d9' },
];
const SECRET = { id: 'secret', name: 'Secret', base: 'dark', ...GLASS_DARK, side: 'rgba(20, 12, 6, .82)', card: 'rgba(60, 36, 18, .9)', theirs: 'rgba(25, 15, 8, .8)', dialog: '#2a1a0e', bg: '#2a1a0e', accent: '#e8a25c', mine: '#9a4d1e', secret: true };
const themeById = (id) => (id === 'secret' ? SECRET : THEMES.find((t) => t.id === id) || THEMES[0]);
const theme = (() => {
  try {
    const stored = localStorage.getItem('uan.accent');
    return { mode: themeById(localStorage.getItem('uan.theme') || 'system').id, accent: stored === null ? -1 : Number(stored) };
  } catch { return { mode: 'system', accent: -1 }; }
})();

function isDark() {
  const t = themeById(theme.mode);
  if (t.base) return t.base === 'dark';
  return theme.mode === 'dark' || (theme.mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}
const THEME_VARS = { bg: '--bg', side: '--side', panel: '--panel', card: '--card', theirs: '--theirs', image: '--bg-image', dialog: '--dialog' };
function applyTheme() {
  const root = document.documentElement;
  const t = themeById(theme.mode);
  if (t.id === 'system') delete root.dataset.theme;
  else root.dataset.theme = t.base || t.id;
  for (const [key, name] of Object.entries(THEME_VARS)) {
    if (t[key]) root.style.setProperty(name, t[key]);
    else root.style.removeProperty(name);
  }
  const dark = isDark();
  // -1 = the theme's own colour.
  const own = theme.accent < 0 || !ACCENTS[theme.accent];
  const a = own ? ACCENTS[0] : ACCENTS[theme.accent];
  const color = own && t.accent ? t.accent : (dark ? a.dark : a.light);
  root.style.setProperty('--accent', color);
  root.style.setProperty('--accent-hover', color);
  root.style.setProperty('--on-accent', dark ? '#000' : '#fff');
  root.style.setProperty('--mine', own && t.mine ? t.mine : (dark ? `color-mix(in srgb, ${color} 45%, #1c1c1c)` : color));
  root.style.setProperty('--on-mine', '#fff');
  setSnow(!!t.snow);
}

// Gentle snowfall behind the app (Christmas theme). Light on the CPU: few flakes, ~30 frames a second,
// and it stops while the window is hidden.
let snow = null;
function setSnow(on) {
  if (on) document.documentElement.dataset.snow = '';
  else delete document.documentElement.dataset.snow;
  if (!on) {
    if (snow) { cancelAnimationFrame(snow.raf); snow.canvas.remove(); snow = null; }
    return;
  }
  if (snow) return;
  const canvas = el('canvas', { class: 'snow', 'aria-hidden': 'true' });
  document.body.prepend(canvas);
  const flakes = Array.from({ length: 55 }, () => ({ x: Math.random(), y: Math.random(), r: 0.8 + Math.random() * 2.2, s: 0.15 + Math.random() * 0.35, d: Math.random() * Math.PI * 2 }));
  let last = 0;
  const frame = (t) => {
    snow.raf = requestAnimationFrame(frame);
    if (document.hidden || t - last < 33) return;
    const dt = Math.min(100, t - last) / 16;
    last = t;
    const w = (canvas.width = innerWidth), h = (canvas.height = innerHeight);
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(255, 255, 255, .5)';
    for (const f of flakes) {
      f.y += (f.s * dt) / h * 3;
      f.d += 0.01 * dt;
      if (f.y > 1.02) { f.y = -0.02; f.x = Math.random(); }
      c.beginPath();
      c.arc(f.x * w + Math.sin(f.d) * 12, f.y * h, f.r, 0, Math.PI * 2);
      c.fill();
    }
  };
  snow = { canvas, raf: requestAnimationFrame(frame) };
}
// Where the face is in the secret picture (0..1 of width/height). For the original photo it is
// known; for other pictures: portrait photos usually have the face in the upper part.
let secretPic = null;
function secretFocus(img) {
  if (img.naturalWidth === 987 && img.naturalHeight === 1755) return [0.565, 0.135];
  return img.naturalHeight > img.naturalWidth * 1.15 ? [0.5, 0.25] : [0.5, 0.4];
}
function placeSecret() {
  if (!secretPic || theme.mode !== 'secret') return;
  const img = secretPic.img;
  if (!img.naturalWidth) return;
  const W = innerWidth, H = innerHeight;
  const [fx, fy] = secretFocus(img);
  // Centre of the chat area (right of the side bar), or of the window.
  const area = document.querySelector('#main:not(.hidden) .content')?.getBoundingClientRect();
  const cx = area && area.width ? area.left + area.width / 2 : W / 2;
  const cy = area && area.height ? area.top + area.height / 2 : H / 2;
  // Big enough to cover the window, and to have room to put the face in the centre.
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const k = Math.min(3, Math.max(W / iw, H / ih, cx / (fx * iw), (W - cx) / ((1 - fx) * iw), cy / (fy * ih), (H - cy) / ((1 - fy) * ih)));
  const w = iw * k, h = ih * k;
  const x = Math.min(0, Math.max(W - w, cx - fx * w));
  const y = Math.min(0, Math.max(H - h, cy - fy * h));
  SECRET.image = `linear-gradient(rgba(0, 0, 0, .25), rgba(0, 0, 0, .45)), url("${secretPic.url}") ${Math.round(x)}px ${Math.round(y)}px / ${Math.round(w)}px ${Math.round(h)}px no-repeat`;
  document.documentElement.style.setProperty('--bg-image', SECRET.image);
}
function useSecretPicture(url) {
  const img = new Image();
  secretPic = { url, img };
  img.onload = placeSecret;
  img.src = url;
  SECRET.image = `linear-gradient(rgba(0, 0, 0, .25), rgba(0, 0, 0, .45)), url("${url}") center / cover no-repeat`;
}
window.addEventListener('resize', placeSecret);

async function unlockSecret() {
  let pic = await invoke('secret_picture').catch(() => null);
  if (!pic) {
    // Not on this PC yet: pick the picture once (it stays on this PC only).
    const input = el('input', { type: 'file', accept: 'image/*' });
    pic = await new Promise((resolve) => {
      input.onchange = async () => {
        const f = input.files[0];
        if (!f) return resolve(null);
        try {
          const img = await createImageBitmap(f);
          const k = Math.min(1, 1600 / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * k);
          c.height = Math.round(img.height * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          const url = c.toDataURL('image/jpeg', 0.88);
          await invoke('set_secret_picture', { jpeg: url.split(',')[1] });
          resolve(url);
        } catch { resolve(null); }
      };
      input.click();
    });
    if (!pic) return;
  }
  useSecretPicture(pic);
  setTheme('secret');
  placeSecret();
  toast('Secret theme unlocked.');
}

function setTheme(id) {
  theme.mode = themeById(id).id;
  theme.accent = -1; // every theme starts with its own colour
  try {
    localStorage.setItem('uan.theme', theme.mode);
    localStorage.removeItem('uan.accent');
  } catch {}
  applyTheme();
  renderSwatches();
  renderThemeTiles();
}
function renderSwatches() {
  const t = themeById(theme.mode);
  const pick = (i) => {
    theme.accent = i;
    try { if (i < 0) localStorage.removeItem('uan.accent'); else localStorage.setItem('uan.accent', String(i)); } catch {}
    applyTheme();
    renderSwatches();
  };
  const own = el('button', { type: 'button', class: 'swatch' + (theme.accent < 0 ? ' on' : ''), title: 'The theme’s own colour', onclick: () => pick(-1) });
  own.style.background = t.accent || (isDark() ? ACCENTS[0].dark : ACCENTS[0].light);
  $('sAccent').replaceChildren(own, ...ACCENTS.slice(t.accent ? 0 : 1).map((a) => {
    const i = ACCENTS.indexOf(a);
    const b = el('button', { type: 'button', class: 'swatch' + (i === theme.accent ? ' on' : ''), title: a.name, onclick: () => pick(i) });
    b.style.background = isDark() ? a.dark : a.light;
    return b;
  }));
}
function renderThemeTiles() {
  const sel = $('sTheme');
  if (!sel.options.length) sel.replaceChildren(...THEMES.map((t) => el('option', { value: t.id, text: t.name })));
  sel.value = theme.mode;
  $('sThemes').replaceChildren(...THEMES.map((t) => {
    const sideC = t.side || t.preview?.[0];
    const mainC = t.panel || t.preview?.[1];
    const tile = el('span', { class: 'tile' });
    if (t.id === 'system') {
      tile.style.background = 'linear-gradient(135deg, #fbfbfb 50%, #272727 50%)';
    } else {
      tile.style.background = t.image || t.bg || mainC;
      const side = el('i', { class: 't-side' });
      side.style.background = sideC;
      const main = el('i', { class: 't-main' });
      main.style.background = t.image ? 'transparent' : mainC;
      const b1 = el('b'); b1.style.cssText = `width: 60%; background: ${t.mine || (t.id === 'light' ? '#005fb8' : '#0f4a73')}`;
      const b2 = el('b'); b2.style.cssText = `width: 40%; align-self: flex-start; background: ${t.theirs || (t.id === 'light' ? '#ffffff' : '#3a3a3a')}`;
      main.append(b2, b1);
      tile.append(side, main);
    }
    return el('button', { type: 'button', class: t.id === theme.mode ? 'on' : '', title: t.id === 'system' ? 'Same as your computer (light or dark)' : t.name, 'data-theme-id': t.id, onclick: () => setTheme(t.id) },
      tile, el('span', { class: 't-name', text: t.name }));
  }));
}
$('sTheme').addEventListener('change', () => setTheme($('sTheme').value));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();
if (theme.mode === 'secret') {
  invoke('secret_picture').then((pic) => {
    if (pic) { useSecretPicture(pic); applyTheme(); }
    else setTheme('dark');
  }).catch(() => {});
}

// ---------- App icon: a few ready-made ones ----------
const APP_ICONS = [
  { id: 'default', name: 'Original' },
  { id: 'violet', name: 'Violet', from: '#8b5cf6', to: '#5b21b6', plane: '#ffffff' },
  { id: 'green', name: 'Green', from: '#34d399', to: '#047857', plane: '#ffffff' },
  { id: 'sunset', name: 'Sunset', from: '#fb923c', to: '#db2777', plane: '#ffffff' },
  { id: 'red', name: 'Red', from: '#f87171', to: '#b91c1c', plane: '#ffffff' },
  { id: 'night', name: 'Night', from: '#374151', to: '#0b0f19', plane: '#ffffff' },
  { id: 'snow', name: 'Snow', from: '#ffffff', to: '#dbe4f0', plane: '#2563eb' },
  { id: 'gold', name: 'Gold', from: '#fcd34d', to: '#d97706', plane: '#1f2937' },
];
function drawAppIcon(canvas, icon) {
  const n = canvas.width;
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, n, n);
  const r = n * 0.22;
  c.beginPath();
  c.roundRect(0, 0, n, n, r);
  const g = c.createLinearGradient(0, 0, n, n);
  g.addColorStop(0, icon.from);
  g.addColorStop(1, icon.to);
  c.fillStyle = g;
  c.fill();
  // The paper plane, like on the original icon.
  const p = (x, y) => [x * n, y * n];
  c.beginPath();
  c.moveTo(...p(0.26, 0.50));
  c.lineTo(...p(0.76, 0.27));
  c.lineTo(...p(0.53, 0.77));
  c.lineTo(...p(0.47, 0.565));
  c.closePath();
  c.fillStyle = icon.plane;
  c.fill();
}
function currentIconId() {
  try { return S.me?.customIcon ? (localStorage.getItem('uan.icon') || 'default') : 'default'; } catch { return 'default'; }
}
async function setAppIcon(icon) {
  try {
    if (icon.id === 'default') {
      await invoke('set_app_icon', { rgba: null, png: null });
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      drawAppIcon(canvas, icon);
      const data = canvas.getContext('2d').getImageData(0, 0, 128, 128).data;
      let bin = '';
      for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
      const big = document.createElement('canvas');
      big.width = big.height = 256;
      drawAppIcon(big, icon);
      await invoke('set_app_icon', { rgba: btoa(bin), png: big.toDataURL('image/png').split(',')[1] });
    }
    try { localStorage.setItem('uan.icon', icon.id); } catch {}
    S.me.customIcon = icon.id !== 'default';
    renderIconTiles();
  } catch (e) {
    toast(e);
  }
}
function renderIconTiles() {
  const cur = currentIconId();
  $('sIcons').replaceChildren(...APP_ICONS.map((icon) => {
    const b = el('button', { type: 'button', class: icon.id === cur ? 'on' : '', title: icon.name, 'data-icon-id': icon.id, onclick: () => setAppIcon(icon) });
    if (icon.id === 'default') {
      b.append(el('img', { src: 'icon.png', alt: '', style: 'width:100%;height:100%;display:block' }));
    } else {
      const canvas = el('canvas', { width: 80, height: 80 });
      drawAppIcon(canvas, icon);
      b.append(canvas);
    }
    return b;
  }));
}

// ---------- Ready-made profile pictures ----------
const AVATARS = [
  { name: 'Sunrise', from: '#ffb347', to: '#ff5f6d', draw: (c) => { c.beginPath(); c.arc(50, 62, 20, Math.PI, 0); c.fill(); c.fillRect(18, 66, 64, 4); c.fillRect(28, 74, 44, 4); c.fillRect(38, 82, 24, 4); } },
  { name: 'Moon', from: '#1e3a8a', to: '#0b1026', draw: (c) => { c.beginPath(); c.arc(50, 50, 24, 0, Math.PI * 2); c.fill(); c.globalCompositeOperation = 'destination-out'; c.beginPath(); c.arc(60, 43, 21, 0, Math.PI * 2); c.fill(); c.globalCompositeOperation = 'source-over'; c.beginPath(); c.arc(72, 30, 2.5, 0, Math.PI * 2); c.arc(80, 52, 1.8, 0, Math.PI * 2); c.fill(); } },
  { name: 'Mountain', from: '#2dd4bf', to: '#0f766e', draw: (c) => { c.beginPath(); c.moveTo(14, 78); c.lineTo(42, 34); c.lineTo(58, 58); c.lineTo(68, 44); c.lineTo(88, 78); c.closePath(); c.fill(); c.beginPath(); c.arc(72, 26, 7, 0, Math.PI * 2); c.fill(); } },
  { name: 'Planet', from: '#a78bfa', to: '#5b21b6', draw: (c) => { c.beginPath(); c.arc(50, 50, 19, 0, Math.PI * 2); c.fill(); c.lineWidth = 4; c.beginPath(); c.ellipse(50, 50, 34, 10, -0.4, 0, Math.PI * 2); c.stroke(); } },
  { name: 'Wave', from: '#38bdf8', to: '#1d4ed8', draw: (c) => { c.lineWidth = 6; c.lineCap = 'round'; for (const y of [38, 54, 70]) { c.beginPath(); c.moveTo(18, y); c.bezierCurveTo(32, y - 14, 40, y + 14, 50, y); c.bezierCurveTo(60, y - 14, 68, y + 14, 82, y); c.stroke(); } } },
  { name: 'Tree', from: '#86efac', to: '#15803d', draw: (c) => { c.beginPath(); c.moveTo(50, 16); c.lineTo(70, 44); c.lineTo(60, 44); c.lineTo(76, 68); c.lineTo(24, 68); c.lineTo(40, 44); c.lineTo(30, 44); c.closePath(); c.fill(); c.fillRect(45, 68, 10, 14); } },
  { name: 'Bolt', from: '#fde047', to: '#f59e0b', ink: '#1f2937', draw: (c) => { c.beginPath(); c.moveTo(56, 14); c.lineTo(28, 54); c.lineTo(46, 54); c.lineTo(40, 86); c.lineTo(72, 42); c.lineTo(53, 42); c.closePath(); c.fill(); } },
  { name: 'Heart', from: '#fb7185', to: '#be123c', draw: (c) => { c.beginPath(); c.moveTo(50, 78); c.bezierCurveTo(10, 52, 22, 22, 50, 38); c.bezierCurveTo(78, 22, 90, 52, 50, 78); c.fill(); } },
  { name: 'Star', from: '#818cf8', to: '#3730a3', draw: (c) => { c.beginPath(); for (let i = 0; i < 10; i++) { const r = i % 2 ? 13 : 30; const a = -Math.PI / 2 + (i * Math.PI) / 5; c.lineTo(50 + r * Math.cos(a), 52 + r * Math.sin(a)); } c.closePath(); c.fill(); } },
  { name: 'Cat', from: '#fdba74', to: '#c2410c', draw: (c, bg) => { c.beginPath(); c.moveTo(26, 44); c.lineTo(28, 18); c.lineTo(46, 32); c.closePath(); c.fill(); c.beginPath(); c.moveTo(74, 44); c.lineTo(72, 18); c.lineTo(54, 32); c.closePath(); c.fill(); c.beginPath(); c.arc(50, 54, 26, 0, Math.PI * 2); c.fill(); c.fillStyle = bg; c.beginPath(); c.arc(40, 50, 4, 0, Math.PI * 2); c.arc(60, 50, 4, 0, Math.PI * 2); c.fill(); c.beginPath(); c.moveTo(46, 60); c.lineTo(54, 60); c.lineTo(50, 65); c.closePath(); c.fill(); } },
  { name: 'Ghost', from: '#64748b', to: '#1e293b', draw: (c, bg) => { c.beginPath(); c.moveTo(26, 82); c.lineTo(26, 46); c.arc(50, 46, 24, Math.PI, 0); c.lineTo(74, 82); c.lineTo(66, 74); c.lineTo(58, 82); c.lineTo(50, 74); c.lineTo(42, 82); c.lineTo(34, 74); c.closePath(); c.fill(); c.fillStyle = bg; c.beginPath(); c.arc(41, 46, 4.5, 0, Math.PI * 2); c.arc(59, 46, 4.5, 0, Math.PI * 2); c.fill(); } },
  { name: 'Mushroom', from: '#e0a96d', to: '#8a4f22', secret: true, draw: (c, bg) => {
    // stem: a thick, slightly bulging trunk
    c.globalAlpha = 0.78;
    c.beginPath(); c.moveTo(39, 50); c.bezierCurveTo(31, 62, 31, 80, 50, 83); c.bezierCurveTo(69, 80, 69, 62, 61, 50); c.closePath(); c.fill();
    c.globalAlpha = 1;
    // cap: a wide dome with a soft rim
    c.beginPath(); c.moveTo(14, 52); c.bezierCurveTo(14, 21, 86, 21, 86, 52); c.bezierCurveTo(72, 58, 28, 58, 14, 52); c.closePath(); c.fill();
    // a small shine on the cap
    c.fillStyle = bg; c.globalAlpha = 0.35;
    c.beginPath(); c.ellipse(36, 36, 8, 4, -0.5, 0, Math.PI * 2); c.fill();
    c.globalAlpha = 1;
  } },
  { name: 'Game', from: '#f472b6', to: '#7c3aed', draw: (c, bg) => { c.beginPath(); c.roundRect(16, 34, 68, 36, 18); c.fill(); c.fillStyle = bg; c.fillRect(30, 49, 14, 5); c.fillRect(34.5, 44.5, 5, 14); c.beginPath(); c.arc(62, 47, 3.5, 0, Math.PI * 2); c.arc(70, 56, 3.5, 0, Math.PI * 2); c.fill(); } },
];
function drawAvatar(canvas, a) {
  const n = canvas.width;
  const c = canvas.getContext('2d');
  const g = c.createLinearGradient(0, 0, n, n);
  g.addColorStop(0, a.from);
  g.addColorStop(1, a.to);
  // Shapes are drawn on their own layer (some cut holes), then put on the background.
  const layer = document.createElement('canvas');
  layer.width = layer.height = n;
  const l = layer.getContext('2d');
  l.scale(n / 100, n / 100);
  l.fillStyle = l.strokeStyle = a.ink || '#ffffff';
  a.draw(l, a.to);
  c.fillStyle = g;
  c.fillRect(0, 0, n, n);
  c.drawImage(layer, 0, 0);
}
function renderAvatarTiles() {
  $('sAvatars').replaceChildren(...AVATARS.map((a) => {
    const canvas = el('canvas', { width: 72, height: 72 });
    drawAvatar(canvas, a);
    let clicks = [];
    return el('button', { type: 'button', title: a.name, onclick: () => {
      const big = document.createElement('canvas');
      big.width = big.height = 160;
      drawAvatar(big, a);
      pendingAvatar = big.toDataURL('image/jpeg', 0.9);
      renderAvatarPick();
      if (a.secret) {
        const now = Date.now();
        clicks = [...clicks.filter((t) => now - t < 900), now];
        if (clicks.length >= 3) { clicks = []; unlockSecret(); }
      }
    } }, canvas);
  }));
}

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
      if (m.thumb?.img) {
        thumb = el('img', { src: m.thumb.img, alt: '' });
        if (isVideo && m.thumb.dur) badge = el('span', { class: 'tile-badge', text: fmtTime(m.thumb.dur) });
      } else if (isImg) {
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
