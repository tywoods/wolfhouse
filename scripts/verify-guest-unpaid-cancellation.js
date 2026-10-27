'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const {
  classifyGuestCancellationPaymentEvidence,
  GUEST_CANCEL_PAYMENT_EVIDENCE_SQL,
  GUEST_CANCEL_BOOKING_UPDATE_SQL,
  GUEST_CANCEL_V3_BOOKING_UPDATE_SQL,
  executeGuestUnpaidCancellationBoundary,
} = require('./lib/guest-unpaid-cancellation');
const {
  loadActiveGuestBookings,
  loadCancellationGuestBookings,
  mapCancellationGuestBookingRows,
} = require('./lib/luna-guest-booking-disambiguation');

function eligible(overrides = {}) {
  return {
    booking_found: true,
    phone_matches: true,
    booking_status: 'payment_pending',
    booking_payment_status: 'waiting_payment',
    booking_amount_paid_cents: 0,
    booking_deposit_paid_cents: 0,
    payment_row_count: 0,
    payment_positive_count: 0,
    payment_unknown_amount_count: 0,
    payment_captured_count: 0,
    payment_unknown_status_count: 0,
    payment_event_paid_count: 0,
    guest_row_count: 2,
    guest_positive_count: 0,
    guest_paid_status_count: 0,
    guest_unknown_status_count: 0,
    guest_unknown_amount_count: 0,
    evidence_consistent: true,
    ...overrides,
  };
}

assert.deepEqual(classifyGuestCancellationPaymentEvidence(eligible()), { eligible: true, reason: 'authoritative_zero_payment' });
const retiredV3Payment = eligible({
  luna_v3_provenance: 'fresh_one_try',
  payment_row_count: 1,
  payment_inert_draft_count: 1,
  payment_provider_active_count: 0,
});
assert.deepEqual(
  classifyGuestCancellationPaymentEvidence(retiredV3Payment, { trustedV3: true }),
  { eligible: true, reason: 'recognized_inert_v3_draft' },
  'trusted-v3 accepts a verified expired/retired zero-money payment after provider identifiers are cleared',
);
assert.deepEqual(
  classifyGuestCancellationPaymentEvidence(retiredV3Payment),
  { eligible: true, reason: 'authoritative_zero_payment' },
  'Classic treats a zero-money draft payment row as unpaid, not as received money',
);
assert.deepEqual(
  classifyGuestCancellationPaymentEvidence(eligible({ payment_row_count: 1, payment_provider_active_count: 1 })),
  { eligible: true, reason: 'authoritative_zero_payment' },
  'Stripe link created awaiting payment took no money and must not block',
);
assert.deepEqual(
  classifyGuestCancellationPaymentEvidence(eligible({
    booking_payment_status: null,
    booking_amount_paid_cents: 0,
    booking_deposit_paid_cents: 0,
  })),
  { eligible: true, reason: 'authoritative_zero_payment' },
  'unknown status uses Staff paid amount 0',
);
assert.deepEqual(
  classifyGuestCancellationPaymentEvidence(eligible({
    booking_amount_paid_cents: null,
    booking_deposit_paid_cents: null,
  })),
  { eligible: true, reason: 'authoritative_zero_payment' },
  'null Staff paid amount with no captured money is unpaid',
);
assert.deepEqual(
  classifyGuestCancellationPaymentEvidence(eligible({ payment_unknown_status_count: 1 })),
  { eligible: true, reason: 'authoritative_zero_payment' },
  'unknown payment-row status still unpaid when Staff paid amount is 0',
);
assert.deepEqual(
  classifyGuestCancellationPaymentEvidence(eligible({ payment_unknown_amount_count: 1 })),
  { eligible: true, reason: 'authoritative_zero_payment' },
  'null draft payment amount is not received money',
);
assert.deepEqual(
  classifyGuestCancellationPaymentEvidence(eligible({ guest_unknown_status_count: 1, guest_unknown_amount_count: 1 })),
  { eligible: true, reason: 'authoritative_zero_payment' },
  'null guest draft amounts are not received money',
);
for (const [name, patch, reason] of [
  ['booking aggregate', { booking_amount_paid_cents: 1 }, 'payment_exists'],
  ['deposit aggregate', { booking_deposit_paid_cents: 1 }, 'payment_exists'],
  ['captured payment row', { payment_captured_count: 1 }, 'payment_exists'],
  ['provider paid event before aggregate update', { payment_event_paid_count: 1 }, 'payment_exists'],
  ['partial payment row', { payment_positive_count: 1 }, 'payment_exists'],
  ['one paid guest', { guest_positive_count: 1 }, 'payment_exists'],
  ['guest paid status', { guest_paid_status_count: 1 }, 'payment_exists'],
  ['inconsistent aggregate', { evidence_consistent: false }, 'payment_evidence_inconsistent'],
  ['wrong phone', { phone_matches: false }, 'booking_not_owned'],
]) {
  assert.deepEqual(classifyGuestCancellationPaymentEvidence(eligible(patch)), { eligible: false, reason }, name);
}

assert.match(GUEST_CANCEL_PAYMENT_EVIDENCE_SQL, /FOR UPDATE OF b/i, 'booking must be locked at the write boundary');
assert.match(GUEST_CANCEL_PAYMENT_EVIDENCE_SQL, /payments/i, 'payment ledger must be checked');
assert.match(GUEST_CANCEL_PAYMENT_EVIDENCE_SQL, /booking_guests/i, 'per-guest ledger must be checked');
assert.match(GUEST_CANCEL_PAYMENT_EVIDENCE_SQL, /client_slug|c\.slug/i, 'tenant scope must be in SQL');
assert.match(GUEST_CANCEL_PAYMENT_EVIDENCE_SQL, /phone/i, 'guest ownership must be in SQL');
assert.match(GUEST_CANCEL_BOOKING_UPDATE_SQL, /status\s*=\s*'cancelled'/i);
assert.match(GUEST_CANCEL_BOOKING_UPDATE_SQL, /NOT EXISTS[\s\S]*payments/i, 'write itself must recheck payment rows');
assert.match(GUEST_CANCEL_BOOKING_UPDATE_SQL, /COALESCE\(p\.amount_paid_cents,0\)>0/i, 'only received payment money blocks the write');
assert.doesNotMatch(GUEST_CANCEL_BOOKING_UPDATE_SQL, /NOT EXISTS \(SELECT 1 FROM payments p WHERE p\.client_id=b\.client_id AND p\.booking_id=b\.id\)/i, 'a draft Stripe link row must not block cancellation');
assert.match(GUEST_CANCEL_BOOKING_UPDATE_SQL, /COALESCE\(b\.(?:amount_paid_cents|deposit_paid_cents),0\)=0/i, 'Staff paid amount 0 or null is unpaid');
assert.doesNotMatch(GUEST_CANCEL_BOOKING_UPDATE_SQL, /bg\.amount_paid_cents IS NULL/i, 'null guest draft amounts must not block the write');
assert.match(GUEST_CANCEL_BOOKING_UPDATE_SQL, /COALESCE\(bg\.amount_paid_cents,0\)>0/i, 'received guest money still blocks');
assert.match(GUEST_CANCEL_PAYMENT_EVIDENCE_SQL, /checkout\.session\.async_payment_succeeded/i, 'async Stripe success is payment truth');
assert.match(GUEST_CANCEL_PAYMENT_EVIDENCE_SQL, /pe\.booking_id=b\.id OR EXISTS[\s\S]*ep\.id=pe\.payment_id/i, 'provider events linked through payment_id are included');
assert.match(GUEST_CANCEL_BOOKING_UPDATE_SQL, /checkout\.session\.async_payment_succeeded/i, 'write guard blocks async Stripe success');
assert.match(GUEST_CANCEL_BOOKING_UPDATE_SQL, /pe\.booking_id=b\.id OR EXISTS[\s\S]*ep\.id=pe\.payment_id/i, 'write guard includes indirect payment-event ownership');
assert.match(GUEST_CANCEL_BOOKING_UPDATE_SQL, /amount_paid_cents/i, 'write itself must recheck booking aggregates');
assert.match(GUEST_CANCEL_PAYMENT_EVIDENCE_SQL, /IN \([^)]*'expired'[^)]*\)[\s\S]{0,700}AS payment_inert_draft_count/i,
  'expired zero-money payment rows with cleared provider identifiers classify as retired/inert');
assert.match(GUEST_CANCEL_V3_BOOKING_UPDATE_SQL, /COALESCE\(p\.amount_paid_cents,0\)>0/i,
  'trusted-v3 write uses the same received-money guard as Classic');

// Discovery uses a separate tenant-scoped cancellation query; service callers
// retain the existing paid-only active-booking semantics.
(async () => {
  const calls = [];
  const pg = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{
    booking_id: 'booking-1', booking_code: 'WH-UNPAID', check_in: '2026-11-01',
    check_out: '2026-11-08', status: 'payment_pending', payment_status: 'waiting_payment',
    guest_count: 1, guest_name: 'Test Guest',
  }] }; } };
  const rows = await loadCancellationGuestBookings(pg, { phone: '+34 600 000 001', clientSlug: 'wolfhouse-somo' });
  assert.equal(rows[0].booking_code, 'WH-UNPAID');
  assert.match(calls[0].sql, /JOIN clients/i);
  assert.match(calls[0].sql, /c\.slug\s*=\s*\$2/i, 'lookup is trusted-tenant scoped');
  assert.match(calls[0].sql, /'waiting_payment','unpaid','pending','not_requested'/i,
    'fresh Staff-created unpaid rows remain discoverable before booking payment status is projected');
  assert.deepEqual(calls[0].params, ['%600000001%', 'wolfhouse-somo']);
  assert.deepEqual(mapCancellationGuestBookingRows(rows), [{
    booking_code: 'WH-UNPAID', check_in: '2026-11-01', check_out: '2026-11-08',
    guest_count: 1, guest_name: 'Test Guest', status: 'payment_pending', payment_status: 'waiting_payment',
  }], 'actual list_my_bookings JSON retains cancellation row shape');
  calls.length = 0;
  await loadActiveGuestBookings(pg, { phone: '+34 600 000 001' });
  assert.match(calls[0].sql, /'deposit_paid','paid','full_paid','balance_due'/);
  assert.doesNotMatch(calls[0].sql, /waiting_payment/, 'legacy active lookup stays paid-only');
})().catch((err) => { console.error(err); process.exitCode = 1; });
assert.match(require('./lib/guest-unpaid-cancellation').GUEST_CANCEL_PAYMENT_ROWS_LOCK_SQL, /payments[\s\S]*FOR UPDATE/i);
assert.match(require('./lib/guest-unpaid-cancellation').GUEST_CANCEL_GUEST_ROWS_LOCK_SQL, /booking_guests[\s\S]*FOR UPDATE/i);
assert.match(require('./lib/guest-unpaid-cancellation').GUEST_CANCEL_PAYMENT_EVENT_ROWS_LOCK_SQL, /payment_events[\s\S]*FOR UPDATE/i);

const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
assert.match(api, /\/staff\/bot\/bookings\/cancel-unpaid/);
assert.match(api, /handleBotGuestCancelUnpaid/);
assert.match(api, /BEGIN[\s\S]*executeGuestUnpaidCancellationBoundary[\s\S]*COMMIT/);

const plugin = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'), 'utf8');
assert.match(plugin, /def cancel_unpaid_booking\(/);
assert.match(plugin, /"cancel_unpaid_booking"/);
assert.match(plugin, /paid_or_unknown_cancellation/);
assert.match(plugin, /from wolfhouse\.live_turn_owner import live_turn_guest_phone/);
const liveOwnerFunction = plugin.split('def _live_turn_guest_phone():')[1].split('def _base_url():')[0];
assert.doesNotMatch(liveOwnerFunction, /get_session_env\(/,
  'destructive identity must not call the environment-fallback accessor');
assert.doesNotMatch(plugin, /refund amount|refund percentage/i);

const gatewayPatch = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/apply_gateway_patches.py'), 'utf8');
assert.match(gatewayPatch, /bind_live_turn_owner/,
  'gateway turn start must bind revocable cancellation authority');
assert.match(gatewayPatch, /close_live_turn_owner\(tokens\)[\s\S]{0,120}clear_session_vars\(tokens\)/,
  'gateway turn close must revoke authority before clearing session vars');

(async () => {
  const evidence = eligible({ booking_id: 'booking-1', client_id: 'client-1', booking_code: 'WH-1' });
  const fakePg = (initial, recheck, updateRows) => ({
    evidenceCalls: 0,
    async query(sql) {
      if (sql === GUEST_CANCEL_PAYMENT_EVIDENCE_SQL) return { rows: [this.evidenceCalls++ === 0 ? initial : recheck] };
      if (sql === GUEST_CANCEL_BOOKING_UPDATE_SQL) return { rows: updateRows };
      return { rows: [] };
    },
  });
  const paidPg = fakePg(eligible({ ...evidence, payment_positive_count: 1 }), eligible({ ...evidence, payment_positive_count: 1 }), []);
  assert.deepEqual(
    await executeGuestUnpaidCancellationBoundary(paidPg, { clientSlug: 'wolfhouse-somo', bookingCode: 'WH-1', phone: '+34611' }),
    { blocked: true, reason: 'payment_exists' },
  );

  const racePg = fakePg(evidence, evidence, []);
  assert.deepEqual(
    await executeGuestUnpaidCancellationBoundary(racePg, { clientSlug: 'wolfhouse-somo', bookingCode: 'WH-1', phone: '+34611' }),
    { blocked: true, reason: 'payment_race_or_evidence_changed' },
  );

  const paidDuringLockPg = fakePg(evidence, { ...evidence, guest_positive_count: 1 }, []);
  assert.deepEqual(
    await executeGuestUnpaidCancellationBoundary(paidDuringLockPg, { clientSlug: 'wolfhouse-somo', bookingCode: 'WH-1', phone: '+34611' }),
    { blocked: true, reason: 'payment_exists' },
  );

  const okPg = fakePg(evidence, evidence, [{ booking_id: 'booking-1', status: 'cancelled' }]);
  const result = await executeGuestUnpaidCancellationBoundary(okPg, { clientSlug: 'wolfhouse-somo', bookingCode: 'WH-1', phone: '+34611' });
  assert.equal(result.blocked, false);
  assert.equal(result.updatedRow.status, 'cancelled');
  console.log('guest unpaid cancellation boundary: PASS');
})().catch((err) => { console.error(err); process.exitCode = 1; });
