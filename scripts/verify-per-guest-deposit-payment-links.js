'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const routes = require('./lib/staff-bot-v2-routes');
const portal = require('./lib/staff-portal-ui-source').readStaffPortalUiSource();
const policy = fs.readFileSync(path.join(__dirname, 'lib/stripe-hold-promote-policy.js'), 'utf8');
const { paymentLinkIntendedAmountCents } = require('./lib/payment-ledger-stale-links');
const checkout = require('./lib/per-guest-checkout');

const cases = [
  [{ shareCents: 32500, depositCents: 10000, receivedCents: 0 }, { depositRemainingCents: 10000, remainingShareCents: 32500 }],
  [{ shareCents: 32500, depositCents: 10000, receivedCents: 10000 }, { depositRemainingCents: 0, remainingShareCents: 22500 }],
  [{ shareCents: 32500, depositCents: 10000, receivedCents: 32500 }, { depositRemainingCents: 0, remainingShareCents: 0 }],
  [{ shareCents: 32500, depositCents: 10000, receivedCents: 4000 }, { depositRemainingCents: 6000, remainingShareCents: 28500 }],
];
for (const [input, expected] of cases) assert.deepStrictEqual(routes.computeGuestPayableAmounts(input), expected);
assert.deepStrictEqual(routes.computeGuestPayableAmounts({ shareCents: 0, depositCents: 10000, receivedCents: 0 }),
  { depositRemainingCents: 0, remainingShareCents: 0 });
const guestId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const remaining = { payment_kind: 'full_amount', amount_due_cents: 22500, booking_guest_id: guestId,
  metadata: { payment_target: 'remaining_share', booking_guest_id: guestId } };
assert.strictEqual(paymentLinkIntendedAmountCents(remaining, { guest_amounts_by_id: {
  [guestId]: { subtotal_cents: 32500, deposit_cents: 10000, amount_paid_cents: 10000 },
} }), 22500);
assert.strictEqual(paymentLinkIntendedAmountCents(remaining, { guest_amounts_by_id: {
  [guestId]: { subtotal_cents: 32500, deposit_cents: 10000, amount_paid_cents: 32500 },
} }), 0, 'authoritative zero must not fall back to old checkout amount');
assert.strictEqual(paymentLinkIntendedAmountCents({ payment_kind: 'deposit_only', booking_guest_id: guestId,
  metadata: { payment_target: 'deposit', booking_guest_id: guestId } }, { guest_amounts_by_id: {
  [guestId]: { subtotal_cents: 5000, deposit_cents: 10000, amount_paid_cents: 1000 },
} }), 4000, 'ledger deposit intent must be capped by the guest share before receipts');
assert(portal.includes('data-payment-target="deposit"'), 'deposit row action missing');
assert(portal.includes('data-payment-target="remaining_share"'), 'remaining-share row action missing');
assert(portal.indexOf('data-payment-target="deposit"') < portal.indexOf('data-payment-target="remaining_share"'), 'deposit must precede payment');
assert(portal.includes("if (getClient() !== 'wolfhouse-somo') html += bcRenderGuestPaymentLinkControlsHtml"), 'Wolfhouse dropdown suppression missing');
assert(portal.includes("payment_target: paymentTarget"), 'browser must send explicit target');
assert(portal.includes('var link = (res.data && res.data.checkout_url) ||'), 'UI must prefer payment-specific checkout URL');
assert(policy.includes('SELECT COALESCE(SUM(amount_paid_cents), 0)'), 'guest projection must sum distinct paid ledger rows');
assert(!policy.includes('SET amount_paid_cents = GREATEST(COALESCE(amount_paid_cents, 0), $1)'), 'obsolete max projection remains');
const routeSource = fs.readFileSync(path.join(__dirname, 'lib/staff-bot-v2-routes.js'), 'utf8');
assert(routeSource.includes("authMode === 'staff_portal' && paymentTarget === 'full_share'"), 'staff endpoint must reject legacy full_share');
assert(portal.includes('requestStillCurrent'), 'late browser response guard missing');
assert(portal.includes("t('drawer.invoice.depositLink')"), 'visible Deposit Link label missing');
assert(portal.includes("t('drawer.invoice.paymentLink')"), 'visible Payment Link label missing');

(async () => {
  for (const failure of ['work', 'commit']) {
    const calls = [];
    const pg = { query: async (sql) => {
      calls.push(sql);
      if (failure === 'commit' && sql === 'COMMIT') throw new Error('commit failed');
      return { rows: [] };
    } };
    await assert.rejects(checkout.tx(pg, async () => {
      if (failure === 'work') throw new Error('query failed');
    }));
    assert.deepStrictEqual(calls.slice(-1), ['ROLLBACK'], failure + ' must rollback');
    await pg.query('SELECT reusable');
    assert.strictEqual(calls.at(-1), 'SELECT reusable');
  }
  assert(checkout.validUrl('https://checkout.stripe.com/c/pay/cs_test'));
  assert(!checkout.validUrl('https://checkout.stripe.com.evil.test/x'));

  function harness(finalizeFailures) {
    const state = { active: null, generation: 0, amount: 10000, collectible: new Set(), expired: [], createCalls: [], retireCalls: 0 };
    const sessions = new Map();
    const guest = { client_id: 'client-a', booking_id: 'booking-a', booking_code: 'BK1', guest_name: 'Guest', guest_number: 1 };
    const stripe = { checkout: { sessions: {
      async create(params, options) {
        state.createCalls.push({ params, key: options.idempotencyKey });
        if (!sessions.has(options.idempotencyKey)) {
          const id = 'cs_' + (sessions.size + 1);
          sessions.set(options.idempotencyKey, { id, url: 'https://checkout.stripe.com/c/pay/' + id, status: 'open', payment_status: 'unpaid', expires_at: 9999999999 });
          state.collectible.add(id);
        }
        return sessions.get(options.idempotencyKey);
      },
      async retrieve(id) { return [...sessions.values()].find((x) => x.id === id); },
      async expire(id) { state.collectible.delete(id); state.expired.push(id); const s = [...sessions.values()].find((x) => x.id === id); if (s) s.status = 'expired'; },
    } } };
    const store = {
      async prepare(target) {
        const amount = state.amount;
        if (!state.active) {
          const generation = 'generation-' + (++state.generation);
          state.active = { paymentId: 'payment-' + state.generation, generation, target, amount, currency: 'EUR',
            key: ['guest-checkout-v3', generation, target, amount, 'EUR'].join(':'), sessionId: null };
        }
        return { guest, amount, operation: { ...state.active },
          authoritative: checkout.sameIntent(state.active, target, amount) };
      },
      async finalize(op, session, target, amount) {
        if (finalizeFailures.length) {
          const failure = finalizeFailures.shift();
          if (failure === 'snapshot') { state.amount = 7000; const e = new Error('guest_payment_snapshot_changed_retry'); e.snapshotChanged = true; throw e; }
          throw new Error(failure);
        }
        if (!state.active || state.active.key !== op.key || op.target !== target || op.amount !== amount || amount !== state.amount) throw new Error('checkout_finalize_precondition_failed');
        state.active.sessionId = session.id; return guest;
      },
      async retire(op) { state.retireCalls += 1; if (state.active && state.active.key === op.key) state.active = null; },
    };
    return { state, stripe, store };
  }
  async function execute(h, target) {
    return checkout.run({ store: h.store, stripe: h.stripe, guestId, clientSlug: 'client-a', paymentTarget: target,
      successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' });
  }

  // Only definitely-unpaid terminal sessions may be retired and replaced.
  {
    const h = harness([]);
    await execute(h, 'deposit');
    const old = [...h.state.collectible][0];
    const session = await h.stripe.checkout.sessions.retrieve(old);
    Object.assign(session, { status: 'expired', payment_status: 'unpaid', expires_at: 1 });
    h.state.collectible.delete(old);
    const result = await execute(h, 'deposit');
    assert.notStrictEqual(result.session.id, old, 'expired unpaid session must be replaced');
    assert.strictEqual(result.session.status, 'open');
    assert.strictEqual(h.state.collectible.size, 1, 'exactly one fresh payable session remains');
    assert.strictEqual(h.state.retireCalls, 1);
  }
  // Provider-complete, paid, no-payment-required, and async/pending states fail
  // closed: preserve the exact local identity for webhook/late reconciliation.
  for (const unsafe of [
    { status: 'complete', payment_status: 'paid' },
    { status: 'complete', payment_status: 'unpaid' },
    { status: 'complete', payment_status: 'no_payment_required' },
    { status: 'open', payment_status: 'processing' },
  ]) {
    const h = harness([]);
    const first = await execute(h, 'deposit');
    const original = { ...h.state.active };
    const session = await h.stripe.checkout.sessions.retrieve(first.session.id);
    Object.assign(session, unsafe);
    const createsBefore = h.state.createCalls.length;
    await assert.rejects(execute(h, 'deposit'), (err) => err.providerBlocked && err.httpStatus === 409);
    assert.strictEqual(h.state.createCalls.length, createsBefore, 'blocked retrieval must never create');
    assert.deepStrictEqual(h.state.expired, [], 'complete/potentially-paid provider state must never be expired');
    assert.strictEqual(h.state.retireCalls, 0, 'blocked provider state must never retire local payment');
    assert.deepStrictEqual(h.state.active, original, 'local payment/session identity must remain unchanged');
  }

  // Provider success followed by finalize-query and commit ambiguity must replay
  // the exact same key and recover one session, never mint a second collectible.
  for (const failure of ['finalize query error', 'commit error']) {
    const h = harness([failure]);
    const result = await execute(h, 'deposit');
    assert.strictEqual(result.session.id, 'cs_1');
    assert.strictEqual(h.state.collectible.size, 1);
    assert.strictEqual(new Set(h.state.createCalls.map((x) => x.key)).size, 1);
    assert.strictEqual(h.state.createCalls[0].params.line_items[0].price_data.unit_amount, 10000);
  }
  // Snapshot change recovers the first provider identity, expires it, then uses
  // a new durable generation/amount.  Exactly one checkout remains payable.
  {
    const h = harness(['snapshot']);
    const result = await execute(h, 'deposit');
    assert.strictEqual(result.amount, 7000);
    assert.deepStrictEqual(h.state.expired, ['cs_1']);
    assert.deepStrictEqual([...h.state.collectible], ['cs_2']);
    assert.strictEqual(new Set(h.state.createCalls.map((x) => x.key)).size, 2);
  }
  // Different target callers deterministically replace mismatched active intent;
  // cover both arrival orders and verify returned target/amount and one payable.
  for (const order of [['deposit', 'remaining_share'], ['remaining_share', 'deposit']]) {
    const h = harness([]);
    const first = await execute(h, order[0]);
    const second = await execute(h, order[1]);
    assert.strictEqual(first.session.id, 'cs_1');
    assert.strictEqual(h.state.active.target, order[1]);
    assert.strictEqual(second.amount, 10000);
    assert.strictEqual(h.state.collectible.size, 1);
    assert(h.state.expired.includes('cs_1'));
    assert(h.state.createCalls.every((call) => call.key.includes(':10000:EUR')));
  }

  // Exercise createSqlStore through its actual query surface. The double keeps
  // transaction snapshots, enforces the partial-unique winner, and reports real
  // rowCount preconditions rather than rewriting operations returned by prepare.
  {
    const guest = { client_id: '11111111-1111-1111-1111-111111111111', booking_id: '22222222-2222-2222-2222-222222222222',
      booking_code: 'BKSQL', guest_name: 'SQL Guest', guest_number: 1, booking_status: 'confirmed',
      deposit_amount_cents: 10000, guest_metadata: { subtotal_cents: 5000 }, amount_paid_cents: 1000 };
    const db = { payment: null, guestPaymentId: null, txSnapshot: null, inserts: 0, conflicts: 0, rollbacks: 0 };
    const clone = (x) => x == null ? x : JSON.parse(JSON.stringify(x));
    const paymentRow = () => db.payment && ({ payment_id: db.payment.id, amount_due_cents: db.payment.amount,
      currency: 'EUR', metadata: clone(db.payment.metadata), stripe_checkout_session_id: db.payment.sessionId,
      checkout_url: db.payment.url });
    const pg = { async query(sql, args = []) {
      if (sql === 'BEGIN') { db.txSnapshot = clone({ payment: db.payment, guestPaymentId: db.guestPaymentId }); return { rows: [], rowCount: 0 }; }
      if (sql === 'COMMIT') { db.txSnapshot = null; return { rows: [], rowCount: 0 }; }
      if (sql === 'ROLLBACK') { db.payment = db.txSnapshot.payment; db.guestPaymentId = db.txSnapshot.guestPaymentId; db.txSnapshot = null; db.rollbacks += 1; return { rows: [], rowCount: 0 }; }
      if (sql.includes('SELECT bg.booking_id::text AS booking_id')) return { rows: [{ booking_id: guest.booking_id }], rowCount: 1 };
      if (sql.includes('SELECT id FROM bookings') || sql.includes('SELECT id FROM booking_guests')) return { rows: [{ id: 'lock' }], rowCount: 1 };
      if (sql.includes('FROM booking_guests bg JOIN bookings')) return { rows: [guest], rowCount: 1 };
      if (sql.includes('FROM payments WHERE client_id') && sql.includes('FOR UPDATE')) {
        const active = db.payment && ['draft', 'checkout_created'].includes(db.payment.status);
        return { rows: active ? [paymentRow()] : [], rowCount: active ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO payments')) {
        db.inserts += 1;
        if (db.payment && ['draft', 'checkout_created'].includes(db.payment.status)) { db.conflicts += 1; return { rows: [], rowCount: 0 }; }
        db.payment = { id: '33333333-3333-3333-3333-333333333333', status: 'draft', amount: args[4],
          metadata: JSON.parse(args[5]), sessionId: null, url: null };
        return { rows: [paymentRow()], rowCount: 1 };
      }
      if (sql.includes('SET metadata=metadata ||')) { Object.assign(db.payment.metadata, JSON.parse(args[1])); return { rows: [], rowCount: 1 }; }
      if (sql.includes("SET status='checkout_created'")) {
        if (!db.payment || !['draft', 'checkout_created'].includes(db.payment.status) || db.payment.metadata.provider_idempotency_key !== args[5]) return { rows: [], rowCount: 0 };
        db.payment.status = 'checkout_created'; db.payment.sessionId = args[0]; db.payment.url = args[1]; return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE booking_guests SET payment_id')) { db.guestPaymentId = args[0]; return { rows: [], rowCount: 1 }; }
      throw new Error('unexpected SQL: ' + sql);
    } };
    const store = checkout.createSqlStore((fn) => fn(pg), guestId, 'client-a', 'staff-1');
    const first = await store.prepare('deposit');
    const second = await store.prepare('deposit');
    assert.deepStrictEqual(second.operation, first.operation, 'sequential prepares must observe the same SQL winner');
    assert.strictEqual(db.inserts, 1);
    assert(db.payment.metadata.provider_idempotency_key, 'provider key must be durably written by prepare');

    // Simulate the ON CONFLICT loser path while still using prepare's SQL: hide
    // the winner from the first active read, expose it when INSERT loses, then
    // let the production winner SELECT return it.
    const originalQuery = pg.query.bind(pg); let hideOnce = true;
    pg.query = async (sql, args) => {
      if (hideOnce && sql.includes('FROM payments WHERE client_id') && sql.includes('FOR UPDATE')) { hideOnce = false; return { rows: [], rowCount: 0 }; }
      return originalQuery(sql, args);
    };
    const loser = await store.prepare('deposit');
    assert.deepStrictEqual(loser.operation, first.operation);
    assert.strictEqual(db.conflicts, 1, 'ON CONFLICT DO NOTHING must expose a zero-row loser');

    await store.finalize(first.operation, { id: 'cs_sql', url: 'https://checkout.stripe.com/c/pay/sql', expires_at: 9999999999 }, 'deposit', 4000);
    assert.strictEqual(db.guestPaymentId, first.operation.paymentId);
    const wrong = { ...first.operation, key: first.operation.key + '-wrong' };
    await assert.rejects(store.finalize(wrong, { id: 'cs_wrong', url: 'https://checkout.stripe.com/c/pay/wrong' }, 'deposit', 4000), /checkout_finalize_precondition_failed/);
    assert.strictEqual(db.payment.sessionId, 'cs_sql', 'failed conditional finalize must rollback its transaction snapshot');
    assert.strictEqual(db.rollbacks, 1);
  }

  // Execute the production staff wrapper: URL tenant A/body tenant B is
  // rejected before delegation (and therefore before guest SQL or Stripe).
  {
    const { handleStaffGenerateGuestPaymentLink } = require('./lib/staff-guest-payment-link-handler');
    const sent = []; let downstream = 0;
    await handleStaffGenerateGuestPaymentLink(
      { url: '/staff/bookings/generate-guest-payment-link?client=A' }, {},
      { allowed_clients: ['A'], staff_user_id: 'staff-1' }, {
        STAFF_ACTIONS_ENABLED: true, UUID_VALIDATE_RE: /^[0-9a-f-]{36}$/i, DEFAULT_CLIENT: 'default',
        readBody: async () => JSON.stringify({ booking_guest_id: guestId, client_slug: 'B', payment_target: 'deposit' }),
        send400() { throw new Error('unexpected send400'); },
        assertStaffClientAccess(u, slug) { assert.strictEqual(slug, 'A'); return true; },
        sendJSON(r, status, body) { sent.push({ status, body }); },
        delegatedHandler: async () => { downstream += 1; }, delegatedContext: {},
      });
    assert.strictEqual(downstream, 0);
    assert.deepStrictEqual(sent, [{ status: 403, body: { success: false, error: 'client_scope_mismatch' } }]);
  }

  // Same-tenant request traverses the production wrapper, delegated route,
  // coordinator and SQL/Stripe seams.
  {
    const { handleStaffGenerateGuestPaymentLink } = require('./lib/staff-guest-payment-link-handler');
    const g = { client_id: '11111111-1111-1111-1111-111111111111', booking_id: '22222222-2222-2222-2222-222222222222',
      booking_code: 'BK-HAPPY', guest_name: 'Happy Guest', guest_number: 2, booking_status: 'confirmed',
      deposit_amount_cents: 10000, guest_metadata: { subtotal_cents: 5000 }, amount_paid_cents: 1000 };
    const md = { source: 'bot_guest_payment_link_slice_a', payment_target: 'deposit', intent_target: 'deposit',
      intent_amount_cents: 4000, intent_currency: 'EUR', intent_generation: 'pay-happy', provider_idempotency_key: 'key-happy' };
    const pg = { async query(sql) {
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT bg.booking_id::text AS booking_id')) return { rows: [{ booking_id: g.booking_id }] };
      if (sql.includes('SELECT id FROM bookings') || sql.includes('SELECT id FROM booking_guests')) return { rows: [{ id: 'lock' }] };
      if (sql.includes('FROM booking_guests bg JOIN bookings')) return { rows: [g] };
      if (sql.includes('FROM payments WHERE client_id') && sql.includes('FOR UPDATE')) return { rows: [{ payment_id: '33333333-3333-3333-3333-333333333333', amount_due_cents: 4000, currency: 'EUR', metadata: md }] };
      if (sql.includes("SET status='checkout_created'") || sql.includes('UPDATE booking_guests SET payment_id')) return { rows: [], rowCount: 1 };
      throw new Error('unexpected happy SQL: ' + sql);
    } };
    const sent = []; let stripeCreates = 0;
    await handleStaffGenerateGuestPaymentLink({ url: '/staff/bookings/generate-guest-payment-link?client=A' }, {},
      { allowed_clients: ['A'], staff_user_id: 'staff-1' }, {
        STAFF_ACTIONS_ENABLED: true, UUID_VALIDATE_RE: /^[0-9a-f-]{36}$/i, DEFAULT_CLIENT: 'default',
        readBody: async () => JSON.stringify({ booking_guest_id: guestId, client_slug: 'A', payment_target: 'deposit' }),
        send400() { throw new Error('unexpected send400'); }, assertStaffClientAccess: () => true,
        sendJSON(r, status, body) { sent.push({ status, body }); }, delegatedHandler: routes.handleBotGuestPaymentCreateLink,
        delegatedContext: { sendJSON(r, status, body) { sent.push({ status, body }); }, send400() {}, readBody: async () => '',
          withPgClient: (fn) => fn(pg), BOT_BOOKING_ENABLED: false, STAFF_ACTIONS_ENABLED: true,
          STRIPE_LINKS_ENABLED: true, STRIPE_SECRET_KEY: 'sk_test_double', DEFAULT_CLIENT: 'default',
          stripeCheckoutRedirectUrlsConfigured: () => true, stripeCheckoutSessionSuccessUrl: () => 'https://example.test/success',
          stripeCheckoutSessionCancelUrl: () => 'https://example.test/cancel', stripe: { checkout: { sessions: {
            create: async () => { stripeCreates += 1; return { id: 'cs_happy', url: 'https://checkout.stripe.com/c/pay/happy', status: 'open', payment_status: 'unpaid', expires_at: 9999999999 }; },
            retrieve: async () => { throw new Error('unexpected retrieve'); }, expire: async () => {},
          } } } },
      });
    assert.strictEqual(stripeCreates, 1);
    assert.strictEqual(sent[0].status, 200);
    assert.strictEqual(sent[0].body.amount_due_cents, 4000);
  }

  // A paid provider session traversing the real staff wrapper returns a safe,
  // typed 409 while preserving the original SQL row and provider identity.
  {
    const { handleStaffGenerateGuestPaymentLink } = require('./lib/staff-guest-payment-link-handler');
    const g = { client_id: '11111111-1111-1111-1111-111111111111', booking_id: '22222222-2222-2222-2222-222222222222',
      booking_code: 'BK-PAID', guest_name: 'Paid Guest', guest_number: 3, booking_status: 'confirmed',
      deposit_amount_cents: 10000, guest_metadata: { subtotal_cents: 5000 }, amount_paid_cents: 1000 };
    const original = { payment_id: '44444444-4444-4444-4444-444444444444', amount_due_cents: 4000, currency: 'EUR',
      metadata: { source: 'bot_guest_payment_link_slice_a', payment_target: 'deposit', intent_target: 'deposit',
        intent_amount_cents: 4000, intent_currency: 'EUR', intent_generation: 'pay-paid', provider_idempotency_key: 'key-paid' },
      stripe_checkout_session_id: 'cs_paid', checkout_url: 'https://checkout.stripe.com/c/pay/paid' };
    let mutations = 0; let creates = 0; let expires = 0;
    const pg = { async query(sql) {
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT bg.booking_id::text AS booking_id')) return { rows: [{ booking_id: g.booking_id }] };
      if (sql.includes('SELECT id FROM bookings') || sql.includes('SELECT id FROM booking_guests')) return { rows: [{ id: 'lock' }] };
      if (sql.includes('FROM booking_guests bg JOIN bookings')) return { rows: [g] };
      if (sql.includes('FROM payments WHERE client_id') && sql.includes('FOR UPDATE')) return { rows: [{ ...original, metadata: { ...original.metadata } }] };
      if (/UPDATE|INSERT/.test(sql)) { mutations += 1; throw new Error('blocked state attempted SQL mutation'); }
      throw new Error('unexpected paid SQL: ' + sql);
    } };
    const sent = [];
    await handleStaffGenerateGuestPaymentLink({ url: '/staff/bookings/generate-guest-payment-link?client=A' }, {},
      { allowed_clients: ['A'], staff_user_id: 'staff-1' }, {
        STAFF_ACTIONS_ENABLED: true, UUID_VALIDATE_RE: /^[0-9a-f-]{36}$/i, DEFAULT_CLIENT: 'default',
        readBody: async () => JSON.stringify({ booking_guest_id: guestId, client_slug: 'A', payment_target: 'deposit' }),
        send400() { throw new Error('unexpected send400'); }, assertStaffClientAccess: () => true,
        sendJSON(r, status, body) { sent.push({ status, body }); }, delegatedHandler: routes.handleBotGuestPaymentCreateLink,
        delegatedContext: { sendJSON(r, status, body) { sent.push({ status, body }); }, send400() {}, readBody: async () => '',
          withPgClient: (fn) => fn(pg), BOT_BOOKING_ENABLED: false, STAFF_ACTIONS_ENABLED: true,
          STRIPE_LINKS_ENABLED: true, STRIPE_SECRET_KEY: '***', DEFAULT_CLIENT: 'default',
          stripeCheckoutRedirectUrlsConfigured: () => true, stripeCheckoutSessionSuccessUrl: () => 'https://example.test/success',
          stripeCheckoutSessionCancelUrl: () => 'https://example.test/cancel', stripe: { checkout: { sessions: {
            create: async () => { creates += 1; },
            retrieve: async () => ({ id: 'cs_paid', status: 'complete', payment_status: 'paid', expires_at: 9999999999 }),
            expire: async () => { expires += 1; },
          } } } },
      });
    assert.strictEqual(creates, 0); assert.strictEqual(expires, 0); assert.strictEqual(mutations, 0);
    assert.strictEqual(sent[0].status, 409);
    assert.deepStrictEqual(sent[0].body, { success: false, error: 'payment_processing_refresh_required',
      message: 'Payment may already be processing. Refresh payment status before creating another link.' });
    assert.strictEqual(original.stripe_checkout_session_id, 'cs_paid');
  }

  // UI/server agreement: deposit is capped by share; unknown is not zero.
  assert.deepStrictEqual(routes.computeGuestPayableAmounts({ shareCents: 5000, depositCents: 10000, receivedCents: 1000 }),
    { depositRemainingCents: 4000, remainingShareCents: 4000 });
  assert(portal.includes('Math.min(deposit, share) - paid'), 'browser deposit must be capped by share');
  assert(portal.includes('share == null ? null'), 'unknown share must remain distinct from zero');
  assert(portal.includes("document.contains(btn)"), 'detached button response guard missing');
  assert(portal.includes("data-booking-view-generation"), 'drawer generation guard missing');
  assert(portal.includes("data-mounted-booking-id"), 'live booking identity guard missing');

  // Execute the production browser function against a DOM/fetch double.  An
  // old response after unmount/remount must be a no-op while the new view's
  // response renders only in its own target slot.
  {
    const start = portal.indexOf('function bcRequestGuestPaymentLink(');
    const end = portal.indexOf('\nfunction bcBindCreateGuestPaymentLinkButtons', start);
    assert(start >= 0 && end > start);
    const mounted = new Set();
    const attrs = (initial = {}) => ({
      values: { ...initial }, parentNode: null, disabled: false, outerHTML: '',
      getAttribute(k) { return this.values[k] == null ? null : this.values[k]; },
      setAttribute(k, v) { this.values[k] = String(v); },
    });
    const drawer = attrs({ 'data-booking-view-generation': '1', 'data-mounted-booking-id': 'booking-A' });
    mounted.add(drawer);
    const pending = [];
    const context = { URL, encodeURIComponent, JSON,
      getClient: () => context.client,
      client: 'A',
      document: { contains: (node) => mounted.has(node), querySelector: (s) => s === '#bc-side-drawer' ? drawer : null },
      fetch(url, options) { return new Promise((resolve) => pending.push({ resolve, url, options })); },
      escHtml: String, t: (x) => x, bcInlinePaymentLinkMarkup: (x) => 'LINK:' + x,
    };
    vm.createContext(context);
    vm.runInContext(portal.slice(start, end), context);
    function controls(booking, target) {
      const parent = { querySelector: () => result };
      const button = attrs({ 'data-booking-guest-id': 'guest-1', 'data-payment-target': target });
      const result = { innerHTML: '', style: { display: 'none' }, parentNode: parent };
      button.parentNode = parent; mounted.add(button); mounted.add(result); return { button, result };
    }
    const old = controls('booking-A', 'deposit');
    context.bcRequestGuestPaymentLink('guest-1', 'deposit', old.result, old.button, { booking_id: 'booking-A' });
    mounted.delete(old.button); mounted.delete(old.result);
    drawer.setAttribute('data-booking-view-generation', '2'); drawer.setAttribute('data-mounted-booking-id', 'booking-B');
    const fresh = controls('booking-B', 'remaining_share');
    context.bcRequestGuestPaymentLink('guest-1', 'remaining_share', fresh.result, fresh.button, { booking_id: 'booking-B' });
    const response = (id) => ({ ok: true, json: async () => ({ success: true, checkout_url: 'https://checkout.stripe.com/c/pay/' + id }) });
    pending[0].resolve(response('old')); pending[1].resolve(response('new'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(old.button.outerHTML, '', 'old detached response mutated stale button');
    assert.strictEqual(old.result.innerHTML, '', 'old detached response mutated stale slot');
    assert.strictEqual(fresh.button.outerHTML, 'LINK:https://checkout.stripe.com/c/pay/new');
    assert.strictEqual(fresh.result.innerHTML, '', 'target slots must remain isolated');
  }
  console.log('PASS verify-per-guest-deposit-payment-links');
})().catch((err) => { console.error(err); process.exitCode = 1; });
