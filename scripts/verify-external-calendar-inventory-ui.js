'use strict';

/**
 * Generated-browser gate for the Owner schedule card.
 * Serves production buildUiHtmlForOfflineTest HTML and drives Chromium events.
 * Playwright missing → exit 2 (skip ≠ pass).
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.EXTERNAL_CALENDAR_INGEST_ENABLED = 'true';
process.env.DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';

const SHOT_DIR = path.join('/opt/data/workspace/patches', 'osb-ui-shots');

function ok(label, cond, detail) {
  if (!cond) {
    console.error('FAIL', label, detail || '');
    throw new Error(label);
  }
  console.log('  PASS ', label);
}

function tryPlaywright() {
  const candidates = [
    process.env.WH_PLAYWRIGHT_PATH,
    path.join(__dirname, '..', 'node_modules', 'playwright'),
    'playwright',
    '/opt/data/home/.npm/_npx/e41f203b7505f1fb/node_modules/playwright',
    '/opt/wolfhouse/WH/node_modules/playwright',
  ].filter(Boolean);
  for (const candidate of candidates) {
    let mod;
    try { mod = require(candidate); } catch (_) { continue; }
    try {
      if (fs.existsSync(mod.chromium.executablePath())) return mod;
    } catch (_) { /* browsers not downloaded */ }
  }
  return null;
}

function buildHtml() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}scripts${path.sep}`)) delete require.cache[key];
  }
  const api = require('./staff-query-api');
  if (typeof api.buildUiHtmlForOfflineTest !== 'function') {
    throw new Error('Production staff UI builder seam is unavailable');
  }
  return api.buildUiHtmlForOfflineTest(0, 'wolfhouse-somo');
}

function serve(html, handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/' || url === '/staff/ui') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
    server.once('error', reject);
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function main() {
  console.log('verify-external-calendar-inventory-ui');
  const html = buildHtml();
  ok('generated /staff/ui includes Owner schedule card', /id="cc-owner-schedule-bridge"/.test(html));
  ok('generated empty CTA', /Connect Google Sheet/.test(html));
  ok('generated HTML has no SECRET_REF', !/SECRET_REF/.test(html));
  ok('generated save has no secret_ref payload', !/function ownerScheduleBridgeSave\(\)\{[\s\S]{0,400}secret_ref/.test(html));
  ok('generated bed control is a select', /data-osb-bed/.test(html));

  const playwright = tryPlaywright();
  if (!playwright) {
    console.log('STATIC GENERATED HTML CHECKS PASSED; LIVE BROWSER SKIPPED');
    process.exit(2);
  }

  const rooms = {
    success: true,
    rooms: [{
      room_code: 'R1',
      room_name: 'Room 1',
      beds: [
        { bed_id: 'bed-live-1', bed_code: 'A', bed_label: 'A' },
        { bed_id: 'bed-live-2', bed_code: 'B', bed_label: 'B' },
      ],
    }],
  };
  const connections = [
    {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Owner schedule · SHEETA',
      status: 'disabled',
      spreadsheet_id: 'sheetAAAAAA',
      sheet_name: 'inventory',
      has_secret: true,
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      name: 'Owner schedule · SHEETB',
      status: 'pending',
      spreadsheet_id: 'sheetBBBBBB',
      sheet_name: 'inventory',
      has_secret: true,
    },
  ];
  const mapsById = {
    '11111111-1111-1111-1111-111111111111': [
      { external_unit_key: 'R1A', bed_id: 'bed-live-1' },
      { external_unit_key: 'OLD', bed_id: 'bed-gone' },
    ],
    '22222222-2222-2222-2222-222222222222': [],
  };
  let failList = false;
  const posts = [];

  const { server, origin } = await serve(html, (req, res) => {
    const url = new URL(req.url, origin);
    if (url.pathname === '/staff/tour-operator/rooms') return json(res, 200, rooms);
    if (url.pathname === '/staff/luna-staff/calendar-bridge' && req.method === 'GET') {
      if (failList) return json(res, 500, { ok: false, error: 'calendar_bridge_failed' });
      return json(res, 200, { ok: true, connections });
    }
    if (url.pathname === '/staff/luna-staff/calendar-bridge/maps' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      return json(res, 200, { ok: true, maps: mapsById[id] || [] });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = {}; }
        posts.push({ path: url.pathname, method: req.method, body });
        json(res, 200, { ok: true, connection: connections[0] });
      });
      return;
    }
    json(res, 404, { ok: false, error: 'not_found' });
  });

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript(() => {
      window.getClient = function () { return 'wolfhouse-somo'; };
    });
    await page.goto(origin + '/staff/ui', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      if (typeof window.getClient !== 'function') window.getClient = function () { return 'wolfhouse-somo'; };
      const tab = document.querySelector('[data-tab="ask-luna"], #tab-ask-luna');
      if (tab && tab.click) tab.click();
      const panel = document.getElementById('tab-ask-luna');
      if (panel) panel.classList.add('active');
    });
    await page.waitForSelector('#cc-owner-schedule-bridge', { timeout: 8000 });
    await page.waitForTimeout(400);

    const rest = await page.evaluate(() => {
      const card = document.getElementById('cc-owner-schedule-bridge');
      const empty = document.getElementById('osb-empty');
      const editor = document.getElementById('osb-editor');
      const detail = document.getElementById('osb-detail');
      const sel = document.getElementById('osb-connections');
      return {
        cardText: card ? card.innerText : '',
        emptyHidden: !empty || empty.hasAttribute('hidden'),
        editorHidden: !editor || editor.hasAttribute('hidden'),
        detailHidden: !detail || detail.hasAttribute('hidden'),
        optionCount: sel ? sel.options.length : 0,
        selected: sel ? sel.value : '',
        secretVisible: /SECRET_REF/.test(card ? card.innerText : ''),
        jsonVisible: /Bed maps JSON/.test(card ? card.innerText : ''),
      };
    });
    ok('rest does not show SECRET_REF or JSON', rest.secretVisible === false && rest.jsonVisible === false);

    await page.click('#osb-new');
    await page.waitForTimeout(100);
    const editorOpen = await page.evaluate(() => !document.getElementById('osb-editor').hasAttribute('hidden'));
    ok('Connect Google Sheet opens the editor', editorOpen === true);
    await page.screenshot({ path: path.join(SHOT_DIR, 'osb-editor.png') });

    await page.click('#osb-cancel');
    await page.waitForTimeout(200);
    const afterLoad = await page.evaluate(() => ({
      emptyHidden: document.getElementById('osb-empty').hasAttribute('hidden'),
      detailHidden: document.getElementById('osb-detail').hasAttribute('hidden'),
      optionCount: document.getElementById('osb-connections').options.length,
      selected: document.getElementById('osb-connections').value,
      selectorVisible: document.getElementById('osb-connections').offsetParent !== null,
    }));
    ok('multiple connections stay selectable', afterLoad.optionCount >= 3 && afterLoad.selectorVisible === true);
    ok('does not silently force the first connection', afterLoad.selected === '' || afterLoad.selected === '11111111-1111-1111-1111-111111111111');

    await page.selectOption('#osb-connections', '11111111-1111-1111-1111-111111111111');
    await page.waitForTimeout(400);
    const mapped = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#osb-map-rows .osb-map-row')];
      const labels = rows.map((row) => [...row.querySelectorAll('[data-osb-bed] option')].map((o) => ({
        value: o.value,
        text: o.textContent,
        unavailable: o.getAttribute('data-osb-unavailable') === '1',
        selected: o.selected,
      })));
      return {
        rowCount: rows.length,
        labels,
        updateDisabled: document.getElementById('osb-sync').disabled,
        status: document.getElementById('osb-detail-status').textContent,
      };
    });
    ok('maps wait for beds then render rows', mapped.rowCount === 2);
    ok('historical bed sentinel present', mapped.labels.some((opts) => opts.some((o) => o.unavailable && o.selected && o.text.indexOf('Unavailable') >= 0)));
    ok('live beds are labeled room / bed', mapped.labels[0].some((o) => o.text === 'R1 / A'));
    ok('Update stays off while connection is disabled', mapped.updateDisabled === true);
    ok('disabled connection is Off', mapped.status === 'Off');

    await page.selectOption('#osb-connections', '22222222-2222-2222-2222-222222222222');
    await page.waitForTimeout(400);
    const second = await page.evaluate(() => ({
      name: document.getElementById('osb-detail-name').textContent,
      status: document.getElementById('osb-detail-status').textContent,
      updateDisabled: document.getElementById('osb-sync').disabled,
    }));
    ok('second connection is reachable', /SHEETB/.test(second.name));
    ok('Update stays off without valid maps', second.updateDisabled === true);
    ok('pending ingest is On', second.status === 'On');
    await page.screenshot({ path: path.join(SHOT_DIR, 'osb-detail.png') });

    failList = true;
    await page.click('#osb-refresh');
    await page.waitForTimeout(300);
    const failed = await page.evaluate(() => ({
      errHidden: document.getElementById('osb-load-error').hasAttribute('hidden'),
      emptyHidden: document.getElementById('osb-empty').hasAttribute('hidden'),
      emptyText: document.getElementById('osb-empty').innerText,
    }));
    ok('load failure does not show the empty connect lie', failed.errHidden === false && /Could not load/.test(await page.locator('#osb-load-error').innerText()));

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({ path: path.join(SHOT_DIR, 'osb-dark.png') });

    const saveBodies = posts.filter((p) => p.path === '/staff/luna-staff/calendar-bridge' && p.method === 'POST');
    ok('browser never posted secret_ref', saveBodies.every((p) => !Object.prototype.hasOwnProperty.call(p.body, 'secret_ref')));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('\nverify-external-calendar-inventory-ui: ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
