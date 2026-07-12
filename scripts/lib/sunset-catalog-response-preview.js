'use strict';

/**
 * sunset-catalog-response-preview.js
 *
 * Sunset-only offline response preview layer.
 * Takes a catalog tool result and produces a preview_text suitable for
 * human review. This is NOT a live WhatsApp reply and NOT Cami voice —
 * it is a pre-flight text preview for staff/operator sign-off.
 *
 * Isolated from Wolfhouse runtime. No DB, network, Stripe, Staff API,
 * WhatsApp, or env dependency. Never imported by luna-guest-* or hermes paths.
 */

const { executeSunsetCatalogTool } = require('./sunset-catalog-tool-executor');

const SUNSET_TENANT = 'sunset';

/**
 * buildSunsetCatalogResponsePreview(input)
 *
 * @param {object} input
 *   client_slug  {string}   Must be 'sunset'.
 *   tool_id      {string}   Tool to invoke (e.g. 'get_sunset_rental_price').
 *   args         {object}   Tool-specific arguments.
 *   dry_run      {boolean}  When true, allows unverified_seed prices through the
 *                           executor so they can be previewed (with a warning).
 *
 * @returns {object}
 *   Success:
 *     { ok: true, client_slug, tool_id, preview_text, pricing_status?,
 *       live_send_allowed, source }
 *   Failure:
 *     { ok: false, client_slug?, tool_id?, reason, detail? }
 */
function buildSunsetCatalogResponsePreview(input) {
  const inp = input || {};
  const clientSlug = String(inp.client_slug || '').trim();
  const toolId     = String(inp.tool_id || '').trim();

  if (!clientSlug || clientSlug !== SUNSET_TENANT) {
    return {
      ok: false,
      tool_id: toolId || null,
      reason: 'invalid_tenant',
      expected_tenant: SUNSET_TENANT,
      received_tenant: clientSlug || null,
    };
  }

  const toolResult = executeSunsetCatalogTool(toolId, {
    client_slug: clientSlug,
    args: inp.args || {},
    dry_run: inp.dry_run === true,
  });

  if (!toolResult.ok) {
    return {
      ok: false,
      client_slug: clientSlug,
      tool_id: toolId,
      reason: toolResult.reason,
      detail: toolResult,
    };
  }

  if (toolId === 'get_sunset_rental_price') {
    return _previewRentalPrice(clientSlug, toolId, toolResult.result);
  }

  if (toolId === 'get_sunset_full_day_equipment_addon') {
    return _previewFullDayAddon(clientSlug, toolId, toolResult.result);
  }

  return {
    ok: false,
    client_slug: clientSlug,
    tool_id: toolId,
    reason: 'no_preview_handler',
  };
}

// Luna-facing preview for the "Material el resto del día" add-on. The Spanish offer copy carries the
// price from the tool response (never invented). Offer once after an eligible selection; do not re-upsell
// after a decline; do not claim it was added until the attach tool confirms.
function _previewFullDayAddon(clientSlug, toolId, r) {
  const eur = (Number(r.amount_cents) / 100);
  const eurText = Number.isInteger(eur) ? String(eur) : eur.toFixed(2);
  const offerText = `También puedes quedarte con el material el resto del día por ${eurText} € más por persona. ¿Te gustaría añadirlo?`;
  let previewText = `[PREVIEW] Full-day equipment add-on: €${r.amount_eur} ${r.currency} per person, per day (active). ` +
    `Offer copy: "${offerText}"`;
  if (r.quote) {
    previewText += ` Quote: ${r.quote.quantity} person(s) × ${r.quote.dates.length} day(s) = €${(r.quote.total_amount_cents / 100)} ${r.quote.currency}.`;
  }
  return {
    ok: true,
    client_slug: clientSlug,
    tool_id: toolId,
    preview_text: previewText,
    offer_text_es: offerText,
    active: r.active === true,
    amount_cents: r.amount_cents,
    live_send_allowed: r.active === true,
    source: 'sunset_catalog_tool_executor',
  };
}

function _previewRentalPrice(clientSlug, toolId, r) {
  const isConfirmed    = r.pricing_status === 'confirmed';
  const liveSendAllowed = isConfirmed;

  const durationLabel = r.duration.replace(/_/g, ' ');
  // Item codes already carry the category suffix (e.g. board_rental, sup_rental).
  // Strip trailing _rental before humanizing so the template word "rental" is not doubled.
  const itemBase  = r.item.replace(/_rental$/, '');
  const itemLabel = itemBase.replace(/_/g, ' ');

  let previewText;
  if (isConfirmed) {
    previewText =
      `[PREVIEW] ${itemLabel} rental for ${durationLabel}: €${r.amount_eur} ${r.currency}. ` +
      `Price confirmed — safe to quote.`;
  } else {
    previewText =
      `[PREVIEW] ${itemLabel} rental for ${durationLabel}: ~€${r.amount_eur} ${r.currency} ` +
      `(seed price — needs staff confirmation before live quoting). ` +
      `Do not send this price to a guest without verification.`;
  }

  return {
    ok: true,
    client_slug: clientSlug,
    tool_id: toolId,
    preview_text: previewText,
    pricing_status: r.pricing_status,
    live_send_allowed: liveSendAllowed,
    source: 'sunset_catalog_tool_executor',
  };
}

module.exports = {
  buildSunsetCatalogResponsePreview,
};
