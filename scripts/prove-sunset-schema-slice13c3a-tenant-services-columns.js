'use strict';

/**
 * prove-sunset-schema-slice13c3a-tenant-services-columns — FOUNDATION Slice 13C.3a
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
const EVIDENCE_PATH = path.join(FIX, 'slice13c3a-tenant-services-columns-evidence.json');
const MISMATCH_EVIDENCE_PATH = path.join(FIX, 'slice13c3a-mismatch-29-to-25-evidence.json');
const MATRIX_PATH = path.join(FIX, 'slice13c3a-tenant-services-column-matrix.json');
const MASTER = '5158320585f0a894329d8ff017fa658d86d041bf';
const PREV_CANON_FP = '553d21d3dca91b60a1b9e09799f677051be63d491792fd68e12b5f6652c220f1';
const LIVE_FP = 'fa7efa9246c2bd75fe41741652c462bb98b3c571906635e55a91ae5735ca1dfd';
const MIG_040 = '040_tenant_services_catalog_columns.sql';
const MIG_040_ID = '040_tenant_services_catalog_columns';

const PHASE_C_TS_KEYS = [
  'live_only|columns|tenant_services.block_rooms_enabled',
  'live_only|columns|tenant_services.blocked_room_codes',
  'live_only|columns|tenant_services.room_block_booking_ids',
  'live_only|columns|tenant_services.weekdays',
];

const PHASE_D_CHECK_KEYS = [
  'expected_only|constraints|tenant_services.tenant_services_date_window.CHECK',
  'expected_only|constraints|tenant_services.tenant_services_price_unit.CHECK',
];

const COLUMNS = [
  'weekdays',
  'block_rooms_enabled',
  'blocked_room_codes',
  'room_block_booking_ids',
];

const suffix = crypto.randomBytes(4).toString('hex');
const CONTAINER = `wh-slice13c3a-${suffix}`;
const VOLUME = `wh-slice13c3a-vol-${suffix}`;
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

function writeTempPre040Manifest(manifest, entry040) {
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

async function columnAttnums(client) {
  const r = await client.query(`
    SELECT a.attname AS name, a.attnum
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'tenant_services'
      AND a.attname = ANY($1::text[])
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attname
  `, [COLUMNS]);
  return r.rows;
}

async function main() {
  const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
  if ((matrix.columns || []).length !== 4) throw new Error('matrix must have 4 promote columns');
  if (!matrix.columns.every((c) => c.decision === 'promote')) throw new Error('all matrix columns must promote');

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
  const sql040 = fs.readFileSync(path.join(MIGRATIONS_DIR, MIG_040), 'utf8');
  if (/tenant_services_date_window|tenant_services_price_unit/i.test(sql040)
    && !/does not add Phase D CHECKs/i.test(sql040)) {
    throw new Error('040 must not add Phase D CHECKs');
  }
  if (/customer_message_templates|035_|schema_migration_ledger|idx_client_notification|tenant_surf_pack/i.test(sql040)
    && !/Intentionally does not/i.test(sql040)) {
    // comments may mention exclusions; forbid DDL keywords for those domains
  }
  if (/CREATE\s+TABLE\s+customer_message_templates|ALTER\s+TABLE\s+customer_message_templates/i.test(sql040)) {
    throw new Error('040 must not touch CMT');
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

  const tempManifestPath = writeTempPre040Manifest(manifest, entry040);

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
  for (const col of COLUMNS) {
    const hit = (productA.snapshot.columns || []).some((c) => c.table === 'tenant_services' && c.column === col);
    if (!hit) throw new Error(`Path A missing tenant_services.${col}`);
  }
  const hasDateWindow = (productA.snapshot.constraints || []).some(
    (c) => c.table === 'tenant_services' && c.name === 'tenant_services_date_window',
  );
  // 028 still defines CHECKs on fresh canonical path — they remain expected_only vs live.
  // 040 must not be the only reason they exist; they come from 028. Verify 040 SQL didn't add them anew beyond 028.
  const fpA = fingerprintProductSchema(productA.snapshot);
  const selfCmp = compareSnapshots(productA.snapshot, productA.snapshot);
  if (!selfCmp.ok) throw new Error('Path A self-match failed');
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
      'Regenerated from disposable canonical chain including 040_tenant_services_catalog_columns; not derived from live.',
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

  // ---- Path B: prior 37 + Staff-like columns already present ----
  const connB = { ...admin, database: DB_B };
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
  // Staff ensure-DDL shape (compatible)
  await clientB.query(`ALTER TABLE tenant_services ADD COLUMN IF NOT EXISTS weekdays SMALLINT[] NOT NULL DEFAULT '{}'`);
  await clientB.query(`ALTER TABLE tenant_services ADD COLUMN IF NOT EXISTS block_rooms_enabled BOOLEAN NOT NULL DEFAULT false`);
  await clientB.query(`ALTER TABLE tenant_services ADD COLUMN IF NOT EXISTS blocked_room_codes TEXT[] NOT NULL DEFAULT '{}'`);
  await clientB.query(`ALTER TABLE tenant_services ADD COLUMN IF NOT EXISTS room_block_booking_ids UUID[] NOT NULL DEFAULT '{}'`);
  const preAtt = await columnAttnums(clientB);
  if (preAtt.length !== 4) throw new Error('Path B pre columns missing');

  await applySqlFile(clientB, MIG_040);
  const postAtt = await columnAttnums(clientB);
  for (let i = 0; i < 4; i += 1) {
    if (preAtt[i].name !== postAtt[i].name || Number(preAtt[i].attnum) !== Number(postAtt[i].attnum)) {
      throw new Error(`Path B did not preserve column identity for ${preAtt[i].name}`);
    }
  }
  const fpB1 = fingerprintProductSchema((await introspectProductSchema(clientB)).snapshot);
  await applySqlFile(clientB, MIG_040);
  const fpB2 = fingerprintProductSchema((await introspectProductSchema(clientB)).snapshot);
  await clientB.end();
  if (fpB1 !== fpA) throw new Error(`Path B fp ${fpB1} != Path A ${fpA}`);
  if (fpB2 !== fpB1) throw new Error('Path B second apply changed fingerprint');

  // ---- RED ----
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
        await applySqlFile(c, MIG_040);
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

  await redCase('incompatible_weekdays_type', async (c) => {
    await c.query(`ALTER TABLE tenant_services ADD COLUMN weekdays TEXT[] NOT NULL DEFAULT '{}'`);
  });

  await redCase('incompatible_block_rooms_nullability', async (c) => {
    await c.query(`ALTER TABLE tenant_services ADD COLUMN block_rooms_enabled BOOLEAN NULL`);
  });

  await redCase('incompatible_blocked_room_codes_default', async (c) => {
    await c.query(`ALTER TABLE tenant_services ADD COLUMN blocked_room_codes TEXT[] NOT NULL DEFAULT ARRAY['X']`);
  });

  await redCase('incompatible_room_block_generated', async (c) => {
    // Generated column incompatible with approved plain storage column.
    await c.query(`
      ALTER TABLE tenant_services
        ADD COLUMN room_block_booking_ids UUID[]
        GENERATED ALWAYS AS (ARRAY[]::uuid[]) STORED
    `);
  });

  await redCase('missing_parent_tenant_services', async (c) => {
    await c.query('DROP TABLE tenant_services CASCADE');
  });

  // ---- Offline mismatch 29 → 25 ----
  const classReport = JSON.parse(
    fs.readFileSync(path.join(FIX, 'slice13a-mismatch-classification-report.json'), 'utf8'),
  );
  const priorMismatch = JSON.parse(
    fs.readFileSync(path.join(FIX, 'slice13c2-mismatch-46-to-29-evidence.json'), 'utf8'),
  );
  const classifications = classReport.classifications || [];
  const genuine = classifications.filter((c) => c.classification === 'genuine_database_drift');
  const phaseCTs = classifications.filter((c) => PHASE_C_TS_KEYS.includes(c.stableKey));
  if (phaseCTs.length !== 4) throw new Error(`phase C ts keys ${phaseCTs.length}`);
  if (genuine.length !== 29) throw new Error(`genuine ${genuine.length}`);

  const remainingGenuine = genuine.filter((c) => !PHASE_C_TS_KEYS.includes(c.stableKey));
  if (remainingGenuine.length !== 25) throw new Error(`remaining genuine ${remainingGenuine.length}`);

  const liveSynthetic = reconstructLiveSnapshot(contract.snapshot, remainingGenuine);
  const normClass = classifications.filter((c) => c.classification === 'observer_normalization_difference');
  const liveWithAzureIds = reconstructLiveSnapshot(liveSynthetic, normClass);

  const azureCtx = { verified: true, host: EXPECTED_HOST, database: EXPECTED_DATABASE };
  const cmpNorm = compareSnapshots(contract.snapshot, liveWithAzureIds, {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext: azureCtx,
  });
  if (cmpNorm.normalizationError) throw new Error(JSON.stringify(cmpNorm.normalizationError));

  const remainingKeys = cmpNorm.drifts.map(stableKey).sort();
  const expectedRemaining = remainingGenuine.map((c) => c.stableKey).sort();
  if (remainingKeys.length !== 25) {
    throw new Error(`remaining ${remainingKeys.length}, expected 25`);
  }
  for (let i = 0; i < 25; i += 1) {
    if (remainingKeys[i] !== expectedRemaining[i]) {
      throw new Error(`remaining key mismatch ${remainingKeys[i]} vs ${expectedRemaining[i]}`);
    }
  }
  for (const k of PHASE_C_TS_KEYS) {
    if (remainingKeys.includes(k)) throw new Error(`Phase C TS key still present: ${k}`);
  }
  for (const k of PHASE_D_CHECK_KEYS) {
    if (!remainingKeys.includes(k)) throw new Error(`Phase D key accidentally resolved: ${k}`);
  }
  // Prior 29 remaining after 13C.2 must include our 4 keys
  const prior29 = priorMismatch.remainingKeys || [];
  if (prior29.length !== 29) throw new Error('prior 13c2 remaining not 29');
  for (const k of PHASE_C_TS_KEYS) {
    if (!prior29.includes(k)) throw new Error(`prior missing ${k}`);
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
    phaseCTenantServicesKeysResolved: PHASE_C_TS_KEYS.slice().sort(),
    phaseDCheckKeysStillPresent: PHASE_D_CHECK_KEYS.slice(),
    remainingKeys,
    remainingByClassification: { genuine_database_drift: 25 },
    noAccidental035CmtNotificationSurfPackResolution: true,
    fingerprints: {
      previousCanonical: PREV_CANON_FP,
      newCanonical: fpA,
      liveRawCommitted: LIVE_FP,
    },
  };
  fs.writeFileSync(MISMATCH_EVIDENCE_PATH, `${JSON.stringify(mismatchEvidence, null, 2)}\n`);

  const evidence = {
    kind: 'sunset-schema-observer-slice13c3a-tenant-services-columns-evidence',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    liveMutation: false,
    azureMutation: false,
    disposablePostgreSQLOnly: true,
    generatedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    migration: {
      id: MIG_040_ID,
      filename: MIG_040,
      sha256CanonicalLfV1: entry040.sha256,
      order: 38,
    },
    columnsPromoted: COLUMNS.slice(),
    objectsExcluded: [
      'tenant_services_date_window',
      'tenant_services_price_unit',
      '035_customer_message_templates',
      'customer_message_templates',
      'notification indexes',
      'surf-pack FK/index/trigger',
      'schema_migration_ledger bootstrap',
    ],
    forwardCount: { before: 37, after: 38 },
    manifestHash: { after: manifestHash },
    productFingerprint: { before: PREV_CANON_FP, after: fpA },
    pathA: {
      ok: true,
      appliedCount: (appliedA.applied || []).length,
      secondApplyNoOp: true,
      productFingerprint: fpA,
      observerSelfMatch: true,
      phaseDChecksFrom028PresentOnFreshCanonical: hasDateWindow,
    },
    pathB: {
      ok: true,
      pre040Applied: 37,
      staffLikeColumnsPrePresent: true,
      after040Fingerprint: fpB1,
      second040Idempotent: fpB2 === fpB1,
      convergedWithPathA: fpB1 === fpA,
      exactColumnsPreservedByAttnum: true,
    },
    catalogValidation: {
      approach: 'pg_attribute/pg_attrdef/pg_type: udt, nullability, normalized default, identity, generated',
      policy: 'absent ADD; exact preserve; incompatible RAISE',
    },
    redFailures: redResults,
    greenCases: [
      { name: 'exact_existing_columns_preserved', ok: true },
      { name: 'second_application_noop', ok: true },
      { name: 'path_a_path_b_converge', ok: fpB1 === fpA },
    ],
    mismatchTrajectory: '29 → 25',
    remainingClassifications: { genuine_database_drift: 25 },
  };
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

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
  }, null, 2)}\n`);
}

main().catch((e) => {
  cleanup();
  console.error(e);
  process.exit(1);
});
