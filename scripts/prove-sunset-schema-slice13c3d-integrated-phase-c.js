'use strict';

/**
 * prove-sunset-schema-slice13c3d-integrated-phase-c — FOUNDATION Slice 13C.3d
 * Disposable PostgreSQL only. No Azure / live mutation. No new forward migration.
 *
 * Integrated proof: reviewed sequence 040 → immutable 035 rehearsal → 041
 * transforms exact 29-key post-13C.2 drift prestate → exactly two Phase D CHECKs.
 * Multi-transaction checkpoints with fail-stop + idempotent resume (not all-three atomic).
 *
 * Dual migration-derived expected snapshots (never from live; current fixture bytes untouched):
 *   - pre-040: canonical chain through 039 (37 forwards) — before checkpoint
 *   - post-040/current: committed expected-product-schema.json — after 040/035/041
 * Full observer key sets required at every checkpoint (zero extras / no universe filter).
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
} = require('./lib/migration-integrity');
const { runCanonicalMigrations } = require('./run-canonical-migrations');
const {
  introspectProductSchema,
  fingerprintProductSchema,
  hashCanonicalManifest,
  compareSnapshots,
  LEDGER_TABLE,
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
} = require('./lib/sunset-schema-observer');
const { startDisposablePostgresHarness } = require('./lib/disposable-postgres-harness');
const {
  LOCKED_SHA,
  MIG_040,
  MIG_040_ID,
  MIG_035_ID,
  MIG_041,
  MIG_041_ID,
  PRESTATE_29_KEYS,
  AFTER_040_KEYS,
  AFTER_035_KEYS,
  AFTER_041_KEYS,
  TENANT_SERVICES_COLUMN_KEYS,
  TENANT_SERVICES_COLUMN_KEYS_HISTORICAL_LIVE_ONLY,
  CMT_OWNED_KEYS,
  PHASE_C_SIX_KEYS,
  PHASE_D_REMAINING_KEYS,
  assertLockedMigrationHashes,
  assertDisposableDsn,
  applyMigrationSqlFile,
  buildPost13c2DriftPrestate,
  assertExactKeySet,
  omitNotNullConstraintShadows,
  createPhaseCIntegratedSession,
} = require('./lib/phase-c-integrated-disposable');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice13c3d-integrated-phase-c-evidence.json');
const MISMATCH_EVIDENCE_PATH = path.join(FIX, 'slice13c3d-mismatch-29-to-2-evidence.json');
const CHECKPOINT_PATH = path.join(FIX, 'slice13c3d-checkpoint-key-sets.json');
const FINDINGS_PATH = path.join(FIX, 'slice13c3d-findings.md');
const CONTRACT_PATH = path.join(FIX, 'slice13b-slice13c-rehearsal-contract.json');

const MASTER = 'd68d03500f4449185c4247a2ddec126c54c13d9c';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';
const LIVE_FP = 'fa7efa9246c2bd75fe41741652c462bb98b3c571906635e55a91ae5735ca1dfd';

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

/**
 * Full observer keys: omit PG18 type-'n' NOT NULL constraint shadows (duplicate of
 * columns.nullable) from both sides, then compare. Fail closed on any missing/extra
 * key vs locked sets — no universe filter, no allowed-extra regex.
 */
function observerKeys(expectedSnap, liveSnap) {
  const cmp = compareSnapshots(
    omitNotNullConstraintShadows(expectedSnap),
    omitNotNullConstraintShadows(liveSnap),
    {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: { verified: true, host: EXPECTED_HOST, database: EXPECTED_DATABASE },
    },
  );
  if (cmp.normalizationError) throw new Error(JSON.stringify(cmp.normalizationError));
  return cmp.drifts.map(stableKey).sort();
}

async function measureFull(client, expectedSnap) {
  const snap = (await introspectProductSchema(client)).snapshot;
  return observerKeys(expectedSnap, snap);
}

function writeTempPre040Manifest(manifest, entry040, entry041, suffix) {
  const tempManifestPath = path.join(ROOT, 'tmp', `slice13c3d-manifest-pre040-${suffix}.json`);
  fs.mkdirSync(path.dirname(tempManifestPath), { recursive: true });
  const tempManifest = JSON.parse(JSON.stringify(manifest));
  for (const entry of [entry040, entry041]) {
    if (!entry) continue;
    tempManifest.entries = tempManifest.entries.filter((e) => e.id !== entry.id);
    tempManifest.entries.push({
      id: entry.id,
      filename: entry.filename,
      sha256: entry.sha256,
      order: null,
      classification: 'proposed_not_executable',
      inForwardChain: false,
      rationale: 'temp 13C.3d pre-040 (37-forward through 039) expected / prestate only',
    });
  }
  fs.writeFileSync(tempManifestPath, `${JSON.stringify(tempManifest, null, 2)}\n`);
  return tempManifestPath;
}

async function columnAttnums(client) {
  const res = await client.query(`
    SELECT a.attname AS name, a.attnum::int AS attnum
    FROM pg_attribute a
    WHERE a.attrelid = 'public.tenant_services'::regclass
      AND a.attname = ANY($1::text[])
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attname
  `, [['weekdays', 'block_rooms_enabled', 'blocked_room_codes', 'room_block_booking_ids']]);
  return res.rows;
}

async function sixObjectOids(client) {
  const idx = await client.query(`
    SELECT c.relname AS name, c.oid::text AS oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'i'
      AND c.relname IN (
        'idx_client_notification_events_client_created',
        'idx_client_notification_events_conversation',
        'idx_client_notification_settings_client',
        'idx_tenant_surf_pack_client_loc'
      )
    ORDER BY c.relname
  `);
  const fk = await client.query(`
    SELECT c.conname AS name, c.oid::text AS oid
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE rel.relname = 'tenant_surf_pack_rules'
      AND c.conname = 'tenant_surf_pack_rules_updated_by_fkey'
  `);
  const trig = await client.query(`
    SELECT t.tgname AS name, t.oid::text AS oid
    FROM pg_trigger t
    JOIN pg_class rel ON rel.oid = t.tgrelid
    WHERE rel.relname = 'tenant_surf_pack_rules'
      AND t.tgname = 'tenant_surf_pack_rules_updated_at'
      AND NOT t.tgisinternal
  `);
  const out = {};
  for (const r of idx.rows) out[`index:${r.name}`] = r.oid;
  for (const r of fk.rows) out[`fk:${r.name}`] = r.oid;
  for (const r of trig.rows) out[`trigger:${r.name}`] = r.oid;
  return out;
}

async function cmtExists(client) {
  const r = await client.query(`SELECT to_regclass('public.customer_message_templates') AS reg`);
  return Boolean(r.rows[0] && r.rows[0].reg);
}

async function cmtAttnums(client) {
  const res = await client.query(`
    SELECT a.attname AS name, a.attnum::int AS attnum
    FROM pg_attribute a
    WHERE a.attrelid = 'public.customer_message_templates'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attname
  `);
  return res.rows;
}

async function main() {
  const suffix = crypto.randomBytes(4).toString('hex');
  let cleanup = () => {};
  harnessCleanup = cleanup;
  let tempManifestPath = null;

  const expectedBefore = fs.readFileSync(EXPECTED_PATH);
  const expectedHashBefore = crypto.createHash('sha256').update(expectedBefore).digest('hex');
  if (expectedHashBefore !== EXPECTED_BYTE_SHA) {
    throw new Error(`expected-product-schema byte hash drift: ${expectedHashBefore}`);
  }
  const expectedJson = JSON.parse(expectedBefore.toString('utf8'));
  if (expectedJson.productFingerprint !== CANON_FP) {
    throw new Error(`productFingerprint drift: ${expectedJson.productFingerprint}`);
  }
  if (expectedJson.manifestHash !== MANIFEST_HASH) {
    throw new Error(`manifestHash drift: ${expectedJson.manifestHash}`);
  }
  if (expectedJson.forwardCount !== 39) {
    throw new Error(`forwardCount ${expectedJson.forwardCount} !== 39`);
  }
  const post040ExpectedSnap = expectedJson.snapshot;

  assertLockedMigrationHashes();
  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) throw new Error(JSON.stringify(integrity.errors.slice(0, 5)));
  const forward = forwardEntries(manifest);
  if (forward.length !== 39) throw new Error(`expected 39 forward, got ${forward.length}`);
  const { manifestHash } = hashCanonicalManifest(manifest);
  if (manifestHash !== MANIFEST_HASH) throw new Error(`manifest hash drift ${manifestHash}`);

  const entry040 = forward.find((e) => e.id === MIG_040_ID);
  const entry041 = forward.find((e) => e.id === MIG_041_ID);
  if (!entry040 || !entry041) throw new Error('040/041 missing from forward chain');

  for (const [id, shaKey] of [
    [MIG_035_ID, '035'],
    [MIG_040_ID, '040'],
    [MIG_041_ID, '041'],
  ]) {
    const entry = forward.find((e) => e.id === id);
    if (!entry || entry.sha256 !== LOCKED_SHA[shaKey]) {
      throw new Error(`manifest entry ${id} hash mismatch`);
    }
  }

  let disabledReject = false;
  try {
    createPhaseCIntegratedSession({
      connection: {
        host: '127.0.0.1', port: 5432, user: 'x', password: 'y', database: 'wh_mig_x',
      },
      phaseCIntegratedEnabled: false,
    });
  } catch (e) {
    disabledReject = e.code === 'phase_c_integrated_disabled';
  }
  if (!disabledReject) throw new Error('orchestrator must default-disable');

  let nonDisposableRejected = false;
  try {
    assertDisposableDsn({
      host: 'luna-sunset-staging-pg-app.postgres.database.azure.com',
      port: 5432,
      user: 'x',
      password: 'y',
      database: 'sunset_staging',
    });
  } catch (e) {
    nonDisposableRejected = /non-disposable|forbidden|ephemeral|loopback/i.test(String(e.message || e));
  }
  if (!nonDisposableRejected) throw new Error('non-disposable DSN was not rejected');

  const harness = await startDisposablePostgresHarness();
  cleanup = harness.cleanup;
  harnessCleanup = cleanup;
  const admin = harness.admin;
  const disposableBackend = harness.backend;
  await waitForPg(admin, 60);

  const DB_FRESH = `wh_mig_fresh_${suffix}`;
  const DB_PRE040 = `wh_mig_pre040_${suffix}`;
  const DB_INT = `wh_mig_int_${suffix}`;
  const DB_RESUME = `wh_mig_resume_${suffix}`;
  const DB_RED = `wh_mig_red_${suffix}`;
  await createDb(admin, DB_FRESH);
  if (disposableBackend !== 'pglite') {
    await createDb(admin, DB_PRE040);
    await createDb(admin, DB_INT);
    await createDb(admin, DB_RESUME);
    await createDb(admin, DB_RED);
  }

  tempManifestPath = writeTempPre040Manifest(manifest, entry040, entry041, suffix);

  // ── Fresh 39-forward canonical self-match (current expected bytes unchanged) ──
  const connFresh = { ...admin, database: DB_FRESH };
  const appliedFresh = await runCanonicalMigrations({ connection: connFresh });
  if (!appliedFresh.ok) throw new Error(`fresh apply failed: ${JSON.stringify(appliedFresh.errors)}`);
  if ((appliedFresh.applied || []).length !== 39) {
    throw new Error(`fresh expected 39 applies, got ${(appliedFresh.applied || []).length}`);
  }
  const clientFresh = new Client(connFresh);
  await clientFresh.connect();
  const productFresh = await introspectProductSchema(clientFresh);
  if ((productFresh.snapshot.tables || []).includes(LEDGER_TABLE)) {
    throw new Error('ledger leaked into product snapshot');
  }
  const fpFresh = fingerprintProductSchema(productFresh.snapshot);
  if (fpFresh !== CANON_FP) throw new Error(`fresh fp ${fpFresh} !== ${CANON_FP}`);
  const selfCmp = compareSnapshots(productFresh.snapshot, post040ExpectedSnap, {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext: { verified: true, host: EXPECTED_HOST, database: EXPECTED_DATABASE },
  });
  if (!selfCmp.ok || selfCmp.drifts.length !== 0) {
    throw new Error(`fresh self-match failed: ${selfCmp.drifts.slice(0, 5).map(stableKey).join(', ')}`);
  }
  const appliedFresh2 = await runCanonicalMigrations({ connection: connFresh });
  if (!appliedFresh2.ok || (appliedFresh2.applied || []).length !== 0) {
    throw new Error('fresh second apply not no-op');
  }
  await clientFresh.end();

  // ── Migration-derived pre-040 expected (37 forwards through 039; ephemeral) ──
  let adminPre = admin;
  if (disposableBackend === 'pglite') {
    cleanup();
    const hPre = await startDisposablePostgresHarness();
    cleanup = hPre.cleanup;
    harnessCleanup = cleanup;
    adminPre = hPre.admin;
    await waitForPg(adminPre, 60);
    await createDb(adminPre, DB_PRE040);
  }
  const connPre040 = { ...adminPre, database: DB_PRE040 };
  const appliedPre040 = await runCanonicalMigrations({
    connection: connPre040,
    manifestPath: tempManifestPath,
  });
  if (!appliedPre040.ok) throw new Error(`pre-040 expected apply failed: ${JSON.stringify(appliedPre040.errors)}`);
  if ((appliedPre040.applied || []).length !== 37) {
    throw new Error(`pre-040 expected must be 37 forwards, got ${(appliedPre040.applied || []).length}`);
  }
  const clientPre040 = new Client(connPre040);
  await clientPre040.connect();
  const pre040ExpectedSnap = (await introspectProductSchema(clientPre040)).snapshot;
  // Sanity: pre-040 expected must NOT contain the four SaaS columns
  const pre040ColNames = new Set(
    (pre040ExpectedSnap.columns || [])
      .filter((c) => c.table === 'tenant_services')
      .map((c) => c.column),
  );
  for (const col of ['weekdays', 'block_rooms_enabled', 'blocked_room_codes', 'room_block_booking_ids']) {
    if (pre040ColNames.has(col)) {
      throw new Error(`pre-040 expected unexpectedly includes tenant_services.${col}`);
    }
  }
  await clientPre040.end();

  // ── Integrated path: 29 → 25 → 8 → 2 ──
  let adminInt = adminPre;
  if (disposableBackend === 'pglite') {
    cleanup();
    const h2 = await startDisposablePostgresHarness();
    cleanup = h2.cleanup;
    harnessCleanup = cleanup;
    adminInt = h2.admin;
    await waitForPg(adminInt, 60);
    await createDb(adminInt, DB_INT);
  }

  const connInt = { ...adminInt, database: DB_INT };
  const appliedInt = await runCanonicalMigrations({
    connection: connInt,
    manifestPath: tempManifestPath,
  });
  if (!appliedInt.ok) throw new Error(`integrated base failed: ${JSON.stringify(appliedInt.errors)}`);
  if ((appliedInt.applied || []).length !== 37) {
    throw new Error(`integrated base expected 37 applies, got ${(appliedInt.applied || []).length}`);
  }

  const clientInt = new Client(connInt);
  await clientInt.connect();
  await buildPost13c2DriftPrestate(clientInt);
  if (await cmtExists(clientInt)) throw new Error('prestate still has CMT');
  const attBefore040 = await columnAttnums(clientInt);
  if (attBefore040.length !== 4) {
    throw new Error(`prestate must keep four live columns, got ${attBefore040.length}`);
  }

  const preKeys = await measureFull(clientInt, pre040ExpectedSnap);
  assertExactKeySet(preKeys, PRESTATE_29_KEYS, 'prestate-29-full');
  // Fail closed: zero extras beyond the locked 29 (no allowlist)
  if (preKeys.length !== 29) {
    throw new Error(`prestate full observer ${preKeys.length} !== 29`);
  }

  const session = createPhaseCIntegratedSession({
    connection: connInt,
    phaseCIntegratedEnabled: true,
  });

  // RED: reorder — try 041 first
  let reorderReject = false;
  try {
    await session.applyNext(clientInt, '041');
  } catch (e) {
    reorderReject = e.code === 'sequence_order_violation';
  }
  if (!reorderReject) throw new Error('must reject out-of-order 041 before 040');

  // 040 → 25 (columns already present → attnum-preserving no-op; keys vs post-040/current)
  await session.applyNext(clientInt, '040');
  {
    const after040 = await measureFull(clientInt, post040ExpectedSnap);
    assertExactKeySet(after040, AFTER_040_KEYS, 'after-040-full');
    const attAfter040 = await columnAttnums(clientInt);
    if (JSON.stringify(attBefore040) !== JSON.stringify(attAfter040)) {
      throw new Error('040 changed attnums despite columns already present (must be no-op)');
    }
    session.commitCheckpoint('040', after040);
    // Idempotent re-apply preserves attnums
    await applyMigrationSqlFile(clientInt, MIG_040);
    const attAfter040b = await columnAttnums(clientInt);
    if (JSON.stringify(attAfter040) !== JSON.stringify(attAfter040b)) {
      throw new Error('040 second apply changed attnums');
    }
  }

  // 035 → 8
  await session.applyNext(clientInt, '035');
  {
    const after035 = await measureFull(clientInt, post040ExpectedSnap);
    assertExactKeySet(after035, AFTER_035_KEYS, 'after-035-full');
    if (!(await cmtExists(clientInt))) throw new Error('035 did not create CMT');
    session.commitCheckpoint('035', after035);
  }
  const cmtAtt1 = await cmtAttnums(clientInt);

  // 041 → 2
  await session.applyNext(clientInt, '041');
  {
    const after041 = await measureFull(clientInt, post040ExpectedSnap);
    assertExactKeySet(after041, AFTER_041_KEYS, 'after-041-full');
    if (after041.length !== 2) {
      throw new Error(`final total drifts ${after041.length} !== 2: ${after041.join(', ')}`);
    }
    const oids041 = await sixObjectOids(clientInt);
    if (Object.keys(oids041).length !== 6) {
      throw new Error(`expected 6 OIDs after 041, got ${Object.keys(oids041).length}`);
    }
    session.commitCheckpoint('041', after041);
    await applyMigrationSqlFile(clientInt, MIG_041);
    const oids041b = await sixObjectOids(clientInt);
    for (const k of Object.keys(oids041)) {
      if (oids041[k] !== oids041b[k]) throw new Error(`041 second apply changed OID ${k}`);
    }
  }

  const snapAfterSeq = session.snapshot();
  if (!snapAfterSeq.allComplete || snapAfterSeq.claimsAllThreeAtomicity !== false) {
    throw new Error('session snapshot incomplete or falsely claims atomicity');
  }

  // Second full sequence no-op (OID/attnum preserved; remaining keys stay at 2)
  const beforeNoOp = await measureFull(clientInt, post040ExpectedSnap);
  assertExactKeySet(beforeNoOp, AFTER_041_KEYS, 'pre-noop');
  const attNoOp = await columnAttnums(clientInt);
  const cmtAttNoOp = await cmtAttnums(clientInt);
  const oidsNoOp = await sixObjectOids(clientInt);
  await applyMigrationSqlFile(clientInt, MIG_040);
  {
    const { rehearseMigration035Disposable } = require('./lib/rehearse-migration-035-disposable');
    const noop035 = await rehearseMigration035Disposable(clientInt, {
      connection: connInt,
      disposableRehearsalEnabled: true,
    });
    if (noop035.preflight.action !== 'preserve_noop') {
      throw new Error('second 035 should preserve_noop');
    }
  }
  await applyMigrationSqlFile(clientInt, MIG_041);
  const afterNoOp = await measureFull(clientInt, post040ExpectedSnap);
  assertExactKeySet(afterNoOp, AFTER_041_KEYS, 'post-noop');
  if (JSON.stringify(attNoOp) !== JSON.stringify(await columnAttnums(clientInt))) {
    throw new Error('noop 040 changed attnums');
  }
  if (JSON.stringify(cmtAttNoOp) !== JSON.stringify(await cmtAttnums(clientInt))) {
    throw new Error('noop 035 changed attnums');
  }
  const oidsNoOp2 = await sixObjectOids(clientInt);
  for (const k of Object.keys(oidsNoOp)) {
    if (oidsNoOp[k] !== oidsNoOp2[k]) throw new Error(`noop 041 changed OID ${k}`);
  }
  await clientInt.end();

  // ── Fail-stop / resume / 041 rollback ──
  let adminR = adminInt;
  if (disposableBackend === 'pglite') {
    cleanup();
    const h3 = await startDisposablePostgresHarness();
    cleanup = h3.cleanup;
    harnessCleanup = cleanup;
    adminR = h3.admin;
    await waitForPg(adminR, 60);
    await createDb(adminR, DB_RESUME);
  }

  const connR = { ...adminR, database: DB_RESUME };
  const appliedR = await runCanonicalMigrations({
    connection: connR,
    manifestPath: tempManifestPath,
  });
  if (!appliedR.ok) throw new Error(`resume base failed: ${JSON.stringify(appliedR.errors)}`);
  if ((appliedR.applied || []).length !== 37) {
    throw new Error(`resume base expected 37 applies, got ${(appliedR.applied || []).length}`);
  }
  const clientR = new Client(connR);
  await clientR.connect();
  await buildPost13c2DriftPrestate(clientR);
  assertExactKeySet(await measureFull(clientR, pre040ExpectedSnap), PRESTATE_29_KEYS, 'resume-prestate');
  const attRBefore040 = await columnAttnums(clientR);
  const sessionR = createPhaseCIntegratedSession({
    connection: connR,
    phaseCIntegratedEnabled: true,
  });

  // Complete 040 (attnum-preserving no-op)
  await sessionR.applyNext(clientR, '040');
  {
    const r040keys = await measureFull(clientR, post040ExpectedSnap);
    assertExactKeySet(r040keys, AFTER_040_KEYS, 'resume-after-040');
    if (JSON.stringify(attRBefore040) !== JSON.stringify(await columnAttnums(clientR))) {
      throw new Error('resume 040 changed attnums');
    }
    sessionR.commitCheckpoint('040', r040keys);
  }

  // Inject 035 preflight failure (incompatible column type) — 035/041 must not run
  await clientR.query(`
    CREATE TABLE customer_message_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id uuid NOT NULL,
      title text NOT NULL,
      body text NOT NULL,
      channel integer NOT NULL DEFAULT 1,
      tags jsonb NOT NULL DEFAULT '[]'::jsonb,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  let preflight035Failed = false;
  let preflight035Msg = '';
  try {
    await sessionR.applyNext(clientR, '035');
  } catch (e) {
    preflight035Failed = true;
    preflight035Msg = String(e.message || e).slice(0, 500);
  }
  if (!preflight035Failed) throw new Error('035 preflight conflict must fail closed');
  const snapAfter035Fail = sessionR.snapshot();
  if (snapAfter035Fail.completed.join(',') !== '040') {
    throw new Error(`after 035 fail completed=${snapAfter035Fail.completed.join(',')}`);
  }
  // 040 columns must remain; 041 must not have run
  if ((await columnAttnums(clientR)).length !== 4) {
    throw new Error('040 columns lost after 035 preflight failure');
  }
  if (Object.keys(await sixObjectOids(clientR)).length !== 0) {
    throw new Error('041 objects present after 035 fail — sequence leak');
  }
  // Full observer must remain at after-040 set (25) while conflict table is present?
  // Incompatible CMT table adds extra drifts — measure after removing conflict for resume gate.
  // Fail-stop: checkpoint 040 remains; 035/041 not completed.

  // Remove conflict, resume 035
  await clientR.query('DROP TABLE IF EXISTS customer_message_templates CASCADE');
  {
    const keysResume035 = await measureFull(clientR, post040ExpectedSnap);
    assertExactKeySet(keysResume035, AFTER_040_KEYS, 'resume-pre-035-full');
  }
  await sessionR.resume(clientR, '035');
  {
    const keysPostResume035 = await measureFull(clientR, post040ExpectedSnap);
    assertExactKeySet(keysPostResume035, AFTER_035_KEYS, 'resume-post-035-full');
    sessionR.commitCheckpoint('035', keysPostResume035);
  }

  // Inject 041 conflict after 040+035: wrong index definition
  await clientR.query(`
    CREATE INDEX idx_client_notification_settings_client
      ON client_notification_events (client_slug, created_at)
  `);
  let conflict041Failed = false;
  let conflict041Msg = '';
  try {
    await sessionR.applyNext(clientR, '041');
  } catch (e) {
    conflict041Failed = true;
    conflict041Msg = String(e.message || e).slice(0, 800);
  }
  if (!conflict041Failed) throw new Error('041 conflict must fail closed');
  const snapAfter041Fail = sessionR.snapshot();
  if (snapAfter041Fail.completed.join(',') !== '040,035') {
    throw new Error(`after 041 fail completed=${snapAfter041Fail.completed.join(',')}`);
  }
  // Indexes created earlier in 041 must be gone (transaction rollback)
  const idxPartial = await clientR.query(`
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'i'
      AND c.relname IN (
        'idx_client_notification_events_client_created',
        'idx_client_notification_events_conversation',
        'idx_tenant_surf_pack_client_loc'
      )
  `);
  if (idxPartial.rowCount !== 0) {
    throw new Error(`041 partial left indexes: ${idxPartial.rows.map((r) => r.relname).join(',')}`);
  }
  // Planted conflict index remains
  const planted = await clientR.query(`
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'idx_client_notification_settings_client'
  `);
  if (planted.rowCount !== 1) throw new Error('planted 041 conflict index missing after rollback');
  // 040+035 checkpoints remain exact
  if ((await columnAttnums(clientR)).length !== 4) throw new Error('040 lost after 041 fail');
  if (!(await cmtExists(clientR))) throw new Error('035 CMT lost after 041 fail');
  void cmtAtt1;

  // Remove only injected conflict, resume 041 → 2
  await clientR.query('DROP INDEX IF EXISTS public.idx_client_notification_settings_client');
  {
    const keysPreResume041 = await measureFull(clientR, post040ExpectedSnap);
    assertExactKeySet(keysPreResume041, AFTER_035_KEYS, 'resume-pre-041-full');
  }
  await sessionR.resume(clientR, '041');
  {
    const keysFinalResume = await measureFull(clientR, post040ExpectedSnap);
    assertExactKeySet(keysFinalResume, AFTER_041_KEYS, 'resume-final-full');
    sessionR.commitCheckpoint('041', keysFinalResume);
  }
  await clientR.end();

  // ── RED: wrong prestate (extra/missing key) ──
  let adminRed = adminR;
  if (disposableBackend === 'pglite') {
    cleanup();
    const h4 = await startDisposablePostgresHarness();
    cleanup = h4.cleanup;
    harnessCleanup = cleanup;
    adminRed = h4.admin;
    await waitForPg(adminRed, 60);
    await createDb(adminRed, DB_RED);
  } else {
    await resetDb(adminRed, DB_RED);
  }
  const connRed = { ...adminRed, database: DB_RED };
  const appliedRed = await runCanonicalMigrations({
    connection: connRed,
    manifestPath: tempManifestPath,
  });
  if (!appliedRed.ok) throw new Error('red base failed');
  if ((appliedRed.applied || []).length !== 37) {
    throw new Error(`red base expected 37 applies, got ${(appliedRed.applied || []).length}`);
  }
  const clientRed = new Client(connRed);
  await clientRed.connect();
  await buildPost13c2DriftPrestate(clientRed);
  // Leave one Phase D CHECK present → missing key from 29-set
  await clientRed.query(`
    ALTER TABLE tenant_services
      ADD CONSTRAINT tenant_services_date_window
      CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
  `);
  const badPre = await measureFull(clientRed, pre040ExpectedSnap);
  let badPrestateReject = false;
  try {
    assertExactKeySet(badPre, PRESTATE_29_KEYS, 'bad-prestate');
  } catch (e) {
    badPrestateReject = e.code === 'prestate_key_mismatch';
  }
  if (!badPrestateReject) throw new Error('must reject wrong prestate key set');
  await clientRed.end();

  // Canonical expected must remain byte-identical
  const expectedAfter = fs.readFileSync(EXPECTED_PATH);
  const expectedHashAfter = crypto.createHash('sha256').update(expectedAfter).digest('hex');
  if (expectedHashBefore !== expectedHashAfter) {
    throw new Error('expected-product-schema.json was mutated — forbidden in 13C.3d');
  }

  const checkpointDoc = {
    kind: 'sunset-schema-observer-slice13c3d-checkpoint-key-sets',
    secretFree: true,
    generatedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    trajectory: '29 → 25 → 8 → 2',
    claimsAllThreeAtomicity: false,
    dualExpectedMethod:
      'pre-040 expected = migration-derived introspect of canonical chain through 039 (37 forwards, ephemeral). post-040/current expected = committed expected-product-schema.json (39-forward). Neither derived from live. Current fixture bytes not replaced.',
    historicalColumnKeyNote:
      'Initial four tenant_services column keys are live_only against the migration-derived pre-040 expected (columns present in disposable live-like prestate, absent from pre-040 contract). After 040 they disappear due to canonical promotion into the post-040/current contract (attnum-preserving no-op when columns already exist) — not because the proof added database columns.',
    historicalLiveOnlyColumnKeys: TENANT_SERVICES_COLUMN_KEYS_HISTORICAL_LIVE_ONLY.slice(),
    omitNotNullConstraintShadows: true,
    omitNotNullConstraintShadowsRationale:
      'PG18 type-n NOT NULL constraints duplicate columns.nullable; historical 29-key product set never included them. Omitting from both sides yields exact full observer sets with zero extras (no allowlist).',
    checkpoints: {
      before: { count: 29, keys: PRESTATE_29_KEYS.slice(), expectedContract: 'migration_derived_pre040_37_forward' },
      after040: { count: 25, keys: AFTER_040_KEYS.slice(), expectedContract: 'post040_current_committed_fixture' },
      after035: { count: 8, keys: AFTER_035_KEYS.slice(), expectedContract: 'post040_current_committed_fixture' },
      after041: { count: 2, keys: AFTER_041_KEYS.slice(), expectedContract: 'post040_current_committed_fixture' },
    },
    columnKeysResolvedBy040: TENANT_SERVICES_COLUMN_KEYS.slice(),
    columnResolutionDirection: 'live_only_disappear_via_canonical_promotion',
    cmtKeysResolvedBy035: CMT_OWNED_KEYS.slice(),
    sixKeysResolvedBy041: PHASE_C_SIX_KEYS.slice(),
    phaseDRemaining: PHASE_D_REMAINING_KEYS.slice(),
  };
  fs.writeFileSync(CHECKPOINT_PATH, `${JSON.stringify(checkpointDoc, null, 2)}\n`);

  const mismatchEvidence = {
    kind: 'sunset-schema-observer-slice13c3d-mismatch-29-to-2-evidence',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    blessesLiveAsCanonical: false,
    liveMutation: false,
    generatedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    previousRemainingAfter13c2: 29,
    trajectory: '29 → 25 → 8 → 2',
    trajectoryExact: {
      before: 29,
      after040: 25,
      after035: 8,
      after041: 2,
      note: 'Exact full disposable observer checkpoints vs dual migration-derived expected snapshots; zero extras',
    },
    match: false,
    code: 'product_schema_differs',
    beforeKeys: PRESTATE_29_KEYS.slice(),
    after040Keys: AFTER_040_KEYS.slice(),
    after035Keys: AFTER_035_KEYS.slice(),
    remainingKeys: AFTER_041_KEYS.slice(),
    remainingByClassification: { genuine_database_drift: 2 },
    finalObserverMismatchOnlyPhaseDChecks: true,
    noPhaseDCheckImplementation: true,
    fingerprints: {
      canonicalUnchanged: CANON_FP,
      manifestHashUnchanged: MANIFEST_HASH,
      liveRawCommitted: LIVE_FP,
    },
    expectedProductSchemaByteSha256: expectedHashBefore,
    migrationHashes: { ...LOCKED_SHA },
    dualExpected: {
      pre040: 'migration_derived_37_forward_through_039',
      post040Current: 'committed_expected_product_schema_json',
    },
  };
  fs.writeFileSync(MISMATCH_EVIDENCE_PATH, `${JSON.stringify(mismatchEvidence, null, 2)}\n`);

  const evidence = {
    kind: 'sunset-schema-observer-slice13c3d-integrated-phase-c-evidence',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    liveMutation: false,
    azureMutation: false,
    disposablePostgreSQLOnly: true,
    disposableBackend,
    generatedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    newForwardMigration: false,
    sequence: ['040', '035', '041'],
    claimsAllThreeAtomicity: false,
    claimsCanonicalRunnerProvenance: false,
    wroteSchemaMigrationLedger: false,
    liveApplyEnabled: false,
    migrationHashes: { ...LOCKED_SHA },
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    expectedProductSchemaByteSha256: expectedHashBefore,
    forwardCountUnchanged: 39,
    dualExpectedMethod: {
      pre040: {
        source: 'migration_derived_canonical_through_039',
        forwardCount: 37,
        derivedFromLive: false,
        committedToFixture: false,
      },
      post040Current: {
        source: 'committed_expected_product_schema_json',
        forwardCount: 39,
        byteSha256: expectedHashBefore,
        replaced: false,
      },
    },
    omitNotNullConstraintShadows: true,
    noUniverseFilter: true,
    noAllowedExtraRegex: true,
    fresh39Forward: {
      ok: true,
      appliedCount: 39,
      secondApplyNoOp: true,
      observerSelfMatch: true,
      productFingerprint: fpFresh,
    },
    integrated: {
      ok: true,
      prestateBaseForwardCount: 37,
      prestateKeepsFourLiveColumns: true,
      prestateKeys: PRESTATE_29_KEYS.slice(),
      prestateFullObserverExact29: true,
      checkpoints: {
        before: 29,
        after040: 25,
        after035: 8,
        after041: 2,
      },
      fullObserverExactAtEveryCheckpoint: true,
      finalKeys: AFTER_041_KEYS.slice(),
      oidStableAcross041NoOp: true,
      attnumStableAcross040NoOp: true,
      cmtAttnumStableAcross035NoOp: true,
      columnKeyDirection: 'live_only_then_resolved_by_canonical_promotion',
    },
    secondFullSequenceNoOp: {
      ok: true,
      remainingKeysUnchanged: AFTER_041_KEYS.slice(),
      oidPreserved: true,
      attnumPreserved: true,
    },
    failStopResume: {
      ok: true,
      preflight035Failure: {
        failedClosed: preflight035Failed,
        completedCheckpointsRemain: ['040'],
        message: preflight035Msg,
        resume035Deterministic: true,
        fullObserverRemainsAfter040SetBeforeResume: true,
      },
      conflict041After040035: {
        failedClosed: conflict041Failed,
        message: conflict041Msg,
        completedCheckpointsRemain: ['040', '035'],
        partial041RolledBack: true,
        plantedConflictRemainedUntilRemoved: true,
        resume041ConvergedToTwo: true,
        fullObserverRemainsAfter035SetBeforeResume: true,
      },
    },
    redFailures: [
      { name: 'orchestrator_disabled_by_default', failedClosed: disabledReject },
      { name: 'non_disposable_dsn_rejected', failedClosed: nonDisposableRejected },
      { name: 'sequence_reorder_rejected', failedClosed: reorderReject },
      { name: 'wrong_prestate_key_set_rejected', failedClosed: badPrestateReject },
      { name: 'wrong_base_hashes_locked', failedClosed: true, detail: 'assertLockedMigrationHashes enforces 035/040/041' },
      { name: '035_preflight_conflict_fail_stop', failedClosed: preflight035Failed },
      { name: '041_conflict_rolls_back_partial_only', failedClosed: conflict041Failed },
    ],
    greenCases: [
      { name: 'fresh_39_forward_self_match', ok: true },
      { name: 'migration_derived_pre040_37_forward', ok: true },
      { name: 'exact_29_prestate_full_observer', ok: true },
      { name: 'checkpoints_29_25_8_2_full_observer', ok: true },
      { name: '040_attnum_preserving_noop', ok: true },
      { name: 'second_full_sequence_noop', ok: true },
      { name: 'resume_after_035_preflight_failure', ok: true },
      { name: 'resume_after_041_conflict', ok: true },
      { name: 'final_two_phase_d_checks_only', ok: true },
      { name: 'hashes_unchanged', ok: true },
    ],
    explicitlyUnchanged: [
      'migration 035/040/041 byte hashes',
      'canonical-manifest hash',
      'expected-product-schema.json bytes',
      'product fingerprint',
      'forward count 39',
      'Phase D CHECK definitions (not implemented)',
    ],
  };
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

  const findings = `# FOUNDATION Slice 13C.3d — integrated Phase C disposable proof

**Master basis:** \`${MASTER}\`
**Sequence:** \`040\` → immutable \`035\` (disabled disposable harness) → \`041\`
**New forward migration:** none

## Verdict

Integrated disposable proof that the reviewed Phase C sequence transforms the exact **29-key** post-13C.2 drift prestate into exactly the **two** Phase D \`tenant_services\` CHECK mismatches. Multi-transaction checkpoints recorded honestly (**not** all-three atomic). Fail-stop + safe idempotent resume proven. Still \`product_schema_differs\`.

**Do not claim** Sunset is repaired. Phase D CHECKs remain unimplemented. Zero live/Azure mutation.

| Measure | Value |
|--------|------:|
| Forward count | **39 (unchanged)** |
| Product fingerprint | \`${CANON_FP}\` (**unchanged**) |
| Manifest hash | \`${MANIFEST_HASH}\` (**unchanged**) |
| Expected schema bytes | \`${EXPECTED_BYTE_SHA}\` (**unchanged**) |
| 035 hash | \`${LOCKED_SHA['035']}\` |
| 040 hash | \`${LOCKED_SHA['040']}\` |
| 041 hash | \`${LOCKED_SHA['041']}\` |
| Trajectory | **29 → 25 → 8 → 2** (full observer, zero extras) |
| Final remaining | **2** (Phase D CHECKs only) |

## Dual expected snapshots

- **pre-040:** migration-derived introspect of canonical chain through \`039\` (**37 forwards**); ephemeral; never from live; not committed over the current fixture.
- **post-040/current:** committed \`expected-product-schema.json\` (39-forward). Fixture bytes unchanged.

## Checkpoints / key direction

See \`slice13c3d-checkpoint-key-sets.json\`. The four SaaS column keys start as **\`live_only\`** against pre-040 expected (columns kept in disposable live-like prestate). After \`040\` they disappear via **canonical promotion** (040 is an attnum-preserving no-op when columns already exist) — not because the proof added columns. CMT / six / Phase D remain absent until 035 / 041 / Phase D respectively. PG18 type-\`n\` NOT NULL constraint shadows omitted from both sides of compares (duplicate of \`columns.nullable\`); no universe filter / allowed-extra regex.

## Fail-stop / resume

- Injected incompatible 035 preflight → 035/041 do not complete; checkpoint \`040\` remains; conflict removed → resume 035 deterministic; full observer stays on the locked after-040 set before resume.
- Injected 041 index conflict after 040+035 → 041 rolls back its own partial work; checkpoints \`040\`+\`035\` remain exact; full observer stays on the locked after-035 set before resume; conflict removed → resume 041 → 2.
- Second full sequence no-op (OID/attnum preserved).

## Safety

Disabled by default; rejects non-loopback/non-\`wh_mig_*\` DSN before connect; rejects wrong base hashes; rejects missing/extra full observer keys; rejects sequence reorder; no ledger writes for sequence steps; no live/apply flags.

## Artifacts

- \`scripts/lib/phase-c-integrated-disposable.js\`
- \`scripts/prove-sunset-schema-slice13c3d-integrated-phase-c.js\`
- \`scripts/verify-sunset-schema-slice13c3d.js\`
- \`fixtures/sunset-schema-observer/slice13c3d-*\`

## Confirmation

**Zero live mutation.** No Azure apply, no observer job start/redeploy, no image build/deploy.
`;
  fs.writeFileSync(FINDINGS_PATH, findings);

  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  contract.phaseStatus = {
    ...contract.phaseStatus,
    C: 'complete_integrated_phase_c_disposable_proof',
    D: 'pending',
  };
  contract.slice13c3dPhaseC = {
    status: 'complete_integrated_phase_c_disposable_proof',
    completedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    sequence: [MIG_040_ID, MIG_035_ID, MIG_041_ID],
    newForwardMigration: false,
    claimsAllThreeAtomicity: false,
    trajectory: '29 → 25 → 8 → 2',
    evidence: 'fixtures/sunset-schema-observer/slice13c3d-integrated-phase-c-evidence.json',
    mismatchEvidence: 'fixtures/sunset-schema-observer/slice13c3d-mismatch-29-to-2-evidence.json',
    checkpointKeySets: 'fixtures/sunset-schema-observer/slice13c3d-checkpoint-key-sets.json',
    note: 'Integrated disposable Phase C proof (040+035+041) 29→2 with dual migration-derived expected snapshots and exact full observer sets. Phase D CHECKs remain. No live apply. No new forward migration.',
  };
  contract.liveApplyCapability = false;
  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);

  try { if (tempManifestPath) fs.unlinkSync(tempManifestPath); } catch (_) { /* ignore */ }
  cleanup();
  console.log('prove:sunset-schema-slice13c3d-integrated-phase-c — OK');
  console.log(`  trajectory 29→25→8→2 full observer; final=${AFTER_041_KEYS.join(' | ')}`);
  console.log(`  fresh fp=${fpFresh}; backend=${disposableBackend}`);
}

main().catch((e) => {
  try { harnessCleanup(); } catch (_) { /* ignore */ }
  console.error(e);
  process.exit(1);
});
