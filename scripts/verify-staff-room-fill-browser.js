'use strict';

/**
 * Room placement screen. Local synthetic page only.
 * Proves the notice, draft cancel/reset, preview wording, and that the
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
      await page.route('**/staff/luna-intelligence/room-fill**', async (route) => {
        const request = route.request();
        calls.push({ width, method: request.method(), url: request.url(), body: request.postData() });
        if (request.method() === 'GET') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope) });
          return;
        }
        if (request.url().endsWith('/preview')) {
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
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false}' });
      });
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
      const notice = await page.locator('#staff-room-fill-notice').innerText();
      if (notice !== NOTICE) fail(`${width} notice ${notice}`);
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
      await page.locator('#staff-room-fill-preview-form button[type="submit"]').click();
      await page.waitForFunction(() => {
        const node = document.getElementById('staff-room-fill-preview-out');
        return node && node.innerText.indexOf('Mode:') >= 0;
      });
      const preview = await page.locator('#staff-room-fill-preview-out').innerText();
      if (!preview.includes('Mode: house') || !preview.includes('Source: draft') || !preview.includes(NOTICE)) {
        fail(`${width} preview copy ${preview}`);
      }
      if (/reservation created|booked/i.test(preview)) fail(`${width} preview claims a booking`);
      const overflow = await page.locator('#staff-room-fill').evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
      if (!overflow) fail(`${width} room placement overflows`);
      await page.screenshot({ path: path.join(OUT, `room-fill-${width}.png`) });
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
