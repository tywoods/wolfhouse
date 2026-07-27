'use strict';

/**
 * verify:sunset-create-drawer-ux-followup
 *
 * Offline gates for three Create Booking UX follow-ups:
 *  A) No lesson + board/wetsuit hides Quantity; qty from Number of surfers
 *  B) Changing surfers updates quote quantity (payload + server force)
 *  C) Group/Private retain independent gear quantity
 *  D) Switching activities cannot leak stale hidden quantity
 *  E) Blank name/phone allows quote request + authoritative quote result
 *  F) Blank/invalid guest keeps Create disabled; server create fails closed
 *  G) Custom add-on is own outlined card above Payment & notes
 *  H) Covered by verify-sunset-create-custom-line (positive/zero/negative)
 *  I) EN/ES/IT copy for Custom add-on
 *
 * Static + pure quote/create validation only — no DB/Azure/network.
 * Run: node scripts/verify-sunset-create-drawer-ux-followup.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
const writesSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'), 'utf8');
const quoteSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/luna-front-desk-quote-service.js'), 'utf8');
const writes = require('./lib/sunset-schedule-booking-writes');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuoteSync,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

function extractFn(src, name) {
  const n = 'function ' + name + '(';
  const s = src.indexOf(n);
  if (s < 0) return null;
  const b = src.indexOf('{', s);
  let d = 0;
  for (let i = b; i < src.length; i += 1) {
    if (src[i] === '{') d += 1;
    else if (src[i] === '}') {
      d -= 1;
      if (!d) return src.slice(s, i + 1);
    }
  }
  return null;
}

function extractCreateModalHtml(src) {
  const start = src.indexOf('id="ps-create-modal"');
  if (start < 0) return '';
  const open = src.lastIndexOf('<div', start);
  const end = src.indexOf('id="ps-drawer-backdrop"', open);
  const close = src.lastIndexOf('</div>', end);
  return src.slice(open, close > open ? close + 6 : end);
}

console.log('\nverify:sunset-create-drawer-ux-followup\n');

// ── A/C/D) No-lesson qty ownership vs Group/Private independent ─────────────
console.log('[A/C/D] No-lesson equipment qty from surfers; Group/Private independent');
const renderRentalsFn = extractFn(apiSrc, 'scheduleRenderCreateRentals') || '';
const readRentalFn = extractFn(apiSrc, 'scheduleReadCreateRentalSelectionFromDom') || '';
const applyExclFn = extractFn(apiSrc, 'scheduleApplyCreateRentalExclusionUi') || '';
const readPayloadFn = extractFn(apiSrc, 'scheduleReadCreatePayload') || '';
const syncSurfersFn = extractFn(apiSrc, 'scheduleReadCreateSurferCount') || '';

assert('scheduleRenderCreateRentals present', !!renderRentalsFn);
assert('No lesson hides independent Quantity control',
  renderRentalsFn.includes('noLesson')
  && /No lesson: do not render an independent Quantity|if \(!noLesson\)/.test(renderRentalsFn)
  && renderRentalsFn.includes("data-qty-owner=\"surfers\""));
assert('No lesson always derives qty from surfers in render',
  /if \(noLesson\)[\s\S]*qty = surfers != null \? surfers : 1/.test(renderRentalsFn)
  || /noLesson[\s\S]*owner = 'surfers'/.test(renderRentalsFn));
assert('Group/Private preserve user-owned independent gear qty',
  /Group\/Private: preserve independent equipment qty|qtyOwner === 'user'/.test(renderRentalsFn)
  && renderRentalsFn.includes("was.qtyOwner === 'user'"));
assert('read path forces no-lesson qty from surfers (no independent trust)',
  readRentalFn.includes('noLesson')
  && /if \(noLesson\)[\s\S]*scheduleReadCreateSurferCount/.test(readRentalFn));
assert('exclusion UI hides qty wrap in no-lesson',
  applyExclFn.includes('noLesson')
  && applyExclFn.includes('qtyWrap.style.display'));
assert('payload carries surfer_count authority',
  readPayloadFn.includes('surfer_count: surferCount'));
assert('activity switch re-renders rentals (clear stale hidden qty)',
  /ps-create-comp-no-lesson[\s\S]*scheduleRenderCreateRentals\(\)/.test(apiSrc)
  || /scheduleRenderCreateRentals\(\)[\s\S]*ps-create-comp-no-lesson/.test(apiSrc)
  || apiSrc.includes("id === 'ps-create-comp-no-lesson'")
    && apiSrc.includes('scheduleRenderCreateRentals()'));
assert('surfers change force-syncs no-lesson rental qty',
  apiSrc.includes('forceAll')
  && /scheduleCreateIsNoLesson[\s\S]*data-qty-owner/.test(apiSrc)
  || /forceAll \|\| inp\.getAttribute\('data-qty-owner'\) !== 'user'/.test(apiSrc));

// Behavioral: applyNoLessonEquipmentQtyFromSurfers
assert('applyNoLessonEquipmentQtyFromSurfers exported',
  typeof writes.applyNoLessonEquipmentQtyFromSurfers === 'function');
const forced = writes.applyNoLessonEquipmentQtyFromSurfers(
  {
    surfer_count: 3,
    components: { surfboard: { quantity: 9 }, wetsuit: { quantity: 9 } },
  },
  [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 9 }],
);
assert('A: no-lesson forces rental qty from surfer_count (ignore override 9→3)',
  forced.forced === true
  && forced.rentals[0].quantity === 3
  && forced.body.components.surfboard.quantity === 3);
const groupKeep = writes.applyNoLessonEquipmentQtyFromSurfers(
  {
    surfer_count: 4,
    components: {
      course: { course_id: 'c', tier_key: '1_day', quantity: 4 },
      surfboard: { quantity: 2 },
    },
  },
  [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 2 }],
);
assert('C: Group keeps independent gear qty (no force)',
  groupKeep.forced === false
  && groupKeep.rentals[0].quantity === 2);

// prepareCanonicalRentalsForCreate forces no-lesson
const prep = writes.prepareCanonicalRentalsForCreate({
  guest_name: 'X',
  guest_phone: '+34600111222',
  surfer_count: 2,
  date_from: '2026-08-20',
  date_to: '2026-08-20',
  components: { surfboard: { quantity: 7 }, wetsuit: { quantity: 7 } },
  rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 7 }],
});
assert('server prepareCanonical forces no-lesson qty to surfer_count',
  prep.ok && prep.present
  && prep.rentals[0].quantity === 2
  && prep.body.components.surfboard.quantity === 2,
  prep.error || JSON.stringify(prep.rentals));

// ── B/E) Quote with blank name/phone + surfer qty authority ─────────────────
console.log('\n[B/E] Quote without name/phone; surfer qty on requote');
assert('quote service allowBlankGuest for components path',
  /validateScheduleBookingBody\(body,\s*\{\s*allowBlankGuest:\s*true\s*\}/.test(quoteSrc));
assert('rentals-only quote allows blank guest name (no placeholder)',
  /Blank guest name\/phone allowed for authoritative rental quote/.test(quoteSrc)
  || /guestName\.length > 200/.test(quoteSrc)
    && !/if \(!guestName \|\| guestName\.length > 200\)/.test(
      extractFn(quoteSrc, 'resolveQuoteComponentsAndRentalsInput') || '',
    ));
assert('portal soft gate skips guest (quote while blank)',
  /opts\.soft[\s\S]*guest/.test(extractFn(portalSrc, 'schedulePortalValidateCreatePayload') || '')
  || /Soft \(quote\): guest name\/phone not required/.test(portalSrc));
assert('portal fetchQuote sends surfer_count',
  (extractFn(portalSrc, 'schedulePortalFetchQuote') || '').includes('surfer_count'));
assert('portal fetchQuote does not inject fake guest placeholder',
  !(extractFn(portalSrc, 'schedulePortalFetchQuote') || '').includes("'Guest'")
  && !(extractFn(portalSrc, 'schedulePortalFetchQuote') || '').includes('"Guest"'));

const baseCfg = resolveTenantBusinessConfig('sunset', 'sunset-somo');
const prices = (baseCfg.prices || []).slice().filter((p) => {
  const k = String((p && (p.offering_key || p.item_code)) || '');
  return !/board_and_suit_rental/.test(k);
}).concat([
  {
    category: 'rental', offering_key: 'board_and_suit_rental', unit: '1_day',
    amount_cents: 2000, active: true, location_id: 'sunset-somo',
    item_code: 'board_and_suit_rental__1_day',
  },
]);

function quoteWithAdmin(body) {
  const built = buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.MANUAL_STAFF,
    trustedLocationId: 'sunset-somo',
    transportBody: { ...body, require_db: false },
    now: new Date('2026-08-01T12:00:00Z'),
  });
  if (!built.ok) return built;
  return executeSunsetQuoteSync(built.command, {
    adminCfg: { prices, surf_packs: [], lesson_times: [], ok: true },
  });
}

const blankQuote = quoteWithAdmin({
  guest_name: '',
  guest_phone: '',
  surfer_count: 2,
  date_from: '2026-08-20',
  date_to: '2026-08-20',
  components: {},
  rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 9 }],
});
assert('E: blank name/phone quote ok',
  blankQuote.ok === true,
  blankQuote.body && (blankQuote.body.reason || blankQuote.body.error || JSON.stringify(blankQuote.body)));
assert('B: server quotes with surfer_count qty (not stale client 9)',
  blankQuote.ok
  && blankQuote.body
  && blankQuote.body.total_cents === 2000 * 2,
  String(blankQuote.body && blankQuote.body.total_cents));
const blankNamedLine = (blankQuote.body && blankQuote.body.line_items || [])
  .find((l) => l.component === 'board_and_suit_rental');
assert('B: bundle line quantity is 2 (from surfers)',
  blankNamedLine && Number(blankNamedLine.quantity) === 2,
  blankNamedLine && String(blankNamedLine.quantity));

// Requote with different surfer count
const requote = quoteWithAdmin({
  guest_name: '',
  guest_phone: '',
  surfer_count: 4,
  date_from: '2026-08-20',
  date_to: '2026-08-20',
  components: {},
  rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
});
assert('B: changing surfers requotes quantity (4×unit)',
  requote.ok && requote.body && requote.body.total_cents === 2000 * 4,
  String(requote.body && requote.body.total_cents));

// ── F) Create disabled + server fail-closed ─────────────────────────────────
console.log('\n[F] Create requires name/phone; server fail-closed');
assert('hard gate requires guest name',
  /!soft[\s\S]*guestRequired/.test(extractFn(portalSrc, 'schedulePortalValidateCreatePayload') || '')
  || (extractFn(portalSrc, 'schedulePortalValidateCreatePayload') || '').includes('schedule.create.guestRequired'));
assert('hard gate requires valid phone',
  (extractFn(portalSrc, 'schedulePortalValidateCreatePayload') || '').includes('schedule.create.phoneRequired')
  && (extractFn(portalSrc, 'schedulePortalValidateCreatePayload') || '').includes('schedulePortalIsValidCreatePhone'));
assert('submit enable helper present',
  /function schedulePortalSyncCreateSubmitEnabled/.test(portalSrc));
assert('submit disabled when name blank or phone invalid',
  (extractFn(portalSrc, 'schedulePortalSyncCreateSubmitEnabled') || '').includes('schedulePortalIsValidCreatePhone')
  && (extractFn(portalSrc, 'schedulePortalSyncCreateSubmitEnabled') || '').includes('btn.disabled'));
assert('wire footer listens to guest + phone',
  (extractFn(portalSrc, 'schedulePortalWireCreateFooter') || '').includes('ps-create-phone'));
assert('isValidStaffCreateGuestPhone exported',
  typeof writes.isValidStaffCreateGuestPhone === 'function');
assert('phone requires 6+ digits',
  writes.isValidStaffCreateGuestPhone('+34600111222') === true
  && writes.isValidStaffCreateGuestPhone('') === false
  && writes.isValidStaffCreateGuestPhone('12') === false
  && writes.isValidStaffCreateGuestPhone('abc') === false);
assert('create validation requires name (default)',
  writes.validateScheduleBookingBody({
    guest_name: '',
    guest_phone: '+34600111222',
    service_date: '2026-08-20',
    components: { lesson: { quantity: 1 } },
  }, { refDate: new Date('2026-08-01T12:00:00Z') }).ok === false);
assert('create validation allowBlankGuest for quote shape',
  writes.validateScheduleBookingBody({
    guest_name: '',
    guest_phone: '',
    service_date: '2026-08-20',
    components: { lesson: { quantity: 1 } },
  }, { refDate: new Date('2026-08-01T12:00:00Z'), allowBlankGuest: true }).ok === true);
assert('requireGuestPhone fails closed on blank phone',
  writes.validateScheduleBookingBody({
    guest_name: 'Ada',
    guest_phone: '',
    service_date: '2026-08-20',
    components: { lesson: { quantity: 1 } },
  }, { refDate: new Date('2026-08-01T12:00:00Z'), requireGuestPhone: true }).ok === false);
assert('requireGuestPhone accepts valid phone',
  writes.validateScheduleBookingBody({
    guest_name: 'Ada',
    guest_phone: '+34600111222',
    service_date: '2026-08-20',
    components: { lesson: { quantity: 1 } },
  }, { refDate: new Date('2026-08-01T12:00:00Z'), requireGuestPhone: true }).ok === true);
assert('staff create path requires guest phone',
  /requireGuestPhone:\s*attribution\.staffManualSchedule\s*===\s*true/.test(writesSrc));

// Lightweight VM: Create button enable logic
const phoneFn = extractFn(portalSrc, 'schedulePortalIsValidCreatePhone');
const enableFn = extractFn(portalSrc, 'schedulePortalSyncCreateSubmitEnabled');
assert('phone + enable fns extractable', !!phoneFn && !!enableFn);
if (phoneFn && enableFn) {
  const nodes = {};
  function N(id, x) {
    nodes[id] = Object.assign({
      id, value: '', disabled: false, style: {}, dataset: {},
      addEventListener() {},
    }, x || {});
    return nodes[id];
  }
  N('ps-create-submit', { disabled: false });
  N('ps-create-guest', { value: '' });
  N('ps-create-phone', { value: '' });
  const ctx = {
    el: (id) => nodes[id] || null,
    schedulePortalSubmitInFlight: false,
  };
  vm.createContext(ctx);
  vm.runInContext(phoneFn + '\n' + enableFn, ctx);
  ctx.schedulePortalSyncCreateSubmitEnabled();
  assert('F: Create disabled when both blank', nodes['ps-create-submit'].disabled === true);
  nodes['ps-create-guest'].value = 'Ada';
  nodes['ps-create-phone'].value = '';
  ctx.schedulePortalSyncCreateSubmitEnabled();
  assert('F: Create disabled when phone blank', nodes['ps-create-submit'].disabled === true);
  nodes['ps-create-phone'].value = '12';
  ctx.schedulePortalSyncCreateSubmitEnabled();
  assert('F: Create disabled when phone invalid', nodes['ps-create-submit'].disabled === true);
  nodes['ps-create-phone'].value = '+34600111222';
  ctx.schedulePortalSyncCreateSubmitEnabled();
  assert('F: Create enabled when name+valid phone', nodes['ps-create-submit'].disabled === false);
}

// Soft validate allows blank guest
const softGateFn = extractFn(portalSrc, 'schedulePortalValidateCreatePayload');
if (softGateFn) {
  const softCtx = {
    schedulePortalHasSellableIntent(p) {
      const c = (p && p.components) || {};
      return !!(c.course || c.private_lesson || c.surfboard || c.wetsuit
        || (Array.isArray(p.rentals) && p.rentals.length));
    },
    schedulePortalCanonicalDateIso(d) { return d ? String(d).slice(0, 10) : null; },
    schedulePortalMadridTodayIso() { return '2026-08-01'; },
    schedulePortalInclusiveDateCount() { return 1; },
    schedulePortalValidatePrivateLessonCreate() { return { ok: true }; },
    scheduleReadCreateSurferCount() { return 2; },
    SCHEDULE_CANONICAL_RENTAL_OFFERINGS: ['board_rental', 'wetsuit_rental', 'board_and_suit_rental'],
    schedulePortalIsValidCreatePhone: null,
  };
  vm.createContext(softCtx);
  vm.runInContext(
    (extractFn(portalSrc, 'schedulePortalIsValidCreatePhone') || '') + '\n' + softGateFn,
    softCtx,
  );
  const softOk = softCtx.schedulePortalValidateCreatePayload({
    guest_name: '',
    guest_phone: '',
    date_from: '2026-08-20',
    date_to: '2026-08-20',
    components: { surfboard: { quantity: 2 }, wetsuit: { quantity: 2 } },
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 2 }],
  }, { soft: true });
  assert('E: soft/quote gate ok with blank name+phone', softOk && softOk.ok === true,
    softOk && softOk.errorKey);
  const hardFail = softCtx.schedulePortalValidateCreatePayload({
    guest_name: '',
    guest_phone: '',
    date_from: '2026-08-20',
    date_to: '2026-08-20',
    components: { surfboard: { quantity: 2 }, wetsuit: { quantity: 2 } },
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 2 }],
  }, { soft: false });
  assert('F: hard/create gate fails on blank guest', hardFail && hardFail.ok === false);
}

// ── G/I) Custom add-on card + i18n ──────────────────────────────────────────
console.log('\n[G/I] Custom add-on card + EN/ES/IT');
const modal = extractCreateModalHtml(apiSrc);
assert('G: custom-addon section present', /data-create-section="custom-addon"/.test(modal));
assert('G: card class present', /portal-schedule-create-custom-addon-card/.test(modal));
assert('G: label Custom add-on', /Custom add-on/.test(modal)
  && /data-i18n="schedule\.create\.section\.customAddon"/.test(modal));
const cardIdx = modal.indexOf('data-create-section="custom-addon"');
const payIdx = modal.indexOf('data-create-section="payment"');
assert('G: card above Payment & notes section', cardIdx >= 0 && payIdx > cardIdx);
assert('G: not nested in payment', (() => {
  const payChunk = modal.slice(payIdx, payIdx + 800);
  return !payChunk.includes('ps-create-custom-lines');
})());
assert('G: thin outline CSS',
  /\.portal-schedule-create-custom-addon-card\{[^}]*border:\s*1px solid/.test(apiSrc));

const i18nSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const esSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');
const enStart = i18nSrc.indexOf('en: {');
const esBlockStart = i18nSrc.indexOf('\n  es:');
const itStart = i18nSrc.indexOf('\n  it: {');
const enBlock = enStart >= 0 && esBlockStart > enStart ? i18nSrc.slice(enStart, esBlockStart) : '';
let itBlock = '';
if (itStart >= 0) {
  const from = itStart + 1;
  const brace = i18nSrc.indexOf('{', from);
  let depth = 0;
  for (let i = brace; i < i18nSrc.length; i += 1) {
    if (i18nSrc[i] === '{') depth += 1;
    else if (i18nSrc[i] === '}') {
      depth -= 1;
      if (depth === 0) { itBlock = i18nSrc.slice(from, i + 1); break; }
    }
  }
}
assert('I: EN customAddon key', enBlock.includes("'schedule.create.section.customAddon':"));
assert('I: EN exact Custom add-on',
  /'schedule\.create\.section\.customAddon':\s*'Custom add-on'/.test(enBlock));
assert('I: ES customAddon key', esSrc.includes("'schedule.create.section.customAddon':"));
assert('I: IT customAddon key', itBlock.includes("'schedule.create.section.customAddon':"));
assert('I: EN/IT phoneRequired',
  enBlock.includes("'schedule.create.phoneRequired':")
  && itBlock.includes("'schedule.create.phoneRequired':"));
assert('I: ES phoneRequired', esSrc.includes("'schedule.create.phoneRequired':"));

// D: switching to no-lesson clears user qty ownership in render
assert('D: no-lesson path forces owner=surfers (clears user leak)',
  /if \(noLesson\)[\s\S]*owner = 'surfers'/.test(renderRentalsFn));

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
console.log('OK verify-sunset-create-drawer-ux-followup\n');
