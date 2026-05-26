/**
 * Phase 3.0b — Backfill bookings.airtable_record_id from booking_code (Postgres only).
 * Does NOT call Airtable API or write to Airtable/Sheets. Does NOT touch payments.
 *
 * Usage:
 *   npm run db:backfill:airtable-ids -- --dry-run
 *   npm run db:backfill:airtable-ids
 *   npm run db:backfill:airtable-ids -- --fix-mismatches
 */
const { bookingCodeToAirtableRecordId } = require('./lib/airtable-record-id');
const { withPgClient } = require('./lib/pg-connect');

const DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';

function parseArgs(argv) {
  const flags = {
    dryRun: false,
    fixMismatches: false,
    clientSlug: DEFAULT_CLIENT_SLUG,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--fix-mismatches') flags.fixMismatches = true;
    else if (arg.startsWith('--client=')) flags.clientSlug = arg.slice('--client='.length);
  }
  return flags;
}

async function getClientId(client, slug) {
  const { rows } = await client.query(`SELECT id FROM clients WHERE slug = $1`, [slug]);
  if (!rows.length) throw new Error(`Client not found: ${slug}`);
  return rows[0].id;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const mode = flags.dryRun ? 'DRY RUN' : 'APPLY';

  console.log(`\nBackfill bookings.airtable_record_id [${mode}] client=${flags.clientSlug}\n`);

  const summary = await withPgClient(async (client) => {
    const clientId = await getClientId(client, flags.clientSlug);

    const { rows: bookings } = await client.query(
      `SELECT id, booking_code, airtable_record_id
       FROM bookings
       WHERE client_id = $1
         AND booking_code IS NOT NULL
         AND booking_code LIKE 'WH-rec%'
       ORDER BY booking_code`,
      [clientId]
    );

    const toFill = [];
    const alreadyOk = [];
    const mismatches = [];
    const unmapped = [];

    for (const row of bookings) {
      const derived = bookingCodeToAirtableRecordId(row.booking_code);
      if (!derived) {
        unmapped.push(row);
        continue;
      }
      const current = row.airtable_record_id ? String(row.airtable_record_id).trim() : '';
      if (!current) {
        toFill.push({ ...row, derived });
      } else if (current === derived) {
        alreadyOk.push(row);
      } else {
        mismatches.push({ ...row, derived, current });
      }
    }

    let updated = 0;
    if (!flags.dryRun) {
      for (const row of toFill) {
        const res = await client.query(
          `UPDATE bookings
           SET airtable_record_id = $1, updated_at = NOW()
           WHERE id = $2
             AND client_id = $3
             AND (airtable_record_id IS NULL OR TRIM(airtable_record_id) = '')`,
          [row.derived, row.id, clientId]
        );
        updated += res.rowCount;
      }

      if (flags.fixMismatches) {
        for (const row of mismatches) {
          const res = await client.query(
            `UPDATE bookings
             SET airtable_record_id = $1, updated_at = NOW()
             WHERE id = $2 AND client_id = $3 AND airtable_record_id = $4`,
            [row.derived, row.id, clientId, row.current]
          );
          updated += res.rowCount;
        }
      }
    }

    return {
      totalWhRec: bookings.length,
      toFill,
      alreadyOk,
      mismatches,
      unmapped,
      updated: flags.dryRun ? 0 : updated,
      wouldUpdate: toFill.length + (flags.fixMismatches ? mismatches.length : 0),
    };
  });

  console.log(`WH-rec* bookings scanned:     ${summary.totalWhRec}`);
  console.log(`Already linked (ok):          ${summary.alreadyOk.length}`);
  console.log(`Would fill (null/empty id):   ${summary.toFill.length}`);
  console.log(`Mismatched id (manual):       ${summary.mismatches.length}`);
  console.log(`Could not derive rec id:      ${summary.unmapped.length}`);

  if (summary.toFill.length) {
    console.log('\nFill candidates (first 20):');
    for (const row of summary.toFill.slice(0, 20)) {
      console.log(`  ${row.booking_code} → ${row.derived}`);
    }
    if (summary.toFill.length > 20) {
      console.log(`  … and ${summary.toFill.length - 20} more`);
    }
  }

  if (summary.mismatches.length) {
    console.log('\nMismatches (not updated unless --fix-mismatches):');
    for (const row of summary.mismatches.slice(0, 10)) {
      console.log(`  ${row.booking_code}: db=${row.current} expected=${row.derived}`);
    }
  }

  if (flags.dryRun) {
    console.log(`\nDry run complete. Would update ${summary.wouldUpdate} row(s).`);
    console.log('Run without --dry-run to apply.\n');
  } else {
    console.log(`\nUpdated ${summary.updated} row(s).\n`);
  }

  if (summary.mismatches.length && !flags.fixMismatches && !flags.dryRun) {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
