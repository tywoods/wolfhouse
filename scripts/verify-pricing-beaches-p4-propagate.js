'use strict';

const assert = require('assert');
const { projectStableBeachIdentity, selectCourseForBeach } = require('./lib/sunset-beach-propagation');
const { nestCatalogOffering } = require('./lib/luna-front-desk-catalog-service');
const { buildCourseSlotAvailabilityResult } = require('./lib/sunset-lesson-availability');
const { buildGroupLessonQuoteResult } = require('./lib/sunset-group-lesson-quote');

let passed = 0;
function ok(label, value) { assert.ok(value, label); passed += 1; console.log(`  PASS ${label}`); }

const registry = [
  { client_slug: 'sunset', location_id: 'sunset-somo', beach_key: 'somo', display_name: 'Somo', active: true },
  { client_slug: 'sunset', location_id: 'sunset-somo', beach_key: 'loredo', display_name: 'Loredo', active: true },
  { client_slug: 'sunset', location_id: 'sunset-sardinero', beach_key: 'somo', display_name: 'Foreign Somo', active: true },
  { client_slug: 'sunset', location_id: 'sunset-somo', beach_key: 'closed', display_name: 'Closed', active: false },
];
const course = { course_id: 'course-1', beaches: ['somo'], capacity: 12, seats_booked: 3, seats_remaining: 9 };

console.log('\nverify:pricing-beaches-p4-propagate\n');
const identity = projectStableBeachIdentity({ clientSlug: 'sunset', locationId: 'sunset-somo', beachKey: 'somo', registry });
ok('registry resolves stable key and label', identity.ok && identity.beach.beach_key === 'somo' && identity.beach.display_name === 'Somo');
for (const [label, args, reason] of [
  ['unknown beach fails closed', { beachKey: 'ghost' }, 'unknown_beach'],
  ['inactive beach fails closed', { beachKey: 'closed' }, 'inactive_beach'],
  ['foreign-property beach fails closed', { beachKey: 'somo', locationId: 'sunset-liencres' }, 'foreign_property_beach'],
]) {
  const out = projectStableBeachIdentity({ clientSlug: 'sunset', locationId: 'sunset-somo', registry, ...args });
  ok(label, !out.ok && out.reason === reason);
}

const selected = selectCourseForBeach([course], identity.beach);
ok('catalog course selection keeps stable key', selected.ok && selected.course.beach.beach_key === 'somo');
const catalog = nestCatalogOffering({ offering_id: 'surf_pack_course-1__day', offering_type: 'course', label: 'Course', active: true, bookable: true, unit_amount_cents: 4200, billing_unit: 'day', course_id: 'course-1', beach: selected.course.beach, beaches: ['somo'] });
ok('catalog emits stable beach identity', catalog.beach.beach_key === 'somo' && catalog.beach.display_name === 'Somo');
const availability = buildCourseSlotAvailabilityResult({ course: selected.course, quantity: 2, dateIso: '2027-06-10', locationId: 'sunset-somo', slotTime: '10:00' });
ok('availability propagates identical beach identity', availability.beach.beach_key === catalog.beach.beach_key);
const quote = buildGroupLessonQuoteResult('sunset-somo', { service_dates: ['2027-06-10'], quantity: 2, date_count: 1, beach: availability.beach }, 4200, { source: 'db' });
ok('quote and Luna-facing truth retain identical beach identity', quote.beach.beach_key === catalog.beach.beach_key && quote.total_cents === 8400);

const renamed = projectStableBeachIdentity({ clientSlug: 'sunset', locationId: 'sunset-somo', beachKey: 'somo', registry: registry.map((r) => r.beach_key === 'somo' && r.location_id === 'sunset-somo' ? { ...r, display_name: 'Somo Central' } : r) });
ok('label rename does not alter stable identity', renamed.beach.beach_key === 'somo' && renamed.beach.display_name === 'Somo Central');
ok('label rename cannot alter authoritative price/capacity', quote.unit_amount_cents === 4200 && availability.course_capacity === 12 && availability.seats_available === 9);
ok('beach projection contains no fabricated price/capacity', !('amount_cents' in identity.beach) && !('capacity' in identity.beach));
ok('read path exposes no send/write/payment side effects', !/send|insert|update|delete|stripe|payment/i.test(projectStableBeachIdentity.toString()));
const wolfhouse = projectStableBeachIdentity({ clientSlug: 'wolfhouse', locationId: 'wolfhouse-somo', beachKey: 'somo', registry });
ok('Wolfhouse remains outside Sunset propagation', !wolfhouse.ok && wolfhouse.reason === 'invalid_tenant');
console.log(`\n${passed} passed — verify:pricing-beaches-p4-propagate OK`);
