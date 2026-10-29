'use strict';

/**
 * Natural-key unique indexes on config tables (from 001/003 + 076).
 *
 * Import may not DELETE/UPDATE a dest row when that would cascade into
 * excluded tables (conversations, staff, bookings, …) or steal a UUID
 * owned by another tenant. Unique-key transitions park dest keys first
 * so retained-id swaps converge instead of 23505.
 */

const NATURAL_KEYS = Object.freeze({
  clients: Object.freeze({ columns: Object.freeze(['slug']) }),
  rooms: Object.freeze({
    columns: Object.freeze(['client_id', 'room_code']),
    parkColumn: 'room_code',
  }),
  beds: Object.freeze({
    columns: Object.freeze(['client_id', 'bed_code']),
    parkColumn: 'bed_code',
  }),
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

const OPERATIONAL_TABLES = Object.freeze([
  'bookings',
  'guests',
  'payments',
  'messages',
  'auth_sessions',
]);

const PARK_PREFIX = '__wh_rec__';

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

function allowlistSet(order) {
  const set = Object.create(null);
  for (const name of order) set[name] = true;
  return set;
}

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) fail('invalid_identifier');
  return name;
}

async function tableExists(tx, name) {
  const res = await tx.query(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
    ['public', name],
  );
  return !!(res.rows && res.rows.length);
}

async function lockOperational(tx) {
  for (const name of OPERATIONAL_TABLES) {
    if (await tableExists(tx, name)) {
      await tx.query('LOCK TABLE ' + quoteIdent(name) + ' IN SHARE ROW EXCLUSIVE MODE');
    }
  }
}

async function assertOperationalEmpty(tx) {
  if (typeof tx.counts !== 'function') return;
  const counts = await tx.counts();
  for (const key of Object.keys(counts || {})) {
    if (Number(counts[key]) !== 0) fail('destination_operational_nonzero');
  }
}

async function excludedForeignKeys(tx, parentTable, allowlist) {
  const res = await tx.query(
    'SELECT c.relname AS child_table, a.attname AS child_column'
    + ' FROM pg_constraint con'
    + ' JOIN pg_class p ON p.oid = con.confrelid'
    + ' JOIN pg_class c ON c.oid = con.conrelid'
    + ' JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]'
    + ' WHERE con.contype = $1 AND p.relname = $2',
    ['f', parentTable],
  );
  const out = [];
  for (const row of res.rows || []) {
    if (allowlist[row.child_table]) continue;
    out.push({ child: row.child_table, column: row.child_column });
  }
  return out;
}

async function staleIds(tx, table, tenant, keepIds) {
  const pred = tenantPredicate(table);
  const res = keepIds.length
    ? await tx.query(
      'SELECT id FROM ' + quoteIdent(table) + ' WHERE ' + pred + ' AND NOT (id = ANY($2::uuid[]))',
      [tenant, keepIds],
    )
    : await tx.query(
      'SELECT id FROM ' + quoteIdent(table) + ' WHERE ' + pred,
      [tenant],
    );
  return (res.rows || []).map((row) => row.id);
}

async function assertSafeToDelete(tx, table, tenant, keepIds, allowlist) {
  const ids = await staleIds(tx, table, tenant, keepIds);
  if (!ids.length) return;
  const fks = await excludedForeignKeys(tx, table, allowlist);
  for (const fk of fks) {
    if (!(await tableExists(tx, fk.child))) continue;
    await tx.query('LOCK TABLE ' + quoteIdent(fk.child) + ' IN SHARE ROW EXCLUSIVE MODE');
    const counted = await tx.query(
      'SELECT count(*)::int AS n FROM ' + quoteIdent(fk.child)
      + ' WHERE ' + quoteIdent(fk.column) + ' = ANY($1::uuid[])',
      [ids],
    );
    if (Number(counted.rows[0].n) > 0) fail('protected_dependent');
  }
}

async function destOwnerSlug(tx, table, dest) {
  if (table === 'clients') return dest.slug || null;
  if (table.startsWith('wh_')) return dest.client_slug || null;
  if (!dest.client_id) return null;
  const owner = await tx.query('SELECT slug FROM clients WHERE id = $1', [dest.client_id]);
  return owner.rows && owner.rows[0] ? owner.rows[0].slug : null;
}

async function assertIncomingOwnership(tx, tables, order, tenant) {
  for (const table of order) {
    const ids = (tables[table] || []).map((row) => row.id).filter(Boolean);
    if (!ids.length) continue;
    if (!(await tableExists(tx, table))) continue;
    const existing = await tx.query(
      'SELECT * FROM ' + quoteIdent(table) + ' WHERE id = ANY($1::uuid[])',
      [ids],
    );
    for (const dest of existing.rows || []) {
      const slug = await destOwnerSlug(tx, table, dest);
      if (slug && slug !== tenant) fail('uuid_owned_by_other_tenant');
    }
  }
}

async function parkUniqueKeys(tx, table, tenant) {
  const spec = NATURAL_KEYS[table];
  if (!spec) return;
  const pred = tenantPredicate(table);
  if (spec.activeOnly) {
    await tx.query(
      'UPDATE ' + quoteIdent(table) + ' SET active = false WHERE ' + pred + ' AND active = true',
      [tenant],
    );
    return;
  }
  if (!spec.parkColumn) return;
  await tx.query(
    'UPDATE ' + quoteIdent(table) + ' SET ' + quoteIdent(spec.parkColumn)
    + ' = $2 || id::text WHERE ' + pred,
    [tenant, PARK_PREFIX],
  );
}

async function deleteStale(tx, table, tenant, keepIds) {
  const pred = tenantPredicate(table);
  if (!keepIds.length) {
    await tx.query('DELETE FROM ' + quoteIdent(table) + ' WHERE ' + pred, [tenant]);
    return;
  }
  await tx.query(
    'DELETE FROM ' + quoteIdent(table) + ' WHERE ' + pred + ' AND NOT (id = ANY($2::uuid[]))',
    [tenant, keepIds],
  );
}

async function reconcileStale(tx, tables, order, tenant) {
  if (typeof tx.query !== 'function') return;
  const allowlist = allowlistSet(order);
  await lockOperational(tx);
  await assertOperationalEmpty(tx);
  await assertIncomingOwnership(tx, tables, order, tenant);
  const reverse = order.slice().reverse();
  for (const table of reverse) {
    const keepIds = (tables[table] || []).map((row) => row.id).filter(Boolean);
    await assertSafeToDelete(tx, table, tenant, keepIds, allowlist);
  }
  for (const table of order) {
    await parkUniqueKeys(tx, table, tenant);
  }
  for (const table of reverse) {
    const keepIds = (tables[table] || []).map((row) => row.id).filter(Boolean);
    await deleteStale(tx, table, tenant, keepIds);
  }
}

module.exports = {
  NATURAL_KEYS,
  assertNaturalKeys,
  reconcileStale,
};
