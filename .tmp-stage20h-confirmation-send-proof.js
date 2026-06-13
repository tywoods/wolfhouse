'use strict';
/** Phase 20h — live Cami confirmation WhatsApp send. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:92e0740-stage20h-confirmation-send';
const PROOF_SUFFIX = 'stage20h-confirmation-send';
const REVERT_SUFFIX = 'stage20h-confirmation-safe';
const PROOF_START = new Date().toISOString();

const BOOKING_ID = '828538c7-c6cb-4c6f-b45a-57a641af37cc';
const BOOKING_CODE = 'MB-WOLFHO-20260924-e90132';
const DEPOSIT_PAYMENT_ID = '7659e304-64d4-47cf-82b9-4be1e37ac913';
const BALANCE_PAYMENT_ID = 'cec96e1f-2d07-4b26-9cdd-0273d763bb96';
const TO = '+491726422307';
const IDEM = 'luna-confirmation:wolfhouse-somo:828538c7-c6cb-4c6f-b45a-57a641af37cc:v1';
const PREVIEW_ROUTE = '/staff/bot/bookings/confirmation-preview';
const SEND_ROUTE = '/staff/bot/guest-reply-send';

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
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
    WHATSAPP_LIVE_SENDS_ENABLED: pick('WHATSAPP_LIVE_SENDS_ENABLED'),
    LUNA_GUEST_LIVE_SEND_OWNER_APPROVED: pick('LUNA_GUEST_LIVE_SEND_OWNER_APPROVED'),
    BOT_BOOKING_ENABLED: pick('BOT_BOOKING_ENABLED'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    WHATSAPP_CLOUD_ACCESS_TOKEN: pick('WHATSAPP_CLOUD_ACCESS_TOKEN'),
    WHATSAPP_PHONE_NUMBER_ID: pick('WHATSAPP_PHONE_NUMBER_ID'),
  };
}

function getBotToken() {
  return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
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
           p.amount_due_cents, p.amount_paid_cents, p.paid_at
      FROM payments p WHERE p.booking_id = $1::uuid ORDER BY p.created_at`, [BOOKING_ID]);

  const sends = await pg.query(`
    SELECT id::text AS guest_message_send_id, status, idempotency_key,
           provider_message_id, send_kind, to_phone,
           LEFT(message_text, 120) AS message_excerpt,
           LENGTH(message_text) AS message_len,
           created_at
      FROM guest_message_sends
     WHERE client_slug = $1 AND idempotency_key = $2
     ORDER BY created_at`, [CLIENT, IDEM]);

  const sentDuringProof = await pg.query(`
    SELECT COUNT(*)::int AS n FROM guest_message_sends
     WHERE client_slug = $1 AND created_at >= $2::timestamptz AND status = 'sent'`,
    [CLIENT, PROOF_START]);

  return {
    booking: bk.rows[0] || null,
    payments: pays.rows,
    guest_message_sends_for_key: sends.rows,
    sent_during_proof: sentDuringProof.rows[0].n,
  };
}

function analyzePreview(body) {
  const msg = String(body.message_preview || '');
  return {
    template_source: body.template_source,
    balance_payment_link_status: body.balance_payment_link_status,
    sends_whatsapp: body.sends_whatsapp,
    confirmation_sent_at: body.confirmation_sent_at,
    has_paid: /€100/.test(msg),
    has_balance: /€170/.test(msg),
    has_address: /C\. Mies de La Ran/.test(msg),
    has_gate: /2684#/.test(msg),
    has_room: /DEMO-R1/.test(msg) && !/DEMO-R1-B/.test(msg),
    has_stripe_url: /checkout\.stripe\.com/i.test(msg),
    no_bed: !/(?:DEMO-R\d+-B\d+)/.test(msg),
    no_fully_paid: !/\bfully paid\b/i.test(msg),
    message_preview: msg,
  };
}

function summarizeSend(body) {
  return {
    success: body.success,
    send_performed: body.send_performed,
    sends_whatsapp: body.sends_whatsapp,
    duplicate: body.duplicate,
    idempotent_replay: body.idempotent_replay,
    whatsapp_message_id: body.whatsapp_message_id || null,
    blocked_reasons: body.blocked_reasons || [],
    updates_confirmation_sent_at: body.updates_confirmation_sent_at,
    guest_message_send_id: body.guest_message_send_id,
    guest_message_send_status: body.guest_message_send_status,
    provider_error: body.provider_error || null,
    error: body.error || null,
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
    'LUNA_AUTO_SEND_ENABLED=true',
    'WHATSAPP_DRY_RUN=false',
    'WHATSAPP_LIVE_SENDS_ENABLED=true',
    'LUNA_GUEST_LIVE_SEND_OWNER_APPROVED=true',
    'WHATSAPP_CLOUD_ACCESS_TOKEN=secretref:meta-whatsapp-token',
    'WHATSAPP_PHONE_NUMBER_ID=secretref:meta-whatsapp-phone-id',
    'STRIPE_LINKS_ENABLED=false',
    '--remove-env-vars BOT_BOOKING_ENABLED',
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
    '--remove-env-vars LUNA_AUTO_SEND_ENABLED WHATSAPP_LIVE_SENDS_ENABLED LUNA_GUEST_LIVE_SEND_OWNER_APPROVED WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID BOT_BOOKING_ENABLED',
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

function buildSendPayload(messagePreview) {
  return {
    client_slug: CLIENT,
    to: TO,
    send_kind: 'confirmation',
    idempotency_key: IDEM,
    suggested_reply: messagePreview,
    source: 'booking_confirmation_preview',
    send_eligibility: {
      send_allowed_later: true,
      requires_staff: false,
      auto_send_ready: true,
    },
  };
}

function stopIfCritical(db, label) {
  const issues = [];
  if (db.booking && db.booking.confirmation_sent_at) issues.push('confirmation_sent_at_set');
  if (db.sent_during_proof > 1) issues.push('multiple_whatsapp_sends');
  const deposit = db.payments.find((p) => p.payment_id === DEPOSIT_PAYMENT_ID);
  const balance = db.payments.find((p) => p.payment_id === BALANCE_PAYMENT_ID);
  if (deposit && deposit.status !== 'paid') issues.push('deposit_not_paid');
  if (balance && balance.status === 'paid') issues.push('balance_marked_paid');
  if (db.payments.length !== 2) issues.push('payment_count_changed');
  if (db.booking && db.booking.payment_status === 'paid') issues.push('booking_fully_paid');
  return { label, issues, stop: issues.length > 0 };
}

(async () => {
  const out = {
    phase: '20h-retry',
    proof_start: PROOF_START,
    image: IMAGE,
    booking_id: BOOKING_ID,
    to: TO,
    idempotency_key: IDEM,
    revision_before: null,
    env_before: null,
    health_before: null,
    preview_precheck: null,
    revision_during: null,
    env_during: null,
    step_a_send: null,
    step_b_replay: null,
    db_after: null,
    revision_after: null,
    env_after: null,
    health_after: null,
    result: 'PENDING',
    stopped_early: false,
    stop_reason: null,
  };

  const token = getBotToken();
  const botHeaders = { 'X-Luna-Bot-Token': token };

  try {
    out.revision_before = activeRevision();
    out.env_before = stagingEnvFlags();
    out.health_before = (await req('GET', '/healthz')).status;

    const prePreview = await req('POST', PREVIEW_ROUTE, {
      client_slug: CLIENT,
      booking_id: BOOKING_ID,
    }, botHeaders);
    out.preview_precheck = {
      http_status: prePreview.status,
      analysis: analyzePreview(prePreview.body || {}),
    };
    out.preview_precheck.checks = {
      http_200: prePreview.status === 200,
      template: out.preview_precheck.analysis.template_source === 'confirmation_templates',
      balance_link: out.preview_precheck.analysis.balance_payment_link_status === 'included_existing_link',
      content_ok: out.preview_precheck.analysis.has_paid
        && out.preview_precheck.analysis.has_balance
        && out.preview_precheck.analysis.has_address
        && out.preview_precheck.analysis.has_gate
        && out.preview_precheck.analysis.has_room
        && out.preview_precheck.analysis.has_stripe_url
        && out.preview_precheck.analysis.no_bed
        && out.preview_precheck.analysis.no_fully_paid,
      preview_no_send: prePreview.body && prePreview.body.sends_whatsapp === false,
      sent_at_null: !prePreview.body || !prePreview.body.confirmation_sent_at,
    };
    out.preview_precheck.result = Object.values(out.preview_precheck.checks).every(Boolean) ? 'PASS' : 'FAIL';

    if (out.preview_precheck.result === 'FAIL') {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = 'preview_precheck_failed';
      throw new Error(out.stop_reason);
    }

    const messagePreview = out.preview_precheck.analysis.message_preview;
    const sendPayload = buildSendPayload(messagePreview);

    enableProofRevision();
    out.revision_during = await waitHealthy(PROOF_SUFFIX);
    out.env_during = stagingEnvFlags();

    if (out.env_during.WHATSAPP_DRY_RUN !== 'false' || out.env_during.LUNA_AUTO_SEND_ENABLED !== 'true') {
      throw new Error('proof_env_not_enabled');
    }

    const pg0 = await pgConnect();
    const dbBeforeSend = await dbSnapshot(pg0);
    await pg0.end();

    const resA = await req('POST', SEND_ROUTE, sendPayload, botHeaders);
    out.step_a_send = {
      http_status: resA.status,
      summary: summarizeSend(resA.body || {}),
    };
    out.step_a_send.checks = {
      http_200: resA.status === 200,
      success: resA.body && resA.body.success === true,
      send_performed: resA.body && resA.body.send_performed === true,
      sends_whatsapp: resA.body && resA.body.sends_whatsapp === true,
      wamid: !!(resA.body && resA.body.whatsapp_message_id),
      no_sent_at_flag: resA.body && resA.body.updates_confirmation_sent_at === false,
    };
    out.step_a_send.result = Object.values(out.step_a_send.checks).every(Boolean) ? 'PASS' : 'FAIL';

    const pg1 = await pgConnect();
    const dbAfterA = await dbSnapshot(pg1);
    await pg1.end();
    const critA = stopIfCritical(dbAfterA, 'after_a');
    if (critA.stop || out.step_a_send.result === 'FAIL') {
      out.stopped_early = true;
      out.stop_reason = critA.issues.join(',') || 'step_a_failed';
      out.db_after_a = dbAfterA;
      if (out.step_a_send.result === 'FAIL') out.result = 'FAIL';
      throw new Error(out.stop_reason);
    }

    const resB = await req('POST', SEND_ROUTE, sendPayload, botHeaders);
    out.step_b_replay = {
      http_status: resB.status,
      summary: summarizeSend(resB.body || {}),
    };
    out.step_b_replay.checks = {
      http_200: resB.status === 200,
      duplicate: resB.body && resB.body.duplicate === true,
      idempotent_replay: resB.body && resB.body.idempotent_replay === true,
      no_send: resB.body && resB.body.send_performed === false && resB.body.sends_whatsapp === false,
      same_wamid: resB.body && resA.body && resB.body.whatsapp_message_id === resA.body.whatsapp_message_id,
    };
    out.step_b_replay.result = Object.values(out.step_b_replay.checks).every(Boolean) ? 'PASS' : 'PARTIAL';

    const pg2 = await pgConnect();
    out.db_after = await dbSnapshot(pg2);
    await pg2.end();

    const sentRows = out.db_after.guest_message_sends_for_key.filter((r) => r.status === 'sent');
    out.db_after.checks = {
      one_sent_row: sentRows.length === 1,
      provider_message_id: sentRows[0] && !!sentRows[0].provider_message_id,
      message_matches_preview: sentRows[0] && Number(sentRows[0].message_len) === messagePreview.length,
      confirmation_sent_at_null: !out.db_after.booking || !out.db_after.booking.confirmation_sent_at,
      deposit_paid: out.db_after.booking && out.db_after.booking.payment_status === 'deposit_paid',
      balance_17000: out.db_after.booking && Number(out.db_after.booking.balance_due_cents) === 17000,
      deposit_still_paid: out.db_after.payments.find((p) => p.payment_id === DEPOSIT_PAYMENT_ID)?.status === 'paid',
      balance_checkout_created: out.db_after.payments.find((p) => p.payment_id === BALANCE_PAYMENT_ID)?.status === 'checkout_created',
      two_payments: out.db_after.payments.length === 2,
      sent_during_proof_one: out.db_after.sent_during_proof === 1,
    };
    out.db_after.result = Object.values(out.db_after.checks).every(Boolean) ? 'PASS' : 'PARTIAL';

    const critFinal = stopIfCritical(out.db_after, 'final');
    if (critFinal.stop) {
      out.result = 'FAIL';
      out.stop_reason = critFinal.issues.join(',');
      throw new Error(out.stop_reason);
    }

    if (out.step_a_send.result === 'PASS' && out.step_b_replay.result === 'PASS' && out.db_after.result === 'PASS') {
      out.result = 'PASS';
    } else if (out.step_a_send.result === 'PASS') {
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
      const webhook = await req('GET', '/staff/meta/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wolfhouse_verify_token&hub.challenge=20hproof');
      out.webhook_verify_after = webhook.raw;
    } catch (revertErr) {
      out.revert_error = revertErr.message;
      out.result = 'FAIL';
    }
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.result === 'PASS' ? 0 : (out.result === 'PARTIAL' ? 2 : 1));
  }
})();
