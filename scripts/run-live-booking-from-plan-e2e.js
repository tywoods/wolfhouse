'use strict';
/** Reproduces Hermes WhatsApp path: booking-create-from-plan + auto payment link fields. */

const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function getToken() {
  if (process.env.LUNA_BOT_INTERNAL_TOKEN) return process.env.LUNA_BOT_INTERNAL_TOKEN.trim();
  return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
}

function request(method, path, body, token, host = HOST) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = token ? {
      'X-Luna-Bot-Token': token,
      Authorization: `Bearer ${token}`,
    } : {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname: host, path, method, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function post(path, body, token) {
  return request('POST', path, body, token);
}

function getPublicUrl(url) {
  const u = new URL(url);
  return request('GET', `${u.pathname}${u.search}`, null, null, u.hostname);
}

(async () => {
  const token = getToken();
  const phone = process.env.E2E_GUEST_PHONE || `+1555${String(Date.now()).slice(-7)}`;
  const checkIn = process.env.E2E_CHECK_IN || '2026-08-01';
  const checkOut = process.env.E2E_CHECK_OUT || '2026-08-09';

  const avail = await post('/staff/bot/availability-check', {
    client_slug: CLIENT,
    check_in: checkIn,
    check_out: checkOut,
    guest_count: 2,
    room_type: 'shared',
  }, token);
  if (!avail.body?.success || !avail.body?.selected_bed_codes?.length) {
    console.error('availability failed', avail);
    process.exit(1);
  }

  const plan = await post('/staff/bot/booking-create-from-plan', {
    client_slug: CLIENT,
    guest_name: 'Ty',
    phone,
    guest_phone: phone,
    check_in: checkIn,
    check_out: checkOut,
    guest_count: 2,
    package_code: 'waimea',
    room_type: 'shared',
    payment_choice: 'deposit',
    selected_bed_codes: avail.body.selected_bed_codes,
    confirm: true,
    idempotency_key: `plan-e2e-${Date.now()}`,
    source: 'live_booking_from_plan_e2e',
  }, token);

  console.log(JSON.stringify({
    status: plan.status,
    success: plan.body?.success,
    write_performed: plan.body?.write_performed,
    booking_code: plan.body?.booking_code,
    payment_id: plan.body?.payment_id,
    top_level_payment_id: plan.body?.payment_id,
    nested_payment_id: plan.body?.create_outcome?.create_response?.payment_id,
  }, null, 2));

  if (!plan.body?.payment_id) {
    console.error('FAIL: payment_id missing at top level — Hermes cannot create payment link');
    process.exit(1);
  }

  const link = await post(`/staff/bot/payments/${plan.body.payment_id}/create-stripe-link`, { client_slug: CLIENT }, token);
  if (!link.body?.checkout_url?.startsWith('https://')) {
    console.error('FAIL: stripe link missing', link);
    process.exit(1);
  }
  const guestUrl = link.body.guest_payment_url || link.body.payment_short_url || link.body.checkout_url;
  if (!guestUrl || !guestUrl.startsWith('https://staff-staging.lunafrontdesk.com/pay/')) {
    console.error('FAIL: expected staff short /pay/ URL, got', guestUrl);
    process.exit(1);
  }

  const payPage = await getPublicUrl(guestUrl);
  if (![200, 302, 303, 307, 308].includes(payPage.status)) {
    console.error('FAIL: public /pay link did not resolve', { status: payPage.status, guestUrl, body: String(payPage.raw || '').slice(0, 300) });
    process.exit(1);
  }

  const arrivalTransfer = await post('/staff/bot/transfers/save', {
    client_slug: CLIENT,
    booking_code: plan.body.booking_code,
    direction: 'arrival',
    airport: 'SDR',
    notes: 'Luna V2 E2E: guest requested Santander arrival transfer; exact time later.',
    confirm_transfer_write: true,
  }, token);
  if (!arrivalTransfer.body?.success || arrivalTransfer.body?.write_performed !== true) {
    console.error('FAIL: arrival transfer was not saved', arrivalTransfer);
    process.exit(1);
  }

  const departureTransfer = await post('/staff/bot/transfers/save', {
    client_slug: CLIENT,
    booking_code: plan.body.booking_code,
    direction: 'departure',
    airport: 'SDR',
    notes: 'Luna V2 E2E: guest requested Santander departure transfer; exact time later.',
    confirm_transfer_write: true,
  }, token);
  if (!departureTransfer.body?.success || departureTransfer.body?.write_performed !== true) {
    console.error('FAIL: departure transfer was not saved', departureTransfer);
    process.exit(1);
  }

  const byCodeStatus = await post('/staff/bot/payments/status', {
    client_slug: CLIENT,
    booking_code: plan.body.booking_code,
  }, token);
  if (!byCodeStatus.body?.success || !byCodeStatus.body?.latest_payment?.payment_id) {
    console.error('FAIL: payment status lookup by booking_code failed', byCodeStatus);
    process.exit(1);
  }

  console.log('OK booking_code=', plan.body.booking_code, 'guest_url=', guestUrl, 'pay_status=', payPage.status, 'transfers=arrival+departure');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
