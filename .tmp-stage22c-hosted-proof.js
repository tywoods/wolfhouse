'use strict';
/** Phase 22c — inbound preview → booking write staging proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:bf05031-stage22b-booking-preview';
const PROOF_SUFFIX = 'stage22c-booking-write-proof';
const REVERT_SUFFIX = 'stage22c-booking-write-safe';
const WA_ID = 'wamid.phase22b.complete.oct.001';
const IDEM = `luna-booking:${CLIENT}:${WA_ID}:v1`;
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

async function loadPersistedPreview(pg) {
  const r = await pg.query(
    `SELECT wa_message_id, from_phone, profile_name, normalized
       FROM guest_message_events
      WHERE client_slug = $1 AND wa_message_id = $2`,
    [CLIENT, WA_ID],
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const norm = typeof row.normalized === 'string' ? JSON.parse(row.normalized) : row.normalized;
  return { row, norm, preview: norm && norm.booking_write_preview };
}

async function dbProof(pg, bookingId) {
  const bk = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.phone,
           b.check_in::text, b.check_out::text, b.guest_count,
           b.status::text AS status, b.payment_status::text AS payment_status,
           b.confirmation_sent_at,
           b.metadata->>'idempotency_key' AS idempotency_key,
           b.metadata->>'source' AS source,
           b.created_at
      FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.metadata->>'idempotency_key' = $2
     ORDER BY b.created_at DESC`, [CLIENT, IDEM]);

  const bookingIds = bk.rows.map((x) => x.booking_id);
  let beds = { rows: [] };
  let pays = { rows: [] };
  if (bookingIds.length) {
    beds = await pg.query(`
      SELECT bb.id::text AS booking_bed_id, bb.booking_id::text, bb.bed_code, bb.room_code,
             bb.assignment_start_date::text, bb.assignment_end_date::text
        FROM booking_beds bb WHERE bb.booking_id = ANY($1::uuid[])`, [bookingIds]);
    pays = await pg.query(`
      SELECT p.id::text AS payment_id, p.status::text, p.payment_kind::text,
             p.amount_due_cents, p.amount_paid_cents, p.checkout_url,
             p.stripe_checkout_session_id, p.booking_id::text, p.created_at
        FROM payments p WHERE p.booking_id = ANY($1::uuid[]) ORDER BY p.created_at`, [bookingIds]);
  }

  const sent = await pg.query(`
    SELECT idempotency_key, status, provider_message_id, created_at
      FROM guest_message_sends
     WHERE client_slug = $1 AND created_at >= $2::timestamptz AND status = 'sent'`, [CLIENT, PROOF_START]);

  const evt = await pg.query(
    `SELECT normalized FROM guest_message_events WHERE client_slug = $1 AND wa_message_id = $2`,
    [CLIENT, WA_ID],
  );
  const norm = evt.rows[0] && evt.rows[0].normalized;
  const parsedNorm = typeof norm === 'string' ? JSON.parse(norm) : norm;

  return {
    booking_count: bk.rows.length,
    bookings: bk.rows,
    booking_beds_count: beds.rows.length,
    booking_beds: beds.rows,
    payment_count: pays.rows.length,
    payments: pays.rows,
    guest_message_sends_sent: sent.rows,
    guest_message_event_has_write_result: !!(parsedNorm && parsedNorm.booking_write_result),
    guest_message_event_normalized_keys: parsedNorm ? Object.keys(parsedNorm) : [],
  };
}

function buildCreatePayload(previewPayload) {
  return {
    ...previewPayload,
    confirm: true,
    idempotency_key: IDEM,
    source: previewPayload.source || 'meta_whatsapp_inbound_preview',
    reason: 'Phase 22c inbound preview write proof',
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
  return {
    success: body.success,
    write_performed: body.write_performed,
    idempotent_replay: body.idempotent_replay,
    duplicate: body.duplicate || (co && co.duplicate),
    idempotent: body.idempotent || (co && co.idempotent),
    booking_id: body.booking_id || (co && co.booking_id),
    booking_code: body.booking_code || (co && co.booking_code),
    payment_id: body.payment_id || (co && co.payment_id),
    payment_status: co && co.payment_status,
    amount_due_cents: co && co.amount_due_cents,
    creates_stripe_link: body.creates_stripe_link,
    sends_whatsapp: body.sends_whatsapp,
    calls_n8n: body.calls_n8n,
    blocked_reasons: body.blocked_reasons || [],
    checkout_url: co && co.checkout_url,
    no_stripe: co && co.no_stripe,
  };
}

function pickEligibility(body) {
  const e = body.eligibility || {};
  return {
    write_ready: body.write_ready ?? e.write_ready,
    blocked_reasons: body.blocked_reasons || e.blocked_reasons || [],
    required_approvals: body.required_approvals || e.required_approvals || [],
    would_call: body.would_call || e.would_call || [],
    write_performed: body.write_performed,
  };
}

function criticalIssues(db, createSum) {
  const issues = [];
  if (db.booking_count > 1) issues.push('duplicate_bookings');
  if (db.payment_count > 1) issues.push('duplicate_payments');
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
  const persisted = await loadPersistedPreview(pg0);
  const dbBefore = await dbProof(pg0, null);
  await pg0.end();

  const preErrs = [];
  if (envBefore.BOT_BOOKING_ENABLED !== '(unset)') preErrs.push('BOT_BOOKING_ENABLED not unset before proof');
  if (envBefore.STRIPE_LINKS_ENABLED !== 'false') preErrs.push('STRIPE_LINKS_ENABLED');
  if (envBefore.WHATSAPP_DRY_RUN !== 'true') preErrs.push('WHATSAPP_DRY_RUN');
  if (healthBefore.status !== 200) preErrs.push('healthz');
  if (!persisted || !persisted.preview || persisted.preview.eligible !== true) preErrs.push('persisted preview missing or not eligible');
  const pp = persisted && persisted.preview && persisted.preview.booking_create_payload_preview;
  if (!pp) preErrs.push('booking_create_payload_preview missing');
  else {
    if (pp.check_in !== '2026-10-06' || pp.check_out !== '2026-10-09') preErrs.push('preview dates');
    if (pp.guest_count !== 2 || pp.package_code !== 'malibu' || pp.payment_choice !== 'deposit') preErrs.push('preview fields');
    if (pp.confirm !== false) preErrs.push('preview confirm should be false');
  }
  if (persisted && persisted.preview && persisted.preview.idempotency_key_preview !== IDEM) preErrs.push('idempotency_key_preview');
  if (dbBefore.booking_count > 0) preErrs.push('booking already exists for idempotency key');

  if (preErrs.length) {
    console.log(JSON.stringify({ phase: '22c', result: 'FAIL', stage: 'pre-check', errors: preErrs, env_before: envBefore, persisted_preview: persisted && persisted.preview }, null, 2));
    process.exit(1);
  }

  enableProofRevision();
  const proofRev = await waitHealthy(PROOF_SUFFIX);
  const envDuring = stagingEnvFlags();
  const healthDuring = await req('GET', '/healthz');
  const token = getToken();
  const botHeaders = { 'X-Luna-Bot-Token': token };

  const createPayload = buildCreatePayload(pp);

  const stepA = await req('POST', '/staff/bot/booking-write-eligibility', createPayload, botHeaders);
  const eligA = pickEligibility(stepA.body || {});

  const stepB = await req('POST', '/staff/bot/booking-create-from-plan', createPayload, botHeaders);
  const createB = summarizeCreate(stepB.body || {});

  const pg1 = await pgConnect();
  const dbAfterB = await dbProof(pg1, createB.booking_id);
  await pg1.end();

  const stepC = await req('POST', '/staff/bot/booking-create-from-plan', createPayload, botHeaders);
  const createC = summarizeCreate(stepC.body || {});

  const pg2 = await pgConnect();
  const dbAfterC = await dbProof(pg2, createC.booking_id);
  await pg2.end();

  revertSafeRevision();
  const restoredRev = await waitHealthy(REVERT_SUFFIX);
  const envAfter = stagingEnvFlags();
  const healthAfter = await req('GET', '/healthz');

  const stepAErrs = [];
  if (stepA.status !== 200) stepAErrs.push(`http ${stepA.status}`);
  if (eligA.write_ready !== true) stepAErrs.push('write_ready not true');
  if (!eligA.would_call.includes('POST /staff/bot/bookings/create')) stepAErrs.push('would_call');
  if (eligA.write_performed === true) stepAErrs.push('write_performed on eligibility');

  const stepBErrs = [];
  if (![200, 201].includes(stepB.status)) stepBErrs.push(`http ${stepB.status}`);
  if (createB.success !== true) stepBErrs.push('success');
  if (createB.write_performed !== true && !createB.booking_id) stepBErrs.push('write_performed/booking_id');
  if (!createB.booking_code) stepBErrs.push('booking_code');
  if (!createB.payment_id) stepBErrs.push('payment_id');
  if (createB.creates_stripe_link !== false) stepBErrs.push('creates_stripe_link');
  if (createB.sends_whatsapp !== false) stepBErrs.push('sends_whatsapp');
  if (createB.checkout_url) stepBErrs.push('checkout_url');

  const stepCErrs = [];
  if (![200, 201].includes(stepC.status)) stepCErrs.push(`http ${stepC.status}`);
  if (!(createC.idempotent_replay === true || createC.duplicate === true || createC.idempotent === true)) {
    stepCErrs.push('idempotent replay flags');
  }
  if (createB.booking_id && createC.booking_id && createB.booking_id !== createC.booking_id) {
    stepCErrs.push('booking_id mismatch on replay');
  }

  const dbErrs = [];
  if (dbAfterC.booking_count !== 1) dbErrs.push(`booking_count ${dbAfterC.booking_count}`);
  if (dbAfterC.payment_count !== 1) dbErrs.push(`payment_count ${dbAfterC.payment_count}`);
  if (dbAfterC.booking_beds_count < 2) dbErrs.push(`booking_beds_count ${dbAfterC.booking_beds_count}`);
  const b0 = dbAfterC.bookings[0];
  if (b0) {
    if (b0.check_in !== '2026-10-06' || b0.check_out !== '2026-10-09') dbErrs.push('booking dates');
    if (Number(b0.guest_count) !== 2) dbErrs.push('guest_count');
    if (b0.phone !== '491726422307') dbErrs.push('phone');
  }
  const p0 = dbAfterC.payments[0];
  if (p0) {
    if (p0.checkout_url || p0.stripe_checkout_session_id) dbErrs.push('stripe fields on payment');
    if (Number(p0.amount_paid_cents) !== 0) dbErrs.push('amount_paid_cents');
  }

  const revertErrs = [];
  if (envAfter.BOT_BOOKING_ENABLED !== '(unset)') revertErrs.push('BOT_BOOKING_ENABLED not reverted');
  if (envAfter.STRIPE_LINKS_ENABLED !== 'false') revertErrs.push('STRIPE_LINKS_ENABLED');
  if (envAfter.WHATSAPP_DRY_RUN !== 'true') revertErrs.push('WHATSAPP_DRY_RUN');
  if (healthAfter.status !== 200) revertErrs.push('healthz after revert');

  const critical = criticalIssues(dbAfterC, createB);
  let result = 'PASS';
  if (critical.length) result = 'FAIL';
  else if ([...stepAErrs, ...stepBErrs, ...stepCErrs, ...dbErrs, ...revertErrs].length) result = 'PARTIAL';

  console.log(JSON.stringify({
    phase: '22c',
    result,
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
    persisted_preview: {
      wa_message_id: WA_ID,
      idempotency_key_preview: persisted.preview.idempotency_key_preview,
      payload_preview: pp,
    },
    step_a_eligibility: { status: stepA.status, summary: eligA, body: stepA.body, errors: stepAErrs },
    step_b_create: { status: stepB.status, summary: createB, body: stepB.body, errors: stepBErrs },
    step_c_replay: { status: stepC.status, summary: createC, body: stepC.body, errors: stepCErrs },
    db_after_create: dbAfterB,
    db_after_replay: dbAfterC,
    db_errors: dbErrs,
    guest_message_events_linkage: {
      has_booking_write_result: dbAfterC.guest_message_event_has_write_result,
      normalized_keys: dbAfterC.guest_message_event_normalized_keys,
      gap: '22d — persist booking_id/payment_id back to guest_message_events.normalized after write',
    },
    critical_issues: critical,
    revert_errors: revertErrs,
    recommended_phase_22d: [
      'Persist booking_write_result on guest_message_events after successful create-from-plan',
      'Optional deposit Stripe link from inbound thread (STRIPE_LINKS_ENABLED gated)',
      'Closeout doc + verifier for Phase 22 inbound→write chain',
    ],
  }, null, 2));
})().catch((e) => {
  console.error(e);
  try { revertSafeRevision(); } catch (_) { /* best effort */ }
  process.exit(1);
});
