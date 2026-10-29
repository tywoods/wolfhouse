'use strict';

const EXPECTED_DATABASE = 'wolfhouse_prod';
const EXPECTED_CLIENT_SLUG = 'wolfhouse-somo';
const TEST_PHONE_RE = '^\\+346' + '99777[0-9]{4}$';
const TEST_MARKER = Object.freeze({ test: true, source: 'crowsnest_live_simulator' });
const TEST_MARKER_JSON = JSON.stringify(TEST_MARKER);

function taggedWhere(alias) {
  return `${alias}.client_id = $1 AND ${alias}.phone ~ $2 AND ${alias}.metadata @> $3::jsonb`;
}

async function assertScope(client) {
  const db = await client.query('SELECT current_database() AS database_name');
  if (!db.rows[0] || db.rows[0].database_name !== EXPECTED_DATABASE) {
    throw new Error('refusing cleanup: database is not wolfhouse_prod');
  }
  const tenant = await client.query('SELECT id FROM clients WHERE slug = $1', [EXPECTED_CLIENT_SLUG]);
  if (tenant.rowCount !== 1) throw new Error('refusing cleanup: expected exactly one wolfhouse-somo client');
  return tenant.rows[0].id;
}

async function inventory(client, clientId) {
  const args = [clientId, TEST_PHONE_RE, TEST_MARKER_JSON];
  const result = {};
  for (const [name, table] of [['chats', 'conversations'], ['bookings', 'bookings'], ['guests', 'guests']]) {
    const found = await client.query(`SELECT id, phone FROM ${table} x WHERE ${taggedWhere('x')} ORDER BY id`, args);
    result[name] = found.rows;
  }
  const customers = await client.query('SELECT id, phone FROM customers x WHERE x.client_id = $1 AND x.phone ~ $2 AND x.crm_tags @> $3::jsonb ORDER BY id', args);
  result.customers = customers.rows;
  return result;
}

async function cleanup(client, { deleteConfirmed = false } = {}) {
  const clientId = await assertScope(client);
  const before = await inventory(client, clientId);
  if (!deleteConfirmed) return { mode: 'dry-list', before };
  const args = [clientId, TEST_PHONE_RE, TEST_MARKER_JSON];
  await client.query('BEGIN');
  try {
    const deleted = {};
    for (const [name, table] of [['chats', 'conversations'], ['bookings', 'bookings'], ['guests', 'guests']]) {
      const result = await client.query(`DELETE FROM ${table} x WHERE ${taggedWhere('x')} RETURNING id`, args);
      deleted[name] = result.rowCount;
    }
    const customers = await client.query('DELETE FROM customers x WHERE x.client_id = $1 AND x.phone ~ $2 AND x.crm_tags @> $3::jsonb RETURNING id', args);
    deleted.customers = customers.rowCount;
    await client.query('COMMIT');
    return { mode: 'delete', before, deleted };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

module.exports = { EXPECTED_DATABASE, EXPECTED_CLIENT_SLUG, TEST_PHONE_RE, TEST_MARKER, assertScope, inventory, cleanup };
