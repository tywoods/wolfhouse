'use strict';
const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = 'b967c50';
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${COMMIT}-stage27w1-guest-safe-replies`;
const PARTIAL_MSG = 'Hi, we are 2 people interested in the Malibu package';

const BANNED_INTERNAL_COPY_RE = /\b(?:confirmed quote|payment choice|payment_choice|quote_status|guest_context|intake_state|readiness_state|automation gate|next_safe_step|dry run)\b/i;

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

async function waitHealthy(timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rev = activeRevision();
    const hz = await req('GET', '/healthz');
    if (rev.health === 'Healthy' && rev.traffic === 100
        && String(rev.name || '').includes('stage27w1-guest-safe-replies')
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

  const review = await req('POST', '/staff/bot/guest-automation-review-dry-run', {
    client_slug: 'wolfhouse-somo',
    channel: 'staff_review',
    message_text: PARTIAL_MSG,
    dry_run: true,
    reference_date: '2026-06-08',
    automation_gate_context: { public_guest_automation_enabled: false, whatsapp_dry_run: true },
  }, { token });

  const reply = review.body && review.body.review && review.body.review.proposed_luna_reply;
  const resultReply = review.body && review.body.review && review.body.review.result
    && review.body.review.result.proposed_luna_reply;

  const out = {
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb6a',
    revision: rev,
    healthz: hz.status,
    login_ok: login.status === 200,
    ui_ok: ui.status === 200,
    ui_has_simulator: /Luna Guest Simulator/.test(ui.raw || ''),
    ui_script_parse_ok: parseOk,
    ui_script_parse_error: parseErr,
    review_status: review.status,
    review_success: review.body && review.body.success,
    review_reply: reply,
    review_matches_result: reply === resultReply,
    review_asks_details: /dates|guests|package|stay|details/i.test(reply || ''),
    review_no_internal_copy: !BANNED_INTERNAL_COPY_RE.test(reply || ''),
    review_intake_not_ready: review.body && review.body.review && review.body.review.result
      && review.body.review.result.booking_intake_ready === false,
    review_quote_not_ready: review.body && review.body.review && review.body.review.quote
      && review.body.review.quote.quote_status === 'not_ready',
    review_pc_not_attempted: review.body && review.body.review && review.body.review.payment_choice
      && review.body.review.payment_choice.payment_choice_capture_attempted === false,
    dry_run: review.body && review.body.dry_run,
    sends_whatsapp: review.body && review.body.sends_whatsapp,
    live_send_blocked: review.body && review.body.live_send_blocked,
  };

  out.pass = out.revision.health === 'Healthy'
    && out.revision.traffic === 100
    && out.healthz === 200
    && out.login_ok
    && out.ui_ok
    && out.ui_has_simulator
    && out.ui_script_parse_ok
    && out.review_status === 200
    && out.review_success === true
    && out.review_asks_details
    && out.review_no_internal_copy
    && out.review_matches_result
    && out.review_intake_not_ready
    && out.review_quote_not_ready
    && out.review_pc_not_attempted
    && out.dry_run === true
    && out.sends_whatsapp === false
    && out.live_send_blocked === true;

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
