'use strict';

/**
 * verify:sunset-schedule-drawer-edit-ui
 *
 * Slice 13 — Schedule drawer edit controller gate.
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
const PAY_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-payment-ui.js');
const VIEW_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const PORTAL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');

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

function portalT(key) {
  const map = {
    'schedule.create.guestName': 'Guest name',
    'schedule.create.guestRequired': 'Guest required',
    'schedule.create.componentsRequired': 'Components required',
    'schedule.drawer.save': 'Save',
    'schedule.drawer.cancel': 'Cancel',
    'schedule.drawer.editTitle': 'Edit booking',
    'schedule.drawer.phone': 'Phone',
    'schedule.create.dateFrom': 'From',
    'schedule.create.dateTo': 'To',
    'schedule.create.payment': 'Payment',
    'schedule.payment.unpaid': 'Unpaid',
    'schedule.payment.paidBankTransfer': 'Bank',
    'schedule.payment.paidInStore': 'In store',
    'schedule.payment.paidViaLink': 'Link',
    'schedule.drawer.notes': 'Notes',
    'schedule.drawer.paymentsTitle': 'Payments',
    'schedule.drawer.saveFailed': 'Save failed',
    'schedule.drawer.saved': 'Saved',
    'schedule.type.wetsuitRental': 'Wetsuit',
    'schedule.type.boardRental': 'Board',
    'schedule.type.course': 'Course',
    'schedule.type.privateCourse': 'Private',
    'schedule.create.courseSelect': 'Course',
    'schedule.create.courseTier': 'Tier',
    'schedule.create.surferCount': 'Surfers',
    'schedule.create.boardQty': 'Boards',
    'schedule.create.wetsuitQty': 'Wetsuits',
    'schedule.create.privateLesson.sessionsHelp': 'Sessions',
    'schedule.create.privateLesson.addSession': 'Add',
    'schedule.type.fullDayEquipment': 'Full day',
    'schedule.drawer.section.notes': 'Notes',
    'schedule.drawer.subtotal': 'Subtotal',
    'schedule.drawer.paid': 'Paid',
    'schedule.drawer.remaining': 'Remaining',
    'schedule.drawer.paymentSection': 'Payment',
    'schedule.drawer.noLineItems': 'None',
    'schedule.col.payment': 'Payment',
    'schedule.drawer.livePricingNote': 'Live pricing',
  };
  return map[key] || key;
}

console.log('\nverify:sunset-schedule-drawer-edit-ui\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const editExists = fs.existsSync(EDIT_MODULE);
const editModSrc = editExists ? fs.readFileSync(EDIT_MODULE, 'utf8') : '';
const ctrlModSrc = fs.existsSync(CTRL_MODULE) ? fs.readFileSync(CTRL_MODULE, 'utf8') : '';
const viewModSrc = fs.readFileSync(VIEW_MODULE, 'utf8');
const portalModSrc = fs.readFileSync(PORTAL_MODULE, 'utf8');
const payModSrc = fs.existsSync(PAY_MODULE) ? fs.readFileSync(PAY_MODULE, 'utf8') : '';
const browserLoader = fs.readFileSync(BROWSER_SRC, 'utf8');

console.log('[1] Module files and injection order');
assert('edit module exists', editExists);
assert('edit inject marker in portal script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-edit-ui */'));
assert('browser source loads edit module', browserLoader.includes('getSunsetScheduleDrawerEditBrowserSource'));
assert('inject chains portal → view → edit', browserLoader.includes('SCHEDULE_DRAWER_EDIT_INJECT_MARKER'));
assert('inline scheduleRenderEditableDrawerHtml removed', !apiSrc.includes('function scheduleRenderEditableDrawerHtml('));
assert('inline scheduleSaveDrawerBooking removed', !apiSrc.includes('function scheduleSaveDrawerBooking('));
assert('inline scheduleEnterDrawerEditMode removed', !apiSrc.includes('function scheduleEnterDrawerEditMode('));
assert('payment section wrapper in payment module', payModSrc.includes('function scheduleRenderDrawerPaymentSectionHtml('));
assert('payment wrapper removed from staff-api', !apiSrc.includes('function scheduleRenderDrawerPaymentSectionHtml('));

const markerIdxPortal = apiSrc.indexOf('/* INJECT:sunset-schedule-portal-module */');
const markerIdxView = apiSrc.indexOf('/* INJECT:sunset-schedule-drawer-view-ui */');
const markerIdxEdit = apiSrc.indexOf('/* INJECT:sunset-schedule-drawer-edit-ui */');
const markerIdxPay = apiSrc.indexOf('/* INJECT:sunset-schedule-drawer-payment-ui */');
const markerIdxWaiver = apiSrc.indexOf('/* INJECT:sunset-schedule-drawer-waiver-ui */');
assert('marker order portal < view < edit < payment < waiver', markerIdxPortal > -1 && markerIdxView > markerIdxPortal && markerIdxEdit > markerIdxView && markerIdxPay > markerIdxEdit && markerIdxWaiver > markerIdxPay);
const markerIdxCtrl = apiSrc.indexOf('/* INJECT:sunset-schedule-drawer-controller */');
assert('marker order waiver < controller', markerIdxCtrl > markerIdxWaiver);
assert('mount orchestration in controller module', ctrlModSrc.includes('function scheduleMountDrawerBody('));
assert('open editable orchestration in controller module', ctrlModSrc.includes('function scheduleOpenEditableDrawer('));

const htmlSample = injectSunsetSchedulePortalModule('<script>(function(){function el(id){return null;}/* INJECT:sunset-schedule-portal-module *//* INJECT:sunset-schedule-drawer-view-ui *//* INJECT:sunset-schedule-drawer-edit-ui *//* INJECT:sunset-schedule-drawer-payment-ui *//* INJECT:sunset-schedule-drawer-waiver-ui */function escHtml(s){return s;}})();</script>');
assert('buildUiHtml inject includes edit module body', htmlSample.includes('function scheduleEnterDrawerEditMode('));
assert('buildUiHtml inject includes view module body', htmlSample.includes('function scheduleRenderViewDrawerHtml('));
assert('buildUiHtml inject includes portal module body', htmlSample.includes('function schedulePortalFetchDrawerDetail('));

console.log('\n[2] Edit module must not introduce price authority');
if (editExists) {
  assert('save PATCH uses in-flight guard', editModSrc.includes('scheduleDrawerSaveInFlight'));
  assert('save refetches canonical detail after PATCH', /schedulePortalFetchDrawerDetail|scheduleFetchDrawerContext/.test(editModSrc));
  assert('no Math.max sub paid balance fallback', !/Math\.max\(sub\s*-\s*paid/.test(editModSrc));
  assert('duplicate-save early return', /if \(scheduleDrawerSaveInFlight\) return/.test(editModSrc));
  assert('payload reader whitelists editable fields', editModSrc.includes('function scheduleReadDrawerEditPayload('));
  assert('payment parse uses allowed select values', editModSrc.includes('function scheduleParsePaymentSelectValue('));
  assert('validation blocks empty guest before PATCH', editModSrc.includes("if (!payload.guest_name)"));
  assert('validation blocks empty components before PATCH', editModSrc.includes('!Object.keys(payload.components).length'));
}

console.log('\n[3] Required edit controller functions in module');
[
  'scheduleRenderEditableDrawerHtml',
  'scheduleEnterDrawerEditMode',
  'scheduleCancelDrawerEditMode',
  'scheduleWireEditableDrawer',
  'scheduleReadDrawerEditPayload',
  'scheduleSaveDrawerBooking',
  'scheduleRenderDrawerPaymentSelectHtml',
  'scheduleRenderDrawerPaymentSectionEditHtml',
].forEach((name) => {
  assert(`module defines ${name}`, editExists && extractFunctionSource(editModSrc, name) != null);
});
['scheduleMountDrawerBody', 'scheduleOpenEditableDrawer'].forEach((name) => {
  assert(`controller defines ${name}`, ctrlModSrc.includes(`function ${name}(`));
});

console.log('\n[4] VM — edit lifecycle, staff + Luna parity, validation, XSS');
if (editExists) {
  const dom = {};
  const fetchLog = [];
  let saveInFlight = false;
  const ctx = {
    console,
    document: {
      createElement: () => ({ innerHTML: '', firstChild: null, parentNode: { replaceChild() {} } }),
    },
    scheduleDrawerState: {
      row: { booking_id: '11111111-1111-1111-1111-111111111111', record_source: 'staff_manual' },
      ctx: {
        booking_id: '11111111-1111-1111-1111-111111111111',
        guest_name: 'Alex',
        phone: '+34111',
        date_from: '2026-07-20',
        date_to: '2026-07-20',
        notes: 'ok',
        components: { course: { course_id: 'c1', tier_key: '1_week', quantity: 2, course_label: 'Beginner' } },
        payment_status: 'unpaid',
        payment: { subtotal_cents: 10000, paid_cents: 0, balance_due_cents: 10000, line_items: [] },
      },
      editing: false,
      openGen: 0,
      refreshGen: 0,
      activeBookingKey: null,
    },
    scheduleDrawerSaveInFlight: false,
    scheduleLastDrawerRowId: null,
    scheduleCoursesCache: [{ course_id: 'c1', label: 'Beginner', price_tiers: [{ key: '1_week', label: '1 week' }] }],
    scheduleFullDayAddonEnabled: false,
    el: (id) => dom[id] || null,
    getClient: () => 'sunset',
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
    scheduleDrawerPopulateComponentFields: () => {},
    scheduleRefreshDrawerFullDayAddon: () => {},
    scheduleEnumerateDates: (a, b) => [a],
    scheduleReadFullDayAddonRows: () => ({}),
    scheduleRenderFullDayAddonRows: () => {},
    scheduleUpdateFullDayAddonSummary: () => {},
    scheduleTodayIso: () => '2026-07-20',
    schedulePaymentStatusLabel: (s) => s,
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
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, context: { guest_name: body.guest_name, booking_id: body.booking_id, components: body.components, payment: { subtotal_cents: 10000, paid_cents: 0, balance_due_cents: 10000 } } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}`, ctx);
  vm.runInContext(`function portalT(k){return (${portalT.toString()})(k);}`, ctx);

  vm.runInContext('var scheduleDrawerSaveInFlight = false;', ctx);

  [
    'scheduleParsePaymentSelectValue',
    'scheduleDrawerPaymentSelectValue',
    'scheduleRenderDrawerPaymentSelectHtml',
    'scheduleRenderDrawerPaymentSectionEditHtml',
    'scheduleRenderEditableDrawerHtml',
    'scheduleReadDrawerEditPayload',
    'scheduleDrawerPopulateComponentFields',
    'scheduleRefreshDrawerFullDayAddon',
    'scheduleUpdateDrawerTotalPreview',
    'scheduleDrawerOnComponentChange',
    'scheduleDrawerPopulateCourseSelect',
    'scheduleDrawerPopulateCourseTierFields',
    'scheduleDrawerReadPrivateSessionsFromDom',
    'scheduleDrawerRenderPrivateSessions',
    'scheduleDrawerSyncPrivateSessions',
    'scheduleDrawerAddPrivateSession',
    'scheduleEnterDrawerEditMode',
    'scheduleCancelDrawerEditMode',
    'scheduleSaveDrawerBooking',
    'scheduleWireEditableDrawer',
  ].forEach((name) => {
    const fnSrc = extractFunctionSource(editModSrc, name);
    if (fnSrc) vm.runInContext(`${fnSrc}\nthis.${name}=${name};`, ctx);
  });
  ['scheduleMountDrawerBody', 'scheduleOpenEditableDrawer', 'scheduleDrawerShowShell', 'scheduleCloneDrawerCtx'].forEach((name) => {
    const fnSrc = extractFunctionSource(ctrlModSrc, name);
    if (fnSrc) vm.runInContext(`${fnSrc}\nthis.${name}=${name};`, ctx);
  });
  vm.runInContext('if(typeof scheduleDrawerState==="undefined"){var scheduleDrawerState={row:null,ctx:null,editing:false,openGen:0,refreshGen:0,activeBookingKey:null};}', ctx);

  dom['ps-detail-drawer'] = { style: {} };
  dom['ps-drawer-backdrop'] = { style: {} };
  dom['ps-drawer-body'] = { innerHTML: '' };

  ctx.scheduleOpenEditableDrawer(ctx.scheduleDrawerState.row, ctx.scheduleDrawerState.ctx);
  assert('open drawer starts in view mode', ctx.scheduleDrawerState.editing === false);

  ctx.scheduleEnterDrawerEditMode();
  assert('enter edit sets editing flag', ctx.scheduleDrawerState.editing === true);
  assert('edit form rendered', dom['ps-drawer-body'].innerHTML.includes('ps-drawer-edit-form'));

  const staffHtml = dom['ps-drawer-body'].innerHTML;
  assert('edit form shows guest value', staffHtml.includes('Alex'));
  assert('edit form shows course qty', staffHtml.includes('value="2"'));

  ctx.scheduleDrawerState.row.record_source = 'luna_guest';
  ctx.scheduleEnterDrawerEditMode();
  assert('luna booking same edit form', dom['ps-drawer-body'].innerHTML.includes('ps-drawer-edit-form'));

  const patchCountBefore = fetchLog.filter((f) => f.opts && f.opts.method === 'PATCH').length;
  ctx.scheduleCancelDrawerEditMode();
  assert('cancel restores view mode', ctx.scheduleDrawerState.editing === false);
  assert('cancel performs no PATCH', fetchLog.filter((f) => f.opts && f.opts.method === 'PATCH').length === patchCountBefore);

  ctx.scheduleEnterDrawerEditMode();
  dom['ps-drawer-guest'] = { value: '<script>x</script>' };
  dom['ps-drawer-phone'] = { value: '' };
  dom['ps-drawer-date-from'] = { value: '2026-07-20' };
  dom['ps-drawer-date-to'] = { value: '2026-07-20' };
  dom['ps-drawer-payment'] = { value: 'unpaid' };
  dom['ps-drawer-notes'] = { value: 'note' };
  dom['ps-drawer-comp-course'] = { checked: true };
  dom['ps-drawer-comp-private-lesson'] = { checked: false };
  dom['ps-drawer-comp-surfboard'] = { checked: false };
  dom['ps-drawer-comp-wetsuit'] = { checked: false };
  dom['ps-drawer-course-select'] = { value: 'c1', selectedIndex: 0, options: [{ getAttribute: () => 'Beginner', textContent: 'Beginner' }] };
  dom['ps-drawer-course-tier'] = { value: '1_week' };
  dom['ps-drawer-course-qty'] = { value: '2' };
  dom['ps-drawer-save-msg'] = { style: {}, className: '', textContent: '' };
  dom['ps-drawer-save'] = { disabled: false };

  const payload = ctx.scheduleReadDrawerEditPayload();
  assert('payload course_id canonical', payload.components.course.course_id === 'c1');
  assert('payload tier_key present', payload.components.course.tier_key === '1_week');
  assert('payload no server-owned payment cents', payload.balance_due_cents == null && payload.subtotal_cents == null);

  assert('payment select paid_bank_transfer maps correctly', ctx.scheduleParsePaymentSelectValue('paid_bank_transfer').method === 'bank_transfer');
  assert('payment select unpaid maps correctly', ctx.scheduleParsePaymentSelectValue('unpaid').status === 'unpaid');

  const xssCtx = Object.assign({}, ctx.scheduleDrawerState.ctx, { guest_name: '<img onerror=alert(1)>', notes: '<script>n</script>' });
  const xssHtml = ctx.scheduleRenderEditableDrawerHtml(ctx.scheduleDrawerState.row, xssCtx);
  assert('edit form escapes guest name in value attr', xssHtml.includes('&lt;img') && !xssHtml.includes('<img onerror'));
  assert('edit form escapes notes in textarea', xssHtml.includes('&lt;script&gt;'));

  dom['ps-drawer-guest'] = { value: '' };
  dom['ps-drawer-comp-course'] = { checked: false };
  dom['ps-drawer-comp-private-lesson'] = { checked: false };
  dom['ps-drawer-comp-surfboard'] = { checked: false };
  dom['ps-drawer-comp-wetsuit'] = { checked: false };
  dom['ps-drawer-save-msg'] = { style: {}, className: '', textContent: '', display: '' };
  const patchesBeforeVal = fetchLog.filter((f) => f.opts && f.opts.method === 'PATCH').length;
  ctx.scheduleSaveDrawerBooking(ctx.scheduleDrawerState.row);
  assert('validation failure blocks PATCH (empty guest)', fetchLog.filter((f) => f.opts && f.opts.method === 'PATCH').length === patchesBeforeVal);
  assert('validation stays in edit mode', ctx.scheduleDrawerState.editing === true);
}

console.log(`\n── verify:sunset-schedule-drawer-edit-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail) process.exit(1);
