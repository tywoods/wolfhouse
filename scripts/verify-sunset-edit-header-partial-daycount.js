'use strict';

/**
 * P2 — Edit header Partial (not Unpaid) + day-count/duration label consistency.
 *
 * Offline only. No DB / Azure / network / inbox-thread / email / Full Wipe.
 * Staff API cash + payment_status remain authority — labels must not invent money.
 *
 * Run: node scripts/verify-sunset-edit-header-partial-daycount.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const ACTIONS = path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-actions.js');
const EDIT = path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-edit-ui.js');
const VIEW = path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-view-ui.js');
const PORTAL = path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js');
const DAY_OPS = path.join(ROOT, 'scripts/browser/sunset-schedule-day-ops-board-ui.js');
const DRAWER = path.join(ROOT, 'scripts/lib/sunset-schedule-booking-drawer.js');
const EN = path.join(ROOT, 'scripts/lib/staff-portal-i18n.js');
const ES = path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');

const actionsSrc = fs.readFileSync(ACTIONS, 'utf8');
const editSrc = fs.readFileSync(EDIT, 'utf8');
const viewSrc = fs.readFileSync(VIEW, 'utf8');
const portalSrc = fs.readFileSync(PORTAL, 'utf8');
const dayOpsSrc = fs.readFileSync(DAY_OPS, 'utf8');
const enSrc = fs.readFileSync(EN, 'utf8');
const esSrc = fs.readFileSync(ES, 'utf8');
const threadBefore = fs.readFileSync(THREAD, 'utf8');

const {
  deriveDrawerPaymentUiStatus,
  buildPaymentSummary,
} = require('./lib/sunset-schedule-booking-drawer');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

function extractFn(src, name) {
  const needle = 'function ' + name + '(';
  const start = src.indexOf(needle);
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

console.log('\nverify:sunset-edit-header-partial-daycount\n');

console.log('[1] Drawer payment UI status preserves Partial');
ok('cash partial → partial', deriveDrawerPaymentUiStatus({ payment_status: 'unpaid' }, 50000, 10000) === 'partial');
ok('cash paid in full → paid', deriveDrawerPaymentUiStatus({ payment_status: 'unpaid' }, 50000, 50000) === 'paid');
ok('zero paid stays unpaid', deriveDrawerPaymentUiStatus({ payment_status: 'waiting_payment' }, 50000, 0) === 'unpaid');
ok('API deposit_paid → partial', deriveDrawerPaymentUiStatus({ payment_status: 'deposit_paid' }, 50000, 0) === 'partial');
ok('API partially_paid → partial', deriveDrawerPaymentUiStatus({ payment_status: 'partially_paid' }, 80000, 0) === 'partial');
ok('API partial → partial', deriveDrawerPaymentUiStatus({ payment_status: 'partial' }, 80000, 0) === 'partial');

const summary = buildPaymentSummary([], {
  payment_status: 'unpaid',
  amount_paid_cents: 12000,
  total_amount_cents: 40000,
  metadata: {},
}, [{
  service_record_id: 'sr-1',
  service_type: 'surf_lesson',
  service_date: '2026-09-01',
  quantity: 1,
  amount_due_cents: 40000,
  metadata: JSON.stringify({ component: 'course', course_label: 'Sandra Course' }),
}], 'config', 12000);
ok('buildPaymentSummary stamps payment_status=partial', summary.payment_status === 'partial', summary.payment_status);
ok('buildPaymentSummary keeps Staff API paid cents', summary.paid_cents === 12000);
ok('buildPaymentSummary balance = subtotal − paid', summary.balance_due_cents === 28000);

console.log('\n[2] schedulePaymentStatusLabel shows Partial (not Unpaid)');
const labelBox = {
  portalT: (k) => ({
    'schedule.payment.paid': 'Paid',
    'schedule.payment.unpaid': 'Unpaid',
    'schedule.payment.partial': 'Partial',
    'schedule.payment.pending': 'Pending',
    'schedule.payment.paidBankTransfer': 'Paid - Bank Transfer',
    'schedule.payment.paidInStore': 'Paid - Cash',
    'schedule.payment.paidViaLink': 'Paid - Stripe',
  }[k] || k),
  SunsetScheduleDrawerActions: null,
  schedulePaymentStatusLabel: null,
};
vm.createContext(labelBox);
vm.runInContext(actionsSrc + '\nthis.schedulePaymentStatusLabel = schedulePaymentStatusLabel;', labelBox);
const label = labelBox.schedulePaymentStatusLabel;
ok('partial → Partial', label('partial') === 'Partial');
ok('partially_paid → Partial', label('partially_paid') === 'Partial');
ok('deposit_paid → Partial', label('deposit_paid') === 'Partial');
ok('unpaid → Unpaid', label('unpaid') === 'Unpaid');
ok('paid → Paid', label('paid') === 'Paid');
ok('paid + link keeps method label', label('paid', 'link') === 'Paid - Stripe');

console.log('\n[3] Edit header owns Partial from cash / payment snapshot');
ok('edit header derives hdrStatus (not raw unpaid collapse)',
  /hdrFullyPaid/.test(editSrc) && /hdrStatus/.test(editSrc)
  && /'partial'/.test(editSrc)
  && /schedulePaymentStatusLabel\(hdrStatus/.test(editSrc));
ok('edit payment section coerces paid>0 unpaid → partial',
  /rawPayStatus\.toLowerCase\(\) !== 'unpaid' \? rawPayStatus : 'partial'/.test(editSrc));
ok('view payment section same partial coerce',
  /rawPayStatus\.toLowerCase\(\) !== 'unpaid' \? rawPayStatus : 'partial'/.test(viewSrc));

console.log('\n[4] EN/ES Partial copy');
ok('EN schedule.payment.partial', /'schedule\.payment\.partial': 'Partial'/.test(enSrc));
ok('ES schedule.payment.partial', /'schedule\.payment\.partial': 'Parcial'/.test(esSrc));

console.log('\n[5] 8–14 span must not display Admin "7 days" label');
ok('portal formats inclusive days label helper',
  /function schedulePortalFormatInclusiveDaysLabel/.test(portalSrc));
ok('8–14 tier_label uses span days not seven.label alone',
  /schedulePortalFormatInclusiveDaysLabel\(days\)/.test(portalSrc)
  && /pricing_basis: '7_days_prorate'/.test(portalSrc));
ok('duration confirm prefers duration_days span label',
  /schedulePortalFormatInclusiveDaysLabel\(derived\.duration_days\)/.test(editSrc));
ok('commercial lines prefer covered day count when key disagrees',
  /Number\(keyDays\) !== n/.test(viewSrc));

const portalBox = {
  portalT: (k) => ({
    'schedule.drawer.dayWordCap': 'Day',
    'schedule.drawer.daysWordCap': 'Days',
    'schedule.create.courseDurationUnavailable': 'unavailable',
    'schedule.create.courseRequired': 'required',
    'calendar.state.invalidDateRange': 'invalid',
  }[k] || k),
  scheduleCoursesCache: [{
    course_id: 'c1',
    price_tiers: [
      { key: '7_days', label: '7 days', duration_days: 7, bookable: true, offering_id: 'o7' },
      { key: '5_days', label: '5 days', duration_days: 5, bookable: true, offering_id: 'o5' },
    ],
  }],
  scheduleEnumerateDates: (from, to) => {
    const out = [];
    const a = new Date(from + 'T12:00:00Z');
    const b = new Date(to + 'T12:00:00Z');
    for (let d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) {
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  },
  schedulePortalCanonicalDateIso: (v) => String(v || '').slice(0, 10),
};
vm.createContext(portalBox);
const portalFns = [
  extractFn(portalSrc, 'schedulePortalInclusiveDateCount'),
  extractFn(portalSrc, 'schedulePortalFormatInclusiveDaysLabel'),
  extractFn(portalSrc, 'schedulePortalMatchSellableCourseTiersByDurationDays'),
  extractFn(portalSrc, 'schedulePortalResolveDerivedCourseTier'),
].join('\n');
vm.runInContext(
  portalFns
  + '\nthis.schedulePortalInclusiveDateCount=schedulePortalInclusiveDateCount;'
  + '\nthis.schedulePortalFormatInclusiveDaysLabel=schedulePortalFormatInclusiveDaysLabel;'
  + '\nthis.schedulePortalResolveDerivedCourseTier=schedulePortalResolveDerivedCourseTier;',
  portalBox,
);
ok('14-day span label is 14 Days', portalBox.schedulePortalFormatInclusiveDaysLabel(14) === '14 Days');
const derived14 = portalBox.schedulePortalResolveDerivedCourseTier('c1', '2026-09-01', '2026-09-14');
ok('14-day derive ok + pricing basis 7_days_prorate',
  derived14 && derived14.ok && derived14.pricing_basis === '7_days_prorate'
  && derived14.tier_key === '7_days' && derived14.duration_days === 14);
ok('14-day tier_label is 14 Days not 7 days',
  derived14 && derived14.tier_label === '14 Days',
  derived14 && derived14.tier_label);

const derived7 = portalBox.schedulePortalResolveDerivedCourseTier('c1', '2026-09-01', '2026-09-07');
ok('exact 7-day still uses catalog label path or 7 Days',
  derived7 && derived7.ok && derived7.duration_days === 7
  && (derived7.tier_label === '7 days' || derived7.tier_label === '7 Days'));

console.log('\n[6] Day N of M extends incomplete explicit dates via peers/singles');
const dayBox = {
  portalT: (k, vars) => {
    if (k === 'schedule.card.dayProgress') {
      return 'Day ' + vars.day + ' of ' + vars.total;
    }
    return k;
  },
  t: null,
  scheduleEnumerateDates: portalBox.scheduleEnumerateDates,
  scheduleParseIso: (iso) => new Date(String(iso).slice(0, 10) + 'T12:00:00Z'),
  scheduleAddDays: (d, n) => {
    const x = new Date(d.getTime());
    x.setUTCDate(x.getUTCDate() + n);
    return x;
  },
  scheduleIsoDate: (d) => d.toISOString().slice(0, 10),
  scheduleGetRowsSnapshot: () => {
    const dates = [];
    for (let i = 0; i < 14; i += 1) {
      const d = new Date(Date.UTC(2026, 8, 1 + i, 12));
      dates.push({
        booking_id: 'bk-sandra',
        service_date: d.toISOString().slice(0, 10),
      });
    }
    return dates;
  },
  escHtml: (s) => String(s),
};
dayBox.t = dayBox.portalT;
vm.createContext(dayBox);
vm.runInContext(
  extractFn(dayOpsSrc, 'scheduleDayOpsIsoDateToken') + '\n'
  + extractFn(dayOpsSrc, 'scheduleDayOpsParseMetaBlob') + '\n'
  + extractFn(dayOpsSrc, 'scheduleCanonicalBookedServiceDates') + '\n'
  + extractFn(dayOpsSrc, 'scheduleBookingDayProgress') + '\n'
  + 'this.scheduleCanonicalBookedServiceDates=scheduleCanonicalBookedServiceDates;'
  + 'this.scheduleBookingDayProgress=scheduleBookingDayProgress;',
  dayBox,
);

const shortExplicit = {
  booking_id: 'bk-sandra',
  service_date: '2026-09-07',
  // Stale/short explicit array (pricing-tier length) must not hide 14 peer service days.
  service_dates: [
    '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
    '2026-09-05', '2026-09-06', '2026-09-07',
  ],
  date_from: '2026-09-01',
  date_to: '2026-09-14',
};
const dates = dayBox.scheduleCanonicalBookedServiceDates(shortExplicit);
ok('peer snapshot extends Day N total to 14',
  Array.isArray(dates) && dates.length === 14, dates && dates.length);
const progress = dayBox.scheduleBookingDayProgress('2026-09-07', shortExplicit);
ok('Day 7 of 14 (not of 7)',
  progress && progress.day === 7 && progress.total === 14,
  progress && JSON.stringify(progress));

console.log('\n[7] Stay-off constraints');
ok('inbox-thread.js untouched', fs.readFileSync(THREAD, 'utf8') === threadBefore);
ok('no Full Wipe / Simulate Guest edits in this slice',
  !/Full Wipe|Simulate Guest/.test(actionsSrc.slice(0, 200)));
ok('drawer lib still exported',
  /deriveDrawerPaymentUiStatus/.test(fs.readFileSync(DRAWER, 'utf8')));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
assert.ok(fail === 0);
console.log('PASS edit-header Partial + day-count consistency');
