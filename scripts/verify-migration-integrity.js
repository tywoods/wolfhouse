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
pass(
  'green-forward-count',
  forwardEntries(manifest).length === 39,
  `forward=${forwardEntries(manifest).length}`,
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
  pass('green-has-rollback', (byClass.rollback_down || 0) === 1);
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

  // All 39 forward byte-verifiable under canonical_lf_v1
  let forwardVerified = 0;
  for (const e of sample) {
    const live = checksumMigrationFile(path.join(MIGRATIONS_DIR, e.filename), CHECKSUM_MODE_CANONICAL_LF_V1);
    if (live.ok && live.sha256 === e.sha256) forwardVerified += 1;
  }
  pass('green-all-39-forward-canonical-lf-v1', forwardVerified === 39, `verified=${forwardVerified}`);

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
        && tr.entries.length >= 40
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

// Ledger reconcile RED + narrow legacy GREEN
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
{
  const forward = forwardEntries(manifest);
  const withLegacy = forward.find((e) => e.legacySha256);
  pass('green-legacy-sha-present-on-some-entries', Boolean(withLegacy));
  if (withLegacy) {
    const acceptCanon = ledgerChecksumAccepted(withLegacy, withLegacy.sha256);
    const acceptLegacy = ledgerChecksumAccepted(withLegacy, withLegacy.legacySha256);
    const rejectOther = ledgerChecksumAccepted(withLegacy, 'a'.repeat(64));
    pass('green-ledger-accepts-canonical-hash', acceptCanon.ok && acceptCanon.mode === CHECKSUM_MODE_CANONICAL_LF_V1);
    pass('green-ledger-accepts-exact-legacy-hash-only', acceptLegacy.ok && acceptLegacy.mode === 'legacy_crlf_era_exact');
    pass('red-ledger-rejects-arbitrary-hash', !rejectOther.ok);

    const rowsLegacyPrefix = forward.slice(0, withLegacy.order).map((e) => ({
      id: e.id,
      filename: e.filename,
      checksum_sha256: e.id === withLegacy.id ? e.legacySha256 : e.sha256,
      apply_order: e.order,
    }));
    const recon = reconcileLedger(forward, rowsLegacyPrefix);
    pass('green-ledger-reconcile-exact-legacy-prefix', recon.ok, JSON.stringify(recon.errors.slice(0, 2)));

    const rowsCanon = forward.slice(0, 3).map((e) => ({
      id: e.id,
      filename: e.filename,
      checksum_sha256: e.sha256,
      apply_order: e.order,
    }));
    pass('green-ledger-reconcile-canonical-writes', reconcileLedger(forward, rowsCanon).ok);
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
