'use strict';

/**
 * verify:sunset-staff-edit-past-quote-save
 *
 * P0: Staff Edit on an existing (often past) booking must not fail-closed on
 * explicit_past_date. Quote may allow_past; Save must stay enabled; payment
 * status must not be hard-gated on quote success; ES surfaces the real reason.
 *
 * Run: node scripts/verify-sunset-staff-edit-past-quote-save.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  normalizeSunsetBookingDatesInBody,
  validateSunsetGuestDateBounds,
} = require('./lib/sunset-guest-date-intake');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuoteSync,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');
const {
  executeSunsetStaffScheduleBookingQuote,
} = require('./lib/sunset-staff-schedule-booking-quote');
const { VERTICAL_CHANNELS } = require('./lib/luna-front-desk-business-vertical');

const ROOT = path.join(__dirname, '..');
const EDIT_UI = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-edit-ui.js');
const PORTAL = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');
const I18N_ES = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es-sunset.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DRAWER = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-drawer.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

function extractFn(src, name) {
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

const REF = new Date('2026-08-20T12:00:00Z');
const PAST_FROM = '2026-08-07';
const PAST_TO = '2026-08-10';

console.log('\nverify:sunset-staff-edit-past-quote-save\n');

console.log('[1] Date intake allowPast');
assert('past ISO rejected by default',
  validateSunsetGuestDateBounds(PAST_FROM, REF, { explicit: true }).reason === 'explicit_past_date');
assert('past ISO accepted with allowPast',
  validateSunsetGuestDateBounds(PAST_FROM, REF, { explicit: true, allowPast: true }).ok === true);
assert('body normalize with allowPast',
  normalizeSunsetBookingDatesInBody(
    { date_from: PAST_FROM, date_to: PAST_TO }, REF, { allowPast: true },
  ).ok === true);

console.log('\n[2] Quote command allowPastDates skips past guard');
const transport = {
  guest_name: 'Hernan',
  date_from: PAST_FROM,
  date_to: PAST_TO,
  components: {},
  rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
};
const blocked = buildSunsetQuoteCommand({
  channel: QUOTE_CHANNELS.MANUAL_STAFF,
  trustedLocationId: 'sunset-somo',
  transportBody: transport,
  now: REF,
});
assert('build without allowPastDates ok', blocked.ok === true);
const blockedQuote = executeSunsetQuoteSync(blocked.command, {
  adminCfg: { ok: true, offerings: [], price_rules: [] },
});
assert('quote rejects past without allowPastDates',
  blockedQuote.ok === false
    && (
      (blockedQuote.body && blockedQuote.body.reason_code === 'explicit_past_date')
      || (blockedQuote.body && blockedQuote.body.reason === 'explicit_past_date')
    ),
  JSON.stringify(blockedQuote));

const allowed = buildSunsetQuoteCommand({
  channel: QUOTE_CHANNELS.MANUAL_STAFF,
  trustedLocationId: 'sunset-somo',
  transportBody: transport,
  allowPastDates: true,
  now: REF,
});
assert('build with allowPastDates ok', allowed.ok === true && allowed.command.allowPastDates === true);
const allowedQuote = executeSunsetQuoteSync(allowed.command, {
  adminCfg: { ok: true, offerings: [], price_rules: [] },
});
assert('quote does not fail as explicit_past_date with allowPastDates',
  !(allowedQuote.body && (
    allowedQuote.body.reason_code === 'explicit_past_date'
    || allowedQuote.body.reason === 'explicit_past_date'
  )),
  JSON.stringify(allowedQuote));

console.log('\n[3] Staff schedule quote helper threads allow_past');
let invokedAllowPast = null;
(async () => {
  const quoted = await executeSunsetStaffScheduleBookingQuote({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    body: { ...transport, allow_past: true },
    pgClient: { query: async () => ({ rows: [] }) },
    verticalResolved: { ok: true, locationId: 'sunset-somo', clientSlug: 'sunset' },
    channel: VERTICAL_CHANNELS.MANUAL_STAFF,
    prepareGenericRentals: async () => ({ ok: true, genericRentals: [], records: [] }),
    buildGenericQuote: () => ({ total_cents: 0, line_items: [], currency: 'EUR' }),
    invokeVertical: async (_r, op, _pg, req) => {
      invokedAllowPast = req && req.allowPastDates === true;
      // Simulate success so helper does not fail on empty stub.
      return {
        ok: true,
        status: 200,
        body: {
          success: true,
          total_cents: 1500,
          line_items: [{ component: 'board_rental', total_cents: 1500 }],
        },
      };
    },
    buildQuoteProvenanceFn: () => ({ quote_fingerprint: 'test' }),
  });
  assert('staff quote helper reads allow_past from body', invokedAllowPast === true);
  assert('staff quote helper succeeds for past body', quoted.ok === true, JSON.stringify(quoted));

  console.log('\n[4] Owners + i18n wiring');
  const editSrc = fs.readFileSync(EDIT_UI, 'utf8');
  const portalSrc = fs.readFileSync(PORTAL, 'utf8');
  const esSrc = fs.readFileSync(I18N_ES, 'utf8');
  const apiSrc = fs.readFileSync(API, 'utf8');
  const drawerSrc = fs.readFileSync(DRAWER, 'utf8');

  assert('Edit quote POST sends allow_past: true',
    /allow_past:\s*true/.test(extractFn(editSrc, 'scheduleDrawerRefreshQuote') || ''));
  assert('Edit soft-fail helper exists',
    /function scheduleDrawerIsPastDateQuoteFailure\s*\(/.test(editSrc));
  assert('Edit render does not hard-block Save on past-date',
    /scheduleDrawerQuotePriceBlocked\s*=\s*!pastDateFail/.test(editSrc)
    || /pastDateFail[\s\S]{0,200}scheduleDrawerQuotePriceBlocked\s*=\s*false/.test(
      extractFn(editSrc, 'scheduleDrawerRenderQuotePreview') || '',
    ));
  assert('portal failure message maps explicit_past_date',
    /explicit_past_date[\s\S]{0,120}quotePastDate/.test(
      extractFn(portalSrc, 'schedulePortalQuoteFailureMessage') || '',
    ));
  assert('ES i18n has quotePastDate (not only generic quoteFailed)',
    /schedule\.create\.quotePastDate/.test(esSrc)
    && /Fecha pasada/.test(esSrc));
  assert('generic Presupuesto no disponible remains for other failures',
    /schedule\.create\.quoteFailed.: 'Presupuesto no disponible'/.test(esSrc));
  assert('HTTP update allowPast',
    /normalizeSunsetBookingDatesInBody\(body,\s*new Date\(\),\s*\{\s*allowPast:\s*true\s*\}\)/.test(apiSrc));
  assert('HTTP quote passes allowPastDates from body.allow_past',
    /allowPastDates:\s*body\.allow_past\s*===\s*true/.test(apiSrc));
  assert('drawer update allowPast + allowPastDates',
    /allowPast:\s*true/.test(drawerSrc) && /allowPastDates:\s*true/.test(drawerSrc));

  console.log('\n[5] Edit UI: past-date quote failure keeps Guardar enabled + surfaces reason');
  const nodes = {};
  function N(id, extra) {
    nodes[id] = Object.assign({
      id,
      value: '',
      disabled: false,
      textContent: '',
      innerHTML: '',
      style: { display: 'none' },
      dataset: {},
      setAttribute() {},
      getAttribute() { return null; },
    }, extra || {});
    return nodes[id];
  }
  N('ps-drawer-save', { disabled: true });
  N('ps-drawer-quote-preview', { innerHTML: '', style: { display: 'none' } });

  const portalFailureMsg = extractFn(portalSrc, 'schedulePortalQuoteFailureMessage');
  const sandbox = {
    console,
    JSON,
    Object,
    Array,
    Number,
    String,
    Math,
    Date,
    portalLang: 'es',
    scheduleDrawerQuoteState: null,
    scheduleDrawerQuotePriceBlocked: true,
    scheduleDrawerSaveInFlight: false,
    scheduleDrawerValidationState: { ok: true },
    scheduleDrawerState: {
      ctx: { payment: { total_cents: 12000, subtotal_cents: 12000 } },
    },
    el: (id) => nodes[id] || null,
    portalT: (k) => ({
      'schedule.create.quoteFailed': 'Presupuesto no disponible',
      'schedule.create.quotePastDate':
        'Fecha pasada — Guardar mantiene los precios guardados; actualizar el presupuesto es opcional.',
      'schedule.create.quoteTotal': 'Total presupuestado',
      'schedule.create.quoteStale': 'stale',
      'schedule.create.quoteBusy': 'busy',
      'schedule.create.priceNotConfigured': 'no price',
      'schedule.create.privateLesson.sessionDatePast': 'Las fechas de sesión no pueden ser en el pasado.',
    }[k] || k),
    escHtml: (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    schedulePortalStrictQuoteTotalCents: null,
    scheduleReadDrawerEditPayload: () => ({
      date_from: PAST_FROM,
      date_to: PAST_TO,
      rentals: [{ offering_key: 'bicycle_rental', quantity: 1 }],
      payment_status: 'transfer',
    }),
    scheduleDrawerQuotePricingIntentKey: () => 'intent',
    scheduleAttachDrawerAccommodationQuote: () => {},
  };
  vm.runInNewContext(
    `${portalFailureMsg}\n`
    + `${extractFn(editSrc, 'scheduleDrawerIsPastDateQuoteFailure')}\n`
    + `${extractFn(editSrc, 'scheduleDrawerStoredQuoteTotalCents')}\n`
    + `${extractFn(editSrc, 'scheduleDrawerSyncSaveEnabled')}\n`
    + `${extractFn(editSrc, 'scheduleDrawerRenderQuotePreview')}\n`
    + 'this.schedulePortalQuoteFailureMessage = schedulePortalQuoteFailureMessage;\n'
    + 'this.scheduleDrawerIsPastDateQuoteFailure = scheduleDrawerIsPastDateQuoteFailure;\n'
    + 'this.scheduleDrawerStoredQuoteTotalCents = scheduleDrawerStoredQuoteTotalCents;\n'
    + 'this.scheduleDrawerSyncSaveEnabled = scheduleDrawerSyncSaveEnabled;\n'
    + 'this.scheduleDrawerRenderQuotePreview = scheduleDrawerRenderQuotePreview;\n'
    + 'this.getBlocked = function(){ return scheduleDrawerQuotePriceBlocked; };\n'
    + 'this.setBlocked = function(v){ scheduleDrawerQuotePriceBlocked = !!v; };\n'
    + 'this.getSaveDisabled = function(){ return el("ps-drawer-save").disabled; };\n'
    + 'this.getPreview = function(){ return el("ps-drawer-quote-preview").innerHTML; };\n',
    sandbox,
  );

  sandbox.scheduleDrawerRenderQuotePreview({
    ok: false,
    error: 'explicit_past_date',
    status: 400,
    body: {
      success: false,
      reason: 'explicit_past_date',
      reason_code: 'explicit_past_date',
      needs_clarification: true,
    },
  });

  assert('past-date failure clears quote price block', sandbox.getBlocked() === false);
  assert('Guardar cambios enabled after past-date quote fail', sandbox.getSaveDisabled() === false);
  const preview = sandbox.getPreview();
  assert('preview surfaces Fecha pasada / explicit_past_date (not only generic)',
    /Fecha pasada|data-reason-code="explicit_past_date"/.test(preview),
    preview);
  assert('preview is not generic-only Presupuesto no disponible',
    !(/Presupuesto no disponible/.test(preview) && !/Fecha pasada/.test(preview)),
    preview);
  assert('preview includes stored total when available',
    /Total presupuestado: €120\.00|data-quote-stored="1"/.test(preview),
    preview);

  // Payment-status change must not require a successful quote to enable Save.
  sandbox.setBlocked(false);
  sandbox.scheduleDrawerSyncSaveEnabled();
  assert('payment-status path: Save stays enabled without live quote',
    sandbox.getSaveDisabled() === false);

  // Unpriced (non-past) still blocks Save.
  sandbox.scheduleDrawerRenderQuotePreview({
    ok: false,
    error: 'price_not_configured',
    body: { success: false, reason_code: 'price_not_configured', price_status: 'unpriced' },
  });
  assert('unpriced still blocks Save', sandbox.getBlocked() === true && sandbox.getSaveDisabled() === true);

  console.log(`\n── verify:sunset-staff-edit-past-quote-save ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  if (fail > 0) process.exit(1);
})().catch((err) => {
  console.error('UNCAUGHT', err && err.stack || err);
  process.exit(1);
});
