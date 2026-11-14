'use strict';

const MALIBU_ACCEPTED_STALE_BODY = Object.freeze({
  name: 'accepted Malibu overrides stale plain transport identity',
  acceptedPackageCode: 'malibu',
  acceptedRoomType: 'private',
  transportPackageCode: 'package_none',
  transportRoomType: 'shared',
  derivedPackageCode: 'package_none',
  derivedAccommodationOnly: true,
  derivedRoomType: 'shared',
  expectedPackageCode: 'malibu',
  expectedAccommodationOnly: false,
  expectedRoomType: 'private',
});

const PLAIN_ACCEPTED_STALE_OFFER = Object.freeze({
  name: 'accepted plain shared stay overrides stale Malibu private offer',
  acceptedPackageCode: 'package_none',
  acceptedRoomType: 'shared',
  transportPackageCode: 'malibu',
  transportRoomType: 'private',
  derivedPackageCode: 'malibu',
  derivedAccommodationOnly: false,
  derivedRoomType: 'private',
  expectedPackageCode: 'package_none',
  expectedAccommodationOnly: true,
  expectedRoomType: 'shared',
});

function makeCapturingPg() {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      const text = String(sql);
      calls.push({ text, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
      if (text.includes('offer_idempotency_lookup')) return { rows: [] };
      if (text === 'SELECT client_id FROM bookings WHERE id = $1') {
        return { rows: [{ client_id: 'bc-skip-client' }] };
      }
      if (text.includes('FROM booking_beds') && text.includes('ORDER BY created_at ASC')) {
        return { rows: [{ bed_code: 'R1-B1', room_code: 'R1' }] };
      }
      if (text.includes('INSERT INTO booking_guests')) return { rows: [{
        booking_guest_id: 'bc-skip-guest-1', guest_number: 1, guest_name: 'Camila',
        assigned_room_code: 'R1', assigned_bed_code: 'R1-B1',
        deposit_amount_cents: 20000, payment_status: 'not_requested',
      }] };
      if (text.includes('FROM wh_pricing_seasons s')) return { rows: [{
        code: 'all-year', active: true, bookable: true, priority: 0, sort_order: 1,
        ranges: [{ start_month: 1, start_day: 1, end_month: 12, end_day: 31 }],
      }] };
      if (text.includes('FROM rooms r') || text.includes('offer_commit_reread') || text.includes('offer_room_lock')) {
        return { rows: [{ bed_code: 'R1-B1', room_code: 'R1', gender_strategy: 'mixed',
          bed_active: true, bed_sellable: true, room_type: 'shared', occupied: false }] };
      }
      if (text.includes('wh_pricing_rules') || text.includes('wh_pricing_items') || text.includes('offer_price_lock')) return { rows: [] };
      if (/inserted_booking_beds|is_duplicate|is_blocked|beds_inserted/i.test(text)) return { rows: [{
        is_duplicate: false, is_blocked: false, booking_id: 'bc-skip-booking',
        booking_code: 'WH-BC-SKIP', beds_inserted: 1, payments_inserted: 1,
      }] };
      if (text.includes('UPDATE payments')) return { rows: [{ payment_id: 'bc-skip-payment' }] };
      return { rows: [] };
    },
  };
}

module.exports = { MALIBU_ACCEPTED_STALE_BODY, PLAIN_ACCEPTED_STALE_OFFER, makeCapturingPg };
