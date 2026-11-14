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
 *      wolfhouse quote engine (runBookingPreviewDryRun). Seasons are resolved the
 *      same way authoritative Pricing does: month_numbers expand into ranges, and
 *      explicit season ranges are kept. The per-guest delta is added to the total.
 *   4. Updates the booking (guest_count, guest_name, total_amount_cents,
 *      balance_due_cents, metadata) and inserts one booking_guests row per new guest.
 *      A requote that still cannot price the stay does not block that save: the
 *      guest is written and the price is flagged for staff review.
 *
 * All DB writes respect the existing env gate (isOpenDemoBookingWritesEnabled) and are
 * no-ops without pg.
 */

const { runBookingPreviewDryRun } = require('./luna-guest-booking-dry-run');
const { isOpenDemoBookingWritesEnabled } = require('./open-demo-whatsapp-gate');
const { configSeasons, loadPricingConfig } = require('./wolfhouse-pricing-resolve');

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

/**
 * Slice 2 — PAID top-up flag. When ON, adding a guest to a PAID / deposit_paid booking
 * proceeds with the same booking mutation as the unpaid path but charges only the delta
 * (the new guest's share) via the balance payment link, instead of handing off to staff.
 * Default OFF → paid bookings keep the Slice 1 handoff.
 */
function isAddGuestPaidEnabled(env) {
  const e = env || process.env;
  return String(e.LUNA_GUEST_ADD_GUEST_PAID_ENABLED || '').toLowerCase() === 'true';
}

function normalizeNewGuestNames(input) {
  if (Array.isArray(input)) {
    return input.map((n) => trimStr(n)).filter(Boolean);
  }
  const single = trimStr(input);
  return single ? [single] : [];
}

/**
 * Copy explicit season ranges. Authoritative Pricing rows store these;
 * resolveSeasonForDate matches them and ignores month_numbers.
 */
function explicitSeasonRanges(season) {
  if (!season || !Array.isArray(season.ranges)) return [];
  const out = [];
  for (const range of season.ranges) {
    if (!range) continue;
    const startMonth = Number(range.start_month);
    const startDay = Number(range.start_day);
    const endMonth = Number(range.end_month);
    const endDay = Number(range.end_day);
    if (![startMonth, startDay, endMonth, endDay].every((n) => Number.isInteger(n))) continue;
    out.push({
      start_month: startMonth,
      start_day: startDay,
      end_month: endMonth,
      end_day: endDay,
    });
  }
  return out;
}

/**
 * Seasons the quote engine can resolve. configSeasons is the authoritative
 * expansion of JSON month_numbers into full-month ranges. Explicit ranges are
 * kept as well, so a DB season and a month_numbers seed both cover their dates.
 */
function seasonsResolvedLikeAuthoritativePricing(seasons) {
  const list = Array.isArray(seasons) ? seasons : [];
  return list.map((season, index) => {
    const source = season && typeof season === 'object' ? season : {};
    const shaped = configSeasons({ seasons: [source] })[0];
    return {
      code: shaped.code,
      label: source.label ? String(source.label) : shaped.label,
      priority: Number(source.priority) || 0,
      bookable: source.bookable !== false,
      active: source.active !== false,
      sort_order: source.sort_order != null ? Number(source.sort_order) : index,
      source: source.source || shaped.source || 'config',
      ranges: explicitSeasonRanges(source).concat(shaped.ranges || []),
    };
  });
}

function pricingConfigForAddGuestQuote(opts) {
  const o = opts || {};
  const base = o.pricingConfig || loadPricingConfig();
  return {
    ...base,
    seasons: seasonsResolvedLikeAuthoritativePricing(base.seasons),
  };
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
    quote_config: pricingConfigForAddGuestQuote(o),
  };
}

function accommodationQuote(quoteFields) {
  const preview = runBookingPreviewDryRun(quoteFields);
  const quote = preview && preview.quote;
  if (!quote || quote.success !== true || !Number.isFinite(Number(quote.total_cents))) {
    const blockers = quote && Array.isArray(quote.blockers) ? quote.blockers.filter(Boolean) : [];
    const reason = blockers.length
      ? blockers.join('; ')
      : (preview && preview.quote_error) || 'quote_unavailable';
    return { ok: false, total_cents: null, reason: String(reason) };
  }
  return { ok: true, total_cents: Number(quote.total_cents), reason: null };
}

/**
 * Requote: return the per-guest accommodation delta for adding `addedCount` guests
 * to the same dates, plus the old/new accommodation totals.
 */
function computeAccommodationDelta(opts, currentGuestCount, addedCount) {
  const oldFields = buildQuoteFields(opts, currentGuestCount);
  const newFields = buildQuoteFields(opts, currentGuestCount + addedCount);
  const oldQuote = accommodationQuote(oldFields);
  const newQuote = accommodationQuote(newFields);
  if (!oldQuote.ok || !newQuote.ok) {
    return {
      ok: false,
      old_accommodation_cents: oldQuote.total_cents,
      new_accommodation_cents: newQuote.total_cents,
      delta_cents: null,
      reason: !newQuote.ok ? newQuote.reason : oldQuote.reason,
    };
  }
  return {
    ok: true,
    old_accommodation_cents: oldQuote.total_cents,
    new_accommodation_cents: newQuote.total_cents,
    delta_cents: newQuote.total_cents - oldQuote.total_cents,
    reason: null,
  };
}

/**
 * Availability guard — confirm a bed exists for the requested party size on the same dates.
 * Uses the bed-calendar dry-run directly (post-booking add-guest already has dates/count).
 */
async function confirmAddedGuestAvailability(pg, opts, newGuestCount) {
  const o = opts || {};
  if (!pg) {
    return { available: false, status: 'no_pg', detail: null };
  }
  const { runAvailabilityCheckDryRun } = require('./luna-guest-booking-dry-run');
  const raw = await runAvailabilityCheckDryRun({
    client_slug: trimStr(o.clientSlug) || 'wolfhouse-somo',
    check_in: o.checkIn || null,
    check_out: o.checkOut || null,
    guest_count: Number(newGuestCount),
    package_code: o.packageCode || 'no_package',
    room_type: trimStr(o.roomType) || 'shared',
  }, pg);
  if (!raw || raw.skipped) {
    return {
      available: false,
      status: raw && raw.reason ? 'needs_staff_review' : 'not_ready',
      detail: raw,
    };
  }
  return {
    available: raw.has_enough_beds === true,
    status: raw.has_enough_beds ? 'available' : 'unavailable',
    detail: raw,
  };
}

async function loadBooking(pg, clientSlug, bookingId, bookingCode) {
  const bySlug = trimStr(clientSlug) || 'wolfhouse-somo';
  if (bookingId) {
    const r = await pg.query(
      `SELECT b.id::text AS booking_id, b.booking_code, b.client_id::text AS client_id,
              b.guest_count, b.guest_name,
              b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents,
              NULLIF(to_jsonb(b)->>'deposit_required_cents','')::int AS deposit_required_cents,
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
              NULLIF(to_jsonb(b)->>'deposit_required_cents','')::int AS deposit_required_cents,
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

/** Integer room share + deposit for an added guest so per-guest checkout can price a link. */
function addedGuestMoney(deltaCents, addedCount, index, booking) {
  const count = Number(addedCount) || 0;
  if (!Number.isInteger(deltaCents) || deltaCents < 0 || count < 1) {
    return { subtotal_cents: 0, deposit_amount_cents: 0 };
  }
  const baseShare = Math.floor(deltaCents / count);
  const subtotal = index === count - 1 ? deltaCents - baseShare * (count - 1) : baseShare;
  const bookingDeposit = Number(booking && booking.deposit_required_cents);
  const origCount = Number(booking && booking.guest_count) || 0;
  let deposit = 0;
  if (Number.isInteger(bookingDeposit) && bookingDeposit >= 0 && origCount > 0) {
    deposit = Math.min(subtotal, Math.max(0, Math.floor(bookingDeposit / origCount)));
  }
  return { subtotal_cents: subtotal, deposit_amount_cents: deposit };
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

  // Slice 2 — a paid / partially paid booking. When the paid top-up flag is OFF, this stays
  // a staff handoff (Slice 1 defense in depth; readiness blocks too). When ON, we fall
  // through and mutate the booking, then charge only the delta via the balance link.
  const bookingIsPaid = isPaidBookingPaymentStatus(booking.payment_status);
  if (bookingIsPaid && !isAddGuestPaidEnabled(env)) {
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
    pricingConfig: o.pricingConfig || null,
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

  const requote = o.pricingUnavailableReason
    ? { ok: false, delta_cents: null, reason: o.pricingUnavailableReason }
    : computeAccommodationDelta(requoteOpts, currentGuestCount, addedCount);
  // A guest who already agreed is saved even when Pricing cannot price the stay.
  // Staff see the flag; the missing price must not become requote_failed with no write.
  const priceNeedsStaffReview = requote.ok !== true;
  const priceReviewReason = priceNeedsStaffReview ? (requote.reason || 'requote_unresolved') : null;

  const oldTotalCents = Number(booking.total_amount_cents) || 0;
  const amountPaidCents = Number(booking.amount_paid_cents) || 0;
  const deltaCents = priceNeedsStaffReview ? null : requote.delta_cents;
  const newTotalCents = priceNeedsStaffReview ? oldTotalCents : oldTotalCents + deltaCents;
  const newBalanceDueCents = priceNeedsStaffReview
    ? (booking.balance_due_cents == null
      ? Math.max(0, oldTotalCents - amountPaidCents)
      : Math.max(0, Number(booking.balance_due_cents) || 0))
    : Math.max(0, newTotalCents - amountPaidCents);
  const newGuestName = appendGuestName(booking.guest_name, newGuestNames);
  const paidTopup = bookingIsPaid && isAddGuestPaidEnabled(env);
  const pricedTopupCents = paidTopup && !priceNeedsStaffReview ? newBalanceDueCents : null;

  const previewSnapshot = {
    ...base,
    booking_id: booking.booking_id,
    booking_code: booking.booking_code,
    old_guest_count: currentGuestCount,
    new_guest_count: newGuestCount,
    old_total_amount_cents: oldTotalCents,
    new_total_amount_cents: newTotalCents,
    new_balance_due_cents: newBalanceDueCents,
    amount_paid_cents: amountPaidCents,
    accommodation_delta_cents: deltaCents,
    price_needs_staff_review: priceNeedsStaffReview,
    price_review_reason: priceReviewReason,
    guest_name: newGuestName,
    paid_topup: paidTopup,
    payment_status: booking.payment_status,
  };

  if (o.previewOnly === true) {
    return {
      ...previewSnapshot,
      status: 'ok',
      preview_only: true,
      no_write_performed: true,
      topup_amount_cents: pricedTopupCents,
    };
  }

  // Respect the env gate. Without it (or without a live gate) we compute the snapshot
  // but do NOT write — same posture as the addon-service attach path.
  if (!isOpenDemoBookingWritesEnabled(env)) {
    return {
      ...previewSnapshot,
      status: 'gated',
      reason: 'booking_writes_disabled',
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
        ...(priceNeedsStaffReview ? {
          add_guest_price_needs_staff_review: true,
          add_guest_price_review_reason: priceReviewReason,
        } : {}),
      }),
    ],
  );

  const insertedGuests = [];
  for (let i = 0; i < newGuestNames.length; i += 1) {
    const guestNumber = currentGuestCount + i + 1;
    const money = addedGuestMoney(deltaCents, addedCount, i, booking);
    const r = await pg.query(
      `INSERT INTO booking_guests (
         client_id, booking_id, guest_number, guest_name,
         assigned_room_code, assigned_bed_code,
         deposit_amount_cents, amount_paid_cents, payment_status, metadata
       ) VALUES (
         $1, $2::uuid, $3, $4, NULL, NULL, $5, 0, 'not_requested', $6::jsonb
       )
       RETURNING id::text AS booking_guest_id, guest_number, guest_name, payment_status`,
      [
        booking.client_id,
        booking.booking_id,
        guestNumber,
        newGuestNames[i],
        money.deposit_amount_cents,
        JSON.stringify({
          source: ADD_GUEST_ATTACH_ORIGIN,
          ...(o.deferPayment === true ? { payment_collection_scope: 'added_guest_only' } : {}),
          add_guest_write_source: base.add_guest_write_source,
          // Zero in the required deposit column is only a storage placeholder.
          // Omit unknown share authority so checkout cannot interpret it as free.
          ...(!priceNeedsStaffReview ? { subtotal_cents: money.subtotal_cents } : {}),
          ...(priceNeedsStaffReview ? {
            add_guest_price_needs_staff_review: true,
            add_guest_price_review_reason: priceReviewReason,
          } : {}),
        }),
      ],
    );
    insertedGuests.push(r.rows[0]);
  }

  // Slice 2 — PAID booking top-up: the already-paid full_amount draft stays as-is (do NOT
  // refresh it). balance_due_cents (newTotal − amountPaid) is the delta for the new guest;
  // the follow-on create_balance_payment_link derives the top-up charge from the booking.
  if (paidTopup) {
    return {
      ...base,
      status: 'ok',
      paid_topup: true,
      payment_status: booking.payment_status,
      booking_id: booking.booking_id,
      booking_code: booking.booking_code,
      old_guest_count: currentGuestCount,
      new_guest_count: newGuestCount,
      old_total_amount_cents: oldTotalCents,
      new_total_amount_cents: newTotalCents,
      new_balance_due_cents: newBalanceDueCents,
      amount_paid_cents: amountPaidCents,
      accommodation_delta_cents: deltaCents,
      price_needs_staff_review: priceNeedsStaffReview,
      price_review_reason: priceReviewReason,
      guest_name: newGuestName,
      inserted_booking_guests: insertedGuests,
      payment_draft_id: null,
      payment_draft_amount_due_cents: null,
      topup_amount_cents: pricedTopupCents,
    };
  }

  // UNPAID — refresh the pay-in-full draft so the re-sent link charges the NEW total,
  // not the stale draft. Threaded back to create_payment_link via payment_draft_id.
  // An unpriced add does not invent a charge; staff review the flagged price first.
  const refreshedDraft = priceNeedsStaffReview || o.deferPayment === true
    ? null
    : await refreshFullPaymentDraftAmount(pg, clientSlug, booking.booking_id, newTotalCents);

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
    accommodation_delta_cents: deltaCents,
    price_needs_staff_review: priceNeedsStaffReview,
    price_review_reason: priceReviewReason,
    guest_name: newGuestName,
    inserted_booking_guests: insertedGuests,
    payment_draft_id: refreshedDraft ? refreshedDraft.payment_draft_id : null,
    payment_draft_amount_due_cents: refreshedDraft ? Number(refreshedDraft.amount_due_cents) : null,
  };
}

/**
 * Dry-run / golden gate — requote + availability without writes or env write gates.
 */
async function previewAddGuestToBooking(pg, opts) {
  return addGuestToBooking(pg, { ...(opts || {}), previewOnly: true });
}

module.exports = {
  ADD_GUEST_WRITE_SOURCE,
  ADD_GUEST_ATTACH_ORIGIN,
  PAID_BOOKING_PAYMENT_STATUSES,
  isPaidBookingPaymentStatus,
  isAddGuestPaidEnabled,
  normalizeNewGuestNames,
  buildQuoteFields,
  computeAccommodationDelta,
  confirmAddedGuestAvailability,
  refreshFullPaymentDraftAmount,
  addGuestToBooking,
  previewAddGuestToBooking,
};
