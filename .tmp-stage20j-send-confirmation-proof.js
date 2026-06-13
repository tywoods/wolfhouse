'use strict';
/** Phase 20j-hosted — dedicated send-confirmation route proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = '434f1f6';
const IMAGE_TAG = `${COMMIT}-stage20j-send-confirmation-safe`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 'stage20j-send-confirmation-safe';
const PROOF_START = new Date().toISOString();

const BOOKING_ID = '828538c7-c6cb-4c6f-b45a-57a641af37cc';
const BOOKING_CODE = 'MB-WOLFHO-20260924-e90132';
const DEPOSIT_PAYMENT_ID = '7659e304-64d4-47cf-82b9-4be1e37ac913';
const BALANCE_PAYMENT_ID = 'cec96e1f-2d07-4b26-9cdd-0273d763bb96';
const EXISTING_GMS_ID = 'a3676eb7-09e7-41c3-b5ba-3fcdbc05c2e6';
const TO = '+491726422307';
const IDEM = 'luna-confirmation:wolfhouse-somo:828538c7-c6cb-4c6f-b45a-57a641af37cc:v1';
const PREVIEW_ROUTE = '/staff/bot/bookings/confirmation-preview';
const SEND_CONFIRM_ROUTE = '/staff/bot/bookings/send-confirmation';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 }).trim();
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
           b.amount_paid_cents, b.balance_due_cents, b.confirmation_sent_at,
           b.metadata
      FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.id = $2::uuid`, [CLIENT, BOOKING_ID]);

  const pays = await pg.query(`
    SELECT p.id::text AS payment_id, p.status::text, p.payment_kind::text,
           p.amount_due_cents, p.amount_paid_cents, p.checkout_url, p.paid_at
      FROM payments p WHERE p.booking_id = $1::uuid ORDER BY p.created_at`, [BOOKING_ID]);

  const sends = await pg.query(`
    SELECT id::text AS guest_message_send_id, status, idempotency_key,
           provider_message_id, send_kind, to_phone, source,
           created_at, sent_at
      FROM guest_message_sends
     WHERE client_slug = $1 AND idempotency_key = $2
     ORDER BY created_at`, [CLIENT, IDEM]);

  const allSentForBooking = await pg.query(`
    SELECT COUNT(*)::int AS n FROM guest_message_sends
     WHERE client_slug = $1 AND send_kind = 'confirmation' AND status = 'sent'`, [CLIENT]);

  const sentDuringProof = await pg.query(`
    SELECT COUNT(*)::int AS n FROM guest_message_sends
     WHERE client_slug = $1 AND created_at >= $2::timestamptz AND status = 'sent'`,
    [CLIENT, PROOF_START]);

  return {
    booking: bk.rows[0] || null,
    payments: pays.rows,
    guest_message_sends_for_key: sends.rows,
    confirmation_sent_rows: allSentForBooking.rows[0].n,
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
    message_preview_len: msg.length,
  };
}

function summarizeSendConfirmation(body) {
  return {
    success: body.success,
    send_performed: body.send_performed,
    sends_whatsapp: body.sends_whatsapp,
    would_send_whatsapp: body.would_send_whatsapp,
    duplicate: body.duplicate,
    idempotent_replay: body.idempotent_replay,
    confirmation_already_sent: body.confirmation_already_sent,
    send_skipped_reason: body.send_skipped_reason || null,
    whatsapp_message_id: body.whatsapp_message_id || null,
    blocked_reasons: body.blocked_reasons || [],
    updates_confirmation_sent_at: body.updates_confirmation_sent_at,
    confirmation_sent_at: body.confirmation_sent_at || null,
    guest_message_send_id: body.guest_message_send_id || null,
    guest_message_send_status: body.guest_message_send_status || null,
    confirmation_send_audit: body.confirmation_send_audit || null,
    send_kind: body.send_kind || null,
    error: body.error || null,
  };
}

function buildSendConfirmationPayload() {
  return {
    client_slug: CLIENT,
    booking_id: BOOKING_ID,
    to: TO,
    idempotency_key: IDEM,
    confirm_send: true,
  };
}

function deploySafeRevision() {
  console.log('Building image via ACR...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.log('Updating container app (safe env)...');
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REV_SUFFIX}`,
    '--set-env-vars WHATSAPP_DRY_RUN=true STRIPE_LINKS_ENABLED=false',
    '--remove-env-vars LUNA_AUTO_SEND_ENABLED WHATSAPP_LIVE_SENDS_ENABLED LUNA_GUEST_LIVE_SEND_OWNER_APPROVED WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID BOT_BOOKING_ENABLED',
  ].join(' '));
}

async function waitHealthy(revSuffix, timeoutMs = 240000) {
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

function envIsSafe(flags) {
  return flags.WHATSAPP_DRY_RUN === 'true'
    && flags.LUNA_AUTO_SEND_ENABLED === '(unset)'
    && flags.WHATSAPP_LIVE_SENDS_ENABLED === '(unset)'
    && flags.LUNA_GUEST_LIVE_SEND_OWNER_APPROVED === '(unset)'
    && flags.STRIPE_LINKS_ENABLED === 'false'
    && flags.BOT_BOOKING_ENABLED === '(unset)';
}

(async () => {
  const out = {
    phase: '20j-hosted',
    commit: COMMIT,
    image: IMAGE,
    proof_start: PROOF_START,
    booking_id: BOOKING_ID,
    idempotency_key: IDEM,
    deploy: null,
    health: null,
    env_before: null,
    env_after: null,
    db_before: null,
    preview_precheck: null,
    gms_precheck: null,
    step_a: null,
    step_b: null,
    db_after: null,
    safety: {},
    result: 'PENDING',
    stopped_early: false,
    stop_reason: null,
    caveats: [],
    recommended_next_step: null,
  };

  const token = getBotToken();
  const botHeaders = { 'X-Luna-Bot-Token': token };

  let pg;
  try {
    pg = await pgConnect();
    out.db_before = await dbSnapshot(pg);
    out.env_before = stagingEnvFlags();

    out.gms_precheck = {
      existing_row: out.db_before.guest_message_sends_for_key.find((r) => r.guest_message_send_id === EXISTING_GMS_ID) || out.db_before.guest_message_sends_for_key[0] || null,
      row_count_for_v1: out.db_before.guest_message_sends_for_key.length,
      checks: {
        confirmation_sent_at_null: !out.db_before.booking?.confirmation_sent_at,
        payment_deposit_paid: out.db_before.booking?.payment_status === 'deposit_paid',
        balance_due_17000: out.db_before.booking?.balance_due_cents === 17000,
        v1_exists: out.db_before.guest_message_sends_for_key.length >= 1,
        v1_status_sent: out.db_before.guest_message_sends_for_key.some((r) => r.status === 'sent'),
        v1_provider_id: out.db_before.guest_message_sends_for_key.some((r) => !!r.provider_message_id),
      },
    };
    out.gms_precheck.result = Object.values(out.gms_precheck.checks).every(Boolean) ? 'PASS' : 'FAIL';

    deploySafeRevision();
    out.deploy = {
      image: IMAGE,
      revision_suffix: REV_SUFFIX,
    };
    const rev = await waitHealthy(REV_SUFFIX);
    out.deploy.revision = rev;
    out.health = (await req('GET', '/healthz')).status;
    out.env_after = stagingEnvFlags();
    out.safety.env_safe = envIsSafe(out.env_after);
    out.safety.health_200 = out.health === 200;
    out.safety.deploy_healthy = rev.health === 'Healthy' && rev.traffic === 100;
    out.safety.image_matches = String(rev.image || '').includes(COMMIT);

    if (out.gms_precheck.result === 'FAIL') {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = 'db_precheck_failed';
      throw new Error(out.stop_reason);
    }

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
      balance_link: out.preview_precheck.analysis.balance_payment_link_status === 'included_existing_link',
      stripe_url: out.preview_precheck.analysis.has_stripe_url,
      address: out.preview_precheck.analysis.has_address,
      gate: out.preview_precheck.analysis.has_gate,
      room: out.preview_precheck.analysis.has_room,
      no_bed: out.preview_precheck.analysis.no_bed,
      preview_no_send: prePreview.body && prePreview.body.sends_whatsapp === false,
    };
    out.preview_precheck.result = Object.values(out.preview_precheck.checks).every(Boolean) ? 'PASS' : 'FAIL';

    if (out.preview_precheck.result === 'FAIL') {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = 'preview_precheck_failed';
      throw new Error(out.stop_reason);
    }

    const sentBefore = out.db_before.guest_message_sends_for_key.length;
    const providerIdBefore = out.db_before.guest_message_sends_for_key[0]?.provider_message_id || null;
    const sentAtBefore = out.db_before.booking?.confirmation_sent_at || null;

    const stepA = await req('POST', SEND_CONFIRM_ROUTE, buildSendConfirmationPayload(), botHeaders);
    out.step_a = {
      http_status: stepA.status,
      body: summarizeSendConfirmation(stepA.body || {}),
      raw_blocked: stepA.body?.blocked_reasons || [],
    };

    if (out.step_a.body.send_performed === true || out.step_a.body.sends_whatsapp === true) {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = 'step_a_attempted_provider_send';
      out.safety.unexpected_whatsapp = true;
      throw new Error(out.stop_reason);
    }

    const dbAfterA = await dbSnapshot(pg);
    out.step_a.db_after = {
      confirmation_sent_at: dbAfterA.booking?.confirmation_sent_at || null,
      metadata: dbAfterA.booking?.metadata || null,
      gms_row_count: dbAfterA.guest_message_sends_for_key.length,
      provider_message_id: dbAfterA.guest_message_sends_for_key[0]?.provider_message_id || null,
      sent_during_proof: dbAfterA.sent_during_proof,
    };

    out.step_a.evaluation = {
      http_200: stepA.status === 200,
      idempotent_or_duplicate: !!(out.step_a.body.duplicate || out.step_a.body.idempotent_replay),
      no_send: out.step_a.body.send_performed !== true && out.step_a.body.sends_whatsapp !== true,
      sent_at_set: !!dbAfterA.booking?.confirmation_sent_at,
      sent_at_changed_from_null: !sentAtBefore && !!dbAfterA.booking?.confirmation_sent_at,
      gms_count_unchanged: dbAfterA.guest_message_sends_for_key.length === sentBefore,
      provider_id_unchanged: (dbAfterA.guest_message_sends_for_key[0]?.provider_message_id || null) === providerIdBefore,
      no_new_sent_rows: dbAfterA.sent_during_proof === 0,
    };

    if (!out.step_a.evaluation.no_send || !out.step_a.evaluation.gms_count_unchanged) {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = 'step_a_safety_violation';
      throw new Error(out.stop_reason);
    }

    if (!out.step_a.evaluation.sent_at_set) {
      out.caveats.push('Step A idempotent replay did NOT backfill confirmation_sent_at (current route only sets on send_performed=true)');
      out.recommended_next_step = 'Tiny patch: backfill confirmation_sent_at from existing guest_message_sends row when status=sent and idempotent_replay';
    }

    const stepB = await req('POST', SEND_CONFIRM_ROUTE, buildSendConfirmationPayload(), botHeaders);
    out.step_b = {
      http_status: stepB.status,
      body: summarizeSendConfirmation(stepB.body || {}),
    };

    if (out.step_b.body.send_performed === true || out.step_b.body.sends_whatsapp === true) {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = 'step_b_attempted_provider_send';
      throw new Error(out.stop_reason);
    }

    const dbAfterB = await dbSnapshot(pg);
    out.db_after = dbAfterB;
    out.step_b.db_after = {
      confirmation_sent_at: dbAfterB.booking?.confirmation_sent_at || null,
      gms_row_count: dbAfterB.guest_message_sends_for_key.length,
      sent_during_proof: dbAfterB.sent_during_proof,
    };
    out.step_b.evaluation = {
      http_200: stepB.status === 200,
      skipped_already_sent: out.step_b.body.send_skipped_reason === 'confirmation_sent_at_already_set'
        || out.step_b.body.confirmation_already_sent === true
        || out.step_b.body.duplicate === true,
      no_send: out.step_b.body.send_performed !== true,
      sent_at_unchanged: (dbAfterB.booking?.confirmation_sent_at || null) === (dbAfterA.booking?.confirmation_sent_at || null),
      gms_count_1: dbAfterB.guest_message_sends_for_key.length === 1,
    };

    const deposit = dbAfterB.payments.find((p) => p.payment_id === DEPOSIT_PAYMENT_ID);
    const balance = dbAfterB.payments.find((p) => p.payment_id === BALANCE_PAYMENT_ID);
    out.safety.no_whatsapp = dbAfterB.sent_during_proof === 0;
    out.safety.no_payment_change = deposit?.status === 'paid' && balance?.status === 'checkout_created';
    out.safety.booking_deposit_paid = dbAfterB.booking?.payment_status === 'deposit_paid';
    out.safety.balance_due_unchanged = dbAfterB.booking?.balance_due_cents === 17000;
    out.safety.gms_v1_count_1 = dbAfterB.guest_message_sends_for_key.length === 1;
    out.safety.env_unchanged = JSON.stringify(out.env_before) === JSON.stringify(out.env_after);

    const stepAPass = out.step_a.evaluation.http_200
      && out.step_a.evaluation.idempotent_or_duplicate
      && out.step_a.evaluation.no_send
      && out.step_a.evaluation.no_new_sent_rows;
    const stepBPass = out.step_b.evaluation.http_200 && out.step_b.evaluation.no_send;

    if (stepAPass && stepBPass && out.step_a.evaluation.sent_at_set && out.safety.no_whatsapp) {
      out.result = 'PASS';
    } else if (stepAPass && stepBPass && out.safety.no_whatsapp) {
      out.result = 'PARTIAL';
    } else {
      out.result = 'FAIL';
    }
  } catch (err) {
    if (out.result === 'PENDING') out.result = 'FAIL';
    out.error = err.message;
    try {
      if (pg) out.db_after = await dbSnapshot(pg);
      out.env_after = stagingEnvFlags();
      out.deploy = out.deploy || {};
      out.deploy.revision = activeRevision();
    } catch (_) { /* ignore */ }
  } finally {
    if (pg) await pg.end().catch(() => {});
    console.log(JSON.stringify(out, null, 2));
  }
})();
