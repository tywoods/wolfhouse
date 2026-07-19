'use strict';

/**
 * verify:sunset-schema-slice13a — FOUNDATION Slice 13A RED→GREEN
 * Offline investigation gates only. No Azure mutation. No DB connections.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadManifest, MANIFEST_PATH, forwardEntries } = require('./lib/migration-integrity');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');

const CLASS_PATH = path.join(FIX, 'slice13a-mismatch-classification-report.json');
const PROV_PATH = path.join(FIX, 'slice13a-migration-provenance-matrix.json');
const FINDINGS_PATH = path.join(FIX, 'slice13a-findings.md');
const DECISIONS_PATH = path.join(FIX, 'slice13a-operator-decision-list.json');
const MISMATCH_PATH = path.join(FIX, 'slice11-canonical-vs-live-mismatch-report.json');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const BUILD_PATH = path.join(ROOT, 'scripts', 'build-sunset-schema-slice13a-classification.js');
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

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function main() {
  console.log('verify:sunset-schema-slice13a — RED→GREEN\n');

  pass('artifacts-exist', [CLASS_PATH, PROV_PATH, FINDINGS_PATH, DECISIONS_PATH, BUILD_PATH].every((p) => fs.existsSync(p)));

  const report = JSON.parse(fs.readFileSync(CLASS_PATH, 'utf8'));
  const provenance = JSON.parse(fs.readFileSync(PROV_PATH, 'utf8'));
  const decisions = JSON.parse(fs.readFileSync(DECISIONS_PATH, 'utf8'));
  const mismatch = JSON.parse(fs.readFileSync(MISMATCH_PATH, 'utf8'));
  const expected = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
  const findings = fs.readFileSync(FINDINGS_PATH, 'utf8');
  const buildSrc = fs.readFileSync(BUILD_PATH, 'utf8');
  const verifySrc = fs.readFileSync(VERIFY_PATH, 'utf8');

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

  let hashOk = true;
  for (const m of migs) {
    const ent = forward.find((e) => e.id === m.id);
    if (!ent || ent.sha256 !== m.sha256) { hashOk = false; break; }
    const disk = sha256File(path.join(ROOT, 'database', 'migrations', m.filename));
    if (disk !== m.sha256) { hashOk = false; break; }
  }
  pass('migration-hashes-match-canonical-manifest', hashOk);

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
    && decisions.failClosed === true);

  pass('ownership-normalization-defect-documented',
    report.observerNormalizationDefect
    && report.observerNormalizationDefect.identified === true
    && report.observerNormalizationDefect.doNotMutateOwnershipToMatchRoleNames === true
    && /azuresu|azure_pg_admin|normalizeOwnerName/i.test(findings));

  pass('master-sha-basis',
    report.masterShaBasis === MASTER
    && provenance.masterShaBasis === MASTER);

  console.log(`\n── verify:sunset-schema-slice13a ${failed ? 'FAILED' : 'PASSED'} (failed=${failed}) ──`);
  process.exit(failed ? 1 : 0);
}

main();
