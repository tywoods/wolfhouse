'use strict';

/**
 * Room placement screen. Local synthetic page only.
 * Proves the UI-only builder, draft cancel/reset, preview wording, and that the
 * research switch remains a separate control.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'artifacts/staff-room-fill/browser'));
const js = fs.readFileSync(path.join(__dirname, 'browser', 'staff-room-fill.js'), 'utf8');
const NOTICE = 'Settings and preview only — not connected to booking placement.';
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';

const envelope = {
  success: true,
  activationStatus: 'not_connected',
  configured: true,
  policyStatus: 'saved',
  policy: {
    contractVersion: 1,
    fillMode: 'house',
    roomPriority: [R1, R2],
    roomPrioritySource: 'custom',
  },
  suggestedPolicy: {
    contractVersion: 1,
    fillMode: 'house',
    roomPriority: [R1, R2],
    roomPrioritySource: 'default_numeric',
  },
  settingsRevision: 'a'.repeat(64),
  catalogRevision: 'b'.repeat(64),
  requiresReview: false,
  removedRoomIds: [],
  unrankedRoomIds: [],
  catalogue: [
    { roomId: R1, roomCode: 'R1', roomNumber: 1, capacity: 4, active: true, label: 'Room 1' },
    { roomId: R2, roomCode: 'R2', roomNumber: 2, capacity: 2, active: true, label: 'Room 2' },
  ],
  legacyNote: 'This order is not the current booking allocator and is not connected to booking placement.',
};

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<button type="button" id="staff-luna-intelligence-toggle" role="switch" aria-checked="false">Off</button>
<div id="staff-room-fill" hidden></div>
<script>${js}</script>
</body></html>`;

function fail(message) {
  console.error('FAIL', message);
  process.exitCode = 1;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await chromium.launch({ headless: true });
  const calls = [];
  try {
    for (const width of [390, 1024]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      let rejectSave = false;
      let holdPreview = false;
      let releasePreview;
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/staff/luna-intelligence/room-fill**', async (route) => {
        const request = route.request();
        calls.push({ width, method: request.method(), url: request.url(), body: request.postData() });
        if (request.method() === 'GET') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope) });
          return;
        }
        if (request.url().endsWith('/preview')) {
          if (holdPreview) await new Promise(resolve => { releasePreview = resolve; });
          const posted = JSON.parse(request.postData() || '{}');
          const mode = posted.draftPolicy && posted.draftPolicy.fillMode === 'room' ? 'room' : 'house';
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              mode,
              source: 'draft',
              reservationCreated: false,
              decision: {
                status: 'placed',
                selected: [{ roomId: R1, roomCode: 'R1', beds: [{ bedCode: 'R1-B1' }] }],
                rationale: [{ code: 'house_lowest_projected_occupancy', text: 'Fill House chose the room with the lowest projected occupancy.' }],
                rooms: [],
              },
            }),
          });
          return;
        }
        if (request.method() === 'PUT') {
          const posted = JSON.parse(request.postData());
          const saved = { ...envelope, policy: { contractVersion: 1, fillMode: posted.fillMode, roomPriority: posted.roomPriority, roomPrioritySource: posted.roomPrioritySource } };
          await route.fulfill({ status: rejectSave ? 409 : 200, contentType: 'application/json', body: JSON.stringify(rejectSave ? { success: false, error: 'stale_settings' } : saved) });
          return;
        }
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false}' });
      });
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
      if (await page.locator('#staff-room-fill-notice').count()) fail(`${width} obsolete banner remains`);
      if (await page.locator('#staff-room-fill .rf-card').count() < 3) fail(`${width} missing placement cards`);
      if (await page.locator('#staff-room-builder').count() !== 1) fail(`${width} missing room builder`);
      if (!(await page.locator('#staff-room-builder').count())) throw new Error('RED: room builder not implemented');
      const beforeBuilder = calls.length;
      await page.locator('#rf-builder-number').fill('12');
      await page.locator('#rf-builder-beds').fill('6');
      await page.locator('input[name="rf-builder-gender"][value="mixed"]').check();
      if (!(await page.locator('#rf-builder-summary').innerText()).includes('Room 12 · 6 beds · Mixed')) fail('live builder summary');
      await page.locator('#rf-builder-add').click();
      if (await page.locator('.rf-draft').count() !== 1) fail('draft not added');
      if (calls.length !== beforeBuilder) fail('builder performed a network request');
      if (await page.locator('#staff-room-fill-list [data-room-id]').count() !== 2) fail('draft leaked into inventory priority');
      await page.locator('#rf-builder-number').fill('01');
      await page.locator('#rf-builder-beds').fill('2');
      await page.locator('input[name="rf-builder-gender"][value="female"]').check();
      await page.locator('#rf-builder-add').click();
      if (await page.locator('.rf-draft').count() !== 1) throw new Error('RED: duplicate inventory room accepted');
      if (!(await page.locator('#rf-builder-error').innerText()).includes('already')) fail('duplicate error missing');
      await page.locator('#rf-builder-number').fill('12');
      await page.locator('#rf-builder-add').click();
      if (await page.locator('.rf-draft').count() !== 1) fail('duplicate draft accepted');
      await page.locator('#rf-builder-number').fill('13');
      for (const value of ['0', '-1', '1.5', '9007199254740992']) {
        await page.locator('#rf-builder-beds').fill(value);
        await page.locator('#rf-builder-add').click();
        if (await page.locator('.rf-draft').count() !== 1) fail('invalid bed count accepted: ' + value);
      }
      await page.getByRole('button', { name: 'Edit draft Room 12', exact: true }).click();
      await page.locator('#rf-builder-beds').fill('4');
      await page.locator('input[name="rf-builder-gender"][value="male"]').check();
      await page.locator('#rf-builder-add').click();
      if (!(await page.locator('.rf-draft').innerText()).includes('4 beds')) fail('draft update failed');
      await page.getByRole('button', { name: 'Remove draft Room 12', exact: true }).click();
      if (await page.locator('.rf-draft').count()) fail('draft removal failed');
      await page.locator('#rf-builder-number').fill('12');
      await page.locator('#rf-builder-beds').fill('6');
      await page.locator('input[name="rf-builder-gender"][value="mixed"]').check();
      await page.locator('#rf-builder-add').click();
      if (calls.length !== beforeBuilder) fail('builder editing wrote to server');
      const research = await page.locator('#staff-luna-intelligence-toggle').innerText();
      if (research !== 'Off') fail(`${width} research switch changed`);
      const book = await page.locator('#staff-room-fill button', { hasText: /^(Book|Reserve)$/ }).count();
      if (book !== 0) fail(`${width} has a booking action`);
      await page.locator('input[value="room"]').check();
      if ((await page.locator('input[value="room"]').isChecked()) !== true) fail(`${width} mode did not draft`);
      await page.locator('#staff-room-fill-cancel').click();
      if ((await page.locator('input[value="house"]').isChecked()) !== true) fail(`${width} cancel did not restore`);
      await page.locator('#staff-room-fill-reset').click();
      const puts = calls.filter((call) => call.width === width && call.method === 'PUT');
      if (puts.length !== 0) fail(`${width} reset or cancel saved`);
      await page.locator('input[name="checkIn"]').fill('2026-10-10');
      await page.locator('input[name="checkOut"]').fill('2026-10-11');
      await page.locator('input[name="partySize"]').fill('2');
      await page.locator('input[value="room"]').check();
      if ((await page.locator('input[name="checkIn"]').inputValue()) !== '2026-10-10') throw new Error('RED: preview fields lost on mode repaint');
      await page.getByRole('button', { name: 'Move Room 2 up', exact: true }).click();
      const firstRowId = () => page.locator('#staff-room-fill-list [data-room-id]').first().getAttribute('data-room-id');
      if (await firstRowId() !== R2) fail('button reorder failed');
      if (!await page.evaluate(() => document.activeElement?.closest('[data-room-id]')?.getAttribute('data-room-id') === '22222222-2222-4222-8222-222222222222')) fail('reorder lost focus');
      await page.keyboard.press('Alt+ArrowDown');
      if (await firstRowId() !== R1) fail('keyboard reorder failed');
      await page.locator(`[data-room-id="${R2}"] .rf-handle`).dragTo(page.locator(`[data-room-id="${R1}"]`));
      if (await firstRowId() !== R2) fail('drag reorder failed');
      if ((await page.locator('input[name="partySize"]').inputValue()) !== '2') fail('party size lost on reorder');
      await page.locator('#staff-room-fill-cancel').click();
      if (await page.locator('.rf-draft').count() !== 1) fail('settings cancel erased room drafts');
      await page.locator('#staff-room-fill-preview-form button[type="submit"]').click();
      await page.waitForFunction(() => {
        const node = document.getElementById('staff-room-fill-preview-out');
        return node && node.innerText.indexOf('Mode:') >= 0;
      });
      const preview = await page.locator('#staff-room-fill-preview-out').innerText();
      if (!preview.includes('Mode: house') || !preview.includes('Source: draft') || !preview.includes('Preview only · no beds reserved.') || preview.includes(NOTICE)) {
        fail(`${width} preview copy ${preview}`);
      }
      if (/reservation created|booked/i.test(preview)) fail(`${width} preview claims a booking`);
      if (!(await page.locator('.rf-preview-room .rf-pebble').count())) throw new Error('RED: preview has no room/bed chips');
      const payload = JSON.parse(calls.filter(c => c.width === width && c.method === 'POST').at(-1).body);
      if (JSON.stringify(payload.draftPolicy.roomPriority) !== JSON.stringify([R1, R2]) || payload.partySize !== 2) fail('preview payload leaked drafts or lost values');
      holdPreview = true;
      const requestPending = page.waitForRequest('**/room-fill/preview');
      await page.locator('#rf-preview-run').click();
      await requestPending;
      await page.locator('input[name="partySize"]').fill('3');
      const responsePending = page.waitForResponse('**/room-fill/preview');
      releasePreview();
      await responsePending;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if ((await page.locator('#staff-room-fill-preview-out').innerText()).trim()) fail('obsolete preview response was shown');
      holdPreview = false;
      await page.locator('input[value="room"]').check();
      await page.locator('#staff-room-fill-save').click();
      await page.waitForFunction(() => document.querySelector('#staff-room-fill-status').textContent.includes('Placement settings saved'));
      const saved = JSON.parse(calls.filter(c => c.width === width && c.method === 'PUT').at(-1).body);
      if (saved.expectedSettingsRevision !== envelope.settingsRevision || saved.expectedCatalogRevision !== envelope.catalogRevision || saved.fillMode !== 'room' || saved.roomPriority.length !== 2 || 'drafts' in saved) fail('save contract changed');
      if (await page.locator('.rf-draft').count() !== 1) fail('save erased builder');
      if (!await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })) fail('reload loses drafts without warning');
      rejectSave = true;
      await page.locator('input[value="house"]').check();
      await page.locator('#staff-room-fill-save').click();
      await page.waitForFunction(() => document.querySelector('#staff-room-fill-status').textContent.includes('Could not save'));
      await page.locator('#staff-room-fill-cancel').click();
      if (!await page.locator('input[value="room"]').isChecked()) fail('failed save overwrote saved settings');
      await page.locator('#rf-preview-run').click();
      await page.waitForFunction(() => document.querySelector('#staff-room-fill-preview-out').textContent.includes('Mode:'));
      if (errors.length) fail('browser errors: ' + errors.join('; '));
      const overflow = await page.locator('#staff-room-fill').evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
      if (!overflow) fail(`${width} room placement overflows`);
      await page.screenshot({ path: path.join(OUT, `room-fill-${width}.png`) });
      page.on('dialog', dialog => dialog.accept());
      await page.reload({ waitUntil: 'networkidle' });
      if (await page.locator('.rf-draft').count()) fail('room drafts unexpectedly persisted across reload');
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  const summary = { calls: calls.length, puts: calls.filter((call) => call.method === 'PUT').length, exit: process.exitCode || 0 };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
