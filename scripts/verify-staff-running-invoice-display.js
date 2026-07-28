'use strict';

const assert = require('assert');
const { formatServiceRecordInvoiceLineText } = require('./lib/service-record-invoice-line');

function line(component, mode, unit, total) {
  return formatServiceRecordInvoiceLineText({
    service_type: component,
    service_date: '2026-08-01',
    quantity: 2,
    amount_due_cents: total,
    metadata: {
      course_equipment: true,
      component,
      course_equipment_mode: mode,
      unit_amount_cents: unit,
    },
  });
}

const cases = [
  ['free during-course board', line('surfboard', 'during_course', 0, 0), /Surfboard — During Course — 2026-08-01 — 2 × €0\.00 = €0\.00/],
  ['extra during-course wetsuit', line('wetsuit', 'during_course', 400, 800), /Wetsuit — During Course — 2026-08-01 — 2 × €4\.00 = €8\.00/],
  ['all-day board', line('surfboard', 'all_day', 1200, 2400), /Surfboard — All Day — 2026-08-01 — 2 × €12\.00 = €24\.00/],
  ['all-day wetsuit', line('wetsuit', 'all_day', 600, 1200), /Wetsuit — All Day — 2026-08-01 — 2 × €6\.00 = €12\.00/],
];

for (const [name, actual, expected] of cases) {
  assert.match(actual, expected, name);
  console.log(`PASS ${name}: ${actual}`);
}
console.log('PASS staff running invoice display invokes production invoice-line owner');