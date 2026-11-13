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

// ---- GIF search for GIPHY (if a GIPHY_KEY secret is set). KLIPY is searched by the app itself,
// as KLIPY requires. GET /gif?p=giphy&q=<search, empty = trending>&page=<1..>
// -> { ok, items: [{ id, url (to send), preview (small), w, h }], more }
const GIF_PER_PAGE = 24;

async function gifSearch(env, url) {
  const p = 'giphy';
  const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
  const page = Math.max(1, Math.min(50, Number(url.searchParams.get('page')) || 1));
  const cache = caches.default;
  const cacheKey = new Request(`https://gif-cache/${p}/${page}/${encodeURIComponent(q.toLowerCase())}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  let items = [];
  let more = false;
  if (p === 'giphy') {
    if (!env.GIPHY_KEY) return fail('GIPHY isn’t set up yet.', 503);
    const api = new URL(q ? 'https://api.giphy.com/v1/gifs/search' : 'https://api.giphy.com/v1/gifs/trending');
    api.searchParams.set('api_key', env.GIPHY_KEY);
    if (q) api.searchParams.set('q', q);
    api.searchParams.set('limit', String(GIF_PER_PAGE));
    api.searchParams.set('offset', String((page - 1) * GIF_PER_PAGE));
    api.searchParams.set('rating', 'pg-13');
    const r = await fetch(api);
    if (!r.ok) return fail(`GIPHY error ${r.status}`, 502);
    const d = await r.json();
    items = (d.data || []).map((g) => ({
      id: g.id,
      url: g.images?.downsized?.url || g.images?.original?.url,
      preview: g.images?.fixed_width?.url || g.images?.downsized?.url,
      w: Number(g.images?.fixed_width?.width) || 200,
      h: Number(g.images?.fixed_width?.height) || 150,
    })).filter((g) => g.url);
    more = (d.pagination?.total_count || 0) > page * GIF_PER_PAGE;
  }
  const res = new Response(JSON.stringify({ ok: true, items, more }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=600', 'access-control-allow-origin': '*' },
  });
  await cache.put(cacheKey, res.clone());
  return res;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'uan-mailbox' });
    if (request.method === 'GET' && url.pathname === '/gif') {
      let res;
      try {
        res = await gifSearch(env, url);
      } catch (e) {
        res = fail('GIF search failed.', 502);
      }
      // The app reads this from its own page, so every answer (errors too) needs this header.
      const h = new Headers(res.headers);
      h.set('access-control-allow-origin', '*');
      return new Response(res.body, { status: res.status, headers: h });
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
        await env.DB.prepare('DELETE FROM mail WHERE created < ?').bind(now - KEEP_MS).run();
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
