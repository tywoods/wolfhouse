'use strict';

/**
 * verify:sunset-admin-lesson-patch
 *
 * Regression guard: lesson-time PATCH must not double __session item_codes
 * and must only sync slot price when amount_cents is patched.
 *
 * Run: node scripts/verify-sunset-admin-lesson-patch.js
 */

const fs = require('fs');
const path = require('path');
const {
  mapBaselineUnitToDb,
  buildDbItemCode,
  lessonSlotPriceItemCode,
  isLessonSlotPriceItemCode,
  preparePriceDbPatch,
} = require('./lib/tenant-admin-writes');

const ROOT = path.join(__dirname, '..');
const WRITES = path.join(ROOT, 'scripts', 'lib', 'tenant-admin-writes.js');

let pass = 0;
let fail = 0;

function assert(label, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

const SLOT_ID = '63096926-b9a8-4589-8d58-8ff95a4c5beb';
const ITEM_CODE = lessonSlotPriceItemCode(SLOT_ID);
const LABEL = 'Adult / adolescent group surf lesson (over 12)';

console.log('\nverify:sunset-admin-lesson-patch — lesson PATCH price sidecar guards\n');

console.log('[1] mapBaselineUnitToDb\n');
assert("mapBaselineUnitToDb('session') === 'session'", mapBaselineUnitToDb('session') === 'session');
assert("mapBaselineUnitToDb('1_hour') === 'session'", mapBaselineUnitToDb('1_hour') === 'session');

console.log('\n[2] lesson slot item_code shape\n');
assert('lessonSlotPriceItemCode format', ITEM_CODE === `lesson_slot_${SLOT_ID}__session`);
assert('isLessonSlotPriceItemCode accepts slot code', isLessonSlotPriceItemCode(ITEM_CODE));
assert('isLessonSlotPriceItemCode rejects doubled session',
  !isLessonSlotPriceItemCode(`${ITEM_CODE}__session`));
assert('buildDbItemCode lesson_slot prefix + session',
  buildDbItemCode(`lesson_slot_${SLOT_ID}`, 'session') === ITEM_CODE);

console.log('\n[3] preparePriceDbPatch — no __session__session\n');
const forced = preparePriceDbPatch(
  { display_name: LABEL, amount_cents: 4500, currency: 'EUR' },
  `lesson_slot_${SLOT_ID}`,
  'session',
  { forceItemCode: ITEM_CODE, forceDbUnit: 'session' },
);
assert('forced item_code stable', forced.item_code === ITEM_CODE);
assert('forced unit session', forced.unit === 'session');
assert('forced no double session', !String(forced.item_code).includes('__session__session'));

const fullKey = preparePriceDbPatch(
  { display_name: LABEL, amount_cents: 4500 },
  ITEM_CODE,
  'session',
);
assert('full lesson_slot item_code not doubled', fullKey.item_code === ITEM_CODE);
assert('full key unit session', fullKey.unit === 'session');

const prefixKey = preparePriceDbPatch(
  { display_name: LABEL, amount_cents: 4500 },
  `lesson_slot_${SLOT_ID}`,
  'session',
);
assert('prefix offering builds single __session', prefixKey.item_code === ITEM_CODE);
assert('prefix unit session', prefixKey.unit === 'session');

const labelCost = preparePriceDbPatch(
  { display_name: LABEL, amount_cents: 4500, currency: 'EUR' },
  `lesson_slot_${SLOT_ID}`,
  'session',
  { forceItemCode: ITEM_CODE, forceDbUnit: 'session' },
);
assert('label+amount_cents keeps display_name', labelCost.display_name === LABEL);
assert('label+amount_cents item_code stable', labelCost.item_code === ITEM_CODE);

console.log('\n[4] patchLessonTimeRule static sidecar gate\n');
const src = fs.readFileSync(WRITES, 'utf8');
assert('price sync gated on amount_cents only',
  /if\s*\(\s*amountCentsPatch\s*!=\s*null\s*\)/.test(src));
assert('no priceLabelPatch sidecar trigger',
  !/priceLabelPatch\s*!=\s*null/.test(src));
assert('upsertLessonSlotPriceRule not wrapped in swallow try/catch',
  !/upsertLessonSlotPriceRule[\s\S]{0,120}catch\s*\(priceErr\)/.test(src));
assert('upsertLessonSlotPriceRule passes explicit amountCents',
  /amountCents:\s*amountCentsPatch/.test(src));

console.log('\n[5] upsertLessonSlotPriceRule input shape (static)\n');
assert('offeringKey uses lesson_slot prefix without __session suffix',
  /const offeringKey = `lesson_slot_\$\{slotKey\}`;/.test(src));
assert('itemCode uses lessonSlotPriceItemCode',
  /const itemCode = lessonSlotPriceItemCode\(slotKey\);/.test(src));
assert('forceItemCode passed to upsertConfigPriceRule',
  /forceItemCode:\s*itemCode/.test(src));
assert('forceDbUnit session passed',
  /forceDbUnit:\s*'session'/.test(src));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-admin-lesson-patch — FAILED');
  process.exit(1);
}
console.log('verify:sunset-admin-lesson-patch — ALL CHECKS PASSED');
