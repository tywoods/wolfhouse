'use strict';

/**
 * verify:sunset-drawer-update-luna
 *
 * Staff drawer update must replace Luna service rows without duplication
 * and preserve Luna creator attribution.
 *
 * Run: node scripts/verify-sunset-drawer-update-luna.js
 */

const path = require('path');
const writesPath = path.join(__dirname, 'lib', 'sunset-schedule-booking-writes.js');
const drawerPath = path.join(__dirname, 'lib', 'sunset-schedule-booking-drawer.js');
require(writesPath).resolveFullDayEquipmentAddonUnitCents = async () => 1000;
const tenantWritesPath = path.join(__dirname, 'lib', 'tenant-services-writes.js');
require(tenantWritesPath).ensureBookingServiceGenericType = async () => {};
delete require.cache[drawerPath];
const { updateSunsetScheduleBooking } = require('./lib/sunset-schedule-booking-drawer');
const {
  LUNA_DB_SOURCE,
  LUNA_METADATA_SOURCE_TAG,
} = require('./lib/sunset-schedule-booking-writes');
const { rowSourceLabel } = require('./lib/sunset-schedule-ops');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

const BOOKING_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function buildMockPg(opts) {
  const state = {
    bookings: [{
      booking_id: BOOKING_ID,
      booking_code: 'SUNSET-20260802-LUNA',
      guest_name: 'Luna Guest',
      phone: '+34111111111',
      status: 'hold',
      payment_status: 'waiting_payment',
      check_in: '2026-08-02',
      check_out: '2026-08-04',
      guest_count: 2,
      total_amount_cents: 9000,
      amount_paid_cents: 0,
      balance_due_cents: 9000,
      metadata: {
        source: LUNA_METADATA_SOURCE_TAG,
        luna_guest_booking: true,
        actor_source: 'agent_luna_whatsapp_bot',
        location_id: 'sunset-somo',
      },
    }],
    services: [
      { id: 'sr-lesson-1', service_record_id: 'sr-lesson-1', service_type: 'surf_lesson', service_date: '2026-08-02', quantity: 2, amount_due_cents: 4500, amount_paid_cents: 0, payment_status: 'pending', record_source: LUNA_DB_SOURCE, metadata_source: LUNA_METADATA_SOURCE_TAG, staff_manual_schedule: 'false', location_id: 'sunset-somo', metadata: { source: LUNA_METADATA_SOURCE_TAG, component: 'lesson' }, metadata_component: 'lesson' },
      { id: 'sr-pl-1', service_record_id: 'sr-pl-1', service_type: 'surf_lesson', service_date: '2026-08-03', quantity: 1, amount_due_cents: 8000, amount_paid_cents: 0, payment_status: 'pending', record_source: LUNA_DB_SOURCE, metadata_source: LUNA_METADATA_SOURCE_TAG, staff_manual_schedule: 'false', location_id: 'sunset-somo', metadata: { source: LUNA_METADATA_SOURCE_TAG, component: 'private_lesson' }, metadata_component: 'private_lesson', service_time_local: '10:00', service_time_local_end: '12:00', slot_time: '10:00' },
      { id: 'sr-addon-1', service_record_id: 'sr-addon-1', service_type: 'addon_service', service_date: '2026-08-02', quantity: 2, amount_due_cents: 2000, amount_paid_cents: 0, payment_status: 'pending', record_source: LUNA_DB_SOURCE, metadata_source: LUNA_METADATA_SOURCE_TAG, staff_manual_schedule: 'false', location_id: 'sunset-somo', metadata: { source: LUNA_METADATA_SOURCE_TAG, component: 'full_day_equipment_extension', service_key: 'full_day_equipment_extension' }, metadata_component: 'full_day_equipment_extension' },
      { id: 'sr-rental-1', service_record_id: 'sr-rental-1', service_type: 'surfboard', service_date: '2026-08-04', quantity: 1, amount_due_cents: 1500, amount_paid_cents: 0, payment_status: 'pending', record_source: LUNA_DB_SOURCE, metadata_source: LUNA_METADATA_SOURCE_TAG, staff_manual_schedule: 'false', location_id: 'sunset-somo', metadata: { source: LUNA_METADATA_SOURCE_TAG, component: 'surfboard' }, metadata_component: 'surfboard' },
    ],
    deletedSources: [],
    insertFailOnce: opts && opts.insertFailOnce,
    insertFailed: false,
    txSnapshot: null,
  };

  const pg = {
    state,
    query: async (sql, params) => {
      const q = String(sql);
      if (/^BEGIN/i.test(q)) {
        state.inTx = true;
        state.txSnapshot = JSON.parse(JSON.stringify(state.services));
        return { rows: [] };
      }
      if (/COMMIT/i.test(q)) { state.inTx = false; state.txSnapshot = null; return { rows: [] }; }
      if (/ROLLBACK/i.test(q)) {
        if (state.txSnapshot) state.services = state.txSnapshot;
        state.inTx = false;
        state.txSnapshot = null;
        return { rows: [] };
      }
      if (/FROM bookings b[\s\S]*INNER JOIN clients/i.test(q)) {
        return { rows: [state.bookings[0]] };
      }
      if (/FROM booking_service_records/i.test(q) && /ORDER BY service_date/i.test(q)) {
        return { rows: state.services };
      }
      if (/DELETE FROM booking_service_records/i.test(q)) {
        const sources = Array.isArray(params[2]) ? params[2] : [params[2]];
        state.deletedSources.push(...sources);
        state.services = state.services.filter((s) => !sources.includes(s.record_source));
        return { rowCount: state.deletedSources.length };
      }
      if (/UPDATE bookings/i.test(q) && /guest_name/i.test(q)) {
        const meta = parseMeta(params[7]);
        state.bookings[0].guest_name = params[0];
        state.bookings[0].metadata = { ...state.bookings[0].metadata, ...meta };
        return { rows: [] };
      }
      if (/INSERT INTO booking_service_records/i.test(q)) {
        if (state.insertFailOnce && !state.insertFailed) {
          state.insertFailed = true;
          throw new Error('simulated_insert_failure');
        }
        let source = null;
        let metaRaw = null;
        let serviceType = params[4];
        let serviceDate = params[5];
        let quantity = params[6];
        if (/'addon_service'/.test(q)) {
          serviceType = 'addon_service';
          serviceDate = params[4];
          quantity = params[5];
          source = params[8];
          metaRaw = params[9];
        } else if (params.length >= 13) {
          source = params[11];
          metaRaw = params[12];
        } else if (params.length >= 10) {
          source = params[8];
          metaRaw = params[9];
        }
        const meta = parseMeta(metaRaw);
        const row = {
          service_record_id: `sr-new-${state.services.length}`,
          service_type: serviceType,
          service_date: serviceDate,
          quantity,
          record_source: source,
          metadata: meta,
          metadata_source: meta.source,
          metadata_component: meta.component || meta.service_key,
          amount_due_cents: 0,
          _deleted: false,
        };
        state.services.push(row);
        return { rows: [row] };
      }
      if (/ensureBookingServiceGenericType|tenant-services-writes/i.test(q)) return { rows: [] };
      if (/tenant_price_rules|resolveTenantBusinessConfig|private_lesson_rules/i.test(q)) return { rows: [] };
      if (/SELECT metadata FROM bookings/i.test(q)) return { rows: [{ metadata: state.bookings[0].metadata }] };
      if (/FROM payments/i.test(q)) return { rows: [] };
      if (/SUM\(amount_paid_cents\)/i.test(q)) return { rows: [{ paid_total: 0 }] };
      return { rows: [] };
    },
  };
  return pg;
}

console.log('\nverify:sunset-drawer-update-luna\n');

(async () => {
  const pg = buildMockPg();
  const updateBody = {
    guest_name: 'Luna Guest Edited',
    payment_status: 'unpaid',
    service_dates: ['2026-08-02', '2026-08-04'],
    components: {
      lesson: { quantity: 2, slot_time: '10:00' },
      surfboard: { quantity: 1 },
      full_day_equipment_extension: { enabled: true, dates: { '2026-08-02': 2 } },
      private_lesson: {
        enabled: true,
        quantity: 1,
        surfer_count: 1,
        sessions: [{ date: '2026-08-03', start: '10:00', end: '12:00' }],
      },
    },
  };

  const result = await updateSunsetScheduleBooking(pg, {
    clientSlug: 'sunset',
    bookingId: BOOKING_ID,
    locationId: 'sunset-somo',
    actor: { email: 'staff@sunset.test' },
    body: updateBody,
  });

  const active = pg.state.services;
  const byKey = (component, date) => active.filter((s) => {
    const m = parseMeta(s.metadata);
    return (m.component || s.metadata_component) === component
      && String(s.service_date || '').slice(0, 10) === date;
  });

  assert('update succeeds', result.ok === true);
  assert('deletes luna_guest rows', pg.state.deletedSources.includes(LUNA_DB_SOURCE));
  assert('deletes staff_manual rows', pg.state.deletedSources.includes('staff_manual'));
  assert('no duplicate lesson row per date', byKey('lesson', '2026-08-02').length === 1,
    `count=${byKey('lesson', '2026-08-02').length}`);
  assert('no duplicate private lesson', byKey('private_lesson', '2026-08-03').length === 1);
  assert('no duplicate add-on row', byKey('full_day_equipment_extension', '2026-08-02').length === 1,
    `count=${byKey('full_day_equipment_extension', '2026-08-02').length}`);
  assert('booking creator still Luna',
    pg.state.bookings[0].metadata.source === LUNA_METADATA_SOURCE_TAG
    && pg.state.bookings[0].metadata.luna_guest_booking === true);
  assert('staff edit metadata recorded',
    pg.state.bookings[0].metadata.last_edited_by_staff === 'staff@sunset.test');
  assert('replacement rows keep Luna source',
    active.every((s) => s.record_source === LUNA_DB_SOURCE));
  assert('UI label still Luna',
    rowSourceLabel({ metadata_source: LUNA_METADATA_SOURCE_TAG, record_source: LUNA_DB_SOURCE }) === 'Luna');

  console.log('\n[rollback on insert failure restores original set]');
  const pgFail = buildMockPg({ insertFailOnce: true });
  const beforeCount = pgFail.state.services.length;
  let threw = false;
  try {
    await updateSunsetScheduleBooking(pgFail, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: 'sunset-somo',
      actor: { email: 'staff@sunset.test' },
      body: updateBody,
    });
  } catch (_) {
    threw = true;
  }
  const afterActive = pgFail.state.services;
  assert('insert failure throws', threw === true);
  assert('rollback leaves original service count', afterActive.length === beforeCount,
    `before=${beforeCount} after=${afterActive.length}`);

  console.log(`\n── verify:sunset-drawer-update-luna ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  if (fail > 0) process.exit(1);
})();
