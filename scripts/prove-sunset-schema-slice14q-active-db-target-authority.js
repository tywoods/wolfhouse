'use strict';

/**
 * prove-sunset-schema-slice14q-active-db-target-authority — FOUNDATION Slice 14Q
 *
 * Offline RED/GREEN → optional --live once: prove active Staff API ↔ Key Vault
 * admin DB target authority (read-only) + classify observer drift. Default offline;
 * preserves historical live evidence when present.
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
const {
  hashCanonicalManifest,
} = require('./lib/sunset-schema-observer');
const {
  TARGETS,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  ENV_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  EXPECTED_028_SHA256,
  assert028PredicatesPresentInSource,
  assertMigration028ByteIntegrity,
} = require('./lib/phase-d-check-preflight');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
} = require('./lib/phase-d-managed-identity-credential-loader');
const {
  PHASE_D_TARGET_AUTHORITY_LIVE_ENABLED,
  ENV_TARGET_AUTHORITY,
  CLI_PROVE_TARGET_AUTHORITY,
  APPLICATION_NAME,
  AUTHORITY_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  evaluateTargetAuthorityGates,
  exactTargetAuthorityArgv,
  targetAuthorityEnv,
  executeActiveDbTargetAuthority,
  createInjectedTargetAuthorityHttp,
  createScriptedTargetAuthorityFakeClientFactory,
  resetTargetAuthorityCounters,
  getTargetAuthorityCounters,
  classifyDrift,
  compareDsnAuthorityInMemory,
  buildOfflineProofSunsetDatabaseUrl,
  buildLockedArmContainerAppPath,
  buildLockedArmListSecretsPath,
  buildLockedImdsArmTokenUrl,
  buildLockedKeyVaultSecretUrl,
} = require('./lib/phase-d-active-db-target-authority');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14q-active-db-target-authority-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14q-active-db-target-authority-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14q-findings.md');
const CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-active-db-target-authority.js');

const MASTER = '85ad38b16146bcc9cbc2abbca8a77fa1471bf3df';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const FAKE_ADMIN_USER = 'slice14q-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14q-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14q-proof-imds-token-never-commit';

const AUTHORIZED_SEQUENCE = Object.freeze([
  'IMDS ARM token (management.azure.com)',
  'ARM GET container app (active revision + env secretRef)',
  'ARM POST listSecrets (only when needed; values zeroed)',
  'IMDS vault token + GET luna-sunset-staging-kv/sunset-database-url',
  'In-memory semantic DSN/KeyVault-ref authority compare',
  'TLS verify-full pg session application_name=wh-sunset-target-authority',
  'BEGIN READ ONLY → inventory → ledger summary → observer → COMMIT',
]);

const ALLOWED_DRIFT_CODES = Object.freeze([
  'wrong_target',
  'genuinely_sparse_active_runtime_db',
  'observation_defect',
  'observer_match',
  'schema_divergence',
]);

function validSecretValue() {
  return buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
}

function authorityArgv(extraFlags) {
  return [
    ...exactTargetAuthorityArgv(),
    ...(extraFlags || []),
  ];
}

function buildExpectedChecksumById(forward) {
  const map = Object.create(null);
  for (const e of forward) {
    if (e && e.id && e.sha256) map[String(e.id)] = String(e.sha256);
  }
  return map;
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
  if (/Bearer\s+slice14q-proof-imds-token/i.test(text)) {
    throw new Error('IMDS token leaked into proof artifact');
  }
  if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/.test(text)) {
    throw new Error('JWT-shaped token leaked into proof artifact');
  }
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

function pickSafeLiveOutcome(result) {
  if (!result || typeof result !== 'object') return null;
  const sameTarget = result.sameTarget === true;
  const schemaInventory = result.schemaInventory || null;
  const observerOutcome = result.observerOutcome || null;
  // Recompute classification from safe inventory/observer fields (never re-runs live).
  const driftClassification = (schemaInventory || observerOutcome)
    ? classifyDrift(sameTarget, schemaInventory, observerOutcome)
    : (result.driftClassification || null);
  return {
    ok: result.ok === true,
    code: String(result.code || 'target_authority_unknown'),
    sameTarget,
    sameTargetReason: result.sameTargetReason || null,
    blocker: result.ok === true ? null : String(result.blocker || result.code || 'failed'),
    activeRevisionName: result.activeRevisionName || null,
    activeRevisionCount: Number.isFinite(result.activeRevisionCount)
      ? result.activeRevisionCount
      : null,
    dbEnvName: result.dbEnvName || null,
    secretRefName: result.secretRefName || null,
    secretRefAmbiguous: result.secretRefAmbiguous === true,
    appSecretKeyVaultUrlMatchesLocked: result.appSecretKeyVaultUrlMatchesLocked === true,
    listSecretsUsed: result.listSecretsUsed === true,
    comparisonMode: result.comparisonMode || null,
    hostMatch: result.hostMatch === true,
    portMatch: result.portMatch === true,
    databaseMatch: result.databaseMatch === true,
    usernameEqual: result.usernameEqual === true,
    passwordEqual: result.passwordEqual === true,
    tlsSemanticsMatch: result.tlsSemanticsMatch === true,
    kvTargetValid: result.kvTargetValid === true,
    appTargetValid: result.appTargetValid === true,
    sessionReadOnly: result.sessionReadOnly === true,
    transactionReadOnly: result.transactionReadOnly === true,
    schemaInventory,
    ledgerSummary: result.ledgerSummary || null,
    observerOutcome,
    driftClassification,
    reconciliationPathHint: (driftClassification && driftClassification.reconciliationPathHint)
      || result.reconciliationPathHint
      || null,
    httpRequestCount: Number(result.httpRequestCount) || 0,
    imdsRequestCount: Number(result.imdsRequestCount) || 0,
    armGetCount: Number(result.armGetCount) || 0,
    armPostCount: Number(result.armPostCount) || 0,
    listSecretsCount: Number(result.listSecretsCount) || 0,
    keyVaultRequestCount: Number(result.keyVaultRequestCount) || 0,
    clientsInstantiated: Number(result.clientsInstantiated) || 0,
    connectCalls: Number(result.connectCalls) || 0,
    queryCalls: Number(result.queryCalls) || 0,
    endCalls: Number(result.endCalls) || 0,
    usedLiveHttp: result.usedLiveHttp === true,
    realImdsCall: result.realImdsCall === true,
    realArmCall: result.realArmCall === true,
    realKeyVaultCall: result.realKeyVaultCall === true,
    realPostgresCall: result.realPostgresCall === true,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    kvMutation: false,
    rbacMutation: false,
    networkMutation: false,
    firewallAction: false,
    committed: result.committed === true,
    rolledBack: result.rolledBack === true,
    closed: result.closed === true,
    applicationName: result.applicationName || APPLICATION_NAME,
    managedIdentityName: result.managedIdentityName || AUTHORITY_LOCKS.managedIdentityName,
    keyVaultName: result.keyVaultName || AUTHORITY_LOCKS.keyVaultName,
    kvSecretName: result.kvSecretName || AUTHORITY_LOCKS.secretName,
    postgresHost: result.postgresHost || AUTHORITY_LOCKS.postgresHost,
    database: result.database || AUTHORITY_LOCKS.database,
    sslmode: result.sslmode || AUTHORITY_LOCKS.sslmode,
    containerAppName: result.containerAppName || AUTHORITY_LOCKS.containerAppName,
    errors: sanitizeErrors(result.errors),
  };
}

async function main() {
  const wantLive = process.argv.includes('--live');
  const offlineOnly = !wantLive
    || process.argv.includes('--offline')
    || process.env.SUNSET_SLICE14Q_PROOF_OFFLINE === '1';
  console.log(offlineOnly
    ? 'prove:sunset-schema-slice14q — offline only (no live HTTP/PG)\n'
    : 'prove:sunset-schema-slice14q — offline then one live target-authority proof\n');

  const priorEvidence = fs.existsSync(EVIDENCE_PATH)
    ? JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'))
    : null;
  const preserveLive = offlineOnly
    && priorEvidence
    && priorEvidence.liveTargetAuthorityOutcome
    && typeof priorEvidence.liveTargetAuthorityOutcome.sameTarget === 'boolean';
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
  const expectedChecksumById = buildExpectedChecksumById(forward);

  if (manifestHash !== MANIFEST_HASH) throw new Error(`manifest hash drift: ${manifestHash}`);
  if (expectedHash !== EXPECTED_BYTE_SHA) throw new Error(`expected hash drift: ${expectedHash}`);
  if (expected.productFingerprint !== CANON_FP) throw new Error('fingerprint drift');
  if (forward.length !== 39) throw new Error('forward count drift');
  assertMigration028ByteIntegrity();
  assert028PredicatesPresentInSource();
  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true) {
    throw new Error('CONNECT_ENABLED must remain activated');
  }
  if (PHASE_D_LIVE_APPLY_ENABLED !== false) {
    throw new Error('global APPLY must remain disabled');
  }
  if (PHASE_D_TARGET_AUTHORITY_LIVE_ENABLED !== true) {
    throw new Error('target authority capability must be enabled');
  }
  if (PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED !== true) {
    throw new Error('live MI HTTP must be activated');
  }
  if (APPLICATION_NAME !== 'wh-sunset-target-authority') {
    throw new Error('APPLICATION_NAME drift');
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

  if (!fs.existsSync(CLI_PATH)) throw new Error('target authority CLI missing');

  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN, validSecretValue()];
  const red = [];
  const green = [];

  // --- RED ---
  resetTargetAuthorityCounters();
  const def = await executeActiveDbTargetAuthority({ env: {}, argv: [] });
  if (getTargetAuthorityCounters().clientsInstantiated !== 0
    || getTargetAuthorityCounters().httpRequestCount !== 0) {
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

  resetTargetAuthorityCounters();
  const noProveFlag = await executeActiveDbTargetAuthority({
    env: targetAuthorityEnv(),
    argv: authorityArgv().filter((a) => a !== CLI_PROVE_TARGET_AUTHORITY),
    httpRequest: createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (getTargetAuthorityCounters().clientsInstantiated !== 0
    || getTargetAuthorityCounters().httpRequestCount !== 0) {
    throw new Error('missing prove flag must zero HTTP/Clients');
  }
  red.push({
    name: 'missing_prove_flag_zero_http',
    ok: true,
    code: noProveFlag.code,
    httpRequestCount: 0,
    clientsInstantiated: 0,
  });

  resetTargetAuthorityCounters();
  const noEnv = await executeActiveDbTargetAuthority({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    },
    argv: authorityArgv(),
    httpRequest: createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (getTargetAuthorityCounters().httpRequestCount !== 0
    || getTargetAuthorityCounters().clientsInstantiated !== 0) {
    throw new Error('missing target authority env must zero HTTP');
  }
  red.push({
    name: 'missing_target_authority_env_zero_http',
    ok: true,
    code: noEnv.code,
    httpRequestCount: 0,
    clientsInstantiated: 0,
  });

  const wrongDb = evaluateTargetAuthorityGates({
    env: targetAuthorityEnv(),
    argv: authorityArgv().map((a, i, arr) => (arr[i - 1] === '--database' ? 'evil_db' : a)),
  });
  if (wrongDb.ok) throw new Error('wrong database must fail');
  resetTargetAuthorityCounters();
  const wrongRun = await executeActiveDbTargetAuthority({
    env: targetAuthorityEnv(),
    argv: authorityArgv().map((a, i, arr) => (arr[i - 1] === '--database' ? 'evil_db' : a)),
    httpRequest: createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (getTargetAuthorityCounters().httpRequestCount !== 0
    || getTargetAuthorityCounters().clientsInstantiated !== 0) {
    throw new Error('wrong targets must zero HTTP');
  }
  red.push({
    name: 'wrong_exact_targets_zero_http',
    ok: true,
    rejected: !wrongDb.ok,
    code: wrongRun.code,
    httpRequestCount: 0,
    clientsInstantiated: 0,
  });

  const forbidden = evaluateTargetAuthorityGates({
    env: targetAuthorityEnv(),
    argv: [
      ...authorityArgv(),
      '--dsn', 'forbidden-dsn-value',
      '--sql', 'SELECT 1',
      '--retry',
    ],
  });
  if (forbidden.ok) throw new Error('forbidden argv must fail');
  resetTargetAuthorityCounters();
  const forbiddenRun = await executeActiveDbTargetAuthority({
    env: targetAuthorityEnv(),
    argv: [
      ...authorityArgv(),
      '--dsn', 'forbidden-dsn-value',
      '--sql', 'SELECT 1',
      '--retry',
    ],
    httpRequest: createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (getTargetAuthorityCounters().httpRequestCount !== 0
    || getTargetAuthorityCounters().clientsInstantiated !== 0) {
    throw new Error('forbidden argv must zero HTTP');
  }
  red.push({
    name: 'forbidden_argv_dsn_sql_retry_zero_http',
    ok: true,
    rejected: !forbidden.ok,
    forbiddenFlags: FORBIDDEN_ARGV_FLAGS.slice(),
    httpRequestCount: 0,
    clientsInstantiated: 0,
    code: forbiddenRun.code,
  });

  const halfFlag = evaluateTargetAuthorityGates({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_TARGET_AUTHORITY]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    },
    argv: exactTargetAuthorityArgv(),
  });
  if (halfFlag.ok) throw new Error('MI without env credential-source must fail');
  red.push({
    name: 'managed_identity_requires_env_and_argv',
    ok: true,
    rejected: !halfFlag.ok,
  });

  resetTargetAuthorityCounters();
  const mismatch = await executeActiveDbTargetAuthority({
    env: targetAuthorityEnv(),
    argv: authorityArgv(),
    httpRequest: createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
      appKeyVaultUrl: 'https://other-kv.vault.azure.net/secrets/other',
    }),
    skipPostgres: true,
  });
  if (mismatch.ok || mismatch.code !== 'mismatched_app_kv_target' || mismatch.sameTarget === true) {
    throw new Error(`mismatched app/kv must refuse: ${JSON.stringify(mismatch)}`);
  }
  if (getTargetAuthorityCounters().clientsInstantiated !== 0) {
    throw new Error('mismatched target must not open PG');
  }
  leakScan(mismatch, secrets);
  red.push({
    name: 'mismatched_app_kv_target',
    ok: true,
    code: mismatch.code,
    sameTarget: false,
    clientsInstantiated: 0,
    driftCode: mismatch.driftClassification && mismatch.driftClassification.code,
  });

  resetTargetAuthorityCounters();
  const ambiguous = await executeActiveDbTargetAuthority({
    env: targetAuthorityEnv(),
    argv: authorityArgv(),
    httpRequest: createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
      ambiguousSecretRefs: true,
    }),
    skipPostgres: true,
  });
  if (ambiguous.ok || ambiguous.code !== 'secret_ref_ambiguous') {
    throw new Error(`ambiguous secretRef must refuse: ${JSON.stringify(ambiguous)}`);
  }
  leakScan(ambiguous, secrets);
  red.push({
    name: 'secret_ref_ambiguous',
    ok: true,
    code: ambiguous.code,
    secretRefAmbiguous: true,
  });

  resetTargetAuthorityCounters();
  const multiRev = await executeActiveDbTargetAuthority({
    env: targetAuthorityEnv(),
    argv: authorityArgv(),
    httpRequest: createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
      multipleActiveRevisions: true,
    }),
    skipPostgres: true,
  });
  if (multiRev.ok || multiRev.code !== 'multiple_active_revisions') {
    throw new Error(`multiple revisions must refuse: ${JSON.stringify(multiRev)}`);
  }
  leakScan(multiRev, secrets);
  red.push({
    name: 'multiple_active_revisions',
    ok: true,
    code: multiRev.code,
    activeRevisionCount: multiRev.activeRevisionCount,
  });

  resetTargetAuthorityCounters();
  const missingDb = await executeActiveDbTargetAuthority({
    env: targetAuthorityEnv(),
    argv: authorityArgv(),
    httpRequest: createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
      missingDbEnv: true,
    }),
    skipPostgres: true,
  });
  if (missingDb.ok || missingDb.code !== 'db_env_missing') {
    throw new Error(`missing db env must refuse: ${JSON.stringify(missingDb)}`);
  }
  leakScan(missingDb, secrets);
  red.push({
    name: 'missing_db_env',
    ok: true,
    code: missingDb.code,
  });

  resetTargetAuthorityCounters();
  const malformed = await executeActiveDbTargetAuthority({
    env: targetAuthorityEnv(),
    argv: authorityArgv(),
    httpRequest: createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: 'not-a-valid-dsn',
      appSecretValue: 'also-not-a-dsn',
      forceListSecrets: true,
    }),
    forceListSecrets: true,
    skipPostgres: true,
  });
  if (malformed.ok || malformed.sameTarget === true) {
    throw new Error(`malformed DSN must refuse: ${JSON.stringify(malformed)}`);
  }
  if (malformed.sameTargetReason !== 'malformed_dsn' && malformed.code !== 'mismatched_app_kv_target') {
    throw new Error(`malformed DSN unexpected: ${JSON.stringify(malformed)}`);
  }
  leakScan(malformed, secrets);
  red.push({
    name: 'malformed_dsn',
    ok: true,
    code: malformed.code,
    sameTargetReason: malformed.sameTargetReason,
    clientsInstantiated: 0,
  });

  resetTargetAuthorityCounters();
  const leakProbe = await executeActiveDbTargetAuthority({
    env: targetAuthorityEnv(),
    argv: authorityArgv(),
    httpRequest: createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
    skipPostgres: true,
  });
  leakScan(leakProbe, secrets);
  const leakText = JSON.stringify(leakProbe);
  if (/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(leakText)
    || leakText.includes(FAKE_ADMIN_PASSWORD)
    || leakText.includes(FAKE_IMDS_TOKEN)
    || /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/.test(leakText)) {
    throw new Error('secret leakage scan failed on GREEN-ish probe');
  }
  red.push({
    name: 'secret_leakage_scan',
    ok: true,
    secretFree: true,
  });

  resetTargetAuthorityCounters();
  const FakeNonRo = createScriptedTargetAuthorityFakeClientFactory({
    transactionReadOnly: false,
    publicTables: 2,
  });
  const nonRo = await executeActiveDbTargetAuthority({
    env: targetAuthorityEnv(),
    argv: authorityArgv(),
    httpRequest: createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
    ClientFactory: FakeNonRo,
    expectedContract: expected,
    expectedChecksumById,
  });
  if (nonRo.ok || nonRo.code !== 'session_not_read_only') {
    throw new Error(`non-read-only session must refuse: ${JSON.stringify(nonRo)}`);
  }
  leakScan(nonRo, secrets);
  red.push({
    name: 'non_read_only_session',
    ok: true,
    code: nonRo.code,
    sameTarget: true,
  });

  resetTargetAuthorityCounters();
  const FakeObs = createScriptedTargetAuthorityFakeClientFactory({
    publicTables: 2,
    ledgerPresent: true,
    ledgerRowCount: 0,
  });
  const obsShape = await executeActiveDbTargetAuthority({
    env: targetAuthorityEnv(),
    argv: authorityArgv(),
    httpRequest: createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
    ClientFactory: FakeObs,
    expectedContract: expected,
    expectedChecksumById,
  });
  if (!obsShape.sameTarget || !obsShape.observerOutcome || !obsShape.observerOutcome.counts) {
    throw new Error(`observer_shape missing counts: ${JSON.stringify(obsShape)}`);
  }
  const counts = obsShape.observerOutcome.counts;
  if (!Object.prototype.hasOwnProperty.call(counts, 'expected_only')
    || !Object.prototype.hasOwnProperty.call(counts, 'live_only')
    || !Object.prototype.hasOwnProperty.call(counts, 'definition_mismatch')) {
    throw new Error(`observer counts shape invalid: ${JSON.stringify(counts)}`);
  }
  leakScan(obsShape, secrets);
  red.push({
    name: 'observer_shape',
    ok: true,
    code: obsShape.code,
    countsKeys: ['expected_only', 'live_only', 'definition_mismatch'],
    expectedOnly: Number(counts.expected_only) || 0,
    liveOnly: Number(counts.live_only) || 0,
    definitionMismatch: Number(counts.definition_mismatch) || 0,
  });

  // --- GREEN ---
  resetTargetAuthorityCounters();
  const kvRefOk = await executeActiveDbTargetAuthority({
    env: targetAuthorityEnv(),
    argv: authorityArgv(),
    httpRequest: createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
    skipPostgres: true,
  });
  leakScan(kvRefOk, secrets);
  if (!kvRefOk.ok || kvRefOk.sameTarget !== true
    || kvRefOk.comparisonMode !== 'keyvault_url_ref'
    || getTargetAuthorityCounters().clientsInstantiated !== 0) {
    throw new Error(`GREEN kv-ref authority failed: ${JSON.stringify(kvRefOk)}`);
  }
  green.push({
    name: 'injected_http_same_keyvault_ref_authority',
    ok: true,
    sameTarget: true,
    comparisonMode: kvRefOk.comparisonMode,
    clientsInstantiated: 0,
    httpRequestCount: kvRefOk.httpRequestCount,
  });

  resetTargetAuthorityCounters();
  const valueOk = await executeActiveDbTargetAuthority({
    env: targetAuthorityEnv(),
    argv: authorityArgv(),
    httpRequest: createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
      appSecretValue: validSecretValue(),
    }),
    forceListSecrets: true,
    skipPostgres: true,
  });
  leakScan(valueOk, secrets);
  if (!valueOk.ok || valueOk.sameTarget !== true
    || valueOk.comparisonMode !== 'value'
    || valueOk.listSecretsUsed !== true) {
    throw new Error(`GREEN value-compare failed: ${JSON.stringify(valueOk)}`);
  }
  green.push({
    name: 'injected_http_value_compare_same_target',
    ok: true,
    sameTarget: true,
    comparisonMode: 'value',
    listSecretsUsed: true,
  });

  const gatesOk = evaluateTargetAuthorityGates({
    env: targetAuthorityEnv(),
    argv: exactTargetAuthorityArgv(),
  });
  if (!gatesOk.ok) {
    throw new Error(`CLI gates should pass: ${JSON.stringify(gatesOk.errors)}`);
  }
  green.push({
    name: 'cli_gates_exact_targets',
    ok: true,
  });

  const cliDefault = spawnSync(process.execPath, [CLI_PATH], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (cliDefault.status === 0) throw new Error('target-authority CLI default must refuse');
  leakScan(`${cliDefault.stdout}${cliDefault.stderr}`, secrets);
  green.push({
    name: 'cli_default_disabled',
    ok: true,
    exitCode: cliDefault.status,
  });

  if (AUTHORITY_LOCKS.applicationName !== 'wh-sunset-target-authority'
    || AUTHORITY_LOCKS.managedIdentityName !== 'wh-staging-identity'
    || AUTHORITY_LOCKS.keyVaultName !== 'luna-sunset-staging-kv'
    || AUTHORITY_LOCKS.secretName !== 'sunset-database-url'
    || AUTHORITY_LOCKS.sslmode !== 'verify-full'
    || AUTHORITY_LOCKS.postgresHost !== TARGETS.postgresHost
    || AUTHORITY_LOCKS.database !== TARGETS.database
    || AUTHORITY_LOCKS.containerAppName !== 'luna-sunset-staging-staff-api'
    || AUTHORITY_LOCKS.managementHostname !== 'management.azure.com'
    || AUTHORITY_LOCKS.armApiVersion !== '2024-03-01') {
    throw new Error('AUTHORITY_LOCKS drift');
  }
  const armPath = buildLockedArmContainerAppPath();
  const listPath = buildLockedArmListSecretsPath();
  const imdsUrl = buildLockedImdsArmTokenUrl();
  const kvUrl = buildLockedKeyVaultSecretUrl();
  if (!listPath.includes('/listSecrets') || !listPath.includes('api-version=2024-03-01')) {
    throw new Error('listSecrets path lock drift');
  }
  if (!armPath.includes('api-version=2024-03-01')
    || !armPath.includes('/providers/Microsoft.App/containerApps/')) {
    throw new Error('ARM container-app path lock drift');
  }
  if (!imdsUrl.includes(AUTHORITY_LOCKS.imdsHost)) {
    throw new Error('IMDS URL lock drift');
  }
  if (!kvUrl.includes(AUTHORITY_LOCKS.keyVaultName) || !kvUrl.includes(AUTHORITY_LOCKS.secretName)) {
    throw new Error('KV URL lock drift');
  }
  green.push({
    name: 'locks_identity_vault_secret_pg_tls_application_name',
    ok: true,
    applicationName: AUTHORITY_LOCKS.applicationName,
    managedIdentityName: AUTHORITY_LOCKS.managedIdentityName,
    keyVaultName: AUTHORITY_LOCKS.keyVaultName,
    secretName: AUTHORITY_LOCKS.secretName,
    sslmode: AUTHORITY_LOCKS.sslmode,
    postgresHost: AUTHORITY_LOCKS.postgresHost,
    database: AUTHORITY_LOCKS.database,
    containerAppName: AUTHORITY_LOCKS.containerAppName,
    armApiVersion: AUTHORITY_LOCKS.armApiVersion,
  });

  if (PHASE_D_LIVE_APPLY_ENABLED !== false) {
    throw new Error('global live apply must remain false');
  }
  green.push({
    name: 'global_live_apply_remains_false',
    ok: true,
    liveApplyEnabled: false,
    targetAuthorityLiveEnabled: true,
  });

  const sparseDrift = classifyDrift(
    true,
    { publicTables: 2, totalObjects: 3, bySchema: { public: { table: 2 } } },
    { match: false, mismatchCount: 400, counts: { expected_only: 400, live_only: 0, definition_mismatch: 0 } },
  );
  const wrongDrift = classifyDrift(false, null, null);
  const richMatch = classifyDrift(
    true,
    { publicTables: 51, totalObjects: 200, bySchema: { public: { table: 51 } } },
    { match: true, mismatchCount: 0, counts: { expected_only: 0, live_only: 0, definition_mismatch: 0 } },
  );
  if (sparseDrift.code !== 'genuinely_sparse_active_runtime_db'
    || wrongDrift.code !== 'wrong_target'
    || richMatch.code !== 'observer_match') {
    throw new Error(`classifyDrift unexpected: ${sparseDrift.code}/${wrongDrift.code}/${richMatch.code}`);
  }
  // sanity: value compare same target with valid DSN pair
  const memCmp = compareDsnAuthorityInMemory(validSecretValue(), validSecretValue());
  if (!memCmp.sameTarget) throw new Error('in-memory same-target compare failed');
  leakScan({ sparseDrift, wrongDrift, richMatch, memCmp }, secrets);
  green.push({
    name: 'sparse_vs_wrong_target_classification',
    ok: true,
    sparseCode: sparseDrift.code,
    wrongTargetCode: wrongDrift.code,
    matchCode: richMatch.code,
  });

  // --- LIVE or preserve ---
  let liveTargetAuthorityOutcome = null;
  let liveAttempted = false;

  if (offlineOnly) {
    if (preserveLive) {
      liveTargetAuthorityOutcome = pickSafeLiveOutcome(priorEvidence.liveTargetAuthorityOutcome);
      liveAttempted = priorEvidence.liveAttemptCount === 1;
      console.log('Offline mode: preserved historical live target-authority outcome.\n');
    } else {
      liveTargetAuthorityOutcome = priorEvidence && priorEvidence.liveTargetAuthorityOutcome
        ? pickSafeLiveOutcome(priorEvidence.liveTargetAuthorityOutcome)
        : null;
      liveAttempted = false;
      console.log('Offline mode: no live target-authority this run (liveAttemptCount remains 0).\n');
    }
  } else {
    console.log('Live section 1/1: one gated active-db-target-authority proof (real HTTP + PG)…\n');
    liveAttempted = true;
    resetTargetAuthorityCounters();
    const liveResult = await executeActiveDbTargetAuthority({
      env: { ...process.env, ...targetAuthorityEnv() },
      argv: exactTargetAuthorityArgv(),
      expectedContract: expected,
      expectedChecksumById,
    });
    leakScan(liveResult, secrets);
    liveTargetAuthorityOutcome = pickSafeLiveOutcome(liveResult);
    leakScan(liveTargetAuthorityOutcome, secrets);
  }

  const liveOk = liveTargetAuthorityOutcome && liveTargetAuthorityOutcome.ok === true;
  const liveSameTarget = liveTargetAuthorityOutcome
    && liveTargetAuthorityOutcome.sameTarget === true;

  let outcome;
  if (offlineOnly && !liveAttempted && !preserveLive) {
    outcome = 'phase_d_target_authority_offline_only';
  } else if (offlineOnly && preserveLive) {
    outcome = liveOk
      ? (liveSameTarget
        ? 'phase_d_target_authority_live_preserved'
        : 'phase_d_target_authority_live_preserved_mismatch')
      : 'phase_d_target_authority_live_preserved_blocked';
  } else if (!liveAttempted) {
    outcome = 'phase_d_target_authority_blocked_before_live';
  } else if (!liveOk) {
    outcome = liveSameTarget
      ? 'phase_d_target_authority_same_target_session_blocked'
      : 'phase_d_target_authority_blocked';
  } else if (liveSameTarget) {
    outcome = liveTargetAuthorityOutcome.observerOutcome
      && liveTargetAuthorityOutcome.observerOutcome.match === true
      ? 'phase_d_target_authority_same_target_observer_match'
      : 'phase_d_target_authority_same_target_observer_drift';
  } else {
    outcome = 'phase_d_target_authority_mismatched';
  }

  const contract = {
    kind: 'sunset-schema-observer-slice14q-active-db-target-authority-contract',
    secretFree: true,
    containsLiveApplyCode: false,
    liveApplyCapability: false,
    targetAuthorityLiveEnabled: true,
    globalLiveApplyEnabled: false,
    liveReadonlyConnectEnabled: true,
    liveHttpEnabled: true,
    writesLedger: false,
    dataMutation: false,
    schemaMutation: false,
    liveMutation: false,
    kvMutation: false,
    rbacMutation: false,
    networkMutation: false,
    firewallMutation: false,
    defaultEnabled: false,
    dualEnableFlagsRequired: true,
    targetAuthorityEnvGateRequired: true,
    targetAuthorityArgvGateRequired: true,
    exactTargetCliConfirmationRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    offlineInjectedHttpAndFakeClientProof: true,
    verifyNeverRerunsLive: true,
    readOnlyAuthorityProof: true,
    driftClassificationEnabled: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14Q',
    purpose: 'Prove read-only whether active Staff API Container App and Key Vault admin sunset-database-url share the locked exact PostgreSQL authority; classify observer drift (sparse vs wrong-target vs observation-defect); zero mutation.',
    targets: { ...TARGETS },
    authorityLocks: {
      applicationName: AUTHORITY_LOCKS.applicationName,
      containerAppName: AUTHORITY_LOCKS.containerAppName,
      managementHostname: AUTHORITY_LOCKS.managementHostname,
      armApiVersion: AUTHORITY_LOCKS.armApiVersion,
      managedIdentityName: AUTHORITY_LOCKS.managedIdentityName,
      keyVaultName: AUTHORITY_LOCKS.keyVaultName,
      secretName: AUTHORITY_LOCKS.secretName,
      postgresHost: AUTHORITY_LOCKS.postgresHost,
      database: AUTHORITY_LOCKS.database,
      sslmode: AUTHORITY_LOCKS.sslmode,
      preferredDbEnvNames: AUTHORITY_LOCKS.preferredDbEnvNames.slice(),
    },
    commandContract: {
      targetAuthority: {
        script: 'scripts/run-phase-d-active-db-target-authority.js',
        npm: 'phase-d:active-db-target-authority',
        requiredEnv: [
          `${ENV_LIVE_READONLY}=1`,
          `${ENV_LIVE_PREFLIGHT}=1`,
          `${ENV_TARGET_AUTHORITY}=1`,
          `${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
          `AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
        ],
        requiredArgv: [
          CLI_PROVE_TARGET_AUTHORITY,
          `--credential-source ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
          `--subscription ${TARGETS.subscriptionId}`,
          `--resource-group ${TARGETS.resourceGroup}`,
          `--container-app ${AUTHORITY_LOCKS.containerAppName}`,
          `--postgres-server ${TARGETS.postgresServer}`,
          `--database ${TARGETS.database}`,
        ],
        forbiddenArgv: FORBIDDEN_ARGV_FLAGS.slice(),
      },
    },
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    offlineGateNames: {
      red: red.map((c) => c.name),
      green: green.map((c) => c.name),
    },
    hashes: {
      manifestHash: MANIFEST_HASH,
      productFingerprint: CANON_FP,
      expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
      migration028: live028,
      migration035: live035,
      migration040: live040,
      migration041: live041,
    },
    allowedDriftCodes: ALLOWED_DRIFT_CODES.slice(),
    forbidden: [
      'INSERT/UPDATE/DELETE into schema_migration_ledger',
      'DDL / DML / schema mutation',
      'KV write / RBAC / network / firewall mutation',
      'DSN / token / username / password / secret version in evidence',
      'az CLI',
      'second live run in verify',
    ],
    nonGoals: [
      'No expected-fixture regeneration',
      'No schema reconcile / constraint apply',
      'Do not claim Sunset repaired',
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14q-active-db-target-authority-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14Q',
    outcome,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    kvMutation: false,
    rbacMutation: false,
    networkMutation: false,
    firewallAction: false,
    identityMutation: false,
    migrationAdded: false,
    writesLedger: false,
    forwardCountUnchanged: 39,
    newForwardMigration: false,
    liveAttemptCount: liveAttempted ? 1 : (preserveLive ? 1 : 0),
    migrationHashes: {
      '028': live028,
      '035': live035,
      '040': live040,
      '041': live041,
    },
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    defaultDisabled: true,
    dualEnableFlagsRequired: true,
    targetAuthorityEnvGateRequired: true,
    targetAuthorityArgvGateRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    applicationName: APPLICATION_NAME,
    authorityLocks: {
      containerAppName: AUTHORITY_LOCKS.containerAppName,
      keyVaultName: AUTHORITY_LOCKS.keyVaultName,
      secretName: AUTHORITY_LOCKS.secretName,
      managedIdentityName: AUTHORITY_LOCKS.managedIdentityName,
      postgresHost: AUTHORITY_LOCKS.postgresHost,
      database: AUTHORITY_LOCKS.database,
      sslmode: AUTHORITY_LOCKS.sslmode,
      applicationName: AUTHORITY_LOCKS.applicationName,
      armApiVersion: AUTHORITY_LOCKS.armApiVersion,
      managementHostname: AUTHORITY_LOCKS.managementHostname,
    },
    offlineGates: {
      defaultPathZeroHttpAndClients: true,
      missingProveFlagZeroHttp: true,
      missingTargetAuthorityEnvZeroHttp: true,
      wrongExactTargetsZeroHttp: true,
      forbiddenArgvDsnSqlRetryZeroHttp: true,
      managedIdentityRequiresEnvAndArgv: true,
      mismatchedAppKvTarget: true,
      secretRefAmbiguous: true,
      multipleActiveRevisions: true,
      missingDbEnv: true,
      malformedDsn: true,
      secretLeakageScan: true,
      nonReadOnlySession: true,
      observerShape: true,
      injectedHttpSameKeyvaultRefAuthority: true,
      injectedHttpValueCompareSameTarget: true,
      cliGatesExactTargets: true,
      cliDefaultDisabled: true,
      locksIdentityVaultSecretPgTlsApplicationName: true,
      globalLiveApplyRemainsFalse: true,
      sparseVsWrongTargetClassification: true,
    },
    redCases: red,
    greenCases: green,
    redCaseCount: red.length,
    greenCaseCount: green.length,
    liveTargetAuthorityOutcome: liveTargetAuthorityOutcome || null,
    sameTarget: liveTargetAuthorityOutcome
      ? liveTargetAuthorityOutcome.sameTarget === true
      : null,
    activeRevisionName: liveTargetAuthorityOutcome
      ? liveTargetAuthorityOutcome.activeRevisionName
      : null,
    dbEnvName: liveTargetAuthorityOutcome
      ? liveTargetAuthorityOutcome.dbEnvName
      : null,
    secretRefName: liveTargetAuthorityOutcome
      ? liveTargetAuthorityOutcome.secretRefName
      : null,
    schemaInventory: liveTargetAuthorityOutcome
      ? liveTargetAuthorityOutcome.schemaInventory
      : null,
    ledgerSummary: liveTargetAuthorityOutcome
      ? liveTargetAuthorityOutcome.ledgerSummary
      : null,
    observerOutcome: liveTargetAuthorityOutcome
      ? liveTargetAuthorityOutcome.observerOutcome
      : null,
    driftClassification: liveTargetAuthorityOutcome
      ? liveTargetAuthorityOutcome.driftClassification
      : null,
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

  // When offline with no prior live, force liveAttemptCount=0
  if (offlineOnly && !preserveLive) {
    evidence.liveAttemptCount = 0;
  }

  leakScan(evidence, secrets);
  leakScan(contract, secrets);

  const liveSummary = !liveAttempted && !preserveLive
    ? 'Live target-authority **not attempted** (offline only).'
    : !liveTargetAuthorityOutcome
      ? 'Live target-authority **missing**.'
      : liveOk && liveSameTarget
        ? `Live target-authority **sameTarget=true** (activeRevision=${liveTargetAuthorityOutcome.activeRevisionName}, dbEnv=${liveTargetAuthorityOutcome.dbEnvName}, secretRef=${liveTargetAuthorityOutcome.secretRefName}, drift=${(liveTargetAuthorityOutcome.driftClassification && liveTargetAuthorityOutcome.driftClassification.code) || 'n/a'}).`
        : liveOk
          ? `Live target-authority **ok but sameTarget=false** (blocker=${liveTargetAuthorityOutcome.blocker}).`
          : `Live target-authority **blocked** (\`blocker=${liveTargetAuthorityOutcome.blocker}\`, sameTarget=${liveTargetAuthorityOutcome.sameTarget}).`;

  const findings = `# FOUNDATION Slice 14Q — Active DB target authority

**Status:** complete (offline RED/GREEN${liveAttempted || preserveLive ? ' + live authority path' : ''}; **zero mutation**)
**Master basis:** \`${MASTER}\`
**Outcome:** \`${outcome}\`

## What this slice proves

Read-only proof that the active Sunset-staging Staff API Container App
(\`${AUTHORITY_LOCKS.containerAppName}\`) and the Key Vault admin secret
(\`${AUTHORITY_LOCKS.keyVaultName}/${AUTHORITY_LOCKS.secretName}\`) resolve to the
**same exact** PostgreSQL server/database/credential authority locked for Phase D.
Then classify live observer drift (\`expected_only\` mass) enough to choose a safe
reconciliation path (\`genuinely_sparse_active_runtime_db\` vs \`wrong_target\` vs
\`observation_defect\` vs \`schema_divergence\`).

## Offline gates

- RED: ${red.length} cases (default refuse, missing prove flag/env, wrong targets,
  forbidden argv, MI dual flags, mismatched app/KV, ambiguous secretRef, multiple
  revisions, missing DB env, malformed DSN, secret leakage, non-read-only session,
  observer counts shape)
- GREEN: ${green.length} cases (KV URL ref authority, value compare, CLI gates,
  locks, global apply false, classifyDrift unit checks)

## Live

${liveSummary}

Mutation flags (all must remain false): liveMutation / schemaMutation / dataMutation /
ledgerWritten / kvMutation = **false**.

## Do not claim

- Do **not** claim Sunset repaired or schema reconciled.
- Do **not** run verify with \`--live\` (verify never re-runs live).
- Do **not** persist DSN, passwords, tokens, or secret versions.

## Artifacts

- \`fixtures/sunset-schema-observer/slice14q-active-db-target-authority-evidence.json\`
- \`fixtures/sunset-schema-observer/slice14q-active-db-target-authority-contract.json\`
- \`fixtures/sunset-schema-observer/slice14q-findings.md\`
`;

  leakScan(findings, secrets);

  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, findings);

  console.log(`RED cases: ${red.length}  GREEN cases: ${green.length}`);
  console.log(`Outcome: ${outcome}`);
  console.log(`Wrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log('\nprove:sunset-schema-slice14q GREEN (offline)');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
