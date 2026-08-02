'use strict';

/**
 * Sync Admin pack config_json.price_tiers into tenant_price_rules using the
 * canonical identity contract. Does not invent amounts — only copies
 * owner-entered tier.amount_cents into the linked price row.
 *
 * Used by:
 *   - Admin pack create/patch (same transaction)
 *   - scripts/reconcile-sunset-admin-price-identities.js (explicit operator reconcile)
 *
 * NOT used by schedule booking create preflight — create must not heal price
 * rules outside the booking transaction (stale create would leave durable writes).
 */

const {
  packPriceItemCode,
  billingUnitForSurfPackTier,
} = require('./sunset-admin-price-identity');
const { normalizeSunsetLocationId } = require('./sunset-school-locations');

async function syncPackTierToPriceRules(client, {
  clientSlug, locationId, packId, packLabel, tiers, actor, skipTransaction,
}) {
  const { upsertConfigPriceRule } = require('./tenant-admin-writes');
  const loc = normalizeSunsetLocationId(locationId);
  const results = [];
  for (const tier of tiers || []) {
    const key = String((tier && tier.key) || '').trim();
    if (!key) continue;
    const amountCents = Math.round(Number(tier.amount_cents));
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      results.push({
        tier_key: key,
        ok: false,
        reason: 'missing_or_non_positive_amount',
        bookable: false,
      });
      continue;
    }
    const itemCode = packPriceItemCode(packId, key);
    const billingUnit = billingUnitForSurfPackTier(key);
    const out = await upsertConfigPriceRule(client, {
      clientSlug,
      locationId: loc,
      category: 'package',
      offeringKey: itemCode,
      unit: billingUnit,
      patch: {
        display_name: `${packLabel || 'Course'} — ${(tier && tier.label) || key}`,
        amount_cents: amountCents,
        currency: 'EUR',
      },
      actor: actor || {},
      forceItemCode: itemCode,
      forceDbUnit: billingUnit,
      skipTransaction: skipTransaction === true,
      // Heal wrong historical units (item/session) onto the canonical grain.
      forceUnitOnUpdate: true,
    });
    results.push({
      tier_key: key,
      ok: !!(out && out.ok !== false),
      item_code: itemCode,
      billing_unit: billingUnit,
      amount_cents: amountCents,
      bookable: true,
      row: out && (out.after || out.row) || null,
    });
  }
  return results;
}

/**
 * Audit packs vs price rules (read-only).
 */
async function auditSunsetPackPriceIdentities(client, { clientSlug, locationId }) {
  const { loadSurfPacksFromDb } = require('./sunset-admin-pack-rules');
  const { loadTenantPriceRuleFromDb } = require('./tenant-business-config');
  const packs = await loadSurfPacksFromDb(client, clientSlug, locationId);
  const report = [];
  for (const pack of packs || []) {
    const tiers = Array.isArray(pack.price_tiers) ? pack.price_tiers : [];
    for (const tier of tiers) {
      const key = String((tier && tier.key) || '').trim();
      if (!key) continue;
      const amountCents = Math.round(Number(tier.amount_cents));
      const itemCode = packPriceItemCode(pack.pack_id, key);
      const billingUnit = billingUnitForSurfPackTier(key);
      let db = null;
      try {
        db = await loadTenantPriceRuleFromDb(client, {
          clientSlug,
          locationId,
          itemType: 'package',
          itemCode,
          duration: '',
          billingUnit,
        });
      } catch (err) {
        db = { status: 'error', detail: err && err.message };
      }
      report.push({
        admin_section: 'surf_packs',
        display_label: `${pack.label || pack.pack_id} — ${(tier && tier.label) || key}`,
        course_id: pack.pack_id,
        tier_key: key,
        offering_id: itemCode,
        item_type: 'package',
        item_code: itemCode,
        expected_unit: billingUnit,
        config_amount_cents: Number.isFinite(amountCents) ? amountCents : null,
        db_status: db && db.status,
        db_amount_cents: db && db.amount_cents != null ? db.amount_cents : null,
        db_unit: db && db.unit != null ? db.unit : null,
        resolvable: !!(db && db.status === 'found' && db.amount_cents > 0),
        needs_sync: !(db && db.status === 'found' && db.amount_cents > 0)
          && Number.isFinite(amountCents) && amountCents > 0,
      });
    }
  }
  return report;
}

module.exports = {
  syncPackTierToPriceRules,
  auditSunsetPackPriceIdentities,
};
