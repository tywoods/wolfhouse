'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const waiver = require('./lib/sunset-waiver-booking');

assert.strictEqual(typeof waiver.bookingCreateResultNeedsWaiver, 'function',
  'bookingCreateResultNeedsWaiver must exist');
assert.strictEqual(waiver.bookingCreateResultNeedsWaiver({
  records: [{ _scheduleType: 'rental', service_type: 'rental' }],
}), false, 'rental-only create must not request a lesson waiver');
assert.strictEqual(waiver.bookingCreateResultNeedsWaiver({
  records: [{ _scheduleType: 'rental' }, { _scheduleType: 'course' }],
}), true, 'mixed course+rental create must request a lesson waiver');
assert.strictEqual(waiver.bookingCreateResultNeedsWaiver({
  records: [{ service_type: 'private_lesson' }],
}), true, 'private lesson create must request a lesson waiver');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
assert(api.includes('bookingCreateResultNeedsWaiver(bodyOut)'),
  'create route must gate waiver creation from authoritative created records');
console.log('verify:sunset-rental-create-waiver-boundary — PASS');
