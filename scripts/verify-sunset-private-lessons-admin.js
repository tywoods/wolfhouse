'use strict';

/**
 * verify:sunset-private-lessons-admin
 *
 * Offline checks for Sunset Admin private lesson config slice.
 * Run: node scripts/verify-sunset-private-lessons-admin.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

console.log('\nverify:sunset-private-lessons-admin — private lesson admin slice\n');

const rules = read('scripts/lib/sunset-admin-private-lesson-rules.js');
const config = read('scripts/lib/tenant-business-config.js');
const api = read('scripts/staff-query-api.js');
const adminUi = read('scripts/browser/sunset-admin-ui.js');
const migration = read('database/migrations/033_tenant_private_lesson_rules.sql');
const en = read('scripts/lib/staff-portal-i18n.js');
const es = read('scripts/lib/staff-portal-i18n-es-sunset.js');

assert('migration 033 exists', migration.includes('tenant_private_lesson_rules'));
assert('rules module exports putPrivateLessonRule', /putPrivateLessonRule/.test(rules));
assert('rules validatePrivateLessonBody', /validatePrivateLessonBody/.test(rules));
assert('rules default duration 120', rules.includes('DEFAULT_DURATION_MINUTES = 120'));
assert('rules price item code private_lesson__session', rules.includes('private_lesson__session'));
assert('rules lazy ensurePrivateLessonTable', rules.includes('ensurePrivateLessonTable'));
assert('rules per_session price basis', rules.includes("'per_session'"));

assert('tenant config loads private lesson from db', config.includes('loadPrivateLessonFromDb'));
assert('tenant config exposes private_lesson in merge', config.includes('private_lesson'));
assert('tenant config baseline private_lesson', config.includes('defaultPrivateLessonFromConfig'));

assert('API PUT private-lesson route', api.includes("pathname === '/staff/admin/config/private-lesson'"));
assert('API handleAdminConfigPrivateLessonPut', api.includes('handleAdminConfigPrivateLessonPut'));
assert('API evaluateAdminWriteGate on private lesson', /handleAdminConfigPrivateLessonPut[\s\S]*evaluateAdminWriteGate/.test(api));
assert('API imports private lesson rules', api.includes('sunset-admin-private-lesson-rules'));

assert('admin UI renderAdminPrivateLessonCard', adminUi.includes('renderAdminPrivateLessonCard'));
assert('admin UI save-private-lesson action', adminUi.includes('save-private-lesson'));
assert('admin UI no time fields in private form', !/admin-private-start|admin-private-time/.test(adminUi));
assert('admin UI group courses + private in section render', /renderAdminPackCards[\s\S]*renderAdminPrivateLessonCard/.test(adminUi));
assert('admin UI group lesson cards removed from section render', !/box\.innerHTML = renderAdminLessonCards/.test(adminUi));

assert('EN private courses title', en.includes("'admin.privateLessons.title': 'Private Courses'"));
assert('ES cursos privados title', es.includes("'admin.privateLessons.title': 'Cursos privados'"));

const {
  defaultPrivateLessonApi,
  defaultPrivateLessonFromConfig,
  validatePrivateLessonBody,
  mapPrivateLessonRow,
} = require('./lib/sunset-admin-private-lesson-rules');

const def = defaultPrivateLessonApi();
assert('default api shape enabled', def.enabled === false && def.price_basis === 'per_session');
assert('default duration 120', def.default_duration_minutes === 120);

const fromCfg = defaultPrivateLessonFromConfig({
  pricing_policy: { currency: 'EUR' },
  catalog: { lessons: { offerings: { private_coaching: { label: 'Private / coaching lesson' } } } },
});
assert('config fallback label from catalog', fromCfg.label === 'Private / coaching lesson');

const valid = validatePrivateLessonBody({
  enabled: true,
  label: 'Private lesson',
  amount_cents: 6000,
  currency: 'EUR',
  price_basis: 'per_session',
  default_duration_minutes: 120,
  notes: 'internal',
});
assert('validate accepts full body', valid.ok === true);

const badDuration = validatePrivateLessonBody({ default_duration_minutes: 10 });
assert('validate rejects short duration', badDuration.ok === false);

const mapped = mapPrivateLessonRow({
  id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  label: 'Private lesson',
  active: true,
  config_json: {
    amount_cents: 6000,
    currency: 'EUR',
    price_basis: 'per_session',
    default_duration_minutes: 120,
    notes: 'note',
  },
});
assert('map row to api shape', mapped.enabled === true && mapped.amount_cents === 6000 && mapped.notes === 'note');

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-private-lessons-admin — FAILED');
  process.exit(1);
}
console.log('verify:sunset-private-lessons-admin — ALL CHECKS PASSED');
