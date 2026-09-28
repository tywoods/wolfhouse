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
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await desktop.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
    await desktop.waitForSelector('body.luna-header-ui.luna-hdr-compact #tabs', { state: 'attached', timeout: 15000 });
    const desktopChrome = await desktop.evaluate(() => {
      const tabs = document.getElementById('tabs');
      const banner = document.getElementById('banner');
      return {
        bannerHeight: Math.round(banner.getBoundingClientRect().height),
        tabsHeight: Math.round(tabs.getBoundingClientRect().height),
        tabsDisplay: getComputedStyle(tabs).display,
        visibleTabCount: Array.from(tabs.querySelectorAll('.tab-btn')).filter((el) => el.getBoundingClientRect().height > 0).length,
      };
    });
    if (desktopChrome.bannerHeight < 48 || desktopChrome.tabsHeight < 48 || desktopChrome.visibleTabCount < 2) {
      throw new Error(`compact desktop primary menu bar is not visible: ${JSON.stringify(desktopChrome)}`);
    }
    console.log(`PASS compact desktop primary menu bar visible: ${JSON.stringify(desktopChrome)}`);
    await desktop.close();

    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body.luna-header-ui.luna-hdr-compact #nav-menu-toggle', { timeout: 15000 });

    const initial = await page.evaluate(() => ({
      compact: document.body.classList.contains('luna-hdr-compact'),
      bannerHeight: Math.round(document.getElementById('banner').getBoundingClientRect().height),
    }));
    if (!initial.compact) throw new Error(`compact is not the default: ${JSON.stringify(initial)}`);
    if (initial.bannerHeight !== 0) throw new Error(`compact mobile top bar is still visible: ${JSON.stringify(initial)}`);

    await page.addStyleTag({ content: '@media(max-width:768px){.ck-bar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-areas:"date date" "nav nav" "range create" "legend legend";gap:10px 8px;padding:16px 12px 12px;align-items:center}.ck-bar .ck-date{grid-area:date;padding-right:54px;align-self:start}.ck-bar__right{display:contents}}' });
    await page.evaluate(() => {
      document.querySelectorAll('.tab-panel.active').forEach((el) => el.classList.remove('active'));
      const home = document.getElementById('tab-portal-home');
      if (home) home.classList.add('active');
      const mount = document.getElementById('ps-day-cockpit');
      mount.className = 'cockpit ps-day-cockpit-host';
      mount.innerHTML = '<div class="ck-bar"><div class="ck-date"><b>September 2026</b><span>Monthly schedule</span></div><div class="ck-bar__right"></div></div>';
      mount.querySelector('.ck-bar').appendChild(document.getElementById('nav-menu-toggle'));
    });
    const cockpit = page.locator('#ps-day-cockpit');
    await cockpit.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForSelector('#ps-day-cockpit .ck-bar > #nav-menu-toggle', { timeout: 15000 });
    const docked = await page.evaluate(() => {
      const card = document.getElementById('ps-day-cockpit').getBoundingClientRect();
      const bar = document.querySelector('#ps-day-cockpit .ck-bar').getBoundingClientRect();
      const headingEl = document.querySelector('#ps-day-cockpit .ck-date b');
      const headingRange = document.createRange();
      headingRange.selectNodeContents(headingEl);
      const heading = headingRange.getBoundingClientRect();
      const button = document.getElementById('nav-menu-toggle').getBoundingClientRect();
      return {
        parentClass: document.getElementById('nav-menu-toggle').parentElement.className,
        insideCard: button.left >= card.left && button.right <= card.right
          && button.top >= card.top && button.bottom <= card.bottom,
        insideBar: button.left >= bar.left && button.right <= bar.right
          && button.top >= bar.top && button.bottom <= bar.bottom,
        nextToHeading: button.left >= heading.right && Math.abs(button.top - heading.top) <= 12,
        heading: { left: Math.round(heading.left), right: Math.round(heading.right), top: Math.round(heading.top) },
        button: { left: Math.round(button.left), right: Math.round(button.right), top: Math.round(button.top) },
      };
    });
    if (!docked.insideCard || !docked.insideBar || !docked.nextToHeading) {
      throw new Error(`hamburger is not inside the schedule card beside the date heading: ${JSON.stringify(docked)}`);
    }
    console.log(`PASS hamburger inside schedule card beside date heading: ${JSON.stringify(docked)}`);

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
