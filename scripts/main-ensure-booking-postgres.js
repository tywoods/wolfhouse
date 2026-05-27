/**
 * Phase 3c.c.4 — Ensure Booking promote execute (bookings only).
 */
const fs = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const { parseEnsureInput, ensureBookingPromote } = require('./lib/main-ensure-booking-pg-sql');
const { buildEnsureBookingPlan } = require('./lib/main-ensure-booking-plan');
const { parseFlags } = require('./report-main-ensure-booking-plan');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

function usage() {
  console.error(`
Usage: npm run db:main-ensure-booking:postgres -- --booking-code=WH-3C-PROMOTE-001 --check-in=... --check-out=... [options]

Same 11 parameters as Postgres - Ensure Booking In Postgres (+ optional --airtable-record-id).
Default dry-run. --execute to write. No payments/payment_events/booking_beds.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }
  const execute = argv.includes('--execute');
  const input = parseEnsureInput(parseFlags(argv));

  if (!input.booking_code || !input.check_in || !input.check_out) {
    usage();
    process.exit(1);
  }

  const result = await withPgClient(async (client) => {
    const plan = await buildEnsureBookingPlan(client, input);
    if (plan.error) return { ok: false, error: plan.error, plan };

    if (!plan.plan_allowed) {
      return { ok: false, blocked: true, plan, actionable: plan.actionable };
    }

    if (!execute) {
      return { ok: true, dry_run: true, plan };
    }

    const promote = await ensureBookingPromote(client, input);
    return { ok: true, dry_run: false, plan, promote };
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = input.booking_code.replace(/[^\w-]/g, '_');
  const outPath = path.join(
    REPORTS_DIR,
    `main-ensure-booking-${safe}-${execute ? 'execute' : 'dry-run'}-${stamp}.json`
  );
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), ...result }, null, 2));

  console.log(`\nPhase 3c.c.4 — Ensure Booking ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`);
  console.log(`  Booking code: ${input.booking_code}`);

  if (result.error) {
    console.error(`  Error: ${result.error}`);
    process.exit(1);
  }
  if (result.blocked) {
    console.log(`  Blocked: ${(result.actionable || []).join(', ')}`);
    process.exit(2);
  }
  if (result.dry_run) {
    console.log(`  Would: ${result.plan?.booking_code_guard?.planned_action?.action}`);
    process.exit(0);
  }

  const p = result.promote;
  console.log(`  booking_id: ${p.booking_id}`);
  console.log(`  created: ${p.created}  promoted: ${p.promoted}  action: ${p.action}`);
  console.log(`  status: ${p.booking?.status} / ${p.booking?.payment_status}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
