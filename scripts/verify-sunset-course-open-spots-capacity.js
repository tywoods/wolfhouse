'use strict';

/**
 * verify:sunset-course-open-spots-capacity
 *
 * Bug Finder P1 (2026-09-07) — Group course capacity must use open spots
 * (capacity − booked), never invent "24 seats", and quote must propagate
 * seats_remaining so staff Create shows accurate leftover copy.
 *
 * Run:
 *   node scripts/verify-sunset-course-open-spots-capacity.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  assertCourseAssignable,
  mapCourseCapacityGateFailure,
  normalizeCoursePartyQuantity,
} = require('./lib/sunset-admin-course-join');

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

const PACK_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const COURSE_DATE = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 40);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 1 ? 0 : (8 - day) % 7));
  return d.toISOString().slice(0, 10);
})();

function packRow(groupSize) {
  return {
    id: PACK_ID,
    label: 'Curso Matutino',
    config_json: {
      age_band: '12_and_up',
      group_size: groupSize,
      beaches: ['somo'],
      weekly: 'mon_fri',
      schedules: ['0930_1130'],
      price_tiers: [{ key: '1_day', label: '1 day', hours: 2, amount_cents: 4500 }],
    },
  };
}

function makePg(opts = {}) {
  const packs = opts.packs || [packRow(24)];
  const existingCourseSeats = opts.existingCourseSeats || {};
  return {
    query: async (sql, params) => {
      const s = String(sql);
      if (/SELECT id FROM clients WHERE slug/i.test(s)) {
        return { rows: [{ id: 'client-sunset-uuid' }] };
      }
      if (/FROM tenant_surf_pack_rules/i.test(s)) {
        return {
          rows: packs.map((p) => ({
            id: p.id,
            label: p.label,
            config_json: p.config_json,
            active: true,
            location_id: 'sunset-somo',
          })),
        };
      }
      if (/FROM booking_service_records/i.test(s) && /seats/i.test(s)) {
        const courseId = params[2];
        const date = String(params[1]).slice(0, 10);
        const key = `${courseId}|${date}`;
        return { rows: [{ seats: existingCourseSeats[key] || 0 }] };
      }
      return { rows: [] };
    },
  };
}

console.log('\n[1] Party quantity normalizer');
assert('normalize 2', normalizeCoursePartyQuantity(2) === 2);
assert('normalize string 3', normalizeCoursePartyQuantity('3') === 3);
assert('blank → 1 (not capacity)', normalizeCoursePartyQuantity(null) === 1);
assert('0 → 1', normalizeCoursePartyQuantity(0) === 1);

console.log('\n[2] Open spots gate — small party succeeds when seats remain');
(async () => {
  const pgOpen = makePg({
    packs: [packRow(24)],
    existingCourseSeats: { [`${PACK_ID}|${COURSE_DATE}`]: 3 }, // 21 open
  });
  const small = await assertCourseAssignable(pgOpen, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    courseId: PACK_ID,
    serviceDates: [COURSE_DATE],
    quantity: 2,
  });
  assert('small party ok when 21 open', small.ok === true, JSON.stringify(small));
  assert(
    'capacity_by_date reports open_spots 21',
    small.capacity_by_date
      && small.capacity_by_date[0]
      && small.capacity_by_date[0].open_spots === 21
      && small.capacity_by_date[0].seats_remaining === 21,
    JSON.stringify(small.capacity_by_date),
  );

  console.log('\n[3] Party larger than open spots → course_full with accurate leftover');
  const pgShort = makePg({
    packs: [packRow(24)],
    existingCourseSeats: { [`${PACK_ID}|${COURSE_DATE}`]: 22 }, // 2 open
  });
  const shortfall = await assertCourseAssignable(pgShort, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    courseId: PACK_ID,
    serviceDates: [COURSE_DATE],
    quantity: 5,
  });
  assert('shortfall fails', shortfall.ok === false && shortfall.body.error === 'course_full', JSON.stringify(shortfall));
  assert('seats_remaining is 2 (not capacity 24)', shortfall.body.seats_remaining === 2, JSON.stringify(shortfall.body));
  assert('open_spots alias is 2', shortfall.body.open_spots === 2, JSON.stringify(shortfall.body));
  assert('requested_quantity is 5', shortfall.body.requested_quantity === 5, JSON.stringify(shortfall.body));

  console.log('\n[4] Full course → 0 open spots');
  const pgFull = makePg({
    packs: [packRow(24)],
    existingCourseSeats: { [`${PACK_ID}|${COURSE_DATE}`]: 24 },
  });
  const full = await assertCourseAssignable(pgFull, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    courseId: PACK_ID,
    serviceDates: [COURSE_DATE],
    quantity: 1,
  });
  assert('full fails', full.ok === false && full.body.error === 'course_full', JSON.stringify(full));
  assert('open_spots 0', full.body.open_spots === 0 && full.body.seats_remaining === 0, JSON.stringify(full.body));

  console.log('\n[5] Quote remap must preserve open spots (regression: invented 24)');
  const mapped = mapCourseCapacityGateFailure(shortfall, { course_id: PACK_ID });
  assert('mapped reason_code course_full', mapped.body.reason_code === 'course_full');
  assert('mapped keeps seats_remaining 2', mapped.body.seats_remaining === 2, JSON.stringify(mapped.body));
  assert('mapped keeps open_spots 2', mapped.body.open_spots === 2, JSON.stringify(mapped.body));
  assert('mapped keeps requested_quantity 5', mapped.body.requested_quantity === 5);
  assert('mapped does not invent capacity-as-message-only', mapped.body.seats_remaining !== 24);

  const strippedLegacy = {
    ok: false,
    status: 409,
    body: { success: false, error: 'course_full', reason_code: 'course_full' },
  };
  const mappedStripped = mapCourseCapacityGateFailure(strippedLegacy, { course_id: PACK_ID });
  assert(
    'stripped body leaves seats_remaining null (portal must not invent 24)',
    mappedStripped.body.seats_remaining == null && mappedStripped.body.open_spots == null,
    JSON.stringify(mappedStripped.body),
  );

  console.log('\n[6] Portal copy uses open spots — never invents 24');
  const portalSrc = fs.readFileSync(
    path.join(__dirname, 'browser/sunset-schedule-portal-module.js'),
    'utf8',
  );
  assert('portal no longer hardcodes fallback 24 seats message', !/This course only has/.test(portalSrc));
  assert('portal uses open spots language', /open spots/.test(portalSrc) && /plazas abiertas/.test(portalSrc));
  assert('quote service uses mapCourseCapacityGateFailure',
    /mapCourseCapacityGateFailure/.test(
      fs.readFileSync(path.join(__dirname, 'lib/luna-front-desk-quote-service.js'), 'utf8'),
    ));

  // Execute schedulePortalQuoteFailureMessage against capacity bodies.
  const fnStart = portalSrc.indexOf('function schedulePortalQuoteFailureMessage(');
  assert('failure message fn present', fnStart >= 0);
  let depth = 0;
  let end = -1;
  for (let i = portalSrc.indexOf('{', fnStart); i < portalSrc.length; i += 1) {
    if (portalSrc[i] === '{') depth += 1;
    else if (portalSrc[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const fnSrc = portalSrc.slice(fnStart, end);
  const sandbox = {
    portalT: (k) => {
      // Simulate missing translations so hardcoded open-spots fallbacks apply.
      if (String(k || '').indexOf('schedule.create.course') === 0) return k;
      return k;
    },
    portalLang: 'en',
  };
  // Force fallbacks: portalT returning the key is truthy — stub empty for capacity keys.
  sandbox.portalT = (k) => {
    if (/courseCapacityNotConfigured|courseFullOpenSpots|courseNotEnoughOpenSpots/.test(String(k || ''))) {
      return '';
    }
    return String(k || '');
  };
  vm.runInNewContext(`${fnSrc}\nthis.schedulePortalQuoteFailureMessage = schedulePortalQuoteFailureMessage;`, sandbox);
  const msgFull = sandbox.schedulePortalQuoteFailureMessage({
    ok: false,
    body: { reason_code: 'course_full', seats_remaining: 0, open_spots: 0, requested_quantity: 2 },
  });
  assert('full message mentions 0 open spots', /0 open spots/i.test(msgFull), msgFull);
  assert('full message does not invent 24', !/24/.test(msgFull), msgFull);

  const msgShort = sandbox.schedulePortalQuoteFailureMessage({
    ok: false,
    body: {
      reason_code: 'course_full',
      seats_remaining: 2,
      open_spots: 2,
      requested_quantity: 5,
    },
  });
  assert('shortfall message shows 2 open / needs 5', /2 open spots/.test(msgShort) && /needs 5/.test(msgShort), msgShort);
  assert('shortfall does not say only has 24 seats', !/only has 24 seats/i.test(msgShort), msgShort);

  const msgMissing = sandbox.schedulePortalQuoteFailureMessage({
    ok: false,
    body: { reason_code: 'course_full' },
  });
  assert(
    'missing leftover does not invent 24',
    !/24/.test(msgMissing) && /open spots|Not enough/i.test(msgMissing),
    msgMissing,
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
