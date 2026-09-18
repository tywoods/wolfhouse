#!/usr/bin/env node
'use strict';

/**
 * MOBILE-FULL-UI-PASS-001 priority proof:
 * - People/Customers mobile order: filter → search → contact list → Luna autonomy controls.
 * - Light-mode pebble/pill/chip text is readable and selected state stays stronger.
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
const OUT_DIR = path.join(ROOT, 'tmp', 'mobile-people-contrast-layout');
const WIDTHS = [360, 390, 430];
let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : `  (${detail})`}`); }
}

function srgb(v) { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function lum(rgb) { return 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2]); }
function contrast(a, b) { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const playwright = loadPlaywright();
  if (!playwright) throw new Error('Playwright is unavailable; run npm ci first');
  const { server, base } = await startFixtureServer(buildPortalHtml());
  const browser = await playwright.chromium.launch({ headless: true });
  const evidence = {};
  try {
    for (const width of WIDTHS) {
      const page = await browser.newPage();
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof window.switchToTab === 'function', null, { timeout: 15000 });
      await page.evaluate(() => {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('staffTheme', 'light');
        window.switchToTab('customers');
      });
      await page.waitForFunction(() => !!document.querySelector('#tab-customers.active .customers-toolbar-main'), null, { timeout: 15000 });
      await page.waitForTimeout(SETTLE_MS);
      const metric = await page.evaluate(() => {
        const parseRgb = (value) => (String(value).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const rect = (sel) => {
          const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
          if (!el) return null;
          const b = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height, color: parseRgb(cs.color), background: parseRgb(cs.backgroundColor), borderColor: parseRgb(cs.borderColor), fontWeight: cs.fontWeight, text: (el.textContent || '').trim() };
        };
        const list = document.querySelector('#cust-list');
        if (list && !list.children.length) {
          list.innerHTML = '<div class="customers-card"><div class="customers-card-body"><div class="customers-card-heading"><div class="customers-card-name">QA Guest</div><span class="customers-card-phone">+34 600 000 000</span></div><div class="customers-badges"><span class="customers-badge customers-badge-warm">Warm lead</span></div></div></div>';
        }
        const toolbarOrder = Array.from(document.querySelectorAll('#tab-customers .customers-toolbar-main > *')).map((el) => el.id || el.className || el.tagName);
        let sample = document.getElementById('mobile-contrast-samples');
        if (!sample) {
          sample = document.createElement('div');
          sample.id = 'mobile-contrast-samples';
          sample.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;padding:8px;background:var(--surface);';
          sample.innerHTML = '<button class="portal-admin-pill">Beach</button><button class="portal-admin-pill is-selected">Selected beach</button><button class="customers-filters-option active">Frequency</button><span class="customers-filter-chip">Tag</span><button class="channelModeBtn isSelected">Auto</button>';
          document.querySelector('#tab-customers .customers-wrap').appendChild(sample);
        }
        if (window.__syncCustomersMobileAutonomy) window.__syncCustomersMobileAutonomy();
        const bg = parseRgb(getComputedStyle(document.body).backgroundColor || 'rgb(255,255,255)');
        const samples = Array.from(sample.children).map((el) => rect(el));
        return {
          viewport: innerWidth,
          bodyScrollW: document.documentElement.scrollWidth,
          pageBackground: bg,
          filter: rect('#tab-customers .customers-filters-wrap'),
          search: rect('#cust-search'),
          list: rect('#cust-list'),
          autonomy: rect('#tab-customers .customers-list-col #inbox-shell-channel-defaults'),
          addButton: rect('#tab-customers .customers-list-col #cust-add-btn'),
          samples,
          toolbarOrder,
          selectedWeights: samples.filter((s) => /Selected|Frequency|Auto/.test(s.text)).map((s) => Number.parseInt(s.fontWeight, 10) || 0),
        };
      });
      metric.sampleContrasts = metric.samples.map((s) => {
        const bg = Array.isArray(s.background) && s.background.length >= 3 ? s.background : metric.pageBackground;
        return contrast(s.color, bg);
      });
      evidence[width] = metric;
      await page.screenshot({ path: path.join(OUT_DIR, `people-${width}.png`), fullPage: true });

      ok(`${width}px People has no horizontal overflow`, metric.bodyScrollW <= width, JSON.stringify({ scrollWidth: metric.bodyScrollW, width }));
      ok(`${width}px toolbar DOM keeps filters before search`, metric.toolbarOrder.indexOf('cust-search') > metric.toolbarOrder.indexOf('customers-filters-wrap'), JSON.stringify(metric.toolbarOrder));
      ok(`${width}px visual order is filter → search → list → Luna`, metric.filter && metric.search && metric.list && metric.autonomy && metric.search.top >= metric.filter.bottom - 1 && metric.list.top >= metric.search.bottom - 1 && metric.autonomy.top >= metric.list.bottom - 1, JSON.stringify({ filter: metric.filter, search: metric.search, list: metric.list, autonomy: metric.autonomy }));
      ok(`${width}px add customer stays below Luna on mobile`, metric.addButton && metric.addButton.top >= metric.autonomy.bottom - 1, JSON.stringify({ autonomy: metric.autonomy, addButton: metric.addButton }));
      ok(`${width}px pebble/chip labels pass readable contrast`, metric.sampleContrasts.every((v) => v >= 4.5), JSON.stringify(metric.sampleContrasts));
      ok(`${width}px selected pebbles stay visually stronger`, metric.selectedWeights.every((v) => v >= 700), JSON.stringify(metric.selectedWeights));
      await page.close();
    }
    fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`\nmobile People + pebble screenshots: ${OUT_DIR}`);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
  console.log(`\nverify-mobile-people-contrast-layout: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err.stack || err); process.exit(1); });
