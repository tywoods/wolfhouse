'use strict';

/**
 * TOMBSTONE — this npm script's gate file was quarantined and never restored.
 *
 * package.json registered `verify:luna-ai-provider` →
 * scripts/verify-luna-ai-provider.js. The script was moved into
 * scripts/verify-old in 58c4377c (2026-06-14) and that folder was later
 * deleted. `npm run verify:luna-ai-provider` produced MODULE_NOT_FOUND
 * before any assertion ran.
 *
 * Shared AI provider that still exists:
 *   scripts/lib/luna-ai-provider.js
 * Healthz wiring still gated by:
 *   scripts/verify-radar-slice16k-staff-api-healthz.js
 *
 * This file stays so a stale `node scripts/verify-luna-ai-provider.js`
 * does not look like a broken install.
 */

console.log(
  'verify-luna-ai-provider: tombstone — '
  + 'gate was quarantined in 58c4377c and never restored; '
  + 'see scripts/lib/luna-ai-provider.js',
);
process.exit(0);
