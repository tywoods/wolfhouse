'use strict';

const assert = require('assert');
const { formatServiceRecordInvoiceLineText } = require('./lib/service-record-invoice-line');

function legacyLine(component, mode, unit, total) {
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

function multiLine({ label, offering_key, mode, unit, total, qty = 2 }) {
  return formatServiceRecordInvoiceLineText({
    service_type: 'addon_service',
    service_date: '2026-08-01',
    quantity: qty,
    amount_due_cents: total,
    metadata: {
      course_equipment: true,
      offering_key,
      label,
      course_equipment_mode: mode,
      unit_amount_cents: unit,
      base_unit_cents: unit,
      all_day_surcharge_unit_cents: 0,
      pricing_provenance: 'course_owned_equipment',
    },
  });
}

const cases = [
  // Narrow historical singleton read compatibility
  ['legacy free during-course board', legacyLine('surfboard', 'during_course', 0, 0), /Surfboard — During Course — 2026-08-01 — 2 × €0\.00 = €0\.00/],
  ['legacy extra during-course wetsuit', legacyLine('wetsuit', 'during_course', 400, 800), /Wetsuit — During Course — 2026-08-01 — 2 × €4\.00 = €8\.00/],
  ['legacy all-day board', legacyLine('surfboard', 'all_day', 1200, 2400), /Surfboard — All Day — 2026-08-01 — 2 × €12\.00 = €24\.00/],
  ['legacy all-day wetsuit', legacyLine('wetsuit', 'all_day', 600, 1200), /Wetsuit — All Day — 2026-08-01 — 2 × €6\.00 = €12\.00/],
  // Multi-item course-owned equipment (persisted immutable identity/money)
  ['multi softboard all day', multiLine({
    label: 'Softboard', offering_key: 'softboard', mode: 'all_day', unit: 1500, total: 3000,
  }), /Softboard — All Day — 2 × €15\.00 = €30\.00/],
  ['multi carbon fins during', multiLine({
    label: 'Carbon Fins', offering_key: 'carbon_fins', mode: 'during_course', unit: 200, total: 200, qty: 1,
  }), /Carbon Fins — During Course — 1 × €2\.00 = €2\.00/],
  ['multi same-label distinct key', multiLine({
    label: 'Twin Label', offering_key: 'same_label_b', mode: 'during_course', unit: 222, total: 444,
  }), /Twin Label — During Course — 2 × €2\.22 = €4\.44/],
];

for (const [name, actual, expected] of cases) {
  assert.match(actual, expected, name);
  console.log(`PASS ${name}: ${actual}`);
}
console.log('PASS staff running invoice display invokes production invoice-line owner');
