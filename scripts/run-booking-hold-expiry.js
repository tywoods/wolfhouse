'use strict';

/**
 * One-shot CLI for overdue hold expiry (WB-4).
 *
 * Default: dry-run (no writes). Pass --apply to mutate.
 *
 *   node scripts/run-booking-hold-expiry.js
 *   node scripts/run-booking-hold-expiry.js --client=wolfhouse-somo
 *   node scripts/run-booking-hold-expiry.js --apply --batch-size=25
 *   node scripts/run-booking-hold-expiry.js --now=2026-07-16T12:00:00Z --apply
 */

const { withPgClient } = require('./lib/pg-connect');
const { expireDueBookingHolds } = require('./lib/booking-hold-expiry');

function parseCliArgs(argv) {
  const out = { apply: false, batchSize: 50 };
  for (const arg of argv) {
    if (arg === '--apply') out.apply = true;
    else if (arg === '--dry-run') out.apply = false;
    else if (arg.startsWith('--client=')) out.clientSlug = arg.slice(9).trim();
    else if (arg.startsWith('--location=')) out.locationId = arg.slice(11).trim();
    else if (arg.startsWith('--batch-size=')) out.batchSize = parseInt(arg.slice(13), 10);
    else if (arg.startsWith('--now=')) out.now = new Date(arg.slice(6));
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  if (out.now && Number.isNaN(out.now.getTime())) {
    throw new Error('invalid --now timestamp');
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/run-booking-hold-expiry.js [options]

Options:
  --dry-run          Preview only (default)
  --apply            Execute writes (required for mutations)
  --client=SLUG      Scope to one client slug
  --location=UUID    Optional location filter
  --batch-size=N     Max bookings per batch (default 50)
  --now=ISO          As-of timestamp (default: now)
`);
}

async function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(1);
  }

  if (opts.help) {
    printHelp();
    return;
  }

  const now = opts.now || new Date();
  const summary = await withPgClient((pg) => expireDueBookingHolds(pg, {
    apply: opts.apply,
    batchSize: opts.batchSize,
    clientSlug: opts.clientSlug,
    locationId: opts.locationId,
    now,
  }));

  console.log(JSON.stringify({
    mode: opts.apply ? 'apply' : 'dry_run',
    now: now.toISOString(),
    client: opts.clientSlug || null,
    location: opts.locationId || null,
    batch_size: opts.batchSize,
    ...summary,
  }, null, 2));

  if (summary.errors && summary.errors.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
