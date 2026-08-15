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
assert.ok(portal.includes('data-other-blocked'));
assert.ok(portal.includes('scheduleCreateCourseGuestCap'));
assert.ok(portal.includes('overCap'));
assert.ok(api.includes('id="ps-create-surfers"') && api.includes('max="24"'));
assert.ok(bookings.includes('if (expanded)') && bookings.includes('html += \'</div>\';\n  });'));
assert.ok(!portal.includes('inbox-thread.js'));
assert.ok(!bookings.includes('inbox-thread.js'));

const phoneStart = portal.indexOf('function schedulePortalIsValidCreatePhone');
const phoneEnd = portal.indexOf('function scheduleCreateCourseGuestCap');
const box = {};
vm.createContext(box);
vm.runInContext(portal.slice(phoneStart, phoneEnd) + '\nthis.schedulePortalIsValidCreatePhone = schedulePortalIsValidCreatePhone;', box);
assert.strictEqual(box.schedulePortalIsValidCreatePhone('+34600111222'), true);
assert.strictEqual(box.schedulePortalIsValidCreatePhone('hello 123456'), false);
assert.strictEqual(box.schedulePortalIsValidCreatePhone('abc!!!'), false);
assert.strictEqual(box.schedulePortalIsValidCreatePhone('+34 600 111 222'), true);

const writeStart = writes.indexOf('function isValidStaffCreateGuestPhone');
const writeEnd = writes.indexOf('function isNoLessonComponents');
const wbox = {};
vm.createContext(wbox);
vm.runInContext(writes.slice(writeStart, writeEnd) + '\nthis.isValidStaffCreateGuestPhone = isValidStaffCreateGuestPhone;', wbox);
assert.strictEqual(wbox.isValidStaffCreateGuestPhone('letters123456'), false);
assert.strictEqual(wbox.isValidStaffCreateGuestPhone('+34600111222'), true);

console.log('PASS BUG-006 capacity + phone + Reservas expand');
