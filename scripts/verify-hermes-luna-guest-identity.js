'use strict';

/**
 * TOMBSTONE — this npm script never had a gate file on disk.
 *
 * package.json registered `verify:hermes-luna-guest-identity` →
 * scripts/verify-hermes-luna-guest-identity.js in 58c4377c (2026-06-14)
 * without committing the script. `npm run verify:hermes-luna-guest-identity`
 * produced MODULE_NOT_FOUND before any assertion ran.
 *
 * Guest WhatsApp identity / session reset that still runs:
 *   scripts/verify-guest-agent-session-reset.js
 *   scripts/lib/luna-hermes-guest-session-reset.js
 *
 * This file stays so a stale `node scripts/verify-hermes-luna-guest-identity.js`
 * does not look like a broken install.
 */

console.log(
  'verify-hermes-luna-guest-identity: tombstone — '
  + 'script was never committed; see scripts/verify-guest-agent-session-reset.js '
  + 'and scripts/lib/luna-hermes-guest-session-reset.js',
);
process.exit(0);
