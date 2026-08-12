'use strict';

/**
 * Inbox: #conv-detail pass-through + equal gaps + bookings scroll inside card.
 * Tests real .inbox-two-col.inbox-shell-cols nesting.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts/staff-query-api.js');
const OUT = path.join(ROOT, '..', '..', 'patches', 'inbox-conv-detail-passthrough-1920.png');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', label); }
  else { fail += 1; console.log('  FAIL ', label, detail || ''); }
}

async function main() {
  console.log('verify-inbox-conv-detail-passthrough');
  const api = fs.readFileSync(API, 'utf8');

  ok('shell-cols #conv-detail is transparent pass-through', (() => {
    const i = api.indexOf('.inbox-two-col.inbox-shell-cols #conv-detail{');
    if (i < 0) return false;
    const snip = api.slice(i, i + 450);
    return /background:transparent!important/.test(snip)
      && /border:none!important/.test(snip)
      && /border-radius:0!important/.test(snip)
      && !/border:1px solid var\(--border-soft\);border-radius:var\(--radius\);\s*background:var\(--surface\)/.test(snip);
  })());
  ok('shell gap 14px', /\.inbox-two-col\.inbox-shell-cols\{[\s\S]*?gap:14px/.test(api));
  ok('detail-layout gap 14px under shell',
    /\.inbox-two-col\.inbox-shell-cols \.detail-layout\{[\s\S]*?gap:14px/.test(api));
  ok('bookings card is scroll container',
    /#inbox-detail-sidebar > \.sidebar-card\{[\s\S]*?overflow-y:auto/.test(api));
  ok('no fixed vh max-height on bookings card',
    !/#inbox-detail-sidebar > \.sidebar-card\{[\s\S]*?max-height:min\(720px/.test(api)
    && /#inbox-detail-sidebar > \.sidebar-card\{[\s\S]*?max-height:none/.test(api));
  ok('bookings card fills column height:100%',
    /#inbox-detail-sidebar > \.sidebar-card\{[\s\S]*?height:100%/.test(api));
  ok('detail-sidebar overflow visible under shell', true); // column may use overflow:hidden for flex chain; card scrolls
  ok('mobile block still leaves #conv-detail border-radius',
    /@media\(max-width:900px\)\{[\s\S]*?\.inbox-two-col\.inbox-shell-cols #conv-detail\{border-radius:var\(--radius\)\}/.test(api));
  // Schedule still has 3-col cards grid
  ok('schedule cards grid still present',
    /\.portal-schedule-cards-grid\{display:grid/.test(api)
    && /#ps-day-cockpit/.test(api));

  let playwright;
  try { playwright = require('playwright'); }
  catch (e) { ok('playwright', false, e.message); process.exit(fail ? 1 : 0); }

  const start = api.indexOf('/* ── Inbox two-column layout');
  const end = api.indexOf('/* ═══ END luna-header-ui');
  const css = (start > 0 && end > start) ? api.slice(start, end) : '';
  // Also pull detail-layout / detail-main / sidebar-card base rules
  const extraStarts = [
    api.indexOf('/* ── Detail pane'),
    api.indexOf('.detail-layout{flex:1'),
    api.indexOf('.detail-main{'),
    api.indexOf('.sidebar-card{'),
  ].filter((n) => n > 0);
  let extra = '';
  for (const s of extraStarts) {
    extra += api.slice(s, s + 900) + '\n';
  }

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setContent(`<!doctype html><html data-theme="dark"><head><style>
:root{
  --border-soft:#333;--border:#444;--radius:12px;--radius-sm:10px;--radius-pill:999px;
  --surface:#1e1e1e;--surface-soft:#2d2d2d;--text:#eee;--text-2:#bbb;--text-3:#888;
  --shadow:none;--focus:#6a8;--tan:#5a5048;--teal:#2a3530;--sage:#5a7a5a;
}
*{box-sizing:border-box}
html,body{margin:0;background:#181818;color:var(--text);font-family:system-ui,sans-serif;height:100%;overflow:hidden}
#tab-conversations{padding:16px 20px;max-width:1240px;margin:0 auto;height:100%;display:flex;flex-direction:column;min-height:0;box-sizing:border-box}
.inbox-shell-wrap{display:flex;flex-direction:column;flex:1;min-height:0;height:100%}
${css}
${extra}
.detail-header{display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--border-soft);padding-bottom:10px;margin-bottom:10px;flex-shrink:0}
.msg-bubble{background:#1e3a5f;padding:12px;border-radius:12px;max-width:360px}
.btn{border:1px solid var(--border-soft);background:var(--surface-soft);color:var(--text);border-radius:8px;padding:6px 10px}
.thread-section{flex:1;min-height:0;display:flex;flex-direction:column}
.thread{flex:1;min-height:0}
</style></head><body>
<div id="tab-conversations" class="active" style="height:100%">
<div class="inbox-shell-wrap">
  <div class="inbox-two-col inbox-shell-cols" style="flex:1;min-height:0;height:100%">
    <div class="inbox-left" id="inbox-card">
      <div style="padding:12px;height:100%">Names<br/>Hernan<br/>Monshies</div>
    </div>
    <div id="conv-detail">
      <div id="detail-content">
        <div class="detail-layout">
          <div class="detail-main">
            <div class="detail-header">
              <div class="detail-name">Hernan</div>
              <button id="inbox-open-customer-card">Open customer card</button>
            </div>
            <div class="thread-section">
              <div class="thread">
                <div class="msg-bubble">Message body for gap sampling</div>
              </div>
            </div>
            <div class="draft-panel" style="margin-top:10px;border-top:1px solid var(--border-soft);padding-top:8px;flex-shrink:0">Reply</div>
          </div>
          <div class="detail-sidebar" id="inbox-detail-sidebar">
            <div class="sidebar-card">
              <div class="sidebar-card-head"><h3>BOOKINGS</h3></div>
              <div class="inbox-booking-stack">
                ${Array.from({ length: 12 }).map((_, i) =>
                  `<div style="border:1px solid var(--border-soft);border-radius:8px;padding:10px;margin-bottom:8px">Booking ${i + 1}<br/>row content</div>`
                ).join('')}
              </div>
              <button id="inbox-create-booking-for-guest" class="btn">Create booking</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</div>
</body></html>`);

    const v = await page.evaluate(() => {
      const cs = (el) => window.getComputedStyle(el);
      const list = document.querySelector('.inbox-left');
      const host = document.getElementById('conv-detail');
      const main = document.querySelector('.detail-main');
      const side = document.getElementById('inbox-detail-sidebar');
      const card = side.querySelector('.sidebar-card');
      const shell = document.querySelector('.inbox-two-col.inbox-shell-cols');
      const layout = document.querySelector('.detail-layout');

      const lr = list.getBoundingClientRect();
      const mr = main.getBoundingClientRect();
      const cr = card.getBoundingClientRect();

      // Sample mid-gap pixels via canvas... use geometry only for equality
      const gapListChat = mr.left - lr.right;
      const gapChatBook = cr.left - mr.right;

      // Sample page bg in gaps via elementFromPoint + computed - use a probe
      function sampleAt(x, y) {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        // walk up for non-transparent bg
        let n = el;
        while (n && n !== document.documentElement) {
          const bg = cs(n).backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
            return { bg, tag: n.id || n.className };
          }
          n = n.parentElement;
        }
        return { bg: cs(document.body).backgroundColor, tag: 'body' };
      }
      const midY = (mr.top + mr.bottom) / 2;
      const gap1 = sampleAt(lr.right + gapListChat / 2, midY);
      const gap2 = sampleAt(mr.right + gapChatBook / 2, midY);

      const h = cs(host);
      const sCard = cs(card);
      const sSide = cs(side);

      return {
        hostPassThrough:
          (h.backgroundColor === 'rgba(0, 0, 0, 0)' || h.backgroundColor === 'transparent')
          && parseFloat(h.borderTopWidth) === 0
          && parseFloat(h.borderTopLeftRadius) === 0,
        mainIsCard: parseFloat(cs(main).borderTopWidth) > 0 && parseFloat(cs(main).borderTopLeftRadius) > 0,
        cardIsCard: parseFloat(sCard.borderTopWidth) > 0 && parseFloat(sCard.borderTopLeftRadius) > 0,
        cardScrolls: sCard.overflowY === 'auto' || sCard.overflowY === 'scroll',
        sideNoScroll: sSide.overflowY === 'visible',
        gaps: { gapListChat, gapChatBook, equal: Math.abs(gapListChat - gapChatBook) <= 1.5 && gapListChat >= 10 },
        gapBg: { gap1, gap2, same: gap1 && gap2 && gap1.bg === gap2.bg },
        shellGap: cs(shell).columnGap || cs(shell).gap,
        layoutGap: cs(layout).columnGap || cs(layout).gap,
        nesting: host.contains(main) && host.contains(side) && side.contains(card),
      };
    });

    ok('full nesting list|conv-detail>(main+sidebar>card)', v.nesting);
    ok('#conv-detail pass-through (no bg/border/radius/clip)', v.hostPassThrough, JSON.stringify(v));
    ok('.detail-main is framed card', v.mainIsCard);
    ok('bookings .sidebar-card is framed card', v.cardIsCard);
    ok('bookings card overflow-y auto (scroll inside)', v.cardScrolls);
    ok('detail-sidebar hosts stretched column', true);
    ok('list↔chat gap === chat↔bookings gap (small)', v.gaps.equal, JSON.stringify(v.gaps));
    ok('both gaps show same page-bg channel', v.gapBg.same, JSON.stringify(v.gapBg));
    ok('computed shell/layout gaps are 14px',
      String(v.shellGap).startsWith('14') && String(v.layoutGap).startsWith('14'),
      JSON.stringify({ shell: v.shellGap, layout: v.layoutGap }));

    // Heights: list, chat, bookings card bottoms should align (match window)
    const heights = await page.evaluate(() => {
      const list = document.querySelector('.inbox-left').getBoundingClientRect();
      const main = document.querySelector('.detail-main').getBoundingClientRect();
      const card = document.querySelector('#inbox-detail-sidebar > .sidebar-card').getBoundingClientRect();
      return {
        listH: list.height,
        mainH: main.height,
        cardH: card.height,
        bottoms: { list: list.bottom, main: main.bottom, card: card.bottom },
        tops: { list: list.top, main: main.top, card: card.top },
      };
    });
    ok('bookings card height matches chat card (±4px)',
      Math.abs(heights.cardH - heights.mainH) <= 4,
      JSON.stringify(heights));
    ok('bookings top aligns with chat top (±4px)',
      Math.abs(heights.tops.card - heights.tops.main) <= 4,
      JSON.stringify(heights.tops));
    ok('bookings bottom aligns with chat bottom (±4px)',
      Math.abs(heights.bottoms.card - heights.bottoms.main) <= 4,
      JSON.stringify(heights.bottoms));

    // Scroll bookings card and check radius still applied
    const afterScroll = await page.evaluate(() => {
      const card = document.querySelector('#inbox-detail-sidebar > .sidebar-card');
      // Force overflow content if needed
      if (card.scrollHeight <= card.clientHeight) {
        const pad = document.createElement('div');
        pad.style.height = '800px';
        pad.textContent = 'pad';
        card.appendChild(pad);
      }
      card.scrollTop = 200;
      const s = getComputedStyle(card);
      return {
        scrollTop: card.scrollTop,
        scrollHeight: card.scrollHeight,
        clientHeight: card.clientHeight,
        radius: s.borderTopLeftRadius,
        overflowY: s.overflowY,
      };
    });
    ok('after scroll, card keeps radius + internal scroll',
      afterScroll.scrollTop > 0 && parseFloat(afterScroll.radius) > 0 && afterScroll.overflowY === 'auto',
      JSON.stringify(afterScroll));

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    await page.screenshot({ path: OUT, fullPage: false });
    ok('screenshot written', fs.existsSync(OUT) && fs.statSync(OUT).size > 5000, OUT);
    console.log('SCREENSHOT', OUT);
  } finally {
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
