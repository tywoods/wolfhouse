'use strict';

/**
 * verify:luna-front-desk-quote-service
 *
 * RED → GREEN gate for the shared Sunset quote application service.
 */

const {
  QUOTE_CHANNELS,
  buildSunsetQuoteCommand,
  executeSunsetQuote,
  executeSunsetQuoteSync,
  computeQuoteFingerprint,
  validateQuoteProvenanceForCreate,
  rejectClientSuppliedMoney,
} = require('./lib/luna-front-desk-quote-service');
const {
  BOOKING_CREATE_CHANNELS,
  buildSunsetBookingCreateCommand,
  executeSunsetBookingCreate,
} = require('./lib/luna-front-desk-booking-create-service');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');
const {
  applyAuthoritativeQuoteAmounts,
  FULL_DAY_EQUIPMENT_ADDON_KEY,
} = require('./lib/sunset-schedule-booking-writes');

let pass = 0;
let fail = 0;
function assert(label, condition, detail) {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; return; }
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

function adminCfg(priceRows, opts = {}) {
  return {
    ok: true,
    source: 'db',
    currency: 'EUR',
    surf_packs: [{
      pack_id: PACK_ID,
      label: 'Weekend Course',
      active: true,
      age_band: '12_and_up',
      group_size: 2,
      beaches: ['somo'],
      weekly: 'sat_sun',
      schedules: ['0930_1130'],
      price_tiers: [{ key: TIER, label: '1 week', hours: 10, amount_cents: AMOUNT }],
    }],
    prices: priceRows || [{
      id: 'price-1',
      category: 'package',
      offering_key: ITEM,
      item_code: ITEM,
      amount_cents: AMOUNT,
      unit: 'day',
      active: true,
      currency: 'EUR',
    }],
    private_lesson: opts.private_lesson || null,
  };
}

function makePg(opts = {}) {
  const packs = opts.packs || adminCfg().surf_packs.map((p) => ({
    id: p.pack_id,
    label: p.label,
    config_json: {
      age_band: p.age_band,
      group_size: p.group_size,
      beaches: p.beaches,
      weekly: p.weekly,
      schedules: p.schedules,
      price_tiers: p.price_tiers,
    },
  }));
  const priceAmount = opts.priceAmount != null ? opts.priceAmount : AMOUNT;
  const seats = opts.existingCourseSeats || {};
  const writes = [];
  const readOnly = opts.readOnly === true;
  const failServiceInsertAt = opts.failServiceInsertAt != null ? Number(opts.failServiceInsertAt) : null;
  const ghostServiceInsert = opts.ghostServiceInsert === true;
  const ghostBookingInsert = opts.ghostBookingInsert === true;
  const forceServiceClientSlug = opts.forceServiceClientSlug != null ? String(opts.forceServiceClientSlug) : null;
  const forceBookingClientId = opts.forceBookingClientId != null ? String(opts.forceBookingClientId) : null;

  function emptyState() {
    return {
      bookings: [],
      services: [],
      amounts: Object.create(null),
      bookingTotals: Object.create(null),
      bookingMeta: Object.create(null),
      serviceInsertCount: 0,
    };
  }
  function cloneState(src) {
    return {
      bookings: src.bookings.map((row) => ({ ...row, params: [...row.params] })),
      services: src.services.map((row) => ({ ...row, params: [...row.params] })),
      amounts: { ...src.amounts },
      bookingTotals: { ...src.bookingTotals },
      bookingMeta: { ...src.bookingMeta },
      serviceInsertCount: src.serviceInsertCount,
    };
  }

  let committed = emptyState();
  let txn = null;
  let committedFlag = false;
  let rolledBackFlag = false;

  function state() {
    return txn || committed;
  }

  const api = {
    writes,
    get inserts() {
      return committed.bookings.concat(committed.services);
    },
    get amountsById() {
      return committed.amounts;
    },
    get persistedBookings() {
      return committed.bookings.slice();
    },
    get persistedServices() {
      return committed.services.slice();
    },
    get persistedAmounts() {
      return { ...committed.amounts };
    },
    get persistedBookingTotals() {
      return { ...committed.bookingTotals };
    },
    get committed() { return committedFlag; },
    get rolledBack() { return rolledBackFlag; },
    seedServiceRecord(id, clientSlug) {
      const st = state();
      const slug = String(clientSlug || 'sunset');
      st.services.push({
        table: 'booking_service_records',
        id: String(id),
        client_slug: slug,
        params: [slug],
      });
      st.amounts[String(id)] = 0;
    },
    seedBooking(id, clientId) {
      const st = state();
      const cid = String(clientId || 'client-sunset');
      st.bookings.push({
        table: 'bookings',
        id: String(id),
        client_id: cid,
        params: [cid],
      });
      st.bookingTotals[String(id)] = 0;
    },
    query: async (sql, params) => {
      const s = String(sql);
      // Slice B stock support: unlimited configured stock for offline create/quote gates.
      if (/tenant_rental_offerings/i.test(s) && /stock_quantity/i.test(s)) {
        const keys = Array.isArray(params) ? params.filter((p) => Array.isArray(p)).flat() : [];
        const keyList = keys.length ? keys : (
          Array.isArray(params) ? params.filter((p) => typeof p === 'string' && /_rental$/.test(p)) : []
        );
        const loc = Array.isArray(params) && params.length >= 2 && typeof params[1] === 'string' && !params[1].includes('_rental')
          ? params[1] : 'sunset-somo';
        const slug = Array.isArray(params) && params[0] ? params[0] : 'sunset';
        const offeringKeys = keyList.length ? keyList : ['board_rental', 'wetsuit_rental', 'board_and_suit_rental'];
        const rows = offeringKeys.map((k, i) => ({
          id: 'stock-' + k,
          client_slug: slug,
          location_id: loc === null || loc === undefined ? null : loc,
          offering_key: k,
          stock_quantity: 99,
          active: true,
        }));
        // Single-key configured query (LIMIT 1)
        if (/LIMIT 1/i.test(s) && !/FOR UPDATE/i.test(s)) {
          const key = Array.isArray(params) ? params[params.length - 1] : null;
          const hit = rows.find((r) => r.offering_key === key) || {
            id: 'stock-' + key, client_slug: slug, location_id: loc,
            offering_key: key, stock_quantity: 99, active: true,
          };
          return { rows: key ? [hit] : [], rowCount: key ? 1 : 0 };
        }
        return { rows, rowCount: rows.length };
      }
      if (/booking_service_records/i.test(s) && /offering_key/i.test(s) && /NOT IN \('cancelled'/i.test(s)) {
        // Active reservations for stock — empty by default (no prior demand).
        return { rows: [], rowCount: 0 };
      }

      const isTxn = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(s);
      const isDml = /\b(INSERT|UPDATE|DELETE)\b/i.test(s);
      if (isTxn || isDml) {
        writes.push({ sql: s, params: params ? [...params] : [] });
        if (readOnly) {
          throw new Error('read_only_pg_write_attempted: ' + s.slice(0, 120));
        }
      }
      if (/^BEGIN/i.test(s)) {
        txn = cloneState(committed);
        committedFlag = false;
        rolledBackFlag = false;
        return { rows: [], rowCount: 0 };
      }
      if (/^COMMIT/i.test(s)) {
        if (txn) committed = txn;
        txn = null;
        committedFlag = true;
        rolledBackFlag = false;
        return { rows: [], rowCount: 0 };
      }
      if (/^ROLLBACK/i.test(s)) {
        txn = null;
        rolledBackFlag = true;
        committedFlag = false;
        return { rows: [], rowCount: 0 };
      }
      const st = state();
      if (/SELECT id FROM clients WHERE slug/i.test(s)) return { rows: [{ id: 'client-sunset' }], rowCount: 1 };
      if (/information_schema\.(tables|columns)/i.test(s)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (/to_regclass/i.test(s)) return { rows: [{ reg: 'tenant_price_rules' }], rowCount: 1 };
      if (/FROM tenant_surf_pack_rules/i.test(s)) return { rows: packs, rowCount: packs.length };
      if (/COALESCE\(SUM/i.test(s) && /booking_service_records/i.test(s)) {
        const date = String(params[1]).slice(0, 10);
        const courseId = params[2];
        const key = courseId + '|' + date;
        return { rows: [{ seats: seats[key] != null ? seats[key] : 0 }], rowCount: 1 };
      }
      if (/FROM tenant_price_rules/i.test(s)) {
        const itemCode = params[2];
        const unit = params[3];
        const locationId = params[4] || LOC;
        if (String(itemCode || '').startsWith('surf_pack_') && unit === 'day') {
          return {
            rows: [{ id: 'price-1', amount_cents: priceAmount, currency: 'EUR', item_type: 'package', item_code: itemCode, unit: 'day', location_id: locationId }],
            rowCount: 1,
          };
        }
        const rentalMap = opts.rentalPrices || {};
        if (rentalMap[itemCode]) {
          const row = rentalMap[itemCode];
          if (row.active === false) return { rows: [], rowCount: 0 };
          if (row.location_id && String(row.location_id) !== String(locationId)) return { rows: [], rowCount: 0 };
          return {
            rows: [{
              id: row.id || ('price-' + itemCode),
              amount_cents: row.amount_cents,
              currency: 'EUR',
              item_type: 'rental',
              item_code: itemCode,
              unit: unit || 'day',
              location_id: locationId,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO bookings/i.test(s)) {
        const bookingId = 'booking-uuid-1';
        const meta = typeof params[8] === 'string' ? JSON.parse(params[8]) : (params[8] || {});
        const clientId = forceBookingClientId != null ? forceBookingClientId : String(params[0]);
        if (!ghostBookingInsert) {
          const row = {
            table: 'bookings',
            id: bookingId,
            client_id: clientId,
            params: [...params],
          };
          st.bookings.push(row);
          st.bookingMeta[bookingId] = meta;
          st.bookingTotals[bookingId] = 0;
        }
        return { rows: [{ id: bookingId, booking_code: 'SUNSET-QTE-01' }], rowCount: 1 };
      }
      if (/INSERT INTO booking_service_records/i.test(s)) {
        st.serviceInsertCount += 1;
        if (failServiceInsertAt != null && st.serviceInsertCount === failServiceInsertAt) {
          throw new Error('forced_service_insert_failure');
        }
        const id = 'sr-' + st.serviceInsertCount;
        const meta = typeof params[9] === 'string' ? JSON.parse(params[9]) : params[9];
        const clientSlug = forceServiceClientSlug != null ? forceServiceClientSlug : String(params[0]);
        if (!ghostServiceInsert) {
          const row = {
            table: 'booking_service_records',
            id,
            client_slug: clientSlug,
            params: [...params],
          };
          st.services.push(row);
          st.amounts[id] = 0;
        }
        return {
          rows: [{
            service_record_id: id,
            id,
            booking_id: 'booking-uuid-1',
            booking_code: 'SUNSET-QTE-01',
            guest_name: params[3],
            service_type: params[4],
            service_date: params[5],
            quantity: params[6],
            amount_due_cents: 0,
            payment_status: params[7],
            record_source: params[8],
            metadata: meta,
            staff_ui_service_type: meta && meta.staff_ui_service_type,
            metadata_component: meta && meta.component,
            bundle_id: meta && meta.bundle_id,
            metadata_components: meta && Array.isArray(meta.components) ? meta.components.join(',') : null,
          }],
          rowCount: 1,
        };
      }
      if (/SELECT metadata FROM bookings/i.test(s)) {
        const bookingId = params && params[1] ? String(params[1]) : 'booking-uuid-1';
        return {
          rows: [{
            metadata: st.bookingMeta[bookingId] || { location_id: LOC, source: 'staff_manual_schedule' },
          }],
          rowCount: 1,
        };
      }
      if (/SELECT id, service_type/i.test(s) && /FROM booking_service_records/i.test(s)) {
        return {
          rows: st.services.map((row) => {
            const meta = typeof row.params[9] === 'string' ? JSON.parse(row.params[9]) : row.params[9];
            return {
              id: row.id,
              service_type: row.params[4],
              service_date: row.params[5],
              quantity: row.params[6],
              amount_due_cents: st.amounts[row.id] != null ? st.amounts[row.id] : 0,
              metadata: meta,
            };
          }),
          rowCount: st.services.length,
        };
      }
      if (/UPDATE booking_service_records\s+SET\s+amount_due_cents/i.test(s)) {
        const due = Number(params[0]);
        const id = String(params[1]);
        // Authoritative quote path scopes by client_slug ($3); legacy price path is id-only.
        if (/client_slug/i.test(s)) {
          const clientSlug = String(params[2]);
          const row = st.services.find((svc) => String(svc.id) === id && String(svc.client_slug) === clientSlug);
          if (!row) {
            return { rows: [], rowCount: 0 };
          }
          st.amounts[id] = due;
          return { rows: [], rowCount: 1 };
        }
        const row = st.services.find((svc) => String(svc.id) === id);
        if (!row) {
          return { rows: [], rowCount: 0 };
        }
        st.amounts[id] = due;
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE bookings\s+SET\s+total_amount_cents/i.test(s)) {
        const total = Number(params[0]);
        // Authoritative quote path: WHERE id = $3 AND client_id = $4
        // Legacy price path: WHERE id = $3 only.
        if (/client_id/i.test(s)) {
          const bookingId = String(params[2]);
          const clientId = String(params[3]);
          const row = st.bookings.find((b) => String(b.id) === bookingId && String(b.client_id) === clientId);
          if (!row) {
            return { rows: [], rowCount: 0 };
          }
          st.bookingTotals[bookingId] = total;
          return { rows: [], rowCount: 1 };
        }
        const bookingId = String(params[2]);
        const row = st.bookings.find((b) => String(b.id) === bookingId);
        if (!row) {
          return { rows: [], rowCount: 0 };
        }
        st.bookingTotals[bookingId] = total;
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE booking_service_records/i.test(s) || /UPDATE bookings SET/i.test(s)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  return api;
}

function buildQuoteCmd(channel, body, extra = {}) {
  return buildSunsetQuoteCommand({
    channel,
    transportBody: body,
    trustedLocationId: extra.trustedLocationId || LOC,
    now: FIXED_NOW,
  });
}

async function run() {
  console.log('\nverify:luna-front-desk-quote-service\n');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  console.log('[A] Staff and Luna normalize to same quote command');
  const transport = {
    offering_id: ITEM,
    course_id: PACK_ID,
    tier_key: TIER,
    service_dates: [SATURDAY],
    quantity: 1,
  };
  const manualBuilt = buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, transport);
  const lunaBuilt = buildQuoteCmd(QUOTE_CHANNELS.LUNA_WHATSAPP, { ...transport, client_slug: 'wolfhouse-somo', location_id: 'sunset-sardinero' });
  assert('manual command', manualBuilt.ok === true);
  assert('luna command', lunaBuilt.ok === true);
  assert('both force sunset tenant', manualBuilt.command.clientSlug === 'sunset' && lunaBuilt.command.clientSlug === 'sunset');
  assert('trusted location wins', lunaBuilt.command.locationId === LOC);

  console.log('\n[B] Same canonical quote across channels (sync fixture)');
  const cfg = adminCfg();
  const manualQuote = executeSunsetQuoteSync(manualBuilt.command, { adminCfg: cfg });
  const lunaQuote = executeSunsetQuoteSync(lunaBuilt.command, { adminCfg: cfg });
  assert('manual quote ok', manualQuote.ok === true, JSON.stringify(manualQuote.body));
  assert('luna quote ok', lunaQuote.ok === true);
  assert('same total', manualQuote.body.total_cents === lunaQuote.body.total_cents);
  assert('same offering_id', manualQuote.body.offering_id === lunaQuote.body.offering_id);
  assert('provenance present', manualQuote.body.quote_provenance && manualQuote.body.quote_provenance.quote_fingerprint);

  console.log('\n[C] Weekend restrictions identical');
  const friManual = executeSunsetQuoteSync(buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, { ...transport, service_dates: [FRIDAY] }).command, { adminCfg: cfg });
  const friLuna = executeSunsetQuoteSync(buildQuoteCmd(QUOTE_CHANNELS.LUNA_WHATSAPP, { ...transport, service_dates: [FRIDAY] }).command, { adminCfg: cfg });
  assert('manual weekday fails', friManual.ok === false);
  assert('luna weekday fails', friLuna.ok === false);
  assert('weekday reasons match', friManual.body.reason === friLuna.body.reason);

  console.log('\n[D] Client money rejected');
  assert('top-level money rejected', rejectClientSuppliedMoney({ unit_amount_cents: 50 }).ok === false);
  const moneyCmd = buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, { ...transport, total_cents: 100 });
  assert('command rejects money', moneyCmd.ok === false);

  console.log('\n[E] Quote creates zero writes');
  const pg = makePg();
  const asyncQuote = await executeSunsetQuote(pg, manualBuilt.command, { adminCfg: cfg });
  assert('async quote ok', asyncQuote.ok === true);
  assert('zero inserts', pg.inserts.length === 0);

  console.log('\n[F] Quote → create parity with provenance');
  const pgQuote = makePg();
  const asyncManualQuote = await executeSunsetQuote(pgQuote, manualBuilt.command, { adminCfg: cfg });
  assert('async manual quote for provenance', asyncManualQuote.ok === true);
  const provenance = asyncManualQuote.body.quote_provenance;
  const { resolveTenantBusinessConfigAsync } = require('./lib/tenant-business-config');
  const origResolve = resolveTenantBusinessConfigAsync;
  const createCmd = buildSunsetBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
    transportBody: {
      guest_name: 'Quote Guest',
      guest_phone: '+34600111222',
      payment_status: 'unpaid',
      service_dates: [SATURDAY],
      components: { course: { quantity: 1, course_id: PACK_ID, tier_key: TIER } },
      quote_provenance: provenance,
    },
    trustedLocationId: LOC,
    actorHints: { email: 'staff@test.com' },
    now: FIXED_NOW,
  });
  const pgCreate = makePg();
  require('./lib/tenant-business-config').resolveTenantBusinessConfigAsync = async () => cfg;
  const created = await executeSunsetBookingCreate(pgCreate, createCmd.command);
  require('./lib/tenant-business-config').resolveTenantBusinessConfigAsync = origResolve;
  assert('create with provenance ok', created.ok === true, JSON.stringify(created.body));
  assert('create total matches quote', created.body.total_cents === asyncManualQuote.body.total_cents);
  assert('create has total_cents', created.body.total_cents === AMOUNT);

  console.log('\n[F2] Exact-offering all-day quote survives canonical create-time re-quote');
  const equipmentKey = 'board_rental';
  const equipmentSelection = [{ offering_key: equipmentKey, mode: 'all_day', quantity: 1 }];
  const equipmentCfg = {
    ...cfg,
    rental_offerings: [{
      offering_key: equipmentKey,
      label: 'Slice A Softboard',
      active: true,
      client_slug: 'sunset',
      location_id: LOC,
    }],
    surf_packs: cfg.surf_packs.map((pack) => ({
      ...pack,
      equipment_options: [{
        offering_key: equipmentKey,
        during_course_price_cents: 0,
        all_day_price_cents: 1200,
      }],
    })),
  };
  const exactEquipmentTransport = {
    ...transport,
    course_equipment: equipmentSelection,
  };
  const exactEquipmentCmd = buildQuoteCmd(QUOTE_CHANNELS.LUNA_WHATSAPP, exactEquipmentTransport);
  const equipmentPg = () => makePg({
    packs: equipmentCfg.surf_packs.map((pack) => ({
      id: pack.pack_id,
      label: pack.label,
      config_json: {
        age_band: pack.age_band,
        group_size: pack.group_size,
        beaches: pack.beaches,
        weekly: pack.weekly,
        schedules: pack.schedules,
        equipment_options: pack.equipment_options,
        price_tiers: pack.price_tiers,
      },
    })),
  });
  const exactEquipmentQuote = await executeSunsetQuote(equipmentPg(), exactEquipmentCmd.command, { adminCfg: equipmentCfg });
  assert('fresh exact-offering all-day quote ok', exactEquipmentQuote.ok === true, JSON.stringify(exactEquipmentQuote.body));
  const exactEquipmentProvenance = exactEquipmentQuote.body.quote_provenance;
  const equipmentCreateCmd = buildSunsetBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    transportBody: {
      guest_name: 'Exact Equipment Guest',
      guest_phone: '+346****1333',
      payment_status: 'unpaid',
      service_dates: [SATURDAY],
      components: { course: { quantity: 1, course_id: PACK_ID, tier_key: TIER } },
      course_equipment: equipmentSelection,
      quote_provenance: exactEquipmentProvenance,
    },
    trustedLocationId: LOC,
    now: FIXED_NOW,
  });
  assert('equipment create command ok', equipmentCreateCmd.ok === true, JSON.stringify(equipmentCreateCmd));
  const freshEquipmentCheck = await validateQuoteProvenanceForCreate(
    equipmentPg(),
    equipmentCreateCmd.command,
    exactEquipmentProvenance,
    { adminCfg: equipmentCfg },
  );
  assert('fresh all-day provenance survives create re-quote', freshEquipmentCheck.ok === true, JSON.stringify(freshEquipmentCheck.body));

  const changedEquipmentCfg = {
    ...equipmentCfg,
    surf_packs: equipmentCfg.surf_packs.map((pack) => ({
      ...pack,
      equipment_options: pack.equipment_options.map((option) => ({
        ...option,
        all_day_price_cents: 1300,
      })),
    })),
  };
  const pgForCfg = (activeCfg) => makePg({
    packs: activeCfg.surf_packs.map((pack) => ({
      id: pack.pack_id,
      label: pack.label,
      config_json: {
        age_band: pack.age_band,
        group_size: pack.group_size,
        beaches: pack.beaches,
        weekly: pack.weekly,
        schedules: pack.schedules,
        equipment_options: pack.equipment_options,
        price_tiers: pack.price_tiers,
      },
    })),
  });
  const hostileCases = [
    {
      label: 'changed equipment price',
      command: equipmentCreateCmd.command,
      cfg: changedEquipmentCfg,
    },
    {
      label: 'changed dates',
      command: {
        ...equipmentCreateCmd.command,
        transportBody: { ...equipmentCreateCmd.command.transportBody, service_dates: [FRIDAY] },
      },
      cfg: equipmentCfg,
    },
    {
      label: 'changed course',
      command: {
        ...equipmentCreateCmd.command,
        transportBody: {
          ...equipmentCreateCmd.command.transportBody,
          components: {
            course: {
              ...equipmentCreateCmd.command.transportBody.components.course,
              course_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            },
          },
        },
      },
      cfg: equipmentCfg,
    },
    {
      label: 'changed location',
      command: { ...equipmentCreateCmd.command, locationId: 'sunset-sardinero' },
      cfg: equipmentCfg,
    },
    {
      label: 'changed quantity',
      command: {
        ...equipmentCreateCmd.command,
        transportBody: {
          ...equipmentCreateCmd.command.transportBody,
          components: {
            course: { ...equipmentCreateCmd.command.transportBody.components.course, quantity: 2 },
          },
        },
      },
      cfg: equipmentCfg,
    },
    {
      label: 'changed equipment offering_key',
      command: {
        ...equipmentCreateCmd.command,
        transportBody: {
          ...equipmentCreateCmd.command.transportBody,
          course_equipment: [{ offering_key: 'wetsuit_rental', mode: 'all_day', quantity: 1 }],
        },
      },
      cfg: equipmentCfg,
    },
  ];
  for (const hostile of hostileCases) {
    const check = await validateQuoteProvenanceForCreate(
      pgForCfg(hostile.cfg),
      hostile.command,
      exactEquipmentProvenance,
      { adminCfg: hostile.cfg },
    );
    assert(`${hostile.label} remains stale`, check.ok === false && check.body && check.body.reason_code === 'stale_quote', JSON.stringify(check.body));
  }

  console.log('\n[G] Stale quote on price change');
  const pgStale = makePg({ priceAmount: AMOUNT + 500 });
  require('./lib/tenant-business-config').resolveTenantBusinessConfigAsync = async () => ({ ...cfg, source: 'db' });
  const staleCheck = await validateQuoteProvenanceForCreate(pgStale, createCmd.command, provenance, { adminCfg: cfg });
  require('./lib/tenant-business-config').resolveTenantBusinessConfigAsync = origResolve;
  assert('stale quote blocked', staleCheck.ok === false);
  assert('stale reason_code', staleCheck.body && staleCheck.body.reason_code === 'stale_quote');
  assert('stale create no booking', pgStale.inserts.filter((i) => i.table === 'bookings').length === 0);

  console.log('\n[H] Capacity full fails consistently');
  const pgFull = makePg({ existingCourseSeats: { [`${PACK_ID}|${SATURDAY}`]: 2 } });
  const qManual = await executeSunsetQuote(pgFull, manualBuilt.command, { adminCfg: cfg });
  const qLuna = await executeSunsetQuote(makePg({ existingCourseSeats: { [`${PACK_ID}|${SATURDAY}`]: 2 } }), lunaBuilt.command, { adminCfg: cfg });
  assert('manual course_full', qManual.ok === false && (qManual.body.reason === 'course_full' || qManual.body.error === 'course_full'));
  assert('luna course_full', qLuna.ok === false && (qLuna.body.reason === 'course_full' || qLuna.body.error === 'course_full'));

  console.log('\n[I] Missing price fails closed');
  const badCfg = {
    ok: true,
    source: 'db',
    currency: 'EUR',
    surf_packs: [{ pack_id: PACK_ID, label: 'X', active: true, group_size: 2, weekly: 'sat_sun', schedules: ['0930_1130'], price_tiers: [{ key: TIER, label: '1 week' }] }],
    prices: [],
  };
  const missing = executeSunsetQuoteSync(manualBuilt.command, { adminCfg: badCfg });
  assert('missing price fails', missing.ok === false && (missing.body.reason === 'price_missing' || missing.body.reason === 'unknown_offering'));

  // ── Slice 3A: canonical rentals[] quote ─────────────────────────────────
  console.log('\n[J] Canonical rentals quote (Slice 3A)');

  const BUNDLE_1D = 2500;
  const BOARD_1D = 1500;
  const WETSUIT_1D = 800;
  const BOARD_3D = 4000;

  function rentalPrices(rows) {
    return adminCfg([
      {
        id: 'price-pack',
        category: 'package',
        offering_key: ITEM,
        item_code: ITEM,
        amount_cents: AMOUNT,
        unit: 'day',
        active: true,
        currency: 'EUR',
        location_id: LOC,
      },
      ...rows,
    ]);
  }

  function rentalRow(offeringKey, amountCents, opts = {}) {
    return {
      id: opts.id || `price-${offeringKey}`,
      category: 'rental',
      offering_key: offeringKey,
      item_code: offeringKey,
      amount_cents: amountCents,
      unit: opts.unit || 'day',
      active: opts.active !== false,
      currency: 'EUR',
      location_id: opts.location_id || LOC,
    };
  }

  const somoRentalCfg = rentalPrices([
    rentalRow('board_and_suit_rental__1_day', BUNDLE_1D),
    rentalRow('board_rental__1_day', BOARD_1D),
    rentalRow('wetsuit_rental__1_day', WETSUIT_1D),
    rentalRow('board_rental__3_days', BOARD_3D),
    rentalRow('board_rental__1_day', 1200, { id: 'price-sardi-board', location_id: 'sunset-sardinero' }),
    rentalRow('board_and_suit_rental__1_day', BUNDLE_1D, { id: 'price-inactive-bundle', active: false }),
  ]);

  function staffRentalBody(extra) {
    const body = {
      guest_name: 'Rental Guest',
      guest_phone: '+34600111222',
      date_from: SATURDAY,
      date_to: SATURDAY,
      service_dates: [SATURDAY],
      payment_status: 'unpaid',
      components: {},
      ...extra,
    };
    // Staff no-lesson equipment requires authoritative surfer_count (guest field).
    // Default guest count from rental/component quantity when the fixture omits it.
    if (body.surfer_count == null && body.guest_count == null) {
      if (Array.isArray(body.rentals) && body.rentals[0] && body.rentals[0].quantity != null) {
        body.surfer_count = Number(body.rentals[0].quantity) || 1;
      } else if (body.components && body.components.surfboard && body.components.surfboard.quantity != null) {
        body.surfer_count = Number(body.components.surfboard.quantity) || 1;
      } else if (body.components && body.components.wetsuit && body.components.wetsuit.quantity != null) {
        body.surfer_count = Number(body.components.wetsuit.quantity) || 1;
      } else {
        body.surfer_count = 1;
      }
    }
    return body;
  }

  // 1. Somo bundle 1_day resolves only board_and_suit_rental__1_day
  const bundleBody = staffRentalBody({
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
    components: {
      surfboard: { quantity: 1 },
      wetsuit: { quantity: 1 },
    },
  });
  const bundleQuote = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, bundleBody).command,
    { adminCfg: somoRentalCfg },
  );
  assert('1 bundle quote ok', bundleQuote.ok === true, JSON.stringify(bundleQuote.body));
  assert(
    '1 Somo bundle resolves board_and_suit_rental__1_day only',
    bundleQuote.body.total_cents === BUNDLE_1D
      && Array.isArray(bundleQuote.body.line_items)
      && bundleQuote.body.line_items.filter((l) => String(l.offering_id || l.offering_item_code || '').includes('rental')).length === 1
      && bundleQuote.body.line_items.some((l) => (
        l.offering_id === 'board_and_suit_rental__1_day'
        || l.offering_item_code === 'board_and_suit_rental__1_day'
      )),
    JSON.stringify(bundleQuote.body.line_items),
  );

  // 2. Bundle quantity 2 charges exactly 2 × bundle price
  const bundleQty2 = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 2 }],
      components: { surfboard: { quantity: 2 }, wetsuit: { quantity: 2 } },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('2 bundle qty 2 = 2× bundle', bundleQty2.ok === true && bundleQty2.body.total_cents === BUNDLE_1D * 2, JSON.stringify(bundleQty2.body));

  // 3. Bundle does not look up individual board/wetsuit prices
  const bundleOnlyCfg = rentalPrices([
    rentalRow('board_and_suit_rental__1_day', BUNDLE_1D),
    // intentionally no separate board/wetsuit rows
  ]);
  const bundleNoSeparate = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, bundleBody).command,
    { adminCfg: bundleOnlyCfg },
  );
  assert(
    '3 bundle does not require individual board/wetsuit prices',
    bundleNoSeparate.ok === true && bundleNoSeparate.body.total_cents === BUNDLE_1D,
    JSON.stringify(bundleNoSeparate.body),
  );

  // 4. Separate board and wetsuit quote independently
  const separateQuote = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [
        { offering_key: 'board_rental', duration_key: '1_day', quantity: 1 },
        { offering_key: 'wetsuit_rental', duration_key: '1_day', quantity: 1 },
      ],
      components: { surfboard: { quantity: 1 }, wetsuit: { quantity: 1 } },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    '4 separate board+wetsuit independent',
    separateQuote.ok === true && separateQuote.body.total_cents === BOARD_1D + WETSUIT_1D,
    JSON.stringify(separateQuote.body),
  );

  // 5. Bundle + board + wetsuit are independent exact offerings (simultaneous OK)
  const bundlePlusBoard = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [
        { offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 },
        { offering_key: 'board_rental', duration_key: '1_day', quantity: 1 },
        { offering_key: 'wetsuit_rental', duration_key: '1_day', quantity: 1 },
      ],
      components: { surfboard: { quantity: 1 }, wetsuit: { quantity: 1 } },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    '5 combo+board+wetsuit simultaneous quote succeeds',
    bundlePlusBoard.ok === true
      && Number(bundlePlusBoard.body.total_cents) === BUNDLE_1D + BOARD_1D + WETSUIT_1D
      && (bundlePlusBoard.body.line_items || []).length === 3,
    JSON.stringify(bundlePlusBoard.body),
  );

  // 6. Unknown/malformed keys, duplicate, wrong-duration rejected
  const badKey = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'Not Valid Key!!', duration_key: '1_day', quantity: 1 }],
      components: { surfboard: { quantity: 1 } },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('6a invalid offering_key shape rejected', badKey.ok === false);

  // Unknown catalog key (valid shape, not in catalog/prices) fail-closed unpriced
  const unknownCatalog = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'kayak_rental', duration_key: '1_day', quantity: 1 }],
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    '6a2 unknown catalog key fails closed (price_missing / not active)',
    unknownCatalog.ok === false,
    JSON.stringify(unknownCatalog.body),
  );

  const dup = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [
        { offering_key: 'board_rental', duration_key: '1_day', quantity: 1 },
        { offering_key: 'board_rental', duration_key: '1_day', quantity: 2 },
      ],
      components: { surfboard: { quantity: 1 } },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('6b duplicate offering_key rejected', dup.ok === false);

  const badQtyCases = [
    { quantity: 0 },
    { quantity: -1 },
    { quantity: 1.5 },
    { quantity: 'abc' },
    { quantity: null },
  ];
  let badQtyOk = true;
  for (const tc of badQtyCases) {
    const q = executeSunsetQuoteSync(
      buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
        rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: tc.quantity }],
        components: { surfboard: { quantity: 1 } },
      })).command,
      { adminCfg: somoRentalCfg },
    );
    if (q.ok) badQtyOk = false;
  }
  assert('6c invalid quantities rejected', badQtyOk);

  const wrongDur = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '3_days', quantity: 1 }],
      components: { surfboard: { quantity: 1 } },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('6d wrong-duration vs date span rejected', wrongDur.ok === false, JSON.stringify(wrongDur.body));

  // Multi-day span requires matching duration_key and exact 3_days price (no ×3)
  const threeDayBody = staffRentalBody({
    date_from: '2026-07-18',
    date_to: '2026-07-20',
    service_dates: ['2026-07-18', '2026-07-19', '2026-07-20'],
    rentals: [{ offering_key: 'board_rental', duration_key: '3_days', quantity: 1 }],
    components: { surfboard: { quantity: 1 } },
  });
  const threeDayQuote = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, threeDayBody).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    '6e exact-duration 3_days is duration total (not × span)',
    threeDayQuote.ok === true && threeDayQuote.body.total_cents === BOARD_3D,
    JSON.stringify(threeDayQuote.body),
  );

  // 7. Inactive / missing / wrong-location fail closed
  const inactiveOnly = rentalPrices([
    rentalRow('board_rental__1_day', BOARD_1D, { active: false }),
  ]);
  const inactiveQ = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
      components: { surfboard: { quantity: 1 } },
    })).command,
    { adminCfg: inactiveOnly },
  );
  assert('7a inactive rental fails closed', inactiveQ.ok === false);

  const missingRental = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'wetsuit_rental', duration_key: '1_day', quantity: 1 }],
      components: { wetsuit: { quantity: 1 } },
    })).command,
    { adminCfg: rentalPrices([rentalRow('board_rental__1_day', BOARD_1D)]) },
  );
  assert('7b missing rental price fails closed', missingRental.ok === false);

  const sardiOnly = rentalPrices([
    rentalRow('board_rental__1_day', 1200, { location_id: 'sunset-sardinero' }),
  ]);
  // Catalog projection tags offerings to trusted location; without a Somo active row the offering is absent.
  const wrongLoc = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
      components: { surfboard: { quantity: 1 } },
    }), { trustedLocationId: LOC }).command,
    { adminCfg: sardiOnly },
  );
  // If catalog still surfaces the row (location stamped to Somo), async DB resolve must fail closed.
  if (wrongLoc.ok) {
    const pgWrong = makePg();
    const asyncWrong = await executeSunsetQuote(pgWrong, buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
      components: { surfboard: { quantity: 1 } },
      require_db: true,
    })).command, { adminCfg: sardiOnly });
    assert('7c wrong-location fails closed (async DB)', asyncWrong.ok === false, JSON.stringify(asyncWrong.body));
    assert('7c wrong-location quote zero writes', pgWrong.inserts.length === 0);
  } else {
    assert('7c wrong-location fails closed (sync catalog)', wrongLoc.ok === false, JSON.stringify(wrongLoc.body));
  }

  // 8. Matching legacy components do not double-charge
  assert(
    '8 matching legacy does not double-charge',
    bundleQuote.ok && bundleQuote.body.total_cents === BUNDLE_1D
      && !(bundleQuote.body.total_cents === BUNDLE_1D + BOARD_1D + WETSUIT_1D),
  );

  // 9. Staff no-lesson without surfer_count fails closed (guest field still required).
  // Equipment qty is independent: rentals[] own qty; components re-synced from rentals.
  const legacyNoSn = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, {
      guest_name: 'Rental Guest',
      date_from: SATURDAY,
      date_to: SATURDAY,
      service_dates: [SATURDAY],
      payment_status: 'unpaid',
      // no surfer_count — staff fail-closed
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 2 }],
      components: { surfboard: { quantity: 1 } },
    }).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    '9 staff without surfer_count fails closed (no legacy spoof)',
    legacyNoSn.ok === false
      && String((legacyNoSn.body && (legacyNoSn.body.reason_code || legacyNoSn.body.reason || legacyNoSn.body.error)) || '')
        .includes('surfer_count_required_for_no_lesson_equipment'),
    JSON.stringify(legacyNoSn.body),
  );
  const legacyIndep = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      surfer_count: 2,
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 9 }],
      components: { surfboard: { quantity: 1 } },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    '9 staff surfer_count preserves independent rental qty 9 (components re-synced from rentals)',
    legacyIndep.ok === true
      && legacyIndep.body.total_cents === BOARD_1D * 9
      && (legacyIndep.body.line_items || []).every((l) => Number(l.quantity) === 9),
    JSON.stringify(legacyIndep.body),
  );

  // 10. Course + bundle total combines correctly
  const courseBundle = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {
        course: { quantity: 1, course_id: PACK_ID, tier_key: TIER },
        surfboard: { quantity: 1 },
        wetsuit: { quantity: 1 },
      },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    '10 course + bundle total',
    courseBundle.ok === true && courseBundle.body.total_cents === AMOUNT + BUNDLE_1D,
    JSON.stringify(courseBundle.body),
  );

  // 11. guest_name + non-rental quote behavior remain green
  assert('11 guest_name on rental quote preserved in command path', bundleQuote.ok === true);
  const courseOnlyStill = executeSunsetQuoteSync(manualBuilt.command, { adminCfg: cfg });
  assert('11 non-rental course quote still green', courseOnlyStill.ok === true && courseOnlyStill.body.total_cents === AMOUNT);
  assert('11 provenance still present on rental quote', bundleQuote.body.quote_provenance && bundleQuote.body.quote_provenance.quote_fingerprint);

  // Legacy-only (no rentals array) preserves hardcoded __1_day behavior
  const legacyOnly = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      components: { surfboard: { quantity: 1 } },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    '11b no rentals array preserves legacy surfboard pricing',
    legacyOnly.ok === true && legacyOnly.body.total_cents === BOARD_1D,
    JSON.stringify(legacyOnly.body),
  );

  // 12. Quote performs no DB writes
  const pgRent = makePg({
    readOnly: true,
    rentalPrices: {
      board_and_suit_rental__1_day: { amount_cents: BUNDLE_1D, location_id: LOC },
    },
  });
  const asyncBundle = await executeSunsetQuote(pgRent, buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, bundleBody).command, { adminCfg: somoRentalCfg });
  assert('12 async rental quote ok', asyncBundle.ok === true, JSON.stringify(asyncBundle.body));
  assert('12 rental quote zero inserts', pgRent.inserts.length === 0);
  assert('12 rental quote zero write statements', pgRent.writes.length === 0);

  // ── Slice 3A corrections: dispatch / duration / provenance ─────────────
  console.log('\n[K] Canonical-only dispatch + authoritative duration + multi-line provenance');

  const bundleOnlyNoLegacy = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {},
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    'K1 sync bundle-only with empty components quotes',
    bundleOnlyNoLegacy.ok === true && bundleOnlyNoLegacy.body.total_cents === BUNDLE_1D,
    JSON.stringify(bundleOnlyNoLegacy.body),
  );

  const boardOnlyNoLegacy = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 2 }],
      components: {},
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    'K2 sync board-only with empty components quotes',
    boardOnlyNoLegacy.ok === true && boardOnlyNoLegacy.body.total_cents === BOARD_1D * 2,
    JSON.stringify(boardOnlyNoLegacy.body),
  );

  const asyncBundleOnly = await executeSunsetQuote(
    makePg({
      readOnly: true,
      rentalPrices: { board_and_suit_rental__1_day: { amount_cents: BUNDLE_1D, location_id: LOC } },
    }),
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {},
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('K3 async bundle-only with empty components quotes', asyncBundleOnly.ok === true && asyncBundleOnly.body.total_cents === BUNDLE_1D, JSON.stringify(asyncBundleOnly.body));

  const neither = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, {
      guest_name: 'Nobody',
      date_from: SATURDAY,
      date_to: SATURDAY,
      payment_status: 'unpaid',
    }).command,
    { adminCfg: somoRentalCfg },
  );
  assert('K4 neither components nor rentals → quote_input_required', neither.ok === false && neither.body.reason === 'quote_input_required');

  // Authoritative duration from date_from/date_to — reject 3-day range + one service date + 1_day
  const spoofedSpan = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, {
      guest_name: 'Spoof',
      date_from: '2026-07-18',
      date_to: '2026-07-20',
      service_dates: ['2026-07-18'],
      payment_status: 'unpaid',
      surfer_count: 1,
      components: {},
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
    }).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    'K5 3-day date range cannot submit one service_date + duration_key=1_day',
    spoofedSpan.ok === false,
    JSON.stringify(spoofedSpan.body),
  );

  const extraServiceDate = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, {
      guest_name: 'Extra',
      date_from: SATURDAY,
      date_to: SATURDAY,
      service_dates: [SATURDAY, '2026-07-19'],
      payment_status: 'unpaid',
      surfer_count: 1,
      components: {},
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
    }).command,
    { adminCfg: somoRentalCfg },
  );
  assert('K6 service_dates with extra day rejected', extraServiceDate.ok === false, JSON.stringify(extraServiceDate.body));

  const threeDayOk = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, {
      guest_name: 'ThreeDay',
      date_from: '2026-07-18',
      date_to: '2026-07-20',
      service_dates: ['2026-07-18', '2026-07-19', '2026-07-20'],
      payment_status: 'unpaid',
      surfer_count: 1,
      components: {},
      rentals: [{ offering_key: 'board_rental', duration_key: '3_days', quantity: 1 }],
    }).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    'K7 matching 3-day range + service_dates + duration_key ok',
    threeDayOk.ok === true && threeDayOk.body.total_cents === BOARD_3D,
    JSON.stringify(threeDayOk.body),
  );

  // Multi-line provenance: fingerprint changes when rental fields change
  const { computeQuoteFingerprint } = require('./lib/luna-front-desk-quote-service');
  const baseCourseBundle = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {
        course: { quantity: 1, course_id: PACK_ID, tier_key: TIER },
      },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('K8 course+bundle quote ok', baseCourseBundle.ok === true, JSON.stringify(baseCourseBundle.body));
  const fpBase = baseCourseBundle.body.quote_provenance.quote_fingerprint;

  const qtyChanged = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 2 }],
      components: {
        course: { quantity: 1, course_id: PACK_ID, tier_key: TIER },
      },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('K9 fingerprint changes on rental quantity', qtyChanged.ok && qtyChanged.body.quote_provenance.quote_fingerprint !== fpBase);

  const offeringChanged = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
      components: {
        course: { quantity: 1, course_id: PACK_ID, tier_key: TIER },
      },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('K10 fingerprint changes on offering key', offeringChanged.ok && offeringChanged.body.quote_provenance.quote_fingerprint !== fpBase);

  const durationChanged = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, {
      guest_name: 'Dur',
      date_from: '2026-07-18',
      date_to: '2026-07-20',
      service_dates: ['2026-07-18', '2026-07-19', '2026-07-20'],
      payment_status: 'unpaid',
      components: {
        course: { quantity: 1, course_id: PACK_ID, tier_key: TIER },
      },
      rentals: [{ offering_key: 'board_rental', duration_key: '3_days', quantity: 1 }],
    }).command,
    { adminCfg: somoRentalCfg },
  );
  // Course may fail weekday for Mon — use rental-only for duration fingerprint vs board 1_day.
  // Both must go through staffRentalBody so required staff surfer_count is present
  // (production still fails closed without it — fixture is valid, not relaxed).
  const board1dFp = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
      components: {},
    })).command,
    { adminCfg: somoRentalCfg },
  );
  const board3dFp = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      date_from: '2026-07-18',
      date_to: '2026-07-20',
      service_dates: ['2026-07-18', '2026-07-19', '2026-07-20'],
      rentals: [{ offering_key: 'board_rental', duration_key: '3_days', quantity: 1 }],
      components: {},
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    'K11 fingerprint changes on duration',
    board1dFp.ok && board3dFp.ok
      && board1dFp.body.quote_provenance
      && board3dFp.body.quote_provenance
      && board1dFp.body.quote_provenance.quote_fingerprint
        !== board3dFp.body.quote_provenance.quote_fingerprint,
    JSON.stringify({
      d1: board1dFp.ok ? board1dFp.body.quote_provenance.quote_fingerprint : board1dFp.body,
      d3: board3dFp.ok ? board3dFp.body.quote_provenance.quote_fingerprint : board3dFp.body,
    }),
  );

  const priceIdChangedCfg = rentalPrices([
    rentalRow('board_and_suit_rental__1_day', BUNDLE_1D, { id: 'price-bundle-alt-id' }),
    rentalRow('board_rental__1_day', BOARD_1D),
    rentalRow('wetsuit_rental__1_day', WETSUIT_1D),
    rentalRow('board_rental__3_days', BOARD_3D),
  ]);
  const priceIdChanged = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {
        course: { quantity: 1, course_id: PACK_ID, tier_key: TIER },
      },
    })).command,
    { adminCfg: priceIdChangedCfg },
  );
  assert(
    'K12 fingerprint changes on authoritative price_id',
    priceIdChanged.ok
      && priceIdChanged.body.quote_provenance.quote_fingerprint !== fpBase,
    JSON.stringify({ base: fpBase, next: priceIdChanged.body.quote_provenance }),
  );

  const unitPriceChangedCfg = rentalPrices([
    rentalRow('board_and_suit_rental__1_day', BUNDLE_1D + 100),
    rentalRow('board_rental__1_day', BOARD_1D),
    rentalRow('wetsuit_rental__1_day', WETSUIT_1D),
    rentalRow('board_rental__3_days', BOARD_3D),
  ]);
  const unitPriceChanged = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {
        course: { quantity: 1, course_id: PACK_ID, tier_key: TIER },
      },
    })).command,
    { adminCfg: unitPriceChangedCfg },
  );
  assert(
    'K13 fingerprint changes on unit price',
    unitPriceChanged.ok
      && unitPriceChanged.body.quote_provenance.quote_fingerprint !== fpBase,
  );

  // Deterministic line summary is what the fingerprint hashes (version bumped)
  const linesSummary = (baseCourseBundle.body.line_items || []).map((l) => ({
    component: l.component,
    offering_id: l.offering_id,
    quantity: l.quantity,
  }));
  assert(
    'K14 multi-line quote includes course + rental lines',
    linesSummary.length >= 2
      && linesSummary.some((l) => l.component === 'course')
      && linesSummary.some((l) => String(l.component || '').includes('rental') || String(l.offering_id || '').includes('rental')),
    JSON.stringify(linesSummary),
  );
  assert(
    'K15 provenance version bumped for multi-line lines',
    baseCourseBundle.body.quote_provenance.quote_version >= 2,
    String(baseCourseBundle.body.quote_provenance.quote_version),
  );

  // ── Slice 3B: canonical rentals[] create/writes ─────────────────────────
  console.log('\n[L] Canonical rentals create (Slice 3B)');

  const rentalPgOpts = {
    rentalPrices: {
      board_and_suit_rental__1_day: { amount_cents: BUNDLE_1D, location_id: LOC, id: 'price-board_and_suit_rental__1_day' },
      board_rental__1_day: { amount_cents: BOARD_1D, location_id: LOC, id: 'price-board_rental__1_day' },
      wetsuit_rental__1_day: { amount_cents: WETSUIT_1D, location_id: LOC, id: 'price-wetsuit_rental__1_day' },
      board_rental__3_days: { amount_cents: BOARD_3D, location_id: LOC, id: 'price-board_rental__3_days' },
    },
  };

  function serviceInserts(pg) {
    return pg.inserts.filter((i) => i.table === 'booking_service_records');
  }
  function metaOf(ins) {
    return typeof ins.params[9] === 'string' ? JSON.parse(ins.params[9]) : ins.params[9];
  }
  function sumAmounts(pg) {
    return Object.values(pg.amountsById).reduce((a, b) => a + (Number(b) || 0), 0);
  }

  async function withCfg(cfgObj, fn) {
    const { resolveTenantBusinessConfigAsync } = require('./lib/tenant-business-config');
    const orig = resolveTenantBusinessConfigAsync;
    require('./lib/tenant-business-config').resolveTenantBusinessConfigAsync = async () => cfgObj;
    try {
      return await fn();
    } finally {
      require('./lib/tenant-business-config').resolveTenantBusinessConfigAsync = orig;
    }
  }

  // L1: bundle qty 1 → linked board+wetsuit rows with shared identity
  {
    const quoteBody = staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {},
    });
    const pg = makePg(rentalPgOpts);
    const created = await withCfg(somoRentalCfg, async () => {
      const q = await executeSunsetQuote(pg, buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, quoteBody).command, { adminCfg: somoRentalCfg });
      return executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
        channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
        transportBody: { ...quoteBody, quote_provenance: q.body.quote_provenance },
        trustedLocationId: LOC,
        actorHints: { email: 'staff@test.com' },
        now: FIXED_NOW,
      }).command);
    });
    const rows = serviceInserts(pg);
    const metas = rows.map(metaOf);
    const exact = rows.filter((r) => {
      const m = metaOf(r);
      return m && m.offering_key === 'board_and_suit_rental';
    });
    const board = rows.filter((r) => r.params[4] === 'surfboard');
    const suit = rows.filter((r) => r.params[4] === 'wetsuit');
    assert('L1 create ok', created.ok === true, JSON.stringify(created.body));
    // Slice B: board_and_suit future write is one exact offering record (not dual components).
    assert(
      'L1 exact board_and_suit offering row (no component halves)',
      exact.length >= 1 && board.length === 0 && suit.length === 0,
      JSON.stringify({ types: rows.map((r) => r.params[4]), metas }),
    );
    assert(
      'L1 exact offering metadata',
      exact.length >= 1
        && metas.some((m) => m.offering_key === 'board_and_suit_rental'
          && m.duration_key === '1_day'
          && m.quantity === 1
          && !m.bundle_part
          && !m.rental_pricing_role),
      JSON.stringify(metas),
    );
    assert('L1 billable aggregate equals quote', created.body.total_cents === BUNDLE_1D && sumAmounts(pg) === BUNDLE_1D, `${created.body.total_cents}/${sumAmounts(pg)}`);
  }

  // L2: bundle qty 2 preserves quantity 2 without double charge
  {
    const quoteBody = staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 2 }],
      components: {},
    });
    const pg = makePg(rentalPgOpts);
    const created = await withCfg(somoRentalCfg, async () => {
      const q = await executeSunsetQuote(pg, buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, quoteBody).command, { adminCfg: somoRentalCfg });
      return executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
        channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
        transportBody: { ...quoteBody, quote_provenance: q.body.quote_provenance },
        trustedLocationId: LOC,
        actorHints: { email: 'staff@test.com' },
        now: FIXED_NOW,
      }).command);
    });
    const metas = serviceInserts(pg).map(metaOf);
    assert('L2 create ok', created.ok === true, JSON.stringify(created.body));
    assert('L2 quantity 2 on operational rows', metas.every((m) => Number(m.quantity) === 2) && serviceInserts(pg).every((r) => Number(r.params[6]) === 2));
    assert('L2 no double charge', created.body.total_cents === BUNDLE_1D * 2 && sumAmounts(pg) === BUNDLE_1D * 2, `${created.body.total_cents}/${sumAmounts(pg)}`);
  }

  // L3: separate board + wetsuit create independently
  {
    const quoteBody = staffRentalBody({
      rentals: [
        { offering_key: 'board_rental', duration_key: '1_day', quantity: 1 },
        { offering_key: 'wetsuit_rental', duration_key: '1_day', quantity: 2 },
      ],
      components: {},
    });
    const pg = makePg(rentalPgOpts);
    const created = await withCfg(somoRentalCfg, async () => {
      const q = await executeSunsetQuote(pg, buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, quoteBody).command, { adminCfg: somoRentalCfg });
      return executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
        channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
        transportBody: { ...quoteBody, quote_provenance: q.body.quote_provenance },
        trustedLocationId: LOC,
        actorHints: { email: 'staff@test.com' },
        now: FIXED_NOW,
      }).command);
    });
    const expected = BOARD_1D + WETSUIT_1D * 2;
    const board = serviceInserts(pg).filter((r) => r.params[4] === 'surfboard');
    const suit = serviceInserts(pg).filter((r) => r.params[4] === 'wetsuit');
    assert('L3 create ok', created.ok === true, JSON.stringify(created.body));
    assert('L3 separate board+wetsuit rows', board.length >= 1 && suit.length >= 1);
    assert('L3 aggregate equals quote', created.body.total_cents === expected && sumAmounts(pg) === expected, `${created.body.total_cents}/${sumAmounts(pg)}`);
  }

  // L4: course + bundle total equals authoritative quote
  {
    const quoteBody = staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: { course: { quantity: 1, course_id: PACK_ID, tier_key: TIER } },
    });
    const pg = makePg(rentalPgOpts);
    let quoteTotal = null;
    const created = await withCfg(somoRentalCfg, async () => {
      const q = await executeSunsetQuote(pg, buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, quoteBody).command, { adminCfg: somoRentalCfg });
      quoteTotal = q.ok ? q.body.total_cents : null;
      return executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
        channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
        transportBody: { ...quoteBody, quote_provenance: q.body.quote_provenance },
        trustedLocationId: LOC,
        actorHints: { email: 'staff@test.com' },
        now: FIXED_NOW,
      }).command);
    });
    const expected = AMOUNT + BUNDLE_1D;
    assert('L4 course+bundle create ok', created.ok === true, JSON.stringify(created.body));
    assert('L4 total equals quote', created.body.total_cents === expected && quoteTotal === expected, `${created.body.total_cents} vs ${quoteTotal}`);
    assert(
      'L4 persisted service amount sum equals quote total',
      sumAmounts(pg) === expected && Object.values(pg.persistedAmounts).reduce((a, b) => a + Number(b), 0) === expected,
      JSON.stringify(pg.persistedAmounts),
    );
    assert(
      'L4 booking header total equals quote',
      Number(pg.persistedBookingTotals['booking-uuid-1']) === expected,
      JSON.stringify(pg.persistedBookingTotals),
    );
  }

  // L5: stale price → zero writes
  {
    const quoteBody = staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {},
    });
    const qPg = makePg(rentalPgOpts);
    const q = await withCfg(somoRentalCfg, async () => executeSunsetQuote(
      qPg,
      buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, quoteBody).command,
      { adminCfg: somoRentalCfg },
    ));
    const staleCfg = rentalPrices([
      rentalRow('board_and_suit_rental__1_day', BUNDLE_1D + 500),
      rentalRow('board_rental__1_day', BOARD_1D),
      rentalRow('wetsuit_rental__1_day', WETSUIT_1D),
      rentalRow('board_rental__3_days', BOARD_3D),
    ]);
    const pg = makePg({
      rentalPrices: {
        board_and_suit_rental__1_day: { amount_cents: BUNDLE_1D + 500, location_id: LOC },
      },
    });
    const created = await withCfg(staleCfg, async () => executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
      channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
      transportBody: { ...quoteBody, quote_provenance: q.body.quote_provenance },
      trustedLocationId: LOC,
      actorHints: { email: 'staff@test.com' },
      now: FIXED_NOW,
    }).command));
    assert('L5 stale create blocked', created.ok === false, JSON.stringify(created.body));
    assert('L5 zero persisted bookings', pg.persistedBookings.length === 0, String(pg.persistedBookings.length));
    assert('L5 zero persisted services', pg.persistedServices.length === 0, String(pg.persistedServices.length));
    assert(
      'L5 zero persisted amounts + no commit',
      Object.keys(pg.persistedAmounts).length === 0 && pg.committed !== true,
      JSON.stringify({ amounts: pg.persistedAmounts, committed: pg.committed, rolledBack: pg.rolledBack }),
    );
  }

  // L6: service insert failure rolls back booking + all service rows (no partial write).
  // Exact board_and_suit is one insert; fail on the first operational insert.
  {
    const quoteBody = staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {},
    });
    const qPg = makePg(rentalPgOpts);
    const q = await withCfg(somoRentalCfg, async () => executeSunsetQuote(
      qPg,
      buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, quoteBody).command,
      { adminCfg: somoRentalCfg },
    ));
    const pg = makePg({ ...rentalPgOpts, failServiceInsertAt: 1 });
    let threw = false;
    let created = null;
    try {
      created = await withCfg(somoRentalCfg, async () => executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
        channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
        transportBody: { ...quoteBody, quote_provenance: q.body.quote_provenance },
        trustedLocationId: LOC,
        actorHints: { email: 'staff@test.com' },
        now: FIXED_NOW,
      }).command));
    } catch (_) {
      threw = true;
    }
    assert(
      'L6 insert failure fails closed (no partial write)',
      threw || (created && created.ok === false),
      JSON.stringify(created && created.body),
    );
    assert('L6 zero persisted bookings', pg.persistedBookings.length === 0);
    assert('L6 zero persisted services', pg.persistedServices.length === 0);
    assert(
      'L6 zero persisted amounts + COMMIT not called',
      Object.keys(pg.persistedAmounts).length === 0 && pg.committed !== true,
      JSON.stringify({ amounts: pg.persistedAmounts, committed: pg.committed, rolledBack: pg.rolledBack }),
    );
  }

  // L7: client amount fields do not influence writes
  {
    const quoteBody = staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1, unit_amount_cents: 1, total_cents: 1 }],
      components: {},
      total_cents: 1,
    });
    const pg = makePg(rentalPgOpts);
    const created = await withCfg(somoRentalCfg, async () => executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
      channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
      transportBody: quoteBody,
      trustedLocationId: LOC,
      actorHints: { email: 'staff@test.com' },
      now: FIXED_NOW,
    }).command));
    assert(
      'L7 client money rejected or ignored (never €1 write)',
      (created.ok === false)
        || (created.ok === true && created.body.total_cents === BOARD_1D && sumAmounts(pg) === BOARD_1D),
      JSON.stringify(created.body),
    );
    if (created.ok) {
      assert('L7 not client amount', created.body.total_cents !== 1 && sumAmounts(pg) !== 1);
    }
  }

  // L8: legacy create without rentals[] remains green
  {
    const legacyBody = {
      guest_name: 'Legacy Board',
      guest_phone: '+34600111222',
      surfer_count: 1,
      date_from: SATURDAY,
      date_to: SATURDAY,
      service_dates: [SATURDAY],
      payment_status: 'unpaid',
      components: { surfboard: { quantity: 1 } },
    };
    const pg = makePg(rentalPgOpts);
    const created = await withCfg(somoRentalCfg, async () => executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
      channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
      transportBody: legacyBody,
      trustedLocationId: LOC,
      actorHints: { email: 'staff@test.com' },
      now: FIXED_NOW,
    }).command));
    assert('L8 legacy create ok', created.ok === true, JSON.stringify(created.body));
    assert('L8 legacy surfboard row', serviceInserts(pg).some((r) => r.params[4] === 'surfboard'));
    assert('L8 legacy priced', created.body.total_cents === BOARD_1D, String(created.body.total_cents));
  }

  // L9: rental + full-day add-on cannot commit without authoritative quote line
  {
    const addonCfg = rentalPrices([
      rentalRow('board_and_suit_rental__1_day', BUNDLE_1D),
      rentalRow('board_rental__1_day', BOARD_1D),
      rentalRow('wetsuit_rental__1_day', WETSUIT_1D),
      rentalRow('board_rental__3_days', BOARD_3D),
      {
        id: 'price-fullday',
        category: 'rental',
        offering_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
        item_code: FULL_DAY_EQUIPMENT_ADDON_KEY,
        amount_cents: 1000,
        unit: 'day',
        active: true,
        currency: 'EUR',
        location_id: LOC,
      },
    ]);
    const quoteBody = staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
      components: {
        [FULL_DAY_EQUIPMENT_ADDON_KEY]: {
          enabled: true,
          dates: { [SATURDAY]: 1 },
        },
      },
    });
    const pg = makePg(rentalPgOpts);
    const created = await withCfg(addonCfg, async () => executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
      channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
      transportBody: quoteBody,
      trustedLocationId: LOC,
      actorHints: { email: 'staff@test.com' },
      now: FIXED_NOW,
    }).command));
    assert('L9 rental+addon blocked without quote line', created.ok === false, JSON.stringify(created.body));
    assert('L9 zero persisted bookings', pg.persistedBookings.length === 0);
    assert('L9 zero persisted services', pg.persistedServices.length === 0);
    assert('L9 COMMIT not called', pg.committed !== true);
  }

  // L10: rental + unquoted legacy lesson cannot commit
  {
    const quoteBody = staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
      components: {
        lesson: { quantity: 1, slot_time: '09:30' },
      },
    });
    const pg = makePg(rentalPgOpts);
    const created = await withCfg(somoRentalCfg, async () => executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
      channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
      transportBody: quoteBody,
      trustedLocationId: LOC,
      actorHints: { email: 'staff@test.com' },
      now: FIXED_NOW,
    }).command));
    assert('L10 rental+lesson blocked', created.ok === false, JSON.stringify(created.body));
    assert('L10 zero persisted rows', pg.persistedBookings.length === 0 && pg.persistedServices.length === 0);
    assert('L10 COMMIT not called', pg.committed !== true);
  }

  // L11–L14: applyAuthoritativeQuoteAmounts accounting unit proofs
  {
    const pg = makePg(rentalPgOpts);
    await pg.query('BEGIN');
    pg.seedServiceRecord('sr-board', 'sunset');
    pg.seedServiceRecord('sr-suit', 'sunset');
    pg.seedServiceRecord('sr-extra', 'sunset');
    pg.seedServiceRecord('sr-dup', 'sunset');
    const quoteBody = {
      total_cents: BUNDLE_1D,
      line_items: [{
        component: 'board_and_suit_rental',
        offering_id: 'board_and_suit_rental__1_day',
        total_cents: BUNDLE_1D,
        unit_amount_cents: BUNDLE_1D,
        quantity: 1,
      }],
    };
    const boardRow = {
      service_record_id: 'sr-board',
      id: 'sr-board',
      service_type: 'surfboard',
      service_date: SATURDAY,
      metadata: {
        offering_key: 'board_and_suit_rental',
        component: 'surfboard',
        bundle_part: 'surfboard',
      },
    };
    const suitRow = {
      service_record_id: 'sr-suit',
      id: 'sr-suit',
      service_type: 'wetsuit',
      service_date: SATURDAY,
      metadata: {
        offering_key: 'board_and_suit_rental',
        component: 'wetsuit',
        bundle_part: 'wetsuit',
      },
    };
    // Seed txn-local ids so UPDATE amount path works
    pg.writes.length = 0;
    const okApply = await applyAuthoritativeQuoteAmounts(pg, [boardRow, suitRow], quoteBody, { clientSlug: 'sunset' });
    assert('L11 bundle apply ok with exact parity', okApply.ok === true && okApply.total_cents === BUNDLE_1D, JSON.stringify(okApply));

    const extra = await applyAuthoritativeQuoteAmounts(pg, [boardRow, suitRow, {
      service_record_id: 'sr-extra',
      id: 'sr-extra',
      service_type: 'lesson',
      service_date: SATURDAY,
      metadata: { component: 'lesson' },
    }], quoteBody, { clientSlug: 'sunset' });
    assert('L12 unexpected extra row rejected', extra.ok === false && /unclaimed_service_row/.test(String(extra.error)), JSON.stringify(extra));

    const missing = await applyAuthoritativeQuoteAmounts(pg, [boardRow], {
      total_cents: BUNDLE_1D + BOARD_1D,
      line_items: [
        { component: 'board_and_suit_rental', total_cents: BUNDLE_1D },
        { component: 'board_rental', total_cents: BOARD_1D },
      ],
    }, { clientSlug: 'sunset' });
    assert('L13 missing row for quote line rejected', missing.ok === false && /no_operational_rows_for_board_rental/.test(String(missing.error)), JSON.stringify(missing));

    const dup = await applyAuthoritativeQuoteAmounts(pg, [{
      service_record_id: 'sr-dup',
      id: 'sr-dup',
      service_type: 'surfboard',
      service_date: SATURDAY,
      metadata: { offering_key: 'board_and_suit_rental', component: 'surfboard', bundle_part: 'surfboard' },
    }], {
      total_cents: BUNDLE_1D * 2,
      line_items: [
        { component: 'board_and_suit_rental', total_cents: BUNDLE_1D },
        { component: 'board_and_suit_rental', total_cents: BUNDLE_1D },
      ],
    }, { clientSlug: 'sunset' });
    assert('L14 duplicate row claim rejected', dup.ok === false && dup.error === 'duplicate_row_claim', JSON.stringify(dup));
    await pg.query('ROLLBACK');
  }

  // L15: course+bundle persisted amount sum equals quote (already covered in L4; reinforce via direct apply)
  {
    const pg = makePg(rentalPgOpts);
    await pg.query('BEGIN');
    pg.seedServiceRecord('sr-course', 'sunset');
    pg.seedServiceRecord('sr-board', 'sunset');
    pg.seedServiceRecord('sr-suit', 'sunset');
    const quoteBody = {
      total_cents: AMOUNT + BUNDLE_1D,
      line_items: [
        {
          component: 'course',
          offering_id: ITEM,
          total_cents: AMOUNT,
          unit_amount_cents: AMOUNT,
          quantity: 1,
        },
        {
          component: 'board_and_suit_rental',
          offering_id: 'board_and_suit_rental__1_day',
          total_cents: BUNDLE_1D,
          unit_amount_cents: BUNDLE_1D,
          quantity: 1,
        },
      ],
    };
    const rows = [
      {
        service_record_id: 'sr-course',
        id: 'sr-course',
        service_type: 'course',
        service_date: SATURDAY,
        metadata: { component: 'course' },
      },
      {
        service_record_id: 'sr-board',
        id: 'sr-board',
        service_type: 'surfboard',
        service_date: SATURDAY,
        metadata: { offering_key: 'board_and_suit_rental', component: 'surfboard', bundle_part: 'surfboard' },
      },
      {
        service_record_id: 'sr-suit',
        id: 'sr-suit',
        service_type: 'wetsuit',
        service_date: SATURDAY,
        metadata: { offering_key: 'board_and_suit_rental', component: 'wetsuit', bundle_part: 'wetsuit' },
      },
    ];
    const applied = await applyAuthoritativeQuoteAmounts(pg, rows, quoteBody, { clientSlug: 'sunset' });
    assert(
      'L15 applied + persisted sums equal quote total',
      applied.ok === true
        && applied.total_cents === quoteBody.total_cents
        && applied.applied_line_total_cents === quoteBody.total_cents,
      JSON.stringify(applied),
    );
    await pg.query('ROLLBACK');
  }

  // L16: missing service-record ID → amount UPDATE rowCount 0 → rollback, zero persisted
  {
    const quoteBody = staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {},
    });
    const qPg = makePg(rentalPgOpts);
    const q = await withCfg(somoRentalCfg, async () => executeSunsetQuote(
      qPg,
      buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, quoteBody).command,
      { adminCfg: somoRentalCfg },
    ));
    const pg = makePg({ ...rentalPgOpts, ghostServiceInsert: true });
    const created = await withCfg(somoRentalCfg, async () => executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
      channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
      transportBody: { ...quoteBody, quote_provenance: q.body.quote_provenance },
      trustedLocationId: LOC,
      actorHints: { email: 'staff@test.com' },
      now: FIXED_NOW,
    }).command));
    assert('L16 missing service id blocked', created.ok === false, JSON.stringify(created.body));
    assert(
      'L16 reason service_amount_update_mismatch',
      /service_amount_update_mismatch/.test(JSON.stringify(created.body)),
      JSON.stringify(created.body),
    );
    assert('L16 zero persisted bookings', pg.persistedBookings.length === 0);
    assert('L16 zero persisted services', pg.persistedServices.length === 0);
    assert(
      'L16 zero persisted amounts + no COMMIT',
      Object.keys(pg.persistedAmounts).length === 0 && pg.committed !== true,
      JSON.stringify({ amounts: pg.persistedAmounts, committed: pg.committed }),
    );
  }

  // L17: wrong service client_slug → amount UPDATE rowCount 0 → rollback
  {
    const quoteBody = staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {},
    });
    const qPg = makePg(rentalPgOpts);
    const q = await withCfg(somoRentalCfg, async () => executeSunsetQuote(
      qPg,
      buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, quoteBody).command,
      { adminCfg: somoRentalCfg },
    ));
    const pg = makePg({ ...rentalPgOpts, forceServiceClientSlug: 'other-tenant' });
    const created = await withCfg(somoRentalCfg, async () => executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
      channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
      transportBody: { ...quoteBody, quote_provenance: q.body.quote_provenance },
      trustedLocationId: LOC,
      actorHints: { email: 'staff@test.com' },
      now: FIXED_NOW,
    }).command));
    assert('L17 wrong service client_slug blocked', created.ok === false, JSON.stringify(created.body));
    assert(
      'L17 reason service_amount_update_mismatch',
      /service_amount_update_mismatch/.test(JSON.stringify(created.body)),
      JSON.stringify(created.body),
    );
    assert('L17 zero persisted state', pg.persistedBookings.length === 0 && pg.persistedServices.length === 0);
    assert('L17 COMMIT not called', pg.committed !== true);
  }

  // L18: missing booking ID → header UPDATE rowCount 0 → rollback
  {
    const quoteBody = staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {},
    });
    const qPg = makePg(rentalPgOpts);
    const q = await withCfg(somoRentalCfg, async () => executeSunsetQuote(
      qPg,
      buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, quoteBody).command,
      { adminCfg: somoRentalCfg },
    ));
    const pg = makePg({ ...rentalPgOpts, ghostBookingInsert: true });
    const created = await withCfg(somoRentalCfg, async () => executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
      channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
      transportBody: { ...quoteBody, quote_provenance: q.body.quote_provenance },
      trustedLocationId: LOC,
      actorHints: { email: 'staff@test.com' },
      now: FIXED_NOW,
    }).command));
    assert('L18 missing booking id blocked', created.ok === false, JSON.stringify(created.body));
    assert(
      'L18 reason booking_total_update_mismatch',
      /booking_total_update_mismatch/.test(JSON.stringify(created.body)),
      JSON.stringify(created.body),
    );
    assert('L18 zero persisted bookings', pg.persistedBookings.length === 0);
    assert('L18 zero persisted services', pg.persistedServices.length === 0);
    assert('L18 COMMIT not called', pg.committed !== true);
  }

  // L19: wrong booking client_id → header UPDATE rowCount 0 → rollback
  {
    const quoteBody = staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {},
    });
    const qPg = makePg(rentalPgOpts);
    const q = await withCfg(somoRentalCfg, async () => executeSunsetQuote(
      qPg,
      buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, quoteBody).command,
      { adminCfg: somoRentalCfg },
    ));
    const pg = makePg({ ...rentalPgOpts, forceBookingClientId: 'other-client' });
    const created = await withCfg(somoRentalCfg, async () => executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
      channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
      transportBody: { ...quoteBody, quote_provenance: q.body.quote_provenance },
      trustedLocationId: LOC,
      actorHints: { email: 'staff@test.com' },
      now: FIXED_NOW,
    }).command));
    assert('L19 wrong booking client_id blocked', created.ok === false, JSON.stringify(created.body));
    assert(
      'L19 reason booking_total_update_mismatch',
      /booking_total_update_mismatch/.test(JSON.stringify(created.body)),
      JSON.stringify(created.body),
    );
    assert('L19 zero persisted bookings', pg.persistedBookings.length === 0);
    assert('L19 zero persisted services', pg.persistedServices.length === 0);
    assert('L19 COMMIT not called', pg.committed !== true);
  }

  // L20: course + bundle still commits with exact quote/service/header parity
  {
    const quoteBody = staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: { course: { quantity: 1, course_id: PACK_ID, tier_key: TIER } },
    });
    const pg = makePg(rentalPgOpts);
    let quoteTotal = null;
    const created = await withCfg(somoRentalCfg, async () => {
      const q = await executeSunsetQuote(pg, buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, quoteBody).command, { adminCfg: somoRentalCfg });
      quoteTotal = q.ok ? q.body.total_cents : null;
      return executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
        channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
        transportBody: { ...quoteBody, quote_provenance: q.body.quote_provenance },
        trustedLocationId: LOC,
        actorHints: { email: 'staff@test.com' },
        now: FIXED_NOW,
      }).command);
    });
    const expected = AMOUNT + BUNDLE_1D;
    assert('L20 course+bundle create ok', created.ok === true, JSON.stringify(created.body));
    assert('L20 quote/service/header parity',
      quoteTotal === expected
        && created.body.total_cents === expected
        && sumAmounts(pg) === expected
        && Number(pg.persistedBookingTotals['booking-uuid-1']) === expected
        && pg.committed === true,
      JSON.stringify({
        quoteTotal,
        body: created.body.total_cents,
        services: sumAmounts(pg),
        header: pg.persistedBookingTotals,
        committed: pg.committed,
      }),
    );
  }

  console.log(`\n── verify:luna-front-desk-quote-service ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(2); });
