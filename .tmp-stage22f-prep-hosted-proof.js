'use strict';
/** Phase 22f-prep — deploy master + manual booking Stripe-disabled proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = '9a97537';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:9a97537-stage22f-prep-master';
const REV_SUFFIX = 'stage22f-prep-master-safe';
const GUEST = 'Phase 22f Manual Booking Proof';
const PHONE = '+3460022f001';
const EMAIL = 'phase22f-manual-booking@example.test';
const PKG = 'malibu';
const PROOF_START = new Date().toISOString();
const IDEM = `phase22f-manual-booking-${Date.now()}`;

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const r = https.request({ hostname: HOST, path, method, headers: h }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

function stagingEnvFlags() {
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const pick = (name) => {
    const row = env.find((e) => e.name === name);
    if (!row) return '(unset)';
    if (row.secretRef) return `(secret:${row.secretRef})`;
    return row.value != null ? row.value : '(unset)';
  };
  return {
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
    WHATSAPP_LIVE_SENDS_ENABLED: pick('WHATSAPP_LIVE_SENDS_ENABLED'),
    LUNA_GUEST_LIVE_SEND_OWNER_APPROVED: pick('LUNA_GUEST_LIVE_SEND_OWNER_APPROVED'),
    BOT_BOOKING_ENABLED: pick('BOT_BOOKING_ENABLED'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    MANUAL_BOOKING_ENABLED: pick('MANUAL_BOOKING_ENABLED'),
    STAFF_ACTIONS_ENABLED: pick('STAFF_ACTIONS_ENABLED'),
    WHATSAPP_CLOUD_ACCESS_TOKEN: pick('WHATSAPP_CLOUD_ACCESS_TOKEN'),
    WHATSAPP_PHONE_NUMBER_ID: pick('WHATSAPP_PHONE_NUMBER_ID'),
  };
}

async function waitHealthy(revSuffix, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rev = activeRevision();
    if (rev.health === 'Healthy' && rev.traffic === 100 && String(rev.name || '').includes(revSuffix)) {
      return rev;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return activeRevision();
}

function deploySafeRevision() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REV_SUFFIX}`,
    '--set-env-vars WHATSAPP_DRY_RUN=true STRIPE_LINKS_ENABLED=false MANUAL_BOOKING_ENABLED=true',
    '--remove-env-vars BOT_BOOKING_ENABLED LUNA_AUTO_SEND_ENABLED WHATSAPP_LIVE_SENDS_ENABLED LUNA_GUEST_LIVE_SEND_OWNER_APPROVED WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID',
  ].join(' '));
}

async function pgConnect() {
  const url = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

async function findAvailableSlot(cookie) {
  const candidates = [
    { ci: '2026-11-10', co: '2026-11-13', beds: ['DEMO-R2-B1'] },
    { ci: '2026-11-17', co: '2026-11-20', beds: ['DEMO-R2-B2'] },
    { ci: '2026-12-01', co: '2026-12-04', beds: ['DEMO-R3-B1'] },
    { ci: '2027-01-12', co: '2027-01-15', beds: ['DEMO-R2-B1'] },
  ];
  for (const c of candidates) {
    const prev = await req('POST', '/staff/manual-bookings/preview', {
      client_slug: CLIENT,
      check_in: c.ci,
      check_out: c.co,
      selected_bed_codes: c.beds,
      guest_count: 1,
      guest_name: GUEST,
      package_code: PKG,
      room_type: 'shared',
      payment_choice: 'deposit',
    }, cookie);
    const avail = prev.body && prev.body.availability;
    if (prev.status === 200 && avail && avail.is_valid && !(avail.blockers && avail.blockers.length)) {
      return c;
    }
  }
  return null;
}

async function dbProof(pg, bookingCode) {
  const bk = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.phone, b.email,
           b.check_in::text, b.check_out::text, b.payment_status::text,
           b.amount_paid_cents, b.balance_due_cents, b.metadata->>'idempotency_key' AS idem
      FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.guest_name = $2
     ORDER BY b.created_at DESC`, [CLIENT, GUEST]);

  const dup = await pg.query(`
    SELECT COUNT(*)::int AS c FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.guest_name = $2`, [CLIENT, GUEST]);

  let beds = { rows: [] };
  let pays = { rows: [] };
  if (bookingCode) {
    beds = await pg.query(`
      SELECT bb.bed_code FROM booking_beds bb
      INNER JOIN bookings b ON b.id = bb.booking_id
      INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.booking_code = $2`, [CLIENT, bookingCode]);
    pays = await pg.query(`
      SELECT p.id::text, p.status::text, p.amount_due_cents, p.amount_paid_cents,
             p.checkout_url, p.stripe_checkout_session_id
        FROM payments p
       INNER JOIN bookings b ON b.id = p.booking_id
       INNER JOIN clients c ON c.id = b.client_id
       WHERE c.slug = $1 AND b.booking_code = $2`, [CLIENT, bookingCode]);
  }

  const sent = await pg.query(`
    SELECT id FROM guest_message_sends
     WHERE client_slug = $1 AND created_at >= $2::timestamptz AND status = 'sent'`, [CLIENT, PROOF_START]);

  return { bookings: bk.rows, duplicate_count: dup.rows[0].c, beds: beds.rows, payments: pays.rows, sends: sent.rows };
}

(async () => {
  const revBefore = activeRevision();
  const envBefore = stagingEnvFlags();
  deploySafeRevision();
  const revAfter = await waitHealthy(REV_SUFFIX);
  const envAfter = stagingEnvFlags();
  const health = await req('GET', '/healthz');

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  if (login.status !== 200) throw new Error('login failed: ' + login.status);
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const ui = await req('GET', '/staff/ui', null, cookie);
  const uiFlags = {
    BC_STAFF_ACTIONS: /BC_STAFF_ACTIONS\s*=\s*(true|false)/.exec(ui.raw || ''),
    BC_MANUAL_BOOKING: /BC_MANUAL_BOOKING\s*=\s*(true|false)/.exec(ui.raw || ''),
    BC_STRIPE_LINKS: /BC_STRIPE_LINKS\s*=\s*(true|false)/.exec(ui.raw || ''),
  };

  const slot = await findAvailableSlot(cookie);
  if (!slot) throw new Error('no available slot found');

  const quote = await req('POST', '/staff/quote-preview', {
    client_slug: CLIENT,
    check_in: slot.ci,
    check_out: slot.co,
    guest_count: 1,
    package_code: PKG,
    room_type: 'shared',
    payment_choice: 'deposit',
    add_ons: [],
  }, cookie);

  const createPayload = {
    client_slug: CLIENT,
    check_in: slot.ci,
    check_out: slot.co,
    selected_bed_codes: slot.beds,
    guest_count: 1,
    guest_name: GUEST,
    phone: PHONE,
    email: EMAIL,
    package_code: PKG,
    room_type: 'shared',
    payment_choice: 'stripe_deposit',
    paid_amount_type: 'deposit',
    add_ons: [],
    confirm: true,
    idempotency_key: IDEM,
    source: 'staff_manual',
    reason: 'Phase 22f manual booking Stripe-disabled proof',
  };

  const created = await req('POST', '/staff/manual-bookings/create', createPayload, cookie);
  const body = created.body || {};
  const bookingCode = body.booking_code;

  const pg = await pgConnect();
  const db = await dbProof(pg, bookingCode);
  await pg.end();

  const healthAfter = await req('GET', '/healthz');

  const errs = [];
  if (health.status !== 200) errs.push('healthz during');
  if (healthAfter.status !== 200) errs.push('healthz after');
  if (revAfter.image !== IMAGE) errs.push('image mismatch');
  if (envAfter.STRIPE_LINKS_ENABLED !== 'false') errs.push('STRIPE_LINKS_ENABLED');
  if (envAfter.WHATSAPP_DRY_RUN !== 'true') errs.push('WHATSAPP_DRY_RUN');
  if (envAfter.BOT_BOOKING_ENABLED !== '(unset)') errs.push('BOT_BOOKING_ENABLED');
  if (created.status !== 201 && created.status !== 200) errs.push(`create http ${created.status}`);
  if (body.success !== true) errs.push('create success false');
  if (body.error === 'STRIPE_NOT_CONFIGURED') errs.push('STRIPE_NOT_CONFIGURED');
  if (body.payment_link_skipped !== true) errs.push('payment_link_skipped not true');
  if (body.skip_reason !== 'stripe_links_disabled') errs.push('skip_reason');
  if (body.checkout_url) errs.push('checkout_url in response');
  if (body.stripe_called) errs.push('stripe_called true');
  if (db.duplicate_count !== 1) errs.push(`duplicate_count ${db.duplicate_count}`);
  if (!db.beds.length) errs.push('no booking_beds');
  for (const p of db.payments) {
    if (p.checkout_url || p.stripe_checkout_session_id) errs.push('stripe in db');
    if (p.status === 'paid' || Number(p.amount_paid_cents) > 0) errs.push('payment marked paid');
  }
  if (db.sends.length) errs.push('whatsapp sent');

  const quoteSummary = body.quote_summary || {};
  const paidNow = body.amount_paid_cents || 0;

  let result = 'PASS';
  if (errs.length) result = body.error === 'STRIPE_NOT_CONFIGURED' ? 'FAIL' : 'PARTIAL';

  console.log(JSON.stringify({
    phase: '22f-prep',
    result,
    commit: COMMIT,
    image: IMAGE,
    revision_before: revBefore,
    revision_after: revAfter,
    env_before: envBefore,
    env_after: envAfter,
    health: { during: health.status, after: healthAfter.status },
    ui_embedded_flags: {
      BC_STAFF_ACTIONS: uiFlags.BC_STAFF_ACTIONS && uiFlags.BC_STAFF_ACTIONS[1],
      BC_MANUAL_BOOKING: uiFlags.BC_MANUAL_BOOKING && uiFlags.BC_MANUAL_BOOKING[1],
      BC_STRIPE_LINKS: uiFlags.BC_STRIPE_LINKS && uiFlags.BC_STRIPE_LINKS[1],
    },
    manual_booking_proof: {
      slot,
      quote_total_cents: quote.body && quote.body.quote && quote.body.quote.total_cents,
      create_status: created.status,
      create_response: {
        success: body.success,
        error: body.error,
        booking_id: body.booking_id,
        booking_code: body.booking_code,
        payment_id: body.payment_id,
        payment_link_skipped: body.payment_link_skipped,
        skip_reason: body.skip_reason,
        payment_status: body.payment_status,
        amount_paid_cents: paidNow,
        amount_due_cents: body.amount_due_cents,
        balance_due_from_quote: quoteSummary.total_cents,
        checkout_url: body.checkout_url,
        stripe_called: body.stripe_called,
        message: body.message,
        no_stripe: body.no_stripe,
        no_whatsapp: body.no_whatsapp,
      },
      stripe_not_configured_fixed: body.error !== 'STRIPE_NOT_CONFIGURED' && body.success === true,
    },
    db_proof: db,
    errors: errs,
    safety: {
      no_stripe_api: !body.stripe_called && !body.checkout_url,
      no_whatsapp_send: db.sends.length === 0,
      no_duplicate_booking: db.duplicate_count === 1,
      env_unchanged_safe: envAfter.BOT_BOOKING_ENABLED === '(unset)' && envAfter.STRIPE_LINKS_ENABLED === 'false',
    },
    recommended_next: 'Phase 22f deposit Stripe link from inbound booking OR Phase 23 handoff/action queue',
  }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
