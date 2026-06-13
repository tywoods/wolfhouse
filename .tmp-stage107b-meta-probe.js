'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const url = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
(async () => {
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const r = await pg.query(`
    SELECT booking_code, booking_source::text, payment_status::text,
           metadata->>'source' AS meta_source, metadata->>'bot_source' AS bot_source,
           metadata->>'created_by' AS created_by, metadata->>'staff_source' AS staff_source
    FROM bookings b JOIN clients c ON c.id = b.client_id
    WHERE c.slug = 'wolfhouse-somo'
      AND booking_code IN ('MB-WOLFHO-20260801-4f10c3','MB-WOLFHO-20260815-4d37a0','DEMO-2603','MB-WOLFHO-20260901-cb4799')
  `);
  console.log(JSON.stringify(r.rows, null, 2));
  const luna = await pg.query(`
    SELECT booking_code, booking_source::text, metadata->>'source' AS meta_source
    FROM bookings b JOIN clients c ON c.id = b.client_id
    WHERE c.slug = 'wolfhouse-somo' AND (
      booking_source::text ILIKE '%luna%' OR booking_source::text ILIKE '%bot%'
      OR metadata->>'source' ILIKE '%bot%' OR metadata->>'bot_source' IS NOT NULL
    ) LIMIT 5
  `);
  console.log('luna candidates', JSON.stringify(luna.rows, null, 2));
  const ops = await pg.query(`
    SELECT booking_code, booking_source::text, block_type::text
    FROM bookings b JOIN clients c ON c.id = b.client_id
    WHERE c.slug = 'wolfhouse-somo' AND booking_source::text = 'operator' LIMIT 5
  `);
  console.log('operator blocks', JSON.stringify(ops.rows, null, 2));
  const opDates = await pg.query(`
    SELECT booking_code, check_in::text, check_out::text
    FROM bookings b JOIN clients c ON c.id = b.client_id
    WHERE c.slug = 'wolfhouse-somo' AND booking_source::text = 'operator'
    ORDER BY check_in DESC LIMIT 8
  `);
  console.log('operator dates', JSON.stringify(opDates.rows, null, 2));
  await pg.end();
})();
