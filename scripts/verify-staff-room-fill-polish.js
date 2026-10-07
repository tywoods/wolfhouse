'use strict';
// Real browser module with intercepted HTTP: no claim of production auth/persistence.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const OUT = path.resolve(process.argv[2] || '../artifacts/staff-ui-polish-006/room-work/browser');
const fixtureSource = fs.readFileSync(path.join(__dirname, 'verify-staff-room-fill-browser.js'), 'utf8');
const fixture = { require, __dirname, process: { argv: [] } };
vm.createContext(fixture);
vm.runInContext(fixtureSource.slice(0, fixtureSource.indexOf('function fail(')) + '\nglobalThis.fixture = { html, envelope };', fixture);
const clone = x => JSON.parse(JSON.stringify(x));
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const report = { cases: [], errors: [], unexpected: [], boundary: 'module with intercepted synthetic HTTP' };
  try {
    for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width === 390, serviceWorkers: 'block' });
      const page = await context.newPage(); page.setDefaultTimeout(5000);
      page.on('pageerror', e => report.errors.push(e.message)); page.on('dialog', d => d.accept());
      let saved = clone(fixture.fixture.envelope);
      saved.catalogue[0].genderEditable = true;
      saved.catalogue[1].genderEditable = false;
      saved.catalogue[1].genderEditNote = 'Read-only: private/couple room restrictions are preserved.';
      const calls = []; let reject = false, hold = false, release, holdGet = false, releaseGet;
      let getHeldResolve; const getHeld = new Promise(resolve => { getHeldResolve = resolve; });
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== 'http://room-fill.invalid') { report.unexpected.push(req.url()); return route.abort(); }
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fixture.fixture.html.replace('<html>', '<html data-theme="' + theme + '">') });
        if (url.pathname.endsWith('/room-fill') && req.method() === 'GET') {
          const body = clone(saved);
          if (holdGet) await new Promise(resolve => { releaseGet = resolve; getHeldResolve(); });
          return route.fulfill({ json: body });
        }
        if (req.method() === 'PUT') {
          const body = req.postDataJSON(); calls.push({ path: url.pathname, body });
          if (hold) await new Promise(resolve => { release = resolve; });
          if (reject) return route.fulfill({ status: 409, json: { success: false, error: 'catalogue_changed' } });
          if (url.pathname.endsWith('/gender')) {
            saved.catalogue[0].genderLabel = body.gender[0].toUpperCase() + body.gender.slice(1);
            saved.catalogRevision = 'c'.repeat(64);
          } else { saved.policy = { ...saved.policy, fillMode: body.fillMode, roomPriority: body.roomPriority }; }
          return route.fulfill({ json: saved });
        }
        report.unexpected.push(req.url()); return route.abort();
      });
      await page.goto('http://room-fill.invalid/');
      await page.locator('.rf-modes label').first().waitFor();
      const geometry = await page.locator('.rf-modes label').evaluateAll(nodes => nodes.map(n => ({ width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height })));
      assert(geometry.every(g => g.width < 180), 'intrinsic fill-mode widths, not expanding cards: ' + JSON.stringify(geometry));
      assert(geometry.every(g => g.height === (width === 390 ? 44 : 32)), '32px desktop / 44px touch fill modes: ' + JSON.stringify(geometry));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      const initialOrder = saved.policy.roomPriority.slice();
      const order = () => page.locator('.rf-row').evaluateAll(nodes => nodes.map(n => n.dataset.roomId));
      const up = page.getByRole('button', { name: 'Move Room 1 up', exact: true });
      const down = page.getByRole('button', { name: 'Move Room 1 down', exact: true });
      assert.equal(await up.textContent(), '↑'); assert.equal(await down.textContent(), '↓');
      assert.equal(await down.getAttribute('title'), 'Move Room 1 down');
      assert(await up.isDisabled()); assert(await page.getByRole('button', { name: 'Move Room 2 down', exact: true }).isDisabled());
      await down.click(); assert.deepEqual(await order(), initialOrder.slice().reverse()); assert.equal(calls.length, 0, 'reorder never autosaves');
      await up.focus(); await page.keyboard.press('Enter'); assert.deepEqual(await order(), initialOrder);
      await page.locator('[name="staff-room-fill-mode"][value="house"]').focus(); await page.keyboard.press('ArrowRight');
      assert(await page.locator('[name="staff-room-fill-mode"][value="room"]').isChecked());
      await down.click(); await page.locator('#staff-room-fill-save').click();
      await page.waitForFunction(() => !window.__roomFillState.pending);
      assert.equal(calls.length, 1); assert.equal(calls[0].body.fillMode, 'room'); assert.deepEqual(calls[0].body.roomPriority, initialOrder.slice().reverse());
      await page.reload(); assert.deepEqual(await order(), initialOrder.slice().reverse());
      assert(await page.locator('[name="staff-room-fill-mode"][value="room"]').isChecked());
      const gender = page.getByRole('combobox', { name: 'Gender for Room 1', exact: true });
      assert.equal(await gender.count(), 1, 'ordinary rooms expose the explicit existing-room gender editor');
      assert.equal(await page.getByRole('combobox', { name: 'Gender for Room 2', exact: true }).count(), 0);
      assert.match(await page.locator('[data-room-id="' + initialOrder[1] + '"]').textContent(), /Read-only.*private\/couple/);
      await page.locator('[name="staff-room-fill-mode"][value="house"]').check();
      await up.click();
      await page.locator('#rf-builder-number').fill('17');
      await page.locator('[name="checkIn"]').fill('2027-04-01');
      const draft = () => page.evaluate(() => ({ mode: __roomFillState.draftMode, order: __roomFillState.draftOrder, dirty: __roomFillState.dirty, source: __roomFillState.source, touched: __roomFillState.touched }));
      const beforeGender = await draft();
      await gender.selectOption('male');
      await page.getByRole('button', { name: 'Cancel gender for Room 1', exact: true }).click();
      assert.equal(await gender.inputValue(), 'mixed'); assert.deepEqual(await draft(), beforeGender); assert.equal(calls.length, 1);
      await gender.selectOption('female'); reject = true;
      await page.getByRole('button', { name: 'Save gender for Room 1', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.rf-gender-status')?.textContent.includes('catalogue_changed'));
      assert.equal(await gender.inputValue(), 'female'); assert.deepEqual(await draft(), beforeGender);
      reject = false; hold = true;
      await page.getByRole('button', { name: 'Save gender for Room 1', exact: true }).click();
      await page.waitForFunction(() => !!__roomFillState.genderPending);
      assert(await page.locator('#staff-room-fill-save').isDisabled()); assert(await gender.isDisabled());
      assert(await page.locator('#rf-builder-add').isDisabled());
      await page.waitForFunction(() => !!__roomFillState.genderPending); assert.equal(typeof release, 'function'); release(); hold = false;
      await page.waitForFunction(() => document.querySelector('.rf-gender-status')?.textContent === 'Saved');
      assert.equal(await gender.inputValue(), 'female'); assert.deepEqual(await draft(), beforeGender);
      assert.equal(await page.locator('#rf-builder-number').inputValue(), '17'); assert.equal(await page.locator('[name="checkIn"]').inputValue(), '2027-04-01');
      assert.equal(calls.at(-1).path, '/staff/luna-intelligence/room-fill/rooms/' + initialOrder[0] + '/gender');
      assert.deepEqual(Object.keys(calls.at(-1).body).sort(), ['expectedCatalogRevision', 'gender']);
      assert.equal(await page.evaluate(() => __roomFillState.server.catalogRevision), 'c'.repeat(64));
      await page.locator('#staff-room-fill-save').click(); await page.waitForFunction(() => !__roomFillState.pending);
      assert.equal(calls.at(-1).body.expectedCatalogRevision, 'c'.repeat(64));
      await page.reload(); assert.equal(await gender.inputValue(), 'female'); assert.deepEqual(await order(), beforeGender.order);
      await page.screenshot({ path: path.join(OUT, 'compact-' + width + '-' + theme + '.png'), fullPage: true });
      // Late gender response cannot paint another admitted context (even switch-away/back).
      await gender.selectOption('male'); hold = true;
      await page.getByRole('button', { name: 'Save gender for Room 1', exact: true }).click();
      await page.waitForFunction(() => !!__roomFillState.genderPending);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('staff-disclosure-context', { detail: { client: 'sunset', key: 'sunset-session' } })));
      assert(await page.locator('#staff-room-fill').isHidden(), 'tenant switch hides stale room inventory immediately');
      assert.equal(typeof release, 'function'); release(); hold = false;
      await page.waitForLoadState('networkidle');
      assert(await page.locator('#staff-room-fill').isHidden());
      assert.equal(await page.locator('.rf-row').count(), 0, 'old tenant rows are removed');
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('staff-disclosure-context', { detail: { client: 'wolfhouse-somo', key: 'wolf-new-session' } })));
      await gender.waitFor(); assert.equal(await gender.inputValue(), 'male', 'fresh authoritative reload on return');
      assert.equal(await page.locator('.rf-gender-status').textContent(), '', 'old Saved status cannot cross sessions');
      holdGet = true; await page.evaluate(() => window.roomFillLoad());
      await getHeld;
      assert.equal(typeof releaseGet, 'function');
      await gender.selectOption('mixed');
      await page.getByRole('button', { name: 'Save gender for Room 1', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.rf-gender-status')?.textContent === 'Saved');
      const staleResponse = page.waitForResponse(res => res.request().method() === 'GET' && res.url().endsWith('/room-fill'));
      releaseGet(); holdGet = false; await (await staleResponse).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => __roomFillState.server.catalogue[0].genderLabel), 'Mixed', 'pre-save GET cannot replace authoritative success');
      report.cases.push({ width, theme, geometry, calls });
      await context.close();
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpected, []);
    report.passed = true; console.log('PASS compact fill modes: 390/1280 light/dark');
  } finally { fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2)); await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
