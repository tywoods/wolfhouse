'use strict';

/**
 * Conversations three-card layout (list | conversation | bookings).
 * Execution-level DOM/CSS checks — no font/colour changes.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts/staff-query-api.js');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', label); }
  else { fail += 1; console.log('  FAIL ', label, detail || ''); }
}
function section(t) { console.log('\n[inbox-three-card]', t); }

function testSource() {
  section('1. Markup ownership');
  const api = fs.readFileSync(API, 'utf8');
  ok('three-card layout class', /detail-layout--three-card/.test(api));
  ok('conversation card class', /detail-conv-card/.test(api));
  ok('bookings card class', /detail-bookings-card/.test(api));
  ok('header nested inside conversation card', (() => {
    const i = api.indexOf("var html = '<div class=\"detail-layout detail-layout--three-card\">'");
    if (i < 0) return false;
    const snip = api.slice(i, i + 900);
    return /detail-conv-card/.test(snip)
      && snip.indexOf('html += headerHtml') > snip.indexOf('detail-conv-card')
      && snip.indexOf('headerHtml') < snip.indexOf('thread-section');
  })());
  ok('Luna controls still in header right (open customer + switches)',
    /inbox-open-customer-card/.test(api)
    && /detailHeaderSwitchesHtml/.test(api)
    && /detail-header-right/.test(api));
  ok('bookings create button preserved', /inbox-create-booking-for-guest/.test(api));
  ok('bookings cal open preserved', /inbox-open-booking-cal/.test(api));
  ok('tabs Conversations/Customers switch preserved', /inbox-view-switch/.test(api));
  ok('no font-family rewrite in three-card CSS block', (() => {
    const i = api.indexOf('.detail-layout--three-card');
    const block = api.slice(i, i + 2500);
    return !/font-family\s*:/.test(block);
  })());
  ok('stack order bookings after conversation on mobile CSS',
    /detail-bookings-card\{[^}]*order:\s*3/.test(api.replace(/\s+/g, '')));
}

async function testBrowser() {
  section('2. Browser DOM three-card');
  let playwright;
  try { playwright = require('playwright'); }
  catch (e) { ok('playwright', false, e.message); return; }

  const api = fs.readFileSync(API, 'utf8');
  // Extract a thin HTML shell + inject CSS from style block + fixture detail markup.
  const cssMatch = api.match(/\.inbox-two-col\.inbox-shell-cols\{[\s\S]*?\/\* ═══ END luna-header-ui/);
  const threeCss = cssMatch ? cssMatch[0].replace(/\/\* ═══ END luna-header-ui/, '') : '';

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (e) {
    ok('chromium', false, e.message);
    return;
  }

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setContent(`<!doctype html><html><head><style>
      :root{--border-soft:#ddd;--radius:10px;--surface:#fff;--surface-soft:#f6f6f4;--text:#222;--text-2:#555;--text-3:#888;--primary:#4E5853;--focus:#4E5853}
      body{margin:0;font-family:system-ui,sans-serif}
      ${threeCss}
      .detail-header{display:flex;align-items:center;gap:10px}
      .detail-header-right{margin-left:auto;display:flex;gap:8px;align-items:center}
      .thread{min-height:120px;border:1px solid var(--border-soft);border-radius:8px;padding:8px}
      .sidebar-card h3{margin:0 0 8px;font-size:12px}
    </style></head><body>
      <div id="tab-conversations" class="active">
        <div id="wrap" class="inbox-shell-wrap">
          <div class="inbox-two-col inbox-shell-cols show-thread">
            <div class="inbox-left" id="inbox-list-card"><div class="conv-card selected">List guest</div></div>
            <div id="conv-detail" class="visible">
              <div id="detail-content">
                <div class="detail-layout detail-layout--three-card">
                  <div class="detail-main detail-conv-card" id="inbox-detail-conv-card">
                    <div class="detail-header">
                      <div class="detail-header-main"><div class="detail-name">Alex</div><div class="detail-meta">+34600</div></div>
                      <div class="detail-header-right">
                        <button type="button" id="inbox-open-customer-card">Open customer card</button>
                        <span class="detail-header-pills"><span class="pill">Luna</span></span>
                        <div class="detail-header-switches">
                          <label class="inbox-header-switch-item"><span class="inbox-header-switch-label">Needs human</span></label>
                          <label class="inbox-header-switch-item"><span class="inbox-header-switch-label">Pause Luna</span></label>
                        </div>
                      </div>
                    </div>
                    <div class="thread-section"><div class="thread" id="thread-container">Hello thread</div></div>
                    <div class="draft-panel"><textarea id="draft-textarea">hi</textarea>
                      <div class="draft-actions"><button type="button" class="btn-send-reply" id="btn-send-reply">Send</button></div>
                    </div>
                  </div>
                  <button type="button" class="detail-sidebar-toggle" id="inbox-sidebar-toggle">Hide bookings</button>
                  <div class="detail-sidebar detail-bookings-card" id="inbox-detail-sidebar">
                    <div class="sidebar-card sidebar-card--bookings">
                      <h3>Bookings</h3>
                      <div class="inbox-booking-stack">
                        <div class="inbox-booking-stack-item">BK-1</div>
                      </div>
                      <button type="button" id="inbox-create-booking-for-guest">Create booking</button>
                      <button type="button" class="inbox-open-booking-cal">Open in calendar</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </body></html>`);

    const desktop = await page.evaluate(() => {
      const list = document.querySelector('.inbox-left');
      const conv = document.querySelector('.detail-conv-card');
      const book = document.querySelector('.detail-bookings-card');
      const layout = document.querySelector('.detail-layout--three-card');
      const headerInConv = !!conv && !!conv.querySelector('.detail-header');
      const lunaInHeader = !!conv && !!conv.querySelector('#inbox-open-customer-card')
        && !!conv.querySelector('.detail-header-switches');
      const bookOutsideConv = !!book && !conv.contains(book);
      const lr = list.getBoundingClientRect();
      const cr = conv.getBoundingClientRect();
      const br = book.getBoundingClientRect();
      return {
        headerInConv,
        lunaInHeader,
        bookOutsideConv,
        threePresent: !!(list && conv && book && layout),
        orderX: lr.left < cr.left && cr.left < br.left,
        sameRow: Math.abs(cr.top - br.top) < 40,
        hasCreate: !!document.getElementById('inbox-create-booking-for-guest'),
        hasCal: !!document.querySelector('.inbox-open-booking-cal'),
        hasSend: !!document.getElementById('btn-send-reply'),
      };
    });
    ok('desktop three regions present', desktop.threePresent);
    ok('desktop left→conv→bookings x-order', desktop.orderX, JSON.stringify(desktop));
    ok('desktop conv+bookings same row', desktop.sameRow);
    ok('header+Luna controls inside conversation card', desktop.headerInConv && desktop.lunaInHeader);
    ok('bookings card outside conversation card', desktop.bookOutsideConv);
    ok('booking actions preserved', desktop.hasCreate && desktop.hasCal);
    ok('send reply preserved in conversation card', desktop.hasSend);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    const mobile = await page.evaluate(() => {
      const conv = document.querySelector('.detail-conv-card');
      const book = document.querySelector('.detail-bookings-card');
      const cr = conv.getBoundingClientRect();
      const br = book.getBoundingClientRect();
      return {
        stacked: br.top >= cr.bottom - 2,
        fullWidth: cr.width > 300 && br.width > 300,
      };
    });
    ok('mobile stacks conversation above bookings', mobile.stacked, JSON.stringify(mobile));
    ok('mobile cards usable width', mobile.fullWidth);
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('verify-sunset-inbox-three-card-layout');
  testSource();
  await testBrowser();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
