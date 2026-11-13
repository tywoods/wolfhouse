'use strict';

/**
 * Together-only must still INSERT via executeWolfhouseBookingCreate
 * (never 400 missing_payment_choice before the row exists).
 *
 * Usage: node scripts/verify-together-only-always-saves.js
 */

const assert = require('node:assert/strict');
const {
  BOOKING_CREATE_CHANNELS,
  executeWolfhouseBookingCreate,
} = require('./lib/luna-front-desk-accommodation-booking-create-service');

function capturingPg() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const text = String(sql);
      calls.push({ text, params: params || [] });
      if (/^BEGIN/i.test(text) || /^COMMIT/i.test(text) || /^ROLLBACK/i.test(text)) return { rows: [] };
      if (text.includes('offer_idempotency_lookup')) return { rows: [] };
      if (text.includes('FROM wh_pricing_seasons s')) {
        return { rows: [{
          code: 'autumn', active: true, bookable: true, priority: 0, sort_order: 1,
          ranges: [{ start_month: 1, start_day: 1, end_month: 12, end_day: 31 }],
        }] };
      }
      if (text.includes('FROM rooms r') || text.includes('offer_commit_reread') || text.includes('offer_room_lock')) {
        return { rows: [
          { bed_code: 'R1-1', room_code: 'R1', gender_strategy: 'mixed', bed_active: true, bed_sellable: true, room_type: 'shared', occupied: false },
          { bed_code: 'R1-2', room_code: 'R1', gender_strategy: 'mixed', bed_active: true, bed_sellable: true, room_type: 'shared', occupied: false },
        ] };
      }
      if (text.includes('wh_pricing_rules') || text.includes('wh_pricing_items') || text.includes('offer_price_lock')) {
        return { rows: [] };
      }
      if (/inserted_booking_beds|is_duplicate|is_blocked|beds_inserted/i.test(text)) {
        return { rows: [{
          is_duplicate: false, is_blocked: false,
          booking_id: 'saved-together-only-1', booking_code: 'WH-TOGETHER-ONLY-1',
          beds_inserted: 2, payments_inserted: 1,
        }] };
      }
      if (text.includes('UPDATE payments')) {
        return { rows: [{ payment_id: 'pay-together-1' }] };
      }
      return { rows: [] };
    },
  };
}

(async () => {
  const savePg = capturingPg();
  const saved = await executeWolfhouseBookingCreate(savePg, {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    actor: { staff_user_id: 'luna-bot-internal', staff_role: 'operator' },
    pkgCtx: { isNoPackage: false },
    usesPerGuestModel: false,
    checkIn: '2026-10-10',
    checkOut: '2026-10-13',
    quoteGuestCount: 2,
    assignedBedCodes: ['R1-1', 'R1-2'],
    roomType: 'shared',
    effectivePackageCode: 'malibu',
    paymentChoice: 'deposit',
    perGuestPaymentLinks: false,
    paymentLinkAmountCents: 20000,
    depositCents: 20000,
    totalCents: 41500,
    quote: {
      success: true,
      total_cents: 41500,
      deposit_required_cents: 20000,
      payment_link_amount_cents: 20000,
      currency: 'EUR',
    },
    notes: '',
    guestsNorm: { guests: [{ guest_name: 'Ada' }, { guest_name: 'Bea' }] },
    authoritativeRoomRows: [
      { bed_code: 'R1-1', room_code: 'R1', gender_strategy: 'mixed' },
      { bed_code: 'R1-2', room_code: 'R1', gender_strategy: 'mixed' },
    ],
    allocationReason: 'explicit_selection',
    availabilityProvenance: true,
    availabilityChecked: true,
    transportBody: {
      guests: [{ name: 'Ada' }, { name: 'Bea' }],
      payment_link_distribution: 'together',
      ask_payment_amount: true,
    },
  });

  assert.equal(saved.ok, true, JSON.stringify(saved && saved.body || saved));
  assert.notEqual(saved.status, 400, 'together-only must not 400 before insert');
  assert.notEqual(saved.body && saved.body.reason_code, 'missing_payment_choice');
  assert.equal(saved.body && saved.body.booking_id, 'saved-together-only-1');
  const insert = savePg.calls.find((row) => /inserted_booking_beds|beds_inserted/i.test(row.text));
  assert.ok(insert, 'executeWolfhouseBookingCreate must INSERT');
  console.log('PASS together-only always saves', {
    booking_id: saved.body.booking_id,
    booking_code: 'WH-TOGETHER-ONLY-1',
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
