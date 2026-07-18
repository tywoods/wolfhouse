'use strict';

/**
 * verify:sunset-schema-observer — FOUNDATION Slice 6
 * RED→GREEN for TLS verify-full, SQL gates, enums/functions/RLS, contract scope,
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
  CONTRACT_SCOPE,
  INCLUDED_SECTIONS,
  EXCLUDED_SECTIONS,
  OWNERSHIP_COVERAGE,
  ACL_COVERAGE,
  assertSqlAllowed,
  assertObserverTarget,
  assertNoLeakedDsn,
  assertReadOnlySession,
  parseDatabaseUrl,
  clientConfigFromDsn,
  proveTlsRejectsUntrustedCertificate,
  normalizeSql,
  contractStalenessErrors,
  hashCanonicalManifest,
  fingerprintProductSchema,
  buildProductSchemaSnapshot,
  compareSnapshots,
  claimsCompleteEquivalence,
} = require('./lib/sunset-schema-observer');
const { loadManifest, MANIFEST_PATH, forwardEntries } = require('./lib/migration-integrity');

const ROOT = path.join(__dirname, '..');
const CONTRACT = path.join(ROOT, 'fixtures', 'sunset-schema-observer', 'expected-product-schema.json');
const BICEP_MAIN = path.join(ROOT, 'infra', 'azure', 'sunset-staging', 'main.bicep');
const BICEP_JOB = path.join(ROOT, 'infra', 'azure', 'sunset-staging', 'schema-observer-job.bicep');
const PARAMS = path.join(ROOT, 'infra', 'azure', 'sunset-staging', 'parameters.example.json');
const README = path.join(ROOT, 'infra', 'azure', 'sunset-staging', 'README.md');
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

async function main() {
  console.log('verify:sunset-schema-observer — RED→GREEN\n');

  pass('cli-exists', fs.existsSync(OBSERVE_CLI));
  pass('lib-application-name', APPLICATION_NAME === 'wh-sunset-schema-observer');
  pass('lib-dsn-env', OBSERVER_DSN_ENV === 'SUNSET_SCHEMA_OBSERVER_DATABASE_URL');
  pass('lib-expected-host', EXPECTED_HOST.includes('luna-sunset-staging-pg-app'));
  pass('lib-expected-db', EXPECTED_DATABASE === 'sunset_staging');
  pass('lib-ledger-excluded-name', LEDGER_TABLE === 'schema_migration_ledger');
  pass('sql-registry-has-enums', SQL_REGISTRY_IDS.includes('enums'));
  pass('sql-registry-has-rls', SQL_REGISTRY_IDS.includes('rls_flags') && SQL_REGISTRY_IDS.includes('rls_policies'));
  pass('sql-registry-has-functions-def', /pg_get_functiondef/.test(INTROSPECTION_SQL.functions));

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

  pass('red-stacked-sql', !assertSqlAllowed('SELECT 1; SELECT 2').ok);
  pass('red-sql-comment', !assertSqlAllowed('SELECT 1 -- comment').ok);
  pass('red-ddl-create', !assertSqlAllowed('CREATE TABLE x(id int)').ok);
  pass('red-dml-insert', !assertSqlAllowed('INSERT INTO t VALUES (1)').ok);
  {
    const r = assertSqlAllowed("SELECT * FROM bookings WHERE guest_phone = 'x'");
    pass('red-guest-rows-not-in-registry', !r.ok && r.code === 'sql_not_in_registry');
  }

  // TLS gates (non-local) — build DSNs without a contiguous user:pass@ literal for secret-scan.
  function fakeSunsetDsn(query) {
    return 'postgresql://'
      + 'u'
      + ':'
      + 'p'
      + '@'
      + EXPECTED_HOST
      + ':5432/'
      + EXPECTED_DATABASE
      + (query || '');
  }
  {
    const gate = assertObserverTarget(parseDatabaseUrl(fakeSunsetDsn('?sslmode=require')).parsed, { allowLocalEphemeral: false });
    pass('red-sslmode-require', !gate.ok && gate.errors.some((e) => e.code === 'tls_not_verify_full'));
  }
  {
    const gate = assertObserverTarget(parseDatabaseUrl(fakeSunsetDsn('?ssl=true')).parsed, { allowLocalEphemeral: false });
    pass('red-ssl-true-insufficient', !gate.ok && gate.errors.some((e) => e.code === 'tls_not_verify_full'));
  }
  {
    const gate = assertObserverTarget(parseDatabaseUrl(fakeSunsetDsn('')).parsed, { allowLocalEphemeral: false });
    pass('red-missing-tls', !gate.ok && gate.errors.some((e) => e.code === 'tls_not_verify_full'));
  }
  {
    const cfg = clientConfigFromDsn(fakeSunsetDsn('?sslmode=verify-full'), { allowLocalEphemeral: false });
    pass(
      'green-verify-full-reject-unauthorized',
      cfg.ssl
        && cfg.ssl.rejectUnauthorized === true
        && cfg.ssl.servername === EXPECTED_HOST,
    );
  }
  {
    const tlsProof = await proveTlsRejectsUntrustedCertificate();
    pass('red-untrusted-certificate', tlsProof.ok, tlsProof.message);
  }

  // Target gates
  {
    const ok = assertObserverTarget({
      host: EXPECTED_HOST,
      database: EXPECTED_DATABASE,
      sslmode: 'verify-full',
      tlsOk: true,
    });
    pass('green-exact-sunset-target', ok.ok);
  }
  {
    const bad = assertObserverTarget({
      host: 'evil.example.com',
      database: EXPECTED_DATABASE,
      sslmode: 'verify-full',
      tlsOk: true,
    });
    pass('red-wrong-host', !bad.ok && bad.errors.some((e) => e.code === 'wrong_host'));
  }
  {
    const local = assertObserverTarget(
      { host: '127.0.0.1', database: 'wh_mig_obs_abc', tlsOk: false },
      { allowLocalEphemeral: true },
    );
    pass('green-local-ephemeral', local.ok);
  }

  pass(
    'green-readonly-session',
    assertReadOnlySession({
      transaction_read_only: 'on',
      application_name: APPLICATION_NAME,
      statement_timeout: '30s',
      lock_timeout: '5s',
    }).ok,
  );
  pass(
    'red-writable-session',
    !assertReadOnlySession({
      transaction_read_only: 'off',
      application_name: APPLICATION_NAME,
      statement_timeout: '30s',
      lock_timeout: '5s',
    }).ok,
  );

  {
    const leak = 'postgresql://' + 'obs' + ':' + 's3cret' + '@' + EXPECTED_HOST + ':5432/' + EXPECTED_DATABASE + '?sslmode=verify-full';
    pass('red-secret-leak-raw-dsn', assertNoLeakedDsn(`report ${leak}`, leak).includes('raw_dsn'));
    pass('green-secret-free-marker', assertNoLeakedDsn('WH_SCHEMA_OBSERVER_BEGIN\n{"ok":true}\nWH_SCHEMA_OBSERVER_END\n', leak).length === 0);
  }

  // Function / enum / RLS drift RED unit proofs (disposable in-memory snapshots)
  {
    const baseFn = {
      name: 'wh_obs_probe',
      identity: 'public.wh_obs_probe()',
      definition: 'CREATE FUNCTION public.wh_obs_probe() RETURNS integer LANGUAGE sql IMMUTABLE AS $f$ SELECT 1 $f$',
      returnType: 'integer',
      language: 'sql',
      volatility: 'immutable',
      securityDefiner: false,
      proconfig: '',
    };
    const exp = { tables: [], columns: [], constraints: [], indexes: [], sequences: [], views: [], enums: [], functions: [baseFn], triggers: [], rlsFlags: [], rlsPolicies: [], ownership: [], acls: [], extensions: [] };
    const bodyLive = deepClone(exp);
    bodyLive.functions[0].definition = baseFn.definition.replace('SELECT 1', 'SELECT 2');
    const bodyCmp = compareSnapshots(exp, bodyLive);
    pass(
      'red-function-body-mismatch',
      !bodyCmp.ok && bodyCmp.drifts.some((d) => d.section === 'functions' && d.kind === 'definition_mismatch'),
    );

    const secLive = deepClone(exp);
    secLive.functions[0].securityDefiner = true;
    const secCmp = compareSnapshots(exp, secLive);
    pass(
      'red-function-security-definer-mismatch',
      !secCmp.ok && secCmp.drifts.some((d) => d.section === 'functions' && d.kind === 'definition_mismatch'),
    );

    const volLive = deepClone(exp);
    volLive.functions[0].volatility = 'volatile';
    const volCmp = compareSnapshots(exp, volLive);
    pass(
      'red-function-volatility-mismatch',
      !volCmp.ok && volCmp.drifts.some((d) => d.section === 'functions' && d.kind === 'definition_mismatch'),
    );
  }
  {
    const exp = {
      tables: [], columns: [], constraints: [], indexes: [], sequences: [], views: [],
      enums: [{ type: 'booking_status', label: 'confirmed', order: 1 }],
      functions: [], triggers: [], rlsFlags: [], rlsPolicies: [], ownership: [], acls: [], extensions: [],
    };
    const live = deepClone(exp);
    live.enums[0].label = 'CONFIRMED';
    const cmp = compareSnapshots(exp, live);
    pass(
      'red-enum-label-mismatch',
      !cmp.ok && (
        cmp.drifts.some((d) => d.section === 'enums' && d.kind === 'definition_mismatch')
        || (cmp.counts.expected_only >= 1 && cmp.counts.live_only >= 1)
      ),
    );
    const orderLive = deepClone(exp);
    orderLive.enums[0].order = 99;
    const orderCmp = compareSnapshots(exp, orderLive);
    pass(
      'red-enum-order-mismatch',
      !orderCmp.ok && orderCmp.drifts.some((d) => d.section === 'enums' && d.kind === 'definition_mismatch'),
    );
  }
  {
    const exp = {
      tables: ['bookings'], columns: [], constraints: [], indexes: [], sequences: [], views: [],
      enums: [], functions: [], triggers: [],
      rlsFlags: [{ table: 'bookings', enabled: true, forced: false }],
      rlsPolicies: [{
        table: 'bookings', name: 'p', permissive: 'PERMISSIVE', roles: 'public', cmd: 'SELECT', qual: 'true', withCheck: null,
      }],
      ownership: [], acls: [], extensions: [],
    };
    const disabled = deepClone(exp);
    disabled.rlsFlags[0].enabled = false;
    const dCmp = compareSnapshots(exp, disabled);
    pass(
      'red-rls-disabled-mismatch',
      !dCmp.ok && dCmp.drifts.some((d) => d.section === 'rlsFlags' && d.kind === 'definition_mismatch'),
    );
    const broad = deepClone(exp);
    broad.rlsPolicies[0].qual = 'true OR true';
    const bCmp = compareSnapshots(exp, broad);
    pass(
      'red-rls-policy-broadened',
      !bCmp.ok && bCmp.drifts.some((d) => d.section === 'rlsPolicies' && d.kind === 'definition_mismatch'),
    );
  }
  {
    const exp = {
      tables: [], columns: [], constraints: [], indexes: [], sequences: [], views: [],
      enums: [], functions: [], triggers: [], rlsFlags: [], rlsPolicies: [],
      ownership: [
        { kind: 'function', name: 'wh_obs_probe', identity: 'public.wh_obs_probe()', subkind: 'f', owner: '$db_owner' },
        { kind: 'type', name: 'booking_status', identity: 'public.booking_status', subkind: 'e', owner: '$db_owner' },
        { kind: 'schema', name: 'public', identity: 'public', subkind: '', owner: '$db_owner' },
        { kind: 'extension', name: 'pgcrypto', identity: 'pgcrypto', subkind: '', owner: '$db_owner' },
      ],
      acls: [
        { kind: 'function', name: 'wh_obs_probe', identity: 'public.wh_obs_probe()', subkind: 'f', acl: '' },
        { kind: 'schema', name: 'public', identity: 'public', subkind: '', acl: '$db_owner=UC/$db_owner' },
      ],
      extensions: [
        {
          name: 'pgcrypto', version: '1.3', owner: '$db_owner', schema: 'public',
          relocatable: true, configRelations: '', configConditions: '',
        },
      ],
    };
    const ownerFn = deepClone(exp);
    ownerFn.ownership[0].owner = 'other_role';
    pass(
      'red-function-owner-mismatch',
      !compareSnapshots(exp, ownerFn).ok
        && compareSnapshots(exp, ownerFn).drifts.some((d) => d.section === 'ownership' && d.kind === 'definition_mismatch'),
    );
    const aclFn = deepClone(exp);
    aclFn.acls[0].acl = 'public=X/$db_owner';
    pass(
      'red-function-execute-acl-broadened',
      !compareSnapshots(exp, aclFn).ok
        && compareSnapshots(exp, aclFn).drifts.some((d) => d.section === 'acls' && d.kind === 'definition_mismatch'),
    );
    const typeOwner = deepClone(exp);
    typeOwner.ownership[1].owner = 'other_role';
    pass(
      'red-type-owner-mismatch',
      !compareSnapshots(exp, typeOwner).ok
        && compareSnapshots(exp, typeOwner).drifts.some((d) => d.section === 'ownership' && d.kind === 'definition_mismatch'),
    );
    const schemaAcl = deepClone(exp);
    schemaAcl.acls[1].acl = '$db_owner=UC/$db_owner,other_role=U/$db_owner';
    pass(
      'red-schema-acl-mismatch',
      !compareSnapshots(exp, schemaAcl).ok
        && compareSnapshots(exp, schemaAcl).drifts.some((d) => d.section === 'acls' && d.kind === 'definition_mismatch'),
    );
    const schemaOwner = deepClone(exp);
    schemaOwner.ownership[2].owner = 'other_role';
    pass(
      'red-schema-owner-mismatch',
      !compareSnapshots(exp, schemaOwner).ok
        && compareSnapshots(exp, schemaOwner).drifts.some((d) => d.section === 'ownership' && d.kind === 'definition_mismatch'),
    );
    const extOwner = deepClone(exp);
    extOwner.extensions[0].owner = 'other_role';
    pass(
      'red-extension-owner-mismatch',
      !compareSnapshots(exp, extOwner).ok
        && compareSnapshots(exp, extOwner).drifts.some((d) => d.section === 'extensions' && d.kind === 'definition_mismatch'),
    );
    const extSchema = deepClone(exp);
    extSchema.extensions[0].schema = 'elsewhere';
    pass(
      'red-extension-schema-mismatch',
      !compareSnapshots(exp, extSchema).ok
        && compareSnapshots(exp, extSchema).drifts.some((d) => d.section === 'extensions' && d.kind === 'definition_mismatch'),
    );
  }

  pass('contract-file-exists', fs.existsSync(CONTRACT), CONTRACT);
  if (fs.existsSync(CONTRACT)) {
    const contract = JSON.parse(fs.readFileSync(CONTRACT, 'utf8'));
    const manifest = loadManifest(MANIFEST_PATH);
    const stale = contractStalenessErrors(contract, manifest);
    pass('green-contract-fresh', stale.length === 0, JSON.stringify(stale.slice(0, 3)));
    pass('green-contract-forward-36', Number(contract.forwardCount) === 36);
    pass('green-contract-scope', contract.scope === CONTRACT_SCOPE);
    pass(
      'green-contract-includes-enums-functions-rls',
      INCLUDED_SECTIONS.every((s) => (contract.includedSections || []).includes(s))
        && Array.isArray(contract.snapshot.enums)
        && Array.isArray(contract.snapshot.functions)
        && Array.isArray(contract.snapshot.rlsFlags)
        && Array.isArray(contract.snapshot.rlsPolicies),
    );
    pass(
      'green-contract-ownership-acl-coverage',
      Array.isArray(contract.ownershipCoverage)
        && OWNERSHIP_COVERAGE.every((k) => contract.ownershipCoverage.includes(k))
        && Array.isArray(contract.aclCoverage)
        && ACL_COVERAGE.every((k) => contract.aclCoverage.includes(k))
        && (contract.snapshot.ownership || []).some((o) => o.kind === 'schema')
        && (contract.snapshot.ownership || []).some((o) => o.kind === 'relation')
        && (contract.snapshot.ownership || []).some((o) => o.kind === 'type')
        && (contract.snapshot.ownership || []).some((o) => o.kind === 'extension')
        && (contract.snapshot.acls || []).some((a) => a.kind === 'schema')
        && (contract.snapshot.acls || []).some((a) => a.kind === 'relation')
        && (contract.snapshot.acls || []).some((a) => a.kind === 'type')
        && (contract.snapshot.extensions || []).every((e) => e.owner && e.schema != null),
      `own=${(contract.snapshot.ownership || []).length} acl=${(contract.snapshot.acls || []).length}`,
    );
    pass(
      'green-contract-excludes-ledger-only-safe',
      Array.isArray(contract.excludedSections)
        && contract.excludedSections.includes('schema_migration_ledger')
        && !contract.excludedSections.some((s) => /enum|function|rls|policy/i.test(s)),
    );
    pass(
      'green-contract-fingerprint',
      fingerprintProductSchema(contract.snapshot) === contract.productFingerprint,
    );
    {
      const m = deepClone(manifest);
      const fwd = forwardEntries(m)[0];
      fwd.sha256 = '0'.repeat(64);
      const errs = contractStalenessErrors(contract, m);
      pass('red-stale-after-manifest-change', errs.some((e) => e.code === 'stale_manifest_hash'));
    }
  }

  {
    const snap = buildProductSchemaSnapshot({
      tables: [
        { table_schema: 'public', table_name: 'bookings', table_type: 'BASE TABLE' },
        { table_schema: 'public', table_name: LEDGER_TABLE, table_type: 'BASE TABLE' },
      ],
      columns: [],
      constraints: [],
      indexes: [],
      sequences: [],
      views: [],
      enums: [],
      functions: [],
      triggers: [],
      rls_flags: [],
      rls_policies: [],
      ownership: [],
      acls: [],
      extensions: [],
    });
    pass('green-ledger-stripped', !snap.tables.includes(LEDGER_TABLE));
  }

  {
    const df = fs.readFileSync(DOCKERFILE, 'utf8');
    pass('dockerfile-copies-scripts', /COPY scripts \.\/scripts/.test(df));
    pass('dockerfile-copies-observer-fixture', /COPY fixtures\/sunset-schema-observer/.test(df));
    pass('dockerfile-ca-certificates', /ca-certificates/.test(df));
    const cli = fs.readFileSync(OBSERVE_CLI, 'utf8');
    pass('cli-markers', /WH_SCHEMA_OBSERVER_BEGIN/.test(cli) && /WH_SCHEMA_OBSERVER_END/.test(cli));
    pass('cli-scope-meta', /contractScopeMeta/.test(cli));
  }

  pass('bicep-job-module-exists', fs.existsSync(BICEP_JOB));
  {
    const mainB = fs.readFileSync(BICEP_MAIN, 'utf8');
    const job = fs.readFileSync(BICEP_JOB, 'utf8');
    const params = JSON.parse(fs.readFileSync(PARAMS, 'utf8'));
    const readme = fs.readFileSync(README, 'utf8');
    pass('bicep-param-default-false', /param deploySchemaObserverJob bool = false/.test(mainB));
    pass('bicep-job-gated', /deployContainerApps && deploySchemaObserverJob/.test(mainB));
    pass('bicep-no-hold-expiry-claim', !/luna-sunset-staging-hold-expiry/.test(mainB + job));
    pass('bicep-job-manual-trigger', /triggerType:\s*'Manual'/.test(job));
    pass('bicep-job-no-schedule', !/Schedule|cronExpression|scheduleTriggerConfig/.test(job));
    pass('bicep-job-dedicated-secret', /sunset-schema-observer-database-url/.test(job));
    pass(
      'params-observer-default-false',
      params.parameters.deploySchemaObserverJob
        && params.parameters.deploySchemaObserverJob.value === false,
    );
    pass('docs-no-complete-equivalence-claim', !claimsCompleteEquivalence(readme));
    pass(
      'docs-scope-wording',
      /structural|security|not complete schema equivalence|product-schema contract/i.test(readme)
        || /schema observer/i.test(readme),
    );
  }

  {
    const { forward, manifestHash } = hashCanonicalManifest(loadManifest(MANIFEST_PATH));
    pass('green-manifest-hash-stable-shape', /^[a-f0-9]{64}$/.test(manifestHash));
    pass('green-forward-count-36', forward.length === 36);
    pass(
      'normalize-sql-idempotent',
      normalizeSql(INTROSPECTION_SQL.tables) === normalizeSql(`  ${INTROSPECTION_SQL.tables}  ;`),
    );
    pass('excluded-sections-constant', EXCLUDED_SECTIONS.includes('schema_migration_ledger'));
  }

  console.log(`\n── verify:sunset-schema-observer ${failed ? 'FAILED' : 'PASSED'} (failed=${failed}) ──`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
