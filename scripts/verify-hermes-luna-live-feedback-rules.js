'use strict';

/**
 * TOMBSTONE — this npm script never had a gate file on disk.
 *
 * package.json registered `verify:hermes-luna-live-feedback-rules` →
 * scripts/verify-hermes-luna-live-feedback-rules.js in 58c4377c (2026-06-14)
 * without committing the script. `npm run verify:hermes-luna-live-feedback-rules`
 * produced MODULE_NOT_FOUND before any assertion ran.
 *
 * Live Luna guest rules that still run:
 *   docker/hermes-staging/SOUL.md
 *   docs/LUNA-GUEST-BEHAVIOR-SPEC.md
 *   npm run verify:luna-all
 *
 * This file stays so a stale `node scripts/verify-hermes-luna-live-feedback-rules.js`
 * does not look like a broken install.
 */

console.log(
  'verify-hermes-luna-live-feedback-rules: tombstone — '
  + 'script was never committed; see docker/hermes-staging/SOUL.md '
  + 'and npm run verify:luna-all',
);
process.exit(0);
