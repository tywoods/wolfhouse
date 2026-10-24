'use strict';

const { getClientTransferConfig } = require('./client-transfer-config');
const { loadRules, loadTransferRules } = require('./wolfhouse-pricing-store');


/** Read-only Staff overlay. Deliberately not the Admin loadView (DDL/catalog writes). */
async function loadStaffTransferConfig(pg, clientSlug) {
  const config = getClientTransferConfig(clientSlug);
  if (config.client_slug !== 'wolfhouse-somo') return config;
  const dbRules = await loadRules(pg, config.client_slug);
  const dbTransferRules = await loadTransferRules(pg, config.client_slug);

  const authoritativePrices = new Map(dbRules
    .filter((rule) => rule.item_type === 'transfer' && rule.active !== false)
    .map((rule) => [String(rule.item_code || '').toUpperCase(), rule]));
  return {
    ...config,
    airports: dbTransferRules.map((r) => ({ code: r.airport_code, label: r.label,
      iata: r.airport_code, aliases: r.aliases || [] })),
    // Runtime eligibility/inclusion is DB-only. Static config is seed/UI data;
    // it must never make a missing Admin row available (or free).
    rules: dbTransferRules.map((r) => {
      const price = authoritativePrices.get(String(r.airport_code || '').toUpperCase()) || null;
      return { ...r, source: 'db',
        price: price ? { amount_cents: Number(price.amount_cents), currency: price.currency,
          unit: price.unit, source: 'db' } : null,
        flat_price_cents: price && price.unit === 'flat' ? price.amount_cents : null,
        per_person_extra_cents: price && price.unit === 'per_person' ? price.amount_cents : null,
      };
    }),
  };
}

module.exports = { loadStaffTransferConfig };
