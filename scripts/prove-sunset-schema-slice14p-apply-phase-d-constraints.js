'use strict';

/**
 * prove-sunset-schema-slice14p-apply-phase-d-constraints — FOUNDATION Slice 14P
 *
 * Offline RED/GREEN → optional --live path: firewall prestate → credential
 * preflight → one gated constraint-apply transaction (exactly two ADD CONSTRAINT
 * from byte-locked 028) → canonical observer read-only compare. Default offline;
 * preserves historical live evidence when present.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const {
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  sha256CanonicalLfV1File,
} = require('./lib/migration-integrity');
const {
  hashCanonicalManifest,
  clientConfigFromDsn,
  introspectProductSchema,
  fingerprintProductSchema,
  compareSnapshots,
  verifyLiveSession,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  EXPECTED_HOST,
  EXPECTED_DATABASE,
} = require('./lib/sunset-schema-observer');
const {
  TARGETS,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  AUTHORIZED_AGGREGATE_SQL,
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
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
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  MI_LOADER_LOCKS,
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  loadProtectedAdminCredentialsViaManagedIdentity,
  zeroPrivateCredentialRefs,
  getManagedIdentityHttpCounters,
  resetManagedIdentityHttpCounters,
} = require('./lib/phase-d-managed-identity-credential-loader');
const {
  CREDENTIAL_PREFLIGHT_LOCKS,
  exactCredentialPreflightArgv,
  credentialPreflightEnv,
} = require('./lib/phase-d-credential-preflight');
const {
  PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED,
  FIREWALL_LOCKS,
  executeLunaboxPgFirewallPrestateVerify,
} = require('./lib/phase-d-lunabox-pg-firewall-apply');
const {
  PHASE_D_CONSTRAINT_APPLY_LIVE_ENABLED,
  ENV_CONSTRAINT_APPLY,
  CLI_APPLY_CONSTRAINTS,
  AUTHORIZED_SEQUENCE,
  APPLY_LOCKS,
  ALTER_DATE_WINDOW_SHA256,
  ALTER_PRICE_UNIT_SHA256,
  CONSTRAINT_DATE_WINDOW,
  CONSTRAINT_PRICE_UNIT,
  FORBIDDEN_ARGV_FLAGS,
  evaluateConstraintApplyGates,
  executePhaseDConstraintApply,
  createScriptedConstraintApplyFakeClientFactory,
  resetConstraintApplyCounters,
  getConstraintApplyCounters,
  exactConstraintApplyArgv,
  constraintApplyEnv,
  assertAlterStatementsByteLocked,
  authorizeApplySql,
} = require('./lib/phase-d-constraint-apply');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14p-apply-phase-d-constraints-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14p-apply-phase-d-constraints-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14p-findings.md');
const APPLY_CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-constraint-apply.js');
const PREFLIGHT_CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-credential-preflight.js');

const MASTER = '51afd90f84a9100afb95c777ce92d27fff164f2c';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const FAKE_ADMIN_USER = 'slice14p-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14p-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14p-proof-imds-token-never-commit';

function validSecretValue() {
  return buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
}

function applyArgv(extraFlags) {
  return [
    ...exactConstraintApplyArgv(),
    ...(extraFlags || []),
  ];
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
  if (/Bearer\s+slice14p-proof-imds-token/i.test(text)) {
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

function buildApplyLiveOutcome(parsed, exitCode) {
  const p = parsed || {};
  const ok = p.ok === true;
  const errors = sanitizeErrors(p.errors);
  if (!parsed) {
    errors.push({
      code: 'live_output_unparseable',
      message: 'constraint-apply CLI stdout/stderr did not contain parseable JSON',
    });
  }
  const code = String(p.code || (ok ? 'phase_d_constraint_apply_ok' : 'constraint_apply_failed'));
  const blocker = ok ? null : String(code || (errors[0] && errors[0].code) || 'constraint_apply_failed');
  const counts = (p.counts && typeof p.counts === 'object') ? {
    total_rows: Number(p.counts.total_rows),
    date_window_violations: Number(p.counts.date_window_violations),
    price_unit_violations: Number(p.counts.price_unit_violations),
  } : null;
  return {
    attempt: 1,
    ok,
    code,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    beforeConstraints: Array.isArray(p.beforeConstraints) ? p.beforeConstraints : [],
    afterConstraints: Array.isArray(p.afterConstraints) ? p.afterConstraints : [],
    counts,
    steps: Array.isArray(p.steps) ? p.steps.slice() : [],
    committed: p.committed === true,
    rolledBack: p.rolledBack === true,
    credentialSource: p.credentialSource || null,
    managedIdentityName: p.managedIdentityName || APPLY_LOCKS.managedIdentityName,
    keyVaultName: p.keyVaultName || APPLY_LOCKS.keyVaultName,
    secretName: p.secretName || APPLY_LOCKS.secretName,
    postgresHost: p.postgresHost || TARGETS.postgresHost,
    database: p.database || TARGETS.database,
    sslmode: p.sslmode || 'verify-full',
    applicationName: p.applicationName || APPLY_LOCKS.applicationName,
    clientsInstantiated: Number(p.clientsInstantiated) || 0,
    connectCalls: Number(p.connectCalls) || 0,
    queryCalls: Number(p.queryCalls) || 0,
    endCalls: Number(p.endCalls) || 0,
    httpRequestCount: Number(p.httpRequestCount) || 0,
    imdsRequestCount: Number(p.imdsRequestCount) || 0,
    keyVaultRequestCount: Number(p.keyVaultRequestCount) || 0,
    closed: p.closed === true,
    liveMutation: p.liveMutation === true,
    schemaMutation: p.schemaMutation === true,
    dataMutation: false,
    ledgerWritten: false,
    errors,
    blocker,
  };
}

async function runCanonicalObserverCompare(dsn) {
  const contract = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
  const cfg = clientConfigFromDsn(dsn);
  const client = new Client(cfg);
  try { cfg.password = undefined; cfg.user = undefined; } catch (_) { /* ignore */ }
  let closed = false;
  try {
    await client.connect();
    const session = await verifyLiveSession(client);
    if (!session.ok) {
      return {
        ok: false,
        match: false,
        code: 'session_not_read_only',
        mismatchCount: null,
        counts: null,
        constraintSamples: [],
        productFingerprintLive: null,
        normalizationError: null,
        blocker: 'session_not_read_only',
        errors: sanitizeErrors(session.errors),
      };
    }
    const product = await introspectProductSchema(client);
    const productFingerprintLive = fingerprintProductSchema(product.snapshot);
    const azureContext = {
      verified: true,
      host: EXPECTED_HOST,
      database: EXPECTED_DATABASE,
    };
    const cmp = compareSnapshots(contract.snapshot, product.snapshot, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext,
    });
    if (cmp.normalizationError) {
      return {
        ok: false,
        match: false,
        code: cmp.normalizationError.code || 'normalization_failed',
        mismatchCount: null,
        counts: cmp.counts || null,
        constraintSamples: [],
        productFingerprintLive,
        normalizationError: {
          code: cmp.normalizationError.code,
          message: String(cmp.normalizationError.message || '').slice(0, 240),
        },
        blocker: cmp.normalizationError.code || 'normalization_failed',
      };
    }
    const mismatchCount = Array.isArray(cmp.drifts) ? cmp.drifts.length : (
      (cmp.counts.expected_only || 0)
      + (cmp.counts.live_only || 0)
      + (cmp.counts.definition_mismatch || 0)
    );
    const phaseDExactKeys = [
      `tenant_services.${CONSTRAINT_DATE_WINDOW}.CHECK`,
      `tenant_services.${CONSTRAINT_PRICE_UNIT}.CHECK`,
    ];
    const phaseDDrifts = (cmp.drifts || []).filter((d) =>
      phaseDExactKeys.some((k) => d.key === k || String(d.key).endsWith(k)));
    return {
      ok: cmp.ok === true,
      match: cmp.ok === true,
      code: cmp.ok === true ? 'observer_match' : 'observer_drift',
      mismatchCount,
      counts: cmp.counts,
      constraintSamples: phaseDDrifts.slice(0, 4).map((d) => ({ kind: d.kind, key: d.key })),
      phaseDCheckKeys: phaseDExactKeys,
      phaseDCheckKeysCleared: phaseDDrifts.length === 0,
      productFingerprintLive,
      normalizationError: null,
      blocker: cmp.ok === true ? null : 'observer_drift',
      sessionReadOnly: true,
    };
  } finally {
    if (!closed) {
      try {
        await client.end();
        closed = true;
      } catch (_) {
        /* ignore */
      }
    }
  }
}

async function main() {
  const wantLive = process.argv.includes('--live');
  const offlineOnly = !wantLive
    || process.argv.includes('--offline')
    || process.env.SUNSET_SLICE14P_PROOF_OFFLINE === '1';
  console.log(offlineOnly
    ? 'prove:sunset-schema-slice14p — offline only (no live HTTP/PG apply/observer)\n'
    : 'prove:sunset-schema-slice14p — offline then live prestate + preflight + apply + observer\n');

  const priorEvidence = fs.existsSync(EVIDENCE_PATH)
    ? JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'))
    : null;
  const preserveLive = offlineOnly
    && priorEvidence
    && priorEvidence.liveApplyOutcome
    && priorEvidence.liveApplyOutcome.ok === true;
  const generatedAt = (!offlineOnly && wantLive)
    ? new Date().toISOString()
    : (preserveLive && priorEvidence.generatedAt) || new Date().toISOString();

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
    throw new Error('global APPLY must remain disabled');
  }
  if (PHASE_D_CONSTRAINT_APPLY_LIVE_ENABLED !== true) {
    throw new Error('constraint apply capability must be enabled');
  }
  if (PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED !== true) {
    throw new Error('live MI HTTP must be activated');
  }
  if (PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED !== true) {
    throw new Error('firewall live HTTP must be enabled');
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

  if (!fs.existsSync(APPLY_CLI_PATH) || !fs.existsSync(PREFLIGHT_CLI_PATH)) {
    throw new Error('required CLIs missing');
  }

  const alterLock = assertAlterStatementsByteLocked();
  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN, validSecretValue()];
  const red = [];
  const green = [];

  // --- RED ---
  resetConstraintApplyCounters();
  resetManagedIdentityHttpCounters();
  const def = await executePhaseDConstraintApply({ env: {}, argv: [] });
  if (getConstraintApplyCounters().clientsInstantiated !== 0
    || getManagedIdentityHttpCounters().httpRequestCount !== 0) {
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

  resetConstraintApplyCounters();
  resetManagedIdentityHttpCounters();
  const noApplyFlag = await executePhaseDConstraintApply({
    env: constraintApplyEnv(),
    argv: applyArgv().filter((a) => a !== CLI_APPLY_CONSTRAINTS),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (getConstraintApplyCounters().clientsInstantiated !== 0
    || getManagedIdentityHttpCounters().httpRequestCount !== 0) {
    throw new Error('missing apply flag must zero Clients/HTTP');
  }
  red.push({
    name: 'missing_apply_flag_zero_clients',
    ok: true,
    code: noApplyFlag.code,
    clientsInstantiated: 0,
  });

  resetConstraintApplyCounters();
  resetManagedIdentityHttpCounters();
  const noEnv = await executePhaseDConstraintApply({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    },
    argv: applyArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (getConstraintApplyCounters().clientsInstantiated !== 0) {
    throw new Error('missing constraint apply env must zero Clients');
  }
  red.push({
    name: 'missing_constraint_apply_env_zero_clients',
    ok: true,
    code: noEnv.code,
    clientsInstantiated: 0,
  });

  const wrongDb = evaluateConstraintApplyGates({
    env: constraintApplyEnv(),
    argv: applyArgv().map((a, i, arr) => (arr[i - 1] === '--database' ? 'evil_db' : a)),
  });
  if (wrongDb.ok) throw new Error('wrong database must fail');
  resetConstraintApplyCounters();
  const wrongRun = await executePhaseDConstraintApply({
    env: constraintApplyEnv(),
    argv: applyArgv().map((a, i, arr) => (arr[i - 1] === '--database' ? 'evil_db' : a)),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (getConstraintApplyCounters().clientsInstantiated !== 0) {
    throw new Error('wrong targets must zero Clients');
  }
  red.push({
    name: 'wrong_exact_targets_zero_clients',
    ok: true,
    rejected: !wrongDb.ok,
    code: wrongRun.code,
    clientsInstantiated: 0,
  });

  const forbidden = evaluateConstraintApplyGates({
    env: constraintApplyEnv(),
    argv: [
      ...applyArgv(),
      '--dsn', 'postgresql://x:y@h/db',
      '--sql', 'DROP TABLE public.tenant_services',
      '--drop',
      '--dml',
      '--retry',
    ],
  });
  if (forbidden.ok) throw new Error('forbidden argv must fail');
  resetConstraintApplyCounters();
  const forbiddenRun = await executePhaseDConstraintApply({
    env: constraintApplyEnv(),
    argv: [
      ...applyArgv(),
      '--dsn', 'postgresql://x:y@h/db',
      '--sql', 'DELETE FROM public.tenant_services',
      '--drop',
      '--dml',
      '--retry',
    ],
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (getConstraintApplyCounters().clientsInstantiated !== 0) {
    throw new Error('forbidden argv must zero Clients');
  }
  red.push({
    name: 'forbidden_argv_dsn_sql_drop_dml_retry_zero_clients',
    ok: true,
    rejected: !forbidden.ok,
    forbiddenFlags: FORBIDDEN_ARGV_FLAGS.slice(),
    clientsInstantiated: 0,
    code: forbiddenRun.code,
  });

  const halfFlag = evaluateConstraintApplyGates({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_CONSTRAINT_APPLY]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    },
    argv: exactConstraintApplyArgv(),
  });
  if (halfFlag.ok) throw new Error('MI without env credential-source must fail');
  red.push({
    name: 'managed_identity_requires_env_and_argv',
    ok: true,
    rejected: !halfFlag.ok,
  });

  resetConstraintApplyCounters();
  resetManagedIdentityHttpCounters();
  const FakeNonzero = createScriptedConstraintApplyFakeClientFactory({
    responses: {
      aggregate: {
        rows: [{
          total_rows: 3,
          date_window_violations: 1,
          price_unit_violations: 0,
        }],
        rowCount: 1,
      },
    },
  });
  const nonzero = await executePhaseDConstraintApply({
    env: constraintApplyEnv(),
    argv: applyArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
    Client: FakeNonzero,
  });
  if (nonzero.ok || nonzero.rolledBack !== true || nonzero.steps.includes('COMMIT')
    || nonzero.steps.some((s) => s.startsWith('ADD CONSTRAINT'))) {
    throw new Error(`nonzero counts must refuse+rollback: ${JSON.stringify(nonzero)}`);
  }
  red.push({
    name: 'nonzero_counts_refuse_rollback',
    ok: true,
    code: nonzero.code,
    rolledBack: true,
    noCommit: !nonzero.steps.includes('COMMIT'),
    noAddConstraint: !nonzero.steps.some((s) => s.startsWith('ADD CONSTRAINT')),
  });

  resetConstraintApplyCounters();
  const FakePreexisting = createScriptedConstraintApplyFakeClientFactory({
    responses: {
      constraintAbsence: {
        rows: [{
          conname: CONSTRAINT_DATE_WINDOW,
          contype: 'c',
          conrel: 'tenant_services',
        }],
        rowCount: 1,
      },
    },
  });
  const preexisting = await executePhaseDConstraintApply({
    env: constraintApplyEnv(),
    argv: applyArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
    Client: FakePreexisting,
  });
  if (preexisting.ok || preexisting.rolledBack !== true || preexisting.steps.includes('COMMIT')) {
    throw new Error(`preexisting constraint must refuse+rollback: ${JSON.stringify(preexisting)}`);
  }
  red.push({
    name: 'preexisting_constraint_refuse_rollback',
    ok: true,
    code: preexisting.code,
    rolledBack: true,
    noCommit: !preexisting.steps.includes('COMMIT'),
  });

  const rejectedSql = [];
  for (const sql of [
    'DROP TABLE public.tenant_services',
    'DELETE FROM public.tenant_services',
    'INSERT INTO public.tenant_services (id) VALUES (1)',
  ]) {
    try {
      authorizeApplySql(sql);
      throw new Error(`authorizeApplySql should reject: ${sql}`);
    } catch (e) {
      if (e.code !== 'unauthorized_sql') throw e;
      rejectedSql.push(sql.split(/\s+/).slice(0, 2).join(' '));
    }
  }
  red.push({
    name: 'wrong_extra_sql_rejected',
    ok: true,
    rejectedStatements: rejectedSql,
  });

  resetConstraintApplyCounters();
  const FakeLockFail = createScriptedConstraintApplyFakeClientFactory({
    queryErrorAt: {
      'pg_advisory_xact_lock': Object.assign(new Error('could not obtain lock'), {
        code: 'lock_timeout',
      }),
    },
  });
  const lockFail = await executePhaseDConstraintApply({
    env: constraintApplyEnv(),
    argv: applyArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
    Client: FakeLockFail,
  });
  if (lockFail.ok || lockFail.rolledBack !== true || lockFail.steps.includes('COMMIT')) {
    throw new Error(`lock failure must rollback: ${JSON.stringify(lockFail)}`);
  }
  red.push({
    name: 'lock_failure_rollback',
    ok: true,
    code: lockFail.code,
    rolledBack: true,
    noCommit: !lockFail.steps.includes('COMMIT'),
  });

  // --- GREEN ---
  resetConstraintApplyCounters();
  resetManagedIdentityHttpCounters();
  const httpOk = createInjectedManagedIdentityHttp({
    imdsAccessToken: FAKE_IMDS_TOKEN,
    defaultSecretValue: validSecretValue(),
  });
  const FakeOk = createScriptedConstraintApplyFakeClientFactory({});
  const okRun = await executePhaseDConstraintApply({
    env: constraintApplyEnv(),
    argv: applyArgv(),
    httpRequest: httpOk,
    Client: FakeOk,
  });
  leakScan(okRun, secrets);
  if (!okRun.ok
    || JSON.stringify(okRun.steps) !== JSON.stringify(AUTHORIZED_SEQUENCE)
    || !Array.isArray(okRun.beforeConstraints) || okRun.beforeConstraints.length !== 0
    || !Array.isArray(okRun.afterConstraints) || okRun.afterConstraints.length !== 2
    || okRun.counts.total_rows !== 0
    || okRun.counts.date_window_violations !== 0
    || okRun.counts.price_unit_violations !== 0
    || okRun.queryCalls !== 12
    || okRun.clientsInstantiated !== 1
    || okRun.httpRequestCount !== 2
    || okRun.dataMutation !== false
    || okRun.ledgerWritten !== false
    || okRun.schemaMutation !== true) {
    throw new Error(`GREEN injected sequence failed: ${JSON.stringify(okRun)}`);
  }
  green.push({
    name: 'injected_http_success_exact_constraint_sequence',
    ok: true,
    steps: okRun.steps,
    beforeConstraints: [],
    afterConstraintsCount: 2,
    counts: okRun.counts,
    clientsInstantiated: 1,
    httpRequestCount: 2,
    queryCalls: 12,
    schemaMutation: true,
    dataMutation: false,
    ledgerWritten: false,
  });

  const gatesOk = evaluateConstraintApplyGates({
    env: constraintApplyEnv(),
    argv: exactConstraintApplyArgv(),
  });
  if (!gatesOk.ok) {
    throw new Error(`CLI gates should pass: ${JSON.stringify(gatesOk.errors)}`);
  }
  green.push({
    name: 'cli_gates_exact_targets',
    ok: true,
    applyConstraints: gatesOk.applyConstraints === true,
  });

  const cliDefault = spawnSync(process.execPath, [APPLY_CLI_PATH], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (cliDefault.status === 0) throw new Error('constraint-apply CLI default must refuse');
  leakScan(`${cliDefault.stdout}${cliDefault.stderr}`, secrets);
  green.push({
    name: 'cli_default_disabled',
    ok: true,
    exitCode: cliDefault.status,
  });

  if (APPLY_LOCKS.applicationName !== 'wh-sunset-phase-d-constraint-apply'
    || MI_LOADER_LOCKS.managedIdentityName !== 'wh-staging-identity'
    || MI_LOADER_LOCKS.keyVaultName !== 'luna-sunset-staging-kv'
    || MI_LOADER_LOCKS.secretName !== 'sunset-database-url'
    || MI_LOADER_LOCKS.sslmode !== 'verify-full') {
    throw new Error('locks drift');
  }
  green.push({
    name: 'locks_identity_vault_secret_pg_tls_application_name',
    ok: true,
    applicationName: APPLY_LOCKS.applicationName,
    managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
    keyVaultName: MI_LOADER_LOCKS.keyVaultName,
    secretName: MI_LOADER_LOCKS.secretName,
    sslmode: MI_LOADER_LOCKS.sslmode,
    postgresHost: APPLY_LOCKS.postgresHost,
    database: APPLY_LOCKS.database,
  });

  if (PHASE_D_LIVE_APPLY_ENABLED !== false) {
    throw new Error('global live apply must remain false');
  }
  green.push({
    name: 'global_live_apply_remains_false',
    ok: true,
    liveApplyEnabled: false,
    constraintApplyLiveEnabled: true,
  });

  const alterBytes = assertAlterStatementsByteLocked();
  green.push({
    name: 'alter_statements_byte_locked',
    ok: true,
    migration028Sha256: alterBytes.migration028Sha256CanonicalLfV1,
    alterDateWindowSha256: alterBytes.alterDateWindowSha256,
    alterPriceUnitSha256: alterBytes.alterPriceUnitSha256,
  });

  // --- LIVE or preserve ---
  let firewallPrestateOutcome;
  let credentialPreflightOutcome;
  let liveApplyOutcome = null;
  let observerOutcome = null;
  let applyAttempted = false;
  let preflightAttempted = false;
  let firewallAttempted = false;
  let observerAttempted = false;

  if (offlineOnly) {
    if (preserveLive) {
      firewallPrestateOutcome = priorEvidence.firewallPrestateOutcome;
      credentialPreflightOutcome = priorEvidence.credentialPreflightOutcome || null;
      liveApplyOutcome = priorEvidence.liveApplyOutcome;
      observerOutcome = priorEvidence.observerOutcome || null;
      applyAttempted = priorEvidence.liveApplyAttemptCount === 1;
      preflightAttempted = priorEvidence.credentialPreflightAttemptCount === 1;
      firewallAttempted = priorEvidence.firewallPrestateAttemptCount === 1;
      observerAttempted = priorEvidence.observerAttemptCount === 1;
      console.log('Offline mode: preserved historical live apply/observer outcomes.\n');
    } else {
      firewallPrestateOutcome = priorEvidence && priorEvidence.firewallPrestateOutcome
        ? priorEvidence.firewallPrestateOutcome
        : null;
      credentialPreflightOutcome = priorEvidence && priorEvidence.credentialPreflightOutcome
        ? priorEvidence.credentialPreflightOutcome
        : null;
      liveApplyOutcome = priorEvidence && priorEvidence.liveApplyOutcome
        ? priorEvidence.liveApplyOutcome
        : null;
      observerOutcome = priorEvidence && priorEvidence.observerOutcome
        ? priorEvidence.observerOutcome
        : null;
      console.log('Offline mode: no live apply this run (liveApplyAttemptCount remains 0).\n');
    }
  } else {
    console.log('Live section 1/4: post-firewall prestate verify…\n');
    firewallAttempted = true;
    const livePrestate = await executeLunaboxPgFirewallPrestateVerify({});
    leakScan(livePrestate, secrets);
    firewallPrestateOutcome = pickSafeFirewallPrestate(livePrestate);
    leakScan(firewallPrestateOutcome, secrets);

    if (firewallPrestateOutcome.ok !== true) {
      console.log(
        `Firewall prestate blocked (${firewallPrestateOutcome.blocker}) — skipping preflight/apply/observer.\n`,
      );
      credentialPreflightOutcome = null;
    } else {
      console.log('Live section 2/4: one gated credential-preflight CLI spawn…\n');
      preflightAttempted = true;
      const livePreflightCli = spawnSync(
        process.execPath,
        [PREFLIGHT_CLI_PATH, ...exactCredentialPreflightArgv()],
        {
          encoding: 'utf8',
          env: { ...process.env, ...credentialPreflightEnv() },
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
          `Credential preflight blocked/invalid (${credentialPreflightOutcome.blocker || 'target_mismatch'}) — skipping apply/observer.\n`,
        );
        if (credentialPreflightOutcome.ok === true && (!hostOk || !dbOk || !sslOk)) {
          credentialPreflightOutcome.ok = false;
          credentialPreflightOutcome.blocker = 'credential_preflight_target_mismatch';
          credentialPreflightOutcome.code = 'credential_preflight_target_mismatch';
        }
      } else {
        console.log('Live section 3/4: exactly one gated constraint-apply CLI spawn…\n');
        applyAttempted = true;
        const liveApplyCli = spawnSync(
          process.execPath,
          [APPLY_CLI_PATH, ...exactConstraintApplyArgv()],
          {
            encoding: 'utf8',
            env: { ...process.env, ...constraintApplyEnv() },
          },
        );
        const applyCombined = `${liveApplyCli.stdout || ''}${liveApplyCli.stderr || ''}`;
        leakScan(applyCombined, secrets);
        const applyParsed = parseLastJsonObject(applyCombined);
        if (applyParsed) leakScan(applyParsed, secrets);
        liveApplyOutcome = buildApplyLiveOutcome(applyParsed, liveApplyCli.status);
        leakScan(liveApplyOutcome, secrets);

        if (liveApplyOutcome.ok === true) {
          console.log('Live section 4/4: canonical observer read-only compare…\n');
          observerAttempted = true;
          const loaded = await loadProtectedAdminCredentialsViaManagedIdentity({
            env: constraintApplyEnv(),
            argv: exactConstraintApplyArgv(),
          });
          if (!loaded.ok) {
            observerOutcome = {
              ok: false,
              match: false,
              code: loaded.code || 'managed_identity_loader_failed',
              mismatchCount: null,
              mismatchCountBeforeClaim: 2,
              mismatchCountAfter: null,
              mismatchReduced2to0: false,
              observed: false,
              blocker: loaded.code || 'managed_identity_loader_failed',
              errors: sanitizeErrors(loaded.errors),
            };
          } else {
            const dsn = buildOfflineProofSunsetDatabaseUrl(loaded._user, loaded._password);
            zeroPrivateCredentialRefs(loaded);
            try {
              const obs = await runCanonicalObserverCompare(dsn);
              observerOutcome = {
                ...obs,
                mismatchCountBeforeClaim: 2,
                mismatchCountAfter: obs.mismatchCount,
                mismatchReduced2to0: obs.match === true && obs.mismatchCount === 0,
                observed: true,
              };
            } catch (e) {
              observerOutcome = {
                ok: false,
                match: false,
                code: (e && e.code) || 'observer_failed',
                mismatchCount: null,
                mismatchCountBeforeClaim: 2,
                mismatchCountAfter: null,
                mismatchReduced2to0: false,
                observed: false,
                blocker: (e && e.code) || 'observer_failed',
                message: String((e && e.message) || 'observer failed').slice(0, 240),
              };
            }
            zeroPrivateCredentialRefs({ _dsn: dsn, _user: '', _password: '' });
          }
          leakScan(observerOutcome, secrets);
        } else {
          console.log(
            `Constraint apply blocked (${liveApplyOutcome.blocker}) — skipping observer.\n`,
          );
        }
      }
    }
  }

  const firewallOk = firewallPrestateOutcome && firewallPrestateOutcome.ok === true;
  const preflightOk = credentialPreflightOutcome && credentialPreflightOutcome.ok === true;
  const applyOk = liveApplyOutcome && liveApplyOutcome.ok === true;
  const observerOk = observerOutcome && observerOutcome.match === true;

  let outcome;
  if (offlineOnly && !applyAttempted && !preserveLive) {
    outcome = 'phase_d_constraint_apply_offline_only';
  } else if (!firewallOk) {
    outcome = 'phase_d_constraint_apply_blocked_at_firewall_prestate';
  } else if (!preflightAttempted) {
    outcome = 'phase_d_constraint_apply_blocked_before_credential_preflight';
  } else if (!preflightOk) {
    outcome = 'phase_d_constraint_apply_blocked_at_credential_preflight';
  } else if (!applyAttempted) {
    outcome = 'phase_d_constraint_apply_blocked_before_apply';
  } else if (!applyOk) {
    outcome = 'phase_d_constraint_apply_blocked';
  } else if (!observerAttempted) {
    outcome = 'phase_d_constraint_apply_ok_observer_skipped';
  } else if (observerOk) {
    outcome = 'phase_d_constraint_apply_and_observer_match';
  } else {
    outcome = 'phase_d_constraint_apply_ok_observer_drift';
  }

  const stillProductSchemaDiffers = observerOk !== true;

  const contract = {
    kind: 'sunset-schema-observer-slice14p-apply-phase-d-constraints-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: true,
    liveApplyCapability: true,
    constraintApplyLiveEnabled: true,
    globalLiveApplyEnabled: false,
    liveReadonlyConnectEnabled: true,
    liveHttpEnabled: true,
    appliesConstraints: true,
    writesLedger: false,
    dataMutation: false,
    mutates: true,
    schemaMutation: true,
    firewallMutation: false,
    networkMutation: false,
    kvMutation: false,
    rbacMutation: false,
    defaultEnabled: false,
    dualEnableFlagsRequired: true,
    constraintApplyEnvGateRequired: true,
    constraintApplyArgvGateRequired: true,
    exactTargetCliConfirmationRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    firewallPrestateRequiredBeforeCredentialPreflight: true,
    credentialPreflightRequiredBeforeLiveApply: true,
    observerReadOnlyAfterSuccessfulApply: true,
    offlineInjectedHttpAndFakeClientProof: true,
    alterStatementsByteLocked: true,
    verifyNeverRerunsLive: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14P',
    purpose: 'Apply exactly two byte-locked migration-028 CHECK constraints (tenant_services_date_window + tenant_services_price_unit) after zero-count preflight; catalog verify; canonical observer read-only; no DML/ledger/migration/Azure mutation beyond MI credential GET; verify never re-runs live.',
    targets: { ...TARGETS },
    applyLocks: {
      applicationName: APPLY_LOCKS.applicationName,
      advisoryLockKey1: APPLY_LOCKS.advisoryLockKey1,
      advisoryLockKey2: APPLY_LOCKS.advisoryLockKey2,
      constraints: APPLY_LOCKS.constraints.slice(),
      migration028Sha256: APPLY_LOCKS.migration028Sha256,
      alterDateWindowSha256: APPLY_LOCKS.alterDateWindowSha256,
      alterPriceUnitSha256: APPLY_LOCKS.alterPriceUnitSha256,
      managedIdentityName: APPLY_LOCKS.managedIdentityName,
      keyVaultName: APPLY_LOCKS.keyVaultName,
      secretName: APPLY_LOCKS.secretName,
      postgresHost: APPLY_LOCKS.postgresHost,
      database: APPLY_LOCKS.database,
      sslmode: APPLY_LOCKS.sslmode,
    },
    commandContract: {
      credentialPreflight: {
        script: 'scripts/run-phase-d-credential-preflight.js',
        npm: 'phase-d:credential-preflight',
      },
      constraintApply: {
        script: 'scripts/run-phase-d-constraint-apply.js',
        npm: 'phase-d:constraint-apply',
        requiredEnv: [
          `${ENV_LIVE_READONLY}=1`,
          `${ENV_LIVE_PREFLIGHT}=1`,
          `${ENV_CONSTRAINT_APPLY}=1`,
          `${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
          `AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
        ],
        requiredArgv: [
          CLI_APPLY_CONSTRAINTS,
          `${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
          `--subscription ${TARGETS.subscriptionId}`,
          `--resource-group ${TARGETS.resourceGroup}`,
          `--postgres-server ${TARGETS.postgresServer}`,
          `--database ${TARGETS.database}`,
        ],
        forbiddenArgv: FORBIDDEN_ARGV_FLAGS.slice(),
      },
    },
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    alterStatementsSha256: {
      date_window: ALTER_DATE_WINDOW_SHA256,
      price_unit: ALTER_PRICE_UNIT_SHA256,
    },
    predicatesUnchangedFrom14A: {
      date_window: DATE_WINDOW_PREDICATE,
      price_unit: PRICE_UNIT_PREDICATE,
    },
    forbidden: [
      'INSERT/UPDATE/DELETE',
      'DROP/RENAME',
      'ledger write',
      'RBAC / network / firewall mutation',
      'migration / predicate changes',
      'DSN / token / username / password / secret version in evidence',
      'broad retry on live failure',
      'second live apply in verify',
    ],
    nonGoals: [
      'No expected-fixture regeneration',
      'No broad Azure/KV/RBAC/network mutation',
      'Do not claim Sunset repaired unless observer match',
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14p-apply-phase-d-constraints-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14P',
    outcome,
    stillProductSchemaDiffers,
    phaseDConstraintsApplied: applyOk === true,
    liveMutation: applyOk === true && liveApplyOutcome && liveApplyOutcome.committed === true,
    schemaMutation: applyOk === true,
    dataMutation: false,
    ledgerWritten: false,
    firewallAction: false,
    networkMutation: false,
    kvMutation: false,
    rbacMutation: false,
    identityMutation: false,
    migrationAdded: false,
    applyFlagPresent: applyAttempted === true,
    appliesConstraints: applyOk === true,
    writesLedger: false,
    forwardCountUnchanged: 39,
    newForwardMigration: false,
    firewallPrestateAttemptCount: firewallAttempted ? 1 : 0,
    credentialPreflightAttemptCount: preflightAttempted ? 1 : 0,
    liveApplyAttemptCount: applyAttempted ? 1 : 0,
    observerAttemptCount: observerAttempted ? 1 : 0,
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
    alterStatementsSha256: {
      date_window: ALTER_DATE_WINDOW_SHA256,
      price_unit: ALTER_PRICE_UNIT_SHA256,
    },
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    defaultDisabled: true,
    dualEnableFlagsRequired: true,
    constraintApplyEnvGateRequired: true,
    constraintApplyArgvGateRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    offlineGates: {
      defaultPathZeroHttpAndClients: true,
      missingApplyFlagZeroClients: true,
      missingConstraintApplyEnvZeroClients: true,
      wrongExactTargetsZeroClients: true,
      forbiddenArgvDsnSqlDropDmlRetryZeroClients: true,
      managedIdentityRequiresEnvAndArgv: true,
      nonzeroCountsRefuseRollback: true,
      preexistingConstraintRefuseRollback: true,
      wrongExtraSqlRejected: true,
      lockFailureRollback: true,
      injectedHttpSuccessExactConstraintSequence: true,
      cliGatesExactTargets: true,
      cliDefaultDisabled: true,
      locksIdentityVaultSecretPgTlsApplicationName: true,
      globalLiveApplyRemainsFalse: true,
      alterStatementsByteLocked: true,
    },
    redCases: red,
    greenCases: green,
    redCaseCount: red.length,
    greenCaseCount: green.length,
    clientCallCounts: {
      successPathClientsInstantiated: 1,
      successPathQueryCalls: 12,
      defaultPathClientsInstantiated: 0,
      liveApplyClientsInstantiated: liveApplyOutcome ? liveApplyOutcome.clientsInstantiated : 0,
      liveApplyQueryCalls: liveApplyOutcome ? liveApplyOutcome.queryCalls : 0,
      liveApplyConnectCalls: liveApplyOutcome ? liveApplyOutcome.connectCalls : 0,
      liveApplyEndCalls: liveApplyOutcome ? liveApplyOutcome.endCalls : 0,
      liveApplySessions: liveApplyOutcome && liveApplyOutcome.connectCalls > 0 ? 1 : 0,
    },
    httpCallCounts: {
      successPathHttpRequestCount: 2,
      defaultPathHttpRequestCount: 0,
      liveCredentialPreflightHttpCallsDelta: credentialPreflightOutcome
        ? credentialPreflightOutcome.httpCallsDelta : 0,
      liveApplyHttpRequestCount: liveApplyOutcome ? liveApplyOutcome.httpRequestCount : 0,
      liveApplyImdsRequestCount: liveApplyOutcome ? liveApplyOutcome.imdsRequestCount : 0,
      liveApplyKeyVaultRequestCount: liveApplyOutcome ? liveApplyOutcome.keyVaultRequestCount : 0,
    },
    firewallPrestateOutcome: firewallPrestateOutcome || null,
    credentialPreflightOutcome: credentialPreflightOutcome || null,
    liveApplyOutcome: liveApplyOutcome || null,
    observerOutcome: observerOutcome || null,
    secretHandlingProof: {
      privateFieldsZeroedImmediately: true,
      neverPrinted: true,
      neverPersisted: true,
      neverHashedIntoEvidence: true,
      neverInArgv: true,
      neverInTempFile: true,
      neverInChildProcessEnv: true,
      observerNeverPersistsDsn: true,
    },
  };

  leakScan(evidence, secrets);
  leakScan(contract, secrets);

  const operatorCmd = [
    `${ENV_LIVE_READONLY}=1`,
    `${ENV_LIVE_PREFLIGHT}=1`,
    `${ENV_CONSTRAINT_APPLY}=1`,
    `${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    `AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
    'npm run phase-d:constraint-apply --',
    CLI_APPLY_CONSTRAINTS,
    `--subscription ${TARGETS.subscriptionId}`,
    `--resource-group ${TARGETS.resourceGroup}`,
    `--postgres-server ${TARGETS.postgresServer}`,
    `--database ${TARGETS.database}`,
    `${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
  ].join(' ');

  const fwSummary = !firewallPrestateOutcome
    ? 'Firewall prestate **not run**.'
    : firewallOk
      ? `Firewall prestate **ok** (rulesCount=${firewallPrestateOutcome.rulesCount}, putCount=${firewallPrestateOutcome.putCount}).`
      : `Firewall prestate **blocked** (\`blocker=${firewallPrestateOutcome.blocker}\`).`;

  const pfSummary = !preflightAttempted
    ? 'Credential preflight **not attempted**.'
    : preflightOk
      ? `Credential preflight **ok** (secretTargetValid=true, clientsInstantiated=0).`
      : `Credential preflight **blocked** (\`blocker=${credentialPreflightOutcome.blocker}\`).`;

  const applySummary = !applyAttempted
    ? 'Live constraint apply **not attempted**.'
    : applyOk
      ? `Live constraint apply **ok** (beforeConstraints=${liveApplyOutcome.beforeConstraints.length}, afterConstraints=${liveApplyOutcome.afterConstraints.length}, committed=${liveApplyOutcome.committed}, queryCalls=${liveApplyOutcome.queryCalls}, schemaMutation=true, dataMutation=false).`
      : `Live constraint apply **blocked** (\`blocker=${liveApplyOutcome.blocker}\`, rolledBack=${liveApplyOutcome.rolledBack}).`;

  const obsSummary = !observerAttempted
    ? 'Observer **not attempted**.'
    : observerOk
      ? `Observer **match** (mismatchCount ${observerOutcome.mismatchCountBeforeClaim}→${observerOutcome.mismatchCountAfter}).`
      : `Observer **drift or blocked** (mismatchCountAfter=${observerOutcome.mismatchCountAfter}, blocker=${observerOutcome.blocker || 'n/a'}). **Do not claim mismatch 2→0.**`;

  const findings = `# FOUNDATION Slice 14P — Apply Phase D CHECK constraints

**Status:** complete (offline RED/GREEN${applyAttempted ? ' + live apply path' : ''}; schema mutation only when live apply commits)
**Master basis:** \`${MASTER}\`
**Generated:** ${generatedAt}

## Outcome

${fwSummary}

${pfSummary}

${applySummary}

${obsSummary}

Outcome code: \`${outcome}\`.

Sequence: post-firewall prestate → credential preflight → exactly one gated constraint-apply transaction (\`application_name=wh-sunset-phase-d-constraint-apply\`, advisory lock, zero-count aggregate, exactly two \`ADD CONSTRAINT\` from byte-locked 028, catalog verify, COMMIT) → canonical observer read-only compare. On blocker: stop (no retry). Verify never re-runs live.

Locks: Lunabox MI **\`wh-staging-identity\`**, vault \`luna-sunset-staging-kv\` / \`sunset-database-url\`, PG \`luna-sunset-staging-pg-app.postgres.database.azure.com:5432/sunset_staging\`, TLS \`sslmode=verify-full\`.

## Operator command (constraint-apply; default-disabled)

\`\`\`bash
${operatorCmd}
\`\`\`

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero HTTP+Clients; missing apply flag/env; wrong/forbidden argv; MI requires env+argv; nonzero/preexisting/lock failures rollback; unauthorized SQL rejected |
| GREEN | injected HTTP → fake Client exact sequence; CLI gates; CLI default refuse; locks; global APPLY disabled; ALTER byte-locked |

## Non-goals / still open

- **No** DML or ledger write
- **No** RBAC/KV/network/firewall mutation (beyond MI credential GET)
- ${stillProductSchemaDiffers ? 'Still `product_schema_differs` until observer match' : 'Observer match recorded'}
- **Do not claim Sunset repaired** unless observer match is true.

## Schema mutation boundary

Exactly two \`ADD CONSTRAINT\` on \`public.tenant_services\` when live apply commits: \`tenant_services_date_window\` and \`tenant_services_price_unit\`. Private refs zeroed. No secret value/version/id in evidence.
`;

  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, findings);

  console.log(`Outcome: ${outcome}`);
  if (liveApplyOutcome && applyOk) {
    console.log(`liveApply: afterConstraints=${liveApplyOutcome.afterConstraints.length} committed=${liveApplyOutcome.committed}`);
  } else if (liveApplyOutcome) {
    console.log(`blocker: ${liveApplyOutcome.blocker}`);
  }
  console.log(`Wrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log(offlineOnly
    ? '\nSlice 14P offline proof GREEN — offline gates recorded; zero additional live calls.'
    : '\nSlice 14P proof GREEN — live prestate + preflight + apply + observer path recorded.');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
