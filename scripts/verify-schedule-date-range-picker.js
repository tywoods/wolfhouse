'use strict';

// Schedule date-range popover must sit above the booking grid and stay fully
// in the viewport at desktop and phone widths. Wolfhouse staff only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
assert.match(api, /function bcPlaceRangePop\(/);
assert.match(api, /document\.body\.appendChild\(pop\)/);
assert.match(api, /position:fixed;z-index:80/);
assert.doesNotMatch(api, /#tab-bed-calendar\.active\{[^}]*overflow:\s*visible/);
assert.doesNotMatch(api, /#wrap-bc\{[^}]*overflow:\s*visible/);
assert.match(api, /#tab-bed-calendar #bc-zoom-bar,#tab-bed-calendar #bc-legend,#tab-bed-calendar #bc-range-wrap\{display:none\}/);

function buildHtml() {
  const built = spawnSync(process.execPath, ['-e', "process.env.NODE_ENV='test';process.env.STAFF_UI_BUILDER_TEST_SEAM='1';process.env.STAFF_AUTH_REQUIRED='false';process.env.STAFF_AUTH_ALLOW_OPEN='true';process.stdout.write(require('./scripts/staff-query-api.js').buildUiHtmlForOfflineTest(0, 'wolfhouse-somo'));"], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(built.status, 0, built.stderr || 'full page build failed');
  assert.match(built.stdout, /id="bc-range-pop"/);
  return built.stdout;
}

async function openPicker(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.tab-panel').forEach((el) => el.classList.remove('active'));
    const tab = document.getElementById('tab-bed-calendar');
    if (tab) tab.classList.add('active');
  });
  await page.locator('#bc-range-btn').click({ timeout: 5000 });
  await page.waitForFunction(() => {
    const pop = document.getElementById('bc-range-pop');
    return pop && !pop.hidden && pop.parentNode === document.body;
  });
}

async function measure(page) {
  return page.evaluate(() => {
    const pop = document.getElementById('bc-range-pop');
    const btn = document.getElementById('bc-range-btn');
    const head = pop.querySelector('.bc-range-pop-head');
    const nav = pop.querySelectorAll('.bc-range-pop-nav');
    const dow = pop.querySelector('.bc-range-pop-dow');
    const hint = pop.querySelector('.bc-range-pop-hint');
    const day = pop.querySelector('.bc-range-pop-day:not(.is-out)');
    const pr = pop.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const hr = head.getBoundingClientRect();
    const hintRect = hint.getBoundingClientRect();
    const style = getComputedStyle(pop);
    const title = pop.querySelector('.bc-range-pop-title');
    const tr = title.getBoundingClientRect();
    let cover = document.getElementById('bc-range-pop-cover');
    if (!cover) {
      cover = document.createElement('div');
      cover.id = 'bc-range-pop-cover';
      cover.textContent = 'Chloe Dubois Paid';
      document.body.appendChild(cover);
    }
    cover.style.cssText = 'position:fixed;left:' + Math.round(tr.x) + 'px;top:' + Math.round(tr.y) + 'px;width:' + Math.round(Math.max(tr.width, 40)) + 'px;height:' + Math.round(Math.max(tr.height, 16)) + 'px;z-index:40;background:#d7ece4;pointer-events:auto;';
    const hit = document.elementFromPoint(tr.x + tr.width / 2, tr.y + tr.height / 2);
    const bar = document.getElementById('bc-range-pop-cover');
    const barHit = bar
      ? document.elementFromPoint(tr.x + 4, tr.y + 4)
      : hit;
    return {
      parent: pop.parentNode === document.body,
      hidden: pop.hidden,
      position: style.position,
      zIndex: Number(style.zIndex),
      pop: { x: pr.x, y: pr.y, right: pr.right, bottom: pr.bottom, width: pr.width, height: pr.height },
      btn: { x: br.x, y: br.y, right: br.right, bottom: br.bottom, width: br.width, height: br.height },
      head: { width: hr.width, height: hr.height, y: hr.y },
      hint: { width: hintRect.width, height: hintRect.height, bottom: hintRect.bottom, text: hint.textContent },
      nav: nav.length,
      dow: dow ? dow.textContent : '',
      day: day ? day.textContent : '',
      hitInPop: !!(hit && pop.contains(hit)),
      barDoesNotCover: !bar || !!(barHit && pop.contains(barHit)),
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  });
}

function assertFullyVisible(info, label) {
  assert.equal(info.parent, true, label + ' popover is not on body');
  assert.equal(info.hidden, false, label + ' popover stayed hidden');
  assert.equal(info.position, 'fixed', label + ' popover is not fixed');
  assert.ok(info.zIndex >= 80, label + ' z-index ' + info.zIndex);
  assert.ok(info.head.height > 8, label + ' month header is clipped ' + JSON.stringify(info.head));
  assert.equal(info.nav, 2, label + ' missing prev/next');
  assert.ok(info.dow.length > 0, label + ' weekday row missing');
  assert.ok(info.day.length > 0, label + ' date rows missing');
  assert.match(info.hint.text, /selected|Pick/, label + ' footer missing');
  assert.ok(info.hint.bottom <= info.vh - 4, label + ' footer clipped ' + JSON.stringify(info.hint));
  assert.ok(info.pop.x >= 4, label + ' left clipped ' + JSON.stringify(info.pop));
  assert.ok(info.pop.y >= 4, label + ' top clipped ' + JSON.stringify(info.pop));
  assert.ok(info.pop.right <= info.vw - 4, label + ' right clipped ' + JSON.stringify(info.pop));
  assert.ok(info.pop.bottom <= info.vh - 4, label + ' bottom clipped ' + JSON.stringify(info.pop));
  assert.equal(info.hitInPop, true, label + ' a grid bar covers the month title');
  assert.equal(info.barDoesNotCover, true, label + ' cover bar still wins');
  const under = info.pop.y >= info.btn.bottom - 2;
  const above = info.pop.bottom <= info.btn.y + 2;
  assert.ok(under || above, label + ' popover is not anchored to the button ' + JSON.stringify({ pop: info.pop, btn: info.btn }));
}

async function main() {
  const html = buildHtml();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{"success":true,"rooms":[],"blocks":[],"days":[],"booking_years":[]}',
  }));
  await page.setContent(html, { waitUntil: 'domcontentloaded' });

  await page.setViewportSize({ width: 1440, height: 900 });
  await openPicker(page);
  assertFullyVisible(await measure(page), '1440');

  await page.evaluate(() => {
    const pop = document.getElementById('bc-range-pop');
    const btn = document.getElementById('bc-range-btn');
    if (pop) pop.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
  await page.setViewportSize({ width: 390, height: 700 });
  await page.addStyleTag({ content: '#bc-range-wrap{display:inline-flex!important;position:fixed;right:8px;bottom:8px;z-index:1}' });
  await openPicker(page);
  const phone = await measure(page);
  assertFullyVisible(phone, '390');
  assert.ok(phone.pop.bottom <= phone.btn.y + 2, '390 near the bottom should flip above the button ' + JSON.stringify(phone));

  await browser.close();
  console.log('PASS schedule date-range picker');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
