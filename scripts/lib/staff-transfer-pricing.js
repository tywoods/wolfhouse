'use strict';

const { getClientTransferConfig } = require('./client-transfer-config');
const { loadRules, loadTransferRules } = require('./wolfhouse-pricing-store');
const { buildAdminPricingView } = require('./wolfhouse-pricing-resolve');

/** Read-only Staff overlay. Deliberately not the Admin loadView (DDL/catalog writes). */
async function loadStaffTransferConfig(pg, clientSlug) {
  const config = getClientTransferConfig(clientSlug);
  if (config.client_slug !== 'wolfhouse-somo') return config;
  const dbRules = await loadRules(pg, config.client_slug);
  const dbTransferRules = await loadTransferRules(pg, config.client_slug);
  const { transfers } = buildAdminPricingView({ transferConfig: config, dbRules, dbTransferRules });
  const authoritativePrices = new Map(dbRules
    .filter((rule) => rule.item_type === 'transfer' && rule.active !== false)
    .map((rule) => [String(rule.item_code || '').toUpperCase(), rule]));
  return {
    ...config,
    airports: transfers.map((r) => ({ code: r.airport_code, label: r.label,
      iata: r.airport_code, aliases: r.aliases || [] })),
    rules: transfers.map((r) => {
      const price = authoritativePrices.get(String(r.airport_code || '').toUpperCase()) || null;
      return { ...r,
        flat_price_cents: price && price.unit === 'flat' ? price.amount_cents : null,
        per_person_extra_cents: price && price.unit === 'per_person' ? price.amount_cents : null,
      };
    }),
  };
}

module.exports = { loadStaffTransferConfig };
