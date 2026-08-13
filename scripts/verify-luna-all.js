'use strict';

/**
 * verify:luna-all — one command for the Luna robustness gate (no API key for core checks).
 *
 * Runs: golden regression gate, coach loop, unified planner static checks.
 * Optional slow stage verifiers via --full.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * @returns {'green'|'red'|'missing'} 'missing' when the registered script is not on disk —
 * a suite bookkeeping error, not a gate failure, and node's MODULE_NOT_FOUND stack reads
 * like a broken install.
 */
function run(label, script, extraArgs) {
  console.log(`\n▶ ${label}`);
  const scriptPath = path.join(__dirname, script);
  if (!fs.existsSync(scriptPath)) {
    console.error(`  MISSING  registered step has no script on disk: scripts/${script}`);
    console.error('  Restore the script, or remove the step from verify-luna-all.js and package.json.');
    return 'missing';
  }
  const res = spawnSync(process.execPath, [scriptPath, ...(extraArgs || [])], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res.status === 0 ? 'green' : 'red';
}

const full = process.argv.includes('--full');
const steps = [
  ['verify:luna-soul-clean', 'verify-luna-soul-clean.js'],
  ['verify:guest-addon-pricing', 'verify-guest-addon-pricing.js'],
  ['verify:guest-room-type-supplement', 'verify-guest-room-type-supplement.js'],
  ['verify:luna-singular-person-date-range', 'verify-luna-singular-person-date-range.js'],
  ['verify:per-person-gear-room-pref', 'verify-per-person-gear-room-pref.js'],
  ['verify:luna-bed-allocator', 'verify-luna-bed-allocator.js'],
  ['verify:short-stay-booking-create', 'verify-short-stay-booking-create.js'],
  ['verify:per-guest-booking-payments', 'verify-per-guest-booking-payments.js'],
  ['verify:rental-invoice-line-text', 'verify-rental-invoice-line-text.js'],
  ['verify:guest-agent-session-reset', 'verify-guest-agent-session-reset.js'],
  ['verify:luna-ux-quote-memory-deposit', 'verify-luna-ux-quote-memory-deposit.js'],
  ['verify:luna-post-booking-addon-balance-link', 'verify-luna-post-booking-addon-balance-link.js'],
  ['verify:luna-add-guest-to-booking', 'verify-luna-add-guest-to-booking.js'],
  ['verify:luna-add-guest-paid', 'verify-luna-add-guest-paid.js'],
  ['verify:hermes-gateway-mirror-patch', 'verify-hermes-gateway-mirror-patch.js'],
  ['verify:luna-handoff-promise-detection', 'verify-luna-handoff-promise-detection.js'],
  ['verify:luna-effective-mode', 'verify-luna-effective-mode.js'],
  ['verify:hermes-send-flags', 'verify-hermes-send-flags.js'],
  ['verify:inbox-luna-mode-control', 'verify-inbox-luna-mode-control.js'],
  ['verify:inbox-shell-channel-defaults', 'verify-inbox-shell-channel-defaults.js'],
  ['verify:inbox-whatsapp-draft-route', 'verify-inbox-whatsapp-draft-route.js'],
  ['verify:inbox-stream-route', 'verify-inbox-stream-route.js'],
  ['verify:staff-broadcasts', 'verify-staff-broadcasts.js'],
  ['verify:inbox-context', 'verify-inbox-context.js'],
  ['verify:inbox-theme', 'verify-inbox-theme.js'],
  ['verify:luna-pause-handoff-controls', 'verify-luna-pause-handoff-controls.js'],
  ['verify:staff-bot-guest-automation-gate', 'verify-staff-bot-guest-automation-gate.js'],
  ['verify:luna-handoff-lifecycle', 'verify-luna-handoff-lifecycle.js'],
  ['verify:luna-needs-human-no-pause', 'verify-luna-needs-human-no-pause.js'],
  ['verify:luna-explicit-human-handoff', 'verify-luna-explicit-human-handoff.js'],
  ['verify:luna-catalog-services', 'verify-luna-catalog-services.js'],
  ['verify:luna-tenant-defaults', 'verify-luna-tenant-defaults.js'],
  ['verify:luna-golden', 'verify-luna-golden.js'],
  ['verify:luna-coach', 'verify-luna-coach.js'],
  ['verify:luna-unified-planner', 'verify-luna-unified-planner.js'],
  ['verify:sunset-luna-school-context', 'verify-sunset-luna-school-context.js'],
  ['verify:luna-confirmation-spacing', 'verify-luna-confirmation-spacing.js'],
  ['verify:luna-pending-transfers-save', 'verify-luna-pending-transfers-save.js'],
];

/**
 * Steps needing infra/.env or a live database, opted into with --full.
 *
 * Empty since the stage46b/49c orchestrator gates were dropped: they were deleted by the
 * 2026-06-14 quarantine (58c4377c) and never restored, and their subject matter is spec'd in
 * docs/LUNA-GUEST-BEHAVIOR-SPEC.md. Slow or DB-backed gates belong here, not in `steps`.
 */
const FULL_ONLY_STEPS = [];

if (full) steps.push(...FULL_ONLY_STEPS);

let green = 0;
const red = [];
const missing = [];
for (const [label, script] of steps) {
  const outcome = run(label, script);
  if (outcome === 'green') green++;
  else if (outcome === 'missing') missing.push([label, script]);
  else red.push(label);
}

const counts = [`${green}/${steps.length} green`];
if (missing.length) counts.push(`${missing.length} missing`);
console.log(`\n── verify:luna-all ${green === steps.length ? 'PASSED' : 'FAILED'} (${counts.join(', ')}) ──`);
if (red.length) {
  console.log('\nFailed steps:');
  for (const label of red) console.log(`  ${label}`);
}
if (missing.length) {
  console.log('\nRegistered steps with no script on disk:');
  for (const [label, script] of missing) console.log(`  ${label} → scripts/${script}`);
}
process.exit(green === steps.length ? 0 : 1);
