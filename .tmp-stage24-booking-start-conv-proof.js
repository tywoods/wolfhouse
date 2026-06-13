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
  console.log(JSON.stringify({
    image: '18c1c29-stage24-booking-start-conv',
    revision: 'wh-staging-staff-api--stage24-booking-start-conv',
    acr_run: 'cb4p',
    health: (await req('GET', '/healthz')).status,
    ui_http: ui.status,
    bcSyncConversationButtons: h.includes('function bcSyncConversationButtons'),
    bcStartConversationFromBooking: h.includes('function bcStartConversationFromBooking'),
    bcOpenOrStart: h.includes('function bcOpenOrStartConversationFromBooking'),
    startConversationLabel: h.includes('Start Conversation'),
    toolbarDefaultStart: h.includes('id="bc-open-conversation-toolbar">Start Conversation'),
    noNoConversationError: !h.includes('No conversation found for this booking'),
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
