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
    await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body.luna-header-ui.luna-hdr-compact #nav-menu-toggle', { timeout: 15000 });

    const initial = await page.evaluate(() => ({
      compact: document.body.classList.contains('luna-hdr-compact'),
      bannerHeight: Math.round(document.getElementById('banner').getBoundingClientRect().height),
    }));
    if (!initial.compact) throw new Error(`compact is not the default: ${JSON.stringify(initial)}`);
    if (initial.bannerHeight !== 0) throw new Error(`compact top bar is still visible: ${JSON.stringify(initial)}`);

    const cockpit = page.locator('#ps-day-cockpit');
    if (await cockpit.isVisible()) {
      await page.waitForSelector('#ps-day-cockpit .ck-bar__right #nav-menu-toggle', { timeout: 15000 });
      const docked = await page.evaluate(() => {
        const card = document.getElementById('ps-day-cockpit').getBoundingClientRect();
        const button = document.getElementById('nav-menu-toggle').getBoundingClientRect();
        return {
          parentClass: document.getElementById('nav-menu-toggle').parentElement.className,
          insideCard: button.left >= card.left && button.right <= card.right
            && button.top >= card.top && button.bottom <= card.bottom,
          nearTopRight: Math.abs(card.right - button.right) <= 24 && (button.top - card.top) <= 24,
        };
      });
      if (!docked.insideCard || !docked.nearTopRight) {
        throw new Error(`hamburger is not docked at schedule card top-right: ${JSON.stringify(docked)}`);
      }
      console.log(`PASS hamburger docked in schedule card top-right: ${JSON.stringify(docked)}`);
    }

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
