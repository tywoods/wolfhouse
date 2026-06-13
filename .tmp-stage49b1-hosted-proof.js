'use strict';
/** Stage 49b.1 — deploy Luna Agent Brain v1 to staging + hosted dry-run + live webhook proof. Temp — do not commit. */

const crypto = require('crypto');
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const COMMIT = '61ea71c';
const IMAGE_TAG = `${COMMIT}-stage49b-agent-brain`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's49b-agent-brain';
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

const TRANSCRIPT_A = ['Oh hello', 'lets book a stay', 'June 12-22', '3', 'tell me more about the packages'];
const TRANSCRIPT_B = ['book a stay', 'June 12 to June 20', '3', 'Malibu', 'deposit is fine'];

const HANDOFF_RE = /looping in our Wolfhouse team|passing this to our team|hand off|handoff|staff will follow up|follow up soon/i;
const EXPLAIN_ASK_RE = /want me to explain them quickly|do you already know which one you prefer/i;
const WELCOME_RE = /i can help you book a stay|checking some info/i;
const STRIPE_RE = /stripe link|checkout\.stripe/i;

const cmd = process.argv[2] || 'status';

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
  console.error('[deploy] containerapp update (sets LUNA_GUEST_AGENT_BRAIN_ENABLED=true)...');
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REV_SUFFIX}`,
    '--set-env-vars LUNA_GUEST_AGENT_BRAIN_ENABLED=true',
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
    source: 'stage49b1_hosted_proof',
    client_slug: CLIENT,
    channel: 'whatsapp',
    guest_phone: phone,
    contact_name: 'Stage49b1 Guest',
    message_text: message,
    reference_date: '2026-06-11',
    received_at: new Date().toISOString(),
    inbound_message_id: `stage49b1-${tag}-${crypto.randomBytes(6).toString('hex')}-t${turnIndex + 1}`,
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
    reply: reply.slice(0, 900),
    handoff: HANDOFF_RE.test(reply) || r.safe_handoff_required === true,
    fields,
    quote_status: quote.quote_status,
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
      agent_safety_notes: agent.agent_safety_notes,
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
  const out = { phase: 'stage49b1-dryrun', revision: activeRevision(), healthz: healthz(), env: envPick() };
  out.env_checks = envMatches(out.env);

  const phoneA = `+34600${String(Date.now()).slice(-6)}`;
  const a = await hostedTranscript(token, phoneA, TRANSCRIPT_A, 'A');
  const a5 = a[4];
  const aMid = a.slice(1, 4);
  out.transcript_a = a;
  out.checks_a = {
    turn5_no_handoff: !a5.handoff,
    turn5_dates_preserved: a5.fields.check_in === '2026-06-12' && a5.fields.check_out === '2026-06-22',
    turn5_count_preserved: a5.fields.guest_count === 3,
    turn5_agent_enabled: a5.agent.agent_brain_enabled === true,
    turn5_agent_owned_reply: a5.agent.agent_final_reply_source === 'agent_brain',
    turn5_agent_intent_package_info: a5.agent.agent_intent === 'package_info',
    turn5_has_packages: /malibu/i.test(a5.reply) && /uluwatu/i.test(a5.reply) && /waimea/i.test(a5.reply),
    turn5_no_explain_ask: !EXPLAIN_ASK_RE.test(a5.reply),
    turn5_next_step: /\?/.test(a5.reply),
    turn5_no_write: a5.no_write === true && !a5.creates_booking && !a5.creates_stripe_link && !a5.write_ready,
    turn5_no_stripe: !STRIPE_RE.test(a5.reply),
    mid_no_welcome_reset: !aMid.some((t) => WELCOME_RE.test(t.reply)),
    intake_turns_agent_endorses: aMid.every((t) => t.agent.agent_fallback_used === true),
  };

  const phoneB = `+34601${String(Date.now()).slice(-6)}`;
  const b = await hostedTranscript(token, phoneB, TRANSCRIPT_B, 'B');
  const b5 = b[4];
  const replies = b.map((t) => t.reply);
  out.transcript_b = b;
  out.checks_b = {
    no_handoff_any_turn: b.every((t) => !t.handoff),
    no_repeated_replies: new Set(replies).size === replies.length,
    quote_ready_after_package: b[3].quote_status === 'ready',
    payment_choice_ready_after_deposit: b5.payment_choice_ready === true,
    hold_plan_ready: b5.plan_status === 'ready',
    agent_does_not_block_tools: b.every((t) => t.agent.agent_fallback_used === true),
    agent_enabled_b: b.every((t) => t.agent.agent_brain_enabled === true),
    dry_run_no_writes: b.every((t) => t.no_write === true && !t.creates_booking),
    no_live_stripe: b.every((t) => !t.creates_stripe_link),
  };

  out.result = Object.values(out.checks_a).every(Boolean) && Object.values(out.checks_b).every(Boolean)
    ? 'PASS' : 'FAIL';
  return out;
}

function buildMetaPayload(fromDigits, wamid, messageText) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: DEMO_PHONE_ID },
          contacts: [{ profile: { name: 'Stage49b Live Guest' } }],
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

async function liveProof() {
  const proofStart = new Date().toISOString();
  const out = { phase: 'stage49b1-live', phone: LIVE_PHONE, proof_start: proofStart, turns: [], transcript: [], live_sends: [] };

  for (let i = 0; i < TRANSCRIPT_A.length; i++) {
    const wamid = `wamid.49b1-${Date.now()}-t${i + 1}-${crypto.randomBytes(6).toString('hex')}`;
    console.error(`[live turn ${i + 1}] ${TRANSCRIPT_A[i]}`);
    const resp = await httpsJson('POST', '/staff/meta/whatsapp/webhook', buildMetaPayload(LIVE_FROM, wamid, TRANSCRIPT_A[i]));
    const body = resp.body || {};
    const sendResult = body.send_result || {};
    out.turns.push({
      turn: i + 1,
      message: TRANSCRIPT_A[i],
      http_status: resp.status,
      send_performed: sendResult.send_performed === true || body.whatsapp_sent === true,
    });
    await new Promise((r) => setTimeout(r, i === TRANSCRIPT_A.length - 1 ? 18000 : 12000));
  }

  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  if (!/staging|wolfhouse_staging/i.test(whUrl)) throw new Error('DB guard: not staging URL');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const phoneRaw = LIVE_PHONE.replace(/^\+/, '');
  const msgs = (await pg.query(`
    SELECT m.direction::text, LEFT(m.message_text, 500) AS body, m.created_at::text
      FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = $3 AND (c.phone = $1 OR c.phone = $2)
       AND m.created_at >= $4::timestamptz
     ORDER BY m.created_at ASC`,
    [LIVE_PHONE, phoneRaw, CLIENT, proofStart])).rows;
  out.transcript = msgs;

  const sends = (await pg.query(`
    SELECT idempotency_key, status, to_phone, send_kind, created_at::text
      FROM guest_message_sends
     WHERE created_at >= $1::timestamptz AND (to_phone = $2 OR to_phone = $3)
     ORDER BY created_at ASC`,
    [proofStart, LIVE_PHONE, phoneRaw])).rows;
  out.live_sends = sends;

  const bookings = (await pg.query(
    'SELECT COUNT(*)::int AS n FROM bookings WHERE created_at >= $1::timestamptz', [proofStart])).rows[0].n;
  const payments = (await pg.query(
    'SELECT COUNT(*)::int AS n FROM payments WHERE created_at >= $1::timestamptz', [proofStart])).rows[0].n;
  const confirmSends = (await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE created_at >= $1::timestamptz AND (to_phone = $2 OR to_phone = $3) AND send_kind ILIKE '%confirm%'`,
    [proofStart, LIVE_PHONE, phoneRaw])).rows[0].n;
  await pg.end();

  const outbound = msgs.filter((m) => m.direction === 'outbound' || m.direction === 'outgoing');
  const inbound = msgs.filter((m) => m.direction === 'inbound' || m.direction === 'incoming');
  const lastOut = outbound[outbound.length - 1] || { body: '' };
  const midOut = outbound.slice(1, 4);

  out.checks = {
    five_inbound: inbound.length === 5,
    one_reply_per_inbound: outbound.length === 5,
    sends_recorded: sends.length >= outbound.length,
    last_reply_has_packages: /malibu/i.test(lastOut.body) && /uluwatu/i.test(lastOut.body) && /waimea/i.test(lastOut.body),
    last_reply_no_explain_ask: !EXPLAIN_ASK_RE.test(lastOut.body),
    last_reply_next_step: /\?/.test(lastOut.body),
    last_reply_no_handoff: !HANDOFF_RE.test(lastOut.body),
    mid_no_welcome_repeat: !midOut.some((m) => WELCOME_RE.test(m.body)),
    no_booking_created: bookings === 0,
    no_payment_created: payments === 0,
    no_confirmation_sends: confirmSends === 0,
  };
  out.result = Object.values(out.checks).every(Boolean) ? 'PASS' : 'FAIL';
  return out;
}

(async () => {
  try {
    if (cmd === 'deploy') {
      const rev = deploy();
      console.log(JSON.stringify({ phase: 'deploy', revision: rev, healthz: healthz(), env: envPick() }, null, 2));
    } else if (cmd === 'dryrun') {
      const r = await dryRunProof();
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.result === 'PASS' ? 0 : 1);
    } else if (cmd === 'live') {
      const r = await liveProof();
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.result === 'PASS' ? 0 : 1);
    } else {
      console.log(JSON.stringify({ revision: activeRevision(), healthz: healthz(), env: envPick() }, null, 2));
    }
  } catch (e) {
    console.error(e.stderr || e.stdout || e.message || e);
    process.exit(1);
  }
})();
