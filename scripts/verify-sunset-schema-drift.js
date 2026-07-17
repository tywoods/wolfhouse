'use strict';

/**
 * verify:sunset-schema-drift — FOUNDATION Slice 5 (safety-corrected)
 * RED→GREEN gate for read-only Sunset live schema-drift helpers.
 * Does not connect to Azure PostgreSQL, does not mutate Azure, does not apply migrations.
 */

const fs = require('fs');
const path = require('path');
const {
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  EXPECTED_SUBSCRIPTION_ID,
  EXPECTED_RG,
  EXPECTED_PG_SERVER,
  EXPECTED_KV,
  EXPECTED_SECRET_NAME,
  EXPECTED_STAFF_APP,
  APPLICATION_NAME,
  INTROSPECTION_SQL,
  SQL_REGISTRY_IDS,
  AZ_COMMAND_SURFACE,
  parseDatabaseUrl,
  assertSunsetStagingTarget,
  assertNoLeakedDsn,
  assertSqlAllowed,
  assertAzCommandAllowed,
  normalizeSql,
  assertKnownObjectSection,
  assertReadOnlySession,
  clientConfigFromDsn,
  compareSnapshots,
  fingerprintProductSchema,
  classifyLedgerStatus,
  redactSecrets,
  buildExactCollectorExecCommand,
  buildExactContainerAppExecArgs,
  resolveRunningExecTarget,
  assertImageIsSunsetStaffApi,
} = require('./lib/sunset-schema-drift');

const ROOT = path.join(__dirname, '..');
const HISTORICAL = path.join(
  ROOT,
  'fixtures',
  'sunset-schema-drift',
  'live-schema-drift-report.json',
);

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('verify:sunset-schema-drift — RED→GREEN (safety-corrected)\n');

const goodDsn =
  `postgresql://sunsetadmin:${['s3', 'cret'].join('')}@${EXPECTED_HOST}:5432/${EXPECTED_DATABASE}?sslmode=require`;

// GREEN: parse + target
{
  const p = parseDatabaseUrl(goodDsn);
  pass('green-parse-dsn', p.ok && p.parsed.host === EXPECTED_HOST && p.parsed.database === EXPECTED_DATABASE);
  pass('green-tls-required', p.ok && p.parsed.tlsOk === true);
  const t = assertSunsetStagingTarget(p.parsed, {
    subscriptionId: EXPECTED_SUBSCRIPTION_ID,
    resourceGroup: EXPECTED_RG,
    serverName: EXPECTED_PG_SERVER,
  });
  pass('green-target', t.ok, JSON.stringify(t.errors));
}

// RED: wrong target
{
  const wolf = parseDatabaseUrl(
    'postgresql://u:<x>@wh-staging-pg.postgres.database.azure.com:5432/wolfhouse_staging?sslmode=require',
  );
  const t = assertSunsetStagingTarget(wolf.parsed, {
    subscriptionId: EXPECTED_SUBSCRIPTION_ID,
    resourceGroup: EXPECTED_RG,
    serverName: EXPECTED_PG_SERVER,
  });
  pass(
    'red-wrong-target-host',
    !t.ok && t.errors.some((e) => e.code === 'wrong_host' || e.code === 'forbidden_host'),
  );
}
{
  const wrongDb = parseDatabaseUrl(
    `postgresql://u:<x>@${EXPECTED_HOST}:5432/wolfhouse_staging?sslmode=require`,
  );
  const t = assertSunsetStagingTarget(wrongDb.parsed);
  pass(
    'red-wrong-target-database',
    !t.ok && t.errors.some((e) => e.code === 'wrong_database' || e.code === 'forbidden_database'),
  );
}
{
  const t = assertSunsetStagingTarget(parseDatabaseUrl(goodDsn).parsed, {
    subscriptionId: '00000000-0000-0000-0000-000000000000',
  });
  pass('red-wrong-subscription', !t.ok && t.errors.some((e) => e.code === 'wrong_subscription'));
}
{
  const t = assertSunsetStagingTarget(parseDatabaseUrl(goodDsn).parsed, {
    resourceGroup: 'luna-wolfhouse-staging-rg',
  });
  pass('red-wrong-rg', !t.ok && t.errors.some((e) => e.code === 'wrong_resource_group'));
}

// RED: missing TLS
{
  const noTls = parseDatabaseUrl(
    `postgresql://u:<x>@${EXPECTED_HOST}:5432/${EXPECTED_DATABASE}`,
  );
  pass('red-missing-tls-parse', noTls.ok && noTls.parsed.tlsOk === false);
  const t = assertSunsetStagingTarget(noTls.parsed);
  pass('red-missing-tls', !t.ok && t.errors.some((e) => e.code === 'missing_tls'));
}

// RED: leaked DSN
{
  const reportText = JSON.stringify({ note: 'connected with ' + goodDsn });
  const hits = assertNoLeakedDsn(reportText, goodDsn);
  pass('red-leaked-dsn', hits.includes('raw_dsn') || hits.includes('embedded_dsn'));
  const clean = redactSecrets(reportText);
  pass('green-redact-dsn', assertNoLeakedDsn(clean, goodDsn).length === 0 && !clean.includes(['s3', 'cret'].join('')));
}

// RED: clientConfig rejects wrong target
{
  let threw = false;
  try {
    clientConfigFromDsn(
      'postgresql://u:<x>@evil.postgres.database.azure.com:5432/sunset_staging?sslmode=require',
    );
  } catch (e) {
    threw = e.code === 'wrong_target';
  }
  pass('red-client-config-wrong-target', threw);
}

// RED: non-read-only session
{
  const r = assertReadOnlySession({
    transaction_read_only: 'off',
    application_name: APPLICATION_NAME,
  });
  pass('red-non-read-only-session', !r.ok && r.errors.some((e) => e.code === 'non_read_only_session'));
}
{
  const r = assertReadOnlySession({
    transaction_read_only: 'on',
    application_name: APPLICATION_NAME,
  });
  pass('green-read-only-session', r.ok);
}

// RED: forbidden / stacked / comment / appended SQL — exact registry only
{
  const bad = assertSqlAllowed('INSERT INTO schema_migration_ledger VALUES (1)');
  pass('red-forbidden-sql-insert', !bad.ok && bad.code === 'forbidden_sql');
}
{
  const bad = assertSqlAllowed('CREATE TABLE evil (id int)');
  pass('red-forbidden-sql-ddl', !bad.ok && bad.code === 'forbidden_sql');
}
{
  const bad = assertSqlAllowed('SET statement_timeout = 1');
  pass('red-forbidden-sql-set', !bad.ok && bad.code === 'forbidden_sql');
}
{
  const bad = assertSqlAllowed('BEGIN; SELECT 1; COMMIT');
  pass('red-forbidden-sql-txn', !bad.ok && (bad.code === 'stacked_sql_rejected' || bad.code === 'forbidden_sql'));
}
{
  const stacked = assertSqlAllowed(`${INTROSPECTION_SQL.show_transaction_read_only}; ${INTROSPECTION_SQL.show_lock_timeout}`);
  pass('red-stacked-sql', !stacked.ok && stacked.code === 'stacked_sql_rejected');
}
{
  const commented = assertSqlAllowed(`${INTROSPECTION_SQL.show_transaction_read_only} -- trailing`);
  pass('red-sql-trailing-comment', !commented.ok && commented.code === 'sql_comments_rejected');
}
{
  const appended = assertSqlAllowed(`${INTROSPECTION_SQL.show_transaction_read_only} OR 1=1`);
  pass('red-sql-appended', !appended.ok && appended.code === 'sql_not_in_registry');
}
{
  const bad = assertSqlAllowed('SELECT * FROM bookings');
  pass('red-sql-not-in-registry', !bad.ok && bad.code === 'sql_not_in_registry');
}
{
  const bad = assertSqlAllowed('COPY schema_migration_ledger TO STDOUT');
  pass('red-forbidden-sql-copy', !bad.ok && bad.code === 'forbidden_sql');
}
{
  const bad = assertSqlAllowed('CALL some_proc()');
  pass('red-forbidden-sql-call', !bad.ok && bad.code === 'forbidden_sql');
}

// GREEN: exact normalized registry equality
{
  let allOk = true;
  for (const [key, sql] of Object.entries(INTROSPECTION_SQL)) {
    const r = assertSqlAllowed(sql);
    if (!r.ok || r.allowlistId !== key) {
      allOk = false;
      console.log(`    registry miss: ${key} → ${r.code}`);
    }
    const spaced = `  ${sql.replace(/\n/g, '  \n  ')}  ;`;
    const r2 = assertSqlAllowed(spaced);
    if (!r2.ok || r2.allowlistId !== key) {
      allOk = false;
      console.log(`    normalize miss: ${key} → ${r2.code}`);
    }
  }
  pass('green-introspection-sql-exact-registry', allOk);
  pass('green-registry-id-count', SQL_REGISTRY_IDS.length === Object.keys(INTROSPECTION_SQL).length);
  pass(
    'green-normalize-sql-stable',
    normalizeSql(INTROSPECTION_SQL.tables) === normalizeSql(`\n${INTROSPECTION_SQL.tables}\n;`),
  );
}

// RED: unknown object type
{
  const r = assertKnownObjectSection('materialized_views');
  pass('red-unknown-object-type', !r.ok && r.code === 'unknown_object_type');
  pass('green-known-object-type', assertKnownObjectSection('tables').ok);
}

// RED: command-surface mutations
{
  const fwCreate = assertAzCommandAllowed([
    'postgres', 'flexible-server', 'firewall-rule', 'create',
    '-g', EXPECTED_RG, '-n', EXPECTED_PG_SERVER, '--rule-name', 'x',
  ]);
  pass('red-az-firewall-create', !fwCreate.ok && fwCreate.code === 'az_mutation_rejected');
}
{
  const fwDel = assertAzCommandAllowed([
    'postgres', 'flexible-server', 'firewall-rule', 'delete',
    '-g', EXPECTED_RG, '-n', EXPECTED_PG_SERVER, '--rule-name', 'x', '--yes',
  ]);
  pass('red-az-firewall-delete', !fwDel.ok && fwDel.code === 'az_mutation_rejected');
}
{
  const upd = assertAzCommandAllowed([
    'containerapp', 'update', '-g', EXPECTED_RG, '-n', EXPECTED_STAFF_APP, '--set-env-vars', 'A=B',
  ]);
  pass('red-az-containerapp-update', !upd.ok && upd.code === 'az_mutation_rejected');
}
{
  const restart = assertAzCommandAllowed([
    'containerapp', 'revision', 'restart', '-g', EXPECTED_RG, '-n', EXPECTED_STAFF_APP, '--revision', 'x',
  ]);
  pass('red-az-containerapp-restart', !restart.ok && restart.code === 'az_mutation_rejected');
}
{
  const deploy = assertAzCommandAllowed([
    'deployment', 'group', 'create', '-g', EXPECTED_RG, '--template-file', 'x.bicep',
  ]);
  pass('red-az-deployment-create', !deploy.ok && deploy.code === 'az_mutation_rejected');
}
{
  const kvWrite = assertAzCommandAllowed([
    'keyvault', 'secret', 'set', '--vault-name', EXPECTED_KV, '--name', 'x', '--value', 'y',
  ]);
  pass('red-az-keyvault-write', !kvWrite.ok && kvWrite.code === 'az_mutation_rejected');
}
{
  const acr = assertAzCommandAllowed(['acr', 'build', '-r', 'x', '-t', 'y', '.']);
  pass('red-az-acr-build', !acr.ok && acr.code === 'az_mutation_rejected');
}
{
  const dbExec = assertAzCommandAllowed([
    'postgres', 'flexible-server', 'execute', '-g', EXPECTED_RG, '-n', EXPECTED_PG_SERVER, '-q', 'SELECT 1',
  ]);
  pass('red-az-db-execute', !dbExec.ok && dbExec.code === 'az_mutation_rejected');
}

// GREEN: allowed read-only Azure surface
{
  const kv = assertAzCommandAllowed([
    'keyvault', 'secret', 'show', '--vault-name', EXPECTED_KV, '--name', EXPECTED_SECRET_NAME, '-o', 'tsv',
  ]);
  pass('green-az-keyvault-show', kv.ok && kv.kind === 'keyvault_secret_show');
}
{
  const show = assertAzCommandAllowed([
    'containerapp', 'show', '-g', EXPECTED_RG, '-n', EXPECTED_STAFF_APP, '-o', 'json',
  ]);
  pass('green-az-containerapp-show', show.ok && show.kind === 'containerapp_show');
}
{
  const rev = assertAzCommandAllowed([
    'containerapp', 'revision', 'list', '-g', EXPECTED_RG, '-n', EXPECTED_STAFF_APP, '-o', 'json',
  ]);
  pass('green-az-revision-list', rev.ok && rev.kind === 'containerapp_revision_list');
}
{
  const rep = assertAzCommandAllowed([
    'containerapp', 'replica', 'list', '-g', EXPECTED_RG, '-n', EXPECTED_STAFF_APP,
    '--revision', 'luna-sunset-staging-staff-api--0000266', '-o', 'json',
  ]);
  pass('green-az-replica-list', rep.ok && rep.kind === 'containerapp_replica_list');
}
{
  const cmd = buildExactCollectorExecCommand();
  const cmd2 = buildExactCollectorExecCommand();
  pass('green-collector-command-deterministic', cmd === cmd2 && cmd.startsWith('node -e '));
  const ex = assertAzCommandAllowed(buildExactContainerAppExecArgs({
    revision: 'luna-sunset-staging-staff-api--0000266',
    replica: 'luna-sunset-staging-staff-api--0000266-abc',
    container: EXPECTED_STAFF_APP,
  }));
  pass('green-az-containerapp-exec-bound', ex.ok && ex.kind === 'containerapp_exec');
}

// RED: collector --command binding — reject alternate payloads
{
  const base = [
    'containerapp', 'exec', '-g', EXPECTED_RG, '-n', EXPECTED_STAFF_APP,
    '--revision', 'r1', '--replica', 'rep1', '--container', 'c1', '--command',
  ];
  pass(
    'red-az-exec-arbitrary-node',
    !assertAzCommandAllowed([...base, 'node -e "console.log(1)"']).ok
      && assertAzCommandAllowed([...base, 'node -e "console.log(1)"']).code === 'az_exec_command_not_bound',
  );
  pass(
    'red-az-exec-shell',
    !assertAzCommandAllowed([...base, 'sh -c "cat /etc/passwd"']).ok,
  );
  pass(
    'red-az-exec-sql',
    !assertAzCommandAllowed([...base, 'psql -c "SELECT 1"']).ok,
  );
  pass(
    'red-az-exec-alternate-base64',
    !assertAzCommandAllowed([
      ...base,
      `node -e 'eval(require("zlib").gunzipSync(Buffer.from("H4sIAAAAAAAAA0u0","base64")).toString("utf8"))'`,
    ]).ok,
  );
  pass(
    'red-az-exec-missing-replica',
    !assertAzCommandAllowed([
      'containerapp', 'exec', '-g', EXPECTED_RG, '-n', EXPECTED_STAFF_APP,
      '--revision', 'r1', '--container', 'c1', '--command', buildExactCollectorExecCommand(),
    ]).ok
      && assertAzCommandAllowed([
        'containerapp', 'exec', '-g', EXPECTED_RG, '-n', EXPECTED_STAFF_APP,
        '--revision', 'r1', '--container', 'c1', '--command', buildExactCollectorExecCommand(),
      ]).code === 'az_exec_target_unbound',
  );
}

// GREEN/RED: image + running target resolver
{
  pass(
    'green-image-sunset-staff-api',
    assertImageIsSunsetStaffApi('whstagingacr.azurecr.io/luna-sunset-staff-api:abc').ok,
  );
  pass(
    'red-image-wh-staff-api',
    !assertImageIsSunsetStaffApi('whstagingacr.azurecr.io/wh-staff-api:abc').ok,
  );
  const app = {
    properties: {
      latestRevisionName: 'rev-100',
      template: { containers: [{ name: EXPECTED_STAFF_APP, image: 'whstagingacr.azurecr.io/luna-sunset-staff-api:abc' }] },
      configuration: { ingress: { traffic: [{ latestRevision: true, weight: 100 }] } },
    },
  };
  const revisions = [{
    name: 'rev-100',
    properties: { template: { containers: [{ name: EXPECTED_STAFF_APP, image: 'whstagingacr.azurecr.io/luna-sunset-staff-api:abc' }] } },
  }];
  const replicas = [{
    name: 'rev-100-replica-1',
    properties: { runningState: 'Running', containers: [{ name: EXPECTED_STAFF_APP }] },
  }];
  const resolved = resolveRunningExecTarget(app, revisions, replicas);
  pass(
    'green-resolve-100pct-replica',
    resolved.ok
      && resolved.target.revision === 'rev-100'
      && resolved.target.replica === 'rev-100-replica-1'
      && resolved.target.container === EXPECTED_STAFF_APP,
  );
  const bad = resolveRunningExecTarget({
    properties: {
      template: { containers: [{ image: 'whstagingacr.azurecr.io/wh-staff-api:x' }] },
      configuration: { ingress: { traffic: [{ revisionName: 'r', weight: 100 }] } },
    },
  }, [], []);
  pass('red-resolve-forbidden-image', !bad.ok);
}

{
  const costUrl =
    `https://management.azure.com/subscriptions/${EXPECTED_SUBSCRIPTION_ID}`
    + `/resourceGroups/${EXPECTED_RG}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`;
  const cost = assertAzCommandAllowed(['rest', '--method', 'post', '--url', costUrl, '--body', '@x.json']);
  pass('green-az-cost-query', cost.ok && cost.kind === 'cost_management_query');
}
pass(
  'green-az-surface-lists-forbidden',
  AZ_COMMAND_SURFACE.forbiddenSubstrings.some((s) => s.includes('firewall-rule create')),
);

// RED: fingerprint mismatch
{
  const expected = {
    tables: ['bookings'],
    columns: [{ table: 'bookings', column: 'id', type: 'uuid', udt: 'uuid', nullable: 'NO', default: null }],
    constraints: [],
    indexes: [],
    sequences: [],
    views: [],
    functions: [],
    triggers: [],
  };
  const live = {
    tables: ['bookings'],
    columns: [{ table: 'bookings', column: 'id', type: 'text', udt: 'text', nullable: 'NO', default: null }],
    constraints: [],
    indexes: [],
    sequences: [],
    views: [],
    functions: [],
    triggers: [],
  };
  const cmp = compareSnapshots(expected, live);
  pass(
    'red-fingerprint-mismatch',
    fingerprintProductSchema(expected) !== fingerprintProductSchema(live)
      && !cmp.ok
      && cmp.counts.definition_mismatch >= 1,
  );
}

// GREEN: identical snapshots
{
  const snap = {
    tables: ['a'],
    columns: [],
    constraints: [],
    indexes: [],
    sequences: [],
    views: [],
    functions: [],
    triggers: [],
  };
  const cmp = compareSnapshots(snap, JSON.parse(JSON.stringify(snap)));
  pass('green-identical-snapshots', cmp.ok && cmp.counts.expected_only === 0);
}

// Ledger status
{
  const forward = [
    { id: '001', order: 1, sha256: 'aa'.repeat(32), filename: '001.sql' },
    { id: '002', order: 2, sha256: 'bb'.repeat(32), filename: '002.sql' },
  ];
  pass('green-ledger-absent', classifyLedgerStatus({ exists: false }, [], forward).status === 'absent');
  pass(
    'green-ledger-complete',
    classifyLedgerStatus(
      { exists: true, incompatible: false },
      [
        { id: '001', apply_order: 1, checksum_sha256: 'aa'.repeat(32) },
        { id: '002', apply_order: 2, checksum_sha256: 'bb'.repeat(32) },
      ],
      forward,
    ).status === 'complete',
  );
  pass(
    'red-ledger-partial',
    classifyLedgerStatus(
      { exists: true, incompatible: false },
      [{ id: '001', apply_order: 1, checksum_sha256: 'aa'.repeat(32) }],
      forward,
    ).status === 'partial',
  );
  pass(
    'red-ledger-incompatible',
    classifyLedgerStatus(
      { exists: true, incompatible: false },
      [
        { id: '001', apply_order: 1, checksum_sha256: 'deadbeef'.repeat(8) },
        { id: '002', apply_order: 2, checksum_sha256: 'bb'.repeat(32) },
      ],
      forward,
    ).status === 'incompatible',
  );
}

// Historical evidence must be marked noncompliant (probe rewrites on run; verifier checks current file if present)
{
  if (fs.existsSync(HISTORICAL)) {
    const hist = JSON.parse(fs.readFileSync(HISTORICAL, 'utf8'));
    // Before probe rewrite, may still be old — accept either already-marked or require drift preserved
    const hasDrift =
      hist.drift
      && hist.drift.counts
      && hist.drift.counts.expected_only === 28
      && hist.drift.counts.live_only === 15;
    pass('green-historical-drift-preserved', hasDrift);
    if (hist.scopeCompliant === false) {
      pass('green-historical-marked-noncompliant', hist.zeroMutationProof === false);
    } else {
      // Will be marked by probe; static expectation for safety correction commit after probe
      pass('green-historical-marked-noncompliant', false, 'run probe to stamp scopeCompliant=false');
    }
  } else {
    pass('green-historical-drift-preserved', false, 'missing historical fixture');
    pass('green-historical-marked-noncompliant', false);
  }
}

console.log('');
if (failed) {
  console.error(`verify:sunset-schema-drift FAILED (${failed})`);
  process.exit(1);
}
console.log('verify:sunset-schema-drift OK');
process.exit(0);
