/**
 * Phase 3c.d.2 — Main conversation state report (SELECT-only).
 */
const fs = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const {
  buildConversationStateReport,
  parseConversationStateInput,
} = require('./lib/main-conversation-state-plan');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

function usage() {
  console.error(`
Usage: npm run db:report:main-conversation-state -- --phone=+353300000001 [options]

Required:
  --phone=+353...                   Guest phone (same key as Main Search Conversation)

Optional:
  --booking-code=WH-3C-...          Simulate Current Hold ID / hold-id search
  --client=wolfhouse-somo           Default client slug
  --json-file=path.json             Merge phone/booking_code/client from JSON

Read-only: SELECT on clients, conversations, messages, bookings only.
No payments/payment_events. No Airtable API. No INSERT/UPDATE/DELETE.
`);
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const raw = {
    client_slug: 'wolfhouse-somo',
    phone: null,
    booking_code: null,
  };
  let jsonFile = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--phone=')) raw.phone = arg.slice(8);
    else if (arg === '--phone' && argv[i + 1]) raw.phone = argv[++i];
    else if (arg.startsWith('--booking-code=')) raw.booking_code = arg.slice(15);
    else if (arg === '--booking-code' && argv[i + 1]) raw.booking_code = argv[++i];
    else if (arg.startsWith('--client=')) raw.client_slug = arg.slice(9);
    else if (arg.startsWith('--json-file=')) jsonFile = arg.slice(12);
  }

  if (jsonFile) {
    const abs = path.isAbsolute(jsonFile) ? jsonFile : path.join(process.cwd(), jsonFile);
    Object.assign(raw, JSON.parse(fs.readFileSync(abs, 'utf8')));
  }

  return parseConversationStateInput(raw);
}

function printSummary(report) {
  console.log('\nPhase 3c.d.2 — Conversation state (SELECT-only)\n');
  console.log(`  read_only: ${report.read_only}  no_mutations: ${report.no_mutations}`);
  console.log(`  phone: ${report.parsed_input.phone}`);
  if (report.parsed_input.booking_code) {
    console.log(`  booking_code: ${report.parsed_input.booking_code}`);
  }

  if (report.error) {
    console.error(`  Error: ${report.error}`);
    return;
  }

  const conv = report.pg_conversation_match;
  console.log(`  PG conversation: ${conv.table_exists ? (conv.row ? 'found' : 'none') : 'table missing'}`);
  if (conv.row) {
    console.log(`    stage: ${conv.row.conversation_stage || '(null)'}`);
    console.log(`    current_hold_booking_id: ${conv.row.current_hold_booking_id || '(null)'}`);
    console.log(`    linked booking_code: ${conv.row.linked_hold_booking_code || '(null)'}`);
    console.log(`    messages: ${conv.message_count}`);
  }

  console.log(`  Active holds (hold/payment_pending): ${report.pg_active_hold_candidates.count}`);
  for (const b of report.pg_active_hold_candidates.rows.slice(0, 3)) {
    console.log(`    - ${b.booking_code} ${b.status}/${b.payment_status} id=${b.booking_id}`);
  }

  const prev = report.current_hold_resolution_preview;
  console.log(`  PG would pick: ${prev.pick_source}`);
  if (prev.pg_would_pick) {
    console.log(
      `    ${prev.pg_would_pick.booking_code} (${prev.pg_would_pick.booking_id}) status=${prev.pg_would_pick.status}`
    );
  }

  if (report.fixture_missing) {
    console.log(`  Fixture: ${report.fixture_missing}`);
  }

  if (report.actionable?.length) {
    console.log(`  Actionable: ${report.actionable.join(', ')}`);
  }
  console.log(`  Risks: ${report.risks.length}`);
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  if (!input.phone) {
    usage();
    process.exit(1);
  }

  const report = await withPgClient((client) => buildConversationStateReport(client, input));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const phoneSafe = input.phone.replace(/[^\d+]/g, '');
  const outPath = path.join(REPORTS_DIR, `main-conversation-state-${phoneSafe}-${stamp}.json`);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({ generated_at: new Date().toISOString(), output_file: outPath, ...report }, null, 2)
  );

  printSummary(report);
  console.log(`\n  Wrote ${outPath}\n`);

  process.exit(report.actionable?.length ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
