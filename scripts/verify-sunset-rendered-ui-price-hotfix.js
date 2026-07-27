'use strict';

/**
 * verify:sunset-rendered-ui-price-hotfix
 *
 * Behavioral gate against the REAL generated /staff/ui artifact (production
 * buildUiHtml + injectSunsetSchedulePortalModule), not raw staff-query-api.js
 * source extraction.
 *
 * Proves:
 *   A) Generated scheduleParseCreateMoneyToCents accepts 10 / 10.00 → 1000 cents
 *      and rejects malformed / exponent / >2 decimals (template-escape bug).
 *   B) Generated Create rental DOM builder for Jul 27–30 emits duration_key
 *      4_days; quote payload retains it; server live-shape quote resolves
 *      board_and_suit_rental__4_days Admin 8000 cents (not silent €20 / 1_day).
 *
 * No Azure / staging mutation. Spins a local open-auth staff API briefly.
 *
 * Run: node scripts/verify-sunset-rendered-ui-price-hotfix.js
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const net = require('net');

const ROOT = path.join(__dirname, '..');
process.env.SUNSET_ADMIN_DB_READ_ENABLED = '1';

const {
  injectSunsetSchedulePortalModule,
  SCHEDULE_MONEY_PARSE_INJECT_MARKER,
} = require('./lib/sunset-schedule-browser-source');
const moneyMod = require('./browser/sunset-schedule-money-parse');
const rentalMod = require('./browser/sunset-schedule-rental-availability');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuoteSync,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');

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

function loadGeneratedParse(html) {
  const fn = extractFn(html, 'scheduleParseCreateMoneyToCents');
  if (!fn) return { fnSrc: null, parse: null };
  // Hostile false-positive guards: must not be the corrupted template form.
  const bad = [
    '/^d+(.d+)?$/',
    '/[€$£\u00a0s]/g',
    '/./g', // bare-dot strip of thousands separators (corrupted \\.)
  ];
  const parse = vm.runInNewContext(fn + '\nscheduleParseCreateMoneyToCents;', {
    Object, Number, String, Math, parseInt,
  });
  return { fnSrc: fn, parse, badHits: bad.filter((b) => fn.includes(b)) };
}

function miniDom() {
  // Minimal DOM for scheduleRenderCreateRentals / scheduleReadCreateRentalSelectionFromDom
  function El(attrs) {
    this.attrs = Object.assign({}, attrs || {});
    this.children = [];
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.style = {};
    this.dataset = {};
    this.innerHTML = '';
    this.textContent = '';
    this.className = (attrs && attrs.class) || '';
    this._listeners = {};
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
    };
  }
  El.prototype.getAttribute = function (k) {
    if (Object.prototype.hasOwnProperty.call(this.attrs, k)) return this.attrs[k];
    return null;
  };
  El.prototype.setAttribute = function (k, v) {
    this.attrs[k] = String(v);
  };
  El.prototype.removeAttribute = function (k) {
    delete this.attrs[k];
  };
  El.prototype.querySelectorAll = function (sel) {
    const out = [];
    const walk = (node) => {
      if (!node || !node.children) return;
      node.children.forEach((c) => {
        if (matchSel(c, sel)) out.push(c);
        walk(c);
      });
    };
    walk(this);
    // Also self
    if (matchSel(this, sel)) out.unshift(this);
    return out;
  };
  El.prototype.querySelector = function (sel) {
    const all = this.querySelectorAll(sel);
    return all.length ? all[0] : null;
  };
  El.prototype.addEventListener = function (type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  };
  El.prototype.closest = function () { return null; };

  function matchSel(el, sel) {
    if (!el || !sel) return false;
    if (sel.charAt(0) === '.') {
      const cls = sel.slice(1);
      return (el.className || '').split(/\s+/).indexOf(cls) >= 0
        || (el.attrs && el.attrs.class && String(el.attrs.class).split(/\s+/).indexOf(cls) >= 0);
    }
    if (sel.charAt(0) === '[') {
      const inner = sel.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq < 0) {
        return el.attrs && Object.prototype.hasOwnProperty.call(el.attrs, inner);
      }
      const k = inner.slice(0, eq);
      let v = inner.slice(eq + 1);
      if ((v.charAt(0) === '"' && v.charAt(v.length - 1) === '"')
        || (v.charAt(0) === "'" && v.charAt(v.length - 1) === "'")) {
        v = v.slice(1, -1);
      }
      return el.getAttribute(k) === v;
    }
    if (sel.indexOf('.') > 0 || sel.indexOf('[') > 0) {
      // compound: tag.class or .a.b — treat as class/attr only subset we need
      if (sel.indexOf('[') >= 0) {
        const attrPart = sel.slice(sel.indexOf('['));
        return matchSel(el, attrPart);
      }
    }
    return false;
  }

  // Very small HTML assigner used by scheduleRenderCreateRentals
  function parseSimple(html, parent) {
    // Enough for rental rows: div[data-rental-offering] with checkbox + optional qty input
    const re = /data-rental-offering="([^"]+)"/g;
    let m;
    const offerings = [];
    while ((m = re.exec(html))) offerings.push(m[1]);
    parent.children = [];
    offerings.forEach((key) => {
      const row = new El({ 'data-rental-offering': key });
      const check = new El({ 'data-offering-key': key, class: 'ps-create-rental-check' });
      check.className = 'ps-create-rental-check';
      check.checked = false;
      const qty = new El({ class: 'ps-create-rental-qty-input', 'data-qty-owner': 'surfers' });
      qty.className = 'ps-create-rental-qty-input';
      qty.value = '1';
      const qtyWrap = new El({ class: 'portal-schedule-create-rental-qty' });
      qtyWrap.className = 'portal-schedule-create-rental-qty';
      qtyWrap.children = [qty];
      const label = new El({ class: 'portal-schedule-create-check' });
      label.className = 'portal-schedule-create-check';
      row.children = [check, label, qtyWrap];
      // pebble host
      parent.children.push(row);
    });
    // pebbles host
    const host = new El({ 'data-rental-duration-pebbles': '' });
    parent.children.push(host);
  }

  const nodes = {};
  function el(id) { return nodes[id] || null; }

  const wrap = new El({ id: 'ps-create-rentals' });
  // Override innerHTML setter behavior via property
  Object.defineProperty(wrap, 'innerHTML', {
    get() { return this._html || ''; },
    set(v) {
      this._html = String(v || '');
      parseSimple(this._html, this);
    },
  });
  nodes['ps-create-rentals'] = wrap;
  nodes['ps-create-date-from'] = new El();
  nodes['ps-create-date-to'] = new El();
  nodes['ps-create-surfers'] = new El();
  nodes['ps-create-surfers'].value = '1';
  nodes['ps-create-comp-no-lesson'] = new El();
  nodes['ps-create-comp-no-lesson'].checked = true;
  nodes['ps-create-comp-course'] = new El();
  nodes['ps-create-comp-course'].checked = false;
  nodes['ps-create-comp-private-lesson'] = new El();
  nodes['ps-create-comp-private-lesson'].checked = false;
  nodes['ps-create-modal'] = new El();

  return { el, nodes, wrap, El };
}

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

function rentalAdminCfg() {
  const prices = [];
  Object.keys(BUNDLE_CENTS).forEach((dur) => {
    prices.push({
      id: 'price-bundle-' + dur,
      item_type: 'rental',
      item_code: 'board_and_suit_rental__' + dur,
      offering_key: 'board_and_suit_rental',
      unit: dur,
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
      amount_cents: Math.round(BUNDLE_CENTS[dur] * 0.4),
      currency: 'EUR',
      location_id: LOC,
      active: true,
    });
  });
  // Short pebbles for same-day no-lesson (must NOT force multi-day to 1_day)
  prices.push(
    {
      id: 'price-board-1h', item_type: 'rental', item_code: 'board_rental__1_hour',
      offering_key: 'board_rental', unit: '1_hour', amount_cents: 800,
      currency: 'EUR', location_id: LOC, active: true,
    },
    {
      id: 'price-suit-1h', item_type: 'rental', item_code: 'wetsuit_rental__1_hour',
      offering_key: 'wetsuit_rental', unit: '1_hour', amount_cents: 500,
      currency: 'EUR', location_id: LOC, active: true,
    },
    {
      id: 'price-board-1d', item_type: 'rental', item_code: 'board_rental__1_day',
      offering_key: 'board_rental', unit: '1_day', amount_cents: 1500,
      currency: 'EUR', location_id: LOC, active: true,
    },
    {
      id: 'price-suit-1d', item_type: 'rental', item_code: 'wetsuit_rental__1_day',
      offering_key: 'wetsuit_rental', unit: '1_day', amount_cents: 1000,
      currency: 'EUR', location_id: LOC, active: true,
    },
  );
  return {
    ok: true, source: 'db', prices, surf_packs: [],
    private_lesson: { label: 'Private', amount_cents: 8000, price_basis: 'per_session', default_duration_minutes: 120 },
  };
}

(async () => {
  console.log('\nverify:sunset-rendered-ui-price-hotfix\n');

  // ── Static ownership contracts ───────────────────────────────────────────
  console.log('[0] Ownership: money parse is injected module, not template body');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const browserSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-browser-source.js'), 'utf8');
  ok('inject marker in staff-api', apiSrc.includes(SCHEDULE_MONEY_PARSE_INJECT_MARKER));
  ok('no inline function scheduleParseCreateMoneyToCents in staff-api',
    !/\bfunction\s+scheduleParseCreateMoneyToCents\s*\(/.test(apiSrc));
  ok('injector loads money-parse module',
    browserSrc.includes('sunset-schedule-money-parse')
    && browserSrc.includes('getSunsetScheduleMoneyParseBrowserSource'));
  ok('module parse 10 → 1000 (source of truth)',
    moneyMod.scheduleParseCreateMoneyToCents('10').ok
    && moneyMod.scheduleParseCreateMoneyToCents('10').amount_cents === 1000);

  // Inject-only smoke (without full server) — same path buildUiHtml uses after template eval.
  const injected = injectSunsetSchedulePortalModule(
    '<script>(function(){function el(id){return null;}'
    + SCHEDULE_MONEY_PARSE_INJECT_MARKER
    + '/* INJECT:sunset-schedule-rental-availability */'
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
    + '})();</script>',
  );
  ok('inject embeds money parse function',
    injected.includes('function scheduleParseCreateMoneyToCents('));
  ok('injected money parse keeps \\d (not template-corrupted d)',
    /\/\^\\d\+\(\\\.\\d\+\)\?\$\//.test(injected)
    && !injected.includes('/^d+(.d+)?$/'));

  // ── A) Live buildUiHtml /staff/ui generated artifact ─────────────────────
  console.log('\n[A] Generated /staff/ui money parse (production buildUiHtml)');
  let rendered;
  try {
    rendered = await fetchRenderedStaffUi();
  } catch (e) {
    ok('fetch /staff/ui', false, String(e && e.message || e));
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(1);
  }
  ok('GET /staff/ui 200 HTML', !!(rendered && rendered.html && rendered.html.length > 10000));
  // Established header only — do not invent SHA public debug endpoint.
  ok('X-Powered-By staff-api header present (established pattern)',
    rendered.headers && /wolfhouse-staff-api/i.test(String(rendered.headers['x-powered-by'] || '')));

  const gen = loadGeneratedParse(rendered.html);
  ok('generated scheduleParseCreateMoneyToCents extract', !!gen.fnSrc);
  ok('generated parser has no corrupted regex forms',
    gen.fnSrc && (!gen.badHits || gen.badHits.length === 0),
    gen.badHits && gen.badHits.length ? gen.badHits.join(',') : '');
  ok('generated parser keeps /^\\d+(\\.\\d+)?$/',
    gen.fnSrc && /\/\^\\d\+\(\\\.\\d\+\)\?\$\//.test(gen.fnSrc));
  ok('generated parse loads in VM', typeof gen.parse === 'function');

  if (typeof gen.parse === 'function') {
    const p = gen.parse;
    ok('generated 10 → 1000', p('10').ok && p('10').amount_cents === 1000);
    ok('generated 10.0 → 1000', p('10.0').ok && p('10.0').amount_cents === 1000);
    ok('generated 10.00 → 1000', p('10.00').ok && p('10.00').amount_cents === 1000);
    ok('generated €10 → 1000', p('€10').ok && p('€10').amount_cents === 1000);
    ok('generated 10,50 locale → 1050', p('10,50').ok && p('10,50').amount_cents === 1050);
    ok('generated signed -5 → -500', p('-5').ok && p('-5').amount_cents === -500);
    ok('generated reject >2 decimals', !p('10.001').ok);
    ok('generated reject exponent 1e2', !p('1e2').ok && !p('10e0').ok);
    ok('generated reject malformed abc', !p('abc').ok);
    ok('generated reject empty', !p('').ok && !p('   ').ok);
  }

  // ── B) Generated rental duration builder + exact 4-day quote ─────────────
  console.log('\n[B] Generated Create rental builder Jul 27–30 → 4_days + €80');
  ok('shortMode gated in generated HTML',
    /shortMode\s*=\s*noLesson\s*&&\s*commonShort\.length\s*>\s*0\s*&&\s*dateDuration\s*===\s*'1_day'/.test(rendered.html));
  ok('read path recomputes multi-day duration from dates',
    /scheduleRentalDurationKeyFromDates/.test(
      extractFn(rendered.html, 'scheduleReadCreateRentalSelectionFromDom') || '',
    )
    && /data-short-rental/.test(
      extractFn(rendered.html, 'scheduleReadCreateRentalSelectionFromDom') || '',
    ));

  // Build a VM sandbox from GENERATED functions (not raw source files).
  const renderFn = extractFn(rendered.html, 'scheduleRenderCreateRentals');
  const readFn = extractFn(rendered.html, 'scheduleReadCreateRentalSelectionFromDom');
  const enumFn = extractFn(rendered.html, 'scheduleEnumerateDates');
  const dateSpanFn = extractFn(rendered.html, 'scheduleCreateDateSpanForRentals');
  const noLessonFn = extractFn(rendered.html, 'scheduleCreateIsNoLesson');
  const surferFn = extractFn(rendered.html, 'scheduleReadCreateSurferCount');
  const applyExclFn = extractFn(rendered.html, 'scheduleApplyCreateRentalExclusionUi');
  const wireFn = extractFn(rendered.html, 'scheduleWireCreateRentals');
  const combinedFn = extractFn(rendered.html, 'scheduleCreateIsCombinedBoardWetsuit');
  const pebblesFn = extractFn(rendered.html, 'scheduleRenderCreateRentalDurationPebbles');
  ok('generated render/read/enum extracts', !!(renderFn && readFn && enumFn));

  const { el, nodes, wrap } = miniDom();
  const prices = rentalAdminCfg().prices;
  const ctx = {
    el,
    scheduleAdminPricesCache: prices,
    scheduleCreateCustomLines: [],
    window: {},
    portalT(k) { return k; },
    escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    getSunsetLocation() { return LOC; },
    scheduleTodayIso() { return '2026-07-27'; },
    // Injected module helpers — same bodies as production inject
    scheduleRentalDurationKeyFromDates: rentalMod.scheduleRentalDurationKeyFromDates,
    scheduleActiveRentalsForDuration: rentalMod.scheduleActiveRentalsForDuration,
    scheduleActiveShortRentalOfferings: rentalMod.scheduleActiveShortRentalOfferings,
    scheduleCommonShortRentalDurationKeys: rentalMod.scheduleCommonShortRentalDurationKeys,
    scheduleRentalOfferingsMode: rentalMod.scheduleRentalOfferingsMode,
    scheduleSerializeRentalsSelection: rentalMod.scheduleSerializeRentalsSelection,
    scheduleRentalOfferingLabelKey: rentalMod.scheduleRentalOfferingLabelKey,
    scheduleShortRentalDurationLabelKey: rentalMod.scheduleShortRentalDurationLabelKey,
    scheduleShortRentalDurationFallbackLabel: rentalMod.scheduleShortRentalDurationFallbackLabel,
    scheduleIsShortRentalDurationKey: rentalMod.scheduleIsShortRentalDurationKey,
    scheduleApplyRentalMutualExclusion: rentalMod.scheduleApplyRentalMutualExclusion,
    Number, String, Math, parseInt, Object, Array, JSON, isNaN, Date,
  };
  vm.createContext(ctx);
  // Load generated helpers used by the multi-day create path
  [
    enumFn, dateSpanFn, noLessonFn, surferFn, combinedFn, applyExclFn,
    pebblesFn, wireFn, renderFn, readFn,
  ].filter(Boolean).forEach((src) => {
    vm.runInContext(src, ctx);
  });

  // Stale-state trap: pretend wrap still holds a short-mode 1_day key from a prior day.
  wrap.setAttribute('data-duration-key', '1_day');
  wrap.setAttribute('data-short-rental', '1');
  nodes['ps-create-date-from'].value = '2026-07-27';
  nodes['ps-create-date-to'].value = '2026-07-30';
  nodes['ps-create-surfers'].value = '1';
  nodes['ps-create-comp-no-lesson'].checked = true;

  ctx.scheduleRenderCreateRentals();
  const afterDur = wrap.getAttribute('data-duration-key');
  const afterShort = wrap.getAttribute('data-short-rental');
  ok('render Jul 27–30 sets data-duration-key 4_days', afterDur === '4_days', 'got ' + afterDur);
  ok('render multi-day sets short-rental=0 (not shortMode)', afterShort === '0', 'got ' + afterShort);

  // Select board_and_suit
  const rows = wrap.querySelectorAll('[data-rental-offering]');
  const bundleRow = rows.find
    ? rows.find((r) => r.getAttribute('data-rental-offering') === 'board_and_suit_rental')
    : null;
  // querySelectorAll returns array-like from our miniDom — use filter
  let bundle = null;
  wrap.querySelectorAll('[data-rental-offering]').forEach((r) => {
    if (r.getAttribute('data-rental-offering') === 'board_and_suit_rental') bundle = r;
  });
  ok('board_and_suit offering row rendered for 4_days', !!bundle);
  if (bundle) {
    const check = bundle.querySelector('.ps-create-rental-check');
    if (check) check.checked = true;
  }

  // Even if attribute is poisoned back to 1_day, read path must recompute.
  wrap.setAttribute('data-duration-key', '1_day');
  wrap.setAttribute('data-short-rental', '0');
  const rentals = ctx.scheduleReadCreateRentalSelectionFromDom();
  ok('read selection emits duration_key 4_days (not stale 1_day)',
    Array.isArray(rentals) && rentals.length === 1
    && rentals[0].offering_key === 'board_and_suit_rental'
    && rentals[0].duration_key === '4_days'
    && rentals[0].quantity === 1,
    JSON.stringify(rentals));

  // Quote payload retains 4_days → Admin 8000
  const built = buildSunsetQuoteCommand({
    clientSlug: 'sunset',
    locationId: LOC,
    channel: QUOTE_CHANNELS.MANUAL_STAFF,
    transportBody: {
      guest_name: 'Rendered Artifact Guest',
      date_from: '2026-07-27',
      date_to: '2026-07-30',
      payment_status: 'unpaid',
      components: { surfboard: { quantity: 1 }, wetsuit: { quantity: 1 } },
      rentals: rentals,
      surfer_count: 1,
    },
    now: new Date('2026-07-01T12:00:00Z'),
  });
  ok('quote command builds', built.ok, JSON.stringify(built));
  const q = executeSunsetQuoteSync(built.command, { adminCfg: rentalAdminCfg() });
  ok('live-shape quote exact Admin 8000 (board_and_suit__4_days)',
    q.ok && q.body && q.body.total_cents === 8000,
    q.ok ? ('total=' + q.body.total_cents) : JSON.stringify(q.body || q));
  ok('quote line identity uses 4_days not 1_day',
    q.ok && (q.body.line_items || []).some((l) => {
      const code = String(l.offering_id || l.offering_item_code || l.component || '');
      return (code.includes('4_days') || l.duration_key === '4_days')
        && Number(l.total_cents) === 8000;
    }),
    q.ok ? JSON.stringify((q.body.line_items || []).map((l) => ({
      c: l.component, d: l.duration_key, t: l.total_cents, o: l.offering_id,
    }))) : '');

  // Same-day short pebbles preserved: 1-day span still shortMode-capable
  nodes['ps-create-date-from'].value = '2026-07-27';
  nodes['ps-create-date-to'].value = '2026-07-27';
  ctx.scheduleRenderCreateRentals();
  ok('single-day no-lesson may shortMode (short-rental=1)',
    wrap.getAttribute('data-short-rental') === '1');
  ok('single-day duration is short key not multi-day',
    ['1_hour', 'half_day', '1_day'].indexOf(wrap.getAttribute('data-duration-key')) >= 0);

  // Duration-days tier key from generated artifact (RegExp constructor form)
  const tierFn = extractFn(rendered.html, 'scheduleDurationDaysFromTierKey');
  ok('scheduleDurationDaysFromTierKey present in artifact', !!tierFn);
  if (tierFn) {
    ok('tier key uses RegExp constructor (not corrupted /^(d+)_days$/)',
      tierFn.includes('new RegExp') && !tierFn.includes('/^(d+)_days$/'));
    const tier = vm.runInNewContext(tierFn + '\nscheduleDurationDaysFromTierKey;', {
      Number, String, parseInt, RegExp,
    });
    ok('generated tier 4_days → 4', typeof tier === 'function' && tier('4_days') === 4);
    ok('generated tier 1_day → 1', typeof tier === 'function' && tier('1_day') === 1);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
