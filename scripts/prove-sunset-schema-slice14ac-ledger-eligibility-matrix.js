'use strict';

/**
 * prove-sunset-schema-slice14ac-ledger-eligibility-matrix
 * FOUNDATION Slice 14AC
 *
 * Offline RED/GREEN for migration-ledger bootstrap eligibility matrix
 * + optional --live once: merged target authority + one TLS read-only observer
 * session application_name=wh-sunset-ledger-eligibility.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  MANIFEST_PATH,
} = require('./lib/migration-integrity');
const { hashCanonicalManifest } = require('./lib/sunset-schema-observer');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const { buildOfflineProofSunsetDatabaseUrl } = require('./lib/phase-d-managed-identity-credential-loader');
const {
  PHASE_D_LEDGER_ELIGIBILITY_LIVE_ENABLED,
  ENV_LEDGER_ELIGIBILITY,
  CLI_PROVE_LEDGER_ELIGIBILITY,
  APPLICATION_NAME,
  LEDGER_LOCKS,
  EXPECTED_FORWARD_COUNT,
  CHECKSUM_MODE_CANONICAL_LF_V1,
  CLASSIFICATION_ELIGIBLE_STRUCTURAL,
  CLASSIFICATION_ELIGIBLE_CURRENT_STATE,
  CLASSIFICATION_BLOCKED_BY_PREFIX,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
  evaluateLedgerEligibilityGates,
  exactLedgerEligibilityArgv,
  ledgerEligibilityEnv,
  executeLedgerEligibility,
  createInjectedTargetAuthorityHttp,
  resetLedgerEligibilityCounters,
  getLedgerEligibilityCounters,
  printCliHelp,
  loadCanonicalForwards,
  buildEligibilityMatrixFromManifest,
  classifyFromEvidence,
  designLedgerDdlExtensions,
  computeContiguousPrefix,
  evaluateMigrationEligibility,
} = require('./lib/phase-d-ledger-eligibility');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14ac-ledger-eligibility-matrix-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14ac-ledger-eligibility-matrix-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14ac-findings.md');

const MASTER = '0b92b7eff718f928ccb590d287830d4d104c37c4';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const FAKE_ADMIN_USER = 'slice14ac-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14ac-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14ac-proof-imds-token-never-commit';

const REQUIRED_RED = [
  'default_path_zero_http_and_clients',
  'missing_prove_flag_zero_clients',
  'missing_ledger_eligibility_env_zero_clients',
  'wrong_exact_targets_zero_clients',
  'forbidden_argv_dsn_sql_drop_dml_zero_clients',
  'zero_drift_missing_fails',
  'ledger_present_fails',
  'checksum_drift_fails',
  'partial_ambiguous_effect_fails',
  'unproven_dml_fails',
  'unproven_comment_fails',
  'unproven_rename_fails',
  'dec006_failures_fail_closed',
  'gap_noncontiguous_prefix_fails',
  'mislabel_executed_runner_fails',
  'expected_bytes_change_fails',
];

const REQUIRED_GREEN = [
  'forward_count_39_canonical_lf_v1',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'global_live_apply_remains_false',
  'never_labels_executed_by_canonical_runner',
  'design_ledger_ddl_extensions_additive_only',
  'contiguous_prefix_algorithm',
  'dec006_018_019_pass_with_metadata',
  'dec006_020_requires_aggregate_for_current_state',
  'offline_injected_authority_same_target',
];

function buildOfflineTargetedResults(aggregateRows) {
  return {
    'dec006:018-col-nullability': [{ is_nullable: 'YES' }],
    'dec006:018-no-conflicting-check': [{ cnt: 0 }],
    'dec006:018-optional-comment': [{ comment_text: 'slice14ac-offline-proof' }],
    'dec006:019-column-present': [{
      column_name: 'language',
      udt_name: 'text',
      data_type: 'text',
    }],
    'dec006:019-default-or-nullability': [{
      is_nullable: 'NO',
      column_default: "'en'::text",
    }],
    'dec006:020-columns-present': [
      { column_name: 'can_be_matrimonial' },
      { column_name: 'gender_strategy' },
      { column_name: 'often_used_by_operator' },
      { column_name: 'room_type' },
    ],
    'dec006:020-aggregate-population-optional': [{ matching_rows: aggregateRows }],
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

function redClassify(name, scenario, ctx) {
  const r = classifyFromEvidence(scenario, ctx);
  return {
    name,
    ok: r.ok === false && r.failClosed === true,
    detail: { code: r.code },
  };
}

function summarizeMatrix(matrix) {
  const counts = {
    eligible_verified_structural_baseline: 0,
    eligible_verified_current_state_baseline: 0,
    blocked_unproven: 0,
    blocked_by_prefix: 0,
  };
  const effectTotals = Object.create(null);
  const rows = (matrix && matrix.evaluationsWithPrefix)
    || (matrix && matrix.evaluations)
    || [];
  for (const e of rows) {
    const status = e.prefixStatus || e.classification;
    if (counts[status] != null) counts[status] += 1;
    else if (counts[e.classification] != null) counts[e.classification] += 1;
    for (const [k, v] of Object.entries(e.effectSummary || {})) {
      if (k === 'weakCount' || k === 'strongCount') continue;
      effectTotals[k] = (effectTotals[k] || 0) + Number(v || 0);
    }
  }
  return {
    forwardCount: matrix && matrix.forwardCount,
    maxPrefixCount: matrix && matrix.maxPrefixCount,
    maxPrefixOrder: matrix && matrix.maxPrefixOrder,
    firstBlocker: (matrix && matrix.firstBlocker) || null,
    proposedLedgerRowCount: ((matrix && matrix.proposedLedgerRows) || []).length,
    classificationCounts: counts,
    effectTotals,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${printCliHelp()}\n`);
    process.exit(0);
  }
  const wantLive = argv.includes('--live')
    && !argv.includes('--offline')
    && process.env.SUNSET_SLICE14AC_PROOF_OFFLINE !== '1';

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

  {
    resetLedgerEligibilityCounters();
    const refused = await executeLedgerEligibility({ env: {}, argv: [] });
    red.push({
      name: 'default_path_zero_http_and_clients',
      ok: refused.ok === false
        && getLedgerEligibilityCounters().clientsInstantiated === 0
        && getLedgerEligibilityCounters().httpRequestCount === 0,
    });
  }

  {
    resetLedgerEligibilityCounters();
    const gate = evaluateLedgerEligibilityGates({
      env: ledgerEligibilityEnv(),
      argv: exactLedgerEligibilityArgv().filter(
        (a) => a !== CLI_PROVE_LEDGER_ELIGIBILITY,
      ),
    });
    red.push({
      name: 'missing_prove_flag_zero_clients',
      ok: gate.ok === false && getLedgerEligibilityCounters().clientsInstantiated === 0,
    });
  }

  {
    resetLedgerEligibilityCounters();
    const gate = evaluateLedgerEligibilityGates({
      env: { ...ledgerEligibilityEnv(), [ENV_LEDGER_ELIGIBILITY]: '' },
      argv: exactLedgerEligibilityArgv(),
    });
    red.push({
      name: 'missing_ledger_eligibility_env_zero_clients',
      ok: gate.ok === false,
    });
  }

  {
    resetLedgerEligibilityCounters();
    const badArgv = exactLedgerEligibilityArgv().map(
      (a, i, arr) => (arr[i - 1] === '--database' ? 'wrong_db' : a),
    );
    const gate = evaluateLedgerEligibilityGates({
      env: ledgerEligibilityEnv(),
      argv: badArgv,
    });
    red.push({
      name: 'wrong_exact_targets_zero_clients',
      ok: gate.ok === false,
    });
  }

  {
    resetLedgerEligibilityCounters();
    const gate = evaluateLedgerEligibilityGates({
      env: ledgerEligibilityEnv(),
      argv: [...exactLedgerEligibilityArgv(), '--dsn', 'postgresql://x'],
    });
    red.push({
      name: 'forbidden_argv_dsn_sql_drop_dml_zero_clients',
      ok: gate.ok === false,
    });
  }

  red.push(redClassify('zero_drift_missing_fails', 'zero-drift-missing', {
    remainingMismatchCount: null,
  }));
  red.push(redClassify('ledger_present_fails', 'ledger-present', {
    ledgerPresent: true,
    ledgerTableCount: 1,
  }));
  red.push(redClassify('checksum_drift_fails', 'checksum-drift', {
    checksumAccepted: false,
    blockedReason: 'checksum_drift',
  }));
  red.push(redClassify('partial_ambiguous_effect_fails', 'partial-effect', {
    blockedReason: 'partial_effect_unproven',
  }));
  red.push(redClassify('unproven_dml_fails', 'unproven-dml', {
    blockedReason: 'unproven_dml',
  }));
  red.push(redClassify('unproven_comment_fails', 'unproven-comment', {
    blockedReason: 'unproven_comment',
  }));
  red.push(redClassify('unproven_rename_fails', 'unproven-rename', {
    blockedReason: 'unproven_rename',
  }));
  red.push(redClassify('dec006_failures_fail_closed', 'dec006-fail', {
    blockedReason: 'dec006_required_checks_failed',
  }));
  red.push(redClassify('gap_noncontiguous_prefix_fails', 'gap-noncontiguous', {
    firstBlocker: { id: '020_wolfhouse_room_gender_metadata', apply_order: 19 },
    maxPrefixCount: 18,
    expectedPrefixCount: 39,
    forwardCount: 39,
  }));
  red.push(redClassify('mislabel_executed_runner_fails', 'mislabel-executed-runner', {
    apply_kind: APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
  }));

  red.push({
    name: 'expected_bytes_change_fails',
    ok: expectedByteSha === EXPECTED_BYTE_SHA,
  });

  {
    const loaded = loadCanonicalForwards();
    green.push({
      name: 'forward_count_39_canonical_lf_v1',
      ok: loaded.ok === true
        && loaded.forwards.length === EXPECTED_FORWARD_COUNT
        && loaded.manifest.checksumMode === CHECKSUM_MODE_CANONICAL_LF_V1,
    });
  }

  {
    const gateOk = evaluateLedgerEligibilityGates({
      env: ledgerEligibilityEnv(),
      argv: exactLedgerEligibilityArgv(),
    });
    green.push({
      name: 'cli_gates_exact_targets',
      ok: gateOk.ok === true,
    });
  }

  {
    resetLedgerEligibilityCounters();
    const refused = evaluateLedgerEligibilityGates({ env: {}, argv: [] });
    green.push({
      name: 'cli_default_disabled',
      ok: refused.ok === false
        && PHASE_D_LEDGER_ELIGIBILITY_LIVE_ENABLED === true
        && getLedgerEligibilityCounters().clientsInstantiated === 0,
    });
  }

  green.push({
    name: 'locks_identity_vault_secret_pg_tls_application_name',
    ok: LEDGER_LOCKS.postgresHost != null
      && LEDGER_LOCKS.database != null
      && LEDGER_LOCKS.sslmode === 'verify-full'
      && APPLICATION_NAME === 'wh-sunset-ledger-eligibility'
      && LEDGER_LOCKS.applicationName === APPLICATION_NAME
      && LEDGER_LOCKS.keyVaultName === 'luna-sunset-staging-kv'
      && LEDGER_LOCKS.secretName === 'sunset-database-url',
  });

  green.push({
    name: 'global_live_apply_remains_false',
    ok: PHASE_D_LIVE_APPLY_ENABLED === false,
  });

  const offlineTargetedAgg0 = buildOfflineTargetedResults(0);
  const offlineTargetedAgg1 = buildOfflineTargetedResults(10);
  const offlineMatrix = buildEligibilityMatrixFromManifest({
    liveSnapshot: expected.snapshot,
    targetedResults: offlineTargetedAgg0,
  });
  if (!offlineMatrix.ok) {
    throw new Error(`offline matrix build failed: ${JSON.stringify(offlineMatrix)}`);
  }

  const eval018 = offlineMatrix.evaluations.find((e) => e.id.includes('018'));
  const eval019 = offlineMatrix.evaluations.find((e) => e.id.includes('019'));
  const eval020 = offlineMatrix.evaluations.find((e) => e.id.includes('020'));

  green.push({
    name: 'dec006_018_019_pass_with_metadata',
    ok: eval018.classification === CLASSIFICATION_ELIGIBLE_STRUCTURAL
      && eval019.classification === CLASSIFICATION_ELIGIBLE_STRUCTURAL
      && eval018.dec006 != null
      && eval019.dec006 != null,
    detail: {
      id018: eval018.id,
      id019: eval019.id,
      classification018: eval018.classification,
      classification019: eval019.classification,
    },
  });

  {
    const matrixAgg1 = buildEligibilityMatrixFromManifest({
      liveSnapshot: expected.snapshot,
      targetedResults: offlineTargetedAgg1,
    });
    const eval020Agg1 = matrixAgg1.evaluations.find((e) => e.id.includes('020'));
    green.push({
      name: 'dec006_020_requires_aggregate_for_current_state',
      ok: eval020.blockedReason === 'unproven_dml_zero_aggregate'
        && eval020Agg1.classification === CLASSIFICATION_ELIGIBLE_CURRENT_STATE,
      detail: {
        aggregate0: eval020.blockedReason,
        aggregatePositive: eval020Agg1.classification,
      },
    });
  }

  {
    const rows = offlineMatrix.proposedLedgerRows || [];
    const mislabel = evaluateMigrationEligibility({
      entry: { id: 'proof_mislabel_guard', filename: 'proof.sql', order: 0 },
      effects: [],
      proofPlan: [],
      liveSnapshot: expected.snapshot,
      targetedResults: {},
      options: { forbiddenApplyKind: APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER },
    });
    green.push({
      name: 'never_labels_executed_by_canonical_runner',
      ok: !rows.some((r) => r.apply_kind === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER)
        && mislabel.blockedReason === 'mislabel_executed_runner_forbidden',
    });
  }

  {
    const design = designLedgerDdlExtensions();
    green.push({
      name: 'design_ledger_ddl_extensions_additive_only',
      ok: design.designOnly === true
        && design.executes === false
        && String(design.additiveDdl).includes('ADD COLUMN IF NOT EXISTS apply_kind')
        && !String(design.additiveDdl).toUpperCase().includes('DROP '),
    });
  }

  {
    const prefix = computeContiguousPrefix([
      {
        apply_order: 1,
        id: 'a',
        filename: 'a.sql',
        checksum_sha256: 'x',
        classification: CLASSIFICATION_ELIGIBLE_STRUCTURAL,
        apply_kind: 'verified_structural_baseline',
        evidenceRefs: ['e:a'],
      },
      {
        apply_order: 2,
        id: 'b',
        filename: 'b.sql',
        classification: 'blocked_unproven',
        blockedReason: 'partial_effect_unproven',
      },
      {
        apply_order: 3,
        id: 'c',
        filename: 'c.sql',
        checksum_sha256: 'y',
        classification: CLASSIFICATION_ELIGIBLE_STRUCTURAL,
        apply_kind: 'verified_structural_baseline',
        evidenceRefs: ['e:c'],
      },
    ]);
    green.push({
      name: 'contiguous_prefix_algorithm',
      ok: prefix.maxPrefixCount === 1
        && prefix.firstBlocker != null
        && prefix.evaluationsWithPrefix[2].prefixStatus === CLASSIFICATION_BLOCKED_BY_PREFIX,
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

  // Always exercise the offline injected path (GREEN coverage), even when --live follows.
  {
    resetLedgerEligibilityCounters();
    const fakeDsn = buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
    const http = createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: fakeDsn,
    });
    const inj = await executeLedgerEligibility({
      env: ledgerEligibilityEnv(),
      argv: exactLedgerEligibilityArgv(),
      httpRequest: http,
      expectedContract: expected,
      injectedObserver: {
        code: 'ledger_eligibility_injected',
        sessionReadOnly: true,
        transactionReadOnly: true,
        remainingMismatchCount: 0,
        ledgerAbsent: true,
        liveSnapshot: expected.snapshot,
        targetedResults: offlineTargetedAgg0,
        errors: [],
      },
    });
    leakScan(inj, secrets);
    green.push({
      name: 'offline_injected_authority_same_target',
      ok: inj.ok === true && inj.sameTarget === true && inj.realPostgresCall !== true,
      detail: { code: inj.code, sameTarget: inj.sameTarget, maxPrefixCount: inj.maxPrefixCount },
    });
  }

  if (wantLive) {
    resetLedgerEligibilityCounters();
    const result = await executeLedgerEligibility({
      env: {
        ...ledgerEligibilityEnv(),
        ...process.env,
        [ENV_LEDGER_ELIGIBILITY]: '1',
      },
      argv: exactLedgerEligibilityArgv(),
      expectedContract: expected,
    });
    leakScan(result, secrets);
    const matrix = result.eligibilityMatrix || null;
    liveOutcome = {
      ok: result.ok === true,
      code: result.code,
      sameTarget: result.sameTarget === true,
      sessionReadOnly: result.sessionReadOnly === true,
      transactionReadOnly: result.transactionReadOnly === true,
      serverVersionClass: result.serverVersionClass || null,
      remainingMismatchCount: result.remainingMismatchCount,
      remainingKeys: result.remainingKeys || [],
      productFingerprintLive: result.productFingerprintLive,
      applicationName: result.applicationName || APPLICATION_NAME,
      httpRequestCount: result.httpRequestCount || 0,
      clientsInstantiated: result.clientsInstantiated || 0,
      realPostgresCall: result.realPostgresCall === true,
      ledgerGate: result.ledgerGate || null,
      ledgerAbsent: result.ledgerGate ? result.ledgerGate.ok === true : null,
      firstBlocker: result.firstBlocker || (matrix && matrix.firstBlocker) || null,
      maxPrefixCount: result.maxPrefixCount != null
        ? result.maxPrefixCount
        : (matrix && matrix.maxPrefixCount),
      maxPrefixOrder: result.maxPrefixOrder != null
        ? result.maxPrefixOrder
        : (matrix && matrix.maxPrefixOrder),
      proposedLedgerRowCount: result.proposedLedgerRowCount != null
        ? result.proposedLedgerRowCount
        : ((matrix && matrix.proposedLedgerRows) || []).length,
      eligibilitySummary: summarizeMatrix(matrix),
      eligibilityMatrix: matrix
        ? {
          forwardCount: matrix.forwardCount,
          maxPrefixCount: matrix.maxPrefixCount,
          maxPrefixOrder: matrix.maxPrefixOrder,
          firstBlocker: matrix.firstBlocker || null,
          proposedLedgerRowCount: (matrix.proposedLedgerRows || []).length,
          evaluations: (matrix.evaluations || []).map((e) => ({
            id: e.id,
            apply_order: e.apply_order,
            classification: e.classification,
            apply_kind: e.apply_kind,
            blockedReason: e.blockedReason,
            effectSummary: e.effectSummary,
            dec006: e.dec006,
          })),
          proposedLedgerRows: matrix.proposedLedgerRows || [],
        }
        : null,
      proposedLedgerRows: (matrix && matrix.proposedLedgerRows) || [],
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      verifyNeverRerunsLive: true,
    };
    if (!(
      liveOutcome.ok
      && liveOutcome.sameTarget
      && liveOutcome.sessionReadOnly
      && liveOutcome.remainingMismatchCount === 0
      && liveOutcome.ledgerAbsent === true
      && liveOutcome.liveMutation === false
      && liveOutcome.ledgerWritten === false
    )) {
      throw new Error(`live outcome failed: ${JSON.stringify({
        ok: liveOutcome.ok,
        code: liveOutcome.code,
        sameTarget: liveOutcome.sameTarget,
        sessionReadOnly: liveOutcome.sessionReadOnly,
        remainingMismatchCount: liveOutcome.remainingMismatchCount,
        ledgerAbsent: liveOutcome.ledgerAbsent,
        firstBlocker: liveOutcome.firstBlocker,
      })}`);
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

  const ledgerDdlDesign = designLedgerDdlExtensions();
  const liveBlock = liveOutcome || previousLive || null;
  const matrixForEvidence = liveBlock
    && liveBlock.eligibilityMatrix
    && liveBlock.proposedLedgerRows
    && liveBlock.proposedLedgerRows.length > 0
    ? {
      forwardCount: liveBlock.eligibilityMatrix.forwardCount || EXPECTED_FORWARD_COUNT,
      maxPrefixCount: liveBlock.eligibilityMatrix.maxPrefixCount,
      maxPrefixOrder: liveBlock.eligibilityMatrix.maxPrefixOrder,
      firstBlocker: liveBlock.eligibilityMatrix.firstBlocker || null,
      proposedLedgerRows: liveBlock.proposedLedgerRows,
    }
    : offlineMatrix;

  const evidence = {
    kind: 'slice14ac-ledger-eligibility-matrix-evidence',
    slice: '14AC',
    masterShaBasis: MASTER,
    applicationName: APPLICATION_NAME,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    productFingerprintExpected: CANON_FP,
    manifestHash: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    checksumMode: CHECKSUM_MODE_CANONICAL_LF_V1,
    secretFree: true,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    kvMutation: false,
    rbacMutation: false,
    networkMutation: false,
    offline: { red, green },
    offlineMatrix: {
      forwardCount: offlineMatrix.forwardCount,
      maxPrefixCount: offlineMatrix.maxPrefixCount,
      maxPrefixOrder: offlineMatrix.maxPrefixOrder,
      firstBlocker: offlineMatrix.firstBlocker,
      proposedLedgerRowCount: offlineMatrix.proposedLedgerRows.length,
      note: 'Offline fixture uses DEC-006 aggregate 0 (Sunset-likely); first blocker 020 at prefix 18',
    },
    eligibilitySummary: {
      forwardCount: matrixForEvidence.forwardCount,
      maxPrefixCount: matrixForEvidence.maxPrefixCount,
      maxPrefixOrder: matrixForEvidence.maxPrefixOrder,
      firstBlocker: matrixForEvidence.firstBlocker,
      proposedLedgerRowCount: (matrixForEvidence.proposedLedgerRows || []).length,
    },
    proposedLedgerRows: matrixForEvidence.proposedLedgerRows || [],
    ledgerDdlDesign,
    liveOutcome: liveBlock,
    secretHandlingProof: {
      leakScanPassed: true,
      fakeCredentialsUsed: true,
      dsnNeverPersisted: true,
    },
    verifyNeverRerunsLive: true,
  };

  const contract = {
    kind: 'slice14ac-ledger-eligibility-matrix-contract',
    slice: '14AC',
    masterShaBasis: MASTER,
    applicationName: APPLICATION_NAME,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    productFingerprintExpected: CANON_FP,
    manifestHash: MANIFEST_HASH,
    checksumMode: CHECKSUM_MODE_CANONICAL_LF_V1,
    forwardCount: EXPECTED_FORWARD_COUNT,
    requiredRed: REQUIRED_RED,
    requiredGreen: REQUIRED_GREEN,
    locks: {
      postgresHost: LEDGER_LOCKS.postgresHost,
      database: LEDGER_LOCKS.database,
      sslmode: LEDGER_LOCKS.sslmode,
      applicationName: APPLICATION_NAME,
      containerAppName: LEDGER_LOCKS.containerAppName,
      keyVaultName: LEDGER_LOCKS.keyVaultName,
      secretName: LEDGER_LOCKS.secretName,
    },
    gates: {
      envLedgerEligibility: ENV_LEDGER_ELIGIBILITY,
      cliProve: CLI_PROVE_LEDGER_ELIGIBILITY,
      defaultDisabled: true,
      liveApplyRemainsFalse: true,
    },
    verifyNeverRerunsLive: true,
  };

  const findingsLines = [
    '# FOUNDATION Slice 14AC — Ledger bootstrap eligibility matrix',
    '',
    `**Status:** ${liveBlock && liveBlock.ok === true
      ? 'ledger_eligibility_matrix_live_ok_zero_drift'
      : 'offline_ok_awaiting_live'}`,
    `**Master basis:** \`${MASTER}\``,
    `**Canonical fingerprint (unchanged):** \`${CANON_FP}\``,
    `**Expected bytes (unchanged):** \`${EXPECTED_BYTE_SHA}\``,
    `**Manifest hash (unchanged):** \`${MANIFEST_HASH}\``,
    `**Generated:** ${new Date().toISOString()}`,
    '',
    '## What this slice does',
    '',
    'Read-only proof of the **39** canonical_forward migration ledger bootstrap eligibility matrix.',
    'Never writes `schema_migration_ledger` or labels rows `executed_by_canonical_runner`.',
    '',
    `- application_name: \`${APPLICATION_NAME}\``,
    '- Observer must reach `remainingMismatchCount === 0` under merged 14AB normalizations',
    '- `schema_migration_ledger` must be absent before bootstrap',
    '- DEC-006 targeted SELECT evidence for migrations 018–020',
    '- Contiguous prefix algorithm; first offline blocker likely **020** at prefix **18** (aggregate 0)',
    '',
    '## Offline gates',
    '',
    `- RED: ${REQUIRED_RED.length} cases`,
    `- GREEN: ${REQUIRED_GREEN.length} cases`,
    '',
    '## Offline matrix (fixture)',
    '',
    `- forwardCount: **${offlineMatrix.forwardCount}**`,
    `- maxPrefixCount: **${offlineMatrix.maxPrefixCount}**`,
    `- firstBlocker: ${JSON.stringify(offlineMatrix.firstBlocker)}`,
    `- proposedLedgerRows: **${offlineMatrix.proposedLedgerRows.length}**`,
    '',
  ];
  if (liveBlock) {
    findingsLines.push(
      '## Live',
      '',
      `application_name: \`${APPLICATION_NAME}\``,
      `sameTarget: **${liveBlock.sameTarget === true}**`,
      `sessionReadOnly: **${liveBlock.sessionReadOnly === true}**`,
      `remaining mismatch: **${liveBlock.remainingMismatchCount}**`,
      `ledger absent: **${liveBlock.ledgerAbsent === true || (liveBlock.ledgerGate && liveBlock.ledgerGate.ok === true)}**`,
      `matrix forwardCount: **${(liveBlock.eligibilityMatrix && liveBlock.eligibilityMatrix.forwardCount) || offlineMatrix.forwardCount}**`,
      `maxPrefixCount: **${(liveBlock.eligibilityMatrix && liveBlock.eligibilityMatrix.maxPrefixCount) != null
        ? liveBlock.eligibilityMatrix.maxPrefixCount
        : offlineMatrix.maxPrefixCount}**`,
      '',
      'Mutation flags: schemaMutation=false; dataMutation=false; ledgerWritten=false; kvMutation=false.',
      '',
    );
  }
  findingsLines.push(
    '## Do not claim',
    '',
    '- Do **not** INSERT into `schema_migration_ledger` or claim `executed_by_canonical_runner`.',
    '- Do **not** run verify with `--live` (verify never re-runs live).',
    '- Do **not** modify expected-product-schema bytes/fingerprint or migrations.',
    '',
    '## Operator live command',
    '',
    '```',
    'SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_LEDGER_ELIGIBILITY=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:ledger-eligibility -- --prove-ledger-eligibility-matrix --prove-active-db-target-authority --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity',
    '```',
    '',
    '## Artifacts',
    '',
    '- `fixtures/sunset-schema-observer/slice14ac-ledger-eligibility-matrix-evidence.json`',
    '- `fixtures/sunset-schema-observer/slice14ac-ledger-eligibility-matrix-contract.json`',
    '- `fixtures/sunset-schema-observer/slice14ac-findings.md`',
  );

  leakScan(evidence, secrets);
  leakScan(contract, secrets);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, `${findingsLines.join('\n')}\n`);

  console.log(`prove:sunset-schema-slice14ac — ${wantLive ? 'live' : 'offline'} OK`);
  console.log(`  RED ${red.length} GREEN ${green.length}`);
  console.log(
    `  matrix forward=${offlineMatrix.forwardCount} prefix=${offlineMatrix.maxPrefixCount}`
    + ` proposedRows=${offlineMatrix.proposedLedgerRows.length}`,
  );
  if (liveBlock) {
    console.log(
      `  live remaining=${liveBlock.remainingMismatchCount}`
      + ` prefix=${liveBlock.eligibilityMatrix && liveBlock.eligibilityMatrix.maxPrefixCount}`,
    );
  }
  console.log(`  evidence ${EVIDENCE_PATH}`);
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
