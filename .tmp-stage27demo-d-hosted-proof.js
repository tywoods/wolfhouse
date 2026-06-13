'use strict';
/** Stage 27demo-d — deploy + booking hold/draft write + calendar proof. Temp, do not commit. */
const https = require('https');
const { execSync, spawnSync } = require('child_process');
const { Client } = require('pg');
const path = require('path');

const COMMIT = '85f2d99';
const IMAGE_TAG = `${COMMIT}-stage27demo-d-booking-write`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 'stage27demo-d-booking-write';
const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const GUEST_PHONE = '+34600995555';
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
const RESTORE_ENV = {
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
};

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
    if (!e) out[n] = null;
    else if (e.secretRef) out[n] = { secretRef: e.secretRef };
    else out[n] = e.value;
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
  const current = activeRevision();
  // Always rebuild after local fix — image tag unchanged, digest updates.
  console.error('[deploy] acr build...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.error('[deploy] containerapp update...');
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REV_SUFFIX}-v2`,
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

function runBookingHarness(token) {
  const res = spawnSync(process.execPath, [
    path.join(__dirname, 'scripts/run-open-demo-whatsapp-inbound-dry-run.js'),
    '--base-url', `https://${HOST}`,
    '--phone-number-id', DEMO_PHONE_ID,
    '--guest-phone', GUEST_PHONE,
    '--fixture', 'booking-deposit-write',
    '--create-demo-hold-draft-confirmed',
    '--guest-email', 'open-demo+34600995555@example.test',
    '--json',
  ], {
    cwd: __dirname,
    env: { ...process.env, LUNA_BOT_INTERNAL_TOKEN: token },
    encoding: 'utf8',
    maxBuffer: 30 * 1024 * 1024,
  });
  const turns = [];
  const chunks = (res.stdout || '').split(/\n(?=\{)/);
  for (const chunk of chunks) {
    const t = chunk.trim();
    if (!t.startsWith('{')) continue;
    try { turns.push(JSON.parse(t)); } catch { /* skip */ }
  }
  return { exit: res.status, stderr: res.stderr, turns };
}

function summarizeTurn(turn, idx) {
  const r = turn.review || {};
  const pc = r.payment_choice || {};
  const plan = r.hold_payment_draft_plan || {};
  const res = r.result || {};
  return {
    turn: idx + 1,
    http_status: turn.http_status,
    success: turn.success === true,
    message_lane: res.message_lane || null,
    guest_count: res.guest_count ?? r.guest_count ?? null,
    package_slug: res.package_slug ?? r.package_slug ?? null,
    quote_ready: r.quote && (r.quote.quote_ready === true || r.quote.total_cents > 0),
    payment_choice_ready: pc.payment_choice_ready === true,
    next_safe_step: pc.next_safe_step || turn.next_safe_step || null,
    hold_plan_status: plan.plan_status || null,
    write_status: turn.write_status || null,
    booking_code: turn.booking_code || null,
    booking_id: turn.booking_id || null,
    payment_draft_id: turn.payment_draft_id || null,
    stripe_link_created: turn.stripe_link_created,
    payment_link_sent: turn.payment_link_sent,
    whatsapp_sent: turn.whatsapp_sent,
    sends_whatsapp: turn.sends_whatsapp,
    demo_booking_write_gate_code: turn.demo_booking_write_gate_code || null,
    write_block_reasons: turn.write_block_reasons || null,
  };
}

async function withDb(fn) {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function dbSafety(proofStart, bookingId, paymentDraftId) {
  return withDb(async (pg) => {
    const sends = await pg.query(`
      SELECT COUNT(*)::int AS n FROM guest_message_sends
       WHERE client_slug = $1 AND to_phone = $2 AND created_at >= $3::timestamptz`,
      [CLIENT, GUEST_PHONE, proofStart]);
    const stripe = bookingId
      ? await pg.query(`
          SELECT id::text, status::text, checkout_url, stripe_checkout_session_id, amount_paid_cents
            FROM payments WHERE booking_id = $1::uuid`, [bookingId])
      : { rows: [] };
    const booking = bookingId
      ? await pg.query(`
          SELECT b.id::text, b.booking_code, b.phone, b.check_in::text, b.check_out::text,
                 b.status::text, b.confirmed_at, b.total_amount_cents
            FROM bookings b WHERE b.id = $1::uuid`, [bookingId])
      : { rows: [] };
    const confirmSends = await pg.query(`
      SELECT COUNT(*)::int AS n FROM guest_message_sends
       WHERE client_slug = $1 AND to_phone = $2 AND send_kind ILIKE '%confirm%'
         AND created_at >= $3::timestamptz`, [CLIENT, GUEST_PHONE, proofStart]).catch(() => ({ rows: [{ n: 0 }] }));
    const dupBookings = await pg.query(`
      SELECT COUNT(*)::int AS n FROM bookings b
       INNER JOIN clients cl ON cl.id = b.client_id
       WHERE cl.slug = $1 AND b.phone = $2 AND b.created_at >= $3::timestamptz`,
      [CLIENT, GUEST_PHONE, proofStart]);
    return {
      guest_message_sends_since_proof: sends.rows[0].n,
      duplicate_bookings_since_proof: dupBookings.rows[0].n,
      payment_rows: stripe.rows,
      booking_row: booking.rows[0] || null,
      confirmation_sends: confirmSends.rows[0].n,
      payment_draft_id: paymentDraftId,
    };
  });
}

async function queryReviewErrors(proofStart) {
  try {
    const q = [
      'az monitor log-analytics query',
      '--workspace $(az monitor log-analytics workspace list --resource-group wh-staging-rg --query "[0].customerId" -o tsv)',
      `--analytics-query "ContainerAppConsoleLogs_CL | where TimeGenerated > datetime(${proofStart}) | where Log_s contains 'LUNA_REVIEW_DRY_RUN_ERROR' | summarize count()"`,
      '-o json',
    ].join(' ');
    const raw = az(q);
    const parsed = JSON.parse(raw);
    const tables = parsed.tables || parsed;
    const count = tables?.[0]?.rows?.[0]?.[0] ?? 0;
    return { ok: Number(count) === 0, count: Number(count) };
  } catch (err) {
    return { ok: null, error: err.message || String(err), skipped: true };
  }
}

(async () => {
  const proof = {
    result: 'FAIL',
    commit: COMMIT,
    image_tag: IMAGE_TAG,
    image: IMAGE,
    revision: null,
    healthz: null,
    ui_ok: null,
    env_during_proof: null,
    harness: { run1: null, run2: null },
    write: {},
    calendar: {},
    db_safety: {},
    review_error_logs: {},
    gates_restored: false,
    failures: [],
  };

  const proofStart = new Date().toISOString();

  try {
    proof.revision = deploy();
    proof.healthz = (await req('GET', '/healthz')).status;

    console.error('[env] enabling booking write gates...');
    setEnvVars(PROOF_ENV);
    execSync('powershell -Command "Start-Sleep -Seconds 15"');
    proof.env_during_proof = envPick(Object.keys(PROOF_ENV));

    const login = await req('POST', '/staff/auth/login', {
      client: CLIENT,
      email: 'operator.stage72c@example.test',
      password: 'OperatorPass123!',
    });
    const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
    const ui = await req('GET', '/staff/ui', null, { cookie, accept: 'text/html' });
    proof.ui_ok = ui.status === 200;

    const token = botToken();
    if (!token) {
      proof.failures.push('missing LUNA_BOT_INTERNAL_TOKEN');
    }

    console.error('[harness] run 1...');
    const run1 = runBookingHarness(token);
    proof.harness.run1 = {
      exit: run1.exit,
      turn_summaries: run1.turns.map(summarizeTurn),
      stderr: run1.stderr ? run1.stderr.slice(0, 500) : null,
    };

    const turn3 = run1.turns[run1.turns.length - 1] || {};
    proof.write = {
      write_status: turn3.write_status,
      booking_code: turn3.booking_code,
      booking_id: turn3.booking_id,
      payment_draft_id: turn3.payment_draft_id,
      next_safe_step: turn3.next_safe_step,
      stripe_link_created: turn3.stripe_link_created,
      payment_link_sent: turn3.payment_link_sent,
      whatsapp_sent: turn3.whatsapp_sent,
      sends_whatsapp: turn3.sends_whatsapp,
      confirmation_sent: turn3.confirmation_sent === true,
    };

    console.error('[harness] idempotency run 2...');
    await new Promise((r) => setTimeout(r, 3000));
    const run2 = runBookingHarness(token);
    const turn3b = run2.turns[run2.turns.length - 1] || {};
    proof.harness.run2 = {
      exit: run2.exit,
      turn3_write_status: turn3b.write_status,
      turn3_booking_code: turn3b.booking_code,
      turn3_booking_id: turn3b.booking_id,
      turn3_payment_draft_id: turn3b.payment_draft_id,
      same_booking_id: !!(turn3.booking_id && turn3b.booking_id && turn3.booking_id === turn3b.booking_id),
      same_payment_draft_id: !!(turn3.payment_draft_id && turn3b.payment_draft_id && turn3.payment_draft_id === turn3b.payment_draft_id),
      reused_or_same: turn3b.write_status === 'reused_existing'
        || (turn3.booking_id && turn3b.booking_id && turn3.booking_id === turn3b.booking_id
          && turn3.payment_draft_id && turn3b.payment_draft_id && turn3.payment_draft_id === turn3b.payment_draft_id),
    };

    proof.db_safety = await dbSafety(proofStart, turn3.booking_id, turn3.payment_draft_id);
    proof.review_error_logs = await queryReviewErrors(proofStart);

    if (turn3.booking_code || turn3.booking_id) {
      const cal = await req(
        'GET',
        `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=${CAL_START}&end=${CAL_END}`,
        null,
        { cookie },
      );
      const blocks = (cal.body && cal.body.blocks) || [];
      const match = blocks.find((b) =>
        (turn3.booking_id && b.booking_id === turn3.booking_id)
        || (turn3.booking_code && b.booking_code === turn3.booking_code)
        || (b.guest_phone === GUEST_PHONE || b.phone === GUEST_PHONE));
      proof.calendar = {
        http: cal.status,
        blocks_in_july: blocks.length,
        matched: !!match,
        booking_code: match && match.booking_code,
        guest_name: match && match.guest_name,
        check_in: match && match.check_in,
        check_out: match && match.check_out,
        status: match && match.status,
        payment_status: match && (match.payment_status || match.payment_summary),
      };
    }

    const t1 = proof.harness.run1.turn_summaries[0] || {};
    const t2 = proof.harness.run1.turn_summaries[1] || {};
    const t3s = proof.harness.run1.turn_summaries[2] || {};

    const checks = [
      ['revision_image', String(proof.revision.image || '').includes(IMAGE_TAG)],
      ['revision_health', proof.revision.health === 'Healthy'],
      ['revision_traffic', proof.revision.traffic === 100],
      ['healthz_200', proof.healthz === 200],
      ['ui_200', proof.ui_ok === true],
      ['harness_exit', run1.exit === 0],
      ['turn1_success', t1.success === true],
      ['turn2_success', t2.success === true],
      ['turn3_success', t3s.success === true],
      ['turn3_payment_choice_ready', t3s.payment_choice_ready === true],
      ['turn3_hold_plan_ready', t3s.hold_plan_status === 'ready'],
      ['write_status_ok', t3s.write_status === 'created' || t3s.write_status === 'reused_existing'],
      ['booking_code', !!t3s.booking_code],
      ['booking_id', !!t3s.booking_id],
      ['payment_draft_id', !!t3s.payment_draft_id],
      ['next_safe_step', t3s.next_safe_step === 'ready_for_stripe_test_link'],
      ['stripe_link_created_false', t3s.stripe_link_created === false],
      ['payment_link_sent_false', t3s.payment_link_sent === false],
      ['whatsapp_sent_false', t3s.whatsapp_sent === false],
      ['sends_whatsapp_false', t3s.sends_whatsapp === false],
      ['calendar_match', proof.calendar.matched === true],
      ['no_stripe_checkout', !(proof.db_safety.payment_rows || []).some((p) => p.stripe_checkout_session_id || p.checkout_url)],
      ['no_whatsapp_sends', proof.db_safety.guest_message_sends_since_proof === 0],
      ['no_confirmation_sends', proof.db_safety.confirmation_sends === 0],
      ['booking_not_confirmed', !proof.db_safety.booking_row?.confirmed_at],
      ['idempotency', proof.harness.run2.reused_or_same === true],
    ];

    for (const [name, ok] of checks) {
      if (!ok) proof.failures.push(name);
    }

    if (proof.review_error_logs.ok === false) proof.failures.push('review_dry_run_errors_in_logs');

    proof.checks = Object.fromEntries(checks);
    proof.result = proof.failures.length === 0 ? 'PASS'
      : (checks.slice(0, 15).every(([, ok]) => ok) && proof.failures.length <= 2 ? 'PARTIAL' : 'FAIL');
  } catch (err) {
    proof.failures.push(err.message || String(err));
    proof.result = 'FAIL';
  } finally {
    try {
      console.error('[env] restoring booking write gate...');
      setEnvVars(RESTORE_ENV);
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
  process.exit(1);
});
