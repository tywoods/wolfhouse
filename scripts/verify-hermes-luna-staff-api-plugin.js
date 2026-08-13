'use strict';

/**
 * TOMBSTONE — this npm script never had a gate file on disk.
 *
 * package.json registered `verify:hermes-luna-staff-api-plugin` →
 * scripts/verify-hermes-luna-staff-api-plugin.js in 58c4377c (2026-06-14)
 * without committing the script. `npm run verify:hermes-luna-staff-api-plugin`
 * produced MODULE_NOT_FOUND before any assertion ran.
 *
 * Hermes Luna Staff API plugin (Python) that still runs:
 *   docker/hermes-staging/plugins/wolfhouse_staff_api/
 * Bot-route contract:
 *   scripts/verify-stage57b-staff-api-bot-routes.js
 *
 * This file stays so a stale `node scripts/verify-hermes-luna-staff-api-plugin.js`
 * does not look like a broken install.
 */

console.log(
  'verify-hermes-luna-staff-api-plugin: tombstone — '
  + 'script was never committed; see docker/hermes-staging/plugins/wolfhouse_staff_api/ '
  + 'and scripts/verify-stage57b-staff-api-bot-routes.js',
);
process.exit(0);
