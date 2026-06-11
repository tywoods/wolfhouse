/**
 * Stage 29a — Luna conversation state-machine tester.
 *
 * Runs multi-turn guest conversations through the real guest automation orchestrator.
 * Default: dry-run only — no WhatsApp send, no writes, no Stripe, no confirmations.
 *
 * Usage:
 *   npm run test:luna-conversations -- --all
 *   npm run test:luna-conversations -- --fixture short-stay-accommodation-only-to-deposit
 *   npm run test:luna-conversations -- --all --verbose --json
 *   npm run test:luna-conversations -- --fixture short-stay-accommodation-only-to-deposit --allow-writes --verbose
 *   npm run test:luna-conversations -- --fixture short-stay-accommodation-only-to-deposit --allow-writes --require-stripe-test-link --verbose
 *   npm run test:luna-conversations -- --fixture short-stay-accommodation-only-to-deposit --allow-writes --require-stripe-test-link --simulate-stripe-webhook --verbose
 *   npm run test:luna-conversations -- --fixture short-stay-accommodation-only-to-deposit --allow-writes --require-stripe-test-link --simulate-stripe-webhook --expect-confirmation-preview --verbose
 *   npm run test:luna-conversations -- --fixture short-stay-accommodation-only-to-deposit --allow-writes --require-stripe-test-link --simulate-stripe-webhook --expect-confirmation-preview --attempt-confirmation-send --verbose
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { withPgClient } = require('./lib/pg-connect');
const { normalizeGuestContextForChain } = require('./lib/luna-guest-context-merge');
const {
  runGuestHoldPaymentDraftWriteDryRunApproved,
  isGuestHoldPaymentDraftWriteEnvironment,
} = require('./lib/luna-guest-hold-payment-draft-write');
const {
  runGuestStripeTestLinkCreateApproved,
  shouldAllowGuestStripeTestLinkCreate,
  isStripeTestSecretKey,
} = require('./lib/luna-guest-stripe-test-link-create');
const { runOpenDemoBookingBedAssignApproved } = require('./lib/open-demo-booking-bed-assign');
const {
  runGuestStripePaymentTruthApplyApproved,
} = require('./lib/luna-guest-stripe-payment-truth-apply');
const {
  runGuestConfirmationPreviewDryRun,
  messageHasBedLeak,
} = require('./lib/luna-guest-confirmation-preview-dry-run');
const {
  runGuestConfirmationSendGoNoGo,
  isWhatsappDryRun,
} = require('./lib/luna-guest-confirmation-send-go-no-go');
const {
  evaluateConfirmationLiveSendAllowlist,
} = require('./lib/luna-guest-confirmation-live-send-allowlist');
const {
  assertNotProductionDb,
  assessCleanupEligibility,
  defaultConnectionString,
  UNPAID_PAYMENT_CANCEL_STATUSES,
} = require('./lib/open-demo-playground-common');
const {
  runLiveProofHygiene,
  liveProofHygieneGuidanceLines,
  isAllowlistedProofPhone,
} = require('./lib/luna-live-proof-hygiene');
const {
  FORBIDDEN_GUEST_PHRASES,
  isFormDevCopy,
} = require('./lib/luna-guest-reply-style-contract');
const { passesConfirmationStyleContract } = require('./lib/luna-guest-confirmation-copy-style');

const WRITE_SOURCE = 'luna_conversation_state_machine_tester';

const CLIENT_SLUG = 'wolfhouse-somo';
const DEFAULT_FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'luna-conversation-state-machine');
const DEFAULT_REFERENCE_DATE = '2026-06-10';
const PACKAGE_NAMES_RE = /\b(?:Malibu|Uluwatu|Waimea)\b/i;

const INTERNAL_LANGUAGE_BLACKLIST = [
  ...FORBIDDEN_GUEST_PHRASES,
  'not creating a hold',
  'not sending a payment link',
];

function usage() {
  console.log(`Usage: node scripts/run-luna-conversation-state-machine-tests.js [options]

Options:
  --all                    Run all fixtures in the fixture directory
  --fixture <name>         Run one fixture (id or filename without .json)
  --limit <n>              Run first N fixtures after filters
  --json                   Print JSON report only
  --verbose                Print full turn diagnostics
  --keep-bookings          Keep unpaid test holds after --allow-writes (skip cleanup)
  --preclean-unpaid-holds  With --allow-writes, cancel unpaid holds for fixture phone + hygiene_window before write proof
  --fresh-proof-window     Alias for --preclean-unpaid-holds
  --allow-staging-paid-proof-reset  With --preclean-unpaid-holds, archive paid staging proof bookings on same window (allowlisted phone only)
  --require-stripe-test-link  With --allow-writes, fail if Stripe TEST checkout is not created
  --simulate-stripe-webhook  With --allow-writes --require-stripe-test-link, apply payment truth via Stage 27p helper
  --expect-confirmation-preview  After payment truth, run Stage 27q confirmation preview dry-run
  --attempt-confirmation-send    After preview, exercise Stage 27r confirmation send go/no-go
  --allow-real-whatsapp-send     With send attempt, allow live WhatsApp (requires allowlist + WHATSAPP_DRY_RUN=false)
  --phone-prefix <prefix>  Default +34629800
  --reference-date <date>  Default ${DEFAULT_REFERENCE_DATE}
  --fixture-dir <path>     Default fixtures/luna-conversation-state-machine
  --help                   Show this help`);
}

function parseArgs(argv) {
  const opts = {
    all: false,
    fixture: null,
    limit: null,
    json: false,
    verbose: false,
    keepBookings: false,
    allowWrites: false,
    precleanUnpaidHolds: false,
    allowStagingPaidProofReset: false,
    requireStripeTestLink: false,
    simulateStripeWebhook: false,
    expectConfirmationPreview: false,
    attemptConfirmationSend: false,
    allowRealWhatsappSend: false,
    phonePrefix: '+34629800',
    referenceDate: DEFAULT_REFERENCE_DATE,
    fixtureDir: DEFAULT_FIXTURE_DIR,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--keep-bookings') opts.keepBookings = true;
    else if (a === '--allow-writes') opts.allowWrites = true;
    else if (a === '--preclean-unpaid-holds' || a === '--fresh-proof-window') opts.precleanUnpaidHolds = true;
    else if (a === '--allow-staging-paid-proof-reset') opts.allowStagingPaidProofReset = true;
    else if (a === '--require-stripe-test-link') opts.requireStripeTestLink = true;
    else if (a === '--simulate-stripe-webhook') opts.simulateStripeWebhook = true;
    else if (a === '--expect-confirmation-preview') opts.expectConfirmationPreview = true;
    else if (a === '--attempt-confirmation-send') opts.attemptConfirmationSend = true;
    else if (a === '--allow-real-whatsapp-send') opts.allowRealWhatsappSend = true;
    else if (a === '--fixture') opts.fixture = argv[++i];
    else if (a === '--limit') opts.limit = parseInt(argv[++i], 10);
    else if (a === '--phone-prefix') opts.phonePrefix = argv[++i];
    else if (a === '--reference-date') opts.referenceDate = argv[++i];
    else if (a === '--fixture-dir') opts.fixtureDir = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      usage();
      process.exit(1);
    }
  }
  return opts;
}

function assertNotProduction() {
  const base = (process.env.STAFF_API_BASE_URL || '').replace(/\/$/, '');
  if (!base) return;
  try {
    const host = new URL(base).hostname.toLowerCase();
    if (/^staff\.lunafrontdesk\.com$/i.test(host)) {
      throw new Error(`production host blocked: ${host}`);
    }
    if (host.includes('lunafrontdesk.com') && !host.includes('staging') && !host.includes('staff-staging')) {
      throw new Error(`production host blocked: ${host}`);
    }
  } catch (e) {
    if (e.message && e.message.includes('production host blocked')) throw e;
    throw new Error(`invalid STAFF_API_BASE_URL: ${base}`);
  }
}

function assessWriteEnvironment() {
  const reasons = [];
  try {
    assertNotProduction();
  } catch (e) {
    reasons.push(e.message);
  }
  try {
    assertNotProductionDb(defaultConnectionString());
  } catch (e) {
    reasons.push(e.message);
  }
  if (!isGuestHoldPaymentDraftWriteEnvironment(process.env, 'localhost')) {
    reasons.push('hold_write_environment_not_staging_or_local');
  }
  return { ok: reasons.length === 0, reasons };
}

function assessStripeTestLinkEnvironment() {
  const reasons = [];
  try {
    assertNotProduction();
  } catch (e) {
    reasons.push(e.message);
  }
  try {
    assertNotProductionDb(defaultConnectionString());
  } catch (e) {
    reasons.push(e.message);
  }
  const gate = shouldAllowGuestStripeTestLinkCreate({
    payment_draft_id: '00000000-0000-0000-0000-000000000001',
  }, buildStripeContext());
  if (!gate.allowed) {
    reasons.push(...gate.reasons.filter((r) => r !== 'payment_draft_id_required'));
  }
  return { ok: reasons.length === 0, reasons };
}

function isStripeCheckoutRequired(opts, writeExpect) {
  if (opts && opts.requireStripeTestLink) return true;
  if (writeExpect && writeExpect.stripe_test_checkout_created === true) return true;
  return false;
}

const UNPAID_CHECKOUT_PAYMENT_STATUSES = ['checkout_created', 'waiting_payment', 'draft', 'pending'];

async function loadPaymentTruth(pg, paymentDraftId) {
  const res = await pg.query(
    `SELECT status::text AS payment_status, amount_paid_cents,
            stripe_checkout_session_id, checkout_url
       FROM payments WHERE id = $1::uuid`,
    [paymentDraftId],
  );
  return res.rows[0] || null;
}

async function loadPaymentBookingSnapshot(pg, paymentDraftId, bookingCode) {
  const res = await pg.query(
    `SELECT p.id::text AS payment_draft_id,
            p.status::text AS payment_status,
            p.amount_paid_cents,
            p.amount_due_cents,
            p.stripe_checkout_session_id,
            p.payment_kind::text AS payment_kind,
            b.booking_code,
            b.id::text AS booking_id,
            b.status::text AS booking_status,
            b.payment_status::text AS booking_payment_status,
            b.amount_paid_cents AS booking_amount_paid_cents,
            b.balance_due_cents AS booking_balance_due_cents,
            b.total_amount_cents AS booking_total_amount_cents,
            b.confirmation_sent_at::text AS confirmation_sent_at,
            (SELECT COUNT(*)::int FROM payments px WHERE px.booking_id = b.id) AS payment_row_count
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND p.id = $2::uuid
        AND ($3::text IS NULL OR b.booking_code = $3)
      LIMIT 1`,
    [CLIENT_SLUG, paymentDraftId, bookingCode || null],
  );
  return res.rows[0] || null;
}

function buildStripeWebhookFixture(snapshot) {
  const sessionId = snapshot && snapshot.stripe_checkout_session_id;
  if (!sessionId) return null;
  const session = {
    id: sessionId,
    livemode: false,
    currency: 'eur',
    amount_total: Number(snapshot.amount_due_cents || 0),
    payment_intent: `pi_test_luna_csm_${String(snapshot.payment_draft_id).slice(0, 8)}`,
    payment_status: 'paid',
    status: 'complete',
    metadata: {
      payment_id: snapshot.payment_draft_id,
      booking_id: snapshot.booking_id,
      booking_code: snapshot.booking_code,
      source: WRITE_SOURCE,
    },
  };
  const event = {
    id: `evt_test_luna_csm_${Date.now()}`,
    type: 'checkout.session.completed',
    livemode: false,
    data: { object: session },
  };
  return { session, event };
}

function buildPaymentTruthContext() {
  return {
    confirm_payment_truth: true,
    env: {
      ...process.env,
      WHATSAPP_DRY_RUN: 'true',
      STRIPE_WEBHOOK_SKIP_VERIFY: 'true',
    },
    host_header: 'localhost',
  };
}

async function detectPaymentTruthReuse(proof) {
  if (!proof.payment_draft_id) return;
  const snap = await withPgClient((pg) => loadPaymentBookingSnapshot(
    pg,
    proof.payment_draft_id,
    proof.booking_code,
  ));
  if (!snap) return;
  if (!proof.stripe_checkout_session_id && snap.stripe_checkout_session_id) {
    proof.stripe_checkout_session_id = snap.stripe_checkout_session_id;
  }
  if (!proof.stripe_checkout_url && snap.checkout_url) {
    proof.stripe_checkout_url = snap.checkout_url;
  }
  proof.payment_status_after_checkout = snap.payment_status;
  proof.payment_amount_paid_cents = Number(snap.amount_paid_cents || 0);
  const paid = ['deposit_paid', 'paid'].includes(snap.booking_payment_status);
  const hasSession = !!snap.stripe_checkout_session_id;
  if (paid && hasSession && proof.payment_amount_paid_cents > 0) {
    proof.payment_truth_pre_applied = true;
    proof.booking_payment_status = snap.booking_payment_status;
  }
}

async function simulateStripeWebhookPaymentTruth(proof, opts) {
  const webhook = {
    attempted: false,
    result: 'SKIPPED',
    skip_reason: null,
    stripe_checkout_session_id: proof.stripe_checkout_session_id || null,
    payment_draft_id: proof.payment_draft_id || null,
    booking_code: proof.booking_code || null,
    payment_status_before: null,
    payment_status_after: null,
    booking_payment_status_before: null,
    booking_payment_status_after: null,
    booking_status_after: null,
    amount_paid_cents_before: null,
    amount_paid_cents_after: null,
    confirmation_sent: false,
    confirmation_sent_at_before: null,
    confirmation_sent_at_after: null,
    payment_row_count_before: null,
    payment_row_count_after: null,
    no_duplicate_payment_truth: null,
    idempotency: null,
    apply_result: null,
  };

  if (!opts.simulateStripeWebhook) return webhook;

  webhook.attempted = true;
  if (!proof.stripe_test_checkout_created) {
    if (!proof.payment_truth_pre_applied || !proof.stripe_checkout_session_id) {
      webhook.skip_reason = 'stripe_checkout_not_created';
      webhook.result = 'FAIL';
      return webhook;
    }
    webhook.reused_payment_truth = true;
  }
  if (!proof.payment_draft_id || !proof.stripe_checkout_session_id) {
    webhook.skip_reason = 'missing_payment_draft_or_session_id';
    webhook.result = 'FAIL';
    return webhook;
  }

  return withPgClient(async (pg) => {
    const before = await loadPaymentBookingSnapshot(pg, proof.payment_draft_id, proof.booking_code);
    if (!before) {
      webhook.skip_reason = 'payment_booking_snapshot_not_found';
      webhook.result = 'FAIL';
      return webhook;
    }

    webhook.payment_status_before = before.payment_status;
    webhook.booking_payment_status_before = before.booking_payment_status;
    webhook.amount_paid_cents_before = Number(before.amount_paid_cents || 0);
    webhook.confirmation_sent_at_before = before.confirmation_sent_at || null;
    webhook.payment_row_count_before = before.payment_row_count;
    webhook.stripe_checkout_session_id = before.stripe_checkout_session_id;

    const fixture = buildStripeWebhookFixture(before);
    if (!fixture) {
      webhook.skip_reason = 'stripe_session_fixture_build_failed';
      webhook.result = 'FAIL';
      return webhook;
    }

    const applyInput = {
      payment_draft_id: proof.payment_draft_id,
      booking_id: before.booking_id,
      booking_code: before.booking_code,
      stripe_event: fixture.event,
      stripe_session: fixture.session,
      source: WRITE_SOURCE,
    };
    const truthCtx = { ...buildPaymentTruthContext(), pg };

    const apply1 = await runGuestStripePaymentTruthApplyApproved(applyInput, truthCtx);
    webhook.apply_result = apply1;

    const after1 = await loadPaymentBookingSnapshot(pg, proof.payment_draft_id, proof.booking_code);
    const apply2 = await runGuestStripePaymentTruthApplyApproved(applyInput, truthCtx);
    const after2 = await loadPaymentBookingSnapshot(pg, proof.payment_draft_id, proof.booking_code);

    webhook.payment_status_after = after1 && after1.payment_status;
    webhook.booking_payment_status_after = after1 && after1.booking_payment_status;
    webhook.booking_status_after = after1 && after1.booking_status;
    webhook.amount_paid_cents_after = after1
      ? Number((after1.booking_amount_paid_cents ?? after1.amount_paid_cents) || 0)
      : null;
    webhook.balance_due_cents_after = after1
      ? Number(after1.booking_balance_due_cents ?? 0)
      : null;
    webhook.confirmation_sent_at_after = after1 && after1.confirmation_sent_at ? after1.confirmation_sent_at : null;
    webhook.confirmation_sent = !!webhook.confirmation_sent_at_after;
    webhook.payment_row_count_after = after2 && after2.payment_row_count;
    webhook.no_duplicate_payment_truth = after2
      && after1
      && after2.payment_row_count === before.payment_row_count;

    webhook.idempotency = {
      result: apply2.idempotent_replay === true ? 'PASS' : 'FAIL',
      idempotent_replay: apply2.idempotent_replay === true,
      second_apply_success: apply2.success === true,
    };

    if (apply1.success && (apply1.payment_truth_recorded || apply1.idempotent_replay)) {
      webhook.result = 'PASS';
    } else {
      webhook.result = 'FAIL';
      webhook.skip_reason = (apply1.block_reasons || []).join('; ') || 'payment_truth_apply_failed';
    }
    return webhook;
  });
}

async function loadAssignedBedsWithMeta(pg, bookingCode) {
  const res = await pg.query(
    `SELECT bb.bed_code, bb.room_code, bb.assignment_type,
            r.name AS room_name, r.fill_priority, r.private_priority,
            r.gender_strategy, r.room_type, r.often_used_by_operator,
            bd.active AS bed_active, bd.sellable AS bed_sellable, bd.bed_label
       FROM booking_beds bb
       JOIN bookings b ON b.id = bb.booking_id AND b.client_id = bb.client_id
       JOIN clients c ON c.id = b.client_id
       JOIN beds bd ON bd.id = bb.bed_id AND bd.client_id = bb.client_id
       JOIN rooms r ON r.id = bd.room_id AND r.client_id = bd.client_id
      WHERE c.slug = $1 AND b.booking_code = $2
      ORDER BY r.fill_priority ASC, bb.bed_code ASC`,
    [CLIENT_SLUG, bookingCode],
  );
  return res.rows;
}

async function loadAttachedManualGuestServices(pg, bookingId) {
  const res = await pg.query(
    `SELECT service_type, service_date, status, source, metadata
       FROM booking_service_records
      WHERE booking_id = $1::uuid
        AND source = 'luna_guest'
        AND metadata->>'pending_origin' = 'luna_guest_pending'
      ORDER BY created_at ASC`,
    [bookingId],
  );
  return res.rows;
}

function priorityOrderValid(beds) {
  if (!beds || beds.length < 2) return true;
  for (let i = 1; i < beds.length; i++) {
    const prev = Number(beds[i - 1].fill_priority);
    const cur = Number(beds[i].fill_priority);
    if (Number.isFinite(prev) && Number.isFinite(cur) && cur < prev) return false;
  }
  return true;
}

function buildWriteChain(lastOut) {
  return {
    result: lastOut.result,
    availability: lastOut.availability,
    quote: lastOut.quote,
    payment_choice: lastOut.payment_choice,
  };
}

function isReadyForHoldWrite(out) {
  const r = (out && out.result) || {};
  const q = (out && out.quote) || {};
  const pc = (out && out.payment_choice) || {};
  const plan = (out && out.hold_payment_draft_plan) || {};
  return r.message_lane === 'new_booking_inquiry'
    && r.booking_intake_ready === true
    && q.quote_status === 'ready'
    && pc.payment_choice_ready === true
    && pc.next_safe_step === 'ready_for_hold_payment_draft'
    && (plan.plan_status == null || plan.plan_status === 'ready');
}

function buildWriteContext(phone, contactName, planner) {
  return {
    confirm_write: true,
    client_slug: CLIENT_SLUG,
    guest_phone: phone,
    guest_name: contactName || 'Conversation Test Guest',
    guest_email: `luna-csm+${String(phone).replace(/\D/g, '')}@wolfhouse.test`,
    env: { ...process.env, WHATSAPP_DRY_RUN: 'true' },
    host_header: 'localhost',
    source: WRITE_SOURCE,
    planner,
  };
}

function buildStripeContext() {
  return {
    confirm_stripe_test_link: true,
    env: { ...process.env, WHATSAPP_DRY_RUN: 'true' },
    host_header: 'localhost',
  };
}

function evaluateStripeGate(paymentDraftId, bookingId, bookingCode) {
  return shouldAllowGuestStripeTestLinkCreate({
    payment_draft_id: paymentDraftId,
    booking_id: bookingId,
    booking_code: bookingCode,
    source: WRITE_SOURCE,
  }, buildStripeContext());
}

async function loadBookingForCleanup(pg, bookingCode) {
  const res = await pg.query(
    `SELECT b.id::text AS booking_id, b.booking_code, b.status::text, b.payment_status::text,
            b.confirmation_sent_at::text
       FROM bookings b
       JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.booking_code = $2
      LIMIT 1`,
    [CLIENT_SLUG, bookingCode],
  );
  return res.rows[0] || null;
}

async function loadPaymentsForBooking(pg, bookingId) {
  const res = await pg.query(
    `SELECT id::text AS payment_id, status::text, payment_kind::text,
            amount_due_cents, amount_paid_cents, stripe_checkout_session_id
       FROM payments WHERE booking_id = $1::uuid ORDER BY created_at`,
    [bookingId],
  );
  return res.rows;
}

async function cleanupUnpaidTestBooking(pg, bookingCode) {
  const booking = await loadBookingForCleanup(pg, bookingCode);
  if (!booking) {
    return { result: 'skipped', reason: 'booking_not_found' };
  }
  const payments = await loadPaymentsForBooking(pg, booking.booking_id);
  const eligibility = assessCleanupEligibility(booking, payments, { allowPaid: false });
  if (!eligibility.eligible) {
    return { result: 'skipped', reason: 'cleanup_not_safe', block_reasons: eligibility.reasons };
  }

  const clientRes = await pg.query('SELECT id::text FROM clients WHERE slug = $1', [CLIENT_SLUG]);
  const clientId = clientRes.rows[0] && clientRes.rows[0].id;
  if (!clientId) return { result: 'skipped', reason: 'client_not_found' };

  const unpaidPayments = payments.filter((p) => UNPAID_PAYMENT_CANCEL_STATUSES.includes(String(p.status).toLowerCase()));
  const note = `[${WRITE_SOURCE} ${new Date().toISOString()}] unpaid test hold cancelled`;

  await pg.query('BEGIN');
  try {
    const delBeds = await pg.query(
      'DELETE FROM booking_beds WHERE booking_id = $1::uuid AND client_id = $2::uuid',
      [booking.booking_id, clientId],
    );
    let paymentsCancelled = 0;
    for (const p of unpaidPayments) {
      const upd = await pg.query(
        `UPDATE payments SET status = 'cancelled', updated_at = NOW()
          WHERE id = $1::uuid AND booking_id = $2::uuid AND status = ANY($3::payment_record_status[])`,
        [p.payment_id, booking.booking_id, UNPAID_PAYMENT_CANCEL_STATUSES],
      );
      paymentsCancelled += upd.rowCount || 0;
    }
    await pg.query(
      `UPDATE bookings SET status = 'cancelled',
              staff_notes = TRIM(BOTH FROM COALESCE(staff_notes, '') || E'\\n' || $3),
              updated_at = NOW()
        WHERE id = $1::uuid AND client_id = $2::uuid`,
      [booking.booking_id, clientId, note],
    );
    await pg.query('COMMIT');
    return {
      result: 'cleaned',
      booking_code: bookingCode,
      beds_released: delBeds.rowCount || 0,
      payments_cancelled: paymentsCancelled,
    };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch { /* ignore */ }
    return { result: 'error', reason: err.message || 'cleanup_failed' };
  }
}

function checkWebhookExpectations(webhookExpect, proof, opts) {
  const failures = [];
  if (!opts.simulateStripeWebhook) return failures;
  const w = proof.stripe_webhook || {};
  const we = webhookExpect || {};

  if (w.result === 'FAIL' || (w.attempted && w.result !== 'PASS')) {
    failures.push(`stripe_webhook_simulation: ${w.skip_reason || w.result || 'failed'}`);
    return failures;
  }
  if (!w.attempted) {
    failures.push('stripe_webhook_simulation not attempted');
    return failures;
  }

  const bookingPayStatus = w.booking_payment_status_after;
  const expectedStatus = we.expected_payment_status_after_webhook
    || we.expected_booking_payment_status_after_webhook;
  if (expectedStatus && bookingPayStatus !== expectedStatus) {
    failures.push(`expected_payment_status_after_webhook ${expectedStatus} got ${bookingPayStatus}`);
  }
  if (we.expected_amount_paid_cents != null && w.amount_paid_cents_after !== we.expected_amount_paid_cents) {
    failures.push(`expected_amount_paid_cents ${we.expected_amount_paid_cents} got ${w.amount_paid_cents_after}`);
  }
  if (we.expected_balance_due_cents != null && w.balance_due_cents_after !== we.expected_balance_due_cents) {
    failures.push(`expected_balance_due_cents ${we.expected_balance_due_cents} got ${w.balance_due_cents_after}`);
  }
  if (we.expected_confirmation_sent === false && w.confirmation_sent === true) {
    failures.push('confirmation_sent expected false after webhook');
  }
  if (we.expected_confirmation_sent_at_unchanged === true) {
    const before = w.confirmation_sent_at_before || null;
    const after = w.confirmation_sent_at_after || null;
    if (before !== after) {
      failures.push(`confirmation_sent_at changed: ${before} -> ${after}`);
    }
  }
  if (we.expected_no_duplicate_payment_truth === true && w.no_duplicate_payment_truth !== true) {
    failures.push('duplicate payment row detected after webhook');
  }
  if (we.expected_webhook_idempotency === true) {
    if (!w.idempotency || w.idempotency.result !== 'PASS') {
      failures.push(`webhook idempotency failed: ${(w.idempotency && w.idempotency.result) || 'missing'}`);
    }
  }
  if (w.payment_status_after !== 'paid') {
    failures.push(`payment row status expected paid got ${w.payment_status_after}`);
  }

  return failures;
}

function formatEuroCents(cents) {
  return `€${(Number(cents) / 100).toFixed(0)}`;
}

function checkConfirmationExpectations(confirmationExpect, proof, opts) {
  const failures = [];
  if (!opts.expectConfirmationPreview) return failures;
  const ce = confirmationExpect || {};
  const cp = proof.confirmation_preview || {};

  if (ce.confirmation_preview_ready === true && !cp.confirmation_preview_ready) {
    failures.push(`confirmation_preview_ready expected true (${cp.skip_reason || 'not ready'})`);
  }
  if (ce.confirmation_sent === false && cp.confirmation_sent === true) {
    failures.push('confirmation_sent expected false after preview');
  }
  if (ce.confirmation_sent_at_unchanged === true) {
    const before = cp.confirmation_sent_at_before || null;
    const after = cp.confirmation_sent_at_after || null;
    if (before !== after) {
      failures.push(`confirmation_sent_at changed: ${before} -> ${after}`);
    }
  }
  if (ce.gate_code_present === true && !cp.gate_code_present) {
    failures.push('gate_code 2684# not present in confirmation preview');
  }
  if (ce.room_label_present === true && !cp.room_label_present) {
    failures.push('room label not present in confirmation preview');
  }
  if (ce.no_bed_number_exposed === true && cp.bed_number_exposed === true) {
    failures.push('bed number exposed in confirmation message');
  }

  const msg = String(cp.proposed_confirmation_message || '').toLowerCase();
  if (Array.isArray(ce.confirmation_message_contains)) {
    for (const needle of ce.confirmation_message_contains) {
      const n = String(needle).toLowerCase();
      if (!msg.includes(n)) failures.push(`confirmation_message_contains "${needle}" missing`);
    }
  }
  if (ce.confirmation_message_contains_booking_code === true && proof.booking_code) {
    if (!msg.includes(String(proof.booking_code).toLowerCase())) {
      failures.push(`confirmation_message missing booking_code ${proof.booking_code}`);
    }
  }
  if (ce.confirmation_message_contains_paid_cents != null) {
    const euros = formatEuroCents(ce.confirmation_message_contains_paid_cents).toLowerCase();
    const centsStr = String(ce.confirmation_message_contains_paid_cents);
    if (!msg.includes(euros) && !msg.includes(centsStr)) {
      failures.push(`confirmation_message missing paid amount ${euros}`);
    }
  }
  if (ce.confirmation_message_contains_balance_cents != null) {
    const euros = formatEuroCents(ce.confirmation_message_contains_balance_cents).toLowerCase();
    const centsStr = String(ce.confirmation_message_contains_balance_cents);
    if (!msg.includes(euros) && !msg.includes(centsStr) && !msg.includes('balance')) {
      failures.push(`confirmation_message missing balance amount ${euros}`);
    }
  }
  if (Array.isArray(ce.confirmation_message_not_contains)) {
    for (const needle of ce.confirmation_message_not_contains) {
      if (msg.includes(String(needle).toLowerCase())) {
        failures.push(`confirmation_message_not_contains "${needle}" found`);
      }
    }
  }
  for (const term of INTERNAL_LANGUAGE_BLACKLIST) {
    if (msg.includes(term.toLowerCase())) {
      failures.push(`confirmation internal language: ${term}`);
    }
  }

  if (ce.confirmation_passes_style_contract === true) {
    const rawMsg = String(cp.proposed_confirmation_message || '');
    const styleCheck = passesConfirmationStyleContract(rawMsg, {
      booking_code: proof.booking_code,
      amount_paid_cents: ce.confirmation_message_contains_paid_cents != null
        ? ce.confirmation_message_contains_paid_cents
        : cp.amount_paid_cents,
      balance_due_cents: ce.confirmation_message_contains_balance_cents != null
        ? ce.confirmation_message_contains_balance_cents
        : cp.balance_due_cents,
    });
    if (!styleCheck.ok) {
      failures.push(`confirmation style contract: ${styleCheck.reasons.join(', ')}`);
    }
  }

  if (ce.expected_balance_due_cents != null && cp.balance_due_cents !== ce.expected_balance_due_cents) {
    failures.push(`expected_balance_due_cents ${ce.expected_balance_due_cents} got ${cp.balance_due_cents}`);
  }

  if (cp.result === 'FAIL' || (cp.attempted && cp.result !== 'PASS' && cp.result !== 'PARTIAL')) {
    if (!failures.some((f) => f.startsWith('confirmation_preview'))) {
      failures.push(`confirmation_preview: ${cp.skip_reason || cp.result || 'failed'}`);
    }
  }

  return failures;
}

async function runConfirmationPreviewProof(proof, fixture, opts) {
  const cp = {
    attempted: false,
    result: 'SKIPPED',
    skip_reason: null,
    confirmation_preview_ready: false,
    proposed_confirmation_message: null,
    gate_code_present: false,
    room_label_present: false,
    bed_number_exposed: false,
    payment_status: null,
    amount_paid_cents: null,
    balance_due_cents: null,
    confirmation_sent: false,
    confirmation_sent_at_before: null,
    confirmation_sent_at_after: null,
    preview_result: null,
  };

  if (!opts.expectConfirmationPreview) return cp;

  cp.attempted = true;
  const wh = proof.stripe_webhook;
  if (!wh || wh.result !== 'PASS') {
    cp.skip_reason = 'payment_truth_required_before_confirmation_preview';
    cp.result = 'FAIL';
    return cp;
  }
  const paidStatus = wh.booking_payment_status_after;
  if (!['deposit_paid', 'paid'].includes(paidStatus)) {
    cp.skip_reason = `booking_not_paid:${paidStatus}`;
    cp.result = 'FAIL';
    return cp;
  }

  return withPgClient(async (pg) => {
    const before = await loadPaymentBookingSnapshot(pg, proof.payment_draft_id, proof.booking_code);
    cp.confirmation_sent_at_before = before && before.confirmation_sent_at ? before.confirmation_sent_at : null;
    cp.payment_status = paidStatus;
    cp.amount_paid_cents = wh.amount_paid_cents_after;

    const previewOut = await runGuestConfirmationPreviewDryRun({
      client_slug: CLIENT_SLUG,
      booking_code: proof.booking_code,
      booking_id: before && before.booking_id,
      language_hint: fixture.language || 'en',
    }, { pg });

    cp.preview_result = previewOut;
    cp.confirmation_preview_ready = previewOut.confirmation_preview_ready === true;
    cp.proposed_confirmation_message = previewOut.proposed_confirmation_message
      || previewOut.message_preview
      || null;
    cp.gate_code_present = !!(previewOut.gate_code && String(previewOut.gate_code).includes('2684'));
    cp.room_label_present = !!(previewOut.room_label || previewOut.room_number);
    cp.bed_number_exposed = messageHasBedLeak(cp.proposed_confirmation_message);
    cp.balance_due_cents = previewOut.balance_due_cents != null
      ? Number(previewOut.balance_due_cents)
      : null;

    const after = await loadPaymentBookingSnapshot(pg, proof.payment_draft_id, proof.booking_code);
    cp.confirmation_sent_at_after = after && after.confirmation_sent_at ? after.confirmation_sent_at : null;
    cp.confirmation_sent = !!cp.confirmation_sent_at_after;

    if (previewOut.success && previewOut.confirmation_preview_ready) {
      cp.result = cp.bed_number_exposed ? 'PARTIAL' : 'PASS';
      if (cp.bed_number_exposed) {
        cp.skip_reason = 'bed_number_exposed_in_confirmation_template';
      }
    } else {
      cp.result = 'FAIL';
      cp.skip_reason = (previewOut.block_reasons || []).join('; ') || 'confirmation_preview_not_ready';
    }
    return cp;
  });
}

function normalizeFixtureSendStatus(status) {
  if (status === 'not_approved' || status === 'send_gate_blocked') return 'blocked_by_gate';
  if (status === 'recipient_not_allowlisted') return 'blocked_by_gate';
  return status;
}

function buildSendPreviewPayload(cp, proof) {
  const previewResult = (cp && cp.preview_result) || {};
  return {
    ...previewResult,
    confirmation_preview_ready: cp && cp.confirmation_preview_ready === true,
    proposed_confirmation_message: cp && cp.proposed_confirmation_message,
    booking_code: proof.booking_code,
    booking_id: previewResult.booking_id || null,
    payment_status: cp && cp.payment_status,
  };
}

function buildConfirmationSendEnv(opts) {
  const env = {
    ...process.env,
    LUNA_AUTO_SEND_ENABLED: 'true',
    WHATSAPP_DRY_RUN: opts.allowRealWhatsappSend ? 'false' : 'true',
  };
  if (!opts.allowRealWhatsappSend) {
    env.WHATSAPP_DRY_RUN = 'true';
  }
  return env;
}

function confirmationMessageMatchesPreview(sendOut, previewMessage) {
  const preview = String(previewMessage || '').trim();
  if (!preview) return false;
  const candidates = [
    sendOut && sendOut.message_sent,
    sendOut && sendOut.proposed_confirmation_message,
    sendOut && sendOut.message_preview,
  ].filter(Boolean).map((v) => String(v).trim());
  if (!candidates.length) return false;
  return candidates.some((msg) => msg === preview || msg.includes(preview.slice(0, 60)));
}

function assessAllowRealWhatsappSend(opts, phone) {
  const reasons = [];
  if (!opts.allowRealWhatsappSend) return { allowed: false, reasons: ['flag_not_passed'] };
  try {
    assertNotProduction();
  } catch (e) {
    reasons.push(e.message);
  }
  try {
    assertNotProductionDb(defaultConnectionString());
  } catch (e) {
    reasons.push(e.message);
  }
  if (isWhatsappDryRun(process.env)) {
    reasons.push('WHATSAPP_DRY_RUN_must_be_false');
  }
  const allowEval = evaluateConfirmationLiveSendAllowlist(phone, process.env);
  if (!allowEval.allowed) reasons.push(...allowEval.reasons);
  return { allowed: reasons.length === 0, reasons, allowEval };
}

function checkConfirmationSendExpectations(confirmationSendExpect, proof, opts) {
  const failures = [];
  if (!opts.attemptConfirmationSend) return failures;
  const se = confirmationSendExpect || {};
  const cs = proof.confirmation_send || {};

  if (se.confirmation_send_attempted === true && !cs.attempted) {
    failures.push('confirmation_send_attempted expected true');
    return failures;
  }
  if (!cs.attempted) return failures;

  const withoutStatus = normalizeFixtureSendStatus(
    cs.without_approval && cs.without_approval.send_status,
  );
  if (se.expected_send_status_without_approval) {
    if (withoutStatus !== se.expected_send_status_without_approval) {
      failures.push(`expected_send_status_without_approval ${se.expected_send_status_without_approval} got ${withoutStatus}`);
    }
  }
  const withStatus = normalizeFixtureSendStatus(cs.with_approval && cs.with_approval.send_status);
  if (se.expected_send_status) {
    const expected = Array.isArray(se.expected_send_status)
      ? se.expected_send_status.map(normalizeFixtureSendStatus)
      : [normalizeFixtureSendStatus(se.expected_send_status)];
    if (!expected.includes(withStatus)) {
      failures.push(`expected_send_status ${expected.join('|')} got ${withStatus}`);
    }
  }
  const dupStatus = normalizeFixtureSendStatus(cs.duplicate_attempt && cs.duplicate_attempt.send_status);
  if (se.expected_duplicate_send_status) {
    const expected = Array.isArray(se.expected_duplicate_send_status)
      ? se.expected_duplicate_send_status
      : [se.expected_duplicate_send_status];
    if (!expected.includes(dupStatus)) {
      failures.push(`expected_duplicate_send_status ${expected.join('|')} got ${dupStatus}`);
    }
  }
  if (se.confirmation_sent_expected === false && cs.confirmation_sent === true) {
    failures.push('confirmation_sent expected false after send go/no-go');
  }
  if (se.confirmation_sent_at_expected === 'unchanged') {
    const before = cs.confirmation_sent_at_before || null;
    const after = cs.confirmation_sent_at_after || null;
    if (before !== after) {
      failures.push(`confirmation_sent_at changed: ${before} -> ${after}`);
    }
  }
  if (se.duplicate_confirmation_blocked === true) {
    const dup = cs.duplicate_attempt || {};
    if (dup.sends_whatsapp === true) {
      failures.push('duplicate confirmation send performed WhatsApp');
    }
    if (dup.send_status === 'sent') {
      failures.push('duplicate confirmation send status sent');
    }
  }
  if (se.confirmation_message_matches_preview === true && !cs.message_matches_preview) {
    failures.push('confirmation_message_matches_preview expected true');
  }
  if (se.whatsapp_sent_expected === false) {
    if (cs.with_approval && cs.with_approval.sends_whatsapp === true) {
      failures.push('whatsapp_sent_expected false but sends_whatsapp true');
    }
    if (cs.duplicate_attempt && cs.duplicate_attempt.sends_whatsapp === true) {
      failures.push('duplicate whatsapp_sent_expected false but sends_whatsapp true');
    }
  }
  if (se.provider_send_performed_expected === false && cs.provider_send_performed === true) {
    failures.push('provider_send_performed expected false');
  }
  if (se.calls_n8n_expected === false && cs.calls_n8n === true) {
    failures.push('calls_n8n expected false');
  }
  if (cs.result === 'FAIL' || (cs.attempted && cs.result !== 'PASS' && cs.result !== 'PARTIAL')) {
    if (!failures.some((f) => f.startsWith('confirmation_send'))) {
      failures.push(`confirmation_send: ${cs.skip_reason || cs.result || 'failed'}`);
    }
  }
  return failures;
}

async function runConfirmationSendProof(proof, fixture, phone, opts) {
  const cs = {
    attempted: false,
    result: 'SKIPPED',
    skip_reason: null,
    without_approval: null,
    with_approval: null,
    duplicate_attempt: null,
    confirmation_sent_at_before: null,
    confirmation_sent_at_after: null,
    confirmation_sent: false,
    provider_send_performed: false,
    calls_n8n: false,
    message_matches_preview: false,
    whatsapp_dry_run: true,
    live_send_blocked: true,
  };

  if (!opts.attemptConfirmationSend) return cs;

  cs.attempted = true;
  const cp = proof.confirmation_preview;
  if (!cp || !cp.attempted) {
    cs.skip_reason = 'confirmation_preview_required';
    cs.result = 'FAIL';
    return cs;
  }
  if (cp.result === 'FAIL' || !cp.confirmation_preview_ready) {
    cs.skip_reason = cp.skip_reason || 'confirmation_preview_not_ready';
    cs.result = 'FAIL';
    return cs;
  }

  if (opts.allowRealWhatsappSend) {
    const liveGate = assessAllowRealWhatsappSend(opts, phone);
    if (!liveGate.allowed) {
      cs.skip_reason = liveGate.reasons.join('; ');
      cs.result = 'PARTIAL';
      return cs;
    }
  }

  return withPgClient(async (pg) => {
    const snapBefore = await loadPaymentBookingSnapshot(pg, proof.payment_draft_id, proof.booking_code);
    cs.confirmation_sent_at_before = snapBefore && snapBefore.confirmation_sent_at
      ? snapBefore.confirmation_sent_at
      : null;

    const previewPayload = buildSendPreviewPayload(cp, proof);
    const idempotencyKey = `${WRITE_SOURCE}:${fixture.id}:${proof.booking_code}:confirmation`;
    const sendEnv = buildConfirmationSendEnv(opts);
    cs.whatsapp_dry_run = isWhatsappDryRun(sendEnv);

    const sendInputBase = {
      confirmation_preview_result: previewPayload,
      to: phone,
      idempotency_key: idempotencyKey,
      client_slug: CLIENT_SLUG,
      booking_code: proof.booking_code,
      booking_id: snapBefore && snapBefore.booking_id,
    };
    const sendCtx = { pg, env: sendEnv };

    cs.without_approval = await runGuestConfirmationSendGoNoGo({
      ...sendInputBase,
      confirm_send: false,
    }, sendCtx);

    cs.with_approval = await runGuestConfirmationSendGoNoGo({
      ...sendInputBase,
      confirm_send: true,
    }, sendCtx);

    cs.duplicate_attempt = await runGuestConfirmationSendGoNoGo({
      ...sendInputBase,
      confirm_send: true,
    }, sendCtx);

    const snapAfter = await loadPaymentBookingSnapshot(pg, proof.payment_draft_id, proof.booking_code);
    cs.confirmation_sent_at_after = snapAfter && snapAfter.confirmation_sent_at
      ? snapAfter.confirmation_sent_at
      : null;
    cs.confirmation_sent = !!cs.confirmation_sent_at_after;
    cs.provider_send_performed = cs.with_approval && (
      cs.with_approval.send_performed === true || cs.with_approval.sends_whatsapp === true
    );
    cs.calls_n8n = [cs.without_approval, cs.with_approval, cs.duplicate_attempt].some(
      (r) => r && r.calls_n8n === true,
    );
    cs.live_send_blocked = cs.with_approval && cs.with_approval.live_send_blocked !== false;
    cs.message_matches_preview = confirmationMessageMatchesPreview(
      cs.with_approval,
      cp.proposed_confirmation_message,
    );

    const withoutOk = cs.without_approval && cs.without_approval.send_attempted === false
      && normalizeFixtureSendStatus(cs.without_approval.send_status) === 'blocked_by_gate';
    const withOk = cs.with_approval && cs.with_approval.send_attempted === true
      && cs.with_approval.sends_whatsapp !== true;
    const dupOk = cs.duplicate_attempt && cs.duplicate_attempt.sends_whatsapp !== true;

    if (withoutOk && withOk && dupOk && cs.message_matches_preview) {
      cs.result = 'PASS';
    } else if (cs.with_approval && cs.with_approval.send_attempted === true) {
      cs.result = 'PARTIAL';
      cs.skip_reason = [
        !withoutOk ? 'without_approval_unexpected' : null,
        !withOk ? 'with_approval_unexpected' : null,
        !dupOk ? 'duplicate_not_blocked' : null,
        !cs.message_matches_preview ? 'message_preview_mismatch' : null,
      ].filter(Boolean).join('; ') || 'confirmation_send_partial';
    } else {
      cs.result = 'FAIL';
      cs.skip_reason = (cs.with_approval && cs.with_approval.block_reasons || []).join('; ')
        || 'confirmation_send_failed';
    }
    return cs;
  });
}

function checkWriteExpectations(writeExpect, proof, opts, webhookExpect, confirmationExpect, confirmationSendExpect) {
  const failures = [];
  if (!writeExpect || typeof writeExpect !== 'object') return failures;
  const w = proof || {};
  const stripeRequired = isStripeCheckoutRequired(opts, writeExpect);

  if (writeExpect.booking_created === true) {
    if (!w.booking_write || w.booking_write.success !== true) failures.push('booking_created expected true');
    if (w.booking_write && !['created', 'reused_existing'].includes(w.booking_write.write_status)) {
      failures.push(`booking write_status expected created/reused got ${w.booking_write.write_status}`);
    }
  }
  if (writeExpect.booking_code_exists === true && !w.booking_code) {
    failures.push('booking_code_exists expected true');
  }
  if (writeExpect.payment_draft_created === true) {
    if (!w.payment_draft_id) failures.push('payment_draft_created expected true');
  }
  if (writeExpect.payment_draft_id_exists === true && !w.payment_draft_id) {
    failures.push('payment_draft_id_exists expected true');
  }
  if (writeExpect.expected_deposit_cents != null) {
    const cents = w.deposit_amount_cents;
    if (cents !== writeExpect.expected_deposit_cents) {
      failures.push(`expected_deposit_cents ${writeExpect.expected_deposit_cents} got ${cents}`);
    }
  }
  if (writeExpect.stripe_live_used === false && w.stripe_live_used === true) {
    failures.push('stripe_live_used must be false');
  }
  if (writeExpect.confirmation_sent === false && w.confirmation_sent === true) {
    failures.push('confirmation_sent expected false in write mode');
  }
  if (writeExpect.duplicate_booking_created === false && w.duplicate_booking_created === true) {
    failures.push('duplicate_booking_created expected false');
  }

  const stripeExpect = writeExpect.stripe_test_checkout_created;
  const prePaidReuse = w.payment_truth_pre_applied === true;
  if (stripeRequired) {
    if (!w.stripe_test_checkout_created && !prePaidReuse) {
      failures.push(`stripe_test_checkout_required: ${w.stripe_skip_reason || 'gate blocked'}`);
    }
    if (prePaidReuse && !w.stripe_checkout_session_id) {
      failures.push('payment_truth_pre_applied but stripe_checkout_session_id missing');
    }
  } else if (stripeExpect === true) {
    if (!w.stripe_test_checkout_created) {
      failures.push(`stripe_test_checkout_created expected true (${w.stripe_skip_reason || 'gate blocked'})`);
    }
  } else if (stripeExpect === false) {
    if (w.stripe_test_checkout_created) failures.push('stripe_test_checkout_created expected false');
  }

  const stripeCheckoutChecks = w.stripe_test_checkout_created
    || (prePaidReuse && w.stripe_checkout_session_id);
  if (stripeCheckoutChecks && !prePaidReuse) {
    if (writeExpect.stripe_checkout_url_exists === true && !w.stripe_checkout_url) {
      failures.push('stripe_checkout_url_exists expected true');
    }
    if (writeExpect.stripe_checkout_session_id_exists === true && !w.stripe_checkout_session_id) {
      failures.push('stripe_checkout_session_id_exists expected true');
    }
    if (stripeRequired || writeExpect.stripe_checkout_url_exists === true) {
      if (!w.stripe_checkout_url) failures.push('stripe_checkout_url missing after checkout');
    }
    if (stripeRequired || writeExpect.stripe_checkout_session_id_exists === true) {
      if (!w.stripe_checkout_session_id) failures.push('stripe_checkout_session_id missing after checkout');
    }
    const ps = w.payment_status_after_checkout;
    if (stripeRequired && ps === 'paid') {
      failures.push(`payment_status must not be paid after checkout got ${ps}`);
    }
    if (stripeRequired && ps && !UNPAID_CHECKOUT_PAYMENT_STATUSES.includes(ps)) {
      failures.push(`payment_status unexpected after checkout: ${ps}`);
    }
    if (w.payment_amount_paid_cents > 0) {
      failures.push(`payment truth mutated: amount_paid_cents=${w.payment_amount_paid_cents}`);
    }
  }

  if (writeExpect.cleanup_expected === true && w.cleanup && w.cleanup.result === 'error') {
    failures.push(`cleanup failed: ${w.cleanup.reason}`);
  }
  if (writeExpect.cleanup_expected === true && w.cleanup && w.cleanup.result === 'refused'
    && !(opts.simulateStripeWebhook && webhookExpect && webhookExpect.cleanup_refused_expected === true)) {
    failures.push(`cleanup refused: ${w.cleanup.reason}`);
  }

  failures.push(...checkWebhookExpectations(webhookExpect, proof, opts));
  failures.push(...checkConfirmationExpectations(confirmationExpect, proof, opts));
  failures.push(...checkConfirmationSendExpectations(confirmationSendExpect, proof, opts));

  if (writeExpect.idempotency_check === true) {
    if (!w.idempotency || w.idempotency.result !== 'PASS') {
      failures.push(`idempotency_check failed: ${(w.idempotency && w.idempotency.reason) || 'missing'}`);
    }
  }

  const assigned = w.assigned_beds || [];
  if (writeExpect.assigned_beds_count != null) {
    if (assigned.length !== writeExpect.assigned_beds_count) {
      failures.push(`assigned_beds_count expected ${writeExpect.assigned_beds_count} got ${assigned.length}`);
    }
  }
  if (writeExpect.no_operator_blocked_beds === true) {
    const op = assigned.filter((b) => b.often_used_by_operator === true);
    if (op.length) {
      failures.push(`operator_blocked_bed_assigned: ${op.map((b) => b.bed_code).join(', ')}`);
    }
  }
  if (writeExpect.no_inactive_beds === true) {
    const bad = assigned.filter((b) => b.bed_active === false || b.bed_sellable === false);
    if (bad.length) {
      failures.push(`inactive_or_unsellable_bed_assigned: ${bad.map((b) => b.bed_code).join(', ')}`);
    }
  }
  if (writeExpect.assigned_room_contains) {
    const needle = String(writeExpect.assigned_room_contains).toLowerCase();
    const hit = assigned.some((b) => String(b.room_code || '').toLowerCase().includes(needle)
      || String(b.room_name || '').toLowerCase().includes(needle));
    if (!hit) failures.push(`assigned_room_contains "${writeExpect.assigned_room_contains}" missing`);
  }
  if (writeExpect.assigned_bed_contains) {
    const needle = String(writeExpect.assigned_bed_contains).toLowerCase();
    const hit = assigned.some((b) => String(b.bed_code || '').toLowerCase().includes(needle)
      || String(b.bed_label || '').toLowerCase().includes(needle));
    if (!hit) failures.push(`assigned_bed_contains "${writeExpect.assigned_bed_contains}" missing`);
  }
  if (writeExpect.assigned_priority_order === 'ascending' && assigned.length > 1) {
    if (!priorityOrderValid(assigned)) {
      failures.push('assigned_priority_order not ascending by fill_priority');
    }
  }

  if (Array.isArray(writeExpect.attached_manual_services_includes)) {
    const attached = (w.attached_manual_services || []).map((row) => {
      const t = String(row.service_type || '').toLowerCase();
      return t === 'meal' ? 'meals' : t;
    });
    for (const svc of writeExpect.attached_manual_services_includes) {
      if (!attached.includes(String(svc).toLowerCase())) {
        failures.push(`attached_manual_services missing ${svc}`);
      }
    }
  }
  if (writeExpect.attached_service_no_fake_schedule === true) {
    const bad = (w.attached_manual_services || []).filter((row) => row.service_date != null);
    if (bad.length) {
      failures.push('attached manual service must not fake service_date');
    }
  }

  return failures;
}

function resolveHygieneWindow(fixture) {
  const hw = (fixture && (fixture.hygiene_window || fixture.proof_window)) || null;
  if (hw && hw.check_in && hw.check_out) {
    return { check_in: hw.check_in, check_out: hw.check_out };
  }
  return null;
}

async function runPrecleanHygiene(fixture, phone, opts) {
  const window = resolveHygieneWindow(fixture);
  const summary = {
    attempted: false,
    result: 'SKIPPED',
    skip_reason: null,
    found_unpaid_holds: 0,
    archived_or_cancelled: 0,
    skipped_paid_or_confirmed: 0,
  };
  if (!opts.precleanUnpaidHolds) return summary;

  summary.attempted = true;
  if (!opts.allowWrites) {
    summary.skip_reason = 'preclean_requires_allow_writes';
    summary.result = 'FAIL';
    return summary;
  }
  if (!window) {
    summary.skip_reason = 'fixture_missing_hygiene_window';
    summary.result = 'FAIL';
    return summary;
  }

  if (opts.allowStagingPaidProofReset) {
    if (!isAllowlistedProofPhone(phone)) {
      summary.skip_reason = 'paid_proof_reset_requires_allowlisted_test_phone';
      summary.result = 'FAIL';
      return summary;
    }
  }

  const out = await runLiveProofHygiene({
    client_slug: CLIENT_SLUG,
    phone,
    check_in: window.check_in,
    check_out: window.check_out,
    source: WRITE_SOURCE,
  }, {
    allow_hygiene: true,
    confirm_hygiene: true,
    dry_run: false,
    allow_staging_paid_proof_reset: opts.allowStagingPaidProofReset === true,
    host_header: 'localhost',
  });

  summary.found_unpaid_holds = out.found_unpaid_holds;
  summary.archived_or_cancelled = out.archived_or_cancelled;
  summary.skipped_paid_or_confirmed = out.skipped_paid_or_confirmed;
  summary.paid_proof_archived = out.paid_proof_archived || 0;
  summary.paid_proof_skipped_not_artifact = out.paid_proof_skipped_not_artifact || 0;
  summary.paid_proof_actions = out.paid_proof_actions || [];
  summary.refused_reason = out.refused_reason || null;
  summary.actions = out.actions || [];
  summary.skipped = out.skipped || [];
  summary.result = out.refused_reason ? 'FAIL' : 'PASS';
  return summary;
}

async function runWriteModeProof(fixture, lastOut, phone, contactName, opts) {
  const stripeRequired = isStripeCheckoutRequired(opts, fixture.write_expect);
  const proof = {
    attempted: true,
    result: 'SKIPPED',
    skip_reason: null,
    booking_write: null,
    stripe_link: null,
    booking_code: null,
    payment_draft_id: null,
    deposit_amount_cents: null,
    stripe_test_checkout_created: false,
    stripe_skip_reason: null,
    stripe_skipped: false,
    stripe_checkout_url: null,
    stripe_checkout_session_id: null,
    payment_status_after_checkout: null,
    payment_amount_paid_cents: 0,
    stripe_live_used: false,
    confirmation_sent: false,
    duplicate_booking_created: false,
    idempotency: null,
    cleanup: null,
    require_stripe_test_link: stripeRequired,
    stripe_gate_reasons: [],
    bed_assignment: null,
    assigned_beds: [],
    stripe_webhook: null,
    confirmation_preview: null,
    confirmation_send: null,
    hygiene: null,
  };

  const envCheck = assessWriteEnvironment();
  if (!envCheck.ok) {
    proof.skip_reason = envCheck.reasons.join('; ');
    return proof;
  }

  proof.hygiene = await runPrecleanHygiene(fixture, phone, opts);
  if (opts.precleanUnpaidHolds && proof.hygiene.result === 'FAIL') {
    proof.skip_reason = proof.hygiene.skip_reason || proof.hygiene.refused_reason || 'preclean_failed';
    proof.result = 'FAIL';
    return proof;
  }

  if (!isReadyForHoldWrite(lastOut)) {
    proof.skip_reason = 'payment_choice_not_ready_for_hold_write';
    return proof;
  }

  const chain = buildWriteChain(lastOut);
  const writeCtx = buildWriteContext(phone, contactName, lastOut.hold_payment_draft_plan);

  const bookingWrite = await withPgClient((pg) => runGuestHoldPaymentDraftWriteDryRunApproved(chain, {
    ...writeCtx,
    pg,
  }));
  proof.booking_write = bookingWrite;

  if (!bookingWrite.success) {
    proof.result = 'FAIL';
    proof.skip_reason = (bookingWrite.write_block_reasons || []).join('; ') || 'hold_write_failed';
    return proof;
  }

  proof.booking_code = bookingWrite.booking_code;
  proof.payment_draft_id = bookingWrite.payment_draft_id;
  proof.deposit_amount_cents = bookingWrite.created_records
    && bookingWrite.created_records.payment_draft
    && bookingWrite.created_records.payment_draft.amount_cents;
  if (proof.deposit_amount_cents == null && bookingWrite.reused_records
    && bookingWrite.reused_records.payment_draft) {
    proof.deposit_amount_cents = bookingWrite.reused_records.payment_draft.amount_cents;
  }
  if (proof.deposit_amount_cents == null && lastOut.hold_payment_draft_plan) {
    proof.deposit_amount_cents = lastOut.hold_payment_draft_plan.payment_amount_cents;
  }

  if (bookingWrite.booking_id && fixture.write_expect
    && (Array.isArray(fixture.write_expect.attached_manual_services_includes)
      || fixture.write_expect.attached_service_no_fake_schedule === true)) {
    proof.attached_manual_services = await withPgClient((pg) => loadAttachedManualGuestServices(pg, bookingWrite.booking_id));
  }

  proof.bed_assignment = await withPgClient((pg) => runOpenDemoBookingBedAssignApproved(pg, {
    client_slug: CLIENT_SLUG,
    booking_id: bookingWrite.booking_id,
    booking_code: bookingWrite.booking_code,
    review: {
      result: lastOut.result,
      availability: lastOut.availability,
      quote: lastOut.quote,
      payment_choice: lastOut.payment_choice,
    },
    env: { ...process.env, WHATSAPP_DRY_RUN: 'true' },
    host_header: 'localhost',
  }));
  if (proof.booking_code) {
    proof.assigned_beds = await withPgClient((pg) => loadAssignedBedsWithMeta(pg, proof.booking_code));
  }

  const stripeGate = evaluateStripeGate(
    bookingWrite.payment_draft_id,
    bookingWrite.booking_id,
    bookingWrite.booking_code,
  );
  proof.stripe_gate_reasons = stripeGate.reasons || [];
  if (stripeGate.allowed) {
    const stripeOut = await withPgClient((pg) => runGuestStripeTestLinkCreateApproved({
      payment_draft_id: bookingWrite.payment_draft_id,
      booking_id: bookingWrite.booking_id,
      booking_code: bookingWrite.booking_code,
      source: WRITE_SOURCE,
    }, { ...buildStripeContext(), pg }));
    proof.stripe_link = stripeOut;
    proof.stripe_test_checkout_created = stripeOut.stripe_link_created === true;
    proof.stripe_live_used = !isStripeTestSecretKey(process.env);
    proof.stripe_checkout_url = stripeOut.stripe_checkout_url || null;
    proof.stripe_checkout_session_id = stripeOut.stripe_checkout_session_id || null;
    proof.payment_status_after_checkout = stripeOut.payment_status || null;
    if (!proof.stripe_test_checkout_created) {
      proof.stripe_skip_reason = (stripeOut.block_reasons || []).join('; ');
      proof.stripe_skipped = true;
    }
  } else {
    proof.stripe_skip_reason = stripeGate.reasons.join('; ');
    proof.stripe_skipped = true;
  }

  if (proof.payment_draft_id) {
    const truth = await withPgClient((pg) => loadPaymentTruth(pg, proof.payment_draft_id));
    if (truth) {
      proof.payment_status_after_checkout = truth.payment_status;
      proof.payment_amount_paid_cents = Number(truth.amount_paid_cents || 0);
      if (!proof.stripe_checkout_url) proof.stripe_checkout_url = truth.checkout_url;
      if (!proof.stripe_checkout_session_id) {
        proof.stripe_checkout_session_id = truth.stripe_checkout_session_id;
      }
    }
    if (proof.booking_code) {
      const booking = await withPgClient((pg) => loadBookingForCleanup(pg, proof.booking_code));
      proof.confirmation_sent = !!(booking && booking.confirmation_sent_at);
    }
    await detectPaymentTruthReuse(proof);
  }

  if (fixture.write_expect && fixture.write_expect.idempotency_check === true) {
    const secondWrite = await withPgClient((pg) => runGuestHoldPaymentDraftWriteDryRunApproved(chain, {
      ...writeCtx,
      pg,
    }));
    const sameBooking = secondWrite.booking_id === bookingWrite.booking_id;
    const reused = secondWrite.write_status === 'reused_existing';
    proof.idempotency = {
      result: sameBooking && reused ? 'PASS' : 'FAIL',
      reason: sameBooking && reused ? null : `write_status=${secondWrite.write_status} booking_match=${sameBooking}`,
      first_booking_id: bookingWrite.booking_id,
      second_booking_id: secondWrite.booking_id,
      second_write_status: secondWrite.write_status,
    };
    proof.duplicate_booking_created = !sameBooking;
  }

  if (opts.simulateStripeWebhook) {
    proof.stripe_webhook = await simulateStripeWebhookPaymentTruth(proof, opts);
    if (proof.stripe_webhook) {
      proof.confirmation_sent = proof.stripe_webhook.confirmation_sent === true;
    }
  }

  if (opts.expectConfirmationPreview) {
    proof.confirmation_preview = await runConfirmationPreviewProof(proof, fixture, opts);
    if (proof.confirmation_preview) {
      proof.confirmation_sent = proof.confirmation_preview.confirmation_sent === true;
    }
  }

  if (opts.attemptConfirmationSend) {
    proof.confirmation_send = await runConfirmationSendProof(proof, fixture, phone, opts);
    if (proof.confirmation_send) {
      proof.confirmation_sent = proof.confirmation_send.confirmation_sent === true;
    }
  }

  const webhookApplied = proof.stripe_webhook && proof.stripe_webhook.result === 'PASS';

  if (!opts.keepBookings && proof.booking_code) {
    if (webhookApplied) {
      proof.cleanup = {
        result: 'refused',
        reason: 'paid_booking_cleanup_refused',
        booking_payment_status: proof.stripe_webhook && proof.stripe_webhook.booking_payment_status_after,
        booking_code: proof.booking_code,
      };
    } else if (fixture.write_expect && fixture.write_expect.cleanup_expected === true) {
      proof.cleanup = await withPgClient((pg) => cleanupUnpaidTestBooking(pg, proof.booking_code));
    }
  } else if (opts.keepBookings) {
    proof.cleanup = { result: 'skipped', reason: '--keep-bookings' };
  }

  const writeFailures = checkWriteExpectations(
    fixture.write_expect,
    proof,
    opts,
    fixture.webhook_expect,
    fixture.confirmation_expect,
    fixture.confirmation_send_expect,
  );
  proof.result = writeFailures.length === 0 ? 'PASS' : 'FAIL';
  if (proof.result === 'PASS' && proof.confirmation_preview && proof.confirmation_preview.result === 'PARTIAL') {
    proof.result = 'PARTIAL';
  }
  if (proof.result === 'PASS' && proof.confirmation_send && proof.confirmation_send.result === 'PARTIAL') {
    proof.result = 'PARTIAL';
  }
  proof.write_failures = writeFailures;
  proof.stripe_outcome = proof.stripe_test_checkout_created
    ? 'created'
    : (stripeRequired ? 'FAIL_required' : 'PASS_optional');
  return proof;
}

function printConfirmationSendDiagnostics(wm) {
  const cs = wm && wm.confirmation_send;
  if (!cs || !cs.attempted) return;
  console.log(`    confirmation_send: ${cs.result}${cs.skip_reason ? ` (${cs.skip_reason})` : ''}`);
  if (cs.without_approval) {
    console.log(`    send without approval: ${normalizeFixtureSendStatus(cs.without_approval.send_status)}`);
  }
  if (cs.with_approval) {
    console.log(`    send with approval: ${cs.with_approval.send_status} sends_whatsapp=${cs.with_approval.sends_whatsapp === true}`);
    console.log(`    provider_send_performed: ${cs.provider_send_performed === true}`);
  }
  if (cs.duplicate_attempt) {
    console.log(`    duplicate send: ${cs.duplicate_attempt.send_status} sends_whatsapp=${cs.duplicate_attempt.sends_whatsapp === true}`);
    console.log(`    duplicate blocked: ${cs.duplicate_attempt.sends_whatsapp !== true}`);
  }
  console.log(`    message_matches_preview: ${cs.message_matches_preview === true}`);
  console.log(`    confirmation_sent: ${cs.confirmation_sent === true}`);
  console.log(`    confirmation_sent_at unchanged: ${(cs.confirmation_sent_at_before || null) === (cs.confirmation_sent_at_after || null)}`);
  console.log(`    whatsapp_dry_run: ${cs.whatsapp_dry_run !== false}`);
  console.log(`    calls_n8n: ${cs.calls_n8n === true}`);
}

function printConfirmationPreviewDiagnostics(wm) {
  const cp = wm && wm.confirmation_preview;
  if (!cp || !cp.attempted) return;
  console.log(`    confirmation_preview: ${cp.result}${cp.skip_reason ? ` (${cp.skip_reason})` : ''}`);
  console.log(`    confirmation_preview_ready: ${cp.confirmation_preview_ready === true}`);
  console.log(`    payment_status: ${cp.payment_status || '—'} amount_paid_cents: ${cp.amount_paid_cents}`);
  console.log(`    gate_code present: ${cp.gate_code_present === true}`);
  console.log(`    room_label present: ${cp.room_label_present === true}`);
  console.log(`    bed_number exposed: ${cp.bed_number_exposed === true}`);
  console.log(`    confirmation_sent: ${cp.confirmation_sent === true}`);
  console.log(`    confirmation_sent_at unchanged: ${(cp.confirmation_sent_at_before || null) === (cp.confirmation_sent_at_after || null)}`);
  if (cp.proposed_confirmation_message) {
    const summary = String(cp.proposed_confirmation_message).replace(/\n/g, ' ').slice(0, wm && wm.result === 'PARTIAL' ? 500 : 200);
    console.log(`    confirmation message: ${summary}`);
  }
}

function printStripeWebhookDiagnostics(wm) {
  const wh = wm && wm.stripe_webhook;
  if (!wh || !wh.attempted) return;
  console.log(`    stripe_webhook: ${wh.result}${wh.skip_reason ? ` (${wh.skip_reason})` : ''}`);
  console.log(`    stripe_checkout_session_id: ${wh.stripe_checkout_session_id || '—'}`);
  console.log(`    payment_draft_id: ${wh.payment_draft_id || '—'}`);
  console.log(`    booking_code: ${wh.booking_code || '—'}`);
  console.log(`    payment_status before/after webhook: ${wh.payment_status_before || '—'} → ${wh.payment_status_after || '—'}`);
  console.log(`    booking payment_status before/after: ${wh.booking_payment_status_before || '—'} → ${wh.booking_payment_status_after || '—'}`);
  console.log(`    amount_paid_cents before/after: ${wh.amount_paid_cents_before} → ${wh.amount_paid_cents_after}`);
  if (wh.balance_due_cents_after != null) {
    console.log(`    balance_due_cents after webhook: ${wh.balance_due_cents_after}`);
  }
  console.log(`    booking_status after webhook: ${wh.booking_status_after || '—'}`);
  console.log(`    confirmation_sent: ${wh.confirmation_sent === true}`);
  console.log(`    confirmation_sent_at before/after: ${wh.confirmation_sent_at_before || 'null'} → ${wh.confirmation_sent_at_after || 'null'}`);
  if (wh.idempotency) console.log(`    webhook idempotency: ${wh.idempotency.result}`);
  if (wh.no_duplicate_payment_truth != null) {
    console.log(`    no_duplicate_payment_truth: ${wh.no_duplicate_payment_truth}`);
  }
  printConfirmationPreviewDiagnostics(wm);
  printConfirmationSendDiagnostics(wm);
}

function printBedAssignmentDiagnostics(wm) {
  if (!wm || !wm.bed_assignment) return;
  const ba = wm.bed_assignment;
  console.log(`    bed_assignment: ${ba.assignment_write_status || '—'} beds=${(wm.assigned_beds || []).length}`);
  for (const bed of wm.assigned_beds || []) {
    console.log(`      ${bed.room_code}/${bed.bed_code} fill_priority=${bed.fill_priority} gender=${bed.gender_strategy || '—'} operator=${bed.often_used_by_operator === true}`);
  }
  if ((wm.assigned_beds || []).length > 1) {
    console.log(`    assignment_priority_ascending: ${priorityOrderValid(wm.assigned_beds)}`);
  }
}

function printStripeWriteDiagnostics(wm) {
  if (!wm) return;
  console.log(`    write: ${wm.result} booking=${wm.booking_code || '—'} draft=${wm.payment_draft_id || '—'}`);
  printBedAssignmentDiagnostics(wm);
  if (wm.stripe_test_checkout_created) {
    console.log('    stripe_test_checkout_created: true');
    console.log(`    checkout_url present: ${!!wm.stripe_checkout_url}`);
    console.log(`    checkout_session_id present: ${!!wm.stripe_checkout_session_id}`);
    console.log(`    payment_status after checkout: ${wm.payment_status_after_checkout || '—'}`);
    console.log(`    confirmation_sent: ${wm.confirmation_sent === true}`);
    console.log(`    stripe_live_used: ${wm.stripe_live_used === true}`);
  } else if (wm.stripe_skipped || wm.stripe_skip_reason) {
    console.log('    stripe skipped: true');
    console.log(`    missing gate/env: ${wm.stripe_skip_reason || wm.stripe_gate_reasons.join('; ') || 'unknown'}`);
    console.log(`    require_stripe_test_link: ${wm.require_stripe_test_link === true}`);
    console.log(`    outcome: ${wm.stripe_outcome || (wm.require_stripe_test_link ? 'FAIL_required' : 'PASS_optional')}`);
  } else {
    console.log(`    stripe_test_checkout_created: ${wm.stripe_test_checkout_created}`);
  }
  if (wm.cleanup) console.log(`    cleanup: ${wm.cleanup.result}${wm.cleanup.reason ? ` (${wm.cleanup.reason})` : ''}${wm.cleanup.booking_code ? ` booking=${wm.cleanup.booking_code}` : ''}`);
  if (wm.idempotency) console.log(`    idempotency: ${wm.idempotency.result}`);
  printStripeWebhookDiagnostics(wm);
}

function loadFixtures(fixtureDir) {
  if (!fs.existsSync(fixtureDir)) {
    throw new Error(`fixture directory not found: ${fixtureDir}`);
  }
  const files = fs.readdirSync(fixtureDir).filter((f) => f.endsWith('.json')).sort();
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(fixtureDir, file), 'utf8');
    const data = JSON.parse(raw);
    if (!data.id) data.id = path.basename(file, '.json');
    return data;
  });
}

function filterFixtures(fixtures, opts) {
  let out = fixtures.slice();
  if (opts.fixture) {
    const needle = opts.fixture.replace(/\.json$/, '');
    out = out.filter((f) => f.id === needle || f.id.includes(needle));
  } else if (!opts.all) {
    out = out.slice(0, 1);
  }
  if (opts.limit != null && opts.limit > 0) out = out.slice(0, opts.limit);
  return out;
}

function applyChannelContactName(guestContext, contactName) {
  if (!contactName) return guestContext || undefined;
  const gc = guestContext ? { ...guestContext } : {};
  if (!gc.contact_name) gc.contact_name = contactName;
  if (!gc.whatsapp_guest_name) gc.whatsapp_guest_name = contactName;
  return gc;
}

function guestContextFromOrchestrator(out, contactName) {
  const r = out || {};
  return applyChannelContactName(normalizeGuestContextForChain({
    message_lane: r.result && r.result.message_lane,
    intake_state: r.result && r.result.intake_state,
    readiness_state: r.result && r.result.readiness_state,
    booking_intake_ready: r.result && r.result.booking_intake_ready,
    extracted_fields: r.result && r.result.extracted_fields,
    package_night_rule: r.result && r.result.package_night_rule,
    result: r.result,
    availability: r.availability,
    quote: r.quote,
    payment_choice: r.payment_choice,
    hold_payment_draft_plan: r.hold_payment_draft_plan,
    detected_language: r.result && r.result.detected_language,
    previous_quote_invalidated: r.result && r.result.previous_quote_invalidated,
    stale_quote_reason: r.result && r.result.stale_quote_reason,
    corrected_fields: r.result && r.result.corrected_fields,
    new_booking_reset: r.result && r.result.new_booking_reset,
  }), contactName);
}

function findInternalLanguage(text) {
  const lower = String(text || '').toLowerCase();
  return INTERNAL_LANGUAGE_BLACKLIST.filter((term) => lower.includes(term.toLowerCase()));
}

function isHandoff(out) {
  const r = out.result || {};
  if (r.safe_handoff_required === true) return true;
  if (out.proposed_next_action === 'staff_handoff_required') return true;
  const gate = out.automation_gate || {};
  return gate.gate_status === 'blocked' || gate.gate_status === 'staff_handoff';
}

function buildTurnDiagnostic(turnIndex, message, out) {
  const r = out.result || {};
  const policy = r.booking_intake_policy || {};
  const brain = r.conversation_brain || {};
  return {
    turn: turnIndex + 1,
    guest_message: message,
    luna_reply: out.proposed_luna_reply || r.proposed_luna_reply || '',
    message_lane: r.message_lane || null,
    brain_intent: brain.intent || null,
    booking_flow_stage: policy.booking_flow_stage || null,
    next_required_field: policy.next_required_field || null,
    extracted_fields: r.extracted_fields || {},
    missing_required_fields: r.missing_required_fields || [],
    readiness_missing_fields: r.readiness_missing_fields || [],
    quote_status: out.quote && out.quote.quote_status,
    quote_total_cents: out.quote && out.quote.quote_total_cents,
    availability_status: out.availability && out.availability.availability_status,
    payment_choice_ready: out.payment_choice && out.payment_choice.payment_choice_ready,
    payment_choice: out.payment_choice && out.payment_choice.payment_choice,
    proposed_next_action: out.proposed_next_action || null,
    safe_handoff_required: r.safe_handoff_required === true,
    handoff_reasons: r.handoff_reasons || [],
    dry_run: out.dry_run,
    no_write_performed: out.no_write_performed,
    sends_whatsapp: out.sends_whatsapp,
    creates_booking: out.creates_booking,
    creates_stripe_link: out.creates_stripe_link,
    payment_link_sent: out.payment_link_sent,
    confirmation_sent: out.confirmation_sent === true,
    internal_language: findInternalLanguage(out.proposed_luna_reply || ''),
    final_reply_source: (r.conversation_brain && r.conversation_brain.final_reply_source) || null,
    composer_state: (r.conversation_brain && r.conversation_brain.composer_state) || null,
  };
}

function printTurnDiagnostic(diag, verbose) {
  console.log(`\n  Turn ${diag.turn}: "${diag.guest_message}"`);
  console.log(`    Luna: ${String(diag.luna_reply).replace(/\n/g, ' ').slice(0, verbose ? 500 : 160)}`);
  console.log(`    lane=${diag.message_lane} intent=${diag.brain_intent} stage=${diag.booking_flow_stage} next=${diag.next_required_field}`);
  console.log(`    quote=${diag.quote_status} avail=${diag.availability_status} pay=${diag.payment_choice} ready=${diag.payment_choice_ready}`);
  console.log(`    action=${diag.proposed_next_action} handoff=${diag.safe_handoff_required}`);
  if (verbose) {
    console.log(`    fields=${JSON.stringify(diag.extracted_fields)}`);
    console.log(`    missing=${JSON.stringify(diag.missing_required_fields)}`);
    if (diag.handoff_reasons.length) console.log(`    handoff_reasons=${JSON.stringify(diag.handoff_reasons)}`);
    if (diag.internal_language.length) console.log(`    internal_language=${JSON.stringify(diag.internal_language)}`);
  }
}

function checkObjectSubset(expected, actual, label) {
  const failures = [];
  if (!expected || typeof expected !== 'object') return failures;
  for (const [key, val] of Object.entries(expected)) {
    const got = actual && actual[key];
    if (got !== val) failures.push(`${label}.${key} expected ${JSON.stringify(val)} got ${JSON.stringify(got)}`);
  }
  return failures;
}

function checkTurnExpectations(expect, out) {
  const failures = [];
  if (!expect || typeof expect !== 'object') return failures;
  const reply = String(out.proposed_luna_reply || (out.result && out.result.proposed_luna_reply) || '');
  const fields = (out.result && out.result.extracted_fields) || {};
  const policy = (out.result && out.result.booking_intake_policy) || {};

  if (Array.isArray(expect.reply_contains)) {
    for (const needle of expect.reply_contains) {
      if (!reply.toLowerCase().includes(String(needle).toLowerCase())) {
        failures.push(`reply_contains "${needle}" missing`);
      }
    }
  }
  if (Array.isArray(expect.reply_not_contains)) {
    for (const needle of expect.reply_not_contains) {
      if (reply.toLowerCase().includes(String(needle).toLowerCase())) {
        failures.push(`reply_not_contains "${needle}" found`);
      }
    }
  }
  failures.push(...checkObjectSubset(expect.expected_fields, fields, 'expected_fields'));
  if (expect.expected_booking_flow_stage != null
    && policy.booking_flow_stage !== expect.expected_booking_flow_stage) {
    failures.push(`expected_booking_flow_stage ${expect.expected_booking_flow_stage} got ${policy.booking_flow_stage}`);
  }
  if (expect.expected_next_required_field != null
    && policy.next_required_field !== expect.expected_next_required_field) {
    failures.push(`expected_next_required_field ${expect.expected_next_required_field} got ${policy.next_required_field}`);
  }
  if (expect.expected_no_handoff === true && isHandoff(out)) {
    failures.push('expected_no_handoff but handoff required');
  }
  if (expect.expected_payment_choice != null) {
    const pc = out.payment_choice && out.payment_choice.payment_choice;
    if (pc !== expect.expected_payment_choice) {
      failures.push(`expected_payment_choice ${expect.expected_payment_choice} got ${pc}`);
    }
  }
  if (expect.expected_quote_ready === true) {
    const qs = out.quote && out.quote.quote_status;
    if (qs !== 'ready') failures.push(`expected_quote_ready but quote_status=${qs}`);
  }
  if (expect.expected_quote_ready === false) {
    const qs = out.quote && out.quote.quote_status;
    if (qs === 'ready') failures.push('expected_quote_ready false but quote is ready');
  }
  if (expect.expected_hold_plan_ready === true) {
    const plan = out.hold_payment_draft_plan || {};
    if (plan.plan_status !== 'ready' || plan.plan_handoff_required === true) {
      failures.push(`expected_hold_plan_ready but plan_status=${plan.plan_status} handoff=${plan.plan_handoff_required} reasons=${JSON.stringify(plan.plan_handoff_reasons || [])}`);
    }
  }
  if (expect.expected_stale_quote === true) {
    const stale = (out.result && out.result.previous_quote_invalidated === true)
      || (out.quote && out.quote.quote_stale === true)
      || (out.quote && out.quote.previous_quote_invalidated === true);
    if (!stale) failures.push('expected_stale_quote but quote was not invalidated');
  }
  if (expect.expected_stale_quote === false) {
    const stale = (out.result && out.result.previous_quote_invalidated === true)
      || (out.quote && out.quote.quote_stale === true);
    if (stale) failures.push('expected_stale_quote false but quote was invalidated');
  }
  if (expect.expected_stale_quote_reason != null) {
    const reason = (out.result && out.result.stale_quote_reason)
      || (out.quote && out.quote.stale_quote_reason);
    if (String(reason) !== String(expect.expected_stale_quote_reason)) {
      failures.push(`expected_stale_quote_reason ${expect.expected_stale_quote_reason} got ${reason}`);
    }
  }
  if (Array.isArray(expect.expected_corrected_fields)) {
    const got = (out.result && out.result.corrected_fields)
      || (out.quote && out.quote.corrected_fields)
      || [];
    for (const field of expect.expected_corrected_fields) {
      if (!got.includes(field)) failures.push(`expected_corrected_fields missing ${field}`);
    }
  }
  if (expect.expected_reset_detected === true) {
    if (!(out.result && out.result.new_booking_reset === true)) {
      failures.push('expected_reset_detected but new_booking_reset not set');
    }
  }
  if (expect.expected_package != null) {
    const pkg = fields.package_interest;
    if (String(pkg).toLowerCase() !== String(expect.expected_package).toLowerCase()) {
      failures.push(`expected_package ${expect.expected_package} got ${pkg}`);
    }
  }
  if (expect.expected_guest_count != null && fields.guest_count !== expect.expected_guest_count) {
    failures.push(`expected_guest_count ${expect.expected_guest_count} got ${fields.guest_count}`);
  }
  if (expect.expected_dates != null) {
    if (expect.expected_dates.check_in && fields.check_in !== expect.expected_dates.check_in) {
      failures.push(`expected check_in ${expect.expected_dates.check_in} got ${fields.check_in}`);
    }
    if (expect.expected_dates.check_out && fields.check_out !== expect.expected_dates.check_out) {
      failures.push(`expected check_out ${expect.expected_dates.check_out} got ${fields.check_out}`);
    }
  }
  if (expect.expected_no_payment_link_before_updated_quote === true) {
    if (/checkout\.stripe\.com/i.test(reply)) {
      failures.push('stripe payment link present before updated quote');
    }
  }
  if (expect.expected_context_preserved === true) {
    const hasDates = fields.check_in && fields.check_out;
    const hasGuests = fields.guest_count != null;
    if (!hasDates && !hasGuests && !fields.package_interest) {
      failures.push('expected_context_preserved but booking fields missing');
    }
  }
  if (expect.no_internal_language === true) {
    const bad = findInternalLanguage(reply);
    if (bad.length) failures.push(`internal language: ${bad.join(', ')}`);
  }
  if (expect.no_form_dev_copy === true && isFormDevCopy(reply)) {
    failures.push('form/dev copy detected in reply');
  }
  if (expect.expected_reply_source != null) {
    const src = (out.result && out.result.conversation_brain && out.result.conversation_brain.final_reply_source);
    if (src !== expect.expected_reply_source) {
      failures.push(`expected_reply_source ${expect.expected_reply_source} got ${src}`);
    }
  }
  if (expect.expected_composer_state != null) {
    const cs = (out.result && out.result.conversation_brain && out.result.conversation_brain.composer_state);
    if (cs !== expect.expected_composer_state) {
      failures.push(`expected_composer_state ${expect.expected_composer_state} got ${cs}`);
    }
  }
  return failures;
}

function checkFinalExpectations(finalExpect, lastOut, allTurns) {
  const failures = [];
  if (!finalExpect || typeof finalExpect !== 'object') return failures;
  const reply = String(lastOut.proposed_luna_reply || '');
  const fields = (lastOut.result && lastOut.result.extracted_fields) || {};

  failures.push(...checkObjectSubset(finalExpect.expected_fields, fields, 'final.expected_fields'));

  if (finalExpect.confirmation_sent === false) {
    if (lastOut.confirmation_sent === true) failures.push('confirmation_sent expected false');
    const anyConfirm = allTurns.some((t) => t.confirmation_sent === true);
    if (anyConfirm) failures.push('confirmation_sent true on a turn');
  }
  if (finalExpect.no_internal_language === true) {
    for (const t of allTurns) {
      if (t.internal_language && t.internal_language.length) {
        failures.push(`internal language turn ${t.turn}: ${t.internal_language.join(', ')}`);
      }
      if (finalExpect.no_form_dev_copy === true && isFormDevCopy(t.luna_reply || '')) {
        failures.push(`form/dev copy turn ${t.turn}`);
      }
    }
  }
  if (finalExpect.expected_final_reply_source != null) {
    const src = (lastOut.result && lastOut.result.conversation_brain
      && lastOut.result.conversation_brain.final_reply_source);
    if (src !== finalExpect.expected_final_reply_source) {
      failures.push(`expected_final_reply_source ${finalExpect.expected_final_reply_source} got ${src}`);
    }
  }
  if (finalExpect.no_package_prompt === true) {
    const addonTurn = allTurns.find((t) => /no thanks|own stuff/i.test(t.guest_message));
    if (addonTurn && PACKAGE_NAMES_RE.test(addonTurn.luna_reply)) {
      failures.push('package names appeared during short-stay accommodation-only flow');
    }
  }
  if (finalExpect.no_handoff === true) {
    const handoffTurn = allTurns.find((t) => t.safe_handoff_required);
    if (handoffTurn) failures.push(`handoff on turn ${handoffTurn.turn}`);
    if (isHandoff(lastOut)) failures.push('final handoff required');
  }
  if (finalExpect.expected_payment_choice != null) {
    const pc = lastOut.payment_choice && lastOut.payment_choice.payment_choice;
    if (pc !== finalExpect.expected_payment_choice) {
      failures.push(`final expected_payment_choice ${finalExpect.expected_payment_choice} got ${pc}`);
    }
  }
  if (finalExpect.expected_quote_ready === true) {
    const qs = lastOut.quote && lastOut.quote.quote_status;
    if (qs !== 'ready') failures.push(`final expected_quote_ready but quote_status=${qs}`);
  }
  if (finalExpect.expected_quote_total_cents != null) {
    const cents = lastOut.quote && lastOut.quote.quote_total_cents;
    if (cents !== finalExpect.expected_quote_total_cents) {
      failures.push(`expected_quote_total_cents ${finalExpect.expected_quote_total_cents} got ${cents}`);
    }
  }
  if (finalExpect.booking_created === true && lastOut.creates_booking !== true) {
    failures.push('booking_created expected true');
  }
  if (finalExpect.booking_created === false && lastOut.creates_booking === true) {
    failures.push('booking_created expected false');
  }
  if (finalExpect.payment_link_created === true && lastOut.creates_stripe_link !== true) {
    failures.push('payment_link_created expected true');
  }
  if (finalExpect.payment_link_created === false && lastOut.creates_stripe_link === true) {
    failures.push('payment_link_created expected false');
  }
  return failures;
}

function checkSafetyDefaults(out) {
  const failures = [];
  if (out.dry_run !== true) failures.push(`dry_run expected true got ${out.dry_run}`);
  if (out.sends_whatsapp !== false) failures.push(`sends_whatsapp expected false got ${out.sends_whatsapp}`);
  if (out.live_send_blocked !== true) failures.push(`live_send_blocked expected true got ${out.live_send_blocked}`);
  if (out.calls_n8n === true) failures.push('calls_n8n must not be true');
  if (out.confirmation_sent === true) failures.push('confirmation_sent must not be true');
  return failures;
}

async function runFixture(fixture, opts, fixtureIndex) {
  const contactName = fixture.contact_name || null;
  const referenceDate = fixture.reference_date || opts.referenceDate;
  const phone = `${opts.phonePrefix}${String(fixtureIndex + 1).padStart(2, '0')}`;
  const result = {
    id: fixture.id,
    label: fixture.label || fixture.id,
    phone,
    contact_name: contactName,
    result: 'PASS',
    turns: [],
    failures: [],
    deposit_detected: false,
    internal_language_found: [],
    writes_or_sends: false,
    write_mode: null,
  };

  let guestContext = applyChannelContactName(null, contactName);
  let lastOut = null;

  for (let ti = 0; ti < fixture.turns.length; ti++) {
    const turn = fixture.turns[ti];
    const message = typeof turn === 'string' ? turn : turn.message;
    const input = {
      client_slug: CLIENT_SLUG,
      channel: 'whatsapp',
      message_text: message,
      guest_phone: phone,
      guest_context: guestContext,
      reference_date: referenceDate,
      language_hint: fixture.language || 'en',
      dry_run: true,
      automation_gate_context: {
        public_guest_automation_enabled: false,
        whatsapp_dry_run: true,
        live_send_allowed: false,
      },
    };

    lastOut = await withPgClient((pg) => runGuestAutomationOrchestratorDryRun(input, {
      reference_date: referenceDate,
      guest_phone: phone,
      dry_run: true,
      pg,
    }));

    const diag = buildTurnDiagnostic(ti, message, lastOut);
    result.turns.push(diag);
    if (diag.payment_choice === 'deposit' || diag.payment_choice === 'full_payment') {
      result.deposit_detected = diag.payment_choice === 'deposit' || result.deposit_detected;
    }
    if (diag.payment_choice_ready && diag.payment_choice === 'deposit') result.deposit_detected = true;
    if (diag.internal_language.length) result.internal_language_found.push(...diag.internal_language);
    if (diag.creates_booking || diag.creates_stripe_link || diag.payment_link_sent || diag.sends_whatsapp) {
      result.writes_or_sends = true;
    }

    const safetyFailures = checkSafetyDefaults(lastOut);
    const expectFailures = checkTurnExpectations(turn.expect, lastOut);
    const turnFailures = [...safetyFailures, ...expectFailures];

    if (!opts.json) printTurnDiagnostic(diag, opts.verbose);

    if (turnFailures.length > 0) {
      result.failures.push(...turnFailures.map((f) => `turn ${ti + 1}: ${f}`));
      result.result = 'FAIL';
      break;
    }

    guestContext = guestContextFromOrchestrator(lastOut, contactName);
  }

  if (result.result !== 'FAIL' && fixture.final_expect && lastOut) {
    const finalFailures = checkFinalExpectations(fixture.final_expect, lastOut, result.turns);
    if (finalFailures.length > 0) {
      result.failures.push(...finalFailures.map((f) => `final: ${f}`));
      result.result = 'FAIL';
    }
  }

  if (result.result !== 'FAIL' && opts.allowWrites && fixture.write_expect && lastOut) {
    result.write_mode = await runWriteModeProof(fixture, lastOut, phone, contactName, opts);
    if (result.write_mode.result === 'FAIL') {
      result.failures.push(...(result.write_mode.write_failures || []).map((f) => `write: ${f}`));
      if (result.write_mode.skip_reason && !result.write_mode.booking_write) {
        result.failures.push(`write: ${result.write_mode.skip_reason}`);
      }
      result.result = 'FAIL';
    } else if (result.write_mode.result === 'SKIPPED') {
      if (opts.requireStripeTestLink) {
        result.failures.push(`write: stripe_test_checkout_required but write skipped: ${result.write_mode.skip_reason}`);
        result.result = 'FAIL';
      } else {
        result.result = 'PARTIAL';
        result.write_skip_reason = result.write_mode.skip_reason;
      }
    } else if (result.write_mode.result === 'PARTIAL') {
      result.result = 'PARTIAL';
      result.writes_or_sends = true;
    } else if (result.write_mode.booking_write) {
      result.writes_or_sends = true;
    }
    if (!opts.json && result.write_mode) {
      printStripeWriteDiagnostics(result.write_mode);
    }
  }

  return result;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }

  if (opts.precleanUnpaidHolds && !opts.allowWrites) {
    console.error('FAIL — --preclean-unpaid-holds requires --allow-writes');
    process.exit(1);
  }

  if (opts.allowStagingPaidProofReset && !opts.precleanUnpaidHolds) {
    console.error('FAIL — --allow-staging-paid-proof-reset requires --preclean-unpaid-holds');
    process.exit(1);
  }

  if (opts.allowStagingPaidProofReset && !opts.allowWrites) {
    console.error('FAIL — --allow-staging-paid-proof-reset requires --allow-writes');
    process.exit(1);
  }

  if (opts.requireStripeTestLink && !opts.allowWrites) {
    console.error('FAIL — --require-stripe-test-link requires --allow-writes');
    process.exit(1);
  }

  if (opts.simulateStripeWebhook && !opts.allowWrites) {
    console.error('FAIL — --simulate-stripe-webhook requires --allow-writes');
    process.exit(1);
  }

  if (opts.simulateStripeWebhook && !opts.requireStripeTestLink) {
    console.error('FAIL — --simulate-stripe-webhook requires --require-stripe-test-link');
    process.exit(1);
  }

  if (opts.expectConfirmationPreview && !opts.simulateStripeWebhook) {
    console.error('FAIL — --expect-confirmation-preview requires --simulate-stripe-webhook');
    process.exit(1);
  }

  if (opts.attemptConfirmationSend && !opts.expectConfirmationPreview) {
    console.error('FAIL — --attempt-confirmation-send requires --expect-confirmation-preview');
    process.exit(1);
  }

  if (opts.allowRealWhatsappSend && !opts.attemptConfirmationSend) {
    console.error('FAIL — --allow-real-whatsapp-send requires --attempt-confirmation-send');
    process.exit(1);
  }

  if (opts.allowRealWhatsappSend) {
    try {
      assertNotProduction();
      assertNotProductionDb(defaultConnectionString());
    } catch (e) {
      console.error(`FAIL — --allow-real-whatsapp-send blocked: ${e.message}`);
      process.exit(1);
    }
    if (isWhatsappDryRun(process.env)) {
      console.error('FAIL — --allow-real-whatsapp-send requires WHATSAPP_DRY_RUN=false in environment');
      process.exit(1);
    }
  }

  if (opts.allowWrites) {
    try {
      assertNotProduction();
    } catch (e) {
      console.error(`FAIL — ${e.message}`);
      process.exit(1);
    }
    if (!opts.json) {
      for (const line of liveProofHygieneGuidanceLines()) {
        console.error(`NOTE — ${line}`);
      }
    }
  }

  if (!opts.all && !opts.fixture) {
    console.error('Specify --all or --fixture <name>');
    usage();
    process.exit(1);
  }

  const fixtures = filterFixtures(loadFixtures(opts.fixtureDir), opts);
  if (fixtures.length === 0) {
    console.error('No fixtures matched.');
    process.exit(1);
  }

  const report = {
    result: 'PASS',
    mode: opts.allowWrites
      ? (opts.attemptConfirmationSend
        ? 'conversation_dry_run_plus_write_proof_confirmation_send'
        : (opts.expectConfirmationPreview
          ? 'conversation_dry_run_plus_write_proof_confirmation_preview'
          : (opts.simulateStripeWebhook
            ? 'conversation_dry_run_plus_write_proof_stripe_webhook'
            : (opts.requireStripeTestLink
              ? 'conversation_dry_run_plus_write_proof_stripe_required'
              : 'conversation_dry_run_plus_write_proof'))))
      : 'dry_run_review_only',
    fixture_dir: opts.fixtureDir,
    reference_date: opts.referenceDate,
    total: fixtures.length,
    passed: 0,
    failed: 0,
    partial: 0,
    fixtures: [],
    first_failure: null,
  };

  if (!opts.json) {
    console.log('\n── Luna Conversation State-Machine Tests ──');
    console.log(`Mode: ${report.mode} · Fixtures: ${fixtures.length}`);
  }

  for (let i = 0; i < fixtures.length; i++) {
    const fx = fixtures[i];
    if (!opts.json) console.log(`\n▶ ${fx.id} — ${fx.label || fx.id}`);
    let fxResult;
    try {
      fxResult = await runFixture(fx, opts, i);
    } catch (err) {
      fxResult = {
        id: fx.id,
        result: 'FAIL',
        failures: [err.message || String(err)],
        turns: [],
      };
    }
    report.fixtures.push(fxResult);
    if (fxResult.result === 'PASS') report.passed++;
    else if (fxResult.result === 'PARTIAL') {
      report.partial++;
      if (report.result === 'PASS') report.result = 'PARTIAL';
    } else {
      report.failed++;
      report.result = 'FAIL';
      if (!report.first_failure) {
        report.first_failure = { id: fxResult.id, failures: fxResult.failures };
      }
      if (!opts.json) {
        console.log(`  FAIL  ${fxResult.id}`);
        for (const f of fxResult.failures) console.log(`         ${f}`);
      }
    }
    if ((fxResult.result === 'PASS' || fxResult.result === 'PARTIAL') && !opts.json) {
      const tag = fxResult.result === 'PARTIAL' ? 'PARTIAL' : 'PASS';
      console.log(`  ${tag}  ${fxResult.id} · deposit=${fxResult.deposit_detected} · writes/sends=${fxResult.writes_or_sends}`);
      if (fxResult.write_skip_reason) console.log(`         write skipped: ${fxResult.write_skip_reason}`);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n── Result: ${report.result} ──`);
    console.log(`Passed: ${report.passed} · Partial: ${report.partial} · Failed: ${report.failed} / ${report.total}`);
  }

  process.exit(report.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
