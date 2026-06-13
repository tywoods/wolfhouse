'use strict';
/** Phase 22f — deposit Stripe link for inbound-created booking. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:9a97537-stage22f-prep-master';
const PROOF_SUFFIX = 'stage22f-stripe-deposit-proof';
const REVERT_SUFFIX = 'stage22f-stripe-deposit-safe';
const PROOF_START = new Date().toISOString();

const PAYMENT_ID = 'd0bb5fa9-7ecc-43b2-b0d9-181b5687ae0a';
const BOOKING_ID = '946cc3ba-70e9-4f9f-a6b8-140ca3d22a79';
const BOOKING_CODE = 'MB-WOLFHO-20261006-5dbf98';
const IDEM = 'luna-booking:wolfhouse-somo:wamid.phase22b.complete.oct.001:v1';
const WA_ID = 'wamid.phase22b.complete.oct.001';
const ROUTE = `/staff/bot/payments/${PAYMENT_ID}/create-stripe-link`;

const PAID = new Set(['paid', 'succeeded', 'complete', 'completed']);

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...(headers || {}) };
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
        resolve({ status: res.statusCode, body: parsed, raw });
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
    BOT_BOOKING_ENABLED: pick('BOT_BOOKING_ENABLED'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    STRIPE_SECRET_KEY: pick('STRIPE_SECRET_KEY'),
    STRIPE_SUCCESS_URL: pick('STRIPE_SUCCESS_URL'),
    STRIPE_CANCEL_URL: pick('STRIPE_CANCEL_URL'),
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
    WHATSAPP_LIVE_SENDS_ENABLED: pick('WHATSAPP_LIVE_SENDS_ENABLED'),
    LUNA_GUEST_LIVE_SEND_OWNER_APPROVED: pick('LUNA_GUEST_LIVE_SEND_OWNER_APPROVED'),
    WHATSAPP_CLOUD_ACCESS_TOKEN: pick('WHATSAPP_CLOUD_ACCESS_TOKEN'),
    WHATSAPP_PHONE_NUMBER_ID: pick('WHATSAPP_PHONE_NUMBER_ID'),
    MANUAL_BOOKING_ENABLED: pick('MANUAL_BOOKING_ENABLED'),
  };
}

function getToken() {
  return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
}

async function pgConnect() {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

async function loadEvent(pg) {
  const r = await pg.query(
    `SELECT normalized FROM guest_message_events WHERE client_slug = $1 AND wa_message_id = $2`,
    [CLIENT, WA_ID],
  );
  const norm = r.rows[0] && r.rows[0].normalized;
  const n = typeof norm === 'string' ? JSON.parse(norm) : norm;
  return {
    has_preview: !!(n && n.booking_write_preview),
    has_result: !!(n && n.booking_write_result),
    result_payment_id: n && n.booking_write_result && n.booking_write_result.payment_id,
    result_booking_id: n && n.booking_write_result && n.booking_write_result.booking_id,
    checkout_url_in_event: !!(n && n.booking_write_result && n.booking_write_result.checkout_url),
  };
}

async function dbProof(pg) {
  const bk = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.payment_status::text,
           b.confirmation_sent_at, b.amount_paid_cents,
           b.metadata->>'idempotency_key' AS idempotency_key
      FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.id = $2::uuid`, [CLIENT, BOOKING_ID]);

  const pays = await pg.query(`
    SELECT p.id::text AS payment_id, p.status::text, p.payment_kind::text,
           p.amount_due_cents, p.amount_paid_cents, p.checkout_url,
           p.stripe_checkout_session_id, p.paid_at, p.booking_id::text, p.created_at
      FROM payments p WHERE p.id = $1::uuid`, [PAYMENT_ID]);

  const payCount = await pg.query(
    'SELECT COUNT(*)::int AS n FROM payments WHERE booking_id = $1::uuid', [BOOKING_ID]);

  const beds = await pg.query(
    'SELECT COUNT(*)::int AS n FROM booking_beds WHERE booking_id = $1::uuid', [BOOKING_ID]);

  const bkCount = await pg.query(`
    SELECT COUNT(*)::int AS n FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.metadata->>'idempotency_key' = $2`, [CLIENT, IDEM]);

  const sends = await pg.query(`
    SELECT COUNT(*)::int AS n FROM guest_message_sends
     WHERE client_slug = $1 AND created_at >= $2::timestamptz AND status = 'sent'`,
    [CLIENT, PROOF_START]);

  const event = await loadEvent(pg);

  return {
    booking: bk.rows[0] || null,
    payment: pays.rows[0] || null,
    payment_count_for_booking: payCount.rows[0].n,
    booking_beds_count: beds.rows[0].n,
    booking_count_by_idem: bkCount.rows[0].n,
    guest_message_sends_sent: sends.rows[0].n,
    guest_message_event: event,
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

function enableProofRevision() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${PROOF_SUFFIX}`,
    '--set-env-vars',
    'BOT_BOOKING_ENABLED=true',
    'STRIPE_LINKS_ENABLED=true',
    'WHATSAPP_DRY_RUN=true',
    'MANUAL_BOOKING_ENABLED=true',
    'STRIPE_SUCCESS_URL=https://staff-staging.lunafrontdesk.com/staff/payment/success?session_id={CHECKOUT_SESSION_ID}',
    'STRIPE_CANCEL_URL=https://staff-staging.lunafrontdesk.com/staff/payment/cancel',
    '--remove-env-vars LUNA_AUTO_SEND_ENABLED WHATSAPP_LIVE_SENDS_ENABLED LUNA_GUEST_LIVE_SEND_OWNER_APPROVED WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID',
  ].join(' '));
}

function revertSafeRevision() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REVERT_SUFFIX}`,
    '--set-env-vars WHATSAPP_DRY_RUN=true STRIPE_LINKS_ENABLED=false MANUAL_BOOKING_ENABLED=true',
    '--remove-env-vars BOT_BOOKING_ENABLED LUNA_AUTO_SEND_ENABLED WHATSAPP_LIVE_SENDS_ENABLED LUNA_GUEST_LIVE_SEND_OWNER_APPROVED WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID',
  ].join(' '));
}

function summarizeApi(body) {
  const sid = body.stripe_checkout_session_id || '';
  return {
    success: body.success,
    idempotent: body.idempotent,
    payment_id: body.payment_id,
    booking_id: body.booking_id,
    booking_code: body.booking_code,
    payment_status: body.payment_status,
    amount_due_cents: body.amount_due_cents,
    checkout_url_present: !!(body.checkout_url),
    checkout_url_host: body.checkout_url ? String(body.checkout_url).split('/')[2] : null,
    stripe_checkout_session_id_present: !!sid,
    stripe_session_id_prefix: sid ? sid.slice(0, 12) + '…' : null,
    sends_whatsapp: body.sends_whatsapp,
    whatsapp_dry_run: body.whatsapp_dry_run,
    no_payment_truth_recorded: body.no_payment_truth_recorded,
    next_action: body.next_action,
  };
}

function criticalIssues(db) {
  const issues = [];
  if (db.booking_count_by_idem !== 1) issues.push('duplicate_booking');
  if (db.payment_count_for_booking !== 1) issues.push('duplicate_payment');
  const p = db.payment;
  if (p && PAID.has(String(p.status || '').toLowerCase())) issues.push('payment_paid');
  if (p && p.paid_at) issues.push('paid_at_set');
  if (p && Number(p.amount_paid_cents) > 0) issues.push('amount_paid_cents_nonzero');
  if (db.guest_message_sends_sent > 0) issues.push('whatsapp_sent');
  if (db.booking && db.booking.confirmation_sent_at) issues.push('confirmation_sent');
  return issues;
}

(async () => {
  const token = getToken();
  const botHeaders = { 'X-Luna-Bot-Token': token };
  const out = {
    phase: '22f',
    proof_start: PROOF_START,
    payment_id: PAYMENT_ID,
    booking_id: BOOKING_ID,
    booking_code: BOOKING_CODE,
    wa_message_id: WA_ID,
    route: ROUTE,
    image: IMAGE,
    verifier_note: 'verify:staff-bot-stripe-link-api D2 known static false positive (uses stripeCheckoutRedirectUrlsConfigured helper)',
    result: 'PENDING',
  };

  try {
    out.revision_before = activeRevision();
    out.env_before = stagingEnvFlags();
    out.health_before = (await req('GET', '/healthz')).status;

    const pg0 = await pgConnect();
    out.db_before = await dbProof(pg0);
    await pg0.end();

    const p0 = out.db_before.payment;
    out.db_before.checks = {
      payment_exists: p0 && p0.payment_id === PAYMENT_ID,
      status_draft: p0 && p0.status === 'draft',
      amount_due_10000: p0 && Number(p0.amount_due_cents) === 10000,
      no_checkout_url: p0 && !p0.checkout_url,
      no_session_id: p0 && !p0.stripe_checkout_session_id,
      amount_paid_zero: p0 && Number(p0.amount_paid_cents) === 0,
      one_booking: out.db_before.booking_count_by_idem === 1,
      two_beds: out.db_before.booking_beds_count === 2,
      event_has_result: out.db_before.guest_message_event.has_result,
    };
    if (out.health_before !== 200) throw new Error('healthz_before');
    if (out.env_before.STRIPE_LINKS_ENABLED !== 'false') throw new Error('STRIPE_LINKS_ENABLED not false before');
    if (out.env_before.BOT_BOOKING_ENABLED !== '(unset)') throw new Error('BOT_BOOKING_ENABLED not unset before');
    const requiredBefore = ['payment_exists', 'status_draft', 'amount_due_10000', 'no_checkout_url', 'no_session_id', 'amount_paid_zero', 'one_booking', 'two_beds'];
    if (!requiredBefore.every((k) => out.db_before.checks[k])) throw new Error('db_before_invalid');
    out.guest_message_events_note = out.db_before.guest_message_event.has_result
      ? 'booking_write_result present on event'
      : 'guest_message_events empty or no row for wa_message_id — linkage check skipped; booking/payment anchors used';

    enableProofRevision();
    out.revision_during = await waitHealthy(PROOF_SUFFIX);
    out.env_during = stagingEnvFlags();
    out.health_during = (await req('GET', '/healthz')).status;
    if (out.health_during !== 200) throw new Error('healthz_during');

    const stepA = await req('POST', ROUTE, {}, botHeaders);
    const pg1 = await pgConnect();
    const dbAfterA = await dbProof(pg1);
    await pg1.end();

    const aSum = summarizeApi(stepA.body || {});
    const pA = dbAfterA.payment;
    const sessionA = pA && pA.stripe_checkout_session_id;
    const urlA = pA && pA.checkout_url;

    out.step_a_create_link = {
      http_status: stepA.status,
      summary: aSum,
      checks: {
        http_ok: stepA.status === 200,
        success: aSum.success === true,
        checkout_url_present: aSum.checkout_url_present === true,
        stripe_session_present: aSum.stripe_checkout_session_id_present === true,
        payment_status_checkout: pA && pA.status === 'checkout_created',
        amount_due_10000: pA && Number(pA.amount_due_cents) === 10000,
        amount_paid_zero: pA && Number(pA.amount_paid_cents) === 0,
        paid_at_null: !pA || !pA.paid_at,
        no_whatsapp: aSum.sends_whatsapp === false,
        single_payment: dbAfterA.payment_count_for_booking === 1,
        single_booking: dbAfterA.booking_count_by_idem === 1,
      },
      db_payment: {
        status: pA && pA.status,
        amount_due_cents: pA && pA.amount_due_cents,
        amount_paid_cents: pA && pA.amount_paid_cents,
        checkout_url_host: urlA ? String(urlA).split('/')[2] : null,
        session_prefix: sessionA ? sessionA.slice(0, 12) + '…' : null,
      },
    };
    out.step_a_create_link.result = Object.values(out.step_a_create_link.checks).every(Boolean)
      && criticalIssues(dbAfterA).length === 0 ? 'PASS' : 'FAIL';

    if (out.step_a_create_link.result === 'FAIL') throw new Error('step_a_failed');

    const stepB = await req('POST', ROUTE, {}, botHeaders);
    const pg2 = await pgConnect();
    const dbAfterB = await dbProof(pg2);
    await pg2.end();

    const bSum = summarizeApi(stepB.body || {});
    const pB = dbAfterB.payment;

    out.step_b_replay = {
      http_status: stepB.status,
      summary: bSum,
      checks: {
        http_ok: stepB.status === 200,
        idempotent: bSum.idempotent === true || bSum.success === true,
        same_session: pB && sessionA && pB.stripe_checkout_session_id === sessionA,
        same_checkout_url: pB && urlA && pB.checkout_url === urlA,
        single_payment: dbAfterB.payment_count_for_booking === 1,
        single_booking: dbAfterB.booking_count_by_idem === 1,
        no_whatsapp: bSum.sends_whatsapp === false,
        amount_paid_zero: pB && Number(pB.amount_paid_cents) === 0,
      },
    };
    out.step_b_replay.result = Object.values(out.step_b_replay.checks).every(Boolean)
      && criticalIssues(dbAfterB).length === 0 ? 'PASS' : 'FAIL';

    revertSafeRevision();
    out.revision_after = await waitHealthy(REVERT_SUFFIX);
    out.env_after = stagingEnvFlags();
    out.health_after = (await req('GET', '/healthz')).status;
    out.db_after = dbAfterB;

    const revertOk = out.env_after.STRIPE_LINKS_ENABLED === 'false'
      && out.env_after.BOT_BOOKING_ENABLED === '(unset)'
      && out.env_after.WHATSAPP_DRY_RUN === 'true'
      && out.health_after === 200;

    out.revert = { ok: revertOk };
    out.critical_issues = criticalIssues(dbAfterB);

    let result = 'PASS';
    if (out.critical_issues.length) result = 'FAIL';
    else if (out.step_a_create_link.result !== 'PASS' || out.step_b_replay.result !== 'PASS' || !revertOk) result = 'PARTIAL';
    out.result = result;
    out.recommended_phase_22g = 'Stripe webhook deposit payment truth for inbound booking OR persist checkout_url on guest_message_events booking_write_result';
  } catch (e) {
    out.result = 'FAIL';
    out.error = e.message;
    try { revertSafeRevision(); out.revision_after = await waitHealthy(REVERT_SUFFIX); out.env_after = stagingEnvFlags(); } catch (_) { /* best effort */ }
  }

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  try { revertSafeRevision(); } catch (_) { /* best effort */ }
  process.exit(1);
});
