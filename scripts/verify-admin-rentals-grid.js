#!/usr/bin/env node
'use strict';

/**
 * ADMIN-RENTALS-GRID-001 — Rentals cards sit side by side and wrap.
 * Wolfhouse Admin Pricing subsections and Sunset equipment rows were
 * full-width stacks. Both stay editable; Add rental / edit pencils stay.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const wh = fs.readFileSync(path.join(ROOT, 'scripts/browser/wolfhouse-admin-pricing-ui.js'), 'utf8');
const sunset = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');

let failed = 0;
function ok(name, cond) {
  if (cond) console.log('  PASS  ' + name);
  else { console.error('  FAIL  ' + name); failed += 1; }
}

function sliceFn(src, name) {
  const start = src.indexOf('function ' + name);
  if (start < 0) return '';
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

const rentalsFn = sliceFn(wh, 'renderRentalsSection');
const servicesFn = sliceFn(wh, 'renderServicesSection');

ok('Wolfhouse rentals render into a grid',
  rentalsFn.includes('portal-admin-rentals-grid')
  && rentalsFn.includes('rentalCards'));
ok('Add rental stays in the Rentals header',
  rentalsFn.includes("'+ ' + whT('admin.wh.pricing.addRental', 'Add rental')")
  && rentalsFn.includes('data-wh-item-type="rental"'));
ok('rental edit pencil stays',
  rentalsFn.includes("pencilBtn('edit-rental-price'"));
ok('services are not pulled into the rentals grid',
  servicesFn && !servicesFn.includes('portal-admin-rentals-grid'));
ok('Sunset equipment list is a wrapping grid, not a column',
  /portal-admin-equip-list\{display:grid;grid-template-columns:repeat\(auto-fill,minmax\(260px,1fr\)\)/.test(api)
  && !/portal-admin-equip-list\{display:flex;flex-direction:column/.test(api));
ok('an open Sunset rental editor spans the row',
  api.includes('.portal-admin-equip-row.is-editing{grid-column:1 / -1}'));
ok('Wolfhouse grid rule is scoped to Admin Pricing',
  api.includes('#wh-admin-pricing-body .portal-admin-rentals-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))'));
ok('Sunset edit pencil and add control stay',
  sunset.includes('data-admin-action="edit-equipment"')
  && sunset.includes('admin.prices.addEquipment'));
ok('this slice does not set font-weight 800',
  !/font-weight:\s*800/.test(api.match(/portal-admin-rentals-grid\{[^}]+\}/)[0] || '')
  && !/font-weight:\s*800/.test(api.match(/portal-admin-equip-list\{[^}]+\}/)[0] || ''));

function cssRules() {
  const want = [
    '.portal-admin-equip-list{',
    '.portal-admin-equip-row{',
    '.portal-admin-equip-row.is-editing{',
    '.portal-admin-equip-list > .portal-admin-equip-row > .portal-admin-equip-compact{',
    '.portal-admin-equip-compact{',
    '#wh-admin-pricing-body .portal-admin-rentals-grid{',
    '#wh-admin-pricing-body .portal-admin-rentals-grid > .portal-admin-subsection{',
    '#wh-admin-pricing-body .portal-admin-rentals-grid > .portal-admin-subsection:has(.is-editing){',
  ];
  return want.map((needle) => {
    const i = api.indexOf(needle);
    if (i < 0) throw new Error('missing rule ' + needle);
    return api.slice(i, api.indexOf('}', i) + 1);
  }).join('\n');
}

function pageHtml() {
  const cards = ['Wetsuit rental', 'Soft board rental', 'Hard board rental'].map((name) => (
    '<div class="portal-admin-subsection">'
    + '<div class="portal-admin-subsection-title">' + name + '</div>'
    + '<div class="portal-admin-price-card"><div class="portal-admin-price-title">1 day</div>'
    + '<button type="button" class="portal-admin-pricing-edit-btn" data-wh-price-action="edit-rental-price">✎</button>'
    + '</div></div>'
  )).join('');
  const rows = ['Wetsuit', 'Soft board', 'Hard board'].map((name) => (
    '<div class="portal-admin-equip-row is-compact">'
    + '<div class="portal-admin-equip-compact"><div class="portal-admin-equip-name">' + name + '</div>'
    + '<button type="button" data-admin-action="edit-equipment">✎</button></div></div>'
  )).join('');
  return '<!doctype html><html><head><style>'
    + ':root{--border-soft:#d9d3c8;--surface-soft:#f6f3ee;--text:#222}'
    + cssRules()
    + '.portal-admin-price-card{min-height:48px}'
    + '</style></head><body>'
    + '<section id="wh-admin-pricing-body"><button type="button" data-wh-item-type="rental">+ Add rental</button>'
    + '<div class="portal-admin-rentals-grid">' + cards + '</div></section>'
    + '<div class="portal-admin-equip-list" data-admin-equip-list="1">' + rows
    + '<div class="portal-admin-equip-row is-editing"><div class="portal-admin-equip-edit-shell">Editing</div></div>'
    + '</div></body></html>';
}

function boxes(page, sel) {
  return page.locator(sel).evaluateAll((nodes) => nodes.map((el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width) };
  }));
}

function sideBySide(list, label) {
  ok(label + ' first two share a row',
    list.length >= 2 && Math.abs(list[0].top - list[1].top) <= 2 && list[1].left >= list[0].right - 4);
  ok(label + ' cards fill the row',
    list.length >= 2 && list[0].width >= 240 && list[1].width >= 240);
}

function stacked(list, label) {
  ok(label + ' wraps to one column',
    list.length >= 2 && list[1].top >= list[0].bottom - 2 && Math.abs(list[0].left - list[1].left) <= 2);
}

async function main() {
  const playwrightPath = [
    path.join(ROOT, 'node_modules/playwright'),
    '/opt/data/workspace/apply-proof-invoice-drop-payment-guest-names-001/node_modules/playwright',
  ].find((p) => fs.existsSync(p));
  if (!playwrightPath) throw new Error('playwright not installed');
  const { chromium } = require(playwrightPath);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(pageHtml());
  sideBySide(await boxes(page, '#wh-admin-pricing-body .portal-admin-rentals-grid > .portal-admin-subsection'), 'Wolfhouse wide');
  sideBySide(await boxes(page, '.portal-admin-equip-list > .portal-admin-equip-row.is-compact'), 'Sunset wide');
  const editor = (await boxes(page, '.portal-admin-equip-row.is-editing'))[0];
  const list = (await boxes(page, '.portal-admin-equip-list'))[0];
  ok('open Sunset editor uses the full row',
    editor && list && editor.width >= list.width - 4);
  ok('Add rental and edit stay clickable in the fixture',
    (await page.locator('[data-wh-item-type="rental"]').count()) === 1
    && (await page.locator('[data-wh-price-action="edit-rental-price"]').count()) === 3
    && (await page.locator('[data-admin-action="edit-equipment"]').count()) === 3);

  await page.setViewportSize({ width: 400, height: 900 });
  stacked(await boxes(page, '#wh-admin-pricing-body .portal-admin-rentals-grid > .portal-admin-subsection'), 'Wolfhouse narrow');
  stacked(await boxes(page, '.portal-admin-equip-list > .portal-admin-equip-row.is-compact'), 'Sunset narrow');
  await browser.close();

  if (failed) {
    console.error('\n' + failed + ' failed');
    process.exit(1);
  }
  console.log('\nverify-admin-rentals-grid: passed');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
