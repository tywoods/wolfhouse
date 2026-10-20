'use strict';

// Fresh install and upgrade of the Crow's Nest number-route audit identity
// columns. Uses the real migration files, the real audit store, and the real
// rollback API. No network, installer, or host command.

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const routing = require('./lib/crowsnest/crowsnest-luna-number-routing');

const root = path.join(__dirname, '..');
const baseSql = cp.execFileSync('git', ['show', '6d3ffb48:database/migrations/103_crowsnest_comms_number_route_audit.sql'], {
  cwd: root,
  encoding: 'utf8',
});
const currentSql = fs.readFileSync(path.join(root, 'database/migrations/103_crowsnest_comms_number_route_audit.sql'), 'utf8');
const upgradeSql = fs.readFileSync(path.join(root, 'database/migrations/113_crowsnest_comms_number_route_identity_upgrade.sql'), 'utf8');
const historicalId = '22222222-2222-4222-8222-222222222222';
const eventId = '44444444-4444-4444-8444-444444444444';
const revision = 'b'.repeat(64);
const historicalResponse = { ok: true, idempotent: true, fixture: 'historical-audit-only' };
const phoneId = '123456780003';
const e164 = '+1' + '555555' + '0103';
const display = '+1 ' + '555' + ' 555 ' + '0103';
const actor = { account_id: 'earthling', username: 'offline-fixture' };

function runtimeEnv() {
  return {
    NODE_ENV: 'staging',
    CROWSNEST_ENVIRONMENT: 'staging',
    CROWSNEST_LUNA_ROUTING_CONTROLLER_URL: 'https://controller.test/_internal/luna-routing/v1/routes/meta-whatsapp-verified-webhook',
    CROWSNEST_LUNA_ROUTING_CONTROLLER_HMAC_KEY: 'k'.repeat(32),
    CROWSNEST_COMMS_DATABASE_URL: 'postgres://audit',
  };
}

function selectedEnv() {
  return {
    ...runtimeEnv(),
    WA_PHONE_NUMBER_ID: phoneId,
    WA_BUSINESS_ACCOUNT_ID: '123456780001',
    WA_APP_ID: '123456780002',
    LUNA_STAGING_WHATSAPP_NUMBER_E164: e164,
    LUNA_STAGING_WHATSAPP_NUMBER_DISPLAY: display,
  };
}

function poolFor(db) {
  return {
    async connect() {
      return {
        async query(sql, params) {
          const result = await db.query(sql, params);
          return { ...result, rowCount: result.rowCount === undefined ? result.affectedRows : result.rowCount };
        },
        release() {},
      };
    },
    async end() {},
  };
}

async function openDb() {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec('CREATE ROLE crowsnest_comms_owner NOLOGIN; CREATE ROLE crowsnest_api NOLOGIN; GRANT CREATE ON DATABASE postgres TO crowsnest_comms_owner;');
  return db;
}

async function exercise(kind, statements, { history }) {
  const db = await openDb();
  let beforeOps = [];
  let beforeEvents = [];
  if (history) {
    await db.exec(baseSql);
    await db.query(
      `INSERT INTO crowsnest_comms.number_route_operations
        (operation_id, action, expected_revision, actor_account_id, actor_username, state, response)
       VALUES ($1, 'rollback_to_wolfhouse', $2, 'earthling', 'offline-fixture', 'succeeded', $3::jsonb)`,
      [historicalId, revision, JSON.stringify(historicalResponse)]
    );
    await db.query(
      `INSERT INTO crowsnest_comms.number_route_events
        (event_id, operation_id, sequence_no, event_type, actor_account_id, actor_username, action, expected_revision, details)
       VALUES ($1, $2, 1, 'requested', 'earthling', 'offline-fixture', 'rollback_to_wolfhouse', $3, '{}'::jsonb)`,
      [eventId, historicalId, revision]
    );
    beforeOps = (await db.query('SELECT operation_id, action, expected_revision, actor_account_id, actor_username, state, response FROM crowsnest_comms.number_route_operations ORDER BY operation_id')).rows;
    beforeEvents = (await db.query('SELECT event_id, operation_id, sequence_no, event_type, actor_account_id, actor_username, action, expected_revision, details FROM crowsnest_comms.number_route_events ORDER BY event_id')).rows;
  }
  for (const sql of statements) await db.exec(sql);
  const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='crowsnest_comms' AND table_name='number_route_operations'")).rows.map((row) => row.column_name);
  assert.equal(columns.includes('number_id') && columns.includes('phone_number_id') && columns.includes('number_e164'), true, kind);
  const constraint = await db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='number_route_identity_complete'");
  assert.equal(constraint.rows.length, 1, kind);
  assert.match(constraint.rows[0].def, /number_id IS NULL/, kind);
  if (history) {
    const afterOps = (await db.query('SELECT operation_id, action, expected_revision, actor_account_id, actor_username, state, response, number_id, phone_number_id, number_e164 FROM crowsnest_comms.number_route_operations WHERE operation_id=$1', [historicalId])).rows;
    assert.deepEqual({
      operation_id: afterOps[0].operation_id,
      action: afterOps[0].action,
      expected_revision: afterOps[0].expected_revision,
      actor_account_id: afterOps[0].actor_account_id,
      actor_username: afterOps[0].actor_username,
      state: afterOps[0].state,
      response: afterOps[0].response,
    }, beforeOps[0], kind);
    assert.equal(afterOps[0].number_id, null, kind);
    assert.equal(afterOps[0].phone_number_id, null, kind);
    assert.equal(afterOps[0].number_e164, null, kind);
    const afterEvents = (await db.query('SELECT event_id, operation_id, sequence_no, event_type, actor_account_id, actor_username, action, expected_revision, details FROM crowsnest_comms.number_route_events ORDER BY event_id')).rows;
    assert.deepEqual(afterEvents, beforeEvents, kind);
  }
  let emptyRejected = false;
  try {
    await db.query(
      `INSERT INTO crowsnest_comms.number_route_operations
        (operation_id, action, expected_revision, actor_account_id, actor_username, number_id, phone_number_id, number_e164, state)
       VALUES ($1, 'rollback_to_wolfhouse', $2, 'earthling', 'offline-fixture', '', '', '', 'succeeded')`,
      [crypto.randomUUID(), 'd'.repeat(64)]
    );
  } catch (error) {
    emptyRejected = error.code === '23514';
  }
  assert.equal(emptyRejected, true, kind + ':empty-identity');
  let transportCalls = 0;
  const transport = async () => {
    transportCalls += 1;
    return { ok: true, status: 200, json: async () => ({ ok: true, idempotent: true, fixture: 'no-controller-or-host' }) };
  };
  const pool = poolFor(db);
  if (history) {
    const replay = await routing.rollbackLunaNumberRoute(
      { operation_id: historicalId, expected_revision: revision },
      actor,
      { env: runtimeEnv(), poolFactory: () => pool, transport }
    );
    assert.deepEqual(replay, historicalResponse, kind + ':unselected-replay');
    assert.equal(transportCalls, 0, kind + ':unselected-replay-io');
    const conflict = await routing.rollbackLunaNumberRoute(
      {
        operation_id: historicalId,
        expected_revision: revision,
        number_id: phoneId,
        phone_number_id: phoneId,
        number_e164: e164,
      },
      actor,
      { env: selectedEnv(), poolFactory: () => pool, transport }
    );
    assert.equal(conflict.status, 409, kind + ':null-not-wildcard');
    assert.equal(conflict.code, 'operation_id_conflict', kind + ':null-not-wildcard');
    assert.equal(transportCalls, 0, kind + ':null-not-wildcard-io');
  }
  const created = await routing.rollbackLunaNumberRoute(
    {
      operation_id: crypto.randomUUID(),
      expected_revision: 'a'.repeat(64),
      number_id: phoneId,
      phone_number_id: phoneId,
      number_e164: e164,
    },
    actor,
    { env: selectedEnv(), poolFactory: () => pool, transport }
  );
  assert.equal(created.ok, true, kind + ':' + JSON.stringify(created));
  assert.equal(transportCalls, 1, kind + ':fresh-io');
  if (history) {
    const still = (await db.query('SELECT number_id, phone_number_id, number_e164, response FROM crowsnest_comms.number_route_operations WHERE operation_id=$1', [historicalId])).rows[0];
    assert.equal(still.number_id, null, kind);
    assert.equal(still.phone_number_id, null, kind);
    assert.equal(still.number_e164, null, kind);
    assert.deepEqual(still.response, historicalResponse, kind);
  }
  await db.close();
}

(async () => {
  const bare = await openDb();
  let missing = false;
  try {
    await bare.exec(upgradeSql);
  } catch (error) {
    missing = /number_route_operations is missing/.test(String(error.message || error));
  }
  assert.equal(missing, true, 'migration 113 must not invent the audit table');
  await bare.close();
  await exercise('fresh-103', [currentSql, currentSql], { history: false });
  await exercise('fresh-103-then-113', [currentSql, upgradeSql], { history: false });
  await exercise('upgrade-rerun-103', [currentSql, currentSql], { history: true });
  await exercise('upgrade-113-only', [upgradeSql, upgradeSql], { history: true });
  console.log('PASS existing audit identity upgrade');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
