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
 * Fail-closed:
 *   - Pure transform never partial-rewrites: any row error → changed:false + original array.
 *   - --apply uses one transaction: lock all candidates, scan all, then either
 *     update all clean changes + COMMIT, or zero UPDATEs + ROLLBACK.
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

function parseConfigJson(configJson) {
  if (configJson && typeof configJson === 'object' && !Array.isArray(configJson)) {
    return configJson;
  }
  if (typeof configJson === 'string') {
    return JSON.parse(configJson);
  }
  return {};
}

/**
 * Pure transform for one equipment_options array.
 * Fail-closed: if ANY row error / mixed schema / invalid option / normalize
 * mismatch occurs, return errors and changed:false with the original array
 * preserved (deep/byte equivalent — same reference). Never partial rewrite.
 *
 * Returns { changed, options, skipped, errors }.
 */
function reconcileEquipmentOptionsArray(raw) {
  if (!Array.isArray(raw)) {
    return { changed: false, options: raw, skipped: 0, errors: ['not_an_array'] };
  }

  const errors = [];
  const out = [];
  let skipped = 0;

  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
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
      } catch (err) {
        errors.push(String(err.message || err));
        skipped += 1;
      }
      continue;
    }
    errors.push(`missing_prices:${row.offering_key || '?'}`);
    skipped += 1;
  }

  // Any row-level failure → preserve original, never partial rewrite.
  if (errors.length) {
    return {
      changed: false,
      options: raw,
      skipped,
      errors,
    };
  }

  // Final normalize sanity on the fully-built candidate list only.
  const normalized = normalizeEquipmentOptions(out);
  if (normalized.length !== out.length) {
    return {
      changed: false,
      options: raw,
      skipped: 0,
      errors: ['normalize_dropped_rows'],
    };
  }

  const changed = JSON.stringify(raw) !== JSON.stringify(normalized);
  return {
    changed,
    options: changed ? normalized : raw,
    skipped: 0,
    errors: [],
  };
}

function scanRow(kind, row, report, pending) {
  report[`${kind === 'pack' ? 'packs' : 'private'}_scanned`] += 1;
  let cfg;
  try {
    cfg = parseConfigJson(row.config_json);
  } catch (err) {
    report.errors.push({
      kind,
      id: row.id,
      errors: [`config_json_parse:${String(err.message || err)}`],
    });
    return;
  }
  const result = reconcileEquipmentOptionsArray(cfg.equipment_options);
  if (result.errors.length) {
    report.errors.push({ kind, id: row.id, errors: result.errors });
  }
  if (!result.changed) return;
  report[`${kind === 'pack' ? 'packs' : 'private'}_changed`] += 1;
  pending.push({
    kind,
    id: row.id,
    cfg,
    options: result.options,
  });
}

/**
 * Dry-run (default) or transactional apply.
 *
 * Dry-run: scan/report all rows, no writes, no transaction.
 * Apply: BEGIN; lock all candidate rows deterministically (ORDER BY id FOR UPDATE);
 *        scan all; if ANY error → zero UPDATEs + ROLLBACK (blocked);
 *        else update all changed rows + COMMIT.
 * Rolls back on any query/update failure. Preserves config fields outside equipment_options.
 */
async function dryRunOrApply(pg, { apply } = {}) {
  const wantApply = !!apply;
  const report = {
    apply: wantApply,
    packs_scanned: 0,
    packs_changed: 0,
    private_scanned: 0,
    private_changed: 0,
    errors: [],
    blocked: false,
    committed: false,
    rolled_back: false,
  };

  let client = pg;
  let release = null;
  if (pg && typeof pg.connect === 'function') {
    client = await pg.connect();
    release = typeof client.release === 'function' ? () => client.release() : null;
  }

  const pending = [];
  let begun = false;

  try {
    if (wantApply) {
      await client.query('BEGIN');
      begun = true;
    }

    const lockClause = wantApply ? ' FOR UPDATE' : '';
    const packs = await client.query(
      `SELECT id::text AS id, client_slug, location_id, config_json
         FROM tenant_surf_pack_rules
        WHERE config_json ? 'equipment_options'
        ORDER BY id${lockClause}`,
    );
    const privates = await client.query(
      `SELECT id::text AS id, client_slug, location_id, config_json
         FROM tenant_private_lesson_rules
        WHERE config_json ? 'equipment_options'
        ORDER BY id${lockClause}`,
    );

    // First scan all candidates (after locks when applying).
    for (const row of packs.rows || []) {
      scanRow('pack', row, report, pending);
    }
    for (const row of privates.rows || []) {
      scanRow('private', row, report, pending);
    }

    // Fail-closed across the whole batch: any error → no UPDATEs.
    if (report.errors.length) {
      report.blocked = true;
      if (begun) {
        await client.query('ROLLBACK');
        begun = false;
        report.rolled_back = true;
      }
      return report;
    }

    if (wantApply) {
      for (const item of pending) {
        const next = { ...item.cfg, equipment_options: item.options };
        const table = item.kind === 'pack'
          ? 'tenant_surf_pack_rules'
          : 'tenant_private_lesson_rules';
        await client.query(
          `UPDATE ${table}
              SET config_json = $1::jsonb, updated_at = NOW()
            WHERE id = $2::uuid`,
          [JSON.stringify(next), item.id],
        );
      }
      await client.query('COMMIT');
      begun = false;
      report.committed = true;
    }

    return report;
  } catch (err) {
    if (begun) {
      try {
        await client.query('ROLLBACK');
        report.rolled_back = true;
      } catch (_) { /* ignore rollback errors */ }
      begun = false;
    }
    throw err;
  } finally {
    if (release) {
      try { release(); } catch (_) { /* ignore */ }
    }
  }
}

// Pure unit self-check when run without DATABASE_URL.
function selfCheck() {
  const legacy = [
    { offering_key: 'softboard', equipment_price_cents: 500, all_day_surcharge_cents: 1000 },
  ];
  const result = reconcileEquipmentOptionsArray(legacy);
  if (!result.changed) throw new Error('expected legacy rewrite');
  if (result.errors.length) throw new Error('legacy must be clean');
  if (result.options[0].during_course_price_cents !== 500) throw new Error('during mismatch');
  if (result.options[0].all_day_price_cents !== 1000) {
    throw new Error('all day must be independent 1000 not 1500');
  }

  const mixedRow = {
    offering_key: 'x',
    equipment_price_cents: 1,
    during_course_price_cents: 1,
    all_day_price_cents: 1,
    all_day_surcharge_cents: 1,
  };
  const mixedOriginal = [mixedRow];
  const mixed = reconcileEquipmentOptionsArray(mixedOriginal);
  if (!mixed.errors.length) throw new Error('mixed schema must error');
  if (mixed.changed) throw new Error('mixed schema must not report changed');
  if (mixed.options !== mixedOriginal) throw new Error('mixed must preserve original array reference');
  if (JSON.stringify(mixed.options) !== JSON.stringify(mixedOriginal)) {
    throw new Error('mixed must preserve original array deep-equivalent');
  }

  // One good legacy + one bad → no partial rewrite of the good row.
  const partial = [
    { offering_key: 'softboard', equipment_price_cents: 500, all_day_surcharge_cents: 1000 },
    mixedRow,
  ];
  const partialResult = reconcileEquipmentOptionsArray(partial);
  if (partialResult.changed) throw new Error('partial bad array must not change');
  if (partialResult.options !== partial) throw new Error('partial bad must preserve original');
  if (!partialResult.errors.some((e) => String(e).includes('mixed_schema'))) {
    throw new Error('partial bad must surface mixed_schema');
  }

  // Invalid row alone fails closed.
  const invalid = [null, 'x'];
  const invalidResult = reconcileEquipmentOptionsArray(invalid);
  if (invalidResult.changed || invalidResult.options !== invalid) {
    throw new Error('invalid rows must preserve original with changed:false');
  }

  // Already-canonical clean → changed false, same reference.
  const canonical = [{
    offering_key: 'softboard',
    during_course_price_cents: 500,
    all_day_price_cents: 1000,
  }];
  const canonResult = reconcileEquipmentOptionsArray(canonical);
  if (canonResult.changed) throw new Error('canonical clean must be unchanged');
  if (canonResult.options !== canonical) throw new Error('canonical clean must keep original ref');
  if (canonResult.errors.length) throw new Error('canonical clean must have no errors');

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
      if (report.blocked) {
        console.error('Reconciliation blocked: errors present; zero updates applied');
        return pool.end().then(() => process.exit(1));
      }
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
  selfCheck,
};
