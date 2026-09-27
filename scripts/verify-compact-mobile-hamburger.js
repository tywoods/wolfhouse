#!/usr/bin/env node
'use strict';

const {
  buildPortalHtml,
  startFixtureServer,
  loadPlaywright,
} = require('./verify-inbox-columns-playwright');

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) throw new Error('Playwright is unavailable; run npm ci first');

  const { server, base } = await startFixtureServer(buildPortalHtml());
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript(() => {
      localStorage.setItem('wh_staff_header_mode', 'compact');
    });
    await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body.luna-header-ui.luna-hdr-compact #nav-menu-toggle', { timeout: 15000 });

    const before = await page.locator('#tabs').evaluate((el) => getComputedStyle(el).display);
    if (before !== 'none') throw new Error(`expected compact mobile menu closed initially, got display=${before}`);

    await page.click('#nav-menu-toggle');
    await page.waitForFunction(() => document.body.classList.contains('nav-menu-open'));

    const state = await page.evaluate(() => {
      const button = document.getElementById('nav-menu-toggle');
      const tabs = document.getElementById('tabs');
      return {
        bodyOpen: document.body.classList.contains('nav-menu-open'),
        expanded: button && button.getAttribute('aria-expanded'),
        tabsDisplay: tabs && getComputedStyle(tabs).display,
        tabsWidth: tabs && Math.round(tabs.getBoundingClientRect().width),
      };
    });

    if (!state.bodyOpen) throw new Error(`hamburger did not set open state: ${JSON.stringify(state)}`);
    if (state.expanded !== 'true') throw new Error(`hamburger aria-expanded is not true: ${JSON.stringify(state)}`);
    if (state.tabsDisplay !== 'flex' || state.tabsWidth <= 0) {
      throw new Error(`compact mobile menu did not become visible: ${JSON.stringify(state)}`);
    }

    console.log(`PASS compact mobile hamburger opens menu: ${JSON.stringify(state)}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
