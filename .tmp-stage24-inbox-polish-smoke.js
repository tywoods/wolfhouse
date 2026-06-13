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
    conv_list_class: h.includes('id="conv-list" class="conv-list"'),
    inbox_left_rows: h.includes('.inbox-left-rows{flex:1'),
    update_luna_in_place: h.includes('function updateLunaPauseUiInPlace'),
    open_booking_cal: h.includes('Open in Booking Calendar'),
    open_booking_fn: h.includes('function openBookingInCalendar'),
    preserve_detail: h.includes('preserveDetail'),
    no_load_conv_on_pause: !/wireLunaPauseSwitch[\s\S]{0,900}loadConvDetail/.test(h),
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
