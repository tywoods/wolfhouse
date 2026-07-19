'use strict';

/**
 * verify:sunset-schema-slice14o — FOUNDATION Slice 14O RED→GREEN
 * Post-firewall Phase D live read-only counts (offline gates + live evidence).
 * Does NOT re-run live firewall prestate, credential-preflight, or live count.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  sha256CanonicalLfV1File,
} = require('./lib/migration-integrity');
const { hashCanonicalManifest } = require('./lib/sunset-schema-observer');
const {
  TARGETS,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  AUTHORIZED_AGGREGATE_SQL,
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  ENV_EXECUTE_COUNT_ONLY,
  CLI_EXECUTE_COUNT_ONLY,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  EXPECTED_028_SHA256,
  AUTHORIZED_AGGREGATE_SQL: AGG_14A,
  assert028PredicatesPresentInSource,
  assertMigration028ByteIntegrity,
} = require('./lib/phase-d-check-preflight');
const {
  createInjectedAzureAdapters,
  createInjectedDbAdapters,
} = require('./lib/phase-d-live-readonly-adapters');
const {
  AUTHORIZED_SEQUENCE,
  executePhaseDLiveReadonlyPgAdapter,
  createScriptedFakePgClientFactory,
  getPgClientInstantiateCount,
  resetPgClientInstantiateCount,
  classifyConnectError,
  CONNECT_FAILED_SAFE_MESSAGE,
  CONNECT_DRIVER_CODE_CATEGORY,
  CONNECT_MESSAGE_SYNTHETIC_CODE,
  CONNECT_CATEGORIES,
  CONNECT_MESSAGE_PROBE_MAX_LEN,
} = require('./lib/phase-d-live-readonly-pg-adapter');
const {
  evaluatePhaseDLiveReadonlyCliGates,
} = require('./lib/phase-d-live-readonly-cli');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  MI_LOADER_LOCKS,
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  getManagedIdentityHttpCounters,
  resetManagedIdentityHttpCounters,
} = require('./lib/phase-d-managed-identity-credential-loader');
const {
  FIREWALL_LOCKS,
  EXPECTED_POST_FIREWALL_RULES,
  createInjectedFirewallHttp,
  executeLunaboxPgFirewallPrestateVerify,
  resetFirewallApplyCounters,
  extractExactThreeFirewallRules,
  PHASE_D_LUNABOX_PG_FIREWALL_DELETE_ENABLED,
} = require('./lib/phase-d-lunabox-pg-firewall-apply');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = 'c0874b04a622190766e74c443bc361e1776ef02f';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const REQUIRED_RED = [
  'default_path_zero_http_and_clients',
  'missing_execute_gate_zero_clients',
  'wrong_or_forbidden_cli_args_zero_clients',
  'managed_identity_requires_env_and_argv',
  'firewall_outbound_ip_mismatch_zero_postgres',
  'firewall_rule_count_mismatch_zero_postgres',
  'firewall_server_not_ready_zero_postgres',
  'connect_classifier_secret_messages_sanitize',
];

const REQUIRED_GREEN = [
  'injected_firewall_prestate_exact_three_rules',
  'injected_http_success_exact_count_sequence',
  'cli_gates_managed_identity_exact_targets',
  'count_only_cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name_firewall',
  'apply_disabled_connect_and_http_enabled',
  'connect_classifier_category_mappings',
];

const FAKE_USER = 'verify-slice14o-admin-user';
const FAKE_PASSWORD = 'verify-slice14o-admin-password';
const FAKE_TOKEN = 'verify-slice14o-imds-token';

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function miEnv(extra) {
  return {
    [ENV_LIVE_READONLY]: '1',
    [ENV_LIVE_PREFLIGHT]: '1',
    [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    [ENV_EXECUTE_COUNT_ONLY]: '1',
    [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    ...(extra || {}),
  };
}

function miArgv() {
  return [
    CLI_EXECUTE_COUNT_ONLY,
    '--subscription', TARGETS.subscriptionId,
    '--resource-group', TARGETS.resourceGroup,
    '--postgres-server', TARGETS.postgresServer,
    '--database', TARGETS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ];
}

async function main() {
  console.log('verify:sunset-schema-slice14o — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14o-post-firewall-phase-d-counts-evidence.json');
  const contractPath = path.join(FIX, 'slice14o-post-firewall-phase-d-counts-contract.json');
  const findingsPath = path.join(FIX, 'slice14o-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14o-post-firewall-phase-d-counts.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14o.js');
  const countCliPath = path.join(ROOT, 'scripts', 'run-phase-d-live-readonly-count-only.js');
  const preflightCliPath = path.join(ROOT, 'scripts', 'run-phase-d-credential-preflight.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-lunabox-pg-firewall-apply.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, provePath, verifyPath, countCliPath, preflightCliPath, libPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const expectedBytes = fs.readFileSync(expectedPath);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);

  const live028 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '028_tenant_services.sql'));
  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
  const live040 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '040_tenant_services_saas_catalog_columns.sql'));
  const live041 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '041_notification_surfpack_convergence.sql'));

  pass('manifest-integrity', integrity.ok === true);
  pass('forward-count-39', forward.length === 39);
  pass('manifest-hash-preserved', manifestHash === MANIFEST_HASH
    && evidence.manifestHashUnchanged === MANIFEST_HASH);
  pass('expected-byte-sha-preserved', expectedHash === EXPECTED_BYTE_SHA
    && evidence.expectedProductSchemaByteSha256 === EXPECTED_BYTE_SHA);
  pass('product-fingerprint-preserved', evidence.productFingerprintUnchanged === CANON_FP);
  pass('migration-028-hash', live028 === LOCKED_13C_SHA['028']);
  pass('migration-035-hash', live035 === LOCKED_13C_SHA['035']);
  pass('migration-040-hash', live040 === LOCKED_13C_SHA['040']);
  pass('migration-041-hash', live041 === LOCKED_13C_SHA['041']);
  assertMigration028ByteIntegrity();
  assert028PredicatesPresentInSource();
  pass('14a-aggregate-unchanged', AUTHORIZED_AGGREGATE_SQL === AGG_14A);
  pass('connect-enabled-apply-disabled',
    PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true
    && PHASE_D_LIVE_APPLY_ENABLED === false
    && PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true
    && PHASE_D_LUNABOX_PG_FIREWALL_DELETE_ENABLED === false);

  pass('evidence-shape',
    evidence.kind === 'sunset-schema-observer-slice14o-post-firewall-phase-d-counts-evidence'
    && evidence.secretFree === true
    && evidence.slice === '14O'
    && evidence.stillProductSchemaDiffers === true
    && evidence.liveMutation === false
    && evidence.firewallAction === false
    && evidence.networkMutation === false
    && evidence.kvMutation === false
    && evidence.rbacMutation === false
    && evidence.phaseDConstraintsApplied === false
    && evidence.forwardCountUnchanged === 39
    && evidence.connectErrorClassifierApplied === true);

  pass('contract-shape',
    contract.kind === 'sunset-schema-observer-slice14o-post-firewall-phase-d-counts-contract'
    && contract.mutates === false
    && contract.firewallMutation === false
    && contract.networkMutation === false
    && contract.verifyNeverRerunsLive === true
    && contract.firewallPrestateRequiredBeforeCredentialPreflight === true
    && contract.credentialPreflightRequiredBeforeLiveCount === true);

  const redNames = (evidence.redCases || []).map((c) => c.name);
  const greenNames = (evidence.greenCases || []).map((c) => c.name);
  pass('red-cases-complete', REQUIRED_RED.every((n) => redNames.includes(n)));
  pass('green-cases-complete', REQUIRED_GREEN.every((n) => greenNames.includes(n)));
  pass('zero-mutation-flags',
    evidence.liveMutation === false
    && evidence.applyFlagPresent === false
    && evidence.appliesConstraints === false
    && evidence.writesLedger === false
    && evidence.migrationAdded === false
    && evidence.newForwardMigration === false);

  const fw = evidence.firewallPrestateOutcome;
  pass('firewall-prestate-evidence',
    fw
    && typeof fw === 'object'
    && fw.putCount === 0
    && fw.armPutCount === 0
    && fw.armDeleteCount === 0
    && fw.retries === 0
    && fw.liveMutation === false
    && fw.networkMutation === false
    && fw.firewallAction === false
    && fw.pgClientInstantiated === 0
    && fw.realPostgresCall === false);

  if (fw && fw.ok === true) {
    pass('firewall-prestate-ok-shape',
      fw.serverState === 'Ready'
      && fw.publicNetworkAccess === 'Enabled'
      && fw.rulesCount === 3
      && fw.exactThreeRules === true
      && fw.allowLunaboxEgressExact === true
      && fw.outboundIpv4Matched === true
      && fw.outboundIpv4Service1 === FIREWALL_LOCKS.expectedOutboundIpv4
      && fw.outboundIpv4Service2 === FIREWALL_LOCKS.expectedOutboundIpv4
      && Array.isArray(fw.firewallRules)
      && fw.firewallRules.length === 3
      && fw.firewallRules.some((r) => r.name === 'AllowLunaboxEgress'
        && r.cidr === '20.238.124.76/32'));
  } else {
    pass('firewall-prestate-blocked-recorded',
      fw && fw.ok === false && typeof fw.blocker === 'string');
  }

  const pf = evidence.credentialPreflightOutcome;
  if (fw && fw.ok === true) {
    pass('credential-preflight-attempted-after-firewall',
      evidence.credentialPreflightAttemptCount === 1 && pf && typeof pf === 'object');
    if (pf && pf.ok === true) {
      pass('credential-preflight-exact-targets',
        pf.postgresHost === TARGETS.postgresHost
        && pf.database === TARGETS.database
        && pf.sslmode === 'verify-full'
        && pf.secretTargetValid === true
        && pf.clientsInstantiated === 0
        && pf.realPostgresCall === false);
    } else {
      pass('credential-preflight-blocked-recorded',
        pf && pf.ok === false && typeof pf.blocker === 'string');
    }
  } else {
    pass('credential-preflight-skipped-when-firewall-blocked',
      evidence.credentialPreflightAttemptCount === 0
      && evidence.liveCountAttemptCount === 0);
  }

  const count = evidence.liveCountOutcome;
  if (pf && pf.ok === true) {
    pass('live-count-attempted-once',
      evidence.liveCountAttemptCount === 1 && count && typeof count === 'object');
    if (count && count.ok === true) {
      pass('safe-counts-recorded',
        evidence.safeCounts
        && Number.isFinite(evidence.safeCounts.total_rows)
        && Number.isFinite(evidence.safeCounts.date_window_violations)
        && Number.isFinite(evidence.safeCounts.price_unit_violations)
        && count.applicationName === 'wh-sunset-phase-d-preflight'
        && count.sslmode === 'verify-full'
        && count.clientsInstantiated === 1
        && count.connectCalls === 1
        && count.endCalls === 1
        && count.queryCalls === AUTHORIZED_SEQUENCE.length
        && evidence.clientCallCounts.liveCountSessions === 1
        && count.liveMutation === false);
    } else {
      pass('live-count-blocked-classified',
        count
        && count.ok === false
        && typeof count.blocker === 'string'
        && (count.message == null || count.message === CONNECT_FAILED_SAFE_MESSAGE)
        && evidence.safeCounts === null);
    }
  } else if (fw && fw.ok === true) {
    pass('live-count-skipped-when-preflight-blocked',
      evidence.liveCountAttemptCount === 0 && evidence.safeCounts === null);
  } else {
    pass('live-count-skipped-when-firewall-blocked', true);
  }

  pass('expected-post-firewall-rules-locked',
    EXPECTED_POST_FIREWALL_RULES.length === 3
    && EXPECTED_POST_FIREWALL_RULES[2].name === 'AllowLunaboxEgress'
    && EXPECTED_POST_FIREWALL_RULES[2].startIpAddress === '20.238.124.76'
    && extractExactThreeFirewallRules(
      EXPECTED_POST_FIREWALL_RULES.map((r) => ({
        name: r.name,
        properties: { startIpAddress: r.startIpAddress, endIpAddress: r.endIpAddress },
      })),
    ).ok === true);

  // Offline runtime re-checks (injected only — never live)
  resetFirewallApplyCounters();
  const injFw = await executeLunaboxPgFirewallPrestateVerify({
    httpRequest: createInjectedFirewallHttp({ postFirewallRulesPresent: true }),
  });
  pass('runtime-injected-firewall-prestate',
    injFw.ok === true
    && injFw.rulesCount === 3
    && injFw.putCount === 0
    && injFw.outboundIpv4Matched === true);

  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const FakeOk = createScriptedFakePgClientFactory({
    responses: {
      aggregate: {
        rows: [{ total_rows: 7, date_window_violations: 1, price_unit_violations: 0 }],
        rowCount: 1,
      },
    },
  });
  const okRun = await executePhaseDLiveReadonlyPgAdapter({
    env: miEnv(),
    argv: ['node', 'verify-14o', ...miArgv()],
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_TOKEN,
      defaultSecretValue: buildOfflineProofSunsetDatabaseUrl(FAKE_USER, FAKE_PASSWORD),
    }),
    Client: FakeOk,
  });
  pass('runtime-injected-count-sequence',
    okRun.ok === true
    && okRun.counts.total_rows === 7
    && okRun.clientsInstantiated === 1
    && getPgClientInstantiateCount() === 1
    && getManagedIdentityHttpCounters().httpRequestCount === 2
    && JSON.stringify(okRun.steps) === JSON.stringify(AUTHORIZED_SEQUENCE));

  const gates = evaluatePhaseDLiveReadonlyCliGates({
    env: miEnv(),
    argv: miArgv(),
  });
  pass('runtime-cli-gates',
    gates.ok === true
    && gates.managedIdentityCredentialSource === true);

  const evil = 'verify-slice14o-classifier-secret-never-commit';
  const clsUnknown = classifyConnectError(Object.assign(
    new Error(`unclassified boom password=${evil}`),
    { code: 'NOT_ALLOWLISTED' },
  ));
  const clsMsgFw = classifyConnectError(Object.assign(
    new Error(`no pg_hba.conf entry; firewall; client IP not allowed password=${evil}`),
    { code: 'ZZ_UNKNOWN' },
  ));
  const clsProbe = JSON.stringify([clsUnknown, clsMsgFw]);
  pass('runtime-connect-classifier',
    clsUnknown.category === 'unknown'
    && clsUnknown.message === CONNECT_FAILED_SAFE_MESSAGE
    && clsMsgFw.category === 'firewall'
    && clsMsgFw.code === CONNECT_MESSAGE_SYNTHETIC_CODE.firewall
    && !clsProbe.includes(evil)
    && Object.keys(CONNECT_DRIVER_CODE_CATEGORY).length >= 15
    && CONNECT_CATEGORIES.includes('firewall')
    && CONNECT_MESSAGE_PROBE_MAX_LEN === 512);

  const cliDefault = spawnSync(process.execPath, [countCliPath], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  pass('count-cli-default-refuse', cliDefault.status !== 0);

  pass('source-forbids-live-mutation',
    !/\baz\s+keyvault\b/i.test(proveSrc)
    && !/\baz\s+postgres\b/i.test(proveSrc)
    && !/--apply-firewall-rule\b/.test(proveSrc)
    && !/ADD\s+CONSTRAINT\s+tenant_services_date_window/i.test(proveSrc)
    && !/schema_migration_ledger/.test(proveSrc)
    && !/INSERT\s+INTO/i.test(proveSrc)
    && evidence.stillProductSchemaDiffers === true
    && /executeLunaboxPgFirewallPrestateVerify/.test(proveSrc));

  const libSrc = fs.readFileSync(libPath, 'utf8');
  pass('lib-has-prestate-and-apply-separate',
    /executeLunaboxPgFirewallPrestateVerify/.test(libSrc)
    && /executeLunaboxPgFirewallApply/.test(libSrc)
    && /extractExactThreeFirewallRules/.test(libSrc));

  pass('npm-commands',
    pkg.scripts['prove:sunset-schema-slice14o-post-firewall-phase-d-counts']
      === 'node scripts/prove-sunset-schema-slice14o-post-firewall-phase-d-counts.js'
    && pkg.scripts['verify:sunset-schema-slice14o']
      === 'node scripts/verify-sunset-schema-slice14o.js'
    && pkg.scripts['phase-d:live-readonly-count-only']
      === 'node scripts/run-phase-d-live-readonly-count-only.js'
    && pkg.scripts['phase-d:credential-preflight']
      === 'node scripts/run-phase-d-credential-preflight.js');

  pass('findings-non-claim',
    /Do not claim/i.test(findings)
    && /Zero DB mutation/i.test(findings)
    && /AllowLunaboxEgress/.test(findings)
    && /20\.238\.124\.76\/32/.test(findings)
    && /post-firewall/i.test(findings)
    && !/Sunset is repaired/i.test(findings.replace(/Do not claim[\s\S]*?repaired/i, '')));

  const artifactText = `${JSON.stringify(evidence)}${JSON.stringify(contract)}${findings}`;
  pass('no-secret-tokens-in-artifacts',
    !/slice14o-proof-admin-password|verify-slice14o-admin-password|slice14o-proof-imds-token/i.test(artifactText)
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(artifactText)
    && !/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/.test(artifactText));

  pass('master-basis',
    evidence.masterShaBasis === MASTER
    && contract.masterShaBasis === MASTER);

  pass('verify-is-offline-only',
    !/credentialPreflightEnv\(\)/.test(verifySrc)
    && !/exactCredentialPreflightArgv\(\)/.test(verifySrc)
    && !/spawnSync\(process\.execPath,\s*\[preflightCliPath/.test(verifySrc)
    && !/spawnSync\(process\.execPath,\s*\[countCliPath,\s*\.\.\./.test(verifySrc)
    && !/executeLunaboxPgFirewallPrestateVerify\(\{\s*\}\)/.test(verifySrc)
    && /createInjectedManagedIdentityHttp/.test(verifySrc)
    && /createScriptedFakePgClientFactory/.test(verifySrc)
    && /createInjectedFirewallHttp/.test(verifySrc)
    && /Does NOT re-run live/.test(verifySrc));

  pass('prove-one-live-count-max',
    /Live section 3\/3/.test(proveSrc)
    && /Live section 1\/3/.test(proveSrc)
    && /Live section 2\/3/.test(proveSrc)
    && /countAttempted = true/.test(proveSrc)
    && /firewallPrestateAttemptCount/.test(proveSrc)
    && /credentialPreflightAttemptCount/.test(proveSrc)
    && /liveCountAttemptCount/.test(proveSrc)
    && (proveSrc.match(/spawnSync\(/g) || []).length === 3);

  // Prior slice verifiers remain (static gate list)
  for (const slice of ['14a', '14b', '14c', '14d', '14e', '14f', '14g', '14h', '14j', '14k', '14m', '14n']) {
    const key = `verify:sunset-schema-slice${slice}`;
    pass(`prior-slice-script-${slice}`, typeof pkg.scripts[key] === 'string');
  }

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14o FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14o GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
