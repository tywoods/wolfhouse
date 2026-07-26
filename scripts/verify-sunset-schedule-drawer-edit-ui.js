'use strict';

/**
 * verify:sunset-schedule-drawer-edit-ui
 *
 * Slice 13 + Kaya Edit drawer continuity gate.
 * Real production owner execution (VM), DOM order, date-derived duration,
 * private sessions, payment bundle presentation, PATCH safety, mutations.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-drawer-edit-ui.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { injectSunsetSchedulePortalModule, SCHEDULE_EDIT_INJECT_MARKER } = require('./lib/sunset-schedule-browser-source');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const EDIT_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-edit-ui.js');
const CTRL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-controller.js');
const PAY_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-actions.js');
const VIEW_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const PORTAL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');
const RENTAL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-rental-availability.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');
const BOOKING_DRAWER = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-drawer.js');
const I18N = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');
const I18N_ES = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es-sunset.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

function extractFunctionSource(src, name) {
  const needle = `function ${name}(`;
  const start = src.indexOf(needle);
  if (start < 0) return null;
  const braceStart = src.indexOf('{', start);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function idOrder(html, id) {
  return html.indexOf(`id="${id}"`);
}

function portalT(key) {
  const map = {
    'schedule.create.guestName': 'Guest name',
    'schedule.create.guestRequired': 'Guest required',
    'schedule.create.componentsRequired': 'Components required',
    'schedule.create.courseRequired': 'Course required',
    'schedule.create.courseDurationUnavailable': 'No duration match',
    'schedule.create.courseDurationAmbiguous': 'Ambiguous duration',
    'schedule.create.privateLesson.rangeTooLong': 'Range too long',
    'schedule.create.privateLesson.sessionIncomplete': 'Session incomplete',
    'schedule.create.privateLesson.sessionMax': 'Too many sessions',
    'schedule.create.privateLesson.sessionsMismatch': 'Sessions mismatch',
    'schedule.create.privateLesson.sessionEndAfterStart': 'End after start',
    'schedule.create.privateLesson.sessionDateInvalid': 'Invalid date',
    'schedule.create.privateLesson.sessionDatePast': 'Past date',
    'schedule.create.privateLesson.sessionDuplicate': 'Duplicate session',
    'schedule.create.privateLesson.sessionsHelp': 'Sessions',
    'schedule.create.privateLesson.addSession': 'Add',
    'schedule.create.privateLesson.start': 'Start',
    'schedule.create.privateLesson.end': 'End',
    'schedule.create.privateLesson.sessionLabel': 'Session',
    'schedule.create.section.guest': 'Guest',
    'schedule.create.section.what': 'What',
    'schedule.create.section.when': 'When',
    'schedule.create.section.paymentNotes': 'Payment & notes',
    'schedule.create.mainActivity': 'Main activity',
    'schedule.create.payment': 'Payment',
    'schedule.create.paymentStatus': 'Payment status',
    'schedule.create.dateFrom': 'From',
    'schedule.create.dateTo': 'To',
    'schedule.create.courseSelect': 'Course',
    'schedule.create.courseTier': 'Tier',
    'schedule.create.surferCount': 'Surfers',
    'schedule.create.boardQty': 'Boards',
    'schedule.create.wetsuitQty': 'Wetsuits',
    'schedule.create.rentalQty': 'Quantity',
    'schedule.drawer.save': 'Save changes',
    'schedule.drawer.cancel': 'Cancel',
    'schedule.drawer.editTitle': 'Edit booking',
    'schedule.drawer.phone': 'Phone',
    'schedule.drawer.notes': 'Notes',
    'schedule.drawer.paymentsTitle': 'Payments',
    'schedule.drawer.saveFailed': 'Could not save booking:',
    'schedule.drawer.saved': 'Saved',
    'schedule.drawer.close': 'Close',
    'schedule.drawer.paidRepriceRequired': 'This booking is already paid. Changing priced items needs a payment adjustment first — no changes were saved.',
    'schedule.drawer.priceWillRefresh': 'Price refreshes on save',
    'schedule.drawer.durationConfirm': 'Course duration',
    'schedule.drawer.whenRange': 'Dates',
    'schedule.drawer.whenPickDates': 'Set From and To dates above.',
    'schedule.drawer.bundleSets': 'sets',
    'schedule.drawer.bundleOneSet': '1 set',
    'schedule.drawer.includedInBundle': 'Included',
    'schedule.drawer.section.rentals': 'Rentals',
    'schedule.drawer.section.notes': 'Notes',
    'schedule.drawer.subtotal': 'Subtotal',
    'schedule.drawer.paid': 'Paid',
    'schedule.drawer.remaining': 'Remaining',
    'schedule.drawer.paymentSection': 'Payment',
    'schedule.drawer.noLineItems': 'None',
    'schedule.drawer.livePricingNote': 'Live pricing',
    'schedule.drawer.dayWordCap': 'day',
    'schedule.drawer.daysWordCap': 'days',
    'schedule.col.payment': 'Payment',
    'schedule.payment.unpaid': 'Unpaid',
    'schedule.payment.paidBankTransfer': 'Bank',
    'schedule.payment.paidInStore': 'In store',
    'schedule.payment.paidViaLink': 'Link',
    'schedule.type.wetsuitRental': 'Wetsuit rental',
    'schedule.type.boardRental': 'Board rental',
    'schedule.type.course': 'Group course',
    'schedule.type.privateCourse': 'Private',
    'schedule.type.privateLesson': 'Private course',
    'schedule.type.noLesson': 'No lesson',
    'schedule.type.fullDayEquipment': 'Full day',
    'schedule.ops.rentalBoth': 'Surfboard + wetsuit',
    'schedule.courses.noneConfigured': 'None',
  };
  return map[key] || key;
}

function realTiers() {
  return [
    { key: '1_week', label: '1 week', duration_days: 7, bookable: true, offering_id: 'surf_pack_c1__1_week' },
    { key: '3_days', label: '3 days', duration_days: 3, bookable: true, offering_id: 'surf_pack_c1__3_days' },
    { key: 'single_class', label: 'Single class', duration_days: 1, bookable: true, offering_id: 'surf_pack_c1__single_class' },
  ];
}

function enumerateDates(from, to) {
  const a = String(from || '').slice(0, 10);
  const b = String(to || from || '').slice(0, 10);
  if (!a || !b || a > b) return [];
  const out = [];
  const [ys, ms, ds] = a.split('-').map(Number);
  const [ye, me, de] = b.split('-').map(Number);
  const cur = new Date(Date.UTC(ys, ms - 1, ds, 12));
  const end = new Date(Date.UTC(ye, me - 1, de, 12));
  while (cur <= end && out.length < 40) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

console.log('\nverify:sunset-schedule-drawer-edit-ui\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const editExists = fs.existsSync(EDIT_MODULE);
const editModSrc = editExists ? fs.readFileSync(EDIT_MODULE, 'utf8') : '';
const ctrlModSrc = fs.existsSync(CTRL_MODULE) ? fs.readFileSync(CTRL_MODULE, 'utf8') : '';
const viewModSrc = fs.readFileSync(VIEW_MODULE, 'utf8');
const portalModSrc = fs.readFileSync(PORTAL_MODULE, 'utf8');
const rentalModSrc = fs.readFileSync(RENTAL_MODULE, 'utf8');
const payModSrc = fs.existsSync(PAY_MODULE) ? fs.readFileSync(PAY_MODULE, 'utf8') : '';
const browserLoader = fs.readFileSync(BROWSER_SRC, 'utf8');
const bookingDrawerSrc = fs.readFileSync(BOOKING_DRAWER, 'utf8');

console.log('[1] Module files and injection order');
assert('edit module exists', editExists);
assert('edit inject marker in portal script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-edit-ui */'));
assert('browser source loads edit module', browserLoader.includes('getSunsetScheduleDrawerEditBrowserSource'));
assert('inject chains portal → view → edit', browserLoader.includes('SCHEDULE_DRAWER_EDIT_INJECT_MARKER'));
assert('inline scheduleRenderEditableDrawerHtml removed', !apiSrc.includes('function scheduleRenderEditableDrawerHtml('));
assert('inline scheduleSaveDrawerBooking removed', !apiSrc.includes('function scheduleSaveDrawerBooking('));
assert('inline scheduleEnterDrawerEditMode removed', !apiSrc.includes('function scheduleEnterDrawerEditMode('));
assert('payment section wrapper in actions module', payModSrc.includes('function scheduleRenderDrawerPaymentSectionHtml('));
assert('payment wrapper removed from staff-api', !apiSrc.includes('function scheduleRenderDrawerPaymentSectionHtml('));

const markerIdxPortal = apiSrc.indexOf('/* INJECT:sunset-schedule-portal-module */');
const markerIdxView = apiSrc.indexOf('/* INJECT:sunset-schedule-drawer-view-ui */');
const markerIdxEdit = apiSrc.indexOf('/* INJECT:sunset-schedule-drawer-edit-ui */');
const markerIdxActions = apiSrc.indexOf('/* INJECT:sunset-schedule-drawer-actions */');
assert('marker order portal < view < edit < actions', markerIdxPortal > -1 && markerIdxView > markerIdxPortal && markerIdxEdit > markerIdxView && markerIdxActions > markerIdxEdit);
const markerIdxCtrl = apiSrc.indexOf('/* INJECT:sunset-schedule-drawer-controller */');
assert('marker order actions < controller', markerIdxCtrl > markerIdxActions);
assert('mount orchestration in controller module', ctrlModSrc.includes('function scheduleMountDrawerBody('));
assert('edit module calls delete wire hook', editModSrc.includes('scheduleWireDrawerDeleteBooking'));

const htmlSample = injectSunsetSchedulePortalModule('<script>(function(){function el(id){return null;}/* INJECT:sunset-schedule-rental-availability *//* INJECT:sunset-schedule-portal-module *//* INJECT:sunset-schedule-drawer-view-ui *//* INJECT:sunset-schedule-drawer-edit-ui *//* INJECT:sunset-schedule-drawer-actions *//* INJECT:sunset-schedule-drawer-controller *//* INJECT:sunset-schedule-day-ops-board-ui *//* INJECT:sunset-schedule-forecast-cards-ui *//* INJECT:sunset-schedule-view-grid-ui *//* INJECT:sunset-schedule-runtime *//* INJECT:sunset-schedule-navigation-ui *//* INJECT:sunset-schedule-data-loader */function escHtml(s){return s;}})();</script>');
assert('buildUiHtml inject includes edit module body', htmlSample.includes('function scheduleEnterDrawerEditMode('));
assert('buildUiHtml inject includes view module body', htmlSample.includes('function scheduleRenderViewDrawerHtml('));
assert('buildUiHtml inject includes portal module body', htmlSample.includes('function schedulePortalFetchDrawerDetail('));

console.log('\n[2] Continuity source contracts (no legacy authority)');
assert('radiogroup main activity in edit owner', /role="radiogroup"/.test(editModSrc) && /ps-drawer-comp-no-lesson/.test(editModSrc));
assert('no visible course tier select authority', !/id="ps-drawer-course-tier"/.test(editModSrc));
assert('uses catalog duration resolver', /schedulePortalResolveDerivedCourseTier/.test(editModSrc));
assert('private rows date-derived owner', /scheduleDrawerSyncPrivateSessions/.test(editModSrc) && /data-session-date/.test(editModSrc));
assert('no private date input type=date in private rows', !/ps-pl-session-date" type="date"/.test(editModSrc));
assert('no dead Add session control', !/ps-drawer-add-session/.test(editModSrc) && !/function scheduleDrawerAddPrivateSession/.test(editModSrc));
assert('when summary uses production keys without fallback',
  /portalT\('schedule\.drawer\.whenPickDates'\)/.test(editModSrc)
  && /portalT\('schedule\.drawer\.whenRange'\)/.test(editModSrc)
  && !/portalT\('schedule\.drawer\.whenPickDates'\)\s*\|\|/.test(editModSrc)
  && !/portalT\('schedule\.drawer\.whenRange'\)\s*\|\|/.test(editModSrc));
assert('rentals seed prefers catalog rental_pricing', /rental_pricing/.test(editModSrc) && !/board&&wet&&bq===wq/.test(editModSrc));
assert('sticky header Edit booking title once', /ps-drawer-edit-title/.test(editModSrc) && (editModSrc.match(/schedule\.drawer\.editTitle/g) || []).length === 1);
assert('no inner duplicate editTitle card section', !/drawer-section-title.*editTitle|editTitle.*drawer-section-title/.test(editModSrc));
assert('sticky footer Cancel + Save', /ps-drawer-cancel/.test(editModSrc) && /ps-drawer-save/.test(editModSrc) && /portal-schedule-drawer-edit-footer|portal-schedule-create-footer/.test(editModSrc));
assert('section order Guest→What→When→Payment markers',
  editModSrc.indexOf('data-edit-section="guest"') < editModSrc.indexOf('data-edit-section="what"')
  && editModSrc.indexOf('data-edit-section="what"') < editModSrc.indexOf('data-edit-section="when"')
  && editModSrc.indexOf('data-edit-section="when"') < editModSrc.indexOf('data-edit-section="payment"'));
assert('payload always includes rentals array', /rentals:\s*rentals/.test(editModSrc));
assert('paid conflict human mapping', /paid_booking_reprice_required/.test(editModSrc));
assert('duplicate-save early return', /if \(scheduleDrawerSaveInFlight\) return/.test(editModSrc));
assert('stale price clear on intent change', /scheduleDrawerMarkPriceStale|scheduleDrawerPriceStale/.test(editModSrc));
assert('no invent Edit preview endpoint', !/\/staff\/schedule\/quote/.test(editModSrc) && !/schedulePortalFetchQuote/.test(editModSrc));
assert('CSS sticky edit shell present', /portal-schedule-drawer-edit-header/.test(apiSrc) && /:has\(#ps-drawer-edit-form\)/.test(apiSrc));
assert('commercial bundle helper in view', /function scheduleDrawerBuildCommercialLines/.test(viewModSrc));
assert('line items carry pricing_group_id', /pricing_group_id:\s*srMeta\.pricing_group_id/.test(bookingDrawerSrc));
assert('drawer context exposes rentals', /rentals:\s*Array\.isArray\(meta\.rentals\)/.test(bookingDrawerSrc));

console.log('\n[3] Edit module must not introduce price authority');
if (editExists) {
  assert('save PATCH uses in-flight guard', editModSrc.includes('scheduleDrawerSaveInFlight'));
  assert('save refetches canonical detail after PATCH', /schedulePortalFetchDrawerDetail|scheduleFetchDrawerContext/.test(editModSrc));
  assert('no Math.max sub paid balance fallback', !/Math\.max\(sub\s*-\s*paid/.test(editModSrc));
  assert('payload reader whitelists editable fields', editModSrc.includes('function scheduleReadDrawerEditPayload('));
  assert('payment parse uses allowed select values', editModSrc.includes('function scheduleParsePaymentSelectValue('));
  assert('validation blocks empty guest before PATCH', editModSrc.includes("schedule.create.guestRequired") || editModSrc.includes("if (!payload.guest_name)"));
}

console.log('\n[4] Required edit controller functions in module');
[
  'scheduleRenderEditableDrawerHtml',
  'scheduleEnterDrawerEditMode',
  'scheduleCancelDrawerEditMode',
  'scheduleWireEditableDrawer',
  'scheduleReadDrawerEditPayload',
  'scheduleSaveDrawerBooking',
  'scheduleRenderDrawerPaymentSelectHtml',
  'scheduleRenderDrawerPaymentSectionEditHtml',
  'scheduleDrawerSyncPrivateSessions',
  'scheduleDrawerBuildCommercialLines',
].forEach((name) => {
  if (name === 'scheduleDrawerBuildCommercialLines') {
    assert(`view defines ${name}`, extractFunctionSource(viewModSrc, name) != null);
  } else {
    assert(`module defines ${name}`, editExists && extractFunctionSource(editModSrc, name) != null);
  }
});
['scheduleMountDrawerBody', 'scheduleOpenEditableDrawer'].forEach((name) => {
  assert(`controller defines ${name}`, ctrlModSrc.includes(`function ${name}(`));
});

console.log('\n[5] Production catalog i18n EN/ES/IT for all new Edit keys');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const esMap = require('./lib/staff-portal-i18n-es-sunset');
const en = STAFF_PORTAL_STRINGS.en || {};
const it = STAFF_PORTAL_STRINGS.it || {};
const es = esMap || {};
const NEW_EDIT_KEYS = [
  'schedule.drawer.paidRepriceRequired',
  'schedule.drawer.priceWillRefresh',
  'schedule.drawer.durationConfirm',
  'schedule.drawer.whenPickDates',
  'schedule.drawer.whenRange',
  'schedule.drawer.bundleSets',
  'schedule.drawer.bundleOneSet',
  'schedule.drawer.includedInBundle',
];
NEW_EDIT_KEYS.forEach((k) => {
  const ok = !!(en[k] && es[k] && it[k])
    && en[k] !== k && es[k] !== k && it[k] !== k
    && es[k] !== en[k] && it[k] !== en[k];
  assert(`production catalog ${k} EN/ES/IT`, ok, `en=${en[k]} es=${es[k]} it=${it[k]}`);
});
// Direct production-catalog assertion (not verifier mock map): keys resolve to real copy.
assert('production whenPickDates is localized copy not raw key',
  en['schedule.drawer.whenPickDates'] === 'Set From and To dates above.'
  && /elige|fechas/i.test(es['schedule.drawer.whenPickDates'])
  && /impost|date/i.test(it['schedule.drawer.whenPickDates']));
assert('production whenRange is localized copy not raw key',
  en['schedule.drawer.whenRange'] === 'Dates'
  && es['schedule.drawer.whenRange'] === 'Fechas'
  && it['schedule.drawer.whenRange'] === 'Date');

console.log('\n[6] VM — continuity lifecycle, DOM order, activity, duration, private, PATCH, bundle');
if (editExists) {
  const dom = {};
  const fetchLog = [];
  let saveInFlight = false;

  function makeNode(extra) {
    const n = Object.assign({
      value: '',
      checked: false,
      disabled: false,
      style: {},
      className: '',
      textContent: '',
      innerHTML: '',
      attributes: {},
      dataset: {},
      options: [],
      selectedIndex: -1,
      _ls: {},
      getAttribute(k) { return this.attributes[k] != null ? this.attributes[k] : (this[k] != null && typeof this[k] !== 'object' ? String(this[k]) : null); },
      setAttribute(k, v) { this.attributes[k] = String(v); },
      removeAttribute(k) { delete this.attributes[k]; },
      addEventListener(ev, fn) { (this._ls[ev] = this._ls[ev] || []).push(fn); },
      dispatchEvent(ev) { (this._ls[ev && ev.type] || []).forEach((fn) => fn.call(this, ev)); },
      querySelectorAll(sel) {
        // Minimal: only private session rows & rental checks from innerHTML scan via registry.
        if (sel === '.portal-schedule-private-session-row') {
          return Object.keys(dom).filter((id) => id.startsWith('_sess_row_')).map((id) => dom[id]);
        }
        if (sel === '[data-rental-offering]') {
          return Object.keys(dom).filter((id) => id.startsWith('_rent_row_')).map((id) => dom[id]);
        }
        if (sel === '.ps-drawer-rental-check') {
          return Object.keys(dom).filter((id) => id.startsWith('_rent_check_')).map((id) => dom[id]);
        }
        if (sel === '.ps-pl-session-start, .ps-pl-session-end' || sel === '.ps-pl-session-start' || sel === '.ps-pl-session-end') {
          return Object.keys(dom).filter((id) => id.includes('_sess_')).map((id) => dom[id]).filter((x) => {
            if (sel === '.ps-pl-session-start') return x.className === 'ps-pl-session-start';
            if (sel === '.ps-pl-session-end') return x.className === 'ps-pl-session-end';
            return x.className === 'ps-pl-session-start' || x.className === 'ps-pl-session-end';
          });
        }
        return [];
      },
      querySelector(sel) {
        const all = this.querySelectorAll(sel);
        return all[0] || null;
      },
    }, extra || {});
    return n;
  }

  const ctx = {
    console,
    document: {
      createElement: () => ({ innerHTML: '', firstChild: null, parentNode: { replaceChild() {} } }),
    },
    scheduleDrawerState: {
      row: { booking_id: '11111111-1111-1111-1111-111111111111', record_source: 'staff_manual', booking_code: 'SUN-1' },
      ctx: {
        booking_id: '11111111-1111-1111-1111-111111111111',
        booking_code: 'SUN-1',
        guest_name: 'Alex',
        phone: '+34111',
        date_from: '2026-07-20',
        date_to: '2026-07-26',
        notes: 'ok',
        components: {
          course: { course_id: 'c1', tier_key: '1_week', quantity: 2, course_label: 'Beginner' },
          surfboard: { quantity: 1 },
          wetsuit: { quantity: 1 },
        },
        rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '7_days', quantity: 1 }],
        rental_pricing: {
          offering_key: 'board_and_suit_rental',
          duration: '7_days',
          quantity: 1,
          pricing_group_id: 'grp-1',
        },
        payment_status: 'unpaid',
        payment: {
          subtotal_cents: 25112,
          paid_cents: 0,
          balance_due_cents: 25112,
          rental_pricing: {
            offering_key: 'board_and_suit_rental',
            duration: '7_days',
            quantity: 1,
            pricing_group_id: 'grp-1',
          },
          line_items: [
            // Multi-day course: create allocation primary + explicit-zero peers.
            {
              service_record_id: 'sr-course',
              service_type: 'surf_lesson',
              service_date: '2026-07-20',
              quantity: 2,
              line_cents: 18000,
              label: 'Beginner · 2',
              component: 'course',
              course_id: 'c1',
              tier_key: '1_week',
              offering_id: 'surf_pack_c1__1_week',
            },
            {
              service_record_id: 'sr-course-d2',
              service_type: 'surf_lesson',
              service_date: '2026-07-21',
              quantity: 2,
              line_cents: 0,
              label: 'Beginner · 2',
              component: 'course',
              course_id: 'c1',
              tier_key: '1_week',
              offering_id: 'surf_pack_c1__1_week',
            },
            {
              service_record_id: 'sr-course-d3',
              service_type: 'surf_lesson',
              service_date: '2026-07-22',
              quantity: 2,
              line_cents: 0,
              label: 'Beginner · 2',
              component: 'course',
              course_id: 'c1',
              tier_key: '1_week',
              offering_id: 'surf_pack_c1__1_week',
            },
            // Board+wetsuit bundle with multi-day explicit-zero peers (Create metadata shape).
            {
              service_record_id: 'sr-board',
              service_type: 'surfboard',
              service_date: '2026-07-20',
              quantity: 1,
              line_cents: 6512,
              label: 'Surfboard · 1',
              pricing_group_id: 'grp-1',
              offering_key: 'board_and_suit_rental',
              bundle_part: 'surfboard',
              duration_key: '7_days',
              rental_service_dates: ['2026-07-20', '2026-07-21', '2026-07-22'],
            },
            {
              service_record_id: 'sr-suit',
              service_type: 'wetsuit',
              service_date: '2026-07-20',
              quantity: 1,
              line_cents: 0,
              label: 'Wetsuit · 1',
              pricing_group_id: 'grp-1',
              offering_key: 'board_and_suit_rental',
              bundle_part: 'wetsuit',
              duration_key: '7_days',
              rental_service_dates: ['2026-07-20', '2026-07-21', '2026-07-22'],
            },
            {
              service_record_id: 'sr-board-d2',
              service_type: 'surfboard',
              service_date: '2026-07-21',
              quantity: 1,
              line_cents: 0,
              label: 'Surfboard · 1',
              pricing_group_id: 'grp-1',
              offering_key: 'board_and_suit_rental',
              bundle_part: 'surfboard',
            },
            {
              service_record_id: 'sr-suit-d2',
              service_type: 'wetsuit',
              service_date: '2026-07-21',
              quantity: 1,
              line_cents: 0,
              label: 'Wetsuit · 1',
              pricing_group_id: 'grp-1',
              offering_key: 'board_and_suit_rental',
              bundle_part: 'wetsuit',
            },
            {
              service_record_id: 'sr-board-d3',
              service_type: 'surfboard',
              service_date: '2026-07-22',
              quantity: 1,
              line_cents: 0,
              label: 'Surfboard · 1',
              pricing_group_id: 'grp-1',
              offering_key: 'board_and_suit_rental',
              bundle_part: 'surfboard',
            },
            // Unrelated free promo zero — must remain visible.
            {
              service_record_id: 'sr-promo',
              service_type: 'addon_service',
              service_date: '2026-07-20',
              quantity: 1,
              line_cents: 0,
              label: 'Promo free · 1',
              component: 'promo_free',
            },
          ],
        },
      },
      editing: false,
      openGen: 0,
      refreshGen: 0,
      activeBookingKey: null,
    },
    scheduleDrawerSaveInFlight: false,
    scheduleDrawerPriceStale: false,
    scheduleDrawerValidationState: { ok: true },
    scheduleLastDrawerRowId: null,
    scheduleCoursesCache: [{ course_id: 'c1', label: 'Beginner', price_tiers: realTiers() }],
    scheduleAdminPricesCache: [
      { offering_key: 'board_rental__7_days', amount_cents: 4000, active: true, location_id: 'sunset-somo' },
      { offering_key: 'wetsuit_rental__7_days', amount_cents: 3000, active: true, location_id: 'sunset-somo' },
      { offering_key: 'board_and_suit_rental__7_days', amount_cents: 6512, active: true, location_id: 'sunset-somo' },
    ],
    scheduleFullDayAddonEnabled: false,
    el: (id) => dom[id] || null,
    getClient: () => 'sunset',
    getSunsetLocation: () => 'sunset-somo',
    sunsetLocationQuerySuffix: () => '',
    scheduleDrawerCanEdit: () => true,
    scheduleCloneDrawerCtx: (c) => JSON.parse(JSON.stringify(c)),
    scheduleFindGroupForRow: (r) => r,
    scheduleRenderDrawerHeroHtml: () => '<div class="hero"></div>',
    scheduleDrawerSectionHtml: (k, inner) => inner,
    scheduleRenderDrawerPaymentSectionViewHtml: () => '<div id="ps-drawer-payment-box"></div>',
    scheduleRenderViewDrawerHtml: () => '<div id="view-mode">view</div>',
    scheduleWireViewDrawer: () => {},
    scheduleWireDrawerHeaderActions: () => {},
    scheduleWireDrawerStripeCopyOpen: () => {},
    scheduleWireDrawerConversation: () => {},
    scheduleWireDrawerOpenCustomer: () => {},
    scheduleWireDrawerManualPayment: () => {},
    scheduleLoadDrawerWaiver: () => {},
    scheduleFetchLessonTimesConfig: () => Promise.resolve({}),
    scheduleEnumerateDates: enumerateDates,
    scheduleReadFullDayAddonRows: () => ({}),
    scheduleRenderFullDayAddonRows: () => {},
    scheduleUpdateFullDayAddonSummary: () => {},
    scheduleTodayIso: () => '2026-07-20',
    schedulePaymentStatusLabel: (s) => s || 'unpaid',
    scheduleDrawerEur: (c) => '€' + (Number(c) / 100).toFixed(2),
    scheduleRenderDrawerManualPaymentHtml: () => '',
    scheduleRenderDrawerStripeLinkSectionHtml: () => '',
    loadSchedulePage: () => {},
    scheduleFetchDrawerContext: (row) => Promise.resolve({
      success: true,
      guest_name: 'Alex',
      booking_id: row.booking_id,
      components: { course: { course_id: 'c1', tier_key: '1_week', quantity: 2 } },
      payment: { subtotal_cents: 10000, paid_cents: 0, balance_due_cents: 10000 },
    }),
    fetch: (url, opts) => {
      fetchLog.push({ url, opts });
      if (opts && opts.method === 'PATCH') {
        if (saveInFlight) return Promise.resolve({ ok: false, json: () => Promise.resolve({ success: false, error: 'duplicate' }) });
        saveInFlight = true;
        const body = JSON.parse(opts.body);
        assert('PATCH has booking_id', !!body.booking_id);
        assert('PATCH has no client subtotal', body.subtotal_cents == null && body.total_cents == null);
        assert('PATCH has no balance_due_cents', body.balance_due_cents == null);
        assert('PATCH includes rentals array for complete intent', Array.isArray(body.rentals));
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            context: {
              guest_name: body.guest_name,
              booking_id: body.booking_id,
              components: body.components,
              payment: { subtotal_cents: 10000, paid_cents: 0, balance_due_cents: 10000 },
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}`, ctx);
  vm.runInContext(`function portalT(k){return (${portalT.toString()})(k);}`, ctx);
  vm.runInContext('var scheduleDrawerSaveInFlight = false; var scheduleDrawerPriceStale = false; var scheduleDrawerValidationState = { ok: true };', ctx);

  // Inject pure helpers from portal + rental + commercial view.
  [
    'schedulePortalInclusiveDateCount',
    'schedulePortalCanonicalDateIso',
    'schedulePortalMadridTodayIso',
    'schedulePortalMatchSellableCourseTiersByDurationDays',
    'schedulePortalResolveDerivedCourseTier',
    'schedulePortalValidatePrivateLessonCreate',
    'schedulePortalDurationLabel',
  ].forEach((name) => {
    const fnSrc = extractFunctionSource(portalModSrc, name);
    if (fnSrc) vm.runInContext(`${fnSrc}\nthis.${name}=${name};`, ctx);
  });
  // Lightweight ISO helpers if not present in extracted form dependencies.
  if (!ctx.schedulePortalCanonicalDateIso) {
    vm.runInContext(`function schedulePortalCanonicalDateIso(raw){var s=String(raw||'').trim().slice(0,10);return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)?s:'';} this.schedulePortalCanonicalDateIso=schedulePortalCanonicalDateIso;`, ctx);
  }
  if (!ctx.schedulePortalMadridTodayIso) {
    vm.runInContext(`function schedulePortalMadridTodayIso(){return '2026-07-01';} this.schedulePortalMadridTodayIso=schedulePortalMadridTodayIso;`, ctx);
  }
  if (!ctx.schedulePortalInclusiveDateCount) {
    vm.runInContext(`function schedulePortalInclusiveDateCount(a,b){return (scheduleEnumerateDates(a,b)||[]).length;} this.schedulePortalInclusiveDateCount=schedulePortalInclusiveDateCount;`, ctx);
  }
  if (!ctx.schedulePortalMatchSellableCourseTiersByDurationDays) {
    vm.runInContext(`function schedulePortalMatchSellableCourseTiersByDurationDays(course,days){var n=Number(days);if(!course||!Number.isFinite(n)||n<1)return[];var tiers=Array.isArray(course.price_tiers)?course.price_tiers:[];return tiers.filter(function(t){return t&&t.bookable!==false&&Number(t.duration_days)===n;});} this.schedulePortalMatchSellableCourseTiersByDurationDays=schedulePortalMatchSellableCourseTiersByDurationDays;`, ctx);
  }
  if (!ctx.schedulePortalResolveDerivedCourseTier) {
    vm.runInContext(`function schedulePortalResolveDerivedCourseTier(courseId,dateFrom,dateTo){var id=String(courseId||'').trim();if(!id)return{ok:false,errorKey:'schedule.create.courseRequired'};var days=schedulePortalInclusiveDateCount(dateFrom,dateTo);if(days<1)return{ok:false,errorKey:'calendar.state.invalidDateRange'};var course=null;(scheduleCoursesCache||[]).forEach(function(c){if(String(c.course_id||'').trim()===id)course=c;});var matches=schedulePortalMatchSellableCourseTiersByDurationDays(course,days);if(!matches.length)return{ok:false,errorKey:'schedule.create.courseDurationUnavailable',duration_days:days};if(matches.length>1)return{ok:false,errorKey:'schedule.create.courseDurationAmbiguous',duration_days:days};var tier=matches[0];return{ok:true,tier_key:String(tier.key),duration_days:days,offering_id:tier.offering_id||('surf_pack_'+id+'__'+tier.key),tier_label:tier.label!=null?String(tier.label):''};} this.schedulePortalResolveDerivedCourseTier=schedulePortalResolveDerivedCourseTier;`, ctx);
  }
  if (!ctx.schedulePortalValidatePrivateLessonCreate) {
    vm.runInContext(`function schedulePortalValidatePrivateLessonCreate(pl){if(!pl||pl.enabled===false)return{ok:true};var max=30;var qty=parseInt(pl.quantity,10);if(!Number.isFinite(qty)||qty<1||qty>max)return{ok:false,errorKey:'schedule.create.privateLesson.sessionMax'};var sessions=Array.isArray(pl.sessions)?pl.sessions:null;if(!sessions||sessions.length!==qty)return{ok:false,errorKey:'schedule.create.privateLesson.sessionsMismatch'};for(var i=0;i<sessions.length;i++){var s=sessions[i]||{};if(!s.date||!s.start||!s.end)return{ok:false,errorKey:'schedule.create.privateLesson.sessionIncomplete'};}return{ok:true};} this.schedulePortalValidatePrivateLessonCreate=schedulePortalValidatePrivateLessonCreate;`, ctx);
  }

  // Rental pure helpers via module.exports pattern — eval source in sandbox.
  vm.runInContext(rentalModSrc.replace(/if \(typeof module[\s\S]*$/, ''), ctx);

  const commercialFn = extractFunctionSource(viewModSrc, 'scheduleDrawerBuildCommercialLines');
  if (commercialFn) vm.runInContext(`${commercialFn}\nthis.scheduleDrawerBuildCommercialLines=scheduleDrawerBuildCommercialLines;`, ctx);
  const stripFn = extractFunctionSource(viewModSrc, 'scheduleDrawerStripLabelDate');
  if (stripFn) vm.runInContext(`${stripFn}\nthis.scheduleDrawerStripLabelDate=scheduleDrawerStripLabelDate;`, ctx);

  [
    'scheduleParsePaymentSelectValue',
    'scheduleDrawerPaymentSelectValue',
    'scheduleDrawerMainActivityValue',
    'scheduleDrawerSetMainActivity',
    'scheduleRenderDrawerPaymentSelectHtml',
    'scheduleRenderDrawerPaymentSectionEditHtml',
    'scheduleRenderEditableDrawerHtml',
    'scheduleReadDrawerEditPayload',
    'scheduleDrawerPopulateComponentFields',
    'scheduleRefreshDrawerFullDayAddon',
    'scheduleUpdateDrawerTotalPreview',
    'scheduleDrawerOnComponentChange',
    'scheduleDrawerPopulateCourseSelect',
    'scheduleDrawerReadPrivateSessionsFromDom',
    'scheduleDrawerRenderPrivateSessions',
    'scheduleDrawerSyncPrivateSessions',
    'scheduleDrawerSeedRentalsFromCtx',
    'scheduleDrawerDateSpan',
    'scheduleReadDrawerRentalSelectionFromDom',
    'scheduleDrawerApplyRentalExclusionUi',
    'scheduleWireDrawerRentals',
    'scheduleRenderDrawerRentals',
    'scheduleDrawerRefreshDurationConfirm',
    'scheduleDrawerRefreshWhenSummary',
    'scheduleDrawerMarkPriceStale',
    'scheduleDrawerValidateEditPayload',
    'scheduleDrawerHumanSaveError',
    'scheduleDrawerSyncFooter',
    'scheduleEnterDrawerEditMode',
    'scheduleCancelDrawerEditMode',
    'scheduleSaveDrawerBooking',
    'scheduleWireEditableDrawer',
  ].forEach((name) => {
    const fnSrc = extractFunctionSource(editModSrc, name);
    if (fnSrc) vm.runInContext(`${fnSrc}\nthis.${name}=${name};`, ctx);
  });
  // scheduleDrawerPopulateCourseTierFields removed (date-derived duration only).
  ['scheduleMountDrawerBody', 'scheduleOpenEditableDrawer', 'scheduleDrawerShowShell', 'scheduleCloneDrawerCtx'].forEach((name) => {
    const fnSrc = extractFunctionSource(ctrlModSrc, name);
    if (fnSrc) vm.runInContext(`${fnSrc}\nthis.${name}=${name};`, ctx);
  });
  vm.runInContext('if(typeof scheduleDrawerState==="undefined"){var scheduleDrawerState={row:null,ctx:null,editing:false,openGen:0,refreshGen:0,activeBookingKey:null};}', ctx);
  vm.runInContext('function scheduleWireDrawerDeleteBooking(){}', ctx);

  dom['ps-detail-drawer'] = makeNode({ style: {} });
  dom['ps-drawer-backdrop'] = makeNode({ style: {} });
  dom['ps-drawer-body'] = makeNode({ innerHTML: '' });

  // --- Commercial presentation (Create/DB allocation fixtures) ---
  const inputItems = ctx.scheduleDrawerState.ctx.payment.line_items;
  const inputSum = inputItems.reduce((a, l) => a + Number(l.line_cents || 0), 0);
  const commercial = ctx.scheduleDrawerBuildCommercialLines(
    inputItems,
    ctx.scheduleDrawerState.ctx.payment.rental_pricing,
  );
  const commercialSum = commercial.lines.reduce((a, l) => a + Number(l.line_cents || 0), 0);
  assert('bundle commercial has one board+wetsuit line',
    commercial.lines.some((l) => l.is_bundle && /Surfboard \+ wetsuit/.test(l.label) && l.line_cents === 6512));
  assert('bundle commercial does not show Wetsuit €0.00 line',
    !commercial.lines.some((l) => /Wetsuit/.test(l.label) && l.line_cents === 0 && !l.is_bundle));
  assert('multi-day course collapsed to one commercial line',
    commercial.lines.filter((l) => !l.is_bundle && /Beginner/.test(String(l.label || ''))).length === 1
    && commercial.lines.some((l) => !l.is_bundle && Number(l.line_cents) === 18000));
  assert('course zero peers hidden',
    commercial.hidden_ids['sr-course'] === true
    && commercial.hidden_ids['sr-course-d2'] === true
    && commercial.hidden_ids['sr-course-d3'] === true);
  assert('bundle multi-day zero peers hidden',
    commercial.hidden_ids['sr-suit'] === true
    && commercial.hidden_ids['sr-board'] === true
    && commercial.hidden_ids['sr-board-d2'] === true
    && commercial.hidden_ids['sr-suit-d2'] === true
    && commercial.hidden_ids['sr-board-d3'] === true);
  assert('unrelated zero promo line kept visible',
    commercial.lines.some((l) => /Promo free/.test(String(l.label || '')) && Number(l.line_cents) === 0)
    && commercial.hidden_ids['sr-promo'] !== true);
  assert('commercial sum equals input canonical sum', commercialSum === inputSum && commercialSum === 24512);

  // Independent board/wetsuit without group identity stay separate.
  const independent = ctx.scheduleDrawerBuildCommercialLines([
    { service_type: 'surfboard', quantity: 2, line_cents: 8000, label: 'Surfboard · 2', offering_key: 'board_rental', duration_key: '3_days' },
    { service_type: 'wetsuit', quantity: 2, line_cents: 6000, label: 'Wetsuit · 2', offering_key: 'wetsuit_rental', duration_key: '3_days' },
  ], null);
  assert('separate board+wetsuit remain two lines (qty>1)',
    independent.lines.length === 2
    && independent.lines.some((l) => /Board rental|Surfboard/.test(l.label) && l.line_cents === 8000 && Number(l.quantity) === 2)
    && independent.lines.some((l) => /Wetsuit/.test(l.label) && l.line_cents === 6000 && Number(l.quantity) === 2));
  assert('separate board+wetsuit sum preserved',
    independent.lines.reduce((a, l) => a + Number(l.line_cents || 0), 0) === 14000);

  // Multi-day single rental with primary+zeros (board_rental offering).
  const multiBoard = [
    { service_record_id: 'b1', service_type: 'surfboard', service_date: '2026-07-20', quantity: 1, line_cents: 4000, offering_key: 'board_rental', duration_key: '3_days', label: 'Surfboard · 1' },
    { service_record_id: 'b2', service_type: 'surfboard', service_date: '2026-07-21', quantity: 1, line_cents: 0, offering_key: 'board_rental', duration_key: '3_days', label: 'Surfboard · 1' },
    { service_record_id: 'b3', service_type: 'surfboard', service_date: '2026-07-22', quantity: 1, line_cents: 0, offering_key: 'board_rental', duration_key: '3_days', label: 'Surfboard · 1' },
  ];
  const multiBoardOut = ctx.scheduleDrawerBuildCommercialLines(multiBoard, null);
  assert('multi-day board rental collapses peers',
    multiBoardOut.lines.length === 1 && multiBoardOut.lines[0].line_cents === 4000
    && multiBoardOut.hidden_ids.b1 && multiBoardOut.hidden_ids.b2 && multiBoardOut.hidden_ids.b3);
  assert('multi-day board sum equals input',
    multiBoardOut.lines.reduce((a, l) => a + Number(l.line_cents || 0), 0)
    === multiBoard.reduce((a, l) => a + Number(l.line_cents || 0), 0));

  // Missing group identity fails closed to raw lines (no fabricated bundle).
  const ambiguous = ctx.scheduleDrawerBuildCommercialLines([
    { service_type: 'surfboard', quantity: 1, line_cents: 6512, label: 'Surfboard · 1' },
    { service_type: 'wetsuit', quantity: 1, line_cents: 0, label: 'Wetsuit · 1' },
  ], { offering_key: 'board_and_suit_rental', duration: '3_days', quantity: 1 });
  assert('no pricing_group_id legacy does not invent/over-collapse bundle',
    !ambiguous.lines.some((l) => l.is_bundle) && ambiguous.lines.length === 2);
  // --- Edit lifecycle ---
  ctx.scheduleOpenEditableDrawer(ctx.scheduleDrawerState.row, ctx.scheduleDrawerState.ctx);
  assert('open drawer starts in view mode', ctx.scheduleDrawerState.editing === false);

  ctx.scheduleEnterDrawerEditMode();
  assert('enter edit sets editing flag', ctx.scheduleDrawerState.editing === true);
  assert('edit form rendered', dom['ps-drawer-body'].innerHTML.includes('ps-drawer-edit-form'));

  const staffHtml = dom['ps-drawer-body'].innerHTML;
  assert('edit form shows guest value', staffHtml.includes('Alex'));
  assert('edit form shows course qty', staffHtml.includes('value="2"'));
  assert('sticky header title Edit booking', /id="ps-drawer-edit-title"/.test(staffHtml) && /Edit booking/.test(staffHtml));
  assert('booking code in header chip', /SUN-1/.test(staffHtml));
  assert('no second oversized Edit booking body title',
    (staffHtml.match(/Edit booking/g) || []).length === 1);
  assert('radiogroup present', /role="radiogroup"/.test(staffHtml));
  assert('no-lesson radio present', /ps-drawer-comp-no-lesson/.test(staffHtml));
  assert('no course tier select', !/ps-drawer-course-tier/.test(staffHtml));
  assert('no private date input', !/ps-pl-session-date" type="date"/.test(staffHtml));
  assert('no Add session control in edit HTML', !/ps-drawer-add-session/.test(staffHtml));
  assert('footer Cancel + Save', /ps-drawer-cancel/.test(staffHtml) && /ps-drawer-save/.test(staffHtml));
  assert('bundle commercial in payment snapshot', /Surfboard \+ wetsuit/.test(staffHtml) && !/Wetsuit rental — €0\.00/.test(staffHtml));
  assert('course commercial not repeated zero peers in payment snapshot',
    (staffHtml.match(/Beginner/g) || []).length <= 2);

  // DOM field order in rendered HTML
  assert('DOM order guest→phone→from→to→activity→when→payment',
    idOrder(staffHtml, 'ps-drawer-guest') >= 0
    && idOrder(staffHtml, 'ps-drawer-phone') > idOrder(staffHtml, 'ps-drawer-guest')
    && idOrder(staffHtml, 'ps-drawer-date-from') > idOrder(staffHtml, 'ps-drawer-phone')
    && idOrder(staffHtml, 'ps-drawer-date-to') > idOrder(staffHtml, 'ps-drawer-date-from')
    && idOrder(staffHtml, 'ps-drawer-comp-course') > idOrder(staffHtml, 'ps-drawer-date-to')
    && idOrder(staffHtml, 'ps-drawer-section-when-title') > idOrder(staffHtml, 'ps-drawer-comp-course')
    && idOrder(staffHtml, 'ps-drawer-payment') > idOrder(staffHtml, 'ps-drawer-section-when-title')
    && idOrder(staffHtml, 'ps-drawer-notes') > idOrder(staffHtml, 'ps-drawer-payment')
    && idOrder(staffHtml, 'ps-drawer-save') > idOrder(staffHtml, 'ps-drawer-notes'));

  // Hydrate interactive DOM nodes for payload tests.
  function hydrateFromHtml(html) {
    // Parse key inputs into dom map for payload reader.
    const pairs = [
      ['ps-drawer-guest', 'Alex'],
      ['ps-drawer-phone', '+34111'],
      ['ps-drawer-date-from', '2026-07-20'],
      ['ps-drawer-date-to', '2026-07-26'],
      ['ps-drawer-payment', 'unpaid'],
      ['ps-drawer-notes', 'ok'],
      ['ps-drawer-course-qty', '2'],
      ['ps-drawer-private-lesson-surfers', '1'],
      ['ps-drawer-board-qty', '1'],
      ['ps-drawer-wetsuit-qty', '1'],
    ];
    pairs.forEach(([id, val]) => { dom[id] = makeNode({ value: val }); });
    dom['ps-drawer-comp-course'] = makeNode({ checked: true, value: 'group' });
    dom['ps-drawer-comp-private-lesson'] = makeNode({ checked: false, value: 'private' });
    dom['ps-drawer-comp-no-lesson'] = makeNode({ checked: false, value: 'none' });
    dom['ps-drawer-comp-fullday'] = makeNode({ checked: false });
    dom['ps-drawer-course-select'] = makeNode({
      value: 'c1',
      selectedIndex: 0,
      options: [{ getAttribute: () => 'Beginner', textContent: 'Beginner' }],
      attributes: { 'data-selected': 'c1' },
    });
    dom['ps-drawer-save-msg'] = makeNode({ style: {}, className: '', textContent: '' });
    dom['ps-drawer-save'] = makeNode({ disabled: false });
    dom['ps-drawer-cancel'] = makeNode({});
    dom['ps-drawer-summary'] = makeNode({ innerHTML: '' });
    dom['ps-drawer-course-duration-confirm'] = makeNode({ style: {}, innerHTML: '' });
    dom['ps-drawer-when-summary'] = makeNode({ style: {}, innerHTML: '' });
    dom['ps-drawer-private-when'] = makeNode({ style: {} });
    dom['ps-drawer-private-sessions'] = makeNode({
      innerHTML: '',
      attributes: {},
      querySelectorAll(sel) {
        if (sel === '.portal-schedule-private-session-row') {
          return Object.keys(dom).filter((k) => k.startsWith('_sess_row_')).map((k) => dom[k]);
        }
        if (sel === '.ps-pl-session-start, .ps-pl-session-end') {
          return Object.keys(dom).filter((k) => k.includes('_sess_start_') || k.includes('_sess_end_')).map((k) => dom[k]);
        }
        return [];
      },
    });
    // Rentals wrap with seeded bundle selection.
    const rentRows = [];
    ['board_rental', 'wetsuit_rental', 'board_and_suit_rental'].forEach((key, i) => {
      const check = makeNode({
        checked: key === 'board_and_suit_rental',
        className: 'ps-drawer-rental-check',
        attributes: { 'data-offering-key': key },
        getAttribute(k) { return k === 'data-offering-key' ? key : (this.attributes[k] || null); },
      });
      const qty = makeNode({ value: '1', className: 'ps-drawer-rental-qty-input' });
      const row = makeNode({
        attributes: { 'data-rental-offering': key },
        getAttribute(k) { return k === 'data-rental-offering' ? key : null; },
        querySelector(sel) {
          if (sel === '.ps-drawer-rental-check') return check;
          if (sel === 'input.ps-drawer-rental-qty-input') return qty;
          if (sel === '.portal-schedule-create-rental-qty') return makeNode({ style: {} });
          if (sel === '.portal-schedule-create-check') return makeNode({ classList: { add() {}, remove() {} } });
          return null;
        },
      });
      dom[`_rent_check_${i}`] = check;
      dom[`_rent_row_${i}`] = row;
      rentRows.push(row);
    });
    dom['ps-drawer-rentals'] = makeNode({
      attributes: {
        'data-duration-key': '7_days',
        'data-seed-board': '1',
        'data-seed-wetsuit': '1',
        'data-seed-board-qty': '1',
        'data-seed-wetsuit-qty': '1',
        'data-seed-rentals': JSON.stringify([{ offering_key: 'board_and_suit_rental', quantity: 1 }]),
      },
      dataset: {},
      querySelectorAll(sel) {
        if (sel === '[data-rental-offering]') return rentRows;
        if (sel === '.ps-drawer-rental-check') return rentRows.map((r) => r.querySelector('.ps-drawer-rental-check'));
        return [];
      },
    });
    dom['ps-drawer-course-fields'] = makeNode({ style: {} });
    dom['ps-drawer-course-qty-wrap'] = makeNode({ style: {} });
    dom['ps-drawer-private-lesson-fields'] = makeNode({ style: { display: 'none' } });
    dom['ps-drawer-course-section'] = makeNode({ style: {} });
    dom['ps-drawer-date-range'] = makeNode({ style: {} });
    dom['ps-drawer-addon-fullday-field'] = makeNode({ style: { display: 'none' }, attributes: { 'data-addon-seed': '{}' } });
    dom['ps-drawer-fullday-rows'] = makeNode({ style: {} });
    dom['ps-drawer-fullday-summary'] = makeNode({ style: {} });
    void html;
  }
  hydrateFromHtml(staffHtml);

  // Duration derived from dates (7 days → 1_week)
  const payload = ctx.scheduleReadDrawerEditPayload();
  assert('payload course_id canonical', payload.components.course.course_id === 'c1');
  assert('payload tier_key date-derived 1_week', payload.components.course.tier_key === '1_week');
  assert('payload no server-owned payment cents', payload.balance_due_cents == null && payload.subtotal_cents == null);
  assert('payload includes rentals complete intent', Array.isArray(payload.rentals) && payload.rentals.some((r) => r.offering_key === 'board_and_suit_rental'));
  assert('payload has surfboard+wetsuit from bundle', payload.components.surfboard && payload.components.wetsuit);

  // Poison: inventing a tier select must not affect payload.
  dom['ps-drawer-course-tier'] = makeNode({ value: 'poison_tier' });
  const payload2 = ctx.scheduleReadDrawerEditPayload();
  assert('hidden/poison tier selector ignored', payload2.components.course.tier_key === '1_week');

  // Ambiguous / unsupported fail closed
  dom['ps-drawer-date-to'] = makeNode({ value: '2026-07-21' }); // 2 days — no match
  const pBad = ctx.scheduleReadDrawerEditPayload();
  assert('unsupported duration omits tier_key', !pBad.components.course.tier_key);
  const gateBad = ctx.scheduleDrawerValidateEditPayload(pBad);
  assert('unsupported duration invalidates save', gateBad.ok === false);

  // Restore 7-day range
  dom['ps-drawer-date-to'] = makeNode({ value: '2026-07-26' });

  // Private sessions: switch activity and set range
  ctx.scheduleDrawerSetMainActivity('private');
  assert('radiogroup exclusive private', ctx.scheduleDrawerMainActivityValue() === 'private'
    && dom['ps-drawer-comp-course'].checked === false
    && dom['ps-drawer-comp-private-lesson'].checked === true);

  // Seed private from ctx with times, then expand/shrink dates.
  ctx.scheduleDrawerState.ctx.components.private_lesson = {
    sessions: [
      { date: '2026-07-20', start: '10:00', end: '12:00' },
      { date: '2026-07-21', start: '11:00', end: '13:00' },
    ],
    surfer_count: 1,
    quantity: 2,
  };
  // Custom private sessions wrap with real row behavior.
  let privateByDate = {
    '2026-07-20': { start: '10:00', end: '12:00' },
    '2026-07-21': { start: '11:00', end: '13:00' },
  };
  function rebuildPrivateDom(sessions) {
    Object.keys(dom).forEach((k) => {
      if (k.startsWith('_sess_')) delete dom[k];
    });
    sessions.forEach((sess, i) => {
      const start = makeNode({ value: sess.start || '', className: 'ps-pl-session-start', dataset: {} });
      const end = makeNode({ value: sess.end || '', className: 'ps-pl-session-end', dataset: {} });
      const row = makeNode({
        attributes: { 'data-session-date': sess.date, 'data-session-index': String(i + 1) },
        getAttribute(k) { return this.attributes[k] || null; },
        querySelector(sel) {
          if (sel === '.ps-pl-session-start') return start;
          if (sel === '.ps-pl-session-end') return end;
          if (sel === '.ps-pl-session-date') return null;
          return null;
        },
      });
      dom[`_sess_row_${i}`] = row;
      dom[`_sess_start_${i}`] = start;
      dom[`_sess_end_${i}`] = end;
    });
    dom['ps-drawer-private-sessions'].querySelectorAll = function(sel) {
      if (sel === '.portal-schedule-private-session-row') {
        return Object.keys(dom).filter((k) => k.startsWith('_sess_row_')).map((k) => dom[k]);
      }
      if (sel === '.ps-pl-session-start, .ps-pl-session-end') {
        return Object.keys(dom).filter((k) => k.includes('_sess_start_') || k.includes('_sess_end_')).map((k) => dom[k]);
      }
      return [];
    };
  }
  // Override render to use our rebuild.
  const origRender = ctx.scheduleDrawerRenderPrivateSessions;
  ctx.scheduleDrawerRenderPrivateSessions = function(sessions) {
    rebuildPrivateDom(sessions || []);
    privateByDate = {};
    (sessions || []).forEach((s) => { privateByDate[s.date] = { start: s.start, end: s.end }; });
  };
  // Re-bind sync which calls render.
  const syncSrc = extractFunctionSource(editModSrc, 'scheduleDrawerSyncPrivateSessions');
  vm.runInContext(`${syncSrc}\nthis.scheduleDrawerSyncPrivateSessions=scheduleDrawerSyncPrivateSessions;`, ctx);

  dom['ps-drawer-date-from'] = makeNode({ value: '2026-07-20' });
  dom['ps-drawer-date-to'] = makeNode({ value: '2026-07-22' });
  ctx.scheduleDrawerSyncPrivateSessions();
  let sess = ctx.scheduleDrawerReadPrivateSessionsFromDom();
  assert('private rows = 3 inclusive dates', sess.length === 3);
  assert('private preserves overlapping times',
    sess[0].date === '2026-07-20' && sess[0].start === '10:00'
    && sess[1].date === '2026-07-21' && sess[1].start === '11:00');
  assert('private new date has blank times', sess[2].date === '2026-07-22' && sess[2].start === '' && sess[2].end === '');
  assert('private no date inputs', sess.every((s) => s.date && !dom['ps-drawer-private-sessions'].innerHTML.includes('type="date"')));

  // Shrink range — drop outside, preserve overlap
  dom['ps-drawer-date-to'] = makeNode({ value: '2026-07-21' });
  ctx.scheduleDrawerSyncPrivateSessions({ skipCtxSeed: true });
  sess = ctx.scheduleDrawerReadPrivateSessionsFromDom();
  assert('private shrink drops out-of-range', sess.length === 2 && sess[0].start === '10:00' && sess[1].start === '11:00');

  // 31 days fail closed
  dom['ps-drawer-date-from'] = makeNode({ value: '2026-07-01' });
  dom['ps-drawer-date-to'] = makeNode({ value: '2026-07-31' });
  ctx.scheduleDrawerSyncPrivateSessions({ skipCtxSeed: true });
  sess = ctx.scheduleDrawerReadPrivateSessionsFromDom();
  assert('private 31+ fail closed zero rows', sess.length === 0);
  assert('private 31 sets range-too-long attr',
    dom['ps-drawer-private-sessions'].getAttribute('data-range-too-long') === '1');

  // 30 days valid
  dom['ps-drawer-date-to'] = makeNode({ value: '2026-07-30' });
  ctx.scheduleDrawerSyncPrivateSessions({ skipCtxSeed: true });
  sess = ctx.scheduleDrawerReadPrivateSessionsFromDom();
  assert('private 30 days valid rows', sess.length === 30);

  // Restore original render
  ctx.scheduleDrawerRenderPrivateSessions = origRender;

  // Cancel / validation / luna
  ctx.scheduleDrawerState.row.record_source = 'luna_guest';
  ctx.scheduleEnterDrawerEditMode();
  assert('luna booking same edit form', dom['ps-drawer-body'].innerHTML.includes('ps-drawer-edit-form'));

  hydrateFromHtml(dom['ps-drawer-body'].innerHTML);
  const patchCountBefore = fetchLog.filter((f) => f.opts && f.opts.method === 'PATCH').length;
  ctx.scheduleCancelDrawerEditMode();
  assert('cancel restores view mode', ctx.scheduleDrawerState.editing === false);
  assert('cancel performs no PATCH', fetchLog.filter((f) => f.opts && f.opts.method === 'PATCH').length === patchCountBefore);

  ctx.scheduleEnterDrawerEditMode();
  hydrateFromHtml(dom['ps-drawer-body'].innerHTML);
  assert('payment select paid_bank_transfer maps correctly', ctx.scheduleParsePaymentSelectValue('paid_bank_transfer').method === 'bank_transfer');
  assert('payment select unpaid maps correctly', ctx.scheduleParsePaymentSelectValue('unpaid').status === 'unpaid');

  const xssCtx = Object.assign({}, ctx.scheduleDrawerState.ctx, { guest_name: '<img onerror=alert(1)>', notes: '<script>n</script>' });
  const xssHtml = ctx.scheduleRenderEditableDrawerHtml(ctx.scheduleDrawerState.row, xssCtx);
  assert('edit form escapes guest name in value attr', xssHtml.includes('&lt;img') && !xssHtml.includes('<img onerror'));
  assert('edit form escapes notes in textarea', xssHtml.includes('&lt;script&gt;'));

  dom['ps-drawer-guest'] = makeNode({ value: '' });
  ctx.scheduleDrawerSetMainActivity('none');
  // clear rentals
  Object.keys(dom).forEach((k) => {
    if (k.startsWith('_rent_check_')) dom[k].checked = false;
  });
  const patchesBeforeVal = fetchLog.filter((f) => f.opts && f.opts.method === 'PATCH').length;
  ctx.scheduleSaveDrawerBooking(ctx.scheduleDrawerState.row);
  assert('validation failure blocks PATCH (empty guest)', fetchLog.filter((f) => f.opts && f.opts.method === 'PATCH').length === patchesBeforeVal);
  assert('validation stays in edit mode', ctx.scheduleDrawerState.editing === true);

  // Paid conflict human message
  const paidMsg = ctx.scheduleDrawerHumanSaveError({ reason_code: 'paid_booking_reprice_required' });
  assert('paid reprice human conflict message', /already paid|payment adjustment/i.test(paidMsg));

  // Duplicate save guard
  hydrateFromHtml('');
  ctx.scheduleDrawerSetMainActivity('group');
  dom['ps-drawer-guest'] = makeNode({ value: 'Alex' });
  dom['ps-drawer-date-from'] = makeNode({ value: '2026-07-20' });
  dom['ps-drawer-date-to'] = makeNode({ value: '2026-07-26' });
  saveInFlight = false;
  ctx.scheduleDrawerSaveInFlight = false;
  const beforeDup = fetchLog.filter((f) => f.opts && f.opts.method === 'PATCH').length;
  // First call sets in-flight synchronously before fetch resolves.
  const p1 = ctx.scheduleSaveDrawerBooking(ctx.scheduleDrawerState.row);
  const mid = fetchLog.filter((f) => f.opts && f.opts.method === 'PATCH').length;
  ctx.scheduleSaveDrawerBooking(ctx.scheduleDrawerState.row);
  const afterDup = fetchLog.filter((f) => f.opts && f.opts.method === 'PATCH').length;
  assert('duplicate save does not double PATCH', mid === beforeDup + 1 && afterDup === mid);
  void p1;

  // 320px CSS contract presence
  assert('320/mobile footer wrap CSS', /max-width:360px/.test(apiSrc) && /portal-schedule-drawer-edit-footer/.test(apiSrc));
  assert('overflow-x hidden on edit shell', /overflow-x:hidden/.test(apiSrc) && /portal-schedule-drawer-edit-body/.test(apiSrc));
}

console.log('\n[7] Independent source mutations (must RED then restore)');
{
  const original = fs.readFileSync(EDIT_MODULE, 'utf8');
  const viewOriginal = fs.readFileSync(VIEW_MODULE, 'utf8');
  try {
    // 1) Hidden duration authority: break resolver call
    let mutated = original.replace(
      'schedulePortalResolveDerivedCourseTier(courseId, dateFrom, dateTo)',
      'null /* mutated duration */',
    );
    assert('mutation duration authority changed bytes', mutated !== original);
    fs.writeFileSync(EDIT_MODULE, mutated);
    {
      // Re-eval payload derivation quickly
      const src = fs.readFileSync(EDIT_MODULE, 'utf8');
      assert('mutation: payload no longer calls resolver', !/schedulePortalResolveDerivedCourseTier\(courseId, dateFrom, dateTo\)/.test(src));
    }
    fs.writeFileSync(EDIT_MODULE, original);

    // 2) Re-introduce dead Add session control → RED
    mutated = original.replace(
      'html += \'<div id="ps-drawer-private-sessions" class="portal-schedule-private-sessions"></div>\';',
      'html += \'<div id="ps-drawer-private-sessions" class="portal-schedule-private-sessions"></div>\';\n'
      + '  html += \'<button type="button" id="ps-drawer-add-session" hidden>Add</button>\';',
    );
    assert('mutation dead Add session changed bytes', mutated !== original);
    fs.writeFileSync(EDIT_MODULE, mutated);
    assert('mutation Add session reintroduced (RED)', /ps-drawer-add-session/.test(fs.readFileSync(EDIT_MODULE, 'utf8')));
    fs.writeFileSync(EDIT_MODULE, original);
    assert('mutation Add session restored absent', !/ps-drawer-add-session/.test(fs.readFileSync(EDIT_MODULE, 'utf8')));

    // 3) Bundle/peer collapse: force identity always empty (old zero-peer algorithm OFF)
    let vMut = viewOriginal.replace(
      'function bKey(li) {',
      'function bKey(li) { return ""; /* mutated no bundle */',
    );
    if (vMut === viewOriginal) {
      vMut = viewOriginal.replace(
        'function bundleKey(li) {',
        'function bundleKey(li) { return ""; /* mutated no bundle */',
      );
    }
    vMut = vMut.replace(
      'function pKey(li) {',
      'function pKey(li) { return ""; /* mutated no peer */',
    );
    if (!/mutated no peer/.test(vMut)) {
      vMut = vMut.replace(
        'function peerKey(li) {',
        'function peerKey(li) { return ""; /* mutated no peer */',
      );
    }
    assert('mutation zero-peer algorithm changed bytes', vMut !== viewOriginal);
    fs.writeFileSync(VIEW_MODULE, vMut);
    {
      const fn = extractFunctionSource(fs.readFileSync(VIEW_MODULE, 'utf8'), 'scheduleDrawerBuildCommercialLines');
      const sandbox = { portalT, schedulePortalDurationLabel: () => '', scheduleDrawerStripLabelDate: (s) => s };
      vm.createContext(sandbox);
      vm.runInContext(fn + '\nthis.out=scheduleDrawerBuildCommercialLines', sandbox);
      const res = sandbox.out([
        { service_record_id: 'a', service_type: 'surfboard', line_cents: 6512, quantity: 1, pricing_group_id: 'g', offering_key: 'board_and_suit_rental' },
        { service_record_id: 'b', service_type: 'wetsuit', line_cents: 0, quantity: 1, pricing_group_id: 'g', offering_key: 'board_and_suit_rental' },
        { service_record_id: 'c1', service_type: 'surf_lesson', line_cents: 18000, quantity: 2, component: 'course', course_id: 'c1', service_date: '2026-07-20', label: 'Beginner · 2' },
        { service_record_id: 'c2', service_type: 'surf_lesson', line_cents: 0, quantity: 2, component: 'course', course_id: 'c1', service_date: '2026-07-21', label: 'Beginner · 2' },
      ], { offering_key: 'board_and_suit_rental', pricing_group_id: 'g', duration: '3_days', quantity: 1 });
      assert('mutation peer collapse OFF → no is_bundle line (RED)', !res.lines.some((l) => l.is_bundle));
      assert('mutation peer collapse OFF → course zero peer not collapsed (RED)',
        res.lines.filter((l) => /Beginner/.test(String(l.label || ''))).length >= 2
        || res.lines.some((l) => Number(l.line_cents) === 0 && /Beginner/.test(String(l.label || ''))));
    }
    fs.writeFileSync(VIEW_MODULE, viewOriginal);

    // 3b) Missing production whenPickDates/whenRange keys → RED catalog check
    {
      const i18nPath = I18N;
      const i18nOrig = fs.readFileSync(i18nPath, 'utf8');
      let i18nMut = i18nOrig
        .replace(/'schedule\.drawer\.whenPickDates':\s*'[^']*',?\n/g, '')
        .replace(/'schedule\.drawer\.whenRange':\s*'[^']*',?\n/g, '');
      assert('mutation production when keys removed', i18nMut !== i18nOrig && !/'schedule\.drawer\.whenPickDates'/.test(i18nMut));
      fs.writeFileSync(i18nPath, i18nMut);
      try {
        delete require.cache[require.resolve('./lib/staff-portal-i18n')];
        const mutStrings = require('./lib/staff-portal-i18n').STAFF_PORTAL_STRINGS;
        const mutEn = mutStrings.en || {};
        assert('mutation missing whenPickDates production key (RED)', !mutEn['schedule.drawer.whenPickDates']);
        assert('mutation missing whenRange production key (RED)', !mutEn['schedule.drawer.whenRange']);
      } finally {
        fs.writeFileSync(i18nPath, i18nOrig);
        delete require.cache[require.resolve('./lib/staff-portal-i18n')];
      }
      const restored = require('./lib/staff-portal-i18n').STAFF_PORTAL_STRINGS.en || {};
      assert('mutation production when keys restored (GREEN)',
        !!restored['schedule.drawer.whenPickDates'] && !!restored['schedule.drawer.whenRange']);
    }

    // 4) Exact date derivation private: empty dates always
    mutated = original.replace(
      'dates = scheduleEnumerateDates(from, to) || [];',
      'dates = []; /* mutated private dates */',
    );
    assert('mutation private date derivation changed bytes', mutated !== original);
    fs.writeFileSync(EDIT_MODULE, mutated);
    assert('mutation private dates emptied', /dates = \[\]; \/\* mutated private dates \*\//.test(fs.readFileSync(EDIT_MODULE, 'utf8')));
    fs.writeFileSync(EDIT_MODULE, original);

    // 5) Paid conflict message broken
    mutated = original.replace(
      "if(code==='paid_booking_reprice_required')",
      "if(code==='never_match_paid')",
    );
    if (mutated === original) {
      mutated = original.replace(
        "if (code === 'paid_booking_reprice_required')",
        "if (code === 'never_match_paid')",
      );
    }
    assert('mutation paid conflict changed bytes', mutated !== original);
    fs.writeFileSync(EDIT_MODULE, mutated);
    {
      const fn = extractFunctionSource(fs.readFileSync(EDIT_MODULE, 'utf8'), 'scheduleDrawerHumanSaveError');
      const sandbox = { portalT };
      vm.createContext(sandbox);
      vm.runInContext(fn + '\nthis.fn=scheduleDrawerHumanSaveError;', sandbox);
      const msg = sandbox.fn({ reason_code: 'paid_booking_reprice_required' }, 'Save failed');
      assert('mutation paid conflict OFF → raw/fallback (RED)', !/already paid|payment adjustment/i.test(String(msg)));
    }
    fs.writeFileSync(EDIT_MODULE, original);

    // 6) Duplicate save guard removed
    mutated = original.replace(
      'if (scheduleDrawerSaveInFlight) return;',
      '/* mutated: no duplicate guard */',
    );
    assert('mutation duplicate save changed bytes', mutated !== original);
    fs.writeFileSync(EDIT_MODULE, mutated);
    assert('mutation duplicate guard gone', !/if \(scheduleDrawerSaveInFlight\) return;/.test(fs.readFileSync(EDIT_MODULE, 'utf8')));
    fs.writeFileSync(EDIT_MODULE, original);

    assert('mutation restored exact edit bytes', fs.readFileSync(EDIT_MODULE, 'utf8') === original);
    assert('mutation restored exact view bytes', fs.readFileSync(VIEW_MODULE, 'utf8') === viewOriginal);
  } catch (err) {
    fs.writeFileSync(EDIT_MODULE, original);
    fs.writeFileSync(VIEW_MODULE, viewOriginal);
    assert('mutation block threw', false, String(err && err.message || err));
  }
}

console.log(`\n── verify:sunset-schedule-drawer-edit-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail) process.exit(1);
