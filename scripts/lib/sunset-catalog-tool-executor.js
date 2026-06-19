'use strict';

/**
 * sunset-catalog-tool-executor.js
 *
 * Sunset-only catalog tool registry and executor.
 * Isolated from Wolfhouse runtime — never imported by luna-guest-* or hermes paths.
 * No DB, no network, no Staff API, no Stripe, no WhatsApp, no env dependency.
 *
 * Tenant guard: only accepts client_slug === 'sunset'.
 */

const { lookupSunsetRentalPrice } = require('./sunset-rental-price-lookup');

const SUNSET_TENANT = 'sunset';

const SUNSET_CATALOG_READ_TOOLS = Object.freeze({
  get_sunset_rental_price: {
    description: 'Look up a Sunset rental price from the local tenant config.',
    params: ['item', 'duration'],
    optional_params: ['require_confirmed'],
  },
});

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * Execute one Sunset catalog read tool.
 *
 * @param {string} toolId
 * @param {object} ctx
 *   client_slug  {string}  Must be 'sunset'.
 *   args         {object}  Tool-specific arguments.
 *   dry_run      {boolean} When true, relaxes require_confirmed to allow unverified_seed prices.
 * @returns {object}  { ok, tool_id, result?, reason? }
 */
function executeSunsetCatalogTool(toolId, ctx) {
  const id = trimStr(toolId);
  const clientSlug = trimStr((ctx && ctx.client_slug) || '');

  // Tenant guard — must be sunset, no fallback when explicit slug provided
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

    // dry_run relaxes the confirmed guard so tests can inspect unverified_seed prices
    const requireConfirmed = ctx.dry_run === true
      ? false
      : (args.require_confirmed !== false);

    const lookup = lookupSunsetRentalPrice({
      client_slug: clientSlug,
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
      };
    }

    return {
      ok: true,
      tool_id: id,
      result: lookup,
    };
  }

  // Defensive fallback — registry has the tool but handler is not implemented
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
