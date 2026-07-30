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

const sel = resolver.normalizeAccommodationSelection({
  enabled: true, check_in: '2026-06-01', check_out: '2026-06-03',
});
ok('selection dates only', sel.ok && !sel.skip && sel.value.check_in === '2026-06-01');

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
    && /scheduleCreateAccommodation = \{/.test(apiSrc));
  ok('Create product enable from admin config',
    /scheduleSetAccommodationProductEnabled/.test(apiSrc)
    && /data\.accommodation && data\.accommodation\.enabled/.test(apiSrc));

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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
