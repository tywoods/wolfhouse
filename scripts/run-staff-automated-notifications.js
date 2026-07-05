'use strict';

/**
 * Dry-run CLI for scheduled staff automated notifications.
 * Executes Ask Luna for due automations and writes audit events — no WhatsApp sends.
 *
 *   node scripts/run-staff-automated-notifications.js
 *   node scripts/run-staff-automated-notifications.js --now=2026-07-07T09:30:00+02:00 --client=wolfhouse-somo
 *   node scripts/run-staff-automated-notifications.js --location=sunset-somo --window-minutes=5
 */

const { withPgClient } = require('./lib/pg-connect');
const { runDueStaffAutomatedNotificationsDryRun } = require('./lib/staff-automated-notifications');
const { executeStaffAskLunaQuestion } = require('./lib/staff-ask-luna-execute');

function parseCliArgs(argv) {
  const out = { windowMinutes: 5 };
  for (const arg of argv) {
    if (arg === '--live') out.live = true;
    else if (arg.startsWith('--now=')) out.now = new Date(arg.slice(6));
    else if (arg.startsWith('--client=')) out.client = arg.slice(9).trim();
    else if (arg.startsWith('--location=')) out.location = arg.slice(11).trim();
    else if (arg.startsWith('--window-minutes=')) out.windowMinutes = parseInt(arg.slice(17), 10);
  }
  if (!Number.isFinite(out.windowMinutes) || out.windowMinutes < 0) out.windowMinutes = 5;
  if (out.now && Number.isNaN(out.now.getTime())) {
    throw new Error('invalid --now timestamp');
  }
  return out;
}

async function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(1);
  }

  if (opts.live) {
    console.error('Live sends not implemented in this slice. Remove --live (dry-run only).');
    process.exit(1);
  }

  const now = opts.now || new Date();
  const summary = await withPgClient((pg) => runDueStaffAutomatedNotificationsDryRun(pg, {
    now,
    clientSlug: opts.client,
    locationId: opts.location,
    windowMinutes: opts.windowMinutes,
    executeQuestion: (input) => executeStaffAskLunaQuestion(input, { pg }),
  }));

  console.log(JSON.stringify({
    mode: 'dry_run',
    now: now.toISOString(),
    client: opts.client || null,
    location: opts.location || null,
    window_minutes: opts.windowMinutes,
    due_count: summary.due_count,
    event_count: summary.event_count,
    dry_run_count: summary.dry_run_count,
    failed_count: summary.failed_count,
    skipped_count: summary.skipped_count,
  }, null, 2));
}

main().catch((err) => {
  console.error('run-staff-automated-notifications failed:', err && err.message ? err.message : err);
  process.exit(1);
});
