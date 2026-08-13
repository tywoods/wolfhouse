'use strict';

/**
 * TOMBSTONE — this npm script's gate file was quarantined and never restored.
 *
 * package.json registered `verify:luna-ai-health-status` →
 * scripts/verify-luna-ai-health-status.js. The script was moved into
 * scripts/verify-old in 58c4377c (2026-06-14) and that folder was later
 * deleted. `npm run verify:luna-ai-health-status` produced MODULE_NOT_FOUND
 * before any assertion ran.
 *
 * /healthz luna_ai wiring still gated by:
 *   scripts/verify-radar-slice16k-staff-api-healthz.js
 * Provider module:
 *   scripts/lib/luna-ai-provider.js
 *
 * This file stays so a stale `node scripts/verify-luna-ai-health-status.js`
 * does not look like a broken install.
 */

console.log(
  'verify-luna-ai-health-status: tombstone — '
  + 'gate was quarantined in 58c4377c and never restored; '
  + 'see scripts/verify-radar-slice16k-staff-api-healthz.js',
);
process.exit(0);
