'use strict';

/**
 * TOMBSTONE — Stage 57a product code was deleted.
 *
 * scripts/lib/luna-hermes-staff-api-tools.js does not exist in this repo
 * (deleted 68b2e3a2, 2026-06-14). Requiring it produced MODULE_NOT_FOUND
 * before any assertion ran.
 *
 * Replacement (Hermes Luna Staff API tool wrappers, Python):
 *   docker/hermes-staging/plugins/wolfhouse_staff_api/
 * Bot-route contract that still runs:
 *   scripts/verify-stage57b-staff-api-bot-routes.js
 * Deposit class (package €200 / short €100) still gated by:
 *   scripts/verify-luna-ux-quote-memory-deposit.js
 *
 * This file stays so ARCHITECTURE.md / docs that name the old path do not
 * 404 into a missing script, and so `node scripts/verify-stage57a-…` does
 * not look like a broken install.
 */

console.log(
  'verify-stage57a-hermes-staff-api-tools: tombstone — '
  + 'product lib luna-hermes-staff-api-tools.js was deleted; '
  + 'see docker/hermes-staging/plugins/wolfhouse_staff_api/ '
  + 'and scripts/verify-stage57b-staff-api-bot-routes.js',
);
process.exit(0);
