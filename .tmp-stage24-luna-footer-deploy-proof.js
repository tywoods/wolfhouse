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
    image: 'stage24-luna-footer-ui',
    revision: 'wh-staging-staff-api--stage24-luna-footer-ui',
    health: (await req('GET', '/healthz')).status,
    ui_http: ui.status,
    inbox_luna_pebble: h.includes('inboxLunaStaffPill') && h.includes('pill-luna') && h.includes('pill-staff-source'),
    drawer_footer: h.includes('bc-drawer-footer-left') && h.includes('bc-drawer-footer-right'),
    cancel_booking_label: h.includes('Cancel Booking'),
    move_before_addons: (() => {
      const d = h.match(/function renderBookingContextDrawer[\s\S]*?function toGetClient/)?.[0] || '';
      const m = d.indexOf('bc-move-bed');
      const a = d.indexOf('bcRenderAddServicePanelHtml');
      return m >= 0 && a > m;
    })(),
    footer_conv_btn: h.includes('bc-open-conv-btn') || h.includes('bc-new-conversation-btn'),
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
