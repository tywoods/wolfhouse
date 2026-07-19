'use strict';

/**
 * Evidence-only live schema OBSERVATION assembler (not “expected”).
 *
 * Intended input: chunked WH_LIVE_CONTRACT markers produced by the dedicated
 * schema-observer job running scripts/dump-sunset-live-schema-contract.js
 * (observer image + secretRef DSN). This script does NOT exec into Staff API,
 * does NOT upload source to Key Vault, and does NOT connect to PostgreSQL.
 *
 * Output ONLY:
 *   tmp/foundation-slice11/actual-live-state-evidence.json
 * labeled “actual live state — not canonical”.
 *
 * NEVER overwrites fixtures/sunset-schema-observer/expected-product-schema.json.
 */

const fs = require('fs');
const path = require('path');
const { fingerprintProductSchema } = require('./lib/sunset-schema-observer');

const ROOT = path.join(__dirname, '..');
const CANONICAL_FIXTURE = path.join(
  ROOT,
  'fixtures',
  'sunset-schema-observer',
  'expected-product-schema.json',
);
const OUT_DIR = path.join(ROOT, 'tmp', 'foundation-slice11');
const OUT = path.join(OUT_DIR, 'actual-live-state-evidence.json');

function refuseCanonicalOverwrite(candidatePath) {
  const forbidden = path.normalize(CANONICAL_FIXTURE);
  const outNorm = path.normalize(candidatePath || OUT);
  if (outNorm === forbidden) {
    throw Object.assign(new Error('refused_canonical_fixture_overwrite'), {
      code: 'refused_canonical_fixture_overwrite',
    });
  }
  if (/[\\/]fixtures[\\/].*expected-product-schema\.json$/i.test(outNorm)) {
    throw Object.assign(new Error('refused_canonical_fixture_overwrite'), {
      code: 'refused_canonical_fixture_overwrite',
    });
  }
  if (!outNorm.replace(/\\/g, '/').endsWith('/tmp/foundation-slice11/actual-live-state-evidence.json')) {
    throw Object.assign(new Error('observation_output_path_locked'), {
      code: 'observation_output_path_locked',
    });
  }
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

function main() {
  refuseCanonicalOverwrite(OUT);

  const chunkPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(OUT_DIR, 'chunk-capture.txt');
  if (!fs.existsSync(chunkPath)) {
    console.error(JSON.stringify({
      ok: false,
      error: 'chunk_capture_missing',
      hint: 'Provide observer-job WH_LIVE_CONTRACT dump path, or place chunk-capture.txt under tmp/foundation-slice11/. This collector never uses Staff API.',
      path: chunkPath,
    }));
    process.exit(2);
  }

  const parsed = parseChunks(fs.readFileSync(chunkPath, 'utf8'));
  if (!parsed.ok || !parsed.payload || !parsed.payload.contract) {
    console.error(JSON.stringify({ ok: false, error: 'live_chunks_incomplete', detail: parsed }));
    process.exit(2);
  }

  const liveContract = parsed.payload.contract;
  const liveFp = fingerprintProductSchema(liveContract.snapshot);
  if (liveFp !== liveContract.productFingerprint) {
    console.error(JSON.stringify({ ok: false, error: 'live_fingerprint_mismatch' }));
    process.exit(2);
  }

  refuseCanonicalOverwrite(OUT);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const evidence = {
    kind: 'sunset-schema-observer-actual-live-state-evidence',
    label: 'actual live state — not canonical',
    notCanonical: true,
    mustNotOverwriteExpectedFixture: true,
    generatedAt: new Date().toISOString(),
    sourceCapture: 'observer-job dump chunks (observation only; not expected)',
    productFingerprint: liveFp,
    forwardCount: liveContract.forwardCount,
    manifestHash: liveContract.manifestHash,
    snapshot: liveContract.snapshot,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(OUT, 0o600); } catch (_) { /* windows */ }

  console.log(JSON.stringify({
    ok: true,
    path: path.relative(ROOT, OUT).replace(/\\/g, '/'),
    label: evidence.label,
    productFingerprint: evidence.productFingerprint,
    overwroteCanonicalFixture: false,
    usedStaffApi: false,
    usedKeyVaultWorkerUpload: false,
  }, null, 2));
}

module.exports = {
  CANONICAL_FIXTURE,
  OUT,
  refuseCanonicalOverwrite,
  parseChunks,
};

if (require.main === module) {
  main();
}
