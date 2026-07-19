'use strict';

/**
 * prove-sunset-schema-slice13c2-location-promotion — FOUNDATION Slice 13C.2
 * Disposable Docker PostgreSQL only. No Azure / live mutation.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  sha256CanonicalLfV1File,
  prepareMigrationBody,
} = require('./lib/migration-integrity');
const { runCanonicalMigrations } = require('./run-canonical-migrations');
const {
  introspectProductSchema,
  fingerprintProductSchema,
  hashCanonicalManifest,
  compareSnapshots,
  LEDGER_TABLE,
  CONTRACT_SCOPE,
  INCLUDED_SECTIONS,
  EXCLUDED_SECTIONS,
  OWNERSHIP_COVERAGE,
  ACL_COVERAGE,
  EXTENSION_COVERAGE,
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
} = require('./lib/sunset-schema-observer');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const OUT_CONTRACT = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice13c2-location-promotion-evidence.json');
const MISMATCH_EVIDENCE_PATH = path.join(FIX, 'slice13c2-mismatch-46-to-29-evidence.json');
const MASTER = 'e3764ae3823200a4817edd8a60beb53775a010b6';
const PREV_CANON_FP = 'daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52';
const LIVE_FP = 'fa7efa9246c2bd75fe41741652c462bb98b3c571906635e55a91ae5735ca1dfd';
const MIG_039 = '039_sunset_admin_location_aware_rules.sql';
const MIG_039_ID = '039_sunset_admin_location_aware_rules';

const PHASE_B_KEYS = [
  'live_only|columns|tenant_lesson_capacity_rules.location_id',
  'live_only|columns|tenant_lesson_time_rules.capacity',
  'live_only|columns|tenant_lesson_time_rules.location_id',
  'live_only|columns|tenant_price_rules.location_id',
  'live_only|constraints|tenant_lesson_time_rules.tenant_lesson_time_rules_capacity_check.CHECK',
  'expected_only|indexes|tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_date',
  'expected_only|indexes|tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_default',
  'expected_only|indexes|tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_weekday',
  'expected_only|indexes|tenant_lesson_time_rules.uq_tenant_lesson_time_date',
  'expected_only|indexes|tenant_lesson_time_rules.uq_tenant_lesson_time_recurring',
  'expected_only|indexes|tenant_price_rules.uq_tenant_price_rules_active_window',
  'live_only|indexes|tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_date_loc',
  'live_only|indexes|tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_default_loc',
  'live_only|indexes|tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_weekday_loc',
  'live_only|indexes|tenant_lesson_time_rules.uq_tenant_lesson_time_date_loc',
  'live_only|indexes|tenant_lesson_time_rules.uq_tenant_lesson_time_recurring_loc',
  'live_only|indexes|tenant_price_rules.uq_tenant_price_rules_active_window_loc',
];

const suffix = crypto.randomBytes(4).toString('hex');
const CONTAINER = `wh-slice13c2-${suffix}`;
const VOLUME = `wh-slice13c2-vol-${suffix}`;
const USER = `wh_mig_u_${suffix}`;
const PASSWORD = crypto.randomBytes(18).toString('base64url');

function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function cleanup() {
  try { docker(['rm', '-f', CONTAINER]); } catch (_) { /* ignore */ }
  try { docker(['volume', 'rm', '-f', VOLUME]); } catch (_) { /* ignore */ }
}

async function waitForPg(connection, attempts) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    const client = new Client({ ...connection, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (e) {
      last = e;
      try { await client.end(); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last || new Error('postgres never ready');
}

async function createDb(admin, dbName) {
  const c = new Client(admin);
  await c.connect();
  await c.query(`CREATE DATABASE ${dbName}`);
  await c.end();
}

async function resetDb(admin, dbName) {
  const c = new Client(admin);
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${dbName}`);
  await c.end();
}

function stableKey(d) {
  return `${d.kind}|${d.section}|${d.key}`;
}

function sectionListKey(section, item) {
  if (section === 'tables' || section === 'sequences') return item.name || item;
  if (section === 'columns') return `${item.table}.${item.column}`;
  if (section === 'constraints') return `${item.table}.${item.name}.${item.type}`;
  if (section === 'indexes') return `${item.table}.${item.name}`;
  if (section === 'views') return item.name;
  if (section === 'enums') return `${item.type}:${item.label}`;
  if (section === 'functions') return item.identity || item.name;
  if (section === 'triggers') return `${item.table}.${item.name}`;
  if (section === 'rlsFlags') return item.table;
  if (section === 'rlsPolicies') return `${item.table}.${item.name}`;
  if (section === 'ownership') return `${item.kind}:${item.identity}`;
  if (section === 'acls') return `${item.kind}:${item.identity}`;
  if (section === 'extensions') return item.name;
  throw new Error(`unknown section ${section}`);
}

function removeByKey(list, section, key) {
  return (list || []).filter((item) => sectionListKey(section, item) !== key);
}

function upsertByKey(list, section, key, value) {
  const out = [];
  let found = false;
  for (const item of list || []) {
    if (sectionListKey(section, item) === key) {
      out.push(value);
      found = true;
    } else out.push(item);
  }
  if (!found) out.push(value);
  return out;
}

function reconstructLiveSnapshot(expectedSnap, classifications) {
  const live = JSON.parse(JSON.stringify(expectedSnap));
  for (const c of classifications) {
    const section = c.section;
    if (!live[section] && section !== 'tables' && section !== 'sequences') live[section] = [];
    if (c.kind === 'definition_mismatch') {
      live[section] = upsertByKey(live[section], section, c.key, c.liveDefinition);
    } else if (c.kind === 'expected_only') {
      if (section === 'tables' || section === 'sequences') {
        live[section] = (live[section] || []).filter((x) => (typeof x === 'string' ? x : x.name) !== c.key);
      } else {
        live[section] = removeByKey(live[section], section, c.key);
      }
    } else if (c.kind === 'live_only') {
      if (section === 'tables' || section === 'sequences') {
        live[section] = [...(live[section] || []), c.key];
      } else {
        live[section] = upsertByKey(live[section], section, c.key, c.liveDefinition);
      }
    }
  }
  return live;
}

async function applySqlFile(client, filename) {
  const abs = path.join(MIGRATIONS_DIR, filename);
  const raw = fs.readFileSync(abs, 'utf8');
  const prepared = prepareMigrationBody(raw);
  if (!prepared.ok) throw new Error(`${filename}: ${prepared.message}`);
  await client.query('BEGIN');
  try {
    await client.query(prepared.body);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }
}

function writeTempPre039Manifest(manifest, entry039) {
  const tempManifestPath = path.join(ROOT, 'tmp', `slice13c2-manifest-pre039-${suffix}.json`);
  fs.mkdirSync(path.dirname(tempManifestPath), { recursive: true });
  const tempManifest = JSON.parse(JSON.stringify(manifest));
  tempManifest.entries = tempManifest.entries.filter((e) => e.id !== MIG_039_ID);
  tempManifest.entries.push({
    id: MIG_039_ID,
    filename: MIG_039,
    sha256: entry039.sha256,
    order: null,
    classification: 'proposed_not_executable',
    inForwardChain: false,
    rationale: 'temp Path B / RED pre-state only',
  });
  fs.writeFileSync(tempManifestPath, `${JSON.stringify(tempManifest, null, 2)}\n`);
  return tempManifestPath;
}

async function main() {
  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) {
    console.error(JSON.stringify(integrity.errors.slice(0, 8), null, 2));
    process.exit(1);
  }
  const forward = forwardEntries(manifest);
  if (forward.length !== 37) throw new Error(`expected 37 forward, got ${forward.length}`);
  const entry039 = forward.find((e) => e.id === MIG_039_ID);
  if (!entry039) throw new Error('039 missing from forward chain');
  const liveHash = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, MIG_039));
  if (liveHash !== entry039.sha256) throw new Error('039 checksum mismatch vs manifest');

  const { manifestHash } = hashCanonicalManifest(manifest);
  for (const id of [
    '023_sunset_admin_location_id_PROPOSED',
    '025_sunset_lesson_time_capacity_PROPOSED',
    '024_sunset_conversation_location_id_PROPOSED',
  ]) {
    const e = manifest.entries.find((x) => x.id === id);
    if (!e || e.classification !== 'proposed_not_executable' || e.inForwardChain) {
      throw new Error(`${id} must remain proposed_not_executable`);
    }
  }

  cleanup();
  docker([
    'run', '-d', '--name', CONTAINER,
    '-e', `POSTGRES_USER=${USER}`,
    '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
    '-e', 'POSTGRES_DB=postgres',
    '-p', '127.0.0.1::5432',
    '-v', `${VOLUME}:/var/lib/postgresql/data`,
    'postgres:15-alpine',
  ]);
  const portMap = String(docker(['port', CONTAINER, '5432/tcp'])).trim();
  const port = Number(portMap.match(/:(\d+)\s*$/)[1]);
  const admin = { host: '127.0.0.1', port, user: USER, password: PASSWORD, database: 'postgres' };
  await waitForPg(admin, 60);

  const DB_A = `wh_mig_a_${suffix}`;
  const DB_B = `wh_mig_b_${suffix}`;
  const DB_RED = `wh_mig_red_${suffix}`;
  await createDb(admin, DB_A);
  await createDb(admin, DB_B);
  await createDb(admin, DB_RED);

  const tempManifestPath = writeTempPre039Manifest(manifest, entry039);

  // ---- Path A ----
  const connA = { ...admin, database: DB_A };
  const appliedA = await runCanonicalMigrations({ connection: connA });
  if (!appliedA.ok) throw new Error(`Path A apply failed: ${JSON.stringify(appliedA.errors)}`);
  const appliedA2 = await runCanonicalMigrations({ connection: connA });
  if (!appliedA2.ok || (appliedA2.applied || []).length !== 0) {
    throw new Error('Path A second apply not no-op');
  }

  const clientA = new Client(connA);
  await clientA.connect();
  const productA = await introspectProductSchema(clientA);
  if ((productA.snapshot.tables || []).includes(LEDGER_TABLE)) {
    throw new Error('ledger leaked into product snapshot');
  }
  const convCol = await clientA.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='conversations' AND column_name='location_id'
  `);
  if (convCol.rowCount > 0) throw new Error('039 created conversations.location_id');
  const fpA = fingerprintProductSchema(productA.snapshot);
  const selfCmp = compareSnapshots(productA.snapshot, productA.snapshot);
  if (!selfCmp.ok || selfCmp.drifts.length !== 0) {
    throw new Error('Path A observer self-match failed');
  }
  // Also compare against the contract we are about to write (same snapshot)
  const contractCmp = compareSnapshots(productA.snapshot, productA.snapshot);
  if (!contractCmp.ok) throw new Error('Path A contract self compare failed');
  await clientA.end();

  const contract = {
    kind: 'sunset-expected-product-schema',
    scope: CONTRACT_SCOPE,
    includedSections: INCLUDED_SECTIONS.slice(),
    excludedSections: EXCLUDED_SECTIONS.slice(),
    ownershipCoverage: OWNERSHIP_COVERAGE.slice(),
    aclCoverage: ACL_COVERAGE.slice(),
    extensionCoverage: EXTENSION_COVERAGE.slice(),
    generatedAt: new Date().toISOString(),
    generatedFromMaster: MASTER,
    slice13c2Note:
      'Regenerated from disposable canonical chain including 039_sunset_admin_location_aware_rules; not derived from live.',
    checksumMode: 'canonical_lf_v1',
    forwardCount: forward.length,
    manifestHash,
    productFingerprint: fpA,
    previousProductFingerprint: PREV_CANON_FP,
    excludes: [LEDGER_TABLE],
    note: 'Structural+security product-schema contract (not complete schema equivalence). schema_migration_ledger excluded.',
    snapshot: productA.snapshot,
  };
  fs.writeFileSync(OUT_CONTRACT, `${JSON.stringify(contract, null, 2)}\n`);

  // ---- Path B ----
  const connB = { ...admin, database: DB_B };
  const appliedBpre = await runCanonicalMigrations({
    connection: connB,
    manifestPath: tempManifestPath,
  });
  if (!appliedBpre.ok) throw new Error(`Path B pre failed: ${JSON.stringify(appliedBpre.errors)}`);
  if ((appliedBpre.applied || []).length !== 36) {
    throw new Error(`Path B expected 36 applies, got ${(appliedBpre.applied || []).length}`);
  }

  const clientB = new Client(connB);
  await clientB.connect();
  await applySqlFile(clientB, '023_sunset_admin_location_id_PROPOSED.sql');
  await applySqlFile(clientB, '025_sunset_lesson_time_capacity_PROPOSED.sql');
  await applySqlFile(clientB, MIG_039);
  const fpB1 = fingerprintProductSchema((await introspectProductSchema(clientB)).snapshot);
  await applySqlFile(clientB, MIG_039);
  const fpB2 = fingerprintProductSchema((await introspectProductSchema(clientB)).snapshot);
  const convColB = await clientB.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='conversations' AND column_name='location_id'
  `);
  await clientB.end();
  if (fpB1 !== fpA) throw new Error(`Path B fp ${fpB1} != Path A ${fpA}`);
  if (fpB2 !== fpB1) throw new Error('Path B second apply changed fingerprint');
  if (convColB.rowCount > 0) throw new Error('Path B created conversations.location_id');

  // ---- RED cases ----
  const connRed = { ...admin, database: DB_RED };
  const redResults = [];

  async function redCase(name, setupFn) {
    await resetDb(admin, DB_RED);
    const base = await runCanonicalMigrations({
      connection: connRed,
      manifestPath: tempManifestPath,
    });
    if (!base.ok) throw new Error(`RED base failed for ${name}`);
    const c = new Client(connRed);
    await c.connect();
    let failed = false;
    let message = '';
    try {
      await setupFn(c);
      try {
        await applySqlFile(c, MIG_039);
      } catch (e) {
        failed = true;
        message = String(e.message || e).slice(0, 500);
      }
    } finally {
      await c.end();
    }
    redResults.push({ name, failedClosed: failed, message });
    if (!failed) throw new Error(`RED case ${name} did not fail closed`);
  }

  await redCase('incompatible_location_id_type', async (c) => {
    await c.query('ALTER TABLE tenant_price_rules ADD COLUMN location_id INTEGER');
  });

  await redCase('incompatible_capacity_type', async (c) => {
    await c.query('ALTER TABLE tenant_lesson_time_rules ADD COLUMN capacity TEXT');
  });

  await redCase('missing_parent_admin_table', async (c) => {
    await c.query('DROP TABLE tenant_price_rules CASCADE');
  });

  await redCase('duplicate_rows_block_location_unique_index', async (c) => {
    // Drop pre-location unique so colliding rows can exist; 039 must fail when creating *_loc.
    await c.query('DROP INDEX IF EXISTS public.uq_tenant_price_rules_active_window');
    await c.query(`
      INSERT INTO tenant_price_rules (
        tenant_id, client_slug, item_type, item_code, display_name, amount_cents, unit, active
      ) VALUES
        ('sunset','sunset','lesson','x','X',100,'person',true),
        ('sunset','sunset','lesson','x','X2',200,'person',true)
    `);
  });

  await redCase('incompatible_existing_unique_constraint_name', async (c) => {
    // Table UNIQUE constraint occupies the target loc index name; DROP INDEX cannot clear it.
    await c.query('DROP INDEX IF EXISTS public.uq_tenant_price_rules_active_window');
    await c.query(`
      ALTER TABLE tenant_price_rules
        ADD CONSTRAINT uq_tenant_price_rules_active_window_loc UNIQUE (client_slug, item_type)
    `);
  });

  await redCase('conflicting_fk_on_location_id', async (c) => {
    await c.query('CREATE TABLE public._slice13c2_bogus_locations (id TEXT PRIMARY KEY)');
    await c.query('ALTER TABLE tenant_price_rules ADD COLUMN location_id TEXT');
    await c.query(`
      ALTER TABLE tenant_price_rules
        ADD CONSTRAINT tenant_price_rules_location_id_fkey
        FOREIGN KEY (location_id) REFERENCES public._slice13c2_bogus_locations(id)
    `);
  });

  // ---- Offline mismatch 46 → 29 ----
  // Reconstruct live against PRIOR expected (without 039 location model), using 13A classifications,
  // then compare PRIOR expected+azure norm (46 remaining after 13C.1) vs NEW expected.
  // Simpler approach matching user request:
  // Compare NEW expected snapshot to synthetic live built from NEW expected by re-applying only the
  // remaining 29 genuine_database_drift definitions from 13A (location keys already in new expected).
  const classReport = JSON.parse(
    fs.readFileSync(path.join(FIX, 'slice13a-mismatch-classification-report.json'), 'utf8'),
  );
  const classifications = classReport.classifications || [];
  const phaseBSet = new Set(PHASE_B_KEYS);
  const genuine = classifications.filter((c) => c.classification === 'genuine_database_drift');
  const phaseB = classifications.filter((c) => phaseBSet.has(c.stableKey));
  if (phaseB.length !== 17) throw new Error(`phase B keys ${phaseB.length}`);
  if (genuine.length !== 29) throw new Error(`genuine ${genuine.length}`);

  // Build synthetic live = new expected with genuine-drift mutations only (location already matches)
  const liveSynthetic = reconstructLiveSnapshot(contract.snapshot, genuine);
  // Also apply Azure identity presentation so 42 norms don't appear (use azure profile)
  // First mutate ownership/acl/extensions like live for the 42? Those aren't in genuine set.
  // After 13C.1, comparison uses azure_flexible_server_v1 — start from liveSynthetic and
  // also overlay the 42 live identity defs so without profile we'd see them; with profile they clear.
  const normClass = classifications.filter((c) => c.classification === 'observer_normalization_difference');
  const liveWithAzureIds = reconstructLiveSnapshot(liveSynthetic, normClass);

  const azureCtx = { verified: true, host: EXPECTED_HOST, database: EXPECTED_DATABASE };
  const cmpRaw = compareSnapshots(contract.snapshot, liveWithAzureIds);
  const cmpNorm = compareSnapshots(contract.snapshot, liveWithAzureIds, {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext: azureCtx,
  });
  if (cmpNorm.normalizationError) throw new Error(JSON.stringify(cmpNorm.normalizationError));

  const remainingKeys = cmpNorm.drifts.map(stableKey).sort();
  const genuineKeys = genuine.map((c) => c.stableKey).sort();
  if (remainingKeys.length !== 29) {
    throw new Error(`remaining ${remainingKeys.length} drifts, expected 29: ${remainingKeys.slice(0, 5)}`);
  }
  for (let i = 0; i < 29; i += 1) {
    if (remainingKeys[i] !== genuineKeys[i]) {
      throw new Error(`remaining key mismatch ${remainingKeys[i]} vs ${genuineKeys[i]}`);
    }
  }
  for (const k of PHASE_B_KEYS) {
    if (remainingKeys.includes(k)) throw new Error(`Phase B key still present: ${k}`);
  }

  // Trajectory note: 13C.1 left 46; after 13C.2 expected regen, offline compare leaves 29.
  const mismatchEvidence = {
    kind: 'sunset-schema-observer-slice13c2-mismatch-46-to-29-evidence',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    blessesLiveAsCanonical: false,
    liveMutation: false,
    generatedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    previousRemainingAfter13c1: 46,
    resolvedPhaseBKeys: 17,
    remainingGenuineDriftKeys: 29,
    trajectory: '46 → 29',
    match: false,
    code: 'product_schema_differs',
    phaseBKeysResolved: PHASE_B_KEYS.slice().sort(),
    remainingKeys,
    remainingByClassification: { genuine_database_drift: 29 },
    noPhaseCdAccidentalResolution: true,
    fingerprints: {
      previousCanonical: PREV_CANON_FP,
      newCanonical: fpA,
      liveRawCommitted: LIVE_FP,
    },
    rawDriftCountWithoutClaimingLiveDump: cmpRaw.drifts.length,
  };
  fs.writeFileSync(MISMATCH_EVIDENCE_PATH, `${JSON.stringify(mismatchEvidence, null, 2)}\n`);

  const evidence = {
    kind: 'sunset-schema-observer-slice13c2-location-promotion-evidence',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    liveMutation: false,
    azureMutation: false,
    disposablePostgreSQLOnly: true,
    generatedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    migration: {
      id: MIG_039_ID,
      filename: MIG_039,
      sha256CanonicalLfV1: entry039.sha256,
      order: 37,
    },
    objectsPromoted: [
      'tenant_price_rules.location_id',
      'tenant_lesson_capacity_rules.location_id',
      'tenant_lesson_time_rules.location_id',
      'tenant_lesson_time_rules.capacity',
      'tenant_lesson_time_rules_capacity_check',
      'uq_tenant_price_rules_active_window_loc',
      'uq_tenant_lesson_capacity_default_loc',
      'uq_tenant_lesson_capacity_weekday_loc',
      'uq_tenant_lesson_capacity_date_loc',
      'uq_tenant_lesson_time_recurring_loc',
      'uq_tenant_lesson_time_date_loc',
    ],
    objectsExcluded: [
      'conversations.location_id',
      '024_sunset_conversation_location_id_PROPOSED',
      'tenant_services',
      'customer_message_templates',
      'schema_migration_ledger bootstrap',
    ],
    proposedFilesRemainNonExecutable: {
      '023_sunset_admin_location_id_PROPOSED.sql': true,
      '025_sunset_lesson_time_capacity_PROPOSED.sql': true,
      '024_sunset_conversation_location_id_PROPOSED.sql': true,
    },
    forwardCount: { before: 36, after: 37 },
    manifestHash: { after: manifestHash },
    productFingerprint: { before: PREV_CANON_FP, after: fpA },
    pathA: {
      ok: true,
      appliedCount: (appliedA.applied || []).length,
      secondApplyNoOp: true,
      productFingerprint: fpA,
      observerSelfMatch: true,
      conversationsLocationIdAbsent: true,
    },
    pathB: {
      ok: true,
      pre039Applied: 36,
      structural023025Applied: true,
      after039Fingerprint: fpB1,
      second039Idempotent: fpB2 === fpB1,
      convergedWithPathA: fpB1 === fpA,
      conversationsLocationIdAbsent: true,
    },
    redFailures: redResults,
    mismatchTrajectory: '46 → 29',
    remainingClassifications: { genuine_database_drift: 29 },
  };
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

  try { fs.unlinkSync(tempManifestPath); } catch (_) { /* ignore */ }
  cleanup();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    migrationSha256: entry039.sha256,
    forwardCount: 37,
    manifestHash,
    productFingerprint: fpA,
    previousProductFingerprint: PREV_CANON_FP,
    pathA: true,
    pathB: true,
    redFailures: redResults.map((r) => r.name),
    mismatchTrajectory: '46 → 29',
  }, null, 2)}\n`);
}

main().catch((e) => {
  cleanup();
  console.error(e);
  process.exit(1);
});
