'use strict';
const https = require('https');
function req(method, path, cookie) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'staff-staging.lunafrontdesk.com', path, method,
      headers: { Accept: 'application/json', Cookie: cookie },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let body = raw;
        try { body = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, body });
      });
    });
    r.on('error', reject);
    r.end();
  });
}
(async () => {
  const loginRes = await new Promise((resolve, reject) => {
    const data = JSON.stringify({
      client: 'wolfhouse-somo', email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
    });
    const r = https.request({
      hostname: 'staff-staging.lunafrontdesk.com', path: '/staff/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ headers: res.headers }));
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
  const cookie = (loginRes.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  for (const [s, e] of [['2026-07-16', '2026-08-10'], ['2026-06-09', '2026-06-20'], ['2029-07-01', '2029-07-31']]) {
    const cal = await req('GET', `/staff/bed-calendar?client=wolfhouse-somo&start=${s}&end=${e}`, cookie);
    console.log(s, e, 'status', cal.status, 'blocks', (cal.body.blocks || []).length);
    for (const b of cal.body.blocks || []) {
      console.log(' ', b.booking_code, b.calendar_payment_primary, 'bal', b.balance_due_cents,
        'paid', b.ledger_paid_cents, 'dep', b.calendar_show_deposit_paid, 'link', b.has_active_payment_link);
    }
  }
  const ctx = await req('GET', '/staff/bookings/MB-WOLFHO-20290701-376db8/context?client=wolfhouse-somo', cookie);
  const pay = ctx.body?.payments?.rows || [];
  console.log('deposit booking payments', pay.map((p) => ({
    st: p.payment_status, kind: p.payment_kind, due: p.amount_due_cents, paid: p.amount_paid_cents,
  })));
})();
