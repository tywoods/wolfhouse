'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const az = (c) => execSync(c, { encoding: 'utf8' }).trim();

(async () => {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const since = '2026-06-10T07:38:22.960Z';
  const sends = await pg.query(
    `SELECT status::text, blocked_reasons, LEFT(message_text,120) AS body, created_at::text
       FROM guest_message_sends
      WHERE (to_phone IN ($1,$2) OR to_phone LIKE $3)
        AND created_at >= $4::timestamptz
      ORDER BY created_at`,
    ['+491726422307', '491726422307', '%1726422307%', since],
  );
  const events = await pg.query(
    `SELECT normalized->>'next_action' AS next_action,
            normalized->'staff_role' AS staff_role,
            normalized->>'owner_luna_route' AS owner_route,
            normalized->>'guest_flow_skipped' AS guest_skipped,
            message_text, send_status
       FROM guest_message_events
      WHERE wa_message_id IN (
        'wamid.HBgMNDkxNzI2NDIyMzA3FQIAEhgWM0VCMDlFQTYzNURFOTg0OUFGNjE5QgA=',
        'wamid.HBgMNDkxNzI2NDIyMzA3FQIAEhgWM0VCMEVGN0M4M0I2MTYyNDRCODY2QwA=',
        'wamid.HBgMNDkxNzI2NDIyMzA3FQIAEhgWM0VCMEVFRTFGNzAxN0Y4NjlFNjZBNwA='
      )`,
  );
  console.log(JSON.stringify({ sends: sends.rows, events: events.rows }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
