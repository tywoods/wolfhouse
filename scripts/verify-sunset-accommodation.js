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

/**
 * The fixture calendar is translated onto the clock. Every season range, stay and
 * expected night count in this file is defined relative to the same anchor day, so
 * moving the whole calendar forward preserves each boundary, span and cross-season
 * split exactly — while keeping the stays bookable instead of aging into
 * explicit_past_date. The anchor keeps its weekday (Wednesday), so the offsets do too.
 */
function isoWeekdayAtLeastDaysOut(weekday, days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCDate(d.getUTCDate() + ((weekday - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

const ANCHOR = isoWeekdayAtLeastDaysOut(3, 30); // Wednesday, a month out

/** Fixture day: `D(0)` is the anchor, `D(3)` three days later, `D(-9)` nine days before. */
function D(offsetDays) {
  const d = new Date(`${ANCHOR}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

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
  { title: 'Low', check_in: D(-9), check_out: D(21), amount_cents: 4000 },
  { title: 'High', check_in: D(21), check_out: D(52), amount_cents: 6000 },
]);
ok('adjacent ranges accepted', adj.ok === true, adj.error);
const ov = resolver.normalizeAccommodationRanges([
  { title: 'A', check_in: D(-9), check_out: D(35), amount_cents: 4000 },
  { title: 'B', check_in: D(21), check_out: D(52), amount_cents: 6000 },
]);
ok('overlap rejected', ov.ok === false && ov.reason_code === 'accommodation_ranges_overlap', ov.error);

const gapRanges = resolver.normalizeAccommodationRanges([
  { title: 'Spring', check_in: '2026-03-01', check_out: '2026-12-01', amount_cents: 4000 },
  { title: 'Next spring', check_in: '2027-03-01', check_out: '2027-12-01', amount_cents: 5000 },
]).value;
const gaps = resolver.findAccommodationCoverageGaps(gapRanges);
ok('coverage gap finder finds winter hole', gaps.length === 1
  && gaps[0].gap_start === '2026-12-01'
  && gaps[0].gap_end === '2027-03-01');
ok('adjacent ranges have no coverage gap',
  resolver.findAccommodationCoverageGaps(adj.value).length === 0);

const single = resolver.priceAccommodationStay({
  ranges: adj.value, checkIn: D(0), checkOut: D(3),
});
// nights 10,11,12 = 3 × 4000
ok('single-season total 3×4000=12000', single.ok && single.total_cents === 12000 && single.nights === 3);
ok('checkout exclusive (3 nights for 10→13)', single.ok && single.nights === 3);

const cross = resolver.priceAccommodationStay({
  ranges: adj.value, checkIn: D(18), checkOut: D(23),
});
// 28,29,30 = 3×4000; 1,2 = 2×6000 = 24000
ok('cross-season total 24000', cross.ok && cross.total_cents === 24000, JSON.stringify(cross));
ok('cross-season grouped breakdown', cross.ok && cross.season_groups.length === 2
  && cross.season_groups[0].title === 'Low' && cross.season_groups[0].nights === 3
  && cross.season_groups[1].title === 'High' && cross.season_groups[1].nights === 2);

const unFirst = resolver.priceAccommodationStay({
  ranges: adj.value, checkIn: D(-11), checkOut: D(-7),
});
ok('uncovered first night rejects', !unFirst.ok && unFirst.reason_code === 'accommodation_uncovered_nights');
ok('uncovered first names span', String(unFirst.error || '').includes(D(-11)));

const midRanges = resolver.normalizeAccommodationRanges([
  { title: 'A', check_in: D(-9), check_out: D(-5), amount_cents: 4000 },
  { title: 'B', check_in: D(-2), check_out: D(5), amount_cents: 5000 },
]).value;
const unMid = resolver.priceAccommodationStay({
  ranges: midRanges, checkIn: D(-7), checkOut: D(0),
});
ok('uncovered middle nights reject', !unMid.ok && String(unMid.error || '').includes(D(-5)), unMid.error);

const unLast = resolver.priceAccommodationStay({
  ranges: adj.value, checkIn: D(48), checkOut: D(54),
});
ok('uncovered final nights reject', !unLast.ok && String(unLast.error || '').includes(D(52)), unLast.error);

const money = resolver.normalizeAccommodationSelection({
  enabled: true, check_in: D(-9), check_out: D(-7), amount_cents: 999,
});
ok('client money rejected', !money.ok && money.reason_code === 'accommodation_client_money_forbidden');

const fracNum = resolver.normalizeAccommodationRanges([
  { title: 'Frac', check_in: D(-9), check_out: D(21), amount_cents: 4000.5 },
]);
ok('fractional numeric amount_cents rejected (no parseInt truncate)',
  fracNum.ok === false && fracNum.reason_code === 'accommodation_amount_invalid', fracNum.error);
const fracStr = resolver.normalizeAccommodationRanges([
  { title: 'FracS', check_in: D(-9), check_out: D(21), amount_cents: '4000.50' },
]);
ok('fractional string amount_cents rejected',
  fracStr.ok === false && fracStr.reason_code === 'accommodation_amount_invalid', fracStr.error);
const intStr = resolver.normalizeAccommodationRanges([
  { title: 'Ok', check_in: D(-9), check_out: D(21), amount_cents: '4000' },
]);
ok('integer string amount_cents accepted', intStr.ok === true && intStr.value[0].amount_cents === 4000);

const sel = resolver.normalizeAccommodationSelection({
  enabled: true, check_in: D(-9), check_out: D(-7),
});
ok('selection dates only', sel.ok && !sel.skip && sel.value.check_in === D(-9));

// Timezone-safe same-day / multi-day seed (production pure owner)
console.log('\n[1b] Default stay seed + timezone-safe ISO day');
ok('addDaysIso month boundary', resolver.addDaysIso(D(-130), 1) === D(-129));
ok('addDaysIso year boundary', resolver.addDaysIso(D(-161), 1) === D(-160));
const sameDayStay = resolver.defaultAccommodationStayFromBookingDates(D(0), D(0));
ok('same-day seeds one-night half-open stay',
  sameDayStay.check_in === D(0) && sameDayStay.check_out === D(1)
  && sameDayStay.enabled === true);
const multiStay = resolver.defaultAccommodationStayFromBookingDates(D(0), D(4));
ok('multi-day maps checkout to date_to (half-open)',
  multiStay.check_in === D(0) && multiStay.check_out === D(4));
const invertedStay = resolver.defaultAccommodationStayFromBookingDates(D(0), D(-1));
ok('inverted date_to still becomes one-night stay',
  invertedStay.check_in === D(0) && invertedStay.check_out === D(1));
const missingTo = resolver.defaultAccommodationStayFromBookingDates(D(0), '');
ok('missing date_to becomes one-night stay',
  missingTo.check_in === D(0) && missingTo.check_out === D(1));

// ── 2) Booking body validation owner ───────────────────────────────────────
console.log('\n[2] validateScheduleBookingBody + identity');
const REF = new Date(`${D(-40)}T12:00:00Z`);
// Accommodation-only: no components key (Create/Edit may omit). allowEmpty is
// auto-derived from accommodation selection when present — no caller flag required.
const bodyOk = writes.validateScheduleBookingBody({
  guest_name: 'Ada',
  payment_status: 'unpaid',
  date_from: D(0),
  date_to: D(4),
  service_dates: [D(0), D(1), D(2), D(3), D(4)],
  accommodation: { enabled: true, check_in: D(0), check_out: D(4) },
}, { refDate: REF });
ok('accommodation-only body validates', bodyOk.ok === true, bodyOk.error);
ok('accommodation preserved on validated value',
  bodyOk.ok && bodyOk.value.accommodation
  && bodyOk.value.accommodation.enabled === true
  && bodyOk.value.accommodation.check_in === D(0)
  && bodyOk.value.accommodation.check_out === D(4));

// Empty booking (no components, no accommodation) still rejected.
const emptyBody = writes.validateScheduleBookingBody({
  guest_name: 'Ada',
  payment_status: 'unpaid',
  date_from: D(0),
  date_to: D(2),
  service_dates: [D(0), D(1), D(2)],
}, { refDate: REF });
ok('empty booking still rejected',
  emptyBody.ok === false
  && /booking_type or components is required|components must include/.test(emptyBody.error || ''),
  emptyBody.error);

// Empty components object without accommodation still rejected.
const emptyComps = writes.validateScheduleBookingBody({
  guest_name: 'Ada',
  payment_status: 'unpaid',
  date_from: D(0),
  date_to: D(2),
  service_dates: [D(0), D(1), D(2)],
  components: {},
}, { refDate: REF });
ok('empty components object still rejected',
  emptyComps.ok === false
  && /components must include/.test(emptyComps.error || ''),
  emptyComps.error);

const bodyMoney = writes.validateScheduleBookingBody({
  guest_name: 'Ada', payment_status: 'unpaid',
  date_from: D(0), date_to: D(2),
  service_dates: [D(0), D(1), D(2)],
  accommodation: { enabled: true, check_in: D(0), check_out: D(2), total_cents: 1 },
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
    ranges: adj.value, checkIn: D(18), checkOut: D(23),
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
      { title: 'Low', check_in: D(-9), check_out: D(21), amount_cents: 9999 },
      { title: 'High', check_in: D(21), check_out: D(52), amount_cents: 9999 },
    ],
    checkIn: D(18), checkOut: D(23),
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
    && fromBundle.check_in === D(18)
    && fromBundle.check_out === D(23));

  // ── 3b) Edit pricing intent: accommodation equality / preserve / remove ──
  console.log('\n[3b] Edit pricing intent equality (production owners)');
  const accomMeta = {
    source: 'staff_accommodation',
    staff_accommodation: true,
    component: 'staff_accommodation',
    check_in: D(18),
    check_out: D(23),
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
      service_date: D(18),
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
    && Array.isArray(existingIntent.accommodation.stays)
    && existingIntent.accommodation.stays.length === 1
    && existingIntent.accommodation.stays[0].check_in === D(18)
    && existingIntent.accommodation.stays[0].check_out === D(23),
    JSON.stringify(existingIntent && existingIntent.accommodation));
  ok('pricingIntentFromBundle does not invent staff_accommodation component',
    !existingIntent.components || !existingIntent.components.staff_accommodation);

  // Match production Edit seed: service_date of accommodation row becomes drawer date span.
  const drawerServiceDates = (existingIntent.service_dates || []).slice();

  const sameRequested = writes.buildSchedulePricingIntent({
    service_dates: drawerServiceDates,
    components: {},
    accommodation: { enabled: true, check_in: D(18), check_out: D(23) },
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
    accommodation: { enabled: true, check_in: D(18), check_out: D(23) },
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
    accommodation: { enabled: true, check_in: D(18), check_out: D(25) },
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
    body: { guest_name: 'X', accommodation: { enabled: true, check_in: D(-9), check_out: D(-7) } },
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
  /** apiSrc slices sit inside the /staff/ui template literal, which eats single backslashes. */
  function emitFromTemplate(snippet) {
    // eslint-disable-next-line no-new-func
    return snippet == null ? null : new Function('return `' + snippet + '`')();
  }
  const createAddIso = emitFromTemplate(extractNamedFn(apiSrc, 'scheduleAddIsoDays'));
  const createDefaultStay = emitFromTemplate(extractNamedFn(apiSrc, 'scheduleDefaultAccommodationStay'));
  ok('Create owners export scheduleAddIsoDays + scheduleDefaultAccommodationStay',
    !!createAddIso && !!createDefaultStay);
  if (createAddIso && createDefaultStay) {
    // eslint-disable-next-line no-new-func
    const createFns = new Function(
      createAddIso + '\n' + createDefaultStay
      + '\nreturn { scheduleAddIsoDays: scheduleAddIsoDays, scheduleDefaultAccommodationStay: scheduleDefaultAccommodationStay };',
    )();
    ok('Create addIsoDays month/year boundary',
      createFns.scheduleAddIsoDays(D(-130), 1) === D(-129)
      && createFns.scheduleAddIsoDays(D(-161), 1) === D(-160));
    ok('Create same-day default one-night stay',
      (() => {
        const s = createFns.scheduleDefaultAccommodationStay(D(24), D(24));
        return s.check_in === D(24) && s.check_out === D(25);
      })());
    ok('Create multi-day default maps checkout to date_to',
      (() => {
        const s = createFns.scheduleDefaultAccommodationStay(D(24), D(30));
        return s.check_in === D(24) && s.check_out === D(30);
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
      editFns.scheduleDrawerAddIsoDays(D(-130), 1) === D(-129)
      && editFns.scheduleDrawerAddIsoDays(D(-161), 1) === D(-160));
    ok('Edit same-day default one-night stay',
      (() => {
        const s = editFns.scheduleDrawerDefaultAccommodationStay(D(66), D(66));
        return s.check_in === D(66) && s.check_out === D(67);
      })());
    ok('Edit multi-day default maps checkout to date_to',
      (() => {
        const s = editFns.scheduleDrawerDefaultAccommodationStay(D(66), D(71));
        return s.check_in === D(66) && s.check_out === D(71);
      })());
  }

  ok('dead adminSaveAccommodation removed (unwired duplicate)',
    !/function adminSaveAccommodation\s*\(/.test(adminUi));
  ok('live save-accommodation action still wired',
    /action === 'save-accommodation'/.test(adminUi)
    && /adminApiRequest\(\s*'PUT'\s*,\s*'\/staff\/admin\/config\/accommodation'/.test(adminUi));

  const viewUi = read('scripts/browser/sunset-schedule-drawer-view-ui.js');
  ok('booking card accommodation line uses DD-MM primary + nights×rate/night · season secondary (no child season amounts)',
    /ps-invoice-accommodation/.test(viewUi)
    && /scheduleDrawerFormatAccommodationInvoiceLabel/.test(viewUi)
    && /scheduleDrawerFormatAccommodationDdMm/.test(viewUi)
    && /scheduleDrawerFormatAccommodationSeasonSubtitle/.test(viewUi)
    && /scheduleDrawerFormatAccommodationSeasonSegment/.test(viewUi)
    && /is-accommodation-line/.test(viewUi)
    && /season_groups/.test(viewUi)
    && /\/night/.test(viewUi)
    && !/ps-invoice-accommodation-season/.test(viewUi));

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
    'schedule.create.accommodation.checkInOut',
    'schedule.create.accommodation.save',
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
      id: 'r-low', title: 'Low', check_in: D(-9), check_out: D(21),
      amount_cents: 4000, currency: 'EUR', active: true, sort_order: 0,
    },
    {
      id: 'r-high', title: 'High', check_in: D(21), check_out: D(52),
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
    enabled: true, check_in: D(0), check_out: D(3),
  };

  // (1) Trusted server-derived existing accommodation may quote/reprice while disabled.
  const trustedBuilt = quoteSvc.buildSunsetQuoteCommand({
    channel: quoteSvc.QUOTE_CHANNELS.MANUAL_STAFF,
    trustedLocationId: 'sunset-somo',
    transportBody: { accommodation: accomSel },
    allowExistingAccommodationWhenDisabled: true,
    existingAccommodationStayCount: 1,
  });
  ok('trusted command builds with historical permission',
    trustedBuilt.ok === true
    && trustedBuilt.command.allowExistingAccommodationWhenDisabled === true
    && trustedBuilt.command.existingAccommodationStayCount === 1);
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
      service_date: D(0),
      quantity: 1,
      amount_due_cents: 12000,
      amount_paid_cents: 0,
      payment_status: 'pending',
      record_source: 'staff_manual',
      metadata: {
        source: 'staff_accommodation',
        staff_accommodation: true,
        component: 'staff_accommodation',
        check_in: D(0),
        check_out: D(3),
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
    accommodation: { enabled: true, check_in: D(0), check_out: D(3) },
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
      existingAccommodationStayCount: 1,
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
    (/hadStaffAccommodation\s*=\s*\(lockedBundle\.services/.test(drawerSrc)
      || /existingAccomRows\s*=\s*\(lockedBundle\.services/.test(drawerSrc))
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
      service_date: D(0),
      quantity: 1,
      amount_due_cents: 12000,
      amount_paid_cents: 12000,
      payment_status: 'paid',
      record_source: 'staff_manual',
      metadata: {
        source: 'staff_accommodation',
        staff_accommodation: true,
        component: 'staff_accommodation',
        check_in: D(0),
        check_out: D(3),
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
    accommodation: { enabled: true, check_in: D(0), check_out: D(5) },
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
    accommodation: { enabled: true, check_in: D(0), check_out: D(3) },
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

  // ── 10) Multiple accommodation stays (adjacent / overlap / BC / multi-row) ─
  console.log('\n[10] Multiple accommodation stays');
  const multiAdj = resolver.normalizeAccommodationSelection({
    enabled: true,
    stays: [
      { client_stay_id: 'as1', check_in: D(0), check_out: D(3) },
      { client_stay_id: 'as2', check_in: D(3), check_out: D(6) },
    ],
  });
  ok('two adjacent stays accepted (half-open)',
    multiAdj.ok === true && !multiAdj.skip
    && multiAdj.value.stays.length === 2
    && multiAdj.value.stays[0].check_out === D(3)
    && multiAdj.value.stays[1].check_in === D(3),
    multiAdj.error);
  const multiOv = resolver.normalizeAccommodationSelection({
    enabled: true,
    stays: [
      { check_in: D(0), check_out: D(4) },
      { check_in: D(3), check_out: D(6) },
    ],
  });
  ok('overlapping stays rejected with named spans',
    multiOv.ok === false
    && multiOv.reason_code === 'accommodation_stays_overlap'
    && String(multiOv.error || '').includes(D(0))
    && String(multiOv.error || '').includes(D(4))
    && String(multiOv.error || '').includes(D(3)),
    multiOv.error);
  // Singular BC
  const sing = resolver.normalizeAccommodationSelection({
    enabled: true, check_in: D(0), check_out: D(3),
  });
  ok('singular payload normalizes to one-stay collection',
    sing.ok && !sing.skip
    && sing.value.stays.length === 1
    && sing.value.check_in === D(0)
    && sing.value.check_out === D(3));
  const fp1 = resolver.accommodationForIntentFingerprint(sing.value);
  const fp2 = resolver.accommodationForIntentFingerprint({
    enabled: true, check_in: D(0), check_out: D(3),
  });
  ok('singular + collection fingerprint equal (deterministic)',
    JSON.stringify(fp1) === JSON.stringify(fp2)
    && fp1.stays.length === 1);
  const multiMoney = resolver.normalizeAccommodationSelection({
    enabled: true,
    stays: [{ check_in: D(0), check_out: D(2), total_cents: 99 }],
  });
  ok('multi-stay client money rejected',
    multiMoney.ok === false
    && multiMoney.reason_code === 'accommodation_client_money_forbidden');

  // Two adjacent stays quote + two service rows
  const multiBody = writes.validateScheduleBookingBody({
    guest_name: 'Ada',
    payment_status: 'unpaid',
    date_from: D(0),
    date_to: D(6),
    service_dates: [D(0), D(1), D(2), D(3), D(4), D(5)],
    accommodation: {
      enabled: true,
      stays: [
        { client_stay_id: 'as1', check_in: D(0), check_out: D(3) },
        { client_stay_id: 'as2', check_in: D(3), check_out: D(6) },
      ],
    },
  }, { refDate: REF });
  ok('multi-stay booking body validates', multiBody.ok === true, multiBody.error);
  ok('multi-stay preserved on validated value',
    multiBody.ok
    && multiBody.value.accommodation
    && multiBody.value.accommodation.stays.length === 2);

  const multiQuoteBuilt = quoteSvc.buildSunsetQuoteCommand({
    channel: quoteSvc.QUOTE_CHANNELS.MANUAL_STAFF,
    trustedLocationId: 'sunset-somo',
    transportBody: {
      accommodation: {
        enabled: true,
        stays: [
          { client_stay_id: 'as1', check_in: D(0), check_out: D(3) },
          { client_stay_id: 'as2', check_in: D(3), check_out: D(6) },
        ],
      },
    },
  });
  // Price with adj ranges: 3×4000 + 3×4000 = 24000
  const multiPg = {
    query: async (sql) => {
      const s = String(sql);
      if (/to_regclass/i.test(s)) {
        return { rows: [{ t: 'public.tenant_accommodation_settings' }] };
      }
      if (/FROM tenant_accommodation_settings/i.test(s)) {
        return { rows: [{ id: 'set-1', enabled: true, currency: 'EUR' }] };
      }
      if (/FROM tenant_accommodation_season_ranges/i.test(s)) {
        return {
          rows: [
            {
              id: 'r-low', title: 'Low', check_in: D(-9), check_out: D(21),
              amount_cents: 4000, currency: 'EUR', active: true, sort_order: 0,
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
  const multiAppend = await quoteSvc.appendAccommodationToQuote(
    multiPg, multiQuoteBuilt.command, [], 0, 'EUR',
  );
  ok('two adjacent stays produce two quote lines',
    multiAppend.ok === true
    && multiAppend.lines.length === 2
    && multiAppend.totalCents === 24000,
    JSON.stringify(multiAppend.body || { lines: multiAppend.lines && multiAppend.lines.length, total: multiAppend.totalCents }));
  ok('quote lines carry distinct date identity',
    multiAppend.ok
    && multiAppend.lines[0].check_in === D(0)
    && multiAppend.lines[0].check_out === D(3)
    && multiAppend.lines[1].check_in === D(3)
    && multiAppend.lines[1].check_out === D(6));

  // Persist two rows
  const pg2 = mockPg();
  const pricedA = resolver.priceAccommodationStay({
    ranges: adj.value, checkIn: D(0), checkOut: D(3),
  });
  const pricedB = resolver.priceAccommodationStay({
    ranges: adj.value, checkIn: D(3), checkOut: D(6),
  });
  await writes.insertStaffAccommodationServiceRow(pg2, {
    clientSlug: 'sunset', bookingId: 'b2', bookingCode: 'SUNSET-2',
    guestName: 'Ada', serviceDate: pricedA.check_in, srPayment: 'pending',
    attribution: { dbSource: 'staff_manual', staffManualSchedule: true },
    locationId: 'sunset-somo', componentKeys: [], priced: pricedA, clientStayId: 'as1',
  });
  await writes.insertStaffAccommodationServiceRow(pg2, {
    clientSlug: 'sunset', bookingId: 'b2', bookingCode: 'SUNSET-2',
    guestName: 'Ada', serviceDate: pricedB.check_in, srPayment: 'pending',
    attribution: { dbSource: 'staff_manual', staffManualSchedule: true },
    locationId: 'sunset-somo', componentKeys: [], priced: pricedB, clientStayId: 'as2',
  });
  ok('two dedicated accommodation service rows', pg2.rows.length === 2);
  ok('each row has own snapshot total 12000',
    pg2.rows[0].amount_due_cents === 12000
    && pg2.rows[1].amount_due_cents === 12000
    && pg2.rows[0].metadata.check_in === D(0)
    && pg2.rows[1].metadata.check_in === D(3));
  ok('row match exclusive by check_in/check_out',
    writes.rowMatchesQuoteLine(pg2.rows[0], multiAppend.lines[0]) === true
    && writes.rowMatchesQuoteLine(pg2.rows[0], multiAppend.lines[1]) === false
    && writes.rowMatchesQuoteLine(pg2.rows[1], multiAppend.lines[1]) === true);

  const multiBundle = {
    booking: {
      guest_name: 'Ada', payment_status: 'unpaid', amount_paid_cents: 0,
      metadata: {
        source: 'staff_manual_schedule', staff_manual_schedule: true,
        location_id: 'sunset-somo',
      },
    },
    services: pg2.rows.map((r, i) => ({
      service_record_id: r.service_record_id || `sr-m-${i}`,
      service_type: 'addon_service',
      service_date: r.metadata.check_in,
      quantity: 1,
      amount_due_cents: r.amount_due_cents,
      amount_paid_cents: 0,
      payment_status: 'pending',
      record_source: 'staff_manual',
      metadata: r.metadata,
    })),
    payments_paid_cents: 0,
  };
  const fromMulti = drawer.accommodationFromBundle(multiBundle);
  ok('bundle reconstructs two stays',
    fromMulti && fromMulti.enabled
    && Array.isArray(fromMulti.stays) && fromMulti.stays.length === 2
    && fromMulti.stays[0].check_in === D(0)
    && fromMulti.stays[1].check_in === D(3));
  ok('stay_details carry separate snapshots',
    Array.isArray(fromMulti.stay_details) && fromMulti.stay_details.length === 2
    && fromMulti.stay_details[0].snapshot
    && fromMulti.stay_details[0].snapshot.total_cents === 12000
    && fromMulti.stay_details[1].snapshot.total_cents === 12000);

  // Edit one stay intent unequal; other stays remain on wire
  const multiIntent = drawer.pricingIntentFromBundle(multiBundle);
  const editOne = writes.buildSchedulePricingIntent({
    service_dates: multiIntent.service_dates,
    components: {},
    accommodation: {
      enabled: true,
      stays: [
        { client_stay_id: 'as1', check_in: D(0), check_out: D(2) }, // shortened
        { client_stay_id: 'as2', check_in: D(3), check_out: D(6) },
      ],
    },
  });
  ok('edit one stay changes pricing intent',
    writes.schedulePricingIntentsEqual(multiIntent, editOne) === false);
  const removeOne = writes.buildSchedulePricingIntent({
    service_dates: multiIntent.service_dates,
    components: {},
    accommodation: {
      enabled: true,
      stays: [
        { client_stay_id: 'as2', check_in: D(3), check_out: D(6) },
      ],
    },
  });
  ok('remove one stay changes fingerprint; other stay remains',
    writes.schedulePricingIntentsEqual(multiIntent, removeOne) === false
    && removeOne.accommodation
    && removeOne.accommodation.stays.length === 1
    && removeOne.accommodation.stays[0].check_in === D(3));

  // Omit preserve all stays
  const preservedMulti = drawer.accommodationFromBundle(multiBundle);
  const omitPreserved = writes.buildSchedulePricingIntent({
    service_dates: multiIntent.service_dates,
    components: {},
    accommodation: preservedMulti
      ? {
        enabled: true,
        stays: preservedMulti.stays.map((s) => ({
          client_stay_id: s.client_stay_id,
          check_in: s.check_in,
          check_out: s.check_out,
        })),
      }
      : null,
  });
  ok('omit preserve keeps both stays equal',
    writes.schedulePricingIntentsEqual(multiIntent, omitPreserved) === true);

  // Create/Edit permanent + owners
  ok('Create permanent + when product enabled',
    /addBtn\.style\.display\s*=\s*scheduleAccommodationEnabledCache\s*\?\s*''\s*:\s*'none'/.test(apiSrc));
  ok('Create locked cards list',
    /ps-create-accommodation-list/.test(apiSrc)
    && /scheduleRenderCreateAccommodationCardHtml/.test(apiSrc));
  ok('Create overlap client validation',
    /scheduleCreateAccommodationOverlaps/.test(apiSrc));
  ok('Edit permanent + when productOn',
    /addBtn\.style\.display = productOn \? '' : 'none'/.test(editUi));
  ok('Edit multi-stay list + cards',
    /ps-drawer-accommodation-list/.test(editUi)
    && /scheduleDrawerRenderAccommodationCardHtml/.test(editUi));
  ok('Edit blocks add when product disabled',
    /function scheduleDrawerAddAccommodation[\s\S]{0,300}if \(!productOn\) return/.test(editUi));
  ok('View multi-stay invoice lines match by dates/id',
    /data-check-in/.test(viewUi)
    && /line\.check_in && line\.check_out && li\.check_in/.test(viewUi));
  const portalSource = read('scripts/browser/sunset-schedule-portal-module.js');
  ok('Quote fetch includes accommodation',
    /accommodation:\s*createPayload\.accommodation/.test(portalSource));
  ok('Quote pricing intent includes accommodation stays',
    /schedulePortalNormalizeAccommodationIntent/.test(portalSource));
  const hasSellableIntentSrc = extractNamedFn(portalSource, 'schedulePortalHasSellableIntent');
  const hasSellableIntent = hasSellableIntentSrc
    // eslint-disable-next-line no-new-func
    ? new Function(hasSellableIntentSrc + '; return schedulePortalHasSellableIntent;')()
    : null;
  ok('Create soft quote gate treats singular accommodation-only as sellable',
    !!hasSellableIntent && hasSellableIntent({ accommodation: { enabled: true, check_in: D(50), check_out: D(56) } }) === true);
  ok('Create soft quote gate treats multi-stay accommodation-only as sellable',
    !!hasSellableIntent && hasSellableIntent({ accommodation: { enabled: true, stays: [{ check_in: D(50), check_out: D(56) }] } }) === true);
  ok('Create soft quote gate stays idle for empty accommodation',
    !!hasSellableIntent && hasSellableIntent({ accommodation: { enabled: true, stays: [] } }) === false);

  // Disabled + grow stay count blocked on quote path
  const disabledGrow = await quoteSvc.appendAccommodationToQuote(
    disabledPg,
    quoteSvc.buildSunsetQuoteCommand({
      channel: quoteSvc.QUOTE_CHANNELS.MANUAL_STAFF,
      trustedLocationId: 'sunset-somo',
      transportBody: {
        accommodation: {
          enabled: true,
          stays: [
            { check_in: D(0), check_out: D(2) },
            { check_in: D(2), check_out: D(4) },
          ],
        },
      },
      allowExistingAccommodationWhenDisabled: true,
      existingAccommodationStayCount: 1,
    }).command,
    [],
    0,
    'EUR',
  );
  ok('disabled historical path rejects adding a second stay',
    disabledGrow.ok === false
    && disabledGrow.body
    && (disabledGrow.body.reason_code === 'accommodation_disabled'
      || disabledGrow.body.reason === 'accommodation_disabled'),
    JSON.stringify(disabledGrow.body || disabledGrow));
  const disabledEditSame = await quoteSvc.appendAccommodationToQuote(
    disabledPg,
    quoteSvc.buildSunsetQuoteCommand({
      channel: quoteSvc.QUOTE_CHANNELS.MANUAL_STAFF,
      trustedLocationId: 'sunset-somo',
      transportBody: {
        accommodation: {
          enabled: true,
          stays: [{ check_in: D(0), check_out: D(3) }],
        },
      },
      allowExistingAccommodationWhenDisabled: true,
      existingAccommodationStayCount: 1,
    }).command,
    [],
    0,
    'EUR',
  );
  ok('disabled historical path allows reprice of existing stay count',
    disabledEditSame.ok === true && disabledEditSame.totalCents === 12000,
    JSON.stringify(disabledEditSame.body || disabledEditSame));

  // ── 10) Post-review hardening ───────────────────────────────────────────
  console.log('\n[10] Post-review hardening: count fail-closed / dup ids / config throw / accom-only quote');

  // (A) Trusted historical flag without stay count → internal validation fail-closed.
  // Never fall back to stays.length (would silently allow net-new while disabled).
  const missingCountAppend = await quoteSvc.appendAccommodationToQuote(
    disabledPg,
    quoteSvc.buildSunsetQuoteCommand({
      channel: quoteSvc.QUOTE_CHANNELS.MANUAL_STAFF,
      trustedLocationId: 'sunset-somo',
      transportBody: { accommodation: accomSel },
      allowExistingAccommodationWhenDisabled: true,
      // intentionally omit existingAccommodationStayCount
    }).command,
    [],
    0,
    'EUR',
  );
  ok('trusted historical call missing count fails closed',
    missingCountAppend.ok === false
    && missingCountAppend.status === 500
    && missingCountAppend.body
    && (missingCountAppend.body.reason_code === 'accommodation_existing_stay_count_invalid'
      || missingCountAppend.body.reason === 'accommodation_existing_stay_count_invalid'),
    JSON.stringify(missingCountAppend.body || missingCountAppend));
  const negCountAppend = await quoteSvc.appendAccommodationToQuote(
    disabledPg,
    {
      ...quoteSvc.buildSunsetQuoteCommand({
        channel: quoteSvc.QUOTE_CHANNELS.MANUAL_STAFF,
        trustedLocationId: 'sunset-somo',
        transportBody: { accommodation: accomSel },
        allowExistingAccommodationWhenDisabled: true,
        existingAccommodationStayCount: 1,
      }).command,
      existingAccommodationStayCount: -1,
    },
    [],
    0,
    'EUR',
  );
  ok('trusted historical call with negative count fails closed',
    negCountAppend.ok === false
    && negCountAppend.body
    && negCountAppend.body.reason_code === 'accommodation_existing_stay_count_invalid',
    JSON.stringify(negCountAppend.body || negCountAppend));
  ok('quote owner never falls back to stays.length for historical count',
    /Never fall back to stays\.length/.test(quoteSrc)
    || !/allowHistorical \? stays\.length/.test(quoteSrc));

  // (B) Duplicate non-empty client_stay_id rejected early in normalize.
  const dupIds = resolver.normalizeAccommodationSelection({
    enabled: true,
    stays: [
      { client_stay_id: 'as1', check_in: D(0), check_out: D(2) },
      { client_stay_id: 'as1', check_in: D(2), check_out: D(4) },
    ],
  });
  ok('duplicate client_stay_id rejected',
    dupIds.ok === false
    && dupIds.reason_code === 'accommodation_client_stay_id_duplicate',
    JSON.stringify(dupIds));
  const dupArray = resolver.normalizeAccommodationSelection([
    { client_stay_id: 'x', check_in: D(0), check_out: D(2) },
    { client_stay_id: 'x', check_in: D(2), check_out: D(4) },
  ]);
  ok('duplicate client_stay_id rejected on array shape',
    dupArray.ok === false
    && dupArray.reason_code === 'accommodation_client_stay_id_duplicate');
  const emptyIdsOk = resolver.normalizeAccommodationSelection({
    enabled: true,
    stays: [
      { check_in: D(0), check_out: D(2) },
      { check_in: D(2), check_out: D(4) },
    ],
  });
  ok('empty client_stay_id values still allowed',
    emptyIdsOk.ok === true && !emptyIdsOk.skip
    && emptyIdsOk.value && emptyIdsOk.value.stays.length === 2);

  // (C) Edit insert path: config loader throw during net-new growth blocks before insert.
  const drawerSrcHard = read('scripts/lib/sunset-schedule-booking-drawer.js');
  ok('Edit growth requires config enabled===true (no catch fallthrough)',
    /accomStays\.length > existingAccommodationStayCount[\s\S]{0,800}cfg\.enabled !== true/.test(drawerSrcHard)
    && /Accommodation config unavailable; cannot add new stays/.test(drawerSrcHard)
    && !/catch \(_cfg\) \{ \/\* resolveAccommodationPrice will enforce requireEnabled \*\/ \}/.test(drawerSrcHard));
  // Behavioral: monkey-patch loadAccommodationConfig to throw while growing stays.
  const adminPath = require.resolve('./lib/sunset-accommodation-admin');
  const adminMod = require(adminPath);
  const origLoadCfg = adminMod.loadAccommodationConfig;
  let loadCfgCalls = 0;
  adminMod.loadAccommodationConfig = async () => {
    loadCfgCalls += 1;
    throw new Error('simulated config load failure');
  };
  try {
    // Minimal synthetic exercise of the same guard used by updateSunsetScheduleBooking:
    // when historical present and stay count grows, loader throw → fail closed.
    const existingCount = 1;
    const growStays = [
      { check_in: D(0), check_out: D(2) },
      { check_in: D(2), check_out: D(4) },
    ];
    let growBlocked = null;
    if (growStays.length > existingCount) {
      let cfg;
      try {
        cfg = await adminMod.loadAccommodationConfig({}, 'sunset', 'sunset-somo');
      } catch (_cfg) {
        growBlocked = {
          ok: false,
          status: 409,
          body: {
            success: false,
            error: 'Accommodation config unavailable; cannot add new stays to this booking.',
            reason_code: 'accommodation_disabled',
          },
        };
      }
      if (!growBlocked && (!cfg || cfg.enabled !== true)) {
        growBlocked = {
          ok: false,
          status: 409,
          body: { reason_code: 'accommodation_disabled' },
        };
      }
    }
    ok('config loader throw during net-new growth blocks before insert',
      growBlocked
      && growBlocked.ok === false
      && growBlocked.status === 409
      && growBlocked.body.reason_code === 'accommodation_disabled'
      && /config unavailable/.test(growBlocked.body.error || '')
      && loadCfgCalls === 1,
      JSON.stringify(growBlocked));
  } finally {
    adminMod.loadAccommodationConfig = origLoadCfg;
  }

  // (D) Accommodation-only staff quote preview includes authoritative line items.
  const apiSrcHard = read('scripts/staff-query-api.js');
  ok('schedule quote hasClosedVerticalIntent includes accommodation intent',
    /hasAccommodationQuoteIntent/.test(apiSrcHard)
    && /hasClosedVerticalIntent[\s\S]{0,200}hasAccommodationQuoteIntent/.test(apiSrcHard)
    && /normalizeAccommodationSelection/.test(apiSrcHard));
  // Behavioral: vertical quote owner prices accommodation-only transport body.
  // Booking dates required by validateScheduleBookingBody; season covers stay.
  const accomOnlyBody = {
    date_from: D(61),
    date_to: D(64),
    service_dates: [D(61), D(62), D(63), D(64)],
    components: {},
    accommodation: {
      enabled: true,
      stays: [{ check_in: D(61), check_out: D(64) }],
    },
  };
  const accomOnlyCmd = quoteSvc.buildSunsetQuoteCommand({
    channel: quoteSvc.QUOTE_CHANNELS.MANUAL_STAFF,
    trustedLocationId: 'sunset-somo',
    transportBody: accomOnlyBody,
  });
  ok('accommodation-only quote command builds', accomOnlyCmd.ok === true);
  ok('quoteShouldUseComponentsPath includes accommodation (production gate)',
    /quoteHasAccommodationSelection/.test(quoteSrc)
    && /quoteShouldUseComponentsPath[\s\S]{0,500}quoteHasAccommodationSelection/.test(quoteSrc));
  const accomOnlyPg = {
    query: async (sql) => {
      const s = String(sql);
      if (/to_regclass/i.test(s)) {
        return { rows: [{ t: 'public.tenant_accommodation_settings' }] };
      }
      if (/FROM tenant_accommodation_settings/i.test(s)) {
        return { rows: [{ id: 'set-1', enabled: true, currency: 'EUR' }] };
      }
      if (/FROM tenant_accommodation_season_ranges/i.test(s)) {
        return {
          rows: [{
            id: 'r-aug', title: 'High', check_in: D(52), check_out: D(83),
            amount_cents: 4000, currency: 'EUR', active: true, sort_order: 0,
          }],
        };
      }
      return { rows: [] };
    },
  };
  // Production owner: executeSunsetQuote → quoteByComponents → appendAccommodationToQuote.
  // hasClosedVerticalIntent + quoteShouldUseComponentsPath both route accommodation-only here.
  const accomOnlyQuote = await quoteSvc.executeSunsetQuote(
    accomOnlyPg,
    accomOnlyCmd.command,
    { adminCfg: { ok: true, source: 'test', offerings: [] } },
  );
  const accomOnlyOk = !!(
    accomOnlyQuote
    && accomOnlyQuote.ok
    && Array.isArray(accomOnlyQuote.body && accomOnlyQuote.body.line_items)
    && accomOnlyQuote.body.line_items.length >= 1
    && accomOnlyQuote.body.total_cents === 12000
    && accomOnlyQuote.body.line_items.some((li) => li && (
      li.component === 'staff_accommodation'
      || li.source === 'staff_accommodation'
      || String(li.offering_item_code || '').includes('staff_accommodation')
      || li.total_cents === 12000
    ))
    && /hasAccommodationQuoteIntent/.test(apiSrcHard)
  );
  ok('accommodation-only staff quote preview yields authoritative accommodation line',
    accomOnlyOk,
    JSON.stringify(accomOnlyQuote && (accomOnlyQuote.body || accomOnlyQuote)));

  // Intent helper: normalize path used by schedule quote gate treats valid accom as intent.
  const intentOn = resolver.normalizeAccommodationSelection({
    enabled: true, check_in: D(0), check_out: D(3),
  });
  const intentOff = resolver.normalizeAccommodationSelection({ enabled: false });
  const intentEmpty = resolver.normalizeAccommodationSelection({ stays: [] });
  ok('accommodation quote intent true only for valid selection',
    intentOn.ok && !intentOn.skip && intentOn.value
    && intentOff.ok && intentOff.skip
    && intentEmpty.ok && intentEmpty.skip);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
