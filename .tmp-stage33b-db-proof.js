'use strict';

const { execSync } = require('child_process');
const { Client } = require('pg');

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

async function main() {
  const db = az(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv'
  );
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const phone = '491726422307';

  const byCode = await pg.query(
    `SELECT b.id::text, b.booking_code, b.phone, b.status::text, b.payment_status::text,
            b.check_in::text, b.check_out::text, b.created_at::text, b.updated_at::text
       FROM bookings b
      WHERE b.booking_code IN ('WH-G27-4C1BA48A9A', 'WH-G27-077CB90CDE', 'WH-G27-FCD6347442')
      ORDER BY b.created_at DESC`
  );
  console.log('BY_CODE', JSON.stringify(byCode.rows, null, 2));

  for (const b of byCode.rows) {
    const svc = await pg.query(
      `SELECT id::text, service_type, status, source, service_date::text, metadata, created_at::text
         FROM booking_service_records WHERE booking_id = $1::uuid ORDER BY created_at`,
      [b.id]
    );
    console.log('SVC_FOR', b.booking_code, svc.rows);
  }

  const recent = await pg.query(
    `SELECT b.id::text, b.booking_code, b.status::text, b.payment_status::text,
            b.check_in::text, b.check_out::text, b.created_at::text, b.updated_at::text
       FROM bookings b JOIN clients c ON c.id = b.client_id
      WHERE c.slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(b.phone, ''), '+', '') = $1
        AND b.updated_at >= '2026-06-10T22:30:00Z'::timestamptz
      ORDER BY b.updated_at DESC LIMIT 5`,
    [phone]
  );
  console.log('RECENT_UPDATED', JSON.stringify(recent.rows, null, 2));

  const sends = await pg.query(
    `SELECT id::text, send_kind, status, LEFT(message_text, 140) AS msg, created_at::text
       FROM guest_message_sends
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(to_phone, ''), '+', '') = $1
        AND created_at >= '2026-06-10T22:30:00Z'::timestamptz
      ORDER BY created_at DESC LIMIT 10`,
    [phone]
  );
  console.log('SENDS_RECENT', JSON.stringify(sends.rows, null, 2));

  const yogaSvc = await pg.query(
    `SELECT bsr.id::text, b.booking_code, bsr.service_type, bsr.status, bsr.source,
            bsr.service_date::text, bsr.metadata, bsr.created_at::text
       FROM booking_service_records bsr
       JOIN bookings b ON b.id = bsr.booking_id
      WHERE bsr.service_type ILIKE '%yoga%'
        AND bsr.created_at >= '2026-06-10T22:00:00Z'::timestamptz
      ORDER BY bsr.created_at DESC
      LIMIT 10`
  );
  console.log('YOGA_SVC', JSON.stringify(yogaSvc.rows, null, 2));

  const gates = JSON.parse(
    az(
      'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json'
    )
  );
  const pick = {};
  for (const n of [
    'WHATSAPP_DRY_RUN',
    'OPEN_DEMO_BOOKING_WRITES_ENABLED',
    'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
    'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
  ]) {
    const e = gates.find((x) => x.name === n);
    pick[n] = e ? e.value ?? `(secret:${e.secretRef})` : null;
  }
  console.log('GATES', pick);
  console.log(
    'HEALTHZ',
    execSync('curl.exe -s -o NUL -w "%{http_code}" https://staff-staging.lunafrontdesk.com/healthz', {
      encoding: 'utf8',
    })
  );

  await pg.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
