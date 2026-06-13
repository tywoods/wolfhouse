'use strict';
/** Stage 50b.1 — deploy GPT Cami Reply Author to staging + hosted dry-run + live proof. Temp — do not commit. */

const crypto = require('crypto');
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const COMMIT = '8d2b685';
const IMAGE_TAG = `${COMMIT}-stage50b-cami-author`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's50b-cami-author';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const DEMO_PHONE_ID = '1152900101233109';
const REVIEW_ROUTE = '/staff/bot/guest-inbound-review-dry-run';

const LIVE_PHONE = '+34600995581';
const LIVE_FROM = '34600995581';

const ENV_EXPECT = {
  LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED: 'true',
  LUNA_GUEST_AGENT_BRAIN_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'false',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'true',
  LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: null,
  LUNA_GUEST_AGENT_BRAIN_ENABLED_PROD: null,
  LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED_PROD: null,
};

const TRANSCRIPT = [
  'Hello!',
  'lets book a stay',
  'June 11th to 20th',
  '3',
  'Tell me about the packages',
  'ok Malibu',
  'Deposit is fine',
];

const HANDOFF_RE = /looping in our Wolfhouse team|passing this to our team|hand off|handoff|staff will follow up|follow up soon/i;
const INTERNAL_RE = /\b(?:\bAI\b|\bmodel\b|\bprompt\b|\btool\b|\bbackend\b|\bdatabase\b|\brouter\b|\bcomposer\b|\borchestrator\b|\bdry[\s-]?run\b|\bstripe\s+link\b)\b/i;
const WELCOME_MENU_RE = /i can help you book a stay|checking some info/i;

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
        const setCookie = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: parsed, raw: buf, headers: res.headers, setCookie });
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
  const openai = env.find((x) => x.name === 'OPENAI_API_KEY');
  out.OPENAI_API_KEY = openai
    ? (openai.secretRef ? { secretRef: openai.secretRef } : '(inline)')
    : null;
  return out;
}

function envMatches(actual) {
  const checks = {};
  for (const [k, expected] of Object.entries(ENV_EXPECT)) {
    const v = actual[k];
    if (expected === null) checks[k] = v == null || v === '' || v === 'false';
    else checks[k] = v === expected;
  }
  checks.OPENAI_API_KEY_server_side = !!(actual.OPENAI_API_KEY && actual.OPENAI_API_KEY.secretRef);
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
  console.error('[deploy] containerapp update + LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED=true...');
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REV_SUFFIX}`,
    '--set-env-vars LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED=true',
    '-o none',
  ].join(' '));
  for (let i = 0; i < 60; i++) {
    const rev = activeRevision();
    const hz = healthz();
    const env = envPick();
    console.error(`[deploy] wait ${i + 1}/60 rev=${rev.name} cami=${env.LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED} hz=${hz}`);
    if (String(rev.image || '').includes(COMMIT) && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200'
      && env.LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED === 'true') return rev;
    sleep(10000);
  }
  throw new Error('deploy did not become healthy in time');
}

function buildReviewPayload(phone, message, guestContext, turnIndex, tag) {
  return {
    source: 'stage50b1_hosted_proof',
    client_slug: CLIENT,
    channel: 'whatsapp',
    guest_phone: phone,
    contact_name: 'Stage50b1 Guest',
    message_text: message,
    reference_date: '2026-06-11',
    received_at: new Date().toISOString(),
    inbound_message_id: `stage50b1-${tag}-${crypto.randomBytes(6).toString('hex')}-t${turnIndex + 1}`,
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
  const cami = r.cami_reply_author || {};
  const agent = r.guest_agent_brain || {};
  const fields = r.extracted_fields || {};
  const quote = review.quote || body.quote || {};
  const plan = review.hold_payment_draft_plan || body.hold_payment_draft_plan || {};
  const reply = String(review.proposed_luna_reply || body.proposed_luna_reply || '');
  return {
    http_status: res.status,
    message,
    reply,
    reply_preview: reply.slice(0, 1000),
    handoff: HANDOFF_RE.test(reply) || r.safe_handoff_required === true,
    fields,
    quote_status: quote.quote_status,
    plan_status: plan.plan_status,
    write_ready: plan.ready_for_hold_draft === true,
    cami,
    agent,
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
    if (i < messages.length - 1) await new Promise((r) => setTimeout(r, 3000));
  }
  return turns;
}

async function dryRunProof() {
  const token = resolveBotToken();
  const phone = `+34603${String(Date.now()).slice(-6)}`;
  const turns = await hostedTranscript(token, phone, TRANSCRIPT, 'main');
  const t4 = turns[4];
  const t5 = turns[5];
  const t6 = turns[6];
  const pkgTurn = turns[3];
  const mid = turns.slice(1, 4);

  const checks = {
    no_handoff_any_turn: turns.every((t) => !t.handoff),
    no_internal_words: turns.every((t) => !INTERNAL_RE.test(t.reply)),
    dates_turn4: turns[3].fields.check_in === '2026-06-11' && turns[3].fields.check_out === '2026-06-20',
    count_preserved_turn6: t6.fields.guest_count === 3,
    package_spacing_turn4: /\n/.test(pkgTurn.reply) && /malibu/i.test(pkgTurn.reply) && /uluwatu/i.test(pkgTurn.reply) && /waimea/i.test(pkgTurn.reply),
    package_not_dense: pkgTurn.reply.length < 1200,
    quote_ready_turn6: t6.quote_status === 'ready',
    payment_choice_turn6: /\b(?:deposit|full)\b/i.test(t6.reply),
    hold_ready_turn7: t6.plan_status === 'ready' || t6.write_ready === true,
    cami_used_some_turn: turns.some((t) => t.cami.cami_author_used === true),
    agent_brain_present: turns.some((t) => t.agent.agent_brain_enabled === true),
    mid_no_welcome_reset: !mid.some((t) => WELCOME_MENU_RE.test(t.reply)),
    no_stripe_link_phrase: !turns.some((t) => /stripe\s+link/i.test(t.reply)),
  };

  return {
    phase: 'stage50b1-dryrun',
    revision: activeRevision(),
    healthz: healthz(),
    env: envPick(),
    env_checks: envMatches(envPick()),
    phone,
    transcript: turns.map((t) => ({
      message: t.message,
      reply_preview: t.reply_preview,
      cami: t.cami,
      agent_brain_enabled: t.agent.agent_brain_enabled,
      fields: t.fields,
      quote_status: t.quote_status,
      plan_status: t.plan_status,
    })),
    checks,
    result: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
  };
}

function buildMetaPayload(fromDigits, wamid, messageText) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: DEMO_PHONE_ID },
          contacts: [{ profile: { name: 'Stage50b Live Guest' } }],
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

async function staffLogin() {
  const login = await httpsJson('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.setCookie || []).map((c) => c.split(';')[0]).join('; ');
  return { status: login.status, cookie };
}

async function queryDb(proofStart) {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  if (!/staging|wolfhouse_staging/i.test(whUrl)) throw new Error('DB guard: not staging URL');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const phoneRaw = LIVE_PHONE.replace(/^\+/, '');

  const msgs = (await pg.query(`
    SELECT m.direction::text, m.message_text AS body, m.created_at::text,
           m.metadata->'cami_reply_author' AS cami_meta,
           m.metadata->'guest_agent_brain' AS agent_meta
      FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = $3 AND (c.phone = $1 OR c.phone = $2)
       AND m.created_at >= $4::timestamptz
     ORDER BY m.created_at ASC`,
    [LIVE_PHONE, phoneRaw, CLIENT, proofStart])).rows;

  const sends = (await pg.query(`
    SELECT idempotency_key, status, to_phone, send_kind, LEFT(message_text, 900) AS message_text, created_at::text
      FROM guest_message_sends
     WHERE created_at >= $1::timestamptz AND (to_phone = $2 OR to_phone = $3)
     ORDER BY created_at ASC`,
    [proofStart, LIVE_PHONE, phoneRaw])).rows;

  const bookings = (await pg.query(`
    SELECT b.id::text, b.booking_code, b.status::text, b.check_in::text, b.check_out::text,
           b.guest_count, b.total_amount_cents, b.deposit_required_cents, b.amount_paid_cents,
           b.created_at::text
      FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.created_at >= $2::timestamptz
     ORDER BY b.created_at DESC LIMIT 3`,
    [CLIENT, proofStart])).rows;

  const payments = (await pg.query(`
    SELECT p.id::text, p.status::text, p.stripe_checkout_session_id, p.amount_paid_cents, p.created_at::text,
           b.booking_code
      FROM payments p
     INNER JOIN bookings b ON b.id = p.booking_id
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND p.created_at >= $2::timestamptz
     ORDER BY p.created_at DESC LIMIT 3`,
    [CLIENT, proofStart])).rows;

  const beds = bookings.length
    ? (await pg.query(`
        SELECT bb.bed_code, bb.room_code
          FROM booking_beds bb
         WHERE bb.booking_id = $1::uuid`,
      [bookings[0].id])).rows
    : [];

  const confirmSends = (await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE created_at >= $1::timestamptz AND (to_phone = $2 OR to_phone = $3) AND send_kind ILIKE '%confirm%'`,
    [proofStart, LIVE_PHONE, phoneRaw])).rows[0].n;

  const convMeta = (await pg.query(`
    SELECT c.metadata->'luna_guest_context'->'result'->'cami_reply_author' AS cami_ctx
      FROM conversations c
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = $1 AND (c.phone = $2 OR c.phone = $3)
     ORDER BY c.updated_at DESC LIMIT 1`,
    [CLIENT, LIVE_PHONE, phoneRaw])).rows[0];

  await pg.end();
  return { msgs, sends, bookings, payments, beds, confirmSends, convMeta };
}

async function liveProof() {
  const proofStart = new Date().toISOString();
  const out = { phase: 'stage50b1-live', phone: LIVE_PHONE, proof_start: proofStart, turns: [], webhook_obs: [] };

  for (let i = 0; i < TRANSCRIPT.length; i++) {
    const wamid = `wamid.50b1-${Date.now()}-t${i + 1}-${crypto.randomBytes(6).toString('hex')}`;
    console.error(`[live turn ${i + 1}] ${TRANSCRIPT[i]}`);
    const resp = await httpsJson('POST', '/staff/meta/whatsapp/webhook', buildMetaPayload(LIVE_FROM, wamid, TRANSCRIPT[i]));
    const body = resp.body || {};
    const review = body.review || {};
    const r = review.result || body.result || {};
    out.turns.push({
      turn: i + 1,
      message: TRANSCRIPT[i],
      http_status: resp.status,
      send_performed: (body.send_result || {}).send_performed === true || body.whatsapp_sent === true,
    });
    out.webhook_obs.push({
      turn: i + 1,
      cami_reply_author: r.cami_reply_author || null,
      guest_agent_brain: r.guest_agent_brain ? {
        agent_brain_enabled: r.guest_agent_brain.agent_brain_enabled,
        agent_intent: r.guest_agent_brain.agent_intent,
        agent_fallback_used: r.guest_agent_brain.agent_fallback_used,
      } : null,
      proposed_reply_preview: String(review.proposed_luna_reply || body.proposed_luna_reply || '').slice(0, 500),
    });
    await new Promise((r) => setTimeout(r, i === TRANSCRIPT.length - 1 ? 22000 : 15000));
  }

  const db = await queryDb(proofStart);
  out.transcript = db.msgs;
  out.live_sends = db.sends;
  out.bookings = db.bookings;
  out.payments = db.payments;
  out.beds = db.beds;
  out.conv_cami_ctx = db.convMeta;

  const staff = await staffLogin();
  let staffBooking = null;
  if (staff.status === 200 && staff.cookie && db.bookings[0]) {
    const code = db.bookings[0].booking_code;
    const detail = await httpsJson('GET', `/staff/bookings/${encodeURIComponent(code)}?client=${CLIENT}`, null, { Cookie: staff.cookie });
    staffBooking = { http_status: detail.status, booking_code: code, body_preview: JSON.stringify(detail.body || {}).slice(0, 1200) };
  }
  out.staff_portal = staffBooking;

  const outbound = db.msgs.filter((m) => m.direction === 'outbound' || m.direction === 'outgoing');
  const inbound = db.msgs.filter((m) => m.direction === 'inbound' || m.direction === 'incoming');
  const pkgReply = outbound.find((m) => /malibu/i.test(m.body) && /uluwatu/i.test(m.body)) || { body: '' };
  const quoteReply = outbound.find((m, i, arr) => /€1080|deposit/i.test(m.body) && /malibu/i.test(m.body))
    || outbound[5] || { body: '' };
  const payReply = outbound[outbound.length - 1] || { body: '' };
  const midOut = outbound.slice(1, 4);

  const camiFromWebhook = out.webhook_obs.filter((w) => w.cami_reply_author && w.cami_reply_author.cami_author_used);
  const camiFromMeta = outbound.filter((m) => m.cami_meta && m.cami_meta.cami_author_used);

  out.checks = {
    seven_inbound: inbound.length === 7,
    seven_outbound: outbound.length === 7,
    package_line_breaks_db: /\n/.test(pkgReply.body),
    package_line_breaks_send: db.sends.some((s) => /\n/.test(String(s.message_text || '')) && /malibu/i.test(String(s.message_text || ''))),
    quote_has_payment_choice: /deposit|full/i.test(quoteReply.body),
    quote_no_internal: !INTERNAL_RE.test(quoteReply.body),
    pay_reply_has_link: /lunafrontdesk\.com\/pay\//i.test(payReply.body) || db.payments.length >= 1,
    stripe_test_only: db.payments.every((p) => !p.stripe_checkout_session_id || /cs_test/i.test(p.stripe_checkout_session_id)),
    booking_created: db.bookings.length >= 1,
    no_confirmation_sends: db.confirmSends === 0,
    mid_no_welcome_repeat: !midOut.some((m) => WELCOME_MENU_RE.test(m.body)),
    no_handoff: !outbound.some((m) => HANDOFF_RE.test(m.body)),
    cami_observed: camiFromWebhook.length >= 1 || camiFromMeta.length >= 1 || !!(db.convMeta && db.convMeta.cami_ctx),
    agent_brain_observed: out.webhook_obs.some((w) => w.guest_agent_brain && w.guest_agent_brain.agent_brain_enabled),
    staff_portal_booking: staffBooking && staffBooking.http_status === 200,
  };

  out.before_after = {
    deterministic_style_example: 'Perfect — June 11 to June 20. How many guests will be staying?',
    live_package_preview: pkgReply.body ? pkgReply.body.slice(0, 400) : null,
    live_quote_preview: quoteReply.body ? quoteReply.body.slice(0, 400) : null,
    live_pay_preview: payReply.body ? payReply.body.slice(0, 400) : null,
  };

  out.result = Object.values(out.checks).every(Boolean) ? 'PASS' : 'FAIL';
  return out;
}

(async () => {
  try {
    if (cmd === 'deploy') {
      const rev = deploy();
      const env = envPick();
      console.log(JSON.stringify({
        phase: 'deploy', commit: COMMIT, image: IMAGE, revision: rev, healthz: healthz(), env, env_checks: envMatches(env),
      }, null, 2));
    } else if (cmd === 'dryrun') {
      const r = await dryRunProof();
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.result === 'PASS' ? 0 : 1);
    } else if (cmd === 'live') {
      const r = await liveProof();
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
