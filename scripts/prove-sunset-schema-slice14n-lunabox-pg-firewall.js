'use strict';

/**
 * prove-sunset-schema-slice14n-lunabox-pg-firewall — FOUNDATION Slice 14N
 *
 * Offline RED/GREEN (injected HTTP) → exactly ONE live ARM PUT of
 * AllowLunaboxEgress (20.238.124.76) on luna-sunset-staging-pg-app via
 * managed-identity ARM REST. No PostgreSQL client/query. No main.bicep deploy.
 * No delete/broaden/retry. Cost actual/amortized before+after (safe totals only).
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
  getFirewallApplyCounters,
  resetFirewallApplyCounters,
  evaluateFirewallApplyGates,
  executeLunaboxPgFirewallApply,
  exactFirewallApplyArgv,
  firewallApplyEnv,
  createInjectedFirewallHttp,
  createLiveFirewallHttpRequest,
  assertLockedFirewallLiveRequest,
  assertBicepFirewallModuleLocked,
  pickSafeFirewallOutput,
} = require('./lib/phase-d-lunabox-pg-firewall-apply');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14n-lunabox-pg-firewall-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14n-lunabox-pg-firewall-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14n-findings.md');
const CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-lunabox-pg-firewall-apply.js');

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

const FAKE_IMDS_TOKEN = 'slice14n-proof-imds-token-never-commit';

function leakScan(value, secrets) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const s of secrets) {
    if (s && text.includes(s)) {
      throw new Error(`secret leaked into proof artifact: ${s.slice(0, 8)}…`);
    }
  }
  if (/Bearer\s+slice14n-proof-imds-token/i.test(text)) {
    throw new Error('IMDS token leaked into proof artifact');
  }
}

function assertSafeOutputShape(result) {
  const keys = Object.keys(result || {});
  for (const k of keys) {
    if (!SAFE_OUTPUT_KEYS.includes(k)) {
      throw new Error(`unsafe output key: ${k}`);
    }
  }
  const forbidden = [
    'token', 'access_token', 'password', 'user', 'dsn', '_token', 'Authorization',
  ];
  for (const k of forbidden) {
    if (Object.prototype.hasOwnProperty.call(result || {}, k)) {
      throw new Error(`forbidden output key present: ${k}`);
    }
  }
}

async function main() {
  console.log('prove:sunset-schema-slice14n-lunabox-pg-firewall — offline then live\n');

  const red = [];
  const green = [];
  const generatedAt = new Date().toISOString();

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) throw new Error('manifest integrity failed');
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  if (manifestHash !== MANIFEST_HASH) throw new Error('manifest hash drift');
  if (forward.length !== 39) throw new Error('forward count drift');

  assertMigration028ByteIntegrity();
  assert028PredicatesPresentInSource();
  const live028 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '028_tenant_services.sql'));
  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
  const live040 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '040_tenant_services_saas_catalog_columns.sql'));
  const live041 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '041_notification_surfpack_convergence.sql'));
  if (live028 !== LOCKED_13C_SHA['028']
    || live035 !== LOCKED_13C_SHA['035']
    || live040 !== LOCKED_13C_SHA['040']
    || live041 !== LOCKED_13C_SHA['041']) {
    throw new Error('13C migration hash drift');
  }

  const expectedBytes = fs.readFileSync(EXPECTED_PATH);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  if (expectedHash !== EXPECTED_BYTE_SHA) throw new Error('expected product schema byte drift');

  const bicepLock = assertBicepFirewallModuleLocked(ROOT);
  if (!bicepLock.ok) throw new Error(`bicep lock failed: ${JSON.stringify(bicepLock.errors)}`);

  if (PHASE_D_LIVE_APPLY_ENABLED !== false) {
    throw new Error('Phase D constraint APPLY must stay disabled');
  }
  if (PHASE_D_LUNABOX_PG_FIREWALL_DELETE_ENABLED !== false) {
    throw new Error('firewall delete must stay disabled');
  }
  if (PHASE_D_LUNABOX_PG_FIREWALL_LIVE_APPLY_ENABLED !== true
    || PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED !== true) {
    throw new Error('firewall live apply/http flags must be enabled for Slice 14N');
  }

  // --- RED ---
  resetFirewallApplyCounters();
  {
    const before = getFirewallApplyCounters();
    const r = await executeLunaboxPgFirewallApply({ env: {}, argv: [] });
    assertSafeOutputShape(r);
    if (r.ok || getFirewallApplyCounters().httpRequestCount !== before.httpRequestCount) {
      throw new Error('default path must refuse with zero HTTP');
    }
    red.push({
      name: 'default_path_zero_http',
      ok: true,
      code: r.code,
      httpRequestCount: 0,
      putCount: 0,
    });
  }

  {
    const before = getFirewallApplyCounters();
    const r = await executeLunaboxPgFirewallApply({
      env: firewallApplyEnv(),
      argv: exactFirewallApplyArgv().filter((a) => a !== CLI_APPLY_FIREWALL_RULE),
    });
    if (r.ok || getFirewallApplyCounters().httpRequestCount !== before.httpRequestCount) {
      throw new Error('missing apply flag must zero HTTP');
    }
    red.push({ name: 'missing_apply_flag_zero_http', ok: true, code: r.code });
  }

  {
    const before = getFirewallApplyCounters();
    const r = await executeLunaboxPgFirewallApply({
      env: {},
      argv: exactFirewallApplyArgv(),
    });
    if (r.ok || getFirewallApplyCounters().httpRequestCount !== before.httpRequestCount) {
      throw new Error('missing env must zero HTTP');
    }
    red.push({ name: 'missing_env_zero_http', ok: true, code: r.code });
  }

  {
    const before = getFirewallApplyCounters();
    const wrong = exactFirewallApplyArgv().map((a) => (
      a === FIREWALL_LOCKS.postgresServer ? 'wrong-server' : a
    ));
    const r = await executeLunaboxPgFirewallApply({
      env: firewallApplyEnv(),
      argv: wrong,
    });
    if (r.ok || getFirewallApplyCounters().httpRequestCount !== before.httpRequestCount) {
      throw new Error('wrong server must zero HTTP');
    }
    red.push({ name: 'wrong_exact_targets_zero_http', ok: true, code: r.code });
  }

  {
    const before = getFirewallApplyCounters();
    const r = await executeLunaboxPgFirewallApply({
      env: firewallApplyEnv(),
      argv: [
        CLI_APPLY_FIREWALL_RULE,
        '--subscription', FIREWALL_LOCKS.subscriptionId,
        '--resource-group', FIREWALL_LOCKS.resourceGroup,
        '--vm-resource-group', FIREWALL_LOCKS.vmResourceGroup,
        '--vm-name', FIREWALL_LOCKS.vmName,
        '--managed-identity', FIREWALL_LOCKS.managedIdentityName,
        '--postgres-server', FIREWALL_LOCKS.postgresServer,
        '--firewall-rule-name', FIREWALL_LOCKS.firewallRuleName,
        '--start-ip', FIREWALL_LOCKS.startIpAddress,
        '--end-ip', '20.238.124.77',
      ],
    });
    if (r.ok || getFirewallApplyCounters().httpRequestCount !== before.httpRequestCount) {
      throw new Error('range attempt must zero HTTP');
    }
    red.push({ name: 'ip_range_rejected_zero_http', ok: true, code: r.code });
  }

  {
    const before = getFirewallApplyCounters();
    const r = await executeLunaboxPgFirewallApply({
      env: firewallApplyEnv(),
      argv: [
        CLI_APPLY_FIREWALL_RULE,
        '--subscription', FIREWALL_LOCKS.subscriptionId,
        '--resource-group', FIREWALL_LOCKS.resourceGroup,
        '--vm-resource-group', FIREWALL_LOCKS.vmResourceGroup,
        '--vm-name', FIREWALL_LOCKS.vmName,
        '--managed-identity', FIREWALL_LOCKS.managedIdentityName,
        '--postgres-server', FIREWALL_LOCKS.postgresServer,
        '--firewall-rule-name', FIREWALL_LOCKS.firewallRuleName,
        '--start-ip', '0.0.0.0',
        '--end-ip', '0.0.0.0',
      ],
    });
    if (r.ok || getFirewallApplyCounters().httpRequestCount !== before.httpRequestCount) {
      throw new Error('0.0.0.0 must zero HTTP');
    }
    red.push({ name: 'zero_ip_rejected_zero_http', ok: true, code: r.code });
  }

  for (const flag of ['--delete', '--token', '--url', '--body', '--retry', '--dsn', '--allow-azure-services']) {
    const before = getFirewallApplyCounters();
    const r = await executeLunaboxPgFirewallApply({
      env: firewallApplyEnv(),
      argv: [...exactFirewallApplyArgv(), flag, 'x'],
    });
    if (r.ok || getFirewallApplyCounters().httpRequestCount !== before.httpRequestCount) {
      throw new Error(`forbidden argv ${flag} must zero HTTP`);
    }
    if (!FORBIDDEN_ARGV_FLAGS.includes(flag)) {
      throw new Error(`forbidden list missing ${flag}`);
    }
    red.push({ name: `forbidden_argv_${flag.slice(2)}`, ok: true, code: r.code });
  }

  {
    const inject = createInjectedFirewallHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      outboundIpMismatch: true,
    });
    resetFirewallApplyCounters();
    const r = await executeLunaboxPgFirewallApply({
      env: firewallApplyEnv(),
      argv: exactFirewallApplyArgv(),
      httpRequest: inject,
      pollDelayMs: 0,
    });
    assertSafeOutputShape(r);
    leakScan(r, [FAKE_IMDS_TOKEN]);
    if (r.ok || r.code !== 'outbound_ip_mismatch' || r.putCount !== 0) {
      throw new Error('outbound IP mismatch must stop with zero PUT');
    }
    red.push({
      name: 'outbound_ip_mismatch_zero_put',
      ok: true,
      code: r.code,
      putCount: r.putCount,
      outboundIpv4Matched: false,
    });
  }

  {
    const inject = createInjectedFirewallHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      putStatusCode: 403,
    });
    resetFirewallApplyCounters();
    const r = await executeLunaboxPgFirewallApply({
      env: firewallApplyEnv(),
      argv: exactFirewallApplyArgv(),
      httpRequest: inject,
      pollDelayMs: 0,
    });
    leakScan(r, [FAKE_IMDS_TOKEN]);
    if (r.ok || r.code !== 'firewall_put_rejected') {
      throw new Error('put failure must sanitize');
    }
    red.push({ name: 'sanitized_put_failure', ok: true, code: r.code });
  }

  {
    // live transport rejects host/method/body deviations
    const live = createLiveFirewallHttpRequest();
    let rejected = 0;
    try {
      assertLockedFirewallLiveRequest({
        purpose: 'firewall_rule_put',
        method: 'PUT',
        hostname: 'evil.example',
        path: '/x',
        body: '{}',
      });
    } catch (_) { rejected += 1; }
    try {
      assertLockedFirewallLiveRequest({
        purpose: 'firewall_rule_put',
        method: 'DELETE',
        hostname: FIREWALL_LOCKS.managementHostname,
        path: require('./lib/phase-d-lunabox-pg-firewall-apply').buildArmFirewallRulePath(),
        body: JSON.stringify({
          properties: {
            startIpAddress: FIREWALL_LOCKS.startIpAddress,
            endIpAddress: FIREWALL_LOCKS.endIpAddress,
          },
        }),
      });
    } catch (_) { rejected += 1; }
    try {
      assertLockedFirewallLiveRequest({
        purpose: 'firewall_rule_put',
        method: 'PUT',
        hostname: FIREWALL_LOCKS.managementHostname,
        path: require('./lib/phase-d-lunabox-pg-firewall-apply').buildArmFirewallRulePath(),
        body: JSON.stringify({
          properties: {
            startIpAddress: '1.1.1.1',
            endIpAddress: '1.1.1.1',
          },
        }),
      });
    } catch (_) { rejected += 1; }
    if (rejected !== 3 || typeof live !== 'function') {
      throw new Error('live transport deviation rejects incomplete');
    }
    red.push({ name: 'live_transport_rejects_host_method_body_deviations', ok: true });
  }

  // --- GREEN ---
  {
    green.push({
      name: 'live_apply_activated_delete_disabled',
      ok: true,
      liveApplyEnabled: PHASE_D_LUNABOX_PG_FIREWALL_LIVE_APPLY_ENABLED === true,
      liveHttpEnabled: PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED === true,
      deleteEnabled: false,
      phaseDConstraintApplyDisabled: PHASE_D_LIVE_APPLY_ENABLED === false,
    });
  }

  {
    const gates = evaluateFirewallApplyGates({
      env: firewallApplyEnv(),
      argv: exactFirewallApplyArgv(),
    });
    if (!gates.ok) throw new Error('exact gates should pass');
    green.push({ name: 'exact_gates_pass', ok: true, code: gates.code });
  }

  {
    const inject = createInjectedFirewallHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      costBeforeAmount: 10,
      costAfterAmount: 10,
    });
    resetFirewallApplyCounters();
    const r = await executeLunaboxPgFirewallApply({
      env: firewallApplyEnv(),
      argv: exactFirewallApplyArgv(),
      httpRequest: inject,
      pollDelayMs: 0,
    });
    assertSafeOutputShape(r);
    leakScan(r, [FAKE_IMDS_TOKEN]);
    if (!r.ok || r.putCount !== 1 || r.retries !== 0 || r.thirdRuleExact !== true) {
      throw new Error(`injected success failed: ${JSON.stringify(r)}`);
    }
    if (r.realPostgresCall !== false || r.pgClientInstantiated !== 0) {
      throw new Error('must never instantiate pg Client');
    }
    if (r.existingRulesUnchanged !== true || r.serverRemainedReady !== true) {
      throw new Error('postconditions failed on inject');
    }
    green.push({
      name: 'exact_one_put_sequence_injected',
      ok: true,
      putCount: r.putCount,
      ruleGetPollCount: r.ruleGetPollCount,
      httpRequestCount: r.httpRequestCount,
      thirdRuleExact: true,
      existingRulesUnchanged: true,
      costDeltaFlagged: r.costDeltaFlagged === false,
    });
  }

  {
    const cli = spawnSync(process.execPath, [CLI_PATH], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env },
    });
    if (cli.status === 0) throw new Error('CLI default must refuse');
    const out = `${cli.stdout || ''}${cli.stderr || ''}`;
    if (!/default_disabled|Default path refused|zero ARM mutation/i.test(out)) {
      throw new Error('CLI default refuse message missing');
    }
    green.push({ name: 'cli_default_disabled', ok: true, exitCode: cli.status });
  }

  {
    const cli = spawnSync(process.execPath, [CLI_PATH, ...exactFirewallApplyArgv()], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, [ENV_FIREWALL_APPLY]: '', AZURE_SUBSCRIPTION_ID: '' },
    });
    if (cli.status === 0) throw new Error('CLI missing env must refuse');
    green.push({ name: 'cli_missing_env_refuses_zero_http', ok: true, exitCode: cli.status });
  }

  {
    green.push({
      name: 'usage_and_locks',
      ok: true,
      firewallRuleName: FIREWALL_LOCKS.firewallRuleName,
      startIpAddress: FIREWALL_LOCKS.startIpAddress,
      endIpAddress: FIREWALL_LOCKS.endIpAddress,
      postgresServer: FIREWALL_LOCKS.postgresServer,
      managedIdentityName: FIREWALL_LOCKS.managedIdentityName,
      existingRules: FIREWALL_LOCKS.existingRules,
      bicepModuleRel: FIREWALL_LOCKS.bicepModuleRel,
    });
  }

  {
    green.push({
      name: 'no_pg_client_hashes_preserved',
      ok: true,
      authorizedAggregateSql: AGG_14A,
      dateWindowPredicate: DATE_WINDOW_PREDICATE,
      priceUnitPredicate: PRICE_UNIT_PREDICATE,
      manifestHash: MANIFEST_HASH,
      expectedByteSha: EXPECTED_BYTE_SHA,
      productFingerprint: CANON_FP,
    });
  }

  // --- LIVE (exactly one PUT) ---
  console.log('live: outbound IP + inspect + cost + one firewall PUT…');
  resetFirewallApplyCounters();
  const live = await executeLunaboxPgFirewallApply({
    env: firewallApplyEnv(),
    argv: exactFirewallApplyArgv(),
  });
  assertSafeOutputShape(live);
  leakScan(live, [FAKE_IMDS_TOKEN]);
  if (!live.ok) {
    throw new Error(`live firewall apply failed: ${live.code} ${live.message || ''}`);
  }
  if (live.putCount !== 1 || live.armPutCount !== 1 || live.retries !== 0) {
    throw new Error(`live PUT integrity failed put=${live.putCount} armPut=${live.armPutCount}`);
  }
  if (live.realPostgresCall !== false || live.pgClientInstantiated !== 0) {
    throw new Error('live must not open PostgreSQL');
  }
  if (live.thirdRuleExact !== true || live.existingRulesUnchanged !== true) {
    throw new Error('live postcondition rules failed');
  }
  if (live.serverRemainedReady !== true || live.publicNetworkAccessUnchanged !== true) {
    throw new Error('live server postcondition failed');
  }
  if (live.outboundIpv4Matched !== true
    || live.outboundIpv4Service1 !== FIREWALL_LOCKS.expectedOutboundIpv4
    || live.outboundIpv4Service2 !== FIREWALL_LOCKS.expectedOutboundIpv4) {
    throw new Error('live outbound IP mismatch');
  }

  const contract = {
    kind: 'sunset-schema-observer-slice14n-lunabox-pg-firewall-contract',
    secretFree: true,
    slice: '14N',
    masterShaBasis: MASTER,
    stillProductSchemaDiffers: true,
    phaseDConstraintsApplied: false,
    liveMutation: true,
    firewallMutation: true,
    networkMutation: false,
    kvMutation: false,
    rbacMutation: false,
    identityMutation: false,
    postgresClientOpened: false,
    postgresQueryExecuted: false,
    deleteEnabled: false,
    mainBicepDeployed: false,
    retries: 0,
    putCount: 1,
    firewallRuleName: FIREWALL_LOCKS.firewallRuleName,
    startIpAddress: FIREWALL_LOCKS.startIpAddress,
    endIpAddress: FIREWALL_LOCKS.endIpAddress,
    postgresServer: FIREWALL_LOCKS.postgresServer,
    existingRulesLocked: FIREWALL_LOCKS.existingRules,
    outboundIpServices: FIREWALL_LOCKS.outboundIpServices.map((s) => ({
      name: s.name,
      hostname: s.hostname,
      path: s.path,
    })),
    expectedOutboundIpv4: FIREWALL_LOCKS.expectedOutboundIpv4,
    bicepModuleRel: FIREWALL_LOCKS.bicepModuleRel,
    authorizedAggregateSqlUnchanged: AGG_14A,
    predicatesUnchangedFrom14A: {
      date_window: DATE_WINDOW_PREDICATE,
      price_unit: PRICE_UNIT_PREDICATE,
    },
    nonGoals: [
      'PostgreSQL client/query',
      'KV/RBAC/identity change',
      'DB/DDL/migration/ledger',
      'full main.bicep deploy',
      'delete or broaden existing firewall rules',
      'Azure-services / 0.0.0.0 / IPv6 / ranges',
      'caller URL/body/token',
      'PUT retries',
    ],
    redRequired: red.map((r) => r.name),
    greenRequired: green.map((g) => g.name),
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14n-lunabox-pg-firewall-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14N',
    outcome: live.ok ? 'lunabox_pg_firewall_apply_ok' : live.code,
    stillProductSchemaDiffers: true,
    phaseDConstraintsApplied: false,
    liveMutation: true,
    firewallAction: true,
    networkMutation: false,
    kvMutation: false,
    rbacMutation: false,
    identityMutation: false,
    migrationAdded: false,
    ledgerWritten: false,
    applyFlagPresent: false,
    appliesConstraints: false,
    writesLedger: false,
    forwardCountUnchanged: 39,
    newForwardMigration: false,
    postgresClientOpened: false,
    postgresQueryExecuted: false,
    realPostgresCall: false,
    pgClientInstantiated: 0,
    deleteEnabled: false,
    mainBicepDeployed: false,
    putCount: live.putCount,
    armPutCount: live.armPutCount,
    armGetCount: live.armGetCount,
    armDeleteCount: 0,
    ruleGetPollCount: live.ruleGetPollCount,
    retries: 0,
    httpRequestCount: live.httpRequestCount,
    imdsRequestCount: live.imdsRequestCount,
    costPostCount: live.costPostCount,
    outboundIpGetCount: live.outboundIpGetCount,
    usedLiveHttp: live.usedLiveHttp === true,
    realImdsCall: live.realImdsCall === true,
    realArmCall: live.realArmCall === true,
    realCostCall: live.realCostCall === true,
    realOutboundIpCall: live.realOutboundIpCall === true,
    subscriptionId: live.subscriptionId,
    resourceGroup: live.resourceGroup,
    postgresServer: live.postgresServer,
    postgresServerResourceId: live.postgresServerResourceId,
    firewallRuleName: live.firewallRuleName,
    firewallRuleResourceId: live.firewallRuleResourceId,
    startIpAddress: live.startIpAddress,
    endIpAddress: live.endIpAddress,
    outboundIpv4Service1: live.outboundIpv4Service1,
    outboundIpv4Service2: live.outboundIpv4Service2,
    outboundIpv4Matched: live.outboundIpv4Matched,
    serverStateBefore: live.serverStateBefore,
    serverStateAfter: live.serverStateAfter,
    publicNetworkAccessBefore: live.publicNetworkAccessBefore,
    publicNetworkAccessAfter: live.publicNetworkAccessAfter,
    publicNetworkAccessUnchanged: live.publicNetworkAccessUnchanged,
    serverRemainedReady: live.serverRemainedReady,
    existingRulesBefore: live.existingRulesBefore,
    existingRulesAfter: live.existingRulesAfter,
    existingRulesUnchanged: live.existingRulesUnchanged,
    rulesBeforeCount: live.rulesBeforeCount,
    rulesAfterCount: live.rulesAfterCount,
    thirdRuleExact: live.thirdRuleExact,
    costBefore: live.costBefore,
    costAfter: live.costAfter,
    costDelta: live.costDelta,
    costDeltaFlagged: live.costDeltaFlagged,
    firewallRuleExpectedDirectCharge: false,
    bicepModuleRel: FIREWALL_LOCKS.bicepModuleRel,
    migrationHashes: { ...LOCKED_13C_SHA },
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    migration028Sha256CanonicalLfV1: LOCKED_13C_SHA['028'],
    defaultDisabled: true,
    offlineGates: {
      defaultPathZeroHttp: true,
      missingApplyFlagZeroHttp: true,
      missingEnvZeroHttp: true,
      wrongExactTargetsZeroHttp: true,
      ipRangeRejected: true,
      zeroIpRejected: true,
      forbiddenArgvRejected: true,
      outboundIpMismatchZeroPut: true,
      sanitizedPutFailure: true,
      liveTransportRejectsDeviations: true,
      exactOnePutSequenceInjected: true,
      cliDefaultDisabled: true,
    },
    redCases: red,
    greenCases: green,
    liveResult: pickSafeFirewallOutput(live),
    privateRefsZeroed: true,
  };

  leakScan(evidence, [FAKE_IMDS_TOKEN]);
  leakScan(contract, [FAKE_IMDS_TOKEN]);

  const findings = `# FOUNDATION Slice 14N — Lunabox PostgreSQL firewall rule

**Status:** complete (offline RED/GREEN + one live ARM PUT of AllowLunaboxEgress; zero PostgreSQL)
**Master basis:** \`${MASTER}\`
**Generated:** ${generatedAt}

## Outcome

Declared standalone Bicep \`${FIREWALL_LOCKS.bicepModuleRel}\` referencing existing \`${FIREWALL_LOCKS.postgresServer}\`, then applied exactly **one** ARM REST PUT for rule **\`${FIREWALL_LOCKS.firewallRuleName}\`** with start=end=**\`${FIREWALL_LOCKS.startIpAddress}\`**.

Live verification:

| Check | Result |
|-------|--------|
| Outbound IPv4 (api.ipify.org) | \`${live.outboundIpv4Service1}\` |
| Outbound IPv4 (ifconfig.me/ip) | \`${live.outboundIpv4Service2}\` |
| Both match locked IP | ${live.outboundIpv4Matched === true} |
| Live PUT count | **${live.putCount}** |
| Exact rule GET polls | **${live.ruleGetPollCount}** |
| ARM GET count | ${live.armGetCount} |
| ARM DELETE count | 0 |
| Retries | 0 |
| Server Ready before→after | \`${live.serverStateBefore}\` → \`${live.serverStateAfter}\` |
| publicNetworkAccess unchanged | \`${live.publicNetworkAccessBefore}\` (unchanged=${live.publicNetworkAccessUnchanged}) |
| Existing two rules unchanged | ${live.existingRulesUnchanged === true} |
| Third rule exact | ${live.thirdRuleExact === true} |
| PostgreSQL client/query | **none** |

### Rules before

${(live.existingRulesBefore || []).map((r) => `- \`${r.name}\` ${r.startIpAddress}–${r.endIpAddress}`).join('\n')}

### Rules after

${(live.existingRulesAfter || []).map((r) => `- \`${r.name}\` ${r.startIpAddress}–${r.endIpAddress}`).join('\n')}
- \`${live.firewallRuleName}\` ${live.startIpAddress}–${live.endIpAddress}

### Cost (safe totals only)

| Phase | Actual | Amortized | Currency | Period |
|-------|--------|-----------|----------|--------|
| Before | ${live.costBefore.actual.amount} | ${live.costBefore.amortized.amount} | ${live.costBefore.actual.currency} | ${live.costBefore.actual.period.from}→${live.costBefore.actual.period.to} |
| After | ${live.costAfter.actual.amount} | ${live.costAfter.amortized.amount} | ${live.costAfter.actual.currency} | ${live.costAfter.actual.period.from}→${live.costAfter.actual.period.to} |

Cost delta flagged: **${live.costDeltaFlagged === true}** (actualΔ=${live.costDelta.actualAmountDelta}, amortizedΔ=${live.costDelta.amortizedAmountDelta}). Firewall rule has **no expected direct charge**.

Safe ARM IDs:
- Server: \`${live.postgresServerResourceId}\`
- Rule: \`${live.firewallRuleResourceId}\`

## Operator command (default-disabled)

\`\`\`bash
SUNSET_PHASE_D_LUNABOX_PG_FIREWALL_APPLY=1 AZURE_SUBSCRIPTION_ID=${FIREWALL_LOCKS.subscriptionId} \\
  npm run phase-d:lunabox-pg-firewall-apply -- --apply-firewall-rule \\
  --subscription ${FIREWALL_LOCKS.subscriptionId} \\
  --resource-group ${FIREWALL_LOCKS.resourceGroup} \\
  --vm-resource-group ${FIREWALL_LOCKS.vmResourceGroup} \\
  --vm-name ${FIREWALL_LOCKS.vmName} \\
  --managed-identity ${FIREWALL_LOCKS.managedIdentityName} \\
  --postgres-server ${FIREWALL_LOCKS.postgresServer} \\
  --firewall-rule-name ${FIREWALL_LOCKS.firewallRuleName} \\
  --start-ip ${FIREWALL_LOCKS.startIpAddress} \\
  --end-ip ${FIREWALL_LOCKS.endIpAddress}
\`\`\`

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default/missing/wrong gates; ranges; 0.0.0.0; forbidden argv; outbound IP mismatch zero PUT; sanitized PUT failure; live transport rejects deviations |
| GREEN | apply activated/delete disabled; exact gates; injected one-PUT sequence; CLI default refuse; locks; hashes preserved; no pg Client |

## Non-goals / still open

- **No** Phase D constraint apply, DDL, or ledger write
- **No** KV/RBAC/identity change
- **No** PostgreSQL connection/query in this slice
- Still \`product_schema_differs\`
- **Do not claim Sunset repaired.**

## Zero DB mutation

No PostgreSQL client. No SQL. Firewall ARM rule only. Private refs zeroed. No token/DSN in evidence.
`;

  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, findings);

  console.log(`wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`wrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log('\nSlice 14N proof GREEN — live AllowLunaboxEgress PUT verified; zero PostgreSQL.');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
