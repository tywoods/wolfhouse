'use strict';

/**
 * Wolfhouse accommodation application helpers — thin delegation to proven
 * quote, package, availability, and dry-run booking paths. No business-rule
 * duplication (Slice 7).
 */

const { calculateWolfhouseQuote, loadConfig } = require('./wolfhouse-quote-calculator');
const { computePackagePricePreview } = require('./booking-guests');
const {
  evaluatePackageNightContext,
  validateStaffPackageNightRule,
} = require('./wolfhouse-package-night-rules');
const {
  runAvailabilityCheckDryRun,
  runLunaGuestBookingDryRun,
} = require('./luna-guest-booking-dry-run');
const { resolveBotBookingPackageContext } = require('./bot-booking-package-normalize');
const { resolveQuoteRoomTypeFromPreference } = require('./wolfhouse-room-options');
const { validateAndNormalizeQuoteAddOns } = require('./guest-addon-pricing');
const { VERTICAL_IDS } = require('./luna-front-desk-vertical-scope');

const WOLFHOUSE_CLIENT_SLUG = 'wolfhouse-somo';

const SURF_SCHOOL_TRANSPORT_KEYS = Object.freeze([
  'offering_id',
  'offering_item_code',
  'item_code',
  'course_id',
  'tier_key',
  'service_dates',
  'service_date',
  'components',
  'joinable',
  'courses_only',
  'require_db',
  'location_id',
  'quantity',
  'date',
]);

function rejectSurfSchoolTransportFields(transportBody) {
  const body = transportBody && typeof transportBody === 'object' ? transportBody : {};
  const found = SURF_SCHOOL_TRANSPORT_KEYS.filter((k) => {
    const v = body[k];
    if (v == null || v === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return false;
    return true;
  });
  if (found.length > 0) {
    return {
      ok: false,
      status: 422,
      body: {
        success: false,
        ok: false,
        reason: 'surf_school_fields_not_supported',
        reason_code: 'surf_school_fields_not_supported',
        vertical_id: VERTICAL_IDS.ACCOMMODATION,
        fields: found,
      },
    };
  }
  return { ok: true };
}

function buildWolfhouseAccommodationCatalog(config) {
  const cfg = config || loadConfig();
  const offerings = (cfg.packages || []).map((p) => ({
    package_code: p.code,
    name: p.name,
    price_scope: p.price_scope || null,
    base_room_type: p.base_room_type || 'shared',
    min_nights: 7,
    offering_kind: 'stay_package',
    inclusions: p.inclusions || [],
  }));
  offerings.push({
    package_code: 'accommodation_only',
    name: 'Accommodation only',
    min_nights: 1,
    offering_kind: 'accommodation_only',
  });
  return {
    success: true,
    client_slug: WOLFHOUSE_CLIENT_SLUG,
    vertical_id: VERTICAL_IDS.ACCOMMODATION,
    currency: cfg.currency,
    offerings,
  };
}

function executeWolfhouseAccommodationListOfferings(transportBody, opts = {}) {
  const rejected = rejectSurfSchoolTransportFields(transportBody);
  if (!rejected.ok) return rejected;

  const body = transportBody || {};
  const catalog = buildWolfhouseAccommodationCatalog(opts.config);
  const checkIn = String(body.check_in || '').trim();
  const checkOut = String(body.check_out || '').trim();

  if (checkIn && checkOut) {
    const guestCount = Math.max(1, parseInt(body.guest_count, 10) || 1);
    const roomType = String(body.room_type || 'shared').trim();
    const preview = computePackagePricePreview({
      client_slug: WOLFHOUSE_CLIENT_SLUG,
      check_in: checkIn,
      check_out: checkOut,
      guest_count: guestCount,
      room_type: roomType,
    }, opts.config);
    return {
      ok: true,
      status: 200,
      body: {
        ...catalog,
        check_in: checkIn,
        check_out: checkOut,
        guest_count: guestCount,
        nights: preview.nights,
        season_code: preview.season_code,
        packages: preview.packages,
        source: preview.source,
      },
    };
  }

  return { ok: true, status: 200, body: catalog };
}

function executeWolfhouseAccommodationQuote(transportBody, opts = {}) {
  const rejected = rejectSurfSchoolTransportFields(transportBody);
  if (!rejected.ok) return rejected;

  const body = transportBody || {};
  const checkIn = String(body.check_in || '').trim();
  const checkOut = String(body.check_out || '').trim();
  const guestCountInt = parseInt(body.guest_count, 10) || 0;

  if (!checkIn || !checkOut) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        reason: 'missing_dates',
        reason_code: 'missing_dates',
        error: 'check_in and check_out are required (YYYY-MM-DD)',
      },
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        reason: 'invalid_dates',
        reason_code: 'invalid_dates',
        error: 'check_in and check_out must be YYYY-MM-DD',
      },
    };
  }

  const packageCode = body.package_code != null ? String(body.package_code).trim() : undefined;
  const roomType = resolveQuoteRoomTypeFromPreference(body.room_type, body.room_preference);
  const addOns = Array.isArray(body.add_ons) ? body.add_ons : [];
  const guestPackages = Array.isArray(body.guest_packages) ? body.guest_packages : [];
  const pkgCtx = resolveBotBookingPackageContext({
    packageCode,
    guestPackages,
    checkIn,
    checkOut,
    guestCount: guestCountInt || guestPackages.length,
  });

  if (packageCode !== undefined) {
    const packageNightCheck = validateStaffPackageNightRule(checkIn, checkOut, packageCode);
    if (!packageNightCheck.ok) {
      return {
        ok: false,
        status: 400,
        body: {
          success: false,
          reason: 'package_min_nights_violation',
          reason_code: 'package_min_nights_violation',
          error: packageNightCheck.error,
          package_night_violation: packageNightCheck,
          nights: packageNightCheck.nights,
        },
      };
    }
  }

  const addOnPrep = validateAndNormalizeQuoteAddOns(addOns, guestCountInt || 1);
  let quote;
  if (!addOnPrep.ok) {
    quote = {
      success: false,
      staff_review_required: true,
      blockers: addOnPrep.blockers,
      unknown_add_on_codes: addOnPrep.unknown_codes,
      line_items: [],
      subtotal_cents: 0,
      discount_cents: 0,
      total_cents: 0,
      deposit_required_cents: 0,
      currency: 'EUR',
    };
  } else {
    try {
      quote = calculateWolfhouseQuote({
        client_slug: WOLFHOUSE_CLIENT_SLUG,
        check_in: checkIn,
        check_out: checkOut,
        guest_count: guestCountInt || body.guest_count,
        package_code: pkgCtx.quotePackageCode,
        guest_packages: pkgCtx.guestPackagesForQuote.length ? pkgCtx.guestPackagesForQuote : undefined,
        room_type: roomType,
        payment_choice: body.payment_choice || opts.payment_choice || 'deposit',
        add_ons: addOnPrep.add_ons,
        manual_price_per_night_cents: body.manual_price_per_night_cents != null
          ? Math.round(Number(body.manual_price_per_night_cents))
          : (body.manual_price_per_night_euros != null
            ? Math.round(Number(body.manual_price_per_night_euros) * 100)
            : undefined),
      }, opts.config);
    } catch (err) {
      return {
        ok: false,
        status: 500,
        body: {
          success: false,
          reason: 'quote_calculation_failed',
          reason_code: 'quote_calculation_failed',
          error: err.message,
        },
      };
    }
  }

  return {
    ok: quote.success !== false,
    status: 200,
    body: {
      success: true,
      preview_only: true,
      no_write_performed: true,
      client_slug: WOLFHOUSE_CLIENT_SLUG,
      quote,
      guest_packages: guestPackages,
    },
  };
}

function evaluateWolfhouseAccommodationDates(fields) {
  const body = fields && typeof fields === 'object' ? fields : {};
  const checkIn = String(body.check_in || '').trim() || null;
  const checkOut = String(body.check_out || '').trim() || null;
  const packageCode = body.package_code || body.package_interest || null;

  if ((Array.isArray(body.service_dates) && body.service_dates.length > 0) || body.service_date) {
    if (!checkIn) {
      return {
        ok: false,
        reason: 'surf_school_fields_not_supported',
        reason_code: 'surf_school_fields_not_supported',
      };
    }
  }

  const ctx = evaluatePackageNightContext(
    { check_in: checkIn, check_out: checkOut, package_interest: packageCode },
    { guest_directly_named_package: body.guest_directly_named_package === true },
  );

  let staffCheck = { ok: true, nights: ctx.nights, package_code: ctx.package_code };
  if (packageCode && checkIn && checkOut) {
    staffCheck = validateStaffPackageNightRule(checkIn, checkOut, packageCode);
  }

  let closedSeason = false;
  let seasonBlocked = false;
  if (checkIn && checkOut && ctx.nights != null) {
    try {
      const quote = calculateWolfhouseQuote({
        client_slug: WOLFHOUSE_CLIENT_SLUG,
        check_in: checkIn,
        check_out: checkOut,
        guest_count: 1,
        package_code: staffCheck.package_code || ctx.package_code || 'accommodation_only',
        room_type: 'shared',
        payment_choice: 'deposit',
        add_ons: [],
      });
      closedSeason = quote.closed_season === true;
      seasonBlocked = !quote.success && (closedSeason
        || (quote.blockers || []).some((b) => /closed/i.test(String(b))));
    } catch (_) {
      // ignore quote errors for date evaluation
    }
  }

  const ok = !ctx.blocks_weekly_package_quote && staffCheck.ok && !seasonBlocked;
  const out = {
    ok,
    nights: ctx.nights != null ? ctx.nights : staffCheck.nights,
    rule: ctx.rule,
    package_code: ctx.package_code || staffCheck.package_code,
    blocks_weekly_package_quote: ctx.blocks_weekly_package_quote,
    closed_season: closedSeason,
  };
  if (!staffCheck.ok) {
    out.reason = 'package_min_nights_violation';
    out.reason_code = 'package_min_nights_violation';
    out.error = staffCheck.error;
  } else if (seasonBlocked) {
    out.reason = 'closed_season';
    out.reason_code = 'closed_season';
  }
  return out;
}

async function executeWolfhouseAccommodationAvailability(pg, transportBody) {
  const rejected = rejectSurfSchoolTransportFields(transportBody);
  if (!rejected.ok) return rejected;

  const body = transportBody || {};
  const fields = {
    client_slug: WOLFHOUSE_CLIENT_SLUG,
    check_in: body.check_in,
    check_out: body.check_out,
    guest_count: parseInt(body.guest_count, 10) || body.guest_count,
    room_type: body.room_type || 'shared',
    gender_preference: body.gender_preference,
    group_gender: body.group_gender,
    guest_name: body.guest_name,
    room_preference: body.room_preference,
  };

  const result = await runAvailabilityCheckDryRun(fields, pg);
  if (result.skipped) {
    return {
      ok: false,
      status: 422,
      body: {
        success: false,
        reason: result.reason || 'availability_check_skipped',
        reason_code: result.reason || 'availability_check_skipped',
        vertical_id: VERTICAL_IDS.ACCOMMODATION,
        ...result,
      },
    };
  }

  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      preview_only: true,
      no_write_performed: true,
      client_slug: WOLFHOUSE_CLIENT_SLUG,
      ...result,
    },
  };
}

async function executeWolfhouseAccommodationCreate(pg, transportBody, opts = {}) {
  const rejected = rejectSurfSchoolTransportFields(transportBody);
  if (!rejected.ok) return rejected;

  const body = transportBody || {};
  const dryRunRequested = body.dry_run === true
    || body.preview_only === true
    || body.confirm !== true
    || opts.dryRunOnly === true;

  if (dryRunRequested) {
    const dryRun = await runLunaGuestBookingDryRun({
      ...body,
      client_slug: WOLFHOUSE_CLIENT_SLUG,
    }, { pg });
    return {
      ok: true,
      status: 200,
      body: dryRun,
    };
  }

  return {
    ok: false,
    status: 501,
    body: {
      success: false,
      ok: false,
      reason: 'capability_deferred',
      reason_code: 'live_booking_create_requires_staff_route',
      vertical_id: VERTICAL_IDS.ACCOMMODATION,
      error: 'Live accommodation booking create remains on existing Staff API routes until a dedicated write service is extracted.',
      allowed_routes: [
        'POST /staff/manual-bookings/create',
        'POST /staff/bot/bookings/create',
      ],
    },
  };
}

module.exports = {
  WOLFHOUSE_CLIENT_SLUG,
  SURF_SCHOOL_TRANSPORT_KEYS,
  rejectSurfSchoolTransportFields,
  buildWolfhouseAccommodationCatalog,
  executeWolfhouseAccommodationListOfferings,
  executeWolfhouseAccommodationQuote,
  evaluateWolfhouseAccommodationDates,
  executeWolfhouseAccommodationAvailability,
  executeWolfhouseAccommodationCreate,
};
