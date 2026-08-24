'use strict';

/**
 * verify:migration-integrity — FOUNDATION Slice 4 + 13A.1
 * RED→GREEN gate for canonical migration manifest + policy helpers.
 * No Azure / staging / production database connections.
 */

const fs = require('fs');
const path = require('path');
const {
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  loadManifest,
  validateManifestIntegrity,
  assertSafeDatabaseTarget,
  forwardEntries,
  prepareMigrationBody,
  CHECKSUM_MODE_CANONICAL_LF_V1,
  checksumMigrationBytes,
  checksumMigrationFile,
  sha256CanonicalLfV1FromBuffer,
  sha256Buffer,
  ledgerChecksumAccepted,
  assertSqlSemanticsUnchanged,
  normalizeMigrationBytesToCanonicalLf,
  reconcileLedger,
} = (() => {
  const integ = require('./lib/migration-integrity');
  const runner = require('./run-canonical-migrations');
  return { ...integ, reconcileLedger: runner.reconcileLedger };
})();

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'fixtures', 'migration-integrity');
const TRANSITION = path.join(
  ROOT,
  'fixtures',
  'sunset-schema-observer',
  'slice13a1-checksum-canonical-lf-v1-transition-report.json',
);

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function rollbackOwners(d, entries) {
  const owners = new Map();
  function add(e) {
    if (e && e.classification !== 'rollback_down') owners.set(e.id || e.filename, e);
  }
  for (const e of entries) {
    if (e.downFilename === d.filename) add(e);
  }
  if (d.pairsWith) {
    add(entries.find((e) => e.filename === d.pairsWith));
  }
  const m = String(d.filename || '').match(/^(.*)_down\.sql$/);
  if (m) add(entries.find((e) => e.filename === m[1] + '.sql'));
  return Array.from(owners.values());
}

function rollbackPairing(man) {
  const entries = man.entries || [];
  const fwd = forwardEntries(man);
  const rollback = entries.filter((e) => e.classification === 'rollback_down');
  const names = rollback.map((d) => d.filename);
  if (new Set(names).size !== names.length) {
    return { ok: false, code: 'duplicate_rollback_filename' };
  }
  const referenced = [];
  for (const f of fwd) {
    if (!f.downFilename) continue;
    const hits = rollback.filter((d) => d.filename === f.downFilename);
    if (hits.length !== 1) {
      return { ok: false, code: 'forward_down_unresolved', id: f.id };
    }
    referenced.push(f.downFilename);
  }
  if (new Set(referenced).size !== referenced.length) {
    return { ok: false, code: 'rollback_referenced_twice' };
  }
  for (const d of rollback) {
    const owners = rollbackOwners(d, entries);
    if (owners.length !== 1) {
      return {
        ok: false,
        code: owners.length === 0 ? 'orphan_rollback' : 'rollback_owner_ambiguous',
        filename: d.filename,
      };
    }
  }
  return { ok: true };
}

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}

console.log('verify:migration-integrity — RED→GREEN\n');

const manifest = loadManifest(MANIFEST_PATH);
const green = validateManifestIntegrity(manifest);
pass('green-manifest-integrity', green.ok, JSON.stringify(green.errors.slice(0, 3)));
pass('green-checksum-mode-canonical-lf-v1', manifest.checksumMode === CHECKSUM_MODE_CANONICAL_LF_V1);
pass(
  'green-015-gap-recorded',
  Array.isArray(manifest.intentionalGaps)
    && manifest.intentionalGaps.some((g) => String(g.number) === '015'),
);
const CALENDAR_BRIDGE_FORWARD_IDS = Object.freeze([
  '089_external_calendar_inventory',
  '090_external_calendar_inventory_tenant_integrity',
  '091_booking_occupancy_serialization',
]);
const ISSUANCE_MATERIAL_FORWARD_ID = '092_tenant_email_luna_automation_issuance_material';
const SHADOW_OUTCOME_FORWARD_ID = '093_tenant_email_luna_automation_shadow_outcomes';
const MASTER_CALENDAR_BRIDGE_DIGESTS = Object.freeze({
  '089_external_calendar_inventory': 'b07a7f87ca1b9e2c3da2da60ef161ccdc049a42726cf12fe4872b742740b9b6f',
  '090_external_calendar_inventory_tenant_integrity': '2e9b9d5219f79d89cc8eadbdb2679c0e2a47c7e7948ecdd0e4449c0eeac33893',
  '091_booking_occupancy_serialization': 'f5c03f76fd949d2e5695bccc03e1bcf4ced7d2836fbbc9646df27be15bca7976',
});

function calendarBridgeSequence(fwd) {
  const ids = fwd.map((e) => e.id);
  const start = ids.indexOf(CALENDAR_BRIDGE_FORWARD_IDS[0]);
  if (start < 0) return '';
  return ids.slice(start, start + CALENDAR_BRIDGE_FORWARD_IDS.length).join(',');
}

function numberedSqlBases(files) {
  const byNumber = new Map();
  for (const filename of files) {
    const match = String(filename).match(/^(\d{3})_(.+?)(?:_down)?\.sql$/);
    if (!match) continue;
    const base = `${match[1]}_${match[2]}.sql`;
    if (!byNumber.has(match[1])) byNumber.set(match[1], new Set());
    byNumber.get(match[1]).add(base);
  }
  return byNumber;
}

const forwards = forwardEntries(manifest);
pass(
  'green-forward-count',
  forwards.length === manifest.entries.filter((e) => e.inForwardChain === true && e.classification === 'canonical_forward').length
    && CALENDAR_BRIDGE_FORWARD_IDS.every((id) => forwards.some((e) => e.id === id))
    && forwards.some((e) => e.id === ISSUANCE_MATERIAL_FORWARD_ID)
    && forwards.some((e) => e.id === SHADOW_OUTCOME_FORWARD_ID),
  `forward=${forwards.length}`,
);
pass(
  'green-calendar-bridge-forward-tail',
  calendarBridgeSequence(forwards) === CALENDAR_BRIDGE_FORWARD_IDS.join(',')
    && forwards.slice(-CALENDAR_BRIDGE_FORWARD_IDS.length - 2, -2).map((e) => e.id).join(',') === CALENDAR_BRIDGE_FORWARD_IDS.join(','),
  forwards.slice(-5).map((e) => e.id).join(','),
);
pass(
  'green-issuance-material-forward-after-calendar-bridge',
  forwards[forwards.length - 1] && forwards[forwards.length - 1].id === SHADOW_OUTCOME_FORWARD_ID
    && forwards[forwards.length - 2] && forwards[forwards.length - 2].id === ISSUANCE_MATERIAL_FORWARD_ID
    && calendarBridgeSequence(forwards.slice(0, -2)) === CALENDAR_BRIDGE_FORWARD_IDS.join(','),
  forwards.slice(-5).map((e) => e.id).join(','),
);
pass(
  'green-all-sql-classified',
  fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).length === manifest.entries.length,
);
pass('green-all-entries-have-canonical-hashes', manifest.entries.every((e) => /^[0-9a-f]{64}$/.test(e.sha256)));

// Duplicate decisions documented
pass(
  'green-duplicate-024-decision',
  (manifest.duplicateNumberDecisions || []).some(
    (d) => String(d.number) === '024' && d.canonicalFilename === '024_booking_guests.sql',
  ),
);
pass(
  'green-duplicate-030-decision',
  (manifest.duplicateNumberDecisions || []).some((d) => String(d.number) === '030'),
);
pass(
  'green-duplicate-033-decision',
  (manifest.duplicateNumberDecisions || []).some((d) => String(d.number) === '033'),
);

// Non-forward classifications present
{
  const byClass = {};
  for (const e of manifest.entries) {
    byClass[e.classification] = (byClass[e.classification] || 0) + 1;
  }
  pass('green-has-proposed', (byClass.proposed_not_executable || 0) >= 4);
  const pairing = rollbackPairing(manifest);
  pass('green-has-rollback', pairing.ok === true, pairing.code);
  pass('green-no-unresolved', (byClass.unresolved || 0) === 0);
}

// RED: checksum change (arbitrary)
{
  const m = deepClone(manifest);
  const fwd = m.entries.find((e) => e.inForwardChain);
  fwd.sha256 = '0'.repeat(64);
  const r = validateManifestIntegrity(m);
  pass('red-checksum-change', !r.ok && r.errors.some((e) => e.code === 'checksum_mismatch'));
}

{
  const m = deepClone(manifest);
  m.entries = m.entries.filter((e) => e.id !== '091_booking_occupancy_serialization');
  const r = validateManifestIntegrity(m);
  const fwd = forwardEntries(m);
  pass(
    'red-calendar-091-missing',
    !r.ok && r.errors.some((e) => e.code === 'unclassified_sql')
      && !fwd.some((e) => e.id === '091_booking_occupancy_serialization')
      && calendarBridgeSequence(fwd) !== CALENDAR_BRIDGE_FORWARD_IDS.join(','),
  );
}

{
  const m = deepClone(manifest);
  const ninety = m.entries.find((e) => e.id === '090_external_calendar_inventory_tenant_integrity');
  const ninetyOne = m.entries.find((e) => e.id === '091_booking_occupancy_serialization');
  ninetyOne.order = ninety.order;
  const r = validateManifestIntegrity(m);
  pass('red-calendar-091-duplicate-order', !r.ok && r.errors.some((e) => e.code === 'duplicate_order'));
}

{
  const m = deepClone(manifest);
  const ninety = m.entries.find((e) => e.id === '090_external_calendar_inventory_tenant_integrity');
  const ninetyOne = m.entries.find((e) => e.id === '091_booking_occupancy_serialization');
  const tmp = ninety.order;
  ninety.order = ninetyOne.order;
  ninetyOne.order = tmp;
  pass(
    'red-calendar-090-091-reordered',
    calendarBridgeSequence(forwardEntries(m)) !== CALENDAR_BRIDGE_FORWARD_IDS.join(','),
  );
}

{
  const m = deepClone(manifest);
  const eightyNine = m.entries.find((e) => e.id === '089_external_calendar_inventory');
  eightyNine.sha256 = '0'.repeat(64);
  const r = validateManifestIntegrity(m);
  pass('red-calendar-089-digest-invalid', !r.ok && r.errors.some((e) => e.code === 'checksum_mismatch'));
}

{
  const m = deepClone(manifest);
  m.entries.push({
    id: 'rollback_orphan_probe',
    filename: '999_orphan_down.sql',
    classification: 'rollback_down',
    inForwardChain: false,
    sha256: 'ab'.repeat(32),
  });
  const pairing = rollbackPairing(m);
  pass('red-rollback-orphan', pairing.ok === false && pairing.code === 'orphan_rollback');
}

{
  const m = deepClone(manifest);
  const down = m.entries.find((e) => e.id === '091_booking_occupancy_serialization_down');
  m.entries.push({
    ...down,
    id: '091_booking_occupancy_serialization_down_dup',
  });
  const pairing = rollbackPairing(m);
  pass('red-rollback-duplicate', pairing.ok === false && pairing.code === 'duplicate_rollback_filename');
}

{
  const m = deepClone(manifest);
  const eightyNine = m.entries.find((e) => e.id === '089_external_calendar_inventory');
  const ninetyOne = m.entries.find((e) => e.id === '091_booking_occupancy_serialization');
  ninetyOne.downFilename = eightyNine.downFilename;
  const pairing = rollbackPairing(m);
  pass(
    'red-forward-wrong-rollback',
    pairing.ok === false
      && (pairing.code === 'rollback_referenced_twice' || pairing.code === 'orphan_rollback'),
  );
}

{
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const byNumber = numberedSqlBases(files);
  const protectedNumbers = ['089', '090', '091', '092'];
  const collisions = [...byNumber.entries()]
    .filter(([n, set]) => protectedNumbers.includes(n) && set.size > 1)
    .map(([n, set]) => `${n}:${[...set].join('|')}`);
  pass('green-no-duplicate-forward-migration-numbers', collisions.length === 0, collisions.join(','));
  pass(
    'green-master-calendar-089-090-091-not-overwritten',
    files.includes('089_external_calendar_inventory.sql')
      && files.includes('089_external_calendar_inventory_down.sql')
      && files.includes('090_external_calendar_inventory_tenant_integrity.sql')
      && files.includes('091_booking_occupancy_serialization.sql')
      && files.includes('092_tenant_email_luna_automation_issuance_material.sql')
      && !files.some((f) => /089_.*issuance_material/.test(f)),
  );
  pass(
    'green-master-calendar-bridge-digests-pinned',
    Object.entries(MASTER_CALENDAR_BRIDGE_DIGESTS).every(([id, sha]) => {
      const entry = manifest.entries.find((e) => e.id === id);
      return entry && entry.sha256 === sha && entry.filename === `${id}.sql`;
    }),
  );
}

{
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const collided = numberedSqlBases(files.concat(['089_tenant_email_luna_automation_issuance_material.sql']));
  pass(
    'red-issuance-089-duplicate-number-collision',
    collided.get('089') && collided.get('089').size > 1
      && collided.get('089').has('089_external_calendar_inventory.sql')
      && collided.get('089').has('089_tenant_email_luna_automation_issuance_material.sql'),
  );
}

{
  const m = deepClone(manifest);
  const issuance = m.entries.find((e) => e.id === ISSUANCE_MATERIAL_FORWARD_ID);
  const calendar = m.entries.find((e) => e.id === '089_external_calendar_inventory');
  issuance.order = calendar.order;
  const r = validateManifestIntegrity(m);
  pass(
    'red-issuance-cannot-reuse-calendar-089-order',
    !r.ok && r.errors.some((e) => e.code === 'duplicate_order'),
  );
}

// RED: unknown checksum mode
{
  const m = deepClone(manifest);
  m.checksumMode = 'raw_bytes_v0_unknown';
  const r = validateManifestIntegrity(m);
  pass('red-unknown-checksum-mode', !r.ok && r.errors.some((e) => e.code === 'checksum_mode_unknown'));
}

// RED: missing checksum mode
{
  const m = deepClone(manifest);
  delete m.checksumMode;
  const r = validateManifestIntegrity(m);
  pass('red-missing-checksum-mode', !r.ok && r.errors.some((e) => e.code === 'checksum_mode_missing'));
}

// RED: duplicate order
{
  const m = deepClone(manifest);
  const fwds = m.entries.filter((e) => e.inForwardChain);
  fwds[1].order = fwds[0].order;
  const r = validateManifestIntegrity(m);
  pass('red-duplicate-order', !r.ok && r.errors.some((e) => e.code === 'duplicate_order'));
}

// RED: duplicate id
{
  const m = deepClone(manifest);
  const fwds = m.entries.filter((e) => e.inForwardChain);
  fwds[1].id = fwds[0].id;
  const r = validateManifestIntegrity(m);
  pass('red-duplicate-id', !r.ok && r.errors.some((e) => e.code === 'duplicate_id'));
}

// RED: proposed in forward chain
{
  const m = deepClone(manifest);
  const prop = m.entries.find((e) => e.classification === 'proposed_not_executable');
  prop.inForwardChain = true;
  prop.order = 999;
  prop.classification = 'proposed_not_executable';
  const r = validateManifestIntegrity(m);
  pass('red-proposed-in-forward-chain', !r.ok && r.errors.some((e) => e.code === 'non_forward_in_chain'));
}

// RED: down in forward chain
{
  const m = deepClone(manifest);
  const down = m.entries.find((e) => e.classification === 'rollback_down');
  down.inForwardChain = true;
  down.order = 998;
  const r = validateManifestIntegrity(m);
  pass('red-down-in-forward-chain', !r.ok && r.errors.some((e) => e.code === 'non_forward_in_chain'));
}

// RED: missing manifest file
{
  const m = deepClone(manifest);
  m.entries.push({
    id: '999_missing',
    filename: '999_does_not_exist.sql',
    sha256: 'a'.repeat(64),
    order: null,
    classification: 'proposed_not_executable',
    inForwardChain: false,
    rationale: 'fixture',
  });
  const r = validateManifestIntegrity(m);
  pass('red-missing-manifest-file', !r.ok && r.errors.some((e) => e.code === 'missing_file'));
}

// RED: unclassified SQL on disk (temp fixture file)
{
  const rogue = path.join(MIGRATIONS_DIR, '_tmp_unclassified_rogue.sql');
  fs.writeFileSync(rogue, '-- rogue\n');
  try {
    const r = validateManifestIntegrity(manifest);
    pass('red-unclassified-sql', !r.ok && r.errors.some((e) => e.code === 'unclassified_sql'));
  } finally {
    fs.unlinkSync(rogue);
  }
}

// RED: unresolved classification
{
  const m = deepClone(manifest);
  const e = m.entries.find((x) => !x.inForwardChain);
  e.classification = 'unresolved';
  const r = validateManifestIntegrity(m);
  pass('red-unresolved', !r.ok && r.errors.some((err) => err.code === 'unresolved_entry'));
}

// Target safety
{
  pass(
    'red-forbidden-azure-host',
    !assertSafeDatabaseTarget({
      host: 'luna-sunset-staging-pg-app.postgres.database.azure.com',
      port: 5432,
      database: 'wh_mig_test',
    }).ok,
  );
  pass(
    'red-forbidden-db-name',
    !assertSafeDatabaseTarget({
      host: '127.0.0.1',
      port: 5432,
      database: 'sunset_staging',
    }).ok,
  );
  pass(
    'green-ephemeral-local-target',
    assertSafeDatabaseTarget({
      host: '127.0.0.1',
      port: 55432,
      database: 'wh_mig_proof_abc123',
    }).ok,
  );
  pass(
    'green-localhost-loopback',
    assertSafeDatabaseTarget({
      host: 'localhost',
      port: 5432,
      database: 'wh_mig_proof_abc123',
    }).ok,
  );
  pass(
    'red-rfc1918-10',
    !assertSafeDatabaseTarget({
      host: '10.0.0.5',
      port: 5432,
      database: 'wh_mig_proof_abc123',
    }).ok
      && assertSafeDatabaseTarget({
        host: '10.0.0.5',
        port: 5432,
        database: 'wh_mig_proof_abc123',
      }).errors.some((e) => e.code === 'target_host_not_loopback'),
  );
  pass(
    'red-rfc1918-172',
    !assertSafeDatabaseTarget({
      host: '172.16.4.2',
      port: 5432,
      database: 'wh_mig_proof_abc123',
    }).ok,
  );
  pass(
    'red-rfc1918-192',
    !assertSafeDatabaseTarget({
      host: '192.168.1.10',
      port: 5432,
      database: 'wh_mig_proof_abc123',
    }).ok,
  );
  pass(
    'red-docker-dns-name',
    !assertSafeDatabaseTarget({
      host: 'postgres',
      port: 5432,
      database: 'wh_mig_proof_abc123',
    }).ok,
  );
  pass(
    'red-deceptive-ephemeral-on-private-host',
    !assertSafeDatabaseTarget({
      host: '10.8.0.1',
      port: 5432,
      database: 'wh_mig_looks_ephemeral',
    }).ok,
  );
}

// prepareMigrationBody RED/GREEN
{
  const plain = prepareMigrationBody('CREATE TABLE t(id int);\n');
  pass('green-prepare-no-wrapper', plain.ok && plain.stripped === false && plain.body.includes('CREATE TABLE'));
}
{
  const wrapped = prepareMigrationBody('BEGIN;\nCREATE TABLE t(id int);\nCOMMIT;\n');
  pass(
    'green-prepare-strip-outer',
    wrapped.ok && wrapped.stripped === true && !/^BEGIN/i.test(wrapped.body) && !/COMMIT/i.test(wrapped.body),
  );
}
{
  const nested = prepareMigrationBody('BEGIN;\nBEGIN;\nCREATE TABLE t(id int);\nCOMMIT;\nCOMMIT;\n');
  pass(
    'red-prepare-nested-txn',
    !nested.ok && nested.code === 'nested_or_extra_txn_control',
  );
}
{
  const ambiguous = prepareMigrationBody('CREATE TABLE t(id int);\nCOMMIT;\n');
  pass(
    'red-prepare-ambiguous-txn',
    !ambiguous.ok && (ambiguous.code === 'ambiguous_txn_wrapper' || ambiguous.code === 'nested_or_extra_txn_control'),
  );
}
{
  const plpgsql = prepareMigrationBody(
    "BEGIN;\nDO $$ BEGIN RAISE NOTICE 'x'; END $$;\nCOMMIT;\n",
  );
  pass('green-prepare-plpgsql-begin-ok', plpgsql.ok && plpgsql.stripped === true);
}
{
  let bad = null;
  for (const e of forwardEntries(manifest)) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, e.filename), 'utf8');
    const p = prepareMigrationBody(sql);
    if (!p.ok) {
      bad = `${e.filename}:${p.code}`;
      break;
    }
  }
  pass('green-all-forward-prepare', bad === null, bad);
}

// Slice 13A.1 — cross-platform checksum equivalence + fail-closed
{
  const sample = forwardEntries(manifest);
  let lfOk = true;
  let crlfOk = true;
  let sqlChangeFails = true;
  for (const e of sample) {
    const abs = path.join(MIGRATIONS_DIR, e.filename);
    const raw = fs.readFileSync(abs);
    const lfNorm = normalizeMigrationBytesToCanonicalLf(raw);
    if (!lfNorm.ok || sha256CanonicalLfV1FromBuffer(lfNorm.buffer) !== e.sha256) lfOk = false;

    // Simulate CRLF checkout of LF content (and leave existing CRLF alone via normalize).
    const asText = raw.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const crlfSim = Buffer.from(asText.replace(/\n/g, '\r\n'), 'utf8');
    const crlfHash = sha256CanonicalLfV1FromBuffer(crlfSim);
    if (crlfHash !== e.sha256) crlfOk = false;

    // Executable SQL byte change must fail checksum
    const mutated = Buffer.from(`${asText}\n-- slice13a1-probe\n`, 'utf8');
    if (sha256CanonicalLfV1FromBuffer(mutated) === e.sha256) sqlChangeFails = false;
  }
  pass('green-raw-lf-canonical-checksums', lfOk);
  pass('green-simulated-crlf-canonical-checksums-identical', crlfOk);
  pass('red-executable-sql-byte-change-fails-checksum', sqlChangeFails);

  // Binary / NUL rejected
  const nul = checksumMigrationBytes(Buffer.from('CREATE TABLE t;\n\0', 'utf8'), CHECKSUM_MODE_CANONICAL_LF_V1);
  pass('red-binary-nul-rejected', !nul.ok && nul.code === 'unsupported_binary_content');

  // All forward migrations byte-verifiable under canonical_lf_v1
  let forwardVerified = 0;
  for (const e of sample) {
    const live = checksumMigrationFile(path.join(MIGRATIONS_DIR, e.filename), CHECKSUM_MODE_CANONICAL_LF_V1);
    if (live.ok && live.sha256 === e.sha256) forwardVerified += 1;
  }
  pass('green-all-forward-canonical-lf-v1', forwardVerified === forwards.length, `verified=${forwardVerified}`);

  // Previously CRLF Git files normalize identically (named in transition report)
  pass('green-transition-report-present', fs.existsSync(TRANSITION));
  if (fs.existsSync(TRANSITION)) {
    const tr = JSON.parse(fs.readFileSync(TRANSITION, 'utf8'));
    const norm = tr.normalizedGitBlobs || [];
    let normOk = norm.length >= 2;
    for (const n of norm) {
      const abs = path.join(MIGRATIONS_DIR, n.filename);
      const live = checksumMigrationFile(abs, CHECKSUM_MODE_CANONICAL_LF_V1);
      const ent = manifest.entries.find((e) => e.filename === n.filename);
      if (!ent || !live.ok || live.sha256 !== ent.sha256 || live.sha256 !== n.canonicalLfHash) {
        normOk = false;
      }
    }
    pass('green-previously-crlf-blobs-normalize-identically', normOk, `count=${norm.length}`);
    pass(
      'green-transition-eol-only-all-entries',
      Array.isArray(tr.entries)
        && tr.entries.length >= 41
        && tr.entries.length <= manifest.entries.length
        && tr.entries.every((e) => e.differenceWasEolOnly === true && e.executableSqlUnchanged === true),
    );
    pass(
      'green-product-fingerprint-unchanged-in-transition',
      tr.productFingerprintUnchanged
        === 'daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52',
    );
  }
}

// Token-aware SQL semantics: EOL-only identical; token change differs
{
  const a = Buffer.from('SELECT 1;\n', 'utf8');
  const b = Buffer.from('SELECT 1;\r\n', 'utf8');
  const c = Buffer.from('SELECT 2;\n', 'utf8');
  pass('green-sql-semantics-eol-only', assertSqlSemanticsUnchanged(a, b).ok);
  pass('red-sql-semantics-token-change', !assertSqlSemanticsUnchanged(a, c).ok);
}

// Ledger reconcile RED + GREEN (Slice 14AD provenance-aware; no silent legacy→canonical)
{
  const {
    APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
    APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
    APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE,
    CHECKSUM_MODE_CANONICAL_LF_V1: MODE,
    LEDGER_DDL,
    LEDGER_LEGACY_UPGRADE_DDL,
  } = require('./lib/migration-integrity');
  const forward = forwardEntries(manifest);
  const TS = '2026-07-20T00:31:52.213Z';
  function row(e, extra) {
    return {
      id: e.id,
      filename: e.filename,
      checksum_sha256: e.sha256,
      apply_order: e.order,
      apply_kind: APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
      checksum_mode: MODE,
      ledger_recorded_at: TS,
      applied_at: TS,
      ...(extra || {}),
    };
  }

  // Fresh DDL remains strict; legacy upgrade is nullable with NO data defaults.
  pass(
    'green-fresh-ledger-ddl-strict-defaults',
    /checksum_mode TEXT NOT NULL DEFAULT 'canonical_lf_v1'/.test(LEDGER_DDL)
      && /ledger_recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/.test(LEDGER_DDL)
      && /apply_kind TEXT NOT NULL/.test(LEDGER_DDL),
  );
  pass(
    'red-legacy-upgrade-no-checksum-mode-default',
    /ADD COLUMN IF NOT EXISTS checksum_mode TEXT;/.test(LEDGER_LEGACY_UPGRADE_DDL)
      && !/checksum_mode TEXT(?:\s+NOT NULL)?\s+DEFAULT/.test(LEDGER_LEGACY_UPGRADE_DDL),
  );
  pass(
    'red-legacy-upgrade-no-silent-now-ledger-recorded-at',
    /ADD COLUMN IF NOT EXISTS ledger_recorded_at TIMESTAMPTZ;/.test(LEDGER_LEGACY_UPGRADE_DDL)
      && !/ledger_recorded_at TIMESTAMPTZ DEFAULT NOW\(\)/.test(LEDGER_LEGACY_UPGRADE_DDL),
  );

  const r = reconcileLedger(forward, [
    row(forward[0], { checksum_sha256: 'f'.repeat(64) }),
  ]);
  pass('red-ledger-checksum-mismatch', !r.ok && r.errors.some((e) => e.code === 'ledger_checksum_mismatch'));
  const rNullKind = reconcileLedger(forward, [row(forward[0], { apply_kind: null })]);
  pass('red-ledger-apply-kind-null', !rNullKind.ok && rNullKind.errors.some((e) => e.code === 'ledger_apply_kind_null'));
  const rBadKind = reconcileLedger(forward, [row(forward[0], { apply_kind: 'fabricated_kind' })]);
  pass('red-ledger-apply-kind-unknown', !rBadKind.ok && rBadKind.errors.some((e) => e.code === 'ledger_apply_kind_unknown'));
  const rNullMode = reconcileLedger(forward, [row(forward[0], { checksum_mode: null })]);
  pass('red-ledger-checksum-mode-null', !rNullMode.ok && rNullMode.errors.some((e) => e.code === 'ledger_checksum_mode_null'));
  const rNullRecorded = reconcileLedger(forward, [row(forward[0], { ledger_recorded_at: null })]);
  pass('red-ledger-recorded-at-null', !rNullRecorded.ok && rNullRecorded.errors.some((e) => e.code === 'ledger_recorded_at_null'));

  // Post-upgrade unrepaired five-column row: all provenance null — fail closed.
  const rNullProv = reconcileLedger(forward, [{
    id: forward[0].id,
    filename: forward[0].filename,
    checksum_sha256: forward[0].sha256,
    apply_order: forward[0].order,
    apply_kind: null,
    checksum_mode: null,
    evidence_ref: null,
    provenance_notes: null,
    ledger_recorded_at: null,
    applied_at: TS,
  }]);
  pass(
    'red-ledger-null-legacy-provenance',
    !rNullProv.ok
      && rNullProv.errors.some((e) => e.code === 'ledger_apply_kind_null')
      && rNullProv.errors.some((e) => e.code === 'ledger_checksum_mode_null')
      && rNullProv.errors.some((e) => e.code === 'ledger_recorded_at_null')
      && rNullProv.errors.some((e) => e.code === 'ledger_checksum_unprovenanced'),
  );

  const rPartial = reconcileLedger(forward, [
    {
      id: forward[1].id,
      filename: forward[1].filename,
      checksum_sha256: forward[1].sha256,
      apply_order: 2,
      apply_kind: APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
      checksum_mode: MODE,
      ledger_recorded_at: TS,
    },
  ]);
  pass('red-ledger-partial-history', !rPartial.ok && rPartial.errors.some((e) => e.code === 'ledger_partial_history'));

  const withLegacy = forward.find((e) => e.legacySha256);
  pass('green-legacy-sha-present-on-some-entries', Boolean(withLegacy));
  if (withLegacy) {
    const acceptCanon = ledgerChecksumAccepted(withLegacy, withLegacy.sha256);
    const acceptLegacy = ledgerChecksumAccepted(withLegacy, withLegacy.legacySha256);
    const rejectOther = ledgerChecksumAccepted(withLegacy, 'a'.repeat(64));
    pass('green-ledger-accepts-canonical-hash', acceptCanon.ok && acceptCanon.mode === CHECKSUM_MODE_CANONICAL_LF_V1);
    // Disk/era helper may still recognize exact legacySha256; reconcile must NOT.
    pass('green-ledger-accepts-exact-legacy-hash-only', acceptLegacy.ok && acceptLegacy.mode === 'legacy_crlf_era_exact');
    pass('red-ledger-rejects-arbitrary-hash', !rejectOther.ok);

    // RED: legacy hash auto-mislabeled as canonical_lf_v1 must fail mode/hash consistency.
    const rowsLegacyMislabeled = forward.slice(0, withLegacy.order).map((e) => ({
      id: e.id,
      filename: e.filename,
      checksum_sha256: e.id === withLegacy.id ? e.legacySha256 : e.sha256,
      apply_order: e.order,
      apply_kind: APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
      checksum_mode: MODE,
      ledger_recorded_at: TS,
    }));
    const reconMislabel = reconcileLedger(forward, rowsLegacyMislabeled);
    pass(
      'red-ledger-legacy-hash-under-canonical-mode',
      !reconMislabel.ok
        && reconMislabel.errors.some((e) => e.code === 'ledger_checksum_mode_hash_inconsistency'),
      JSON.stringify(reconMislabel.errors.slice(0, 2)),
    );

    // Single-row RED: canonical mode + exact legacy hash → inconsistency (not mismatch).
    const rInconsistency = reconcileLedger(forward, [
      row(withLegacy, { checksum_sha256: withLegacy.legacySha256 }),
    ]);
    pass(
      'red-ledger-canonical-mode-legacy-hash-inconsistency',
      !rInconsistency.ok
        && rInconsistency.errors.some((e) => e.code === 'ledger_checksum_mode_hash_inconsistency')
        && !rInconsistency.errors.some((e) => e.code === 'ledger_checksum_mismatch'),
    );

    // GREEN: exact canonical repaired row under canonical mode.
    const repaired = reconcileLedger(forward, [row(withLegacy)]);
    pass('green-ledger-exact-canonical-repaired-row', repaired.ok, JSON.stringify(repaired.errors.slice(0, 2)));

    const rowsCanon = forward.slice(0, 3).map((e) => row(e));
    pass('green-ledger-reconcile-canonical-writes', reconcileLedger(forward, rowsCanon).ok);

    const rowsBaseline = forward.slice(0, 3).map((e, i) => row(e, {
      apply_kind: i === 0
        ? APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE
        : APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
    }));
    pass('green-ledger-reconcile-baseline-kinds-as-applied', reconcileLedger(forward, rowsBaseline).ok);
  }
}

// Fixture dir exists for proof notes
fs.mkdirSync(FIXTURES, { recursive: true });
fs.writeFileSync(
  path.join(FIXTURES, 'README.md'),
  '# Migration integrity fixtures\n\nRED cases live in `scripts/verify-migration-integrity.js` (in-memory).\nChecksum mode: canonical_lf_v1 (Slice 13A.1).\n',
);

// Spot-check checksums via declared mode (not raw disk bytes)
{
  const sample = forwardEntries(manifest).slice(0, 3);
  let ok = true;
  for (const e of sample) {
    const live = checksumMigrationFile(path.join(MIGRATIONS_DIR, e.filename), CHECKSUM_MODE_CANONICAL_LF_V1);
    if (!live.ok || live.sha256 !== e.sha256) ok = false;
  }
  pass('green-sample-checksums-match-disk-via-mode', ok);
}

// .gitattributes LF pin
{
  const ga = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
  pass(
    'green-gitattributes-migrations-eol-lf',
    /database\/migrations\/\*\.sql\s+text\s+eol=lf/.test(ga),
  );
}

// Secret-free: committed Slice 4/13A.1 artifacts must not contain live secret patterns
{
  const { scanSecretValues } = require('./lib/sunset-staging-iac-drift');
  const paths = [
    MANIFEST_PATH,
    path.join(ROOT, 'scripts/lib/migration-integrity.js'),
    path.join(ROOT, 'scripts/run-canonical-migrations.js'),
    path.join(ROOT, 'scripts/verify-migration-integrity.js'),
    path.join(ROOT, 'scripts/prove-canonical-migrations-fresh-db.js'),
    path.join(ROOT, 'scripts/apply-migration-checksum-canonical-lf-v1.js'),
    path.join(ROOT, 'database/migrations/README.md'),
    TRANSITION,
  ];
  let secretHits = 0;
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const hits = scanSecretValues(fs.readFileSync(p, 'utf8'));
    if (hits.length) {
      secretHits += 1;
      console.log(`        secret hit in ${path.relative(ROOT, p)}: ${hits.map((h) => h.pattern).join(',')}`);
    }
  }
  pass('green-slice4-artifacts-secret-free', secretHits === 0);
}

console.log(`\n── verify:migration-integrity: ${failed ? 'FAILED' : 'PASSED'} ──`);
process.exit(failed ? 1 : 0);
