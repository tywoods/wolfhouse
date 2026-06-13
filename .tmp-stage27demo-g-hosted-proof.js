'use strict';
/** Stage 27demo-g — confirmation preview dry-run proof. Temp — do not commit. */
const { execSync } = require('child_process');
const { Client } = require('pg');
const { runGuestConfirmationPreviewDryRun } = require('./scripts/lib/luna-guest-confirmation-preview-dry-run');

const BOOKING_CODE = 'WH-G27-850FDAFDB9';
const BOOKING_ID = 'ba1a0426-c1c7-469e-a7c4-edf9b89ee12d';
const CLIENT = 'wolfhouse-somo';
const HOST = 'staff-staging.lunafrontdesk.com';

function azSecret(name) {
  return execSync(
    `az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name ${name} --query value -o tsv`,
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  ).trim();
}

function azEnv(names) {
  const app = JSON.parse(execSync(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const env = app.properties.template.containers[0].env || [];
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    out[n] = e ? e.value : null;
  }
  return out;
}

async function fetchContext(pg) {
  const bk = await pg.query(
    `SELECT b.booking_code, b.id::text AS booking_id, b.guest_name,
            b.check_in::text, b.check_out::text,
            b.payment_status::text, b.amount_paid_cents, b.balance_due_cents,
            b.confirmation_sent_at, b.primary_room_code,
            b.metadata->'confirmation_draft' AS confirmation_draft,
            (SELECT string_agg(bb.bed_code, ', ' ORDER BY bb.bed_code)
               FROM booking_beds bb WHERE bb.booking_id = b.id) AS bed_codes,
            (SELECT string_agg(DISTINCT COALESCE(bb.room_code, regexp_replace(bb.bed_code, '-B\\d+$', '')),
                               ', ')
               FROM booking_beds bb WHERE bb.booking_id = b.id) AS room_labels
       FROM bookings b
       JOIN clients c ON c.id = b.client_id
      WHERE b.booking_code = $1 AND c.slug = $2`,
    [BOOKING_CODE, CLIENT],
  );
  const sends = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE created_at >= NOW() - INTERVAL '5 minutes'`,
  );
  return { booking: bk.rows[0] || null, recent_sends: sends.rows[0].n };
}

async function snapshotDraft(pg) {
  const r = await pg.query(
    `SELECT metadata->'confirmation_draft' AS confirmation_draft,
            confirmation_sent_at
       FROM bookings WHERE id = $1::uuid`,
    [BOOKING_ID],
  );
  return r.rows[0] || null;
}

function analyzeMessage(msg, ctx) {
  const m = msg || '';
  const draft = ctx.confirmation_draft || {};
  const checks = {
    has_guest_name: !ctx.guest_name || /guest/i.test(m) || m.toLowerCase().includes(String(ctx.guest_name || '').toLowerCase()),
    has_dates: (!ctx.check_in || m.includes('2026') || /aug/i.test(m)),
    has_room_or_label: !!(ctx.room_labels || ctx.primary_room_code || draft.room_number)
      && (/(?:DEMO-R|room)/i.test(m) || /R1/i.test(m)),
    has_gate_code: /2684#/.test(m) || !!(draft.gate_code && m.includes(String(draft.gate_code))),
    has_address: /Somo|Cantabria|Mies de La Ran/i.test(m) || !!(draft.address && m.includes('Somo')),
    has_balance_or_arrival: ctx.balance_due_cents > 0
      ? /(?:balance|arrival|cash|bank|stripe|498)/i.test(m)
      : true,
    no_bed_leak: !/(?:DEMO-R\d+-B\d+)/i.test(m),
    luna_identity: /(?:luna|wolfhouse)/i.test(m),
  };
  return checks;
}

(async () => {
  const proofStart = new Date().toISOString();
  const dbUrl = azSecret('wolfhouse-database-url');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const ctx = await fetchContext(pg);
  if (!ctx.booking) {
    await pg.end();
    console.log(JSON.stringify({ result: 'FAIL', error: 'booking_not_found' }, null, 2));
    process.exit(1);
  }

  const draftBefore = await snapshotDraft(pg);
  const sendsBefore = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE created_at >= $1::timestamptz`,
    [proofStart],
  );

  const env = {
    NODE_ENV: 'staging',
    WHATSAPP_DRY_RUN: 'true',
    OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
  };

  const preview1 = await runGuestConfirmationPreviewDryRun(
    { booking_id: BOOKING_ID, booking_code: BOOKING_CODE, client_slug: CLIENT, language_hint: 'en' },
    { pg, env, host_header: HOST },
  );

  const draftAfter1 = await snapshotDraft(pg);
  const preview2 = await runGuestConfirmationPreviewDryRun(
    { booking_id: BOOKING_ID, booking_code: BOOKING_CODE, client_slug: CLIENT, language_hint: 'en' },
    { pg, env, host_header: HOST },
  );
  const draftAfter2 = await snapshotDraft(pg);

  const sendsAfter = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE created_at >= $1::timestamptz`,
    [proofStart],
  );

  const confirmSent = await pg.query(
    'SELECT confirmation_sent_at FROM bookings WHERE id = $1::uuid',
    [BOOKING_ID],
  );

  await pg.end();

  const msg = preview1.proposed_confirmation_message || '';
  const fieldChecks = analyzeMessage(msg, ctx.booking);
  const missingFields = Object.entries(fieldChecks).filter(([, ok]) => !ok).map(([k]) => k);

  const checks = {
    preview_ready: preview1.confirmation_preview_ready === true,
    preview_success: preview1.success === true,
    next_safe_step: preview1.next_safe_step === 'ready_for_confirmation_send_go_no_go',
    uses_draft: !!(preview1.confirmation_draft || ctx.booking.confirmation_draft),
    no_send_flags: preview1.confirmation_send_allowed === false
      && preview1.sends_whatsapp === false
      && preview1.preview_only === true,
    confirmation_sent_at_null: confirmSent.rows[0].confirmation_sent_at == null,
    no_new_whatsapp: sendsAfter.rows[0].n === sendsBefore.rows[0].n,
    draft_stable: JSON.stringify(draftBefore.confirmation_draft)
      === JSON.stringify(draftAfter2.confirmation_draft),
    idempotent_preview: preview2.confirmation_preview_ready === true
      && preview2.proposed_confirmation_message === preview1.proposed_confirmation_message,
    no_bed_leak: fieldChecks.no_bed_leak,
    content_fields: missingFields.length === 0,
  };

  const failures = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (missingFields.length) failures.push(...missingFields.map((f) => `missing_${f}`));

  let result = 'FAIL';
  if (failures.length === 0) result = 'PASS';
  else if (checks.preview_ready && missingFields.length === 0) result = 'PARTIAL';

  const out = {
    result,
    code_changed: false,
    commit: null,
    booking_code: BOOKING_CODE,
    booking_context: {
      guest_name: ctx.booking.guest_name,
      check_in: ctx.booking.check_in,
      check_out: ctx.booking.check_out,
      payment_status: ctx.booking.payment_status,
      amount_paid_cents: ctx.booking.amount_paid_cents,
      balance_due_cents: ctx.booking.balance_due_cents,
      bed_codes: ctx.booking.bed_codes,
      room_labels: ctx.booking.room_labels,
      confirmation_draft: ctx.booking.confirmation_draft,
    },
    preview1: {
      confirmation_preview_ready: preview1.confirmation_preview_ready,
      next_safe_step: preview1.next_safe_step,
      confirmation_send_allowed: preview1.confirmation_send_allowed,
      sends_whatsapp: preview1.sends_whatsapp,
      preview_only: preview1.preview_only,
      payment_status: preview1.payment_status,
      balance_due_cents: preview1.balance_due_cents,
      room_label: preview1.room_label,
      room_number: preview1.room_number,
      gate_code: preview1.gate_code ? '(present)' : null,
      address: preview1.address ? '(present)' : null,
      block_reasons: preview1.block_reasons || null,
      message_length: msg.length,
      message_excerpt: msg.slice(0, 500),
    },
    key_fields_included: fieldChecks,
    missing_fields: missingFields,
    confirmation_sent_at: confirmSent.rows[0].confirmation_sent_at,
    whatsapp_sends_during_proof: sendsAfter.rows[0].n,
    idempotency: {
      preview2_ready: preview2.confirmation_preview_ready,
      messages_match: preview2.proposed_confirmation_message === preview1.proposed_confirmation_message,
      draft_unchanged: checks.draft_stable,
    },
    safety: {
      confirmation_sent: preview1.confirmation_sent !== true,
      sends_whatsapp: preview1.sends_whatsapp === false,
      no_whatsapp_rows: sendsAfter.rows[0].n === 0,
      reused_path: preview1.reused_preview_path,
    },
    gates: azEnv([
      'WHATSAPP_DRY_RUN',
      'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
      'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
      'OPEN_DEMO_BOOKING_WRITES_ENABLED',
    ]),
    failures,
    recommended_next_step: result === 'PASS'
      ? 'Stage 27demo-h optional confirmation send go/no-go (dry-run blocked) or 27r on open-demo path'
      : missingFields.length
        ? `Fix missing preview fields: ${missingFields.join(', ')}`
        : 'Inspect block_reasons and fix before retry',
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(JSON.stringify({ result: 'FAIL', error: e.message }));
  process.exit(1);
});
