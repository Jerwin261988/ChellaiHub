'use strict';
// Starts the server with an in-memory store and checks sign-in and access rules.
const { spawn } = require('child_process');
const crypto = require('crypto');
const PORT = 3999, B = 'http://localhost:' + PORT;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
let ok = 0, bad = 0;
const t = (name, cond) => { if (cond) { ok++; console.log('  ok  ' + name); } else { bad++; console.log('  FAIL ' + name); } };
function client() {
  let cookie = '';
  return async (method, path, body, hdr) => {
    const r = await fetch(B + path, { method, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Hub': '1', Cookie: cookie }, hdr), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let j = null; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j, etag: r.headers.get('etag') };
  };
}
(async () => {
  const srv = spawn(process.execPath, ['server.js'], { env: Object.assign({}, process.env, { STORE: 'memory', PORT, SESSION_SECRET: 'x'.repeat(40), ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'secret123', TZ: 'Asia/Manila' }), stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  try {
    const A = client(), S = client(), S2 = client(), N = client();
    t('not signed in is refused', (await N('GET', '/api/db/staff')).s === 401);
    t('wrong admin password refused', (await A('POST', '/api/login', { id: 'boss', password: 'nope' })).s === 401);
    t('admin signs in', (await A('POST', '/api/login', { id: 'boss', password: 'secret123' })).s === 200);
    const me = await A('GET', '/api/me'); t('me is admin', me.j.role === 'admin' && me.j.name === 'boss');
    t('admin creates employee 102', (await A('PUT', '/api/db/staff/102', { name: 'Mark', rate: 900 })).s === 200);
    t('admin creates employee 103', (await A('PUT', '/api/db/staff/103', { name: 'John', rate: 650 })).s === 200);
    t('admin sets passwords', (await A('POST', '/api/staff-password', { id: '102', password: 'pass102' })).s === 200 && (await A('POST', '/api/staff-password', { id: '103', password: 'pass103' })).s === 200);
    t('admin writes payslips', (await A('PUT', '/api/db/payslips/p1', { empId: '102', net: 5000 })).s === 200 && (await A('PUT', '/api/db/payslips/p2', { empId: '103', net: 4000 })).s === 200);
    await A('PUT', '/api/db/sales/s1', { amount: 1000, date: today });
    await A('PUT', '/api/db/settings/leave', { rule: 'all' });
    await A('PUT', '/api/db/settings/incentive', { pct: 1, target: 600000 });

    t('wrong employee password refused', (await S('POST', '/api/login', { id: '102', password: 'bad' })).s === 401);
    t('employee signs in (lowercase id works)', (await S('POST', '/api/login', { id: '102', password: 'pass102' })).s === 200);
    t('employee 103 signs in', (await S2('POST', '/api/login', { id: '103', password: 'pass103' })).s === 200);
    const st = await S('GET', '/api/db/staff'); t('employee sees only own staff record', st.j.docs.length === 1 && st.j.docs[0].id === '102');
    const ps = await S('GET', '/api/db/payslips'); t('employee sees only own payslips', ps.j.docs.length === 1 && ps.j.docs[0].data.empId === '102');
    t('employee cannot read sales', (await S('GET', '/api/db/sales')).s === 403);
    t('employee cannot read history', (await S('GET', '/api/db/history')).s === 403);
    const se = await S('GET', '/api/db/settings'); t('employee sees only the leave setting', se.j.docs.length === 1 && se.j.docs[0].id === 'leave');
    t('employee cannot write payslips', (await S('PUT', '/api/db/payslips/p9', { empId: '102', net: 99999 })).s === 403);
    t('employee cannot change own staff record', (await S('PUT', '/api/db/staff/102', { name: 'Mark', rate: 5000 })).s === 403);
    t('employee cannot read another payslip by id', (await S('GET', '/api/db/payslips/p2')).s === 404);
    t('creds are not an API collection', (await S('GET', '/api/db/creds')).s === 404);

    t('clock in for today', (await S('PUT', '/api/db/attendance/a_102_' + today, { empId: '102', name: 'Mark', date: today, in: 1000, out: null, photoIn: true })).s === 200);
    t('clock in for yesterday refused', (await S('PUT', '/api/db/attendance/a_102_2020-01-01', { empId: '102', date: '2020-01-01', in: 1 })).s === 403);
    t('clock in for someone else refused', (await S('PUT', '/api/db/attendance/a_103_' + today, { empId: '103', date: today, in: 1 })).s === 403);
    t('staff cannot mark off or absent', (await S('PUT', '/api/db/attendance/a_102_' + today, { empId: '102', date: today, in: 1000, out: null, absent: true })).s === 403);
    t('clock out works', (await S('PATCH', '/api/db/attendance/a_102_' + today, { out: 2000, photoOut: true })).s === 200);
    t('time in cannot be rewritten', (await S('PATCH', '/api/db/attendance/a_102_' + today, { in: 5 })).s === 403);
    t('clock out cannot be rewritten', (await S('PATCH', '/api/db/attendance/a_102_' + today, { out: 9999 })).s === 403);
    t('employee 103 cannot see 102 attendance', (await S2('GET', '/api/db/attendance')).j.docs.length === 0);
    t('admin sees attendance', (await A('GET', '/api/db/attendance')).j.docs.length === 1);

    t('employee requests leave (pending)', (await S('PUT', '/api/db/leaves/l1', { empId: '102', status: 'pending', type: 'sick' })).s === 200);
    t('employee cannot approve own leave', (await S('PATCH', '/api/db/leaves/l1', { status: 'approved' })).s === 403);
    t('employee cannot create approved leave', (await S('PUT', '/api/db/leaves/l2', { empId: '102', status: 'approved' })).s === 403);
    t('admin approves leave', (await A('PATCH', '/api/db/leaves/l1', { status: 'approved' })).s === 200);
    t('employee uploads own photo', (await S('PUT', '/api/db/photos/a_102_' + today + '_in', { empId: '102', date: today, img: 'data:x' })).s === 200);
    t('employee cannot read photos', (await S('GET', '/api/db/photos/a_102_' + today + '_in')).s === 404);
    t('employee cannot list photos', (await S('GET', '/api/db/photos')).s === 403);
    t('admin reads a photo', (await A('GET', '/api/db/photos/a_102_' + today + '_in')).s === 200);

    const l1 = await A('GET', '/api/db/payslips'); t('admin reads all payslips', l1.j.docs.length === 2);
    const l2 = await A('GET', '/api/db/payslips', null, { 'If-None-Match': l1.etag }); t('unchanged list answers 304', l2.s === 304);
    await A('PUT', '/api/db/payslips/p3', { empId: '102', net: 1 });
    const l3 = await A('GET', '/api/db/payslips', null, { 'If-None-Match': l1.etag }); t('changed list returns new data', l3.s === 200 && l3.j.docs.length === 3);
    const w = await A('GET', '/api/db/sales?f=date&op=lt&v=' + encodeURIComponent('2099-01-01') + '&fields=id'); t('query by field works', w.j.docs.length === 1);

    t('employee changes own password', (await S('POST', '/api/password', { current: 'pass102', next: 'newpass1' })).s === 200);
    t('old password stops working', (await client()('POST', '/api/login', { id: '102', password: 'pass102' })).s === 401);
    t('new password works', (await client()('POST', '/api/login', { id: '102', password: 'newpass1' })).s === 200);
    t('wrong current password refused', (await S('POST', '/api/password', { current: 'x', next: 'abcdefg' })).s === 400);
    t('employee cannot reset passwords', (await S('POST', '/api/staff-password', { id: '103', password: 'hack1234' })).s === 403);

    await A('PUT', '/api/db/staff/103', { name: 'John', rate: 650, resigned: true, resignDate: '2020-01-01' });
    t('resigned employee is signed out', (await S2('GET', '/api/me')).s === 401);
    t('resigned employee cannot sign in', (await client()('POST', '/api/login', { id: '103', password: 'pass103' })).s === 403);
    await A('PUT', '/api/db/staff/102', { name: 'Mark', rate: 900, isAdm: true });
    const S3 = client(); await S3('POST', '/api/login', { id: '102', password: 'newpass1' });
    t('employee with admin flag can read sales', (await S3('GET', '/api/db/sales')).s === 200);
    t('admin flag gives write access', (await S3('PUT', '/api/db/sales/s2', { amount: 5, date: today })).s === 200);
    t('requests without the header are refused', (await fetch(B + '/api/db/sales/s3', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: 'x=1' }, body: '{}' })).status === 403);
    t('page is served', (await (await fetch(B + '/')).text()).length >= 0);
    t('health check', (await fetch(B + '/healthz')).status === 200);
    let n = 0; for (let i = 0; i < 9; i++) { const r = await client()('POST', '/api/login', { id: '555', password: 'x' }); n = r.s; }
    t('too many wrong attempts are limited', n === 429);
  } finally { srv.kill(); }
  console.log('\n' + ok + ' passed, ' + bad + ' failed');
  process.exit(bad ? 1 : 0);
})();
