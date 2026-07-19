'use strict';

/**
 * FOUNDATION Slice 13A.1 — one-shot transition to checksumMode canonical_lf_v1.
 * Local filesystem + git only. No Azure / Postgres / live mutation.
 *
 * Usage: node scripts/apply-migration-checksum-canonical-lf-v1.js
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  ROOT,
  CHECKSUM_MODE_CANONICAL_LF_V1,
  sha256Buffer,
  sha256CanonicalLfV1FromBuffer,
  assertSqlSemanticsUnchanged,
  normalizeMigrationBytesToCanonicalLf,
  validateManifestIntegrity,
  loadManifest,
} = require('./lib/migration-integrity');
const { hashCanonicalManifest } = require('./lib/sunset-schema-observer');

const BASE_SHA = '235aca35d0c784e4a4c2388f075b5aa0ada85766';
const PRODUCT_FP = 'daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52';
const EVIDENCE_DIR = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const TRANSITION_PATH = path.join(
  EVIDENCE_DIR,
  'slice13a1-checksum-canonical-lf-v1-transition-report.json',
);

function gitShow(relPath) {
  return execFileSync('git', ['show', `${BASE_SHA}:${relPath.replace(/\\/g, '/')}`], {
    cwd: ROOT,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function hasCr(buf) {
  return Buffer.isBuffer(buf) && buf.includes(0x0d);
}

function eolOnlyDiff(beforeBuf, afterBuf) {
  const a = normalizeMigrationBytesToCanonicalLf(beforeBuf);
  const b = normalizeMigrationBytesToCanonicalLf(afterBuf);
  if (!a.ok || !b.ok) return { ok: false, reason: a.message || b.message };
  if (a.text !== b.text) {
    return { ok: false, reason: 'canonical-LF text differs beyond EOL' };
  }
  const sem = assertSqlSemanticsUnchanged(beforeBuf, afterBuf);
  if (!sem.ok) return { ok: false, reason: sem.message };
  return { ok: true, semanticFingerprint: sem.semanticFingerprint };
}

function hashCanonicalManifestLegacy(manifest) {
  // Pre-13A.1 algorithm (no checksumMode field) — used only for transition audit.
  const forward = (manifest.entries || [])
    .filter((e) => e.inForwardChain === true && e.classification === 'canonical_forward')
    .slice()
    .sort((a, b) => a.order - b.order);
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        version: manifest.version || null,
        intentionalGaps: manifest.intentionalGaps || [],
        forward: forward.map((e) => ({
          id: e.id,
          order: e.order,
          filename: e.filename,
          sha256: e.sha256,
        })),
      }),
    )
    .digest('hex');
}

function main() {
  const oldManifest = loadManifest(MANIFEST_PATH);
  const oldManifestHash = hashCanonicalManifestLegacy(oldManifest);

  const entriesOut = [];
  const transitionEntries = [];
  const crlfFilenames = [];

  for (const e of oldManifest.entries) {
    const rel = path.join('database', 'migrations', e.filename).replace(/\\/g, '/');
    const blob = gitShow(rel);
    const blobSha = sha256Buffer(blob);
    const canonicalSha = sha256CanonicalLfV1FromBuffer(blob);
    const oldSha = e.sha256;
    const eolOnly =
      blobSha === canonicalSha ||
      eolOnlyDiff(blob, normalizeMigrationBytesToCanonicalLf(blob).buffer).ok;
    // Prove: old manifest hash equals either raw blob or CRLF(blob) working-tree form
    const crlfSim = Buffer.from(blob.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
    const crlfSha = sha256Buffer(crlfSim);
    const oldMatchesBlob = oldSha === blobSha;
    const oldMatchesCrlfSim = oldSha === crlfSha;
    const oldMatchesCanonical = oldSha === canonicalSha;
    const differenceWasEolOnly =
      oldMatchesCanonical ||
      ((oldMatchesBlob || oldMatchesCrlfSim) &&
        eolOnlyDiff(
          oldMatchesCrlfSim ? crlfSim : blob,
          normalizeMigrationBytesToCanonicalLf(blob).buffer,
        ).ok);

    const sem = assertSqlSemanticsUnchanged(
      oldMatchesCrlfSim ? crlfSim : blob,
      normalizeMigrationBytesToCanonicalLf(blob).buffer,
    );

    if (hasCr(blob)) crlfFilenames.push(e.filename);

    transitionEntries.push({
      id: e.id,
      filename: e.filename,
      oldManifestHash: oldSha,
      rawPreChangeGitBlobHash: blobSha,
      canonicalLfHash: canonicalSha,
      differenceWasEolOnly: Boolean(differenceWasEolOnly),
      executableSqlUnchanged: Boolean(sem.ok),
      gitBlobHadCr: hasCr(blob),
      oldMatchedRawGitBlob: oldMatchesBlob,
      oldMatchedCrlfWorkingTreeSimulation: oldMatchesCrlfSim,
      classification: e.classification,
      inForwardChain: e.inForwardChain,
    });

    if (!differenceWasEolOnly || !sem.ok) {
      throw new Error(
        `refusing to rewrite ${e.filename}: eolOnly=${differenceWasEolOnly} sqlUnchanged=${sem.ok}`,
      );
    }

    entriesOut.push({
      ...e,
      sha256: canonicalSha,
      legacySha256: oldSha === canonicalSha ? undefined : oldSha,
    });
    // Drop undefined legacySha256
    if (entriesOut[entriesOut.length - 1].legacySha256 === undefined) {
      delete entriesOut[entriesOut.length - 1].legacySha256;
    }
  }

  // Normalize CRLF Git blobs to LF after proving EOL-only.
  const normalizedFiles = [];
  for (const filename of crlfFilenames) {
    const abs = path.join(MIGRATIONS_DIR, filename);
    const before = fs.readFileSync(abs);
    const n = normalizeMigrationBytesToCanonicalLf(before);
    if (!n.ok) throw new Error(`${filename}: ${n.message}`);
    const proof = eolOnlyDiff(before, n.buffer);
    if (!proof.ok) throw new Error(`${filename}: not EOL-only — ${proof.reason}`);
    // Also prove against committed blob
    const blob = gitShow(path.join('database', 'migrations', filename).replace(/\\/g, '/'));
    const blobProof = eolOnlyDiff(blob, n.buffer);
    if (!blobProof.ok) throw new Error(`${filename}: blob not EOL-only — ${blobProof.reason}`);
    fs.writeFileSync(abs, n.buffer);
    normalizedFiles.push({
      filename,
      beforeSha256: sha256Buffer(before),
      afterSha256: sha256Buffer(n.buffer),
      canonicalLfHash: sha256CanonicalLfV1FromBuffer(n.buffer),
      eolOnly: true,
      executableSqlUnchanged: true,
    });
  }

  const newManifest = {
    ...oldManifest,
    schemaVersion: oldManifest.schemaVersion || 1,
    checksumMode: CHECKSUM_MODE_CANONICAL_LF_V1,
    checksumModeNote:
      'Slice 13A.1: SHA-256 over UTF-8 bytes after CRLF/lone-CR→LF normalization. Rejects NUL/binary. legacySha256 retains exact pre-transition hashes for narrow ledger acceptance only.',
    generatedForMaster: BASE_SHA,
    slice13a1Transition: {
      fromMaster: BASE_SHA,
      mode: CHECKSUM_MODE_CANONICAL_LF_V1,
      transitionReport: 'fixtures/sunset-schema-observer/slice13a1-checksum-canonical-lf-v1-transition-report.json',
    },
    entries: entriesOut,
  };

  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(newManifest, null, 2)}\n`);

  const integrity = validateManifestIntegrity(newManifest);
  if (!integrity.ok) {
    throw new Error(`post-write integrity failed: ${JSON.stringify(integrity.errors.slice(0, 5))}`);
  }

  const newHashBundle = hashCanonicalManifest(newManifest);
  const newManifestHash = newHashBundle.manifestHash;

  // Update expected product schema manifestHash only; fingerprint must stay locked.
  const expectedPath = path.join(EVIDENCE_DIR, 'expected-product-schema.json');
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  if (expected.productFingerprint !== PRODUCT_FP) {
    throw new Error(`product fingerprint drifted: ${expected.productFingerprint}`);
  }
  const oldExpectedManifestHash = expected.manifestHash;
  expected.manifestHash = newManifestHash;
  expected.checksumMode = CHECKSUM_MODE_CANONICAL_LF_V1;
  expected.generatedFromMaster = BASE_SHA;
  expected.slice13a1Note =
    'manifestHash regenerated for canonical_lf_v1; productFingerprint unchanged';
  fs.writeFileSync(expectedPath, `${JSON.stringify(expected, null, 2)}\n`);

  const transition = {
    kind: 'sunset-schema-observer-slice13a1-checksum-canonical-lf-v1-transition',
    secretFree: true,
    containsRepairSql: false,
    liveMutation: false,
    azureMutation: false,
    postgresMutation: false,
    generatedAt: new Date().toISOString(),
    baseMasterSha: BASE_SHA,
    checksumMode: CHECKSUM_MODE_CANONICAL_LF_V1,
    ledgerCompatibility: {
      decision: 'accept_exact_legacySha256_only',
      rationale:
        'Environments that applied migrations under Slice 4 may store Windows CRLF-era working-tree hashes in schema_migration_ledger.checksum_sha256. reconcileLedger accepts only the exact committed legacySha256 for that entry, or the new canonical_lf_v1 sha256. Arbitrary mismatches still fail closed. New ledger inserts always write canonical_lf_v1 (entry.sha256). No live DB was queried.',
      newLedgerWritesUse: CHECKSUM_MODE_CANONICAL_LF_V1,
      liveDbQueried: false,
      liveDbMutated: false,
    },
    totals: {
      manifestEntries: transitionEntries.length,
      forwardEntries: transitionEntries.filter((e) => e.inForwardChain).length,
      eolOnly: transitionEntries.filter((e) => e.differenceWasEolOnly).length,
      executableSqlUnchanged: transitionEntries.filter((e) => e.executableSqlUnchanged).length,
      gitBlobsNormalizedFromCrlfToLf: normalizedFiles.length,
      entriesWithLegacySha256: entriesOut.filter((e) => e.legacySha256).length,
    },
    oldManifestHash,
    newManifestHash,
    oldExpectedManifestHash,
    productFingerprintUnchanged: PRODUCT_FP,
    normalizedGitBlobs: normalizedFiles,
    entries: transitionEntries,
    crossPlatformProofPlan: {
      rawLfCheckout: 'canonical_lf_v1 hash equals manifest.sha256',
      simulatedCrlfCheckout: 'normalize then hash equals same manifest.sha256',
      unknownModeFails: true,
      arbitraryHashFails: true,
      executableSqlByteChangeFails: true,
    },
  };

  fs.writeFileSync(TRANSITION_PATH, `${JSON.stringify(transition, null, 2)}\n`);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        entries: transition.totals.manifestEntries,
        normalizedGitBlobs: normalizedFiles.map((f) => f.filename),
        oldManifestHash,
        newManifestHash,
        productFingerprint: PRODUCT_FP,
        transitionReport: path.relative(ROOT, TRANSITION_PATH).replace(/\\/g, '/'),
      },
      null,
      2,
    )}\n`,
  );
}

main();
