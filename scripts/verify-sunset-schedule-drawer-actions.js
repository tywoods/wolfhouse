'use strict';

/**
 * verify:sunset-schedule-drawer-actions
 *
 * Slice 25 — consolidated drawer mutation-actions behavioral gate.
 * Replaces structural payment / waiver / delete slice gates.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-drawer-actions.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  injectSunsetSchedulePortalModule,
  SCHEDULE_ACTIONS_INJECT_MARKER,
} = require('./lib/sunset-schedule-browser-source');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const ACTIONS_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-actions.js');
const VIEW_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const EDIT_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-edit-ui.js');
const CTRL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-controller.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');
const DRAWER_SERVER = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-drawer.js');

const REMOVED_MARKERS = [
  '/* INJECT:sunset-schedule-drawer-payment-ui */',
  '/* INJECT:sunset-schedule-drawer-waiver-ui */',
  '/* INJECT:sunset-schedule-drawer-delete-ui */',
];
const REMOVED_FILES = [
  'scripts/browser/sunset-schedule-drawer-payment-ui.js',
  'scripts/browser/sunset-schedule-drawer-waiver-ui.js',
  'scripts/browser/sunset-schedule-drawer-delete-ui.js',
];

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

function portalT(key) {
  const map = {
    'schedule.drawer.addManualPayment': 'Add manual payment',
    'schedule.drawer.manualPayAmount': 'Amount',
    'schedule.drawer.manualPayMethod': 'Method',
    'schedule.payment.paidBankTransfer': 'Bank',
    'schedule.payment.paidInStore': 'In store',
    'schedule.drawer.manualPayNote': 'Note',
    'schedule.drawer.manualPaySubmit': 'Submit',
    'schedule.drawer.stripeSection': 'Stripe',
    'schedule.drawer.stripeLink': 'Create link',
    'schedule.drawer.stripeRegenerate': 'Regenerate',
    'schedule.drawer.stripeUnavailable': 'Unavailable',
    'schedule.drawer.stripeNone': 'None',
    'schedule.drawer.stripeCopy': 'Copy',
    'schedule.drawer.stripeDelete': 'Delete',
    'schedule.drawer.stripeDeleteConfirm': 'Delete link?',
    'schedule.drawer.stripeStatus': 'Status',
    'schedule.drawer.stripeAmount': 'Amount',
    'schedule.drawer.stripeStatusActive': 'Active',
    'schedule.status.paid': 'Paid',
    'schedule.drawer.stripeFailed': 'Stripe failed',
    'schedule.drawer.stripeDeleted': 'Deleted',
    'schedule.drawer.stripeDeleteFailed': 'Delete failed',
    'schedule.drawer.manualPayAmountRequired': 'Amount required',
    'schedule.drawer.manualPaySaved': 'Saved',
    'schedule.drawer.manualPayFailed': 'Failed',
    'schedule.payment.unpaid': 'Unpaid',
    'schedule.payment.paid': 'Paid',
    'schedule.drawer.waiverNone': 'No waiver yet',
    'schedule.drawer.waiverCreate': 'Create link',
    'schedule.drawer.waiverCreateGroup': 'Create group link',
    'schedule.drawer.waiverStatus': 'Status',
    'schedule.drawer.waiverPending': 'Pending',
    'schedule.drawer.waiverCompleted': 'Completed',
    'schedule.drawer.waiverNeedsReview': 'Needs review',
    'schedule.drawer.waiverExpired': 'Expired',
    'schedule.drawer.waiverRevoked': 'Revoked',
    'schedule.drawer.waiverCompletedAt': 'Completed at',
    'schedule.drawer.waiverViewAnswers': 'View answers',
    'schedule.drawer.waiverAnswers': 'Answers',
    'schedule.drawer.waiverStudentLabel': 'Student',
    'schedule.drawer.waiverGroupLabel': 'Group',
    'schedule.drawer.waiverStudents': 'students',
    'schedule.drawer.waiverCompletedProgress': 'Progress',
    'schedule.drawer.waiverMigrationPending': 'Migration pending',
    'schedule.drawer.waiverCreated': 'Created',
    'schedule.drawer.waiverCreateFailed': 'Create failed',
    'schedule.drawer.waiverLoadFailed': 'Load failed',
    'schedule.drawer.deleteBooking': 'Delete booking',
    'schedule.drawer.deleteBookingConfirm': 'Delete this booking?',
    'schedule.drawer.deleteBookingFailed': 'Could not delete booking:',
  };
  return map[key] || key;
}

function jsonResponse(data, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: () => Promise.resolve(data),
  };
}

console.log('\nverify:sunset-schedule-drawer-actions\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const actionsExists = fs.existsSync(ACTIONS_MODULE);
const actionsSrc = actionsExists ? fs.readFileSync(ACTIONS_MODULE, 'utf8') : '';
const viewSrc = fs.readFileSync(VIEW_MODULE, 'utf8');
const editSrc = fs.readFileSync(EDIT_MODULE, 'utf8');
const ctrlSrc = fs.readFileSync(CTRL_MODULE, 'utf8');
const browserLoader = fs.readFileSync(BROWSER_SRC, 'utf8');
const drawerServerSrc = fs.readFileSync(DRAWER_SERVER, 'utf8');

console.log('[1] Consolidation + injection');
assert('actions module exists', actionsExists);
assert('actions inject marker in portal script', apiSrc.includes(SCHEDULE_ACTIONS_INJECT_MARKER));
assert('browser source loads actions module', browserLoader.includes('getSunsetScheduleDrawerActionsBrowserSource'));
assert('inject uses SCHEDULE_ACTIONS_INJECT_MARKER', browserLoader.includes('SCHEDULE_ACTIONS_INJECT_MARKER'));
REMOVED_MARKERS.forEach((m) => {
  assert(`removed marker absent: ${m}`, !apiSrc.includes(m) && !browserLoader.includes(m));
});
REMOVED_FILES.forEach((rel) => {
  assert(`removed file absent: ${rel}`, !fs.existsSync(path.join(ROOT, rel)));
});
assert('no payment module loader', !browserLoader.includes('getSunsetScheduleDrawerPaymentBrowserSource'));
assert('no waiver module loader', !browserLoader.includes('getSunsetScheduleDrawerWaiverBrowserSource'));
assert('no delete module loader', !browserLoader.includes('getSunsetScheduleDrawerDeleteBrowserSource'));

const markers = [
  '/* INJECT:sunset-schedule-portal-module */',
  '/* INJECT:sunset-schedule-drawer-view-ui */',
  '/* INJECT:sunset-schedule-drawer-edit-ui */',
  '/* INJECT:sunset-schedule-drawer-actions */',
  '/* INJECT:sunset-schedule-drawer-controller */',
  '/* INJECT:sunset-schedule-day-ops-board-ui */',
  '/* INJECT:sunset-schedule-forecast-cards-ui */',
  '/* INJECT:sunset-schedule-view-grid-ui */',
  '/* INJECT:sunset-schedule-runtime */',
  '/* INJECT:sunset-schedule-navigation-ui */',
  '/* INJECT:sunset-schedule-row-normalizer */',
  '/* INJECT:sunset-schedule-data-loader */',
];
let prev = -1;
markers.forEach((m) => {
  const idx = apiSrc.indexOf(m);
  assert(`marker present ${m}`, idx > -1);
  assert(`marker once ${m}`, apiSrc.indexOf(m, idx + 1) === -1);
  if (idx > -1) assert(`marker order ${m}`, idx > prev, `idx=${idx} prev=${prev}`);
  if (idx > prev) prev = idx;
});

assert('inline payment create removed', !apiSrc.includes('function scheduleCreateDrawerStripeLink('));
assert('inline waiver load removed', !apiSrc.includes('function scheduleLoadDrawerWaiver('));
assert('inline delete removed', !apiSrc.includes('function scheduleDeleteBookingFromDrawer('));
assert('view still owns waiver shell', viewSrc.includes('function scheduleRenderDrawerWaiverSectionHtml('));
assert('edit still calls waiver load hook', editSrc.includes('scheduleLoadDrawerWaiver(ctx)'));
assert('controller wires actions hooks', ctrlSrc.includes('scheduleWireDrawerManualPayment') && ctrlSrc.includes('scheduleWireDrawerDeleteBooking'));
assert('delete wiring not in edit/controller bodies', !editSrc.includes('scheduleDeleteBookingFromDrawer') && !ctrlSrc.includes('scheduleDeleteBookingFromDrawer'));
assert('server cancel route unchanged', drawerServerSrc.includes('cancelSunsetScheduleBooking'));

const htmlSample = injectSunsetSchedulePortalModule(
  '<script>(function(){function el(id){return null;}'
  + '/* INJECT:sunset-schedule-portal-module */'
  + '/* INJECT:sunset-schedule-drawer-view-ui */'
  + '/* INJECT:sunset-schedule-drawer-edit-ui */'
  + '/* INJECT:sunset-schedule-drawer-actions */'
  + '/* INJECT:sunset-schedule-drawer-controller */'
  + '/* INJECT:sunset-schedule-day-ops-board-ui */'
  + '/* INJECT:sunset-schedule-forecast-cards-ui */'
  + '/* INJECT:sunset-schedule-view-grid-ui */'
  + '/* INJECT:sunset-schedule-runtime */'
  + '/* INJECT:sunset-schedule-navigation-ui */'
  + '/* INJECT:sunset-schedule-row-normalizer */'
  + '/* INJECT:sunset-schedule-data-loader */'
  + 'function escHtml(s){return s;}})();</script>'
);
assert('inject includes actions module', htmlSample.includes('SunsetScheduleDrawerActions'));
assert('stripe create injected once', htmlSample.split('function scheduleCreateDrawerStripeLink(').length === 2);
assert('waiver load injected once', htmlSample.split('function scheduleLoadDrawerWaiver(').length === 2);
assert('delete injected once', htmlSample.split('function scheduleDeleteBookingFromDrawer(').length === 2);

console.log('\n[2] Closure contract + safety');
assert('defines SunsetScheduleDrawerActions IIFE', /var SunsetScheduleDrawerActions = \(function/.test(actionsSrc));
assert('private flight object', /var flight = \{/.test(actionsSrc));
assert('shared requestJson helper', /function requestJson\(/.test(actionsSrc));
assert('does not assign window', !/window\.SunsetScheduleDrawerActions/.test(actionsSrc));
assert('no tenant/location from DOM input', !/getElementById\(['"]client['"]\)|querySelector\(['"]#client['"]\)|location_id['"]\s*\+|dataset\.location/.test(actionsSrc));
assert('uses getClient + sunsetLocationQuerySuffix', actionsSrc.includes('getClient()') && actionsSrc.includes('sunsetLocationQuerySuffix()'));
assert('stripe create uses in-flight', /flight\.stripeCreate/.test(actionsSrc));
assert('stripe delete uses in-flight', /flight\.stripeDelete/.test(actionsSrc));
assert('manual pay uses in-flight', /flight\.manualPay/.test(actionsSrc));
assert('waiver create uses in-flight', /flight\.waiverCreate/.test(actionsSrc));
assert('delete uses in-flight', /flight\.deleteBooking/.test(actionsSrc));
assert('stale-gen via actionIsActive / openGen', actionsSrc.includes('actionIsActive') && actionsSrc.includes('openGen'));
assert('mutations refetch canonical detail', /paymentRefetchAndRemount|scheduleFetchDrawerContext/.test(actionsSrc));
assert('no Math.max paid balance fallback', !/Math\.max\(sub\s*-\s*paid/.test(actionsSrc));
assert('manual payload has allowed fields only', /amount_cents/.test(actionsSrc) && !/\bsubtotal_cents\b/.test(actionsSrc));
assert('waiver POST body empty object', /body:\s*\{\}/.test(actionsSrc) || /body:\s*JSON\.stringify\(\{\}\)/.test(actionsSrc));
assert('waiver answers escaped', actionsSrc.includes('escHtml(a.label') && actionsSrc.includes('escHtml(String'));
assert('no WhatsApp in actions module', !/whatsapp/i.test(actionsSrc));
assert('delete closes then refreshes (no remount reopen)',
  /closeScheduleDetailDrawer\(\);\s*\n\s*loadSchedulePage\(\);/.test(actionsSrc));
assert('API frozen', actionsSrc.includes('Object.freeze(api)'));

[
  'scheduleCreateDrawerStripeLink',
  'scheduleDeleteDrawerStripeLink',
  'scheduleWireDrawerManualPayment',
  'scheduleLoadDrawerWaiver',
  'scheduleCreateDrawerWaiver',
  'scheduleDeleteBookingFromDrawer',
  'scheduleWireDrawerDeleteBooking',
  'scheduleRenderDrawerPaymentSectionHtml',
  'scheduleRenderWaiverBoxInner',
].forEach((name) => {
  assert(`compatibility export ${name}`, actionsSrc.includes(`function ${name}(`));
});

console.log('\n[3] VM — payment / waiver / delete behavior');
if (!actionsExists) {
  console.log(`\n── verify:sunset-schedule-drawer-actions ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
}

const fetchLog = [];
let confirmResult = true;
let confirmMsg = '';
let scheduleRefreshed = 0;
let drawerClosed = 0;
/** @type {null | ((value: any) => void)} */
let pendingStripeResolve = null;
/** @type {null | ((value: any) => void)} */
let pendingWaiverResolve = null;
/** @type {null | ((value: any) => void)} */
let pendingDeleteResolve = null;

const dom = {
  'ps-drawer-payment-box': { parentNode: { replaceChild() {} } },
  'ps-drawer-stripe-link': { disabled: false },
  'ps-drawer-stripe-delete': { disabled: false, onclick: null },
  'ps-drawer-stripe-msg': { style: { display: 'none' }, className: '', textContent: '' },
  'ps-drawer-manual-submit': { disabled: false, onclick: null },
  'ps-drawer-manual-amount': { value: '10' },
  'ps-drawer-manual-method': { value: 'bank_transfer' },
  'ps-drawer-manual-note': { value: '' },
  'ps-drawer-manual-msg': { style: { display: 'none' }, className: '', textContent: '' },
  'ps-drawer-waiver-box': { innerHTML: '', style: {} },
  'ps-drawer-waiver-create': { disabled: false, onclick: null },
  'ps-drawer-waiver-msg': { style: {}, className: '', textContent: '' },
  'ps-drawer-delete-booking': { disabled: false, style: {}, onclick: null },
  'ps-drawer-save-msg': { className: '', textContent: '', innerHTML: '', style: { display: 'none' }, _text: '' },
  'ps-detail-drawer': { style: { display: 'block' } },
  'ps-drawer-backdrop': { style: { display: 'block' } },
};
Object.defineProperty(dom['ps-drawer-save-msg'], 'textContent', {
  get() { return this._text || ''; },
  set(v) {
    this._text = String(v);
    this.innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },
});

const ctx = {
  console,
  portalT,
  document: { createElement: () => ({ innerHTML: '', firstChild: null }) },
  scheduleDrawerState: {
    row: { booking_id: 'b1', record_source: 'staff_manual' },
    ctx: { booking_id: 'b1', booking_code: 'SS-1' },
    editing: false,
    openGen: 1,
    activeBookingKey: 'id:b1',
  },
  scheduleDrawerCanLoadCanonical: (row) => row && (row.record_source === 'staff_manual' || row.record_source === 'luna_guest') && !row._isDemo,
  scheduleDrawerBookingKey: (row) => (row && row.booking_id ? 'id:' + row.booking_id : null),
  scheduleDrawerIsRequestActive: (openGen, bookingKey) => {
    const st = ctx.scheduleDrawerState;
    if (openGen !== st.openGen) return false;
    if (bookingKey && st.activeBookingKey !== bookingKey) return false;
    const drawer = ctx.el('ps-detail-drawer');
    return !!(drawer && drawer.style.display !== 'none');
  },
  scheduleCloneDrawerCtx: (c) => JSON.parse(JSON.stringify(c)),
  scheduleMountDrawerBody: () => {},
  scheduleRenderDrawerPaymentSectionViewHtml: () => '<div id="ps-drawer-payment-box">view</div>',
  scheduleRenderDrawerPaymentSectionEditHtml: () => '<div id="ps-drawer-payment-box">edit</div>',
  scheduleDrawerEur: (c) => '€' + (Number(c) / 100).toFixed(2),
  scheduleCopyTextFallback: () => {},
  scheduleDrawerFlashCopied: () => {},
  scheduleDateOnlyLabel: (v) => String(v || '').slice(0, 10),
  scheduleDrawerCopyIconBtnHtml: (id) => `<button id="${id}"></button>`,
  schedulePortalStripeLinkFromCtx: (c) => {
    if (c && c.payment_link_invalidated) return { url: 'https://checkout.stripe.com/old', actionable: false, stale: true };
    if (c && c.stripe_link && c.stripe_link.checkout_url) {
      return { url: c.stripe_link.checkout_url, actionable: c.stripe_link.actionable !== false, stale: false };
    }
    return { url: '', actionable: false, stale: false };
  },
  scheduleFetchDrawerContext: (row) => Promise.resolve({ success: true, booking_id: row.booking_id, payment: { balance_due_cents: 5000 } }),
  closeScheduleDetailDrawer: () => {
    drawerClosed += 1;
    ctx.scheduleDrawerState.row = null;
    ctx.scheduleDrawerState.ctx = null;
    ctx.scheduleDrawerState.activeBookingKey = null;
    ctx.scheduleDrawerState.openGen += 1;
    dom['ps-detail-drawer'].style.display = 'none';
  },
  loadSchedulePage: () => { scheduleRefreshed += 1; },
  getClient: () => 'sunset',
  sunsetLocationQuerySuffix: () => '',
  el: (id) => dom[id] || null,
  window: {
    confirm: (msg) => { confirmMsg = msg; return confirmResult; },
    location: { origin: 'https://sunset-staging.lunafrontdesk.com' },
    open: () => {},
  },
  fetch: (url, opts) => {
    fetchLog.push({ url, opts });
    const method = (opts && opts.method) || 'GET';
    if (method === 'POST' && String(url).includes('stripe-link')) {
      return new Promise((resolve) => { pendingStripeResolve = resolve; });
    }
    if (method === 'POST' && String(url).includes('/waiver')) {
      return new Promise((resolve) => { pendingWaiverResolve = resolve; });
    }
    if (method === 'DELETE' && String(url).includes('/staff/schedule/bookings')) {
      return new Promise((resolve) => { pendingDeleteResolve = resolve; });
    }
    if (String(url).includes('/waiver') && !String(url).includes('submission')) {
      return Promise.resolve(jsonResponse({
        success: true,
        waiver: { status: 'pending', public_url: 'https://sunset-staging.lunafrontdesk.com/forms/waiver/waiv_test' },
      }));
    }
    return Promise.resolve(jsonResponse({ success: true }));
  },
};

vm.createContext(ctx);
vm.runInContext(`function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}`, ctx);
vm.runInContext(`function portalT(k){return (${portalT.toString()})(k);}`, ctx);
vm.runInContext(actionsSrc, ctx);

assert('SunsetScheduleDrawerActions present', typeof ctx.SunsetScheduleDrawerActions === 'object');
assert('no window exposure of actions', typeof ctx.window.SunsetScheduleDrawerActions === 'undefined');
assert('requestJson on private API', typeof ctx.SunsetScheduleDrawerActions.requestJson === 'function');
assert('flight private keys', ctx.SunsetScheduleDrawerActions.flight
  && 'stripeCreate' in ctx.SunsetScheduleDrawerActions.flight
  && 'deleteBooking' in ctx.SunsetScheduleDrawerActions.flight);

const unpaid = {
  booking_id: 'b1',
  booking_code: 'SS-1',
  stripe_available: true,
  stripe_link: { checkout_url: 'https://checkout.stripe.com/live', actionable: true },
  payment: { subtotal_cents: 5000, paid_cents: 0, balance_due_cents: 5000 },
};
const unpaidHtml = ctx.scheduleRenderDrawerStripeLinkSectionHtml(unpaid);
assert('active unpaid link renders anchor', unpaidHtml.includes('ps-drawer-stripe-url'));

const invalidated = {
  booking_id: 'b1',
  payment_link_invalidated: true,
  stripe_link: { checkout_url: 'https://checkout.stripe.com/old', actionable: false },
  stripe_available: true,
  payment: { balance_due_cents: 5000, paid_cents: 0 },
};
assert('invalidated link has no actionable anchor', !ctx.scheduleRenderDrawerStripeLinkSectionHtml(invalidated).includes('checkout.stripe.com/old'));

const paid = {
  booking_id: 'b1',
  payment_status: 'paid',
  stripe_available: true,
  payment: { subtotal_cents: 5000, paid_cents: 5000, balance_due_cents: 0 },
};
assert('paid booking hides manual pay shell', ctx.scheduleRenderDrawerManualPaymentHtml(paid) === '');
assert('payment router delegates view mode', ctx.scheduleRenderDrawerPaymentSectionHtml(unpaid, false).includes('view'));
assert('payment router delegates edit mode', ctx.scheduleRenderDrawerPaymentSectionHtml(unpaid, true).includes('edit'));

const xssPay = Object.assign({}, unpaid, {
  stripe_link: { checkout_url: 'https://x.com/<script>', actionable: true },
  booking_code: 'SS-<img>',
});
const xssPayHtml = ctx.scheduleRenderDrawerStripeLinkSectionHtml(xssPay);
assert('stripe URL escaped in href', xssPayHtml.includes('&lt;script&gt;') || !xssPayHtml.includes('<script>'));

const missingHtml = ctx.scheduleRenderWaiverBoxInner({ guest_count: 1, waiver: null });
assert('missing waiver renders empty state', missingHtml.includes('No waiver yet'));
assert('missing waiver shows create action', missingHtml.includes('ps-drawer-waiver-create'));

const pendingHtml = ctx.scheduleRenderWaiverBoxInner({
  guest_count: 1,
  waiver: { status: 'pending', public_url: 'https://x.com/waiv_1' },
});
assert('unsigned pending renders status', pendingHtml.includes('Pending'));
assert('unsigned pending renders actionable URL', pendingHtml.includes('ps-drawer-waiver-url'));

const signedHtml = ctx.scheduleRenderWaiverBoxInner({
  guest_count: 1,
  waiver: {
    status: 'completed',
    completed_at: '2026-07-01',
    public_url: 'https://x.com/waiv_done',
    submission: { raw_answers_json: { answers: { legal_q: { label: 'I accept <terms>', value: 'Sí' } } } },
  },
});
assert('signed waiver renders completed status', signedHtml.includes('Completed'));
assert('signed waiver shows view answers button', signedHtml.includes('ps-drawer-waiver-view'));
assert('signed waiver does not show create button', !signedHtml.includes('id="ps-drawer-waiver-create"'));

const xssWaiver = ctx.scheduleRenderWaiverBoxInner({
  guest_count: 20,
  expected_request_mode: 'group',
  waiver: { status: 'pending', public_url: 'https://x.com/<script>' },
  multi_student_note: '<img onerror=alert(1)>',
});
assert('waiver URL escaped in href', xssWaiver.includes('&lt;script&gt;') || !xssWaiver.includes('<script>'));
assert('group note escaped', xssWaiver.includes('&lt;img'));

const answersHtml = ctx.scheduleRenderWaiverSubmissionBlock({
  raw_answers_json: {
    answers: {
      q1: { label: '<b>Name</b>', value: '<script>' },
      q2: { label: 'Optional', value: null },
    },
  },
});
assert('answer labels escaped', answersHtml.includes('&lt;b&gt;'));
assert('answer values escaped', answersHtml.includes('&lt;script&gt;'));
assert('missing optional answer safe', answersHtml.includes('—'));

assert('untrusted demo cannot delete', ctx.scheduleDrawerCanDeleteBooking({ _isDemo: true, record_source: 'staff_manual' }, { booking_id: 'x' }) === false);
assert('trusted staff can delete', ctx.scheduleDrawerCanDeleteBooking({ record_source: 'staff_manual' }, { booking_id: '11111111-1111-1111-1111-111111111111' }) === true);
assert('trusted luna follows same gate', ctx.scheduleDrawerCanDeleteBooking({ record_source: 'luna_guest' }, { booking_id: '11111111-1111-1111-1111-111111111111' }) === true);
assert('no global scheduleDeleteBookingFromDrawer on this global', typeof global.scheduleDeleteBookingFromDrawer === 'undefined');

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

(async function runAsyncBehavior() {
  fetchLog.length = 0;
  pendingStripeResolve = null;
  ctx.scheduleDrawerState = {
    row: { booking_id: 'b1', record_source: 'staff_manual' },
    ctx: { booking_id: 'b1', booking_code: 'SS-1' },
    editing: false,
    openGen: 1,
    activeBookingKey: 'id:b1',
  };
  dom['ps-detail-drawer'].style.display = 'block';
  ctx.SunsetScheduleDrawerActions.flight.stripeCreate = false;
  ctx.scheduleCreateDrawerStripeLink({ booking_id: 'b1' });
  ctx.scheduleCreateDrawerStripeLink({ booking_id: 'b1' });
  assert('duplicate stripe create issues one POST', fetchLog.filter((f) => f.opts && f.opts.method === 'POST' && f.url.includes('stripe-link')).length === 1);
  if (pendingStripeResolve) pendingStripeResolve(jsonResponse({ success: true }));
  await tick();
  await tick();

  fetchLog.length = 0;
  pendingWaiverResolve = null;
  ctx.SunsetScheduleDrawerActions.flight.waiverCreate = false;
  ctx.scheduleCreateDrawerWaiver();
  ctx.scheduleCreateDrawerWaiver();
  assert('duplicate waiver create issues one POST', fetchLog.filter((f) => f.opts && f.opts.method === 'POST' && f.url.includes('/waiver')).length === 1);
  if (pendingWaiverResolve) pendingWaiverResolve(jsonResponse({ success: true }));
  await tick();
  await tick();

  confirmResult = false;
  fetchLog.length = 0;
  dom['ps-detail-drawer'].style.display = 'block';
  ctx.scheduleDrawerState = {
    row: { booking_id: '11111111-1111-1111-1111-111111111111', record_source: 'staff_manual' },
    ctx: { booking_id: '11111111-1111-1111-1111-111111111111', booking_code: 'SUNSET-TEST-001' },
    openGen: 2,
    activeBookingKey: 'id:11111111-1111-1111-1111-111111111111',
  };
  ctx.SunsetScheduleDrawerActions.flight.deleteBooking = false;
  ctx.scheduleDeleteBookingFromDrawer();
  assert('cancel confirmation sends no DELETE', fetchLog.filter((f) => f.opts && f.opts.method === 'DELETE').length === 0);

  confirmResult = true;
  fetchLog.length = 0;
  drawerClosed = 0;
  scheduleRefreshed = 0;
  pendingDeleteResolve = null;
  ctx.SunsetScheduleDrawerActions.flight.deleteBooking = false;
  ctx.scheduleDeleteBookingFromDrawer();
  assert('successful delete sends one DELETE', fetchLog.filter((f) => f.opts && f.opts.method === 'DELETE').length === 1);
  assert('DELETE body uses trusted booking_id only', fetchLog[0] && JSON.parse(fetchLog[0].opts.body).booking_id === '11111111-1111-1111-1111-111111111111');
  assert('confirm includes booking code', confirmMsg.includes('SUNSET-TEST-001'));
  if (pendingDeleteResolve) {
    pendingDeleteResolve(jsonResponse({ success: true, deleted: true, booking_id: '11111111-1111-1111-1111-111111111111' }));
  }
  await tick();
  await tick();
  assert('successful delete closes drawer', drawerClosed === 1);
  assert('successful delete refreshes schedule', scheduleRefreshed === 1);
  assert('delete bumps gen so removed row cannot reopen via stale action', ctx.scheduleDrawerState.openGen === 3 && ctx.scheduleDrawerState.row == null);

  ctx.scheduleDrawerState = {
    row: { booking_id: 'fail-id', record_source: 'staff_manual' },
    ctx: { booking_id: 'fail-id', booking_code: 'FAIL-001' },
    openGen: 4,
    activeBookingKey: 'id:fail-id',
  };
  dom['ps-detail-drawer'].style.display = 'block';
  ctx.SunsetScheduleDrawerActions.flight.deleteBooking = false;
  dom['ps-drawer-delete-booking'].disabled = false;
  fetchLog.length = 0;
  pendingDeleteResolve = null;
  ctx.scheduleDeleteBookingFromDrawer();
  if (pendingDeleteResolve) {
    pendingDeleteResolve(jsonResponse({ success: false, error: '<script>alert(1)</script>' }, false));
  }
  await tick();
  await tick();
  assert('failed delete keeps drawer open', dom['ps-detail-drawer'].style.display === 'block');
  assert('failed delete releases in-flight', ctx.SunsetScheduleDrawerActions.flight.deleteBooking === false);
  assert('failed delete re-enables button', dom['ps-drawer-delete-booking'].disabled === false);
  assert('failed delete shows safe error text', dom['ps-drawer-save-msg'].textContent.includes('Could not delete booking'));
  assert('failed delete error uses textContent not HTML injection', !dom['ps-drawer-save-msg'].innerHTML.includes('<script'));

  ctx.SunsetScheduleDrawerActions.flight.deleteBooking = true;
  fetchLog.length = 0;
  ctx.scheduleDeleteBookingFromDrawer();
  assert('in-flight blocks duplicate delete', fetchLog.length === 0);

  ctx.SunsetScheduleDrawerActions.flight.deleteBooking = false;
  ctx.scheduleDrawerState = {
    row: { booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', record_source: 'staff_manual' },
    ctx: { booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', booking_code: 'BOOK-A' },
    openGen: 10,
    activeBookingKey: 'id:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  };
  dom['ps-detail-drawer'].style.display = 'block';
  fetchLog.length = 0;
  ctx.window.confirm = function () {
    ctx.scheduleDrawerState = {
      row: { booking_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', record_source: 'staff_manual' },
      ctx: { booking_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', booking_code: 'BOOK-B' },
      openGen: 11,
      activeBookingKey: 'id:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    };
    return true;
  };
  ctx.scheduleDeleteBookingFromDrawer();
  assert('stale confirm sends no DELETE', fetchLog.filter((f) => f.opts && f.opts.method === 'DELETE').length === 0);

  fetchLog.length = 0;
  ctx.scheduleDrawerState = { row: {}, ctx: {}, openGen: 20, activeBookingKey: null };
  ctx.SunsetScheduleDrawerActions.flight.deleteBooking = false;
  ctx.scheduleDeleteBookingFromDrawer();
  assert('missing booking_id fails closed', fetchLog.length === 0);

  ctx.scheduleDrawerState = {
    row: { booking_id: 'b1', record_source: 'staff_manual' },
    ctx: { booking_id: 'b1' },
    openGen: 30,
    activeBookingKey: 'id:b1',
  };
  dom['ps-detail-drawer'].style.display = 'block';
  fetchLog.length = 0;
  ctx.SunsetScheduleDrawerActions.flight.stripeCreate = false;
  ctx.scheduleDrawerState.openGen = 31;
  ctx.scheduleDrawerState.activeBookingKey = 'id:other';
  ctx.scheduleCreateDrawerStripeLink({ booking_id: 'b1' });
  assert('stale drawer generation blocks stripe create', fetchLog.length === 0);

  console.log(`\n── verify:sunset-schedule-drawer-actions ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
