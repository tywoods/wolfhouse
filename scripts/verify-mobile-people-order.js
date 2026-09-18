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
const VIEWPORTS = [
  { width: 360, height: 844 },
  { width: 390, height: 720 },
  { width: 390, height: 844 },
  { width: 430, height: 844 },
];
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
  ok('mobile grid has intrinsic rows for filter, search, list, Luna',
    shell.includes('grid-template-rows:auto auto auto auto!important')
    && shell.includes('#tab-conversations #inbox-shell:not(.show-thread) > #inbox-card .inbox-left-rows{flex:0 0 auto;height:auto;overflow:visible}'));
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
    for (const viewport of VIEWPORTS) {
      const width = viewport.width;
      const height = viewport.height;
      for (const theme of ['light', ...(width === 390 && height === 720 ? ['dark'] : [])]) {
        const page = await browser.newPage();
        await page.setViewportSize({ width, height });
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
            const rowHtml = (id, name, time, chip) => '<button type="button" class="conv-card inbox-row inbox-row-owner-lab" data-mobile-owner-row="' + id + '">' +
              '<span class="inbox-row-body"><span class="conv-card-header-row"><span class="conv-card-name">' + name + '</span><span class="conv-card-time">' + time + '</span></span>' +
              '<span class="conv-card-preview">Owner Lab mobile row should remain selectable.</span>' +
              (chip ? '<span class="inbox-owner-lab-chip">Owner Lab</span>' : '') + '</span></button>';
            list.innerHTML = [
              rowHtml('row-1', 'Ana Mobile QA', 'now', true),
              rowHtml('row-2', 'Berto Mobile QA', '1m', true),
              rowHtml('row-3', 'Carla Mobile QA', '2m', true),
              rowHtml('row-4', 'Guest', '3m', true),
            ].join('');
            window.__mobileOwnerClicked = null;
            list.querySelectorAll('[data-mobile-owner-row]').forEach(function(btn){
              btn.addEventListener('click', function(){ window.__mobileOwnerClicked = btn.getAttribute('data-mobile-owner-row'); });
            });
          }
          const shell = document.getElementById('inbox-shell');
          if (shell) shell.classList.remove('show-thread');
          if (window.__syncInboxMobileOrder) window.__syncInboxMobileOrder();
          else if (window.__syncCustomersMobileAutonomy) window.__syncCustomersMobileAutonomy();
        }, theme);
        await page.waitForTimeout(SETTLE_MS);
        await page.evaluate(() => {
          const list = document.getElementById('conv-list');
          if (!list) return;
          const rowHtml = (id, name, time) => '<button type="button" class="conv-card inbox-row inbox-row-owner-lab" data-mobile-owner-row="' + id + '">' +
            '<span class="inbox-row-body"><span class="conv-card-header-row"><span class="conv-card-name">' + name + '</span><span class="conv-card-time">' + time + '</span></span>' +
            '<span class="conv-card-preview">Owner Lab mobile row should remain selectable.</span>' +
            '<span class="inbox-owner-lab-chip">Owner Lab</span></span></button>';
          list.innerHTML = [
            rowHtml('row-1', 'Ana Mobile QA', 'now'),
            rowHtml('row-2', 'Berto Mobile QA', '1m'),
            rowHtml('row-3', 'Carla Mobile QA', '2m'),
            rowHtml('row-4', 'Guest', '3m'),
          ].join('');
          window.__mobileOwnerClicked = null;
          list.querySelectorAll('[data-mobile-owner-row]').forEach(function(btn){
            btn.addEventListener('click', function(){ window.__mobileOwnerClicked = btn.getAttribute('data-mobile-owner-row'); });
          });
          if (window.__syncInboxMobileOrder) window.__syncInboxMobileOrder();
          else if (window.__syncCustomersMobileAutonomy) window.__syncCustomersMobileAutonomy();
        });
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
          const rowRects = Array.from(document.querySelectorAll('#conv-list [data-mobile-owner-row]')).map((el) => {
            const b = el.getBoundingClientRect();
            return { id: el.getAttribute('data-mobile-owner-row'), top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height };
          });
          return {
            viewport: `${innerWidth}x${innerHeight}`,
            bodyScrollW: document.documentElement.scrollWidth,
            filter: rect('#inbox-views-rail'),
            search: rect('#tab-conversations .inbox-conv-search-wrap'),
            list: rect('#inbox-card'),
            rows: rect('#conv-list'),
            rowRects,
            autonomy: rect('#tab-conversations #inbox-shell-channel-defaults'),
            searchParent: parentId('#tab-conversations .inbox-conv-search-wrap'),
            autonomyParent: parentId('#tab-conversations #inbox-shell-channel-defaults'),
            shellOrder: Array.from(document.querySelectorAll('#inbox-shell > *')).map((el) => el.id || el.className || el.tagName).filter(Boolean),
          };
        });
        const key = `${width}x${height}-${theme}`;
        evidence[key] = metric;
        await page.screenshot({ path: path.join(OUT_DIR, `people-order-${width}x${height}-${theme}.png`), fullPage: true });
        ok(`${width}x${height} ${theme} has no horizontal overflow`, metric.bodyScrollW <= width, JSON.stringify({ scrollWidth: metric.bodyScrollW, width }));
        ok(`${width}x${height} ${theme} search is a shell row above list`, metric.searchParent === 'inbox-shell' && metric.search && metric.list && metric.search.bottom <= metric.list.top + 1, JSON.stringify(metric));
        ok(`${width}x${height} ${theme} Luna is a shell row below list`, metric.autonomyParent === 'inbox-shell' && metric.autonomy && metric.list && metric.autonomy.top >= metric.list.bottom - 1, JSON.stringify(metric));
        ok(`${width}x${height} ${theme} all four rows sit above Luna`,
          metric.rowRects.length === 4 && metric.autonomy
          && metric.rowRects.every((row) => row.bottom <= metric.autonomy.top - 1),
          JSON.stringify({ rows: metric.rowRects, autonomy: metric.autonomy }));
        const fourth = metric.rowRects[3];
        if (fourth) {
          await page.mouse.click((fourth.left + fourth.right) / 2, (fourth.top + fourth.bottom) / 2);
          await page.waitForTimeout(50);
        }
        const clicked = await page.evaluate(() => window.__mobileOwnerClicked || null);
        ok(`${width}x${height} ${theme} fourth row click reaches the row, not Luna`, clicked === 'row-4', JSON.stringify({ clicked, fourth, autonomy: metric.autonomy }));
        ok(`${width}x${height} ${theme} visual order is filter → search → list → Luna`,
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
