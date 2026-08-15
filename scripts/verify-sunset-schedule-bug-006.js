'use strict';

/**
 * BUG-006 — Create caps: guest count, phone, Reservas expand stay local.
 * Stay off Inbox, email, language packs, production.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const portal = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
const writes = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'), 'utf8');
const bookings = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

assert.ok(portal.includes("if (/[A-Za-z]/.test(phone)) return false;"));
assert.ok(writes.includes("if (/[A-Za-z]/.test(phone)) return false;"));
assert.ok(portal.includes('SCHEDULE_CREATE_GUEST_MAX'));
assert.ok(portal.includes('if (!courseOn) return hardMax'));
assert.ok(!portal.includes('if (!courseOn) return 99'));
assert.ok(portal.includes('schedulePortalSanitizeCreatePhoneField'));
assert.ok(api.includes('id="ps-create-surfers"') && api.includes('max="24"'));
assert.ok(api.includes('id="ps-create-course-qty"') && /id="ps-create-course-qty"[^>]*max="24"/.test(api));
assert.ok(/id="ps-create-private-lesson-surfers"[^>]*max="24"/.test(api));
assert.ok(bookings.includes('if (expanded)') && bookings.includes('html += \'</div>\';\n  });'));
assert.ok(!portal.includes('inbox-thread.js'));
assert.ok(!bookings.includes('inbox-thread.js'));

const phoneStart = portal.indexOf('function schedulePortalIsValidCreatePhone');
const phoneEnd = portal.indexOf('function schedulePortalSanitizeCreatePhoneField');
const box = {};
vm.createContext(box);
vm.runInContext(portal.slice(phoneStart, phoneEnd) + '\nthis.schedulePortalIsValidCreatePhone = schedulePortalIsValidCreatePhone;', box);
assert.strictEqual(box.schedulePortalIsValidCreatePhone('+34600111222'), true);
assert.strictEqual(box.schedulePortalIsValidCreatePhone('hello 123456'), false);
assert.strictEqual(box.schedulePortalIsValidCreatePhone('abc!!!'), false);
assert.strictEqual(box.schedulePortalIsValidCreatePhone('+34 600 111 222'), true);

const sanitizeStart = portal.indexOf('function schedulePortalSanitizeCreatePhoneField');
const sanitizeEnd = portal.indexOf('function scheduleCreateCourseGuestCap');
const sbox = { SCHEDULE_CREATE_GUEST_MAX: 24, el: function () { return null; } };
vm.createContext(sbox);
vm.runInContext(
  portal.slice(sanitizeStart, sanitizeEnd)
  + '\nthis.schedulePortalSanitizeCreatePhoneField = schedulePortalSanitizeCreatePhoneField;',
  sbox,
);
const phoneNode = { value: 'xx+34600111222yy' };
assert.strictEqual(sbox.schedulePortalSanitizeCreatePhoneField(phoneNode), '+34600111222');
assert.strictEqual(phoneNode.value, '+34600111222');

const writeStart = writes.indexOf('function isValidStaffCreateGuestPhone');
const writeEnd = writes.indexOf('function isNoLessonComponents');
const wbox = {};
vm.createContext(wbox);
vm.runInContext(writes.slice(writeStart, writeEnd) + '\nthis.isValidStaffCreateGuestPhone = isValidStaffCreateGuestPhone;', wbox);
assert.strictEqual(wbox.isValidStaffCreateGuestPhone('letters123456'), false);
assert.strictEqual(wbox.isValidStaffCreateGuestPhone('+34600111222'), true);

console.log('PASS BUG-006 capacity + phone + Reservas expand');
