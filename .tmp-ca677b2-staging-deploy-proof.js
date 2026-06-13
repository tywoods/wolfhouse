'use strict';

const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = 'ca677b2';
const IMAGE_TAG = 'ca677b2-ask-luna-display';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
      headers: {
        Accept: 'application/json,text/html',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function activeRevision() {
  const rows = JSON.parse(execSync(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties.template?.containers?.[0]?.image,
  };
}

function simulateAlRenderHtml(data) {
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  if (data.intent === 'unsupported_intent') return '';
  const n = data.row_count != null ? data.row_count : (data.rows ? data.rows.length : 0);
  const rows = data.rows || [];
  let html = '<div class="al-answer-prose">' + escHtml(data.answer || '') + '</div>';
  if (n > 0 && rows.length > 0) {
    html += '<div class="al-raw-block">';
    html += '<span class="al-answer-rowcount">' + n + ' rows returned</span>';
    html += '<button class="al-raw-toggle">Show raw data</button>';
    html += '<div class="al-raw-wrap"><table class="al-rows-table"></table></div>';
    html += '</div>';
  }
  return html;
}

(async () => {
  const revision = activeRevision();
  const healthz = await req('GET', '/healthz');
  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const ui = await req('GET', '/staff/ui', null, cookie);

  const html = ui.raw || '';
  const uiChecks = {
    has_al_examples: html.includes('id="al-examples"'),
    chip_count: (html.match(/class="al-example-chip"/g) || []).length,
    first_chip_ops: html.includes('data-q="What\'s happening today?"'),
    no_owes_money: !html.includes('Who owes money?') && !html.includes('Who still owes money?'),
    has_payment_followup: html.includes('Which bookings need payment follow-up?'),
    prose_css: /\.al-answer-prose[^}]*white-space:pre-wrap/.test(html),
    raw_hidden_css: /\.al-raw-wrap\{display:none/.test(html),
    show_raw_toggle: html.includes('Show raw data'),
    al_toggle_fn: html.includes('function alToggleRawData'),
  };

  const questions = [
    "What's happening today?",
    'Which conversations need staff reply?',
    'Who is staying tonight?',
    'Which beds are free tonight?',
    'Which bookings need payment follow-up?',
  ];

  const askResults = {};
  for (const q of questions) {
    const res = await req('POST', '/staff/ask-luna', {
      client_slug: 'wolfhouse-somo',
      question: q,
      source: 'staff_portal',
    }, cookie);
    const data = res.body || {};
    const rendered = simulateAlRenderHtml(data);
    askResults[q] = {
      http: res.status,
      success: data.success === true,
      intent: data.intent,
      answer_len: (data.answer || '').length,
      answer_has_newlines: /\n/.test(data.answer || ''),
      row_count: data.row_count,
      read_only: data.read_only === true,
      no_write: data.no_write_performed === true,
      render_has_prose: rendered.includes('al-answer-prose'),
      render_raw_collapsed: rendered.includes('al-raw-wrap') && !rendered.includes('is-open'),
      render_has_show_raw: rendered.includes('Show raw data'),
      render_table_when_rows: (data.rows && data.rows.length > 0)
        ? rendered.includes('al-rows-table') : true,
    };
  }

  const out = {
    result: 'PENDING',
    commit: COMMIT,
    expected_image: `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`,
    revision,
    healthz_status: healthz.status,
    healthz_ok: healthz.status === 200,
    login_ok: login.status === 200,
    ui_ok: ui.status === 200,
    uiChecks,
    askResults,
    safety: {
      no_stripe_in_ui: !/api\.stripe\.com|stripe\.com\/v1/.test(html),
      no_whatsapp_in_ui: !/graph\.facebook\.com|whatsapp/i.test(html),
      no_n8n_in_ui: !/n8n\./i.test(html),
    },
  };

  const uiPass = uiChecks.has_al_examples && uiChecks.chip_count === 15
    && uiChecks.first_chip_ops && uiChecks.no_owes_money
    && uiChecks.prose_css && uiChecks.raw_hidden_css && uiChecks.show_raw_toggle;

  const askPass = Object.values(askResults).every((r) =>
    r.http === 200 && r.success && r.render_has_prose && r.render_raw_collapsed
    && r.render_has_show_raw && r.read_only && r.no_write);

  const revPass = revision.image && revision.image.includes(IMAGE_TAG)
    && revision.health === 'Healthy' && revision.traffic === 100;

  out.result = (revPass && out.healthz_ok && out.login_ok && uiPass && askPass) ? 'PASS' : 'FAIL';

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
