'use strict';

/**
 * verify:sunset-schema-slice14n — FOUNDATION Slice 14N RED→GREEN
 * Lunabox PostgreSQL firewall rule (gated ARM apply; offline + evidence).
 * Verifier does not re-run live mutation.
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
  EXPECTED_028_SHA256,
  AUTHORIZED_AGGREGATE_SQL: AGG_14A,
  DATE_WINDOW_PREDICATE,
  PRICE_UNIT_PREDICATE,
  assert028PredicatesPresentInSource,
  assertMigration028ByteIntegrity,
} = require('./lib/phase-d-check-preflight');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  PHASE_D_LUNABOX_PG_FIREWALL_LIVE_APPLY_ENABLED,
  PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED,
  PHASE_D_LUNABOX_PG_FIREWALL_DELETE_ENABLED,
  ENV_FIREWALL_APPLY,
  CLI_APPLY_FIREWALL_RULE,
  FIREWALL_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  evaluateFirewallApplyGates,
  executeLunaboxPgFirewallApply,
  exactFirewallApplyArgv,
  firewallApplyEnv,
  createInjectedFirewallHttp,
  createLiveFirewallHttpRequest,
  assertBicepFirewallModuleLocked,
  resetFirewallApplyCounters,
  getFirewallApplyCounters,
} = require('./lib/phase-d-lunabox-pg-firewall-apply');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '6da7470029cf747f7326b255ec0651aa975c937c';
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
  'default_path_zero_http',
  'missing_apply_flag_zero_http',
  'missing_env_zero_http',
  'wrong_exact_targets_zero_http',
  'ip_range_rejected_zero_http',
  'zero_ip_rejected_zero_http',
  'outbound_ip_mismatch_zero_put',
  'sanitized_put_failure',
  'live_transport_rejects_host_method_body_deviations',
];

const REQUIRED_GREEN = [
  'live_apply_activated_delete_disabled',
  'exact_gates_pass',
  'exact_one_put_sequence_injected',
  'offline_mode_zero_http',
  'cli_default_disabled',
  'cli_missing_env_refuses_zero_http',
  'usage_and_locks',
  'no_pg_client_hashes_preserved',
];

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('verify:sunset-schema-slice14n — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14n-lunabox-pg-firewall-evidence.json');
  const contractPath = path.join(FIX, 'slice14n-lunabox-pg-firewall-contract.json');
  const findingsPath = path.join(FIX, 'slice14n-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14n-lunabox-pg-firewall.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14n.js');
  const cliPath = path.join(ROOT, 'scripts', 'run-phase-d-lunabox-pg-firewall-apply.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-lunabox-pg-firewall-apply.js');
  const bicepPath = path.join(ROOT, FIREWALL_LOCKS.bicepModuleRel);
  const paramsPath = path.join(ROOT, FIREWALL_LOCKS.bicepParametersRel);

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, provePath, cliPath, libPath, bicepPath, paramsPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const cliSrc = fs.readFileSync(cliPath, 'utf8');
  const libSrc = fs.readFileSync(libPath, 'utf8');
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
  pass('028-predicates', (() => {
    assert028PredicatesPresentInSource();
    assertMigration028ByteIntegrity();
    return true;
  })());
  pass('aggregate-sql-unchanged', contract.authorizedAggregateSqlUnchanged === AGG_14A
    && contract.predicatesUnchangedFrom14A.date_window === DATE_WINDOW_PREDICATE
    && contract.predicatesUnchangedFrom14A.price_unit === PRICE_UNIT_PREDICATE);

  pass('master-basis', evidence.masterShaBasis === MASTER && /6da7470/.test(findings));
  pass('still-product-schema-differs', evidence.stillProductSchemaDiffers === true
    && contract.stillProductSchemaDiffers === true);
  pass('phase-d-constraint-apply-disabled', PHASE_D_LIVE_APPLY_ENABLED === false
    && evidence.phaseDConstraintsApplied === false);
  pass('firewall-live-apply-enabled', PHASE_D_LUNABOX_PG_FIREWALL_LIVE_APPLY_ENABLED === true
    && PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED === true);
  pass('delete-disabled', PHASE_D_LUNABOX_PG_FIREWALL_DELETE_ENABLED === false
    && evidence.deleteEnabled === false);
  pass('no-pg-client', evidence.postgresClientOpened === false
    && evidence.postgresQueryExecuted === false
    && evidence.pgClientInstantiated === 0
    && evidence.realPostgresCall === false);
  pass('one-put-zero-retries', evidence.putCount === 1
    && evidence.armPutCount === 1
    && evidence.armDeleteCount === 0
    && evidence.retries === 0);
  pass('firewall-action-true', evidence.firewallAction === true
    && contract.firewallMutation === true);
  pass('live-mutation-true', evidence.liveMutation === true
    && contract.liveMutation === true);
  pass('network-mutation-true', evidence.networkMutation === true
    && contract.networkMutation === true);
  pass('non-network-mutations-false', evidence.kvMutation === false
    && evidence.rbacMutation === false
    && evidence.identityMutation === false
    && contract.kvMutation === false
    && contract.rbacMutation === false
    && contract.identityMutation === false
    && evidence.postgresClientOpened === false
    && evidence.postgresQueryExecuted === false);
  pass('apply-flag-present', evidence.applyFlagPresent === true);
  pass('rules-before-after-2-to-3', evidence.rulesBeforeCount === 2
    && evidence.rulesAfterCount === 3
    && Array.isArray(evidence.existingRulesBefore)
    && evidence.existingRulesBefore.length === 2
    && Array.isArray(evidence.existingRulesAfter)
    && evidence.existingRulesAfter.length === 3
    && evidence.existingRulesBefore.length === evidence.rulesBeforeCount
    && evidence.existingRulesAfter.length === evidence.rulesAfterCount);
  pass('existing-arrays-count-consistency', (() => {
    const before = evidence.existingRulesBefore;
    const after = evidence.existingRulesAfter;
    const locked = [
      { name: 'AllowSunsetCaeEgress', startIpAddress: '4.209.106.13', endIpAddress: '4.209.106.13' },
      { name: 'AllowSunsetAppEgress', startIpAddress: '4.208.189.26', endIpAddress: '4.208.189.26' },
    ];
    const third = {
      name: 'AllowLunaboxEgress',
      startIpAddress: '20.238.124.76',
      endIpAddress: '20.238.124.76',
    };
    const beforeOk = JSON.stringify(before) === JSON.stringify(locked);
    const afterOk = JSON.stringify(after) === JSON.stringify(locked.concat([third]));
    const liveOk = evidence.liveResult
      && evidence.liveResult.rulesBeforeCount === 2
      && evidence.liveResult.rulesAfterCount === 3
      && JSON.stringify(evidence.liveResult.existingRulesAfter) === JSON.stringify(after);
    return beforeOk && afterOk && liveOk;
  })());
  pass('exactly-one-historical-live-put', evidence.usedLiveHttp === true
    && evidence.realArmCall === true
    && evidence.putCount === 1
    && evidence.armPutCount === 1
    && evidence.liveResult
    && evidence.liveResult.putCount === 1
    && evidence.liveResult.armPutCount === 1
    && evidence.liveResult.networkMutation === true
    && (evidence.redCases || []).every((r) => r.name !== 'historical_live_put_duplicate'));
  pass('generated-at-preserved-historical', evidence.generatedAt === '2026-07-19T21:07:57.711Z'
    && /2026-07-19T21:07:57\.711Z/.test(findings));
  pass('third-rule-exact', evidence.thirdRuleExact === true
    && evidence.firewallRuleName === 'AllowLunaboxEgress'
    && evidence.startIpAddress === '20.238.124.76'
    && evidence.endIpAddress === '20.238.124.76');
  pass('existing-rules-unchanged', evidence.existingRulesUnchanged === true
    && evidence.rulesAfterCount === 3
    && Array.isArray(evidence.existingRulesBefore)
    && evidence.existingRulesBefore.length === 2);
  pass('server-ready-public-access', evidence.serverRemainedReady === true
    && evidence.publicNetworkAccessUnchanged === true
    && evidence.publicNetworkAccessBefore === 'Enabled');
  pass('outbound-ip-matched', evidence.outboundIpv4Matched === true
    && evidence.outboundIpv4Service1 === '20.238.124.76'
    && evidence.outboundIpv4Service2 === '20.238.124.76');
  pass('cost-snapshots-present', evidence.costBefore
    && evidence.costAfter
    && evidence.costBefore.actual
    && evidence.costBefore.amortized
    && evidence.costAfter.actual
    && evidence.costAfter.amortized
    && evidence.firewallRuleExpectedDirectCharge === false);
  pass('bicep-standalone-locked', assertBicepFirewallModuleLocked(ROOT).ok === true);
  pass('main-bicep-not-deployed', evidence.mainBicepDeployed === false
    && contract.mainBicepDeployed === false
    && !/module\s+lunabox/.test(fs.readFileSync(path.join(ROOT, 'infra/azure/sunset-staging/main.bicep'), 'utf8')));

  const redNames = (evidence.redCases || []).map((r) => r.name);
  const greenNames = (evidence.greenCases || []).map((g) => g.name);
  for (const name of REQUIRED_RED) {
    pass(`red-case:${name}`, redNames.includes(name));
  }
  for (const name of REQUIRED_GREEN) {
    pass(`green-case:${name}`, greenNames.includes(name));
  }

  pass('npm-scripts', Boolean(
    pkg.scripts['prove:sunset-schema-slice14n-lunabox-pg-firewall']
    && pkg.scripts['verify:sunset-schema-slice14n']
    && pkg.scripts['phase-d:lunabox-pg-firewall-apply'],
  ));
  pass('cli-gates-surface', Boolean(
    cliSrc.includes('ENV_FIREWALL_APPLY')
    && cliSrc.includes('CLI_APPLY_FIREWALL_RULE')
    && libSrc.includes('SUNSET_PHASE_D_LUNABOX_PG_FIREWALL_APPLY')
    && libSrc.includes('--apply-firewall-rule')
    && libSrc.includes('AllowLunaboxEgress')
    && libSrc.includes('20.238.124.76'),
  ));
  pass('verifier-does-not-live-mutate', !verifySrc.includes('executeLunaboxPgFirewallApply({')
    || /httpRequest:\s*inject|createInjectedFirewallHttp|offline:\s*true|forbidLiveHttp:\s*true/.test(verifySrc));
  pass('prove-default-offline-no-live', /offlineOnly|SUNSET_SLICE14N_PROOF_OFFLINE|--live/.test(proveSrc)
    && /skipped live ARM\/HTTP|zero additional live calls/.test(proveSrc)
    && !/console\.log\('live: outbound IP/.test(proveSrc.split('if (offlineOnly)')[0]));
  pass('prove-mentions-zero-pg', /zero PostgreSQL|No PostgreSQL/i.test(proveSrc)
    && /zero PostgreSQL/i.test(findings));
  pass('safe-output-keys-locked', SAFE_OUTPUT_KEYS.includes('putCount')
    && SAFE_OUTPUT_KEYS.includes('costBefore')
    && SAFE_OUTPUT_KEYS.includes('networkMutation')
    && !SAFE_OUTPUT_KEYS.includes('token'));
  pass('forbidden-argv-locked', FORBIDDEN_ARGV_FLAGS.includes('--delete')
    && FORBIDDEN_ARGV_FLAGS.includes('--retry')
    && FORBIDDEN_ARGV_FLAGS.includes('--token'));

  // Offline re-check: default refuse + injected GREEN (no live)
  resetFirewallApplyCounters();
  {
    const r = await executeLunaboxPgFirewallApply({ env: {}, argv: [], offline: true, forbidLiveHttp: true });
    pass('offline-default-refuse', r.ok === false && getFirewallApplyCounters().httpRequestCount === 0);
  }
  {
    const gates = evaluateFirewallApplyGates({
      env: firewallApplyEnv(),
      argv: exactFirewallApplyArgv(),
    });
    pass('offline-exact-gates', gates.ok === true);
  }
  {
    const inject = createInjectedFirewallHttp({
      imdsAccessToken: 'verify-slice14n-token-never-commit',
      costBeforeAmount: 1,
      costAfterAmount: 1,
    });
    resetFirewallApplyCounters();
    const r = await executeLunaboxPgFirewallApply({
      env: firewallApplyEnv(),
      argv: exactFirewallApplyArgv(),
      httpRequest: inject,
      pollDelayMs: 0,
      offline: true,
      forbidLiveHttp: true,
    });
    pass('offline-injected-one-put', r.ok === true && r.putCount === 1 && r.thirdRuleExact === true
      && r.rulesBeforeCount === 2 && r.rulesAfterCount === 3
      && r.networkMutation === true && r.firewallAction === true
      && r.usedLiveHttp === false
      && getFirewallApplyCounters().httpRequestCount > 0);
  }
  {
    resetFirewallApplyCounters();
    const r = await executeLunaboxPgFirewallApply({
      env: firewallApplyEnv(),
      argv: exactFirewallApplyArgv(),
      offline: true,
      forbidLiveHttp: true,
    });
    pass('offline-forbid-live-http', r.ok === false
      && r.code === 'http_transport_unavailable'
      && getFirewallApplyCounters().httpRequestCount === 0
      && r.networkMutation === false);
  }
  {
    const cli = spawnSync(process.execPath, [cliPath], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env },
    });
    pass('offline-cli-default', cli.status !== 0);
  }
  pass('live-transport-present', typeof createLiveFirewallHttpRequest() === 'function');
  pass('prove-offline-argv-gate', proveSrc.includes("process.argv.includes('--live')")
    && proveSrc.includes('offlineOnly'));

  // Evidence must record live PUT happened once — verifier must not re-PUT
  pass('evidence-live-put-recorded', evidence.usedLiveHttp === true
    && evidence.realArmCall === true
    && evidence.liveResult
    && evidence.liveResult.putCount === 1);

  console.log(`\n── verify:sunset-schema-slice14n: ${failed ? 'FAILED' : 'ALL CHECKS PASSED'} ──`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
