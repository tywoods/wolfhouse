'use strict';
const https = require('https');

const HOST = 'staff-staging.lunafrontdesk.com';
const BOOKING_CODE = 'WH-G27-05910FC9BD';
const PAYMENT_DRAFT_ID = 'fb228044-3ac3-468b-9a77-1312b4aadb91';

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(headers.cookie ? { Cookie: headers.cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const hz = await req('GET', '/healthz');
  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const ui = await req('GET', '/staff/ui?cachebust=27w10-stripe', null, { cookie, accept: 'text/html' });

  const stripe = await req('POST', '/staff/bot/guest-simulator-create-stripe-test-link', {
    source: 'luna_guest_simulator',
    confirm_simulator_stripe: true,
    confirm_stripe_test_link: true,
    payment_draft_id: PAYMENT_DRAFT_ID,
    booking_code: BOOKING_CODE,
  }, { cookie });

  const b = stripe.body && typeof stripe.body === 'object' ? stripe.body : {};
  console.log(JSON.stringify({
    healthz: hz.status,
    ui_status: ui.status,
    has_simulator: /Luna Guest Simulator/.test(ui.raw || ''),
    has_stripe_btn: /Create Stripe TEST Link/.test(ui.raw || ''),
    lgs_stripe_links_enabled: /LGS_STRIPE_LINKS\s*=\s*true/.test(ui.raw || ''),
    stripe_http: stripe.status,
    success: b.success,
    stripe_link_created: b.stripe_link_created,
    stripe_link_status: b.stripe_link_status,
    stripe_checkout_url_present: !!(b.stripe_checkout_url && String(b.stripe_checkout_url).startsWith('https://')),
    payment_status: b.payment_status,
    sends_whatsapp: b.sends_whatsapp,
    live_send_blocked: b.live_send_blocked,
    booking_confirmed: b.booking_confirmed,
    payment_truth_recorded: b.payment_truth_recorded,
    error: b.error,
    booking_code: b.booking_code || BOOKING_CODE,
    payment_draft_id: b.payment_draft_id || PAYMENT_DRAFT_ID,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
