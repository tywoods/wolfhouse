'use strict';

/**
 * verify:sunset-rental-quantity-total-hotfix
 *
 * Strict RED-first gate for authenticated staging screenshot regression:
 *   No lesson · Board and wetsuit ×2 · 5 days Jul 27–31 → must quote €200
 *   (Admin board_and_suit_rental__5_days 10000 × qty 2 = 20000), never stale €40
 *   (1_day 2000 × 2).
 *
 * Exercises the REAL production path (not handcrafted rentals arrays):
 *   1) GET generated /staff/ui artifact
 *   2) Real Create DOM builders + scheduleReadCreatePayload
 *   3) Real schedulePortalFetchQuote with fetch intercepted → capture exact JSON body
 *   4) Feed THAT body through production buildSunsetQuoteCommand + quote service
 *      with live-shaped Admin fixture (5_days=10000)
 *
 * Mutations that force 1_day or drop rentals must RED.
 * Stale €40 cannot display beside a 5-day pricing intent.
 *
 * No Azure / staging mutation. Local open-auth staff API only.
 *
 * Run: node scripts/verify-sunset-rental-quantity-total-hotfix.js
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const net = require('net');

const ROOT = path.join(__dirname, '..');
process.env.SUNSET_ADMIN_DB_READ_ENABLED = '1';

const rentalMod = require('./browser/sunset-schedule-rental-availability');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuoteSync,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');

const LOC = 'sunset-somo';
const BUNDLE_CENTS = {
  '1_day': 2000,
  '2_days': 4000,
  '3_days': 6000,
  '4_days': 8000,
  '5_days': 10000,
  '6_days': 11500,
  '7_days': 13000,
};

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

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('GET timeout'));
    });
  });
}

async function fetchRenderedStaffUi() {
  const port = await freePort();
  const env = Object.assign({}, process.env, {
    STAFF_AUTH_REQUIRED: 'false',
    STAFF_AUTH_ALLOW_OPEN: 'true',
    STAFF_AUTH_HTTPS: 'false',
    STAFF_QUERY_API_PORT: String(port),
    STAFF_QUERY_API_BIND_HOST: '127.0.0.1',
    STAFF_RUNTIME_PROFILE: 'test',
    NODE_ENV: 'test',
    META_WEBHOOK_SKIP_VERIFY: 'true',
    BOOKING_MOVE_WRITE_ENABLED: 'true',
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/staff-query-api.js')], {
    env,
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', () => { /* drain */ });

  let lastErr = null;
  try {
    for (let i = 0; i < 40; i += 1) {
      if (child.exitCode != null) {
        throw new Error('staff-query-api exited early: ' + stderr.slice(0, 500));
      }
      try {
        const res = await httpGet('http://127.0.0.1:' + port + '/staff/ui');
        if (res.status === 200 && res.body.includes('<!DOCTYPE html>')) {
          return { html: res.body, headers: res.headers, port };
        }
        lastErr = new Error('HTTP ' + res.status);
      } catch (e) {
        lastErr = e;
      }
      await sleep(150);
    }
    throw lastErr || new Error('timeout waiting for /staff/ui');
  } finally {
    try { child.kill('SIGTERM'); } catch (_k) { /* ignore */ }
    await sleep(100);
    try { child.kill('SIGKILL'); } catch (_k2) { /* ignore */ }
  }
}

function miniDom() {
  function El(attrs) {
    this.attrs = Object.assign({}, attrs || {});
    this.children = [];
    this.value = '';
    this._checked = false;
    this.disabled = false;
    this.style = {};
    this.dataset = {};
    this._html = '';
    this.textContent = '';
    this.className = (attrs && attrs.class) || '';
    this._listeners = {};
    this.tagName = 'DIV';
    const self = this;
    this.classList = {
      add(c) {
        const parts = String(self.className || '').split(/\s+/).filter(Boolean);
        if (parts.indexOf(c) < 0) parts.push(c);
        self.className = parts.join(' ');
        self.attrs.class = self.className;
      },
      remove(c) {
        const parts = String(self.className || '').split(/\s+/).filter(Boolean)
          .filter((x) => x !== c);
        self.className = parts.join(' ');
        self.attrs.class = self.className;
      },
      contains(c) {
        return String(self.className || '').split(/\s+/).indexOf(c) >= 0;
      },
      toggle(c, force) {
        if (force === true) this.add(c);
        else if (force === false) this.remove(c);
        else if (this.contains(c)) this.remove(c);
        else this.add(c);
      },
    };
  }
  Object.defineProperty(El.prototype, 'checked', {
    get() { return this._checked; },
    set(v) { this._checked = !!v; },
    configurable: true,
  });
  El.prototype.getAttribute = function (k) {
    if (k === 'class') return this.className;
    if (Object.prototype.hasOwnProperty.call(this.attrs, k)) return this.attrs[k];
    return null;
  };
  El.prototype.setAttribute = function (k, v) {
    this.attrs[k] = String(v);
    if (k === 'class') this.className = String(v);
  };
  El.prototype.removeAttribute = function (k) { delete this.attrs[k]; };
  El.prototype.addEventListener = function (type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  };
  El.prototype.appendChild = function (c) {
    this.children.push(c);
    c.parentNode = this;
    return c;
  };
  El.prototype.closest = function () { return null; };
  El.prototype.querySelector = function (sel) {
    const all = this.querySelectorAll(sel);
    return all.length ? all[0] : null;
  };
  El.prototype.querySelectorAll = function (sel) {
    const out = [];
    const match = (ch) => {
      if (sel === 'input.ps-create-rental-qty-input' || sel === '.ps-create-rental-qty-input') {
        return (ch.className || '').split(/\s+/).indexOf('ps-create-rental-qty-input') >= 0;
      }
      if (sel === '.ps-create-rental-check') {
        return (ch.className || '').split(/\s+/).indexOf('ps-create-rental-check') >= 0;
      }
      if (sel === '[data-rental-offering]') {
        return ch.getAttribute('data-rental-offering') != null;
      }
      if (sel === '[data-rental-duration-pebbles]') {
        return ch.getAttribute('data-rental-duration-pebbles') != null;
      }
      if (sel === '.portal-schedule-create-rental-qty') {
        return (ch.className || '').split(/\s+/).indexOf('portal-schedule-create-rental-qty') >= 0;
      }
      if (sel === '.portal-schedule-create-check') {
        return (ch.className || '').split(/\s+/).indexOf('portal-schedule-create-check') >= 0;
      }
      if (sel.charAt(0) === '[') {
        const inner = sel.slice(1, -1);
        const eq = inner.indexOf('=');
        if (eq < 0) return ch.getAttribute(inner) != null;
        const k = inner.slice(0, eq);
        let v = inner.slice(eq + 1).replace(/^["']|["']$/g, '');
        return ch.getAttribute(k) === v;
      }
      if (sel.charAt(0) === '.') {
        return (ch.className || '').split(/\s+/).indexOf(sel.slice(1)) >= 0;
      }
      return false;
    };
    const rec = (n) => {
      (n.children || []).forEach((ch) => {
        if (match(ch)) out.push(ch);
        rec(ch);
      });
    };
    rec(this);
    out.forEach = Array.prototype.forEach;
    out.find = Array.prototype.find;
    return out;
  };

  function parseRentalsHtml(html, parent) {
    parent.children = [];
    const re = /data-rental-offering="([^"]+)"/g;
    let m;
    const keys = [];
    while ((m = re.exec(html))) keys.push(m[1]);
    keys.forEach((key) => {
      const row = new El({ 'data-rental-offering': key });
      row.setAttribute('data-rental-offering', key);
      row.className = 'portal-schedule-create-rental-row';
      const check = new El({ class: 'ps-create-rental-check', 'data-offering-key': key });
      check.className = 'ps-create-rental-check';
      check.setAttribute('data-offering-key', key);
      const chunk = html.split('data-rental-offering="' + key + '"')[1] || '';
      check.checked = /checked/.test((chunk.split('data-rental-offering=')[0] || '').slice(0, 300));
      const label = new El({ class: 'portal-schedule-create-check' });
      label.className = 'portal-schedule-create-check';
      label.appendChild(check);
      row.appendChild(label);
      const qtyWrap = new El({ class: 'portal-schedule-create-rental-qty' });
      qtyWrap.className = 'portal-schedule-create-rental-qty';
      const qty = new El({ class: 'ps-create-rental-qty-input', 'data-qty-owner': 'surfers' });
      qty.className = 'ps-create-rental-qty-input';
      qty.setAttribute('data-qty-owner', 'surfers');
      const qm = chunk.match(/value="(\d+)"/);
      qty.value = qm ? qm[1] : '1';
      qtyWrap.appendChild(qty);
      row.appendChild(qtyWrap);
      parent.appendChild(row);
    });
    if (/data-rental-duration-pebbles/.test(html)) {
      const host = new El({ 'data-rental-duration-pebbles': '' });
      host.setAttribute('data-rental-duration-pebbles', '');
      host.className = 'portal-schedule-create-rental-pebbles-host';
      parent.appendChild(host);
    }
  }

  const nodes = {};
  function make(id) {
    const e = new El({ id });
    e.id = id;
    nodes[id] = e;
    return e;
  }
  [
    'ps-create-guest', 'ps-create-phone', 'ps-create-date-from', 'ps-create-date-to',
    'ps-create-payment', 'ps-create-notes', 'ps-create-surfers',
    'ps-create-comp-course', 'ps-create-comp-private-lesson', 'ps-create-comp-no-lesson',
    'ps-create-comp-fullday', 'ps-create-course-select', 'ps-create-quote-preview',
    'ps-create-summary', 'ps-create-modal', 'ps-create-rentals', 'ps-create-submit',
  ].forEach(make);
  nodes['ps-create-payment'].value = 'unpaid';
  nodes['ps-create-surfers'].value = '2';
  nodes['ps-create-comp-no-lesson'].checked = true;

  const wrap = nodes['ps-create-rentals'];
  Object.defineProperty(wrap, 'innerHTML', {
    get() { return this._html || ''; },
    set(v) {
      this._html = String(v || '');
      parseRentalsHtml(this._html, this);
    },
  });

  return {
    el: (id) => nodes[id] || null,
    nodes,
    wrap,
  };
}

function liveAdminFixture() {
  const prices = [];
  Object.keys(BUNDLE_CENTS).forEach((dur) => {
    prices.push({
      id: 'price-bundle-' + dur,
      item_type: 'rental',
      item_code: 'board_and_suit_rental__' + dur,
      offering_key: 'board_and_suit_rental',
      unit: dur,
      category: 'rental',
      amount_cents: BUNDLE_CENTS[dur],
      currency: 'EUR',
      location_id: LOC,
      active: true,
    });
    prices.push({
      id: 'price-board-' + dur,
      item_type: 'rental',
      item_code: 'board_rental__' + dur,
      offering_key: 'board_rental',
      unit: dur,
      category: 'rental',
      amount_cents: Math.round(BUNDLE_CENTS[dur] * 0.6),
      currency: 'EUR',
      location_id: LOC,
      active: true,
    });
    prices.push({
      id: 'price-suit-' + dur,
      item_type: 'rental',
      item_code: 'wetsuit_rental__' + dur,
      offering_key: 'wetsuit_rental',
      unit: dur,
      category: 'rental',
      amount_cents: Math.round(BUNDLE_CENTS[dur] * 0.4),
      currency: 'EUR',
      location_id: LOC,
      active: true,
    });
  });
  // Short pebbles for no-lesson single-day mode
  ['1_hour', 'half_day'].forEach((dur) => {
    prices.push({
      id: 'price-board-s-' + dur,
      item_type: 'rental',
      item_code: 'board_rental__' + dur,
      offering_key: 'board_rental',
      unit: dur,
      category: 'rental',
      amount_cents: 1000,
      currency: 'EUR',
      location_id: LOC,
      active: true,
    });
    prices.push({
      id: 'price-suit-s-' + dur,
      item_type: 'rental',
      item_code: 'wetsuit_rental__' + dur,
      offering_key: 'wetsuit_rental',
      unit: dur,
      category: 'rental',
      amount_cents: 500,
      currency: 'EUR',
      location_id: LOC,
      active: true,
    });
  });
  // source: 'db' required when SUNSET_ADMIN_DB_READ_ENABLED=1 (live-shaped fixture).
  return {
    ok: true,
    source: 'db',
    prices,
    surf_packs: [],
    lesson_times: [],
    private_lesson: {
      label: 'Private', amount_cents: 8000, price_basis: 'per_session',
      default_duration_minutes: 120,
    },
  };
}

function quoteCapturedBody(body, adminCfg) {
  const built = buildSunsetQuoteCommand({
    clientSlug: 'sunset',
    locationId: LOC,
    channel: QUOTE_CHANNELS.MANUAL_STAFF,
    transportBody: body,
    now: new Date('2026-07-01T12:00:00Z'),
  });
  if (!built.ok) return built;
  return executeSunsetQuoteSync(built.command, { adminCfg });
}

(async () => {
  console.log('\nverify:sunset-rental-quantity-total-hotfix\n');
  const portalSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'),
    'utf8',
  );
  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

  console.log('[0] Ownership: multi-day force-recompute + intent-bound quote');
  ok('read path forces multi-day over sticky shortMode',
    (() => {
      const fn = extractFn(apiSrc, 'scheduleReadCreateRentalSelectionFromDom') || '';
      // Authoritative span recompute from dates (not a stale short-window default).
      return /dateDur !== '1_day'/.test(fn)
        || /dateDur != '1_day'/.test(fn)
        || (/scheduleRentalDurationKeyFromDates/.test(fn) && /data-duration-key/.test(fn));
    })());
  ok('portal defines schedulePortalQuotePricingIntentKey',
    /function schedulePortalQuotePricingIntentKey/.test(portalSrc));
  ok('portal defines schedulePortalDropStaleQuoteUi',
    /function schedulePortalDropStaleQuoteUi/.test(portalSrc));
  ok('fetchQuote stores intent_key on state',
    /intent_key:\s*intentKey/.test(extractFn(portalSrc, 'schedulePortalFetchQuote') || ''));
  ok('refresh clears quote state before checking',
    /schedulePortalQuoteState\s*=\s*null/.test(
      extractFn(portalSrc, 'schedulePortalRefreshCreateQuote') || '',
    ));
  ok('sync footer drops stale quote before refresh',
    /schedulePortalDropStaleQuoteUi/.test(
      extractFn(portalSrc, 'schedulePortalSyncCreateFooter') || '',
    ));

  console.log('\n[1] Generated /staff/ui artifact');
  const rendered = await fetchRenderedStaffUi();
  ok('GET /staff/ui 200 HTML', !!(rendered && rendered.html && rendered.html.includes('<!DOCTYPE')));
  ok('generated multi-day force-recompute present',
    // Span-owned duration: always recompute from date_from/date_to (not a stale 1_day default).
    (/dateDur !== '1_day'|dateDur != '1_day'/.test(rendered.html)
      || (/scheduleRentalDurationKeyFromDates/.test(rendered.html)
        && /data-duration-key/.test(rendered.html)
        && /function scheduleReadCreateRentalSelectionFromDom/.test(rendered.html))));
  ok('generated scheduleReadCreatePayload present',
    /function scheduleReadCreatePayload/.test(rendered.html));
  ok('generated schedulePortalFetchQuote present',
    /function schedulePortalFetchQuote/.test(rendered.html));

  const html = rendered.html;
  const adminCfg = liveAdminFixture();
  const prices = adminCfg.prices;
  const { el, nodes, wrap } = miniDom();
  const captured = [];

  const rentalOfferingsIdentity = [
    { offering_key: 'board_rental', label: 'Surfboard', active: true, location_id: LOC, client_slug: 'sunset' },
    { offering_key: 'wetsuit_rental', label: 'Wetsuit', active: true, location_id: LOC, client_slug: 'sunset' },
    { offering_key: 'board_and_suit_rental', label: 'Board and wetsuit', active: true, location_id: LOC, client_slug: 'sunset' },
  ];
  const ctx = {
    el,
    scheduleAdminPricesCache: prices,
    scheduleRentalOfferingsCache: rentalOfferingsIdentity,
    scheduleCreateCustomLines: [],
    window: {},
    document: { querySelectorAll() { return []; } },
    portalT(k) {
      if (k === 'schedule.ops.rentalBoth') return 'Board and wetsuit';
      if (k === 'schedule.type.noLesson') return 'No lesson';
      if (k === 'schedule.create.quoteTotal') return 'Quoted total';
      if (k === 'admin.period.5_days') return '5 days';
      if (k === 'admin.period.1_day') return '1 day';
      if (k === 'schedule.create.rentalDuration.fullDay') return 'Full day';
      if (k === 'schedule.payment.unpaid') return 'Unpaid';
      if (k === 'schedule.create.rentalQty') return 'Qty';
      return k;
    },
    escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    getSunsetLocation() { return LOC; },
    getClient() { return 'sunset'; },
    sunsetLocationQuerySuffix() { return '&location_id=' + LOC; },
    scheduleTodayIso() { return '2026-07-27'; },
    schedulePortalMadridTodayIso() { return '2026-07-27'; },
    adminPeriodLabel(k) {
      const m = {
        '1_day': '1 day', '5_days': '5 days', '4_days': '4 days', half_day: 'Half day',
      };
      return m[k] || k;
    },
    scheduleRentalDurationKeyFromDates: rentalMod.scheduleRentalDurationKeyFromDates,
    scheduleProjectStandaloneRentals: rentalMod.scheduleProjectStandaloneRentals,
    scheduleActiveRentalsForDuration: rentalMod.scheduleActiveRentalsForDuration,
    scheduleActiveShortRentalOfferings: rentalMod.scheduleActiveShortRentalOfferings,
    scheduleCommonShortRentalDurationKeys: rentalMod.scheduleCommonShortRentalDurationKeys,
    scheduleRentalOfferingsMode: rentalMod.scheduleRentalOfferingsMode,
    scheduleSerializeRentalsSelection: rentalMod.scheduleSerializeRentalsSelection,
    scheduleRentalsToLegacyComponents: rentalMod.scheduleRentalsToLegacyComponents,
    scheduleRentalOfferingLabelKey: rentalMod.scheduleRentalOfferingLabelKey,
    scheduleRentalOfferingDisplayLabel: rentalMod.scheduleRentalOfferingDisplayLabel,
    scheduleShortRentalDurationLabelKey: rentalMod.scheduleShortRentalDurationLabelKey,
    scheduleShortRentalDurationFallbackLabel: rentalMod.scheduleShortRentalDurationFallbackLabel,
    scheduleIsShortRentalDurationKey: rentalMod.scheduleIsShortRentalDurationKey,
    scheduleApplyRentalMutualExclusion: rentalMod.scheduleApplyRentalMutualExclusion,
    scheduleEnhanceIntSteppersIn() {},
    scheduleFormatCentsMoney(c) { return '€' + (Number(c) / 100).toFixed(0); },
    SCHEDULE_CANONICAL_RENTAL_OFFERINGS: rentalMod.SCHEDULE_CANONICAL_RENTAL_OFFERINGS,
    schedulePortalQuoteGen: 0,
    schedulePortalQuoteState: null,
    schedulePortalQuoteAbort: null,
    schedulePortalQuoteTimer: null,
    schedulePortalQuoteDebounceMs: 0,
    schedulePortalSubmitInFlight: false,
    scheduleSyncCreateSurferMirrors() {},
    scheduleReadPrivateLessonSessionsFromDom() { return []; },
    scheduleReadFullDayAddonRows() { return {}; },
    scheduleReadCreateCustomLineItems() { return []; },
    scheduleReadCreateAccommodation() { return null; },
    schedulePortalNormalizeLessonsIntent() { return { present: false, lessons: [] }; },
    schedulePortalNormalizeCourseEquipmentIntent() { return null; },
    schedulePortalNormalizeAccommodationIntent() { return null; },
    schedulePortalNormalizeCustomLinesIntent() { return []; },
    schedulePortalNormalizeRentalsIntent(r) { return Array.isArray(r) ? r : []; },
    schedulePortalSyncCreateSubmitEnabled() {},
    fetch(url, opts) {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      captured.push({ url, body });
      const q = quoteCapturedBody(body, adminCfg);
      const resp = q.ok ? q.body : Object.assign({ success: false }, q.body || {});
      return Promise.resolve({
        ok: !!q.ok,
        status: q.ok ? 200 : (q.status || 422),
        json: () => Promise.resolve(resp),
      });
    },
    Number, String, Math, parseInt, Object, Array, JSON, isNaN, Date, Promise, console,
    setTimeout, clearTimeout,
    AbortController: class {
      constructor() { this.signal = { aborted: false }; }
      abort() { this.signal.aborted = true; }
    },
  };
  vm.createContext(ctx);

  const need = [
    'scheduleEnumerateDates',
    'scheduleCreateDateSpanForRentals',
    'scheduleCreateIsNoLesson',
    'scheduleReadCreateSurferCount',
    'scheduleApplyCreateRentalExclusionUi',
    'scheduleCreateIsCombinedBoardWetsuit',
    'scheduleRenderCreateRentalDurationPebbles',
    'scheduleWireCreateRentals',
    'scheduleRenderCreateRentals',
    'scheduleReadCreateRentalSelectionFromDom',
    'scheduleReadCreatePayload',
    'schedulePortalServiceDatesFromPayload',
    'schedulePortalStrictQuoteTotalCents',
    'schedulePortalClientQuery',
    'schedulePortalFetchJson',
    'schedulePortalNormalizeRentalsIntent',
    'schedulePortalQuotePricingIntentKey',
    'schedulePortalQuoteMatchesPricingIntent',
    'schedulePortalDropStaleQuoteUi',
    'schedulePortalFetchQuote',
    'schedulePortalRenderCreateIntentSummary',
    'schedulePortalFormatCompactDateRange',
    'schedulePortalRentalLabel',
    'schedulePortalDurationLabel',
    'schedulePortalHumanCourseBit',
    'schedulePortalShowQuoteChecking',
    'schedulePortalRenderCreateQuotePreview',
    'schedulePortalInvalidatePreviewWork',
    'schedulePortalInvalidateCreateQuoteIntent',
    'schedulePortalRefreshCreateQuote',
    'schedulePortalSyncCreateFooter',
    'schedulePortalRunPreviewQuote',
    'schedulePortalValidateCreatePayload',
    'schedulePortalHasSellableIntent',
    'schedulePortalCanonicalDateIso',
    'schedulePortalClearQuotePreviewUi',
  ];
  need.forEach((n) => {
    const src = extractFn(html, n) || extractFn(portalSrc, n) || extractFn(apiSrc, n);
    if (!src) {
      ok('extract ' + n, false, 'missing');
      return;
    }
    try {
      vm.runInContext(src, ctx);
    } catch (e) {
      ok('load ' + n, false, e.message);
    }
  });

  console.log('\n[2] Screenshot path: Jul 27–31 · 2 surfers · no lesson · board+suit');
  // Start as short-day (stale trap), then extend to 5 days — mirrors real staff flow.
  nodes['ps-create-date-from'].value = '2026-07-27';
  nodes['ps-create-date-to'].value = '2026-07-27';
  nodes['ps-create-surfers'].value = '2';
  nodes['ps-create-comp-no-lesson'].checked = true;
  nodes['ps-create-guest'].value = 'Screenshot Guest';
  wrap.setAttribute('data-duration-key', '1_day');
  wrap.setAttribute('data-short-rental', '1');
  ctx.scheduleRenderCreateRentals();

  // Select board_and_suit if present; else board+wetsuit combined short path.
  // Equipment qty is independent of guest/surfer count — set physical units to 2.
  function selectBundleAndSetQty(q) {
    let selected = false;
    wrap.querySelectorAll('[data-rental-offering]').forEach((r) => {
      const k = r.getAttribute('data-rental-offering');
      const want = k === 'board_and_suit_rental'
        || (!selected && (k === 'board_rental' || k === 'wetsuit_rental'));
      if (!want) return;
      const c = r.querySelector('.ps-create-rental-check');
      if (c) {
        c.checked = true;
        if (k === 'board_and_suit_rental') selected = true;
      }
      const qtyEl = r.querySelector('input.ps-create-rental-qty-input')
        || r.querySelector('.ps-create-rental-qty-input');
      if (qtyEl) {
        qtyEl.value = String(q);
        qtyEl.setAttribute('data-qty-owner', 'user');
      }
    });
    return selected;
  }
  selectBundleAndSetQty(2);

  // First quote at 1 day (establishes €40 stale risk = 2000×2)
  captured.length = 0;
  ctx.schedulePortalQuoteGen = 1;
  const p1 = ctx.scheduleReadCreatePayload();
  await ctx.schedulePortalFetchQuote(p1, { gen: 1, applyState: true });
  const t1 = ctx.schedulePortalQuoteState && ctx.schedulePortalQuoteState.total_cents;
  ok('1-day baseline quote is Admin 1_day × 2 (stale-risk €40 path)',
    t1 === 4000 || t1 === 3000 || t1 === 2000,
    'got ' + t1 + ' (board_and_suit 2000×2=4000 or expanded board+suit)');

  // Extend to screenshot 5 days
  nodes['ps-create-date-to'].value = '2026-07-31';
  ctx.scheduleRenderCreateRentals();
  // Preserve/ensure board_and_suit checked + independent qty 2 after multi-day re-render
  selectBundleAndSetQty(2);

  // Sticky shortMode trap: poison attributes the way a missed re-render would leave them.
  wrap.setAttribute('data-duration-key', '1_day');
  wrap.setAttribute('data-short-rental', '1');

  const payload = ctx.scheduleReadCreatePayload();
  ok('payload date_from 2026-07-27', payload.date_from === '2026-07-27', payload.date_from);
  ok('payload date_to 2026-07-31', payload.date_to === '2026-07-31', payload.date_to);
  ok('payload surfer_count 2', payload.surfer_count === 2, String(payload.surfer_count));
  ok('payload rentals exact board_and_suit 5_days qty 2',
    Array.isArray(payload.rentals) && payload.rentals.length === 1
    && payload.rentals[0].offering_key === 'board_and_suit_rental'
    && payload.rentals[0].duration_key === '5_days'
    && payload.rentals[0].quantity === 2,
    JSON.stringify(payload.rentals));
  ok('sticky shortMode poison cleared by multi-day recompute',
    wrap.getAttribute('data-short-rental') === '0'
    && wrap.getAttribute('data-duration-key') === '5_days',
    'short=' + wrap.getAttribute('data-short-rental')
    + ' dur=' + wrap.getAttribute('data-duration-key'));
  ok('components present but do not replace rentals',
    payload.components && payload.components.surfboard && payload.components.wetsuit
    && payload.rentals[0].offering_key === 'board_and_suit_rental');

  console.log('\n[3] Real schedulePortalFetchQuote transport capture');
  captured.length = 0;
  ctx.schedulePortalQuoteGen = 2;
  // Simulate footer: summary + drop stale + fetch
  ctx.schedulePortalRenderCreateIntentSummary(payload);
  ctx.schedulePortalDropStaleQuoteUi(payload);
  ok('stale 1-day quote state cleared after intent drift',
    ctx.schedulePortalQuoteState == null,
    JSON.stringify(ctx.schedulePortalQuoteState));

  const fetchResult = await ctx.schedulePortalFetchQuote(payload, { gen: 2, applyState: true });
  ok('fetch captured exactly one body', captured.length === 1, 'n=' + captured.length);
  const body = captured[0] && captured[0].body;
  ok('transport date_from', body && body.date_from === '2026-07-27', JSON.stringify(body && body.date_from));
  ok('transport date_to', body && body.date_to === '2026-07-31', JSON.stringify(body && body.date_to));
  ok('transport surfer_count 2', body && body.surfer_count === 2, JSON.stringify(body && body.surfer_count));
  ok('transport rentals exact',
    body && Array.isArray(body.rentals) && body.rentals.length === 1
    && body.rentals[0].offering_key === 'board_and_suit_rental'
    && body.rentals[0].duration_key === '5_days'
    && body.rentals[0].quantity === 2,
    JSON.stringify(body && body.rentals));
  ok('transport service_dates 5 inclusive days',
    body && Array.isArray(body.service_dates) && body.service_dates.length === 5
    && body.service_dates[0] === '2026-07-27'
    && body.service_dates[4] === '2026-07-31',
    JSON.stringify(body && body.service_dates));
  ok('transport components canonical (surfboard+wetsuit) without overriding rentals',
    body && body.components && body.components.surfboard && body.components.wetsuit
    && body.rentals[0].duration_key === '5_days');

  console.log('\n[4] Captured body → production quote service (live-shaped Admin)');
  const q = quoteCapturedBody(body, adminCfg);
  ok('quote ok', q.ok === true, JSON.stringify(q.body || q));
  ok('quote total 20000 (€200)', q.ok && q.body && q.body.total_cents === 20000,
    q.ok ? ('total=' + q.body.total_cents) : JSON.stringify(q.body || q));
  const line = (q.body && q.body.line_items || []).find(
    (l) => l.component === 'board_and_suit_rental'
      || String(l.offering_id || '').includes('board_and_suit_rental'),
  );
  ok('one claimed board_and_suit line',
    !!line && (q.body.line_items || []).filter(
      (l) => String(l.component || '').includes('board') || String(l.component || '').includes('suit'),
    ).length === 1,
    JSON.stringify((q.body && q.body.line_items || []).map((l) => ({
      c: l.component, d: l.duration_key, u: l.unit_amount_cents, q: l.quantity, t: l.total_cents,
    }))));
  ok('line unit 10000 qty 2 total 20000',
    line && Number(line.unit_amount_cents) === 10000
    && Number(line.quantity) === 2
    && Number(line.total_cents) === 20000,
    line ? JSON.stringify({
      u: line.unit_amount_cents, q: line.quantity, t: line.total_cents, d: line.duration_key,
      o: line.offering_id,
    }) : 'no line');
  ok('line identity board_and_suit_rental__5_days',
    line && (
      String(line.offering_id || '').includes('__5_days')
      || String(line.offering_item_code || '').includes('__5_days')
      || line.duration_key === '5_days'
    ),
    line ? String(line.offering_id || line.offering_item_code) : '');
  ok('fetch result applyState total 20000 with intent_key',
    fetchResult && fetchResult.ok
    && ctx.schedulePortalQuoteState
    && ctx.schedulePortalQuoteState.total_cents === 20000
    && ctx.schedulePortalQuoteState.intent_key != null,
    JSON.stringify(ctx.schedulePortalQuoteState));

  console.log('\n[5] Mutations must RED');
  // Force 1_day on captured body
  const mut1 = JSON.parse(JSON.stringify(body));
  mut1.rentals = [{
    offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 2,
  }];
  const qMut1 = quoteCapturedBody(mut1, adminCfg);
  ok('mutation force 1_day on 5-day span fails closed (not silent €40)',
    !qMut1.ok
    || (qMut1.body && (qMut1.body.reason_code === 'rental_duration_mismatch'
      || qMut1.body.reason === 'rental_duration_mismatch')),
    qMut1.ok
      ? ('accepted total=' + qMut1.body.total_cents + ' — must not silently price 1-day')
      : JSON.stringify(qMut1.body || qMut1));

  // Drop rentals — components-only must not silently become 1_day × 2 = 4000 on multi-day
  // when Admin has multi-day board/suit rows; if it quotes, total must not be 4000.
  const mut2 = JSON.parse(JSON.stringify(body));
  delete mut2.rentals;
  const qMut2 = quoteCapturedBody(mut2, adminCfg);
  ok('mutation drop rentals does not yield silent €40 (1_day×2)',
    !(qMut2.ok && qMut2.body && qMut2.body.total_cents === 4000),
    qMut2.ok
      ? ('total=' + qMut2.body.total_cents + ' lines='
        + JSON.stringify((qMut2.body.line_items || []).map((l) => l.offering_id || l.duration_key)))
      : JSON.stringify(qMut2.body || qMut2));

  // Empty rentals array present-owns → no rental lines / not 4000
  const mut3 = JSON.parse(JSON.stringify(body));
  mut3.rentals = [];
  const qMut3 = quoteCapturedBody(mut3, adminCfg);
  ok('mutation empty rentals[] does not yield €40',
    !(qMut3.ok && qMut3.body && qMut3.body.total_cents === 4000),
    qMut3.ok ? ('total=' + qMut3.body.total_cents) : JSON.stringify(qMut3.body || qMut3));

  console.log('\n[6] Stale €40 cannot display beside 5-day summary');
  // Plant stale state + preview HTML, then sync footer for 5-day payload
  ctx.schedulePortalQuoteState = {
    total_cents: 4000,
    gen: 1,
    intent_key: JSON.stringify({ stale: true }),
    quote_provenance: { quote_fingerprint: 'stale-1day' },
  };
  nodes['ps-create-quote-preview'].innerHTML =
    '<p class="portal-schedule-drawer-hint">Quoted total: €40.00</p>';
  nodes['ps-create-quote-preview'].style.display = 'block';
  ctx.schedulePortalSyncCreateFooter({ quote: false });
  ok('sync footer drops stale €40 from preview',
    !/€40/.test(String(nodes['ps-create-quote-preview'].innerHTML || '')),
    nodes['ps-create-quote-preview'].innerHTML);
  ok('sync footer nulls stale quote state',
    ctx.schedulePortalQuoteState == null);

  // Full refresh path after 5-day payload
  captured.length = 0;
  ctx.schedulePortalQuoteDebounceMs = 0;
  await new Promise((resolve) => {
    const p = ctx.schedulePortalRefreshCreateQuote();
    if (p && typeof p.then === 'function') p.then(resolve, resolve);
    else setTimeout(resolve, 30);
  });
  await sleep(30);
  ok('refresh requotes with 5_days transport',
    captured.some((c) => c.body && c.body.rentals
      && c.body.rentals[0] && c.body.rentals[0].duration_key === '5_days'
      && c.body.rentals[0].quantity === 2),
    JSON.stringify(captured.map((c) => c.body && c.body.rentals)));
  ok('refresh state is €200 not €40',
    ctx.schedulePortalQuoteState
    && ctx.schedulePortalQuoteState.total_cents === 20000,
    JSON.stringify(ctx.schedulePortalQuoteState && {
      t: ctx.schedulePortalQuoteState.total_cents,
      i: !!ctx.schedulePortalQuoteState.intent_key,
    }));
  ok('preview shows €200.00',
    /€200\.00/.test(String(nodes['ps-create-quote-preview'].innerHTML || '')),
    nodes['ps-create-quote-preview'].innerHTML);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
