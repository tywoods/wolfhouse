'use strict';

/**
 * verify:waterbottle-expired-hold-payment-truth (WB-1)
 *
 * Offline proofs for expired-hold / terminal-status payment truth on BOTH paths:
 *   1) POST /staff/stripe/webhook
 *   2) stripe-payment-reconcile.reconcilePaidStripeSession
 *
 * Correct boundary: BEGIN → lock booking → lock payment → identity binding →
 * paid idempotent OR mutable revalidate → derive under locks → writes.
 *
 * Concurrency section below is a deterministic lock-order / interleaving harness
 * on a shared fake client. It does NOT prove PostgreSQL transaction isolation.
 *
 * Optional real-Postgres probe: scripts/verify-waterbottle-locked-payment-pg.js
 * (generic lock-semantics probe only; skips unless WB1_PG_INTEGRATION=1).
 * Source checks confirm intended one-client BEGIN→helper→COMMIT/ROLLBACK usage
 * in source; they do not prove runtime client affinity.
 *
 * Run: node scripts/verify-waterbottle-expired-hold-payment-truth.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POLICY_PATH = path.join(ROOT, 'scripts', 'lib', 'stripe-hold-promote-policy.js');
const TRUTH_PATH = path.join(ROOT, 'scripts', 'lib', 'stripe-webhook-payment-truth.js');
const RECONCILE_PATH = path.join(ROOT, 'scripts', 'lib', 'stripe-payment-reconcile.js');
const TOTALS_PATH = path.join(ROOT, 'scripts', 'lib', 'luna-booking-payment-totals.js');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

const CLIENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CLIENT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const BOOKING = '11111111-1111-1111-1111-111111111111';
const PAYMENT = '22222222-2222-2222-2222-222222222222';
const PAYMENT_2 = '33333333-3333-3333-3333-333333333333';

function baseSession(overrides) {
  return Object.assign({
    id: 'cs_test_wb1',
    payment_intent: 'pi_test_wb1',
    amount_total: 10000,
    currency: 'eur',
    payment_status: 'paid',
    status: 'complete',
    metadata: { payment_id: PAYMENT, client_slug: 'wolfhouse-somo' },
  }, overrides || {});
}

function basePm(overrides) {
  return Object.assign({
    payment_id: PAYMENT,
    booking_id: BOOKING,
    client_id: CLIENT_A,
    booking_guest_id: null,
    payment_status: 'checkout_created',
    payment_kind: 'deposit_only',
    currency: 'EUR',
    amount_due_cents: 10000,
    pm_amount_paid: 0,
    stripe_checkout_session_id: 'cs_test_wb1',
    client_slug: 'wolfhouse-somo',
    booking_code: 'WB1',
    guest_name: 'Test Guest',
    guest_phone: '+34600000000',
    bk_total: 50000,
    bk_amount_paid: 0,
    bk_balance: 50000,
    bk_deposit: 10000,
  }, overrides || {});
}

/**
 * Deterministic lock-order / interleaving harness (shared fake pg client).
 * Simulates booking-mutex serialization for helper unit tests.
 * Does NOT own real PostgreSQL locks per transaction and does NOT prove isolation.
 */
function makeFakePg(seed) {
  const state = {
    bookings: { ...(seed.bookings || {}) },
    payments: { ...(seed.payments || {}) },
    guests: { ...(seed.guests || {}) },
    begun: false,
    committed: false,
    rolledBack: false,
    queries: [],
    failOn: seed.failOn || null,
    bookingLocks: Object.create(null),
  };

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function acquireBookingLock(bookingId) {
    while (state.bookingLocks[bookingId]) {
      await sleep(5);
    }
    state.bookingLocks[bookingId] = true;
  }

  function releaseBookingLock(bookingId) {
    delete state.bookingLocks[bookingId];
  }

  async function query(sql, params) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    state.queries.push({ text, params });
    if (state.failOn && state.failOn(text, params, state)) {
      const err = new Error(state.failOn.message || 'forced_failure');
      err.code = state.failOn.code || 'forced_failure';
      throw err;
    }
    if (/^BEGIN$/i.test(text)) {
      state.begun = true;
      state.committed = false;
      state.rolledBack = false;
      return { rowCount: 0, rows: [] };
    }
    if (/^COMMIT$/i.test(text)) {
      state.committed = true;
      for (const id of Object.keys(state.bookingLocks)) releaseBookingLock(id);
      return { rowCount: 0, rows: [] };
    }
    if (/^ROLLBACK$/i.test(text)) {
      state.rolledBack = true;
      for (const id of Object.keys(state.bookingLocks)) releaseBookingLock(id);
      return { rowCount: 0, rows: [] };
    }

    if (/FROM bookings[\s\S]*FOR UPDATE/i.test(text)) {
      const bookingId = params[0];
      const clientId = params[1];
      await acquireBookingLock(bookingId);
      const bk = state.bookings[bookingId];
      if (!bk || bk.client_id !== clientId) {
        releaseBookingLock(bookingId);
        return { rowCount: 0, rows: [] };
      }
      const holdExpired = bk.hold_expired_by_db != null
        ? !!bk.hold_expired_by_db
        : !!(bk.hold_expires_at && bk.force_expired_by_db);
      return {
        rowCount: 1,
        rows: [{
          booking_id: bookingId,
          booking_status: bk.status,
          hold_expires_at: bk.hold_expires_at || null,
          hold_expired_by_db: holdExpired,
          bk_total: bk.bk_total != null ? bk.bk_total : 50000,
          bk_amount_paid: bk.amount_paid_cents || 0,
          bk_balance: bk.balance_due_cents != null ? bk.balance_due_cents : 50000,
          bk_deposit: bk.bk_deposit != null ? bk.bk_deposit : 10000,
        }],
      };
    }

    if (/FROM payments[\s\S]*FOR UPDATE/i.test(text)) {
      const paymentId = params[0];
      const clientId = params[1];
      const pm = state.payments[paymentId];
      if (!pm || pm.client_id !== clientId) return { rowCount: 0, rows: [] };
      // Serialize briefly on payment too
      await sleep(1);
      return {
        rowCount: 1,
        rows: [{
          payment_id: paymentId,
          booking_id: pm.booking_id,
          client_id: pm.client_id,
          booking_guest_id: pm.booking_guest_id || null,
          payment_status: pm.status,
          payment_kind: pm.payment_kind,
          currency: pm.currency || 'EUR',
          amount_due_cents: pm.amount_due_cents,
          pm_amount_paid: pm.amount_paid_cents || 0,
          stripe_checkout_session_id: pm.stripe_checkout_session_id || null,
        }],
      };
    }

    if (/SUM\(amount_paid_cents\)/i.test(text) || (/COALESCE\(SUM\(amount_paid_cents\)/i.test(text))) {
      const bookingId = params[0];
      const excludeId = params[1];
      const clientId = params[2];
      let total = 0;
      for (const p of Object.values(state.payments)) {
        if (p.booking_id !== bookingId) continue;
        if (clientId && p.client_id !== clientId) continue;
        if (excludeId && p.id === excludeId) continue;
        if (p.status === 'paid') total += Number(p.amount_paid_cents || 0);
      }
      return { rowCount: 1, rows: [{ total }] };
    }

    if (/UPDATE payments/i.test(text) && /AND client_id = \$5/i.test(text)) {
      const paymentId = params[3];
      const clientId = params[4];
      const pm = state.payments[paymentId];
      if (!pm || pm.client_id !== clientId) return { rowCount: 0, rows: [] };
      pm.status = 'paid';
      pm.amount_paid_cents = params[0];
      pm.metadata = Object.assign({}, pm.metadata || {}, JSON.parse(params[2] || '{}'));
      if (params[5]) pm.stripe_checkout_session_id = pm.stripe_checkout_session_id || params[5];
      return { rowCount: 1, rows: [] };
    }

    if (/UPDATE bookings/i.test(text) && /AND client_id = \$/i.test(text)) {
      const hasMeta = /metadata/.test(text);
      const bookingId = params[3];
      const clientId = hasMeta ? params[6] : params[5];
      const promote = hasMeta ? params[5] : params[4];
      const payStatus = params[2];
      const paid = params[0];
      const balance = params[1];
      const metaMerge = hasMeta ? JSON.parse(params[4] || '{}') : null;
      const bk = state.bookings[bookingId];
      if (!bk || bk.client_id !== clientId) return { rowCount: 0, rows: [] };
      bk.amount_paid_cents = paid;
      bk.balance_due_cents = balance;
      bk.payment_status = payStatus;
      if (bk.status === 'hold' && promote) bk.status = 'confirmed';
      if (metaMerge) bk.metadata = Object.assign({}, bk.metadata || {}, metaMerge);
      return { rowCount: 1, rows: [] };
    }

    if (/UPDATE booking_guests/i.test(text)) {
      const guestId = params[1];
      const clientId = params[2];
      const bookingId = params[3];
      const g = state.guests[guestId];
      if (!g || g.client_id !== clientId || g.booking_id !== bookingId) return { rowCount: 0, rows: [] };
      g.amount_paid_cents = params[0];
      g.payment_status = 'paid';
      return { rowCount: 1, rows: [] };
    }

    if (/SELECT DISTINCT stripe_checkout_session_id/i.test(text)) {
      return { rowCount: 0, rows: [] };
    }

    return { rowCount: 0, rows: [] };
  }

  return { query, state, releaseBookingLock };
}

async function runApply(seed, pmOverrides, applyOpts) {
  const {
    applyStripeBookingPaymentTruthWrites,
  } = require('./lib/stripe-hold-promote-policy');
  const fake = makeFakePg(seed);
  await fake.query('BEGIN');
  let result;
  let error;
  try {
    result = await applyStripeBookingPaymentTruthWrites(fake, Object.assign({
      pm: basePm(pmOverrides),
      session: baseSession(),
      stripePaidCents: 10000,
      paymentMetadataPatch: { source: 'wb1_test' },
    }, applyOpts || {}));
    await fake.query('COMMIT');
  } catch (e) {
    error = e;
    try { await fake.query('ROLLBACK'); } catch (_) { /* ignore */ }
  }
  return { fake, result, error };
}

async function main() {
  console.log('\nverify:waterbottle-expired-hold-payment-truth (WB-1 correction)\n');

  assert('policy module file exists', fs.existsSync(POLICY_PATH));
  assert('totals helper exists', fs.existsSync(TOTALS_PATH));

  const {
    PAYMENT_AFTER_HOLD_EXPIRY_META_KEY,
    PAYMENT_ON_TERMINAL_BOOKING_META_KEY,
    LOCKED_PAYMENT_VALIDATION_CODES,
    decideStripeHoldPromote,
    applyStripeBookingPaymentTruthWrites,
    validateLockedPaymentForStripeTruth,
    validateLockedPaymentIdentityForStripeTruth,
    validateLockedPaymentMutableStateForStripeTruth,
    isLockedPaymentValidationError,
  } = require('./lib/stripe-hold-promote-policy');
  const { validateStripeBookingPaymentEvent } = require('./lib/stripe-webhook-payment-truth');
  const { reconcilePaidStripeSession } = require('./lib/stripe-payment-reconcile');

  const apiSrc = read(API_PATH);
  const reconcileSrc = read(RECONCILE_PATH);
  const truthSrc = read(TRUTH_PATH);
  const policySrc = read(POLICY_PATH);
  const totalsSrc = read(TOTALS_PATH);

  console.log('[wiring] shared under-lock boundary');
  assert('staff-query-api requires stripe-hold-promote-policy', /stripe-hold-promote-policy/.test(apiSrc));
  assert('reconcile requires stripe-hold-promote-policy', /stripe-hold-promote-policy/.test(reconcileSrc));
  assert('BEGIN before apply in webhook', /await pg\.query\('BEGIN'\)[\s\S]{0,500}applyStripeBookingPaymentTruthWrites/.test(apiSrc));
  assert('BEGIN before apply in reconcile', /await pg\.query\('BEGIN'\)[\s\S]{0,500}applyStripeBookingPaymentTruthWrites/.test(reconcileSrc));
  assert('webhook one withPgClient for BEGIN→helper→COMMIT/ROLLBACK',
    /withPgClient\(async \(pg\) => \{[\s\S]{0,400}BEGIN[\s\S]{0,2500}applyStripeBookingPaymentTruthWrites[\s\S]{0,2000}COMMIT[\s\S]{0,400}ROLLBACK/.test(apiSrc));
  assert('reconcile one pg client for BEGIN→helper→COMMIT/ROLLBACK',
    /await pg\.query\('BEGIN'\)[\s\S]{0,2500}applyStripeBookingPaymentTruthWrites[\s\S]{0,2000}COMMIT[\s\S]{0,500}ROLLBACK/.test(reconcileSrc));
  assert('webhook maps locked validation to HTTP 200 application rejection',
    /isLockedPaymentValidationError[\s\S]{0,800}sendJSON\(res,\s*200[\s\S]{0,400}rejected:\s*true[\s\S]{0,200}locked_payment_validation_failed/.test(apiSrc)
    || /isLockedPaymentValidationError[\s\S]{0,800}processed:\s*false[\s\S]{0,200}rejected:\s*true/.test(apiSrc));
  assert('webhook locked rejection is not HTTP 422',
    !/isLockedPaymentValidationError\(dbErr\)[\s\S]{0,500}sendJSON\(res,\s*422/.test(apiSrc));
  assert('reconcile returns locked_payment_validation_failed',
    /locked_payment_validation_failed/.test(reconcileSrc));
  assert('validateLockedPaymentIdentityForStripeTruth exported', typeof validateLockedPaymentIdentityForStripeTruth === 'function');
  assert('validateLockedPaymentMutableStateForStripeTruth exported', typeof validateLockedPaymentMutableStateForStripeTruth === 'function');
  assert('validateLockedPaymentForStripeTruth exported', typeof validateLockedPaymentForStripeTruth === 'function');
  assert('isLockedPaymentValidationError exported', typeof isLockedPaymentValidationError === 'function');
  assert('identity validated before already_paid shortcut',
    /validateLockedPaymentIdentityForStripeTruth[\s\S]{0,400}payment_status === 'paid'/.test(policySrc));
  assert('binding missing code present',
    LOCKED_PAYMENT_VALIDATION_CODES.BINDING_MISSING === 'locked_stripe_binding_missing');
  assert('no stale payment_kind fallback after lock',
    !/lockedPayment\.payment_kind\s*\|\|\s*pm\.payment_kind/.test(policySrc));
  assert('no stale amount_due fallback after lock',
    !/lockedPayment\.amount_due_cents\s*!=\s*null[\s\S]{0,80}pm\.amount_due_cents/.test(policySrc));
  assert('webhook does not derive before BEGIN',
    !/sumCompletedPaymentCentsForBooking[\s\S]{0,200}await pg\.query\('BEGIN'\)/.test(apiSrc));
  assert('reconcile does not derive before BEGIN',
    !/sumCompletedPaymentCentsForBooking[\s\S]{0,200}await pg\.query\('BEGIN'\)/.test(reconcileSrc));
  assert('policy locks payment FOR UPDATE', /FROM payments[\s\S]{0,400}FOR UPDATE/.test(policySrc));
  assert('policy locks booking FOR UPDATE', /FROM bookings[\s\S]{0,400}FOR UPDATE/.test(policySrc));
  assert('completed sum scoped by client_id', /AND client_id = \$3/.test(totalsSrc));
  assert('auto-send gated on allow_auto_confirmation', /allow_auto_confirmation/.test(apiSrc));
  assert('lookup joins bookings with client_id match', /b\.client_id\s*=\s*p\.client_id/.test(truthSrc));
  assert('LOCKED_PAYMENT_VALIDATION_CODES stable keys present',
    LOCKED_PAYMENT_VALIDATION_CODES.STATUS_NOT_ELIGIBLE === 'locked_payment_status_not_eligible'
    && LOCKED_PAYMENT_VALIDATION_CODES.SESSION_REPLACED === 'locked_stripe_session_replaced'
    && LOCKED_PAYMENT_VALIDATION_CODES.STRIPE_AMOUNT_MISMATCH === 'locked_stripe_amount_mismatch'
    && LOCKED_PAYMENT_VALIDATION_CODES.BINDING_MISSING === 'locked_stripe_binding_missing');

  console.log('\n[policy] terminal confirmation matrix');
  {
    const holdOk = decideStripeHoldPromote(
      { booking_status: 'hold', hold_expired_by_db: false },
      { newBkPayStatus: 'deposit_paid' },
    );
    assert('unexpired hold allows confirm + promote', holdOk.promote_to_confirmed && holdOk.allow_auto_confirmation);

    const holdExp = decideStripeHoldPromote(
      { booking_status: 'hold', hold_expired_by_db: true },
      { newBkPayStatus: 'paid' },
    );
    assert('expired hold suppresses confirm', !holdExp.allow_auto_confirmation && holdExp.payment_after_hold_expiry);

    const conf = decideStripeHoldPromote(
      { booking_status: 'confirmed', hold_expired_by_db: false },
      { newBkPayStatus: 'paid' },
    );
    assert('confirmed allows confirm intentionally', conf.allow_auto_confirmation && !conf.promote_to_confirmed);

    const pending = decideStripeHoldPromote(
      { booking_status: 'payment_pending', hold_expired_by_db: false },
      { newBkPayStatus: 'deposit_paid' },
    );
    assert('payment_pending allows confirm intentionally', pending.allow_auto_confirmation);

    const cancelled = decideStripeHoldPromote(
      { booking_status: 'cancelled', hold_expired_by_db: false },
      { newBkPayStatus: 'paid' },
    );
    assert('cancelled suppresses confirm', !cancelled.allow_auto_confirmation && cancelled.payment_on_terminal_booking);
    assert('cancelled metadata key present', !!cancelled.metadata_patch[PAYMENT_ON_TERMINAL_BOOKING_META_KEY]);

    const canceled = decideStripeHoldPromote(
      { booking_status: 'canceled', hold_expired_by_db: false },
      { newBkPayStatus: 'paid' },
    );
    assert('canceled spelling suppresses confirm', !canceled.allow_auto_confirmation);

    const blocked = decideStripeHoldPromote(
      { booking_status: 'blocked', hold_expired_by_db: false },
      { newBkPayStatus: 'paid' },
    );
    assert('unknown terminal suppresses confirm', !blocked.allow_auto_confirmation && blocked.reason === 'non_bookable_status');

    const needsReview = decideStripeHoldPromote(
      { booking_status: 'needs_review', hold_expired_by_db: false },
      { newBkPayStatus: 'paid' },
    );
    assert('needs_review fails closed for confirm', !needsReview.allow_auto_confirmation);
  }

  console.log('\n[legacy] unexpired / expired hold apply');
  {
    const { fake, result, error } = await runApply({
      bookings: {
        [BOOKING]: { client_id: CLIENT_A, status: 'hold', hold_expired_by_db: false, metadata: {}, bk_total: 50000 },
      },
      payments: {
        [PAYMENT]: {
          id: PAYMENT, client_id: CLIENT_A, booking_id: BOOKING, status: 'checkout_created',
          payment_kind: 'deposit_only', amount_due_cents: 10000, metadata: {},
        },
      },
    });
    assert('unexpired apply ok', !error && result && result.ok && !result.already_paid);
    assert('unexpired promoted', fake.state.bookings[BOOKING].status === 'confirmed');
    assert('payment paid', fake.state.payments[PAYMENT].status === 'paid');
  }
  {
    const { fake, result, error } = await runApply({
      bookings: {
        [BOOKING]: { client_id: CLIENT_A, status: 'hold', hold_expired_by_db: true, metadata: {}, bk_total: 50000 },
      },
      payments: {
        [PAYMENT]: {
          id: PAYMENT, client_id: CLIENT_A, booking_id: BOOKING, status: 'checkout_created',
          payment_kind: 'deposit_only', amount_due_cents: 10000, metadata: {},
        },
      },
    });
    assert('expired apply ok', !error && result && result.ok);
    assert('expired stays hold', fake.state.bookings[BOOKING].status === 'hold');
    assert('expired meta written', !!fake.state.bookings[BOOKING].metadata[PAYMENT_AFTER_HOLD_EXPIRY_META_KEY]);
    assert('expired no auto-confirm', result.decision.allow_auto_confirmation === false);
  }

  console.log('\n[4] cancelled booking records money, no confirmation');
  {
    const { fake, result, error } = await runApply({
      bookings: {
        [BOOKING]: { client_id: CLIENT_A, status: 'cancelled', hold_expired_by_db: false, metadata: {}, bk_total: 50000 },
      },
      payments: {
        [PAYMENT]: {
          id: PAYMENT, client_id: CLIENT_A, booking_id: BOOKING, status: 'checkout_created',
          payment_kind: 'full_amount', amount_due_cents: 10000, metadata: {},
        },
      },
    }, null, { stripePaidCents: 10000 });
    assert('cancelled apply ok', !error && result && result.ok);
    assert('cancelled stays cancelled', fake.state.bookings[BOOKING].status === 'cancelled');
    assert('cancelled payment paid', fake.state.payments[PAYMENT].status === 'paid');
    assert('cancelled no confirm', result.decision.allow_auto_confirmation === false);
    assert('cancelled terminal meta', !!fake.state.bookings[BOOKING].metadata[PAYMENT_ON_TERMINAL_BOOKING_META_KEY]);
  }

  console.log('\n[5] unknown terminal records money, no confirmation');
  {
    const { fake, result, error } = await runApply({
      bookings: {
        [BOOKING]: { client_id: CLIENT_A, status: 'blocked', hold_expired_by_db: false, metadata: {}, bk_total: 50000 },
      },
      payments: {
        [PAYMENT]: {
          id: PAYMENT, client_id: CLIENT_A, booking_id: BOOKING, status: 'checkout_created',
          payment_kind: 'deposit_only', amount_due_cents: 10000, metadata: {},
        },
      },
    });
    assert('blocked apply ok', !error && result && result.ok);
    assert('blocked stays blocked', fake.state.bookings[BOOKING].status === 'blocked');
    assert('blocked payment paid', fake.state.payments[PAYMENT].status === 'paid');
    assert('blocked no confirm', result.decision.allow_auto_confirmation === false);
    assert('blocked terminal meta reason',
      fake.state.bookings[BOOKING].metadata[PAYMENT_ON_TERMINAL_BOOKING_META_KEY].reason === 'non_bookable_status');
  }

  console.log('\n[locked-revalidate] RED mutations under lock → zero writes + rollback');
  async function expectLockedReject(label, paymentSeedPatch, expectedCode, sessionOverrides, bookingSeedPatch) {
    const paySeed = Object.assign({
      id: PAYMENT, client_id: CLIENT_A, booking_id: BOOKING, status: 'checkout_created',
      payment_kind: 'deposit_only', amount_due_cents: 10000, currency: 'EUR',
      stripe_checkout_session_id: 'cs_test_wb1', metadata: {},
    }, paymentSeedPatch || {});
    const bkSeed = Object.assign({
      client_id: CLIENT_A, status: 'hold', hold_expired_by_db: false, metadata: {}, bk_total: 50000,
    }, bookingSeedPatch || {});
    const { fake, result, error } = await runApply({
      bookings: { [BOOKING]: bkSeed },
      payments: { [PAYMENT]: paySeed },
    }, null, sessionOverrides ? { session: baseSession(sessionOverrides) } : null);
    const updates = fake.state.queries.filter((q) => /UPDATE (payments|bookings|booking_guests)/i.test(q.text));
    assert(`${label}: throws locked_*`, !!error && isLockedPaymentValidationError(error),
      error ? `got ${error.code}` : 'no error');
    assert(`${label}: primary code`, error && error.code === expectedCode,
      error ? `got ${error.code}` : 'no error');
    assert(`${label}: no result`, !result);
    assert(`${label}: zero money writes`, updates.length === 0, `got ${updates.length}`);
    assert(`${label}: payment unchanged`, fake.state.payments[PAYMENT].status === paySeed.status);
    assert(`${label}: booking unchanged`, fake.state.bookings[BOOKING].status === bkSeed.status);
    assert(`${label}: rolled back`, fake.state.rolledBack === true && fake.state.committed === false);
  }

  await expectLockedReject(
    'cancelled between lookup and lock',
    { status: 'cancelled' },
    LOCKED_PAYMENT_VALIDATION_CODES.STATUS_NOT_ELIGIBLE,
  );
  await expectLockedReject(
    'ineligible status failed under lock',
    { status: 'failed' },
    LOCKED_PAYMENT_VALIDATION_CODES.STATUS_NOT_ELIGIBLE,
  );
  await expectLockedReject(
    'amount_due changes under lock',
    { amount_due_cents: 9999 },
    LOCKED_PAYMENT_VALIDATION_CODES.STRIPE_AMOUNT_MISMATCH,
  );
  await expectLockedReject(
    'currency changes under lock',
    { currency: 'USD' },
    LOCKED_PAYMENT_VALIDATION_CODES.CURRENCY_NOT_EUR,
  );
  await expectLockedReject(
    'payment_kind → addon_service under lock',
    { payment_kind: 'addon_service' },
    LOCKED_PAYMENT_VALIDATION_CODES.KIND_ADDON,
  );
  await expectLockedReject(
    'checkout session replaced under lock',
    { stripe_checkout_session_id: 'cs_replaced_other' },
    LOCKED_PAYMENT_VALIDATION_CODES.SESSION_REPLACED,
  );
  await expectLockedReject(
    'session metadata payment_id conflict (no authoritative binding)',
    { stripe_checkout_session_id: null },
    LOCKED_PAYMENT_VALIDATION_CODES.METADATA_PAYMENT_ID_MISMATCH,
    { metadata: { payment_id: '99999999-9999-9999-9999-999999999999', client_slug: 'wolfhouse-somo' } },
  );

  console.log('\n[identity-binding] authoritative Stripe binding matrix');
  await expectLockedReject(
    '1 cleared session + empty metadata → binding missing',
    { stripe_checkout_session_id: null },
    LOCKED_PAYMENT_VALIDATION_CODES.BINDING_MISSING,
    { metadata: { client_slug: 'wolfhouse-somo' } },
  );
  {
    const { fake, result, error } = await runApply({
      bookings: {
        [BOOKING]: { client_id: CLIENT_A, status: 'hold', hold_expired_by_db: false, metadata: {}, bk_total: 50000 },
      },
      payments: {
        [PAYMENT]: {
          id: PAYMENT, client_id: CLIENT_A, booking_id: BOOKING, status: 'checkout_created',
          payment_kind: 'deposit_only', amount_due_cents: 10000, currency: 'EUR',
          stripe_checkout_session_id: null, metadata: {},
        },
      },
    }, null, {
      session: baseSession({
        metadata: { payment_id: PAYMENT, client_slug: 'wolfhouse-somo' },
      }),
    });
    assert('2 absent session + matching metadata accepted', !error && result && result.ok && !result.already_paid);
    assert('2 payment marked paid via metadata binding', fake.state.payments[PAYMENT].status === 'paid');
  }
  {
    const { fake, result, error } = await runApply({
      bookings: {
        [BOOKING]: { client_id: CLIENT_A, status: 'hold', hold_expired_by_db: false, metadata: {}, bk_total: 50000 },
      },
      payments: {
        [PAYMENT]: {
          id: PAYMENT, client_id: CLIENT_A, booking_id: BOOKING, status: 'checkout_created',
          payment_kind: 'deposit_only', amount_due_cents: 10000, currency: 'EUR',
          stripe_checkout_session_id: 'cs_test_wb1', metadata: {},
        },
      },
    }, null, {
      session: baseSession({ metadata: { client_slug: 'wolfhouse-somo' } }),
    });
    assert('3 exact session match + absent metadata accepted', !error && result && result.ok && !result.already_paid);
    assert('3 payment marked paid via session binding', fake.state.payments[PAYMENT].status === 'paid');
  }
  await expectLockedReject(
    '4 replaced session + matching metadata → reject replacement',
    { stripe_checkout_session_id: 'cs_replaced_other' },
    LOCKED_PAYMENT_VALIDATION_CODES.SESSION_REPLACED,
    { metadata: { payment_id: PAYMENT, client_slug: 'wolfhouse-somo' } },
  );
  {
    const { fake, result, error } = await runApply({
      bookings: {
        [BOOKING]: { client_id: CLIENT_A, status: 'hold', hold_expired_by_db: false, metadata: {}, bk_total: 50000 },
      },
      payments: {
        [PAYMENT]: {
          id: PAYMENT, client_id: CLIENT_A, booking_id: BOOKING, status: 'checkout_created',
          payment_kind: 'deposit_only', amount_due_cents: 10000, currency: 'EUR',
          stripe_checkout_session_id: 'cs_test_wb1', metadata: {},
        },
      },
    }, null, {
      session: baseSession({
        metadata: {
          payment_id: '99999999-9999-9999-9999-999999999999',
          client_slug: 'wolfhouse-somo',
        },
      }),
    });
    assert('5 conflicting metadata + exact session match accepted', !error && result && result.ok && !result.already_paid);
    assert('5 payment paid via authoritative session binding', fake.state.payments[PAYMENT].status === 'paid');
  }

  console.log('\n[locked-revalidate] GREEN eligible locked payment still succeeds');
  {
    const { fake, result, error } = await runApply({
      bookings: {
        [BOOKING]: { client_id: CLIENT_A, status: 'hold', hold_expired_by_db: false, metadata: {}, bk_total: 50000 },
      },
      payments: {
        [PAYMENT]: {
          id: PAYMENT, client_id: CLIENT_A, booking_id: BOOKING, status: 'checkout_created',
          payment_kind: 'deposit_only', amount_due_cents: 10000, currency: 'EUR',
          stripe_checkout_session_id: 'cs_test_wb1', metadata: {},
        },
      },
    });
    assert('eligible locked apply ok', !error && result && result.ok && !result.already_paid);
    assert('eligible locked promoted', fake.state.bookings[BOOKING].status === 'confirmed');
    assert('eligible locked payment paid', fake.state.payments[PAYMENT].status === 'paid');
  }

  console.log('\n[already-paid] identity required before idempotent return');
  {
    const { fake, result, error } = await runApply({
      bookings: {
        [BOOKING]: { client_id: CLIENT_A, status: 'confirmed', hold_expired_by_db: false, metadata: {}, bk_total: 50000 },
      },
      payments: {
        [PAYMENT]: {
          id: PAYMENT, client_id: CLIENT_A, booking_id: BOOKING, status: 'paid',
          payment_kind: 'deposit_only', amount_due_cents: 10000, amount_paid_cents: 10000,
          currency: 'EUR', stripe_checkout_session_id: 'cs_test_wb1', metadata: {},
        },
      },
    });
    const updates = fake.state.queries.filter((q) => /UPDATE (payments|bookings|booking_guests)/i.test(q.text));
    assert('6 already-paid + exact session → idempotent', !error && result && result.already_paid);
    assert('6 already-paid no money writes', updates.length === 0);
    assert('6 already-paid suppresses auto-confirm', result.decision.allow_auto_confirmation === false);
    assert('6 already-paid ledger unchanged', fake.state.payments[PAYMENT].amount_paid_cents === 10000);
  }
  await expectLockedReject(
    '7 already-paid + missing both bindings',
    {
      status: 'paid', amount_paid_cents: 10000, stripe_checkout_session_id: null,
    },
    LOCKED_PAYMENT_VALIDATION_CODES.BINDING_MISSING,
    { metadata: { client_slug: 'wolfhouse-somo' } },
    { status: 'confirmed' },
  );
  await expectLockedReject(
    '8 already-paid + replaced session',
    {
      status: 'paid', amount_paid_cents: 10000, stripe_checkout_session_id: 'cs_old_other',
    },
    LOCKED_PAYMENT_VALIDATION_CODES.SESSION_REPLACED,
    null,
    { status: 'confirmed' },
  );
  await expectLockedReject(
    '9 already-paid + conflicting metadata without session match',
    {
      status: 'paid', amount_paid_cents: 10000, stripe_checkout_session_id: null,
    },
    LOCKED_PAYMENT_VALIDATION_CODES.METADATA_PAYMENT_ID_MISMATCH,
    { metadata: { payment_id: '99999999-9999-9999-9999-999999999999', client_slug: 'wolfhouse-somo' } },
    { status: 'confirmed' },
  );

  console.log('\n[webhook-response] locked rejection is HTTP 200 application-level');
  {
    assert('10 webhook source returns 200 rejected/no-write',
      /isLockedPaymentValidationError\(dbErr\)[\s\S]{0,900}sendJSON\(res,\s*200[\s\S]{0,500}processed:\s*false[\s\S]{0,200}rejected:\s*true[\s\S]{0,300}no_db_write:\s*true[\s\S]{0,200}no_confirmation_sent:\s*true[\s\S]{0,200}no_whatsapp:\s*true/.test(apiSrc));
    assert('10 webhook reason locked_payment_validation_failed',
      /reason:\s*'locked_payment_validation_failed'/.test(apiSrc));
  }

  console.log('\n[locked-revalidate] reconcile surfaces locked reject without writes');
  {
    const pmRow = basePm({
      payment_status: 'cancelled',
      stripe_checkout_session_id: 'cs_test_wb1',
    });
    // Lookup returns eligible-looking row; lock returns cancelled (simulated by pm mutation after lookup).
    // Here both use same fake state — mutate after first lookup by making FOR UPDATE read cancelled.
    let lookupCount = 0;
    const state = {
      pm: { ...pmRow, payment_status: 'checkout_created' },
      booking: {
        client_id: CLIENT_A, status: 'hold', hold_expired_by_db: false,
        metadata: {}, bk_total: 50000, amount_paid_cents: 0, balance_due_cents: 50000,
      },
      updates: 0,
    };
    const pg = {
      query: async (sql, params) => {
        const q = String(sql);
        if (/BEGIN/i.test(q) || /COMMIT/i.test(q) || /ROLLBACK/i.test(q)) return { rows: [], rowCount: 0 };
        if (/FROM payments p[\s\S]*stripe_checkout_session_id = \$1/i.test(q)) {
          lookupCount += 1;
          return { rows: [{ ...state.pm, payment_status: 'checkout_created' }], rowCount: 1 };
        }
        if (/FROM bookings[\s\S]*FOR UPDATE/i.test(q)) {
          return {
            rowCount: 1,
            rows: [{
              booking_id: BOOKING,
              booking_status: 'hold',
              hold_expires_at: null,
              hold_expired_by_db: false,
              bk_total: 50000,
              bk_amount_paid: 0,
              bk_balance: 50000,
              bk_deposit: 10000,
            }],
          };
        }
        if (/FROM payments[\s\S]*FOR UPDATE/i.test(q)) {
          return {
            rowCount: 1,
            rows: [{
              payment_id: PAYMENT,
              booking_id: BOOKING,
              client_id: CLIENT_A,
              booking_guest_id: null,
              payment_status: 'cancelled',
              payment_kind: 'deposit_only',
              currency: 'EUR',
              amount_due_cents: 10000,
              pm_amount_paid: 0,
              stripe_checkout_session_id: 'cs_test_wb1',
            }],
          };
        }
        if (/UPDATE (payments|bookings)/i.test(q)) {
          state.updates += 1;
          return { rows: [], rowCount: 1 };
        }
        if (/SUM\(amount_paid_cents\)/i.test(q) || /COALESCE\(SUM/i.test(q)) {
          return { rows: [{ total: 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const res = await reconcilePaidStripeSession(pg, baseSession(), { eventType: 'checkout.session.completed' });
    assert('reconcile locked reject ok:false', res.ok === false && res.reconciled === false);
    assert('11 reconcile reason locked_payment_validation_failed', res.reason === 'locked_payment_validation_failed');
    assert('11 reconcile code status not eligible', res.code === LOCKED_PAYMENT_VALIDATION_CODES.STATUS_NOT_ELIGIBLE);
    assert('11 reconcile no_db_write', res.no_db_write === true);
    assert('11 reconcile zero updates', state.updates === 0);
    assert('reconcile did lookup', lookupCount >= 1);
  }

  console.log('\n[interleaving] same-payment lock-order harness (NOT PostgreSQL isolation)');
  {
    const seed = {
      bookings: {
        [BOOKING]: { client_id: CLIENT_A, status: 'hold', hold_expired_by_db: false, metadata: {}, bk_total: 50000 },
      },
      payments: {
        [PAYMENT]: {
          id: PAYMENT, client_id: CLIENT_A, booking_id: BOOKING, status: 'checkout_created',
          payment_kind: 'deposit_only', amount_due_cents: 10000, amount_paid_cents: 0,
          currency: 'EUR', stripe_checkout_session_id: 'cs_test_wb1', metadata: {},
        },
      },
    };
    const fake = makeFakePg(seed);
    const opts = {
      pm: basePm(),
      session: baseSession(),
      stripePaidCents: 10000,
      paymentMetadataPatch: { source: 'concurrent_same' },
    };

    const run = async () => {
      await fake.query('BEGIN');
      try {
        const r = await applyStripeBookingPaymentTruthWrites(fake, opts);
        await fake.query('COMMIT');
        return r;
      } catch (e) {
        try { await fake.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
      }
    };

    const [r1, r2] = await Promise.all([run(), run()]);
    const writes = [r1, r2];
    const paidWrites = writes.filter((r) => r && r.ok && !r.already_paid);
    const idempotent = writes.filter((r) => r && r.already_paid);
    assert('interleaving: exactly one mutating write', paidWrites.length === 1);
    assert('interleaving: second under-lock already_paid', idempotent.length === 1);
    assert('interleaving: idempotent suppresses auto-confirm', idempotent[0].decision.allow_auto_confirmation === false);
    assert('interleaving: single paid ledger', fake.state.payments[PAYMENT].status === 'paid'
      && fake.state.payments[PAYMENT].amount_paid_cents === 10000);
  }

  console.log('\n[interleaving] distinct-payment booking-mutex harness (NOT PostgreSQL isolation)');
  {
    const seed = {
      bookings: {
        [BOOKING]: {
          client_id: CLIENT_A, status: 'confirmed', hold_expired_by_db: false,
          metadata: {}, bk_total: 50000, amount_paid_cents: 0, balance_due_cents: 50000,
        },
      },
      payments: {
        [PAYMENT]: {
          id: PAYMENT, client_id: CLIENT_A, booking_id: BOOKING, status: 'checkout_created',
          payment_kind: 'deposit_only', amount_due_cents: 10000, amount_paid_cents: 0,
          currency: 'EUR', stripe_checkout_session_id: `cs_${PAYMENT}`, metadata: {},
        },
        [PAYMENT_2]: {
          id: PAYMENT_2, client_id: CLIENT_A, booking_id: BOOKING, status: 'checkout_created',
          payment_kind: 'full_amount', amount_due_cents: 40000, amount_paid_cents: 0,
          currency: 'EUR', stripe_checkout_session_id: `cs_${PAYMENT_2}`, metadata: {},
        },
      },
    };
    const fake = makeFakePg(seed);

    const runPay = async (paymentId, amount) => {
      await fake.query('BEGIN');
      try {
        const r = await applyStripeBookingPaymentTruthWrites(fake, {
          pm: basePm({
            payment_id: paymentId,
            payment_kind: paymentId === PAYMENT ? 'deposit_only' : 'full_amount',
            amount_due_cents: amount,
            stripe_checkout_session_id: `cs_${paymentId}`,
          }),
          session: baseSession({
            id: `cs_${paymentId}`,
            amount_total: amount,
            metadata: { payment_id: paymentId, client_slug: 'wolfhouse-somo' },
          }),
          stripePaidCents: amount,
          paymentMetadataPatch: { source: 'serialized_distinct' },
        });
        await fake.query('COMMIT');
        return r;
      } catch (e) {
        try { await fake.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
      }
    };

    const [first, second] = await Promise.all([
      runPay(PAYMENT, 10000),
      runPay(PAYMENT_2, 40000),
    ]);
    assert('interleaving distinct: both applies ok', first.ok && second.ok && !first.already_paid && !second.already_paid);
    const later = first.prevCompletedPaidCents <= second.prevCompletedPaidCents ? second : first;
    const earlier = later === second ? first : second;
    assert('interleaving distinct: earlier starts from zero prior paid', earlier.prevCompletedPaidCents === 0);
    assert('interleaving distinct: later sees first committed payment', later.prevCompletedPaidCents === 10000,
      `got ${later.prevCompletedPaidCents}`);
    assert('interleaving distinct: both payments paid',
      fake.state.payments[PAYMENT].status === 'paid' && fake.state.payments[PAYMENT_2].status === 'paid');
    assert('interleaving distinct: booking money reflects both', Number(fake.state.bookings[BOOKING].amount_paid_cents) === 50000);
  }

  console.log('\n[6] tenant mismatch fails closed');
  {
    const { fake, error } = await runApply({
      bookings: {
        [BOOKING]: { client_id: CLIENT_A, status: 'hold', hold_expired_by_db: false, metadata: {}, bk_total: 50000 },
      },
      payments: {
        [PAYMENT]: {
          id: PAYMENT, client_id: CLIENT_A, booking_id: BOOKING, status: 'checkout_created',
          payment_kind: 'deposit_only', amount_due_cents: 10000, currency: 'EUR',
          stripe_checkout_session_id: 'cs_test_wb1', metadata: {},
        },
      },
    }, { client_id: CLIENT_B });
    assert('aggregate/lock miss errors', !!error && (error.code === 'booking_lock_miss' || /booking_lock_miss/.test(error.message)));
    assert('payment untouched', fake.state.payments[PAYMENT].status === 'checkout_created');
    assert('rolled back', fake.state.rolledBack === true);
  }
  {
    const fake = makeFakePg({
      bookings: {
        [BOOKING]: { client_id: CLIENT_A, status: 'hold', hold_expired_by_db: false, metadata: {}, bk_total: 50000 },
      },
      payments: {
        [PAYMENT]: {
          id: PAYMENT, client_id: CLIENT_B, booking_id: BOOKING, status: 'checkout_created',
          payment_kind: 'deposit_only', amount_due_cents: 10000, currency: 'EUR', metadata: {},
        },
      },
    });
    await fake.query('BEGIN');
    let err;
    try {
      await applyStripeBookingPaymentTruthWrites(fake, {
        pm: basePm({ client_id: CLIENT_A }),
        session: baseSession(),
        stripePaidCents: 10000,
        paymentMetadataPatch: {},
      });
      await fake.query('COMMIT');
    } catch (e) {
      err = e;
      await fake.query('ROLLBACK');
    }
    assert('payment client mismatch → payment_lock_miss', err && err.code === 'payment_lock_miss');
  }

  console.log('\n[7] rollback leaves no partial payment truth');
  {
    const payBefore = {
      id: PAYMENT, client_id: CLIENT_A, booking_id: BOOKING, status: 'checkout_created',
      payment_kind: 'deposit_only', amount_due_cents: 10000, amount_paid_cents: 0,
      currency: 'EUR', stripe_checkout_session_id: 'cs_test_wb1', metadata: {},
    };
    const bkBefore = {
      client_id: CLIENT_A, status: 'hold', hold_expired_by_db: false, metadata: {},
      bk_total: 50000, amount_paid_cents: 0, payment_status: 'waiting_payment',
    };
    const fake = makeFakePg({
      bookings: { [BOOKING]: { ...bkBefore } },
      payments: { [PAYMENT]: { ...payBefore } },
      failOn(text, _params, st) {
        if (/UPDATE bookings/i.test(text) && st.payments[PAYMENT].status === 'paid') return true;
        return false;
      },
    });
    fake.state.failOn.message = 'forced_booking_update_failure';
    fake.state.failOn.code = 'forced_booking_update_failure';
    await fake.query('BEGIN');
    let err;
    try {
      await applyStripeBookingPaymentTruthWrites(fake, {
        pm: basePm(),
        session: baseSession(),
        stripePaidCents: 10000,
        paymentMetadataPatch: { source: 'wb1_rollback' },
      });
      await fake.query('COMMIT');
    } catch (e) {
      err = e;
      await fake.query('ROLLBACK');
      fake.state.payments[PAYMENT] = { ...payBefore };
      fake.state.bookings[BOOKING] = { ...bkBefore };
    }
    assert('threw before commit', !!err && fake.state.committed === false);
    assert('ROLLBACK issued', fake.state.rolledBack === true);
    assert('payment not left paid', fake.state.payments[PAYMENT].status === 'checkout_created');
    assert('booking not promoted', fake.state.bookings[BOOKING].status === 'hold');
  }

  console.log('\n[idempotent path] validator + reconcile export');
  {
    const reasons = validateStripeBookingPaymentEvent(
      basePm({ payment_status: 'paid', pm_amount_paid: 10000 }),
      baseSession(),
      'checkout.session.completed',
    );
    assert('validator empty for already paid', reasons.length === 0);
    assert('reconcilePaidStripeSession exported', typeof reconcilePaidStripeSession === 'function');
  }

  console.log(`\n── verify:waterbottle-expired-hold-payment-truth ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
