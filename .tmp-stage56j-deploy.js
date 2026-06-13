'use strict';
/** Stage 56j deploy — transfer times ask, service schedule writes, Luna notes. Temp — do not commit. */

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const { LUNA_GUEST_STAGING_V1 } = require('./scripts/lib/luna-guest-staging-profile');
const { OPEN_DEMO_WHATSAPP_ROUTE } = require('./scripts/lib/open-demo-whatsapp-gate');

const COMMIT = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
const IMAGE_TAG = `${COMMIT}-s56j-schedule-notes5`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's56j-schedule-notes5';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const GUEST_PHONE = '+491726422307';
const ENV_EXPECT = { ...LUNA_GUEST_STAGING_V1 };

const cmd = process.argv[2] || 'deploy';

function az(cmdStr) {
  return execSync(cmdStr, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sleep(ms) {
  execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: 'ignore' });
}

function token() {
  return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
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

function healthz() {
  return execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${STAFF_HOST}/healthz`, { encoding: 'utf8' }).trim();
}

function postJson(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: STAFF_HOST,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${token()}`,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, json: { raw } }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildOpenDemoPayload(msg, guestContext, turnIndex, flags) {
  const wamid = `wamid.s56j-${Date.now()}-t${turnIndex}`;
  const p = {
    source: 'n8n_open_demo_whatsapp_harness',
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    phone_number_id: '1152900101233109',
    guest_phone: GUEST_PHONE,
    guest_email: 'open-demo+491726422307@example.test',
    message_text: msg,
    wamid,
    inbound_message_id: wamid,
    received_at: new Date().toISOString(),
    reference_date: '2026-06-08',
  };
  if (guestContext) p.guest_context = guestContext;
  if (flags.hold) p.create_demo_hold_draft_confirmed = true;
  if (flags.bed) p.assign_demo_bed_confirmed = true;
  if (flags.stripe) p.create_stripe_test_link_confirmed = true;
  if (flags.live) p.send_live_reply_confirmed = true;
  return p;
}

async function runTurn(msg, guestContext, turnIndex, flags) {
  const payload = buildOpenDemoPayload(msg, guestContext, turnIndex, flags);
  const { status, json } = await postJson(OPEN_DEMO_WHATSAPP_ROUTE, payload);
  const body = json.body || json;
  return {
    status,
    body,
    reply: body.review && body.review.proposed_luna_reply,
    composerState: body.review && body.review.composer_state,
    nextContext: body.slim_guest_context_for_next_turn || null,
    bookingId: body.booking_id || (body.review && body.review.guest_context_chain && body.review.guest_context_chain.booking_id),
    serviceSchedule: body.serviceSchedule,
    transferTimesUpdate: body.transferTimesUpdate,
    lunaNotes: body.lunaNotes,
  };
}

async function smoke() {
  console.log('\n=== Stage 56j smoke (+491726422307) ===\n');
  let ctx = null;
  const report = { turns: [], checks: {} };

  // Turn 0 — booking intake to quote
  let t = await runTurn('Hi I want to book Malibu for 2 guests September 1 to September 9', ctx, 0, {});
  report.turns.push({ msg: 'malibu intake', reply: (t.reply || '').slice(0, 180), composerState: t.composerState });
  ctx = t.nextContext || ctx;

  t = await runTurn('Yes please Malibu for 2', ctx, 1, {});
  report.turns.push({ msg: 'confirm malibu', reply: (t.reply || '').slice(0, 180), composerState: t.composerState });
  ctx = t.nextContext || ctx;

  // Transfer airport — should ask times (not jump straight to payment)
  t = await runTurn('Yes transfer to and from Santander please', ctx, 2, {});
  const timesAsk = /arrival|departure|times when you have them|send over your arrival/i.test(t.reply || '');
  report.turns.push({
    msg: 'santander transfer',
    reply: (t.reply || '').slice(0, 220),
    composerState: t.composerState,
    timesAsk,
  });
  report.checks.transfer_times_asked = timesAsk;

  ctx = t.nextContext || ctx;

  // Proceed with deposit without times
  t = await runTurn('Deposit please', ctx, 3, { hold: true, bed: true, stripe: true });
  report.turns.push({
    msg: 'deposit',
    reply: (t.reply || '').slice(0, 180),
    bookingId: t.bookingId,
    hold: t.body && t.body.bookingWrite,
  });
  ctx = t.nextContext || ctx;
  const bookingId = t.bookingId
    || (t.body && t.body.bookingWrite && t.body.bookingWrite.booking_id)
    || (ctx && ctx.booking_id);

  report.checks.booking_created = !!bookingId;

  // Post-booking meal + schedule
  if (bookingId) {
    t = await runTurn('Can you add 1 meal please', ctx, 4, {});
    report.turns.push({ msg: 'add meal', reply: (t.reply || '').slice(0, 180), serviceAttach: t.body && t.body.serviceAttach });
    ctx = t.nextContext || ctx;

    t = await runTurn('Schedule the meal for September 2nd please', ctx, 5, {});
    report.turns.push({
      msg: 'schedule meal sept 2',
      reply: (t.reply || '').slice(0, 180),
      serviceSchedule: t.serviceSchedule || (t.body && t.body.serviceSchedule),
      composerState: t.composerState,
    });
    report.checks.meal_schedule_write = !!(t.serviceSchedule && t.serviceSchedule.success)
      || !!(t.body && t.body.serviceSchedule && t.body.serviceSchedule.success);

    const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
    const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
    await pg.connect();
    const mealRow = (await pg.query(
      `SELECT service_date::text AS service_date, service_type
         FROM booking_service_records
        WHERE booking_id = $1::uuid AND service_type IN ('meal','meals')
        ORDER BY created_at DESC LIMIT 1`,
      [bookingId],
    )).rows[0];
    const transfers = (await pg.query(
      `SELECT direction, scheduled_at, notes
         FROM booking_transfers WHERE booking_id = $1::uuid ORDER BY direction`,
      [bookingId],
    )).rows;
    const meta = (await pg.query(
      `SELECT metadata FROM bookings WHERE id = $1::uuid`, [bookingId],
    )).rows[0];
    const notes = meta && meta.metadata && meta.metadata.luna_guest_notes;
    await pg.end();

    report.db = {
      meal_service_date: mealRow && mealRow.service_date,
      transfers: transfers.map((r) => ({
        direction: r.direction,
        scheduled_at: r.scheduled_at,
        notes: r.notes,
      })),
      luna_notes_count: Array.isArray(notes) ? notes.length : 0,
    };
    report.checks.meal_on_calendar = mealRow && mealRow.service_date === '2026-09-02';
    report.checks.transfers_exist = transfers.length >= 2;
  }

  const pass = report.checks.transfer_times_asked
    && report.checks.booking_created
    && (report.checks.meal_on_calendar || report.checks.meal_schedule_write);

  report.ok = pass;
  console.log(JSON.stringify(report, null, 2));
  if (!pass) process.exit(1);
}

function deploy() {
  console.error(`[deploy] commit=${COMMIT} image=${IMAGE}`);
  console.error('[deploy] acr build...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  const envArgs = Object.entries(ENV_EXPECT).map(([k, v]) => `${k}=${v}`).join(' ');
  console.error('[deploy] containerapp update...');
  az(`az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image ${IMAGE} --revision-suffix ${REV_SUFFIX} --set-env-vars ${envArgs} -o none`);

  for (let i = 0; i < 60; i++) {
    sleep(10000);
    const cur = activeRevision();
    const hz = healthz();
    console.error(`[deploy] wait ${i + 1}/60 rev=${cur.name} health=${cur.health} hz=${hz}`);
    if (String(cur.image || '').includes(IMAGE_TAG) && cur.health === 'Healthy' && cur.traffic === 100 && hz === '200') {
      console.log(JSON.stringify({ ok: true, revision: cur, commit: COMMIT, image: IMAGE }, null, 2));
      return;
    }
  }
  console.error('Deploy timeout');
  process.exit(1);
}

if (cmd === 'smoke') {
  smoke().catch((e) => { console.error(e); process.exit(1); });
} else if (cmd === 'deploy-and-smoke') {
  deploy();
  sleep(5000);
  smoke().catch((e) => { console.error(e); process.exit(1); });
} else {
  deploy();
}
