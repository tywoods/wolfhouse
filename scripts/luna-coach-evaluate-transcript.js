'use strict';

/**
 * Luna coach — evaluate a transcript and optionally emit a fixture skeleton.
 *
 * Usage:
 *   node scripts/luna-coach-evaluate-transcript.js --file path/to/transcript.json
 *   node scripts/luna-coach-evaluate-transcript.js --seed package-choice-assumed
 *   node scripts/luna-coach-evaluate-transcript.js --file bad.json --emit-fixture fixtures/luna-golden/coach-new.json
 */

const fs = require('fs');
const path = require('path');

const { evaluateLunaGuestTranscript } = require('./lib/luna-guest-coach-evaluator');
const { buildRegressionFixtureSkeleton } = require('./lib/luna-guest-regression-fixture-builder');

const SEEDS_DIR = path.join(__dirname, 'fixtures', 'coach-seeds');

function usage() {
  console.log(`
Usage:
  node scripts/luna-coach-evaluate-transcript.js --file <transcript.json>
  node scripts/luna-coach-evaluate-transcript.js --seed <seed-name>
  node scripts/luna-coach-evaluate-transcript.js --file <path> --emit-fixture <out.json>

Transcript JSON:
  {
    "id": "optional",
    "label": "optional",
    "reference_date": "2026-06-10",
    "transcript": [
      { "guest": "hello", "luna": "Hey! I'm Luna..." },
      { "guest": "book stay", "luna": "..." }
    ],
    "booking_state": { "extracted_fields": { ... } },
    "stage_flags": { "handoff_expected": false }
  }
`);
}

function parseArgs(argv) {
  const opts = { file: null, seed: null, emitFixture: null, json: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') opts.file = argv[++i];
    else if (a === '--seed') opts.seed = argv[++i];
    else if (a === '--emit-fixture') opts.emitFixture = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function loadInput(opts) {
  if (opts.seed) {
    const p = path.join(SEEDS_DIR, `${opts.seed}.json`);
    if (!fs.existsSync(p)) throw new Error(`seed not found: ${p}`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  if (opts.file) {
    const p = path.resolve(opts.file);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error('Provide --file or --seed');
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }

  const input = loadInput(opts);
  const report = evaluateLunaGuestTranscript(input);
  const fixture = buildRegressionFixtureSkeleton({
    transcript: input.transcript,
    coach_report: report,
    id: input.id,
    label: input.label,
    reference_date: input.reference_date,
  });

  const out = {
    coach_report: report,
    fixture_suggestion: fixture,
  };

  if (opts.emitFixture) {
    const outPath = path.resolve(opts.emitFixture);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
    out.fixture_written = outPath;
  }

  console.log(JSON.stringify(out, null, 2));

  if (report.shipping_blocker) process.exit(2);
  if (report.overall_score < 70) process.exit(1);
  process.exit(0);
}

main();
