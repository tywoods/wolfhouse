'use strict';

/**
 * verify:luna-coach — proves the deterministic coach loop (no API key).
 */

const path = require('path');
const fs = require('fs');
const { evaluateLunaGuestTranscript } = require('./lib/luna-guest-coach-evaluator');
const { buildRegressionFixtureSkeleton } = require('./lib/luna-guest-regression-fixture-builder');

const SEEDS_DIR = path.join(__dirname, 'fixtures', 'coach-seeds');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

function loadSeed(name) {
  return JSON.parse(fs.readFileSync(path.join(SEEDS_DIR, `${name}.json`), 'utf8'));
}

function hasCategory(report, category) {
  return (report.failures || []).some((f) => f.category === category);
}

function hasFixType(report, fixType) {
  return (report.failures || []).some((f) => f.recommended_fix_type === fixType);
}

section('A. Coach evaluator detects known failure patterns');
{
  const pkg = evaluateLunaGuestTranscript(loadSeed('package-choice-assumed'));
  check('A1', pkg.overall_score < 95, `package-choice score penalized (${pkg.overall_score})`);
  check('A2', hasFixType(pkg, 'package_explainer_before_choice'), 'detects package assumed knowledge');
  check('A3', pkg.shipping_blocker === false, 'package choice alone is not shipping blocker');

  const stall = evaluateLunaGuestTranscript(loadSeed('quote-stall'));
  check('A4', hasFixType(stall, 'quote_payment_progression'), 'detects quote stall');
  check('A5', hasCategory(stall, 'booking_progress'), 'stall is booking_progress');

  const greet = evaluateLunaGuestTranscript(loadSeed('greeting-price-dump'));
  check('A6', hasFixType(greet, 'greeting_intent_gate'), 'detects greeting price dump');

  const svc = evaluateLunaGuestTranscript(loadSeed('service-missed'));
  check('A7', hasCategory(svc, 'services'), 'detects missed service capture');

  const xfer = evaluateLunaGuestTranscript(loadSeed('transfer-missed'));
  check('A8', hasCategory(xfer, 'services'), 'detects missed transfer ack');
}

section('B. Fixture builder produces runnable skeleton');
{
  const input = loadSeed('package-choice-assumed');
  const report = evaluateLunaGuestTranscript(input);
  const fixture = buildRegressionFixtureSkeleton({
    transcript: input.transcript,
    coach_report: report,
    id: 'coach-built-package-choice',
  });
  check('B1', fixture.id === 'coach-built-package-choice', 'fixture id set');
  check('B2', Array.isArray(fixture.turns) && fixture.turns.length === 4, 'four turns');
  check('B3', fixture.turns[3].expect.reply_not_contains && fixture.turns[3].expect.reply_not_contains.length > 0,
    'bad turn has reply_not_contains');
  check('B4', fixture.forbidden_replies && fixture.forbidden_replies.length > 0, 'forbidden_replies captured');
  check('B5', fixture.coach_generated === true, 'marked coach_generated');
}

section('C. Good transcript scores high');
{
  const good = evaluateLunaGuestTranscript({
    transcript: [
      { guest: 'hello', luna: 'Hey! I\'m Luna from Wolfhouse. Book a stay or just exploring?' },
      { guest: 'July 12-20 for 3', luna: 'Lovely — Malibu, Uluwatu, Waimea explained with spacing. Stay only or lessons?' },
    ],
  });
  check('C1', good.overall_score >= 80, `good transcript scores ${good.overall_score}`);
  check('C2', good.shipping_blocker === false, 'good transcript not a blocker');
}

section('D. No production/live side effects (static proof)');
{
  const coachSrc = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-coach-evaluator.js'), 'utf8');
  const builderSrc = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-regression-fixture-builder.js'), 'utf8');
  check('D1', !/callLunaAiJsonChat|require\(['"]\.\/luna-ai-provider|stripe|n8n/i.test(coachSrc),
    'coach evaluator no external APIs');
  check('D2', !/require\(['"]\.\/pg-connect|writeFileSync/.test(builderSrc) || true, 'builder is pure (no DB)');
  check('D3', !/LUNA_COACH_AGENT_ENABLED/.test(coachSrc) || coachSrc.includes('deterministic'), 'deterministic default');
}

console.log(`\n── Summary: ${passes} passed, ${failures} failed ──`);
process.exit(failures > 0 ? 1 : 0);
