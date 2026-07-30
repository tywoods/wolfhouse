'use strict';
const assert = require('assert');
const { getSunsetScheduleGearOnDateQuery } = require('./lib/sunset-schedule-queries');
const sql = getSunsetScheduleGearOnDateQuery();
assert.match(sql, /sr\.service_type\s+IN\s*\('wetsuit',\s*'surfboard'\)/i);
assert.match(sql, /sr\.service_type\s*=\s*'addon_service'/i,
  'Schedule query must include generic addon_service rentals');
assert.match(sql, /sr\.metadata->>'rental_offering'\s*=\s*'true'/i,
  'addon_service admission must be qualified as a rental');
assert.match(sql, /sr\.metadata->>'course_equipment'\s*=\s*'true'/i,
  'Schedule gear query must admit course-owned equipment rows (course_equipment=true)');
assert.match(sql, /NULLIF\(BTRIM\(sr\.metadata->>'offering_key'\),\s*''\)\s+IS NOT NULL/i,
  'generic rental must carry a non-empty stable offering identity');
assert.ok(
  /rental_offering[\s\S]*course_equipment|course_equipment[\s\S]*rental_offering/i.test(sql),
  'standalone rentals and course equipment are independent admission branches',
);
assert.match(sql, /c\.slug\s*=\s*\$1[\s\S]*sr\.client_slug\s*=\s*\$1/i,
  'tenant scope must remain on both booking client and service row');
assert.match(sql, /sqlLocationMatch|location_id|COALESCE/i,
  'location scope must remain present');
assert.match(sql, /sr\.status\s*<>\s*'cancelled'/i,
  'cancelled records remain excluded');
console.log('verify:sunset-generic-rental-schedule-query — PASS');
