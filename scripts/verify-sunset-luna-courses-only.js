'use strict';

/**
 * verify:sunset-luna-courses-only
 *
 * TDD gate — Luna must offer ONLY admin-configured COURSES (surf packs) and
 * private lessons. Standalone group lessons (€30/€45 slots) must not appear in
 * discovery, catalog, or quote tools.
 *
 * Run:
 *   node scripts/verify-sunset-luna-courses-only.js
 */

const fs = require('fs');
const path = require('path');
const {
  listJoinableSunsetOfferings,
} = require('./lib/sunset-admin-course-join');
const {
  buildSunsetLunaCatalogFromConfig,
} = require('./lib/sunset-luna-admin-catalog');

let pass = 0;
let fail = 0;
function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

const ROOT = path.resolve(__dirname, '..');
const pluginSrc = fs.readFileSync(
  path.join(ROOT, 'docker', 'hermes-staging', 'plugins', 'wolfhouse_staff_api', '__init__.py'),
  'utf8',
);
const PACK_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SLOT_ID = '11111111-2222-4333-8444-555555555555';
const SLOT_CODE = `lesson_slot_${SLOT_ID}__session`;
const COURSE_CODE = `surf_pack_${PACK_ID}__1_week`;

function makeDiscoverPg() {
  return {
    query: async (sql) => {
      const s = String(sql);
      if (/information_schema\.tables/i.test(s) && /tenant_surf_pack_rules/i.test(s)) {
        return { rows: [{ '?column?': 1 }] };
      }
      if (/information_schema\.columns/i.test(s)) {
        return { rows: [{ '?column?': 1 }] };
      }
      if (/FROM tenant_surf_pack_rules/i.test(s)) {
        return {
          rows: [{
            id: PACK_ID,
            label: 'Adults Mon–Fri mornings',
            config_json: {
              age_band: '12_and_up',
              group_size: 16,
              beaches: ['somo'],
              weekly: 'mon_fri',
              schedules: ['0930_1130'],
              price_tiers: [{ key: '1_week', label: '1 week', hours: 10, amount_cents: 18000 }],
            },
          }],
        };
      }
      // Lesson-slot seat / config probes — ignored; group lessons must stay empty.
      return { rows: [] };
    },
  };
}

function catalogWithGroupSlotAndCourse() {
  return {
    ok: true,
    source: 'db',
    location_id: 'sunset-somo',
    lesson_times: [{
      slot_id: SLOT_ID,
      active: true,
      slot_time: '09:30-11:30',
      offering_label: 'Morning group class',
      age_band: '12_and_up',
      capacity: 12,
      weekdays_active: [1, 2, 3, 4, 5],
    }],
    surf_packs: [{
      pack_id: PACK_ID,
      label: 'Adults week course',
      active: true,
      group_size: 16,
      weekly: 'mon_fri',
      schedules: ['0930_1130'],
      price_tiers: [{ key: '1_week', label: '1 week', hours: 10 }],
    }],
    prices: [
      {
        id: 'slot-price',
        category: 'lesson',
        offering_key: SLOT_CODE,
        label: 'Morning group class',
        amount: 45,
        amount_cents: 4500,
        unit: 'session',
        active: true,
        currency: 'EUR',
      },
      {
        id: 'course-price',
        category: 'package',
        offering_key: COURSE_CODE,
        label: '1 week course',
        amount: 180,
        amount_cents: 18000,
        unit: 'day',
        active: true,
        currency: 'EUR',
      },
      {
        id: 'seed-30',
        category: 'lesson',
        offering_key: 'group_lesson_adult',
        label: 'Adult group lesson seed',
        amount: 30,
        amount_cents: 3000,
        unit: 'session',
        active: true,
        currency: 'EUR',
        pricing_status: 'unverified_seed',
      },
    ],
    private_lesson: {
      rule_id: 'private_lesson',
      enabled: true,
      amount_cents: 9500,
      unit: 'session',
      label: 'Private lesson',
      active: true,
    },
  };
}

async function main() {
  console.log('\nverify:sunset-luna-courses-only — no standalone group lessons for Luna\n');

  console.log('[A] Discovery must not return group_lessons');
  const listed = await listJoinableSunsetOfferings(makeDiscoverPg(), {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
  });
  assert('discovery ok', listed.ok === true, JSON.stringify(listed));
  assert('discovery has admin courses',
    Array.isArray(listed.courses) && listed.courses.some((c) => c.course_id === PACK_ID),
    JSON.stringify(listed.courses));
  assert('discovery group_lessons is empty array',
    Array.isArray(listed.group_lessons) && listed.group_lessons.length === 0,
    JSON.stringify(listed.group_lessons));

  console.log('\n[B] Lesson catalog offers courses + private only (no group_lesson / €30 / €45)');
  const catalog = buildSunsetLunaCatalogFromConfig(catalogWithGroupSlotAndCourse(), {
    locationId: 'sunset-somo',
    requireDb: false,
  });
  assert('catalog ok', catalog.ok === true, JSON.stringify(catalog));
  const offerings = catalog.offerings || [];
  const types = offerings.map((o) => o.offering_type);
  assert('catalog includes course', types.includes('course'), JSON.stringify(types));
  assert('catalog includes private_lesson', types.includes('private_lesson'), JSON.stringify(types));
  assert('catalog has no group_lesson', !types.includes('group_lesson'), JSON.stringify(types));
  assert('catalog has no kids_lesson standalone slot', !types.includes('kids_lesson'), JSON.stringify(types));
  assert('catalog never surfaces €30 seed',
    !offerings.some((o) => Number(o.unit_amount_cents) === 3000
      || Number(o.price && o.price.amount_cents) === 3000),
    JSON.stringify(offerings.map((o) => o.unit_amount_cents || (o.price && o.price.amount_cents))));
  assert('catalog never surfaces €45 group slot',
    !offerings.some((o) => Number(o.unit_amount_cents) === 4500
      || Number(o.price && o.price.amount_cents) === 4500),
    JSON.stringify(offerings.map((o) => o.unit_amount_cents || (o.price && o.price.amount_cents))));
  assert('no lesson_slot_* offering_id reachable',
    !offerings.some((o) => /lesson_slot_/i.test(String(o.offering_id || ''))
      || /lesson_slot_/i.test(String(o.price_id || ''))
      || /lesson_slot_/i.test(String(o.item_code || ''))),
    JSON.stringify(offerings.map((o) => o.offering_id)));

  console.log('\n[C] Hermes plugin: no Luna-facing group-lesson quote / discovery surface');
  assert('plugin stub keeps get_sunset_group_lesson_quote def (disabled)',
    pluginSrc.includes('def get_sunset_group_lesson_quote(')
    && pluginSrc.includes('group_lessons_not_offered'));
  assert('get_sunset_group_lesson_quote not in tool registry tuples',
    !/\(\s*"get_sunset_group_lesson_quote"\s*,/.test(pluginSrc));
  assert('joinable courses tool always returns empty group_lessons',
    pluginSrc.includes('"group_lessons": []'));

  console.log(`\nTotals: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
