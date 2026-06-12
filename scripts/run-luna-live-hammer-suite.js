'use strict';

/**
 * Luna live hammer — real staging DB writes: bookings, add-ons, transfers.
 *
 * Usage:
 *   npm run hammer:luna:live -- --limit 5
 *   npm run hammer:luna:live -- --all --keep-bookings
 *   npm run hammer:luna:live -- --scenario hammer-live-waimea-yoga-each
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { executeOpenDemoWhatsAppInbound } = require('./lib/open-demo-whatsapp-inbound-execute');
const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');
const { withPgClient } = require('./lib/pg-connect');
const { normalizeGuestContextForChain } = require('./lib/luna-guest-context-merge');
const {
  runGuestHoldPaymentDraftWriteDryRunApproved,
  isGuestHoldPaymentDraftWriteEnvironment,
} = require('./lib/luna-guest-hold-payment-draft-write');
const {
  runGuestStripeTestLinkCreateApproved,
  shouldAllowGuestStripeTestLinkCreate,
} = require('./lib/luna-guest-stripe-test-link-create');
const { runOpenDemoBookingBedAssignApproved } = require('./lib/open-demo-booking-bed-assign');
const { runGuestStripePaymentTruthApplyApproved } = require('./lib/luna-guest-stripe-payment-truth-apply');
const { applyLunaGuestStagingProfile } = require('./lib/luna-guest-staging-profile');
const { assertNotProductionDb, defaultConnectionString } = require('./lib/open-demo-playground-common');
const { isAllowlistedProofPhone } = require('./lib/luna-live-proof-hygiene');

const CLIENT_SLUG = 'wolfhouse-somo';
const WRITE_SOURCE = 'luna_live_hammer_suite';
const DEFAULT_REFERENCE_DATE = '2026-06-10';
const REPORT_DIR = path.join(__dirname, '..', 'reports');

function usage() {
  console.log(`Usage: node scripts/run-luna-live-hammer-suite.js [options]

Options:
  --all                 Run all scenarios (default)
  --limit N             Run first N scenarios
  --scenario ID         Run one scenario by id
  --phone-prefix PREFIX Default +3462980 (allowlisted staging proof prefix)
  --reference-date DATE Default ${DEFAULT_REFERENCE_DATE}
  --keep-bookings       Do not cancel unpaid holds after run (paid bookings always kept)
  --json                JSON report only
  --write-report        Write reports/luna-live-hammer-*.json
  --help                Show help

Requires staging/local PG + OPEN_DEMO_BOOKING_WRITES_ENABLED. WhatsApp stays dry-run.`);
}

function parseArgs(argv) {
  const opts = {
    all: true,
    limit: null,
    scenario: null,
    phonePrefix: '+3462980',
    referenceDate: DEFAULT_REFERENCE_DATE,
    keepBookings: false,
    json: false,
    writeReport: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--write-report') opts.writeReport = true;
    else if (a === '--keep-bookings') opts.keepBookings = true;
    else if (a === '--limit') opts.limit = parseInt(argv[++i], 10);
    else if (a === '--scenario') { opts.scenario = argv[++i]; opts.all = false; }
    else if (a === '--phone-prefix') opts.phonePrefix = argv[++i];
    else if (a === '--reference-date') opts.referenceDate = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      usage();
      process.exit(1);
    }
  }
  return opts;
}

function assertSafeEnvironment() {
  const base = (process.env.STAFF_API_BASE_URL || '').replace(/\/$/, '');
  if (base) {
    try {
      const host = new URL(base).hostname.toLowerCase();
      if (/^staff\.lunafrontdesk\.com$/i.test(host)) {
        throw new Error(`production host blocked: ${host}`);
      }
    } catch (e) {
      if (e.message && e.message.includes('production host blocked')) throw e;
    }
  }
  assertNotProductionDb(defaultConnectionString());
  if (!isGuestHoldPaymentDraftWriteEnvironment(process.env, 'localhost')) {
    throw new Error('hold_write_environment_not_staging_or_local');
  }
}

function monthLabel(ymd) {
  const d = new Date(`${String(ymd).slice(0, 10)}T12:00:00Z`);
  return d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
}

function formatDateRange(checkIn, checkOut) {
  const ciDay = String(checkIn).slice(8, 10);
  const coDay = String(checkOut).slice(8, 10);
  return `${monthLabel(checkIn)} ${ciDay}-${coDay}`;
}

function buildIntakeTurns(scenario) {
  const s = scenario;
  const range = formatDateRange(s.check_in, s.check_out);
  const pkgLine = s.package === 'accommodation_only'
    ? 'just accommodation no package'
    : `${s.package} please`;
  const turns = [
    'hi I want to make a booking',
    range,
    `${s.guest_count} please`,
    pkgLine,
  ];
  if (s.transfer_intake) turns.push(s.transfer_intake);
  turns.push('deposit is fine');
  if (Array.isArray(s.intake_extra)) turns.push(...s.intake_extra);
  return turns;
}

const LIVE_HAMMER_SCENARIOS = [
  {
    id: 'hammer-live-waimea-yoga-each',
    label: 'Waimea 3 guests — yoga for each on Sept 5 (live break case)',
    check_in: '2026-09-01',
    check_out: '2026-09-10',
    guest_count: 3,
    package: 'waimea',
    post_booking: ['ok great. can we book 1 yoga class for each of us on sept 5th?'],
    expect: { yoga_rows_min: 3, yoga_scheduled_min: 3, reply_required: true },
  },
  {
    id: 'hammer-live-malibu-meals-deferred',
    label: 'Malibu — meals interested, schedule later',
    check_in: '2026-09-15',
    check_out: '2026-09-22',
    guest_count: 2,
    package: 'malibu',
    intake_extra: ['maybe dinner some nights, we will decide later'],
    post_booking: ['can we add dinner on sept 17 and sept 19?'],
    expect: { meal_rows_min: 2, meal_scheduled_min: 2, reply_required: true },
  },
  {
    id: 'hammer-live-uluwatu-yoga-single',
    label: 'Uluwatu — single yoga with date',
    check_in: '2026-10-01',
    check_out: '2026-10-08',
    guest_count: 2,
    package: 'uluwatu',
    intake_extra: ['add yoga on oct 3 please'],
    expect: { yoga_rows_min: 1, yoga_scheduled_min: 1 },
  },
  {
    id: 'hammer-live-accommodation-short-meals',
    label: 'Accommodation only short stay + meals',
    check_in: '2026-08-20',
    check_out: '2026-08-23',
    guest_count: 2,
    package: 'accommodation_only',
    intake_extra: ['breakfast each morning please'],
    expect: { meal_rows_min: 1 },
  },
  {
    id: 'hammer-live-waimea-santander-scheduled',
    label: 'Waimea + Santander transfer with times at intake',
    check_in: '2026-11-01',
    check_out: '2026-11-10',
    guest_count: 3,
    package: 'waimea',
    transfer_intake: 'Santander airport pickup at 15:00 on arrival and 11:00 departure',
    expect: { transfer_rows_min: 2, transfer_scheduled_min: 2 },
  },
  {
    id: 'hammer-live-malibu-santander-deferred',
    label: 'Malibu + Santander transfer deferred',
    check_in: '2026-11-15',
    check_out: '2026-11-22',
    guest_count: 2,
    package: 'malibu',
    transfer_intake: 'yes Santander transfer please, flight details later',
    expect: { transfer_rows_min: 2 },
  },
  {
    id: 'hammer-live-waimea-bilbao-ask',
    label: 'Waimea — guest asks Bilbao (4+ group)',
    check_in: '2026-12-01',
    check_out: '2026-12-10',
    guest_count: 4,
    package: 'waimea',
    intake_extra: ['can we get Bilbao airport transfer instead?'],
    expect: { transfer_rows_min: 2 },
  },
  {
    id: 'hammer-live-malibu-post-transfer-times',
    label: 'Malibu — post-booking transfer time update',
    check_in: '2026-12-15',
    check_out: '2026-12-22',
    guest_count: 2,
    package: 'malibu',
    transfer_intake: 'Santander transfer yes',
    post_booking: ['arrival pickup at 16:30 and departure at 10:00 please'],
    expect: { transfer_rows_min: 2, reply_required: true },
  },
  {
    id: 'hammer-live-waimea-yoga-meals-combo',
    label: 'Waimea — yoga each + meals on two nights',
    check_in: '2027-01-05',
    check_out: '2027-01-12',
    guest_count: 3,
    package: 'waimea',
    post_booking: [
      '1 yoga class for each of us on jan 8',
      'dinner for all of us on jan 9 and jan 10',
    ],
    expect: { yoga_rows_min: 3, yoga_scheduled_min: 3, meal_rows_min: 2, meal_scheduled_min: 2 },
  },
  {
    id: 'hammer-live-uluwatu-4guest-yoga',
    label: 'Uluwatu 4 guests — yoga per person',
    check_in: '2027-02-01',
    check_out: '2027-02-08',
    guest_count: 4,
    package: 'uluwatu',
    post_booking: ['yoga for everyone on feb 3 please'],
    expect: { yoga_rows_min: 4, yoga_scheduled_min: 4 },
  },
];

async function loadPaymentBookingSnapshot(pg, paymentDraftId, bookingCode) {
  const res = await pg.query(
    `SELECT p.id::text AS payment_draft_id,
            p.status::text AS payment_status,
            p.amount_paid_cents,
            p.amount_due_cents,
            p.stripe_checkout_session_id,
            b.booking_code,
            b.id::text AS booking_id,
            b.payment_status::text AS booking_payment_status
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND p.id = $2::uuid
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
    payment_intent: `pi_hammer_${String(snapshot.payment_draft_id).slice(0, 8)}`,
    payment_status: 'paid',
    status: 'complete',
    metadata: {
      payment_id: snapshot.payment_draft_id,
      booking_id: snapshot.booking_id,
      booking_code: snapshot.booking_code,
      source: WRITE_SOURCE,
    },
  };
  return {
    session,
    event: {
      id: `evt_hammer_${Date.now()}`,
      type: 'checkout.session.completed',
      livemode: false,
      data: { object: session },
    },
  };
}

function guestContextFromOrchestrator(out) {
  return normalizeGuestContextForChain({
    message_lane: out.result && out.result.message_lane,
    extracted_fields: out.result && out.result.extracted_fields,
    quote: out.quote,
    payment_choice: out.payment_choice,
    hold_payment_draft_plan: out.hold_payment_draft_plan,
    booking_code: out.booking_code || null,
    booking_id: out.booking_id || null,
    result: out.result,
    availability: out.availability,
    active_thread: out.result && out.result.active_thread,
  });
}

function isReadyForHoldWrite(out) {
  const r = (out && out.result) || {};
  const q = (out && out.quote) || {};
  const pc = (out && out.payment_choice) || {};
  return r.booking_intake_ready === true
    && q.quote_status === 'ready'
    && pc.payment_choice_ready === true;
}

async function simulateDepositPaid(pg, paymentDraftId, bookingCode, env) {
  const snap = await loadPaymentBookingSnapshot(pg, paymentDraftId, bookingCode);
  if (!snap) return { ok: false, error: 'snapshot_missing' };
  const fixture = buildStripeWebhookFixture(snap);
  if (!fixture) return { ok: false, error: 'stripe_session_missing' };
  const apply = await runGuestStripePaymentTruthApplyApproved({
    payment_draft_id: paymentDraftId,
    booking_id: snap.booking_id,
    booking_code: bookingCode,
    stripe_event: fixture.event,
    stripe_session: fixture.session,
    source: WRITE_SOURCE,
  }, {
    confirm_payment_truth: true,
    env: { ...env, WHATSAPP_DRY_RUN: 'true', STRIPE_WEBHOOK_SKIP_VERIFY: 'true' },
    pg,
    host_header: 'localhost',
  });
  const after = await loadPaymentBookingSnapshot(pg, paymentDraftId, bookingCode);
  return {
    ok: apply.success === true && ['deposit_paid', 'paid'].includes(after && after.booking_payment_status),
    booking_payment_status: after && after.booking_payment_status,
    apply,
  };
}

async function loadBookingDbState(pg, bookingId) {
  const yoga = await pg.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE service_date IS NOT NULL)::int AS scheduled
       FROM booking_service_records
      WHERE booking_id = $1::uuid AND service_type = 'yoga'`,
    [bookingId],
  );
  const meals = await pg.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE service_date IS NOT NULL)::int AS scheduled
       FROM booking_service_records
      WHERE booking_id = $1::uuid AND service_type = 'meal'`,
    [bookingId],
  );
  const transfers = await pg.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE scheduled_at IS NOT NULL)::int AS scheduled
       FROM booking_transfers
      WHERE booking_id = $1::uuid`,
    [bookingId],
  );
  return {
    yoga_rows: yoga.rows[0].n,
    yoga_scheduled: yoga.rows[0].scheduled,
    meal_rows: meals.rows[0].n,
    meal_scheduled: meals.rows[0].scheduled,
    transfer_rows: transfers.rows[0].n,
    transfer_scheduled: transfers.rows[0].scheduled,
  };
}

function resolveProposedReply(reviewOutcome, outcome) {
  const review = reviewOutcome.body && reviewOutcome.body.review;
  if (!review) return '';
  let reply = review.proposed_luna_reply != null ? String(review.proposed_luna_reply).trim() : '';
  if (reply) return reply;
  const composed = composeLunaGuestReply({
    payload: review,
    message_text: review.message_text || '',
    prior_guest_context: reviewOutcome.body.slim_guest_context_for_next_turn,
    client_slug: CLIENT_SLUG,
    mode: 'live_staging',
    live_outcomes: {
      bookingWrite: outcome.bookingWrite,
      bedAssignment: outcome.bedAssignment,
      stripeLink: outcome.stripeLink,
      serviceAttach: outcome.serviceAttach,
      serviceSchedule: outcome.serviceSchedule,
      transferTimesUpdate: outcome.transferTimesUpdate,
    },
  });
  return composed && composed.reply ? String(composed.reply).trim() : '';
}

async function runOpenDemoTurn(pg, env, opts) {
  const wamid = `wamid.${WRITE_SOURCE}.${opts.runId}.${opts.turnIndex}.${Date.now()}`;
  const body = {
    client_slug: CLIENT_SLUG,
    channel: 'whatsapp',
    guest_phone: opts.phone,
    message_text: opts.message,
    inbound_message_id: wamid,
    wamid,
    reference_date: opts.referenceDate,
    contact_name: 'Hammer Guest',
    guest_context: opts.guestContext,
    create_demo_hold_draft_confirmed: opts.createHold === true,
    assign_demo_bed_confirmed: opts.assignBed === true,
    create_stripe_test_link_confirmed: opts.createStripe === true,
    send_live_reply_confirmed: false,
  };
  return executeOpenDemoWhatsAppInbound(pg, body, env, { hostHeader: 'localhost', actorId: WRITE_SOURCE });
}

async function runScenario(scenario, index, opts, env) {
  const phone = `${opts.phonePrefix}${String(index + 1).padStart(2, '0')}`;
  const runId = `${scenario.id}-${Date.now()}`;
  const result = {
    id: scenario.id,
    label: scenario.label,
    phone,
    result: 'PASS',
    failures: [],
    booking_code: null,
    booking_id: null,
    db: null,
    intake_turns: 0,
    post_turns: 0,
  };

  if (!isAllowlistedProofPhone(phone)) {
    result.result = 'FAIL';
    result.failures.push('phone_not_allowlisted_for_staging_proof');
    return result;
  }

  let guestContext = null;
  let lastOut = null;
  const intakeTurns = buildIntakeTurns(scenario);

  for (let ti = 0; ti < intakeTurns.length; ti++) {
    const message = intakeTurns[ti];
    lastOut = await withPgClient((pg) => runGuestAutomationOrchestratorDryRun({
      client_slug: CLIENT_SLUG,
      channel: 'whatsapp',
      message_text: message,
      guest_phone: phone,
      guest_context: guestContext,
      reference_date: opts.referenceDate,
      dry_run: true,
      automation_gate_context: {
        public_guest_automation_enabled: false,
        whatsapp_dry_run: true,
        live_send_allowed: false,
      },
    }, { reference_date: opts.referenceDate, guest_phone: phone, dry_run: true, pg }));

    guestContext = guestContextFromOrchestrator(lastOut);
    result.intake_turns += 1;
  }

  if (!isReadyForHoldWrite(lastOut)) {
    result.result = 'FAIL';
    result.failures.push('intake_not_ready_for_hold_write');
    return result;
  }

  const writeOut = await withPgClient(async (pg) => {
    const chain = {
      result: lastOut.result,
      availability: lastOut.availability,
      quote: lastOut.quote,
      payment_choice: lastOut.payment_choice,
    };
    const hold = await runGuestHoldPaymentDraftWriteDryRunApproved(chain, {
      confirm_write: true,
      client_slug: CLIENT_SLUG,
      guest_phone: phone,
      guest_name: 'Hammer Guest',
      guest_email: `hammer+${phone.replace(/\D/g, '')}@wolfhouse.test`,
      env,
      host_header: 'localhost',
      source: WRITE_SOURCE,
      pg,
      planner: lastOut.hold_payment_draft_plan,
    });
    if (!hold.success) {
      return { hold, bed: null, stripe: null };
    }
    const bed = await runOpenDemoBookingBedAssignApproved(pg, {
      client_slug: CLIENT_SLUG,
      booking_id: hold.booking_id,
      booking_code: hold.booking_code,
      review: {
        result: lastOut.result,
        availability: lastOut.availability,
        quote: lastOut.quote,
        payment_choice: lastOut.payment_choice,
      },
      env,
      host_header: 'localhost',
    });
    let stripe = null;
    const gate = shouldAllowGuestStripeTestLinkCreate({
      payment_draft_id: hold.payment_draft_id,
      booking_id: hold.booking_id,
      booking_code: hold.booking_code,
      source: WRITE_SOURCE,
    }, { confirm_stripe_test_link: true, env, host_header: 'localhost' });
    if (gate.allowed) {
      stripe = await runGuestStripeTestLinkCreateApproved({
        payment_draft_id: hold.payment_draft_id,
        booking_id: hold.booking_id,
        booking_code: hold.booking_code,
        source: WRITE_SOURCE,
      }, { confirm_stripe_test_link: true, env, host_header: 'localhost', pg });
    }
    const paid = await simulateDepositPaid(pg, hold.payment_draft_id, hold.booking_code, env);
    return { hold, bed, stripe, paid };
  });

  if (!writeOut.hold || !writeOut.hold.success) {
    result.result = 'FAIL';
    result.failures.push(`hold_write_failed: ${(writeOut.hold && writeOut.hold.write_block_reasons || []).join('; ')}`);
    return result;
  }

  result.booking_code = writeOut.hold.booking_code;
  result.booking_id = writeOut.hold.booking_id;

  if (!writeOut.paid || !writeOut.paid.ok) {
    result.result = 'FAIL';
    result.failures.push(`deposit_simulation_failed: ${writeOut.paid && writeOut.paid.error || 'unknown'}`);
    return result;
  }

  guestContext = normalizeGuestContextForChain({
    ...guestContext,
    booking_id: writeOut.hold.booking_id,
    booking_code: writeOut.hold.booking_code,
    payment_status: writeOut.paid.booking_payment_status,
    deposit_paid: true,
    guest_count: scenario.guest_count,
    check_in: scenario.check_in,
    check_out: scenario.check_out,
    extracted_fields: {
      ...(guestContext && guestContext.extracted_fields),
      guest_count: scenario.guest_count,
      check_in: scenario.check_in,
      check_out: scenario.check_out,
    },
  });

  const postTurns = scenario.post_booking || [];
  for (let pi = 0; pi < postTurns.length; pi++) {
    const message = postTurns[pi];
    const outcome = await withPgClient((pg) => runOpenDemoTurn(pg, env, {
      phone,
      message,
      referenceDate: opts.referenceDate,
      guestContext,
      runId,
      turnIndex: pi,
    }));
    const reviewOutcome = outcome.reviewOutcome;
    if (!reviewOutcome.ok) {
      result.failures.push(`post_turn_${pi + 1}: review_failed`);
      result.result = 'FAIL';
      break;
    }
    const reply = resolveProposedReply(reviewOutcome, outcome);
    if (scenario.expect && scenario.expect.reply_required && !reply) {
      result.failures.push(`post_turn_${pi + 1}: empty_reply`);
      result.result = 'FAIL';
    }
    if (reviewOutcome.body.slim_guest_context_for_next_turn) {
      guestContext = normalizeGuestContextForChain({
        ...guestContext,
        ...reviewOutcome.body.slim_guest_context_for_next_turn,
        booking_id: writeOut.hold.booking_id,
        booking_code: writeOut.hold.booking_code,
        payment_status: writeOut.paid.booking_payment_status,
      });
    }
    result.post_turns += 1;
  }

  result.db = await withPgClient((pg) => loadBookingDbState(pg, writeOut.hold.booking_id));

  const ex = scenario.expect || {};
  if (ex.yoga_rows_min != null && result.db.yoga_rows < ex.yoga_rows_min) {
    result.failures.push(`yoga_rows expected >= ${ex.yoga_rows_min} got ${result.db.yoga_rows}`);
    result.result = 'FAIL';
  }
  if (ex.yoga_scheduled_min != null && result.db.yoga_scheduled < ex.yoga_scheduled_min) {
    result.failures.push(`yoga_scheduled expected >= ${ex.yoga_scheduled_min} got ${result.db.yoga_scheduled}`);
    result.result = 'FAIL';
  }
  if (ex.meal_rows_min != null && result.db.meal_rows < ex.meal_rows_min) {
    result.failures.push(`meal_rows expected >= ${ex.meal_rows_min} got ${result.db.meal_rows}`);
    result.result = 'FAIL';
  }
  if (ex.meal_scheduled_min != null && result.db.meal_scheduled < ex.meal_scheduled_min) {
    result.failures.push(`meal_scheduled expected >= ${ex.meal_scheduled_min} got ${result.db.meal_scheduled}`);
    result.result = 'FAIL';
  }
  if (ex.transfer_rows_min != null && result.db.transfer_rows < ex.transfer_rows_min) {
    result.failures.push(`transfer_rows expected >= ${ex.transfer_rows_min} got ${result.db.transfer_rows}`);
    result.result = 'FAIL';
  }
  if (ex.transfer_scheduled_min != null && result.db.transfer_scheduled < ex.transfer_scheduled_min) {
    result.failures.push(`transfer_scheduled expected >= ${ex.transfer_scheduled_min} got ${result.db.transfer_scheduled}`);
    result.result = 'FAIL';
  }

  return result;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }

  try {
    assertSafeEnvironment();
  } catch (e) {
    console.error(`FAIL — ${e.message}`);
    process.exit(1);
  }

  const env = applyLunaGuestStagingProfile(process.env);
  env.WHATSAPP_DRY_RUN = 'true';
  env.LUNA_OPEN_PHONE_TESTING = 'true';

  let scenarios = LIVE_HAMMER_SCENARIOS;
  if (opts.scenario) {
    scenarios = scenarios.filter((s) => s.id === opts.scenario);
    if (!scenarios.length) {
      console.error(`Unknown scenario: ${opts.scenario}`);
      process.exit(1);
    }
  }
  if (opts.limit != null) scenarios = scenarios.slice(0, opts.limit);

  const started = Date.now();
  const results = [];
  for (let i = 0; i < scenarios.length; i++) {
    const r = await runScenario(scenarios[i], i, opts, env);
    results.push(r);
    if (!opts.json) {
      const mark = r.result === 'PASS' ? 'PASS' : 'FAIL';
      console.log(`${mark}  ${r.id}  ${r.booking_code || '—'}  yoga=${r.db && r.db.yoga_rows}/${r.db && r.db.yoga_scheduled} meals=${r.db && r.db.meal_rows}/${r.db && r.db.meal_scheduled} transfers=${r.db && r.db.transfer_rows}/${r.db && r.db.transfer_scheduled}`);
      if (r.failures.length) r.failures.forEach((f) => console.log(`       - ${f}`));
    }
  }

  const summary = {
    ok: results.every((r) => r.result === 'PASS'),
    elapsed_ms: Date.now() - started,
    pass: results.filter((r) => r.result === 'PASS').length,
    fail: results.filter((r) => r.result === 'FAIL').length,
    bookings_created: results.filter((r) => r.booking_code).map((r) => ({
      id: r.id,
      booking_code: r.booking_code,
      phone: r.phone,
      db: r.db,
    })),
    results,
  };

  if (opts.writeReport) {
    if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(REPORT_DIR, `luna-live-hammer-${stamp}.json`);
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
    if (!opts.json) console.log(`\nReport: ${outPath}`);
  }

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`\nLive hammer: ${summary.pass} PASS, ${summary.fail} FAIL (${summary.elapsed_ms}ms)`);
    console.log(`Bookings in staff portal: ${summary.bookings_created.map((b) => b.booking_code).join(', ')}`);
  }

  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
