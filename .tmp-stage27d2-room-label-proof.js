'use strict';
/** Stage 27demo-d.2 room label fallback — hosted proof. Temp, do not commit. */
const https = require('https');
const { execSync, spawnSync } = require('child_process');
const { Client } = require('pg');
const path = require('path');

const COMMIT = '5de3c07';
const IMAGE_TAG = `${COMMIT}-stage27demo-d2-room-label-fallback`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's27d2-room-label';
const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const GUEST_PHONE = '+34600995556';
const GUEST_EMAIL = 'open-demo+34600995556@example.test';
const EXPECT_BOOKING = 'WH-G27-8E83FAD8BB';
const CHECK_IN = '2026-08-18';
const CHECK_OUT = '2026-08-25';
const DEMO_PHONE_ID = '1152900101233109';

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
    const hz = execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim();
    if (String(rev.image || '').includes(IMAGE_TAG) && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200') {
      return rev;
    }
    execSync('powershell -Command "Start-Sleep -Seconds 10"');
  }
  return activeRevision();
}

function botToken() {
  return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
}

function runHarness(token) {
  const res = spawnSync(process.execPath, [
    path.join(__dirname, 'scripts/run-open-demo-whatsapp-inbound-dry-run.js'),
    '--base-url', `https://${HOST}`,
    '--phone-number-id', DEMO_PHONE_ID,
    '--guest-phone', GUEST_PHONE,
    '--guest-email', GUEST_EMAIL,
    '--fixture', 'booking-deposit-write-clean',
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

function pickTurn3(turn) {
  const t = turn || {};
  return {
    http_status: t.http_status,
    success: t.success === true,
    write_status: t.write_status || null,
    assignment_write_status: t.assignment_write_status || null,
    booking_code: t.booking_code || null,
    booking_id: t.booking_id || null,
    assigned_bed_label: t.assigned_bed_label || null,
    assigned_room_label: t.assigned_room_label || null,
    calendar_visible_expected: t.calendar_visible_expected === true,
    stripe_link_created: t.stripe_link_created,
    payment_link_sent: t.payment_link_sent,
    whatsapp_sent: t.whatsapp_sent,
    confirmation_sent: t.confirmation_sent === true,
  };
}

async function dbSafety(bookingId) {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const sends = await pg.query(
    'SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE to_phone = $1 AND created_at >= NOW() - INTERVAL \'1 hour\'',
    [GUEST_PHONE],
  );
  const bookings = await pg.query(
    `SELECT COUNT(*)::int AS n FROM bookings b
       JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.phone = $2 AND b.check_in = $3::date AND b.check_out = $4::date`,
    [CLIENT, GUEST_PHONE, CHECK_IN, CHECK_OUT],
  );
  const beds = bookingId
    ? await pg.query('SELECT COUNT(*)::int AS n FROM booking_beds WHERE booking_id = $1::uuid', [bookingId])
    : { rows: [{ n: 0 }] };
  const pay = bookingId
    ? await pg.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE stripe_checkout_session_id IS NOT NULL OR checkout_url IS NOT NULL)::int AS stripe_n
         FROM payments WHERE booking_id = $1::uuid`,
      [bookingId],
    )
    : { rows: [{ n: 0, stripe_n: 0 }] };
  await pg.end();
  return {
    guest_message_sends_1h: sends.rows[0].n,
    bookings_same_window: bookings.rows[0].n,
    booking_beds_count: beds.rows[0].n,
    payments_count: pay.rows[0].n,
    stripe_checkout_rows: pay.rows[0].stripe_n,
  };
}

(async () => {
  const proof = {
    result: 'FAIL',
    commit: COMMIT,
    image_tag: IMAGE_TAG,
    revision: null,
    turn3: null,
    db_safety: null,
    gates_restored: false,
    failures: [],
  };

  try {
    proof.revision = deploy();
    console.error('[env] enabling gates...');
    setEnvVars(PROOF_ENV);
    execSync('powershell -Command "Start-Sleep -Seconds 20"');

    const token = botToken();
    console.error('[harness] idempotency run...');
    const run = runHarness(token);
    const t3 = run.turns[run.turns.length - 1] || {};
    proof.turn3 = pickTurn3(t3);
    proof.harness_exit = run.exit;
    proof.db_safety = await dbSafety(t3.booking_id);

    const checks = [
      ['revision_image', String(proof.revision.image || '').includes(IMAGE_TAG)],
      ['revision_healthy', proof.revision.health === 'Healthy'],
      ['harness_exit', run.exit === 0],
      ['turn3_success', t3.success === true],
      ['write_reused', t3.write_status === 'reused_existing'],
      ['assign_reused', t3.assignment_write_status === 'reused_existing'],
      ['booking_code', t3.booking_code === EXPECT_BOOKING],
      ['bed_label', t3.assigned_bed_label === 'DEMO-R1-B1'],
      ['room_label', t3.assigned_room_label === 'DEMO-R1'],
      ['calendar_visible', t3.calendar_visible_expected === true],
      ['no_dup_booking', proof.db_safety.bookings_same_window === 1],
      ['no_dup_beds', proof.db_safety.booking_beds_count === 2],
      ['no_whatsapp', proof.db_safety.guest_message_sends_1h === 0],
      ['no_stripe', proof.db_safety.stripe_checkout_rows === 0],
      ['stripe_false', t3.stripe_link_created === false],
      ['whatsapp_false', t3.whatsapp_sent === false],
      ['no_confirmation', t3.confirmation_sent !== true],
    ];
    proof.checks = Object.fromEntries(checks);
    for (const [name, ok] of checks) if (!ok) proof.failures.push(name);
    proof.result = proof.failures.length === 0 ? 'PASS' : (proof.failures.length <= 1 ? 'PARTIAL' : 'FAIL');
  } catch (err) {
    proof.failures.push(err.message || String(err));
    proof.result = 'FAIL';
  } finally {
    try {
      console.error('[env] restoring gate...');
      setEnvVars({ OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false' });
      const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
      const e = (app.properties.template.containers[0].env || []).find((x) => x.name === 'OPEN_DEMO_BOOKING_WRITES_ENABLED');
      proof.gates_restored = e && e.value === 'false';
    } catch (e) {
      proof.gates_restored = false;
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
