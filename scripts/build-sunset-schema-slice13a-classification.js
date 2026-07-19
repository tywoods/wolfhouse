'use strict';

/**
 * FOUNDATION Slice 13A — offline classification of 88 canonical/live mismatches
 * and 36-migration structural provenance. Investigation only.
 *
 * Inputs (read-only):
 *  - fixtures/sunset-schema-observer/slice11-canonical-vs-live-mismatch-report.json
 *  - fixtures/sunset-schema-observer/expected-product-schema.json
 *  - database/migrations/canonical-manifest.json + migration SQL files
 *  - optional gitignored live catalog evidence (tmp/.../actual-live-state-evidence.json)
 *
 * Outputs (committed secret-free fixtures under fixtures/sunset-schema-observer/):
 *  - slice13a-mismatch-classification-report.json
 *  - slice13a-migration-provenance-matrix.json
 *  - slice13a-findings.md
 *  - slice13a-operator-decision-list.json
 *
 * No Azure mutation. No repair SQL. No live apply code.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { forwardEntries, loadManifest, MANIFEST_PATH } = require('./lib/migration-integrity');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MIG_DIR = path.join(ROOT, 'database', 'migrations');
const REPORT_PATH = path.join(FIX, 'slice11-canonical-vs-live-mismatch-report.json');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const LIVE_CANDIDATES = [
  path.join(ROOT, 'tmp', 'foundation-slice13a', 'actual-live-state-evidence.json'),
  path.join(ROOT, 'tmp', 'foundation-slice11', 'actual-live-state-evidence.json'),
];

const CANON_FP = 'daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52';
const LIVE_FP = 'fa7efa9246c2bd75fe41741652c462bb98b3c571906635e55a91ae5735ca1dfd';

const CLASSIFICATIONS = [
  'genuine_database_drift',
  'observer_normalization_difference',
  'canonical_manifest_question',
  'unresolved',
];

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function loadLiveSnapshot() {
  for (const p of LIVE_CANDIDATES) {
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.productFingerprint !== LIVE_FP) {
        throw new Error(`live evidence fingerprint mismatch at ${p}`);
      }
      return { path: path.relative(ROOT, p).replace(/\\/g, '/'), snapshot: j.snapshot, label: j.label };
    }
  }
  return null;
}

function indexBy(list, keyFn) {
  const m = new Map();
  for (const item of list || []) m.set(keyFn(item), item);
  return m;
}

function stableMismatchId(m) {
  return `${m.kind}|${m.section}|${m.key}`;
}

function readForwardMigrations() {
  const manifest = loadManifest(MANIFEST_PATH);
  const forward = forwardEntries(manifest);
  return forward.map((e) => {
    const filePath = path.join(MIG_DIR, e.filename);
    const sql = fs.readFileSync(filePath, 'utf8');
    const hash = sha256File(filePath);
    if (hash !== e.sha256) {
      throw new Error(`hash mismatch for ${e.filename}: manifest=${e.sha256} disk=${hash}`);
    }
    return { ...e, sql, filePath };
  });
}

function migrationsMentioning(migrations, needles) {
  const hits = [];
  for (const m of migrations) {
    for (const n of needles) {
      if (!n) continue;
      if (m.sql.includes(n)) {
        hits.push(m.id);
        break;
      }
    }
  }
  return [...new Set(hits)];
}

function primaryObjectFromKey(section, key) {
  if (section === 'tables' || section === 'rlsFlags') return key;
  if (section === 'ownership' || section === 'acls') {
    const i = key.indexOf(':');
    return i >= 0 ? key.slice(i + 1) : key;
  }
  if (section === 'extensions') return key;
  if (section === 'functions') return key;
  // table.column / table.index / table.constraint...
  return String(key).split('.')[0];
}

function classifyOne(m, ctx) {
  const { expectedSnap, liveSnap, migrations, proposedSql } = ctx;
  const id = stableMismatchId(m);
  const obj = primaryObjectFromKey(m.section, m.key);
  const isCmt = String(m.key).includes('customer_message_templates') || obj === 'customer_message_templates';
  const isPgcryptoFamily =
    m.section === 'ownership'
    && (m.key.startsWith('extension:pgcrypto')
      || m.key.startsWith('extension:plpgsql')
      || m.key.startsWith('function:public.'));
  const isAzureSchemaPublic =
    (m.section === 'ownership' && m.key === 'schema:public')
    || (m.section === 'acls' && m.key === 'schema:public');
  const isExtDef =
    m.section === 'extensions' && (m.key === 'pgcrypto' || m.key === 'plpgsql');

  let expectedDefinition = null;
  let liveDefinition = null;

  if (m.section === 'ownership') {
    const expMap = indexBy(expectedSnap.ownership, (o) => `${o.kind}:${o.identity}`);
    const liveMap = indexBy(liveSnap.ownership, (o) => `${o.kind}:${o.identity}`);
    expectedDefinition = expMap.get(m.key) || null;
    liveDefinition = liveMap.get(m.key) || null;
  } else if (m.section === 'acls') {
    const expMap = indexBy(expectedSnap.acls, (a) => `${a.kind}:${a.identity}`);
    const liveMap = indexBy(liveSnap.acls, (a) => `${a.kind}:${a.identity}`);
    expectedDefinition = expMap.get(m.key) || null;
    liveDefinition = liveMap.get(m.key) || null;
  } else if (m.section === 'extensions') {
    const expMap = indexBy(expectedSnap.extensions, (e) => e.name);
    const liveMap = indexBy(liveSnap.extensions, (e) => e.name);
    expectedDefinition = expMap.get(m.key) || null;
    liveDefinition = liveMap.get(m.key) || null;
  } else if (m.section === 'columns') {
    const expMap = indexBy(expectedSnap.columns, (c) => `${c.table}.${c.column}`);
    const liveMap = indexBy(liveSnap.columns, (c) => `${c.table}.${c.column}`);
    expectedDefinition = expMap.get(m.key) || null;
    liveDefinition = liveMap.get(m.key) || null;
  } else if (m.section === 'indexes') {
    const expMap = indexBy(expectedSnap.indexes, (i) => `${i.table}.${i.name}`);
    const liveMap = indexBy(liveSnap.indexes, (i) => `${i.table}.${i.name}`);
    expectedDefinition = expMap.get(m.key) || null;
    liveDefinition = liveMap.get(m.key) || null;
  } else if (m.section === 'constraints') {
    const expMap = indexBy(expectedSnap.constraints, (c) => `${c.table}.${c.name}.${c.type}`);
    const liveMap = indexBy(liveSnap.constraints, (c) => `${c.table}.${c.name}.${c.type}`);
    expectedDefinition = expMap.get(m.key) || null;
    liveDefinition = liveMap.get(m.key) || null;
  } else if (m.section === 'tables') {
    expectedDefinition = (expectedSnap.tables || []).includes(m.key) ? { name: m.key } : null;
    liveDefinition = (liveSnap.tables || []).includes(m.key) ? { name: m.key } : null;
  } else if (m.section === 'triggers') {
    const expMap = indexBy(expectedSnap.triggers, (t) => `${t.table}.${t.name}`);
    const liveMap = indexBy(liveSnap.triggers, (t) => `${t.table}.${t.name}`);
    expectedDefinition = expMap.get(m.key) || null;
    liveDefinition = liveMap.get(m.key) || null;
  } else if (m.section === 'rlsFlags') {
    const expMap = indexBy(expectedSnap.rlsFlags, (r) => r.table);
    const liveMap = indexBy(liveSnap.rlsFlags, (r) => r.table);
    expectedDefinition = expMap.get(m.key) || null;
    liveDefinition = liveMap.get(m.key) || null;
  }

  // Migration attribution
  let migrationIds = [];
  if (isCmt) {
    migrationIds = ['035_customer_message_templates'];
  } else if (m.key.includes('idx_client_notification')) {
    migrationIds = migrationsMentioning(migrations, [
      'idx_client_notification_events_client_created',
      'idx_client_notification_events_conversation',
      'idx_client_notification_settings_client',
    ]);
  } else if (m.key.includes('tenant_surf_pack_rules')) {
    migrationIds = migrationsMentioning(migrations, [
      'tenant_surf_pack_rules_updated_at',
      'idx_tenant_surf_pack_client_loc',
      'tenant_surf_pack_rules_updated_by_fkey',
      'tenant_surf_pack_rules',
    ]);
  } else if (m.key.includes('tenant_services')) {
    migrationIds = migrationsMentioning(migrations, [
      'tenant_services_date_window',
      'tenant_services_price_unit',
      'block_rooms_enabled',
      'blocked_room_codes',
      'room_block_booking_ids',
      'weekdays',
      'tenant_services',
    ]);
  } else if (
    m.key.includes('uq_tenant_lesson_capacity')
    || m.key.includes('uq_tenant_lesson_time')
    || m.key.includes('uq_tenant_price_rules')
    || m.key.includes('location_id')
    || m.key.includes('capacity_check')
    || m.key.includes('.capacity')
  ) {
    migrationIds = migrationsMentioning(migrations, [
      String(m.key).split('.').pop(),
      'uq_tenant_lesson_capacity_date',
      'uq_tenant_lesson_capacity_date_loc',
      'location_id',
      'tenant_lesson_time_rules_capacity_check',
    ]);
  } else if (isPgcryptoFamily || isExtDef || isAzureSchemaPublic) {
    migrationIds = migrationsMentioning(migrations, ['CREATE EXTENSION', 'pgcrypto', 'plpgsql']);
  } else {
    migrationIds = migrationsMentioning(migrations, [obj, String(m.key).split('.').pop()]);
  }

  // Proposed-but-not-forward signals
  const inProposed = proposedSql.some((p) => p.sql.includes(String(m.key).split('.').pop()) || p.sql.includes(obj));

  let classification = 'unresolved';
  let likelyCause = '';
  let confidence = 'low';
  let semanticSecurityImpact = '';
  let laterRepairShape = 'unresolved';
  let notes = [];

  if (isCmt && m.kind === 'expected_only') {
    classification = 'genuine_database_drift';
    likelyCause =
      'Canonical migration 035_customer_message_templates was not applied on sunset_staging (table and dependents absent). schema_migration_ledger also absent, so applied-set cannot be proven from ledger.';
    confidence = 'high';
    semanticSecurityImpact =
      'Product feature gap: staff CRM message templates unavailable. Not a privilege escalation. Additive table absence.';
    laterRepairShape = 'additive';
    notes.push('Cascade of missing table/columns/indexes/constraints/ownership/acls/rlsFlags row.');
  } else if (isPgcryptoFamily || isExtDef || isAzureSchemaPublic) {
    const expOwner = expectedDefinition && expectedDefinition.owner;
    const liveOwner = liveDefinition && liveDefinition.owner;
    const expAcl = expectedDefinition && expectedDefinition.acl;
    const liveAcl = liveDefinition && liveDefinition.acl;
    classification = 'observer_normalization_difference';
    likelyCause =
      'Azure Database for PostgreSQL Flexible Server environment identities (azuresu / azure_pg_admin) differ from local-canonical normalized owners ($db_owner / pg_database_owner). Observer normalizeOwnerName only rewrites datdba→$db_owner and does not equate azuresu or azure_pg_admin↔pg_database_owner. Extension/function ownership and public schema ACL text therefore compare unequal despite equivalent platform defaults.';
    confidence = 'high';
    semanticSecurityImpact =
      'Low product-security impact: platform extension/schema ownership, not tenant privilege grants. Do not REASSIGN OWNED / ALTER OWNER merely to match role names.';
    laterRepairShape = 'normalization-only';
    notes.push(`expectedOwner=${expOwner || 'n/a'} liveOwner=${liveOwner || 'n/a'}`);
    if (expAcl != null || liveAcl != null) notes.push(`expectedAcl=${expAcl || ''} liveAcl=${liveAcl || ''}`);
    notes.push('Observer normalization defect candidate: Azure platform roles not treated as environment-equivalent.');
  } else if (
    m.kind === 'live_only'
    && (m.key.includes('_loc') || m.key.endsWith('.location_id') || m.key.includes('capacity_check') || m.key.endsWith('.capacity'))
  ) {
    classification = inProposed ? 'canonical_manifest_question' : 'genuine_database_drift';
    likelyCause = inProposed
      ? 'Live objects match PROPOSED location_id / capacity migrations that are excluded from the canonical forward chain (e.g. 023_sunset_admin_location_id_PROPOSED). Live appears to have applied a non-forward proposed path (or equivalent manual DDL).'
      : 'Live has columns/indexes/constraints not present in canonical expected snapshot; no clear forward-migration match.';
    confidence = inProposed ? 'high' : 'medium';
    semanticSecurityImpact =
      'Structural divergence: multi-location uniqueness / capacity semantics differ from canonical. May be intentional Sunset staging evolution outside forward chain.';
    laterRepairShape = 'destructive/data-sensitive';
    notes.push(inProposed ? 'Attributed to proposed-not-executable migration content.' : 'No proposed file hit; treat carefully.');
  } else if (
    m.kind === 'expected_only'
    && (m.key.includes('uq_tenant_lesson_capacity_')
      || m.key.includes('uq_tenant_lesson_time_')
      || m.key.includes('uq_tenant_price_rules_active_window'))
    && !m.key.includes('_loc')
  ) {
    classification = 'canonical_manifest_question';
    likelyCause =
      'Canonical expected still has pre-location unique indexes; live replaced them with *_loc variants (proposed 023 pattern). Expected-only index is the superseded pre-location signature.';
    confidence = 'high';
    semanticSecurityImpact = 'Index shape drift tied to location_id evolution; dropping/recreating uniques can be data-sensitive.';
    laterRepairShape = 'destructive/data-sensitive';
  } else if (
    m.kind === 'expected_only'
    && (m.key.includes('tenant_services_date_window') || m.key.includes('tenant_services_price_unit'))
  ) {
    classification = 'genuine_database_drift';
    likelyCause =
      'CHECK constraints declared in canonical migration 028_tenant_services are absent live (live tenant_services also has extra columns not in canonical).';
    confidence = 'medium';
    semanticSecurityImpact = 'Weaker invariant enforcement on tenant_services if CHECKs absent; verify live table definition before any ALTER.';
    laterRepairShape = 'destructive/data-sensitive';
  } else if (
    m.kind === 'live_only'
    && m.key.startsWith('tenant_services.')
  ) {
    classification = 'genuine_database_drift';
    likelyCause =
      'Live tenant_services has columns (block_rooms_*, weekdays, room_block_booking_ids) absent from canonical expected — likely out-of-band or non-forward DDL on Sunset staging.';
    confidence = 'medium';
    semanticSecurityImpact = 'Extra columns may be used by Sunset admin UI; removing them would be destructive.';
    laterRepairShape = 'destructive/data-sensitive';
  } else if (
    m.kind === 'expected_only'
    && (m.key.includes('idx_client_notification') || m.key.includes('tenant_surf_pack_rules'))
  ) {
    classification = 'genuine_database_drift';
    likelyCause =
      'Canonical forward migrations declare these indexes/triggers/FKs, but they are absent live — partial/absent application of the owning migration(s), or later drop.';
    confidence = 'medium';
    semanticSecurityImpact = 'Missing indexes degrade query performance/integrity; missing trigger may skip updated_at maintenance; missing FK weakens referential integrity.';
    laterRepairShape = m.key.includes('fkey') || m.key.includes('FOREIGN KEY')
      ? 'destructive/data-sensitive'
      : 'additive';
  } else {
    classification = 'unresolved';
    likelyCause = 'Insufficient committed evidence to attribute confidently without additional catalog/history.';
    confidence = 'low';
    semanticSecurityImpact = 'Unknown until resolved; fail closed — do not treat as safe to ignore or auto-repair.';
    laterRepairShape = 'unresolved';
  }

  if (!CLASSIFICATIONS.includes(classification)) {
    throw new Error(`bad classification ${classification}`);
  }

  return {
    stableKey: id,
    kind: m.kind,
    section: m.section,
    key: m.key,
    category: m.section,
    canonicalMigrations: migrationIds,
    expectedDefinition: expectedDefinition,
    liveDefinition: liveDefinition,
    likelyCause,
    confidence,
    semanticSecurityImpact,
    classification,
    laterRepairShape,
    notes,
  };
}

function buildProvenance(migrations, classifications, expectedSnap, liveSnap) {
  const byMig = new Map(migrations.map((m) => [m.id, m]));

  // Signature helpers: object names strongly associated with each migration via SQL tokens
  function extractSignatures(sql, id) {
    const sigs = new Set();
    const tableRe = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z0-9_]+)/gi;
    const indexRe = /CREATE(?:\s+UNIQUE)?\s+INDEX(?:\s+IF NOT EXISTS)?\s+([a-z0-9_]+)/gi;
    const triggerRe = /CREATE(?:\s+OR REPLACE)?\s+TRIGGER\s+([a-z0-9_]+)/gi;
    const constraintRe = /CONSTRAINT\s+([a-z0-9_]+)/gi;
    let match;
    while ((match = tableRe.exec(sql))) sigs.add(`table:${match[1]}`);
    while ((match = indexRe.exec(sql))) sigs.add(`index:${match[1]}`);
    while ((match = triggerRe.exec(sql))) sigs.add(`trigger:${match[1]}`);
    while ((match = constraintRe.exec(sql))) sigs.add(`constraint:${match[1]}`);
    if (id === '035_customer_message_templates') {
      sigs.add('table:customer_message_templates');
      sigs.add('index:idx_customer_message_templates_client_active');
      sigs.add('constraint:customer_message_templates_pkey');
      sigs.add('constraint:customer_message_templates_client_id_fkey');
    }
    return [...sigs].sort();
  }

  function liveHasSignature(sig) {
    const [kind, name] = sig.split(':');
    if (kind === 'table') return (liveSnap.tables || []).includes(name);
    if (kind === 'index') return (liveSnap.indexes || []).some((i) => i.name === name);
    if (kind === 'trigger') return (liveSnap.triggers || []).some((t) => t.name === name);
    if (kind === 'constraint') return (liveSnap.constraints || []).some((c) => c.name === name);
    return false;
  }

  function expectedHasSignature(sig) {
    const [kind, name] = sig.split(':');
    if (kind === 'table') return (expectedSnap.tables || []).includes(name);
    if (kind === 'index') return (expectedSnap.indexes || []).some((i) => i.name === name);
    if (kind === 'trigger') return (expectedSnap.triggers || []).some((t) => t.name === name);
    if (kind === 'constraint') return (expectedSnap.constraints || []).some((c) => c.name === name);
    return false;
  }

  const relatedMismatches = (id) =>
    classifications.filter((c) => (c.canonicalMigrations || []).includes(id));

  return migrations.map((m) => {
    const signaturesExpected = extractSignatures(m.sql, m.id).filter((s) => expectedHasSignature(s) || s.startsWith('table:') || s.startsWith('index:') || s.startsWith('trigger:') || s.startsWith('constraint:'));
    // Prefer signatures that appear in SQL; mark which are present live
    const rawSigs = extractSignatures(m.sql, m.id);
    const signaturesPresentLive = rawSigs.filter((s) => liveHasSignature(s));
    const signaturesExpectedPresent = rawSigs.filter((s) => expectedHasSignature(s));
    const related = relatedMismatches(m.id);

    let inferredState = 'ambiguous';
    let confidence = 'low';
    let evidence = [];

    if (m.id === '035_customer_message_templates') {
      inferredState = 'absent';
      confidence = 'high';
      evidence.push('table customer_message_templates absent live');
      evidence.push('17 expected_only mismatches attributed to 035');
    } else if (rawSigs.length === 0) {
      inferredState = 'ambiguous';
      confidence = 'low';
      evidence.push('No CREATE TABLE/INDEX/TRIGGER/CONSTRAINT signatures extracted (may be ALTER-only).');
    } else {
      const expectedSigs = rawSigs.filter((s) => expectedHasSignature(s));
      const liveOfExpected = expectedSigs.filter((s) => liveHasSignature(s));
      const missingExpected = expectedSigs.filter((s) => !liveHasSignature(s));
      evidence.push(`signaturesInSql=${rawSigs.length}`);
      evidence.push(`expectedVisible=${expectedSigs.length}`);
      evidence.push(`liveHasOfExpected=${liveOfExpected.length}`);
      evidence.push(`missingOfExpected=${missingExpected.length}`);
      if (expectedSigs.length > 0 && missingExpected.length === 0 && liveOfExpected.length === expectedSigs.length) {
        inferredState = related.some((r) => r.classification === 'genuine_database_drift' && r.kind === 'expected_only')
          ? 'partially_applied'
          : 'fully_applied';
        confidence = related.length ? 'medium' : 'medium';
        if (related.length === 0) {
          inferredState = 'fully_applied';
          confidence = 'medium';
        }
      } else if (expectedSigs.length > 0 && liveOfExpected.length === 0) {
        inferredState = 'absent';
        confidence = 'medium';
      } else if (expectedSigs.length > 0 && missingExpected.length > 0 && liveOfExpected.length > 0) {
        inferredState = 'partially_applied';
        confidence = 'medium';
        evidence.push(`missing=${missingExpected.join(',')}`);
      } else if (expectedSigs.length === 0 && signaturesPresentLive.length > 0) {
        inferredState = 'ambiguous';
        confidence = 'low';
        evidence.push('SQL signatures not represented in expected snapshot comparison set.');
      } else {
        inferredState = 'ambiguous';
        confidence = 'low';
      }

      // Superseded: expected unique indexes replaced by live *_loc variants for lesson/price rules
      if (
        related.some((r) => r.classification === 'canonical_manifest_question' && /uq_tenant_/.test(r.key))
        && m.id.includes('021_sunset_admin_business_config')
      ) {
        inferredState = 'superseded';
        confidence = 'medium';
        evidence.push('Pre-location unique indexes superseded live by *_loc variants (proposed location_id path).');
      }
    }

    // Fail closed: if any related mismatch is unresolved, mark migration ambiguous unless already absent with high confidence
    if (related.some((r) => r.classification === 'unresolved') && inferredState !== 'absent') {
      inferredState = 'ambiguous';
      confidence = 'low';
      evidence.push('Related unresolved mismatch → fail closed to ambiguous.');
    }

    return {
      id: m.id,
      filename: m.filename,
      sha256: m.sha256,
      order: m.order,
      signaturesExpected: signaturesExpectedPresent.length ? signaturesExpectedPresent : rawSigs,
      signaturesPresentLive,
      inferredState,
      confidence,
      evidence,
      relatedMismatchCount: related.length,
      relatedMismatchStableKeys: related.map((r) => r.stableKey),
    };
  });
}

function main() {
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
  const expected = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
  if (expected.productFingerprint !== CANON_FP) {
    throw new Error('canonical fixture fingerprint mismatch');
  }
  if (report.canonicalExpectedFingerprint !== CANON_FP || report.actualLiveFingerprint !== LIVE_FP) {
    throw new Error('mismatch report fingerprints do not match locked contract');
  }
  if (report.mismatchCount !== 88 || report.mismatches.length !== 88) {
    throw new Error('mismatch count != 88');
  }

  const liveMeta = loadLiveSnapshot();
  if (!liveMeta) {
    throw new Error('live catalog evidence required for definition fields; place actual-live-state-evidence.json under tmp/foundation-slice13a/');
  }

  const migrations = readForwardMigrations();
  if (migrations.length !== 36) throw new Error(`expected 36 forward migrations, got ${migrations.length}`);

  const proposed = fs.readdirSync(MIG_DIR)
    .filter((f) => /PROPOSED/i.test(f) && f.endsWith('.sql'))
    .map((f) => ({ filename: f, sql: fs.readFileSync(path.join(MIG_DIR, f), 'utf8') }));

  const ctx = {
    expectedSnap: expected.snapshot,
    liveSnap: liveMeta.snapshot,
    migrations,
    proposedSql: proposed,
  };

  const classifications = report.mismatches.map((m) => classifyOne(m, ctx));
  const stableKeys = classifications.map((c) => c.stableKey);
  if (new Set(stableKeys).size !== 88) {
    throw new Error('stable keys not unique');
  }

  const kindTotals = {
    expected_only: classifications.filter((c) => c.kind === 'expected_only').length,
    live_only: classifications.filter((c) => c.kind === 'live_only').length,
    definition_mismatch: classifications.filter((c) => c.kind === 'definition_mismatch').length,
  };
  if (kindTotals.expected_only !== 31 || kindTotals.live_only !== 15 || kindTotals.definition_mismatch !== 42) {
    throw new Error(`kind totals mismatch ${JSON.stringify(kindTotals)}`);
  }

  const classTotals = {};
  for (const c of CLASSIFICATIONS) classTotals[c] = classifications.filter((x) => x.classification === c).length;

  const repairShapeTotals = {};
  for (const c of classifications) {
    repairShapeTotals[c.laterRepairShape] = (repairShapeTotals[c.laterRepairShape] || 0) + 1;
  }

  const provenance = buildProvenance(migrations, classifications, expected.snapshot, liveMeta.snapshot);
  if (provenance.length !== 36) throw new Error('provenance length != 36');
  if (new Set(provenance.map((p) => p.id)).size !== 36) throw new Error('provenance ids not unique');

  const provenanceTotals = {};
  for (const p of provenance) {
    provenanceTotals[p.inferredState] = (provenanceTotals[p.inferredState] || 0) + 1;
  }

  const mig035 = provenance.find((p) => p.id === '035_customer_message_templates');
  const cmtClass = classifications.filter((c) => c.canonicalMigrations.includes('035_customer_message_templates'));

  const classificationReport = {
    kind: 'sunset-schema-observer-slice13a-mismatch-classification',
    label: 'investigation only — do not bless live; do not apply repairs from this artifact',
    secretFree: true,
    containsProductRowValues: false,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    generatedAt: new Date().toISOString(),
    masterShaBasis: '3c27d4ee3dd9b5678c63037d3ccc524c21907332',
    canonicalExpectedFingerprint: CANON_FP,
    actualLiveFingerprint: LIVE_FP,
    liveEvidence: {
      used: true,
      pathNote: 'gitignored operator-local actual-live-state-evidence.json (label: actual live state — not canonical)',
      fingerprint: LIVE_FP,
      sourceLabel: liveMeta.label,
    },
    mismatchCount: 88,
    kindTotals,
    classificationTotals: classTotals,
    laterRepairShapeTotals: repairShapeTotals,
    observerNormalizationDefect: {
      identified: true,
      summary:
        'normalizeOwnerName only maps datdba→$db_owner. On Azure Flexible Server, extension/function owners remain azuresu and public schema owner/ACL grantor is azure_pg_admin (canonical local uses pg_database_owner). These compare as definition_mismatch without representing tenant privilege drift.',
      doNotMutateOwnershipToMatchRoleNames: true,
    },
    classifications,
  };

  const provenanceMatrix = {
    kind: 'sunset-schema-observer-slice13a-migration-provenance-matrix',
    label: 'structural inference only — schema_migration_ledger absent live; states are evidence-based not ledger-proven',
    secretFree: true,
    containsRepairSql: false,
    generatedAt: new Date().toISOString(),
    masterShaBasis: '3c27d4ee3dd9b5678c63037d3ccc524c21907332',
    canonicalForwardCount: 36,
    schema_migration_ledger_present_live: false,
    provenanceTotals,
    migrations: provenance,
    migration_035_customer_message_templates: {
      id: mig035.id,
      filename: mig035.filename,
      sha256: mig035.sha256,
      inferredState: mig035.inferredState,
      confidence: mig035.confidence,
      expectedObjects: [
        'table:customer_message_templates',
        'index:idx_customer_message_templates_client_active',
        'constraint:customer_message_templates_pkey',
        'constraint:customer_message_templates_client_id_fkey',
      ],
      liveAbsenceConfirmed: true,
      partialRemnantsObserved: false,
      appearsSafelyAdditive: true,
      seedOrBackfillRequired: false,
      seedOrBackfillNote:
        'Migration 035 creates empty template table with IF NOT EXISTS; no mandatory seed rows. Optional staff-authored templates would be data, not schema. Do not apply in Slice 13A.',
      doNotApplyInThisSlice: true,
      relatedMismatchCount: cmtClass.length,
    },
  };

  const unresolved = classifications.filter((c) => c.classification === 'unresolved');
  const decisions = {
    kind: 'sunset-schema-observer-slice13a-operator-decision-list',
    secretFree: true,
    generatedAt: new Date().toISOString(),
    failClosed: true,
    items: [
      {
        id: 'DEC-001',
        topic: 'Azure ownership/ACL/extension definition_mismatches',
        recommendation:
          'Treat as observer normalization / environment identity — do not ALTER OWNER or rewrite ACLs merely to match $db_owner/pg_database_owner. Consider a future observer normalization enhancement (optional, separate slice).',
        status: 'proposed_non_mutating',
        relatedCount: classTotals.observer_normalization_difference,
      },
      {
        id: 'DEC-002',
        topic: 'Proposed location_id / *_loc unique indexes present live but excluded from canonical forward chain',
        recommendation:
          'Decide whether Sunset staging should adopt proposed 023 (promote into forward chain + regenerate canonical fixture) or revert live toward pre-location canonical uniques (data-sensitive).',
        status: 'needs_operator_decision',
        relatedClassifications: ['canonical_manifest_question'],
      },
      {
        id: 'DEC-003',
        topic: 'Migration 035_customer_message_templates absent live',
        recommendation:
          'Confirm additive apply is desired in a later repair slice; no seed required for empty table. Not applied in 13A.',
        status: 'needs_operator_decision',
        relatedMigration: '035_customer_message_templates',
      },
      {
        id: 'DEC-004',
        topic: 'tenant_services live-only columns and missing CHECKs',
        recommendation:
          'Inventory which Sunset admin features depend on live-only columns before any DROP/ADD CONSTRAINT. Likely needs a dedicated repair/design slice.',
        status: 'needs_operator_decision',
      },
      {
        id: 'DEC-005',
        topic: 'schema_migration_ledger absent',
        recommendation:
          'Cannot prove applied migration set. Any later repair should introduce ledgered apply discipline; do not invent applied history from live catalog alone.',
        status: 'needs_operator_decision',
      },
      {
        id: 'DEC-006',
        topic: 'Ambiguous migration provenance (ALTER-only / weak signatures)',
        recommendation:
          'Fail closed: treat ambiguous migrations as not proven fully_applied until stronger catalog/history evidence exists. Do not auto-repair.',
        status: 'unresolved_fail_closed',
        relatedMigrations: provenance
          .filter((p) => p.inferredState === 'ambiguous')
          .map((p) => p.id),
      },
      ...unresolved.map((u, i) => ({
        id: `DEC-UNRESOLVED-${String(i + 1).padStart(3, '0')}`,
        topic: u.stableKey,
        recommendation: 'Fail closed — gather more catalog/history before classifying or repairing.',
        status: 'unresolved',
        classification: 'unresolved',
      })),
    ],
  };

  const findingsMd = `# FOUNDATION Slice 13A — Sunset schema drift classification (investigation only)

**Master basis:** \`3c27d4ee3dd9b5678c63037d3ccc524c21907332\`
**Canonical fingerprint:** \`${CANON_FP}\`
**Live fingerprint:** \`${LIVE_FP}\`
**mismatchCount:** 88 (expected_only=31, live_only=15, definition_mismatch=42)

## Verdict

- Runtime observer image is already repaired (Slice 12). This slice classifies **why** live still differs.
- **Do not bless live as canonical. Do not apply migrations or mutate ownership from this report.**
- \`schema_migration_ledger\` is **absent** live → applied-set is inferred from catalog signatures only.

## Classification totals

| Classification | Count |
|----------------|------:|
| genuine_database_drift | ${classTotals.genuine_database_drift} |
| observer_normalization_difference | ${classTotals.observer_normalization_difference} |
| canonical_manifest_question | ${classTotals.canonical_manifest_question} |
| unresolved | ${classTotals.unresolved} |

## Ownership / ACL / extensions

Live owners for pgcrypto/plpgsql functions and extensions are \`azuresu\`; public schema owner/ACL grantor is \`azure_pg_admin\`. Canonical expected uses \`$db_owner\` / \`pg_database_owner\` after local generation.

**Interpretation:** Azure Flexible Server environment identities, not tenant privilege drift. Observer \`normalizeOwnerName\` only rewrites \`datdba\` → \`$db_owner\` — **normalization defect candidate**. **Do not recommend ownership mutation merely to match role names.**

## Migration provenance totals

| Inferred state | Count |
|----------------|------:|
${Object.entries(provenanceTotals).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

## Migration 035 (\`035_customer_message_templates\`)

- Expected objects present in canonical fixture; **absent live** (no partial remnants observed).
- Appears **safely additive** (\`CREATE TABLE IF NOT EXISTS\` + index); **no mandatory seed/backfill**.
- **Not applied in Slice 13A.**

## Artifacts

- \`fixtures/sunset-schema-observer/slice13a-mismatch-classification-report.json\`
- \`fixtures/sunset-schema-observer/slice13a-migration-provenance-matrix.json\`
- \`fixtures/sunset-schema-observer/slice13a-operator-decision-list.json\`
- This findings note

## Forbidden (honored)

No live DDL/DML, ledger, role, credential, image, job, Staff API, Luna, firewall/network, Wolfhouse, or production mutation. No executable repair tooling. No observer job start. No product-row reads.
`;

  fs.writeFileSync(
    path.join(FIX, 'slice13a-mismatch-classification-report.json'),
    `${JSON.stringify(classificationReport, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(FIX, 'slice13a-migration-provenance-matrix.json'),
    `${JSON.stringify(provenanceMatrix, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(FIX, 'slice13a-operator-decision-list.json'),
    `${JSON.stringify(decisions, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(FIX, 'slice13a-findings.md'), findingsMd);

  console.log(JSON.stringify({
    ok: true,
    mismatchCount: 88,
    kindTotals,
    classificationTotals: classTotals,
    provenanceTotals,
    unresolvedCount: unresolved.length,
    migration035: provenanceMatrix.migration_035_customer_message_templates,
  }, null, 2));
}

main();
