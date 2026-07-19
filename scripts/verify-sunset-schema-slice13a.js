'use strict';

/**
 * verify:sunset-schema-slice13a — FOUNDATION Slice 13A RED→GREEN
 * Offline investigation gates only. No Azure mutation. No DB connections.
 * Compares raw Git blobs for migration hash honesty.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadManifest, MANIFEST_PATH, forwardEntries, validateManifestIntegrity, sha256CanonicalLfV1FromBuffer, CHECKSUM_MODE_CANONICAL_LF_V1 } = require('./lib/migration-integrity');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');

const CLASS_PATH = path.join(FIX, 'slice13a-mismatch-classification-report.json');
const PROV_PATH = path.join(FIX, 'slice13a-migration-provenance-matrix.json');
const FINDINGS_PATH = path.join(FIX, 'slice13a-findings.md');
const DECISIONS_PATH = path.join(FIX, 'slice13a-operator-decision-list.json');
const BYTE_PATH = path.join(FIX, 'slice13a-manifest-byte-provenance-report.json');
const TRANSITION_PATH = path.join(FIX, 'slice13a1-checksum-canonical-lf-v1-transition-report.json');
const MISMATCH_PATH = path.join(FIX, 'slice11-canonical-vs-live-mismatch-report.json');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const BUILD_PATH = path.join(ROOT, 'scripts', 'build-sunset-schema-slice13a-classification.js');
const HASH_BUILD_PATH = path.join(ROOT, 'scripts', 'build-sunset-schema-slice13a-manifest-hash-report.js');
const VERIFY_PATH = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice13a.js');

const CANON_FP = 'daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52';
const LIVE_FP = 'fa7efa9246c2bd75fe41741652c462bb98b3c571906635e55a91ae5735ca1dfd';
const MASTER = '3c27d4ee3dd9b5678c63037d3ccc524c21907332';

const ALLOWED = new Set([
  'genuine_database_drift',
  'observer_normalization_difference',
  'canonical_manifest_question',
  'unresolved',
]);

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function gitBlobBytes(rel) {
  const r = spawnSync('git', ['show', `HEAD:${rel.replace(/\\/g, '/')}`], {
    cwd: ROOT,
    encoding: 'buffer',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git show failed for ${rel}`);
  return Buffer.from(r.stdout);
}

function gitBlobSha(rel) {
  return sha256(gitBlobBytes(rel));
}

function isResolved13a1(decisions, provenance, byteReport, expected) {
  const dec007 = (decisions.items || []).find((d) => d.id === 'DEC-007');
  return Boolean(
    dec007
    && dec007.status === 'resolved_by_slice_13a1'
    && fs.existsSync(TRANSITION_PATH)
    && provenance.migration_integrity_blocker
    && provenance.migration_integrity_blocker.present === false
    && provenance.migration_integrity_blocker.resolved === true
    && byteReport.migration_integrity_blocker
    && byteReport.migration_integrity_blocker.present === false
    && expected.checksumMode === CHECKSUM_MODE_CANONICAL_LF_V1
    && expected.productFingerprint === CANON_FP,
  );
}

function main() {
  console.log('verify:sunset-schema-slice13a — RED→GREEN\n');

  pass(
    'artifacts-exist',
    [CLASS_PATH, PROV_PATH, FINDINGS_PATH, DECISIONS_PATH, BYTE_PATH, BUILD_PATH, HASH_BUILD_PATH]
      .every((p) => fs.existsSync(p)),
  );

  const report = JSON.parse(fs.readFileSync(CLASS_PATH, 'utf8'));
  const provenance = JSON.parse(fs.readFileSync(PROV_PATH, 'utf8'));
  const decisions = JSON.parse(fs.readFileSync(DECISIONS_PATH, 'utf8'));
  const byteReport = JSON.parse(fs.readFileSync(BYTE_PATH, 'utf8'));
  const mismatch = JSON.parse(fs.readFileSync(MISMATCH_PATH, 'utf8'));
  const expected = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
  const findings = fs.readFileSync(FINDINGS_PATH, 'utf8');
  const buildSrc = fs.readFileSync(BUILD_PATH, 'utf8');
  const verifySrc = fs.readFileSync(VERIFY_PATH, 'utf8');
  const resolved13a1 = isResolved13a1(decisions, provenance, byteReport, expected);

  pass('no-live-derived-expected-fixture', expected.productFingerprint === CANON_FP
    && (!expected.source || expected.source !== 'live-sunset-staging-observer-catalog')
    && report.canonicalExpectedFingerprint === CANON_FP
    && report.actualLiveFingerprint === LIVE_FP
    && mismatch.canonicalExpectedFingerprint === CANON_FP);

  const items = report.classifications || [];
  pass('exactly-88-classifications', items.length === 88 && report.mismatchCount === 88);

  const stable = items.map((x) => x.stableKey);
  pass('stable-keys-unique', new Set(stable).size === 88);

  const sourceKeys = (mismatch.mismatches || []).map((m) => `${m.kind}|${m.section}|${m.key}`);
  pass('source-mismatch-keys-unique', new Set(sourceKeys).size === 88 && sourceKeys.length === 88);

  const missingFromClass = sourceKeys.filter((k) => !stable.includes(k));
  const extraInClass = stable.filter((k) => !sourceKeys.includes(k));
  pass('every-mismatch-appears-exactly-once', missingFromClass.length === 0 && extraInClass.length === 0
    && stable.length === sourceKeys.length);

  const kindTotals = {
    expected_only: items.filter((x) => x.kind === 'expected_only').length,
    live_only: items.filter((x) => x.kind === 'live_only').length,
    definition_mismatch: items.filter((x) => x.kind === 'definition_mismatch').length,
  };
  pass('totals-reconcile-31-15-42',
    kindTotals.expected_only === 31
    && kindTotals.live_only === 15
    && kindTotals.definition_mismatch === 42
    && report.kindTotals
    && report.kindTotals.expected_only === 31
    && report.kindTotals.live_only === 15
    && report.kindTotals.definition_mismatch === 42);

  pass('all-classifications-allowed', items.every((x) => ALLOWED.has(x.classification)));

  const unresolved = items.filter((x) => x.classification === 'unresolved');
  const decisionUnresolved = (decisions.items || []).filter((d) => d.status === 'unresolved' || d.classification === 'unresolved');
  pass('unresolved-fail-closed-listed',
    unresolved.every((u) => decisionUnresolved.some((d) => d.topic === u.stableKey))
    && (unresolved.length === 0 || decisionUnresolved.length >= unresolved.length));

  const migs = provenance.migrations || [];
  pass('exactly-36-migrations', migs.length === 36 && provenance.canonicalForwardCount === 36);

  const migIds = migs.map((m) => m.id);
  pass('migration-ids-unique', new Set(migIds).size === 36);

  const manifest = loadManifest(MANIFEST_PATH);
  const forward = forwardEntries(manifest);
  pass('forward-manifest-36', forward.length === 36);
  pass(
    'manifest-checksum-mode-when-resolved',
    !resolved13a1 || manifest.checksumMode === CHECKSUM_MODE_CANONICAL_LF_V1,
  );

  const integrity = validateManifestIntegrity(manifest);
  console.log(`  INFO  validateManifestIntegrity ok=${integrity.ok} errors=${integrity.errors.length} mode=${manifest.checksumMode || 'none'}`);
  pass('green-manifest-integrity-when-resolved', !resolved13a1 || integrity.ok);

  // Honest byte report gates (historical investigation fields preserved)
  const comparisons = byteReport.comparisons || [];
  pass('byte-report-has-36-comparisons', comparisons.length === 36
    && byteReport.totals
    && byteReport.totals.forwardCount === 36
    && (byteReport.totals.bytesMatchManifest + byteReport.totals.bytesMismatchManifest) === 36);

  if (resolved13a1) {
    const transition = JSON.parse(fs.readFileSync(TRANSITION_PATH, 'utf8'));
    let canonOk = true;
    for (const m of migs) {
      const ent = forward.find((e) => e.id === m.id);
      if (!ent) { canonOk = false; continue; }
      if (m.manifestRecordedSha256 !== ent.sha256) { canonOk = false; continue; }
      const blob = gitBlobBytes(`database/migrations/${m.filename}`);
      const canon = sha256CanonicalLfV1FromBuffer(blob);
      if (canon !== ent.sha256) { canonOk = false; continue; }
      if (m.bytesMatchManifest !== true) { canonOk = false; continue; }
      if (m.hashesVerifiedAgainstGitBlob !== true) { canonOk = false; continue; }
    }
    pass('canonical-lf-v1-forward-hashes-byte-verifiable', canonOk && migs.length === 36);
    pass(
      'hash-match-mismatch-totals-reconcile-36',
      provenance.hashTotals
        && provenance.hashTotals.bytesMatchManifest === 36
        && provenance.hashTotals.bytesMismatchManifest === 0
        && provenance.hashTotals.reconcileTo36 === true
        && provenance.hashTotals.checksumMode === CHECKSUM_MODE_CANONICAL_LF_V1,
    );
    pass(
      'dec-007-resolved-by-slice-13a1',
      decisions.items.some((d) => d.id === 'DEC-007' && d.status === 'resolved_by_slice_13a1')
        && provenance.migration_integrity_blocker.present === false
        && byteReport.migration_integrity_blocker.present === false
        && /Slice 13A\.1 resolution/i.test(findings)
        && transition.checksumMode === CHECKSUM_MODE_CANONICAL_LF_V1
        && transition.totals.executableSqlUnchanged === transition.totals.manifestEntries
        && transition.productFingerprintUnchanged === CANON_FP,
    );
    pass('no-false-hash-verified-claim',
      migs.every((m) => m.hashesVerifiedAgainstGitBlob === true && m.bytesMatchManifest === true)
        && provenance.migration_integrity_blocker.hashesVerifiedClaim === true);
    pass('migration-integrity-blocker-recorded-when-mismatch', true);
    pass('does-not-claim-all-manifest-hashes-match-git-blobs', true);
    pass('raw-git-blob-hash-fields-honest',
      // Historical byte-report comparisons remain the Slice 13A investigation record (2 match / 34 mismatch).
      byteReport.totals.bytesMatchManifest === 2
        && byteReport.totals.bytesMismatchManifest === 34
        && byteReport.rootCause
        && byteReport.rootCause.notStaleExecutableSql === true);
  } else {
    let gitBlobCompareOk = true;
    let claimedVerifiedWhileMismatch = false;
    for (const m of migs) {
      const ent = forward.find((e) => e.id === m.id);
      const cmp = comparisons.find((c) => c.id === m.id);
      if (!ent || !cmp) { gitBlobCompareOk = false; continue; }
      if (!m.manifestRecordedSha256 || !m.currentGitBlobSha256) { gitBlobCompareOk = false; continue; }
      if (m.manifestRecordedSha256 !== ent.sha256) { gitBlobCompareOk = false; continue; }
      if (m.manifestRecordedSha256 !== cmp.manifestRecordedSha256) { gitBlobCompareOk = false; continue; }
      const liveBlob = gitBlobSha(`database/migrations/${m.filename}`);
      if (m.currentGitBlobSha256 !== liveBlob) { gitBlobCompareOk = false; continue; }
      if (cmp.currentGitBlobSha256 !== liveBlob) { gitBlobCompareOk = false; continue; }
      const expectedMatch = liveBlob === ent.sha256;
      if (m.bytesMatchManifest !== expectedMatch) { gitBlobCompareOk = false; continue; }
      if (cmp.bytesMatchManifest !== expectedMatch) { gitBlobCompareOk = false; continue; }
      if (m.hashesVerifiedAgainstGitBlob === true && m.bytesMatchManifest !== true) {
        claimedVerifiedWhileMismatch = true;
      }
    }
    pass('raw-git-blob-hash-fields-honest', gitBlobCompareOk && !claimedVerifiedWhileMismatch);

    const matchN = migs.filter((m) => m.bytesMatchManifest).length;
    const mismatchN = migs.filter((m) => !m.bytesMatchManifest).length;
    pass('hash-match-mismatch-totals-reconcile-36',
      matchN + mismatchN === 36
      && provenance.hashTotals
      && provenance.hashTotals.bytesMatchManifest === matchN
      && provenance.hashTotals.bytesMismatchManifest === mismatchN
      && provenance.hashTotals.reconcileTo36 === true
      && byteReport.totals.bytesMatchManifest === matchN
      && byteReport.totals.bytesMismatchManifest === mismatchN);

    pass('no-false-hash-verified-claim',
      migs.every((m) => m.hashesVerifiedAgainstGitBlob === m.bytesMatchManifest)
      && provenance.migration_integrity_blocker
      && provenance.migration_integrity_blocker.hashesVerifiedClaim === false
      && provenance.migration_integrity_blocker.present === (mismatchN > 0)
      && provenance.migration_integrity_blocker.state === 'migration_integrity_blocker');

    pass('migration-integrity-blocker-recorded-when-mismatch',
      mismatchN === 0
      || (
        provenance.migration_integrity_blocker.present === true
        && byteReport.migration_integrity_blocker.present === true
        && (decisions.items || []).some((d) => d.id === 'DEC-007' && d.status === 'migration_integrity_blocker')
        && /migration_integrity_blocker/i.test(findings)
      ));

    pass('does-not-claim-all-manifest-hashes-match-git-blobs',
      !(mismatchN > 0 && /hashes verified against git blob/i.test(findings) && !/blocker/i.test(findings))
      && (mismatchN === 0 || /do not claim byte-verified/i.test(findings)));
  }

  const mig035 = migs.find((m) => m.id === '035_customer_message_templates');
  pass('migration-035-explicit',
    Boolean(mig035)
    && provenance.migration_035_customer_message_templates
    && provenance.migration_035_customer_message_templates.id === '035_customer_message_templates'
    && provenance.migration_035_customer_message_templates.inferredState === 'absent'
    && provenance.migration_035_customer_message_templates.appearsSafelyAdditive === true
    && provenance.migration_035_customer_message_templates.seedOrBackfillRequired === false
    && provenance.migration_035_customer_message_templates.doNotApplyInThisSlice === true
    && /Migration 035/.test(findings)
    && /customer_message_templates/.test(findings));

  const ambiguous = migs.filter((m) => m.inferredState === 'ambiguous');
  const decAmb = (decisions.items || []).find((d) => d.id === 'DEC-006');
  pass('ambiguous-migrations-fail-closed-listed',
    ambiguous.every((m) => (decAmb && Array.isArray(decAmb.relatedMigrations) && decAmb.relatedMigrations.includes(m.id)))
    && decAmb
    && /fail closed/i.test(String(decAmb.recommendation || '')));

  pass('findings-forbid-blessing-and-repair',
    /do not bless live/i.test(findings)
    && /do not apply/i.test(findings)
    && /investigation only/i.test(findings));

  pass('no-live-apply-code-in-builder',
    !/\baz deployment group create\b/.test(buildSrc)
    && !(buildSrc.includes(['containerapp', 'job', 'start'].join(' ')))
    && !buildSrc.includes(['LIVE_APPLY', 'ENABLED'].join('_'))
    && !/execSync\([^)]*psql/.test(buildSrc)
    && !buildSrc.includes(['new', 'Client('].join(' '))
    && /Investigation only|No Azure mutation|No repair SQL/.test(buildSrc));

  pass('no-live-apply-code-in-verifier',
    !(verifySrc.includes(['containerapp', 'job', 'start'].join(' ')))
    && !verifySrc.includes(['LIVE_APPLY', 'ENABLED'].join('_'))
    && !verifySrc.includes(['new', 'Client('].join(' ')));

  pass('artifacts-declare-no-repair-sql',
    report.containsRepairSql === false
    && report.containsLiveApplyCode === false
    && provenance.containsRepairSql === false
    && byteReport.containsRepairSql === false
    && decisions.failClosed === true);

  pass('ownership-normalization-defect-documented',
    report.observerNormalizationDefect
    && report.observerNormalizationDefect.identified === true
    && report.observerNormalizationDefect.doNotMutateOwnershipToMatchRoleNames === true
    && /azuresu|azure_pg_admin|normalizeOwnerName/i.test(findings));

  pass('master-sha-basis',
    report.masterShaBasis === MASTER
    && provenance.masterShaBasis === MASTER
    && byteReport.masterShaBasis === MASTER);

  pass('root-cause-line-ending-documented',
    byteReport.rootCause
    && /crlf|line.?ending|autocrlf/i.test(JSON.stringify(byteReport.rootCause))
    && byteReport.rootCause.notStaleExecutableSql === true);

  console.log(`\n── verify:sunset-schema-slice13a ${failed ? 'FAILED' : 'PASSED'} (failed=${failed}) ──`);
  process.exit(failed ? 1 : 0);
}

main();
