'use strict';

/**
 * Surf-school vertical adapter — thin delegation to proven Slice 3–5 application
 * services. No business-rule duplication.
 */

const {
  CATALOG_CHANNELS,
  buildSunsetCatalogCommand,
  executeSunsetCatalog,
  executeSunsetCatalogSync,
} = require('../luna-front-desk-catalog-service');
const {
  QUOTE_CHANNELS,
  buildSunsetQuoteCommand,
  executeSunsetQuote,
  executeSunsetQuoteSync,
} = require('../luna-front-desk-quote-service');
const {
  BOOKING_CREATE_CHANNELS,
  buildSunsetBookingCreateCommand,
  executeSunsetBookingCreate,
} = require('../luna-front-desk-booking-create-service');
const { evaluateSunsetOfferingDates } = require('../sunset-offering-schedule');
const { assertCourseAssignable } = require('../sunset-admin-course-join');
const { SUNSET_CLIENT_SLUG } = require('../sunset-bookable-offerings');
const {
  VERTICAL_IDS,
  VERTICAL_CHANNELS,
  assertResolvedVerticalScope,
} = require('../luna-front-desk-vertical-scope');

const ACCOMMODATION_TRANSPORT_KEYS = Object.freeze([
  'check_in',
  'check_out',
  'package_code',
  'package_interest',
  'guest_count',
  'room_type',
  'room_preference',
  'selected_bed_codes',
  'bed_code',
  'gender_preference',
  'group_gender',
  'guest_packages',
  'manual_price_per_night_cents',
  'manual_price_per_night_euros',
]);

function rejectAccommodationTransportFields(transportBody) {
  const body = transportBody && typeof transportBody === 'object' ? transportBody : {};
  const found = ACCOMMODATION_TRANSPORT_KEYS.filter((k) => {
    const v = body[k];
    if (v == null || v === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  });
  if (found.length > 0) {
    return {
      ok: false,
      status: 422,
      body: {
        success: false,
        ok: false,
        reason: 'accommodation_fields_not_supported',
        reason_code: 'accommodation_fields_not_supported',
        vertical_id: VERTICAL_IDS.SURF_SCHOOL,
        fields: found,
      },
    };
  }
  return { ok: true };
}

function mapCatalogChannel(channel) {
  const c = String(channel || '').trim();
  if (c === VERTICAL_CHANNELS.SCHEDULE) return CATALOG_CHANNELS.SCHEDULE;
  if (c === VERTICAL_CHANNELS.MANUAL_STAFF) return CATALOG_CHANNELS.MANUAL_STAFF;
  return CATALOG_CHANNELS.LUNA_WHATSAPP;
}

function mapQuoteChannel(channel) {
  const c = String(channel || '').trim();
  if (c === VERTICAL_CHANNELS.MANUAL_STAFF) return QUOTE_CHANNELS.MANUAL_STAFF;
  return QUOTE_CHANNELS.LUNA_WHATSAPP;
}

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
      vertical_id: scope.vertical_id || VERTICAL_IDS.SURF_SCHOOL,
    },
  };
}

const surfSchoolVerticalAdapter = {
  verticalId: VERTICAL_IDS.SURF_SCHOOL,
  supportedClientSlug: SUNSET_CLIENT_SLUG,

  async listOfferings(pg, request = {}) {
    const scope = assertResolvedVerticalScope(request.resolved, VERTICAL_IDS.SURF_SCHOOL);
    if (!scope.ok) return scopeFailure(scope);
    const rejected = rejectAccommodationTransportFields(request.transportBody);
    if (!rejected.ok) return rejected;
    const built = buildSunsetCatalogCommand({
      channel: mapCatalogChannel(request.channel),
      trustedLocationId: request.resolved.locationId,
      transportBody: request.transportBody || {},
    });
    if (!built.ok) return { ok: false, status: built.status, body: built.body };
    if (pg) {
      return executeSunsetCatalog(pg, built.command, { adminCfg: request.adminCfg });
    }
    return executeSunsetCatalogSync(built.command, { adminCfg: request.adminCfg });
  },

  async quoteOffering(pg, request = {}) {
    const scope = assertResolvedVerticalScope(request.resolved, VERTICAL_IDS.SURF_SCHOOL);
    if (!scope.ok) return scopeFailure(scope);
    const rejected = rejectAccommodationTransportFields(request.transportBody);
    if (!rejected.ok) return rejected;
    const built = buildSunsetQuoteCommand({
      channel: mapQuoteChannel(request.channel),
      trustedLocationId: request.resolved.locationId,
      transportBody: request.transportBody || {},
    });
    if (!built.ok) return { ok: false, status: built.status, body: built.body };
    if (pg) {
      return executeSunsetQuote(pg, built.command, { adminCfg: request.adminCfg });
    }
    return executeSunsetQuoteSync(built.command, { adminCfg: request.adminCfg });
  },

  async createBooking(pg, request = {}) {
    const scope = assertResolvedVerticalScope(request.resolved, VERTICAL_IDS.SURF_SCHOOL);
    if (!scope.ok) return scopeFailure(scope);
    const rejected = rejectAccommodationTransportFields(request.transportBody);
    if (!rejected.ok) return rejected;
    if (!pg) {
      return {
        ok: false,
        status: 500,
        body: { success: false, reason: 'database_required', reason_code: 'database_required' },
      };
    }
    const built = buildSunsetBookingCreateCommand({
      channel: mapBookingChannel(request.channel),
      trustedLocationId: request.resolved.locationId,
      transportBody: request.transportBody || {},
      actorHints: request.actorHints || {},
    });
    if (!built.ok) return { ok: false, status: built.status, body: built.body };
    return executeSunsetBookingCreate(pg, built.command);
  },

  evaluateDates(request = {}) {
    const scope = assertResolvedVerticalScope(request.resolved, VERTICAL_IDS.SURF_SCHOOL);
    if (!scope.ok) {
      return {
        ok: false,
        reason: scope.reason,
        reason_code: scope.reason_code || scope.reason,
      };
    }
    const offering = request.offering || request.schedule || {};
    const dates = request.serviceDates || request.service_dates || [];
    return evaluateSunsetOfferingDates(offering, dates, request.options || {});
  },

  async checkAvailability(pg, request = {}) {
    const scope = assertResolvedVerticalScope(request.resolved, VERTICAL_IDS.SURF_SCHOOL);
    if (!scope.ok) return scopeFailure(scope);
    const rejected = rejectAccommodationTransportFields(request.transportBody);
    if (!rejected.ok) return rejected;
    const transportBody = {
      ...(request.transportBody || {}),
      include_capacity: true,
      joinable: true,
      courses_only: true,
      require_db: request.transportBody && request.transportBody.require_db != null
        ? request.transportBody.require_db
        : true,
    };
    const date = transportBody.date || (Array.isArray(transportBody.service_dates) && transportBody.service_dates[0]);
    if (date && !transportBody.service_dates) {
      transportBody.service_dates = [String(date).slice(0, 10)];
    }
    const built = buildSunsetCatalogCommand({
      channel: CATALOG_CHANNELS.LUNA_WHATSAPP,
      trustedLocationId: request.resolved.locationId,
      transportBody,
    });
    if (!built.ok) return { ok: false, status: built.status, body: built.body };
    const catalogResult = await executeSunsetCatalog(pg, built.command, { adminCfg: request.adminCfg });
    if (!catalogResult.ok) return catalogResult;
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        success: true,
        client_slug: SUNSET_CLIENT_SLUG,
        location_id: request.resolved.locationId,
        date: date ? String(date).slice(0, 10) : null,
        courses: catalogResult.body.courses || [],
        group_lessons: catalogResult.body.group_lessons || [],
        source_tables: [
          'tenant_surf_pack_rules',
          'tenant_price_rules',
          'booking_service_records',
        ],
      },
    };
  },

  async assertCourseAssignable(pg, request = {}) {
    const scope = assertResolvedVerticalScope(request.resolved, VERTICAL_IDS.SURF_SCHOOL);
    if (!scope.ok) return scopeFailure(scope);
    return assertCourseAssignable(pg, {
      clientSlug: SUNSET_CLIENT_SLUG,
      locationId: request.resolved.locationId,
      courseId: request.courseId,
      serviceDates: request.serviceDates || request.service_dates,
      quantity: request.quantity,
    });
  },
};

module.exports = {
  surfSchoolVerticalAdapter,
  ACCOMMODATION_TRANSPORT_KEYS,
  rejectAccommodationTransportFields,
};
