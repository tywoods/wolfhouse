'use strict';
/** Phase 22d — backfill booking_write_result via idempotent replay. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = '3c81670';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:3c81670-stage22d-write-result';
const PROOF_SUFFIX = 'stage22d-write-result-persist';
const REVERT_SUFFIX = 'stage22d-write-result-safe';
const WA_ID = 'wamid.phase22b.complete.oct.001';
const IDEM = `luna-booking:${CLIENT}:${WA_ID}:v1`;
const EXP_BOOKING_ID = '946cc3ba-70e9-4f9f-a6b8-140ca3d22a79';
const EXP_BOOKING_CODE = 'MB-WOLFHO-20261006-5dbf98';
const EXP_PAYMENT_ID = 'd0bb5fa9-7ecc-43b2-b0d9-181b5687ae0a';
const PROOF_START = new Date().toISOString();

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
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
    WHATSAPP_LIVE_SENDS_ENABLED: pick('WHATSAPP_LIVE_SENDS_ENABLED'),
    LUNA_GUEST_LIVE_SEND_OWNER_APPROVED: pick('LUNA_GUEST_LIVE_SEND_OWNER_APPROVED'),
    WHATSAPP_CLOUD_ACCESS_TOKEN: pick('WHATSAPP_CLOUD_ACCESS_TOKEN'),
    WHATSAPP_PHONE_NUMBER_ID: pick('WHATSAPP_PHONE_NUMBER_ID'),
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

async function loadEventState(pg) {
  const r = await pg.query(
    `SELECT wa_message_id, normalized FROM guest_message_events WHERE client_slug = $1 AND wa_message_id = $2`,
    [CLIENT, WA_ID],
  );
  if (!r.rows.length) return null;
  const norm = typeof r.rows[0].normalized === 'string' ? JSON.parse(r.rows[0].normalized) : r.rows[0].normalized;
  return {
    preview: norm && norm.booking_write_preview,
    result: norm && norm.booking_write_result,
    normalized_keys: norm ? Object.keys(norm) : [],
    normalized: norm,
  };
}

async function dbProof(pg) {
  const bk = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.confirmation_sent_at,
           b.metadata->>'idempotency_key' AS idempotency_key, b.created_at
      FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.metadata->>'idempotency_key' = $2
     ORDER BY b.created_at DESC`, [CLIENT, IDEM]);

  const bookingIds = bk.rows.map((x) => x.booking_id);
  let beds = { rows: [] };
  let pays = { rows: [] };
  if (bookingIds.length) {
    beds = await pg.query(
      'SELECT id::text, bed_code FROM booking_beds WHERE booking_id = ANY($1::uuid[])',
      [bookingIds],
    );
    pays = await pg.query(`
      SELECT p.id::text AS payment_id, p.status::text, p.checkout_url, p.stripe_checkout_session_id, p.created_at
        FROM payments p WHERE p.booking_id = ANY($1::uuid[]) ORDER BY p.created_at`, [bookingIds]);
  }

  const sent = await pg.query(`
    SELECT idempotency_key, status, provider_message_id, created_at
      FROM guest_message_sends
     WHERE client_slug = $1 AND created_at >= $2::timestamptz AND status = 'sent'`, [CLIENT, PROOF_START]);

  const evt = await loadEventState(pg);
  return {
    booking_count: bk.rows.length,
    bookings: bk.rows,
    booking_beds_count: beds.rows.length,
    booking_beds: beds.rows,
    payment_count: pays.rows.length,
    payments: pays.rows,
    guest_message_sends_sent: sent.rows,
    event: evt,
  };
}

function buildReplayPayload(previewPayload) {
  return {
    ...previewPayload,
    confirm: true,
    idempotency_key: IDEM,
    source_wa_message_id: WA_ID,
    client_slug: CLIENT,
    source: previewPayload.source || 'meta_whatsapp_inbound_preview',
    reason: 'Phase 22d booking_write_result backfill replay',
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

function deployProofRevision() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${PROOF_SUFFIX}`,
    '--set-env-vars',
    'BOT_BOOKING_ENABLED=true',
    'WHATSAPP_DRY_RUN=true',
    'STRIPE_LINKS_ENABLED=false',
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
    '--set-env-vars WHATSAPP_DRY_RUN=true STRIPE_LINKS_ENABLED=false',
    '--remove-env-vars BOT_BOOKING_ENABLED LUNA_AUTO_SEND_ENABLED WHATSAPP_LIVE_SENDS_ENABLED LUNA_GUEST_LIVE_SEND_OWNER_APPROVED WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID',
  ].join(' '));
}

function summarizeCreate(body) {
  const co = body.create_outcome && body.create_outcome.create_response;
  const persist = body.booking_write_result_persistence;
  return {
    success: body.success,
    write_performed: body.write_performed,
    idempotent_replay: body.idempotent_replay,
    duplicate: body.duplicate || (co && co.duplicate),
    idempotent: body.idempotent || (co && co.idempotent),
    booking_id: body.booking_id || (co && co.booking_id),
    booking_code: body.booking_code || (co && co.booking_code),
    payment_id: body.payment_id || (co && co.payment_id),
    creates_stripe_link: body.creates_stripe_link,
    sends_whatsapp: body.sends_whatsapp,
    calls_n8n: body.calls_n8n,
    checkout_url: co && co.checkout_url,
    persistence: persist ? {
      persisted: persist.persisted,
      wa_message_id: persist.wa_message_id,
      booking_write_result: persist.booking_write_result,
    } : null,
  };
}

function validateWriteResult(result) {
  const errs = [];
  if (!result) { errs.push('missing'); return errs; }
  if (result.created !== true) errs.push('created');
  if (result.booking_id !== EXP_BOOKING_ID) errs.push('booking_id');
  if (result.booking_code !== EXP_BOOKING_CODE) errs.push('booking_code');
  if (result.payment_id !== EXP_PAYMENT_ID) errs.push('payment_id');
  if (result.idempotency_key !== IDEM) errs.push('idempotency_key');
  if (result.idempotent_replay !== true) errs.push('idempotent_replay');
  if (result.creates_stripe_link !== false) errs.push('creates_stripe_link');
  if (result.sends_whatsapp !== false) errs.push('sends_whatsapp');
  return errs;
}

function criticalIssues(db, createSum) {
  const issues = [];
  if (db.booking_count > 1) issues.push('duplicate_bookings');
  if (db.payment_count > 1) issues.push('duplicate_payments');
  if (db.booking_beds_count !== 2) issues.push(`booking_beds_count_${db.booking_beds_count}`);
  if (createSum.checkout_url) issues.push('stripe_checkout_url_in_response');
  for (const p of db.payments) {
    if (p.checkout_url || p.stripe_checkout_session_id) issues.push('stripe_link_in_db');
  }
  if (db.guest_message_sends_sent.length) issues.push('whatsapp_sent');
  for (const b of db.bookings) {
    if (b.confirmation_sent_at) issues.push('confirmation_sent_at_set');
  }
  return issues;
}

(async () => {
  const envBefore = stagingEnvFlags();
  const revBefore = activeRevision();
  const healthBefore = await req('GET', '/healthz');

  const pg0 = await pgConnect();
  const beforeEvt = await loadEventState(pg0);
  const dbBefore = await dbProof(pg0);
  await pg0.end();

  const preErrs = [];
  if (envBefore.BOT_BOOKING_ENABLED !== '(unset)') preErrs.push('BOT_BOOKING_ENABLED not unset');
  if (envBefore.STRIPE_LINKS_ENABLED !== 'false') preErrs.push('STRIPE_LINKS_ENABLED');
  if (envBefore.WHATSAPP_DRY_RUN !== 'true') preErrs.push('WHATSAPP_DRY_RUN');
  if (healthBefore.status !== 200) preErrs.push('healthz');
  if (!beforeEvt || !beforeEvt.preview || beforeEvt.preview.eligible !== true) preErrs.push('preview missing/not eligible');
  if (beforeEvt && beforeEvt.result) preErrs.push('booking_write_result already present before proof');
  const pp = beforeEvt && beforeEvt.preview && beforeEvt.preview.booking_create_payload_preview;
  if (!pp) preErrs.push('booking_create_payload_preview missing');
  if (dbBefore.booking_count !== 1) preErrs.push(`booking_count ${dbBefore.booking_count} expected 1`);
  if (dbBefore.bookings[0] && dbBefore.bookings[0].booking_id !== EXP_BOOKING_ID) preErrs.push('booking_id mismatch');
  if (dbBefore.payment_count !== 1) preErrs.push(`payment_count ${dbBefore.payment_count}`);
  if (dbBefore.booking_beds_count !== 2) preErrs.push(`bed_count ${dbBefore.booking_beds_count}`);

  if (preErrs.length) {
    console.log(JSON.stringify({ phase: '22d', result: 'FAIL', stage: 'pre-check', errors: preErrs, env_before: envBefore, db_before: dbBefore, event_before: beforeEvt }, null, 2));
    process.exit(1);
  }

  deployProofRevision();
  const proofRev = await waitHealthy(PROOF_SUFFIX);
  const envDuring = stagingEnvFlags();
  const healthDuring = await req('GET', '/healthz');
  const token = getToken();
  const botHeaders = { 'X-Luna-Bot-Token': token };
  const createPayload = buildReplayPayload(pp);

  const stepA = await req('POST', '/staff/bot/booking-create-from-plan', createPayload, botHeaders);
  const createA = summarizeCreate(stepA.body || {});

  const pg1 = await pgConnect();
  const dbAfterA = await dbProof(pg1);
  await pg1.end();

  const stepB = await req('POST', '/staff/bot/booking-create-from-plan', createPayload, botHeaders);
  const createB = summarizeCreate(stepB.body || {});

  const pg2 = await pgConnect();
  const dbAfterB = await dbProof(pg2);
  await pg2.end();

  revertSafeRevision();
  const restoredRev = await waitHealthy(REVERT_SUFFIX);
  const envAfter = stagingEnvFlags();
  const healthAfter = await req('GET', '/healthz');

  const stepAErrs = [];
  if (stepA.status !== 200) stepAErrs.push(`http ${stepA.status}`);
  if (createA.success !== true) stepAErrs.push('success');
  if (!(createA.idempotent_replay === true || createA.duplicate === true || createA.idempotent === true)) {
    stepAErrs.push('idempotent replay flags');
  }
  if (createA.write_performed === true) stepAErrs.push('write_performed should be false on replay');
  if (createA.booking_id !== EXP_BOOKING_ID) stepAErrs.push('booking_id');
  if (createA.booking_code !== EXP_BOOKING_CODE) stepAErrs.push('booking_code');
  if (createA.payment_id !== EXP_PAYMENT_ID) stepAErrs.push('payment_id');
  if (createA.creates_stripe_link !== false) stepAErrs.push('creates_stripe_link');
  if (createA.sends_whatsapp !== false) stepAErrs.push('sends_whatsapp');
  if (createA.checkout_url) stepAErrs.push('checkout_url');
  if (!createA.persistence || createA.persistence.persisted !== true) stepAErrs.push('persistence not persisted');

  const resultAErrs = validateWriteResult(dbAfterA.event && dbAfterA.event.result);
  const previewStillA = !!(dbAfterA.event && dbAfterA.event.preview);
  if (!previewStillA) stepAErrs.push('preview removed');
  if (resultAErrs.length) stepAErrs.push(...resultAErrs.map((e) => `result.${e}`));

  const stepBErrs = [];
  if (stepB.status !== 200) stepBErrs.push(`http ${stepB.status}`);
  if (!(createB.idempotent_replay === true || createB.duplicate === true || createB.idempotent === true)) {
    stepBErrs.push('idempotent replay flags');
  }
  if (createB.booking_id !== EXP_BOOKING_ID) stepBErrs.push('booking_id');
  const resultBErrs = validateWriteResult(dbAfterB.event && dbAfterB.event.result);
  if (resultBErrs.length) stepBErrs.push(...resultBErrs.map((e) => `result.${e}`));
  const rA = dbAfterA.event && dbAfterA.event.result;
  const rB = dbAfterB.event && dbAfterB.event.result;
  if (rA && rB && JSON.stringify(rA) !== JSON.stringify(rB)) stepBErrs.push('result changed on second replay');

  const dbErrs = [];
  if (dbAfterB.booking_count !== 1) dbErrs.push(`booking_count ${dbAfterB.booking_count}`);
  if (dbAfterB.payment_count !== 1) dbErrs.push(`payment_count ${dbAfterB.payment_count}`);
  if (dbAfterB.booking_beds_count !== 2) dbErrs.push(`booking_beds_count ${dbAfterB.booking_beds_count}`);

  const revertErrs = [];
  if (envAfter.BOT_BOOKING_ENABLED !== '(unset)') revertErrs.push('BOT_BOOKING_ENABLED not reverted');
  if (envAfter.STRIPE_LINKS_ENABLED !== 'false') revertErrs.push('STRIPE_LINKS_ENABLED');
  if (envAfter.WHATSAPP_DRY_RUN !== 'true') revertErrs.push('WHATSAPP_DRY_RUN');
  if (healthAfter.status !== 200) revertErrs.push('healthz after revert');

  const critical = criticalIssues(dbAfterB, createA);
  let result = 'PASS';
  if (critical.length) result = 'FAIL';
  else if ([...stepAErrs, ...stepBErrs, ...dbErrs, ...revertErrs].length) result = 'PARTIAL';

  console.log(JSON.stringify({
    phase: '22d',
    result,
    commit: COMMIT,
    proof_start: PROOF_START,
    checked_at: new Date().toISOString(),
    image: IMAGE,
    revision_before: revBefore,
    proof_revision: proofRev,
    restored_revision: restoredRev,
    env_before: envBefore,
    env_during: envDuring,
    env_after: envAfter,
    health: { before: healthBefore.status, during: healthDuring.status, after: healthAfter.status },
    guest_message_events_before: {
      has_preview: !!(beforeEvt && beforeEvt.preview),
      preview_eligible: beforeEvt && beforeEvt.preview && beforeEvt.preview.eligible,
      has_result: !!(beforeEvt && beforeEvt.result),
      normalized_keys: beforeEvt && beforeEvt.normalized_keys,
    },
    guest_message_events_after: {
      has_preview: !!(dbAfterB.event && dbAfterB.event.preview),
      has_result: !!(dbAfterB.event && dbAfterB.event.result),
      booking_write_result: dbAfterB.event && dbAfterB.event.result,
      normalized_keys: dbAfterB.event && dbAfterB.event.normalized_keys,
    },
    step_a_replay: { status: stepA.status, summary: createA, errors: stepAErrs, body: stepA.body },
    step_b_replay: { status: stepB.status, summary: createB, errors: stepBErrs, body: stepB.body },
    db_before: dbBefore,
    db_after_a: dbAfterA,
    db_after_b: dbAfterB,
    db_errors: dbErrs,
    critical_issues: critical,
    revert_errors: revertErrs,
    recommended_next: result === 'PASS'
      ? ['Phase 22e closeout doc — inbound Meta → preview → write → result persistence chain', 'Optional: deposit Stripe link from inbound thread when STRIPE_LINKS_ENABLED=true']
      : ['Fix persistence gaps before closeout'],
  }, null, 2));
})().catch((e) => {
  console.error(e);
  try { revertSafeRevision(); } catch (_) { /* best effort */ }
  process.exit(1);
});
