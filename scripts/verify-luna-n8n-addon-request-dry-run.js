'use strict';

/**
 * TOMBSTONE — n8n addon-request dry-run gate was quarantined and never restored.
 *
 * package.json registered `verify:luna-n8n-addon-request-dry-run` →
 * scripts/verify-luna-n8n-addon-request-dry-run.js. The script was moved
 * into scripts/verify-old in 58c4377c (2026-06-14) and that folder was later
 * deleted. `npm run verify:luna-n8n-addon-request-dry-run` produced
 * MODULE_NOT_FOUND before any assertion ran.
 *
 * Guest addon / payment path that still runs:
 *   npm run verify:luna-all
 *   scripts/verify-luna-post-booking-addon-balance-link.js
 *
 * This file stays so a stale `node scripts/verify-luna-n8n-addon-request-dry-run.js`
 * does not look like a broken install.
 */

console.log(
  'verify-luna-n8n-addon-request-dry-run: tombstone — '
  + 'n8n addon dry-run gate was quarantined in 58c4377c and never restored; '
  + 'see npm run verify:luna-all',
);
process.exit(0);
