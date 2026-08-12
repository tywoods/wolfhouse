'use strict';

/**
 * Flat 3-column Conversations: one outer shell, column dividers, thread chrome stripped.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts/staff-query-api.js');
const OUT_DIR = path.join(ROOT, '..', '..', 'patches');
const SHOT = path.join(OUT_DIR, 'inbox-flat-three-col-desktop-1920.png');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', label); }
  else { fail += 1; console.log('  FAIL ', label, detail || ''); }
}

async function main() {
  console.log('verify-sunset-inbox-three-card-layout (flat shell)');
  const api = fs.readFileSync(API, 'utf8');

  ok('FLAT 3-COLUMN comment present', /FLAT 3-COLUMN Conversations/.test(api));
  ok('outer shell kept on shell-cols',
    /\.inbox-two-col\.inbox-shell-cols\{[\s\S]{0,400}?border:1px solid var\(--border-soft\)!important/.test(api));
  ok('thread chrome stripped at base',
    /\.thread\{[^}]*background:transparent;border:none/.test(api));
  ok('inbox-thread-wrap chrome stripped',
    /\.inbox-thread-wrap\{[^}]*border:none;border-radius:0;background:transparent/.test(api));
  ok('wooden resize bar removed (thin divider)',
    !/\.inbox-thread-resize-handle\{[^}]*linear-gradient\(180deg,#EFE8DC/.test(api)
    && /\.inbox-thread-resize-handle\{[^}]*height:10px/.test(api)
    && !/\.inbox-thread-resize-handle::after\{[^}]*box-shadow:0 5px 0 0 #B8A99A/.test(api));
  ok('list uses border-right divider not card',
    /\.inbox-two-col\.inbox-shell-cols > \.inbox-left\{[\s\S]*?border-right:1px solid var\(--border-soft\)!important/.test(api));
  ok('bookings uses border-left divider',
    /#inbox-bookings-rail[\s\S]*?border-left:1px solid var\(--border-soft\)!important/.test(api));
  ok('sibling rail still present', /id="inbox-bookings-rail"/.test(api));
  ok('bookings still injected to rail', /bookingsRail\.innerHTML\s*=\s*bookingsHtml/.test(api));

  let playwright;
  try { playwright = require('playwright'); }
  catch (e) { ok('playwright', false, e.message); process.exit(1); }

  const start = api.indexOf('/* ── Inbox two-column layout');
  const end = api.indexOf('/* ═══ END luna-header-ui');
  const css = api.slice(start, end);
  const theme = `
    :root{
      --border-soft:#3a3a3a;--border:#4a4a4a;--radius:12px;--radius-sm:8px;--radius-pill:999px;
      --surface:#1e1e1e;--surface-soft:#2a2a2a;--text:#e8e8e8;--text-2:#b0b0b0;--text-3:#888;
      --primary:#4E5853;--shadow:0 8px 24px rgba(0,0,0,.35);--tan:#5a5048;--teal:#2a3530;--sage:#5a7a5a;
      --staff-green-bg:#1e3a2f;--staff-green-text:#c8e6d0;--staff-green-border:#2d5a45;
      --luna-blue:#1e3a5f;--luna-blue-text:#dce7ee;--luna-blue-border:#2d4a6f;
    }
    *{box-sizing:border-box}
    body{margin:0;background:#0e0e0e;color:var(--text);font-family:Inter,system-ui,sans-serif}
    #tab-conversations{padding:20px;max-width:1240px;margin:0 auto}
    .inbox-shell-wrap{display:flex;flex-direction:column;min-height:820px}
    .msg-bubble{padding:12px 14px;border-radius:14px;max-width:420px;line-height:1.45;font-size:13px}
    .msg.inbound .msg-bubble{background:var(--staff-green-bg);color:var(--staff-green-text);border:1px solid var(--staff-green-border)}
    .btn,.btn-ghost,.btn-soft-grey{font:inherit;border-radius:8px;padding:6px 10px;border:1px solid var(--border-soft);background:var(--surface-soft);color:var(--text)}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#2a4038;font-size:11px}
    .detail-header{display:flex;align-items:flex-start;gap:12px;justify-content:space-between}
    .detail-header-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .detail-name{font-size:18px;font-weight:700}
    .detail-meta{font-size:12px;color:var(--text-2);margin-top:4px}
  `;

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setContent(`<!doctype html><html data-theme="dark"><head><style>
${theme}
${css}
    </style></head><body>
<div id="tab-conversations" class="tab-panel active">
<div id="wrap" class="inbox-shell-wrap">
  <div class="inbox-shell-toolbar" style="margin-bottom:12px;color:var(--text-2);font-size:13px">Conversations · flat 3-col proof</div>
  <div class="inbox-two-col inbox-shell-cols has-open-conversation">
    <div class="inbox-left" id="inbox-card">
      <div class="inbox-left-toolbar"><div style="padding:8px;font-size:12px">All · Email · WhatsApp</div></div>
      <div class="inbox-left-rows">
        <div class="conv-card selected"><div class="conv-card-name">Hernan</div><div class="conv-card-phone">+5491122676249</div></div>
        <div class="conv-card"><div class="conv-card-name">Monshies</div></div>
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
              <span style="font-size:11px">Needs human</span>
              <span style="font-size:11px">Pause Luna</span>
            </div>
          </div>
          <div class="thread-section"><div class="thread">
            <div class="inbox-thread-shell"><div class="inbox-thread-wrap">
              <div class="thread-messages" id="thread-container" style="padding:8px 0;min-height:180px">
                <div class="msg inbound"><div class="msg-bubble">Your morning course is booked for 7-10 August.
Here's the secure €130 payment link.</div></div>
              </div>
            </div>
            <div id="inbox-thread-resize-handle" class="inbox-thread-resize-handle" role="separator"></div>
            </div>
          </div></div>
          <div class="draft-panel" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-soft)">
            <div style="font-size:11px;color:var(--text-3);margin-bottom:6px">Reply:</div>
            <textarea style="width:100%;min-height:72px;background:var(--surface-soft);border:1px solid var(--border-soft);border-radius:8px;color:var(--text);padding:8px">Edit reply</textarea>
          </div>
        </div>
      </div>
    </div>
    <div id="inbox-bookings-rail" class="inbox-bookings-column has-conversation">
      <div class="detail-sidebar detail-bookings-card" id="inbox-detail-sidebar">
        <h3 style="margin:0 0 12px;font-size:11px;letter-spacing:.06em;color:var(--text-2)">BOOKINGS</h3>
        <div style="border:1px solid var(--border-soft);border-radius:10px;padding:10px;margin-bottom:10px">
          <div style="font-weight:700;font-size:12px">SUNSET-20260805-09A25D</div>
          <button type="button" class="btn btn-ghost inbox-open-booking-cal" style="margin-top:8px">Open booking</button>
        </div>
        <button type="button" class="btn btn-ghost" id="inbox-create-booking-for-guest">Create booking</button>
      </div>
    </div>
  </div>
</div>
</div>
</body></html>`);

    const v = await page.evaluate(() => {
      const cs = (el) => window.getComputedStyle(el);
      const owner = document.querySelector('.inbox-two-col.inbox-shell-cols');
      const list = document.querySelector('.inbox-left');
      const conv = document.getElementById('conv-detail');
      const book = document.getElementById('inbox-bookings-rail');
      const thread = document.querySelector('.thread');
      const wrap = document.querySelector('.inbox-thread-wrap');
      const handle = document.querySelector('.inbox-thread-resize-handle');
      const o = cs(owner);
      const t = cs(thread);
      const w = cs(wrap);
      const l = cs(list);
      const b = cs(book);
      const c = cs(conv);
      return {
        siblings: list.parentElement === owner && conv.parentElement === owner && book.parentElement === owner,
        bookNotInConv: !conv.contains(book),
        outerShell: {
          border: parseFloat(o.borderTopWidth) > 0 && o.borderTopStyle !== 'none',
          radius: parseFloat(o.borderTopLeftRadius) > 0,
          bgSolid: o.backgroundColor !== 'rgba(0, 0, 0, 0)' && o.backgroundColor !== 'transparent',
        },
        listNoCardBorder: parseFloat(l.borderTopWidth) === 0 && parseFloat(l.borderRightWidth) > 0,
        bookNoCardBorder: parseFloat(b.borderTopWidth) === 0 && parseFloat(b.borderLeftWidth) > 0,
        convNoBorder: parseFloat(c.borderTopWidth) === 0 && parseFloat(c.borderLeftWidth) === 0,
        threadFlat: t.backgroundColor === 'rgba(0, 0, 0, 0)' || t.backgroundColor === 'transparent',
        threadNoBorder: parseFloat(t.borderTopWidth) === 0,
        wrapFlat: w.backgroundColor === 'rgba(0, 0, 0, 0)' || w.backgroundColor === 'transparent',
        wrapNoBorder: parseFloat(w.borderTopWidth) === 0,
        handleThin: handle.getBoundingClientRect().height <= 14,
        handleNotWood: !cs(handle).backgroundImage.includes('gradient'),
        headerInConv: !!conv.querySelector('#inbox-open-customer-card'),
        bookingInBook: !!book.querySelector('#inbox-create-booking-for-guest'),
      };
    });

    ok('three sibling columns', v.siblings);
    ok('bookings not nested in conversation', v.bookNotInConv);
    ok('ONE outer shell has border+radius+bg',
      v.outerShell.border && v.outerShell.radius && v.outerShell.bgSolid, JSON.stringify(v.outerShell));
    ok('list divider-only (no full card border)', v.listNoCardBorder);
    ok('bookings divider-only (border-left)', v.bookNoCardBorder);
    ok('conversation column has no frame', v.convNoBorder);
    ok('thread background transparent', v.threadFlat);
    ok('thread no border', v.threadNoBorder);
    ok('inbox-thread-wrap transparent', v.wrapFlat);
    ok('inbox-thread-wrap no border', v.wrapNoBorder);
    ok('resize handle thin (not wooden slab)', v.handleThin && v.handleNotWood);
    ok('controls on middle column', v.headerInConv);
    ok('booking actions on bookings column', v.bookingInBook);

    fs.mkdirSync(OUT_DIR, { recursive: true });
    await page.screenshot({ path: SHOT, fullPage: false });
    ok('screenshot written', fs.existsSync(SHOT) && fs.statSync(SHOT).size > 8000, SHOT);
    console.log('SCREENSHOT', SHOT);
  } finally {
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
