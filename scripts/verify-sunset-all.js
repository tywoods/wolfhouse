'use strict';

/**
 * verify:sunset-all
 *
 * Aggregator for all Sunset offline checks.
 * Runs each check as a child process, collects results, and exits
 * non-zero if any check fails.
 *
 * Does NOT include verify:luna-all — Sunset checks are isolated.
 *
 * Run:
 *   node scripts/verify-sunset-all.js
 *   npm run verify:sunset-all
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const CHECKS = [
  { name: 'verify:sunset-rental-lookup',            script: 'scripts/verify-sunset-rental-lookup.js' },
  { name: 'verify:sunset-catalog-tools',            script: 'scripts/verify-sunset-catalog-tool-executor.js' },
  { name: 'verify:sunset-catalog-response-preview', script: 'scripts/verify-sunset-catalog-response-preview.js' },
  { name: 'verify:sunset-golden',                   script: 'scripts/verify-sunset-golden.js' },
  { name: 'verify:sunset-portal-slice1-seed',       script: 'scripts/verify-sunset-portal-slice1-seed.js' },
  { name: 'verify:sunset-portal-slice1',           script: 'scripts/verify-sunset-portal-slice1.js' },
  { name: 'verify:sunset-portal-v1',               script: 'scripts/verify-sunset-portal-v1.js' },
  { name: 'verify:sunset-portal-slice1-seed-runner', script: 'scripts/verify-sunset-portal-slice1-seed-runner.js' },
];

const SEP = '─'.repeat(64);

console.log(`\n${SEP}`);
console.log('verify:sunset-all — Sunset offline check suite');
console.log(SEP);

const results = [];

for (const check of CHECKS) {
  console.log(`\n▶ ${check.name}`);
  const result = spawnSync(process.execPath, [path.join(ROOT, check.script)], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  const ok = result.status === 0 && result.error == null;
  results.push({ name: check.name, ok, status: result.status, error: result.error });
}

console.log(`\n${SEP}`);
console.log('SUMMARY');
console.log(SEP);

let allPass = true;
for (const r of results) {
  const label = r.ok ? 'PASS' : 'FAIL';
  console.log(`  ${label}  ${r.name}${r.error ? ' — ' + r.error.message : ''}`);
  if (!r.ok) allPass = false;
}

console.log(SEP);
if (allPass) {
  console.log('verify:sunset-all — ALL CHECKS PASSED');
} else {
  const failed = results.filter((r) => !r.ok).map((r) => r.name).join(', ');
  console.error(`verify:sunset-all — FAILED: ${failed}`);
  process.exit(1);
}
