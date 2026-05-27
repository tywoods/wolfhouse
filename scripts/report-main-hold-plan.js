/**
 * Phase 3c.c.1 — Main hold upsert plan (read-only).
 *
 * Usage:
 *   npm run db:report:main-hold-plan -- --booking-code=WH-3C-HOLD-TEST-001 --check-in=... --check-out=...
 */
const fs = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const { buildMainHoldPlan, parseHoldInput } = require('./lib/main-booking-hold-plan');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

function usage() {
  console.error(`
Usage: npm run db:report:main-hold-plan -- --booking-code=WH-3C-HOLD-TEST-001 --check-in=YYYY-MM-DD --check-out=YYYY-MM-DD [options]

Required:
  --booking-code=WH-3C-HOLD-...     Proposed booking_code (fixture or Main-style WH-YYMMDD-####)
  --check-in=YYYY-MM-DD
  --check-out=YYYY-MM-DD

Optional:
  --phone=+353...
  --guest-name=...
  --email=...
  --guest-count=N                   Default 1
  --room-type=shared|private|any
  --room-preference=...
  --guest-gender-group-type=...
  --primary-room-code=R3
  --package-code=...
  --notes=...
  --client=wolfhouse-somo
  --json-file=path.json

Read-only: SELECT guards + availability report. No INSERT/UPDATE/DELETE.
No booking_beds. No payments/payment_events.
`);
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const raw = {
    client_slug: 'wolfhouse-somo',
    booking_code: null,
    phone: null,
    guest_name: null,
    email: null,
    check_in: null,
    check_out: null,
    guest_count: 1,
    room_type: 'shared',
    room_preference: null,
    guest_gender_group_type: 'unknown',
    primary_room_code: null,
    package_code: null,
    notes: null,
  };
  let jsonFile = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--booking-code=')) {
      raw.booking_code = arg.slice('--booking-code='.length);
    } else if (arg === '--booking-code' && argv[i + 1]) {
      raw.booking_code = argv[++i];
    } else if (arg.startsWith('--phone=')) {
      raw.phone = arg.slice('--phone='.length);
    } else if (arg === '--phone' && argv[i + 1]) {
      raw.phone = argv[++i];
    } else if (arg.startsWith('--guest-name=')) {
      raw.guest_name = arg.slice('--guest-name='.length);
    } else if (arg === '--guest-name' && argv[i + 1]) {
      raw.guest_name = argv[++i];
    } else if (arg.startsWith('--email=')) {
      raw.email = arg.slice('--email='.length);
    } else if (arg === '--email' && argv[i + 1]) {
      raw.email = argv[++i];
    } else if (arg.startsWith('--check-in=')) {
      raw.check_in = arg.slice('--check-in='.length);
    } else if (arg === '--check-in' && argv[i + 1]) {
      raw.check_in = argv[++i];
    } else if (arg.startsWith('--check-out=')) {
      raw.check_out = arg.slice('--check-out='.length);
    } else if (arg === '--check-out' && argv[i + 1]) {
      raw.check_out = argv[++i];
    } else if (arg.startsWith('--guest-count=')) {
      raw.guest_count = arg.slice('--guest-count='.length);
    } else if (arg === '--guest-count' && argv[i + 1]) {
      raw.guest_count = argv[++i];
    } else if (arg.startsWith('--room-type=')) {
      raw.room_type = arg.slice('--room-type='.length);
    } else if (arg === '--room-type' && argv[i + 1]) {
      raw.room_type = argv[++i];
    } else if (arg.startsWith('--room-preference=')) {
      raw.room_preference = arg.slice('--room-preference='.length);
    } else if (arg === '--room-preference' && argv[i + 1]) {
      raw.room_preference = argv[++i];
    } else if (arg.startsWith('--guest-gender-group-type=')) {
      raw.guest_gender_group_type = arg.slice('--guest-gender-group-type='.length);
    } else if (arg === '--guest-gender-group-type' && argv[i + 1]) {
      raw.guest_gender_group_type = argv[++i];
    } else if (arg.startsWith('--primary-room-code=')) {
      raw.primary_room_code = arg.slice('--primary-room-code='.length);
    } else if (arg === '--primary-room-code' && argv[i + 1]) {
      raw.primary_room_code = argv[++i];
    } else if (arg.startsWith('--package-code=')) {
      raw.package_code = arg.slice('--package-code='.length);
    } else if (arg === '--package-code' && argv[i + 1]) {
      raw.package_code = argv[++i];
    } else if (arg.startsWith('--notes=')) {
      raw.notes = arg.slice('--notes='.length);
    } else if (arg === '--notes' && argv[i + 1]) {
      raw.notes = argv[++i];
    } else if (arg.startsWith('--client=')) {
      raw.client_slug = arg.slice('--client='.length);
    } else if (arg.startsWith('--json-file=')) {
      jsonFile = arg.slice('--json-file='.length);
    } else if (arg === '--json-file' && argv[i + 1]) {
      jsonFile = argv[++i];
    }
  }

  if (jsonFile) {
    const abs = path.isAbsolute(jsonFile) ? jsonFile : path.join(process.cwd(), jsonFile);
    Object.assign(raw, JSON.parse(fs.readFileSync(abs, 'utf8')));
  }
  if (!raw.room_preference) {
    raw.room_preference = raw.room_type;
  }

  return parseHoldInput(raw);
}

async function main() {
  const holdInput = parseArgs(process.argv.slice(2));

  if (!holdInput.booking_code || !holdInput.check_in || !holdInput.check_out) {
    usage();
    process.exit(1);
  }

  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const generatedAt = new Date().toISOString();

  const report = await withPgClient(async (client) => {
    const plan = await buildMainHoldPlan(client, holdInput);
    return { generated_at: generatedAt, phase: '3c.c.1', report_type: 'main_hold_plan', ...plan };
  });

  if (report.error === 'client_not_found') {
    console.error(`\nMain hold plan: client not found (${holdInput.client_slug})\n`);
    process.exit(1);
  }
  if (
    report.error === 'missing_booking_code' ||
    report.error === 'missing_dates' ||
    report.error === 'invalid_date_range'
  ) {
    console.error(`\nMain hold plan: ${report.error}\n`);
    process.exit(1);
  }

  const safeCode = holdInput.booking_code.replace(/[^\w-]/g, '_');
  const stamp = report.generated_at.replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(REPORTS_DIR, `main-hold-plan-${safeCode}-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\nPhase 3c.c.1 — Main hold plan (read-only)\n');
  console.log(`  Booking code:     ${holdInput.booking_code}`);
  console.log(`  Dates:            ${holdInput.check_in} → ${holdInput.check_out}`);
  console.log(`  Availability:     ${report.availability_summary?.availability_found ?? 'n/a'}`);
  console.log(`  Plan allowed:     ${report.plan_allowed}`);
  console.log(`  Code action:      ${report.booking_code_guard?.planned_action?.action ?? 'n/a'}`);
  console.log(`  Proposed status:  ${report.proposed_status} / ${report.proposed_payment_status}`);
  if (report.active_hold_guard?.blocking) {
    console.log(`  Active hold guard: BLOCKING (${report.active_hold_guard.other_active_holds?.length ?? 0})`);
  }
  if (report.warnings?.length) {
    console.log('\n  Warnings:');
    for (const w of report.warnings) console.log(`    - ${w}`);
  }
  console.log(`\nWrote ${outPath}`);
  console.log('read_only: true | no_mutations: true\n');

  if (report.actionable?.length) {
    console.log(`Main hold plan: actionable: ${report.actionable.join(', ')}. Exit 2.\n`);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
