'use strict';
/** Phase 19g.8b — hosted persistence proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const ROUTE = '/staff/meta/whatsapp/webhook';
const COMMIT = 'da14a74';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:da14a74-stage19g8-meta-inbound-persist';
const TEST_FROM = '491726422307';
const PROOF_START = new Date().toISOString();

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function httpsReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({ hostname: HOST, path, method, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function metaText(waId, text) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '34663439419', phone_number_id: '1152900101233109' },
          contacts: [{ profile: { name: 'Ty Live Proof' }, wa_id: TEST_FROM }],
          messages: [{
            from: TEST_FROM,
            id: waId,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

function stagingEnvFlags() {
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const pick = (name) => {
    const row = env.find((e) => e.name === name);
    if (!row) return '(unset)';
    return row.value != null ? row.value : `(secret:${row.secretRef})`;
  };
  return {
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
  };
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  return rows.find((x) => x.properties.trafficWeight === 100) || rows[0] || {};
}

async function dbProof() {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const events = await pg.query(
    `SELECT wa_message_id, from_phone, message_type, message_text, draft_called, next_action,
            handoff_required, send_attempted, send_status, send_idempotency_key, send_blocked_reasons, created_at
       FROM guest_message_events
      WHERE from_phone LIKE $1
      ORDER BY created_at DESC LIMIT 10`,
    [`%${TEST_FROM}%`],
  );

  const dupCounts = await pg.query(
    `SELECT wa_message_id, COUNT(*)::int AS n
       FROM guest_message_events
      WHERE from_phone LIKE $1
      GROUP BY wa_message_id
      HAVING COUNT(*) > 1`,
    [`%${TEST_FROM}%`],
  );

  const sentAfter = await pg.query(
    `SELECT idempotency_key, status, provider_message_id, created_at
       FROM guest_message_sends
      WHERE status = 'sent' AND created_at >= $1::timestamptz`,
    [PROOF_START],
  );

  const blockedAfter = await pg.query(
    `SELECT idempotency_key, status, blocked_reasons, created_at
       FROM guest_message_sends
      WHERE created_at >= $1::timestamptz
      ORDER BY created_at DESC`,
    [PROOF_START],
  );

  const bookings = await pg.query(
    `SELECT id, booking_code, created_at FROM bookings WHERE created_at >= $1::timestamptz LIMIT 5`,
    [PROOF_START],
  );
  const payments = await pg.query(
    `SELECT id, status, created_at FROM payments WHERE created_at >= $1::timestamptz LIMIT 5`,
    [PROOF_START],
  );

  await pg.end();
  return {
    guest_message_events: events.rows,
    duplicate_wa_counts: dupCounts.rows,
    sent_after_proof: sentAfter.rows,
    blocked_after_proof: blockedAfter.rows,
    bookings,
    payments,
  };
}

function blockedIncludes(body, reason) {
  const fromResult = body.send_result && Array.isArray(body.send_result.blocked_reasons)
    ? body.send_result.blocked_reasons : [];
  const top = Array.isArray(body.blocked_reasons) ? body.blocked_reasons : [];
  return fromResult.includes(reason) || top.includes(reason);
}

(async () => {
  const rev = activeRevision();
  const health = await httpsReq('GET', '/healthz');
  const verify = await httpsReq(
    'GET',
    '/staff/meta/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wolfhouse_verify_token&hub.challenge=persist123',
  );

  const WA_A = 'wamid.HBgMNDkxNzI2NDIyMzA3FQIAEhgWM0VCMDg4YjBQUk9PRjE5ZzhiLUNBc0E=';
  const WA_B = 'wamid.HBgMNDkxNzI2NDIyMzA3FQIAEhgWM0VCMDg4YjBQUk9PRjE5ZzhiLUNCc0E=';
  const WA_C = 'wamid.HBgMNDkxNzI2NDIyMzA3FQIAEhgWM0VCMDg4YjBQUk9PRjE5ZzhiLUNDc0E=';
  const TEXT_A = 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?';
  const TEXT_B = 'I want a refund and need to talk to someone.';
  const TEXT_C = 'Hello';

  const caseA = await httpsReq('POST', ROUTE, metaText(WA_A, TEXT_A));
  const caseB = await httpsReq('POST', ROUTE, metaText(WA_B, TEXT_B));
  const caseC = await httpsReq('POST', ROUTE, metaText(WA_C, TEXT_C));

  const sendsBeforeReplay = await dbProof();

  const replay = await httpsReq('POST', ROUTE, metaText(WA_A, TEXT_A));
  const dbAfter = await dbProof();

  const a = caseA.body || {};
  const b = caseB.body || {};
  const c = caseC.body || {};
  const r = replay.body || {};

  const expectedAKey = `luna:wolfhouse-somo:${WA_A}:ask_missing_field`;

  const caseAOk = caseA.status === 200
    && a.draft_called === true
    && a.next_action === 'ask_missing_field'
    && /check-in|check-out|date|date/i.test(String(a.suggested_reply || ''))
    && a.send_attempted === true
    && a.send_idempotency_key === expectedAKey || a.idempotency_key === expectedAKey
    && a.event_persisted === true
    && a.send_result && a.send_result.send_performed === false
    && blockedIncludes(a, 'luna_auto_send_not_enabled')
    && a.sends_whatsapp === false;

  const caseBOk = caseB.status === 200
    && b.draft_called === true
    && b.handoff_required === true
    && b.next_action === 'handoff_to_staff'
    && b.send_attempted === false
    && b.event_persisted === true
    && b.sends_whatsapp === false;

  const caseCOk = caseC.status === 200
    && c.event_persisted === true
    && c.send_attempted === false
    && c.sends_whatsapp === false
    && (c.next_action === 'unsupported' || c.draft_called === true);

  const replayOk = replay.status === 200
    && r.duplicate === true
    && r.idempotent_replay === true
    && r.send_result && r.send_result.send_performed !== true
    && r.sends_whatsapp === false;

  const rowA = dbAfter.guest_message_events.find((x) => x.wa_message_id === WA_A);
  const rowB = dbAfter.guest_message_events.find((x) => x.wa_message_id === WA_B);
  const rowC = dbAfter.guest_message_events.find((x) => x.wa_message_id === WA_C);

  const dbAOk = rowA
    && rowA.draft_called === true
    && rowA.next_action === 'ask_missing_field'
    && rowA.send_attempted === true
    && rowA.send_status === 'blocked'
    && Array.isArray(rowA.send_blocked_reasons)
    && rowA.send_blocked_reasons.includes('luna_auto_send_not_enabled');

  const dbBOk = rowB
    && rowB.handoff_required === true
    && rowB.next_action === 'handoff_to_staff'
    && rowB.send_attempted === false;

  const dbCOk = rowC && rowC.send_attempted === false;

  const noDup = dbAfter.duplicate_wa_counts.length === 0;
  const noSent = dbAfter.sent_after_proof.length === 0;
  const noBookingPayment = dbAfter.bookings.rows.length === 0 && dbAfter.payments.rows.length === 0;

  const blockedForA = dbAfter.blocked_after_proof.filter((x) => x.idempotency_key === expectedAKey);

  let result = 'PASS';
  if (!noSent) result = 'FAIL';
  else if (!caseAOk || !caseBOk || !caseCOk || !replayOk || !dbAOk || !dbBOk || !dbCOk || !noDup) {
    result = 'PARTIAL';
  }

  console.log(JSON.stringify({
    phase: '19g.8b',
    result,
    proof_start: PROOF_START,
    checked_at: new Date().toISOString(),
    commit: COMMIT,
    image: IMAGE,
    revision: rev.name,
    health: { status: health.status, body: health.body },
    webhook_verify: { status: verify.status, body: typeof verify.body === 'string' ? verify.body.slice(0, 40) : verify.body },
    env: stagingEnvFlags(),
    cases: {
      A: { http: caseA.status, response: a, db_row: rowA, pass: caseAOk && dbAOk },
      B: { http: caseB.status, response: b, db_row: rowB, pass: caseBOk && dbBOk },
      C: { http: caseC.status, response: c, db_row: rowC, pass: caseCOk && dbCOk },
    },
    replay: { http: replay.status, response: r, pass: replayOk, sends_before: sendsBeforeReplay.blocked_after_proof.length, sends_after: dbAfter.blocked_after_proof.length },
    guest_message_events_query: dbAfter.guest_message_events,
    duplicate_wa_counts: dbAfter.duplicate_wa_counts,
    guest_message_sends_blocked: dbAfter.blocked_after_proof,
    no_send_proof: { sent_after_proof: dbAfter.sent_after_proof, any_sent: !noSent },
    safety: { bookings: dbAfter.bookings.rows, payments: dbAfter.payments.rows, no_booking_payment: noBookingPayment },
    blocked_row_for_case_a: blockedForA,
  }, null, 2));
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
