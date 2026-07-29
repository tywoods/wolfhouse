'use strict';
const assert = require('assert');
const fs = require('fs');
const { validateEquipmentOptions } = require('./lib/sunset-course-equipment-options');

const api = fs.readFileSync(require.resolve('./staff-query-api'), 'utf8');
const ui = fs.readFileSync(require.resolve('./browser/sunset-admin-ui'), 'utf8');
const enIt = fs.readFileSync(require.resolve('./lib/staff-portal-i18n'), 'utf8');
const es = fs.readFileSync(require.resolve('./lib/staff-portal-i18n-es-sunset'), 'utf8');
{
  const scopedOfferings = [{ client_slug: 'sunset', location_id: 'sunset-somo', offering_key: 'softboard', active: true }];
  assert.deepStrictEqual(validateEquipmentOptions([{ offering_key: 'softboard', equipment_price_cents: 0, all_day_surcharge_cents: 125 }], { clientSlug: 'sunset', locationId: 'sunset-somo', offerings: scopedOfferings }), [{ offering_key: 'softboard', equipment_price_cents: 0, all_day_surcharge_cents: 125 }]);
  assert.throws(() => validateEquipmentOptions([{ offering_key: 'softboard', equipment_price_cents: 0, all_day_surcharge_cents: 0 }, { offering_key: 'softboard', equipment_price_cents: 0, all_day_surcharge_cents: 0 }]));
  assert.throws(() => validateEquipmentOptions([{ offering_key: 'softboard', equipment_price_cents: 0, all_day_surcharge_cents: 0 }], { clientSlug: 'sunset', locationId: 'sunset-sardinero', offerings: scopedOfferings }));


  assert(api.includes("pathname === '/staff/admin/config/course-equipment' && method === 'PATCH'"));
  assert(api.includes("requireAuth(req, res, 'admin')"));
  assert(api.includes('evaluateAdminWriteGate({ user, clientSlug'));
  assert(api.includes('assertStaffClientAccess(user, clientSlug, res)'));
  assert(api.includes('if (!isSunsetLocationId(query.location))'));
  assert(api.includes("error: 'invalid_course_equipment_pricing'"));
  assert(api.includes("error: 'write failed'"));
  assert(!api.match(/handleAdminConfigCourseEquipmentPatch[\s\S]{0,2500}(body\.client|body\.tenant|body\.location)/), 'no request body authority');

  const privateAt = ui.indexOf('renderAdminPrivateLessonCard(cfg, writes)');
  const equipmentAt = ui.indexOf('renderAdminCourseEquipment(cfg, writes)', privateAt);
  assert(privateAt >= 0 && equipmentAt > privateAt, 'All Day section follows Private Courses');
  ['data-admin-equipment-editor','data-equipment-option-row','equipment_options','admin-course-all-day-enabled','admin-course-all-day-board','admin-course-all-day-suit','aria-labelledby','aria-describedby','inputmode="decimal"'].forEach((s) => assert(ui.includes(s), s));
  ['equipment_included: !!','equipment_price_cents: equipmentPriceParsed'].forEach((s) => assert(!ui.includes(s), `obsolete payload ${s}`));
  ['admin-course-during-board','admin-course-during-suit','admin-course-equipment-policy','free_with_course'].forEach((s) => assert(!ui.includes(s), `removed ${s}`));
  assert(ui.includes('adminParseEurosToCents'), 'euro inputs convert at boundary');
  assert(ui.includes("if (!adminOpStillOwns(op)) return"), 'stale response guard');
  assert(ui.includes("if (!btn || adminSaveBusy) return"), 'double submit guard');
  assert(api.includes('min-height:44px') && api.includes('@media(max-width:520px)') && api.includes('minmax(0,1fr)'), 'mobile/44px/no overflow CSS');
  ['Equipment + Price','Material + Precio','Attrezzatura + Prezzo'].forEach((s, i) => assert((i === 1 ? es : enIt).includes(s), s));
  console.log('PASS sunset Admin consolidated course equipment persistence/API/UI contract');
}
