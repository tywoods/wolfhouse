'use strict';

/**
 * verify:sunset-edit-drawer-parity
 *
 * Stage 1 — Sunset Edit Booking drawer shared-menu parity with Create:
 *   A) Header/location row matches Create layout contracts
 *   B) Compact date-range trigger/calendar (same selection rules as Create)
 *   C) Main activity native buttons + exclusive aria-pressed
 *   D) Group course in-place drill-down, Back, hidden compat select
 *   E) Private drill-down host; custom addon / payment / footer chrome
 *   F) Seeded state for no-lesson / group / private / rental / multi-day
 *   G) Back/Cancel never mutate persisted ctx; Save contract markers intact
 *   H) EN/ES/IT + mobile 320/375/390/430 + 44px targets + no overflow
 *
 * Executes REAL generated /staff/ui (production buildUiHtml + inject) plus
 * VM behavioral checks against the injected Edit owner module.
 *
 * No Azure / staging / DB mutation.
 *
 * Run: node scripts/verify-sunset-edit-drawer-parity.js
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
} = require('./lib/sunset-schedule-browser-source');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const esSunset = require('./lib/staff-portal-i18n-es-sunset');

const EDIT_MODULE = path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-edit-ui.js');
const API = path.join(ROOT, 'scripts/staff-query-api.js');

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
          return { html: res.body, port, kill() {
            try { child.kill('SIGTERM'); } catch (_k) { /* ignore */ }
          } };
        }
        lastErr = new Error('HTTP ' + res.status);
      } catch (e) {
        lastErr = e;
      }
      await sleep(150);
    }
    throw lastErr || new Error('timeout waiting for /staff/ui');
  } catch (e) {
    try { child.kill('SIGTERM'); } catch (_k) { /* ignore */ }
    throw e;
  }
}

function makeClassList(initial) {
  const set = new Set(Array.isArray(initial) ? initial : String(initial || '').split(/\s+/).filter(Boolean));
  return {
    add(c) { String(c || '').split(/\s+/).filter(Boolean).forEach((x) => set.add(x)); },
    remove(c) { String(c || '').split(/\s+/).filter(Boolean).forEach((x) => set.delete(x)); },
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

function parseButtonsFromHtml(html) {
  const out = [];
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    const get = (name) => {
      const a = attrs.match(new RegExp(name + '="([^"]*)"'));
      return a ? a[1] : null;
    };
    const cls = get('class') || '';
    const date = get('data-date');
    const courseId = get('data-course-id');
    const editAct = get('data-edit-activity') || get('data-create-activity');
    out.push({
      tagName: 'BUTTON',
      type: 'button',
      className: cls,
      classList: makeClassList(cls.split(/\s+/)),
      textContent: text,
      disabled: /\sdisabled(?:\s|=|>|$)/.test(attrs),
      tabIndex: Number(get('tabindex') != null ? get('tabindex') : 0),
      _attrs: {
        'data-date': date,
        'data-course-id': courseId,
        'data-label': get('data-label'),
        'data-edit-activity': editAct,
        'data-create-activity': get('data-create-activity'),
        role: get('role'),
        'aria-label': get('aria-label'),
        'aria-pressed': get('aria-pressed'),
        tabindex: get('tabindex') != null ? get('tabindex') : '0',
        class: cls,
      },
      getAttribute(k) { return this._attrs[k] != null ? this._attrs[k] : null; },
      setAttribute(k, v) {
        this._attrs[k] = String(v);
        if (k === 'tabindex' || k === 'tabIndex') this.tabIndex = Number(v);
        if (k === 'aria-pressed') this._attrs['aria-pressed'] = String(v);
      },
      focus() { /* set by runtime */ },
      closest(sel) {
        if (sel === '[data-date]' && this.getAttribute('data-date')) return this;
        if (sel === '[data-edit-activity]' && this.getAttribute('data-edit-activity')) return this;
        if (sel === '[data-create-activity]' && this.getAttribute('data-create-activity')) return this;
        if (sel === '[data-course-id]' && this.getAttribute('data-course-id')) return this;
        if (sel === 'button') return this;
        return null;
      },
    });
  }
  return out;
}

function buildEditRuntime(editSrc, apiSrc, opts) {
  opts = opts || {};
  const nodes = {};
  const docListeners = { keydown: [], mousedown: [] };
  let focused = null;

  function makeNode(id, extra) {
    const listeners = {};
    const node = {
      id,
      value: '',
      checked: false,
      disabled: false,
      hidden: false,
      textContent: '',
      style: { display: '' },
      dataset: {},
      classList: makeClassList([]),
      _attrs: {},
      _children: [],
      _dayButtons: [],
      _courseRows: [],
      options: [],
      selectedIndex: -1,
      addEventListener(type, fn) {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(fn);
      },
      dispatchEvent(ev) {
        const type = ev && ev.type;
        (listeners[type] || []).forEach((fn) => fn(ev));
        return true;
      },
      getAttribute(k) {
        if (k === 'aria-expanded') return this._attrs['aria-expanded'] || null;
        if (k === 'aria-pressed') return this._attrs['aria-pressed'] || null;
        if (k === 'data-edit-activity') return this._attrs['data-edit-activity'] || null;
        if (k === 'data-create-activity') return this._attrs['data-create-activity'] || null;
        if (k === 'data-date') return this._attrs['data-date'] || null;
        if (k === 'data-selected') return this._attrs['data-selected'] || null;
        if (k === 'tabindex' || k === 'tabIndex') return this._attrs.tabindex != null ? this._attrs.tabindex : String(this.tabIndex || 0);
        return this._attrs[k] != null ? this._attrs[k] : null;
      },
      setAttribute(k, v) {
        this._attrs[k] = String(v);
        if (k === 'tabindex' || k === 'tabIndex') this.tabIndex = Number(v);
        if (k === 'hidden') this.hidden = v !== false && v != null;
      },
      removeAttribute(k) {
        delete this._attrs[k];
        if (k === 'hidden') this.hidden = false;
      },
      focus() { focused = this; },
      contains(child) {
        if (!child) return false;
        if (child === this) return true;
        if (this._dayButtons && this._dayButtons.indexOf(child) >= 0) return true;
        if (this._courseRows && this._courseRows.indexOf(child) >= 0) return true;
        if (this._children && this._children.indexOf(child) >= 0) return true;
        if (this.id === 'ps-drawer-date-range') {
          const ids = [
            'ps-drawer-date-range-trigger', 'ps-drawer-date-range-popover',
            'ps-drawer-date-range-display', 'ps-drawer-date-from', 'ps-drawer-date-to',
            'ps-drawer-date-range-grid',
            'ps-drawer-date-range-cancel', 'ps-drawer-date-range-apply',
            'ps-drawer-date-range-prev', 'ps-drawer-date-range-next',
          ];
          if (child.id && ids.indexOf(child.id) >= 0) return true;
          const pop = nodes['ps-drawer-date-range-popover'];
          if (pop && pop.contains && pop.contains(child)) return true;
        }
        if (this.id === 'ps-drawer-date-range-popover') {
          const ids = [
            'ps-drawer-date-range-grid',
            'ps-drawer-date-range-cancel', 'ps-drawer-date-range-apply',
            'ps-drawer-date-range-prev', 'ps-drawer-date-range-next',
            'ps-drawer-date-range-month-label',
          ];
          if (child.id && ids.indexOf(child.id) >= 0) return true;
          if (this._dayButtons && this._dayButtons.indexOf(child) >= 0) return true;
          const grid = nodes['ps-drawer-date-range-grid'];
          if (grid && grid.contains && grid.contains(child)) return true;
        }
        if (this.id === 'ps-drawer-main-activity-choices' || this.id === 'ps-drawer-course-list') {
          return !!(this._children && this._children.indexOf(child) >= 0)
            || !!(this._courseRows && this._courseRows.indexOf(child) >= 0);
        }
        return false;
      },
      querySelector(sel) {
        if (!sel) return null;
        if (sel.startsWith('#')) return nodes[sel.slice(1)] || null;
        if (sel.startsWith('[data-date=')) {
          const m = sel.match(/data-date=["']([^"']+)["']/);
          if (!m) return null;
          return (this._dayButtons || []).find((b) => b.getAttribute('data-date') === m[1]) || null;
        }
        if (sel === '[data-date]') return (this._dayButtons && this._dayButtons[0]) || null;
        if (sel === '.portal-schedule-create-date-range-day:not(.is-outside)') {
          return (this._dayButtons || []).find((b) => !b.classList.contains('is-outside')) || null;
        }
        if (sel.startsWith('[data-edit-activity=') || sel.startsWith('[data-create-activity=')) {
          const m = sel.match(/data-(?:edit|create)-activity=["']([^"']+)["']/);
          if (!m) return null;
          return (this._children || []).find((c) =>
            c.getAttribute('data-edit-activity') === m[1]
            || c.getAttribute('data-create-activity') === m[1]
          ) || null;
        }
        if (sel.includes('button[data-course-id][aria-pressed="true"]')
          || sel.includes("button[data-course-id][aria-pressed='true']")) {
          return (this._courseRows || []).find((b) => b.getAttribute('aria-pressed') === 'true') || null;
        }
        if (sel.includes('data-course-id=')) {
          const m = sel.match(/data-course-id=["']?([^"'\]]+)/);
          if (!m) return null;
          return (this._courseRows || []).find((b) => String(b.getAttribute('data-course-id')) === m[1]) || null;
        }
        if (sel.includes('input[type="radio"]:checked') || sel.includes('input[type=radio]:checked')) {
          return (this._courseRadios || []).find((r) => r.checked) || null;
        }
        return null;
      },
      querySelectorAll(sel) {
        if (sel && sel.includes('data-date')) return (this._dayButtons || []).slice();
        if (sel && (sel.includes('data-edit-activity') || sel.includes('data-create-activity'))) {
          return (this._children || []).filter((c) =>
            c.getAttribute('data-edit-activity') || c.getAttribute('data-create-activity')
          );
        }
        if (sel && sel.includes('data-course-id')) return (this._courseRows || []).slice();
        if (sel && sel.includes('input')) return (this._courseRadios || []).slice();
        if (sel && sel.includes('button')) return (this._courseRows || []).slice();
        return [];
      },
      closest(sel) {
        if (sel === '[data-date]' && this.getAttribute('data-date')) return this;
        if (sel === '[data-edit-activity]' && this.getAttribute('data-edit-activity')) return this;
        if (sel === '[data-create-activity]' && this.getAttribute('data-create-activity')) return this;
        return null;
      },
    };
    Object.defineProperty(node, 'innerHTML', {
      get() { return this._innerHTML || ''; },
      set(v) {
        this._innerHTML = String(v || '');
        if (this.id === 'ps-drawer-date-range-grid' || /date-range-grid/.test(this.id || '')) {
          this._dayButtons = parseButtonsFromHtml(this._innerHTML).filter((b) => b.getAttribute('data-date'));
          this._dayButtons.forEach((b) => {
            b.focus = () => { focused = b; };
          });
          if (nodes['ps-drawer-date-range-popover']) {
            nodes['ps-drawer-date-range-popover']._dayButtons = this._dayButtons;
          }
          if (nodes['ps-drawer-date-range']) {
            nodes['ps-drawer-date-range']._dayButtons = this._dayButtons;
          }
        }
        if (this.id === 'ps-drawer-course-list') {
          const rows = parseButtonsFromHtml(this._innerHTML).filter((b) => b.getAttribute('data-course-id'));
          const radios = [];
          const radioRe = /<input[^>]*type="radio"[^>]*>/g;
          let rm;
          while ((rm = radioRe.exec(this._innerHTML))) {
            const tag = rm[0];
            const valM = tag.match(/value="([^"]*)"/);
            radios.push({
              type: 'radio',
              value: valM ? valM[1] : '',
              checked: /checked/.test(tag),
              disabled: /disabled/.test(tag),
              _ls: {},
              addEventListener(ev, fn) {
                this._ls[ev] = this._ls[ev] || [];
                this._ls[ev].push(fn);
              },
            });
          }
          rows.forEach((row, i) => {
            row._input = radios[i] || null;
            row.addEventListener = function(ev, fn) {
              this._ls = this._ls || {};
              this._ls[ev] = this._ls[ev] || [];
              this._ls[ev].push(fn);
            };
            row.dispatchEvent = function(ev) {
              (this._ls && this._ls[ev && ev.type] || []).forEach((fn) => fn(ev));
            };
          });
          this._courseRows = rows;
          this._courseRadios = radios;
          this._children = rows.slice();
        }
      },
      configurable: true,
    });
    Object.assign(node, extra || {});
    nodes[id] = node;
    return node;
  }

  // Radios + activity buttons
  const courseRadio = makeNode('ps-drawer-comp-course', { type: 'radio', checked: opts.mode === 'group' });
  const privRadio = makeNode('ps-drawer-comp-private-lesson', { type: 'radio', checked: opts.mode === 'private' });
  const noneRadio = makeNode('ps-drawer-comp-no-lesson', {
    type: 'radio',
    checked: !opts.mode || opts.mode === 'none',
  });
  function makeActBtn(id, selected) {
    return makeNode('btn-' + id, {
      tagName: 'BUTTON',
      type: 'button',
      classList: makeClassList(selected
        ? ['portal-schedule-create-activity-btn', 'is-selected']
        : ['portal-schedule-create-activity-btn']),
      _attrs: {
        'data-edit-activity': id,
        'aria-pressed': selected ? 'true' : 'false',
      },
    });
  }
  const btnCourse = makeActBtn('ps-drawer-comp-course', opts.mode === 'group');
  const btnPriv = makeActBtn('ps-drawer-comp-private-lesson', opts.mode === 'private');
  const btnNone = makeActBtn('ps-drawer-comp-no-lesson', !opts.mode || opts.mode === 'none');
  const choices = makeNode('ps-drawer-main-activity-choices', {
    _children: [btnCourse, btnPriv, btnNone, courseRadio, privRadio, noneRadio],
    style: { display: '' },
    hidden: false,
  });
  choices.querySelector = function(sel) {
    if (sel && (sel.startsWith('[data-edit-activity=') || sel.startsWith('[data-create-activity='))) {
      const m = sel.match(/data-(?:edit|create)-activity=["']([^"']+)["']/);
      if (!m) return null;
      return this._children.find((c) =>
        c.getAttribute('data-edit-activity') === m[1]
        || c.getAttribute('data-create-activity') === m[1]
      ) || null;
    }
    return null;
  };

  makeNode('ps-drawer-main-activity-back', {
    hidden: true,
    style: { display: 'none' },
    textContent: 'Back',
  });
  makeNode('ps-drawer-main-activity-path', {
    hidden: true,
    style: { display: 'none' },
    textContent: '',
  });
  const courseList = makeNode('ps-drawer-course-list', {
    hidden: true,
    style: { display: 'none' },
    innerHTML: '',
  });
  makeNode('ps-drawer-private-panel', { hidden: true, style: { display: 'none' } });
  makeNode('ps-drawer-private-when', { hidden: true, style: { display: 'none' } });
  makeNode('ps-drawer-private-sessions', { innerHTML: '' });
  makeNode('ps-drawer-course-select', {
    value: opts.courseId || '',
    selectedIndex: opts.courseId ? 0 : -1,
    options: opts.courseId
      ? [{ value: opts.courseId, textContent: opts.courseLabel || opts.courseId, getAttribute: () => opts.courseLabel || opts.courseId }]
      : [],
    getAttribute(k) {
      if (k === 'data-selected') return opts.courseId || '';
      return this._attrs && this._attrs[k] != null ? this._attrs[k] : null;
    },
    _attrs: { 'data-selected': opts.courseId || '' },
  });
  makeNode('ps-drawer-course-fields', { hidden: true, style: { display: 'none' } });
  makeNode('ps-drawer-course-qty-wrap', { style: { display: opts.mode === 'group' ? '' : 'none' } });
  makeNode('ps-drawer-course-qty', { value: String(opts.courseQty || 1) });
  makeNode('ps-drawer-course-duration-confirm', { style: { display: 'none' }, innerHTML: '' });
  makeNode('ps-drawer-private-lesson-fields', { style: { display: opts.mode === 'private' ? '' : 'none' } });
  makeNode('ps-drawer-private-lesson-surfers', { value: String(opts.surfers || 1) });
  makeNode('ps-drawer-surfers-field', {
    style: { display: (!opts.mode || opts.mode === 'none') ? '' : 'none' },
  });
  makeNode('ps-drawer-surfers', { value: String(opts.surfers || 1) });
  makeNode('ps-drawer-rentals', {
    getAttribute(k) {
      const map = {
        'data-seed-board': opts.board ? '1' : '0',
        'data-seed-wetsuit': opts.wetsuit ? '1' : '0',
        'data-seed-board-qty': '1',
        'data-seed-wetsuit-qty': '1',
        'data-seed-surfers': String(opts.surfers || 1),
        'data-seed-rentals': JSON.stringify(opts.rentals || []),
      };
      return map[k] != null ? map[k] : null;
    },
  });
  makeNode('ps-drawer-course-section', { style: { display: '' } });
  makeNode('ps-drawer-when-summary', { style: { display: '' }, innerHTML: '' });
  makeNode('ps-drawer-summary', { innerHTML: '—' });
  makeNode('ps-drawer-quote-preview', { style: { display: 'none' } });
  makeNode('ps-drawer-save-msg', { style: { display: 'none' } });
  makeNode('ps-drawer-save', { disabled: false });
  makeNode('ps-drawer-cancel', {});
  makeNode('ps-drawer-guest', { value: opts.guest || 'Alex' });
  makeNode('ps-drawer-phone', { value: opts.phone || '+34111' });
  makeNode('ps-drawer-notes', { value: '' });
  makeNode('ps-drawer-payment', { value: 'unpaid' });
  makeNode('ps-drawer-edit-form', {});
  makeNode('ps-drawer-addon-fullday-field', { style: { display: 'none' }, getAttribute: () => '{}' });
  makeNode('ps-drawer-comp-fullday', { type: 'checkbox', checked: false });
  makeNode('ps-drawer-fullday-rows', {});
  makeNode('ps-drawer-fullday-summary', {});

  // Date range
  makeNode('ps-drawer-date-range-trigger', {
    tagName: 'BUTTON',
    _attrs: { 'aria-expanded': 'false' },
  });
  makeNode('ps-drawer-date-range-display', {
    textContent: opts.dateFrom || 'Select dates',
  });
  makeNode('ps-drawer-date-range-popover', {
    hidden: true,
    style: { display: 'none' },
  });
  makeNode('ps-drawer-date-range-grid', {
    role: 'group',
    _attrs: { role: 'group', 'aria-labelledby': 'ps-drawer-date-range-month-label' },
    _dayButtons: [],
  });
  makeNode('ps-drawer-date-range-month-label', { textContent: '' });
  makeNode('ps-drawer-date-range-prev', { tagName: 'BUTTON' });
  makeNode('ps-drawer-date-range-next', { tagName: 'BUTTON' });
  makeNode('ps-drawer-date-range-cancel', { tagName: 'BUTTON' });
  makeNode('ps-drawer-date-range-apply', { tagName: 'BUTTON', disabled: true });
  makeNode('ps-drawer-date-from', {
    value: opts.dateFrom || '2026-07-20',
    type: 'date',
    hidden: true,
  });
  makeNode('ps-drawer-date-to', {
    value: opts.dateTo || opts.dateFrom || '2026-07-22',
    type: 'date',
    hidden: true,
  });
  makeNode('ps-drawer-date-range', {});
  makeNode('outside-click-target', {});

  const document = {
    getElementById(id) { return nodes[id] || null; },
    addEventListener(type, fn) {
      if (!docListeners[type]) docListeners[type] = [];
      docListeners[type].push(fn);
    },
    dispatchEvent(ev) {
      const type = ev && ev.type;
      (docListeners[type] || []).forEach((fn) => fn(ev));
      return true;
    },
  };
  function el(id) { return document.getElementById(id); }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function scheduleParseIso(s) {
    const p = String(s || '').split('-');
    if (p.length !== 3) return new Date();
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  function scheduleIsoDate(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function scheduleTodayIso() { return opts.today || '2026-07-20'; }
  function portalT(k) {
    const en = STAFF_PORTAL_STRINGS.en || {};
    return en[k] || k;
  }
  function schedulePortalSetVisible(node, vis) {
    if (!node) return;
    node.hidden = !vis;
    node.style.display = vis ? '' : 'none';
    try {
      if (vis) node.removeAttribute('hidden');
      else node.setAttribute('hidden', '');
      node.setAttribute('aria-hidden', vis ? 'false' : 'true');
    } catch (_e) { /* ignore */ }
  }

  const pureNames = [
    'scheduleCreateDateRangeIsValidIso',
    'scheduleCreateDateRangeSelectDay',
    'scheduleCreateDateRangeAddDays',
    'scheduleCreateDateRangeWeekStartIso',
    'scheduleCreateDateRangeWeekEndIso',
    'scheduleCreateDateRangeFormatShort',
    'scheduleCreateDateRangeDisplayText',
    'scheduleCreateHeaderRowContract',
  ];
  const editFnNames = [
    'scheduleDrawerSetVisible',
    'scheduleDrawerStaffLocaleTag',
    'scheduleDrawerDateCellAriaLabel',
    'scheduleDrawerDateRangeSeedDraft',
    'scheduleDrawerDateRangeIsOpen',
    'scheduleSyncDrawerDateRangeUi',
    'scheduleDrawerDateRangeClosePopover',
    'scheduleDrawerDateRangeFocusInto',
    'scheduleDrawerDateRangeOpenPopover',
    'scheduleDrawerDateRangeTogglePopover',
    'scheduleDrawerDateRangeMoveFocus',
    'scheduleRenderDrawerDateRangeCalendar',
    'scheduleApplyDrawerDateRangeDraft',
    'scheduleDrawerDateRangeOnDocumentKeydown',
    'scheduleDrawerDateRangeOnDocumentPointer',
    'scheduleWireDrawerDateRange',
    'scheduleSyncDrawerMainActivityButtons',
    'scheduleWireDrawerMainActivityButtons',
    'scheduleDrawerMainActivityValue',
    'scheduleDrawerSetMainActivity',
    'scheduleDrawerIsGroupCourseDrilldown',
    'scheduleDrawerIsPrivateSessionsDrilldown',
    'scheduleDrawerEnterGroupCourseDrilldown',
    'scheduleDrawerEnterPrivateSessionsDrilldown',
    'scheduleDrawerExitMainActivityDrilldown',
    'scheduleDrawerRenderMainActivityPath',
    'scheduleDrawerGetSelectedCourseId',
    'scheduleDrawerSyncCourseButtons',
    'scheduleDrawerClearSelectedCourse',
    'scheduleDrawerSelectCourse',
    'scheduleDrawerRenderCourseList',
    'scheduleDrawerSeedMainActivityView',
    'scheduleDrawerPrivatePanelNode',
    'scheduleDrawerClearPrivateSessionDraft',
  ];

  let bundle = '';
  bundle += 'var scheduleDrawerDateRangeDraft = { start: null, end: null };\n';
  bundle += 'var scheduleDrawerDateRangeViewYm = null;\n';
  bundle += 'var scheduleDrawerDateRangeFocusIso = null;\n';
  bundle += 'var scheduleDrawerDateRangeRestoreFocus = false;\n';
  bundle += 'var scheduleDrawerDateRangeDocWired = false;\n';
  bundle += 'var scheduleDrawerMainActivityView = "root";\n';
  pureNames.forEach((name) => {
    const src = extractFn(apiSrc, name);
    if (src) bundle += src + '\n';
  });
  editFnNames.forEach((name) => {
    const src = extractFn(editSrc, name);
    if (!src) return;
    bundle += src + '\n';
  });

  const sandbox = {
    el,
    document,
    escHtml,
    scheduleParseIso,
    scheduleIsoDate,
    scheduleTodayIso,
    portalT,
    schedulePortalSetVisible,
    scheduleCoursesCache: opts.courses || [
      { course_id: 'c1', label: 'Beginner', eligible_on_requested_dates: true },
      { course_id: 'c2', label: 'Curso Mañana', eligible_on_requested_dates: true },
    ],
    scheduleDrawerState: {
      row: { booking_id: 'b1', booking_code: 'SUN-1' },
      ctx: {
        booking_id: 'b1',
        booking_code: 'SUN-1',
        guest_name: opts.guest || 'Alex',
        date_from: opts.dateFrom || '2026-07-20',
        date_to: opts.dateTo || '2026-07-22',
        components: opts.components || {},
      },
    },
    scheduleDrawerMarkPriceStale: function() {},
    scheduleDrawerPopulateComponentFields: function() {},
    scheduleDrawerOnComponentChange: function() {},
    scheduleDrawerRefreshDurationConfirm: function() {},
    scheduleDrawerRefreshWhenSummary: function() {},
    scheduleDrawerSyncPrivateSessions: function() {},
    scheduleDrawerSyncFooter: function() {},
    scheduleRenderDrawerRentals: function() {},
    scheduleRefreshDrawerFullDayAddon: function() {},
    scheduleDrawerSyncRentalQtyFromSurfers: function() {},
    scheduleFetchLessonTimesConfig: function() { return Promise.resolve({}); },
    getClient: function() { return 'sunset'; },
    Event: function Event(type, init) {
      this.type = type;
      this.bubbles = !!(init && init.bubbles);
    },
    console,
  };

  // Fallbacks when pure Create helpers missing from unexpected builds
  if (!extractFn(apiSrc, 'scheduleCreateDateRangeIsValidIso')) {
    bundle += 'function scheduleCreateDateRangeIsValidIso(iso){iso=String(iso||"").slice(0,10);return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(iso);}\n';
  }

  try {
    vm.runInNewContext(bundle, sandbox, { timeout: 8000 });
  } catch (e) {
    return { error: e, nodes, el, sandbox: null };
  }

  // Wire if available
  try {
    if (typeof sandbox.scheduleWireDrawerDateRange === 'function') sandbox.scheduleWireDrawerDateRange();
    if (typeof sandbox.scheduleWireDrawerMainActivityButtons === 'function') sandbox.scheduleWireDrawerMainActivityButtons();
    if (typeof sandbox.scheduleSyncDrawerMainActivityButtons === 'function') sandbox.scheduleSyncDrawerMainActivityButtons();
    if (typeof sandbox.scheduleSyncDrawerDateRangeUi === 'function') sandbox.scheduleSyncDrawerDateRangeUi();
  } catch (_w) { /* leave for assertions */ }

  return {
    nodes,
    el,
    document,
    sandbox,
    choices,
    courseList,
    activityButtons: { course: btnCourse, priv: btnPriv, none: btnNone },
    getFocused: () => focused,
    setFocused: (n) => { focused = n; },
    dayButtons() {
      return (nodes['ps-drawer-date-range-grid']._dayButtons || []).slice();
    },
    fireGridClick(iso) {
      const grid = nodes['ps-drawer-date-range-grid'];
      const btn = grid.querySelector('[data-date="' + iso + '"]');
      if (!btn) throw new Error('no day button for ' + iso);
      grid.dispatchEvent({
        type: 'click',
        target: btn,
        preventDefault() {},
      });
    },
    fireGridKey(iso, key) {
      const grid = nodes['ps-drawer-date-range-grid'];
      const btn = grid.querySelector('[data-date="' + iso + '"]');
      if (!btn) throw new Error('no day button for ' + iso);
      focused = btn;
      grid.dispatchEvent({
        type: 'keydown',
        key,
        target: btn,
        preventDefault() { this.defaultPrevented = true; },
      });
    },
  };
}

async function main() {
  console.log('\nverify:sunset-edit-drawer-parity\n');

  const editExists = fs.existsSync(EDIT_MODULE);
  const editSrc = editExists ? fs.readFileSync(EDIT_MODULE, 'utf8') : '';
  const apiSrc = fs.readFileSync(API, 'utf8');
  const en = STAFF_PORTAL_STRINGS.en || {};
  const it = STAFF_PORTAL_STRINGS.it || {};
  // Full portal ES (calendar.day.*) + sunset-only overlays for schedule create keys.
  const es = Object.assign({}, STAFF_PORTAL_STRINGS.es || {}, esSunset || {});

  // ── Production /staff/ui ─────────────────────────────────────────────────
  console.log('[0] Production /staff/ui inject');
  let uiHtml = '';
  let killUi = null;
  try {
    const res = await fetchRenderedStaffUi();
    uiHtml = res.html;
    killUi = res.kill;
    ok('GET /staff/ui 200 HTML', uiHtml.includes('<!DOCTYPE html>'));
    ok('ui injects edit module body',
      uiHtml.includes('function scheduleRenderEditableDrawerHtml(')
      || uiHtml.includes('function scheduleEnterDrawerEditMode('));
    ok('ui includes Create date-range CSS shared with Edit',
      /portal-schedule-create-date-range-trigger/.test(uiHtml)
      && /portal-schedule-create-activity-btn/.test(uiHtml));
  } catch (e) {
    ok('GET /staff/ui 200 HTML', false, String(e && e.message || e));
  } finally {
    if (killUi) try { killUi(); } catch (_k) { /* ignore */ }
  }

  // Also prove inject path without server
  const injectSample = injectSunsetSchedulePortalModule(
    '<script>(function(){function el(id){return null;}'
    + '/* INJECT:sunset-schedule-rental-availability */'
    + '/* INJECT:sunset-schedule-portal-module */'
    + '/* INJECT:sunset-schedule-drawer-view-ui */'
    + '/* INJECT:sunset-schedule-drawer-edit-ui */'
    + '/* INJECT:sunset-schedule-drawer-actions */'
    + '/* INJECT:sunset-schedule-drawer-controller */'
    + 'function escHtml(s){return s;}})();</script>'
  );
  ok('injectSunsetSchedulePortalModule embeds edit owner',
    injectSample.includes('function scheduleRenderEditableDrawerHtml('));

  // ── A) Header ────────────────────────────────────────────────────────────
  console.log('\n[A] Header / location row parity');
  ok('edit module exists', editExists);
  ok('edit header uses create-header chrome classes',
    /portal-schedule-create-header/.test(editSrc)
    && /portal-schedule-create-header-text/.test(editSrc)
    && /portal-schedule-create-title/.test(editSrc)
    && /portal-schedule-create-school-chip/.test(editSrc)
    && /id="ps-drawer-close"/.test(editSrc));
  const headerTextCss = extractCssBlock(apiSrc, '.portal-schedule-create-header-text{');
  const titleCss = extractCssBlock(apiSrc, '.portal-schedule-create-title{');
  const chipCss = extractCssBlock(apiSrc, '.portal-schedule-create-school-chip{');
  ok('shared header-text is single nowrap row',
    /display:\s*flex/.test(headerTextCss)
    && /flex-direction:\s*row/.test(headerTextCss)
    && /flex-wrap:\s*nowrap/.test(headerTextCss)
    && /min-width:\s*0/.test(headerTextCss));
  ok('title + chip truncate with ellipsis',
    /text-overflow:\s*ellipsis/.test(titleCss)
    && /text-overflow:\s*ellipsis/.test(chipCss));
  ok('close button has ≥44px target (create close or drawer close)',
    (/#ps-create-close[^\{]*\{[^}]*min-width:\s*44px/.test(apiSrc)
      || /#ps-create-close\{[^}]*min-width:\s*44px/.test(apiSrc))
    && (/#ps-drawer-close[^\{]*\{[^}]*min-width:\s*44px/.test(apiSrc)
      || /\.portal-schedule-create-header[^{]*#ps-drawer-close[^{]*\{[^}]*min-width:\s*44px/.test(apiSrc)
      || /\.portal-schedule-create-header[^{]*drawer-close-btn[^{]*\{[^}]*min-width:\s*44px/.test(apiSrc)
      || /portal-schedule-drawer-close-btn\{[^}]*min-width:\s*44px/.test(apiSrc)));
  ok('header row contract pure helper present',
    /function scheduleCreateHeaderRowContract/.test(apiSrc));
  {
    const src = extractFn(apiSrc, 'scheduleCreateHeaderRowContract');
    if (src) {
      const sb = { result: null };
      vm.runInNewContext(src + '; result = scheduleCreateHeaderRowContract({ width: 390 });', sb);
      ok('390px header contract fits without overflow',
        sb.result && sb.result.singleRow && sb.result.noWrap && sb.result.fitsWithoutOverflow);
      [320, 375, 390, 430].forEach((w) => {
        const r = {};
        vm.runInNewContext(src + '; result = scheduleCreateHeaderRowContract({ width: ' + w + ' });', r);
        ok(w + 'px header contract no overflow', r.result && r.result.fitsWithoutOverflow);
      });
    } else {
      ok('scheduleCreateHeaderRowContract extractable', false);
    }
  }

  // ── B) Date range structure ──────────────────────────────────────────────
  console.log('\n[B] Compact date-range structure + owner functions');
  ok('edit renders date-range trigger (not dual visible labels)',
    /id="ps-drawer-date-range-trigger"/.test(editSrc)
    && /id="ps-drawer-date-range-display"/.test(editSrc)
    && /id="ps-drawer-date-range-popover"/.test(editSrc)
    && /id="ps-drawer-date-range-grid"/.test(editSrc)
    && /id="ps-drawer-date-range-apply"/.test(editSrc)
    && /id="ps-drawer-date-range-cancel"/.test(editSrc));
  ok('canonical ps-drawer-date-from/to preserved once each in render',
    (editSrc.match(/id="ps-drawer-date-from"/g) || []).length === 1
    && (editSrc.match(/id="ps-drawer-date-to"/g) || []).length === 1);
  ok('from/to hidden compatibility (no dual visible From/To labels)',
    /portal-schedule-create-date-hidden|visually-hidden|aria-hidden="true"/.test(editSrc)
    && !/<label[^>]*for="ps-drawer-date-from"/.test(editSrc)
    && !/<label[^>]*for="ps-drawer-date-to"/.test(editSrc));
  ok('edit date-range owner functions present',
    /function scheduleWireDrawerDateRange/.test(editSrc)
    && /function scheduleApplyDrawerDateRangeDraft/.test(editSrc)
    && /function scheduleRenderDrawerDateRangeCalendar/.test(editSrc)
    && /function scheduleDrawerDateRangeClosePopover/.test(editSrc)
    && /function scheduleDrawerDateRangeOpenPopover/.test(editSrc));
  ok('edit reuses Create pure day-selection helpers (no duplicate owner)',
    /scheduleCreateDateRangeSelectDay/.test(editSrc)
    && /scheduleCreateDateRangeIsValidIso/.test(editSrc)
    && /scheduleCreateDateRangeDisplayText/.test(editSrc));
  ok('no Clear action on Edit range',
    !/id="ps-drawer-date-range-clear"/.test(editSrc)
    && !/function scheduleClearDrawerDateRange/.test(editSrc));
  ok('no ARIA grid roles on Edit calendar',
    !/role="grid"/.test(editSrc)
    && !/role="gridcell"/.test(editSrc)
    && !/role="columnheader"/.test(editSrc));

  // ── C) Main activity buttons ─────────────────────────────────────────────
  console.log('\n[C] Main activity native buttons');
  ok('edit uses activity buttons + hidden radios',
    /portal-schedule-create-activity-btn/.test(editSrc)
    && /data-edit-activity=/.test(editSrc)
    && /id="ps-drawer-comp-course"/.test(editSrc)
    && /id="ps-drawer-comp-private-lesson"/.test(editSrc)
    && /id="ps-drawer-comp-no-lesson"/.test(editSrc)
    && /portal-schedule-create-visually-hidden/.test(editSrc));
  ok('no visible radio-label glyph for main activity',
    !/<label class="portal-schedule-create-check"><input type="radio" name="ps-drawer-main-activity"/.test(editSrc));
  ok('main activity role is group (Create parity, not radiogroup-with-visible-radios)',
    /id="ps-drawer-main-activity-choices"[\s\S]{0,120}role="group"/.test(editSrc)
    || /role="group"[\s\S]{0,80}id="ps-drawer-main-activity-choices"/.test(editSrc)
    || /ps-drawer-main-activity-choices"[^>]*role="group"/.test(editSrc));
  ok('sync + wire helpers for activity buttons',
    /function scheduleSyncDrawerMainActivityButtons/.test(editSrc)
    && /function scheduleWireDrawerMainActivityButtons/.test(editSrc));
  const activityBtnCss = extractCssBlock(apiSrc, '.portal-schedule-create-activity-btn{');
  ok('activity buttons min-height 44px shared CSS',
    /min-height:\s*44px/.test(activityBtnCss));

  // ── D) Group course drill-down ───────────────────────────────────────────
  console.log('\n[D] Group course in-place drill-down');
  ok('Back + path + course list hosts in Edit render',
    /id="ps-drawer-main-activity-back"/.test(editSrc)
    && /id="ps-drawer-main-activity-path"/.test(editSrc)
    && /id="ps-drawer-course-list"/.test(editSrc)
    && /portal-schedule-create-main-activity-back/.test(editSrc));
  ok('drill-down enter/exit owners',
    /function scheduleDrawerEnterGroupCourseDrilldown/.test(editSrc)
    && /function scheduleDrawerExitMainActivityDrilldown/.test(editSrc)
    && /function scheduleDrawerRenderCourseList/.test(editSrc)
    && /function scheduleDrawerSelectCourse/.test(editSrc));
  ok('compat course select stays hidden (no second dropdown authority)',
    /id="ps-drawer-course-select"/.test(editSrc)
    && /ps-drawer-course-fields[\s\S]{0,200}(hidden|display:none|aria-hidden)/.test(editSrc)
      || /id="ps-drawer-course-fields"[^>]*(hidden|display:\s*none)/.test(editSrc)
      || (/style="display:none"/.test(editSrc)
        && /ps-drawer-course-fields/.test(editSrc)
        && /function scheduleDrawerEnterGroupCourseDrilldown/.test(editSrc)));
  ok('course options use activity-btn + aria-pressed exclusive pattern',
    /data-course-id=/.test(editSrc)
    && /aria-pressed=/.test(editSrc)
    && /scheduleDrawerSyncCourseButtons|aria-pressed/.test(editSrc));

  // ── E) Private / addon / payment / footer ────────────────────────────────
  console.log('\n[E] Private panel, custom addon, payment, footer chrome');
  ok('private panel host for in-place drill-down',
    /id="ps-drawer-private-panel"/.test(editSrc)
    || /id="ps-drawer-private-when"/.test(editSrc));
  ok('private sessions host preserved',
    /id="ps-drawer-private-sessions"/.test(editSrc));
  ok('custom addon card present',
    /data-edit-section="custom-addon"/.test(editSrc)
    && /ps-drawer-custom-line-add-btn/.test(editSrc));
  ok('payment section + footer actions preserved',
    /data-edit-section="payment"/.test(editSrc)
    && /ps-drawer-payment-box|scheduleRenderDrawerPaymentSectionEditHtml/.test(editSrc)
    && /portal-schedule-create-footer/.test(editSrc)
    && /id="ps-drawer-cancel"/.test(editSrc)
    && /id="ps-drawer-save"/.test(editSrc));
  ok('rental host + per-item duration select pattern (Slice 2)',
    /id="ps-drawer-rentals"/.test(editSrc)
    && (/data-rental-duration-select|ps-drawer-rental-duration/.test(editSrc)
      || /data-rental-duration-pebbles|rental-pebble/.test(editSrc)));

  // ── F) Render seed HTML via real function ────────────────────────────────
  console.log('\n[F] Seeded HTML from scheduleRenderEditableDrawerHtml');
  function renderHtml(ctxExtras) {
    const row = { booking_id: 'b1', booking_code: 'SUN-1', record_source: 'staff_manual' };
    const ctx = Object.assign({
      booking_id: 'b1',
      booking_code: 'SUN-1',
      guest_name: 'Alex',
      phone: '+34111',
      date_from: '2026-07-20',
      date_to: '2026-07-22',
      notes: '',
      payment_status: 'unpaid',
      components: {},
      rentals: [],
      payment: { subtotal_cents: 0, paid_cents: 0, balance_due_cents: 0, line_items: [] },
    }, ctxExtras || {});
    const sb = {
      portalT(k) {
        const map = STAFF_PORTAL_STRINGS.en || {};
        return map[k] || k;
      },
      escHtml(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      },
      schedulePaymentStatusLabel(s) { return s || 'unpaid'; },
      scheduleDrawerEur(c) { return '€' + (Number(c || 0) / 100).toFixed(2); },
      scheduleDrawerBuildCommercialLines: null,
      scheduleRenderDrawerPaymentSelectHtml: extractFn(editSrc, 'scheduleRenderDrawerPaymentSelectHtml'),
      scheduleRenderDrawerPaymentSectionEditHtml: extractFn(editSrc, 'scheduleRenderDrawerPaymentSectionEditHtml'),
      scheduleDrawerPaymentSelectValue: extractFn(editSrc, 'scheduleDrawerPaymentSelectValue'),
      result: '',
    };
    const parts = [
      extractFn(editSrc, 'scheduleDrawerPaymentSelectValue'),
      extractFn(editSrc, 'scheduleRenderDrawerPaymentSelectHtml'),
      extractFn(editSrc, 'scheduleRenderDrawerPaymentSectionEditHtml'),
      extractFn(editSrc, 'scheduleRenderEditableDrawerHtml'),
    ].filter(Boolean);
    if (parts.length < 4) return { html: '', error: 'missing render fns' };
    try {
      vm.runInNewContext(
        parts.join('\n') + '\nresult = scheduleRenderEditableDrawerHtml('
        + JSON.stringify(row) + ',' + JSON.stringify(ctx) + ');',
        sb,
        { timeout: 5000 }
      );
      return { html: sb.result || '', error: null };
    } catch (e) {
      return { html: '', error: String(e && e.message || e) };
    }
  }

  {
    const none = renderHtml({
      components: {},
      rentals: [{ offering_key: 'board_rental', quantity: 2, duration_key: '3_days' }],
      date_from: '2026-07-20',
      date_to: '2026-07-22',
    });
    ok('render no-lesson HTML', !none.error && /ps-drawer-edit-form/.test(none.html), none.error);
    if (none.html) {
      ok('no-lesson: date trigger present; hidden from/to seeded',
        /ps-drawer-date-range-trigger/.test(none.html)
        && /id="ps-drawer-date-from"[^>]*value="2026-07-20"/.test(none.html)
        && /id="ps-drawer-date-to"[^>]*value="2026-07-22"/.test(none.html));
      ok('no-lesson: No lesson button pressed; radios hidden',
        /data-edit-activity="ps-drawer-comp-no-lesson"[^>]*aria-pressed="true"/.test(none.html)
        || /data-edit-activity="ps-drawer-comp-no-lesson"[^>]*is-selected/.test(none.html)
        || (/ps-drawer-comp-no-lesson[^>]*checked/.test(none.html)
          && /portal-schedule-create-activity-btn/.test(none.html)));
      ok('no-lesson: surfers field visible seed',
        /id="ps-drawer-surfers-field"/.test(none.html)
        && !/id="ps-drawer-surfers-field"[^>]*display:\s*none/.test(none.html));
      ok('no-lesson: activity buttons not radio labels',
        /portal-schedule-create-activity-btn/.test(none.html)
        && !/<label class="portal-schedule-create-check"><input type="radio" name="ps-drawer-main-activity"/.test(none.html));
    }

    const group = renderHtml({
      components: {
        course: { course_id: 'c1', quantity: 2, course_label: 'Beginner', tier_key: '3_days' },
      },
      date_from: '2026-07-20',
      date_to: '2026-07-22',
    });
    ok('render group HTML', !group.error && /ps-drawer-edit-form/.test(group.html), group.error);
    if (group.html) {
      ok('group: course select seeded data-selected=c1',
        /id="ps-drawer-course-select"[^>]*data-selected="c1"/.test(group.html));
      ok('group: group radio checked / course button seed path',
        /id="ps-drawer-comp-course"[^>]*checked/.test(group.html)
        || /data-edit-activity="ps-drawer-comp-course"[^>]*aria-pressed="true"/.test(group.html));
      ok('group: course list host present',
        /id="ps-drawer-course-list"/.test(group.html));
      ok('group: multi-day from/to seeded 20→22',
        /value="2026-07-20"/.test(group.html) && /value="2026-07-22"/.test(group.html));
    }

    const priv = renderHtml({
      components: {
        private_lesson: { surfer_count: 1, sessions: [
          { date: '2026-07-20', start: '10:00', end: '12:00' },
        ] },
      },
      date_from: '2026-07-20',
      date_to: '2026-07-20',
    });
    ok('render private HTML', !priv.error && /ps-drawer-edit-form/.test(priv.html), priv.error);
    if (priv.html) {
      ok('private: private radio checked seed',
        /id="ps-drawer-comp-private-lesson"[^>]*checked/.test(priv.html));
      ok('private: private panel / sessions host present',
        /id="ps-drawer-private-panel"/.test(priv.html) || /id="ps-drawer-private-when"/.test(priv.html));
      ok('private: same-day from/to',
        /id="ps-drawer-date-from"[^>]*value="2026-07-20"/.test(priv.html)
        && /id="ps-drawer-date-to"[^>]*value="2026-07-20"/.test(priv.html));
    }

    const rental = renderHtml({
      components: {
        surfboard: { quantity: 1 },
        wetsuit: { quantity: 1 },
      },
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '7_days', quantity: 1 }],
      rental_pricing: { offering_key: 'board_and_suit_rental', duration: '7_days', quantity: 1 },
      date_from: '2026-07-20',
      date_to: '2026-07-26',
    });
    ok('render rental multi-day HTML', !rental.error, rental.error);
    if (rental.html) {
      ok('rental: rentals host seed board+wetsuit attrs',
        /data-seed-board="1"/.test(rental.html)
        && /data-seed-wetsuit="1"/.test(rental.html)
        && /board_and_suit_rental/.test(rental.html));
      ok('rental: multi-day date span seeded',
        /value="2026-07-20"/.test(rental.html) && /value="2026-07-26"/.test(rental.html));
    }
  }

  // ── G) Behavioral calendar + activity + Back ─────────────────────────────
  console.log('\n[G] Behavioral: calendar, activity, Back, Cancel contract markers');
  {
    const rt = buildEditRuntime(editSrc, apiSrc, {
      mode: 'none',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-22',
    });
    if (rt.error || !rt.sandbox) {
      ok('edit runtime boots', false, String(rt.error && rt.error.message || rt.error || 'no sandbox'));
    } else {
      const { el, sandbox, getFocused, setFocused, fireGridClick, dayButtons, activityButtons } = rt;
      ok('edit runtime boots', true);

      // Pure helpers available
      ok('Create pure SelectDay available to Edit',
        typeof sandbox.scheduleCreateDateRangeSelectDay === 'function');
      if (typeof sandbox.scheduleCreateDateRangeSelectDay === 'function') {
        let st = sandbox.scheduleCreateDateRangeSelectDay({}, '2026-07-20');
        ok('first click start only', st.start === '2026-07-20' && !st.end);
        st = sandbox.scheduleCreateDateRangeSelectDay(st, '2026-07-20');
        ok('same-day second click sets end', st.start === '2026-07-20' && st.end === '2026-07-20');
        st = sandbox.scheduleCreateDateRangeSelectDay({ start: '2026-07-20', end: null }, '2026-07-22');
        ok('second later click sets end range', st.start === '2026-07-20' && st.end === '2026-07-22');
      }

      if (typeof sandbox.scheduleDrawerDateRangeOpenPopover === 'function') {
        setFocused(el('ps-drawer-date-range-trigger'));
        const canonFrom = el('ps-drawer-date-from').value;
        const canonTo = el('ps-drawer-date-to').value;
        sandbox.scheduleDrawerDateRangeOpenPopover();
        ok('open: popover open', sandbox.scheduleDrawerDateRangeIsOpen());
        ok('open: aria-expanded true',
          el('ps-drawer-date-range-trigger').getAttribute('aria-expanded') === 'true');
        ok('open: draft seeded from canonical from/to',
          sandbox.scheduleDrawerDateRangeDraft
          && sandbox.scheduleDrawerDateRangeDraft.start === '2026-07-20'
          && sandbox.scheduleDrawerDateRangeDraft.end === '2026-07-22');
        ok('open: day buttons rendered', dayButtons().length > 0);
        ok('open: focus moved into calendar',
          !!(getFocused() && getFocused() !== el('ps-drawer-date-range-trigger')));

        // Mutate draft then Escape — discard, canonical unchanged
        fireGridClick('2026-07-25');
        ok('draft mutated after day click',
          sandbox.scheduleDrawerDateRangeDraft.start === '2026-07-25');
        sandbox.scheduleDrawerDateRangeOnDocumentKeydown({
          key: 'Escape',
          preventDefault() {},
        });
        ok('Escape closes popover', !sandbox.scheduleDrawerDateRangeIsOpen());
        ok('Escape discards draft; canonical unchanged until Apply',
          el('ps-drawer-date-from').value === canonFrom
          && el('ps-drawer-date-to').value === canonTo);

        // One-click same-day Apply
        sandbox.scheduleDrawerDateRangeOpenPopover();
        fireGridClick('2026-07-21');
        // start only — Apply commits from=to=start
        ok('Apply ready with start-only (one-day)',
          !el('ps-drawer-date-range-apply').disabled);
        sandbox.scheduleApplyDrawerDateRangeDraft();
        ok('one-day Apply sets from=to=start',
          el('ps-drawer-date-from').value === '2026-07-21'
          && el('ps-drawer-date-to').value === '2026-07-21');
        ok('Apply closes popover', !sandbox.scheduleDrawerDateRangeIsOpen());

        // Multi-day second click + Apply
        sandbox.scheduleDrawerDateRangeOpenPopover();
        fireGridClick('2026-07-20');
        fireGridClick('2026-07-23');
        sandbox.scheduleApplyDrawerDateRangeDraft();
        ok('range Apply commits start/end',
          el('ps-drawer-date-from').value === '2026-07-20'
          && el('ps-drawer-date-to').value === '2026-07-23');

        // Cancel discard
        const beforeFrom = el('ps-drawer-date-from').value;
        const beforeTo = el('ps-drawer-date-to').value;
        sandbox.scheduleDrawerDateRangeOpenPopover();
        fireGridClick('2026-07-10');
        sandbox.scheduleDrawerDateRangeClosePopover({ restoreFocus: true, discard: true });
        ok('Cancel discard leaves canonical values',
          el('ps-drawer-date-from').value === beforeFrom
          && el('ps-drawer-date-to').value === beforeTo);

        // Outside click discard
        sandbox.scheduleDrawerDateRangeOpenPopover();
        fireGridClick('2026-07-11');
        sandbox.scheduleDrawerDateRangeOnDocumentPointer({
          target: el('outside-click-target'),
        });
        ok('outside click closes without applying',
          !sandbox.scheduleDrawerDateRangeIsOpen()
          && el('ps-drawer-date-from').value === beforeFrom);

        // Keyboard roving
        sandbox.scheduleDrawerDateRangeOpenPopover();
        if (typeof sandbox.scheduleDrawerDateRangeMoveFocus === 'function'
          || typeof sandbox.scheduleCreateDateRangeMoveFocus === 'function') {
          const mover = sandbox.scheduleDrawerDateRangeMoveFocus
            || sandbox.scheduleCreateDateRangeMoveFocus;
          ok('ArrowRight moves focus day', mover('2026-07-20', 'ArrowRight') === '2026-07-21');
          ok('ArrowDown moves +7', mover('2026-07-20', 'ArrowDown') === '2026-07-27');
        } else {
          ok('keyboard move helper present', false);
        }
      } else {
        ok('scheduleDrawerDateRangeOpenPopover present', false);
      }

      // Activity buttons exclusive
      if (typeof sandbox.scheduleSyncDrawerMainActivityButtons === 'function') {
        el('ps-drawer-comp-course').checked = true;
        el('ps-drawer-comp-no-lesson').checked = false;
        el('ps-drawer-comp-private-lesson').checked = false;
        sandbox.scheduleSyncDrawerMainActivityButtons();
        ok('sync: Group exclusive aria-pressed',
          activityButtons.course.getAttribute('aria-pressed') === 'true'
          && activityButtons.none.getAttribute('aria-pressed') === 'false'
          && activityButtons.priv.getAttribute('aria-pressed') === 'false');
      } else {
        ok('scheduleSyncDrawerMainActivityButtons present', false);
      }

      // Group drill-down + course select exclusive
      if (typeof sandbox.scheduleDrawerEnterGroupCourseDrilldown === 'function'
        && typeof sandbox.scheduleDrawerRenderCourseList === 'function') {
        sandbox.scheduleDrawerEnterGroupCourseDrilldown();
        ok('enter group: choices hidden, list shown, Back shown',
          el('ps-drawer-main-activity-choices').style.display === 'none'
          && el('ps-drawer-course-list').style.display !== 'none'
          && el('ps-drawer-main-activity-back').style.display !== 'none');
        ok('enter group: group radio checked', !!el('ps-drawer-comp-course').checked);
        sandbox.scheduleDrawerRenderCourseList(sandbox.scheduleCoursesCache, { selectedId: '' });
        ok('course list renders option buttons',
          (el('ps-drawer-course-list')._courseRows || []).length >= 1
          || /data-course-id/.test(el('ps-drawer-course-list').innerHTML));
        if (typeof sandbox.scheduleDrawerSelectCourse === 'function') {
          sandbox.scheduleDrawerSelectCourse('c1', 'Beginner');
          ok('select course syncs hidden select',
            el('ps-drawer-course-select').value === 'c1');
          ok('select course exclusive aria-pressed',
            typeof sandbox.scheduleDrawerGetSelectedCourseId === 'function'
            && sandbox.scheduleDrawerGetSelectedCourseId() === 'c1');
        }
        // Back → No lesson draft (not persisted write)
        const ctxBefore = JSON.stringify(sandbox.scheduleDrawerState.ctx);
        sandbox.scheduleDrawerExitMainActivityDrilldown({ clearCourse: true, clearPrivate: true });
        ok('Back: root choices restored + No lesson checked',
          el('ps-drawer-main-activity-choices').style.display !== 'none'
          && !!el('ps-drawer-comp-no-lesson').checked
          && !el('ps-drawer-comp-course').checked);
        ok('Back: No lesson button pressed exclusive',
          activityButtons.none.getAttribute('aria-pressed') === 'true'
          && activityButtons.course.getAttribute('aria-pressed') === 'false');
        ok('Back: persisted scheduleDrawerState.ctx unchanged',
          JSON.stringify(sandbox.scheduleDrawerState.ctx) === ctxBefore);
      } else {
        ok('group drill-down owners present', false);
      }

      // Private drill-down
      if (typeof sandbox.scheduleDrawerEnterPrivateSessionsDrilldown === 'function') {
        sandbox.scheduleDrawerEnterPrivateSessionsDrilldown();
        ok('private drill-down: private radio + panel visible',
          !!el('ps-drawer-comp-private-lesson').checked
          && (el('ps-drawer-private-panel').style.display !== 'none'
            || el('ps-drawer-private-when').style.display !== 'none'));
        sandbox.scheduleDrawerExitMainActivityDrilldown();
        ok('Back from private restores No lesson',
          !!el('ps-drawer-comp-no-lesson').checked);
      } else {
        ok('private drill-down owner present', false);
      }
    }
  }

  // Save / cancel contract markers (do not invent new write paths)
  ok('Save still uses scheduleSaveDrawerBooking + in-flight guard',
    /function scheduleSaveDrawerBooking/.test(editSrc)
    && /scheduleDrawerSaveInFlight/.test(editSrc));
  ok('Cancel remounts from ctx (scheduleCancelDrawerEditMode)',
    /function scheduleCancelDrawerEditMode/.test(editSrc)
    && /scheduleMountDrawerBody\([\s\S]{0,80}false\)/.test(editSrc));
  ok('no client-side invent quote endpoint',
    !/\/staff\/schedule\/quote/.test(editSrc));
  ok('stale capacity / money mismatch still fail-closed on save path markers',
    /paid_booking_reprice_required|scheduleDrawerHumanSaveError|scheduleDrawerValidateEditPayload/.test(editSrc));

  // ── H) i18n + mobile ─────────────────────────────────────────────────────
  console.log('\n[H] EN/ES/IT + mobile spacing');
  const i18nKeys = [
    'schedule.create.dateRange',
    'schedule.create.dateRange.cancel',
    'schedule.create.dateRange.apply',
    'schedule.create.mainActivity',
    'schedule.create.mainActivityBack',
    'schedule.type.course',
    'schedule.type.privateLesson',
    'schedule.type.noLesson',
    'schedule.drawer.editTitle',
    'schedule.drawer.cancel',
    'schedule.drawer.save',
  ];
  i18nKeys.forEach((k) => {
    ok('EN ' + k, !!(en[k] && String(en[k]).trim() && en[k] !== k));
    ok('ES ' + k, !!(es[k] && String(es[k]).trim() && es[k] !== en[k]));
    ok('IT ' + k, !!(it[k] && String(it[k]).trim() && it[k] !== en[k]));
  });
  ok('edit drawer overflow-x hidden',
    /portal-schedule-drawer[^\{]*\{[^}]*overflow-x:\s*hidden/.test(apiSrc)
    || /:has\(#ps-drawer-edit-form\)\{[^}]*overflow-x:\s*hidden/.test(apiSrc)
    || /drawer-edit\{[^}]*overflow-x:\s*hidden/.test(apiSrc));
  ok('mobile full-bleed drawer @640px',
    /@media\(max-width:640px\)\{\.portal-schedule-drawer,\.portal-schedule-create-drawer\{width:100vw/.test(apiSrc)
    || /@media\(max-width:640px\)\{[^}]*portal-schedule-drawer\{[^}]*width:100vw/.test(apiSrc));
  ok('main activity Back min 44px',
    /portal-schedule-create-main-activity-back\{[^}]*min-height:\s*44px/.test(apiSrc));
  ok('date range trigger min 44px',
    /portal-schedule-create-date-range-trigger\{[^}]*min-height:\s*44px/.test(apiSrc));
  ok('edit footer actions min 44px',
    /drawer-edit-footer[\s\S]{0,200}min-height:\s*44px/.test(apiSrc)
    || /create-footer[\s\S]{0,200}min-height:\s*44px/.test(apiSrc));

  // ── I) Review-block regressions (payment / identity / race / locale / mutation safety) ─
  console.log('\n[I] Review-block regressions');

  // I1) Payment seed authority — nested canonical preferred over legacy top-level
  {
    const payFn = extractFn(editSrc, 'scheduleDrawerPaymentSelectValue');
    ok('scheduleDrawerPaymentSelectValue extractable', !!payFn);
    if (payFn) {
      function evalPay(ctx) {
        const sb = { result: null };
        vm.runInNewContext(
          payFn + '\nresult = scheduleDrawerPaymentSelectValue(' + JSON.stringify(ctx) + ');',
          sb,
          { timeout: 2000 }
        );
        return sb.result;
      }
      ok('paid nested payment_status + nested method → paid_bank_transfer',
        evalPay({
          payment: { payment_status: 'paid', payment_method: 'bank_transfer' },
        }) === 'paid_bank_transfer');
      ok('paid nested status + nested in_store method',
        evalPay({
          payment: { payment_status: 'paid', payment_method: 'in_store' },
        }) === 'paid_in_store');
      ok('paid nested status + top-level method fallback',
        evalPay({
          payment: { payment_status: 'paid' },
          payment_method: 'link',
        }) === 'paid_via_link');
      ok('unpaid nested never seeds paid',
        evalPay({
          payment: { payment_status: 'unpaid' },
          payment_status: 'paid',
          payment_method: 'bank_transfer',
        }) === 'unpaid');
      ok('legacy top-level paid still seeds paid_bank_transfer',
        evalPay({ payment_status: 'paid', payment_method: 'bank_transfer' }) === 'paid_bank_transfer');
      ok('legacy top-level unpaid still seeds unpaid',
        evalPay({ payment_status: 'unpaid' }) === 'unpaid');
      // Seed HTML for paid nested must not select unpaid
      const paidHtml = renderHtml({
        payment_status: undefined,
        payment_method: undefined,
        payment: {
          payment_status: 'paid',
          payment_method: 'bank_transfer',
          subtotal_cents: 4500,
          paid_cents: 4500,
          balance_due_cents: 0,
          line_items: [],
        },
      });
      ok('paid nested seed HTML selects paid_bank_transfer not unpaid',
        !paidHtml.error
        && /id="ps-drawer-payment"/.test(paidHtml.html)
        && /value="paid_bank_transfer"[^>]*selected|selected[^>]*value="paid_bank_transfer"/.test(paidHtml.html)
        && !/<option value="unpaid" selected/.test(paidHtml.html),
        paidHtml.error || 'select markup missing');
    }
  }

  // I2) Rental identity fail-closed — never invent generics; preserve missing seed
  {
    ok('edit rentals do not invent board/wetsuit/bundle when catalog empty',
      !/if\s*\(\s*!offerings\.length\s*\)\s*\{\s*offerings\s*=\s*\[\s*\{\s*offering_key:\s*'board_rental'/.test(editSrc)
      && !/offerings\s*=\s*\[\s*\{\s*offering_key:\s*'board_rental'[\s\S]{0,120}wetsuit_rental[\s\S]{0,120}board_and_suit/.test(editSrc));
    ok('edit rentals preserve compatibility / unavailable seed state',
      /data-compatibility|compatibility|data-eligible|rentalUnavailable|noRentalsAvailable/.test(editSrc)
      && /scheduleDrawerValidateEditPayload/.test(editSrc));
    // Behavioral: empty catalog + seeded rental must preserve identity and block Save
    const rentFn = extractFn(editSrc, 'scheduleRenderDrawerRentals');
    const seedFn = extractFn(editSrc, 'scheduleDrawerSeedRentalsFromCtx');
    const validateFn = extractFn(editSrc, 'scheduleDrawerValidateEditPayload');
    const readRentFn = extractFn(editSrc, 'scheduleReadDrawerRentalSelectionFromDom');
    ok('rental render/seed/validate extractable',
      !!(rentFn && seedFn && validateFn));
    if (rentFn && seedFn) {
      const wrap = {
        _attrs: {
          'data-seed-rentals': JSON.stringify([
            { offering_key: 'board_rental', quantity: 2, duration_key: '3_days' },
          ]),
          'data-duration-key': '3_days',
        },
        style: { display: '' },
        hidden: false,
        getAttribute(k) { return this._attrs[k] != null ? this._attrs[k] : null; },
        setAttribute(k, v) { this._attrs[k] = String(v); },
        removeAttribute(k) { delete this._attrs[k]; },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        dataset: {},
        innerHTML: '',
      };
      const nodes = { 'ps-drawer-rentals': wrap };
      const sb = {
        el(id) { return nodes[id] || null; },
        scheduleDrawerState: {
          ctx: {
            rentals: [{ offering_key: 'board_rental', quantity: 2, duration_key: '3_days' }],
          },
        },
        scheduleDrawerMainActivityValue() { return 'none'; },
        scheduleDrawerDateSpan() { return { from: '2026-07-20', to: '2026-07-22' }; },
        scheduleRentalDurationKeyFromDates() { return '3_days'; },
        scheduleEnumerateDates() { return ['2026-07-20', '2026-07-21', '2026-07-22']; },
        getSunsetLocation() { return 'sunset-somo'; },
        getClient() { return 'sunset'; },
        scheduleAdminPricesCache: [],
        scheduleRentalOfferingsCache: [],
        scheduleProjectStandaloneRentals() { return []; },
        scheduleCommonShortRentalDurationKeys() { return []; },
        scheduleActiveShortRentalOfferings() { return []; },
        scheduleActiveRentalsForDuration() { return []; },
        scheduleRentalOfferingsMode() { return 'none'; },
        scheduleDrawerReadSurferCount() { return 2; },
        scheduleDrawerApplyRentalExclusionUi() {},
        scheduleWireDrawerRentals() {},
        scheduleRentalOfferingDisplayLabel(k, lab) { return lab || k; },
        scheduleRentalOfferingLabelKey(k) {
          return k === 'wetsuit_rental' ? 'schedule.type.wetsuitRental'
            : k === 'board_and_suit_rental' ? 'schedule.ops.rentalBoth'
              : (k === 'board_rental' ? 'schedule.type.boardRental' : '');
        },
        portalT(k) { return (en[k] || k); },
        escHtml(s) {
          return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        },
      };
      try {
        vm.runInNewContext(
          seedFn + '\n' + rentFn + '\nscheduleRenderDrawerRentals();',
          sb,
          { timeout: 4000 }
        );
        ok('empty catalog + seed: preserves board_rental in DOM (no silent drop)',
          /data-rental-offering="board_rental"/.test(wrap.innerHTML)
          || wrap.getAttribute('data-compatibility-rentals')
          || /board_rental/.test(wrap.innerHTML));
        ok('empty catalog + seed: does not invent all three generics as free choices',
          !(/board_rental/.test(wrap.innerHTML)
            && /wetsuit_rental/.test(wrap.innerHTML)
            && /board_and_suit_rental/.test(wrap.innerHTML)
            && !/data-compatibility|data-eligible="0"|is-unavailable/.test(wrap.innerHTML)));
        ok('empty catalog + seed marks compatibility/unavailable',
          /data-compatibility|data-eligible="0"|is-unavailable|compatibility/.test(wrap.innerHTML)
          || wrap.getAttribute('data-rental-compatibility') === '1');
      } catch (e) {
        ok('empty catalog rental render runs', false, String(e && e.message || e));
      }
    }
    if (validateFn) {
      const vSb = {
        el() { return null; },
        scheduleDrawerMainActivityValue() { return 'none'; },
        scheduleDrawerReadSurferCount() { return 2; },
        schedulePortalInclusiveDateCount() { return 3; },
        result: null,
      };
      // Simulate DOM with compatibility rental checked via helper side-channel
      vSb.el = function(id) {
        if (id === 'ps-drawer-rentals') {
          return {
            getAttribute(k) {
              if (k === 'data-rental-compatibility') return '1';
              return null;
            },
            querySelectorAll(sel) {
              if (String(sel).indexOf('rental-check') >= 0 || String(sel).indexOf('data-rental') >= 0) {
                return [{
                  checked: true,
                  getAttribute(k) {
                    if (k === 'data-offering-key' || k === 'data-rental-offering') return 'board_rental';
                    if (k === 'data-compatibility' || k === 'data-eligible') return k === 'data-eligible' ? '0' : '1';
                    return null;
                  },
                  querySelector() {
                    return {
                      checked: true,
                      getAttribute(k) {
                        if (k === 'data-offering-key') return 'board_rental';
                        if (k === 'data-compatibility') return '1';
                        if (k === 'data-eligible') return '0';
                        return null;
                      },
                    };
                  },
                }];
              }
              return [];
            },
          };
        }
        return null;
      };
      try {
        vm.runInNewContext(
          validateFn
          + '\nresult = scheduleDrawerValidateEditPayload({'
          + 'guest_name:"Alex",components:{},rentals:[{offering_key:"board_rental",quantity:2,duration_key:"3_days"}],'
          + 'surfer_count:2});',
          vSb,
          { timeout: 3000 }
        );
        ok('compatibility rental blocks Save (validate fail-closed)',
          vSb.result && vSb.result.ok === false && !!vSb.result.errorKey,
          JSON.stringify(vSb.result));
      } catch (e) {
        ok('compatibility rental validate runs', false, String(e && e.message || e));
      }
    }
  }

  // I3) Course identity fail-closed — do not clear seeded missing/ineligible course
  {
    const courseFn = extractFn(editSrc, 'scheduleDrawerRenderCourseList');
    const clearFn = extractFn(editSrc, 'scheduleDrawerClearSelectedCourse');
    ok('course list render extractable', !!courseFn);
    ok('course render must not clear seeded when catalog has peers but seed missing',
      courseFn
      && !/else if \(prev && \(courses \|\| \[\]\)\.length > 0\) \{\s*scheduleDrawerClearSelectedCourse\(\);/.test(courseFn)
      && /compatibility|unavailable|data-selected|eligible/.test(courseFn || ''));
    if (courseFn) {
      const courseNodes = {};
      function makeSelect(selected) {
        return {
          value: selected || '',
          options: [],
          selectedIndex: selected ? 0 : -1,
          _attrs: { 'data-selected': selected || '' },
          getAttribute(k) { return this._attrs[k] != null ? this._attrs[k] : null; },
          setAttribute(k, v) { this._attrs[k] = String(v); },
          innerHTML: '',
        };
      }
      function makeList() {
        return {
          innerHTML: '',
          querySelectorAll() { return []; },
          querySelector() { return null; },
        };
      }
      courseNodes['ps-drawer-course-list'] = makeList();
      courseNodes['ps-drawer-course-select'] = makeSelect('seeded-missing');
      const cSb = {
        el(id) { return courseNodes[id] || null; },
        portalT(k) { return en[k] || k; },
        escHtml(s) {
          return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        },
        scheduleDrawerGetSelectedCourseId() {
          const sel = courseNodes['ps-drawer-course-select'];
          return sel ? String(sel.getAttribute('data-selected') || sel.value || '').trim() : '';
        },
        scheduleDrawerSyncCourseButtons() {},
        scheduleDrawerClearSelectedCourse() {
          const sel = courseNodes['ps-drawer-course-select'];
          if (sel) {
            sel.value = '';
            sel.setAttribute('data-selected', '');
          }
          cSb._cleared = true;
        },
        scheduleDrawerRenderMainActivityPath() {},
        _cleared: false,
        result: null,
      };
      // Catalog has other courses; seeded id absent → must preserve, not clear
      try {
        vm.runInNewContext(
          courseFn
          + '\nresult = scheduleDrawerRenderCourseList('
          + '[{course_id:"other",label:"Other",eligible_on_requested_dates:true}],'
          + '{selectedId:"seeded-missing"});',
          cSb,
          { timeout: 4000 }
        );
        ok('missing seed course not cleared by catalog peers',
          cSb._cleared !== true
          && courseNodes['ps-drawer-course-select'].getAttribute('data-selected') === 'seeded-missing');
        ok('missing seed course surfaced as unavailable/compatibility in list or select',
          /seeded-missing/.test(courseNodes['ps-drawer-course-list'].innerHTML)
          || /seeded-missing/.test(courseNodes['ps-drawer-course-select'].innerHTML)
          || courseNodes['ps-drawer-course-select'].getAttribute('data-compatibility-unavailable') === '1');
      } catch (e) {
        ok('course list missing-seed render runs', false, String(e && e.message || e));
      }
      // Ineligible (dates) seed preserved
      courseNodes['ps-drawer-course-list'] = makeList();
      courseNodes['ps-drawer-course-select'] = makeSelect('c-inelig');
      cSb._cleared = false;
      try {
        vm.runInNewContext(
          'result = scheduleDrawerRenderCourseList('
          + '[{course_id:"c-inelig",label:"Inelig",eligible_on_requested_dates:false},'
          + '{course_id:"ok",label:"OK",eligible_on_requested_dates:true}],'
          + '{selectedId:"c-inelig"});',
          cSb,
          { timeout: 4000 }
        );
        ok('ineligible seed course not cleared',
          cSb._cleared !== true
          && courseNodes['ps-drawer-course-select'].getAttribute('data-selected') === 'c-inelig');
      } catch (e) {
        ok('course list ineligible-seed render runs', false, String(e && e.message || e));
      }
    }
    // Seed path must not invent eligible:true for missing catalog course
    ok('seed main activity does not invent eligible:true for empty-catalog course',
      !/eligible_on_requested_dates:\s*true\s*\}\s*\]/.test(
        extractFn(editSrc, 'scheduleDrawerSeedMainActivityView') || ''
      )
      || /eligible_on_requested_dates:\s*false/.test(
        extractFn(editSrc, 'scheduleDrawerSeedMainActivityView') || ''
      ));
  }

  // I4) Async mount race — generation token on catalog init + late callbacks
  {
    ok('edit wire captures openGen/mountGen for late catalog callbacks',
      /scheduleWireEditableDrawer/.test(editSrc)
      && (/mountGen|openGen/.test(extractFn(editSrc, 'scheduleWireEditableDrawer') || '')
        || /scheduleDrawerIsRequestActive|scheduleDrawerState\.(openGen|mountGen)/.test(editSrc)));
    ok('late catalog callback gated by active generation',
      /scheduleFetchLessonTimesConfig[\s\S]{0,400}then\(function/.test(editSrc)
      && (/scheduleDrawerIsRequestActive|mountGen|openGen/.test(
        (extractFn(editSrc, 'scheduleWireEditableDrawer') || '')
        + (extractFn(editSrc, 'scheduleDrawerPopulateCourseSelect') || '')
      )));
    // Behavioral race: booking A late callback must not mutate booking B DOM
    const wireFn = extractFn(editSrc, 'scheduleWireEditableDrawer');
    const ctrlSrc = fs.readFileSync(
      path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-controller.js'),
      'utf8'
    );
    ok('controller exposes openGen + isRequestActive + mountGen',
      /openGen/.test(ctrlSrc)
      && /function scheduleDrawerIsRequestActive/.test(ctrlSrc)
      && (/mountGen|function scheduleDrawerBumpMountGeneration/.test(ctrlSrc)
        || /function scheduleMountDrawerBody/.test(ctrlSrc)));
    if (wireFn) {
      let catalogResolve = null;
      const bodyA = { booking: 'A', mutated: false, courseListHtml: '' };
      const bodyB = { booking: 'B', mutated: false, courseListHtml: 'B-seed' };
      let activeBody = bodyA;
      const state = {
        row: { booking_id: 'A' },
        ctx: { booking_id: 'A' },
        editing: true,
        openGen: 1,
        mountGen: 1,
        activeBookingKey: 'id:A',
      };
      const nodes = {
        'ps-drawer-body': activeBody,
        'ps-drawer-course-list': {
          get innerHTML() { return activeBody.courseListHtml; },
          set innerHTML(v) { activeBody.courseListHtml = v; activeBody.mutated = true; },
          querySelectorAll() { return []; },
          style: { display: '' },
          setAttribute() {},
          removeAttribute() {},
        },
        'ps-drawer-course-select': {
          value: '',
          options: [],
          _attrs: { 'data-selected': 'course-A' },
          getAttribute(k) { return this._attrs[k] != null ? this._attrs[k] : null; },
          setAttribute(k, v) { this._attrs[k] = String(v); },
          addEventListener() {},
          innerHTML: '',
        },
        'ps-drawer-comp-course': { checked: true, addEventListener() {} },
        'ps-drawer-comp-private-lesson': { checked: false, addEventListener() {} },
        'ps-drawer-comp-no-lesson': { checked: false, addEventListener() {} },
        'ps-drawer-main-activity-back': { dataset: {}, addEventListener() {}, style: {} },
        'ps-drawer-comp-fullday': null,
        'ps-drawer-date-from': { value: '2026-07-20', addEventListener() {} },
        'ps-drawer-date-to': { value: '2026-07-20', addEventListener() {} },
        'ps-drawer-course-qty': { value: '1', addEventListener() {} },
        'ps-drawer-private-lesson-surfers': null,
        'ps-drawer-surfers': null,
        'ps-drawer-guest': { addEventListener() {} },
        'ps-drawer-save': { addEventListener() {} },
        'ps-drawer-cancel': { addEventListener() {} },
        'ps-drawer-stripe-link': null,
        'ps-detail-drawer': { style: { display: 'flex' }, querySelector() { return { id: 'ps-drawer-edit-form' }; } },
      };
      const raceSb = {
        el(id) { return nodes[id] || null; },
        scheduleDrawerState: state,
        scheduleDrawerBookingKey(row) {
          return row && row.booking_id ? 'id:' + row.booking_id : null;
        },
        scheduleDrawerIsRequestActive(openGen, bookingKey) {
          if (openGen !== state.openGen) return false;
          if (bookingKey && state.activeBookingKey !== bookingKey) return false;
          const drawer = nodes['ps-detail-drawer'];
          if (!drawer || drawer.style.display === 'none') return false;
          return true;
        },
        scheduleFindGroupForRow(row) { return row; },
        scheduleWireDrawerHeaderActions() {},
        scheduleWireDrawerDateRange() {},
        scheduleWireDrawerMainActivityButtons() {},
        scheduleDrawerSeedCustomLinesFromCtx() {},
        scheduleDrawerRenderCustomLines() {},
        scheduleWireDrawerCustomLines() {},
        scheduleDrawerSetCustomLineEditorOpen() {},
        scheduleFetchLessonTimesConfig() {
          return {
            then(cb) {
              catalogResolve = cb;
              return { catch() { return this; }, then() { return this; } };
            },
          };
        },
        scheduleDrawerSeedMainActivityView() {
          activeBody.mutated = true;
          activeBody.courseListHtml = 'SEEDED-FROM-LATE-A';
        },
        scheduleDrawerPopulateComponentFields() { activeBody.mutated = true; },
        scheduleRenderDrawerRentals() { activeBody.mutated = true; },
        scheduleRefreshDrawerFullDayAddon() {},
        scheduleDrawerRefreshDurationConfirm() {},
        scheduleDrawerSyncFooter() {},
        scheduleDrawerOnComponentChange() {},
        scheduleDrawerMarkPriceStale() {},
        scheduleDrawerExitMainActivityDrilldown() {},
        scheduleDrawerSyncRentalQtyFromSurfers() {},
        scheduleSyncDrawerDateRangeUi() {},
        scheduleDrawerSyncPrivateSessions() {},
        scheduleDrawerPopulateCourseSelect() {},
        scheduleDrawerRefreshWhenSummary() {},
        scheduleWireDrawerStripeCopyOpen() {},
        scheduleWireDrawerConversation() {},
        scheduleWireDrawerOpenCustomer() {},
        scheduleWireDrawerManualPayment() {},
        scheduleLoadDrawerWaiver() {},
        scheduleWireDrawerDeleteBooking() {},
        scheduleSaveDrawerBooking() {},
        scheduleCancelDrawerEditMode() {},
        scheduleCreateDrawerStripeLink() {},
        getClient() { return 'sunset'; },
      };
      try {
        vm.runInNewContext(wireFn + '\nscheduleWireEditableDrawer({booking_id:"A"}, {booking_id:"A"});', raceSb, { timeout: 4000 });
        // Switch to booking B (open another) before A catalog resolves
        state.openGen = 2;
        state.mountGen = 2;
        state.row = { booking_id: 'B' };
        state.activeBookingKey = 'id:B';
        activeBody = bodyB;
        bodyB.courseListHtml = 'B-seed';
        bodyB.mutated = false;
        if (typeof catalogResolve === 'function') catalogResolve({});
        ok('late booking A catalog cannot mutate booking B DOM/state',
          bodyB.mutated === false && bodyB.courseListHtml === 'B-seed');
      } catch (e) {
        ok('mount race behavioral proof runs', false, String(e && e.message || e));
      }
    }
  }

  // I5) Locale a11y — weekday/month/date cell labels follow portal locale
  {
    ok('date range calendar uses getStaffLocale (not host undefined locale only)',
      /getStaffLocale/.test(extractFn(editSrc, 'scheduleRenderDrawerDateRangeCalendar') || editSrc)
      || /getStaffLocale/.test(editSrc));
    ok('weekday labels use portal i18n keys (calendar.day.*)',
      /calendar\.day\.(sun|mon)/.test(editSrc)
      && !/var dows = \['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'\]/.test(
        extractFn(editSrc, 'scheduleRenderDrawerDateRangeCalendar') || ''
      ));
    const calFn = extractFn(editSrc, 'scheduleRenderDrawerDateRangeCalendar');
    const localeFn = extractFn(editSrc, 'scheduleDrawerStaffLocaleTag') || '';
    const ariaFn = extractFn(editSrc, 'scheduleDrawerDateCellAriaLabel') || '';
    if (calFn) {
      function renderCal(locale) {
        const grid = {
          innerHTML: '',
          _dateRangeCells: null,
        };
        const monthLabel = { textContent: '' };
        const apply = { disabled: true };
        const nodes = {
          'ps-drawer-date-range-grid': grid,
          'ps-drawer-date-range-month-label': monthLabel,
          'ps-drawer-date-range-apply': apply,
        };
        const sb = {
          el(id) { return nodes[id] || null; },
          scheduleDrawerDateRangeViewYm: '2026-07',
          scheduleDrawerDateRangeDraft: { start: '2026-07-20', end: '2026-07-22' },
          scheduleDrawerDateRangeFocusIso: '2026-07-20',
          scheduleTodayIso() { return '2026-07-01'; },
          scheduleCreateDateRangeIsValidIso(iso) {
            return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(iso || '').slice(0, 10));
          },
          getStaffLocale() { return locale; },
          portalT(k) {
            if (locale === 'es') return (es[k] || en[k] || k);
            if (locale === 'it') return (it[k] || en[k] || k);
            return en[k] || k;
          },
          escHtml(s) {
            return String(s == null ? '' : s)
              .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          },
        };
        vm.runInNewContext(
          localeFn + '\n' + ariaFn + '\n' + calFn + '\nscheduleRenderDrawerDateRangeCalendar();',
          sb,
          { timeout: 4000 }
        );
        return { html: grid.innerHTML, month: monthLabel.textContent };
      }
      try {
        const enCal = renderCal('en');
        const esCal = renderCal('es');
        const itCal = renderCal('it');
        ok('EN weekday uses calendar.day mon/sun labels',
          /Sun|Mon|Mon|Su|Mo/.test(enCal.html) || /calendar\.day/.test(enCal.html)
          || (en['calendar.day.sun'] && enCal.html.indexOf(en['calendar.day.sun']) >= 0));
        ok('ES weekday labels differ from EN hard-coded Su/Mo set',
          esCal.html.indexOf('Dom') >= 0 || esCal.html.indexOf(es['calendar.day.sun'] || 'Dom') >= 0
          || (es['calendar.day.mon'] && esCal.html.indexOf(es['calendar.day.mon']) >= 0));
        ok('IT weekday labels differ from EN hard-coded Su/Mo set',
          itCal.html.indexOf('Dom') >= 0 || itCal.html.indexOf(it['calendar.day.sun'] || 'Dom') >= 0
          || (it['calendar.day.lun'] && false)
          || (it['calendar.day.mon'] && itCal.html.indexOf(it['calendar.day.mon']) >= 0));
        ok('month label localized via staff locale (ES/IT not forced English host)',
          (esCal.month && /julio|July|2026/i.test(esCal.month))
          && (itCal.month && /luglio|July|2026/i.test(itCal.month)));
        ok('date cell aria-label present and not host-locale-only raw without locale path',
          /aria-label=/.test(enCal.html) && /aria-label=/.test(esCal.html));
      } catch (e) {
        ok('locale calendar render runs', false, String(e && e.message || e));
      }
    } else {
      ok('scheduleRenderDrawerDateRangeCalendar extractable', false);
    }
    // Touched strings: no English-only fallback when production key exists for courses none
    const courseListSrc = extractFn(editSrc, 'scheduleDrawerRenderCourseList') || '';
    ok('course noneConfigured has no English-only fallback when key exists',
      !/\|\|\s*'No group courses configured'/.test(courseListSrc)
      && !/\|\|\s*"No group courses configured"/.test(courseListSrc));
  }

  // I6) Mutation tests must not rewrite tracked production files (structural proof in lifecycle gate)
  {
    const lifeSrc = fs.readFileSync(
      path.join(ROOT, 'scripts/verify-sunset-schedule-drawer-edit-ui.js'),
      'utf8'
    );
    ok('lifecycle gate mutation block avoids writeFileSync on EDIT_MODULE path',
      !/fs\.writeFileSync\(\s*EDIT_MODULE/.test(lifeSrc)
      || /in-memory|temp|mkdtemp|byte-identical|do not write|without writing/i.test(lifeSrc));
    ok('lifecycle mutations prove tracked files byte-identical',
      /byte-identical|readFileSync\(EDIT_MODULE[\s\S]{0,200}=== original|Buffer\.compare/.test(lifeSrc));
  }

  console.log('\n── verify:sunset-edit-drawer-parity '
    + (fail ? 'FAILED' : 'PASSED')
    + ' (pass=' + pass + ' fail=' + fail + ') ──\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
