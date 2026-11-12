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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'uan-mailbox' });
    if (request.method !== 'POST') return fail('Not found.', 404);

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
      default:
        return fail('Not found.', 404);
    }
  },
};
