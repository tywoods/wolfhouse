'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const az = (c) => execSync(c, { encoding: 'utf8' }).trim();
(async () => {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const code = 'WH-G27-F88DB3CBBD';
  const b = (await pg.query('SELECT id::text FROM bookings WHERE booking_code = $1', [code])).rows[0];
  const holds = b ? (await pg.query(
    `SELECT bh.bed_code, bh.room_code, bh.check_in::text, bh.check_out::text, bh.status::text
       FROM booking_beds bb
       JOIN bed_holds bh ON bh.id = bb.bed_hold_id
      WHERE bb.booking_id = $1::uuid`,
    [b.id],
  )).rows : [];
  const convLink = b ? (await pg.query(
    `SELECT id::text, phone, current_hold_booking_id::text FROM conversations
      WHERE current_hold_booking_id = $1::uuid OR id IN (
        SELECT conversation_id FROM guest_message_events WHERE booking_id = $1::uuid LIMIT 5
      )`,
    [b.id],
  )).rows : [];
  await pg.end();
  console.log(JSON.stringify({ bed_holds: holds, conversation_links: convLink }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
