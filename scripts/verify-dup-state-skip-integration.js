'use strict';

const assert = require('node:assert/strict');
const { amountFor } = require('./lib/per-guest-checkout');

function acceptedPersonMoneyConsumer() {
  const known = {
    guest_metadata: {
      money: { subtotal_cents: 28000, deposit_cents: 10000 },
      money_attribution: { version: 1, state: 'known', source: 'accepted_solo_aggregate' },
    },
    // The legacy SQL placeholder is not the person-money authority.
    deposit_amount_cents: 0,
    amount_paid_cents: 0,
  };
  assert.equal(amountFor(known, 'deposit'), 10000,
    'personal deposit preparation consumes accepted person money, not the legacy zero placeholder');
  assert.equal(amountFor(known, 'full'), 28000,
    'personal full preparation consumes the accepted person subtotal');

  for (const attribution of [
    { money: { subtotal_cents: null, deposit_cents: null }, money_attribution: { version: 1, state: 'unknown' } },
    { money: { subtotal_cents: 28000, deposit_cents: null }, money_attribution: { version: 1, state: 'partial' } },
  ]) {
    assert.throws(() => amountFor({ guest_metadata: attribution,
      deposit_amount_cents: 0, amount_paid_cents: 0 }, 'deposit'),
    /authoritative_guest_money_unavailable/,
    'incomplete group attribution must stay unavailable instead of becoming zero or an equal split');
  }
}

acceptedPersonMoneyConsumer();
console.log('PASS BC-K04 accepted person money drives personal-payment readiness');
