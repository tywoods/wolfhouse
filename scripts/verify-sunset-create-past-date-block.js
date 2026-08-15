'use strict';

/**
 * verify:sunset-create-past-date-block
 *
 * Create-booking must reject past service dates before submit:
 * soft gate fails, quote preview paints, Create stays disabled.
 * Bonus: failed quotes also keep Create disabled.
 *
 * Run: node scripts/verify-sunset-create-past-date-block.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PORTAL = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');
const WRITES = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-writes.js');
const BOUNDARY = path.join(ROOT, 'scripts', 'verify-sunset-staff-schedule-date-boundary.js');

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

const portalSrc = fs.readFileSync(PORTAL, 'utf8');
const writesSrc = fs.readFileSync(WRITES, 'utf8');
const boundarySrc = fs.readFileSync(BOUNDARY, 'utf8');

console.log('\nverify:sunset-create-past-date-block\n');

console.log('[1] Owners stay on create-validation path (not edit drawer)');
assert('portal module owns validate + soft block helper',
  /function schedulePortalValidateCreatePayload\s*\(/.test(portalSrc)
  && /function schedulePortalIsCreateSoftBlockKey\s*\(/.test(portalSrc)
  && /function schedulePortalSyncCreateSubmitEnabled\s*\(/.test(portalSrc));
assert('soft block includes past/invalid date keys',
  /calendar\.state\.invalidDateRange/.test(extractFn(portalSrc, 'schedulePortalIsCreateSoftBlockKey') || '')
  && /sessionDatePast/.test(extractFn(portalSrc, 'schedulePortalIsCreateSoftBlockKey') || ''));
assert('submit uses shared hard gate',
  /schedulePortalValidateCreatePayload/.test(extractFn(portalSrc, 'submitScheduleManualBooking') || ''));
assert('server write path still validates body',
  /validateScheduleBookingBody/.test(writesSrc)
  && /explicit_past_date/.test(boundarySrc));

const TODAY = '2026-08-15';
const PAST = '2026-08-10';

function makeSandbox() {
  const nodes = {};
  function N(id, extra) {
    nodes[id] = Object.assign({
      id,
      value: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      style: { display: 'none' },
      dataset: {},
      classList: { add() {}, remove() {} },
      setAttribute(k, v) { this['_' + k] = v; },
      getAttribute(k) { return this['_' + k] != null ? this['_' + k] : null; },
      removeAttribute(k) { delete this['_' + k]; },
      addEventListener() {},
    }, extra || {});
    return nodes[id];
  }
  N('ps-create-submit', { disabled: false });
  N('ps-create-guest', { value: 'Ada' });
  N('ps-create-phone', { value: '+34600111222' });
  N('ps-create-date-from', { value: TODAY });
  N('ps-create-date-to', { value: TODAY });
  N('ps-create-quote-preview', { innerHTML: '', style: { display: 'none' } });
  N('ps-create-msg', { textContent: '', style: { display: 'none' } });
  N('ps-create-comp-course', { checked: false });

  const ctx = {
    console,
    JSON,
    Object,
    Array,
    Number,
    String,
    Math,
    Date,
    Intl,
    schedulePortalQuoteState: null,
    schedulePortalQuotePriceBlocked: false,
    schedulePortalSubmitInFlight: false,
    schedulePortalQuoteGen: 0,
    el: (id) => nodes[id] || null,
    portalT: (k) => ({
      'calendar.state.invalidDateRange': 'Enter valid dates as DD/MM/YYYY.',
      'schedule.create.privateLesson.sessionDatePast': 'Session dates cannot be in the past.',
      'schedule.create.courseOrTurnOff': 'Select a course or turn off Group Course',
      'schedule.create.courseRequired': 'Select a course or turn off Group Course',
      'schedule.create.quoteFailed': 'Quote unavailable',
      'schedule.create.componentsRequired': 'Select at least one component.',
      'schedule.create.guestRequired': 'Guest name is required.',
      'schedule.create.phoneRequired': 'Enter a valid phone number.',
    }[k] || k),
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    schedulePortalGetSelectedCreateCourseId: () => '',
    scheduleReadCreateSurferCount: () => 1,
    scheduleCreateCourseGuestCap: () => 24,
    schedulePortalHasSellableIntent(p) {
      const c = (p && p.components) || {};
      return !!(c.course || c.private_lesson || c.surfboard || c.wetsuit
        || (Array.isArray(p.rentals) && p.rentals.length)
        || (c.full_day_equipment_extension));
    },
    schedulePortalInclusiveDateCount() { return 1; },
    _nodes: nodes,
  };
  vm.createContext(ctx);
  const names = [
    'schedulePortalMadridTodayIso',
    'schedulePortalCanonicalDateIso',
    'schedulePortalIsValidCreatePhone',
    'schedulePortalIsCreateSoftBlockKey',
    'schedulePortalValidatePrivateLessonCreate',
    'schedulePortalValidateCreatePayload',
    'schedulePortalRenderCreateQuotePreview',
    'schedulePortalSyncCreateSubmitEnabled',
    'schedulePortalApplyQuoteFailure',
    'schedulePortalResetQuoteRuntimeState',
  ];
  let code = '';
  for (const name of names) {
    const fn = extractFn(portalSrc, name);
    if (!fn) throw new Error('missing function ' + name);
    code += `${fn}\n`;
  }
  // Freeze Madrid "today" for deterministic past-date assertions (overrides extract).
  code += `\nfunction schedulePortalMadridTodayIso(){ return '${TODAY}'; }\n`;
  code += names.map((n) => `this.${n} = ${n};`).join('\n');
  vm.runInContext(code, ctx);
  return ctx;
}

console.log('\n[2] Soft validate rejects past service dates');
{
  const sb = makeSandbox();
  const past = sb.schedulePortalValidateCreatePayload({
    guest_name: 'Ada',
    guest_phone: '+34600111222',
    date_from: PAST,
    date_to: PAST,
    components: {},
    rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
  }, { soft: true });
  assert('soft past → softInvalid invalidDateRange',
    past && past.ok === false && past.softInvalid === true
    && past.errorKey === 'calendar.state.invalidDateRange',
    JSON.stringify(past));

  const todayOk = sb.schedulePortalValidateCreatePayload({
    guest_name: 'Ada',
    guest_phone: '+34600111222',
    date_from: TODAY,
    date_to: TODAY,
    components: {},
    rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
  }, { soft: true });
  assert('soft today ok', todayOk && todayOk.ok === true, JSON.stringify(todayOk));

  const hardPast = sb.schedulePortalValidateCreatePayload({
    guest_name: 'Ada',
    guest_phone: '+34600111222',
    date_from: PAST,
    date_to: PAST,
    components: {},
    rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
  }, { soft: false });
  assert('hard past blocked',
    hardPast && hardPast.ok === false && hardPast.errorKey === 'calendar.state.invalidDateRange');
}

console.log('\n[3] Soft past-date paints + disables Create');
{
  const sb = makeSandbox();
  sb.schedulePortalSyncCreateSubmitEnabled();
  assert('baseline Create enabled (today + guest)',
    sb._nodes['ps-create-submit'].disabled === false);

  sb.schedulePortalRenderCreateQuotePreview({
    ok: false,
    softInvalid: true,
    errorKey: 'calendar.state.invalidDateRange',
  });
  const box = sb._nodes['ps-create-quote-preview'];
  assert('past soft paints invalid-date status',
    /invalid-date/.test(box.innerHTML) && box.style.display === 'block');
  assert('past soft message is human',
    /Enter valid dates/.test(box.innerHTML) && !/calendar\.state\./.test(box.innerHTML));
  assert('past soft sets QuotePriceBlocked', sb.schedulePortalQuotePriceBlocked === true);
  assert('past soft disables Create', sb._nodes['ps-create-submit'].disabled === true);

  sb._nodes['ps-create-date-from'].value = PAST;
  sb._nodes['ps-create-date-to'].value = PAST;
  sb.schedulePortalQuotePriceBlocked = false;
  sb.schedulePortalSyncCreateSubmitEnabled();
  assert('live past date inputs disable Create',
    sb._nodes['ps-create-submit'].disabled === true);
}

console.log('\n[4] Private session past date soft-block');
{
  const sb = makeSandbox();
  const pl = sb.schedulePortalValidateCreatePayload({
    guest_name: 'Pri',
    guest_phone: '+34600111222',
    date_from: TODAY,
    date_to: TODAY,
    components: {
      private_lesson: {
        enabled: true,
        quantity: 1,
        surfer_count: 1,
        sessions: [{ date: PAST, start: '10:00', end: '12:00' }],
      },
    },
    rentals: [],
  }, { soft: true });
  assert('private past session softInvalid',
    pl && pl.ok === false && pl.softInvalid === true
    && pl.errorKey === 'schedule.create.privateLesson.sessionDatePast',
    JSON.stringify(pl));

  sb.schedulePortalRenderCreateQuotePreview({
    ok: false,
    softInvalid: true,
    errorKey: 'schedule.create.privateLesson.sessionDatePast',
  });
  assert('private past paints + disables Create',
    /invalid-date/.test(sb._nodes['ps-create-quote-preview'].innerHTML)
    && sb.schedulePortalQuotePriceBlocked === true
    && sb._nodes['ps-create-submit'].disabled === true);
}

console.log('\n[5] Bonus — failed quote keeps Create disabled');
{
  const sb = makeSandbox();
  sb.schedulePortalApplyQuoteFailure({
    ok: false,
    error: 'quote_failed',
    body: { reason_code: 'price_unavailable' },
  });
  assert('quote failure blocks Create',
    sb.schedulePortalQuotePriceBlocked === true
    && sb._nodes['ps-create-submit'].disabled === true);
  assert('quote failure paints unpriced UI',
    /unpriced|Quote unavailable|quoteFailed/i.test(sb._nodes['ps-create-quote-preview'].innerHTML));
}

console.log(`\n── verify:sunset-create-past-date-block ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
process.exit(fail ? 1 : 0);
