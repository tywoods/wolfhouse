#!/usr/bin/env node
'use strict';

/** Browser evidence for INBOX-DELETE-THEN-MOBILE-001.
 * Uses the real generated /staff/ui fixture and Playwright screenshots at
 * desktop + required phone widths (360/390/430).
 */

const fs = require('fs');
const path = require('path');
const {
  buildPortalHtml,
  startFixtureServer,
  loadPlaywright,
  openInbox,
  CONV_ID,
  SETTLE_MS,
} = require('./verify-inbox-columns-playwright');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'inbox-delete-mobile-001-viewports');

function assert(label, cond, detail) {
  if (!cond) throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
  console.log('PASS', label);
}

async function cardDeleteState(page) {
  return page.evaluate((id) => {
    const card = document.querySelector(`#conv-list .conv-card[data-id="${id}"]`);
    const btn = card && card.querySelector('.conv-card-delete');
    const name = card && card.querySelector('.conv-card-name');
    const header = card && card.querySelector('.conv-card-header-row');
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      return {
        display: cs.display,
        visibility: cs.visibility,
        opacity: Number(cs.opacity),
        width: Math.round(b.width),
        height: Math.round(b.height),
        left: Math.round(b.left),
        right: Math.round(b.right),
        top: Math.round(b.top),
        bottom: Math.round(b.bottom),
      };
    };
    const activeTab = document.querySelector('.tab-panel.active')?.id || null;
    return {
      activeTab,
      card: r(card),
      btn: r(btn),
      name: r(name),
      header: r(header),
      aria: btn && btn.getAttribute('aria-label'),
      tabIndex: btn && btn.tabIndex,
    };
  }, CONV_ID);
}

async function main() {
  const playwright = loadPlaywright();
  assert('Playwright available', playwright);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const { server, base } = await startFixtureServer(buildPortalHtml());
  const browser = await playwright.chromium.launch({ headless: true });
  const evidence = {};
  try {
    const page = await browser.newPage();

    // Desktop regression: hidden until hover/focus, then visible beside guest name.
    await page.setViewportSize({ width: 1365, height: 900 });
    await openInbox(page, base);
    let desktop = await cardDeleteState(page);
    assert('desktop starts on Inbox after explicit tab open', desktop.activeTab === 'tab-conversations', desktop.activeTab);
    assert('desktop delete glyph exists and is keyboard focusable', desktop.aria === 'Delete conversation permanently' && desktop.tabIndex === 0, JSON.stringify(desktop));
    assert('desktop delete glyph is hidden before row hover', desktop.btn.display.includes('flex') && desktop.btn.opacity < 0.1, JSON.stringify(desktop.btn));
    await page.hover(`#conv-list .conv-card[data-id="${CONV_ID}"]`);
    await page.waitForTimeout(SETTLE_MS);
    desktop = await cardDeleteState(page);
    assert('desktop hover reveals delete glyph', desktop.btn.opacity > 0.9, JSON.stringify(desktop.btn));
    assert('desktop delete glyph sits in the guest-name header row', desktop.btn.left > desktop.name.left && desktop.btn.right <= desktop.header.right + 2 && Math.abs(desktop.btn.top - desktop.name.top) <= 12, JSON.stringify({ header: desktop.header, name: desktop.name, btn: desktop.btn }));
    await page.focus(`#conv-list .conv-card[data-id="${CONV_ID}"] .conv-card-delete`);
    await page.waitForTimeout(SETTLE_MS);
    desktop = await cardDeleteState(page);
    assert('desktop keyboard focus keeps delete glyph visible', desktop.btn.opacity > 0.9, JSON.stringify(desktop.btn));
    await page.screenshot({ path: path.join(OUT_DIR, 'desktop-1365-hover-focus.png'), fullPage: false });
    evidence.desktop1365 = desktop;

    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await openInbox(page, base);
      await page.click('#inbox-mobile-back');
      await page.waitForTimeout(SETTLE_MS);
      const m = await cardDeleteState(page);
      assert(`${width}px stays on Inbox list after mobile back`, m.activeTab === 'tab-conversations', m.activeTab);
      assert(`${width}px delete glyph persists on touch layout`, m.btn.display.includes('flex') && m.btn.opacity >= 0.6, JSON.stringify(m.btn));
      assert(`${width}px delete tap target is usable`, m.btn.width >= 44 && m.btn.height >= 44, JSON.stringify(m.btn));
      assert(`${width}px delete glyph remains in the guest-name header`, m.btn.left > m.name.left && m.btn.right <= m.header.right + 10 && m.btn.top <= m.header.bottom + 8, JSON.stringify({ header: m.header, name: m.name, btn: m.btn }));
      await page.screenshot({ path: path.join(OUT_DIR, `phone-${width}-list-delete.png`), fullPage: false });
      evidence[`phone${width}`] = m;
    }

    // Landing/deep-link evidence: phone startup should not force Inbox unless ?conversation= is present.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tab-panel.active', { timeout: 15000 });
    const landing = await page.evaluate(() => document.querySelector('.tab-panel.active')?.id || null);
    assert('390px normal landing does not force Inbox', landing !== 'tab-conversations', landing);
    evidence.normalPhoneLanding = landing;

    await page.goto(`${base}/staff/ui?conversation=${encodeURIComponent(CONV_ID)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tab-conversations.active', { timeout: 15000 });
    const deep = await page.evaluate(() => document.querySelector('.tab-panel.active')?.id || null);
    assert('390px conversation deep link still lands in Inbox', deep === 'tab-conversations', deep);
    evidence.deepLinkLanding = deep;

    const evidencePath = path.join(OUT_DIR, 'evidence.json');
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(`EVIDENCE ${evidencePath}`);
    console.log(`SCREENSHOTS ${OUT_DIR}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
