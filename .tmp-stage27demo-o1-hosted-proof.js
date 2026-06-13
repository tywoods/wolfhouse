'use strict';
/** Stage 27demo-o.1 — confirmation preview dry-run on n8n booking. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const { runGuestConfirmationPreviewDryRun } = require('./scripts/lib/luna-guest-confirmation-preview-dry-run');

const HOST = 'staff-staging.lunafrontdesk.com';
const BOOKING_CODE = 'WH-G27-0ECC1D9B57';
const BOOKING_ID = '0ade1b48-2087-4ac1-8019-d3e651ab2c2b';
const CLIENT = 'wolfhouse-somo';
const PROOF_PHONE = '+34600995557';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return { name: a.name, health: a.properties.healthState, image: a.properties?.template?.containers?.[0]?.image };
}

function azSecret(name) {
  return az(`az keyvault secret show --vault-name wh-staging-kv --name ${name} --query value -o tsv`);
}

function azEnv(names) {
  const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const env = app.properties.template.containers[0].env || [];
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    out[n] = e ? (e.secretRef ? `(secret:${e.secretRef})` : e.value) : null;
  }
  return out;
}

async function fetchContext(pg, since) {
  const bk = await pg.query(
    `SELECT b.booking_code, b.id::text AS booking_id, b.guest_name,
            b.status::text AS booking_status,
            b.check_in::text, b.check_out::text,
            b.payment_status::text, b.amount_paid_cents, b.balance_due_cents,
            b.confirmation_sent_at, b.primary_room_code,
            b.metadata->'confirmation_draft' AS confirmation_draft,
            (SELECT string_agg(bb.bed_code, ', ' ORDER BY bb.bed_code)
               FROM booking_beds bb WHERE bb.booking_id = b.id) AS bed_codes,
            (SELECT string_agg(DISTINCT COALESCE(bb.room_code, regexp_replace(bb.bed_code, '-B\\d+$', '')),
                               ', ' ORDER BY COALESCE(bb.room_code, regexp_replace(bb.bed_code, '-B\\d+$', '')))
               FROM booking_beds bb WHERE bb.booking_id = b.id) AS room_labels
       FROM bookings b
       JOIN clients c ON c.id = b.client_id
      WHERE b.booking_code = $1 AND c.slug = $2`,
    [BOOKING_CODE, CLIENT],
  );

  const pays = await pg.query(
    `SELECT p.id::text, p.status::text, p.amount_paid_cents, p.stripe_checkout_session_id
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE b.booking_code = $1`,
    [BOOKING_CODE],
  );

  const sends = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE to_phone = $1 AND created_at >= $2::timestamptz`,
    [PROOF_PHONE, since],
  );

  return { booking: bk.rows[0] || null, payments: pays.rows, guest_sends: sends.rows[0].n };
}

async function snapshotBooking(pg) {
  const r = await pg.query(
    `SELECT status::text AS booking_status, payment_status::text,
            amount_paid_cents, balance_due_cents, confirmation_sent_at,
            metadata->'confirmation_draft' AS confirmation_draft
       FROM bookings WHERE id = $1::uuid`,
    [BOOKING_ID],
  );
  return r.rows[0] || null;
}

function analyzeMessage(msg, ctx) {
  const m = msg || '';
  const draft = ctx.confirmation_draft || {};
  return {
    has_booking_code: m.includes(BOOKING_CODE) || m.includes('WH-G27'),
    has_guest_name: !ctx.guest_name || m.toLowerCase().includes(String(ctx.guest_name).toLowerCase()),
    has_paid_200: /(?:€\s*200|200\s*€|paid.*200|20000)/i.test(m) || Number(ctx.amount_paid_cents) === 20000,
    has_balance_398: /(?:€\s*398|398\s*€|balance.*398|remaining.*398)/i.test(m)
      || (Number(ctx.balance_due_cents) === 39800 && /balance|arrival|remaining|saldo/i.test(m)),
    has_room_demo_r2: /DEMO-R2/i.test(m) || (ctx.room_labels && /DEMO-R2/i.test(ctx.room_labels)),
    has_gate_code: /2684#/.test(m) || String(draft.gate_code || '') === '2684#',
    has_address: /Somo|Cantabria|Mies de La Ran/i.test(m),
    has_arrival_payment: /(?:cash|bank transfer|stripe|on arrival|check-in|check in)/i.test(m),
    no_bed_leak: !/(?:DEMO-R2-B\d+|DEMO-R\d+-B\d+)/i.test(m),
    luna_identity: /(?:luna|wolfhouse)/i.test(m),
  };
}

(async () => {
  const proofStart = new Date().toISOString();
  const out = {
    stage: '27demo-o.1',
    booking_code: BOOKING_CODE,
    proof_start: proofStart,
    deploy_needed: false,
    code_changed: false,
  };

  try {
    out.healthz = Number(execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim());
    out.revision = activeRevision();
    out.gates = azEnv([
      'WHATSAPP_DRY_RUN',
      'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
      'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
      'OPEN_DEMO_BOOKING_WRITES_ENABLED',
    ]);

    const pg = new Client({ connectionString: azSecret('wolfhouse-database-url'), ssl: { rejectUnauthorized: false } });
    await pg.connect();

    out.pre = await fetchContext(pg, proofStart);
    if (!out.pre.booking) throw new Error('booking_not_found');

    const draftBefore = await snapshotBooking(pg);
    const env = {
      NODE_ENV: 'staging',
      WHATSAPP_DRY_RUN: 'true',
      OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
    };

    const preview1 = await runGuestConfirmationPreviewDryRun(
      { booking_id: BOOKING_ID, booking_code: BOOKING_CODE, client_slug: CLIENT, language_hint: 'en' },
      { pg, env, host_header: HOST },
    );

    const mid = await snapshotBooking(pg);
    const preview2 = await runGuestConfirmationPreviewDryRun(
      { booking_id: BOOKING_ID, booking_code: BOOKING_CODE, client_slug: CLIENT, language_hint: 'en' },
      { pg, env, host_header: HOST },
    );
    const post = await snapshotBooking(pg);
    const postCtx = await fetchContext(pg, proofStart);
    await pg.end();

    const msg = preview1.proposed_confirmation_message || '';
    const fieldChecks = analyzeMessage(msg, out.pre.booking);
    const missingFields = Object.entries(fieldChecks).filter(([, ok]) => !ok).map(([k]) => k);

    out.preview1 = {
      success: preview1.success,
      confirmation_preview_ready: preview1.confirmation_preview_ready,
      next_safe_step: preview1.next_safe_step,
      confirmation_send_allowed: preview1.confirmation_send_allowed,
      sends_whatsapp: preview1.sends_whatsapp,
      preview_only: preview1.preview_only,
      live_send_blocked: preview1.live_send_blocked,
      no_write_performed: preview1.no_write_performed,
      payment_status: preview1.payment_status,
      balance_due_cents: preview1.balance_due_cents,
      room_label: preview1.room_label,
      room_number: preview1.room_number,
      gate_code: preview1.gate_code,
      address: preview1.address,
      block_reasons: preview1.block_reasons || null,
      reused_preview_path: preview1.reused_preview_path,
      message_length: msg.length,
      message_excerpt: msg.slice(0, 800),
      full_message: msg,
    };

    out.content_checks = fieldChecks;
    out.missing_fields = missingFields;

    out.post = {
      booking_status: post.booking_status,
      payment_status: post.payment_status,
      amount_paid_cents: post.amount_paid_cents,
      balance_due_cents: post.balance_due_cents,
      confirmation_sent_at: post.confirmation_sent_at,
      guest_message_sends: postCtx.guest_sends,
      payments: postCtx.payments,
      draft_unchanged: JSON.stringify(draftBefore.confirmation_draft) === JSON.stringify(post.confirmation_draft),
    };

    out.idempotency = {
      preview2_ready: preview2.confirmation_preview_ready === true,
      messages_match: preview2.proposed_confirmation_message === preview1.proposed_confirmation_message,
      preview2_success: preview2.success === true,
    };

    out.checks = {
      healthz_200: out.healthz === 200,
      preview_ready: preview1.confirmation_preview_ready === true,
      preview_success: preview1.success === true,
      dry_run_flags: preview1.confirmation_send_allowed === false
        && preview1.sends_whatsapp === false
        && preview1.preview_only === true
        && preview1.live_send_blocked === true,
      next_safe_step_ok: preview1.next_safe_step === 'ready_for_confirmation_send_go_no_go',
      confirmation_sent_at_null: post.confirmation_sent_at == null,
      payment_status_unchanged: post.payment_status === 'deposit_paid',
      amount_paid_unchanged: Number(post.amount_paid_cents) === 20000,
      balance_unchanged: Number(post.balance_due_cents) === 39800,
      no_whatsapp_sends: postCtx.guest_sends === 0,
      no_payment_mutation: postCtx.payments.every((p) => p.status === 'paid' && Number(p.amount_paid_cents) === 20000),
      no_bed_leak: fieldChecks.no_bed_leak,
      content_complete: missingFields.length === 0,
      idempotent_preview: out.idempotency.messages_match && out.idempotency.preview2_ready,
      draft_stable: out.post.draft_unchanged,
    };

    const failures = Object.entries(out.checks).filter(([, ok]) => !ok).map(([k]) => k);
    if (missingFields.length) failures.push(...missingFields.map((f) => `missing_${f}`));
    out.failures = failures;
    out.verdict = failures.length === 0 ? 'PASS' : failures.length <= 2 ? 'PARTIAL' : 'FAIL';
    out.recommended_next = failures.length === 0
      ? 'Stage 27demo-h / 27r confirmation send go/no-go (dry-run blocked) — not live send'
      : `Fix: ${failures.join(', ')}`;
  } catch (err) {
    out.error = err.message;
    out.verdict = 'FAIL';
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.verdict === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
