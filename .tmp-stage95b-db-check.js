'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');

const CONV = process.argv[2] || '448d4c64-3f45-4aeb-bde1-f4722df55b1c';

async function main() {
  const url = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: url });
  await pg.connect();
  const [counts, botMode, activePause] = await Promise.all([
    pg.query('SELECT (SELECT COUNT(*)::int FROM bookings) AS bookings, (SELECT COUNT(*)::int FROM payments) AS payments, (SELECT COUNT(*)::int FROM booking_service_records) AS services'),
    pg.query('SELECT bot_mode::text AS bot_mode FROM conversations WHERE id = $1::uuid', [CONV]),
    pg.query('SELECT COUNT(*)::int AS n FROM bot_pause_states WHERE paused = TRUE'),
  ]);
  await pg.end();
  console.log(JSON.stringify({ conversation_id: CONV, ...counts.rows[0], bot_mode: botMode.rows[0].bot_mode, active_pause_rows: activePause.rows[0].n }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
