'use strict';

/**
 * Evidence-only canonical-vs-live comparison from already captured observation.
 *
 * Prefers tmp/foundation-slice11/actual-live-state-evidence.json (gitignored).
 * Optionally assembles that file from chunk-capture.txt first.
 * NEVER overwrites fixtures/sunset-schema-observer/expected-product-schema.json.
 * Writes operator-local mismatch copy under tmp/ only; committed audit report is
 * fixtures/sunset-schema-observer/slice11-canonical-vs-live-mismatch-report.json.
 */

const fs = require('fs');
const path = require('path');
const {
  fingerprintProductSchema,
  compareSnapshots,
} = require('./lib/sunset-schema-observer');
const { parseChunks } = require('./capture-sunset-live-schema-observation');

const ROOT = path.join(__dirname, '..');
const CANONICAL = path.join(ROOT, 'fixtures', 'sunset-schema-observer', 'expected-product-schema.json');
const COMMITTED_REPORT = path.join(
  ROOT,
  'fixtures',
  'sunset-schema-observer',
  'slice11-canonical-vs-live-mismatch-report.json',
);
const OUT_DIR = path.join(ROOT, 'tmp', 'foundation-slice11');
const LIVE_OUT = path.join(OUT_DIR, 'actual-live-state-evidence.json');
const MISMATCH_OUT = path.join(OUT_DIR, 'canonical-vs-live-mismatch-report.json');
const CHUNK_SRC = path.join(OUT_DIR, 'chunk-capture.txt');

function fail(msg) {
  console.error(JSON.stringify({ ok: false, error: msg }));
  process.exit(2);
}

function groupDrifts(drifts) {
  const groups = {
    missingExpectedObjects: [],
    unexpectedLiveObjects: [],
    columnsDefaultsNullability: [],
    enums: [],
    indexesConstraints: [],
    functionsDefinitionsSecurityVolatility: [],
    rlsAndPolicies: [],
    ownership: [],
    acls: [],
    extensions: [],
    other: [],
  };
  for (const d of drifts || []) {
    const row = { kind: d.kind, section: d.section, key: d.key };
    if (d.kind === 'expected_only' && ['tables', 'views', 'sequences', 'triggers'].includes(d.section)) {
      groups.missingExpectedObjects.push(row);
    } else if (d.kind === 'live_only' && ['tables', 'views', 'sequences', 'triggers'].includes(d.section)) {
      groups.unexpectedLiveObjects.push(row);
    } else if (d.section === 'columns' || (d.section === 'constraints' && /DEFAULT|NULL/i.test(d.key || ''))) {
      groups.columnsDefaultsNullability.push(row);
    } else if (d.section === 'enums') {
      groups.enums.push(row);
    } else if (d.section === 'indexes' || d.section === 'constraints') {
      groups.indexesConstraints.push(row);
    } else if (d.section === 'functions') {
      groups.functionsDefinitionsSecurityVolatility.push(row);
    } else if (d.section === 'rlsFlags' || d.section === 'rlsPolicies') {
      groups.rlsAndPolicies.push(row);
    } else if (d.section === 'ownership') {
      groups.ownership.push(row);
    } else if (d.section === 'acls') {
      groups.acls.push(row);
    } else if (d.section === 'extensions') {
      groups.extensions.push(row);
    } else {
      groups.other.push(row);
    }
  }
  return groups;
}

function loadLiveSnapshot() {
  if (fs.existsSync(LIVE_OUT)) {
    const liveEvidence = JSON.parse(fs.readFileSync(LIVE_OUT, 'utf8'));
    if (!liveEvidence.notCanonical || liveEvidence.label !== 'actual live state — not canonical') {
      fail('live_evidence_missing_observation_label');
    }
    const liveFp = fingerprintProductSchema(liveEvidence.snapshot);
    if (liveFp !== liveEvidence.productFingerprint) fail('live_fingerprint_mismatch');
    return {
      snapshot: liveEvidence.snapshot,
      productFingerprint: liveFp,
      forwardCount: liveEvidence.forwardCount,
      manifestHash: liveEvidence.manifestHash,
      source: 'actual-live-state-evidence.json',
    };
  }
  if (!fs.existsSync(CHUNK_SRC)) fail('live_evidence_or_chunk_capture_missing');
  const parsed = parseChunks(fs.readFileSync(CHUNK_SRC, 'utf8'));
  if (!parsed.ok || !parsed.payload || !parsed.payload.contract) fail('live_chunks_incomplete');
  const liveContract = parsed.payload.contract;
  const liveFp = fingerprintProductSchema(liveContract.snapshot);
  if (liveFp !== liveContract.productFingerprint) fail('live_fingerprint_mismatch');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const liveEvidence = {
    kind: 'sunset-schema-observer-actual-live-state-evidence',
    label: 'actual live state — not canonical',
    notCanonical: true,
    mustNotOverwriteExpectedFixture: true,
    generatedAt: new Date().toISOString(),
    sourceCapture: 'chunk-capture.txt (prior secret-safe live dump; observation only)',
    productFingerprint: liveFp,
    forwardCount: liveContract.forwardCount,
    manifestHash: liveContract.manifestHash,
    snapshot: liveContract.snapshot,
  };
  if (LIVE_OUT.replace(/\\/g, '/').includes('/fixtures/')) fail('refused_fixtures_path');
  fs.writeFileSync(LIVE_OUT, `${JSON.stringify(liveEvidence, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(LIVE_OUT, 0o600); } catch (_) { /* windows */ }
  return {
    snapshot: liveContract.snapshot,
    productFingerprint: liveFp,
    forwardCount: liveContract.forwardCount,
    manifestHash: liveContract.manifestHash,
    source: 'chunk-capture.txt',
  };
}

function main() {
  if (!fs.existsSync(CANONICAL)) fail('canonical_fixture_missing');

  const canonical = JSON.parse(fs.readFileSync(CANONICAL, 'utf8'));
  if (canonical.source === 'live-sunset-staging-observer-catalog'
    || canonical.source === 'live-observation-only') {
    fail('canonical_fixture_still_live_derived');
  }
  const canonicalFp = fingerprintProductSchema(canonical.snapshot);
  if (canonicalFp !== canonical.productFingerprint) fail('canonical_fingerprint_mismatch');

  const live = loadLiveSnapshot();
  const cmp = compareSnapshots(canonical.snapshot, live.snapshot);
  const groups = groupDrifts(cmp.drifts);
  const mismatches = (cmp.drifts || []).map((d) => ({ kind: d.kind, section: d.section, key: d.key }));
  const mismatchCount = cmp.counts.expected_only + cmp.counts.live_only + cmp.counts.definition_mismatch;
  const groupCounts = Object.fromEntries(
    Object.entries(groups).map(([k, v]) => [k, v.length]),
  );
  const cmt = {
    missingFromLiveTables: (canonical.snapshot.tables || []).includes('customer_message_templates')
      && !(live.snapshot.tables || []).includes('customer_message_templates'),
    missingMismatchKeys: mismatches.filter((d) => String(d.key || '').includes('customer_message_templates')),
  };

  const report = {
    kind: 'sunset-schema-observer-canonical-vs-live-mismatch-report',
    label: 'observation only — live drift is a failure, not a fixture refresh',
    secretFree: true,
    containsProductRowValues: false,
    generatedAt: new Date().toISOString(),
    canonicalExpectedFingerprint: canonical.productFingerprint,
    actualLiveFingerprint: live.productFingerprint,
    fingerprintsEqual: canonical.productFingerprint === live.productFingerprint,
    match: cmp.ok && canonical.productFingerprint === live.productFingerprint,
    observerExitIfRun: (cmp.ok && canonical.productFingerprint === live.productFingerprint) ? 0 : 4,
    counts: cmp.counts,
    mismatchCount,
    groupCounts,
    groups,
    mismatches,
    migrationLedgerVersusCanonicalForwardChain: {
      schema_migration_ledger_present_live: false,
      canonicalForwardCount: 36,
      recordedAppliedSet: 'unknown — schema_migration_ledger absent on sunset_staging',
      note: 'Cannot reconcile live applied migrations to the canonical forward chain without a ledger.',
    },
    customer_message_templates: {
      canonicalMigration: 'database/migrations/035_customer_message_templates.sql',
      presentInCanonicalExpected: true,
      presentLive: !cmt.missingFromLiveTables,
      missingMismatchKeys: cmt.missingMismatchKeys,
    },
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(MISMATCH_OUT, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    ok: true,
    canonicalExpectedFingerprint: report.canonicalExpectedFingerprint,
    actualLiveFingerprint: report.actualLiveFingerprint,
    mismatchCount,
    counts: cmp.counts,
    observerExitIfRun: report.observerExitIfRun,
    liveEvidencePath: path.relative(ROOT, LIVE_OUT).replace(/\\/g, '/'),
    mismatchReportPath: path.relative(ROOT, MISMATCH_OUT).replace(/\\/g, '/'),
    committedAuditReportPath: path.relative(ROOT, COMMITTED_REPORT).replace(/\\/g, '/'),
    cmtMissingLive: cmt.missingFromLiveTables,
    note: 'Does not mutate Azure/Postgres; does not overwrite canonical fixture.',
  }, null, 2));
}

main();
