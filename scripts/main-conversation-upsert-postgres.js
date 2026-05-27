/**
 * Phase 3c.d.4 — Conversation upsert execute (conversations only).
 */
const fs = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const {
  parseConversationUpsertInput,
  buildConversationUpsertPlan,
  upsertConversationForHold,
} = require('./lib/main-conversation-pg-sql');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

function usage() {
  console.error(`
Usage: npm run db:main-conversation-upsert:postgres -- --phone=+353300000001 --booking-code=WH-3C-ACTIVE-HOLD-GUARD-001 [options]

Required:
  --phone=+353...
  --booking-code=WH-...

Optional:
  --conversation-stage=booking_flow|payment_pending  Default from booking.status
  --session-state-json='{"check_in":"2026-08-07"}'   Shallow merge into session_state
  --pending-action=...
  --language=en
  --airtable-record-id=rec...   Set only if current airtable_record_id is null
  --needs-human=true            Only sets true when passed; never clears handoff
  --bot-mode=bot|staff|paused   Only when passed
  --client=wolfhouse-somo

Default dry-run. --execute to write.
No messages, booking_beds, payments, or payment_events.
`);
}

function parseArgv(argv) {
  const raw = {
    client_slug: 'wolfhouse-somo',
    phone: null,
    booking_code: null,
    conversation_stage: null,
    pending_action: null,
    language: null,
    airtable_record_id: null,
    session_state_json: null,
    needs_human: undefined,
    bot_mode: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--phone=')) raw.phone = arg.slice(8);
    else if (arg === '--phone' && argv[i + 1]) raw.phone = argv[++i];
    else if (arg.startsWith('--booking-code=')) raw.booking_code = arg.slice(15);
    else if (arg === '--booking-code' && argv[i + 1]) raw.booking_code = argv[++i];
    else if (arg.startsWith('--conversation-stage=')) raw.conversation_stage = arg.slice(21);
    else if (arg.startsWith('--session-state-json=')) {
      raw.session_state_json = arg.slice(21);
    } else if (arg.startsWith('--pending-action=')) raw.pending_action = arg.slice(17);
    else if (arg.startsWith('--language=')) raw.language = arg.slice(11);
    else if (arg.startsWith('--airtable-record-id=')) raw.airtable_record_id = arg.slice(21);
    else if (arg.startsWith('--client=')) raw.client_slug = arg.slice(9);
    else if (arg.startsWith('--needs-human=')) raw.needs_human = arg.slice(14);
    else if (arg.startsWith('--bot-mode=')) raw.bot_mode = arg.slice(11);
  }

  return parseConversationUpsertInput(raw);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const execute = argv.includes('--execute');
  const input = parseArgv(argv);

  if (!input.phone || !input.booking_code) {
    usage();
    process.exit(1);
  }

  const result = await withPgClient(async (client) => {
    if (!execute) {
      return buildConversationUpsertPlan(client, input, { execute: false });
    }
    return upsertConversationForHold(client, input);
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = input.booking_code.replace(/[^\w-]/g, '_');
  const outPath = path.join(
    REPORTS_DIR,
    `main-conversation-upsert-${safe}-${execute ? 'execute' : 'dry-run'}-${stamp}.json`
  );
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({ generated_at: new Date().toISOString(), ...result }, null, 2)
  );

  console.log(`\nPhase 3c.d.4 — Conversation upsert ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`);
  console.log(`  phone: ${input.phone}`);
  console.log(`  booking_code: ${input.booking_code}`);

  if (result.error) {
    console.error(`  Error: ${result.error}`);
    if (result.actionable?.length) {
      console.log(`  Actionable: ${result.actionable.join(', ')}`);
      process.exit(2);
    }
    process.exit(1);
  }

  if (!result.plan_allowed) {
    console.log(`  Blocked: ${(result.actionable || []).join(', ')}`);
    process.exit(2);
  }

  if (!execute) {
    console.log(`  Would: ${result.would_create ? 'INSERT' : 'UPDATE'} conversation`);
    console.log(`  current_hold_booking_id: ${result.would_write.current_hold_booking_id}`);
    console.log(`  stage: ${result.would_write.conversation_stage}`);
    process.exit(0);
  }

  console.log(`  conversation_id: ${result.conversation_id}`);
  console.log(`  created: ${result.created}  updated: ${result.updated}`);
  console.log(`  current_hold_booking_id: ${result.conversation?.current_hold_booking_id}`);
  console.log(`  stage: ${result.conversation?.conversation_stage}`);
  console.log(`  Wrote ${outPath}\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
