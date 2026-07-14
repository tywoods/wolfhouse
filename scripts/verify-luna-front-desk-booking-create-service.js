'use strict';

/**
 * verify:luna-front-desk-booking-create-service
 *
 * RED → GREEN gate for the shared Sunset booking-create application service.
 * Proves manual_staff and luna_whatsapp channels normalize to the same command,
 * produce identical failures/successes, and preserve attribution + idempotency.
 *
 * Run:
 *   node scripts/verify-luna-front-desk-booking-create-service.js
 */

const {
  BOOKING_CREATE_CHANNELS,
  buildSunsetBookingCreateCommand,
  executeSunsetBookingCreate,
  resolveActorForChannel,
} = require('./lib/luna-front-desk-booking-create-service');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');
const { normalizeComponents } = require('./lib/sunset-schedule-booking-writes');

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

const PACK_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TIER = '1_week';
const ITEM = packPriceItemCode(PACK_ID, TIER);
const AMOUNT = 19900;
const FRIDAY = '2026-07-17';
const SATURDAY = '2026-07-18';
const LOC = 'sunset-somo';
const FIXED_NOW = new Date('2026-07-14T12:00:00Z');

function baseTransport(overrides = {}) {
  return {
    guest_name: 'Service Guest',
    guest_phone: '+34600111222',
    payment_status: 'unpaid',
    service_dates: [SATURDAY],
    components: {
      course: {
        quantity: 1,
        course_id: PACK_ID,
        course_label: 'Weekend Course',
        tier_key: TIER,
      },
    },
    ...overrides,
  };
}

function packRow(overrides = {}) {
  return {
    id: PACK_ID,
    label: 'Weekend Course',
    config_json: {
      age_band: '12_and_up',
      group_size: 2,
      beaches: ['somo'],
      weekly: 'sat_sun',
      schedules: ['0930_1130'],
      price_tiers: [{ key: TIER, label: '1 week', hours: 10, amount_cents: AMOUNT }],
      ...(overrides.config_json || {}),
    },
    ...overrides,
  };
}

function makePg(opts = {}) {
  const packs = opts.packs || [packRow()];
  const existingCourseSeats = opts.existingCourseSeats || {};
  const priceRows = opts.priceRows;
  const inserts = [];
  let rolledBack = false;
  let committed = false;
  const idempotencyHits = opts.idempotencyHits || [];

  return {
    inserts,
    rolledBack: () => rolledBack,
    committed: () => committed,
    query: async (sql, params) => {
      const s = String(sql);
      if (/^BEGIN/i.test(s)) return { rows: [] };
      if (/^COMMIT/i.test(s)) { committed = true; return { rows: [] }; }
      if (/^ROLLBACK/i.test(s)) { rolledBack = true; return { rows: [] }; }
      if (/SELECT id FROM clients WHERE slug/i.test(s)) return { rows: [{ id: 'client-sunset' }] };
      if (/information_schema\.(tables|columns)/i.test(s)) return { rows: [{ '?column?': 1 }] };
      if (/to_regclass/i.test(s)) return { rows: [{ reg: 'tenant_price_rules' }] };
      if (/FROM tenant_surf_pack_rules/i.test(s)) {
        return {
          rows: packs.map((p) => ({ id: p.id, label: p.label, config_json: p.config_json })),
        };
      }
      if (/COALESCE\(SUM/i.test(s) && /booking_service_records/i.test(s)) {
        const date = String(params[1]).slice(0, 10);
        const courseId = params[2];
        const key = `${courseId}|${date}`;
        const seats = existingCourseSeats[key] != null ? existingCourseSeats[key] : 0;
        return { rows: [{ seats }] };
      }
      if (/FROM tenant_price_rules/i.test(s)) {
        if (priceRows === null) return { rows: [] };
        const itemCode = params[2];
        const unit = params[3];
        if (String(itemCode || '').startsWith('surf_pack_') && unit === 'day') {
          return {
            rows: [{
              id: 'price-1',
              amount_cents: AMOUNT,
              currency: 'EUR',
              item_type: 'package',
              item_code: itemCode,
              unit: 'day',
              location_id: params[4] || LOC,
            }],
          };
        }
        return { rows: [] };
      }
      if (/metadata->>'idempotency_key'/i.test(s)) {
        return { rows: idempotencyHits };
      }
      if (/INSERT INTO bookings/i.test(s)) {
        inserts.push({ table: 'bookings', params: [...params] });
        return { rows: [{ id: 'booking-uuid-1', booking_code: 'SUNSET-20260714-SVC01' }] };
      }
      if (/INSERT INTO booking_service_records/i.test(s)) {
        inserts.push({ table: 'booking_service_records', params: [...params] });
        const meta = typeof params[9] === 'string' ? JSON.parse(params[9]) : params[9];
        return {
          rows: [{
            service_record_id: 'sr-1',
            booking_id: 'booking-uuid-1',
            booking_code: params[2],
            guest_name: params[3],
            service_type: params[4],
            service_date: params[5],
            quantity: params[6],
            amount_due_cents: AMOUNT,
            payment_status: params[7],
            record_source: params[8],
            metadata_source: meta.source,
            metadata_component: meta.component,
            metadata_offering_id: meta.offering_id,
            metadata_tier_key: meta.tier_key,
            metadata_course_id: meta.course_id,
          }],
        };
      }
      if (/SELECT metadata FROM bookings/i.test(s)) {
        return { rows: [{ metadata: { location_id: LOC, source: 'staff_manual_schedule' } }] };
      }
      if (/SELECT id, service_type/i.test(s) && /FROM booking_service_records/i.test(s)) {
        return {
          rows: inserts.filter((i) => i.table === 'booking_service_records').map((row, idx) => ({
            id: `sr-${idx + 1}`,
            service_type: row.params[4],
            service_date: row.params[5],
            quantity: row.params[6],
            amount_due_cents: AMOUNT,
            metadata: typeof row.params[9] === 'string' ? JSON.parse(row.params[9]) : row.params[9],
          })),
        };
      }
      if (/UPDATE booking_service_records/i.test(s) || /UPDATE bookings SET/i.test(s)) {
        return { rows: [] };
      }
      if (/syncPackTierToPriceRules|tenant_price_rules/i.test(s)) return { rows: [] };
      return { rows: [] };
    },
  };
}

function buildForChannel(channel, transportBody, extra = {}) {
  return buildSunsetBookingCreateCommand({
    channel,
    transportBody,
    trustedLocationId: extra.trustedLocationId || LOC,
    actorHints: extra.actorHints || (channel === BOOKING_CREATE_CHANNELS.MANUAL_STAFF
      ? { email: 'staff@test.com', staff_user_id: 'staff-1' }
      : {}),
    now: FIXED_NOW,
  });
}

async function run() {
  console.log('\nverify:luna-front-desk-booking-create-service\n');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  console.log('[A] Command normalization — manual vs Luna');
  const transport = baseTransport();
  const manualBuilt = buildForChannel(BOOKING_CREATE_CHANNELS.MANUAL_STAFF, transport);
  const lunaBuilt = buildForChannel(BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP, {
    ...transport,
    client_slug: 'wolfhouse-somo',
    location_id: 'sunset-sardinero',
  });
  assert('manual command builds', manualBuilt.ok === true);
  assert('luna command builds', lunaBuilt.ok === true);
  assert('both force sunset tenant', manualBuilt.command.clientSlug === 'sunset'
    && lunaBuilt.command.clientSlug === 'sunset');
  assert('trusted location wins over body', lunaBuilt.command.locationId === LOC);
  assert('manual actor email', manualBuilt.command.actor.email === 'staff@test.com');
  assert('luna actor source', lunaBuilt.command.actor.source === 'agent_luna_whatsapp_bot');
  assert('resolveActorForChannel manual', resolveActorForChannel(BOOKING_CREATE_CHANNELS.MANUAL_STAFF, { email: 'a@b.c' }).email === 'a@b.c');

  console.log('\n[B] Client money fields rejected before write');
  const moneyReject = normalizeComponents({
    course: { course_id: PACK_ID, tier_key: TIER, quantity: 1, unit_amount_cents: 50 },
  });
  assert('normalize rejects unit_amount_cents', moneyReject.ok === false);

  console.log('\n[C] Weekday rejection identical across channels');
  const weekdayTransport = baseTransport({ service_dates: [FRIDAY] });
  for (const channel of [BOOKING_CREATE_CHANNELS.MANUAL_STAFF, BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP]) {
    const built = buildForChannel(channel, weekdayTransport);
    const pg = makePg();
    const out = await executeSunsetBookingCreate(pg, built.command);
    assert(`${channel} weekday fails`, out.ok === false && /weekend/i.test(String(out.body.error || '')));
    assert(`${channel} weekday zero booking inserts`, pg.inserts.filter((i) => i.table === 'bookings').length === 0);
  }

  console.log('\n[D] Same offering/date/price → same total + shape');
  const results = [];
  for (const channel of [BOOKING_CREATE_CHANNELS.MANUAL_STAFF, BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP]) {
    const built = buildForChannel(channel, baseTransport());
    const pg = makePg();
    const out = await executeSunsetBookingCreate(pg, built.command);
    results.push({ channel, out, pg });
    assert(`${channel} success`, out.ok === true, JSON.stringify(out.body));
    assert(`${channel} total_cents`, out.body.total_cents === AMOUNT);
    assert(`${channel} offering_id`, out.body.records && out.body.records[0] && out.body.records[0].metadata_offering_id === ITEM
      || (pg.inserts[1] && JSON.parse(pg.inserts[1].params[9]).offering_id === ITEM));
  }
  assert('totals match across channels', results[0].out.body.total_cents === results[1].out.body.total_cents);

  console.log('\n[E] Attribution differs by channel only');
  assert('manual staff attribution', results[0].out.body.attribution.staff_manual_schedule === true
    && results[0].out.body.attribution.luna_guest_booking === false);
  assert('luna attribution', results[1].out.body.attribution.luna_guest_booking === true
    && results[1].out.body.attribution.staff_manual_schedule === false);
  const manualMeta = JSON.parse(results[0].pg.inserts.find((i) => i.table === 'booking_service_records').params[9]);
  const lunaMeta = JSON.parse(results[1].pg.inserts.find((i) => i.table === 'booking_service_records').params[9]);
  assert('manual metadata source', manualMeta.source === 'staff_manual_schedule');
  assert('luna metadata source', lunaMeta.source === 'luna_guest_whatsapp');

  console.log('\n[F] Missing price fails closed with rollback');
  const builtPrice = buildForChannel(BOOKING_CREATE_CHANNELS.MANUAL_STAFF, baseTransport());
  const pgNoPrice = makePg({ priceRows: null });
  const outNoPrice = await executeSunsetBookingCreate(pgNoPrice, builtPrice.command);
  assert('missing price fails', outNoPrice.ok === false);
  assert('missing price no partial writes', pgNoPrice.inserts.filter((i) => i.table === 'bookings').length === 0
    && !pgNoPrice.committed());

  console.log('\n[G] Capacity full fails identically');
  const pgFull = makePg({ existingCourseSeats: { [`${PACK_ID}|${SATURDAY}`]: 2 } });
  const outFullManual = await executeSunsetBookingCreate(pgFull, buildForChannel(BOOKING_CREATE_CHANNELS.MANUAL_STAFF, baseTransport()).command);
  const outFullLuna = await executeSunsetBookingCreate(makePg({ existingCourseSeats: { [`${PACK_ID}|${SATURDAY}`]: 2 } }),
    buildForChannel(BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP, baseTransport()).command);
  assert('manual course_full', outFullManual.ok === false && outFullManual.body.error === 'course_full');
  assert('luna course_full', outFullLuna.ok === false && outFullLuna.body.error === 'course_full');

  console.log('\n[H] Idempotency replay');
  const pgIdem = makePg({
    idempotencyHits: [{
      service_record_id: 'sr-existing',
      booking_id: 'existing-booking',
      booking_code: 'SUNSET-IDEM-01',
      guest_name: 'Service Guest',
      service_type: 'surf_lesson',
      service_date: SATURDAY,
      quantity: 1,
      payment_status: 'unpaid',
      record_source: 'staff_manual',
      slot_time: null,
      notes: null,
      staff_ui_service_type: 'course',
      metadata_source: 'staff_manual_schedule',
      metadata_component: 'course',
      metadata_offering_id: ITEM,
      metadata_tier_key: TIER,
      metadata_course_id: PACK_ID,
    }],
  });
  const builtIdem = buildForChannel(BOOKING_CREATE_CHANNELS.MANUAL_STAFF, baseTransport({ idempotency_key: 'idem-key-1' }));
  const outIdem = await executeSunsetBookingCreate(pgIdem, builtIdem.command);
  assert('idempotent ok', outIdem.ok === true && outIdem.body.idempotent === true);
  assert('idempotent no new inserts', pgIdem.inserts.length === 0);

  console.log(`\n── verify:luna-front-desk-booking-create-service ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(2);
});
