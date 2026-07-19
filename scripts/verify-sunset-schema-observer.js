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
    pass(
      'docs-slice10-standalone-module-only',
      /standalone `infra\/azure\/sunset-staging\/schema-observer-job\.bicep`/i.test(readme)
        || /standalone schema-observer-job\.bicep only/i.test(readme)
        || /Deployment path \(only\):.*schema-observer-job\.bicep/i.test(readme),
    );
  }

  // Slice 10 parameter preparer: module-only, no unrelated secret inputs
  {
    const PREP = path.join(ROOT, 'scripts', 'prepare-sunset-schema-observer-job-slice10-params.js');
    const EVIDENCE = path.join(ROOT, 'fixtures', 'sunset-schema-observer', 'slice10-job-deploy-evidence.json');
    pass('slice10-preparer-exists', fs.existsSync(PREP));
    if (fs.existsSync(PREP)) {
      const src = fs.readFileSync(PREP, 'utf8');
      pass('slice10-preparer-writes-module-params-only', /slice10-job-module\.secure\.local\.json/.test(src));
      const overlayName = ['slice10', 'deploy', 'secure', 'local', 'json'].join('-').replace(
        /^(slice10)-(deploy)-(secure)-(local)-(json)$/,
        '$1-$2.$3.$4.$5',
      );
      const pgAdmin = ['postgres', 'Admin', 'Password'].join('');
      const botTok = ['luna', 'Bot', 'Internal', 'Token'].join('');
      const appDsnSecret = ['sunset', 'database', 'url'].join('-');
      pass(
        'slice10-preparer-no-main-overlay-path',
        !src.includes(overlayName),
      );
      pass(
        'slice10-preparer-no-unrelated-secret-inputs',
        !src.includes(pgAdmin)
          && !src.includes(botTok)
          && !/SUNSET_[A-Z0-9_]*WHATSAPP/.test(src)
          && !src.includes(overlayName)
          && !src.includes(appDsnSecret)
          && !/secret show[\s\S]*luna-bot/i.test(src),
      );
      pass(
        'slice10-preparer-no-keyvault-secret-show',
        !/['"]keyvault['"]\s*,\s*['"]secret['"]\s*,\s*['"]show['"]/.test(src)
          && !/\bsecret['\s,]+show\b/.test(src)
          && !/secrets\/get/i.test(src)
          && !/Get Secret/i.test(src),
      );
      const observerCheck = (src.match(
        /Metadata-only listing[\s\S]*?(?=const image =)/,
      ) || [''])[0];
      pass(
        'slice10-preparer-observer-secret-metadata-only',
        Boolean(observerCheck)
          && /['"]keyvault['"]\s*,\s*['"]secret['"]\s*,\s*['"]list['"]/.test(observerCheck)
          && /\[\?name=='\$\{OBSERVER_SECRET\}'\]\.\{name:name, enabled:attributes\.enabled\}/.test(observerCheck)
          && /observer_secret_missing/.test(observerCheck)
          && /observer_secret_disabled/.test(observerCheck)
          && /observer_secret_ambiguous/.test(observerCheck)
          && /observer_secret_metadata_malformed/.test(observerCheck)
          && /observerSecretValueRetrieved:\s*false/.test(src),
      );
      pass(
        'slice10-preparer-no-secret-value-fields',
        Boolean(observerCheck)
          && !/['"]keyvault['"]\s*,\s*['"]secret['"]\s*,\s*['"]show['"]/.test(observerCheck)
          && !/\bsecret['\s,]+show\b/.test(observerCheck)
          && !/\bvalue\s*:/.test(observerCheck)
          && !/attributes\.value/.test(observerCheck)
          && !/['"]value['"]/.test(observerCheck),
      );
    }
    if (fs.existsSync(EVIDENCE)) {
      const ev = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8'));
      const overlayName = ['slice10', 'deploy', 'secure', 'local', 'json'].join('-').replace(
        /^(slice10)-(deploy)-(secure)-(local)-(json)$/,
        '$1-$2.$3.$4.$5',
      );
      pass(
        'slice10-evidence-no-main-overlay',
        ev.deploymentPath
          && ev.deploymentPath.mainOverlayPrepared === false
          && !String(JSON.stringify(ev)).includes(overlayName),
      );
      pass(
        'slice10-evidence-no-secret-value-retrieval',
        ev.parameterPreparerContract
          && ev.parameterPreparerContract.observerSecretValueRetrieved === false,
      );
    }
  }

  // Slice 11 correction: canonical fixture integrity (no live blessing)
  {
    const CONTRACT = path.join(ROOT, 'fixtures', 'sunset-schema-observer', 'expected-product-schema.json');
    const CAPTURE = path.join(ROOT, 'scripts', 'capture-sunset-live-schema-observation.js');
    const COMPARE = path.join(ROOT, 'scripts', 'compare-sunset-canonical-vs-live-evidence.js');
    const README = path.join(ROOT, 'infra', 'azure', 'sunset-staging', 'README.md');
    const GEN = path.join(ROOT, 'scripts', 'generate-sunset-expected-schema-contract.js');
    const EVIDENCE11 = path.join(ROOT, 'fixtures', 'sunset-schema-observer', 'slice11-job-execution-evidence.json');
    const MISMATCH = path.join(ROOT, 'fixtures', 'sunset-schema-observer', 'slice11-canonical-vs-live-mismatch-report.json');
    const FOLLOWUP = path.join(ROOT, 'fixtures', 'sunset-schema-observer', 'slice12-observer-image-repair-contract.json');
    const CONTAINER_PG = path.join(ROOT, 'scripts', 'lib', 'sunset-schema-observer-role-container-pg.js');
    const contract = JSON.parse(fs.readFileSync(CONTRACT, 'utf8'));
    const captureSrc = fs.readFileSync(CAPTURE, 'utf8');
    const compareSrc = fs.readFileSync(COMPARE, 'utf8');
    const readme = fs.readFileSync(README, 'utf8');
    const genSrc = fs.readFileSync(GEN, 'utf8');
    const containerPgSrc = fs.readFileSync(CONTAINER_PG, 'utf8');
    const evidence11 = JSON.parse(fs.readFileSync(EVIDENCE11, 'utf8'));
    const mismatch = JSON.parse(fs.readFileSync(MISMATCH, 'utf8'));
    const followup = JSON.parse(fs.readFileSync(FOLLOWUP, 'utf8'));

    const CANONICAL_FP = 'daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52';
    const LIVE_FP = 'fa7efa9246c2bd75fe41741652c462bb98b3c571906635e55a91ae5735ca1dfd';

    pass(
      'slice11-canonical-fixture-not-live-derived',
      !contract.source
        || (contract.source !== 'live-sunset-staging-observer-catalog'
          && contract.source !== 'live-observation-only'),
    );
    pass(
      'slice11-canonical-includes-customer-message-templates',
      (contract.snapshot.tables || []).includes('customer_message_templates'),
    );
    pass(
      'slice11-canonical-forward-36-with-cmt-migration',
      Number(contract.forwardCount) === 36
        && fs.existsSync(path.join(ROOT, 'database', 'migrations', '035_customer_message_templates.sql')),
    );
    pass(
      'slice11-capture-writes-tmp-only',
      /actual-live-state-evidence\.json/.test(captureSrc)
        && /refuseCanonicalOverwrite/.test(captureSrc)
        && /not canonical/i.test(captureSrc)
        && !/writeFileSync\([^)]*expected-product-schema\.json/.test(captureSrc),
    );
    pass(
      'slice11-live-capture-cannot-write-canonical-fixture',
      /refused_canonical_fixture_overwrite/.test(captureSrc)
        && /mustNotOverwriteExpectedFixture/.test(captureSrc)
        && /tmp.*foundation-slice11/.test(captureSrc)
        && /observation_output_path_locked/.test(captureSrc),
    );
    pass(
      'slice11-docs-forbid-blessing-live-drift',
      /failure requiring investigation/i.test(readme)
        && /observations only/i.test(readme)
        && /Canonical expected state/i.test(readme)
        && !/Expected contract may be refreshed from the live/i.test(readme)
        && !/capture-sunset-expected-schema-from-live/.test(readme),
    );
    pass(
      'slice11-generator-is-migration-derived',
      /canonical 36-migration|disposable local PostgreSQL|runCanonicalMigrations/i.test(genSrc)
        && /expected-product-schema\.json/.test(genSrc),
    );
    pass(
      'slice11-canonical-fixture-equals-migration-contract-fingerprint',
      contract.productFingerprint === CANONICAL_FP
        && fingerprintProductSchema(contract.snapshot) === CANONICAL_FP,
    );
    pass(
      'slice11-compare-evidence-script-exists',
      fs.existsSync(COMPARE)
        && /actual-live-state-evidence\.json/.test(compareSrc)
        && !/runStagedWorkerSource/.test(compareSrc),
    );
    pass(
      'slice11-live-derived-cannot-false-green',
      contract.productFingerprint === CANONICAL_FP
        && contract.productFingerprint !== LIVE_FP,
    );
    pass(
      'slice11-cmt-cannot-vanish-while-migration-canonical',
      (contract.snapshot.tables || []).includes('customer_message_templates')
        && /035_customer_message_templates/.test(
          fs.readFileSync(path.join(ROOT, 'database', 'migrations', 'canonical-manifest.json'), 'utf8'),
        ),
    );
    pass(
      'slice11-no-generic-arbitrary-source-worker-helper',
      !/\brunStagedWorkerSource\b/.test(containerPgSrc)
        && !/module\.exports[\s\S]*runStagedWorkerSource/.test(containerPgSrc)
        && !/Stage arbitrary worker JS/.test(containerPgSrc),
    );
    pass(
      'slice11-no-slice11-script-uploads-executable-kv-source',
      !fs.existsSync(path.join(ROOT, 'scripts', 'run-sunset-schema-observer-slice11.js'))
        && !fs.existsSync(path.join(ROOT, 'scripts', 'finish-sunset-schema-observer-slice11.js'))
        && !fs.existsSync(path.join(ROOT, 'scripts', 'lib', 'sunset-schema-observer-slice11-proof.js'))
        && !fs.existsSync(path.join(ROOT, 'scripts', 'capture-sunset-expected-schema-from-live.js'))
        && !/keyvault['"]\s*,\s*['"]secret['"]\s*,\s*['"]set['"]/.test(captureSrc)
        && !/runStagedWorkerSource/.test(captureSrc)
        && !/runContainerWorker/.test(captureSrc)
        && /does NOT upload source to Key Vault/.test(captureSrc)
        && /usedKeyVaultWorkerUpload:\s*false/.test(captureSrc),
    );
    pass(
      'slice11-no-obsolete-hardcoded-slice11final-image-in-scripts',
      (() => {
        const scriptsDir = path.join(ROOT, 'scripts');
        const needle = ['a5a57b3920b0a71f71e35786b8784de1ae25b69b', 'slice11final'].join('-');
        const bad = [];
        const walk = (dir) => {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, ent.name);
            if (ent.isDirectory()) walk(p);
            else if (/\.(js|mjs|cjs)$/.test(ent.name)) {
              const rel = path.relative(ROOT, p).replace(/\\/g, '/');
              if (rel === 'scripts/verify-sunset-schema-observer.js') continue;
              const src = fs.readFileSync(p, 'utf8');
              if (src.includes(needle)) bad.push(rel);
            }
          }
        };
        walk(scriptsDir);
        return bad.length === 0;
      })(),
    );
    pass(
      'slice11-current-job-marked-unsafe-for-canonical-monitoring',
      evidence11.finalJobState
        && evidence11.finalJobState.currentImageContainsLiveDerivedExpectedFixture === true
        && evidence11.finalJobState.safeForCanonicalMonitoring === false
        && evidence11.finalJobState.defaultExecutionWouldFalseGreen === true
        && evidence11.passed === false
        && /unresolved/i.test(String(evidence11.outcome || '')),
    );
    pass(
      'slice11-mismatch-evidence-totals-reconcile-88',
      mismatch.mismatchCount === 88
        && Array.isArray(mismatch.mismatches)
        && mismatch.mismatches.length === 88
        && mismatch.counts
        && (mismatch.counts.expected_only + mismatch.counts.live_only + mismatch.counts.definition_mismatch) === 88
        && mismatch.canonicalExpectedFingerprint === CANONICAL_FP
        && mismatch.actualLiveFingerprint === LIVE_FP
        && mismatch.observerExitIfRun === 4
        && mismatch.match === false
        && mismatch.containsProductRowValues === false
        && Object.values(mismatch.groupCounts || {}).reduce((a, b) => a + Number(b || 0), 0) === 88,
    );
    pass(
      'slice11-followup-image-repair-contract-present',
      followup.kind === 'sunset-schema-observer-slice12-image-repair-contract'
        && followup.canonicalExpectedFingerprintRequired === CANONICAL_FP
        && followup.expectedObserverExitWhileDriftRemains === 4
        && followup.databaseRepairOutOfScope === true
        && followup.currentJobUnsafeUntilImageRepair === true,
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
