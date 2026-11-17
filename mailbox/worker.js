// UaN offline mailbox (Cloudflare Worker + D1, free tier).
//
// When a friend is offline, the app drops an *encrypted* message here and deletes its own copy,
// so the sender can switch off their PC. The friend picks it up next time UaN starts.
// The mailbox only ever sees ciphertext: only the recipient's key can open it.
// Every request is signed with the user's UaN key, so nobody can read or delete someone else's mail.

const MAX_BOX = 300_000; // ~300 KB per message (text and file info only, never the files themselves)
const MAX_QUEUED = 5000; // per recipient
const KEEP_MS = 30 * 86_400_000; // undelivered mail is kept for 30 days
const CLOCK_SKEW_MS = 10 * 60_000;

let ready = false;

async function init(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS mail (id INTEGER PRIMARY KEY AUTOINCREMENT, rcpt TEXT NOT NULL, sender TEXT NOT NULL, box TEXT NOT NULL, created INTEGER NOT NULL)',
    ),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_mail_rcpt ON mail (rcpt, id)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_mail_created ON mail (created)'),
  ]);
  ready = true;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (error, status = 400) => json({ ok: false, error }, status);
const isKey = (k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k);

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verify(keyHex, message, sigHex) {
  if (!isKey(keyHex) || typeof sigHex !== 'string' || !/^[0-9a-f]{128}$/.test(sigHex)) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(keyHex), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, hexToBytes(sigHex), new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

// ---- Small encrypted files for offline friends (Workers KV) ----
const MAX_BLOB = 25 * 1024 * 1024; // KV's value limit
const BLOB_TTL = 14 * 86_400; // seconds
const isId = (s) => typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);

async function blobPut(request, env, url) {
  const q = url.searchParams;
  const from = q.get('from'), to = q.get('to'), id = q.get('id'), ts = Number(q.get('ts')), sig = q.get('sig');
  if (!isKey(from) || !isKey(to) || !isId(id) || !Number.isFinite(ts)) return fail('Bad request.');
  if (Math.abs(Date.now() - ts) > CLOCK_SKEW_MS) return fail('Your PC clock is off.', 401);
  const size = Number(request.headers.get('content-length') || 0);
  if (!size || size > MAX_BLOB) return fail('Too big for the mailbox.', 413);
  // The signature covers who, what and how big; the content itself is authenticated by its encryption.
  if (!(await verify(from, `blobput:${to}:${id}:${ts}:${size}`, sig))) return fail('Bad signature.', 401);
  const body = await request.arrayBuffer();
  if (body.byteLength !== size) return fail('Upload incomplete.');
  await env.FILES.put(`${to}/${id}`, body, { expirationTtl: BLOB_TTL, metadata: { from } });
  return json({ ok: true });
}

async function blobGet(env, body) {
  const { who, id, ts, sig } = body;
  if (!isId(id) || !(await verify(who, `blobget:${who}:${id}:${ts}`, sig))) return fail('Bad signature.', 401);
  const { value, metadata } = await env.FILES.getWithMetadata(`${who}/${id}`, 'arrayBuffer');
  if (!value) return fail('Not found.', 404);
  return new Response(value, { headers: { 'content-type': 'application/octet-stream', 'x-from': metadata?.from || '' } });
}

async function blobDel(env, body) {
  const { who, id, ts, sig } = body;
  if (!isId(id) || !(await verify(who, `blobdel:${who}:${id}:${ts}`, sig))) return fail('Bad signature.', 401);
  await env.FILES.delete(`${who}/${id}`);
  return json({ ok: true });
}

// ---- Theme workshop: themes people publish (after the admin approves them), like, find and use. Files in R2, the rest in D1. ----
const WS_MAX_FILE = 50 * 1024 * 1024; // one theme
const WS_MAX_THEMES = 100; // in the whole workshop, waiting ones included
const WS_MAX_PER_PERSON = 10;
const WS_MAX_PER_DAY = 5; // uploads per person per day
const WS_HIDE_AT = 3; // reports that hide a theme until the admin looks at it
const WS_ADMIN_HOURS = 6; // how long one opening of the dev panel stays signed in
const WS_LINK_MINUTES = 10; // the sign-in link from UaN must be opened this soon, and works once
const WS_MAX_WAITING = 30; // themes waiting for approval at one time (so spam can't fill the workshop)
const WS_MAX_OPEN_IDEAS = 500; // unread suggestions kept at one time
const WS_TYPES = { html: 'text/html', htm: 'text/html', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
const wsKind = (mime) => (mime === 'text/html' ? 'html' : mime.startsWith('video/') ? 'video' : 'image');
// Anything people upload is shown in a sandbox: it can never run as this site (and so never reach the dev panel).
const WS_SANDBOX = { 'content-security-policy': "sandbox allow-scripts; default-src 'self' data: blob: 'unsafe-inline'", 'x-content-type-options': 'nosniff' };
let wsReady = false;
async function wsInit(env) {
  if (wsReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ws_themes (id TEXT PRIMARY KEY, owner TEXT NOT NULL, author TEXT NOT NULL, name TEXT NOT NULL, about TEXT NOT NULL, ext TEXT NOT NULL, mime TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, base TEXT NOT NULL, accent TEXT, thumb TEXT, likes INTEGER NOT NULL DEFAULT 0, downloads INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL)"),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS ws_owner ON ws_themes (owner, created)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS ws_likes (theme TEXT NOT NULL, who TEXT NOT NULL, PRIMARY KEY (theme, who))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS ws_reports (theme TEXT NOT NULL, who TEXT NOT NULL, reason TEXT, created INTEGER, PRIMARY KEY (theme, who))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS ws_suggest (id INTEGER PRIMARY KEY AUTOINCREMENT, who TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS ws_suggest_who ON ws_suggest (who, created)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS ws_admin_sessions (sid TEXT PRIMARY KEY, expires INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS ws_admin_used (sig TEXT PRIMARY KEY, ts INTEGER NOT NULL)'),
  ]);
  wsReady = true;
}
const wsAdmin = (env, who) => !!env.WS_ADMIN && who === env.WS_ADMIN;
const wsFresh = (ts) => Number.isFinite(ts) && Math.abs(Date.now() - ts) <= CLOCK_SKEW_MS;
const wsRow = (r, who, liked, adminKey) => ({ dev: !!adminKey && r.owner === adminKey, id: r.id, author: r.author, name: r.name, about: r.about, ext: r.ext, mime: r.mime, kind: r.kind, size: r.size, base: r.base, accent: r.accent,
  likes: r.likes, downloads: r.downloads, created: r.created, hidden: !!r.hidden, reports: r.reports, status: r.status, thumb: !!r.thumb, mine: r.owner === who, liked: liked.has(r.id) });

async function wsList(env, url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
  const sort = url.searchParams.get('sort') === 'new' ? 'created DESC' : 'likes DESC, created DESC';
  let who = url.searchParams.get('who') || '';
  const lts = Number(url.searchParams.get('ts')), lsig = url.searchParams.get('sig') || '';
  if (!(isKey(who) && wsFresh(lts) && (await verify(who, `wslist:${who}:${lts}`, lsig)))) who = '';
  const admin = wsAdmin(env, who);
  const where = ["status != 'uploading'"], binds = [];
  // Everyone sees the approved ones; you also see yours that wait for approval; the admin sees all.
  if (!admin) { where.push("((status = 'live' AND hidden = 0) OR owner = ?)"); binds.push(who); }
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    where.push("(name LIKE ? ESCAPE '\\' OR about LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\')");
    binds.push(like, like, like);
  }
  const sql = 'SELECT * FROM ws_themes' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY ' + sort + ' LIMIT 100';
  const { results } = await (binds.length ? env.DB.prepare(sql).bind(...binds) : env.DB.prepare(sql)).all();
  const liked = new Set();
  if (isKey(who)) {
    const { results: l } = await env.DB.prepare('SELECT theme FROM ws_likes WHERE who = ?1').bind(who).all();
    for (const x of l) liked.add(x.theme);
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM ws_themes WHERE status = 'live'").first('n');
  return json({ ok: true, admin, count, max: WS_MAX_THEMES, maxFile: WS_MAX_FILE, themes: results.map((r) => wsRow(r, who, liked, env.WS_ADMIN)) });
}

async function wsUpload(request, env, url) {
  const q = url.searchParams;
  const owner = q.get('owner'), ts = Number(q.get('ts')), sig = q.get('sig'), meta = q.get('meta') || '';
  if (!isKey(owner) || !wsFresh(ts) || meta.length > 2000) return fail('Bad request.');
  const size = Number(request.headers.get('content-length') || 0);
  if (!size) return fail('Bad request.');
  if (size > WS_MAX_FILE) return fail('A theme can be 50 MB at most.', 413);
  if (!(await verify(owner, `wsput:${owner}:${ts}:${size}:${meta}`, sig))) return fail('Bad signature.', 401);
  let m;
  try { m = JSON.parse(meta); } catch { return fail('Bad request.'); }
  const ext = String(m.ext || '').toLowerCase();
  const mime = WS_TYPES[ext];
  if (!mime) return fail('A theme can be an .html page, a video (.mp4, .webm) or a picture.');
  const name = String(m.name || '').trim().slice(0, 24) || 'Theme';
  const about = String(m.about || '').trim().slice(0, 200);
  const author = String(m.author || '').trim().slice(0, 32) || 'Someone';
  const base = m.base === 'light' ? 'light' : 'dark';
  const accent = /^#[0-9a-fA-F]{6}$/.test(m.accent || '') ? m.accent : null;
  const admin = wsAdmin(env, owner);
  const now = Date.now();
  // Uploads that never finished (a closed app, a lost connection) give their place back after an hour.
  const { results: stale } = await env.DB.prepare("SELECT id, ext FROM ws_themes WHERE status = 'uploading' AND created < ?1").bind(now - 3600_000).all();
  for (const s of stale) await wsDeleteTheme(env, s.id, s.ext);
  const id = crypto.randomUUID().replace(/-/g, '');
  const res = await env.DB.prepare(`INSERT INTO ws_themes (id, owner, author, name, about, ext, mime, kind, size, base, accent, thumb, status, created)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, 'uploading', ?12
    WHERE (SELECT COUNT(*) FROM ws_themes) < ?13
      AND (?14 = 1 OR ((SELECT COUNT(*) FROM ws_themes WHERE owner = ?2) < ?15
        AND (SELECT COUNT(*) FROM ws_themes WHERE owner = ?2 AND created > ?16) < ?17
        AND (SELECT COUNT(*) FROM ws_themes WHERE status IN ('pending', 'uploading')) < ?18))`)
    .bind(id, owner, author, name, about, ext, mime, wsKind(mime), size, base, accent, now, WS_MAX_THEMES, admin ? 1 : 0, WS_MAX_PER_PERSON, now - 86_400_000, WS_MAX_PER_DAY, WS_MAX_WAITING).run();
  if (!res.meta.changes) {
    const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM ws_themes').first('n');
    if (total >= WS_MAX_THEMES) return fail('The workshop is full (100 themes). Try again when one is removed.', 429);
    const mine = await env.DB.prepare('SELECT COUNT(*) AS n, SUM(created > ?2) AS today FROM ws_themes WHERE owner = ?1').bind(owner, now - 86_400_000).first();
    if ((mine?.n || 0) >= WS_MAX_PER_PERSON) return fail('You have 10 themes in the workshop already. Remove one first.', 429);
    if ((mine?.today || 0) >= WS_MAX_PER_DAY) return fail('5 uploads a day at most. Try again tomorrow.', 429);
    return fail('Many themes are waiting for approval right now. Try again later.', 429);
  }
  try {
    await env.WS.put(`themes/${id}.${ext}`, request.body, { httpMetadata: { contentType: mime } });
  } catch {
    await wsDeleteTheme(env, id, ext);
    return fail('Upload failed. Try again.');
  }
  const head = await env.WS.head(`themes/${id}.${ext}`);
  if (!head || head.size !== size) { await wsDeleteTheme(env, id, ext); return fail('Upload incomplete.'); }
  const status = admin ? 'live' : 'pending';
  await env.DB.prepare('UPDATE ws_themes SET status = ?2 WHERE id = ?1').bind(id, status).run();
  return json({ ok: true, id, status });
}

async function wsFile(env, id, ctx) {
  if (!isId(id)) return fail('Not found.', 404);
  const r = await env.DB.prepare("SELECT ext, mime FROM ws_themes WHERE id = ?1 AND status != 'uploading'").bind(id).first();
  if (!r) return fail('Not found.', 404);
  const obj = await env.WS.get(`themes/${id}.${r.ext}`);
  if (!obj) return fail('Not found.', 404);
  ctx.waitUntil(env.DB.prepare('UPDATE ws_themes SET downloads = downloads + 1 WHERE id = ?1').bind(id).run());
  return new Response(obj.body, { headers: { 'content-type': r.mime, 'content-length': String(obj.size), ...WS_SANDBOX } });
}

async function wsThumb(env, id) {
  if (!isId(id)) return fail('Not found.', 404);
  const r = await env.DB.prepare('SELECT thumb FROM ws_themes WHERE id = ?1').bind(id).first();
  const m = r?.thumb && /^data:(image\/[a-z+]+);base64,(.+)$/.exec(r.thumb);
  if (!m) return fail('Not found.', 404);
  const bin = atob(m[2]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Response(out, { headers: { 'content-type': m[1], 'cache-control': 'public, max-age=86400', ...WS_SANDBOX } });
}

async function wsDeleteTheme(env, id, ext) {
  await env.WS.delete(`themes/${id}.${ext}`);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ws_themes WHERE id = ?1').bind(id),
    env.DB.prepare('DELETE FROM ws_likes WHERE theme = ?1').bind(id),
    env.DB.prepare('DELETE FROM ws_reports WHERE theme = ?1').bind(id),
  ]);
}

// Ideas and wishes for UaN, from Settings → About & updates. Only the admin reads them (in the dev panel).
async function wsSuggest(env, body) {
  const { who, ts, sig } = body;
  const text = String(body.text || '').trim().slice(0, 1000);
  const author = String(body.author || '').trim().slice(0, 32) || 'Someone';
  if (!isKey(who) || !wsFresh(ts) || !text) return fail('Bad request.');
  if (!(await verify(who, `wssuggest:${who}:${ts}:${await sha256hex(text)}`, sig))) return fail('Bad signature.', 401);
  const open = await env.DB.prepare('SELECT COUNT(*) AS n FROM ws_suggest WHERE done = 0').first('n');
  if (open >= WS_MAX_OPEN_IDEAS) return fail('The ideas box is full right now. Try again later.', 429);
  const today = await env.DB.prepare('SELECT COUNT(*) AS n FROM ws_suggest WHERE who = ?1 AND created > ?2').bind(who, Date.now() - 86_400_000).first('n');
  if (today >= 5) return fail('5 suggestions a day at most. Thank you, try again tomorrow.', 429);
  await env.DB.prepare('INSERT INTO ws_suggest (who, author, text, created) VALUES (?1, ?2, ?3, ?4)').bind(who, author, text, Date.now()).run();
  return json({ ok: true });
}

async function wsAct(env, path, body) {
  if (path === '/ws/suggest') return wsSuggest(env, body);
  const { who, id, ts, sig } = body;
  if (!isKey(who) || !isId(id) || !wsFresh(ts)) return fail('Bad request.');
  const r = await env.DB.prepare('SELECT owner, ext, status FROM ws_themes WHERE id = ?1').bind(id).first();
  if (!r) return fail('That theme is gone.', 404);
  if (path === '/ws/like') {
    const on = body.on ? 1 : 0;
    if (!(await verify(who, `wslike:${who}:${id}:${on}:${ts}`, sig))) return fail('Bad signature.', 401);
    await env.DB.batch([
      on ? env.DB.prepare('INSERT OR IGNORE INTO ws_likes (theme, who) VALUES (?1, ?2)').bind(id, who) : env.DB.prepare('DELETE FROM ws_likes WHERE theme = ?1 AND who = ?2').bind(id, who),
      env.DB.prepare('UPDATE ws_themes SET likes = (SELECT COUNT(*) FROM ws_likes WHERE theme = ?1) WHERE id = ?1').bind(id),
    ]);
    const likes = await env.DB.prepare('SELECT likes FROM ws_themes WHERE id = ?1').bind(id).first('likes');
    return json({ ok: true, likes });
  }
  if (path === '/ws/report') {
    if (!(await verify(who, `wsreport:${who}:${id}:${ts}`, sig))) return fail('Bad signature.', 401);
    const reason = String(body.reason || '').trim().slice(0, 300);
    await env.DB.batch([
      env.DB.prepare('INSERT OR REPLACE INTO ws_reports (theme, who, reason, created) VALUES (?1, ?2, ?3, ?4)').bind(id, who, reason, Date.now()),
      env.DB.prepare('UPDATE ws_themes SET reports = (SELECT COUNT(*) FROM ws_reports WHERE theme = ?1) WHERE id = ?1').bind(id),
      env.DB.prepare('UPDATE ws_themes SET hidden = 1 WHERE id = ?1 AND reports >= ?2').bind(id, WS_HIDE_AT),
    ]);
    return json({ ok: true });
  }
  if (path === '/ws/thumb') {
    // A small picture of the theme for the list (sent after the upload: it would not fit in the address).
    const thumb = body.thumb;
    if (typeof thumb !== 'string' || !thumb.startsWith('data:image/') || thumb.length > 40000) return fail('Bad request.');
    if (!(await verify(who, `wsthumb:${who}:${id}:${ts}:${await sha256hex(thumb)}`, sig))) return fail('Bad signature.', 401);
    if (r.owner !== who) return fail('Not allowed.', 403);
    await env.DB.prepare('UPDATE ws_themes SET thumb = ?2 WHERE id = ?1').bind(id, thumb).run();
    return json({ ok: true });
  }
  if (path === '/ws/delete') {
    if (!(await verify(who, `wsdel:${who}:${id}:${ts}`, sig))) return fail('Bad signature.', 401);
    if (r.owner !== who && !wsAdmin(env, who)) return fail('Only who published it (or the admin) can remove it.', 403);
    await wsDeleteTheme(env, id, r.ext);
    return json({ ok: true });
  }
  return fail('Not found.', 404);
}

// ---- The dev panel (a web page): approve uploads, read reports and suggestions, remove themes. Only the admin key gets in. ----
const hexOf = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
async function adminSession(request, env) {
  const m = /(?:^|;\s*)uan_admin=([0-9a-f]{64})(?:;|$)/.exec(request.headers.get('cookie') || '');
  if (!m) return null;
  const s = await env.DB.prepare('SELECT sid FROM ws_admin_sessions WHERE sid = ?1 AND expires > ?2').bind(m[1], Date.now()).first();
  return s ? m[1] : null;
}
async function adminEntry(request, env, url) {
  const who = url.searchParams.get('who'), ts = Number(url.searchParams.get('ts')), sig = url.searchParams.get('sig');
  if (!who && !sig) return adminPage();
  const now = Date.now();
  const ok = wsAdmin(env, who) && Number.isFinite(ts) && Math.abs(now - ts) <= WS_LINK_MINUTES * 60_000 && typeof sig === 'string' && (await verify(who, `wsadmin:${who}:${ts}`, sig));
  if (!ok) return adminPage();
  const once = await env.DB.prepare('INSERT OR IGNORE INTO ws_admin_used (sig, ts) VALUES (?1, ?2)').bind(sig, now).run();
  if (!once.meta.changes) return adminPage();
  const sid = hexOf(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ws_admin_sessions WHERE expires < ?1').bind(now),
    env.DB.prepare('DELETE FROM ws_admin_used WHERE ts < ?1').bind(now - 86_400_000),
    env.DB.prepare('INSERT INTO ws_admin_sessions (sid, expires) VALUES (?1, ?2)').bind(sid, now + WS_ADMIN_HOURS * 3600_000),
  ]);
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return new Response(null, { status: 303, headers: { location: '/admin', 'set-cookie': `uan_admin=${sid}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${WS_ADMIN_HOURS * 3600}${secure}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}
async function adminApi(request, env, body) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return fail('Not allowed.', 403);
  const sid = await adminSession(request, env);
  if (!sid) return fail('Open the dev panel again from UaN (Settings → About & updates).', 401);
  const action = body.action;
  if (action === 'logout') {
    await env.DB.prepare('DELETE FROM ws_admin_sessions WHERE sid = ?1').bind(sid).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'set-cookie': 'uan_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0' } });
  }
  const id = body.id;
  const theme = isId(id) ? await env.DB.prepare('SELECT ext FROM ws_themes WHERE id = ?1').bind(id).first() : null;
  const row = (r) => ({ id: r.id, owner: r.owner, author: r.author, name: r.name, about: r.about, ext: r.ext, kind: r.kind, size: r.size, likes: r.likes, downloads: r.downloads,
    reports: r.reports, hidden: !!r.hidden, status: r.status, thumb: !!r.thumb, created: r.created, reasons: r.reasons ? JSON.parse(r.reasons) : [] });
  switch (action) {
    case 'overview': {
      const reasons = "(SELECT json_group_array(json_object('reason', reason, 'created', created)) FROM ws_reports WHERE theme = t.id) AS reasons";
      const [pending, reported, live, sugg] = await env.DB.batch([
        env.DB.prepare(`SELECT t.*, ${reasons} FROM ws_themes t WHERE status = 'pending' ORDER BY created`),
        env.DB.prepare(`SELECT t.*, ${reasons} FROM ws_themes t WHERE reports > 0 ORDER BY hidden DESC, reports DESC, created DESC`),
        env.DB.prepare(`SELECT t.*, ${reasons} FROM ws_themes t WHERE status = 'live' ORDER BY created DESC`),
        env.DB.prepare('SELECT id, author, text, created, done FROM ws_suggest ORDER BY done, created DESC LIMIT 300'),
      ]);
      return json({ ok: true, max: WS_MAX_THEMES, pending: pending.results.map(row), reported: reported.results.map(row), live: live.results.map(row), suggestions: sugg.results });
    }
    case 'approve':
      if (!theme) return fail('That theme is gone.', 404);
      await env.DB.prepare("UPDATE ws_themes SET status = 'live' WHERE id = ?1").bind(id).run();
      return json({ ok: true });
    case 'reject':
    case 'delete':
      if (!theme) return fail('That theme is gone.', 404);
      await wsDeleteTheme(env, id, theme.ext);
      return json({ ok: true });
    case 'dismiss':
      if (!theme) return fail('That theme is gone.', 404);
      await env.DB.batch([
        env.DB.prepare('UPDATE ws_themes SET hidden = 0, reports = 0 WHERE id = ?1').bind(id),
        env.DB.prepare('DELETE FROM ws_reports WHERE theme = ?1').bind(id),
      ]);
      return json({ ok: true });
    case 'suggest-done':
      await env.DB.prepare('UPDATE ws_suggest SET done = 1 - done WHERE id = ?1').bind(Number(id)).run();
      return json({ ok: true });
    case 'suggest-delete':
      await env.DB.prepare('DELETE FROM ws_suggest WHERE id = ?1').bind(Number(id)).run();
      return json({ ok: true });
    default:
      return fail('Unknown action.');
  }
}

const ADMIN_HTML = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"robots\" content=\"noindex\">\n<title>UaN dev panel</title>\n<style>\n  :root { --bg: #0f1115; --panel: #171a21; --card: #1d212a; --border: #2a2f3a; --text: #e8eaf0; --muted: #8b93a4; --accent: #5fd3b0; --danger: #ff6b6b; --warn: #f5b84a; }\n  * { box-sizing: border-box; }\n  body { margin: 0; font: 14px/1.45 \"Segoe UI\", system-ui, sans-serif; background: var(--bg); color: var(--text); }\n  header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 16px; padding: 14px 22px; background: rgba(15, 17, 21, .92); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); }\n  header h1 { margin: 0; font-size: 17px; }\n  header .who { margin-left: auto; color: var(--muted); font-size: 12px; }\n  header .out { height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel); color: var(--text); cursor: pointer; font: inherit; font-size: 12px; }\n  nav { display: flex; gap: 6px; padding: 12px 22px 0; flex-wrap: wrap; }\n  nav button { height: 34px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel); color: var(--text); cursor: pointer; font: inherit; }\n  nav button.on { border-color: var(--accent); background: rgba(95, 211, 176, .14); }\n  nav .n { display: inline-block; min-width: 20px; margin-left: 6px; padding: 0 6px; border-radius: 9px; background: var(--border); font-size: 12px; text-align: center; }\n  nav .n.hot { background: var(--warn); color: #1d1300; }\n  main { padding: 16px 22px 40px; }\n  .note { color: var(--muted); }\n  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; }\n  .card { display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }\n  .card.flag { border-color: rgba(255, 107, 107, .6); }\n  .thumb { position: relative; aspect-ratio: 16 / 9; background: #12151b; display: grid; place-items: center; color: var(--muted); }\n  .thumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }\n  .tag { position: absolute; left: 8px; top: 8px; padding: 2px 8px; border-radius: 6px; background: rgba(0, 0, 0, .65); font-size: 11px; font-weight: 600; }\n  .tag.r { left: auto; right: 8px; background: var(--danger); }\n  .body { padding: 10px 12px; flex: 1; }\n  .name { font-weight: 700; font-size: 15px; word-break: break-word; }\n  .meta { color: var(--muted); font-size: 12px; margin-top: 2px; word-break: break-all; }\n  .about { margin-top: 6px; word-break: break-word; }\n  .reasons { margin: 8px 0 0; padding: 8px 10px; border-radius: 8px; background: rgba(255, 107, 107, .08); border: 1px solid rgba(255, 107, 107, .25); }\n  .reasons div { font-size: 13px; }\n  .reasons div + div { margin-top: 4px; padding-top: 4px; border-top: 1px dashed rgba(255, 107, 107, .25); }\n  .actions { display: flex; gap: 6px; padding: 0 12px 12px; flex-wrap: wrap; }\n  .actions button, .actions a { height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel); color: var(--text); cursor: pointer; font: inherit; font-size: 13px; text-decoration: none; display: inline-flex; align-items: center; }\n  .actions .ok { background: var(--accent); border-color: var(--accent); color: #062018; font-weight: 600; }\n  .actions .bad { color: var(--danger); border-color: rgba(255, 107, 107, .5); }\n  .sugg { display: flex; flex-direction: column; gap: 10px; max-width: 900px; }\n  .s { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }\n  .s.done { opacity: .5; }\n  .s .text { white-space: pre-wrap; word-break: break-word; margin-top: 4px; }\n  .s .actions { padding: 10px 0 0; }\n  .empty { padding: 50px 0; text-align: center; color: var(--muted); }\n  .err { margin: 40px auto; max-width: 520px; padding: 18px; border-radius: 12px; background: var(--card); border: 1px solid var(--border); text-align: center; }\n</style>\n</head>\n<body>\n<header><h1>UaN dev panel</h1><span class=\"note\" id=\"cap\"></span><span class=\"who\" id=\"who\"></span></header>\n<nav id=\"tabs\"></nav>\n<main id=\"main\"><div class=\"empty\">Loading…</div></main>\n<script>\n(function () {\n  // Signed in by UaN: the one-time link was swapped for a session cookie this page can't read.\n  var tab = 'pending', data = null;\n  function h(tag, attrs) {\n    var e = document.createElement(tag);\n    for (var k in (attrs || {})) {\n      if (k === 'text') e.textContent = attrs[k];\n      else if (k === 'class') e.className = attrs[k];\n      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);\n      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);\n    }\n    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c != null) e.append(c); }\n    return e;\n  }\n  function fail(msg) { document.getElementById('main').replaceChildren(h('div', { class: 'err' }, h('div', { text: msg }))); document.getElementById('tabs').replaceChildren(); }\n  document.getElementById('who').replaceChildren(h('button', { class: 'out', text: 'Sign out', onclick: function () { api('logout').then(function () { fail('Signed out. Open it again from UaN when you need it.'); }); } }));\n  function api(action, id) {\n    return fetch('/admin/api', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: action, id: id }) })\n      .then(function (r) { return r.json(); })\n      .then(function (v) { if (!v.ok) throw new Error(v.error || 'Error'); return v; });\n  }\n  function size(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }\n  function when(t) { return new Date(t).toLocaleString(); }\n  var KIND = { video: 'Video', image: 'Picture', html: 'Page' };\n  function act(action, id, confirmText) {\n    if (confirmText && !confirm(confirmText)) return;\n    api(action, id).then(load).catch(function (e) { alert(e.message); });\n  }\n  function card(t, mode) {\n    var thumb = h('div', { class: 'thumb' },\n      t.thumb ? h('img', { src: '/ws/thumb/' + t.id, alt: '' }) : h('span', { text: KIND[t.kind] || 'Theme' }),\n      h('span', { class: 'tag', text: (KIND[t.kind] || 'Theme') + ' · ' + size(t.size) }),\n      t.reports ? h('span', { class: 'tag r', text: t.reports + ' report' + (t.reports === 1 ? '' : 's') + (t.hidden ? ' · hidden' : '') }) : null);\n    var reasons = t.reasons && t.reasons.length ? h('div', { class: 'reasons' }, ...t.reasons.map(function (r) { return h('div', { text: (r.reason || '(no reason given)') + '  ·  ' + when(r.created) }); })) : null;\n    var buttons = [h('a', { href: '/ws/file/' + t.id, target: '_blank', rel: 'noopener', text: 'Preview' })];\n    if (mode === 'pending') {\n      buttons.push(h('button', { class: 'ok', text: 'Approve', onclick: function () { act('approve', t.id); } }));\n      buttons.push(h('button', { class: 'bad', text: 'Reject', onclick: function () { act('reject', t.id, 'Reject and delete “' + t.name + '”?'); } }));\n    } else {\n      if (t.reports) buttons.push(h('button', { text: 'Keep it (clear reports)', onclick: function () { act('dismiss', t.id); } }));\n      buttons.push(h('button', { class: 'bad', text: 'Remove', onclick: function () { act('delete', t.id, 'Remove “' + t.name + '” from the workshop? People who use it keep their copy.'); } }));\n    }\n    return h('div', { class: 'card' + (t.reports ? ' flag' : '') }, thumb,\n      h('div', { class: 'body' },\n        h('div', { class: 'name', text: t.name }),\n        h('div', { class: 'meta', text: 'by ' + t.author + ' · ' + when(t.created) + ' · ' + t.likes + ' likes · ' + t.downloads + ' used' }),\n        h('div', { class: 'meta', text: 'key ' + t.owner }),\n        t.about ? h('div', { class: 'about', text: t.about }) : null,\n        reasons),\n      h('div', { class: 'actions' }, ...buttons));\n  }\n  function render() {\n    var tabs = [['pending', 'Waiting for approval', data.pending.length, true], ['reported', 'Reports', data.reported.length, true], ['live', 'In the workshop', data.live.length, false], ['suggestions', 'Suggestions', data.suggestions.filter(function (s) { return !s.done; }).length, true]];\n    document.getElementById('tabs').replaceChildren(...tabs.map(function (x) {\n      return h('button', { class: tab === x[0] ? 'on' : '', onclick: function () { tab = x[0]; render(); } }, x[1], h('span', { class: 'n' + (x[3] && x[2] ? ' hot' : ''), text: String(x[2]) }));\n    }));\n    document.getElementById('cap').textContent = data.live.length + ' live, ' + data.pending.length + ' waiting, ' + data.max + ' fit';\n    var main = document.getElementById('main');\n    if (tab === 'suggestions') {\n      main.replaceChildren(data.suggestions.length ? h('div', { class: 'sugg' }, ...data.suggestions.map(function (s) {\n        return h('div', { class: 's' + (s.done ? ' done' : '') },\n          h('div', { class: 'meta', text: s.author + ' · ' + when(s.created) }),\n          h('div', { class: 'text', text: s.text }),\n          h('div', { class: 'actions' },\n            h('button', { text: s.done ? 'Not done' : 'Done', onclick: function () { act('suggest-done', s.id); } }),\n            h('button', { class: 'bad', text: 'Delete', onclick: function () { act('suggest-delete', s.id, 'Delete this suggestion?'); } })));\n      })) : h('div', { class: 'empty', text: 'No suggestions yet.' }));\n      return;\n    }\n    var list = data[tab];\n    var empty = { pending: 'Nothing waiting for approval.', reported: 'No reports.', live: 'The workshop is empty.' }[tab];\n    main.replaceChildren(list.length ? h('div', { class: 'grid' }, ...list.map(function (t) { return card(t, tab === 'pending' ? 'pending' : 'other'); })) : h('div', { class: 'empty', text: empty }));\n  }\n  function load() { return api('overview').then(function (v) { data = v; render(); }).catch(function (e) { fail(e.message); }); }\n  load();\n  setInterval(load, 60000);\n})();\n</script>\n</body>\n</html>\n";
function adminPage() {
  return new Response(ADMIN_HTML, { headers: {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
  } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'uan-mailbox' });
    if (url.pathname === '/admin' && request.method === 'GET') {
      if (!env.WS) return fail('The theme workshop is not set up on this mailbox.', 503);
      await wsInit(env);
      return adminEntry(request, env, url);
    }
    if (url.pathname === '/admin/api' && request.method === 'POST') {
      if (!env.WS) return fail('The theme workshop is not set up on this mailbox.', 503);
      await wsInit(env);
      let body;
      try { body = await request.json(); } catch { return fail('Bad request.'); }
      return adminApi(request, env, body);
    }
    if (url.pathname.startsWith('/ws/')) {
      if (!env.WS) return fail('The theme workshop is not set up on this mailbox.', 503);
      await wsInit(env);
      if (request.method === 'GET' && url.pathname === '/ws/list') return wsList(env, url);
      if (request.method === 'GET' && url.pathname.startsWith('/ws/file/')) return wsFile(env, url.pathname.slice(9), ctx);
      if (request.method === 'GET' && url.pathname.startsWith('/ws/thumb/')) return wsThumb(env, url.pathname.slice(10));
      if (request.method === 'PUT' && url.pathname === '/ws/upload') return wsUpload(request, env, url);
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return fail('Bad request.'); }
        return wsAct(env, url.pathname, body);
      }
      return fail('Not found.', 404);
    }
    if (request.method !== 'POST') return fail('Not found.', 404);
    if (url.pathname === '/blob/put') return blobPut(request, env, url);

    let body;
    try {
      body = await request.json();
    } catch {
      return fail('Bad request.');
    }
    if (!Number.isFinite(body.ts) || Math.abs(Date.now() - body.ts) > CLOCK_SKEW_MS) {
      return fail('Your PC clock is off. Fix the date and time in Windows settings.', 401);
    }
    await init(env);
    const now = Date.now();

    switch (url.pathname) {
      case '/send': {
        const { from, to, box, ts, sig } = body;
        if (!isKey(from) || !isKey(to) || typeof box !== 'string' || box.length > MAX_BOX) return fail('Bad request.');
        if (!(await verify(from, `send:${to}:${ts}:${await sha256hex(box)}`, sig))) return fail('Bad signature.', 401);
        const queued = await env.DB.prepare('SELECT COUNT(*) AS n FROM mail WHERE rcpt = ?').bind(to).first('n');
        if (queued >= MAX_QUEUED) return fail('Their mailbox is full.', 429);
        await env.DB.prepare('INSERT INTO mail (rcpt, sender, box, created) VALUES (?, ?, ?, ?)').bind(to, from, box, now).run();
        return json({ ok: true });
      }
      case '/fetch': {
        const { who, ts, sig } = body;
        if (!(await verify(who, `fetch:${who}:${ts}`, sig))) return fail('Bad signature.', 401);
        // Old mail is swept now and then (the index on "created" keeps even that cheap), not on every check.
        if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM mail WHERE created < ?').bind(now - KEEP_MS).run();
        const { results } = await env.DB.prepare('SELECT id, sender, box FROM mail WHERE rcpt = ? ORDER BY id LIMIT 200').bind(who).all();
        return json({ ok: true, mail: results });
      }
      case '/ack': {
        const { who, ts, ids, sig } = body;
        if (!Array.isArray(ids) || ids.length > 500 || !ids.every(Number.isInteger)) return fail('Bad request.');
        if (!(await verify(who, `ack:${who}:${ts}:${ids.join(',')}`, sig))) return fail('Bad signature.', 401);
        if (ids.length) await env.DB.batch(ids.map((id) => env.DB.prepare('DELETE FROM mail WHERE id = ? AND rcpt = ?').bind(id, who)));
        return json({ ok: true });
      }
      case '/blob/get':
        return blobGet(env, body);
      case '/blob/del':
        return blobDel(env, body);
      default:
        return fail('Not found.', 404);
    }
  },
};
