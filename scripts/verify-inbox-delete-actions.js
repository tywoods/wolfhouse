#!/usr/bin/env node
'use strict';

/**
 * Browser proof for INBOX-DELETE-X-BROKEN-001.
 * Verifies both delete entry points against the generated Staff UI fixture:
 * - list hover-X confirms and DELETEs the row
 * - full/thread-view Delete confirms and DELETEs the selected conversation
 * - after a list refresh, deleted rows stay gone and no browser errors appear
 */

const fs = require('fs');
const path = require('path');
const {
  buildPortalHtml,
  startFixtureServer,
  loadPlaywright,
  CONV_ID,
  CONV_ID_2,
  SETTLE_MS,
} = require('./verify-inbox-columns-playwright');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'inbox-delete-x-broken-001');

function assert(label, cond, detail) {
  if (!cond) throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
  console.log('PASS', label);
}

async function openInboxList(page, base) {
  await page.addInitScript(() => {
    try { window.localStorage.setItem('wh_staff_portal_locale', 'en'); } catch (_e) { /* ignore */ }
  });
  await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inbox-shell', { state: 'attached', timeout: 15000 });
  await page.evaluate(() => {
    const btn = document.querySelector('.tab-btn[data-tab="conversations"]');
    if (btn) btn.click();
  });
  await page.waitForSelector('#tab-conversations.active', { timeout: 15000 });
  await page.waitForSelector('#conv-list .conv-card', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(SETTLE_MS);
}

async function rowExists(page, convId) {
  return page.evaluate((id) => !!document.querySelector(`#conv-list .conv-card[data-id="${id}"]`), convId);
}

async function openConversation(page, convId) {
  await page.evaluate((id) => {
    const card = document.querySelector(`#conv-list .conv-card[data-id="${id}"]`);
    if (card) card.click();
  }, convId);
  await page.waitForSelector('.detail-main', { timeout: 15000 });
  await page.waitForSelector('#btn-inbox-conv-delete', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(SETTLE_MS);
}

async function withFixture(browser, fn) {
  const { server, base } = await startFixtureServer(buildPortalHtml());
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const evidence = { deletes: [], consoleErrors: [] };
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/EventSource's response has a MIME type/.test(text)) return;
    evidence.consoleErrors.push(text);
  });
  page.on('pageerror', (err) => evidence.consoleErrors.push(err.message));
  page.on('dialog', async (dialog) => {
    evidence.lastConfirm = dialog.message();
    await dialog.accept();
  });
  page.on('request', (req) => {
    if (req.method() === 'DELETE' && /\/staff\/conversations\//.test(req.url())) {
      evidence.deletes.push(req.url());
    }
  });
  try {
    await fn({ page, base, evidence });
    return evidence;
  } finally {
    await context.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const playwright = loadPlaywright();
  assert('Playwright available', playwright);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await playwright.chromium.launch({ headless: true });
  const allEvidence = {};
  try {
    allEvidence.hoverX = await withFixture(browser, async ({ page, base, evidence }) => {
      await openInboxList(page, base);
      assert('list initially includes hover-X target row', await rowExists(page, CONV_ID));
      await page.hover(`#conv-list .conv-card[data-id="${CONV_ID}"]`);
      await page.click(`#conv-list .conv-card[data-id="${CONV_ID}"] .conv-card-delete`);
      await page.waitForTimeout(SETTLE_MS);
      assert('list hover-X sent DELETE request', evidence.deletes.some((u) => u.includes(CONV_ID)), JSON.stringify(evidence.deletes));
      assert('list hover-X row is removed immediately', !(await rowExists(page, CONV_ID)));
      await openInboxList(page, base);
      assert('list hover-X row stays gone after refresh', !(await rowExists(page, CONV_ID)));
      assert('no browser orphan/console errors during hover-X delete', evidence.consoleErrors.length === 0, JSON.stringify(evidence.consoleErrors));
      await page.screenshot({ path: path.join(OUT_DIR, 'hover-x-row-gone-after-refresh.png'), fullPage: false });
    });

    allEvidence.fullView = await withFixture(browser, async ({ page, base, evidence }) => {
      await openInboxList(page, base);
      assert('full/thread-view target row initially exists', await rowExists(page, CONV_ID_2));
      await openConversation(page, CONV_ID_2);
      assert('full/thread-view Delete button is visible', await page.locator('#btn-inbox-conv-delete').isVisible());
      await page.click('#btn-inbox-conv-delete');
      await page.waitForTimeout(SETTLE_MS);
      assert('full/thread-view Delete sent DELETE request', evidence.deletes.some((u) => u.includes(CONV_ID_2)), JSON.stringify(evidence.deletes));
      assert('full/thread-view row is removed immediately', !(await rowExists(page, CONV_ID_2)));
      await openInboxList(page, base);
      assert('full/thread-view row stays gone after refresh', !(await rowExists(page, CONV_ID_2)));
      assert('no browser orphan/console errors during full/thread delete', evidence.consoleErrors.length === 0, JSON.stringify(evidence.consoleErrors));
      await page.screenshot({ path: path.join(OUT_DIR, 'full-view-row-gone-after-refresh.png'), fullPage: false });
    });

    const evidencePath = path.join(OUT_DIR, 'evidence.json');
    fs.writeFileSync(evidencePath, `${JSON.stringify(allEvidence, null, 2)}\n`, 'utf8');
    console.log(`EVIDENCE ${evidencePath}`);
    console.log(`SCREENSHOTS ${OUT_DIR}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
