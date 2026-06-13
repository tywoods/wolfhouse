'use strict';
/** Stage 27demo-d.1 — deploy + calendar assignment hosted proof. Temp, do not commit. */
const https = require('https');
const { execSync, spawnSync } = require('child_process');
const { Client } = require('pg');
const path = require('path');

const COMMIT = 'e5ebc86';
const IMAGE_TAG = `${COMMIT}-stage27demo-d1-calendar-assign`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's27d1-cal-assign';
const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const GUEST_PHONE = '+34600995555';
const GUEST_EMAIL = 'open-demo+34600995555@example.test';
const DEMO_PHONE_ID = '1152900101233109';
const CAL_START = '2026-07-01';
const CAL_END = '2026-07-31';

const PROOF_ENV = {
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
  WHATSAPP_DRY_RUN: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
};

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function req(method, pathStr, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path: pathStr,
      method,
      headers: {
        Accept: opts.accept || 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.cookie ? { Cookie: opts.cookie } : {}),
        ...(opts.token ? { 'X-Luna-Bot-Token': opts.token } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

function envPick(names) {
  const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const env = app.properties.template.containers[0].env || [];
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    out[n] = e ? (e.secretRef ? { secretRef: e.secretRef } : e.value) : null;
  }
  return out;
}

function setEnvVars(pairs) {
  const parts = Object.entries(pairs).map(([k, v]) => `${k}=${v}`);
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--set-env-vars ${parts.join(' ')}`,
    '-o none',
  ].join(' '));
}

function deploy() {
  if (process.env.SKIP_DEPLOY === '1') {
    console.error('[deploy] SKIP_DEPLOY=1 — using active revision');
    for (let i = 0; i < 45; i++) {
      const rev = activeRevision();
      const hz = execSync(`curl -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim();
      if (String(rev.image || '').includes(IMAGE_TAG) && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200') {
        return rev;
      }
      execSync('powershell -Command "Start-Sleep -Seconds 10"');
    }
    return activeRevision();
  }
  console.error('[deploy] acr build...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.error('[deploy] containerapp update...');
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REV_SUFFIX}`,
    '-o none',
  ].join(' '));
  for (let i = 0; i < 45; i++) {
    const rev = activeRevision();
    const hz = execSync(`curl -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim();
    if (String(rev.image || '').includes(IMAGE_TAG) && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200') {
      return rev;
    }
    execSync('powershell -Command "Start-Sleep -Seconds 10"');
  }
  return activeRevision();
}

function botToken() {
  try {
    return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
  } catch {
    return process.env.LUNA_BOT_INTERNAL_TOKEN || '';
  }
}

function runHarness(token) {
  const res = spawnSync(process.execPath, [
    path.join(__dirname, 'scripts/run-open-demo-whatsapp-inbound-dry-run.js'),
    '--base-url', `https://${HOST}`,
    '--phone-number-id', DEMO_PHONE_ID,
    '--guest-phone', GUEST_PHONE,
    '--guest-email', GUEST_EMAIL,
    '--fixture', 'booking-deposit-write',
    '--create-demo-hold-draft-confirmed',
    '--assign-demo-bed-confirmed',
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

function summarizeTurn3(turn) {
  const t = turn || {};
  const r = t.review || {};
  const pc = r.payment_choice || {};
  const plan = r.hold_payment_draft_plan || {};
  return {
    http_status: t.http_status,
    success: t.success === true,
    payment_choice_ready: pc.payment_choice_ready === true,
    hold_plan_status: plan.plan_status || null,
    write_status: t.write_status || null,
    booking_code: t.booking_code || null,
    booking_id: t.booking_id || null,
    payment_draft_id: t.payment_draft_id || null,
    assignment_write_status: t.assignment_write_status || null,
    assigned_bed_label: t.assigned_bed_label || null,
    assigned_room_label: t.assigned_room_label || null,
    assigned_bed_id: t.assigned_bed_id || null,
    calendar_visible_expected: t.calendar_visible_expected === true,
    stripe_link_created: t.stripe_link_created,
    payment_link_sent: t.payment_link_sent,
    whatsapp_sent: t.whatsapp_sent,
    sends_whatsapp: t.sends_whatsapp,
    confirmation_sent: t.confirmation_sent === true,
    next_safe_step: t.next_safe_step || pc.next_safe_step || null,
  };
}

async function calendarMatch(cookie, bookingId, bookingCode) {
  const cal = await req(
    'GET',
    `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=${CAL_START}&end=${CAL_END}`,
    null,
    { cookie },
  );
  const blocks = (cal.body && cal.body.blocks) || [];
  const m = blocks.find((b) =>
    (bookingId && b.booking_id === bookingId)
    || (bookingCode && b.booking_code === bookingCode));
  return {
    http: cal.status,
    blocks_count: blocks.length,
    matched: !!m,
    booking_code: m && m.booking_code,
    bed_code: m && m.bed_code,
    room_code: m && m.room_code,
    check_in: m && (m.start_date || m.check_in),
    check_out: m && (m.end_date || m.check_out),
    status: m && m.status,
    guest_name: m && m.guest_name,
    assignment_status: m && m.assignment_status,
  };
}

async function dbSafety(proofStart, bookingId, paymentDraftId) {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const sends = await pg.query(
    "SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE to_phone = $1 AND created_at >= $2::timestamptz",
    [GUEST_PHONE, proofStart],
  );
  const beds = bookingId
    ? await pg.query(
      'SELECT COUNT(*)::int AS n FROM booking_beds WHERE booking_id = $1::uuid',
      [bookingId],
    )
    : { rows: [{ n: 0 }] };
  const dupBookings = await pg.query(
    `SELECT COUNT(*)::int AS n FROM bookings b
       INNER JOIN clients cl ON cl.id = b.client_id
      WHERE cl.slug = $1 AND b.phone = $2 AND b.created_at >= $3::timestamptz`,
    [CLIENT, GUEST_PHONE, proofStart],
  );
  let pay = { rows: [] };
  if (paymentDraftId) {
    pay = await pg.query(
      'SELECT status::text, checkout_url, stripe_checkout_session_id, amount_paid_cents FROM payments WHERE id = $1::uuid',
      [paymentDraftId],
    );
  }
  await pg.end();
  return {
    guest_message_sends: sends.rows[0].n,
    booking_beds_count: beds.rows[0].n,
    bookings_created_since_proof: dupBookings.rows[0].n,
    payment: pay.rows[0] || null,
  };
}

(async () => {
  const proof = {
    result: 'FAIL',
    commit: COMMIT,
    image_tag: IMAGE_TAG,
    revision: null,
    healthz: null,
    ui_ok: null,
    env_during_proof: null,
    harness_run1: null,
    harness_run2: null,
    turn3_run1: null,
    turn3_run2: null,
    calendar: null,
    db_safety: null,
    gates_restored: false,
    failures: [],
  };

  const proofStart = new Date().toISOString();

  try {
    proof.revision = deploy();
    proof.healthz = (await req('GET', '/healthz')).status;

    console.error('[env] enabling gates...');
    setEnvVars(PROOF_ENV);
    execSync('powershell -Command "Start-Sleep -Seconds 15"');
    proof.env_during_proof = envPick(Object.keys(PROOF_ENV));

    const login = await req('POST', '/staff/auth/login', {
      client: CLIENT,
      email: 'operator.stage72c@example.test',
      password: 'OperatorPass123!',
    });
    const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
    proof.ui_ok = (await req('GET', '/staff/ui', null, { cookie, accept: 'text/html' })).status === 200;

    const token = botToken();
    console.error('[harness] run 1...');
    const run1 = runHarness(token);
    const t3a = run1.turns[run1.turns.length - 1] || {};
    proof.harness_run1 = { exit: run1.exit, turn_count: run1.turns.length };
    proof.turn3_run1 = summarizeTurn3(t3a);

    proof.calendar = await calendarMatch(cookie, t3a.booking_id, t3a.booking_code);
    proof.db_safety = await dbSafety(proofStart, t3a.booking_id, t3a.payment_draft_id);

    console.error('[harness] idempotency run 2...');
    await new Promise((r) => setTimeout(r, 3000));
    const run2 = runHarness(token);
    const t3b = run2.turns[run2.turns.length - 1] || {};
    proof.harness_run2 = { exit: run2.exit, turn_count: run2.turns.length };
    proof.turn3_run2 = summarizeTurn3(t3b);

    const writeOk = (s) => s === 'created' || s === 'reused_existing';
    const assignOk = (s) => s === 'created' || s === 'reused_existing';

    proof.idempotency = {
      same_booking_id: !!(t3a.booking_id && t3b.booking_id && t3a.booking_id === t3b.booking_id),
      same_payment_draft_id: !!(t3a.payment_draft_id && t3b.payment_draft_id && t3a.payment_draft_id === t3b.payment_draft_id),
      run2_write_reused: t3b.write_status === 'reused_existing',
      run2_assignment_reused: t3b.assignment_write_status === 'reused_existing',
      same_bed_label: !!(t3a.assigned_bed_label && t3b.assigned_bed_label && t3a.assigned_bed_label === t3b.assigned_bed_label),
    };

    const checks = [
      ['revision_image', String(proof.revision.image || '').includes(IMAGE_TAG)],
      ['revision_health', proof.revision.health === 'Healthy'],
      ['revision_traffic', proof.revision.traffic === 100],
      ['healthz_200', proof.healthz === 200],
      ['ui_200', proof.ui_ok === true],
      ['harness1_exit', run1.exit === 0],
      ['turn3_success', t3a.success === true],
      ['write_status', writeOk(t3a.write_status)],
      ['assignment_status', assignOk(t3a.assignment_write_status)],
      ['calendar_visible_expected', t3a.calendar_visible_expected === true],
      ['assigned_bed_label', !!t3a.assigned_bed_label],
      ['assigned_room_label', !!t3a.assigned_room_label],
      ['calendar_match', proof.calendar.matched === true],
      ['calendar_dates', proof.calendar.matched && String(proof.calendar.check_in || '').includes('2026-07-10') && String(proof.calendar.check_out || '').includes('2026-07-17')],
      ['stripe_false', t3a.stripe_link_created === false],
      ['payment_link_false', t3a.payment_link_sent === false],
      ['whatsapp_false', t3a.whatsapp_sent === false],
      ['sends_whatsapp_false', t3a.sends_whatsapp === false],
      ['no_confirmation', t3a.confirmation_sent !== true],
      ['harness2_exit', run2.exit === 0],
      ['idempotency_write', writeOk(t3b.write_status)],
      ['idempotency_assign', assignOk(t3b.assignment_write_status)],
      ['idempotency_same_booking', proof.idempotency.same_booking_id],
      ['no_whatsapp_sends', proof.db_safety.guest_message_sends === 0],
      ['booking_beds_exist', proof.db_safety.booking_beds_count >= 1],
      ['no_stripe_checkout', !(proof.db_safety.payment && (proof.db_safety.payment.stripe_checkout_session_id || proof.db_safety.payment.checkout_url))],
    ];

    proof.checks = Object.fromEntries(checks);
    for (const [name, ok] of checks) {
      if (!ok) proof.failures.push(name);
    }

    proof.result = proof.failures.length === 0 ? 'PASS'
      : (proof.failures.length <= 2 && checks.filter(([, ok]) => ok).length >= 20 ? 'PARTIAL' : 'FAIL');
  } catch (err) {
    proof.failures.push(err.message || String(err));
    proof.result = 'FAIL';
  } finally {
    try {
      console.error('[env] restoring gate...');
      setEnvVars({ OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false' });
      proof.gates_restored = envPick(['OPEN_DEMO_BOOKING_WRITES_ENABLED']).OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false';
    } catch (restoreErr) {
      proof.gates_restored = false;
      proof.restore_error = restoreErr.message || String(restoreErr);
    }
  }

  console.log(JSON.stringify(proof, null, 2));
  process.exit(proof.result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  try {
    execSync('az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --set-env-vars OPEN_DEMO_BOOKING_WRITES_ENABLED=false -o none');
  } catch { /* ignore */ }
  process.exit(1);
});
