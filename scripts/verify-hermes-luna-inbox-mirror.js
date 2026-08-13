'use strict';

/**
 * TOMBSTONE — this npm script never had a gate file on disk.
 *
 * package.json registered `verify:hermes-luna-inbox-mirror` →
 * scripts/verify-hermes-luna-inbox-mirror.js in 58c4377c (2026-06-14)
 * without committing the script. `npm run verify:hermes-luna-inbox-mirror`
 * produced MODULE_NOT_FOUND before any assertion ran.
 *
 * Inbox mirror contract that still runs:
 *   scripts/verify-sunset-luna-inbox-mirror.js
 * Product owners:
 *   docker/hermes-staging/wolfhouse_whatsapp_mirror.py
 *   scripts/lib/luna-hermes-whatsapp-thread-mirror.js
 *
 * This file stays so a stale `node scripts/verify-hermes-luna-inbox-mirror.js`
 * does not look like a broken install.
 */

console.log(
  'verify-hermes-luna-inbox-mirror: tombstone — '
  + 'script was never committed; see scripts/verify-sunset-luna-inbox-mirror.js',
);
process.exit(0);
