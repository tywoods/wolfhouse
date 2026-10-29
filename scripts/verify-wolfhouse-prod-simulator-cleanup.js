#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { cleanup, TEST_PHONE_RE } = require('./lib/wolfhouse-prod-simulator-cleanup');

function fakeClient(database = 'wolfhouse_prod', tenantRows = [{ id: 'tenant-1' }]) {
  const calls = [];
  return { calls, async query(sql, args = []) {
    calls.push({ sql, args });
    if (sql.includes('current_database()')) return { rows: [{ database_name: database }], rowCount: 1 };
    if (sql.includes('SELECT id FROM clients')) return { rows: tenantRows, rowCount: tenantRows.length };
    if (sql.startsWith('SELECT id, phone')) return { rows: [{ id: 'safe-id', phone: '+346' + '997770001' }], rowCount: 1 };
    if (sql.startsWith('DELETE FROM')) return { rows: [{ id: 'safe-id' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
}

async function main() {
  assert.strictEqual(TEST_PHONE_RE, '^\\+346' + '99777[0-9]{4}$');
  await assert.rejects(() => cleanup(fakeClient('postgres')), /database is not wolfhouse_prod/);
  await assert.rejects(() => cleanup(fakeClient('wolfhouse_prod', [])), /exactly one wolfhouse-somo client/);
  const dry = fakeClient();
  assert.strictEqual((await cleanup(dry)).mode, 'dry-list');
  assert.strictEqual(dry.calls.some((call) => call.sql.startsWith('DELETE')), false);
  const apply = fakeClient();
  const result = await cleanup(apply, { deleteConfirmed: true });
  assert.deepStrictEqual(result.deleted, { chats: 1, bookings: 1, guests: 1, customers: 1 });
  const deletes = apply.calls.filter((call) => call.sql.startsWith('DELETE'));
  assert.strictEqual(deletes.length, 4);
  assert.ok(deletes.every((call) => call.sql.includes('client_id = $1') && call.sql.includes('phone ~ $2') && call.sql.includes('@> $3::jsonb')));
  assert.ok(apply.calls.some((call) => call.sql === 'BEGIN') && apply.calls.some((call) => call.sql === 'COMMIT'));
  console.log('verify:wolfhouse-prod-simulator-cleanup passed');
}

main().catch((error) => { console.error(error.stack || error); process.exit(1); });
