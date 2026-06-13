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
    no_inbox_h2: !/<h2>\s*Inbox\s*<\/h2>/.test(h),
    no_nh_toggle_wrap: !h.includes('nh-toggle-wrap'),
    inbox_left_scroll: h.includes('.inbox-left-scroll{flex:1'),
    conv_list_scroll: /\.conv-list\{[^}]*overflow-y:\s*auto/.test(h),
    inbox_switch_orange: h.includes('inbox-switch-orange'),
    inbox_switch_red: h.includes('inbox-switch-red'),
    luna_pause_switch_id: h.includes('luna-pause-switch'),
    needs_human_toggle_id: h.includes('conv-needs-human-toggle'),
    no_btn_luna_pause: !h.includes('btn-luna-pause'),
    perform_inbox_send: h.includes('function performInboxSend'),
    enter_keydown: /keydown[\s\S]{0,120}Enter/.test(h),
    shift_enter_guard: h.includes('ev.shiftKey'),
    send_route: h.includes('/staff/inbox/send-reply'),
    no_guest_reply_send: !h.includes('/staff/bot/guest-reply-send'),
    thread_scroll: h.includes('.thread{') && h.includes('overflow-y:auto'),
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
