'use strict';

/**
 * Clear a single guest's chat history + bookings (by phone) from the tenant DB.
 * Dry-run by default; set CLEAR_EXECUTE=true to actually delete. Phone is matched on
 * digits only (format-agnostic). Deletes: booking_service_records + bot_pause_states
 * for the guest, bookings (cascades payments/booking_guests/transfers), and
 * conversations (cascades messages). KEEPS the customers row (durable identity).
 * Runs inside the tenant's Container Apps environment (DB only reachable there).
 *
 *   GUEST_PHONE=+491726422307 node scripts/clear-guest-data.js
 *   GUEST_PHONE=+491726422307 CLEAR_EXECUTE=true node scripts/clear-guest-data.js
 */

const path = require('path');
const { withPgClient } = require(path.join(__dirname, 'lib', 'pg-connect'));

const RAW = process.env.GUEST_PHONE || process.argv[2] || '';
const DIGITS = String(RAW).replace(/[^0-9]/g, '');
const EXECUTE = String(process.env.CLEAR_EXECUTE || '').trim().toLowerCase() === 'true';

const NORM = "regexp_replace(coalesce(phone,''),'[^0-9]','','g')";
const NORM_GP = "regexp_replace(coalesce(guest_phone,''),'[^0-9]','','g')";

async function tableExists(c, t) {
  const r = await c.query('SELECT to_regclass($1) AS reg', [t]);
  return r.rows[0].reg !== null;
}

async function main() {
  if (!DIGITS || DIGITS.length < 6) throw new Error('GUEST_PHONE required (got: ' + JSON.stringify(RAW) + ')');
  await withPgClient(async (c) => {
    const convs = await c.query('SELECT id FROM conversations WHERE ' + NORM + ' = $1', [DIGITS]);
    const bks = await c.query('SELECT id, booking_code, status FROM bookings WHERE ' + NORM + ' = $1', [DIGITS]);
    const msgs = await c.query('SELECT count(*)::int n FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE ' + NORM + ' = $1)', [DIGITS]);
    console.log('phone digits=' + DIGITS
      + ' conversations=' + convs.rowCount
      + ' bookings=' + bks.rowCount
      + ' messages=' + msgs.rows[0].n);
    console.log('booking_codes=' + JSON.stringify(bks.rows.map(function (r) { return r.booking_code + '(' + r.status + ')'; })));

    if (!EXECUTE) { console.log('DRY RUN — nothing deleted. Set CLEAR_EXECUTE=true to delete.'); return; }

    await c.query('BEGIN');
    try {
      let bsr = { rowCount: 0 };
      if (await tableExists(c, 'booking_service_records')) {
        bsr = await c.query('DELETE FROM booking_service_records WHERE booking_id IN (SELECT id FROM bookings WHERE ' + NORM + ' = $1)', [DIGITS]);
      }
      let bps = { rowCount: 0 };
      if (await tableExists(c, 'bot_pause_states')) {
        bps = await c.query('DELETE FROM bot_pause_states WHERE ' + NORM_GP + ' = $1', [DIGITS]);
      }
      const db = await c.query('DELETE FROM bookings WHERE ' + NORM + ' = $1', [DIGITS]);
      const dc = await c.query('DELETE FROM conversations WHERE ' + NORM + ' = $1', [DIGITS]);
      await c.query('COMMIT');
      console.log('deleted booking_service_records=' + bsr.rowCount
        + ' bot_pause_states=' + bps.rowCount
        + ' bookings=' + db.rowCount
        + ' conversations=' + dc.rowCount
        + ' (messages + payments + booking_guests cascaded; customers row kept)');
    } catch (e) { await c.query('ROLLBACK'); console.error('ROLLBACK: ' + e.message); throw e; }
  });
}

main().then(function () { process.exit(0); }).catch(function (e) { console.error('FATAL: ' + e.message); process.exit(1); });
