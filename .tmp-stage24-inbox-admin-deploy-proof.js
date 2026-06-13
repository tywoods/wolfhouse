'use strict';
const https = require('https');
function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'text/html,application/json', ...(cookie ? { Cookie: cookie } : {}) };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const r = https.request({ hostname: 'staff-staging.lunafrontdesk.com', path, method, headers: h }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const ui = await req('GET', '/staff/ui', null, cookie);
  const h = ui.raw;
  const session = await req('GET', '/staff/auth/session', null, cookie);
  let sessionJson = {};
  try { sessionJson = JSON.parse(session.raw); } catch (_) {}
  const listPill = h.match(/function convListPill\(conv\)\{[\s\S]*?\n\}/);
  console.log(JSON.stringify({
    image: 'stage24-inbox-admin',
    revision: 'wh-staging-staff-api--stage24-inbox-admin',
    acr_run: 'cb4j',
    health: (await req('GET', '/healthz')).status,
    ui_http: ui.status,
    session_ok: sessionJson.success === true,
    session_clients: (sessionJson.clients || []).length,
    client_dropdown: h.includes('id="c-client"') && h.includes('inbox-client-select'),
    conv_list_pill: listPill ? listPill[0].includes('Needs Human') : false,
    no_handoff_pill: listPill ? !listPill[0].includes('HANDOFF') : false,
    luna_staff_pills: h.includes('convHeaderStatusPillsHtml') && h.includes('pill-luna'),
    clear_conversation_btn: h.includes('btn-clear-conversation') && h.includes('Clear Conversation'),
    delete_conv_btn: h.includes('conv-card-delete'),
    silent_refresh: h.includes('silent: true, preserveDetail: true'),
    clear_messages_route: h.includes('/clear-messages'),
    delete_route: h.includes("method: 'DELETE'"),
    needs_human_filter: h.includes('Needs Human'),
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
