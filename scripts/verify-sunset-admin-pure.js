'use strict';

/**
 * verify:sunset-admin-pure
 *
 * Unit parity tests for scripts/lib/sunset-admin-ui-helpers.js (mirror of browser helpers).
 * No Playwright, staging, or portal wiring required.
 *
 * Run: node scripts/verify-sunset-admin-pure.js
 *      npm run verify:sunset-admin-pure
 */

const fs = require('fs');
const path = require('path');
const {
  adminHumanizeText,
  adminSlotTimeStart,
  adminSlotTimeEnd,
  adminSlotDurationLabel,
  adminParseTimeHm,
  adminParseCapacity,
  getSunsetAdminBrowserHelperSource,
} = require('./lib/sunset-admin-ui-helpers');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return true;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
  return false;
}

function runStaticInlineHelperChecks() {
  console.log('\n[1] Injected admin helper source (staff-query-api.js + pure module)\n');
  const src = fs.readFileSync(STAFF_API, 'utf8');
  const browserSrc = getSunsetAdminBrowserHelperSource();
  const names = [
    'adminHumanizeText',
    'adminSlotTimeStart',
    'adminSlotTimeEnd',
    'adminSlotDurationLabel',
    'adminParseTimeHm',
    'adminParseCapacity',
  ];
  assert('getSunsetAdminBrowserHelperSource() wired in staff-query-api.js',
    src.includes('getSunsetAdminBrowserHelperSource()'));
  assert('injection marker comment present',
    src.includes('sunset-admin-ui-helpers: injected'));
  for (const name of names) {
    assert(`no duplicate inline function ${name}( in staff-query-api.js`,
      !new RegExp(`function ${name}\\s*\\(`).test(src));
    assert(`browser source defines ${name}(`, new RegExp(`function ${name}\\s*\\(`).test(browserSrc));
  }
  assert('adminHumanizeText whitespace regex intact', browserSrc.includes('text.replace(/\\s+/g'));
  assert('adminHumanizeText 1 hour boundary intact',
    browserSrc.includes("new RegExp('\\\\b1 hour\\\\b'"));
}

function runHumanizeTests() {
  console.log('\n[2] adminHumanizeText parity\n');

  assert('empty → em dash', adminHumanizeText('') === '—');
  assert('cfg prefix stripped', adminHumanizeText('cfg:sunset:foo_bar') === 'Foo bar');
  assert('underscores → spaces', adminHumanizeText('wetsuit_rental') === 'Wetsuit rental');
  assert('Wetsuit rental preserves s',
    adminHumanizeText('Wetsuit rental').toLowerCase().includes('wetsuit'));
  assert('surf lesson intact', adminHumanizeText('adult surf lesson').toLowerCase().includes('surf lesson'));
  assert('adolescent intact',
    adminHumanizeText('Adult / adolescent group surf lesson').toLowerCase().includes('adolescent'));
  assert('no wet uit corruption', !adminHumanizeText('Wetsuit rental').toLowerCase().includes('wet uit'));
  assert('no urf le on corruption',
    !adminHumanizeText('adult surf lesson').toLowerCase().includes('urf le on'));
  assert('no adole cent corruption',
    !adminHumanizeText('adolescent').toLowerCase().includes('adole cent'));
  assert('day pack surfer suffix trimmed',
    adminHumanizeText('3 day pack surfer') === '3 day pack');
  assert('collapses whitespace', adminHumanizeText('foo   bar') === 'Foo bar');
}

function runSlotTimeTests() {
  console.log('\n[3] Slot time start / end / duration\n');

  assert('11:00-13:00 start', adminSlotTimeStart('11:00-13:00') === '11:00');
  assert('11:00-13:00 end', adminSlotTimeEnd('11:00-13:00') === '13:00');
  assert('11:00-13:00 duration 2h', adminSlotDurationLabel('11:00-13:00') === '2h');

  assert('09:30-11:00 start', adminSlotTimeStart('09:30-11:00') === '09:30');
  assert('09:30-11:00 end', adminSlotTimeEnd('09:30-11:00') === '11:00');
  assert('09:30-11:00 duration 1h 30m', adminSlotDurationLabel('09:30-11:00') === '1h 30m');

  assert('missing end → duration —', adminSlotDurationLabel('11:00') === '—');
  assert('empty slot → duration —', adminSlotDurationLabel('') === '—');
  assert('invalid range → duration —', adminSlotDurationLabel('13:00-11:00') === '—');
}

function runParseTimeHmTests() {
  console.log('\n[4] adminParseTimeHm\n');

  assert('00:00 valid', adminParseTimeHm('00:00').ok === true);
  assert('23:59 valid', adminParseTimeHm('23:59').ok === true);
  assert('11:00 value', adminParseTimeHm('11:00').value === '11:00');
  assert('24:00 rejected', adminParseTimeHm('24:00').ok === false);
  assert('9:00 rejected (no leading zero)', adminParseTimeHm('9:00').ok === false);
  assert('abc rejected', adminParseTimeHm('abc').ok === false);
  assert('empty rejected', adminParseTimeHm('').ok === false);
}

function runParseCapacityTests() {
  console.log('\n[5] adminParseCapacity\n');

  assert('1 valid', adminParseCapacity('1').ok === true && adminParseCapacity('1').value === 1);
  assert('999 valid', adminParseCapacity('999').ok === true && adminParseCapacity('999').value === 999);
  assert('200 valid', adminParseCapacity('200').value === 200);
  assert('0 rejected', adminParseCapacity('0').ok === false);
  assert('1000 rejected', adminParseCapacity('1000').ok === false);
  assert('empty rejected', adminParseCapacity('').ok === false);
  assert('non-numeric rejected', adminParseCapacity('abc').ok === false);
}

function main() {
  console.log('\nverify:sunset-admin-pure — Sunset Admin pure helper parity\n');
  runStaticInlineHelperChecks();
  runHumanizeTests();
  runSlotTimeTests();
  runParseTimeHmTests();
  runParseCapacityTests();

  console.log('\n' + '─'.repeat(48));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('verify:sunset-admin-pure — FAILED');
    process.exit(1);
  }
  console.log('verify:sunset-admin-pure — ALL CHECKS PASSED');
}

main();
