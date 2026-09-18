#!/usr/bin/env node
'use strict';

/**
 * Verifies the mobile hamburger drawer footer in light mode.
 * Ty bug: Logout + language toggle were nearly invisible on the white mobile footer.
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
const OUT_DIR = path.join(ROOT, 'tmp', 'mobile-footer-contrast');
const WIDTHS = [360, 390, 430];
let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? '' : `  (${detail})`}`);
  }
}

function srgbToLinear(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb) {
  return 0.2126 * srgbToLinear(rgb[0]) + 0.7152 * srgbToLinear(rgb[1]) + 0.0722 * srgbToLinear(rgb[2]);
}

function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const playwright = loadPlaywright();
  if (!playwright) throw new Error('Playwright is unavailable; run npm ci first');
  const { server, base } = await startFixtureServer(buildPortalHtml());
  const browser = await playwright.chromium.launch({ headless: true });
  const evidence = {};
  try {
    const page = await browser.newPage();
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#banner .nav-menu-toggle', { timeout: 15000 });
      await page.evaluate(() => {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('staffTheme', 'light');
      });
      await page.click('#banner .nav-menu-toggle');
      await page.waitForSelector('body.nav-menu-open #nav-menu-tools', { timeout: 15000 });
      await page.waitForTimeout(SETTLE_MS);
      const metric = await page.evaluate(() => {
        const parseRgb = (value) => {
          const nums = String(value).match(/[\d.]+/g) || [];
          return nums.slice(0, 3).map((n) => Number(n));
        };
        const rect = (el) => {
          if (!el) return null;
          const b = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            text: (el.innerText || el.getAttribute('aria-label') || '').trim(),
            color: parseRgb(cs.color),
            background: parseRgb(cs.backgroundColor),
            borderColor: parseRgb(cs.borderColor),
            opacity: Number(cs.opacity),
            display: cs.display,
            width: Math.round(b.width),
            height: Math.round(b.height),
            left: Math.round(b.left),
            right: Math.round(b.right),
            top: Math.round(b.top),
            bottom: Math.round(b.bottom),
          };
        };
        const footer = document.querySelector('#nav-menu-tools');
        const footerStyle = getComputedStyle(footer);
        return {
          viewport: innerWidth,
          bodyScrollW: document.documentElement.scrollWidth,
          footer: rect(footer),
          footerBackground: parseRgb(footerStyle.backgroundColor),
          logout: rect(document.querySelector('#nav-menu-tools #btn-logout')),
          lang: rect(document.querySelector('#nav-menu-tools #staff-lang-switch')),
          langButtons: Array.from(document.querySelectorAll('#nav-menu-tools .staff-lang-btn')).map(rect),
          theme: rect(document.querySelector('#nav-menu-tools #staff-theme-toggle')),
        };
      });
      const bg = metric.footerBackground;
      metric.contrast = {
        logout: contrast(metric.logout.color, metric.logout.background),
        lang: contrast(metric.lang.color, bg),
        langButtons: metric.langButtons.map((btn) => contrast(btn.color, bg)),
        themeIcon: contrast(metric.theme.color, metric.theme.background),
        themeBorder: contrast(metric.theme.borderColor, bg),
      };
      evidence[width] = metric;
      await page.screenshot({ path: path.join(OUT_DIR, `footer-${width}.png`), fullPage: false });

      ok(`${width}px drawer has no horizontal overflow`, metric.bodyScrollW <= width, JSON.stringify({ bodyScrollW: metric.bodyScrollW, width }));
      ok(`${width}px footer visible and tappable`, metric.footer.height >= 58 && metric.footer.width <= width, JSON.stringify(metric.footer));
      ok(`${width}px logout is readable on light footer`, metric.contrast.logout >= 4.5, metric.contrast.logout.toFixed(2));
      ok(`${width}px language label/buttons readable`, metric.contrast.lang >= 4.5 && metric.contrast.langButtons.every((v) => v >= 4.5), JSON.stringify(metric.contrast));
      ok(`${width}px theme toggle icon and border are visible`, metric.contrast.themeIcon >= 4.5 && metric.contrast.themeBorder >= 2.0, JSON.stringify(metric.contrast));
      ok(`${width}px controls fit within drawer`, metric.logout.right <= width && metric.theme.left >= 0 && metric.lang.right <= width, JSON.stringify({ logout: metric.logout, theme: metric.theme, lang: metric.lang }));
    }
    fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`\nmobile footer contrast screenshots: ${OUT_DIR}`);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
  console.log(`\nverify-mobile-footer-contrast: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
