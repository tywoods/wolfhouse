'use strict';

const https = require('https');
const { execSync, spawnSync } = require('child_process');
const path = require('path');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = '0f637fa';
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${COMMIT}-stage27testc-package-explainer`;
const REV_SUFFIX = 'stage27testc-package-explainer';
const ACR_RUN = 'cb6h';

const BANNED_REPLY_TERMS = [
  'confirmed quote', 'payment choice', 'payment_choice', 'quote_status',
  'guest_context', 'intake_state', 'readiness_state', 'automation gate',
  'next_safe_step', 'dry run', 'idempotency', 'webhook',
];

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
}

function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path: p, method,
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

async function waitHealthy(timeoutMs = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rev = activeRevision();
    const hz = await req('GET', '/healthz');
    if (rev.health === 'Healthy' && rev.traffic === 100
        && String(rev.name || '').includes(REV_SUFFIX)
        && String(rev.image || '').includes(COMMIT)
        && hz.status === 200) {
      return rev;
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  return activeRevision();
}

function findBannedTerms(reply) {
  const text = String(reply || '').toLowerCase();
  return BANNED_REPLY_TERMS.filter((t) => text.includes(t.toLowerCase()));
}

function isHandoff(review) {
  if (!review) return false;
  const r = review.result || {};
  if (r.safe_handoff_required === true) return true;
  if (review.proposed_next_action === 'staff_handoff_required') return true;
  const gate = r.automation_gate || {};
  if (gate.gate_status === 'blocked' || gate.gate_status === 'staff_handoff') return true;
  return false;
}

function checkPackageReply(reply, lang) {
  const text = String(reply || '');
  const lower = text.toLowerCase();
  const checks = {
    mentions_malibu: /malibu/i.test(text),
    mentions_uluwatu: /uluwatu/i.test(text),
    mentions_waimea: /waimea/i.test(text),
    price_249: text.includes('€249') || text.includes('249'),
    price_349: text.includes('€349') || text.includes('349'),
    price_499: text.includes('€499') || text.includes('499'),
    no_handoff_phrase: !/team will|staff will|hand off|handoff|connect you with/i.test(text),
    no_availability_claim: !/available|availability|booked|reserved|confirmed/i.test(lower)
      || /not include availability|no availability|without availability/i.test(lower),
    no_payment_claim: !/pay now|payment link|deposit link|stripe|checkout/i.test(lower),
    no_internal_terms: findBannedTerms(text).length === 0,
    has_factual_inclusions: /7 night|7 notti|shared kitchen|cucina|lessons|lezioni|surfboard|t-shirt|airport shuttle/i.test(text),
  };
  if (lang === 'it') {
    checks.italian_reply = /pacchett|notte|notti|€249|include|surf/i.test(text);
  }
  checks.pass = checks.mentions_malibu && checks.mentions_uluwatu && checks.mentions_waimea
    && checks.price_249 && checks.price_349 && checks.price_499
    && checks.no_internal_terms && checks.no_handoff_phrase
    && (lang !== 'it' || checks.italian_reply);
  return checks;
}

function checkSafety(body) {
  const failures = [];
  if (body.dry_run !== true) failures.push(`dry_run=${body.dry_run}`);
  if (body.sends_whatsapp !== false) failures.push(`sends_whatsapp=${body.sends_whatsapp}`);
  if (body.live_send_blocked !== true) failures.push(`live_send_blocked=${body.live_send_blocked}`);
  if (body.no_write_performed !== true) failures.push(`no_write_performed=${body.no_write_performed}`);
  return { pass: failures.length === 0, failures };
}

async function inboundReview(token, message, langHint) {
  const payload = {
    source: 'harness_inbound_review',
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    guest_phone: '+34600999997',
    message_text: message,
    reference_date: '2026-06-08',
    received_at: new Date().toISOString(),
    inbound_message_id: `stage27testc-${langHint}-${Date.now()}`,
    automation_gate_context: {
      public_guest_automation_enabled: false,
      whatsapp_dry_run: true,
      live_send_allowed: false,
    },
  };
  if (langHint) payload.language_hint = langHint;
  return req('POST', '/staff/bot/guest-inbound-review-dry-run', payload, { token });
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

  let token = '';
  try {
    token = az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
  } catch {
    token = process.env.LUNA_BOT_INTERNAL_TOKEN || '';
  }

  const envRows = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query "properties.template.containers[0].env[?name==\'WHATSAPP_DRY_RUN\' || name==\'STRIPE_LINKS_ENABLED\' || name==\'NODE_ENV\'].{name:name,value:value}" -o json',
  ));

  const enRes = await inboundReview(token, 'What are the packages?', 'en');
  const itRes = await inboundReview(token, 'Quali sono i pacchetti?', 'it');

  const enBody = enRes.body || {};
  const itBody = itRes.body || {};
  const enReview = enBody.review || {};
  const itReview = itBody.review || {};
  const enReply = enReview.proposed_luna_reply || '';
  const itReply = itReview.proposed_luna_reply || '';

  const enChecks = checkPackageReply(enReply, 'en');
  const itChecks = checkPackageReply(itReply, 'it');
  const enSafety = checkSafety(enBody);
  const itSafety = checkSafety(itBody);

  let golden = null;
  if (token) {
    const gr = spawnSync(process.execPath, [
      path.join(__dirname, 'scripts/run-luna-guest-golden-tests.js'),
      '--base-url', `https://${HOST}`,
      '--category', 'package_explainer',
      '--limit', '10',
    ], {
      cwd: __dirname,
      env: { ...process.env, LUNA_BOT_INTERNAL_TOKEN: token },
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    const stdout = gr.stdout || '';
    const mPass = stdout.match(/(\d+)\/(\d+) pass/i);
    golden = {
      exit: gr.status,
      summary: mPass ? `${mPass[1]}/${mPass[2]} pass` : stdout.slice(-500),
      stdout_tail: stdout.slice(-800),
    };
  }

  const out = {
    result: null,
    commit: COMMIT,
    image: IMAGE,
    acr_run: ACR_RUN,
    revision: rev,
    healthz: hz.status,
    env_gates_unchanged: envRows,
    login_ok: login.status === 200,
    ui_ok: ui.status === 200,
    ui_has_simulator_tab: /Luna Guest Simulator/.test(ui.raw || ''),
    ui_has_inbound_review: /guest-inbound-review-dry-run|guest-automation-review-dry-run/.test(ui.raw || ''),
    english: {
      http_status: enRes.status,
      message_lane: enReview.result?.message_lane,
      handoff: isHandoff(enReview),
      proposed_next_action: enReview.proposed_next_action,
      reply_preview: enReply.slice(0, 500),
      reply_length: enReply.length,
      checks: enChecks,
      safety: enSafety,
    },
    italian: {
      http_status: itRes.status,
      message_lane: itReview.result?.message_lane,
      handoff: isHandoff(itReview),
      proposed_next_action: itReview.proposed_next_action,
      reply_preview: itReply.slice(0, 500),
      reply_length: itReply.length,
      checks: itChecks,
      safety: itSafety,
    },
    golden_subset: golden,
  };

  const corePass = out.healthz === 200
    && rev.health === 'Healthy'
    && rev.traffic === 100
    && String(rev.image || '').includes(COMMIT)
    && out.login_ok
    && out.ui_has_simulator_tab
    && enRes.status === 200 && enBody.success === true
    && itRes.status === 200 && itBody.success === true
    && !out.english.handoff && !out.italian.handoff
    && enChecks.pass && itChecks.pass
    && enSafety.pass && itSafety.pass;

  const goldenPass = !golden || golden.exit === 0;
  out.result = corePass && goldenPass ? 'PASS' : (corePass ? 'PARTIAL' : 'FAIL');

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'FAIL' ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
