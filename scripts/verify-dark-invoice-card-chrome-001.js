#!/usr/bin/env node
'use strict';

/**
 * DARK-INVOICE-CARD-CHROME-001
 * Dark Payment History and Per Guest must match sibling overview cards.
 * The old !important --surface fill is the black slab behind those amounts.
 * Light mode keeps the shared card (surface, radius, soft shadow).
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('  PASS  ' + label); pass += 1; return; }
  console.error('  FAIL  ' + label + (extra ? '  (' + extra + ')' : ''));
  fail += 1;
}

const OVERRIDE = '[data-theme="dark"] .ctx-payment-history-card{background:var(--surface)!important}';
const DARK_CARD = '[data-theme="dark"] .bc-drawer-overview-card{background:#2d2d2d;border-color:#3c3c3c;box-shadow:none}';
const LIGHT_CARD = '.bc-drawer-overview-card{padding:14px 16px;background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius-sm);box-shadow:var(--shadow-soft)}';
const HEADER = ':is(#bc-move-bed,#bc-payment-history-card,#bc-per-guest-card) .bc-card-collapse{';
const DARK_PRICE = '[data-theme="dark"] .bc-guest-pay-price{color:#fff;background:transparent;border-radius:0;font-weight:700}';
const LIGHT_PRICE = '.bc-guest-pay-price{color:#000;background:#fff;border-radius:3px;font-weight:400';

console.log('\nverify-dark-invoice-card-chrome-001\n');
ok('dark surface override is gone', !api.includes(OVERRIDE));
ok('dark overview card is #2d2d2d / #3c3c3c / no shadow', api.includes(DARK_CARD));
ok('light overview card keeps surface, radius, soft shadow', api.includes(LIGHT_CARD));
ok('Payment History and Per Guest share the Move Bed header', api.includes(HEADER));
ok('dark Total amount stays a transparent chip', api.includes(DARK_PRICE));
ok('light Total amount keeps the white chip', api.includes(LIGHT_PRICE));
ok('Per Guest card is an overview card', api.includes('bc-per-guest-card ctx-payment-history-card bc-drawer-overview-card'));
ok('Payment History card is an overview card', api.includes('ctx-payment-history-card bc-drawer-overview-card'));

function rgb(hex) {
  const n = hex.replace('#', '');
  return `rgb(${parseInt(n.slice(0, 2), 16)}, ${parseInt(n.slice(2, 4), 16)}, ${parseInt(n.slice(4, 6), 16)})`;
}

const css = [
  ':root{--surface:#FFFFFF;--border-soft:#e6e0d6;--radius-sm:8px;--shadow-soft:0 1px 2px rgba(0,0,0,.08)}',
  'html[data-theme="dark"]{--surface:#252526}',
  LIGHT_CARD,
  api.includes(OVERRIDE) ? OVERRIDE : '',
  DARK_CARD,
  '.bc-guest-pay-price{color:#000;background:#fff;border-radius:3px;font-weight:400}',
  DARK_PRICE,
  '.bc-guest-pay-owed{color:#9C5742}',
  '[data-theme="dark"] .bc-guest-pay-owed{color:#ffb896}',
].join('\n');

const html = `<!doctype html><html><head><style>${css}</style></head><body>
<section id="light">
  <div id="bc-move-bed" class="bc-drawer-overview-card"><button class="bc-card-collapse"><span class="bc-drawer-card-title">Move Bed</span></button></div>
  <div id="bc-payment-history-card" class="ctx-payment-history-card bc-drawer-overview-card"><button class="bc-card-collapse"><span class="bc-drawer-card-title">Payment History</span></button></div>
  <div id="bc-per-guest-card" class="bc-per-guest-card ctx-payment-history-card bc-drawer-overview-card">
    <span class="bc-guest-pay-price">€325.00</span><span class="bc-guest-pay-owed">€225.00</span>
  </div>
</section>
</body></html>`;

function paint(theme) {
  return `document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});`;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(html);

  async function card(id) {
    return page.locator('#' + id).evaluate((el) => {
      const s = getComputedStyle(el);
      return { background: s.backgroundColor, border: s.borderTopColor, shadow: s.boxShadow, radius: s.borderRadius };
    });
  }
  async function amount(sel) {
    return page.locator(sel).evaluate((el) => getComputedStyle(el).backgroundColor);
  }

  await page.evaluate(paint('dark'));
  const darkHistory = await card('bc-payment-history-card');
  const darkGuest = await card('bc-per-guest-card');
  const darkMove = await card('bc-move-bed');
  const wantBg = rgb('2d2d2d');
  const wantBorder = rgb('3c3c3c');
  ok('dark Payment History matches Move Bed fill', darkHistory.background === darkMove.background && darkHistory.background === wantBg, darkHistory.background + ' vs ' + darkMove.background);
  ok('dark Per Guest matches Move Bed fill', darkGuest.background === darkMove.background && darkGuest.background === wantBg, darkGuest.background);
  ok('dark cards use #3c3c3c border', darkHistory.border === wantBorder && darkGuest.border === wantBorder && darkMove.border === wantBorder, darkHistory.border);
  ok('dark cards have no shadow', darkHistory.shadow === 'none' && darkGuest.shadow === 'none' && darkMove.shadow === 'none', darkHistory.shadow);
  const darkPrice = await amount('#bc-per-guest-card .bc-guest-pay-price');
  const darkOwe = await amount('#bc-per-guest-card .bc-guest-pay-owed');
  ok('dark Total amount has no opaque fill', darkPrice === 'rgba(0, 0, 0, 0)', darkPrice);
  ok('dark Owe amount has no opaque fill', darkOwe === 'rgba(0, 0, 0, 0)', darkOwe);

  await page.evaluate(paint('light'));
  const lightHistory = await card('bc-payment-history-card');
  const lightGuest = await card('bc-per-guest-card');
  const lightMove = await card('bc-move-bed');
  ok('light Payment History matches Move Bed', lightHistory.background === lightMove.background && lightHistory.border === lightMove.border && lightHistory.shadow === lightMove.shadow && lightHistory.radius === lightMove.radius, JSON.stringify(lightHistory));
  ok('light Per Guest matches Move Bed', lightGuest.background === lightMove.background && lightGuest.shadow === lightMove.shadow, JSON.stringify(lightGuest));
  ok('light cards keep a soft shadow', lightMove.shadow !== 'none', lightMove.shadow);
  ok('light cards keep radius', lightMove.radius === '8px', lightMove.radius);
  const lightPrice = await amount('#bc-per-guest-card .bc-guest-pay-price');
  ok('light Total amount keeps the white chip', lightPrice === 'rgb(255, 255, 255)', lightPrice);

  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
