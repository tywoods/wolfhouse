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
assert(portal.includes('data-payment-target="deposit"'), 'deposit row action missing');
assert(portal.includes('data-payment-target="remaining_share"'), 'remaining-share row action missing');
assert(portal.indexOf('data-payment-target="deposit"') < portal.indexOf('data-payment-target="remaining_share"'), 'deposit must precede payment');
assert(portal.includes("if (getClient() !== 'wolfhouse-somo') html += bcRenderGuestPaymentLinkControlsHtml"), 'Wolfhouse dropdown suppression missing');
assert(portal.includes("payment_target: paymentTarget"), 'browser must send explicit target');
assert(portal.includes('var link = (res.data && res.data.checkout_url) ||'), 'UI must prefer payment-specific checkout URL');
assert(policy.includes('SELECT COALESCE(SUM(amount_paid_cents), 0)'), 'guest projection must sum distinct paid ledger rows');
assert(!policy.includes('SET amount_paid_cents = GREATEST(COALESCE(amount_paid_cents, 0), $1)'), 'obsolete max projection remains');
const routeSource = fs.readFileSync(path.join(__dirname, 'lib/staff-bot-v2-routes.js'), 'utf8');
assert(routeSource.includes('stripe.checkout.sessions.expire'), 'replacement must retire the prior provider checkout');
assert(routeSource.includes("SELECT id FROM booking_guests WHERE id = $1::uuid AND booking_id = $2::uuid FOR UPDATE"), 'same guest domain must serialize with receipt writers');
assert(routeSource.includes("{ idempotencyKey: stripeIdempotencyKey }"), 'Stripe request must use deterministic idempotency identity');
assert(routeSource.indexOf("await pg.query('COMMIT')") < routeSource.indexOf('stripe.checkout.sessions.create({', routeSource.indexOf('async function handleBotGuestPaymentCreateLink')), 'durable draft must commit before provider creation');
assert(routeSource.includes("authMode === 'staff_portal' && paymentTarget === 'full_share'"), 'staff endpoint must reject legacy full_share');
assert(routeSource.includes("(checkout|billing)\\.stripe\\.com"), 'checkout URL must be restricted to approved Stripe HTTPS hosts');
assert(routeSource.includes('unit_amount: amountDueCents'), 'legacy source amount assertion missing');
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
    const state = { active: null, generation: 0, amount: 10000, collectible: new Set(), expired: [], createCalls: [] };
    const sessions = new Map();
    const guest = { client_id: 'client-a', booking_id: 'booking-a', booking_code: 'BK1', guest_name: 'Guest', guest_number: 1 };
    const stripe = { checkout: { sessions: {
      async create(params, options) {
        state.createCalls.push({ params, key: options.idempotencyKey });
        if (!sessions.has(options.idempotencyKey)) {
          const id = 'cs_' + (sessions.size + 1);
          sessions.set(options.idempotencyKey, { id, url: 'https://checkout.stripe.com/c/pay/' + id, status: 'open', expires_at: 9999999999 });
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
      async retire(op) { if (state.active && state.active.key === op.key) state.active = null; },
    };
    return { state, stripe, store };
  }
  async function execute(h, target) {
    return checkout.run({ store: h.store, stripe: h.stripe, guestId, clientSlug: 'client-a', paymentTarget: target,
      successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' });
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

  // Public staff wrapper rejects operator-A/body-B before any downstream work.
  {
    const auth = require('./lib/staff-guest-payment-link-auth');
    const sent = []; let downstream = 0;
    const bound = auth.bindStaffGuestPaymentClient({ req: { url: '/staff/bookings/generate-guest-payment-link?client=A' },
      body: { client_slug: 'B' }, user: { allowed_clients: ['A'] }, defaultClient: 'default', res: {},
      assertStaffClientAccess(u, slug) { assert.strictEqual(slug, 'A'); return true; },
      sendJSON(r, status, body) { sent.push({ status, body }); } });
    if (bound) downstream += 1;
    assert.strictEqual(downstream, 0);
    assert.deepStrictEqual(sent, [{ status: 403, body: { success: false, error: 'client_scope_mismatch' } }]);
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
