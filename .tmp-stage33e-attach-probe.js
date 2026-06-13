'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const {
  attachPendingManualGuestServices,
  mergePendingServiceAttachContext,
  collectPendingManualServices,
} = require('./scripts/lib/luna-guest-pending-service-attach');

function az(s) {
  return execSync(s, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

(async () => {
  const db = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const cols = await pg.query(
    `SELECT column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_name = 'booking_service_records'
      ORDER BY ordinal_position`,
  );

  const ctx = {
    yoga_status: 'requested',
    services_pending_manual: ['yoga'],
    extracted_fields: {},
  };
  const merged = mergePendingServiceAttachContext({}, ctx);
  const candidates = collectPendingManualServices(merged);

  let attachErr = null;
  let attachOut = null;
  try {
    attachOut = await attachPendingManualGuestServices(pg, {
      clientSlug: 'wolfhouse-somo',
      bookingId: '4568e749-d907-45b7-ada7-1cb98ed73c09',
      bookingCode: 'WH-G27-4C1BA48A9A',
      guestName: 'Stage33e Guest',
      extractedFields: merged,
      resultContext: ctx,
    });
  } catch (e) {
    attachErr = e.message;
  }

  const rows = await pg.query(
    `SELECT id::text, service_type, status, source, service_date::text, metadata
       FROM booking_service_records
      WHERE booking_id = '4568e749-d907-45b7-ada7-1cb98ed73c09'::uuid`,
  );

  console.log(JSON.stringify({
    columns: cols.rows,
    merged,
    candidates,
    attachOut,
    attachErr,
    rows: rows.rows,
  }, null, 2));

  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
