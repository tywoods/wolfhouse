#!/usr/bin/env node
'use strict';

/**
 * Offline Staff API boundary: unknown group-class shapes and model money must
 * fail closed at validateScheduleBookingBody — zero bookings/service/payment
 * construction. Does not contact staging or Stripe.
 */

const {
  validateScheduleBookingBody,
  normalizeComponents,
} = require('./lib/sunset-schedule-booking-writes');

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${msg}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${msg}${detail ? ` — ${detail}` : ''}`);
  }
}

const REF = new Date('2026-07-13T12:00:00+02:00');
const base = {
  guest_name: 'Boundary Test',
  guest_phone: '+490000000001',
  service_dates: ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23'],
  payment_status: 'unpaid',
  location_id: 'sunset-somo',
};

console.log('\n── Unknown / unsupported component shapes ──');
for (const key of ['group_class', 'group_class_lesson', 'class', 'grupo', 'surf_class']) {
  const r = normalizeComponents({ components: { [key]: { quantity: 1 } } });
  ok(!r.ok && /unknown components/i.test(r.error || ''), `reject ${key}`, r.error);
  const v = validateScheduleBookingBody({ ...base, components: { [key]: { quantity: 1 } } }, { refDate: REF });
  ok(!v.ok, `validate rejects ${key}`, v.error);
}

console.log('\n── Exact approved alias group_lesson → lesson ──');
const alias = normalizeComponents({ components: { group_lesson: { quantity: 2 } } });
ok(alias.ok && alias.value.lesson && alias.value.lesson.quantity === 2 && !alias.value.group_lesson,
  'group_lesson maps to lesson only');

console.log('\n── Model money rejected (never reaches persistence) ──');
for (const field of [
  'price', 'unit_price', 'unit_amount', 'unit_amount_cents',
  'amount', 'amount_cents', 'total', 'total_cents',
  'line_total', 'line_total_cents', 'currency', 'price_source',
  'offering_key', 'item_code', 'unit',
]) {
  const r = normalizeComponents({
    components: { lesson: { quantity: 1, [field]: 999 } },
  });
  ok(!r.ok && /must not be supplied/i.test(r.error || ''), `reject lesson.${field}`, r.error);
}

console.log('\n── Course requires exact course_id (no offering_key smuggle) ──');
const bareCourse = normalizeComponents({ components: { course: { quantity: 1 } } });
ok(!bareCourse.ok && /course_id/i.test(bareCourse.error || ''), 'course without course_id rejected');
const offeringSmuggle = normalizeComponents({
  components: { course: { quantity: 1, offering_key: 'invented_course' } },
});
ok(!offeringSmuggle.ok, 'course+offering_key alone rejected', offeringSmuggle.error);

console.log('\n── Canonical lesson accepted ──');
const good = normalizeComponents({ components: { lesson: { quantity: 2 } } });
ok(good.ok && good.value.lesson.quantity === 2, 'canonical lesson accepted');
const validated = validateScheduleBookingBody({
  ...base,
  components: { lesson: { quantity: 2 } },
}, { refDate: REF });
ok(validated.ok, 'canonical multi-date lesson validates', validated.error);

console.log('\n────────────────────────────────────────────────');
console.log(`verify-sunset-booking-component-boundary  pass=${pass}  fail=${fail}`);
if (fail > 0) process.exit(1);
console.log('verify-sunset-booking-component-boundary — ALL CHECKS PASSED');
