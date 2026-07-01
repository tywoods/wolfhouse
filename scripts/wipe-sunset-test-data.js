'use strict';

/**
 * One-off maintenance: wipe ALL Sunset test data (client slug = 'sunset') so the
 * tenant starts clean. Dry-run by default — prints diagnostics + row counts and
 * deletes NOTHING. Set env WIPE_EXECUTE=true to actually delete (inside a single
 * transaction; rolls back on any error).
 *
 * Scope is strictly the 'sunset' client. Wolfhouse (and any other client) is never
 * touched. Admin catalog/config (tenant_* tables) is intentionally preserved.
 *
 * Cascades (from schema): deleting bookings -> payments, booking_guests,
 * booking_transfers; deleting conversations -> messages. booking_service_records
 * and bot_pause_states are client_slug-scoped and deleted explicitly.
 *
 * Run inside the Sunset Container Apps environment (the DB is only reachable there):
 *   node scripts/wipe-sunset-test-data.js            # dry run
 *   WIPE_EXECUTE=true node scripts/wipe-sunset-test-data.js
 */

const path = require('path');
const { withPgClient } = require(path.join(__dirname, 'lib', 'pg-connect'));

const SLUG = 'sunset';
const EXECUTE = String(process.env.WIPE_EXECUTE || '').trim().toLowerCase() === 'true';

async function main() {
  await withPgClient(async (pg) => {
    const clients = await pg.query('SELECT id, slug FROM clients ORDER BY slug');
    console.log('ALL CLIENTS:', JSON.stringify(clients.rows));
    const target = clients.rows.filter((r) => r.slug === SLUG);
    if (target.length !== 1) {
      throw new Error(`expected exactly 1 client with slug='${SLUG}', found ${target.length} — aborting`);
    }
    const cid = target[0].id;
    console.log(`TARGET client: slug=${SLUG} id=${cid}`);

    // Diagnostics: reveal the actual denormalized slug values in child tables so we
    // can confirm scoping before deleting.
    const bsrSlugs = await pg.query('SELECT DISTINCT client_slug FROM booking_service_records ORDER BY 1');
    const bpsSlugs = await pg.query('SELECT DISTINCT client_slug FROM bot_pause_states ORDER BY 1');
    console.log('booking_service_records client_slug values:', JSON.stringify(bsrSlugs.rows.map((r) => r.client_slug)));
    console.log('bot_pause_states client_slug values:', JSON.stringify(bpsSlugs.rows.map((r) => r.client_slug)));

    const counts = {};
    const count = async (label, sql, params) => {
      const r = await pg.query(sql, params);
      counts[label] = Number(r.rows[0].n);
    };
    await count('booking_service_records', 'SELECT count(*) n FROM booking_service_records WHERE client_slug=$1', [SLUG]);
    await count('bot_pause_states', 'SELECT count(*) n FROM bot_pause_states WHERE client_slug=$1', [SLUG]);
    await count('bookings', 'SELECT count(*) n FROM bookings WHERE client_id=$1', [cid]);
    await count('payments (cascade)', 'SELECT count(*) n FROM payments WHERE booking_id IN (SELECT id FROM bookings WHERE client_id=$1)', [cid]);
    await count('booking_guests (cascade)', 'SELECT count(*) n FROM booking_guests WHERE booking_id IN (SELECT id FROM bookings WHERE client_id=$1)', [cid]);
    await count('conversations', 'SELECT count(*) n FROM conversations WHERE client_id=$1', [cid]);
    await count('messages (cascade)', 'SELECT count(*) n FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE client_id=$1)', [cid]);
    await count('guests', 'SELECT count(*) n FROM guests WHERE client_id=$1', [cid]);
    console.log('SUNSET-SCOPED COUNTS:', JSON.stringify(counts, null, 2));

    if (!EXECUTE) {
      console.log('DRY RUN — nothing deleted. Set WIPE_EXECUTE=true to delete.');
      return;
    }

    console.log('EXECUTE mode — deleting inside a transaction...');
    await pg.query('BEGIN');
    try {
      const del = async (label, sql, params) => {
        const r = await pg.query(sql, params);
        console.log(`  deleted ${label}: ${r.rowCount}`);
      };
      await del('booking_service_records', 'DELETE FROM booking_service_records WHERE client_slug=$1', [SLUG]);
      await del('bot_pause_states', 'DELETE FROM bot_pause_states WHERE client_slug=$1', [SLUG]);
      await del('bookings (cascades payments/booking_guests/transfers)', 'DELETE FROM bookings WHERE client_id=$1', [cid]);
      await del('conversations (cascades messages)', 'DELETE FROM conversations WHERE client_id=$1', [cid]);
      await del('guests', 'DELETE FROM guests WHERE client_id=$1', [cid]);
      await pg.query('COMMIT');
      console.log('COMMIT OK — Sunset test data wiped clean.');
    } catch (e) {
      await pg.query('ROLLBACK');
      console.error('ROLLBACK — no changes committed. Error:', e.message);
      throw e;
    }
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
