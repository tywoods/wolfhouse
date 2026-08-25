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
  <select id="osb-connections"><option value="">Select a connection</option></select>
  <input id="osb-name"><input id="osb-sheet"><input id="osb-tab"><input id="osb-secret">
  <textarea id="osb-map-json"></textarea>
  <button id="osb-save">Save</button>
  <button id="osb-probe">Probe</button>
  <button id="osb-sync">Sync</button>
  <button id="osb-new">New</button>
  <button id="osb-refresh">Refresh</button>
  <pre id="osb-out"></pre>
</div>
<script>
function el(id){ return document.getElementById(id); }
function getClient(){ return 'wolfhouse-somo'; }
var store = {
  connections: [
    { id: '11111111-1111-1111-1111-111111111111', name: 'A', spreadsheet_id: 'sheetAAAAAA', sheet_name: 'inventory', status: 'pending', last_error: 'calendar_bridge_failed', has_secret: true },
    { id: '22222222-2222-2222-2222-222222222222', name: 'B', spreadsheet_id: 'sheetBBBBBB', sheet_name: 'inventory', status: 'pending', has_secret: true }
  ]
};
window.fetch = function(url, opts){
  var body = opts && opts.body ? JSON.parse(opts.body) : {};
  window.__osbPush({ url: String(url), method: opts && opts.method, body: opts && opts.body });
  if (/calendar-bridge\\?/.test(url) && (!opts || opts.method === 'GET')) {
    return Promise.resolve({ json: function(){ return Promise.resolve({ ok: true, connections: store.connections }); } });
  }
  if (/calendar-bridge\\?/.test(url) && opts && opts.method === 'POST') {
    if (body.id) {
      store.connections = store.connections.map(function(c){ return c.id === body.id ? Object.assign({}, c, body) : c; });
      var updated = store.connections.filter(function(c){ return c.id === body.id; })[0];
      return Promise.resolve({ json: function(){ return Promise.resolve({ ok: true, connection: updated }); } });
    }
    var created = { id: '33333333-3333-3333-3333-333333333333', name: body.name, spreadsheet_id: body.spreadsheet_id, sheet_name: body.sheet_name, status: 'disabled' };
    store.connections.push(created);
    return Promise.resolve({ json: function(){ return Promise.resolve({ ok: true, connection: created }); } });
  }
  if (/probe|sync|maps|enable/.test(url)) {
    return Promise.resolve({ json: function(){ return Promise.resolve({ ok: true }); } });
  }
  return Promise.resolve({ json: function(){ return Promise.resolve({ ok: false, error: 'duplicate key value violates unique constraint bookings_pkey' }); } });
};
${handlers}
</script></body></html>`);

    const colors = await page.evaluate(() => getComputedStyle(document.getElementById('blk')).backgroundColor);
    const rgb = colors.match(/\d+/g).map(Number);
    if (!(rgb[0] > 180 && rgb[1] > 160 && rgb[2] < 140)) throw new Error('not yellow ' + colors);
    console.log('  PASS  generated CSS paints yellow', colors);

    await page.click('#osb-refresh');
    await page.waitForTimeout(40);
    const optionCount = await page.evaluate(() => document.querySelectorAll('#osb-connections option').length);
    if (optionCount < 3) throw new Error('list not rendered');
    console.log('  PASS  refresh renders connection list');

    await page.selectOption('#osb-connections', '11111111-1111-1111-1111-111111111111');
    await page.waitForTimeout(40);
    const filled = await page.inputValue('#osb-name');
    if (filled !== 'A') throw new Error('select did not populate form: ' + filled);
    console.log('  PASS  select populates selected connection');

    await page.fill('#osb-name', 'A-updated');
    await page.click('#osb-save');
    await page.waitForTimeout(40);
    const saveCall = calls.find((c) => /calendar-bridge\?/.test(c.url) && c.method === 'POST' && c.body && /"id":"11111111-1111-1111-1111-111111111111"/.test(c.body));
    if (!saveCall) {
      throw new Error('update did not send selected id');
    }
    console.log('  PASS  save updates the selected connection id');

    await page.click('#osb-probe');
    await page.waitForTimeout(40);
    const probeCall = calls.filter((c) => /calendar-bridge\/probe/.test(c.url)).pop();
    if (!probeCall || !/id=11111111-1111-1111-1111-111111111111/.test(probeCall.url)) {
      throw new Error('probe missing selected id');
    }
    if (probeCall.body && /"rows"/.test(probeCall.body)) throw new Error('probe sent rows');
    console.log('  PASS  probe uses selected id and no rows');

    await page.click('#osb-new');
    await page.fill('#osb-name', 'C');
    await page.fill('#osb-sheet', 'sheetCCCCCCCC');
    await page.click('#osb-save');
    await page.waitForTimeout(40);
    const createCall = calls.filter((c) => c.method === 'POST' && /calendar-bridge\?/.test(c.url) && c.body && /sheetCCCCCCCC/.test(c.body)).pop();
    if (!createCall) throw new Error('create not called');
    if (/"id":"11111111/.test(createCall.body || '')) throw new Error('new connection reused old id');
    console.log('  PASS  new connection does not reuse previous id');

    await page.evaluate(() => {
      osbSelectedId = '11111111-1111-1111-1111-111111111111';
      document.getElementById('osb-connections').value = osbSelectedId;
    });
    await page.evaluate(async () => {
      const res = { body: { ok: false, error: 'duplicate key value violates unique constraint bookings_pkey' } };
      document.getElementById('osb-status').textContent = ownerScheduleSafeCopy(res.body.error);
      document.getElementById('osb-out').textContent = JSON.stringify(ownerSchedulePublicPayload(res.body));
    });
    const status = await page.textContent('#osb-status');
    const out = await page.textContent('#osb-out');
    if (/duplicate key|bookings_pkey/.test(status + out)) throw new Error('raw SQL leaked to DOM');
    if (!/Last blocks were kept/.test(status)) throw new Error('unsafe operator copy missing');
    console.log('  PASS  hostile SQL error stays out of DOM');
  } finally {
    await browser.close();
  }
  console.log('\nverify-external-calendar-inventory-browser: ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
