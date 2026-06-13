'use strict';
/** Stage 49c.1 — deploy package-choice fix to staging + hosted dry-run + live WhatsApp proof. Temp — do not commit. */

const crypto = require('crypto');
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const COMMIT = '09fecc7';
const IMAGE_TAG = `${COMMIT}-stage49c-package-choice`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's49c-package-choice';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const DEMO_PHONE_ID = '1152900101233109';
const REVIEW_ROUTE = '/staff/bot/guest-inbound-review-dry-run';

const LIVE_PHONE = '+34600995581';
const LIVE_FROM = '34600995581';

const ENV_EXPECT = {
  LUNA_GUEST_AGENT_BRAIN_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'false',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'true',
  LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: null,
  LUNA_GUEST_AGENT_BRAIN_ENABLED_PROD: null,
};

const TRANSCRIPT = [
  'Hello!',
  'lets book a stay',
  'June 11th to 20th',
  '3',
  'Tell me about the packages',
  'ok Malibu',
];

const HANDOFF_RE = /looping in our Wolfhouse team|passing this to our team|hand off|handoff|staff will follow up|follow up soon/i;
const STALL_RE = /I can look into it|not confirming availability yet/i;
const WELCOME_RE = /i can help you book a stay|checking some info/i;
const STRIPE_RE = /stripe link|checkout\.stripe/i;

const cmd = process.argv[2] || 'status';
const extraArg = process.argv[3] || '';

function az(cmdStr, retries = 3) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      return execSync(cmdStr, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) {
      last = err;
      if (i < retries - 1) execSync('powershell -Command "Start-Sleep -Seconds 2"', { stdio: 'ignore' });
    }
  }
  throw last;
}

function sleep(ms) { execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: 'ignore' }); }

function httpsJson(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: STAFF_HOST, path: reqPath, method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((r) => r.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties?.healthState,
    traffic: a.properties?.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

function envPick() {
  const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const env = app.properties.template.containers[0].env || [];
  const out = {};
  for (const n of Object.keys(ENV_EXPECT)) {
    const e = env.find((x) => x.name === n);
    if (!e) out[n] = null;
    else if (e.secretRef) out[n] = { secretRef: e.secretRef };
    else out[n] = e.value;
  }
  return out;
}

function envMatches(actual) {
  const checks = {};
  for (const [k, expected] of Object.entries(ENV_EXPECT)) {
    const v = actual[k];
    if (expected === null) checks[k] = v == null || v === '' || v === 'false';
    else checks[k] = v === expected;
  }
  return checks;
}

function healthz() {
  return execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${STAFF_HOST}/healthz`, { encoding: 'utf8' }).trim();
}

function resolveBotToken() {
  try {
    return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
  } catch { return ''; }
}

function deploy() {
  const head = az('git rev-parse --short HEAD');
  if (!head.startsWith(COMMIT)) throw new Error(`HEAD is ${head}, expected ${COMMIT}`);
  console.error(`[deploy] acr build ${IMAGE_TAG}...`);
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.error('[deploy] containerapp update (image only, no env changes)...');
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REV_SUFFIX}`,
    '-o none',
  ].join(' '));
  for (let i = 0; i < 60; i++) {
    const rev = activeRevision();
    const hz = healthz();
    console.error(`[deploy] wait ${i + 1}/60 rev=${rev.name} health=${rev.health} hz=${hz}`);
    if (String(rev.image || '').includes(COMMIT) && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200') return rev;
    sleep(10000);
  }
  throw new Error('deploy did not become healthy in time');
}

function buildReviewPayload(phone, message, guestContext, turnIndex, tag) {
  return {
    source: 'stage49c1_hosted_proof',
    client_slug: CLIENT,
    channel: 'whatsapp',
    guest_phone: phone,
    contact_name: 'Stage49c1 Guest',
    message_text: message,
    reference_date: '2026-06-11',
    received_at: new Date().toISOString(),
    inbound_message_id: `stage49c1-${tag}-${crypto.randomBytes(6).toString('hex')}-t${turnIndex + 1}`,
    automation_gate_context: {
      public_guest_automation_enabled: false,
      whatsapp_dry_run: true,
      live_send_allowed: false,
    },
    ...(guestContext ? { guest_context: guestContext } : {}),
  };
}

async function runDryRunTurn(token, phone, message, guestContext, turnIndex, tag) {
  const headers = token ? { 'X-Luna-Bot-Token': token } : {};
  const res = await httpsJson('POST', REVIEW_ROUTE, buildReviewPayload(phone, message, guestContext, turnIndex, tag), headers);
  const body = res.body || {};
  const review = body.review || {};
  const r = review.result || {};
  const agent = r.guest_agent_brain || {};
  const fields = r.extracted_fields || {};
  const plan = review.hold_payment_draft_plan || body.hold_payment_draft_plan || {};
  const pc = review.payment_choice || body.payment_choice || {};
  const quote = review.quote || body.quote || {};
  const reply = String(review.proposed_luna_reply || body.proposed_luna_reply || '');
  return {
    http_status: res.status,
    message,
    reply,
    reply_preview: reply.slice(0, 900),
    handoff: HANDOFF_RE.test(reply) || r.safe_handoff_required === true,
    stall: STALL_RE.test(reply),
    fields,
    quote_status: quote.quote_status,
    quote_total: quote.total_amount || quote.quote_total,
    payment_choice_ready: pc.payment_choice_ready === true,
    plan_status: plan.plan_status,
    write_ready: plan.ready_for_hold_draft === true,
    no_write: body.no_write_performed === true,
    creates_booking: body.creates_booking === true,
    creates_stripe_link: body.creates_stripe_link === true,
    agent: {
      agent_brain_enabled: agent.agent_brain_enabled,
      agent_intent: agent.agent_intent,
      agent_final_reply_source: agent.agent_final_reply_source,
      agent_fallback_used: agent.agent_fallback_used,
      agent_tool_calls: agent.agent_tool_calls,
    },
    slim_guest_context: body.slim_guest_context_for_next_turn || null,
  };
}

async function hostedTranscript(token, phone, messages, tag) {
  const turns = [];
  let ctx = null;
  for (let i = 0; i < messages.length; i++) {
    const t = await runDryRunTurn(token, phone, messages[i], ctx, i, tag);
    turns.push(t);
    ctx = t.slim_guest_context;
  }
  return turns;
}

async function dryRunProof() {
  const token = resolveBotToken();
  const out = { phase: 'stage49c1-dryrun', revision: activeRevision(), healthz: healthz(), env: envPick() };
  out.env_checks = envMatches(out.env);

  const phone = `+34602${String(Date.now()).slice(-6)}`;
  const turns = await hostedTranscript(token, phone, TRANSCRIPT, 'main');
  out.transcript = turns.map((t) => ({
    message: t.message,
    reply_preview: t.reply_preview,
    fields: t.fields,
    quote_status: t.quote_status,
    payment_choice_ready: t.payment_choice_ready,
    handoff: t.handoff,
    stall: t.stall,
    agent: t.agent,
  }));

  const t4 = turns[4]; // Tell me about the packages
  const t5 = turns[5]; // ok Malibu
  const mid = turns.slice(1, 4);

  out.checks = {
    no_handoff_any_turn: turns.every((t) => !t.handoff),
    no_stall_any_turn: turns.every((t) => !t.stall),
    mid_no_welcome_reset: !mid.some((t) => WELCOME_RE.test(t.reply)),
    dates_after_count: turns[3].fields.check_in === '2026-06-11' && turns[3].fields.check_out === '2026-06-20',
    count_preserved_turn5: t5.fields.guest_count === 3,
    dates_preserved_turn5: t5.fields.check_in === '2026-06-11' && t5.fields.check_out === '2026-06-20',
    package_turn_has_all_three: /malibu/i.test(t4.reply) && /uluwatu/i.test(t4.reply) && /waimea/i.test(t4.reply),
    package_turn_has_line_breaks: /\n/.test(t4.reply),
    package_turn_no_giant_paragraph_only: t4.reply.split('\n').length >= 3,
    malibu_selected_turn5: /malibu/i.test(String(t5.fields.package_choice || t5.fields.package || '')) || /malibu/i.test(t5.reply),
    quote_ready_turn5: t5.quote_status === 'ready',
    quote_reply_has_total: /total|quote|checked|availability/i.test(t5.reply),
    payment_choice_asked_turn5: /deposit|full payment|pay in full/i.test(t5.reply),
    turn5_no_stall: !t5.stall,
    turn5_no_handoff: !t5.handoff,
    no_write_until_payment: turns.every((t) => t.no_write === true && !t.creates_booking && !t.creates_stripe_link),
    no_stripe_before_payment: !turns.slice(0, 5).some((t) => STRIPE_RE.test(t.reply)),
  };

  out.result = Object.values(out.checks).every(Boolean) ? 'PASS' : 'FAIL';
  return out;
}

function buildMetaPayload(fromDigits, wamid, messageText) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: DEMO_PHONE_ID },
          contacts: [{ profile: { name: 'Stage49c Live Guest' } }],
          messages: [{
            from: fromDigits,
            id: wamid,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: messageText },
          }],
        },
        field: 'messages',
      }],
    }],
  };
}

async function queryDb(proofStart) {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  if (!/staging|wolfhouse_staging/i.test(whUrl)) throw new Error('DB guard: not staging URL');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const phoneRaw = LIVE_PHONE.replace(/^\+/, '');

  const msgs = (await pg.query(`
    SELECT m.direction::text, m.message_text AS body, m.created_at::text
      FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = $3 AND (c.phone = $1 OR c.phone = $2)
       AND m.created_at >= $4::timestamptz
     ORDER BY m.created_at ASC`,
    [LIVE_PHONE, phoneRaw, CLIENT, proofStart])).rows;

  const sends = (await pg.query(`
    SELECT idempotency_key, status, to_phone, send_kind, LEFT(message_text, 800) AS message_text, created_at::text
      FROM guest_message_sends
     WHERE created_at >= $1::timestamptz AND (to_phone = $2 OR to_phone = $3)
     ORDER BY created_at ASC`,
    [proofStart, LIVE_PHONE, phoneRaw])).rows;

  const bookings = (await pg.query(
    'SELECT id, status, check_in::text, check_out::text, guest_count, created_at::text FROM bookings WHERE created_at >= $1::timestamptz ORDER BY created_at DESC LIMIT 5',
    [proofStart])).rows;

  const payments = (await pg.query(
    'SELECT id, status, stripe_checkout_session_id, created_at::text FROM payments WHERE created_at >= $1::timestamptz ORDER BY created_at DESC LIMIT 5',
    [proofStart])).rows;

  const confirmSends = (await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE created_at >= $1::timestamptz AND (to_phone = $2 OR to_phone = $3) AND send_kind ILIKE '%confirm%'`,
    [proofStart, LIVE_PHONE, phoneRaw])).rows[0].n;

  await pg.end();
  return { msgs, sends, bookings, payments, confirmSends };
}

async function liveProof(includeDeposit = false) {
  const proofStart = new Date().toISOString();
  const messages = includeDeposit ? [...TRANSCRIPT, 'Deposit is fine'] : TRANSCRIPT;
  const out = { phase: 'stage49c1-live', phone: LIVE_PHONE, proof_start: proofStart, include_deposit: includeDeposit, turns: [], transcript: [], live_sends: [] };

  for (let i = 0; i < messages.length; i++) {
    const wamid = `wamid.49c1-${Date.now()}-t${i + 1}-${crypto.randomBytes(6).toString('hex')}`;
    console.error(`[live turn ${i + 1}] ${messages[i]}`);
    const resp = await httpsJson('POST', '/staff/meta/whatsapp/webhook', buildMetaPayload(LIVE_FROM, wamid, messages[i]));
    const body = resp.body || {};
    const sendResult = body.send_result || {};
    out.turns.push({
      turn: i + 1,
      message: messages[i],
      http_status: resp.status,
      send_performed: sendResult.send_performed === true || body.whatsapp_sent === true,
    });
    await new Promise((r) => setTimeout(r, i === messages.length - 1 ? 20000 : 14000));
  }

  const db = await queryDb(proofStart);
  out.transcript = db.msgs;
  out.live_sends = db.sends;
  out.bookings = db.bookings;
  out.payments = db.payments;

  const outbound = db.msgs.filter((m) => m.direction === 'outbound' || m.direction === 'outgoing');
  const inbound = db.msgs.filter((m) => m.direction === 'inbound' || m.direction === 'incoming');
  const pkgReply = outbound.find((m) => /malibu/i.test(m.body) && /uluwatu/i.test(m.body)) || { body: '' };
  const quoteReply = outbound[outbound.length - 1] || { body: '' };
  const midOut = outbound.slice(1, 4);

  out.checks = {
    inbound_count: inbound.length === messages.length,
    one_reply_per_inbound: outbound.length === messages.length,
    sends_recorded: db.sends.length >= outbound.length,
    package_reply_has_line_breaks_db: /\n/.test(pkgReply.body),
    package_reply_has_three_packages: /malibu/i.test(pkgReply.body) && /uluwatu/i.test(pkgReply.body) && /waimea/i.test(pkgReply.body),
    whatsapp_send_preserves_line_breaks: db.sends.some((s) => /\n/.test(String(s.message_text || ''))),
    quote_reply_has_payment_choice: /deposit|full payment|pay in full/i.test(quoteReply.body),
    quote_reply_no_stall: !STALL_RE.test(quoteReply.body),
    quote_reply_no_handoff: !HANDOFF_RE.test(quoteReply.body),
    mid_no_welcome_repeat: !midOut.some((m) => WELCOME_RE.test(m.body)),
    no_confirmation_sends: db.confirmSends === 0,
  };

  if (includeDeposit) {
    out.checks.deposit_booking_or_hold = db.bookings.length >= 1 || db.payments.length >= 1;
    out.checks.stripe_test_only = db.payments.every((p) => !p.stripe_checkout_session_id || /test/i.test(p.stripe_checkout_session_id) || /cs_test/i.test(p.stripe_checkout_session_id));
    out.checks.no_confirmation_after_deposit = db.confirmSends === 0;
  } else {
    out.checks.no_booking_before_payment = db.bookings.length === 0;
    out.checks.no_payment_before_payment_choice = db.payments.length === 0;
  }

  out.result = Object.values(out.checks).every(Boolean) ? 'PASS' : 'FAIL';
  return out;
}

(async () => {
  try {
    if (cmd === 'deploy') {
      const rev = deploy();
      console.log(JSON.stringify({ phase: 'deploy', commit: COMMIT, image: IMAGE, revision: rev, healthz: healthz(), env: envPick(), env_checks: envMatches(envPick()) }, null, 2));
    } else if (cmd === 'dryrun') {
      const r = await dryRunProof();
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.result === 'PASS' ? 0 : 1);
    } else if (cmd === 'live') {
      const includeDeposit = extraArg === 'deposit';
      const r = await liveProof(includeDeposit);
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.result === 'PASS' ? 0 : 1);
    } else {
      console.log(JSON.stringify({ revision: activeRevision(), healthz: healthz(), env: envPick(), env_checks: envMatches(envPick()) }, null, 2));
    }
  } catch (e) {
    console.error(e.stderr || e.stdout || e.message || e);
    process.exit(1);
  }
})();
