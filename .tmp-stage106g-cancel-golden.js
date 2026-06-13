'use strict';
const https = require('https');
const CODE = 'MB-WOLFHO-20260801-4f10c3';
function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: 'staff-staging.lunafrontdesk.com', path, method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo', email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const ctx = await req('GET', `/staff/bookings/${encodeURIComponent(CODE)}/context?client=wolfhouse-somo`, null, cookie);
  const rows = ctx.body?.payments?.rows || [];
  console.log('payments', rows.map((p) => ({
    id: p.payment_id, st: p.payment_status, due: p.amount_due_cents, paid: p.amount_paid_cents,
  })));
  const unpaid = rows.filter((p) => ['checkout_created', 'pending', 'draft'].includes(String(p.payment_status).toLowerCase())
    && Number(p.amount_paid_cents || 0) === 0);
  console.log('unpaid rows', unpaid.length);
  if (!unpaid[0]) return;
  const pid = unpaid[0].payment_id;
  const paidBefore = rows.reduce((s, p) => (String(p.payment_status).toLowerCase() === 'paid'
    ? s + Number(p.amount_paid_cents || 0) : s), 0);
  const cancel = await req('POST', '/staff/bookings/cancel-payment-link?client=wolfhouse-somo', {
    client_slug: 'wolfhouse-somo', booking_code: CODE, payment_id: pid,
    idempotency_key: 'golden-cancel-' + Date.now(),
  }, cookie);
  console.log('cancel', cancel.status, cancel.body);
  const ctx2 = await req('GET', `/staff/bookings/${encodeURIComponent(CODE)}/context?client=wolfhouse-somo`, null, cookie);
  const rows2 = ctx2.body?.payments?.rows || [];
  const paidAfter = rows2.reduce((s, p) => (String(p.payment_status).toLowerCase() === 'paid'
    ? s + Number(p.amount_paid_cents || 0) : s), 0);
  const cancelled = rows2.find((p) => p.payment_id === pid);
  console.log('paid before/after', paidBefore, paidAfter, 'row', cancelled?.payment_status);
})();
