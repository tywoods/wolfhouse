'use strict';
/** Phase 19g.7 — post-cutover inbound check after Ty test messages. Temp */
const { execSync } = require('child_process');
const { Client } = require('pg');

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

(async () => {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const after1020 = await pg.query(
    `SELECT idempotency_key, status, to_phone, message_text, created_at
     FROM guest_message_sends WHERE created_at > '2026-06-06T10:20:00Z' ORDER BY created_at DESC`,
  );
  const realWamid = await pg.query(
    `SELECT idempotency_key, status, created_at FROM guest_message_sends
     WHERE idempotency_key LIKE 'luna:wolfhouse-somo:wamid.%' AND idempotency_key NOT LIKE '%phase19%'
     ORDER BY created_at DESC LIMIT 10`,
  );
  const sentAfter1020 = after1020.rows.filter((r) => r.status === 'sent');
  await pg.end();

  const staffReceived = after1020.rows.some((r) => !r.idempotency_key.includes('phase19g6'));
  let result = 'FAIL';
  if (staffReceived && sentAfter1020.length === 0) result = 'PASS';
  else if (after1020.rows.length > 0 && after1020.rows.every((r) => r.idempotency_key.includes('phase19g6'))) {
    result = 'FAIL';
  }

  console.log(JSON.stringify({
    phase: '19g.7-post-inbound',
    result,
    ty_sent: ['Hello', 'Ciao partial IT', 'Refund handoff'],
    ty_sent_at: '12:24 local 6 Jun 2026',
    after_1020_utc_rows: after1020.rows,
    real_wamid_keys_non_fixture: realWamid.rows,
    staff_api_received_ty_messages: staffReceived,
    new_sent_rows_after_1020: sentAfter1020,
    diagnosis: staffReceived
      ? 'Staff API received real Meta inbound'
      : 'No new guest_message_sends after 10:20 UTC except 19g6 curl fixtures — Meta likely still pointing at n8n or webhook not delivered to Staff API',
  }, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
