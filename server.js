'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { memoryStore, supabaseStore } = require('./store');

const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || 'Asia/Manila';
const PROD = process.env.NODE_ENV === 'production';
const need = n => { if (!process.env[n]) { console.error('Missing environment variable ' + n); process.exit(1); } return process.env[n]; };
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set: sessions end whenever the server restarts.');
const store = process.env.STORE === 'memory' ? memoryStore() : supabaseStore(need('SUPABASE_URL'), need('SUPABASE_SERVICE_KEY'));

// ---------- who may read and write what ----------
// r: admin | own:id | own:empId | settings     w: admin | own
const COL = {
  staff:      { r: 'own:id',    w: 'admin' },
  payslips:   { r: 'own:empId', w: 'admin' },
  leaves:     { r: 'own:empId', w: 'own' },
  attendance: { r: 'own:empId', w: 'own' },
  loans:      { r: 'own:empId', w: 'admin' },
  adjust:     { r: 'own:empId', w: 'admin' },
  roster:     { r: 'own:empId', w: 'admin' },
  settings:   { r: 'settings',  w: 'admin' },
  history:    { r: 'admin',     w: 'admin' },
  sales:      { r: 'admin',     w: 'admin' },
  nodays:     { r: 'admin',     w: 'admin' },
  photos:     { r: 'admin',     w: 'own' }
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const isAdm = c => c.role === 'admin' || !!c.adm;
const live = s => !s.resigned || !s.resignDate || s.resignDate >= today();

function canSee(col, ctx, row) {
  if (isAdm(ctx)) return true;
  const r = COL[col].r;
  if (r === 'admin') return false;
  if (r === 'settings') return row.id === 'leave';
  if (r === 'own:id') return row.id === ctx.id;
  return !!(row.data && row.data.empId === ctx.id);
}
function writeError(col, ctx, existing, next, method) {
  if (isAdm(ctx)) return null;
  if (COL[col].w === 'admin') return 'Only an admin can change this.';
  const me = ctx.id;
  if (col === 'leaves') {
    if (existing || method === 'DELETE') return 'A leave request cannot be changed here.';
    if (next.empId !== me || next.status !== 'pending') return 'Not allowed.';
    return null;
  }
  if (method === 'DELETE') return 'Not allowed.';
  if (next.empId !== me || next.date !== today()) return 'You can only save your own record for today.';
  if (existing && existing.empId !== me) return 'Not allowed.';
  if (col === 'attendance') {
    if (next.off || next.absent || next.half || next.imported) return 'Not allowed.';
    if (existing && existing.in && next.in !== existing.in) return 'Time in cannot be changed.';
    if (existing && existing.out && next.out !== existing.out) return 'You already clocked out.';
  }
  return null;
}

// ---------- passwords and sessions ----------
const b64 = s => Buffer.from(s).toString('base64url');
const sign = p => { const b = b64(JSON.stringify(p)); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); };
function verify(t) {
  if (!t) return null;
  const [b, s] = t.split('.');
  if (!s) return null;
  const e = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (e.length !== s.length || !crypto.timingSafeEqual(Buffer.from(e), Buffer.from(s))) return null;
  try { const p = JSON.parse(Buffer.from(b, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch (x) { return null; }
}
const newPw = pw => { const salt = crypto.randomBytes(16).toString('hex'); return { algo: 'scrypt', salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') }; };
function checkPw(row, pw) {
  if (!row) return false;
  let h;
  if (row.algo === 'scrypt') h = crypto.scryptSync(pw, row.salt, 32).toString('hex');
  else if (row.algo === 'sha256') h = crypto.createHash('sha256').update(row.salt + ':' + pw).digest('hex');
  else return false;
  return h.length === row.hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(row.hash));
}
const upgrade = (row, pw) => row.algo === 'scrypt' ? null : store.putCred(Object.assign({}, row, newPw(pw)));

// ---------- cached reads ----------
const cache = {}, bump = {}, T0 = Date.now();
async function getAll(col) {
  const c = cache[col];
  if (c && Date.now() - c.t < 60000) return c.rows;
  const rows = await store.list(col);
  cache[col] = { t: Date.now(), rows };
  return rows;
}
const changed = col => { delete cache[col]; bump[col] = (bump[col] || 0) + 1; };

// ---------- http helpers ----------
const send = (res, code, obj, extra) => { const b = JSON.stringify(obj); res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extra)); res.end(b); };
function body(req) {
  return new Promise((ok, no) => {
    let n = 0; const ch = [];
    req.on('data', d => { n += d.length; if (n > 3e6) { no(new Error('Too large')); req.destroy(); } else ch.push(d); });
    req.on('end', () => { try { ok(ch.length ? JSON.parse(Buffer.concat(ch).toString()) : {}); } catch (e) { no(new Error('Bad JSON')); } });
  });
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split(/=(.*)/s)).filter(a => a[0]));
const setCookie = (res, v, age) => res.setHeader('Set-Cookie', 'hub=' + v + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + age + (PROD ? '; Secure' : ''));
const ID = /^[A-Za-z0-9_\-.:@+]{1,200}$/;

async function context(req) {
  const p = verify(cookies(req).hub);
  if (!p) return null;
  if (p.role === 'admin') return { role: 'admin', id: 'admin' };
  const s = (await getAll('staff')).find(r => r.id === p.id);
  if (!s || !live(s.data)) return null;
  return { role: 'staff', id: p.id, adm: !!s.data.isAdm, name: s.data.name };
}

const fails = new Map();
function limited(ip) { const f = fails.get(ip); return f && f.n >= 8 && Date.now() - f.t < 600000; }
function failed(ip) { const f = fails.get(ip); fails.set(ip, f && Date.now() - f.t < 600000 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() }); }

// ---------- routes ----------
async function api(req, res, u) {
  const m = req.method, parts = u.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
  if (m !== 'GET' && req.headers['x-hub'] !== '1') return send(res, 403, { error: 'Bad request' });
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  if (parts[0] === 'login' && m === 'POST') {
    if (limited(ip)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const b = await body(req), ident = String(b.id || '').trim(), pw = String(b.password || '');
    const admin = await store.findAdmin();
    let ctx = null, inactive = false;
    if (admin && admin.username && ident.toLowerCase() === admin.username.toLowerCase() && checkPw(admin, pw)) { ctx = { role: 'admin', id: 'admin' }; await upgrade(admin, pw); }
    else {
      const id = ident.toUpperCase(), s = ident && ID.test(id) ? await store.get('staff', id) : null, row = s && await store.getCred(id);
      if (s && checkPw(row, pw)) { if (live(s.data)) { ctx = { role: 'staff', id }; await upgrade(row, pw); } else inactive = true; }
    }
    if (inactive) return send(res, 403, { error: 'This account is no longer active. Please contact your admin.' });
    if (!ctx) { failed(ip); return send(res, 401, { error: 'ID or password is incorrect.' }); }
    fails.delete(ip);
    setCookie(res, sign({ role: ctx.role, id: ctx.id, exp: Date.now() + 12 * 3600e3 }), 12 * 3600);
    return send(res, 200, { ok: true });
  }
  if (parts[0] === 'logout' && m === 'POST') { setCookie(res, '', 0); return send(res, 200, { ok: true }); }

  const ctx = await context(req);
  if (!ctx) return send(res, 401, { error: 'Please sign in.' });

  if (parts[0] === 'me' && m === 'GET') {
    const admin = ctx.role === 'admin' ? await store.findAdmin() : null;
    return send(res, 200, { role: ctx.role, id: ctx.id, adm: !!ctx.adm, name: ctx.role === 'admin' ? (admin && admin.username) || 'Admin' : ctx.name });
  }

  if (parts[0] === 'password' && m === 'POST') {
    const b = await body(req), row = await store.getCred(ctx.id);
    if (!checkPw(row, String(b.current || ''))) return send(res, 400, { error: 'Your current password is incorrect.' });
    const n = String(b.next || '');
    if (n.length < 6) return send(res, 400, { error: 'New password must be at least 6 characters.' });
    await store.putCred(Object.assign({}, row, newPw(n)));
    return send(res, 200, { ok: true });
  }
  if (parts[0] === 'admin-account' && m === 'POST') {
    if (ctx.role !== 'admin') return send(res, 403, { error: 'Only the admin account can do this.' });
    const b = await body(req), row = await store.getCred('admin'), n = String(b.next || ''), u = String(b.username || '').trim();
    if (!checkPw(row, String(b.current || ''))) return send(res, 400, { error: 'Your current password is incorrect.' });
    if (u.length < 3) return send(res, 400, { error: 'Username must be at least 3 characters.' });
    if (n && n.length < 6) return send(res, 400, { error: 'New password must be at least 6 characters.' });
    await store.putCred(Object.assign({}, row, n ? newPw(n) : {}, { username: u }));
    return send(res, 200, { ok: true });
  }
  if (parts[0] === 'staff-password' && m === 'POST') {
    if (!isAdm(ctx)) return send(res, 403, { error: 'Only an admin can do this.' });
    const b = await body(req), id = String(b.id || '').toUpperCase(), pw = String(b.password || '');
    if (!ID.test(id) || id === 'ADMIN') return send(res, 400, { error: 'Invalid employee ID.' });
    if (pw.length < 4) return send(res, 400, { error: 'Password must be at least 4 characters.' });
    if (!(await store.get('staff', id))) return send(res, 404, { error: 'Save the employee first.' });
    await store.putCred(Object.assign({ id, role: 'staff' }, newPw(pw)));
    return send(res, 200, { ok: true });
  }

  if (parts[0] === 'db' && parts[1] && COL[parts[1]]) {
    const col = parts[1], id = parts[2];
    if (!id) {
      if (m !== 'GET') return send(res, 405, { error: 'Method not allowed' });
      if (COL[col].r === 'admin' && !isAdm(ctx)) return send(res, 403, { error: 'Not allowed.' });
      const f = u.searchParams.get('f'), scope = isAdm(ctx) ? 'a' : ctx.id;
      let rows, etag = null;
      if (f) {
        if (!/^[A-Za-z0-9_]+$/.test(f) || !['eq', 'lt', 'lte', 'gt', 'gte'].includes(u.searchParams.get('op'))) return send(res, 400, { error: 'Bad query' });
        rows = await store.list(col, { f, op: u.searchParams.get('op'), v: u.searchParams.get('v') || '' });
      } else {
        etag = 'W/"' + T0 + '-' + (bump[col] || 0) + '-' + scope + '"';
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
        rows = await getAll(col);
      }
      const idsOnly = u.searchParams.get('fields') === 'id';
      const docs = rows.filter(r => canSee(col, ctx, r)).map(r => ({ id: r.id, data: idsOnly ? {} : r.data }));
      return send(res, 200, { docs }, etag ? { ETag: etag } : {});
    }
    if (!ID.test(id)) return send(res, 400, { error: 'Bad id' });
    const ex = await store.get(col, id);
    if (m === 'GET') return ex && canSee(col, ctx, ex) ? send(res, 200, { id, data: ex.data }) : send(res, 404, { error: 'Not found' });
    if (ex && !canSee(col, ctx, ex) && !isAdm(ctx)) return send(res, 403, { error: 'Not allowed.' });
    if (m === 'DELETE') {
      const e = writeError(col, ctx, ex && ex.data, null, 'DELETE');
      if (e) return send(res, 403, { error: e });
      await store.del(col, id); changed(col);
      return send(res, 200, { ok: true });
    }
    if (m === 'PUT' || m === 'PATCH') {
      const b = await body(req);
      if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'Bad data' });
      if (m === 'PATCH' && !ex) return send(res, 404, { error: 'Not found' });
      const next = m === 'PATCH' ? Object.assign({}, ex.data, b) : b;
      const e = writeError(col, ctx, ex && ex.data, next, m);
      if (e) return send(res, 403, { error: e });
      const r = await store.put(col, id, next); changed(col);
      return send(res, 200, { ok: true, version: r.version });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const PUB = path.join(__dirname, 'public');
function serveStatic(req, res, u) {
  let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, '');
  if (!p) p = 'index.html';
  const f = path.join(PUB, p);
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/healthz') return send(res, 200, { ok: true });
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    return serveStatic(req, res, u);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong. Please try again.' });
  }
});

async function boot() {
  if (!(await store.findAdmin())) {
    const u = process.env.ADMIN_USERNAME, p = process.env.ADMIN_PASSWORD;
    if (u && p && p.length >= 6) { await store.putCred(Object.assign({ id: 'admin', role: 'admin', username: u }, newPw(p))); console.log('Admin account created for "' + u + '".'); }
    else console.warn('No admin account yet. Set ADMIN_USERNAME and ADMIN_PASSWORD (at least 6 characters) and restart.');
  }
  server.listen(PORT, () => console.log('Company Hub listening on ' + PORT));
}
if (require.main === module) boot(); else module.exports = { server, boot, store };
