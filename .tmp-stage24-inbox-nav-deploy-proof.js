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
  const pp = h.match(/function priorityPill\(conv\)\{[\s\S]*?\n\}/);
  console.log(JSON.stringify({
    commit: 'c4efe4a',
    revision: 'wh-staging-staff-api--c4efe4a-stage24-inbox-nav',
    health: (await req('GET', '/healthz')).status,
    ui_http: ui.status,
    wheel_handler: h.includes('wireInboxLeftListWheel'),
    flex_height_fix: h.includes('inbox-left-rows{flex:1 1 0'),
    begin_conv_load: h.includes('beginConvDetailLoad'),
    open_booking_in_calendar: h.includes('Open Booking in Calendar'),
    no_open_in_booking: !h.includes('Open in Booking Calendar'),
    no_reply_h3: !h.includes('<h3>Reply</h3>'),
    review_and_send: h.includes('Review and send reply'),
    open_conversation_toolbar: h.includes('bc-open-conversation-toolbar'),
    bc_open_conversation_fn: h.includes('bcOpenConversationFromBooking'),
    bc_new_conv_success: /btn-success-light[\s\S]{0,120}bc-new-conversation-btn/.test(h),
    no_urgent_in_priorityPill: pp ? !/URGENT/.test(pp[0]) : false,
    needs_human_badge: pp ? /NEEDS HUMAN/.test(pp[0]) : false,
    tab_rewire_wheel: h.includes("if (tab === 'conversations') wireInboxLeftListWheel()"),
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
