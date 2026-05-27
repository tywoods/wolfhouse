/**
 * Phase 3c.c.3 — Main booking hold Postgres execute (bookings only).
 * Default: dry-run. Requires --execute to write.
 */
const fs = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const { parseHoldInput, upsertBookingHold } = require('./lib/main-booking-hold-pg-sql');
const { buildMainHoldPlan } = require('./lib/main-booking-hold-plan');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

function usage() {
  console.error(`
Usage: npm run db:main-hold:postgres -- --booking-code=WH-3C-HOLD-EXEC-001 --check-in=YYYY-MM-DD --check-out=YYYY-MM-DD [options]

Required:
  --booking-code=WH-3C-...
  --check-in=YYYY-MM-DD
  --check-out=YYYY-MM-DD

Optional:
  --phone=+353...  --guest-name=...  --email=...
  --guest-count=N  --room-type=shared  --room-preference=...
  --guest-gender-group-type=...  --primary-room-code=R3  --package-code=...
  --notes=...  --client=wolfhouse-somo  --json-file=path.json
  --execute          Apply upsert (default: dry-run)
  --dry-run          Explicit dry-run

Prerequisites: availability + hold guards (same as db:report:main-hold-plan).
Writes: bookings row only. No booking_beds, payments, or payment_events.
`);
}

function parseArgv(argv) {
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
  let execute = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') execute = true;
    else if (arg === '--dry-run') execute = false;
    else if (arg.startsWith('--booking-code=')) raw.booking_code = arg.slice(15);
    else if (arg === '--booking-code' && argv[i + 1]) raw.booking_code = argv[++i];
    else if (arg.startsWith('--phone=')) raw.phone = arg.slice(8);
    else if (arg === '--phone' && argv[i + 1]) raw.phone = argv[++i];
    else if (arg.startsWith('--guest-name=')) raw.guest_name = arg.slice(13);
    else if (arg === '--guest-name' && argv[i + 1]) raw.guest_name = argv[++i];
    else if (arg.startsWith('--email=')) raw.email = arg.slice(8);
    else if (arg === '--email' && argv[i + 1]) raw.email = argv[++i];
    else if (arg.startsWith('--check-in=')) raw.check_in = arg.slice(11);
    else if (arg === '--check-in' && argv[i + 1]) raw.check_in = argv[++i];
    else if (arg.startsWith('--check-out=')) raw.check_out = arg.slice(12);
    else if (arg === '--check-out' && argv[i + 1]) raw.check_out = argv[++i];
    else if (arg.startsWith('--guest-count=')) raw.guest_count = arg.slice(14);
    else if (arg === '--guest-count' && argv[i + 1]) raw.guest_count = argv[++i];
    else if (arg.startsWith('--room-type=')) raw.room_type = arg.slice(12);
    else if (arg === '--room-type' && argv[i + 1]) raw.room_type = argv[++i];
    else if (arg.startsWith('--room-preference=')) raw.room_preference = arg.slice(18);
    else if (arg === '--room-preference' && argv[i + 1]) raw.room_preference = argv[++i];
    else if (arg.startsWith('--guest-gender-group-type=')) {
      raw.guest_gender_group_type = arg.slice(26);
    } else if (arg === '--guest-gender-group-type' && argv[i + 1]) {
      raw.guest_gender_group_type = argv[++i];
    } else if (arg.startsWith('--primary-room-code=')) {
      raw.primary_room_code = arg.slice(20);
    } else if (arg === '--primary-room-code' && argv[i + 1]) {
      raw.primary_room_code = argv[++i];
    } else if (arg.startsWith('--package-code=')) raw.package_code = arg.slice(15);
    else if (arg === '--package-code' && argv[i + 1]) raw.package_code = argv[++i];
    else if (arg.startsWith('--notes=')) raw.notes = arg.slice(8);
    else if (arg === '--notes' && argv[i + 1]) raw.notes = argv[++i];
    else if (arg.startsWith('--client=')) raw.client_slug = arg.slice(9);
    else if (arg.startsWith('--json-file=')) jsonFile = arg.slice(12);
    else if (arg === '--json-file' && argv[i + 1]) jsonFile = argv[++i];
  }

  if (jsonFile) {
    const abs = path.isAbsolute(jsonFile) ? jsonFile : path.join(process.cwd(), jsonFile);
    Object.assign(raw, JSON.parse(fs.readFileSync(abs, 'utf8')));
  }
  if (!raw.room_preference) raw.room_preference = raw.room_type;

  return { holdInput: parseHoldInput(raw), execute };
}

async function countBooking(client, bookingCode) {
  const { rows } = await client.query(
    `SELECT b.id::text AS booking_id, b.status::text AS status
     FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = 'wolfhouse-somo' AND b.booking_code = $1`,
    [bookingCode]
  );
  return rows[0] || null;
}

async function main() {
  const { holdInput, execute } = parseArgv(process.argv.slice(2));
  if (!holdInput.booking_code || !holdInput.check_in || !holdInput.check_out) {
    usage();
    process.exit(1);
  }

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const result = await withPgClient(async (client) => {
    const before = await countBooking(client, holdInput.booking_code);
    const plan = await buildMainHoldPlan(client, holdInput);

    if (plan.error) {
      return { ok: false, error: plan.error, plan, before, after: before };
    }

    if (!plan.plan_allowed) {
      return {
        ok: false,
        blocked: true,
        plan,
        before,
        after: before,
        actionable: plan.actionable,
      };
    }

    if (!execute) {
      return {
        ok: true,
        dry_run: true,
        plan,
        before,
        after: before,
        would_upsert: plan.would_upsert_booking,
      };
    }

    const clientRes = await client.query(`SELECT id FROM clients WHERE slug = $1`, [
      holdInput.client_slug,
    ]);
    const upsert = await upsertBookingHold(
      client,
      clientRes.rows[0].id,
      holdInput,
      plan.would_upsert_booking
    );
    const after = await countBooking(client, holdInput.booking_code);
    return { ok: true, dry_run: false, plan, before, after, upsert };
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = holdInput.booking_code.replace(/[^\w-]/g, '_');
  const outPath = path.join(
    REPORTS_DIR,
    `main-hold-exec-${safe}-${execute ? 'execute' : 'dry-run'}-${stamp}.json`
  );
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

  console.log(`\nPhase 3c.c.3 — Main hold ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`);
  console.log(`  Booking code: ${holdInput.booking_code}`);
  console.log(`  Plan allowed: ${result.plan?.plan_allowed ?? 'n/a'}`);

  if (result.error) {
    console.error(`  Error: ${result.error}`);
    process.exit(1);
  }

  if (result.blocked) {
    console.log(`  Blocked: ${(result.actionable || []).join(', ')}`);
    console.log(`  Wrote ${outPath}\n`);
    process.exit(2);
  }

  if (result.dry_run) {
    console.log(`  Would upsert: yes (no DB write)`);
    console.log(`  Row before: ${result.before ? result.before.booking_id : 'none'}`);
    console.log(`  Wrote ${outPath}\n`);
    process.exit(0);
  }

  console.log(`  Created: ${result.upsert.created}  Updated: ${result.upsert.updated}`);
  console.log(`  booking_id: ${result.after.booking_id}`);
  console.log(`  status: ${result.upsert.booking.status} / ${result.upsert.booking.payment_status}`);
  console.log(`  airtable_record_id: ${result.upsert.booking.airtable_record_id ?? 'null'}`);
  console.log(`  Wrote ${outPath}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
