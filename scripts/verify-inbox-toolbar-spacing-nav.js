'use strict';

/**
 * Inbox toolbar equal spacing + Inbox nav stays active on Customers.
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

function main() {
  console.log('verify-inbox-toolbar-spacing-nav');
  const api = fs.readFileSync(API, 'utf8');

  ok('conversations wrap uses --tab-top-gap',
    /#tab-conversations\.active #wrap\.inbox-shell-wrap\{[\s\S]*?padding:var\(--tab-top-gap\) 20px 12px!important/.test(api));
  ok('customers wrap uses --tab-top-gap',
    /\.customers-wrap\{[^}]*padding:var\(--tab-top-gap\) 20px 12px/.test(api));
  ok('inbox-shell-toolbar margin-bottom 10px',
    /\.inbox-shell-toolbar\{[^}]*margin-bottom:10px/.test(api));
  ok('customers-toolbar margin-bottom 10px',
    /\.customers-toolbar\{[^}]*margin-bottom:10px/.test(api));
  ok('customers-header no phantom margin',
    /\.customers-header\{margin:0;padding:0;min-height:0\}/.test(api));
  ok('no customers-header margin-bottom:12px',
    !/\.customers-header\{margin-bottom:12px\}/.test(api));
  ok('switchToTab maps customers → conversations nav',
    /var navTab = \(tab === 'customers'\) \? 'conversations' : tab/.test(api));
  ok('syncNavQuickFlip treats customers as conversations',
    /if \(tab === 'customers'\) tab = 'conversations'/.test(api));
  // Regression: 3-col conversation shell still present
  ok('conversation 3-col shell still present',
    /\.inbox-two-col\.inbox-shell-cols\{/.test(api)
    && /#inbox-detail-sidebar > \.sidebar-card\{/.test(api));
  ok('schedule cards grid still present',
    /\.portal-schedule-cards-grid\{display:grid/.test(api));

  // Browser: spacing + nav active
  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    try {
      // eslint-disable-next-line import/no-dynamic-require
      playwright = require('/opt/data/home/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
    } catch (e2) {
      ok('playwright available', false, e2.message);
      console.log(`\n${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    }
  }

  return (async () => {
    const browser = await playwright.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.setContent(`<!doctype html><html data-theme="dark"><head><style>
:root{--tab-top-gap:24px;--border-soft:#333;--surface:#1e1e1e;--surface-soft:#2a2a2a;--text:#eee;--text-2:#bbb;--sage:#5a7a5a;--primary:#ccc;--cream:#181818;--font-sans:system-ui}
*{box-sizing:border-box}
body{margin:0;background:#181818;color:var(--text);font-family:var(--font-sans)}
#tabs{display:flex;border-bottom:1px solid #333;padding:0 12px;height:48px;align-items:stretch}
.tab-btn{background:none;border:none;border-bottom:3px solid transparent;color:#9d9d9d;padding:0 18px;cursor:pointer}
.tab-btn.active{color:#ccc;border-bottom-color:var(--sage)}
.tab-panel{display:none}
.tab-panel.active{display:flex;flex-direction:column}
#tab-conversations.active #wrap.inbox-shell-wrap{
  max-width:1240px;width:100%;margin:0 auto;padding:var(--tab-top-gap) 20px 12px;display:flex;flex-direction:column;
}
.inbox-shell-toolbar{display:flex;flex-direction:column;gap:8px;margin-bottom:10px;margin-top:0}
.customers-wrap{max-width:1240px;width:100%;margin:0 auto;padding:var(--tab-top-gap) 20px 12px;display:flex;flex-direction:column}
.customers-header{margin:0;padding:0;min-height:0}
.customers-toolbar{display:flex;flex-direction:column;gap:8px;margin-top:0;margin-bottom:10px}
.inbox-two-col{min-height:200px;background:var(--surface);border:1px solid #333;border-radius:10px}
.customers-two-col{min-height:200px;background:var(--surface);border:1px solid #333;border-radius:10px}
.inbox-view-btn.is-active{font-weight:700}
</style></head><body>
<div id="tabs">
  <button class="tab-btn" data-tab="portal-home">Schedule</button>
  <button class="tab-btn active" data-tab="conversations">Inbox</button>
  <button class="tab-btn" data-tab="customers" style="display:none">Customers</button>
</div>
<div id="tab-conversations" class="tab-panel active">
  <div id="wrap" class="inbox-shell-wrap">
    <div class="inbox-shell-toolbar" id="conv-toolbar">
      <button class="inbox-view-btn is-active" data-view="conversations">Conversations</button>
      <button class="inbox-view-btn" data-view="customers">Customers</button>
    </div>
    <div class="inbox-two-col inbox-shell-cols" id="conv-cards">cards</div>
  </div>
</div>
<div id="tab-customers" class="tab-panel">
  <div class="customers-wrap">
    <header class="customers-header"><h1 class="customers-school-heading" style="display:none">—</h1></header>
    <div class="customers-toolbar" id="cust-toolbar">
      <button class="inbox-view-btn" data-view="conversations">Conversations</button>
      <button class="inbox-view-btn is-active" data-view="customers">Customers</button>
    </div>
    <div class="customers-two-col" id="cust-cards">list</div>
  </div>
</div>
<script>
function el(id){ return document.getElementById(id); }
function switchToTab(tab){
  document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.remove('active'); });
  document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active'); });
  var navTab = (tab === 'customers') ? 'conversations' : tab;
  var btn = document.querySelector('.tab-btn[data-tab=\"' + navTab + '\"]');
  if (btn && btn.style.display !== 'none') btn.classList.add('active');
  var panel = el('tab-' + tab);
  if (panel) panel.classList.add('active');
  document.querySelectorAll('.inbox-view-btn').forEach(function(vb){
    vb.classList.toggle('is-active', vb.getAttribute('data-view') === tab);
  });
}
window.switchToTab = switchToTab;
</script>
</body></html>`);

      const gapsConv = await page.evaluate(() => {
        const tabs = document.getElementById('tabs').getBoundingClientRect();
        const toolbar = document.getElementById('conv-toolbar').getBoundingClientRect();
        const cards = document.getElementById('conv-cards').getBoundingClientRect();
        return {
          above: toolbar.top - tabs.bottom,
          below: cards.top - toolbar.bottom,
        };
      });

      await page.evaluate(() => switchToTab('customers'));

      const gapsCust = await page.evaluate(() => {
        const tabs = document.getElementById('tabs').getBoundingClientRect();
        const toolbar = document.getElementById('cust-toolbar').getBoundingClientRect();
        const cards = document.getElementById('cust-cards').getBoundingClientRect();
        const inboxActive = document.querySelector('.tab-btn[data-tab="conversations"]').classList.contains('active');
        const customersBtnActive = document.querySelector('.tab-btn[data-tab="customers"]').classList.contains('active');
        const panelOk = document.getElementById('tab-customers').classList.contains('active')
          && !document.getElementById('tab-conversations').classList.contains('active');
        return {
          above: toolbar.top - tabs.bottom,
          below: cards.top - toolbar.bottom,
          inboxActive,
          customersBtnActive,
          panelOk,
        };
      });

      const allAbove = [gapsConv.above, gapsCust.above];
      const allBelow = [gapsConv.below, gapsCust.below];
      ok('nav→toolbar gaps are 24px (--tab-top-gap) on both tabs',
        allAbove.every((v) => Math.abs(v - 24) <= 1),
        JSON.stringify({ gapsConv, gapsCust }));
      ok('toolbar→content gaps are 10px on both tabs',
        allBelow.every((v) => Math.abs(v - 10) <= 1),
        JSON.stringify({ gapsConv, gapsCust }));
      ok('Customers panel active while Inbox nav highlighted',
        gapsCust.panelOk && gapsCust.inboxActive && !gapsCust.customersBtnActive,
        JSON.stringify(gapsCust));

      await page.evaluate(() => switchToTab('conversations'));
      const back = await page.evaluate(() => ({
        inbox: document.querySelector('.tab-btn[data-tab="conversations"]').classList.contains('active'),
        panel: document.getElementById('tab-conversations').classList.contains('active'),
      }));
      ok('switching back to Conversations keeps Inbox active', back.inbox && back.panel, JSON.stringify(back));
    } finally {
      await browser.close();
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

main();
