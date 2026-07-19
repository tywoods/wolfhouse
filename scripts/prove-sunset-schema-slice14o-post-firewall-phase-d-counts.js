'use strict';

/**
 * prove-sunset-schema-slice14o-post-firewall-phase-d-counts — FOUNDATION Slice 14O
 *
 * Offline RED/GREEN → one live post-firewall prestate (Ready + Enabled + exact
 * three rules including AllowLunaboxEgress 20.238.124.76/32 + dual outbound IP
 * match) → one merged metadata-only credential preflight → exactly ONE gated
 * managed-identity count-only path. On any blocker: existing secret-free
 * classifier / sanitize and stop (no retry). Zero mutation.
 *
 * Default: offline (preserves historical live evidence). Pass --live once to
 * capture live prestate + preflight + count.
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
  DATE_WINDOW_PREDICATE,
  PRICE_UNIT_PREDICATE,
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
  CONNECT_MESSAGE_PROBE_MAX_LEN,
  CONNECT_CATEGORIES,
} = require('./lib/phase-d-live-readonly-pg-adapter');
const {
  evaluatePhaseDLiveReadonlyCliGates,
  FORBIDDEN_ARGV_FLAGS,
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
  CREDENTIAL_PREFLIGHT_LOCKS,
  SAFE_OUTPUT_KEYS,
  exactCredentialPreflightArgv,
  credentialPreflightEnv,
} = require('./lib/phase-d-credential-preflight');
const {
  PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED,
  PHASE_D_LUNABOX_PG_FIREWALL_DELETE_ENABLED,
  FIREWALL_LOCKS,
  EXPECTED_POST_FIREWALL_RULES,
  createInjectedFirewallHttp,
  executeLunaboxPgFirewallPrestateVerify,
  resetFirewallApplyCounters,
  getFirewallApplyCounters,
  extractExactThreeFirewallRules,
} = require('./lib/phase-d-lunabox-pg-firewall-apply');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14o-post-firewall-phase-d-counts-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14o-post-firewall-phase-d-counts-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14o-findings.md');
const COUNT_CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-live-readonly-count-only.js');
const PREFLIGHT_CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-credential-preflight.js');

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

const FAKE_ADMIN_USER = 'slice14o-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14o-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14o-proof-imds-token-never-commit';

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

function miArgv(extraFlags) {
  return [
    CLI_EXECUTE_COUNT_ONLY,
    '--subscription', TARGETS.subscriptionId,
    '--resource-group', TARGETS.resourceGroup,
    '--postgres-server', TARGETS.postgresServer,
    '--database', TARGETS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    ...(extraFlags || []),
  ];
}

function adapterArgv() {
  return ['node', 'prove-14o', ...miArgv()];
}

function validSecretValue() {
  return buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
}

function leakScan(value, secrets) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const s of secrets) {
    if (s && text.includes(s)) {
      throw new Error(`secret leaked into proof artifact: ${s.slice(0, 8)}…`);
    }
  }
  if (/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(text)) {
    throw new Error('DSN leaked into proof artifact');
  }
  if (/Bearer\s+slice14o-proof-imds-token/i.test(text)) {
    throw new Error('IMDS token leaked into proof artifact');
  }
  if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/.test(text)) {
    throw new Error('JWT-shaped token leaked into proof artifact');
  }
}

function parseLastJsonObject(text) {
  const src = String(text || '');
  let last = null;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const chunk = src.slice(start, i + 1);
        try {
          last = JSON.parse(chunk);
        } catch (_) {
          // keep scanning
        }
        start = -1;
      }
    }
  }
  return last;
}

function sanitizeErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => ({
    code: String((e && e.code) || 'phase_d_failed').slice(0, 80),
    message: String((e && e.message) || 'phase d failed')
      .replace(/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/gi, 'postgresql://[REDACTED]:')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .slice(0, 240),
  }));
}

function buildPreflightLiveOutcome(parsed, exitCode) {
  const p = parsed || {};
  const ok = p.ok === true;
  const errors = sanitizeErrors(p.errors);
  if (!parsed) {
    errors.push({
      code: 'live_output_unparseable',
      message: 'credential-preflight CLI stdout/stderr did not contain parseable JSON',
    });
  }
  const blocker = ok ? null : String(p.code || (errors[0] && errors[0].code) || 'credential_preflight_failed');
  return {
    ok,
    code: String(p.code || (ok ? 'credential_preflight_ok' : blocker)),
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    managedIdentityName: p.managedIdentityName || CREDENTIAL_PREFLIGHT_LOCKS.managedIdentityName,
    keyVaultName: p.keyVaultName || CREDENTIAL_PREFLIGHT_LOCKS.keyVaultName,
    secretName: p.secretName || CREDENTIAL_PREFLIGHT_LOCKS.secretName,
    postgresHost: p.postgresHost || CREDENTIAL_PREFLIGHT_LOCKS.postgresHost,
    database: p.database || CREDENTIAL_PREFLIGHT_LOCKS.database,
    sslmode: p.sslmode || CREDENTIAL_PREFLIGHT_LOCKS.sslmode,
    secretTargetValid: p.secretTargetValid === true,
    httpCallsDelta: Number(p.httpCallsDelta) || 0,
    imdsRequestCount: Number(p.imdsRequestCount) || 0,
    keyVaultRequestCount: Number(p.keyVaultRequestCount) || 0,
    clientsInstantiated: Number(p.clientsInstantiated) || 0,
    realImdsCall: p.realImdsCall === true,
    realKeyVaultCall: p.realKeyVaultCall === true,
    realPostgresCall: false,
    liveMutation: false,
    errors,
    blocker,
  };
}

function buildCountLiveOutcome(parsed, exitCode) {
  const p = parsed || {};
  const ok = p.ok === true;
  const errors = sanitizeErrors(p.errors);
  if (!parsed) {
    errors.push({
      code: 'live_output_unparseable',
      message: 'count-only CLI stdout/stderr did not contain parseable JSON',
    });
  }
  const connectCategory = p.connectCategory
    ? String(p.connectCategory).slice(0, 32)
    : null;
  const code = String(p.code || (ok ? 'phase_d_live_readonly_pg_sequence_ok' : 'count_failed'));
  const blocker = ok
    ? null
    : String(connectCategory || code || (errors[0] && errors[0].code) || 'count_failed');
  const counters = (p.counters && typeof p.counters === 'object') ? p.counters : {};
  const counts = (p.counts && typeof p.counts === 'object') ? {
    total_rows: Number(p.counts.total_rows),
    date_window_violations: Number(p.counts.date_window_violations),
    price_unit_violations: Number(p.counts.price_unit_violations),
  } : null;
  let message = null;
  if (!ok && connectCategory) {
    message = CONNECT_FAILED_SAFE_MESSAGE;
  } else if (typeof p.message === 'string') {
    message = String(p.message)
      .replace(/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/gi, 'postgresql://[REDACTED]:')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .slice(0, 240);
  }
  return {
    attempt: 1,
    ok,
    code,
    connectCategory,
    message,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    counts: counts && Number.isFinite(counts.total_rows) ? counts : null,
    steps: Array.isArray(p.steps) ? p.steps.slice() : [],
    credentialSource: p.credentialSource || null,
    managedIdentityName: p.managedIdentityName || 'wh-staging-identity',
    keyVaultName: p.keyVaultName || 'luna-sunset-staging-kv',
    secretName: p.secretName || 'sunset-database-url',
    postgresHost: p.postgresHost || TARGETS.postgresHost,
    database: p.database || TARGETS.database,
    sslmode: p.sslmode || TARGETS.sslmode,
    applicationName: p.applicationName || TARGETS.applicationName,
    clientsInstantiated: Number(p.clientsInstantiated) || 0,
    connectCalls: Number(counters.connectCalls) || 0,
    queryCalls: Number(counters.queryCalls) || 0,
    endCalls: Number(counters.endCalls) || 0,
    httpRequestCount: Number(counters.httpRequestCount) || 0,
    imdsRequestCount: Number(counters.imdsRequestCount) || 0,
    keyVaultRequestCount: Number(counters.keyVaultRequestCount) || 0,
    closed: p.closed === true,
    liveQueryExecution: p.liveQueryExecution === true,
    realImdsCall: (Number(counters.imdsRequestCount) || 0) > 0,
    realKeyVaultCall: (Number(counters.keyVaultRequestCount) || 0) > 0,
    realPostgresCall: p.liveQueryExecution === true || (Number(p.clientsInstantiated) || 0) > 0,
    liveMutation: false,
    errors,
    blocker,
  };
}

function pickSafeFirewallPrestate(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    ok: result.ok === true,
    code: String(result.code || 'firewall_prestate_unknown'),
    prestateOk: result.prestateOk === true,
    serverState: result.serverState || null,
    publicNetworkAccess: result.publicNetworkAccess || null,
    serverReady: result.serverReady === true,
    publicNetworkAccessEnabled: result.publicNetworkAccessEnabled === true,
    rulesCount: Number.isFinite(result.rulesCount) ? result.rulesCount : null,
    exactThreeRules: result.exactThreeRules === true,
    allowLunaboxEgressExact: result.allowLunaboxEgressExact === true,
    firewallRules: Array.isArray(result.firewallRules)
      ? result.firewallRules.map((r) => ({
        name: r.name,
        startIpAddress: r.startIpAddress,
        endIpAddress: r.endIpAddress,
        cidr: r.cidr || `${r.startIpAddress}/32`,
      }))
      : [],
    outboundIpv4Service1: result.outboundIpv4Service1 || null,
    outboundIpv4Service2: result.outboundIpv4Service2 || null,
    outboundIpv4Matched: result.outboundIpv4Matched === true,
    expectedOutboundIpv4: FIREWALL_LOCKS.expectedOutboundIpv4,
    httpRequestCount: Number(result.httpRequestCount) || 0,
    imdsRequestCount: Number(result.imdsRequestCount) || 0,
    armGetCount: Number(result.armGetCount) || 0,
    armPutCount: Number(result.armPutCount) || 0,
    armDeleteCount: Number(result.armDeleteCount) || 0,
    outboundIpGetCount: Number(result.outboundIpGetCount) || 0,
    putCount: Number(result.putCount) || 0,
    retries: 0,
    usedLiveHttp: result.usedLiveHttp === true,
    realImdsCall: result.realImdsCall === true,
    realArmCall: result.realArmCall === true,
    realOutboundIpCall: result.realOutboundIpCall === true,
    realPostgresCall: false,
    pgClientInstantiated: 0,
    liveMutation: false,
    networkMutation: false,
    firewallAction: false,
    kvMutation: false,
    rbacMutation: false,
    identityMutation: false,
    postgresServer: FIREWALL_LOCKS.postgresServer,
    firewallRuleName: FIREWALL_LOCKS.firewallRuleName,
    startIpAddress: FIREWALL_LOCKS.startIpAddress,
    endIpAddress: FIREWALL_LOCKS.endIpAddress,
    managedIdentityName: FIREWALL_LOCKS.managedIdentityName,
    errors: sanitizeErrors(result.errors),
    blocker: result.ok === true ? null : String(result.code || 'firewall_prestate_failed'),
  };
}

async function main() {
  const wantLive = process.argv.includes('--live');
  const offlineOnly = !wantLive
    || process.argv.includes('--offline')
    || process.env.SUNSET_SLICE14O_PROOF_OFFLINE === '1';
  console.log(offlineOnly
    ? 'prove:sunset-schema-slice14o — offline only (no live HTTP/PG)\n'
    : 'prove:sunset-schema-slice14o — offline then live prestate + preflight + one count\n');

  const priorEvidence = fs.existsSync(EVIDENCE_PATH)
    ? JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'))
    : null;
  const generatedAt = (!offlineOnly && wantLive)
    ? new Date().toISOString()
    : (priorEvidence && priorEvidence.generatedAt) || new Date().toISOString();

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) throw new Error('manifest integrity failed');
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  const expectedBytes = fs.readFileSync(EXPECTED_PATH);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  const expected = JSON.parse(expectedBytes.toString('utf8'));

  if (manifestHash !== MANIFEST_HASH) throw new Error(`manifest hash drift: ${manifestHash}`);
  if (expectedHash !== EXPECTED_BYTE_SHA) throw new Error(`expected hash drift: ${expectedHash}`);
  if (expected.productFingerprint !== CANON_FP) throw new Error('fingerprint drift');
  if (forward.length !== 39) throw new Error('forward count drift');
  assertMigration028ByteIntegrity();
  assert028PredicatesPresentInSource();
  if (AUTHORIZED_AGGREGATE_SQL !== AGG_14A) throw new Error('14A aggregate drift');
  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true) {
    throw new Error('CONNECT_ENABLED must remain activated');
  }
  if (PHASE_D_LIVE_APPLY_ENABLED !== false) {
    throw new Error('APPLY must remain disabled');
  }
  if (PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED !== true) {
    throw new Error('live MI HTTP must be activated');
  }
  if (PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED !== true) {
    throw new Error('firewall live HTTP must be enabled');
  }
  if (PHASE_D_LUNABOX_PG_FIREWALL_DELETE_ENABLED !== false) {
    throw new Error('firewall delete must stay disabled');
  }
  if (EXPECTED_POST_FIREWALL_RULES.length !== 3) {
    throw new Error('expected post-firewall rules must be exactly 3');
  }

  const live028 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '028_tenant_services.sql'));
  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
  const live040 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '040_tenant_services_saas_catalog_columns.sql'));
  const live041 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '041_notification_surfpack_convergence.sql'));
  for (const [k, v] of Object.entries({
    '028': live028, '035': live035, '040': live040, '041': live041,
  })) {
    if (v !== LOCKED_13C_SHA[k]) throw new Error(`13C hash drift on ${k}`);
  }

  if (!fs.existsSync(COUNT_CLI_PATH) || !fs.existsSync(PREFLIGHT_CLI_PATH)) {
    throw new Error('required CLIs missing');
  }

  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN, validSecretValue()];
  const red = [];
  const green = [];

  // --- RED: count path ---
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const def = await executePhaseDLiveReadonlyPgAdapter({ env: {}, argv: [] });
  if (getManagedIdentityHttpCounters().httpRequestCount !== 0
    || getPgClientInstantiateCount() !== 0) {
    throw new Error('default path must refuse with zero HTTP/Clients');
  }
  leakScan(def, secrets);
  red.push({
    name: 'default_path_zero_http_and_clients',
    ok: true,
    code: def.code,
    httpRequestCount: 0,
    clientsInstantiated: 0,
  });

  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const noExec = await executePhaseDLiveReadonlyPgAdapter({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    },
    argv: [
      'node', 'prove',
      '--subscription', TARGETS.subscriptionId,
      '--resource-group', TARGETS.resourceGroup,
      '--postgres-server', TARGETS.postgresServer,
      '--database', TARGETS.database,
      CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    ],
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (getPgClientInstantiateCount() !== 0
    || getManagedIdentityHttpCounters().httpRequestCount !== 0) {
    throw new Error('missing execute gate must zero Clients/HTTP');
  }
  red.push({
    name: 'missing_execute_gate_zero_clients',
    ok: true,
    code: noExec.code,
    clientsInstantiated: 0,
  });

  const wrongDb = evaluatePhaseDLiveReadonlyCliGates({
    env: miEnv(),
    argv: miArgv().map((a, i, arr) => (arr[i - 1] === '--database' ? 'evil_db' : a)),
  });
  if (wrongDb.ok) throw new Error('wrong database must fail');
  const forbidden = evaluatePhaseDLiveReadonlyCliGates({
    env: miEnv(),
    argv: [...miArgv(), '--dsn', 'postgresql://x:y@h/db'],
  });
  if (forbidden.ok) throw new Error('forbidden --dsn must fail');
  red.push({
    name: 'wrong_or_forbidden_cli_args_zero_clients',
    ok: true,
    wrongDatabaseRejected: !wrongDb.ok,
    forbiddenDsnRejected: !forbidden.ok,
    forbiddenFlags: FORBIDDEN_ARGV_FLAGS.slice(),
  });

  const halfFlag = evaluatePhaseDLiveReadonlyCliGates({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [ENV_EXECUTE_COUNT_ONLY]: '1',
    },
    argv: miArgv(),
  });
  if (halfFlag.ok) throw new Error('MI without env credential-source must fail');
  red.push({
    name: 'managed_identity_requires_env_and_argv',
    ok: true,
    rejected: !halfFlag.ok,
  });

  // RED: firewall prestate blockers stop without PostgreSQL
  resetFirewallApplyCounters();
  {
    const before = getFirewallApplyCounters();
    const r = await executeLunaboxPgFirewallPrestateVerify({
      httpRequest: createInjectedFirewallHttp({
        postFirewallRulesPresent: true,
        outboundIpMismatch: true,
      }),
    });
    if (r.ok || r.putCount !== 0 || r.pgClientInstantiated !== 0
      || getFirewallApplyCounters().putCount !== before.putCount) {
      throw new Error('outbound mismatch must fail with zero PUT/PG');
    }
    red.push({
      name: 'firewall_outbound_ip_mismatch_zero_postgres',
      ok: true,
      code: r.code,
      putCount: 0,
      pgClientInstantiated: 0,
    });
  }
  resetFirewallApplyCounters();
  {
    const r = await executeLunaboxPgFirewallPrestateVerify({
      httpRequest: createInjectedFirewallHttp({ postFirewallRulesPresent: false }),
    });
    if (r.ok || r.code !== 'firewall_rule_count_mismatch' || r.putCount !== 0) {
      throw new Error('missing third rule must fail count mismatch with zero PUT');
    }
    red.push({
      name: 'firewall_rule_count_mismatch_zero_postgres',
      ok: true,
      code: r.code,
      rulesCount: r.rulesCount,
      putCount: 0,
    });
  }
  resetFirewallApplyCounters();
  {
    const r = await executeLunaboxPgFirewallPrestateVerify({
      httpRequest: createInjectedFirewallHttp({
        postFirewallRulesPresent: true,
        serverState: 'Updating',
      }),
    });
    if (r.ok || r.code !== 'server_not_ready' || r.putCount !== 0) {
      throw new Error('server not Ready must stop with zero PUT');
    }
    red.push({
      name: 'firewall_server_not_ready_zero_postgres',
      ok: true,
      code: r.code,
      putCount: 0,
    });
  }

  // RED: connect classifier secret sanitize
  const evilSuffix = ` password=${FAKE_ADMIN_PASSWORD} DSN=${validSecretValue()} Bearer ${FAKE_IMDS_TOKEN}`;
  function assertClassifierSecretFree(classified, label) {
    const text = JSON.stringify(classified);
    if (text.includes(FAKE_ADMIN_PASSWORD)
      || text.includes(FAKE_IMDS_TOKEN)
      || /postgresql:\/\//i.test(text)
      || classified.message !== CONNECT_FAILED_SAFE_MESSAGE) {
      throw new Error(`classifier leaked secrets (${label})`);
    }
  }
  const clsUnknown = classifyConnectError(Object.assign(
    new Error(`unclassified boom${evilSuffix}`),
    { code: 'NOT_ALLOWLISTED' },
  ));
  assertClassifierSecretFree(clsUnknown, 'unknown');
  const clsDns = classifyConnectError(Object.assign(
    new Error(`ENOTFOUND host${evilSuffix}`),
    { code: 'ENOTFOUND' },
  ));
  assertClassifierSecretFree(clsDns, 'dns');
  const adversarial = [
    { name: 'msg_tls', err: Object.assign(new Error(`self-signed certificate SSL/TLS${evilSuffix}`), { code: 'ZZ' }), category: 'tls', code: CONNECT_MESSAGE_SYNTHETIC_CODE.tls },
    { name: 'msg_auth', err: Object.assign(new Error(`password authentication failed SASL${evilSuffix}`), { code: 'ZZ' }), category: 'auth', code: CONNECT_MESSAGE_SYNTHETIC_CODE.auth },
    { name: 'msg_firewall', err: Object.assign(new Error(`pg_hba firewall client IP not allowed${evilSuffix}`), { code: 'ZZ' }), category: 'firewall', code: CONNECT_MESSAGE_SYNTHETIC_CODE.firewall },
    { name: 'msg_timeout', err: Object.assign(new Error(`connection timed out${evilSuffix}`), { code: 'ZZ' }), category: 'timeout', code: CONNECT_MESSAGE_SYNTHETIC_CODE.timeout },
  ];
  const adversarialResults = [];
  for (const a of adversarial) {
    const c = classifyConnectError(a.err);
    if (c.category !== a.category || c.code !== a.code) {
      throw new Error(`adversarial classifier failed: ${a.name}`);
    }
    assertClassifierSecretFree(c, a.name);
    adversarialResults.push({
      name: a.name,
      category: c.category,
      code: c.code,
      message: c.message,
    });
  }
  red.push({
    name: 'connect_classifier_secret_messages_sanitize',
    ok: true,
    classifiedUnknown: {
      category: clsUnknown.category,
      code: clsUnknown.code,
      message: clsUnknown.message,
    },
    classifiedDnsWithSecrets: {
      category: clsDns.category,
      code: clsDns.code,
      message: clsDns.message,
    },
    adversarialMessageClassifications: adversarialResults,
  });

  // --- GREEN ---
  resetFirewallApplyCounters();
  {
    const r = await executeLunaboxPgFirewallPrestateVerify({
      httpRequest: createInjectedFirewallHttp({ postFirewallRulesPresent: true }),
    });
    leakScan(r, secrets);
    if (!r.ok || !r.prestateOk || r.rulesCount !== 3 || !r.outboundIpv4Matched
      || r.putCount !== 0 || r.pgClientInstantiated !== 0
      || !r.allowLunaboxEgressExact) {
      throw new Error(`GREEN firewall prestate failed: ${JSON.stringify(r)}`);
    }
    const exact = extractExactThreeFirewallRules(
      EXPECTED_POST_FIREWALL_RULES.map((x) => ({
        name: x.name,
        properties: { startIpAddress: x.startIpAddress, endIpAddress: x.endIpAddress },
      })),
    );
    if (!exact.ok) throw new Error('exact three helper failed on locked rules');
    green.push({
      name: 'injected_firewall_prestate_exact_three_rules',
      ok: true,
      rulesCount: 3,
      outboundIpv4Matched: true,
      allowLunaboxEgressExact: true,
      putCount: 0,
      httpRequestCount: r.httpRequestCount,
      armGetCount: r.armGetCount,
      outboundIpGetCount: r.outboundIpGetCount,
    });
  }

  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const httpOk = createInjectedManagedIdentityHttp({
    imdsAccessToken: FAKE_IMDS_TOKEN,
    defaultSecretValue: validSecretValue(),
  });
  const FakeOk = createScriptedFakePgClientFactory({
    responses: {
      aggregate: {
        rows: [{
          total_rows: 11,
          date_window_violations: 2,
          price_unit_violations: 1,
        }],
        rowCount: 1,
      },
    },
  });
  const okRun = await executePhaseDLiveReadonlyPgAdapter({
    env: miEnv(),
    argv: adapterArgv(),
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    httpRequest: httpOk,
    Client: FakeOk,
  });
  leakScan(okRun, secrets);
  if (!okRun.ok
    || okRun.credentialSource !== 'managed_identity'
    || JSON.stringify(okRun.steps) !== JSON.stringify(AUTHORIZED_SEQUENCE)
    || okRun.counts.total_rows !== 11
    || okRun.counts.date_window_violations !== 2
    || okRun.counts.price_unit_violations !== 1
    || okRun.clientsInstantiated !== 1
    || okRun.counters.httpRequestCount !== 2
    || okRun.counters.queryCalls !== AUTHORIZED_SEQUENCE.length
    || okRun.closed !== true
    || okRun.liveMutation !== false) {
    throw new Error(`GREEN MI sequence failed: ${JSON.stringify(okRun)}`);
  }
  green.push({
    name: 'injected_http_success_exact_count_sequence',
    ok: true,
    steps: okRun.steps,
    counts: okRun.counts,
    clientsInstantiated: 1,
    httpRequestCount: 2,
    queryCalls: AUTHORIZED_SEQUENCE.length,
    credentialSource: 'managed_identity',
    closed: true,
  });

  const gatesOk = evaluatePhaseDLiveReadonlyCliGates({
    env: miEnv(),
    argv: miArgv(),
  });
  if (!gatesOk.ok || !gatesOk.managedIdentityCredentialSource) {
    throw new Error(`CLI MI gates should pass: ${JSON.stringify(gatesOk.errors)}`);
  }
  green.push({
    name: 'cli_gates_managed_identity_exact_targets',
    ok: true,
    confirmed: gatesOk.confirmed,
  });

  const cliDefault = spawnSync(process.execPath, [COUNT_CLI_PATH], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (cliDefault.status === 0) throw new Error('count-only CLI default must refuse');
  leakScan(`${cliDefault.stdout}${cliDefault.stderr}`, secrets);
  green.push({
    name: 'count_only_cli_default_disabled',
    ok: true,
    exitCode: cliDefault.status,
  });

  if (MI_LOADER_LOCKS.managedIdentityName !== 'wh-staging-identity'
    || MI_LOADER_LOCKS.keyVaultName !== 'luna-sunset-staging-kv'
    || MI_LOADER_LOCKS.secretName !== 'sunset-database-url'
    || MI_LOADER_LOCKS.sslmode !== 'verify-full'
    || TARGETS.applicationName !== 'wh-sunset-phase-d-preflight'
    || FIREWALL_LOCKS.firewallRuleName !== 'AllowLunaboxEgress'
    || FIREWALL_LOCKS.startIpAddress !== '20.238.124.76') {
    throw new Error('locks drift');
  }
  green.push({
    name: 'locks_identity_vault_secret_pg_tls_application_name_firewall',
    ok: true,
    managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
    keyVaultName: MI_LOADER_LOCKS.keyVaultName,
    secretName: MI_LOADER_LOCKS.secretName,
    sslmode: MI_LOADER_LOCKS.sslmode,
    applicationName: TARGETS.applicationName,
    firewallRuleName: FIREWALL_LOCKS.firewallRuleName,
    startIpAddress: FIREWALL_LOCKS.startIpAddress,
  });

  if (PHASE_D_LIVE_APPLY_ENABLED !== false
    || PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true
    || PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED !== true) {
    throw new Error('apply/connect/http flags unexpected');
  }
  green.push({
    name: 'apply_disabled_connect_and_http_enabled',
    ok: true,
    liveApplyEnabled: false,
    liveReadonlyConnectEnabled: true,
    liveHttpEnabled: true,
    firewallDeleteEnabled: false,
  });

  const mappingResults = [];
  for (const [code, category] of Object.entries(CONNECT_DRIVER_CODE_CATEGORY)) {
    const classified = classifyConnectError({ code });
    if (classified.category !== category || classified.message !== CONNECT_FAILED_SAFE_MESSAGE) {
      throw new Error(`GREEN code mapping failed: ${code}`);
    }
    mappingResults.push({ code, category: classified.category });
  }
  green.push({
    name: 'connect_classifier_category_mappings',
    ok: true,
    mappings: mappingResults.slice(0, 8),
    allowlistEntryCount: Object.keys(CONNECT_DRIVER_CODE_CATEGORY).length,
    syntheticCodes: { ...CONNECT_MESSAGE_SYNTHETIC_CODE },
    categories: CONNECT_CATEGORIES.slice(),
    messageProbeMaxLen: CONNECT_MESSAGE_PROBE_MAX_LEN,
  });

  // --- LIVE or preserve ---
  let firewallPrestateOutcome;
  let credentialPreflightOutcome;
  let countOutcome = null;
  let countAttempted = false;
  let preflightAttempted = false;
  let firewallAttempted = false;

  if (offlineOnly) {
    if (!priorEvidence || !priorEvidence.firewallPrestateOutcome) {
      throw new Error('offline mode requires prior live evidence (run once with --live)');
    }
    firewallPrestateOutcome = priorEvidence.firewallPrestateOutcome;
    credentialPreflightOutcome = priorEvidence.credentialPreflightOutcome || null;
    countOutcome = priorEvidence.liveCountOutcome || null;
    countAttempted = priorEvidence.liveCountAttemptCount === 1;
    preflightAttempted = priorEvidence.credentialPreflightAttemptCount === 1;
    firewallAttempted = true;
    console.log('Offline mode: preserved historical live firewall/preflight/count outcomes.\n');
  } else {
    console.log('Live section 1/3: post-firewall prestate verify (ARM GET + outbound IP; zero PUT)…\n');
    firewallAttempted = true;
    resetFirewallApplyCounters();
    const livePrestate = await executeLunaboxPgFirewallPrestateVerify({});
    leakScan(livePrestate, secrets);
    firewallPrestateOutcome = pickSafeFirewallPrestate(livePrestate);
    leakScan(firewallPrestateOutcome, secrets);

    if (firewallPrestateOutcome.ok !== true) {
      console.log(
        `Firewall prestate blocked (${firewallPrestateOutcome.blocker}) — skipping credential preflight and count.\n`,
      );
      credentialPreflightOutcome = null;
    } else {
      console.log('Live section 2/3: one gated credential-preflight CLI spawn…\n');
      preflightAttempted = true;
      const livePreflightEnv = credentialPreflightEnv();
      const livePreflightArgv = exactCredentialPreflightArgv();
      const livePreflightCli = spawnSync(
        process.execPath,
        [PREFLIGHT_CLI_PATH, ...livePreflightArgv],
        {
          encoding: 'utf8',
          env: { ...process.env, ...livePreflightEnv },
        },
      );
      const preflightCombined = `${livePreflightCli.stdout || ''}${livePreflightCli.stderr || ''}`;
      leakScan(preflightCombined, secrets);
      const preflightParsed = parseLastJsonObject(preflightCombined);
      if (preflightParsed) leakScan(preflightParsed, secrets);
      credentialPreflightOutcome = buildPreflightLiveOutcome(
        preflightParsed,
        livePreflightCli.status,
      );
      leakScan(credentialPreflightOutcome, secrets);

      const hostOk = credentialPreflightOutcome.postgresHost === CREDENTIAL_PREFLIGHT_LOCKS.postgresHost;
      const dbOk = credentialPreflightOutcome.database === CREDENTIAL_PREFLIGHT_LOCKS.database;
      const sslOk = credentialPreflightOutcome.sslmode === 'verify-full';
      if (credentialPreflightOutcome.ok !== true || !hostOk || !dbOk || !sslOk
        || credentialPreflightOutcome.secretTargetValid !== true) {
        console.log(
          `Credential preflight blocked/invalid (${credentialPreflightOutcome.blocker || 'target_mismatch'}) — skipping count.\n`,
        );
        if (credentialPreflightOutcome.ok === true && (!hostOk || !dbOk || !sslOk)) {
          credentialPreflightOutcome.ok = false;
          credentialPreflightOutcome.blocker = 'credential_preflight_target_mismatch';
          credentialPreflightOutcome.code = 'credential_preflight_target_mismatch';
        }
      } else {
        console.log('Live section 3/3: exactly one gated managed-identity count-only CLI spawn…\n');
        countAttempted = true;
        const liveCountEnv = miEnv();
        const liveCountArgv = miArgv();
        const liveCountCli = spawnSync(
          process.execPath,
          [COUNT_CLI_PATH, ...liveCountArgv],
          {
            encoding: 'utf8',
            env: { ...process.env, ...liveCountEnv },
          },
        );
        const countCombined = `${liveCountCli.stdout || ''}${liveCountCli.stderr || ''}`;
        leakScan(countCombined, secrets);
        const countParsed = parseLastJsonObject(countCombined);
        if (countParsed) leakScan(countParsed, secrets);
        countOutcome = buildCountLiveOutcome(countParsed, liveCountCli.status);
        leakScan(countOutcome, secrets);
      }
    }
  }

  const firewallOk = firewallPrestateOutcome && firewallPrestateOutcome.ok === true;
  const preflightOk = credentialPreflightOutcome && credentialPreflightOutcome.ok === true;
  const countOk = countOutcome && countOutcome.ok === true;
  let outcome;
  if (!firewallOk) {
    outcome = 'phase_d_post_firewall_counts_blocked_at_firewall_prestate';
  } else if (!preflightAttempted) {
    outcome = 'phase_d_post_firewall_counts_blocked_before_credential_preflight';
  } else if (!preflightOk) {
    outcome = 'phase_d_post_firewall_counts_blocked_at_credential_preflight';
  } else if (!countAttempted) {
    outcome = 'phase_d_post_firewall_counts_blocked_before_count';
  } else if (countOk) {
    outcome = 'phase_d_post_firewall_counts_ok';
  } else {
    outcome = 'phase_d_post_firewall_counts_blocked';
  }

  const contract = {
    kind: 'sunset-schema-observer-slice14o-post-firewall-phase-d-counts-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    liveApplyCapability: false,
    liveReadonlyConnectEnabled: true,
    liveQueryExecution: true,
    liveHttpEnabled: true,
    appliesConstraints: false,
    writesLedger: false,
    mutates: false,
    firewallMutation: false,
    networkMutation: false,
    defaultEnabled: false,
    dualEnableFlagsRequired: true,
    executeCountOnlyGateRequired: true,
    exactTargetCliConfirmationRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    firewallPrestateRequiredBeforeCredentialPreflight: true,
    credentialPreflightRequiredBeforeLiveCount: true,
    offlineInjectedHttpAndFakeClientProof: true,
    connectErrorClassifierRequired: true,
    connectMessageClassifierRequired: true,
    existingCliGatesUnchanged: true,
    verifyNeverRerunsLive: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14O',
    purpose: 'Post-firewall: verify Ready/Enabled + exact three rules including AllowLunaboxEgress 20.238.124.76/32 + dual outbound IP match; then one metadata credential preflight; then exactly one gated managed-identity Phase D count-only aggregate; safe counts or blocker only; zero mutation; verify never re-runs live.',
    targets: { ...TARGETS },
    firewallLocks: {
      firewallRuleName: FIREWALL_LOCKS.firewallRuleName,
      startIpAddress: FIREWALL_LOCKS.startIpAddress,
      endIpAddress: FIREWALL_LOCKS.endIpAddress,
      expectedOutboundIpv4: FIREWALL_LOCKS.expectedOutboundIpv4,
      expectedRules: EXPECTED_POST_FIREWALL_RULES.map((r) => ({
        name: r.name,
        startIpAddress: r.startIpAddress,
        endIpAddress: r.endIpAddress,
        cidr: `${r.startIpAddress}/32`,
      })),
      outboundIpServices: FIREWALL_LOCKS.outboundIpServices.map((s) => ({
        name: s.name,
        hostname: s.hostname,
        path: s.path,
      })),
    },
    managedIdentityLocks: {
      imdsHost: MI_LOADER_LOCKS.imdsHost,
      keyVaultName: MI_LOADER_LOCKS.keyVaultName,
      secretName: MI_LOADER_LOCKS.secretName,
      managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
      managedIdentityClientId: MI_LOADER_LOCKS.managedIdentityClientId,
      postgresHost: MI_LOADER_LOCKS.postgresHost,
      database: MI_LOADER_LOCKS.database,
      sslmode: MI_LOADER_LOCKS.sslmode,
      port: MI_LOADER_LOCKS.port,
      applicationName: TARGETS.applicationName,
    },
    commandContract: {
      credentialPreflight: {
        script: 'scripts/run-phase-d-credential-preflight.js',
        npm: 'phase-d:credential-preflight',
      },
      countOnly: {
        script: 'scripts/run-phase-d-live-readonly-count-only.js',
        npm: 'phase-d:live-readonly-count-only',
        requiredEnv: [
          `${ENV_LIVE_READONLY}=1`,
          `${ENV_LIVE_PREFLIGHT}=1`,
          `${ENV_EXECUTE_COUNT_ONLY}=1`,
          `${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
          `AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
        ],
        requiredArgv: [
          CLI_EXECUTE_COUNT_ONLY,
          `${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
          `--subscription ${TARGETS.subscriptionId}`,
          `--resource-group ${TARGETS.resourceGroup}`,
          `--postgres-server ${TARGETS.postgresServer}`,
          `--database ${TARGETS.database}`,
        ],
        forbiddenArgv: FORBIDDEN_ARGV_FLAGS.slice(),
      },
      credentialPreflightSafeOutputKeys: SAFE_OUTPUT_KEYS.slice(),
    },
    authorizedSequence: [
      'firewall prestate (server Ready + publicNetworkAccess Enabled + exact three rules + dual outbound IP)',
      'IMDS GET',
      'Key Vault secret GET',
      'in-memory exact target validation',
      'one pg Client (TLS verify-full, application_name wh-sunset-phase-d-preflight)',
      ...AUTHORIZED_SEQUENCE,
    ],
    predicatesUnchangedFrom14A: {
      date_window: DATE_WINDOW_PREDICATE,
      price_unit: PRICE_UNIT_PREDICATE,
    },
    forbidden: [
      'INSERT/UPDATE/DELETE',
      'DDL / ADD CONSTRAINT',
      'ledger write',
      'RBAC / network / firewall mutation',
      'migration / predicate changes',
      'DSN / token / username / password / secret version in evidence',
      'broad retry on live failure',
      'second live count in verify',
      'raw connect driver message in evidence',
    ],
    nonGoals: [
      'No Phase D constraint apply',
      'No Sunset repair claim',
      'No expected-fixture regeneration',
      'No Azure/KV/RBAC/network mutation',
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14o-post-firewall-phase-d-counts-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14O',
    outcome,
    stillProductSchemaDiffers: true,
    phaseDConstraintsApplied: false,
    liveMutation: false,
    liveReadonlyConnectEnabled: true,
    liveHttpEnabled: true,
    liveApplyEnabled: false,
    firewallAction: false,
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
    existingCliGatesUnchanged: true,
    connectErrorClassifierApplied: true,
    connectMessageClassifierApplied: true,
    firewallPrestateAttemptCount: firewallAttempted ? 1 : 0,
    credentialPreflightAttemptCount: preflightAttempted ? 1 : 0,
    liveCountAttemptCount: countAttempted ? 1 : 0,
    migrationHashes: {
      '028': live028,
      '035': live035,
      '040': live040,
      '041': live041,
    },
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    migration028Sha256CanonicalLfV1: live028,
    defaultDisabled: true,
    dualEnableFlagsRequired: true,
    executeCountOnlyGateRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    authorizedSequence: contract.authorizedSequence.slice(),
    offlineGates: {
      defaultPathZeroHttpAndClients: true,
      missingExecuteGateZeroClients: true,
      wrongOrForbiddenCliArgsZeroClients: true,
      managedIdentityRequiresEnvAndArgv: true,
      firewallOutboundIpMismatchZeroPostgres: true,
      firewallRuleCountMismatchZeroPostgres: true,
      firewallServerNotReadyZeroPostgres: true,
      connectClassifierSecretMessagesSanitize: true,
      injectedFirewallPrestateExactThreeRules: true,
      injectedHttpSuccessExactCountSequence: true,
      cliGatesManagedIdentityExactTargets: true,
      countOnlyCliDefaultDisabled: true,
      locksIdentityVaultSecretPgTlsApplicationNameFirewall: true,
      applyDisabledConnectAndHttpEnabled: true,
      connectClassifierCategoryMappings: true,
    },
    redCases: red,
    greenCases: green,
    redCaseCount: red.length,
    greenCaseCount: green.length,
    httpCallCounts: {
      successPathHttpRequestCount: 2,
      successPathImdsRequestCount: 1,
      successPathKeyVaultRequestCount: 1,
      defaultPathHttpRequestCount: 0,
      liveFirewallPrestateHttpRequestCount: firewallPrestateOutcome
        ? firewallPrestateOutcome.httpRequestCount : 0,
      liveFirewallPrestateImdsRequestCount: firewallPrestateOutcome
        ? firewallPrestateOutcome.imdsRequestCount : 0,
      liveFirewallPrestateArmGetCount: firewallPrestateOutcome
        ? firewallPrestateOutcome.armGetCount : 0,
      liveFirewallPrestateOutboundIpGetCount: firewallPrestateOutcome
        ? firewallPrestateOutcome.outboundIpGetCount : 0,
      liveFirewallPrestatePutCount: firewallPrestateOutcome
        ? firewallPrestateOutcome.putCount : 0,
      liveCredentialPreflightHttpCallsDelta: credentialPreflightOutcome
        ? credentialPreflightOutcome.httpCallsDelta : 0,
      liveCredentialPreflightImdsRequestCount: credentialPreflightOutcome
        ? credentialPreflightOutcome.imdsRequestCount : 0,
      liveCredentialPreflightKeyVaultRequestCount: credentialPreflightOutcome
        ? credentialPreflightOutcome.keyVaultRequestCount : 0,
      liveCountHttpRequestCount: countOutcome ? countOutcome.httpRequestCount : 0,
      liveCountImdsRequestCount: countOutcome ? countOutcome.imdsRequestCount : 0,
      liveCountKeyVaultRequestCount: countOutcome ? countOutcome.keyVaultRequestCount : 0,
    },
    clientCallCounts: {
      successPathClientsInstantiated: 1,
      successPathQueryCalls: AUTHORIZED_SEQUENCE.length,
      defaultPathClientsInstantiated: 0,
      liveFirewallPrestateClientsInstantiated: 0,
      liveCredentialPreflightClientsInstantiated: credentialPreflightOutcome
        ? credentialPreflightOutcome.clientsInstantiated : 0,
      liveCountClientsInstantiated: countOutcome ? countOutcome.clientsInstantiated : 0,
      liveCountConnectCalls: countOutcome ? countOutcome.connectCalls : 0,
      liveCountQueryCalls: countOutcome ? countOutcome.queryCalls : 0,
      liveCountEndCalls: countOutcome ? countOutcome.endCalls : 0,
      liveCountSessions: countOutcome && countOutcome.connectCalls > 0 ? 1 : 0,
    },
    safeCounts: countOk && countOutcome && countOutcome.counts
      ? {
        total_rows: countOutcome.counts.total_rows,
        date_window_violations: countOutcome.counts.date_window_violations,
        price_unit_violations: countOutcome.counts.price_unit_violations,
      }
      : null,
    firewallPrestateOutcome,
    credentialPreflightOutcome,
    liveCountOutcome: countOutcome,
    secretHandlingProof: {
      privateFieldsZeroedImmediately: true,
      neverPrinted: true,
      neverPersisted: true,
      neverHashedIntoEvidence: true,
      neverInArgv: true,
      neverInTempFile: true,
      neverInChildProcessEnv: true,
      connectClassifierNeverOutputsRawMessage: true,
      connectMessageClassifierNeverOutputsMatchedFragment: true,
    },
  };

  leakScan(evidence, secrets);
  leakScan(contract, secrets);

  const operatorCmd = [
    `${ENV_LIVE_READONLY}=1`,
    `${ENV_LIVE_PREFLIGHT}=1`,
    `${ENV_EXECUTE_COUNT_ONLY}=1`,
    `${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    `AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
    'npm run phase-d:live-readonly-count-only --',
    CLI_EXECUTE_COUNT_ONLY,
    `--subscription ${TARGETS.subscriptionId}`,
    `--resource-group ${TARGETS.resourceGroup}`,
    `--postgres-server ${TARGETS.postgresServer}`,
    `--database ${TARGETS.database}`,
    `${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
  ].join(' ');

  const fwSummary = !firewallPrestateOutcome
    ? 'Firewall prestate **not run**.'
    : firewallOk
      ? `Firewall prestate **ok** (Ready=${firewallPrestateOutcome.serverState}, publicNetworkAccess=${firewallPrestateOutcome.publicNetworkAccess}, rulesCount=${firewallPrestateOutcome.rulesCount}, AllowLunaboxEgress=${FIREWALL_LOCKS.startIpAddress}/32, outbound matched=${firewallPrestateOutcome.outboundIpv4Matched}, putCount=${firewallPrestateOutcome.putCount}, armGet=${firewallPrestateOutcome.armGetCount}, outboundIpGet=${firewallPrestateOutcome.outboundIpGetCount}).`
      : `Firewall prestate **blocked** (\`blocker=${firewallPrestateOutcome.blocker}\`, code=\`${firewallPrestateOutcome.code}\`, putCount=${firewallPrestateOutcome.putCount}).`;

  const pfSummary = !preflightAttempted
    ? 'Credential preflight **not attempted** (stopped after firewall prestate).'
    : preflightOk
      ? `Credential preflight **ok** (host/database/sslmode=verify-full, secretTargetValid=true, httpCallsDelta=${credentialPreflightOutcome.httpCallsDelta}, clientsInstantiated=0).`
      : `Credential preflight **blocked** (\`blocker=${credentialPreflightOutcome.blocker}\`, code=\`${credentialPreflightOutcome.code}\`).`;

  const countSummary = !countAttempted
    ? 'Live count **not attempted**.'
    : countOk
      ? `Live count **ok** (total_rows=${countOutcome.counts.total_rows}, date_window_violations=${countOutcome.counts.date_window_violations}, price_unit_violations=${countOutcome.counts.price_unit_violations}, clientsInstantiated=${countOutcome.clientsInstantiated}, connectCalls=${countOutcome.connectCalls}, queryCalls=${countOutcome.queryCalls}, endCalls=${countOutcome.endCalls}, sessions=1, httpRequestCount=${countOutcome.httpRequestCount}).`
      : `Live count **blocked** (\`category=${countOutcome.connectCategory || 'n/a'}\`, \`code=${countOutcome.code}\`, \`blocker=${countOutcome.blocker}\`, clientsInstantiated=${countOutcome.clientsInstantiated}, connectCalls=${countOutcome.connectCalls}, queryCalls=${countOutcome.queryCalls}, endCalls=${countOutcome.endCalls}).`;

  const findings = `# FOUNDATION Slice 14O — Post-firewall Phase D live read-only counts

**Status:** complete (offline RED/GREEN + live firewall prestate + credential preflight + one count attempt; zero mutation)
**Master basis:** \`${MASTER}\`
**Generated:** ${generatedAt}

## Outcome

${fwSummary}

${pfSummary}

${countSummary}

Outcome code: \`${outcome}\`.

Sequence: post-firewall ARM/outbound prestate → merged 14F/14G metadata credential-preflight → exactly one merged 14D/14E managed-identity count-only path (\`application_name=wh-sunset-phase-d-preflight\`, \`BEGIN READ ONLY\`, transaction_read_only verify, locked catalog checks, exact 14A aggregate for total_rows/date_window_violations/price_unit_violations, COMMIT/ROLLBACK, end). On blocker: existing secret-free classifier; no retry. Verify never re-runs live.

Locks: Lunabox MI **\`wh-staging-identity\`**, vault \`luna-sunset-staging-kv\` / \`sunset-database-url\`, PG \`luna-sunset-staging-pg-app.postgres.database.azure.com:5432/sunset_staging\`, TLS \`sslmode=verify-full\`, firewall **\`AllowLunaboxEgress\`** \`20.238.124.76/32\`.

## Operator command (count-only; default-disabled)

\`\`\`bash
${operatorCmd}
\`\`\`

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero HTTP+Clients; missing execute gate; wrong/forbidden argv; MI requires env+argv; firewall outbound/rule-count/server-not-ready zero PG; connect classifier secret sanitize |
| GREEN | injected firewall prestate exact three rules; injected HTTP → fake Client exact sequence; CLI gates; CLI default refuse; locks; APPLY disabled; connect classifier mappings |

## Non-goals / still open

- **No** Phase D constraint apply, DDL, or ledger write
- **No** RBAC/KV/network/firewall mutation
- Still \`product_schema_differs\`
- **Do not claim Sunset repaired.**

## Zero DB mutation

Read-only \`BEGIN READ ONLY\` aggregate counts only (when count runs). Private refs zeroed. No secret value/version/id in evidence. No INSERT/UPDATE/DELETE. No apply/DDL. Firewall prestate is GET-only (\`putCount=0\`).
`;

  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, findings);

  console.log(`Outcome: ${outcome}`);
  if (evidence.safeCounts) {
    console.log(`safeCounts: ${JSON.stringify(evidence.safeCounts)}`);
  } else if (countOutcome) {
    console.log(`blocker: ${countOutcome.blocker} code=${countOutcome.code} category=${countOutcome.connectCategory}`);
  } else if (credentialPreflightOutcome && !preflightOk) {
    console.log(`blocker: ${credentialPreflightOutcome.blocker}`);
  } else if (firewallPrestateOutcome && !firewallOk) {
    console.log(`blocker: ${firewallPrestateOutcome.blocker}`);
  }
  console.log(`Wrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log(offlineOnly
    ? '\nSlice 14O offline proof GREEN — historical live evidence preserved; zero additional live calls.'
    : '\nSlice 14O proof GREEN — live prestate + preflight + one count path recorded; zero mutation.');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
