'use strict';
// Real browser module, synthetic intercepted HTTP; verifies client CAS ownership.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');
const source = fs.readFileSync(path.join(__dirname, 'verify-staff-room-fill-browser.js'), 'utf8');
const fixture = { require, __dirname, process: { argv: [] } };
vm.createContext(fixture);
vm.runInContext(source.slice(0, source.indexOf('function fail(')) + '\nglobalThis.fixture = { html, envelope };', fixture);
const clone = value => JSON.parse(JSON.stringify(value));
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const dirty of [true, false]) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const saved = clone(fixture.fixture.envelope);
        saved.catalogue[0].genderEditable = true;
        const originalRevision = saved.settingsRevision;
        const originalOrder = saved.policy.roomPriority.slice();
        const writes = [];
        let releaseGender;
        const genderHeld = new Promise(resolve => { releaseGender = resolve; });
        let markStarted;
        const genderStarted = new Promise(resolve => { markStarted = resolve; });
        await context.route('**/*', async route => {
          const req = route.request(), url = new URL(req.url());
          assert.equal(url.origin, 'http://room-fill.invalid');
          if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fixture.fixture.html });
          if (req.method() === 'GET') return route.fulfill({ json: saved });
          const body = req.postDataJSON();
          writes.push(body);
          if (url.pathname.endsWith('/gender')) {
            markStarted();
            await genderHeld;
            saved.catalogue[0].genderLabel = 'Female';
            saved.catalogRevision = 'c'.repeat(64);
            return route.fulfill({ json: saved });
          }
          if (body.expectedSettingsRevision !== saved.settingsRevision) {
            return route.fulfill({ status: 409, json: { success: false, error: 'settings_changed' } });
          }
          saved.policy = { ...saved.policy, fillMode: body.fillMode, roomPriority: body.roomPriority };
          return route.fulfill({ json: saved });
        });
        await page.goto('http://room-fill.invalid/');
        await page.locator('.rf-row').first().waitFor();
        if (dirty) await page.getByRole('button', { name: 'Move Room 1 down', exact: true }).click();
        await page.locator('#rf-builder-number').fill('17');
        await page.locator('[name="checkIn"]').fill('2027-04-01');
        const snapshot = () => page.evaluate(() => ({
          mode: __roomFillState.draftMode, order: __roomFillState.draftOrder,
          source: __roomFillState.source, touched: __roomFillState.touched, dirty: __roomFillState.dirty
        }));
        const before = await snapshot();
        await page.getByRole('combobox', { name: 'Gender for Room 1', exact: true }).selectOption('female');
        await page.getByRole('button', { name: 'Save gender for Room 1', exact: true }).click();
        await genderStarted;
        // Another staff member saves placement while this inventory-only edit is pending.
        saved.settingsRevision = 'd'.repeat(64);
        saved.policy = { ...saved.policy, fillMode: 'room', roomPriority: originalOrder.slice().reverse(), roomPrioritySource: 'custom' };
        releaseGender();
        await page.waitForFunction(() => document.querySelector('.rf-gender-status')?.textContent === 'Saved');
        assert.equal(await page.locator('#rf-builder-number').inputValue(), '17');
        assert.equal(await page.locator('[name="checkIn"]').inputValue(), '2027-04-01');
        assert.equal(await page.evaluate(() => __roomFillState.server.catalogRevision), 'c'.repeat(64));
        if (dirty) {
          assert.deepEqual(await snapshot(), before, 'dirty placement draft must survive gender save');
          assert.equal(await page.evaluate(() => __roomFillState.server.settingsRevision), originalRevision, 'dirty placement keeps original CAS base');
        } else {
          assert.deepEqual(await snapshot(), { mode: 'room', order: saved.policy.roomPriority, source: 'custom', touched: false, dirty: false }, 'clean placement must adopt authoritative policy with its new revision');
          assert.equal(await page.evaluate(() => __roomFillState.server.settingsRevision), saved.settingsRevision);
          assert(await page.locator('[name="staff-room-fill-mode"][value="room"]').isChecked());
          assert.deepEqual(await page.locator('.rf-row').evaluateAll(rows => rows.map(row => row.dataset.roomId)), saved.policy.roomPriority);
        }
        await page.locator('#staff-room-fill-save').click();
        await page.waitForFunction(() => !__roomFillState.pending);
        assert.equal(writes.at(-1).expectedSettingsRevision, dirty ? originalRevision : saved.settingsRevision);
        assert.equal(writes.at(-1).expectedCatalogRevision, 'c'.repeat(64));
        assert.equal(writes.at(-1).fillMode, dirty ? before.mode : 'room');
        assert.deepEqual(writes.at(-1).roomPriority, saved.policy.roomPriority);
        assert.equal(saved.policy.fillMode, 'room', 'placement save must never overwrite concurrent staff policy');
        if (dirty) {
          assert.equal(await page.locator('#staff-room-fill-status').textContent(), 'Could not save room placement. The saved setting was not changed.');
          assert.deepEqual(await snapshot(), before, 'CAS rejection retains dirty draft');
        }
        assert.deepEqual(errors, []);
        console.log('PASS gender-save concurrent placement: ' + (dirty ? 'dirty draft + original CAS base retained; stale save rejected' : 'clean policy + revision adopted; save preserves concurrent placement'));
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
