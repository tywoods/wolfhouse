'use strict';
// Production module + intercepted synthetic HTTP. No persistence or auth claim.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const OUT = path.resolve(process.argv[2] || 'artifacts/room-fill-save-lifecycle');
const fixtureSource = fs.readFileSync(path.join(__dirname, 'verify-staff-room-fill-browser.js'), 'utf8');
const fixture = { require, __dirname, process: { argv: [] } };
vm.createContext(fixture);
vm.runInContext(fixtureSource.slice(0, fixtureSource.indexOf('function fail(')) + '\nglobalThis.fixture = { html, envelope };', fixture);
const clone = x => JSON.parse(JSON.stringify(x));
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const report = { boundary: 'module/browser, intercepted HTTP only', cases: [], errors: [], unexpected: [] };
  try {
    for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      page.on('pageerror', e => report.errors.push(e.message));
      page.on('dialog', d => d.accept());
      let mode = 'hold', release, posted;
      const calls = [];
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        calls.push({ method: req.method(), path: url.pathname, body: req.postData() });
        if (url.origin === 'http://room-fill.invalid') {
          if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fixture.fixture.html.replace('<html>', '<html data-theme="' + theme + '">') });
          if (url.pathname.endsWith('/room-fill') && req.method() === 'GET') return route.fulfill({ json: fixture.fixture.envelope });
          if (url.pathname.endsWith('/rooms') && req.method() === 'POST') {
            posted = req.postDataJSON();
            if (mode === 'abort') return route.abort('connectionreset');
            if (mode === 'hold') await new Promise(r => { release = r; });
            const body = clone(fixture.fixture.envelope), id = '12121212-1212-4121-8121-121212121212';
            body.catalogue.push({ roomId: id, roomNumber: posted.roomNumber, roomCode: 'R' + posted.roomNumber, capacity: posted.bedCount, genderLabel: 'Female' });
            body.policy.roomPriority = posted.roomPriority.concat(id);
            body.policy.fillMode = posted.fillMode;
            return route.fulfill({ json: body });
          }
        }
        report.unexpected.push({ method: req.method(), url: req.url() });
        return route.abort();
      });
      const fill = async n => {
        await page.locator('#rf-builder-number').fill(String(n));
        await page.locator('#rf-builder-beds').fill('2');
        await page.locator('[name="rf-builder-gender"][value="female"]').check();
      };
      const state = () => page.evaluate(() => ({ mode: window.__roomFillState.draftMode, order: window.__roomFillState.draftOrder, dirty: window.__roomFillState.dirty }));
      await page.goto('http://room-fill.invalid/');
      await fill(12);
      const before = await state();
      await page.locator('#rf-builder-add').click();
      await page.waitForFunction(() => window.__roomFillState.builder.pending);
      for (const selector of ['[name="staff-room-fill-mode"]', '#staff-room-fill-reset', '#staff-room-fill-cancel', '#staff-room-fill-save', '.rf-handle', '#rf-builder-number', '#rf-builder-beds', '#rf-builder-add']) {
        assert(await page.locator(selector).evaluateAll(nodes => nodes.length > 0 && nodes.every(n => n.disabled)), selector + ' must be fenced while create pending');
      }
      assert(await page.locator('.rf-handle').evaluateAll(nodes => nodes.every(n => !n.draggable)), 'drag cannot start while create pending');
      // Adversarial already-queued DOM events must not bypass the rendered fence.
      await page.locator('[name="staff-room-fill-mode"][value="room"]').evaluate(n => { n.checked = true; n.dispatchEvent(new Event('change')); });
      await page.locator('.rf-row').first().evaluate(n => { n.tabIndex = -1; n.focus(); });
      await page.keyboard.press('Alt+ArrowDown');
      await page.locator('#staff-room-fill-reset').dispatchEvent('click');
      await page.locator('#staff-room-fill-cancel').dispatchEvent('click');
      assert.deepEqual(await state(), before);
      const getCount = calls.filter(x => x.method === 'GET').length;
      await page.evaluate(() => window.roomFillLoad());
      assert.equal(calls.filter(x => x.method === 'GET').length, getCount);
      await page.screenshot({ path: path.join(OUT, 'pending-' + theme + '-' + width + '.png'), fullPage: true });
      assert.equal(typeof release, 'function'); release();
      await page.waitForFunction(() => !window.__roomFillState.builder.pending);
      assert.equal((await state()).mode, before.mode);
      assert.deepEqual((await state()).order.slice(0, before.order.length), before.order);
      assert.match(await page.locator('#staff-room-fill-live').textContent(), /Room 12 saved/);
      for (const editedNumber of ['15', '0']) {
        mode = 'abort';
        await page.reload();
        await fill(14);
        await page.locator('#rf-builder-add').click();
        await page.waitForFunction(() => document.querySelector('#rf-builder-error').textContent.includes('may have changed'));
        const original = clone(posted);
        await page.locator('#rf-builder-number').fill(editedNumber);
        await page.locator('#rf-builder-beds').fill('3');
        await page.locator('[name="rf-builder-gender"][value="male"]').check();
        mode = 'success';
        await page.locator('#rf-builder-add').click();
        await page.waitForFunction(() => document.querySelector('#staff-room-fill-list').textContent.includes('Room 14'), { timeout: 5000 });
        assert.deepEqual(posted, original, 'retry must use immutable original operation');
        assert.match(await page.locator('#staff-room-fill-live').textContent(), /Room 14 saved/, 'announce recovered identity, not new draft');
        assert.equal(await page.locator('#rf-builder-number').inputValue(), editedNumber, 'new draft number preserved');
        assert.equal(await page.locator('#rf-builder-beds').inputValue(), '3');
        assert(await page.locator('[name="rf-builder-gender"][value="male"]').isChecked());
        assert(!await page.locator('#staff-room-fill-save').isDisabled(), 'recovery releases placement fence');
      }
      await page.screenshot({ path: path.join(OUT, 'recovered-' + theme + '-' + width + '.png'), fullPage: true });
      report.cases.push({ width, theme, pending: 'PASS', recovery: 'PASS', calls });
      await context.close();
    }
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.unexpected, []);
    report.passed = true;
    console.log('PASS pending-create placement fences, all widths/themes');
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
