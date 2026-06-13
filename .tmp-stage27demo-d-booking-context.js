'use strict';
const https = require('https');

const BOOKING_CODE = 'WH-G27-0BB996236D';

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
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const ctx = await req('GET', `/staff/bookings/${encodeURIComponent(BOOKING_CODE)}/context?client=wolfhouse-somo`, null, cookie);
  const bk = ctx.body && ctx.body.booking;
  const payments = (ctx.body && ctx.body.payments && ctx.body.payments.rows) || [];
  console.log(JSON.stringify({
    http: ctx.status,
    success: ctx.body && ctx.body.success,
    booking: bk && {
      booking_code: bk.booking_code,
      guest_name: bk.guest_name,
      phone: bk.phone,
      check_in: bk.check_in,
      check_out: bk.check_out,
      status: bk.status,
      payment_status: bk.payment_status,
      assignment_status: bk.assignment_status,
    },
    payments: payments.map((p) => ({
      id: p.id,
      status: p.status,
      checkout_url: p.checkout_url,
      stripe_checkout_session_id: p.stripe_checkout_session_id,
      amount_paid_cents: p.amount_paid_cents,
    })),
    calendar_note: 'Bed calendar grid requires booking_beds row; hold write creates booking only until staff assigns bed',
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
