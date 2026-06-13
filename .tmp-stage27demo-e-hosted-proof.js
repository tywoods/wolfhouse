'use strict';
/** Stage 27demo-e hosted proof — temp, do not commit. */
const https = require('https');
const { execSync, spawnSync } = require('child_process');
const { Client } = require('pg');
const path = require('path');

const COMMIT = 'b816f06';
const IMAGE_TAG = `${COMMIT}-stage27demo-e-stripe-link`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's27demo-e2';
const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const DEMO_PHONE_ID = '1152900101233109';
const EXPECT_BOOKING = 'WH-G27-8E83FAD8BB';
const GUEST_PHONE = '+34600995556';
const GUEST_EMAIL = 'open-demo+34600995556@example.test';
const TY_PHONE = '+491726422307';
const TY_EMAIL = 'open-demo+ty-paymentlink@example.test';

const LINK_ENV = {
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
  STRIPE_LINKS_ENABLED: 'true',
  STAFF_ACTIONS_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
};

const RESTORE_ENV = {
  WHATSAPP_DRY_RUN: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
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

function deploy() {
  const rev = activeRevision();
  const hz = execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim();
  if (String(rev.image || '').includes(IMAGE_TAG) && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200') {
    console.error('[deploy] skip — already on target image');
    return { ...rev, healthz: Number(hz) };
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
    const hz = execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim();
    if (String(rev.image || '').includes(IMAGE_TAG) && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200') {
      return { ...rev, healthz: Number(hz) };
    }
    execSync('powershell -Command "Start-Sleep -Seconds 10"');
  }
  const finalRev = activeRevision();
  const finalHz = execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim();
  return { ...finalRev, healthz: Number(finalHz) };
}

function botToken() {
  return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
}

function runHarness(token, opts = {}) {
  const args = [
    path.join(__dirname, 'scripts/run-open-demo-whatsapp-inbound-dry-run.js'),
    '--base-url', `https://${HOST}`,
    '--phone-number-id', DEMO_PHONE_ID,
    '--guest-phone', opts.guestPhone || GUEST_PHONE,
    '--guest-email', opts.guestEmail || GUEST_EMAIL,
    '--fixture', 'booking-deposit-write-clean',
    '--create-demo-hold-draft-confirmed',
    '--assign-demo-bed-confirmed',
    '--create-stripe-test-link-confirmed',
    '--json',
  ];
  if (opts.sendPaymentLink) args.push('--send-payment-link-whatsapp-confirmed');

  const res = spawnSync(process.execPath, args, {
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
    payment_draft_id: t.payment_draft_id || null,
    stripe_link_created: t.stripe_link_created === true,
    stripe_link_reused: t.stripe_link_reused === true,
    stripe_checkout_url: t.stripe_checkout_url || null,
    stripe_checkout_session_id: t.stripe_checkout_session_id || null,
    payment_status: t.payment_status || null,
    next_safe_step: t.next_safe_step || null,
    payment_link_sent: t.payment_link_sent === true,
    whatsapp_sent: t.whatsapp_sent === true,
    sends_whatsapp: t.sends_whatsapp === true,
    confirmation_sent: t.confirmation_sent === true,
    demo_stripe_link_gate_code: t.demo_stripe_link_gate_code || null,
    demo_stripe_link_error: t.demo_stripe_link_error || null,
    payment_link_send_gate_code: t.payment_link_send_gate_code || null,
  };
}

async function dbSafety(bookingId, guestPhone, proofStart) {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const sends = await pg.query(
    'SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE to_phone = $1 AND created_at >= $2::timestamptz',
    [guestPhone, proofStart],
  );
  const stripeKey = process.env.STRIPE_SECRET_KEY || '';
  let pay = { rows: [] };
  let stripeSessions = { rows: [{ n: 0 }] };
  if (bookingId) {
    pay = await pg.query(
      `SELECT id::text, status::text, checkout_url, stripe_checkout_session_id,
              amount_paid_cents
         FROM payments WHERE booking_id = $1::uuid ORDER BY created_at ASC`,
      [bookingId],
    );
    stripeSessions = await pg.query(
      `SELECT COUNT(DISTINCT stripe_checkout_session_id)::int AS n
         FROM payments WHERE booking_id = $1::uuid AND stripe_checkout_session_id IS NOT NULL`,
      [bookingId],
    );
  }
  const beds = bookingId
    ? await pg.query('SELECT COUNT(*)::int AS n FROM booking_beds WHERE booking_id = $1::uuid', [bookingId])
    : { rows: [{ n: 0 }] };
  await pg.end();
  return {
    guest_message_sends: sends.rows[0].n,
    payments: pay.rows,
    distinct_stripe_sessions: stripeSessions.rows[0].n,
    booking_beds_count: beds.rows[0].n,
    stripe_key_prefix: stripeKey ? stripeKey.slice(0, 8) : '(secret not local)',
  };
}

(async () => {
  const proofStart = new Date().toISOString();
  const proof = {
    result: 'FAIL',
    commit: COMMIT,
    image_tag: IMAGE_TAG,
    revision: null,
    part1: null,
    part2: null,
    part3: null,
    part3_ran: false,
    db_safety: null,
    gates_restored: false,
    failures: [],
  };

  try {
    proof.revision = deploy();
    console.error('[env] link-only gates...');
    setEnvVars(LINK_ENV);
    execSync('powershell -Command "Start-Sleep -Seconds 20"');

    const token = botToken();

    console.error('[harness] part 1...');
    const run1 = runHarness(token);
    const t1 = run1.turns[run1.turns.length - 1] || {};
    proof.part1 = { exit: run1.exit, turn3: pickTurn3(t1) };

    console.error('[harness] part 2 idempotency...');
    await new Promise((r) => setTimeout(r, 3000));
    const run2 = runHarness(token);
    const t2 = run2.turns[run2.turns.length - 1] || {};
    proof.part2 = { exit: run2.exit, turn3: pickTurn3(t2) };

    proof.db_safety = await dbSafety(t1.booking_id, GUEST_PHONE, proofStart);

    const linkOk = (t) => t.stripe_link_created || t.stripe_link_reused;
    const part12Checks = [
      ['healthz', proof.revision.healthz === 200],
      ['revision_image', String(proof.revision.image || '').includes(IMAGE_TAG)],
      ['p1_exit', run1.exit === 0],
      ['p1_http', t1.http_status === 200],
      ['p1_write_reused', t1.write_status === 'reused_existing'],
      ['p1_assign_reused', t1.assignment_write_status === 'reused_existing'],
      ['p1_booking', t1.booking_code === EXPECT_BOOKING],
      ['p1_stripe_link', linkOk(t1)],
      ['p1_checkout_url', !!t1.stripe_checkout_url],
      ['p1_no_whatsapp', t1.payment_link_sent !== true && t1.whatsapp_sent !== true],
      ['p1_no_confirm', t1.confirmation_sent !== true],
      ['p2_exit', run2.exit === 0],
      ['p2_stripe_reused', t2.stripe_link_reused === true],
      ['p2_same_booking', t1.booking_id && t2.booking_id && t1.booking_id === t2.booking_id],
      ['p2_same_draft', t1.payment_draft_id && t2.payment_draft_id && t1.payment_draft_id === t2.payment_draft_id],
      ['p2_same_url', t1.stripe_checkout_url && t2.stripe_checkout_url && t1.stripe_checkout_url === t2.stripe_checkout_url],
      ['p2_no_whatsapp', t2.payment_link_sent !== true],
      ['no_dup_sessions', proof.db_safety.distinct_stripe_sessions <= 1],
      ['no_dup_beds', proof.db_safety.booking_beds_count === 2],
      ['not_paid', !(proof.db_safety.payments[0] && proof.db_safety.payments[0].amount_paid_cents > 0)],
    ];
    proof.part12_checks = Object.fromEntries(part12Checks);
    for (const [n, ok] of part12Checks) if (!ok) proof.failures.push(n);

    const part12Pass = proof.failures.length === 0;

    if (part12Pass) {
      console.error('[env] live send window...');
      setEnvVars({
        ...LINK_ENV,
        OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
        WHATSAPP_DRY_RUN: 'false',
      });
      execSync('powershell -Command "Start-Sleep -Seconds 20"');
      proof.part3_ran = true;

      console.error('[harness] part 3 live send to Ty...');
      const run3 = runHarness(token, {
        guestPhone: TY_PHONE,
        guestEmail: TY_EMAIL,
        sendPaymentLink: true,
      });
      const t3 = run3.turns[run3.turns.length - 1] || {};
      proof.part3 = { exit: run3.exit, turn3: pickTurn3(t3) };
      proof.db_safety_part3 = await dbSafety(t3.booking_id, TY_PHONE, proofStart);

      const p3Checks = [
        ['p3_exit', run3.exit === 0],
        ['p3_payment_link_sent', t3.payment_link_sent === true],
        ['p3_whatsapp_sent', t3.whatsapp_sent === true],
        ['p3_sends_whatsapp', t3.sends_whatsapp === true],
        ['p3_checkout_in_url', !!(t3.stripe_checkout_url && t3.stripe_checkout_url.includes('stripe'))],
        ['p3_no_confirm', t3.confirmation_sent !== true],
        ['p3_whatsapp_count', proof.db_safety_part3.guest_message_sends >= 1],
      ];
      proof.part3_checks = Object.fromEntries(p3Checks);
      for (const [n, ok] of p3Checks) if (!ok) proof.failures.push(n);
    } else {
      proof.part3_skipped = 'part 1/2 failed';
    }

    proof.result = proof.failures.length === 0 ? 'PASS'
      : (proof.failures.length <= 2 && part12Pass ? 'PARTIAL' : proof.failures.length <= 3 ? 'PARTIAL' : 'FAIL');
  } catch (err) {
    proof.failures.push(err.message || String(err));
    proof.result = 'FAIL';
  } finally {
    try {
      console.error('[env] restoring gates...');
      setEnvVars(RESTORE_ENV);
      const restored = envPick(Object.keys(RESTORE_ENV));
      proof.gates_restored = restored.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false'
        && restored.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'false'
        && restored.WHATSAPP_DRY_RUN === 'true'
        && restored.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'false';
      proof.gates_after_restore = restored;
    } catch (e) {
      proof.gates_restored = false;
      proof.restore_error = e.message;
    }
  }

  console.log(JSON.stringify(proof, null, 2));
  process.exit(proof.result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  try {
    execSync('az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --set-env-vars WHATSAPP_DRY_RUN=true OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false OPEN_DEMO_BOOKING_WRITES_ENABLED=false -o none');
  } catch { /* ignore */ }
  process.exit(1);
});
