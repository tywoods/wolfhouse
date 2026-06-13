'use strict';
/** Phase 19g.7 — re-check inbound after Meta cutover retry. Temp */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const TEST_FROM = '491726422307';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function httpsGet(path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: STAFF_HOST, path }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

(async () => {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const recent = await pg.query(
    `SELECT idempotency_key, status, blocked_reasons, to_phone, message_text, provider_message_id, created_at
     FROM guest_message_sends
     WHERE created_at > NOW() - INTERVAL '6 hours'
     ORDER BY created_at DESC LIMIT 40`,
  );
  const fromPhone = await pg.query(
    `SELECT idempotency_key, status, blocked_reasons, to_phone, message_text, created_at
     FROM guest_message_sends
     WHERE REPLACE(to_phone, '+', '') LIKE $1
     ORDER BY created_at DESC LIMIT 20`,
    [`%${TEST_FROM}%`],
  );
  const bookings = await pg.query(
    `SELECT id, booking_code, created_at FROM bookings WHERE created_at > NOW() - INTERVAL '6 hours' LIMIT 5`,
  );
  const payments = await pg.query(
    `SELECT id, status, created_at FROM payments WHERE created_at > NOW() - INTERVAL '6 hours' LIMIT 5`,
  );
  await pg.end();

  const isFixture = (k) => /phase19g[46]|phase19f3|phase19e5c/.test(String(k || ''));
  const realMeta = recent.rows.filter((r) => !isFixture(r.idempotency_key));
  const sent = recent.rows.filter((r) => r.status === 'sent' && !isFixture(r.idempotency_key));

  const classifyText = (text) => {
    const t = String(text || '').toLowerCase();
    if (/refund|talk to someone|team member/.test(t)) return 'refund_handoff';
    if (/settembre|check-in|date|vorresti soggiornare|quali date/.test(t)) return 'partial_it';
    if (/hello|ciaooo|ciao/.test(t)) return 'hello_or_greeting';
    if (/€|deposit|malibu|270/.test(t)) return 'quote';
    return 'other';
  };

  const realByKind = {};
  for (const row of realMeta) {
    const kind = classifyText(row.message_text);
    if (!realByKind[kind]) realByKind[kind] = [];
    realByKind[kind].push(row);
  }

  const verify = await httpsGet('/staff/meta/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wolfhouse_verify_token&hub.challenge=recheck123');
  const health = await httpsGet('/healthz');

  const hasRealWamid = realMeta.some((r) => /wamid\./.test(r.idempotency_key) && !/phase19/.test(r.idempotency_key));
  const hasPartialBlocked = realMeta.some((r) =>
    r.status === 'blocked' && (r.idempotency_key.includes('ask_missing_field') || /date|settembre|soggiornare/i.test(r.message_text)));
  const hasRefundNoRow = !realMeta.some((r) => /refund|team member/i.test(r.message_text) && r.idempotency_key.includes('ask_missing_field'));
  const refundRows = realMeta.filter((r) => /refund|team member|handoff/i.test(r.message_text) || r.idempotency_key.includes('handoff'));

  let result = 'FAIL';
  if (hasRealWamid && sent.length === 0 && bookings.rows.length === 0 && payments.rows.length === 0) {
    result = hasPartialBlocked ? 'PASS' : 'PARTIAL';
  } else if (realMeta.length > 0 && sent.length === 0) {
    result = 'PARTIAL';
  }
  if (sent.length > 0) result = 'FAIL';

  console.log(JSON.stringify({
    phase: '19g.7-recheck',
    checked_at_utc: new Date().toISOString(),
    result,
    healthz: health.status,
    webhook_verify: { status: verify.status, body: verify.body, ok: verify.status === 200 && verify.body === 'recheck123' },
    guest_message_sends_recent: recent.rows,
    real_meta_rows: realMeta,
    real_meta_by_kind: realByKind,
    from_test_phone: fromPhone.rows,
    sent_real_rows: sent,
    bookings_recent: bookings.rows,
    payments_recent: payments.rows,
    checks: {
      real_wamid_inbound: hasRealWamid,
      partial_it_blocked: hasPartialBlocked,
      no_new_sent: sent.length === 0,
      no_booking_payment: bookings.rows.length === 0 && payments.rows.length === 0,
      refund_audit_rows: refundRows,
    },
    diagnosis: hasRealWamid
      ? 'Staff API received live Meta inbound — see real_meta_rows'
      : realMeta.length > 0
        ? 'Some non-fixture rows but no live wamid keys yet'
        : 'Still no live Meta inbound in guest_message_sends — callback may still be on n8n or webhook not reaching Staff API',
  }, null, 2));
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
