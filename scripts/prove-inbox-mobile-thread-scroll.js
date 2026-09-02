#!/usr/bin/env node
'use strict';

const path = require('path');
const { chromium } = require('playwright');

async function main() {
  const fixture = path.join(__dirname, '..', 'tmp', 'inbox-mobile-thread-scroll-fixture.html');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto('file://' + fixture, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__threadScroll && window.__threadScroll.scrollHeight() > window.__threadScroll.clientHeight());

  const metrics = await page.evaluate(() => ({
    scrollHeight: window.__threadScroll.scrollHeight(),
    clientHeight: window.__threadScroll.clientHeight(),
    scrollTopAfterStick: window.__threadScroll.scrollTop(),
  }));

  await page.evaluate(() => window.__threadScroll.setScrollTop(0));
  const scrollTopAfterUp = await page.evaluate(() => window.__threadScroll.scrollTop());
  await page.evaluate(() => window.__threadScroll.setScrollTop(99999));
  const scrollTopAfterDown = await page.evaluate(() => window.__threadScroll.scrollTop());

  await browser.close();

  const scrollable = metrics.scrollHeight > metrics.clientHeight + 8;
  const stuckToLatest = metrics.scrollTopAfterStick >= metrics.scrollHeight - metrics.clientHeight - 4;
  const canScrollUp = scrollTopAfterUp < metrics.scrollHeight - metrics.clientHeight - 4;
  const canScrollDown = scrollTopAfterDown > scrollTopAfterUp + 8;

  console.log('inbox-mobile-thread-scroll playwright proof @390px');
  console.log(JSON.stringify({ ...metrics, scrollTopAfterUp, scrollTopAfterDown, scrollable, stuckToLatest, canScrollUp, canScrollDown }, null, 2));

  if (!scrollable || !stuckToLatest || !canScrollUp || !canScrollDown) {
    process.exit(1);
  }
}

main().catch(function(err) {
  console.error(err);
  process.exit(1);
});
