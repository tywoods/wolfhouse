/**
 * Phase 3b.5a — Operator Room Release impact report (read-only).
 * SELECT-only; no Postgres/Airtable/Sheets/payment mutations.
 *
 * Usage:
 *   npm run db:report:operator-room-release-impact -- --operator="Surf Week" --room-code=R7 --release-start=2027-06-01 --release-end=2027-06-08
 */
const fs = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const {
  INPUT_SURFACE_RECOMMENDATION,
  ROOM_MATCH_RULE,
  OPERATOR_MATCH_RULE,
  parseOperatorRoomReleaseInput,
  loadOperatorRoomReleaseImpactPlan,
} = require('./lib/operator-room-release-impact-plan');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

function usage() {
  console.error(`
Usage: npm run db:report:operator-room-release-impact -- [options]

Required:
  --operator="Surf Week Co"       Operator name (trimmed exact match)
  --room-code=R7                Room code (e.g. R7)
  --release-start=YYYY-MM-DD    Release window start (exclusive end of block A)
  --release-end=YYYY-MM-DD      Release window end (exclusive start of block B)

Optional:
  --client=wolfhouse-somo       Client slug (default wolfhouse-somo)
  --request-code=...            Preview operator_room_release_requests.request_code
  --notes=...                   Staff notes preview
  --json-file=path.json         Webhook/form body snapshot
  --release-record-id=rec...    Deprecated — logged as warning only; no Airtable API

Read-only: SELECT on Postgres only. No writes, webhooks, or Airtable calls.
`);
}

function buildParsedInput(input) {
  return {
    operator: input.operator,
    room_code: input.roomCode,
    release_start: input.releaseStart,
    release_end: input.releaseEnd,
    client_slug: input.clientSlug,
    request_code: input.requestCode,
    notes: input.notes,
    release_record_id: input.releaseRecordId,
    json_file: input.jsonFile,
    parsed_from: input.parsedFrom,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  let input;
  try {
    input = parseOperatorRoomReleaseInput(argv);
  } catch (err) {
    console.error(`Failed to parse input: ${err.message}`);
    usage();
    process.exit(1);
  }

  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const plan = await withPgClient((client) => loadOperatorRoomReleaseImpactPlan(client, input));

  if (plan.error === 'missing_required_fields') {
    console.error(`Missing required fields: ${plan.validation.missing.join(', ')}`);
    usage();
    process.exit(1);
  }
  if (plan.error === 'invalid_date_range') {
    console.error('Invalid date range: release_end must be after release_start');
    process.exit(1);
  }
  if (plan.error === 'client_not_found') {
    console.error(`Client not found: ${plan.client_slug}`);
    process.exit(1);
  }
  if (plan.error === 'room_not_found') {
    console.error(`Room not found in Postgres: ${plan.room_code} (client ${plan.client_slug})`);
    process.exit(1);
  }

  const report = {
    generated_at: new Date().toISOString(),
    phase: '3b.5a',
    read_only: true,
    no_mutations: true,
    no_delete: true,
    no_insert: true,
    no_update: true,
    parsed_input: buildParsedInput(input),
    input_surface_recommendation: INPUT_SURFACE_RECOMMENDATION,
    room_match_rule: ROOM_MATCH_RULE,
    operator_match_rule: OPERATOR_MATCH_RULE,
    validation: plan.validation,
    match_phase: plan.match_phase,
    cancel_phase: plan.cancel_phase,
    split_phase: plan.split_phase,
    create_blocks_phase: plan.create_blocks_phase,
    overlap_conflicts: plan.overlap_conflicts,
    payments_untouched: plan.payments_untouched,
    operator_room_release_request_preview: plan.operator_room_release_request_preview,
    warnings: plan.warnings,
    actionable: plan.actionable,
    hosted_parity_notes: plan.hosted_parity_notes,
    summary: {
      found_match: plan.match_phase.found_match,
      match_count: plan.match_phase.match_count,
      booking_beds_would_remove: plan.cancel_phase?.booking_beds_affected?.length ?? 0,
      new_blocks_count: plan.create_blocks_phase?.new_booking_count ?? 0,
      overlap_conflicts_count: plan.overlap_conflicts.length,
      payments_rows: plan.payments_untouched.payments_count,
    },
  };

  const stamp = report.generated_at.replace(/[:.]/g, '-').slice(0, 19);
  const safeRoom = String(input.roomCode || 'unknown').replace(/[^\w-]/g, '_');
  const outPath = path.join(REPORTS_DIR, `operator-room-release-impact-${safeRoom}-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  const s = report.summary;
  console.log('\nPhase 3b.5a — Operator Room Release impact report (read-only)\n');
  console.log(`  Operator:          ${input.operator}`);
  console.log(`  Room:              ${input.roomCode}`);
  console.log(`  Release:           ${input.releaseStart} → ${input.releaseEnd}`);
  console.log(`  Match count:       ${s.match_count}`);
  console.log(`  Found match:       ${s.found_match}`);
  if (s.found_match) {
    console.log(`  Original booking:  ${plan.cancel_phase.original_booking_preview.booking_code}`);
    console.log(`  Beds would remove: ${s.booking_beds_would_remove}`);
    console.log(`  New blocks:        ${s.new_blocks_count}`);
    console.log(`  Block A:           ${plan.split_phase.should_create_a}`);
    console.log(`  Block B:           ${plan.split_phase.should_create_b}`);
  }
  console.log(`  Overlap conflicts: ${s.overlap_conflicts_count}`);
  console.log(`  Payments rows:     ${s.payments_rows} (untouched)`);
  if (report.warnings.length) {
    console.log('\n  Warnings:');
    for (const w of report.warnings) console.log(`    - ${w}`);
  }
  console.log(`\nWrote ${outPath}`);
  console.log('No Postgres writes, Airtable, Sheets, webhooks, or payment mutations.\n');

  if (report.actionable.length) {
    console.log(`Operator room release impact: actionable: ${report.actionable.join(', ')}. Exit 2.\n`);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
