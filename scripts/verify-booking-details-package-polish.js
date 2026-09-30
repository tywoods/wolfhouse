#!/usr/bin/env node
'use strict';

/**
 * BOOKING-DETAILS-POLISH-AUDIT-001
 * Package chip belongs to the guest (guest number, not row order).
 * Bottom grouped pile is gone. Top Edit saves via guest-packages.
 * Chip stays in the name column. Phone stacks contact and dates.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
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

console.log('\nverify-booking-details-package-polish\n');

ok('name span stays name-only', apiSrc.includes("'<span class=\"bc-guest-name-line\">' + escHtml(name)"));
ok('chip is not inside the name span', !apiSrc.includes("bc-guest-name-line\">' + escHtml(name) + bcGuestPackageChipHtml"));
ok('bottom package pile removed from booking details', !apiSrc.includes("kvBCHtml(t('drawer.field.package'), bcRenderPackagePebblesHtml"));
ok('private room stays in the package group', apiSrc.includes('var packageKv = bcPrivateRoomReadKv(bcBookingPrivateRoomEnabled(bk));'));
ok('phone email dates language source strings remain', ['drawer.field.phone', 'drawer.field.email', 'drawer.field.checkIn', 'drawer.field.language', 'drawer.field.source'].every(k => apiSrc.includes(k)));
ok('top save posts guest-packages', apiSrc.includes("fetch('/staff/bookings/' + encodeURIComponent(code) + '/guest-packages'"));
ok('reload after inline save', /bcFieldEditPostGuestPackages\(packagePackages\)[\s\S]{0,180}loadBlockDetail\(code\)/.test(apiSrc));
ok('menu label uses the guest name', apiSrc.includes('function bcPackageGuestMenuLabel(gn, guests)'));
ok('select id kept for the standalone editor', apiSrc.includes("id=\"bc-field-package-select-' + gn + '\""));
ok('chip sits on the pebble line under the name', apiSrc.includes('bc-guest-pebble-line') && apiSrc.includes('#bc-drawer-card-booking .bc-guest-pebble-line{display:flex'));
ok('name is its own line', apiSrc.includes('#bc-drawer-card-booking .bc-guest-name-row{display:flex;flex-direction:column'));
ok('phone stacks contact and dates', apiSrc.includes('#bc-drawer-card-booking #bc-field-group-contact .ctx-field-kv-grid') && apiSrc.includes('grid-template-columns:minmax(0,1fr)!important'));
ok('services tab may still group pebbles', apiSrc.includes('bc-svc-summary-pebbles'));

const sandbox = {
  window: {},
  escHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
};
vm.createContext(sandbox);
vm.runInContext([
  extractFunction(apiSrc, 'bcFieldEditPackageDisplayLabel'),
  extractFunction(apiSrc, 'bcPackagePebbleClass'),
  extractFunction(apiSrc, 'bcGuestPackageChipHtml'),
  extractFunction(apiSrc, 'bcGuestNameBedDisplayHtml'),
  extractFunction(apiSrc, 'bcPackageGuestMenuLabel'),
].join('\n'), sandbox);

const guests = [
  { guest_number: 2, guest_name: 'Sam', assigned_bed_code: 'R2-B5' },
  { guest_number: 1, guest_name: 'Alexandra', assigned_bed_code: 'R2-B4' },
];
const packages = [
  { guest_number: 1, package_code: 'uluwatu' },
  { guest_number: 2, package_code: 'malibu' },
];
const html = sandbox.bcGuestNameBedDisplayHtml(guests, 'Alexandra', [], false, packages);
ok('lead still first', html.indexOf('Alexandra') < html.indexOf('Sam'), html);
ok('name span is the name only', /<span class="bc-guest-name-line">Alexandra<\/span>/.test(html));
const alex = html.slice(html.indexOf('Alexandra'), html.indexOf('Sam'));
const sam = html.slice(html.indexOf('Sam'));
const row = html.slice(html.indexOf('bc-guest-name-row'), html.indexOf('Sam'));
ok('pebbles follow the name', row.indexOf('bc-guest-name-line') < row.indexOf('bc-guest-pebble-line'));
ok('package then bed on the pebble line', (() => {
  const line = row.slice(row.indexOf('bc-guest-pebble-line'));
  const pkg = line.indexOf('bc-guest-package-pebble');
  const bed = line.indexOf('bc-guest-bed');
  const pay = line.indexOf('bc-accom-pay-pebble');
  return pkg >= 0 && bed > pkg && (pay < 0 || pay > bed);
})());
ok('uluwatu stays with guest 1 even though she is sorted first', alex.includes('Uluwatu') && alex.includes('bc-guest-package-pebble') && !alex.includes('Malibu'), alex);
ok('malibu stays with guest 2, not row order', sam.includes('Malibu') && !sam.includes('Uluwatu'), sam);
ok('no times-count grouping on the guest chip', !/×\d|x\d/.test(html) && !html.includes('\\u00d7'), html);
ok('missing guest gets a blank slot, not another guest chip', (() => {
  const missing = sandbox.bcGuestPackageChipHtml(9, packages);
  return missing.includes('bc-guest-package-slot') && !missing.includes('Uluwatu') && !missing.includes('Malibu') && !missing.includes('No package');
})());
ok('menu label is the guest name', sandbox.bcPackageGuestMenuLabel(2, guests) === 'Sam');
ok('menu label does not invent Guest 2 when the name exists', sandbox.bcPackageGuestMenuLabel(2, guests) !== 'Guest 2');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
