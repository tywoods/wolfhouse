'use strict';
/**
 * Simulates admin click handlers against live staging config + rendered HTML structure.
 */
const https = require('https');
function req(method, url, body, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Cookie: cookie || '',
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw: d, json: (() => { try { return JSON.parse(d); } catch { return null; } })() }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  const base = 'https://sunset-staging.lunafrontdesk.com';
  const login = await req('POST', `${base}/staff/auth/login`, {
    client: 'sunset', email: 'tywoods@gmail.com', password: 'SunsetStaging2026!',
  });
  const ck = (Array.isArray(login.headers?.['set-cookie']) ? login.headers['set-cookie'] : [login.headers?.['set-cookie']])
    .filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const ui = await req('GET', `${base}/staff/ui`, null, ck);
  const hasHandler = ui.raw.includes("if (action === 'save-price-group')");
  const hasAddPackHandler = ui.raw.includes("if (action === 'add-pack')");
  const hasDeleteHandler = ui.raw.includes("if (action === 'delete-price')");

  // Check if save-price-group appears only in guard/html, not as handler
  const handlerIdx = ui.raw.indexOf("if (action === 'save-price-group')");
  const context = handlerIdx >= 0 ? ui.raw.slice(handlerIdx, handlerIdx + 120) : '';

  console.log(JSON.stringify({
    hasSavePriceGroupHandler: hasHandler,
    handlerContext: context,
    hasAddPackHandler,
    hasDeleteHandler,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
