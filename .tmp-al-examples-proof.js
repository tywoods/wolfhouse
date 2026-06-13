'use strict';
const https = require('https');
const HOST = 'staff-staging.lunafrontdesk.com';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: 'text/html,application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw, headers: res.headers }));
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
  const html = ui.raw || '';
  const out = {
    login_ok: login.status === 200,
    ui_ok: ui.status === 200,
    has_al_examples: html.includes('id="al-examples"'),
    has_chip_ops: html.includes("data-q=\"What's happening today?\""),
    has_chip_payment_soft: html.includes('data-q="Which bookings need payment follow-up?"'),
    no_owes_money_example: !html.includes('Who still owes money?') && !html.includes('Who owes money?'),
    chip_count: (html.match(/class="al-example-chip"/g) || []).length,
  };
  out.pass = Object.values(out).every((v) => v === true || typeof v === 'number');
  out.pass = out.login_ok && out.ui_ok && out.has_al_examples && out.has_chip_ops
    && out.has_chip_payment_soft && out.no_owes_money_example && out.chip_count === 15;
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
