'use strict';

// Proves Cap's month/year CHANGES against generated page text and native clicks.
// The year regex is compiled the same way buildUiHtml's template literal emits it.
// The 769px check uses the real toolbar CSS cascade, including the nowrap rules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('/opt/data/home/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const es = require('./lib/staff-portal-i18n-es');

const ROOT = path.resolve(__dirname, '..');
const CHROME = '/opt/data/home/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const src = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

function slice(start, end) {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a + start.length);
  assert.ok(a > 0 && b > a, 'missing slice ' + start);
  return src.slice(a, b);
}

function generated(text) {
  return eval('`' + text + '`');
}

const yearFns = generated(slice('function bcParseNavYear', 'function bcLocalTodayIso'));
assert.equal(yearFns.includes('/^d{4}'), false, 'template must not emit /^d{4}/');
const yearApi = new Function(yearFns + '\nreturn { bcParseNavYear, bcSelectedNavYear };')();
assert.equal(yearApi.bcParseNavYear('2027'), 2027);
assert.equal(yearApi.bcParseNavYear('2028'), 2028);
assert.equal(yearApi.bcParseNavYear('20ab'), null);

const toolbarHtml = generated(slice('<!-- Controls card -->', '<!-- Warnings -->'));
assert.match(toolbarHtml, /id="bc-nav-prev"[^>]*data-i18n-aria="calendar\.nav\.prev"/);
assert.match(toolbarHtml, /id="bc-nav-next"[^>]*data-i18n-aria="calendar\.nav\.next"/);
assert.equal(es['calendar.nav.prev'], 'Mes anterior');
assert.equal(es['calendar.nav.next'], 'Mes siguiente');

const css = [
  '.toolbar{display:flex;align-items:center;gap:14px}',
  '#tab-bed-calendar .bc-chip{flex:0 0 auto;padding:4px 8px;white-space:nowrap}',
  generated(slice('/* staff-portal-calendar:toolbar-row', '.bc-range-pick{')),
].join('\n');
assert.match(css, /max-width:1024px/);
assert.match(css, /flex-wrap:nowrap/);
assert.match(css, /flex-wrap:wrap/);

const pageHtml = `<!DOCTYPE html><html><head><style>
body{margin:0}
#tab-bed-calendar{display:block}
#wrap-bc{max-width:100%;padding:4px 16px 12px;box-sizing:border-box}
.card{padding:6px 12px;box-sizing:border-box}
${css}
</style></head><body>
<div id="tab-bed-calendar"><div id="wrap-bc"><div class="card">${toolbarHtml}</div></div></div>
<script>
window.__chip = '';
window.__refresh = false;
document.querySelectorAll('.bc-chip').forEach(function(el){
  el.addEventListener('click', function(){ window.__chip = el.dataset.chip; });
});
document.getElementById('bc-load').addEventListener('click', function(){ window.__refresh = true; });
</script></body></html>`;

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 769, height: 800 } });
  await page.setContent(pageHtml);
  await page.evaluate((dict) => {
    window.t = function(key){ return dict[key] || key; };
    document.querySelectorAll('[data-i18n-aria]').forEach(function(el){
      el.setAttribute('aria-label', window.t(el.getAttribute('data-i18n-aria')));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function(el){
      el.setAttribute('title', window.t(el.getAttribute('data-i18n-title')));
    });
  }, es);
  assert.equal(await page.locator('#bc-nav-prev').getAttribute('aria-label'), 'Mes anterior');
  assert.equal(await page.locator('#bc-nav-next').getAttribute('aria-label'), 'Mes siguiente');
  assert.equal(await page.locator('#bc-nav-prev').getAttribute('title'), 'Mes anterior');

  for (const width of [769, 800, 900, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    const chip = page.locator('[data-chip="oct-nov"]');
    const chipBox = await chip.boundingBox();
    assert.ok(chipBox && chipBox.width > 20, width + ' seasonal chip width ' + (chipBox && chipBox.width));
    const refresh = await page.locator('#bc-load').boundingBox();
    assert.ok(refresh, width + ' refresh missing');
    assert.ok(refresh.x >= 0 && refresh.x + refresh.width <= width + 1, width + ' refresh offscreen ' + JSON.stringify(refresh));
    const chipHit = await page.evaluate(() => {
      const el = document.querySelector('[data-chip="oct-nov"]');
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!(hit && (hit === el || el.contains(hit)));
    });
    assert.equal(chipHit, true, width + ' ordinary click misses the seasonal shortcut');
    await page.evaluate(() => { window.__chip = ''; window.__refresh = false; });
    await chip.click();
    assert.equal(await page.evaluate(() => window.__chip), 'oct-nov', width + ' chip click did not fire');
    const refreshHit = await page.evaluate(() => {
      const el = document.getElementById('bc-load');
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + Math.min(8, r.width / 2), r.y + r.height / 2);
      return !!(hit && (hit === el || el.contains(hit)));
    });
    assert.equal(refreshHit, true, width + ' ordinary click misses Refresh');
    await page.locator('#bc-load').click();
    assert.equal(await page.evaluate(() => window.__refresh), true, width + ' refresh click did not fire');
  }
  await browser.close();
  console.log('PASS month/year generated page and 769 toolbar clicks');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
