'use strict';

/**
 * verify:luna-all — one command for the Luna robustness gate (no API key for core checks).
 *
 * Runs: golden regression gate, coach loop, unified planner static checks.
 * Optional slow stage verifiers via --full.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function run(label, script, extraArgs) {
  console.log(`\n▶ ${label}`);
  const res = spawnSync(process.execPath, [path.join(__dirname, script), ...(extraArgs || [])], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res.status === 0;
}

const full = process.argv.includes('--full');
const steps = [
  ['verify:luna-golden', 'verify-luna-golden.js'],
  ['verify:luna-coach', 'verify-luna-coach.js'],
  ['verify:luna-unified-planner', 'verify-luna-unified-planner.js'],
];

if (full) {
  steps.push(
    ['verify:stage49c-agent-package-choice-frontdesk', 'verify-stage49c-agent-package-choice-frontdesk.js'],
    ['verify:stage46b-vague-booking-intake', 'verify-stage46b-vague-booking-intake.js'],
    ['verify:staff-bot-guest-automation-gate', 'verify-staff-bot-guest-automation-gate.js'],
  );
}

let failed = 0;
for (const [label, script] of steps) {
  if (!run(label, script)) failed++;
}

console.log(`\n── verify:luna-all ${failed ? 'FAILED' : 'PASSED'} (${steps.length - failed}/${steps.length} green) ──`);
process.exit(failed > 0 ? 1 : 0);
