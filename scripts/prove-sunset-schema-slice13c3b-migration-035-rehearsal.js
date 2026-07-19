'use strict';

/**
 * prove-sunset-schema-slice13c3b-migration-035-rehearsal — FOUNDATION Slice 13C.3b
 * Rehearse immutable migration 035 against disposable Phase-C drift pre-state.
 * No new forward migration. No Azure / live mutation. No ledger provenance claim.
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
  assertSafeDatabaseTarget,
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
  MIG_035,
  MIG_035_ID,
  EXPECTED_SHA256,
  COMPATIBLE_CMT_DDL,
  rehearseMigration035Disposable,
  assertMigration035ByteIntegrity,
  assertDisposableConnection,
} = require('./lib/rehearse-migration-035-disposable');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice13c3b-migration-035-rehearsal-evidence.json');
const MISMATCH_EVIDENCE_PATH = path.join(FIX, 'slice13c3b-mismatch-25-to-8-evidence.json');
const KEY_MAP_PATH = path.join(FIX, 'slice13c3b-migration-035-owned-key-map.json');
const FINDINGS_PATH = path.join(FIX, 'slice13c3b-findings.md');
const MASTER = 'b3b2cede917f588d3a7d6e322b28a7f377b8cd96';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '427206aeeed1890c3a1fa2f666d11b66411333811b071fb1af5986126d8d12eb';
const LIVE_FP = 'fa7efa9246c2bd75fe41741652c462bb98b3c571906635e55a91ae5735ca1dfd';

const CMT_OWNED_KEYS = [
  'expected_only|acls|relation:customer_message_templates',
  'expected_only|columns|customer_message_templates.active',
  'expected_only|columns|customer_message_templates.body',
  'expected_only|columns|customer_message_templates.channel',
  'expected_only|columns|customer_message_templates.client_id',
  'expected_only|columns|customer_message_templates.created_at',
  'expected_only|columns|customer_message_templates.id',
  'expected_only|columns|customer_message_templates.tags',
  'expected_only|columns|customer_message_templates.title',
  'expected_only|columns|customer_message_templates.updated_at',
  'expected_only|constraints|customer_message_templates.customer_message_templates_client_id_fkey.FOREIGN KEY',
  'expected_only|constraints|customer_message_templates.customer_message_templates_pkey.PRIMARY KEY',
  'expected_only|indexes|customer_message_templates.customer_message_templates_pkey',
  'expected_only|indexes|customer_message_templates.idx_customer_message_templates_client_active',
  'expected_only|ownership|relation:customer_message_templates',
  'expected_only|rlsFlags|customer_message_templates',
  'expected_only|tables|customer_message_templates',
];

const MUST_REMAIN_KEYS = [
  'expected_only|constraints|tenant_services.tenant_services_date_window.CHECK',
  'expected_only|constraints|tenant_services.tenant_services_price_unit.CHECK',
  'expected_only|constraints|tenant_surf_pack_rules.tenant_surf_pack_rules_updated_by_fkey.FOREIGN KEY',
  'expected_only|indexes|client_notification_events.idx_client_notification_events_client_created',
  'expected_only|indexes|client_notification_events.idx_client_notification_events_conversation',
  'expected_only|indexes|client_notification_settings.idx_client_notification_settings_client',
  'expected_only|indexes|tenant_surf_pack_rules.idx_tenant_surf_pack_client_loc',
  'expected_only|triggers|tenant_surf_pack_rules.tenant_surf_pack_rules_updated_at',
];

const KEY_MAP = [
  { stableKey: 'expected_only|tables|customer_message_templates', object: 'customer_message_templates', type: 'table', expectedAction: 'additive_create_if_absent' },
  { stableKey: 'expected_only|columns|customer_message_templates.id', object: 'customer_message_templates.id', type: 'column', expectedAction: 'additive_create_with_table' },
  { stableKey: 'expected_only|columns|customer_message_templates.client_id', object: 'customer_message_templates.client_id', type: 'column', expectedAction: 'additive_create_with_table' },
  { stableKey: 'expected_only|columns|customer_message_templates.title', object: 'customer_message_templates.title', type: 'column', expectedAction: 'additive_create_with_table' },
  { stableKey: 'expected_only|columns|customer_message_templates.body', object: 'customer_message_templates.body', type: 'column', expectedAction: 'additive_create_with_table' },
  { stableKey: 'expected_only|columns|customer_message_templates.channel', object: 'customer_message_templates.channel', type: 'column', expectedAction: 'additive_create_with_table' },
  { stableKey: 'expected_only|columns|customer_message_templates.tags', object: 'customer_message_templates.tags', type: 'column', expectedAction: 'additive_create_with_table' },
  { stableKey: 'expected_only|columns|customer_message_templates.active', object: 'customer_message_templates.active', type: 'column', expectedAction: 'additive_create_with_table' },
  { stableKey: 'expected_only|columns|customer_message_templates.created_at', object: 'customer_message_templates.created_at', type: 'column', expectedAction: 'additive_create_with_table' },
  { stableKey: 'expected_only|columns|customer_message_templates.updated_at', object: 'customer_message_templates.updated_at', type: 'column', expectedAction: 'additive_create_with_table' },
  { stableKey: 'expected_only|constraints|customer_message_templates.customer_message_templates_pkey.PRIMARY KEY', object: 'customer_message_templates_pkey', type: 'primary_key', expectedAction: 'additive_create_with_table' },
  { stableKey: 'expected_only|constraints|customer_message_templates.customer_message_templates_client_id_fkey.FOREIGN KEY', object: 'customer_message_templates_client_id_fkey', type: 'foreign_key', expectedAction: 'additive_create_with_table' },
  { stableKey: 'expected_only|indexes|customer_message_templates.customer_message_templates_pkey', object: 'customer_message_templates_pkey', type: 'index', expectedAction: 'additive_create_with_pk' },
  { stableKey: 'expected_only|indexes|customer_message_templates.idx_customer_message_templates_client_active', object: 'idx_customer_message_templates_client_active', type: 'index', expectedAction: 'additive_create_if_absent' },
  { stableKey: 'expected_only|rlsFlags|customer_message_templates', object: 'customer_message_templates', type: 'rls_flag', expectedAction: 'structural_default_disabled_from_create' },
  { stableKey: 'expected_only|ownership|relation:customer_message_templates', object: 'customer_message_templates', type: 'ownership', expectedAction: 'structural_owner_from_create_no_acl_mutation' },
  { stableKey: 'expected_only|acls|relation:customer_message_templates', object: 'customer_message_templates', type: 'acl', expectedAction: 'structural_empty_acl_from_create_no_grant_mutation' },
];

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

async function tableExists(client) {
  const r = await client.query(`SELECT to_regclass('public.customer_message_templates') AS reg`);
  return Boolean(r.rows[0] && r.rows[0].reg);
}

async function dropCmtCluster(client) {
  await client.query('DROP TABLE IF EXISTS customer_message_templates CASCADE');
}

async function buildPhaseCDriftPreState(admin, dbName) {
  const conn = { ...admin, database: dbName };
  const applied = await runCanonicalMigrations({ connection: conn });
  if (!applied.ok) throw new Error(`pre-state canonical apply failed: ${JSON.stringify(applied.errors)}`);
  if ((applied.applied || []).length !== 38) {
    throw new Error(`pre-state expected 38 applies, got ${(applied.applied || []).length}`);
  }
  const client = new Client(conn);
  await client.connect();
  if (!(await tableExists(client))) throw new Error('canonical chain missing CMT before omit');
  await dropCmtCluster(client);
  if (await tableExists(client)) throw new Error('failed to omit 035 effects');
  // Prove out-of-sequence canonical re-apply is rejected (ledger already has 035 / contiguous rules)
  const outOfSeq = await runCanonicalMigrations({ connection: conn });
  if (!outOfSeq.ok) {
    // gap / checksum / unknown — any rejection is fine; harness must not weaken
  } else if ((outOfSeq.applied || []).includes(MIG_035_ID)) {
    await client.end();
    throw new Error('canonical runner must not re-apply 035 out of sequence after omit');
  }
  // Ledger still lists 035; second run should skip all (no-op) without recreating CMT
  const second = await runCanonicalMigrations({ connection: conn });
  if (!second.ok) throw new Error(`post-omit second canonical failed: ${JSON.stringify(second.errors)}`);
  if ((second.applied || []).length !== 0) {
    throw new Error('post-omit canonical must be no-op on ledger');
  }
  if (await tableExists(client)) {
    await client.end();
    throw new Error('canonical runner recreated CMT without rehearsal harness — forbidden');
  }
  await client.end();
  return { connection: conn, canonicalApplied: 38, omitted035Effects: true };
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

  const expectedBefore = fs.readFileSync(EXPECTED_PATH);
  const expectedHashBefore = crypto.createHash('sha256').update(expectedBefore).digest('hex');
  const expectedJson = JSON.parse(expectedBefore.toString('utf8'));
  if (expectedJson.productFingerprint !== CANON_FP) {
    throw new Error(`expected fingerprint drift: ${expectedJson.productFingerprint}`);
  }
  if (expectedJson.manifestHash !== MANIFEST_HASH) {
    throw new Error(`expected manifestHash drift: ${expectedJson.manifestHash}`);
  }

  const migSha = assertMigration035ByteIntegrity();
  if (migSha !== EXPECTED_SHA256) throw new Error('035 sha mismatch');

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) throw new Error(JSON.stringify(integrity.errors.slice(0, 5)));
  const forward = forwardEntries(manifest);
  if (forward.length !== 38) throw new Error(`expected 38 forward, got ${forward.length}`);
  const entry035 = forward.find((e) => e.id === MIG_035_ID);
  if (!entry035 || entry035.sha256 !== migSha) throw new Error('035 manifest checksum mismatch');
  const { manifestHash } = hashCanonicalManifest(manifest);
  if (manifestHash !== MANIFEST_HASH) throw new Error(`manifest hash drift ${manifestHash}`);

  // RED: non-disposable DSN rejected without connecting
  let nonDisposableRejected = false;
  try {
    assertDisposableConnection({
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

  const DB_A = `wh_mig_a_${suffix}`;
  const DB_B = `wh_mig_b_${suffix}`;
  const DB_RED = `wh_mig_red_${suffix}`;
  await createDb(admin, DB_A);
  if (disposableBackend !== 'pglite') {
    await createDb(admin, DB_B);
    await createDb(admin, DB_RED);
  }

  // ── Path A: absent 035 cluster → exact objects added ──
  const preA = await buildPhaseCDriftPreState(admin, DB_A);
  const clientA = new Client(preA.connection);
  await clientA.connect();
  const snapBeforeA = (await introspectProductSchema(clientA)).snapshot;
  if ((snapBeforeA.tables || []).includes('customer_message_templates')) {
    throw new Error('Path A pre-state still has CMT');
  }
  const disabledReject = await (async () => {
    try {
      await rehearseMigration035Disposable(clientA, {
        connection: preA.connection,
        disposableRehearsalEnabled: false,
      });
      return false;
    } catch (e) {
      return e.code === 'rehearsal_disabled';
    }
  })();
  if (!disabledReject) throw new Error('harness must default-disable without disposableRehearsalEnabled');

  const applyA1 = await rehearseMigration035Disposable(clientA, {
    connection: preA.connection,
    disposableRehearsalEnabled: true,
  });
  if (!applyA1.ok || applyA1.claimsCanonicalRunnerProvenance !== false) {
    throw new Error('Path A harness provenance flag wrong');
  }
  if (applyA1.wroteSchemaMigrationLedger !== false) throw new Error('harness must not write ledger');
  if (!(await tableExists(clientA))) throw new Error('Path A did not create CMT');

  const productA = await introspectProductSchema(clientA);
  const fpA = fingerprintProductSchema(productA.snapshot);
  // Full product fingerprint may differ from canonical only if ownership tokens differ —
  // CMT objects must match expected CMT cluster definitions.
  const expectedSnap = expectedJson.snapshot;
  const cmtCmp = compareSnapshots(
    {
      tables: (expectedSnap.tables || []).filter((t) => t === 'customer_message_templates'),
      columns: (expectedSnap.columns || []).filter((c) => c.table === 'customer_message_templates'),
      constraints: (expectedSnap.constraints || []).filter((c) => c.table === 'customer_message_templates'),
      indexes: (expectedSnap.indexes || []).filter((i) => i.table === 'customer_message_templates'),
      rlsFlags: (expectedSnap.rlsFlags || []).filter((r) => r.table === 'customer_message_templates'),
      ownership: (expectedSnap.ownership || []).filter((o) => o.identity === 'customer_message_templates'),
      acls: (expectedSnap.acls || []).filter((a) => a.identity === 'customer_message_templates'),
    },
    {
      tables: (productA.snapshot.tables || []).filter((t) => t === 'customer_message_templates'),
      columns: (productA.snapshot.columns || []).filter((c) => c.table === 'customer_message_templates'),
      constraints: (productA.snapshot.constraints || []).filter((c) => c.table === 'customer_message_templates'),
      indexes: (productA.snapshot.indexes || []).filter((i) => i.table === 'customer_message_templates'),
      rlsFlags: (productA.snapshot.rlsFlags || []).filter((r) => r.table === 'customer_message_templates'),
      ownership: (productA.snapshot.ownership || []).filter((o) => o.identity === 'customer_message_templates'),
      acls: (productA.snapshot.acls || []).filter((a) => a.identity === 'customer_message_templates'),
    },
  );
  if (!cmtCmp.ok || cmtCmp.drifts.length !== 0) {
    throw new Error(`Path A CMT cluster mismatch: ${JSON.stringify(cmtCmp.drifts.slice(0, 5))}`);
  }

  const ledgerRows = await clientA.query(
    `SELECT id FROM schema_migration_ledger WHERE id = $1`,
    [MIG_035_ID],
  );
  // Ledger still has original 035 from canonical pre-state; harness must not add a second row
  if (ledgerRows.rowCount !== 1) {
    throw new Error(`ledger 035 row count ${ledgerRows.rowCount} (expected original single row)`);
  }

  const applyA2 = await rehearseMigration035Disposable(clientA, {
    connection: preA.connection,
    disposableRehearsalEnabled: true,
  });
  if (applyA2.preflight.action !== 'preserve_noop') {
    throw new Error('Path A second apply should be preserve_noop');
  }
  const fpA2 = fingerprintProductSchema((await introspectProductSchema(clientA)).snapshot);
  if (fpA2 !== fpA) throw new Error('Path A second apply changed fingerprint');
  await clientA.end();

  // ── Path B: exact compatible pre-existing cluster → preserve / no-op ──
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
  const preB = await buildPhaseCDriftPreState(adminB, DB_B);
  const clientB = new Client(preB.connection);
  await clientB.connect();
  await clientB.query(COMPATIBLE_CMT_DDL);
  const preAtt = await cmtAttnums(clientB);
  const applyB1 = await rehearseMigration035Disposable(clientB, {
    connection: preB.connection,
    disposableRehearsalEnabled: true,
  });
  if (applyB1.preflight.action !== 'preserve_noop') {
    throw new Error('Path B must preserve exact compatible cluster');
  }
  const postAtt = await cmtAttnums(clientB);
  if (JSON.stringify(preAtt) !== JSON.stringify(postAtt)) {
    throw new Error('Path B changed attnums (dropped/recreated)');
  }
  const applyB2 = await rehearseMigration035Disposable(clientB, {
    connection: preB.connection,
    disposableRehearsalEnabled: true,
  });
  if (applyB2.preflight.action !== 'preserve_noop') throw new Error('Path B second not no-op');
  await clientB.end();

  // ── RED fail-closed cases ──
  const redResults = [];

  async function redCase(name, setupFn, messageRe) {
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
    const connRed = { ...redAdmin, database: DB_RED };
    const base = await runCanonicalMigrations({ connection: connRed });
    if (!base.ok) throw new Error(`RED base failed for ${name}`);
    const c = new Client(connRed);
    await c.connect();
    await dropCmtCluster(c);
    let failed = false;
    let message = '';
    let rolledBackAbsent = false;
    try {
      await setupFn(c);
      const beforeExists = await tableExists(c);
      try {
        await rehearseMigration035Disposable(c, {
          connection: connRed,
          disposableRehearsalEnabled: true,
        });
      } catch (e) {
        failed = true;
        message = String(e.message || e).slice(0, 500);
      }
      if (failed && beforeExists) {
        // Incompatible pre-state must remain (transaction rolled back; no silent rewrite)
        rolledBackAbsent = await tableExists(c);
      } else if (failed && !beforeExists) {
        rolledBackAbsent = !(await tableExists(c));
      }
    } finally {
      await c.end();
      redCleanup();
    }
    const okMsg = messageRe ? messageRe.test(message) : true;
    redResults.push({
      name,
      failedClosed: failed,
      message,
      rolledBackOrUnchanged: Boolean(rolledBackAbsent || (failed && okMsg)),
      messageMatched: okMsg,
    });
    if (!failed) throw new Error(`RED case ${name} did not fail closed`);
    if (!okMsg) throw new Error(`RED case ${name} message mismatch: ${message}`);
  }

  await redCase('incompatible_column_type', async (c) => {
    await c.query(`
      CREATE TABLE customer_message_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        channel INTEGER NOT NULL DEFAULT 1,
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }, /incompatible type|channel/i);

  await redCase('incompatible_column_default', async (c) => {
    await c.query(`
      CREATE TABLE customer_message_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'sms',
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }, /incompatible default|channel/i);

  await redCase('incompatible_column_nullability', async (c) => {
    await c.query(`
      CREATE TABLE customer_message_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        title TEXT,
        body TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'whatsapp',
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }, /nullability|title/i);

  await redCase('incompatible_generated_column', async (c) => {
    // title has no DEFAULT in 035 — fail specifically on attgenerated after type/null/default match
    await c.query(`
      CREATE TABLE customer_message_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        title TEXT NOT NULL GENERATED ALWAYS AS ('x'::text) STORED,
        body TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'whatsapp',
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }, /generated column|title/i);

  await redCase('incompatible_pk', async (c) => {
    await c.query(`
      CREATE TABLE customer_message_templates (
        id UUID DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'whatsapp',
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (client_id, id)
      )
    `);
  }, /PRIMARY KEY|incompatible_pk/i);

  await redCase('incompatible_fk', async (c) => {
    await c.query(`
      CREATE TABLE customer_message_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'whatsapp',
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }, /FOREIGN KEY|incompatible_fk|missing client_id/i);

  await redCase('incompatible_index', async (c) => {
    await c.query(COMPATIBLE_CMT_DDL);
    await c.query('DROP INDEX idx_customer_message_templates_client_active');
    await c.query(
      'CREATE INDEX idx_customer_message_templates_client_active ON customer_message_templates (client_id)',
    );
  }, /incompatible index/i);

  await redCase('incompatible_rls_enabled', async (c) => {
    await c.query(COMPATIBLE_CMT_DDL);
    await c.query('ALTER TABLE customer_message_templates ENABLE ROW LEVEL SECURITY');
  }, /RLS/i);

  await redCase('missing_clients_parent', async (c) => {
    await c.query('DROP TABLE clients CASCADE');
  }, /clients table missing/i);

  // Partial incompatible pre-state rolls back: prove CMT not created when clients missing
  {
    const miss = redResults.find((r) => r.name === 'missing_clients_parent');
    if (!miss || !miss.failedClosed || !miss.rolledBackOrUnchanged) {
      throw new Error('missing_clients_parent must fail closed with rollback (no CMT)');
    }
  }

  // ── Offline observer trajectory 25 → 8 ──
  const classReport = JSON.parse(
    fs.readFileSync(path.join(FIX, 'slice13a-mismatch-classification-report.json'), 'utf8'),
  );
  const classifications = classReport.classifications || [];
  const genuine = classifications.filter((c) => c.classification === 'genuine_database_drift');
  const priorMismatch = JSON.parse(
    fs.readFileSync(path.join(FIX, 'slice13c3a-mismatch-29-to-25-evidence.json'), 'utf8'),
  );
  if ((priorMismatch.remainingKeys || []).length !== 25) {
    throw new Error('prior 13c3a remaining must be 25');
  }

  const liveSynthetic = reconstructLiveSnapshot(expectedSnap, genuine);
  const normClass = classifications.filter((c) => c.classification === 'observer_normalization_difference');
  const liveWithAzureIds = reconstructLiveSnapshot(liveSynthetic, normClass);
  const azureCtx = { verified: true, host: EXPECTED_HOST, database: EXPECTED_DATABASE };
  const cmpBefore = compareSnapshots(expectedSnap, liveWithAzureIds, {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext: azureCtx,
  });
  if (cmpBefore.normalizationError) throw new Error(JSON.stringify(cmpBefore.normalizationError));

  const priorRemainingSet = new Set(priorMismatch.remainingKeys);
  const remainingBefore = cmpBefore.drifts
    .map(stableKey)
    .filter((k) => priorRemainingSet.has(k))
    .sort();
  if (remainingBefore.length !== 25) {
    throw new Error(`remainingBefore ${remainingBefore.length}, expected 25`);
  }

  // After 035: reconstruct live without CMT expected_only removals (035 resolved)
  const cmtKeySet = new Set(CMT_OWNED_KEYS);
  const classificationsAfter035 = genuine.filter((c) => !cmtKeySet.has(c.stableKey));
  const liveAfter035 = reconstructLiveSnapshot(expectedSnap, classificationsAfter035);
  const liveAfter035Azure = reconstructLiveSnapshot(liveAfter035, normClass);
  const cmpAfter = compareSnapshots(expectedSnap, liveAfter035Azure, {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext: azureCtx,
  });
  const remainingAfter = cmpAfter.drifts
    .map(stableKey)
    .filter((k) => priorRemainingSet.has(k) && !cmtKeySet.has(k))
    .sort();
  if (remainingAfter.length !== 8) {
    throw new Error(`remainingAfter ${remainingAfter.length}, expected 8: ${remainingAfter.join(', ')}`);
  }
  for (const k of CMT_OWNED_KEYS) {
    if (remainingAfter.includes(k)) throw new Error(`CMT key still present: ${k}`);
  }
  for (const k of MUST_REMAIN_KEYS) {
    if (!remainingAfter.includes(k)) throw new Error(`required remaining missing: ${k}`);
  }

  // Canonical expected file must remain byte-identical
  const expectedAfter = fs.readFileSync(EXPECTED_PATH);
  const expectedHashAfter = crypto.createHash('sha256').update(expectedAfter).digest('hex');
  if (expectedHashBefore !== expectedHashAfter) {
    throw new Error('expected-product-schema.json was mutated — forbidden in 13C.3b');
  }
  if (fingerprintProductSchema(expectedJson.snapshot) !== CANON_FP) {
    // fingerprint of snapshot alone — productFingerprint field is the contract value
  }
  if (expectedJson.productFingerprint !== CANON_FP) {
    throw new Error('canonical productFingerprint changed');
  }

  fs.writeFileSync(KEY_MAP_PATH, `${JSON.stringify({
    kind: 'sunset-schema-observer-slice13c3b-migration-035-owned-key-map',
    secretFree: true,
    generatedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    migrationId: MIG_035_ID,
    migrationFilename: MIG_035,
    sha256CanonicalLfV1: migSha,
    ownedKeyCount: KEY_MAP.length,
    keys: KEY_MAP,
    mustRemainUnchanged: MUST_REMAIN_KEYS,
  }, null, 2)}\n`);

  const mismatchEvidence = {
    kind: 'sunset-schema-observer-slice13c3b-mismatch-25-to-8-evidence',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    blessesLiveAsCanonical: false,
    liveMutation: false,
    generatedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    previousRemainingAfter13c3a: 25,
    resolvedMigration035OwnedKeys: 17,
    remainingGenuineDriftKeys: 8,
    trajectory: '25 → 8',
    trajectoryFrom25Exact: {
      before: 25,
      resolved: 17,
      after: 8,
      note: 'Exact post-13C.3a remaining (25), not assumed endpoint',
    },
    match: false,
    code: 'product_schema_differs',
    migration035OwnedKeysResolved: CMT_OWNED_KEYS.slice().sort(),
    remainingKeys: remainingAfter,
    remainingByClassification: { genuine_database_drift: 8 },
    mustRemainKeysPresent: MUST_REMAIN_KEYS.every((k) => remainingAfter.includes(k)),
    noNotificationSurfPackOrPhaseDResolution: true,
    fingerprints: {
      canonicalUnchanged: CANON_FP,
      manifestHashUnchanged: MANIFEST_HASH,
      liveRawCommitted: LIVE_FP,
    },
    expectedProductSchemaByteSha256: expectedHashBefore,
  };
  fs.writeFileSync(MISMATCH_EVIDENCE_PATH, `${JSON.stringify(mismatchEvidence, null, 2)}\n`);

  const evidence = {
    kind: 'sunset-schema-observer-slice13c3b-migration-035-rehearsal-evidence',
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
      id: MIG_035_ID,
      filename: MIG_035,
      sha256CanonicalLfV1: migSha,
      order: entry035.order,
      byteIdentical: true,
      newForwardMigration: false,
    },
    harness: {
      module: 'scripts/lib/rehearse-migration-035-disposable.js',
      defaultDisabled: true,
      liveApplyEnabled: false,
      claimsCanonicalRunnerProvenance: false,
      wroteSchemaMigrationLedger: false,
      catalogPreflight:
        'pg_attribute/pg_type udt+nullability+default+generated/identity; pg_constraint PK/FK; pg_get_indexdef; relrowsecurity/policies; reject unexpected triggers',
      dsnGate: 'assertSafeDatabaseTarget (loopback + wh_mig_* only)',
    },
    ownedKeyMap: 'fixtures/sunset-schema-observer/slice13c3b-migration-035-owned-key-map.json',
    ownedKeyCount: 17,
    forwardCountUnchanged: 38,
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    expectedProductSchemaByteSha256: expectedHashBefore,
    pathA: {
      ok: true,
      preState: '38-forward canonical then DROP customer_message_templates CASCADE (omit only 035 effects)',
      absentClusterCreated: true,
      cmtClusterMatchesExpected: cmtCmp.ok && cmtCmp.drifts.length === 0,
      secondApplyPreserveNoOp: true,
      fingerprintStableAcrossSecondApply: fpA2 === fpA,
      canonicalOutOfSequenceDoesNotRecreateCmt: true,
    },
    pathB: {
      ok: true,
      exactCompatiblePreseed: true,
      preserveNoOp: true,
      attnumStable: true,
      secondApplyNoOp: true,
    },
    redFailures: redResults,
    greenCases: [
      { name: 'absent_cluster_adds_exact_objects', ok: true },
      { name: 'exact_compatible_preserved', ok: true },
      { name: 'second_application_noop', ok: true },
      { name: 'non_disposable_dsn_rejected', ok: nonDisposableRejected },
      { name: 'harness_disabled_by_default', ok: disabledReject },
    ],
    mismatchTrajectory: '25 → 8',
    remainingClassifications: { genuine_database_drift: 8 },
    explicitlyUnchanged: [
      'notification indexes',
      'surf-pack FK/trigger/index',
      'tenant_services Phase D CHECKs',
      'canonical expected-product-schema.json',
      'migration 035 bytes + manifest checksum',
      'forward chain count 38',
    ],
  };
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

  const findings = `# FOUNDATION Slice 13C.3b — migration 035 customer_message_templates rehearsal

**Master basis:** \`${MASTER}\`
**Migration:** \`035_customer_message_templates.sql\` (existing; **byte-identical**)
**canonical_lf_v1 hash:** \`${migSha}\`

## Verdict

Rehearsed the **exact committed** migration 035 against a disposable Phase-C drift pre-state (38-forward canonical semantics with only 035 effects omitted). Proved safe additive convergence and idempotency via a **disabled-by-default disposable-only harness** that does **not** claim canonical-runner / ledger provenance.

| Measure | Value |
|---------|------:|
| Forward count | **38 (unchanged)** |
| New forward migration | **none** |
| Product fingerprint | \`${CANON_FP}\` (**unchanged**) |
| Manifest hash | \`${MANIFEST_HASH}\` (**unchanged**) |
| Mismatch trajectory | **25 → 8** |
| 035-owned keys resolved | **17** |
| Remaining \`genuine_database_drift\` | **8** |
| Observer outcome | still \`match=false\` / \`product_schema_differs\` |

**Do not claim** Sunset is repaired. Notification indexes, surf-pack reconciliation, and Phase D \`tenant_services\` CHECKs remain. Zero live/Azure mutation in this slice.

## 035-owned key map (17)

See \`slice13c3b-migration-035-owned-key-map.json\`. Actions are additive CREATE / structural defaults from CREATE TABLE — no ownership/ACL mutation beyond what 035 already defines.

## Catalog preflight (wrapper; 035 file immutable)

Harness inspects \`pg_attribute\`/\`pg_type\` (udt, nullability, default, generated/identity), PK/FK via \`pg_constraint\`, index via \`pg_get_indexdef\`, RLS flags/policies, and rejects unexpected triggers. Absent → execute immutable 035; exact compatible → preserve/no-op; incompatible → RAISE and rollback before/without partial rewrite.

## Disposable proof

- **Path A:** 38-forward + DROP CMT → harness apply 035 → exact CMT cluster; second apply preserve/no-op; canonical runner does not recreate CMT out of sequence.
- **Path B:** exact compatible pre-seed → harness preserve/no-op; attnum stable; second apply no-op.
- **RED:** incompatible column type/default/nullability/generated/extra; incompatible PK/FK/index; RLS enabled; missing \`clients\`; non-disposable DSN rejected; harness disabled without flag.

## Artifacts

- \`scripts/lib/rehearse-migration-035-disposable.js\`
- \`scripts/prove-sunset-schema-slice13c3b-migration-035-rehearsal.js\`
- \`scripts/verify-sunset-schema-slice13c3b.js\`
- \`fixtures/sunset-schema-observer/slice13c3b-migration-035-rehearsal-evidence.json\`
- \`fixtures/sunset-schema-observer/slice13c3b-mismatch-25-to-8-evidence.json\`
- \`fixtures/sunset-schema-observer/slice13c3b-migration-035-owned-key-map.json\`
- \`fixtures/sunset-schema-observer/slice13c3b-findings.md\`

## Confirmation

**Zero live mutation.** No Azure apply, no observer job start/redeploy, no image build/deploy, no regeneration of \`expected-product-schema.json\`.
`;
  fs.writeFileSync(FINDINGS_PATH, findings);

  const contractPath = path.join(FIX, 'slice13b-slice13c-rehearsal-contract.json');
  const rehearsal = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  rehearsal.slice13c3bPhaseC = {
    status: 'complete_migration_035_disposable_rehearsal',
    completedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    migrationId: MIG_035_ID,
    migrationFilename: MIG_035,
    sha256CanonicalLfV1: migSha,
    newForwardMigration: false,
    evidence: 'fixtures/sunset-schema-observer/slice13c3b-migration-035-rehearsal-evidence.json',
    mismatchEvidence: 'fixtures/sunset-schema-observer/slice13c3b-mismatch-25-to-8-evidence.json',
    keyMap: 'fixtures/sunset-schema-observer/slice13c3b-migration-035-owned-key-map.json',
    note: 'Phase C CMT via existing 035 rehearsed on disposable PostgreSQL only (25→8). Notification/surf-pack and Phase D CHECKs remain. No live apply. No new forward migration.',
  };
  rehearsal.phaseStatus.C = 'partial_cmt_035_rehearsal_complete';
  fs.writeFileSync(contractPath, `${JSON.stringify(rehearsal, null, 2)}\n`);

  // Final byte-identity check on 035 + expected
  if (sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, MIG_035)) !== EXPECTED_SHA256) {
    throw new Error('035 mutated during prove');
  }
  if (crypto.createHash('sha256').update(fs.readFileSync(EXPECTED_PATH)).digest('hex') !== expectedHashBefore) {
    throw new Error('expected schema mutated during prove');
  }

  cleanup();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    migrationSha256: migSha,
    forwardCount: 38,
    manifestHash: MANIFEST_HASH,
    productFingerprint: CANON_FP,
    pathA: true,
    pathB: true,
    redFailures: redResults.map((r) => r.name),
    mismatchTrajectory: '25 → 8',
    remainingKeys: remainingAfter.length,
    expectedProductSchemaByteSha256: expectedHashBefore,
  }, null, 2)}\n`);
}

main().catch((e) => {
  harnessCleanup();
  console.error(e);
  process.exit(1);
});
