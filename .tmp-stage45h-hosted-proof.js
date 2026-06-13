'use strict';
/** Stage 45h — enable booking writes + Stripe test links on staging. Temp — do not commit. */

const crypto = require('crypto');
const https = require('https');
const path = require('path');
const { Client } = require('pg');
const { execSync, spawnSync } = require('child_process');

const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT_SHORT = '1911d36';
const DEMO_PHONE_ID = '1152900101233109';
const GUEST_PHONE = '+34600995558';
const CAL_START = '2026-08-01';
const CAL_END = '2026-08-31';

const ENABLE_ENV = {
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'true',
};

const ENV_NAMES = [
  'OPEN_DEMO_WHATSAPP_ENABLED',
  'LUNA_OPEN_PHONE_TESTING',
  'LUNA_OPEN_PHONE_TESTING_BYPASS_STAFF_ROUTING',
  'OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_DRY_RUN',
  'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
  'OPEN_DEMO_BOOKING_WRITES_ENABLED',
  'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
  'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
  'STRIPE_LINKS_ENABLED',
  'STAFF_ACTIONS_ENABLED',
  'STRIPE_SECRET_KEY',
];

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function runNpm(script) {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], {
    cwd: path.join(__dirname),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    shell: true,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const pass = /0 failed/i.test(out) || /PASS/i.test(out.split('\n').slice(-5).join('\n'));
  const summary = out.split('\n').filter((l) => /passed|failed|PASS|FAIL|Result:/i.test(l)).slice(-3).join(' | ');
  return { script, exit: r.status, pass, summary, tail: out.split('\n').slice(-4).join('\n') };
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

function setEnvVars(pairs) {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--set-env-vars ${Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join(' ')}`,
    '-o none',
  ].join(' '));
}

function stripeKeyProof(envRow) {
  if (!envRow) return { present: false, mode: 'missing' };
  if (envRow.secretRef) {
    let prefix = null;
    try {
      const val = az(`az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name ${envRow.secretRef} --query value -o tsv`);
      prefix = val.slice(0, 8);
      if (val.startsWith('sk_live_')) return { present: true, mode: 'LIVE_BLOCKED', prefix, secretRef: envRow.secretRef };
      if (val.startsWith('sk_test_')) return { present: true, mode: 'test', prefix, secretRef: envRow.secretRef };
      return { present: true, mode: 'unknown_prefix', prefix, secretRef: envRow.secretRef };
    } catch (err) {
      return { present: true, mode: 'secret_ref_unreadable', secretRef: envRow.secretRef, error: err.message };
    }
  }
  const val = String(envRow);
  if (val.startsWith('sk_live_')) return { present: true, mode: 'LIVE_BLOCKED', prefix: val.slice(0, 8) };
  if (val.startsWith('sk_test_')) return { present: true, mode: 'test', prefix: val.slice(0, 8) };
  return { present: true, mode: 'inline_unknown', prefix: val.slice(0, 8) };
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

async function staffLogin() {
  const login = await httpsJson('POST', '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  return (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
}

function botToken() {
  try {
    return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
  } catch {
    return process.env.LUNA_BOT_INTERNAL_TOKEN || '';
  }
}

function runBookingHarness(token) {
  const res = spawnSync(process.execPath, [
    path.join(__dirname, 'scripts/run-open-demo-whatsapp-inbound-dry-run.js'),
    '--base-url', `https://${STAFF_HOST}`,
    '--phone-number-id', DEMO_PHONE_ID,
    '--guest-phone', GUEST_PHONE,
    '--guest-email', `open-demo+34600995558@example.test`,
    '--fixture', 'booking-deposit-write-clean',
    '--create-demo-hold-draft-confirmed',
    '--assign-demo-bed-confirmed',
    '--create-stripe-test-link-confirmed',
    '--json',
  ], {
    cwd: __dirname,
    env: { ...process.env, LUNA_BOT_INTERNAL_TOKEN: token },
    encoding: 'utf8',
    maxBuffer: 40 * 1024 * 1024,
  });
  const turns = [];
  for (const chunk of (res.stdout || '').split(/\n(?=\{)/)) {
    const t = chunk.trim();
    if (!t.startsWith('{')) continue;
    try { turns.push(JSON.parse(t)); } catch { /* skip */ }
  }
  return { exit: res.status, stderr: res.stderr, turns };
}

(async () => {
  const out = {
    phase: 'stage45h-booking-stripe-enable',
    preflight: { verifiers: [], revision: null, inventory: {}, stripe: {}, env_before: null },
    env_changed: {},
    live_replies: {},
    harness: {},
    booking: {},
    bed: {},
    calendar: {},
    conversation: {},
    payment: {},
    stripe_link: {},
    copy: {},
    safety: {},
    cleanup: {
      command: `npm run cleanup:open-demo-booking -- --phone ${GUEST_PHONE} --dry-run`,
      confirm: `npm run cleanup:open-demo-booking -- --phone ${GUEST_PHONE} --confirm-cleanup`,
    },
    result: 'FAIL',
  };

  const verifierScripts = [
    'verify:stage45g-open-phone-metadata-persist',
    'verify:stage45b-luna-open-phone-testing',
    'verify:stage45d-luna-open-phone-staff-routing-bypass',
    'verify:stage45a-wolfhouse-inventory',
    'verify:stage43a-staff-manual-booking-create',
    'verify:stage43c-staff-manual-booking-ui-payload',
    'verify:staff-bed-calendar-ui',
    'verify:stage27demo-d-open-demo-booking-write',
    'verify:stage27demo-e-stripe-test-link-whatsapp',
  ];
  for (const s of verifierScripts) out.preflight.verifiers.push(runNpm(s));

  out.preflight.revision = activeRevision();
  out.preflight.env_before = envPick(ENV_NAMES);
  out.preflight.stripe = stripeKeyProof(out.preflight.env_before.STRIPE_SECRET_KEY);

  const cookie = await staffLogin();
  const calBefore = await httpsJson('GET', `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=${CAL_START}&end=${CAL_END}`, null, { Cookie: cookie });
  const rooms = calBefore.body?.rooms || [];
  const bedCodes = [];
  for (const room of rooms) {
    for (const bed of room.beds || []) bedCodes.push(bed.bed_code);
  }
  out.preflight.inventory = {
    calendar_status: calBefore.status,
    room_count: rooms.length,
    bed_count: bedCodes.length,
    room_codes: rooms.map((r) => r.room_code).sort(),
    has_demo_rooms: rooms.some((r) => /^DEMO-/i.test(r.room_code)),
    real_r_pattern_beds: bedCodes.filter((c) => /^R\d+-B\d+$/i.test(c)).length,
    inventory_source: calBefore.body?.inventory_source || null,
  };

  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  if (!/staging|wolfhouse_staging/i.test(whUrl)) {
    out.preflight.db_guard = { ok: false, reason: 'not_staging_db' };
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }
  out.preflight.db_guard = { ok: true, host_hint: whUrl.replace(/:[^:@/]+@/, ':***@').slice(0, 80) };

  console.error('[env] enabling booking writes + Stripe test links...');
  setEnvVars(ENABLE_ENV);
  execSync('powershell -Command "Start-Sleep -Seconds 18"', { stdio: 'ignore' });
  out.env_changed = envPick(ENV_NAMES);

  out.live_replies = {
    whatsapp_dry_run: out.env_changed.WHATSAPP_DRY_RUN === 'true',
    live_replies_enabled: out.env_changed.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'true',
    mode: out.env_changed.WHATSAPP_DRY_RUN === 'true' ? 'dry_run_harness_only' : 'live_whatsapp_possible',
    note: 'Live replies NOT changed — booking+Stripe via harness/API only unless Ty enables live replies separately.',
  };

  const proofStart = new Date().toISOString();
  const bookingsBefore = await (async () => {
    const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
    await pg.connect();
    const n = await pg.query(
      `SELECT COUNT(*)::int AS n FROM bookings b JOIN clients c ON c.id=b.client_id WHERE c.slug=$1 AND b.created_at >= $2::timestamptz`,
      [CLIENT, proofStart],
    );
    await pg.end();
    return n.rows[0].n;
  })();

  const token = botToken();
  console.error('[harness] 3-turn booking + bed assign + stripe test link...');
  const harness = runBookingHarness(token);
  out.harness = { exit: harness.exit, turn_count: harness.turns.length, stderr: harness.stderr?.slice(0, 400) || null };
  const final = harness.turns[harness.turns.length - 1] || {};

  out.booking = {
    guest_phone: GUEST_PHONE,
    fixture: 'booking-deposit-write-clean (Aug 18–25, Malibu, 2 guests, deposit)',
    write_status: final.write_status || null,
    booking_code: final.booking_code || null,
    booking_id: final.booking_id || null,
    payment_draft_id: final.payment_draft_id || null,
    assignment_write_status: final.assignment_write_status || null,
    assigned_bed_label: final.assigned_bed_label || null,
    assigned_room_label: final.assigned_room_label || null,
    calendar_visible_expected: final.calendar_visible_expected === true,
    open_phone_testing: final.open_phone_testing,
    guest_tester_class: final.guest_tester_class,
  };

  out.bed = {
    assigned_bed_label: final.assigned_bed_label || null,
    assigned_room_label: final.assigned_room_label || null,
    is_real_r_bed: /^R\d+-B\d+$/i.test(String(final.assigned_bed_label || '')),
    is_demo_bed: /^DEMO-/i.test(String(final.assigned_bed_label || '')),
    assignment_write_status: final.assignment_write_status || null,
  };

  out.stripe_link = {
    stripe_link_created: final.stripe_link_created === true,
    stripe_link_reused: final.stripe_link_reused === true,
    stripe_checkout_url: final.stripe_checkout_url || null,
    checkout_is_test_host: /checkout\.stripe\.com|cs_test_/.test(String(final.stripe_checkout_url || '')),
    payment_link_sent: final.payment_link_sent === true,
    sends_whatsapp: final.sends_whatsapp === true,
    live_send_blocked: final.live_send_blocked === true,
  };

  const reply = String(final.review?.proposed_luna_reply || final.proposed_luna_reply || '');
  out.copy = {
    proposed_luna_reply_excerpt: reply.slice(0, 280),
    says_stripe_link: /stripe link/i.test(reply),
    says_payment_link: /payment link|secure payment/i.test(reply),
    says_secure_payment_link: /secure payment link/i.test(reply),
  };

  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  if (final.booking_id) {
    const b = await pg.query(
      `SELECT b.booking_code, b.status::text, b.payment_status::text, b.check_in::text, b.check_out::text,
              b.phone, b.confirmation_sent_at
         FROM bookings b WHERE b.id=$1::uuid`, [final.booking_id]);
    out.booking.db_row = b.rows[0] || null;

    const beds = await pg.query(
      `SELECT bb.bed_code, bb.room_code FROM booking_beds bb WHERE bb.booking_id=$1::uuid ORDER BY bb.bed_code`,
      [final.booking_id]);
    out.bed.db_assignments = beds.rows;

    if (final.payment_draft_id) {
      const p = await pg.query(
        `SELECT id::text, status::text, payment_kind::text, currency, amount_due_cents,
                stripe_checkout_session_id, checkout_url
           FROM payments WHERE id=$1::uuid`, [final.payment_draft_id]);
      out.payment = p.rows[0] || null;
      if (out.payment) {
        out.stripe_link.session_id_prefix = String(out.payment.stripe_checkout_session_id || '').slice(0, 8);
        out.stripe_link.session_is_cs_test = String(out.payment.stripe_checkout_session_id || '').startsWith('cs_test_');
        out.stripe_link.currency_eur = out.payment.currency === 'EUR';
      }
    }
  }

  const bookingsAfter = await pg.query(
    `SELECT COUNT(*)::int AS n FROM bookings b JOIN clients c ON c.id=b.client_id
      WHERE c.slug=$1 AND b.created_at >= $2::timestamptz`, [CLIENT, proofStart]);
  out.safety.bookings_created_since_proof = bookingsAfter.rows[0].n - bookingsBefore;
  out.safety.payment_pending = out.payment?.status === 'pending' || out.payment?.status === 'draft';
  out.safety.no_confirmation_sent = !out.booking.db_row?.confirmation_sent_at;

  const sends = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE created_at >= $1::timestamptz
       AND (to_phone=$2 OR to_phone=$3)`, [proofStart, GUEST_PHONE, GUEST_PHONE.replace(/^\+/, '')]);
  out.safety.guest_message_sends = sends.rows[0].n;

  const confirmSends = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE created_at >= $1::timestamptz
       AND send_kind ILIKE '%confirm%'`, [proofStart]).catch(() => ({ rows: [{ n: 0 }] }));
  out.safety.confirmation_send_rows = confirmSends.rows[0].n;

  if (final.conversation_id) {
    const conv = await pg.query(
      `SELECT c.metadata->>'open_phone_testing' AS open_phone_testing,
              c.metadata->>'guest_tester_class' AS guest_tester_class
         FROM conversations c WHERE c.id=$1::uuid`, [final.conversation_id]);
    out.conversation.metadata = conv.rows[0] || null;

    const inbox = await httpsJson('GET', `/staff/conversations?client=${CLIENT}&limit=50`, null, { Cookie: cookie });
    const convs = inbox.body?.conversations || [];
    const hit = convs.find((c) => c.id === final.conversation_id);
    out.conversation.inbox = {
      found: !!hit,
      open_phone_testing: hit?.open_phone_testing ?? null,
      guest_tester_class: hit?.guest_tester_class ?? null,
      booking_code: hit?.booking_code || hit?.active_booking_code || null,
    };
  }

  await pg.end();

  if (final.booking_id || final.booking_code) {
    const cal = await httpsJson(
      'GET',
      `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=${CAL_START}&end=${CAL_END}`,
      null,
      { Cookie: cookie },
    );
    const blocks = cal.body?.blocks || [];
    const match = blocks.find((b) =>
      (final.booking_id && b.booking_id === final.booking_id)
      || (final.booking_code && b.booking_code === final.booking_code));
    out.calendar = {
      status: cal.status,
      matched: !!match,
      bed_code: match?.bed_code || null,
      room_code: match?.room_code || null,
      booking_code: match?.booking_code || null,
      has_demo_block: blocks.some((b) =>
        (b.booking_id === final.booking_id || b.booking_code === final.booking_code)
        && /^DEMO-/i.test(String(b.bed_code || b.room_code || ''))),
    };
  }

  const preOk = out.preflight.verifiers.every((v) => v.pass);
  const revOk = out.preflight.revision.image?.includes(COMMIT_SHORT) && out.preflight.revision.health === 'Healthy';
  const invOk = out.preflight.inventory.room_count === 10 && out.preflight.inventory.bed_count === 52
    && !out.preflight.inventory.has_demo_rooms;
  const stripeOk = out.preflight.stripe.mode === 'test';
  const envOk = out.env_changed.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'true'
    && out.env_changed.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'true'
    && out.env_changed.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST == null;
  const writeOk = ['created', 'reused_existing'].includes(final.write_status);
  const bedOk = out.bed.is_real_r_bed && !out.bed.is_demo_bed;
  const stripeLinkOk = out.stripe_link.stripe_link_created && out.stripe_link.session_is_cs_test !== false;
  const copyOk = !out.copy.says_stripe_link && (out.copy.says_payment_link || out.copy.says_secure_payment_link);
  const safetyOk = out.safety.guest_message_sends === 0 && out.safety.confirmation_send_rows === 0
    && out.safety.no_confirmation_sent !== false;

  out.result = (preOk && revOk && invOk && stripeOk && envOk && writeOk && bedOk && stripeLinkOk && copyOk && safetyOk)
    ? 'PASS' : 'PARTIAL';

  out.next_go_no_go = {
    continue_dry_run_friend_testing: envOk && writeOk ? 'GO' : 'NO-GO',
    enable_live_replies: 'NO-GO until Ty explicitly confirms OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=true and WHATSAPP_DRY_RUN=false',
    keep_harness_api_only: out.live_replies.mode === 'dry_run_harness_only' ? 'GO (current)' : 'review',
  };

  console.log(JSON.stringify(out, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
