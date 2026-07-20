'use strict';

/**
 * verify:radar-slice16m-stripe-event-claim — RADAR Slice 16M
 *
 * Offline RED/GREEN gate for fail-closed Stripe webhook event-id claim
 * before booking-payment and addon_service mutations. Fake transactional
 * pg sequencing + source anti-pattern REDs. No network, no live DB, no deploy.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MASTER = '49b4ccff673014b28047307514f91a508cc8c497';
const BRANCH = 'radar/slice-16m-stripe-event-claim';
const CONTRACT_REL = 'fixtures/radar-operations/slice16m-expected-contract.json';
const LIB_REL = 'scripts/lib/stripe-webhook-event-claim.js';
const TRUTH_REL = 'scripts/lib/stripe-webhook-payment-truth.js';
const API_REL = 'scripts/staff-query-api.js';
const VERIFY_REL = 'scripts/verify-radar-slice16m-stripe-event-claim.js';

const {
  CLAIM_INSERT_SQL,
  MARK_PROCESSED_SQL,
  IDEMPOTENT_DUPLICATE_REASON,
  STRIPE_WEBHOOK_EVENT_PAYLOAD_ALLOWLIST,
  FORBIDDEN_PAYLOAD_CANARIES,
  PAYMENT_EVENTS_OWNERSHIP_COLUMN,
  buildMinimizedStripeWebhookEventPayload,
  claimStripeWebhookEvent,
  markStripeWebhookEventProcessed,
  withStripeWebhookEventClaim,
  buildStripeEventClaimIdempotentBody,
} = require('./lib/stripe-webhook-event-claim');

let pass = 0;
let fail = 0;
let redPass = 0;
let redFail = 0;
let greenPass = 0;
let greenFail = 0;

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  return false;
}

function red(label, cond, detail) {
  if (cond) {
    redPass += 1;
    pass += 1;
    console.log(`  RED   ${label}`);
    return true;
  }
  redFail += 1;
  fail += 1;
  console.log(`  FAIL-RED  ${label}${detail ? ' — ' + detail : ''}`);
  return false;
}

function green(label, cond, detail) {
  if (cond) {
    greenPass += 1;
    pass += 1;
    console.log(`  GREEN ${label}`);
    return true;
  }
  greenFail += 1;
  fail += 1;
  console.log(`  FAIL-GREEN  ${label}${detail ? ' — ' + detail : ''}`);
  return false;
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function uuid() {
  return crypto.randomUUID();
}

function currentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (_) {
    return '';
  }
}

/**
 * Fake transactional pg with UNIQUE(stripe_event_id) claim store.
 * Shared `ledger` enables concurrent conflict simulation.
 */
function makeFakeTxnPg(opts) {
  const ledger = (opts && opts.ledger) || {
    events: new Map(),
    inflight: new Set(),
    paymentsMutations: 0,
    serviceMutations: 0,
    bookingMutations: 0,
  };
  if (!ledger.inflight) ledger.inflight = new Set();
  const state = {
    begun: false,
    committed: false,
    rolledBack: false,
    open: false,
    queries: [],
    mutationCount: 0,
    failOn: opts && opts.failOn,
    claimIds: new Map(),
    pendingClaim: null,
    mutDelta: { payments: 0, service: 0, booking: 0 },
  };

  async function query(sql, params) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    state.queries.push({ text, params: params || [] });
    if (state.failOn) {
      const hit = state.failOn(text, params || [], state, ledger);
      if (hit) {
        const err = new Error(hit.message || 'forced_failure');
        err.code = hit.code || 'forced_failure';
        throw err;
      }
    }
    if (/^BEGIN$/i.test(text)) {
      state.begun = true;
      state.open = true;
      state.committed = false;
      state.rolledBack = false;
      state.pendingClaim = null;
      state.mutDelta = { payments: 0, service: 0, booking: 0 };
      return { rows: [], rowCount: 0 };
    }
    if (/^COMMIT$/i.test(text)) {
      if (!state.open) throw new Error('commit_without_begin');
      if (state.pendingClaim) {
        ledger.events.set(state.pendingClaim.stripe_event_id, {
          ...state.pendingClaim,
        });
        ledger.inflight.delete(state.pendingClaim.stripe_event_id);
      }
      state.committed = true;
      state.open = false;
      state.pendingClaim = null;
      return { rows: [], rowCount: 0 };
    }
    if (/^ROLLBACK$/i.test(text)) {
      if (state.pendingClaim) {
        ledger.inflight.delete(state.pendingClaim.stripe_event_id);
        ledger.events.delete(state.pendingClaim.stripe_event_id);
      }
      ledger.paymentsMutations = Math.max(0, ledger.paymentsMutations - state.mutDelta.payments);
      ledger.serviceMutations = Math.max(0, ledger.serviceMutations - state.mutDelta.service);
      ledger.bookingMutations = Math.max(0, ledger.bookingMutations - state.mutDelta.booking);
      state.rolledBack = true;
      state.open = false;
      state.pendingClaim = null;
      state.mutDelta = { payments: 0, service: 0, booking: 0 };
      return { rows: [], rowCount: 0 };
    }

    if (/INSERT\s+INTO\s+payment_events/i.test(text)) {
      if (!state.open) {
        const err = new Error('claim_outside_transaction');
        err.code = 'claim_outside_transaction';
        throw err;
      }
      if (!/ON CONFLICT\s*\(\s*stripe_event_id\s*\)\s*DO NOTHING/i.test(text)) {
        const err = new Error('claim_missing_on_conflict');
        err.code = 'claim_missing_on_conflict';
        throw err;
      }
      if (!/RETURNING\s+id/i.test(text)) {
        const err = new Error('claim_missing_returning');
        err.code = 'claim_missing_returning';
        throw err;
      }
      const [
        clientId, paymentId, bookingId, stripeEventId, eventType, payloadJson,
      ] = params;
      if (ledger.events.has(stripeEventId) || ledger.inflight.has(stripeEventId)) {
        return { rows: [], rowCount: 0 };
      }
      const id = uuid();
      let payload;
      try { payload = JSON.parse(payloadJson); } catch (_) { payload = {}; }
      state.pendingClaim = {
        id,
        client_id: clientId,
        payment_id: paymentId,
        booking_id: bookingId,
        stripe_event_id: stripeEventId,
        event_type: eventType,
        payload,
        processed: false,
      };
      ledger.inflight.add(stripeEventId);
      state.claimIds.set(id, stripeEventId);
      return { rows: [{ id }], rowCount: 1 };
    }

    if (/UPDATE\s+payment_events/i.test(text) && /processed\s*=\s*true/i.test(text)) {
      if (!state.open) {
        const err = new Error('processed_outside_transaction');
        err.code = 'processed_outside_transaction';
        throw err;
      }
      const claimId = params[0];
      if (!state.pendingClaim || state.pendingClaim.id !== claimId) {
        return { rows: [], rowCount: 0 };
      }
      state.pendingClaim.processed = true;
      return { rows: [{ id: claimId }], rowCount: 1 };
    }

    if (/UPDATE\s+payments/i.test(text)) {
      if (!state.open) throw new Error('mutation_outside_transaction');
      if (!state.pendingClaim) {
        const err = new Error('mutation_before_claim');
        err.code = 'mutation_before_claim';
        throw err;
      }
      ledger.paymentsMutations += 1;
      state.mutDelta.payments += 1;
      state.mutationCount += 1;
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE\s+booking_service_records/i.test(text)) {
      if (!state.pendingClaim) throw Object.assign(new Error('mutation_before_claim'), { code: 'mutation_before_claim' });
      ledger.serviceMutations += 1;
      state.mutDelta.service += 1;
      state.mutationCount += 1;
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE\s+bookings/i.test(text)) {
      if (!state.pendingClaim) throw Object.assign(new Error('mutation_before_claim'), { code: 'mutation_before_claim' });
      ledger.bookingMutations += 1;
      state.mutDelta.booking += 1;
      state.mutationCount += 1;
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT\s+id,\s*amount_due_cents/i.test(text)) {
      return { rows: [{ id: uuid(), amount_due_cents: 1000, payment_status: 'unpaid' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  return { query, state, ledger };
}

/** Simulate booking-payment route transaction (claim → mutate → processed → commit). */
async function runBookingPaymentRouteTxn(pg, claimInput, mutateFn) {
  await pg.query('BEGIN');
  try {
    const outcome = await withStripeWebhookEventClaim(pg, claimInput, mutateFn);
    if (outcome.duplicate) {
      await pg.query('ROLLBACK');
      return { status: 200, body: buildStripeEventClaimIdempotentBody(claimInput), duplicate: true };
    }
    await pg.query('COMMIT');
    return { status: 200, body: { success: true, idempotent: false, path: 'booking_payment' }, duplicate: false };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) {}
    return { status: 500, body: { success: false, error: err.message }, error: err };
  }
}

/** Simulate addon_service route transaction. */
async function runAddonServiceRouteTxn(pg, claimInput, mutateFn) {
  await pg.query('BEGIN');
  try {
    const outcome = await withStripeWebhookEventClaim(pg, claimInput, mutateFn);
    if (outcome.duplicate) {
      await pg.query('ROLLBACK');
      return {
        status: 200,
        body: Object.assign(buildStripeEventClaimIdempotentBody(claimInput), { addon_service_payment: true }),
        duplicate: true,
      };
    }
    await pg.query('COMMIT');
    return { status: 200, body: { success: true, idempotent: false, path: 'addon_service' }, duplicate: false };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) {}
    return { status: 500, body: { success: false, error: err.message }, error: err };
  }
}

function claimBase(overrides) {
  return Object.assign({
    hostelId: uuid(),
    paymentId: uuid(),
    bookingId: uuid(),
    stripeEventId: `evt_test_${uuid().replace(/-/g, '').slice(0, 24)}`,
    eventType: 'checkout.session.completed',
    sessionId: `cs_test_${uuid().replace(/-/g, '').slice(0, 16)}`,
    clientSlug: 'sunset',
    paymentKind: 'full_amount',
    currency: 'EUR',
    amountPaidCents: 4500,
    paymentStatusBefore: 'checkout_created',
    lookupPath: 'session_id',
    livemode: false,
    path: 'booking_payment',
  }, overrides || {});
}

console.log('verify:radar-slice16m-stripe-event-claim — RADAR Slice 16M\n');

const contract = readJson(CONTRACT_REL);
const apiSrc = readText(API_REL);
const truthSrc = readText(TRUTH_REL);
const libSrc = readText(LIB_REL);
const branch = currentBranch();

ok('C1 contract slice/branch/master',
  contract.slice === 'RADAR-16M'
  && contract.branch === BRANCH
  && contract.master_basis === MASTER
  && contract.gate_id === 'G05_retry_replay_safety'
  && contract.progress_class === 'source_partial_progress_only');
ok('C2 HEAD branch matches', branch === BRANCH, `head=${branch}`);
ok('C3 ownership column is client_id (hostel rename)',
  PAYMENT_EVENTS_OWNERSHIP_COLUMN === 'client_id'
  && /INSERT INTO payment_events[\s\S]*client_id/.test(CLAIM_INSERT_SQL));
ok('C4 claim SQL has ON CONFLICT RETURNING',
  /ON CONFLICT \(stripe_event_id\) DO NOTHING/.test(CLAIM_INSERT_SQL)
  && /RETURNING id/.test(CLAIM_INSERT_SQL)
  && /processed/.test(CLAIM_INSERT_SQL));
ok('C5 mark processed SQL scoped to claim id',
  /UPDATE payment_events/.test(MARK_PROCESSED_SQL)
  && /processed = true/.test(MARK_PROCESSED_SQL)
  && /RETURNING id/.test(MARK_PROCESSED_SQL));
ok('C6 lookup returns hostel_id alias',
  /p\.client_id\s+AS hostel_id/.test(truthSrc));
ok('C7 webhook imports claim helper',
  /withStripeWebhookEventClaim/.test(apiSrc)
  && /buildStripeEventClaimIdempotentBody/.test(apiSrc)
  && /stripe-webhook-event-claim/.test(apiSrc));

// ── Source anti-pattern REDs (must reject) ──────────────────────────────────
console.log('\n── Source anti-pattern REDs ──');

function extractTxnBlocks(src) {
  const addon = src.match(/payment_kind === 'addon_service'[\s\S]*?return sendJSON\(res, 200, addonBody\)/);
  const booking = src.match(/Shared payment-truth apply[\s\S]*?if \(bookingDuplicateClaim\)[\s\S]*?\}\n/);
  return {
    addon: addon ? addon[0] : '',
    booking: booking ? booking[0] : '',
  };
}
const blocks = extractTxnBlocks(apiSrc);

red('reject_claim_after_mutation_addon',
  /withStripeWebhookEventClaim[\s\S]*UPDATE payments/.test(blocks.addon)
  && !/UPDATE payments[\s\S]*withStripeWebhookEventClaim/.test(blocks.addon));
red('reject_claim_after_mutation_booking',
  /withStripeWebhookEventClaim[\s\S]*applyStripeBookingPaymentTruthWrites/.test(blocks.booking)
  && !/applyStripeBookingPaymentTruthWrites[\s\S]*withStripeWebhookEventClaim/.test(blocks.booking));
red('reject_claim_outside_transaction_addon',
  /await pg\.query\('BEGIN'\)[\s\S]*withStripeWebhookEventClaim/.test(blocks.addon));
red('reject_claim_outside_transaction_booking',
  /await pg\.query\('BEGIN'\)[\s\S]*withStripeWebhookEventClaim/.test(blocks.booking));
red('reject_on_conflict_without_returning',
  /ON CONFLICT\s*\(\s*stripe_event_id\s*\)\s*DO NOTHING\s*RETURNING\s+id/.test(CLAIM_INSERT_SQL)
  && !/ON CONFLICT\s*\(\s*stripe_event_id\s*\)\s*DO NOTHING\s*;/.test(libSrc.replace(/\s+/g, ' ')));
red('reject_processed_update_outside_same_txn_helper',
  /await mutateFn\(pg\);\s*\n\s*await markStripeWebhookEventProcessed/.test(libSrc)
  && /withStripeWebhookEventClaim/.test(blocks.addon)
  && /withStripeWebhookEventClaim/.test(blocks.booking)
  && /COMMIT/.test(blocks.addon)
  && /COMMIT/.test(blocks.booking));
red('reject_raw_payload_persistence',
  !/JSON\.stringify\(\s*event\s*\)/.test(blocks.addon + blocks.booking)
  && !/payload:\s*event/.test(libSrc)
  && !/payload:\s*session/.test(libSrc)
  && FORBIDDEN_PAYLOAD_CANARIES.every((c) => !STRIPE_WEBHOOK_EVENT_PAYLOAD_ALLOWLIST.includes(c)));
red('ignored_unmatched_paths_unchanged_no_claim',
  /ignored:\s*true/.test(apiSrc)
  && /STRIPE_BOOKING_PAYMENT_EVENT_TYPES\.includes\(eventType\)/.test(apiSrc)
  && !/withStripeWebhookEventClaim[\s\S]{0,200}ignored:\s*true/.test(apiSrc));

// ── Payload canary REDs ─────────────────────────────────────────────────────
console.log('\n── Payload privacy REDs ──');
{
  const clean = buildMinimizedStripeWebhookEventPayload({
    stripe_event_id: 'evt_1',
    event_type: 'checkout.session.completed',
    stripe_session_id: 'cs_1',
    payment_id: uuid(),
    booking_id: uuid(),
    client_slug: 'sunset',
    payment_kind: 'full_amount',
    email: 'guest@example.com',
    phone: '+34111',
    guest_name: 'Secret Guest',
    customer: { id: 'cus_x' },
    raw_event: { id: 'evt_1' },
  });
  red('payload_drops_canaries',
    !Object.keys(clean).some((k) => FORBIDDEN_PAYLOAD_CANARIES.includes(k))
    && clean.email === undefined
    && clean.phone === undefined
    && clean.guest_name === undefined
    && clean.customer === undefined
    && clean.raw_event === undefined
    && clean.stripe_event_id === 'evt_1'
    && clean.client_slug === 'sunset');
}

// ── Route sequencing GREEN/RED (fake txn pg) ────────────────────────────────
console.log('\n── Route transactional sequencing ──');

(async () => {
  // Booking first-event order: claim → mutation → processed → commit
  {
    const pg = makeFakeTxnPg();
    const input = claimBase({ path: 'booking_payment', paymentKind: 'full_amount' });
    const order = [];
    const result = await runBookingPaymentRouteTxn(pg, input, async () => {
      order.push('mutate');
      await pg.query('UPDATE payments SET status = $1', ['paid']);
      await pg.query('UPDATE bookings SET payment_status = $1', ['paid']);
    });
    const texts = pg.state.queries.map((q) => q.text);
    const claimIdx = texts.findIndex((t) => /INSERT INTO payment_events/i.test(t));
    const mutIdx = texts.findIndex((t) => /UPDATE payments/i.test(t));
    const procIdx = texts.findIndex((t) => /UPDATE payment_events/i.test(t) && /processed/i.test(t));
    const commitIdx = texts.findIndex((t) => /^COMMIT$/i.test(t));
    green('booking_first_event_order_claim_mutate_processed_commit',
      result.status === 200
      && result.duplicate === false
      && claimIdx >= 0
      && mutIdx > claimIdx
      && procIdx > mutIdx
      && commitIdx > procIdx
      && order[0] === 'mutate'
      && pg.ledger.events.get(input.stripeEventId)
      && pg.ledger.events.get(input.stripeEventId).processed === true
      && pg.ledger.paymentsMutations === 1);
  }

  // Addon first-event order
  {
    const pg = makeFakeTxnPg();
    const input = claimBase({ path: 'addon_service', paymentKind: 'addon_service' });
    const result = await runAddonServiceRouteTxn(pg, input, async () => {
      await pg.query('UPDATE payments SET status = $1', ['paid']);
      await pg.query('UPDATE booking_service_records SET payment_status = $1', ['paid']);
    });
    const texts = pg.state.queries.map((q) => q.text);
    const claimIdx = texts.findIndex((t) => /INSERT INTO payment_events/i.test(t));
    const payIdx = texts.findIndex((t) => /UPDATE payments/i.test(t));
    const svcIdx = texts.findIndex((t) => /UPDATE booking_service_records/i.test(t));
    const procIdx = texts.findIndex((t) => /UPDATE payment_events/i.test(t) && /processed/i.test(t));
    const commitIdx = texts.findIndex((t) => /^COMMIT$/i.test(t));
    green('addon_first_event_order_claim_mutate_processed_commit',
      result.status === 200
      && !result.duplicate
      && claimIdx < payIdx
      && payIdx < svcIdx
      && svcIdx < procIdx
      && procIdx < commitIdx
      && pg.ledger.serviceMutations === 1);
  }

  // Exact replay → no mutations
  {
    const ledger = {
      events: new Map(),
      paymentsMutations: 0,
      serviceMutations: 0,
      bookingMutations: 0,
    };
    const input = claimBase();
    const pg1 = makeFakeTxnPg({ ledger });
    await runBookingPaymentRouteTxn(pg1, input, async () => {
      await pg1.query('UPDATE payments SET status = $1', ['paid']);
    });
    const mutAfterFirst = ledger.paymentsMutations;
    const pg2 = makeFakeTxnPg({ ledger });
    const replay = await runBookingPaymentRouteTxn(pg2, input, async () => {
      await pg2.query('UPDATE payments SET status = $1', ['paid']);
    });
    green('exact_replay_no_mutations',
      replay.status === 200
      && replay.duplicate === true
      && replay.body.idempotent === true
      && replay.body.reason === IDEMPOTENT_DUPLICATE_REASON
      && ledger.paymentsMutations === mutAfterFirst
      && pg2.state.rolledBack === true
      && pg2.state.committed === false);
  }

  // Concurrent same event — one mutation path
  {
    const ledger = {
      events: new Map(),
      paymentsMutations: 0,
      serviceMutations: 0,
      bookingMutations: 0,
    };
    const input = claimBase({ stripeEventId: `evt_concurrent_${Date.now()}` });
    const pgA = makeFakeTxnPg({ ledger });
    const pgB = makeFakeTxnPg({ ledger });
    // Serialize claim via shared ledger: first BEGIN+claim wins when committed mid-flight.
    // Simulate race: A claims in open txn; B sees pending via shared map after A inserts pending.
    const rAPromise = runBookingPaymentRouteTxn(pgA, input, async () => {
      await new Promise((r) => setTimeout(r, 30));
      await pgA.query('UPDATE payments SET status = $1', ['paid']);
    });
    await new Promise((r) => setTimeout(r, 5));
    const rB = await runBookingPaymentRouteTxn(pgB, input, async () => {
      await pgB.query('UPDATE payments SET status = $1', ['paid']);
    });
    const rA = await rAPromise;
    const winners = [rA, rB].filter((r) => !r.duplicate && r.status === 200);
    const dupes = [rA, rB].filter((r) => r.duplicate);
    green('concurrent_same_event_one_mutation_path',
      winners.length === 1
      && dupes.length === 1
      && ledger.paymentsMutations === 1,
      `winners=${winners.length} dupes=${dupes.length} mut=${ledger.paymentsMutations}`);
  }

  // Mutation failure rolls back; retry succeeds
  {
    const ledger = {
      events: new Map(),
      paymentsMutations: 0,
      serviceMutations: 0,
      bookingMutations: 0,
    };
    const input = claimBase({ stripeEventId: `evt_retry_${uuid().slice(0, 8)}` });
    let blow = true;
    const pgFail = makeFakeTxnPg({
      ledger,
      failOn: (text) => {
        if (blow && /UPDATE payments/i.test(text)) {
          return { message: 'mutation_boom', code: 'mutation_boom' };
        }
        return null;
      },
    });
    const failed = await runBookingPaymentRouteTxn(pgFail, input, async () => {
      await pgFail.query('UPDATE payments SET status = $1', ['paid']);
    });
    red('mutation_failure_rolls_back_no_claim',
      failed.status === 500
      && !ledger.events.has(input.stripeEventId)
      && ledger.paymentsMutations === 0
      && pgFail.state.rolledBack === true);
    blow = false;
    const pgRetry = makeFakeTxnPg({ ledger });
    const retried = await runBookingPaymentRouteTxn(pgRetry, input, async () => {
      await pgRetry.query('UPDATE payments SET status = $1', ['paid']);
    });
    green('retry_after_rollback_succeeds',
      retried.status === 200
      && !retried.duplicate
      && ledger.events.has(input.stripeEventId)
      && ledger.events.get(input.stripeEventId).processed === true
      && ledger.paymentsMutations === 1);
  }

  // Processed failure rolls back; retry succeeds
  {
    const ledger = {
      events: new Map(),
      paymentsMutations: 0,
      serviceMutations: 0,
      bookingMutations: 0,
    };
    const input = claimBase({ stripeEventId: `evt_procfail_${uuid().slice(0, 8)}` });
    let blowProc = true;
    const pgFail = makeFakeTxnPg({
      ledger,
      failOn: (text) => {
        if (blowProc && /UPDATE payment_events/i.test(text) && /processed/i.test(text)) {
          return { message: 'processed_boom', code: 'processed_boom' };
        }
        return null;
      },
    });
    const failed = await runBookingPaymentRouteTxn(pgFail, input, async () => {
      await pgFail.query('UPDATE payments SET status = $1', ['paid']);
    });
    red('processed_failure_rolls_back',
      failed.status === 500
      && !ledger.events.has(input.stripeEventId)
      && pgFail.state.rolledBack === true);
    blowProc = false;
    const pgRetry = makeFakeTxnPg({ ledger });
    const retried = await runAddonServiceRouteTxn(pgRetry, Object.assign({}, input, { path: 'addon_service' }), async () => {
      await pgRetry.query('UPDATE payments SET status = $1', ['paid']);
    });
    green('retry_after_processed_failure_succeeds',
      retried.status === 200 && ledger.events.get(input.stripeEventId).processed === true);
  }

  // Cross-tenant / invalid — no claim (helper rejects before insert)
  {
    const pg = makeFakeTxnPg();
    await pg.query('BEGIN');
    let threw = null;
    try {
      await claimStripeWebhookEvent(pg, claimBase({ hostelId: 'not-a-uuid' }));
    } catch (e) { threw = e; }
    await pg.query('ROLLBACK');
    red('invalid_hostel_id_no_claim',
      threw && threw.code === 'hostel_id_invalid'
      && pg.state.queries.every((q) => !/INSERT INTO payment_events/i.test(q.text)));
  }

  // Commit failure simulation: mutate ok, then COMMIT throws → rollback path used by caller
  {
    const ledger = {
      events: new Map(),
      paymentsMutations: 0,
      serviceMutations: 0,
      bookingMutations: 0,
    };
    const input = claimBase({ stripeEventId: `evt_commitfail_${uuid().slice(0, 8)}` });
    const pg = makeFakeTxnPg({
      ledger,
      failOn: (text) => (/^COMMIT$/i.test(text) ? { message: 'commit_boom', code: 'commit_boom' } : null),
    });
    const failed = await runBookingPaymentRouteTxn(pg, input, async () => {
      await pg.query('UPDATE payments SET status = $1', ['paid']);
    });
    // COMMIT throws → catch ROLLBACK restores snapshot → no durable claim
    red('commit_failure_no_durable_claim',
      failed.status === 500
      && !ledger.events.has(input.stripeEventId));
    const pg2 = makeFakeTxnPg({ ledger });
    const ok2 = await runBookingPaymentRouteTxn(pg2, input, async () => {
      await pg2.query('UPDATE payments SET status = $1', ['paid']);
    });
    green('retry_after_commit_failure_succeeds',
      ok2.status === 200 && ledger.events.has(input.stripeEventId));
  }

  // Deterministic idempotent body
  {
    const body = buildStripeEventClaimIdempotentBody({
      stripeEventId: 'evt_x',
      eventType: 'checkout.session.completed',
      paymentId: 'p1',
      bookingId: 'b1',
    });
    green('idempotent_body_deterministic',
      body.success === true
      && body.idempotent === true
      && body.reason === IDEMPOTENT_DUPLICATE_REASON
      && body.no_db_write === true
      && body.stripe_event_id === 'evt_x');
  }

  // Wire proofs for both paths + validation/tenant preserved
  green('addon_path_wires_claim_before_payment_update',
    /withStripeWebhookEventClaim[\s\S]{0,800}UPDATE payments[\s\S]{0,400}addon_service/.test(apiSrc)
    || (/path: 'addon_service'/.test(apiSrc)
      && /withStripeWebhookEventClaim[\s\S]*UPDATE payments/.test(blocks.addon)));
  green('booking_path_wires_claim_before_apply',
    /withStripeWebhookEventClaim[\s\S]*applyStripeBookingPaymentTruthWrites/.test(blocks.booking));
  green('signature_and_tenant_gate_still_before_lookup',
    /constructEvent|STRIPE_WEBHOOK_SKIP_VERIFY/.test(apiSrc)
    && /resolveStripeWebhookExpectedClientSlug[\s\S]{0,900}lookupPaymentForStripeSession/.test(apiSrc));
  green('validation_still_before_booking_claim',
    /validateStripeBookingPaymentEvent[\s\S]{0,1200}withStripeWebhookEventClaim/.test(apiSrc));
  green('duplicate_claim_returns_http_200_idempotent',
    /bookingDuplicateClaim[\s\S]{0,200}sendJSON\(res,\s*200,\s*buildStripeEventClaimIdempotentBody/.test(apiSrc)
    && /addonDuplicateClaim[\s\S]{0,300}buildStripeEventClaimIdempotentBody/.test(apiSrc));
  green('db_errors_still_retryable_500',
    /sendJSON\(res,\s*500,\s*\{\s*success:\s*false,\s*error:\s*'DB update failed:/.test(apiSrc));

  // Contract still_open gates
  ok('C8 still_open lists deploy/live/concurrency/replay/DLQ/drill',
    Array.isArray(contract.still_open)
    && contract.still_open.some((s) => /deploy/i.test(s))
    && contract.still_open.some((s) => /replay|DLQ|operator/i.test(s))
    && contract.still_open.some((s) => /concurren/i.test(s) || /drill/i.test(s)));
  ok('C9 zero live mutation claim',
    contract.zero_live_mutation === true
    && contract.liveDeployEnabled === false
    && contract.execution_claim === false);
  ok('C10 package script present',
    /"verify:radar-slice16m-stripe-event-claim"/.test(readText('package.json')));

  console.log(`\nResult: ${pass} passed, ${fail} failed (RED ${redPass}/${redPass + redFail}, GREEN ${greenPass}/${greenPass + greenFail})`);
  if (fail > 0) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
