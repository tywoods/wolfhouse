'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { runCanonicalMigrations } = require('./run-canonical-migrations');

const ROOT = path.join(__dirname, '..');
const SOURCE_MIGRATIONS = path.join(ROOT, 'database', 'migrations');
const SOURCE_MANIFEST = path.join(SOURCE_MIGRATIONS, 'canonical-manifest.json');

let dockerCommand = 'docker';
let dockerPrefix = [];

function docker(args) {
  return execFileSync(dockerCommand, [...dockerPrefix, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function waitForPostgres(connection) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const client = new Client({ ...connection, connectionTimeoutMillis: 1000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error('disposable PostgreSQL did not become ready');
}

async function query(connection, sql, values) {
  const client = new Client(connection);
  await client.connect();
  try {
    return await client.query(sql, values);
  } finally {
    await client.end();
  }
}

function canonicalSha256(contents) {
  const normalized = contents.replace(/\r\n?/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function mutatedChain(tempRoot, name, mutate) {
  const migrationsDir = path.join(tempRoot, name);
  fs.cpSync(SOURCE_MIGRATIONS, migrationsDir, { recursive: true });
  const manifestPath = path.join(migrationsDir, 'canonical-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const helpers = {
    rewrite(id, transform) {
      const entry = manifest.entries.find((candidate) => candidate.id === id);
      assert.ok(entry, `manifest entry ${id}`);
      const filename = path.join(migrationsDir, entry.filename);
      const before = fs.readFileSync(filename, 'utf8');
      const after = transform(before);
      assert.notEqual(after, before, `${name}: mutation must change ${entry.filename}`);
      fs.writeFileSync(filename, after);
      entry.sha256 = canonicalSha256(after);
      delete entry.legacySha256;
    },
    entry(id) {
      const entry = manifest.entries.find((candidate) => candidate.id === id);
      assert.ok(entry, `manifest entry ${id}`);
      return entry;
    },
  };
  mutate(helpers);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { migrationsDir, manifestPath };
}

async function fire114HoldTrigger(client, slug) {
  // This INSERT is the important runtime proof: PL/pgSQL resolves the quoted
  // rooms.selling_mode and lock-function dependencies only when the trigger runs.
  await client.query(`
    WITH c AS (
      INSERT INTO clients (slug,name) VALUES ($1,$1) RETURNING id
    ), r AS (
      INSERT INTO rooms (client_id,room_code,name,capacity,selling_mode)
      SELECT id,'R1','Runtime proof room',1,'shared' FROM c RETURNING id,client_id
    ), b AS (
      INSERT INTO beds (client_id,room_id,bed_code,bed_number)
      SELECT client_id,id,'R1-B1',1 FROM r RETURNING id,client_id,bed_code
    ), s AS (
      INSERT INTO luna_v3_sessions (client_id,session_key,principal_id,write_admitted)
      SELECT id,'luna-v3:' || $1,'prerequisite-gate',true FROM c RETURNING id,client_id
    ), sel AS (
      INSERT INTO luna_v3_selections
        (client_id,session_id,quote_revision,check_in,check_out,guests,assignments,quote)
      SELECT client_id,id,'q1',DATE '2035-01-01',DATE '2035-01-03','[]','[]','{}' FROM s
      RETURNING id,client_id,session_id
    ), h AS (
      INSERT INTO luna_v3_holds
        (client_id,session_id,selection_id,check_in,check_out,expires_at)
      SELECT client_id,session_id,id,DATE '2035-01-01',DATE '2035-01-03',now()+interval '1 hour' FROM sel
      RETURNING id,client_id
    )
    INSERT INTO luna_v3_hold_beds (hold_id,client_id,bed_id,guest_ordinal,bed_code)
    SELECT h.id,h.client_id,b.id,1,b.bed_code FROM h JOIN b ON b.client_id=h.client_id
  `, [slug]);
}

async function applyScenario(admin, database, chain, options = {}) {
  await query(admin, `CREATE DATABASE ${database}`);
  await query(admin, `GRANT CREATE ON DATABASE ${database} TO crowsnest_comms_owner`);
  const connection = { ...admin, database };
  let triggerFired = false;
  const result = await runCanonicalMigrations({
    connection,
    migrationsDir: chain.migrationsDir,
    manifestPath: chain.manifestPath,
    beforeLedgerInsert: async (client, entry) => {
      if (entry.id === '114_luna_v3_staff_operations') {
        await fire114HoldTrigger(client, database);
        triggerFired = true;
      }
    },
  });
  if (options.expectSuccess) {
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(triggerFired, true, 'migration 114 hold trigger was not fired');
    const evidence = await query(connection, `
      SELECT
        (SELECT apply_order FROM schema_migration_ledger WHERE id='111_room_selling_mode') AS room_mode_order,
        (SELECT apply_order FROM schema_migration_ledger WHERE id='114_luna_v3_staff_operations') AS staff_ops_order,
        (SELECT count(*)::int FROM luna_v3_hold_beds) AS fired_rows
    `);
    assert.ok(evidence.rows[0].room_mode_order < evidence.rows[0].staff_ops_order);
    assert.equal(evidence.rows[0].fired_rows, 1);
  }
  return { result, triggerFired };
}

test('canonical prerequisites execute in order on disposable PostgreSQL and quoted dependency mutations fail', { timeout: 600_000 }, async (t) => {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
  } catch (_) {
    execFileSync('sudo', ['-n', 'docker', 'version'], { stdio: 'ignore' });
    dockerCommand = 'sudo';
    dockerPrefix = ['-n', 'docker'];
  }
  const suffix = crypto.randomBytes(5).toString('hex');
  const container = `wh-prereq-${suffix}`;
  const user = `wh_gate_${suffix}`;
  const password = crypto.randomBytes(24).toString('base64url');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-prereq-gate-'));
  t.after(() => {
    try { docker(['rm', '-f', container]); } catch (_) { /* best effort */ }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  docker(['run', '-d', '--name', container,
    '-e', `POSTGRES_USER=${user}`, '-e', `POSTGRES_PASSWORD=${password}`,
    '-e', 'POSTGRES_DB=postgres', '-p', '127.0.0.1::5432', 'postgres:16-alpine']);
  const portOutput = docker(['port', container, '5432/tcp']).trim();
  const port = Number((portOutput.match(/:(\d+)$/) || [])[1]);
  assert.ok(port > 0, `unparseable Docker port: ${portOutput}`);
  const admin = { host: '127.0.0.1', port, user, password, database: 'postgres' };
  await waitForPostgres(admin);

  // Migration 059 intentionally adopts these least-privilege roles. They are
  // server bootstrap, not schema migrations, so provision them in the disposable server.
  await query(admin, `
    CREATE ROLE crowsnest_comms_owner NOLOGIN NOINHERIT;
    CREATE ROLE crowsnest_api NOLOGIN NOINHERIT;
    GRANT crowsnest_comms_owner TO ${user} WITH ADMIN OPTION;
    GRANT crowsnest_api TO ${user} WITH ADMIN OPTION;
    GRANT crowsnest_api TO crowsnest_comms_owner WITH ADMIN OPTION;
  `);

  const canonical = mutatedChain(tempRoot, 'canonical-quoted', ({ rewrite }) => {
    rewrite('114_luna_v3_staff_operations', (sql) => sql
      .replace('JOIN rooms r', 'JOIN "rooms" r')
      .replace('r.selling_mode', 'r."selling_mode"')
      .replaceAll("booking_occupancy_lock_key('bed',NEW.bed_id)", '"booking_occupancy_lock_key"(\'bed\',NEW.bed_id)'));
  });
  await applyScenario(admin, `wh_mig_ok_${suffix}`, canonical, { expectSuccess: true });

  const mutations = [
    ['quoted_table', (h) => h.rewrite('114_luna_v3_staff_operations', (sql) => sql
      .replace('JOIN rooms r', 'JOIN "missing_rooms" r'))],
    ['quoted_function', (h) => h.rewrite('114_luna_v3_staff_operations', (sql) => sql
      .replaceAll("booking_occupancy_lock_key('bed',NEW.bed_id)", '"missing_lock_function"(\'bed\',NEW.bed_id)'))],
    ['quoted_column', (h) => h.rewrite('114_luna_v3_staff_operations', (sql) => sql
      .replace('r.selling_mode', 'r."missing_selling_mode"'))],
    ['order_111_after_114', (h) => {
      const roomMode = h.entry('111_room_selling_mode');
      const staffOps = h.entry('114_luna_v3_staff_operations');
      [roomMode.order, staffOps.order] = [staffOps.order, roomMode.order];
    }],
  ];

  for (let index = 0; index < mutations.length; index += 1) {
    const [name, mutation] = mutations[index];
    const chain = mutatedChain(tempRoot, name, mutation);
    const proof = await applyScenario(admin, `wh_mig_bad_${index}_${suffix}`, chain);
    assert.equal(proof.result.ok, false, `${name} unexpectedly passed the real PostgreSQL gate`);
    assert.equal(proof.triggerFired, false, `${name} unexpectedly completed the hold trigger`);
    assert.ok(proof.result.errors.length > 0, `${name} returned no PostgreSQL error`);
  }
});
