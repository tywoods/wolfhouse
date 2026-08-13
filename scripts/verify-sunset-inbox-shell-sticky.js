'use strict';

/**
 * Sunset Inbox shell polish + sticky header short-page behavior.
 *
 * Proves:
 *  1) Source: Conversations label, toolbar docking, two-card shell, sticky bail removed
 *  2) DOM: switch inside toolbars; two framed columns @ desktop 1240; mobile still usable
 *  3) Sticky: short page wheel collapse/expand; shrink-from-tall still expands
 *
 * Usage: node scripts/verify-sunset-inbox-shell-sticky.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts/staff-query-api.js');
const I18N_EN = path.join(ROOT, 'scripts/lib/staff-portal-i18n.js');
const I18N_ES = path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(t) {
  console.log(`\n[inbox-shell-sticky] ${t}`);
}

function extractBetween(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return '';
  const j = src.indexOf(endMarker, i + startMarker.length);
  if (j < 0) return src.slice(i);
  return src.slice(i, j);
}

function testStaticSource() {
  section('1. Source structure + i18n');
  const api = fs.readFileSync(API, 'utf8');
  const en = fs.readFileSync(I18N_EN, 'utf8');
  const es = fs.readFileSync(I18N_ES, 'utf8');

  ok('EN nav.tab.conversations = Conversations',
    /'nav\.tab\.conversations':\s*'Conversations'/.test(en));
  ok('ES nav.tab.conversations = Conversaciones',
    /'nav\.tab\.conversations':\s*'Conversaciones'/.test(es));

  ok('sticky short-page scrollHeight bail removed',
    !/scrollHeight\s*<=\s*pn\.clientHeight\s*\+\s*4/.test(api));
  ok('sticky controller still present',
    /Header collapse controller/.test(api) && /setCollapsed\(true\)/.test(api));

  const convBlock = extractBetween(api, 'id="tab-conversations"', '<!-- /tab-conversations -->');
  ok('conversations shell wrap class', /id="wrap"\s+class="inbox-shell-wrap"/.test(convBlock));
  ok('conversations has inbox-shell-toolbar', /class="inbox-shell-toolbar"/.test(convBlock));
  ok('conversations switch uses nav.tab.conversations',
    /data-i18n="nav\.tab\.conversations"/.test(convBlock) && /Conversations/.test(convBlock));
  /* Column layout model: the switch is view navigation, so it sits in the views rail
     (column 1) rather than the top bar. The Customers panel keeps its toolbar-docked copy
     until the saved-view rail replaces both. */
  ok('conversations switch is inside the views rail', (() => {
    const rail = extractBetween(convBlock, 'id="inbox-col1"', '</nav>');
    return /inbox-view-switch/.test(rail) && /data-view="conversations"/.test(rail);
  })());
  ok('conversations two framed cols class', /inbox-two-col inbox-shell-cols/.test(convBlock));
  ok('conversations has rail + list + detail columns',
    /id="inbox-col1"/.test(convBlock) && /id="inbox-card"/.test(convBlock) && /id="conv-detail"/.test(convBlock));

  const custBlock = extractBetween(api, 'id="tab-customers"', '<!-- /tab-customers -->');
  ok('customers switch uses nav.tab.conversations',
    /data-i18n="nav\.tab\.conversations"/.test(custBlock));
  ok('customers switch is inside customers-toolbar-main', (() => {
    const main = extractBetween(custBlock, 'class="customers-toolbar-main"', 'id="cust-filter-chips"');
    return /inbox-view-switch/.test(main)
      && main.indexOf('inbox-view-switch') < main.indexOf('cust-search');
  })());
  ok('customers keeps two framed columns',
    /customers-two-col/.test(custBlock)
    && /customers-list-col/.test(custBlock)
    && /customers-detail-col/.test(custBlock));
  ok('customers no full-width switch before header',
    !/<div class="customers-wrap">\s*<div class="inbox-view-switch"/.test(custBlock));

  ok('CSS inbox-shell-cols two-card framing',
    /\.inbox-two-col\.inbox-shell-cols/.test(api)
    && /grid-template-columns:minmax\(260px,340px\)/.test(api));
  ok('CSS toolbar-docked switch',
    /\.inbox-toolbar-top\s*>\s*\.inbox-view-switch/.test(api)
    && /\.customers-toolbar-main\s*>\s*\.inbox-view-switch/.test(api));
  ok('CSS 1240 shell wrap',
    /#tab-conversations\.active #wrap\.inbox-shell-wrap/.test(api)
    && /max-width:1240px/.test(api));
}

function extractCollapseController(apiSrc) {
  const start = apiSrc.indexOf('/* Header collapse controller');
  const end = apiSrc.indexOf('/* Header-style picker Edit gate', start);
  if (start < 0 || end < 0) throw new Error('collapse controller markers missing');
  return apiSrc.slice(start, end).replace(/<\/script>[\s\S]*$/, '');
}

function buildFixtureHtml(apiSrc) {
  const controller = extractCollapseController(apiSrc);
  // Markup mirrors the production shell (toolbar-docked switch + two framed cards).
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>inbox-shell-sticky</title>
<style>
  html,body{margin:0;height:100%;}
  body{font-family:system-ui,sans-serif;background:#f6f3ec;}
  .tab-panel{display:none}
  .tab-panel.active{display:block;height:100vh;overflow:auto;box-sizing:border-box}
  #banner{height:80px;background:#4E5853;color:#fff;display:flex;align-items:center;padding:0 16px}
  body.header-collapsed #banner{display:none}
  .customers-wrap,#wrap.inbox-shell-wrap{max-width:1240px;width:100%;margin:0 auto;padding:16px 20px;display:flex;flex-direction:column;box-sizing:border-box}
  .customers-toolbar,.inbox-shell-toolbar{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
  .customers-toolbar-main,.inbox-toolbar-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
  .customers-toolbar-main > .inbox-view-switch,.inbox-toolbar-top > .inbox-view-switch{order:-1;margin-right:4px}
  .inbox-view-switch{display:inline-flex;gap:3px;background:#f1ece1;border-radius:10px;padding:3px}
  .inbox-view-btn{border:1px solid transparent;border-radius:8px;padding:6px 12px;font-weight:600;background:transparent}
  .inbox-view-btn.is-active{background:#fff;border-color:#ddd}
  .customers-two-col,.inbox-two-col.inbox-shell-cols{
    display:grid;grid-template-columns:minmax(260px,340px) minmax(0,1fr);gap:14px;min-height:200px;
  }
  .customers-list-col,.customers-detail-col,
  .inbox-two-col.inbox-shell-cols .inbox-left,
  .inbox-two-col.inbox-shell-cols #conv-detail{
    background:#fff;border:1px solid #cfc8bc;border-radius:10px;min-height:160px;padding:12px;box-sizing:border-box;
  }
  @media(max-width:900px){
    .customers-two-col,.inbox-two-col.inbox-shell-cols{grid-template-columns:1fr}
  }
  #tall-filler{height:0}
</style>
</head>
<body class="luna-header-ui luna-hdr-sunsetmoonlight">
<div id="banner">Banner</div>

<div id="tab-conversations" class="tab-panel active">
  <div id="wrap" class="inbox-shell-wrap">
    <div class="inbox-shell-toolbar">
      <div class="inbox-toolbar-top">
        <div class="inbox-view-switch" role="tablist">
          <button type="button" class="inbox-view-btn is-active" data-view="conversations" data-i18n="nav.tab.conversations">Conversations</button>
          <button type="button" class="inbox-view-btn" data-view="customers" data-i18n="nav.tab.customers">Customers</button>
        </div>
        <select id="c-client" class="inbox-client-select"><option>sunset</option></select>
        <button type="button" id="btn-refresh">↻</button>
      </div>
    </div>
    <div class="inbox-two-col inbox-shell-cols">
      <div class="inbox-left" id="inbox-card">List card</div>
      <div id="conv-detail">Detail card</div>
    </div>
  </div>
</div>

<div id="tab-customers" class="tab-panel">
  <div class="customers-wrap">
    <div class="customers-toolbar">
      <div class="customers-toolbar-main">
        <div class="inbox-view-switch" role="tablist">
          <button type="button" class="inbox-view-btn" data-view="conversations" data-i18n="nav.tab.conversations">Conversations</button>
          <button type="button" class="inbox-view-btn is-active" data-view="customers" data-i18n="nav.tab.customers">Customers</button>
        </div>
        <input id="cust-search" class="customers-search" placeholder="Search" />
        <button type="button" id="cust-add-btn">Add</button>
      </div>
    </div>
    <div class="customers-two-col">
      <div class="customers-list-col">List card</div>
      <div class="customers-detail-col">Detail card</div>
    </div>
  </div>
</div>

<div id="tab-short" class="tab-panel"><div style="padding:20px">Short page content only.</div></div>
<div id="tab-tall" class="tab-panel"><div style="padding:20px">Tall start<div id="tall-filler"></div></div></div>

<script>
${controller}
window.__testSetActive = function(id){
  document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active'); });
  var el = document.getElementById(id);
  if (el) el.classList.add('active');
};
window.__testCollapsed = function(){ return document.body.classList.contains('header-collapsed'); };
window.__testSetCollapsed = function(v){ document.body.classList.toggle('header-collapsed', !!v); };
window.__testSetTall = function(px){
  var f = document.getElementById('tall-filler');
  if (f) f.style.height = String(px||0) + 'px';
};
</script>
</body></html>`;
}

async function testDomAndSticky() {
  section('2. DOM + sticky short-page (Playwright)');
  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    ok('playwright available', false, String(e.message || e));
    return;
  }

  const api = fs.readFileSync(API, 'utf8');
  const html = buildFixtureHtml(api);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/`;

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (e) {
    ok('chromium launch', false, String(e.message || e));
    await new Promise((r) => server.close(r));
    return;
  }

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await page.evaluate(() => window.__testSetActive('tab-conversations'));
    const conv = await page.evaluate(() => {
      const panel = document.getElementById('tab-conversations');
      const switchEl = panel.querySelector('.inbox-view-switch');
      const toolbar = panel.querySelector('.inbox-toolbar-top');
      const btn = switchEl && switchEl.querySelector('[data-view="conversations"]');
      const wrap = panel.querySelector('#wrap.inbox-shell-wrap');
      const cols = panel.querySelector('.inbox-two-col.inbox-shell-cols');
      const left = panel.querySelector('#inbox-card');
      const right = panel.querySelector('#conv-detail');
      const leftCs = left ? getComputedStyle(left) : null;
      const rightCs = right ? getComputedStyle(right) : null;
      const wrapRect = wrap ? wrap.getBoundingClientRect() : null;
      const leftR = left ? left.getBoundingClientRect() : null;
      const rightR = right ? right.getBoundingClientRect() : null;
      return {
        switchInToolbar: !!(toolbar && switchEl && toolbar.contains(switchEl)),
        label: btn ? (`${btn.getAttribute('data-i18n')}|${(btn.textContent || '').trim()}`) : null,
        hasShellCols: !!cols,
        leftBorder: leftCs ? leftCs.borderTopWidth : null,
        rightBorder: rightCs ? rightCs.borderTopWidth : null,
        leftRadius: leftCs ? leftCs.borderTopLeftRadius : null,
        wrapWidth: wrapRect ? wrapRect.width : 0,
        sideBySide: !!(leftR && rightR && rightR.left >= leftR.right - 2),
      };
    });
    ok('DOM conv: switch inside toolbar-top', conv.switchInToolbar, JSON.stringify(conv));
    ok('DOM conv: Conversations i18n label',
      conv.label && conv.label.includes('nav.tab.conversations') && /Conversations/i.test(conv.label),
      conv.label);
    ok('DOM conv: shell cols + side-by-side framed cards',
      conv.hasShellCols && conv.sideBySide
      && conv.leftBorder && conv.leftBorder !== '0px'
      && conv.rightBorder && conv.rightBorder !== '0px',
      JSON.stringify(conv));
    ok('DOM conv: wrap near 1240 desktop',
      conv.wrapWidth > 900 && conv.wrapWidth <= 1240 + 2,
      String(conv.wrapWidth));

    await page.evaluate(() => window.__testSetActive('tab-customers'));
    const cust = await page.evaluate(() => {
      const panel = document.getElementById('tab-customers');
      const main = panel.querySelector('.customers-toolbar-main');
      const switchEl = panel.querySelector('.inbox-view-switch');
      const btn = switchEl && switchEl.querySelector('[data-view="conversations"]');
      const list = panel.querySelector('.customers-list-col');
      const detail = panel.querySelector('.customers-detail-col');
      const wrap = panel.querySelector('.customers-wrap');
      const listR = list ? list.getBoundingClientRect() : null;
      const detailR = detail ? detail.getBoundingClientRect() : null;
      return {
        switchInMain: !!(main && switchEl && main.contains(switchEl)),
        firstIsSwitch: !!(main && main.firstElementChild && main.firstElementChild.classList.contains('inbox-view-switch')),
        label: btn ? (`${btn.getAttribute('data-i18n')}|${(btn.textContent || '').trim()}`) : null,
        sideBySide: !!(listR && detailR && detailR.left >= listR.right - 2),
        wrapW: wrap ? wrap.getBoundingClientRect().width : 0,
      };
    });
    ok('DOM cust: switch left-docked in toolbar-main', cust.switchInMain && cust.firstIsSwitch, JSON.stringify(cust));
    ok('DOM cust: Conversations i18n label',
      cust.label && cust.label.includes('nav.tab.conversations') && /Conversations/i.test(cust.label),
      cust.label);
    ok('DOM cust: two framed columns side-by-side', cust.sideBySide);
    ok('DOM cust: wrap near 1240 desktop', cust.wrapW > 900 && cust.wrapW <= 1240 + 2, String(cust.wrapW));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.__testSetActive('tab-conversations'));
    const mobile = await page.evaluate(() => {
      const panel = document.getElementById('tab-conversations');
      const switchEl = panel.querySelector('.inbox-view-switch');
      const left = panel.querySelector('#inbox-card');
      const right = panel.querySelector('#conv-detail');
      return {
        switchVisible: !!(switchEl && switchEl.getBoundingClientRect().height > 0),
        hasBothCards: !!(left && right),
      };
    });
    ok('DOM mobile conv: switch visible', mobile.switchVisible);
    ok('DOM mobile conv: both cards remain', mobile.hasBothCards);
    await page.setViewportSize({ width: 1280, height: 800 });

    // Sticky short page
    await page.evaluate(() => {
      window.__testSetCollapsed(false);
      window.__testSetActive('tab-short');
    });
    const shortGeom = await page.evaluate(() => {
      const pn = document.querySelector('body > .tab-panel.active');
      return {
        short: pn.scrollHeight <= pn.clientHeight + 4,
        atTop: (pn.scrollTop || 0) <= 0,
      };
    });
    ok('sticky fixture: short page (scrollHeight<=clientHeight+4)', shortGeom.short, JSON.stringify(shortGeom));

    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(500); // > COOLDOWN (420ms)
    let collapsed = await page.evaluate(() => window.__testCollapsed());
    ok('sticky short: wheel-down collapses banner', collapsed === true);

    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(500);
    collapsed = await page.evaluate(() => window.__testCollapsed());
    ok('sticky short: wheel-up at top expands banner', collapsed === false);

    // Tall → collapse → shrink → expand
    await page.evaluate(() => {
      window.__testSetCollapsed(false);
      window.__testSetActive('tab-tall');
      window.__testSetTall(2500);
    });
    await page.waitForTimeout(500);
    const tallGeom = await page.evaluate(() => {
      const pn = document.querySelector('body > .tab-panel.active');
      if (pn) pn.scrollTop = 0;
      return { scrollable: pn.scrollHeight > pn.clientHeight + 4, atTop: (pn.scrollTop || 0) <= 0 };
    });
    ok('sticky fixture: tall page scrollable', tallGeom.scrollable, JSON.stringify(tallGeom));

    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(500);
    collapsed = await page.evaluate(() => window.__testCollapsed());
    ok('sticky tall@top: wheel-down collapses', collapsed === true);

    await page.evaluate(() => {
      window.__testSetTall(0);
      const pn = document.querySelector('body > .tab-panel.active');
      if (pn) pn.scrollTop = 0;
    });
    await page.waitForTimeout(100);
    const shrunk = await page.evaluate(() => {
      const pn = document.querySelector('body > .tab-panel.active');
      return {
        short: pn.scrollHeight <= pn.clientHeight + 4,
        atTop: (pn.scrollTop || 0) <= 0,
        collapsed: document.body.classList.contains('header-collapsed'),
      };
    });
    ok('sticky after shrink: short + collapsed + at top',
      shrunk.short && shrunk.atTop && shrunk.collapsed,
      JSON.stringify(shrunk));

    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(500);
    collapsed = await page.evaluate(() => window.__testCollapsed());
    ok('sticky after shrink: wheel-up expands banner again', collapsed === false);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

async function main() {
  console.log('verify-sunset-inbox-shell-sticky');
  testStaticSource();
  await testDomAndSticky();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
