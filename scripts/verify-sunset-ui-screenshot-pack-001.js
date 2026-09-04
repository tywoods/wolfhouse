'use strict';

/**
 * SUNSET-UI-SCREENSHOT-PACK-001
 * Pack-only chrome from Ty screenshots. Stay off inbox-thread.js.
 *
 * 1 Monthly Horario: no hour timeline
 * 2 Guest card: no Recent messages
 * 3 Guest card: Add Tags: + opens picker
 * 4 Light: soft Salt/Sand tokens (no new palette names)
 * 5 Remove Gmail grey/disabled when not connected
 * 7 Finance Year chart X = months
 * 8 Spots available copy, right-align, no € left on table
 * 10 Drop "Where the money's coming from" + "Aged by last service date"
 * 12 Luna Staff: no ACA additive banner
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const cockpitSrc = read('scripts/browser/sunset-schedule-day-cockpit-ui.js');
const inboxSrc = read('scripts/browser/inbox-context.js');
const financeSrc = read('scripts/browser/sunset-admin-finance-redesign-ui.js');
const emailSrc = read('scripts/browser/sunset-admin-email-settings-ui.js');
const lunaSrc = read('scripts/browser/sunset-admin-luna-runtime-status.js');
const threadSrc = read('scripts/browser/inbox-thread.js');
const i18nEn = read('scripts/lib/staff-portal-i18n.js');
const i18nEs = read('scripts/lib/staff-portal-i18n-es-sunset.js');

assert.ok(!threadSrc.includes('inbox-guest-tags-add'), 'inbox-thread.js has no Add Tags chrome');
assert.ok(!threadSrc.includes('pfb-callout--spots'), 'inbox-thread.js has no finance spots chrome');
assert.ok(!threadSrc.includes('paintSunsetLunaRuntimeStatus'), 'inbox-thread.js has no Luna Staff painter');

// 1 — Monthly Horario has no hour timeline
assert.ok(
  /rangeKey === 'next30'[\s\S]{0,400}ck-hours/.test(cockpitSrc) === false
    || /if \(rangeKey === 'next30'\) \{[\s\S]{0,200}(?!ck-hours)/.test(cockpitSrc),
  'monthly path is present'
);
const cockpit = require(path.join(ROOT, 'scripts/browser/sunset-schedule-day-cockpit-ui.js'));
function fakeMount() {
  function el(tag) {
    const n = {
      tagName: String(tag || 'DIV').toUpperCase(),
      className: '',
      children: [],
      style: { setProperty() {} },
      attributes: Object.create(null),
      _text: '',
      type: '',
      title: '',
      parentNode: null,
      ownerDocument: null,
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k] || null; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      addEventListener() {},
      querySelectorAll(sel) {
        const out = [];
        const walk = (node) => {
          const cls = ' ' + String(node.className || '') + ' ';
          if (sel.startsWith('.') && cls.includes(' ' + sel.slice(1) + ' ')) out.push(node);
          (node.children || []).forEach(walk);
        };
        walk(this);
        return out;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    };
    Object.defineProperty(n, 'textContent', {
      get() {
        if (!this.children.length) return this._text;
        return this.children.map((c) => c.textContent).join('');
      },
      set(v) { this.children.length = 0; this._text = v == null ? '' : String(v); },
    });
    n.classList = { add(c) { this._n.className = (this._n.className + ' ' + c).trim(); }, _n: n };
    return n;
  }
  const mount = el('div');
  mount.ownerDocument = {
    createElement(tag) { const n = el(tag); n.ownerDocument = this; return n; },
    createTextNode(t) { const n = el('#text'); n.textContent = t; return n; },
  };
  mount.appendChild = function (c) { c.parentNode = this; this.children.push(c); return c; };
  return mount;
}
const monthlyMount = fakeMount();
cockpit.scheduleRenderDayCockpit(monthlyMount, {
  date: '2026-09-04',
  range: 'next30',
  venue: 'Somo',
  sessions: [
    { id: 'manana', name: 'Mañana', start: '10:00', end: '12:00', booked: 4, capacity: 8 },
    { id: 'tarde', name: 'Tarde', start: '16:00', end: '18:00', booked: 2, capacity: 8 },
  ],
  now: 12 * 60 + 30,
});
assert.strictEqual(monthlyMount.querySelectorAll('.ck-hours').length, 0, 'monthly has no hour labels');
assert.strictEqual(monthlyMount.querySelectorAll('.ck-needle').length, 0, 'monthly has no hour needle');
assert.strictEqual(monthlyMount.querySelectorAll('.ck-ribbon').length, 0, 'monthly has no hour ribbon');

const dailyMount = fakeMount();
cockpit.scheduleRenderDayCockpit(dailyMount, {
  date: '2026-09-04',
  range: 'today',
  venue: 'Somo',
  sessions: [
    { id: 'manana', name: 'Mañana', start: '10:00', end: '12:00', booked: 4, capacity: 8 },
  ],
  now: 11 * 60,
});
assert.ok(dailyMount.querySelectorAll('.ck-hours').length >= 1, 'daily still has hour labels');
assert.ok(dailyMount.querySelectorAll('.ck-ribbon').length >= 1, 'daily still has ribbon');

// 2 — Guest card drops Recent messages
assert.ok(!/collapse\(inboxContextT\('customers\.detail\.messages'/.test(inboxSrc), 'full card does not collapse Recent messages');
assert.ok(!/inboxContextT\('customers\.detail\.messages',\s*'Recent messages'\)/.test(inboxSrc)
  || !/html \+= collapse\(inboxContextT\('customers\.detail\.messages'/.test(inboxSrc),
  'Recent messages section not appended');

// 3 — Add Tags: + opens picker
assert.ok(inboxSrc.includes('Add Tags:'), 'Add Tags: label');
assert.ok(inboxSrc.includes('inbox-guest-tags-add'), '+ control class');
assert.ok(/inbox-guest-tags-add[\s\S]{0,80}\+/.test(inboxSrc) || inboxSrc.includes('>+</span>') || inboxSrc.includes('>+</button>'), '+ glyph');
assert.ok(inboxSrc.includes('id="inbox-guest-tags-open"'), 'existing picker open id kept');

// 4 — Light Salt/Sand, no new palette names
assert.ok(!/Foam|Sol\b|Kelp|Ember/.test(cockpitSrc), 'cockpit no new palette names');
assert.ok(!/Foam|Sol\b|Kelp|Ember/.test(financeSrc), 'finance no new palette names');
assert.ok(
  /html:not\(\[data-theme="dark"\]\) \.cockpit/.test(cockpitSrc)
    && cockpitSrc.includes('--ck-surface:var(--surface)'),
  'light cockpit surfaces follow Salt/Sand --surface'
);

// 5 — Remove Gmail disabled / grey when not connected
assert.ok(emailSrc.includes('adminEmailComingCardHtml'), 'coming card still exists');
assert.ok(
  /data-email-state="coming"[\s\S]*disabled/.test(emailSrc),
  'coming Gmail/IMAP action is disabled'
);
assert.ok(
  emailSrc.includes("gmailRemoveDisabled") || /provider === 'gmail_api'[\s\S]{0,800}disabled/.test(emailSrc),
  'Gmail Remove/Disconnect is disabled when not connected'
);

// 7 / 8 / 10 — Finance
const { renderFinanceRedesignHtml } = require(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'));
const yearSummary = {
  redesign: {
    view: { granularity: 'year', anchor: '2026-09-04', range: { start: '2026-01-01', end: '2026-12-31' } },
    net: { gross_collected_cents: 100000, vs_prior_pct: 0, vs_yoy_pct: 0 },
    pipeline: { booked_cents: 200000, bookings_count: 3, avg_booking_cents: 66666, next_30_days_cents: 0, delivered_unpaid_cents: 0, vs_prior_pct: 0, vs_yoy_pct: 0 },
    outstanding: { outstanding_cents: 0, bookings_count: 0, due_soon_cents: 0, overdue_cents: 0 },
    revenue_by_product: [{ key: 'lessons', slot: 'lessons', label: 'Lessons', cents: 200000, pct: 100 }],
    capacity: { seats_pct: 40, seats_filled: 4, seats_capacity: 10, unsold_seats: 6, left_on_table_cents: 99900, by_product: [] },
    monthly_gross_trend: [
      { month: 1, booked_cents: 10000, ly_booked_cents: 8000, collected_gross_cents: 10000, ly_collected_gross_cents: 8000 },
      { month: 2, booked_cents: 20000, ly_booked_cents: 9000, collected_gross_cents: 20000, ly_collected_gross_cents: 9000 },
    ],
    daily_gross_trend: [
      { date: '2026-09-01', collected_gross_cents: 111, ly_collected_gross_cents: 50 },
      { date: '2026-09-02', collected_gross_cents: 222, ly_collected_gross_cents: 60 },
    ],
  },
};
global.window = { __financeTrendMode: 'days' };
const yearHtml = renderFinanceRedesignHtml(yearSummary);
assert.ok(/data-finance-trend-mode="year"/.test(yearHtml), 'Year period paints monthly chart even if leftover days mode');
assert.ok(/pfb-trend-day--month/.test(yearHtml), 'year bars are month columns');
assert.ok(/Jan|Feb/.test(yearHtml), 'year X labels are month names');
assert.ok(!/>1</.test(yearHtml) || /Jan/.test(yearHtml), 'year X is not day-of-month only');
assert.ok(/6 spots available (this year|year)/.test(yearHtml), 'year spots copy');
assert.ok(!/left on the table/.test(yearHtml), 'no € left on the table');
assert.ok(!/Where the money/.test(yearHtml), 'no Where the money\'s coming from');
assert.ok(!/Aged by last service date/.test(yearHtml), 'no Aged by last service date');
assert.ok(/pfb-callout--spots|text-align:right|justify-content:flex-end/.test(financeSrc + yearHtml), 'spots right-aligned');

const monthSummary = JSON.parse(JSON.stringify(yearSummary));
monthSummary.redesign.view.granularity = 'month';
global.window = { __financeTrendMode: 'days' };
const monthHtml = renderFinanceRedesignHtml(monthSummary);
assert.ok(/6 spots available (this month|month)/.test(monthHtml), 'month spots copy');

const daySummary = JSON.parse(JSON.stringify(yearSummary));
daySummary.redesign.view.granularity = 'day';
const dayHtml = renderFinanceRedesignHtml(daySummary);
assert.ok(/6 spots available today/.test(dayHtml), 'day spots copy');

assert.ok(i18nEn.includes('spots available') || financeSrc.includes('spots available'), 'EN spots copy exists');
assert.ok(i18nEs.includes('plazas disponibles') || financeSrc.includes('plazas disponibles'), 'ES spots copy exists');

// 12 — ACA additive banner gone
assert.ok(
  !lunaSrc.includes('The new Luna ACA runtime is additive and not live for guests.')
    || /function paintSunsetLunaRuntimeStatus[\s\S]+return;/.test(lunaSrc),
  'additive banner copy removed or paint is a no-op'
);
function paintLuna(opts) {
  const wrap = { html: '', innerHTML: '', insertAdjacentHTML(pos, html) { this.html = String(html) + this.html; this.innerHTML = this.html; } };
  let card = null;
  const sandbox = {
    portalLang: opts.lang || 'en',
    portalT(key) { return key; },
    getClient() { return opts.client; },
    escHtml(s) { return String(s == null ? '' : s); },
    el(id) { return id === 'al-wrap' ? wrap : null; },
    document: {
      documentElement: { getAttribute(name) { return name === 'data-portal-client' ? opts.portalClient : null; } },
      head: { appendChild() {} },
      createElement() { return { id: '', textContent: '' }; },
      getElementById(id) {
        if (id === 'al-wrap') return wrap;
        if (id === 'sunset-luna-runtime-status') return card;
        return null;
      },
    },
  };
  vm.runInNewContext(lunaSrc, sandbox);
  sandbox.paintSunsetLunaRuntimeStatus();
  return wrap.html;
}
const painted = paintLuna({ portalClient: 'sunset', client: 'sunset', lang: 'en' });
assert.ok(!/additive and not live/.test(painted), 'sunset Luna Staff does not paint ACA additive banner');
assert.ok(!/data-sunset-luna-runtime="1"/.test(painted), 'runtime status card not inserted');

console.log('PASS SUNSET-UI-SCREENSHOT-PACK-001');
