'use strict';

/**
 * verify:sunset-schedule-drawer-payment-ui
 *
 * Slice 14 — Schedule drawer payment-action controller gate.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-drawer-payment-ui.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { injectSunsetSchedulePortalModule, SCHEDULE_PAYMENT_INJECT_MARKER } = require('./lib/sunset-schedule-browser-source');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PAY_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-payment-ui.js');
const VIEW_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const EDIT_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-edit-ui.js');
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
  };
  return map[key] || key;
}

console.log('\nverify:sunset-schedule-drawer-payment-ui\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const payExists = fs.existsSync(PAY_MODULE);
const payModSrc = payExists ? fs.readFileSync(PAY_MODULE, 'utf8') : '';
const viewModSrc = fs.readFileSync(VIEW_MODULE, 'utf8');
const editModSrc = fs.readFileSync(EDIT_MODULE, 'utf8');
const portalModSrc = fs.readFileSync(PORTAL_MODULE, 'utf8');
const browserLoader = fs.readFileSync(BROWSER_SRC, 'utf8');

console.log('[1] Module files and injection order');
assert('payment module exists', payExists);
assert('payment inject marker in portal script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-payment-ui */'));
assert('browser source loads payment module', browserLoader.includes('getSunsetScheduleDrawerPaymentBrowserSource'));
assert('inject chains portal → view → edit → payment', browserLoader.includes('SCHEDULE_PAYMENT_INJECT_MARKER'));

const markers = [
  '/* INJECT:sunset-schedule-portal-module */',
  '/* INJECT:sunset-schedule-drawer-view-ui */',
  '/* INJECT:sunset-schedule-drawer-edit-ui */',
  '/* INJECT:sunset-schedule-drawer-payment-ui */',
  '/* INJECT:sunset-schedule-drawer-waiver-ui */',
];
const idx = markers.map((m) => apiSrc.indexOf(m));
assert('all five markers present once', idx.every((i) => i >= 0) && markers.every((m) => apiSrc.split(m).length === 2));
assert('marker dependency order', idx[0] < idx[1] && idx[1] < idx[2] && idx[2] < idx[3] && idx[3] < idx[4]);
assert('inline scheduleCreateDrawerStripeLink removed', !apiSrc.includes('function scheduleCreateDrawerStripeLink('));
assert('inline scheduleWireDrawerManualPayment removed', !apiSrc.includes('function scheduleWireDrawerManualPayment('));
assert('inline scheduleRenderDrawerPaymentSectionHtml removed', !apiSrc.includes('function scheduleRenderDrawerPaymentSectionHtml('));
assert('edit module no longer owns scheduleUpdateDrawerPaymentFromContext', !editModSrc.includes('function scheduleUpdateDrawerPaymentFromContext('));

const htmlSample = injectSunsetSchedulePortalModule('<script>(function(){function el(id){return null;}/* INJECT:sunset-schedule-portal-module *//* INJECT:sunset-schedule-drawer-view-ui *//* INJECT:sunset-schedule-drawer-edit-ui *//* INJECT:sunset-schedule-drawer-payment-ui *//* INJECT:sunset-schedule-drawer-waiver-ui */function escHtml(s){return s;}})();</script>');
assert('buildUiHtml inject includes payment module', htmlSample.includes('function scheduleCreateDrawerStripeLink('));
assert('payment module injected once', htmlSample.split('function scheduleCreateDrawerStripeLink(').length === 2);

console.log('\n[2] Payment safety and duplicate-action guards');
if (payExists) {
  assert('uses schedulePortalStripeLinkFromCtx for stripe section', payModSrc.includes('schedulePortalStripeLinkFromCtx'));
  assert('stripe section respects actionable flag', payModSrc.includes('resolved.actionable'));
  assert('no Math.max sub paid balance fallback', !/Math\.max\(sub\s*-\s*paid/.test(payModSrc));
  assert('stripe create in-flight guard', /scheduleDrawerStripeCreateInFlight/.test(payModSrc));
  assert('stripe delete in-flight guard', /scheduleDrawerStripeDeleteInFlight/.test(payModSrc));
  assert('manual pay in-flight guard', /scheduleDrawerManualPayInFlight/.test(payModSrc));
  assert('mutations refetch canonical detail', /scheduleDrawerPaymentRefetchAndRemount|scheduleFetchDrawerContext/.test(payModSrc));
  assert('manual payload has allowed fields only', (() => {
    const fn = extractFunctionSource(payModSrc, 'scheduleWireDrawerManualPayment') || '';
    return fn.includes('client_slug') && fn.includes('amount_cents') && !/\bsubtotal_cents\b/.test(fn) && !/\bbalance_due_cents\b/.test(fn);
  })());
  assert('copy wiring uses actionable URL helper', payModSrc.includes('scheduleDrawerPaymentActionableDisplayUrl'));
}

console.log('\n[3] Required payment controller functions');
[
  'schedulePaymentStatusLabel',
  'scheduleRenderDrawerPaymentSectionHtml',
  'scheduleRenderDrawerManualPaymentHtml',
  'scheduleDrawerPaymentShortUrl',
  'scheduleStripeStatusLabel',
  'scheduleRenderDrawerStripeLinkSectionHtml',
  'scheduleWireDrawerStripeCopyOpen',
  'scheduleCreateDrawerStripeLink',
  'scheduleDeleteDrawerStripeLink',
  'scheduleWireDrawerManualPayment',
  'scheduleUpdateDrawerPaymentFromContext',
  'scheduleDrawerPaymentRefetchAndRemount',
].forEach((name) => {
  assert(`module defines ${name}`, payExists && extractFunctionSource(payModSrc, name) != null);
});

console.log('\n[4] VM — actionable links, paid guard, XSS, router');
if (payExists) {
  const dom = {};
  const fetchLog = [];
  let stripeCreateInFlight = false;
  const ctx = {
    console,
    scheduleDrawerState: { row: { booking_id: 'b1' }, ctx: null, editing: false },
    scheduleDrawerStripeCreateInFlight: false,
    scheduleDrawerStripeDeleteInFlight: false,
    scheduleDrawerManualPayInFlight: false,
    el: (id) => dom[id] || null,
    getClient: () => 'sunset',
    sunsetLocationQuerySuffix: () => '',
    scheduleCloneDrawerCtx: (c) => JSON.parse(JSON.stringify(c)),
    scheduleMountDrawerBody: () => {},
    scheduleRenderDrawerPaymentSectionViewHtml: (c) => '<div id="ps-drawer-payment-box">view</div>',
    scheduleRenderDrawerPaymentSectionEditHtml: (c) => '<div id="ps-drawer-payment-box">edit</div>',
    scheduleDrawerEur: (c) => '€' + (Number(c) / 100).toFixed(2),
    scheduleCopyTextFallback: () => {},
    scheduleDrawerFlashCopied: () => {},
    schedulePortalStripeLinkFromCtx: (c) => {
      if (c && c.payment_link_invalidated) return { url: 'https://checkout.stripe.com/old', actionable: false, stale: true };
      if (c && c.stripe_link && c.stripe_link.checkout_url) {
        return { url: c.stripe_link.checkout_url, actionable: c.stripe_link.actionable !== false, stale: false };
      }
      return { url: '', actionable: false, stale: false };
    },
    scheduleFetchDrawerContext: (row) => Promise.resolve({ success: true, booking_id: row.booking_id, payment: { balance_due_cents: 5000 } }),
    fetch: (url, opts) => {
      fetchLog.push({ url, opts });
      if (opts && opts.method === 'POST' && url.includes('stripe-link')) {
        if (stripeCreateInFlight) return Promise.resolve({ ok: false, json: () => Promise.resolve({ success: false }) });
        stripeCreateInFlight = true;
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}`, ctx);
  vm.runInContext(`function portalT(k){return (${portalT.toString()})(k);}`, ctx);
  vm.runInContext('var scheduleDrawerStripeCreateInFlight=false;var scheduleDrawerStripeDeleteInFlight=false;var scheduleDrawerManualPayInFlight=false;', ctx);
  ctx.scheduleDrawerPaymentRefetchAndRemount = () => Promise.resolve({ success: true });
  ctx.scheduleMountDrawerBody = () => {};

  [
    'scheduleDrawerPaymentFullyPaid',
    'scheduleDrawerPaymentActionableDisplayUrl',
    'scheduleDrawerPaymentShortUrl',
    'scheduleStripeStatusLabel',
    'scheduleRenderDrawerStripeLinkSectionHtml',
    'scheduleRenderDrawerManualPaymentHtml',
    'scheduleRenderDrawerPaymentSectionHtml',
    'scheduleWireDrawerStripeCopyOpen',
    'scheduleCreateDrawerStripeLink',
    'scheduleDeleteDrawerStripeLink',
    'scheduleWireDrawerManualPayment',
    'scheduleUpdateDrawerPaymentFromContext',
    'scheduleDrawerPaymentRefetchAndRemount',
  ].forEach((name) => {
    const fnSrc = extractFunctionSource(payModSrc, name);
    if (fnSrc) vm.runInContext(`${fnSrc}\nthis.${name}=${name};`, ctx);
  });

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
  const invHtml = ctx.scheduleRenderDrawerStripeLinkSectionHtml(invalidated);
  assert('invalidated link has no actionable anchor', !invHtml.includes('checkout.stripe.com/old'));

  const paid = {
    booking_id: 'b1',
    payment_status: 'paid',
    stripe_available: true,
    payment: { subtotal_cents: 5000, paid_cents: 5000, balance_due_cents: 0 },
  };
  assert('paid booking hides manual pay shell', ctx.scheduleRenderDrawerManualPaymentHtml(paid) === '');

  assert('payment router delegates view mode', ctx.scheduleRenderDrawerPaymentSectionHtml(unpaid, false).includes('view'));
  assert('payment router delegates edit mode', ctx.scheduleRenderDrawerPaymentSectionHtml(unpaid, true).includes('edit'));

  const xss = Object.assign({}, unpaid, {
    stripe_link: { checkout_url: 'https://x.com/<script>', actionable: true },
    booking_code: 'SS-<img>',
  });
  const xssHtml = ctx.scheduleRenderDrawerStripeLinkSectionHtml(xss);
  assert('stripe URL escaped in href', xssHtml.includes('&lt;script&gt;') || !xssHtml.includes('<script>'));

  ctx.scheduleCreateDrawerStripeLink({ booking_id: 'b1' });
  ctx.scheduleCreateDrawerStripeLink({ booking_id: 'b1' });
  assert('duplicate stripe create issues one POST', fetchLog.filter((f) => f.opts && f.opts.method === 'POST' && f.url.includes('stripe-link')).length === 1);
}

console.log(`\n── verify:sunset-schedule-drawer-payment-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
process.exit(fail ? 1 : 0);
