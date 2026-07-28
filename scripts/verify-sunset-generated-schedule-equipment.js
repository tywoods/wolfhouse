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
sandbox.portalT = (key) => ({
  'schedule.equipment.both': 'board + wetsuit',
  'schedule.equipment.boardOnly': 'board only',
  'schedule.equipment.wetsuitOnly': 'wetsuit only',
  'schedule.equipment.none': 'no equipment',
}[key] || key);
vm.createContext(sandbox);
vm.runInContext([
  owner('scheduleOpsParseMetadata', 'scheduleOpsRowQty'),
  owner('scheduleOpsRowQty', 'scheduleOpsIsLessonRow'),
  owner('scheduleOpsIsLessonRow', 'scheduleOpsIsBoardRow'),
  owner('scheduleOpsIsBoardRow', 'scheduleOpsIsWetsuitRow'),
  owner('scheduleOpsIsWetsuitRow', 'scheduleOpsBuildGearIndex'),
  owner('scheduleOpsBuildGearIndex', 'scheduleOpsEquipmentLabel'),
  owner('scheduleOpsEquipmentLabel', 'scheduleOpsRowSourceLabel'),
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

const noCodeLesson = { booking_id: 'booking-a', service_date: DATE, service_type: 'lesson', quantity: 2 };
assert.strictEqual(sandbox.scheduleOpsEquipmentLabel(noCodeLesson, index), 'board + wetsuit',
  'generated label consumer resolves booking_id when booking_code is absent');

index = sandbox.scheduleOpsBuildGearIndex([
  { ...included('cancelled-service', 'surfboard', 9), status: 'cancelled' },
  { ...included('cancelled-booking', 'wetsuit', 8), booking_status: 'cancelled' },
], DATE);
assert.deepStrictEqual(Object.keys(index), [], 'cancelled service and booking rows cannot contribute');

console.log('verify:sunset-generated-schedule-equipment — GREEN 8/8');
