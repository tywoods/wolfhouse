#!/usr/bin/env node
'use strict';

/**
 * BOOKING-HEADER-BALANCE-PEBBLE-001
 * Balance due / Paid sits in the booking-card header's right column, below
 * the pin and arrow and right-aligned with them. Guest rows with no package
 * keep a blank slot so bed and payment pebbles stay aligned.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const invoice = fs.readFileSync(path.join(__dirname, 'browser/booking-invoice.js'), 'utf8');
let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); pass += 1; return; }
  console.error('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
  fail += 1;
}

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

console.log('\nverify-booking-header-balance-pebble-001\n');

ok('header row is a two-column grid', api.includes('.bc-side-head-row{display:grid;grid-template-columns:minmax(7.5em,1fr) minmax(0,210px);grid-template-areas:"title actions" "meta pebbles"'));
ok('pebble host is the right column', api.includes('.bc-side-header-pebbles{grid-area:pebbles;justify-self:end;align-self:center'));
ok('pebble host is not under the title', !api.includes('<div class="bc-side-head-main">') && api.includes('<div class="bc-side-header-pebbles" id="bc-side-header-pebbles"></div>'));
const head = api.slice(api.indexOf('<header class="bc-side-head">'), api.indexOf('</header>', api.indexOf('<header class="bc-side-head">')));
ok('pebble markup follows the pin/arrow controls', head.indexOf('bc-side-close') < head.indexOf('bc-side-header-pebbles'));
ok('meta stays in the header, not inside the pebble host', head.indexOf('id="bc-side-meta"') > 0 && head.indexOf('id="bc-side-meta"') < head.indexOf('bc-side-header-pebbles'));
ok('balance copy is unchanged', api.includes("html += '<span class=\"pill pill-orange\">Balance due '"));
ok('paid copy is unchanged', api.includes("html += '<span class=\"pill pill-green\">Paid</span>'"));
ok('dropdown still says No package', api.includes("if (!c || c === 'no_package' || c === 'package_none') return 'No package';"));
ok('guest row does not paint the No package label', !extractFunction(api, 'bcGuestPackageChipHtml').includes('>No package<'));
ok('empty package is a reserved slot', extractFunction(api, 'bcGuestPackageChipHtml').includes('bc-guest-package-slot'));
ok('invoice styles keep the slot in column 2', invoice.includes(".bc-guest-package-pebble{grid-column:2}") && invoice.includes('.bc-guest-package-slot{min-width:4.75em'));

const sandbox = {
  escHtml: (s) => String(s == null ? '' : s),
  window: {},
  bcAccommodationPayPebbleHtml: (n) => '<span class="bc-accom-pay-pebble">' + (n === 1 ? 'Paid' : 'Unpaid') + '</span>',
};
vm.createContext(sandbox);
vm.runInContext([
  extractFunction(api, 'bcFieldEditPackageDisplayLabel'),
  extractFunction(api, 'bcPackagePebbleClass'),
  extractFunction(api, 'bcGuestPackageChipHtml'),
  extractFunction(api, 'bcGuestNameBedDisplayHtml'),
].join('\n'), sandbox);

const packages = [
  { guest_number: 1, package_code: 'no_package' },
  { guest_number: 2, package_code: 'malibu' },
  { guest_number: 3, package_code: 'package_none' },
  { guest_number: 4, package_code: 'waimea' },
];
const empty = sandbox.bcGuestPackageChipHtml(1, packages);
const malibu = sandbox.bcGuestPackageChipHtml(2, packages);
const none = sandbox.bcGuestPackageChipHtml(3, packages);
const waimea = sandbox.bcGuestPackageChipHtml(4, packages);
ok('no_package is a blank slot', empty.includes('bc-guest-package-slot') && !empty.includes('No package'), empty);
ok('package_none is a blank slot', none.includes('bc-guest-package-slot') && !none.includes('No package'), none);
ok('packaged row keeps its pebble', malibu.includes('>Malibu<') && malibu.includes('bc-guest-package-pebble') && !malibu.includes('bc-guest-package-slot'), malibu);
ok('another package stays labeled', waimea.includes('>Waimea<') && !waimea.includes('No package'), waimea);

const rows = sandbox.bcGuestNameBedDisplayHtml([
  { guest_number: 1, guest_name: 'Ray', assigned_bed_code: 'R1-B2' },
  { guest_number: 2, guest_name: 'Rob', assigned_bed_code: 'R1-B3' },
  { guest_number: 4, guest_name: 'Roy', assigned_bed_code: 'R1-B5' },
], 'Ray', [], false, packages);
ok('guest rows do not say No package', !rows.includes('No package'), rows);
ok('blank slot is in the no-package row', rows.slice(rows.indexOf('Ray'), rows.indexOf('Rob')).includes('bc-guest-package-slot'));
ok('packaged guest keeps Malibu', rows.includes('>Malibu<') && rows.includes('>Waimea<'));
const ray = rows.slice(rows.indexOf('Ray'), rows.indexOf('Rob'));
ok('blank slot precedes the bed', ray.indexOf('bc-guest-package-slot') >= 0 && ray.indexOf('bc-guest-package-slot') < ray.indexOf('bc-guest-bed'));

async function geometry() {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) { console.log('  SKIP  playwright geometry — ' + e.message); return; }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
    const headerCss = api.slice(api.indexOf('/* BOOKING-HEADER-BALANCE-PEBBLE-001'), api.indexOf('.bc-side-pin,.bc-side-close{'));
    const pinCss = api.slice(api.indexOf('.bc-side-pin,.bc-side-close{'), api.indexOf('.bc-side-pin svg{'));
    await page.setContent('<style>' + headerCss + pinCss + '.bc-side-head{width:360px;box-sizing:border-box;padding:10px 12px 8px}</style>' +
      '<header class="bc-side-head"><div class="bc-side-head-row">' +
      '<div class="bc-side-title-row"><h2 class="bc-side-title bc-side-title-code" id="bc-side-title">MB-WOLFHO-20261005-1e1ee7</h2></div>' +
      '<div class="bc-side-head-actions"><button class="bc-side-pin" id="bc-side-pin"></button><button class="bc-side-close" id="bc-side-close">→</button></div>' +
      '<p class="bc-side-meta" id="bc-side-meta"><span class="bc-side-dates">Oct 5 → Oct 11</span><span class="bc-side-stay">6 nights · 4 guests</span><span class="bc-guest-services">4× surfboard\n4× wetsuit\n4× yoga</span></p>' +
      '<div class="bc-side-header-pebbles" id="bc-side-header-pebbles"><span class="bc-detail-meta"><span class="pill pill-orange">Balance due €1125.00</span></span></div>' +
      '</div></header>');
    const box = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
      const head = document.querySelector('.bc-side-head').getBoundingClientRect();
      return { title: r('bc-side-title'), pin: r('bc-side-pin'), close: r('bc-side-close'), chips: r('bc-side-header-pebbles'), head: head.toJSON(), text: document.getElementById('bc-side-header-pebbles').innerText };
    });
    ok('fixture keeps Balance due €1125.00', box.text.includes('Balance due €1125.00'), box.text);
    ok('pebble below pin', box.chips.top >= box.pin.bottom - 1, JSON.stringify(box));
    ok('pebble below arrow', box.chips.top >= box.close.bottom - 1, JSON.stringify(box));
    ok('pebble right-aligned with arrow', Math.abs(box.chips.right - box.close.right) <= 4, JSON.stringify(box));
    ok('pebble does not overlap pin or arrow', box.chips.top >= box.pin.bottom - 1 && box.chips.top >= box.close.bottom - 1, JSON.stringify(box));
    ok('pebble is not beside the booking code', box.chips.left > box.title.right - 8 || box.chips.top >= box.title.bottom, JSON.stringify(box));
    ok('pebble stays inside the header', box.chips.right <= box.head.right + 1 && box.chips.left >= box.head.left, JSON.stringify(box));

    const guestCss = invoice.slice(invoice.indexOf("guestScope + '#bc-guest-names{"), invoice.indexOf('document.head.appendChild(style);'));
    const guestRules = guestCss.replace(/guestScope \+ '/g, '#bc-guest-names ').replace(/'\s*\+\s*$/gm, '').replace(/';/g, '');
    await page.setContent('<style>' +
      '#bc-guest-names{display:grid;grid-template-columns:minmax(40px,1fr) max-content max-content max-content;column-gap:6px;width:320px}' +
      '#bc-guest-names .bc-guest-name-row{display:grid;grid-column:1/-1;grid-template-columns:subgrid;align-items:center;gap:6px}' +
      '#bc-guest-names .bc-guest-name-line{grid-column:1}' +
      '#bc-guest-names .bc-guest-pebble-line{display:contents}' +
      '#bc-guest-names .bc-guest-package-pebble{grid-column:2}' +
      '#bc-guest-names .bc-guest-bed{grid-column:3;background:#e8f4fd;padding:2px 10px}' +
      '#bc-guest-names .bc-accom-pay-pebble{grid-column:4;padding:2px 8px}' +
      '#bc-guest-names .bc-guest-package-slot{min-width:4.75em;width:auto;padding:0;visibility:hidden}' +
      '.pkg-pebble{padding:2px 8px;border-radius:999px;background:#E4E4E4}' +
      '</style><div id="bc-guest-names">' + rows + '</div>');
    const align = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.bc-guest-name-row')];
      return rows.map((row) => {
        const bed = row.querySelector('.bc-guest-bed').getBoundingClientRect();
        const pay = row.querySelector('.bc-accom-pay-pebble').getBoundingClientRect();
        const slot = row.querySelector('.bc-guest-package-pebble');
        return {
          name: row.querySelector('.bc-guest-name-line').textContent,
          label: slot.textContent,
          slot: slot.className,
          bedLeft: bed.left,
          payLeft: pay.left,
        };
      });
    });
    ok('measured three guest rows', align.length === 3, JSON.stringify(align));
    const bedLefts = align.map((r) => r.bedLeft);
    const payLefts = align.map((r) => r.payLeft);
    ok('beds stay aligned across no-package and packaged rows', Math.max(...bedLefts) - Math.min(...bedLefts) <= 1, JSON.stringify(align));
    ok('payment pebbles stay aligned', Math.max(...payLefts) - Math.min(...payLefts) <= 1, JSON.stringify(align));
    ok('Ray slot has no No package label', align[0].name === 'Ray' && align[0].label === '' && align[0].slot.includes('bc-guest-package-slot'), JSON.stringify(align));
    ok('Rob still shows Malibu', align.some((r) => r.name === 'Rob' && r.label === 'Malibu'));
    void guestRules;
  } finally {
    await browser.close();
  }
}

geometry().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
