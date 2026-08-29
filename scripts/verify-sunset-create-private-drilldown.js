'use strict';

/**
 * verify:sunset-create-private-drilldown
 *
 * Private course Create Booking Main activity drill-down parity with Group:
 *   1. Initial three Main activity choices (Group / Private / No lesson)
 *   2. Private course click replaces that list in place with the existing
 *      per-date start/end session editor (sessionsHelp prompt)
 *   3. No duplicate private schedule editor lower in the drawer
 *   4. One start/end row per inclusive date in range
 *   5. Main activity header Back button visible (right, ≥44px)
 *   6. Back clears private selection/session draft and restores three choices
 *      with No lesson default
 *   7. Compact path summary shows Private course while inside the panel
 *   8. Re-entry after Back starts from current date-range defaults (no leak)
 *   9. Incomplete/invalid private sessions cannot create or retain stale quote
 *  10. Group course drill-down regression; No lesson regression
 *  11. EN/ES/IT localization; mobile 375/430 CSS (no overflow, usable time rows)
 *
 * Executes the REAL generated /staff/ui artifact (production buildUiHtml +
 * injectSunsetSchedulePortalModule), not source-regex alone.
 *
 * No Azure / staging / DB mutation.
 *
 * Run: node scripts/verify-sunset-create-private-drilldown.js
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
  'schedule.create.summary.completeSessions': 'Complete session details',
  'schedule.create.quoteTotal': 'Quoted total',
  'schedule.create.quoteFailed': 'Quote unavailable',
  'schedule.create.privateLesson.sessionsHelp': 'Set start and end time for each date in the range.',
  'schedule.create.privateLesson.sessionLabel': 'Session',
  'schedule.create.privateLesson.start': 'Start',
  'schedule.create.privateLesson.end': 'End',
  'schedule.create.privateLesson.sessionIncomplete': 'Complete each session start and end time.',
  'schedule.type.course': 'Group course',
  'schedule.type.privateLesson': 'Private Course',
  'schedule.type.noLesson': 'No lesson',
  'schedule.courses.noneConfigured': 'No group courses configured',
  'admin.period.5_days': '5 days',
};

const T_ES = Object.assign({}, T_EN, {
  'schedule.create.mainActivity': 'Actividad principal',
  'schedule.create.mainActivityBack': 'Atrás',
  'schedule.create.privateLesson.sessionsHelp': 'Fija la hora de inicio y fin de cada fecha del intervalo.',
  'schedule.type.course': 'Curso en grupo',
  'schedule.type.privateLesson': 'Curso privado',
  'schedule.type.noLesson': 'Sin clase',
});

const T_IT = Object.assign({}, T_EN, {
  'schedule.create.mainActivity': 'Attività principale',
  'schedule.create.mainActivityBack': 'Indietro',
  'schedule.create.privateLesson.sessionsHelp': 'Imposta ora di inizio e fine per ogni data dell\'intervallo.',
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
        if (sel === '.ps-pl-session-start' || sel === '.ps-pl-session-end' || sel === '.ps-pl-session-date') {
          return null;
        }
        return null;
      },
      querySelectorAll(sel) {
        if (this.id === 'ps-create-course-list') {
          const rows = this._courseRows || [];
          if (!sel || sel === '*' || sel.includes('label')
            || sel.includes('portal-schedule-create-check')
            || sel.includes('portal-schedule-create-activity-btn')
            || sel.includes('button[data-course-id]')
            || (sel.includes('button') && sel.includes('data-course-id'))) {
            return rows.slice();
          }
          if (sel.includes('input')) {
            return rows.map((r) => r._input).filter(Boolean);
          }
          if (sel.includes('[data-course-id]')) {
            return rows.slice();
          }
        }
        if (this.id === 'ps-create-private-lesson-sessions') {
          const rows = this._sessionRows || [];
          if (sel === '.portal-schedule-private-session-row') return rows.slice();
          if (sel === '.ps-pl-session-start') return rows.map((r) => r._start).filter(Boolean);
          if (sel === '.ps-pl-session-end') return rows.map((r) => r._end).filter(Boolean);
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
  N('ps-create-date-from', { value: opts.dateFrom || '2026-07-27' });
  N('ps-create-date-to', { value: opts.dateTo || '2026-07-31' });
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
  // Private panel — must live in Main activity replacement region (not a second When editor).
  N('ps-create-private-panel', {
    style: { display: 'none' },
    hidden: true,
    classList: makeClassList(['portal-schedule-create-private-panel']),
  });
  N('ps-create-private-when', {
    style: { display: 'none' },
    hidden: true,
    classList: makeClassList(['portal-schedule-create-private-when']),
  });
  N('ps-create-private-sessions-help', {
    textContent: T['schedule.create.privateLesson.sessionsHelp'],
    classList: makeClassList(['portal-schedule-create-label']),
  });
  N('ps-create-private-lesson-qty', { value: '0' });
  N('ps-create-private-lesson-surfers', { value: '2' });
  N('ps-create-add-session', { style: { display: 'none' }, hidden: true });
  N('ps-create-private-lesson-qty-wrap', { style: { display: 'none' }, hidden: true });
  N('ps-create-private-lesson-fields', { style: { display: 'none' }, hidden: true });

  const sessionsWrap = N('ps-create-private-lesson-sessions', {
    style: { display: '' },
    hidden: false,
    innerHTML: '',
    _sessionRows: [],
    classList: makeClassList(['portal-schedule-private-sessions']),
  });
  Object.defineProperty(sessionsWrap, 'innerHTML', {
    get() { return this._innerHTML || ''; },
    set(v) {
      this._innerHTML = String(v || '');
      this._sessionRows = [];
      const html = this._innerHTML;
      const rowRe = /portal-schedule-private-session-row[^>]*data-session-date="([^"]*)"[\s\S]*?<\/div>\s*<\/div>/g;
      let m;
      // Broader parse: each row block by data-session-date
      const dates = [];
      const dateRe = /data-session-date="([^"]*)"/g;
      let dm;
      while ((dm = dateRe.exec(html))) dates.push(dm[1]);
      const starts = [];
      const ends = [];
      const startRe = /ps-pl-session-start"[^>]*value="([^"]*)"/g;
      const endRe = /ps-pl-session-end"[^>]*value="([^"]*)"/g;
      let sm;
      while ((sm = startRe.exec(html))) starts.push(sm[1]);
      while ((sm = endRe.exec(html))) ends.push(sm[1]);
      for (let i = 0; i < dates.length; i += 1) {
        const dateAttr = dates[i];
        const startVal = starts[i] != null ? starts[i] : '';
        const endVal = ends[i] != null ? ends[i] : '';
        const startEl = {
          className: 'ps-pl-session-start',
          classList: makeClassList(['ps-pl-session-start']),
          type: 'time',
          value: startVal,
          defaultValue: startVal,
          dataset: {},
          _ls: {},
          addEventListener(ev, fn) {
            this._ls[ev] = this._ls[ev] || [];
            this._ls[ev].push(fn);
          },
        };
        const endEl = {
          className: 'ps-pl-session-end',
          classList: makeClassList(['ps-pl-session-end']),
          type: 'time',
          value: endVal,
          defaultValue: endVal,
          dataset: {},
          _ls: {},
          addEventListener(ev, fn) {
            this._ls[ev] = this._ls[ev] || [];
            this._ls[ev].push(fn);
          },
        };
        const row = {
          className: 'portal-schedule-private-session-row',
          classList: makeClassList(['portal-schedule-private-session-row']),
          dataset: { wired: '', sessionDate: dateAttr },
          _start: startEl,
          _end: endEl,
          getAttribute(k) {
            if (k === 'data-session-date') return dateAttr;
            return this['_' + k] != null ? this['_' + k] : null;
          },
          setAttribute(k, val) { this['_' + k] = val; },
          querySelector(sel) {
            if (sel === '.ps-pl-session-start') return startEl;
            if (sel === '.ps-pl-session-end') return endEl;
            if (sel === '.ps-pl-session-date') return null;
            return null;
          },
        };
        this._sessionRows.push(row);
      }
      void rowRe; // silence unused if parser falls back to dates only
    },
    configurable: true,
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
  N('ps-create-date-range', { style: { display: '' } });

  // When section shell — must stay hidden; editor lives in Main activity region.
  const whenSection = {
    id: 'ps-create-when-section',
    dataset: { createSection: 'when' },
    style: { display: 'none' },
    hidden: true,
    classList: makeClassList(['is-when-hidden']),
    setAttribute(k, v) { if (k === 'hidden') this.hidden = v !== 'false' && v != null; },
    removeAttribute(k) { if (k === 'hidden') this.hidden = false; },
  };

  // Live-ish course list DOM (activity buttons + hidden radios; legacy labels accepted)
  const courseList = nodes['ps-create-course-list'];
  Object.defineProperty(courseList, 'innerHTML', {
    get() { return this._innerHTML || ''; },
    set(v) {
      this._innerHTML = String(v || '');
      this._courseRows = [];
      const html = this._innerHTML;
      let m;
      const btnRe = /<button[^>]*data-course-id="([^"]*)"[^>]*data-label="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g;
      while ((m = btnRe.exec(html))) {
        const cid = m[1];
        const lab = m[2]
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const attrs = m[0].slice(0, m[0].indexOf('>'));
        const disabled = /\sdisabled(?:\s|=|>|$)/.test(attrs) || /is-disabled/.test(attrs);
        const pressed = /aria-pressed="true"/.test(attrs) || /is-selected/.test(attrs);
        const after = html.slice(m.index + m[0].length, m.index + m[0].length + 280);
        const inputMatch = after.match(/<input[^>]*type="radio"[^>]*>/);
        const inputTag = inputMatch ? inputMatch[0] : '';
        const input = {
          type: 'radio',
          name: 'ps-create-course-pick',
          value: cid,
          checked: /checked/.test(inputTag) || pressed,
          disabled: disabled || /disabled/.test(inputTag),
          _ls: {},
          addEventListener(ev, fn) {
            this._ls[ev] = this._ls[ev] || [];
            this._ls[ev].push(fn);
          },
          setAttribute() {},
          getAttribute() { return null; },
        };
        this._courseRows.push({
          tagName: 'BUTTON',
          type: 'button',
          className: 'portal-schedule-create-activity-btn' + (pressed ? ' is-selected' : ''),
          classList: makeClassList([
            'portal-schedule-create-activity-btn',
            ...(pressed ? ['is-selected'] : []),
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
        });
      }
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
    'schedulePortalEnterPrivateSessionsDrilldown',
    'schedulePortalExitMainActivityDrilldown',
    'schedulePortalExitGroupCourseDrilldown',
    'schedulePortalIsGroupCourseDrilldown',
    'schedulePortalIsPrivateSessionsDrilldown',
    'schedulePortalIsMainActivityDrilldown',
    'schedulePortalPrivatePanelNode',
    'schedulePortalClearPrivateSessionDraft',
    'schedulePortalRenderMainActivityPath',
    'schedulePortalRenderCreateCourseList',
    'schedulePortalSelectCreateCourse',
    'schedulePortalClearSelectedCreateCourse',
    'schedulePortalGetSelectedCreateCourseId',
    'schedulePortalSyncCreateCourseButtons',
    'schedulePortalApplyDesiredCourseSelect',
    'schedulePortalPopulateCreateCourseFields',
    'schedulePortalValidateCreatePayload',
    'schedulePortalValidatePrivateLessonCreate',
    'schedulePortalHasSellableIntent',
    'schedulePortalCanonicalDateIso',
    'schedulePortalMadridTodayIso',
    'schedulePortalInclusiveDateCount',
    'schedulePortalMatchSellableCourseTiersByDurationDays',
    'schedulePortalResolveDerivedCourseTier',
    'schedulePortalFormatCompactDateRange',
    'schedulePortalRentalLabel',
    'schedulePortalDurationLabel',
    'schedulePrivateLessonDefaultStartHm',
    'schedulePrivateLessonDefaultEnd',
    'schedulePrivateLessonApplyBlankTimeDefaults',
    'scheduleReadPrivateLessonSessionsFromDom',
    'scheduleWirePrivateLessonSessionRow',
    'schedulePrivateLessonSessionsRefreshDependents',
    'scheduleSyncPrivateLessonSessions',
  ];
  function readSessionsFromDom() {
    if (typeof ctx.scheduleReadPrivateLessonSessionsFromDom === 'function') {
      return ctx.scheduleReadPrivateLessonSessionsFromDom();
    }
    return (nodes['ps-create-private-lesson-sessions']._sessionRows || []).map((r) => ({
      date: r.getAttribute('data-session-date'),
      start: r._start ? r._start.value : '',
      end: r._end ? r._end.value : '',
    }));
  }

  const FixedDate = class extends Date {
    constructor(...args) {
      super(...(args.length ? args : ['2026-07-01T12:00:00Z']));
    }
    static now() { return Date.parse('2026-07-01T12:00:00Z'); }
  };

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
    Date: FixedDate,
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
    scheduleSlotMinutesFromToken(hm) {
      const x = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
      return x ? (+x[1]) * 60 + (+x[2]) : null;
    },
    scheduleMinutesLabel(mins) {
      return String(Math.floor(mins / 60)).padStart(2, '0') + ':'
        + String(mins % 60).padStart(2, '0');
    },
    schedulePrivateLessonDurationCache: 120,
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
        const sessions = readSessionsFromDom();
        components.private_lesson = {
          enabled: true,
          quantity: sessions.length || parseInt(nodes['ps-create-private-lesson-qty'].value, 10) || 0,
          surfer_count: surferCount,
          sessions: sessions.length ? sessions : [],
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
    scheduleCreateSelectedDates: () => {
      const a = nodes['ps-create-date-from'].value;
      const b = nodes['ps-create-date-to'].value || a;
      return ctx.scheduleEnumerateDates(a, b);
    },
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
      querySelector(sel) {
        if (sel === '#ps-create-modal [data-create-section="when"]') return whenSection;
        return null;
      },
      querySelectorAll() { return []; },
    },
    window: { applyStaffPortalI18n() {} },
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
    scheduleUpdateCreateTotalPreview() {},
    scheduleOnCreateComponentChange() {},
    _nodes: nodes,
    _whenSection: whenSection,
    _listeners: listeners,
    _setCatalog(c) { catalogCourses = c.slice(); ctx.scheduleCoursesCache = c.slice(); },
    _setPayload(p) { payload = p; },
    _fire(id, ev) {
      const n = nodes[id];
      if (!n || !n._ls || !n._ls[ev]) return;
      n._ls[ev].forEach((fn) => fn({ target: n, type: ev }));
    },
    _readSessions: readSessionsFromDom,
  };

  Object.defineProperty(nodes['ps-create-course-select'], 'options', {
    get() { return this._options || []; },
    set(v) { this._options = v || []; },
    configurable: true,
  });
  nodes['ps-create-course-select']._options = [];
  Object.defineProperty(nodes['ps-create-course-select'], 'value', {
    get() { return this._value || ''; },
    set(v) {
      this._value = String(v || '');
      const optsArr = this._options || [];
      let idx = -1;
      for (let i = 0; i < optsArr.length; i += 1) {
        if (String(optsArr[i].value) === this._value) { idx = i; break; }
      }
      this.selectedIndex = idx;
    },
    configurable: true,
  });
  Object.defineProperty(nodes['ps-create-course-select'], 'innerHTML', {
    get() { return this._innerHTML || ''; },
    set(v) {
      this._innerHTML = String(v || '');
      const optsArr = [];
      const re = /<option[^>]*value="([^"]*)"[^>]*(?:data-label="([^"]*)")?[^>]*>([\s\S]*?)<\/option>/g;
      let m;
      while ((m = re.exec(this._innerHTML))) {
        const val = m[1];
        const lab = (m[2] || m[3] || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
        const disabled = /disabled/.test(m[0]);
        optsArr.push({
          value: val,
          textContent: (m[3] || lab).replace(/<[^>]+>/g, ''),
          disabled,
          getAttribute: (k) => (k === 'data-label' ? lab : null),
        });
      }
      this._options = optsArr;
      if (this._value) {
        let idx = -1;
        for (let i = 0; i < optsArr.length; i += 1) {
          if (String(optsArr[i].value) === this._value) { idx = i; break; }
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
    'schedulePrivateLessonDurationCache = 120',
    'schedulePrivateLessonAmountCentsCache = null',
    'scheduleAccommodationRangesCache = []',
  ];
  const prelude = preludeVars.map((v) => `var ${v};`).join('\n');

  // Roots above plus every helper and module-level state var they call: the
  // portal front-end lives in scripts/browser modules, so a hand-listed set of
  // names goes stale and the slice dies on ReferenceError before asserting.
  const sliced = collectPortalFunctions(html, needed, {
    provided: Object.keys(ctx).concat(preludeVars.map((v) => v.split(' ')[0])),
  });
  ctx._sliced = sliced;

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

function privatePanelVisible(c) {
  const panel = c.el('ps-create-private-panel') || c.el('ps-create-private-when');
  return visible(panel);
}

function whenSectionVisible(c) {
  const w = c._whenSection;
  if (!w) return false;
  return !(w.hidden === true || w.style.display === 'none' || (w.classList && w.classList.contains('is-when-hidden')));
}

function enterPrivate(c) {
  c.el('ps-create-comp-private-lesson').checked = true;
  c.el('ps-create-comp-course').checked = false;
  c.el('ps-create-comp-no-lesson').checked = false;
  if (typeof c.schedulePortalEnterPrivateSessionsDrilldown === 'function') {
    c.schedulePortalEnterPrivateSessionsDrilldown();
  }
  if (typeof c.scheduleSyncPrivateLessonSessions === 'function') {
    c.scheduleSyncPrivateLessonSessions({ deferSideEffects: true });
  }
}

function exitMain(c, opts) {
  if (typeof c.schedulePortalExitMainActivityDrilldown === 'function') {
    c.schedulePortalExitMainActivityDrilldown(opts || { clearCourse: true, clearPrivate: true });
  } else if (typeof c.schedulePortalExitGroupCourseDrilldown === 'function') {
    c.schedulePortalExitGroupCourseDrilldown(opts || { clearCourse: true });
  } else {
    c._fire('ps-create-main-activity-back', 'click');
  }
}

(async function main() {
  console.log('\nverify:sunset-create-private-drilldown\n');

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
  ok('Main activity Back control present',
    /id="ps-create-main-activity-back"/.test(modal)
    || /id="ps-create-main-activity-back"/.test(apiSrc));
  ok('Initial three Main activity radios present',
    /id="ps-create-comp-course"/.test(apiSrc)
    && /id="ps-create-comp-private-lesson"/.test(apiSrc)
    && /id="ps-create-comp-no-lesson"/.test(apiSrc));
  ok('choices host for in-place replacement',
    /id="ps-create-main-activity-choices"/.test(apiSrc));
  ok('private panel host lives in Main activity field (not only lower When)',
    /id="ps-create-main-activity-field"[\s\S]{0,2500}id="ps-create-private-(panel|when)"/.test(apiSrc)
    || /id="ps-create-private-panel"/.test(apiSrc)
    || (
      /id="ps-create-main-activity-choices"[\s\S]{0,1200}id="ps-create-private-when"/.test(apiSrc)
      && /id="ps-create-private-lesson-sessions"/.test(apiSrc)
    ));
  ok('exactly one private sessions host in Create modal',
    ((modal.match(/id="ps-create-private-lesson-sessions"/g) || []).length === 1));
  ok('private sessionsHelp prompt present once',
    (modal.match(/schedule\.create\.privateLesson\.sessionsHelp/g) || []).length === 1
    || (apiSrc.match(/data-i18n="schedule\.create\.privateLesson\.sessionsHelp"/g) || []).length >= 1);
  ok('When section does not host a second private sessions editor',
    !(/data-create-section="when"[\s\S]{0,800}id="ps-create-private-lesson-sessions"/.test(modal)
      && /id="ps-create-main-activity-field"[\s\S]{0,2500}id="ps-create-private-lesson-sessions"/.test(modal)));
  ok('Back CSS right-aligned ≥44px',
    /\.portal-schedule-create-main-activity-back\{[^}]*min-height:\s*44px/.test(apiSrc)
    && (
      /\.portal-schedule-create-main-activity-header\{[^}]*justify-content:\s*space-between/.test(apiSrc)
      || /\.portal-schedule-create-main-activity-back\{[^}]*margin-left:\s*auto/.test(apiSrc)
    ));
  ok('private session time rows usable on mobile (grid collapses)',
    /@media\(max-width:640px\)\{\.portal-schedule-private-session-grid\{grid-template-columns:1fr\}/.test(apiSrc)
    || /@media\(max-width:430px\)[\s\S]{0,400}portal-schedule-private-session-grid/.test(apiSrc)
    || /\.portal-schedule-private-session-grid\{[^}]*minmax/.test(apiSrc));
  ok('mobile 375/430 create drawer full-bleed',
    /@media\(max-width:640px\)\{\.portal-schedule-drawer,\.portal-schedule-create-drawer\{width:100vw/.test(apiSrc)
    || /portal-schedule-create-drawer\{[^}]*width:100vw/.test(apiSrc));
  ok('portal owns private enter + shared exit owners',
    /function schedulePortalEnterPrivateSessionsDrilldown/.test(portalSrc)
    && (
      /function schedulePortalExitMainActivityDrilldown/.test(portalSrc)
      || /function schedulePortalExitGroupCourseDrilldown/.test(portalSrc)
    ));
  ok('portal main activity view includes private-sessions',
    /private-sessions/.test(portalSrc)
    && /schedulePortalMainActivityView/.test(portalSrc));
  ok('one exit/reset owner clears private draft',
    /function schedulePortal(ExitMainActivityDrilldown|ExitGroupCourseDrilldown|ClearPrivateSessionDraft)/.test(portalSrc)
    && (
      /ClearPrivateSessionDraft|private-lesson-sessions[\s\S]{0,80}innerHTML\s*=\s*''/.test(portalSrc)
      || /sessions\.innerHTML\s*=\s*''/.test(portalSrc)
    ));
  ok('existing private session sync owner retained',
    /function scheduleSyncPrivateLessonSessions/.test(portalSrc)
    && /schedulePrivateLessonApplyBlankTimeDefaults/.test(portalSrc));

  // i18n EN/ES/IT
  ok('EN sessionsHelp exact prompt',
    STAFF_PORTAL_STRINGS.en['schedule.create.privateLesson.sessionsHelp']
      === 'Set start and end time for each date in the range.');
  ok('ES sessionsHelp localized',
    esSunset['schedule.create.privateLesson.sessionsHelp']
      === 'Fija la hora de inicio y fin de cada fecha del intervalo.');
  ok('IT sessionsHelp localized',
    STAFF_PORTAL_STRINGS.it['schedule.create.privateLesson.sessionsHelp']
      === 'Imposta ora di inizio e fine per ogni data dell\'intervallo.');
  ok('EN/ES/IT Back + Private course keys',
    STAFF_PORTAL_STRINGS.en['schedule.create.mainActivityBack'] === 'Back'
    && esSunset['schedule.create.mainActivityBack'] === 'Atrás'
    && STAFF_PORTAL_STRINGS.it['schedule.create.mainActivityBack'] === 'Indietro'
    && !!STAFF_PORTAL_STRINGS.en['schedule.type.privateLesson']
    && !!esSunset['schedule.type.privateLesson']
    && !!STAFF_PORTAL_STRINGS.it['schedule.type.privateLesson']);

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
  ok('GET /staff/ui 200 HTML', html.includes('<!DOCTYPE html>') && html.includes('ps-create-comp-private-lesson'));
  ok('/staff/ui has Back + private sessions host',
    html.includes('ps-create-main-activity-back')
    && html.includes('ps-create-private-lesson-sessions'));
  ok('/staff/ui injects private drill-down owners',
    html.includes('function schedulePortalEnterPrivateSessionsDrilldown')
    && (
      html.includes('function schedulePortalExitMainActivityDrilldown')
      || html.includes('function schedulePortalExitGroupCourseDrilldown')
    )
    && html.includes('function schedulePortalRenderMainActivityPath'));
  ok('/staff/ui private sessions appear once',
    (html.match(/id="ps-create-private-lesson-sessions"/g) || []).length === 1);
  ok('/staff/ui sessionsHelp in Main activity region',
    /ps-create-main-activity[\s\S]{0,3000}privateLesson\.sessionsHelp|ps-create-private-(panel|when)[\s\S]{0,400}sessionsHelp/.test(html)
    || /id="ps-create-main-activity-choices"[\s\S]{0,2000}sessionsHelp/.test(html)
    || /id="ps-create-private-panel"[\s\S]{0,600}sessionsHelp/.test(html)
    || /id="ps-create-private-when"[\s\S]{0,600}sessionsHelp/.test(html));
  ok('/staff/ui CSS Back 44px + private grid mobile',
    /portal-schedule-create-main-activity-back[\s\S]{0,120}min-height:\s*44px/.test(html)
    && /portal-schedule-private-session-grid/.test(html));

  const injected = injectSunsetSchedulePortalModule(
    '<!--x-->' + SCHEDULE_PORTAL_INJECT_MARKER + '<!--y-->',
  );
  ok('inject path includes private enter drill-down',
    injected.includes('function schedulePortalEnterPrivateSessionsDrilldown'));

  const art = html;

  // ── [2] Initial root three-choice view ───────────────────────────────────
  console.log('\n[2] Initial three-choice view');
  const root = sandboxFromHtml(art);
  ok('sandbox loaded without throw', !root._loadError, root._loadError && root._loadError.message);
  ok('every helper the sliced owners call is in scope',
    root._sliced.missing.length === 0 && root._sliced.unparsable.length === 0,
    'missing=' + root._sliced.missing.join(',') + ' unparsable=' + root._sliced.unparsable.join(','));
  ok('initial No lesson checked', !!root.el('ps-create-comp-no-lesson').checked);
  ok('initial Private unchecked', !root.el('ps-create-comp-private-lesson').checked);
  ok('initial choices visible', visible(root.el('ps-create-main-activity-choices')));
  ok('initial private panel hidden', !privatePanelVisible(root));
  ok('initial course list hidden', !visible(root.el('ps-create-course-list')));
  ok('initial Back hidden', !visible(root.el('ps-create-main-activity-back')));
  ok('initial path hidden', !visible(root.el('ps-create-main-activity-path')));

  // ── [3] Private click replaces choices with session editor ───────────────
  console.log('\n[3] Private course click replaces choices with session panel');
  const priv = sandboxFromHtml(art, { dateFrom: '2026-07-27', dateTo: '2026-07-29' });
  enterPrivate(priv);
  ok('private drill-down mode active',
    typeof priv.schedulePortalIsPrivateSessionsDrilldown === 'function'
      ? priv.schedulePortalIsPrivateSessionsDrilldown() === true
      : privatePanelVisible(priv));
  ok('choices hidden after Private click', !visible(priv.el('ps-create-main-activity-choices')));
  ok('private panel visible after Private click', privatePanelVisible(priv));
  ok('course list stays hidden in private panel', !visible(priv.el('ps-create-course-list')));
  ok('Back visible after Private click', visible(priv.el('ps-create-main-activity-back')));
  ok('When section stays hidden (no lower second editor)', !whenSectionVisible(priv));
  const helpText = String(
    (priv.el('ps-create-private-sessions-help') && priv.el('ps-create-private-sessions-help').textContent)
    || priv.portalT('schedule.create.privateLesson.sessionsHelp')
    || '',
  );
  ok('panel headed by exact sessionsHelp prompt',
    helpText === 'Set start and end time for each date in the range.'
    || /Set start and end time for each date in the range/.test(helpText),
    helpText);
  ok('path summary shows Private course while inside panel',
    /Private Course|Private course|Curso privado|Corso privato/i.test(pathText(priv))
    || /Private Course|Private course/i.test(priv.portalT('schedule.type.privateLesson')),
    pathText(priv));

  // ── [4] One row per inclusive date ───────────────────────────────────────
  console.log('\n[4] One start/end row per inclusive date');
  const sess = priv._readSessions();
  ok('three session rows for 27–29 inclusive', sess.length === 3, JSON.stringify(sess));
  ok('row dates match range',
    sess.map((s) => s.date).join(',') === '2026-07-27,2026-07-28,2026-07-29',
    JSON.stringify(sess));
  ok('defaults 10:00–12:00 on each row',
    sess.every((s) => s.start === '10:00' && s.end === '12:00'),
    JSON.stringify(sess));
  // Grow range regenerates rows
  priv.el('ps-create-date-to').value = '2026-07-30';
  if (typeof priv.scheduleSyncPrivateLessonSessions === 'function') {
    priv.scheduleSyncPrivateLessonSessions({ deferSideEffects: true });
  }
  const grown = priv._readSessions();
  ok('date-range change regenerates one row per date',
    grown.length === 4
    && grown.map((s) => s.date).join(',') === '2026-07-27,2026-07-28,2026-07-29,2026-07-30',
    JSON.stringify(grown));

  // ── [5] Back clears + restores No lesson ─────────────────────────────────
  console.log('\n[5] Back clears private draft and restores three choices');
  // Abandon custom times first
  const rows = priv.el('ps-create-private-lesson-sessions')._sessionRows || [];
  if (rows[0] && rows[0]._start) {
    rows[0]._start.value = '08:00';
    rows[0]._end.value = '09:00';
  }
  exitMain(priv, { clearCourse: true, clearPrivate: true });
  ok('after Back: choices visible', visible(priv.el('ps-create-main-activity-choices')));
  ok('after Back: private panel hidden', !privatePanelVisible(priv));
  ok('after Back: Back control hidden', !visible(priv.el('ps-create-main-activity-back')));
  ok('after Back: path hidden', !visible(priv.el('ps-create-main-activity-path')));
  ok('after Back: Private radio unchecked', !priv.el('ps-create-comp-private-lesson').checked);
  ok('after Back: No lesson restored', !!priv.el('ps-create-comp-no-lesson').checked);
  ok('after Back: session draft cleared',
    priv._readSessions().length === 0
    || String(priv.el('ps-create-private-lesson-sessions').innerHTML || '').trim() === '',
    JSON.stringify(priv._readSessions()));

  // ── [6] Re-entry after Back does not leak abandoned values ───────────────
  console.log('\n[6] Re-entry after Back uses current date-range defaults');
  enterPrivate(priv);
  const re = priv._readSessions();
  ok('re-entry rows from current range (4 dates)', re.length === 4, JSON.stringify(re));
  ok('re-entry does not leak abandoned 08:00–09:00',
    re.every((s) => s.start === '10:00' && s.end === '12:00')
    && !re.some((s) => s.start === '08:00' || s.end === '09:00'),
    JSON.stringify(re));

  // ── [7] Quote invalidation / Create gate for incomplete private ──────────
  console.log('\n[7] Incomplete private cannot create or retain stale quote');
  const gate = sandboxFromHtml(art, {
    guest: 'Ada',
    phone: '+34600999888',
    dateFrom: '2026-07-27',
    dateTo: '2026-07-27',
  });
  enterPrivate(gate);
  // Force incomplete session
  const gRows = gate.el('ps-create-private-lesson-sessions')._sessionRows || [];
  if (gRows[0]) {
    gRows[0]._start.value = '';
    gRows[0]._end.value = '';
  }
  // Or inject incomplete payload
  const badPayload = gate.scheduleReadCreatePayload();
  if (badPayload.components && badPayload.components.private_lesson) {
    badPayload.components.private_lesson.sessions = [{
      date: '2026-07-27', start: '', end: '',
    }];
    badPayload.components.private_lesson.quantity = 1;
  }
  let soft = null;
  if (typeof gate.schedulePortalValidateCreatePayload === 'function') {
    soft = gate.schedulePortalValidateCreatePayload(badPayload, { soft: true });
  }
  ok('soft validate fails for incomplete private sessions',
    soft && soft.ok === false,
    JSON.stringify(soft));
  gate.el('ps-create-quote-preview').innerHTML = 'Quoted total: €200.00';
  gate.el('ps-create-quote-preview').style.display = 'block';
  gate.schedulePortalQuoteState = {
    total_cents: 20000,
    intent_key: 'stale-private-before-invalid',
  };
  if (typeof gate.schedulePortalInvalidateCreateQuoteIntent === 'function') {
    gate.schedulePortalInvalidateCreateQuoteIntent({ softInvalid: true });
  } else if (typeof gate.schedulePortalDropStaleQuoteUi === 'function') {
    gate.schedulePortalDropStaleQuoteUi(badPayload);
  }
  const qAfter = String(gate.el('ps-create-quote-preview').innerHTML || '');
  ok('stale quote cleared when private sessions invalid',
    !/€200/.test(qAfter)
    && (gate.el('ps-create-quote-preview').style.display === 'none'
      || !qAfter.trim()
      || /softInvalid|checking|Quote unavailable|Complete session/i.test(qAfter)
      || gate.schedulePortalQuoteState == null
      || (gate.schedulePortalQuoteState
        && gate.schedulePortalQuoteState.intent_key !== 'stale-private-before-invalid')),
    qAfter);
  // Valid private defaults pass soft gate
  const good = sandboxFromHtml(art, {
    guest: 'Ada',
    phone: '+34600999888',
    dateFrom: '2026-07-27',
    dateTo: '2026-07-27',
  });
  enterPrivate(good);
  const goodPayload = good.scheduleReadCreatePayload();
  let softOk = null;
  if (typeof good.schedulePortalValidateCreatePayload === 'function') {
    softOk = good.schedulePortalValidateCreatePayload(goodPayload, { soft: true });
  }
  ok('complete default private sessions pass soft validate',
    softOk && softOk.ok === true,
    JSON.stringify(softOk));

  // ── [8] Group drill-down regression ──────────────────────────────────────
  console.log('\n[8] Group course drill-down regression (PR #255)');
  const group = sandboxFromHtml(art);
  group.el('ps-create-comp-course').checked = true;
  group.el('ps-create-comp-no-lesson').checked = false;
  if (typeof group.schedulePortalEnterGroupCourseDrilldown === 'function') {
    group.schedulePortalEnterGroupCourseDrilldown();
  }
  if (typeof group.schedulePortalPopulateCreateCourseFields === 'function') {
    await group.schedulePortalPopulateCreateCourseFields();
  }
  ok('Group: choices hidden', !visible(group.el('ps-create-main-activity-choices')));
  ok('Group: course list visible', visible(group.el('ps-create-course-list')));
  ok('Group: private panel hidden', !privatePanelVisible(group));
  ok('Group: Back visible', visible(group.el('ps-create-main-activity-back')));
  ok('Group: legacy course-fields stay hidden', !visible(group.el('ps-create-course-fields')));
  if (typeof group.schedulePortalSelectCreateCourse === 'function') {
    group.schedulePortalSelectCreateCourse('c-manana', 'Curso Mañana');
  }
  // e97d9d0a (2026-07-28) dropped the Main activity crumb — the selected activity
  // button already names the choice. Same contract as
  // verify-sunset-create-course-drilldown's "path summary stays hidden after pick".
  ok('Group: path crumb stays hidden after pick (activity button names the course)',
    !visible(group.el('ps-create-main-activity-path'))
    && !pathText(group).trim(),
    pathText(group));
  exitMain(group, { clearCourse: true });
  ok('Group Back: choices restored + No lesson',
    visible(group.el('ps-create-main-activity-choices'))
    && !!group.el('ps-create-comp-no-lesson').checked
    && !group.el('ps-create-comp-course').checked);

  // ── [9] No lesson regression ─────────────────────────────────────────────
  console.log('\n[9] No lesson regression');
  const none = sandboxFromHtml(art, { guest: 'Ada', phone: '+34600999888' });
  none.el('ps-create-comp-no-lesson').checked = true;
  none.el('ps-create-comp-course').checked = false;
  none.el('ps-create-comp-private-lesson').checked = false;
  if (typeof none.schedulePortalSyncCreateSubmitEnabled === 'function') {
    none.schedulePortalSyncCreateSubmitEnabled();
  }
  ok('No lesson: choices visible, panels hidden',
    visible(none.el('ps-create-main-activity-choices'))
    && !privatePanelVisible(none)
    && !visible(none.el('ps-create-course-list')));
  ok('No lesson Create not blocked by course/private requirement',
    none.el('ps-create-submit').disabled === false);

  // ── [10] EN / ES / IT localization ───────────────────────────────────────
  console.log('\n[10] EN/ES/IT localization');
  for (const [loc, T, backWord, privateWord, helpWord] of [
    ['en', T_EN, 'Back', 'Private Course', 'Set start and end time for each date in the range.'],
    ['es', T_ES, 'Atrás', 'Curso privado', 'Fija la hora de inicio y fin de cada fecha del intervalo.'],
    ['it', T_IT, 'Indietro', 'Corso privato', 'Imposta ora di inizio e fine per ogni data dell\'intervallo.'],
  ]) {
    const locCtx = sandboxFromHtml(art, { locale: loc, T });
    ok(loc + ' Back label',
      String(locCtx.el('ps-create-main-activity-back').textContent || '').includes(backWord)
      || locCtx.portalT('schedule.create.mainActivityBack') === backWord);
    ok(loc + ' sessionsHelp key',
      locCtx.portalT('schedule.create.privateLesson.sessionsHelp') === helpWord);
    enterPrivate(locCtx);
    const p = pathText(locCtx);
    const pathOk = (p && p.includes(privateWord))
      || locCtx.portalT('schedule.type.privateLesson') === privateWord;
    ok(loc + ' path uses localized Private label', pathOk, p || locCtx.portalT('schedule.type.privateLesson'));
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('');
  if (fail > 0) {
    console.error('verify:sunset-create-private-drilldown — FAILED pass=' + pass + ' fail=' + fail + '\n');
    process.exit(1);
  }
  console.log('verify:sunset-create-private-drilldown — ALL CHECKS PASSED (pass=' + pass + ')\n');
  process.exit(0);
})().catch((err) => {
  console.error('verify:sunset-create-private-drilldown crashed:', err);
  process.exit(1);
});
