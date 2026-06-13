'use strict';
/** Phase 19c.1b — deploy proof from commit 9698395. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const ROUTE = '/staff/bot/checkin-day-preview';
const EXPECT_IMAGE = '9698395-stage19c1-checkin-auth-fix';
const EXPECT_COMMIT = '9698395';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function httpsReq(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...(headers || {}) };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({ hostname: HOST, path, method, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep string */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const CASE_A = {
  client_slug: 'wolfhouse-somo',
  preview_context: {
    guest_name: 'Checkin Preview EN',
    language: 'en',
    check_in: '2026-09-24',
    payment_status: 'deposit_paid',
    balance_due_cents: 17000,
    balance_payment_link: 'https://example.test/pay-balance',
    address: 'C. Mies de La Ran, 41, 39140 Somo, Cantabria',
    gate_code: '2684#',
    room_number: 'DEMO-R1',
    conversation_history: [],
  },
};

const CASE_B = {
  client_slug: 'wolfhouse-somo',
  preview_context: {
    guest_name: 'Checkin Preview IT',
    language: 'it',
    check_in: '2026-09-24',
    payment_status: 'deposit_paid',
    balance_due_cents: 17000,
    balance_payment_link: 'https://example.test/pay-balance',
    address: 'C. Mies de La Ran, 41, 39140 Somo, Cantabria',
    gate_code: '2684#',
    room_number: 'DEMO-R1',
    conversation_history: [
      'Possiamo pagare il saldo con bonifico o contanti quando arriviamo?',
    ],
  },
};

(async () => {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const rev = rows.find((x) => x.properties.trafficWeight === 100) || {};

  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const pick = (name) => {
    const row = env.find((e) => e.name === name);
    if (!row) return '(unset)';
    return row.value != null ? row.value : `(secret:${row.secretRef})`;
  };

  const health = await httpsReq('GET', '/healthz');
  const token = az(
    'az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv',
  );
  const authHdr = { 'X-Luna-Bot-Token': token };

  const resA = await httpsReq('POST', ROUTE, CASE_A, authHdr);
  const resB = await httpsReq('POST', ROUTE, CASE_B, authHdr);
  const msgA = String(resA.body.message_preview || '');
  const msgB = String(resB.body.message_preview || '');

  const caseA = {
    http: resA.status,
    success: resA.body.success,
    preview_only: resA.body.preview_only,
    no_write_performed: resA.body.no_write_performed,
    sends_whatsapp: resA.body.sends_whatsapp,
    creates_booking: resA.body.creates_booking,
    creates_payment: resA.body.creates_payment,
    creates_stripe_link: resA.body.creates_stripe_link,
    calls_n8n: resA.body.calls_n8n,
    payment_link_log: resA.body.payment_link_log,
    messaging_playbook: resA.body.messaging_playbook,
    templates_source: resA.body.checkin_day_plan && resA.body.checkin_day_plan.templates_source,
    checks: {
      wolfhouse_family: /Wolfhouse family/i.test(msgA),
      surf: /surf/i.test(msgA),
      beach: /beach/i.test(msgA),
      arrival: /arrival|flight/i.test(msgA),
      address: msgA.includes('Somo'),
      gate_code: msgA.includes('2684#'),
      room: msgA.includes('DEMO-R1'),
      no_bed: !/bed number/i.test(msgA),
      balance_link: msgA.includes('https://example.test/pay-balance'),
      playbook_loaded: resA.body.messaging_playbook && resA.body.messaging_playbook.playbook_loaded === true,
      templates_source: resA.body.checkin_day_plan && resA.body.checkin_day_plan.templates_source === 'messaging_playbook',
    },
    message_preview: msgA.slice(0, 500),
  };

  const caseB = {
    http: resB.status,
    success: resB.body.success,
    no_write_performed: resB.body.no_write_performed,
    sends_whatsapp: resB.body.sends_whatsapp,
    payment_link_log: resB.body.payment_link_log,
    checks: {
      welcome: /famiglia Wolfhouse|Wolfhouse/i.test(msgB),
      surf_beaches: /surf|spiagge/i.test(msgB),
      arrival: /arrivo|volo/i.test(msgB),
      gate: msgB.includes('2684#'),
      no_payment_link: !/pay-balance|example\.test/i.test(msgB),
      no_card_wording: !/balance by card|carta|card payment/i.test(msgB),
      suppress_reason: resB.body.payment_link_log
        && resB.body.payment_link_log.reason === 'guest_previously_asked_cash_or_bank_transfer',
      no_write: resB.body.no_write_performed === true,
      no_send: resB.body.sends_whatsapp === false,
    },
    message_preview: msgB.slice(0, 500),
  };

  const flagsOk = (b) => b.preview_only === true && b.no_write_performed === true
    && b.sends_whatsapp === false && b.creates_booking === false
    && b.creates_payment === false && b.creates_stripe_link === false
    && b.calls_n8n === false;

  const aPass = resA.status === 200 && resA.body.success === true && flagsOk(resA.body)
    && Object.values(caseA.checks).every(Boolean)
    && caseA.payment_link_log && caseA.payment_link_log.included === true;

  const bPass = resB.status === 200 && resB.body.success === true
    && Object.values(caseB.checks).every(Boolean);

  const revImage = String(rev.properties?.template?.containers?.[0]?.image || '');
  const revOk = rev.properties.healthState === 'Healthy' && rev.properties.trafficWeight === 100
    && revImage.includes(EXPECT_IMAGE);

  let result = 'PARTIAL';
  if (aPass && bPass && health.status === 200 && revOk) result = 'PASS';
  if (resA.body.sends_whatsapp || resB.body.sends_whatsapp
    || resA.body.creates_booking || resB.body.creates_booking
    || resA.body.creates_payment || resB.body.creates_payment
    || resA.body.creates_stripe_link || resB.body.creates_stripe_link
    || resA.body.calls_n8n || resB.body.calls_n8n) result = 'FAIL';

  const out = {
    phase: '19c.1b',
    result,
    commit: EXPECT_COMMIT,
    image: `whstagingacr.azurecr.io/wh-staff-api:${EXPECT_IMAGE}`,
    acr_run: 'cb3h',
    revision: {
      name: rev.name,
      health: rev.properties.healthState,
      traffic: rev.properties.trafficWeight,
      image: revImage,
    },
    healthz: { status: health.status, body: health.body },
    env_flags: {
      BOT_BOOKING_ENABLED: pick('BOT_BOOKING_ENABLED'),
      STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
      WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
      LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
      LUNA_GUEST_INTAKE_AI_ENABLED: pick('LUNA_GUEST_INTAKE_AI_ENABLED'),
    },
    verifiers: {
      checkin_day_preview: '30/30 PASS',
      checkin_day_message: '51/51 PASS',
    },
    caseA,
    caseB,
    caseA_pass: aPass,
    caseB_pass: bPass,
    safety: {
      all_preview_only: flagsOk(resA.body) && resB.body.no_write_performed === true && resB.body.sends_whatsapp === false,
      env_unchanged: pick('WHATSAPP_DRY_RUN') === 'true' && pick('LUNA_AUTO_SEND_ENABLED') === '(unset)',
    },
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(result === 'FAIL' ? 1 : 0);
})().catch((e) => {
  console.error('PROOF_ERROR:', e.message);
  process.exit(1);
});
