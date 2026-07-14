'use strict';

/**
 * verify:sunset-generic-admin-service-pricing
 *
 * Generic Admin offering → tenant_price_rules identity contract for Sunset.
 *
 * Run:
 *   node scripts/verify-sunset-generic-admin-service-pricing.js
 */

const fs = require('fs');
const path = require('path');

const {
  resolveSunsetPriceIdentity,
  courseTierIdentity,
  privateLessonIdentity,
  rentalIdentity,
  fullDayEquipmentIdentity,
  packPriceItemCode,
  priceIdentityKey,
} = require('./lib/sunset-admin-price-identity');
const {
  resolveActiveSunsetAdminPrice,
  staffFacingSunsetAdminPriceError,
} = require('./lib/sunset-admin-price-resolve');
const { syncPackTierToPriceRules } = require('./lib/sunset-admin-price-sync');
const {
  resolveCourseLessonPriceIdentity,
  lookupSunsetCourseLessonPriceAsync,
} = require('./lib/sunset-course-lesson-price-lookup');

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

const PACK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TIER = '1_week';
const ITEM = packPriceItemCode(PACK, TIER);
const UNIT = 'day';
const AMOUNT = 27100;
const FIXED_NOW = new Date('2026-07-15T12:00:00Z');

function calendarDateKey(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function makePg(opts = {}) {
  const rows = [...(opts.rows || [])];
  const captured = [];
  return {
    captured,
    rows,
    async query(sql, params) {
      const s = String(sql);
      captured.push({ sql: s, params: params || [] });
      if (/to_regclass/i.test(s)) return { rows: [{ reg: 'tenant_price_rules' }] };
      if (/information_schema\.columns/i.test(s)) return { rows: [{ '?column?': 1 }] };
      if (/BEGIN|COMMIT|ROLLBACK|SAVEPOINT|insertConfigAudit|tenant_config_audit/i.test(s)) {
        return { rows: [] };
      }
      if (/FROM tenant_price_rules/i.test(s) && /FOR UPDATE/i.test(s)) {
        const itemCode = params[3] || params[2];
        const unit = /unit = \$5/i.test(s) ? params[4] : (/unit = \$4/i.test(s) ? params[3] : null);
        const hit = rows.filter((r) => r.item_code === itemCode
          && r.active !== false
          && (unit == null || r.unit === unit));
        return { rows: hit };
      }
      if (/FROM tenant_price_rules/i.test(s)) {
        const clientSlug = params[0];
        const itemType = params[1];
        const itemCode = params[2];
        const billingUnit = params[3];
        const locationId = params[4];
        const today = calendarDateKey(FIXED_NOW);
        const matched = rows.filter((r) => (
          r.client_slug === clientSlug
          && r.item_type === itemType
          && r.item_code === itemCode
          && r.unit === billingUnit
          && r.location_id === locationId
          && r.active !== false
          && (!r.effective_from || calendarDateKey(r.effective_from) <= today)
          && (!r.effective_to || calendarDateKey(r.effective_to) >= today)
        ));
        if (!matched.length) return { rows: [] };
        const row = matched[0];
        return {
          rows: [{
            id: row.id,
            amount_cents: row.amount_cents,
            currency: row.currency || 'EUR',
            item_type: row.item_type,
            item_code: row.item_code,
            unit: row.unit,
            location_id: row.location_id,
          }],
        };
      }
      if (/INSERT INTO tenant_price_rules/i.test(s)) {
        const row = {
          id: `new-${rows.length + 1}`,
          tenant_id: 'sunset',
          client_slug: params[1],
          location_id: params[2],
          item_type: params[3],
          item_code: params[4],
          display_name: params[5],
          currency: params[6],
          amount_cents: params[7],
          unit: params[8],
          active: true,
        };
        rows.push(row);
        return { rows: [row] };
      }
      if (/UPDATE tenant_price_rules SET/i.test(s)) {
        const id = params[0];
        const row = rows.find((r) => String(r.id) === String(id));
        if (row && /unit = /i.test(s)) {
          // best-effort: last unit-like numeric/string after amount
          row.updated = true;
        }
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    },
  };
}

async function main() {
  console.log('\nverify:sunset-generic-admin-service-pricing\n');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  console.log('[RED] Live-shaped mismatch — Admin JSON shows tier; DB row missing or wrong unit');
  const identity = courseTierIdentity(PACK, TIER, 'sunset-somo');
  assert('canonical course identity item_code', identity.item_code === ITEM, JSON.stringify(identity));
  assert('canonical course billing_unit=day for week tier', identity.billing_unit === 'day');
  assert('week tier billing_mode=whole_offering_x_qty', identity.billing_mode === 'whole_offering_x_qty');

  const emptyPg = makePg({ rows: [] });
  const redMiss = await resolveActiveSunsetAdminPrice(emptyPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    quantity: 1,
    metadata: {
      component: 'course',
      course_id: PACK,
      tier_key: TIER,
      offering_id: ITEM,
      location_id: 'sunset-somo',
    },
  });
  assert('RED: missing DB row → price_not_configured',
    redMiss.ok === false && redMiss.reason === 'price_not_configured',
    JSON.stringify(redMiss));

  const wrongUnitPg = makePg({
    rows: [{
      id: 'wrong-unit',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_type: 'package',
      item_code: ITEM,
      amount_cents: AMOUNT,
      unit: 'item', // historical forceDbUnit miss / mapBaselineUnitToDb(week)
      active: true,
      effective_from: '2026-01-01',
    }],
  });
  const redUnit = await resolveActiveSunsetAdminPrice(wrongUnitPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    quantity: 1,
    metadata: { component: 'course', course_id: PACK, tier_key: TIER, offering_id: ITEM },
  });
  assert('RED: wrong unit (item vs day) fails closed like live portal',
    redUnit.ok === false && redUnit.reason === 'price_not_configured',
    JSON.stringify(redUnit));

  const oldIdentity = resolveCourseLessonPriceIdentity({
    component: 'course',
    course_id: PACK,
    tier_key: TIER,
  });
  assert('legacy helper forms same item_code', oldIdentity && oldIdentity.itemCode === ITEM);
  assert('legacy helper forms same billing unit', oldIdentity && oldIdentity.billingUnit === 'day');

  console.log('\n[GREEN] Identity coverage for all Admin service families');
  assert('private lesson identity', privateLessonIdentity('sunset-somo').item_code === 'private_lesson__session');
  assert('board rental identity', rentalIdentity('board_rental', '1_day', 'sunset-somo').item_code === 'board_rental__1_day');
  assert('wetsuit identity', rentalIdentity('wetsuit_rental', '1_day', 'sunset-somo').item_code === 'wetsuit_rental__1_day');
  assert('bundle identity', rentalIdentity('board_and_suit_rental', '1_day', 'sunset-somo').item_code === 'board_and_suit_rental__1_day');
  assert('full-day identity', fullDayEquipmentIdentity('sunset-somo').item_code === 'full_day_equipment_extension__day');

  const future = resolveSunsetPriceIdentity({
    offering_id: 'custom_addon_xyz__day',
    item_type: 'rental',
    location_id: 'sunset-somo',
  });
  assert('future Admin offering resolves without new if/else branch',
    future && future.item_code === 'custom_addon_xyz__day' && future.billing_unit === 'day',
    JSON.stringify(future));

  assert('wrong tenant rejected', !(await resolveActiveSunsetAdminPrice(emptyPg, {
    clientSlug: 'wolfhouse',
    locationId: 'sunset-somo',
    metadata: { component: 'course', course_id: PACK, tier_key: TIER },
  })).ok);

  assert('sardinero rejected by somo-only rows',
    (await resolveActiveSunsetAdminPrice(makePg({
      rows: [{
        id: '1',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'package',
        item_code: ITEM,
        unit: UNIT,
        amount_cents: AMOUNT,
        active: true,
        effective_from: '2026-01-01',
      }],
    }), {
      clientSlug: 'sunset',
      locationId: 'sunset-sardinero',
      metadata: { component: 'course', course_id: PACK, tier_key: TIER, offering_id: ITEM },
    })).ok === false);

  console.log('\n[GREEN] Exact Admin DB amount');
  const goodPg = makePg({
    rows: [{
      id: 'active',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_type: 'package',
      item_code: ITEM,
      unit: UNIT,
      amount_cents: AMOUNT,
      currency: 'EUR',
      active: true,
      effective_from: '2026-01-01',
    }],
  });
  const one = await resolveActiveSunsetAdminPrice(goodPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    quantity: 1,
    metadata: { component: 'course', course_id: PACK, tier_key: TIER, offering_id: ITEM },
  });
  assert('1 surfer Admin amount', one.ok && one.amount_cents === AMOUNT && one.price_source === 'admin_db', JSON.stringify(one));
  const two = await resolveActiveSunsetAdminPrice(goodPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    quantity: 2,
    metadata: { component: 'course', course_id: PACK, tier_key: TIER, offering_id: ITEM },
  });
  assert('2 surfers = Admin × qty once', two.ok && two.amount_cents === AMOUNT * 2, JSON.stringify(two));

  console.log('\n[GREEN] Sync heals missing/wrong-unit rows from config_json amounts');
  const healPg = makePg({ rows: [] });
  const synced = await syncPackTierToPriceRules(healPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    packId: PACK,
    packLabel: 'Adults',
    tiers: [{ key: TIER, label: '1 week', amount_cents: AMOUNT }],
    actor: {},
    skipTransaction: true,
  });
  assert('sync reports bookable tier', synced[0] && synced[0].ok && synced[0].item_code === ITEM, JSON.stringify(synced));
  assert('sync inserted canonical row',
    healPg.rows.some((r) => r.item_code === ITEM && r.unit === UNIT && r.amount_cents === AMOUNT),
    JSON.stringify(healPg.rows));

  const afterHeal = await resolveActiveSunsetAdminPrice(healPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    quantity: 1,
    metadata: { component: 'course', course_id: PACK, tier_key: TIER },
  });
  assert('after sync, generic resolver finds Admin amount',
    afterHeal.ok && afterHeal.amount_cents === AMOUNT,
    JSON.stringify(afterHeal));

  console.log('\n[GREEN] Staff-facing copy + browser amount ignored markers');
  const face = staffFacingSunsetAdminPriceError('price_not_configured', identity);
  assert('staff message hides SQL/tables',
    /Admin price/i.test(face.error) && !/tenant_price_rules|SELECT|uuid/i.test(face.error));

  const writes = fs.readFileSync(path.join(__dirname, 'lib/sunset-schedule-booking-writes.js'), 'utf8');
  assert('manual create heals via syncPackTierToPriceRules', writes.includes('syncPackTierToPriceRules'));
  assert('model money fields rejected at normalize', writes.includes('MODEL_MONEY_FIELDS'));

  const packs = fs.readFileSync(path.join(__dirname, 'lib/sunset-admin-pack-rules.js'), 'utf8');
  assert('pack create syncs tiers in same transaction', packs.includes('skipTransaction: true')
    && packs.includes('upsertPackPriceTiers'));

  const stripe = fs.readFileSync(path.join(__dirname, 'lib/sunset-stripe-payment-links.js'), 'utf8');
  assert('payment path uses resolveActiveSunsetAdminPrice', stripe.includes('resolveActiveSunsetAdminPrice'));

  // Compatibility: course/lesson async lookup still works against good rows.
  const compat = await lookupSunsetCourseLessonPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    quantity: 1,
    metadata: { component: 'course', course_id: PACK, tier_key: TIER, offering_id: ITEM },
    pgClient: goodPg,
  });
  assert('compat lookupSunsetCourseLessonPriceAsync still greens',
    compat.ok && compat.amount_cents === AMOUNT, JSON.stringify(compat));

  assert('identity key is stable compound',
    priceIdentityKey(identity) === `sunset|sunset-somo|package|${ITEM}|day`);

  console.log(`\nTotals: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
