'use strict';

/**
 * TOMBSTONE — Stage 57c product code was deleted.
 *
 * scripts/lib/luna-hermes-e2e-rehearsal.js does not exist in this repo
 * (deleted 68b2e3a2, 2026-06-14, with luna-hermes-staff-api-tools.js).
 * Requiring it produced MODULE_NOT_FOUND before any assertion ran.
 *
 * Replacement (Hermes Luna dry-run / tool wrappers, Python):
 *   docker/hermes-staging/plugins/wolfhouse_staff_api/
 *   docker/hermes-staging/plugins/wolfhouse_staff_api/test_luna_tool_guards.py
 * Guest-pipeline rehearsal that still runs:
 *   npm run verify:luna-all
 * Bot-route contract that still runs:
 *   scripts/verify-stage57b-staff-api-bot-routes.js
 *
 * This file stays so ARCHITECTURE.md / docs that name the old path do not
 * 404 into a missing script, and so `node scripts/verify-stage57c-…` does
 * not look like a broken install.
 */

console.log(
  'verify-stage57c-hermes-luna-e2e-rehearsal: tombstone — '
  + 'product lib luna-hermes-e2e-rehearsal.js was deleted; '
  + 'see docker/hermes-staging/plugins/wolfhouse_staff_api/ '
  + 'and npm run verify:luna-all',
);
process.exit(0);
