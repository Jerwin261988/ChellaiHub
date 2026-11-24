// Small client library that gives the hub page its database, user and download helpers.
// The page talks to this server (/api/...); the server talks to Supabase.
(function () {
  const J = { 'Content-Type': 'application/json', 'X-Hub': '1' };
  async function api(path, opt) {
    const r = await fetch(path, Object.assign({ credentials: 'same-origin' }, opt));
    if (r.status === 304) return { status: 304 };
    if (!r.ok) {
      let m = ''; try { m = (await r.json()).error; } catch (e) {}
      const e = new Error(m || ('HTTP ' + r.status)); e.code = r.status; throw e;
    }
    return { status: r.status, json: await r.json(), etag: r.headers.get('ETag') };
  }
  const snap = (id, d) => ({ id: id, exists: true, data: () => d });
  const OPS = { '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte', '==': 'eq', '=': 'eq' };

  function collection(name) {
    const base = '/api/db/' + encodeURIComponent(name);
    return {
      doc(id) {
        const u = base + '/' + encodeURIComponent(id);
        return {
          async get() {
            try { const r = await api(u); return snap(id, r.json.data); }
            catch (e) { if (e.code === 404) return { id: id, exists: false, data: () => undefined }; throw e; }
          },
          async set(d) { await api(u, { method: 'PUT', headers: J, body: JSON.stringify(d) }); },
          async update(d) { await api(u, { method: 'PATCH', headers: J, body: JSON.stringify(d) }); },
          async delete() { await api(u, { method: 'DELETE', headers: J }); }
        };
      },
      // Checks for changes every few seconds; the server answers "not modified" when nothing changed.
      onSnapshot(cb, err) {
        let etag = null, stop = false, timer = null, broken = false;
        const tick = async () => {
          if (stop) return;
          try {
            if (!document.hidden) {
              const r = await api(base, { headers: etag ? { 'If-None-Match': etag } : {} });
              broken = false;
              if (r.status !== 304) { etag = r.etag; cb({ docs: r.json.docs.map(d => snap(d.id, d.data)) }); }
            }
          } catch (e) {
            if (e.code === 401) { location.reload(); return; }
            if (!broken && err) err(e);
            broken = true;
          }
          timer = setTimeout(tick, 4000);
        };
        tick();
        return () => { stop = true; clearTimeout(timer); };
      },
      // Returns document ids only (used for housekeeping such as deleting old photos).
      where(f, op, v) {
        return {
          async get() {
            const r = await api(base + '?f=' + encodeURIComponent(f) + '&op=' + (OPS[op] || op) + '&v=' + encodeURIComponent(v) + '&fields=id');
            return { docs: r.json.docs.map(d => snap(d.id, d.data)) };
          }
        };
      }
    };
  }

  const MIMES = { pdf: 'application/pdf', html: 'text/html', json: 'application/json', csv: 'text/csv' };
  const downloads = {
    async save(req) {
      const ext = (req.filename.split('.').pop() || '').toLowerCase();
      const blob = req.data instanceof Blob ? req.data : new Blob([req.data], { type: MIMES[ext] || 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = req.filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      return { ok: true };
    }
  };

  window.claude = {
    use: async function (name) {
      if (name === 'db') return { collection: collection };
      if (name === 'downloads') return downloads;
      return null;
    }
  };
})();
