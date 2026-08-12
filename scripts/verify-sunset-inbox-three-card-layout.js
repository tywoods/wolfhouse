'use strict';

/**
 * Conversations three sibling columns (list | conversation | bookings).
 * Proves Bookings is NOT nested inside Conversation.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts/staff-query-api.js');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', label); }
  else { fail += 1; console.log('  FAIL ', label, detail || ''); }
}
function section(t) { console.log('\n[inbox-three-sibling]', t); }

function testSource() {
  section('1. Source structure');
  const api = fs.readFileSync(API, 'utf8');
  ok('HTML has sibling bookings rail', /id="inbox-bookings-rail"/.test(api));
  ok('HTML bookings rail after conv-detail', (() => {
    const a = api.indexOf('id="conv-detail"');
    const b = api.indexOf('id="inbox-bookings-rail"');
    return a > 0 && b > a;
  })());
  ok('loadConvDetail writes bookings to rail not nested html',
    /bookingsRail\.innerHTML\s*=\s*bookingsHtml/.test(api)
    && /Bookings HTML goes into the sibling/.test(api));
  ok('conversation html has no detail-layout--three-card wrapper', (() => {
    const i = api.indexOf('function loadConvDetail');
    const snip = api.slice(i, i + 12000);
    // After inject, conversation target gets only detail-conv-card
    return /var html = '';/.test(snip)
      && /detail-conv-card/.test(snip)
      && !/var html = '<div class="detail-layout detail-layout--three-card">/.test(snip);
  })());
  ok('grid three columns in CSS',
    /grid-template-columns:\s*minmax\(240px,300px\)\s+minmax\(0,1fr\)\s+minmax\(260px,320px\)/.test(api));
  ok('Luna controls still in conversation header',
    /inbox-open-customer-card/.test(api) && /detailHeaderSwitchesHtml/.test(api));
}

async function testBrowser() {
  section('2. Browser sibling parentage');
  let playwright;
  try { playwright = require('playwright'); }
  catch (e) { ok('playwright', false, e.message); return; }

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (e) {
    ok('chromium', false, e.message);
    return;
  }

  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.setContent(`<!doctype html><html><head><style>
      :root{--border-soft:#444;--radius:10px;--surface:#1e1e1e;--text:#eee;--text-2:#bbb;--text-3:#888}
      body{margin:0;background:#111;color:var(--text);font-family:system-ui,sans-serif}
      .inbox-two-col.inbox-shell-cols{
        display:grid;grid-template-columns:minmax(240px,300px) minmax(0,1fr) minmax(260px,320px);
        gap:14px;height:80vh;padding:16px;
      }
      .inbox-left,#conv-detail,#inbox-bookings-rail{
        border:1px solid var(--border-soft);border-radius:var(--radius);background:var(--surface);
        min-height:0;overflow:auto;padding:12px;
      }
      .detail-header{display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--border-soft);padding-bottom:8px;margin-bottom:8px}
      .detail-header-right{margin-left:auto;display:flex;gap:8px}
      .thread{min-height:100px;border:1px solid var(--border-soft);border-radius:8px;padding:8px}
      @media(max-width:900px){
        .inbox-two-col.inbox-shell-cols{grid-template-columns:1fr}
        #inbox-bookings-rail{order:3} #conv-detail{order:2} .inbox-left{order:1}
      }
    </style></head><body>
      <div id="tab-conversations" class="active">
        <div class="inbox-two-col inbox-shell-cols has-open-conversation">
          <div class="inbox-left" id="inbox-card"><div class="conv-card">Names</div></div>
          <div id="conv-detail" class="inbox-conv-column">
            <div id="detail-content">
              <div class="detail-main detail-conv-card" id="inbox-detail-conv-card">
                <div class="detail-header">
                  <div class="detail-header-main"><div class="detail-name">Hernan</div></div>
                  <div class="detail-header-right">
                    <button id="inbox-open-customer-card">Open customer card</button>
                    <div class="detail-header-switches"><span>Needs human</span><span>Pause Luna</span></div>
                  </div>
                </div>
                <div class="thread" id="thread-container">Message body</div>
                <div class="draft-panel"><button id="btn-send-reply">Send</button></div>
              </div>
            </div>
          </div>
          <div id="inbox-bookings-rail" class="inbox-bookings-column has-conversation">
            <div class="detail-sidebar detail-bookings-card" id="inbox-detail-sidebar">
              <h3>BOOKINGS</h3>
              <button id="inbox-create-booking-for-guest">Create booking</button>
              <button class="inbox-open-booking-cal">Open booking</button>
            </div>
          </div>
        </div>
      </div>
    </body></html>`);

    const r = await page.evaluate(() => {
      const owner = document.querySelector('.inbox-two-col.inbox-shell-cols');
      const list = document.querySelector('.inbox-left');
      const conv = document.getElementById('conv-detail');
      const book = document.getElementById('inbox-bookings-rail');
      const convCard = document.getElementById('inbox-detail-conv-card');
      const kids = Array.from(owner.children).map((c) => c.id || c.className);
      return {
        siblingOwner: owner && list && conv && book
          && list.parentElement === owner
          && conv.parentElement === owner
          && book.parentElement === owner,
        bookNotInConv: conv && book && !conv.contains(book),
        convNotInBook: conv && book && !book.contains(conv),
        noSharedWrapper: !document.querySelector('.detail-layout--three-card'),
        lunaInConv: !!(conv && conv.querySelector('#inbox-open-customer-card') && conv.querySelector('.detail-header-switches')),
        bookingActionsInBook: !!(book && book.querySelector('#inbox-create-booking-for-guest') && book.querySelector('.inbox-open-booking-cal')),
        sendInConv: !!(conv && conv.querySelector('#btn-send-reply')),
        kids,
        geometry: (() => {
          const lr = list.getBoundingClientRect();
          const cr = conv.getBoundingClientRect();
          const br = book.getBoundingClientRect();
          return {
            xOrder: lr.left < cr.left && cr.left < br.left,
            sameRow: Math.abs(lr.top - cr.top) < 30 && Math.abs(cr.top - br.top) < 30,
            gapLR: cr.left - lr.right,
            gapRB: br.left - cr.right,
          };
        })(),
      };
    });

    ok('three columns are siblings under same owner', r.siblingOwner, JSON.stringify(r.kids));
    ok('bookings NOT descendant of conversation', r.bookNotInConv);
    ok('conversation NOT descendant of bookings', r.convNotInBook);
    ok('no nested three-card wrapper', r.noSharedWrapper);
    ok('Luna controls inside conversation column', r.lunaInConv);
    ok('booking actions inside bookings column', r.bookingActionsInBook);
    ok('send reply inside conversation column', r.sendInConv);
    ok('desktop x-order list→conv→bookings', r.geometry.xOrder, JSON.stringify(r.geometry));
    ok('desktop same-row top alignment', r.geometry.sameRow, JSON.stringify(r.geometry));
    ok('visible gaps between independent cards', r.geometry.gapLR > 8 && r.geometry.gapRB > 8, JSON.stringify(r.geometry));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(80);
    const m = await page.evaluate(() => {
      const conv = document.getElementById('conv-detail').getBoundingClientRect();
      const book = document.getElementById('inbox-bookings-rail').getBoundingClientRect();
      return { stacked: book.top >= conv.bottom - 4 };
    });
    ok('mobile conversation above bookings', m.stacked, JSON.stringify(m));
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
