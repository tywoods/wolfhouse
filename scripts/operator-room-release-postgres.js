/**
 * Phase 3b.5b — Operator Room Release mirror in Postgres only (local).
 * Default: dry-run. Requires --execute to mutate.
 * Does NOT touch payments, payment_events, Airtable, or Sheets.
 */
const { withPgClient } = require('./lib/pg-connect');
const {
  parseOperatorRoomReleaseInput,
  loadOperatorRoomReleaseImpactPlan,
} = require('./lib/operator-room-release-impact-plan');
const {
  findCompletedRequestByCode,
  executeOperatorRoomRelease,
  loadBookingSummary,
} = require('./lib/operator-room-release-pg-sql');

function parseFlags(argv) {
  const input = parseOperatorRoomReleaseInput(argv);
  const flags = {
    input,
    execute: false,
    allowOverlap: false,
  };
  for (const arg of argv) {
    if (arg === '--execute') flags.execute = true;
    else if (arg === '--dry-run') flags.execute = false;
    else if (arg === '--allow-overlap') flags.allowOverlap = true;
  }
  return flags;
}

function usage() {
  console.error(`
Usage: npm run db:operator-room-release:postgres -- --operator=... --room-code=R7 --release-start=YYYY-MM-DD --release-end=YYYY-MM-DD

Required:
  --operator=...           Operator name (trimmed exact match)
  --room-code=R7           Room code
  --release-start=...      Release window start
  --release-end=...        Release window end (must be after start)

Optional:
  --client=wolfhouse-somo
  --request-code=...       Recommended for idempotency
  --notes=...
  --json-file=path.json
  --execute                Apply mutations (default: dry-run)
  --allow-overlap            Allow execute despite overlap_conflicts

Dry-run is the default. Run db:report:operator-room-release-impact before first --execute.
`);
}

function printDryRun(plan, input) {
  const m = plan.match_phase;
  const c = plan.cancel_phase;
  const s = plan.split_phase;
  const cb = plan.create_blocks_phase;

  console.log(`  Match:             ${m.found_match} (${m.match_count} candidate(s))`);
  if (m.found_match && c) {
    console.log(`  Original booking:  ${c.original_booking_preview.booking_code}`);
    console.log(`  Beds would DELETE: ${c.booking_beds_affected.length}`);
    console.log(`  Original status:   ${c.booking_fields_would_change_if_executed.status.from} → cancelled`);
  }
  if (s) {
    console.log(`  Block A:           ${s.should_create_a}${s.block_a ? ` (${s.block_a.check_in} → ${s.block_a.check_out})` : ''}`);
    console.log(`  Block B:           ${s.should_create_b}${s.block_b ? ` (${s.block_b.check_in} → ${s.block_b.check_out})` : ''}`);
    if (c?.original_booking_preview?.booking_code) {
      const base = c.original_booking_preview.booking_code;
      if (s.should_create_a) console.log(`  Block A code:      ${base}-A`);
      if (s.should_create_b) console.log(`  Block B code:      ${base}-B`);
    }
  }
  if (cb) {
    console.log(`  New bookings:      ${cb.new_booking_count} (no booking_beds in release workflow)`);
  }
  console.log(`  Overlap conflicts: ${plan.overlap_conflicts.length}`);
  console.log(
    `  Payments:          ${plan.payments_untouched.payments_count} row(s), events ${plan.payments_untouched.payment_events_count} (untouched)`
  );
  if (input.requestCode) {
    console.log(`  Request code:      ${input.requestCode}`);
  }
  if (plan.warnings.length) {
    console.log('  Warnings:');
    for (const w of plan.warnings) console.log(`    - ${w}`);
  }
  if (plan.actionable.length) {
    console.log(`  Actionable:        ${plan.actionable.join(', ')}`);
  }
}

async function verifyAfterExecute(client, clientId, result) {
  const orig = await loadBookingSummary(client, clientId, result.original_booking_id);
  const { rows: bedCount } = await client.query(
    `SELECT COUNT(*)::int AS c FROM booking_beds WHERE client_id = $1 AND booking_id = $2`,
    [clientId, result.original_booking_id]
  );
  const checks = {
    original_status: orig?.status,
    original_beds: bedCount[0].c,
    block_a: result.block_a,
    block_b: result.block_b,
  };
  return checks;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const flags = parseFlags(argv);
  const { input } = flags;

  if (input.showHelp) {
    usage();
    process.exit(0);
  }

  const mode = flags.execute ? 'EXECUTE' : 'DRY RUN';

  const outcome = await withPgClient(async (client) => {
    const plan = await loadOperatorRoomReleaseImpactPlan(client, input);

    if (plan.error === 'missing_required_fields') {
      return { error: 'missing_required_fields', missing: plan.validation?.missing };
    }
    if (plan.error === 'invalid_date_range') {
      return { error: 'invalid_date_range' };
    }
    if (plan.error === 'client_not_found') {
      return { error: 'client_not_found', slug: plan.client_slug };
    }
    if (plan.error === 'room_not_found') {
      return { error: 'room_not_found', room_code: plan.room_code };
    }

    const clientId = plan.client_id;

    if (!flags.allowOverlap && plan.overlap_conflicts?.length) {
      return { error: 'overlap_conflicts', plan, count: plan.overlap_conflicts.length };
    }

    if (!flags.execute) {
      if (plan.actionable?.length) {
        return { mode: 'dry_run', plan, actionable: plan.actionable };
      }
      return { mode: 'dry_run', plan };
    }

    if (input.requestCode) {
      const completed = await findCompletedRequestByCode(client, clientId, input.requestCode);
      if (completed) {
        const orig = await loadBookingSummary(client, clientId, completed.original_booking_id);
        const blockA = completed.new_booking_a_id
          ? await loadBookingSummary(client, clientId, completed.new_booking_a_id)
          : null;
        const blockB = completed.new_booking_b_id
          ? await loadBookingSummary(client, clientId, completed.new_booking_b_id)
          : null;
        return {
          mode: 'execute',
          idempotent: true,
          request_code: input.requestCode,
          original_booking: orig,
          block_a: blockA,
          block_b: blockB,
        };
      }
    }

    if (plan.actionable?.length) {
      return { error: 'actionable', plan, actionable: plan.actionable };
    }

    const result = await executeOperatorRoomRelease(client, plan, input);
    if (result.idempotent) {
      return { mode: 'execute', idempotent: true, ...result };
    }
    if (result.error) {
      return { mode: 'execute', error: result.error, details: result };
    }

    const verify = await verifyAfterExecute(client, clientId, result);
    return { mode: 'execute', result, verify, plan };
  });

  console.log(`\nPhase 3b.5b — Operator Room Release Postgres mirror [${mode}]\n`);
  console.log(`  Operator:          ${input.operator}`);
  console.log(`  Room:              ${input.roomCode}`);
  console.log(`  Release:           ${input.releaseStart} → ${input.releaseEnd}`);
  if (input.requestCode) console.log(`  Request code:      ${input.requestCode}`);

  if (outcome.error === 'missing_required_fields') {
    console.error(`\nMissing: ${outcome.missing?.join(', ')}\n`);
    usage();
    process.exit(1);
  }
  if (outcome.error === 'invalid_date_range') {
    console.error('\nInvalid date range: release_end must be after release_start.\n');
    process.exit(1);
  }
  if (outcome.error === 'client_not_found') {
    console.error(`\nClient not found: ${outcome.slug}\n`);
    process.exit(1);
  }
  if (outcome.error === 'room_not_found') {
    console.error(`\nRoom not found: ${outcome.room_code}\n`);
    process.exit(1);
  }
  if (outcome.error === 'overlap_conflicts') {
    console.error(`\n${outcome.count} overlap conflict(s). Use --allow-overlap or fix inventory.\n`);
    process.exit(1);
  }
  if (outcome.error === 'actionable') {
    console.error(`\nActionable: ${outcome.actionable.join(', ')}\n`);
    console.error('Fix plan or run db:report:operator-room-release-impact first.\n');
    process.exit(2);
  }

  if (outcome.mode === 'dry_run') {
    printDryRun(outcome.plan, input);
    console.log('\n  No mutations (dry-run). Pass --execute to apply.');
    console.log('  Tip: npm run db:report:operator-room-release-impact -- (same flags)\n');
    process.exit(outcome.actionable?.length || outcome.plan.actionable?.length ? 2 : 0);
  }

  if (outcome.idempotent) {
    console.log('  Idempotent:          yes (request already completed)');
    console.log(`  Original booking:  ${outcome.original_booking?.booking_code || outcome.original_booking?.id || 'n/a'}`);
    if (outcome.block_a) console.log(`  Block A:             ${outcome.block_a.booking_code}`);
    if (outcome.block_b) console.log(`  Block B:             ${outcome.block_b.booking_code}`);
    console.log('\n  No duplicate A/B created. Payments unchanged.\n');
    process.exit(0);
  }

  if (outcome.error === 'already_cancelled_ambiguous') {
    console.error(
      `\nOriginal booking ${outcome.details.booking_code} already ${outcome.details.status} without completed request row.\n`
    );
    process.exit(2);
  }
  if (outcome.error === 'payments_exist') {
    console.error(
      `\nPayments guard: payments=${outcome.details.payments_count} events=${outcome.details.payment_events_count}\n`
    );
    process.exit(2);
  }
  if (outcome.error === 'block_booking_code_conflict') {
    console.error('\nBlock booking code exists with mismatched dates:\n');
    console.error(JSON.stringify(outcome.details.conflicts, null, 2));
    process.exit(2);
  }
  if (outcome.error === 'request_stuck_processing') {
    console.error('\nRequest row stuck in processing status.\n');
    process.exit(2);
  }

  const r = outcome.result;
  const v = outcome.verify;
  console.log('  EXECUTE summary:');
  console.log(`    request_id:          ${r.request_id}`);
  console.log(`    original cancelled:  ${r.original_booking_code} (beds deleted: ${r.deleted_beds})`);
  if (r.block_a) console.log(`    Block A:             ${r.block_a.booking_code}`);
  if (r.block_b) console.log(`    Block B:             ${r.block_b.booking_code}`);
  console.log(`    payments (guard):    ${r.payments_count} rows, ${r.payment_events_count} events`);
  console.log('  Verify:');
  console.log(`    original status:     ${v.original_status}`);
  console.log(`    original bed rows:   ${v.original_beds}`);
  console.log('\n  Airtable / Sheets unchanged.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
