#!/usr/bin/env node
'use strict';

/**
 * CANCEL-BOOKING-PRIMARY-GREYOUT-001
 *
 * After Cancel Booking opens the confirm panel, the top primary button is
 * disabled and grey — not still peach. Back / Keep reservation restores it.
 * Confirm cancellation still runs. Scroll-into-view stays.
 *
 * Sunset Schedule uses a different drawer (#ps-drawer-cancel-booking + a
 * confirm dialog). That surface is N/A for this chrome.
 *
 * Run: NODE_PATH=.../node_modules node scripts/verify-cancel-booking-primary-greyout-001.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const sunsetSrc = fs.readFileSync(
  path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-actions.js'),
  'utf8'
);

function extract(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, 'missing ' + start);
  return src.slice(i, j);
}

function rgb(css) {
  const m = String(css || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isPeachFill(css) {
  const c = rgb(css);
  if (!c) return false;
  return c[0] > 220 && c[1] > 180 && c[2] > 170 && (c[0] - c[2]) > 12;
}

function isGreyFill(css) {
  const c = rgb(css);
  if (!c) return false;
  const spread = Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
  return spread <= 12 && c[0] >= 180 && c[0] <= 242 && !isPeachFill(css);
}

function isBrownText(css) {
  const c = rgb(css);
  return !!(c && c[0] > 120 && c[1] < 110 && c[2] < 90);
}

function pageHtml() {
  const css = extract(apiSrc, '/* Phase 10.5f — cancel reservation', '/* Phase 10.6a');
  const js = extract(apiSrc, 'var bcCancelCtx = {', 'function bcInitFieldEditShell(data){');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>cancel primary greyout</title>
<style>
  ${css}
  #bc-side-drawer{width:360px;height:320px;display:flex;flex-direction:column;overflow:hidden;border:1px solid #ccc;background:#fff}
  #bc-side-body{flex:1 1 auto;overflow:auto;height:240px}
  .filler{height:900px;background:#f4f1ea}
</style></head>
<body>
<div id="bc-side-drawer" class="is-open">
  <div id="bc-side-body" class="bc-side-body">
    <div class="filler">Booking details</div>
    <div id="bc-drawer-footer-wrap" class="bc-drawer-footer-wrap">
      <button type="button" class="btn btn-danger-light" id="bc-cancel-reservation-btn">Cancel Booking</button>
      <div id="bc-cancel-confirm-inline" class="bc-cancel-confirm-inline"></div>
      <div id="bc-cancel-result"></div>
    </div>
  </div>
</div>
<script>
function el(id){ return document.getElementById(id); }
function escHtml(s){ return String(s == null ? '' : s); }
function t(k){ return k; }
function getBcClient(){ return 'wolfhouse-somo'; }
function loadBlockDetail(){ window.__loadDetail = (window.__loadDetail || 0) + 1; }
function loadBedCalendar(){ window.__loadCal = (window.__loadCal || 0) + 1; }
window.__fetchCalls = 0;
window.__fetchMode = 'hang';
window.fetch = function(){
  window.__fetchCalls += 1;
  if (window.__fetchMode === 'fail') {
    return Promise.resolve({
      ok: false,
      status: 400,
      json: function(){ return Promise.resolve({ success: false, error: 'nope' }); },
    });
  }
  return new Promise(function(){});
};
${js}
</script>
</body></html>`;
}

const BOOKING = {
  booking: {
    booking_id: 'b1',
    booking_code: 'MB-WOLFHO-20260926-ad7ac3',
    guest_name: 'Tom',
    status: 'confirmed',
    check_in: '2026-09-26',
    check_out: '2026-10-03',
  },
};

async function readPrimary(page) {
  return page.evaluate(() => {
    const btn = document.getElementById('bc-cancel-reservation-btn');
    const cs = getComputedStyle(btn);
    const panel = document.getElementById('bc-cancel-confirm');
    const confirm = document.getElementById('bc-cancel-confirm-btn');
    const back = document.getElementById('bc-cancel-keep-btn');
    const scroller = document.getElementById('bc-side-body');
    return {
      disabled: btn.disabled,
      className: btn.className,
      background: cs.backgroundColor,
      color: cs.color,
      cursor: cs.cursor,
      panelCount: document.querySelectorAll('#bc-cancel-confirm').length,
      panelText: panel ? panel.textContent : '',
      confirmDisabled: confirm ? confirm.disabled : null,
      backDisabled: back ? back.disabled : null,
      confirmBg: confirm ? getComputedStyle(confirm).backgroundColor : '',
      scrollTop: scroller.scrollTop,
      fetchCalls: window.__fetchCalls,
    };
  });
}

async function listen(html) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, url: 'http://127.0.0.1:' + port + '/' };
}

async function prove(page, label) {
  await page.evaluate((data) => {
    window.bcInitBookingCancelShell(data);
  }, BOOKING);

  const before = await readPrimary(page);
  assert.strictEqual(before.disabled, false, label + ' primary starts enabled');
  assert.strictEqual(before.panelCount, 0, label + ' confirm starts closed');
  assert.ok(isPeachFill(before.background), label + ' primary starts peach ' + before.background);

  await page.click('#bc-cancel-reservation-btn');
  const open = await readPrimary(page);
  assert.ok(open.panelText.includes('Cancel booking?'), label + ' confirm panel rendered');
  assert.ok(open.panelText.includes('Confirm cancellation'), label + ' confirm action rendered');
  assert.ok(open.panelText.includes('Back / Keep reservation'), label + ' back action rendered');
  assert.strictEqual(open.disabled, true, label + ' primary disabled while confirm is open');
  assert.ok(
    open.className.includes('is-awaiting-confirm'),
    label + ' primary marked awaiting confirm'
  );
  assert.ok(isGreyFill(open.background), label + ' primary fill is grey, not peach ' + open.background);
  assert.ok(!isBrownText(open.color), label + ' primary label is not still peach-brown ' + open.color);
  assert.ok(!isPeachFill(open.background), label + ' primary is not still peach ' + open.background);
  assert.strictEqual(open.confirmDisabled, false, label + ' confirm stays enabled');
  assert.strictEqual(open.backDisabled, false, label + ' back stays enabled');
  assert.ok(isPeachFill(open.confirmBg), label + ' confirm button stays peach ' + open.confirmBg);
  assert.strictEqual(open.panelCount, 1, label + ' one confirm panel');
  assert.ok(open.scrollTop > 0, label + ' drawer still scrolls confirm into view');

  await page.evaluate(() => {
    document.getElementById('bc-cancel-reservation-btn').click();
  });
  const still = await readPrimary(page);
  assert.strictEqual(still.panelCount, 1, label + ' disabled primary does not open a second panel');
  assert.strictEqual(still.disabled, true, label + ' primary stays disabled after a second click');

  await page.click('#bc-cancel-keep-btn');
  const restored = await readPrimary(page);
  assert.strictEqual(restored.panelCount, 0, label + ' back closes the confirm panel');
  assert.strictEqual(restored.disabled, false, label + ' primary enabled after back');
  assert.ok(
    !restored.className.includes('is-awaiting-confirm'),
    label + ' awaiting class cleared after back'
  );
  assert.ok(isPeachFill(restored.background), label + ' primary returns to peach ' + restored.background);

  await page.click('#bc-cancel-reservation-btn');
  await page.evaluate(() => { window.__fetchMode = 'fail'; });
  await page.click('#bc-cancel-confirm-btn');
  await page.waitForFunction(() => window.__fetchCalls >= 1);
  const failed = await readPrimary(page);
  assert.ok(failed.fetchCalls >= 1, label + ' confirm still posts the cancel');
  assert.strictEqual(failed.panelCount, 1, label + ' failed confirm leaves the panel open');
  assert.strictEqual(failed.disabled, true, label + ' primary stays greyed after a failed confirm');
  assert.ok(isGreyFill(failed.background), label + ' primary stays grey after a failed confirm ' + failed.background);
  assert.strictEqual(failed.confirmDisabled, false, label + ' confirm can be retried after failure');
}

async function main() {
  assert.ok(
    !sunsetSrc.includes('bc-cancel-confirm') && sunsetSrc.includes('ps-drawer-cancel-booking'),
    'Sunset cancel is a different drawer'
  );
  console.log('SUNSET_CANCEL_DRAWER=N/A');

  const { chromium } = require('playwright');
  const { server, url } = await listen(pageHtml());
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/opt/hermes/.playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell',
  });
  try {
    const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await desktop.goto(url);
    await prove(desktop, 'desktop');
    await desktop.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('verify-cancel-booking-primary-greyout-001: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
