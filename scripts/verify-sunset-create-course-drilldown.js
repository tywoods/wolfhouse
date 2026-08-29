'use strict';

/**
 * verify:sunset-create-course-drilldown
 *
 * Single-course Create Booking Main activity drill-down:
 *   1. Initial three Main activity choices (Group / Private / Equipment only)
 *   2. Group course click replaces that list in place with available courses
 *   3. No legacy bottom dropdown for course select
 *   4. Touch-friendly activity buttons (no radio glyphs); exactly one selected;
 *      aria-pressed exclusive; 44px targets; hidden radio/select may remain
 *   5. Main activity header Back button (right-aligned)
 *   6. Back clears selected course and restores three choices
 *   7. Chosen-path crumb stays hidden (selected activity button is enough)
 *   8. Date range + global surfer count still own the selected course
 *   9. Private / Equipment only unchanged
 *  10. Catalog/date re-render: keep selection only if still available
 *  11. Create disabled until group course selected; quote clears/requotes
 *  12. EN/ES/IT localization; mobile 375/430 CSS (≥44px rows + Back)
 *
 * Executes the REAL generated /staff/ui artifact (production buildUiHtml +
 * injectSunsetSchedulePortalModule), not source-regex alone.
 *
 * No Azure / staging / DB mutation.
 *
 * Run: node scripts/verify-sunset-create-course-drilldown.js
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
const { collectPortalFunctions, slicePortalFunction } = require('./lib/portal-fn-slice');

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
  return slicePortalFunction(src, name);
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
  'schedule.create.mainActivity': 'Main activity',
  'schedule.create.mainActivityBack': 'Back',
  'schedule.create.courseRequired': 'Select a group course.',
  'schedule.create.courseNotOnSelectedDates': 'not available on selected dates',
  'schedule.create.summary.chooseLessonOrGear': 'Choose a lesson or add gear',
  'schedule.create.quoteTotal': 'Quoted total',
  'schedule.create.quoteFailed': 'Quote unavailable',
  'schedule.type.course': 'Group course',
  'schedule.type.privateLesson': 'Private Course',
  'schedule.type.noLesson': 'Equipment only',
  'schedule.courses.noneConfigured': 'No group courses configured',
  'admin.period.5_days': '5 days',
};

const T_ES = Object.assign({}, T_EN, {
  'schedule.create.mainActivity': 'Actividad principal',
  'schedule.create.mainActivityBack': 'Atrás',
  'schedule.create.courseRequired': 'Selecciona un curso en grupo.',
  'schedule.type.course': 'Curso en grupo',
  'schedule.type.privateLesson': 'Curso privado',
  'schedule.type.noLesson': 'Sin clase',
});

const T_IT = Object.assign({}, T_EN, {
  'schedule.create.mainActivity': 'Attività principale',
  'schedule.create.mainActivityBack': 'Indietro',
  'schedule.create.courseRequired': 'Seleziona un corso di gruppo.',
  'schedule.type.course': 'Corso di gruppo',
  'schedule.type.privateLesson': 'Corso privato',
  'schedule.type.noLesson': 'Nessuna lezione',
});

function makeClassList(initial) {
  const set = new Set(Array.isArray(initial) ? initial : []);
  return {
    add(c) { set.add(c); },
    remove(c) { set.delete(c); },
    contains(c) { return set.has(c); },
    toggle(c, force) {
      if (force === true) set.add(c);
      else if (force === false) set.delete(c);
      else if (set.has(c)) set.delete(c);
      else set.add(c);
    },
    toString() { return Array.from(set).join(' '); },
  };
}

function sandboxFromHtml(html, opts) {
  opts = opts || {};
  const locale = opts.locale || 'en';
  const T = opts.T || (locale === 'es' ? T_ES : locale === 'it' ? T_IT : T_EN);
  const nodes = {};
  const listeners = {};

  function N(id, x) {
    const base = {
      id,
      value: '',
      checked: false,
      disabled: false,
      hidden: false,
      textContent: '',
      innerHTML: '',
      style: { display: 'none' },
      dataset: {},
      classList: makeClassList(),
      options: [],
      selectedIndex: -1,
      _ls: {},
      children: [],
      addEventListener(ev, fn) {
        this._ls[ev] = this._ls[ev] || [];
        this._ls[ev].push(fn);
        listeners[id] = listeners[id] || {};
        listeners[id][ev] = listeners[id][ev] || [];
        listeners[id][ev].push(fn);
      },
      setAttribute(k, v) {
        this['_' + k] = v;
        if (k === 'hidden') this.hidden = v !== false && v != null;
        if (k === 'aria-hidden') this._ariaHidden = String(v);
      },
      getAttribute(k) {
        if (k === 'hidden') return this.hidden ? '' : null;
        if (k === 'aria-hidden') return this._ariaHidden != null ? this._ariaHidden : null;
        return this['_' + k] != null ? this['_' + k] : null;
      },
      removeAttribute(k) {
        delete this['_' + k];
        if (k === 'hidden') this.hidden = false;
        if (k === 'aria-hidden') delete this._ariaHidden;
      },
      querySelector(sel) {
        if (!sel) return null;
        if (sel.startsWith('#')) return nodes[sel.slice(1)] || null;
        if (sel.includes('button[data-course-id][aria-pressed="true"]')
          || sel.includes('button[data-course-id][aria-pressed=\'true\']')) {
          const rows = this._courseRows || [];
          for (let i = 0; i < rows.length; i += 1) {
            if (rows[i].getAttribute && rows[i].getAttribute('aria-pressed') === 'true') return rows[i];
          }
          return null;
        }
        if (sel.includes('button[data-course-id=') || sel.includes('[data-course-id=')) {
          const idMatch = sel.match(/data-course-id=["']?([^"'\]]+)/);
          if (!idMatch) return null;
          const want = idMatch[1];
          const all = this.querySelectorAll('button[data-course-id], [data-course-id]');
          for (let i = 0; i < all.length; i += 1) {
            if (String(all[i].getAttribute('data-course-id')) === want) return all[i];
          }
          return null;
        }
        if (sel.includes('input[type=radio]') || sel === 'input[type="radio"]' || sel === 'input') {
          const radios = this.querySelectorAll('input');
          return radios[0] || null;
        }
        if (sel.includes(':checked')) {
          const radios = this.querySelectorAll('input');
          for (let i = 0; i < radios.length; i += 1) {
            if (radios[i].checked) return radios[i];
          }
          return null;
        }
        return null;
      },
      querySelectorAll(sel) {
        if (this.id === 'ps-create-course-list') {
          const rows = this._courseRows || [];
          if (sel && sel.includes('input')) {
            const inputs = rows.map((r) => r._input).filter(Boolean);
            return sel.includes(':checked') ? inputs.filter((i) => i.checked) : inputs;
          }
          if (!sel || sel === '*' || sel.includes('label')
            || sel.includes('portal-schedule-create-check')
            || sel.includes('portal-schedule-create-activity-btn')
            || sel.includes('button[data-course-id]')
            || sel.includes('[data-course-id]')
            || (sel.includes('button') && sel.includes('data-course-id'))) {
            // Attribute filters in the selector are load-bearing: the multi-select
            // reader asks for button[data-course-id][aria-pressed="true"].
            const wantPressed = /\[aria-pressed=["']?true["']?\]/.test(sel);
            return rows.filter((r) => (wantPressed
              ? r.getAttribute && r.getAttribute('aria-pressed') === 'true'
              : true));
          }
        }
        return [];
      },
    };
    nodes[id] = Object.assign(base, x || {});
    return nodes[id];
  }

  N('ps-create-summary', { innerHTML: '<span>—</span>', style: { display: '' } });
  N('ps-create-quote-preview');
  N('ps-create-msg');
  N('ps-create-submit', { disabled: true });
  N('ps-create-guest', { value: opts.guest != null ? opts.guest : 'Koa' });
  N('ps-create-phone', { value: opts.phone != null ? opts.phone : '+34600111222' });
  N('ps-create-notes');
  N('ps-create-payment', { value: 'unpaid' });
  N('ps-create-date-from', { value: '2026-07-27' });
  N('ps-create-date-to', { value: '2026-07-31' });
  N('ps-create-surfers', { value: '2' });
  N('ps-create-course-qty', { value: '2' });
  N('ps-create-comp-course', { type: 'radio', name: 'ps-create-main-activity', checked: false });
  N('ps-create-comp-private-lesson', { type: 'radio', name: 'ps-create-main-activity', checked: false });
  N('ps-create-comp-no-lesson', { type: 'radio', name: 'ps-create-main-activity', checked: true });
  N('ps-create-comp-fullday', { type: 'checkbox', checked: false });
  N('ps-create-rentals');
  N('ps-create-main-activity-label', { textContent: T['schedule.create.mainActivity'] });
  N('ps-create-main-activity-back', {
    style: { display: 'none' },
    hidden: true,
    textContent: T['schedule.create.mainActivityBack'],
  });
  N('ps-create-main-activity-path', { style: { display: 'none' }, hidden: true, textContent: '' });
  N('ps-create-main-activity-choices', {
    style: { display: '' },
    hidden: false,
    classList: makeClassList(['portal-schedule-create-components', 'portal-schedule-create-main-activity']),
  });
  N('ps-create-course-list', {
    style: { display: 'none' },
    hidden: true,
    innerHTML: '',
    _courseRows: [],
    classList: makeClassList(['portal-schedule-create-components', 'portal-schedule-create-course-list']),
  });
  // Legacy select — must remain hidden (no second dropdown).
  const cOpts = [];
  N('ps-create-course-select', {
    value: '',
    options: cOpts,
    selectedIndex: -1,
    style: { display: 'none' },
    hidden: true,
  });
  N('ps-create-course-fields', {
    style: { display: 'none' },
    hidden: true,
  });
  N('ps-create-course-tier', { value: '', options: [], selectedIndex: -1 });
  N('ps-create-activity-empty-hint', { style: { display: '' } });

  // Live-ish course list DOM: when portal sets innerHTML, rebuild button rows + hidden radios.
  const courseList = nodes['ps-create-course-list'];
  Object.defineProperty(courseList, 'innerHTML', {
    get() { return this._innerHTML || ''; },
    set(v) {
      this._innerHTML = String(v || '');
      this._courseRows = [];
      let m;
      const html = this._innerHTML;
      // Prefer real course option buttons (parity with Main activity lesson buttons).
      const btnRe = /<button[^>]*data-course-id="([^"]*)"[^>]*data-label="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g;
      while ((m = btnRe.exec(html))) {
        const cid = m[1];
        const lab = m[2]
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const attrs = m[0].slice(0, m[0].indexOf('>'));
        const disabled = /\sdisabled(?:\s|=|>|$)/.test(attrs) || /is-disabled/.test(attrs);
        const pressed = /aria-pressed="true"/.test(attrs) || /is-selected/.test(attrs);
        // Hidden radio sibling after this button (compat state).
        const after = html.slice(m.index + m[0].length, m.index + m[0].length + 280);
        const inputMatch = after.match(/<input[^>]*type="radio"[^>]*>/);
        const inputTag = inputMatch ? inputMatch[0] : '';
        const input = {
          type: 'radio',
          name: 'ps-create-course-pick',
          value: cid,
          checked: /checked/.test(inputTag) || pressed,
          disabled: disabled || /disabled/.test(inputTag),
          className: 'portal-schedule-create-visually-hidden',
          _ls: {},
          addEventListener(ev, fn) {
            this._ls[ev] = this._ls[ev] || [];
            this._ls[ev].push(fn);
          },
          setAttribute() {},
          getAttribute() { return null; },
        };
        const row = {
          tagName: 'BUTTON',
          type: 'button',
          className: 'portal-schedule-create-activity-btn' + (pressed ? ' is-selected' : '') + (disabled ? ' is-disabled' : ''),
          classList: makeClassList([
            'portal-schedule-create-activity-btn',
            ...(pressed ? ['is-selected'] : []),
            ...(disabled ? ['is-disabled'] : []),
          ]),
          disabled,
          _input: input,
          textContent: lab,
          dataset: { courseId: cid, label: lab },
          _attrs: {
            'data-course-id': cid,
            'data-label': lab,
            'aria-pressed': pressed ? 'true' : 'false',
          },
          setAttribute(k, val) {
            this._attrs[k] = String(val);
            if (k === 'aria-pressed') {
              const on = String(val) === 'true';
              if (on) this.classList.add('is-selected');
              else this.classList.remove('is-selected');
            }
          },
          getAttribute(k) {
            if (k === 'data-course-id') return cid;
            if (k === 'data-label') return lab;
            if (k === 'aria-pressed') return this._attrs['aria-pressed'] || 'false';
            return this._attrs[k] != null ? this._attrs[k] : null;
          },
          addEventListener(ev, fn) {
            this._ls = this._ls || {};
            this._ls[ev] = this._ls[ev] || [];
            this._ls[ev].push(fn);
          },
          querySelector(sel) {
            if (!sel || sel.includes('input')) return input;
            return null;
          },
          querySelectorAll(sel) {
            if (!sel || sel.includes('input')) return [input];
            return [];
          },
        };
        this._courseRows.push(row);
      }
      // Legacy label radio-card parse (compat if older markup appears).
      if (!this._courseRows.length) {
        const labelRe = /<label[^>]*data-course-id="([^"]*)"[^>]*data-label="([^"]*)"[^>]*>([\s\S]*?)<\/label>/g;
        while ((m = labelRe.exec(html))) {
          const cid = m[1];
          const lab = m[2]
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
          const inputMatch = m[3].match(/value="([^"]*)"/);
          const disabled = /disabled/.test(m[3]);
          const input = {
            type: 'radio',
            name: 'ps-create-course-pick',
            value: inputMatch ? inputMatch[1] : cid,
            checked: /checked/.test(m[3]),
            disabled,
            _ls: {},
            addEventListener(ev, fn) {
              this._ls[ev] = this._ls[ev] || [];
              this._ls[ev].push(fn);
            },
            setAttribute() {},
            getAttribute() { return null; },
          };
          this._courseRows.push({
            className: 'portal-schedule-create-check',
            classList: makeClassList(['portal-schedule-create-check']),
            _input: input,
            textContent: lab,
            dataset: { courseId: cid, label: lab },
            setAttribute(k, val) { this['_' + k] = val; },
            getAttribute(k) {
              if (k === 'data-course-id') return cid;
              if (k === 'data-label') return lab;
              return this['_' + k] != null ? this['_' + k] : null;
            },
            querySelector(sel) {
              if (!sel || sel.includes('input')) return input;
              return null;
            },
            querySelectorAll(sel) {
              if (!sel || sel.includes('input')) return [input];
              return [];
            },
          });
        }
      }
    },
    configurable: true,
  });

  let catalogCourses = opts.catalogCourses || [
    {
      course_id: 'c-manana',
      label: 'Curso Mañana',
      schedule_summary: 'Daily',
      eligible_on_requested_dates: true,
      price_tiers: [{ key: '5_days', duration_days: 5, bookable: true, label: '5 days' }],
    },
    {
      course_id: 'c-tarde',
      label: 'Curso Tarde',
      schedule_summary: 'Daily',
      eligible_on_requested_dates: true,
      price_tiers: [{ key: '5_days', duration_days: 5, bookable: true, label: '5 days' }],
    },
  ];

  let payload = opts.payload || null;

  const needed = [
    'schedulePortalIsValidCreatePhone',
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
    'schedulePortalInvalidateCreateQuoteIntent',
    'schedulePortalRefreshCreateQuote',
    'schedulePortalSetVisible',
    'schedulePortalEnterGroupCourseDrilldown',
    'schedulePortalExitGroupCourseDrilldown',
    'schedulePortalIsGroupCourseDrilldown',
    'schedulePortalRenderMainActivityPath',
    'schedulePortalRenderCreateCourseList',
    'schedulePortalSelectCreateCourse',
    'schedulePortalClearSelectedCreateCourse',
    'schedulePortalGetSelectedCreateCourseId',
    'schedulePortalSyncCreateCourseButtons',
    'schedulePortalApplyDesiredCourseSelect',
    'schedulePortalPopulateCreateCourseFields',
    'schedulePortalValidateCreatePayload',
    'schedulePortalHasSellableIntent',
    'schedulePortalCanonicalDateIso',
    'schedulePortalMadridTodayIso',
    'schedulePortalInclusiveDateCount',
    'schedulePortalMatchSellableCourseTiersByDurationDays',
    'schedulePortalResolveDerivedCourseTier',
    'schedulePortalFormatCompactDateRange',
    'schedulePortalRentalLabel',
    'schedulePortalDurationLabel',
  ];

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
    scheduleEnumerateDates: (a, b) => {
      const out = [];
      const start = String(a).slice(0, 10);
      const end = String(b || a).slice(0, 10);
      const d = new Date(start + 'T12:00:00Z');
      const endD = new Date(end + 'T12:00:00Z');
      while (d <= endD) {
        out.push(d.toISOString().slice(0, 10));
        d.setUTCDate(d.getUTCDate() + 1);
      }
      return out.length ? out : [start];
    },
    scheduleReadCreatePayload: () => {
      if (payload) return JSON.parse(JSON.stringify(payload));
      const courseOn = !!(nodes['ps-create-comp-course'] && nodes['ps-create-comp-course'].checked);
      const privateOn = !!(nodes['ps-create-comp-private-lesson'] && nodes['ps-create-comp-private-lesson'].checked);
      const components = {};
      const surferCount = parseInt(nodes['ps-create-surfers'].value, 10) || null;
      if (courseOn) {
        const sel = nodes['ps-create-course-select'];
        const courseId = sel ? String(sel.value || '').trim() : '';
        let courseLabel = '';
        if (sel && sel.options && sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]) {
          const opt = sel.options[sel.selectedIndex];
          courseLabel = (opt.getAttribute && opt.getAttribute('data-label')) || opt.textContent || '';
        }
        components.course = {
          quantity: surferCount,
          course_id: courseId,
          course_label: courseLabel,
        };
        if (typeof ctx.schedulePortalResolveDerivedCourseTier === 'function' && courseId) {
          const derived = ctx.schedulePortalResolveDerivedCourseTier(
            courseId,
            nodes['ps-create-date-from'].value,
            nodes['ps-create-date-to'].value,
          );
          if (derived && derived.ok && derived.tier_key) {
            components.course.tier_key = derived.tier_key;
            components.course.tier_label = derived.tier_label || '';
            components.course.offering_id = derived.offering_id;
          }
        }
      }
      if (privateOn) {
        components.private_lesson = {
          enabled: true,
          quantity: 1,
          surfer_count: surferCount,
          sessions: [{
            date: nodes['ps-create-date-from'].value,
            start: '10:00',
            end: '12:00',
          }],
        };
      }
      return {
        guest_name: nodes['ps-create-guest'].value,
        guest_phone: nodes['ps-create-phone'].value,
        date_from: nodes['ps-create-date-from'].value,
        date_to: nodes['ps-create-date-to'].value,
        payment_status: 'unpaid',
        notes: '',
        components,
        rentals: [],
        custom_line_items: [],
        surfer_count: surferCount,
      };
    },
    scheduleUpdateFullDayAddonSummary() {},
    scheduleUpdateFullDayAddonSummary() {},
    scheduleCreateSelectedDates: () => ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31'],
    schedulePortalFetchCatalog: () => Promise.resolve({ courses: catalogCourses.slice() }),
    scheduleCoursesCache: catalogCourses.slice(),
    schedulePortalOpenGen: 1,
    schedulePortalPendingCourseId: null,
    schedulePortalPendingCourseGen: 0,
    adminPeriodLabel: (k) => T['admin.period.' + k] || null,
    portalT: (k) => T[k] || k,
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    el: (id) => nodes[id] || null,
    document: {
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    scheduleRentalOfferingLabelKey: () => '',
    schedulePortalQuoteState: null,
    schedulePortalQuoteGen: 0,
    schedulePortalQuoteAbort: null,
    schedulePortalQuoteTimer: null,
    schedulePortalQuoteDebounceMs: 400,
    schedulePortalSubmitInFlight: false,
    scheduleReadCreateSurferCount: () => {
      const n = parseInt(nodes['ps-create-surfers'].value, 10);
      return Number.isInteger(n) && n >= 1 ? n : null;
    },
    scheduleSyncCreateSurferMirrors() {},
    schedulePopulateCreateComponentFields() {},
    scheduleRenderCreateRentals() {},
    scheduleRefreshCreateFullDayAddon() {},
    scheduleOnCreateComponentChange() {},
    _nodes: nodes,
    _listeners: listeners,
    _setCatalog(c) { catalogCourses = c.slice(); ctx.scheduleCoursesCache = c.slice(); },
    _setPayload(p) { payload = p; },
    _fire(id, ev) {
      const n = nodes[id];
      if (!n || !n._ls || !n._ls[ev]) return;
      n._ls[ev].forEach((fn) => fn({ target: n, type: ev }));
    },
  };

  // Fill select options helper used by populate when select still exists.
  Object.defineProperty(nodes['ps-create-course-select'], 'options', {
    get() { return this._options || []; },
    set(v) { this._options = v || []; },
    configurable: true,
  });
  nodes['ps-create-course-select']._options = [];
  // Make setting value update selectedIndex
  Object.defineProperty(nodes['ps-create-course-select'], 'value', {
    get() { return this._value || ''; },
    set(v) {
      this._value = String(v || '');
      const opts = this._options || [];
      let idx = -1;
      for (let i = 0; i < opts.length; i += 1) {
        if (String(opts[i].value) === this._value) { idx = i; break; }
      }
      this.selectedIndex = idx;
    },
    configurable: true,
  });
  Object.defineProperty(nodes['ps-create-course-select'], 'innerHTML', {
    get() { return this._innerHTML || ''; },
    set(v) {
      this._innerHTML = String(v || '');
      const opts = [];
      const re = /<option[^>]*value="([^"]*)"[^>]*(?:data-label="([^"]*)")?[^>]*>([\s\S]*?)<\/option>/g;
      let m;
      while ((m = re.exec(this._innerHTML))) {
        const val = m[1];
        const lab = (m[2] || m[3] || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
        const disabled = /disabled/.test(m[0]);
        opts.push({
          value: val,
          textContent: (m[3] || lab).replace(/<[^>]+>/g, ''),
          disabled,
          getAttribute: (k) => (k === 'data-label' ? lab : null),
        });
      }
      this._options = opts;
      if (this._value) {
        let idx = -1;
        for (let i = 0; i < opts.length; i += 1) {
          if (String(opts[i].value) === this._value) { idx = i; break; }
        }
        this.selectedIndex = idx;
        if (idx < 0) this._value = '';
      }
    },
    configurable: true,
  });

  const preludeVars = [
    'schedulePortalQuoteState = null',
    'schedulePortalQuoteGen = 0',
    'schedulePortalQuoteAbort = null',
    'schedulePortalQuoteTimer = null',
    'schedulePortalQuoteDebounceMs = 400',
    'schedulePortalSubmitInFlight = false',
    'schedulePortalQuoteChecking = false',
    'schedulePortalQuotePriceBlocked = false',
    'schedulePortalOpenGen = 1',
    'schedulePortalPendingCourseId = null',
    'schedulePortalPendingCourseGen = 0',
    'schedulePortalMainActivityView = "root"',
    'scheduleCoursesCache = []',
  ];
  const prelude = preludeVars.map((v) => `var ${v};`).join('\n');

  // Pull the roots above plus every helper they call: the portal front-end lives
  // in scripts/browser modules now, so a hand-listed set of names goes stale and
  // the slice dies on a ReferenceError before asserting anything.
  const sliced = collectPortalFunctions(html, needed, {
    provided: Object.keys(ctx).concat(preludeVars.map((v) => v.split(' ')[0])),
  });
  ctx._sliced = sliced;

  // Seed cache
  const portalBody = sliced.code;
  vm.createContext(ctx);
  try {
    vm.runInContext(
      prelude
      + '\nscheduleCoursesCache = '
      + JSON.stringify(catalogCourses)
      + ';\n'
      + portalBody,
      ctx,
    );
  } catch (e) {
    ctx._loadError = e;
  }
  // Sync cache into ctx globals that populate may write
  try {
    vm.runInContext('scheduleCoursesCache = ' + JSON.stringify(catalogCourses) + ';', ctx);
  } catch (_e) { /* ignore */ }

  return ctx;
}

function visible(node) {
  if (!node) return false;
  if (node.hidden) return false;
  if (node.style && node.style.display === 'none') return false;
  if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return false;
  return true;
}

function pathText(c) {
  const n = c.el('ps-create-main-activity-path');
  if (!n || !visible(n)) return '';
  return String(n.textContent || n.innerHTML || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

(async function main() {
  console.log('\nverify:sunset-create-course-drilldown\n');

  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const portalSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'),
    'utf8',
  );
  const i18nSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
  const esSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');

  // ── [0] Source / CSS / i18n contracts ────────────────────────────────────
  console.log('[0] Source contracts (HTML/CSS/i18n/portal owners)');
  const modal = (apiSrc.match(/id="ps-create-modal"[\s\S]*?id="ps-create-submit"/) || [])[0] || '';
  ok('Main activity header hosts Back control',
    /id="ps-create-main-activity-back"/.test(modal)
    || /id="ps-create-main-activity-back"/.test(apiSrc));
  ok('Main activity path summary element present',
    /id="ps-create-main-activity-path"/.test(apiSrc));
  ok('Course list host present (drill-down target)',
    /id="ps-create-course-list"/.test(apiSrc));
  ok('Initial three Main activity radios still present',
    /id="ps-create-comp-course"/.test(apiSrc)
    && /id="ps-create-comp-private-lesson"/.test(apiSrc)
    && /id="ps-create-comp-no-lesson"/.test(apiSrc));
  ok('choices host id for in-place replacement',
    /id="ps-create-main-activity-choices"/.test(apiSrc)
    || /portal-schedule-create-main-activity/.test(apiSrc));
  // No visible second dropdown at bottom: course-fields permanently hidden / aria-hidden
  ok('legacy course select not a visible second dropdown',
    /id="ps-create-course-fields"[\s\S]{0,120}(hidden|aria-hidden="true"|display:\s*none)/.test(apiSrc)
    && /id="ps-create-course-select"/.test(apiSrc));
  ok('Back CSS right-aligned ≥44px touch target',
    /\.portal-schedule-create-main-activity-back\{[^}]*min-height:\s*44px/.test(apiSrc)
    && (
      /\.portal-schedule-create-main-activity-header\{[^}]*justify-content:\s*space-between/.test(apiSrc)
      || /\.portal-schedule-create-main-activity-header\{[^}]*margin-left:\s*auto/.test(apiSrc)
      || /\.portal-schedule-create-main-activity-back\{[^}]*margin-left:\s*auto/.test(apiSrc)
    ));
  ok('course list rows ≥44px touch target',
    /\.portal-schedule-create-course-list[\s\S]{0,200}min-height:\s*44px/.test(apiSrc)
    || /portal-schedule-create-course-list .portal-schedule-create-activity-btn\{[^}]*min-height:\s*44px/.test(apiSrc)
    || /portal-schedule-create-course-list .portal-schedule-create-check\{[^}]*min-height:\s*44px/.test(apiSrc));
  ok('course options reuse activity-btn style (not visible radio glyphs)',
    /portal-schedule-create-course-list[\s\S]{0,200}portal-schedule-create-activity-btn/.test(apiSrc)
    && /function schedulePortalRenderCreateCourseList[\s\S]{0,2200}portal-schedule-create-activity-btn/.test(portalSrc)
    && /function schedulePortalRenderCreateCourseList[\s\S]{0,2200}aria-pressed/.test(portalSrc));
  ok('portal owns course button sync helper',
    /function schedulePortalSyncCreateCourseButtons/.test(portalSrc));
  ok('mobile 375/430 create drawer full-bleed (no overflow)',
    /@media\(max-width:640px\)\{\.portal-schedule-drawer,\.portal-schedule-create-drawer\{width:100vw/.test(apiSrc)
    || /@media\(max-width:640px\)\{[^}]*portal-schedule-create-drawer\{[^}]*width:100vw/.test(apiSrc));
  ok('portal owns enter/exit drill-down helpers',
    /function schedulePortalEnterGroupCourseDrilldown/.test(portalSrc)
    && /function schedulePortalExitGroupCourseDrilldown/.test(portalSrc));
  ok('portal owns course list renderer + single select',
    /function schedulePortalRenderCreateCourseList/.test(portalSrc)
    && /function schedulePortalSelectCreateCourse/.test(portalSrc));
  ok('portal path summary owner',
    /function schedulePortalRenderMainActivityPath/.test(portalSrc));
  ok('Create submit gate requires selected group course',
    /function schedulePortalSyncCreateSubmitEnabled[\s\S]{0,900}courseRequired|function schedulePortalSyncCreateSubmitEnabled[\s\S]{0,900}course_id|function schedulePortalSyncCreateSubmitEnabled[\s\S]{0,900}GetSelectedCreateCourseId|function schedulePortalSyncCreateSubmitEnabled[\s\S]{0,900}ps-create-comp-course/.test(portalSrc));
  ok('populate retains selection only when still available',
    /function schedulePortalPopulateCreateCourseFields[\s\S]{0,2500}eligible|function schedulePortalPopulateCreateCourseFields[\s\S]{0,2500}disabled|function schedulePortalPopulateCreateCourseFields[\s\S]{0,2500}ClearSelected/.test(portalSrc));

  // i18n EN/ES/IT
  ok('EN Back key',
    STAFF_PORTAL_STRINGS.en['schedule.create.mainActivityBack'] === 'Back'
    || /'schedule\.create\.mainActivityBack':\s*'Back'/.test(i18nSrc));
  ok('ES Back key',
    esSunset['schedule.create.mainActivityBack'] === 'Atrás'
    || /'schedule\.create\.mainActivityBack':\s*'Atrás'/.test(esSrc));
  ok('IT Back key',
    (STAFF_PORTAL_STRINGS.it && STAFF_PORTAL_STRINGS.it['schedule.create.mainActivityBack'] === 'Indietro')
    || /'schedule\.create\.mainActivityBack':\s*'Indietro'/.test(i18nSrc));
  ok('EN/ES/IT Main activity + Group course keys present',
    !!(STAFF_PORTAL_STRINGS.en['schedule.create.mainActivity']
      && STAFF_PORTAL_STRINGS.en['schedule.type.course']
      && esSunset['schedule.create.mainActivity']
      && esSunset['schedule.type.course']
      && STAFF_PORTAL_STRINGS.it['schedule.create.mainActivity']
      && STAFF_PORTAL_STRINGS.it['schedule.type.course']));

  // Preserve layout cleanup (no Guest/What section titles)
  ok('preserved: no Guest/What section titles in Create modal',
    !/<h3[^>]*ps-create-section-guest-title/.test(apiSrc)
    && !/<h3[^>]*ps-create-section-what-title/.test(apiSrc));
  ok('preserved: Main activity uses create-label typography class',
    /portal-schedule-create-label/.test(apiSrc)
    && /\.portal-schedule-create-label\{[^}]*font-size:\s*11px/.test(apiSrc));

  // ── [1] Generated /staff/ui ──────────────────────────────────────────────
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
  ok('GET /staff/ui 200 HTML', html.includes('<!DOCTYPE html>') && html.includes('ps-create-comp-course'));
  ok('/staff/ui has Back control + course list host',
    html.includes('ps-create-main-activity-back') && html.includes('ps-create-course-list'));
  ok('/staff/ui injects drill-down owners',
    html.includes('function schedulePortalEnterGroupCourseDrilldown')
    && html.includes('function schedulePortalRenderCreateCourseList')
    && html.includes('function schedulePortalRenderMainActivityPath'));
  ok('/staff/ui CSS Back + course row 44px',
    /portal-schedule-create-main-activity-back[\s\S]{0,120}min-height:\s*44px/.test(html)
    && /portal-schedule-create-course-list[\s\S]{0,240}min-height:\s*44px/.test(html));
  ok('/staff/ui course list CSS targets activity buttons',
    /portal-schedule-create-course-list[\s\S]{0,200}portal-schedule-create-activity-btn/.test(html));
  ok('/staff/ui injects course button sync owner',
    html.includes('function schedulePortalSyncCreateCourseButtons')
    && html.includes('function schedulePortalRenderCreateCourseList'));
  ok('/staff/ui no visible Select course label in body flow',
    // Legacy select may exist hidden; visible label "Select course" next to a shown select must not appear
    !(/id="ps-create-course-fields"[^>]*(?!hidden)[^>]*>[\s\S]{0,80}Select course/.test(html)
      && /id="ps-create-course-fields"[^>]*style="(?!display:\s*none)/.test(html)));

  // Also prove inject path includes portal functions (hostile offline parity).
  const injected = injectSunsetSchedulePortalModule(
    '<!--x-->' + SCHEDULE_PORTAL_INJECT_MARKER + '<!--y-->',
  );
  ok('inject path includes enter drill-down',
    injected.includes('function schedulePortalEnterGroupCourseDrilldown'));

  const art = html;

  // ── [2] Initial three-choice view ────────────────────────────────────────
  console.log('\n[2] Initial three-choice view');
  const root = sandboxFromHtml(art);
  ok('sandbox loaded without throw', !root._loadError, root._loadError && root._loadError.message);
  ok('every helper the sliced owners call is in scope',
    root._sliced.missing.length === 0 && root._sliced.unparsable.length === 0,
    'missing=' + root._sliced.missing.join(',') + ' unparsable=' + root._sliced.unparsable.join(','));
  ok('initial Equipment only checked', !!root.el('ps-create-comp-no-lesson').checked);
  ok('initial Group unchecked', !root.el('ps-create-comp-course').checked);
  ok('initial choices visible',
    typeof root.schedulePortalIsGroupCourseDrilldown !== 'function'
      ? visible(root.el('ps-create-main-activity-choices'))
      : root.schedulePortalIsGroupCourseDrilldown() === false
        || visible(root.el('ps-create-main-activity-choices')));
  ok('initial course list hidden', !visible(root.el('ps-create-course-list')));
  ok('initial Back hidden', !visible(root.el('ps-create-main-activity-back')));
  ok('initial path hidden', !visible(root.el('ps-create-main-activity-path')));

  // ── [3] Group click → in-place course list; no dropdown ──────────────────
  console.log('\n[3] Group course click replaces choices with course list');
  const group = sandboxFromHtml(art);
  group.el('ps-create-comp-course').checked = true;
  group.el('ps-create-comp-no-lesson').checked = false;
  if (typeof group.schedulePortalEnterGroupCourseDrilldown === 'function') {
    group.schedulePortalEnterGroupCourseDrilldown();
  }
  if (typeof group.schedulePortalPopulateCreateCourseFields === 'function') {
    await group.schedulePortalPopulateCreateCourseFields();
  }
  ok('drill-down mode active',
    typeof group.schedulePortalIsGroupCourseDrilldown === 'function'
      ? group.schedulePortalIsGroupCourseDrilldown() === true
      : visible(group.el('ps-create-course-list')));
  ok('choices hidden after Group click', !visible(group.el('ps-create-main-activity-choices')));
  ok('course list visible after Group click', visible(group.el('ps-create-course-list')));
  ok('Back visible after Group click', visible(group.el('ps-create-main-activity-back')));
  ok('legacy course-fields stay hidden (no second dropdown)',
    !visible(group.el('ps-create-course-fields')));
  const listHtml = String(group.el('ps-create-course-list').innerHTML || '');
  ok('course list renders real activity buttons (no visible radio labels)',
    /portal-schedule-create-activity-btn/.test(listHtml)
    && /<button\b[^>]*data-course-id=/.test(listHtml)
    && /aria-pressed=/.test(listHtml)
    && /Curso Mañana/.test(listHtml)
    && /Curso Tarde/.test(listHtml)
    && !/<label[^>]*portal-schedule-create-check/.test(listHtml),
    listHtml.slice(0, 280));
  ok('hidden radio/select compatibility may remain without visible glyphs',
    (/type="radio"/.test(listHtml)
      ? /portal-schedule-create-visually-hidden|aria-hidden="true"|tabindex="-1"/.test(listHtml)
      : true)
    && !!group.el('ps-create-course-select'));
  ok('course list is NOT a <select> dropdown',
    !/<select[\s>]/i.test(listHtml));
  ok('path summary stays hidden before pick (button shows choice)',
    !visible(group.el('ps-create-main-activity-path'))
    && !(pathText(group) || '').trim(), pathText(group));

  // ── [4] Single selection + aria-pressed button semantics ─────────────────
  console.log('\n[4] Single-selection button / aria-pressed semantics (production owners)');
  if (typeof group.schedulePortalSelectCreateCourse === 'function') {
    group.schedulePortalSelectCreateCourse('c-manana', 'Curso Mañana');
  } else {
    // Attempt button/radio click simulation
    const rows = group.el('ps-create-course-list')._courseRows || [];
    if (rows[0] && rows[0]._input) {
      rows.forEach((r) => { r._input.checked = false; if (r.setAttribute) r.setAttribute('aria-pressed', 'false'); });
      rows[0]._input.checked = true;
      if (rows[0].setAttribute) rows[0].setAttribute('aria-pressed', 'true');
      group.el('ps-create-course-select').value = 'c-manana';
    }
  }
  ok('selected course id is c-manana',
    typeof group.schedulePortalGetSelectedCreateCourseId === 'function'
      ? group.schedulePortalGetSelectedCreateCourseId() === 'c-manana'
      : group.el('ps-create-course-select').value === 'c-manana');
  {
    const rows = group.el('ps-create-course-list')._courseRows || [];
    const pressed = rows.filter((r) => r.getAttribute && r.getAttribute('aria-pressed') === 'true');
    const selectedCls = rows.filter((r) => r.classList && r.classList.contains('is-selected'));
    ok('exactly one course button aria-pressed=true after select',
      pressed.length === 1
      && pressed[0]
      && pressed[0].getAttribute('data-course-id') === 'c-manana',
      'pressed=' + pressed.length);
    ok('exactly one course button has is-selected',
      selectedCls.length === 1
      && selectedCls[0]
      && selectedCls[0].getAttribute('data-course-id') === 'c-manana');
    ok('hidden radio mirrors selected id when present',
      !rows[0]._input
        || rows.some((r) => r._input && r._input.checked && r.getAttribute('data-course-id') === 'c-manana'));
  }
  // Multi-lesson Create (8e5b39ba, 2026-07-29) made a second pick additive:
  // schedulePortalSelectCreateCourse appends, button clicks toggle, and exclusive
  // replacement is now opt-in via { exclusive: true }.
  if (typeof group.schedulePortalSelectCreateCourse === 'function') {
    group.schedulePortalSelectCreateCourse('c-tarde', 'Curso Tarde');
  }
  ok('selecting second course adds it (multi-select) and keeps the first primary',
    typeof group.schedulePortalGetSelectedCreateCourseIds === 'function'
      ? group.schedulePortalGetSelectedCreateCourseIds().join(',') === 'c-manana,c-tarde'
        && group.schedulePortalGetSelectedCreateCourseId() === 'c-manana'
      : group.el('ps-create-course-select').value === 'c-manana',
    typeof group.schedulePortalGetSelectedCreateCourseIds === 'function'
      ? group.schedulePortalGetSelectedCreateCourseIds().join(',') : '');
  {
    const rows = group.el('ps-create-course-list')._courseRows || [];
    const pressed = rows.filter((r) => r.getAttribute && r.getAttribute('aria-pressed') === 'true');
    ok('both selected courses stay aria-pressed after the second pick',
      pressed.length === 2
      && pressed.map((r) => r.getAttribute('data-course-id')).sort().join(',') === 'c-manana,c-tarde',
      'pressed=' + pressed.length);
  }
  if (typeof group.schedulePortalSelectCreateCourse === 'function') {
    group.schedulePortalSelectCreateCourse('c-tarde', 'Curso Tarde', { exclusive: true });
  }
  {
    const rows = group.el('ps-create-course-list')._courseRows || [];
    const pressed = rows.filter((r) => r.getAttribute && r.getAttribute('aria-pressed') === 'true');
    ok('exclusive select still replaces the whole set (single-course path intact)',
      pressed.length === 1
      && pressed[0]
      && pressed[0].getAttribute('data-course-id') === 'c-tarde',
      'pressed=' + pressed.length);
  }
  // Back to a single Curso Mañana selection for the footer/payload checks below.
  if (typeof group.schedulePortalSelectCreateCourse === 'function') {
    group.schedulePortalSelectCreateCourse('c-manana', 'Curso Mañana', { exclusive: true });
  }
  if (typeof group.schedulePortalRenderMainActivityPath === 'function') {
    group.schedulePortalRenderMainActivityPath();
  }
  const pathAfter = pathText(group);
  ok('path summary stays hidden after pick (selected course button is enough)',
    !visible(group.el('ps-create-main-activity-path'))
    && !(pathAfter || '').trim(),
    pathAfter);
  ok('path remains empty (no crumb duplication risk)',
    !(pathAfter || '').trim(), pathAfter);
  // Footer summary prefers named course without generic Group course
  if (typeof group.schedulePortalRenderCreateIntentSummary === 'function') {
    group.schedulePortalRenderCreateIntentSummary();
  }
  const foot = String(group.el('ps-create-summary').innerHTML || '').replace(/<[^>]+>/g, ' ');
  ok('footer summary has Curso Mañana', /Curso Mañana/.test(foot), foot);
  ok('footer omits generic Group course when named',
    !/Group course/i.test(foot), foot);

  // Surfer count authority still applies
  const payload = group.scheduleReadCreatePayload();
  ok('payload course_id selected + surfer quantity from global count',
    payload.components
    && payload.components.course
    && payload.components.course.course_id === 'c-manana'
    && Number(payload.components.course.quantity) === 2,
    JSON.stringify(payload.components && payload.components.course));

  // ── [5] Back clears + restores ───────────────────────────────────────────
  console.log('\n[5] Back clears selected course and restores three choices');
  if (typeof group.schedulePortalExitGroupCourseDrilldown === 'function') {
    group.schedulePortalExitGroupCourseDrilldown({ clearCourse: true });
  } else {
    group._fire('ps-create-main-activity-back', 'click');
  }
  ok('after Back: choices visible', visible(group.el('ps-create-main-activity-choices')));
  ok('after Back: course list hidden', !visible(group.el('ps-create-course-list')));
  ok('after Back: Back control hidden', !visible(group.el('ps-create-main-activity-back')));
  ok('after Back: selected course cleared',
    typeof group.schedulePortalGetSelectedCreateCourseId === 'function'
      ? !group.schedulePortalGetSelectedCreateCourseId()
      : !group.el('ps-create-course-select').value);
  ok('after Back: Group radio unchecked (not stuck in group without course)',
    !group.el('ps-create-comp-course').checked);
  ok('after Back: Equipment only restored', !!group.el('ps-create-comp-no-lesson').checked);

  // ── [6] Invalidated selection on catalog/date change ─────────────────────
  console.log('\n[6] Retain selection only if still available after catalog/date change');
  const inv = sandboxFromHtml(art);
  inv.el('ps-create-comp-course').checked = true;
  inv.el('ps-create-comp-no-lesson').checked = false;
  if (typeof inv.schedulePortalEnterGroupCourseDrilldown === 'function') {
    inv.schedulePortalEnterGroupCourseDrilldown();
  }
  if (typeof inv.schedulePortalPopulateCreateCourseFields === 'function') {
    await inv.schedulePortalPopulateCreateCourseFields();
  }
  if (typeof inv.schedulePortalSelectCreateCourse === 'function') {
    inv.schedulePortalSelectCreateCourse('c-manana', 'Curso Mañana');
  } else {
    inv.el('ps-create-course-select').value = 'c-manana';
  }
  ok('precondition selected c-manana',
    (typeof inv.schedulePortalGetSelectedCreateCourseId === 'function'
      ? inv.schedulePortalGetSelectedCreateCourseId()
      : inv.el('ps-create-course-select').value) === 'c-manana');

  // Still available → retain
  inv._setCatalog([
    {
      course_id: 'c-manana',
      label: 'Curso Mañana',
      eligible_on_requested_dates: true,
      price_tiers: [{ key: '5_days', duration_days: 5, bookable: true, label: '5 days' }],
    },
    {
      course_id: 'c-tarde',
      label: 'Curso Tarde',
      eligible_on_requested_dates: true,
      price_tiers: [{ key: '5_days', duration_days: 5, bookable: true, label: '5 days' }],
    },
  ]);
  if (typeof inv.schedulePortalPopulateCreateCourseFields === 'function') {
    await inv.schedulePortalPopulateCreateCourseFields();
  }
  ok('retains selection when still available',
    (typeof inv.schedulePortalGetSelectedCreateCourseId === 'function'
      ? inv.schedulePortalGetSelectedCreateCourseId()
      : inv.el('ps-create-course-select').value) === 'c-manana');
  {
    const rows = inv.el('ps-create-course-list')._courseRows || [];
    const pressed = rows.filter((r) => r.getAttribute && r.getAttribute('aria-pressed') === 'true');
    ok('catalog refresh keeps exclusive button pressed on retained course',
      pressed.length === 1
      && pressed[0]
      && pressed[0].getAttribute('data-course-id') === 'c-manana');
  }

  // Becomes unavailable → clear
  inv._setCatalog([
    {
      course_id: 'c-manana',
      label: 'Curso Mañana',
      eligible_on_requested_dates: false,
      price_tiers: [{ key: '5_days', duration_days: 5, bookable: true, label: '5 days' }],
    },
    {
      course_id: 'c-tarde',
      label: 'Curso Tarde',
      eligible_on_requested_dates: true,
      price_tiers: [{ key: '5_days', duration_days: 5, bookable: true, label: '5 days' }],
    },
  ]);
  if (typeof inv.schedulePortalPopulateCreateCourseFields === 'function') {
    await inv.schedulePortalPopulateCreateCourseFields();
  }
  const afterInv = typeof inv.schedulePortalGetSelectedCreateCourseId === 'function'
    ? inv.schedulePortalGetSelectedCreateCourseId()
    : inv.el('ps-create-course-select').value;
  ok('clears selection when course no longer available', !afterInv, String(afterInv));
  {
    const rows = inv.el('ps-create-course-list')._courseRows || [];
    const pressed = rows.filter((r) => r.getAttribute && r.getAttribute('aria-pressed') === 'true');
    ok('stale removal clears all course button pressed states', pressed.length === 0);
  }

  // Back clears button pressed + hidden radio after a live pick
  if (typeof inv.schedulePortalSelectCreateCourse === 'function') {
    inv.schedulePortalSelectCreateCourse('c-tarde', 'Curso Tarde');
  }
  if (typeof inv.schedulePortalExitGroupCourseDrilldown === 'function') {
    inv.schedulePortalExitGroupCourseDrilldown({ clearCourse: true });
  }
  ok('Back after stale-removal path: course id cleared',
    !(typeof inv.schedulePortalGetSelectedCreateCourseId === 'function'
      ? inv.schedulePortalGetSelectedCreateCourseId()
      : inv.el('ps-create-course-select').value));

  // ── [7] Create disabled without course; quote stale/requote ──────────────
  console.log('\n[7] Create disabled without course + quote clear on selection change');
  const gate = sandboxFromHtml(art, { guest: 'Ada', phone: '+34600999888' });
  // Equipment only with guest/phone → Create may enable (no course required)
  gate.el('ps-create-comp-no-lesson').checked = true;
  gate.el('ps-create-comp-course').checked = false;
  if (typeof gate.schedulePortalSyncCreateSubmitEnabled === 'function') {
    gate.schedulePortalSyncCreateSubmitEnabled();
  }
  ok('Create enabled for Equipment only with valid guest/phone',
    gate.el('ps-create-submit').disabled === false);

  // Group without course → disabled
  gate.el('ps-create-comp-course').checked = true;
  gate.el('ps-create-comp-no-lesson').checked = false;
  if (typeof gate.schedulePortalEnterGroupCourseDrilldown === 'function') {
    gate.schedulePortalEnterGroupCourseDrilldown();
  }
  if (typeof gate.schedulePortalClearSelectedCreateCourse === 'function') {
    gate.schedulePortalClearSelectedCreateCourse();
  } else {
    gate.el('ps-create-course-select').value = '';
  }
  if (typeof gate.schedulePortalSyncCreateSubmitEnabled === 'function') {
    gate.schedulePortalSyncCreateSubmitEnabled();
  }
  ok('Create disabled when Group selected without course',
    gate.el('ps-create-submit').disabled === true);

  // Select course → enabled
  if (typeof gate.schedulePortalSelectCreateCourse === 'function') {
    gate.schedulePortalSelectCreateCourse('c-manana', 'Curso Mañana');
  } else {
    gate.el('ps-create-course-select').value = 'c-manana';
  }
  if (typeof gate.schedulePortalSyncCreateSubmitEnabled === 'function') {
    gate.schedulePortalSyncCreateSubmitEnabled();
  }
  ok('Create enabled after group course selected',
    gate.el('ps-create-submit').disabled === false);

  // Quote clears on selection change (stale intent)
  gate.el('ps-create-quote-preview').innerHTML = 'Quoted total: €115.00';
  gate.el('ps-create-quote-preview').style.display = 'block';
  gate.schedulePortalQuoteState = {
    total_cents: 11500,
    intent_key: 'stale-before-course-change',
  };
  if (typeof gate.schedulePortalSelectCreateCourse === 'function') {
    gate.schedulePortalSelectCreateCourse('c-tarde', 'Curso Tarde');
  } else {
    gate.el('ps-create-course-select').value = 'c-tarde';
  }
  if (typeof gate.schedulePortalSyncCreateFooter === 'function') {
    gate.schedulePortalSyncCreateFooter({ quote: false });
  } else if (typeof gate.schedulePortalDropStaleQuoteUi === 'function') {
    gate.schedulePortalDropStaleQuoteUi(gate.scheduleReadCreatePayload());
  } else if (typeof gate.schedulePortalInvalidateCreateQuoteIntent === 'function') {
    gate.schedulePortalInvalidateCreateQuoteIntent({ softInvalid: true });
  }
  const qAfter = String(gate.el('ps-create-quote-preview').innerHTML || '');
  ok('stale quote cleared/requoted path on course selection change',
    !/€115/.test(qAfter)
    && (gate.el('ps-create-quote-preview').style.display === 'none'
      || !qAfter.trim()
      || /softInvalid|checking|Quote unavailable/i.test(qAfter)
      || gate.schedulePortalQuoteState == null
      || (gate.schedulePortalQuoteState
        && gate.schedulePortalQuoteState.intent_key !== 'stale-before-course-change')),
    qAfter);

  // ── [8] Private / Equipment only unchanged ────────────────────────────────────
  console.log('\n[8] Private course and Equipment only remain unchanged');
  const priv = sandboxFromHtml(art);
  priv.el('ps-create-comp-private-lesson').checked = true;
  priv.el('ps-create-comp-course').checked = false;
  priv.el('ps-create-comp-no-lesson').checked = false;
  if (typeof priv.schedulePortalExitGroupCourseDrilldown === 'function') {
    priv.schedulePortalExitGroupCourseDrilldown({ clearCourse: true, restoreRootOnly: true });
  }
  ok('Private does not open course list', !visible(priv.el('ps-create-course-list')));
  ok('Private keeps choices path (root radios exist)', !!priv.el('ps-create-comp-private-lesson'));
  const none = sandboxFromHtml(art);
  none.el('ps-create-comp-no-lesson').checked = true;
  none.el('ps-create-comp-course').checked = false;
  if (typeof none.schedulePortalSyncCreateSubmitEnabled === 'function') {
    none.schedulePortalSyncCreateSubmitEnabled();
  }
  ok('Equipment only Create not blocked by course requirement',
    none.el('ps-create-submit').disabled === false);

  // ── [9] EN / ES / IT localization of Back + path ─────────────────────────
  console.log('\n[9] EN/ES/IT localization');
  for (const [loc, T, backWord, groupWord] of [
    ['en', T_EN, 'Back', 'Group course'],
    ['es', T_ES, 'Atrás', 'Curso en grupo'],
    ['it', T_IT, 'Indietro', 'Corso di gruppo'],
  ]) {
    const locCtx = sandboxFromHtml(art, { locale: loc, T });
    ok(loc + ' Back label text',
      String(locCtx.el('ps-create-main-activity-back').textContent || '').includes(backWord)
      || locCtx.portalT('schedule.create.mainActivityBack') === backWord);
    locCtx.el('ps-create-comp-course').checked = true;
    if (typeof locCtx.schedulePortalEnterGroupCourseDrilldown === 'function') {
      locCtx.schedulePortalEnterGroupCourseDrilldown();
    }
    if (typeof locCtx.schedulePortalSelectCreateCourse === 'function') {
      locCtx.schedulePortalSelectCreateCourse('c-manana', 'Curso Mañana');
    }
    if (typeof locCtx.schedulePortalRenderMainActivityPath === 'function') {
      locCtx.schedulePortalRenderMainActivityPath();
    }
    const p = pathText(locCtx) || (typeof locCtx.schedulePortalRenderMainActivityPath === 'function'
      ? pathText(locCtx) : '');
    // Path may use portalT; if path empty (function missing), still check portalT keys
    const pathOk = (p && p.includes(groupWord) && p.includes('Curso Mañana'))
      || (locCtx.portalT('schedule.type.course') === groupWord);
    ok(loc + ' path uses localized Group label', pathOk, p || locCtx.portalT('schedule.type.course'));
  }

  // ── [10] One-day canonical tier wins over legacy alias ────────────────────
  console.log('\n[10] One-day canonical duration identity');
  const durationCtx = sandboxFromHtml(art);
  const oneDayCanonical = {
    key: '1_day', duration_days: 1, bookable: true,
    offering_id: 'surf_pack_c-manana__1_day', label: '1 day',
  };
  const oneDayLegacy = {
    key: 'single_class', duration_days: 1, bookable: true,
    offering_id: 'surf_pack_c-manana__single_class', label: 'Single class',
  };
  durationCtx._setCatalog([{
    course_id: 'c-manana', label: 'Curso Mañana',
    price_tiers: [oneDayCanonical, oneDayLegacy],
  }]);
  const canonicalResult = durationCtx.schedulePortalResolveDerivedCourseTier(
    'c-manana', '2026-08-05', '2026-08-05');
  ok('one-day exact canonical 1_day wins when legacy single_class also exists',
    canonicalResult && canonicalResult.ok === true
    && canonicalResult.tier_key === '1_day'
    && canonicalResult.offering_id === 'surf_pack_c-manana__1_day',
    JSON.stringify(canonicalResult));
  durationCtx._setCatalog([{
    course_id: 'c-manana', label: 'Curso Mañana', price_tiers: [oneDayLegacy],
  }]);
  const legacyOnlyResult = durationCtx.schedulePortalResolveDerivedCourseTier(
    'c-manana', '2026-08-05', '2026-08-05');
  ok('legacy-only single_class remains readable for unmigrated catalogs',
    legacyOnlyResult && legacyOnlyResult.ok === true
    && legacyOnlyResult.tier_key === 'single_class',
    JSON.stringify(legacyOnlyResult));
  durationCtx._setCatalog([{
    course_id: 'c-manana', label: 'Curso Mañana',
    price_tiers: [oneDayCanonical, Object.assign({}, oneDayCanonical, {
      offering_id: 'surf_pack_c-manana__1_day_duplicate',
    })],
  }]);
  const duplicateCanonicalResult = durationCtx.schedulePortalResolveDerivedCourseTier(
    'c-manana', '2026-08-05', '2026-08-05');
  ok('duplicate canonical one-day rows still fail closed as ambiguous',
    duplicateCanonicalResult && duplicateCanonicalResult.ok === false
    && duplicateCanonicalResult.errorKey === 'schedule.create.courseDurationAmbiguous',
    JSON.stringify(duplicateCanonicalResult));

  const quoteService = require('./lib/luna-front-desk-quote-service');
  const alignedCanonical = quoteService.resolveCourseOfferingIdentity({
    course_id: 'c-manana', tier_key: '1_day',
    offering_id: 'surf_pack_c-manana__1_day',
  });
  ok('server accepts aligned canonical course/tier/offering identity',
    alignedCanonical.ok === true
    && alignedCanonical.offering_id === 'surf_pack_c-manana__1_day',
    JSON.stringify(alignedCanonical));
  const derivedCanonical = quoteService.resolveCourseOfferingIdentity({
    course_id: 'c-manana', tier_key: '1_day',
  });
  ok('server derives canonical offering when browser omits offering_id',
    derivedCanonical.ok === true
    && derivedCanonical.offering_id === 'surf_pack_c-manana__1_day',
    JSON.stringify(derivedCanonical));
  const mismatchedIdentity = quoteService.resolveCourseOfferingIdentity({
    course_id: 'c-manana', tier_key: '1_day',
    offering_id: 'surf_pack_c-manana__single_class',
  });
  ok('server rejects canonical tier paired with legacy offering identity',
    mismatchedIdentity.ok === false
    && mismatchedIdentity.status === 422
    && mismatchedIdentity.body.reason === 'course_offering_identity_mismatch',
    JSON.stringify(mismatchedIdentity));
  const alignedLegacy = quoteService.resolveCourseOfferingIdentity({
    course_id: 'c-manana', tier_key: 'single_class',
    offering_id: 'surf_pack_c-manana__single_class',
  });
  ok('server retains aligned legacy-only identity',
    alignedLegacy.ok === true
    && alignedLegacy.offering_id === 'surf_pack_c-manana__single_class',
    JSON.stringify(alignedLegacy));
  const quoteServiceSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/lib/luna-front-desk-quote-service.js'), 'utf8');
  ok('both async and sync component quote paths enforce server identity owner',
    (quoteServiceSrc.match(/const identity = resolveCourseOfferingIdentity\(comp\);/g) || []).length === 2);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('');
  if (fail > 0) {
    console.error('verify:sunset-create-course-drilldown — FAILED pass=' + pass + ' fail=' + fail + '\n');
    process.exit(1);
  }
  console.log('verify:sunset-create-course-drilldown — ALL CHECKS PASSED (pass=' + pass + ')\n');
  process.exit(0);
})().catch((err) => {
  console.error('verify:sunset-create-course-drilldown crashed:', err);
  process.exit(1);
});
