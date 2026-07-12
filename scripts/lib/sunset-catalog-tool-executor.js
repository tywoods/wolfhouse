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

const { lookupSunsetRentalPrice, lookupSunsetFullDayEquipmentAddon } = require('./sunset-rental-price-lookup');
const { normalizeSunsetLocationId } = require('./sunset-school-locations');
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
  const locationId = normalizeSunsetLocationId(
    args.location_id || (ctx && ctx.location_id) || null,
  );

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

module.exports = {
  SUNSET_CATALOG_READ_TOOLS,
  SUNSET_TENANT,
  executeSunsetCatalogTool,
};
