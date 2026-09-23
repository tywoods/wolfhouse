#!/usr/bin/env node
'use strict';

/**
 * SCHEDULE-GINA-MULTI-BED-PAINT-001
 *
 * One group booking must not paint the same guest name and money pills on
 * every assigned bed. Sibling bars share a soft accent and a hover target
 * list that can cross rooms. Empty calendar cells are near-white / charcoal,
 * not the warm beige wash.
 *
 * Run: node scripts/verify-schedule-gina-multi-bed-paint.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {
  GROUP_ACCENTS,
  annotateCalendarBlocks,
  groupHoverTargets,
} = require('./lib/staff-calendar-group-paint');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

function block(partial) {
  return Object.assign({
    booking_id: 'booking-gina',
    booking_code: 'WH-GINA',
    guest_name: 'Gina',
    bed_guest_name: 'Gina',
    room_code: 'R8',
    bed_code: 'R8-B1',
    balance_due_cents: 65000,
    calendar_show_deposit_paid: true,
    has_active_payment_link: true,
  }, partial);
}

function ginaFixture() {
  const blocks = [
    block({ bed_code: 'R8-B1', room_code: 'R8' }),
    block({ bed_code: 'R8-B2', room_code: 'R8' }),
    block({ bed_code: 'R8-B3', room_code: 'R8' }),
    block({
      booking_id: 'booking-other',
      booking_code: 'WH-OTHER',
      guest_name: 'Sam',
      bed_guest_name: 'Sam',
      room_code: 'R2',
      bed_code: 'R2-B1',
    }),
    block({
      booking_id: 'booking-gina',
      bed_code: 'R2-B4',
      room_code: 'R2',
    }),
  ];
  const guests = [
    { booking_id: 'booking-gina', guest_number: 1, guest_name: 'Gina', assigned_bed_code: 'R8-B1', assigned_room_code: 'R8' },
    { booking_id: 'booking-gina', guest_number: 2, guest_name: 'Jamie', assigned_bed_code: 'R8-B2', assigned_room_code: 'R8' },
    { booking_id: 'booking-gina', guest_number: 3, guest_name: 'Tina', assigned_bed_code: 'R8-B3', assigned_room_code: 'R8' },
    { booking_id: 'booking-gina', guest_number: 4, guest_name: 'Noah', assigned_bed_code: 'R2-B4', assigned_room_code: 'R2' },
  ];
  return annotateCalendarBlocks(blocks, guests);
}

function assertGinaPaint() {
  const rows = ginaFixture();
  const gina = rows.filter((row) => row.booking_id === 'booking-gina');
  const byBed = Object.fromEntries(gina.map((row) => [row.bed_code, row]));
  assert.strictEqual(byBed['R8-B1'].guest_name, 'Gina');
  assert.strictEqual(byBed['R8-B2'].guest_name, 'Jamie');
  assert.strictEqual(byBed['R8-B3'].guest_name, 'Tina');
  assert.strictEqual(byBed['R2-B4'].guest_name, 'Noah');
  assert.strictEqual(byBed['R8-B1'].calendar_show_payment_pills, true, 'money stays on the primary bed');
  assert.strictEqual(byBed['R8-B2'].calendar_show_payment_pills, false);
  assert.strictEqual(byBed['R8-B3'].calendar_show_payment_pills, false);
  assert.strictEqual(byBed['R2-B4'].calendar_show_payment_pills, false);
  const accents = new Set(gina.map((row) => row.calendar_group_accent));
  assert.strictEqual(accents.size, 1, 'one group shares one accent');
  assert.ok(GROUP_ACCENTS.includes(gina[0].calendar_group_accent));
  assert.notStrictEqual(rows.find((row) => row.booking_id === 'booking-other').calendar_group_accent, gina[0].calendar_group_accent);
  assert.strictEqual(rows.find((row) => row.booking_id === 'booking-other').calendar_show_payment_pills, true);
  assert.strictEqual(rows.find((row) => row.booking_id === 'booking-other').calendar_group_accent, null, 'a solo bar is not a group');

  const hovered = byBed['R8-B2'];
  const targets = groupHoverTargets(rows, hovered);
  assert.strictEqual(targets.length, 4);
  assert.ok(targets.some((row) => row.room_code === 'R2' && row.bed_code === 'R2-B4'), 'hover includes a sibling in another room');
  assert.ok(!targets.some((row) => row.booking_id === 'booking-other'));
}

function assertClonedWriteStillSplitsPills() {
  const blocks = annotateCalendarBlocks([
    block({ bed_code: 'R8-B1' }),
    block({ bed_code: 'R8-B2' }),
    block({ bed_code: 'R8-B3' }),
  ], []);
  const pills = blocks.filter((row) => row.calendar_show_payment_pills);
  assert.strictEqual(pills.length, 1, 'cloned Gina rows still show money once');
  assert.strictEqual(pills[0].bed_code, 'R8-B1');
}

function assertSource() {
  assert.ok(apiSrc.includes("background:#F7F8F8"), 'light empty cells are near-white');
  assert.ok(apiSrc.includes('[data-theme="dark"] .bc-day-cell:not(:has(.bc-block)){background:#2A2A2C}'), 'dark empty cells are neutral charcoal');
  assert.ok(!apiSrc.includes('rgba(240,236,228'), 'warm beige empty-cell wash is gone');
  assert.ok(apiSrc.includes('calendar_show_payment_pills === false'), 'sibling bars skip money pills');
  assert.ok(apiSrc.includes('data-group-key'), 'bars carry a group key');
  assert.ok(apiSrc.includes('function bcSetGroupHover'), 'hover paints every sibling');
  assert.ok(apiSrc.includes('0 2px 10px rgba(68,80,74,.15)'), 'group hover reuses the existing shadow');
  assert.ok(apiSrc.includes('annotateCalendarBlocks('), 'calendar response is annotated');
  assert.ok(/FROM booking_guests bg[\s\S]*c\.slug = \$2/.test(apiSrc), 'guest names are tenant-scoped');
  assert.ok(apiSrc.includes('--chip-balance-bg:#F5E0D0'), 'pebble tokens were not retouched');
  assert.ok(apiSrc.includes('.portal-admin-bookings-chip--paid{color:#86efac'), 'bookings status chips were not retouched');
}

function main() {
  assertGinaPaint();
  assertClonedWriteStillSplitsPills();
  assertSource();
  console.log('verify-schedule-gina-multi-bed-paint: PASS');
}

main();
