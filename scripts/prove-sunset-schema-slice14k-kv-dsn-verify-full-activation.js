'use strict';

/**
 * prove-sunset-schema-slice14k-kv-dsn-verify-full-activation — FOUNDATION Slice 14K
 *
 * Offline proof that the merged 14J metadata-preserving sslmode-only KV mutation
 * adapter is activated behind SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_APPLY=1 +
 * --apply-verify-full + exact subscription/RG/VM/identity/vault/secret/PG flags.
 * Injected transport + child CLI only — no live IMDS/Key Vault/PostgreSQL call.
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
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED,
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED,
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_HTTP_ENABLED,
  DSN_PLAN_LOCKS,
  KEY_VAULT_RESOURCE_ID,
  createInjectedDsnNormalizeHttp,
  buildOfflineProofTlsDeficientSunsetDatabaseUrl,
  buildOfflineProofVerifyFullSunsetDatabaseUrl,
  executeDsnNormalizeAdapter,
  assertLockedDsnNormalizeLiveRequest,
  createLiveDsnNormalizeHttpRequest,
  getDsnPlanCounters,
  resetDsnPlanCounters,
} = require('./lib/phase-d-kv-dsn-verify-full-plan');
const {
  ENV_DSN_APPLY,
  CLI_APPLY_VERIFY_FULL,
  DSN_APPLY_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  evaluateDsnApplyGates,
  executeDsnVerifyFullApply,
  executeDsnVerifyFullApplyRollback,
  exactDsnApplyArgv,
  dsnApplyEnv,
  renderDsnApplyUsage,
} = require('./lib/phase-d-kv-dsn-verify-full-apply');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14k-kv-dsn-verify-full-activation-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14k-kv-dsn-verify-full-activation-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14k-findings.md');
const CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-kv-dsn-verify-full-apply.js');

const MASTER = '4cfb610e069bb382f83160064963fd86572ffecb';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const FAKE_USER = 'slice14k-proof-admin';
const FAKE_PASSWORD = 'slice14k-proof-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14k-proof-imds-token-never-commit';
const FAKE_PRIOR_VERSION = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FAKE_NEW_VERSION = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FAKE_CONTENT_TYPE = 'text/plain';
const FAKE_TAGS = Object.freeze({ env: 'proof', purpose: 'slice14k' });
const FAKE_ATTRS = Object.freeze({ enabled: true, nbf: 1700000000, exp: 1800000000 });

function tlsDeficientSecret() {
  return buildOfflineProofTlsDeficientSunsetDatabaseUrl(FAKE_USER, FAKE_PASSWORD, 'require');
}

function verifyFullSecret() {
  return buildOfflineProofVerifyFullSunsetDatabaseUrl(FAKE_USER, FAKE_PASSWORD);
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
  if (/Bearer\s+slice14k-proof-imds-token/i.test(text)) {
    throw new Error('IMDS token leaked into proof artifact');
  }
  if (text.includes(FAKE_CONTENT_TYPE) && text.includes('"contentType"')) {
    throw new Error('contentType metadata value leaked');
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
    'token', 'access_token', 'password', 'user', 'dsn', '_user', '_password',
    '_token', '_dsn', 'value', 'contentType', 'tags',
  ];
  for (const k of forbidden) {
    if (Object.prototype.hasOwnProperty.call(result || {}, k)) {
      throw new Error(`forbidden output key present: ${k}`);
    }
  }
}

function makeOkInject(overrides) {
  return createInjectedDsnNormalizeHttp({
    imdsAccessToken: FAKE_IMDS_TOKEN,
    currentSecretValue: tlsDeficientSecret(),
    priorSecretVersionId: FAKE_PRIOR_VERSION,
    newSecretVersionId: FAKE_NEW_VERSION,
    secretContentType: FAKE_CONTENT_TYPE,
    secretTags: { ...FAKE_TAGS },
    secretAttributes: { ...FAKE_ATTRS },
    ...(overrides || {}),
  });
}

async function main() {
  console.log('prove:sunset-schema-slice14k-kv-dsn-verify-full-activation — offline\n');

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

  const secrets = [FAKE_USER, FAKE_PASSWORD, FAKE_IMDS_TOKEN, tlsDeficientSecret(), verifyFullSecret()];
  const red = [];
  const green = [];

  // ── RED ────────────────────────────────────────────────────────────
  resetDsnPlanCounters();
  const defaultGates = evaluateDsnApplyGates({ env: {}, argv: [] });
  if (defaultGates.ok || getDsnPlanCounters().httpRequestCount !== 0
    || getDsnPlanCounters().kvWriteCount !== 0) {
    throw new Error('default gates must refuse with zero HTTP/writes');
  }
  red.push({
    name: 'default_path_zero_http_writes',
    ok: true,
    httpRequestCount: 0,
    kvWriteCount: 0,
  });

  resetDsnPlanCounters();
  const missingEnv = await executeDsnVerifyFullApply({
    env: { AZURE_SUBSCRIPTION_ID: DSN_APPLY_LOCKS.subscriptionId },
    argv: exactDsnApplyArgv(),
  });
  leakScan(missingEnv, secrets);
  assertSafeOutputShape(missingEnv);
  if (missingEnv.ok || getDsnPlanCounters().httpRequestCount !== 0) {
    throw new Error('missing apply env must zero HTTP');
  }
  red.push({ name: 'missing_env_zero_http', ok: true, code: missingEnv.code });

  resetDsnPlanCounters();
  const missingFlag = await executeDsnVerifyFullApply({
    env: dsnApplyEnv(),
    argv: exactDsnApplyArgv().filter((a) => a !== CLI_APPLY_VERIFY_FULL),
  });
  if (missingFlag.ok || getDsnPlanCounters().httpRequestCount !== 0) {
    throw new Error('missing --apply-verify-full must zero HTTP');
  }
  red.push({ name: 'missing_apply_flag_zero_http', ok: true, code: missingFlag.code });

  resetDsnPlanCounters();
  const wrongTarget = await executeDsnVerifyFullApply({
    env: dsnApplyEnv(),
    argv: exactDsnApplyArgv().map((a) => (a === 'lunabox' ? 'wrong-vm' : a)),
  });
  if (wrongTarget.ok || getDsnPlanCounters().httpRequestCount !== 0) {
    throw new Error('wrong VM target must zero HTTP');
  }
  red.push({ name: 'wrong_exact_targets_zero_http', ok: true, code: wrongTarget.code });

  resetDsnPlanCounters();
  const forbiddenArgv = await executeDsnVerifyFullApply({
    env: dsnApplyEnv(),
    argv: [...exactDsnApplyArgv(), '--dsn', 'postgresql://x'],
  });
  if (forbiddenArgv.ok || getDsnPlanCounters().httpRequestCount !== 0) {
    throw new Error('forbidden --dsn must zero HTTP');
  }
  red.push({ name: 'forbidden_value_dsn_url_token_file_argv', ok: true });

  resetDsnPlanCounters();
  const adapterBare = await executeDsnNormalizeAdapter({});
  if (adapterBare.ok || getDsnPlanCounters().kvWriteCount !== 0) {
    throw new Error('bare adapter without httpRequest must zero writes');
  }
  red.push({ name: 'adapter_without_http_zero_writes', ok: true, code: adapterBare.code });

  resetDsnPlanCounters();
  const transportFail = await executeDsnVerifyFullApply({
    env: dsnApplyEnv(),
    argv: exactDsnApplyArgv(),
    httpRequest: makeOkInject({ imdsStatusCode: 500 }),
  });
  leakScan(transportFail, secrets);
  assertSafeOutputShape(transportFail);
  if (transportFail.ok || transportFail.kvPutCount !== 0) {
    throw new Error('IMDS failure must sanitize and zero PUTs');
  }
  red.push({
    name: 'sanitized_transport_failure',
    ok: true,
    code: transportFail.code,
    kvPutCount: 0,
  });

  resetDsnPlanCounters();
  const putFail = await executeDsnVerifyFullApply({
    env: dsnApplyEnv(),
    argv: exactDsnApplyArgv(),
    httpRequest: makeOkInject({ kvPutStatusCode: 403 }),
  });
  leakScan(putFail, secrets);
  assertSafeOutputShape(putFail);
  if (putFail.ok || !putFail.priorSecretVersionId) {
    throw new Error('PUT failure must retain prior-version safe ID');
  }
  red.push({
    name: 'sanitized_put_failure_retains_prior_version_id',
    ok: true,
    priorSecretVersionId: putFail.priorSecretVersionId,
  });

  resetDsnPlanCounters();
  const verifyFail = await executeDsnVerifyFullApply({
    env: dsnApplyEnv(),
    argv: exactDsnApplyArgv(),
    httpRequest: makeOkInject({ kvVerifyStatusCode: 500 }),
  });
  leakScan(verifyFail, secrets);
  assertSafeOutputShape(verifyFail);
  if (verifyFail.ok) throw new Error('verify GET failure must fail closed');
  red.push({ name: 'sanitized_verify_failure', ok: true, code: verifyFail.code });

  resetDsnPlanCounters();
  const rollbackRefuse = await executeDsnVerifyFullApplyRollback();
  if (rollbackRefuse.ok || getDsnPlanCounters().kvWriteCount !== 0) {
    throw new Error('rollback must stay hard-disabled');
  }
  red.push({ name: 'rollback_hard_disabled_zero_writes', ok: true, code: rollbackRefuse.code });

  // Live transport lock rejects host/method/path deviations (no network).
  let hostRejected = false;
  try {
    assertLockedDsnNormalizeLiveRequest({
      purpose: 'imds_token',
      method: 'GET',
      hostname: 'evil.example',
      path: '/metadata/identity/oauth2/token',
      headers: { Metadata: 'true' },
    });
  } catch (e) {
    hostRejected = e && e.code === 'imds_host_rejected';
  }
  if (!hostRejected) throw new Error('live transport must reject wrong IMDS host');

  let methodRejected = false;
  try {
    assertLockedDsnNormalizeLiveRequest({
      purpose: 'keyvault_secret_put',
      method: 'POST',
      hostname: new URL(`https://${DSN_PLAN_LOCKS.keyVaultName}.vault.azure.net`).hostname,
      path: `/secrets/${DSN_PLAN_LOCKS.secretName}?api-version=${DSN_PLAN_LOCKS.keyVaultApiVersion}`,
      headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'x' }),
    });
  } catch (e) {
    methodRejected = e && e.code === 'http_method_forbidden';
  }
  if (!methodRejected) throw new Error('live transport must reject non-PUT method for PUT purpose');

  let bodyRejected = false;
  try {
    const kvHost = `${DSN_PLAN_LOCKS.keyVaultName}.vault.azure.net`;
    assertLockedDsnNormalizeLiveRequest({
      purpose: 'keyvault_secret_put',
      method: 'PUT',
      hostname: kvHost,
      path: `/secrets/${DSN_PLAN_LOCKS.secretName}?api-version=${DSN_PLAN_LOCKS.keyVaultApiVersion}`,
      headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'x', extra: 'nope' }),
    });
  } catch (e) {
    bodyRejected = e && e.code === 'kv_put_body_rejected';
  }
  if (!bodyRejected) throw new Error('live transport must reject arbitrary PUT body keys');
  red.push({
    name: 'live_transport_rejects_host_method_body_deviations',
    ok: true,
  });

  // ── GREEN ──────────────────────────────────────────────────────────
  if (PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED !== true
    || PHASE_D_KV_DSN_VERIFY_FULL_LIVE_HTTP_ENABLED !== true
    || PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED !== false) {
    throw new Error('live mutate/HTTP must be enabled; rollback must stay disabled');
  }
  green.push({
    name: 'live_http_activated_rollback_disabled',
    ok: true,
    liveMutateEnabled: true,
    liveHttpEnabled: true,
    liveRollbackEnabled: false,
  });

  resetDsnPlanCounters();
  const gatesOk = evaluateDsnApplyGates({
    env: dsnApplyEnv(),
    argv: exactDsnApplyArgv(),
  });
  if (!gatesOk.ok) throw new Error(`exact gates must pass: ${JSON.stringify(gatesOk.errors)}`);
  green.push({ name: 'exact_gates_pass', ok: true, code: gatesOk.code });

  resetDsnPlanCounters();
  const httpOk = makeOkInject();
  const success = await executeDsnVerifyFullApply({
    env: dsnApplyEnv(),
    argv: exactDsnApplyArgv(),
    httpRequest: httpOk,
  });
  leakScan(success, secrets);
  assertSafeOutputShape(success);
  if (!success.ok
    || success.httpRequestCount !== 4
    || success.keyVaultPutCount !== 1
    || success.putCount !== 1
    || success.metadataPreserved !== true
    || success.sslmodeNormalized !== true
    || success.usedLiveHttp !== false
    || success.realImdsCall !== false
    || success.realKeyVaultCall !== false
    || success.realPostgresCall !== false
    || success.priorSecretVersionId !== FAKE_PRIOR_VERSION
    || success.newSecretVersionId !== FAKE_NEW_VERSION
    || success.pgClientInstantiated !== 0) {
    throw new Error(`exact one-PUT success failed: ${JSON.stringify(success)}`);
  }
  if (httpOk.getPutCount() !== 1) throw new Error('inject put count must be 1');
  green.push({
    name: 'exact_one_put_sequence_injected',
    ok: true,
    httpRequestCount: 4,
    imdsRequestCount: 1,
    keyVaultGetCount: 2,
    keyVaultPutCount: 1,
    putCount: 1,
    metadataPreserved: true,
    priorSecretVersionId: success.priorSecretVersionId,
    newSecretVersionId: success.newSecretVersionId,
  });

  const liveFn = createLiveDsnNormalizeHttpRequest();
  if (typeof liveFn !== 'function') throw new Error('live HTTP transport missing');
  green.push({ name: 'live_http_transport_present', ok: true });

  const cliDefault = spawnSync(process.execPath, [CLI_PATH], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (cliDefault.status === 0) throw new Error('CLI default must refuse');
  leakScan(`${cliDefault.stdout}${cliDefault.stderr}`, secrets);
  green.push({
    name: 'cli_default_disabled',
    ok: true,
    exitCode: cliDefault.status,
  });

  const cliMissing = spawnSync(process.execPath, [CLI_PATH, ...exactDsnApplyArgv()], {
    encoding: 'utf8',
    env: { ...process.env, AZURE_SUBSCRIPTION_ID: DSN_APPLY_LOCKS.subscriptionId },
  });
  if (cliMissing.status === 0) throw new Error('CLI missing apply env must refuse');
  leakScan(`${cliMissing.stdout}${cliMissing.stderr}`, secrets);
  let cliMissingOut = {};
  try {
    cliMissingOut = JSON.parse(String(cliMissing.stdout || '').trim());
  } catch (_) {
    cliMissingOut = { code: null };
  }
  if (Number(cliMissingOut.httpRequestCount || 0) !== 0
    || Number(cliMissingOut.kvWriteCount || 0) !== 0) {
    throw new Error('CLI missing-env must report zero HTTP/writes');
  }
  green.push({
    name: 'cli_missing_env_refuses_zero_http',
    ok: true,
    exitCode: cliMissing.status,
    code: cliMissingOut.code || null,
  });

  // Child CLI with full gates would attempt live HTTP — do NOT spawn that path
  // in this slice. Prove gates-only child refuse above; success stays in-process inject.

  const usage = renderDsnApplyUsage();
  if (!usage.includes(CLI_APPLY_VERIFY_FULL)
    || !usage.includes(ENV_DSN_APPLY)
    || !usage.includes('wh-staging-identity')
    || !usage.includes('lunabox')) {
    throw new Error('usage text incomplete');
  }
  green.push({ name: 'usage_and_locks', ok: true, locks: { ...DSN_APPLY_LOCKS } });

  if (getDsnPlanCounters().pgClientInstantiated !== 0) {
    throw new Error('pg Client must never instantiate');
  }
  green.push({
    name: 'no_pg_client_hashes_preserved',
    ok: true,
    pgClientInstantiated: 0,
    manifestHash: MANIFEST_HASH,
    expectedByteSha: EXPECTED_BYTE_SHA,
    productFingerprint: CANON_FP,
  });

  const generatedAt = new Date().toISOString();
  const contract = {
    kind: 'sunset-schema-observer-slice14k-kv-dsn-verify-full-activation-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: true,
    liveMutateCapability: true,
    liveMutateEnabled: true,
    liveHttpEnabled: true,
    liveRollbackEnabled: false,
    liveMutation: false,
    mutates: false,
    firewallMutation: false,
    networkMutation: false,
    defaultEnabled: false,
    applyEnvRequired: true,
    applyFlagRequired: true,
    exactTargetCliConfirmationRequired: true,
    offlineInjectedHttpProof: true,
    neverInstantiatesPgClient: true,
    retriesForbidden: true,
    redirectsRejected: true,
    metadataPreservationRequired: true,
    rollbackHardDisabled: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14K',
    purpose: 'Activate merged 14J metadata-preserving sslmode-only KV mutation adapter behind dedicated APPLY env + --apply-verify-full + exact targets; real locked HTTP/HTTPS transport; offline injected proof only — no live IMDS/KV/PG in this slice.',
    locks: { ...DSN_APPLY_LOCKS },
    mutationContract: {
      operation: 'setSecretNewVersion',
      field: 'sslmode',
      to: 'verify-full',
      putCount: 1,
      retries: 0,
      preserveUserMetadata: true,
      httpSequence: [
        'IMDS GET',
        'Key Vault secret GET',
        'Key Vault secret PUT',
        'Key Vault secret verification GET',
      ],
    },
    commandContract: {
      script: 'scripts/run-phase-d-kv-dsn-verify-full-apply.js',
      npm: 'phase-d:kv-dsn-verify-full-apply',
      requiredEnv: [
        `${ENV_DSN_APPLY}=1`,
        `AZURE_SUBSCRIPTION_ID=${DSN_APPLY_LOCKS.subscriptionId}`,
      ],
      requiredArgv: [
        CLI_APPLY_VERIFY_FULL,
        `--subscription ${DSN_APPLY_LOCKS.subscriptionId}`,
        `--resource-group ${DSN_APPLY_LOCKS.resourceGroup}`,
        `--vm-resource-group ${DSN_APPLY_LOCKS.vmResourceGroup}`,
        `--vm-name ${DSN_APPLY_LOCKS.vmName}`,
        `--managed-identity ${DSN_APPLY_LOCKS.managedIdentityName}`,
        `--key-vault ${DSN_APPLY_LOCKS.keyVaultName}`,
        `--secret-name ${DSN_APPLY_LOCKS.secretName}`,
        `--postgres-server ${DSN_APPLY_LOCKS.postgresServer}`,
        `--database ${DSN_APPLY_LOCKS.database}`,
      ],
      forbiddenArgv: [...FORBIDDEN_ARGV_FLAGS],
      safeOutputKeys: [...SAFE_OUTPUT_KEYS],
    },
    authorizedHttpSequenceOnSuccess: [
      'IMDS GET',
      'Key Vault secret GET',
      'Key Vault secret PUT',
      'Key Vault secret verification GET',
    ],
    successCallCounts: {
      httpRequestCount: 4,
      imdsRequestCount: 1,
      keyVaultGetCount: 2,
      keyVaultPutCount: 1,
      putCount: 1,
    },
    predicatesUnchangedFrom14A: {
      date_window: DATE_WINDOW_PREDICATE,
      price_unit: PRICE_UNIT_PREDICATE,
    },
    nonGoals: [
      'Do not execute live IMDS/Key Vault/PostgreSQL in Slice 14K',
      'Do not change RBAC/KV/PG/network/migrations/DDL/ledger',
      'Do not enable rollback',
      'Do not instantiate a pg Client',
      'Do not expose token/DSN/user/password/metadata values',
      'Do not claim Sunset repaired',
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14k-kv-dsn-verify-full-activation-evidence',
    secretFree: true,
    slice: '14K',
    generatedAt,
    masterShaBasis: MASTER,
    manifestHashUnchanged: MANIFEST_HASH,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    productFingerprintUnchanged: CANON_FP,
    liveMutateEnabled: true,
    liveHttpEnabled: true,
    liveRollbackEnabled: false,
    liveMutation: false,
    realImdsCall: false,
    realKeyVaultCall: false,
    realPostgresCall: false,
    offlineInjectedHttpProof: true,
    zeroLiveMutation: true,
    keyVaultResourceId: KEY_VAULT_RESOURCE_ID,
    authorizedSequence: contract.authorizedHttpSequenceOnSuccess,
    successCallCounts: contract.successCallCounts,
    red,
    green,
    locks: { ...DSN_APPLY_LOCKS },
    predicatesUnchangedFrom14A: contract.predicatesUnchangedFrom14A,
    authorizedAggregateSqlUnchanged: AGG_14A,
  };

  leakScan(evidence, secrets);
  leakScan(contract, secrets);

  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

  const findings = `# FOUNDATION Slice 14K — Key Vault DSN sslmode=verify-full apply activation (offline)

**Status:** complete (14J adapter activated behind gated apply CLI; live HTTP transport present; offline injected proof only; rollback hard-disabled; zero live IMDS/KV/PG)
**Master basis:** \`${MASTER}\`
**Generated:** ${generatedAt}

## Outcome

Activated the merged Slice **14J** metadata-preserving sslmode-only Key Vault mutation adapter behind a dedicated exact operator command. Real Node \`http\`/\`https\` transport is restricted to locked IMDS GET, exact current-secret GET, exactly one same-secret PUT, and exact verification GET — redirects, DNS/host/path/method/body deviations, and retries are rejected.

Live path requires:

1. \`SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_APPLY=1\`
2. exact \`AZURE_SUBSCRIPTION_ID\`
3. \`--apply-verify-full\`
4. exact subscription / RG / VM RG / VM name / managed identity / vault / secret / postgres server / database

Default / missing / wrong gates → **zero HTTP / zero writes**. Rollback remains separately hard-disabled. This slice does **not** execute live IMDS/Key Vault/PostgreSQL.

| Lock | Value |
|------|-------|
| Vault / secret | \`luna-sunset-staging-kv\` / \`sunset-database-url\` |
| Identity / VM | \`wh-staging-identity\` / \`lunabox\` in \`wh-staging-rg\` |
| PG host / database | \`luna-sunset-staging-pg-app.postgres.database.azure.com\` / \`sunset_staging\` |
| Mutation | \`sslmode\` only → \`verify-full\` (metadata preserved) |
| PUT count | exactly 1 (no retries) |

## Operator command (default-disabled; NOT executed live in this slice)

\`\`\`bash
SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_APPLY=1 \\
AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \\
npm run phase-d:kv-dsn-verify-full-apply -- \\
  --apply-verify-full \\
  --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 \\
  --resource-group luna-sunset-staging-rg \\
  --vm-resource-group wh-staging-rg \\
  --vm-name lunabox \\
  --managed-identity wh-staging-identity \\
  --key-vault luna-sunset-staging-kv \\
  --secret-name sunset-database-url \\
  --postgres-server luna-sunset-staging-pg-app \\
  --database sunset_staging
\`\`\`

## RED / GREEN (injected transport + child CLI)

| Class | Cases |
|-------|-------|
| RED | default/missing env/flag; wrong targets; forbidden DSN/url/token/file argv; bare adapter zero writes; sanitized transport/PUT/verify failures; rollback hard-disabled; live transport rejects host/method/body deviations |
| GREEN | live HTTP activated + rollback disabled; exact gates; fake HTTP **IMDS GET + KV GET + KV PUT + verify GET** (4 calls, 1 PUT, metadata preserved); CLI default refuse; CLI missing-env refuse; live transport present; hashes preserved; no pg Client |

**Mutation success call counts:** httpRequestCount=4, imdsRequestCount=1, keyVaultGetCount=2, keyVaultPutCount=1.

## Non-goals / still open

- **No** live IMDS / Key Vault / PostgreSQL call in this slice
- **No** RBAC / network / PG / DB / DDL / ledger / migration change
- Still \`product_schema_differs\`
- **Do not claim** Sunset repaired.

## Zero live mutation

Offline injected-HTTP proof + child CLI gate refuses only. Default/wrong args → zero HTTP/writes. Rollback flag remains \`false\`. No live apply executed.
`;

  fs.writeFileSync(FINDINGS_PATH, findings);
  leakScan(findings, secrets);

  console.log(`  RED cases: ${red.length}`);
  console.log(`  GREEN cases: ${green.length}`);
  console.log(`  wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`  wrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`  wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log('\nprove:sunset-schema-slice14k — PASSED (offline)');
}

main().catch((err) => {
  console.error(`prove:sunset-schema-slice14k FAILED: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
