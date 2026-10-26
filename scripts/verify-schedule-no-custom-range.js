'use strict';

// Custom date-range pill (Oct 1 – Dec 1) and its popover are gone on phone and desktop.
// Hidden #bc-start/#bc-end and bcSetRange stay so period chips still load.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

assert.match(api, /id="bc-start"/);
assert.match(api, /id="bc-end"/);
assert.match(api, /function bcSetRange\(/);

const hideRule = /#tab-bed-calendar #bc-range-wrap\{display:none!important\}/;
assert.match(api, hideRule, 'range wrap must be hidden at every width, not only 768');

const media768 = api.slice(api.indexOf('@media (max-width:768px){'));
assert.ok(
  !/#tab-bed-calendar #bc-range-wrap\{display:none!important\}/.test(media768.split('@media (min-width:769px)')[0] || '') ||
  hideRule.test(api.replace(/@media \(max-width:768px\)\{[\s\S]*?\n\}/g, '')),
  'hide must not live only inside the 768 block'
);

async function main() {
  const built = spawnSync(process.execPath, ['-e', "process.env.NODE_ENV='test';process.env.STAFF_UI_BUILDER_TEST_SEAM='1';process.env.STAFF_AUTH_REQUIRED='false';process.env.STAFF_AUTH_ALLOW_OPEN='true';process.stdout.write(require('./scripts/staff-query-api.js').buildUiHtmlForOfflineTest(0, 'wolfhouse-somo'));"], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(built.status, 0, built.stderr);
  const html = built.stdout;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        const tab = document.getElementById('tab-bed-calendar');
        if (tab) {
          tab.classList.add('active');
          tab.style.display = 'block';
        }
      });
      const vis = await page.locator('#bc-range-wrap').isVisible().catch(() => false);
      const btnVis = await page.locator('#bc-range-btn').isVisible().catch(() => false);
      const popVis = await page.locator('#bc-range-pop').isVisible().catch(() => false);
      assert.equal(vis, false, width + ' range wrap still visible');
      assert.equal(btnVis, false, width + ' range pill still visible');
      assert.equal(popVis, false, width + ' range popover still visible');
      const chips = await page.locator('#bc-chips .bc-chip').count();
      assert.equal(chips, 9, width + ' period pills must stay');
      const gap = await page.evaluate(() => {
        const wrap = document.getElementById('bc-range-wrap');
        const chipsEl = document.getElementById('bc-chips');
        const load = document.getElementById('bc-load');
        const wr = wrap ? wrap.getBoundingClientRect() : { width: 0, height: 0 };
        const cr = chipsEl.getBoundingClientRect();
        const lr = load.getBoundingClientRect();
        return {
          wrapW: wr.width,
          wrapH: wr.height,
          wrapDisplay: wrap ? getComputedStyle(wrap).display : 'none',
          chipRight: cr.right,
          refreshX: lr.x,
          start: document.getElementById('bc-start') != null,
          end: document.getElementById('bc-end') != null,
        };
      });
      assert.equal(gap.wrapDisplay, 'none', width + ' leftover wrap display ' + gap.wrapDisplay);
      assert.equal(gap.wrapW, 0, width + ' leftover wrap width ' + gap.wrapW);
      assert.equal(gap.wrapH, 0, width + ' leftover wrap height ' + gap.wrapH);
      assert.equal(gap.start, true, 'hidden start stays');
      assert.equal(gap.end, true, 'hidden end stays');
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log('PASS schedule no custom range');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
