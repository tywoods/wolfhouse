'use strict';

/**
 * Luna nightly suite — OFFLINE, env-independent regression smoke for GitHub CI.
 *
 *   npm run luna:nightly            # full offline suite
 *   npm run luna:nightly -- --quick # node-only checks (skip python step)
 *   node scripts/run-luna-nightly-suite.js --json
 *
 * WHY THIS IS OFFLINE-ONLY:
 *   The high-value regression nets — the golden-conversation suite
 *   (scripts/luna-golden-conversations.js) and the generative tester
 *   (scripts/luna-generative-tester.js) — drive the REAL Luna agent through the
 *   `wolfhouse.simulate_guest_turn` hook, which requires the live hermes-luna
 *   container. That only exists on Lunabox, NOT on a GitHub runner. So those run
 *   as a scheduled sweep ON LUNABOX (the true Phase-2 sweep); this CI nightly is
 *   the deterministic, container-free half: pure-source/static checks that behave
 *   identically on a runner and on the box.
 *
 * The previous scripts/run-luna-nightly-suite.js was deleted in the "quarantine
 * legacy brains" commit (it drove the retired offline conversation simulator);
 * package.json + .github/workflows/luna-nightly.yml still referenced it, so the
 * nightly failed with MODULE_NOT_FOUND. This is its lean, green replacement.
 *
 * Every step here is verified env-independent (no DB, no network, no container).
 * Add new checks only if they hold that property.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'reports', 'luna-nightly');

const argv = process.argv.slice(2);
const QUICK = argv.includes('--quick');
const JSON_OUT = argv.includes('--json');

// Each step is a pure-source / static check — no DB, no live container, no network.
// `node` steps run on any runner; the python step needs python3 (present on the
// GitHub ubuntu image) and is skipped under --quick for a node-only fast path.
const STEPS = [
  { label: 'soul-clean',        cmd: process.execPath, args: ['scripts/check-soul-clean.js'] },
  { label: 'i18n-guest-copy',   cmd: process.execPath, args: ['scripts/check-i18n-guest-copy.js'] },
  { label: 'pause-gate-static', cmd: 'python3', args: ['docker/hermes-staging/verify-pause-gate.py'], needsPython: true },
];

function runStep(step) {
  const r = spawnSync(step.cmd, step.args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const ok = r.status === 0;
  const tail = String(r.stdout || '').trim().split('\n').slice(-1)[0] || '';
  return { label: step.label, ok, status: r.status, error: r.error ? r.error.message : null, tail };
}

function main() {
  const steps = STEPS.filter((s) => !(QUICK && s.needsPython));
  const results = [];
  for (const step of steps) {
    const res = runStep(step);
    results.push(res);
    const mark = res.ok ? '✓' : '✗';
    process.stdout.write(`  ${mark} ${res.label}${res.tail ? `  — ${res.tail}` : ''}\n`);
    if (!res.ok && res.error) process.stdout.write(`      (${res.error})\n`);
  }
  const failed = results.filter((r) => !r.ok);
  const summary = {
    suite: 'luna-nightly-offline',
    quick: QUICK,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    failures: failed.map((r) => r.label),
  };

  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'latest.json'), JSON.stringify({ ...summary, results }, null, 2));
  } catch (_) { /* report is best-effort */ }

  if (JSON_OUT) console.log(JSON.stringify({ ...summary, results }, null, 2));
  console.log(`\n${failed.length ? '✗' : '✓'} luna nightly (offline): ${summary.passed}/${summary.total} passed${QUICK ? ', quick' : ''}`);
  console.log('  (live golden + generative suites run on Lunabox — see header.)');
  process.exit(failed.length ? 1 : 0);
}

main();
