'use strict';

/**
 * Luna Front Desk — business vertical resolver and interface.
 *
 * Routes and HTTP handlers resolve a trusted tenant context to a vertical
 * adapter (`surf_school` | `accommodation`). Application services remain
 * vertical-specific; this module is the explicit boundary (Slice 6).
 *
 * See docs/LUNA-FRONT-DESK-DOMAIN-CONTRACT.md §14.
 */

const {
  normalizeSunsetLocationId,
  isSunsetLocationId,
} = require('./sunset-school-locations');
const {
  VERTICAL_IDS,
  VERTICAL_CHANNELS,
  VERTICAL_TENANT,
  assertResolvedVerticalScope,
} = require('./luna-front-desk-vertical-scope');
const { surfSchoolVerticalAdapter } = require('./verticals/surf-school-vertical-adapter');
const { accommodationVerticalPlaceholder } = require('./verticals/accommodation-vertical-placeholder');

const SUNSET_TENANT = VERTICAL_TENANT[VERTICAL_IDS.SURF_SCHOOL];
const WOLFHOUSE_TENANT = VERTICAL_TENANT[VERTICAL_IDS.ACCOMMODATION];

/**
 * Resolve trusted tenant → vertical. Fail closed on unknown tenants.
 *
 * @param {object} trustedTenantContext
 * @returns {object}
 */
function resolveBusinessVertical(trustedTenantContext) {
  const ctx = trustedTenantContext && typeof trustedTenantContext === 'object'
    ? trustedTenantContext
    : {};
  const clientSlug = String(ctx.clientSlug || ctx.client_slug || '').trim();
  if (!clientSlug) {
    return {
      ok: false,
      reason: 'unknown_tenant',
      reason_code: 'unknown_tenant',
    };
  }

  if (clientSlug === SUNSET_TENANT) {
    const rawLoc = ctx.locationId != null ? ctx.locationId : ctx.location_id;
    const locationId = normalizeSunsetLocationId(rawLoc);
    if (rawLoc != null && String(rawLoc).trim() && !isSunsetLocationId(rawLoc)) {
      return {
        ok: false,
        reason: 'unknown_location',
        reason_code: 'unknown_location',
        location_id: String(rawLoc).trim(),
      };
    }
    return {
      ok: true,
      verticalId: VERTICAL_IDS.SURF_SCHOOL,
      clientSlug: SUNSET_TENANT,
      locationId,
    };
  }

  if (clientSlug === WOLFHOUSE_TENANT) {
    return {
      ok: true,
      verticalId: VERTICAL_IDS.ACCOMMODATION,
      clientSlug: WOLFHOUSE_TENANT,
      locationId: ctx.locationId != null ? String(ctx.locationId).trim() : null,
    };
  }

  return {
    ok: false,
    reason: 'unknown_tenant',
    reason_code: 'unknown_tenant',
    received_tenant: clientSlug,
  };
}

function getVerticalAdapter(resolved) {
  if (!resolved || resolved.ok !== true) return null;
  if (resolved.verticalId === VERTICAL_IDS.SURF_SCHOOL) return surfSchoolVerticalAdapter;
  if (resolved.verticalId === VERTICAL_IDS.ACCOMMODATION) return accommodationVerticalPlaceholder;
  return null;
}

function invokeVerticalOperation(resolved, operation, pg, request) {
  const adapter = getVerticalAdapter(resolved);
  if (!adapter) {
    return {
      ok: false,
      status: 403,
      body: {
        success: false,
        reason: 'unknown_vertical',
        reason_code: 'unknown_vertical',
      },
    };
  }
  const fn = adapter[operation];
  if (typeof fn !== 'function') {
    return {
      ok: false,
      status: 500,
      body: {
        success: false,
        reason: 'operation_not_supported',
        reason_code: 'operation_not_supported',
        operation,
      },
    };
  }
  const payload = { ...request, resolved };
  if (operation === 'evaluateDates') {
    return fn.call(adapter, payload);
  }
  return fn.call(adapter, pg, payload);
}

module.exports = {
  VERTICAL_IDS,
  VERTICAL_CHANNELS,
  SUNSET_TENANT,
  WOLFHOUSE_TENANT,
  resolveBusinessVertical,
  getVerticalAdapter,
  assertResolvedVerticalScope,
  invokeVerticalOperation,
  surfSchoolVerticalAdapter,
  accommodationVerticalPlaceholder,
};
