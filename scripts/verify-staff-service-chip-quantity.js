'use strict';

const fs = require('fs');
const path = require('path');
const {
  formatPaidServiceSummaryLine,
  staffServiceChipQuantity,
  buildPaidRequestedSummaryLines,
} = require('./lib/staff-booking-services-schedule');

let passed = 0;
let failed = 0;

function check(id, ok, msg) {
  if (ok) { passed += 1; return; }
  failed += 1;
  console.error(`FAIL ${id}: ${msg}`);
}

check('QTY1', staffServiceChipQuantity({ quantity: 2 }) === 2, 'quantity 2');
check('QTY2', staffServiceChipQuantity({ quantity: 1, people_count: 2 }) === 2, 'people_count 2');
check('QTY3', staffServiceChipQuantity({ quantity: 1 }) === 1, 'single qty');

{
  const line = formatPaidServiceSummaryLine({
    service_name: 'Hard board',
    service_type: 'surfboard',
    quantity: 2,
    total_price_cents: 4000,
  });
  check('CHIP1', line === 'Hard board ×2 — €40.00', `2-guest hardboard (${line})`);
  check('CHIP2', !/×1/.test(line), 'no ×1 on multi');
}

{
  const line = formatPaidServiceSummaryLine({
    service_name: 'Hard board',
    quantity: 1,
    total_price_cents: 2000,
  });
  check('CHIP3', line === 'Hard board — €20.00', `single hardboard (${line})`);
  check('CHIP4', !/×/.test(line), 'single has no multiplier');
}

{
  const line = formatPaidServiceSummaryLine({
    service_name: 'Wetsuit',
    quantity: 2,
    total_price_cents: 3000,
  });
  check('CHIP5', line === 'Wetsuit ×2 — €30.00', `wetsuit ×2 (${line})`);
}

{
  const line = formatPaidServiceSummaryLine({
    service_name: 'Surf lesson',
    service_type: 'surf_lesson',
    quantity: 3,
    total_price_cents: 13500,
  });
  check('CHIP6', line === 'Surf lesson ×3 — €135.00', `lesson ×3 (${line})`);
}

{
  const agg = buildPaidRequestedSummaryLines([
    {
      service_type: 'surfboard',
      service_name: 'Hard board',
      quantity: 1,
      total_price_cents: 2000,
      amount_due_cents: 2000,
      color_class: 'bc-svc-color-board',
    },
    {
      service_type: 'surfboard',
      service_name: 'Hard board',
      quantity: 1,
      total_price_cents: 2000,
      amount_due_cents: 2000,
      color_class: 'bc-svc-color-board',
    },
  ]);
  check('AGG1', agg.length === 1, 'aggregates two hard board rows');
  check('AGG2', agg[0].summary_line === 'Hard board ×2 — €40.00', `aggregated line (${agg[0].summary_line})`);
}

{
  const apiPath = path.join(__dirname, 'staff-query-api.js');
  const src = fs.readFileSync(apiPath, 'utf8');
  check('SRC1', src.includes('function bcFormatServiceChipText'), 'portal chip formatter');
  check('SRC2', src.includes('function bcServiceChipQuantity'), 'portal qty helper');
  check('SRC3', src.includes("name + ' \\u00d7' + qty"), 'chip ×qty in portal JS');
}

console.log(`\nverify-staff-service-chip-quantity: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
