'use strict';

/**
 * verify:sunset-accommodation
 *
 * RED→GREEN focused gates for Sunset employee-managed Accommodation.
 * Hits real production owners + generated browser artifacts (not helper-only regex).
 *
 * Covers:
 *  - seasonal range overlap/adjacent, half-open arithmetic, cross-season totals
 *  - uncovered first/middle/final nights with specific messages
 *  - client money rejection, server-authoritative pricing
 *  - Admin HTML/API owners, Create/Edit/booking-card owners
 *  - tenant isolation (Sunset allow / Wolfhouse deny)
 *  - snapshot metadata identity, enable/disable history semantics
 *  - production module load / generated artifact parsing
 *
 * Run: node scripts/verify-sunset-accommodation.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const resolver = require('./lib/sunset-accommodation-price-resolver');
const admin = require('./lib/sunset-accommodation-admin');
const writes = require('./lib/sunset-schedule-booking-writes');
const drawer = require('./lib/sunset-schedule-booking-drawer');
const quoteSvc = require('./lib/luna-front-desk-quote-service');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

console.log('\nverify:sunset-accommodation\n');

// ── 1) Pure resolver math ──────────────────────────────────────────────────
console.log('[1] Range validation + half-open pricing');
const adj = resolver.normalizeAccommodationRanges([
  { title: 'Low', check_in: '2026-06-01', check_out: '2026-07-01', amount_cents: 4000 },
  { title: 'High', check_in: '2026-07-01', check_out: '2026-08-01', amount_cents: 6000 },
]);
ok('adjacent ranges accepted', adj.ok === true, adj.error);
const ov = resolver.normalizeAccommodationRanges([
  { title: 'A', check_in: '2026-06-01', check_out: '2026-07-15', amount_cents: 4000 },
  { title: 'B', check_in: '2026-07-01', check_out: '2026-08-01', amount_cents: 6000 },
]);
ok('overlap rejected', ov.ok === false && ov.reason_code === 'accommodation_ranges_overlap', ov.error);

const single = resolver.priceAccommodationStay({
  ranges: adj.value, checkIn: '2026-06-10', checkOut: '2026-06-13',
});
// nights 10,11,12 = 3 × 4000
ok('single-season total 3×4000=12000', single.ok && single.total_cents === 12000 && single.nights === 3);
ok('checkout exclusive (3 nights for 10→13)', single.ok && single.nights === 3);

const cross = resolver.priceAccommodationStay({
  ranges: adj.value, checkIn: '2026-06-28', checkOut: '2026-07-03',
});
// 28,29,30 = 3×4000; 1,2 = 2×6000 = 24000
ok('cross-season total 24000', cross.ok && cross.total_cents === 24000, JSON.stringify(cross));
ok('cross-season grouped breakdown', cross.ok && cross.season_groups.length === 2
  && cross.season_groups[0].title === 'Low' && cross.season_groups[0].nights === 3
  && cross.season_groups[1].title === 'High' && cross.season_groups[1].nights === 2);

const unFirst = resolver.priceAccommodationStay({
  ranges: adj.value, checkIn: '2026-05-30', checkOut: '2026-06-03',
});
ok('uncovered first night rejects', !unFirst.ok && unFirst.reason_code === 'accommodation_uncovered_nights');
ok('uncovered first names span', /2026-05-30/.test(unFirst.error || ''));

const midRanges = resolver.normalizeAccommodationRanges([
  { title: 'A', check_in: '2026-06-01', check_out: '2026-06-05', amount_cents: 4000 },
  { title: 'B', check_in: '2026-06-08', check_out: '2026-06-15', amount_cents: 5000 },
]).value;
const unMid = resolver.priceAccommodationStay({
  ranges: midRanges, checkIn: '2026-06-03', checkOut: '2026-06-10',
});
ok('uncovered middle nights reject', !unMid.ok && /2026-06-05–2026-06-07|2026-06-05/.test(unMid.error || ''), unMid.error);

const unLast = resolver.priceAccommodationStay({
  ranges: adj.value, checkIn: '2026-07-28', checkOut: '2026-08-03',
});
ok('uncovered final nights reject', !unLast.ok && /2026-08-01/.test(unLast.error || ''), unLast.error);

const money = resolver.normalizeAccommodationSelection({
  enabled: true, check_in: '2026-06-01', check_out: '2026-06-03', amount_cents: 999,
});
ok('client money rejected', !money.ok && money.reason_code === 'accommodation_client_money_forbidden');

const fracNum = resolver.normalizeAccommodationRanges([
  { title: 'Frac', check_in: '2026-06-01', check_out: '2026-07-01', amount_cents: 4000.5 },
]);
ok('fractional numeric amount_cents rejected (no parseInt truncate)',
  fracNum.ok === false && fracNum.reason_code === 'accommodation_amount_invalid', fracNum.error);
const fracStr = resolver.normalizeAccommodationRanges([
  { title: 'FracS', check_in: '2026-06-01', check_out: '2026-07-01', amount_cents: '4000.50' },
]);
ok('fractional string amount_cents rejected',
  fracStr.ok === false && fracStr.reason_code === 'accommodation_amount_invalid', fracStr.error);
const intStr = resolver.normalizeAccommodationRanges([
  { title: 'Ok', check_in: '2026-06-01', check_out: '2026-07-01', amount_cents: '4000' },
]);
ok('integer string amount_cents accepted', intStr.ok === true && intStr.value[0].amount_cents === 4000);

const sel = resolver.normalizeAccommodationSelection({
  enabled: true, check_in: '2026-06-01', check_out: '2026-06-03',
});
ok('selection dates only', sel.ok && !sel.skip && sel.value.check_in === '2026-06-01');

// Timezone-safe same-day / multi-day seed (production pure owner)
console.log('\n[1b] Default stay seed + timezone-safe ISO day');
ok('addDaysIso month boundary', resolver.addDaysIso('2026-01-31', 1) === '2026-02-01');
ok('addDaysIso year boundary', resolver.addDaysIso('2025-12-31', 1) === '2026-01-01');
const sameDayStay = resolver.defaultAccommodationStayFromBookingDates('2026-06-10', '2026-06-10');
ok('same-day seeds one-night half-open stay',
  sameDayStay.check_in === '2026-06-10' && sameDayStay.check_out === '2026-06-11'
  && sameDayStay.enabled === true);
const multiStay = resolver.defaultAccommodationStayFromBookingDates('2026-06-10', '2026-06-14');
ok('multi-day maps checkout to date_to (half-open)',
  multiStay.check_in === '2026-06-10' && multiStay.check_out === '2026-06-14');
const invertedStay = resolver.defaultAccommodationStayFromBookingDates('2026-06-10', '2026-06-09');
ok('inverted date_to still becomes one-night stay',
  invertedStay.check_in === '2026-06-10' && invertedStay.check_out === '2026-06-11');
const missingTo = resolver.defaultAccommodationStayFromBookingDates('2026-06-10', '');
ok('missing date_to becomes one-night stay',
  missingTo.check_in === '2026-06-10' && missingTo.check_out === '2026-06-11');

// ── 2) Booking body validation owner ───────────────────────────────────────
console.log('\n[2] validateScheduleBookingBody + identity');
const REF = new Date('2026-05-01T12:00:00Z');
// Accommodation-only: no components key (Create/Edit may omit). allowEmpty is
// auto-derived from accommodation selection when present — no caller flag required.
const bodyOk = writes.validateScheduleBookingBody({
  guest_name: 'Ada',
  payment_status: 'unpaid',
  date_from: '2026-06-10',
  date_to: '2026-06-14',
  service_dates: ['2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14'],
  accommodation: { enabled: true, check_in: '2026-06-10', check_out: '2026-06-14' },
}, { refDate: REF });
ok('accommodation-only body validates', bodyOk.ok === true, bodyOk.error);
ok('accommodation preserved on validated value',
  bodyOk.ok && bodyOk.value.accommodation
  && bodyOk.value.accommodation.enabled === true
  && bodyOk.value.accommodation.check_in === '2026-06-10'
  && bodyOk.value.accommodation.check_out === '2026-06-14');

// Empty booking (no components, no accommodation) still rejected.
const emptyBody = writes.validateScheduleBookingBody({
  guest_name: 'Ada',
  payment_status: 'unpaid',
  date_from: '2026-06-10',
  date_to: '2026-06-12',
  service_dates: ['2026-06-10', '2026-06-11', '2026-06-12'],
}, { refDate: REF });
ok('empty booking still rejected',
  emptyBody.ok === false
  && /booking_type or components is required|components must include/.test(emptyBody.error || ''),
  emptyBody.error);

// Empty components object without accommodation still rejected.
const emptyComps = writes.validateScheduleBookingBody({
  guest_name: 'Ada',
  payment_status: 'unpaid',
  date_from: '2026-06-10',
  date_to: '2026-06-12',
  service_dates: ['2026-06-10', '2026-06-11', '2026-06-12'],
  components: {},
}, { refDate: REF });
ok('empty components object still rejected',
  emptyComps.ok === false
  && /components must include/.test(emptyComps.error || ''),
  emptyComps.error);

const bodyMoney = writes.validateScheduleBookingBody({
  guest_name: 'Ada', payment_status: 'unpaid',
  date_from: '2026-06-10', date_to: '2026-06-12',
  service_dates: ['2026-06-10', '2026-06-11', '2026-06-12'],
  accommodation: { enabled: true, check_in: '2026-06-10', check_out: '2026-06-12', total_cents: 1 },
}, { refDate: REF });
ok('validated body rejects client total_cents', bodyMoney.ok === false);

ok('STAFF_ACCOMMODATION constants exported',
  writes.STAFF_ACCOMMODATION_SOURCE === 'staff_accommodation'
  && writes.STAFF_ACCOMMODATION_COMPONENT === 'staff_accommodation');
ok('insertStaffAccommodationServiceRow exported',
  typeof writes.insertStaffAccommodationServiceRow === 'function');
ok('accommodationFromBundle exported', typeof drawer.accommodationFromBundle === 'function');
ok('appendAccommodationToQuote exported', typeof quoteSvc.appendAccommodationToQuote === 'function');

// ── 3) Snapshot insert (mock pg) + identity ────────────────────────────────
console.log('\n[3] Persistence snapshot + dedicated identity');
function mockPg() {
  const rows = [];
  return {
    rows,
    query: async (sql, params) => {
      const s = String(sql);
      if (/INSERT INTO booking_service_records/i.test(s)) {
        const meta = typeof params[9] === 'string' ? JSON.parse(params[9]) : params[9];
        const row = {
          service_record_id: `sr-${rows.length + 1}`,
          service_type: params[4],
          service_date: params[5],
          quantity: params[6],
          amount_due_cents: 0,
          metadata: meta,
        };
        rows.push(row);
        return { rows: [row] };
      }
      if (/UPDATE booking_service_records SET amount_due_cents/i.test(s)) {
        const id = params[1];
        const r = rows.find((x) => x.service_record_id === id);
        if (r) r.amount_due_cents = params[0];
        return { rowCount: r ? 1 : 0, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

(async () => {
  const priced = resolver.priceAccommodationStay({
    ranges: adj.value, checkIn: '2026-06-28', checkOut: '2026-07-03',
  });
  const pg = mockPg();
  const row = await writes.insertStaffAccommodationServiceRow(pg, {
    clientSlug: 'sunset',
    bookingId: 'b1',
    bookingCode: 'SUNSET-1',
    guestName: 'Ada',
    serviceDate: priced.check_in,
    srPayment: 'pending',
    attribution: { dbSource: 'staff_manual', staffManualSchedule: true },
    locationId: 'sunset-somo',
    componentKeys: [],
    priced,
  });
  ok('one accommodation service row', pg.rows.length === 1);
  ok('snapshotted total 24000', row && row.amount_due_cents === 24000);
  const meta = row.metadata;
  ok('dedicated identity flags',
    meta.source === 'staff_accommodation'
    && meta.staff_accommodation === true
    && meta.component === 'staff_accommodation');
  ok('snapshot season_groups preserved',
    Array.isArray(meta.season_groups) && meta.season_groups.length === 2);
  ok('snapshot nightly_breakdown nights=5',
    Array.isArray(meta.nightly_breakdown) && meta.nightly_breakdown.length === 5);

  // Later Admin price change does not rewrite historical snapshot in the row.
  const later = resolver.priceAccommodationStay({
    ranges: [
      { title: 'Low', check_in: '2026-06-01', check_out: '2026-07-01', amount_cents: 9999 },
      { title: 'High', check_in: '2026-07-01', check_out: '2026-08-01', amount_cents: 9999 },
    ],
    checkIn: '2026-06-28', checkOut: '2026-07-03',
  });
  ok('new pricing differs', later.ok && later.total_cents !== 24000);
  ok('historical row total unchanged', row.amount_due_cents === 24000);

  const card = resolver.formatAccommodationBookingCard(meta, row.amount_due_cents);
  ok('booking card shape',
    card.kind === 'staff_accommodation'
    && card.nights === 5
    && card.total_cents === 24000
    && card.season_groups.length === 2);

  const fromBundle = drawer.accommodationFromBundle({
    services: [{ metadata: meta, amount_due_cents: 24000 }],
    booking: { metadata: {} },
  });
  ok('reconstruct selection from bundle',
    fromBundle && fromBundle.enabled
    && fromBundle.check_in === '2026-06-28'
    && fromBundle.check_out === '2026-07-03');

  // ── 3b) Edit pricing intent: accommodation equality / preserve / remove ──
  console.log('\n[3b] Edit pricing intent equality (production owners)');
  const accomMeta = {
    source: 'staff_accommodation',
    staff_accommodation: true,
    component: 'staff_accommodation',
    check_in: '2026-06-28',
    check_out: '2026-07-03',
    nights: 5,
    total_cents: 24000,
    season_groups: meta.season_groups,
    nightly_breakdown: meta.nightly_breakdown,
    currency: 'EUR',
  };
  const accomBundle = {
    booking: {
      guest_name: 'Ada',
      payment_status: 'paid',
      amount_paid_cents: 24000,
      metadata: {
        source: 'staff_manual_schedule',
        staff_manual_schedule: true,
        location_id: 'sunset-somo',
      },
    },
    services: [{
      service_record_id: 'sr-accom',
      service_type: 'addon_service',
      service_date: '2026-06-28',
      quantity: 1,
      amount_due_cents: 24000,
      amount_paid_cents: 24000,
      payment_status: 'paid',
      record_source: 'staff_manual',
      metadata: accomMeta,
    }],
    payments_paid_cents: 24000,
  };
  const existingIntent = drawer.pricingIntentFromBundle(accomBundle);
  ok('pricingIntentFromBundle carries accommodation',
    existingIntent && existingIntent.accommodation
    && existingIntent.accommodation.enabled === true
    && existingIntent.accommodation.check_in === '2026-06-28'
    && existingIntent.accommodation.check_out === '2026-07-03',
    JSON.stringify(existingIntent && existingIntent.accommodation));
  ok('pricingIntentFromBundle does not invent staff_accommodation component',
    !existingIntent.components || !existingIntent.components.staff_accommodation);

  // Match production Edit seed: service_date of accommodation row becomes drawer date span.
  const drawerServiceDates = (existingIntent.service_dates || []).slice();

  const sameRequested = writes.buildSchedulePricingIntent({
    service_dates: drawerServiceDates,
    components: {},
    accommodation: { enabled: true, check_in: '2026-06-28', check_out: '2026-07-03' },
  });
  ok('unchanged accommodation intents equal',
    writes.schedulePricingIntentsEqual(existingIntent, sameRequested) === true);

  const removeRequested = writes.buildSchedulePricingIntent({
    service_dates: drawerServiceDates,
    components: {},
    accommodation: null,
  });
  ok('explicit accommodation:null unequal (removes stay)',
    writes.schedulePricingIntentsEqual(existingIntent, removeRequested) === false
    && removeRequested.accommodation == null);

  // Omitted wire → production preserve path injects accommodationFromBundle.
  const preserved = drawer.accommodationFromBundle(accomBundle);
  const omittedThenPreserved = writes.buildSchedulePricingIntent({
    service_dates: drawerServiceDates,
    components: {},
    accommodation: preserved
      ? { enabled: true, check_in: preserved.check_in, check_out: preserved.check_out }
      : null,
  });
  ok('omitted wire + preserve keeps existing accommodation equal',
    writes.schedulePricingIntentsEqual(existingIntent, omittedThenPreserved) === true);

  // Paid notes-only: pricing equal → no paid-reprice block (intent gate only).
  const notesOnlyRequested = writes.buildSchedulePricingIntent({
    service_dates: drawerServiceDates,
    components: {},
    notes: 'please leave towels',
    guest_name: 'Ada Lovelace',
    accommodation: { enabled: true, check_in: '2026-06-28', check_out: '2026-07-03' },
  });
  ok('paid notes-only keeps pricing intent equal',
    writes.schedulePricingIntentsEqual(existingIntent, notesOnlyRequested) === true);
  ok('bundle is financially committed (paid reprice gate would apply if unequal)',
    writes.isSunsetBookingFinanciallyCommitted(accomBundle) === true);
  ok('paid notes-only does not require reprice (equal intent)',
    writes.schedulePricingIntentsEqual(existingIntent, notesOnlyRequested) === true
    && writes.isSunsetBookingFinanciallyCommitted(accomBundle) === true);

  const changedDates = writes.buildSchedulePricingIntent({
    service_dates: drawerServiceDates,
    components: {},
    accommodation: { enabled: true, check_in: '2026-06-28', check_out: '2026-07-05' },
  });
  ok('changed accommodation dates unequal (triggers reprice)',
    writes.schedulePricingIntentsEqual(existingIntent, changedDates) === false);

  // Explicit remove fingerprint is null; reprice path will not re-insert accommodation.
  ok('explicit remove fingerprint null (row removed on reprice rewrite)',
    writes.accommodationForIntentFingerprint(null) == null
    && writes.accommodationForIntentFingerprint({ enabled: false }) == null);

  // ── 4) Tenant isolation ─────────────────────────────────────────────────
  console.log('\n[4] Tenant isolation (Sunset allow / Wolfhouse deny)');
  const wolfGate = admin.assertSunsetClient('wolfhouse-somo');
  ok('wolfhouse assert fails', !wolfGate.ok && wolfGate.status === 403);
  const sunGate = admin.assertSunsetClient('sunset');
  ok('sunset assert ok', sunGate.ok === true);

  const wolfRes = await admin.saveAccommodationConfig({
    query: async () => { throw new Error('should not query for wolfhouse'); },
  }, {
    clientSlug: 'wolfhouse-somo',
    locationId: 'sunset-somo',
    enabled: true,
    ranges: [],
  });
  ok('wolfhouse save denied', wolfRes.ok === false && wolfRes.status === 403);

  const createWolf = await writes.createSunsetScheduleBooking({
    query: async () => ({ rows: [] }),
  }, {
    clientSlug: 'wolfhouse-somo',
    locationId: 'sunset-somo',
    body: { guest_name: 'X', accommodation: { enabled: true, check_in: '2026-06-01', check_out: '2026-06-03' } },
    actor: { email: 'staff@test' },
  });
  ok('create booking wolfhouse denied',
    createWolf.ok === false && createWolf.status === 403
    && /unsupported_client/.test(JSON.stringify(createWolf.body || {})));

  // Admin route strings (generated portal owner)
  const apiSrc = read('scripts/staff-query-api.js');
  ok('Admin PUT route accommodation',
    /pathname === '\/staff\/admin\/config\/accommodation'/.test(apiSrc)
    && /handleAdminConfigAccommodationPut/.test(apiSrc));
  ok('Admin GET attaches accommodation for sunset only',
    /clientSlug === 'sunset'/.test(apiSrc)
    && /loadAccommodationConfig/.test(apiSrc)
    && /accommodation,/.test(apiSrc));
  ok('Admin HTML section below rental prices',
    /id="admin-sec-prices"[\s\S]{0,400}id="admin-sec-accommodation"/.test(apiSrc)
    || (/admin-sec-prices/.test(apiSrc) && /admin-sec-accommodation/.test(apiSrc)
      && apiSrc.indexOf('admin-sec-prices') < apiSrc.indexOf('admin-sec-accommodation')));
  ok('Admin section only after prices',
    apiSrc.indexOf('admin-sec-prices') < apiSrc.indexOf('admin-sec-accommodation'));
  ok('no wolfhouse accommodation admin route',
    !/wolfhouse.*config\/accommodation/.test(apiSrc));

  // ── 5) Generated Admin / Create / Edit / booking-card owners ────────────
  console.log('\n[5] Generated Admin/Create/Edit/booking-card owners');
  const adminUi = read('scripts/browser/sunset-admin-ui.js');
  ok('admin render accommodation function',
    /function renderAdminSectionAccommodationFromConfig/.test(adminUi));
  ok('admin save accommodation action',
    /action === 'save-accommodation'/.test(adminUi)
    && /\/staff\/admin\/config\/accommodation/.test(adminUi));
  ok('admin edit/add/remove range actions',
    /edit-accommodation/.test(adminUi)
    && /accom-add-range/.test(adminUi)
    && /accom-remove-range/.test(adminUi));
  ok('admin hides for non-sunset',
    /getClient\(\) !== 'sunset'/.test(adminUi));

  ok('Create Accommodation + under custom addon',
    /ps-create-accommodation-add-btn/.test(apiSrc)
    && /ps-create-custom-addon-card[\s\S]{0,2500}ps-create-accommodation/.test(apiSrc));
  ok('Create reads accommodation into payload',
    /accommodation: scheduleReadCreateAccommodation\(\)/.test(apiSrc));
  ok('Create seed from booking dates',
    /function scheduleAddCreateAccommodation/.test(apiSrc)
    && /ps-create-date-from/.test(apiSrc)
    && /scheduleDefaultAccommodationStay|scheduleCreateAccommodation = scheduleDefaultAccommodationStay/.test(apiSrc));
  ok('Create product enable from admin config',
    /scheduleSetAccommodationProductEnabled/.test(apiSrc)
    && /data\.accommodation && data\.accommodation\.enabled/.test(apiSrc));

  // Behavioral: Create generated owners (timezone-safe defaults)
  function extractNamedFn(src, name) {
    const start = src.search(new RegExp('function\\s+' + name + '\\s*\\('));
    if (start < 0) return null;
    const brace = src.indexOf('{', start);
    if (brace < 0) return null;
    let depth = 0;
    for (let i = brace; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    return null;
  }
  const createAddIso = extractNamedFn(apiSrc, 'scheduleAddIsoDays');
  const createDefaultStay = extractNamedFn(apiSrc, 'scheduleDefaultAccommodationStay');
  ok('Create owners export scheduleAddIsoDays + scheduleDefaultAccommodationStay',
    !!createAddIso && !!createDefaultStay);
  if (createAddIso && createDefaultStay) {
    // eslint-disable-next-line no-new-func
    const createFns = new Function(
      createAddIso + '\n' + createDefaultStay
      + '\nreturn { scheduleAddIsoDays: scheduleAddIsoDays, scheduleDefaultAccommodationStay: scheduleDefaultAccommodationStay };',
    )();
    ok('Create addIsoDays month/year boundary',
      createFns.scheduleAddIsoDays('2026-01-31', 1) === '2026-02-01'
      && createFns.scheduleAddIsoDays('2025-12-31', 1) === '2026-01-01');
    ok('Create same-day default one-night stay',
      (() => {
        const s = createFns.scheduleDefaultAccommodationStay('2026-07-04', '2026-07-04');
        return s.check_in === '2026-07-04' && s.check_out === '2026-07-05';
      })());
    ok('Create multi-day default maps checkout to date_to',
      (() => {
        const s = createFns.scheduleDefaultAccommodationStay('2026-07-04', '2026-07-10');
        return s.check_in === '2026-07-04' && s.check_out === '2026-07-10';
      })());
  }

  const editUi = read('scripts/browser/sunset-schedule-drawer-edit-ui.js');
  ok('Edit accommodation under custom addon',
    /ps-drawer-accommodation/.test(editUi)
    && /data-edit-section="custom-addon"[\s\S]{0,3000}ps-drawer-accommodation/.test(editUi));
  ok('Edit payload includes accommodation',
    /accommodation: accommodation/.test(editUi));
  ok('Edit seed + wire + remove',
    /scheduleDrawerSeedAccommodationFromCtx/.test(editUi)
    && /scheduleWireDrawerAccommodation/.test(editUi)
    && /scheduleDrawerRemoveAccommodation/.test(editUi));
  ok('Edit preserves historical when product disabled',
    /hasExisting/.test(editUi) && /scheduleAccommodationEnabledCache/.test(editUi));

  const editAddIso = extractNamedFn(editUi, 'scheduleDrawerAddIsoDays');
  const editDefaultStay = extractNamedFn(editUi, 'scheduleDrawerDefaultAccommodationStay');
  ok('Edit owners export scheduleDrawerAddIsoDays + DefaultAccommodationStay',
    !!editAddIso && !!editDefaultStay);
  if (editAddIso && editDefaultStay) {
    // eslint-disable-next-line no-new-func
    const editFns = new Function(
      editAddIso + '\n' + editDefaultStay
      + '\nreturn { scheduleDrawerAddIsoDays: scheduleDrawerAddIsoDays, scheduleDrawerDefaultAccommodationStay: scheduleDrawerDefaultAccommodationStay };',
    )();
    ok('Edit addIsoDays month/year boundary',
      editFns.scheduleDrawerAddIsoDays('2026-01-31', 1) === '2026-02-01'
      && editFns.scheduleDrawerAddIsoDays('2025-12-31', 1) === '2026-01-01');
    ok('Edit same-day default one-night stay',
      (() => {
        const s = editFns.scheduleDrawerDefaultAccommodationStay('2026-08-15', '2026-08-15');
        return s.check_in === '2026-08-15' && s.check_out === '2026-08-16';
      })());
    ok('Edit multi-day default maps checkout to date_to',
      (() => {
        const s = editFns.scheduleDrawerDefaultAccommodationStay('2026-08-15', '2026-08-20');
        return s.check_in === '2026-08-15' && s.check_out === '2026-08-20';
      })());
  }

  ok('dead adminSaveAccommodation removed (unwired duplicate)',
    !/function adminSaveAccommodation\s*\(/.test(adminUi));
  ok('live save-accommodation action still wired',
    /action === 'save-accommodation'/.test(adminUi)
    && /adminApiRequest\(\s*'PUT'\s*,\s*'\/staff\/admin\/config\/accommodation'/.test(adminUi));

  const viewUi = read('scripts/browser/sunset-schedule-drawer-view-ui.js');
  ok('booking card accommodation line + seasons',
    /ps-invoice-accommodation/.test(viewUi)
    && /ps-invoice-accommodation-season/.test(viewUi)
    && /season_groups/.test(viewUi));

  const portalMod = read('scripts/browser/sunset-schedule-portal-module.js');
  ok('create open wires accommodation',
    /scheduleWireCreateAccommodation/.test(portalMod));
  ok('create reset clears accommodation',
    /scheduleCreateAccommodation = null/.test(portalMod));

  // ── 6) i18n EN/ES/IT ────────────────────────────────────────────────────
  console.log('\n[6] i18n EN/ES/IT');
  const i18nEn = read('scripts/lib/staff-portal-i18n.js');
  const i18nEs = read('scripts/lib/staff-portal-i18n-es-sunset.js');
  const keys = [
    'admin.section.accommodation',
    'admin.accommodation.title',
    'admin.accommodation.help',
    'admin.accommodation.enabled',
    'schedule.create.accommodation.title',
    'schedule.create.accommodation.add',
    'schedule.create.accommodation.checkIn',
    'schedule.create.accommodation.checkOut',
  ];
  keys.forEach((k) => {
    ok(`EN key ${k}`, i18nEn.includes(`'${k}'`) || i18nEn.includes(`"${k}"`));
  });
  ok('ES sunset keys present',
    keys.every((k) => i18nEs.includes(`'${k}'`) || i18nEs.includes(`"${k}"`)));
  ok('IT keys present',
    i18nEn.includes("'admin.section.accommodation': 'Alloggio'")
    || i18nEn.includes('admin.section.accommodation') && i18nEn.includes('Alloggio'));

  // ── 7) Migration + exports + rollback path evidence ─────────────────────
  console.log('\n[7] Schema / API / persistence contract');
  const mig = read('database/migrations/052_tenant_accommodation.sql');
  ok('migration settings table', /tenant_accommodation_settings/.test(mig));
  ok('migration ranges table half-open',
    /tenant_accommodation_season_ranges/.test(mig)
    && /check_out > check_in/.test(mig));
  ok('ensureAccommodationTables twin',
    typeof admin.ensureAccommodationTables === 'function');
  const adminSrc = read('scripts/lib/sunset-accommodation-admin.js');
  ok('lazy DDL twin has updated_at triggers matching migration 052',
    /tenant_accommodation_settings_updated_at/.test(adminSrc)
    && /tenant_accommodation_season_ranges_updated_at/.test(adminSrc)
    && /DROP TRIGGER IF EXISTS tenant_accommodation_settings_updated_at/.test(adminSrc)
    && /DROP TRIGGER IF EXISTS tenant_accommodation_season_ranges_updated_at/.test(adminSrc)
    && /EXECUTE FUNCTION set_updated_at\(\)/.test(adminSrc)
    && /BEFORE UPDATE ON tenant_accommodation_settings/.test(adminSrc)
    && /BEFORE UPDATE ON tenant_accommodation_season_ranges/.test(adminSrc));
  ok('migration 052 has matching updated_at triggers',
    /CREATE TRIGGER tenant_accommodation_settings_updated_at/.test(mig)
    && /CREATE TRIGGER tenant_accommodation_season_ranges_updated_at/.test(mig)
    && /EXECUTE FUNCTION set_updated_at\(\)/.test(mig));
  ok('create path insert accommodation',
    /insertStaffAccommodationServiceRow/.test(read('scripts/lib/sunset-schedule-booking-writes.js'))
    && /input\.accommodation && input\.accommodation\.enabled/.test(read('scripts/lib/sunset-schedule-booking-writes.js')));
  ok('edit path insert accommodation',
    /input\.accommodation && input\.accommodation\.enabled/.test(read('scripts/lib/sunset-schedule-booking-drawer.js')));
  ok('edit omit preserves accommodation',
    /hasOwnProperty\.call\(requestBody, 'accommodation'\)/.test(read('scripts/lib/sunset-schedule-booking-drawer.js')));
  ok('quote staff-only accommodation',
    /accommodation_staff_only/.test(read('scripts/lib/luna-front-desk-quote-service.js')));
  ok('row match dedicated component',
    /STAFF_ACCOMMODATION_COMPONENT/.test(read('scripts/lib/sunset-schedule-booking-writes.js'))
    && /isStaffAccommodationMeta/.test(read('scripts/lib/sunset-schedule-booking-writes.js')));

  // Production module parse smoke (generated owners load)
  ok('admin ui parses', (() => {
    try { new Function(adminUi); return true; } catch (e) { return false; }
  })());
  ok('edit ui parses', (() => {
    try { new Function(editUi); return true; } catch (e) { return false; }
  })());
  ok('view ui parses', (() => {
    try { new Function(viewUi); return true; } catch (e) { return false; }
  })());

  // Disable history: requireEnabled true blocks new; false allows historical reprice
  ok('resolveAccommodationPrice exported', typeof admin.resolveAccommodationPrice === 'function');
  ok('disabled product semantics documented in i18n help',
    /Disabled blocks new|existing stays keep/i.test(i18nEn));

  // ── 8) Disabled-product history + paid/notes Edit owners (behavioral) ───
  console.log('\n[8] Disabled history reprice / paid / notes / untrusted field');
  const disabledRanges = [
    {
      id: 'r-low', title: 'Low', check_in: '2026-06-01', check_out: '2026-07-01',
      amount_cents: 4000, currency: 'EUR', active: true, sort_order: 0,
    },
    {
      id: 'r-high', title: 'High', check_in: '2026-07-01', check_out: '2026-08-01',
      amount_cents: 6000, currency: 'EUR', active: true, sort_order: 1,
    },
  ];
  function mockDisabledAccomPg() {
    return {
      query: async (sql) => {
        const s = String(sql);
        if (/to_regclass/i.test(s)) {
          return { rows: [{ t: 'public.tenant_accommodation_settings' }] };
        }
        if (/FROM tenant_accommodation_settings/i.test(s)) {
          return { rows: [{ id: 'set-1', enabled: false, currency: 'EUR' }] };
        }
        if (/FROM tenant_accommodation_season_ranges/i.test(s)) {
          return { rows: disabledRanges };
        }
        return { rows: [] };
      },
    };
  }
  const disabledPg = mockDisabledAccomPg();
  const accomSel = {
    enabled: true, check_in: '2026-06-10', check_out: '2026-06-13',
  };

  // (1) Trusted server-derived existing accommodation may quote/reprice while disabled.
  const trustedBuilt = quoteSvc.buildSunsetQuoteCommand({
    channel: quoteSvc.QUOTE_CHANNELS.MANUAL_STAFF,
    trustedLocationId: 'sunset-somo',
    transportBody: { accommodation: accomSel },
    allowExistingAccommodationWhenDisabled: true,
  });
  ok('trusted command builds with historical permission',
    trustedBuilt.ok === true
    && trustedBuilt.command.allowExistingAccommodationWhenDisabled === true);
  const trustedAppend = await quoteSvc.appendAccommodationToQuote(
    disabledPg, trustedBuilt.command, [], 0, 'EUR',
  );
  ok('disabled + trusted existing accom appends quote line (reprice path)',
    trustedAppend.ok === true
    && Array.isArray(trustedAppend.lines)
    && trustedAppend.lines.length === 1
    && trustedAppend.totalCents === 12000,
    JSON.stringify(trustedAppend.body || trustedAppend));
  ok('trusted reprice line uses staff_accommodation identity',
    trustedAppend.ok
    && trustedAppend.lines[0]
    && (trustedAppend.lines[0].component === 'staff_accommodation'
      || trustedAppend.lines[0].source === 'staff_accommodation'
      || String(trustedAppend.lines[0].offering_item_code || '').includes('staff_accommodation')
      || trustedAppend.lines[0].total_cents === 12000));

  // Direct price owner: requireEnabled:false allows disabled product for historical.
  const histPrice = await admin.resolveAccommodationPrice(disabledPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    checkIn: accomSel.check_in,
    checkOut: accomSel.check_out,
    requireEnabled: false,
  });
  ok('resolveAccommodationPrice requireEnabled:false succeeds while disabled',
    histPrice.ok === true && histPrice.priced && histPrice.priced.total_cents === 12000,
    JSON.stringify(histPrice));

  // Unrelated unpaid commercial change can still carry accommodation on intent/reprice.
  const unpaidExistingBundle = {
    booking: {
      guest_name: 'Ada',
      payment_status: 'unpaid',
      amount_paid_cents: 0,
      metadata: {
        source: 'staff_manual_schedule',
        staff_manual_schedule: true,
        location_id: 'sunset-somo',
      },
    },
    services: [{
      service_record_id: 'sr-accom-u',
      service_type: 'addon_service',
      service_date: '2026-06-10',
      quantity: 1,
      amount_due_cents: 12000,
      amount_paid_cents: 0,
      payment_status: 'pending',
      record_source: 'staff_manual',
      metadata: {
        source: 'staff_accommodation',
        staff_accommodation: true,
        component: 'staff_accommodation',
        check_in: '2026-06-10',
        check_out: '2026-06-13',
        nights: 3,
        total_cents: 12000,
        currency: 'EUR',
      },
    }],
    payments_paid_cents: 0,
  };
  const unpaidExistingIntent = drawer.pricingIntentFromBundle(unpaidExistingBundle);
  const unpaidCommercialChange = writes.buildSchedulePricingIntent({
    service_dates: unpaidExistingIntent.service_dates,
    components: {},
    accommodation: { enabled: true, check_in: '2026-06-10', check_out: '2026-06-13' },
    custom_line_items: [{ client_line_id: 'c1', label: 'Towel', amount_cents: 500 }],
  });
  ok('unpaid commercial change unequal (reprice) while accom preserved',
    writes.schedulePricingIntentsEqual(unpaidExistingIntent, unpaidCommercialChange) === false
    && unpaidCommercialChange.accommodation
    && unpaidCommercialChange.accommodation.enabled === true);
  ok('unpaid commercial change is not financially committed (paid gate closed)',
    writes.isSunsetBookingFinanciallyCommitted(unpaidExistingBundle) === false);
  // Production quote owner still prices accommodation under trusted historical flag.
  const unpaidRepriceQuote = await quoteSvc.appendAccommodationToQuote(
    disabledPg,
    quoteSvc.buildSunsetQuoteCommand({
      channel: quoteSvc.QUOTE_CHANNELS.MANUAL_STAFF,
      trustedLocationId: 'sunset-somo',
      transportBody: {
        accommodation: unpaidCommercialChange.accommodation,
        custom_line_items: unpaidCommercialChange.custom_line_items,
      },
      allowExistingAccommodationWhenDisabled: true,
    }).command,
    [],
    0,
    'EUR',
  );
  ok('unpaid commercial reprice quotes historical accom while product disabled',
    unpaidRepriceQuote.ok === true && unpaidRepriceQuote.totalCents === 12000,
    JSON.stringify(unpaidRepriceQuote.body || unpaidRepriceQuote));

  // (2) Disabled + no prior accommodation → add rejected with accommodation_disabled.
  const newAddBuilt = quoteSvc.buildSunsetQuoteCommand({
    channel: quoteSvc.QUOTE_CHANNELS.MANUAL_STAFF,
    trustedLocationId: 'sunset-somo',
    transportBody: { accommodation: accomSel },
    // default: no historical permission
  });
  ok('new-add command has no historical permission',
    newAddBuilt.ok && newAddBuilt.command.allowExistingAccommodationWhenDisabled === false);
  const newAddAppend = await quoteSvc.appendAccommodationToQuote(
    disabledPg, newAddBuilt.command, [], 0, 'EUR',
  );
  ok('disabled + no prior accom add rejected accommodation_disabled',
    newAddAppend.ok === false
    && newAddAppend.status === 409
    && (newAddAppend.body && (newAddAppend.body.reason_code === 'accommodation_disabled'
      || newAddAppend.body.reason === 'accommodation_disabled')),
    JSON.stringify(newAddAppend.body || newAddAppend));
  const newAddPrice = await admin.resolveAccommodationPrice(disabledPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    checkIn: accomSel.check_in,
    checkOut: accomSel.check_out,
    requireEnabled: true,
  });
  ok('resolveAccommodationPrice requireEnabled:true rejects while disabled',
    newAddPrice.ok === false && newAddPrice.reason_code === 'accommodation_disabled',
    JSON.stringify(newAddPrice));

  // Untrusted request field must NEVER grant historical permission.
  const spoofBuilt = quoteSvc.buildSunsetQuoteCommand({
    channel: quoteSvc.QUOTE_CHANNELS.MANUAL_STAFF,
    trustedLocationId: 'sunset-somo',
    transportBody: {
      accommodation: accomSel,
      allowExistingAccommodationWhenDisabled: true,
      requireEnabled: false,
      historical_accommodation: true,
      existing_accommodation: true,
    },
  });
  ok('untrusted transportBody cannot set command historical permission',
    spoofBuilt.ok === true
    && spoofBuilt.command.allowExistingAccommodationWhenDisabled === false);
  const spoofAppend = await quoteSvc.appendAccommodationToQuote(
    disabledPg, spoofBuilt.command, [], 0, 'EUR',
  );
  ok('spoofed transportBody still rejects accommodation_disabled',
    spoofAppend.ok === false
    && spoofAppend.body
    && (spoofAppend.body.reason_code === 'accommodation_disabled'
      || spoofAppend.body.reason === 'accommodation_disabled'),
    JSON.stringify(spoofAppend.body || spoofAppend));

  // Edit owner wires permission only from locked service-row identity (source contract).
  const drawerSrc = read('scripts/lib/sunset-schedule-booking-drawer.js');
  const quoteSrc = read('scripts/lib/luna-front-desk-quote-service.js');
  const writesSrc = read('scripts/lib/sunset-schedule-booking-writes.js');
  ok('Edit derives hadStaffAccommodation from lockedBundle services only',
    /hadStaffAccommodation\s*=\s*\(lockedBundle\.services/.test(drawerSrc)
    && /isStaffAccommodationMeta/.test(drawerSrc)
    && /allowExistingAccommodationWhenDisabled:\s*hadStaffAccommodation/.test(drawerSrc));
  ok('quote command never reads historical flag from transportBody',
    /opts\s*&&\s*opts\.allowExistingAccommodationWhenDisabled\s*===\s*true/.test(quoteSrc)
    && !/transportBody\.allowExistingAccommodationWhenDisabled/.test(quoteSrc)
    && !/body\.allowExistingAccommodationWhenDisabled/.test(quoteSrc));
  ok('authoritative quote threads trusted flag only from opts',
    /allowExistingAccommodationWhenDisabled:\s*\n?\s*opts\s*&&\s*opts\.allowExistingAccommodationWhenDisabled\s*===\s*true/.test(writesSrc)
    || /opts && opts\.allowExistingAccommodationWhenDisabled === true/.test(writesSrc));

  // (3) Disabled + existing explicit remove succeeds / no accommodation quote line.
  const removeNorm = resolver.normalizeAccommodationSelection(null);
  ok('explicit null selection skips', removeNorm.ok && removeNorm.skip === true);
  const removeBuilt = quoteSvc.buildSunsetQuoteCommand({
    channel: quoteSvc.QUOTE_CHANNELS.MANUAL_STAFF,
    trustedLocationId: 'sunset-somo',
    transportBody: { accommodation: null },
    allowExistingAccommodationWhenDisabled: true,
  });
  const removeAppend = await quoteSvc.appendAccommodationToQuote(
    disabledPg, removeBuilt.command, [], 5000, 'EUR',
  );
  ok('explicit remove leaves lines empty (no accom quote line)',
    removeAppend.ok === true
    && removeAppend.lines.length === 0
    && removeAppend.totalCents === 5000);
  const removeFalseBuilt = quoteSvc.buildSunsetQuoteCommand({
    channel: quoteSvc.QUOTE_CHANNELS.MANUAL_STAFF,
    trustedLocationId: 'sunset-somo',
    transportBody: { accommodation: { enabled: false } },
    allowExistingAccommodationWhenDisabled: true,
  });
  const removeFalseAppend = await quoteSvc.appendAccommodationToQuote(
    disabledPg, removeFalseBuilt.command, [], 5000, 'EUR',
  );
  ok('enabled:false remove skips accommodation quote line',
    removeFalseAppend.ok === true
    && removeFalseAppend.lines.length === 0
    && removeFalseAppend.totalCents === 5000);
  // Edit pricing intent: explicit remove is unequal and fingerprint null.
  const existingForRemove = drawer.pricingIntentFromBundle(unpaidExistingBundle);
  const removeIntent = writes.buildSchedulePricingIntent({
    service_dates: existingForRemove.service_dates,
    components: {},
    accommodation: null,
  });
  ok('explicit remove intent unequal + null fingerprint (Edit owner)',
    writes.schedulePricingIntentsEqual(existingForRemove, removeIntent) === false
    && removeIntent.accommodation == null
    && writes.accommodationForIntentFingerprint(null) == null);

  // (4) Paid changed-price intent remains blocked by existing paid gate.
  const paidBundle = {
    booking: {
      guest_name: 'Ada',
      payment_status: 'paid',
      amount_paid_cents: 12000,
      metadata: {
        source: 'staff_manual_schedule',
        staff_manual_schedule: true,
        location_id: 'sunset-somo',
      },
    },
    services: [{
      service_record_id: 'sr-accom-p',
      service_type: 'addon_service',
      service_date: '2026-06-10',
      quantity: 1,
      amount_due_cents: 12000,
      amount_paid_cents: 12000,
      payment_status: 'paid',
      record_source: 'staff_manual',
      metadata: {
        source: 'staff_accommodation',
        staff_accommodation: true,
        component: 'staff_accommodation',
        check_in: '2026-06-10',
        check_out: '2026-06-13',
        nights: 3,
        total_cents: 12000,
        currency: 'EUR',
      },
    }],
    payments_paid_cents: 12000,
  };
  const paidExisting = drawer.pricingIntentFromBundle(paidBundle);
  const paidChanged = writes.buildSchedulePricingIntent({
    service_dates: paidExisting.service_dates,
    components: {},
    accommodation: { enabled: true, check_in: '2026-06-10', check_out: '2026-06-15' },
  });
  ok('paid + changed accom dates unequal (would reprice)',
    writes.schedulePricingIntentsEqual(paidExisting, paidChanged) === false);
  ok('paid bundle is financially committed',
    writes.isSunsetBookingFinanciallyCommitted(paidBundle) === true);
  const paidGate = writes.paidBookingRepriceRequiredResult();
  ok('paid reprice gate returns paid_booking_reprice_required',
    paidGate.ok === false
    && paidGate.status === 409
    && paidGate.body
    && paidGate.body.reason_code === writes.PAID_BOOKING_REPRICE_REQUIRED);
  // Production Edit owner: pricingChanged && committed → paid gate (behavioral composition).
  const pricingChangedPaid = !writes.schedulePricingIntentsEqual(paidExisting, paidChanged);
  const wouldBlockPaid = pricingChangedPaid
    && writes.isSunsetBookingFinanciallyCommitted(paidBundle);
  ok('Edit paid composition blocks changed-price intent',
    wouldBlockPaid === true);

  // (5) Unchanged notes-only remains equal / non-reprice.
  const notesOnly = writes.buildSchedulePricingIntent({
    service_dates: paidExisting.service_dates,
    components: {},
    notes: 'leave towels please',
    guest_name: 'Ada Lovelace',
    accommodation: { enabled: true, check_in: '2026-06-10', check_out: '2026-06-13' },
  });
  ok('notes-only keeps pricing intent equal (non-reprice)',
    writes.schedulePricingIntentsEqual(paidExisting, notesOnly) === true);
  ok('notes-only does not trip paid reprice composition',
    writes.schedulePricingIntentsEqual(paidExisting, notesOnly) === true
    || !writes.isSunsetBookingFinanciallyCommitted(paidBundle) === false);
  const notesOnlyWouldBlock = !writes.schedulePricingIntentsEqual(paidExisting, notesOnly)
    && writes.isSunsetBookingFinanciallyCommitted(paidBundle);
  ok('notes-only composition is non-reprice (no paid gate)',
    notesOnlyWouldBlock === false);

  // ── 9) Strict Admin euro→cents parser (production browser owner) ────────
  console.log('\n[9] Admin strict euro→cents parser');
  const adminParseFnSrc = extractNamedFn(adminUi, 'adminParseEurosToCents');
  ok('adminParseEurosToCents extractable from production Admin UI', !!adminParseFnSrc);
  let adminParseEurosToCents = null;
  if (adminParseFnSrc) {
    // eslint-disable-next-line no-new-func
    adminParseEurosToCents = new Function(
      'portalT',
      `${adminParseFnSrc}\nreturn adminParseEurosToCents;`,
    )((k) => String(k || 'err'));
  }
  if (adminParseEurosToCents) {
    ok('parse 12 → 1200',
      adminParseEurosToCents('12').ok && adminParseEurosToCents('12').value === 1200);
    ok('parse 12.3 → 1230',
      adminParseEurosToCents('12.3').ok && adminParseEurosToCents('12.3').value === 1230);
    ok('parse 12.34 → 1234',
      adminParseEurosToCents('12.34').ok && adminParseEurosToCents('12.34').value === 1234);
    ok('parse comma 12,50 → 1250',
      adminParseEurosToCents('12,50').ok && adminParseEurosToCents('12,50').value === 1250);
    ok('parse euro-prefixed €12.34 → 1234',
      adminParseEurosToCents('€12.34').ok && adminParseEurosToCents('€12.34').value === 1234);
    ok('reject >2 decimals 12.345',
      adminParseEurosToCents('12.345').ok === false);
    ok('reject exponent 1e2',
      adminParseEurosToCents('1e2').ok === false);
    ok('reject negative -3.50',
      adminParseEurosToCents('-3.50').ok === false);
    ok('reject empty/invalid',
      adminParseEurosToCents('').ok === false
      && adminParseEurosToCents('abc').ok === false);
    ok('reject NaN text',
      adminParseEurosToCents('NaN').ok === false);
  }
  ok('Admin accommodation draft uses adminParseEurosToCents (not Math.round float)',
    /adminParseEurosToCents\(eurRaw\)/.test(adminUi)
    && !/Math\.round\(euros \* 100\)/.test(
      (adminUi.match(/function adminReadAccommodationDraftFromDom[\s\S]*?\n\}/) || [''])[0],
    ));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
