#!/usr/bin/env node
'use strict';

/**
 * CANCEL-BOOKING-SCROLL-001
 *
 * Tapping Cancel Booking in the booking drawer must bring the confirm panel
 * fully into the drawer's scroll area. Phone and desktop use the same drawer.
 *
 * Run: NODE_PATH=.../node_modules node scripts/verify-cancel-booking-scroll-001.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

function extract(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, 'missing ' + start);
  return src.slice(i, j);
}

function pageHtml() {
  const scrollFn = extract(apiSrc, 'function bcScrollCancelConfirmIntoView(){', 'function bcRenderCancelConfirmPanel(data){');
  const renderFn = extract(apiSrc, 'function bcRenderCancelConfirmPanel(data){', 'function bcRenderCancelResult(data, isError){');
  const initFn = extract(apiSrc, 'function bcInitBookingCancelShell(data){', 'function bcInitFieldEditShell(data){');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>cancel scroll</title>
<style>
  #bc-side-drawer{width:360px;height:320px;display:flex;flex-direction:column;overflow:hidden;border:1px solid #ccc}
  #bc-side-body{flex:1 1 auto;overflow:auto;height:240px}
  .filler{height:900px;background:#f4f1ea}
  .bc-cancel-confirm{margin-top:12px;padding:12px;border:1px solid #E6C7BC;background:#FBF7F0}
</style></head>
<body>
<div id="bc-side-drawer" class="is-open">
  <div id="bc-side-body" class="bc-side-body">
    <div class="filler">Booking details</div>
    <div id="bc-drawer-footer-wrap">
      <button type="button" id="bc-cancel-reservation-btn">Cancel Booking</button>
      <div id="bc-cancel-confirm-inline"></div>
    </div>
  </div>
</div>
<script>
function el(id){ return document.getElementById(id); }
function escHtml(s){ return String(s == null ? '' : s); }
function bcBookingStatusIsCancelled(){ return false; }
function bcCloseCancelConfirm(){ var host = el('bc-cancel-confirm-inline'); if (host) host.innerHTML = ''; }
function bcCancelFormatDatesLine(bk){
  bk = bk || {};
  return (bk.check_in || '—') + ' → ' + (bk.check_out || '—');
}
function bcRunCancelReservation(){}
var bcCancelCtx = { inFlight: false };
${scrollFn}
${renderFn}
${initFn}
</script>
</body></html>`;
}

function fullyInView(panel, scroller, pad) {
  const nr = panel;
  const sr = scroller;
  return nr.top >= sr.top - 1 && nr.bottom <= sr.bottom + 1 && nr.height > 40;
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
  }, {
    booking: {
      booking_id: 'b1',
      booking_code: 'WH-GINA',
      guest_name: 'Gina',
      status: 'confirmed',
      check_in: '2026-10-01',
      check_out: '2026-10-04',
    },
  });
  const before = await page.evaluate(() => {
    const scroller = document.getElementById('bc-side-body');
    const btn = document.getElementById('bc-cancel-reservation-btn');
    const br = btn.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    return { scrollTop: scroller.scrollTop, buttonBelow: br.top > sr.bottom };
  });
  assert.strictEqual(before.scrollTop, 0, label + ' starts at the top of the drawer');
  assert.strictEqual(before.buttonBelow, true, label + ' cancel button starts below the fold');
  await page.click('#bc-cancel-reservation-btn');
  const after = await page.evaluate(() => {
    const panel = document.getElementById('bc-cancel-confirm');
    const scroller = document.getElementById('bc-side-body');
    const nr = panel.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    return {
      top: nr.top,
      bottom: nr.bottom,
      height: nr.height,
      viewTop: sr.top,
      viewBottom: sr.bottom,
      scrollTop: scroller.scrollTop,
      text: panel.textContent,
    };
  });
  assert.ok(after.text.includes('Cancel booking?'), label + ' confirm panel rendered');
  assert.ok(after.text.includes('Confirm cancellation'), label + ' confirm action rendered');
  assert.ok(after.scrollTop > 0, label + ' drawer scrolled');
  assert.ok(fullyInView(after, { top: after.viewTop, bottom: after.viewBottom }), label + ' confirm panel fully in view ' + JSON.stringify(after));
}

async function main() {
  assert.ok(apiSrc.includes('function bcScrollCancelConfirmIntoView(){'), 'scroll helper exists');
  assert.ok(/bcRenderCancelConfirmPanel\(data\)\{[\s\S]*bcScrollCancelConfirmIntoView\(\);/.test(apiSrc), 'render scrolls after paint');
  assert.ok(!/function handleStaffPaymentLink/.test(apiSrc.slice(apiSrc.indexOf('function bcScrollCancelConfirmIntoView'), apiSrc.indexOf('function bcInitFieldEditShell'))), 'scroll slice does not touch payment handlers');

  const { chromium } = require('playwright');
  const { server, url } = await listen(pageHtml());
  const browser = await chromium.launch({ headless: true });
  try {
    const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await desktop.goto(url);
    await prove(desktop, 'desktop');
    await desktop.close();
    const phone = await browser.newPage({ viewport: { width: 390, height: 700 } });
    await phone.goto(url);
    await prove(phone, 'phone');
    await phone.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('verify-cancel-booking-scroll-001: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
