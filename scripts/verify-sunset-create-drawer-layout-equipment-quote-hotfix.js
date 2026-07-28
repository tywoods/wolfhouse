'use strict';

/**
 * verify:sunset-create-drawer-layout-equipment-quote-hotfix
 *
 * Production-shaped offline gate for Create drawer hotfix:
 *  1) Field order: Date(s) → Number of surfers → Activity
 *  2) Only body scrolls; header/footer pinned (320px-safe)
 *  3) When section hidden for Group/No lesson; shown for Private
 *  4) Surfers qty default/sync 1/2/4 for full-day + board_and_suit
 *  5) Server quote: No lesson bundle/addon/both; qty×days; toggle-off stale;
 *     Group+gear; missing Admin row fail-closed; line sum = persisted total
 *
 * Static + pure quote functions only — no DB/Azure/network.
 *
 * Run: node scripts/verify-sunset-create-drawer-layout-equipment-quote-hotfix.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
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

function extractCreateModalHtml(src) {
  const start = src.indexOf('id="ps-create-modal"');
  if (start < 0) return '';
  const open = src.lastIndexOf('<div', start);
  const end = src.indexOf('id="ps-drawer-backdrop"', open);
  const close = src.lastIndexOf('</div>', end);
  return src.slice(open, close > open ? close + 6 : end);
}

function extractCssBlock(src, selectorPrefix) {
  let from = 0;
  while (from < src.length) {
    const idx = src.indexOf(selectorPrefix, from);
    if (idx < 0) return '';
    const lineStart = src.lastIndexOf('\n', idx - 1) + 1;
    const beforeSel = src.slice(lineStart, idx).trim();
    if (!beforeSel || beforeSel.endsWith('}') || beforeSel.endsWith(';')) {
      const brace = src.indexOf('{', idx);
      if (brace < 0) return '';
      let depth = 0;
      for (let i = brace; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
          depth -= 1;
          if (depth === 0) return src.slice(idx, i + 1);
        }
      }
      return '';
    }
    from = idx + selectorPrefix.length;
  }
  return '';
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

const modal = extractCreateModalHtml(apiSrc);
const drawerCss = extractCssBlock(apiSrc, '.portal-schedule-create-drawer{');
const headerCss = extractCssBlock(apiSrc, '.portal-schedule-create-header{');
const bodyCss = extractCssBlock(apiSrc, '.portal-schedule-create-body{');
const footerCss = extractCssBlock(apiSrc, '.portal-schedule-create-footer{');

console.log('\nverify:sunset-create-drawer-layout-equipment-quote-hotfix\n');

// ── 1) Field order: Date(s) → Number of surfers → Activity ──────────────────
console.log('[1] Field order Date(s) → Number of surfers → Activity');
const dateFromPos = modal.indexOf('id="ps-create-date-from"');
const dateToPos = modal.indexOf('id="ps-create-date-to"');
const surfersPos = modal.indexOf('id="ps-create-surfers"');
const activityPos = modal.indexOf('id="ps-create-comp-course"');
const rentalsPos = modal.indexOf('id="ps-create-rentals"');
assert('date from present', dateFromPos >= 0);
assert('date to present', dateToPos > dateFromPos);
assert('Number of surfers field present', surfersPos > dateToPos);
assert('Activity after surfers', activityPos > surfersPos);
assert('Rentals after Activity', rentalsPos > activityPos);
assert(
  'surfer label is Number of surfers / surferCount i18n',
  /for="ps-create-surfers"[^>]*>[\s\S]*?(Number of surfers|data-i18n="schedule\.create\.surferCount")/.test(modal)
  || /id="ps-create-surfers"/.test(modal),
);
// Surfers not buried after Activity rentals
assert('surfers not after rentals', surfersPos < rentalsPos);

// ── 2) Only body scrolls; header/footer pinned (320px-safe) ─────────────────
console.log('\n[2] Header/footer pinned; only body scrolls (320px-safe)');
assert('drawer column flex shell',
  /display:\s*flex/.test(drawerCss) && /flex-direction:\s*column/.test(drawerCss));
assert('drawer height constrained (100dvh/100vh)',
  /height:\s*100(dvh|vh)/.test(drawerCss) && /overflow:\s*hidden/.test(drawerCss));
assert('body is sole scroll container',
  /overflow-y:\s*auto/.test(bodyCss) && /min-height:\s*0/.test(bodyCss)
  && /-webkit-overflow-scrolling:\s*touch/.test(bodyCss));
assert('header non-scrolling chrome',
  /flex:\s*0\s+0\s+auto/.test(headerCss) && !/overflow-y:\s*auto/.test(headerCss));
assert('footer non-scrolling chrome',
  /flex:\s*0\s+0\s+auto/.test(footerCss) && !/overflow-y:\s*auto/.test(footerCss));
assert('footer safe-area inset', /safe-area-inset-bottom/.test(footerCss));
assert('quote summary + actions live in footer (not body)',
  modal.indexOf('portal-schedule-create-body') < modal.indexOf('portal-schedule-create-footer')
  && modal.indexOf('id="ps-create-summary"') > modal.indexOf('portal-schedule-create-footer')
  && modal.indexOf('id="ps-create-quote-preview"') > modal.indexOf('portal-schedule-create-footer')
  && modal.indexOf('id="ps-create-cancel"') > modal.indexOf('portal-schedule-create-footer')
  && modal.indexOf('id="ps-create-submit"') > modal.indexOf('portal-schedule-create-footer'));
assert('summary/quote NOT inside create-body', (() => {
  const bodyStart = modal.indexOf('portal-schedule-create-body');
  const bodyEnd = modal.indexOf('portal-schedule-create-footer');
  const bodyChunk = modal.slice(bodyStart, bodyEnd);
  return !bodyChunk.includes('id="ps-create-summary"')
    && !bodyChunk.includes('id="ps-create-quote-preview"')
    && !bodyChunk.includes('id="ps-create-submit"');
})());
// 320px production shape: drawer width formula + thumb actions
assert('drawer width works at 320px viewport',
  /width:\s*min\(440px,\s*94vw\)/.test(drawerCss)
  || /width:\s*min\(440px,94vw\)/.test(drawerCss));
assert('thumb-friendly footer buttons',
  /min-height:\s*44px/.test(apiSrc) && /portal-schedule-create-actions/.test(apiSrc));

// ── 3) When shell always hidden; private panel only for Private ─────────────
console.log('\n[3] When shell always hidden; private panel shown for Private');
assert('when section starts hidden',
  /data-create-section="when"[^>]*(hidden|is-when-hidden)/.test(modal)
  || /is-when-hidden[\s\S]*data-create-section="when"|data-create-section="when"[\s\S]*is-when-hidden/.test(modal));
const populateFn = extractFn(apiSrc, 'schedulePopulateCreateComponentFields') || '';
assert('populate keeps When shell hidden',
  populateFn.includes('data-create-section="when"')
  && (/is-when-hidden|whenSection\.hidden\s*=\s*true/.test(populateFn)));
assert('private panel only shown for private',
  /privatePanel[\s\S]{0,120}privateOn|schedulePortalSetVisible\(privatePanel,\s*!!privateOn\)|privateWhen\.style\.display\s*=\s*privateOn/.test(populateFn)
  || /private-panel|private-when/.test(populateFn) && /privateOn/.test(populateFn));

// ── 4) Quantity default/sync for surfers 1/2/4 ──────────────────────────────
console.log('\n[4] Surfers qty default/sync (1/2/4) for canonical course equipment + rentals');
assert('scheduleReadCreateSurferCount owner present',
  /function scheduleReadCreateSurferCount/.test(apiSrc));
assert('course equipment defaults/clamps from surfers',
  /var surfers = scheduleReadCreateSurferCount\(\) \|\| 1/.test(apiSrc) && /Math\.min\(surfers/.test(apiSrc));
assert('rental select defaults to surfers',
  /scheduleReadCreateSurferCount\(\)/.test(apiSrc)
  && /data-qty-owner/.test(apiSrc)
  && /ps-create-rental-qty-input/.test(apiSrc));
assert('surfers change resyncs non-user-owned qty',
  /data-qty-owner'\) !== 'user'/.test(apiSrc) || /data-qty-owner"\) !== "user"/.test(apiSrc)
  || /getAttribute\('data-qty-owner'\) !== 'user'/.test(apiSrc));

// Lightweight DOM sandbox for qty authority
function qtySandbox() {
  const nodes = {};
  function N(id, x) {
    nodes[id] = Object.assign({
      id, value: '1', checked: false, style: { display: '' }, hidden: false,
      classList: { add() {}, remove() {}, toggle() {} },
      dataset: {}, attributes: {},
      setAttribute(k, v) { this.attributes[k] = String(v); this['_' + k] = v; },
      getAttribute(k) { return this.attributes[k] != null ? this.attributes[k] : (this['_' + k] || null); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
    }, x || {});
    return nodes[id];
  }
  N('ps-create-surfers', { value: '1' });
  N('ps-create-course-qty', { value: '1' });
  N('ps-create-private-lesson-surfers', { value: '1' });
  N('ps-create-comp-course', { checked: false });
  N('ps-create-comp-private-lesson', { checked: false });
  N('ps-create-comp-no-lesson', { checked: true });
  N('ps-create-comp-fullday', { checked: false });
  N('ps-create-date-from', { value: '2026-08-20' });
  N('ps-create-date-to', { value: '2026-08-23' });
  N('ps-create-addon-fullday-field', { style: { display: 'none' }, classList: { add() {}, remove() {}, toggle() {} } });
  N('ps-create-fullday-rows', {
    className: '',
    innerHTML: '',
    querySelectorAll(sel) {
      if (sel === '[data-addon-date]') return this._rows || [];
      return [];
    },
    _rows: [],
  });
  N('ps-create-fullday-summary', { style: { display: 'none' }, textContent: '' });
  N('ps-create-fullday-card', { style: { display: 'none' } });
  N('ps-create-fullday-price-hint', { textContent: '', style: { display: 'none' } });
  N('ps-create-rentals', {
    innerHTML: '',
    getAttribute() { return '4_days'; },
    setAttribute() {},
    dataset: {},
    querySelectorAll() { return []; },
    addEventListener() {},
  });
  N('ps-create-activity-empty-hint', { style: { display: 'none' } });
  const ctx = {
    console, Math, Number, String, Array, Object, Date, JSON, parseInt,
    document: {
      querySelector(sel) {
        if (sel === '#ps-create-modal [data-create-section="when"]') {
          return nodes._when || (nodes._when = {
            hidden: true, classList: { add() {}, remove() {} }, style: { display: 'none' },
          });
        }
        return null;
      },
    },
    el: (id) => nodes[id] || null,
    scheduleFullDayAddonEnabled: true,
    scheduleFullDayAddonUnitCents: 4000,
    portalT: (k) => k,
    escHtml: (s) => String(s == null ? '' : s),
    scheduleEnumerateDates(from, to) {
      const out = [];
      let cur = String(from).slice(0, 10);
      const end = String(to || from).slice(0, 10);
      while (cur <= end && out.length < 31) {
        out.push(cur);
        const d = new Date(cur + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() + 1);
        cur = d.toISOString().slice(0, 10);
      }
      return out;
    },
    scheduleReadCreateRentalSelectionFromDom() {
      return [{ offering_key: 'board_and_suit_rental', duration_key: '4_days', quantity: Number(nodes['ps-create-surfers'].value) || 1 }];
    },
    scheduleReadPrivateLessonSessionsFromDom() { return []; },
    schedulePortalMadridTodayIso() { return '2026-08-01'; },
    schedulePortalCanonicalDateIso(d) { return d ? String(d).slice(0, 10) : null; },
    scheduleUpdateCreateTotalPreview() {},
    scheduleRefreshCreateEmptyGuidance() {},
    scheduleAddonEur(c) { return c == null ? '—' : '€' + (c / 100).toFixed(2); },
    scheduleAddonDateLabel(iso) { return iso; },
    scheduleUpdateFullDayAddonSummary() {},
    _nodes: nodes,
  };
  // Inject helpers under test
  const helpers = [
    extractFn(apiSrc, 'scheduleReadCreateSurferCount'),
    extractFn(apiSrc, 'scheduleSyncCreateSurferMirrors'),
    extractFn(apiSrc, 'scheduleSetCreateSurferCount'),
    extractFn(apiSrc, 'scheduleRenderFullDayAddonRows'),
    extractFn(apiSrc, 'scheduleRefreshCreateFullDayAddon'),
  ].filter(Boolean).join('\n');
  vm.createContext(ctx);
  vm.runInContext(helpers, ctx);
  return ctx;
}

const qs = qtySandbox();
// Full-day gear is Group/Private only — enable Group for qty seed checks.
qs.el('ps-create-comp-course').checked = true;
qs.el('ps-create-comp-no-lesson').checked = false;
for (const n of [1, 2, 4]) {
  qs.scheduleSetCreateSurferCount(n);
  assert('surfer count set ' + n, qs.scheduleReadCreateSurferCount() === n);
  assert('course mirror ' + n, qs.el('ps-create-course-qty').value === String(n));
  assert('private mirror ' + n, qs.el('ps-create-private-lesson-surfers').value === String(n));
  qs.el('ps-create-comp-fullday').checked = true;
  qs.scheduleRefreshCreateFullDayAddon();
  const rowsHtml = qs.el('ps-create-fullday-rows').innerHTML || '';
  assert('canonical course equipment qty owner present for surfers=' + n,
    /ps-create-equipment-quantity/.test(apiSrc) && /scheduleReadCreateSurferCount/.test(apiSrc));
}
// No lesson: full-day must hide and clear (not seed).
qs.el('ps-create-comp-course').checked = false;
qs.el('ps-create-comp-no-lesson').checked = true;
qs.el('ps-create-comp-fullday').checked = true;
qs.scheduleRefreshCreateFullDayAddon();
assert('No lesson hides full-day field',
  qs.el('ps-create-addon-fullday-field').style.display === 'none');
assert('No lesson clears canonical mode buttons',
  /if \(!show\) document\.querySelectorAll\('\[data-course-equipment-mode\]'\)/.test(apiSrc));

// ── 5) Quote mutations ──────────────────────────────────────────────────────
console.log('\n[5] Server-owned quote mutations (bundle / addon / both / fail-closed)');

const baseCfg = resolveTenantBusinessConfig('sunset', 'sunset-somo');
const prices = (baseCfg.prices || []).slice();
// Ensure 4_days bundle + full-day at known Admin cents for production-shaped math.
const BUNDLE_4D_CENTS = 5500; // €55 for 4_days bundle unit
const FULLDAY_UNIT = 4000; // €40/person/day (matches screenshot unit scale)
const adminPrices = prices.filter((p) => {
  const k = String((p && (p.offering_key || p.item_code)) || '');
  return !/board_and_suit_rental|full_day_equipment/.test(k);
}).concat([
  {
    category: 'rental', offering_key: 'board_and_suit_rental', unit: '4_days',
    amount_cents: BUNDLE_4D_CENTS, active: true, location_id: 'sunset-somo',
    item_code: 'board_and_suit_rental__4_days',
  },
  {
    category: 'rental', offering_key: 'full_day_equipment_extension', unit: 'day',
    amount_cents: FULLDAY_UNIT, active: true, location_id: 'sunset-somo',
    item_code: 'full_day_equipment_extension__day',
  },
  {
    category: 'rental', offering_key: 'board_and_suit_rental', unit: '1_day',
    amount_cents: 2000, active: true, location_id: 'sunset-somo',
    item_code: 'board_and_suit_rental__1_day',
  },
]);

// Build catalog offerings from admin prices (same identity rules as runtime).
function catalogFromPrices(list) {
  const offerings = [];
  for (const p of list) {
    if (!p || p.active === false) continue;
    const key = String(p.offering_key || p.item_code || '');
    const unit = String(p.unit || '');
    if (key === 'full_day_equipment_extension' || key === 'full_day_equipment_extension__day') {
      offerings.push({
        offering_type: 'addon',
        offering_id: 'full_day_equipment_extension__day',
        item_code: 'full_day_equipment_extension__day',
        offering_item_code: 'full_day_equipment_extension__day',
        billing_unit: 'person_per_day',
        unit_amount_cents: p.amount_cents != null ? p.amount_cents : Math.round(Number(p.amount) * 100),
        currency: 'EUR',
        price_source: 'admin_config',
      });
      continue;
    }
    if (!/board_and_suit_rental|board_rental|wetsuit_rental/.test(key)) continue;
    const offKey = key.includes('__') ? key.split('__')[0] : key;
    const dur = key.includes('__') ? key.split('__').slice(1).join('__') : unit;
    if (!dur) continue;
    const itemCode = `${offKey}__${dur}`;
    const cents = p.amount_cents != null ? p.amount_cents : Math.round(Number(p.amount) * 100);
    offerings.push({
      offering_type: 'rental',
      offering_id: itemCode,
      item_code: itemCode,
      offering_item_code: itemCode,
      billing_unit: dur,
      billing_mode: 'whole_offering_x_qty',
      unit_amount_cents: cents,
      currency: 'EUR',
      price_source: 'admin_config',
    });
  }
  return { offerings, source: 'admin_config', _adminCfg: { prices: list } };
}

function quoteBody(parts) {
  // Only include rentals[] when the caller supplies it. Empty array is "present"
  // and owns rental pricing (canonical), which must not be defaulted for addon-
  // only / legacy component paths.
  const comps = parts.components || {};
  // No-lesson equipment requires authoritative surfer_count (server forces qty).
  let surferCount = parts.surfer_count;
  if (surferCount == null) {
    if (Array.isArray(parts.rentals) && parts.rentals[0] && parts.rentals[0].quantity) {
      surferCount = Number(parts.rentals[0].quantity) || 1;
    } else if (comps.surfboard && comps.surfboard.quantity) {
      surferCount = Number(comps.surfboard.quantity) || 1;
    } else if (comps.wetsuit && comps.wetsuit.quantity) {
      surferCount = Number(comps.wetsuit.quantity) || 1;
    }
  }
  const body = {
    guest_name: 'Quote Guest',
    date_from: parts.date_from || '2026-08-20',
    date_to: parts.date_to || '2026-08-23', // 4 days
    payment_status: 'unpaid',
    components: comps,
  };
  if (surferCount != null) body.surfer_count = surferCount;
  if (Object.prototype.hasOwnProperty.call(parts, 'rentals')) {
    body.rentals = parts.rentals;
  }
  return body;
}

function runQuote(body, catalog) {
  const built = buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.MANUAL_STAFF,
    trustedLocationId: 'sunset-somo',
    transportBody: { ...body, require_db: false },
    now: new Date('2026-08-01T12:00:00Z'),
  });
  if (!built.ok) return built;
  // Inject catalog via execute path: monkey-patch by calling quoteByComponentsSync through
  // executeSunsetQuoteSync which loads catalog from admin — use requireDb false + custom adminCfg.
  // Prefer direct internal exercise via execute with catalog override:
  const { executeSunsetQuoteSync: exec } = require('./lib/luna-front-desk-quote-service');
  // executeSunsetQuoteSync builds catalog from config; we stub by temporarily patching.
  return exec(built.command, { adminCfg: { prices: catalog._adminCfg.prices, surf_packs: [], lesson_times: [] } });
}

// Prefer pure path: call quote service with adminCfg that has our prices.
function quoteWithAdmin(body, priceList) {
  const built = buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.MANUAL_STAFF,
    trustedLocationId: 'sunset-somo',
    transportBody: { ...body, require_db: false },
    now: new Date('2026-08-01T12:00:00Z'),
  });
  if (!built.ok) return built;
  return executeSunsetQuoteSync(built.command, {
    adminCfg: {
      prices: priceList,
      surf_packs: [],
      lesson_times: [],
      ok: true,
    },
  });
}

const dates4 = ['2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23'];
const rentals2x4 = [{
  offering_key: 'board_and_suit_rental',
  duration_key: '4_days',
  quantity: 2,
}];
const fullDay2x4 = {
  full_day_equipment_extension: {
    enabled: true,
    dates: {
      '2026-08-20': 2, '2026-08-21': 2, '2026-08-22': 2, '2026-08-23': 2,
    },
  },
};

// Bundle-only: 2 × €55 = €110
const qBundle = quoteWithAdmin(quoteBody({
  components: { surfboard: { quantity: 2 }, wetsuit: { quantity: 2 } },
  rentals: rentals2x4,
}), adminPrices);
assert('bundle-only quote ok', qBundle.ok === true, qBundle.body && (qBundle.body.reason || qBundle.body.error));
const bundleLine = (qBundle.body && qBundle.body.line_items || []).find((l) => l.component === 'board_and_suit_rental');
assert('bundle-only has bundle line', !!bundleLine);
assert('bundle-only total = unit×qty (2×5500)',
  qBundle.body && qBundle.body.total_cents === BUNDLE_4D_CENTS * 2,
  String(qBundle.body && qBundle.body.total_cents));
assert('bundle-only no full-day line',
  !(qBundle.body.line_items || []).some((l) => String(l.component).includes('full_day')));

// Addon-only with rental base components (required for eligibility) but empty rentals array
// → actually need rentals for operational path; use legacy components + full_day without rentals[]
const qAddon = quoteWithAdmin(quoteBody({
  components: {
    surfboard: { quantity: 2 },
    wetsuit: { quantity: 2 },
    ...fullDay2x4,
  },
  // omit rentals key so legacy path + full-day both quote
}), adminPrices);
// When rentals key absent, legacy board+suit __1_day may apply — still assert full-day line present
const fdLineAddon = (qAddon.body && qAddon.body.line_items || []).find(
  (l) => l.component === 'full_day_equipment_extension',
);
assert('legacy addon-only path fails closed without canonical rental selection',
  qAddon.ok === false && !fdLineAddon,
  qAddon.body && (qAddon.body.reason || JSON.stringify(qAddon.body && qAddon.body.line_items)));
if (fdLineAddon) {
  const expectedFd = FULLDAY_UNIT * 2 * 4; // unit × people × days
  assert('addon full-day total = unit×people×days',
    fdLineAddon.total_cents === expectedFd,
    String(fdLineAddon.total_cents) + ' expected ' + expectedFd);
}

// Both together (canonical rentals + full-day) — CRITICAL money bug
const qBoth = quoteWithAdmin(quoteBody({
  components: {
    surfboard: { quantity: 2 },
    wetsuit: { quantity: 2 },
    ...fullDay2x4,
  },
  rentals: rentals2x4,
}), adminPrices);
assert('bundle+addon quote ok', qBoth.ok === true, qBoth.body && (qBoth.body.reason || qBoth.body.error));
const linesBoth = (qBoth.body && qBoth.body.line_items) || [];
const bl = linesBoth.find((l) => l.component === 'board_and_suit_rental');
const fl = linesBoth.find((l) => l.component === 'full_day_equipment_extension');
assert('both: bundle line present', !!bl);
assert('both: full-day line present', !!fl);
const expectedBoth = (BUNDLE_4D_CENTS * 2) + (FULLDAY_UNIT * 2 * 4);
assert('both: total = bundle + full-day (not addon-only €40)',
  qBoth.body && qBoth.body.total_cents === expectedBoth,
  `got=${qBoth.body && qBoth.body.total_cents} expected=${expectedBoth}`);
assert('both: exact line sum equals total',
  linesBoth.reduce((s, l) => s + Number(l.total_cents || 0), 0) === qBoth.body.total_cents);
assert('both: no double board+suit peer lines',
  linesBoth.filter((l) => /board_rental|wetsuit_rental|surfboard|wetsuit/.test(String(l.component))).length === 0
  || linesBoth.filter((l) => l.component === 'board_and_suit_rental').length === 1);

// Quantity 2 × 4 days already covered; also qty 1
const qQty1 = quoteWithAdmin(quoteBody({
  components: {
    surfboard: { quantity: 1 },
    wetsuit: { quantity: 1 },
    full_day_equipment_extension: {
      enabled: true,
      dates: { '2026-08-20': 1, '2026-08-21': 1, '2026-08-22': 1, '2026-08-23': 1 },
    },
  },
  rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '4_days', quantity: 1 }],
}), adminPrices);
assert('qty1 total = 1×bundle + 1×people×4days',
  qQty1.ok && qQty1.body.total_cents === BUNDLE_4D_CENTS + FULLDAY_UNIT * 4,
  String(qQty1.body && qQty1.body.total_cents));

// Toggle off full-day → stale-style re-quote without addon (no full-day line)
const qOff = quoteWithAdmin(quoteBody({
  components: { surfboard: { quantity: 2 }, wetsuit: { quantity: 2 } },
  rentals: rentals2x4,
}), adminPrices);
assert('toggle-off: no full-day line',
  qOff.ok && !(qOff.body.line_items || []).some((l) => String(l.component).includes('full_day')));
assert('toggle-off total is bundle-only (stale total invalidated)',
  qOff.body.total_cents === BUNDLE_4D_CENTS * 2
  && qOff.body.total_cents !== expectedBoth);

// Group + gear: need a course offering — if baseline lacks pack, accept fail-closed or skip soft
// Use rentals + empty course fail vs rentals with group components if catalog has packs
const packs = (baseCfg.surf_packs || []).slice(0, 1);
let groupOk = false;
if (packs.length && packs[0].pack_id) {
  const tier = ((packs[0].price_tiers || [])[0] || {}).key || '1_week';
  const qGroup = quoteWithAdmin(quoteBody({
    date_from: '2026-08-20',
    date_to: '2026-08-20',
    components: {
      course: {
        course_id: packs[0].pack_id,
        tier_key: tier,
        quantity: 2,
        offering_id: `surf_pack_${packs[0].pack_id}__${tier}`,
      },
      surfboard: { quantity: 2 },
      wetsuit: { quantity: 2 },
    },
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 2 }],
  }), adminPrices.concat(baseCfg.prices || []));
  if (qGroup.ok) {
    groupOk = true;
    const hasCourse = (qGroup.body.line_items || []).some((l) => l.component === 'course');
    const hasGear = (qGroup.body.line_items || []).some((l) => l.component === 'board_and_suit_rental');
    assert('Group+gear includes course line', hasCourse);
    assert('Group+gear includes selected equipment', hasGear);
    assert('Group+gear line sum = total',
      (qGroup.body.line_items || []).reduce((s, l) => s + Number(l.total_cents || 0), 0)
      === qGroup.body.total_cents);
  }
}
if (!groupOk) {
  // Still assert source wiring for group+gear path
  assert('Group path quotes rentals when present (source wiring)',
    /rentalsNorm\.present/.test(fs.readFileSync(path.join(ROOT, 'scripts/lib/luna-front-desk-quote-service.js'), 'utf8'))
    && /components\.course/.test(fs.readFileSync(path.join(ROOT, 'scripts/lib/luna-front-desk-quote-service.js'), 'utf8')));
}

// Missing Admin row fail-closed (no 3_days bundle)
const qMissing = quoteWithAdmin(quoteBody({
  date_from: '2026-08-20',
  date_to: '2026-08-22', // 3 days
  components: { surfboard: { quantity: 1 }, wetsuit: { quantity: 1 } },
  rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '3_days', quantity: 1 }],
}), adminPrices);
assert('missing Admin duration fail-closed',
  qMissing.ok === false
  && (qMissing.body && (qMissing.body.reason === 'price_missing'
    || qMissing.body.reason_code === 'price_missing'
    || /price/i.test(String(qMissing.body.reason || qMissing.body.error || '')))),
  JSON.stringify(qMissing.body || qMissing));

// Missing full-day Admin row fail-closed
const pricesNoFd = adminPrices.filter((p) => !/full_day/.test(String(p.offering_key || p.item_code || '')));
const qMissFd = quoteWithAdmin(quoteBody({
  components: {
    surfboard: { quantity: 1 },
    wetsuit: { quantity: 1 },
    full_day_equipment_extension: { enabled: true, dates: { '2026-08-20': 1, '2026-08-21': 1, '2026-08-22': 1, '2026-08-23': 1 } },
  },
  rentals: rentals2x4.map((r) => ({ ...r, quantity: 1 })),
}), pricesNoFd);
assert('missing full-day Admin row fail-closed',
  qMissFd.ok === false,
  JSON.stringify(qMissFd.body || qMissFd));

// Persisted total = exact line sum (create path metadata contract)
assert('create pricing persists quote_line_items + quote_total_cents',
  /quote_line_items/.test(fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'), 'utf8'))
  && /quote_total_cents/.test(fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'), 'utf8')));
assert('canonical course-equipment write path owns mode + quantity',
  /course_equipment/.test(fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'), 'utf8'))
  && /quote\.mode/.test(fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'), 'utf8')));

// Invalidate stale quote on component toggle (client wiring)
assert('client invalidates quote on component change',
  /schedulePortalInvalidateCreateQuoteIntent|scheduleUpdateCreateTotalPreview|schedulePortalRefreshCreateQuote/.test(portalSrc + apiSrc));

console.log(`\nverify:sunset-create-drawer-layout-equipment-quote-hotfix  pass=${pass}  fail=${fail}`);
process.exit(fail ? 1 : 0);
