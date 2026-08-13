'use strict';

/**
 * TOMBSTONE — this npm script's gate file was quarantined and never restored.
 *
 * package.json registered `verify:luna-agent-phase24-closeout` →
 * scripts/verify-luna-agent-phase24-closeout.js. The script was moved into
 * scripts/verify-old in 58c4377c (2026-06-14) and that folder was later
 * deleted. `npm run verify:luna-agent-phase24-closeout` produced
 * MODULE_NOT_FOUND before any assertion ran.
 *
 * Phase 24 closeout that still exists:
 *   docs/PHASE-24-OPENAI-ASK-LUNA-PROVIDER-CLOSEOUT.md
 * Shared provider:
 *   scripts/lib/luna-ai-provider.js
 *
 * This file stays so a stale `node scripts/verify-luna-agent-phase24-closeout.js`
 * does not look like a broken install.
 */

console.log(
  'verify-luna-agent-phase24-closeout: tombstone — '
  + 'gate was quarantined in 58c4377c and never restored; '
  + 'see docs/PHASE-24-OPENAI-ASK-LUNA-PROVIDER-CLOSEOUT.md',
);
process.exit(0);
