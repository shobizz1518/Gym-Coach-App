// Gym Coach server: serves the app and stores everyone's data so all phones share one group.
// Storage: Postgres when DATABASE_URL is set, otherwise a JSON file (fine for testing; Render's free disk is wiped on redeploy).
// Optional GROUP_CODE env var: when set, a phone must enter it once before it can read or save anything.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CODE = (process.env.GROUP_CODE || '').trim();
const ROOT = __dirname;
const MAX_BODY = 4 * 1024 * 1024;
const ADMIN_PIN = (process.env.ADMIN_PIN || '').trim();

// ---------- storage ----------
let store;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
  const ready = pool.query('CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, u BIGINT NOT NULL DEFAULT 0, body JSONB)');
  store = {
    kind: 'postgres',
    async all() { await ready; const r = await pool.query('SELECT id, u, body FROM docs'); return r.rows.map(x => ({ id: x.id, u: Number(x.u), body: x.body })); },
    async get(id) { await ready; const r = await pool.query('SELECT id, u, body FROM docs WHERE id = $1', [id]); return r.rows[0] ? { id, u: Number(r.rows[0].u), body: r.rows[0].body } : null; },
    async put(id, u, body) { await ready; await pool.query('INSERT INTO docs (id, u, body) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET u = EXCLUDED.u, body = EXCLUDED.body', [id, u, JSON.stringify(body)]); },
    async del(id) { await ready; await pool.query('DELETE FROM docs WHERE id = $1', [id]); },
  };
} else {
  const file = path.join(process.env.DATA_DIR || ROOT, 'data.json');
  let mem = {};
  try { mem = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { }
  let t = null;
  const save = () => { clearTimeout(t); t = setTimeout(() => fs.writeFile(file, JSON.stringify(mem), () => { }), 300); };
  store = {
    kind: 'file',
    async all() { return Object.entries(mem).map(([id, d]) => ({ id, u: d.u, body: d.body })); },
    async get(id) { return mem[id] ? { id, ...mem[id] } : null; },
    async put(id, u, body) { mem[id] = { u, body }; save(); },
    async del(id) { delete mem[id]; save(); },
  };
}

// ---------- per-person PINs ----------
// Private docs (a person's settings, which hold age/height/weight/targets/weigh-ins, and their food logs m_*) are only
// sent or accepted with that person's token. PINs are stored as salted scrypt hashes in the hidden _pins doc.
function splitId(id) { const m = id.match(/^pr_(.+?)__(.+)$/); return m ? { pid: m[1], key: m[2] } : { pid: 'main', key: id }; }
const isPrivate = id => { if (id === 'profiles') return false; const { key } = splitId(id); return key === 'priv' || key.startsWith('m_'); };
// personal fields never live in the shared settings doc (older app versions put them there)
const PRIV_KEYS = ['profile', 'targets', 'weighIns', 'autoT', 'tnote', 'foods', 'waterGoal'];
const isSettings = id => id !== 'profiles' && splitId(id).key === 'settings';
const stripPriv = b => b && typeof b === 'object' ? Object.fromEntries(Object.entries(b).filter(([k]) => !PRIV_KEYS.includes(k))) : b;
const privOf = b => b && typeof b === 'object' ? Object.fromEntries(Object.entries(b).filter(([k]) => PRIV_KEYS.includes(k))) : {};
const privIdFor = id => { const { pid } = splitId(id); return pid === 'main' ? 'priv' : `pr_${pid}__priv`; };
async function migratePrivate() {
  for (const d of await store.all()) {
    if (!isSettings(d.id) || !d.body) continue;
    const pv = privOf(d.body); if (!Object.keys(pv).length) continue;
    const pid = privIdFor(d.id); if (!(await store.get(pid))) await store.put(pid, d.u, pv);
    await store.put(d.id, d.u, stripPriv(d.body));
  }
}
migratePrivate().then(() => console.log('private fields checked')).catch(e => console.error('migrate', e));
let SECRET = null;
async function secret() {
  if (SECRET) return SECRET;
  const d = await store.get('_secret');
  if (d && d.body && d.body.k) SECRET = d.body.k;
  else { SECRET = crypto.randomBytes(32).toString('hex'); await store.put('_secret', Date.now(), { k: SECRET }); }
  return SECRET;
}
async function pins() { const d = await store.get('_pins'); return (d && d.body) || {}; }
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
async function tokenFor(pid, rec) { return crypto.createHmac('sha256', await secret()).update(pid + ':' + rec.hash).digest('hex'); }
function readTokens(req) { try { const t = JSON.parse(decodeURIComponent(req.headers['x-pins'] || '') || '{}'); return t && typeof t === 'object' ? t : {}; } catch (e) { return {}; } }
async function canAccess(pid, tokens, P) {
  const rec = P[pid]; if (!rec) return true; // no PIN set yet
  const t = tokens[pid]; if (typeof t !== 'string') return false;
  const good = await tokenFor(pid, rec);
  return t.length === good.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(good));
}
const FAILS = new Map(); // pid -> { n, until }
function blocked(pid) { const f = FAILS.get(pid); return f && f.until > Date.now(); }
function failed(pid) { const f = FAILS.get(pid) || { n: 0, until: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60e3; f.n = 0; } FAILS.set(pid, f); }
const validPin = p => typeof p === 'string' && /^\d{4}$/.test(p);

// profiles are merged rather than overwritten, so two phones adding people at once both keep theirs
async function putProfiles(u, body, tokens) {
  const cur = await store.get('profiles'), P = await pins();
  const asked = ((body && body.deleted) || []).map(String), okDel = [];
  for (const pid of asked) if (await canAccess(pid, tokens, P)) okDel.push(pid); // can't delete someone else's PIN-protected person
  const deleted = [...new Set([...((cur && cur.body && cur.body.deleted) || []), ...okDel].map(String))].slice(-500);
  const byId = new Map();
  for (const p of ((cur && cur.body && cur.body.list) || [])) if (p && p.id) byId.set(String(p.id), p);
  for (const p of ((body && body.list) || [])) if (p && p.id) byId.set(String(p.id), { id: String(p.id), name: String(p.name || 'Me').slice(0, 30) });
  const list = [...byId.values()].filter(p => !deleted.includes(p.id));
  const nu = Math.max(Number(u) || 0, (cur && cur.u) || 0, Date.now());
  await store.put('profiles', nu, { list, deleted });
  if (okDel.length) { const P2 = await pins(); okDel.forEach(p => delete P2[p]); await store.put('_pins', Date.now(), P2); }
  return { u: nu, body: { list, deleted } };
}

// ---------- http ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((ok, bad) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { bad(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { bad(e); } });
    req.on('error', bad);
  });
}
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_\-]{1,120}$/.test(id);

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/api/health') return send(res, 200, { ok: true, store: store.kind, code: !!CODE });
    if (p.startsWith('/api/')) {
      if (CODE && (req.headers['x-group-code'] || '').trim().toLowerCase() !== CODE.toLowerCase()) return send(res, 401, { error: 'need_code' });
      const tokens = readTokens(req);
      if (p === '/api/docs' && req.method === 'GET') {
        const P = await pins(), all = await store.all(), out = [];
        for (const d0 of all) { const d = isSettings(d0.id) ? { ...d0, body: stripPriv(d0.body) } : d0; if (d.id.startsWith('_')) continue; if (isPrivate(d.id) && !(await canAccess(splitId(d.id).pid, tokens, P))) continue; out.push(d); }
        return send(res, 200, { docs: out, pins: Object.keys(P) });
      }
      if (p === '/api/pins' && req.method === 'GET') return send(res, 200, { pins: Object.keys(await pins()) });
      const pm = p.match(/^\/api\/(unlock|pin)\/([A-Za-z0-9_\-]{1,60})$/);
      if (pm && req.method === 'POST') {
        const [, what, pid] = pm, d = await readBody(req), P = await pins(), rec = P[pid];
        if (blocked(pid)) return send(res, 429, { error: 'too_many', wait: Math.ceil((FAILS.get(pid).until - Date.now()) / 1000) });
        if (what === 'unlock') {
          if (!rec) return send(res, 200, { token: null, none: true });
          const ok = (validPin(d.pin) && hashPin(d.pin, rec.salt) === rec.hash) || (ADMIN_PIN && String(d.pin) === ADMIN_PIN);
          if (!ok) { failed(pid); return send(res, 403, { error: 'wrong_pin' }); }
          FAILS.delete(pid); return send(res, 200, { token: await tokenFor(pid, rec) });
        }
        // set or change a PIN: allowed when none is set, or with that person's token, old PIN, or the admin PIN
        if (!validPin(d.pin)) return send(res, 400, { error: 'pin_format' });
        if (rec && !(await canAccess(pid, tokens, P)) && !(validPin(d.old) && hashPin(d.old, rec.salt) === rec.hash) && !(ADMIN_PIN && String(d.old) === ADMIN_PIN)) { failed(pid); return send(res, 403, { error: 'wrong_pin' }); }
        const salt = crypto.randomBytes(16).toString('hex'), nrec = { salt, hash: hashPin(d.pin, salt) };
        P[pid] = nrec; await store.put('_pins', Date.now(), P);
        return send(res, 200, { token: await tokenFor(pid, nrec) });
      }
      const m = p.match(/^\/api\/docs\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!validId(id) || id.startsWith('_')) return send(res, 400, { error: 'bad_id' });
        if (isPrivate(id) && !(await canAccess(splitId(id).pid, tokens, await pins()))) return send(res, 403, { error: 'locked' });
        if (req.method === 'PUT') {
          const d = await readBody(req);
          if (id === 'profiles') return send(res, 200, await putProfiles(d.u, d.body, tokens));
          if (isSettings(id) && d.body) { const pv = privOf(d.body); if (Object.keys(pv).length && await canAccess(splitId(id).pid, tokens, await pins())) { const pidDoc = privIdFor(id), c = await store.get(pidDoc); if (!c) await store.put(pidDoc, Number(d.u) || Date.now(), pv); } d.body = stripPriv(d.body); }
          const cur = await store.get(id);
          const u = Number(d.u) || Date.now();
          if (cur && cur.u > u) return send(res, 200, { u: cur.u, body: cur.body, stale: true });
          await store.put(id, u, d.body == null ? null : d.body);
          return send(res, 200, { ok: true, u });
        }
        if (req.method === 'DELETE') { await store.del(id); return send(res, 200, { ok: true }); }
      }
      return send(res, 404, { error: 'not_found' });
    }
    // static files
    let f = p === '/' ? '/index.html' : p;
    f = path.normalize(path.join(ROOT, f));
    if (!f.startsWith(ROOT) || /server\.js|data\.json|package|render\.yaml|node_modules|\.git/.test(path.relative(ROOT, f))) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    fs.readFile(f, (err, buf) => {
      if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      send(res, 200, buf, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': f.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' });
    });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'server_error' });
  }
}).listen(PORT, () => console.log(`Gym Coach on :${PORT} (storage: ${store.kind}${CODE ? ', group code on' : ''})`));
