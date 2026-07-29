'use strict';

/**
 * Safe reconciliation script — course equipment option schema.
 *
 * Legacy JSON pair on Group/Private course config:
 *   { equipment_price_cents, all_day_surcharge_cents }
 * is rewritten to independent totals:
 *   { during_course_price_cents, all_day_price_cents }
 *
 * Interpretation: the legacy pair is already independent unit totals (€5 / €10),
 * NEVER base + surcharge (€15). This script only rewrites field names.
 *
 * DO NOT run against production without operator approval.
 * This module is intentionally inert unless invoked with --apply and a DATABASE_URL.
 *
 * Usage (dry-run default):
 *   node scripts/reconcile-course-equipment-option-prices.js
 *   node scripts/reconcile-course-equipment-option-prices.js --apply
 */

const {
  resolveEquipmentOptionMoney,
  normalizeEquipmentOptions,
} = require('./lib/sunset-course-equipment-options');

function hasLegacyFields(row) {
  if (!row || typeof row !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(row, 'equipment_price_cents')
    || Object.prototype.hasOwnProperty.call(row, 'all_day_surcharge_cents');
}

function hasCanonicalFields(row) {
  if (!row || typeof row !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(row, 'during_course_price_cents')
    || Object.prototype.hasOwnProperty.call(row, 'all_day_price_cents');
}

/**
 * Pure transform for one equipment_options array.
 * Returns { changed, options, skipped, errors }.
 */
function reconcileEquipmentOptionsArray(raw) {
  if (!Array.isArray(raw)) {
    return { changed: false, options: raw, skipped: 0, errors: ['not_an_array'] };
  }
  const errors = [];
  const out = [];
  let changed = false;
  let skipped = 0;
  for (const row of raw) {
    if (!row || typeof row !== 'object') {
      errors.push('invalid_row');
      skipped += 1;
      continue;
    }
    if (hasCanonicalFields(row) && hasLegacyFields(row)) {
      errors.push(`mixed_schema:${row.offering_key || '?'}`);
      skipped += 1;
      continue;
    }
    if (hasCanonicalFields(row) && !hasLegacyFields(row)) {
      try {
        out.push(resolveEquipmentOptionMoney(row));
      } catch (err) {
        errors.push(String(err.message || err));
        skipped += 1;
      }
      continue;
    }
    if (hasLegacyFields(row)) {
      try {
        out.push(resolveEquipmentOptionMoney(row));
        changed = true;
      } catch (err) {
        errors.push(String(err.message || err));
        skipped += 1;
      }
      continue;
    }
    errors.push(`missing_prices:${row.offering_key || '?'}`);
    skipped += 1;
  }
  // Prefer normalize as final sanity (canonical only).
  const normalized = normalizeEquipmentOptions(out);
  if (normalized.length !== out.length && out.length) {
    errors.push('normalize_dropped_rows');
  }
  return {
    changed: changed || (JSON.stringify(raw) !== JSON.stringify(normalized) && normalized.length > 0),
    options: normalized.length ? normalized : out,
    skipped,
    errors,
  };
}

async function dryRunOrApply(pg, { apply }) {
  const report = {
    apply: !!apply,
    packs_scanned: 0,
    packs_changed: 0,
    private_scanned: 0,
    private_changed: 0,
    errors: [],
  };

  const packs = await pg.query(
    `SELECT id::text AS id, client_slug, location_id, config_json
       FROM tenant_surf_pack_rules
      WHERE config_json ? 'equipment_options'`,
  );
  for (const row of packs.rows || []) {
    report.packs_scanned += 1;
    const cfg = row.config_json && typeof row.config_json === 'object'
      ? row.config_json
      : (typeof row.config_json === 'string' ? JSON.parse(row.config_json) : {});
    const result = reconcileEquipmentOptionsArray(cfg.equipment_options);
    if (result.errors.length) {
      report.errors.push({ kind: 'pack', id: row.id, errors: result.errors });
    }
    if (!result.changed) continue;
    report.packs_changed += 1;
    if (apply) {
      const next = { ...cfg, equipment_options: result.options };
      await pg.query(
        `UPDATE tenant_surf_pack_rules
            SET config_json = $1::jsonb, updated_at = NOW()
          WHERE id = $2::uuid`,
        [JSON.stringify(next), row.id],
      );
    }
  }

  const privates = await pg.query(
    `SELECT id::text AS id, client_slug, location_id, config_json
       FROM tenant_private_lesson_rules
      WHERE config_json ? 'equipment_options'`,
  );
  for (const row of privates.rows || []) {
    report.private_scanned += 1;
    const cfg = row.config_json && typeof row.config_json === 'object'
      ? row.config_json
      : (typeof row.config_json === 'string' ? JSON.parse(row.config_json) : {});
    const result = reconcileEquipmentOptionsArray(cfg.equipment_options);
    if (result.errors.length) {
      report.errors.push({ kind: 'private', id: row.id, errors: result.errors });
    }
    if (!result.changed) continue;
    report.private_changed += 1;
    if (apply) {
      const next = { ...cfg, equipment_options: result.options };
      await pg.query(
        `UPDATE tenant_private_lesson_rules
            SET config_json = $1::jsonb, updated_at = NOW()
          WHERE id = $2::uuid`,
        [JSON.stringify(next), row.id],
      );
    }
  }

  return report;
}

// Pure unit self-check when run without DATABASE_URL.
function selfCheck() {
  const legacy = [
    { offering_key: 'softboard', equipment_price_cents: 500, all_day_surcharge_cents: 1000 },
  ];
  const result = reconcileEquipmentOptionsArray(legacy);
  if (!result.changed) throw new Error('expected legacy rewrite');
  if (result.options[0].during_course_price_cents !== 500) throw new Error('during mismatch');
  if (result.options[0].all_day_price_cents !== 1000) throw new Error('all day must be independent 1000 not 1500');
  const mixed = reconcileEquipmentOptionsArray([{
    offering_key: 'x',
    equipment_price_cents: 1,
    during_course_price_cents: 1,
    all_day_price_cents: 1,
    all_day_surcharge_cents: 1,
  }]);
  if (!mixed.errors.length) throw new Error('mixed schema must error');
  console.log('reconcile-course-equipment-option-prices self-check OK (no DB mutation)');
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  if (!process.env.DATABASE_URL) {
    selfCheck();
    if (apply) {
      console.error('Refusing --apply without DATABASE_URL');
      process.exit(2);
    }
    process.exit(0);
  }
  // Lazy require so pure self-check never loads pg.
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  dryRunOrApply(pool, { apply })
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      return pool.end();
    })
    .catch(async (err) => {
      console.error(err);
      try { await pool.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}

module.exports = {
  reconcileEquipmentOptionsArray,
  dryRunOrApply,
  hasLegacyFields,
  hasCanonicalFields,
};
