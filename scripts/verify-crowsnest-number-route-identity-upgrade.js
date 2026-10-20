'use strict';

// Fresh install and upgrade of the Crow's Nest number-route audit identity
// columns. Uses the real migration files, the real audit store, and the real
// rollback API. No network, installer, or host command. A partial null tuple
// must be check-constraint 23514, including after replacing R3's same-name
// weak check. Historical all-null rows are not backfilled.

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
const r3Sql = cp.execFileSync('git', ['show', '02ce33c7:database/migrations/103_crowsnest_comms_number_route_audit.sql'], {
  cwd: root,
  encoding: 'utf8',
});
const identityPredicate = "(number_id IS NULL AND phone_number_id IS NULL AND number_e164 IS NULL) OR ( number_id IS NOT NULL AND number_id <> '' AND phone_number_id IS NOT NULL AND phone_number_id <> '' AND number_e164 IS NOT NULL AND number_e164 <> '' )";
function flat(sql) {
  return sql.replace(/\s+/g, ' ');
}
assert.equal(flat(currentSql).split(identityPredicate).length - 1, 2);
assert.equal(flat(upgradeSql).split(identityPredicate).length - 1, 1);
assert.match(currentSql, /DROP CONSTRAINT IF EXISTS number_route_identity_complete/);
assert.match(upgradeSql, /DROP CONSTRAINT IF EXISTS number_route_identity_complete/);
assert.doesNotMatch(currentSql, /IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/);
assert.doesNotMatch(upgradeSql, /IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/);
assert.doesNotMatch(r3Sql, /number_id IS NOT NULL/);
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

async function rejectIdentity(db, kind, tuple) {
  let code = null;
  try {
    await db.query(
      `INSERT INTO crowsnest_comms.number_route_operations
        (operation_id, action, expected_revision, actor_account_id, actor_username, number_id, phone_number_id, number_e164, state)
       VALUES ($1, 'rollback_to_wolfhouse', $2, 'earthling', 'offline-fixture', $3, $4, $5, 'succeeded')`,
      [crypto.randomUUID(), 'd'.repeat(64), ...tuple]
    );
  } catch (error) {
    code = error.code;
  }
  assert.equal(code, '23514', kind + ':' + JSON.stringify(tuple));
}

async function assertIdentityContract(db, kind) {
  const samples = [
    [null, '', phoneId],
    [null, '', phoneId],
    [null, '', e164],
  ];
  let seen = 0;
  for (const numberId of samples[0]) {
    for (const phoneNumberId of samples[1]) {
      for (const numberE164 of samples[2]) {
        const tuple = [numberId, phoneNumberId, numberE164];
        const complete = tuple.every((value) => value === null) || tuple.every((value) => typeof value === 'string' && value.length > 0);
        seen += 1;
        if (!complete) {
          await rejectIdentity(db, kind, tuple);
          continue;
        }
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO crowsnest_comms.number_route_operations
            (operation_id, action, expected_revision, actor_account_id, actor_username, number_id, phone_number_id, number_e164, state)
           VALUES ($1, 'rollback_to_wolfhouse', $2, 'earthling', 'offline-fixture', $3, $4, $5, 'succeeded')`,
          [id, 'd'.repeat(64), ...tuple]
        );
        await db.query('DELETE FROM crowsnest_comms.number_route_operations WHERE operation_id=$1', [id]);
      }
    }
  }
  assert.equal(seen, 27, kind + ':matrix');
}

async function exercise(kind, statements, { history, priorSql, expectWeakBefore }) {
  const db = await openDb();
  let beforeOps = [];
  let beforeEvents = [];
  if (history) {
    await db.exec(priorSql || baseSql);
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
  if (expectWeakBefore) {
    const probeId = '55555555-5555-4555-8555-555555555555';
    await db.exec('BEGIN');
    await db.query(
      `INSERT INTO crowsnest_comms.number_route_operations
        (operation_id, action, expected_revision, actor_account_id, actor_username, number_id, phone_number_id, number_e164, state)
       VALUES ($1, 'rollback_to_wolfhouse', $2, 'earthling', 'offline-fixture', NULL, $3, NULL, 'succeeded')`,
      [probeId, 'c'.repeat(64), phoneId]
    );
    const probed = (await db.query('SELECT phone_number_id FROM crowsnest_comms.number_route_operations WHERE operation_id=$1', [probeId])).rows;
    assert.equal(probed.length, 1, kind + ':weak-before');
    assert.equal(probed[0].phone_number_id, phoneId, kind + ':weak-before');
    await db.exec('ROLLBACK');
    const gone = (await db.query('SELECT operation_id FROM crowsnest_comms.number_route_operations WHERE operation_id=$1', [probeId])).rows;
    assert.equal(gone.length, 0, kind + ':weak-probe-rolled-back');
  }
  for (const sql of statements) await db.exec(sql);
  const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='crowsnest_comms' AND table_name='number_route_operations'")).rows.map((row) => row.column_name);
  assert.equal(columns.includes('number_id') && columns.includes('phone_number_id') && columns.includes('number_e164'), true, kind);
  const constraint = await db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='number_route_identity_complete'");
  assert.equal(constraint.rows.length, 1, kind);
  assert.match(constraint.rows[0].def, /number_id IS NULL/, kind);
  assert.match(constraint.rows[0].def, /number_id IS NOT NULL/, kind);
  assert.match(constraint.rows[0].def, /phone_number_id IS NOT NULL/, kind);
  assert.match(constraint.rows[0].def, /number_e164 IS NOT NULL/, kind);
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
  await assertIdentityContract(db, kind);
  const pool = poolFor(db);
  const store = routing.createAuditStore('fixture-only', () => pool);
  const partialId = crypto.randomUUID();
  let storeCode = null;
  try {
    await store.begin({
      operation_id: partialId,
      action: 'rollback_to_wolfhouse',
      expected_revision: 'e'.repeat(64),
      actor,
      identity: { number_id: null, phone_number_id: phoneId, number_e164: null },
    });
  } catch (error) {
    storeCode = error.code;
  }
  assert.equal(storeCode, '23514', kind + ':store-partial');
  const leaked = (await db.query('SELECT operation_id FROM crowsnest_comms.number_route_operations WHERE operation_id=$1', [partialId])).rows;
  const leakedEvents = (await db.query('SELECT event_id FROM crowsnest_comms.number_route_events WHERE operation_id=$1', [partialId])).rows;
  assert.equal(leaked.length, 0, kind + ':store-partial-not-committed');
  assert.equal(leakedEvents.length, 0, kind + ':store-partial-no-event');
  let transportCalls = 0;
  const transport = async () => {
    transportCalls += 1;
    return { ok: true, status: 200, json: async () => ({ ok: true, idempotent: true, fixture: 'no-controller-or-host' }) };
  };
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
  await exercise('fresh-103-then-113', [currentSql, upgradeSql, upgradeSql], { history: false });
  await exercise('upgrade-rerun-103', [currentSql, currentSql], { history: true });
  await exercise('upgrade-113-only', [upgradeSql, upgradeSql], { history: true });
  await exercise('r3-then-113', [upgradeSql, upgradeSql], { history: true, priorSql: r3Sql, expectWeakBefore: true });
  await exercise('r3-then-rerun-103', [currentSql, currentSql], { history: true, priorSql: r3Sql, expectWeakBefore: true });
  console.log('PASS existing audit identity upgrade');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
