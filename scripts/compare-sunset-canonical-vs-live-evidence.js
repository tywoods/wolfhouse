'use strict';

/**
 * Evidence-only: assemble a previously captured live catalog snapshot from
 * chunked Log Analytics text. Writes ONLY under gitignored tmp/.
 * NEVER overwrites fixtures/sunset-schema-observer/expected-product-schema.json.
 * Label: actual live state — not canonical.
 */

const fs = require('fs');
const path = require('path');
const {
  fingerprintProductSchema,
  compareSnapshots,
} = require('./lib/sunset-schema-observer');

const ROOT = path.join(__dirname, '..');
const CANONICAL = path.join(ROOT, 'fixtures', 'sunset-schema-observer', 'expected-product-schema.json');
const OUT_DIR = path.join(ROOT, 'tmp', 'foundation-slice11');
const LIVE_OUT = path.join(OUT_DIR, 'actual-live-state-evidence.json');
const MISMATCH_OUT = path.join(OUT_DIR, 'canonical-vs-live-mismatch-report.json');
const CHUNK_SRC = path.join(OUT_DIR, 'chunk-capture.txt');

function fail(msg) {
  console.error(JSON.stringify({ ok: false, error: msg }));
  process.exit(2);
}

function parseChunks(text) {
  const lines = String(text || '').split(/\r?\n/);
  let expected = null;
  const parts = [];
  let done = false;
  for (const line of lines) {
    const mChunks = line.match(/^WH_LIVE_CONTRACT_CHUNKS\s+(\d+)\s*$/);
    if (mChunks) {
      expected = Number(mChunks[1]);
      continue;
    }
    const mPart = line.match(/^WH_LIVE_CONTRACT_PART\s+(\d+)\/(\d+)\s+([A-Za-z0-9+/=]+)\s*$/);
    if (mPart) {
      parts.push({ i: Number(mPart[1]), n: Number(mPart[2]), b64: mPart[3] });
      continue;
    }
    if (line.trim() === 'WH_LIVE_CONTRACT_DONE') done = true;
  }
  if (!done || !expected || parts.length !== expected) {
    return { ok: false, expected, got: parts.length, done };
  }
  parts.sort((a, b) => a.i - b.i);
  const json = Buffer.from(parts.map((p) => p.b64).join(''), 'base64').toString('utf8');
  return { ok: true, payload: JSON.parse(json) };
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

function main() {
  if (!fs.existsSync(CANONICAL)) fail('canonical_fixture_missing');
  if (!fs.existsSync(CHUNK_SRC)) fail('chunk_capture_missing');

  const canonical = JSON.parse(fs.readFileSync(CANONICAL, 'utf8'));
  if (canonical.source === 'live-sunset-staging-observer-catalog') {
    fail('canonical_fixture_still_live_derived');
  }
  const canonicalFp = fingerprintProductSchema(canonical.snapshot);
  if (canonicalFp !== canonical.productFingerprint) fail('canonical_fingerprint_mismatch');

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
  fs.writeFileSync(LIVE_OUT, `${JSON.stringify(liveEvidence, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(LIVE_OUT, 0o600); } catch (_) { /* windows */ }

  // Refuse to write under fixtures/
  if (LIVE_OUT.replace(/\\/g, '/').includes('/fixtures/')) fail('refused_fixtures_path');

  const cmp = compareSnapshots(canonical.snapshot, liveContract.snapshot);
  const groups = groupDrifts(cmp.drifts);
  const mismatchCount = cmp.counts.expected_only + cmp.counts.live_only + cmp.counts.definition_mismatch;
  const cmt = {
    missingFromLiveTables: (canonical.snapshot.tables || []).includes('customer_message_templates')
      && !(liveContract.snapshot.tables || []).includes('customer_message_templates'),
    expectedColumns: (cmp.drifts || []).filter((d) => String(d.key || '').startsWith('customer_message_templates')),
  };

  const report = {
    kind: 'sunset-schema-observer-canonical-vs-live-mismatch-report',
    label: 'observation only — live drift is a failure, not a fixture refresh',
    generatedAt: new Date().toISOString(),
    canonicalExpectedFingerprint: canonical.productFingerprint,
    actualLiveFingerprint: liveFp,
    fingerprintsEqual: canonical.productFingerprint === liveFp,
    match: cmp.ok && canonical.productFingerprint === liveFp,
    observerExitIfRun: (cmp.ok && canonical.productFingerprint === liveFp) ? 0 : 4,
    counts: cmp.counts,
    mismatchCount,
    groups,
    customer_message_templates: cmt,
    sample: (cmp.drifts || []).slice(0, 80),
    allDrifts: cmp.drifts,
  };
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
    cmtMissingLive: cmt.missingFromLiveTables,
  }, null, 2));
}

main();
