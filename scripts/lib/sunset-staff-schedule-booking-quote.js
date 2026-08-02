'use strict';

/**
 * Staff schedule booking quote — production owner used by
 * handleSunsetScheduleBookingQuote (auth/tenant/location stay in the HTTP handler).
 *
 * Classification of canonical vs generic rentals must use the same
 * CANONICAL_RENTAL_OFFERING_KEYS authority as prepare/quote/create
 * (sunset-schedule-booking-writes). Never maintain a separate hardcoded list.
 *
 * Tests and captain in-env jobs invoke this helper directly (no staff cookie).
 */

const {
  prepareGenericRentalsForCreate,
  buildGenericRentalAuthoritativeQuote,
  CANONICAL_RENTAL_OFFERING_KEYS,
  rentalDurationKeyFromDateRange,
  transportHasNonGenericCommercialIntent,
} = require('./sunset-schedule-booking-writes');
const {
  VERTICAL_CHANNELS,
  invokeVerticalOperation,
} = require('./luna-front-desk-business-vertical');

/** Drawer / staff UI message key for missing or zero standalone prices. */
const PRICE_NOT_CONFIGURED_UI_KEY = 'schedule.create.priceNotConfigured';

/**
 * Production missing/unpriced reason codes that must surface as drawer
 * "Price not configured" (never silent ok €0).
 */
const PRICE_FAILURE_REASONS = Object.freeze(new Set([
  'price_not_found',
  'price_missing',
  'price_not_configured',
  'price_unverified',
  'unpriced',
  'unpriced_offering',
  'ambiguous_price',
  'no_bookable_tiers',
]));

/**
 * Normalize a failure reason to a known unpriced/missing code, or null.
 * Shared so attachStaffQuoteUiContract and tests use one authority.
 */
function normalizeStaffQuotePriceFailureReason(reason) {
  const r = String(reason || '').trim();
  if (!r) return null;
  if (PRICE_FAILURE_REASONS.has(r)) return r;
  // Loose production aliases that still mean "cannot sell this line".
  if (/^no_price_for_/i.test(r)) return 'price_not_configured';
  if (/price_not_configured|price_missing|price_not_found|unpriced/i.test(r)) {
    if (/not_found/i.test(r)) return 'price_not_found';
    if (/missing/i.test(r)) return 'price_missing';
    if (/unpriced/i.test(r)) return 'unpriced';
    return 'price_not_configured';
  }
  return null;
}

/**
 * Documented pre-P0c staff-handler filter (base 34e4b7f3). Kept only so offline
 * RED can prove the empty-stub €0 path; production must never call this.
 */
const STALE_HARDCODED_CANONICAL_KEYS = Object.freeze([
  'board_rental',
  'wetsuit_rental',
  'board_and_suit_rental',
]);

/**
 * Filter requested rentals to the shared canonical set (same authority as create).
 * Exported for adversarial classification drift tests.
 */
function classifyCanonicalRentalsForStaffQuote(requestedRentals) {
  const rows = Array.isArray(requestedRentals) ? requestedRentals : [];
  return rows.filter((r) =>
    CANONICAL_RENTAL_OFFERING_KEYS.includes(String(r && r.offering_key || '').trim()));
}

/** Offline RED only — reproduces the base staff-handler filter that dropped S+W. */
function classifyCanonicalRentalsWithStaleHardcodedFilter(requestedRentals) {
  const rows = Array.isArray(requestedRentals) ? requestedRentals : [];
  return rows.filter((r) =>
    STALE_HARDCODED_CANONICAL_KEYS.includes(String(r && r.offering_key || '').trim()));
}

/**
 * Attach a drawer-friendly contract when the failure is unpriced / missing price.
 * Never invent money; only surface reason for UI.
 */
function attachStaffQuoteUiContract(result) {
  if (!result || result.ok) return result;
  const body = result.body && typeof result.body === 'object' ? { ...result.body } : {};
  const normalized = normalizeStaffQuotePriceFailureReason(
    body.reason_code || body.reason || body.error,
  );
  if (normalized) {
    body.reason_code = normalized;
    if (!body.reason) body.reason = normalized;
    if (!body.error) body.error = normalized;
    body.ui_message_key = PRICE_NOT_CONFIGURED_UI_KEY;
    body.price_status = 'unpriced';
    // Explicit zero-total contract: failures never paint a commercial €0 total.
    if (body.total_cents != null) delete body.total_cents;
    // Prefer 422 when status was missing or success-class.
    const status = Number(result.status);
    const nextStatus = (!Number.isFinite(status) || status < 400) ? 422 : status;
    return { ...result, status: nextStatus, body };
  }
  return result;
}

function calendarDayCountFromBody(body) {
  const from = String(body && body.date_from || '').slice(0, 10);
  const to = String(body && body.date_to || body && body.date_from || '').slice(0, 10);
  if (!from || !to || to < from) return 0;
  return Math.round(
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000,
  ) + 1;
}

/**
 * Production DB quote body for the authenticated staff schedule route.
 *
 * @param {object} opts
 * @param {string} opts.clientSlug
 * @param {string} opts.locationId trusted location
 * @param {object} opts.body request body (after auth/location checks)
 * @param {object} opts.pgClient open PG client
 * @param {object} opts.verticalResolved resolveBusinessVertical result (ok:true)
 * @param {string} [opts.channel] default MANUAL_STAFF
 * @param {function} [opts.prepareGenericRentals] inject for tests
 * @param {function} [opts.buildGenericQuote] inject for tests
 * @param {function} [opts.invokeVertical] inject for tests
 * @param {function} [opts.buildQuoteProvenanceFn] inject for tests
 * @returns {Promise<{ok:boolean,status:number,body:object,meta?:object}>}
 */
async function executeSunsetStaffScheduleBookingQuote(opts) {
  const o = opts || {};
  const clientSlug = String(o.clientSlug || '').trim();
  const locationId = String(o.locationId || '').trim();
  const body = o.body && typeof o.body === 'object' ? o.body : {};
  const pg = o.pgClient;
  const resolved = o.verticalResolved;
  if (!pg) {
    return {
      ok: false,
      status: 500,
      body: { success: false, error: 'pg_client_required', reason_code: 'pg_client_required' },
    };
  }
  if (!resolved || !resolved.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        error: (resolved && (resolved.reason || resolved.reason_code)) || 'vertical_unresolved',
        reason_code: (resolved && resolved.reason_code) || 'vertical_unresolved',
      },
    };
  }

  const prepFn = o.prepareGenericRentals || prepareGenericRentalsForCreate;
  const buildGq = o.buildGenericQuote || buildGenericRentalAuthoritativeQuote;
  const invokeFn = o.invokeVertical || invokeVerticalOperation;
  const channel = o.channel || VERTICAL_CHANNELS.MANUAL_STAFF;

  const requestedRentals = Array.isArray(body.rentals) ? body.rentals : [];
  const genericPrep = await prepFn({
    clientSlug,
    locationId,
    pgClient: pg,
    rentals: requestedRentals,
    serviceDate: String(body.date_from || '').slice(0, 10),
    source: 'staff_manual',
    calendarDayCount: calendarDayCountFromBody(body),
    bookingDurationKey: rentalDurationKeyFromDateRange(body.date_from, body.date_to),
    dateFrom: body.date_from,
    dateTo: body.date_to || body.date_from,
    listOfferings: o.listOfferings,
    loadRule: o.loadRule,
  });
  if (!genericPrep.ok) {
    return attachStaffQuoteUiContract({
      ok: false,
      status: 422,
      body: {
        success: false,
        error: genericPrep.reason,
        reason: genericPrep.reason,
        reason_code: genericPrep.reason,
      },
      meta: { genericPrep, canonicalRentals: [], requestedRentals },
    });
  }

  const genericQuote = buildGq(genericPrep.records);
  // Shared SSoT — same keys as prepareGenericRentalsForCreate / create path.
  // Never reintroduce a separate hardcoded list (P0c).
  const canonicalRentals = classifyCanonicalRentalsForStaffQuote(requestedRentals);
  const transportBody = genericPrep.genericRentals.length
    ? { ...body, rentals: canonicalRentals }
    : body;
  if (genericPrep.genericRentals.length && !canonicalRentals.length) {
    delete transportBody.rentals;
  }

  // Same commercial-intent authority as create / re-quote (lessons, CE, custom,
  // components, accommodation). Never maintain a separate predicate here.
  const hasClosedVerticalIntent = canonicalRentals.length > 0
    || transportHasNonGenericCommercialIntent(transportBody);

  let quoted = hasClosedVerticalIntent
    ? await invokeFn(resolved, 'quoteOffering', pg, {
      channel,
      transportBody,
    })
    : {
      ok: true,
      status: 200,
      body: { ok: true, currency: 'EUR', total_cents: 0, line_items: [] },
    };

  if (!quoted.ok || !genericQuote.line_items.length) {
    const out = attachStaffQuoteUiContract(quoted);
    return {
      ...out,
      meta: {
        genericPrep,
        genericQuote,
        canonicalRentals,
        hasClosedVerticalIntent,
        transportBody,
        requestedRentals,
      },
    };
  }

  quoted = {
    ...quoted,
    body: {
      ...quoted.body,
      total_cents: Number(quoted.body.total_cents || 0) + genericQuote.total_cents,
      line_items: [...(quoted.body.line_items || []), ...genericQuote.line_items],
    },
  };

  const buildQuoteProvenance = o.buildQuoteProvenanceFn
    || require('./luna-front-desk-quote-service').buildQuoteProvenance;
  quoted.body.quote_provenance = buildQuoteProvenance(quoted.body);

  return {
    ...quoted,
    meta: {
      genericPrep,
      genericQuote,
      canonicalRentals,
      hasClosedVerticalIntent,
      transportBody,
      requestedRentals,
    },
  };
}

module.exports = {
  executeSunsetStaffScheduleBookingQuote,
  classifyCanonicalRentalsForStaffQuote,
  classifyCanonicalRentalsWithStaleHardcodedFilter,
  attachStaffQuoteUiContract,
  normalizeStaffQuotePriceFailureReason,
  PRICE_NOT_CONFIGURED_UI_KEY,
  PRICE_FAILURE_REASONS,
  CANONICAL_RENTAL_OFFERING_KEYS,
  STALE_HARDCODED_CANONICAL_KEYS,
  // Re-export production commercial-intent predicate (no duplicate list).
  transportHasNonGenericCommercialIntent,
};
