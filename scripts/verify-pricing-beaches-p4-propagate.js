'use strict';

const assert = require('assert');
const { CATALOG_CHANNELS, buildSunsetCatalogCommand, executeSunsetCatalog } = require('./lib/luna-front-desk-catalog-service');
const { resolveCourseScopedLessonAvailability } = require('./lib/sunset-lesson-availability');
const { quoteSunsetGroupLessonsAsync } = require('./lib/sunset-group-lesson-quote');

const LOC = 'sunset-somo';
const COURSE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const registry = [
  { client_slug: 'sunset', location_id: LOC, beach_key: 'somo', display_name: 'Somo Central', active: true },
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
    if (/tenant_surf_beaches/.test(sql)) return { rows: registry.filter((r) => r.client_slug === params[0] && r.beach_key === params[1]) };
    if (/tenant_surf_pack_rules/.test(sql)) return { rows: cfg.surf_packs.map((p) => ({ id: p.pack_id, label: p.label, config_json: { group_size: p.group_size, beaches: p.beaches, weekly: p.weekly, schedules: p.schedules, price_tiers: p.price_tiers } })) };
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
  ok('catalog registry lookup uses trusted scope, not transport overrides', db.calls.some((c) => /tenant_surf_beaches/.test(c.sql) && c.params[0] === 'sunset'));

  const availability = await resolveCourseScopedLessonAvailability(db, { clientSlug: 'sunset', locationId: LOC, dateIso: '2027-06-10', quantity: 2, slotTime: '10:00', beachKey: 'somo' });
  ok('runtime availability resolves and emits same identity', availability.ok && availability.beach.beach_key === offering.beach.beach_key && availability.seats_available === 9);

  const quote = await quoteSunsetGroupLessonsAsync({ clientSlug: 'sunset', locationId: LOC, body: { service_dates: ['2027-06-10'], quantity: 2, beach_key: 'somo' }, pgClient: db, adminCfg: { ok: true, source: 'db', prices: [{ category: 'lesson', offering_key: 'lesson_slot_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee__session', unit: 'session', amount_cents: 4200, active: true, source: 'db', pricing_status: 'confirmed', effective_state: 'db' }] }, refDate: new Date('2026-01-01T00:00:00Z') });
  ok('runtime quote resolves and emits same identity without owning price', quote.ok && quote.beach.beach_key === offering.beach.beach_key && quote.total_cents === 8400);

  for (const [key, reason] of [['ghost', 'unknown_beach'], ['closed', 'inactive_beach'], ['foreign', 'foreign_property_beach']]) {
    const out = await quoteSunsetGroupLessonsAsync({ clientSlug: 'sunset', locationId: LOC, body: { service_dates: ['2027-06-10'], beach_key: key }, pgClient: db, adminCfg: { ok: true, source: 'db', prices: [{ category: 'lesson', offering_key: 'lesson_slot_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee__session', unit: 'session', amount_cents: 4200, active: true, source: 'db', pricing_status: 'confirmed', effective_state: 'db' }] }, refDate: new Date('2026-01-01T00:00:00Z') });
    ok(`${key} fails closed through runtime quote`, !out.ok && out.reason === reason);
  }
  const override = buildSunsetCatalogCommand({ channel: CATALOG_CHANNELS.LUNA_WHATSAPP, trustedLocationId: LOC, transportBody: { beach_key: 'somo', client_slug: 'wolfhouse', location_id: 'sunset-sardinero', require_db: true } });
  const protectedResult = await executeSunsetCatalog(db, override.command, { adminCfg: cfg });
  ok('request cannot override trusted tenant/property', protectedResult.ok && protectedResult.body.location_id === LOC);
  ok('registry read performs no writes', !db.calls.some((c) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(c.sql)));
  console.log('\nverify:pricing-beaches-p4-propagate OK');
})().catch((err) => { console.error(err.stack || err); process.exit(1); });
