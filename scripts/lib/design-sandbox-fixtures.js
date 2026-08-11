'use strict';

/**
 * Design sandbox — fake schedule rows.
 *
 * MOCK DATA ONLY. Nothing here touches Postgres, Stripe or WhatsApp. Rows are
 * shaped to match the `/staff/schedule/day` payload built by
 * getSunsetScheduleLessonsOnDateQuery() / getSunsetScheduleGearOnDateQuery()
 * so the real portal UI renders them without knowing it is in a sandbox.
 *
 * Data is deterministic per date (seeded hash) so screenshots taken days apart
 * stay comparable — that is the whole point of the design environment.
 */

const DEFAULT_LOCATION_ID = 'sunset-somo';

const GUESTS = [
  'Marta Ibáñez', 'Tom Whitfield', 'Léa Moreau', 'Jonas Bergström',
  'Sofía Ramírez', 'Daniel O\'Connor', 'Chiara Bellini', 'Nils Andersen',
  'Aitor Etxeberria', 'Emma de Vries', 'Hugo Laurent', 'Paula Cifuentes',
  'Ben Carter', 'Ines Fonseca', 'Lukas Meier', 'Nora Haugen',
];

const LESSON_SLOTS = ['10:00', '12:00', '16:00', '18:00'];
const BOARD_LABELS = ['Softboard 7\'6"', 'Softboard 8\'0"', 'Funboard 7\'2"', 'Shortboard 6\'2"'];
const WETSUIT_LABELS = ['Wetsuit 4/3 M', 'Wetsuit 4/3 L', 'Wetsuit 3/2 S', 'Wetsuit 4/3 XL'];

/** Deterministic 32-bit hash → same date always yields the same day. */
function seedFor(dateIso) {
  let h = 2166136261;
  for (let i = 0; i < dateIso.length; i += 1) {
    h ^= dateIso.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed) {
  let s = seed || 1;
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length) % list.length];
}

function bookingCode(rng) {
  const n = Math.floor(rng() * 9000) + 1000;
  return `SUN-${n}`;
}

function phone(rng) {
  const n = Math.floor(rng() * 9000000) + 1000000;
  return `+346${String(n).slice(0, 7)}`;
}

function endTime(slot, minutes) {
  const [h, m] = slot.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const eh = String(Math.floor(total / 60) % 24).padStart(2, '0');
  const em = String(total % 60).padStart(2, '0');
  return `${eh}:${em}`;
}

function baseRow(rng, dateIso, locationId, overrides) {
  const guest = pick(rng, GUESTS);
  const code = bookingCode(rng);
  const paid = rng() > 0.35;
  const totalCents = (Math.floor(rng() * 8) + 3) * 2500;
  const row = {
    booking_id: `demo-${seedFor(dateIso + code)}`,
    phone: phone(rng),
    guest_name: guest,
    booking_code: code,
    service_date: dateIso,
    quantity: 1,
    service_status: 'confirmed',
    payment_status: paid ? 'paid' : 'pending',
    booking_payment_status: paid ? 'paid' : 'pending',
    booking_amount_paid_cents: paid ? totalCents : 0,
    booking_balance_due_cents: paid ? 0 : totalCents,
    waiver_signed: rng() > 0.4,
    service_record_id: `demo-sr-${seedFor(dateIso + code + (overrides.service_type || ''))}`,
    notes: null,
    needs_reply: rng() > 0.85,
    staff_ui_service_type: null,
    metadata_component: null,
    record_source: 'design_sandbox',
    metadata: {},
    booking_metadata: { location_id: locationId },
    location_id: locationId,
  };
  return Object.assign(row, overrides);
}

function lessonsFor(rng, dateIso, locationId) {
  const rows = [];
  LESSON_SLOTS.forEach((slot) => {
    // Not every slot runs — quiet slots make the board look real.
    const headcount = Math.floor(rng() * 6);
    for (let i = 0; i < headcount; i += 1) {
      rows.push(baseRow(rng, dateIso, locationId, {
        service_type: 'surf_lesson',
        slot_time: slot,
        service_time_local: slot,
        service_time_local_end: endTime(slot, 90),
        quantity: 1,
        metadata: { slot_time: slot, location_id: locationId },
      }));
    }
  });
  return rows;
}

function gearFor(rng, dateIso, locationId) {
  const rows = [];
  const rentals = Math.floor(rng() * 7);
  for (let i = 0; i < rentals; i += 1) {
    const isBoard = rng() > 0.45;
    const label = isBoard ? pick(rng, BOARD_LABELS) : pick(rng, WETSUIT_LABELS);
    rows.push(baseRow(rng, dateIso, locationId, {
      service_type: isBoard ? 'surfboard' : 'wetsuit',
      offering_label: label,
      catalog_label: label,
      slot_time: null,
      service_time_local: null,
      service_time_local_end: null,
      quantity: Math.floor(rng() * 2) + 1,
      metadata: { offering_label: label, location_id: locationId },
    }));
  }
  return rows;
}

/**
 * Build the full `/staff/schedule/day` payload for one date.
 * @param {string} dateIso  YYYY-MM-DD
 * @param {string} [locationId]
 */
function buildScheduleDayPayload(dateIso, locationId) {
  const loc = locationId || DEFAULT_LOCATION_ID;
  const rng = makeRng(seedFor(`${dateIso}|${loc}`));
  const active = [...lessonsFor(rng, dateIso, loc), ...gearFor(rng, dateIso, loc)];
  // A cancelled ghost or two keeps the cancelled-row styling exercised.
  const cancelled = rng() > 0.6
    ? [baseRow(rng, dateIso, loc, {
      service_type: 'surf_lesson',
      slot_time: '12:00',
      service_time_local: '12:00',
      service_time_local_end: '13:30',
      service_status: 'cancelled',
      booking_status: 'cancelled',
      schedule_ghost: true,
      metadata: { slot_time: '12:00', location_id: loc },
    })]
    : [];
  const rows = [...active, ...cancelled];
  return {
    success: true,
    date: dateIso,
    location_id: loc,
    rows,
    rental_label_map: {},
    active_count: active.length,
    cancelled_count: cancelled.length,
    count: rows.length,
    elapsed_ms: 0,
    design_sandbox: true,
  };
}

module.exports = {
  DEFAULT_LOCATION_ID,
  buildScheduleDayPayload,
};
