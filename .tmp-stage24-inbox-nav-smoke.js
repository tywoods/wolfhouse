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
  const health = await req('GET', '/healthz');
  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const ui = await req('GET', '/staff/ui', null, cookie);
  const h = ui.raw;
  console.log(JSON.stringify({
    health: health.status,
    ui_http: ui.status,
    wheel_handler: h.includes('wireInboxLeftListWheel'),
    begin_conv_load: h.includes('beginConvDetailLoad'),
    open_booking_in_calendar: h.includes('Open Booking in Calendar'),
    no_open_in_booking: !h.includes('Open in Booking Calendar'),
    no_reply_h3: !h.includes('<h3>Reply</h3>'),
    review_and_send: h.includes('Review and send reply'),
    open_conversation_toolbar: h.includes('bc-open-conversation-toolbar'),
    btn_success_light: h.includes('btn-success-light'),
    bc_open_conversation_fn: h.includes('bcOpenConversationFromBooking'),
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
