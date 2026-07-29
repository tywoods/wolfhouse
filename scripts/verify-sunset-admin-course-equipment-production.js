'use strict';
const assert = require('assert');
const fs = require('fs');
const store = require('./lib/sunset-admin-location-store');
const { DEFAULT_CONFIG, validateConfig, normalizeConfig } = require('./lib/sunset-course-equipment-pricing');

const api = fs.readFileSync(require.resolve('./staff-query-api'), 'utf8');
const ui = fs.readFileSync(require.resolve('./browser/sunset-admin-ui'), 'utf8');
const enIt = fs.readFileSync(require.resolve('./lib/staff-portal-i18n'), 'utf8');
const es = fs.readFileSync(require.resolve('./lib/staff-portal-i18n-es-sunset'), 'utf8');
const path = store.STORE_PATH;
const before = fs.existsSync(path) ? fs.readFileSync(path) : null;
const good = { all_day: { enabled: true, surfboard_cents: 2100, wetsuit_cents: 900 } };
try {
  assert.deepStrictEqual(normalizeConfig(undefined), JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  assert.deepStrictEqual(normalizeConfig({ during_course: false }), JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  store.putCourseEquipmentPricing('sunset-somo', good);
  assert.deepStrictEqual(store.getCourseEquipmentPricing('sunset-somo'), good, 'PATCH write + GET readback');
  assert.deepStrictEqual(store.getCourseEquipmentPricing('sunset-sardinero'), JSON.parse(JSON.stringify(DEFAULT_CONFIG)), 'cross-location isolation');
  const snapshot = fs.readFileSync(path, 'utf8');
  const invalid = [
    null, [], {}, true,
    { ...good, during_course: { policy: 'extra', surfboard_cents: 1, wetsuit_cents: 1 } },
    { all_day: { ...good.all_day, enabled: 'true' } },
    { all_day: { ...good.all_day, surfboard_cents: true } },
    { all_day: { ...good.all_day, surfboard_cents: '1' } },
    { all_day: { ...good.all_day, surfboard_cents: 1.5 } },
    { all_day: { ...good.all_day, surfboard_cents: -1 } },
    { all_day: { ...good.all_day, surfboard_cents: Number.MAX_SAFE_INTEGER + 1 } },
  ];
  invalid.forEach((v) => assert.throws(() => store.putCourseEquipmentPricing('sunset-somo', v)));
  assert.strictEqual(fs.readFileSync(path, 'utf8'), snapshot, 'invalid writes roll back without mutation');
  assert.deepStrictEqual(validateConfig({ all_day: { enabled: false, surfboard_cents: 0, wetsuit_cents: 0 } }),
    { all_day: { enabled: false, surfboard_cents: 0, wetsuit_cents: 0 } });

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
  ['admin-pack-equipment-price','admin-private-equipment-included','admin-private-equipment-price','admin-course-all-day-enabled','admin-course-all-day-board','admin-course-all-day-suit','aria-labelledby','aria-describedby','inputmode="decimal"'].forEach((s) => assert(ui.includes(s), s));
  ['admin-course-during-board','admin-course-during-suit','admin-course-equipment-policy','free_with_course'].forEach((s) => assert(!ui.includes(s), `removed ${s}`));
  assert(ui.includes('adminParseEurosToCents'), 'euro inputs convert at boundary');
  assert(ui.includes("if (!adminOpStillOwns(op)) return"), 'stale response guard');
  assert(ui.includes("if (!btn || adminSaveBusy) return"), 'double submit guard');
  assert(api.includes('min-height:44px') && api.includes('@media(max-width:520px)') && api.includes('minmax(0,1fr)'), 'mobile/44px/no overflow CSS');
  ['Course Equipment','Material del curso','Attrezzatura del corso'].forEach((s, i) => assert((i === 1 ? es : enIt).includes(s), s));
  console.log('PASS sunset Admin consolidated course equipment persistence/API/UI contract');
} finally {
  if (before == null) { try { fs.unlinkSync(path); } catch (_) {} }
  else fs.writeFileSync(path, before);
}
