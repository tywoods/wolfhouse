'use strict';
const https = require('https');
const fs = require('fs');

function req(method, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: opts.headers || {},
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function parseCookies(setCookie) {
  const arr = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  return arr.map((c) => String(c).split(';')[0]).join('; ');
}

function extractFn(src, name) {
  const re = new RegExp(`function ${name}\\([^)]*\\)\\{`);
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length - 1;
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  return null;
}

(async () => {
  const pw = process.env.SUNSET_STAGING_PORTAL_PASSWORD || 'SunsetStaging2026!';
  const base = 'https://sunset-staging.lunafrontdesk.com';
  const login = await req('POST', `${base}/staff/auth/login`, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client: 'sunset', email: 'tywoods@gmail.com', password: pw }),
  });
  const ck = parseCookies(login.headers['set-cookie']);
  const ui = await req('GET', `${base}/staff/ui`, { headers: { Cookie: ck, Accept: 'text/html' } });
  fs.writeFileSync('tmp/staging-ui-snippet.txt', ui.body.slice(ui.body.indexOf('tab-admin') - 200, ui.body.indexOf('tab-admin') + 2500));

  const fns = ['loadAdminTab', 'renderAdminLoadingShell', 'renderAdminSchoolContext', 'renderAdminFromConfig', 'renderAdminFallback', 'refreshSunsetSchoolContextLabels'];
  const extracted = Object.fromEntries(fns.map((n) => [n, extractFn(ui.body, n) ? 'present' : 'MISSING']));

  const snippets = {};
  for (const n of ['loadAdminTab', 'renderAdminSchoolContext']) {
    const fn = extractFn(ui.body, n);
    snippets[n] = fn ? fn.slice(0, 800) : null;
  }

  console.log(JSON.stringify({ extracted, snippets }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
