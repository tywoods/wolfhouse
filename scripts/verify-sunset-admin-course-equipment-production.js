'use strict';
/**
 * Production contract for course-owned equipment on Group/Private Admin cards.
 * Location-wide Equipment + Price (course_equipment_pricing) is retired.
 */
const assert = require('assert');
const fs = require('fs');
const { validateEquipmentOptions } = require('./lib/sunset-course-equipment-options');

const api = fs.readFileSync(require.resolve('./staff-query-api'), 'utf8');
const ui = fs.readFileSync(require.resolve('./browser/sunset-admin-ui'), 'utf8');
const enIt = fs.readFileSync(require.resolve('./lib/staff-portal-i18n'), 'utf8');
const es = fs.readFileSync(require.resolve('./lib/staff-portal-i18n-es-sunset'), 'utf8');
{
  const scopedOfferings = [{ client_slug: 'sunset', location_id: 'sunset-somo', offering_key: 'softboard', active: true }];
  assert.deepStrictEqual(validateEquipmentOptions([{ offering_key: 'softboard', during_course_price_cents: 0, all_day_price_cents: 125 }], { clientSlug: 'sunset', locationId: 'sunset-somo', offerings: scopedOfferings }), [{ offering_key: 'softboard', during_course_price_cents: 0, all_day_price_cents: 125 }]);
  assert.throws(() => validateEquipmentOptions([{ offering_key: 'softboard', during_course_price_cents: 0, all_day_price_cents: 0 }, { offering_key: 'softboard', during_course_price_cents: 0, all_day_price_cents: 0 }]));
  assert.throws(() => validateEquipmentOptions([{ offering_key: 'softboard', during_course_price_cents: 0, all_day_price_cents: 0 }], { clientSlug: 'sunset', locationId: 'sunset-sardinero', offerings: scopedOfferings }));

  // Global location-wide write route retired (410), not accepting writes.
  assert(api.includes("pathname === '/staff/admin/config/course-equipment' && method === 'PATCH'"));
  assert(api.includes("error: 'course_equipment_pricing_retired'") || api.includes('410'));
  assert(!/function\s+handleAdminConfigCourseEquipmentPatch\b/.test(api), 'accepting patch handler removed');
  assert(!/putCourseEquipmentPricing\s*\(/.test(api), 'no location-wide put from Staff API');
  assert(!/payload\.course_equipment_pricing\s*=/.test(api), 'config GET must not attach global pricing');

  // Course-owned equipment UI remains; obsolete global All Day Surfboard/Wetsuit block gone.
  assert(ui.includes('renderAdminPrivateLessonCard(cfg, writes)'));
  assert(!/function\s+renderAdminCourseEquipment\b/.test(ui), 'global renderAdminCourseEquipment removed');
  assert(!ui.includes('admin-course-all-day-enabled'));
  assert(!ui.includes('admin-course-all-day-board'));
  assert(!ui.includes('admin-course-all-day-suit'));
  assert(!ui.includes('save-course-equipment'));
  assert(!ui.includes('data-admin-course-equipment'));
  ['data-admin-equipment-editor', 'data-equipment-option-row', 'equipment_options', 'inputmode="decimal"'].forEach((s) => assert(ui.includes(s), s));
  ['equipment_included: !!', 'equipment_price_cents: equipmentPriceParsed'].forEach((s) => assert(!ui.includes(s), `obsolete payload ${s}`));
  assert(ui.includes('during_course_price_cents') && ui.includes('all_day_price_cents'), 'canonical option fields on write');
  assert(ui.includes('admin-equipment-during-price') && ui.includes('admin-equipment-all-day-price'), 'independent price inputs');
  assert(!/All Day Price Surcharge/i.test(enIt), 'no surcharge label');
  ['admin-course-during-board', 'admin-course-during-suit', 'admin-course-equipment-policy', 'free_with_course'].forEach((s) => assert(!ui.includes(s), `removed ${s}`));
  assert(ui.includes('adminParseEurosToCents'), 'euro inputs convert at boundary');
  assert(ui.includes('adminOpStillOwns'), 'stale response guard');
  assert(ui.includes("if (!btn || adminSaveBusy) return"), 'double submit guard');
  assert(api.includes('min-height:44px') && api.includes('@media(max-width:520px)') && api.includes('minmax(0,1fr)'), 'mobile/44px/no overflow CSS');
  // i18n labels may remain for historical strings; course card Equipment editor is the active surface.
  ['Equipment', 'Material', 'Attrezzatura'].forEach((s, i) => assert((i === 1 ? es : enIt).includes(s), s));
  console.log('PASS sunset Admin course-owned equipment persistence/API/UI contract (global authority retired)');
}
