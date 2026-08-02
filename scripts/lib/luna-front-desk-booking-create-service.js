'use strict';

/**
 * Luna Front Desk — canonical Sunset booking-create application service.
 *
 * Single write use case shared by Staff manual schedule create and Luna bot
 * booking-create. Routes authenticate, apply transport-only gates, build a
 * trusted command, call executeSunsetBookingCreate, and map the HTTP response.
 *
 * See docs/LUNA-FRONT-DESK-DOMAIN-CONTRACT.md §3–§4.
 */

const { normalizeSunsetBookingDatesInBody } = require('./sunset-guest-date-intake');
const {
  createSunsetScheduleBooking,
  resolveScheduleBookingAttribution,
  SUNSET_CLIENT_SLUG,
} = require('./sunset-schedule-booking-writes');
const { priceSunsetBookingAfterCreate } = require('./sunset-stripe-payment-links');
const {
  rejectClientSuppliedMoney,
} = require('./luna-front-desk-quote-service');
const { staffFacingSunsetPriceError } = require('./sunset-course-lesson-price-lookup');
const {
  normalizeSunsetLocationId,
  isSunsetLocationId,
} = require('./sunset-school-locations');

const BOOKING_CREATE_CHANNELS = Object.freeze({
  MANUAL_STAFF: 'manual_staff',
  LUNA_WHATSAPP: 'luna_whatsapp',
});

function resolveActorForChannel(channel, actorHints) {
  const hints = actorHints && typeof actorHints === 'object' ? actorHints : {};
  if (channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP) {
    return { source: 'agent_luna_whatsapp_bot' };
  }
  if (channel === BOOKING_CREATE_CHANNELS.MANUAL_STAFF) {
    return {
      staff_user_id: hints.staff_user_id || null,
      email: hints.email || null,
    };
  }
  return null;
}

/**
 * Build a trusted command from transport input. Does not trust body tenant or
 * location — caller supplies trustedLocationId from auth-scoped route context.
 */
function buildSunsetBookingCreateCommand(opts) {
  const channel = String((opts && opts.channel) || '').trim();
  if (!Object.values(BOOKING_CREATE_CHANNELS).includes(channel)) {
    return { ok: false, status: 400, body: { success: false, reason_code: 'invalid_channel', error: 'invalid booking create channel' } };
  }
  const actor = resolveActorForChannel(channel, opts && opts.actorHints);
  if (!actor) {
    return { ok: false, status: 400, body: { success: false, reason_code: 'invalid_channel', error: 'invalid booking create channel' } };
  }
  const rawLoc = opts && opts.trustedLocationId;
  const locationId = normalizeSunsetLocationId(rawLoc);
  if (rawLoc != null && String(rawLoc).trim() && !isSunsetLocationId(rawLoc)) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        reason_code: 'unknown_location',
        error: 'unknown location',
        location_id: String(rawLoc).trim(),
      },
    };
  }
  return {
    ok: true,
    command: {
      channel,
      clientSlug: SUNSET_CLIENT_SLUG,
      locationId,
      transportBody: (opts && opts.transportBody) || {},
      actor,
      now: (opts && opts.now) instanceof Date ? opts.now : new Date(),
    },
  };
}

function mapBookingCreateFailure(result) {
  const rawErr = (result.body && (result.body.reason_code || result.body.error)) || 'write_failed';
  if (/no_price_for_|tier_key|course_tier|price_not_configured|service_dates_not_on_course_schedule|course_full|unknown_course_id/i.test(String(rawErr))
    || (result.body && result.body.reason_code)) {
    const faced = staffFacingSunsetPriceError(rawErr);
    return {
      ok: false,
      status: result.status || 422,
      body: {
        success: false,
        error: (result.body && result.body.error) || faced.error,
        reason_code: (result.body && result.body.reason_code) || faced.reason_code,
        ...(result.body && result.body.detail ? { detail: result.body.detail } : {}),
        ...(result.body && result.body.course_id ? { course_id: result.body.course_id } : {}),
      },
    };
  }
  return {
    ok: false,
    status: result.status || 400,
    body: { ...result.body, success: false },
  };
}

function mapPricingFailure(priced, bookingId) {
  const faced = staffFacingSunsetPriceError((priced && priced.error) || 'pricing_failed');
  return {
    ok: false,
    status: 422,
    body: {
      success: false,
      error: faced.error,
      reason_code: faced.reason_code,
      booking_id: bookingId,
      booking_cancelled: !!(priced && priced.booking_cancelled),
    },
  };
}

/**
 * Execute booking create inside an existing pg client transaction scope.
 *
 * @param {object} pg
 * @param {object} command — output of buildSunsetBookingCreateCommand().command
 */
async function executeSunsetBookingCreate(pg, command) {
  if (!command || command.clientSlug !== SUNSET_CLIENT_SLUG) {
    return {
      ok: false,
      status: 403,
      body: { success: false, error: 'unsupported_client', reason_code: 'tenant_mismatch' },
    };
  }

  const dateNorm = normalizeSunsetBookingDatesInBody(command.transportBody, command.now);
  if (!dateNorm.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        error: dateNorm.reason || 'invalid_date',
        reason_code: dateNorm.reason || 'invalid_date',
        needs_clarification: dateNorm.needs_clarification === true,
      },
    };
  }

  const moneyCheck = rejectClientSuppliedMoney(dateNorm.body);
  if (!moneyCheck.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        error: 'client-supplied money fields are not allowed',
        reason_code: 'client_money_rejected',
        field: moneyCheck.field,
      },
    };
  }

  // Lane-aware provenance revalidation + fingerprint compare run exactly once
  // inside createSunsetScheduleBooking → resolveAuthoritativeScheduleQuoteInTxn
  // (quote_lane selects exact_offering vs components). Always pass provenance
  // for course, rental, and mixed creates — never drop it for non-rental only.
  const provenance = command.transportBody.quote_provenance || command.transportBody.quoteProvenance;

  const result = await createSunsetScheduleBooking(pg, {
    clientSlug: SUNSET_CLIENT_SLUG,
    body: dateNorm.body,
    locationId: command.locationId,
    actor: command.actor,
    now: command.now,
    quoteProvenance: provenance && typeof provenance === 'object' ? provenance : null,
    quoteChannel: command.channel,
  });

  if (!result.ok) {
    return mapBookingCreateFailure(result);
  }

  const attribution = resolveScheduleBookingAttribution(command.actor);
  let bodyOut = {
    ...result.body,
    success: true,
    client_slug: SUNSET_CLIENT_SLUG,
    location_id: command.locationId,
    channel: command.channel,
    attribution: {
      db_source: attribution.dbSource,
      metadata_source: attribution.metadataSource,
      staff_manual_schedule: attribution.staffManualSchedule,
      luna_guest_booking: attribution.lunaGuestBooking,
      created_by_staff: attribution.createdByStaff,
      actor_source: attribution.actorSource,
    },
  };

  const bookingId = bodyOut.booking_id || (bodyOut.booking && bodyOut.booking.booking_id);
  if (bookingId && !(bodyOut.total_cents > 0) && bodyOut.idempotent !== true) {
    const priced = await priceSunsetBookingAfterCreate(pg, SUNSET_CLIENT_SLUG, bookingId);
    if (!priced || !priced.ok) {
      return mapPricingFailure(priced, bookingId);
    }
    bodyOut.total_cents = priced.total_cents;
    bodyOut.currency = 'EUR';
  } else if (bodyOut.total_cents > 0 && !bodyOut.currency) {
    bodyOut.currency = 'EUR';
  }

  return {
    ok: true,
    status: result.status,
    body: bodyOut,
  };
}

module.exports = {
  BOOKING_CREATE_CHANNELS,
  buildSunsetBookingCreateCommand,
  executeSunsetBookingCreate,
  resolveActorForChannel,
  mapBookingCreateFailure,
};
