'use strict';

/**
 * verify:luna-golden — the regression gate for the curated golden Luna threads.
 *
 * Runs the deterministic dry-run conversation runner against fixtures/luna-golden
 * (no GPT planner, no Cami API, no writes, no live sends) and compares each
 * fixture's result against the recorded baseline. The build FAILS only on a
 * regression: a fixture that was PASS/PARTIAL dropping in rank.
 *
 * Improvements (FAIL -> PASS) are reported and you are nudged to update the
 * baseline so the new bar is locked in.
 *
 * Usage:
 *   node scripts/verify-luna-golden.js
 *   node scripts/verify-luna-golden.js --update-baseline   (re-record after intentional change)
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'run-luna-conversation-state-machine-tests.js');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-golden');
const BASELINE_PATH = path.join(ROOT, 'fixtures', 'luna-golden-baseline.json');

const RANK = { FAIL: 0, PARTIAL: 1, PASS: 2 };

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return { results: {} };
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

function runGolden() {
  const res = spawnSync(process.execPath, [
    RUNNER,
    '--fixture-dir', FIXTURE_DIR,
    '--all',
    '--json',
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  const stdout = res.stdout || '';
  const start = stdout.indexOf('{');
  if (start < 0) {
    console.error('FAIL — runner produced no JSON output');
    console.error(stdout.slice(0, 2000));
    console.error(res.stderr ? String(res.stderr).slice(0, 2000) : '');
    process.exit(1);
  }
  try {
    return JSON.parse(stdout.slice(start));
  } catch (e) {
    console.error(`FAIL — could not parse runner JSON: ${e.message}`);
    console.error(stdout.slice(0, 2000));
    process.exit(1);
  }
}

function turnFailureLines(fixture) {
  const lines = [];
  for (const t of fixture.turns || []) {
    if (t.failures && t.failures.length) {
      lines.push(`      turn ${t.turn}: ${t.failures.join('; ')}`);
    }
  }
  const finals = fixture.final_failures || fixture.finalFailures;
  if (finals && finals.length) lines.push(`      final: ${finals.join('; ')}`);
  return lines;
}

function main() {
  const updateBaseline = process.argv.includes('--update-baseline');
  const baseline = loadBaseline();
  const report = runGolden();

  const current = {};
  for (const f of report.fixtures || []) current[f.id] = f.result;

  console.log('\n── Luna golden gate ──');
  console.log(`profile: deterministic-composer (no GPT, no API key)`);
  console.log(`fixtures: ${report.total}  pass: ${report.passed}  partial: ${report.partial}  fail: ${report.failed}\n`);

  const regressions = [];
  const improvements = [];
  const newFixtures = [];

  for (const f of report.fixtures || []) {
    const was = baseline.results ? baseline.results[f.id] : undefined;
    const now = f.result;
    const tag = was === undefined ? 'NEW ' : '';
    const marker = now === 'PASS' ? '  ' : (now === 'PARTIAL' ? ' ~' : ' X');
    console.log(`${marker} ${tag}${now.padEnd(8)} ${f.id}`);
    if (now !== 'PASS') turnFailureLines(f).forEach((l) => console.log(l));

    if (was === undefined) {
      newFixtures.push(f.id);
      continue;
    }
    if (RANK[now] < RANK[was]) regressions.push(`${f.id}: ${was} -> ${now}`);
    else if (RANK[now] > RANK[was]) improvements.push(`${f.id}: ${was} -> ${now}`);
  }

  // Fixtures present in baseline but missing from the run.
  for (const id of Object.keys(baseline.results || {})) {
    if (!(id in current)) regressions.push(`${id}: missing from run (was ${baseline.results[id]})`);
  }

  if (improvements.length) {
    console.log(`\nImprovements (consider --update-baseline):`);
    improvements.forEach((l) => console.log(`  + ${l}`));
  }
  if (newFixtures.length) {
    console.log(`\nNew fixtures not yet in baseline (run --update-baseline to record):`);
    newFixtures.forEach((id) => console.log(`  ? ${id} (${current[id]})`));
  }

  if (updateBaseline) {
    const next = {
      ...baseline,
      results: current,
      recorded_at: new Date().toISOString(),
    };
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`\nBaseline updated -> ${path.relative(ROOT, BASELINE_PATH)}`);
  }

  if (regressions.length) {
    console.log(`\nREGRESSIONS:`);
    regressions.forEach((l) => console.log(`  - ${l}`));
    console.log(`\nverify:luna-golden FAILED (${regressions.length} regression(s))`);
    process.exit(1);
  }

  console.log(`\nverify:luna-golden PASSED (no regressions)`);
  process.exit(0);
}

main();
