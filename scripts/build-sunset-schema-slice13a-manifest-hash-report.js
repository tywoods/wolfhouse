'use strict';

/**
 * FOUNDATION Slice 13A correction — secret-free migration byte provenance report.
 * Compares canonical-manifest sha256 vs current Git blob / working-tree / LF-normalized.
 * No manifest regeneration. No migration SQL edits. No Azure mutation.
 */

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadManifest, MANIFEST_PATH, forwardEntries } = require('./lib/migration-integrity');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const OUT = path.join(FIX, 'slice13a-manifest-byte-provenance-report.json');
const MANIFEST_COMMIT = 'adf6a71da869a34b2e0cd069f45a38088a214db1';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function toLf(buf) {
  return Buffer.from(Buffer.from(buf).toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
}

function gitShow(spec) {
  const r = spawnSync('git', ['show', spec], {
    cwd: ROOT,
    encoding: 'buffer',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return { ok: false, stderr: String(r.stderr || ''), stdout: null };
  }
  return { ok: true, stdout: Buffer.from(r.stdout) };
}

function gitLog(rel) {
  const r = spawnSync('git', ['log', '--format=%H|%ci|%s', '--', rel], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) return [];
  return String(r.stdout || '')
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, date, ...rest] = line.split('|');
      return { sha, date, subject: rest.join('|') };
    });
}

function main() {
  const manifest = loadManifest(MANIFEST_PATH);
  const forward = forwardEntries(manifest);
  if (forward.length !== 36) throw new Error(`expected 36 forward, got ${forward.length}`);

  const comparisons = [];
  for (const e of forward) {
    const rel = `database/migrations/${e.filename}`;
    const abs = path.join(ROOT, rel);
    const wt = fs.readFileSync(abs);
    const blobRes = gitShow(`HEAD:${rel.replace(/\\/g, '/')}`);
    if (!blobRes.ok) throw new Error(`git show failed for ${rel}: ${blobRes.stderr}`);
    const blob = blobRes.stdout;
    const atManifest = gitShow(`${MANIFEST_COMMIT}:${rel.replace(/\\/g, '/')}`);
    const commits = gitLog(rel);
    const commitsAfterManifest = commits.filter((c) => c.sha !== MANIFEST_COMMIT
      && spawnSync('git', ['merge-base', '--is-ancestor', MANIFEST_COMMIT, c.sha], { cwd: ROOT }).status === 0);

    let identicalGitBlobSinceManifest = null;
    let contentChangedBeyondEolSinceManifest = null;
    if (atManifest.ok) {
      identicalGitBlobSinceManifest = sha256(atManifest.stdout) === sha256(blob);
      contentChangedBeyondEolSinceManifest = sha256(toLf(atManifest.stdout)) !== sha256(toLf(blob));
    } else {
      identicalGitBlobSinceManifest = false;
      contentChangedBeyondEolSinceManifest = 'not_present_at_manifest_commit';
    }

    const manifestRecordedSha256 = e.sha256;
    const currentGitBlobSha256 = sha256(blob);
    const workingTreeSha256 = sha256(wt);
    const normalizedLfGitBlobSha256 = sha256(toLf(blob));
    const normalizedLfWorkingTreeSha256 = sha256(toLf(wt));
    const bytesMatchManifest = currentGitBlobSha256 === manifestRecordedSha256;
    const lineEndingOnlyDiscrepancy = !bytesMatchManifest
      && (
        (sha256(toLf(wt)) === currentGitBlobSha256
          && sha256(Buffer.from(blob.toString('utf8').replace(/\n/g, '\r\n'))) === workingTreeSha256)
        || (normalizedLfGitBlobSha256 === normalizedLfWorkingTreeSha256
          && workingTreeSha256 === manifestRecordedSha256
          && currentGitBlobSha256 !== manifestRecordedSha256)
      );

    comparisons.push({
      id: e.id,
      filename: e.filename,
      order: e.order,
      manifestRecordedSha256,
      currentGitBlobSha256,
      workingTreeSha256,
      normalizedLfGitBlobSha256,
      normalizedLfWorkingTreeSha256,
      bytesMatchManifest,
      workingTreeMatchesManifest: workingTreeSha256 === manifestRecordedSha256,
      gitBlobHasCR: blob.includes(0x0d),
      workingTreeHasCR: wt.includes(0x0d),
      lineEndingOnlyDiscrepancy,
      executableSqlChangedBeyondEolSinceManifest: contentChangedBeyondEolSinceManifest === true,
      identicalGitBlobSinceManifest,
      contentChangedBeyondEolSinceManifest,
      manifestCreatedOrLastUpdatedCommit: MANIFEST_COMMIT,
      lastMigrationTouchCommit: commits[0] || null,
      commitsAfterManifestTouchingFile: commitsAfterManifest,
    });
  }

  const matching = comparisons.filter((c) => c.bytesMatchManifest);
  const mismatching = comparisons.filter((c) => !c.bytesMatchManifest);
  if (matching.length + mismatching.length !== 36) {
    throw new Error('totals do not reconcile to 36');
  }

  const allMismatchLineEndingOnly = mismatching.every((c) => c.lineEndingOnlyDiscrepancy);
  const anyExecutableSqlChanged = comparisons.some((c) => c.executableSqlChangedBeyondEolSinceManifest === true);

  const report = {
    kind: 'sunset-schema-observer-slice13a-manifest-byte-provenance-report',
    label: 'investigation correction — do not regenerate manifest from this report without a dedicated integrity repair slice',
    secretFree: true,
    containsRepairSql: false,
    generatedAt: new Date().toISOString(),
    masterShaBasis: '3c27d4ee3dd9b5678c63037d3ccc524c21907332',
    correctionOf: 'a322e5dda3ad57e3baf4795720a877b743fdbd53',
    canonicalManifestPath: 'database/migrations/canonical-manifest.json',
    manifestCreatedCommit: {
      sha: MANIFEST_COMMIT,
      subject: 'Add canonical migration manifest and fresh-DB proof (FOUNDATION Slice 4).',
      date: '2026-07-17 15:48:03 +0200',
    },
    rootCause: {
      code: 'manifest_hashed_crlf_working_tree_not_git_blob',
      deterministic: true,
      summary:
        'canonical-manifest.json sha256 values were recorded from Windows working-tree bytes under core.autocrlf=true (CRLF). Git blobs for 34/36 forward migrations are LF-normalized. validateManifestIntegrity hashes working-tree files, so it can pass on Windows autocrlf checkouts while raw git-blob comparison fails.',
      notStaleExecutableSql: !anyExecutableSqlChanged,
      lineEndingNormalization: true,
      migrationsModifiedAfterManifestBeyondEol: anyExecutableSqlChanged,
      staleManifestExecutableContent: false,
    },
    totals: {
      forwardCount: 36,
      bytesMatchManifest: matching.length,
      bytesMismatchManifest: mismatching.length,
      lineEndingOnlyMismatches: mismatching.filter((c) => c.lineEndingOnlyDiscrepancy).length,
      gitBlobStoredWithCR: comparisons.filter((c) => c.gitBlobHasCR).length,
      executableSqlChangedBeyondEolSinceManifest: comparisons.filter((c) => c.executableSqlChangedBeyondEolSinceManifest === true).length,
    },
    migration_integrity_blocker: {
      present: mismatching.length > 0,
      code: 'canonical_manifest_sha256_not_equal_current_git_blob',
      reason:
        'Raw Git blob sha256 differs from manifest-recorded sha256 for one or more forward migrations. Byte-verified migration provenance is blocked until a dedicated manifest-integrity repair rewrites hashes from committed blobs (or pins eol=lf) without changing executable SQL intent.',
      doNotClaimHashesVerified: true,
      doNotInferReliableHistoricalApplicationFromByteManifest: true,
      existingValidateManifestIntegrityNote:
        'scripts/verify-migration-integrity.js → validateManifestIntegrity hashes working-tree files via sha256File(disk). On this Windows autocrlf checkout it returned ok=true (working-tree CRLF matches CRLF-recorded manifest). That pass does not prove git-blob equality.',
    },
    matchingIds: matching.map((c) => c.id),
    mismatchingIds: mismatching.map((c) => c.id),
    comparisons,
  };

  if (!allMismatchLineEndingOnly && mismatching.length) {
    report.rootCause.code = 'manifest_git_blob_mismatch_not_solely_line_endings';
    report.rootCause.deterministic = true;
  }

  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    out: path.relative(ROOT, OUT).replace(/\\/g, '/'),
    totals: report.totals,
    rootCause: report.rootCause.code,
    blocker: report.migration_integrity_blocker.present,
  }, null, 2));
}

main();
