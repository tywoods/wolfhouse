'use strict';

/**
 * Slice 1 — Add a guest to an EXISTING, UNPAID booking.
 *
 * Mirrors the shape/exports of luna-guest-addon-service-attach.js. Given an existing
 * booking + the added guest name(s), it:
 *   1. Loads the booking; if it is paid/deposit_paid/partially paid → returns
 *      { status: 'handoff_paid' } WITHOUT mutating (defense in depth; readiness blocks too).
 *   2. Confirms a bed exists for the extra guest(s) on the SAME dates
 *      (reuses runGuestAvailabilityDryRun). If not → { status: 'no_availability' }.
 *   3. Requotes accommodation for guest_count + N on the same dates via the shared
 *      wolfhouse quote engine (runBookingPreviewDryRun) and adds the per-guest
 *      accommodation delta to the existing booking total.
 *   4. Updates the booking (guest_count, guest_name, total_amount_cents,
 *      balance_due_cents, metadata) and inserts one booking_guests row per new guest.
 *
 * All DB writes respect the existing env gate (isOpenDemoBookingWritesEnabled) and are
 * no-ops without pg.
 */

const { runBookingPreviewDryRun } = require('./luna-guest-booking-dry-run');
const { runGuestAvailabilityDryRun } = require('./luna-guest-availability-dry-run');
const { isOpenDemoBookingWritesEnabled } = require('./open-demo-whatsapp-gate');

const ADD_GUEST_WRITE_SOURCE = 'luna_guest';
const ADD_GUEST_ATTACH_ORIGIN = 'luna_guest_add_guest';

/** Booking payment_status values that mean "paid / partially paid" → stays a staff handoff. */
const PAID_BOOKING_PAYMENT_STATUSES = Object.freeze(new Set([
  'paid',
  'deposit_paid',
  'partially_paid',
  'fully_paid',
]));

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function isPaidBookingPaymentStatus(paymentStatus) {
  return PAID_BOOKING_PAYMENT_STATUSES.has(trimStr(paymentStatus).toLowerCase());
}

function normalizeNewGuestNames(input) {
  if (Array.isArray(input)) {
    return input.map((n) => trimStr(n)).filter(Boolean);
  }
  const single = trimStr(input);
  return single ? [single] : [];
}

/**
 * Build the flat quote-engine field shape (same fields mapRouterToQuoteFields produces)
 * so we can requote accommodation for an arbitrary guest_count on the same dates.
 */
function buildQuoteFields(opts, guestCount) {
  const o = opts || {};
  return {
    client_slug: trimStr(o.clientSlug) || 'wolfhouse-somo',
    location_id: o.locationId || null,
    check_in: o.checkIn || null,
    check_out: o.checkOut || null,
    guest_count: Number(guestCount),
    package_code: o.packageCode || 'no_package',
    room_type: trimStr(o.roomType) || 'shared',
    payment_choice: 'full',
    add_ons: [],
    transfer_interest: null,
  };
}

function accommodationTotalCents(quoteFields) {
  const preview = runBookingPreviewDryRun(quoteFields);
  const q = preview && preview.quote;
  if (!q || !q.success) return null;
  return Number(q.total_cents);
}

/**
 * Requote: return the per-guest accommodation delta for adding `addedCount` guests
 * to the same dates, plus the old/new accommodation totals.
 */
function computeAccommodationDelta(opts, currentGuestCount, addedCount) {
  const oldFields = buildQuoteFields(opts, currentGuestCount);
  const newFields = buildQuoteFields(opts, currentGuestCount + addedCount);
  const oldTotal = accommodationTotalCents(oldFields);
  const newTotal = accommodationTotalCents(newFields);
  if (oldTotal == null || newTotal == null) {
    return { ok: false, old_accommodation_cents: oldTotal, new_accommodation_cents: newTotal, delta_cents: null };
  }
  return {
    ok: true,
    old_accommodation_cents: oldTotal,
    new_accommodation_cents: newTotal,
    delta_cents: newTotal - oldTotal,
  };
}

/**
 * Availability guard — confirm a bed exists for the requested party size on the same dates.
 * Reuses the existing availability dry-run. Returns { available, status, detail }.
 */
async function confirmAddedGuestAvailability(pg, opts, newGuestCount) {
  const o = opts || {};
  const routerResult = {
    success: true,
    detected_language: 'en',
    extracted_fields: {
      check_in: o.checkIn || null,
      check_out: o.checkOut || null,
      guest_count: Number(newGuestCount),
      package_interest: 'accommodation_only',
    },
  };
  const avail = await runGuestAvailabilityDryRun(routerResult, {
    pg,
    client_slug: trimStr(o.clientSlug) || 'wolfhouse-somo',
    room_type: trimStr(o.roomType) || 'shared',
  });
  return {
    available: avail && avail.availability_status === 'available',
    status: avail && avail.availability_status,
    detail: avail,
  };
}

async function loadBooking(pg, clientSlug, bookingId, bookingCode) {
  const bySlug = trimStr(clientSlug) || 'wolfhouse-somo';
  if (bookingId) {
    const r = await pg.query(
      `SELECT b.id::text AS booking_id, b.booking_code, b.client_id::text AS client_id,
              b.guest_count, b.guest_name,
              b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents,
              b.payment_status::text AS payment_status,
              b.check_in::text AS check_in, b.check_out::text AS check_out,
              b.package_code, b.metadata
         FROM bookings b
         INNER JOIN clients c ON c.id = b.client_id
        WHERE c.slug = $1 AND b.id::text = $2
        LIMIT 1`,
      [bySlug, bookingId],
    );
    return r.rows[0] || null;
  }
  if (bookingCode) {
    const r = await pg.query(
      `SELECT b.id::text AS booking_id, b.booking_code, b.client_id::text AS client_id,
              b.guest_count, b.guest_name,
              b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents,
              b.payment_status::text AS payment_status,
              b.check_in::text AS check_in, b.check_out::text AS check_out,
              b.package_code, b.metadata
         FROM bookings b
         INNER JOIN clients c ON c.id = b.client_id
        WHERE c.slug = $1 AND b.booking_code = $2
        LIMIT 1`,
      [bySlug, bookingCode],
    );
    return r.rows[0] || null;
  }
  return null;
}

function appendGuestName(existing, newNames) {
  const base = trimStr(existing);
  const additions = newNames.map(trimStr).filter(Boolean);
  if (!additions.length) return base;
  return base ? `${base}, ${additions.join(', ')}` : additions.join(', ');
}

/**
 * Refresh the open pay-in-full payment draft for this booking to the new total so the
 * re-sent Stripe link charges the updated amount (the link derives its charge from
 * payments.amount_due_cents, NOT bookings.total_amount_cents). Only touches an UNPAID
 * full-amount draft (amount_paid_cents = 0, status not paid). Returns the draft id, if any.
 */
async function refreshFullPaymentDraftAmount(pg, clientSlug, bookingId, newTotalCents) {
  const r = await pg.query(
    `UPDATE payments p
        SET amount_due_cents = $3
       FROM bookings b, clients c
      WHERE p.booking_id = b.id
        AND b.client_id = c.id
        AND c.slug = $1
        AND b.id::text = $2
        AND p.payment_kind = 'full_amount'
        AND p.status::text <> 'paid'
        AND COALESCE(p.amount_paid_cents, 0) = 0
      RETURNING p.id::text AS payment_draft_id, p.amount_due_cents`,
    [clientSlug, bookingId, newTotalCents],
  );
  return r.rows[0] || null;
}

/**
 * Add guest(s) to an existing UNPAID booking.
 *
 * @param {object} pg
 * @param {object} opts
 *   clientSlug, bookingId, bookingCode, newGuestNames[], writeSource,
 *   checkIn/checkOut/packageCode/roomType (optional overrides for the requote),
 *   env
 * @returns snapshot with updated totals for the composer / payment-link step.
 */
async function addGuestToBooking(pg, opts) {
  const o = opts || {};
  const clientSlug = trimStr(o.clientSlug) || 'wolfhouse-somo';
  const bookingId = trimStr(o.bookingId);
  const bookingCode = trimStr(o.bookingCode);
  const env = o.env || process.env;
  const newGuestNames = normalizeNewGuestNames(o.newGuestNames);
  const addedCount = newGuestNames.length;

  const base = {
    add_guest_write_source: trimStr(o.writeSource) || 'luna_guest_gpt_write_tool_add_guest',
    added_guest_names: newGuestNames,
    added_guest_count: addedCount,
  };

  if (!pg || !bookingId && !bookingCode) {
    return { ...base, status: 'noop', reason: 'pg_or_booking_ref_missing' };
  }
  if (!addedCount) {
    return { ...base, status: 'noop', reason: 'no_added_guest_names' };
  }

  const booking = await loadBooking(pg, clientSlug, bookingId, bookingCode);
  if (!booking) {
    return { ...base, status: 'noop', reason: 'booking_not_found' };
  }

  // Defense in depth — never mutate a paid / partially paid booking. Readiness blocks too.
  if (isPaidBookingPaymentStatus(booking.payment_status)) {
    return {
      ...base,
      status: 'handoff_paid',
      reason: 'booking_paid_requires_staff',
      payment_status: booking.payment_status,
      booking_id: booking.booking_id,
      booking_code: booking.booking_code,
    };
  }

  const currentGuestCount = Number(booking.guest_count) || 0;
  const newGuestCount = currentGuestCount + addedCount;

  const requoteOpts = {
    clientSlug,
    locationId: o.locationId || null,
    checkIn: o.checkIn || booking.check_in,
    checkOut: o.checkOut || booking.check_out,
    packageCode: o.packageCode || booking.package_code || 'no_package',
    roomType: o.roomType || 'shared',
  };

  // Availability guard — a bed must exist for the extra guest(s) on the same dates.
  const availabilityChecker = typeof o.availabilityChecker === 'function'
    ? o.availabilityChecker
    : confirmAddedGuestAvailability;
  const availability = await availabilityChecker(pg, requoteOpts, newGuestCount);
  if (!availability.available) {
    return {
      ...base,
      status: 'no_availability',
      reason: 'no_availability_for_added_guest',
      availability_status: availability.status,
      booking_id: booking.booking_id,
      booking_code: booking.booking_code,
    };
  }

  const requote = computeAccommodationDelta(requoteOpts, currentGuestCount, addedCount);
  if (!requote.ok) {
    return {
      ...base,
      status: 'requote_failed',
      reason: 'requote_failed',
      booking_id: booking.booking_id,
      booking_code: booking.booking_code,
    };
  }

  const oldTotalCents = Number(booking.total_amount_cents) || 0;
  const amountPaidCents = Number(booking.amount_paid_cents) || 0;
  const newTotalCents = oldTotalCents + requote.delta_cents;
  const newBalanceDueCents = Math.max(0, newTotalCents - amountPaidCents);
  const newGuestName = appendGuestName(booking.guest_name, newGuestNames);

  // Respect the env gate. Without it (or without a live gate) we compute the snapshot
  // but do NOT write — same posture as the addon-service attach path.
  if (!isOpenDemoBookingWritesEnabled(env)) {
    return {
      ...base,
      status: 'gated',
      reason: 'booking_writes_disabled',
      booking_id: booking.booking_id,
      booking_code: booking.booking_code,
      old_guest_count: currentGuestCount,
      new_guest_count: newGuestCount,
      old_total_amount_cents: oldTotalCents,
      new_total_amount_cents: newTotalCents,
      new_balance_due_cents: newBalanceDueCents,
      accommodation_delta_cents: requote.delta_cents,
      guest_name: newGuestName,
    };
  }

  await pg.query(
    `UPDATE bookings b
        SET guest_count = $3,
            guest_name = $4,
            total_amount_cents = $5,
            balance_due_cents = $6,
            metadata = COALESCE(b.metadata, '{}'::jsonb) || $7::jsonb
       FROM clients c
      WHERE b.client_id = c.id
        AND c.slug = $1
        AND b.id::text = $2`,
    [
      clientSlug,
      booking.booking_id,
      newGuestCount,
      newGuestName,
      newTotalCents,
      newBalanceDueCents,
      JSON.stringify({
        add_guest_origin: ADD_GUEST_ATTACH_ORIGIN,
        added_guest_names: newGuestNames,
        add_guest_write_source: base.add_guest_write_source,
      }),
    ],
  );

  const insertedGuests = [];
  for (let i = 0; i < newGuestNames.length; i += 1) {
    const guestNumber = currentGuestCount + i + 1;
    const r = await pg.query(
      `INSERT INTO booking_guests (
         client_id, booking_id, guest_number, guest_name,
         assigned_room_code, assigned_bed_code,
         deposit_amount_cents, amount_paid_cents, payment_status, metadata
       ) VALUES (
         $1, $2::uuid, $3, $4, NULL, NULL, 0, 0, 'not_requested', $5::jsonb
       )
       RETURNING id::text AS booking_guest_id, guest_number, guest_name, payment_status`,
      [
        booking.client_id,
        booking.booking_id,
        guestNumber,
        newGuestNames[i],
        JSON.stringify({
          source: ADD_GUEST_ATTACH_ORIGIN,
          add_guest_write_source: base.add_guest_write_source,
        }),
      ],
    );
    insertedGuests.push(r.rows[0]);
  }

  // Refresh the pay-in-full draft so the re-sent link charges the NEW total (€435), not
  // the stale €300 draft. Threaded back to create_payment_link via payment_draft_id.
  const refreshedDraft = await refreshFullPaymentDraftAmount(
    pg, clientSlug, booking.booking_id, newTotalCents,
  );

  return {
    ...base,
    status: 'ok',
    booking_id: booking.booking_id,
    booking_code: booking.booking_code,
    old_guest_count: currentGuestCount,
    new_guest_count: newGuestCount,
    old_total_amount_cents: oldTotalCents,
    new_total_amount_cents: newTotalCents,
    new_balance_due_cents: newBalanceDueCents,
    accommodation_delta_cents: requote.delta_cents,
    guest_name: newGuestName,
    inserted_booking_guests: insertedGuests,
    payment_draft_id: refreshedDraft ? refreshedDraft.payment_draft_id : null,
    payment_draft_amount_due_cents: refreshedDraft ? Number(refreshedDraft.amount_due_cents) : null,
  };
}

module.exports = {
  ADD_GUEST_WRITE_SOURCE,
  ADD_GUEST_ATTACH_ORIGIN,
  PAID_BOOKING_PAYMENT_STATUSES,
  isPaidBookingPaymentStatus,
  normalizeNewGuestNames,
  buildQuoteFields,
  computeAccommodationDelta,
  confirmAddedGuestAvailability,
  refreshFullPaymentDraftAmount,
  addGuestToBooking,
};
