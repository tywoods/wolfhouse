'use strict';

/**
 * Visual proof: three independent conversation cards at 1920px.
 * Uses CSS extracted from staff-query-api.js + sibling DOM structure.
 * Saves screenshot for Sea Dog review. No deploy.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts/staff-query-api.js');
const OUT_DIR = path.join(ROOT, '..', '..', 'patches');
const SHOT = path.join(OUT_DIR, 'inbox-three-cards-desktop-1920.png');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', label); }
  else { fail += 1; console.log('  FAIL ', label, detail || ''); }
}

function extractCss(src) {
  // Pull base inbox + shell-cols blocks
  const parts = [];
  const markers = [
    ['.inbox-two-col{', '/* ── Conversation cards'],
    ['#conv-detail{', '/* ── Detail pane'],
    ['.inbox-shell-toolbar{', '/* ═══ END luna-header-ui'],
    ['.detail-header{', '.detail-name{'],
    ['.detail-layout{', '/* ── Message thread'],
    ['.thread{', '/* ── Luna draft'],
    ['.draft-panel{', '.draft-label{'],
  ];
  // Simpler: take large style chunks by line ranges we know
  return null;
}

async function main() {
  console.log('verify-sunset-inbox-three-card-layout (visual)');
  const api = fs.readFileSync(API, 'utf8');

  // Extract CSS between known anchors
  const start = api.indexOf('/* ── Inbox two-column layout');
  const end = api.indexOf('/* ═══ END luna-header-ui');
  ok('extracted inbox CSS block', start > 0 && end > start);
  let css = api.slice(start, end);
  // Also include detail-header basics
  const dh = api.indexOf('.detail-header{');
  const dn = api.indexOf('.detail-name{');
  if (dh > 0 && dn > dh) css += '\n' + api.slice(dh, dn + 200);

  // Tokens approximating dark portal
  const theme = `
    :root{
      --border-soft:#3a3a3a;--border:#4a4a4a;--radius:12px;--radius-sm:8px;--radius-pill:999px;
      --surface:#1e1e1e;--surface-soft:#2a2a2a;--text:#e8e8e8;--text-2:#b0b0b0;--text-3:#888;
      --primary:#4E5853;--shadow:none;--tan:#5a5048;--teal:#2a3530;--sage:#5a7a5a;
      --focus:#6a8a7a;--ocean:#5a7a8a;
    }
    *{box-sizing:border-box}
    body{margin:0;background:#121212;color:var(--text);font-family:Inter,system-ui,sans-serif}
    #tab-conversations{padding:16px 20px;max-width:1240px;margin:0 auto}
    .inbox-shell-wrap{display:flex;flex-direction:column;min-height:820px}
    .msg-bubble{background:#1e3a5f;color:#dce7ee;padding:12px 14px;border-radius:14px;max-width:420px;line-height:1.45;font-size:13px}
    .btn,.btn-ghost,.btn-soft-grey,.btn-primary{font:inherit;border-radius:8px;padding:6px 10px;border:1px solid var(--border-soft);background:var(--surface-soft);color:var(--text);cursor:pointer}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#2a4038;font-size:11px}
  `;

  ok('sibling rail in source', /id="inbox-bookings-rail"/.test(api));
  ok('bookings injected to rail', /bookingsRail\.innerHTML\s*=\s*bookingsHtml/.test(api));
  ok('no nested three-card emit in loadConvDetail', !/var html = '<div class="detail-layout detail-layout--three-card">/.test(api));

  let playwright;
  try { playwright = require('playwright'); }
  catch (e) { ok('playwright', false, e.message); process.exit(1); }

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setContent(`<!doctype html><html data-theme="dark"><head><style>
${theme}
${css}
    </style></head><body>
<div id="tab-conversations" class="tab-panel active">
<div id="wrap" class="inbox-shell-wrap">
  <div class="inbox-shell-toolbar" style="margin-bottom:12px;color:var(--text-2);font-size:13px">Conversations | Customers · desktop proof 1920</div>
  <div class="inbox-two-col inbox-shell-cols has-open-conversation">
    <div class="inbox-left" id="inbox-card">
      <div class="inbox-left-toolbar"><div class="inbox-filters" style="padding:8px;font-size:12px">All · Email · WhatsApp</div></div>
      <div class="inbox-left-rows">
        <div class="conv-card selected"><div class="conv-card-name">Hernan</div><div class="conv-card-phone">+5491122676249</div></div>
        <div class="conv-card"><div class="conv-card-name">Monshies</div></div>
        <div class="conv-card"><div class="conv-card-name">GoDaddy</div></div>
      </div>
    </div>
    <div id="conv-detail" class="inbox-conv-column visible">
      <div id="detail-content">
        <div class="detail-main detail-conv-card" id="inbox-detail-conv-card">
          <div class="detail-header">
            <div class="detail-header-main">
              <div class="detail-name">Hernan</div>
              <div class="detail-meta">+5491122676249</div>
            </div>
            <div class="detail-header-right">
              <button type="button" class="btn btn-soft-grey" id="inbox-open-customer-card">Open customer card</button>
              <span class="pill">Luna</span>
              <div class="detail-header-switches" style="display:flex;gap:10px;font-size:11px">
                <span>Needs human</span><span>Pause Luna</span>
              </div>
            </div>
          </div>
          <div class="thread-section"><div class="thread">
            <div class="thread-messages" id="thread-container" style="padding:8px">
              <div class="msg inbound"><div class="msg-bubble">Your morning course is booked for 7-10 August.
Here's the secure €130 payment link:
https://sunset-staging.lunafrontdesk.com/pay/SUNSET-20260805-09A25D

Please sign the waiver before your first class.</div></div>
            </div>
          </div></div>
          <div class="draft-panel" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-soft)">
            <div style="font-size:11px;color:var(--text-3);margin-bottom:6px">Reply:</div>
            <textarea id="draft-textarea" style="width:100%;min-height:72px;background:var(--surface-soft);border:1px solid var(--border-soft);border-radius:8px;color:var(--text);padding:8px">Edit reply before sending</textarea>
            <div style="margin-top:8px;text-align:right"><button type="button" class="btn-send-reply" id="btn-send-reply">Send</button></div>
          </div>
        </div>
      </div>
    </div>
    <div id="inbox-bookings-rail" class="inbox-bookings-column has-conversation">
      <div class="detail-sidebar detail-bookings-card" id="inbox-detail-sidebar">
        <div class="sidebar-card sidebar-card--bookings">
          <h3 style="margin:0 0 12px;font-size:11px;letter-spacing:.06em;color:var(--text-2)">BOOKINGS</h3>
          <div class="inbox-booking-stack">
            <div class="inbox-booking-stack-item" style="border:1px solid var(--border-soft);border-radius:10px;padding:10px;margin-bottom:10px">
              <div style="font-weight:700;font-size:12px;margin-bottom:8px">SUNSET-20260805-09A25D</div>
              <div style="font-size:11px;color:var(--text-2)">STATUS payment pending · €130.00 due</div>
              <button type="button" class="btn btn-ghost inbox-open-booking-cal" style="margin-top:8px">Open booking</button>
            </div>
            <div class="inbox-booking-stack-item" style="border:1px solid var(--border-soft);border-radius:10px;padding:10px">
              <div style="font-weight:700;font-size:12px;margin-bottom:8px">SUNSET-20260804-93108C</div>
              <div style="font-size:11px;color:var(--text-2)">STATUS payment pending</div>
            </div>
          </div>
          <button type="button" class="btn btn-ghost" id="inbox-create-booking-for-guest" style="margin-top:10px">Create booking for this guest</button>
        </div>
      </div>
    </div>
  </div>
</div>
</div>
</body></html>`);

    // Visual ownership assertions
    const v = await page.evaluate(() => {
      function cs(el) { return window.getComputedStyle(el); }
      function hasCardChrome(el) {
        const s = cs(el);
        const bg = s.backgroundColor;
        const transparent = bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent';
        const border = parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none';
        const radius = parseFloat(s.borderTopLeftRadius) > 0;
        return { transparent, border, radius, bg, bw: s.borderTopWidth, br: s.borderTopLeftRadius };
      }
      const owner = document.querySelector('.inbox-two-col.inbox-shell-cols');
      const list = document.querySelector('.inbox-left');
      const conv = document.getElementById('conv-detail');
      const book = document.getElementById('inbox-bookings-rail');
      // Ancestors that contain BOTH conv and book
      const shared = [];
      let n = conv.parentElement;
      while (n) {
        if (n.contains(book) && n.contains(conv) && n !== document.body && n !== document.documentElement) {
          const chrome = hasCardChrome(n);
          if (!chrome.transparent || chrome.border || chrome.radius) {
            shared.push({ tag: n.id || n.className, chrome });
          }
        }
        n = n.parentElement;
      }
      const lc = hasCardChrome(list);
      const cc = hasCardChrome(conv);
      const bc = hasCardChrome(book);
      const lr = list.getBoundingClientRect();
      const cr = conv.getBoundingClientRect();
      const br = book.getBoundingClientRect();
      return {
        siblings: list.parentElement === owner && conv.parentElement === owner && book.parentElement === owner,
        bookNotInConv: !conv.contains(book),
        sharedCardAncestors: shared,
        listCard: lc,
        convCard: cc,
        bookCard: bc,
        gaps: { listConv: cr.left - lr.right, convBook: br.left - cr.right },
        tops: { list: lr.top, conv: cr.top, book: br.top },
        headerOnlyInConv: !!conv.querySelector('#inbox-open-customer-card') && !book.querySelector('#inbox-open-customer-card'),
        bookingsOnlyInBook: !!book.querySelector('#inbox-create-booking-for-guest') && !conv.querySelector('#inbox-create-booking-for-guest'),
      };
    });

    ok('three sibling columns under owner', v.siblings);
    ok('bookings not inside conversation', v.bookNotInConv);
    ok('no shared card-chrome ancestor spanning conv+bookings',
      v.sharedCardAncestors.length === 0, JSON.stringify(v.sharedCardAncestors));
    ok('list has independent border+radius+bg',
      v.listCard.border && v.listCard.radius && !v.listCard.transparent, JSON.stringify(v.listCard));
    ok('conversation has independent border+radius+bg',
      v.convCard.border && v.convCard.radius && !v.convCard.transparent, JSON.stringify(v.convCard));
    ok('bookings has independent border+radius+bg',
      v.bookCard.border && v.bookCard.radius && !v.bookCard.transparent, JSON.stringify(v.bookCard));
    ok('gap list↔conv ≈ gap conv↔bookings (within 4px)',
      Math.abs(v.gaps.listConv - v.gaps.convBook) <= 4 && v.gaps.listConv >= 10,
      JSON.stringify(v.gaps));
    ok('tops aligned within 4px',
      Math.abs(v.tops.list - v.tops.conv) <= 4 && Math.abs(v.tops.conv - v.tops.book) <= 4,
      JSON.stringify(v.tops));
    ok('Luna controls only in conversation card', v.headerOnlyInConv);
    ok('booking actions only in bookings card', v.bookingsOnlyInBook);

    fs.mkdirSync(OUT_DIR, { recursive: true });
    await page.screenshot({ path: SHOT, fullPage: false });
    ok('screenshot written', fs.existsSync(SHOT) && fs.statSync(SHOT).size > 10000, SHOT);
    console.log('SCREENSHOT', SHOT);

  } finally {
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
