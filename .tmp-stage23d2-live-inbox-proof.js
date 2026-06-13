'use strict';
/** Phase 23d.2 — one live staff inbox send. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const {
  buildStaffReplyIdempotencyKey,
} = require('./scripts/lib/luna-staff-inbox-send-reply');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:6663302-stage23d1-inbox-send';
const PROOF_SUFFIX = 'stage23d2-live-inbox-send';
const REVERT_SUFFIX = 'stage23d2-revert-safe';
const TEST_TO = '+491726422307';
const LIVE_MSG = 'Staging live staff reply proof — please ignore.';
const PROOF_CONV_ID = 'a23d2001-23d2-423d-823d-491726422307';
const PROOF_START = new Date().toISOString();
const LOGIN = {
  client: CLIENT,
  email: 'operator.stage72c@example.test',
  password: 'OperatorPass123!',
};

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
    BOT_BOOKING_ENABLED: pick('BOT_BOOKING_ENABLED'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    WHATSAPP_CLOUD_ACCESS_TOKEN: pick('WHATSAPP_CLOUD_ACCESS_TOKEN'),
    WHATSAPP_PHONE_NUMBER_ID: pick('WHATSAPP_PHONE_NUMBER_ID'),
    WHATSAPP_LIVE_SENDS_ENABLED: pick('WHATSAPP_LIVE_SENDS_ENABLED'),
  };
}

function isEnvSafe(flags) {
  return flags.WHATSAPP_DRY_RUN === 'true'
    && flags.STRIPE_LINKS_ENABLED === 'false'
    && flags.LUNA_AUTO_SEND_ENABLED === '(unset)'
    && flags.BOT_BOOKING_ENABLED === '(unset)'
    && flags.WHATSAPP_CLOUD_ACCESS_TOKEN === '(unset)'
    && flags.WHATSAPP_PHONE_NUMBER_ID === '(unset)';
}

async function waitHealthy(suffix, timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rev = activeRevision();
    if (rev.health === 'Healthy' && rev.traffic === 100 && String(rev.name || '').includes(suffix)) {
      return rev;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return activeRevision();
}

function enableLiveRevision() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${PROOF_SUFFIX}`,
    '--set-env-vars',
    'WHATSAPP_DRY_RUN=false',
    'STRIPE_LINKS_ENABLED=false',
    'MANUAL_BOOKING_ENABLED=true',
    'WHATSAPP_LIVE_SENDS_ENABLED=true',
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
    `--revision-suffix ${REVERT_SUFFIX}`,
    '--set-env-vars WHATSAPP_DRY_RUN=true STRIPE_LINKS_ENABLED=false MANUAL_BOOKING_ENABLED=true',
    '--remove-env-vars LUNA_AUTO_SEND_ENABLED BOT_BOOKING_ENABLED WHATSAPP_LIVE_SENDS_ENABLED LUNA_GUEST_LIVE_SEND_OWNER_APPROVED WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID',
  ].join(' '));
}

async function staffLogin() {
  const login = await req('POST', '/staff/auth/login', LOGIN);
  if (login.status !== 200 || !login.body || !login.body.success) {
    throw new Error(`login failed HTTP ${login.status}`);
  }
  return (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
}

async function pgConnect() {
  const url = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

async function findTestConversation(pg) {
  const r = await pg.query(
    `SELECT conv.id::text AS conversation_id, conv.phone
       FROM conversations conv
      INNER JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = $1
        AND REPLACE(COALESCE(conv.phone, ''), '+', '') LIKE '%491726422307%'
      LIMIT 1`,
    [CLIENT],
  );
  return r.rows[0] || null;
}

function normalizeDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

(async () => {
  const out = {
    phase: '23d.2-hosted-live',
    proof_start: PROOF_START,
    test_recipient: TEST_TO,
    result: 'PENDING',
    reverted: false,
  };
  let reverted = false;

  const doRevert = async (reason) => {
    if (reverted) return;
    try {
      console.error('Reverting env...', reason || '');
      revertSafeRevision();
      out.restored_revision = await waitHealthy(REVERT_SUFFIX);
      out.env_after = stagingEnvFlags();
      out.health_after_revert = (await req('GET', '/healthz')).status;
      out.reverted = true;
      reverted = true;
    } catch (e) {
      out.revert_error = e.message;
    }
  };

  try {
    const kv = JSON.parse(az('az keyvault secret list --vault-name wh-staging-kv --query "[?name==\'meta-whatsapp-token\' || name==\'meta-whatsapp-phone-id\'].name" -o json'));
    out.kv_secrets_present = kv.includes('meta-whatsapp-token') && kv.includes('meta-whatsapp-phone-id');

    out.revision_before = activeRevision();
    out.env_before = stagingEnvFlags();
    out.health_before = (await req('GET', '/healthz')).status;

    if (!String(out.revision_before.image || '').includes('6663302')) {
      throw new Error('active revision not on 6663302+: ' + out.revision_before.image);
    }
    if (out.health_before !== 200) throw new Error('healthz not 200 before proof');
    if (!isEnvSafe(out.env_before)) throw new Error('env not safe before proof: ' + JSON.stringify(out.env_before));
    if (!out.kv_secrets_present) throw new Error('KV WhatsApp secrets missing');

    enableLiveRevision();
    out.proof_revision = await waitHealthy(PROOF_SUFFIX);
    out.env_during = stagingEnvFlags();
    out.health_during = (await req('GET', '/healthz')).status;

    if (out.env_during.WHATSAPP_DRY_RUN !== 'false') throw new Error('WHATSAPP_DRY_RUN not false during proof');
    if (!String(out.env_during.WHATSAPP_CLOUD_ACCESS_TOKEN).includes('meta-whatsapp-token')) {
      throw new Error('token secretRef not set during proof');
    }

    const pg0 = await pgConnect();
    const foundConv = await findTestConversation(pg0);
    await pg0.end();

    const convId = foundConv ? foundConv.conversation_id : PROOF_CONV_ID;
    out.conversation_strategy = foundConv ? 'db_match' : 'explicit_to_with_proof_conv_id';
    out.conversation_id_used = convId;

    const idemKey = buildStaffReplyIdempotencyKey(CLIENT, convId, LIVE_MSG);
    out.idempotency_key = idemKey;

    const sendBody = {
      client_slug: CLIENT,
      conversation_id: convId,
      to: TEST_TO,
      message_text: LIVE_MSG,
      idempotency_key: idemKey,
    };

    const cookie = await staffLogin();
    const stepA = await req('POST', '/staff/inbox/send-reply', sendBody, cookie);
    out.step_a = {
      http: stepA.status,
      success: stepA.body && stepA.body.success,
      send_kind: stepA.body && stepA.body.send_kind,
      send_performed: stepA.body && stepA.body.send_performed,
      sends_whatsapp: stepA.body && stepA.body.sends_whatsapp,
      provider_message_id: stepA.body && stepA.body.whatsapp_message_id,
      to: stepA.body && stepA.body.to,
      blocked_reasons: stepA.body && stepA.body.blocked_reasons,
      guest_message_send_status: stepA.body && stepA.body.guest_message_send_status,
    };

    const providerIdA = stepA.body && stepA.body.whatsapp_message_id;

    await new Promise((r) => setTimeout(r, 1500));
    const stepB = await req('POST', '/staff/inbox/send-reply', sendBody, cookie);
    out.step_b = {
      http: stepB.status,
      duplicate: stepB.body && stepB.body.duplicate,
      idempotent_replay: stepB.body && stepB.body.idempotent_replay,
      send_performed: stepB.body && stepB.body.send_performed,
      sends_whatsapp: stepB.body && stepB.body.sends_whatsapp,
      provider_message_id: stepB.body && stepB.body.whatsapp_message_id,
      guest_message_send_status: stepB.body && stepB.body.guest_message_send_status,
    };

    const pg = await pgConnect();
    const sends = await pg.query(
      `SELECT id::text, send_kind, status, idempotency_key, to_phone, blocked_reasons,
              provider_message_id, created_at, sent_at
         FROM guest_message_sends
        WHERE client_slug = $1 AND idempotency_key = $2`,
      [CLIENT, idemKey],
    );
    const sentSince = await pg.query(
      `SELECT id::text, to_phone, provider_message_id, idempotency_key
         FROM guest_message_sends
        WHERE client_slug = $1 AND status = 'sent' AND created_at >= $2::timestamptz
        ORDER BY created_at DESC`,
      [CLIENT, PROOF_START],
    );
    const bookings = await pg.query('SELECT COUNT(*)::int AS n FROM bookings WHERE created_at >= $1::timestamptz', [PROOF_START]);
    const payments = await pg.query('SELECT COUNT(*)::int AS n FROM payments WHERE created_at >= $1::timestamptz', [PROOF_START]);
    const handoffs = await pg.query('SELECT COUNT(*)::int AS n FROM staff_handoffs WHERE created_at >= $1::timestamptz', [PROOF_START]);
    await pg.end();

    out.guest_message_sends = {
      rows_for_key: sends.rows,
      row_count_for_key: sends.rows.length,
      sent_since_proof: sentSince.rows,
      sent_count_since_proof: sentSince.rows.length,
    };

    out.safety = {
      bookings_created: bookings.rows[0].n,
      payments_created: payments.rows[0].n,
      staff_handoffs_created: handoffs.rows[0].n,
    };

    const toOk = normalizeDigits(out.step_a.to || sends.rows[0]?.to_phone) === normalizeDigits(TEST_TO);
    out.test_recipient_verified = toOk;

    const stepAPass = stepA.status === 200
      && out.step_a.success === true
      && out.step_a.send_kind === 'staff_reply'
      && out.step_a.send_performed === true
      && out.step_a.sends_whatsapp === true
      && !!providerIdA
      && toOk;

    const stepBPass = stepB.status === 200
      && out.step_b.duplicate === true
      && out.step_b.idempotent_replay === true
      && out.step_b.send_performed === false
      && out.step_b.sends_whatsapp === false
      && out.step_b.provider_message_id === providerIdA
      && sends.rows.length === 1
      && sentSince.rows.length === 1;

    const safetyPass = out.safety.bookings_created === 0 && out.safety.payments_created === 0
      && out.safety.staff_handoffs_created === 0 && sentSince.rows.length <= 1;

    if (stepAPass && stepBPass && safetyPass) out.result = 'PASS';
    else if (stepAPass && safetyPass) out.result = 'PARTIAL';
    else out.result = 'FAIL';

    out.checks = { stepAPass, stepBPass, safetyPass, toOk };
  } catch (err) {
    out.result = 'FAIL';
    out.error = err.message;
  } finally {
    await doRevert('finally');
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'PASS' ? 0 : 1);
})();
