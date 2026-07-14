'use strict';

/**
 * Accommodation vertical adapter — thin delegation to proven Wolfhouse
 * quote, package, availability, and dry-run booking paths (Slice 7).
 */

const {
  WOLFHOUSE_CLIENT_SLUG,
  executeWolfhouseAccommodationListOfferings,
  executeWolfhouseAccommodationQuote,
  evaluateWolfhouseAccommodationDates,
  executeWolfhouseAccommodationAvailability,
  executeWolfhouseAccommodationCreate,
} = require('../wolfhouse-accommodation-application');
const { BOOKING_CREATE_CHANNELS } = require('../luna-front-desk-accommodation-booking-create-service');
const {
  VERTICAL_IDS,
  VERTICAL_CHANNELS,
  assertResolvedVerticalScope,
} = require('../luna-front-desk-vertical-scope');

function mapBookingChannel(channel) {
  const c = String(channel || '').trim();
  if (c === VERTICAL_CHANNELS.MANUAL_STAFF) return BOOKING_CREATE_CHANNELS.MANUAL_STAFF;
  return BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP;
}

function scopeFailure(scope) {
  return {
    ok: false,
    status: scope.status || 403,
    body: {
      success: false,
      ok: false,
      reason: scope.reason,
      reason_code: scope.reason_code || scope.reason,
      vertical_id: scope.vertical_id || VERTICAL_IDS.ACCOMMODATION,
    },
  };
}

const accommodationVerticalAdapter = {
  verticalId: VERTICAL_IDS.ACCOMMODATION,
  supportedClientSlug: WOLFHOUSE_CLIENT_SLUG,

  async listOfferings(_pg, request = {}) {
    const scope = assertResolvedVerticalScope(request.resolved, VERTICAL_IDS.ACCOMMODATION);
    if (!scope.ok) return scopeFailure(scope);
    return executeWolfhouseAccommodationListOfferings(request.transportBody || {}, {
      config: request.config,
    });
  },

  async quoteOffering(_pg, request = {}) {
    const scope = assertResolvedVerticalScope(request.resolved, VERTICAL_IDS.ACCOMMODATION);
    if (!scope.ok) return scopeFailure(scope);
    return executeWolfhouseAccommodationQuote(request.transportBody || {}, {
      config: request.config,
      payment_choice: request.channel === 'manual_staff' ? undefined : undefined,
    });
  },

  async createBooking(pg, request = {}) {
    const scope = assertResolvedVerticalScope(request.resolved, VERTICAL_IDS.ACCOMMODATION);
    if (!scope.ok) return scopeFailure(scope);
    return executeWolfhouseAccommodationCreate(pg, request.transportBody || {}, {
      channel: mapBookingChannel(request.channel),
      actorHints: request.actorHints || {},
      dryRunOnly: false,
      stripeConfig: request.stripeConfig,
      privateRoomHooks: request.privateRoomHooks,
      actorLabel: request.actorLabel,
    });
  },

  evaluateDates(request = {}) {
    const scope = assertResolvedVerticalScope(request.resolved, VERTICAL_IDS.ACCOMMODATION);
    if (!scope.ok) {
      return {
        ok: false,
        reason: scope.reason,
        reason_code: scope.reason_code || scope.reason,
      };
    }
    const body = {
      ...(request.transportBody || {}),
      check_in: request.check_in || (request.transportBody && request.transportBody.check_in),
      check_out: request.check_out || (request.transportBody && request.transportBody.check_out),
      package_code: request.package_code
        || (request.transportBody && request.transportBody.package_code)
        || request.package_interest,
      service_dates: request.serviceDates || request.service_dates,
    };
    return evaluateWolfhouseAccommodationDates(body);
  },

  async checkAvailability(pg, request = {}) {
    const scope = assertResolvedVerticalScope(request.resolved, VERTICAL_IDS.ACCOMMODATION);
    if (!scope.ok) return scopeFailure(scope);
    return executeWolfhouseAccommodationAvailability(pg, request.transportBody || {});
  },
};

module.exports = {
  accommodationVerticalAdapter,
};
