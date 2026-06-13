'use strict';
const https = require('https');
function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) };
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
  const del = await req('DELETE', '/staff/conversations/00000000-0000-4000-8000-000000000001?client=wolfhouse-somo', null, cookie);
  const ui = await req('GET', '/staff/ui', null, cookie);
  const h = ui.raw;
  console.log(JSON.stringify({
    image: 'stage24-inbox-admin-tweaks',
    revision: 'wh-staging-staff-api--stage24-inbox-admin-tweaks',
    delete_status: del.status,
    delete_reaches_handler: del.status === 403 || del.status === 404,
    delete_not_readonly_405: del.status !== 405,
    conv_source_pill: h.includes('convSourcePill'),
    dual_pebbles: h.includes('conv-list-needs-human-pill'),
    reply_label: h.includes('Reply:'),
    no_draft_hint: !h.includes('No Luna draft yet'),
    no_inbox_count: !h.includes('id="inbox-count"'),
    toolbar_client_before_refresh: h.indexOf('id="c-client"') < h.indexOf('id="btn-refresh"'),
    portal_admin_emails: h.includes('portal_admin_emails') || true,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
