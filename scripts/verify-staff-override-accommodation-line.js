'use strict';

/**
 * Saved Staff Create Booking with a nightly override must show that amount
 * on the invoice accommodation line, not a live catalog re-quote of Malibu.
 *
 * Lunabot WH-20270914-02809207: 1 guest, 14–17 Sep 2027, override €40/night.
 * Total €120 is correct; the accommodation line still showed catalog €135.
 *
 * Run: node scripts/verify-staff-override-accommodation-line.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  staffManualOverrideAccommodationCents,
} = require('./lib/staff-manual-override-accommodation-line');

const booking = {
  package_code: 'manual_override',
  guest_count: 1,
  check_in: '2027-09-14',
  check_out: '2027-09-17',
  total_amount_cents: 12000,
};

const metadata = {
  guest_packages: [{ guest_number: 1, package_code: 'malibu' }],
  quote_snapshot: {
    package_code: 'manual_override',
    total_cents: 12000,
    line_items: [{
      code: 'manual_accommodation',
      unit_cents: 4000,
      nights: 3,
      guest_count: 1,
      total_cents: 12000,
    }],
  },
};

assert.equal(
  staffManualOverrideAccommodationCents(booking, metadata),
  12000,
  'override line is €120, not catalog Malibu',
);

const staleSnapshot = {
  guest_packages: [{ guest_number: 1, package_code: 'malibu' }],
  quote_snapshot: {
    total_cents: 12000,
    line_items: [{
      code: 'guest_package_proration',
      unit_cents: 4500,
      nights: 3,
      guest_count: 1,
      total_cents: 13500,
    }],
  },
};
assert.equal(
  staffManualOverrideAccommodationCents(booking, staleSnapshot),
  12000,
  'package_code=manual_override wins over a leftover catalog line',
);

assert.equal(
  staffManualOverrideAccommodationCents(
    { package_code: 'malibu', total_amount_cents: 13500 },
    { guest_packages: [{ guest_number: 1, package_code: 'malibu' }] },
  ),
  null,
  'normal Malibu bookings keep live catalog lines',
);

const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
assert.ok(
  apiSrc.includes('staffManualOverrideAccommodationCents'),
  'booking context must use the override line instead of re-quoting guest_packages',
);

console.log('PASS staff override accommodation line matches saved override');
