'use strict';

/**
 * verify:sunset-create-footer-mobile-compact
 *
 * Compact mobile Create Booking sticky-footer summary:
 *   - two-row hierarchy + dedicated quote row
 *   - omit generic "Group Course" when course name is present
 *   - one duration only (no course+gear duration duplication)
 *   - compact date without years (27–31 Jul / 30 Jul–2 Aug)
 *   - omit payment status (Payment Status control owns it)
 *   - quote remains server-authoritative on its own row
 *   - stale quote clears when pricing intent changes
 *   - 375/430 CSS contract: no overflow, 44px button min target
 *   - EN/ES/IT locale behavior for dates + labels
 *
 * Executes the REAL generated /staff/ui artifact (production buildUiHtml +
 * injectSunsetSchedulePortalModule), not source-regex alone.
 *
 * No Azure / staging / DB mutation.
 *
 * Run: node scripts/verify-sunset-create-footer-mobile-compact.js
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const {
  injectSunsetSchedulePortalModule,
  SCHEDULE_PORTAL_INJECT_MARKER,
} = require('./lib/sunset-schedule-browser-source');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const esSunset = require('./lib/staff-portal-i18n-es-sunset');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log('  PASS  ' + label);
    pass += 1;
  } else {
    console.error('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
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
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('GET timeout')));
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
  child.stdout.on('data', () => {});

  let lastErr = null;
  try {
    for (let i = 0; i < 40; i += 1) {
      if (child.exitCode != null) {
        throw new Error('staff-query-api exited early: ' + stderr.slice(0, 500));
      }
      try {
        const res = await httpGet('http://127.0.0.1:' + port + '/staff/ui');
        if (res.status === 200 && res.body.includes('<!DOCTYPE html>')) {
          return { html: res.body, port };
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

const T_EN = {
  'schedule.create.summary.chooseLessonOrGear': 'Choose a lesson or add gear',
  'schedule.create.summary.completeSessions': 'Complete session details',
  'schedule.create.summary.sessions': 'Sessions',
  'schedule.create.summary.surfers': 'Surfers',
  'schedule.create.checkingPrice': 'Checking price…',
  'schedule.create.quoteTotal': 'Quoted total',
  'schedule.create.quoteFailed': 'Quote unavailable',
  'schedule.type.course': 'Group course',
  'schedule.type.privateLesson': 'Private course',
  'schedule.type.noLesson': 'No lesson',
  'schedule.type.boardRental': 'Board rental',
  'schedule.type.wetsuitRental': 'Wetsuit rental',
  'schedule.ops.rentalBoth': 'Board and wetsuit',
  'schedule.type.fullDayEquipment': 'Full-day gear',
  'schedule.payment.paid': 'Paid',
  'schedule.payment.unpaid': 'Unpaid',
  'admin.period.5_days': '5 days',
  'admin.period.6_days': '6 days',
  'admin.period.2_days': '2 day',
  'admin.period.1_day': '1 day',
  'admin.period.1_week': '1 week',
};

const T_ES = Object.assign({}, T_EN, {
  'schedule.type.course': 'Curso grupal',
  'schedule.type.noLesson': 'Sin clase',
  'schedule.ops.rentalBoth': 'Tabla y traje',
  'schedule.create.quoteTotal': 'Total presupuestado',
  'admin.period.5_days': '5 días',
  'admin.period.6_days': '6 días',
});

const T_IT = Object.assign({}, T_EN, {
  'schedule.type.course': 'Corso di gruppo',
  'schedule.type.noLesson': 'Nessuna lezione',
  'schedule.ops.rentalBoth': 'Tavola e muta',
  'schedule.create.quoteTotal': 'Totale quotato',
  'admin.period.5_days': '5 giorni',
  'admin.period.6_days': '6 giorni',
});

function sandboxFromHtml(html, opts) {
  opts = opts || {};
  const locale = opts.locale || 'en';
  const T = opts.T || (locale === 'es' ? T_ES : locale === 'it' ? T_IT : T_EN);
  const nodes = {};
  function N(id, x) {
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
      options: [],
      selectedIndex: -1,
      _ls: {},
      addEventListener(ev, fn) { (this._ls[ev] = this._ls[ev] || []).push(fn); },
      setAttribute(k, v) { this['_' + k] = v; },
      getAttribute(k) { return this['_' + k] || null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    }, x || {});
    return nodes[id];
  }
  N('ps-create-summary', { innerHTML: '<span>—</span>', style: { display: '' } });
  N('ps-create-quote-preview');
  N('ps-create-msg');
  N('ps-create-submit');
  N('ps-create-guest');
  N('ps-create-phone');
  N('ps-create-notes');
  N('ps-create-payment', { value: 'unpaid' });
  N('ps-create-date-from', { value: '2026-07-27' });
  N('ps-create-date-to', { value: '2026-07-31' });
  const cOpts = opts.courseOptions !== undefined
    ? opts.courseOptions
    : [{
      value: 'c1',
      textContent: 'Curso Mañana — Daily',
      getAttribute: (k) => (k === 'data-label' ? 'Curso Mañana' : null),
    }];
  N('ps-create-course-select', {
    value: cOpts[0] ? cOpts[0].value : '',
    options: cOpts,
    selectedIndex: cOpts.length ? 0 : -1,
  });
  N('ps-create-course-tier', { value: '5_days', options: [{ value: '5_days', textContent: '5 days' }], selectedIndex: 0 });
  N('ps-create-course-qty', { value: '1' });
  N('ps-create-comp-course');
  N('ps-create-comp-private-lesson');
  N('ps-create-comp-no-lesson', { checked: true });
  N('ps-create-comp-fullday');
  N('ps-create-rentals');

  let payload = opts.payload || {
    guest_name: 'Koa',
    guest_phone: '+34600',
    notes: '',
    date_from: '2026-07-27',
    date_to: '2026-07-31',
    payment_status: 'unpaid',
    components: {},
    rentals: [],
  };

  // Extract only the portal functions we need from the generated artifact.
  const needed = [
    'schedulePortalFormatCompactDateRange',
    'schedulePortalRentalLabel',
    'schedulePortalDurationLabel',
    'schedulePortalHumanCourseBit',
    'schedulePortalRenderCreateIntentSummary',
    'schedulePortalRenderCreateQuotePreview',
    'schedulePortalStrictQuoteTotalCents',
    'schedulePortalDropStaleQuoteUi',
    'schedulePortalQuotePricingIntentKey',
    'schedulePortalQuoteMatchesPricingIntent',
    'schedulePortalNormalizeRentalsIntent',
    'schedulePortalSyncCreateFooter',
    'schedulePortalSyncCreateSubmitEnabled',
    'schedulePortalShowQuoteChecking',
    'schedulePortalClearQuotePreviewUi',
    'schedulePortalInvalidatePreviewWork',
    'schedulePortalRefreshCreateQuote',
  ];
  const chunks = [];
  for (const name of needed) {
    const fn = extractFn(html, name);
    if (fn) chunks.push(fn);
  }
  // Fallback: if compact helper missing, still load renderer (RED expected).
  const portalBody = chunks.join('\n');
  ok('generated artifact has schedulePortalRenderCreateIntentSummary',
    !!extractFn(html, 'schedulePortalRenderCreateIntentSummary'));

  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Object,
    Array,
    Number,
    String,
    Math,
    Date,
    Intl,
    AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
    getClient: () => 'sunset',
    getSunsetLocation: () => 'sunset-somo',
    sunsetLocationQuerySuffix: () => '&location_id=sunset-somo',
    getStaffLocale: () => locale,
    scheduleEnumerateDates: (a, b) => [String(a).slice(0, 10), String(b).slice(0, 10)],
    scheduleReadCreatePayload: () => JSON.parse(JSON.stringify(payload)),
    scheduleUpdateFullDayAddonSummary() {},
    adminPeriodLabel: (k) => T['admin.period.' + k] || null,
    portalT: (k) => T[k] || k,
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    el: (id) => nodes[id] || null,
    scheduleRentalOfferingLabelKey: (k) => (
      k === 'wetsuit_rental' ? 'schedule.type.wetsuitRental'
        : k === 'board_and_suit_rental' ? 'schedule.ops.rentalBoth'
          : k === 'board_rental' ? 'schedule.type.boardRental'
            : ''
    ),
    schedulePortalQuoteState: null,
    schedulePortalQuoteGen: 0,
    schedulePortalQuoteAbort: null,
    schedulePortalQuoteTimer: null,
    schedulePortalQuoteDebounceMs: 400,
    schedulePortalSubmitInFlight: false,
    _nodes: nodes,
    _setPayload(p) { payload = p; },
  };

  // Declare mutable module-level vars used by extracted functions.
  const prelude = [
    'var schedulePortalQuoteState = null;',
    'var schedulePortalQuoteGen = 0;',
    'var schedulePortalQuoteAbort = null;',
    'var schedulePortalQuoteTimer = null;',
    'var schedulePortalQuoteDebounceMs = 400;',
    'var schedulePortalSubmitInFlight = false;',
  ].join('\n');

  vm.createContext(ctx);
  try {
    vm.runInContext(prelude + '\n' + portalBody, ctx);
  } catch (e) {
    // Some extracted helpers may reference missing siblings in RED state — surface later.
    ctx._loadError = e;
  }
  return ctx;
}

function S(c) {
  return String(c.el('ps-create-summary').innerHTML || '');
}
function Stext(c) {
  return S(c).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function Q(c) {
  return String(c.el('ps-create-quote-preview').innerHTML || '');
}

function stripYear(s) {
  return !/\b2026\b/.test(s) && !/\b20\d{2}\b/.test(s);
}

(async function main() {
  console.log('\nverify:sunset-create-footer-mobile-compact\n');

  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const portalSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'),
    'utf8',
  );

  // ── CSS / HTML contract (source + structure) ─────────────────────────────
  console.log('[0] CSS + footer chrome contract');
  const footer = (apiSrc.match(/<footer class="portal-schedule-create-footer"[\s\S]*?<\/footer>/) || [])[0] || '';
  ok('footer order summary → quote → actions',
    footer.includes('ps-create-summary')
    && footer.includes('ps-create-quote-preview')
    && footer.indexOf('ps-create-summary') < footer.indexOf('ps-create-quote-preview')
    && footer.indexOf('ps-create-quote-preview') < footer.indexOf('ps-create-submit'));
  ok('footer overflow-x hidden',
    /\.portal-schedule-create-footer\{[^}]*overflow-x:\s*hidden/.test(apiSrc));
  ok('button min-height 44px touch target',
    /\.portal-schedule-create-footer\s+\.portal-schedule-create-actions\s+\.btn\{[^}]*min-height:\s*44px/.test(apiSrc)
    || /\.portal-schedule-create-footer \.portal-schedule-create-actions \.btn\{[^}]*min-height:\s*44px/.test(apiSrc));
  ok('summary two-row classes present in CSS',
    /\.portal-schedule-create-summary-primary/.test(apiSrc)
    && /\.portal-schedule-create-summary-secondary/.test(apiSrc));
  ok('mobile compact media allows vertical growth without covering actions',
    /@media\s*\(\s*max-width:\s*640px\s*\)[\s\S]{0,1200}?portal-schedule-create-summary/.test(apiSrc)
    || /\.portal-schedule-create-summary\{[^}]*flex-direction:\s*column/.test(apiSrc));
  ok('quote row dedicated (not nested in summary)',
    !/id="ps-create-quote-preview"[\s\S]{0,40}ps-create-summary/.test(footer)
    && /id="ps-create-summary"/.test(footer)
    && /id="ps-create-quote-preview"/.test(footer));
  // 375 / 430: drawer full-bleed + footer no wrap-over buttons
  ok('create drawer full width ≤640',
    /@media\(max-width:640px\)\{\.portal-schedule-drawer,\.portal-schedule-create-drawer\{width:100vw/.test(apiSrc)
    || /@media\(max-width:640px\)\{[^}]*portal-schedule-create-drawer\{[^}]*width:100vw/.test(apiSrc));
  ok('actions flex 0 0 auto (buttons not crushed by summary)',
    /\.portal-schedule-create-footer\s+\.portal-schedule-create-actions\{[^}]*flex:\s*0\s+0\s+auto/.test(apiSrc)
    || /\.portal-schedule-create-footer \.portal-schedule-create-actions\{[^}]*flex:\s*0\s+0\s+auto/.test(apiSrc));
  ok('compact date helper owner in portal module',
    /function schedulePortalFormatCompactDateRange/.test(portalSrc));
  ok('summary omits payment_status bit',
    !/payment_status[\s\S]{0,200}bits\.push/.test(
      extractFn(portalSrc, 'schedulePortalRenderCreateIntentSummary') || '',
    )
    && !/schedule\.payment\.(paid|unpaid)/.test(
      extractFn(portalSrc, 'schedulePortalRenderCreateIntentSummary') || '',
    ));

  // ── Live /staff/ui artifact ──────────────────────────────────────────────
  console.log('\n[1] Generated /staff/ui artifact');
  let rendered;
  try {
    rendered = await fetchRenderedStaffUi();
  } catch (e) {
    ok('GET /staff/ui', false, String(e && e.message || e));
    console.error('\nFAILED early — cannot load /staff/ui\n');
    process.exit(1);
  }
  const html = rendered.html;
  ok('GET /staff/ui 200 HTML', html.includes('<!DOCTYPE html>') && html.includes('ps-create-summary'));
  ok('/staff/ui injects portal summary renderer',
    html.includes('function schedulePortalRenderCreateIntentSummary'));
  ok('/staff/ui injects compact date helper',
    html.includes('function schedulePortalFormatCompactDateRange'));
  ok('/staff/ui CSS has primary/secondary summary rows',
    html.includes('portal-schedule-create-summary-primary')
    && html.includes('portal-schedule-create-summary-secondary'));
  ok('/staff/ui still has 44px footer buttons',
    /\.portal-schedule-create-footer[\s\S]{0,400}min-height:\s*44px/.test(html));

  // Offline inject path (same as buildUiHtml post-template) for hostile parity.
  const injected = injectSunsetSchedulePortalModule(
    '<!--x-->' + SCHEDULE_PORTAL_INJECT_MARKER + '<!--y-->'
    + fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8')
      .match(/\.portal-schedule-create-summary[\s\S]{0,800}?portal-schedule-create-footer #ps-create-quote-preview[\s\S]{0,200}/)?.[0]
    || '',
  );
  // Prefer live HTML for behavioral sandbox (true generated artifact).
  const art = html;

  // ── Behavioral cases from generated artifact ─────────────────────────────
  console.log('\n[2] Group course compact summary (screenshot case)');
  const group = sandboxFromHtml(art);
  group._setPayload({
    guest_name: 'Koa',
    guest_phone: '+34600',
    notes: 'secret-notes',
    date_from: '2026-07-27',
    date_to: '2026-07-31',
    payment_status: 'unpaid',
    components: {
      course: {
        course_id: 'c1',
        course_label: 'Curso Mañana',
        tier_key: '5_days',
        tier_label: '5 days',
        quantity: 1,
      },
    },
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '5_days', quantity: 1 }],
  });
  if (typeof group.schedulePortalRenderCreateIntentSummary === 'function') {
    group.schedulePortalRenderCreateIntentSummary();
  }
  const gText = Stext(group);
  const gHtml = S(group);
  ok('group retains Curso Mañana', /Curso Mañana/.test(gText), gText);
  ok('group retains ×1', /×1|\u00d71/.test(gText), gText);
  ok('group retains Board and wetsuit', /Board and wetsuit/.test(gText), gText);
  ok('group retains single 5 days',
    (gText.match(/5 days/g) || []).length === 1, gText);
  ok('group retains Koa', /Koa/.test(gText), gText);
  ok('group omits Group course / Group Course',
    !/Group course/i.test(gText), gText);
  ok('group omits year 2026', stripYear(gText), gText);
  ok('group omits Unpaid / Paid payment status',
    !/\bUnpaid\b|\bPaid\b/.test(gText), gText);
  ok('group compact same-month date 27–31 Jul',
    /27\s*[–\-]\s*31\s*Jul/i.test(gText), gText);
  ok('group two-row hierarchy markup',
    /portal-schedule-create-summary-primary/.test(gHtml)
    && /portal-schedule-create-summary-secondary/.test(gHtml), gHtml);
  ok('group does not leak notes or phone',
    !/secret-notes|\+34600/.test(gText), gText);

  console.log('\n[3] No-lesson + six-day gear');
  const noLesson = sandboxFromHtml(art);
  noLesson._setPayload({
    guest_name: 'Bo',
    date_from: '2026-07-27',
    date_to: '2026-08-01',
    payment_status: 'unpaid',
    components: {},
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '6_days', quantity: 1 }],
  });
  if (typeof noLesson.schedulePortalRenderCreateIntentSummary === 'function') {
    noLesson.schedulePortalRenderCreateIntentSummary();
  }
  const nText = Stext(noLesson);
  ok('no-lesson retains No lesson', /No lesson/.test(nText), nText);
  ok('no-lesson retains gear label', /Board and wetsuit/.test(nText), nText);
  ok('no-lesson one duration only',
    (nText.match(/6 days/g) || []).length === 1, nText);
  ok('no-lesson compact cross-month date',
    /27\s*Jul\s*[–\-]\s*1\s*Aug/i.test(nText) || /27\s*Jul\s*[–\-]\s*01\s*Aug/i.test(nText),
    nText);
  ok('no-lesson omits year + Unpaid',
    stripYear(nText) && !/\bUnpaid\b/.test(nText), nText);

  console.log('\n[4] Compact date formatting (same-month + cross-month)');
  const dateCtx = sandboxFromHtml(art);
  if (typeof dateCtx.schedulePortalFormatCompactDateRange === 'function') {
    const same = dateCtx.schedulePortalFormatCompactDateRange('2026-07-27', '2026-07-31');
    const cross = dateCtx.schedulePortalFormatCompactDateRange('2026-07-30', '2026-08-02');
    const single = dateCtx.schedulePortalFormatCompactDateRange('2026-07-27', '2026-07-27');
    ok('same-month compact', /27\s*[–\-]\s*31\s*Jul/i.test(same) && !/2026/.test(same), same);
    ok('cross-month compact',
      /30\s*Jul\s*[–\-]\s*2\s*Aug/i.test(cross) && !/2026/.test(cross), cross);
    ok('single-day compact', /27\s*Jul/i.test(single) && !/2026/.test(single), single);
  } else {
    ok('same-month compact', false, 'schedulePortalFormatCompactDateRange missing');
    ok('cross-month compact', false, 'schedulePortalFormatCompactDateRange missing');
    ok('single-day compact', false, 'schedulePortalFormatCompactDateRange missing');
  }

  console.log('\n[5] Quote distinct row + exact server amount; stale drop');
  const quote = sandboxFromHtml(art, {
    payload: {
      guest_name: 'Ada',
      guest_phone: '+34999',
      date_from: '2026-07-27',
      date_to: '2026-07-31',
      payment_status: 'unpaid',
      components: {
        course: {
          course_id: 'c1', course_label: 'Curso Mañana', tier_key: '5_days',
          tier_label: '5 days', quantity: 1,
        },
      },
      rentals: [],
    },
  });
  if (typeof quote.schedulePortalRenderCreateIntentSummary === 'function') {
    quote.schedulePortalRenderCreateIntentSummary();
  }
  // Paint authoritative quote (server total_cents only).
  if (typeof quote.schedulePortalRenderCreateQuotePreview === 'function') {
    quote.schedulePortalQuoteState = {
      total_cents: 11500,
      intent_key: typeof quote.schedulePortalQuotePricingIntentKey === 'function'
        ? quote.schedulePortalQuotePricingIntentKey(quote.scheduleReadCreatePayload())
        : 'x',
      quote_provenance: { source: 't' },
    };
    quote.schedulePortalRenderCreateQuotePreview({
      ok: true,
      body: { success: true, total_cents: 11500 },
      intent_key: quote.schedulePortalQuoteState.intent_key,
    });
  }
  const qHtml = Q(quote);
  const qDisp = quote.el('ps-create-quote-preview').style.display;
  ok('quote row visible with exact €115.00',
    /Quoted total:\s*€115\.00/.test(qHtml.replace(/&nbsp;/g, ' '))
    && qDisp !== 'none',
    qHtml + ' display=' + qDisp);
  ok('quote not embedded inside summary',
    !/€115/.test(S(quote)) && /ps-create-quote-preview/.test(footer) === false
      ? !/Quoted total/.test(S(quote))
      : !/Quoted total/.test(S(quote)),
    S(quote));

  // Stale quote must disappear when pricing intent changes.
  quote.el('ps-create-quote-preview').innerHTML = 'Quoted total: €115.00';
  quote.el('ps-create-quote-preview').style.display = 'block';
  quote.schedulePortalQuoteState = {
    total_cents: 11500,
    intent_key: 'stale-intent',
  };
  quote._setPayload({
    guest_name: 'Ada',
    guest_phone: '+34999',
    date_from: '2026-07-28', // intent change
    date_to: '2026-07-31',
    payment_status: 'unpaid',
    components: {
      course: {
        course_id: 'c1', course_label: 'Curso Mañana', tier_key: '4_days',
        tier_label: '4 days', quantity: 1,
      },
    },
    rentals: [],
  });
  if (typeof quote.schedulePortalSyncCreateFooter === 'function') {
    quote.schedulePortalSyncCreateFooter({ quote: false });
  } else if (typeof quote.schedulePortalDropStaleQuoteUi === 'function') {
    quote.schedulePortalDropStaleQuoteUi(quote.scheduleReadCreatePayload());
  }
  ok('stale quote cleared on pricing intent change',
    !/€115/.test(Q(quote))
    && (quote.el('ps-create-quote-preview').style.display === 'none'
      || !String(quote.el('ps-create-quote-preview').innerHTML || '').trim()),
    Q(quote));

  console.log('\n[6] Custom line labels preserved');
  const custom = sandboxFromHtml(art);
  custom._setPayload({
    guest_name: 'Kim',
    date_from: '2026-07-27',
    date_to: '2026-07-27',
    payment_status: 'paid',
    components: {},
    rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
    custom_line_items: [{ client_line_id: 'a', label: 'Wax pack', amount_cents: 500 }],
  });
  if (typeof custom.schedulePortalRenderCreateIntentSummary === 'function') {
    custom.schedulePortalRenderCreateIntentSummary();
  }
  const cText = Stext(custom);
  ok('custom line label in summary', /Wax pack/.test(cText), cText);
  ok('custom still omits Paid', !/\bPaid\b/.test(cText), cText);

  console.log('\n[7] EN / ES / IT labels + locale date');
  const enC = sandboxFromHtml(art, { locale: 'en' });
  enC._setPayload({
    guest_name: '',
    date_from: '2026-07-27',
    date_to: '2026-07-31',
    payment_status: 'unpaid',
    components: {},
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '5_days', quantity: 1 }],
  });
  if (typeof enC.schedulePortalRenderCreateIntentSummary === 'function') {
    enC.schedulePortalRenderCreateIntentSummary();
  }
  ok('EN No lesson label', /No lesson/.test(Stext(enC)), Stext(enC));

  const esC = sandboxFromHtml(art, { locale: 'es', T: T_ES });
  esC._setPayload({
    guest_name: '',
    date_from: '2026-07-27',
    date_to: '2026-07-31',
    payment_status: 'unpaid',
    components: {},
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '5_days', quantity: 1 }],
  });
  if (typeof esC.schedulePortalRenderCreateIntentSummary === 'function') {
    esC.schedulePortalRenderCreateIntentSummary();
  }
  const esText = Stext(esC);
  ok('ES Sin clase label', /Sin clase/.test(esText), esText);
  ok('ES gear label', /Tabla y traje/.test(esText), esText);
  ok('ES no year', stripYear(esText), esText);
  // Month may be "jul" / "Jul" depending on Intl; just require day range without year.
  ok('ES compact date days present', /27/.test(esText) && /31/.test(esText), esText);

  const itC = sandboxFromHtml(art, { locale: 'it', T: T_IT });
  itC._setPayload({
    guest_name: '',
    date_from: '2026-07-27',
    date_to: '2026-07-31',
    payment_status: 'unpaid',
    components: {},
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '5_days', quantity: 1 }],
  });
  if (typeof itC.schedulePortalRenderCreateIntentSummary === 'function') {
    itC.schedulePortalRenderCreateIntentSummary();
  }
  ok('IT Nessuna lezione label', /Nessuna lezione/.test(Stext(itC)), Stext(itC));

  // i18n dictionary still has type labels (used when course name missing).
  const en = STAFF_PORTAL_STRINGS.en || {};
  const it = STAFF_PORTAL_STRINGS.it || {};
  const es = esSunset || STAFF_PORTAL_STRINGS.es || {};
  ok('i18n type labels EN/ES/IT present',
    !!(en['schedule.type.course'] && en['schedule.type.noLesson']
      && (es['schedule.type.course'] || esSunset['schedule.type.course'])
      && it['schedule.type.course'] && it['schedule.type.noLesson']));
  ok('quoteTotal i18n EN/ES/IT',
    !!(en['schedule.create.quoteTotal']
      && (es['schedule.create.quoteTotal'] || esSunset['schedule.create.quoteTotal'])
      && it['schedule.create.quoteTotal']));

  // Fallback when course name missing: still show localized Group course.
  const bare = sandboxFromHtml(art, {
    courseOptions: [],
  });
  bare._setPayload({
    guest_name: '',
    date_from: '2026-07-27',
    date_to: '2026-07-27',
    payment_status: 'unpaid',
    components: { course: { course_id: 'c1', tier_key: '5_days', quantity: 1 } },
    rentals: [],
  });
  bare.el('ps-create-course-select').options = [];
  bare.el('ps-create-course-select').selectedIndex = -1;
  if (typeof bare.schedulePortalRenderCreateIntentSummary === 'function') {
    bare.schedulePortalRenderCreateIntentSummary();
  }
  ok('bare course falls back to Group course (no key leak)',
    /Group course/.test(Stext(bare)) && !/\bc1\b|5_days/.test(Stext(bare)),
    Stext(bare));

  console.log('\n[8] Hostile: no client-side money math in summary owner');
  const sumFn = extractFn(html, 'schedulePortalRenderCreateIntentSummary')
    || extractFn(portalSrc, 'schedulePortalRenderCreateIntentSummary')
    || '';
  ok('summary owner never totals amount_cents',
    !/amount_cents|total_cents|sumCents|reduce\(/.test(sumFn));
  const quoteFn = extractFn(html, 'schedulePortalRenderCreateQuotePreview')
    || extractFn(portalSrc, 'schedulePortalRenderCreateQuotePreview')
    || '';
  ok('quote preview still uses strict total cents',
    /schedulePortalStrictQuoteTotalCents/.test(quoteFn));

  if (fail) {
    console.error('\nFAILED pass=' + pass + ' fail=' + fail + '\n');
    process.exit(1);
  }
  console.log('\nverify:sunset-create-footer-mobile-compact — ALL CHECKS PASSED (pass=' + pass + ')\n');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
