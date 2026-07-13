'use strict';

/**
 * verify:sunset-payment-link-concurrency
 *
 * Concurrent Sunset payment-link creation must serialize on the booking row,
 * pass Stripe Idempotency-Key, and never mint duplicate payable sessions.
 *
 * Run: node scripts/verify-sunset-payment-link-concurrency.js
 */

const {
  createSunsetScheduleStripeLink,
  buildStripeCheckoutIdempotencyKey,
  buildAuthoritativePaymentIntentKey,
} = require('./lib/sunset-stripe-payment-links');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

const BOOKING_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CLIENT_SLUG = 'sunset';
const IDEM = 'idem-concurrent-test-001';

function baseOpts(overrides) {
  return {
    clientSlug: CLIENT_SLUG,
    bookingId: BOOKING_ID,
    locationId: 'sunset-somo',
    idempotencyKey: IDEM,
    staffActionsEnabled: true,
    stripeLinksEnabled: true,
    stripeSecretKey: 'sk_test_concurrency',
    stripeSuccessUrl: 'https://example.test/success',
    stripeCancelUrl: 'https://example.test/cancel',
    ...overrides,
  };
}

function buildConcurrentPg(stripeCalls) {
  let lockHolder = null;
  const waiters = [];
  const payments = [];
  const booking = {
    booking_id: BOOKING_ID,
    booking_code: 'SUNSET-20260802-CONC',
    guest_name: 'Concurrent Guest',
    status: 'hold',
    payment_status: 'waiting_payment',
    check_in: '2026-08-02',
    check_out: '2026-08-03',
    metadata: { source: 'luna_guest_whatsapp', luna_guest_booking: true, location_id: 'sunset-somo' },
  };
  const services = [{
    service_type: 'surf_lesson',
    service_date: '2026-08-02',
    quantity: 1,
    amount_due_cents: 0,
    metadata: { location_id: 'sunset-somo', component: 'lesson' },
  }];

  async function acquireLock() {
    if (!lockHolder) {
      lockHolder = Promise.resolve();
      return;
    }
    await new Promise((resolve) => { waiters.push(resolve); });
  }

  function releaseLock() {
    const next = waiters.shift();
    if (next) next();
    else lockHolder = null;
  }

  const pg = {
    payments,
    stripeCalls,
    query: async (sql, params) => {
      const q = String(sql);
      if (/BEGIN/i.test(q)) return { rows: [] };
      if (/COMMIT/i.test(q)) { releaseLock(); return { rows: [] }; }
      if (/ROLLBACK/i.test(q)) { releaseLock(); return { rows: [] }; }
      if (/FROM bookings b[\s\S]*FOR UPDATE/i.test(q)) {
        await acquireLock();
        return { rows: [{ id: BOOKING_ID }] };
      }
      if (/FROM bookings b[\s\S]*INNER JOIN clients/i.test(q) && !/FOR UPDATE/i.test(q)) {
        return { rows: [booking] };
      }
      if (/FROM booking_service_records/i.test(q)) return { rows: services };
      if (/SELECT metadata FROM bookings/i.test(q)) {
        return { rows: [{ metadata: booking.metadata }] };
      }
      if (/SELECT id FROM clients WHERE slug/i.test(q)) {
        return { rows: [{ id: 'client-sunset-1' }] };
      }
      if (/UPDATE booking_service_records SET amount_due_cents/i.test(q)) return { rows: [] };
      if (/UPDATE bookings[\s\S]*total_amount_cents/i.test(q)) return { rows: [] };
      if (/metadata->>'source' = 'sunset_schedule_stripe_link'/i.test(q) && /payment_kind = \$2/i.test(q)) {
        const hit = payments.find((p) => p.booking_id === params[0]
          && (p.payment_kind || 'full_amount') === params[1]
          && Number(p.amount_due_cents) === Number(params[2])
          && (p.currency || 'EUR') === params[3]
          && p.metadata && p.metadata.source === 'sunset_schedule_stripe_link'
          && ['draft', 'checkout_created'].includes(String(p.status || p.payment_status)));
        return { rows: hit ? [hit] : [] };
      }
      if (/metadata->>'idempotency_key'/i.test(q)) {
        const hit = payments.find((p) => p.booking_id === params[0]
          && p.metadata && p.metadata.idempotency_key === params[1]);
        if (/ORDER BY created_at DESC/i.test(q)) {
          return { rows: hit ? [hit] : [] };
        }
        if (hit && hit.checkout_url) return { rows: [hit] };
        return { rows: [] };
      }
      if (/INSERT INTO payments/i.test(q)) {
        const row = {
          payment_id: `pay-${payments.length + 1}`,
          booking_id: params[1],
          status: 'draft',
          payment_status: 'draft',
          payment_kind: 'full_amount',
          currency: 'EUR',
          amount_due_cents: params[2],
          checkout_url: null,
          stripe_checkout_session_id: null,
          metadata: JSON.parse(params[3]),
        };
        payments.push(row);
        return { rows: [{ payment_id: row.payment_id }] };
      }
      if (/UPDATE payments[\s\S]*checkout_created/i.test(q)) {
        const pid = params[4];
        const row = payments.find((p) => p.payment_id === pid);
        if (row) {
          row.checkout_url = params[1];
          row.stripe_checkout_session_id = params[0];
          row.payment_status = 'checkout_created';
          row.status = 'checkout_created';
        }
        return { rows: [] };
      }
      if (/UPDATE payments[\s\S]*stripe_checkout_session_id = \$1/i.test(q)) {
        const row = payments.find((p) => p.payment_id === params[2]);
        if (row) {
          row.stripe_checkout_session_id = params[0];
          row.metadata = { ...(row.metadata || {}), ...JSON.parse(params[1]) };
        }
        return { rows: [] };
      }
      if (/UPDATE bookings[\s\S]*payment_link_sent/i.test(q)) return { rows: [] };
      if (/FROM payments[\s\S]*checkout_url IS NOT NULL[\s\S]*ORDER BY created_at DESC/i.test(q)) {
        const withUrl = payments.filter((p) => p.checkout_url);
        return { rows: withUrl.length ? [withUrl[withUrl.length - 1]] : [] };
      }
      return { rows: [] };
    },
  };
  return pg;
}

function mockStripeFetch(stripeCalls) {
  const sessionsByIdem = new Map();
  return async function stripeFetch(url, opts) {
    stripeCalls.push({ url, headers: opts && opts.headers, body: opts && opts.body });
    const idemKey = opts && opts.headers && opts.headers['Idempotency-Key'];
    if (idemKey && sessionsByIdem.has(idemKey)) {
      return { ok: true, json: async () => sessionsByIdem.get(idemKey) };
    }
    const sessionNum = stripeCalls.length;
    const session = {
      id: `cs_test_concurrent_${sessionNum}`,
      url: `https://checkout.stripe.com/c/pay/cs_test_concurrent_${sessionNum}`,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      livemode: false,
    };
    if (idemKey) sessionsByIdem.set(idemKey, session);
    return { ok: true, json: async () => session };
  };
}

console.log('\nverify:sunset-payment-link-concurrency\n');

(async () => {
  console.log('[1] Idempotency key builder is deterministic');
  const keyA = buildStripeCheckoutIdempotencyKey({
    clientSlug: CLIENT_SLUG,
    bookingId: BOOKING_ID,
    paymentKind: 'full_amount',
    idempotencyKey: IDEM,
    amountDueCents: 4500,
    currency: 'EUR',
  });
  const keyB = buildStripeCheckoutIdempotencyKey({
    clientSlug: CLIENT_SLUG,
    bookingId: BOOKING_ID,
    paymentKind: 'full_amount',
    idempotencyKey: IDEM,
    amountDueCents: 4500,
    currency: 'EUR',
  });
  assert('idempotency key stable', keyA === keyB && typeof keyA === 'string' && keyA.length > 10, keyA);
  const keyDiff = buildStripeCheckoutIdempotencyKey({
    clientSlug: CLIENT_SLUG,
    bookingId: BOOKING_ID,
    paymentKind: 'full_amount',
    idempotencyKey: 'different-client-key',
    amountDueCents: 4500,
    currency: 'EUR',
  });
  assert('different client request keys share authoritative stripe key', keyA === keyDiff, `${keyA} vs ${keyDiff}`);
  assert('authoritative key ignores request key',
    buildAuthoritativePaymentIntentKey({
      clientSlug: CLIENT_SLUG,
      bookingId: BOOKING_ID,
      paymentKind: 'full_amount',
      amountDueCents: 4500,
      currency: 'EUR',
    }) === keyA);

  console.log('\n[2] Two concurrent link requests → one Stripe session');
  const stripeCalls = [];
  const pg = buildConcurrentPg(stripeCalls);
  const originalFetch = global.fetch;
  global.fetch = mockStripeFetch(stripeCalls);
  try {
    const [r1, r2] = await Promise.all([
      createSunsetScheduleStripeLink(pg, baseOpts()),
      createSunsetScheduleStripeLink(pg, baseOpts()),
    ]);
    const payable = pg.payments.filter((p) => p.checkout_url);
    const sessionIds = new Set(payable.map((p) => p.stripe_checkout_session_id));
    assert('both callers succeed', r1.ok && r2.ok, JSON.stringify({ r1: r1.body, r2: r2.body }));
    assert('exactly one draft payment with checkout', payable.length === 1, `count=${payable.length}`);
    assert('exactly one Stripe Checkout create', stripeCalls.length === 1, `calls=${stripeCalls.length}`);
    assert('both return same session id',
      r1.body.stripe_checkout_session_id === r2.body.stripe_checkout_session_id);
    assert('no second payable session', sessionIds.size === 1);
    assert('Stripe Idempotency-Key header sent',
      stripeCalls[0] && stripeCalls[0].headers && !!stripeCalls[0].headers['Idempotency-Key']);
  } finally {
    global.fetch = originalFetch;
  }

  console.log('\n[3] Provider success + DB failure retry reuses session');
  const stripeCallsRetry = [];
  const pgRetry = buildConcurrentPg(stripeCallsRetry);
  let failUpdateOnce = true;
  const origQuery = pgRetry.query.bind(pgRetry);
  pgRetry.query = async (sql, params) => {
    if (failUpdateOnce && /UPDATE bookings[\s\S]*payment_link_sent/i.test(String(sql))) {
      failUpdateOnce = false;
      throw new Error('simulated_db_failure_after_stripe');
    }
    return origQuery(sql, params);
  };
  global.fetch = mockStripeFetch(stripeCallsRetry);
  try {
    let first;
    try {
      first = await createSunsetScheduleStripeLink(pgRetry, baseOpts({ idempotencyKey: 'idem-retry-001' }));
    } catch (err) {
      first = { ok: false, error: err };
    }
    assert('first attempt reaches Stripe', stripeCallsRetry.length >= 1, `calls=${stripeCallsRetry.length}`);
    const second = await createSunsetScheduleStripeLink(pgRetry, baseOpts({ idempotencyKey: 'idem-retry-001' }));
    assert('retry succeeds', second.ok === true);
    assert('retry does not create second Stripe session', stripeCallsRetry.length === 1,
      `calls=${stripeCallsRetry.length}`);
    assert('retry returns checkout url', !!second.body.checkout_url);
  } finally {
    global.fetch = originalFetch;
  }

  console.log('\n[4] Different bookings do not block each other');
  const stripeCallsB = [];
  function buildPgForBooking(bookingId) {
    const pg = buildConcurrentPg(stripeCallsB);
    const booking = {
      booking_id: bookingId,
      booking_code: bookingId === BOOKING_ID ? 'SUNSET-20260802-CONC' : 'SUNSET-20260802-OTHER',
      guest_name: 'Concurrent Guest',
      status: 'hold',
      payment_status: 'waiting_payment',
      check_in: '2026-08-02',
      check_out: '2026-08-03',
      metadata: { source: 'luna_guest_whatsapp', luna_guest_booking: true, location_id: 'sunset-somo' },
    };
    const orig = pg.query.bind(pg);
    pg.query = async (sql, params) => {
      const q = String(sql);
      if (/FROM bookings b[\s\S]*INNER JOIN clients/i.test(q) && !/FOR UPDATE/i.test(q)) {
        return { rows: [{ ...booking, id: bookingId }] };
      }
      if (/FROM bookings b[\s\S]*FOR UPDATE/i.test(q)) {
        return orig(sql, params);
      }
      if (/INSERT INTO payments/i.test(q)) {
        const res = await orig(sql, params);
        const row = pg.payments[pg.payments.length - 1];
        if (row) row.booking_id = bookingId;
        return res;
      }
      if (/metadata->>'idempotency_key'/i.test(q)) {
        const hit = pg.payments.find((p) => p.booking_id === bookingId
          && p.metadata && p.metadata.idempotency_key === params[1]);
        if (/ORDER BY created_at DESC/i.test(q)) return { rows: hit ? [hit] : [] };
        if (hit && hit.checkout_url) return { rows: [hit] };
        return { rows: [] };
      }
      return orig(sql, params);
    };
    return pg;
  }
  global.fetch = mockStripeFetch(stripeCallsB);
  try {
    const [a, b] = await Promise.all([
      createSunsetScheduleStripeLink(buildPgForBooking(BOOKING_ID), baseOpts({ bookingId: BOOKING_ID, idempotencyKey: 'idem-a' })),
      createSunsetScheduleStripeLink(buildPgForBooking('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), baseOpts({
        bookingId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        idempotencyKey: 'idem-b',
      })),
    ]);
    assert('different bookings both succeed', a.ok && b.ok);
    assert('two Stripe sessions for two bookings', stripeCallsB.length === 2, `calls=${stripeCallsB.length}`);
  } finally {
    global.fetch = originalFetch;
  }

  console.log('\n[5] Different/missing request keys → one Stripe session');
  async function runConcurrentKeyCases(label, optsA, optsB) {
    const calls = [];
    const pgKeys = buildConcurrentPg(calls);
    global.fetch = mockStripeFetch(calls);
    try {
      const [r1, r2] = await Promise.all([
        createSunsetScheduleStripeLink(pgKeys, baseOpts(optsA)),
        createSunsetScheduleStripeLink(pgKeys, baseOpts(optsB)),
      ]);
      const payable = pgKeys.payments.filter((p) => p.checkout_url);
      assert(`${label}: both succeed`, r1.ok && r2.ok);
      assert(`${label}: one Stripe call`, calls.length === 1, `calls=${calls.length}`);
      assert(`${label}: one payable row`, payable.length === 1, `rows=${payable.length}`);
      assert(`${label}: same session`, r1.body.stripe_checkout_session_id === r2.body.stripe_checkout_session_id);
    } finally {
      global.fetch = originalFetch;
    }
  }
  await runConcurrentKeyCases('different explicit keys', { idempotencyKey: 'key-a' }, { idempotencyKey: 'key-b' });
  await runConcurrentKeyCases('explicit + omitted', { idempotencyKey: 'key-only' }, {});
  await runConcurrentKeyCases('both omitted', {}, {});

  console.log('\n[6] Retry without client key reuses authoritative Stripe key');
  const stripeCallsNoKey = [];
  const pgNoKey = buildConcurrentPg(stripeCallsNoKey);
  global.fetch = mockStripeFetch(stripeCallsNoKey);
  try {
    const first = await createSunsetScheduleStripeLink(pgNoKey, baseOpts({}));
    const second = await createSunsetScheduleStripeLink(pgNoKey, baseOpts({}));
    assert('no-key retry succeeds', first.ok && second.ok);
    assert('no-key retry one Stripe call', stripeCallsNoKey.length === 1);
    const authKey = stripeCallsNoKey[0] && stripeCallsNoKey[0].headers && stripeCallsNoKey[0].headers['Idempotency-Key'];
    const expectedKey = buildAuthoritativePaymentIntentKey({
      clientSlug: CLIENT_SLUG,
      bookingId: BOOKING_ID,
      paymentKind: 'full_amount',
      amountDueCents: first.body.amount_due_cents,
      currency: 'EUR',
    });
    assert('no-key uses authoritative stripe key', authKey === expectedKey, `${authKey} vs ${expectedKey}`);
  } finally {
    global.fetch = originalFetch;
  }

  console.log('\n[7] Different authoritative amounts do not collide');
  const key4500 = buildAuthoritativePaymentIntentKey({
    clientSlug: CLIENT_SLUG, bookingId: BOOKING_ID, paymentKind: 'full_amount', amountDueCents: 4500, currency: 'EUR',
  });
  const key5000 = buildAuthoritativePaymentIntentKey({
    clientSlug: CLIENT_SLUG, bookingId: BOOKING_ID, paymentKind: 'full_amount', amountDueCents: 5000, currency: 'EUR',
  });
  assert('different amounts → different authoritative keys', key4500 !== key5000);

  console.log(`\n── verify:sunset-payment-link-concurrency ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  if (fail > 0) process.exit(1);
})();
