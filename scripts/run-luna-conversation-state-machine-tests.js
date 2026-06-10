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
const {
  assertNotProductionDb,
  assessCleanupEligibility,
  defaultConnectionString,
  UNPAID_PAYMENT_CANCEL_STATUSES,
} = require('./lib/open-demo-playground-common');

const WRITE_SOURCE = 'luna_conversation_state_machine_tester';

const CLIENT_SLUG = 'wolfhouse-somo';
const DEFAULT_FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'luna-conversation-state-machine');
const DEFAULT_REFERENCE_DATE = '2026-06-10';
const PACKAGE_NAMES_RE = /\b(?:Malibu|Uluwatu|Waimea)\b/i;

const INTERNAL_LANGUAGE_BLACKLIST = [
  'dry run',
  'staging',
  'automation gate',
  'quote_status',
  'payment_choice',
  'guest_context',
  'intake_state',
  'i am not confirming the booking',
  'i am not creating a hold',
  'i am not sending a payment link',
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
  --allow-writes           After conversation, run hold/draft + Stripe TEST write proof
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

function checkWriteExpectations(writeExpect, proof) {
  const failures = [];
  if (!writeExpect || typeof writeExpect !== 'object') return failures;
  const w = proof || {};

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
  if (stripeExpect === true) {
    if (!w.stripe_test_checkout_created) {
      failures.push(`stripe_test_checkout_created expected true (${w.stripe_skip_reason || 'gate blocked'})`);
    }
  } else if (stripeExpect === false) {
    if (w.stripe_test_checkout_created) failures.push('stripe_test_checkout_created expected false');
  }

  if (writeExpect.cleanup_expected === true && w.cleanup && w.cleanup.result === 'error') {
    failures.push(`cleanup failed: ${w.cleanup.reason}`);
  }

  if (writeExpect.idempotency_check === true) {
    if (!w.idempotency || w.idempotency.result !== 'PASS') {
      failures.push(`idempotency_check failed: ${(w.idempotency && w.idempotency.reason) || 'missing'}`);
    }
  }

  return failures;
}

async function runWriteModeProof(fixture, lastOut, phone, contactName, opts) {
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
    stripe_live_used: false,
    confirmation_sent: false,
    duplicate_booking_created: false,
    idempotency: null,
    cleanup: null,
  };

  const envCheck = assessWriteEnvironment();
  if (!envCheck.ok) {
    proof.skip_reason = envCheck.reasons.join('; ');
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

  const stripeGate = evaluateStripeGate(
    bookingWrite.payment_draft_id,
    bookingWrite.booking_id,
    bookingWrite.booking_code,
  );
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
    if (!proof.stripe_test_checkout_created) {
      proof.stripe_skip_reason = (stripeOut.block_reasons || []).join('; ');
    }
  } else {
    proof.stripe_skip_reason = stripeGate.reasons.join('; ');
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

  if (!opts.keepBookings && fixture.write_expect && fixture.write_expect.cleanup_expected === true
    && proof.booking_code) {
    proof.cleanup = await withPgClient((pg) => cleanupUnpaidTestBooking(pg, proof.booking_code));
  } else if (opts.keepBookings) {
    proof.cleanup = { result: 'skipped', reason: '--keep-bookings' };
  }

  const writeFailures = checkWriteExpectations(fixture.write_expect, proof);
  proof.result = writeFailures.length === 0 ? 'PASS' : 'FAIL';
  proof.write_failures = writeFailures;
  return proof;
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
  if (expect.no_internal_language === true) {
    const bad = findInternalLanguage(reply);
    if (bad.length) failures.push(`internal language: ${bad.join(', ')}`);
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
      result.result = 'PARTIAL';
      result.write_skip_reason = result.write_mode.skip_reason;
    } else if (result.write_mode.booking_write) {
      result.writes_or_sends = true;
    }
    if (!opts.json && result.write_mode) {
      const wm = result.write_mode;
      console.log(`    write: ${wm.result} booking=${wm.booking_code || '—'} draft=${wm.payment_draft_id || '—'} stripe=${wm.stripe_test_checkout_created}`);
      if (wm.stripe_skip_reason) console.log(`    stripe_skip: ${wm.stripe_skip_reason}`);
      if (wm.cleanup) console.log(`    cleanup: ${wm.cleanup.result}${wm.cleanup.reason ? ` (${wm.cleanup.reason})` : ''}`);
      if (wm.idempotency) console.log(`    idempotency: ${wm.idempotency.result}`);
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

  if (opts.allowWrites) {
    try {
      assertNotProduction();
    } catch (e) {
      console.error(`FAIL — ${e.message}`);
      process.exit(1);
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
    mode: opts.allowWrites ? 'conversation_dry_run_plus_write_proof' : 'dry_run_review_only',
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
