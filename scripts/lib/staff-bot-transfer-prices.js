'use strict';

const { loadStaffTransferConfig } = require('./staff-transfer-pricing');

/** Read-only catalog facts, not a booking quote or a capacity check.
 * Tenant is pinned by dispatchBotRouteBoundToPrincipalTenant, never by model input.
 * Do not use Admin loadView here: it performs schema/catalog writes.
 */
function createBotTransferPricesHandler({ withPgClient, sendJSON }) {
  return async function handleBotTransferPrices(req, res) {
    const slug = req._botBoundClientSlug;
    if (slug !== 'wolfhouse-somo') {
      return sendJSON(res, 403, { success: false, error: 'unsupported_client' });
    }
    let config;
    try {
      config = await withPgClient(pg => loadStaffTransferConfig(pg, slug));
    } catch (_) {
      return sendJSON(res, 503, { success: false, error: 'transfer_prices_unavailable' });
    }
    return sendJSON(res, 200, {
      success: true,
      client_slug: slug,
      read_only: true,
      availability_checked: false,
      transfers: config.rules.map(rule => ({
        airport_code: rule.airport_code,
        label: rule.label,
        price: rule.price,
        eligibility: {
          min_guest_count: rule.min_guest_count == null ? null : rule.min_guest_count,
          max_guest_count: rule.max_guest_count == null ? null : rule.max_guest_count,
          requires_package: rule.requires_package,
          included_when_package: rule.included_when_package,
          source: rule.source,
        },
      })),
    });
  };
}

module.exports = { createBotTransferPricesHandler };
