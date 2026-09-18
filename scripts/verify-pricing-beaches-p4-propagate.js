'use strict';

process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { CATALOG_CHANNELS, buildSunsetCatalogCommand, executeSunsetCatalog } = require('./lib/luna-front-desk-catalog-service');
const { resolveCourseScopedLessonAvailability } = require('./lib/sunset-lesson-availability');
const { quoteSunsetGroupLessonsAsync } = require('./lib/sunset-group-lesson-quote');
const { QUOTE_CHANNELS, buildSunsetQuoteCommand, executeSunsetQuote } = require('./lib/luna-front-desk-quote-service');
const { applyBeachToCatalogProjection } = require('./lib/sunset-beach-propagation');

const LOC = 'sunset-somo';
const COURSE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const registry = [
  { client_slug: 'sunset', location_id: LOC, beach_key: 'somo', display_name: 'Somo Central', active: true },
  { client_slug: 'sunset', location_id: LOC, beach_key: 'other', display_name: 'Other', active: true },
  { client_slug: 'sunset', location_id: LOC, beach_key: 'closed', display_name: 'Closed', active: false },
  { client_slug: 'sunset', location_id: 'sunset-sardinero', beach_key: 'foreign', display_name: 'Foreign', active: true },
];
const cfg = {
  ok: true, source: 'db', currency: 'EUR',
  surf_packs: [{ pack_id: COURSE, label: 'Course', active: true, group_size: 12, beaches: ['somo'], weekly: 'daily', schedules: ['1000_1200'], price_tiers: [{ key: 'day', label: 'Day', hours: 2, amount_cents: 4200 }] }],
  prices: [{ id: 'price-1', category: 'package', offering_key: `surf_pack_${COURSE}__day`, item_code: `surf_pack_${COURSE}__day`, amount_cents: 4200, unit: 'day', active: true, currency: 'EUR' }],
};
function pg() {
  const calls = [];
  return { calls, query: async (sql, params) => {
    calls.push({ sql: String(sql), params });
    if (/tenant_surf_beaches/.test(sql)) return { rows: registry.filter((r) => r.client_slug === params[0] && r.location_id === params[1] && r.beach_key === params[2]) };
    if (/tenant_surf_pack_rules/.test(sql)) return { rows: cfg.surf_packs.map((p) => ({ id: p.pack_id, label: p.label, config_json: { group_size: p.group_size, beaches: p.beaches, weekly: p.weekly, schedules: p.schedules, price_tiers: p.price_tiers } })) };
    if (/to_regclass/.test(sql)) return { rows: [{ reg: 'tenant_price_rules' }] };
    if (/information_schema\.columns/.test(sql)) return { rows: [{ exists: true }] };
    if (/tenant_price_rules/.test(sql)) return { rows: [{ id: 'price-1', amount_cents: 4200, currency: 'EUR', item_type: 'package', item_code: `surf_pack_${COURSE}__day`, unit: 'day', location_id: LOC }] };
    if (/COALESCE\(SUM/.test(sql)) return { rows: [{ seats: 3 }] };
    if (/tenant_business_config/.test(sql)) return { rows: [] };
    return { rows: [] };
  } };
}
function ok(label, condition) { assert.ok(condition, label); console.log(`  PASS ${label}`); }

(async () => {
  console.log('\nverify:pricing-beaches-p4-propagate runtime seams\n');

  const db = pg();
  const built = buildSunsetCatalogCommand({ channel: CATALOG_CHANNELS.LUNA_WHATSAPP, trustedLocationId: LOC, transportBody: { beach_key: 'somo', require_db: true } });
  const catalog = await executeSunsetCatalog(db, built.command, { adminCfg: cfg });
  const offering = catalog.ok && catalog.body.courses.find((o) => o.course_id === COURSE);

  ok('public Luna catalog resolves registry identity', offering && offering.beach && offering.beach.beach_key === 'somo' && offering.beach.display_name === 'Somo Central');
  ok('catalog registry lookup binds trusted tenant and property scope', db.calls.some((c) => /WHERE client_slug = \$1 AND location_id = \$2 AND beach_key = \$3/.test(c.sql.replace(/\s+/g, ' ')) && c.params[0] === 'sunset' && c.params[1] === LOC && c.params[2] === 'somo'));

  const availability = await resolveCourseScopedLessonAvailability(db, { clientSlug: 'sunset', locationId: LOC, dateIso: '2027-06-10', quantity: 2, slotTime: '10:00', beachKey: 'somo' });
  ok('runtime availability resolves and emits same identity', availability.ok && availability.beach.beach_key === offering.beach.beach_key && availability.seats_available === 9);
  const pluginSource = fs.readFileSync(path.join(__dirname, '..', 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'), 'utf8');
  const availabilityTool = pluginSource.slice(pluginSource.indexOf('def get_sunset_lesson_availability'), pluginSource.indexOf('def get_sunset_joinable_courses'));
  const availabilitySchema = pluginSource.slice(pluginSource.indexOf('(\"get_sunset_lesson_availability\"'), pluginSource.indexOf('(\"get_sunset_joinable_courses\"'));
  ok('production Luna availability forwards beach_key', /body\[\"beach_key\"\]\s*=/.test(availabilityTool));
  ok('production Luna availability schema accepts beach_key', /\"beach_key\"\s*:/.test(availabilitySchema));
  const catalogTool = pluginSource.slice(pluginSource.indexOf('def _get_sunset_lesson_catalog_impl'), pluginSource.indexOf('def get_sunset_lesson_catalog'));
  const catalogSchema = pluginSource.slice(pluginSource.indexOf('(\"get_sunset_lesson_catalog\"'), pluginSource.indexOf('(\"get_sunset_offering_quote\"'));
  ok('production Luna catalog forwards beach_key', /body\[\"beach_key\"\]\s*=\s*payload\[\"beach_key\"\]/.test(catalogTool));
  ok('production Luna catalog schema accepts optional beach_key', /\"beach_key\"\s*:/.test(catalogSchema) && !/\[\s*\"beach_key\"\s*\]/.test(catalogSchema));
  const pluginRegression = spawnSync(process.env.PYTHON || 'python3', [path.join(__dirname, '..', 'docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_rental_catalog_tool.py')], { encoding: 'utf8' });
  ok('production Luna catalog plugin runtime regression passes', pluginRegression.status === 0 && /lesson catalog forwards exact beach_key/.test(pluginRegression.stdout));
  const staffSource = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  ok('Staff beach-only requests enter course-scoped availability', /if \(beachKey \|\| slotTime \|\| courseId\)/.test(staffSource));

  const exact = catalog.body.offerings.find((o) => o.course_id === COURSE);
  ok('beach resolves to exact course price identity', exact && exact.offering_id === `surf_pack_${COURSE}__day` && exact.price_identity.item_code === exact.offering_id && exact.price.amount_cents === 4200);
  const projected = { courses: [{ course_id: COURSE, beaches: ['somo'] }], offerings: [{ offering_type: 'course', course_id: COURSE, active: true, bookable: true, offering_id: exact.offering_id, unit_amount_cents: 4200, price_identity: { item_code: exact.offering_id } }] };
  ok('inactive course fails closed', applyBeachToCatalogProjection({ ...projected, offerings: projected.offerings.map((o) => ({ ...o, active: false })) }, { beach_key: 'somo' }).reason === 'beach_course_unpriced');
  ok('unpriced course fails closed', applyBeachToCatalogProjection({ ...projected, offerings: projected.offerings.map((o) => ({ ...o, unit_amount_cents: null, bookable: false })) }, { beach_key: 'somo' }).reason === 'beach_course_unpriced');
  ok('ambiguous active courses fail closed', applyBeachToCatalogProjection({ courses: [...projected.courses, { course_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', beaches: ['somo'] }], offerings: [...projected.offerings, { ...projected.offerings[0], course_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', offering_id: 'surf_pack_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee__day', price_identity: { item_code: 'surf_pack_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee__day' } }] }, { beach_key: 'somo' }).reason === 'ambiguous_beach_course');
  const quote = await executeSunsetQuote(db, buildSunsetQuoteCommand({ channel: QUOTE_CHANNELS.LUNA_WHATSAPP, trustedLocationId: LOC, transportBody: { offering_id: exact.offering_id, course_id: COURSE, tier_key: 'day', service_dates: ['2027-06-10'], quantity: 2, beach_key: 'somo', require_db: true } }).command, { adminCfg: cfg });
  ok('canonical Luna quote uses exact course price', quote.ok && quote.body.course_id === COURSE && quote.body.offering_id === exact.offering_id && quote.body.total_cents === 8400);
  ok('canonical Luna quote preserves selected beach identity', quote.ok && quote.body.beach && quote.body.beach.beach_key === offering.beach.beach_key);
  const mismatch = await executeSunsetQuote(db, buildSunsetQuoteCommand({ channel: QUOTE_CHANNELS.LUNA_WHATSAPP, trustedLocationId: LOC, transportBody: { offering_id: 'lesson_slot_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee__session', course_id: COURSE, service_dates: ['2027-06-10'], quantity: 2, beach_key: 'somo', require_db: true } }).command, { adminCfg: cfg });
  ok('mismatched generic lesson price identity is rejected', !mismatch.ok && !(mismatch.body && Number.isInteger(mismatch.body.total_cents)));
  const legacy = await quoteSunsetGroupLessonsAsync({ clientSlug: 'sunset', locationId: LOC, body: { service_dates: ['2027-06-10'], quantity: 2, beach_key: 'somo' }, pgClient: db, adminCfg: { ...cfg, prices: [{ category: 'lesson', offering_key: 'lesson_slot_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee__session', unit: 'session', amount_cents: 9999, active: true }] }, refDate: new Date('2026-01-01T00:00:00Z') });
  ok('beach-scoped legacy quote fails closed', !legacy.ok && legacy.reason === 'beach_course_quote_required');

  const disallowedQuote = await executeSunsetCatalog(db, buildSunsetCatalogCommand({ channel: CATALOG_CHANNELS.LUNA_WHATSAPP, trustedLocationId: LOC, transportBody: { beach_key: 'other', require_db: true } }).command, { adminCfg: cfg });
  ok('active but course-disallowed beach fails closed', !disallowedQuote.ok && disallowedQuote.body.reason === 'beach_course_unavailable');

  for (const [key, reason] of [['ghost', 'unknown_beach'], ['closed', 'inactive_beach'], ['foreign', 'unknown_beach']]) {
    const out = await quoteSunsetGroupLessonsAsync({ clientSlug: 'sunset', locationId: LOC, body: { service_dates: ['2027-06-10'], beach_key: key }, pgClient: db, adminCfg: cfg, refDate: new Date('2026-01-01T00:00:00Z') });
    ok(`${key} fails closed through runtime quote`, !out.ok && out.reason === reason);
  }
  const override = buildSunsetCatalogCommand({ channel: CATALOG_CHANNELS.LUNA_WHATSAPP, trustedLocationId: LOC, transportBody: { beach_key: 'somo', client_slug: 'wolfhouse', location_id: 'sunset-sardinero', require_db: true } });
  const protectedResult = await executeSunsetCatalog(db, override.command, { adminCfg: cfg });
  ok('request cannot override trusted tenant/property', protectedResult.ok && protectedResult.body.location_id === LOC);
  ok('registry read performs no writes', !db.calls.some((c) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(c.sql)));
  console.log('\nverify:pricing-beaches-p4-propagate OK');
})().catch((err) => { console.error(err.stack || err); process.exit(1); });
