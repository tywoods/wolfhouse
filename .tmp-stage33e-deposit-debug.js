'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');

const BOOKING_ID = '4568e749-d907-45b7-ada7-1cb98ed73c09';
const SINCE = '2026-06-11T06:45:00Z';

function az(s) {
  return execSync(s, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

(async () => {
  const db = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const deposit = await pg.query(
    `SELECT id::text, created_at::text, message_text,
            normalized->'open_demo_result' AS odr
       FROM guest_message_events
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(from_phone,''),'+','') = '491726422307'
        AND message_text = 'deposit'
        AND created_at >= $1::timestamptz
      ORDER BY created_at DESC LIMIT 1`,
    [SINCE],
  );

  const svc = await pg.query(
    `SELECT * FROM booking_service_records WHERE booking_id = $1::uuid`,
    [BOOKING_ID],
  );

  const conv = await pg.query(
    `SELECT conv.metadata->'luna_inbound_reviews' AS reviews
       FROM conversations conv JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = 'wolfhouse-somo' AND REPLACE(COALESCE(conv.phone,''),'+','') = '491726422307'`,
  );

  console.log(JSON.stringify({
    deposit_event: deposit.rows[0],
    service_records: svc.rows,
    review_keys: conv.rows[0]?.reviews ? Object.keys(conv.rows[0].reviews).slice(-4) : [],
  }, null, 2));

  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
