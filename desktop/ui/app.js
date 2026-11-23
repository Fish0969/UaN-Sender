'use strict';

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// A call that may take long (a friend's PC far away): give up after some seconds instead of waiting for ever.
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

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
  voice: '<path d="M4 9v6h4l5 4V5L8 9Z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
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
  chev: '<path d="m9 6 6 6-6 6"/>',
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
function avatar(name, { online = false, group = false, seed, src, mode, uid } = {}) {
  const a = el('div', { class: 'avatar' + (online ? ' online' : '') + (group ? ' group' : '') + (src ? ' has-img' : '') + (mode && mode !== 'online' ? ` mode-${mode}` : '') });
  if (src) a.append(bioMediaNode(src));
  else a.textContent = (name || '?')[0];
  a.style.setProperty('--h', hue(seed || name || '?'));
  if (uid) a.dataset.uid = uid;
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
  // Shown again on top of everything, also above an open dialog.
  try { if (t.matches(':popover-open')) t.hidePopover(); t.showPopover(); } catch {}
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.add('hidden'); try { t.hidePopover(); } catch {} }, 5000);
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
  return `${base}/${file.owner}${file.dev ? `~${file.dev}` : ''}/${file.id}/${file.size}/${encodeURIComponent(file.mime)}`;
}

// Feels like an app, not a web page.
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, .bubble, .code-box')) e.preventDefault();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'F11') { e.preventDefault(); winCtl('fullscreen'); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'k' && S.me?.name) { e.preventDefault(); $('findInput').focus(); $('findInput').select(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'f' && S.me?.name) { e.preventDefault(); openSearch(S.active || ''); return; }
  if (e.key === 'F5' || (e.ctrlKey && ['r', 'p', 'g', 'u'].includes(e.key.toLowerCase()))) e.preventDefault();
  if ($('viewer').classList.contains('hidden')) return;
  if (e.key === 'Escape') closeViewer();
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest?.('#viewer input') && (e.shiftKey || !viewerPlayer)) { e.preventDefault(); e.stopImmediatePropagation(); viewerStep(e.key === 'ArrowLeft' ? -1 : 1); }
});

// ---------- Start ----------
// ---------- Window: UaN's own title bar (Windows), full screen with F11 ----------
function syncWindow(st) {
  if (!st) return;
  document.documentElement.classList.toggle('fullscreen', !!st.fullscreen);
  const max = !!st.maximized;
  $('tbMax').title = max ? 'Restore' : 'Maximize';
  $('tbMax').replaceChildren(svg(max
    ? '<path d="M8.5 8.5V6.6a1.1 1.1 0 0 1 1.1-1.1h7.8a1.1 1.1 0 0 1 1.1 1.1v7.8a1.1 1.1 0 0 1-1.1 1.1h-1.9"/><rect x="5.5" y="8.5" width="10" height="10" rx="1.4"/>'
    : '<rect x="5.5" y="5.5" width="13" height="13" rx="1.5"/>'));
}
const winCtl = (action) => invoke('win_ctl', { action }).then(syncWindow).catch(() => {});
function setupChrome() {
  if (!S.me.customChrome) return;
  document.documentElement.classList.add('chrome');
  $('titlebar').classList.remove('hidden');
  const name = S.me.profileName ? `UaN (${S.me.profileName})` : 'UaN';
  const title = () => { $('tbTitle').textContent = /^\(\d+\)/.test(document.title) ? `${document.title.match(/^\(\d+\)/)[0]} ${name}` : name; };
  title();
  new MutationObserver(title).observe(document.querySelector('title'), { childList: true });
  $('tbDrag').addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.detail === 2) winCtl('toggle_max'); else winCtl('drag');
  });
  $('tbMin').addEventListener('click', () => winCtl('minimize'));
  $('tbMax').addEventListener('click', () => winCtl('toggle_max'));
  $('tbClose').addEventListener('click', () => winCtl('close'));
  let rz;
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => winCtl('state'), 120); });
  winCtl('state');
}
function applySavedZoom() { if (uiZoom !== 1) setZoom(uiZoom, false); }

// The lock screen: shown until the password is right (the core gives nothing out before that).
function waitForUnlock() {
  return new Promise((resolve) => {
    $('lockForm').classList.remove('hidden');
    setTimeout(() => $('lockPw').focus(), 50);
    $('lockForm').onsubmit = async (e) => {
      e.preventDefault();
      const pw = $('lockPw').value;
      if (!pw) return;
      $('lockGo').disabled = true; $('lockErr').textContent = '';
      try { await invoke('unlock', { password: pw }); $('lockPw').value = ''; resolve(); }
      catch (err) { $('lockErr').textContent = String(err); $('lockPw').select(); }
      $('lockGo').disabled = false;
    };
  });
}
async function boot() {
  const lock = await invoke('lock_state').catch(() => ({ locked: false }));
  if (lock.locked) await waitForUnlock();
  S.me = await invoke('state');
  $('lockScreen').remove();
  applyTheme();
  setupChrome();
  applySavedZoom();
  loadCustomThemes();
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
let lastUpdate = null;
let lastUpdateFailed = false;
// The release notes, without GitHub's automatic "Full Changelog" line.
const updateNotes = (u) => String(u?.notes || '').split('\n').filter((l) => !/^\**Full Changelog/i.test(l.trim())).join('\n').trim();
async function showNotes(u) {
  const notes = updateNotes(u);
  if (!notes) return;
  if (await ask('UaN ' + u.version + ': what’s new\n\n' + notes, 'Update now')) installUpdate(u, [$('sUpdNow')]);
}
// One click: downloads the new version and switches over by itself (the buttons are the ones to disable meanwhile).
// Auto update (off unless you turn it on): a new version found when UaN starts is installed straight away.
const autoUpdateOn = () => { try { return localStorage.getItem('uan.autoUpdate') === '1'; } catch { return false; } };
function setAutoUpdate(on) {
  try { localStorage.setItem('uan.autoUpdate', on ? '1' : '0'); } catch {}
  $('sAutoUpd').checked = on;
  $('updAutoBtn')?.classList.toggle('hidden', on);
}
let firstUpdateCheck = true;
async function installUpdate(u, btns, quiet = false) {
  if (!u.url) return quiet ? undefined : toast('No download for this system in that release yet.');
  const size = u.size ? ` (${fmtBytes(u.size)})` : '';
  if (quiet) toast(`Updating to UaN ${u.version} by itself (auto update is on)…`);
  else if (!(await ask(`Update to UaN ${u.version}${size}? It downloads the new version and switches over by itself, nothing to install. UaN restarts in a few seconds.`, 'Update'))) return;
  const labels = btns.map((b) => b.textContent);
  const busy = (on) => btns.forEach((b, i) => { b.disabled = on; b.textContent = on ? 'Downloading…' : labels[i]; });
  busy(true);
  try {
    await invoke('install_update', { url: u.url, name: u.name });
  } catch (err) {
    if (String(err) === 'no-write' && u.installer) {
      try { await invoke('install_update', { url: u.installer, name: u.installerName }); return; } catch (e2) { err = e2; }
    }
    busy(false);
    toast(err);
  }
}
function renderHistory() {
  const c = CHANGELOG.find((x) => x.v === S.me?.version) || CHANGELOG[0];
  $('sHistoryTitle').textContent = `What is new in ${c.v}`;
  $('sHistory').replaceChildren(el('ul', { class: 'hnote' }, ...c.items.map((t) => el('li', { text: t }))));
}
function renderUpdateState() {
  const u = lastUpdate;
  $('sUpdState').textContent = u ? `UaN ${u.version} is available` : lastUpdateFailed ? 'Couldn’t check (no internet, or GitHub didn’t answer). Try again in a moment.' : 'You have the newest version.';
  $('sUpdNow').classList.toggle('hidden', !u);
  $('sNotes').classList.toggle('hidden', !(u && updateNotes(u)));
}
async function checkUpdate() {
  let failed = false;
  const u = await invoke('check_update').catch(() => { failed = true; return null; });
  lastUpdate = u;
  lastUpdateFailed = failed;
  const bar = $('updateBar');
  bar.classList.toggle('hidden', !u);
  if (u) {
    const btn = el('button', { type: 'button', text: 'Update' });
    btn.onclick = () => installUpdate(u, [btn, $('sUpdNow')]);
    const auto = el('button', { type: 'button', class: 'upd-auto' + (autoUpdateOn() ? ' hidden' : ''), id: 'updAutoBtn', title: 'From now on, new versions install by themselves when UaN starts', text: 'Turn on auto update' });
    auto.onclick = () => { setAutoUpdate(true); toast('Auto update is on: new versions install by themselves when UaN starts. (Settings → About & updates)'); installUpdate(u, [btn, $('sUpdNow')], true); };
    bar.replaceChildren(
      el('div', { class: 'upd-ico' }, svg('<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>')),
      el('div', { class: 'upd-text' }, el('b', { text: 'Update available' }), el('span', { text: `UaN ${u.version}` }),
        updateNotes(u) ? el('button', { type: 'button', class: 'link upd-notes', text: 'What’s new', onclick: () => showNotes(u) }) : null),
      el('div', { class: 'upd-btns' }, btn, auto));
    if (firstUpdateCheck && autoUpdateOn()) installUpdate(u, [btn, $('sUpdNow')], true);
  }
  firstUpdateCheck = false;
  renderUpdateState();
  return u;
}
$('sUpdCheck').addEventListener('click', async () => {
  $('sUpdState').textContent = 'Checking…';
  await checkUpdate();
});
$('sUpdNow').addEventListener('click', () => { if (lastUpdate) installUpdate(lastUpdate, [$('sUpdNow')]); });
$('sNotes').addEventListener('click', () => { if (lastUpdate) showNotes(lastUpdate); });

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
  if (S.me.selftestAssist) {
    let stage = 'start';
    const dog = setTimeout(() => report(false, 'watchdog: stuck at stage ' + stage), 100000);
    try {
    const v = el('video', { src: mediaUrl(file) });
    document.body.append(v);
    v.play().catch(() => {});
    const t0 = Date.now();
    const wait = async (cond, ms) => { while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
    if (!(await wait(() => v.currentTime > 2, 40000))) return report(false, 'picture did not play: t=' + v.currentTime + ' err=' + v.error?.code);
    const tracks = await withTimeout(invoke('media_tracks', { file }), 8000).catch((e) => String(e));
    stage = 'assist start';
    const started = await startAudioAssist(v, file, () => {});
    stage = 'assist started';
    if (!started) return report(false, 'the sound helper did not start (VLC missing?)');
    const a = v._assist?.audio;
    stage = 'waiting for the sound';
    const playing = await wait(() => a && !a.paused && a.currentTime > 1.5, 60000);
    stage = 'sound playing';
    if (!playing) return report(false, 'sound did not play: ready=' + v._assist?.ready + ' paused=' + a?.paused + ' t=' + a?.currentTime + ' err=' + a?.error?.code + ' picture=' + v.currentTime.toFixed(1));
    const drift1 = v.currentTime - (v._assist.startAt + a.currentTime);
    v.currentTime = Math.min(v.currentTime + 6, (v.duration || 100) - 3); // jump ahead: the sound must follow
    await new Promise((r) => setTimeout(r, 1000));
    const back = await wait(() => a && !a.paused && !v.paused && Math.abs(v.currentTime - (v._assist.startAt + a.currentTime)) < 0.8, 60000);
    const drift2 = v.currentTime - (v._assist.startAt + a.currentTime);
    stage = 'done';
    v._assist.stop();
    clearTimeout(dog);
    return report(back && Math.abs(drift1) < 0.8, 'quiet sound OK (sound tracks listed: ' + (Array.isArray(tracks) ? tracks.map((t) => t.codec + '/' + t.lang).join(',') : tracks) + '): drift ' + drift1.toFixed(2) + 's, after the jump ' + drift2.toFixed(2) + 's, picture at ' + v.currentTime.toFixed(1) + 's');
    } catch (e) { clearTimeout(dog); return report(false, 'exception at stage ' + stage + ': ' + (e && e.stack || e)); }
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
  $('meName').onclick = () => openProfile(S.me.id);
  $('meName').title = 'See your profile as others see it';
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
// Showing the code takes two presses: the first asks "Are you sure?" (it may be seen, e.g. while you stream your screen).
let codeAsk = null;
$('showCode').addEventListener('click', () => {
  const hidden = $('codeText').classList.contains('hidden');
  if (!hidden) { toggleCode(false); return; }
  if (!codeAsk) {
    $('showCode').textContent = 'Are you sure?';
    $('showCode').classList.add('confirm');
    codeAsk = setTimeout(() => { codeAsk = null; $('showCode').classList.remove('confirm'); $('showCode').textContent = 'Show friend code'; }, 3500);
    return;
  }
  clearTimeout(codeAsk); codeAsk = null;
  $('showCode').classList.remove('confirm');
  toggleCode(true);
});
$('sNewCode').addEventListener('click', async () => {
  if (!(await ask('Make a new friend code? Your current code stops working: people who have it can’t add you with it any more. Your friends stay your friends.', 'Make a new one'))) return;
  try {
    const code = await invoke('new_friend_code');
    S.me.code = code;
    $('codeText').textContent = code;
    toast('Done. Your new friend code is ready: Copy friend code copies it.');
  } catch (e) { toast(e); }
});

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

// A list row: name and time on top, a short line and the unread count below.
function rowText(name, sub, ts, ...extra) {
  return el('div', { class: 'grow row-text' },
    el('div', { class: 'row-top' }, el('span', { class: 'name ellipsis', text: name }), ts ? el('span', { class: 'when', text: whenFmt(ts) }) : null),
    el('div', { class: 'row-bot' }, el('span', { class: 'sub ellipsis', text: sub || '' }), ...extra));
}
const weekdayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const shortDayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
function whenFmt(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
  const days = (new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5;
  if (days === 1) return 'Yesterday';
  if (days < 7) return weekdayFmt.format(d);
  return shortDayFmt.format(d);
}

function renderLists() {
  const byRecent = (a, b) => (b.lastAt || 0) - (a.lastAt || 0) || a.name.localeCompare(b.name);
  const badge = (chat) => {
    const n = S.unread.get(chat) || 0;
    return n ? el('span', { class: 'badge', text: n > 99 ? '99+' : String(n) }) : null;
  };

  const pins = pinned();
  const pinFirst = (kind) => (a, b) => (pins[kind].includes(b.id) - pins[kind].includes(a.id)) || (pins[kind].indexOf(a.id) - pins[kind].indexOf(b.id)) || byRecent(a, b);
  const pinMark = (kind, id) => (pins[kind].includes(id) ? el('span', { class: 'pin-dot', title: 'Pinned to the top' }, svg(ICON.pin)) : null);
  const found = (arr) => (findQ ? arr.filter((x) => matchScore(x.name, findQ) > 0) : arr);
  $('groupList').replaceChildren(...found([...S.groups]).sort(pinFirst('g')).map((g) => {
    const n = unreadIn(g.id);
    const online = g.members.filter((m) => m.online || m.id === S.me.id).length;
    return el('li', { class: 'friend' + (groupIdOf(S.active) === g.id ? ' active' : '') + (n ? ' has-unread' : ''), onclick: () => openGroup(g.id), oncontextmenu: (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, groupMenu(g)); } },
      avatar(g.name, { group: true, seed: g.id, src: g.avatar }),
      rowText(g.name, `${g.members.length} members · ${online} online`, g.lastAt,
        pinMark('g', g.id),
        S.mutes.has(`g:${g.id}`) ? svg(ICON.mute) : null,
        n ? el('span', { class: 'badge', text: n > 99 ? '99+' : String(n) }) : null));
  }));
  $('noGroups').classList.toggle('hidden', S.groups.length > 0);

  $('friendList').replaceChildren(...found([...S.friends]).sort(pinFirst('f')).map((f) => el('li', {
    class: 'friend' + (S.active === f.id ? ' active' : '') + (S.unread.get(f.id) ? ' has-unread' : ''), onclick: () => openChat(f.id),
    oncontextmenu: (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, friendMenu(f)); },
    title: f.status || '',
  }, avatar(f.name, { online: f.online, seed: f.id, src: f.avatar, mode: f.mode }),
  rowText(f.name, f.status || (watchInfo(f.watching) ? '🎬 ' + watchInfo(f.watching).film : '') || (f.online ? (f.mode === 'away' ? 'Away' : f.mode === 'dnd' ? 'Do not disturb' : 'Online') : 'Offline'), f.lastAt,
    pinMark('f', f.id),
    S.mutes.has(f.id) ? svg(ICON.mute) : null,
    badge(f.id)))));
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
  if (ch.voice) return voiceChannelItem(g, ch, tag);
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
// A voice channel: a speaker icon, who is in it now, and a click to join (or leave).
function voiceChannelItem(g, ch, tag) {
  const people = (S.voiceRooms?.[ch.chat] || []);
  const here = VC.chat === ch.chat;
  const menu = (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, channelMenu(g, ch)); };
  const click = () => (here ? voiceLeave() : voiceJoin(ch.chat));
  const title = here ? 'You are in it: click to leave' : people.length ? 'Join: ' + people.map((p) => p.name).join(', ') : 'Join this voice channel';
  if (tag === 'tab') {
    return el('button', { type: 'button', class: 'voice-tab' + (here ? ' on in-voice' : ''), onclick: click, oncontextmenu: menu, title },
      svg(ICON.voice), ch.name,
      people.length ? el('span', { class: 'voice-heads' }, ...people.slice(0, 4).map((p) => avatar(p.name, { seed: p.id, src: p.id === S.me.id ? S.me.profile?.avatar : (g.members.find((m) => m.id === p.id)?.avatar) })),
        people.length > 4 ? el('span', { class: 'more', text: '+' + (people.length - 4) }) : null) : null);
  }
  return el('li', { class: 'friend voice-chan' + (here ? ' active in-voice' : ''), onclick: click, oncontextmenu: menu, title },
    el('div', { class: 'voice-row' }, svg(ICON.voice), el('span', { class: 'grow ellipsis', text: ch.name })),
    people.length ? el('div', { class: 'voice-people' }, ...people.map((p) => el('div', { class: 'voice-person' },
      avatar(p.name, { seed: p.id, src: p.id === S.me.id ? S.me.profile?.avatar : (g.members.find((m) => m.id === p.id)?.avatar), uid: p.id }), el('span', { class: 'ellipsis', text: p.id === S.me.id ? p.name + ' (you)' : p.name })))) : null);
}
function renderChannels() {
  // New layout: the side column shows the open group's channels and members.
  const g = groupById(S.view);
  if (g) {
    $('sideGroupText').textContent = g.name;
    $('chanList').replaceChildren(...channelsOf(g).map((ch) => channelItem(g, ch)));
    $('memberList').replaceChildren(...g.members.map((m) => el('li', {},
      avatar(m.name, { online: m.online, seed: m.id, src: m.id === S.me.id ? S.me.profile?.avatar : m.avatar, uid: m.id }),
      el('span', { class: 'grow ellipsis', text: m.id === S.me.id ? `${m.name} (you)` : m.name }))));
  }
  $('addChanBtn').classList.toggle('hidden', !isManager(groupById(S.view)));
  // Legacy layout: tabs above the messages.
  const ag = groupOf(S.active);
  const tabs = !document.body.classList.contains('modern') && ag;
  $('chanTabs').classList.toggle('hidden', !tabs);
  if (tabs) {
    $('chanTabs').replaceChildren(...channelsOf(ag).map((ch) => channelItem(ag, ch, 'tab')),
      isManager(ag) ? el('button', { type: 'button', title: 'Create a channel', onclick: () => openChanDlg(ag) }, svg('<path d="M12 5v14M5 12h14"/>')) : '');
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
  if (!isManager(g)) { toast('Only the group’s owner and co-owners can make channels.'); return; }
  chanDlgGroup = g;
  $('chanName').value = '';
  $('chanPw').value = '';
  $('chanLock').checked = false;
  $('chanVoice').checked = false;
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
    const voice = $('chanVoice').checked;
    const chat = await invoke('create_channel', { group: chanDlgGroup.id, name: $('chanName').value, password: voice ? null : pw, voice });
    $('chanDlg').close();
    await loadContacts();
    if (!voice && chatInfo(chat)) openChat(chat);
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
// Locked channels ask for their password every time you open them: leaving one forgets its key.
function relock(chat) {
  const ch = chat && channelOf(chat);
  if (!ch || !ch.locked || !ch.unlocked) return;
  ch.unlocked = false;
  invoke('forget_channel', { chat }).catch(() => {});
}
S.drafts = new Map();
async function openChat(chat, focusId) {
  if (S.active !== chat) {
    if (S.active) S.drafts.set(S.active, $('msgInput').value);
    cancelReply();
    relock(S.active);
    stopInlineAudio();
  }
  const switched = S.active !== chat;
  S.active = chat;
  if (switched) { $('msgInput').value = S.drafts.get(chat) || ''; renderMentions(); }
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
  await loadReactions(chat);
  try { S.reads.set(chat, await invoke('reads', { chat })); } catch {}
  try { if (S.active === chat) renderPins(await invoke('pins', { chat })); } catch {}
  if (S.active !== chat) return;
  renderMessages();
  renderTyping();
  markRead();
  if (focusId) {
    const node = document.querySelector(`#msgs .print[data-id="${CSS.escape(focusId)}"]`) || msgNode(focusId);
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
  relock(S.active);
  S.active = null;
  $('main').classList.remove('in-chat');
  $('chat').classList.add('hidden');
  $('empty').classList.remove('hidden');
}

function renderChatHead() {
  const info = S.active && chatInfo(S.active);
  if (!info) return;
  $('chatName').textContent = info.group ? `# ${info.channelName}` : info.name;
  $('callBtn').classList.toggle('hidden', !!info.group);
  $('callBtn').classList.toggle('on', VC.chat === S.active);
  if (info.group) {
    // You count too: "2 online" means you and one other.
    const on = info.group.members.filter((m) => m.online || m.id === S.me.id);
    const heads = onlineHeads() ? el('span', { class: 'online-heads', title: on.map((m) => (m.id === S.me.id ? 'You' : m.name)).join(', ') },
      on.slice(0, 10).map((m) => avatar(m.name, { seed: m.id, src: m.id === S.me.id ? S.me.profile?.avatar : m.avatar })),
      on.length > 10 ? el('span', { class: 'more', text: `+${on.length - 10}` }) : null) : null;
    $('chatStatus').replaceChildren(`${info.name} · ${info.group.members.length} members · ${on.length} online`, heads || '');
    $('chatStatus').title = '';
    setAvatar($('chatAvatar'), info.name, { group: true, seed: info.group.id, src: info.group.avatar });
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

// Messages are shown in blocks: a single message, a contact sheet (photos and videos sent together)
// or a folder (all files of a folder that was sent). A run is the same person writing within a few minutes.
const RUN_GAP = 7 * 60 * 1000;
const SHEET_GAP = 2 * 60 * 1000;
const folderOf = (m) => (m.file && !m.locked && /[\\/]/.test(m.file.name) ? m.file.name.split(/[\\/]/)[0] : null);
const isMediaOnly = (m) => !!(m.file && !m.text && !m.reply && !m.locked && !folderOf(m)
  && (IMAGE.test(m.file.mime) || /^video\//i.test(m.file.mime))
  && (m.thumb?.img || (IMAGE.test(m.file.mime) && m.file.size <= INLINE_IMAGE_LIMIT)));
function blocksOf(list) {
  const out = [];
  for (const m of list) {
    const b = out[out.length - 1];
    const last = b && b.items[b.items.length - 1];
    const same = last && last.sender === m.sender && dayFmt.format(last.ts) === dayFmt.format(m.ts);
    const f = folderOf(m);
    if (f && same && b.kind === 'folder' && b.folder === f && m.ts - last.ts < 30 * 60 * 1000) { b.items.push(m); continue; }
    if (!f && same && isMediaOnly(m) && isMediaOnly(last) && b.kind !== 'folder' && m.ts - last.ts < SHEET_GAP) { b.kind = 'sheet'; b.items.push(m); continue; }
    out.push({ kind: f ? 'folder' : 'one', folder: f, items: [m] });
  }
  return out;
}
function renderMessages(keepPlace = false) {
  $('pollBtn').classList.toggle('hidden', !groupOf(S.active));
  const box = $('msgs');
  const top = box.scrollTop;
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const list = S.msgs.get(S.active) || [];
  const nodes = [];
  let lastDay = '';
  let prev = null;
  for (const b of blocksOf(list)) {
    const m = b.items[0];
    const day = dayFmt.format(m.ts);
    if (day !== lastDay) { nodes.push(el('div', { class: 'day', text: day })); lastDay = day; prev = null; }
    const run = !prev || prev.sender !== m.sender || m.ts - prev.ts > RUN_GAP;
    nodes.push(b.kind === 'one' ? messageNode(m, run) : messageNode(b.items[b.items.length - 1], run, b));
    prev = b.items[b.items.length - 1];
  }
  // Within a run, only the last message shows its time (the others on hover).
  nodes.forEach((n, i) => {
    const next = nodes[i + 1];
    if (n.classList.contains('msg') && next?.classList.contains('msg') && !next.classList.contains('run')) n.classList.add('cont');
  });
  if (!list.length) nodes.push(emptyChatNode());
  box.replaceChildren(...nodes);
  box.scrollTop = keepPlace && !near ? top : box.scrollHeight;
}
const msgNode = (id) => document.querySelector(`#msgs .msg[data-ids~="${CSS.escape(id)}"]`);
function emptyChatNode() {
  const info = chatInfo(S.active);
  const phone = document.documentElement.classList.contains('phone');
  const where = info?.group ? `in #${info.channelName}` : `with ${info?.name || 'them'}`;
  return el('div', { class: 'chat-empty', text: `No messages ${where} yet. Write something, or ${phone ? 'send a photo' : 'drop a file here'}.` });
}
// Reply, edit, pin, copy and delete: right-click on PC, press and hold on the phone.
function msgMenu(m, items) {
  const many = items.length > 1;
  return [
    m.locked ? null : { label: 'Reply', run: () => startReply(m) },
    !many && m.mine && m.text && !m.locked ? { label: 'Edit', run: () => startEdit(m) } : null,
    !many && !m.locked ? { label: m.pinned ? 'Unpin' : 'Pin', run: () => togglePin(m) } : null,
    m.text && !m.locked ? { label: 'Copy text', run: () => navigator.clipboard.writeText(m.text).then(() => toast('Copied.')).catch(() => {}) } : null,
    !many && themeable(m.file) ? { label: 'Use as theme', run: () => useAsTheme(m.file) } : null,
    '-',
    { label: many ? 'Delete these…' : 'Delete…', danger: true, run: () => deleteMessage(many ? items : m) },
  ];
}
let ctxTarget = null; // the message whose menu is open (Shift+Delete deletes it right away)
function attachMenu(node, m, items) {
  const open = (x, y, target) => {
    const print = target.closest?.('.print');
    const pm = print && items.find((i) => i.id === print.dataset.id);
    ctxTarget = pm ? { m: pm, items: [pm] } : { m, items };
    showMenu(x, y, pm ? printMenu(pm) : msgMenu(m, items));
  };
  node.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.bubble') && getSelection().toString()) return; // copying selected text
    e.preventDefault();
    open(e.clientX, e.clientY, e.target);
  });
  let timer = null;
  node.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; navigator.vibrate?.(15); open(t.clientX, t.clientY, e.target); }, 450);
  }, { passive: true });
  const cancel = () => { clearTimeout(timer); timer = null; };
  node.addEventListener('touchmove', cancel, { passive: true });
  node.addEventListener('touchend', cancel);
  node.addEventListener('touchcancel', cancel);
}

// **bold**, *italic*, ~~strike~~, `code`, and @mentions; everything else stays plain text.
function formatText(text) {
  const frag = document.createDocumentFragment();
  const re = /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|\*[^*\s][^*\n]*?\*|~~[^~\n]+?~~|`[^`\n]+?`|@[\p{L}\p{N}_.-]+)/gu;
  let last = 0;
  for (const mt of text.matchAll(re)) {
    if (mt.index > last) frag.append(text.slice(last, mt.index));
    const t = mt[0];
    if (t.startsWith('**')) frag.append(el('b', { text: t.slice(2, -2) }));
    else if (t.startsWith('__')) frag.append(el('u', { text: t.slice(2, -2) }));
    else if (t.startsWith('~~')) frag.append(el('s', { text: t.slice(2, -2) }));
    else if (t.startsWith('`')) frag.append(el('code', { text: t.slice(1, -1) }));
    else if (t.startsWith('*')) frag.append(el('i', { text: t.slice(1, -1) }));
    else frag.append(el('span', { class: 'mention', text: t }));
    last = mt.index + t.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}
// A message that tags you or @everyone (whoever wrote it, you too) stands out in the theme's opposite colour;
// one that tags only someone else is a slightly different shade of its usual bubble.
function pingClass(m) {
  if (!m.text || m.locked) return '';
  if (mentionsMe(m.text)) return ' mentions-me';
  return /(^|[^\p{L}\p{N}])@[\p{L}\p{N}_.-]+/u.test(m.text) ? ' pings-out' : '';
}
function mentionsMe(text) {
  if (!text || !S.me?.name) return false;
  if (/(^|[^\p{L}\p{N}])@everyone(?![\p{L}\p{N}])/iu.test(text)) return true;
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

function senderOf(m) {
  const g = groupOf(m.chat);
  const p = (g && g.members.find((x) => x.id === m.sender)) || friendById(m.sender);
  return { name: m.senderName || p?.name || '?', src: p?.avatar, look: p?.look };
}
// ---------- Reactions: one emoji per person per message ----------
S.reacts = new Map(); // message id -> Map(person id -> emoji)
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
function setReaction(id, by, emoji) {
  let m = S.reacts.get(id);
  if (!m) S.reacts.set(id, (m = new Map()));
  if (emoji) m.set(by, emoji); else m.delete(by);
}
async function loadReactions(chat) {
  try { for (const r of await invoke('reactions', { chat })) setReaction(r.id, r.by, r.emoji); } catch {}
}
listen('reaction', ({ payload: p }) => {
  setReaction(p.id, p.by, p.emoji);
  if (p.chat === S.active) renderMessages(true);
});
const whoIs = (id) => (id === S.me.id ? 'You' : friendById(id)?.name || S.groups.flatMap((g) => g.members).find((x) => x.id === id)?.name || 'Someone');
const reactTo = (m, emoji) => invoke('react', { chat: m.chat, id: m.id, emoji }).catch(toast);
function reactsNode(m) {
  const mp = S.reacts.get(m.id);
  if (!mp || !mp.size) return null;
  const groups = new Map();
  for (const [by, e] of mp) { if (e.startsWith('poll:')) continue; if (!groups.has(e)) groups.set(e, []); groups.get(e).push(by); }
  if (!groups.size) return null;
  return el('div', { class: 'reacts' }, ...[...groups].map(([e, users]) => {
    const mine = users.includes(S.me.id);
    return el('button', { type: 'button', class: 'react-chip' + (mine ? ' mine' : ''), title: users.map(whoIs).join(', '), onclick: () => reactTo(m, mine ? '' : e) }, e, el('span', { text: String(users.length) }));
  }));
}
function reactPicker(btn, m) {
  document.querySelector('.react-pop')?.remove();
  const mine = S.reacts.get(m.id)?.get(S.me.id);
  const pop = el('div', { class: 'react-pop' }, REACTIONS.map((e) => el('button', { type: 'button', class: e === mine ? 'on' : '', title: e === mine ? 'Take it back' : e,
    onclick: () => { pop.remove(); reactTo(m, e === mine ? '' : e); } }, e)));
  document.body.append(pop);
  const r = btn.getBoundingClientRect();
  const w = pop.getBoundingClientRect().width;
  pop.style.left = Math.max(6, Math.min(innerWidth - w - 6, r.left + r.width / 2 - w / 2)) + 'px';
  pop.style.top = Math.max(6, r.top - 46) + 'px';
  const close = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
}

// A poll is a message like "📊 Question" + lines "• option" (readable in older UaN too).
function parsePoll(text) {
  if (!text || !text.startsWith('📊 ')) return null;
  const lines = text.split('\n');
  const q = lines[0].slice(3).trim();
  const opts = lines.slice(1).filter((l) => l.startsWith('• ')).map((l) => l.slice(2).trim());
  if (!q || opts.length < 2 || opts.length > 10 || opts.length !== lines.length - 1) return null;
  return { q, opts };
}
function pollNode(m, poll) {
  const votes = [...(S.reacts.get(m.id) || new Map())].filter(([, e]) => e.startsWith('poll:')).map(([by, e]) => [by, Number(e.slice(5))]).filter(([, i]) => i >= 0 && i < poll.opts.length);
  const total = votes.length;
  const mine = votes.find(([by]) => by === S.me.id)?.[1];
  return el('div', { class: 'poll' },
    el('div', { class: 'poll-head' }, svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'), 'Poll'),
    el('div', { class: 'poll-q', text: poll.q }),
    ...poll.opts.map((o, i) => {
      const who = votes.filter(([, v]) => v === i).map(([by]) => by);
      const pct = total ? Math.round((who.length / total) * 100) : 0;
      const bar = el('span', { class: 'poll-bar' });
      bar.style.width = pct + '%';
      return el('button', { type: 'button', class: 'poll-opt' + (mine === i ? ' mine' : ''), title: who.length ? who.map(whoIs).join(', ') : 'No votes yet',
        onclick: () => reactTo(m, mine === i ? '' : 'poll:' + i) },
      bar, el('span', { class: 'poll-txt', text: o }), el('span', { class: 'poll-n', text: who.length ? pct + '% · ' + who.length : '' }));
    }),
    el('div', { class: 'poll-foot', text: total + (total === 1 ? ' vote' : ' votes') + ' · click to vote, click again to take it back' }));
}
function messageNode(m, run = true, block = null) {
  const items = block ? block.items : [m];
  const group = isGroup(m.chat);
  const quote = !block && m.reply ? el('button', { type: 'button', class: 'quote', title: 'Show the message', onclick: () => jumpTo(m.reply.id) },
    el('b', { text: m.reply.name }), m.reply.text || '') : null;
  const bubble = block ? null : m.locked ? el('div', { class: 'bubble locked-msg', text: 'Locked message. Unlock the channel to read it.' })
    : m.text ? (parsePoll(m.text) ? pollNode(m, parsePoll(m.text)) : el('div', { class: 'bubble' }, formatText(m.text))) : null;
  const content = block ? (block.kind === 'sheet' ? sheetNode(block) : folderCard(block))
    : m.file ? fileCard(m.file, m.chat, m.thumb) : null;
  const acts = m.locked ? [] : [
    el('button', { type: 'button', class: 'msg-act', title: 'Reply', onclick: () => startReply(m) }, svg(ICON.reply)),
    !block ? el('button', { type: 'button', class: 'msg-act', title: 'React', onclick: (e) => reactPicker(e.currentTarget, m) }, svg('<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5v.5M15 9.5v.5"/>')) : null,
    !block && m.mine && m.text ? el('button', { type: 'button', class: 'msg-act', title: 'Edit', onclick: () => startEdit(m) }, svg(ICON.edit)) : null,
    !block ? el('button', { type: 'button', class: 'msg-act', title: m.pinned ? 'Unpin' : 'Pin to the top of the chat', onclick: () => togglePin(m) }, svg(ICON.pin)) : null,
  ];
  const del = el('button', { type: 'button', class: 'msg-del', title: block ? 'Delete these messages' : 'Delete message', onclick: () => deleteMessage(block ? items : m) }, svg(ICON.x));
  const time = el('span', { class: 'time', text: timeFmt.format(m.ts), title: `${dayFmt.format(m.ts)} ${timeFmt.format(m.ts)}` });
  const edited = m.edited ? el('span', { class: 'edited', text: 'edited' }) : null;
  const pin = items.some((x) => x.pinned) ? el('span', { class: 'pin-mark', title: 'Pinned' }, svg(ICON.pin)) : null;
  const seen = seenRow(m.chat, items.map((x) => x.id));
  // Seen heads always sit right before the time; the actions are on the outer side.
  const meta = el('div', { class: 'meta' + (edited || pin ? ' keep-fixed' : '') + (seen ? ' keep-seen' : '') }, m.mine ? [del, ...acts, pin, edited, seen, time] : [seen, time, edited, pin, ...acts, del]);
  const theirsInGroup = group && !m.mine;
  const body = [theirsInGroup && run ? el('div', { class: 'sender', text: m.senderName, 'data-uid': m.sender, style: lookColour(senderOf(m).look) ? 'color:' + lookColour(senderOf(m).look) : null }) : null, quote, content, bubble, block ? null : reactsNode(m), meta];
  const cls = 'msg ' + (m.mine ? 'mine' : 'theirs') + (theirsInGroup ? ' g' : '') + (run ? ' run' : '')
    + pingClass(m) + (block ? ` block-${block.kind}` : '');
  const attrs = { class: cls, 'data-id': m.id, 'data-ids': items.map((x) => x.id).join(' ') };
  let node;
  if (!theirsInGroup) node = el('div', attrs, body);
  else {
    const who = senderOf(m);
    node = el('div', attrs,
      run ? avatar(who.name, { seed: m.sender, src: who.src, uid: m.sender }) : el('span', { class: 'av-gap' }),
      el('div', { class: 'msg-body' }, body));
  }
  attachMenu(node, m, items);
  return node;
}

function sheetNode(b) {
  const n = b.items.length;
  const set = b.items.map((x) => x.file);
  const sheet = el('div', { class: `sheet n${n}` }, b.items.map((m) => printNode(m, set)));
  sheet.style.setProperty('--cols', n <= 4 ? 2 : 3);
  return sheet;
}
function printNode(m, set) {
  const f = m.file;
  const video = /^video\//i.test(f.mime);
  const pic = el('img', { src: m.thumb?.img || mediaUrl(f), alt: '', loading: 'lazy', onload: keepBottom });
  if (m.thumb?.img) animateGif(pic, f, m.thumb);
  return el('button', { type: 'button', class: 'print', 'data-id': m.id, title: f.name, onclick: () => openViewer(f, { list: set }) },
  pic,
  isGif(f.mime) ? el('span', { class: 'gif-badge', text: '.gif' }) : null,
  video ? el('span', { class: 'play-badge' }, svg(ICON.bigplay)) : null,
  video && m.thumb?.dur ? el('span', { class: 'dur', text: fmtTime(m.thumb.dur) }) : null);
}
function printMenu(m) {
  const t = downloadOf(m.file.id);
  return [
    { label: /^video\//i.test(m.file.mime) ? 'Play' : 'Open', run: () => openViewer(m.file) },
    m.file.owner !== S.me.id ? (t?.status === 'done'
      ? { label: 'Open the downloaded file', run: () => invoke('transfer_action', { id: t.id, action: 'open' }).catch(toast) }
      : { label: 'Download', run: () => startDownload(m.file, m.chat) }) : null,
    isGroup(m.chat) && /^video\//i.test(m.file.mime) ? { label: 'Watch together', run: () => openPartySetup(m.file, groupIdOf(m.chat)) } : null,
    themeable(m.file) ? { label: 'Use as theme', run: () => useAsTheme(m.file) } : null,
    '-',
    { label: 'Reply', run: () => startReply(m) },
    { label: m.pinned ? 'Unpin' : 'Pin', run: () => togglePin(m) },
    { label: 'Delete…', danger: true, run: () => deleteMessage(m) },
  ];
}

// ---------- Folders: one card in the chat, the contents in a panel ----------
function folderCard(b) {
  const files = b.items.map((x) => x.file);
  const size = files.reduce((a, f) => a + f.size, 0);
  const tm = transferIndex();
  const done = files.filter((f) => tm.get(f.id)?.status === 'done').length;
  const mine = b.items[0].mine;
  const got = !mine && done ? ` · ${done === files.length ? 'downloaded' : `${done} downloaded`}` : '';
  return el('button', { type: 'button', class: 'folder-card', title: 'Show what is in this folder', onclick: () => openFolder(b) },
    el('span', { class: 'folder-ico' }, svg(ICON.folder)),
    el('span', { class: 'grow' },
      el('div', { class: 'file-name', text: b.folder }),
      el('div', { class: 'sub', text: `${files.length} ${files.length === 1 ? 'file' : 'files'} · ${fmtBytes(size)}${got}` })),
    el('span', { class: 'chev' }, svg(ICON.chev)));
}
let folderOpen = null;
// A folder can hold tens of thousands of files (an 800 GB one froze the app): rows are drawn a page at a time,
// the ticks live in a Set instead of in the page, and transfers are looked up in one pass, not once per row.
const folderCollator = new Intl.Collator(undefined, { numeric: true });
const FOLDER_PAGE = 150;
let folderRows = [];            // the folder's files, sorted (done once when it is opened)
let folderShown = 0;            // how many rows are drawn
let folderSel = new Set();      // ticked file ids
let folderSizes = new Map();    // file id -> size
let folderTotal = 0;
let folderLast = -1;
let folderMore = null;          // watches the "Show more" button so it loads by itself when you scroll down
let folderTimer = null;

function transferIndex() {
  const m = new Map();
  for (const t of S.transfers) m.set(t.file.id, t); // the latest one of a file wins
  return m;
}
function openFolder(b, sel = null) {
  folderOpen = b;
  folderLast = -1;
  const mine = b.items[0].mine;
  $('folderName').textContent = b.folder;
  for (const id of ['folderAllRow', 'folderDlSel', 'folderDlAll']) $(id).classList.toggle('hidden', mine);
  folderRows = [...b.items].sort((x, y) => folderCollator.compare(x.file.name, y.file.name));
  folderSizes = new Map(folderRows.map((x) => [x.file.id, x.file.size]));
  folderTotal = folderRows.reduce((a, x) => a + x.file.size, 0);
  if (sel) {
    // Back from a picture or film: the ticks are as you left them.
    folderSel = new Set(sel);
  } else {
    const tm = transferIndex();
    folderSel = new Set(folderRows.filter((x) => !tm.has(x.file.id)).map((x) => x.file.id));
  }
  folderShown = Math.min(FOLDER_PAGE, folderRows.length);
  $('folderList').scrollTop = 0;
  renderFolder();
  $('folderDlg').showModal();
}
// Opens a picture, film or song of the folder in the big viewer; the arrows go through the folder's
// other ones, and closing it comes back to the folder.
function openFromFolder(f) {
  const b = folderOpen;
  if (!b) return;
  const list = folderRows.map((x) => x.file).filter((x) => IMAGE.test(x.mime) || PLAYABLE.test(x.mime));
  const sel = new Set(folderSel);
  $('folderDlg').close();
  openViewer(f, { list, chat: b.items[0].chat, back: () => openFolder(b, sel) });
}
function syncFolderBoxes() {
  for (const i of $('folderList').querySelectorAll('input')) i.checked = folderSel.has(i.value);
}
function folderRow(x, i, tm, mine) {
  const f = x.file;
  const stop = (fn) => (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
  const rel = f.name.split(/[\\/]/).slice(1);
  const leaf = rel.pop() || f.name;
  const media = IMAGE.test(f.mime) || /^video\//i.test(f.mime);
  const playable = media || PLAYABLE.test(f.mime);
  const src = x.thumb?.img || (IMAGE.test(f.mime) && f.size <= INLINE_IMAGE_LIMIT ? mediaUrl(f) : null);
  const ext = (leaf.includes('.') ? leaf.split('.').pop() : 'file').slice(0, 4);
  const thumb = el(playable ? 'button' : 'span', playable ? { type: 'button', class: 'f-thumb', title: 'Open', onclick: stop(() => openFromFolder(f)) } : { class: 'f-thumb' },
    src ? el('img', { src, alt: '', loading: 'lazy', decoding: 'async', onerror: (e) => e.target.remove() }) : f.mime.startsWith('video/') ? null : el('span', { class: 'ext', text: ext }),
    /^video\//i.test(f.mime) ? el('span', { class: 'f-play' }, svg(ICON.bigplay)) : null);
  const t = tm.get(f.id);
  let act;
  if (mine) act = playable ? el('button', { type: 'button', class: 'small', text: /^(video|audio)\//i.test(f.mime) ? 'Play' : 'Open', onclick: stop(() => openFromFolder(f)) }) : el('span', { class: 'f-state', text: 'Sent' });
  else if (t?.status === 'done') act = el('button', { type: 'button', class: 'small', text: 'Open', title: 'Open the downloaded file', onclick: stop(() => invoke('transfer_action', { id: t.id, action: 'open' }).catch(toast)) });
  else if (t?.status === 'running') act = el('span', { class: 'f-state', text: `${Math.floor((t.done / Math.max(t.size, 1)) * 100)}%` });
  else act = el('button', { type: 'button', class: 'small', text: t?.status === 'error' ? 'Retry' : t?.status === 'paused' ? 'Resume' : 'Download', onclick: stop(() => startDownload(f, x.chat)) });
  const box = el('input', { type: 'checkbox', value: f.id,
    onclick: (e) => {
      // Shift-click selects everything between the last click and this one.
      if (e.shiftKey && folderLast >= 0) {
        const [a, z] = [Math.min(folderLast, i), Math.max(folderLast, i)];
        for (let k = a; k <= z; k++) {
          const id = folderRows[k].file.id;
          if (e.target.checked) folderSel.add(id); else folderSel.delete(id);
        }
        syncFolderBoxes();
      } else if (e.target.checked) {
        folderSel.add(f.id);
      } else {
        folderSel.delete(f.id);
      }
      folderLast = i;
      folderSelInfo();
    } });
  box.checked = folderSel.has(f.id);
  if (mine) box.classList.add('hidden');
  return el('label', { class: 'f-row' + (mine ? ' mine' : ''), title: f.name },
    box,
    thumb,
    el('span', { class: 'f-text' },
      el('span', { class: 'f-path' }, rel.length ? el('span', { class: 'dir', text: rel.join('/') + '/' }) : null, leaf),
      el('span', { class: 'f-size', text: fmtBytes(f.size) })),
    act);
}
function moreButton() {
  const left = folderRows.length - folderShown;
  const btn = el('button', { type: 'button', class: 'f-more', text: `Show more (${left} more ${left === 1 ? 'file' : 'files'})`, onclick: showMoreFolder });
  folderMore?.disconnect();
  if (typeof IntersectionObserver === 'function') {
    folderMore = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) showMoreFolder(); }, { root: $('folderList'), rootMargin: '200px' });
    folderMore.observe(btn);
  }
  return btn;
}
function showMoreFolder() {
  if (!folderOpen || folderShown >= folderRows.length) return;
  const list = $('folderList');
  list.querySelector('.f-more')?.remove();
  const mine = folderOpen.items[0].mine;
  const tm = transferIndex();
  const end = Math.min(folderRows.length, folderShown + FOLDER_PAGE * 2);
  const rows = [];
  for (let i = folderShown; i < end; i++) rows.push(folderRow(folderRows[i], i, tm, mine));
  folderShown = end;
  if (folderShown < folderRows.length) rows.push(moreButton());
  list.append(...rows);
}
function renderFolder() {
  const b = folderOpen;
  if (!b) return;
  const mine = b.items[0].mine;
  const tm = transferIndex();
  const n = folderRows.length;
  $('folderInfo').textContent = `${n} ${n === 1 ? 'file' : 'files'} · ${fmtBytes(folderTotal)} · ${mine ? 'you sent this folder' : `from ${b.items[0].senderName}`}`;
  const top = $('folderList').scrollTop;
  const rows = [];
  for (let i = 0; i < folderShown; i++) rows.push(folderRow(folderRows[i], i, tm, mine));
  if (folderShown < n) rows.push(moreButton());
  $('folderList').replaceChildren(...rows);
  $('folderList').scrollTop = top;
  folderSelInfo(tm);
}
// Transfers tick several times a second: refresh the folder at most twice a second.
function refreshFolderSoon() {
  if (!folderOpen || folderTimer) return;
  folderTimer = setTimeout(() => { folderTimer = null; renderFolder(); }, 500);
}
function folderSelInfo(tm = transferIndex()) {
  if (!folderOpen) return;
  let size = 0;
  for (const id of folderSel) size += folderSizes.get(id) || 0;
  const n = folderSel.size;
  const all = folderRows.length;
  $('folderAll').checked = n === all && all > 0;
  let allDone = all > 0;
  for (const x of folderRows) if (tm.get(x.file.id)?.status !== 'done') { allDone = false; break; }
  $('folderDlAll').textContent = allDone ? 'Show in folder' : 'Download folder';
  $('folderDlAll').title = allDone ? 'Opens the folder where it was saved' : 'Downloads every file of the folder';
  $('folderSel').textContent = folderOpen.items[0].mine ? 'Click a picture or video to open it.' : n ? `${n} selected · ${fmtBytes(size)}` : 'Nothing selected';
  $('folderDlSel').disabled = !n;
  $('folderDlSel').textContent = n && n < all ? `Download ${n} selected` : 'Download selected';
}
$('folderAll').addEventListener('change', () => {
  folderSel = $('folderAll').checked ? new Set(folderRows.map((x) => x.file.id)) : new Set();
  syncFolderBoxes();
  folderSelInfo();
});
async function downloadFolder(ids) {
  const b = folderOpen;
  if (!b) return;
  // One question for the whole folder.
  const dir = await askDownloadDir('Where should the folder “' + b.folder + '” be saved?');
  if (dir === null) return;
  const want = new Set(ids);
  const tm = transferIndex();
  let n = 0;
  for (const x of b.items) {
    if (!want.has(x.file.id)) continue;
    const t = tm.get(x.file.id);
    if (t && (t.status === 'done' || t.status === 'running')) continue;
    startDownload(x.file, x.chat, dir);
    n++;
  }
  const where = (dir || S.me?.dlPath || 'Downloads').replace(/[\\/]+$/, '');
  toast(n ? `Downloading ${n} ${n === 1 ? 'file' : 'files'} into ${where}\\${b.folder}.` : 'Those files are already downloaded.');
}
$('folderDlSel').addEventListener('click', () => downloadFolder([...folderSel]));
$('folderDlAll').addEventListener('click', () => {
  const tm = transferIndex();
  const done = folderOpen.items.map((x) => tm.get(x.file.id));
  if (done.every((t) => t?.status === 'done')) return invoke('transfer_action', { id: done[0].id, action: 'reveal' }).catch(toast);
  downloadFolder(folderOpen.items.map((x) => x.file.id));
});
$('folderDlg').addEventListener('close', () => { folderOpen = null; folderMore?.disconnect(); clearTimeout(folderTimer); folderTimer = null; });

function jumpTo(id) {
  const node = document.querySelector(`#msgs .print[data-id="${CSS.escape(id)}"]`) || msgNode(id);
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
    const old = msgNode(id);
    if (old && !old.dataset.ids.includes(' ')) {
      const fresh = messageNode(m, old.classList.contains('run'));
      if (old.classList.contains('cont')) fresh.classList.add('cont');
      old.replaceWith(fresh);
    }
    else if (old) renderMessages(true);
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

// ---------- Profile card: click a person's picture or name ----------
const joinFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
// ---- profile backgrounds: ready-made ones, a colour, or your own picture
const BANNERS = [
  { id: 'aurora', name: 'Aurora', css: 'linear-gradient(120deg,#0f766e,#2563eb 50%,#7c3aed)' },
  { id: 'sunset', name: 'Sunset', css: 'linear-gradient(120deg,#f97316,#ec4899 55%,#6d28d9)' },
  { id: 'ocean', name: 'Ocean', css: 'linear-gradient(160deg,#38bdf8,#1e3a8a)' },
  { id: 'forest', name: 'Forest', css: 'linear-gradient(135deg,#22c55e,#064e3b)' },
  { id: 'candy', name: 'Candy', css: 'linear-gradient(120deg,#f9a8d4,#a5b4fc 55%,#99f6e4)' },
  { id: 'ember', name: 'Ember', css: 'radial-gradient(circle at 20% 20%,#fde047,#f97316 40%,#7f1d1d)' },
  { id: 'midnight', name: 'Midnight', css: 'radial-gradient(circle at 80% 10%,#6366f1,#0f172a 60%)' },
  { id: 'mono', name: 'Mono', css: 'linear-gradient(135deg,#64748b,#0f172a)' },
  { id: 'rainbow', name: 'Rainbow', css: 'linear-gradient(90deg,#ef4444,#f59e0b,#84cc16,#06b6d4,#8b5cf6)' },
  { id: 'stripes', name: 'Stripes', css: 'repeating-linear-gradient(45deg,#7c3aed 0 14px,#6d28d9 14px 28px)' },
  { id: 'dots', name: 'Dots', css: 'radial-gradient(rgba(255,255,255,.45) 2px,transparent 2px) 0 0/16px 16px,linear-gradient(135deg,#0ea5e9,#14b8a6)' },
  { id: 'grid', name: 'Grid', css: 'linear-gradient(rgba(255,255,255,.14) 1px,transparent 1px) 0 0/20px 20px,linear-gradient(90deg,rgba(255,255,255,.14) 1px,transparent 1px) 0 0/20px 20px,linear-gradient(135deg,#1e293b,#475569)' },
];
function bannerStyle(spec, seed) {
  if (spec && spec.startsWith('data:image/')) return 'url("' + spec + '") center / cover';
  if (spec && spec.startsWith('g:')) { const b = BANNERS.find((x) => 'g:' + x.id === spec); if (b) return b.css; }
  if (spec && /^c:#[0-9a-fA-F]{6}$/.test(spec)) { const c = spec.slice(2); return 'linear-gradient(135deg,' + c + ',color-mix(in srgb,' + c + ' 55%,#000))'; }
  const h = hue(seed || '?');
  return 'linear-gradient(135deg,hsl(' + h + ' 50% 40%),hsl(' + ((h + 50) % 360) + ' 50% 24%))';
}

// ---- profile card: click a person's picture or name
function personInfo(id) {
  if (id === S.me.id) {
    const p = S.me.profile || {};
    return { id, name: S.me.name, status: p.status || '', avatar: p.avatar, bio: p.bio || '', joined: p.joined, banner: p.banner || '', look: p.look || '', watching: myWatching(), me: true };
  }
  const f = friendById(id);
  let m = null;
  for (const g of S.groups) { m = g.members.find((x) => x.id === id); if (m) break; }
  const base = f || m;
  if (!base) return null;
  const alt = m || {};
  return { id, name: base.name, status: base.status || alt.status || '', avatar: base.avatar || alt.avatar, bio: base.bio || alt.bio || '', joined: base.joined || alt.joined, banner: base.banner || alt.banner || '', look: base.look || alt.look || '', watching: base.watching || alt.watching || '', since: f?.since, online: base.online, friend: !!f };
}
// A picture shows as a picture; a GIF that UaN made smaller is a short silent video that loops.
function bioMediaNode(src) {
  if (src.startsWith('data:video/')) {
    const v = el('video', { src, autoplay: true, loop: true, playsinline: true });
    v.muted = true;
    return v;
  }
  return el('img', { src, alt: '' });
}
// "#rrggbb|aura" -> the colour (or '') ; what someone watches together right now
const lookColour = (look) => { const c = (look || '').split('|')[0]; return /^#[0-9a-fA-F]{6}$/.test(c) ? c : ''; };
function watchInfo(json) {
  if (!json) return null;
  try {
    const w = JSON.parse(json);
    if (!w?.film) return null;
    return { film: String(w.film).replace(/\.[a-z0-9]{2,4}$/i, ''), with: Array.isArray(w.with) ? w.with.map(String).slice(0, 5) : [] };
  } catch { return null; }
}
function myWatching() {
  for (const p of S.parties.values()) {
    if (!p || p.state === 'ended') continue;
    const me = p.members.find((x) => x.id === S.me.id);
    if (!me || me.left || !(me.joined || p.leader === S.me.id)) continue;
    const film = (p.file?.name || '').split(/[\\/]/).pop();
    const withs = p.members.filter((x) => x.id !== S.me.id && !x.left && (x.joined || x.id === p.leader)).map((x) => x.name).slice(0, 5);
    return JSON.stringify({ film, with: withs });
  }
  return '';
}
// Where the About picture goes: this mark in the text (old versions show it as it is).
const BIO_PIC = '[picture]';
function openProfile(id) {
  const p = personInfo(id);
  if (!p) return;
  $('pfBanner').style.background = bannerStyle(p.banner, p.id);
  $('pfAvatar').replaceChildren(avatar(p.name, { seed: p.id, src: p.avatar, online: !!p.online }));
  const col = lookColour(p.look);
  $('profileDlg').classList.toggle('has-look', !!col);
  if (col) $('profileDlg').style.setProperty('--look', col); else $('profileDlg').style.removeProperty('--look');
  const w = watchInfo(p.watching);
  $('pfWatch').classList.toggle('hidden', !w);
  $('pfWatch').textContent = w ? '🎬 Watching ' + w.film + (w.with.length ? ' with ' + w.with.join(', ') : '') : '';
  $('pfName').textContent = p.name;
  $('pfStatus').textContent = p.status || '';
  $('pfStatus').classList.toggle('hidden', !p.status);
  const link = S.links?.[id];
  const online = p.me ? '' : p.online ? (link ? (link.direct ? 'Online · direct connection' : 'Online · via relay') : 'Online') : 'Offline';
  $('pfOnline').textContent = online;
  $('pfOnline').classList.toggle('hidden', !online);
  $('pfNote').classList.toggle('hidden', !p.me);
  $('pfEditBg').classList.toggle('hidden', !p.me);
  $('pfBgPanel').classList.add('hidden');
  $('pfEditBg').onclick = () => {
    const panel = $('pfBgPanel');
    if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
    let cur = S.me.profile?.banner || '';
    const g = bannerGrid(cur, async (spec) => {
      try {
        await invoke('set_profile', { name: S.me.name, status: S.me.profile?.status || '', avatar: null, bio: null, banner: spec });
        S.me = await invoke('state');
        cur = spec;
        $('pfBanner').style.background = bannerStyle(spec, S.me.id);
        g.mark(cur);
      } catch (e) { toast(e); }
    }, false);
    panel.replaceChildren(g);
    panel.classList.remove('hidden');
  };
  $('pfAboutBox').classList.toggle('hidden', !p.bio && !p.me);
  const bio = p.bio || '';
  const at = bio.indexOf(BIO_PIC);
  const before = (at >= 0 ? bio.slice(0, at) : bio).replace(/\n$/, '');
  const after = (at >= 0 ? bio.slice(at + BIO_PIC.length) : '').replace(/^\n/, '');
  const slot = el('span', { class: 'bio-slot' });
  const hasText = !!(before + after).trim();
  const emptyNote = el('span', { text: p.me ? 'You have not written anything about yourself yet (Settings → Profile).' : '' });
  $('pfBio').replaceChildren(...(hasText ? [formatText(before), slot, formatText(after)] : [emptyNote, slot]));
  $('pfBio').classList.toggle('empty', !hasText);
  $('pfAboutBox').classList.toggle('hidden', !hasText && !p.me);
  invoke('bio_image', { id: p.id }).then((src) => {
    if (!src || $('pfName').textContent !== p.name) return;
    slot.replaceChildren(bioMediaNode(src));
    // A picture or GIF is something written about you too: no "nothing yet" note.
    emptyNote.remove();
    $('pfBio').classList.remove('empty');
    $('pfAboutBox').classList.remove('hidden');
  }).catch(() => {});
  const facts = [];
  if (p.friend && p.since) facts.push(['Friends since', joinFmt.format(p.since)]);
  if (p.joined) facts.push(['Join date', joinFmt.format(p.joined)]);
  $('pfFacts').replaceChildren(...facts.flatMap(([k, v]) => [el('span', { class: 'k', text: k }), el('span', { text: v })]));
  $('pfActions').replaceChildren(
    ...(p.me ? [el('button', { type: 'button', class: 'small', text: 'Edit profile', onclick: () => { $('profileDlg').close(); $('settingsBtn').click(); } })] : []));
  $('profileDlg').showModal();
}
document.addEventListener('click', (e) => {
  const t = e.target.closest?.('[data-uid]');
  if (!t || !t.dataset.uid) return;
  e.preventDefault();
  e.stopPropagation();
  openProfile(t.dataset.uid);
}, true);

// ---------- @mentions: suggestions while typing in a group ----------
let mentionSel = 0;
// Lower case, accents off: "Árvíz" and "arviz" are the same.
const fold = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
// How well a name fits what was typed: 0 = not at all. The better the fit, the higher.
function matchScore(name, q) {
  const n = fold(name);
  if (n === q) return 1000;
  if (n.startsWith(q)) return 900 - n.length;
  // the start of a word or of a capital letter inside the name: "TsaRuben" has "tsa" and "ruben"
  const starts = new Set([0]);
  for (let i = 1; i < name.length; i++) {
    const c = name[i], p = name[i - 1];
    if (/[^\p{L}\p{N}]/u.test(p) || (c !== c.toLowerCase() && p === p.toLowerCase())) starts.add(i);
  }
  let best = 0;
  const at = n.indexOf(q);
  if (at >= 0) best = starts.has(at) ? 800 - at : 600 - at;
  if (best) return best - n.length / 100;
  // letters in order, with gaps ("tsrb")
  let qi = 0, gaps = 0, last = -1;
  for (let i = 0; i < n.length && qi < q.length; i++) {
    if (n[i] === q[qi]) { if (last >= 0 && i - last > 1) gaps++; last = i; qi++; }
  }
  return qi === q.length ? Math.max(1, 300 - gaps * 20 - n.length) : 0;
}
function mentionCandidates() {
  const input = $('msgInput');
  const g = groupOf(S.active);
  if (!g) return null;
  const upto = input.value.slice(0, input.selectionStart);
  const mt = upto.match(/(^|\s)@([\p{L}\p{N}_.-]*)$/u);
  if (!mt) return null;
  const q = fold(mt[2]);
  const pool = [{ id: '*everyone', name: 'everyone', everyone: true }, ...g.members.filter((x) => x.id !== S.me.id)];
  const list = pool
    .map((x) => ({ x, s: q ? matchScore(x.name, q) : (x.everyone ? 2 : 1) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.x.name.localeCompare(b.x.name))
    .slice(0, 8)
    .map((r) => r.x);
  return list.length ? { list, start: upto.length - mt[2].length - 1 } : null;
}
function renderMentions() {
  const c = mentionCandidates();
  $('mentionPop').classList.toggle('hidden', !c);
  if (!c) return;
  mentionSel = Math.min(mentionSel, c.list.length - 1);
  $('mentionPop').replaceChildren(...c.list.map((x, i) => el('button', { type: 'button', class: i === mentionSel ? 'on' : '', onmousedown: (e) => { e.preventDefault(); insertMention(x.name); } },
    x.everyone ? avatar('@', { group: true, seed: 'everyone' }) : avatar(x.name, { seed: x.id, src: x.avatar }),
    el('span', { text: x.name }),
    x.everyone ? el('span', { class: 'mention-all-note', text: 'notifies the whole group' }) : null)));
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

// Like in Messenger: small pictures of who has seen up to here, in the same row as the time.
function seenRow(chat, ids) {
  const reads = S.reads.get(chat) || {};
  const who = Object.keys(reads).filter((id) => ids.includes(reads[id]) && id !== S.me.id);
  if (!who.length) return null;
  const group = isGroup(chat) ? groupOf(chat) : null;
  const person = (id) => (group ? group.members.find((x) => x.id === id) : friendById(id)) || friendById(id);
  const known = who.map(person).filter(Boolean);
  if (!known.length) return null;
  const row = el('span', { class: 'seen-row', title: `Seen by ${known.map((p) => p.name).join(', ')}` },
    known.slice(0, 6).map((p) => avatar(p.name, { seed: p.id, src: p.avatar })));
  if (known.length > 6) row.append(el('span', { class: 'more', text: `+${known.length - 6}` }));
  return row;
}

function renderSeen() {
  const box = $('msgs');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.querySelectorAll('.seen-row').forEach((n) => n.remove());
  box.querySelectorAll('.meta.keep-seen').forEach((n) => n.classList.remove('keep-seen'));
  for (const node of box.querySelectorAll('.msg[data-ids]')) {
    const row = seenRow(S.active, node.dataset.ids.split(' '));
    if (!row) continue;
    const time = node.querySelector('.meta .time');
    time?.before(row);
    time?.parentElement.classList.add('keep-seen');
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
// Nothing moves on screen while the window is hidden. When you only click out of UaN (it stays visible),
// the background keeps moving but its sound is off until you come back.
function onStage() {
  const hidden = document.hidden;
  document.documentElement.classList.toggle('paused', hidden);
  const v = typeof backdrop !== 'undefined' ? backdrop?.video : null;
  if (v) { if (hidden) v.pause(); else v.play().catch(() => {}); }
  if (typeof backdrop !== 'undefined' && backdrop?.c) applyTune(backdrop.c);
}
document.addEventListener('visibilitychange', onStage);
window.addEventListener('blur', onStage);
window.addEventListener('focus', onStage);

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
function deleteMessage(arg, now = false) {
  const items = Array.isArray(arg) ? arg : [arg];
  // The group's owner and co-owners may delete anyone's message for everyone.
  const mine = items.every((x) => x.mine) || isManager(groupOf(items[0].chat));
  if (now && mine) {
    // Shift+Delete: no questions asked, it goes for everyone.
    (async () => {
      for (const x of items) {
        try { await invoke('delete_message', { id: x.id, everyone: true }); } catch (e) { toast(e); break; }
      }
    })();
    return;
  }
  const files = items.some((x) => x.file);
  const d = $('delDlg');
  $('delAll').classList.toggle('hidden', !mine);
  $('delText').textContent = (items.length > 1 ? `This deletes all ${items.length} of them. ` : '') + (mine
    ? (files ? 'Delete for everyone also stops sharing the files: nobody in this chat can watch or download them from your PC any more.' : 'Delete for everyone removes it for everyone in this chat, also for those who are offline now.')
    : 'This removes it only on this device.');
  d.returnValue = '';
  d.addEventListener('close', async () => {
    if (d.returnValue !== 'me' && d.returnValue !== 'all') return;
    for (const x of items) {
      try {
        await invoke('delete_message', { id: x.id, everyone: d.returnValue === 'all' });
      } catch (e) {
        toast(e);
        break;
      }
    }
  }, { once: true });
  d.showModal();
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' || !e.shiftKey || e.target.closest?.('input, textarea, select')) return;
  let target = null;
  if (!$('ctxMenu').classList.contains('hidden') && ctxTarget) target = ctxTarget;
  else {
    const node = [...document.querySelectorAll('.msg:hover')].pop();
    if (node) {
      const ids = (node.dataset.ids || node.dataset.id || '').split(' ');
      const items = (S.msgs.get(S.active) || []).filter((x) => ids.includes(x.id));
      if (items.length) target = { m: items[0], items };
    }
  }
  if (!target) return;
  e.preventDefault();
  hideMenu();
  deleteMessage(target.items.length > 1 ? target.items : target.m, true);
});

function removeMessage(id, chat) {
  const list = S.msgs.get(chat);
  if (list) {
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list.splice(i, 1);
  }
  if (chat === S.active) renderMessages(true);
}

// A small player inside the message, like a voice message in Messenger: play or pause, a bar to jump around, the time.
// It keeps playing while new messages arrive (the same player is put back into the message each time).
const audioPlayers = new Map(); // file id -> player
const AP_PLAY = '<path d="M8 5v14l11-7Z"/>';
const AP_SPK = '<path d="M4 9v6h4l5 4V5L8 9Z"/><path d="M16 9a4 4 0 0 1 0 6"/>';
const AP_SPK_OFF = '<path d="M4 9v6h4l5 4V5L8 9Z"/><path d="m17 9 4 6M21 9l-4 6"/>';
// One volume for every sound in the messages (kept for next time). The slider is a curve: the quiet end is spread out.
const AP_VOL = (() => { try { const v = JSON.parse(localStorage.getItem('uan.audioVol') || 'null'); return { p: Math.min(100, Math.max(0, Number(v?.p ?? 80))), muted: !!v?.muted }; } catch { return { p: 80, muted: false }; } })();
const apAmp = () => (AP_VOL.muted ? 0 : (AP_VOL.p / 100) ** 2);
function applyApVolume() {
  document.querySelectorAll('audio.ap-audio').forEach((x) => { x.volume = apAmp(); });
  document.querySelectorAll('.ap-vol').forEach((b) => { b.value = String(AP_VOL.p); b.style.setProperty('--p', AP_VOL.p + '%'); });
  document.querySelectorAll('.ap-vol-btn').forEach((b) => b.replaceChildren(svg(AP_VOL.muted || AP_VOL.p === 0 ? AP_SPK_OFF : AP_SPK)));
  try { localStorage.setItem('uan.audioVol', JSON.stringify(AP_VOL)); } catch {}
}
const AP_PAUSE = '<rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/>';
function audioPlayer(file) {
  const have = audioPlayers.get(file.id);
  if (have) return have;
  const a = el('audio', { class: 'ap-audio', preload: 'none' });
  a.src = mediaUrl(file);
  const btn = el('button', { type: 'button', class: 'ap-btn', title: 'Play', 'aria-label': 'Play' }, svg(AP_PLAY));
  const bar = el('input', { type: 'range', class: 'ap-bar', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Position in the sound' });
  const time = el('span', { class: 'ap-time', text: '0:00' });
  let dragging = false;
  const show = () => {
    const d = Number.isFinite(a.duration) ? a.duration : 0;
    if (!dragging) bar.value = d ? String(Math.round((a.currentTime / d) * 1000)) : '0';
    bar.style.setProperty('--p', `${Number(bar.value) / 10}%`);
    time.textContent = d ? `${fmtTime(a.currentTime)} / ${fmtTime(d)}` : fmtTime(a.currentTime);
  };
  const icon = (playing) => { btn.replaceChildren(svg(playing ? AP_PAUSE : AP_PLAY)); btn.title = btn.ariaLabel = playing ? 'Pause' : 'Play'; };
  btn.addEventListener('click', () => { if (a.paused) a.play().catch(() => {}); else a.pause(); });
  a.addEventListener('play', () => icon(true));
  a.addEventListener('pause', () => icon(false));
  a.addEventListener('ended', () => { icon(false); a.currentTime = 0; show(); });
  a.addEventListener('timeupdate', show);
  a.addEventListener('loadedmetadata', show);
  a.addEventListener('error', async () => {
    icon(false);
    const reach = await reachability(file);
    toast(reach !== 'ok'
      ? (file.owner === S.me.id ? 'UaN can’t read this file from your disk any more.' : 'Can’t reach this sound right now: the sender’s PC is off, or UaN isn’t running on it.')
      : 'UaN can’t play this sound format. Download it to open it with another player.');
  });
  bar.addEventListener('pointerdown', () => { dragging = true; });
  bar.addEventListener('input', () => {
    const d = Number.isFinite(a.duration) ? a.duration : 0;
    if (d) a.currentTime = (Number(bar.value) / 1000) * d;
    bar.style.setProperty('--p', `${Number(bar.value) / 10}%`);
  });
  bar.addEventListener('change', () => { dragging = false; });
  const vbtn = el('button', { type: 'button', class: 'ap-vol-btn', title: 'Mute or unmute', 'aria-label': 'Mute or unmute' }, svg(AP_VOL.muted || AP_VOL.p === 0 ? AP_SPK_OFF : AP_SPK));
  const vbar = el('input', { type: 'range', class: 'ap-vol', min: 0, max: 100, step: 1, value: AP_VOL.p, 'aria-label': 'Volume of the sounds' });
  vbar.style.setProperty('--p', AP_VOL.p + '%');
  vbtn.addEventListener('click', () => { AP_VOL.muted = !AP_VOL.muted; applyApVolume(); });
  vbar.addEventListener('input', () => { AP_VOL.p = Number(vbar.value); AP_VOL.muted = false; applyApVolume(); });
  a.volume = apAmp();
  const box = el('div', { class: 'ap' }, btn, bar, time, el('div', { class: 'ap-vol-group' }, vbtn, vbar), a);
  audioPlayers.set(file.id, box);
  return box;
}
// One sound at a time: starting one stops the others.
document.addEventListener('play', (e) => {
  if (e.target.classList?.contains('ap-audio')) document.querySelectorAll('audio.ap-audio').forEach((x) => { if (x !== e.target) x.pause(); });
}, true);
function stopInlineAudio() { document.querySelectorAll('audio.ap-audio').forEach((x) => x.pause()); }

function fileCard(file, chat, thumb) {
  let preview = null;
  if (thumb?.img && (IMAGE.test(file.mime) || /^video\//i.test(file.mime))) {
    // The sender's preview: shows instantly, even when the sender's PC is off.
    const video = /^video\//i.test(file.mime);
    const pic = el('img', { src: thumb.img, alt: '', onload: keepBottom });
    animateGif(pic, file, thumb);
    preview = el('button', { class: 'thumb', type: 'button', title: video ? 'Play here without downloading' : 'Open', onclick: () => openViewer(file) },
      pic,
      video ? el('span', { class: 'play-badge' }, svg(ICON.bigplay)) : null,
      video && thumb.dur ? el('span', { class: 'dur', text: fmtTime(thumb.dur) }) : null);
  } else if (IMAGE.test(file.mime) && file.size <= INLINE_IMAGE_LIMIT) {
    preview = el('img', { src: mediaUrl(file), alt: '', loading: 'lazy', onclick: () => openViewer(file), onload: keepBottom, onerror: (e) => e.target.remove() });
  } else if (/^audio\//i.test(file.mime)) {
    preview = audioPlayer(file);
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
    preview ? gifTag(file) : null,
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

// Before a download: "where should it go?" (any folder, any drive), unless turned off in Settings → Downloads.
// Phones save into UaN's own folder. Returns the folder, '' for the usual one, or null if you cancelled.
async function askDownloadDir(title) {
  if (!S.me?.dlAsk || document.documentElement.classList.contains('phone')) return '';
  try { return await invoke('pick_download_dir', { title: title || null }); } catch (e) { toast(e); return null; }
}
async function startDownload(file, chat, dir) {
  const t = transferIndex().get(file.id);
  // Resuming one that already started keeps its place.
  if (dir === undefined && !(t && t.status !== 'error')) {
    dir = await askDownloadDir('Where should “' + (file.name || '').split(/[\\/]/).pop() + '” be saved?');
    if (dir === null) return;
  }
  invoke('download', { file, chat: chat || S.active || '', dir: dir || null }).catch(toast);
}

const toBottom = el('button', { type: 'button', class: 'to-bottom hidden', id: 'toBottom', title: 'Jump to the newest message' }, svg('<path d="M12 5v14M6 13l6 6 6-6"/>'));
$('chat').append(toBottom);
toBottom.addEventListener('click', () => { const b = $('msgs'); b.scrollTop = b.scrollHeight; });
$('msgs').addEventListener('scroll', () => { const b = $('msgs'); toBottom.classList.toggle('hidden', b.scrollHeight - b.scrollTop - b.clientHeight < 420); }, { passive: true });
let wasNearBottom = true;
$('msgs').addEventListener('scroll', () => {
  const b = $('msgs');
  wasNearBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 80;
});
function keepBottom() {
  if (wasNearBottom) $('msgs').scrollTop = $('msgs').scrollHeight;
}

const thumbPending = new Set();
const isGif = (mime) => /^image\/gif$/i.test(mime || '');
const GIF_AUTO_LIMIT = 8 * 1024 * 1024; // bigger GIFs stay a still picture until you open them
// A GIF is shown moving: the sender's small preview is only the first frame, so the real GIF replaces it as soon as it can be reached.
function animateGif(img, file, thumb) {
  if (!isGif(file.mime) || thumb?.gif || file.size > GIF_AUTO_LIMIT) return;
  const real = new Image();
  real.onload = () => { img.src = real.src; };
  real.src = mediaUrl(file);
}
const gifTag = (file) => (isGif(file.mime) ? el('div', { class: 'gif-tag', text: '.gif' }) : null);

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
    // A small GIF goes as it is, so it moves for everyone at once, even when your PC is off.
    if (isGif(file.mime) && file.size <= 170000) {
      try {
        const url = await fileToDataUrl(await (await fetch(mediaUrl(file))).blob());
        if (url.length <= 250000) return { img: url, w: img.naturalWidth, h: img.naturalHeight, gif: true };
      } catch {}
    }
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
      // The player can't decode this picture (e.g. HEVC / 10-bit in .mkv): no preview rather than a black one.
      if (!v.videoWidth || !v.videoHeight) throw new Error('no picture');
      // A frame 10% in; if it is black (a fade, a logo screen) try a few later ones.
      let img = null;
      for (const at of [0.1, 0.25, 0.45, 0.65]) {
        v.currentTime = isFinite(dur) ? Math.min(dur * at, 3600) : 5;
        await Promise.race([new Promise((res) => { v.onseeked = res; }), timeout(25000, 'seek timeout')]);
        await new Promise((r) => setTimeout(r, 150));
        const probe = document.createElement('canvas');
        probe.width = probe.height = 12;
        const pc = probe.getContext('2d', { willReadFrequently: true });
        pc.drawImage(v, 0, 0, 12, 12);
        const px = pc.getImageData(0, 0, 12, 12).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
        const bright = sum / (px.length / 4) / 3;
        img = draw(v, v.videoWidth, v.videoHeight);
        if (bright > 14 || !isFinite(dur)) break;
      }
      return { img, dur: isFinite(dur) ? dur : null, w: v.videoWidth, h: v.videoHeight };
    } finally {
      v.removeAttribute('src');
      v.load();
    }
  }
  return null;
}

// Previews are made two at a time. (Sending a folder with thousands of files used to start thousands of
// video loads at once, which froze the whole app.)
const thumbQueue = [];
let thumbRunning = 0;
function ensureThumb(m) {
  if (!m.mine || !m.file || m.thumb || thumbPending.has(m.file.id)) return;
  if (!IMAGE.test(m.file.mime) && !/^video\//i.test(m.file.mime)) return;
  // A huge folder gets previews for its first files only; the rest show their file type.
  if (thumbQueue.length >= 60) return;
  thumbPending.add(m.file.id);
  thumbQueue.push(m);
  pumpThumbs();
}
function pumpThumbs() {
  while (thumbRunning < 2 && thumbQueue.length) {
    const m = thumbQueue.shift();
    thumbRunning++;
    (async () => {
      try {
        const t = await makeThumb(m.file);
        if (t?.img && t.img.length < 280000) await invoke('set_thumb', { fileId: m.file.id, data: JSON.stringify(t) });
      } catch {
        // No preview for this one (e.g. a format the built-in player can't decode); the card still works.
      } finally {
        thumbRunning--;
        pumpThumbs();
      }
    })();
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
  if (visible) renderMessages(true);
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
      if (folderOf(m) || isMediaOnly(m)) {
        // It may join the folder or photo grid above it. (Drawn once for a burst: a folder brings thousands at once.)
        renderMessagesSoon(!(near || m.mine));
      } else {
        box.querySelector('.chat-empty')?.remove();
        if (!prev || dayFmt.format(prev.ts) !== day) box.append(el('div', { class: 'day', text: day }));
        const run = !prev || prev.sender !== m.sender || m.ts - prev.ts > RUN_GAP || dayFmt.format(prev.ts) !== day;
        const last = box.lastElementChild;
        if (!run && last?.classList.contains('msg')) last.classList.add('cont');
        box.append(messageNode(m, run));
        if (near || m.mine) box.scrollTop = box.scrollHeight;
      }
      soon('read', markRead);
    }
  } else if (!m.mine) {
    S.unread.set(m.chat, (S.unread.get(m.chat) || 0) + 1);
  }
  soon('lists', renderLists);
}
// Runs fn once a little later, however many times it is asked for meanwhile.
const soonTimers = new Map();
function soon(key, fn, ms = 120) {
  if (soonTimers.has(key)) return;
  soonTimers.set(key, setTimeout(() => { soonTimers.delete(key); fn(); }, ms));
}
let soonKeep = true;
function renderMessagesSoon(keep) {
  soonKeep = soonKeep && keep;
  soon('msgs', () => { const k = soonKeep; soonKeep = true; renderMessages(k); });
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

// Hands a file picked in the window to the app core (in pieces); gives back where it was put.
async function uploadFile(f) {
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
  return path;
}
document.addEventListener('paste', async (e) => {
  if (!S.active || $('chat').classList.contains('hidden') || document.querySelector('dialog[open]')) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type));
  if (!files.length) return;
  e.preventDefault();
  const name = chatInfo(S.active)?.name || 'this chat';
  if (!(await ask(files.length === 1 ? 'Send the picture you pasted to ' + name + '?' : 'Send the ' + files.length + ' pictures you pasted to ' + name + '?', 'Send'))) return;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const named = files.map((f, i) => new File([f], f.name && f.name !== 'image.png' ? f.name : 'picture-' + stamp + (files.length > 1 ? '-' + (i + 1) : '') + '.' + (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg'), { type: f.type }));
  try { await sendPhoneFiles(named); } catch (err) { toast(err); }
});
async function sendPhoneFiles(files) {
  const chat = S.active;
  const paths = [];
  for (const f of files) paths.push(await uploadFile(f));
  if (paths.length) await invoke('send_paths', { paths, chats: [chat], text: '' });
}
$('phoneFiles').addEventListener('change', () => {
  const files = [...$('phoneFiles').files];
  $('phoneFiles').value = '';
  if (files.length) sendPhoneFiles(files).catch(toast);
});

$('photoBtn').addEventListener('click', () => { if (S.active) $('phonePhotos').click(); });
$('phonePhotos').addEventListener('change', () => {
  const files = [...$('phonePhotos').files];
  $('phonePhotos').value = '';
  if (files.length) sendPhoneFiles(files).catch(toast);
});

// ---------- Theme workshop: themes other people made (and yours, to share) ----------
const WS = { base: '', items: [], admin: false, timer: null };
const fmtWsSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const WS_KIND = { video: 'Video', image: 'Picture', html: 'Page' };
async function wsLoad() {
  $('wsCount').textContent = 'Loading…';
  try {
    // "Liked by you": the themes you gave a like (and "Your favourites": the ones saved among your themes).
    const view = $('wsSort').value;
    const v = await invoke('ws_list', { q: $('wsQ').value.trim(), sort: view === 'liked' || view === 'favs' ? 'likes' : view });
    WS.base = v.base; WS.admin = !!v.admin;
    WS.items = (v.themes || []).filter((t) => view === 'liked' ? t.liked : view === 'favs' ? !!wsFavOf(t) : true);
    $('wsCount').textContent = view === 'liked' ? WS.items.length + ' theme' + (WS.items.length === 1 ? '' : 's') + ' you liked'
      : view === 'favs' ? WS.items.length + ' of your favourites' : v.count + ' of ' + v.max + ' themes in the workshop' + ($('wsQ').value.trim() ? ' · ' + WS.items.length + ' found' : '');
    wsRender();
  } catch (e) {
    $('wsCount').textContent = '';
    $('wsGrid').replaceChildren(el('div', { class: 'ws-empty', text: String(e) }));
  }
}
function wsRender() {
  if (!WS.items.length) {
    const view = $('wsSort').value;
    $('wsGrid').replaceChildren(el('div', { class: 'ws-empty', text: view === 'liked' ? 'You haven’t liked any theme yet: press the heart on one you like.' : view === 'favs' ? 'No favourites yet: press Favourite on a theme.' : $('wsQ').value.trim() ? 'No theme matches that.' : 'No themes yet. Be the first: press Publish a theme.' }));
    return;
  }
  $('wsGrid').replaceChildren(...WS.items.map((t) => {
    const thumb = el('div', { class: 'ws-thumb', title: 'Preview', onclick: () => wsView(t) },
      t.thumb ? el('img', { src: WS.base + '/ws/thumb/' + t.id, alt: '', loading: 'lazy' }) : el('span', { text: WS_KIND[t.kind] || 'Theme' }),
      el('span', { class: 'ws-play' }, svg(t.kind === 'video' ? '<path d="M8 5.5v13l11-6.5Z"/>' : '<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.6"/>')),
      el('span', { class: 'ws-kind', text: (WS_KIND[t.kind] || 'Theme') + ' · ' + fmtWsSize(t.size) }),
      t.status === 'pending' ? el('span', { class: 'ws-flag wait', text: 'Waiting for approval' }) : t.hidden ? el('span', { class: 'ws-flag', text: 'Hidden after reports' }) : null);
    const like = el('button', { type: 'button', class: 'ws-like small' + (t.liked ? ' on' : ''), title: t.liked ? 'Take your like back' : 'Like it' },
      svg('<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/>'), el('span', { text: String(t.likes) }));
    like.addEventListener('click', async () => {
      like.disabled = true;
      try { const r = await invoke('ws_act', { what: 'like', id: t.id, on: !t.liked }); t.liked = !t.liked; t.likes = r.likes; wsRender(); } catch (e) { toast(e); like.disabled = false; }
    });
    // Favourite: the theme is saved on this PC among your themes (Settings → Themes), to pick any time.
    const use = wsFavButton(t, wsRender);
    const more = el('button', { type: 'button', class: 'icon small', title: 'More' }, svg('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'));
    more.addEventListener('click', (e) => {
      const r = more.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, [
        !t.mine ? { label: 'Report…', run: () => wsReport(t) } : null,
        t.mine || WS.admin ? { label: t.mine ? 'Remove from the workshop' : 'Remove (admin)', danger: true, run: async () => {
          if (!(await ask('Remove “' + t.name + '” from the workshop for everyone? Those who already use it keep their copy.', 'Remove'))) return;
          try { await invoke('ws_act', { what: 'delete', id: t.id }); wsLoad(); } catch (err) { toast(err); }
        } } : null,
      ]);
      e.stopPropagation();
    });
    return el('div', { class: 'ws-card' + (t.hidden ? ' hidden-theme' : '') }, thumb,
      el('div', { class: 'ws-body' },
        el('div', { class: 'ws-name', title: t.name, text: t.name }),
        el('div', { class: 'ws-by' }, 'by ' + t.author + (t.mine ? ' (you)' : ''), t.dev ? el('span', { class: 'ws-dev', title: 'Published by the developer of UaN', text: '✓ Developer' }) : null, ' · ' + t.downloads + ' used'),
        t.about ? el('div', { class: 'ws-about', title: t.about, text: t.about }) : null),
      el('div', { class: 'ws-foot' }, like, more, use));
  }));
}
// Favourite: the theme is saved on this PC among your themes (Settings → Themes); again, and it is taken out.
const STAR = '<path d="m12 3.5 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8Z"/>';
const wsFavOf = (t) => customThemes.find((c) => c.ws === t.id);
async function wsToggleFav(t) {
  const fav = wsFavOf(t);
  try {
    if (fav) {
      await invoke('theme_remove', { id: fav.id });
      if (theme.mode === 'custom:' + fav.id) setTheme('dark');
      await loadCustomThemes();
      toast('“' + t.name + '” is not one of your themes any more.');
    } else {
      await invoke('ws_install', { id: t.id, name: t.name, author: t.author, ext: t.ext, base: t.base, accent: t.accent || null });
      await loadCustomThemes();
      toast('“' + t.name + '” is in your themes now: pick it in Settings → Themes.');
    }
  } catch (e) { toast(e); }
  if ($('settingsDlg').open) renderTopThemes();
}
function wsFavButton(t, after) {
  const fav = wsFavOf(t);
  const b = el('button', { type: 'button', class: 'small ws-fav' + (fav ? ' on' : ' accent'), title: fav ? 'Take it out of your themes' : 'Save it among your themes' },
    svg(STAR), el('span', { text: fav ? 'Favourited' : 'Favourite' }));
  b.addEventListener('click', async () => {
    b.disabled = true;
    if (!fav) b.lastChild.textContent = 'Saving…';
    await wsToggleFav(t);
    after();
  });
  return b;
}
// Top themes: the 5 most liked, small, under the workshop in Settings → Appearance.
var TOP = { items: [], at: 0 };
async function loadTopThemes() {
  if (Date.now() - TOP.at < 5 * 60_000) { renderTopThemes(); return; }
  try {
    const v = await invoke('ws_list', { q: '', sort: 'likes' });
    WS.base = v.base;
    TOP.items = (v.themes || []).filter((t) => t.status !== 'pending' && !t.hidden).slice(0, 5);
    TOP.at = Date.now();
  } catch { TOP.items = []; }
  renderTopThemes();
}
function renderTopThemes() {
  if (!TOP) return;
  $('sTopWrap').classList.toggle('hidden', !TOP.items.length);
  $('sTopThemes').style.setProperty('--n', String(Math.max(4, TOP.items.length)));
  $('sTopThemes').replaceChildren(...TOP.items.map((t) => {
    const fav = wsFavOf(t);
    const tile = el('span', { class: 'tile custom' },
      t.thumb ? el('img', { src: WS.base + '/ws/thumb/' + t.id, alt: '', loading: 'lazy' }) : svg(t.kind === 'html' ? '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12"/>' : '<path d="M8 5.5v13l11-6.5Z"/>'));
    const star = el('span', { class: 't-star' + (fav ? ' on' : ''), role: 'button', tabindex: '0', title: fav ? 'Favourited: take it out of your themes' : 'Favourite: save it among your themes',
      onclick: async (e) => { e.stopPropagation(); star.style.pointerEvents = 'none'; await wsToggleFav(t); },
      onkeydown: (e) => { if (e.key === 'Enter') { e.stopPropagation(); wsToggleFav(t); } } }, svg(STAR));
    return el('button', { type: 'button', class: 'custom-tile top-tile' + (fav && theme.mode === 'custom:' + fav.id ? ' on' : ''), title: t.name + ' by ' + t.author + ' · ' + t.likes + ' likes (click to preview)', onclick: () => wsView(t) },
      tile, star, el('span', { class: 't-name', text: t.name }));
  }));
}
// The whole theme, big: the video plays (with its sound), the picture or the page is shown. Nothing is saved.
function wsView(t) {
  const src = WS.base + '/ws/file/' + t.id + '?view=1';
  let media;
  if (t.kind === 'video') media = el('video', { src, autoplay: true, loop: true, controls: true, playsinline: true });
  else if (t.kind === 'html') media = el('iframe', { src, sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', title: t.name });
  else media = el('img', { src, alt: t.name });
  if (t.kind === 'video') {
    media.addEventListener('error', () => $('wsViewStage').replaceChildren(el('div', { class: 'ws-empty', text: 'This video can’t be played here (its format isn’t supported).' })));
    // While it plays with sound, the theme behind keeps quiet.
    for (const ev of ['play', 'pause', 'volumechange']) media.addEventListener(ev, syncBackdropSound);
  }
  $('wsViewStage').replaceChildren(media);
  $('wsViewName').textContent = t.name;
  const favSlot = () => $('wsViewFav').replaceChildren(wsFavButton(t, () => { favSlot(); if ($('wsDlg').open) wsRender(); }));
  favSlot();
  $('wsViewBy').textContent = 'by ' + t.author + ' · ' + (WS_KIND[t.kind] || 'Theme') + ' · ' + fmtWsSize(t.size);
  $('wsViewDlg').showModal();
  syncBackdropSound();
}
$('wsViewClose').addEventListener('click', () => { $('wsViewStage').replaceChildren(); $('wsViewDlg').close(); syncBackdropSound(); });
$('wsViewDlg').addEventListener('close', () => $('wsViewStage').replaceChildren());
// A small picture of your theme for the list: a frame of the video, the picture, or none for a page.
async function wsThumbOf(c) {
  if (c.kind === 'html') return null;
  const W = 320, H = 180;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const cover = (src, w, h) => { const s = Math.max(W / w, H / h); const dw = w * s, dh = h * s; ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh); };
  try {
    if (c.kind === 'image') {
      const img = new Image(); img.crossOrigin = 'anonymous'; img.src = themeFileUrl(c);
      await img.decode();
      cover(img, img.naturalWidth, img.naturalHeight);
    } else {
      const v = document.createElement('video'); v.crossOrigin = 'anonymous'; v.muted = true; v.preload = 'auto'; v.src = themeFileUrl(c);
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; setTimeout(rej, 15000); });
      v.currentTime = Math.min(1.5, (v.duration || 3) / 3);
      await new Promise((res) => { v.onseeked = res; setTimeout(res, 4000); });
      cover(v, v.videoWidth, v.videoHeight);
    }
    let q = 0.72, out = cv.toDataURL('image/jpeg', q);
    while (out.length > 38000 && q > 0.3) { q -= 0.1; out = cv.toDataURL('image/jpeg', q); }
    return out.length <= 40000 ? out : null;
  } catch { return null; }
}
function wsReport(t) {
  $('wsReportWhy').selectedIndex = 0;
  $('wsReportMore').value = '';
  $('wsReportDlg').dataset.id = t.id;
  $('wsReportDlg').showModal();
}
$('wsReportCancel').addEventListener('click', () => $('wsReportDlg').close());
$('wsReportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const reason = $('wsReportWhy').value + ($('wsReportMore').value.trim() ? ': ' + $('wsReportMore').value.trim() : '');
  try {
    await invoke('ws_act', { what: 'report', id: $('wsReportDlg').dataset.id, reason });
    $('wsReportDlg').close();
    toast('Thanks, the developer gets your report.');
  } catch (err) { toast(err); }
});
// Ideas for UaN, and the dev panel (only on the PC where it is switched on)
function suggestCount() {
  const n = $('sSuggest').value.length;
  $('sSuggestCount').textContent = n + ' / 1000';
  $('sSuggestCount').classList.toggle('full', n >= 950);
  $('sSuggestSend').disabled = !$('sSuggest').value.trim();
}
$('sSuggest').addEventListener('input', () => { $('sSuggestNote').textContent = ''; $('sSuggestNote').classList.remove('ok'); suggestCount(); });
$('sSuggestSend').addEventListener('click', async () => {
  const text = $('sSuggest').value.trim();
  if (!text) return;
  $('sSuggestSend').disabled = true;
  try {
    await invoke('ws_suggest', { text });
    $('sSuggest').value = '';
    $('sSuggestNote').textContent = '✓ Sent, thank you!';
    $('sSuggestNote').classList.add('ok');
  } catch (e) { $('sSuggestNote').textContent = String(e); $('sSuggestNote').classList.remove('ok'); }
  suggestCount();
});
$('sDevPanel').addEventListener('click', () => invoke('dev_panel').catch(toast));
// What is being published: a file staged for the workshop, or one of your own themes.
WS.pick = null; // { staged: info } | { theme: c }
function wsShowPreview(src, kind) {
  const prev = $('wsPreview');
  let media;
  if (kind === 'video') { media = el('video', { src, autoplay: true, loop: true, playsinline: true }); media.muted = true; }
  else if (kind === 'html') media = el('iframe', { src, sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', title: 'Preview' });
  else media = el('img', { src, alt: '' });
  prev.replaceChildren(media, el('span', { class: 'ws-kindtag', text: (WS_KIND[kind] || 'Theme') + ' · preview' }),
    el('button', { type: 'button', class: 'small ws-change', text: 'Change', onclick: () => { $('wsFile').value = ''; $('wsFile').click(); } }));
  prev.classList.remove('hidden');
  $('wsDropEmpty').classList.add('hidden');
}
// How bright a picture is, 0 (black) to 1 (white), the way eyes see it.
async function brightnessOf(src) {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 18;
    const x = cv.getContext('2d');
    x.drawImage(img, 0, 0, 32, 18);
    const d = x.getImageData(0, 0, 32, 18).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (d.length / 4) / 255;
  } catch { return 0; }
}
function wsClearPick() {
  WS.pick = null;
  $('wsPreview').replaceChildren();
  $('wsPreview').classList.add('hidden');
  $('wsDropEmpty').classList.remove('hidden');
}
async function wsStagePath(path) {
  $('wsPubErr').textContent = '';
  try {
    const info = await invoke('ws_stage', { path });
    WS.pick = { staged: info };
    $('wsPubTheme').value = '';
    if (!$('wsPubName').value.trim()) $('wsPubName').value = info.name;
    wsShowPreview(themeFileUrl({ file: info.file, size: info.size, mime: info.mime }) + '?t=' + Date.now(), info.kind);
  } catch (e) { $('wsPubErr').textContent = String(e); }
}
function wsOpenPublish() {
  $('wsPubErr').textContent = '';
  $('wsPubName').value = '';
  $('wsPubAbout').value = '';
  $('wsPubBase').value = 'auto';
  wsClearPick();
  $('wsPubTheme').replaceChildren(el('option', { value: '', text: customThemes.length ? '(none)' : 'You have no themes yet' }),
    ...customThemes.map((c) => el('option', { value: c.id, text: c.name + ' · ' + (WS_KIND[c.kind] || 'Theme') + ' · ' + fmtWsSize(c.size) + (c.size > 50 * 1024 * 1024 ? ' (too big)' : '') })));
  $('wsPubGo').textContent = S.me.devPanel ? 'Publish' : 'Ask to publish';
  $('wsPub').classList.remove('hidden');
  $('wsPubName').focus();
}
$('wsPickFile').addEventListener('click', () => { $('wsFile').value = ''; $('wsFile').click(); });
$('wsFile').addEventListener('change', async () => {
  const f = $('wsFile').files[0];
  if (!f) return;
  if (f.size > 50 * 1024 * 1024) { $('wsPubErr').textContent = 'A theme can be 50 MB at most.'; return; }
  $('wsPubErr').textContent = 'Getting it ready…';
  try { const path = await uploadFile(f); await wsStagePath(path); } catch (e) { $('wsPubErr').textContent = String(e); }
});
$('wsPubTheme').addEventListener('change', () => {
  const c = customThemes.find((x) => x.id === $('wsPubTheme').value);
  if (!c) { wsClearPick(); return; }
  WS.pick = { theme: c };
  $('wsPubName').value = c.name;
  $('wsPubBase').value = 'auto';
  wsShowPreview(themeFileUrl(c), c.kind);
});
$('wsOpen').addEventListener('click', () => { $('wsDlg').showModal(); $('wsPub').classList.add('hidden'); wsLoad(); });
$('wsClose').addEventListener('click', () => $('wsDlg').close());
$('wsSort').addEventListener('change', wsLoad);
$('wsQ').addEventListener('input', () => { clearTimeout(WS.timer); WS.timer = setTimeout(wsLoad, 300); });
$('wsPublishBtn').addEventListener('click', wsOpenPublish);
$('wsPubCancel').addEventListener('click', () => $('wsPub').classList.add('hidden'));
$('wsPubGo').addEventListener('click', async () => {
  const pick = WS.pick;
  if (!pick) { $('wsPubErr').textContent = 'Drop a file here, choose one, or pick one of your themes.'; return; }
  const name = $('wsPubName').value.trim();
  if (!name) { $('wsPubErr').textContent = 'Give it a name.'; $('wsPubName').focus(); return; }
  const c = pick.theme || { kind: pick.staged.kind, file: pick.staged.file, size: pick.staged.size, mime: pick.staged.mime, name };
  if (c.size > 50 * 1024 * 1024) { $('wsPubErr').textContent = 'That one is bigger than 50 MB.'; return; }
  const go = $('wsPubGo');
  const label = go.textContent;
  go.disabled = true; go.textContent = 'Uploading…';
  $('wsPubErr').textContent = '';
  try {
    const thumb = await wsThumbOf(c);
    // Automatic: light panels over a bright picture, dark ones over a dark picture (a page without a picture gets dark ones).
    let base = $('wsPubBase').value;
    if (base === 'auto') base = thumb && (await brightnessOf(thumb)) > 0.58 ? 'light' : 'dark';
    if (pick.theme) await invoke('ws_publish', { id: c.id, about: $('wsPubAbout').value, thumb, name, base });
    else await invoke('ws_publish_file', { file: c.file, name, about: $('wsPubAbout').value, base, thumb });
    wsClearPick();
    $('wsPub').classList.add('hidden');
    toast(S.me.devPanel ? '“' + name + '” is in the workshop now.' : 'Sent! “' + name + '” shows up for everyone once it is approved.');
    $('wsSort').value = 'new';
    wsLoad();
  } catch (e) { $('wsPubErr').textContent = String(e); }
  go.disabled = false; go.textContent = label;
});

// ---------- Emoji picker ----------
const EMOJIS = '😀😃😄😁😆😅😂🤣😊😇🙂😉😍🥰😘😋😛😜🤪🤔🤨😐😑🙄😏😴😎🤓🥳😭😢😤😡😱😨😰🤗🤭🫡🤫🥺😳😬🙃🫠🤯🥵🥶🤢🤮👍👎👏🙌🙏🤝💪👀👋✌️🤞🫶❤️🧡💛💚💙💜🖤🤍💔💯🔥✨🎉🎬🍿🎮🎧🎵🍕🍔🍟🍺☕🚀🌙⭐☀️🌈💀👻🤖🐱🐶'.match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu);
function closeEmoji() { document.querySelector('.emoji-pop')?.remove(); }
$('emojiBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (document.querySelector('.emoji-pop')) { closeEmoji(); return; }
  const pop = el('div', { class: 'emoji-pop' }, EMOJIS.map((em) => el('button', { type: 'button', text: em, onmousedown: (ev) => ev.preventDefault(), onclick: () => {
    const t = $('msgInput');
    const s = t.selectionStart ?? t.value.length, en = t.selectionEnd ?? s;
    t.value = t.value.slice(0, s) + em + t.value.slice(en);
    t.focus();
    t.setSelectionRange(s + em.length, s + em.length);
  } })));
  document.body.append(pop);
  const r = $('emojiBtn').getBoundingClientRect();
  pop.style.left = Math.max(6, Math.min(innerWidth - 322, r.left)) + 'px';
  pop.style.top = Math.max(6, r.top - pop.getBoundingClientRect().height - 8) + 'px';
  const close = (ev) => { if (!pop.contains(ev.target)) { closeEmoji(); document.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEmoji(); });

// ---------- Polls ----------
function pollRow(value = '') {
  const input = el('input', { maxlength: '80', placeholder: 'Option', value, autocomplete: 'off' });
  const row = el('div', { class: 'row' }, input, iconBtn('x', 'Remove this option', () => { if ($('pollOpts').children.length > 2) row.remove(); }));
  return row;
}
$('pollBtn').addEventListener('click', () => {
  $('pollQ').value = '';
  $('pollErr').textContent = '';
  $('pollOpts').replaceChildren(pollRow(), pollRow());
  $('pollDlg').showModal();
  $('pollQ').focus();
});
$('pollAdd').addEventListener('click', () => { if ($('pollOpts').children.length < 10) { const r = pollRow(); $('pollOpts').append(r); r.querySelector('input').focus(); } });
$('pollCancel').addEventListener('click', () => $('pollDlg').close());
$('pollForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('pollQ').value.replace(/\s+/g, ' ').trim();
  const opts = [...$('pollOpts').querySelectorAll('input')].map((i) => i.value.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!q) { $('pollErr').textContent = 'Write a question.'; return; }
  if (opts.length < 2) { $('pollErr').textContent = 'Give at least two options.'; return; }
  const text = '📊 ' + q + '\n' + opts.map((o) => '• ' + o).join('\n');
  try {
    await invoke('send_text', { chats: [S.active], text, reply: null });
    $('pollDlg').close();
  } catch (err) { $('pollErr').textContent = String(err); }
});

$('attachBtn').addEventListener('click', () => {
  if (!S.active) return;
  if (document.documentElement.classList.contains('phone')) return $('phoneFiles').click();
  const r = $('attachBtn').getBoundingClientRect();
  showMenu(r.left, r.top - 70, [
    { label: 'Send files…', run: () => invoke('pick_and_send', { chats: [S.active], text: '' }).catch(toast) },
    { label: 'Send a folder…', run: async () => {
      const chat = S.active;
      try {
        const path = await invoke('pick_folder');
        if (path) await askFolderTypes(await scanFolder(path), chat);
      } catch (e) { toast(e); }
    } },
  ]);
});

const wsDropping = () => $('wsDlg').open && !$('wsPub').classList.contains('hidden');
listen('tauri://drag-enter', () => { if (wsDropping()) { $('wsDrop').classList.add('over'); return; } if (S.active) $('drop').classList.remove('hidden'); });
listen('tauri://drag-leave', () => { $('drop').classList.add('hidden'); $('wsDrop').classList.remove('over'); });
listen('tauri://drag-drop', async ({ payload }) => {
  $('drop').classList.add('hidden');
  if (wsDropping()) { $('wsDrop').classList.remove('over'); if (payload.paths?.length) wsStagePath(payload.paths[0]); return; }
  if (!S.active || !payload.paths?.length) return;
  const chat = S.active;
  // Files go at once; for a folder you first pick which file types go.
  const files = [], folders = [];
  for (const p of payload.paths) {
    try { folders.push(await scanFolder(p)); } catch { files.push(p); }
  }
  if (files.length) invoke('send_paths', { paths: files, chats: [chat], text: '' }).catch(toast);
  for (const f of folders) await askFolderTypes(f, chat);
});

// ---------- Sending a folder: pick which file types go ----------
// Counting a whole drive can take a while: a note shows meanwhile (only when it is slow).
async function scanFolder(path) {
  const slow = setTimeout(() => toast('Counting the files…'), 600);
  try { return await invoke('scan_folder', { path }); } finally { clearTimeout(slow); }
}
const fmtCount = (n) => n.toLocaleString('en-US').replace(/,/g, ' ');
function askFolderTypes(scan, chat) {
  return new Promise((resolve) => {
    const d = $('folderSendDlg');
    const max = scan.max || 1000;
    $('fsTitle').textContent = `Send “${scan.name}”`;
    $('fsInfo').textContent = `${fmtCount(scan.count)}${scan.partial ? '+' : ''} ${scan.count === 1 ? 'file' : 'files'} · ${fmtBytes(scan.size)}${scan.partial ? '+' : ''}`;
    $('fsErr').textContent = '';
    const rows = scan.exts.map((x) => el('label', { class: 'fs-row' },
      el('input', { type: 'checkbox', value: x.ext, checked: true, onchange: update }),
      el('span', { class: 'fs-ext', text: x.ext ? `.${x.ext}` : 'no extension' }),
      el('span', { class: 'fs-count', text: `${fmtCount(x.count)} ${x.count === 1 ? 'file' : 'files'}` }),
      el('span', { class: 'fs-size', text: fmtBytes(x.size) })));
    $('fsList').replaceChildren(...rows);
    function update() {
      const on = scan.exts.filter((x) => rows.find((r) => r.querySelector('input').value === x.ext).querySelector('input').checked);
      const n = on.reduce((a, x) => a + x.count, 0), size = on.reduce((a, x) => a + x.size, 0);
      $('fsAll').checked = on.length === scan.exts.length;
      $('fsSend').disabled = !n || n > max;
      $('fsSend').textContent = n ? `Send ${fmtCount(n)} ${n === 1 ? 'file' : 'files'} (${fmtBytes(size)})` : 'Send';
      $('fsErr').textContent = n > max ? `${fmtCount(max)} files at most at once: untick some types (like .dll or no extension), zip it, or send part of it.`
        : scan.partial ? `This is very big: only the first ${fmtCount(scan.count)} files were counted.` : '';
    }
    $('fsAll').onchange = () => { for (const r of rows) r.querySelector('input').checked = $('fsAll').checked; update(); };
    update();
    const finish = (go) => async () => {
      d.close();
      if (go) {
        const exts = rows.map((r) => r.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
        const slow = setTimeout(() => toast('Sending the files…'), 800);
        try { const n = await invoke('send_folder', { path: scan.path, chats: [chat], exts }); toast(`${fmtCount(n)} ${n === 1 ? 'file' : 'files'} sent.`); } catch (e) { toast(e); }
        clearTimeout(slow);
      }
      resolve();
    };
    $('fsSend').onclick = finish(true);
    $('fsCancel').onclick = finish(false);
    d.showModal();
  });
}

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
  // The volume slider is a curve (position squared): the quiet end is spread out, so small volumes can be set finely.
  const posOf = (v) => Math.round(Math.sqrt(v) * 100);

  const btn = (title, icon, cls = '') => el('button', { class: `pl-btn ${cls}`, type: 'button', title }, svg(icon));
  const playBtn = btn('Play / pause (Space)', PICON.play);
  const time = el('span', { class: 'pl-time', text: '0:00 / 0:00' });
  const seek = el('input', { type: 'range', class: 'pl-seek', min: 0, max: 1000, step: 1, value: 0, title: 'Seek (← →)' });
  const muteBtn = btn('Mute (M)', PICON.vol);
  const vol = el('input', { type: 'range', class: 'pl-vol', min: 0, max: 100, value: posOf(video.volume), title: 'Volume' });
  const audioBtn = el('button', { class: 'pl-btn pl-text hidden', type: 'button', title: 'Choose the sound track (language)', text: 'Audio' });
  const cc = el('button', { class: 'pl-btn pl-cc', type: 'button', text: 'CC' });
  const load = el('button', { class: 'pl-btn pl-text', type: 'button', title: 'Load a subtitle file from your PC (.srt or .vtt)', text: '+ Subtitles' });
  const fsBtn = btn('Full screen (F)', PICON.full, 'pl-fs');
  const spinner = el('div', { class: 'pl-spin hidden' });
  const bar = el('div', { class: 'pl-bar' }, playBtn, time, seek, muteBtn, vol, cc, load, audioBtn, fsBtn);
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
  // With a picked sound track the film's own sound stays off; "muted" then belongs to the helper's sound.
  const isMuted = () => (video._assist?.chosen ? video._assist.userMuted : video.muted);
  const setMuted = (on) => {
    if (video._assist?.chosen) { video._assist.userMuted = on; video._assist.volume?.(); } else video.muted = on;
    volIcon();
  };
  const volIcon = () => setIcon(muteBtn, isMuted() || video.volume === 0 ? PICON.mute : PICON.vol);
  vol.addEventListener('input', () => {
    video.volume = (vol.value / 100) ** 2;
    setMuted(video.volume === 0);
    volIcon();
    try { localStorage.setItem('uan.vol', String(video.volume)); } catch {}
  });
  muteBtn.onclick = () => setMuted(!isMuted());
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

  // A film with more than one sound track (languages): an "Audio" button lists them. The default one plays as usual;
  // another one is decoded by the silent VLC and replaces it (the picture stays here).
  if (/\.(mkv|webm|mka)$/i.test(file.name || '') || /matroska|webm/i.test(file.mime)) {
    withTimeout(invoke('media_tracks', { file }), 15000).then((tracks) => {
      if (!Array.isArray(tracks) || tracks.length < 2 || !video.isConnected) return;
      audioBtn.classList.remove('hidden');
      const defIdx = Math.max(0, tracks.findIndex((x) => x.default));
      let cur = defIdx;
      const lang = (c) => { try { return c && c !== 'und' ? new Intl.DisplayNames(['en'], { type: 'language' }).of(c) : ''; } catch { return c || ''; } };
      const label = (tr, i) => [lang(tr.lang) || 'Track ' + (i + 1), tr.name && tr.name !== lang(tr.lang) ? tr.name : '', String(tr.codec || '').replace(/^A_/, '')].filter(Boolean).join(' · ');
      const pick = async (i) => {
        if (i === cur) return;
        const was = cur;
        cur = i;
        if (i === defIdx) { if (video._assist?.chosen) video._assist.stop(); return; }
        const ok = await startAudioAssist(video, file, () => { cur = defIdx; }, { track: i });
        if (!ok) cur = was;
      };
      audioBtn.onclick = () => {
        const r = audioBtn.getBoundingClientRect();
        showMenu(r.left, Math.max(8, r.top - 12 - tracks.length * 34), tracks.map((tr, i) => ({ label: (i === cur ? '\u2022 ' : '   ') + label(tr, i), run: () => pick(i) })));
      };
    }).catch(() => {});
  }

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
  else if (k === 'm') activePlayer.root.querySelector('.pl-btn[title^="Mute"]')?.click();
  else if (k === 'c') activePlayer.root.querySelector('.pl-cc').click();
});

// ---------- VLC: for formats the built-in player can't play (streams, nothing is downloaded) ----------
function httpUrl(file) {
  return `${S.me.httpBase}/${file.owner}${file.dev ? `~${file.dev}` : ''}/${file.id}/${file.size}/${encodeURIComponent(file.mime)}?stream=1`;
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
  // (Also watches the picture: some films, e.g. HEVC / 10-bit in .mkv, play their sound while the screen stays black.)
  if (!/^video\//i.test(file.mime) || S.me.platform !== 'windows') return;
  // Counts real playback time (a stream from far away often stalls at first), and decides after 3 seconds.
  let played = 0;
  let last = null;
  const iv = setInterval(async () => {
    if (!video.isConnected) return clearInterval(iv);
    if (video.paused || video.seeking || video.readyState < 3) { last = null; return; }
    const t = video.currentTime;
    if (last !== null && t > last && t - last < 3) played += t - last;
    last = t;
    if (played < 3) return;
    clearInterval(iv);
    // Picture: it has been playing for seconds, but no video frame was ever decoded (a black screen).
    const q = video.getVideoPlaybackQuality?.();
    const noFrames = (q && q.totalVideoFrames === 0) || video.videoWidth === 0 || video.webkitDecodedFrameCount === 0;
    if (noFrames && video.isConnected) return onSilent('picture');
    const decoded = video.webkitAudioDecodedByteCount;
    if (typeof decoded !== 'number' || decoded > 0) return;
    let has = true; // can't tell: a film with no sound at all is rare, a missing codec is not
    try { has = await invoke('audio_track', { file }); } catch {}
    if (has && video.isConnected) onSilent('sound');
  }, 1000);
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

// ---------- The film's sound through VLC, quietly: the picture and everything else stay in UaN ----------
// Some films carry their sound in a format the built-in player can't decode (AC-3, DTS ...). Instead of opening VLC's
// window, a silent VLC decodes just the sound and sends it back as an ordinary audio stream; it plays here, level
// with the picture (restarted after a jump, nudged when it drifts). Returns true when it started.
async function startAudioAssist(video, file, onFail, opts = {}) {
  if (video._assist && opts.track == null) return true;
  if (video._assist) video._assist.stop();
  if (!(await ensureVlc('This film’s sound is in a format the built-in player can’t decode. VLC (free) can decode it quietly in the background, so the film still plays here.'))) return false;
  const a = new Audio();
  a.preload = 'auto';
  const chosen = opts.track != null; // a track the viewer picked: the film's own sound is switched off, this one replaces it
  const A = (video._assist = { audio: a, startAt: 0, lead: 3, ready: false, token: 0, failures: 0, iv: null, timer: null, chosen, track: opts.track, userMuted: video.muted });
  if (chosen) video.muted = true;
  const stop = () => {
    clearInterval(A.iv);
    clearTimeout(A.timer);
    A.token++;
    a.pause();
    a.removeAttribute('src');
    a.load();
    invoke('audio_assist_stop').catch(() => {});
    if (A.chosen) video.muted = A.userMuted; // the film's own sound again
    if (video._assist === A) video._assist = null;
  };
  A.stop = stop;
  const failed = (why) => {
    stop();
    toast('The film’s sound couldn’t be started quietly' + (why ? ' (' + why + ')' : '') + ', so it opens in VLC instead.');
    onFail?.();
  };
  // Starts the sound a few seconds ahead of the picture (VLC needs a moment), and lets it begin when the picture gets there.
  const launch = async (from) => {
    const mine = ++A.token;
    A.ready = false;
    a.pause();
    A.startAt = Math.max(0, from + A.lead);
    try {
      const url = await invoke('audio_assist_start', { url: httpUrl(file), start: A.startAt, track: A.track ?? null });
      if (mine !== A.token) return;
      // VLC opens its port a moment later: try a few times.
      let ok = false;
      for (let n = 0; n < 12 && !ok && mine === A.token; n++) {
        a.src = n ? url + '?r=' + n : url;
        a.load();
        ok = await new Promise((res) => {
          const done = (v) => { clearTimeout(t); a.removeEventListener('canplay', yes); a.removeEventListener('error', no); res(v); };
          const yes = () => done(true);
          const no = () => done(false);
          const t = setTimeout(() => done(false), 4000);
          a.addEventListener('canplay', yes, { once: true });
          a.addEventListener('error', no, { once: true });
        });
        if (!ok) await new Promise((r) => setTimeout(r, 350));
      }
      if (mine !== A.token) return;
      if (!ok) { if (++A.failures >= 3) failed('no sound came back'); else launch(video.currentTime); return; }
      A.failures = 0;
      A.ready = true;
    } catch (e) {
      if (mine === A.token) failed(String(e).slice(0, 80));
    }
  };
  const tick = () => {
    if (!video.isConnected) return stop(); // the player was closed
    if (!A.ready) return;
    const vt = video.currentTime;
    if (video.paused || video.seeking || video.readyState < 3) { if (!a.paused) a.pause(); return; }
    if (a.paused) {
      if (vt >= A.startAt - 0.03) {
        if (vt > A.startAt + 1.2) { A.lead = Math.min(A.lead + 1.5, 9); launch(vt); return; } // too late: ask for it further ahead
        a.play().catch(() => {});
      }
      return;
    }
    const diff = vt - (A.startAt + a.currentTime); // positive: the sound is behind the picture
    if (Math.abs(diff) > 1.2) { launch(vt); return; }
    a.playbackRate = Math.abs(diff) > 0.12 ? 1 + Math.max(-0.05, Math.min(0.05, diff * 0.5)) : 1;
  };
  const volume = () => { a.volume = video.volume; a.muted = A.chosen ? A.userMuted : video.muted; };
  volume();
  video.addEventListener('volumechange', volume);
  A.volume = volume;
  video.addEventListener('seeked', () => { clearTimeout(A.timer); A.timer = setTimeout(() => launch(video.currentTime), 250); });
  video.addEventListener('ended', stop);
  A.iv = setInterval(tick, 200);
  launch(video.currentTime);
  return true;
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
let viewerCtx = null; // { list: the files the arrows go through, chat, back: what to reopen when it closes }
let viewerFile = null;
function openViewer(file, ctx = null) {
  viewerCtx = ctx;
  showInViewer(file);
}
function viewerStep(d) {
  const list = viewerCtx?.list;
  if (!list || list.length < 2 || !viewerFile) return;
  const i = list.findIndex((f) => f.id === viewerFile.id);
  showInViewer(list[(i + d + list.length) % list.length]);
}
$('viewerPrev').addEventListener('click', () => viewerStep(-1));
$('viewerNext').addEventListener('click', () => viewerStep(1));
// On the phone: swipe left or right to go through them.
{
  let start = null;
  $('viewerBody').addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    start = e.touches.length === 1 && !e.target.closest('.pl-bar') ? { x: t.clientX, y: t.clientY } : null;
  }, { passive: true });
  $('viewerBody').addEventListener('touchend', (e) => {
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x, dy = t.clientY - start.y;
    start = null;
    if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) viewerStep(dx < 0 ? 1 : -1);
  });
}
function showInViewer(file) {
  viewerFile = file;
  const chat = viewerCtx?.chat || S.active;
  const list = viewerCtx?.list || [];
  const many = list.length > 1;
  $('viewerPrev').classList.toggle('hidden', !many);
  $('viewerNext').classList.toggle('hidden', !many);
  $('viewerCount').textContent = many ? `${list.findIndex((f) => f.id === file.id) + 1} / ${list.length}` : '';
  const film = PLAYABLE.test(file.mime);
  $('viewerPrev').title = film ? 'Previous (Shift+left arrow)' : 'Previous (left arrow)';
  $('viewerNext').title = film ? 'Next (Shift+right arrow)' : 'Next (right arrow)';
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
        el('button', { type: 'button', class: 'small', text: 'Try again', onclick: () => showInViewer(file) })));
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
        el('button', { type: 'button', class: 'small', text: 'Download', onclick: () => startDownload(file, chat) })));
    }
    note.classList.remove('hidden');
    if (reach === 'ok' && /^video\//i.test(file.mime) && !autoVlc) {
      autoVlc = true;
      openInVlc(file, 'This video’s format can’t be played inside UaN on this computer, but VLC can play it without downloading.');
    }
  };
  if (/^video\//i.test(file.mime)) {
    viewerPlayer = makePlayer(body, { file, chat });
    viewerPlayer.video.addEventListener('error', showError);
    const toVlcWindow = (what = 'sound') => {
      if (token !== viewerToken || autoVlc) return;
      autoVlc = true;
      viewerPlayer?.video.pause();
      note.textContent = `This film’s ${what} can’t be played inside UaN on this computer, so it plays in VLC instead (nothing is downloaded).`;
      note.append(el('div', { class: 'note-actions' },
        el('button', { type: 'button', class: 'small', text: 'Open in VLC (no download)', onclick: () => { viewerPlayer?.video.pause(); openInVlc(file); } })));
      note.classList.remove('hidden');
      openInVlc(file, `This film’s ${what} can’t be played inside UaN on this computer, but VLC can play it without downloading.`);
    };
    watchSound(viewerPlayer.video, file, async (what = 'sound') => {
      if (token !== viewerToken || autoVlc) return;
      if (what === 'sound' && await startAudioAssist(viewerPlayer.video, file, () => toVlcWindow('sound'))) {
        note.textContent = 'This film’s sound is in a format the built-in player can’t decode, so VLC decodes it quietly in the background. The film plays here.';
        note.classList.remove('hidden');
        setTimeout(() => { if (token === viewerToken) note.classList.add('hidden'); }, 7000);
        return;
      }
      toVlcWindow(what);
    });
  } else {
    const src = mediaUrl(file);
    const node = IMAGE.test(file.mime) ? el('img', { src, alt: file.name }) : el('audio', { src, controls: true, autoplay: true });
    node.addEventListener('error', showError);
    body.replaceChildren(node);
  }
  $('viewerName').textContent = `${file.name.split(/[\\/]/).pop()} · ${fmtBytes(file.size)}`;
  $('viewerDl').classList.toggle('hidden', file.owner === S.me.id);
  $('viewerVlc').classList.toggle('hidden', !/^video\//i.test(file.mime));
  $('viewerVlc').onclick = () => { viewerPlayer?.video.pause(); openInVlc(file); };
  $('viewerDl').onclick = () => startDownload(file, chat);
  $('viewer').classList.remove('hidden');
  // The keys now belong to the viewer, not to the message box behind it.
  if (!$('viewer').contains(document.activeElement)) document.activeElement?.blur();
}
function closeViewer() {
  viewerToken++;
  viewerPlayer?.destroy();
  viewerPlayer = null;
  viewerFile = null;
  $('viewer').classList.add('hidden');
  $('viewerBody').replaceChildren(); // stops playback and network reads
  const back = viewerCtx?.back;
  viewerCtx = null;
  back?.();
}
$('viewerClose').addEventListener('click', closeViewer);

// ---------- Picking friends: send to several / new group / add to group ----------
let pickMode = null;
let pickGroup = null;

let pickTheme = null;
function openPick(mode, group, themeToSend = null) {
  pickMode = mode;
  pickGroup = group;
  pickTheme = themeToSend;
  let choices = S.friends;
  if (mode === 'add') choices = S.friends.filter((f) => !group.members.some((m) => m.id === f.id));
  if (!choices.length) return toast(mode === 'add' ? 'All your friends are already in this group.' : 'Add a friend first.');
  $('pickTitle').textContent = { multi: 'Send to several', group: 'Create a group', add: `Add to ${group?.name}`, theme: `Send “${themeToSend?.name}”` }[mode];
  $('pickNote').textContent = {
    theme: 'Pick friends and groups. They can right-click it and choose Use as theme.',
    multi: 'Pick friends and groups. A file is sent once and lands in every chat.',
    group: 'Pick the friends to put in the group. Everyone sees everything posted there.',
    add: 'Pick friends to add. They will see the earlier messages too.',
  }[mode];
  $('pickName').classList.toggle('hidden', mode !== 'group');
  $('pickText').classList.toggle('hidden', mode !== 'multi');
  $('pickAlt').classList.toggle('hidden', mode !== 'multi');
  $('pickAlt').textContent = 'Send message only';
  $('pickOk').textContent = { multi: 'Choose files…', group: 'Create group', add: 'Add', theme: 'Send' }[mode];
  $('pickName').value = '';
  $('pickText').value = '';
  $('pickError').textContent = '';
  const rows = choices.map((f) => el('label', {}, el('input', { type: 'checkbox', value: f.id, checked: f.id === S.active }), avatar(f.name, { online: f.online, seed: f.id, src: f.avatar }), el('span', { text: f.name })));
  if (mode === 'multi' || mode === 'theme') {
    rows.unshift(...S.groups.map((g) => el('label', {}, el('input', { type: 'checkbox', value: `g:${g.id}`, checked: S.active === `g:${g.id}` }), avatar(g.name, { group: true, seed: g.id, src: g.avatar }), el('span', { text: g.name }))));
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
    if (pickMode === 'theme') {
      if (!ids.length) return void ($('pickError').textContent = 'Pick at least one.');
      await invoke('theme_send', { id: pickTheme.id, chats: ids });
      $('pickDlg').close();
      toast(`Sent “${pickTheme.name}”.`);
    } else if (pickMode === 'multi') {
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
  // An open dialog sits above everything else on the page, so the menu has to live inside it
  // (otherwise it shows up behind the dialog).
  const host = document.fullscreenElement || [...document.querySelectorAll('dialog[open]')].pop() || document.body;
  if (m.parentElement !== host) host.append(m);
  m.replaceChildren(...items.filter(Boolean).map((it) => (it === '-'
    ? el('hr')
    : el('button', { type: 'button', class: it.danger ? 'danger-text' : '', text: it.label, onclick: () => { hideMenu(); it.run(); } }))));
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  const bottom = document.documentElement.classList.contains('phone') ? 64 : 4;
  m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - bottom))}px`;
}
function hideMenu() { $('ctxMenu').classList.add('hidden'); ctxTarget = null; }
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#ctxMenu')) hideMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
window.addEventListener('blur', hideMenu);

// Automatic downloads happen only in the chats where you switch them on (and only while they are on in Settings).
function autoDlItem(chat) {
  const list = S.me?.autodlChats || [];
  const on = list.includes(chat);
  return { label: on ? '✓ Automatic downloads here' : 'Automatic downloads here', run: async () => {
    try {
      await invoke('set_autodl_chat', { chat, on: !on });
      S.me.autodlChats = on ? list.filter((c) => c !== chat) : [...list, chat];
      toast(on ? 'Files in this chat are no longer downloaded by themselves.'
        : S.me.autodl ? 'Files sent here are downloaded by themselves now.' : 'Switched on for this chat. Automatic downloads are off in Settings → Downloads & start-up: turn them on there too.');
    } catch (e) { toast(e); }
  } };
}
function muteItem(chat) {
  const on = S.mutes.has(chat);
  return { label: on ? 'Unmute notifications' : 'Mute notifications', run: async () => {
    await invoke('set_mute', { chat, on: !on }).catch(toast);
    if (on) S.mutes.delete(chat); else S.mutes.add(chat);
    renderLists();
    toast(on ? 'Notifications are on again.' : 'Muted. You still get a notification if someone @mentions you or answers you.');
  } };
}

// ---------- Pinned to the top of the list: up to 3 friends and 3 groups ----------
function pinned() {
  try { const p = JSON.parse(localStorage.getItem('uan.pinned') || '{}'); return { f: p.f || [], g: p.g || [] }; } catch { return { f: [], g: [] }; }
}
function pinItem(kind, id) {
  const p = pinned();
  const on = p[kind].includes(id);
  return { label: on ? 'Unpin' : 'Pin to the top', run: () => {
    if (!on && p[kind].length >= 3) return toast(`You can pin 3 ${kind === 'f' ? 'friends' : 'groups'}. Unpin one first.`);
    p[kind] = on ? p[kind].filter((x) => x !== id) : [...p[kind], id];
    try { localStorage.setItem('uan.pinned', JSON.stringify(p)); } catch {}
    renderLists();
  } };
}
const onlineHeads = () => { try { return localStorage.getItem('uan.onlineHeads') !== '0'; } catch { return true; } };
const isManager = (g) => !!g && (g.owner === S.me.id || (g.admins || []).includes(S.me.id));

function groupMenu(g) {
  const owner = g.owner === S.me.id;
  const manager = isManager(g);
  return [
    { label: 'Add people…', run: () => openPick('add', g) },
    pinItem('g', g.id),
    muteItem(`g:${g.id}`),
    autoDlItem(`g:${g.id}`),
    { label: 'Members and details', run: () => openGroupInfo(g.id) },
    manager ? { label: 'Change group picture…', run: () => pickGroupPicture(g) } : null,
    '-',
    { label: 'Clear messages for me', run: () => clearChat(`g:${g.id}`, false) },
    manager ? { label: 'Clear messages for everyone', danger: true, run: () => clearChat(`g:${g.id}`, true) } : null,
    { label: owner ? 'Delete group' : 'Leave group', danger: true, run: () => leaveGroup(g) },
  ];
}
function pickGroupPicture(g) {
  const input = el('input', { type: 'file', accept: 'image/*' });
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    try {
      const img = await createImageBitmap(f);
      const c = document.createElement('canvas');
      c.width = c.height = 160;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 160, 160);
      await groupAct(g, 'picture', [], c.toDataURL('image/jpeg', 0.85));
      toast('Group picture changed.');
    } catch (e) { toast(e.message || e); }
  };
  input.click();
}
function friendMenu(f, inChat = false) {
  return [
    inChat ? null : { label: 'Open chat', run: () => openChat(f.id) },
    inChat ? null : { label: 'Check profile', run: () => openProfile(f.id) },
    inChat ? null : pinItem('f', f.id),
    muteItem(f.id),
    autoDlItem(f.id),
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
  openProfile(info.friend.id);
});
$('chatTitle').addEventListener('contextmenu', (e) => {
  const info = chatInfo(S.active);
  if (!info || info.group) return;
  e.preventDefault();
  showMenu(e.clientX, e.clientY, friendMenu(info.friend, true));
});

let groupDlgId = null;
function openGroupInfo(id = groupDlgId) {
  const g = groupById(id);
  if (!g) return;
  groupDlgId = g.id;
  const owner = g.owner === S.me.id;
  const manager = isManager(g);
  const admins = g.admins || [];
  $('gTitle').textContent = g.name;
  $('gRenameRow').classList.toggle('hidden', !manager);
  $('gPic').classList.toggle('hidden', !manager);
  setAvatar($('gAvatar'), g.name, { group: true, seed: g.id, src: g.avatar });
  $('gName').value = g.name;
  $('gCount').textContent = `${g.members.length} members`;
  $('gError').textContent = '';
  $('gMembers').replaceChildren(...[...g.members].sort((a, b) => (b.id === g.owner) - (a.id === g.owner) || admins.includes(b.id) - admins.includes(a.id) || a.name.localeCompare(b.name)).map((m) => {
    const isAdmin = admins.includes(m.id);
    const canRemove = manager && m.id !== S.me.id && m.id !== g.owner && (owner || !isAdmin);
    return el('li', {},
      avatar(m.name, { online: m.online, seed: m.id, src: m.id === S.me.id ? S.me.profile?.avatar : m.avatar, uid: m.id }),
      el('span', { class: 'grow ellipsis', text: m.id === S.me.id ? `${m.name} (you)` : m.name + (m.status ? ` · ${m.status}` : '') }),
      m.id === g.owner ? el('span', { class: 'tag', text: 'owner' }) : isAdmin ? el('span', { class: 'tag', text: 'co-owner' }) : null,
      owner && m.id !== S.me.id ? el('button', { type: 'button', class: 'small', text: isAdmin ? 'Remove co-owner' : 'Make co-owner',
        title: isAdmin ? 'They go back to being a member' : 'They can then do what you do, except deleting the group and naming co-owners',
        onclick: () => groupAct(g, isAdmin ? 'unadmin' : 'admin', [m.id]) }) : null,
      canRemove ? iconBtn('x', 'Remove from group', () => groupAct(g, 'remove', [m.id])) : null);
  }));
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
$('gPic').addEventListener('click', () => pickGroupPicture(groupById(groupDlgId)));
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
  refreshFolderSoon();
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
  const letter = ($('sName').value || S.me.name || '?')[0].toUpperCase();
  btn.replaceChildren(src ? bioMediaNode(src) : letter);
  const lt = $('sLetterTile');
  if (lt) { lt.textContent = letter; lt.style.background = `hsl(${hue(S.me.id)} 45% 48%)`; }
}

// ---------- One account on a PC and a phone ----------
const ICON_DEV = {
  pc: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
};
async function renderDevices() {
  const list = await invoke('devices').catch(() => []);
  const phone = document.documentElement.classList.contains('phone');
  const shown = S.me.linked ? list : list.filter((d) => !d.primary);
  $('sDevicesTitle').textContent = S.me.linked || phone ? 'Your PC' : 'Phone';
  $('sDevices').replaceChildren(...shown.map((d) => el('div', { class: 'dev-row' },
    svg(d.primary ? ICON_DEV.pc : ICON_DEV.phone),
    el('span', { class: 'grow', text: d.name + (d.here ? ' (this device)' : '') }),
    el('span', { class: 'sub', text: d.here ? '' : d.online ? 'Online' : 'Offline' }))));
  $('sLinkBtn').classList.toggle('hidden', !!S.me.linked);
  $('sLinkBtn').textContent = phone ? 'Sign in with your PC…' : 'Sign in on your phone…';
  $('sLinkNote').textContent = S.me.linked
    ? 'This device uses your PC’s account. It keeps working when the PC is off; the two catch up when both are on.'
    : phone ? 'Use the same account as on your PC: friends, groups and messages. What is on this phone now is replaced.'
    : 'Your phone gets your friends, groups and messages, and keeps working when this PC is off.';
}
$('sLinkBtn').addEventListener('click', () => {
  if (document.documentElement.classList.contains('phone')) openJoin();
  else openLink();
});
async function openLink() {
  $('linkCode').textContent = '…';
  $('linkStatus').textContent = 'Making a code…';
  $('linkDlg').showModal();
  try {
    $('linkCode').textContent = await invoke('link_start');
    $('linkStatus').textContent = 'The code works for 15 minutes. Keep UaN open on this PC until the phone is done.';
  } catch (e) {
    $('linkCode').textContent = '';
    $('linkStatus').textContent = String(e);
  }
}
$('linkDlg').addEventListener('close', () => invoke('link_cancel').catch(() => {}));
listen('linked', ({ payload }) => {
  $('linkStatus').textContent = `Your ${(payload.name || 'phone').toLowerCase()} is signed in. It gets everything from now on, also while this PC is off.`;
  $('linkCode').textContent = 'Done';
  if ($('settingsDlg').open) renderDevices();
});
function openJoin() {
  $('joinCode').value = '';
  $('joinErr').textContent = '';
  $('joinStatus').textContent = '';
  $('joinGo').disabled = false;
  $('joinDlg').showModal();
  setTimeout(() => $('joinCode').focus(), 50);
}
$('setupLink').addEventListener('click', openJoin);
$('joinCancel').addEventListener('click', () => $('joinDlg').close());
$('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('joinErr').textContent = '';
  $('joinGo').disabled = true;
  $('joinStatus').textContent = 'Looking for your PC…';
  try {
    await invoke('link_join', { code: $('joinCode').value });
    const phone = document.documentElement.classList.contains('phone');
    $('joinStatus').textContent = phone ? 'Signed in. UaN closes now: open it again.' : 'Signed in. UaN starts again…';
    setTimeout(() => invoke('restart_app'), phone ? 2500 : 1200);
  } catch (err) {
    $('joinErr').textContent = String(err);
    $('joinStatus').textContent = '';
    $('joinGo').disabled = false;
  }
});
listen('link-progress', ({ payload }) => {
  $('joinStatus').textContent = `Copying your messages… ${Math.round((payload.done / payload.parts) * 100)}%`;
});
listen('me', async () => {
  S.me = await invoke('state');
  renderMe();
});

$('settingsBtn').addEventListener('click', async () => {
  S.me = await invoke('state');
  renderDevices();
  pendingAvatar = null;
  $('sName').value = S.me.name;
  $('sStatus').value = S.me.profile?.status || '';
  $('sBio').value = S.me.profile?.bio || '';
  pendingBioImg = null;
  ownBioImg = '';
  renderBioMedia();
  if (S.me.profile?.bioimgV) invoke('bio_image', { id: S.me.id }).then((src) => { ownBioImg = src || ''; renderBioMedia(); }).catch(() => {});
  renderAvatarPick();
  $('sTheme').value = theme.mode;
  renderSwatches();
  $('sMailbox').value = S.me.mailbox || '';
  $('sAuto').checked = S.me.autostart;
  $('sTyping').checked = S.me.typing;
  $('sReceipts').checked = S.me.receipts;
  $('sHeads').checked = onlineHeads();
  renderThemeTiles();
  syncTune();
  renderUiStyles();
  $('sZoom').value = String(Math.round(uiZoom * 100));
  $('sZoomVal').textContent = Math.round(uiZoom * 100) + '%';
  renderIconTiles();
  renderAvatarTiles();
  pendingBanner = null;
  renderBannerTiles();
  pendingLook = null;
  renderLookPick();
  $('sAutoDl').checked = S.me.autodl;
  $('sAutoDlGb').value = S.me.autodlGb;
  $('sWifi').checked = S.me.wifiOnly !== false;
  $('sKeepFree').checked = S.me.keepFree !== false;
  $('sDlAsk').checked = S.me.dlAsk !== false;
  $('sDlDir').value = S.me.dlDir || '';
  $('sDlDir').placeholder = S.me.dlPath || 'Downloads';
  $('sAutoDlDir').value = S.me.autodlDir || '';
  $('sAutoDlDir').placeholder = S.me.autodlPath || 'UaN folder';
  $('sAutoDlReset').classList.toggle('hidden', !S.me.autodlDir);
  $('sAutoRow').classList.toggle('hidden', !!S.me.profileName);
  $('sError').textContent = '';
  $('sVersion').textContent = `UaN ${S.me.version}`;
  $('sAboutVer').textContent = `UaN ${S.me.version}`;
  $('sDevCard').classList.toggle('hidden', !S.me.devPanel);
  $('sSuggestNote').textContent = '';
  suggestCount();
  renderUpdateState();
  renderHistory();
  // The phone page carries the name the app gives it; pages that don't exist here (no mailbox on a phone) get no tab.
  const devLabel = $('sDevicesTitle').textContent || 'Phone';
  document.querySelector('.s-tab[data-page="devices"] span').textContent = devLabel;
  document.querySelector('.s-page[data-page="devices"] .s-title').textContent = devLabel;
  for (const [page, group] of [['devices', 'sDevicesGroup'], ['mailbox', 'sMailboxGroup']]) {
    const g = $(group);
    document.querySelector(`.s-tab[data-page="${page}"]`).classList.toggle('hidden', g.classList.contains('hidden') || getComputedStyle(g).display === 'none');
  }
  showSettingsPage('profile');
  $('settingsDlg').showModal();
  settingsReady = true;
  loadTopThemes();
});
function showSettingsPage(name) {
  document.querySelectorAll('.s-tab').forEach((b) => b.classList.toggle('on', b.dataset.page === name));
  document.querySelectorAll('.s-page').forEach((p) => p.classList.toggle('hidden', p.dataset.page !== name));
  $('settingsDlg').querySelector('.s-pages').scrollTop = 0;
}
document.querySelectorAll('.s-tab').forEach((b) => b.addEventListener('click', () => showSettingsPage(b.dataset.page)));
$('sSeeProfile').addEventListener('click', async () => { await saveSettingsNow(); openProfile(S.me.id); });
// The window can be moved by its title bar while a window like Settings is open (the bar is under its shade).
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.tagName !== 'DIALOG' || !document.documentElement.classList.contains('chrome')) return;
  const bar = $('titlebar').getBoundingClientRect();
  if (e.clientY <= bar.bottom) { e.preventDefault(); winCtl('drag'); }
});

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
// ---- About: the text, its formatting buttons, one picture or GIF ----
let pendingBioImg = null; // null = unchanged, '' = removed, data URL = new
let ownBioImg = '';
const BIO_IMG_COST = 300; // a picture takes the place of this many characters
let bioCaret = null; // where the cursor was last in the About box
for (const ev of ['keyup', 'click', 'select', 'blur', 'input']) $('sBio').addEventListener(ev, () => { bioCaret = $('sBio').selectionStart; });
function placeBioPic() {
  const t = $('sBio');
  let v = t.value;
  let pos = bioCaret ?? v.length;
  const old = v.indexOf(BIO_PIC);
  if (old >= 0) { v = v.slice(0, old) + v.slice(old + BIO_PIC.length); if (pos > old) pos = Math.max(old, pos - BIO_PIC.length); }
  pos = Math.min(pos, v.length);
  t.value = v.slice(0, pos) + BIO_PIC + v.slice(pos);
  bioCaret = pos + BIO_PIC.length;
  updateBioCount();
}
const bioImgNow = () => (pendingBioImg === null ? ownBioImg || (S.me.profile?.bioimgV ? 'yes' : '') : pendingBioImg);
const bioLimit = () => (bioImgNow() ? 500 - BIO_IMG_COST : 500);
function updateBioCount() {
  const n = $('sBio').value.length, lim = bioLimit();
  $('sBioCount').textContent = n + ' / ' + lim + (bioImgNow() ? ' · the picture shows where ' + BIO_PIC + ' is in your text (it takes the place of ' + BIO_IMG_COST + ' characters)' : '');
  $('sBioCount').classList.toggle('over', n > lim);
}
function renderBioMedia() {
  const src = pendingBioImg === null ? ownBioImg : pendingBioImg;
  if (src) {
    $('sBioMedia').replaceChildren(el('div', { class: 'bio-prev-row' },
      el('div', { class: 'bio-prev' }, bioMediaNode(src),
        el('button', { type: 'button', class: 'bio-x', title: 'Remove the picture', onclick: () => { pendingBioImg = ''; $('sBio').value = $('sBio').value.split(BIO_PIC).join(''); renderBioMedia(); } }, svg('<path d="M6 6l12 12M18 6 6 18"/>'))),
      el('button', { type: 'button', class: 'small bio-place', title: 'Click in your text first, then here', onmousedown: (e) => e.preventDefault(), onclick: placeBioPic }, 'Put it where the cursor is')));
  } else {
    $('sBioMedia').replaceChildren(el('button', { type: 'button', class: 'bio-add', onclick: () => { $('bioFile').value = ''; $('bioFile').click(); } },
      svg('<path d="M12 5v14M5 12h14"/>'), 'Picture or GIF'));
  }
  updateBioCount();
}
$('sBio').addEventListener('input', updateBioCount);
for (const b of $('sBioTools').querySelectorAll('[data-wrap]')) {
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection in the text
  b.addEventListener('click', () => {
    const t = $('sBio'), w = b.dataset.wrap;
    const s = t.selectionStart, e = t.selectionEnd, v = t.value;
    const sel = v.slice(s, e);
    t.value = v.slice(0, s) + w + sel + w + v.slice(e);
    t.focus();
    if (sel) t.setSelectionRange(s, e + w.length * 2); else t.setSelectionRange(s + w.length, s + w.length);
    updateBioCount();
  });
}
// Makes the picture small enough to send: a small file stays as it is (GIFs keep moving),
// a big GIF becomes a short silent looping video, a big still picture is shrunk.
const BIO_MAX = 940000; // characters of the data URL
const fileToDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
// A tiny WebM writer: VP8 frames from the browser's own encoder, in a file any player loops.
function webmFile(chunks, w, h, durMs) {
  const cat = (parts) => { const n = parts.reduce((a, b) => a + b.length, 0), o = new Uint8Array(n); let k = 0; for (const x of parts) { o.set(x, k); k += x.length; } return o; };
  const uint = (v) => { const b = []; do { b.unshift(v & 255); v = Math.floor(v / 256); } while (v > 0); return new Uint8Array(b); };
  const size = (n) => { const b = new Uint8Array(8); b[0] = 1; for (let k = 7; k >= 1; k--) { b[k] = n & 255; n = Math.floor(n / 256); } return b; };
  const elm = (id, data) => cat([new Uint8Array(id), size(data.length), data]);
  const str = (s) => new TextEncoder().encode(s);
  const f64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return b; };
  const header = elm([0x1a, 0x45, 0xdf, 0xa3], cat([
    elm([0x42, 0x86], uint(1)), elm([0x42, 0xf7], uint(1)), elm([0x42, 0xf2], uint(4)), elm([0x42, 0xf3], uint(8)),
    elm([0x42, 0x82], str('webm')), elm([0x42, 0x87], uint(2)), elm([0x42, 0x85], uint(2))]));
  const info = elm([0x15, 0x49, 0xa9, 0x66], cat([elm([0x2a, 0xd7, 0xb1], uint(1000000)), elm([0x4d, 0x80], str('UaN')), elm([0x57, 0x41], str('UaN')), elm([0x44, 0x89], f64(durMs))]));
  const tracks = elm([0x16, 0x54, 0xae, 0x6b], elm([0xae], cat([
    elm([0xd7], uint(1)), elm([0x73, 0xc5], uint(1)), elm([0x83], uint(1)), elm([0x86], str('V_VP8')),
    elm([0xe0], cat([elm([0xb0], uint(w)), elm([0xba], uint(h))]))])));
  const blocks = chunks.map((c) => {
    const t = Math.round(c.ts / 1000);
    return elm([0xa3], cat([new Uint8Array([0x81, (t >> 8) & 255, t & 255, c.key ? 0x80 : 0]), c.data]));
  });
  const cluster = elm([0x1f, 0x43, 0xb6, 0x75], cat([elm([0xe7], uint(0)), ...blocks]));
  return cat([header, elm([0x18, 0x53, 0x80, 0x67], cat([info, tracks, cluster]))]);
}
async function animToWebm(dec, frames, opts = {}) {
  if (!('VideoEncoder' in window)) throw new Error('no encoder');
  const first = await dec.decode({ frameIndex: 0 });
  const w0 = first.image.displayWidth, h0 = first.image.displayHeight;
  first.image.close();
  const tries = opts.tries || [[480, 360, 700000], [360, 270, 380000], [280, 210, 200000], [220, 165, 120000], [160, 120, 70000]];
  const limit = opts.max || BIO_MAX, maxUs = (opts.maxMs || 30000) * 1000;
  const side0 = Math.min(w0, h0), sx = opts.square ? (w0 - side0) / 2 : 0, sy = opts.square ? (h0 - side0) / 2 : 0;
  const sw = opts.square ? side0 : w0, sh = opts.square ? side0 : h0;
  for (const [mw, mh, bps] of tries) {
    const sc = Math.min(1, mw / sw, mh / sh);
    const w = Math.max(2, Math.round(sw * sc / 2) * 2), h = Math.max(2, Math.round(sh * sc / 2) * 2);
    const cfg = { codec: 'vp8', width: w, height: h, bitrate: bps, framerate: 25 };
    if (!(await VideoEncoder.isConfigSupported(cfg)).supported) throw new Error('no encoder');
    const out = [];
    let failed = null;
    const enc = new VideoEncoder({
      output: (chunk) => { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); out.push({ data: d, ts: chunk.timestamp, key: chunk.type === 'key' }); },
      error: (e) => { failed = e; },
    });
    enc.configure(cfg);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    let t = 0; // microseconds
    for (let i = 0; i < frames && t < maxUs; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const d = Math.max(20000, image.duration || 100000);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, w, h);
      image.close();
      const vf = new VideoFrame(canvas, { timestamp: t, duration: d });
      enc.encode(vf, { keyFrame: i % 30 === 0 });
      vf.close();
      t += d;
    }
    await enc.flush();
    enc.close();
    if (failed || !out.length) throw new Error('no encoder');
    const url = await fileToDataUrl(new Blob([webmFile(out, w, h, t / 1000)], { type: 'video/webm' }));
    if (url.length <= limit) return url;
  }
  throw new Error('too big');
}
async function movingAvatar(file) {
  if (!/gif|webp|png/.test(file.type) || !('ImageDecoder' in window)) return null;
  const dec = new ImageDecoder({ data: await file.arrayBuffer(), type: file.type });
  try {
    await dec.tracks.ready;
    await dec.completed;
    const frames = dec.tracks.selectedTrack?.frameCount || 1;
    if (frames < 2) return null;
    const asIs = await fileToDataUrl(file);
    if (asIs.length <= 190000) return asIs;
    toast('Making the GIF small enough…');
    return await animToWebm(dec, frames, { square: true, tries: [[160, 160, 170000], [128, 128, 110000], [96, 96, 70000], [72, 72, 40000]], max: 195000, maxMs: 30000 });
  } finally { try { dec.close(); } catch {} }
}
async function prepareBioMedia(file) {
  if (!/^image\//.test(file.type)) throw new Error('not a picture');
  const asIs = await fileToDataUrl(file);
  if (asIs.length <= BIO_MAX && file.size <= 650000) return asIs;
  if ('ImageDecoder' in window) {
    let dec = null;
    try {
      dec = new ImageDecoder({ data: await file.arrayBuffer(), type: file.type });
      await dec.tracks.ready;
      await dec.completed;
      const frames = dec.tracks.selectedTrack?.frameCount || 1;
      if (frames > 1) return await animToWebm(dec, frames);
    } catch (e) {
      if (e?.message === 'too big') throw e;
    } finally { try { dec?.close(); } catch {} }
  }
  const img = await createImageBitmap(file);
  const sc = Math.min(1, 720 / img.width, 480 / img.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * sc); canvas.height = Math.round(img.height * sc);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  let q = 0.85, out = canvas.toDataURL('image/webp', q);
  while (out.length > BIO_MAX && q > 0.3) { q -= 0.1; out = canvas.toDataURL('image/webp', q); }
  if (out.length > BIO_MAX) throw new Error('too big');
  return out;
}
$('bioFile').addEventListener('change', async () => {
  const file = $('bioFile').files[0];
  if (!file) return;
  toast('Getting the picture ready…');
  try {
    pendingBioImg = await prepareBioMedia(file);
    if (!$('sBio').value.includes(BIO_PIC)) placeBioPic();
    renderBioMedia();
    toast('Ready. Save to show it on your profile.');
  } catch (e) {
    toast(e?.message === 'too big' ? 'That one is too big even after shrinking. Try a shorter GIF.' : 'That file isn’t a picture or GIF UaN can read.');
  }
});
$('sGithub').addEventListener('click', () => invoke('open_github').catch(() => {}));
// Settings save themselves: a moment after each change, and when the window closes (however it is closed).
let settingsSaving = Promise.resolve(true), settingsTimer = null, settingsReady = false;
function saveSettingsSoon(e) {
  if (!settingsReady || e?.target?.id === 'sSuggest') return;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => { settingsSaving = settingsSaving.then(() => saveSettings()); }, 900);
}
function saveSettingsNow() {
  clearTimeout(settingsTimer);
  settingsSaving = settingsSaving.then(() => saveSettings());
  return settingsSaving;
}
$('settingsForm').addEventListener('input', saveSettingsSoon);
$('settingsForm').addEventListener('change', saveSettingsSoon);
$('settingsDlg').addEventListener('close', () => { if (settingsReady) { settingsReady = false; saveSettingsNow(); } });
$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await saveSettingsNow()) $('settingsDlg').close();
});
async function saveSettings() {
  $('sError').textContent = '';
  try {
    const status = $('sStatus').value.trim();
    const bio = $('sBio').value.trim();
    if (!$('sName').value.trim()) { $('sError').textContent = 'Your name can’t be empty.'; return false; }
    if (bio.length > bioLimit()) { $('sError').textContent = 'Your About is too long: ' + bioLimit() + ' characters at most' + (bioImgNow() ? ' (the picture takes the place of ' + BIO_IMG_COST + ').' : '.'); return false; }
    if ($('sName').value.trim() !== S.me.name || status !== (S.me.profile?.status || '') || bio !== (S.me.profile?.bio || '') || pendingAvatar !== null || pendingBanner !== null || pendingBioImg !== null || pendingLook !== null) {
      await invoke('set_profile', { name: $('sName').value, status, avatar: pendingAvatar, bio, banner: pendingBanner, bioimg: pendingBioImg, look: pendingLook });
      pendingAvatar = null; pendingBanner = null; pendingBioImg = null; pendingLook = null;
    }
    if ($('sMailbox').value.trim() !== (S.me.mailbox || '')) {
      await invoke('set_mailbox', { url: $('sMailbox').value });
      invoke('check_mailbox').catch(() => {});
    }
    await invoke('set_autodl', { on: $('sAutoDl').checked, gb: Math.max(1, Number($('sAutoDlGb').value) || 10) });
    await invoke('set_privacy', { typing: $('sTyping').checked, receipts: $('sReceipts').checked });
    try { localStorage.setItem('uan.onlineHeads', $('sHeads').checked ? '1' : '0'); } catch {}
    renderChatHead();
    S.me = await invoke('state');
    renderMe();
    $('sSaved').classList.add('show');
    clearTimeout(saveSettings.t);
    saveSettings.t = setTimeout(() => $('sSaved').classList.remove('show'), 1600);
    return true;
  } catch (err) { $('sError').textContent = err; return false; }
}

// ---------- Search ----------
function chatLabel(chat) {
  return chatInfo(chat)?.name || (isGroup(chat) ? 'Old group' : 'Former friend');
}

function openSearch(scope = S.active || '') {
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
  $('sChat').value = scope;
  updateSearchTitle();
  $('searchPanel').classList.remove('hidden');
  $('sq').focus();
  $('sq').select();
  runSearch();
}
function closeSearch() { $('searchPanel').classList.add('hidden'); }
function updateSearchTitle() {
  const c = $('sChat').value;
  $('spTitle').textContent = c ? 'Search in ' + chatLabel(c) : 'Search everywhere';
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
    const ext = m.file ? (m.file.name.includes('.') ? m.file.name.split('.').pop() : 'file').slice(0, 4) : '';
    const main = m.file
      ? el('div', { class: 'result-text' }, highlight(m.file.name, q), el('span', { class: 'sub', text: '  ·  ' + fmtBytes(m.file.size) }))
      : highlight(m.text || '', q);
    const who = m.mine ? { name: S.me.name, src: S.me.profile?.avatar } : senderOf(m);
    return el('div', {
      class: 'result',
      title: 'Double-click to go to the message',
      onclick: (e) => {
        if (document.documentElement.classList.contains('phone')) { closeSearch(); openChat(m.chat, m.id); return; }
        for (const r of $('sResults').querySelectorAll('.sel')) r.classList.remove('sel');
        e.currentTarget.classList.add('sel');
      },
      ondblclick: () => { openChat(m.chat, m.id); },
    },
    m.file ? el('div', { class: 'ext', text: ext }) : avatar(who.name, { seed: m.sender, src: who.src }),
    el('div', { class: 'grow', style: 'min-width:0' },
      el('div', { class: 'result-meta' }, el('b', { text: m.mine ? 'You' : who.name }), ' · ' + chatLabel(m.chat) + ' · ' + dayFmt.format(m.ts) + ' ' + timeFmt.format(m.ts)),
      main,
      m.file && m.text ? el('div', { class: 'sub ellipsis', text: m.text }) : null));
  }));
}

$('chatSearchBtn').addEventListener('click', () => openSearch(S.active || ''));
$('searchClose').addEventListener('click', closeSearch);
$('searchPanel').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSearch(); } });
$('sChat').addEventListener('change', updateSearchTitle);

// The slim field above the lists: find a group or a friend (Ctrl+K).
let findQ = '';
function setFind(text) {
  findQ = fold(text.trim());
  $('findClose').classList.toggle('hidden', !text);
  renderLists();
}
$('findClose').addEventListener('click', () => { $('findInput').value = ''; setFind(''); $('findInput').focus(); });
$('findForm').addEventListener('submit', (e) => { e.preventDefault(); const f = $('groupList').firstElementChild || $('friendList').firstElementChild; f?.click(); });
$('findInput').addEventListener('input', () => setFind($('findInput').value));
$('findInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('findInput').value = ''; setFind(''); $('findInput').blur(); } });

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
$('partySetupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const members =[...$('pList').querySelectorAll('input:checked')].map((b) => b.value);
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
// An invitation shows as a card wherever you are in the app (and as the bar inside the group).
const invitesSeen = new Set(); // parties you said "Not now" to
function renderInviteCard() {
  const card = $('partyInvite');
  const p = [...S.parties.values()].find((x) => x.state !== 'ended' && x.leader !== S.me.id && !invitesSeen.has(x.id)
    && x.members.some((m) => m.id === S.me.id && !m.joined && !m.left));
  const here = p && groupIdOf(S.active) === p.group && !$('chat').classList.contains('hidden');
  card.classList.toggle('hidden', !p || here || openPartyId === p?.id);
  if (!p || here) return;
  const host = p.members.find((m) => m.id === p.leader);
  const g = groupById(p.group);
  const join = (full) => async () => {
    card.classList.add('hidden');
    try { await invoke('party_join', { id: p.id, full }); openParty(p.id); } catch (e) { toast(e); }
  };
  card.replaceChildren(
    el('div', { class: 'pi-head' },
      avatar(host?.name || '?', { seed: p.leader, src: g?.members.find((m) => m.id === p.leader)?.avatar }),
      el('div', { class: 'grow' },
        el('div', { class: 'strong', text: `${host?.name || 'Someone'} invited you to watch together` }),
        el('div', { class: 'sub ellipsis', text: `${p.file.name}${g ? ` · ${g.name}` : ''}` }))),
    el('div', { class: 'pi-btns' },
      el('button', { class: 'accent', type: 'button', text: 'Join', title: 'Streams the film, nothing is downloaded', onclick: join(false) }),
      el('button', { type: 'button', text: 'Download first', title: 'Downloads the whole film before it starts (smoothest)', onclick: join(true) }),
      el('button', { type: 'button', text: 'Not now', onclick: () => { invitesSeen.add(p.id); invoke('party_leave', { id: p.id }).catch(() => {}); S.parties.delete(p.id); renderInviteBar(); } })));
}
function renderInviteBar() {
  renderInviteCard();
  const bar = $('inviteBar');
  const p = [...S.parties.values()].find((x) => groupIdOf(S.active) === x.group && x.state !== 'ended' && x.members.some((m) => m.id === S.me.id && !m.joined && !m.left));
  bar.classList.toggle('hidden', !p);
  if (!p) return;
  const host = p.members.find((m) => m.id === p.leader)?.name || 'Someone';
  bar.replaceChildren(
    svg(ICON.bigplay),
    el('span', { class: 'grow ellipsis', text: `${host} invited you to watch “${p.file.name}” together` }),
    el('button', { class: 'accent small', type: 'button', text: 'Join', title: 'Streams the film, nothing is downloaded', onclick: async () => { await invoke('party_join', { id: p.id, full: false }).catch(toast); openParty(p.id); } }),
    el('button', { class: 'small', type: 'button', text: 'Join, download first', title: 'Downloads the whole film before it starts (smoothest; kept in your UaN folder)', onclick: async () => { await invoke('party_join', { id: p.id, full: true }).catch(toast); openParty(p.id); } }),
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
    watchSound(v, p.file, async (what = 'sound') => {
      if (what === 'sound' && openPartyId === id && partyPlayer?.video === v && !noAutoVlc.has(id)
        && await startAudioAssist(v, p.file, () => toVlc('sound'))) {
        toast('This film’s sound plays through VLC in the background, still in sync with everyone.');
        return;
      }
      toVlc(what);
    });
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
    const status = !m.joined ? (m.id === p.leader ? 'host' : leader ? (m.reached ? 'got the invite, not joined yet' : m.note ? `invite not delivered yet: ${m.note}; trying again` : 'sending the invite…') : 'invited')
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
    : 'Download the whole film before watching: smoothest playback, the party waits for you. A copy is kept in your UaN folder.';
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

  }
  renderInviteBar();
});

// ---------- Profile picture ----------
async function pickAvatar() {
  $('avatarFile').value = '';
  $('avatarFile').click();
}
$('sAvatarBtn').addEventListener('click', pickAvatar);
$('sName').addEventListener('input', renderAvatarPick);
$('avatarFile').addEventListener('change', async () => {
  const file = $('avatarFile').files[0];
  if (!file) return;
  try {
    // A GIF stays a GIF when it is small; a big one becomes a short square clip (it still moves).
    const moving = await movingAvatar(file);
    if (moving) { pendingAvatar = moving; renderAvatarPick(); return; }
  } catch (e) {
    $('sError').textContent = e?.message === 'too big' ? 'That GIF is too big even after shrinking. Try a shorter one.' : '';
    if (e?.message === 'too big') return;
  }
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
  { id: 'light', name: 'Light', preview: ['#f6f6f7', '#ffffff'] },
  { id: 'dark', name: 'Dark', preview: ['#1c1c1c', '#222222'] },
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
// Your own themes (the + tile): an .html page, a video or a picture behind the panels.
let customThemes = (() => { try { return JSON.parse(localStorage.getItem('uan.customThemes') || '[]'); } catch { return []; } })();
const customTheme = (c) => (c.base === 'light'
  ? { id: `custom:${c.id}`, name: c.name, base: 'light', custom: c, ...GLASS_LIGHT, bg: '#e9e9ee', dialog: '#f6f6f9', head: 'rgba(255, 255, 255, .78)', composer: 'rgba(255, 255, 255, .9)', accent: c.accent || undefined }
  : { id: `custom:${c.id}`, name: c.name, base: 'dark', custom: c, bg: '#0b0b10', side: 'rgba(8, 8, 12, .62)', panel: 'rgba(8, 8, 12, .36)', card: 'rgba(22, 22, 28, .8)', theirs: 'rgba(18, 18, 22, .84)', dialog: '#15151b', head: 'rgba(7, 7, 11, .42)', composer: 'rgba(16, 14, 18, .86)', transfers: 'rgba(7, 7, 11, .62)', shade: '0 1px 3px rgba(0, 0, 0, .95), 0 0 12px rgba(0, 0, 0, .7)', accent: c.accent || undefined });
const themeById = (id) => {
  if (id === 'secret' || id === 'horizon') id = 'dark'; // themes that were removed
  if (id?.startsWith('custom:')) {
    const c = customThemes.find((x) => `custom:${x.id}` === id);
    return c ? customTheme(c) : THEMES[0];
  }
  return THEMES.find((t) => t.id === id) || THEMES[0];
};
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
const THEME_VARS = { bg: '--bg', side: '--side', panel: '--panel', card: '--card', theirs: '--theirs', image: '--bg-image', dialog: '--dialog', head: '--head-bg', composer: '--composer-bg', transfers: '--transfers-bg', shade: '--text-shade' };
function applyTheme() {
  setTimeout(() => { if ($('settingsDlg').open) renderPingRows(); }, 0);
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
  setBackdrop(t.custom || null);
}

// The background of one of your own themes. An .html page runs in a locked-down frame: its scripts
// can draw and animate, but cannot reach UaN, your files or the internet.
const THEME_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:";
function wrapThemeHtml(html) {
  const guard = `<meta http-equiv="Content-Security-Policy" content="${THEME_CSP}"><script>for (const k of ['__TAURI__', '__TAURI_INTERNALS__', '__TAURI_INVOKE_KEY__', '__TAURI_PATTERN__', 'ipc']) { try { Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false }); } catch (e) { try { delete window[k]; } catch (e2) {} } }</` + `script>`;
  const m = html.match(/<!doctype[^>]*>/i);
  return m ? html.replace(m[0], m[0] + guard) : `<!doctype html>${guard}${html}`;
}
const themeFileUrl = (c) => `${S.me?.mediaBase || convertFileSrc('', 'media').replace(/\/$/, '')}/_theme/${encodeURIComponent(c.file)}/${c.size}/${encodeURIComponent(c.mime)}`;
let backdrop = null;
function setBackdrop(c) {
  const root = document.documentElement;
  if (!c) {
    delete root.dataset.backdrop;
    backdrop?.node.remove();
    backdrop = null;
    return;
  }
  root.dataset.backdrop = c.base === 'light' ? 'light' : 'dark';
  if (backdrop?.id === c.id) { applyTune(c); return; }
  if (!S.me) return; // (before the app has started, the media address isn't known yet)
  backdrop?.node.remove();
  const node = el('div', { class: 'backdrop', 'aria-hidden': 'true' });
  document.body.prepend(node);
  backdrop = { id: c.id, node, video: null, c };
  if (c.kind === 'video') {
    const v = el('video', { src: themeFileUrl(c), loop: true, playsinline: true, preload: 'auto' });
    v.muted = !c.sound;
    v.autoplay = true;
    v.disablePictureInPicture = true;
    backdrop.video = v;
    node.append(v);
    if (!document.hidden) v.play().catch(() => {});
  } else if (c.kind === 'image') {
    node.append(el('img', { src: themeFileUrl(c), alt: '' }));
  } else {
    // Scripts run only on Windows, where the frame is proven to be cut off from the app (see the tests).
    // Elsewhere the page is shown without scripts: its CSS still animates.
    const frame = el('iframe', { sandbox: S.me.platform === 'windows' ? 'allow-scripts' : '', referrerpolicy: 'no-referrer', tabindex: '-1', title: '' });
    node.append(frame);
    invoke('theme_html', { id: c.id }).then((html) => { if (backdrop?.id === c.id) frame.srcdoc = wrapThemeHtml(html); }).catch(() => {});
  }
  applyTune(c);
}

// ---------- Adjusting your own theme: sound on/off, volume, blur, brightness ----------
const TUNE_DEFAULT = { vol: 60, bright: 100, blur: 0 };
const tuneOf = (c) => ({ ...TUNE_DEFAULT, ...(c?.tune || {}) });
// Something else is playing (the film viewer, a watch party, a sound in a message): the background stays quiet.
function mediaBusy() {
  // UaN hidden in the tray or minimized: the theme makes no sound (it starts again when the window is back).
  if (document.hidden) return true;
  if (!$('viewer').classList.contains('hidden') || !$('party').classList.contains('hidden')) return true;
  // In a call or a voice channel (or it is ringing): the theme's sound would talk over people.
  if ((typeof VC !== 'undefined' && VC.chat) || (typeof sfxLoopName !== 'undefined' && sfxLoopName)) return true;
  // Only what can be heard counts: a moving profile picture or an About GIF is a silent clip and must not quiet the theme.
  return [...document.querySelectorAll('video, audio')].some((m) => m !== backdrop?.video && !m.paused && !m.ended && !m.muted && m.volume > 0);
}
function syncBackdropSound() { if (backdrop?.c) applyTune(backdrop.c); }
for (const ev of ['play', 'pause', 'ended']) document.addEventListener(ev, syncBackdropSound, true);
new MutationObserver(syncBackdropSound).observe($('viewer'), { attributes: true, attributeFilter: ['class'] });
new MutationObserver(syncBackdropSound).observe($('party'), { attributes: true, attributeFilter: ['class'] });
function applyTune(c) {
  if (!backdrop || backdrop.id !== c.id) return;
  backdrop.c = c;
  const t = tuneOf(c);
  const s = backdrop.node.style;
  s.setProperty('--bb', String(t.bright / 100));
  s.setProperty('--bblur', `${t.blur}px`);
  if (backdrop.video) {
    backdrop.video.volume = Math.min(1, Math.max(0, t.vol / 100));
    // The sound only plays while UaN is the window you are using.
    backdrop.video.muted = !c.sound || t.vol === 0 || document.hidden || !document.hasFocus() || mediaBusy();
  }
}
let tuneSaveTimer = null;
function saveTune(c) {
  clearTimeout(tuneSaveTimer);
  tuneSaveTimer = setTimeout(() => {
    invoke('theme_tune', { id: c.id, tune: c.tune || {} }).catch(() => {});
    try { localStorage.setItem('uan.customThemes', JSON.stringify(customThemes)); } catch {}
  }, 250);
}
let tuning = null; // the theme whose panel is open
const TUNE_ICON = {
  sound: '<path d="M4 9v6h4l5 4V5L8 9Z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9Z"/><path d="m17 9 4 6M21 9l-4 6"/>',
  bright: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  blur: '<path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11Z"/>',
  panels: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  color: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4.1-4-7.4-9-7.4Z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15" cy="7.5" r="1"/>',
};
function renderTune() {
  const c = tuning;
  if (!c) return;
  const t = tuneOf(c);
  $('tuneName').textContent = c.name;
  const video = c.kind === 'video';
  const set = (key, v) => { c.tune = { ...(c.tune || {}), [key]: v }; applyTune(c); saveTune(c); };
  const row = (icon, label, ...ctl) => el('div', { class: 'wp-row' }, svg(TUNE_ICON[icon]), el('span', { class: 'wp-lbl', text: label }), ...ctl);
  // Whole numbers only. For volume and blur the slider moves along a curve, so the small values are easy to hit.
  const slider = (key, icon, label, min, max, curve = false) => {
    const whole = (v) => Math.round(v);
    const clamp = (v) => Math.min(max, Math.max(min, whole(v)));
    const show = (v) => String(whole(v));
    const toPos = (v) => Math.round((curve ? Math.sqrt(Math.max(0, (v - min) / (max - min))) : (v - min) / (max - min)) * 1000);
    const fromPos = (p) => min + (max - min) * (curve ? (p / 1000) ** 2 : p / 1000);
    const num = el('input', { type: 'number', class: 'wp-num', min, max, step: 1, value: show(t[key]), 'aria-label': label + ' (number)' });
    const input = el('input', { type: 'range', class: 'wp-range', min: 0, max: 1000, step: 1, value: toPos(t[key]), 'aria-label': label });
    input.addEventListener('input', () => { const v = clamp(fromPos(Number(input.value))); num.value = show(v); set(key, v); });
    num.addEventListener('input', () => {
      if (num.value === '' || !Number.isFinite(Number(num.value))) return;
      const v = clamp(Number(num.value));
      input.value = toPos(v);
      set(key, v);
    });
    num.addEventListener('change', () => {
      const v = num.value !== '' && Number.isFinite(Number(num.value)) ? clamp(Number(num.value)) : clamp(fromPos(Number(input.value)));
      num.value = show(v);
      input.value = toPos(v);
      set(key, v);
    });
    return row(icon, label, input, num);
  };
  const rows = [];
  if (video) {
    const box = el('input', { type: 'checkbox', class: 'wp-check', 'aria-label': 'Sound' });
    box.checked = !!c.sound;
    box.addEventListener('change', async () => {
      c.sound = box.checked;
      if (c.sound && tuneOf(c).vol === 0) c.tune = { ...(c.tune || {}), vol: TUNE_DEFAULT.vol };
      applyTune(c);
      await invoke('theme_sound', { id: c.id, on: c.sound }).catch(toast);
      saveTune(c);
      renderTune();
      renderThemeTiles();
    });
    rows.push(row(c.sound ? 'sound' : 'mute', 'Sound', box));
    rows.push(slider('vol', 'sound', 'Volume', 0, 100, true));
  }
  rows.push(slider('blur', 'blur', 'Blur', 0, 40, true));
  rows.push(slider('bright', 'bright', 'Brightness', 20, 160));
  // The interface colour (buttons, links, highlights) that goes with this theme.
  const pick = el('input', { type: 'color', class: 'wp-color', value: c.accent || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().slice(0, 7) || '#4cc2ff', 'aria-label': 'Interface colour' });
  const auto = el('button', { type: 'button', class: 'small wp-auto' + (c.accent ? '' : ' hidden'), text: 'Auto', title: 'Back to the usual colour' });
  let colorT;
  pick.addEventListener('input', () => {
    c.accent = pick.value;
    auto.classList.remove('hidden');
    applyTheme();
    clearTimeout(colorT);
    colorT = setTimeout(() => invoke('theme_accent', { id: c.id, accent: c.accent }).then(loadCustomThemes).catch(toast), 400);
  });
  auto.addEventListener('click', async () => {
    c.accent = null;
    auto.classList.add('hidden');
    await invoke('theme_accent', { id: c.id, accent: null }).catch(toast);
    await loadCustomThemes();
    renderTune();
  });
  rows.push(row('color', 'Interface colour', pick, auto));
  // The panels over the theme: dark or light glass.
  const seg = el('div', { class: 'wp-seg' }, ...['dark', 'light'].map((b) => el('button', { type: 'button', class: c.base === b ? 'on' : '', text: b === 'dark' ? 'Dark' : 'Light', onclick: async () => {
    if (c.base === b) return;
    c.base = b;
    applyTheme();
    await invoke('theme_base', { id: c.id, base: b }).catch(toast);
    await loadCustomThemes();
    renderTune();
  } })));
  rows.push(row('panels', 'Panels', seg));
  $('tuneRows').replaceChildren(...rows);
}
// The panel opens in the Appearance page itself, right under the theme tiles (above the colours),
// and the settings stay where they are, in the middle.
function placeTune() {
  const panel = $('themeTune');
  if (panel.previousElementSibling !== $('sThemes')) $('sThemes').after(panel);
}
function openTune(c) {
  tuning = c;
  placeTune();
  $('themeTune').classList.remove('hidden');
  renderTune();
}
// The adjust panel is shown by itself whenever the theme in use is one of your own (the X hides it until you pick a theme again).
function syncTune() {
  const c = theme.mode.startsWith('custom:') ? customThemes.find((x) => `custom:${x.id}` === theme.mode) : null;
  if (c) openTune(c); else closeTune();
}
function closeTune() {
  tuning = null;
  $('themeTune').classList.add('hidden');
  $('settingsDlg').classList.remove('tuning');
}
$('tuneClose').addEventListener('click', closeTune);
$('settingsDlg').addEventListener('close', closeTune);
// Closed windows don't keep clips running in the background (pictures, previews), and the theme gets its sound back.
for (const d of ['settingsDlg', 'profileDlg', 'wsDlg', 'wsViewDlg']) {
  $(d).addEventListener('close', () => { for (const v of $(d).querySelectorAll('video')) v.pause(); syncBackdropSound(); });
}
$('tuneReset').addEventListener('click', () => {
  if (!tuning) return;
  tuning.tune = {};
  applyTune(tuning);
  saveTune(tuning);
  renderTune();
});

async function loadCustomThemes() {
  try {
    customThemes = await invoke('themes');
    localStorage.setItem('uan.customThemes', JSON.stringify(customThemes));
  } catch {}
  if (theme.mode.startsWith('custom:') && !customThemes.some((c) => `custom:${c.id}` === theme.mode)) setTheme('dark');
  else applyTheme();
  if ($('settingsDlg').open) {
    renderThemeTiles();
    // The themes were read again: the panel works on the fresh copy of the theme.
    if (tuning) {
      const fresh = customThemes.find((x) => x.id === tuning.id);
      if (fresh) { tuning = fresh; renderTune(); } else closeTune();
    }
  }
}
$('themeFile').addEventListener('change', async () => {
  const f = $('themeFile').files[0];
  $('themeFile').value = '';
  if (!f) return;
  try {
    let base = 'dark';
    let accent = null;
    if (/\.html?$/i.test(f.name)) {
      // A page can say which panels suit it: <meta name="uan-theme" content="light"> and <meta name="uan-accent" content="#ff8800">
      const head = await f.slice(0, 65536).text();
      if (/<meta[^>]+name=["']uan-theme["'][^>]+content=["']light["']/i.test(head)) base = 'light';
      accent = head.match(/<meta[^>]+name=["']uan-accent["'][^>]+content=["'](#[0-9a-f]{6})["']/i)?.[1] || null;
    }
    toast('Adding the theme…');
    const path = await uploadFile(f);
    const t = await invoke('theme_add', { path, name: f.name.replace(/\.[^.]+$/, ''), base, accent });
    await themeAdded(t);
  } catch (e) {
    toast(e);
  }
});
async function themeAdded(t) {
  if (t.kind === 'video' && await ask(`“${t.name}” is a video. Play its sound too? (You can change this any time: right-click the theme.)`, 'Sound on')) {
    await invoke('theme_sound', { id: t.id, on: true }).catch(() => {});
  }
  await loadCustomThemes();
  setTheme(`custom:${t.id}`);
  toast(`Theme added: ${t.name}.`);
}
async function removeTheme(c) {
  if (!(await ask(`Remove your theme “${c.name}”?`, 'Remove'))) return;
  await invoke('theme_remove', { id: c.id }).catch(toast);
  if (theme.mode === `custom:${c.id}`) setTheme('dark');
  await loadCustomThemes();
}
function themeMenu(c) {
  return [
    { label: theme.mode === `custom:${c.id}` ? 'In use' : 'Use this theme', run: () => setTheme(`custom:${c.id}`) },
    { label: 'Theme settings…', run: () => { if (theme.mode !== `custom:${c.id}`) setTheme(`custom:${c.id}`); openTune(customThemes.find((x) => x.id === c.id) || c); } },
    c.kind === 'video' ? { label: c.sound ? 'Turn the sound off' : 'Turn the sound on', run: async () => {
      await invoke('theme_sound', { id: c.id, on: !c.sound }).catch(toast);
      await loadCustomThemes();
    } } : null,
    { label: 'Send to friends…', run: () => openPick('theme', null, c) },
    '-',
    { label: 'Remove theme…', danger: true, run: () => removeTheme(c) },
  ];
}
// Any picture, video or .html page someone sent can become your theme.
const themeable = (f) => f && (IMAGE.test(f.mime) || /^video\//i.test(f.mime) || /\.html?$/i.test(f.name)) && f.size <= 1024 * 1024 * 1024;
async function useAsTheme(f) {
  try {
    toast('Adding the theme…');
    const r = await fetch(mediaUrl(f));
    if (!r.ok) throw new Error(r.status === 503 ? 'Can’t reach the sender’s PC right now.' : `Couldn’t load it (${r.status}).`);
    const blob = await r.blob();
    const name = f.name.split(/[\\/]/).pop();
    let base = 'dark', accent = null;
    if (/\.html?$/i.test(name)) {
      const head = await blob.slice(0, 65536).text();
      if (/<meta[^>]+name=["']uan-theme["'][^>]+content=["']light["']/i.test(head)) base = 'light';
      accent = head.match(/<meta[^>]+name=["']uan-accent["'][^>]+content=["'](#[0-9a-f]{6})["']/i)?.[1] || null;
    }
    const path = await uploadFile(new File([blob], name));
    await themeAdded(await invoke('theme_add', { path, name: name.replace(/\.[^.]+$/, '').replace(/^Theme$/, 'My theme'), base, accent }));
  } catch (e) {
    toast(e.message || e);
  }
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
  syncTune();
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
  const add = el('button', { type: 'button', class: 'add-theme', title: 'Add your own theme: an .html page, a video or a picture', 'aria-label': 'Add your own theme', onclick: () => $('themeFile').click() },
    svg('<path d="M12 5v14M5 12h14"/>'));
  $('sThemes').replaceChildren(...[...THEMES, ...customThemes.map(customTheme)].map((t) => {
    if (t.custom) {
      const c = t.custom;
      const tile = el('span', { class: 'tile custom' },
        c.kind === 'image' ? el('img', { src: themeFileUrl(c), alt: '', loading: 'lazy' })
          : c.kind === 'video' ? el('video', { src: `${themeFileUrl(c)}#t=1`, preload: 'metadata', muted: true, tabindex: '-1' })
          : svg('<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12"/>'));
      const trash = el('span', { class: 't-trash', role: 'button', tabindex: '0', title: 'Remove this theme', 'aria-label': `Remove ${t.name}`,
        onclick: (e) => { e.stopPropagation(); removeTheme(c); }, onkeydown: (e) => { if (e.key === 'Enter') { e.stopPropagation(); removeTheme(c); } } },
      svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'));
      const sound = c.kind === 'video' && c.sound ? el('span', { class: 't-sound', title: 'Plays its sound' }, svg('<path d="M4 9v6h4l5 4V5L8 9Z"/><path d="M16 9a4 4 0 0 1 0 6"/>')) : null;
      return el('button', { type: 'button', class: 'custom-tile' + (t.id === theme.mode ? ' on' : ''), title: `${t.name} (your own theme: double-click for its settings, right-click for more)`, 'data-theme-id': t.id,
        onclick: () => { if (theme.mode !== t.id) setTheme(t.id); },
        ondblclick: () => { if (theme.mode !== t.id) setTheme(t.id); const cur = customThemes.find((x) => x.id === c.id); if (cur) openTune(cur); },
        oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); showMenu(e.clientX, e.clientY, themeMenu(c)); } },
      tile, sound, trash, el('span', { class: 't-name', text: t.name }));
    }
    const sideC = t.side || t.preview?.[0];
    const mainC = t.panel || t.preview?.[1];
    const tile = el('span', { class: 'tile' });
    if (t.id === 'system') {
      tile.style.background = 'linear-gradient(135deg, #fbfbfb 50%, #272727 50%)';
    } else {
      tile.style.background = t.tile || t.image || t.bg || mainC;
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
  }), add);
  renderTopThemes();
}
$('sTheme').addEventListener('change', () => setTheme($('sTheme').value));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();

// ---------- Interface style: the shape and feel of the panels (Default changes nothing) ----------
const UI_STYLES = [
  { id: 'default', name: 'Default' },
  { id: 'glass', name: 'Liquid glass' },
  { id: 'pixel', name: 'Pixel' },
  { id: 'flat', name: 'Flat' },
  { id: 'retro', name: 'Retro' },
  { id: 'neon', name: 'Neon' },
  { id: 'terminal', name: 'Terminal' },
  { id: 'soft', name: 'Soft' },
  { id: 'brutal', name: 'Brutal' },
  { id: 'paper', name: 'Paper' },
  { id: 'aero', name: 'Aero' },
  { id: 'bubble', name: 'Bubble' },
  { id: 'holo', name: 'Holo' },
];
// ---------- Interface size: the whole window's zoom, kept for next time ----------
let uiZoom = (() => { try { const z = parseFloat(localStorage.getItem('uan.zoom') || '1'); return z >= 0.7 && z <= 1.6 ? z : 1; } catch { return 1; } })();
function setZoom(z, save = true) {
  uiZoom = Math.min(1.6, Math.max(0.7, Math.round(z * 20) / 20));
  if (save) { try { if (uiZoom === 1) localStorage.removeItem('uan.zoom'); else localStorage.setItem('uan.zoom', String(uiZoom)); } catch {} }
  document.documentElement.style.zoom = uiZoom === 1 ? '' : String(uiZoom);
  document.documentElement.style.setProperty('--uiz', String(uiZoom));
  if ($('sZoom')) { $('sZoom').value = String(Math.round(uiZoom * 100)); $('sZoomVal').textContent = Math.round(uiZoom * 100) + '%'; }
}
$('sZoom').addEventListener('input', () => { $('sZoomVal').textContent = $('sZoom').value + '%'; });
$('sZoom').addEventListener('change', () => setZoom(Number($('sZoom').value) / 100));
$('sZoomReset').addEventListener('click', () => setZoom(1));
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey) return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(uiZoom + 0.05); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(uiZoom - 0.05); }
  else if (e.key === '0') { e.preventDefault(); setZoom(1); }
});
let uiStyle = (() => { try { const v = localStorage.getItem('uan.ui'); return UI_STYLES.some((u) => u.id === v) ? v : 'default'; } catch { return 'default'; } })();
function applyUiStyle() {
  if (uiStyle === 'default') delete document.documentElement.dataset.ui;
  else document.documentElement.dataset.ui = uiStyle;
}
function setUiStyle(id) {
  uiStyle = UI_STYLES.some((u) => u.id === id) ? id : 'default';
  try { if (uiStyle === 'default') localStorage.removeItem('uan.ui'); else localStorage.setItem('uan.ui', uiStyle); } catch {}
  applyUiStyle();
  renderUiStyles();
}
function renderUiStyles() {
  $('sUiStyles').replaceChildren(...UI_STYLES.map((u) => el('button', { type: 'button', class: u.id === uiStyle ? 'on' : '', 'data-ui-id': u.id, title: u.name, onclick: () => setUiStyle(u.id) },
    el('div', { class: 'uis-prev' }, el('i'), el('i')), el('span', { class: 'uis-name', text: u.name }))));
}
applyUiStyle();

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
  { name: 'Mushroom', from: '#e0a96d', to: '#8a4f22', draw: (c, bg) => {
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
let pendingBanner = null; // null = unchanged, '' = none
let bannerTarget = null; // who gets the picture chosen with the + tile
// The picker: ready-made backgrounds, then your own (a picture with +, or any colour).
function bannerGrid(current, onPick, live) {
  const wrap = el('div', { class: 'banner-picker' });
  const mk = (spec, title) => {
    const b = el('button', { type: 'button', class: 'banner-tile', title, 'data-spec': spec, onclick: () => onPick(spec) });
    b.style.background = bannerStyle(spec, S.me.id);
    return b;
  };
  const plus = el('button', { type: 'button', class: 'banner-tile banner-plus', title: 'Use your own picture', onclick: () => { bannerTarget = onPick; $('bannerFile').value = ''; $('bannerFile').click(); } }, svg('<path d="M12 5v14M5 12h14"/>'));
  const colour = el('label', { class: 'banner-tile banner-colour', title: 'Pick any colour' },
    svg('<path d="M4 20c3 0 5-1 5-3.5L18.5 7a2.1 2.1 0 0 0-3-3L6 13.5C4 14 4 17 4 20Z"/><path d="m14 6 4 4"/>'),
    el('input', { type: 'color', value: '#5b6cf0', 'aria-label': 'Colour', oninput: (e) => { if (live) onPick('c:' + e.target.value); }, onchange: (e) => { if (!live) onPick('c:' + e.target.value); } }));
  wrap.append(
    el('div', { class: 'banner-label', text: 'Ready-made' }),
    el('div', { class: 'banner-grid' }, mk('', 'Default (your colour)'), ...BANNERS.map((b) => mk('g:' + b.id, b.name))),
    el('div', { class: 'banner-label', text: 'Your own' }),
    el('div', { class: 'banner-grid' }, plus, colour));
  wrap.mark = (cur) => {
    for (const b of wrap.querySelectorAll('[data-spec]')) b.classList.toggle('on', b.dataset.spec === cur);
    plus.classList.toggle('on', cur.startsWith('data:image/'));
    colour.classList.toggle('on', cur.startsWith('c:'));
    colour.style.background = cur.startsWith('c:') ? cur.slice(2) : '';
  };
  wrap.mark(current || '');
  return wrap;
}
function renderBannerPick() {
  const cur = pendingBanner === null ? (S.me.profile?.banner || '') : pendingBanner;
  $('sBannerPrev').style.background = bannerStyle(cur, S.me.id);
  $('sBanners').firstElementChild?.mark(cur);
}
function renderBannerTiles() {
  const cur = pendingBanner === null ? (S.me.profile?.banner || '') : pendingBanner;
  $('sBanners').replaceChildren(bannerGrid(cur, (spec) => { pendingBanner = spec; renderBannerPick(); }, true));
  renderBannerPick();
}
$('bannerFile').addEventListener('change', async () => {
  const file = $('bannerFile').files[0];
  if (!file) return;
  try {
    const img = await createImageBitmap(file);
    const W = 720, H = 240;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const r = Math.max(W / img.width, H / img.height), sw = W / r, sh = H / r;
    canvas.getContext('2d').drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, W, H);
    let q = 0.82, out = canvas.toDataURL('image/jpeg', q);
    while (out.length > 190000 && q > 0.3) { q -= 0.1; out = canvas.toDataURL('image/jpeg', q); }
    (bannerTarget || ((spec) => { pendingBanner = spec; renderBannerPick(); }))(out);
  } catch {
    toast('That file isn’t a picture UaN can read.');
  }
});
let pendingLook = null; // null = unchanged
const LOOK_COLOURS = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
function renderLookPick() {
  const look = pendingLook === null ? (S.me.profile?.look || '') : pendingLook;
  const [c0, a0] = look.split('|');
  const c = /^#[0-9a-fA-F]{6}$/.test(c0 || '') ? c0 : '', a = '';
  void a0;
  const set = (nc) => { pendingLook = nc ? nc + '|' : ''; renderLookPick(); };
  const sw = (col) => {
    const b = el('button', { type: 'button', class: 'look-sw' + (col === c ? ' on' : '') + (col ? '' : ' none'), title: col || 'No colour', onclick: () => set(col, a) }, col ? null : svg('<path d="M6 6l12 12"/>'));
    if (col) b.style.background = col;
    return b;
  };
  const custom = c && !LOOK_COLOURS.includes(c);
  const brush = el('label', { class: 'look-sw brush' + (custom ? ' on' : ''), title: 'Any colour' }, svg('<path d="M4 20c3 0 5-1 5-3.5L18.5 7a2.1 2.1 0 0 0-3-3L6 13.5C4 14 4 17 4 20Z"/><path d="m14 6 4 4"/>'),
    el('input', { type: 'color', value: c || '#8b5cf6', onchange: (e) => set(e.target.value, a) }));
  if (custom) { brush.style.background = c; brush.style.color = '#fff'; }
  $('sLookColours').replaceChildren(sw(''), ...LOOK_COLOURS.map(sw), brush);
}
function renderAvatarTiles() {
  const letterTile = el('button', { type: 'button', id: 'sLetterTile', class: 'letter-tile', title: 'Your first letter (the default)', onclick: () => { pendingAvatar = ''; renderAvatarPick(); } });
  $('sAvatars').replaceChildren(letterTile, ...AVATARS.map((a) => {
    const canvas = el('canvas', { width: 72, height: 72 });
    drawAvatar(canvas, a);
    return el('button', { type: 'button', title: a.name, onclick: () => {
      const big = document.createElement('canvas');
      big.width = big.height = 160;
      drawAvatar(big, a);
      pendingAvatar = big.toDataURL('image/jpeg', 0.9);
      renderAvatarPick();
    } }, canvas);
  }));
  renderAvatarPick();
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
      const badge = el('span', { class: 'g-dur' });
      if (m.thumb?.img) {
        thumb = el('img', { src: m.thumb.img, alt: '', loading: 'lazy' });
        if (isVideo && m.thumb.dur) badge.textContent = fmtTime(m.thumb.dur);
      } else if (isImg) {
        thumb = el('img', { src: mediaUrl(m.file), alt: '', loading: 'lazy' });
      } else if (isVideo && videoThumbs++ < 24) {
        // A frame from a fifth of the way in (the first seconds are often a logo or black).
        thumb = el('video', { src: mediaUrl(m.file), preload: 'metadata', muted: true, tabindex: '-1' });
        thumb.addEventListener('loadedmetadata', () => {
          badge.textContent = fmtTime(thumb.duration);
          if (isFinite(thumb.duration)) thumb.currentTime = Math.min(thumb.duration * 0.2, 900);
        }, { once: true });
      } else {
        thumb = el('span', { class: 'g-blank' }, svg(ICON.bigplay));
      }
      const list = items.map((x) => x.file);
      nodes.push(el('button', {
        type: 'button',
        class: 'g-item',
        title: `${m.file.name}\n${fmtBytes(m.file.size)} · ${m.mine ? 'You' : m.senderName} · ${dayFmt.format(m.ts)}`,
        onclick: () => { $('galleryDlg').close(); openViewer(m.file, { list, chat }); },
        oncontextmenu: (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, printMenu(m)); },
      },
      el('span', { class: 'g-print' }, thumb, isVideo ? el('span', { class: 'g-play' }, svg(ICON.bigplay)) : null, badge),
      el('span', { class: 'g-name', text: m.file.name.split(/[\\/]/).pop() }),
      el('span', { class: 'g-meta', text: `${fmtBytes(m.file.size)} · ${m.mine ? 'You' : m.senderName} · ${shortDayFmt.format(m.ts)}` })));
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

// Where automatic downloads go
$('sAuto').addEventListener('change', async () => {
  if (S.me.profileName) return;
  try {
    const on = await invoke('set_autostart', { enabled: $('sAuto').checked });
    S.me.autostart = on;
    $('sAuto').checked = on;
    toast(on ? 'UaN starts with your computer now.' : 'UaN no longer starts with your computer.');
  } catch (e) { $('sAuto').checked = S.me.autostart; toast(e); }
});
$('sAutoDlDir').addEventListener('change', async () => {
  try {
    await invoke('set_autodl_dir', { dir: $('sAutoDlDir').value });
    S.me.autodlDir = $('sAutoDlDir').value.trim();
    $('sAutoDlReset').classList.toggle('hidden', !S.me.autodlDir);
    toast(S.me.autodlDir ? 'Automatic downloads go to ' + S.me.autodlDir + ' now.' : 'Automatic downloads go to the UaN folder in your user folder.');
  } catch (e) { toast(e); $('sAutoDlDir').value = S.me.autodlDir || ''; }
});
$('sAutoDlPick').addEventListener('click', async () => {
  try { const d = await invoke('pick_autodl_dir', { reset: false }); S.me.autodlDir = d; $('sAutoDlDir').value = d || ''; $('sAutoDlReset').classList.toggle('hidden', !d); } catch (e) { toast(e); }
});
$('sAutoDlReset').addEventListener('click', async () => {
  try { await invoke('pick_autodl_dir', { reset: true }); S.me.autodlDir = ''; $('sAutoDlDir').value = ''; $('sAutoDlReset').classList.add('hidden'); } catch (e) { toast(e); }
});

$('sAutoUpd').addEventListener('change', () => setAutoUpdate($('sAutoUpd').checked));
setAutoUpdate(autoUpdateOn());

// ---------- Ping colours ----------
// Auto (the default) follows your theme: your pings are a slightly different shade of your own bubbles,
// pings to you (and @everyone) are the opposite colour of the theme's, so they stand out. Each can be set by hand.
function pingColors() {
  try { return { out: '', in: '', ...JSON.parse(localStorage.getItem('uan.pings2') || '{}') }; } catch { return { out: '', in: '' }; }
}
// Dark or light text, whichever reads better on the colour.
const inkOn = (hex) => { const n = parseInt(hex.slice(1), 16); const l = (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255; return l > 0.6 ? '#141414' : '#ffffff'; };
function applyPings() {
  const p = pingColors();
  const s = document.documentElement.style;
  for (const k of ['out', 'in']) {
    if (p[k]) { s.setProperty('--ping-' + k, p[k]); s.setProperty('--ping-' + k + '-ink', inkOn(p[k])); }
    else { s.removeProperty('--ping-' + k); s.removeProperty('--ping-' + k + '-ink'); }
  }
}
function savePings(p) { try { localStorage.setItem('uan.pings2', JSON.stringify(p)); } catch {} applyPings(); }
// The colour a ping bubble has right now (to show it in the picker), as #rrggbb.
function pingNow(which) {
  const probe = el('div', { class: 'msg ' + (which === 'out' ? 'mine pings-out' : 'theirs mentions-me'), style: 'position:fixed;left:-999px;top:0' }, el('div', { class: 'bubble', text: 'x' }));
  document.body.append(probe);
  const bg = getComputedStyle(probe.firstChild).backgroundColor;
  probe.remove();
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const x = cv.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, 1, 1);
  const d = x.getImageData(0, 0, 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function pingPickers() {
  const p = pingColors();
  const one = (which, label) => {
    const pick = el('input', { type: 'color', class: 'wp-color', value: p[which] || pingNow(which), 'aria-label': label, title: p[which] ? label : label + ' (Auto: from your theme)' });
    pick.addEventListener('input', () => { const q = pingColors(); q[which] = pick.value; savePings(q); });
    pick.addEventListener('change', renderPingRows);
    const auto = el('button', { type: 'button', class: 'small wp-auto' + (p[which] ? '' : ' on'), text: 'Auto', title: 'Follow your theme', onclick: () => { const q = pingColors(); q[which] = ''; savePings(q); renderPingRows(); } });
    return [pick, auto];
  };
  return { out: one('out', 'Your pings'), in: one('in', 'Pings to you') };
}
function renderPingRows() {
  const box = $('sPingColors');
  if (!box) return;
  const k = pingPickers();
  box.replaceChildren(
    el('span', { class: 'ping-lbl' }, 'Your pings'), ...k.out,
    el('span', { class: 'ping-lbl' }, 'Pings to you (and @everyone)'), ...k.in);
}
applyPings();
renderPingRows();

$('sAutoDlOpen').addEventListener('click', () => invoke('open_autodl_dir').catch(toast));

// ---------- Click an @mention: a small profile card pops up next to it (like on Discord) ----------
function personByName(name) {
  const n = name.toLowerCase();
  if (S.me?.name?.toLowerCase() === n) return S.me.id;
  const g = groupOf(S.active);
  const pools = [g ? g.members : [], S.friends || [], ...S.groups.map((x) => x.members)];
  for (const pool of pools) {
    const hit = pool.find((x) => (x.name || '').toLowerCase() === n);
    if (hit) return hit.id;
  }
  // "@Tsa" for "TsaRuben": the one name that starts like it
  for (const pool of pools) {
    const hits = pool.filter((x) => (x.name || '').toLowerCase().startsWith(n));
    if (hits.length === 1) return hits[0].id;
  }
  return null;
}
function closeMiniProfile() { document.querySelector('.mini-pf')?.remove(); }
function openMiniProfile(id, anchor) {
  closeMiniProfile();
  const p = personInfo(id);
  if (!p) return;
  const col = lookColour(p.look);
  const bio = (p.bio || '').replace(BIO_PIC, '').trim();
  const online = p.me ? 'You' : p.online ? 'Online' : 'Offline';
  const card = el('div', { class: 'mini-pf', role: 'dialog', 'aria-label': p.name },
    el('div', { class: 'mini-banner' }),
    el('div', { class: 'mini-av' }, avatar(p.name, { seed: p.id, src: p.avatar, online: !!p.online })),
    el('div', { class: 'mini-body' },
      el('div', { class: 'mini-name', text: p.name }),
      el('div', { class: 'mini-sub', text: online }),
      p.status ? el('div', { class: 'mini-status', text: p.status }) : null,
      bio ? el('div', { class: 'mini-bio' }, formatText(bio.length > 220 ? bio.slice(0, 220) + '…' : bio)) : null,
      el('div', { class: 'mini-acts' },
        el('button', { type: 'button', class: 'small accent', text: p.me ? 'See your profile' : 'View profile', onclick: () => { closeMiniProfile(); openProfile(id); } }),
        p.friend ? el('button', { type: 'button', class: 'small', text: 'Message', onclick: () => { closeMiniProfile(); openChat(id); } }) : null)));
  card.querySelector('.mini-banner').style.background = bannerStyle(p.banner, p.id);
  if (col) { card.style.setProperty('--look', col); card.classList.add('has-look'); }
  document.body.append(card);
  // Next to the mention, kept inside the window.
  const r = anchor.getBoundingClientRect();
  const w = card.offsetWidth, h = card.offsetHeight;
  let x = r.right + 8, y = r.top - 20;
  if (x + w > innerWidth - 8) x = r.left - w - 8;
  if (x < 8) x = Math.max(8, Math.min(innerWidth - w - 8, r.left));
  if (y + h > innerHeight - 8) y = innerHeight - h - 8;
  card.style.left = Math.max(8, x) + 'px';
  card.style.top = Math.max(8, y) + 'px';
}
document.addEventListener('click', (e) => {
  const m = e.target.closest?.('.bubble .mention');
  if (!m) return;
  e.stopPropagation();
  const name = m.textContent.replace(/^@/, '');
  if (name.toLowerCase() === 'everyone') { toast('@everyone tags the whole group.'); return; }
  const id = personByName(name);
  if (id) openMiniProfile(id, m); else toast('UaN doesn’t know who ' + m.textContent + ' is.');
}, true);
document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('.mini-pf') && !e.target.closest?.('.bubble .mention')) closeMiniProfile(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMiniProfile(); });
$('msgs').addEventListener('wheel', closeMiniProfile, { passive: true });

// ---------- Settings → Privacy: lock UaN with a password ----------
async function renderLock() {
  const st = await invoke('lock_state').catch(() => ({ enabled: false }));
  $('sLockState').textContent = st.enabled ? '🔒 On: UaN asks for the password when it starts.' : 'Off';
  $('sLockCurRow').classList.toggle('hidden', !st.enabled);
  $('sLockOff').classList.toggle('hidden', !st.enabled);
  $('sLockOn').textContent = st.enabled ? 'Change password' : 'Turn on';
  for (const id of ['sLockCur', 'sLockNew', 'sLockNew2']) $(id).value = '';
}
$('sLockOn').addEventListener('click', async () => {
  const pw = $('sLockNew').value;
  if (pw.length < 4) return toast('The password must be at least 4 characters.');
  if (pw !== $('sLockNew2').value) return toast('The two passwords are not the same.');
  try {
    await invoke('lock_set', { on: true, password: pw, current: $('sLockCur').value || null });
    toast('UaN is locked with your password from the next start.');
    renderLock();
  } catch (e) { toast(e); }
});
$('sLockOff').addEventListener('click', async () => {
  if (!$('sLockCur').value) return toast('Type your current password to turn the lock off.');
  try {
    await invoke('lock_set', { on: false, password: '', current: $('sLockCur').value });
    toast('The lock is off.');
    renderLock();
  } catch (e) { toast(e); }
});
document.querySelector('.s-tab[data-page="privacy"]').addEventListener('click', renderLock);

// ---------- Phones: Wi-Fi only, and the keyboard ----------
$('sWifi').addEventListener('change', async () => {
  await invoke('set_wifi_only', { on: $('sWifi').checked }).catch(toast);
  S.me.wifiOnly = $('sWifi').checked;
  toast($('sWifi').checked ? 'Files go only on Wi-Fi now.' : 'Files also go on mobile data now.');
});
// The window knows whether the phone is on mobile data; the core is told (and again whenever it changes).
(function watchNetwork() {
  const c = navigator.connection;
  if (!c) return;
  const tell = () => invoke('set_network', { cellular: c.type === 'cellular' }).catch(() => {});
  tell();
  c.addEventListener?.('change', tell);
})();
// When the keyboard opens, the app shrinks to the space above it (the header and the channel stay in sight).
if (window.visualViewport) {
  const fit = () => {
    if (!document.documentElement.classList.contains('phone')) return;
    document.documentElement.style.setProperty('--app-h', visualViewport.height + 'px');
    if (window.scrollY || document.scrollingElement?.scrollTop) window.scrollTo(0, 0);
  };
  visualViewport.addEventListener('resize', fit);
  visualViewport.addEventListener('scroll', fit);
  fit();
}

// ---------- Delete everything (Settings → Privacy): only after typing the words ----------
const WIPE_WORDS = 'Delete everything';
$('sWipe').addEventListener('click', () => {
  $('wipeText').value = '';
  $('wipeErr').textContent = '';
  $('wipeGo').disabled = true;
  $('wipeDlg').showModal();
  setTimeout(() => $('wipeText').focus(), 50);
});
$('wipeText').addEventListener('input', () => { $('wipeGo').disabled = $('wipeText').value.trim() !== WIPE_WORDS; });
$('wipeCancel').addEventListener('click', () => $('wipeDlg').close());
$('wipeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('wipeText').value.trim() !== WIPE_WORDS) return;
  $('wipeGo').disabled = true; $('wipeCancel').disabled = true;
  $('wipeGo').textContent = 'Deleting…';
  try {
    const r = await invoke('wipe_everything', { confirm: $('wipeText').value.trim() });
    $('wipeErr').classList.add('ok');
    $('wipeErr').textContent = 'Deleted ' + r.files + ' file' + (r.files === 1 ? '' : 's') + ' (' + fmtBytes(r.bytes) + '). UaN closes now and removes its folders.';
  } catch (err) {
    $('wipeErr').textContent = String(err);
    $('wipeGo').disabled = false; $('wipeCancel').disabled = false; $('wipeGo').textContent = WIPE_WORDS;
  }
});

$('sKeepFree').addEventListener('change', async () => {
  const on = $('sKeepFree').checked;
  await invoke('set_keep_free', { on }).catch(toast);
  S.me.keepFree = on;
  toast(on ? 'UaN keeps at least 20 GB free when it downloads by itself.' : 'UaN now downloads by itself until 2 GB is left (it never fills the disk completely).');
});

// ---------- Voice: channels in groups and calls between friends ----------
// The sound goes straight between the devices (WebRTC: Opus, echo and noise removal); UaN's own peer-to-peer
// link carries the set-up and who is in which room. Audio only, so it stays light.
const VOICE_ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
var VC = { chat: null, stream: null, peers: new Map(), early: {}, muted: false, deaf: false, beat: null, noAnswer: null };
S.voiceRooms = {};
function voiceRoomName(chat) {
  const g = groupOf(chat);
  if (g) {
    const ch = (g.channels || []).find((c) => c.chat === chat);
    return (ch ? ch.name : 'voice') + ' · ' + g.name;
  }
  return chatInfo(chat)?.name || 'Call';
}
async function refreshVoiceRooms() {
  try { S.voiceRooms = await invoke('voice_rooms'); } catch {}
  if (S.me) { renderChannels(); renderVoiceBar(); }
}
setInterval(refreshVoiceRooms, 8000);
const voiceSig = (dev, obj) => invoke('voice_send', { chat: VC.chat, kind: 'signal', to: dev, data: JSON.stringify(obj) }).catch(() => {});

async function voiceJoin(chat, { ring = false } = {}) {
  if (VC.chat === chat) return;
  if (VC.chat) await voiceLeave();
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return toast('Voice isn’t available on this system.');
  try {
    VC.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch (e) {
    return toast('UaN can’t use your microphone: ' + (e?.message || e));
  }
  VC.chat = chat;
  VC.seen = new Set();
  VC.answered = false;
  applyMute();
  try { await invoke('voice_send', { chat, kind: 'here' }); }
  catch (e) { toast(e); return voiceLeave(); }
  if (ring) sfxLoop('ringback'); else sfx('join');
  if (ring) {
    invoke('voice_send', { chat, kind: 'ring' }).catch(() => {});
    VC.noAnswer = setTimeout(() => {
      if (VC.chat === chat && !VC.peers.size) { toast('No answer.'); voiceLeave(); }
    }, 35000);
  }
  VC.beat = setInterval(() => { if (VC.chat) invoke('voice_send', { chat: VC.chat, kind: 'here' }).catch(() => {}); }, 10000);
  syncBackdropSound();
  await refreshVoiceRooms();
  for (const p of S.voiceRooms[chat] || []) if (p.dev !== S.me.dev) voiceConnect(p.dev);
  renderChatHead();
}
function voicePeer(dev) {
  const pc = new RTCPeerConnection({ iceServers: VOICE_ICE });
  const entry = { pc, audio: null, pending: VC.early[dev] || [] };
  delete VC.early[dev];
  VC.peers.set(dev, entry);
  for (const t of VC.stream.getTracks()) pc.addTrack(t, VC.stream);
  pc.onicecandidate = (e) => { if (e.candidate) voiceSig(dev, { ice: e.candidate }); };
  pc.ontrack = (e) => {
    if (!entry.audio) { entry.audio = new Audio(); entry.audio.autoplay = true; }
    entry.audio.srcObject = e.streams[0];
    entry.audio.muted = VC.deaf;
    entry.audio.play().catch(() => {});
    clearTimeout(VC.noAnswer);
    // A call was picked up: the ringing stops.
    if (!VC.answered && !groupOf(VC.chat || '')) { VC.answered = true; sfxStop(); sfx('connected'); }
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) voiceDrop(dev);
    renderVoiceBar();
  };
  return entry;
}
// Between two devices the one with the smaller id makes the offer (so both never do).
async function voiceConnect(dev) {
  if (!VC.chat || VC.peers.has(dev) || dev === S.me.dev || !(S.me.dev < dev)) return;
  const { pc } = voicePeer(dev);
  await pc.setLocalDescription(await pc.createOffer());
  voiceSig(dev, { sdp: pc.localDescription });
}
function voiceDrop(dev) {
  const e = VC.peers.get(dev);
  if (!e) return;
  try { e.pc.close(); } catch {}
  if (e.audio) { e.audio.pause(); e.audio.srcObject = null; }
  VC.peers.delete(dev);
}
async function voiceLeave() {
  if (!VC.chat) return;
  const chat = VC.chat;
  VC.chat = null;
  sfxStop();
  sfx('leave');
  clearInterval(VC.beat);
  clearTimeout(VC.noAnswer);
  invoke('voice_send', { chat, kind: 'leave' }).catch(() => {});
  for (const d of [...VC.peers.keys()]) voiceDrop(d);
  VC.early = {};
  for (const t of VC.stream?.getTracks() || []) t.stop();
  VC.stream = null;
  syncBackdropSound();
  await refreshVoiceRooms();
  renderChatHead();
}
function applyMute() {
  for (const t of VC.stream?.getAudioTracks() || []) t.enabled = !VC.muted && !VC.deaf;
  for (const e of VC.peers.values()) if (e.audio) e.audio.muted = VC.deaf;
}
listen('voice', ({ payload: p }) => onVoice(p).catch(() => {}));
async function onVoice(p) {
  const rooms = S.voiceRooms;
  // Sounds: someone comes into your room, or goes.
  if (p.chat === VC.chat && p.dev !== S.me?.dev) {
    if (p.kind === 'here' && !VC.seen?.has(p.dev)) { VC.seen?.add(p.dev); if (groupOf(p.chat)) sfx('otherJoin'); }
    if (['leave', 'hangup'].includes(p.kind) && VC.seen?.delete(p.dev) && groupOf(p.chat)) sfx('otherLeave');
  }
  if (p.kind === 'here') {
    const list = (rooms[p.chat] ||= []);
    if (!list.some((x) => x.dev === p.dev)) list.push({ dev: p.dev, id: p.from, name: p.name });
  }
  if (['leave', 'hangup', 'decline'].includes(p.kind)) {
    rooms[p.chat] = (rooms[p.chat] || []).filter((x) => x.dev !== p.dev);
    if (p.chat === VC.chat) voiceDrop(p.dev);
    if (!groupOf(p.chat) && $('callIn').dataset.chat === p.chat) hideIncomingCall();
  }
  if (p.kind === 'ring' && VC.chat !== p.chat) showIncomingCall(p);
  if (p.chat === VC.chat) {
    if (p.kind === 'decline') { toast(p.name + ' declined the call.'); sfxStop(); voiceLeave().then(() => sfx('declined')); }
    else if (p.kind === 'leave' && !groupOf(p.chat) && !(rooms[p.chat] || []).some((x) => x.dev !== S.me.dev)) { toast(p.name + ' left the call.'); voiceLeave(); }
    else if (p.kind === 'here') {
      // Someone new: the one with the smaller id makes the offer; if that is them, tell them we are here right away.
      if (!VC.peers.has(p.dev) && p.dev < S.me.dev && !p.to) invoke('voice_send', { chat: VC.chat, kind: 'here', to: p.dev }).catch(() => {});
      voiceConnect(p.dev);
    }
    else if (p.kind === 'signal') {
      let d;
      try { d = JSON.parse(p.data || ''); } catch { return; }
      let e = VC.peers.get(p.dev);
      if (d.sdp?.type === 'offer') {
        if (e) voiceDrop(p.dev);
        e = voicePeer(p.dev);
        await e.pc.setRemoteDescription(d.sdp);
        await e.pc.setLocalDescription(await e.pc.createAnswer());
        voiceSig(p.dev, { sdp: e.pc.localDescription });
        for (const c of e.pending.splice(0)) await e.pc.addIceCandidate(c).catch(() => {});
      } else if (d.sdp?.type === 'answer' && e) {
        await e.pc.setRemoteDescription(d.sdp);
        for (const c of e.pending.splice(0)) await e.pc.addIceCandidate(c).catch(() => {});
      } else if (d.ice) {
        if (e?.pc.remoteDescription) e.pc.addIceCandidate(d.ice).catch(() => {});
        else if (e) e.pending.push(d.ice);
        else (VC.early[p.dev] ||= []).push(d.ice);
      }
    }
  }
  renderChannels();
  renderVoiceBar();
}
// The bar at the bottom of the side column while you are in a voice channel or a call.
function renderVoiceBar() {
  const bar = $('voiceBar');
  if (!VC.chat) { bar.classList.add('hidden'); bar.replaceChildren(); return; }
  const others = (S.voiceRooms[VC.chat] || []).filter((x) => x.dev !== S.me.dev);
  const live = [...VC.peers.values()].filter((e) => e.pc.connectionState === 'connected').length;
  const state = live ? 'Voice connected' : others.length ? 'Connecting…' : (groupOf(VC.chat) ? 'Voice connected · alone here' : 'Calling…');
  const btn = (icon, title, on, run, cls = '') => el('button', { type: 'button', class: 'icon small' + (on ? ' on' : '') + cls, title, onclick: run }, svg(icon));
  bar.classList.remove('hidden');
  bar.replaceChildren(
    el('div', { class: 'grow voice-info' },
      el('div', { class: 'voice-state' + (live ? ' live' : ''), text: state }),
      el('div', { class: 'voice-room ellipsis', text: voiceRoomName(VC.chat) + (others.length ? ' · ' + others.map((o) => o.name).join(', ') : '') })),
    btn(VC.muted ? '<path d="M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0Z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/>' : '<path d="M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0Z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
      VC.muted ? 'Unmute' : 'Mute your microphone', VC.muted, () => { VC.muted = !VC.muted; sfx(VC.muted ? 'mute' : 'unmute'); applyMute(); renderVoiceBar(); }),
    btn(VC.deaf ? '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/><path d="M4 4l16 16"/>' : '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
      VC.deaf ? 'Hear again' : 'Deafen (hear nobody, and mute)', VC.deaf, () => { VC.deaf = !VC.deaf; sfx(VC.deaf ? 'deafen' : 'undeafen'); applyMute(); renderVoiceBar(); }),
    btn('<path d="M3 15c5-5 13-5 18 0l-2.5 2.5-3-1.5v-2.5a10 10 0 0 0-5 0V16l-3 1.5Z"/>', groupOf(VC.chat) ? 'Leave the voice channel' : 'Hang up', false, () => voiceLeave(), ' hang'));
}
// A friend calls you
let callInTimer = null;
function showIncomingCall(p) {
  const box = $('callIn');
  box.dataset.chat = p.chat;
  box.replaceChildren(
    el('div', { class: 'call-ico' }, svg('<path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/>')),
    el('div', { class: 'grow' }, el('div', { class: 'strong', text: p.name }), el('div', { class: 'sub', text: 'is calling you' })),
    el('button', { type: 'button', class: 'call-no', title: 'Decline', onclick: () => { invoke('voice_send', { chat: p.chat, kind: 'decline' }).catch(() => {}); hideIncomingCall(); } }, svg('<path d="M6 6l12 12M18 6 6 18"/>')),
    el('button', { type: 'button', class: 'call-yes', title: 'Answer', onclick: () => { hideIncomingCall(); voiceJoin(p.chat); } }, svg('<path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/>')));
  box.classList.remove('hidden');
  sfxLoop('ringtone');
  clearTimeout(callInTimer);
  callInTimer = setTimeout(hideIncomingCall, 35000);
}
function hideIncomingCall() { if (!$('callIn').classList.contains('hidden')) sfxStop(); $('callIn').classList.add('hidden'); delete $('callIn').dataset.chat; clearTimeout(callInTimer); }
$('callBtn').addEventListener('click', () => {
  const chat = S.active;
  if (!chat || groupOf(chat)) return;
  if (VC.chat === chat) return voiceLeave();
  voiceJoin(chat, { ring: true });
});
window.addEventListener('beforeunload', () => { if (VC.chat) invoke('voice_send', { chat: VC.chat, kind: 'leave' }).catch(() => {}); });

// ---------- Voice sounds: calling, ringing, joining, leaving, mute, deafen ----------
// Made on the spot (no sound files): a few soft notes each, one shared audio context.
const vsfxOn = () => { try { return localStorage.getItem('uan.vsfx') !== '0'; } catch { return true; } };
var sfxCtx = null, sfxLoopTimer = null, sfxLoopName = null;
function sfxNotes(notes, vol = 0.11, bell = false) {
  if (!vsfxOn()) return;
  try {
    sfxCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (sfxCtx.state === 'suspended') sfxCtx.resume();
    const t0 = sfxCtx.currentTime + 0.01;
    for (const [freq, at, len, type = 'sine', v = 1] of notes) {
      const o = sfxCtx.createOscillator(), g = sfxCtx.createGain();
      o.type = type;
      o.frequency.value = freq;
      const s = t0 + at;
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(vol * v, s + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0008, s + len);
      o.connect(g).connect(sfxCtx.destination);
      o.start(s);
      o.stop(s + len + 0.05);
      if (bell) {
        // a quiet octave above makes it ring like a small bell
        const o2 = sfxCtx.createOscillator(), g2 = sfxCtx.createGain();
        o2.frequency.value = freq * 2;
        g2.gain.setValueAtTime(0, s);
        g2.gain.linearRampToValueAtTime(vol * v * 0.18, s + 0.008);
        g2.gain.exponentialRampToValueAtTime(0.0006, s + len * 0.6);
        o2.connect(g2).connect(sfxCtx.destination);
        o2.start(s);
        o2.stop(s + len + 0.05);
      }
    }
  } catch {}
}
const SFX = {
  join: [[659, 0, 0.14], [880, 0.09, 0.22]],                    // up: you are in
  leave: [[880, 0, 0.14], [587, 0.09, 0.24]],                   // down: you left
  otherJoin: [[784, 0, 0.16, 'sine', 0.7]],                     // someone came in
  otherLeave: [[523, 0, 0.18, 'sine', 0.7]],                    // someone went
  mute: [[440, 0, 0.08, 'triangle'], [330, 0.06, 0.12, 'triangle']],
  unmute: [[330, 0, 0.08, 'triangle'], [494, 0.06, 0.12, 'triangle']],
  deafen: [[392, 0, 0.12, 'triangle'], [262, 0.09, 0.2, 'triangle']],
  undeafen: [[262, 0, 0.12, 'triangle'], [392, 0.09, 0.2, 'triangle']],
  connected: [[523, 0, 0.12], [659, 0.08, 0.12], [784, 0.16, 0.26]],
  declined: [[494, 0, 0.16], [392, 0.12, 0.16], [294, 0.24, 0.3]],
  // while you call: two soft bell notes, then quiet
  ringback: [[587, 0, 0.9, 'sine', 0.55], [784, 0.32, 1.1, 'sine', 0.5]],
  // someone calls you: a gentle four-note bell phrase
  ringtone: [[784, 0, 0.9, 'sine', 0.7], [988, 0.22, 0.9, 'sine', 0.65], [1175, 0.44, 0.9, 'sine', 0.6], [988, 0.7, 1.4, 'sine', 0.55]],
};
const SFX_EVERY = { ringback: 3200, ringtone: 3000 };
const SFX_BELL = new Set(['ringback', 'ringtone', 'connected', 'join', 'leave']);
function sfx(name) { if (SFX[name]) sfxNotes(SFX[name], name === 'ringtone' ? 0.09 : 0.11, SFX_BELL.has(name)); }
function sfxLoop(name) {
  sfxStop();
  sfxLoopName = name;
  syncBackdropSound();
  sfx(name);
  sfxLoopTimer = setInterval(() => sfx(name), SFX_EVERY[name] || 3000);
}
function sfxStop() { const was = sfxLoopName; clearInterval(sfxLoopTimer); sfxLoopTimer = null; sfxLoopName = null; if (was) syncBackdropSound(); }
$('sVsfx').checked = vsfxOn();
$('sVsfx').addEventListener('change', () => {
  try { localStorage.setItem('uan.vsfx', $('sVsfx').checked ? '1' : '0'); } catch {}
  if (!$('sVsfx').checked) sfxStop();
});

document.addEventListener('visibilitychange', () => syncBackdropSound());

// ---------- Settings → Downloads: ask where each download goes, or one folder for all ----------
$('sDlAsk').addEventListener('change', async () => {
  await invoke('set_dl_ask', { on: $('sDlAsk').checked }).catch(toast);
  S.me.dlAsk = $('sDlAsk').checked;
});
$('sDlDir').addEventListener('change', async () => {
  try {
    await invoke('set_dl_dir', { dir: $('sDlDir').value });
    S.me.dlDir = $('sDlDir').value.trim();
    S.me = await invoke('state');
    $('sDlDir').placeholder = S.me.dlPath || 'Downloads';
  } catch (e) { toast(e); $('sDlDir').value = S.me.dlDir || ''; }
});
$('sDlPick').addEventListener('click', async () => {
  try {
    const d = await invoke('pick_download_dir', { title: 'Where should your downloads go?' });
    if (!d) return;
    await invoke('set_dl_dir', { dir: d });
    $('sDlDir').value = d;
    S.me = await invoke('state');
  } catch (e) { toast(e); }
});
