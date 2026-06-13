'use strict';
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const GUEST = 'Phase 22f Manual Booking Proof';
const PHONE = '+3460022f001';
const EMAIL = 'phase22f-manual-booking@example.test';
const PKG = 'malibu';
const PROOF_START = new Date().toISOString();
const IDEM = `phase22f-manual-booking-${Date.now()}`;

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = https.request({ hostname: HOST, path, method, headers: h }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
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
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const candidates = [
    { ci: '2026-10-20', co: '2026-10-23', beds: ['DEMO-R2-B1'] },
    { ci: '2026-10-20', co: '2026-10-23', beds: ['DEMO-R3-B1'] },
    { ci: '2026-12-10', co: '2026-12-13', beds: ['DEMO-R2-B1'] },
    { ci: '2026-07-14', co: '2026-07-17', beds: ['DEMO-R2-B2'] },
    { ci: '2026-09-10', co: '2026-09-13', beds: ['DEMO-R3-B1'] },
  ];

  let slot = null;
  for (const c of candidates) {
    const prev = await req('POST', '/staff/manual-bookings/preview', {
      client_slug: CLIENT, check_in: c.ci, check_out: c.co, selected_bed_codes: c.beds,
      guest_count: 1, guest_name: GUEST, package_code: PKG, room_type: 'shared', payment_choice: 'deposit',
    }, cookie);
    const q = await req('POST', '/staff/quote-preview', {
      client_slug: CLIENT, check_in: c.ci, check_out: c.co, guest_count: 1,
      package_code: PKG, room_type: 'shared', payment_choice: 'deposit', add_ons: [],
    }, cookie);
    const avail = prev.body && prev.body.availability;
    const quoteOk = q.body && q.body.success && q.body.quote && !q.body.quote.blockers?.length;
    console.log(c, 'preview', prev.status, avail && avail.is_valid, 'quote', quoteOk, q.body?.quote?.total_cents || q.body?.error);
    if (prev.status === 200 && avail && avail.is_valid && quoteOk) { slot = c; break; }
  }
  if (!slot) { console.error('no slot'); process.exit(1); }

  const created = await req('POST', '/staff/manual-bookings/create', {
    client_slug: CLIENT, check_in: slot.ci, check_out: slot.co, selected_bed_codes: slot.beds,
    guest_count: 1, guest_name: GUEST, phone: PHONE, email: EMAIL, package_code: PKG,
    room_type: 'shared', payment_choice: 'stripe_deposit', paid_amount_type: 'deposit',
    add_ons: [], confirm: true, idempotency_key: IDEM, source: 'staff_manual',
    reason: 'Phase 22f manual booking Stripe-disabled proof',
  }, cookie);

  const body = created.body || {};
  const url = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const bk = await pg.query(`SELECT b.booking_code, b.balance_due_cents, b.amount_paid_cents FROM bookings b JOIN clients c ON c.id=b.client_id WHERE c.slug=$1 AND b.guest_name=$2`, [CLIENT, GUEST]);
  const pays = body.booking_code ? await pg.query(`SELECT p.status::text, p.checkout_url, p.amount_paid_cents, p.amount_due_cents FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN clients c ON c.id=b.client_id WHERE c.slug=$1 AND b.booking_code=$2`, [CLIENT, body.booking_code]) : { rows: [] };
  const beds = body.booking_code ? await pg.query(`SELECT bb.bed_code FROM booking_beds bb JOIN bookings b ON b.id=bb.booking_id JOIN clients c ON c.id=b.client_id WHERE c.slug=$1 AND b.booking_code=$2`, [CLIENT, body.booking_code]) : { rows: [] };
  const dup = await pg.query(`SELECT COUNT(*)::int c FROM bookings b JOIN clients c ON c.id=b.client_id WHERE c.slug=$1 AND b.guest_name=$2`, [CLIENT, GUEST]);
  const sent = await pg.query(`SELECT COUNT(*)::int c FROM guest_message_sends WHERE client_slug=$1 AND created_at>=$2::timestamptz AND status='sent'`, [CLIENT, PROOF_START]);
  await pg.end();

  console.log(JSON.stringify({
    slot, create_status: created.status, body: {
      success: body.success, error: body.error, booking_code: body.booking_code,
      payment_link_skipped: body.payment_link_skipped, skip_reason: body.skip_reason,
      amount_paid_cents: body.amount_paid_cents, amount_due_cents: body.amount_due_cents,
      checkout_url: body.checkout_url, stripe_called: body.stripe_called, message: body.message,
    },
    db: { bookings: bk.rows, payments: pays.rows, beds: beds.rows, dup: dup.rows[0].c, sends: sent.rows[0].c },
    fixed: body.success === true && body.error !== 'STRIPE_NOT_CONFIGURED',
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
