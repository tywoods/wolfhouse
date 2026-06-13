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
    commit: '18c1c29',
    revision: 'wh-staging-staff-api--18c1c29-cal-rollback',
    health: (await req('GET', '/healthz')).status,
    ui_http: ui.status,
    rollback_no_bc_detail_kv_row: !h.includes('bc-detail-kv-row'),
    rollback_no_source_pebble: !h.includes('bcRenderBookingSourcePebble'),
    rollback_no_stay_block: !h.includes('bc-detail-stay-block'),
    restored_ctx_field_grid: h.includes('ctx-field-kv-grid'),
    inbox_wheel_handler: h.includes('wireInboxLeftListWheel'),
    open_booking_in_calendar: h.includes('Open Booking in Calendar'),
    open_conversation_toolbar: h.includes('bc-open-conversation-toolbar'),
    begin_conv_load: h.includes('beginConvDetailLoad'),
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
