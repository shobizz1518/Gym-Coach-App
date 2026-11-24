// Gym Coach server: serves the app and stores everyone's data so all phones share one group.
// Storage: Postgres when DATABASE_URL is set, otherwise a JSON file (fine for testing; Render's free disk is wiped on redeploy).
// Optional GROUP_CODE env var: when set, a phone must enter it once before it can read or save anything.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CODE = (process.env.GROUP_CODE || '').trim();
const ROOT = __dirname;
const MAX_BODY = 4 * 1024 * 1024;

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

// profiles are merged rather than overwritten, so two phones adding people at once both keep theirs
async function putProfiles(u, body) {
  const cur = await store.get('profiles');
  const deleted = [...new Set([...((cur && cur.body && cur.body.deleted) || []), ...((body && body.deleted) || [])].map(String))].slice(-500);
  const byId = new Map();
  for (const p of ((cur && cur.body && cur.body.list) || [])) if (p && p.id) byId.set(String(p.id), p);
  for (const p of ((body && body.list) || [])) if (p && p.id) byId.set(String(p.id), { id: String(p.id), name: String(p.name || 'Me').slice(0, 30) });
  const list = [...byId.values()].filter(p => !deleted.includes(p.id));
  const nu = Math.max(Number(u) || 0, (cur && cur.u) || 0, Date.now());
  await store.put('profiles', nu, { list, deleted });
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
      if (p === '/api/docs' && req.method === 'GET') return send(res, 200, { docs: await store.all() });
      const m = p.match(/^\/api\/docs\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!validId(id)) return send(res, 400, { error: 'bad_id' });
        if (req.method === 'PUT') {
          const d = await readBody(req);
          if (id === 'profiles') return send(res, 200, await putProfiles(d.u, d.body));
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
