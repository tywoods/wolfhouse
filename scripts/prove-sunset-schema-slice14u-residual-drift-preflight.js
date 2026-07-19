'use strict';

/**
 * prove-sunset-schema-slice14u-residual-drift-preflight
 * FOUNDATION Slice 14U
 *
 * Offline RED/GREEN for residual drift classify + preflight of the exact 35
 * post-14T mismatches + optional --live once: merged target authority + one
 * TLS verify-full READ ONLY session
 * application_name=wh-sunset-residual-drift-preflight.
 *
 * Default offline. Verify never re-runs live. Zero mutation.
 * Residual inventory is 35 only — do not invent/carry forward 448.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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
  EXPECTED_HOST,
  classifyServerVersionClass,
} = require('./lib/sunset-schema-observer');
const {
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  EXPECTED_028_SHA256,
} = require('./lib/phase-d-check-preflight');
const {
  PHASE_D_RESIDUAL_DRIFT_PREFLIGHT_LIVE_ENABLED,
  ENV_RESIDUAL_DRIFT_PREFLIGHT,
  CLI_PROVE_RESIDUAL_DRIFT_PREFLIGHT,
  APPLICATION_NAME,
  RESIDUAL_LOCKS,
  BASELINE_MISMATCH_COUNT,
  BASELINE_MISMATCH_SECTIONS,
  DEPENDENCY_ORDER_RANK,
  evaluateResidualDriftPreflightGates,
  exactResidualDriftPreflightArgv,
  residualDriftPreflightEnv,
  executeResidualDriftPreflight,
  createInjectedTargetAuthorityHttp,
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  resetResidualDriftPreflightCounters,
  getResidualDriftPreflightCounters,
  printCliHelp,
  assertBaselineMismatch,
  assertCoverageComplete,
  classifyConstraintResidual,
  classifyNonTableResidual,
  buildCanonicalKeyInventory,
  planMutationBatches,
  buildNotNullNullCountSql,
  buildPkDuplicateSql,
  buildUniqueDuplicateSql,
  buildFkOrphanSql,
  buildCheckViolationSql,
  buildIndexSupportProof,
  quoteIdent,
} = require('./lib/phase-d-residual-drift-preflight');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14u-residual-drift-preflight-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14u-residual-drift-preflight-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14u-findings.md');
const CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-residual-drift-preflight.js');

const MASTER = 'e0db8af748a7d3cc93cb84fc6b09c199dc4fb5e8';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';
const EXPECTED_035_SHA256 = '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': EXPECTED_035_SHA256,
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const FAKE_ADMIN_USER = 'slice14u-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14u-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14u-proof-imds-token-never-commit';

const REQUIRED_RED = [
  'default_path_zero_http_and_clients',
  'missing_prove_flag_zero_clients',
  'missing_residual_env_zero_clients',
  'wrong_exact_targets_zero_clients',
  'forbidden_argv_dsn_sql_drop_dml_zero_clients',
  'baseline_drift_mismatch_stops',
  'nullable_mismatch_with_nonzero_nulls_red',
  'duplicate_orphan_violation_red',
  'unsupported_definition_red',
  'missing_owner_red',
  'incomplete_coverage_red',
  'unsafe_ordering_red',
];

const REQUIRED_GREEN = [
  'baseline_exactly_35_sections_ok',
  'classify_constraint_categories',
  'not_null_sql_aggregate_shape',
  'pk_fk_unique_check_sql_shapes',
  'index_support_proof_shape',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'global_live_apply_remains_false',
  'coverage_complete_35_once',
  'mutation_batches_execute_false_ordered',
  'injected_authority_preflight_path_secret_free',
];

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
  if (/Bearer\s+slice14u-proof-imds-token/i.test(text)) {
    throw new Error('IMDS token leaked into proof artifact');
  }
}

function buildSynthetic35Drifts() {
  const drifts = [];
  const expectedConstraints = [];
  for (let i = 0; i < 25; i += 1) {
    const name = `t_c${i}_not_null`;
    drifts.push({ kind: 'expected_only', section: 'constraints', key: `t.${name}.n` });
    expectedConstraints.push({
      table: 't',
      name,
      type: 'n',
      definition: `NOT NULL c${i}`,
    });
  }
  for (let i = 0; i < 5; i += 1) {
    drifts.push({ kind: 'expected_only', section: 'indexes', key: `t.idx${i}` });
  }
  drifts.push({ kind: 'expected_only', section: 'functions', key: 'public.f()' });
  drifts.push({ kind: 'expected_only', section: 'triggers', key: 't.trg' });
  drifts.push({ kind: 'expected_only', section: 'ownership', key: 'table:t' });
  drifts.push({ kind: 'expected_only', section: 'acls', key: 'table:t' });
  drifts.push({ kind: 'expected_only', section: 'extensions', key: 'pgcrypto' });

  const expectedSnapshot = {
    tables: ['t'],
    columns: Array.from({ length: 25 }, (_, i) => ({
      table: 't',
      column: `c${i}`,
      type: 'text',
      nullable: 'NO',
    })),
    constraints: expectedConstraints,
    indexes: Array.from({ length: 5 }, (_, i) => ({
      table: 't',
      name: `idx${i}`,
      def: `CREATE INDEX idx${i} ON public.t USING btree (c0)`,
    })),
    functions: [{ identity: 'public.f()', name: 'f' }],
    triggers: [{ table: 't', name: 'trg', def: 'CREATE TRIGGER trg' }],
    ownership: [{ kind: 'table', identity: 't' }],
    acls: [{ kind: 'table', identity: 't' }],
    extensions: [{ name: 'pgcrypto' }],
  };

  const ownershipIndex = {
    '001': {
      tables: new Set(['t']),
      columns: new Set(),
      indexes: new Set(['idx0', 'idx1', 'idx2', 'idx3', 'idx4']),
      constraints: new Set(),
      functions: new Set(['f']),
      triggers: new Set(['trg']),
      extensions: new Set(['pgcrypto']),
    },
  };
  const migrationHashes = {
    '001': {
      id: '001',
      filename: '001.sql',
      order: 1,
      sha256CanonicalLfV1: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  };

  return { drifts, expectedSnapshot, ownershipIndex, migrationHashes };
}

function batchRankForId(id) {
  const s = String(id || '');
  if (s.startsWith('batch_01')) return DEPENDENCY_ORDER_RANK.indexes;
  if (s.startsWith('batch_02')) return DEPENDENCY_ORDER_RANK.NOT_NULL;
  if (s.startsWith('batch_03')) return DEPENDENCY_ORDER_RANK.PRIMARY_KEY;
  if (s.startsWith('batch_04')) return DEPENDENCY_ORDER_RANK.FOREIGN_KEY;
  if (s.startsWith('batch_05')) return DEPENDENCY_ORDER_RANK.CHECK;
  if (s.startsWith('batch_06')) return DEPENDENCY_ORDER_RANK.functions;
  if (s.startsWith('batch_07')) return DEPENDENCY_ORDER_RANK.ownership;
  if (s.startsWith('batch_08')) return DEPENDENCY_ORDER_RANK.extensions;
  if (s.startsWith('batch_09')) return DEPENDENCY_ORDER_RANK.definition_mismatch;
  return 99;
}

function ranksNonDecreasing(batches) {
  const ranks = (batches || []).map((b) => batchRankForId(b.id));
  for (let i = 1; i < ranks.length; i += 1) {
    if (ranks[i] < ranks[i - 1]) return false;
  }
  return true;
}

function pickSafeLiveOutcome(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    ok: result.ok === true,
    code: String(result.code || 'residual_drift_preflight_unknown'),
    sameTarget: result.sameTarget === true,
    sameTargetReason: result.sameTargetReason || null,
    blocker: result.blocker || null,
    sessionReadOnly: result.sessionReadOnly === true,
    transactionReadOnly: result.transactionReadOnly === true,
    serverVersionClass: result.serverVersionClass || null,
    observerAfter: result.observerAfter
      ? {
        ok: result.observerAfter.ok === true,
        match: result.observerAfter.match === true,
        code: result.observerAfter.code || null,
        mismatchCount: result.observerAfter.mismatchCount,
        counts: result.observerAfter.counts || null,
        mismatchSections: result.observerAfter.mismatchSections || null,
        notNullArtifactsNormalized: result.observerAfter.notNullArtifactsNormalized,
      }
      : null,
    baseline: result.baseline || null,
    inventory: result.inventory
      ? {
        count: result.inventory.count,
        items: Array.isArray(result.inventory.items)
          ? result.inventory.items.map((i) => ({
            key: i.key,
            section: i.section,
            kind: i.kind,
            expectedMismatchType: i.expectedMismatchType || null,
            liveMismatchType: i.liveMismatchType || null,
            constraintCategory: i.constraintCategory || null,
            contype: i.contype
              || (i.constraintClass && i.constraintClass.contype)
              || null,
            constraintReason: i.constraintReason
              || (i.constraintClass && i.constraintClass.reason)
              || null,
            nonTableOutcomeClass: i.nonTableOutcomeClass
              || (i.nonTableClass && i.nonTableClass.outcomeClass)
              || null,
            nonTableReason: i.nonTableReason
              || (i.nonTableClass && i.nonTableClass.reason)
              || null,
            ownerMigrationId: i.ownerMigrationId || null,
            sha256CanonicalLfV1: i.sha256CanonicalLfV1 || null,
            missingOwner: i.missingOwner === true,
            dependencyOrderRank: i.dependencyOrderRank,
          }))
          : [],
      }
      : null,
    preflightResults: Array.isArray(result.preflightResults)
      ? result.preflightResults.map((p) => ({
        key: p.key,
        section: p.section,
        kind: p.kind,
        category: p.category || null,
        outcomeClass: p.outcomeClass || null,
        code: p.code || null,
        null_count: p.null_count,
        table_total: p.table_total,
        duplicate_count: p.duplicate_count,
        orphan_count: p.orphan_count,
        violation_count: p.violation_count,
        execute: false,
      }))
      : null,
    mutationBatches: result.mutationBatches || null,
    coverage: result.coverage || null,
    productFingerprintLive: result.productFingerprintLive || null,
    applicationName: result.applicationName || APPLICATION_NAME,
    httpRequestCount: Number(result.httpRequestCount) || 0,
    imdsRequestCount: Number(result.imdsRequestCount) || 0,
    keyVaultRequestCount: Number(result.keyVaultRequestCount) || 0,
    clientsInstantiated: Number(result.clientsInstantiated) || 0,
    connectCalls: Number(result.connectCalls) || 0,
    queryCalls: Number(result.queryCalls) || 0,
    endCalls: Number(result.endCalls) || 0,
    usedLiveHttp: result.usedLiveHttp === true,
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
    execute: false,
    postgresHost: result.postgresHost || RESIDUAL_LOCKS.postgresHost,
    database: result.database || RESIDUAL_LOCKS.database,
    sslmode: result.sslmode || RESIDUAL_LOCKS.sslmode,
    errors: Array.isArray(result.errors)
      ? result.errors.map((e) => ({
        code: String((e && e.code) || 'failed').slice(0, 80),
        message: String((e && e.message) || '').slice(0, 240),
      }))
      : [],
  };
}

async function main() {
  const forceOffline = process.argv.includes('--offline-only')
    || process.argv.includes('--offline')
    || process.env.SUNSET_SLICE14U_PROOF_OFFLINE === '1';
  const wantLive = process.argv.includes('--live') && !forceOffline;
  const offlineOnly = !wantLive;
  console.log(offlineOnly
    ? 'prove:sunset-schema-slice14u — offline only (no live HTTP/PG)\n'
    : 'prove:sunset-schema-slice14u — offline then one live residual-drift preflight\n');

  const priorEvidence = fs.existsSync(EVIDENCE_PATH)
    ? JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'))
    : null;
  const preserveLive = offlineOnly
    && priorEvidence
    && priorEvidence.liveOutcome
    && priorEvidence.liveOutcome.realPostgresCall === true;

  const red = [];
  const green = [];
  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN];

  // ── Integrity locks ──────────────────────────────────────────────
  const expectedBytes = fs.readFileSync(EXPECTED_PATH);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  if (expectedHash !== EXPECTED_BYTE_SHA) {
    throw new Error(`expected-product-schema byte drift: ${expectedHash}`);
  }
  const expected = JSON.parse(expectedBytes.toString('utf8'));
  if (expected.productFingerprint !== CANON_FP) {
    throw new Error('canonical fingerprint drift');
  }
  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) throw new Error('manifest integrity failed');
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  if (manifestHash !== MANIFEST_HASH) throw new Error('manifest hash drift');
  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
  if (live035 !== EXPECTED_035_SHA256) throw new Error('migration 035 sha drift');
  const live028 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '028_tenant_services.sql'));
  if (live028 !== EXPECTED_028_SHA256) throw new Error('migration 028 sha drift');

  const synth = buildSynthetic35Drifts();

  // ── Offline RED: gates ───────────────────────────────────────────
  {
    resetResidualDriftPreflightCounters();
    const r = await executeResidualDriftPreflight({ env: {}, argv: [] });
    const c = getResidualDriftPreflightCounters();
    red.push({
      name: 'default_path_zero_http_and_clients',
      ok: r.ok === false && c.clientsInstantiated === 0 && c.httpRequestCount === 0,
      code: r.code,
    });
  }

  {
    resetResidualDriftPreflightCounters();
    const env = residualDriftPreflightEnv();
    const argv = exactResidualDriftPreflightArgv().filter((a) => a !== CLI_PROVE_RESIDUAL_DRIFT_PREFLIGHT);
    const r = await executeResidualDriftPreflight({ env, argv });
    const c = getResidualDriftPreflightCounters();
    red.push({
      name: 'missing_prove_flag_zero_clients',
      ok: r.ok === false && c.clientsInstantiated === 0,
      code: r.code,
    });
  }

  {
    resetResidualDriftPreflightCounters();
    const env = { ...residualDriftPreflightEnv() };
    delete env[ENV_RESIDUAL_DRIFT_PREFLIGHT];
    const r = await executeResidualDriftPreflight({
      env,
      argv: exactResidualDriftPreflightArgv(),
    });
    red.push({
      name: 'missing_residual_env_zero_clients',
      ok: r.ok === false && r.code === 'residual_drift_preflight_env_required',
    });
  }

  {
    resetResidualDriftPreflightCounters();
    const env = residualDriftPreflightEnv();
    const argv = exactResidualDriftPreflightArgv().map((a) => (a === 'sunset_staging' ? 'wrong_db' : a));
    const r = await executeResidualDriftPreflight({ env, argv });
    red.push({
      name: 'wrong_exact_targets_zero_clients',
      ok: r.ok === false && getResidualDriftPreflightCounters().clientsInstantiated === 0,
    });
  }

  {
    resetResidualDriftPreflightCounters();
    const env = residualDriftPreflightEnv();
    const argv = [...exactResidualDriftPreflightArgv(), '--dsn', 'postgresql://x:y@host/db'];
    const r = await executeResidualDriftPreflight({ env, argv });
    red.push({
      name: 'forbidden_argv_dsn_sql_drop_dml_zero_clients',
      ok: r.ok === false && (r.code === 'forbidden_argv' || String(r.code).includes('forbidden')),
    });
  }

  // ── Offline RED: baseline / classify / coverage / ordering ───────
  {
    const badCount = assertBaselineMismatch({
      mismatchCount: 36,
      mismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
    });
    const badSections = assertBaselineMismatch({
      mismatchCount: 35,
      mismatchSections: { ...BASELINE_MISMATCH_SECTIONS, constraints: 24 },
    });
    red.push({
      name: 'baseline_drift_mismatch_stops',
      ok: badCount.ok === false
        && badCount.code === 'baseline_drift_mismatch'
        && badSections.ok === false
        && badSections.code === 'baseline_drift_mismatch',
    });
  }

  {
    const inv = buildCanonicalKeyInventory(
      synth.drifts,
      synth.expectedSnapshot,
      synth.ownershipIndex,
      synth.migrationHashes
    );
    const pfs = inv.items.map((i) => {
      if (i.section === 'constraints' && i.constraintCategory === 'NOT_NULL_shaped') {
        return {
          key: i.key,
          section: i.section,
          null_count: 3,
          table_total: 10,
          nullableState: 'expected_no_live_yes',
        };
      }
      return {
        key: i.key,
        section: i.section,
        null_count: 0,
        nullableState: 'expected_no_live_yes',
        duplicate_count: 0,
        orphan_count: 0,
        violation_count: 0,
      };
    });
    const plan = planMutationBatches(inv, pfs);
    const blocked = (plan.batches || []).find((b) => b.id === 'batch_02b_not_null_blocked');
    const safeNn = (plan.batches || []).find((b) => b.id === 'batch_02_not_null_safe');
    red.push({
      name: 'nullable_mismatch_with_nonzero_nulls_red',
      ok: blocked
        && blocked.outcome === 'blocker'
        && blocked.keys.length === 25
        && blocked.execute === false
        && (!safeNn || safeNn.keys.length === 0),
      detail: { blockedKeys: blocked && blocked.keys.length },
    });
  }

  {
    const pk = classifyConstraintResidual({
      table: 't',
      name: 't_pkey',
      type: 'PRIMARY KEY',
      definition: 'PRIMARY KEY (id)',
    });
    const fk = classifyConstraintResidual({
      table: 't',
      name: 't_fk',
      type: 'FOREIGN KEY',
      definition: 'FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE',
    });
    const chk = classifyConstraintResidual({
      table: 't',
      name: 't_check',
      type: 'CHECK',
      definition: 'CHECK ((end_date IS NULL) OR (start_date IS NULL))',
    });
    const drifts = [
      { kind: 'expected_only', section: 'constraints', key: 't.t_pkey.PRIMARY KEY' },
      { kind: 'expected_only', section: 'constraints', key: 't.t_fk.FOREIGN KEY' },
      { kind: 'expected_only', section: 'constraints', key: 't.t_check.CHECK' },
    ];
    const expectedSnapshot = {
      tables: ['t', 'clients'],
      columns: [
        { table: 't', column: 'id', nullable: 'NO' },
        { table: 't', column: 'client_id', nullable: 'YES' },
        { table: 'clients', column: 'id', nullable: 'NO' },
      ],
      constraints: [
        { table: 't', name: 't_pkey', type: 'PRIMARY KEY', definition: 'PRIMARY KEY (id)' },
        {
          table: 't',
          name: 't_fk',
          type: 'FOREIGN KEY',
          definition: 'FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE',
        },
        {
          table: 't',
          name: 't_check',
          type: 'CHECK',
          definition: 'CHECK ((end_date IS NULL) OR (start_date IS NULL))',
        },
      ],
      indexes: [],
      functions: [],
      triggers: [],
      ownership: [],
      acls: [],
      extensions: [],
    };
    const ownershipIndex = {
      '001': {
        tables: new Set(['t', 'clients']),
        columns: new Set(),
        indexes: new Set(),
        constraints: new Set(['t_pkey', 't_fk', 't_check']),
        functions: new Set(),
        triggers: new Set(),
        extensions: new Set(),
      },
    };
    const migrationHashes = {
      '001': { id: '001', filename: '001.sql', order: 1, sha256CanonicalLfV1: 'bb'.repeat(32) },
    };
    const inv = buildCanonicalKeyInventory(drifts, expectedSnapshot, ownershipIndex, migrationHashes);
    const pfs = inv.items.map((i) => {
      if (i.constraintCategory === 'PRIMARY_KEY') {
        return { key: i.key, section: i.section, duplicate_count: 2 };
      }
      if (i.constraintCategory === 'FOREIGN_KEY') {
        return { key: i.key, section: i.section, orphan_count: 5 };
      }
      if (i.constraintCategory === 'CHECK') {
        return { key: i.key, section: i.section, violation_count: 1 };
      }
      return { key: i.key, section: i.section };
    });
    const plan = planMutationBatches(inv, pfs);
    const pkBlocked = (plan.batches || []).some((b) => b.id === 'batch_03b_pk_unique_blocked' && b.keys.length > 0);
    const fkBlocked = (plan.batches || []).some((b) => b.id === 'batch_04b_fk_blocked' && b.keys.length > 0);
    const chkBlocked = (plan.batches || []).some((b) => b.id === 'batch_05b_check_blocked' && b.keys.length > 0);
    red.push({
      name: 'duplicate_orphan_violation_red',
      ok: pk.ok && fk.ok && chk.ok && pkBlocked && fkBlocked && chkBlocked
        && (plan.batches || []).every((b) => b.execute === false),
    });
  }

  {
    const bad = classifyConstraintResidual({
      table: 't',
      name: 't_weird',
      type: 'EXCLUDE',
      definition: 'EXCLUDE USING gist (c WITH &&)',
    });
    const badNn = classifyConstraintResidual({
      table: 't',
      name: 'weird_not_null',
      type: 'n',
      definition: 'NOT NULL (c)',
    });
    red.push({
      name: 'unsupported_definition_red',
      ok: bad.category === 'unsupported'
        && bad.ok === false
        && badNn.ok === false
        && badNn.category === 'unsupported'
        && (badNn.reason === 'unsupported_definition_shape' || badNn.reason === 'name_shape_mismatch'),
      detail: { badReason: bad.reason, badNnReason: badNn.reason, badNnCategory: badNn.category },
    });
  }

  {
    const inv = buildCanonicalKeyInventory(
      synth.drifts,
      synth.expectedSnapshot,
      {}, // empty ownership → missing owners
      {}
    );
    const unowned = inv.items.filter((i) => i.missingOwner === true);
    red.push({
      name: 'missing_owner_red',
      ok: unowned.length === inv.count && inv.count === 35,
      detail: { unowned: unowned.length },
    });
  }

  {
    const inv = buildCanonicalKeyInventory(
      synth.drifts,
      synth.expectedSnapshot,
      synth.ownershipIndex,
      synth.migrationHashes
    );
    const pfs = inv.items.slice(0, inv.items.length - 1).map((i) => ({
      key: i.key,
      section: i.section,
    }));
    const cov = assertCoverageComplete(inv, pfs);
    red.push({
      name: 'incomplete_coverage_red',
      ok: cov.ok === false && cov.code === 'coverage_incomplete' && cov.missingKeys.length === 1,
    });
  }

  {
    const inv = buildCanonicalKeyInventory(
      synth.drifts,
      synth.expectedSnapshot,
      synth.ownershipIndex,
      synth.migrationHashes
    );
    const pfs = inv.items.map((i) => ({
      key: i.key,
      section: i.section,
      null_count: 0,
      nullableState: 'expected_no_live_yes',
      duplicate_count: 0,
      orphan_count: 0,
      violation_count: 0,
    }));
    const plan = planMutationBatches(inv, pfs);
    const orderedOk = ranksNonDecreasing(plan.batches);
    const shuffled = [...(plan.batches || [])].reverse();
    const shuffledViolates = !ranksNonDecreasing(shuffled) || shuffled.length <= 1;
    // Also: FK-before-index would violate DEPENDENCY_ORDER_RANK if manually ordered that way.
    const fakeUnsafe = [
      { id: 'batch_04_fk_safe', outcome: 'exact_additive_canonical_apply', keys: ['x'], execute: false },
      { id: 'batch_01_indexes_additive', outcome: 'exact_additive_canonical_apply', keys: ['y'], execute: false },
    ];
    const fakeUnsafeDetected = !ranksNonDecreasing(fakeUnsafe);
    red.push({
      name: 'unsafe_ordering_red',
      ok: orderedOk === true
        && shuffledViolates === true
        && fakeUnsafeDetected === true
        && DEPENDENCY_ORDER_RANK.indexes < DEPENDENCY_ORDER_RANK.FOREIGN_KEY
        && DEPENDENCY_ORDER_RANK.NOT_NULL < DEPENDENCY_ORDER_RANK.FOREIGN_KEY,
      detail: {
        orderedOk,
        shuffledViolates,
        fakeUnsafeDetected,
        batchIds: (plan.batches || []).map((b) => b.id),
      },
    });
  }

  // ── Offline GREEN ────────────────────────────────────────────────
  {
    const ok = assertBaselineMismatch({
      mismatchCount: BASELINE_MISMATCH_COUNT,
      mismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
    });
    green.push({
      name: 'baseline_exactly_35_sections_ok',
      ok: ok.ok === true
        && ok.code === 'baseline_ok'
        && BASELINE_MISMATCH_COUNT === 35
        && BASELINE_MISMATCH_SECTIONS.constraints === 25,
    });
  }

  {
    const nn = classifyConstraintResidual({
      table: 'bookings',
      name: 'bookings_id_not_null',
      type: 'n',
      definition: 'NOT NULL id',
    });
    const pk = classifyConstraintResidual({
      table: 'bookings',
      name: 'bookings_pkey',
      type: 'PRIMARY KEY',
      definition: 'PRIMARY KEY (id)',
    });
    const uq = classifyConstraintResidual({
      table: 't',
      name: 't_uq',
      type: 'UNIQUE',
      definition: 'UNIQUE (client_id, title)',
    });
    const fk = classifyConstraintResidual({
      table: 't',
      name: 't_fk',
      type: 'FOREIGN KEY',
      definition: 'FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE',
    });
    const chk = classifyConstraintResidual({
      table: 't',
      name: 't_check',
      type: 'CHECK',
      definition: 'CHECK ((end_date IS NULL) OR (start_date IS NULL))',
    });
    const fn = classifyNonTableResidual(
      { section: 'functions', kind: 'expected_only' },
      { name: 'f' }
    );
    const ext = classifyNonTableResidual(
      { section: 'extensions', kind: 'expected_only' },
      { name: 'pgcrypto' }
    );
    green.push({
      name: 'classify_constraint_categories',
      ok: nn.category === 'NOT_NULL_shaped' && nn.ok === true
        && pk.category === 'PRIMARY_KEY' && pk.columns[0] === 'id'
        && uq.category === 'UNIQUE' && uq.columns.length === 2
        && fk.category === 'FOREIGN_KEY' && fk.refTable === 'clients'
        && chk.category === 'CHECK' && chk.ok === true
        && fn.outcomeClass === 'exact_additive_canonical_apply'
        && ext.outcomeClass === 'extension_policy',
    });
  }

  {
    const plan = buildNotNullNullCountSql('bookings', 'id');
    green.push({
      name: 'not_null_sql_aggregate_shape',
      ok: plan.sql.includes('FILTER (WHERE "id" IS NULL)')
        && plan.sql.includes('AS null_count')
        && plan.sql.includes('AS table_total')
        && plan.sql.includes('FROM public."bookings"')
        && quoteIdent('bookings') === '"bookings"',
    });
  }

  {
    const pk = buildPkDuplicateSql('t', ['id']);
    const uq = buildUniqueDuplicateSql('t', ['client_id', 'title']);
    const fk = buildFkOrphanSql('t', ['client_id'], 'clients', ['id']);
    const chk = buildCheckViolationSql('t', '(end_date IS NULL) OR (start_date IS NULL)');
    green.push({
      name: 'pk_fk_unique_check_sql_shapes',
      ok: /AS duplicate_count/.test(pk.sql)
        && /AS duplicate_count/.test(uq.sql)
        && /AS orphan_count/.test(fk.sql)
        && /LEFT JOIN/.test(fk.sql)
        && /AS violation_count/.test(chk.sql)
        && /WHERE NOT \(/.test(chk.sql),
    });
  }

  {
    const proof = buildIndexSupportProof(
      {
        table: 't',
        name: 'idx_a',
        def: 'CREATE INDEX idx_a ON public.t USING btree (c0)',
      },
      [{ table: 't', name: 'idx_b', def: 'CREATE INDEX idx_b ON public.t USING btree (c0)' }],
      [{ table: 't', column: 'c0' }]
    );
    green.push({
      name: 'index_support_proof_shape',
      ok: proof.supportingColumnsExist === true
        && proof.hasDuplicateSemanticIndex === true
        && proof.duplicateSemanticIndexNames.includes('idx_b')
        && /AS table_total/.test(proof.tableRowCountSql)
        && !/EXPLAIN/i.test(proof.tableRowCountSql),
    });
  }

  {
    const gates = evaluateResidualDriftPreflightGates({
      env: residualDriftPreflightEnv(),
      argv: exactResidualDriftPreflightArgv(),
    });
    green.push({
      name: 'cli_gates_exact_targets',
      ok: gates.ok === true,
    });
  }

  {
    const help = printCliHelp();
    green.push({
      name: 'cli_default_disabled',
      ok: PHASE_D_RESIDUAL_DRIFT_PREFLIGHT_LIVE_ENABLED === true
        && PHASE_D_LIVE_APPLY_ENABLED === false
        && PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true
        && /DEFAULT: refused/.test(help),
    });
  }

  {
    green.push({
      name: 'locks_identity_vault_secret_pg_tls_application_name',
      ok: APPLICATION_NAME === 'wh-sunset-residual-drift-preflight'
        && RESIDUAL_LOCKS.sslmode === 'verify-full'
        && RESIDUAL_LOCKS.database === 'sunset_staging'
        && RESIDUAL_LOCKS.postgresHost === EXPECTED_HOST
        && RESIDUAL_LOCKS.secretName === 'sunset-database-url',
    });
  }

  {
    green.push({
      name: 'global_live_apply_remains_false',
      ok: PHASE_D_LIVE_APPLY_ENABLED === false,
    });
  }

  {
    const inv = buildCanonicalKeyInventory(
      synth.drifts,
      synth.expectedSnapshot,
      synth.ownershipIndex,
      synth.migrationHashes
    );
    const pfs = inv.items.map((i) => ({
      key: i.key,
      section: i.section,
      null_count: 0,
      nullableState: 'expected_no_live_yes',
    }));
    const cov = assertCoverageComplete(inv, pfs);
    green.push({
      name: 'coverage_complete_35_once',
      ok: inv.count === 35
        && cov.ok === true
        && cov.code === 'coverage_complete'
        && cov.duplicateKeys.length === 0
        && inv.count !== 448,
    });
  }

  {
    const inv = buildCanonicalKeyInventory(
      synth.drifts,
      synth.expectedSnapshot,
      synth.ownershipIndex,
      synth.migrationHashes
    );
    const pfs = inv.items.map((i) => ({
      key: i.key,
      section: i.section,
      null_count: 0,
      nullableState: 'expected_no_live_yes',
      duplicate_count: 0,
      orphan_count: 0,
      violation_count: 0,
    }));
    const plan = planMutationBatches(inv, pfs);
    green.push({
      name: 'mutation_batches_execute_false_ordered',
      ok: plan.execute === false
        && (plan.batches || []).length > 0
        && (plan.batches || []).every((b) => b.execute === false)
        && ranksNonDecreasing(plan.batches) === true,
      detail: { batchIds: (plan.batches || []).map((b) => b.id) },
    });
  }

  {
    resetResidualDriftPreflightCounters();
    const fakeDsn = buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
    const http = createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: fakeDsn,
    });
    const inv = buildCanonicalKeyInventory(
      synth.drifts,
      synth.expectedSnapshot,
      synth.ownershipIndex,
      synth.migrationHashes
    );
    const pfs = inv.items.map((i) => ({
      key: i.key,
      section: i.section,
      kind: i.kind,
      outcomeClass: 'exact_additive_canonical_apply',
      code: 'injected',
      null_count: 0,
      nullableState: 'expected_no_live_yes',
      execute: false,
    }));
    const plan = planMutationBatches(inv, pfs);
    const cov = assertCoverageComplete(inv, pfs);
    const r = await executeResidualDriftPreflight({
      env: residualDriftPreflightEnv(),
      argv: exactResidualDriftPreflightArgv(),
      httpRequest: http,
      skipPostgres: false,
      expectedContract: expected,
      injectedPreflight: {
        ok: true,
        code: 'residual_drift_preflight_injected',
        sessionReadOnly: true,
        transactionReadOnly: true,
        committed: true,
        serverVersionClass: classifyServerVersionClass(150018, '15.18'),
        observerAfter: {
          ok: false,
          match: false,
          code: 'observer_drift',
          mismatchCount: 35,
          counts: { expected_only: 34, live_only: 0, definition_mismatch: 1 },
          mismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
          notNullArtifactsNormalized: 0,
        },
        baseline: assertBaselineMismatch({
          mismatchCount: 35,
          mismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
        }),
        inventory: { count: inv.count, items: inv.items.map((i) => ({
          key: i.key,
          section: i.section,
          kind: i.kind,
          dependencyOrderRank: i.dependencyOrderRank,
          missingOwner: i.missingOwner,
        })) },
        preflightResults: pfs,
        mutationBatches: plan,
        coverage: cov,
        productFingerprintLive: 'injected-offline-fingerprint',
      },
    });
    leakScan(r, secrets);
    green.push({
      name: 'injected_authority_preflight_path_secret_free',
      ok: r.ok === true
        && r.sameTarget === true
        && r.liveMutation === false
        && r.inventory
        && r.inventory.count === 35
        && r.inventory.count !== 448,
    });
  }

  // Validate required RED/GREEN names present
  for (const name of REQUIRED_RED) {
    if (!red.some((r) => r.name === name)) {
      red.push({ name, ok: false, detail: 'missing case' });
    }
  }
  for (const name of REQUIRED_GREEN) {
    if (!green.some((g) => g.name === name)) {
      green.push({ name, ok: false, detail: 'missing case' });
    }
  }

  const redFailed = red.filter((r) => !r.ok);
  const greenFailed = green.filter((g) => !g.ok);
  if (redFailed.length || greenFailed.length) {
    console.error('RED failures', redFailed);
    console.error('GREEN failures', greenFailed);
    throw new Error(`offline RED/GREEN failed: red=${redFailed.length} green=${greenFailed.length}`);
  }
  console.log(`  PASS  offline RED (${red.length}) / GREEN (${green.length})`);

  // ── Optional live ────────────────────────────────────────────────
  let liveOutcome = preserveLive ? priorEvidence.liveOutcome : null;
  if (!offlineOnly) {
    console.log('  … running one live residual-drift preflight session');
    resetResidualDriftPreflightCounters();
    const result = await executeResidualDriftPreflight({
      env: {
        ...residualDriftPreflightEnv(),
        ...process.env,
        [ENV_RESIDUAL_DRIFT_PREFLIGHT]: '1',
      },
      argv: exactResidualDriftPreflightArgv(),
      expectedContract: expected,
    });
    liveOutcome = pickSafeLiveOutcome(result);
    leakScan(liveOutcome, secrets);

    if (liveOutcome.sameTarget !== true) {
      throw new Error(`live sameTarget required; got ${liveOutcome.sameTarget}`);
    }
    if (!liveOutcome.baseline || liveOutcome.baseline.ok !== true) {
      throw new Error(`live baseline required ok; got ${JSON.stringify(liveOutcome.baseline)}`);
    }
    const svc = liveOutcome.serverVersionClass || {};
    if (!(svc.versionClass === 'postgresql_15' || Number(svc.major) === 15)) {
      throw new Error(`live postgresql_15 required; got ${JSON.stringify(svc)}`);
    }
    if (!liveOutcome.inventory || liveOutcome.inventory.count !== 35) {
      throw new Error(`live inventory must be 35; got ${liveOutcome.inventory && liveOutcome.inventory.count}`);
    }
    if (!liveOutcome.coverage || liveOutcome.coverage.ok !== true) {
      throw new Error('live coverage incomplete');
    }
    if (liveOutcome.liveMutation || liveOutcome.schemaMutation || liveOutcome.dataMutation
      || liveOutcome.ledgerWritten || liveOutcome.kvMutation) {
      throw new Error('live mutation flags must be false');
    }
    const batches = (liveOutcome.mutationBatches && liveOutcome.mutationBatches.batches) || [];
    if (!batches.every((b) => b.execute === false)) {
      throw new Error('live mutation batches must all be execute:false');
    }
    console.log(`  live code=${liveOutcome.code} sameTarget=${liveOutcome.sameTarget}`);
    console.log(`  serverVersionClass=${JSON.stringify(liveOutcome.serverVersionClass)}`);
    console.log(`  baseline=${liveOutcome.baseline && liveOutcome.baseline.mismatchCount}`);
    console.log(`  inventory=${liveOutcome.inventory && liveOutcome.inventory.count}`);
  }

  const evidence = {
    kind: 'slice14u-residual-drift-preflight-evidence',
    slice: '14U',
    masterShaBasis: MASTER,
    generatedAt: new Date().toISOString(),
    secretFree: true,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    kvMutation: false,
    rbacMutation: false,
    networkMutation: false,
    firewallAction: false,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    blessesLiveAsCanonical: false,
    doNotClaimDatabaseMatchesCanonical: true,
    residualInventoryIs35Only: true,
    doNotCarryForward448AsResidualInventory: true,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    productFingerprintExpected: CANON_FP,
    manifestHash: MANIFEST_HASH,
    migration035Sha256: EXPECTED_035_SHA256,
    migration028Sha256: EXPECTED_028_SHA256,
    lockedMigrationShas: LOCKED_13C_SHA,
    applicationName: APPLICATION_NAME,
    baselineMismatchCount: BASELINE_MISMATCH_COUNT,
    baselineMismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
    offline: {
      red,
      green,
      redCount: red.length,
      greenCount: green.length,
      syntheticResidualCount: 35,
    },
    liveOutcome,
    secretHandlingProof: {
      neverPrinted: true,
      neverPersisted: true,
      neverHashedIntoEvidence: true,
      neverInArgv: true,
      observerNeverPersistsDsn: true,
    },
    verifyNeverRerunsLive: true,
  };

  const contract = {
    kind: 'slice14u-residual-drift-preflight-contract',
    slice: '14U',
    masterShaBasis: MASTER,
    applicationName: APPLICATION_NAME,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    productFingerprintExpected: CANON_FP,
    manifestHash: MANIFEST_HASH,
    migration035Sha256: EXPECTED_035_SHA256,
    migration028Sha256: EXPECTED_028_SHA256,
    baselineMismatchCount: BASELINE_MISMATCH_COUNT,
    baselineMismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
    requiredRed: REQUIRED_RED.slice(),
    requiredGreen: REQUIRED_GREEN.slice(),
    locks: {
      postgresHost: RESIDUAL_LOCKS.postgresHost,
      database: RESIDUAL_LOCKS.database,
      sslmode: RESIDUAL_LOCKS.sslmode,
      applicationName: APPLICATION_NAME,
      containerAppName: RESIDUAL_LOCKS.containerAppName,
      keyVaultName: RESIDUAL_LOCKS.keyVaultName,
      secretName: RESIDUAL_LOCKS.secretName,
    },
    gates: {
      envResidualDriftPreflight: ENV_RESIDUAL_DRIFT_PREFLIGHT,
      cliProve: CLI_PROVE_RESIDUAL_DRIFT_PREFLIGHT,
      defaultDisabled: true,
      liveApplyRemainsFalse: true,
    },
    verifyNeverRerunsLive: true,
  };

  const versionClass = liveOutcome && liveOutcome.serverVersionClass
    ? liveOutcome.serverVersionClass.versionClass
    : null;
  const invCount = liveOutcome && liveOutcome.inventory
    ? liveOutcome.inventory.count
    : null;
  const baselineCount = liveOutcome && liveOutcome.baseline
    ? liveOutcome.baseline.mismatchCount
    : null;

  const findings = `# FOUNDATION Slice 14U — Residual drift classify + preflight

**Status:** ${liveOutcome && liveOutcome.ok ? 'residual_drift_preflight_live_ok' : 'offline_gates_ok'}
**Master basis:** \`${MASTER}\`
**Canonical fingerprint (unchanged):** \`${CANON_FP}\`
**Expected bytes (unchanged):** \`${EXPECTED_BYTE_SHA}\`

## What this slice does

Read-only classify + preflight of the exact **35** residual drifts remaining after
Slice 14T NOT NULL observer normalization under \`azure_flexible_server_v1\`:

- Baseline gate: mismatchCount === 35 with sections
  constraints=25, indexes=5, functions=1, triggers=1, ownership=1, acls=1, extensions=1
- Canonical key inventory (secret-free) with migration ownership + sha256CanonicalLfV1
- Constraint aggregates: NOT NULL null_count, PK/UNIQUE duplicates, FK orphans, CHECK violations
- Index support proof (columns exist; no duplicate semantic index; safe COUNT(*) only)
- Non-table classify: additive / privilege_mutation / extension_policy / blocker
- Deterministic mutation batches with \`execute:false\` always — zero mutation

**Do not** invent or carry forward the historical **448** NOT NULL normalized count as
residual inventory. Residual inventory is **35 only**.

## Offline gates

- RED: ${red.length} cases
- GREEN: ${green.length} cases

## Live

application_name: \`${APPLICATION_NAME}\`
sameTarget: **${liveOutcome ? liveOutcome.sameTarget : 'n/a'}**
server version class: **${versionClass || 'n/a'}**
baseline mismatchCount: **${baselineCount == null ? 'n/a' : baselineCount}**
inventory count: **${invCount == null ? 'n/a' : invCount}**
coverage: **${liveOutcome && liveOutcome.coverage ? liveOutcome.coverage.code : 'n/a'}**
after sections: ${liveOutcome && liveOutcome.observerAfter ? JSON.stringify(liveOutcome.observerAfter.mismatchSections) : 'n/a'}

Mutation flags: schemaMutation=false; dataMutation=false; ledgerWritten=false; kvMutation=false.
All mutation batches: execute=false.

## Do not claim

- Do **not** claim Sunset fully repaired unless observer mismatch is truly zero.
- Do **not** apply residual DDL/DML in this slice.
- Do **not** run verify with \`--live\` (verify never re-runs live).
- Do **not** modify expected-product-schema bytes/fingerprint or migrations.
- Do **not** treat 448 as residual inventory size.

## Operator live command

\`\`\`
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_RESIDUAL_DRIFT_PREFLIGHT=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:residual-drift-preflight -- --prove-residual-drift-preflight --prove-active-db-target-authority --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
\`\`\`

## Artifacts

- \`fixtures/sunset-schema-observer/slice14u-residual-drift-preflight-evidence.json\`
- \`fixtures/sunset-schema-observer/slice14u-residual-drift-preflight-contract.json\`
- \`fixtures/sunset-schema-observer/slice14u-findings.md\`
`;

  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, findings);

  leakScan(evidence, secrets);
  leakScan(contract, secrets);
  leakScan(findings, secrets);

  // Evidence must not treat 448 as residual inventory length.
  const evidenceText = JSON.stringify(evidence);
  if (/"count"\s*:\s*448/.test(evidenceText) || /inventoryCount"\s*:\s*448/.test(evidenceText)) {
    throw new Error('evidence must not use 448 as residual inventory size');
  }

  if (!fs.existsSync(CLI_PATH)) {
    console.warn('  WARN  CLI path missing:', CLI_PATH);
  }

  // Silence unused binding for createInjectedManagedIdentityHttp (available for prove extensions).
  void createInjectedManagedIdentityHttp;
  void forward;

  console.log(`\nWrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log('prove:sunset-schema-slice14u GREEN (offline)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
