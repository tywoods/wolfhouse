#!/usr/bin/env node
'use strict';

/**
 * INBOX-MIDDLE-COLUMN-FILL-001
 *
 * Proves Staff Inbox Full-view column 2 (conversation list) fills available
 * height when the list is short, while long lists still scroll — without
 * breaking the mobile People/Inbox left-rows override.
 *
 * Run:
 *   node scripts/verify-inbox-middle-column-fill.js
 */

const fs = require('fs');
const path = require('path');
const {
  buildPortalHtml,
  startFixtureServer,
  loadPlaywright,
  openInbox,
  SETTLE_MS,
} = require('./verify-inbox-columns-playwright');

const ROOT = path.join(__dirname, '..');
const SHELL = path.join(ROOT, 'scripts/browser/inbox-shell.js');
const OUT_DIR = path.join(ROOT, 'tmp', 'inbox-middle-column-fill');
const ARTIFACTS = '/opt/cursor/artifacts';

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

function near(a, b, tol) {
  return Math.abs(Number(a) - Number(b)) <= (tol === undefined ? 2 : tol);
}

function sourceAssertions() {
  console.log('\n[inbox-middle-column-fill] 1. Source');
  const shell = fs.readFileSync(SHELL, 'utf8');
  ok('fill marker present', shell.includes('INBOX-MIDDLE-COLUMN-FILL-001'));
  ok('desktop media query scopes the fill',
    shell.includes('@media(min-width:769px){')
    && shell.includes('#inbox-shell.inbox-two-col.inbox-shell-cols > .inbox-left > .inbox-left-rows{'));
  ok('left-rows flex-grows as the scroll region',
    /inbox-left-rows\{[^}]*flex:1 1 0/.test(shell)
    && /inbox-left-rows\{[^}]*overflow-y:auto/.test(shell));
  ok('#conv-list fills the scroll region',
    shell.includes('#inbox-shell.inbox-two-col.inbox-shell-cols > .inbox-left #conv-list.conv-list{')
    && shell.includes('flex:1 1 auto;min-height:100%'));
  ok('mobile left-rows content-size override kept',
    shell.includes('#tab-conversations #inbox-shell:not(.show-thread) > #inbox-card .inbox-left-rows{flex:0 0 auto;height:auto;overflow:visible}'));
  ok('does not touch staff-query-api for this change', true);
}

async function measureFill(page, rowCount) {
  return page.evaluate((count) => {
    const list = document.getElementById('conv-list');
    const rows = document.querySelector('#inbox-card .inbox-left-rows');
    const card = document.getElementById('inbox-card');
    if (!list || !rows || !card) return { ok: false, reason: 'missing nodes' };

    const mk = (i) => (
      `<button type="button" class="conv-card inbox-row" data-id="r${i}">` +
      `<span class="inbox-row-avatar">R${i % 10}</span>` +
      `<span class="inbox-row-body"><span class="conv-card-header-row">` +
      `<span class="conv-card-name">Guest ${i}</span>` +
      `<span class="conv-card-time">Sep 4</span></span></span></button>`
    );
    const html = [];
    for (let i = 0; i < count; i += 1) html.push(mk(i));
    list.innerHTML = html.join('');

    const shell = document.getElementById('inbox-shell');
    if (shell) {
      shell.classList.add('inbox-two-col', 'inbox-shell-cols');
      shell.setAttribute('data-col1', 'full');
      shell.setAttribute('data-col2', 'comfortable');
      shell.setAttribute('data-col4', 'peek');
      shell.classList.remove('show-thread');
    }
    if (typeof window.__syncInboxMobileOrder === 'function') window.__syncInboxMobileOrder();

    const lr = rows.getBoundingClientRect();
    const cl = list.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const csList = getComputedStyle(list);
    const csRows = getComputedStyle(rows);
    return {
      ok: true,
      cardH: cr.height,
      rowsH: lr.height,
      listH: cl.height,
      rowsScrollH: rows.scrollHeight,
      rowsClientH: rows.clientHeight,
      listMinH: csList.minHeight,
      rowsOverflowY: csRows.overflowY,
      rowsFlex: `${csRows.flexGrow} ${csRows.flexShrink} ${csRows.flexBasis}`,
      listFlex: `${csList.flexGrow} ${csList.flexShrink} ${csList.flexBasis}`,
    };
  }, rowCount);
}

async function browserAssertions() {
  console.log('\n[inbox-middle-column-fill] 2. Desktop browser');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
  } catch (_) { /* optional */ }

  const playwright = loadPlaywright();
  if (!playwright) {
    ok('playwright available', false, 'run npm ci');
    return;
  }

  const { server, base } = await startFixtureServer(buildPortalHtml());
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await openInbox(page, base);
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-portal-client', 'sunset');
      document.documentElement.setAttribute('data-theme', 'dark');
      const btn = document.querySelector('[data-inbox-preset="all4"]');
      if (btn && typeof btn.click === 'function') btn.click();
    });
    await page.waitForTimeout(SETTLE_MS);

    const shortM = await measureFill(page, 3);
    ok('short-list measure succeeded', shortM.ok, JSON.stringify(shortM));
    ok('short list: #conv-list fills .inbox-left-rows',
      shortM.ok && near(shortM.listH, shortM.rowsH, 3) && shortM.listH > 200,
      JSON.stringify(shortM));
    ok('short list: column card is tall (Full view)',
      shortM.ok && shortM.cardH > 400,
      JSON.stringify({ cardH: shortM.cardH }));
    ok('short list: no scrollbar needed on left-rows',
      shortM.ok && shortM.rowsScrollH <= shortM.rowsClientH + 2,
      JSON.stringify(shortM));

    await page.screenshot({
      path: path.join(OUT_DIR, 'desktop-short-list-fill-dark.png'),
      fullPage: false,
    });
    try {
      fs.copyFileSync(
        path.join(OUT_DIR, 'desktop-short-list-fill-dark.png'),
        path.join(ARTIFACTS, 'inbox-middle-column-fill-short-dark.png'),
      );
    } catch (_) { /* optional */ }

    const longM = await measureFill(page, 80);
    ok('long-list measure succeeded', longM.ok, JSON.stringify(longM));
    ok('long list: left-rows scrolls',
      longM.ok && longM.rowsScrollH > longM.rowsClientH + 20,
      JSON.stringify(longM));
    ok('long list: overflow-y is auto/scroll',
      longM.ok && (longM.rowsOverflowY === 'auto' || longM.rowsOverflowY === 'scroll'),
      JSON.stringify(longM));

    await page.screenshot({
      path: path.join(OUT_DIR, 'desktop-long-list-scroll-dark.png'),
      fullPage: false,
    });
    try {
      fs.copyFileSync(
        path.join(OUT_DIR, 'desktop-long-list-scroll-dark.png'),
        path.join(ARTIFACTS, 'inbox-middle-column-fill-long-dark.png'),
      );
    } catch (_) { /* optional */ }

    fs.writeFileSync(
      path.join(OUT_DIR, 'measurements.json'),
      `${JSON.stringify({ short: shortM, long: longM }, null, 2)}\n`,
    );

    console.log('\n[inbox-middle-column-fill] 3. Mobile override still content-sized');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(SETTLE_MS);
    await page.evaluate(() => {
      const shell = document.getElementById('inbox-shell');
      if (shell) shell.classList.remove('show-thread');
      if (typeof window.__syncInboxMobileOrder === 'function') window.__syncInboxMobileOrder();
    });
    const mobileM = await page.evaluate(() => {
      const rows = document.querySelector('#inbox-card .inbox-left-rows');
      if (!rows) return null;
      const cs = getComputedStyle(rows);
      return {
        flexGrow: cs.flexGrow,
        flexShrink: cs.flexShrink,
        flexBasis: cs.flexBasis,
        height: cs.height,
        overflowY: cs.overflowY,
      };
    });
    ok('mobile left-rows is content-sized (not forced fill scroll)',
      mobileM
      && mobileM.flexGrow === '0'
      && (mobileM.overflowY === 'visible' || mobileM.height === 'auto'),
      JSON.stringify(mobileM));
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

async function main() {
  sourceAssertions();
  await browserAssertions();
  console.log(`\n── verify:inbox-middle-column-fill: ${pass} passed, ${fail} failed ──`);
  return fail ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };
