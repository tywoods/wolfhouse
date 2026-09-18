#!/usr/bin/env node
'use strict';

/**
 * MOBILE-PEOPLE-ORDER-FIX-001
 * Proves the phone Inbox/People stack paints in this order:
 * filter rail -> search -> conversation/contact list -> Luna Autonomy.
 */
const fs = require('fs');
const path = require('path');
const {
  buildPortalHtml,
  startFixtureServer,
  loadPlaywright,
  SETTLE_MS,
} = require('./verify-inbox-columns-playwright');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'mobile-people-order');
const WIDTHS = [360, 390, 430];
let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : `  (${detail})`}`); }
}

function sourceAssertions() {
  const shell = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-shell.js'), 'utf8');
  ok('mobile order sync is exposed for tab switches/resizes',
    shell.includes('window.__syncInboxMobileOrder = inboxShellSyncMobileLayout')
    && shell.includes("window.__syncCustomersMobileAutonomy = inboxShellSyncMobileLayout"));
  ok('mobile Inbox search is moved before the list card',
    /shell\.insertBefore\(wrap, list\)/.test(shell)
    && /wrap\.classList\.add\('is-inbox-mobile-order'\)/.test(shell));
  ok('mobile Luna card is moved after the list card',
    /inboxList\.insertAdjacentElement\('afterend', card\)/.test(shell)
    && /card\.classList\.add\('is-inbox-mobile-docked'\)/.test(shell));
  ok('mobile grid has rows for filter, search, list, Luna',
    shell.includes('grid-template-rows:auto auto minmax(0,1fr) auto!important'));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  sourceAssertions();
  const playwright = loadPlaywright();
  if (!playwright) throw new Error('Playwright is unavailable; run npm ci first');
  const { server, base } = await startFixtureServer(buildPortalHtml());
  const browser = await playwright.chromium.launch({ headless: true });
  const evidence = {};
  try {
    for (const width of WIDTHS) {
      for (const theme of ['light', ...(width === 390 ? ['dark'] : [])]) {
        const page = await browser.newPage();
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof window.switchToTab === 'function', null, { timeout: 15000 });
        await page.evaluate((themeName) => {
          document.documentElement.setAttribute('data-portal-client', 'sunset');
          if (themeName === 'dark') {
            document.documentElement.setAttribute('data-theme', 'dark');
            localStorage.setItem('staffTheme', 'dark');
          } else {
            document.documentElement.removeAttribute('data-theme');
            localStorage.setItem('staffTheme', 'light');
          }
          window.switchToTab('conversations');
          const rail = document.getElementById('inbox-views-rail');
          if (rail) {
            rail.innerHTML = '<div class="inbox-views-group"><button type="button" class="inbox-views-item is-active"><span>People</span><span class="inbox-views-item-count">2</span></button></div>';
          }
          const list = document.getElementById('conv-list');
          if (list) {
            list.innerHTML = '<button class="conv-card"><span class="conv-card-header-row"><span class="conv-card-name">Ana Mobile QA</span><span class="conv-card-time">now</span></span></button><button class="conv-card"><span class="conv-card-header-row"><span class="conv-card-name">Berto Mobile QA</span><span class="conv-card-time">1m</span></span></button>';
          }
          const shell = document.getElementById('inbox-shell');
          if (shell) shell.classList.remove('show-thread');
          if (window.__syncInboxMobileOrder) window.__syncInboxMobileOrder();
          else if (window.__syncCustomersMobileAutonomy) window.__syncCustomersMobileAutonomy();
        }, theme);
        await page.waitForTimeout(SETTLE_MS);
        const metric = await page.evaluate(() => {
          const rect = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const b = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height, display: cs.display, text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) };
          };
          const parentId = (sel) => {
            const el = document.querySelector(sel);
            return el && el.parentElement ? (el.parentElement.id || el.parentElement.className || el.parentElement.tagName) : null;
          };
          return {
            viewport: innerWidth,
            bodyScrollW: document.documentElement.scrollWidth,
            filter: rect('#inbox-views-rail'),
            search: rect('#tab-conversations .inbox-conv-search-wrap'),
            list: rect('#inbox-card'),
            rows: rect('#conv-list'),
            autonomy: rect('#tab-conversations #inbox-shell-channel-defaults'),
            searchParent: parentId('#tab-conversations .inbox-conv-search-wrap'),
            autonomyParent: parentId('#tab-conversations #inbox-shell-channel-defaults'),
            shellOrder: Array.from(document.querySelectorAll('#inbox-shell > *')).map((el) => el.id || el.className || el.tagName).filter(Boolean),
          };
        });
        evidence[`${width}-${theme}`] = metric;
        await page.screenshot({ path: path.join(OUT_DIR, `people-order-${width}-${theme}.png`), fullPage: true });
        ok(`${width}px ${theme} has no horizontal overflow`, metric.bodyScrollW <= width, JSON.stringify({ scrollWidth: metric.bodyScrollW, width }));
        ok(`${width}px ${theme} search is a shell row above list`, metric.searchParent === 'inbox-shell' && metric.search && metric.list && metric.search.bottom <= metric.list.top + 1, JSON.stringify(metric));
        ok(`${width}px ${theme} Luna is a shell row below list`, metric.autonomyParent === 'inbox-shell' && metric.autonomy && metric.list && metric.autonomy.top >= metric.list.bottom - 1, JSON.stringify(metric));
        ok(`${width}px ${theme} visual order is filter → search → list → Luna`,
          metric.filter && metric.search && metric.list && metric.autonomy
          && metric.search.top >= metric.filter.bottom - 1
          && metric.list.top >= metric.search.bottom - 1
          && metric.autonomy.top >= metric.list.bottom - 1,
          JSON.stringify({ filter: metric.filter, search: metric.search, list: metric.list, autonomy: metric.autonomy, order: metric.shellOrder }));
        await page.close();
      }
    }
    fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`\nmobile People order screenshots: ${OUT_DIR}`);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
  console.log(`\nverify-mobile-people-order: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err.stack || err); process.exit(1); });
