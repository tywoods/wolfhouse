/**
 * Phase 3c.b — Main availability report (read-only).
 *
 * Usage:
 *   npm run db:report:main-availability -- --check-in=2026-08-07 --check-out=2026-08-12 --guest-count=2
 */
const fs = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const { loadAssignPlan, parseBedList } = require('./lib/assign-booking-beds-plan');
const {
  parseSessionInput,
  runMainAvailabilityReport,
} = require('./lib/main-availability-pg-sql');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

function usage() {
  console.error(`
Usage: npm run db:report:main-availability -- --check-in=YYYY-MM-DD --check-out=YYYY-MM-DD [options]

Required:
  --check-in=YYYY-MM-DD
  --check-out=YYYY-MM-DD

Optional:
  --guest-count=N                 Default 1
  --room-type=shared|private|any  Default shared
  --room-preference=...           Default: same as room-type
  --guest-gender-group-type=...   Default unknown
  --gender-strategy=...           Optional room filter hint
  --client=wolfhouse-somo         Default client slug
  --json-file=path.json           Session-shaped JSON (merges with CLI flags)
  --compare-booking-code=WH-rec   Optional assign-impact parity block
  --compare-beds=R7-B1,R7-B2      Beds for parity (requires --compare-booking-code)

Read-only: SELECT on clients, rooms, beds, bookings, booking_beds only.
No payments/payment_events. No INSERT/UPDATE/DELETE.
`);
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const raw = {
    client_slug: 'wolfhouse-somo',
    check_in: null,
    check_out: null,
    guest_count: 1,
    room_type: 'shared',
    room_preference: null,
    guest_gender_group_type: 'unknown',
    gender_strategy: null,
  };
  let jsonFile = null;
  let compareBookingCode = null;
  let compareBeds = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--check-in=')) {
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
    } else if (arg.startsWith('--gender-strategy=')) {
      raw.gender_strategy = arg.slice('--gender-strategy='.length);
    } else if (arg === '--gender-strategy' && argv[i + 1]) {
      raw.gender_strategy = argv[++i];
    } else if (arg.startsWith('--client=')) {
      raw.client_slug = arg.slice('--client='.length);
    } else if (arg.startsWith('--json-file=')) {
      jsonFile = arg.slice('--json-file='.length);
    } else if (arg === '--json-file' && argv[i + 1]) {
      jsonFile = argv[++i];
    } else if (arg.startsWith('--compare-booking-code=')) {
      compareBookingCode = arg.slice('--compare-booking-code='.length).trim();
    } else if (arg === '--compare-booking-code' && argv[i + 1]) {
      compareBookingCode = argv[++i].trim();
    } else if (arg.startsWith('--compare-beds=')) {
      compareBeds = parseBedList(arg.slice('--compare-beds='.length));
    } else if (arg === '--compare-beds' && argv[i + 1]) {
      compareBeds = parseBedList(argv[++i]);
    }
  }

  if (jsonFile) {
    const abs = path.isAbsolute(jsonFile) ? jsonFile : path.join(process.cwd(), jsonFile);
    const fromFile = JSON.parse(fs.readFileSync(abs, 'utf8'));
    Object.assign(raw, fromFile);
  }

  if (!raw.room_preference) {
    raw.room_preference = raw.room_type;
  }

  const input = parseSessionInput(raw);
  return { input, compareBookingCode, compareBeds };
}

async function buildAssignParity(client, input, compareBookingCode, compareBeds) {
  if (!compareBookingCode || !compareBeds.length) {
    return {
      skipped: true,
      reason: 'Pass --compare-booking-code and --compare-beds for assign-impact parity',
    };
  }

  const assignFlags = {
    clientSlug: input.client_slug,
    bookingCode: compareBookingCode,
    bedCodes: compareBeds,
    checkIn: input.check_in,
    checkOut: input.check_out,
  };

  const plan = await loadAssignPlan(client, assignFlags);
  if (plan.error) {
    return { skipped: false, error: plan.error, assign_flags: assignFlags };
  }

  const mainBlocked = new Set(
    compareBeds.filter((code) => {
      const blocked = plan.overlapConflicts.some(
        (c) => String(c.proposed_bed_code).toUpperCase() === code
      );
      return blocked;
    })
  );

  return {
    skipped: false,
    assign_flags: assignFlags,
    assign_overlap_count: plan.overlapConflicts.length,
    assign_unknown_beds: plan.unknownBedCodes,
    beds_checked: compareBeds,
    beds_blocked_by_assign_semantics: [...mainBlocked],
    parity_match:
      plan.unknownBedCodes.length === 0 &&
      compareBeds.every((code) => {
        const inMainAvailable = !mainBlocked.has(code);
        const assignWouldConflict = plan.overlapConflicts.some(
          (c) => String(c.proposed_bed_code).toUpperCase() === code
        );
        return inMainAvailable === !assignWouldConflict;
      }),
    assign_overlap_conflicts: plan.overlapConflicts,
    note: 'Per-bed parity: available in main report vs no assign overlap conflict for same dates',
  };
}

async function main() {
  const { input, compareBookingCode, compareBeds } = parseArgs(process.argv.slice(2));

  if (!input.check_in || !input.check_out) {
    usage();
    process.exit(1);
  }

  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const generatedAt = new Date().toISOString();

  const report = await withPgClient(async (client) => {
    const core = await runMainAvailabilityReport(client, input);
    if (core.error) return { generated_at: generatedAt, ...core };

    const parity_comparison = await buildAssignParity(
      client,
      input,
      compareBookingCode,
      compareBeds
    );

    return {
      generated_at: generatedAt,
      phase: '3c.b',
      report_type: 'main_availability',
      ...core,
      parity_comparison_with_assign_impact: parity_comparison,
      payments_untouched: {
        policy: 'No read or write on payments or payment_events',
      },
    };
  });

  if (report.error === 'client_not_found') {
    console.error(`\nMain availability: client not found (${report.client_slug || input.client_slug})\n`);
    process.exit(1);
  }
  if (report.error === 'missing_dates' || report.error === 'invalid_date_range') {
    console.error(`\nMain availability: ${report.error}\n`);
    process.exit(1);
  }

  const stamp = report.generated_at.replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(
    REPORTS_DIR,
    `main-availability-${input.check_in}_${input.check_out}-${stamp}.json`
  );
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\nPhase 3c.b — Main availability report (read-only)\n');
  console.log(`  Client:              ${report.client_slug}`);
  console.log(`  Dates:               ${input.check_in} → ${input.check_out}`);
  console.log(`  Guest count:         ${input.guest_count}`);
  console.log(`  Room preference:     ${input.room_preference}`);
  console.log(`  Availability found:  ${report.availability_found}`);
  console.log(`  Candidate rooms:     ${report.candidate_rooms.length}`);
  console.log(`  Available beds:      ${report.available_beds.length}`);
  console.log(`  Blocked beds:        ${report.blocked_beds.length}`);
  console.log(`  Overlap conflicts:   ${report.overlap_conflicts.length}`);
  if (report.recommended_room_or_beds) {
    console.log(
      `  Recommended:         ${report.recommended_room_or_beds.room_code} beds ${report.recommended_room_or_beds.bed_codes.join(', ')}`
    );
  }
  if (report.parity_comparison_with_assign_impact?.parity_match != null) {
    console.log(
      `  Assign parity:       ${report.parity_comparison_with_assign_impact.parity_match ? 'match' : 'mismatch'}`
    );
  }
  if (report.warnings.length) {
    console.log('\n  Warnings:');
    for (const w of report.warnings) console.log(`    - ${w}`);
  }
  console.log(`\nWrote ${outPath}`);
  console.log('read_only: true | no_mutations: true');
  console.log('No Postgres writes. No Airtable/Sheets/payments.\n');

  if (report.actionable.length) {
    console.log(`Main availability: actionable: ${report.actionable.join(', ')}. Exit 2.\n`);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
