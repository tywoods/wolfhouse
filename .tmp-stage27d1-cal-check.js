'use strict';
const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';

function req(method, pathStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path: pathStr, method,
      headers: {
        Accept: headers.accept || 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(headers.cookie ? { Cookie: headers.cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* */ }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
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
  const cal = await req('GET', '/staff/bed-calendar?client=wolfhouse-somo&start=2026-07-01&end=2026-07-31', null, { cookie });
  const blocks = cal.body.blocks || [];
  const match = blocks.filter((b) => b.booking_code === 'WH-G27-0BB996236D' || b.booking_id === 'a3bdf2bf-3b00-4127-b4c2-587543163f89');
  console.log(JSON.stringify({ http: cal.status, blocks_count: blocks.length, matches: match }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
