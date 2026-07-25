'use strict';

/**
 * verify:sunset-schedule-booking-attribution
 *
 * Persistence tests for Sunset schedule booking write attribution.
 * Luna bot actor → luna_guest; staff portal actor → staff_manual.
 *
 * Run: node scripts/verify-sunset-schedule-booking-attribution.js
 */

const { rowSourceLabel } = require('./lib/sunset-schedule-ops');
const {
  createSunsetScheduleBooking,
  scheduleRowFromDb,
  resolveScheduleBookingAttribution,
  LUNA_DB_SOURCE,
  LUNA_METADATA_SOURCE_TAG,
  DB_SOURCE,
  METADATA_SOURCE_TAG,
  isLunaTrustedActor,
  buildScheduleBookingIntentFingerprint,
  evaluateIdempotentReplay,
  scheduleBookingIdempotencyAdvisoryKeys,
  validateScheduleBookingBody,
  prepareCanonicalRentalsForCreate,
} = require('./lib/sunset-schedule-booking-writes');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function buildMockPg() {
  const PACK_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const state = {
    clientId: '11111111-1111-1111-1111-111111111111',
    bookings: [],
    serviceRecords: [],
    idempotency: new Map(),
    packId: PACK_ID,
  };

  const pg = {
    state,
    query: async (sql, params) => {
      const q = String(sql);
      if (/SELECT id FROM clients WHERE slug/i.test(q)) {
        return { rows: [{ id: state.clientId }] };
      }
      if (/BEGIN|COMMIT|ROLLBACK/i.test(q)) return { rows: [] };
      if (/pg_advisory_xact_lock/i.test(q)) return { rows: [{}] };
      if (/information_schema\.tables/i.test(q) && /tenant_surf_pack_rules/i.test(q)) {
        return { rows: [{ '?column?': 1 }] };
      }
      if (/information_schema\.columns/i.test(q) && (params && params[0] === 'tenant_surf_pack_rules' || /tenant_surf_pack_rules/i.test(q))) {
        return { rows: [{ '?column?': 1 }] };
      }
      if (/FROM tenant_surf_pack_rules/i.test(q)) {
        return {
          rows: [{
            id: PACK_ID,
            label: '5-day',
            config_json: {
              age_band: '12_and_up',
              group_size: 16,
              beaches: ['somo'],
              weekly: 'mon_fri',
              schedules: ['0930_1130'],
              price_tiers: [{ key: '1_week', label: '1 week', hours: 10, amount_cents: 18000 }],
            },
          }],
        };
      }
      if (/COALESCE\(SUM/i.test(q) && /booking_service_records/i.test(q) && /course_id/i.test(q)) {
        return { rows: [{ seats: 0 }] };
      }
      if (/INSERT INTO bookings/i.test(q)) {
        const meta = parseMeta(params[8]);
        const row = {
          id: `bk-${state.bookings.length + 1}`,
          booking_code: params[1],
          metadata: meta,
        };
        state.bookings.push(row);
        return { rows: [{ id: row.id, booking_code: row.booking_code }] };
      }
      if (/INSERT INTO booking_service_records/i.test(q)) {
        const meta = parseMeta(params[9]);
        const row = {
          service_record_id: `sr-${state.serviceRecords.length + 1}`,
          booking_id: params[1],
          booking_code: params[2],
          guest_name: params[3],
          service_type: params[4],
          service_date: params[5],
          quantity: params[6],
          payment_status: params[7],
          record_source: params[8],
          client_slug: params[0],
          metadata: meta,
          metadata_source: meta.source,
          staff_manual_schedule: meta.staff_manual_schedule,
          location_id: meta.location_id || null,
          idempotency_intent_fp: meta.idempotency_intent_fp || null,
        };
        state.serviceRecords.push(row);
        if (meta.idempotency_key) {
          const list = state.idempotency.get(meta.idempotency_key) || [];
          list.push(row);
          state.idempotency.set(meta.idempotency_key, list);
        }
        return {
          rows: [{
            ...row,
            slot_time: meta.slot_time || null,
            notes: meta.notes || null,
            needs_reply: meta.needs_reply || false,
            staff_ui_service_type: meta.staff_ui_service_type || null,
            lesson_category: meta.lesson_category || null,
            course_id: meta.course_id || null,
            course_label: meta.course_label || null,
            metadata_component: meta.component || null,
            bundle_id: meta.bundle_id || null,
            metadata_components: meta.components ? meta.components.join(',') : null,
          }],
        };
      }
      if (/metadata->>'idempotency_key'/i.test(q)) {
        const key = params[1];
        // Tenant scope: query is client_slug + key (params[0], params[1]).
        const clientSlug = params[0];
        const rows = (state.idempotency.get(key) || []).filter((r) => {
          if (r.client_slug && clientSlug && r.client_slug !== clientSlug) return false;
          return true;
        });
        return {
          rows: rows.map((row) => ({
            ...row,
            location_id: (row.metadata && row.metadata.location_id) || row.location_id || null,
            idempotency_intent_fp: (row.metadata && row.metadata.idempotency_intent_fp) || null,
            idempotency_key: (row.metadata && row.metadata.idempotency_key) || key,
          })),
        };
      }
      if (/tenant_price_rules|full_day_equipment/i.test(q)) {
        // Enough for resolveFullDayEquipmentAddonUnitCents / tables_missing fallback paths.
        if (/to_regclass/i.test(q)) return { rows: [{ reg: null }] };
        return { rows: [] };
      }
      if (/ALTER TABLE booking_service_records/i.test(q)) return { rows: [] };
      if (/to_regclass/i.test(q)) return { rows: [{ reg: null }] };
      if (/information_schema/i.test(q)) return { rows: [] };
      return { rows: [] };
    },
  };
  return pg;
}

function assertNoStaffAttribution(rows, label) {
  for (const row of rows) {
    const meta = parseMeta(row.metadata);
    assert(`${label}: sr ${row.service_record_id} source not staff_manual`, row.record_source !== DB_SOURCE, row.record_source);
    assert(`${label}: sr ${row.service_record_id} meta.source not staff_manual_schedule`, meta.source !== METADATA_SOURCE_TAG, meta.source);
    assert(`${label}: sr ${row.service_record_id} is luna_guest`, row.record_source === LUNA_DB_SOURCE);
    assert(`${label}: sr ${row.service_record_id} meta is luna`, meta.source === LUNA_METADATA_SOURCE_TAG);
    const ui = scheduleRowFromDb(row);
    assert(`${label}: classifier Luna for ${row.service_record_id}`, rowSourceLabel(ui) === 'Luna', rowSourceLabel(ui));
  }
}

console.log('\nverify:sunset-schedule-booking-attribution\n');

console.log('[1] resolveScheduleBookingAttribution unit');
const lunaAttr = resolveScheduleBookingAttribution({ source: 'agent_luna_whatsapp_bot' });
assert('Luna actor → luna_guest db', lunaAttr.dbSource === LUNA_DB_SOURCE);
assert('Luna actor → luna_guest_whatsapp meta', lunaAttr.metadataSource === LUNA_METADATA_SOURCE_TAG);
assert('Luna actor not staff_manual_schedule', lunaAttr.staffManualSchedule === false);
assert('Luna actor preserves actor_source', lunaAttr.actorSource === 'agent_luna_whatsapp_bot');

const staffAttr = resolveScheduleBookingAttribution({ email: 'ops@sunset.test' });
assert('Staff actor → staff_manual db', staffAttr.dbSource === DB_SOURCE);
assert('Staff actor → staff_manual_schedule meta', staffAttr.metadataSource === METADATA_SOURCE_TAG);
assert('Staff actor staff_manual_schedule flag', staffAttr.staffManualSchedule === true);
assert('Staff actor created_by_staff', staffAttr.createdByStaff === 'ops@sunset.test');
assert('isLunaTrustedActor bot', isLunaTrustedActor({ source: 'agent_luna_whatsapp_bot' }));
assert('isLunaTrustedActor staff false', !isLunaTrustedActor({ email: 'x@test.com' }));

(async () => {
  console.log('\n[2] Luna rental persistence');
  const pgRental = buildMockPg();
  const rental = await createSunsetScheduleBooking(pgRental, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    actor: { source: 'agent_luna_whatsapp_bot' },
    body: {
      guest_name: 'Frankie',
      components: { surfboard: { quantity: 1 } },
      service_date: '2026-08-02',
      idempotency_key: 'luna-rental-1',
    },
  });
  assert('rental create ok', rental.ok === true);
  assertNoStaffAttribution(pgRental.state.serviceRecords, 'rental');
  const bkMeta = parseMeta(pgRental.state.bookings[0].metadata);
  assert('rental booking meta luna', bkMeta.source === LUNA_METADATA_SOURCE_TAG);

  console.log('\n[3] Luna lesson + course + private lesson + addon + multi-date');
  const pgCombo = buildMockPg();
  const comboPackId = pgCombo.state.packId;
  const combo = await createSunsetScheduleBooking(pgCombo, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    actor: { source: 'agent_luna_whatsapp_bot' },
    body: {
      guest_name: 'Group',
      // Mon–Tue 2026-08-03/04 — matches admin mon_fri pack schedule
      service_dates: ['2026-08-03', '2026-08-04'],
      components: {
        course: { quantity: 2, course_id: comboPackId, course_label: '5-day' },
        full_day_equipment_extension: { enabled: true, dates: { '2026-08-03': 2 } },
      },
      idempotency_key: 'luna-combo-1',
    },
  });
  assert('combo create ok', combo.ok === true, combo.body && combo.body.error);
  assertNoStaffAttribution(pgCombo.state.serviceRecords, 'combo');
  assert('multi-date rows > 1', pgCombo.state.serviceRecords.length >= 2);

  const pgPrivate = buildMockPg();
  const pl = await createSunsetScheduleBooking(pgPrivate, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    actor: { source: 'agent_luna_whatsapp_bot' },
    body: {
      guest_name: 'Coach',
      components: {
        private_lesson: {
          enabled: true,
          quantity: 1,
          surfer_count: 1,
          sessions: [{ date: '2026-08-02', start: '10:00', end: '12:00' }],
        },
      },
      idempotency_key: 'luna-pl-1',
    },
  });
  assert('private lesson create ok', pl.ok === true, pl.body && pl.body.error);
  assertNoStaffAttribution(pgPrivate.state.serviceRecords, 'private');

  console.log('\n[4] Idempotent replay preserves Luna attribution');
  const pgIdem = buildMockPg();
  const first = await createSunsetScheduleBooking(pgIdem, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    actor: { source: 'agent_luna_whatsapp_bot' },
    body: {
      guest_name: 'Replay',
      components: { lesson: { quantity: 1 } },
      service_date: '2026-08-02',
      idempotency_key: 'idem-luna-1',
    },
  });
  const second = await createSunsetScheduleBooking(pgIdem, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    actor: { source: 'agent_luna_whatsapp_bot' },
    body: {
      guest_name: 'Replay',
      components: { lesson: { quantity: 1 } },
      service_date: '2026-08-02',
      idempotency_key: 'idem-luna-1',
    },
  });
  assert('idempotent replay ok', second.ok && second.body.idempotent === true);
  assertNoStaffAttribution(pgIdem.state.serviceRecords, 'idem');

  console.log('\n[5] Staff manual creation stays Staff');
  const pgStaff = buildMockPg();
  const staff = await createSunsetScheduleBooking(pgStaff, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    actor: { email: 'staff@sunset.test' },
    body: {
      guest_name: 'Portal',
      components: { wetsuit: { quantity: 1 } },
      service_date: '2026-08-02',
    },
  });
  assert('staff create ok', staff.ok === true);
  for (const row of pgStaff.state.serviceRecords) {
    const meta = parseMeta(row.metadata);
    assert('staff sr source staff_manual', row.record_source === DB_SOURCE);
    assert('staff meta staff_manual_schedule', meta.source === METADATA_SOURCE_TAG);
    const ui = scheduleRowFromDb(row);
    assert('staff classifier Staff', rowSourceLabel(ui) === 'Staff', rowSourceLabel(ui));
  }

  console.log('\n[6] Slice A — durable idempotency');
  const lessonBody = (name) => ({ guest_name: name, components: { lesson: { quantity: 1 } }, service_date: '2026-08-02' });
  const vA = validateScheduleBookingBody(lessonBody('Replay'));
  const vB = validateScheduleBookingBody(lessonBody('Other'));
  const vC = validateScheduleBookingBody(lessonBody('Concurrent'));
  assert('validated fixtures', vA.ok && vB.ok && vC.ok);
  const fpA = buildScheduleBookingIntentFingerprint(vA.value, 'sunset-somo');
  const fpB = buildScheduleBookingIntentFingerprint(vB.value, 'sunset-somo');
  const fpC = buildScheduleBookingIntentFingerprint(vC.value, 'sunset-somo');
  assert('fp stable/differs', fpA === buildScheduleBookingIntentFingerprint(vA.value, 'sunset-somo') && fpA !== fpB);
  const row = {
    service_record_id: 'sr-1', booking_id: 'bk-1', booking_code: 'SUNSET-SEED-1', guest_name: 'Replay',
    service_type: 'surf_lesson', service_date: '2026-08-02', quantity: 1, payment_status: 'unpaid',
    record_source: LUNA_DB_SOURCE, client_slug: 'sunset', location_id: 'sunset-somo', idempotency_intent_fp: fpA,
    metadata: { source: LUNA_METADATA_SOURCE_TAG, location_id: 'sunset-somo', idempotency_key: 'k1', idempotency_intent_fp: fpA, component: 'lesson', staff_ui_service_type: 'lesson' },
    metadata_source: LUNA_METADATA_SOURCE_TAG, staff_ui_service_type: 'lesson', metadata_component: 'lesson',
  };
  assert('replay same intent', evaluateIdempotentReplay([row], vA.value, 'sunset-somo').replay === true);
  assert('conflict intent', evaluateIdempotentReplay([row], vB.value, 'sunset-somo').body.reason_code === 'idempotency_key_intent_conflict');
  assert('conflict location', evaluateIdempotentReplay([row], vA.value, 'sunset-sardinero').body.reason_code === 'idempotency_key_location_conflict');
  for (const badFp of [null, undefined, '', '   ']) {
    const legacy = { ...row, idempotency_intent_fp: badFp, metadata: { ...row.metadata, idempotency_intent_fp: badFp } };
    const ev = evaluateIdempotentReplay([legacy], vA.value, 'sunset-somo');
    assert(`missing fp fails closed (${JSON.stringify(badFp)})`,
      ev.ok === false && ev.status === 409 && ev.body.reason_code === 'idempotency_key_intent_unverifiable', JSON.stringify(ev));
  }
  assert('altered fp conflicts',
    evaluateIdempotentReplay([{ ...row, idempotency_intent_fp: 'deadbeef', metadata: { ...row.metadata, idempotency_intent_fp: 'deadbeef' } }], vA.value, 'sunset-somo')
      .body.reason_code === 'idempotency_key_intent_conflict');
  const pgLegacy = buildMockPg();
  const legacyRow = { ...row, idempotency_intent_fp: null, metadata: { ...row.metadata, idempotency_intent_fp: null } };
  pgLegacy.state.idempotency.set('legacy-k', [legacyRow]); pgLegacy.state.serviceRecords.push(legacyRow);
  const legacyCreate = await createSunsetScheduleBooking(pgLegacy, {
    clientSlug: 'sunset', locationId: 'sunset-somo', actor: { source: 'agent_luna_whatsapp_bot' },
    body: { ...lessonBody('Replay'), idempotency_key: 'legacy-k' },
  });
  assert('create fails closed missing fp',
    legacyCreate.ok === false && legacyCreate.status === 409
      && legacyCreate.body.reason_code === 'idempotency_key_intent_unverifiable'
      && pgLegacy.state.serviceRecords.length === 1, JSON.stringify(legacyCreate.body));

  const rentFp = (spec) => {
    const prep = prepareCanonicalRentalsForCreate({ guest_name: 'Renter', ...spec });
    const v = validateScheduleBookingBody(prep.body);
    return v.ok ? buildScheduleBookingIntentFingerprint(v.value, 'sunset-somo', { rentals: prep.rentals }) : null;
  };
  const day1 = { date_from: '2026-08-02', date_to: '2026-08-02' };
  const fpBoard = rentFp({ ...day1, rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }] });
  assert('rental body validates', !!fpBoard);
  assert('rental fp ignores client money', fpBoard === buildScheduleBookingIntentFingerprint(
    validateScheduleBookingBody(prepareCanonicalRentalsForCreate({ guest_name: 'Renter', ...day1, rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }] }).body).value,
    'sunset-somo', { rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1, total_cents: 99999 }] }));
  assert('rental qty fp differs', rentFp({ ...day1, rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 2 }] }) !== fpBoard);
  assert('rental duration/dates fp differs', rentFp({ date_from: '2026-08-02', date_to: '2026-08-03', rentals: [{ offering_key: 'board_rental', duration_key: '2_days', quantity: 1 }] }) !== fpBoard);
  assert('rental offering fp differs', rentFp({ ...day1, rentals: [{ offering_key: 'wetsuit_rental', duration_key: '1_day', quantity: 1 }] }) !== fpBoard);
  assert('bundle vs split rental fp differs',
    rentFp({ ...day1, rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }] })
      !== rentFp({ ...day1, rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }, { offering_key: 'wetsuit_rental', duration_key: '1_day', quantity: 1 }] }));
  const plSess = (start, end) => validateScheduleBookingBody({
    guest_name: 'Coach',
    components: { private_lesson: { enabled: true, quantity: 1, surfer_count: 1, sessions: [{ date: '2026-08-02', start, end }] } },
  });
  const plA = plSess('10:00', '12:00'); const plB = plSess('14:00', '16:00');
  assert('private session time material to fp', plA.ok && plB.ok
    && buildScheduleBookingIntentFingerprint(plA.value, 'sunset-somo') !== buildScheduleBookingIntentFingerprint(plB.value, 'sunset-somo'));

  const pg = buildMockPg(); pg.state.idempotency.set('k1', [row]); pg.state.serviceRecords.push(row);
  const replay = await createSunsetScheduleBooking(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', actor: { source: 'agent_luna_whatsapp_bot' }, body: { ...lessonBody('Replay'), idempotency_key: 'k1' } });
  assert('create replay', replay.ok && replay.body.idempotent && pg.state.serviceRecords.length === 1);
  const bad = await createSunsetScheduleBooking(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', actor: { source: 'agent_luna_whatsapp_bot' }, body: { ...lessonBody('Other'), idempotency_key: 'k1' } });
  assert('create conflict', bad.ok === false && bad.body.reason_code === 'idempotency_key_intent_conflict' && pg.state.serviceRecords.length === 1);
  const cross = await createSunsetScheduleBooking(buildMockPg(), { clientSlug: 'wolfhouse', locationId: 'sunset-somo', actor: { email: 'x@t' }, body: { ...lessonBody('Replay'), idempotency_key: 'k1' } });
  assert('cross-tenant', cross.ok === false && cross.body.error === 'unsupported_client');
  const adv = scheduleBookingIdempotencyAdvisoryKeys('sunset', 'k1');
  assert('advisory keys', adv.length === 2 && scheduleBookingIdempotencyAdvisoryKeys('sunset', 'k1')[0] === adv[0]);
  const crow = { ...row, booking_id: 'bk-c', booking_code: 'SUNSET-C', guest_name: 'Concurrent', idempotency_intent_fp: fpC, metadata: { ...row.metadata, idempotency_key: 'ck', idempotency_intent_fp: fpC } };
  const pgC = buildMockPg(); pgC.state.idempotency.set('ck', [crow]); pgC.state.serviceRecords.push(crow);
  const bodyC = { ...lessonBody('Concurrent'), idempotency_key: 'ck' };
  const [a, b] = await Promise.all([
    createSunsetScheduleBooking(pgC, { clientSlug: 'sunset', locationId: 'sunset-somo', actor: { email: 's@t' }, body: bodyC }),
    createSunsetScheduleBooking(pgC, { clientSlug: 'sunset', locationId: 'sunset-somo', actor: { email: 's@t' }, body: bodyC }),
  ]);
  assert('concurrent idempotent one row', a.ok && b.ok && a.body.idempotent && b.body.idempotent && pgC.state.serviceRecords.length === 1 && a.body.booking_id === b.body.booking_id);

  console.log(`\n── verify:sunset-schedule-booking-attribution ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  if (fail > 0) process.exit(1);
})();
