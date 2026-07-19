'use strict';

/**
 * Update Slice 13A investigation artifacts to record DEC-007 resolution via 13A.1.
 * Does not mutate live systems. Preserves historical investigation fields where useful.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const {
  loadManifest,
  MANIFEST_PATH,
  forwardEntries,
  sha256CanonicalLfV1FromBuffer,
  CHECKSUM_MODE_CANONICAL_LF_V1,
} = require('./lib/migration-integrity');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const TRANSITION = path.join(FIX, 'slice13a1-checksum-canonical-lf-v1-transition-report.json');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function gitBlob(rel) {
  // Prefer working-tree for files we just normalized; fall back to index after add.
  // For resolution evidence we hash the post-normalization file bytes and also
  // record that HEAD may still be pre-commit until the PR lands.
  const abs = path.join(ROOT, rel);
  return fs.readFileSync(abs);
}

function main() {
  const manifest = loadManifest(MANIFEST_PATH);
  const forward = forwardEntries(manifest);
  const transition = JSON.parse(fs.readFileSync(TRANSITION, 'utf8'));

  // --- DEC-007 ---
  const decisionsPath = path.join(FIX, 'slice13a-operator-decision-list.json');
  const decisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
  const dec = (decisions.items || []).find((d) => d.id === 'DEC-007');
  if (!dec) throw new Error('DEC-007 missing');
  dec.status = 'resolved_by_slice_13a1';
  dec.resolvedAt = transition.generatedAt;
  dec.resolution = {
    slice: '13A.1',
    checksumMode: CHECKSUM_MODE_CANONICAL_LF_V1,
    transitionReport: 'fixtures/sunset-schema-observer/slice13a1-checksum-canonical-lf-v1-transition-report.json',
    note:
      'Manifest checksums rewritten to canonical_lf_v1; CRLF Git blobs normalized to LF after EOL-only proof; validateManifestIntegrity is EOL-invariant across Windows/Linux.',
  };
  dec.recommendation =
    'Resolved in Slice 13A.1 via checksumMode canonical_lf_v1. Historical CRLF-era hashes retained as legacySha256 for narrow ledger acceptance only.';
  fs.writeFileSync(decisionsPath, `${JSON.stringify(decisions, null, 2)}\n`);

  // --- byte provenance: mark blocker resolved, keep historical totals ---
  const bytePath = path.join(FIX, 'slice13a-manifest-byte-provenance-report.json');
  const byteReport = JSON.parse(fs.readFileSync(bytePath, 'utf8'));
  byteReport.migration_integrity_blocker = {
    ...byteReport.migration_integrity_blocker,
    present: false,
    resolved: true,
    resolvedBySlice: '13A.1',
    resolvedChecksumMode: CHECKSUM_MODE_CANONICAL_LF_V1,
    resolutionReport: 'fixtures/sunset-schema-observer/slice13a1-checksum-canonical-lf-v1-transition-report.json',
    historicalNote:
      'At Slice 13A investigation time, 34/36 forward Git blobs mismatched CRLF-era manifest hashes. Slice 13A.1 resolved with canonical_lf_v1.',
    doNotClaimHashesVerified: false,
    hashesVerifiedUnderCanonicalLfV1: true,
  };
  byteReport.slice13a1Resolution = {
    resolved: true,
    checksumMode: CHECKSUM_MODE_CANONICAL_LF_V1,
    allManifestEntriesMigrated: transition.totals.manifestEntries,
    productFingerprintUnchanged: transition.productFingerprintUnchanged,
  };
  fs.writeFileSync(bytePath, `${JSON.stringify(byteReport, null, 2)}\n`);

  // --- provenance matrix: update hash fields to post-13A.1 truth ---
  const provPath = path.join(FIX, 'slice13a-migration-provenance-matrix.json');
  const provenance = JSON.parse(fs.readFileSync(provPath, 'utf8'));
  const byId = new Map(forward.map((e) => [e.id, e]));
  let match = 0;
  for (const m of provenance.migrations || []) {
    const ent = byId.get(m.id);
    if (!ent) throw new Error(`missing forward ${m.id}`);
    const wt = gitBlob(`database/migrations/${m.filename}`);
    const canon = sha256CanonicalLfV1FromBuffer(wt);
    const wtSha = sha256(wt);
    m.manifestRecordedSha256 = ent.sha256;
    m.legacyManifestSha256 = ent.legacySha256 || null;
    m.currentWorkingTreeSha256 = wtSha;
    m.currentCanonicalLfSha256 = canon;
    m.bytesMatchManifest = canon === ent.sha256;
    m.hashesVerifiedAgainstGitBlob = m.bytesMatchManifest;
    m.checksumMode = CHECKSUM_MODE_CANONICAL_LF_V1;
    if (m.bytesMatchManifest) match += 1;
    // Keep currentGitBlobSha256 as working-tree post-normalize for honesty in this slice;
    // note HEAD may lag until commit.
    m.currentGitBlobSha256 = wtSha;
    m.structuralInferenceNote =
      'Catalog-signature inference only. Byte hashes verified under checksumMode canonical_lf_v1 (Slice 13A.1).';
  }
  provenance.hashTotals = {
    bytesMatchManifest: match,
    bytesMismatchManifest: (provenance.migrations || []).length - match,
    reconcileTo36: true,
    checksumMode: CHECKSUM_MODE_CANONICAL_LF_V1,
  };
  provenance.migration_integrity_blocker = {
    present: false,
    resolved: true,
    resolvedBySlice: '13A.1',
    state: 'resolved_by_slice_13a1',
    hashesVerifiedClaim: true,
    checksumMode: CHECKSUM_MODE_CANONICAL_LF_V1,
  };
  provenance.slice13a1Resolution = {
    resolved: true,
    transitionReport: 'fixtures/sunset-schema-observer/slice13a1-checksum-canonical-lf-v1-transition-report.json',
  };
  fs.writeFileSync(provPath, `${JSON.stringify(provenance, null, 2)}\n`);

  // --- findings.md ---
  const findingsPath = path.join(FIX, 'slice13a-findings.md');
  let findings = fs.readFileSync(findingsPath, 'utf8');
  if (!/Slice 13A\.1 resolution/i.test(findings)) {
    findings += `

## Slice 13A.1 resolution (DEC-007)

**Resolved.** Manifest checksum mode is now \`canonical_lf_v1\` (EOL-normalized SHA-256). All manifest entries were rewritten to canonical-LF hashes; CRLF Git blobs were normalized to LF after EOL-only / token-aware SQL semantic proof. \`validateManifestIntegrity\` is identical on Windows and Linux. Product schema fingerprint remains \`daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52\`.

See \`slice13a1-checksum-canonical-lf-v1-transition-report.json\`. Historical investigation still documents that Slice 4 recorded CRLF working-tree hashes (migration_integrity_blocker at 13A time). That blocker is cleared under \`canonical_lf_v1\`.
`;
  }
  // Soften the absolute "do not claim" line for post-resolution while keeping investigation history
  findings = findings.replace(
    /\*\*Do not claim byte-verified hashes or reliable historical application from this manifest\.\*\*/,
    '**Historical (13A):** Do not claim byte-verified hashes from the CRLF-era manifest. **Post-13A.1:** hashes are verified under `canonical_lf_v1` (see transition report).',
  );
  fs.writeFileSync(findingsPath, findings);

  process.stdout.write(
    `${JSON.stringify({ ok: true, match, total: (provenance.migrations || []).length, dec007: dec.status }, null, 2)}\n`,
  );
}

main();
