'use strict';
/** Stage 45j — enable live replies + 3-turn real-phone Meta inbound proof. Temp — do not commit. */

const crypto = require('crypto');
const https = require('https');
const path = require('path');
const { Client } = require('pg');
const { execSync, spawnSync } = require('child_process');

const COMMIT_SHORT = '6fbf703';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const DEMO_PHONE_ID = '1152900101233109';
const GUEST_PHONE = '+34600995567';
const GUEST_FROM = '34600995567';
const CAL_START = '2026-08-01';
const CAL_END = '2026-08-31';

const ENV_NAMES = [
  'OPEN_DEMO_WHATSAPP_ENABLED',
  'LUNA_OPEN_PHONE_TESTING',
  'LUNA_OPEN_PHONE_TESTING_BYPASS_STAFF_ROUTING',
  'OPEN_DEMO_BOOKING_WRITES_ENABLED',
  'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
  'WHATSAPP_DRY_RUN',
  'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
  'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
  'STRIPE_SECRET_KEY',
];

const VERIFIERS = [
  'verify:stage45i-payment-choice-declines-addons',
  'verify:stage45g-open-phone-metadata-persist',
  'verify:stage45b-luna-open-phone-testing',
  'verify:stage45d-luna-open-phone-staff-routing-bypass',
  'verify:stage42a-cami-behavior-realism',
  'verify:staff-bot-guest-automation-gate',
];

const TURN_MESSAGES = [
  'Hi, we are 2 people interested in the Malibu package',
  'August 18 to August 25',
  'Deposit is fine',
];

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function runVerifier(script) {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], {
    cwd: path.join(__dirname),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    shell: true,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+) passed, (\d+) failed/);
  return {
    script,
    exit: r.status,
    passed: m ? Number(m[1]) : null,
    failed: m ? Number(m[2]) : null,
    ok: r.status === 0 && (!m || Number(m[2]) === 0),
    tail: out.split('\n').filter((l) => /passed|failed|PASS|FAIL|Summary|Result:/i.test(l)).slice(-4).join(' | '),
  };
}

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
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: buf });
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
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

function envPick(names) {
  const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const env = app.properties.template.containers[0].env || [];
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    if (!e) out[n] = null;
    else if (e.secretRef) out[n] = { secretRef: e.secretRef };
    else out[n] = e.value;
  }
  return out;
}

function stripeKeyProof(envRow) {
  if (!envRow) return { present: false, mode: 'missing' };
  if (envRow.secretRef) {
    const val = az(`az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name ${envRow.secretRef} --query value -o tsv`);
    if (val.startsWith('sk_live_')) return { present: true, mode: 'LIVE_BLOCKED', prefix: val.slice(0, 12) };
    if (val.startsWith('sk_test_')) return { present: true, mode: 'test', prefix: val.slice(0, 12) };
    return { present: true, mode: 'unknown_prefix', prefix: val.slice(0, 12) };
  }
  const val = String(envRow);
  if (val.startsWith('sk_live_')) return { present: true, mode: 'LIVE_BLOCKED' };
  if (val.startsWith('sk_test_')) return { present: true, mode: 'test' };
  return { present: true, mode: 'inline_unknown' };
}

function buildMetaPayload(fromDigits, wamid, messageText, contactName) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: DEMO_PHONE_ID },
          contacts: [{ profile: { name: contactName || 'Stage45j Guest' } }],
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

function enableLiveReplies() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    '--set-env-vars',
    'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=true',
    'WHATSAPP_DRY_RUN=false',
    '-o none',
  ].join(' '));
}

async function staffLogin() {
  const login = await httpsJson('POST', '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  return (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
}

(async () => {
  const out = {
    phase: 'stage45j-live-replies-proof',
    commit: COMMIT_SHORT,
    preflight: {},
    env_before: {},
    env_after: {},
    env_changed: ['OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=true', 'WHATSAPP_DRY_RUN=false'],
    stripe: {},
    meta_inbound: { webhook_path: '/staff/meta/whatsapp/webhook', test_phone_type: 'unknown_external' },
    turns: [],
    transcript: [],
    live_sends: [],
    booking: {},
    beds: {},
    calendar: {},
    conversation: {},
    payment: {},
    safety: {},
    cleanup: {
      dry_run: `npm run cleanup:open-demo-booking -- --phone ${GUEST_PHONE} --dry-run`,
      confirm: `npm run cleanup:open-demo-booking -- --phone ${GUEST_PHONE} --confirm-cleanup`,
    },
    result: 'FAIL',
  };

  out.preflight.revision = activeRevision();
  const hz = await httpsJson('GET', '/healthz');
  out.preflight.healthz = hz.body;
  out.env_before = envPick(ENV_NAMES);
  out.stripe = stripeKeyProof(out.env_before.STRIPE_SECRET_KEY);

  console.error('[preflight] running verifiers...');
  out.preflight.verifiers = VERIFIERS.map(runVerifier);

  console.error('[enable] turning on live replies...');
  enableLiveReplies();
  execSync('powershell -Command "Start-Sleep -Seconds 12"', { stdio: 'ignore' });
  out.env_after = envPick(ENV_NAMES);

  const proofStart = new Date().toISOString();
  for (let i = 0; i < TURN_MESSAGES.length; i++) {
    const wamid = `wamid.45j-${Date.now()}-t${i + 1}-${crypto.randomBytes(6).toString('hex')}`;
    const payload = buildMetaPayload(GUEST_FROM, wamid, TURN_MESSAGES[i], 'Stage45j Friend Test');
    console.error(`[turn ${i + 1}] posting Meta webhook...`);
    const resp = await httpsJson('POST', '/staff/meta/whatsapp/webhook', payload);
    const body = resp.body || {};
    const draft = body.draft || {};
    const sendResult = body.send_result || {};
    const bw = body.booking_write_preview || body.booking_write || {};
    out.turns.push({
      turn: i + 1,
      message: TURN_MESSAGES[i],
      wamid,
      http_status: resp.status,
      sends_whatsapp: body.sends_whatsapp === true || sendResult.sends_whatsapp === true || sendResult.send_performed === true,
      whatsapp_sent: sendResult.send_performed === true || body.whatsapp_sent === true,
      live_send_blocked: body.live_send_blocked,
      blocked_reasons: sendResult.blocked_reasons || draft.send_eligibility?.blocked_reasons || [],
      suggested_reply: String(draft.suggested_reply || body.suggested_reply || '').slice(0, 400),
      quote_status: body.open_demo?.review?.quote?.quote_status || body.review?.quote?.quote_status,
      payment_choice_needed: body.open_demo?.review?.quote?.payment_choice_needed ?? body.review?.quote?.payment_choice_needed,
      payment_choice_ready: body.open_demo?.review?.payment_choice?.payment_choice_ready ?? body.review?.payment_choice?.payment_choice_ready,
      write_status: bw.write_status || body.write_status,
      booking_code: bw.booking_code || body.booking_code,
      booking_id: bw.booking_id || body.booking_id,
      stripe_link_created: bw.stripe_link_created || body.stripe_link_created,
    });
    await new Promise((r) => setTimeout(r, i === TURN_MESSAGES.length - 1 ? 20000 : 12000));
  }

  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  if (!/staging|wolfhouse_staging/i.test(whUrl)) throw new Error('DB guard: not staging URL');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const phoneRaw = GUEST_PHONE.replace(/^\+/, '');
  const msgs = (await pg.query(`
    SELECT m.direction::text, LEFT(m.message_text, 500) AS body, m.created_at::text,
           m.metadata->>'open_phone_testing' AS open_phone_testing,
           m.metadata->>'guest_tester_class' AS guest_tester_class
      FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = $4
       AND (c.phone = $1 OR c.phone = $2 OR c.phone = $3)
       AND m.created_at >= $5::timestamptz
     ORDER BY m.created_at ASC`,
    [GUEST_PHONE, phoneRaw, `+${phoneRaw}`, CLIENT, proofStart])).rows;

  out.transcript = msgs.map((m) => ({
    direction: m.direction,
    body: m.body,
    at: m.created_at,
    open_phone_testing: m.open_phone_testing,
    guest_tester_class: m.guest_tester_class,
  }));

  const conv = (await pg.query(`
    SELECT c.id::text, c.phone, c.booking_id::text,
           c.metadata->>'open_phone_testing' AS open_phone_testing,
           c.metadata->>'guest_tester_class' AS guest_tester_class
      FROM conversations c
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = $4 AND (c.phone = $1 OR c.phone = $2 OR c.phone = $3)
     ORDER BY c.updated_at DESC LIMIT 1`,
    [GUEST_PHONE, phoneRaw, `+${phoneRaw}`, CLIENT])).rows[0];

  const sends = (await pg.query(`
    SELECT idempotency_key, status, to_phone, send_kind, created_at::text, blocked_reasons
      FROM guest_message_sends
     WHERE created_at >= $1::timestamptz
       AND (to_phone = $2 OR to_phone = $3 OR to_phone = $4)
     ORDER BY created_at ASC`,
    [proofStart, GUEST_PHONE, phoneRaw, `+${phoneRaw}`])).rows;

  out.live_sends = sends;

  const t3 = out.turns[2] || {};
  const bookingId = t3.booking_id || conv?.booking_id;
  let bookingRow = null;
  let beds = [];
  let payment = null;
  if (bookingId) {
    bookingRow = (await pg.query(
      `SELECT booking_code, status::text, payment_status::text, check_in::text, check_out::text,
              confirmation_sent_at, metadata
         FROM bookings WHERE id=$1::uuid`, [bookingId])).rows[0];
    beds = (await pg.query(
      'SELECT bed_code, room_code FROM booking_beds WHERE booking_id=$1::uuid ORDER BY bed_code', [bookingId])).rows;
    payment = (await pg.query(
      `SELECT id::text, status::text, currency, amount_due_cents, stripe_checkout_session_id, checkout_url, metadata
         FROM payments WHERE booking_id=$1::uuid ORDER BY created_at DESC LIMIT 1`, [bookingId])).rows[0];
  }

  const confirmSends = (await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE created_at >= $1::timestamptz
        AND (to_phone = $2 OR to_phone = $3 OR to_phone = $4)
        AND send_kind ILIKE '%confirm%'`,
    [proofStart, GUEST_PHONE, phoneRaw, `+${phoneRaw}`])).rows[0].n;

  await pg.end();

  const cookie = await staffLogin();
  const cal = await httpsJson('GET',
    `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=${CAL_START}&end=${CAL_END}`, null, { Cookie: cookie });
  const calHolds = [];
  for (const room of cal.body?.rooms || []) {
    for (const bed of room.beds || []) {
      for (const h of bed.holds || []) {
        if (h.booking_code === bookingRow?.booking_code) calHolds.push({ bed: bed.bed_code, hold: h });
      }
    }
  }

  let inboxHit = null;
  if (conv?.id) {
    const inbox = await httpsJson('GET', `/staff/conversations?client=${CLIENT}&limit=80`, null, { Cookie: cookie });
    const convs = inbox.body?.conversations || inbox.body?.data || [];
    inboxHit = convs.find((c) => c.id === conv.id || c.conversation_id === conv.id) || null;
  }

  const turn2Reply = out.transcript.filter((m) => m.direction === 'outbound')[1]?.body
    || out.turns[1]?.suggested_reply || '';
  const turn3Reply = out.transcript.filter((m) => m.direction === 'outbound')[2]?.body
    || out.turns[2]?.suggested_reply || '';
  const sentRows = sends.filter((s) => s.status === 'sent');
  const inboundCount = msgs.filter((m) => m.direction === 'inbound').length;
  const outboundCount = msgs.filter((m) => m.direction === 'outbound').length;

  out.booking = {
    booking_id: bookingId,
    booking_code: bookingRow?.booking_code || t3.booking_code,
    status: bookingRow?.status,
    payment_status: bookingRow?.payment_status,
    check_in: bookingRow?.check_in,
    check_out: bookingRow?.check_out,
    confirmation_sent_at: bookingRow?.confirmation_sent_at,
    write_status: t3.write_status,
  };
  out.beds = {
    assigned: beds,
    real_r_pattern: beds.length > 0 && beds.every((b) => /^R\d+-B\d+$/i.test(b.bed_code)),
    no_demo: beds.every((b) => !/^DEMO-/i.test(b.bed_code)),
  };
  out.calendar = { status: cal.status, holds_for_booking: calHolds };
  out.conversation = {
    id: conv?.id,
    phone: conv?.phone,
    booking_id: conv?.booking_id,
    open_phone_testing: conv?.open_phone_testing,
    guest_tester_class: conv?.guest_tester_class,
    inbox_open_phone_testing: inboxHit?.open_phone_testing ?? null,
    inbox_guest_tester_class: inboxHit?.guest_tester_class ?? null,
    inbox_booking_id: inboxHit?.booking_id ?? inboxHit?.linked_booking_id ?? null,
  };
  out.payment = payment ? {
    status: payment.status,
    currency: payment.currency,
    amount_due_cents: payment.amount_due_cents,
    stripe_checkout_session_id: payment.stripe_checkout_session_id,
    is_test_checkout: String(payment.stripe_checkout_session_id || '').startsWith('cs_test_'),
    checkout_url_has_test: /checkout\.stripe\.com/i.test(String(payment.checkout_url || '')),
    turn3_has_payment_link: /payment link|secure payment link|pay online|checkout/i.test(turn3Reply),
    no_stripe_brand: !/stripe link/i.test(turn3Reply),
  } : null;

  out.quote_copy_turn2 = {
    has_total: /€698|698/.test(turn2Reply),
    asks_deposit_or_full: /deposit|full/i.test(turn2Reply),
    optional_addons_later: /lessons|rentals/i.test(turn2Reply) && /later|if you want/i.test(turn2Reply),
    no_just_the_stay: !/just the stay/i.test(turn2Reply),
    no_stripe_link: !/stripe link/i.test(turn2Reply),
    reply: turn2Reply,
  };

  out.safety = {
    production_db: false,
    stripe_mode: out.stripe.mode,
    no_sk_live: out.stripe.mode !== 'LIVE_BLOCKED',
    allowlist_unset: out.env_after.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST == null,
    live_sends_sent: sentRows.length,
    inbound_messages: inboundCount,
    outbound_messages: outboundCount,
    one_reply_per_inbound: inboundCount === 3 && outboundCount === 3 && sentRows.length === 3,
    no_duplicate_idempotency: new Set(sentRows.map((s) => s.idempotency_key)).size === sentRows.length,
    confirmation_sends: confirmSends,
    confirmation_sent_at_null: !bookingRow?.confirmation_sent_at,
  };

  const preflightOk = out.preflight.revision.image?.includes(COMMIT_SHORT)
    && out.preflight.revision.health === 'Healthy'
    && out.preflight.healthz?.ok === true
    && out.preflight.verifiers.every((v) => v.ok)
    && out.stripe.mode === 'test';

  const liveOk = out.env_after.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'true'
    && out.env_after.WHATSAPP_DRY_RUN === 'false'
    && out.env_after.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'true'
    && out.env_after.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'true';

  const flowOk = out.quote_copy_turn2.has_total
    && out.quote_copy_turn2.asks_deposit_or_full
    && out.quote_copy_turn2.optional_addons_later
    && out.quote_copy_turn2.no_stripe_link
    && (t3.write_status === 'created' || t3.write_status === 'reused_existing')
    && out.beds.real_r_pattern
    && out.payment?.is_test_checkout
    && out.payment?.amount_due_cents === 20000
    && out.safety.one_reply_per_inbound
    && out.safety.confirmation_sends === 0
    && out.safety.confirmation_sent_at_null
    && conv?.open_phone_testing === 'true'
    && conv?.guest_tester_class === 'external_open_testing';

  out.result = preflightOk && liveOk && flowOk ? 'PASS' : 'PARTIAL';
  out.live_replies_recommendation = flowOk
    ? 'Keep ON for friend testing; restore with playground:open-demo-off when done'
    : 'Fix gaps before wider friend testing';

  console.log(JSON.stringify(out, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
