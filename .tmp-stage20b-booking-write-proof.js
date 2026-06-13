'use strict';
/** Phase 20b — Luna booking + payment draft bridge staging proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:d2f4dae-stage19g11a-ui-fix';
const PROOF_SUFFIX = 'stage20b-booking-proof';
const REVERT_SUFFIX = 'stage20b-booking-safe';
const IDEM = 'phase20b-booking-proof-001';
const PROOF_START = new Date().toISOString();

const PAYLOAD = {
  client_slug: CLIENT,
  channel: 'whatsapp',
  from: '+15555552020',
  guest_phone: '+15555552020',
  phone: '+15555552020',
  guest_name: 'Phase 20b Booking Proof',
  email: 'phase20b@example.test',
  language: 'en',
  message_text: 'Hi, I want Malibu package September 24 to 27 for 2 guests, deposit please.',
  check_in: '2026-09-24',
  check_out: '2026-09-27',
  guests: 2,
  guest_count: 2,
  package_code: 'malibu',
  room_type: 'shared',
  payment_choice: 'deposit',
  confirm: true,
  idempotency_key: IDEM,
  source: 'phase20b_staging_proof',
};

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

async function dbProof(pg) {
  const bk = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.phone, b.email,
           b.check_in::text, b.check_out::text, b.guest_count,
           b.status::text AS status, b.payment_status::text AS payment_status,
           b.confirmation_sent_at,
           b.metadata->>'idempotency_key' AS idempotency_key,
           b.created_at
      FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.metadata->>'idempotency_key' = $2
     ORDER BY b.created_at DESC`, [CLIENT, IDEM]);

  const bookingIds = bk.rows.map((r) => r.booking_id);
  let beds = { rows: [] };
  let pays = { rows: [] };
  if (bookingIds.length > 0) {
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

  const sends = await pg.query(`
    SELECT idempotency_key, status, provider_message_id, created_at
      FROM guest_message_sends
     WHERE client_slug = $1 AND created_at >= $2::timestamptz AND status = 'sent'`, [CLIENT, PROOF_START]);

  return {
    booking_count: bk.rows.length,
    booking_beds_count: beds.rows.length,
    payment_count: pays.rows.length,
    bookings: bk.rows,
    booking_beds: beds.rows,
    payments: pays.rows,
    guest_message_sends_sent_since_proof: sends.rows.length,
    guest_message_sends_sent: sends.rows,
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
    creates_stripe_link: body.creates_stripe_link,
    sends_whatsapp: body.sends_whatsapp,
    calls_n8n: body.calls_n8n,
    blocked_reasons: body.blocked_reasons || [],
    safe_next_step: body.safe_next_step,
    next_action: co && co.next_action,
    checkout_url: co && co.checkout_url,
    no_stripe: co && co.no_stripe,
  };
}

function pickDryRunSummary(body) {
  const avail = body.availability || {};
  const preview = body.booking_preview || {};
  return {
    dry_run: body.dry_run,
    preview_only: body.preview_only,
    no_write_performed: body.no_write_performed,
    next_action: body.next_action,
    planned_actions: body.planned_actions,
    has_quote: !!(preview.quote && preview.quote.success),
    selected_bed_codes: avail.selected_bed_codes,
    has_enough_beds: avail.has_enough_beds,
    creates_booking: body.creates_booking,
    creates_payment: body.creates_payment,
    creates_stripe_link: body.creates_stripe_link,
  };
}

function pickEligibilitySummary(body) {
  const e = body.eligibility || {};
  return {
    write_ready: body.write_ready ?? e.write_ready,
    blocked_reasons: body.blocked_reasons || e.blocked_reasons || [],
    required_approvals: body.required_approvals || e.required_approvals || [],
    safe_next_step: body.safe_next_step || e.safe_next_step,
    would_call: body.would_call || e.would_call || [],
    write_performed: body.write_performed,
  };
}

function criticalIssues(db, createSum) {
  const issues = [];
  if (db.booking_count > 1) issues.push('duplicate_bookings');
  if (createSum.checkout_url) issues.push('stripe_checkout_url_in_response');
  for (const p of db.payments) {
    if (p.checkout_url || p.stripe_checkout_session_id) issues.push('stripe_link_in_db');
    if (['paid', 'succeeded'].includes(String(p.status || '').toLowerCase())) issues.push('payment_paid');
  }
  if (db.guest_message_sends_sent_since_proof > 0) issues.push('whatsapp_sent');
  for (const b of db.bookings) {
    if (b.confirmation_sent_at) issues.push('confirmation_sent_at_set');
  }
  return issues;
}

(async () => {
  const out = {
    phase: '20b',
    proof_start: PROOF_START,
    image: IMAGE,
    idempotency_key: IDEM,
    payload: PAYLOAD,
    revision_before: null,
    env_before: null,
    health_before: null,
    db_before: null,
    step_a_dry_run: null,
    step_b_eligibility: null,
    step_c_create: null,
    step_d_replay: null,
    db_after: null,
    revision_during: null,
    env_during: null,
    revision_after: null,
    env_after: null,
    health_after: null,
    result: 'PENDING',
    stopped_early: false,
    stop_reason: null,
  };

  const token = getToken();
  const botHeaders = { 'X-Luna-Bot-Token': token };

  try {
    out.revision_before = activeRevision();
    out.env_before = stagingEnvFlags();
    out.health_before = (await req('GET', '/healthz')).status;

    const pg0 = await pgConnect();
    out.db_before = await dbProof(pg0);
    await pg0.end();

    // Proof revision: BOT_BOOKING on, Stripe off, WhatsApp dry, no live-send gates
    enableProofRevision();
    out.revision_during = await waitHealthy(PROOF_SUFFIX);
    out.env_during = stagingEnvFlags();
    out.health_during = (await req('GET', '/healthz')).status;

    if (out.health_during !== 200) {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = 'healthz_not_200_during_proof';
      throw new Error(out.stop_reason);
    }

    const dryBody = { ...PAYLOAD };
    delete dryBody.confirm;
    delete dryBody.idempotency_key;

    const stepA = await req('POST', '/staff/bot/booking-dry-run', dryBody, botHeaders);
    out.step_a_dry_run = {
      http_status: stepA.status,
      summary: pickDryRunSummary(stepA.body || {}),
      checks: {
        http_200: stepA.status === 200,
        dry_run_true: stepA.body && stepA.body.dry_run === true,
        no_write: stepA.body && stepA.body.no_write_performed === true,
        has_quote: !!(stepA.body && stepA.body.booking_preview && stepA.body.booking_preview.quote),
        has_beds: !!(stepA.body && stepA.body.availability && stepA.body.availability.selected_bed_codes && stepA.body.availability.selected_bed_codes.length >= 2),
        planned_booking: !!(stepA.body && stepA.body.planned_actions && stepA.body.planned_actions.includes('would_create_booking_after_approval')),
        no_writes_flags: stepA.body && stepA.body.creates_booking === false && stepA.body.creates_payment === false,
      },
    };
    out.step_a_dry_run.result = Object.values(out.step_a_dry_run.checks).every(Boolean) ? 'PASS' : 'FAIL';

    const stepB = await req('POST', '/staff/bot/booking-write-eligibility', PAYLOAD, botHeaders);
    out.step_b_eligibility = {
      http_status: stepB.status,
      summary: pickEligibilitySummary(stepB.body || {}),
      checks: {
        http_200: stepB.status === 200,
        write_ready: stepB.body && (stepB.body.write_ready === true || (stepB.body.eligibility && stepB.body.eligibility.write_ready === true)),
        write_not_performed: stepB.body && stepB.body.write_performed === false,
        no_stripe_in_would_call: !(stepB.body && (stepB.body.would_call || []).some((x) => /stripe|payment-link/i.test(x))),
      },
    };
    out.step_b_eligibility.result = Object.values(out.step_b_eligibility.checks).every(Boolean) ? 'PASS' : 'FAIL';

    if (out.step_a_dry_run.result === 'FAIL' || out.step_b_eligibility.result === 'FAIL') {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = 'precheck_steps_failed';
      throw new Error(out.stop_reason);
    }

    const stepC = await req('POST', '/staff/bot/booking-create-from-plan', PAYLOAD, botHeaders);
    const cSum = summarizeCreate(stepC.body || {});
    out.step_c_create = {
      http_status: stepC.status,
      summary: cSum,
      raw_create_outcome: stepC.body && stepC.body.create_outcome,
      checks: {
        http_ok: stepC.status === 200 || stepC.status === 201,
        success: cSum.success === true || cSum.write_performed === true || cSum.idempotent_replay === true,
        has_booking_id: !!cSum.booking_id,
        has_booking_code: !!cSum.booking_code,
        no_stripe_link: !cSum.checkout_url && cSum.creates_stripe_link !== true,
        no_whatsapp: cSum.sends_whatsapp !== true,
        no_n8n: cSum.calls_n8n !== true,
      },
    };

    const pg1 = await pgConnect();
    out.db_after_create = await dbProof(pg1);
    await pg1.end();

    out.step_c_create.db = {
      booking_count: out.db_after_create.booking_count,
      booking_beds_count: out.db_after_create.booking_beds_count,
      payment_count: out.db_after_create.payment_count,
    };
    out.step_c_create.checks.db_one_booking = out.db_after_create.booking_count === 1;
    out.step_c_create.checks.db_has_beds = out.db_after_create.booking_beds_count >= 2;
    out.step_c_create.checks.db_has_draft_payment = out.db_after_create.payment_count >= 1
      && out.db_after_create.payments.every((p) => !p.checkout_url && !p.stripe_checkout_session_id
        && !['paid', 'succeeded'].includes(String(p.status || '').toLowerCase()));
    out.step_c_create.result = Object.values(out.step_c_create.checks).every(Boolean) ? 'PASS' : 'PARTIAL';

    const stepD = await req('POST', '/staff/bot/booking-create-from-plan', PAYLOAD, botHeaders);
    const dSum = summarizeCreate(stepD.body || {});
    out.step_d_replay = {
      http_status: stepD.status,
      summary: dSum,
      checks: {
        http_200: stepD.status === 200,
        success: dSum.success === true,
        idempotent: dSum.idempotent_replay === true || dSum.duplicate === true || dSum.idempotent === true,
        write_not_redone: dSum.write_performed === false || dSum.idempotent_replay === true || dSum.duplicate === true,
        same_booking: !cSum.booking_id || !dSum.booking_id || cSum.booking_id === dSum.booking_id,
        no_stripe: !dSum.checkout_url && dSum.creates_stripe_link !== true,
      },
    };

    const pg2 = await pgConnect();
    out.db_after = await dbProof(pg2);
    await pg2.end();

    out.step_d_replay.checks.db_booking_count_1 = out.db_after.booking_count === 1;
    out.step_d_replay.checks.db_payment_stable = out.db_after.payment_count === out.db_after_create.payment_count;
    out.step_d_replay.checks.db_beds_stable = out.db_after.booking_beds_count === out.db_after_create.booking_beds_count;
    out.step_d_replay.result = Object.values(out.step_d_replay.checks).every(Boolean) ? 'PASS' : 'FAIL';

    const crit = criticalIssues(out.db_after, cSum);
    out.safety = {
      critical_issues: crit,
      guest_message_sends_sent: out.db_after.guest_message_sends_sent_since_proof,
      no_stripe_api_observable: true,
    };

    if (crit.length > 0) {
      out.result = 'FAIL';
      out.stopped_early = true;
      out.stop_reason = crit.join(',');
    } else if ([out.step_a_dry_run.result, out.step_b_eligibility.result, out.step_c_create.result, out.step_d_replay.result].every((x) => x === 'PASS')) {
      out.result = 'PASS';
    } else if ([out.step_c_create.result, out.step_d_replay.result].includes('PARTIAL')) {
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
    process.exit(out.result === 'PASS' ? 0 : 1);
  }
})();
