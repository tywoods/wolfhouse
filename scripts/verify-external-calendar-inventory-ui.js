'use strict';

/**
 * Generated-browser gate for the Owner schedule card.
 * Serves production buildUiHtmlForOfflineTest HTML and drives Chromium events.
 * Playwright/Chromium missing → exit 2 (skip ≠ pass).
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');

process.env.NODE_ENV = 'test';
process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.EXTERNAL_CALENDAR_INGEST_ENABLED = 'true';
process.env.DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
process.env.STAFF_PORTAL_LOCALES = process.env.STAFF_PORTAL_LOCALES || 'en,es,it';

const SHOT_DIR = path.join('/opt/data/workspace/patches', 'osb-ui-shots');
const FIRST_ID = '11111111-1111-1111-1111-111111111111';
const SECOND_ID = '22222222-2222-2222-2222-222222222222';

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

function assertGeneratedScriptsParse(html) {
  const { spawnSync } = require('child_process');
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  let index = 0;
  let checked = 0;
  while ((m = re.exec(html))) {
    index += 1;
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/type\s*=\s*['"]application\/(?:ld\+)?json['"]/i.test(attrs)) continue;
    const body = m[2] || '';
    if (!body.trim()) continue;
    checked += 1;
    const r = spawnSync(process.execPath, ['--check'], { input: body, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error('generated script #' + index + ' invalid: ' + String(r.stderr || r.stdout || '').trim());
    }
  }
  ok('generated inline scripts parse', checked > 0, 'checked=' + checked);
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

function createPortalServer(html) {
  const { buildClientProfilesMap, getAccessibleClients } = require('./lib/staff-portal-clients');
  function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }
  return http.createServer((req, res) => {
    const parsed = require('url').parse(req.url, true);
    const pathname = parsed.pathname || '/';
    if (pathname === '/staff/ui' || pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (pathname === '/staff/auth/session') {
      return sendJson(res, 200, {
        success: true,
        auth_required: false,
        role: 'owner',
        email: null,
        display_name: null,
        clients: getAccessibleClients(null),
        client_profiles: buildClientProfilesMap(null),
        can_use_owner_insights: true,
      });
    }
    if (pathname.startsWith('/staff/assets/')) {
      res.writeHead(204);
      return res.end();
    }
    if (pathname.startsWith('/staff/')) {
      return sendJson(res, 200, {
        success: true,
        rows: [],
        conversations: [],
        offerings: [],
        services: [],
        days: [],
        counts: {},
        numbers: [],
        prompts: [],
      });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
}

async function dumpBootDiagnostics(page, consoleErrors, pageErrors, failedReqs) {
  let snap = {};
  try {
    snap = await page.evaluate(() => {
      const sel = document.getElementById('c-client');
      return {
        href: location.href,
        bodyClass: document.body ? document.body.className : null,
        title: document.title,
        clientOptions: sel ? [...sel.options].map((o) => o.value) : [],
        clientValue: sel ? sel.value : null,
        visibleText: (document.body && document.body.innerText || '').slice(0, 800),
      };
    });
  } catch (err) {
    snap = { evaluateError: String(err && err.message || err) };
  }
  console.error('BOOT DIAGNOSTICS');
  console.error(JSON.stringify({
    snap,
    consoleErrors,
    pageErrors,
    failedReqs,
  }, null, 2));
}

async function openLunaStaff(page, consoleErrors, pageErrors, failedReqs) {
  try {
    await page.waitForFunction(() => {
      const select = document.getElementById('c-client');
      return document.body
        && !document.body.classList.contains('portal-profile-pending')
        && select
        && select.value === 'wolfhouse-somo';
    }, null, { timeout: 30000 });
  } catch (err) {
    await dumpBootDiagnostics(page, consoleErrors, pageErrors, failedReqs);
    throw err;
  }

  const lodgingLuna = page.locator('#wh-admin-tab-luna-staff');
  if (await lodgingLuna.count()) {
    await page.locator('button.tab-btn[data-tab="admin"]').click();
    await page.waitForSelector('#tab-admin.tab-panel.active', { timeout: 20000 });
    await lodgingLuna.click();
  } else {
    await page.locator('button.tab-btn[data-tab="ask-luna"]').click();
  }

  await page.waitForFunction(() => {
    const card = document.getElementById('cc-owner-schedule-bridge');
    if (!card) return false;
    const st = window.getComputedStyle(card);
    const r = card.getBoundingClientRect();
    return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 8 && r.height > 8;
  }, null, { timeout: 20000 });
}

function visible(page, sel) {
  return page.locator(sel).evaluate((n) => {
    const r = n.getBoundingClientRect();
    const st = window.getComputedStyle(n);
    return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  });
}

async function main() {
  console.log('verify-external-calendar-inventory-ui');
  const html = buildHtml();
  assertGeneratedScriptsParse(html);
  ok('generated sheet parser is not a comment regex',
    /new RegExp\('\/spreadsheets\/d\/\(\[a-zA-Z0-9\-_\]\+\)'\)/.test(html)
    && !/match\(\/\/spreadsheets/.test(html));
  ok('generated /staff/ui includes Owner schedule card', /id="cc-owner-schedule-bridge"/.test(html));
  ok('generated empty CTA', /Connect Google Sheet/.test(html));
  ok('hidden wins over osb-actions flex', /#cc-owner-schedule-bridge \[hidden\]\{display:none!important\}/.test(html));
  ok('generated HTML has no SECRET_REF', !/SECRET_REF/.test(html));
  ok('generated save has no secret_ref payload', !/function ownerScheduleBridgeSave\(\)\{[\s\S]{0,400}secret_ref/.test(html));
  ok('generated bed control is a select', /data-osb-bed/.test(html));
  ok('toggle uses ownerScheduleIngestOn', /ownerScheduleBridgeEnable\(!ownerScheduleIngestOn\(conn\)\)/.test(html));
  ok('mapping heading is Match beds from your Sheet', /Match beds from your Sheet/.test(html));
  ok('old unit-matching heading is gone', !/Match sheet units to Luna beds/.test(html));
  ok('mapping explanation mentions colored dates', /colored dates block the correct bed/.test(html));
  ok('Name used in Sheet label is present', /Name used in Sheet/.test(html));
  ok('Luna bed mapping label is present', /Luna bed/.test(html));
  ok('Add bed match button copy', />Add bed match</.test(html) || /Add bed match/.test(html));
  ok('Save bed matches button copy', /Save bed matches/.test(html));
  ok('Sheet shape help disclosure', /How should my Sheet look\?/.test(html));
  ok('help says first column is bed names', /first column/i.test(html) && /bed names/i.test(html));
  ok('help says top row is dates', /top row/i.test(html) && /dates/i.test(html));
  ok('help says colored means booked', /colored/i.test(html) && /booked/i.test(html));
  ok('help says clear means available', /clear/i.test(html) && /available/i.test(html));
  ok('Remove connected Sheet action exists', /Remove connected Sheet/.test(html) && /id="osb-remove"/.test(html));
  ok('staff-facing Match sheet units jargon is gone', !/sheet units to Luna/i.test(html));
  ok('map save still posts external_unit_key payload', /external_unit_key/.test(html));

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
  const fixtureConnections = [
    {
      id: FIRST_ID,
      name: 'Owner schedule · SHEETA',
      status: 'disabled',
      spreadsheet_id: 'sheetAAAAAA',
      sheet_name: 'inventory',
      has_secret: true,
    },
    {
      id: SECOND_ID,
      name: 'Owner schedule · SHEETB',
      status: 'pending',
      spreadsheet_id: 'sheetBBBBBB',
      sheet_name: 'inventory',
      has_secret: true,
    },
  ];
  let connections = [];
  const mapsById = {
    [FIRST_ID]: [
      { external_unit_key: 'R1A', bed_id: 'bed-live-1' },
      { external_unit_key: 'OLD', bed_id: 'bed-gone' },
    ],
    [SECOND_ID]: [],
  };
  let failList = false;
  let failDelete = false;
  const posts = [];
  const consoleErrors = [];
  const pageErrors = [];
  const failedReqs = [];

  const server = createPortalServer(html);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem('staff_portal_client', 'wolfhouse-somo');
      localStorage.setItem('wh_staff_portal_locale', 'en');
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));
    page.on('requestfailed', (req) => {
      failedReqs.push({ url: req.url(), error: req.failure() && req.failure().errorText });
    });
    page.on('response', (res) => {
      if (res.status() >= 400) failedReqs.push({ url: res.url(), status: res.status() });
    });
    await page.route('**/staff/tour-operator/rooms**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(rooms),
    }));
    await page.route('**/staff/luna-staff/calendar-bridge**', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const method = req.method();
      let body = {};
      if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
        try { body = req.postDataJSON() || {}; } catch (_) { body = {}; }
        posts.push({ path: u.pathname, method, body, id: u.searchParams.get('id') });
      }
      if (u.pathname === '/staff/luna-staff/calendar-bridge' && method === 'GET') {
        if (failList) {
          return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'calendar_bridge_failed' }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, connections }) });
      }
      if (u.pathname === '/staff/luna-staff/calendar-bridge/maps' && method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, maps: mapsById[u.searchParams.get('id')] || [] }) });
      }
      if (u.pathname === '/staff/luna-staff/calendar-bridge/sync') {
        posts.push({ path: u.pathname, method, body: {} });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      if (u.pathname === '/staff/luna-staff/calendar-bridge' && method === 'DELETE') {
        if (failDelete) {
          return route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, error: 'delete_failed' }),
          });
        }
        const id = u.searchParams.get('id');
        connections = connections.filter((c) => c.id !== id);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, deleted: true, connection: { id } }),
        });
      }
      if (u.pathname === '/staff/luna-staff/calendar-bridge' && method === 'POST') {
        const saved = {
          id: '33333333-3333-3333-3333-333333333333',
          name: body.name || 'Owner schedule',
          status: 'disabled',
          spreadsheet_id: body.spreadsheet_id,
          sheet_name: body.sheet_name || 'inventory',
          has_secret: false,
        };
        connections.push(saved);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, connection: saved }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, connection: connections[0] }) });
    });
    await page.goto(origin + '/staff/ui', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await openLunaStaff(page, consoleErrors, pageErrors, failedReqs);

    ok('card is truly visible after Luna Staff navigation', await visible(page, '#cc-owner-schedule-bridge'));
    await page.waitForFunction(() => {
      const wrap = document.getElementById('osb-primary-actions');
      const empty = document.getElementById('osb-empty');
      const btn = document.getElementById('osb-new');
      return wrap && empty && btn && !wrap.hasAttribute('hidden') && !empty.hasAttribute('hidden')
        && btn.offsetParent !== null;
    });
    ok('Connect is visible only on the empty state', await visible(page, '#osb-new'));
    await page.screenshot({ path: path.join(SHOT_DIR, 'osb-empty.png') });

    const rest = await page.evaluate(() => {
      const card = document.getElementById('cc-owner-schedule-bridge');
      const r = card.getBoundingClientRect();
      return {
        secretVisible: /SECRET_REF/.test(card.innerText),
        jsonVisible: /Bed maps JSON/.test(card.innerText),
        overflow: card.scrollWidth > card.clientWidth + 1,
        width: r.width,
        emptyText: document.getElementById('osb-empty').innerText,
      };
    });
    ok('rest does not show SECRET_REF or JSON', rest.secretVisible === false && rest.jsonVisible === false);
    ok('empty state copy is isolated', /No Google Sheet is connected yet/.test(rest.emptyText));
    ok('desktop empty card does not overflow', rest.overflow === false && rest.width > 200);
    ok('load/render issued no sync calls', posts.every((p) => p.path !== '/staff/luna-staff/calendar-bridge/sync'));
    ok('load issued no probe, enable, or delete', posts.every((p) =>
      p.path.indexOf('/probe') < 0 && p.path.indexOf('/enable') < 0 && p.method !== 'DELETE'));

    await page.locator('#osb-new').click();
    await page.waitForFunction(() => !document.getElementById('osb-editor').hasAttribute('hidden'));
    ok('Connect Google Sheet opens the editor', await visible(page, '#osb-sheet'));
    await page.screenshot({ path: path.join(SHOT_DIR, 'osb-editor.png') });

    const beforeInvalid = posts.length;
    await page.fill('#osb-sheet', '');
    await page.locator('#osb-save').click();
    await page.fill('#osb-sheet', 'https://example.com/not-a-sheet');
    await page.locator('#osb-save').click();
    const statusCopy = await page.locator('#osb-status').innerText();
    ok('validation shows safe inline copy', /Paste a Google Sheet URL or ID/.test(statusCopy));
    ok('invalid save does not POST', posts.length === beforeInvalid);

    await page.fill('#osb-sheet', 'https://docs.google.com/spreadsheets/d/AbC_12345678/edit');
    await page.locator('#osb-save').click();
    await page.waitForTimeout(300);
    const savePost = posts.find((p) => p.path === '/staff/luna-staff/calendar-bridge' && p.method === 'POST');
    ok('save journey posted a spreadsheet id', !!(savePost && savePost.body.spreadsheet_id === 'AbC_12345678'));
    ok('save journey never sent secret_ref', !!(savePost && !Object.prototype.hasOwnProperty.call(savePost.body, 'secret_ref')));

    connections = fixtureConnections.slice();
    await page.locator('#osb-refresh').click();
    await page.waitForFunction(() => document.getElementById('osb-connections').options.length >= 3);
    const afterLoad = await page.evaluate(() => ({
      optionCount: document.getElementById('osb-connections').options.length,
      selected: document.getElementById('osb-connections').value,
      selectorVisible: document.getElementById('osb-connections').offsetParent !== null,
      connectVisible: !!(document.getElementById('osb-new') && document.getElementById('osb-new').offsetParent),
    }));
    ok('multiple connections stay selectable', afterLoad.optionCount >= 3 && afterLoad.selectorVisible === true);
    ok('does not silently force the first connection', afterLoad.selected === '');
    ok('Connect is hidden once connections exist', afterLoad.connectVisible === false);

    await page.selectOption('#osb-connections', FIRST_ID);
    await page.waitForFunction(() => document.querySelectorAll('#osb-map-rows .osb-map-row').length >= 2);
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
    ok('historical bed sentinel present', mapped.labels.some((opts) => opts.some((o) => o.unavailable && o.selected && /Unavailable/.test(o.text))));
    ok('live beds are labeled room / bed', mapped.labels[0].some((o) => o.text === 'R1 / A'));
    ok('Update stays off while connection is disabled', mapped.updateDisabled === true);
    ok('disabled connection is Off', mapped.status === 'Off');

    await page.selectOption('#osb-map-rows .osb-map-row [data-osb-bed]', 'bed-live-1');
    await page.locator('#osb-save-maps').click();
    await page.waitForTimeout(200);
    const mapPut = posts.find((p) => p.path === '/staff/luna-staff/calendar-bridge/maps' && p.method === 'PUT');
    ok('map save posts canonical bed ids', !!(mapPut && Array.isArray(mapPut.body.maps) && mapPut.body.maps.some((m) => m.bed_id === 'bed-live-1')));
    ok('map save has no secret_ref', !!(mapPut && !Object.prototype.hasOwnProperty.call(mapPut.body, 'secret_ref')));

    await page.selectOption('#osb-connections', SECOND_ID);
    await page.waitForTimeout(300);
    const second = await page.evaluate(() => ({
      name: document.getElementById('osb-detail-name').textContent,
      status: document.getElementById('osb-detail-status').textContent,
      updateDisabled: document.getElementById('osb-sync').disabled,
    }));
    ok('second connection is reachable', /SHEETB/.test(second.name));
    ok('Update stays off without valid maps', second.updateDisabled === true);
    ok('pending ingest is On', second.status === 'On');
    const onRemove = await page.evaluate(() => {
      const btn = document.getElementById('osb-remove');
      return { exists: !!btn, disabled: !!(btn && btn.disabled), visible: !!(btn && btn.offsetParent) };
    });
    ok('Remove is disabled while the selected Sheet is On', onRemove.exists && onRemove.disabled === true);

    await page.selectOption('#osb-connections', FIRST_ID);
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.__osbConfirm = false;
      window.confirm = function (msg) {
        window.__lastConfirm = String(msg || '');
        return window.__osbConfirm === true;
      };
    });
    const beforeCancelDelete = posts.filter((p) => p.method === 'DELETE').length;
    await page.locator('#osb-remove').click();
    await page.waitForTimeout(200);
    const cancelMsg = await page.evaluate(() => window.__lastConfirm || '');
    ok('remove confirmation names the connection', /Owner schedule · SHEETA/.test(cancelMsg));
    ok('canceling remove sends zero DELETE', posts.filter((p) => p.method === 'DELETE').length === beforeCancelDelete);

    failDelete = true;
    await page.evaluate(() => { window.__osbConfirm = true; });
    await page.locator('#osb-remove').click();
    await page.waitForTimeout(300);
    const failedDeletes = posts.filter((p) => p.method === 'DELETE');
    ok('confirmed remove DELETEs the selected connection',
      failedDeletes.length === 1
      && failedDeletes[0].id === FIRST_ID
      && failedDeletes[0].body.confirm_name === 'Owner schedule · SHEETA');
    const failUi = await page.evaluate(() => ({
      selected: document.getElementById('osb-connections').value,
      name: document.getElementById('osb-detail-name').textContent,
      status: document.getElementById('osb-status').textContent,
      optionCount: document.getElementById('osb-connections').options.length,
    }));
    ok('failed remove keeps the connected Sheet selected', failUi.selected === FIRST_ID && /SHEETA/.test(failUi.name));
    ok('failed remove shows a staff-readable error', /Could not remove|Last blocks were kept/.test(failUi.status));

    failDelete = false;
    connections = fixtureConnections.slice();
    await page.evaluate(() => { window.__osbConfirm = true; });
    await page.locator('#osb-remove').click();
    await page.waitForTimeout(400);
    const successDeletes = posts.filter((p) => p.method === 'DELETE' && p.id === FIRST_ID);
    ok('successful remove DELETEs only the selected connection', successDeletes.length >= 1);
    const afterRemove = await page.evaluate(() => ({
      options: [...document.getElementById('osb-connections').options].map((o) => o.value),
      selected: document.getElementById('osb-connections').value,
    }));
    ok('successful remove refreshes the selector without the deleted connection',
      afterRemove.options.indexOf(FIRST_ID) < 0 && afterRemove.options.indexOf(SECOND_ID) >= 0);

    await page.screenshot({ path: path.join(SHOT_DIR, 'osb-detail.png') });
    await page.screenshot({ path: path.join(SHOT_DIR, 'osb-light.png') });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    const mobile = await page.evaluate(() => {
      const card = document.getElementById('cc-owner-schedule-bridge');
      const r = card.getBoundingClientRect();
      return {
        overflow: card.scrollWidth > card.clientWidth + 2,
        right: r.right,
        visible: r.width > 8 && r.height > 8,
        connectVisible: !!(document.getElementById('osb-new') && document.getElementById('osb-new').offsetParent),
      };
    });
    ok('narrow viewport keeps the card on screen', mobile.visible && mobile.right <= 390 && mobile.overflow === false);
    ok('narrow detail does not show Connect', mobile.connectVisible === false);
    await page.screenshot({ path: path.join(SHOT_DIR, 'osb-narrow.png') });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({ path: path.join(SHOT_DIR, 'osb-dark.png') });

    failList = true;
    await page.locator('#osb-refresh').click();
    await page.waitForFunction(() => !document.getElementById('osb-load-error').hasAttribute('hidden'));
    const failState = await page.evaluate(() => ({
      text: document.getElementById('osb-load-error').innerText,
      connectVisible: !!(document.getElementById('osb-new') && document.getElementById('osb-new').offsetParent),
    }));
    ok('load failure does not show the empty connect lie', /Could not load/.test(failState.text));
    ok('Connect is hidden on load failure', failState.connectVisible === false);

    ok('browser never posted secret_ref', posts.every((p) => !Object.prototype.hasOwnProperty.call(p.body || {}, 'secret_ref')));
    ok('no sync during the whole load/save/map journey except explicit Update',
      posts.filter((p) => p.path === '/staff/luna-staff/calendar-bridge/sync').length === 0);
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
