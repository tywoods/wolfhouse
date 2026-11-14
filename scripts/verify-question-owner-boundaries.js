'use strict';
const assert = require('node:assert/strict');
const { markGuestsPaymentLinkRequested } = require('./lib/booking-guest-payment-status');
const { buildBotQuoteReplyDraft } = require('./lib/bot-booking-package-normalize');
(async () => {
  const failure = new Error('projection_failure');
  const pg = { async query(sql) { if (sql.startsWith('UPDATE')) throw failure; return {rowCount: 0}; } };
  await assert.rejects(markGuestsPaymentLinkRequested(pg, {clientId:'tenant', bookingId:'booking'}), e => e instanceof require('./lib/booking-guest-payment-status').GuestPaymentStatusProjectionError && e.code === 'GUEST_PAYMENT_STATUS_PROJECTION_FAILED' && e.cause === failure);
  const text = buildBotQuoteReplyDraft({package_code: 'malibu', total_cents: 30000, deposit_required_cents: 20000}, {quotePackageCode: 'malibu'}, 'malibu');
  assert.ok(!text.includes('?'), 'Staff quote must not independently ask shuttle');
  console.log('PASS propagated SQL failure and single question producer');
})().catch(e => { console.error(e); process.exitCode = 1; });
