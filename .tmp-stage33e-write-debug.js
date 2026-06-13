'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');

function az(s) {
  return execSync(s, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

(async () => {
  const db = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const deposit = await pg.query(
    `SELECT normalized AS n FROM guest_message_events
      WHERE id = 'a0c05c5b-5385-424c-8a95-132d8963f489'`,
  );
  const n = deposit.rows[0]?.n || {};
  const odr = n.open_demo_result || {};
  const wamid = 'wolfhouse-somo:whatsapp:wamid.stage33e.1781160372290.98b24d13';

  const conv = await pg.query(
    `SELECT conv.metadata->'luna_inbound_reviews' AS reviews
       FROM conversations conv JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = 'wolfhouse-somo' AND REPLACE(COALESCE(conv.phone,''),'+','') = '491726422307'`,
  );
  const reviews = conv.rows[0]?.reviews || {};
  const review = reviews[wamid] || null;

  console.log(JSON.stringify({
    write_status: odr.write_status,
    demo_booking_write: n.demo_booking_write || odr.demo_booking_write,
    booking_write: n.booking_write,
    attached_manual_services: odr.attached_manual_services,
    review_result_yoga: review?.result?.yoga_status,
    review_result_pending: review?.result?.services_pending_manual,
    review_result_extracted: review?.result?.extracted_fields,
    writeOut_keys: n.demo_booking_write ? Object.keys(n.demo_booking_write) : null,
  }, null, 2));

  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
