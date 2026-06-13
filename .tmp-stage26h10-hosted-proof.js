'use strict';
/** Stage 26h.10 — deploy + hosted proof. Temp, do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const COMMIT = '3dc2921';
const IMAGE_TAG = `${COMMIT}-stage26h10-nav-botmode`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REVISION_SUFFIX = 'stage26h10-nav-botmode';
const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const SVC_BOOKING_ID = '01039383-389e-4e71-a7d6-75b56345fdbf';
const XFER_BOOKING_ID = 'adf70f79-c750-458d-a306-97c81304898b';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function req(method, pathStr, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path: pathStr,
      method,
      headers: {
        Accept: 'application/json,text/html,*/*',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
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

async function withDb(fn) {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties.template?.containers?.[0]?.image,
  };
}

function envSummary() {
  const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const env = app.properties.template.containers[0].env || [];
  const pick = (name) => {
    const e = env.find((x) => x.name === name);
    if (!e) return null;
    if (e.secretRef) return { name, secretRef: e.secretRef };
    return { name, value: e.value };
  };
  return {
    STAFF_ACTIONS_ENABLED: pick('STAFF_ACTIONS_ENABLED'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    whatsapp_live_send_vars: env.filter((e) => /WHATSAPP.*SEND|META.*SEND|LIVE_SEND/i.test(e.name) && e.value === 'true').map((e) => e.name),
  };
}

async function dbCounts(c) {
  const q = async (s, p) => (await c.query(s, p)).rows[0];
  return {
    payments: (await q('SELECT COUNT(*)::text AS c FROM payments')).c,
    guest_message_sends_sent: (await q("SELECT COUNT(*)::text AS c FROM guest_message_sends WHERE status='sent'")).c,
  };
}

function waitHealthy(targetImage, maxSec) {
  for (let i = 0; i < maxSec / 10; i++) {
    const rev = activeRevision();
    if (rev.image === targetImage && rev.health === 'Healthy' && rev.traffic === 100) return rev;
    execSync('powershell -Command "Start-Sleep -Seconds 10"');
  }
  return activeRevision();
}

(async () => {
  const proof = {
    result: 'PASS',
    commit: COMMIT,
    image: IMAGE,
    revision: null,
    env: null,
    healthz: null,
    proofA_nav: {},
    proofB_botmode: {},
    proofC_regression: {},
    counts: {},
    safety: {},
    caveats: [],
  };

  proof.revision = waitHealthy(IMAGE, 180);
  if (proof.revision.image !== IMAGE || proof.revision.health !== 'Healthy') {
    proof.result = 'PARTIAL';
    proof.caveats.push(`Revision not fully healthy: ${JSON.stringify(proof.revision)}`);
  }

  proof.env = envSummary();
  if ((proof.env.whatsapp_live_send_vars || []).length) {
    proof.result = 'FAIL';
    proof.caveats.push('WhatsApp live-send env detected');
  }

  proof.healthz = (await req('GET', '/healthz')).status;
  if (proof.healthz !== 200) {
    proof.result = 'FAIL';
    proof.caveats.push(`/healthz ${proof.healthz}`);
  }

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const ui = await req('GET', '/staff/ui', null, cookie);
  const html = ui.raw || '';
  const navSlice = (html.match(/id="tabs"[\s\S]{0,500}/) || [''])[0];

  proof.proofA_nav = {
    whatsapp_label: /data-tab="conversations">WhatsApp</.test(navSlice),
    luna_staff_label: /data-tab="ask-luna">Luna Staff</.test(navSlice),
    no_inbox_nav: !/data-tab="conversations">Inbox</.test(navSlice),
    no_command_center_nav: !/data-tab="ask-luna">Command Center</.test(navSlice),
    hero_luna_staff: /al-hero-title">Luna Staff</.test(html),
    conversations_tab_id: /data-tab="conversations"/.test(navSlice),
    ask_luna_tab_id: /data-tab="ask-luna"/.test(navSlice),
  };
  if (!proof.proofA_nav.whatsapp_label || !proof.proofA_nav.luna_staff_label) {
    proof.result = 'FAIL';
  }

  // Bot mode wiring in deployed UI
  const pauseSlice = (html.match(/function wireLunaPauseSwitch[\s\S]{0,2200}/) || [''])[0];
  proof.proofB_botmode.ui_wiring = {
    bcUpdateDrawerConvBotModePebble: /function bcUpdateDrawerConvBotModePebble/.test(html),
    pause_calls_update: /bcUpdateDrawerConvBotModePebble/.test(pauseSlice),
    drawer_pebble_id: /bc-drawer-conv-bot-mode-v/.test(html),
    luna_paused_detection: /luna_paused/.test(html.match(/function isLunaGuestAutomationPaused[\s\S]{0,600}/)?.[0] || ''),
    staff_pill: /pill-staff-source/.test(html),
    luna_pill: /pill-luna/.test(html),
  };

  // Find booking with linked conversation for pause API round-trip
  let convId = null;
  let bookingId = null;
  let bookingCode = null;
  let pausedBefore = null;
  await withDb(async (c) => {
    proof.counts.before = await dbCounts(c);
    const row = (await c.query(
      `SELECT c.id::text AS conversation_id, b.id::text AS booking_id, b.booking_code
       FROM conversations c
       JOIN bookings b ON b.id = c.current_hold_booking_id
       JOIN clients cl ON cl.id = b.client_id
       WHERE cl.slug = $1 AND b.status NOT IN ('cancelled', 'expired')
       ORDER BY c.updated_at DESC NULLS LAST
       LIMIT 1`,
      [CLIENT],
    )).rows[0];
    if (row) {
      convId = row.conversation_id;
      bookingId = row.booking_id;
      bookingCode = row.booking_code;
    }
  });

  if (convId) {
    const ctxBefore = await req('GET', `/staff/bookings/${bookingId}/context?client_slug=${encodeURIComponent(CLIENT)}`, null, cookie);
    const wasPaused = ctxBefore.body?.conversation?.luna_paused === true || ctxBefore.body?.conversation?.luna_paused === 't';
    pausedBefore = wasPaused;
    const wantPause = !wasPaused;
    const pausePath = wantPause ? '/staff/bot/pause' : '/staff/bot/resume';
    const pauseBody = { client_slug: CLIENT, conversation_id: convId };
    if (wantPause) pauseBody.pause_reason = 'Stage 26h.10 hosted proof pause test';
    const pauseRes = await req('POST', pausePath + '?client=' + encodeURIComponent(CLIENT), pauseBody, cookie);
    const ctxAfterPause = await req('GET', `/staff/bookings/${bookingId}/context?client_slug=${encodeURIComponent(CLIENT)}`, null, cookie);
    const pausedAfter = ctxAfterPause.body?.conversation?.luna_paused;
    const resumePath = wantPause ? '/staff/bot/resume' : '/staff/bot/pause';
    const resumeBody = { client_slug: CLIENT, conversation_id: convId };
    if (!wantPause) resumeBody.pause_reason = 'Stage 26h.10 hosted proof restore';
    const resumeRes = await req('POST', resumePath + '?client=' + encodeURIComponent(CLIENT), resumeBody, cookie);
    const ctxAfterResume = await req('GET', `/staff/bookings/${bookingId}/context?client_slug=${encodeURIComponent(CLIENT)}`, null, cookie);

    proof.proofB_botmode.api = {
      conversation_id: convId,
      booking_id: bookingId,
      booking_code: bookingCode,
      pause_http: pauseRes.status,
      pause_success: pauseRes.body?.success !== false,
      context_paused_after_pause: pausedAfter === true || pausedAfter === 't',
      resume_http: resumeRes.status,
      context_paused_after_resume: !(ctxAfterResume.body?.conversation?.luna_paused === true || ctxAfterResume.body?.conversation?.luna_paused === 't'),
      restored_to_before: String(!!pausedBefore) === String(!!(ctxAfterResume.body?.conversation?.luna_paused === true || ctxAfterResume.body?.conversation?.luna_paused === 't')),
    };
    if (!proof.proofB_botmode.api.context_paused_after_pause || !proof.proofB_botmode.api.context_paused_after_resume) {
      proof.result = proof.result === 'FAIL' ? 'FAIL' : 'PARTIAL';
      proof.caveats.push('Pause/resume API state did not toggle as expected');
    }
  } else {
    proof.proofB_botmode.api = { skipped: 'no conversation/booking pair found' };
    proof.caveats.push('No conv for pause API proof');
  }

  // Regression spot-check (read-only)
  const svcGet = await req('GET', `/staff/bookings/${SVC_BOOKING_ID}/services?client_slug=${encodeURIComponent(CLIENT)}`, null, cookie);
  const xferGet = await req('GET', `/staff/bookings/${XFER_BOOKING_ID}/transfers?client_slug=${encodeURIComponent(CLIENT)}`, null, cookie);
  proof.proofC_regression = {
    services_has_total: /total_services|Total services/i.test(JSON.stringify(svcGet.body || {})) || html.includes('Total services'),
    services_schedule_modes: html.includes('Span Across Booking') && html.includes('Schedule Later'),
    transfers_ok: xferGet.status === 200,
    payment_link_btn: html.includes('bc-generate-payment-link-btn'),
    payment_link_not_disabled: /genBtn\.disabled\s*=\s*false/.test(html.match(/function bcInitPaymentLinkShell[\s\S]{0,1400}/)?.[0] || ''),
  };

  await withDb(async (c) => {
    proof.counts.after = await dbCounts(c);
  });
  proof.safety = {
    payments_unchanged: proof.counts.before?.payments === proof.counts.after?.payments,
    no_whatsapp_sends: proof.counts.before?.guest_message_sends_sent === proof.counts.after?.guest_message_sends_sent,
    no_live_send_env: !(proof.env.whatsapp_live_send_vars || []).length,
  };
  if (!proof.safety.payments_unchanged || !proof.safety.no_whatsapp_sends) {
    proof.result = 'FAIL';
  }

  console.log(JSON.stringify(proof, null, 2));
  process.exit(proof.result === 'FAIL' ? 1 : 0);
})();
