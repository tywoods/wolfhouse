'use strict';

/**
 * verify:migration-integrity — FOUNDATION Slice 4
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
  sha256File,
  prepareMigrationBody,
  reconcileLedger,
} = (() => {
  const integ = require('./lib/migration-integrity');
  const runner = require('./run-canonical-migrations');
  return { ...integ, reconcileLedger: runner.reconcileLedger };
})();

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'fixtures', 'migration-integrity');

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}

console.log('verify:migration-integrity — RED→GREEN\n');

const manifest = loadManifest(MANIFEST_PATH);
const green = validateManifestIntegrity(manifest);
pass('green-manifest-integrity', green.ok, JSON.stringify(green.errors.slice(0, 3)));
pass(
  'green-015-gap-recorded',
  Array.isArray(manifest.intentionalGaps)
    && manifest.intentionalGaps.some((g) => String(g.number) === '015'),
);
pass(
  'green-forward-count',
  forwardEntries(manifest).length === 36,
  `forward=${forwardEntries(manifest).length}`,
);
pass(
  'green-all-sql-classified',
  fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).length === manifest.entries.length,
);

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
  pass('green-has-rollback', (byClass.rollback_down || 0) === 1);
  pass('green-no-unresolved', (byClass.unresolved || 0) === 0);
}

// RED: checksum change
{
  const m = deepClone(manifest);
  const fwd = m.entries.find((e) => e.inForwardChain);
  fwd.sha256 = '0'.repeat(64);
  const r = validateManifestIntegrity(m);
  pass('red-checksum-change', !r.ok && r.errors.some((e) => e.code === 'checksum_mismatch'));
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
  // plpgsql BEGIN without semicolon must not be treated as SQL txn control
  const plpgsql = prepareMigrationBody(
    "BEGIN;\nDO $$ BEGIN RAISE NOTICE 'x'; END $$;\nCOMMIT;\n",
  );
  pass('green-prepare-plpgsql-begin-ok', plpgsql.ok && plpgsql.stripped === true);
}
{
  // All forward migrations must prepare cleanly
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

// Ledger reconcile RED
{
  const forward = forwardEntries(manifest);
  const r = reconcileLedger(forward, [
    {
      id: forward[0].id,
      filename: forward[0].filename,
      checksum_sha256: 'f'.repeat(64),
      apply_order: 1,
    },
  ]);
  pass('red-ledger-checksum-mismatch', !r.ok && r.errors.some((e) => e.code === 'ledger_checksum_mismatch'));
}
{
  const forward = forwardEntries(manifest);
  const r = reconcileLedger(forward, [
    {
      id: forward[1].id,
      filename: forward[1].filename,
      checksum_sha256: forward[1].sha256,
      apply_order: 2,
    },
  ]);
  pass('red-ledger-partial-history', !r.ok && r.errors.some((e) => e.code === 'ledger_partial_history'));
}

// Fixture dir exists for proof notes
fs.mkdirSync(FIXTURES, { recursive: true });
fs.writeFileSync(
  path.join(FIXTURES, 'README.md'),
  '# Migration integrity fixtures\n\nRED cases live in `scripts/verify-migration-integrity.js` (in-memory).\n',
);

// Spot-check a few checksums still match disk
{
  const sample = forwardEntries(manifest).slice(0, 3);
  let ok = true;
  for (const e of sample) {
    if (sha256File(path.join(MIGRATIONS_DIR, e.filename)) !== e.sha256) ok = false;
  }
  pass('green-sample-checksums-match-disk', ok);
}

// Secret-free: committed Slice 4 artifacts must not contain live secret patterns
{
  const { scanSecretValues } = require('./lib/sunset-staging-iac-drift');
  const paths = [
    MANIFEST_PATH,
    path.join(ROOT, 'scripts/lib/migration-integrity.js'),
    path.join(ROOT, 'scripts/run-canonical-migrations.js'),
    path.join(ROOT, 'scripts/verify-migration-integrity.js'),
    path.join(ROOT, 'scripts/prove-canonical-migrations-fresh-db.js'),
    path.join(ROOT, 'database/migrations/README.md'),
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
