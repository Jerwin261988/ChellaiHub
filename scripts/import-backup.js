'use strict';
// Loads a backup file made with "Download backup" in the old hub (Account tab) into this app's database.
// Usage:  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/import-backup.js backup.json
const fs = require('fs');
const { memoryStore, supabaseStore } = require('../store');
const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/import-backup.js backup.json'); process.exit(1); }
const b = JSON.parse(fs.readFileSync(file, 'utf8'));
if (b.app !== 'company-hub' || !b.data) { console.error('That is not a Company Hub backup file.'); process.exit(1); }
const store = process.env.STORE === 'memory' ? memoryStore() : supabaseStore(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
(async () => {
  let n = 0;
  for (const [col, docs] of Object.entries(b.data)) {
    if (col === 'creds') {
      // Employees keep their existing passwords (they are upgraded to a stronger hash at their next sign-in).
      for (const [id, c] of Object.entries(docs)) { if (id === 'admin') continue; await store.putCred({ id, role: 'staff', algo: 'sha256', salt: c.salt, hash: c.hash }); n++; }
      continue;
    }
    const entries = Object.entries(docs);
    await store.putMany(col, entries);
    n += entries.length;
    console.log(col + ': ' + entries.length);
  }
  console.log('Imported ' + n + ' records.');
})().catch(e => { console.error(e.message); process.exit(1); });
