'use strict';

/**
 * verify:sunset-admin-course-join
 *
 * TDD gate — course bookings JOIN existing admin-configured surf packs
 * (tenant_surf_pack_rules). Invented course_ids and arbitrary off-schedule
 * dates are rejected with no write. Capacity = group_size − confirmed seats.
 *
 * Run:
 *   node scripts/verify-sunset-admin-course-join.js
 */

const fs = require('fs');
const path = require('path');
const {
  createSunsetScheduleBooking,
  resolveScheduleBookingAttribution,
  LUNA_DB_SOURCE,
  LUNA_METADATA_SOURCE_TAG,
} = require('./lib/sunset-schedule-booking-writes');
const {
  listJoinableSunsetOfferings,
  assertCourseAssignable,
  datesBelongToPackSchedule,
  weekdaysFromPackWeekly,
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
const OTHER_LOC_PACK = 'ffffffff-1111-4222-8333-444444444444';
const INVENTED_COURSE = 'invented-course-not-in-admin';

// Next Monday (UTC) on/after a fixed future anchor so date-boundary stays green.
function nextMondayOnOrAfter(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  const day = d.getUTCDay();
  const add = day === 1 ? 0 : (8 - day) % 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString().slice(0, 10);
}
const COURSE_DATE = nextMondayOnOrAfter('2026-08-03'); // Monday
const WEEKEND_DATE = (() => {
  const d = new Date(`${COURSE_DATE}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 5); // Saturday
  return d.toISOString().slice(0, 10);
})();

function packRow(overrides = {}) {
  return {
    id: PACK_ID,
    label: 'Adults Mon–Fri mornings',
    config_json: {
      age_band: '12_and_up',
      group_size: 2,
      beaches: ['somo'],
      weekly: 'mon_fri',
      schedules: ['0930_1130'],
      price_tiers: [{ key: '1_week', label: '1 week', hours: 10, amount_cents: 18000 }],
      ...(overrides.config_json || {}),
    },
    ...overrides,
  };
}

function makePg(opts = {}) {
  const packs = opts.packs || [packRow()];
  const existingCourseSeats = opts.existingCourseSeats || {}; // `${courseId}|${date}` → seats
  const inserts = [];
  const begins = { n: 0 };
  let rolledBack = false;
  const captured = [];

  return {
    inserts,
    begins,
    rolledBack: () => rolledBack,
    captured,
    query: async (sql, params) => {
      const s = String(sql);
      captured.push({ sql: s, params: params ? [...params] : [] });
      if (/^BEGIN/i.test(s)) { begins.n += 1; return { rows: [] }; }
      if (/^COMMIT/i.test(s)) return { rows: [] };
      if (/^ROLLBACK/i.test(s)) { rolledBack = true; return { rows: [] }; }
      if (/SELECT id FROM clients WHERE slug/i.test(s)) {
        return { rows: [{ id: 'client-sunset-uuid' }] };
      }
      if (/information_schema\.tables/i.test(s) && /tenant_surf_pack_rules/i.test(s)) {
        return { rows: [{ '?column?': 1 }] };
      }
      if (/information_schema\.columns/i.test(s)) {
        // loadSurfPacksFromDb + price resolve require location_id columns.
        if (/tenant_surf_pack_rules|tenant_price_rules/i.test(s)
          || (params && /tenant_surf_pack_rules|tenant_price_rules/.test(String(params[0] || '')))) {
          return { rows: [{ '?column?': 1 }] };
        }
        return { rows: [] };
      }
      if (/FROM tenant_surf_pack_rules/i.test(s)) {
        const slug = params[0];
        const loc = params.length > 1 ? params[1] : null;
        const rows = packs.filter((p) => {
          if (p._client_slug && p._client_slug !== slug) return false;
          if (loc && p._location_id && p._location_id !== loc) return false;
          if (p._active === false) return false;
          return true;
        }).map((p) => ({
          id: p.id,
          label: p.label,
          config_json: p.config_json,
        }));
        return { rows };
      }
      if (/COALESCE\(SUM/i.test(s) && /booking_service_records/i.test(s)) {
        const date = params[1];
        const courseId = params[2];
        const key = `${courseId}|${String(date).slice(0, 10)}`;
        const seats = existingCourseSeats[key] != null ? existingCourseSeats[key] : 0;
        return { rows: [{ seats }] };
      }
      if (/to_regclass/i.test(s)) {
        return { rows: [{ reg: 'tenant_price_rules' }] };
      }
      if (/FROM tenant_price_rules/i.test(s)) {
        // Canonical package price for pack tiers so create preflight can resolve.
        const itemCode = params[2];
        const unit = params[3];
        const locationId = params[4];
        if (String(itemCode || '').startsWith('surf_pack_') && unit === 'day') {
          return {
            rows: [{
              id: 'price-pack-1',
              amount_cents: 18000,
              currency: 'EUR',
              item_type: 'package',
              item_code: itemCode,
              unit: 'day',
              location_id: locationId || 'sunset-somo',
            }],
          };
        }
        return { rows: [] };
      }
      if (/UPDATE booking_service_records/i.test(s) && /amount_due_cents/i.test(s)) {
        return { rows: [] };
      }
      if (/UPDATE bookings SET/i.test(s)) {
        return { rows: [] };
      }
      if (/SELECT metadata FROM bookings/i.test(s)) {
        return {
          rows: [{
            metadata: {
              location_id: 'sunset-somo',
              source: 'luna_guest_whatsapp',
              staff_manual_schedule: false,
            },
          }],
        };
      }
      if (/SELECT id, service_type/i.test(s) && /FROM booking_service_records/i.test(s)) {
        const rows = inserts.filter((i) => i.table === 'booking_service_records').map((i, idx) => {
          const meta = typeof i.params[9] === 'string' ? JSON.parse(i.params[9]) : i.params[9];
          return {
            id: `sr-${idx + 1}`,
            service_type: i.params[4],
            service_date: i.params[5],
            quantity: i.params[6],
            amount_due_cents: 0,
            metadata: meta,
          };
        });
        return { rows };
      }
      if (/UPDATE booking_service_records SET amount_due_cents/i.test(s)) {
        return { rows: [] };
      }
      if (/UPDATE bookings/i.test(s) && /total_amount_cents/i.test(s)) {
        return { rows: [] };
      }
      if (/INSERT INTO bookings/i.test(s)) {
        inserts.push({ table: 'bookings', params });
        return { rows: [{ id: 'booking-uuid-1' }] };
      }
      if (/INSERT INTO booking_service_records/i.test(s)) {
        inserts.push({ table: 'booking_service_records', params, sql: s });
        return {
          rows: [{
            id: `sr-${inserts.length}`,
            booking_id: 'booking-uuid-1',
            booking_code: params[2] || 'SUN-X',
            guest_name: params[3],
            service_type: params[4],
            service_date: params[5],
            quantity: params[6],
            payment_status: params[7],
            source: params[8],
            metadata: typeof params[9] === 'string' ? JSON.parse(params[9]) : params[9],
            status: 'confirmed',
          }],
        };
      }
      if (/FROM booking_service_records/i.test(s) && /idempotency/i.test(s)) {
        return { rows: [] };
      }
      if (/metadata->>'idempotency_key'/i.test(s)) return { rows: [] };
      // Config async for group lessons — keep empty.
      if (/to_regclass/i.test(s) || /information_schema/i.test(s) || /tenant_/i.test(s)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

async function main() {
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';
  console.log('\nverify:sunset-admin-course-join — assign to admin courses, never mint\n');

  console.log('[0] Schedule helpers');
  assert('mon_fri weekdays are 1–5', JSON.stringify(weekdaysFromPackWeekly('mon_fri')) === '[1,2,3,4,5]');
  const pack = {
    pack_id: PACK_ID,
    weekly: 'mon_fri',
    group_size: 2,
    label: 'Adults',
    schedules: ['0930_1130'],
  };
  assert('Monday belongs to mon_fri pack',
    datesBelongToPackSchedule(pack, [COURSE_DATE]).ok === true);
  assert('Saturday rejected for mon_fri pack',
    datesBelongToPackSchedule(pack, [WEEKEND_DATE]).ok === false
    && datesBelongToPackSchedule(pack, [WEEKEND_DATE]).error === 'service_dates_not_on_course_schedule');

  console.log('\n[A] Discovery lists admin courses with DB capacity');
  const pgDiscover = makePg({
    packs: [packRow()],
    existingCourseSeats: { [`${PACK_ID}|${COURSE_DATE}`]: 1 },
  });
  const listed = await listJoinableSunsetOfferings(pgDiscover, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    date: COURSE_DATE,
  });
  assert('discovery ok', listed.ok === true, JSON.stringify(listed));
  assert('discovery returns the admin pack',
    listed.courses.some((c) => c.course_id === PACK_ID), JSON.stringify(listed.courses));
  const found = listed.courses.find((c) => c.course_id === PACK_ID);
  assert('capacity = group_size', found && found.capacity === 2, JSON.stringify(found));
  assert('seats_booked from DB', found && found.seats_booked === 1, JSON.stringify(found));
  assert('seats_remaining = capacity − booked', found && found.seats_remaining === 1, JSON.stringify(found));
  assert('source_tables include surf_pack + booking rows',
    Array.isArray(listed.source_tables)
    && listed.source_tables.includes('tenant_surf_pack_rules')
    && listed.source_tables.includes('booking_service_records'));

  console.log('\n[B] Unknown / invented course_id → rejected, no write');
  const pgInvent = makePg({ packs: [packRow()] });
  const invent = await createSunsetScheduleBooking(pgInvent, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    actor: { source: 'agent_luna_whatsapp_bot' },
    body: {
      guest_name: 'Invent Guest',
      payment_status: 'unpaid',
      service_dates: [COURSE_DATE],
      components: {
        course: { quantity: 1, course_id: INVENTED_COURSE, course_label: 'Made up course', tier_key: '1_week' },
      },
    },
  });
  assert('invented course rejected', invent.ok === false && invent.body && invent.body.error === 'unknown_course_id',
    JSON.stringify(invent));
  assert('invented course issues zero booking inserts',
    pgInvent.inserts.filter((i) => i.table === 'bookings').length === 0, JSON.stringify(pgInvent.inserts));
  assert('invented course issues zero service-record inserts',
    pgInvent.inserts.filter((i) => i.table === 'booking_service_records').length === 0);
  assert('invented course never BEGINs a write txn', pgInvent.begins.n === 0);

  console.log('\n[C] Valid course_id → assigned to admin course on real schedule');
  const pgValid = makePg({ packs: [packRow()] });
  const valid = await createSunsetScheduleBooking(pgValid, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    actor: { source: 'agent_luna_whatsapp_bot' },
    body: {
      guest_name: 'Join Guest',
      payment_status: 'unpaid',
      service_dates: [COURSE_DATE],
      components: {
        course: { quantity: 1, course_id: PACK_ID, tier_key: '1_week' },
      },
    },
  });
  assert('valid course create ok', valid.ok === true, JSON.stringify(valid));
  assert('response includes assigned_course',
    valid.body && valid.body.assigned_course && valid.body.assigned_course.course_id === PACK_ID,
    JSON.stringify(valid.body && valid.body.assigned_course));
  const srInserts = pgValid.inserts.filter((i) => i.table === 'booking_service_records');
  assert('one service row inserted', srInserts.length === 1, String(srInserts.length));
  const meta = srInserts[0].params[9] && JSON.parse(srInserts[0].params[9]);
  assert('metadata.course_id is admin pack id', meta && meta.course_id === PACK_ID, JSON.stringify(meta));
  assert('metadata.admin_course_assigned', meta && meta.admin_course_assigned === true);
  assert('service_date is the admin schedule date',
    String(srInserts[0].params[5]).slice(0, 10) === COURSE_DATE);

  console.log('\n[D] Off-schedule date rejected');
  const pgOff = makePg({ packs: [packRow()] });
  const off = await createSunsetScheduleBooking(pgOff, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    actor: { source: 'agent_luna_whatsapp_bot' },
    body: {
      guest_name: 'Weekend Guest',
      payment_status: 'unpaid',
      service_dates: [WEEKEND_DATE],
      components: { course: { quantity: 1, course_id: PACK_ID, tier_key: '1_week' } },
    },
  });
  assert('off-schedule rejected',
    off.ok === false && off.body && (/service_dates_not_on_course_schedule|weekdays|weekend|not available/i.test(String(off.body.error||'')) || off.body.reason_code === 'service_dates_not_on_course_schedule'),
    JSON.stringify(off));
  assert('off-schedule no writes', pgOff.inserts.length === 0);

  console.log('\n[E] Full course → fail closed');
  const pgFull = makePg({
    packs: [packRow()],
    existingCourseSeats: { [`${PACK_ID}|${COURSE_DATE}`]: 2 },
  });
  const full = await createSunsetScheduleBooking(pgFull, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    actor: { source: 'agent_luna_whatsapp_bot' },
    body: {
      guest_name: 'Full Guest',
      payment_status: 'unpaid',
      service_dates: [COURSE_DATE],
      components: { course: { quantity: 1, course_id: PACK_ID, tier_key: '1_week' } },
    },
  });
  assert('full course → course_full',
    full.ok === false && full.body && full.body.error === 'course_full', JSON.stringify(full));
  assert('full course no writes', pgFull.inserts.length === 0);

  console.log('\n[F] Attribution preserved (Luna)');
  const attr = resolveScheduleBookingAttribution({ source: 'agent_luna_whatsapp_bot' });
  assert('luna db source', attr.dbSource === LUNA_DB_SOURCE);
  assert('luna metadata source', attr.metadataSource === LUNA_METADATA_SOURCE_TAG);
  const pgAttr = makePg({ packs: [packRow()] });
  const attributed = await createSunsetScheduleBooking(pgAttr, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    actor: { source: 'agent_luna_whatsapp_bot' },
    body: {
      guest_name: 'Luna Guest',
      payment_status: 'unpaid',
      service_dates: [COURSE_DATE],
      components: { course: { quantity: 1, course_id: PACK_ID, tier_key: '1_week' } },
    },
  });
  assert('create ok for attribution case', attributed.ok === true, JSON.stringify(attributed));
  const sr = pgAttr.inserts.find((i) => i.table === 'booking_service_records');
  assert('service source is luna_guest', sr && sr.params[8] === LUNA_DB_SOURCE, JSON.stringify(sr && sr.params));
  const aMeta = JSON.parse(sr.params[9]);
  assert('metadata source is luna_guest_whatsapp', aMeta.source === LUNA_METADATA_SOURCE_TAG);

  console.log('\n[G] Private lesson + rental paths unchanged (no course gate)');
  const pgPl = makePg({ packs: [] });
  // assertCourseAssignable only — private/rental create exercises other modules;
  // gate must not run without a course component. Spot-check gate isolation:
  const noCourse = await assertCourseAssignable(pgPl, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    courseId: '',
    serviceDates: [COURSE_DATE],
    quantity: 1,
  });
  assert('empty course_id fails closed at gate',
    noCourse.ok === false && noCourse.body.error === 'unknown_course_id');

  // Plugin + route wiring
  const plugin = fs.readFileSync(
    path.join(__dirname, '../docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'),
    'utf8',
  );
  assert('plugin exposes get_sunset_joinable_courses', /def get_sunset_joinable_courses/.test(plugin));
  assert('plugin registers joinable-courses tool', /get_sunset_joinable_courses/.test(plugin)
    && /\/sunset\/joinable-courses/.test(plugin));
  const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  assert('staff API has joinable-courses route',
    api.includes("/staff/bot/sunset/joinable-courses")
    && api.includes('handleBotSunsetJoinableCourses'));
  assert('staff API route is sunset-scoped path',
    /\/staff\/bot\/sunset\/joinable-courses/.test(api));

  console.log('\n[H] Location isolation on assignment');
  const pgLoc = makePg({
    packs: [packRow({ id: PACK_ID, _location_id: 'sunset-somo' })],
  });
  // loadSurfPacksFromDb filters by location param — our mock filters _location_id
  const wrongLoc = await createSunsetScheduleBooking(pgLoc, {
    clientSlug: 'sunset',
    locationId: 'sunset-sardinero',
    actor: { source: 'agent_luna_whatsapp_bot' },
    body: {
      guest_name: 'Cross Loc',
      payment_status: 'unpaid',
      service_dates: [COURSE_DATE],
      components: { course: { quantity: 1, course_id: PACK_ID, tier_key: '1_week' } },
    },
  });
  assert('Somo pack not joinable from Sardinero',
    wrongLoc.ok === false && wrongLoc.body && wrongLoc.body.error === 'unknown_course_id',
    JSON.stringify(wrongLoc));

  console.log(`\nTotals: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
