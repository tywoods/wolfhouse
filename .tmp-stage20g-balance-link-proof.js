'use strict';
/** Phase 20g — balance Stripe link + confirmation preview. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:e4def6f-stage20f-cami-confirmation-preview';
const PROOF_SUFFIX = 'stage20g-balance-link-proof';
const REVERT_SUFFIX = 'stage20g-balance-link-safe';
const PROOF_START = new Date().toISOString();

const BOOKING_ID = '828538c7-c6cb-4c6f-b45a-57a641af37cc';
const BOOKING_CODE = 'MB-WOLFHO-20260924-e90132';
const DEPOSIT_PAYMENT_ID = '7659e304-64d4-47cf-82b9-4be1e37ac913';
const IDEM = 'phase20g-balance-link-proof-001';
const GEN_ROUTE = `/staff/bookings/generate-payment-link?client=${encodeURIComponent(CLIENT)}`;
const PREVIEW_ROUTE = '/staff/bot/bookings/confirmation-preview';

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
    BOT_BOOKING_ENABLED: pick('BOT_BOOKING_ENABLED'),
    STAFF_ACTIONS_ENABLED: pick('STAFF_ACTIONS_ENABLED'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    WHATSAPP_LIVE_SENDS_ENABLED: pick('WHATSAPP_LIVE_SENDS_ENABLED'),
    LUNA_GUEST_LIVE_SEND_OWNER_APPROVED: pick('LUNA_GUEST_LIVE_SEND_OWNER_APPROVED'),
  };
}

function getBotToken() {
  return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
}

async function staffLogin() {
  const res = await req('POST', '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  if (res.status !== 200) throw new Error('staff login failed: ' + res.status);
  return (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
}

async function pgConnect() {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

async function dbSnapshot(pg) {
  const bk = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.payment_status::text,
           b.amount_paid_cents, b.balance_due_cents, b.confirmation_sent_at
      FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.id = $2::uuid`, [CLIENT, BOOKING_ID]);

  const pays = await pg.query(`
    SELECT p.id::text AS payment_id, p.status::text, p.payment_kind::text,
           p.amount_due_cents, p.amount_paid_cents, p.checkout_url IS NOT NULL AS has_checkout_url,
           p.stripe_checkout_session_id IS NOT NULL AS has_session_id,
           p.paid_at, p.created_at
      FROM payments p WHERE p.booking_id = $1::uuid ORDER BY p.created_at`, [BOOKING_ID]);

  const sends = await pg.query(`
    SELECT COUNT(*)::int AS n FROM guest_message_sends
     WHERE client_slug = $1 AND created_at >= $2::timestamptz AND status = 'sent'`,
    [CLIENT, PROOF_START]);

  return {
    booking: bk.rows[0] || null,
    payments: pays.rows,
    payment_count: pays.rows.length,
    guest_message_sends_sent: sends.rows[0].n,
  };
}

function enableProofRevision() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${PROOF_SUFFIX}`,
    '--set-env-vars',
    'STAFF_ACTIONS_ENABLED=true',
    'STRIPE_LINKS_ENABLED=true',
    'WHATSAPP_DRY_RUN=true',
    'STRIPE_SUCCESS_URL=https://staff-staging.lunafrontdesk.com/staff/payment/success?session_id={CHECKOUT_SESSION_ID}',
    'STRIPE_CANCEL_URL=https://staff-staging.lunafrontdesk.com/staff/payment/cancel',
    '--remove-env-vars BOT_BOOKING_ENABLED LUNA_AUTO_SEND_ENABLED WHATSAPP_LIVE_SENDS_ENABLED LUNA_GUEST_LIVE_SEND_OWNER_APPROVED',
  ].join(' '));
}

function revertSafeRevision() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REVERT_SUFFIX}`,
    '--set-env-vars WHATSAPP_DRY_RUN=true STRIPE_LINKS_ENABLED=false',
    '--remove-env-vars STAFF_ACTIONS_ENABLED BOT_BOOKING_ENABLED LUNA_AUTO_SEND_ENABLED WHATSAPP_LIVE_SENDS_ENABLED LUNA_GUEST_LIVE_SEND_OWNER_APPROVED',
  ].join(' '));
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

function summarizeGen(body) {
  const sid = body.stripe_checkout_session_id || '';
  return {
    success: body.success,
    created: body.created,
    idempotent: body.idempotent,
    payment_id: body.payment_id,
    amount_due_cents: body.amount_due_cents,
    payment_status: body.payment_status,
    checkout_url_present: !!body.checkout_url,
    checkout_url_host: body.checkout_url ? String(body.checkout_url).split('/')[2] : null,
    stripe_checkout_session_id_present: !!sid,
    stripe_session_prefix: sid ? sid.slice(0, 14) + '…' : null,
    no_payment_truth_recorded: body.no_payment_truth_recorded,
    no_whatsapp: body.no_whatsapp,
    send_mutation: body.send_mutation,
  };
}

function summarizePreview(body) {
  const msg = String(body.message_preview || '');
  return {
    success: body.success,
    template_source: body.template_source,
    balance_payment_link_status: body.balance_payment_link_status,
    preview_only: body.preview_only,
    sends_whatsapp: body.sends_whatsapp,
    creates_stripe_link: body.creates_stripe_link,
    confirmation_sent_at: body.confirmation_sent_at,
    has_checkout_url_in_message: /https:\/\/checkout\.stripe\.com/i.test(msg),
    has_paid_100: /€100/.test(msg),
    has_balance_170: /€170/.test(msg),
    has_address: /C\. Mies de La Ran/.test(msg),
    has_gate: /2684#/.test(msg),
    has_room: /DEMO-R1/.test(msg),
    no_bed_leak: !/(?:DEMO-R\d+-B\d+)/.test(msg),
    message_excerpt: msg.slice(0, 220),
  };
}

function stopIfCritical(db, label) {
  const issues = [];
  if (db.booking && db.booking.confirmation_sent_at) issues.push('confirmation_sent_at_set');
  if (db.guest_message_sends_sent > 0) issues.push('whatsapp_sent');
  const deposit = db.payments.find((p) => p.payment_id === DEPOSIT_PAYMENT_ID);
  if (deposit && deposit.status !== 'paid') issues.push('deposit_not_paid');
  const balancePaid = db.payments.filter((p) => p.payment_kind === 'full_amount' && p.status === 'paid');
  if (balancePaid.length) issues.push('balance_marked_paid');
  if (db.booking && db.booking.payment_status === 'paid') issues.push('booking_fully_paid');
  return { label, issues, stop: issues.length > 0 };
}

(async () => {
  const out = {
    phase: '20g',
    proof_start: PROOF_START,
    route_used: 'POST /staff/bookings/generate-payment-link',
    booking_id: BOOKING_ID,
    booking_code: BOOKING_CODE,
    idempotency_key: IDEM,
    image: IMAGE,
    revision_before: null,
    env_before: null,
    health_before: null,
    db_before: null,
    revision_during: null,
    env_during: null,
    step_a_create_balance_link: null,
    step_b_confirmation_preview: null,
    step_c_replay: null,
    db_after: null,
    revision_after: null,
    env_after: null,
    health_after: null,
    result: 'PENDING',
    stopped_early: false,
    stop_reason: null,
  };

  try {
    out.revision_before = activeRevision();
    out.env_before = stagingEnvFlags();
    out.health_before = (await req('GET', '/healthz')).status;

    const pg0 = await pgConnect();
    out.db_before = await dbSnapshot(pg0);
    await pg0.end();

    const bk0 = out.db_before.booking;
    const balanceLinksBefore = out.db_before.payments.filter((p) =>
      p.payment_kind === 'full_amount' && p.has_checkout_url && p.status !== 'paid' && p.status !== 'cancelled');

    out.db_before.checks = {
      deposit_paid: bk0 && bk0.payment_status === 'deposit_paid',
      amount_paid_10000: bk0 && Number(bk0.amount_paid_cents) === 10000,
      balance_17000: bk0 && Number(bk0.balance_due_cents) === 17000,
      confirmation_sent_at_null: !bk0 || !bk0.confirmation_sent_at,
      no_active_balance_checkout: balanceLinksBefore.length === 0,
      one_deposit_payment: out.db_before.payments.filter((p) => p.payment_id === DEPOSIT_PAYMENT_ID).length === 1,
    };
    out.db_before.result = Object.values(out.db_before.checks).every(Boolean) ? 'PASS' : 'FAIL';

    if (out.db_before.result === 'FAIL') {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = 'db_before_invalid';
      throw new Error(out.stop_reason);
    }

    enableProofRevision();
    out.revision_during = await waitHealthy(PROOF_SUFFIX);
    out.env_during = stagingEnvFlags();

    if (out.env_during.STAFF_ACTIONS_ENABLED !== 'true' || out.env_during.STRIPE_LINKS_ENABLED !== 'true') {
      throw new Error('proof_env_not_enabled');
    }

    const cookie = await staffLogin();
    const genPayload = {
      client_slug: CLIENT,
      booking_id: BOOKING_ID,
      idempotency_key: IDEM,
      reason: 'Phase 20g balance link proof',
    };

    const resA = await req('POST', GEN_ROUTE, genPayload, { Cookie: cookie });
    out.step_a_create_balance_link = {
      http_status: resA.status,
      summary: summarizeGen(resA.body || {}),
      raw_error: resA.body && resA.body.error,
    };
    out.step_a_create_balance_link.balance_payment_id = resA.body && resA.body.payment_id;

    const critA = stopIfCritical(await (async () => {
      const pg = await pgConnect();
      const snap = await dbSnapshot(pg);
      await pg.end();
      return snap;
    })(), 'after_a');
    if (critA.stop) {
      out.stopped_early = true;
      out.stop_reason = critA.issues.join(',');
      out.result = 'FAIL';
      throw new Error(out.stop_reason);
    }

    const botToken = getBotToken();
    const previewPayload = { client_slug: CLIENT, booking_id: BOOKING_ID };
    const resB = await req('POST', PREVIEW_ROUTE, previewPayload, { 'X-Luna-Bot-Token': botToken });
    out.step_b_confirmation_preview = {
      http_status: resB.status,
      summary: summarizePreview(resB.body || {}),
    };

    const resC = await req('POST', GEN_ROUTE, genPayload, { Cookie: cookie });
    out.step_c_replay = {
      http_status: resC.status,
      summary: summarizeGen(resC.body || {}),
    };

    const pg1 = await pgConnect();
    out.db_after = await dbSnapshot(pg1);
    await pg1.end();

    const deposit = out.db_after.payments.find((p) => p.payment_id === DEPOSIT_PAYMENT_ID);
    const balanceRows = out.db_after.payments.filter((p) => p.payment_kind === 'full_amount');
    const balance = balanceRows.find((p) => p.status === 'checkout_created') || balanceRows[balanceRows.length - 1];

    out.db_after.checks = {
      deposit_still_paid: deposit && deposit.status === 'paid',
      one_balance_payment: balanceRows.length === 1,
      balance_amount_17000: balance && Number(balance.amount_due_cents) === 17000,
      balance_checkout_created: balance && balance.status === 'checkout_created',
      balance_has_checkout_url: balance && balance.has_checkout_url,
      balance_paid_at_null: balance && !balance.paid_at,
      balance_amount_paid_zero: balance && Number(balance.amount_paid_cents) === 0,
      booking_deposit_paid: out.db_after.booking && out.db_after.booking.payment_status === 'deposit_paid',
      balance_due_17000: out.db_after.booking && Number(out.db_after.booking.balance_due_cents) === 17000,
      confirmation_sent_at_null: !out.db_after.booking || !out.db_after.booking.confirmation_sent_at,
      no_whatsapp_sends: out.db_after.guest_message_sends_sent === 0,
      payment_count_is_two: out.db_after.payment_count === 2,
    };
    out.db_after.balance_payment_id = balance && balance.payment_id;
    out.db_after.result = Object.values(out.db_after.checks).every(Boolean) ? 'PASS' : 'PARTIAL';

    out.step_a_create_balance_link.checks = {
      http_200: resA.status === 200,
      success: resA.body && resA.body.success === true,
      amount_17000: resA.body && Number(resA.body.amount_due_cents) === 17000,
      checkout_url: resA.body && !!resA.body.checkout_url,
      session_id: resA.body && !!resA.body.stripe_checkout_session_id,
      no_whatsapp: resA.body && resA.body.no_whatsapp !== false,
      no_payment_truth: resA.body && resA.body.no_payment_truth_recorded === true,
    };
    out.step_a_create_balance_link.result = Object.values(out.step_a_create_balance_link.checks).every(Boolean) ? 'PASS' : 'FAIL';

    out.step_b_confirmation_preview.checks = {
      http_200: resB.status === 200,
      included_existing_link: resB.body && resB.body.balance_payment_link_status === 'included_existing_link',
      url_in_message: resB.body && /https:\/\/checkout\.stripe\.com/i.test(String(resB.body.message_preview || '')),
      cami_template: resB.body && resB.body.template_source === 'confirmation_templates',
      preview_only: resB.body && resB.body.preview_only === true,
      no_send: resB.body && resB.body.sends_whatsapp === false,
      no_bed_leak: resB.body && !/(?:DEMO-R\d+-B\d+)/.test(String(resB.body.message_preview || '')),
    };
    out.step_b_confirmation_preview.result = Object.values(out.step_b_confirmation_preview.checks).every(Boolean) ? 'PASS' : 'FAIL';

    out.step_c_replay.checks = {
      http_200: resC.status === 200,
      idempotent: resC.body && (resC.body.idempotent === true || resC.body.created === false),
      same_payment_id: resC.body && resA.body && resC.body.payment_id === resA.body.payment_id,
      no_second_stripe: resC.body && resC.body.stripe_mutation === false,
    };
    out.step_c_replay.result = Object.values(out.step_c_replay.checks).every(Boolean) ? 'PASS' : 'PARTIAL';

    const parts = [
      out.step_a_create_balance_link.result,
      out.step_b_confirmation_preview.result,
      out.db_after.result,
    ];
    if (parts.every((x) => x === 'PASS') && out.step_c_replay.result !== 'FAIL') {
      out.result = out.step_c_replay.result === 'PASS' ? 'PASS' : 'PARTIAL';
    } else if (out.step_a_create_balance_link.result !== 'FAIL' && out.db_after.result !== 'FAIL') {
      out.result = 'PARTIAL';
    } else {
      out.result = 'FAIL';
    }
  } catch (err) {
    if (out.result === 'PENDING') out.result = 'FAIL';
    out.error = err.message;
  } finally {
    try {
      revertSafeRevision();
      out.revision_after = await waitHealthy(REVERT_SUFFIX);
      out.env_after = stagingEnvFlags();
      out.health_after = (await req('GET', '/healthz')).status;
    } catch (revertErr) {
      out.revert_error = revertErr.message;
    }
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.result === 'PASS' ? 0 : (out.result === 'PARTIAL' ? 2 : 1));
  }
})();
