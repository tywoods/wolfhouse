'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

function extractCss() {
  const chunks = [];
  const re = /\.bc-(?:legend-sw|block)-owner_schedule_blocked\{[^}]+\}/g;
  let m;
  while ((m = re.exec(api))) chunks.push(m[0]);
  return chunks.join('\n');
}

function extractHandlers() {
  const start = api.indexOf('function ownerScheduleBridgeClient()');
  const end = api.indexOf('function staffWhatsappNumberAdd()');
  if (start < 0 || end < 0) throw new Error('generated handlers not found');
  return api.slice(start, end);
}

async function main() {
  console.log('verify-external-calendar-inventory-browser');
  let playwright;
  try { playwright = require('playwright'); }
  catch (e) {
    try { playwright = require('/opt/data/home/.npm/_npx/e41f203b7505f1fb/node_modules/playwright'); }
    catch (e2) {
      console.log('SKIP live browser — playwright missing (not a pass)');
      process.exit(2);
    }
  }
  const css = extractCss();
  const handlers = extractHandlers();
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const calls = [];
    await page.exposeFunction('__osbPush', (entry) => { calls.push(entry); });
    await page.setContent(`<!doctype html><html><head><style>${css}
.bc-block{height:28px;padding:4px 8px;font:600 12px sans-serif}
</style></head><body>
<div class="bc-block bc-block-owner_schedule_blocked" id="blk">Owner schedule blocked</div>
<div class="card" id="cc-owner-schedule-bridge">
  <div id="osb-status"></div>
  <input id="osb-name" value="Owner"><input id="osb-sheet" value="sheetid1234"><input id="osb-tab" value="inventory">
  <input id="osb-secret" value="WH_SHEET_SA">
  <button id="osb-save">Save</button>
  <button id="osb-probe">Probe</button>
  <button id="osb-sync">Sync</button>
  <pre id="osb-out"></pre>
</div>
<script>
function el(id){ return document.getElementById(id); }
function getClient(){ return 'wolfhouse-somo'; }
window.fetch = function(url, opts){
  window.__osbPush({ url: String(url), method: opts && opts.method, body: opts && opts.body });
  return Promise.resolve({ json: function(){ return Promise.resolve({ ok: true }); } });
};
${handlers}
</script></body></html>`);

    const colors = await page.evaluate(() => getComputedStyle(document.getElementById('blk')).backgroundColor);
    const rgb = colors.match(/\d+/g).map(Number);
    if (!(rgb[0] > 180 && rgb[1] > 160 && rgb[2] < 140)) throw new Error('not yellow ' + colors);
    console.log('  PASS  generated CSS paints yellow', colors);

    await page.click('#osb-probe');
    await page.waitForTimeout(50);
    const probeCall = calls.find((c) => /calendar-bridge\/probe/.test(c.url));
    if (!probeCall) throw new Error('probe not called');
    if (probeCall.body && /"rows"/.test(probeCall.body)) throw new Error('probe sent rows');
    console.log('  PASS  generated probe handler sends no rows');

    await page.click('#osb-save');
    await page.waitForTimeout(50);
    const saveCall = calls.find((c) => /calendar-bridge\?/.test(c.url) && c.method === 'POST');
    if (!saveCall) throw new Error('save not called');
    if (/private_key|BEGIN /.test(saveCall.body || '')) throw new Error('save leaked credential');
    console.log('  PASS  generated save sends secret_ref only');
  } finally {
    await browser.close();
  }
  console.log('\nverify-external-calendar-inventory-browser: ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
