'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const whUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
(async () => {
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const pause = await pg.query(
    `SELECT guest_phone, paused, pause_reason FROM bot_pause_states WHERE guest_phone LIKE $1`,
    ['%491726422307%'],
  );
  const evt = await pg.query(
    `SELECT wa_message_id, next_action, handoff_required, draft_called, suggested_reply,
            normalized->'dry_run_plan' AS dry_run_plan,
            normalized->'booking_write_preview' AS booking_write_preview,
            normalized->'send_eligibility' AS send_eligibility
       FROM guest_message_events
      WHERE wa_message_id = $1`,
    ['wamid.phase22b.complete.001'],
  );
  console.log(JSON.stringify({ pause: pause.rows, event: evt.rows[0] }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
