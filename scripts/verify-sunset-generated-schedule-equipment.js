'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
function owner(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert(start >= 0 && end > start, `generated owner ${name} must exist`);
  return source.slice(start, end);
}
const sandbox = { scheduleRowIsCourse: () => false };
vm.createContext(sandbox);
vm.runInContext([
  owner('scheduleOpsParseMetadata', 'scheduleOpsRowQty'),
  owner('scheduleOpsRowQty', 'scheduleOpsIsLessonRow'),
  owner('scheduleOpsIsLessonRow', 'scheduleOpsIsBoardRow'),
  owner('scheduleOpsIsBoardRow', 'scheduleOpsIsWetsuitRow'),
  owner('scheduleOpsIsWetsuitRow', 'scheduleOpsBuildGearIndex'),
  owner('scheduleOpsBuildGearIndex', 'scheduleOpsEquipmentLabel'),
].join('\n'), sandbox);

const DATE = '2026-08-10';
const paid = (bookingId, qty) => ({
  booking_id: bookingId,
  service_date: DATE,
  service_type: 'addon_service',
  quantity: qty,
  metadata: { component: 'full_day_equipment_extension' },
});
const included = (bookingId, component, qty) => ({
  booking_id: bookingId,
  service_date: DATE,
  service_type: component,
  quantity: qty,
  metadata: { component, included_equipment: true },
});

let index = sandbox.scheduleOpsBuildGearIndex([paid('booking-a', 2)], DATE);
assert.deepStrictEqual({ boards: index['booking-a'].boards, wetsuits: index['booking-a'].wetsuits },
  { boards: 2, wetsuits: 2 }, 'paid full-day extension alone increments board + wetsuit demand');

index = sandbox.scheduleOpsBuildGearIndex([
  paid('booking-a', 2), included('booking-a', 'surfboard', 2), included('booking-a', 'wetsuit', 2),
], DATE);
assert.deepStrictEqual({ boards: index['booking-a'].boards, wetsuits: index['booking-a'].wetsuits },
  { boards: 2, wetsuits: 2 }, 'same-booking included and paid rows deduplicate');

index = sandbox.scheduleOpsBuildGearIndex([paid('booking-a', 2), paid('booking-b', 3)], DATE);
assert.strictEqual(Object.values(index).reduce((n, row) => n + row.boards, 0), 5,
  'different bookings add board demand');
assert.strictEqual(Object.values(index).reduce((n, row) => n + row.wetsuits, 0), 5,
  'different bookings add wetsuit demand');

console.log('verify:sunset-generated-schedule-equipment — GREEN 6/6');
