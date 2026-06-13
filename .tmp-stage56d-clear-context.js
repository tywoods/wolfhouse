'use strict';
/** Clear stale luna_guest_context for the test phone so a fresh booking can start. */

const { execSync } = require('child_process');

const DB_URL = execSync(
  'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
  { encoding: 'utf8' },
).trim();

const { Client } = require('pg');
const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  await client.connect();

  // Clear context for the test phone number
  const phone = '+491726422307';

  // Find the conversation
  const conv = await client.query(
    `SELECT id, phone, luna_guest_context FROM conversations WHERE phone LIKE $1 ORDER BY updated_at DESC LIMIT 3`,
    [`%${phone.replace(/\D/g, '').slice(-9)}%`],
  );

  if (!conv.rows.length) {
    console.log('No conversation found for', phone);
  } else {
    for (const row of conv.rows) {
      const ctx = row.luna_guest_context || {};
      console.log(`conv ${row.id}: booking_id=${ctx.booking_id}, active_thread=${ctx.active_thread}`);
      await client.query(
        `UPDATE conversations SET luna_guest_context = $1 WHERE id = $2`,
        [JSON.stringify({}), row.id],
      );
      console.log(`  → cleared luna_guest_context for conv ${row.id}`);
    }
  }

  await client.end();
  console.log('Done.');
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
