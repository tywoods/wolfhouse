'use strict';
const https = require('https');
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
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
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
  const c = await req('POST', '/staff/manual-bookings/create', {
    client_slug: 'wolfhouse-somo', check_in: '2028-09-10', check_out: '2028-09-13',
    selected_bed_codes: ['DEMO-R2-B2'], guest_count: 1, guest_name: 'Stage106g cancel-proof',
    phone: '+34600666' + String(Date.now()).slice(-4), package_code: 'malibu', room_type: 'shared',
    payment_choice: 'no_payment_yet', add_ons: [], confirm: true,
    idempotency_key: 'stage106g-cancel-' + Date.now(),
  }, cookie);
  console.log('create', c.status, c.body);
  if (!c.body?.booking_code) return;
  const gen = await req('POST', '/staff/bookings/generate-payment-link?client=wolfhouse-somo', {
    client_slug: 'wolfhouse-somo', booking_id: c.body.booking_id, booking_code: c.body.booking_code,
    idempotency_key: 'g-' + Date.now(),
  }, cookie);
  console.log('gen', gen.status, gen.body);
  const ctx = await req('GET', `/staff/bookings/${encodeURIComponent(c.body.booking_code)}/context?client=wolfhouse-somo`, null, cookie);
  const rows = ctx.body?.payments?.rows || [];
  const ch = rows.find((p) => String(p.payment_status).toLowerCase() === 'checkout_created');
  const paidBefore = rows.reduce((s, p) => (String(p.payment_status).toLowerCase() === 'paid'
    ? s + Number(p.amount_paid_cents || 0) : s), 0);
  const cancel = await req('POST', '/staff/bookings/cancel-payment-link?client=wolfhouse-somo', {
    client_slug: 'wolfhouse-somo', booking_code: c.body.booking_code, payment_id: ch.payment_id,
    idempotency_key: 'c-' + Date.now(),
  }, cookie);
  console.log('cancel', cancel.status, cancel.body);
  const ctx2 = await req('GET', `/staff/bookings/${encodeURIComponent(c.body.booking_code)}/context?client=wolfhouse-somo`, null, cookie);
  const rows2 = ctx2.body?.payments?.rows || [];
  const paidAfter = rows2.reduce((s, p) => (String(p.payment_status).toLowerCase() === 'paid'
    ? s + Number(p.amount_paid_cents || 0) : s), 0);
  console.log('paid before/after', paidBefore, paidAfter);
  const ui = await req('GET', '/staff/ui', null, cookie);
  console.log('ui cancel markers', {
    bcInitCancelPaymentLinkShell: /bcInitCancelPaymentLinkShell/.test(ui.raw),
    cancelIcon: /cancel payment link|Cancel payment link/i.test(ui.raw),
    ledgerCancel: /ledgerCancel|bcLedger.*[Cc]ancel/.test(ui.raw),
  });
})().catch((e) => { console.error(e); process.exit(1); });
