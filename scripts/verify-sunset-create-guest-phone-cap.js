'use strict';

/**
 * Create booking: guest count capped (not 99) + phone rejects letters.
 * Complements past-date soft gate (verify-sunset-create-past-date-block.js).
 * Stay off Inbox, email, production.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
const writesSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const writes = require('./lib/sunset-schedule-booking-writes');

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) return null;
  let i = start;
  let depth = 0;
  let started = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') {
      depth--;
      if (started && depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log('  ok ' + label);
}

console.log('[1] Static owners: guest max 24 + phone letter reject');
ok('portal declares SCHEDULE_CREATE_GUEST_MAX = 24',
  /var SCHEDULE_CREATE_GUEST_MAX\s*=\s*24/.test(portalSrc));
ok('portal non-course cap is hard max (not 99)',
  /if\s*\(!courseOn\)\s*return hardMax/.test(portalSrc)
  && !/if\s*\(!courseOn\)\s*return 99/.test(portalSrc));
ok('portal sanitizes phone letters on input',
  /function schedulePortalSanitizeCreatePhoneField/.test(portalSrc)
  && /replace\(\/\[A-Za-z\]\/g/.test(portalSrc));
ok('portal phone validator rejects letters',
  /function schedulePortalIsValidCreatePhone[\s\S]*?\/\[A-Za-z\]\/\.test\(phone\)/.test(portalSrc));
ok('server STAFF_CREATE_GUEST_MAX = 24', writes.STAFF_CREATE_GUEST_MAX === 24);
ok('server phone rejects letters',
  writes.isValidStaffCreateGuestPhone('letters123456') === false
  && writes.isValidStaffCreateGuestPhone('+34600111222') === true);
ok('visible + mirror surfer inputs max=24',
  /id="ps-create-surfers"[^>]*max="24"/.test(apiSrc)
  && /id="ps-create-course-qty"[^>]*max="24"/.test(apiSrc)
  && /id="ps-create-private-lesson-surfers"[^>]*max="24"/.test(apiSrc));
ok('phone input pattern rejects letters',
  /id="ps-create-phone"[^>]*pattern="\[0-9/.test(apiSrc));
ok('stays off inbox-thread',
  !portalSrc.includes('inbox-thread.js') && !writesSrc.includes('inbox-thread.js'));

console.log('\n[2] Server: guest count 99 rejected, 24 ok; equipment 99 still ok');
ok('parseGuestSurferCount(99) null', writes.parseGuestSurferCount(99) === null);
ok('parseGuestSurferCount(24) 24', writes.parseGuestSurferCount(24) === 24);
ok('parseGuestSurferCount(1) 1', writes.parseGuestSurferCount(1) === 1);
ok('parseAuthoritativeSurferCount rejects 99',
  writes.parseAuthoritativeSurferCount({ surfer_count: 99 }) === null);
ok('parseAuthoritativeSurferCount accepts 24',
  writes.parseAuthoritativeSurferCount({ surfer_count: 24 }) === 24);

const refDate = new Date('2026-08-20T12:00:00Z');
const baseBody = {
  guest_name: 'Ada',
  guest_phone: '+34600111222',
  date_from: '2026-08-20',
  date_to: '2026-08-20',
  payment_status: 'unpaid',
  surfer_count: 1,
  components: {
    private_lesson: {
      enabled: true,
      quantity: 1,
      surfer_count: 1,
      sessions: [{ date: '2026-08-20', start: '10:00', end: '11:00' }],
    },
  },
};

ok('validate accepts surfer_count 24',
  writes.validateScheduleBookingBody({
    ...baseBody,
    surfer_count: 24,
    components: {
      private_lesson: {
        enabled: true,
        quantity: 1,
        surfer_count: 24,
        sessions: [{ date: '2026-08-20', start: '10:00', end: '11:00' }],
      },
    },
  }, { refDate, requireGuestPhone: true }).ok === true);

const over = writes.validateScheduleBookingBody({
  ...baseBody,
  surfer_count: 99,
  components: {
    private_lesson: {
      enabled: true,
      quantity: 1,
      surfer_count: 99,
      sessions: [{ date: '2026-08-20', start: '10:00', end: '11:00' }],
    },
  },
}, { refDate, requireGuestPhone: true });
ok('validate rejects private surfer_count 99',
  over.ok === false && /1–24|1-24/.test(String(over.error || '')));

const lettersPhone = writes.validateScheduleBookingBody({
  ...baseBody,
  guest_phone: 'hello123456',
}, { refDate, requireGuestPhone: true });
ok('validate rejects phone with letters',
  lettersPhone.ok === false);

const courseOver = writes.validateScheduleBookingBody({
  guest_name: 'Ada',
  guest_phone: '+34600111222',
  date_from: '2026-08-20',
  date_to: '2026-08-20',
  payment_status: 'unpaid',
  surfer_count: 99,
  components: {
    course: {
      quantity: 99,
      course_id: 'course-a',
      tier_key: '1_week',
      course_label: 'Beginner',
    },
  },
}, { refDate, requireGuestPhone: true });
ok('validate rejects course quantity 99',
  courseOver.ok === false && /1–24|1-24/.test(String(courseOver.error || '')));

console.log('\n[3] Portal helpers: sanitize phone + guest cap');
const phoneFn = extractFn(portalSrc, 'schedulePortalIsValidCreatePhone');
const sanitizeFn = extractFn(portalSrc, 'schedulePortalSanitizeCreatePhoneField');
const capFn = extractFn(portalSrc, 'scheduleCreateCourseGuestCap');
assert.ok(phoneFn && sanitizeFn && capFn, 'extract phone/sanitize/cap fns');

const box = {
  SCHEDULE_CREATE_GUEST_MAX: 24,
  el: function () { return null; },
};
vm.createContext(box);
vm.runInContext(
  phoneFn + '\n' + sanitizeFn + '\n' + capFn
  + '\nthis.schedulePortalIsValidCreatePhone = schedulePortalIsValidCreatePhone;'
  + '\nthis.schedulePortalSanitizeCreatePhoneField = schedulePortalSanitizeCreatePhoneField;'
  + '\nthis.scheduleCreateCourseGuestCap = scheduleCreateCourseGuestCap;',
  box,
);

ok('valid phone ok', box.schedulePortalIsValidCreatePhone('+34 600 111 222') === true);
ok('letters+digits phone invalid', box.schedulePortalIsValidCreatePhone('abc123456') === false);
ok('letters-only phone invalid', box.schedulePortalIsValidCreatePhone('notaphone') === false);

const node = { value: 'ab+34cd600ef' };
const cleaned = box.schedulePortalSanitizeCreatePhoneField(node);
ok('sanitize strips letters', cleaned === '+34600' && node.value === '+34600');
ok('sanitize leaves digits/punctuation', (() => {
  const n2 = { value: '+34 600-111.222' };
  return box.schedulePortalSanitizeCreatePhoneField(n2) === '+34 600-111.222';
})());

ok('non-course guest cap is 24', box.scheduleCreateCourseGuestCap() === 24);

console.log('\nPASS create guest-phone cap (' + passed + ' asserts)');
