'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const az = (s) => execSync(s, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
const CLIENT = 'wolfhouse-somo';
const WA = 'wamid.phase22b.complete.oct.001';
const BK = '946cc3ba-70e9-4f9f-a6b8-140ca3d22a79';
const IDEM = `luna-booking:${CLIENT}:${WA}:v1`;

(async () => {
  const url = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const evt = await pg.query(
    'SELECT wa_message_id, normalized FROM guest_message_events WHERE client_slug = $1 AND wa_message_id = $2',
    [CLIENT, WA],
  );
  const norm = evt.rows[0] && evt.rows[0].normalized;
  const n = typeof norm === 'string' ? JSON.parse(norm) : norm;
  const bk = await pg.query(
    `SELECT id::text, booking_code, metadata->>'idempotency_key' AS idem FROM bookings WHERE id = $1::uuid`,
    [BK],
  );
  const pay = await pg.query(
    `SELECT id::text, status::text, checkout_url, stripe_checkout_session_id FROM payments WHERE booking_id = $1::uuid`,
    [BK],
  );
  const beds = await pg.query(
    'SELECT count(*)::int AS c FROM booking_beds WHERE booking_id = $1::uuid',
    [BK],
  );
  const idemCnt = await pg.query(
    `SELECT count(*)::int AS c FROM bookings b JOIN clients c ON c.id = b.client_id WHERE c.slug = $1 AND b.metadata->>'idempotency_key' = $2`,
    [CLIENT, IDEM],
  );
  console.log(JSON.stringify({
    preview: !!(n && n.booking_write_preview),
    preview_eligible: n && n.booking_write_preview && n.booking_write_preview.eligible,
    has_result: !!(n && n.booking_write_result),
    result: n && n.booking_write_result,
    preview_keys: n ? Object.keys(n) : [],
    booking: bk.rows[0],
    payments: pay.rows,
    bed_count: beds.rows[0].c,
    idem_count: idemCnt.rows[0].c,
  }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
