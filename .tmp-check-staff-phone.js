'use strict';
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DB_URL });
async function main() {
  await client.connect();
  // Check if phone is in staff_phones table
  const r1 = await client.query(
    `SELECT * FROM staff_phones WHERE phone = '+491726422307' OR phone = '491726422307' LIMIT 5`
  ).catch(e => ({ rows: [], error: e.message }));
  console.log('staff_phones:', JSON.stringify(r1.rows));

  // Check recent guest_message_events
  const r2 = await client.query(
    `SELECT wa_message_id, from_phone, message_text, draft_called, send_attempted, send_status, created_at
     FROM guest_message_events
     ORDER BY created_at DESC LIMIT 10`
  ).catch(e => ({ rows: [], error: e.message }));
  console.log('recent events:', JSON.stringify(r2.rows, null, 2));
  await client.end();
}
main().catch(e => console.error(e.message));
