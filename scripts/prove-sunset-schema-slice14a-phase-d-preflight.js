'use strict';

/**
 * prove-sunset-schema-slice14a-phase-d-preflight — FOUNDATION Slice 14A
 * Disposable PostgreSQL only. No Azure / live mutation. No constraint apply.
 * No migration / ledger / firewall / apply flag.
 *
 * Proves the source-only Phase D aggregate preflight for migration-028 CHECKs:
 * date_window + price_unit — counts only.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  sha256CanonicalLfV1File,
  assertSafeDatabaseTarget,
} = require('./lib/migration-integrity');
const { hashCanonicalManifest } = require('./lib/sunset-schema-observer');
const { startDisposablePostgresHarness } = require('./lib/disposable-postgres-harness');
const {
  MIG_028,
  EXPECTED_028_SHA256,
  PHASE_D_LIVE_APPLY_ENABLED,
  DEFAULT_PHASE_D_PREFLIGHT_ENABLED,
  AUTHORIZED_AGGREGATE_SQL,
  OUTPUT_KEYS,
  AGGREGATE_CONTRACT,
  DATE_WINDOW_PREDICATE,
  PRICE_UNIT_PREDICATE,
  runPhaseDCheckPreflight,
  authorizeAggregateSql,
  assertMigration028ByteIntegrity,
  assert028PredicatesPresentInSource,
  assertDisposableConnection,
  sanitizeError,
} = require('./lib/phase-d-check-preflight');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14a-phase-d-preflight-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14a-phase-d-preflight-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14a-findings.md');

const MASTER = '935d278b01c49344ed6e6ef729ac36de5b7d5400';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

/** Locked 13C migration hashes — must remain byte-identical. */
const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

/** Minimal tenant_services without Phase D CHECKs (so violating rows can be inserted). */
const TENANT_SERVICES_DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE public.tenant_services (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL DEFAULT 'wolfhouse',
  client_slug     TEXT NOT NULL,
  name            TEXT NOT NULL,
  category        TEXT,
  notes_for_luna  TEXT,
  keywords        TEXT[] NOT NULL DEFAULT '{}',
  start_date      DATE,
  end_date        DATE,
  price_cents     INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  price_unit      TEXT NOT NULL DEFAULT 'per_day',
  per_guest       BOOLEAN NOT NULL DEFAULT true,
  span_booking    BOOLEAN NOT NULL DEFAULT false,
  luna_visible    BOOLEAN NOT NULL DEFAULT true,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID,
  schedule_slots  JSONB NOT NULL DEFAULT '[]'::jsonb
);
`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function connectReady(admin, database) {
  const deadline = Date.now() + 60000;
  let last;
  while (Date.now() < deadline) {
    const c = new Client({
      host: admin.host,
      port: admin.port,
      user: admin.user,
      password: admin.password,
      database,
      connectionTimeoutMillis: 3000,
    });
    try {
      await c.connect();
      return c;
    } catch (e) {
      last = e;
      try { await c.end(); } catch (_) { /* ignore */ }
      await sleep(250);
    }
  }
  throw last || new Error('postgres not ready');
}

async function createEphemeralDb(admin) {
  const dbName = `wh_mig_14a_${crypto.randomBytes(4).toString('hex')}`;
  const c = await connectReady(admin, 'postgres');
  try {
    await c.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await c.end();
  }
  return dbName;
}

async function dropEphemeralDb(admin, dbName) {
  const c = await connectReady(admin, 'postgres');
  try {
    await c.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `, [dbName]);
    await c.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } finally {
    await c.end();
  }
}

function connInfo(admin, database) {
  return {
    host: admin.host,
    port: admin.port,
    user: admin.user,
    password: admin.password,
    database,
  };
}

function assertCounts(got, exp, label) {
  for (const k of OUTPUT_KEYS) {
    if (got[k] !== exp[k]) {
      throw new Error(`${label}: ${k} got ${got[k]} expected ${exp[k]}`);
    }
  }
  const keys = Object.keys(got).sort();
  const expectedKeys = OUTPUT_KEYS.slice().sort();
  if (keys.join(',') !== expectedKeys.join(',')) {
    throw new Error(`${label}: output key leak ${keys.join(',')}`);
  }
}

function leakScan(value, forbiddenSubstrings) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  for (const f of forbiddenSubstrings) {
    if (f && s.includes(f)) {
      throw new Error(`data leakage detected: contains ${f}`);
    }
  }
}

async function main() {
  console.log('prove:sunset-schema-slice14a-phase-d-preflight — disposable only\n');

  assert028PredicatesPresentInSource();
  const sha028 = assertMigration028ByteIntegrity();

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) throw new Error(`manifest integrity failed: ${JSON.stringify(integrity.errors)}`);
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  const expectedBytes = fs.readFileSync(EXPECTED_PATH);
  const expectedByteSha = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  const expected = JSON.parse(expectedBytes.toString('utf8'));

  if (forward.length !== 39) throw new Error(`forward count drift: ${forward.length}`);
  if (manifestHash !== MANIFEST_HASH) throw new Error('manifest hash drift');
  if (expectedByteSha !== EXPECTED_BYTE_SHA) throw new Error('expected fixture byte drift');
  if (expected.productFingerprint !== CANON_FP) throw new Error('product fingerprint drift');
  if (expected.manifestHash !== MANIFEST_HASH) throw new Error('fixture manifestHash drift');

  for (const [id, want] of Object.entries(LOCKED_13C_SHA)) {
    const file = id === '028' ? MIG_028
      : id === '035' ? '035_customer_message_templates.sql'
        : id === '040' ? '040_tenant_services_saas_catalog_columns.sql'
          : '041_notification_surfpack_convergence.sql';
    const got = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, file));
    if (got !== want) throw new Error(`locked hash drift ${id}: ${got}`);
  }

  // Offline RED: default-disabled / unauthorized SQL / non-loopback (before any DB).
  let disabledRejected = false;
  try {
    await runPhaseDCheckPreflight({ query: async () => {} }, {
      connection: { host: '127.0.0.1', database: 'wh_mig_offline' },
      disposableProofEnabled: false,
      phaseDPreflightEnabled: false,
    });
  } catch (e) {
    disabledRejected = e.code === 'preflight_disabled';
  }
  if (!disabledRejected) throw new Error('default-disabled must reject');

  let unauthorizedRejected = false;
  try {
    authorizeAggregateSql('SELECT id, name FROM tenant_services');
  } catch (e) {
    unauthorizedRejected = e.code === 'unauthorized_sql';
  }
  if (!unauthorizedRejected) throw new Error('arbitrary SQL must be rejected');

  const badTarget = assertSafeDatabaseTarget({
    host: 'sunset-staging.postgres.database.azure.com',
    database: 'sunset_staging',
  });
  if (badTarget.ok) throw new Error('non-loopback Azure target must fail closed');
  let nonLoopbackRejected = false;
  try {
    assertDisposableConnection({
      host: 'sunset-staging.postgres.database.azure.com',
      database: 'wh_mig_fake',
    });
  } catch (e) {
    nonLoopbackRejected = e.code === 'non_disposable_dsn';
  }
  if (!nonLoopbackRejected) throw new Error('non-loopback must reject in disposable proof mode');

  if (PHASE_D_LIVE_APPLY_ENABLED !== false) throw new Error('live apply must be false');
  if (DEFAULT_PHASE_D_PREFLIGHT_ENABLED !== false) throw new Error('default enabled must be false');

  const harness = await startDisposablePostgresHarness();
  const cases = [];
  const forbiddenLeakTokens = [
    'GUEST_SECRET_ALICE',
    'GUEST_SECRET_BOB',
    'notes-should-never-leak',
    'evil@example.com',
  ];

  let dbName;
  try {
    dbName = await createEphemeralDb(harness.admin);
    const connection = connInfo(harness.admin, dbName);
    assertDisposableConnection(connection);

    const client = await connectReady(harness.admin, dbName);
    try {
      await client.query(TENANT_SERVICES_DDL);

      // --- GREEN: zero violations ---
      await client.query(`
        INSERT INTO tenant_services (client_slug, name, start_date, end_date, price_unit, notes_for_luna)
        VALUES
          ('wolfhouse', 'Clean A', '2026-07-01', '2026-07-10', 'per_day', 'notes-should-never-leak'),
          ('wolfhouse', 'Clean B', NULL, '2026-07-10', 'per_week', 'notes-should-never-leak'),
          ('wolfhouse', 'Clean C', '2026-07-01', NULL, 'per_stay', 'notes-should-never-leak'),
          ('wolfhouse', 'Clean D', NULL, NULL, 'one_off', 'notes-should-never-leak')
      `);
      const zero = await runPhaseDCheckPreflight(client, {
        connection,
        disposableProofEnabled: true,
        phaseDPreflightEnabled: true,
      });
      assertCounts(zero.counts, {
        total_rows: 4,
        date_window_violations: 0,
        price_unit_violations: 0,
      }, 'zero-violations');
      leakScan(zero, forbiddenLeakTokens);
      cases.push({
        name: 'zero_violations',
        ok: true,
        counts: zero.counts,
        readOnly: zero.readOnly,
      });

      // --- date_window violation class ---
      await client.query('DELETE FROM tenant_services');
      await client.query(`
        INSERT INTO tenant_services (client_slug, name, start_date, end_date, price_unit, notes_for_luna)
        VALUES
          ('wolfhouse', 'Ok', '2026-07-01', '2026-07-10', 'per_day', 'GUEST_SECRET_ALICE'),
          ('wolfhouse', 'BadWindow', '2026-07-10', '2026-07-01', 'per_day', 'GUEST_SECRET_ALICE')
      `);
      const dw = await runPhaseDCheckPreflight(client, {
        connection,
        disposableProofEnabled: true,
        phaseDPreflightEnabled: true,
      });
      assertCounts(dw.counts, {
        total_rows: 2,
        date_window_violations: 1,
        price_unit_violations: 0,
      }, 'date_window_class');
      leakScan(dw, forbiddenLeakTokens);
      cases.push({ name: 'date_window_violation_class', ok: true, counts: dw.counts });

      // --- price_unit violation class ---
      await client.query('DELETE FROM tenant_services');
      await client.query(`
        INSERT INTO tenant_services (client_slug, name, start_date, end_date, price_unit, notes_for_luna)
        VALUES
          ('wolfhouse', 'Ok', '2026-07-01', '2026-07-10', 'per_day', 'GUEST_SECRET_BOB'),
          ('wolfhouse', 'BadUnit', '2026-07-01', '2026-07-10', 'per_hour', 'GUEST_SECRET_BOB')
      `);
      const pu = await runPhaseDCheckPreflight(client, {
        connection,
        disposableProofEnabled: true,
        phaseDPreflightEnabled: true,
      });
      assertCounts(pu.counts, {
        total_rows: 2,
        date_window_violations: 0,
        price_unit_violations: 1,
      }, 'price_unit_class');
      leakScan(pu, forbiddenLeakTokens);
      cases.push({ name: 'price_unit_violation_class', ok: true, counts: pu.counts });

      // --- NULL semantics (date_window: NULL dates pass; price_unit NULL passes CHECK) ---
      await client.query('DELETE FROM tenant_services');
      await client.query('ALTER TABLE tenant_services ALTER COLUMN price_unit DROP NOT NULL');
      await client.query(`
        INSERT INTO tenant_services (client_slug, name, start_date, end_date, price_unit, notes_for_luna)
        VALUES
          ('wolfhouse', 'NullStart', NULL, '2026-07-10', 'per_day', 'evil@example.com'),
          ('wolfhouse', 'NullEnd', '2026-07-01', NULL, 'per_week', 'evil@example.com'),
          ('wolfhouse', 'BothNull', NULL, NULL, 'per_stay', 'evil@example.com'),
          ('wolfhouse', 'NullUnit', '2026-07-01', '2026-07-10', NULL, 'evil@example.com')
      `);
      // Schema validation requires price_unit NOT NULL — temporarily restore nullability expectation
      // by validating NULL semantics via direct authorized query under altered nullability?
      // Contract: validate schema before count — nullability mismatch must fail-closed.
      // So prove NULL *date* semantics with price_unit NOT NULL restored, then separately
      // prove price_unit NULL CHECK-pass semantics via authorized SQL only after
      // documenting that schema gate requires NOT NULL (028), while CHECK itself treats NULL as pass.
      await client.query(`
        UPDATE tenant_services SET price_unit = 'one_off' WHERE price_unit IS NULL
      `);
      await client.query('ALTER TABLE tenant_services ALTER COLUMN price_unit SET NOT NULL');
      await client.query(`
        UPDATE tenant_services SET price_unit = 'per_day'
        WHERE name IN ('NullStart', 'NullEnd', 'BothNull', 'NullUnit')
      `);
      // Re-insert null-date rows only (price_unit valid)
      await client.query('DELETE FROM tenant_services');
      await client.query(`
        INSERT INTO tenant_services (client_slug, name, start_date, end_date, price_unit, notes_for_luna)
        VALUES
          ('wolfhouse', 'NullStart', NULL, '2026-07-10', 'per_day', 'evil@example.com'),
          ('wolfhouse', 'NullEnd', '2026-07-01', NULL, 'per_week', 'evil@example.com'),
          ('wolfhouse', 'BothNullDates', NULL, NULL, 'per_stay', 'evil@example.com'),
          ('wolfhouse', 'EqualDates', '2026-07-01', '2026-07-01', 'one_off', 'evil@example.com')
      `);
      const nullDates = await runPhaseDCheckPreflight(client, {
        connection,
        disposableProofEnabled: true,
        phaseDPreflightEnabled: true,
      });
      assertCounts(nullDates.counts, {
        total_rows: 4,
        date_window_violations: 0,
        price_unit_violations: 0,
      }, 'null_date_semantics');
      leakScan(nullDates, forbiddenLeakTokens);

      // price_unit NULL: CHECK treats NULL as pass; schema gate requires NOT NULL.
      // Prove CHECK-null-pass via authorized SQL inside a one-off ALTER (disposable only),
      // after confirming schema gate fail-closes while NOT NULL is dropped.
      await client.query('ALTER TABLE tenant_services ALTER COLUMN price_unit DROP NOT NULL');
      let nullabilityFailed = false;
      let nullabilityCode = '';
      try {
        await runPhaseDCheckPreflight(client, {
          connection,
          disposableProofEnabled: true,
          phaseDPreflightEnabled: true,
        });
      } catch (e) {
        nullabilityFailed = e.code === 'column_nullability_mismatch';
        nullabilityCode = e.code;
        leakScan(String(e.message), forbiddenLeakTokens);
      }
      if (!nullabilityFailed) throw new Error('nullability mismatch must fail closed');

      await client.query(`
        INSERT INTO tenant_services (client_slug, name, start_date, end_date, price_unit, notes_for_luna)
        VALUES ('wolfhouse', 'NullPriceUnit', '2026-07-01', '2026-07-05', NULL, 'evil@example.com')
      `);
      // Direct authorized aggregate (schema gate bypassed only for CHECK NULL-pass proof)
      const nullUnitRes = await client.query(AUTHORIZED_AGGREGATE_SQL);
      const nullUnitCounts = {
        total_rows: Number(nullUnitRes.rows[0].total_rows),
        date_window_violations: Number(nullUnitRes.rows[0].date_window_violations),
        price_unit_violations: Number(nullUnitRes.rows[0].price_unit_violations),
      };
      // 5 rows now (4 prior + 1 null unit); null price_unit is NOT a violation (CHECK NULL-pass)
      assertCounts(nullUnitCounts, {
        total_rows: 5,
        date_window_violations: 0,
        price_unit_violations: 0,
      }, 'null_price_unit_check_pass');
      leakScan(nullUnitCounts, forbiddenLeakTokens);
      await client.query('DELETE FROM tenant_services WHERE price_unit IS NULL');
      await client.query(`UPDATE tenant_services SET price_unit = 'per_day' WHERE price_unit IS NULL`);
      await client.query('ALTER TABLE tenant_services ALTER COLUMN price_unit SET DEFAULT \'per_day\'');
      await client.query('ALTER TABLE tenant_services ALTER COLUMN price_unit SET NOT NULL');
      cases.push({
        name: 'null_semantics',
        ok: true,
        dateWindowNullPasses: true,
        priceUnitNullCheckPasses: true,
        schemaGateRejectsNullablePriceUnit: nullabilityFailed,
        nullabilityCode,
        nullDateCounts: nullDates.counts,
        nullPriceUnitAggregateCounts: nullUnitCounts,
      });

      // --- mixed rows ---
      await client.query('DELETE FROM tenant_services');
      await client.query(`
        INSERT INTO tenant_services (client_slug, name, start_date, end_date, price_unit, notes_for_luna)
        VALUES
          ('wolfhouse', 'Good', '2026-07-01', '2026-07-10', 'per_day', 'GUEST_SECRET_ALICE'),
          ('wolfhouse', 'BadWindow', '2026-08-01', '2026-07-01', 'per_week', 'GUEST_SECRET_ALICE'),
          ('wolfhouse', 'BadUnit', '2026-07-01', '2026-07-10', 'hourly', 'GUEST_SECRET_BOB'),
          ('wolfhouse', 'BothBad', '2026-09-01', '2026-08-01', 'monthly', 'GUEST_SECRET_BOB'),
          ('wolfhouse', 'NullOk', NULL, NULL, 'one_off', 'notes-should-never-leak')
      `);
      const mixed = await runPhaseDCheckPreflight(client, {
        connection,
        disposableProofEnabled: true,
        phaseDPreflightEnabled: true,
      });
      assertCounts(mixed.counts, {
        total_rows: 5,
        date_window_violations: 2,
        price_unit_violations: 2,
      }, 'mixed_rows');
      leakScan(mixed, forbiddenLeakTokens);
      cases.push({ name: 'mixed_rows', ok: true, counts: mixed.counts });

      // --- wrong schema / type fail-closed ---
      await client.query('DROP TABLE tenant_services');
      let missingTable = false;
      try {
        await runPhaseDCheckPreflight(client, {
          connection,
          disposableProofEnabled: true,
          phaseDPreflightEnabled: true,
        });
      } catch (e) {
        missingTable = e.code === 'table_missing';
        leakScan(String(e.message), forbiddenLeakTokens);
      }
      if (!missingTable) throw new Error('missing table must fail closed');

      await client.query(`
        CREATE TABLE public.tenant_services (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          start_date TEXT,
          end_date DATE,
          price_unit TEXT NOT NULL DEFAULT 'per_day'
        )
      `);
      let badType = false;
      let badTypeMsg = '';
      try {
        await runPhaseDCheckPreflight(client, {
          connection,
          disposableProofEnabled: true,
          phaseDPreflightEnabled: true,
        });
      } catch (e) {
        badType = e.code === 'column_type_mismatch';
        badTypeMsg = String(e.message);
        leakScan(badTypeMsg, forbiddenLeakTokens);
      }
      if (!badType) throw new Error('wrong column type must fail closed');
      await client.query('DROP TABLE tenant_services');
      await client.query(TENANT_SERVICES_DDL);
      cases.push({
        name: 'wrong_schema_type_fail_closed',
        ok: true,
        missingTable,
        columnTypeMismatch: badType,
        errorSanitized: !forbiddenLeakTokens.some((t) => badTypeMsg.includes(t)),
      });

      // --- read-only transaction / session ---
      await client.query(`
        INSERT INTO tenant_services (client_slug, name, start_date, end_date, price_unit)
        VALUES ('wolfhouse', 'RO', '2026-07-01', '2026-07-02', 'per_day')
      `);
      const ro = await runPhaseDCheckPreflight(client, {
        connection,
        disposableProofEnabled: true,
        phaseDPreflightEnabled: true,
      });
      assertCounts(ro.counts, {
        total_rows: 1,
        date_window_violations: 0,
        price_unit_violations: 0,
      }, 'read_only_path');

      // Prove WRITE fails under READ ONLY in the same style of transaction.
      let writeRejected = false;
      await client.query('BEGIN READ ONLY');
      try {
        await client.query(`
          INSERT INTO tenant_services (client_slug, name, start_date, end_date, price_unit)
          VALUES ('wolfhouse', 'ShouldFail', '2026-07-01', '2026-07-02', 'per_day')
        `);
      } catch (e) {
        writeRejected = /read-only|readonly/i.test(String(e.message)) || e.code === '25006';
        await client.query('ROLLBACK');
      }
      if (!writeRejected) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw new Error('READ ONLY transaction must reject writes');
      }
      cases.push({
        name: 'read_only_transaction_session',
        ok: true,
        preflightReadOnly: ro.readOnly === true,
        writeRejectedInReadOnlyTxn: writeRejected,
      });

      // --- exact aggregate query authorization ---
      let authOk = false;
      try {
        authorizeAggregateSql(AUTHORIZED_AGGREGATE_SQL);
        authOk = true;
      } catch (_) {
        authOk = false;
      }
      let authReject = false;
      try {
        authorizeAggregateSql('SELECT count(*) FROM tenant_services WHERE name = \'GUEST_SECRET_ALICE\'');
      } catch (e) {
        authReject = e.code === 'unauthorized_sql';
      }
      // Caller-supplied options.sql that differs must reject inside runPhaseDCheckPreflight
      let optsSqlReject = false;
      try {
        await runPhaseDCheckPreflight(client, {
          connection,
          disposableProofEnabled: true,
          phaseDPreflightEnabled: true,
          sql: 'SELECT id FROM tenant_services',
        });
      } catch (e) {
        optsSqlReject = e.code === 'unauthorized_sql';
      }
      if (!authOk || !authReject || !optsSqlReject) {
        throw new Error('aggregate query authorization failed');
      }
      cases.push({
        name: 'exact_aggregate_query_authorization',
        ok: true,
        lockedSqlAuthorized: authOk,
        arbitrarySqlRejected: authReject,
        optionsSqlRejected: optsSqlReject,
        authorizedAggregateSql: AUTHORIZED_AGGREGATE_SQL,
      });

      // --- no data leakage in output / sanitized errors ---
      await client.query('DELETE FROM tenant_services');
      await client.query(`
        INSERT INTO tenant_services (client_slug, name, start_date, end_date, price_unit, notes_for_luna)
        VALUES
          ('wolfhouse', 'GUEST_SECRET_ALICE', '2026-07-10', '2026-07-01', 'per_hour', 'notes-should-never-leak'),
          ('wolfhouse', 'GUEST_SECRET_BOB', '2026-07-01', '2026-07-05', 'per_day', 'evil@example.com')
      `);
      const leakProbe = await runPhaseDCheckPreflight(client, {
        connection,
        disposableProofEnabled: true,
        phaseDPreflightEnabled: true,
      });
      assertCounts(leakProbe.counts, {
        total_rows: 2,
        date_window_violations: 1,
        price_unit_violations: 1,
      }, 'leak_probe');
      leakScan(leakProbe, forbiddenLeakTokens);
      leakScan(JSON.stringify(leakProbe.counts), forbiddenLeakTokens);

      const sanitized = sanitizeError(
        Object.assign(new Error("DETAIL: Key (name)=(GUEST_SECRET_ALICE) already exists\nHINT: evil@example.com"), {
          code: '23505',
        }),
        'phase_d_preflight_failed',
      );
      leakScan(String(sanitized.message), forbiddenLeakTokens);
      cases.push({
        name: 'no_data_leakage',
        ok: true,
        outputKeysOnly: Object.keys(leakProbe.counts).sort().join(',') === OUTPUT_KEYS.slice().sort().join(','),
        evidenceScanClean: true,
        errorSanitizerStripsLiterals: true,
      });
    } finally {
      await client.end();
    }
  } finally {
    if (dbName) {
      try { await dropEphemeralDb(harness.admin, dbName); } catch (_) { /* ignore */ }
    }
    harness.cleanup();
  }

  const allOk = cases.every((c) => c.ok);
  if (!allOk) throw new Error('one or more proof cases failed');

  const generatedAt = new Date().toISOString();

  const contract = {
    kind: 'sunset-schema-observer-slice14a-phase-d-preflight-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    liveApplyCapability: false,
    appliesConstraints: false,
    writesLedger: false,
    mutates: false,
    defaultEnabled: false,
    disposablePostgreSQLOnly: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14A',
    purpose:
      'Source-only, default-disabled, read-only aggregate preflight for Phase D CHECKs owned by immutable migration 028 (date_window + price_unit). Counts only — never row values, identifiers, guest data, or arbitrary SQL.',
    aggregateContract: AGGREGATE_CONTRACT,
    predicates: {
      date_window: DATE_WINDOW_PREDICATE,
      price_unit: PRICE_UNIT_PREDICATE,
    },
    authorizedAggregateSql: AUTHORIZED_AGGREGATE_SQL,
    outputKeys: OUTPUT_KEYS.slice(),
    forbidden: [
      'live/Azure connectivity',
      'firewall action',
      'mutation',
      'migration',
      'ledger',
      'apply flag',
      'constraint ADD',
      'row payloads',
      'arbitrary SQL',
    ],
    nonGoals: [
      'No Phase D constraint apply',
      'No Sunset repair claim',
      'No live observer job',
      'No expected-fixture regeneration',
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14a-phase-d-preflight-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14A',
    outcome: 'phase_d_aggregate_preflight_proven_disposable_only',
    stillProductSchemaDiffers: true,
    phaseDConstraintsApplied: false,
    liveMutation: false,
    azureConnectivity: false,
    firewallAction: false,
    migrationAdded: false,
    ledgerWritten: false,
    applyFlagPresent: false,
    forwardCountUnchanged: 39,
    newForwardMigration: false,
    migrationHashes: { ...LOCKED_13C_SHA },
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    migration028Sha256CanonicalLfV1: sha028,
    defaultDisabled: true,
    liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED,
    offlineGates: {
      defaultDisabledRejected: disabledRejected,
      unauthorizedSqlRejected: unauthorizedRejected,
      nonLoopbackRejected: nonLoopbackRejected,
      azureTargetFailClosed: !badTarget.ok,
    },
    disposableProofCases: cases,
    aggregateContract: {
      outputKeys: OUTPUT_KEYS.slice(),
      authorizedAggregateSql: AUTHORIZED_AGGREGATE_SQL,
      dateWindowPredicate: DATE_WINDOW_PREDICATE,
      priceUnitPredicate: PRICE_UNIT_PREDICATE,
      returnsRowValues: false,
      returnsIdentifiers: false,
      returnsGuestData: false,
      acceptsArbitrarySql: false,
    },
    note:
      'Slice 14A proves aggregate preflight only. Phase D CHECK ADD remains a later slice. Do not claim Sunset repaired.',
  };

  const findings = `# FOUNDATION Slice 14A — Phase D CHECK aggregate preflight

**Status:** complete (source-only / disposable proof)
**Master basis:** \`${MASTER}\`
**Generated:** ${generatedAt}

## Outcome

Created a **source-only, default-disabled, read-only** aggregate preflight for the two Phase D constraints already owned by immutable migration \`028_tenant_services.sql\`:

- \`tenant_services_date_window\` — \`${DATE_WINDOW_PREDICATE}\`
- \`tenant_services_price_unit\` — \`${PRICE_UNIT_PREDICATE}\`

Returns **only** \`total_rows\`, \`date_window_violations\`, \`price_unit_violations\`. Never row values, identifiers, guest data, or arbitrary SQL.

## Exact aggregate contract

\`\`\`sql
${AUTHORIZED_AGGREGATE_SQL}
\`\`\`

Schema/type validation of \`start_date\` (date, nullable), \`end_date\` (date, nullable), and \`price_unit\` (text, not null) runs **before** counting. Fail-closed on missing table / wrong type / nullability drift.

## Disposable proof matrix

| Case | Result |
|------|--------|
| Zero violations | GREEN |
| date_window violation class | GREEN (count=1) |
| price_unit violation class | GREEN (count=1) |
| NULL date semantics (CHECK-pass) | GREEN (violations=0) |
| NULL price_unit CHECK-pass + schema gate | GREEN (aggregate 0; nullability fail-closed) |
| Mixed rows | GREEN (dw=2, pu=2) |
| Wrong schema/type | RED fail-closed |
| Read-only transaction/session | GREEN |
| Exact aggregate query authorization | GREEN |
| No data leakage in output/errors | GREEN |
| Non-loopback / default-disabled | RED reject |

## Unchanged hashes (byte-identical)

| Artifact | Hash |
|----------|------|
| Migration 028 | \`${LOCKED_13C_SHA['028']}\` |
| Migration 035 | \`${LOCKED_13C_SHA['035']}\` |
| Migration 040 | \`${LOCKED_13C_SHA['040']}\` |
| Migration 041 | \`${LOCKED_13C_SHA['041']}\` |
| Manifest | \`${MANIFEST_HASH}\` |
| Product fingerprint | \`${CANON_FP}\` |
| expected-product-schema.json bytes | \`${EXPECTED_BYTE_SHA}\` |
| Forward count | **39** (unchanged) |

## Non-claims

**Do not claim** Sunset is repaired. Phase D \`ADD CONSTRAINT\` is **not** implemented in 14A. Zero live/Azure mutation. No firewall, ledger, migration, or apply flag.

## Commands

\`\`\`bash
npm run prove:sunset-schema-slice14a-phase-d-preflight
npm run verify:sunset-schema-slice14a
\`\`\`
`;

  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, findings);

  console.log('  PASS  offline default-disabled / unauthorized SQL / non-loopback');
  for (const c of cases) {
    console.log(`  PASS  ${c.name}`);
  }
  console.log('\nEvidence written:');
  console.log(`  ${CONTRACT_PATH}`);
  console.log(`  ${EVIDENCE_PATH}`);
  console.log(`  ${FINDINGS_PATH}`);
  console.log('\nSlice 14A disposable proof GREEN — no live mutation.');
}

main().catch((err) => {
  console.error('FAIL', err && err.stack ? err.stack : err);
  process.exit(1);
});
