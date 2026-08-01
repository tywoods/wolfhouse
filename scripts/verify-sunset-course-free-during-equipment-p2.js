'use strict';

/**
 * verify:sunset-course-free-during-equipment-p2
 *
 * P2: free during-class gear from course equipment_options (€0) must land on
 * the booking as course_equipment service rows so the staff drawer equipment
 * pill is ON. Config-driven — no hardcoded board/wetsuit list.
 *
 * Layer A — unit + helper insert contracts
 * Layer B — real executeSunsetBookingCreate (fake PG):
 *   1) free during + omitted course_equipment → committed SUNSET-… + CE rows + pill ON
 *   2) no free during → committed booking, no CE rows, pill OFF
 *   3) explicit course_equipment preserved (not replaced by default)
 *   4) full-day extension remains separate paid structured row
 *
 * Run: node scripts/verify-sunset-course-free-during-equipment-p2.js
 */

const fs = require('fs');
const path = require('path');
const {
  BOOKING_CREATE_CHANNELS,
  buildSunsetBookingCreateCommand,
  executeSunsetBookingCreate,
} = require('./lib/luna-front-desk-booking-create-service');
const {
  defaultFreeDuringCourseEquipmentSelection,
  isPresentCourseEquipmentSelection,
  normalizeEquipmentOptions,
} = require('./lib/sunset-course-equipment-options');
const {
  insertCourseEquipmentRows,
  FULL_DAY_EQUIPMENT_ADDON_KEY,
} = require('./lib/sunset-schedule-booking-writes');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${label}${detail != null ? ` — ${String(detail).slice(0, 320)}` : ''}`);
  }
}

const LOC = 'sunset-somo';
// Saturday — matches pack weekly sat_sun
const SERVICE_DATE = '2026-08-01';
const FIXED_NOW = new Date('2026-07-28T12:00:00Z');
const PACK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TIER = '1_day';
const PACK_ITEM = packPriceItemCode(PACK_ID, TIER);
const COURSE_AMOUNT = 3500; // €35 Curso Medio Dia

const FREE_EQ = {
  offering_key: 'board_and_suit_rental',
  during_course_price_cents: 0,
  all_day_price_cents: 1000,
  label: 'Board and wetsuit',
};

const PAID_EQ = {
  offering_key: 'board_and_suit_rental',
  during_course_price_cents: 1500,
  all_day_price_cents: 2500,
  label: 'Board and wetsuit',
};

const OFFERINGS = [
  {
    offering_key: 'board_and_suit_rental',
    label: 'Board and wetsuit',
    active: true,
    client_slug: 'sunset',
    location_id: LOC,
    stock_quantity: 20,
  },
];

function packRow(equipmentOptions) {
  return {
    id: PACK_ID,
    label: 'Curso Medio Dia',
    config_json: {
      age_band: '12_and_up',
      group_size: 8,
      beaches: ['somo'],
      weekly: 'sat_sun',
      schedules: ['1000_1300'],
      equipment_options: equipmentOptions,
      price_tiers: [{ key: TIER, label: '1 day', hours: 3, amount_cents: COURSE_AMOUNT }],
    },
  };
}

function drawerCourseEquipmentFromServices(services) {
  const out = [];
  for (const sr of services || []) {
    const meta = sr.metadata || {};
    if (meta.course_equipment !== true) continue;
    const offeringKey = String(meta.offering_key || '').trim();
    const mode = meta.course_equipment_mode === 'all_day' ? 'all_day' : 'during_course';
    const quantity = Number(sr.quantity) || 1;
    if (!offeringKey) continue;
    if (!out.some((x) => x && x.offering_key === offeringKey)) {
      out.push({
        offering_key: offeringKey,
        mode,
        quantity,
        label: meta.label != null ? String(meta.label) : undefined,
        unit_amount_cents: meta.unit_amount_cents != null ? Number(meta.unit_amount_cents) : undefined,
        during_course_price_cents: meta.during_course_price_cents != null
          ? Number(meta.during_course_price_cents) : undefined,
      });
    }
  }
  return out;
}

/**
 * Fake PG for real executeSunsetBookingCreate.
 * Packs + prices + rental offerings + booking/service writes.
 */
function makeCreatePg(opts = {}) {
  const packs = opts.packs || [packRow([FREE_EQ])];
  const equipmentOptions = opts.equipmentOptions;
  // allow override of pack equipment via opts
  if (equipmentOptions) {
    packs[0] = packRow(equipmentOptions);
  }
  const state = {
    bookings: [],
    services: [],
    committed: false,
    rolledBack: false,
    bookingSeq: 0,
    serviceSeq: 0,
  };

  const pg = {
    state,
    committed: () => state.committed,
    rolledBack: () => state.rolledBack,
    async query(sql, params = []) {
      const q = String(sql);

      if (/^\s*BEGIN/i.test(q)) return { rows: [] };
      if (/^\s*COMMIT/i.test(q)) {
        state.committed = true;
        return { rows: [] };
      }
      if (/^\s*ROLLBACK/i.test(q)) {
        state.rolledBack = true;
        return { rows: [] };
      }
      if (/pg_advisory_xact_lock/i.test(q)) return { rows: [] };
      // Admin DB table presence (must return ALL ADMIN_CONFIG_TABLES for source=db)
      if (/FROM information_schema\.tables/i.test(q) && /table_name = ANY/i.test(q)) {
        const names = Array.isArray(params[0]) ? params[0] : [
          'tenant_price_rules',
          'tenant_lesson_capacity_rules',
          'tenant_lesson_time_rules',
          'tenant_config_audit_log',
        ];
        return { rows: names.map((table_name) => ({ table_name })) };
      }
      if (/FROM information_schema\.columns/i.test(q)) {
        // has location_id / effective_* columns
        return { rows: [{ '?column?': 1 }] };
      }
      if (/to_regclass/i.test(q)) {
        return { rows: [{ reg: 'tenant_price_rules', t: 'booking_service_records' }] };
      }
      if (/pg_constraint|ALTER TABLE/i.test(q)) {
        return {
          rows: [{
            definition: "CHECK ((service_type)::text = ANY ((ARRAY['addon_service'::character varying,'surf_lesson'::character varying])::text[]))",
          }],
        };
      }
      if (/SELECT id FROM clients WHERE slug/i.test(q)) {
        return { rows: [{ id: 'client-sunset-uuid' }] };
      }
      if (/FROM tenant_surf_pack_rules/i.test(q)) {
        return {
          rows: packs.map((p) => ({
            id: p.id,
            label: p.label,
            config_json: p.config_json,
            active: true,
            location_id: LOC,
          })),
        };
      }
      if (/COALESCE\(SUM/i.test(q) && /booking_service_records/i.test(q)) {
        return { rows: [{ seats: 0 }] };
      }
      // Rental offerings list (for insertCourseEquipmentRows activeScoped filter)
      if (/FROM tenant_rental_offerings/i.test(q) || /rental_offerings/i.test(q)) {
        return {
          rows: OFFERINGS.map((o) => ({
            id: o.offering_key,
            offering_key: o.offering_key,
            label: o.label,
            display_name: o.label,
            active: true,
            client_slug: 'sunset',
            location_id: LOC,
            stock_quantity: o.stock_quantity || 20,
            config_json: {},
          })),
        };
      }
      // Stock lock / load
      if (/FROM tenant_rental_stock|tenant_rental_offerings.*FOR UPDATE/i.test(q)
        || (/FOR UPDATE/i.test(q) && /rental/i.test(q))) {
        const keys = [];
        for (const p of params) {
          if (Array.isArray(p)) keys.push(...p.map(String));
          else if (typeof p === 'string' && p.includes('rental')) keys.push(p);
        }
        if (!keys.length) {
          return {
            rows: OFFERINGS.map((o) => ({
              offering_key: o.offering_key,
              stock_quantity: 20,
              remaining: 20,
              active: true,
            })),
          };
        }
        return {
          rows: keys.map((k) => ({
            offering_key: k,
            stock_quantity: 20,
            remaining: 20,
            active: true,
          })),
        };
      }
      // Price rules — course pack + optional full-day addon
      if (/FROM tenant_price_rules/i.test(q)) {
        const rows = [];
        // Full list path
        if (!/LIMIT\s+1/i.test(q) || /ORDER BY/i.test(q)) {
          rows.push({
            id: 'pr-course',
            amount_cents: COURSE_AMOUNT,
            currency: 'EUR',
            item_type: 'package',
            item_code: PACK_ITEM,
            unit: 'day',
            location_id: LOC,
            active: true,
          });
          // full day equipment addon common codes
          rows.push({
            id: 'pr-fda',
            amount_cents: 1000,
            currency: 'EUR',
            item_type: 'addon',
            item_code: 'full_day_equipment_extension',
            unit: 'person_per_day',
            location_id: LOC,
            active: true,
          });
          rows.push({
            id: 'pr-fda2',
            amount_cents: 1000,
            currency: 'EUR',
            item_type: 'addon',
            item_code: 'full_day_equipment_addon',
            unit: 'day',
            location_id: LOC,
            active: true,
          });
          return { rows };
        }
        // Exact LIMIT 1
        const itemCode = params.find((p) => typeof p === 'string' && (
          String(p).startsWith('surf_pack_')
          || String(p).includes('full_day')
          || String(p).includes('equipment')
        )) || params[2];
        const unit = params[3];
        if (String(itemCode || '').startsWith('surf_pack_') || String(itemCode) === PACK_ITEM) {
          return {
            rows: [{
              id: 'pr-course',
              amount_cents: COURSE_AMOUNT,
              currency: 'EUR',
              item_type: 'package',
              item_code: itemCode || PACK_ITEM,
              unit: unit || 'day',
              location_id: LOC,
              active: true,
            }],
          };
        }
        if (/full_day|equipment/i.test(String(itemCode || ''))) {
          return {
            rows: [{
              id: 'pr-fda',
              amount_cents: 1000,
              currency: 'EUR',
              item_type: 'addon',
              item_code: itemCode,
              unit: unit || 'person_per_day',
              location_id: LOC,
              active: true,
            }],
          };
        }
        return { rows: [] };
      }
      if (/metadata->>'idempotency_key'/i.test(q)) return { rows: [] };

      if (/INSERT INTO bookings/i.test(q)) {
        state.bookingSeq += 1;
        const code = `SUNSET-20260801-P2${String(state.bookingSeq).padStart(2, '0')}`;
        const id = `bbbbbbbb-cccc-4ddd-8eee-fffffffffff${state.bookingSeq}`;
        const meta = typeof params[8] === 'string' ? JSON.parse(params[8]) : (params[8] || {});
        state.bookings.push({
          id, booking_code: code, metadata: meta, guest_name: params[2],
        });
        return { rows: [{ id, booking_code: code }] };
      }

      if (/INSERT INTO booking_service_records/i.test(q)) {
        state.serviceSeq += 1;
        const id = `sr-${state.serviceSeq}`;
        let meta = {};
        for (const p of params) {
          if (typeof p === 'string' && p.trim().startsWith('{')) {
            try { meta = JSON.parse(p); } catch (_) { /* */ }
          }
        }
        // Two insert shapes:
        // A) insertServiceRecord: [slug, bid, code, name, service_type, date, qty, pay, source, meta]
        // B) full-day addon:     [slug, bid, code, name, date, qty, amount, pay, source, meta]
        //    (service_type hard-coded 'addon_service' in SQL)
        const hardAddon = /'addon_service'/i.test(q) && !/\$5/.test(q.split('VALUES')[0] || '');
        // Detect B by: SQL embeds 'addon_service' literal AND params[4] looks like a date
        const p4 = params[4];
        const p4IsDate = typeof p4 === 'string' && /^\d{4}-\d{2}-\d{2}/.test(p4);
        let serviceType;
        let serviceDate;
        let quantity;
        let amountDue;
        if (p4IsDate || (/'addon_service'/i.test(q) && params.length >= 10 && typeof params[6] === 'number')) {
          serviceType = 'addon_service';
          serviceDate = p4IsDate ? p4 : (params[4] || SERVICE_DATE);
          quantity = params[5] || 1;
          amountDue = Number.isInteger(params[6]) ? params[6] : 0;
        } else {
          serviceType = params[4] || 'addon_service';
          serviceDate = params[5] || SERVICE_DATE;
          quantity = params[6] || 1;
          amountDue = Number.isInteger(params[7]) ? params[7] : 0;
        }
        // Prefer amount from metadata when insert seeds 0 then UPDATEs
        if (meta && Number.isInteger(meta.amount_cents) && amountDue === 0
          && meta.course_equipment === true) {
          // amount updated later
        }
        const row = {
          id,
          service_record_id: id,
          booking_id: params[1],
          booking_code: params[2],
          guest_name: params[3],
          service_type: serviceType,
          service_date: serviceDate,
          quantity,
          amount_due_cents: amountDue,
          metadata: meta,
        };
        state.services.push(row);
        return {
          rows: [{ ...row }],
          rowCount: 1,
        };
      }

      if (/UPDATE booking_service_records SET amount_due_cents/i.test(q)) {
        const due = params[0];
        const id = params[1];
        const hit = state.services.find((s) => String(s.id) === String(id)
          || String(s.service_record_id) === String(id));
        if (hit) hit.amount_due_cents = due;
        return { rows: [], rowCount: hit ? 1 : 0 };
      }
      if (/UPDATE\s+bookings\b/i.test(q)) {
        // total_amount_cents / balance snapshot — must report 1 row updated
        return { rows: [{ id: state.bookings[0] && state.bookings[0].id }], rowCount: 1 };
      }
      if (/UPDATE booking_service_records/i.test(q)) {
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT metadata FROM bookings/i.test(q)) {
        const b = state.bookings[state.bookings.length - 1];
        return { rows: [{ metadata: (b && b.metadata) || { location_id: LOC } }] };
      }
      if (/SELECT id, service_type/i.test(q) && /FROM booking_service_records/i.test(q)) {
        return {
          rows: state.services.map((s) => ({
            id: s.id,
            service_type: s.service_type,
            service_date: s.service_date,
            quantity: s.quantity,
            amount_due_cents: s.amount_due_cents,
            metadata: s.metadata,
          })),
        };
      }
      return { rows: [] };
    },
  };
  return pg;
}

function buildCourseCommand(transportOverrides = {}) {
  return buildSunsetBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    trustedLocationId: LOC,
    now: FIXED_NOW,
    transportBody: {
      guest_name: 'P2 Course Guest',
      guest_phone: '+346****6000',
      guest_confirmed_booking: true,
      payment_status: 'unpaid',
      service_date: SERVICE_DATE,
      service_dates: [SERVICE_DATE],
      date_from: SERVICE_DATE,
      date_to: SERVICE_DATE,
      components: {
        course: {
          course_id: PACK_ID,
          course_label: 'Curso Medio Dia',
          tier_key: TIER,
          quantity: 1,
        },
      },
      ...transportOverrides,
    },
  });
}

async function main() {
  console.log('\nverify:sunset-course-free-during-equipment-p2\n');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  // ── A) Helper unit ───────────────────────────────────────────────────────
  console.log('[A] defaultFreeDuringCourseEquipmentSelection');
  const free1 = defaultFreeDuringCourseEquipmentSelection({
    packs: [{ equipment_options: [FREE_EQ] }],
    surfers: 2,
  });
  ok('free during → one selection', Array.isArray(free1) && free1.length === 1, free1);
  ok('free mode during_course', free1 && free1[0].mode === 'during_course');
  ok('free offering_key from config', free1 && free1[0].offering_key === 'board_and_suit_rental');
  ok('free quantity = surfers', free1 && free1[0].quantity === 2);
  ok('paid-only during → null',
    defaultFreeDuringCourseEquipmentSelection({
      packs: [{ equipment_options: [PAID_EQ] }],
      surfers: 1,
    }) == null);
  ok('empty options → null',
    defaultFreeDuringCourseEquipmentSelection({
      packs: [{ equipment_options: [] }],
      surfers: 1,
    }) == null);
  ok('isPresent empty false', isPresentCourseEquipmentSelection([]) === false);
  ok('isPresent free true', isPresentCourseEquipmentSelection(free1) === true);
  ok('normalize free options',
    normalizeEquipmentOptions([FREE_EQ])[0].during_course_price_cents === 0);

  // Multi-pack intersection
  const packB = {
    equipment_options: [
      FREE_EQ,
      { offering_key: 'towel_rental', during_course_price_cents: 0, all_day_price_cents: 300 },
    ],
  };
  const inter = defaultFreeDuringCourseEquipmentSelection({
    packs: [{ equipment_options: [FREE_EQ] }, packB],
    surfers: 1,
  });
  ok('multi-pack intersection shared free only',
    Array.isArray(inter) && inter.length === 1 && inter[0].offering_key === 'board_and_suit_rental',
    inter);

  // Direct insert still works (supplemental)
  {
    const pg = makeCreatePg();
    const rows = await insertCourseEquipmentRows(pg, {
      clientSlug: 'sunset',
      bookingId: 'bbbbbbbb-cccc-4ddd-8eee-fffffffffff1',
      bookingCode: 'SUNSET-HELPER',
      guestName: 'Helper',
      selection: free1,
      surfers: 2,
      bookingDates: [SERVICE_DATE],
      course: {
        pack_id: PACK_ID,
        course_id: PACK_ID,
        equipment_options: [FREE_EQ],
        label: 'Curso Medio Dia',
      },
      offerings: OFFERINGS,
      attribution: {
        metadataSource: 'agent_luna_whatsapp_bot',
        staffManualSchedule: false,
        dbSource: 'agent_luna_whatsapp_bot',
      },
      locationId: LOC,
      bundleId: 'b-helper',
      srPayment: 'pending',
    });
    ok('helper insertCourseEquipmentRows writes', Array.isArray(rows) && rows.length >= 1);
  }

  // ── B) Real executeSunsetBookingCreate ───────────────────────────────────
  console.log('\n[B] executeSunsetBookingCreate — free / none / explicit / full-day');

  // B1: free during, omit course_equipment
  {
    const built = buildCourseCommand(); // no course_equipment
    ok('B1 command builds', built.ok === true, built.body || built.error);
    const pg = makeCreatePg({ equipmentOptions: [FREE_EQ] });
    const out = await executeSunsetBookingCreate(pg, built.command);
    ok('B1 create ok', out.ok === true, JSON.stringify(out.body || out).slice(0, 280));
    ok('B1 committed', pg.committed() === true && pg.rolledBack() !== true);
    const code = out.body && (out.body.booking_code || (out.body.booking && out.body.booking.booking_code));
    ok('B1 SUNSET-… code', typeof code === 'string' && /^SUNSET-/.test(code), code);
    ok('B1 booking insert', pg.state.bookings.length >= 1);
    const ce = pg.state.services.filter((s) => s.metadata && s.metadata.course_equipment === true);
    ok('B1 course_equipment service row', ce.length >= 1, `ce=${ce.length} total=${pg.state.services.length}`);
    ok('B1 mode during_course', ce.every((s) => s.metadata.course_equipment_mode === 'during_course'));
    ok('B1 due 0', ce.every((s) => Number(s.amount_due_cents) === 0));
    ok('B1 during price 0', ce.every((s) => s.metadata.during_course_price_cents === 0));
    ok('B1 offering from config', ce.every((s) => s.metadata.offering_key === 'board_and_suit_rental'));
    const drawer = drawerCourseEquipmentFromServices(pg.state.services);
    ok('B1 drawer pill ON', drawer.length >= 1 && drawer[0].mode === 'during_course', drawer);
  }

  // B2: no free during
  {
    const built = buildCourseCommand();
    const pg = makeCreatePg({ equipmentOptions: [PAID_EQ] });
    const out = await executeSunsetBookingCreate(pg, built.command);
    ok('B2 create ok (course still books)', out.ok === true, JSON.stringify(out.body || out).slice(0, 280));
    ok('B2 committed', pg.committed() === true);
    const code = out.body && (out.body.booking_code || (out.body.booking && out.body.booking.booking_code));
    ok('B2 SUNSET-… code', typeof code === 'string' && /^SUNSET-/.test(code), code);
    const ce = pg.state.services.filter((s) => s.metadata && s.metadata.course_equipment === true);
    ok('B2 no course_equipment rows', ce.length === 0, ce.length);
    ok('B2 drawer pill OFF', drawerCourseEquipmentFromServices(pg.state.services).length === 0);
    ok('B2 still has course service row',
      pg.state.services.some((s) => s.service_type === 'surf_lesson'
        || (s.metadata && s.metadata.component === 'course')),
      pg.state.services.map((s) => s.service_type).join(','));
  }

  // B3: empty equipment_options
  {
    const built = buildCourseCommand();
    const pg = makeCreatePg({ equipmentOptions: [] });
    const out = await executeSunsetBookingCreate(pg, built.command);
    ok('B3 empty options create ok', out.ok === true, JSON.stringify(out.body || out).slice(0, 200));
    const ce = pg.state.services.filter((s) => s.metadata && s.metadata.course_equipment === true);
    ok('B3 empty → no CE rows', ce.length === 0);
  }

  // B4: explicit course_equipment preserved (all_day, not free during default)
  {
    const explicit = [{
      offering_key: 'board_and_suit_rental',
      mode: 'all_day',
      quantity: 1,
    }];
    const built = buildCourseCommand({ course_equipment: explicit });
    ok('B4 command with explicit CE builds', built.ok === true, built.body || built.error);
    const pg = makeCreatePg({ equipmentOptions: [FREE_EQ] });
    const out = await executeSunsetBookingCreate(pg, built.command);
    ok('B4 create ok', out.ok === true, JSON.stringify(out.body || out).slice(0, 280));
    const ce = pg.state.services.filter((s) => s.metadata && s.metadata.course_equipment === true);
    ok('B4 CE rows written', ce.length >= 1, ce.length);
    ok('B4 explicit all_day preserved (not forced during)',
      ce.every((s) => s.metadata.course_equipment_mode === 'all_day'),
      ce.map((s) => s.metadata.course_equipment_mode).join(','));
    ok('B4 all_day unit 1000 not free 0',
      ce.every((s) => Number(s.metadata.unit_amount_cents) === 1000
        || Number(s.metadata.all_day_price_cents) === 1000),
      JSON.stringify(ce[0] && ce[0].metadata));
  }

  // B5: full-day extension separate when free during also auto-attached
  {
    const built = buildCourseCommand({
      components: {
        course: {
          course_id: PACK_ID,
          course_label: 'Curso Medio Dia',
          tier_key: TIER,
          quantity: 1,
        },
        [FULL_DAY_EQUIPMENT_ADDON_KEY]: {
          enabled: true,
          dates: { [SERVICE_DATE]: 1 },
        },
      },
    });
    ok('B5 command with full-day builds', built.ok === true, built.body || built.error);
    const pg = makeCreatePg({ equipmentOptions: [FREE_EQ] });
    const out = await executeSunsetBookingCreate(pg, built.command);
    ok('B5 create ok', out.ok === true, JSON.stringify(out.body || out).slice(0, 320));
    if (out.ok) {
      const ce = pg.state.services.filter((s) => s.metadata && s.metadata.course_equipment === true);
      ok('B5 free CE still attached', ce.length >= 1 && ce.every((s) => s.metadata.course_equipment_mode === 'during_course'));
      const fda = pg.state.services.filter((s) => {
        const m = s.metadata || {};
        return m.component === FULL_DAY_EQUIPMENT_ADDON_KEY
          || m.service_key === FULL_DAY_EQUIPMENT_ADDON_KEY
          || m.staff_ui_service_type === FULL_DAY_EQUIPMENT_ADDON_KEY;
      });
      ok('B5 full-day extension separate row', fda.length >= 1, `fda=${fda.length}`);
      ok('B5 full-day is not course_equipment flag',
        fda.every((s) => s.metadata.course_equipment !== true));
      ok('B5 full-day billable (or unit snap)',
        fda.some((s) => Number(s.amount_due_cents) > 0
          || Number(s.metadata.unit_amount_cents) > 0
          || Number(s.metadata.amount_cents) > 0),
        JSON.stringify(fda[0] && fda[0].metadata));
    } else {
      ok('B5 free CE still attached', false, 'create failed');
      ok('B5 full-day extension separate row', false, 'create failed');
      ok('B5 full-day is not course_equipment flag', false, 'create failed');
      ok('B5 full-day billable (or unit snap)', false, 'create failed');
    }
  }

  // ── C) Source contracts ──────────────────────────────────────────────────
  console.log('\n[C] Source contracts');
  const writesSrc = fs.readFileSync(
    path.join(__dirname, 'lib/sunset-schedule-booking-writes.js'),
    'utf8',
  );
  ok('create calls defaultFree', writesSrc.includes('defaultFreeDuringCourseEquipmentSelection'));
  ok('create only when CE absent',
    /if\s*\(\s*!isPresentCourseEquipmentSelection\(\s*input\.course_equipment\s*\)\s*\)/.test(writesSrc));
  ok('create uses insertCourseEquipmentRows', writesSrc.includes('insertCourseEquipmentRows'));
  ok('full_day key separate',
    writesSrc.includes(FULL_DAY_EQUIPMENT_ADDON_KEY));
  ok('no hardcoded free board list',
    !/freeSel\s*=\s*\[\s*\{\s*offering_key:\s*'board/.test(writesSrc));
  const optSrc = fs.readFileSync(
    path.join(__dirname, 'lib/sunset-course-equipment-options.js'),
    'utf8',
  );
  ok('helper filters === 0', /during_course_price_cents\s*===\s*0/.test(optSrc));

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  console.log('PASS verify:sunset-course-free-during-equipment-p2\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
