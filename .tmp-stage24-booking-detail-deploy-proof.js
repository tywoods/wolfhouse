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
  const legend = h.match(/id=["']bc-legend["'][\s\S]{0,480}/)?.[0] || '';
  console.log(JSON.stringify({
    commit: '1200512',
    revision: 'wh-staging-staff-api--1200512-stage24-booking-detail',
    health: (await req('GET', '/healthz')).status,
    ui_http: ui.status,
    bc_detail_kv_row: h.includes('bc-detail-kv-row'),
    auto_fit_grid: h.includes('repeat(auto-fit,minmax(132px,1fr))'),
    source_pebble_bot: h.includes('bc-source-pebble-bot'),
    source_pebble_staff: h.includes('bc-source-pebble-staff'),
    render_source_pebble: h.includes('bcRenderBookingSourcePebble'),
    stay_block: h.includes('bc-detail-stay-block'),
    assigned_field: h.includes("kvBC('Assigned'"),
    legend_luna_staff_tour: legend.includes('bc-legend-sw-payment') &&
      legend.indexOf('bc-legend-sw-manual') > legend.indexOf('bc-legend-sw-payment') &&
      legend.indexOf('bc-legend-sw-tour_operator') > legend.indexOf('bc-legend-sw-manual'),
    no_forced_3col: !h.includes('ctx-field-kv-grid--3'),
    btn_success_light: h.includes('btn-success-light'),
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
