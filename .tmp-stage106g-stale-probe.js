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
  let code, bid;
  for (let day = 1; day <= 28; day += 2) {
    const ci = `2029-06-${String(day).padStart(2, '0')}`;
    const co = `2029-06-${String(day + 3).padStart(2, '0')}`;
    const c = await req('POST', '/staff/manual-bookings/create', {
      client_slug: 'wolfhouse-somo', check_in: ci, check_out: co, selected_bed_codes: ['DEMO-R2-B2'],
      guest_count: 1, guest_name: 'Stage106g stale', phone: '+34600777' + String(Date.now()).slice(-4),
      package_code: 'malibu', room_type: 'shared', payment_choice: 'no_payment_yet', add_ons: [],
      confirm: true, idempotency_key: 'stale-' + day + '-' + Date.now(),
    }, cookie);
    if (c.status === 201 && c.body?.booking_code) { code = c.body.booking_code; bid = c.body.booking_id; console.log('created', code, ci); break; }
  }
  if (!code) { console.log('no create'); return; }
  const g1 = await req('POST', '/staff/bookings/generate-payment-link?client=wolfhouse-somo', {
    client_slug: 'wolfhouse-somo', booking_id: bid, booking_code: code, idempotency_key: 'stale-g1-' + Date.now(),
  }, cookie);
  console.log('gen1', g1.status, g1.body?.success);
  const ctxA = await req('GET', `/staff/bookings/${encodeURIComponent(code)}/context?client=wolfhouse-somo`, null, cookie);
  const balA = Number(ctxA.body?.booking?.balance_due_cents || 0);
  const cash = await req('POST', '/staff/bookings/record-cash-payment?client=wolfhouse-somo', {
    client_slug: 'wolfhouse-somo', booking_id: bid, booking_code: code,
    amount_cents: Math.min(5000, Math.max(1000, Math.floor(balA / 2))),
    idempotency_key: 'stale-cash-' + Date.now(), note: 'stage106g stale',
  }, cookie);
  console.log('cash', cash.status, cash.body?.success);
  const ctxB = await req('GET', `/staff/bookings/${encodeURIComponent(code)}/context?client=wolfhouse-somo`, null, cookie);
  const balB = Number(ctxB.body?.booking?.balance_due_cents || 0);
  const ui = await req('GET', '/staff/ui', null, cookie);
  console.log({ balA, balB, balance_changed: balB < balA, outdated: /Outdated amount/.test(ui.raw || '') });
})();
