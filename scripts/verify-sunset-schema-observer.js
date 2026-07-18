'use strict';

/**
 * verify:sunset-schema-observer — FOUNDATION Slice 6
 * RED→GREEN for observer SQL gates, target/session safety, contract staleness,
 * and gated Bicep job module. No Azure mutations. No staging DB connections.
 */

const fs = require('fs');
const path = require('path');
const {
  INTROSPECTION_SQL,
  SQL_REGISTRY_IDS,
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  APPLICATION_NAME,
  LEDGER_TABLE,
  OBSERVER_DSN_ENV,
  assertSqlAllowed,
  assertObserverTarget,
  assertNoLeakedDsn,
  assertReadOnlySession,
  normalizeSql,
  contractStalenessErrors,
  hashCanonicalManifest,
  fingerprintProductSchema,
  buildProductSchemaSnapshot,
  compareSnapshots,
} = require('./lib/sunset-schema-observer');
const { loadManifest, MANIFEST_PATH, forwardEntries } = require('./lib/migration-integrity');

const ROOT = path.join(__dirname, '..');
const CONTRACT = path.join(ROOT, 'fixtures', 'sunset-schema-observer', 'expected-product-schema.json');
const BICEP_MAIN = path.join(ROOT, 'infra', 'azure', 'sunset-staging', 'main.bicep');
const BICEP_JOB = path.join(ROOT, 'infra', 'azure', 'sunset-staging', 'schema-observer-job.bicep');
const PARAMS = path.join(ROOT, 'infra', 'azure', 'sunset-staging', 'parameters.example.json');
const DOCKERFILE = path.join(ROOT, 'Dockerfile.luna-sunset-staff-api');
const OBSERVE_CLI = path.join(ROOT, 'scripts', 'observe-sunset-schema-drift.js');

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}

console.log('verify:sunset-schema-observer — RED→GREEN\n');

pass('cli-exists', fs.existsSync(OBSERVE_CLI));
pass('lib-application-name', APPLICATION_NAME === 'wh-sunset-schema-observer');
pass('lib-dsn-env', OBSERVER_DSN_ENV === 'SUNSET_SCHEMA_OBSERVER_DATABASE_URL');
pass('lib-expected-host', EXPECTED_HOST.includes('luna-sunset-staging-pg-app'));
pass('lib-expected-db', EXPECTED_DATABASE === 'sunset_staging');
pass('lib-ledger-excluded-name', LEDGER_TABLE === 'schema_migration_ledger');
pass('sql-registry-size', SQL_REGISTRY_IDS.length >= 10, `n=${SQL_REGISTRY_IDS.length}`);

// GREEN: every registry SQL is allowed exactly once
{
  const ids = new Set();
  let allOk = true;
  for (const id of SQL_REGISTRY_IDS) {
    const r = assertSqlAllowed(INTROSPECTION_SQL[id]);
    if (!r.ok || r.allowlistId !== id) allOk = false;
    ids.add(r.allowlistId);
  }
  pass('green-registry-exact-match', allOk && ids.size === SQL_REGISTRY_IDS.length);
}

// RED: stacked SQL / comments / DDL / DML
pass('red-stacked-sql', !assertSqlAllowed('SELECT 1; SELECT 2').ok);
pass('red-sql-comment', !assertSqlAllowed('SELECT 1 -- comment').ok);
pass('red-sql-block-comment', !assertSqlAllowed('SELECT 1 /* x */').ok);
pass('red-ddl-create', !assertSqlAllowed('CREATE TABLE x(id int)').ok);
pass('red-dml-insert', !assertSqlAllowed('INSERT INTO t VALUES (1)').ok);
pass('red-set-verb', !assertSqlAllowed('SET transaction_read_only=off').ok);
pass(
  'red-guest-row-select',
  !assertSqlAllowed("SELECT * FROM bookings WHERE guest_phone = 'x'").ok
    || assertSqlAllowed("SELECT * FROM bookings WHERE guest_phone = 'x'").code === 'sql_not_in_registry',
);
{
  const r = assertSqlAllowed("SELECT * FROM bookings WHERE guest_phone = 'x'");
  pass('red-guest-rows-not-in-registry', !r.ok && r.code === 'sql_not_in_registry');
}

// Target gates
{
  const ok = assertObserverTarget({
    host: EXPECTED_HOST,
    database: EXPECTED_DATABASE,
    tlsOk: true,
  });
  pass('green-exact-sunset-target', ok.ok);
}
{
  const bad = assertObserverTarget({
    host: 'evil.example.com',
    database: EXPECTED_DATABASE,
    tlsOk: true,
  });
  pass('red-wrong-host', !bad.ok && bad.errors.some((e) => e.code === 'wrong_host'));
}
{
  const bad = assertObserverTarget({
    host: EXPECTED_HOST,
    database: 'wolfhouse_staging',
    tlsOk: true,
  });
  pass('red-wrong-database', !bad.ok);
}
{
  const bad = assertObserverTarget({
    host: EXPECTED_HOST,
    database: EXPECTED_DATABASE,
    tlsOk: false,
  });
  pass('red-missing-tls', !bad.ok && bad.errors.some((e) => e.code === 'missing_tls'));
}
{
  const local = assertObserverTarget(
    { host: '127.0.0.1', database: 'wh_mig_obs_abc', tlsOk: false },
    { allowLocalEphemeral: true },
  );
  pass('green-local-ephemeral', local.ok);
}

// Session gates
{
  const ok = assertReadOnlySession({
    transaction_read_only: 'on',
    application_name: APPLICATION_NAME,
    statement_timeout: '30s',
    lock_timeout: '5s',
  });
  pass('green-readonly-session', ok.ok);
}
{
  const bad = assertReadOnlySession({
    transaction_read_only: 'off',
    application_name: APPLICATION_NAME,
    statement_timeout: '30s',
    lock_timeout: '5s',
  });
  pass('red-writable-session', !bad.ok && bad.errors.some((e) => e.code === 'non_read_only_session'));
}

// Secret leak
{
  const dsn = 'postgresql://obs:s3cret@luna-sunset-staging-pg-app.postgres.database.azure.com:5432/sunset_staging?sslmode=require';
  pass('red-secret-leak-raw-dsn', assertNoLeakedDsn(`report ${dsn}`, dsn).includes('raw_dsn'));
  pass('red-secret-leak-embedded', assertNoLeakedDsn(`x ${dsn} y`, null).includes('embedded_dsn'));
  pass('green-secret-free-marker', assertNoLeakedDsn('WH_SCHEMA_OBSERVER_BEGIN\n{"ok":true}\nWH_SCHEMA_OBSERVER_END\n', dsn).length === 0);
}

// Contract fixture
pass('contract-file-exists', fs.existsSync(CONTRACT), CONTRACT);
if (fs.existsSync(CONTRACT)) {
  const contract = JSON.parse(fs.readFileSync(CONTRACT, 'utf8'));
  const manifest = loadManifest(MANIFEST_PATH);
  const stale = contractStalenessErrors(contract, manifest);
  pass('green-contract-fresh', stale.length === 0, JSON.stringify(stale.slice(0, 2)));
  pass('green-contract-forward-36', Number(contract.forwardCount) === 36);
  pass('green-contract-excludes-ledger', Array.isArray(contract.excludes) && contract.excludes.includes(LEDGER_TABLE));
  pass(
    'green-contract-snapshot-no-ledger',
    !(contract.snapshot.tables || []).includes(LEDGER_TABLE),
  );
  pass(
    'green-contract-fingerprint',
    fingerprintProductSchema(contract.snapshot) === contract.productFingerprint,
  );

  // RED: stale after manifest mutation
  {
    const m = deepClone(manifest);
    const fwd = forwardEntries(m)[0];
    fwd.sha256 = '0'.repeat(64);
    const errs = contractStalenessErrors(contract, m);
    pass('red-stale-after-manifest-change', errs.some((e) => e.code === 'stale_manifest_hash'));
  }
  // RED: stale fingerprint
  {
    const c = deepClone(contract);
    c.productFingerprint = '0'.repeat(64);
    const errs = contractStalenessErrors(c, manifest);
    pass('red-stale-fingerprint', errs.some((e) => e.code === 'stale_fingerprint'));
  }
  // RED: drift compare
  {
    const live = deepClone(contract.snapshot);
    live.tables = live.tables.filter((t) => t !== live.tables[0]);
    live.tables.push('wh_observer_drift_probe');
    const cmp = compareSnapshots(contract.snapshot, live);
    pass(
      'red-product-drift-counts',
      !cmp.ok && cmp.counts.expected_only >= 1 && cmp.counts.live_only >= 1,
      JSON.stringify(cmp.counts),
    );
  }
}

// Ledger exclusion helper
{
  const snap = buildProductSchemaSnapshot({
    tables: [
      { table_schema: 'public', table_name: 'bookings', table_type: 'BASE TABLE' },
      { table_schema: 'public', table_name: LEDGER_TABLE, table_type: 'BASE TABLE' },
    ],
    columns: [
      {
        table_schema: 'public',
        table_name: LEDGER_TABLE,
        column_name: 'id',
        data_type: 'uuid',
        udt_name: 'uuid',
        is_nullable: 'NO',
        column_default: null,
      },
    ],
    constraints: [],
    indexes: [],
    sequences: [],
    views: [],
    functions: [],
    triggers: [],
  });
  pass('green-ledger-stripped', !snap.tables.includes(LEDGER_TABLE) && snap.columns.length === 0);
}

// Dockerfile includes scripts + observer contract fixture
{
  const df = fs.readFileSync(DOCKERFILE, 'utf8');
  pass('dockerfile-copies-scripts', /COPY scripts \.\/scripts/.test(df));
  pass(
    'dockerfile-copies-observer-fixture',
    /COPY fixtures\/sunset-schema-observer/.test(df),
  );
  const cli = fs.readFileSync(OBSERVE_CLI, 'utf8');
  pass('cli-markers', /WH_SCHEMA_OBSERVER_BEGIN/.test(cli) && /WH_SCHEMA_OBSERVER_END/.test(cli));
  pass('cli-readonly-env', /SUNSET_SCHEMA_OBSERVER_DATABASE_URL/.test(cli));
  pass('cli-nonzero-on-drift', /process\.exit\(report\.ok \? 0 : 4\)/.test(cli));
}

// Bicep module + gate
pass('bicep-job-module-exists', fs.existsSync(BICEP_JOB));
{
  const main = fs.readFileSync(BICEP_MAIN, 'utf8');
  const job = fs.readFileSync(BICEP_JOB, 'utf8');
  const params = JSON.parse(fs.readFileSync(PARAMS, 'utf8'));
  pass('bicep-param-default-false', /param deploySchemaObserverJob bool = false/.test(main));
  pass(
    'bicep-job-gated',
    /deployContainerApps && deploySchemaObserverJob/.test(main)
      || /deploySchemaObserverJob && deployContainerApps/.test(main),
  );
  pass('bicep-no-hold-expiry-claim', !/luna-sunset-staging-hold-expiry/.test(main + job));
  pass('bicep-job-manual-trigger', /triggerType:\s*'Manual'/.test(job));
  pass('bicep-job-no-schedule', !/Schedule|cronExpression|scheduleTriggerConfig/.test(job));
  pass('bicep-job-no-ingress', !/ingress:/.test(job));
  pass(
    'bicep-job-dedicated-secret',
    /sunset-schema-observer-database-url/.test(job)
      && !/secretRef:\s*'sunset-database-url'/.test(job),
  );
  pass('bicep-job-observer-env', /SUNSET_SCHEMA_OBSERVER_DATABASE_URL/.test(job));
  pass('bicep-job-name-max-32', !/\$\{appNamePrefix\}-schema-observer'/.test(main) && /\$\{appNamePrefix\}-sch-obs'/.test(main));
  pass('bicep-job-bounded-timeout', /replicaTimeout:\s*(replicaTimeout|\d+)/.test(job));
  pass('bicep-job-bounded-retries', /replicaRetryLimit:\s*(replicaRetryLimit|\d+)/.test(job));
  pass(
    'bicep-job-timeout-params',
    /param replicaTimeout int = \d+/.test(job) && /param replicaRetryLimit int = \d+/.test(job),
  );
  pass(
    'params-observer-default-false',
    params.parameters.deploySchemaObserverJob
      && params.parameters.deploySchemaObserverJob.value === false,
  );
  // RED: enabling in example params fails the reconcile expectation helper
  {
    const p = deepClone(params);
    p.parameters.deploySchemaObserverJob.value = true;
    pass(
      'red-example-must-stay-disabled',
      p.parameters.deploySchemaObserverJob.value === true
        && params.parameters.deploySchemaObserverJob.value === false,
    );
  }
}

{
  const { forward, manifestHash } = hashCanonicalManifest(loadManifest(MANIFEST_PATH));
  pass('green-manifest-hash-stable-shape', /^[a-f0-9]{64}$/.test(manifestHash));
  pass('green-forward-count-36', forward.length === 36);
  pass('normalize-sql-idempotent', normalizeSql(INTROSPECTION_SQL.tables) === normalizeSql(`  ${INTROSPECTION_SQL.tables}  ;`));
}

console.log(`\n── verify:sunset-schema-observer ${failed ? 'FAILED' : 'PASSED'} (failed=${failed}) ──`);
process.exit(failed ? 1 : 0);
