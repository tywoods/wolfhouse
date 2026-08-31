#!/usr/bin/env node
'use strict';

/**
 * verify-inbox-full-3col-width-playwright
 *
 * Rendered layout gate at 1920×1080. Sea Dog r4: static CSS is not enough.
 *
 * Fails unless:
 *   - Full 3-col and 4-col #wrap.inbox-shell-wrap left AND right edges match
 *   - Full 3-col and 4-col outer #inbox-shell widths are equal
 *   - 3-col .detail-main right edge equals #inbox-guest-restore right edge
 *
 * Stay OFF inbox-thread.js, package.json.
 *
 * Run:
 *   node scripts/verify-inbox-full-3col-width-playwright.js
 */

const path = require('path');
const {
  buildPortalHtml,
  startFixtureServer,
  loadPlaywright,
  openInbox,
  SETTLE_MS,
} = require('./verify-inbox-columns-playwright');

const TOL = 2;

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${label}${detail === undefined ? '' : `  (${detail})`}`);
  return false;
}

function near(a, b, t) {
  return Math.abs(Number(a) - Number(b)) <= (t === undefined ? TOL : t);
}

const MEASURE = () => {
  const rect = (sel) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    const cs = window.getComputedStyle(node);
    return {
      width: Math.round(r.width * 100) / 100,
      left: Math.round(r.left * 100) / 100,
      right: Math.round(r.right * 100) / 100,
      visible: cs.display !== 'none' && cs.visibility !== 'hidden'
        && parseFloat(cs.opacity) > 0.01 && r.width > 0,
    };
  };
  const shell = document.getElementById('inbox-shell');
  const wrap = document.querySelector('#wrap.inbox-shell-wrap');
  const fullBtn = document.querySelector('[data-inbox-preset="all4"]');
  return {
    col4: shell ? shell.getAttribute('data-col4') : null,
    fullPressed: fullBtn ? fullBtn.getAttribute('aria-pressed') : null,
    shell: shell ? {
      width: Math.round(shell.getBoundingClientRect().width * 100) / 100,
      right: Math.round(shell.getBoundingClientRect().right * 100) / 100,
    } : null,
    wrap: wrap ? {
      width: Math.round(wrap.getBoundingClientRect().width * 100) / 100,
      left: Math.round(wrap.getBoundingClientRect().left * 100) / 100,
      right: Math.round(wrap.getBoundingClientRect().right * 100) / 100,
    } : null,
    chat: rect('.detail-main'),
    tab: rect('#inbox-guest-restore'),
  };
};

async function setFullColumn(page, state) {
  await page.evaluate((col4) => {
    const btn = document.querySelector('[data-inbox-preset="all4"]');
    if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
    const api = window.__inboxColumns;
    if (!api || typeof api.setColumn !== 'function') throw new Error('no __inboxColumns');
    api.setColumn('col4', col4);
    if (typeof api.clearPeek === 'function') api.clearPeek();
  }, state);
  await page.waitForTimeout(SETTLE_MS);
}

async function main() {
  console.log('\nverify-inbox-full-3col-width-playwright — 1920×1080 layout\n');

  const playwright = loadPlaywright();
  if (!playwright) {
    console.error('  FAIL  playwright module unavailable');
    return 1;
  }

  const html = buildPortalHtml();
  const { server, base } = await startFixtureServer(html);
  const launchOpts = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const browser = await playwright.chromium.launch(launchOpts);
  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await openInbox(page, base);

    await setFullColumn(page, 'peek');
    const four = await page.evaluate(MEASURE);
    ok('4-col Full is peek with Full pressed',
      four.col4 === 'peek' && four.fullPressed === 'true',
      JSON.stringify({ col4: four.col4, fullPressed: four.fullPressed }));
    ok('4-col shell has a measured width', four.shell && four.shell.width > 1000, four.shell && four.shell.width);

    await setFullColumn(page, 'hidden');
    const three = await page.evaluate(MEASURE);
    ok('3-col Full is hidden with Full pressed',
      three.col4 === 'hidden' && three.fullPressed === 'true',
      JSON.stringify({ col4: three.col4, fullPressed: three.fullPressed }));
    ok('Guest restore tab is visible in 3-col',
      three.tab && three.tab.visible, three.tab);
    ok('3-col chat is visible', three.chat && three.chat.visible, three.chat);

    console.log('  wrap 4-col', four.wrap);
    console.log('  wrap 3-col', three.wrap);

    ok('outer Full wrap left edge is equal in 3-col and 4-col',
      four.wrap && three.wrap && near(four.wrap.left, three.wrap.left, TOL),
      JSON.stringify({ fourLeft: four.wrap && four.wrap.left, threeLeft: three.wrap && three.wrap.left }));
    ok('outer Full wrap right edge is equal in 3-col and 4-col',
      four.wrap && three.wrap && near(four.wrap.right, three.wrap.right, TOL),
      JSON.stringify({ fourRight: four.wrap && four.wrap.right, threeRight: three.wrap && three.wrap.right }));
    ok('outer Full wrap width is equal in 3-col and 4-col',
      four.wrap && three.wrap && near(four.wrap.width, three.wrap.width, TOL),
      JSON.stringify({ four: four.wrap && four.wrap.width, three: three.wrap && three.wrap.width }));

    ok('outer shell width is equal in 3-col and 4-col',
      four.shell && three.shell && near(four.shell.width, three.shell.width, TOL),
      JSON.stringify({ four: four.shell && four.shell.width, three: three.shell && three.shell.width }));

    ok('3-col chat right edge equals Guest tab right edge',
      three.chat && three.tab && near(three.chat.right, three.tab.right, TOL),
      JSON.stringify({
        chatRight: three.chat && three.chat.right,
        tabLeft: three.tab && three.tab.left,
        tabRight: three.tab && three.tab.right,
        shellRight: three.shell && three.shell.right,
      }));

    ok('3-col does not leave a blank 300px hole (tab within 30px of shell right)',
      three.tab && three.shell && (three.shell.right - three.tab.right) < 30,
      JSON.stringify({ shellRight: three.shell && three.shell.right, tabRight: three.tab && three.tab.right }));
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }

  console.log('\n' + '─'.repeat(48));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('verify-inbox-full-3col-width-playwright — FAILED');
    return 1;
  }
  console.log('verify-inbox-full-3col-width-playwright — ALL CHECKS PASSED');
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
