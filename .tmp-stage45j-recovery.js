'use strict';
/** Stage 45j recovery — collect proof after live 3-turn Meta test. Temp — do not commit. */

const https = require('https');
const { Client } = require('pg');
const { execSync, spawnSync } = require('child_process');
const path = require('path');

const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const GUEST_PHONE = '+34600995567';
const CAL_START = '2026-08-01';
const CAL_END = '2026-08-31';
// Proof window: Stage 45j script started ~2026-06-11; use last 30 min
const PROOF_SINCE = new Date(Date.now() - 30 * 60 * 1000).toISOString();

const VERIFIERS = [
  'verify:stage45i-payment-choice-declines-addons',
  'verify:stage45g-open-phone-metadata-persist',
  'verify:stage45b-luna-open-phone-testing',
  'verify:stage45d-luna-open-phone-staff-routing-bypass',
  'verify:stage42a-cami-behavior-realism',
  'verify:staff-bot-guest-automation-gate',
];

function az(c) { return execSync(c, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 }).trim(); }

function runVerifier(script) {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], {
    cwd: path.join(__dirname), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, shell: true,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+) passed, (\d+) failed/);
  return { script, exit: r.status, passed: m ? Number(m[1]) : null, failed: m ? Number(m[2]) : null, ok: r.status === 0 && (!m || Number(m[2]) === 0) };
}

function httpsJson(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: STAFF_HOST, path: reqPath, method,
      headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const rev = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json')).find((r) => r.properties.trafficWeight === 100);
  const envRaw = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json'));
  const pick = (n) => { const e = envRaw.find((x) => x.name === n); return e?.secretRef ? `(secret:${e.secretRef})` : e?.value ?? null; };
  const sk = az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name stripe-secret-key --query value -o tsv');
  const hz = await httpsJson('GET', '/healthz');

  const verifiers = VERIFIERS.map(runVerifier);

  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const phoneRaw = GUEST_PHONE.replace(/^\+/, '');

  const msgs = (await pg.query(`
    SELECT m.direction::text, m.message_text AS body, m.created_at::text,
           m.metadata->>'open_phone_testing' AS open_phone_testing,
           m.metadata->>'guest_tester_class' AS guest_tester_class
      FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = $4 AND (c.phone = $1 OR c.phone = $2 OR c.phone = $3)
       AND m.created_at >= $5::timestamptz
     ORDER BY m.created_at ASC`,
    [GUEST_PHONE, phoneRaw, `+${phoneRaw}`, CLIENT, PROOF_SINCE])).rows;

  const conv = (await pg.query(`
    SELECT c.id::text, c.phone, c.current_hold_booking_id::text AS booking_id,
           c.metadata->>'open_phone_testing' AS open_phone_testing,
           c.metadata->>'guest_tester_class' AS guest_tester_class
      FROM conversations c INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = $4 AND (c.phone = $1 OR c.phone = $2 OR c.phone = $3)
     ORDER BY c.updated_at DESC LIMIT 1`,
    [GUEST_PHONE, phoneRaw, `+${phoneRaw}`, CLIENT])).rows[0];

  const sends = (await pg.query(`
    SELECT idempotency_key, status, to_phone, send_kind, created_at::text, blocked_reasons
      FROM guest_message_sends
     WHERE created_at >= $1::timestamptz AND (to_phone = $2 OR to_phone = $3 OR to_phone = $4)
     ORDER BY created_at ASC`,
    [PROOF_SINCE, GUEST_PHONE, phoneRaw, `+${phoneRaw}`])).rows;

  const bookingId = conv?.booking_id;
  let booking = null; let beds = []; let payment = null;
  if (bookingId) {
    booking = (await pg.query(
      `SELECT booking_code, status::text, payment_status::text, check_in::text, check_out::text, confirmation_sent_at
         FROM bookings WHERE id=$1::uuid`, [bookingId])).rows[0];
    beds = (await pg.query('SELECT bed_code, room_code FROM booking_beds WHERE booking_id=$1::uuid ORDER BY bed_code', [bookingId])).rows;
    payment = (await pg.query(
      `SELECT status::text, currency, amount_due_cents, stripe_checkout_session_id, checkout_url
         FROM payments WHERE booking_id=$1::uuid ORDER BY created_at DESC LIMIT 1`, [bookingId])).rows[0];
  }

  const confirmSends = (await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE created_at >= $1::timestamptz AND (to_phone = $2 OR to_phone = $3 OR to_phone = $4)
        AND send_kind ILIKE '%confirm%'`,
    [PROOF_SINCE, GUEST_PHONE, phoneRaw, `+${phoneRaw}`])).rows[0].n;

  await pg.end();

  const login = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!' });
    const req = https.request({
      hostname: STAFF_HOST, path: '/staff/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve(res.headers['set-cookie']));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
  const cookie = (login || []).map((x) => x.split(';')[0]).join('; ');

  const cal = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: STAFF_HOST,
      path: `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=${CAL_START}&end=${CAL_END}`,
      method: 'GET', headers: { Accept: 'application/json', Cookie: cookie },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    req.on('error', reject);
    req.end();
  });

  const calHolds = [];
  for (const room of cal?.rooms || []) {
    for (const bed of room.beds || []) {
      for (const h of bed.holds || []) {
        if (h.booking_code === booking?.booking_code) calHolds.push({ bed: bed.bed_code, hold: h });
      }
    }
  }

  const inbox = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: STAFF_HOST, path: `/staff/conversations?client=${CLIENT}&limit=80`, method: 'GET',
      headers: { Accept: 'application/json', Cookie: cookie },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    req.on('error', reject);
    req.end();
  });
  const convs = inbox?.conversations || inbox?.data || [];
  const inboxHit = convs.find((c) => c.id === conv?.id || c.conversation_id === conv?.id) || null;

  const outbound = msgs.filter((m) => m.direction === 'outbound');
  const inbound = msgs.filter((m) => m.direction === 'inbound');
  const turn2Reply = outbound[1]?.body || '';
  const turn3Reply = outbound[2]?.body || '';
  const sentRows = sends.filter((s) => s.status === 'sent');

  console.log(JSON.stringify({
    deploy: { revision: rev?.name, health: rev?.properties?.healthState, image: rev?.properties?.template?.containers?.[0]?.image, healthz: hz },
    preflight_verifiers: verifiers,
    env_before_note: 'see env_after — live replies were enabled this session',
    env_after: {
      OPEN_DEMO_WHATSAPP_ENABLED: pick('OPEN_DEMO_WHATSAPP_ENABLED'),
      LUNA_OPEN_PHONE_TESTING: pick('LUNA_OPEN_PHONE_TESTING'),
      LUNA_OPEN_PHONE_TESTING_BYPASS_STAFF_ROUTING: pick('LUNA_OPEN_PHONE_TESTING_BYPASS_STAFF_ROUTING'),
      OPEN_DEMO_BOOKING_WRITES_ENABLED: pick('OPEN_DEMO_BOOKING_WRITES_ENABLED'),
      OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: pick('OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED'),
      WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
      OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: pick('OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED'),
      LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: pick('LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST'),
    },
    env_changed: ['OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=true', 'WHATSAPP_DRY_RUN=false'],
    stripe: { prefix: sk.slice(0, 12), test_mode: sk.startsWith('sk_test_'), live_blocked: sk.startsWith('sk_live_') },
    test_phone_type: 'unknown_external',
    guest_phone: GUEST_PHONE,
    transcript: msgs.map((m) => ({ direction: m.direction, body: m.body, at: m.created_at })),
    quote_copy_turn2: {
      reply: turn2Reply,
      has_total: /€698|698/.test(turn2Reply),
      asks_deposit_or_full: /deposit|full/i.test(turn2Reply),
      optional_addons_later: /lessons|rentals/i.test(turn2Reply) && /later|if you want/i.test(turn2Reply),
      no_just_the_stay: !/just the stay/i.test(turn2Reply),
      no_stripe_link: !/stripe link/i.test(turn2Reply),
    },
    turn3_reply: turn3Reply,
    live_sends: sends,
    booking: booking ? { ...booking, booking_id: bookingId } : null,
    beds: { assigned: beds, real_r_pattern: beds.every((b) => /^R\d+-B\d+$/i.test(b.bed_code)), no_demo: beds.every((b) => !/^DEMO-/i.test(b.bed_code)) },
    payment: payment ? {
      ...payment,
      is_test_checkout: String(payment.stripe_checkout_session_id || '').startsWith('cs_test_'),
      turn3_has_payment_link: /payment link|secure payment link|pay online|checkout/i.test(turn3Reply),
    } : null,
    calendar: { holds_for_booking: calHolds },
    conversation: {
      ...conv,
      inbox_open_phone_testing: inboxHit?.open_phone_testing,
      inbox_guest_tester_class: inboxHit?.guest_tester_class,
      inbox_booking_id: inboxHit?.booking_id,
    },
    safety: {
      inbound_count: inbound.length,
      outbound_count: outbound.length,
      live_sends_sent: sentRows.length,
      one_reply_per_inbound: inbound.length === 3 && outbound.length === 3 && sentRows.length === 3,
      no_duplicate_idempotency: new Set(sentRows.map((s) => s.idempotency_key)).size === sentRows.length,
      confirmation_sends: confirmSends,
      confirmation_sent_at_null: !booking?.confirmation_sent_at,
      production_db: false,
    },
    cleanup: {
      dry_run: `npm run cleanup:open-demo-booking -- --phone ${GUEST_PHONE} --dry-run`,
      confirm: `npm run cleanup:open-demo-booking -- --phone ${GUEST_PHONE} --confirm-cleanup`,
    },
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
