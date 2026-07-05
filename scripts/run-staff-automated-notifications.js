'use strict';

/**
 * Manual CLI for scheduled staff automated notifications.
 * Default: dry-run (Ask Luna + audit events, no WhatsApp).
 * Live mode: gated manual WhatsApp delivery — manual CLI only, not scheduled.
 *
 *   node scripts/run-staff-automated-notifications.js
 *   node scripts/run-staff-automated-notifications.js --now=2026-07-07T09:30:00+02:00 --client=wolfhouse-somo
 *   node scripts/run-staff-automated-notifications.js --location=sunset-somo --window-minutes=5
 *
 * Live (all gates required):
 *   STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED=true
 *   WHATSAPP_DRY_RUN=false
 *   STAFF_AUTOMATED_NOTIFICATIONS_ALLOWED_PHONES=+34...
 *   node scripts/run-staff-automated-notifications.js --live --client=...
 */

const { withPgClient } = require('./lib/pg-connect');
const {
  runDueStaffAutomatedNotificationsDryRun,
  runDueStaffAutomatedNotificationsLive,
  checkStaffAutomatedNotificationsLiveGates,
} = require('./lib/staff-automated-notifications');
const { executeStaffAskLunaQuestion } = require('./lib/staff-ask-luna-execute');
const { sendLunaWhatsAppMessage } = require('./lib/luna-whatsapp-provider');

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

function printLiveGateFailure(reasons) {
  console.error('Live send blocked — required gates not satisfied:');
  for (const reason of reasons) {
    console.error(`  • ${reason}`);
  }
  console.error('Live sends require: --live, STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED=true,');
  console.error('WHATSAPP_DRY_RUN=false, and STAFF_AUTOMATED_NOTIFICATIONS_ALLOWED_PHONES (E.164 allowlist).');
}

async function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(1);
  }

  const now = opts.now || new Date();

  if (opts.live) {
    const gate = checkStaffAutomatedNotificationsLiveGates({ liveFlag: true, env: process.env });
    if (!gate.ok) {
      printLiveGateFailure(gate.reasons);
      process.exit(1);
    }

    const liveEnv = {
      ...process.env,
      WHATSAPP_DRY_RUN: 'false',
      STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED: 'true',
    };
    const summary = await withPgClient((pg) => runDueStaffAutomatedNotificationsLive(pg, {
      now,
      clientSlug: opts.client,
      locationId: opts.location,
      windowMinutes: opts.windowMinutes,
      allowedPhones: gate.allowedPhones,
      executeQuestion: (input) => executeStaffAskLunaQuestion(input, { pg }),
      sendMessage: (input) => sendLunaWhatsAppMessage(input, liveEnv),
    }));

    console.log(JSON.stringify({
      mode: 'live',
      now: now.toISOString(),
      client: opts.client || null,
      location: opts.location || null,
      window_minutes: opts.windowMinutes,
      allowed_phones_count: gate.allowedPhones.length,
      due_count: summary.due_count,
      event_count: summary.event_count,
      sent_count: summary.sent_count,
      failed_count: summary.failed_count,
      skipped_count: summary.skipped_count,
      ask_luna_count: summary.ask_luna_count,
    }, null, 2));
    return;
  }

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
