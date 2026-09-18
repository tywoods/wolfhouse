#!/usr/bin/env node
'use strict';

// Real production /staff/ui with the existing offline API fixture (empty Schedule).
// No staging, guest sends or writes. Default blocks all external requests.
// --web-fonts permits ONLY the production Google Fonts stylesheet/font GETs.
// --capture-only records a baseline without enforcing the new layout.
// --baseline-html <saved-production-html> works only with --capture-only.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');

async function measure(page) {
  return page.locator('#ps-day-cockpit .ck-bar').evaluate(bar => {
    const rect = node => {
      const r = node.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    };
    const rgba = value => (value.match(/[\d.]+/g) || []).map(Number);
    const luminance = rgb => rgb.slice(0, 3).map(c => {
      c /= 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const background = node => {
      if (!node) return [255, 255, 255];
      const color = rgba(getComputedStyle(node).backgroundColor);
      const alpha = color.length > 3 ? color[3] : 1;
      if (alpha === 1) return color;
      const behind = background(node.parentElement);
      return behind.map((c, i) => color[i] * alpha + c * (1 - alpha));
    };
    const controls = Array.from(bar.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width).map(b => {
      const r = rect(b);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const fg = luminance(rgba(getComputedStyle(b).color));
      const bg = luminance(background(b));
      return { ...r, text: b.textContent, contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05), hit: b === hit || b.contains(hit), clipped: b.scrollWidth > b.clientWidth };
    });
    return {
      bar: rect(bar), date: rect(bar.querySelector('.ck-date')),
      nav: rect(bar.querySelector('.ck-seg')), controls,
      headingSize: parseFloat(getComputedStyle(bar.querySelector('.ck-date b')).fontSize),
      display: getComputedStyle(bar).display,
      bodyOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

function checkFit(m, width, mobile = true) {
  assert(!m.bodyOverflow, 'page must not overflow horizontally');
  if (mobile) {
    assert(m.date.bottom <= m.nav.top, 'date must be above navigation');
    assert(m.headingSize >= 22, 'date is the prominent heading');
    assert.equal(m.controls.length, 7, 'navigation, range, refresh and create remain visible');
  } else assert.equal(m.display, 'flex', 'desktop keeps its existing flex layout');
  for (const b of m.controls) {
    assert(b.left >= m.bar.left && b.right <= m.bar.right + 1 && b.right <= width, `${b.text}: inside chrome`);
    assert(!b.clipped && b.hit, `${b.text}: unclipped and pointer-reachable`);
    if (mobile) {
      assert(b.width >= 44 && b.height >= 44, `${b.text}: 44px target`);
      assert(b.contrast >= 4.5, `${b.text}: contrast ${b.contrast.toFixed(2)} must be >= 4.5`);
    }
  }
}

async function settle(page) {
  // The heading changes at navigation start; only this loader-owned state
  // clears after the final paint. Do not race keyboard focus against repaint.
  await page.waitForFunction(() => document.getElementById('ps-state').style.display === 'none');
}

async function exercise(page) {
  const bar = page.locator('#ps-day-cockpit .ck-bar');
  const heading = bar.locator('.ck-date b');
  const nav = bar.locator(':scope > .ck-seg button');
  const range = bar.locator('.ck-seg--range button');
  await settle(page);
  const today = await heading.textContent();
  await nav.nth(2).click();
  await settle(page);
  await page.waitForFunction(text => document.querySelector('.ck-date b').textContent !== text, today);
  await nav.nth(0).click();
  await settle(page);
  await page.waitForFunction(text => document.querySelector('.ck-date b').textContent === text, today);
  await nav.nth(0).click();
  await settle(page);
  await page.waitForFunction(text => document.querySelector('.ck-date b').textContent !== text, today);
  await nav.nth(1).click();
  await settle(page);
  await page.waitForFunction(text => document.querySelector('.ck-date b').textContent === text, today);
  await range.nth(1).click();
  await settle(page);
  await page.waitForFunction(() => document.querySelectorAll('.ck-seg--range button')[1].getAttribute('aria-pressed') === 'true');
  assert.notEqual(await heading.textContent(), today, 'Monthly switches the heading');
  const month = await heading.textContent();
  await nav.nth(2).click();
  await settle(page);
  await page.waitForFunction(text => document.querySelector('.ck-date b').textContent !== text, month);
  await nav.nth(0).click();
  await settle(page);
  await page.waitForFunction(text => document.querySelector('.ck-date b').textContent === text, month);
  await nav.nth(1).click();
  await settle(page);
  await range.nth(0).click();
  await settle(page);
  await page.waitForFunction(() => document.querySelectorAll('.ck-seg--range button')[0].getAttribute('aria-pressed') === 'true');
  await Promise.all([
    page.waitForRequest(r => new URL(r.url()).pathname === '/staff/schedule/day'),
    bar.locator('.ck-icon-btn').click(),
  ]);
  await settle(page);
  await page.waitForFunction(text => document.querySelector('.ck-date b').textContent === text, today);
  await bar.locator('.ck-cta').focus();
  await page.keyboard.press('Enter');
  await page.locator('#ps-create-close').waitFor({ state: 'visible' });
  await page.locator('#ps-create-close').click();
  await page.locator('#ps-create-close').waitFor({ state: 'hidden' });
}

async function main() {
  const captureOnly = process.argv.includes('--capture-only');
  const webFonts = process.argv.includes('--web-fonts');
  const quick = process.argv.includes('--quick');
  const baselineIndex = process.argv.indexOf('--baseline-html');
  assert(baselineIndex < 0 || captureOnly, 'baseline HTML is capture-only, never test evidence');
  const baseline = baselineIndex >= 0 ? fs.readFileSync(process.argv[baselineIndex + 1], 'utf8') : null;
  const out = path.join(__dirname, '../tmp/mobile-schedule', captureOnly ? 'before' : 'after', (webFonts ? 'web-fonts' : 'offline') + (quick ? '-quick' : ''));
  fs.mkdirSync(out, { recursive: true });
  const server = createSunsetAdminVerifyServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const failures = [];
  const evidence = [];
  try {
    browser = await chromium.launch({ headless: true });
    for (const width of (quick ? [390] : [360, 390, 430, 1365])) {
      for (const theme of (quick ? ['dark'] : ['light', 'dark'])) {
        for (const locale of (quick ? ['es'] : ['es', 'en'])) {
          const label = `${width}-${theme}-${locale}`;
          const page = await browser.newPage({ viewport: { width, height: 900 }, locale, timezoneId: 'Europe/Madrid' });
          page.setDefaultTimeout(10000);
          const errors = [], writes = [];
          page.on('pageerror', err => errors.push(err.message));
          try {
            await page.addInitScript(({ theme, locale }) => {
              localStorage.setItem('wh_staff_portal_theme', theme);
              localStorage.setItem('wh_staff_portal_locale', locale);
            }, { theme, locale });
            await page.route('**/*', route => {
              const req = route.request(), url = new URL(req.url());
              // Catalog uses POST for a read-only listOfferings query; allow only
              // this exact path on our loopback fixture, never any booking writes.
              const catalogRead = url.origin === base && url.pathname === '/staff/schedule/bookings/catalog' && req.method() === 'POST';
              if (!['GET', 'HEAD'].includes(req.method()) && !catalogRead) { writes.push(req.method() + ' ' + url.pathname); return route.abort(); }
              if (baseline && url.origin === base && url.pathname === '/staff/ui') return route.fulfill({ contentType: 'text/html', body: baseline });
              if (url.origin === base || (webFonts && ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname))) return route.continue();
              return route.abort();
            });
            await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForSelector('#ps-day-cockpit .ck-bar');
            await settle(page);
            await page.evaluate(() => document.fonts.ready);
            if (webFonts) assert(await page.evaluate(() => document.fonts.check('13px "Instrument Sans"') && Array.from(document.fonts).some(f => f.family === 'Instrument Sans' && f.status === 'loaded')), 'production Instrument Sans font loaded');
            const initial = await measure(page);
            await page.screenshot({ path: path.join(out, `${label}.png`) });
            if (!captureOnly) {
              checkFit(initial, width, width <= 768);
              await page.locator('#ps-day-cockpit .ck-cta').hover();
              checkFit(await measure(page), width, width <= 768);
              await exercise(page);
              checkFit(await measure(page), width, width <= 768);
              if (width <= 768) {
                // Deliberately long fixture copy: layout stress only, not operational facts.
                await page.locator('.ck-date span').evaluate(el => { el.textContent = 'Horario de Escuela de Surf Sunset — Playa de Somo y Loredo · 120 sesiones · 999 huéspedes'; });
                checkFit(await measure(page), width);
                await page.screenshot({ path: path.join(out, `${label}-long-heading.png`) });
              }
              assert.deepEqual(errors, [], 'no browser exceptions');
              assert.deepEqual(writes, [], 'no write/send requests');
              console.log(`PASS ${label}: fit, contrast, targets, nav, range, refresh, Enter Create/pointer close`);
            }
            evidence.push({ label, initial, errors, writes });
          } catch (err) { failures.push(`${label}: ${err.message}`); console.error('FAIL', label, err.message); }
          finally { await page.close(); }
        }
      }
    }
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ source: 'production HTML / offline empty API fixture', webFonts, captureOnly, quick, evidence, failures }, null, 2));
    assert.equal(failures.length, 0, failures.join('\n'));
    console.log(`Evidence: ${out}`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
