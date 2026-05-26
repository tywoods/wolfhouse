/**
 * Phase 3b.4a — Manual Entry impact report (read-only).
 * Simulates mirroring a Manual Entries queue row into Postgres; no mutations.
 *
 * Usage:
 *   npm run db:report:manual-entry-impact -- --action=create --manual-entry-id=MAN-test ...
 */
const fs = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const { toIsoDateString } = require('./lib/bed-drift-keys');
const { formatPlanningRowFromPostgres } = require('./lib/planning-row-format');
const {
  parseManualEntryInput,
  loadManualEntryImpactPlan,
} = require('./lib/manual-entry-impact-plan');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

function usage() {
  console.error(`
Usage: npm run db:report:manual-entry-impact -- [options]

Required:
  --manual-entry-id=MAN-...     Queue row id
  --action=create|update|delete   Or derive via --sync-status

Create also requires:
  --guest-name=... --check-in=YYYY-MM-DD --check-out=YYYY-MM-DD --beds=R1-B1,...

Update/delete also require:
  --booking-code=WH-rec...  OR  --airtable-record-id=rec...

Optional:
  --sync-status=ready|update ready|delete ready
  --guest-count=N --status=Confirmed --payment-status=waiting_payment --package=malibu
  --json-file=path.json         Full queue item snapshot (n8n pick-node shape)
  --client=wolfhouse-somo

Read-only: no Postgres, Airtable, Sheets, or payment mutations.
`);
}

function buildPlanningRow(bookingLike, row, extra = {}) {
  const formatted = formatPlanningRowFromPostgres({
    booking_code: bookingLike.booking_code,
    airtable_record_id: bookingLike.airtable_record_id,
    booking_source: bookingLike.booking_source || 'manual_staff',
    guest_name: bookingLike.guest_name,
    guest_count: bookingLike.guest_count,
    status: bookingLike.status,
    payment_status: bookingLike.payment_status,
    assignment_status: extra.assignment_status || bookingLike.assignment_status || 'assigned',
    package_code: bookingLike.package_code,
    deposit_paid_cents: null,
    requested_room_type: bookingLike.requested_room_type,
    room_preference: bookingLike.room_preference,
    guest_gender_group_type: bookingLike.guest_gender_group_type,
    assignment_start_date: row.assignment_start_date,
    assignment_end_date: row.assignment_end_date,
    room_code: row.room_code,
    bed_code: row.bed_code,
    assignment_notes: null,
    planning_row_label: null,
  });
  return {
    bed_code: String(row.bed_code || '').toUpperCase(),
    assignment_start_date: toIsoDateString(row.assignment_start_date),
    assignment_end_date: toIsoDateString(row.assignment_end_date),
    display_text: formatted['Display Text'],
    color_type: formatted['Color Type'],
    ...extra,
  };
}

function buildSummary(plan) {
  const parsed = plan.parsed;
  const action = parsed.action;
  const create = plan.createPhase;
  const update = plan.updatePhase;
  const del = plan.deletePhase;

  return {
    action,
    would_create_booking: action === 'create' && !plan.bookingMatch.found,
    would_update_booking:
      action === 'update' ||
      (action === 'create' && plan.bookingMatch.found) ||
      action === 'delete',
    would_delete_beds_count: del ? del.postgres_booking_beds_would_delete.length : 0,
    would_insert_beds_count: create ? create.would_insert.length : 0,
    would_skip_beds_count: create ? create.would_skip.length : 0,
    unknown_bed_codes_count: create ? create.unknown_bed_codes.length : 0,
    overlap_conflicts_count: create ? create.overlap_conflicts.length : 0,
    guest_count_matches: plan.guestCountCheck?.matches ?? null,
    payments_rows: plan.payments.payments.length,
    payment_events_rows: plan.payments.payment_events_count,
  };
}

async function main() {
  const input = parseManualEntryInput(process.argv.slice(2));

  if (!input.manualEntryId && !input.jsonFile) {
    usage();
    process.exit(1);
  }

  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const plan = await withPgClient((client) => loadManualEntryImpactPlan(client, input));

  if (plan.error === 'missing_required_fields') {
    console.error(
      `\nManual entry impact: missing required fields: ${plan.missing.join(', ')}\n`
    );
    const fatal = plan.missing.some((f) =>
      ['manual_entry_id', 'action', 'airtable_record_id_or_booking_code'].includes(f)
    );
    process.exit(fatal ? 1 : 2);
  }
  if (plan.error === 'invalid_date_range') {
    console.error(
      `\nManual entry impact: invalid date range ${plan.check_in} .. ${plan.check_out}\n`
    );
    process.exit(2);
  }
  if (plan.error === 'client_not_found') {
    console.error(`\nManual entry impact: client not found: ${plan.slug}\n`);
    process.exit(1);
  }
  if (plan.error === 'booking_not_found') {
    console.error(
      `\nManual entry impact: booking not found (${plan.parsed.booking_code || plan.parsed.airtable_record_id})\n`
    );
    process.exit(1);
  }
  if (plan.error === 'booking_ambiguous') {
    console.error(`\nManual entry impact: ambiguous booking lookup (${plan.matches} rows)\n`);
    process.exit(1);
  }

  const parsed = plan.parsed;
  const summary = buildSummary(plan);

  const bookingLikeForPlanning = plan.createPhase?.proposed_booking ||
    plan.bookingMatch.booking || {
      booking_code: plan.createPhase?.provisional_booking_code,
      guest_name: parsed.guest_name,
      guest_count: parsed.guest_count,
      status: parsed.status,
      payment_status: parsed.payment_status,
      package_code: parsed.package_code,
      booking_source: 'manual_staff',
      airtable_record_id: parsed.airtable_record_id,
      assignment_status: plan.createPhase?.proposed_booking?.assignment_status || 'assigned',
    };

  const planningRowsBefore = [];
  const planningRowsAfter = [];

  if (plan.deletePhase && plan.bookingMatch.booking) {
    const b = plan.bookingMatch.booking;
    for (const row of plan.deletePhase.postgres_booking_beds_would_delete) {
      planningRowsBefore.push(
        buildPlanningRow(
          {
            booking_code: b.booking_code,
            airtable_record_id: b.airtable_record_id,
            booking_source: b.booking_source,
            guest_name: b.guest_name,
            guest_count: b.guest_count,
            status: b.status,
            payment_status: b.payment_status,
            package_code: b.package_code,
            assignment_status: b.assignment_status,
          },
          row
        )
      );
    }
  }

  if (plan.createPhase) {
    const pb = plan.createPhase.proposed_booking;
    for (const row of plan.createPhase.would_insert) {
      planningRowsAfter.push(
        buildPlanningRow(
          {
            booking_code:
              plan.bookingMatch.booking_code || plan.createPhase.provisional_booking_code,
            airtable_record_id: pb.airtable_record_id,
            booking_source: 'manual_staff',
            guest_name: pb.guest_name,
            guest_count: pb.guest_count,
            status: pb.status,
            payment_status: pb.payment_status,
            package_code: pb.package_code,
            assignment_status: pb.assignment_status,
          },
          row,
          { is_new_after_manual_create: true }
        )
      );
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    phase: '3b.4a',
    read_only: true,
    no_mutations: true,
    no_delete: true,
    no_insert: true,
    no_update: true,
    input: {
      manual_entry_id: parsed.manual_entry_id,
      action: parsed.action,
      sync_status: parsed.sync_status,
      client_slug: input.clientSlug,
      parsed_from: input.parsedFrom,
      json_file: input.jsonFile || null,
    },
    parsed_manual_entry: {
      guest_name: parsed.guest_name,
      check_in: parsed.check_in,
      check_out: parsed.check_out,
      guest_count: parsed.guest_count,
      bed_codes: parsed.bed_codes,
      status: parsed.status,
      payment_status: parsed.payment_status,
      package_code: parsed.package_code,
      booking_source: parsed.booking_source,
      airtable_record_id: parsed.airtable_record_id,
      booking_code: parsed.booking_code,
    },
    validation: {
      missing_required_fields: [],
      invalid_date_range: false,
      actionable_gate_ok: plan.actionable.length === 0,
    },
    postgres_booking_match: {
      found: plan.bookingMatch.found,
      match_by: plan.bookingMatch.match_by,
      booking_id: plan.bookingMatch.booking_id || null,
      booking_code: plan.bookingMatch.booking_code || null,
      ambiguous_count: plan.bookingMatch.ambiguous_count || 0,
    },
    summary,
    create_phase: plan.createPhase,
    update_phase: plan.updatePhase,
    delete_phase: plan.deletePhase,
    guest_count_check: plan.guestCountCheck,
    payments_untouched: {
      policy:
        'No INSERT/UPDATE/DELETE on payments or payment_events; payment_status mirror on booking only in 3b.4b+',
      payments_count: plan.payments.payments.length,
      payment_events_count: plan.payments.payment_events_count,
      payment_status_would_change_on_booking:
        plan.updatePhase?.booking_fields_would_update?.payment_status != null,
      payments: plan.payments.payments,
    },
    planning_report_impact: {
      rows_before: planningRowsBefore,
      rows_after: planningRowsAfter,
      planning_delta: {
        added_count: planningRowsAfter.length,
        removed_count: planningRowsBefore.length,
        bed_codes_added: planningRowsAfter.map((r) => r.bed_code),
        bed_codes_removed: planningRowsBefore.map((r) => r.bed_code),
      },
    },
    warnings: [...plan.warnings],
    actionable: [...plan.actionable],
  };

  if (plan.createPhase?.unknown_bed_codes?.length) {
    report.warnings.push(
      `unknown_bed_codes: ${plan.createPhase.unknown_bed_codes.join(', ')}`
    );
  }
  if (plan.createPhase?.overlap_conflicts?.length) {
    report.warnings.push(
      `postgres_overlap_conflicts: ${plan.createPhase.overlap_conflicts.length} conflict(s)`
    );
  }
  if (plan.guestCountCheck?.matches === false) {
    report.warnings.push(
      `guest_count_mismatch: guest_count=${plan.guestCountCheck.guest_count} would_insert=${plan.guestCountCheck.would_insert_count}`
    );
  }

  const stamp = report.generated_at.replace(/[:.]/g, '-').slice(0, 19);
  const safeId = String(parsed.manual_entry_id || 'unknown').replace(/[^\w-]/g, '_');
  const outPath = path.join(REPORTS_DIR, `manual-entry-impact-${safeId}-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  const s = report.summary;
  console.log('\nPhase 3b.4a — Manual Entry impact report (read-only)\n');
  console.log(`  Manual Entry ID:   ${parsed.manual_entry_id}`);
  console.log(`  Action:            ${parsed.action}`);
  console.log(`  PG booking match:  ${report.postgres_booking_match.found ? report.postgres_booking_match.booking_code : 'none'}`);
  console.log(`  Would insert beds: ${s.would_insert_beds_count}`);
  console.log(`  Would delete beds: ${s.would_delete_beds_count}`);
  console.log(`  Unknown beds:      ${s.unknown_bed_codes_count}`);
  console.log(`  PG overlaps:       ${s.overlap_conflicts_count}`);
  console.log(`  Guest count OK:    ${s.guest_count_matches ?? 'n/a'}`);
  console.log(`  Payments:          ${s.payments_rows} rows (untouched)`);
  console.log(`  Planning after:    ${report.planning_report_impact.rows_after.length} row(s)`);
  if (report.warnings.length) {
    console.log('\n  Warnings:');
    for (const w of report.warnings) console.log(`    - ${w}`);
  }
  console.log(`\nWrote ${outPath}`);
  console.log('No Postgres, Airtable, Sheets, or payment mutations.\n');

  if (report.actionable.length) {
    console.log(`Manual entry impact: actionable: ${report.actionable.join(', ')}. Exit 2.\n`);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
