'use strict';

/**
 * verify:sunset-bookings-admin-sort-type
 *
 * Bookings tab v2 — server-side sort defaults + Type buckets (Lessons/Rentals/
 * Accommodation), course-equipment exclusion, UI alignment/chip palette gates.
 *
 * Run: NODE_PATH=/opt/wolfhouse/WH/node_modules node scripts/verify-sunset-bookings-admin-sort-type.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sharedNodePath = [
  process.env.NODE_PATH,
  path.join(ROOT, 'node_modules'),
  '/opt/wolfhouse/WH/node_modules',
].filter(Boolean).join(path.delimiter);
process.env.NODE_PATH = sharedNodePath;
require('module').Module._initPaths();

const DOMAIN = require('./lib/sunset-bookings-admin');
const DATA = require('./lib/sunset-bookings-admin-data');
const { getSunsetAdminUiBrowserSource } = require('./lib/sunset-admin-browser-source');

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function section(title) {
  console.log(`\n[sort-type] ${title}`);
}

function rowFromServices(services, bookingExtras) {
  return DOMAIN.buildBookingListRow({
    booking: Object.assign({
      booking_id: 'b1',
      booking_code: 'BK-1',
      guest_name: 'Ada',
      status: 'confirmed',
      created_at: '2026-07-01T10:00:00Z',
      total_amount_cents: 10000,
    }, bookingExtras || {}),
    services,
    collected_cents: 0,
    refunded_cents: 0,
  });
}

function main() {
  console.log('verify:sunset-bookings-admin-sort-type\n');

  // ── Sort params + defaults ───────────────────────────────────────────────
  section('1. sort/dir parse + first-click defaults');
  ok('default (no sort) → sort null, dir desc sentinel', (() => {
    const p = DOMAIN.parseListQuery({});
    return p.sort == null && p.dir === 'desc';
  })());
  ok('total first-click default DESC', DOMAIN.normalizeSortParams('total', null).dir === 'desc'
    && DOMAIN.SORT_FIRST_DIR.total === 'desc');
  ok('paid first-click default DESC', DOMAIN.normalizeSortParams('paid', null).dir === 'desc');
  ok('created first-click default DESC', DOMAIN.normalizeSortParams('created', null).dir === 'desc'
    && DOMAIN.SORT_FIRST_DIR.created === 'desc');
  ok('dates alias → created DESC', DOMAIN.normalizeSortParams('dates', null).sort === 'created'
    && DOMAIN.normalizeSortParams('dates', null).dir === 'desc');
  ok('booking first-click default DESC', DOMAIN.normalizeSortParams('booking', null).dir === 'desc');
  ok('guest first-click default DESC', DOMAIN.normalizeSortParams('guest', null).dir === 'desc');
  ok('type first-click default ASC', DOMAIN.normalizeSortParams('type', null).dir === 'asc');
  ok('status first-click default ASC', DOMAIN.normalizeSortParams('status', null).dir === 'asc');
  ok('explicit dir honored', DOMAIN.normalizeSortParams('total', 'asc').dir === 'asc');
  ok('unknown sort ignored', DOMAIN.normalizeSortParams('nope', 'asc').sort == null);
  ok('alias booking_code → booking', DOMAIN.normalizeSortParams('booking_code', 'asc').sort === 'booking');

  section('2. server-side sort of full set (not page-only)');
  const sample = [
    {
      booking_id: '1', booking_code: 'C', guest_name: 'Zed', service_date_start: '2026-07-10',
      total_cents: 100, paid_cents: 50, status: 'unpaid', created_at: '2026-07-03T00:00:00Z',
      type_categories: ['rentals'],
    },
    {
      booking_id: '2', booking_code: 'A', guest_name: 'Amy', service_date_start: '2026-07-01',
      total_cents: 900, paid_cents: 900, status: 'paid', created_at: '2026-07-01T00:00:00Z',
      type_categories: ['lessons'],
    },
    {
      booking_id: '3', booking_code: 'B', guest_name: 'Bea', service_date_start: '2026-07-05',
      total_cents: 500, paid_cents: 0, status: 'partial', created_at: '2026-07-02T00:00:00Z',
      type_categories: ['accommodation', 'lessons'],
    },
  ];
  ok('default sort created_at DESC', (() => {
    const s = DOMAIN.sortBookingRows(sample, null, null);
    return s.map((r) => r.booking_code).join(',') === 'C,B,A';
  })());
  ok('total DESC highest first', (() => {
    const s = DOMAIN.sortBookingRows(sample, 'total', 'desc');
    return s.map((r) => r.total_cents).join(',') === '900,500,100';
  })());
  ok('total ASC lowest first', (() => {
    const s = DOMAIN.sortBookingRows(sample, 'total', 'asc');
    return s.map((r) => r.total_cents).join(',') === '100,500,900';
  })());
  ok('created ASC oldest first', (() => {
    const s = DOMAIN.sortBookingRows(sample, 'created', 'asc');
    return s.map((r) => r.created_at).join(',') === '2026-07-01T00:00:00Z,2026-07-02T00:00:00Z,2026-07-03T00:00:00Z';
  })());
  ok('created DESC newest first', (() => {
    const s = DOMAIN.sortBookingRows(sample, 'created', 'desc');
    return s.map((r) => r.booking_code).join(',') === 'C,B,A';
  })());
  ok('guest DESC Z first', (() => {
    const s = DOMAIN.sortBookingRows(sample, 'guest', 'desc');
    return s[0].guest_name === 'Zed';
  })());
  ok('booking ASC A first', (() => {
    const s = DOMAIN.sortBookingRows(sample, 'booking', 'asc');
    return s.map((r) => r.booking_code).join(',') === 'A,B,C';
  })());
  ok('status ASC', (() => {
    const s = DOMAIN.sortBookingRows(sample, 'status', 'asc');
    return s.map((r) => r.status).join(',') === 'paid,partial,unpaid';
  })());
  ok('paid DESC', (() => {
    const s = DOMAIN.sortBookingRows(sample, 'paid', 'desc');
    return s.map((r) => r.paid_cents).join(',') === '900,50,0';
  })());
  ok('type ASC lessons before rentals', (() => {
    const s = DOMAIN.sortBookingRows(sample, 'type', 'asc');
    // accommodation,lessons < lessons < rentals
    return s[0].booking_code === 'B' && s[1].booking_code === 'A' && s[2].booking_code === 'C';
  })());
  ok('sort does not mutate input', (() => {
    const copy = sample.slice();
    DOMAIN.sortBookingRows(sample, 'total', 'asc');
    return sample[0].booking_code === 'C' && copy[0] === sample[0];
  })());

  section('3. dynamic ORDER BY SQL whitelist');
  ok('default ORDER BY created_at DESC', /ORDER BY b\.created_at DESC/i.test(
    DOMAIN.buildListBookingsOrderBySql(null, null),
  ));
  ok('booking ASC order by booking_code', (() => {
    const sql = DOMAIN.buildListBookingsOrderBySql('booking', 'asc');
    return /ORDER BY b\.booking_code ASC/i.test(sql) && !/DROP|DELETE|;/.test(sql);
  })());
  ok('guest DESC order by guest_name', /ORDER BY b\.guest_name DESC/i.test(
    DOMAIN.buildListBookingsOrderBySql('guest', 'desc'),
  ));
  ok('injection rejected — falls back', (() => {
    const sql = DOMAIN.buildListBookingsOrderBySql('booking_code; drop table', 'asc');
    return /created_at DESC/i.test(sql) && !/drop table/i.test(sql);
  })());
  ok('buildListBookingsSql wires ORDER BY', (() => {
    const sql = DATA.buildListBookingsSql('booking', 'desc');
    return /FROM bookings b/i.test(sql) && /ORDER BY b\.booking_code DESC/i.test(sql);
  })());
  ok('LIST_BOOKINGS_SQL still defaults created_at', /ORDER BY b\.created_at DESC/i.test(
    DATA.LIST_BOOKINGS_SQL,
  ));

  // ── Type categories ──────────────────────────────────────────────────────
  section('4. Type = 3 buckets, multi-chip, course equipment excluded');
  ok('lesson only → Lessons', (() => {
    const r = rowFromServices([{ service_type: 'surf_lesson', service_date: '2026-07-10', status: 'active' }]);
    return JSON.stringify(r.type_categories) === JSON.stringify(['lessons'])
      && r.what_summary === 'Lessons';
  })());
  ok('standalone board rental → Rentals', (() => {
    const r = rowFromServices([{
      service_type: 'rental',
      service_date: '2026-07-10',
      status: 'active',
      metadata: { component: 'board_rental', staff_ui_service_type: 'rental' },
    }]);
    return JSON.stringify(r.type_categories) === JSON.stringify(['rentals']);
  })());
  ok('accommodation → Accommodation', (() => {
    const r = rowFromServices([{ service_type: 'accommodation', service_date: '2026-07-10', status: 'active' }]);
    return JSON.stringify(r.type_categories) === JSON.stringify(['accommodation'])
      && r.type_flags && r.type_flags.accommodation === true;
  })());
  ok('staff_accommodation addon_service → Accommodation (not unknown)', (() => {
    const r = rowFromServices([{
      service_type: 'addon_service',
      service_date: '2026-07-10',
      status: 'active',
      metadata: {
        source: 'staff_accommodation',
        staff_accommodation: true,
        component: 'staff_accommodation',
        staff_ui_service_type: 'staff_accommodation',
        check_in: '2026-07-10',
        check_out: '2026-07-12',
        nights: 2,
      },
    }]);
    return JSON.stringify(r.type_categories) === JSON.stringify(['accommodation'])
      && r.type_flags.accommodation === true
      && r.what_summary === 'Accommodation';
  })());
  ok('course + course-included equip → Lessons only (no Rentals)', (() => {
    const r = rowFromServices([
      { service_type: 'surf_lesson', service_date: '2026-07-10', status: 'active', metadata: { component: 'course' } },
      {
        service_type: 'rental',
        service_date: '2026-07-10',
        status: 'active',
        metadata: {
          pricing_provenance: 'course_owned_equipment',
          course_equipment_mode: 'during_course',
          during_course_policy: 'included',
          component: 'board_rental',
        },
      },
    ]);
    return JSON.stringify(r.type_categories) === JSON.stringify(['lessons'])
      && !r.type_categories.includes('rentals');
  })());
  ok('course + standalone all_day rental → Lessons · Rentals', (() => {
    const r = rowFromServices([
      { service_type: 'surf_lesson', service_date: '2026-07-10', status: 'active', metadata: { component: 'course' } },
      {
        service_type: 'rental',
        service_date: '2026-07-10',
        status: 'active',
        metadata: {
          staff_ui_service_type: 'rental',
          component: 'board_and_suit_rental',
          course_equipment_mode: 'all_day',
          mode: 'all_day',
          rental_offering: true,
        },
      },
    ]);
    return JSON.stringify(r.type_categories) === JSON.stringify(['lessons', 'rentals']);
  })());
  ok('included_equipment flag alone never Rentals', (() => {
    const r = rowFromServices([{
      service_type: 'wetsuit',
      status: 'active',
      metadata: { included_equipment: true, included_course_id: 'c1' },
    }]);
    return r.type_categories.includes('lessons') && !r.type_categories.includes('rentals');
  })());
  ok('yoga flagged unknown (not guessed)', (() => {
    const info = DOMAIN.buildTypeCategories([
      { service_type: 'yoga', status: 'active' },
    ]);
    return info.type_categories.length === 0
      && info.type_categories_unknown.includes('yoga');
  })());
  ok('meal flagged unknown', (() => {
    const info = DOMAIN.buildTypeCategories([{ service_type: 'meal', status: 'active' }]);
    return info.type_categories_unknown.includes('meal');
  })());
  ok('multi buckets stable order Lessons·Rentals·Accommodation', (() => {
    const r = rowFromServices([
      { service_type: 'accommodation', status: 'active' },
      { service_type: 'rental', status: 'active', metadata: { staff_ui_service_type: 'rental' } },
      { service_type: 'surf_lesson', status: 'active' },
    ]);
    return JSON.stringify(r.type_categories) === JSON.stringify(['lessons', 'rentals', 'accommodation'])
      && r.what_summary === 'Lessons · Rentals · Accommodation';
  })());
  ok('filter type=lessons matches type_categories', (() => {
    const r = rowFromServices([{ service_type: 'surf_lesson', status: 'active' }]);
    return DOMAIN.bookingMatchesType(r, 'lessons') === true
      && DOMAIN.bookingMatchesType(r, 'rentals') === false;
  })());
  ok('legacy filter surf_lesson maps to lessons', (() => {
    const r = rowFromServices([{ service_type: 'surf_lesson', status: 'active' }]);
    return DOMAIN.bookingMatchesType(r, 'surf_lesson') === true;
  })());
  ok('private lesson grouped as Lessons (no private split)', (() => {
    const r = rowFromServices([{
      service_type: 'surf_lesson',
      status: 'active',
      metadata: { component: 'private_lesson' },
    }]);
    return JSON.stringify(r.type_categories) === JSON.stringify(['lessons']);
  })());

  // ── UI / CSS gates ───────────────────────────────────────────────────────
  section('5. UI sort headers, Type plain text, alignment, dark chips');
  const ui = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
  const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  let browserSrc = '';
  try {
    browserSrc = getSunsetAdminUiBrowserSource() || '';
  } catch (_e) {
    browserSrc = ui;
  }

  ok('UI sortable headers data-bookings-sort', /data-bookings-sort/.test(ui));
  ok('UI col.type header key', /admin\.bookings\.col\.type/.test(ui));
  ok('UI col.created header key', /admin\.bookings\.col\.created/.test(ui));
  ok('UI type plain-text renderer', /adminBookingsTypeChipsHtml/.test(ui) && /portal-admin-bookings-type-text/.test(ui));
  ok('UI no type-chip classes', !/portal-admin-bookings-type-chip--/.test(ui));
  ok('UI sends sort+dir query params', /params\.set\('sort'/.test(ui) && /params\.set\('dir'/.test(ui));
  ok('UI first-click defaults Total/Paid DESC', /total:\s*'desc'/.test(ui) && /paid:\s*'desc'/.test(ui));
  ok('UI first-click created DESC', /created:\s*'desc'/.test(ui));
  ok('UI restore action present', /data-bookings-restore/.test(ui));
  ok('UI restore gated not-hidden', /!isHidden/.test(ui) && /data-bookings-restore/.test(ui));
  ok('UI type filter uses 3 buckets', /value="lessons"/.test(ui) && /value="rentals"/.test(ui)
    && /value="accommodation"/.test(ui));
  ok('UI th-num right-align class', /portal-admin-bookings-th-num/.test(ui));
  ok('CSS th-num text-align right', /\.portal-admin-bookings-th-num\{[^}]*text-align:right/.test(api));
  ok('CSS Status column wider (minmax 132)', /minmax\(132px/.test(api));
  ok('CSS Booking wider (minmax 128)', /minmax\(128px,1\.15fr\)/.test(api));
  ok('CSS Type narrower (minmax 88)', /minmax\(88px,\.75fr\)/.test(api));
  ok('CSS status chips centered', /\.portal-admin-bookings-td-status\{[^}]*justify-content:center/.test(api));
  ok('CSS chip paid dark palette', /chip--paid\{color:#86efac;[^}]*background:rgba\(34,197,94,\.15\)/.test(api));
  ok('CSS chip unpaid dark palette', /chip--unpaid\{color:#cbd5e1;[^}]*background:rgba\(148,163,184,\.15\)/.test(api));
  ok('CSS chip partial dark palette', /chip--partial\{color:#5eead4;[^}]*background:rgba\(20,184,166,\.15\)/.test(api));
  ok('CSS chip refunded dark palette', /chip--refunded\{color:#d8b4fe;[^}]*background:rgba\(168,85,247,\.15\)/.test(api));
  ok('CSS chip cancelled dark palette', /chip--cancelled\{color:#fca5a5;[^}]*background:rgba\(239,68,68,\.15\)/.test(api));
  ok('CSS chip refund_needed dark palette', /chip--refund_needed\{color:#fcd34d;[^}]*background:rgba\(245,158,11,\.18\)/.test(api));
  ok('CSS chip hidden dark palette', /chip--hidden\{color:#cbd5e1;[^}]*background:rgba\(100,116,139,\.18\)/.test(api));
  ok('CSS chips smaller padding/font', /\.portal-admin-bookings-chip\{[^}]*padding:2px 7px;[^}]*font-size:10px/.test(api));
  ok('i18n col.type present EN', (() => {
    const i18n = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
    return /'admin\.bookings\.col\.type':\s*'Type'/.test(i18n)
      && /'admin\.bookings\.col\.created':\s*'Created'/.test(i18n)
      && /'admin\.bookings\.action\.restore'/.test(i18n)
      && /'admin\.bookings\.refundNeedsCancel'/.test(i18n);
  })());
  ok('browser source includes bookings UI or ui file present', browserSrc.length > 0 || ui.length > 0);

  // ── listSunsetBookingsAdmin integrates sort ──────────────────────────────
  section('6. list path sorts before page slice');
  const dataSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-bookings-admin-data.js'), 'utf8');
  ok('listSunsetBookingsAdmin calls sortBookingRows', /sortBookingRows\(filtered/.test(dataSrc));
  ok('list returns sort/dir in filters', /sort:\s*filters\.sort/.test(dataSrc));
  ok('export also sorts', /sortBookingRows\(filtered/.test(dataSrc)
    && /exportSunsetBookingsAdminCsv[\s\S]*sortBookingRows/.test(dataSrc));

  console.log(`\n── verify:sunset-bookings-admin-sort-type: ${pass} passed, ${fail} failed ──`);
  process.exit(fail ? 1 : 0);
}

main();
