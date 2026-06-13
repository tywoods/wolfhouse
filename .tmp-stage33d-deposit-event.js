'use strict';

const { execSync } = require('child_process');
const { Client } = require('pg');

async function main() {
  const db = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const row = (await pg.query(
    `SELECT normalized->'open_demo_result' AS odr
       FROM guest_message_events
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(from_phone,''),'+','') = '491726422307'
        AND created_at >= '2026-06-11T06:27:00Z'::timestamptz
        AND message_text = 'deposit'
      ORDER BY created_at DESC LIMIT 1`,
  )).rows[0];
  const odr = row?.odr || {};
  const ef = odr.result?.extracted_fields || {};
  console.log(JSON.stringify({
    yoga_status: odr.yoga_status,
    services_pending_manual: odr.services_pending_manual,
    attached_manual_services: odr.attached_manual_services,
    extracted_fields: ef,
    booking_write: odr.booking_write || odr.bookingWrite,
    hold_plan: odr.hold_payment_draft_plan?.plan_status,
    payment_choice_ready: odr.payment_choice_ready,
  }, null, 2));
  await pg.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
