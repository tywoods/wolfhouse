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
  const legend = (h.split('id="bc-legend"')[1] || '').slice(0, 400);
  console.log(JSON.stringify({
    health: (await req('GET', '/healthz')).status,
    ui_http: ui.status,
    booking_calendar_nav: h.includes('>Booking Calendar</button>'),
    default_bed_calendar_active: /id="tab-bed-calendar" class="tab-panel active"/.test(h),
    no_today_nav: !h.includes('data-tab="today"'),
    legend_luna_before_staff: legend.indexOf('Luna') < legend.indexOf('Staff'),
    no_staff_manual: !h.includes('Staff / manual'),
    no_readonly_queue: !h.includes('READ-ONLY HANDOFF QUEUE'),
    needs_human_toggle: h.includes('conv-needs-human-toggle'),
    layout_scroll: h.includes('#detail-content{flex:1'),
  }, null, 2));
})();
