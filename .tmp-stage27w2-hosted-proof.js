'use strict';
const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = 'ced30c1';
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${COMMIT}-stage27w2-guest-context-merge`;
const TURN1_MSG = 'Hi, we are 2 people interested in the Malibu package';
const TURN2_MSG = 'July 10 to July 17';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
}

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: headers.accept || 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(headers.cookie ? { Cookie: headers.cookie } : {}),
        ...(headers.token ? { 'X-Luna-Bot-Token': headers.token } : {}),
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

function guestContextFromReview(body) {
  const r = body.review || {};
  return {
    message_lane: r.result && r.result.message_lane,
    intake_state: r.result && r.result.intake_state,
    readiness_state: r.result && r.result.readiness_state,
    booking_intake_ready: r.result && r.result.booking_intake_ready,
    extracted_fields: r.result && r.result.extracted_fields,
    result: r.result,
    availability: r.availability,
    quote: r.quote,
    payment_choice_needed: r.quote && r.quote.payment_choice_needed,
    payment_choice: r.payment_choice,
    hold_payment_draft_plan: r.hold_payment_draft_plan,
    detected_language: r.result && r.result.detected_language,
  };
}

function reviewPayload(messageText, guestContext) {
  return {
    client_slug: 'wolfhouse-somo',
    channel: 'staff_review',
    message_text: messageText,
    dry_run: true,
    reference_date: '2026-06-08',
    guest_context: guestContext || undefined,
    automation_gate_context: { public_guest_automation_enabled: false, whatsapp_dry_run: true },
  };
}

async function waitHealthy(timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rev = activeRevision();
    const hz = await req('GET', '/healthz');
    if (rev.health === 'Healthy' && rev.traffic === 100
        && String(rev.name || '').includes('stage27w2-guest-context-merge')
        && String(rev.image || '').includes(COMMIT)
        && hz.status === 200) {
      return rev;
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  return activeRevision();
}

(async () => {
  const rev = await waitHealthy();
  const hz = await req('GET', '/healthz');

  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  const ui = await req('GET', '/staff/ui', null, { cookie, accept: 'text/html' });
  const scripts = [...ui.raw.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((x) => x[1]);
  const main = scripts[scripts.length - 1];
  let parseOk = false;
  let parseErr = null;
  try { new Function(main); parseOk = true; } catch (e) { parseErr = e.message; }

  let token = '';
  try {
    token = az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
  } catch {
    token = process.env.LUNA_BOT_INTERNAL_TOKEN || '';
  }

  const turn1 = await req('POST', '/staff/bot/guest-automation-review-dry-run', reviewPayload(TURN1_MSG), { token });
  const ctx = guestContextFromReview(turn1.body);
  const turn2 = await req('POST', '/staff/bot/guest-automation-review-dry-run', reviewPayload(TURN2_MSG, ctx), { token });

  const t1r = turn1.body && turn1.body.review;
  const t2r = turn2.body && turn2.body.review;
  const t2fields = t2r && t2r.result && t2r.result.extracted_fields;

  const out = {
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb6b',
    revision: rev,
    healthz: hz.status,
    login_ok: login.status === 200,
    ui_ok: ui.status === 200,
    ui_has_simulator: /Luna Guest Simulator/.test(ui.raw || ''),
    ui_has_context_merge: /extracted_fields:\s*r\.result/.test(ui.raw || ''),
    ui_script_parse_ok: parseOk,
    ui_script_parse_error: parseErr,
    turn1_status: turn1.status,
    turn1_asks_dates: /dates|check-in|check-out|stay/i.test((t1r && t1r.proposed_luna_reply) || ''),
    turn1_fields: t1r && t1r.result && t1r.result.extracted_fields,
    turn2_status: turn2.status,
    turn2_fields: t2fields,
    turn2_guest_count: t2fields && t2fields.guest_count,
    turn2_package: t2fields && t2fields.package_interest,
    turn2_has_dates: !!(t2fields && t2fields.check_in === '2026-07-10' && t2fields.check_out === '2026-07-17'),
    turn2_intake_ready: t2r && t2r.result && t2r.result.booking_intake_ready,
    turn2_availability_attempted: t2r && t2r.availability && t2r.availability.availability_check_attempted,
    turn2_reply: t2r && t2r.proposed_luna_reply,
    turn2_no_guest_ask: !/how many guests will be staying/i.test((t2r && t2r.proposed_luna_reply) || ''),
    dry_run: turn2.body && turn2.body.dry_run,
    sends_whatsapp: turn2.body && turn2.body.sends_whatsapp,
    live_send_blocked: turn2.body && turn2.body.live_send_blocked,
  };

  out.pass = out.revision.health === 'Healthy'
    && out.revision.traffic === 100
    && out.healthz === 200
    && out.login_ok
    && out.ui_ok
    && out.ui_has_simulator
    && out.ui_script_parse_ok
    && out.ui_has_context_merge
    && out.turn1_status === 200
    && out.turn1_asks_dates
    && out.turn2_status === 200
    && out.turn2_guest_count === 2
    && out.turn2_package === 'malibu'
    && out.turn2_has_dates
    && out.turn2_intake_ready === true
    && out.turn2_no_guest_ask
    && out.dry_run === true
    && out.sends_whatsapp === false
    && out.live_send_blocked === true;

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
