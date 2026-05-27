/**
 * Phase 3c.c.4 — Ensure Booking promote plan (read-only).
 */
const fs = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const { buildEnsureBookingPlan, parseEnsureInput } = require('./lib/main-ensure-booking-plan');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

function usage() {
  console.error(`
Usage: npm run db:report:main-ensure-booking-plan -- --booking-code=WH-3C-PROMOTE-001 --check-in=YYYY-MM-DD --check-out=YYYY-MM-DD [options]

Required: --booking-code, --check-in, --check-out
Optional: guest/contact fields (11 Ensure params), --airtable-record-id=rec..., --client=wolfhouse-somo

Read-only. No payments/payment_events/booking_beds.
`);
}

function parseArgv(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }
  const raw = parseFlags(argv);
  return parseEnsureInput(raw);
}

function parseFlags(argv) {
  const raw = {
    client_slug: 'wolfhouse-somo',
    booking_code: null,
    guest_name: null,
    phone: null,
    email: null,
    check_in: null,
    check_out: null,
    guest_count: 1,
    package_code: null,
    requested_room_type: 'shared',
    room_preference: 'shared',
    guest_gender_group_type: 'unknown',
    airtable_record_id: null,
  };
  let jsonFile = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--booking-code=')) raw.booking_code = arg.slice(15);
    else if (arg === '--booking-code' && argv[i + 1]) raw.booking_code = argv[++i];
    else if (arg.startsWith('--guest-name=')) raw.guest_name = arg.slice(13);
    else if (arg === '--guest-name' && argv[i + 1]) raw.guest_name = argv[++i];
    else if (arg.startsWith('--phone=')) raw.phone = arg.slice(8);
    else if (arg === '--phone' && argv[i + 1]) raw.phone = argv[++i];
    else if (arg.startsWith('--email=')) raw.email = arg.slice(8);
    else if (arg === '--email' && argv[i + 1]) raw.email = argv[++i];
    else if (arg.startsWith('--check-in=')) raw.check_in = arg.slice(11);
    else if (arg === '--check-in' && argv[i + 1]) raw.check_in = argv[++i];
    else if (arg.startsWith('--check-out=')) raw.check_out = arg.slice(12);
    else if (arg === '--check-out' && argv[i + 1]) raw.check_out = argv[++i];
    else if (arg.startsWith('--guest-count=')) raw.guest_count = arg.slice(14);
    else if (arg === '--guest-count' && argv[i + 1]) raw.guest_count = argv[++i];
    else if (arg.startsWith('--package-code=')) raw.package_code = arg.slice(15);
    else if (arg === '--package-code' && argv[i + 1]) raw.package_code = argv[++i];
    else if (arg.startsWith('--requested-room-type=')) raw.requested_room_type = arg.slice(22);
    else if (arg.startsWith('--room-preference=')) raw.room_preference = arg.slice(18);
    else if (arg.startsWith('--guest-gender-group-type=')) {
      raw.guest_gender_group_type = arg.slice(26);
    } else if (arg.startsWith('--airtable-record-id=')) {
      raw.airtable_record_id = arg.slice(21);
    } else if (arg.startsWith('--client=')) raw.client_slug = arg.slice(9);
    else if (arg.startsWith('--json-file=')) jsonFile = arg.slice(12);
  }
  if (jsonFile) {
    const abs = path.isAbsolute(jsonFile) ? jsonFile : path.join(process.cwd(), jsonFile);
    Object.assign(raw, JSON.parse(fs.readFileSync(abs, 'utf8')));
  }
  return raw;
}

async function main() {
  const input = parseArgv(process.argv.slice(2));
  if (!input.booking_code || !input.check_in || !input.check_out) {
    usage();
    process.exit(1);
  }

  const report = await withPgClient(async (client) => buildEnsureBookingPlan(client, input));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = input.booking_code.replace(/[^\w-]/g, '_');
  const outPath = path.join(REPORTS_DIR, `main-ensure-booking-plan-${safe}-${stamp}.json`);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), ...report }, null, 2));

  console.log('\nPhase 3c.c.4 — Ensure Booking plan (read-only)\n');
  console.log(`  Booking code: ${input.booking_code}`);
  console.log(`  Plan allowed: ${report.plan_allowed}`);
  console.log(`  Action: ${report.booking_code_guard?.planned_action?.action ?? 'n/a'}`);
  console.log(`  Wrote ${outPath}\n`);

  if (report.actionable?.length) process.exit(2);
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { parseFlags, parseArgv };
