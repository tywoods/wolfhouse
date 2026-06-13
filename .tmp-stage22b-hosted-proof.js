'use strict';
/** Phase 22b — temp hosted proof. Do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const ROUTE = '/staff/meta/whatsapp/webhook';
const COMMIT = 'bf05031';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:bf05031-stage22b-booking-preview';
const TEST_FROM = '491726422307';
const PROFILE = 'Phase 22 Booking Preview';
const PROOF_START = new Date().toISOString();

const WA_COMPLETE = 'wamid.phase22b.complete.001';
const WA_PARTIAL = 'wamid.phase22b.partial.001';
const WA_REFUND = 'wamid.phase22b.refund.001';

const TEXT_COMPLETE =
  'Hi, we are 2 people and want Malibu from September 24 to September 27. We can pay the deposit.';
const TEXT_PARTIAL = 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?';
const TEXT_REFUND = 'I want a refund and need to talk to someone.';

const IDEM_PREVIEW = `luna-booking:wolfhouse-somo:${WA_COMPLETE}:v1`;

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function httpsReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({ hostname: HOST, path, method, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function metaText(waId, text) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '34663439419', phone_number_id: '1152900101233109' },
          contacts: [{ profile: { name: PROFILE }, wa_id: TEST_FROM }],
          messages: [{
            from: TEST_FROM,
            id: waId,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

function stagingEnvFlags() {
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const pick = (name) => {
    const row = env.find((e) => e.name === name);
    if (!row) return '(unset)';
    return row.value != null ? row.value : `(secret:${row.secretRef})`;
  };
  return {
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
    BOT_BOOKING_ENABLED: pick('BOT_BOOKING_ENABLED'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
  };
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

async function dbProof() {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  async function eventByWa(waId) {
    const r = await pg.query(
      `SELECT wa_message_id, from_phone, profile_name, draft_called, next_action, handoff_required,
              send_attempted, send_status, normalized, created_at
         FROM guest_message_events
        WHERE client_slug = 'wolfhouse-somo' AND wa_message_id = $1`,
      [waId],
    );
    return r.rows[0] || null;
  }

  async function countWa(waId) {
    const r = await pg.query(
      `SELECT COUNT(*)::int AS n FROM guest_message_events
        WHERE client_slug = 'wolfhouse-somo' AND wa_message_id = $1`,
      [waId],
    );
    return r.rows[0].n;
  }

  const bookings = await pg.query(
    `SELECT b.id::text, b.booking_code, b.guest_name, b.phone, b.created_at
       FROM bookings b
      INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = 'wolfhouse-somo'
        AND (b.phone LIKE $1 OR b.guest_name = $2)
        AND b.created_at >= $3::timestamptz
      ORDER BY b.created_at DESC`,
    [`%${TEST_FROM}%`, PROFILE, PROOF_START],
  );

  const payments = await pg.query(
    `SELECT p.id::text, p.status::text, p.stripe_checkout_session_id, p.created_at
       FROM payments p
      WHERE p.created_at >= $1::timestamptz
      ORDER BY p.created_at DESC LIMIT 10`,
    [PROOF_START],
  );

  const sent = await pg.query(
    `SELECT idempotency_key, status, provider_message_id, created_at
       FROM guest_message_sends
      WHERE client_slug = 'wolfhouse-somo' AND status = 'sent'
        AND created_at >= $1::timestamptz`,
    [PROOF_START],
  );

  const completeRow = await eventByWa(WA_COMPLETE);
  const partialRow = await eventByWa(WA_PARTIAL);
  const refundRow = await eventByWa(WA_REFUND);
  const completeCount = await countWa(WA_COMPLETE);

  await pg.end();

  return {
    complete_row: completeRow,
    partial_row: partialRow,
    refund_row: refundRow,
    complete_wa_count: completeCount,
    bookings: bookings.rows,
    payments: payments.rows,
    guest_message_sends_sent: sent.rows,
  };
}

function previewOk(p) {
  if (!p || p.eligible !== true) return ['eligible not true'];
  const errs = [];
  if (p.action !== 'create_booking_and_payment_draft') errs.push('action');
  if (p.would_call !== 'POST /staff/bot/booking-create-from-plan') errs.push('would_call');
  if (p.confirm_required !== true) errs.push('confirm_required');
  if (p.idempotency_key_preview !== IDEM_PREVIEW) errs.push('idempotency_key_preview');
  if (p.server_requotes_on_write !== true) errs.push('server_requotes_on_write');
  if (p.amounts_not_final !== true) errs.push('amounts_not_final');
  const pay = p.booking_create_payload_preview;
  if (!pay) errs.push('payload missing');
  else {
    if (pay.client_slug !== 'wolfhouse-somo') errs.push('client_slug');
    if (pay.check_in !== '2026-09-24' || pay.check_out !== '2026-09-27') errs.push('dates');
    if (pay.guest_count !== 2) errs.push('guest_count');
    if (pay.package_code !== 'malibu') errs.push('package_code');
    if (pay.payment_choice !== 'deposit') errs.push('payment_choice');
    if (pay.confirm !== false) errs.push('confirm');
    if (pay.source !== 'meta_whatsapp_inbound_preview') errs.push('source');
  }
  const approvals = p.pending_write_approvals || [];
  if (!approvals.includes('BOT_BOOKING_ENABLED') || !approvals.includes('confirm_true')) {
    errs.push('pending_write_approvals');
  }
  return errs;
}

(async () => {
  const rev = activeRevision();
  const health = await httpsReq('GET', '/healthz');
  const envBefore = stagingEnvFlags();

  const caseA = await httpsReq('POST', ROUTE, metaText(WA_COMPLETE, TEXT_COMPLETE));
  const dbAfterA = await dbProof();
  const replay = await httpsReq('POST', ROUTE, metaText(WA_COMPLETE, TEXT_COMPLETE));
  const dbAfterReplay = await dbProof();

  const caseB = await httpsReq('POST', ROUTE, metaText(WA_PARTIAL, TEXT_PARTIAL));
  const caseC = await httpsReq('POST', ROUTE, metaText(WA_REFUND, TEXT_REFUND));
  const dbFinal = await dbProof();
  const envAfter = stagingEnvFlags();

  const a = caseA.body || {};
  const r = replay.body || {};
  const b = caseB.body || {};
  const c = caseC.body || {};
  const p = a.booking_write_preview || {};
  const stored = dbAfterA.complete_row && dbAfterA.complete_row.normalized
    ? (typeof dbAfterA.complete_row.normalized === 'string'
      ? JSON.parse(dbAfterA.complete_row.normalized)
      : dbAfterA.complete_row.normalized)
    : null;
  const storedPreview = stored && stored.booking_write_preview;

  const caseAErrs = [];
  if (caseA.status !== 200) caseAErrs.push(`http ${caseA.status}`);
  if (a.draft_called !== true) caseAErrs.push('draft_called');
  if (!a.dry_run_plan) caseAErrs.push('dry_run_plan');
  if (!a.booking_write_preview) caseAErrs.push('booking_write_preview missing');
  caseAErrs.push(...previewOk(p));
  if (a.sends_whatsapp !== false) caseAErrs.push('sends_whatsapp');
  if (a.creates_booking !== false || a.creates_payment !== false || a.creates_stripe_link !== false) {
    caseAErrs.push('write flags');
  }

  const dbErrs = [];
  if (!dbAfterA.complete_row) dbErrs.push('no guest_message_events row');
  if (!storedPreview || storedPreview.eligible !== true) dbErrs.push('stored preview eligible');
  if (storedPreview && storedPreview.idempotency_key_preview !== IDEM_PREVIEW) dbErrs.push('stored idem');
  if (!storedPreview || !storedPreview.booking_create_payload_preview) dbErrs.push('stored payload');

  const replayErrs = [];
  if (replay.status !== 200) replayErrs.push(`http ${replay.status}`);
  if (r.duplicate !== true && r.idempotent_replay !== true) replayErrs.push('replay flags');
  if (!r.booking_write_preview || r.booking_write_preview.eligible !== true) replayErrs.push('replay preview');
  if (r.sends_whatsapp !== false) replayErrs.push('replay sends_whatsapp');
  if (dbAfterReplay.complete_wa_count !== 1) replayErrs.push(`wa count ${dbAfterReplay.complete_wa_count}`);

  const partialPreview = b.booking_write_preview || {};
  const partialErrs = [];
  if (caseB.status !== 200) partialErrs.push(`http ${caseB.status}`);
  if (partialPreview.eligible !== false) partialErrs.push('eligible should be false');
  if (!Array.isArray(partialPreview.blocked_reasons) || !partialPreview.blocked_reasons.length) {
    partialErrs.push('blocked_reasons');
  } else if (!partialPreview.blocked_reasons.some((x) => /missing_field|dry_run_not_available/.test(x))) {
    partialErrs.push('missing blocked reason');
  }
  if (partialPreview.booking_create_payload_preview) partialErrs.push('payload should be absent');

  const refundPreview = c.booking_write_preview || {};
  const refundErrs = [];
  if (caseC.status !== 200) refundErrs.push(`http ${caseC.status}`);
  if (c.next_action !== 'handoff_to_staff') refundErrs.push('next_action');
  if (refundPreview.eligible !== false) refundErrs.push('eligible');
  if (!Array.isArray(refundPreview.blocked_reasons) || !refundPreview.blocked_reasons.some((x) => /handoff/i.test(x))) {
    refundErrs.push('handoff blocked_reasons');
  }
  if (refundPreview.booking_create_payload_preview) refundErrs.push('payload absent');

  const safetyErrs = [];
  if (dbFinal.bookings.length) safetyErrs.push('new bookings');
  if (dbFinal.payments.some((x) => x.stripe_checkout_session_id)) safetyErrs.push('stripe sessions');
  if (dbFinal.guest_message_sends_sent.length) safetyErrs.push('whatsapp sent');

  const envErrs = [];
  if (envAfter.WHATSAPP_DRY_RUN !== 'true') envErrs.push('WHATSAPP_DRY_RUN');
  if (envAfter.LUNA_AUTO_SEND_ENABLED !== '(unset)') envErrs.push('LUNA_AUTO_SEND_ENABLED');
  if (envAfter.BOT_BOOKING_ENABLED !== '(unset)') envErrs.push('BOT_BOOKING_ENABLED');
  if (envAfter.STRIPE_LINKS_ENABLED !== 'false') envErrs.push('STRIPE_LINKS_ENABLED');

  const allErrs = [...caseAErrs, ...dbErrs, ...replayErrs, ...partialErrs, ...refundErrs, ...safetyErrs, ...envErrs];
  let result = 'PASS';
  if (safetyErrs.length) result = 'FAIL';
  else if (allErrs.length) result = 'PARTIAL';

  console.log(JSON.stringify({
    phase: '22b',
    result,
    proof_start: PROOF_START,
    checked_at: new Date().toISOString(),
    commit: COMMIT,
    image: IMAGE,
    revision: rev,
    health: { status: health.status, body: health.body },
    env_before: envBefore,
    env_after: envAfter,
    case_a: {
      status: caseA.status,
      draft_called: a.draft_called,
      next_action: a.next_action,
      booking_write_preview: a.booking_write_preview,
      sends_whatsapp: a.sends_whatsapp,
      creates_booking: a.creates_booking,
      creates_payment: a.creates_payment,
      creates_stripe_link: a.creates_stripe_link,
      errors: caseAErrs,
    },
    db_persistence: {
      row_exists: !!dbAfterA.complete_row,
      stored_preview_eligible: storedPreview && storedPreview.eligible,
      stored_idempotency_key_preview: storedPreview && storedPreview.idempotency_key_preview,
      errors: dbErrs,
    },
    replay: {
      status: replay.status,
      duplicate: r.duplicate,
      idempotent_replay: r.idempotent_replay,
      preview_eligible: r.booking_write_preview && r.booking_write_preview.eligible,
      wa_message_count: dbAfterReplay.complete_wa_count,
      errors: replayErrs,
    },
    case_b: {
      status: caseB.status,
      preview: b.booking_write_preview,
      errors: partialErrs,
    },
    case_c: {
      status: caseC.status,
      next_action: c.next_action,
      preview: c.booking_write_preview,
      errors: refundErrs,
    },
    safety: {
      bookings_since_proof: dbFinal.bookings,
      payments_since_proof: dbFinal.payments,
      guest_message_sends_sent: dbFinal.guest_message_sends_sent,
      errors: safetyErrs,
    },
    env_errors: envErrs,
    all_errors: allErrs,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
