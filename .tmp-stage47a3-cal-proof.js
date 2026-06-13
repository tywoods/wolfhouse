'use strict';
const https = require('https');

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: 'staff-staging.lunafrontdesk.com',
      path,
      method,
      headers: {
        Accept: 'text/html,application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw: buf, headers: res.headers }));
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
  const ui = await req('GET', '/staff/ui?cb=47a3', null, { cookie });
  const raw = ui.raw;
  const checks = {
    max_4000: raw.includes('BC_GRID_HEIGHT_MAX = 4000'),
    no_content_cap_clamp: !/Math\.min\(bcGetGridHeightMax\(\)/.test(raw),
    pointerdown: raw.includes("addEventListener('pointerdown', onDown)"),
    max_height_cleared: raw.includes("wrap.style.maxHeight = ''"),
    measure_auto: raw.includes("wrap.style.height = 'auto'"),
  };
  console.log(JSON.stringify({ status: ui.status, checks, allPass: Object.values(checks).every(Boolean) }, null, 2));
})();
