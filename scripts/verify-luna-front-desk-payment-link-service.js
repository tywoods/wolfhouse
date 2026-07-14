'use strict';

/**
 * verify:luna-front-desk-payment-link-service
 *
 * RED → GREEN gate for canonical payment-link application service (Slice 10).
 *
 * Run:
 *   node scripts/verify-luna-front-desk-payment-link-service.js
 */

const {
  PAYMENT_LINK_CHANNELS,
  PAYMENT_LINK_OPERATIONS,
  PAYMENT_LINK_LIFECYCLE,
  WOLFHOUSE_CLIENT_SLUG,
  buildPaymentLinkCommand,
  createPaymentLink,
  getPaymentStatus,
  cancelOrInvalidatePaymentLink,
  resolveActionableCheckoutUrl,
  rejectClientSuppliedAmounts,
  assertStripeRuntime,
} = require('./lib/luna-front-desk-payment-link-service');
const { SUNSET_CLIENT_SLUG } = require('./lib/sunset-stripe-payment-links');

let pass = 0;
let fail = 0;
function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

const BOOKING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BOOKING_CODE = 'WH-STALE-01';
const PAYMENT_ID = 'pppppppp-pppp-4ppp-8ppp-pppppppppppp';
const STALE_URL = 'https://checkout.stripe.com/c/pay/cs_test_stale123';
const CLIENT_WH = 'client-wh-1';
const CLIENT_SUN = 'client-sun-1';

function baseExecOpts(overrides = {}) {
  return {
    staffActionsEnabled: true,
    stripeLinksEnabled: true,
    secretKey: 'sk_test_slice10',
    successUrl: 'https://example.com/success',
    cancelUrl: 'https://example.com/cancel',
    blockLiveKeys: true,
    createStripeCheckoutSession: async (opts) => ({
      id: 'cs_test_mock',
      url: `https://checkout.stripe.com/c/pay/cs_test_mock_${opts.amountDueCents}`,
      livemode: false,
      payment_status: 'unpaid',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
    ...overrides,
  };
}

function makePg(state = {}) {
  const bookings = state.bookings || [];
  const payments = state.payments || [];
  let draftDeleted = false;
  let paymentUpdates = 0;
  let bookingMetaUpdates = 0;

  return {
    draftDeleted: () => draftDeleted,
    paymentUpdates: () => paymentUpdates,
    bookingMetaUpdates: () => bookingMetaUpdates,
    query: async (sql, params) => {
      const s = String(sql);
      const norm = s.replace(/\s+/g, ' ').trim();
      if (/^BEGIN/i.test(s)) return { rows: [] };
      if (/^COMMIT/i.test(s)) return { rows: [] };
      if (/^ROLLBACK/i.test(s)) return { rows: [] };

      if (/DELETE FROM payments/i.test(s)) {
        draftDeleted = true;
        return { rowCount: 1, rows: [] };
      }

      if (/UPDATE bookings/i.test(s) && /metadata/i.test(s)) {
        bookingMetaUpdates += 1;
        const bk = bookings.find((b) => b.booking_id === params[0]);
        if (bk) {
          const patch = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
          bk.metadata = { ...(bk.metadata || {}), ...patch };
        }
        return { rows: [] };
      }

      if (/UPDATE payments/i.test(s)) {
        paymentUpdates += 1;
        const pid = params.length >= 5 ? params[4] : params[0];
        const pay = payments.find((p) => p.payment_id === pid);
        if (pay) {
          if (/status = 'cancelled'/i.test(s)) {
            pay.payment_status = 'cancelled';
            pay.checkout_url = null;
          }
          if (/status = 'checkout_created'/i.test(s)) {
            pay.payment_status = 'checkout_created';
            pay.checkout_url = params[1] || pay.checkout_url;
            pay.stripe_checkout_session_id = params[0];
          }
        }
        return { rows: pay ? [pay] : [{ payment_id: pid, payment_status: 'checkout_created' }] };
      }

      if (/FROM bookings b/i.test(s) && /INNER JOIN clients/i.test(s)) {
        const slug = params[0];
        const key = params[1];
        const bk = bookings.find((b) => b.client_slug === slug
          && (b.booking_id === key || b.booking_code === key));
        return { rows: bk ? [bk] : [] };
      }

      if (/FROM payments p/i.test(s) && /booking_code = \$2/i.test(s)) {
        const slug = params[0];
        const code = params[1];
        return { rows: payments.filter((p) => p.client_slug === slug && p.booking_code === code) };
      }

      if (/FROM payments p/i.test(s) && /WHERE p\.id = \$1::uuid AND cl\.slug/i.test(norm)) {
        const pay = payments.find((p) => p.payment_id === params[0] && p.client_slug === params[1]);
        if (!pay) return { rows: [] };
        const bk = bookings.find((b) => b.booking_id === pay.booking_id) || {};
        return { rows: [{ ...pay, ...bk, booking_status: bk.status }] };
      }

      if (/INSERT INTO payments/i.test(s)) {
        const newId = state.nextPaymentId || 'pay-new-1';
        payments.push({
          payment_id: newId,
          client_id: params[0],
          booking_id: params[1],
          payment_status: 'draft',
          payment_kind: 'full_amount',
          currency: 'EUR',
          amount_due_cents: params[2],
          amount_paid_cents: 0,
          checkout_url: null,
          metadata: typeof params[3] === 'string' ? JSON.parse(params[3]) : params[3],
          client_slug: WOLFHOUSE_CLIENT_SLUG,
          booking_code: BOOKING_CODE,
        });
        return { rows: [{ payment_id: newId }] };
      }

      if (/metadata->>'idempotency_key'/i.test(s)) {
        const pay = payments.find((p) => p.booking_id === params[0]
          && p.metadata && p.metadata.idempotency_key === params[2]);
        return { rows: pay ? [pay] : [] };
      }

      if (/FROM clients WHERE slug/i.test(s)) {
        return { rows: [{ id: params[0] === SUNSET_CLIENT_SLUG ? CLIENT_SUN : CLIENT_WH }] };
      }

      return { rows: [] };
    },
  };
}

async function main() {
  console.log('\nverify:luna-front-desk-payment-link-service\n');

  console.log('[0] resolveActionableCheckoutUrl — stale cancelled metadata (RED repro)');
  {
    const resolved = resolveActionableCheckoutUrl({
      bookingRow: {
        status: 'cancelled',
        metadata: { last_payment_link_url: STALE_URL, payment_link_invalidated: true },
      },
      paymentRow: null,
    });
    assert('cancelled booking never returns stale cs_test URL', resolved.payment_link_url === null);
    assert('cancelled booking payment_id null', resolved.payment_id === null);
    assert('lifecycle booking_cancelled', resolved.lifecycle === PAYMENT_LINK_LIFECYCLE.BOOKING_CANCELLED);
    assert('not actionable', resolved.actionable === false);
  }

  console.log('[1] getPaymentStatus — cancelled booking with stale metadata');
  {
    const pg = makePg({
      bookings: [{
        booking_id: BOOKING_ID,
        booking_code: BOOKING_CODE,
        client_slug: WOLFHOUSE_CLIENT_SLUG,
        client_id: CLIENT_WH,
        status: 'cancelled',
        metadata: { last_payment_link_url: STALE_URL, payment_link_invalidated: true },
      }],
      payments: [],
    });
    const built = buildPaymentLinkCommand({
      operation: PAYMENT_LINK_OPERATIONS.GET_STATUS,
      trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
      channel: PAYMENT_LINK_CHANNELS.STAFF_PORTAL,
      bookingCode: BOOKING_CODE,
    });
    const result = await getPaymentStatus(pg, built.command);
    assert('getPaymentStatus ok', result.ok);
    assert('payment_link_url null', result.body.payment_link_url === null);
    assert('payment_id null', result.body.payment_id === null);
  }

  console.log('[2] Staff vs Luna parity on draft payment create');
  {
    const sharedPayment = {
      payment_id: PAYMENT_ID,
      client_id: CLIENT_WH,
      client_slug: WOLFHOUSE_CLIENT_SLUG,
      booking_id: BOOKING_ID,
      booking_code: BOOKING_CODE,
      guest_name: 'Guest',
      check_in: '2026-07-06',
      check_out: '2026-07-13',
      status: 'confirmed',
      payment_status: 'draft',
      payment_kind: 'deposit',
      currency: 'EUR',
      amount_due_cents: 5000,
      checkout_url: null,
    };
    const pgStaff = makePg({ bookings: [{ booking_id: BOOKING_ID, booking_code: BOOKING_CODE, client_slug: WOLFHOUSE_CLIENT_SLUG, status: 'confirmed' }], payments: [sharedPayment] });
    const pgLuna = makePg({ bookings: [{ booking_id: BOOKING_ID, booking_code: BOOKING_CODE, client_slug: WOLFHOUSE_CLIENT_SLUG, status: 'confirmed' }], payments: [{ ...sharedPayment }] });

    const staffBuilt = buildPaymentLinkCommand({
      operation: PAYMENT_LINK_OPERATIONS.CREATE,
      channel: PAYMENT_LINK_CHANNELS.STAFF_PORTAL,
      trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
      paymentId: PAYMENT_ID,
      target: 'draft_payment',
    });
    const lunaBuilt = buildPaymentLinkCommand({
      operation: PAYMENT_LINK_OPERATIONS.CREATE,
      channel: PAYMENT_LINK_CHANNELS.LUNA_WHATSAPP,
      trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
      paymentId: PAYMENT_ID,
      target: 'draft_payment',
    });

    const staffRes = await createPaymentLink(pgStaff, staffBuilt.command, baseExecOpts());
    const lunaRes = await createPaymentLink(pgLuna, lunaBuilt.command, baseExecOpts());
    assert('staff create ok', staffRes.ok);
    assert('luna create ok', lunaRes.ok);
    assert('parity amount_due_cents', staffRes.body.amount_due_cents === lunaRes.body.amount_due_cents);
    assert('parity checkout_url shape', !!staffRes.body.checkout_url && !!lunaRes.body.checkout_url);
  }

  console.log('[3] Idempotent draft link create');
  {
    const pay = {
      payment_id: PAYMENT_ID,
      client_id: CLIENT_WH,
      client_slug: WOLFHOUSE_CLIENT_SLUG,
      booking_id: BOOKING_ID,
      booking_code: BOOKING_CODE,
      guest_name: 'Guest',
      status: 'confirmed',
      payment_status: 'checkout_created',
      payment_kind: 'deposit',
      currency: 'EUR',
      amount_due_cents: 5000,
      checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_existing',
    };
    const pg = makePg({ bookings: [{ booking_id: BOOKING_ID, booking_code: BOOKING_CODE, client_slug: WOLFHOUSE_CLIENT_SLUG, status: 'confirmed' }], payments: [pay] });
    const built = buildPaymentLinkCommand({
      operation: PAYMENT_LINK_OPERATIONS.CREATE,
      channel: PAYMENT_LINK_CHANNELS.STAFF_PORTAL,
      trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
      paymentId: PAYMENT_ID,
      target: 'draft_payment',
    });
    const result = await createPaymentLink(pg, built.command, baseExecOpts());
    assert('idempotent ok', result.ok && result.body.idempotent === true);
    assert('same checkout url', result.body.checkout_url === pay.checkout_url);
  }

  console.log('[4] Cancel unpaid link → non-actionable');
  {
    const pay = {
      payment_id: PAYMENT_ID,
      client_id: CLIENT_WH,
      client_slug: WOLFHOUSE_CLIENT_SLUG,
      booking_id: BOOKING_ID,
      booking_code: BOOKING_CODE,
      payment_status: 'checkout_created',
      amount_due_cents: 5000,
      amount_paid_cents: 0,
      checkout_url: STALE_URL,
      metadata: { payment_link_url: STALE_URL },
    };
    const booking = {
      booking_id: BOOKING_ID,
      booking_code: BOOKING_CODE,
      client_slug: WOLFHOUSE_CLIENT_SLUG,
      client_id: CLIENT_WH,
      status: 'confirmed',
      metadata: { last_payment_link_url: STALE_URL },
    };
    const pg = makePg({ bookings: [booking], payments: [pay] });
    const built = buildPaymentLinkCommand({
      operation: PAYMENT_LINK_OPERATIONS.CANCEL,
      channel: PAYMENT_LINK_CHANNELS.STAFF_PORTAL,
      trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
      paymentId: PAYMENT_ID,
      idempotencyKey: 'cancel-key-1',
    });
    const cancelRes = await cancelOrInvalidatePaymentLink(pg, built.command);
    assert('cancel ok', cancelRes.ok);
    assert('booking metadata invalidated', pg.bookingMetaUpdates() >= 1);

    const statusBuilt = buildPaymentLinkCommand({
      operation: PAYMENT_LINK_OPERATIONS.GET_STATUS,
      trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
      channel: PAYMENT_LINK_CHANNELS.STAFF_PORTAL,
      bookingCode: BOOKING_CODE,
    });
    const statusRes = await getPaymentStatus(pg, statusBuilt.command);
    assert('status after cancel not actionable', statusRes.body.actionable === false);
    assert('no stale url after cancel', statusRes.body.payment_link_url === null);
  }

  console.log('[5] Client-supplied amount rejected');
  {
    const reject = rejectClientSuppliedAmounts({ amount_due_cents: 100 });
    assert('rejects amount_due_cents', reject.ok === false);
    const built = buildPaymentLinkCommand({
      operation: PAYMENT_LINK_OPERATIONS.CREATE,
      trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
      transportBody: { balance_due_cents: 9999 },
      bookingCode: BOOKING_CODE,
      idempotencyKey: 'k1',
    });
    assert('build rejects client amount', built.ok === false && built.body.reason_code === 'client_amount_rejected');
  }

  console.log('[6] Wrong tenant fails closed');
  {
    const built = buildPaymentLinkCommand({
      operation: PAYMENT_LINK_OPERATIONS.CREATE,
      trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
      transportBody: { client_slug: SUNSET_CLIENT_SLUG },
      bookingCode: BOOKING_CODE,
      idempotencyKey: 'k2',
    });
    assert('tenant mismatch rejected', built.ok === false && built.body.reason_code === 'tenant_mismatch');
  }

  console.log('[7] Stripe failure rolls back draft (balance link)');
  {
    const booking = {
      booking_id: BOOKING_ID,
      booking_code: BOOKING_CODE,
      client_slug: WOLFHOUSE_CLIENT_SLUG,
      client_id: CLIENT_WH,
      status: 'confirmed',
      guest_name: 'Guest',
      total_amount_cents: 10000,
      amount_paid_cents: 0,
      balance_due_cents: 10000,
    };
    const pg = makePg({ bookings: [booking], payments: [], nextPaymentId: 'pay-draft-rollback' });
    const built = buildPaymentLinkCommand({
      operation: PAYMENT_LINK_OPERATIONS.CREATE,
      channel: PAYMENT_LINK_CHANNELS.STAFF_PORTAL,
      trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
      bookingId: BOOKING_ID,
      idempotencyKey: 'rollback-key',
      authoritativeBalanceDueCents: 10000,
    });
    const result = await createPaymentLink(pg, built.command, baseExecOpts({
      createStripeCheckoutSession: async () => { throw new Error('stripe_down'); },
    }));
    assert('stripe failure not ok', !result.ok);
    assert('draft deleted on stripe failure', pg.draftDeleted());
  }

  console.log('[8] Wolfhouse vs Sunset Stripe mode isolation');
  {
    const whLive = assertStripeRuntime(WOLFHOUSE_CLIENT_SLUG, {
      staffActionsEnabled: true,
      stripeLinksEnabled: true,
      secretKey: 'sk_live_wh',
      successUrl: 'https://a/s',
      cancelUrl: 'https://a/c',
      blockLiveKeys: true,
    });
    assert('wolfhouse live blocked on staging', !whLive.ok && whLive.body.reason_code === 'live_stripe_blocked');

    const sunLive = assertStripeRuntime(SUNSET_CLIENT_SLUG, {
      staffActionsEnabled: true,
      stripeLinksEnabled: true,
      secretKey: 'sk_live_sun',
      successUrl: 'https://a/s',
      cancelUrl: 'https://a/c',
    });
    assert('sunset live blocked', !sunLive.ok && sunLive.body.reason_code === 'live_stripe_blocked');

    const crossMode = assertStripeRuntime(WOLFHOUSE_CLIENT_SLUG, {
      staffActionsEnabled: true,
      stripeLinksEnabled: true,
      secretKey: 'sk_live_wh',
      successUrl: 'https://a/s',
      cancelUrl: 'https://a/c',
      blockLiveKeys: false,
      expectedMode: 'test',
    });
    assert('test/live cross rejected', !crossMode.ok && crossMode.body.reason_code === 'stripe_mode_cross');
  }

  console.log('[9] Paid payment row not actionable');
  {
    const resolved = resolveActionableCheckoutUrl({
      bookingRow: { status: 'confirmed', metadata: {} },
      paymentRow: {
        payment_id: PAYMENT_ID,
        payment_status: 'paid',
        amount_paid_cents: 5000,
        checkout_url: STALE_URL,
      },
    });
    assert('paid not actionable', resolved.actionable === false);
    assert('paid no url returned', resolved.payment_link_url === null);
  }

  console.log(`\n── verify:luna-front-desk-payment-link-service ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
