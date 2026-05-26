/**
 * Phase 3b.4b — Manual Entry mirror in Postgres only (local).
 * create / update / delete from Manual Entries queue semantics; no Airtable or Sheets.
 * Does NOT touch payments or payment_events.
 *
 * Default: dry-run. Requires --execute to mutate.
 */
const { withPgClient } = require('./lib/pg-connect');
const {
  parseManualEntryInput,
  loadManualEntryImpactPlan,
  loadExistingBeds,
  loadCreateBedPlan,
  buildBookingFieldDiff,
  findBookingByManualEntryId,
  partitionBedsForInsert,
  provisionalBookingCode,
} = require('./lib/manual-entry-impact-plan');
const {
  upsertBookingForCreate,
  insertBookingBeds,
  updateBookingFields,
  deleteBedsAndCancelBooking,
  countPayments,
} = require('./lib/manual-entry-pg-sql');

function parseExecuteFlags(argv) {
  const input = parseManualEntryInput(argv);
  const flags = {
    input,
    execute: false,
    strictGuestCount: false,
    allowConflict: false,
    strictOverlap: true,
  };
  for (const arg of argv) {
    if (arg === '--execute') flags.execute = true;
    else if (arg === '--dry-run') flags.execute = false;
    else if (arg === '--strict-guest-count') flags.strictGuestCount = true;
    else if (arg === '--allow-conflict') flags.allowConflict = true;
    else if (arg === '--no-strict-overlap') flags.strictOverlap = false;
  }
  return flags;
}

function usage() {
  console.error(`
Usage: npm run db:manual-entry:postgres -- --action=create|update|delete --manual-entry-id=MAN-... [options]

Create requires: --guest-name --check-in --check-out --beds=R1-B1,...
Update/delete require: --booking-code=WH-rec... OR --airtable-record-id=rec...

Options:
  --execute                      Apply mutations (default: dry-run)
  --strict-guest-count           Refuse --execute on create if beds != guest_count
  --allow-conflict               On overlap: set needs_review/conflict instead of failing
  --no-strict-overlap            Allow --execute despite overlaps (not recommended)
  (plus all flags from db:report:manual-entry-impact)

Dry-run is the default. Run db:report:manual-entry-impact before first --execute.
`);
}

function printBedTable(title, rows) {
  console.log(`\n  ${title} (${rows.length}):\n`);
  if (!rows.length) {
    console.log('    (none)\n');
    return;
  }
  for (const row of rows) {
    console.log(
      `    ${String(row.bed_code || '').padEnd(9)}  ${String(row.assignment_start_date || '').padEnd(11)}  ${String(row.assignment_end_date || '').padEnd(11)}  ${row.natural_key || row.booking_bed_id || ''}`
    );
  }
  console.log('');
}

async function executeCreate(client, plan, flags) {
  const parsed = plan.parsed;
  const createPhase = plan.createPhase;
  const provisionalCode = createPhase.provisional_booking_code;

  if (createPhase.unknown_bed_codes.length) {
    return { error: 'unknown_bed_codes', codes: createPhase.unknown_bed_codes };
  }

  if (flags.strictGuestCount && plan.guestCountCheck?.matches === false) {
    return { error: 'guest_count_mismatch', guestCountCheck: plan.guestCountCheck };
  }

  const dup = await findBookingByManualEntryId(client, plan.clientId, parsed.manual_entry_id);
  if (dup.error) return dup;
  if (
    dup.found &&
    (!plan.bookingMatch.found || plan.bookingMatch.booking_id !== dup.booking_id)
  ) {
    return {
      error: 'duplicate_manual_entry_id',
      existing_booking_code: dup.booking_code,
    };
  }

  const defaultAssignment = {
    assignment_status: 'assigned',
    availability_check_status: 'available',
  };

  await client.query('BEGIN');
  try {
    const bookingResult = await upsertBookingForCreate(
      client,
      plan.clientId,
      parsed,
      provisionalCode,
      defaultAssignment
    );
    if (bookingResult.error) {
      await client.query('ROLLBACK');
      return bookingResult;
    }

    const { booking_id: bookingId, booking_code: bookingCode, booking } = bookingResult;

    if (['cancelled', 'expired'].includes(booking.status)) {
      await client.query('ROLLBACK');
      return { error: 'booking_not_assignable', status: booking.status };
    }

    const existingBeds = await loadExistingBeds(client, plan.clientId, bookingId, bookingCode);

    const overlapId = bookingId;
    const bedPlan = await loadCreateBedPlan(
      client,
      plan.clientId,
      bookingCode,
      overlapId,
      parsed.bed_codes,
      parsed.check_in,
      parsed.check_out
    );

    const candidates = bedPlan.wouldInsert.filter((r) => r.bed_id);
    const { toInsert, skipped } = partitionBedsForInsert(existingBeds, candidates);

    const toInsertCodes = new Set(toInsert.map((r) => r.bed_code));
    const overlapsForInsert = bedPlan.overlapConflicts.filter((c) =>
      toInsertCodes.has(c.proposed_bed_code)
    );
    if (overlapsForInsert.length && flags.strictOverlap && !flags.allowConflict) {
      await client.query('ROLLBACK');
      return { error: 'postgres_overlap_conflicts', conflicts: overlapsForInsert };
    }

    if (toInsert.length === 0 && skipped.length === 0 && candidates.length === 0) {
      await client.query('ROLLBACK');
      return { error: 'unknown_bed_codes', codes: createPhase.unknown_bed_codes };
    }

    const inserted = await insertBookingBeds(
      client,
      plan.clientId,
      bookingId,
      bookingCode,
      parsed.guest_name,
      toInsert
    );

    if (overlapsForInsert.length && flags.allowConflict) {
      await client.query(
        `UPDATE bookings
         SET assignment_status = 'needs_review'::assignment_status,
             availability_check_status = 'conflict'::availability_check_status
         WHERE id = $1 AND client_id = $2`,
        [bookingId, plan.clientId]
      );
    } else if (inserted.length > 0) {
      await client.query(
        `UPDATE bookings
         SET assignment_status = 'assigned'::assignment_status,
             availability_check_status = 'available'::availability_check_status
         WHERE id = $1 AND client_id = $2`,
        [bookingId, plan.clientId]
      );
    }

    const paymentsAfter = await countPayments(client, plan.clientId, bookingId);

    await client.query('COMMIT');

    return {
      mode: 'execute',
      action: 'create',
      bookingResult,
      existing_beds: existingBeds,
      proposed_beds: createPhase.proposed_beds,
      inserted_beds: inserted,
      skipped_beds: skipped,
      overlap_conflicts: overlapsForInsert,
      payments_count: paymentsAfter,
      idempotent: inserted.length === 0 && !bookingResult.created,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function executeUpdate(client, plan, flags) {
  const parsed = plan.parsed;
  const booking = plan.bookingMatch.booking;
  const diff = buildBookingFieldDiff(booking, parsed, {
    explicitOnly: true,
    explicitFields: flags.input.explicitFields,
  });

  if (parsed.bed_codes.length) {
    console.log(
      '  Warning:     --beds ignored on update (MVP: booking fields only; use Reassign for bed changes)'
    );
  }

  await client.query('BEGIN');
  try {
    const updateResult = await updateBookingFields(
      client,
      plan.clientId,
      booking.id,
      diff,
      parsed
    );

    await client.query('COMMIT');

    return {
      mode: 'execute',
      action: 'update',
      booking_code: booking.booking_code,
      booking_id: booking.id,
      existing_beds: await loadExistingBeds(
        client,
        plan.clientId,
        booking.id,
        booking.booking_code
      ),
      fields_would_update: diff,
      updateResult,
      idempotent: updateResult.idempotent,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function executeDelete(client, plan) {
  const booking = plan.bookingMatch.booking;
  const existingBeds = plan.deletePhase.postgres_booking_beds_would_delete;

  await client.query('BEGIN');
  try {
    const deleteResult = await deleteBedsAndCancelBooking(
      client,
      plan.clientId,
      booking.id,
      existingBeds
    );

    await client.query('COMMIT');

    return {
      mode: 'execute',
      action: 'delete',
      booking_code: booking.booking_code,
      booking_id: booking.id,
      existing_beds: existingBeds,
      deleteResult,
      idempotent: deleteResult.idempotent,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

function printCreateDryRun(plan) {
  const c = plan.createPhase;
  console.log(`  Provisional code:  ${c.provisional_booking_code}`);
  console.log(`  PG booking exists: ${c.postgres_booking_already_exists}`);
  console.log('  Proposed booking:');
  const pb = c.proposed_booking;
  console.log(`    guest_name:              ${pb.guest_name}`);
  console.log(`    status:                  ${pb.status}`);
  console.log(`    payment_status:          ${pb.payment_status} (booking mirror only)`);
  console.log(`    assignment_status:       ${pb.assignment_status}`);
  console.log(`    availability_check:      ${pb.availability_check_status}`);
  console.log(`    dates:                   ${pb.check_in} → ${pb.check_out}`);
  console.log(`    guest_count:             ${pb.guest_count}`);
  printBedTable('Proposed booking_beds (insert)', c.would_insert);
  printBedTable('Skipped', c.would_skip);
  if (c.unknown_bed_codes.length) {
    console.log(`  Unknown beds:      ${c.unknown_bed_codes.join(', ')}`);
  }
  if (c.overlap_conflicts.length) {
    console.log(`  PG overlaps:       ${c.overlap_conflicts.length}`);
  }
  if (plan.guestCountCheck) {
    console.log(
      `  Guest count check: ${plan.guestCountCheck.matches === false ? 'MISMATCH' : 'ok'} (${plan.guestCountCheck.would_insert_count} beds vs guest_count=${plan.guestCountCheck.guest_count})`
    );
  }
}

function printUpdateDryRun(plan) {
  const u = plan.updatePhase;
  console.log(`  Booking:           ${plan.bookingMatch.booking_code}`);
  console.log(`  Beds unchanged:    yes (${u.existing_booking_beds_count} existing)`);
  const fields = u.booking_fields_would_update;
  if (!Object.keys(fields).length) {
    console.log('  Field changes:     (none — idempotent update)\n');
    return;
  }
  console.log('  Would UPDATE bookings:');
  for (const [key, ch] of Object.entries(fields)) {
    console.log(`    ${key}: ${ch.current} → ${ch.would_be}`);
  }
  console.log('');
}

function printDeleteDryRun(plan) {
  const d = plan.deletePhase;
  console.log(`  Booking:           ${plan.bookingMatch.booking_code}`);
  console.log(`  Status:            ${d.booking_fields_would_update.status.current} → cancelled`);
  console.log(`  payment_status:    ${d.booking_fields_would_update.payment_status.current} (unchanged)`);
  printBedTable('booking_beds would DELETE', d.postgres_booking_beds_would_delete);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseExecuteFlags(argv);

  if (!flags.input.manualEntryId && !flags.input.jsonFile) {
    usage();
    process.exit(1);
  }

  const mode = flags.execute ? 'EXECUTE' : 'DRY RUN';

  const result = await withPgClient(async (client) => {
    const plan = await loadManualEntryImpactPlan(client, flags.input);
    if (plan.error) return { planError: plan };

    if (!flags.execute) {
      return { mode: 'dry_run', plan };
    }

    if (plan.parsed.action === 'create') {
      return await executeCreate(client, plan, flags);
    }
    if (plan.parsed.action === 'update') {
      return await executeUpdate(client, plan, flags);
    }
    if (plan.parsed.action === 'delete') {
      return await executeDelete(client, plan);
    }
    return { planError: { error: 'invalid_action', parsed: plan.parsed } };
  });

  if (result.planError) {
    const pe = result.planError;
    if (pe.error === 'missing_required_fields') {
      console.error(`\nMissing required fields: ${pe.missing.join(', ')}\n`);
      process.exit(pe.missing.some((f) =>
        ['manual_entry_id', 'action', 'airtable_record_id_or_booking_code'].includes(f)
      ) ? 1 : 2);
    }
    if (pe.error === 'invalid_date_range') {
      console.error(`\nInvalid date range: ${pe.check_in} .. ${pe.check_out}\n`);
      process.exit(2);
    }
    if (pe.error === 'booking_not_found') {
      console.error('\nBooking not found.\n');
      process.exit(1);
    }
    if (pe.error === 'booking_ambiguous') {
      console.error(`\nAmbiguous booking lookup (${pe.matches} rows).\n`);
      process.exit(1);
    }
    if (pe.error === 'client_not_found') {
      console.error(`\nClient not found: ${pe.slug}\n`);
      process.exit(1);
    }
    process.exit(1);
  }

  if (result.error === 'unknown_bed_codes') {
    console.error(`\nUnknown bed code(s): ${result.codes.join(', ')}\n`);
    process.exit(1);
  }
  if (result.error === 'postgres_overlap_conflicts') {
    console.error('\nPostgres overlap conflict(s). Use --allow-conflict or fix dates/beds.\n');
    process.exit(1);
  }
  if (result.error === 'guest_count_mismatch') {
    console.error('\nGuest count mismatch. Use --strict-guest-count only to enforce; fix beds or guest_count.\n');
    process.exit(1);
  }
  if (result.error === 'duplicate_manual_entry_id') {
    console.error(
      `\nDuplicate manual_entry_id already linked to booking ${result.existing_booking_code}\n`
    );
    process.exit(1);
  }
  if (result.error === 'booking_not_assignable') {
    console.error(`\nBooking status "${result.status}" is not assignable.\n`);
    process.exit(1);
  }
  if (result.error === 'booking_ambiguous') {
    console.error(`\nAmbiguous booking lookup (${result.matches} rows).\n`);
    process.exit(1);
  }

  console.log(`\nPhase 3b.4b — Manual Entry Postgres mirror [${mode}]\n`);
  console.log(`  Manual Entry ID:   ${result.plan?.parsed?.manual_entry_id || result.bookingResult?.booking?.booking_code || ''}`);
  console.log(`  Action:            ${result.plan?.parsed?.action || result.action}`);

  if (result.mode === 'dry_run') {
    const plan = result.plan;
    console.log(`  Payments:          ${plan.payments.payments.length} row(s) (untouched)`);
    if (plan.actionable?.length) {
      console.log(`  Actionable:        ${plan.actionable.join(', ')}`);
    }
    if (plan.warnings?.length) {
      console.log('  Warnings:');
      for (const w of plan.warnings) console.log(`    - ${w}`);
    }

    if (plan.parsed.action === 'create') printCreateDryRun(plan);
    else if (plan.parsed.action === 'update') printUpdateDryRun(plan);
    else if (plan.parsed.action === 'delete') printDeleteDryRun(plan);

    console.log('\n  No mutations (dry-run). Pass --execute to apply.');
    console.log(
      '  Tip: npm run db:report:manual-entry-impact -- (same flags)\n'
    );
    process.exit(plan.actionable?.length ? 2 : 0);
  }

  if (result.action === 'create') {
    const br = result.bookingResult;
    console.log(`  Booking:           ${br.booking_code} (${br.booking_id})`);
    console.log(`  Booking row:       ${br.created ? 'INSERT' : 'UPDATE'}`);
    console.log(`  Payments:          ${result.payments_count} row(s) (untouched)`);
    printBedTable('Existing booking_beds before', result.existing_beds);
    printBedTable('Inserted booking_beds', result.inserted_beds);
    printBedTable('Skipped (already assigned)', result.skipped_beds);
    console.log('  EXECUTE summary:');
    console.log(`    inserted booking_beds: ${result.inserted_beds.length}`);
    console.log(`    skipped:               ${result.skipped_beds.length}`);
    if (result.idempotent) {
      console.log('    idempotent:            yes (0 beds inserted; booking unchanged or already mirrored)');
    }
  }

  if (result.action === 'update') {
    console.log(`  Booking:           ${result.booking_code}`);
    console.log(`  Payments:          ${result.updateResult.payments_count} row(s) (untouched)`);
    printBedTable('Existing booking_beds (unchanged)', result.existing_beds);
    console.log('  EXECUTE summary:');
    console.log(`    booking fields updated: ${result.updateResult.fields_updated.join(', ') || '(none)'}`);
    if (result.idempotent) console.log('    idempotent:            yes');
  }

  if (result.action === 'delete') {
    const dr = result.deleteResult;
    console.log(`  Booking:           ${result.booking_code}`);
    console.log(`  Payments:          ${dr.payments_count} row(s) (untouched)`);
    console.log(`  payment_status:    ${dr.payment_status_before} (unchanged)`);
    printBedTable('Deleted booking_beds', dr.beds_deleted_detail);
    console.log('  EXECUTE summary:');
    console.log(`    deleted booking_beds:  ${dr.deleted_beds}`);
    console.log(`    status:                ${dr.status_before} → ${dr.status_after}`);
    if (dr.idempotent) console.log('    idempotent:            yes');
  }

  console.log(
    '\n  Airtable / Sheets unchanged. Re-run db:report:bed-drift and planning:report:postgres.\n'
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
