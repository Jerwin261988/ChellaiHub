'use strict';
// Storage layer. Supabase (PostgREST over fetch, no dependencies) or an in-memory store for local tests.

function match(d, f) {
  const a = d ? d[f.f] : undefined, v = f.v;
  switch (f.op) {
    case 'eq': return String(a) === v;
    case 'lt': return String(a) < v;
    case 'lte': return String(a) <= v;
    case 'gt': return String(a) > v;
    case 'gte': return String(a) >= v;
  }
  return false;
}

function memoryStore() {
  const docs = new Map(), creds = new Map();
  const k = (c, i) => c + '\u0000' + i;
  return {
    async list(col, flt) {
      const out = [];
      for (const v of docs.values()) if (v.collection === col && (!flt || match(v.data, flt))) out.push({ id: v.id, data: v.data, version: v.version });
      return out.sort((a, b) => (a.id < b.id ? -1 : 1));
    },
    async get(col, id) { const v = docs.get(k(col, id)); return v ? { id, data: v.data, version: v.version } : null; },
    async put(col, id, data) { const o = docs.get(k(col, id)); const v = { collection: col, id, data, version: (o ? o.version : 0) + 1 }; docs.set(k(col, id), v); return v; },
    async putMany(col, entries) { for (const [id, data] of entries) await this.put(col, id, data); },
    async del(col, id) { docs.delete(k(col, id)); },
    async getCred(id) { return creds.get(id) || null; },
    async putCred(row) { creds.set(row.id, row); },
    async findAdmin() { for (const r of creds.values()) if (r.role === 'admin') return r; return null; }
  };
}

function supabaseStore(url, key) {
  const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const base = url.replace(/\/$/, '') + '/rest/v1/';
  async function rq(path, opt) {
    const r = await fetch(base + path, Object.assign({ headers: H }, opt));
    if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + (await r.text()).slice(0, 300));
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }
  const q = encodeURIComponent;
  return {
    async list(col, flt) {
      let out = [], from = 0;
      const step = 1000;
      for (;;) {
        let p = 'documents?collection=eq.' + q(col) + '&select=id,data,version&order=id.asc&limit=' + step + '&offset=' + from;
        if (flt) p += '&' + q('data->>' + flt.f) + '=' + flt.op + '.' + q(flt.v);
        const rows = await rq(p);
        out = out.concat(rows);
        if (rows.length < step) break;
        from += step;
      }
      return out;
    },
    async get(col, id) {
      const r = await rq('documents?collection=eq.' + q(col) + '&id=eq.' + q(id) + '&select=id,data,version');
      return r && r[0] ? r[0] : null;
    },
    async put(col, id, data) {
      const o = await this.get(col, id), version = (o ? o.version : 0) + 1;
      await rq('documents?on_conflict=collection,id', { method: 'POST', headers: Object.assign({}, H, { Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify({ collection: col, id, data, version, updated_at: new Date().toISOString() }) });
      return { id, data, version };
    },
    async putMany(col, entries) {
      for (let i = 0; i < entries.length; i += 300) {
        const rows = entries.slice(i, i + 300).map(([id, data]) => ({ collection: col, id, data, version: 1, updated_at: new Date().toISOString() }));
        await rq('documents?on_conflict=collection,id', { method: 'POST', headers: Object.assign({}, H, { Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(rows) });
      }
    },
    async del(col, id) { await rq('documents?collection=eq.' + q(col) + '&id=eq.' + q(id), { method: 'DELETE' }); },
    async getCred(id) { const r = await rq('credentials?id=eq.' + q(id) + '&select=*'); return r && r[0] ? r[0] : null; },
    async putCred(row) {
      await rq('credentials?on_conflict=id', { method: 'POST', headers: Object.assign({}, H, { Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(Object.assign({}, row, { updated_at: new Date().toISOString() })) });
    },
    async findAdmin() { const r = await rq('credentials?role=eq.admin&select=*&limit=1'); return r && r[0] ? r[0] : null; }
  };
}

module.exports = { memoryStore, supabaseStore };
