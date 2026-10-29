'use strict';

/**
 * Natural-key unique indexes on config tables (from 001/003 + 076).
 * Import must drop dest rows that collide on these keys (migration seeds
 * with different UUIDs) before ON CONFLICT (id), then drop leftovers so
 * dest equals the source envelope.
 */

const NATURAL_KEYS = Object.freeze({
  clients: Object.freeze({ columns: Object.freeze(['slug']) }),
  rooms: Object.freeze({ columns: Object.freeze(['client_id', 'room_code']) }),
  beds: Object.freeze({ columns: Object.freeze(['client_id', 'bed_code']) }),
  wh_pricing_seasons: Object.freeze({
    columns: Object.freeze(['client_slug', 'code']),
    activeOnly: true,
  }),
  wh_pricing_items: Object.freeze({
    columns: Object.freeze(['client_slug', 'item_type', 'item_code']),
    activeOnly: true,
  }),
  wh_pricing_rules: Object.freeze({
    columns: Object.freeze(['client_slug', 'item_type', 'item_code', 'season_code']),
    coalesce: Object.freeze({ season_code: '' }),
    activeOnly: true,
  }),
  wh_pricing_transfer_rules: Object.freeze({
    columns: Object.freeze(['client_slug', 'airport_code']),
    activeOnly: true,
  }),
});

function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

function naturalKeyValue(spec, row, column) {
  const value = row[column];
  if (spec.coalesce && Object.prototype.hasOwnProperty.call(spec.coalesce, column)) {
    return value == null ? spec.coalesce[column] : value;
  }
  return value;
}

function naturalKeyToken(spec, row) {
  return spec.columns.map((column) => String(naturalKeyValue(spec, row, column))).join('\0');
}

function assertNaturalKeys(tables) {
  if (!tables || typeof tables !== 'object') fail('invalid_envelope');
  for (const table of Object.keys(NATURAL_KEYS)) {
    const spec = NATURAL_KEYS[table];
    const rows = tables[table];
    if (!Array.isArray(rows)) continue;
    const seen = new Set();
    for (const row of rows) {
      if (!row || typeof row !== 'object') fail('invalid_row:' + table);
      if (spec.activeOnly && row.active === false) continue;
      const token = naturalKeyToken(spec, row);
      if (seen.has(token)) fail('duplicate_natural_key:' + table);
      seen.add(token);
    }
  }
  return true;
}

function tenantPredicate(table) {
  if (table === 'clients') return 'slug = $1';
  if (table.startsWith('wh_')) return 'client_slug = $1';
  return 'client_id = (SELECT id FROM clients WHERE slug = $1)';
}

async function deleteStale(tx, table, tenant, keepIds) {
  const pred = tenantPredicate(table);
  if (!keepIds.length) {
    await tx.query('DELETE FROM ' + table + ' WHERE ' + pred, [tenant]);
    return;
  }
  await tx.query(
    'DELETE FROM ' + table + ' WHERE ' + pred + ' AND NOT (id = ANY($2::uuid[]))',
    [tenant, keepIds],
  );
}

async function reconcileStale(tx, tables, order, tenant) {
  if (typeof tx.query !== 'function') return;
  const reverse = order.slice().reverse();
  for (const table of reverse) {
    const rows = tables[table] || [];
    const keepIds = rows.map((row) => row.id).filter(Boolean);
    await deleteStale(tx, table, tenant, keepIds);
  }
}

module.exports = {
  NATURAL_KEYS,
  assertNaturalKeys,
  reconcileStale,
};
