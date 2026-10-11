'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts/staff-room-fill-archive');
const js = fs.readFileSync(path.join(__dirname, 'browser/staff-room-fill.js'), 'utf8');
const R11 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const envelope = {
  success: true,
  activationStatus: 'connected',
  configured: true,
  policyStatus: 'saved',
  settingsRevision: 'a'.repeat(64),
  catalogRevision: 'b'.repeat(64),
  policy: { contractVersion: 1, fillMode: 'house', roomPriority: [R11, R2], roomPrioritySource: 'custom' },
  suggestedPolicy: { contractVersion: 1, fillMode: 'house', roomPriority: [R11, R2], roomPrioritySource: 'default_numeric' },
  requiresReview: false,
  catalogue: [
    { roomId: R11, roomCode: 'R11', roomNumber: 11, capacity: 4, active: true, label: 'Room 11', genderLabel: 'Mixed', sellingMode: 'per_bed' },
    { roomId: R2, roomCode: 'R2', roomNumber: 2, capacity: 2, active: true, label: 'Room 2', genderLabel: 'Mixed', sellingMode: 'per_bed' },
  ],
  archivedRooms: [],
  legacyNote: 'This order is not the current booking allocator and is not connected to booking placement.',
};

function pageHtml(theme) {
  return `<!doctype html><html data-portal-client="wolfhouse" data-theme="${theme}"><head><meta charset="utf-8"></head><body style="margin:0;background:${theme === 'dark' ? '#1c211e' : '#f6f1e8'};color:${theme === 'dark' ? '#f4efe6' : '#24302a'}">
<button type="button" id="staff-luna-intelligence-toggle" role="switch" aria-checked="false">Off</button>
<div id="staff-room-fill" hidden></div>
<script>${js}</script>
</body></html>`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = http.createServer((req, res) => {
    const theme = new URL(req.url, 'http://127.0.0.1').searchParams.get('theme') || 'light';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(pageHtml(theme));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const shot of [
      { name: 'desktop-light-confirm', width: 1280, theme: 'light' },
      { name: 'mobile-dark-confirm', width: 390, theme: 'dark' },
    ]) {
      const page = await browser.newPage({ viewport: { width: shot.width, height: 900 }, colorScheme: shot.theme });
      await page.route('**/staff/luna-intelligence/room-fill**', async (route) => {
        const url = route.request().url();
        if (url.includes('/archive-check')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, eligible: true, checkFailed: false, blockers: [] }),
          });
          return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope) });
      });
      await page.goto(`http://127.0.0.1:${port}/?theme=${shot.theme}`, { waitUntil: 'networkidle' });
      const x = page.locator('#rf-delete-' + R11);
      if (await x.count() !== 1) throw new Error('missing delete button');
      const box = await x.boundingBox();
      const moves = await page.locator('.rf-row').first().locator('.rf-moves').boundingBox();
      const row = await page.locator('.rf-row').first().boundingBox();
      console.log(JSON.stringify({ shot: shot.name, box, moves, row }));
      const sameLine = box && moves && Math.abs(box.y - moves.y) < 20;
      const separated = sameLine && box.x >= moves.x + moves.width + 16;
      const rightEdge = box && row && box.x + box.width >= row.x + row.width - 8 && (!sameLine || separated);
      if (!separated && !rightEdge) throw new Error('delete control is not separated from the arrows');
      await x.click();
      await page.waitForSelector('#rf-delete-title');
      const title = await page.locator('#rf-delete-title').innerText();
      if (title !== 'Delete Room 11?') throw new Error(title);
      await page.screenshot({ path: path.join(OUT, shot.name + '.png'), fullPage: true });
      await page.keyboard.press('Escape');
      if (await page.locator('#rf-delete-modal').count()) throw new Error('escape did not close');
      await page.close();
    }
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let releaseRestore;
    const restoreBodies = [];
    await page.route('**/staff/luna-intelligence/room-fill**', async (route) => {
      const request = route.request();
      if (request.url().includes('/restore')) {
        const posted = JSON.parse(request.postData() || '{}');
        restoreBodies.push(posted.operationId);
        if (!releaseRestore) await new Promise((resolve) => { releaseRestore = resolve; });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...envelope,
            catalogue: [{ roomId: R11, roomCode: 'R11', roomNumber: 11, capacity: 4, active: true, label: 'Room 11', genderLabel: 'Mixed' }],
            archivedRooms: [],
            policy: { ...envelope.policy, roomPriority: [R11] },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...envelope,
          catalogue: [{ roomId: R2, roomCode: 'R2', roomNumber: 2, capacity: 2, active: true, label: 'Room 2', genderLabel: 'Mixed' }],
          archivedRooms: [{ roomId: R11, roomCode: 'R11', label: 'Room 11', bedCount: 4, archivedAt: '2026-10-10T10:00:00Z', archiveOperationId: 'op-archive-a' }],
          policy: { ...envelope.policy, roomPriority: [R2] },
        }),
      });
    });
    await page.goto(`http://127.0.0.1:${port}/?theme=light`, { waitUntil: 'networkidle' });
    await page.locator('#rf-deleted-rooms').locator('summary').click();
    await page.getByRole('button', { name: 'Restore Room 11' }).click();
    await page.waitForFunction(() => window.__roomFillState && window.__roomFillState.archivePending === true);
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('staff-disclosure-context', { detail: { client: 'sunset', key: 'sunset' } }));
    });
    releaseRestore();
    await page.waitForTimeout(300);
    const leaked = await page.locator('#staff-room-fill').innerText();
    if (leaked.includes('Room 11') && !leaked.includes('Could not load')) {
      throw new Error('late restore painted Wolfhouse rooms after Sunset: ' + leaked.slice(0, 180));
    }
    if (restoreBodies.length !== 1) throw new Error('restore did not send one operation');
    await page.close();

    async function lateLoad(direction, fail) {
      const late = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      let releaseGet;
      const gets = [];
      const archived = {
        ...envelope,
        catalogue: [],
        archivedRooms: [{ roomId: R11, roomCode: 'R11', label: 'Room 11', bedCount: 4, archivedAt: '2026-10-10T10:00:00Z', archiveOperationId: 'op-archive-late' }],
        policy: { ...envelope.policy, roomPriority: [] },
        catalogRevision: 'c'.repeat(64),
      };
      await late.route('**/staff/luna-intelligence/room-fill**', async (route) => {
        const request = route.request();
        const url = request.url();
        if (url.includes('/archive-check')) {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, eligible: true, checkFailed: false, blockers: [] }) });
          return;
        }
        if (url.includes('/archive') && request.method() === 'POST') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...archived, success: true, archiveOperationId: 'op-archive-late' }) });
          return;
        }
        if (url.includes('/restore') && request.method() === 'POST') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope) });
          return;
        }
        gets.push(url);
        if (gets.length === 1) {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(direction === 'restore' ? archived : envelope) });
          return;
        }
        await new Promise((resolve) => { releaseGet = resolve; });
        if (fail) await route.abort();
        else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(direction === 'restore' ? archived : envelope) });
      });
      await late.goto(`http://127.0.0.1:${port}/?theme=light`, { waitUntil: 'networkidle' });
      const loadPromise = late.evaluate(() => window.roomFillLoad());
      await late.waitForFunction(() => window.__roomFillState && window.__roomFillState.loadSequence >= 2);
      if (direction === 'archive') {
        await late.locator('#rf-delete-' + R11).click();
        await late.locator('#rf-delete-confirm').click();
        await late.waitForSelector('#rf-archive-undo');
      } else {
        await late.locator('#rf-deleted-rooms').locator('summary').click();
        await late.getByRole('button', { name: 'Restore Room 11' }).click();
        await late.waitForFunction(() => (window.__roomFillState.server.catalogue || []).some((room) => room.roomId === '11111111-1111-4111-8111-111111111111'));
      }
      const before = await late.evaluate(() => ({
        revision: window.__roomFillState.server.catalogRevision,
        active: (window.__roomFillState.server.catalogue || []).map((room) => room.roomId),
        undo: !!window.__roomFillState.archiveUndo,
      }));
      if (releaseGet) releaseGet();
      await loadPromise.catch(() => {});
      await late.waitForTimeout(200);
      const after = await late.evaluate(() => ({
        revision: window.__roomFillState.server.catalogRevision,
        active: (window.__roomFillState.server.catalogue || []).map((room) => room.roomId),
        undo: !!window.__roomFillState.archiveUndo,
        text: document.getElementById('staff-room-fill').innerText,
      }));
      if (after.revision !== before.revision || after.active.join() !== before.active.join() || after.undo !== before.undo) {
        throw new Error('late GET overwrote ' + direction + ' ' + JSON.stringify({ before, after, fail }));
      }
      if (fail && after.text.includes('Could not load room placement')) throw new Error('late GET failure wiped ' + direction);
      await late.close();
    }
    await lateLoad('archive', false);
    await lateLoad('archive', true);
    await lateLoad('restore', false);
    await lateLoad('restore', true);

    const retryPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const archivePosts = [];
    await retryPage.route('**/staff/luna-intelligence/room-fill**', async (route) => {
      const request = route.request();
      if (request.url().includes('/archive-check')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, eligible: true, checkFailed: false, blockers: [] }) });
        return;
      }
      if (request.url().includes('/archive') && request.method() === 'POST') {
        archivePosts.push(request.postData());
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'server' }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope) });
    });
    await retryPage.goto(`http://127.0.0.1:${port}/?theme=light`, { waitUntil: 'networkidle' });
    await retryPage.locator('#rf-delete-' + R11).click();
    await retryPage.locator('#rf-delete-confirm').click();
    await retryPage.waitForSelector('#rf-archive-retry');
    const retryDisabled = await retryPage.locator('#rf-archive-retry').isDisabled();
    const deleteDisabled = await retryPage.locator('#rf-delete-confirm').isDisabled();
    if (retryDisabled || !deleteDisabled) throw new Error('500 recovery controls are wrong');
    await retryPage.evaluate(() => { window.__roomFillState.server.catalogRevision = 'd'.repeat(64); });
    await retryPage.locator('#rf-archive-retry').click();
    await retryPage.waitForFunction(() => window.__roomFillState && window.__roomFillState.archivePending === false);
    if (archivePosts.length < 2 || archivePosts[0] !== archivePosts[1]) {
      throw new Error('retry did not resend the frozen payload ' + JSON.stringify(archivePosts));
    }
    await retryPage.close();
    console.log(JSON.stringify({ ok: true, out: OUT, restoreOperationId: restoreBodies[0], lateLoads: 4, frozenRetry: true }));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
