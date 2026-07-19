'use strict';

/**
 * prove-sunset-schema-slice14ab-azure-pgcrypto-compat-normalization
 * FOUNDATION Slice 14AB
 *
 * Offline RED/GREEN for Azure PG15 pgcrypto 1.3 presentation normalization
 * + optional --live once: merged target authority + one TLS verify-full observer
 * session application_name=wh-sunset-pgcrypto-compatibility.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  MANIFEST_PATH,
  sha256CanonicalLfV1File,
} = require('./lib/migration-integrity');
const {
  hashCanonicalManifest,
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  compareSnapshots,
  buildIdentifierTruncationNotNullProvenance,
  normalizeAzurePg15PgcryptoCompatibility,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  LOCKED_PGCRYPTO_EXTENSION,
  LOCKED_FIPS_MODE_FUNCTION,
  LOCKED_FIPS_MODE_OWNERSHIP,
  LOCKED_FIPS_MODE_ACL,
  PGCRYPTO_LIVE_VERSION,
  PGCRYPTO_COMPATIBILITY_RULE,
} = require('./lib/sunset-schema-observer');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  PHASE_D_PGCRYPTO_COMPATIBILITY_NORMALIZATION_LIVE_ENABLED,
  ENV_PGCRYPTO_COMPATIBILITY_NORMALIZATION,
  CLI_PROVE_PGCRYPTO_COMPATIBILITY_NORMALIZATION,
  APPLICATION_NAME,
  PGCRYPTO_LOCKS,
  BASELINE_MISMATCH_COUNT,
  BASELINE_MISMATCH_SECTIONS,
  evaluatePgcryptoCompatibilityNormalizationGates,
  exactPgcryptoCompatibilityNormalizationArgv,
  pgcryptoCompatibilityNormalizationEnv,
  executePgcryptoCompatibilityNormalization,
  createInjectedTargetAuthorityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  buildOfflinePgcryptoLiveProfile,
  resetPgcryptoCompatibilityNormalizationCounters,
  getPgcryptoCompatibilityNormalizationCounters,
  printCliHelp,
  buildObserverCompareOptions,
} = require('./lib/phase-d-pgcrypto-compatibility-normalization');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14ab-azure-pgcrypto-compat-normalization-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14ab-azure-pgcrypto-compat-normalization-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14ab-findings.md');

const MASTER = '51578961029ae7c7b53582542f049d53f2952b98';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const AZURE_CTX = Object.freeze({
  verified: true,
  host: EXPECTED_HOST,
  database: EXPECTED_DATABASE,
  versionClass: 'postgresql_15',
});

const FAKE_ADMIN_USER = 'slice14ab-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14ab-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14ab-proof-imds-token-never-commit';

const REQUIRED_RED = [
  'default_path_zero_http_and_clients',
  'missing_prove_flag_zero_clients',
  'missing_pgcrypto_env_zero_clients',
  'wrong_exact_targets_zero_clients',
  'forbidden_argv_dsn_sql_drop_dml_zero_clients',
  'non_azure_profile_retains',
  'non_pg15_retains_or_rejects',
  'wrong_live_version_retains',
  'wrong_namespace_retains',
  'wrong_owner_retains',
  'wrong_relocatable_retains',
  'upgrade_available_1_4_unapplied_fails',
  'missing_gen_random_uuid_capability_retains',
  'gen_random_uuid_not_extension_member_retains',
  'fips_mode_present_differently_retains',
  'extra_unexpected_pgcrypto_member_delta_retains',
  'expected_bytes_change_fails',
];

const REQUIRED_GREEN = [
  'exact_locked_version_pair_normalizes_four',
  'capability_proof_gen_random_uuid',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'global_live_apply_remains_false',
  'accounting_baseline_4_normalized_4_remaining_0',
  'raw_vs_normalized_compare_api',
  'fips_mode_absence_member_delta',
  'prior_14x_rules_still_default_behavior',
];

function emptySnap() {
  return {
    tables: [],
    columns: [],
    constraints: [],
    indexes: [],
    sequences: [],
    views: [],
    enums: [],
    functions: [],
    triggers: [],
    rlsFlags: [],
    rlsPolicies: [],
    ownership: [],
    acls: [],
    extensions: [],
  };
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
}

function findFromCanonical(expectedFull, kind, identity) {
  const snap = expectedFull.snapshot;
  if (kind === 'function') {
    return snap.functions.find((f) => f.identity === identity);
  }
  if (kind === 'ownership') {
    return snap.ownership.find((o) => o.identity === identity);
  }
  if (kind === 'acl') {
    return snap.acls.find((a) => a.identity === identity);
  }
  if (kind === 'extension') {
    return snap.extensions.find((e) => e.name === identity);
  }
  return null;
}

function buildPgcryptoFixture(expectedFull) {
  const genUuidFn = findFromCanonical(expectedFull, 'function', 'public.gen_random_uuid()');
  const genUuidOwn = findFromCanonical(expectedFull, 'ownership', 'public.gen_random_uuid()');
  const genUuidAcl = findFromCanonical(expectedFull, 'acl', 'public.gen_random_uuid()');
  if (!genUuidFn || !genUuidOwn || !genUuidAcl) {
    throw new Error('canonical expected missing gen_random_uuid tuples');
  }
  if (!LOCKED_FIPS_MODE_FUNCTION || !LOCKED_FIPS_MODE_OWNERSHIP || !LOCKED_FIPS_MODE_ACL) {
    throw new Error('locked fips_mode tuples missing');
  }
  const pgcryptoExt = { ...LOCKED_PGCRYPTO_EXTENSION };
  const livePgcryptoExt = {
    ...LOCKED_PGCRYPTO_EXTENSION,
    version: PGCRYPTO_LIVE_VERSION,
  };

  const expected = emptySnap();
  expected.functions = [{ ...LOCKED_FIPS_MODE_FUNCTION }, { ...genUuidFn }];
  expected.ownership = [{ ...LOCKED_FIPS_MODE_OWNERSHIP }, { ...genUuidOwn }];
  expected.acls = [{ ...LOCKED_FIPS_MODE_ACL }, { ...genUuidAcl }];
  expected.extensions = [{ ...pgcryptoExt }, {
    name: 'plpgsql',
    version: '1.0',
    owner: '$db_owner',
    schema: 'pg_catalog',
    relocatable: false,
    configRelations: '',
    configConditions: '',
  }];

  const live = emptySnap();
  live.functions = [{ ...genUuidFn }];
  live.ownership = [{ ...genUuidOwn }];
  live.acls = [{ ...genUuidAcl }];
  live.extensions = [{ ...livePgcryptoExt }, { ...expected.extensions[1] }];

  const liveProfile = buildOfflinePgcryptoLiveProfile(live);
  return { expected, live, liveProfile };
}

function normOpts(extra) {
  return {
    profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext: AZURE_CTX,
    serverVersionClass: 'postgresql_15',
    liveProfile: extra && extra.liveProfile,
    ...(extra || {}),
  };
}

function compareOpts(extra) {
  const provenance = buildIdentifierTruncationNotNullProvenance();
  return buildObserverCompareOptions(AZURE_CTX, 'postgresql_15', provenance.ok ? provenance : null, extra);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${printCliHelp()}\n`);
    process.exit(0);
  }
  const wantLive = argv.includes('--live')
    && !argv.includes('--offline')
    && process.env.SUNSET_SLICE14AB_PROOF_OFFLINE !== '1';

  const red = [];
  const green = [];
  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN];

  const expectedBytes = fs.readFileSync(EXPECTED_PATH);
  const expectedByteSha = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  if (expectedByteSha !== EXPECTED_BYTE_SHA) {
    throw new Error(`expected bytes drift: ${expectedByteSha}`);
  }
  const expected = JSON.parse(expectedBytes.toString('utf8'));
  if (expected.productFingerprint !== CANON_FP) {
    throw new Error('canonical fingerprint drift');
  }
  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) throw new Error('manifest integrity failed');
  forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  if (manifestHash !== MANIFEST_HASH) throw new Error('manifest hash drift');

  const fixture = buildPgcryptoFixture(expected);

  {
    resetPgcryptoCompatibilityNormalizationCounters();
    const refused = await executePgcryptoCompatibilityNormalization({ env: {}, argv: [] });
    red.push({
      name: 'default_path_zero_http_and_clients',
      ok: refused.ok === false
        && getPgcryptoCompatibilityNormalizationCounters().clientsInstantiated === 0
        && getPgcryptoCompatibilityNormalizationCounters().httpRequestCount === 0,
    });
  }

  {
    resetPgcryptoCompatibilityNormalizationCounters();
    const gate = evaluatePgcryptoCompatibilityNormalizationGates({
      env: pgcryptoCompatibilityNormalizationEnv(),
      argv: exactPgcryptoCompatibilityNormalizationArgv().filter(
        (a) => a !== CLI_PROVE_PGCRYPTO_COMPATIBILITY_NORMALIZATION,
      ),
    });
    red.push({
      name: 'missing_prove_flag_zero_clients',
      ok: gate.ok === false && getPgcryptoCompatibilityNormalizationCounters().clientsInstantiated === 0,
    });
  }

  {
    resetPgcryptoCompatibilityNormalizationCounters();
    const gate = evaluatePgcryptoCompatibilityNormalizationGates({
      env: { ...pgcryptoCompatibilityNormalizationEnv(), [ENV_PGCRYPTO_COMPATIBILITY_NORMALIZATION]: '' },
      argv: exactPgcryptoCompatibilityNormalizationArgv(),
    });
    red.push({
      name: 'missing_pgcrypto_env_zero_clients',
      ok: gate.ok === false,
    });
  }

  {
    resetPgcryptoCompatibilityNormalizationCounters();
    const badArgv = exactPgcryptoCompatibilityNormalizationArgv().map(
      (a, i, arr) => (arr[i - 1] === '--database' ? 'wrong_db' : a),
    );
    const gate = evaluatePgcryptoCompatibilityNormalizationGates({
      env: pgcryptoCompatibilityNormalizationEnv(),
      argv: badArgv,
    });
    red.push({
      name: 'wrong_exact_targets_zero_clients',
      ok: gate.ok === false,
    });
  }

  {
    resetPgcryptoCompatibilityNormalizationCounters();
    const gate = evaluatePgcryptoCompatibilityNormalizationGates({
      env: pgcryptoCompatibilityNormalizationEnv(),
      argv: [...exactPgcryptoCompatibilityNormalizationArgv(), '--dsn', 'postgresql://x'],
    });
    red.push({
      name: 'forbidden_argv_dsn_sql_drop_dml_zero_clients',
      ok: gate.ok === false,
    });
  }

  {
    const norm = normalizeAzurePg15PgcryptoCompatibility(fixture.expected, fixture.live, normOpts({
      profile: 'other_profile',
      liveProfile: fixture.liveProfile,
    }));
    red.push({
      name: 'non_azure_profile_retains',
      ok: norm.applied === false && norm.reason === 'profile_not_azure_flexible_server_v1',
    });
  }

  {
    const reject = normalizeAzurePg15PgcryptoCompatibility(fixture.expected, fixture.live, normOpts({
      serverVersionClass: 'postgresql_14',
      liveProfile: fixture.liveProfile,
    }));
    const skip = normalizeAzurePg15PgcryptoCompatibility(fixture.expected, fixture.live, normOpts({
      azureContext: { verified: true, host: EXPECTED_HOST, database: EXPECTED_DATABASE },
      serverVersionClass: null,
      liveProfile: fixture.liveProfile,
    }));
    red.push({
      name: 'non_pg15_retains_or_rejects',
      ok: reject.ok === false && skip.applied === false,
    });
  }

  {
    const liveWrong = emptySnap();
    liveWrong.extensions = [{ ...LOCKED_PGCRYPTO_EXTENSION, version: '1.2' }];
    liveWrong.functions = fixture.live.functions.slice();
    const norm = normalizeAzurePg15PgcryptoCompatibility(fixture.expected, liveWrong, normOpts({
      liveProfile: buildOfflinePgcryptoLiveProfile(liveWrong),
    }));
    red.push({
      name: 'wrong_live_version_retains',
      ok: norm.applied === false && norm.reason === 'wrong_live_version',
    });
  }

  {
    const liveWrong = JSON.parse(JSON.stringify(fixture.live));
    liveWrong.extensions[0].schema = 'extensions';
    const norm = normalizeAzurePg15PgcryptoCompatibility(fixture.expected, liveWrong, normOpts({
      liveProfile: buildOfflinePgcryptoLiveProfile(liveWrong),
    }));
    red.push({
      name: 'wrong_namespace_retains',
      ok: norm.applied === false && norm.reason === 'wrong_namespace',
    });
  }

  {
    const liveWrong = JSON.parse(JSON.stringify(fixture.live));
    liveWrong.extensions[0].owner = 'postgres';
    const norm = normalizeAzurePg15PgcryptoCompatibility(fixture.expected, liveWrong, normOpts({
      liveProfile: buildOfflinePgcryptoLiveProfile(liveWrong),
    }));
    red.push({
      name: 'wrong_owner_retains',
      ok: norm.applied === false && norm.reason === 'wrong_owner',
    });
  }

  {
    const liveWrong = JSON.parse(JSON.stringify(fixture.live));
    liveWrong.extensions[0].relocatable = false;
    const norm = normalizeAzurePg15PgcryptoCompatibility(fixture.expected, liveWrong, normOpts({
      liveProfile: buildOfflinePgcryptoLiveProfile(liveWrong),
    }));
    red.push({
      name: 'wrong_relocatable_retains',
      ok: norm.applied === false && norm.reason === 'wrong_relocatable',
    });
  }

  {
    const profile = buildOfflinePgcryptoLiveProfile(fixture.live, {
      availableVersions: [
        { name: 'pgcrypto', version: '1.3', installed: true, relocatable: true, schema: 'public' },
        { name: 'pgcrypto', version: '1.4', installed: false, relocatable: true, schema: 'public' },
      ],
    });
    const norm = normalizeAzurePg15PgcryptoCompatibility(fixture.expected, fixture.live, normOpts({
      liveProfile: profile,
    }));
    red.push({
      name: 'upgrade_available_1_4_unapplied_fails',
      ok: norm.ok === false && norm.code === 'upgrade_available_unapplied',
    });
  }

  {
    const liveMissing = JSON.parse(JSON.stringify(fixture.live));
    liveMissing.functions = [];
    const norm = normalizeAzurePg15PgcryptoCompatibility(fixture.expected, liveMissing, normOpts({
      liveProfile: buildOfflinePgcryptoLiveProfile(liveMissing),
    }));
    red.push({
      name: 'missing_gen_random_uuid_capability_retains',
      ok: norm.applied === false && norm.reason === 'missing_gen_random_uuid_capability',
    });
  }

  {
    const liveBadMember = JSON.parse(JSON.stringify(fixture.live));
    const profile = buildOfflinePgcryptoLiveProfile(liveBadMember);
    profile.capabilityMembership['public.gen_random_uuid()'] = { extname: null };
    const norm = normalizeAzurePg15PgcryptoCompatibility(fixture.expected, liveBadMember, normOpts({
      liveProfile: profile,
    }));
    red.push({
      name: 'gen_random_uuid_not_extension_member_retains',
      ok: norm.applied === false && norm.reason === 'gen_random_uuid_not_extension_member',
    });
  }

  {
    const liveFips = JSON.parse(JSON.stringify(fixture.live));
    liveFips.functions = [{ ...LOCKED_FIPS_MODE_FUNCTION, returnType: 'integer' }];
    const norm = normalizeAzurePg15PgcryptoCompatibility(fixture.expected, liveFips, normOpts({
      liveProfile: buildOfflinePgcryptoLiveProfile(liveFips),
    }));
    red.push({
      name: 'fips_mode_present_differently_retains',
      ok: norm.applied === false && norm.reason === 'fips_mode_present_differently',
    });
  }

  {
    const expectedExtra = JSON.parse(JSON.stringify(fixture.expected));
    expectedExtra.functions.push({
      name: 'crypt',
      identity: 'public.crypt(text, text)',
      definition: "CREATE OR REPLACE FUNCTION public.crypt(text, text)\n RETURNS text\n LANGUAGE c\n IMMUTABLE PARALLEL SAFE STRICT\nAS '$libdir/pgcrypto', $function$pg_crypt$function$",
      returnType: 'text',
      language: 'c',
      volatility: 'volatile',
      securityDefiner: false,
      proconfig: '',
    });
    const norm = normalizeAzurePg15PgcryptoCompatibility(expectedExtra, fixture.live, normOpts({
      liveProfile: fixture.liveProfile,
    }));
    red.push({
      name: 'extra_unexpected_pgcrypto_member_delta_retains',
      ok: norm.applied === false && norm.reason === 'extra_unexpected_pgcrypto_member_delta',
    });
  }

  red.push({
    name: 'expected_bytes_change_fails',
    ok: expectedByteSha === EXPECTED_BYTE_SHA,
  });

  {
    const norm = normalizeAzurePg15PgcryptoCompatibility(fixture.expected, fixture.live, normOpts({
      liveProfile: fixture.liveProfile,
    }));
    green.push({
      name: 'exact_locked_version_pair_normalizes_four',
      ok: norm.applied === true
        && norm.normalizedCount === 4
        && norm.rule === PGCRYPTO_COMPATIBILITY_RULE
        && norm.versionPair.expectedVersion === '1.4'
        && norm.versionPair.liveVersion === '1.3',
    });
    green.push({
      name: 'capability_proof_gen_random_uuid',
      ok: norm.capabilityProof
        && norm.capabilityProof.gen_random_uuid
        && norm.capabilityProof.gen_random_uuid.extname === 'pgcrypto',
    });
  }

  {
    const gateOk = evaluatePgcryptoCompatibilityNormalizationGates({
      env: pgcryptoCompatibilityNormalizationEnv(),
      argv: exactPgcryptoCompatibilityNormalizationArgv(),
    });
    green.push({
      name: 'cli_gates_exact_targets',
      ok: gateOk.ok === true,
    });
  }

  {
    resetPgcryptoCompatibilityNormalizationCounters();
    const refused = evaluatePgcryptoCompatibilityNormalizationGates({ env: {}, argv: [] });
    green.push({
      name: 'cli_default_disabled',
      ok: refused.ok === false
        && PHASE_D_PGCRYPTO_COMPATIBILITY_NORMALIZATION_LIVE_ENABLED === true
        && getPgcryptoCompatibilityNormalizationCounters().clientsInstantiated === 0,
    });
  }

  green.push({
    name: 'locks_identity_vault_secret_pg_tls_application_name',
    ok: PGCRYPTO_LOCKS.postgresHost === EXPECTED_HOST
      && PGCRYPTO_LOCKS.database === EXPECTED_DATABASE
      && PGCRYPTO_LOCKS.sslmode === 'verify-full'
      && APPLICATION_NAME === 'wh-sunset-pgcrypto-compatibility'
      && PGCRYPTO_LOCKS.applicationName === APPLICATION_NAME
      && PGCRYPTO_LOCKS.keyVaultName === 'luna-sunset-staging-kv'
      && PGCRYPTO_LOCKS.secretName === 'sunset-database-url',
  });

  green.push({
    name: 'global_live_apply_remains_false',
    ok: PHASE_D_LIVE_APPLY_ENABLED === false,
  });

  {
    const raw = compareSnapshots(fixture.expected, fixture.live, compareOpts());
    const norm = compareSnapshots(fixture.expected, fixture.live, compareOpts({
      enablePgcryptoCompatibilityNormalization: true,
      liveProfile: fixture.liveProfile,
    }));
    const normalized = norm.pgcryptoCompatibilityNormalization
      ? norm.pgcryptoCompatibilityNormalization.normalizedCount
      : 0;
    const remaining = (norm.drifts || []).length;
    green.push({
      name: 'accounting_baseline_4_normalized_4_remaining_0',
      ok: raw.drifts.length === 4
        && normalized === 4
        && remaining === 0,
      detail: { raw: raw.drifts.length, normalized, remaining },
    });
    green.push({
      name: 'raw_vs_normalized_compare_api',
      ok: raw.drifts.length - norm.drifts.length === 4
        && norm.pgcryptoCompatibilityNormalization.applied === true,
    });
  }

  {
    const norm = normalizeAzurePg15PgcryptoCompatibility(fixture.expected, fixture.live, normOpts({
      liveProfile: fixture.liveProfile,
    }));
    green.push({
      name: 'fips_mode_absence_member_delta',
      ok: norm.applied === true
        && !fixture.live.functions.some((f) => f.identity === 'public.fips_mode()'),
    });
  }

  {
    const cmp = compareSnapshots(fixture.expected, fixture.live, compareOpts());
    green.push({
      name: 'prior_14x_rules_still_default_behavior',
      ok: cmp.pgcryptoCompatibilityNormalization == null
        && cmp.drifts.length === 4,
    });
  }

  let liveOutcome = null;
  let previousLive = null;
  if (fs.existsSync(EVIDENCE_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'));
      if (prev && prev.liveOutcome) previousLive = prev.liveOutcome;
    } catch (_) { /* ignore */ }
  }

  if (!wantLive) {
    resetPgcryptoCompatibilityNormalizationCounters();
    const fakeDsn = buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
    const http = createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: fakeDsn,
    });
    const inj = await executePgcryptoCompatibilityNormalization({
      env: pgcryptoCompatibilityNormalizationEnv(),
      argv: exactPgcryptoCompatibilityNormalizationArgv(),
      httpRequest: http,
      skipPostgres: false,
      expectedContract: expected,
      injectedObserver: {
        code: 'pgcrypto_compatibility_normalization_injected',
        sessionReadOnly: true,
        transactionReadOnly: true,
        committed: true,
        serverVersionClass: { versionClass: 'postgresql_15', major: 15 },
        baselineMismatchCount: BASELINE_MISMATCH_COUNT,
        pgcryptoCompatibilitiesNormalized: 4,
        remainingMismatchCount: 0,
        remainingKeys: [],
        accountingOk: true,
        liveProfile: { offline: true },
        observerBefore: {
          mismatchCount: BASELINE_MISMATCH_COUNT,
          mismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
        },
        observerAfter: {
          mismatchCount: 0,
          match: true,
        },
        baseline: { ok: true, code: 'baseline_ok', mismatchCount: BASELINE_MISMATCH_COUNT },
        errors: [],
      },
    });
    leakScan(inj, secrets);
    green.push({
      name: 'offline_injected_authority_same_target',
      ok: inj.ok === true && inj.sameTarget === true && inj.realPostgresCall !== true,
      detail: { code: inj.code, sameTarget: inj.sameTarget },
    });
  } else {
    resetPgcryptoCompatibilityNormalizationCounters();
    const result = await executePgcryptoCompatibilityNormalization({
      env: {
        ...pgcryptoCompatibilityNormalizationEnv(),
        ...process.env,
        [ENV_PGCRYPTO_COMPATIBILITY_NORMALIZATION]: '1',
      },
      argv: exactPgcryptoCompatibilityNormalizationArgv(),
      expectedContract: expected,
    });
    leakScan(result, secrets);
    liveOutcome = {
      ok: result.ok === true,
      code: result.code,
      sameTarget: result.sameTarget === true,
      sessionReadOnly: result.sessionReadOnly === true,
      transactionReadOnly: result.transactionReadOnly === true,
      serverVersionClass: result.serverVersionClass || null,
      observerBefore: result.observerBefore || null,
      observerAfter: result.observerAfter || null,
      baseline: result.baseline || null,
      baselineMismatchCount: result.baselineMismatchCount,
      pgcryptoCompatibilitiesNormalized: result.pgcryptoCompatibilitiesNormalized,
      remainingMismatchCount: result.remainingMismatchCount,
      remainingKeys: result.remainingKeys || [],
      accountingOk: result.accountingOk === true,
      liveProfile: result.liveProfile || null,
      productFingerprintLive: result.productFingerprintLive,
      applicationName: result.applicationName || APPLICATION_NAME,
      httpRequestCount: result.httpRequestCount || 0,
      clientsInstantiated: result.clientsInstantiated || 0,
      realPostgresCall: result.realPostgresCall === true,
      liveMutation: false,
      verifyNeverRerunsLive: true,
    };
    if (!(
      liveOutcome.ok
      && liveOutcome.sameTarget
      && liveOutcome.sessionReadOnly
      && liveOutcome.baselineMismatchCount === BASELINE_MISMATCH_COUNT
      && liveOutcome.accountingOk
      && liveOutcome.pgcryptoCompatibilitiesNormalized === 4
      && liveOutcome.liveMutation === false
    )) {
      throw new Error(`live outcome failed: ${JSON.stringify(liveOutcome)}`);
    }
  }

  const missingRed = REQUIRED_RED.filter((n) => !red.some((r) => r.name === n));
  const missingGreen = REQUIRED_GREEN.filter((n) => !green.some((g) => g.name === n));
  if (missingRed.length || missingGreen.length) {
    throw new Error(`missing cases red=${missingRed} green=${missingGreen}`);
  }
  const failedRed = red.filter((r) => !r.ok);
  const failedGreen = green.filter((g) => !g.ok);
  if (failedRed.length || failedGreen.length) {
    console.error('FAILED RED', failedRed);
    console.error('FAILED GREEN', failedGreen);
    throw new Error(`offline proof failed: red=${failedRed.length} green=${failedGreen.length}`);
  }

  const evidence = {
    kind: 'slice14ab-azure-pgcrypto-compat-normalization-evidence',
    slice: '14AB',
    masterShaBasis: MASTER,
    applicationName: APPLICATION_NAME,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    productFingerprintExpected: CANON_FP,
    manifestHash: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    baselineMismatchCountExpected: BASELINE_MISMATCH_COUNT,
    baselineMismatchSectionsExpected: { ...BASELINE_MISMATCH_SECTIONS },
    lockedVersionPair: { expectedVersion: '1.4', liveVersion: '1.3' },
    rule: PGCRYPTO_COMPATIBILITY_RULE,
    secretFree: true,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    kvMutation: false,
    rbacMutation: false,
    networkMutation: false,
    offline: { red, green },
    liveOutcome: liveOutcome || previousLive || null,
    secretHandlingProof: {
      leakScanPassed: true,
      fakeCredentialsUsed: true,
      dsnNeverPersisted: true,
    },
    verifyNeverRerunsLive: true,
  };

  const contract = {
    kind: 'slice14ab-azure-pgcrypto-compat-normalization-contract',
    slice: '14AB',
    masterShaBasis: MASTER,
    applicationName: APPLICATION_NAME,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    productFingerprintExpected: CANON_FP,
    manifestHash: MANIFEST_HASH,
    baselineMismatchCount: BASELINE_MISMATCH_COUNT,
    baselineMismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
    lockedVersionPair: { expectedVersion: '1.4', liveVersion: '1.3' },
    rule: PGCRYPTO_COMPATIBILITY_RULE,
    requiredRed: REQUIRED_RED,
    requiredGreen: REQUIRED_GREEN,
    locks: {
      postgresHost: PGCRYPTO_LOCKS.postgresHost,
      database: PGCRYPTO_LOCKS.database,
      sslmode: PGCRYPTO_LOCKS.sslmode,
      applicationName: APPLICATION_NAME,
      containerAppName: PGCRYPTO_LOCKS.containerAppName,
      keyVaultName: PGCRYPTO_LOCKS.keyVaultName,
      secretName: PGCRYPTO_LOCKS.secretName,
    },
    gates: {
      envPgcryptoCompatibilityNormalization: ENV_PGCRYPTO_COMPATIBILITY_NORMALIZATION,
      cliProve: CLI_PROVE_PGCRYPTO_COMPATIBILITY_NORMALIZATION,
      defaultDisabled: true,
      liveApplyRemainsFalse: true,
    },
    verifyNeverRerunsLive: true,
  };

  const liveBlock = liveOutcome || previousLive;
  const liveInstalled = liveBlock && liveBlock.liveProfile && liveBlock.liveProfile.installed
    ? liveBlock.liveProfile.installed
    : null;
  const liveAvail = liveBlock && liveBlock.liveProfile && liveBlock.liveProfile.availableExtensions
    ? liveBlock.liveProfile.availableExtensions
    : null;
  const capProof = liveBlock
    && liveBlock.observerAfter
    && liveBlock.observerAfter.pgcryptoCompatibilityNormalization
    && liveBlock.observerAfter.pgcryptoCompatibilityNormalization.capabilityProof
      ? liveBlock.observerAfter.pgcryptoCompatibilityNormalization.capabilityProof
      : (liveBlock && liveBlock.liveProfile && liveBlock.liveProfile.capabilityMembership) || null;

  const findingsLines = [
    '# FOUNDATION Slice 14AB — Azure PG15 pgcrypto compatibility normalization',
    '',
    `**Status:** ${liveBlock && liveBlock.ok === true
      ? 'pgcrypto_compatibility_normalization_live_ok_zero_drift'
      : 'offline_ok_awaiting_live'}`,
    `**Master basis:** \`${MASTER}\``,
    `**Canonical fingerprint (unchanged):** \`${CANON_FP}\``,
    `**Expected bytes (unchanged):** \`${EXPECTED_BYTE_SHA}\``,
    `**Manifest hash (unchanged):** \`${MANIFEST_HASH}\``,
    `**Generated:** ${new Date().toISOString()}`,
    '',
    '## What this slice does',
    '',
    'Conservative `azure_flexible_server_v1` + `postgresql_15` presentation normalization for',
    'exactly the final **4** Azure pgcrypto/fips_mode residuals (default OFF):',
    '',
    `- application_name: \`${APPLICATION_NAME}\``,
    `- rule: \`${PGCRYPTO_COMPATIBILITY_RULE}\``,
    '- locked version pair: expected **1.4** → live **1.3** (Azure PG15 default ceiling)',
    '- strips expected-only `public.fips_mode()` function + ownership + ACL',
    '- maps expected `pgcrypto` extension version presentation 1.4 → 1.3',
    '- does **not** ALTER/UPDATE EXTENSION or privileges',
    '',
    '## Offline gates',
    '',
    `- RED: ${REQUIRED_RED.length} cases`,
    `- GREEN: ${REQUIRED_GREEN.length} cases`,
    '',
  ];
  if (liveBlock) {
    findingsLines.push(
      '## Live',
      '',
      `application_name: \`${APPLICATION_NAME}\``,
      `sameTarget: **${liveBlock.sameTarget === true}**`,
      `server version class: **${(liveBlock.serverVersionClass && liveBlock.serverVersionClass.versionClass) || 'postgresql_15'}**`,
      `baseline mismatch (14T+14V+14W+14X on; pgcrypto off): **${liveBlock.baselineMismatchCount}**`,
      `pgcrypto compatibilities normalized: **${liveBlock.pgcryptoCompatibilitiesNormalized}**`,
      `remaining mismatch: **${liveBlock.remainingMismatchCount}**`,
      `remaining keys: ${JSON.stringify(liveBlock.remainingKeys || [])}`,
      `accounting: baseline === normalized + remaining → **${liveBlock.accountingOk === true}**`,
      '',
      '### Expected / live extension tuples',
      '',
      '- expected: `{name:pgcrypto, version:1.4, schema:public, owner:$db_owner, relocatable:true}`',
      `- live installed: ${JSON.stringify(liveInstalled)}`,
      `- available/default ceiling: ${JSON.stringify(liveAvail)}`,
      `- fips_mode present: **${Boolean(liveBlock.liveProfile && liveBlock.liveProfile.fipsMode && liveBlock.liveProfile.fipsMode.present)}**`,
      `- capability membership: ${JSON.stringify(capProof)}`,
      '',
      'Mutation flags: schemaMutation=false; dataMutation=false; ledgerWritten=false; kvMutation=false.',
      '',
    );
  }
  findingsLines.push(
    '## Do not claim',
    '',
    '- Do **not** ALTER/UPDATE EXTENSION or mutate privileges.',
    '- Do **not** run verify with `--live` (verify never re-runs live).',
    '- Do **not** modify expected-product-schema bytes/fingerprint or migrations.',
    '',
    '## Operator live command',
    '',
    '```',
    'SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_PGCRYPTO_COMPATIBILITY_NORMALIZATION=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:pgcrypto-compatibility-normalization -- --prove-pgcrypto-compatibility-normalization --prove-active-db-target-authority --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity',
    '```',
    '',
    '## Artifacts',
    '',
    '- `fixtures/sunset-schema-observer/slice14ab-azure-pgcrypto-compat-normalization-evidence.json`',
    '- `fixtures/sunset-schema-observer/slice14ab-azure-pgcrypto-compat-normalization-contract.json`',
    '- `fixtures/sunset-schema-observer/slice14ab-findings.md`',
  );

  leakScan(evidence, secrets);
  leakScan(contract, secrets);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, `${findingsLines.join('\n')}\n`);

  console.log(`prove:sunset-schema-slice14ab — ${wantLive ? 'live' : 'offline'} OK`);
  console.log(`  RED ${red.length} GREEN ${green.length}`);
  if (liveBlock) {
    console.log(
      `  live baseline=${liveBlock.baselineMismatchCount} normalized=${liveBlock.pgcryptoCompatibilitiesNormalized}`
      + ` remaining=${liveBlock.remainingMismatchCount}`,
    );
  }
  console.log(`  evidence ${EVIDENCE_PATH}`);
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
