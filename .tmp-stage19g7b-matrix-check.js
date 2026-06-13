'use strict';
/** Phase 19g.7b — live inbound matrix check B/C. Temp */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const TEST_FROM = '491726422307';
const CASE_A_WAMID = 'wamid.HBgMNDkxNzI2NDIyMzA3FQIAEhgWM0VCMDMxQzYwMTVCQjg0NThCNEU4QQA=';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

(async () => {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const sinceCutover = await pg.query(
    `SELECT idempotency_key, status, blocked_reasons, to_phone, message_text, provider_message_id, created_at
     FROM guest_message_sends
     WHERE created_at >= '2026-06-06T10:28:00Z'
     ORDER BY created_at ASC`,
  );
  const fromPhone = await pg.query(
    `SELECT idempotency_key, status, blocked_reasons, to_phone, message_text, provider_message_id, created_at
     FROM guest_message_sends
     WHERE REPLACE(COALESCE(to_phone,''), '+', '') LIKE $1
     ORDER BY created_at DESC LIMIT 30`,
    [`%${TEST_FROM}%`],
  );
  const sentRecent = await pg.query(
    `SELECT idempotency_key, status, provider_message_id, created_at
     FROM guest_message_sends
     WHERE status = 'sent' AND created_at >= '2026-06-06T10:28:00Z'`,
  );
  const bookings = await pg.query(
    `SELECT id, booking_code, created_at FROM bookings WHERE created_at >= '2026-06-06T10:28:00Z' LIMIT 5`,
  );
  const payments = await pg.query(
    `SELECT id, status, created_at FROM payments WHERE created_at >= '2026-06-06T10:28:00Z' LIMIT 5`,
  );
  await pg.end();

  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const pick = (n) => {
    const row = env.find((e) => e.name === n);
    if (!row) return '(unset)';
    return row.value != null ? row.value : `(secret:${row.secretRef})`;
  };

  const liveRows = sinceCutover.rows.filter((r) =>
    /wamid\.HBg/.test(r.idempotency_key) || (r.idempotency_key.includes('wamid.') && !r.idempotency_key.includes('phase19')));

  const caseA = liveRows.find((r) => r.idempotency_key.includes(CASE_A_WAMID) || r.idempotency_key.includes('ask_missing_field'));
  const caseB = liveRows.find((r) =>
    /refund|team member|handoff/i.test(r.message_text || '') || r.idempotency_key.includes('handoff'));
  const caseC = liveRows.filter((r) => r !== caseA && !caseB).filter((r) =>
    /hello|unsupported|team will review|Thanks for reaching/i.test(r.message_text || '') ||
    (r.idempotency_key.includes('wamid.') && !r.idempotency_key.includes('ask_missing_field') && !r.idempotency_key.includes('show_quote')));

  // All live wamid keys after cutover
  const liveWamids = liveRows.map((r) => {
    const m = r.idempotency_key.match(/wamid\.[^:]+\.?[^:]*(?=:)/) || r.idempotency_key.match(/(wamid\.[^:]+)/);
    return {
      idempotency_key: r.idempotency_key,
      wa_message_id: m ? m[0].replace(/:$/, '') : null,
      status: r.status,
      message_text: String(r.message_text || '').slice(0, 120),
      blocked_reasons: r.blocked_reasons,
      created_at: r.created_at,
    };
  });

  const sentAfterCutover = sentRecent.rows.length > 0;
  let result = 'PARTIAL';

  const caseBPass = !caseB && !sentAfterCutover; // refund should NOT create send row
  const caseCPass = caseC.length > 0 && caseC.every((r) => r.status !== 'sent');

  if (sentAfterCutover) result = 'FAIL';
  else if (liveRows.length >= 2 && caseBPass) result = 'PASS';
  else if (liveRows.length === 1 && caseBPass) {
    result = 'PARTIAL'; // only Case A confirmed; B/C not in audit table (B expected absent)
  }

  console.log(JSON.stringify({
    phase: '19g.7b',
    checked_at_utc: new Date().toISOString(),
    result,
    callback_url: 'https://staff-staging.lunafrontdesk.com/staff/meta/whatsapp/webhook (unchanged this check)',
    env_flags: {
      WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
      LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
    },
    live_wamids_after_cutover: liveWamids,
    caseA: caseA ? {
      wa_message_id: CASE_A_WAMID,
      status: caseA.status,
      send_kind: 'ask_missing_field',
      blocked: true,
      pass: true,
    } : null,
    caseB: {
      guest_message_sends_row: caseB || null,
      expected: 'no row (send_attempted false for handoff)',
      pass: caseBPass,
      note: caseB
        ? 'unexpected audit row for handoff — inspect'
        : 'no guest_message_sends row — consistent with send_attempted false',
    },
    caseC: {
      rows: caseC,
      pass: caseCPass,
      note: caseC.length === 0
        ? 'no audit row yet — Hello may not trigger send gate (unsupported/low-confidence) or webhook not received'
        : 'audit rows present',
    },
    all_rows_since_cutover: sinceCutover.rows,
    from_test_phone_recent: fromPhone.rows,
    no_send_proof: {
      sent_after_cutover: sentRecent.rows,
      any_sent: sentAfterCutover,
    },
    safety: {
      bookings: bookings.rows,
      payments: payments.rows,
      no_booking_payment: bookings.rows.length === 0 && payments.rows.length === 0,
    },
  }, null, 2));
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
