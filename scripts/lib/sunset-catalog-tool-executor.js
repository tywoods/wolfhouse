'use strict';

/**
 * sunset-catalog-tool-executor.js
 *
 * Sunset-only catalog tool registry and executor.
 * Isolated from Wolfhouse runtime — never imported by wolfhouse-only paths.
 * No network, no Stripe, no WhatsApp.
 *
 * Tenant guard: only accepts client_slug === 'sunset'.
 */

const {
  lookupSunsetRentalPrice,
  lookupSunsetRentalPriceAsync,
  lookupSunsetFullDayEquipmentAddon,
} = require('./sunset-rental-price-lookup');
const { normalizeSunsetLocationId, isSunsetLocationId, DEFAULT_SUNSET_LOCATION_ID } = require('./sunset-school-locations');
const { resolveTenantBusinessConfig } = require('./tenant-business-config');
const {
  buildPrivateLessonCatalogItem,
  findPrivateLessonCatalogService,
} = require('./sunset-private-lesson-luna-catalog');

const SUNSET_TENANT = 'sunset';

const SUNSET_CATALOG_READ_TOOLS = Object.freeze({
  get_sunset_rental_price: {
    description: 'Look up a Sunset rental price from school-scoped admin config.',
    params: ['item', 'duration'],
    optional_params: ['require_confirmed', 'location_id'],
  },
  get_sunset_private_lesson: {
    description: 'Read Sunset private lesson unit product (no fixed slots; custom sessions per booking).',
    params: [],
    optional_params: ['location_id'],
  },
  get_sunset_full_day_equipment_addon: {
    description: 'Read Sunset "Material el resto del día" add-on: active state, config price (per person, per day), and a quote for given eligible dates + quantity.',
    params: [],
    optional_params: ['location_id', 'dates', 'quantity'],
  },
});

function isIsoDate(s) {
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(s || '').trim());
}

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function classifyExplicitSunsetLocation(raw) {
  if (raw == null) return { ok: false };
  const trimmed = String(raw).trim();
  if (trimmed === '') return { ok: false };
  if (!isSunsetLocationId(raw)) return { ok: false };
  return { ok: true, location_id: normalizeSunsetLocationId(raw) };
}

/**
 * Resolve rental/catalog location from trusted ctx ingress vs model args.
 * Omission → documented Somo default; explicit invalid → fail closed;
 * conflicting valid scopes → location_scope_mismatch.
 */
function resolveSunsetCatalogToolLocation(ctx, args) {
  const ctxObj = ctx || {};
  const argsObj = args || {};
  const ctxExplicit = Object.prototype.hasOwnProperty.call(ctxObj, 'location_id');
  const argsExplicit = Object.prototype.hasOwnProperty.call(argsObj, 'location_id');

  let ctxNorm = null;
  if (ctxExplicit) {
    const c = classifyExplicitSunsetLocation(ctxObj.location_id);
    if (!c.ok) return { ok: false, reason: 'unknown_location' };
    ctxNorm = c.location_id;
  }

  let argsNorm = null;
  if (argsExplicit) {
    const a = classifyExplicitSunsetLocation(argsObj.location_id);
    if (!a.ok) return { ok: false, reason: 'unknown_location' };
    argsNorm = a.location_id;
  }

  if (ctxExplicit && argsExplicit) {
    if (ctxNorm !== argsNorm) {
      return { ok: false, reason: 'location_scope_mismatch' };
    }
    return { ok: true, location_id: ctxNorm };
  }
  if (ctxExplicit) return { ok: true, location_id: ctxNorm };
  if (argsExplicit) return { ok: true, location_id: argsNorm };
  return { ok: true, location_id: DEFAULT_SUNSET_LOCATION_ID };
}

/**
 * Resolve Sunset bot HTTP body location aliases (location_id, location).
 * Omission → Somo default; explicit invalid or conflicting aliases → fail closed.
 */
function resolveSunsetBotBodyLocation(body) {
  const b = body && typeof body === 'object' ? body : {};
  const hasLocationId = Object.prototype.hasOwnProperty.call(b, 'location_id');
  const hasLocation = Object.prototype.hasOwnProperty.call(b, 'location');

  if (hasLocationId) {
    const idRes = classifyExplicitSunsetLocation(b.location_id);
    if (!idRes.ok) {
      return { ok: false, location_id: null, raw: b.location_id };
    }
    if (hasLocation) {
      const locRes = classifyExplicitSunsetLocation(b.location);
      if (!locRes.ok) {
        return { ok: false, location_id: null, raw: b.location };
      }
      if (locRes.location_id !== idRes.location_id) {
        return { ok: false, location_id: null, raw: b.location };
      }
    }
    return { ok: true, location_id: idRes.location_id, raw: idRes.location_id };
  }

  if (hasLocation) {
    const locRes = classifyExplicitSunsetLocation(b.location);
    if (!locRes.ok) {
      return { ok: false, location_id: null, raw: b.location };
    }
    return { ok: true, location_id: locRes.location_id, raw: locRes.location_id };
  }

  return { ok: true, location_id: DEFAULT_SUNSET_LOCATION_ID, raw: null };
}

/**
 * Execute one Sunset catalog read tool.
 *
 * @param {string} toolId
 * @param {object} ctx
 *   client_slug   {string}  Must be 'sunset'.
 *   location_id   {string}  sunset-somo | sunset-sardinero
 *   args          {object}  Tool-specific arguments.
 *   dry_run       {boolean} When true, relaxes require_confirmed to allow unverified_seed prices.
 * @returns {object}  { ok, tool_id, result?, reason? }
 */
function executeSunsetCatalogTool(toolId, ctx) {
  const id = trimStr(toolId);
  const clientSlug = trimStr((ctx && ctx.client_slug) || '');

  if (!clientSlug || clientSlug !== SUNSET_TENANT) {
    return {
      ok: false,
      tool_id: id,
      reason: 'invalid_tenant',
      expected_tenant: SUNSET_TENANT,
      received_tenant: clientSlug || null,
    };
  }

  if (!SUNSET_CATALOG_READ_TOOLS[id]) {
    return {
      ok: false,
      tool_id: id,
      reason: 'unknown_tool',
      known_tools: Object.keys(SUNSET_CATALOG_READ_TOOLS),
    };
  }

  const args = (ctx && ctx.args) || {};
  const locRes = resolveSunsetCatalogToolLocation(ctx, args);
  if (!locRes.ok) {
    return {
      ok: false,
      tool_id: id,
      reason: locRes.reason,
    };
  }
  const locationId = locRes.location_id;

  if (id === 'get_sunset_rental_price') {
    const item = trimStr(args.item);
    const duration = trimStr(args.duration);

    if (!item) {
      return {
        ok: false,
        tool_id: id,
        reason: 'invalid_args',
        detail: 'missing required arg: item',
      };
    }
    if (!duration) {
      return {
        ok: false,
        tool_id: id,
        reason: 'invalid_args',
        detail: 'missing required arg: duration',
      };
    }

    const requireConfirmed = ctx.dry_run === true
      ? false
      : (args.require_confirmed !== false);

    const lookup = lookupSunsetRentalPrice({
      client_slug: clientSlug,
      location_id: locationId,
      item,
      duration,
      require_confirmed: requireConfirmed,
    });

    if (!lookup.ok) {
      return {
        ok: false,
        tool_id: id,
        reason: lookup.reason,
        detail: lookup,
        location_id: locationId,
      };
    }

    return {
      ok: true,
      tool_id: id,
      location_id: locationId,
      result: lookup,
    };
  }

  if (id === 'get_sunset_private_lesson') {
    const adminCfg = resolveTenantBusinessConfig(SUNSET_TENANT, locationId);
    if (!adminCfg || adminCfg.ok === false) {
      return {
        ok: false,
        tool_id: id,
        reason: 'config_unavailable',
        location_id: locationId,
      };
    }
    const catalogItem = findPrivateLessonCatalogService(adminCfg.catalog_services)
      || buildPrivateLessonCatalogItem(adminCfg.private_lesson);
    if (!catalogItem.enabled) {
      return {
        ok: false,
        tool_id: id,
        reason: 'private_lesson_disabled',
        location_id: locationId,
        result: catalogItem,
      };
    }
    return {
      ok: true,
      tool_id: id,
      location_id: locationId,
      result: catalogItem,
    };
  }

  if (id === 'get_sunset_full_day_equipment_addon') {
    const lookup = lookupSunsetFullDayEquipmentAddon({
      client_slug: clientSlug,
      location_id: locationId,
    });
    if (!lookup.ok) {
      return {
        ok: false,
        tool_id: id,
        reason: lookup.reason,
        detail: lookup,
        location_id: locationId,
      };
    }
    // Optional quote: eligible dates (subset the caller already validated as eligible) + quantity(people).
    // Server (booking write) revalidates eligibility/dates/quantity/price — this is an advisory quote only.
    let quote = null;
    const rawDates = Array.isArray(args.dates) ? args.dates : null;
    if (rawDates && rawDates.length) {
      const dates = [];
      for (const d of rawDates) {
        const iso = trimStr(d);
        if (!isIsoDate(iso)) {
          return { ok: false, tool_id: id, reason: 'invalid_args', detail: `date must be YYYY-MM-DD: ${iso}`, location_id: locationId };
        }
        if (dates.indexOf(iso) < 0) dates.push(iso);
      }
      let quantity = 1;
      if (args.quantity != null) {
        quantity = parseInt(String(args.quantity), 10);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
          return { ok: false, tool_id: id, reason: 'invalid_args', detail: 'quantity must be an integer 1–99', location_id: locationId };
        }
      }
      const perDateCents = lookup.amount_cents * quantity;
      quote = {
        dates: dates.sort(),
        quantity,
        unit_amount_cents: lookup.amount_cents,
        per_date_amount_cents: perDateCents,
        total_amount_cents: perDateCents * dates.length,
        currency: lookup.currency,
      };
    }
    return {
      ok: true,
      tool_id: id,
      location_id: locationId,
      result: quote ? { ...lookup, quote } : lookup,
    };
  }

  return {
    ok: false,
    tool_id: id,
    reason: 'not_implemented',
  };
}

/**
 * Async, DB-authoritative variant for LIVE bot routes. Only get_sunset_rental_price
 * currently has a DB-backed price path; every other catalog read tool keeps the
 * existing synchronous behavior. The live bot rental-price route MUST await this
 * so the owner-managed portal price — not the repo baseline seed — is returned.
 */
async function executeSunsetCatalogToolAsync(toolId, ctx) {
  const id = trimStr(toolId);
  if (id !== 'get_sunset_rental_price') {
    return executeSunsetCatalogTool(toolId, ctx);
  }

  const clientSlug = trimStr((ctx && ctx.client_slug) || '');
  if (!clientSlug || clientSlug !== SUNSET_TENANT) {
    return {
      ok: false,
      tool_id: id,
      reason: 'invalid_tenant',
      expected_tenant: SUNSET_TENANT,
      received_tenant: clientSlug || null,
    };
  }

  const args = (ctx && ctx.args) || {};
  const locRes = resolveSunsetCatalogToolLocation(ctx, args);
  if (!locRes.ok) {
    return {
      ok: false,
      tool_id: id,
      reason: locRes.reason,
    };
  }
  const locationId = locRes.location_id;
  const item = trimStr(args.item);
  const duration = trimStr(args.duration);
  if (!item) {
    return { ok: false, tool_id: id, reason: 'invalid_args', detail: 'missing required arg: item' };
  }
  if (!duration) {
    return { ok: false, tool_id: id, reason: 'invalid_args', detail: 'missing required arg: duration' };
  }

  const requireConfirmed = ctx && ctx.dry_run === true
    ? false
    : (args.require_confirmed !== false);

  const lookup = await lookupSunsetRentalPriceAsync({
    client_slug: clientSlug,
    location_id: locationId,
    item,
    duration,
    require_confirmed: requireConfirmed,
    pgClient: ctx && ctx.pgClient,
    loadRule: ctx && ctx.loadRule,
  });

  if (!lookup.ok) {
    return {
      ok: false,
      tool_id: id,
      reason: lookup.reason,
      detail: lookup,
      location_id: locationId,
    };
  }
  return {
    ok: true,
    tool_id: id,
    location_id: locationId,
    result: lookup,
  };
}

module.exports = {
  SUNSET_CATALOG_READ_TOOLS,
  SUNSET_TENANT,
  executeSunsetCatalogTool,
  executeSunsetCatalogToolAsync,
  resolveSunsetCatalogToolLocation,
  resolveSunsetBotBodyLocation,
};
