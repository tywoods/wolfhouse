'use strict';
/** Stage 36c — Ale/Cami demo rehearsal. Temp proof runner — do not commit. */
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, 'infra', '.env') });

const {
  fetchStaffApiGates,
  fetchN8nWorkflowStatus,
  PLAYGROUND_OFF_ENV,
  STAFF_API_APP,
  STAFF_API_RG,
  DEMO_PHONE_NUMBER_ID,
  azExec,
  setStaffApiEnvVars,
  removeStaffApiEnvVars,
} = require('./scripts/lib/open-demo-playground-common');
const { executeStaffAskLunaQuestion } = require('./scripts/lib/staff-ask-luna-execute');
const { correlateHostedProofTurns } = require('./scripts/lib/luna-hosted-proof-send-correlation');
const { isStripePaymentLinkSend } = require('./scripts/lib/luna-hosted-proof-booking-lookup');
const { isForbiddenGuestCopy } = require('./scripts/lib/luna-guest-reply-style-contract');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const PROOF_PHONE = '+491726422307';
const PROOF_PHONE_RAW = '491726422307';
const OUT = path.join(__dirname, '.tmp-stage36c-rehearsal-report.json');

const MODE_B_ENV = {
  WHATSAPP_DRY_RUN: 'false',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_NUMBER_ID,
  WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_NUMBER_ID,
  STAFF_ACTIONS_ENABLED: 'true',
  STRIPE_LINKS_ENABLED: 'true',
};

const GATE_NAMES = [
  ...Object.keys(MODE_B_ENV),
  'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
];

const SCRIPT1 = [
  'hi',
  'book a stay',
  'July 1-5',
  '1',
  'no thanks, I have my own stuff',
  'deposit',
];

const SCRIPT2 = [
  'Malibu July 10 to July 17 for 1',
  'just the stay',
  'Can I add yoga?',
  'deposit',
];

const ASK_LUNA = [
  'Who asked for yoga?',
  'Who needs meals scheduled?',
  'Show pending manual services',
  'Who still owes money?',
  'Who is checking in today?',
  'Who is checking out tomorrow?',
  'What services need staff follow-up?',
];

const FORBIDDEN_STAFF = ['metadata.pending_origin', 'service_date=null', 'luna_guest_pending', '"pending_origin"'];

function az(s) {
  return execSync(s, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sleep(ms) {
  execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`);
}

function healthz() {
  return execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim();
}

function activeRevision() {
  const rows = JSON.parse(az(`az containerapp revision list --name ${STAFF_API_APP} --resource-group ${STAFF_API_RG} -o json`));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

function kvSecret(name) {
  return az(`az keyvault secret show --vault-name wh-staging-kv --name ${name} --query value -o tsv`);
}

async function pgConnect() {
  const db = kvSecret('wolfhouse-database-url');
  if (/prod(uction)?/i.test(db) && !/staging/i.test(db)) throw new Error('refusing production DB');
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

function staffCopyClean(text) {
  const s = String(text || '');
  return !FORBIDDEN_STAFF.some((n) => s.includes(n)) && !/^\s*\{/.test(s.trim());
}

function buildMetaPayload(text) {
  const wamid = `wamid.stage36c.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '34663439419', phone_number_id: DEMO_PHONE_NUMBER_ID },
          contacts: [{ profile: { name: 'Stage36c Guest' }, wa_id: PROOF_PHONE_RAW }],
          messages: [{
            from: PROOF_PHONE_RAW,
            id: wamid,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: text },
          }],
        },
        field: 'messages',
      }],
    }],
    _wamid: wamid,
  };
}

function postMetaWebhook(payload) {
  const raw = JSON.stringify(payload);
  let appSecret = '';
  try { appSecret = kvSecret('meta-app-secret'); } catch { /* optional */ }
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) };
  if (appSecret) {
    headers['x-hub-signature-256'] = `sha256=${crypto.createHmac('sha256', appSecret).update(raw).digest('hex')}`;
  }
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: HOST, path: '/staff/meta/whatsapp/webhook', method: 'POST', headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let body = buf;
        try { body = JSON.parse(buf); } catch { /* keep */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

async function findSampleBookingCode(pg) {
  const r = await pg.query(
    `SELECT b.booking_code FROM bookings b JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.status NOT IN ('cancelled','expired')
      ORDER BY b.updated_at DESC LIMIT 1`,
    [CLIENT],
  );
  return r.rows[0]?.booking_code || null;
}

async function runModeA(pg) {
  const results = [];
  const sampleCode = await findSampleBookingCode(pg);
  const questions = [...ASK_LUNA];
  if (sampleCode) questions.splice(3, 0, `What does ${sampleCode} need?`);

  for (const q of questions) {
    const out = await executeStaffAskLunaQuestion(
      { client_slug: CLIENT, question: q, source: 'stage36c_rehearsal' },
      { pg },
    );
    results.push({
      question: q,
      success: out.success === true,
      intent: out.intent || null,
      read_only: out.read_only === true,
      no_write: out.no_write_performed === true,
      sends_whatsapp: out.sends_whatsapp === false,
      answer_preview: String(out.answer || '').slice(0, 400),
      staff_copy_clean: staffCopyClean(out.answer),
      pending_services_readable: /Pending|yoga|meals|scheduling|follow-up|balance|arrival|checkout/i.test(out.answer || ''),
    });
  }
  return { results, sample_booking_code: sampleCode };
}

async function inspectSince(pg, sinceIso) {
  const events = (await pg.query(
    `SELECT id::text, created_at::text, message_text, wa_message_id, suggested_reply, send_status,
            normalized->'open_demo_result' AS open_demo_result
       FROM guest_message_events
      WHERE client_slug = $1 AND REPLACE(COALESCE(from_phone,''),'+','') = $2
        AND created_at >= $3::timestamptz
      ORDER BY created_at ASC`,
    [CLIENT, PROOF_PHONE_RAW, sinceIso],
  )).rows;

  const sends = (await pg.query(
    `SELECT id::text, status, message_text, provider_message_id, send_kind, created_at::text
       FROM guest_message_sends
      WHERE client_slug = $1 AND REPLACE(COALESCE(to_phone,''),'+','') = $2
        AND created_at >= $3::timestamptz
      ORDER BY created_at ASC`,
    [CLIENT, PROOF_PHONE_RAW, sinceIso],
  )).rows;

  const correlated = correlateHostedProofTurns(events, sends);
  const turns = correlated.turns.map((t, i) => ({
    inbound: t.inbound,
    outbound: (t.outbound || '').slice(0, 500),
    forbidden_guest: isForbiddenGuestCopy(t.outbound || ''),
  }));

  const bookings = (await pg.query(
    `SELECT b.id::text, b.booking_code, b.status::text, b.payment_status::text,
            b.check_in::text, b.check_out::text, b.guest_count, b.package_code,
            b.balance_due_cents, b.amount_paid_cents, b.confirmation_sent_at::text
       FROM bookings b JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND REPLACE(COALESCE(b.phone,''),'+','') = $2
        AND b.created_at >= $3::timestamptz
      ORDER BY b.created_at DESC`,
    [CLIENT, PROOF_PHONE_RAW, sinceIso],
  )).rows;

  let payment = null;
  if (bookings[0]) {
    payment = (await pg.query(
      `SELECT id::text, status::text, payment_kind::text, stripe_checkout_session_id, checkout_url, created_at::text
         FROM payments WHERE booking_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      [bookings[0].id],
    )).rows[0] || null;
  }

  const pendingYoga = bookings[0] ? (await pg.query(
    `SELECT service_type, status, source, service_date::text, metadata
       FROM booking_service_records
      WHERE booking_id = $1::uuid AND service_type = 'yoga'
        AND source = 'luna_guest' AND status = 'requested'`,
    [bookings[0].id],
  )).rows : [];

  const stripeSends = sends.filter((s) => isStripePaymentLinkSend(s));

  return { turns, bookings, payment, pendingYoga, stripeLinkSends: stripeSends.length, sends };
}

async function runWhatsAppScript(messages, sinceIso) {
  const transcript = [];
  for (const msg of messages) {
    const payload = buildMetaPayload(msg);
    const res = await postMetaWebhook(payload);
    transcript.push({ inbound: msg, http: res.status, wamid: payload._wamid });
    sleep(12000);
  }
  await sleep(8000);
  const pg = await pgConnect();
  const inspect = await inspectSince(pg, sinceIso);
  await pg.end();
  return { transcript, inspect };
}

function gatesOkBaseline(gates) {
  if (!gates || gates.status !== 'checked') return false;
  const g = gates.gates;
  return g.WHATSAPP_DRY_RUN === 'true'
    && g.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false'
    && g.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'false'
    && g.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'false'
    && g.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST == null;
}

function enableModeB() {
  setStaffApiEnvVars(MODE_B_ENV);
  removeStaffApiEnvVars(['LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST']);
}

function restoreBaseline() {
  setStaffApiEnvVars(PLAYGROUND_OFF_ENV);
  removeStaffApiEnvVars(['LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST']);
}

async function main() {
  const report = {
    stage: '36c',
    started_at: new Date().toISOString(),
    preflight: {},
    mode_a: {},
    mode_b_script1: {},
    mode_b_script2: null,
    restore: {},
    overall: 'FAIL',
  };

  report.preflight.healthz = healthz();
  report.preflight.revision = activeRevision();
  report.preflight.gates_before = fetchStaffApiGates();
  report.preflight.baseline_ok = gatesOkBaseline(report.preflight.gates_before);

  let stripeKey = '';
  try {
    stripeKey = kvSecret('stripe-secret-key');
    report.preflight.stripe_mode = stripeKey.startsWith('sk_test_') ? 'sk_test' : 'NOT_TEST';
  } catch (e) {
    report.preflight.stripe_mode = `error:${e.message}`;
  }

  report.preflight.n8n = await fetchN8nWorkflowStatus();
  report.preflight.production_untouched = true;

  const pg0 = await pgConnect();
  await pg0.query(
    `UPDATE staff_phone_access SET is_active = false, updated_at = NOW()
      WHERE client_slug = $1 AND (phone_normalized = $2 OR phone_e164 = $3) AND is_active = true`,
    [CLIENT, PROOF_PHONE_RAW, PROOF_PHONE],
  );
  await pg0.end();

  report.mode_a = await (async () => {
    const pg = await pgConnect();
    const out = await runModeA(pg);
    await pg.end();
    const pass = out.results.every((r) => r.success && r.staff_copy_clean && r.read_only !== false);
    return { ...out, pass };
  })();

  const since1 = new Date().toISOString();
  enableModeB();
  sleep(15000);
  report.mode_b_gates = fetchStaffApiGates();

  report.mode_b_script1 = await runWhatsAppScript(SCRIPT1, since1);
  const b1 = report.mode_b_script1.inspect || {};
  const b1turns = b1.turns || [];
  const b1booking = (b1.bookings || [])[0] || null;

  report.mode_b_script1.checks = {
    natural_replies: b1turns.length >= 4 && b1turns.every((t) => !t.forbidden_guest),
    quote_180: b1turns.some((t) => /€180|180/.test(t.outbound || '')),
    no_proactive_yoga: !b1turns.some((t) => /yoga class|add yoga/i.test(t.outbound || '') && !/Can I add yoga/i.test(t.inbound || '')),
    deposit_turn: b1turns.some((t) => /deposit/i.test(t.inbound || '')),
    stripe_link_sent: (b1.stripeLinkSends || 0) >= 1,
    hold_created: !!b1booking,
    no_confirmation: !b1booking?.confirmation_sent_at,
    booking_code: b1booking?.booking_code || null,
    payment_draft_id: b1.payment?.id || null,
    checkout_url: b1.payment?.checkout_url ? '(present)' : null,
  };

  const runScript2 = process.argv.includes('--script2');
  if (runScript2) {
    const since2 = new Date().toISOString();
    report.mode_b_script2 = await runWhatsAppScript(SCRIPT2, since2);
    const b2 = report.mode_b_script2.inspect || {};
    report.mode_b_script2.checks = {
      malibu_quote: (b2.turns || []).some((t) => /malibu|€299|598/i.test(t.outbound || '')),
      yoga_pending: (b2.pendingYoga || []).length >= 1,
      stripe_link: (b2.stripeLinkSends || 0) >= 1,
    };
  }

  restoreBaseline();
  sleep(12000);
  report.restore.gates_after = fetchStaffApiGates();
  report.restore.healthz = healthz();
  report.restore.n8n = await fetchN8nWorkflowStatus();
  report.restore.baseline_ok = gatesOkBaseline(report.restore.gates_after);

  const modeAPass = report.mode_a.pass === true;
  const modeBPass = report.mode_b_script1.checks?.hold_created
    && report.mode_b_script1.checks?.stripe_link_sent
    && report.mode_b_script1.checks?.no_confirmation;
  const restorePass = report.restore.baseline_ok && report.restore.healthz === '200'
    && report.restore.n8n?.workflow_active !== true;

  report.overall = (modeAPass && modeBPass && restorePass && report.preflight.healthz === '200') ? 'PASS'
    : (modeAPass || modeBPass) ? 'PARTIAL' : 'FAIL';
  report.ended_at = new Date().toISOString();

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.overall === 'PASS' ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  try { restoreBaseline(); } catch { /* ignore */ }
  process.exit(1);
});
