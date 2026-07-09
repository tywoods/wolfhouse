'use strict';

/**
 * Deterministic in-memory pg stub for verify:luna-golden (offline gate).
 *
 * Satisfies read-only bed-calendar and booking lookups used by the guest
 * automation orchestrator dry-run path — no Docker Postgres, no Staff API.
 */

const {
  getBedCalendarRoomsQuery,
  getBedCalendarBlocksQuery,
} = require('./staff-bed-calendar-queries');

const ROOMS_QUERY = getBedCalendarRoomsQuery().replace(/\s+/g, ' ').trim();
const BLOCKS_QUERY = getBedCalendarBlocksQuery().replace(/\s+/g, ' ').trim();

/** Post-booking golden fixtures — stable ids from fixtures/luna-golden. */
const GOLDEN_BOOKINGS = Object.freeze({
  '00000000-0000-0000-0000-000000000001': {
    id: '00000000-0000-0000-0000-000000000001',
    booking_code: 'WH-G27-GOLDEN14',
    payment_status: 'deposit_paid',
    guest_count: 3,
    guest_name: 'Alex',
    check_in: '2026-09-01',
    check_out: '2026-09-10',
    status: 'confirmed',
    confirmation_sent_at: null,
  },
  '00000000-0000-0000-0000-000000000016': {
    id: '00000000-0000-0000-0000-000000000016',
    booking_code: 'WH-G27-GOLDEN16',
    payment_status: 'deposit_paid',
    guest_count: 2,
    guest_name: 'Ty',
    check_in: '2026-09-15',
    check_out: '2026-09-22',
    status: 'confirmed',
    confirmation_sent_at: null,
  },
  '00000000-0000-0000-0000-000000000021': {
    id: '00000000-0000-0000-0000-000000000021',
    booking_code: 'WH-G27-GOLDEN21',
    payment_status: 'pending',
    guest_count: 2,
    guest_name: 'John',
    check_in: '2026-09-16',
    check_out: '2026-09-19',
    package_code: 'no_package',
    total_amount_cents: 27000,
    amount_paid_cents: 0,
    balance_due_cents: 27000,
    status: 'pending_payment',
    confirmation_sent_at: null,
    client_id: 'golden-client-id',
    metadata: {},
  },
  '11111111-1111-4111-8111-111111111122': {
    id: '11111111-1111-4111-8111-111111111122',
    booking_code: 'WH-G27-GOLDEN22',
    payment_status: 'deposit_paid',
    guest_count: 2,
    guest_name: 'John',
    check_in: '2026-09-16',
    check_out: '2026-09-19',
    package_code: 'no_package',
    total_amount_cents: 30000,
    amount_paid_cents: 20000,
    balance_due_cents: 10000,
    status: 'confirmed',
    confirmation_sent_at: null,
    client_id: 'golden-client-id',
    metadata: {},
  },
});

const GOLDEN_BOOKINGS_BY_CODE = Object.freeze(
  Object.fromEntries(Object.values(GOLDEN_BOOKINGS).map((row) => [row.booking_code, row])),
);

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function buildGoldenBedRows() {
  const rows = [];
  for (let room = 1; room <= 4; room++) {
    for (let bed = 1; bed <= 4; bed++) {
      rows.push({
        room_id: `golden-room-${room}`,
        room_code: `R${room}`,
        room_name: `Room ${room}`,
        house: 'main',
        room_type: 'shared',
        capacity: 4,
        fill_priority: room,
        room_sort_order: room,
        gender_strategy: null,
        can_be_matrimonial: false,
        often_used_by_operator: false,
        bed_id: `golden-bed-${room}-${bed}`,
        bed_code: `R${room}-B${bed}`,
        bed_label: `Bed ${bed}`,
        bed_number: bed,
        bed_planning_label: null,
        bed_active: true,
        bed_sellable: true,
      });
    }
  }
  return rows;
}

const GOLDEN_BED_ROWS = buildGoldenBedRows();

function bookingSendStateRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    booking_code: row.booking_code,
    payment_status: row.payment_status,
    confirmation_sent_at: row.confirmation_sent_at,
    guest_phone_meta: null,
    guest_phone_column: null,
    guest_name_meta: row.guest_name,
    guest_name: row.guest_name,
  };
}

function bookingAddonLookupRow(row) {
  if (!row) return null;
  return {
    booking_id: row.id,
    booking_code: row.booking_code,
    guest_name: row.guest_name,
    check_in: row.check_in,
    check_out: row.check_out,
    booking_status: row.status,
    client_id: 'golden-client-id',
    client_slug: 'wolfhouse-somo',
  };
}

function activeGuestBookingRow(row) {
  if (!row) return null;
  return {
    booking_id: row.id,
    booking_code: row.booking_code,
    check_in: row.check_in,
    check_out: row.check_out,
    status: row.status,
    payment_status: row.payment_status,
    guest_count: row.guest_count,
    guest_name: row.guest_name,
  };
}

function resolveBookingById(id) {
  return GOLDEN_BOOKINGS[String(id)] || null;
}

function resolveBookingByCode(code) {
  return GOLDEN_BOOKINGS_BY_CODE[String(code || '').trim()] || null;
}

function bookingLoadRow(row) {
  if (!row) return null;
  return {
    booking_id: row.id,
    booking_code: row.booking_code,
    client_id: row.client_id || 'golden-client-id',
    guest_count: row.guest_count,
    guest_name: row.guest_name,
    total_amount_cents: row.total_amount_cents,
    amount_paid_cents: row.amount_paid_cents,
    balance_due_cents: row.balance_due_cents,
    payment_status: row.payment_status,
    check_in: row.check_in,
    check_out: row.check_out,
    package_code: row.package_code || 'no_package',
    metadata: row.metadata || {},
  };
}

function resolveGoldenBookingLoad(slug, idOrCode, byCode) {
  const row = byCode ? resolveBookingByCode(idOrCode) : resolveBookingById(idOrCode);
  if (!row) return null;
  if (slug && slug !== 'wolfhouse-somo') return null;
  return bookingLoadRow(row);
}

function queryGoldenOfflinePg(sql, params) {
  const s = normalizeSql(sql);
  const p = params || [];

  if (s === ROOMS_QUERY || (s.includes('FROM rooms r') && s.includes('LEFT JOIN beds bd'))) {
    return { rows: GOLDEN_BED_ROWS };
  }
  if (s === BLOCKS_QUERY || (s.includes('FROM booking_beds bb') && s.includes('assignment_start_date'))) {
    return { rows: [] };
  }
  if (s.includes('FROM bookings WHERE id = $1::uuid')) {
    return { rows: [bookingSendStateRow(resolveBookingById(p[0]))].filter(Boolean) };
  }
  if (s.includes('FROM bookings WHERE booking_code = $1') && !s.includes('JOIN clients')) {
    return { rows: [bookingSendStateRow(resolveBookingByCode(p[0]))].filter(Boolean) };
  }
  if (s.includes('FROM bookings') && s.includes('phone LIKE')) {
    return { rows: [] };
  }
  if (s.includes('FROM bookings b') && s.includes('JOIN clients cl') && s.includes('booking_code = $1')) {
    return { rows: [bookingAddonLookupRow(resolveBookingByCode(p[0]))].filter(Boolean) };
  }
  if (s.includes('FROM bookings b') && s.includes('INNER JOIN clients c') && s.includes('b.id::text = $2')) {
    return { rows: [resolveGoldenBookingLoad(p[0], p[1], false)].filter(Boolean) };
  }
  if (s.includes('FROM bookings b') && s.includes('INNER JOIN clients c') && s.includes('b.booking_code = $2')) {
    return { rows: [resolveGoldenBookingLoad(p[0], p[1], true)].filter(Boolean) };
  }
  if (s.includes('FROM clients WHERE slug')) {
    return { rows: [{ id: 'golden-client-id' }] };
  }
  if (s.includes('FROM messages m') && s.includes('INNER JOIN conversations conv')) {
    return { rows: [] };
  }

  throw new Error(`luna-golden-offline-pg: unexpected query: ${s.slice(0, 160)}`);
}

/**
 * @returns {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: object[] }> }}
 */
function createLunaGoldenOfflinePg() {
  return {
    async query(sql, params) {
      return queryGoldenOfflinePg(sql, params);
    },
  };
}

module.exports = {
  createLunaGoldenOfflinePg,
  queryGoldenOfflinePg,
  GOLDEN_BOOKINGS,
  GOLDEN_BED_ROWS,
};
