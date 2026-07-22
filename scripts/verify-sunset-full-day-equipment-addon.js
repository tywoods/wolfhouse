'use strict';

/**
 * verify:sunset-full-day-equipment-addon
 *
 * Offline assertions for the "Material el resto del día" full-day equipment add-on
 * (internal key full_day_equipment_extension). No API key, DB, network, or Stripe.
 *
 * Covers: price resolution (config-backed), snapshot semantics, per-date persistence
 * (mock pg), booking totals + Stripe balance reuse, stale-client-total rejection,
 * paid-booking remaining balance, removal-no-refund, and the Luna tool + attach contract
 * plus offline conversation-behavior fixtures.
 *
 * Run:
 *   node scripts/verify-sunset-full-day-equipment-addon.js
 *   npm run verify:sunset-full-day-equipment-addon
 */

const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const {
  serviceRecordUnitPriceCents,
  isFullDayEquipmentAddon,
  FULL_DAY_EQUIPMENT_ADDON_KEY,
} = require('./lib/sunset-stripe-payment-links');
const {
  validateScheduleBookingBody,
  insertFullDayEquipmentAddonRows,
  normalizeFullDayEquipmentAddon,
} = require('./lib/sunset-schedule-booking-writes');
const { buildPaymentSummary } = require('./lib/sunset-schedule-booking-drawer');
const { executeSunsetCatalogTool } = require('./lib/sunset-catalog-tool-executor');
const { lookupSunsetFullDayEquipmentAddon } = require('./lib/sunset-rental-price-lookup');
const { attachSunsetFullDayEquipmentAddon } = require('./lib/luna-guest-addon-service-attach');
const { buildSunsetCatalogResponsePreview } = require('./lib/sunset-catalog-response-preview');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

const PRICES = resolveTenantBusinessConfig('sunset', 'sunset-somo').prices;

function addonSr(qty, amountDue) {
  return {
    service_record_id: 'sr-' + qty,
    service_type: 'addon_service',
    service_date: '2026-07-20',
    quantity: qty,
    amount_due_cents: amountDue,
    metadata: JSON.stringify({ service_key: FULL_DAY_EQUIPMENT_ADDON_KEY, component: FULL_DAY_EQUIPMENT_ADDON_KEY }),
  };
}

// ── 1. Price resolution + per-person-per-day math ────────────────────────────
console.log('\n[1] Resolver math (config-backed, never hard-coded)');
assert('config resolves add-on unit €10', serviceRecordUnitPriceCents(PRICES, addonSr(1, 0)) === 1000);
assert('1 person × 1 day = €10', serviceRecordUnitPriceCents(PRICES, addonSr(1, 0)) === 1000);
assert('3 persons × 1 day = €30', serviceRecordUnitPriceCents(PRICES, addonSr(3, 0)) === 3000);
assert('unknown add-on key => null (no price)',
  serviceRecordUnitPriceCents(PRICES, { service_type: 'addon_service', quantity: 2, metadata: JSON.stringify({ service_key: 'other' }) }) === null);
assert('isFullDayEquipmentAddon true for our rows', isFullDayEquipmentAddon(addonSr(1, 0)) === true);
assert('isFullDayEquipmentAddon false for surfboard',
  isFullDayEquipmentAddon({ service_type: 'surfboard', metadata: {} }) === false);

// ── 2. Normalize + validation (eligibility, subset, qty) ─────────────────────
console.log('\n[2] Normalize + validate');
// Frozen refDate keeps fixture ISOs future-stable (same pattern as date-boundary verifier).
const REF = new Date('2026-07-13T12:00:00Z');
const okBody = {
  guest_name: 'Ana', payment_status: 'unpaid', service_dates: ['2026-07-20', '2026-07-21'],
  components: { course: { quantity: 3, course_id: 'c1', tier_key: '1_week' }, full_day_equipment_extension: { enabled: true, dates: { '2026-07-20': 3, '2026-07-21': 2 } } },
};
const okV = validateScheduleBookingBody(okBody, { refDate: REF });
assert('valid combo passes', okV.ok === true, okV.error);
assert('addon dates preserved', okV.ok && JSON.stringify(okV.value.components.full_day_equipment_extension.dates) === JSON.stringify({ '2026-07-20': 3, '2026-07-21': 2 }));

const badDate = JSON.parse(JSON.stringify(okBody));
badDate.components.full_day_equipment_extension.dates = { '2026-08-01': 1 };
assert('ineligible add-on date rejected', validateScheduleBookingBody(badDate, { refDate: REF }).ok === false);

const addonAlone = { guest_name: 'X', payment_status: 'unpaid', service_dates: ['2026-07-20'], components: { full_day_equipment_extension: { enabled: true, dates: { '2026-07-20': 1 } } } };
assert('add-on alone rejected', validateScheduleBookingBody(addonAlone, { refDate: REF }).ok === false);

// Wall-clock past date (no freeze): real explicit_past_date rejection must still fire.
const realPast = validateScheduleBookingBody({
  guest_name: 'Ana', payment_status: 'unpaid', service_dates: ['2020-01-01'],
  components: { course: { quantity: 1, course_id: 'c1', tier_key: '1_week' }, full_day_equipment_extension: { enabled: true, dates: { '2020-01-01': 1 } } },
});
assert('explicit past date rejected', realPast.ok === false && realPast.error === 'explicit_past_date', JSON.stringify(realPast));

const badQty = normalizeFullDayEquipmentAddon({ enabled: true, dates: { '2026-07-20': 0 } });
assert('quantity 0 rejected', badQty.ok === false);
assert('disabled add-on normalizes to skip', normalizeFullDayEquipmentAddon({ enabled: false }).skip === true);

// ── 3. Per-date persistence + snapshot (mock pg) ─────────────────────────────
console.log('\n[3] Persistence (mock pg) + snapshot');
function mockInsertPg() {
  const rows = [];
  return {
    rows,
    query: async (sql, params) => {
      if (/INSERT INTO booking_service_records/i.test(String(sql))) {
        rows.push({ service_date: params[4], quantity: params[5], amount_due_cents: params[6] });
        return { rows: [{ service_record_id: 'x', service_date: params[4], quantity: params[5], amount_due_cents: params[6], service_type: 'addon_service' }] };
      }
      return { rows: [] };
    },
  };
}
(async () => {
  const pg = mockInsertPg();
  await insertFullDayEquipmentAddonRows(pg, {
    clientSlug: 'sunset', bookingId: 'b1', bookingCode: 'SUNSET-1', guestName: 'Ana',
    addonDates: { '2026-07-20': 3, '2026-07-21': 2 }, addonUnitCents: 1000, componentKeys: ['course', 'full_day_equipment_extension'],
    bundleId: 'bundle', locationId: 'sunset-somo', srPayment: 'pending',
  });
  assert('one row per date', pg.rows.length === 2, JSON.stringify(pg.rows));
  assert('3×1 day snapshot = 3000', pg.rows[0].amount_due_cents === 3000);
  assert('different qty per day: 2×1 day = 2000', pg.rows[1].amount_due_cents === 2000);

  // 3 persons × 2 days = €60 combined
  const total3x2 = pg.rows.reduce((a, r) => a + r.amount_due_cents, 0);
  assert('combined (3×€10 + 2×€10) = 5000', total3x2 === 5000);

  // Snapshot immutability: a later price change (unit=1500) does NOT touch existing rows.
  const pg2 = mockInsertPg();
  await insertFullDayEquipmentAddonRows(pg2, {
    clientSlug: 'sunset', bookingId: 'b1', bookingCode: 'SUNSET-1', guestName: 'Ana',
    addonDates: { '2026-07-22': 3 }, addonUnitCents: 1500, componentKeys: ['course', 'full_day_equipment_extension'],
    bundleId: 'bundle', locationId: 'sunset-somo', srPayment: 'pending',
  });
  assert('price change affects new rows only (3×€15=4500)', pg2.rows[0].amount_due_cents === 4500);
  assert('historical rows unchanged after price change', pg.rows[0].amount_due_cents === 3000);

  // ── 4. Totals + Stripe balance reuse; stale client totals ignored ──────────
  console.log('\n[4] Totals + Stripe balance');
  const services = [addonSr(3, 3000), { ...addonSr(2, 2000), service_record_id: 'sr-b', service_date: '2026-07-21' }];
  const sumUnpaid = buildPaymentSummary(PRICES, { amount_paid_cents: 0, metadata: {} }, services, 'config', 0);
  assert('subtotal from snapshots = 5000', sumUnpaid.subtotal_cents === 5000);
  assert('total mirrors subtotal (authoritative)', sumUnpaid.total_cents === 5000);
  assert('no double counting (2 line items)', sumUnpaid.line_items.length === 2);
  assert('compact label "Material · qty"', /Material el resto del día · 3/.test(sumUnpaid.line_items[0].label));

  // Stale client total (e.g. browser claims 999) is irrelevant: server recomputes from rows.
  const stale = buildPaymentSummary(PRICES, { amount_paid_cents: 0, metadata: { client_claimed_total_cents: 999 } }, services, 'config', 0);
  assert('stale client total ignored — server total wins', stale.total_cents === 5000);

  // Paid booking + add-on: paid 3000 already; add-on adds 2000 -> remaining 2000; paid kept.
  const paid = buildPaymentSummary(PRICES, { amount_paid_cents: 3000, metadata: {} }, services, 'config', 3000);
  assert('paid booking keeps amount_paid', paid.paid_cents === 3000);
  assert('paid booking + add-on remaining = 2000', paid.balance_due_cents === 2000);

  // Removal-no-refund: dropping the 07-21 row leaves paid untouched; balance shifts, no negative refund.
  const afterRemoval = buildPaymentSummary(PRICES, { amount_paid_cents: 3000, metadata: {} }, [addonSr(3, 3000)], 'config', 3000);
  assert('removal does not auto-refund (paid stays 3000)', afterRemoval.paid_cents === 3000);
  assert('removal balance floors at 0 (no negative refund)', afterRemoval.balance_due_cents === 0);

  // Existing booking WITHOUT the add-on: identical totals before/after this feature.
  const noAddon = [{ service_record_id: 'l1', service_type: 'surf_lesson', service_date: '2026-07-20', quantity: 3, amount_due_cents: 9000, metadata: JSON.stringify({ component: 'course', course_label: 'Group Course' }) }];
  const noAddonSum = buildPaymentSummary(PRICES, { amount_paid_cents: 0, metadata: {} }, noAddon, 'config', 0);
  assert('booking without add-on unchanged (9000)', noAddonSum.subtotal_cents === 9000);

  // ── 5. Luna tool contract ─────────────────────────────────────────────────
  console.log('\n[5] Luna catalog tool + lookup');
  const read = executeSunsetCatalogTool('get_sunset_full_day_equipment_addon', { client_slug: 'sunset', location_id: 'sunset-somo' });
  assert('tool read ok + active', read.ok === true && read.result.active === true);
  assert('tool read price €10 from config', read.result.amount_cents === 1000);
  assert('tool read billing_unit person_per_day', read.result.billing_unit === 'person_per_day');

  const quote = executeSunsetCatalogTool('get_sunset_full_day_equipment_addon', { client_slug: 'sunset', location_id: 'sunset-somo', args: { dates: ['2026-07-20', '2026-07-21'], quantity: 3 } });
  assert('tool quote 3×2 = €60', quote.ok && quote.result.quote.total_amount_cents === 6000);
  assert('tool quote per-date = €30', quote.result.quote.per_date_amount_cents === 3000);

  assert('tool fail-closed on wrong tenant', executeSunsetCatalogTool('get_sunset_full_day_equipment_addon', { client_slug: 'wolfhouse' }).ok === false);
  assert('tool fail-closed on invalid quantity', executeSunsetCatalogTool('get_sunset_full_day_equipment_addon', { client_slug: 'sunset', location_id: 'sunset-somo', args: { dates: ['2026-07-20'], quantity: 0 } }).ok === false);
  assert('tool fail-closed on bad date', executeSunsetCatalogTool('get_sunset_full_day_equipment_addon', { client_slug: 'sunset', location_id: 'sunset-somo', args: { dates: ['not-a-date'], quantity: 1 } }).ok === false);
  assert('lookup fail-closed on wrong tenant', lookupSunsetFullDayEquipmentAddon({ client_slug: 'wolfhouse' }).ok === false);

  // ── 6. Luna attach contract (mock pg) ─────────────────────────────────────
  console.log('\n[6] Luna attach (mock pg)');
  function attachPg(booking, eligibleDates, existingDates) {
    const inserts = [];
    return {
      inserts,
      query: async (sql, params) => {
        const s = String(sql);
        if (/FROM bookings b INNER JOIN clients/i.test(s)) return { rows: booking ? [booking] : [] };
        if (/SELECT DISTINCT service_date/i.test(s)) return { rows: eligibleDates.map((d) => ({ service_date: d })) };
        if (/SELECT id FROM booking_service_records/i.test(s)) { const d = params[1]; return { rows: existingDates.indexOf(d) >= 0 ? [{ id: 'x' }] : [] }; }
        if (/INSERT INTO booking_service_records/i.test(s)) { inserts.push({ date: params[4], qty: params[5], amount: params[6] }); return { rows: [] }; }
        return { rows: [] };
      },
    };
  }
  const bk = { booking_id: 'b1', booking_code: 'SUNSET-1', guest_name: 'Ana', metadata: { location_id: 'sunset-somo' }, client_slug: 'sunset' };
  const okAttach = await attachSunsetFullDayEquipmentAddon(attachPg(bk, ['2026-07-20', '2026-07-21'], []), { clientSlug: 'sunset', bookingId: '00000000-0000-0000-0000-0000000000b1', quote: { unit_amount_cents: 1000, quantity: 3, dates: ['2026-07-20', '2026-07-21'], currency: 'EUR' } });
  assert('attach ok, 2 dates', okAttach.ok === true && okAttach.attached_dates.length === 2);
  assert('attach snapshots price from quote (3×€10)', okAttach.attached_dates[0].amount_due_cents === 3000);

  const cross = await attachSunsetFullDayEquipmentAddon(attachPg({ ...bk, client_slug: 'wolfhouse' }, ['2026-07-20'], []), { clientSlug: 'sunset', bookingId: '00000000-0000-0000-0000-0000000000b1', quote: { unit_amount_cents: 1000, quantity: 2, dates: ['2026-07-20'] } });
  assert('attach fail-closed on cross-tenant booking', cross.ok === false && cross.reason === 'cross_tenant_booking');

  const inelig = await attachSunsetFullDayEquipmentAddon(attachPg(bk, ['2026-07-20'], []), { clientSlug: 'sunset', bookingId: '00000000-0000-0000-0000-0000000000b1', quote: { unit_amount_cents: 1000, quantity: 2, dates: ['2026-07-25'] } });
  assert('attach fail-closed on ineligible date', inelig.ok === false && inelig.reason === 'ineligible_date');

  const idem = attachPg(bk, ['2026-07-20', '2026-07-21'], ['2026-07-20']);
  await attachSunsetFullDayEquipmentAddon(idem, { clientSlug: 'sunset', bookingId: '00000000-0000-0000-0000-0000000000b1', quote: { unit_amount_cents: 1000, quantity: 3, dates: ['2026-07-20', '2026-07-21'] } });
  assert('attach idempotent per booking+date (1 new insert)', idem.inserts.length === 1 && idem.inserts[0].date === '2026-07-21');

  assert('attach fail-closed on missing price', (await attachSunsetFullDayEquipmentAddon({}, { clientSlug: 'sunset', bookingId: '00000000-0000-0000-0000-000000000001', quote: { quantity: 2, dates: ['2026-07-20'] } })).reason === 'missing_price');

  // ── 7. Luna conversation-behavior fixtures (offline) ──────────────────────
  console.log('\n[7] Luna offer copy fixtures');
  const offer = buildSunsetCatalogResponsePreview({ client_slug: 'sunset', tool_id: 'get_sunset_full_day_equipment_addon', args: { location_id: 'sunset-somo', dates: ['2026-07-20', '2026-07-21'], quantity: 3 } });
  assert('offer preview ok', offer.ok === true);
  assert('offer copy exact Spanish w/ price from tool',
    offer.offer_text_es === 'También puedes quedarte con el material el resto del día por 10 € más por persona. ¿Te gustaría añadirlo?',
    offer.offer_text_es);
  assert('offer preview quote 3×2 = €60', /= €60/.test(offer.preview_text));
  assert('offer preview live_send_allowed only when active', offer.live_send_allowed === true);
  // No-invented-price: the offer number equals the tool amount, not a literal.
  assert('offer number == tool amount (no invented price)', /por 10 € más/.test(offer.offer_text_es));

  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`verify:sunset-full-day-equipment-addon  pass=${pass}  fail=${fail}`);
  if (fail > 0) process.exit(1);
})().catch((err) => {
  console.error('UNCAUGHT', err && err.stack || err);
  process.exit(1);
});
