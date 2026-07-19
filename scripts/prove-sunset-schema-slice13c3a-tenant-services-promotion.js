'use strict';

/**
 * prove-sunset-schema-slice13c3a-tenant-services-promotion — FOUNDATION Slice 13C.3a
 * Disposable PostgreSQL only (Docker preferred; PGlite socket fallback). No Azure / live mutation.
 */

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
const EVIDENCE_PATH = path.join(FIX, 'slice13c3a-tenant-services-promotion-evidence.json');
const MISMATCH_EVIDENCE_PATH = path.join(FIX, 'slice13c3a-mismatch-29-to-25-evidence.json');
const MASTER = '5158320585f0a894329d8ff017fa658d86d041bf';
const PREV_CANON_FP = '553d21d3dca91b60a1b9e09799f677051be63d491792fd68e12b5f6652c220f1';
const LIVE_FP = 'fa7efa9246c2bd75fe41741652c462bb98b3c571906635e55a91ae5735ca1dfd';
const MIG_040 = '040_tenant_services_saas_catalog_columns.sql';
const MIG_040_ID = '040_tenant_services_saas_catalog_columns';

const PHASE_C_TENANT_SERVICES_COLUMN_KEYS = [
  'live_only|columns|tenant_services.block_rooms_enabled',
  'live_only|columns|tenant_services.blocked_room_codes',
  'live_only|columns|tenant_services.room_block_booking_ids',
  'live_only|columns|tenant_services.weekdays',
];

const MUST_REMAIN_KEYS = [
  'expected_only|constraints|tenant_services.tenant_services_date_window.CHECK',
  'expected_only|constraints|tenant_services.tenant_services_price_unit.CHECK',
  'expected_only|tables|customer_message_templates',
  'expected_only|indexes|client_notification_events.idx_client_notification_events_client_created',
  'expected_only|indexes|tenant_surf_pack_rules.idx_tenant_surf_pack_client_loc',
];

const ENSURE_LIVE_DDL = `
ALTER TABLE tenant_services ADD COLUMN IF NOT EXISTS weekdays SMALLINT[] NOT NULL DEFAULT '{}';
ALTER TABLE tenant_services ADD COLUMN IF NOT EXISTS block_rooms_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenant_services ADD COLUMN IF NOT EXISTS blocked_room_codes TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE tenant_services ADD COLUMN IF NOT EXISTS room_block_booking_ids UUID[] NOT NULL DEFAULT '{}';
`;

const PROMOTED_COLUMNS = [
  'weekdays',
  'block_rooms_enabled',
  'blocked_room_codes',
  'room_block_booking_ids',
];

const { startDisposablePostgresHarness } = require('./lib/disposable-postgres-harness');

let harnessCleanup = () => {};

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

function writeTempPre040Manifest(manifest, entry040, suffix) {
  const tempManifestPath = path.join(ROOT, 'tmp', `slice13c3a-manifest-pre040-${suffix}.json`);
  fs.mkdirSync(path.dirname(tempManifestPath), { recursive: true });
  const tempManifest = JSON.parse(JSON.stringify(manifest));
  tempManifest.entries = tempManifest.entries.filter((e) => e.id !== MIG_040_ID);
  tempManifest.entries.push({
    id: MIG_040_ID,
    filename: MIG_040,
    sha256: entry040.sha256,
    order: null,
    classification: 'proposed_not_executable',
    inForwardChain: false,
    rationale: 'temp Path B / RED pre-state only',
  });
  fs.writeFileSync(tempManifestPath, `${JSON.stringify(tempManifest, null, 2)}\n`);
  return tempManifestPath;
}

async function columnAttnums(client, names) {
  const res = await client.query(`
    SELECT a.attname AS name, a.attnum::int AS attnum
    FROM pg_attribute a
    WHERE a.attrelid = 'public.tenant_services'::regclass
      AND a.attname = ANY($1::text[])
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attname
  `, [names]);
  return res.rows;
}

async function main() {
  const suffix = crypto.randomBytes(4).toString('hex');
  let cleanup = () => {};
  harnessCleanup = cleanup;
  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) {
    console.error(JSON.stringify(integrity.errors.slice(0, 8), null, 2));
    process.exit(1);
  }
  const forward = forwardEntries(manifest);
  if (forward.length !== 38) throw new Error(`expected 38 forward, got ${forward.length}`);
  const entry040 = forward.find((e) => e.id === MIG_040_ID);
  if (!entry040) throw new Error('040 missing from forward chain');
  const liveHash = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, MIG_040));
  if (liveHash !== entry040.sha256) throw new Error('040 checksum mismatch vs manifest');

  const { manifestHash } = hashCanonicalManifest(manifest);

  cleanup();
  const harness = await startDisposablePostgresHarness();
  cleanup = harness.cleanup;
  harnessCleanup = cleanup;
  const admin = harness.admin;
  const disposableBackend = harness.backend;
  await waitForPg(admin, 60);

  const DB_A = `wh_mig_a_${suffix}`;
  const DB_B = `wh_mig_b_${suffix}`;
  const DB_RED = `wh_mig_red_${suffix}`;
  await createDb(admin, DB_A);
  if (disposableBackend !== 'pglite') {
    await createDb(admin, DB_B);
    await createDb(admin, DB_RED);
  }

  const tempManifestPath = writeTempPre040Manifest(manifest, entry040, suffix);

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
  const fpA = fingerprintProductSchema(productA.snapshot);
  const selfCmp = compareSnapshots(productA.snapshot, productA.snapshot);
  if (!selfCmp.ok || selfCmp.drifts.length !== 0) {
    throw new Error('Path A observer self-match failed');
  }
  for (const col of PROMOTED_COLUMNS) {
    const colRes = await clientA.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='tenant_services' AND column_name=$1
    `, [col]);
    if (colRes.rowCount !== 1) throw new Error(`Path A missing tenant_services.${col}`);
  }
  const checkRes = await clientA.query(`
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE rel.relname = 'tenant_services'
      AND c.contype = 'c'
      AND c.conname IN ('tenant_services_date_window', 'tenant_services_price_unit')
  `);
  if (checkRes.rowCount !== 2) {
    throw new Error('040 must not add tenant_services Phase D CHECK constraints');
  }
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
    slice13c3aNote:
      'Regenerated from disposable canonical chain including 040_tenant_services_saas_catalog_columns; not derived from live.',
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

  let adminB = admin;
  if (disposableBackend === 'pglite') {
    cleanup();
    const harnessB = await startDisposablePostgresHarness();
    cleanup = harnessB.cleanup;
    harnessCleanup = cleanup;
    adminB = harnessB.admin;
    await waitForPg(adminB, 60);
    await createDb(adminB, DB_B);
  }

  const connB = { ...adminB, database: DB_B };
  const appliedBpre = await runCanonicalMigrations({
    connection: connB,
    manifestPath: tempManifestPath,
  });
  if (!appliedBpre.ok) throw new Error(`Path B pre failed: ${JSON.stringify(appliedBpre.errors)}`);
  if ((appliedBpre.applied || []).length !== 37) {
    throw new Error(`Path B expected 37 applies, got ${(appliedBpre.applied || []).length}`);
  }

  const clientB = new Client(connB);
  await clientB.connect();
  await clientB.query(ENSURE_LIVE_DDL);
  const preCols = await columnAttnums(clientB, PROMOTED_COLUMNS);
  if (preCols.length !== 4) throw new Error(`Path B expected 4 pre columns, got ${preCols.length}`);

  await applySqlFile(clientB, MIG_040);
  const postCols = await columnAttnums(clientB, PROMOTED_COLUMNS);
  for (let i = 0; i < 4; i += 1) {
    if (preCols[i].name !== postCols[i].name || Number(preCols[i].attnum) !== Number(postCols[i].attnum)) {
      throw new Error(`Path B dropped/recreated column ${preCols[i].name}`);
    }
  }

  const fpB1 = fingerprintProductSchema((await introspectProductSchema(clientB)).snapshot);
  await applySqlFile(clientB, MIG_040);
  const fpB2 = fingerprintProductSchema((await introspectProductSchema(clientB)).snapshot);
  await clientB.end();
  if (fpB1 !== fpA) throw new Error(`Path B fp ${fpB1} != Path A ${fpA}`);
  if (fpB2 !== fpB1) throw new Error('Path B second apply changed fingerprint');

  const connRed = { ...adminB, database: DB_RED };
  const redResults = [];

  async function redCase(name, setupFn) {
    let redAdmin = adminB;
    let redCleanup = () => {};
    if (disposableBackend === 'pglite') {
      const harnessRed = await startDisposablePostgresHarness();
      redAdmin = harnessRed.admin;
      redCleanup = harnessRed.cleanup;
      await waitForPg(redAdmin, 60);
      await createDb(redAdmin, DB_RED);
    } else {
      await resetDb(adminB, DB_RED);
    }
    const connRedLocal = { ...redAdmin, database: DB_RED };
    const base = await runCanonicalMigrations({
      connection: connRedLocal,
      manifestPath: tempManifestPath,
    });
    if (!base.ok) throw new Error(`RED base failed for ${name}`);
    const c = new Client(connRedLocal);
    await c.connect();
    let failed = false;
    let message = '';
    try {
      await setupFn(c);
      try {
        await applySqlFile(c, MIG_040);
      } catch (e) {
        failed = true;
        message = String(e.message || e).slice(0, 500);
      }
    } finally {
      await c.end();
      redCleanup();
    }
    redResults.push({ name, failedClosed: failed, message });
    if (!failed) throw new Error(`RED case ${name} did not fail closed`);
  }

  await redCase('incompatible_weekdays_type', async (c) => {
    await c.query('ALTER TABLE tenant_services ADD COLUMN weekdays INTEGER[] NOT NULL DEFAULT \'{}\'');
  });

  await redCase('incompatible_block_rooms_enabled_type', async (c) => {
    await c.query('ALTER TABLE tenant_services ADD COLUMN block_rooms_enabled TEXT NOT NULL DEFAULT \'false\'');
  });

  await redCase('incompatible_blocked_room_codes_nullable', async (c) => {
    await c.query('ALTER TABLE tenant_services ADD COLUMN blocked_room_codes TEXT[]');
  });

  await redCase('incompatible_room_block_booking_ids_default', async (c) => {
    await c.query(`ALTER TABLE tenant_services ADD COLUMN room_block_booking_ids UUID[] NOT NULL DEFAULT '{00000000-0000-0000-0000-000000000001}'::uuid[]`);
  });

  await redCase('missing_parent_tenant_services_table', async (c) => {
    await c.query('DROP TABLE tenant_services CASCADE');
  });

  await redCase('generated_weekdays_column', async (c) => {
    await c.query(`ALTER TABLE tenant_services ADD COLUMN weekdays SMALLINT[] GENERATED ALWAYS AS ('{}'::smallint[]) STORED`);
  });

  const greenResults = [
    {
      name: 'exact_existing_columns_unchanged',
      ok: true,
      detail: 'Path B attnum-stable across 040 for all four promoted columns',
    },
    {
      name: 'second_migration_application_noop',
      ok: true,
      detail: 'Path A ledger second apply empty; Path B second 040 fingerprint unchanged',
    },
    {
      name: 'path_a_path_b_converge',
      ok: fpB1 === fpA,
      detail: `fp=${fpA}`,
    },
  ];
  if (!greenResults.every((g) => g.ok)) throw new Error('GREEN cases failed');

  const classReport = JSON.parse(
    fs.readFileSync(path.join(FIX, 'slice13a-mismatch-classification-report.json'), 'utf8'),
  );
  const classifications = classReport.classifications || [];
  const phaseCSet = new Set(PHASE_C_TENANT_SERVICES_COLUMN_KEYS);
  const genuine = classifications.filter((c) => c.classification === 'genuine_database_drift');
  const phaseC = classifications.filter((c) => phaseCSet.has(c.stableKey));
  if (phaseC.length !== 4) throw new Error(`phase C tenant_services keys ${phaseC.length}`);
  if (genuine.length !== 29) throw new Error(`genuine ${genuine.length}`);

  const liveSynthetic = reconstructLiveSnapshot(contract.snapshot, genuine);
  const normClass = classifications.filter((c) => c.classification === 'observer_normalization_difference');
  const liveWithAzureIds = reconstructLiveSnapshot(liveSynthetic, normClass);
  const azureCtx = { verified: true, host: EXPECTED_HOST, database: EXPECTED_DATABASE };
  const cmpRaw = compareSnapshots(contract.snapshot, liveWithAzureIds);
  const cmpNorm = compareSnapshots(contract.snapshot, liveWithAzureIds, {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext: azureCtx,
  });
  if (cmpNorm.normalizationError) throw new Error(JSON.stringify(cmpNorm.normalizationError));

  const genuineKeys = genuine.map((c) => c.stableKey).sort();
  const genuineKeySet = new Set(genuineKeys);
  const remainingKeys = cmpNorm.drifts
    .map(stableKey)
    .filter((k) => genuineKeySet.has(k))
    .sort();
  if (remainingKeys.length !== 25) {
    throw new Error(`remaining ${remainingKeys.length} drifts, expected 25: ${remainingKeys.slice(0, 8).join(', ')}`);
  }
  for (const k of PHASE_C_TENANT_SERVICES_COLUMN_KEYS) {
    if (remainingKeys.includes(k)) throw new Error(`Phase C tenant_services key still present: ${k}`);
  }
  for (const k of MUST_REMAIN_KEYS) {
    if (!remainingKeys.includes(k)) throw new Error(`required remaining key missing: ${k}`);
  }

  const mismatchEvidence = {
    kind: 'sunset-schema-observer-slice13c3a-mismatch-29-to-25-evidence',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    blessesLiveAsCanonical: false,
    liveMutation: false,
    generatedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    previousRemainingAfter13c2: 29,
    resolvedPhaseCTenantServicesColumnKeys: 4,
    remainingGenuineDriftKeys: 25,
    trajectory: '29 → 25',
    match: false,
    code: 'product_schema_differs',
    phaseCTenantServicesColumnKeysResolved: PHASE_C_TENANT_SERVICES_COLUMN_KEYS.slice().sort(),
    remainingKeys,
    remainingByClassification: { genuine_database_drift: 25 },
    noOtherPhaseCAccidentalResolution: true,
    fingerprints: {
      previousCanonical: PREV_CANON_FP,
      newCanonical: fpA,
      liveRawCommitted: LIVE_FP,
    },
    rawDriftCountWithoutClaimingLiveDump: cmpRaw.drifts.length,
  };
  fs.writeFileSync(MISMATCH_EVIDENCE_PATH, `${JSON.stringify(mismatchEvidence, null, 2)}\n`);

  const evidence = {
    kind: 'sunset-schema-observer-slice13c3a-tenant-services-promotion-evidence',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    liveMutation: false,
    azureMutation: false,
    disposablePostgreSQLOnly: true,
    disposableBackend,
    generatedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    migration: {
      id: MIG_040_ID,
      filename: MIG_040,
      sha256CanonicalLfV1: entry040.sha256,
      order: 38,
    },
    fieldMatrix: [
      {
        column: 'weekdays',
        liveDefinition: 'SMALLINT[] NOT NULL DEFAULT \'{}\'',
        codeOwner: 'scripts/lib/tenant-services-writes.js ensureServicesTable + validateServiceBody',
        meaning: 'Optional weekday filter (0=Sun..6=Sat) for recurring catalog availability',
        decision: 'promote',
        evidence: 'DEC-004 Phase C; Slice 13A live_only; Staff ensure-DDL',
      },
      {
        column: 'block_rooms_enabled',
        liveDefinition: 'BOOLEAN NOT NULL DEFAULT false',
        codeOwner: 'scripts/lib/tenant-services-writes.js + tenant-service-room-blocks.js ensureServiceBlockColumns',
        meaning: 'Enables whole-room operator inventory blocks for camp/service dates',
        decision: 'promote',
        evidence: 'DEC-004 Phase C; syncServiceRoomBlocks gate',
      },
      {
        column: 'blocked_room_codes',
        liveDefinition: 'TEXT[] NOT NULL DEFAULT \'{}\'',
        codeOwner: 'scripts/lib/tenant-service-room-blocks.js normalizeRoomCodes + writes layer',
        meaning: 'Room codes to block when block_rooms_enabled',
        decision: 'promote',
        evidence: 'DEC-004 Phase C; required when block_rooms_enabled',
      },
      {
        column: 'room_block_booking_ids',
        liveDefinition: 'UUID[] NOT NULL DEFAULT \'{}\'',
        codeOwner: 'scripts/lib/tenant-service-room-blocks.js syncServiceRoomBlocks',
        meaning: 'Backing operator whole_room booking UUIDs for active blocks',
        decision: 'promote',
        evidence: 'DEC-004 Phase C; mutated by syncServiceRoomBlocks only',
      },
    ],
    objectsPromoted: PROMOTED_COLUMNS.map((c) => `tenant_services.${c}`),
    objectsExcluded: [
      'tenant_services_date_window CHECK',
      'tenant_services_price_unit CHECK',
      'customer_message_templates',
      'client_notification_events indexes',
      'tenant_surf_pack_rules FK/trigger/index',
      'schema_migration_ledger bootstrap',
    ],
    forwardCount: { before: 37, after: 38 },
    manifestHash: { before: '7ac14e1637b7e58f28bda8f494f8556dd0f03c27c00a04340ebf941f19e7beb0', after: manifestHash },
    productFingerprint: { before: PREV_CANON_FP, after: fpA },
    pathA: {
      ok: true,
      appliedCount: (appliedA.applied || []).length,
      secondApplyNoOp: true,
      productFingerprint: fpA,
      observerSelfMatch: true,
      promotedColumnsPresent: true,
      phaseDChecksUnchanged: true,
    },
    pathB: {
      ok: true,
      pre040Applied: 37,
      ensureLiveDdlApplied: true,
      after040Fingerprint: fpB1,
      second040Idempotent: fpB2 === fpB1,
      convergedWithPathA: fpB1 === fpA,
      exactColumnsPreservedByAttnum: true,
    },
    catalogValidation: {
      approach: 'pg_attribute + pg_type udt_name, attnotnull, pg_get_expr default, attgenerated/attidentity; incompatible RAISE else ADD IF NOT EXISTS',
      locks: 'brief ACCESS EXCLUSIVE on ALTER TABLE tenant_services ADD COLUMN',
      compatibility: 'absent add; exact compatible preserve/no-op; incompatible type/default/nullability/generated/identity fail closed rollback',
    },
    redFailures: redResults,
    greenCases: greenResults,
    mismatchTrajectory: '29 → 25',
    remainingClassifications: { genuine_database_drift: 25 },
  };
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

  const contractPath = path.join(FIX, 'slice13b-slice13c-rehearsal-contract.json');
  const rehearsal = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  rehearsal.slice13c3aPhaseC = {
    status: 'complete_tenant_services_column_promotion',
    completedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    migrationId: MIG_040_ID,
    migrationFilename: MIG_040,
    evidence: 'fixtures/sunset-schema-observer/slice13c3a-tenant-services-promotion-evidence.json',
    mismatchEvidence: 'fixtures/sunset-schema-observer/slice13c3a-mismatch-29-to-25-evidence.json',
    note: 'Phase C tenant_services live-only columns promoted into one forward migration (29→25). Phase D CHECKs/CMT/notification/surf-pack remain. No live apply.',
  };
  rehearsal.phaseStatus.C = 'partial_tenant_services_columns_complete';
  fs.writeFileSync(contractPath, `${JSON.stringify(rehearsal, null, 2)}\n`);

  try { fs.unlinkSync(tempManifestPath); } catch (_) { /* ignore */ }
  cleanup();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    migrationSha256: entry040.sha256,
    forwardCount: 38,
    manifestHash,
    productFingerprint: fpA,
    previousProductFingerprint: PREV_CANON_FP,
    pathA: true,
    pathB: true,
    redFailures: redResults.map((r) => r.name),
    mismatchTrajectory: '29 → 25',
    remainingKeys: remainingKeys.length,
  }, null, 2)}\n`);
}

main().catch((e) => {
  harnessCleanup();
  console.error(e);
  process.exit(1);
});
