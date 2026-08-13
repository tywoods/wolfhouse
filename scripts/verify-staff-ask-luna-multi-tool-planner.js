'use strict';

/**
 * TOMBSTONE — this npm script's gate file was quarantined and never restored.
 *
 * package.json registered `verify:staff-ask-luna-multi-tool-planner` →
 * scripts/verify-staff-ask-luna-multi-tool-planner.js. The script was moved
 * into scripts/verify-old in 58c4377c (2026-06-14) and that folder was later
 * deleted. `npm run verify:staff-ask-luna-multi-tool-planner` produced
 * MODULE_NOT_FOUND before any assertion ran.
 *
 * Multi-tool planner that still exists:
 *   scripts/lib/staff-ask-luna-multi-tool-planner.js
 *
 * This file stays so a stale `node scripts/verify-staff-ask-luna-multi-tool-planner.js`
 * does not look like a broken install.
 */

console.log(
  'verify-staff-ask-luna-multi-tool-planner: tombstone — '
  + 'gate was quarantined in 58c4377c and never restored; '
  + 'see scripts/lib/staff-ask-luna-multi-tool-planner.js',
);
process.exit(0);
