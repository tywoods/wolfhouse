'use strict';
/** Phase 19g.11 — controlled inbound auto-reply proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const FROM = '491726422307';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:4cab874-stage19g10-message-events-ui';
const CASE_A_TEXT = 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?';
const CASE_B_TEXT = 'I want a refund and need to talk to someone.';
const PROOF_START = new Date().toISOString();
const CASE_A_WAMID = `wamid.phase19g11.casea.${Date.now()}`;
const CASE_B_WAMID = `wamid.phase19g11.caseb.${Date.now() + 1}`;

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
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
    WHATSAPP_CLOUD_ACCESS_TOKEN: pick('WHATSAPP_CLOUD_ACCESS_TOKEN'),
    WHATSAPP_PHONE_NUMBER_ID: pick('WHATSAPP_PHONE_NUMBER_ID'),
  };
}

async function pgConnect() {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

function buildMetaPayload(waMessageId, messageText, profileName = 'Ty Live Proof') {
  const phoneId = az('az keyvault secret show --vault-name wh-staging-kv --name meta-whatsapp-phone-id --query value -o tsv');
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '842343435599477',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: '34663439419',
            phone_number_id: phoneId.trim(),
          },
          contacts: [{ profile: { name: profileName }, wa_id: FROM }],
          messages: [{
            from: FROM,
            id: waMessageId,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: messageText },
          }],
        },
      }],
    }],
  };
}

async function waitHealthy(revSuffix, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rev = activeRevision();
    if (rev.health === 'Healthy'
      && rev.traffic === 100
      && String(rev.name || '').includes(revSuffix)) {
      return rev;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return activeRevision();
}

async function queryEvent(pg, waMessageId) {
  const ev = await pg.query(
    `SELECT wa_message_id, message_text, draft_called, next_action, suggested_reply,
            handoff_required, send_attempted, send_status, send_blocked_reasons,
            send_idempotency_key, created_at
       FROM guest_message_events
      WHERE client_slug = $1 AND wa_message_id = $2`,
    [CLIENT, waMessageId],
  );
  return ev.rows[0] || null;
}

async function querySends(pg, idempotencyKey) {
  const s = await pg.query(
    `SELECT idempotency_key, status, provider_message_id, message_text, created_at
       FROM guest_message_sends
      WHERE idempotency_key = $1
      ORDER BY created_at ASC`,
    [idempotencyKey],
  );
  return s.rows;
}

async function safetyCounts(pg) {
  const sent = await pg.query(
    `SELECT idempotency_key, status, provider_message_id, created_at
       FROM guest_message_sends
      WHERE status = 'sent' AND created_at >= $1::timestamptz`,
    [PROOF_START],
  );
  const bookings = await pg.query('SELECT id FROM bookings WHERE created_at >= $1::timestamptz LIMIT 3', [PROOF_START]);
  const payments = await pg.query('SELECT id FROM payments WHERE created_at >= $1::timestamptz LIMIT 3', [PROOF_START]);
  return { sent: sent.rows, bookings: bookings.rows, payments: payments.rows };
}

function enableProofRevision() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    '--revision-suffix stage19g11-autosend-proof3',
    '--set-env-vars',
    'LUNA_AUTO_SEND_ENABLED=true',
    'WHATSAPP_DRY_RUN=false',
    'WHATSAPP_LIVE_SENDS_ENABLED=true',
    'LUNA_GUEST_LIVE_SEND_OWNER_APPROVED=true',
    'WHATSAPP_CLOUD_ACCESS_TOKEN=secretref:meta-whatsapp-token',
    'WHATSAPP_PHONE_NUMBER_ID=secretref:meta-whatsapp-phone-id',
  ].join(' '));
}

function revertSafeRevision() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    '--revision-suffix stage19g11-revert-safe3',
    '--set-env-vars WHATSAPP_DRY_RUN=true',
    '--remove-env-vars LUNA_AUTO_SEND_ENABLED WHATSAPP_LIVE_SENDS_ENABLED LUNA_GUEST_LIVE_SEND_OWNER_APPROVED WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID',
  ].join(' '));
}

(async () => {
  const step = process.argv[2] || 'all';
  const out = { phase: '19g.11', proof_start: PROOF_START, checked_at: new Date().toISOString() };

  if (step === 'precheck' || step === 'all') {
    out.env_before = stagingEnvFlags();
    out.revision_before = activeRevision();
    out.health = (await req('GET', '/healthz')).status;
    out.webhook_verify = (await req('GET', '/staff/meta/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wolfhouse_verify_token&hub.challenge=auto123')).raw;
    console.log(JSON.stringify({ step: 'precheck', ...out }, null, 2));
    if (step === 'precheck') return;
  }

  if (step === 'enable' || step === 'all') {
    out.env_before = out.env_before || stagingEnvFlags();
    enableProofRevision();
    out.proof_revision = await waitHealthy('stage19g11-autosend-proof3');
    out.env_during = stagingEnvFlags();
    console.log(JSON.stringify({ step: 'enable', ...out }, null, 2));
    if (step === 'enable') return;
  }

  const pg = await pgConnect();

  if (step === 'case-a' || step === 'all') {
    out.env_during = out.env_during || stagingEnvFlags();
    const payloadA = buildMetaPayload(CASE_A_WAMID, CASE_A_TEXT);
    out.case_a_payload_wamid = CASE_A_WAMID;
    const respA = await req('POST', '/staff/meta/whatsapp/webhook', payloadA);
    out.case_a_http = respA.status;
    out.case_a_response = respA.body;
    await new Promise((r) => setTimeout(r, 2000));
    const evA = await queryEvent(pg, CASE_A_WAMID);
    const idemA = evA?.send_idempotency_key || `luna:${CLIENT}:${CASE_A_WAMID}:ask_missing_field`;
    const sendsA = await querySends(pg, idemA);
    out.case_a_event = evA;
    out.case_a_sends = sendsA;
    out.case_a_idempotency_key = idemA;
    out.case_a_send_count = sendsA.filter((r) => r.status === 'sent').length;

    // Replay
    const replayA = await req('POST', '/staff/meta/whatsapp/webhook', payloadA);
    out.case_a_replay_http = replayA.status;
    out.case_a_replay_response = replayA.body;
    await new Promise((r) => setTimeout(r, 1500));
    const sendsA2 = await querySends(pg, idemA);
    out.case_a_sends_after_replay = sendsA2;
    out.case_a_send_count_after_replay = sendsA2.filter((r) => r.status === 'sent').length;

    console.log(JSON.stringify({ step: 'case-a', ...out }, null, 2));
    if (step === 'case-a') { await pg.end(); return; }
  }

  if (step === 'case-b' || step === 'all') {
    const payloadB = buildMetaPayload(CASE_B_WAMID, CASE_B_TEXT);
    out.case_b_payload_wamid = CASE_B_WAMID;
    const respB = await req('POST', '/staff/meta/whatsapp/webhook', payloadB);
    out.case_b_http = respB.status;
    out.case_b_response = respB.body;
    await new Promise((r) => setTimeout(r, 2000));
    const evB = await queryEvent(pg, CASE_B_WAMID);
    out.case_b_event = evB;
    const idemB = evB?.send_idempotency_key;
    out.case_b_sends = idemB ? await querySends(pg, idemB) : [];
    out.case_b_sent_rows = (await pg.query(
      `SELECT idempotency_key, status FROM guest_message_sends
        WHERE created_at >= $1::timestamptz AND to_phone = $2 AND status = 'sent'`,
      [PROOF_START, FROM],
    )).rows.filter((r) => String(r.idempotency_key || '').includes(CASE_B_WAMID));
    console.log(JSON.stringify({ step: 'case-b', ...out }, null, 2));
    if (step === 'case-b') { await pg.end(); return; }
  }

  await pg.end();

  if (step === 'revert' || step === 'all') {
    revertSafeRevision();
    out.restored_revision = await waitHealthy('stage19g11-revert-safe3');
    out.env_after = stagingEnvFlags();
    out.health_after = (await req('GET', '/healthz')).status;
    out.webhook_after = (await req('GET', '/staff/meta/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wolfhouse_verify_token&hub.challenge=auto123')).raw;
    console.log(JSON.stringify({ step: 'revert', ...out }, null, 2));
    if (step === 'revert') return;
  }

  // Final scoring
  const pg2 = await pgConnect();
  const safety = await safetyCounts(pg2);
  await pg2.end();

  const a = out.case_a_response || {};
  const aReplay = out.case_a_replay_response || {};
  const b = out.case_b_response || {};
  const evA = out.case_a_event || {};
  const evB = out.case_b_event || {};

  const checks = {
    case_a_draft: evA.draft_called === true && evA.next_action === 'ask_missing_field',
    case_a_send: evA.send_attempted === true && evA.send_status === 'sent',
    case_a_suggested: !!evA.suggested_reply,
    case_a_one_send_row: out.case_a_send_count === 1,
    case_a_replay_dup: aReplay.duplicate === true || aReplay.idempotent_replay === true,
    case_a_no_second_send: out.case_a_send_count_after_replay === 1,
    case_b_handoff: evB.next_action === 'handoff_to_staff' && evB.handoff_required === true,
    case_b_no_send: evB.send_attempted === false,
    case_b_no_sent_row: (out.case_b_sent_rows || []).length === 0,
    env_reverted: out.env_after?.WHATSAPP_DRY_RUN === 'true' && out.env_after?.LUNA_AUTO_SEND_ENABLED === '(unset)',
    no_extra_sent: safety.sent.length <= 1,
    no_bookings: safety.bookings.length === 0,
    no_payments: safety.payments.length === 0,
  };

  let result = 'PASS';
  if (Object.values(checks).some((v) => !v)) result = 'PARTIAL';
  if ((out.case_a_send_count_after_replay || 0) > 1) result = 'FAIL';
  if ((out.case_b_sent_rows || []).length > 0) result = 'FAIL';
  if (safety.bookings.length || safety.payments.length) result = 'FAIL';
  if (!checks.env_reverted) result = 'FAIL';

  console.log(JSON.stringify({
    phase: '19g.11-final',
    result,
    proof_revision: out.proof_revision,
    restored_revision: out.restored_revision,
    env_before: out.env_before,
    env_during: out.env_during,
    env_after: out.env_after,
    case_a_wamid: CASE_A_WAMID,
    case_a_luna_reply: evA.suggested_reply,
    case_a_whatsapp_message_id: (out.case_a_sends?.find((r) => r.status === 'sent')?.provider_message_id) || a.send_result?.whatsapp_message_id,
    case_a_replay: {
      duplicate: aReplay.duplicate,
      idempotent_replay: aReplay.idempotent_replay,
      send_count_before: out.case_a_send_count,
      send_count_after: out.case_a_send_count_after_replay,
    },
    case_b: {
      wamid: CASE_B_WAMID,
      next_action: evB.next_action,
      handoff_required: evB.handoff_required,
      send_attempted: evB.send_attempted,
    },
    checks,
    safety,
    caveat: 'Case A/B triggered via Meta-shaped POST to Staff API webhook (same handler path as live Meta delivery). Confirm WhatsApp delivery on +491726422307 manually.',
  }, null, 2));
})().catch((e) => {
  console.error('ERR', e.message);
  try { revertSafeRevision(); } catch { /* best effort */ }
  process.exit(1);
});
