'use strict';

/**
 * One-off maintenance: wipe ALL Sunset test data (client slug = 'sunset') so the
 * tenant starts clean. Dry-run by default — prints diagnostics + row counts and
 * deletes NOTHING. Set env WIPE_EXECUTE=true to actually delete (inside a single
 * transaction; rolls back on any error).
 *
 * Scope is strictly the 'sunset' client. Any other client is never touched. Admin
 * catalog/config (tenant_* tables) is intentionally preserved. Tables that do not
 * exist in this DB are skipped.
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

async function tableExists(pg, table) {
  const r = await pg.query('SELECT to_regclass($1) AS reg', [table]);
  return r.rows[0].reg !== null;
}

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

    // Ordered ops: children/companions first, then parents (cascades handle the rest).
    const ops = [
      { label: 'booking_service_records', table: 'booking_service_records', where: 'client_slug=$1', params: [SLUG] },
      { label: 'bot_pause_states', table: 'bot_pause_states', where: 'client_slug=$1', params: [SLUG] },
      { label: 'booking_guests (cascade w/ bookings)', table: 'booking_guests', where: 'booking_id IN (SELECT id FROM bookings WHERE client_id=$1)', params: [cid] },
      { label: 'payments (cascade w/ bookings)', table: 'payments', where: 'booking_id IN (SELECT id FROM bookings WHERE client_id=$1)', params: [cid] },
      { label: 'messages (cascade w/ conversations)', table: 'messages', where: 'conversation_id IN (SELECT id FROM conversations WHERE client_id=$1)', params: [cid] },
      { label: 'bookings', table: 'bookings', where: 'client_id=$1', params: [cid] },
      { label: 'conversations', table: 'conversations', where: 'client_id=$1', params: [cid] },
      { label: 'guests', table: 'guests', where: 'client_id=$1', params: [cid] },
    ];

    console.log('--- SUNSET-SCOPED COUNTS ---');
    for (const op of ops) {
      if (!(await tableExists(pg, op.table))) { console.log(`  ${op.label}: (no table — skip)`); op.skip = true; continue; }
      const r = await pg.query(`SELECT count(*) n FROM ${op.table} WHERE ${op.where}`, op.params);
      console.log(`  ${op.label}: ${r.rows[0].n}`);
    }

    if (!EXECUTE) {
      console.log('DRY RUN — nothing deleted. Set WIPE_EXECUTE=true to delete.');
      return;
    }

    console.log('--- EXECUTE: deleting inside a transaction ---');
    await pg.query('BEGIN');
    try {
      // Delete companions/children explicitly, then parents. Parent deletes cascade
      // the FK-CASCADE children (messages, payments, booking_guests, transfers).
      const delOrder = ['booking_service_records', 'bot_pause_states', 'bookings', 'conversations', 'guests'];
      for (const table of delOrder) {
        const op = ops.find((o) => o.table === table);
        if (op.skip) { console.log(`  ${table}: (no table — skip)`); continue; }
        const r = await pg.query(`DELETE FROM ${table} WHERE ${op.where}`, op.params);
        console.log(`  deleted ${table}: ${r.rowCount}`);
      }
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
