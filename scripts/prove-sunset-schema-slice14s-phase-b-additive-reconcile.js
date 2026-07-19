'use strict';

/**
 * prove-sunset-schema-slice14s-phase-b-additive-reconcile — FOUNDATION Slice 14S
 *
 * Offline RED/GREEN → optional --live path:
 *   active-db-target-authority (sameTarget) → firewall prestate → credential
 *   preflight → one gated Phase B additive CREATE TABLE → canonical observer.
 * Default offline; preserves historical live evidence when present.
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
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  EXPECTED_028_SHA256,
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
  exactCredentialPreflightArgv,
  credentialPreflightEnv,
  CREDENTIAL_PREFLIGHT_LOCKS,
} = require('./lib/phase-d-credential-preflight');
const {
  PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED,
  FIREWALL_LOCKS,
  executeLunaboxPgFirewallPrestateVerify,
} = require('./lib/phase-d-lunabox-pg-firewall-apply');
const {
  executeActiveDbTargetAuthority,
  exactTargetAuthorityArgv,
  targetAuthorityEnv,
} = require('./lib/phase-d-active-db-target-authority');
const {
  PHASE_D_PHASE_B_ADDITIVE_LIVE_ENABLED,
  ENV_PHASE_B_ADDITIVE,
  CLI_APPLY_PHASE_B_ADDITIVE,
  AUTHORIZED_SEQUENCE,
  APPLY_LOCKS,
  CREATE_TABLE_SQL,
  CREATE_TABLE_SHA256,
  EXPECTED_035_SHA256,
  FORBIDDEN_ARGV_FLAGS,
  FORBIDDEN_INDEX_NAME,
  FORBIDDEN_CREATE_INDEX_SQL,
  LOCKED_14R_PHASE_B_TABLES,
  LOCKED_14R_PHASE_B_COLUMNS,
  evaluatePhaseBAdditiveGates,
  executePhaseBAdditiveReconcile,
  createScriptedPhaseBFakeClientFactory,
  buildMatching14RPreflight,
  resetPhaseBAdditiveCounters,
  getPhaseBAdditiveCounters,
  exactPhaseBAdditiveArgv,
  phaseBAdditiveEnv,
  assertCreateTableByteLocked,
  authorizeApplySql,
  derivePhaseBAdditiveSet,
} = require('./lib/phase-d-phase-b-additive-reconcile');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14s-phase-b-additive-reconcile-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14s-phase-b-additive-reconcile-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14s-findings.md');
const APPLY_CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-phase-b-additive-reconcile.js');
const PREFLIGHT_CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-credential-preflight.js');

const MASTER = '691025bd4e92ee6d0ea5a6cd214ea10e92ca7d4e';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';
const MISMATCH_BEFORE_CLAIM = 499;

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': EXPECTED_035_SHA256,
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const FAKE_ADMIN_USER = 'slice14s-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14s-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14s-proof-imds-token-never-commit';

function validSecretValue() {
  return buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
}

function applyArgv(extraFlags) {
  return [
    ...exactPhaseBAdditiveArgv(),
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
  if (/Bearer\s+slice14s-proof-imds-token/i.test(text)) {
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
    code: String((e && e.code) || 'phase_b_failed').slice(0, 80),
    message: String((e && e.message) || 'phase b failed')
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
    httpRequestCount: Number(result.httpRequestCount) || 0,
    putCount: Number(result.putCount) || 0,
    usedLiveHttp: result.usedLiveHttp === true,
    liveMutation: false,
    networkMutation: false,
    firewallAction: false,
    postgresServer: FIREWALL_LOCKS.postgresServer,
    errors: sanitizeErrors(result.errors),
    blocker: result.ok === true ? null : String(result.code || 'firewall_prestate_failed'),
  };
}

function pickSafeAuthority(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    ok: result.ok === true,
    code: String(result.code || 'target_authority_unknown'),
    sameTarget: result.sameTarget === true,
    sameTargetReason: result.sameTargetReason || null,
    activeRevisionName: result.activeRevisionName || null,
    dbEnvName: result.dbEnvName || null,
    secretRefName: result.secretRefName || null,
    blocker: result.ok === true && result.sameTarget === true
      ? null
      : String(result.blocker || result.code || 'target_authority_failed'),
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
    clientsInstantiated: Number(p.clientsInstantiated) || 0,
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
      message: 'phase-b-additive CLI stdout/stderr did not contain parseable JSON',
    });
  }
  const code = String(p.code || (ok ? 'phase_b_additive_reconcile_ok' : 'phase_b_additive_failed'));
  const blocker = ok ? null : String(code || (errors[0] && errors[0].code) || 'phase_b_additive_failed');
  return {
    attempt: 1,
    ok,
    code,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    beforeAdditive: p.beforeAdditive || null,
    afterAdditive: p.afterAdditive || null,
    derivedPhaseBSet: p.derivedPhaseBSet || null,
    rowCountPreservation: p.rowCountPreservation || null,
    createTableSha256: p.createTableSha256 || null,
    migration035Sha256: p.migration035Sha256 || null,
    steps: Array.isArray(p.steps) ? p.steps.slice() : [],
    committed: p.committed === true,
    rolledBack: p.rolledBack === true,
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
    indexAbsent: p.indexAbsent === true,
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
        mismatchSections: null,
        productFingerprintLive: null,
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
        productFingerprintLive,
        blocker: cmp.normalizationError.code || 'normalization_failed',
      };
    }
    const mismatchCount = Array.isArray(cmp.drifts) ? cmp.drifts.length : (
      (cmp.counts.expected_only || 0)
      + (cmp.counts.live_only || 0)
      + (cmp.counts.definition_mismatch || 0)
    );
    const mismatchSections = {};
    for (const d of cmp.drifts || []) {
      const s = String(d.section || 'unknown');
      mismatchSections[s] = (mismatchSections[s] || 0) + 1;
    }
    const phaseBKeys = [
      'customer_message_templates',
      ...LOCKED_14R_PHASE_B_COLUMNS,
    ];
    const phaseBDrifts = (cmp.drifts || []).filter((d) =>
      d.kind === 'expected_only'
      && (d.section === 'tables' || d.section === 'columns')
      && phaseBKeys.includes(String(d.key)));
    const derived = derivePhaseBAdditiveSet(cmp);
    return {
      ok: cmp.ok === true,
      match: cmp.ok === true,
      code: cmp.ok === true ? 'observer_match' : 'observer_drift',
      mismatchCount,
      counts: cmp.counts,
      mismatchSections,
      phaseBTableColumnKeysCleared: phaseBDrifts.length === 0,
      derivedPhaseBSetAfter: derived,
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
    || process.env.SUNSET_SLICE14S_PROOF_OFFLINE === '1';
  console.log(offlineOnly
    ? 'prove:sunset-schema-slice14s — offline only (no live HTTP/PG apply/observer)\n'
    : 'prove:sunset-schema-slice14s — offline then live authority + prestate + preflight + apply + observer\n');

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
  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true) {
    throw new Error('CONNECT_ENABLED must remain activated');
  }
  if (PHASE_D_LIVE_APPLY_ENABLED !== false) {
    throw new Error('global APPLY must remain disabled');
  }
  if (PHASE_D_PHASE_B_ADDITIVE_LIVE_ENABLED !== true) {
    throw new Error('phase B additive capability must be enabled');
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

  const createLock = assertCreateTableByteLocked();
  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN, validSecretValue()];
  const red = [];
  const green = [];

  // --- RED ---
  resetPhaseBAdditiveCounters();
  resetManagedIdentityHttpCounters();
  const def = await executePhaseBAdditiveReconcile({ env: {}, argv: [] });
  if (getPhaseBAdditiveCounters().clientsInstantiated !== 0
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

  resetPhaseBAdditiveCounters();
  resetManagedIdentityHttpCounters();
  const noApplyFlag = await executePhaseBAdditiveReconcile({
    env: phaseBAdditiveEnv(),
    argv: applyArgv().filter((a) => a !== CLI_APPLY_PHASE_B_ADDITIVE),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (getPhaseBAdditiveCounters().clientsInstantiated !== 0
    || getManagedIdentityHttpCounters().httpRequestCount !== 0) {
    throw new Error('missing apply flag must zero Clients/HTTP');
  }
  red.push({
    name: 'missing_apply_flag_zero_clients',
    ok: true,
    code: noApplyFlag.code,
    clientsInstantiated: 0,
  });

  resetPhaseBAdditiveCounters();
  resetManagedIdentityHttpCounters();
  const noEnv = await executePhaseBAdditiveReconcile({
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
  if (getPhaseBAdditiveCounters().clientsInstantiated !== 0) {
    throw new Error('missing phase B env must zero Clients');
  }
  red.push({
    name: 'missing_phase_b_env_zero_clients',
    ok: true,
    code: noEnv.code,
    clientsInstantiated: 0,
  });

  const wrongDb = evaluatePhaseBAdditiveGates({
    env: phaseBAdditiveEnv(),
    argv: applyArgv().map((a, i, arr) => (arr[i - 1] === '--database' ? 'evil_db' : a)),
  });
  if (wrongDb.ok) throw new Error('wrong database must fail');
  resetPhaseBAdditiveCounters();
  const wrongRun = await executePhaseBAdditiveReconcile({
    env: phaseBAdditiveEnv(),
    argv: applyArgv().map((a, i, arr) => (arr[i - 1] === '--database' ? 'evil_db' : a)),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (getPhaseBAdditiveCounters().clientsInstantiated !== 0) {
    throw new Error('wrong targets must zero Clients');
  }
  red.push({
    name: 'wrong_exact_targets_zero_clients',
    ok: true,
    rejected: !wrongDb.ok,
    code: wrongRun.code,
    clientsInstantiated: 0,
  });

  const forbidden = evaluatePhaseBAdditiveGates({
    env: phaseBAdditiveEnv(),
    argv: [
      ...applyArgv(),
      '--dsn', 'forbidden-dsn-value',
      '--sql', 'DROP TABLE public.customer_message_templates',
      '--drop',
      '--dml',
      '--retry',
    ],
  });
  if (forbidden.ok) throw new Error('forbidden argv must fail');
  resetPhaseBAdditiveCounters();
  const forbiddenRun = await executePhaseBAdditiveReconcile({
    env: phaseBAdditiveEnv(),
    argv: [
      ...applyArgv(),
      '--dsn', 'forbidden-dsn-value',
      '--sql', 'DELETE FROM public.clients',
      '--drop',
      '--dml',
      '--retry',
    ],
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (getPhaseBAdditiveCounters().clientsInstantiated !== 0) {
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

  const halfFlag = evaluatePhaseBAdditiveGates({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_PHASE_B_ADDITIVE]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    },
    argv: exactPhaseBAdditiveArgv(),
  });
  if (halfFlag.ok) throw new Error('MI without env credential-source must fail');
  red.push({
    name: 'managed_identity_requires_env_and_argv',
    ok: true,
    rejected: !halfFlag.ok,
  });

  resetPhaseBAdditiveCounters();
  const FakeDrift = createScriptedPhaseBFakeClientFactory({});
  const setDrift = await executePhaseBAdditiveReconcile({
    env: phaseBAdditiveEnv(),
    argv: applyArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
    Client: FakeDrift,
    injectedPreflight: buildMatching14RPreflight({
      derived: {
        tables: ['customer_message_templates', 'extra_evil_table'],
        columns: LOCKED_14R_PHASE_B_COLUMNS.slice(),
        matches14R: false,
      },
    }),
  });
  if (setDrift.ok || setDrift.schemaMutation === true || setDrift.code !== 'phase_b_set_drift') {
    throw new Error(`set drift must refuse: ${JSON.stringify(setDrift)}`);
  }
  red.push({
    name: 'set_drift_from_14r_refuse',
    ok: true,
    code: setDrift.code,
    schemaMutation: false,
  });

  resetPhaseBAdditiveCounters();
  const FakeUnsafe = createScriptedPhaseBFakeClientFactory({});
  const unsafeNn = await executePhaseBAdditiveReconcile({
    env: phaseBAdditiveEnv(),
    argv: applyArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
    Client: FakeUnsafe,
    injectedPreflight: buildMatching14RPreflight({
      unsafeNonemptyNotNull: true,
    }),
  });
  if (unsafeNn.ok || unsafeNn.schemaMutation === true) {
    throw new Error(`unsafe nonempty NOT NULL must refuse: ${JSON.stringify(unsafeNn)}`);
  }
  red.push({
    name: 'unsafe_nonempty_not_null_refuse',
    ok: true,
    code: unsafeNn.code,
    schemaMutation: false,
  });

  resetPhaseBAdditiveCounters();
  const FakeIncompat = createScriptedPhaseBFakeClientFactory({});
  const incompat = await executePhaseBAdditiveReconcile({
    env: phaseBAdditiveEnv(),
    argv: applyArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
    Client: FakeIncompat,
    injectedPreflight: buildMatching14RPreflight({
      cmtRelkind: 'v',
      cmtTableExists: false,
    }),
  });
  if (incompat.ok || incompat.schemaMutation === true) {
    throw new Error(`incompatible same-name must refuse: ${JSON.stringify(incompat)}`);
  }
  red.push({
    name: 'incompatible_same_name_object_refuse',
    ok: true,
    code: incompat.code,
    schemaMutation: false,
  });

  const rejectedSql = [];
  for (const sql of [
    'DROP TABLE public.customer_message_templates',
    'DELETE FROM public.clients',
    'INSERT INTO public.clients (id) VALUES (gen_random_uuid())',
    FORBIDDEN_CREATE_INDEX_SQL,
    'COMMENT ON TABLE customer_message_templates IS \'x\'',
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
    name: 'extra_sql_rejected',
    ok: true,
    rejectedStatements: rejectedSql,
  });
  red.push({
    name: 'dml_or_drop_rejected',
    ok: true,
    rejectedStatements: rejectedSql.filter((s) =>
      /^(DROP|DELETE|INSERT)/i.test(s)),
  });

  resetPhaseBAdditiveCounters();
  const FakePartial = createScriptedPhaseBFakeClientFactory({
    queryErrorAt: {
      'CREATE TABLE customer_message_templates': Object.assign(
        new Error('simulated create failure'),
        { code: 'query_failed' },
      ),
    },
  });
  const partial = await executePhaseBAdditiveReconcile({
    env: phaseBAdditiveEnv(),
    argv: applyArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
    Client: FakePartial,
    injectedPreflight: buildMatching14RPreflight(),
  });
  if (partial.ok || partial.rolledBack !== true || partial.steps.includes('COMMIT')) {
    throw new Error(`partial failure must rollback: ${JSON.stringify(partial)}`);
  }
  red.push({
    name: 'partial_failure_rollback',
    ok: true,
    code: partial.code,
    rolledBack: true,
    noCommit: !partial.steps.includes('COMMIT'),
  });

  resetPhaseBAdditiveCounters();
  const FakeWrongOrder = createScriptedPhaseBFakeClientFactory({
    expectedSteps: [
      'BEGIN',
      'CREATE TABLE customer_message_templates', // wrong order vs authorized
    ],
    strictSequence: true,
  });
  const wrongOrder = await executePhaseBAdditiveReconcile({
    env: phaseBAdditiveEnv(),
    argv: applyArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
    Client: FakeWrongOrder,
    injectedPreflight: buildMatching14RPreflight(),
  });
  if (wrongOrder.ok || wrongOrder.schemaMutation === true) {
    throw new Error(`wrong order must fail: ${JSON.stringify(wrongOrder)}`);
  }
  const wrongGates = evaluatePhaseBAdditiveGates({ env: {}, argv: [] });
  if (wrongGates.ok) throw new Error('empty gates must fail');
  red.push({
    name: 'wrong_order_or_gates',
    ok: true,
    wrongOrderCode: wrongOrder.code,
    gatesRejected: !wrongGates.ok,
    schemaMutation: false,
  });

  // --- GREEN ---
  resetPhaseBAdditiveCounters();
  resetManagedIdentityHttpCounters();
  const httpOk = createInjectedManagedIdentityHttp({
    imdsAccessToken: FAKE_IMDS_TOKEN,
    defaultSecretValue: validSecretValue(),
  });
  const FakeOk = createScriptedPhaseBFakeClientFactory({});
  const okRun = await executePhaseBAdditiveReconcile({
    env: phaseBAdditiveEnv(),
    argv: applyArgv(),
    httpRequest: httpOk,
    Client: FakeOk,
    injectedPreflight: buildMatching14RPreflight(),
  });
  leakScan(okRun, secrets);
  if (!okRun.ok
    || JSON.stringify(okRun.steps) !== JSON.stringify(AUTHORIZED_SEQUENCE)
    || okRun.queryCalls !== 14
    || okRun.clientsInstantiated !== 1
    || okRun.httpRequestCount !== 2
    || okRun.dataMutation !== false
    || okRun.ledgerWritten !== false
    || okRun.schemaMutation !== true
    || okRun.createTableSha256 !== CREATE_TABLE_SHA256
    || okRun.indexAbsent !== true) {
    throw new Error(`GREEN injected sequence failed: ${JSON.stringify(okRun)}`);
  }
  green.push({
    name: 'injected_http_success_exact_create_table_sequence',
    ok: true,
    steps: okRun.steps,
    queryCalls: 14,
    clientsInstantiated: 1,
    httpRequestCount: 2,
    schemaMutation: true,
    dataMutation: false,
    ledgerWritten: false,
    createTableSha256: okRun.createTableSha256,
  });

  const gatesOk = evaluatePhaseBAdditiveGates({
    env: phaseBAdditiveEnv(),
    argv: exactPhaseBAdditiveArgv(),
  });
  if (!gatesOk.ok) {
    throw new Error(`CLI gates should pass: ${JSON.stringify(gatesOk.errors)}`);
  }
  green.push({
    name: 'cli_gates_exact_targets',
    ok: true,
    applyPhaseBAdditive: gatesOk.applyPhaseBAdditive === true,
  });

  const cliDefault = spawnSync(process.execPath, [APPLY_CLI_PATH], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (cliDefault.status === 0) throw new Error('phase-b-additive CLI default must refuse');
  leakScan(`${cliDefault.stdout}${cliDefault.stderr}`, secrets);
  green.push({
    name: 'cli_default_disabled',
    ok: true,
    exitCode: cliDefault.status,
  });

  if (APPLY_LOCKS.applicationName !== 'wh-sunset-phase-b-additive'
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
    phaseBAdditiveLiveEnabled: true,
  });

  green.push({
    name: 'create_table_byte_locked_to_035',
    ok: true,
    createTableSha256: createLock.createTableSha256,
    migration035Sha256: createLock.migration035Sha256CanonicalLfV1,
  });

  const lockedSet = derivePhaseBAdditiveSet({
    drifts: [
      { kind: 'expected_only', section: 'tables', key: 'customer_message_templates' },
      ...LOCKED_14R_PHASE_B_COLUMNS.map((key) => ({
        kind: 'expected_only', section: 'columns', key,
      })),
    ],
  });
  if (!lockedSet.matches14R) throw new Error('14R phase B set lock failed');
  green.push({
    name: 'phase_b_set_locked_to_14r',
    ok: true,
    tables: LOCKED_14R_PHASE_B_TABLES.slice(),
    columns: LOCKED_14R_PHASE_B_COLUMNS.slice(),
  });

  let indexInAuthorized = false;
  try {
    authorizeApplySql(FORBIDDEN_CREATE_INDEX_SQL);
    indexInAuthorized = true;
  } catch (e) {
    if (e.code !== 'unauthorized_sql') throw e;
  }
  if (indexInAuthorized) throw new Error('CREATE INDEX must not be authorized');
  if (CREATE_TABLE_SQL.includes('CREATE INDEX') || CREATE_TABLE_SQL.includes(FORBIDDEN_INDEX_NAME)) {
    throw new Error('CREATE TABLE must not include index');
  }
  green.push({
    name: 'no_separate_index_in_authorized_sql',
    ok: true,
    forbiddenIndexName: FORBIDDEN_INDEX_NAME,
  });

  // --- LIVE or preserve ---
  let targetAuthorityOutcome = null;
  let firewallPrestateOutcome;
  let credentialPreflightOutcome;
  let liveApplyOutcome = null;
  let observerOutcome = null;
  let applyAttempted = false;
  let preflightAttempted = false;
  let firewallAttempted = false;
  let authorityAttempted = false;
  let observerAttempted = false;

  if (offlineOnly) {
    if (preserveLive) {
      targetAuthorityOutcome = priorEvidence.targetAuthorityOutcome || null;
      firewallPrestateOutcome = priorEvidence.firewallPrestateOutcome;
      credentialPreflightOutcome = priorEvidence.credentialPreflightOutcome || null;
      liveApplyOutcome = priorEvidence.liveApplyOutcome;
      observerOutcome = priorEvidence.observerOutcome || null;
      applyAttempted = priorEvidence.liveApplyAttemptCount === 1;
      preflightAttempted = priorEvidence.credentialPreflightAttemptCount === 1;
      firewallAttempted = priorEvidence.firewallPrestateAttemptCount === 1;
      authorityAttempted = priorEvidence.targetAuthorityAttemptCount === 1;
      observerAttempted = priorEvidence.observerAttemptCount === 1;
      console.log('Offline mode: preserved historical live apply/observer outcomes.\n');
    } else {
      targetAuthorityOutcome = priorEvidence && priorEvidence.targetAuthorityOutcome
        ? priorEvidence.targetAuthorityOutcome
        : null;
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
    console.log('Live section 1/5: active DB target authority (require sameTarget)…\n');
    authorityAttempted = true;
    const authResult = await executeActiveDbTargetAuthority({
      env: { ...process.env, ...targetAuthorityEnv() },
      argv: exactTargetAuthorityArgv(),
      expectedContract: expected,
    });
    leakScan(authResult, secrets);
    targetAuthorityOutcome = pickSafeAuthority(authResult);
    leakScan(targetAuthorityOutcome, secrets);

    if (targetAuthorityOutcome.sameTarget !== true) {
      console.log(
        `Target authority sameTarget=false (${targetAuthorityOutcome.blocker}) — skipping firewall/apply/observer.\n`,
      );
    } else {
      console.log('Live section 2/5: post-firewall prestate verify…\n');
      firewallAttempted = true;
      const livePrestate = await executeLunaboxPgFirewallPrestateVerify({});
      leakScan(livePrestate, secrets);
      firewallPrestateOutcome = pickSafeFirewallPrestate(livePrestate);
      leakScan(firewallPrestateOutcome, secrets);

      if (firewallPrestateOutcome.ok !== true) {
        console.log(
          `Firewall prestate blocked (${firewallPrestateOutcome.blocker}) — skipping preflight/apply/observer.\n`,
        );
      } else {
        console.log('Live section 3/5: one gated credential-preflight CLI spawn…\n');
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
          console.log('Live section 4/5: exactly one gated phase-b-additive CLI spawn…\n');
          applyAttempted = true;
          const liveApplyCli = spawnSync(
            process.execPath,
            [APPLY_CLI_PATH, ...exactPhaseBAdditiveArgv()],
            {
              encoding: 'utf8',
              env: { ...process.env, ...phaseBAdditiveEnv() },
            },
          );
          const applyCombined = `${liveApplyCli.stdout || ''}${liveApplyCli.stderr || ''}`;
          leakScan(applyCombined, secrets);
          const applyParsed = parseLastJsonObject(applyCombined);
          if (applyParsed) leakScan(applyParsed, secrets);
          liveApplyOutcome = buildApplyLiveOutcome(applyParsed, liveApplyCli.status);
          leakScan(liveApplyOutcome, secrets);

          if (liveApplyOutcome.ok === true) {
            console.log('Live section 5/5: canonical observer read-only compare…\n');
            observerAttempted = true;
            const loaded = await loadProtectedAdminCredentialsViaManagedIdentity({
              env: phaseBAdditiveEnv(),
              argv: exactPhaseBAdditiveArgv(),
            });
            if (!loaded.ok) {
              observerOutcome = {
                ok: false,
                match: false,
                code: loaded.code || 'managed_identity_loader_failed',
                mismatchCount: null,
                mismatchCountBeforeClaim: MISMATCH_BEFORE_CLAIM,
                mismatchCountAfter: null,
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
                  mismatchCountBeforeClaim: MISMATCH_BEFORE_CLAIM,
                  mismatchCountAfter: obs.mismatchCount,
                  // Never claim full repair unless truly zero.
                  fullRepairClaimed: false,
                  observerMatchClaimed: obs.match === true && obs.mismatchCount === 0,
                  observed: true,
                };
              } catch (e) {
                observerOutcome = {
                  ok: false,
                  match: false,
                  code: (e && e.code) || 'observer_failed',
                  mismatchCount: null,
                  mismatchCountBeforeClaim: MISMATCH_BEFORE_CLAIM,
                  mismatchCountAfter: null,
                  fullRepairClaimed: false,
                  observerMatchClaimed: false,
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
              `Phase B additive blocked (${liveApplyOutcome.blocker}) — skipping observer.\n`,
            );
          }
        }
      }
    }
  }

  const authorityOk = targetAuthorityOutcome && targetAuthorityOutcome.sameTarget === true;
  const firewallOk = firewallPrestateOutcome && firewallPrestateOutcome.ok === true;
  const preflightOk = credentialPreflightOutcome && credentialPreflightOutcome.ok === true;
  const applyOk = liveApplyOutcome && liveApplyOutcome.ok === true;
  const observerOk = observerOutcome && observerOutcome.match === true;

  let outcome;
  if (offlineOnly && !applyAttempted && !preserveLive) {
    outcome = 'phase_b_additive_reconcile_offline_only';
  } else if (authorityAttempted && !authorityOk) {
    outcome = 'phase_b_additive_blocked_at_target_authority';
  } else if (!firewallOk && firewallAttempted) {
    outcome = 'phase_b_additive_blocked_at_firewall_prestate';
  } else if (!preflightAttempted && authorityOk) {
    outcome = 'phase_b_additive_blocked_before_credential_preflight';
  } else if (preflightAttempted && !preflightOk) {
    outcome = 'phase_b_additive_blocked_at_credential_preflight';
  } else if (!applyAttempted && preflightOk) {
    outcome = 'phase_b_additive_blocked_before_apply';
  } else if (applyAttempted && !applyOk) {
    outcome = 'phase_b_additive_blocked';
  } else if (applyOk && !observerAttempted) {
    outcome = 'phase_b_additive_ok_observer_skipped';
  } else if (observerOk) {
    outcome = 'phase_b_additive_ok_observer_match';
  } else if (applyOk) {
    outcome = 'phase_b_additive_ok_observer_drift';
  } else {
    outcome = 'phase_b_additive_reconcile_offline_only';
  }

  const stillProductSchemaDiffers = observerOk !== true;

  const contract = {
    kind: 'sunset-schema-observer-slice14s-phase-b-additive-reconcile-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: true,
    liveApplyCapability: true,
    phaseBAdditiveLiveEnabled: true,
    globalLiveApplyEnabled: false,
    liveReadonlyConnectEnabled: true,
    liveHttpEnabled: true,
    appliesPhaseBAdditive: true,
    writesLedger: false,
    dataMutation: false,
    mutates: true,
    schemaMutation: true,
    createIndex: false,
    commentOn: false,
    firewallMutation: false,
    networkMutation: false,
    kvMutation: false,
    rbacMutation: false,
    defaultEnabled: false,
    dualEnableFlagsRequired: true,
    phaseBAdditiveEnvGateRequired: true,
    phaseBAdditiveArgvGateRequired: true,
    exactTargetCliConfirmationRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    targetAuthorityRequiredBeforeLive: true,
    firewallPrestateRequiredBeforeCredentialPreflight: true,
    credentialPreflightRequiredBeforeLiveApply: true,
    observerReadOnlyAfterSuccessfulApply: true,
    offlineInjectedHttpAndFakeClientProof: true,
    createTableByteLocked: true,
    verifyNeverRerunsLive: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14S',
    purpose: 'Phase B additive only: create missing public.customer_message_templates from byte-locked migration 035 CREATE TABLE (9 columns); no CREATE INDEX/COMMENT/DML/ledger/Phase C–G; verify never re-runs live.',
    targets: { ...TARGETS },
    applyLocks: {
      applicationName: APPLY_LOCKS.applicationName,
      advisoryLockKey1: APPLY_LOCKS.advisoryLockKey1,
      advisoryLockKey2: APPLY_LOCKS.advisoryLockKey2,
      createTableSha256: APPLY_LOCKS.createTableSha256,
      migration035Sha256: APPLY_LOCKS.migration035Sha256,
      forbiddenIndexName: APPLY_LOCKS.forbiddenIndexName,
      lockedPhaseBTables: APPLY_LOCKS.lockedPhaseBTables.slice(),
      lockedPhaseBColumns: APPLY_LOCKS.lockedPhaseBColumns.slice(),
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
      phaseBAdditive: {
        script: 'scripts/run-phase-d-phase-b-additive-reconcile.js',
        npm: 'phase-d:phase-b-additive-reconcile',
        requiredEnv: [
          `${ENV_LIVE_READONLY}=1`,
          `${ENV_LIVE_PREFLIGHT}=1`,
          `${ENV_PHASE_B_ADDITIVE}=1`,
          `${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
          `AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
        ],
        requiredArgv: [
          CLI_APPLY_PHASE_B_ADDITIVE,
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
    createTableSha256: CREATE_TABLE_SHA256,
    mismatchCountBeforeClaim: MISMATCH_BEFORE_CLAIM,
    forbidden: [
      'INSERT/UPDATE/DELETE',
      'DROP/RENAME',
      'CREATE INDEX',
      'COMMENT',
      'ledger write',
      'RBAC / network / firewall mutation',
      'migration file changes',
      'DSN / token / username / password / secret version in evidence',
      'broad retry on live failure',
      'second live apply in verify',
      'claim Sunset fully repaired',
    ],
    nonGoals: [
      'No Phase C–G',
      'No expected-fixture regeneration',
      'No broad Azure/KV/RBAC/network mutation',
      'Do not claim Sunset repaired unless observer match (zero drift)',
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14s-phase-b-additive-reconcile-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14S',
    outcome,
    stillProductSchemaDiffers,
    phaseBAdditiveApplied: applyOk === true,
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
    createIndex: false,
    commentOn: false,
    applyFlagPresent: applyAttempted === true,
    writesLedger: false,
    forwardCountUnchanged: 39,
    newForwardMigration: false,
    targetAuthorityAttemptCount: authorityAttempted ? 1 : 0,
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
    createTableSha256: CREATE_TABLE_SHA256,
    migration035Sha256CanonicalLfV1: live035,
    mismatchCountBeforeClaim: MISMATCH_BEFORE_CLAIM,
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    defaultDisabled: true,
    dualEnableFlagsRequired: true,
    phaseBAdditiveEnvGateRequired: true,
    phaseBAdditiveArgvGateRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    offlineGates: {
      defaultPathZeroHttpAndClients: true,
      missingApplyFlagZeroClients: true,
      missingPhaseBEnvZeroClients: true,
      wrongExactTargetsZeroClients: true,
      forbiddenArgvDsnSqlDropDmlRetryZeroClients: true,
      managedIdentityRequiresEnvAndArgv: true,
      setDriftFrom14rRefuse: true,
      unsafeNonemptyNotNullRefuse: true,
      incompatibleSameNameObjectRefuse: true,
      extraSqlRejected: true,
      dmlOrDropRejected: true,
      partialFailureRollback: true,
      wrongOrderOrGates: true,
      injectedHttpSuccessExactCreateTableSequence: true,
      cliGatesExactTargets: true,
      cliDefaultDisabled: true,
      locksIdentityVaultSecretPgTlsApplicationName: true,
      globalLiveApplyRemainsFalse: true,
      createTableByteLockedTo035: true,
      phaseBSetLockedTo14r: true,
      noSeparateIndexInAuthorizedSql: true,
    },
    redCases: red,
    greenCases: green,
    redCaseCount: red.length,
    greenCaseCount: green.length,
    clientCallCounts: {
      successPathClientsInstantiated: 1,
      successPathQueryCalls: 14,
      defaultPathClientsInstantiated: 0,
      liveApplyClientsInstantiated: liveApplyOutcome ? liveApplyOutcome.clientsInstantiated : 0,
      liveApplyQueryCalls: liveApplyOutcome ? liveApplyOutcome.queryCalls : 0,
    },
    httpCallCounts: {
      successPathHttpRequestCount: 2,
      defaultPathHttpRequestCount: 0,
      liveApplyHttpRequestCount: liveApplyOutcome ? liveApplyOutcome.httpRequestCount : 0,
    },
    targetAuthorityOutcome: targetAuthorityOutcome || null,
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
    `${ENV_PHASE_B_ADDITIVE}=1`,
    `${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    `AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
    'npm run phase-d:phase-b-additive-reconcile --',
    CLI_APPLY_PHASE_B_ADDITIVE,
    `--subscription ${TARGETS.subscriptionId}`,
    `--resource-group ${TARGETS.resourceGroup}`,
    `--postgres-server ${TARGETS.postgresServer}`,
    `--database ${TARGETS.database}`,
    `${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
  ].join(' ');

  const authSummary = !targetAuthorityOutcome
    ? 'Target authority **not run**.'
    : authorityOk
      ? `Target authority **sameTarget=true**.`
      : `Target authority **blocked** (sameTarget=false, blocker=${targetAuthorityOutcome.blocker}).`;

  const fwSummary = !firewallPrestateOutcome
    ? 'Firewall prestate **not run**.'
    : firewallOk
      ? `Firewall prestate **ok**.`
      : `Firewall prestate **blocked** (\`blocker=${firewallPrestateOutcome.blocker}\`).`;

  const pfSummary = !preflightAttempted
    ? 'Credential preflight **not attempted**.'
    : preflightOk
      ? 'Credential preflight **ok**.'
      : `Credential preflight **blocked** (\`blocker=${credentialPreflightOutcome.blocker}\`).`;

  const applySummary = !applyAttempted
    ? 'Live Phase B additive **not attempted**.'
    : applyOk
      ? `Live Phase B additive **ok** (CREATE TABLE customer_message_templates, committed=${liveApplyOutcome.committed}, queryCalls=${liveApplyOutcome.queryCalls}, schemaMutation=true, dataMutation=false, indexAbsent=true).`
      : `Live Phase B additive **blocked** (\`blocker=${liveApplyOutcome.blocker}\`, rolledBack=${liveApplyOutcome.rolledBack}).`;

  const obsSummary = !observerAttempted
    ? 'Observer **not attempted**.'
    : observerOk
      ? `Observer **match** (mismatchCount ${observerOutcome.mismatchCountBeforeClaim}→${observerOutcome.mismatchCountAfter}).`
      : `Observer **drift or blocked** (mismatchCountBeforeClaim=${MISMATCH_BEFORE_CLAIM}, mismatchCountAfter=${observerOutcome && observerOutcome.mismatchCountAfter}, phaseBTableColumnKeysCleared=${observerOutcome && observerOutcome.phaseBTableColumnKeysCleared === true}). **Do not claim Sunset fully repaired.**`;

  const findings = `# FOUNDATION Slice 14S — Phase B additive reconcile

**Status:** ${offlineOnly && !applyAttempted ? 'offline RED/GREEN complete' : outcome}
**Master basis:** \`${MASTER}\`
**Outcome:** \`${outcome}\`

## What this slice does

Phase B **additive only** on Sunset staging: create missing
\`public.customer_message_templates\` from byte-locked migration 035
CREATE TABLE SQL (thereby adding its exact 9 columns).

- CREATE TABLE sha256: \`${CREATE_TABLE_SHA256}\`
- Migration 035 sha256: \`${EXPECTED_035_SHA256}\`
- application_name: \`wh-sunset-phase-b-additive\`
- Observer before claim mismatch total: **${MISMATCH_BEFORE_CLAIM}**

## Offline gates

- RED: ${red.length} cases
- GREEN: ${green.length} cases

## Live

${authSummary}
${fwSummary}
${pfSummary}
${applySummary}
${obsSummary}

Mutation flags: schemaMutation=${applyOk === true}; dataMutation=false; ledgerWritten=false.

## Do not claim

- Do **not** claim Sunset fully repaired unless observer mismatch is truly zero.
- Do **not** CREATE INDEX / COMMENT / Phase C–G in this slice.
- Do **not** run verify with \`--live\` (verify never re-runs live).
- Do **not** persist DSN, passwords, tokens, or secret versions.

## Operator apply command

\`\`\`
${operatorCmd}
\`\`\`

## Artifacts

- \`fixtures/sunset-schema-observer/slice14s-phase-b-additive-reconcile-evidence.json\`
- \`fixtures/sunset-schema-observer/slice14s-phase-b-additive-reconcile-contract.json\`
- \`fixtures/sunset-schema-observer/slice14s-findings.md\`
`;

  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, findings);

  leakScan(fs.readFileSync(EVIDENCE_PATH, 'utf8'), secrets);
  leakScan(fs.readFileSync(CONTRACT_PATH, 'utf8'), secrets);
  leakScan(fs.readFileSync(FINDINGS_PATH, 'utf8'), secrets);

  console.log(`Wrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log(`\noutcome=${outcome} red=${red.length} green=${green.length}`);
  console.log(offlineOnly
    ? '\nprove:sunset-schema-slice14s GREEN (offline)'
    : '\nprove:sunset-schema-slice14s GREEN (live path attempted)');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
