'use strict';

/**
 * SAME-DESK-005 — final Guest Journey v2 regression pack.
 *
 * Runs the accepted SAME-DESK-001–004 contracts together with the established
 * WhatsApp journey/send owners. This file owns orchestration only; commercial
 * truth and channel behavior stay in their canonical Staff API owners.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

const STAGES = Object.freeze([
  ['001 — grounded Admin catalog', 'scripts/verify-luna-same-desk-admin-catalog.js'],
  ['002 — email presentation and grouped asks', 'scripts/verify-luna-same-desk-email-presentation.js'],
  ['003 — email hold, pay-to-book, and payment truth', 'scripts/verify-luna-same-desk-email-booking.js'],
  ['004 — email auto-send eligibility and fail-closed gates', 'scripts/verify-luna-same-desk-email-auto-send.js'],
  ['WhatsApp — canonical guest journey golden pack', 'scripts/verify-luna-golden.js'],
  ['Cross-channel — outbound kill switches and WhatsApp provider path', 'scripts/verify-hermes-send-flags.js'],
]);

let failed = 0;

console.log('SAME-DESK-005 — Guest Journey v2, WhatsApp + email one desk');

for (const [label, relativeScript] of STAGES) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(process.execPath, [path.join(ROOT, relativeScript)], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    stdio: 'inherit',
  });

  if (result.error) {
    failed += 1;
    console.error(`FAIL ${label} — ${result.error.message}`);
    continue;
  }

  if (result.status !== 0) {
    failed += 1;
    console.error(`FAIL ${label} — exited ${String(result.status)}`);
    continue;
  }

  console.log(`PASS ${label}`);
}

if (failed > 0) {
  console.error(`\nSAME-DESK-005 BLOCKED — ${failed} journey stage(s) failed.`);
  process.exit(1);
}

console.log(`\nSAME-DESK-005 PASS — all ${STAGES.length} journey stages passed.`);
