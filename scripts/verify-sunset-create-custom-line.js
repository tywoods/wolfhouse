'use strict';

/**
 * verify:sunset-create-custom-line
 *
 * Offline gate for Create booking staff custom commercial lines:
 *  - UI placement above Payments; collapsed +; add/remove multiple; escaping
 *  - positive/zero/negative parsing, -0 normalization, >2 decimals reject
 *  - aggregate below zero reject; exact total
 *  - server auth/tenant + custom_line_items validation
 *  - idempotent persistence identity; client cannot mutate Admin cents
 *  - signed custom amounts CHECK-safe (amount_due ≥ 0) + metadata.amount_cents
 *  - custom rows never excluded from quote claim as full-day addon rows
 *  - stale quote invalidation via fingerprint
 *
 * No DB / Azure / network.
 * Source checks use exact bounded function markers only — never broad non-greedy.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
const writesSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'), 'utf8');
const writes = require('./lib/sunset-schedule-booking-writes');
const quoteSvc = require('./lib/luna-front-desk-quote-service');

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

/** Exact bounded function body via brace matching — never /fn[\s\S]*?/ non-greedy. */
function extractFn(src, name) {
  const needle = 'function ' + name + '(';
  const start = src.indexOf(needle);
  if (start < 0) return null;
  const brace = src.indexOf('{', start);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
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

console.log('\nverify:sunset-create-custom-line\n');

// ── 1) UI placement: own outlined card above Payment & notes ────────────────
console.log('[1] Custom add-on card above Payment & notes (not nested)');
const modal = extractCreateModalHtml(apiSrc);
const customPos = modal.indexOf('id="ps-create-custom-lines"');
const customCardPos = modal.indexOf('data-create-section="custom-addon"');
const paymentSectionPos = modal.indexOf('data-create-section="payment"');
const paymentPos = modal.indexOf('id="ps-create-section-payment-title"');
const paySelectPos = modal.indexOf('id="ps-create-payment"');
ok('custom section present', customPos >= 0);
ok('custom add-on is its own section/card', customCardPos >= 0
  && /portal-schedule-create-custom-addon-card/.test(modal));
ok('Custom add-on label exact EN via i18n key',
  /data-i18n="schedule\.create\.section\.customAddon"/.test(modal)
  && /Custom add-on/.test(modal));
ok('custom card above Payment section', customCardPos >= 0 && paymentSectionPos > customCardPos);
ok('custom section above Payments title', customPos >= 0 && paymentPos > customPos);
ok('custom section above payment select', customPos >= 0 && paySelectPos > customPos);
// Not nested inside payment section
ok('custom lines not nested under payment section', (() => {
  if (customCardPos < 0 || paymentSectionPos < 0) return false;
  const payChunk = modal.slice(paymentSectionPos, paymentSectionPos + 1200);
  return !payChunk.includes('id="ps-create-custom-lines"');
})());
ok('collapsed + button present', /id="ps-create-custom-line-add-btn"/.test(modal)
  && /portal-schedule-create-custom-line-plus/.test(modal));
ok('accessible label Add custom line',
  /aria-label="Add custom line"/.test(modal)
  || /data-i18n-aria="schedule\.create\.customLine\.add"/.test(modal));
ok('editor has Label + Price + Add/Cancel',
  /id="ps-create-custom-line-label"/.test(modal)
  && /id="ps-create-custom-line-price"/.test(modal)
  && /id="ps-create-custom-line-confirm"/.test(modal)
  && /id="ps-create-custom-line-cancel"/.test(modal));
ok('editor starts collapsed (hidden)',
  /id="ps-create-custom-lines-editor"[^>]*hidden|id="ps-create-custom-lines-editor"[^>]*display:none/.test(modal));
ok('touch-friendly + min 44px CSS',
  /\.portal-schedule-create-custom-line-plus\{[^}]*min-width:\s*44px/.test(apiSrc)
  && /\.portal-schedule-create-custom-line-plus\{[^}]*min-height:\s*44px/.test(apiSrc));
ok('card thin outline CSS (no heavy background)',
  /\.portal-schedule-create-custom-addon-card\{[^}]*border:\s*1px solid/.test(apiSrc)
  && /\.portal-schedule-create-custom-addon-card\{[^}]*background:\s*transparent/.test(apiSrc));

const readPayloadFn = extractFn(apiSrc, 'scheduleReadCreatePayload');
ok('scheduleReadCreatePayload bounded extract', !!readPayloadFn);
ok('payload includes custom_line_items (bounded fn)',
  !!readPayloadFn && readPayloadFn.includes('custom_line_items'));

const fetchQuoteFn = extractFn(portalSrc, 'schedulePortalFetchQuote');
ok('schedulePortalFetchQuote bounded extract', !!fetchQuoteFn);
ok('quote body sends custom_line_items (bounded fn)',
  !!fetchQuoteFn && fetchQuoteFn.includes('custom_line_items'));

const renderFn = extractFn(apiSrc, 'scheduleRenderCreateCustomLines');
ok('escaping helper used for labels (bounded fn)',
  !!renderFn
  && renderFn.includes('scheduleEscapeHtmlLite')
  && /scheduleEscapeHtmlLite\(\s*line\.label\s*\)/.test(renderFn));

// ── 2) Parse cents (behavioral — server + browser VM) ───────────────────────
console.log('\n[2] Positive/zero/negative parsing + rejects');
const parse = writes.parseLocaleMoneyToCents;
ok('+12.50 → 1250', parse('12.50').ok && parse('12.50').amount_cents === 1250);
ok('locale comma 12,50 → 1250', parse('12,50').ok && parse('12,50').amount_cents === 1250);
ok('EU thousands 1.234,56 → 123456', parse('1.234,56').ok && parse('1.234,56').amount_cents === 123456);
ok('zero allowed', parse('0').ok && parse('0').amount_cents === 0);
ok('zero .00', parse('0.00').ok && parse('0.00').amount_cents === 0);
ok('negative discount -5 → -500', parse('-5').ok && parse('-5').amount_cents === -500);
ok('negative -3,50 → -350', parse('-3,50').ok && parse('-3,50').amount_cents === -350);
ok('-0 normalizes to 0', parse('-0').ok && parse('-0').amount_cents === 0
  && !Object.is(parse('-0').amount_cents, -0));
ok('integer number accepted', parse(2500).ok && parse(2500).amount_cents === 2500);
ok('negative integer number', parse(-100).ok && parse(-100).amount_cents === -100);
ok('>2 decimals rejected', !parse('1.234').ok && parse('1.234').error === 'amount_too_many_decimals');
ok('NaN rejected', !parse('abc').ok);
ok('empty rejected', !parse('').ok);
ok('float number rejected (strict integer cents for number type)', !parse(12.5).ok);
ok('overflow rejected', !parse(String(Number.MAX_SAFE_INTEGER) + '0').ok || !parse(Number.MAX_SAFE_INTEGER + 1).ok
  || !parse(String(Number.MAX_SAFE_INTEGER) + '.00').ok);

// Browser parser: VM evaluate bounded function only (no dead Node-bridge path).
const browserParseFn = extractFn(apiSrc, 'scheduleParseCreateMoneyToCents');
ok('browser parse fn bounded extract', !!browserParseFn);
ok('browser parse has no dead parseLocaleMoneyToCents bridge',
  !!browserParseFn && !browserParseFn.includes('parseLocaleMoneyToCents'));
let browserParse = null;
if (browserParseFn) {
  try {
    browserParse = vm.runInNewContext(browserParseFn + '; scheduleParseCreateMoneyToCents;', {
      Object, Number, String, Math, parseInt,
    });
  } catch (e) {
    browserParse = null;
  }
}
ok('browser VM parse loads', typeof browserParse === 'function');
if (typeof browserParse === 'function') {
  ok('browser 10 → 1000 (Coffee +€10)', browserParse('10').ok && browserParse('10').amount_cents === 1000);
  ok('browser 10.0 → 1000', browserParse('10.0').ok && browserParse('10.0').amount_cents === 1000);
  ok('browser 10.00 → 1000', browserParse('10.00').ok && browserParse('10.00').amount_cents === 1000);
  ok('browser -5 → -500', browserParse('-5').ok && browserParse('-5').amount_cents === -500);
  ok('browser 12,50 → 1250', browserParse('12,50').ok && browserParse('12,50').amount_cents === 1250);
  ok('browser >2 decimals reject', !browserParse('1.234').ok);
  ok('browser exponent reject', !browserParse('1e2').ok);
}

// Dead alias must not be re-exported.
ok('no dead parseStrictCustomLineAmountCents export',
  typeof writes.parseStrictCustomLineAmountCents !== 'function'
  && !/function\s+parseStrictCustomLineAmountCents\s*\(/.test(writesSrc));

// ── 3) normalizeCustomLineItems ─────────────────────────────────────────────
console.log('\n[3] normalizeCustomLineItems validation');
const n1 = writes.normalizeCustomLineItems([
  { client_line_id: 'a1', label: '  Promo  ', amount_cents: -500 },
  { client_line_id: 'b2', label: 'Extra', amount_cents: 0 },
  { client_line_id: 'c3', label: 'Late fee', amount_cents: 1500 },
]);
ok('multi lines ok', n1.ok && n1.value.length === 3);
ok('label trimmed', n1.ok && n1.value[0].label === 'Promo');
ok('required label', !writes.normalizeCustomLineItems([{ client_line_id: 'x', label: '  ', amount_cents: 1 }]).ok);
ok('label max 120', !writes.normalizeCustomLineItems([{
  client_line_id: 'x', label: 'x'.repeat(121), amount_cents: 1,
}]).ok);
ok('unique ids', !writes.normalizeCustomLineItems([
  { client_line_id: 'dup', label: 'A', amount_cents: 1 },
  { client_line_id: 'dup', label: 'B', amount_cents: 2 },
]).ok);
ok('bounded max', !writes.normalizeCustomLineItems(
  Array.from({ length: 21 }, (_, i) => ({ client_line_id: 'id' + i, label: 'L' + i, amount_cents: 1 })),
).ok);
ok('locale string amount on server', writes.normalizeCustomLineItems([
  { client_line_id: 's1', label: 'X', amount_cents: '10,50' },
]).ok && writes.normalizeCustomLineItems([
  { client_line_id: 's1', label: 'X', amount_cents: '10,50' },
]).value[0].amount_cents === 1050);

// ── 4) Quote: Admin + custom; reject negative total; no Admin mutate ────────
console.log('\n[4] Quote custom lines + aggregate + fingerprint');
const adminLines = [{
  component: 'course',
  offering_id: 'surf_pack_c1__1_day',
  total_cents: 5000,
  unit_amount_cents: 5000,
  quantity: 1,
  currency: 'EUR',
  price_source: 'admin_db',
}];
const staffCmd = {
  channel: quoteSvc.QUOTE_CHANNELS.MANUAL_STAFF,
  transportBody: {
    custom_line_items: [
      { client_line_id: 'cl1', label: 'Discount', amount_cents: -1000 },
      { client_line_id: 'cl2', label: 'Zero', amount_cents: 0 },
      { client_line_id: 'cl3', label: 'Extra', amount_cents: 500 },
    ],
  },
};
const qOk = quoteSvc.appendCustomLineItemsToQuote(staffCmd, adminLines.slice(), 5000, 'EUR');
ok('quote appends custom lines', qOk.ok && qOk.lines.length === 4);
ok('exact total Admin+custom', qOk.ok && qOk.totalCents === 4500);
ok('zero line remains in quote', qOk.ok && qOk.lines.some((l) => l.client_line_id === 'cl2' && l.total_cents === 0));
ok('negative discount line present', qOk.ok && qOk.lines.some((l) => l.total_cents === -1000));

const tooNeg = quoteSvc.appendCustomLineItemsToQuote({
  channel: quoteSvc.QUOTE_CHANNELS.MANUAL_STAFF,
  transportBody: {
    custom_line_items: [{ client_line_id: 'x', label: 'Huge disc', amount_cents: -6000 }],
  },
}, adminLines.slice(), 5000, 'EUR');
ok('aggregate below zero rejected', !tooNeg.ok && tooNeg.body && tooNeg.body.reason_code === 'booking_total_negative');

const lunaBlocked = quoteSvc.appendCustomLineItemsToQuote({
  channel: quoteSvc.QUOTE_CHANNELS.LUNA_WHATSAPP,
  transportBody: {
    custom_line_items: [{ client_line_id: 'x', label: 'Nope', amount_cents: 100 }],
  },
}, adminLines.slice(), 5000, 'EUR');
ok('Luna channel cannot inject custom lines', !lunaBlocked.ok && lunaBlocked.status === 403);

const moneyReject = quoteSvc.rejectClientSuppliedMoney({
  components: { course: { course_id: 'c1', tier_key: '1_day', quantity: 1, amount_cents: 1 } },
});
ok('client cannot mutate Admin component amount_cents', !moneyReject.ok && moneyReject.reason === 'client_money_rejected');
const customOkMoney = quoteSvc.rejectClientSuppliedMoney({
  custom_line_items: [{ client_line_id: 'a', label: 'X', amount_cents: 100 }],
  components: { course: { course_id: 'c1', tier_key: '1_day', quantity: 1 } },
});
ok('custom_line_items amount_cents not treated as Admin spoof', customOkMoney.ok);

const bodyA = {
  location_id: 'sunset-somo',
  offering_id: 'x',
  total_cents: 4500,
  unit_amount_cents: 5000,
  currency: 'EUR',
  price_source: 'admin_db',
  service_dates: ['2026-07-01'],
  quantity: 1,
  line_items: qOk.lines,
  quoted_at: new Date().toISOString(),
};
const fpA = quoteSvc.computeQuoteFingerprint(bodyA);
const bodyB = {
  ...bodyA,
  total_cents: 4000,
  line_items: qOk.lines.map((l) => (l.client_line_id === 'cl1' ? { ...l, total_cents: -1500, unit_amount_cents: -1500 } : l)),
};
const fpB = quoteSvc.computeQuoteFingerprint(bodyB);
ok('custom amount change invalidates fingerprint', fpA && fpB && fpA !== fpB);

// ── 5) Persistence claim + signed amounts + no Admin mutate ─────────────────
console.log('\n[5] Persistence claim + signed amounts + ownership + no Admin mutate');
ok('insertStaffCustomLineServiceRows exported', typeof writes.insertStaffCustomLineServiceRows === 'function');
ok('STAFF_CUSTOM_LINE_SOURCE constant', writes.STAFF_CUSTOM_LINE_SOURCE === 'staff_custom_line');

// Custom rows must remain quote-owned even when service_type is addon_service (full-day filter).
const pricingFn = extractFn(writesSrc, 'applyAuthoritativeSchedulePricingInTxn');
ok('applyAuthoritativeSchedulePricingInTxn bounded extract', !!pricingFn);
ok('full-day filter excludes staff_custom_line ownership (bounded)',
  !!pricingFn
  && pricingFn.includes('isFullDayServiceRow')
  && pricingFn.includes('STAFF_CUSTOM_LINE_COMPONENT')
  && pricingFn.includes('STAFF_CUSTOM_LINE_SOURCE')
  && /staff_custom_line\s*===\s*true/.test(pricingFn)
  && /return false/.test(pricingFn));

(async () => {
  const updates = [];
  const pg = {
    async query(sql, params) {
      updates.push({ sql: String(sql), params });
      return { rowCount: 1 };
    },
  };
  const quoteBody = {
    total_cents: 4500,
    line_items: [
      { component: 'course', total_cents: 5000 },
      { component: 'staff_custom_line', client_line_id: 'cl1', label: 'Disc', total_cents: -1000, price_source: 'staff_custom_line' },
      { component: 'staff_custom_line', client_line_id: 'cl2', label: 'Zero', total_cents: 0, price_source: 'staff_custom_line' },
      { component: 'staff_custom_line', client_line_id: 'cl3', label: 'Extra', total_cents: 500, price_source: 'staff_custom_line' },
    ],
  };
  const rows = [
    { service_record_id: 'r-course', service_type: 'course', metadata: { component: 'course' } },
    {
      service_record_id: 'r-cl1', service_type: 'addon_service',
      metadata: { component: 'staff_custom_line', client_line_id: 'cl1', source: 'staff_custom_line', staff_custom_line: true },
    },
    {
      service_record_id: 'r-cl2', service_type: 'addon_service',
      metadata: { component: 'staff_custom_line', client_line_id: 'cl2', source: 'staff_custom_line', staff_custom_line: true },
    },
    {
      service_record_id: 'r-cl3', service_type: 'addon_service',
      metadata: { component: 'staff_custom_line', client_line_id: 'cl3', source: 'staff_custom_line', staff_custom_line: true },
    },
  ];
  const applied = await writes.applyAuthoritativeQuoteAmounts(pg, rows, quoteBody, { clientSlug: 'sunset' });
  ok('apply exact total 4500 (quote-claim equality)', applied.ok && applied.total_cents === 4500);
  const courseUpd = updates.find((u) => u.params && u.params[1] === 'r-course');
  ok('Admin course cents set to 5000 (not client-mutated)', courseUpd && courseUpd.params[0] === 5000);
  ok('discount stores amount_due 0 (CHECK-safe) with signed metadata', (() => {
    const u = updates.find((x) => x.params && x.params.indexOf('r-cl1') >= 0);
    if (!u) return false;
    const due = u.params[0];
    const metaRaw = u.params.find((p) => typeof p === 'string' && p.includes('amount_cents'));
    if (due !== 0) return false;
    if (!metaRaw) return false;
    const meta = JSON.parse(metaRaw);
    return meta.amount_cents === -1000 && meta.source === 'staff_custom_line';
  })());
  ok('positive custom stores amount_due 500', (() => {
    const u = updates.find((x) => x.params && x.params.indexOf('r-cl3') >= 0);
    return u && u.params[0] === 500;
  })());

  // Booking metadata quote_line_items retain custom identity (bounded source check).
  ok('quote_line_items meta keeps client_line_id for custom (bounded)',
    !!pricingFn
    && pricingFn.includes('client_line_id')
    && pricingFn.includes('STAFF_CUSTOM_LINE_COMPONENT')
    && pricingFn.includes('price_source'));

  const fp1 = writes.buildScheduleBookingIntentFingerprint({
    guest_name: 'A', payment_status: 'unpaid', service_dates: ['2026-07-01'],
    components: { course: { course_id: 'c', tier_key: '1_day', quantity: 1 } },
    notes: '', custom_line_items: [{ client_line_id: 'a', label: 'X', amount_cents: 100 }],
  }, 'sunset-somo', {});
  const fp2 = writes.buildScheduleBookingIntentFingerprint({
    guest_name: 'A', payment_status: 'unpaid', service_dates: ['2026-07-01'],
    components: { course: { course_id: 'c', tier_key: '1_day', quantity: 1 } },
    notes: '', custom_line_items: [{ client_line_id: 'a', label: 'X', amount_cents: 200 }],
  }, 'sunset-somo', {});
  ok('idempotency intent changes with custom amount', fp1 && fp2 && fp1 !== fp2);

  const pricingIntent = writes.buildSchedulePricingIntent({
    service_dates: ['2026-07-01'],
    components: { course: { course_id: 'c', tier_key: '1_day', quantity: 1 } },
    custom_line_items: [{ client_line_id: 'a', label: 'X', amount_cents: -50 }],
  });
  ok('pricing intent carries custom lines (paid reprice safety)',
    pricingIntent.custom_line_items && pricingIntent.custom_line_items.length === 1
    && pricingIntent.custom_line_items[0].amount_cents === -50);

  // Drawer display uses signed metadata (bounded).
  const drawerSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-drawer.js'), 'utf8');
  const dueFn = extractFn(drawerSrc, 'readPersistedServiceDueCents');
  ok('drawer reads signed metadata amount_cents (bounded)',
    !!dueFn && dueFn.includes('staff_custom_line') && dueFn.includes('amount_cents'));

  // ── 6) i18n EN/ES/IT (key presence only — no broad locale blob match) ─────
  console.log('\n[6] EN/ES/IT labels');
  const keys = [
    'schedule.create.section.customAddon',
    'schedule.create.customLine.add',
    'schedule.create.customLine.label',
    'schedule.create.customLine.price',
    'schedule.create.customLine.confirm',
    'schedule.create.customLine.cancel',
  ];
  ok('EN Custom add-on exact copy',
    /'schedule\.create\.section\.customAddon':\s*'Custom add-on'/.test(
      fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8'),
    ));
  const i18nSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
  const esSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');
  // Locate EN and IT blocks by fixed markers (brace-bounded), not [\s\S]*.
  const enStart = i18nSrc.indexOf("en: {");
  const esBlockStart = i18nSrc.indexOf("\n  es:");
  const itStart = i18nSrc.indexOf("\n  it: {");
  const enBlock = enStart >= 0 && esBlockStart > enStart ? i18nSrc.slice(enStart, esBlockStart) : '';
  // IT block: from "it: {" to end of STAFF_PORTAL_STRINGS object — use next top-level sibling if any.
  let itBlock = '';
  if (itStart >= 0) {
    const from = itStart + 1; // skip leading newline
    const brace = i18nSrc.indexOf('{', from);
    let depth = 0;
    for (let i = brace; i < i18nSrc.length; i += 1) {
      if (i18nSrc[i] === '{') depth += 1;
      else if (i18nSrc[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          itBlock = i18nSrc.slice(from, i + 1);
          break;
        }
      }
    }
  }
  keys.forEach((k) => {
    const needle = "'" + k + "':";
    ok('EN ' + k, enBlock.includes(needle));
    ok('ES ' + k, esSrc.includes(needle));
    ok('IT ' + k, itBlock.includes(needle));
  });

  ok('no new migration file required',
    !fs.existsSync(path.join(ROOT, 'database/migrations/051_staff_custom_line.sql')));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
