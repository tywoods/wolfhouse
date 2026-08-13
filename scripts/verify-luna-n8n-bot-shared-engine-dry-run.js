'use strict';

/**
 * TOMBSTONE — n8n shared-engine dry-run gate was quarantined and never restored.
 *
 * package.json registered `verify:luna-n8n-bot-shared-engine-dry-run` →
 * scripts/verify-luna-n8n-bot-shared-engine-dry-run.js. The script was moved
 * into scripts/verify-old in 58c4377c (2026-06-14) and that folder was later
 * deleted. `npm run verify:luna-n8n-bot-shared-engine-dry-run` produced
 * MODULE_NOT_FOUND before any assertion ran.
 *
 * Guest WhatsApp path that still runs (Hermes, not n8n):
 *   npm run verify:luna-all
 * Historical map (n8n workflow is gone):
 *   docs/STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md
 *
 * This file stays so a stale `node scripts/verify-luna-n8n-bot-shared-engine-dry-run.js`
 * does not look like a broken install.
 */

console.log(
  'verify-luna-n8n-bot-shared-engine-dry-run: tombstone — '
  + 'n8n dry-run gate was quarantined in 58c4377c and never restored; '
  + 'see npm run verify:luna-all',
);
process.exit(0);
