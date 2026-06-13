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

  const ev = await pg.query(
    `SELECT normalized::text AS n FROM guest_message_events WHERE id = 'a0c05c5b-5385-424c-8a95-132d8963f489'`,
  );
  const n = JSON.parse(ev.rows[0].n);

  const conv = await pg.query(
    `SELECT conv.metadata->'luna_inbound_reviews' AS reviews
       FROM conversations conv JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = 'wolfhouse-somo' AND REPLACE(COALESCE(conv.phone,''),'+','') = '491726422307'`,
  );
  const reviews = conv.rows[0]?.reviews || {};
  const depositKey = Object.keys(reviews).find((k) => k.includes('98b24d13'));
  const review = depositKey ? reviews[depositKey] : null;

  console.log(JSON.stringify({
    open_demo_result_write: {
      write_status: n.open_demo_result?.write_status,
      write_block_reasons: n.open_demo_result?.write_block_reasons,
      booking_id: n.open_demo_result?.booking_id,
      attached_manual_services: n.open_demo_result?.attached_manual_services,
    },
    bookingWrite: n.bookingWrite,
    demo_booking_write: n.demo_booking_write,
    review_result: review?.result ? {
      yoga_status: review.result.yoga_status,
      services_pending_manual: review.result.services_pending_manual,
      extracted_fields: review.result.extracted_fields,
      yoga_request: review.result.extracted_fields?.yoga_request,
    } : null,
    chain_merged_extracted: review?.result ? require('./scripts/lib/luna-guest-pending-service-attach')
      .mergePendingServiceAttachContext(review.result.extracted_fields, review.result) : null,
  }, null, 2));

  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
