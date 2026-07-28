'use strict';

/**
 * verify:sunset-create-drawer-polish
 *
 * Offline gates for approved Create Booking drawer polish:
 *  A) Header: title + active school on one row (no wrap); close far right; 390px contract
 *  B) Compact From–To range trigger + accessible in-drawer calendar;
 *     hidden ps-create-date-from/to remain canonical compatibility state
 *  C) Uniform top-level Create card padding (12px vertical / 14px horizontal)
 *  D) Main activity Group / Private / No lesson as real buttons with
 *     exclusive aria-pressed, selected style, keyboard focus; no radio glyph
 *  E) EN/ES (and IT when present) copy for new range UI strings
 *  F) Mobile width constraints
 *  G) Behavioral: Back/exit path resets visible activity to No lesson
 *  H) Behavioral: honest calendar a11y (focus, Escape, Cancel/Apply, outside, roving keys)
 *  I) Behavioral: no Clear action; Cancel remains non-mutating; Apply needs a start
 *     (one-day: start-only Apply commits date_from=date_to=start; multi-day still 2-click)
 *  J) Calendar is labelled group of real date buttons (no invalid grid roles);
 *     selected days expose truthful aria-pressed
 *
 * Static + pure DOM/vm runtime — no DB/Azure/network.
 * Run: node scripts/verify-sunset-create-drawer-polish.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
const i18nSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const esSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const esSunset = require('./lib/staff-portal-i18n-es-sunset');

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

/** Lightweight runtime DOM for calendar + activity behavioral tests. */
function buildPolishRuntime() {
  const nodes = {};
  const docListeners = { keydown: [], mousedown: [] };
  let focused = null;

  function parseDayButtons(html) {
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
      if (!date) continue;
      const btn = {
        tagName: 'BUTTON',
        type: 'button',
        className: cls,
        classList: makeClassList(cls.split(/\s+/)),
        textContent: text,
        tabIndex: Number(get('tabindex') != null ? get('tabindex') : 0),
        _attrs: {
          'data-date': date,
          role: get('role') || null,
          'aria-label': get('aria-label') || date,
          'aria-pressed': get('aria-pressed'),
          tabindex: get('tabindex') != null ? get('tabindex') : '0',
        },
        getAttribute(k) { return this._attrs[k] != null ? this._attrs[k] : null; },
        setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'tabindex' || k === 'tabIndex') this.tabIndex = Number(v); },
        focus() { focused = this; },
        closest(sel) {
          if (sel === '[data-date]' && this.getAttribute('data-date')) return this;
          if (sel === 'button') return this;
          return null;
        },
      };
      out.push(btn);
    }
    return out;
  }

  function makeNode(id, extra) {
    const listeners = {};
    const node = {
      id,
      value: '',
      checked: false,
      disabled: false,
      hidden: false,
      textContent: '',
      innerHTML: '',
      style: { display: '' },
      dataset: {},
      classList: makeClassList([]),
      _attrs: {},
      _children: [],
      _dayButtons: [],
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
        if (k === 'data-create-activity') return this._attrs['data-create-activity'] || null;
        if (k === 'data-date') return this._attrs['data-date'] || null;
        if (k === 'tabindex' || k === 'tabIndex') return this._attrs.tabindex != null ? this._attrs.tabindex : String(this.tabIndex);
        return this._attrs[k] != null ? this._attrs[k] : null;
      },
      setAttribute(k, v) {
        this._attrs[k] = String(v);
        if (k === 'aria-expanded') this._attrs['aria-expanded'] = String(v);
        if (k === 'tabindex' || k === 'tabIndex') this.tabIndex = Number(v);
      },
      focus() { focused = this; },
      contains(child) {
        if (!child) return false;
        if (child === this) return true;
        if (this._dayButtons && this._dayButtons.indexOf(child) >= 0) return true;
        if (this._children && this._children.indexOf(child) >= 0) return true;
        // Field hosts contain known child ids
        if (this.id === 'ps-create-date-range') {
          const ids = [
            'ps-create-date-range-trigger', 'ps-create-date-range-popover',
            'ps-create-date-range-display', 'ps-create-date-from', 'ps-create-date-to',
            'ps-create-date-range-grid',
            'ps-create-date-range-cancel', 'ps-create-date-range-apply',
            'ps-create-date-range-prev', 'ps-create-date-range-next',
          ];
          if (child.id && ids.indexOf(child.id) >= 0) return true;
          if (this._dayButtons && this._dayButtons.indexOf(child) >= 0) return true;
          const pop = nodes['ps-create-date-range-popover'];
          if (pop && pop.contains && pop.contains(child)) return true;
        }
        if (this.id === 'ps-create-date-range-popover') {
          const ids = [
            'ps-create-date-range-grid',
            'ps-create-date-range-cancel', 'ps-create-date-range-apply',
            'ps-create-date-range-prev', 'ps-create-date-range-next',
            'ps-create-date-range-month-label',
          ];
          if (child.id && ids.indexOf(child.id) >= 0) return true;
          if (this._dayButtons && this._dayButtons.indexOf(child) >= 0) return true;
          const grid = nodes['ps-create-date-range-grid'];
          if (grid && grid.contains && grid.contains(child)) return true;
        }
        if (this.id === 'ps-create-main-activity-choices') {
          return !!(this._children && this._children.indexOf(child) >= 0);
        }
        return false;
      },
      querySelector(sel) {
        if (!sel) return null;
        if (sel.startsWith('#')) return nodes[sel.slice(1)] || null;
        if (sel.startsWith('[data-date=')) {
          const m = sel.match(/data-date=["']([^"']+)["']/);
          if (!m) return null;
          const days = this._dayButtons || [];
          return days.find((b) => b.getAttribute('data-date') === m[1]) || null;
        }
        if (sel === '[data-date]') {
          return (this._dayButtons && this._dayButtons[0]) || null;
        }
        if (sel === '.portal-schedule-create-date-range-day:not(.is-outside)') {
          const days = this._dayButtons || [];
          return days.find((b) => !b.classList.contains('is-outside')) || null;
        }
        if (sel.startsWith('[data-create-activity=')) {
          const m = sel.match(/data-create-activity=["']([^"']+)["']/);
          if (!m) return null;
          return (this._children || []).find((c) => c.getAttribute('data-create-activity') === m[1]) || null;
        }
        if (sel === 'button' || sel === '#ps-create-date-range-prev') {
          if (sel === '#ps-create-date-range-prev') return nodes['ps-create-date-range-prev'] || null;
          return nodes['ps-create-date-range-prev'] || (this._dayButtons && this._dayButtons[0]) || null;
        }
        return null;
      },
      querySelectorAll(sel) {
        if (sel && sel.includes('data-date')) return (this._dayButtons || []).slice();
        if (sel && sel.includes('data-create-activity')) return (this._children || []).filter((c) => c.getAttribute('data-create-activity'));
        return [];
      },
      closest(sel) {
        if (sel === '[data-date]' && this.getAttribute('data-date')) return this;
        if (sel === '[data-create-activity]' && this.getAttribute('data-create-activity')) return this;
        return null;
      },
    };
    Object.defineProperty(node, 'innerHTML', {
      get() { return this._innerHTML || ''; },
      set(v) {
        this._innerHTML = String(v || '');
        this._dayButtons = parseDayButtons(this._innerHTML);
        // Keep parent field/popover cell lists in sync for contains()
        if (this.id === 'ps-create-date-range-grid') {
          if (nodes['ps-create-date-range-popover']) {
            nodes['ps-create-date-range-popover']._dayButtons = this._dayButtons;
          }
          if (nodes['ps-create-date-range']) {
            nodes['ps-create-date-range']._dayButtons = this._dayButtons;
          }
        }
      },
      configurable: true,
    });
    Object.assign(node, extra || {});
    nodes[id] = node;
    return node;
  }

  // Activity radios + buttons
  const courseRadio = makeNode('ps-create-comp-course', { type: 'radio', checked: false });
  const privRadio = makeNode('ps-create-comp-private-lesson', { type: 'radio', checked: false });
  const noneRadio = makeNode('ps-create-comp-no-lesson', { type: 'radio', checked: true });
  function makeActivityBtn(id, selected) {
    const btn = makeNode('btn-' + id, {
      tagName: 'BUTTON',
      type: 'button',
      classList: makeClassList(selected ? ['portal-schedule-create-activity-btn', 'is-selected'] : ['portal-schedule-create-activity-btn']),
      _attrs: {
        'data-create-activity': id,
        'aria-pressed': selected ? 'true' : 'false',
      },
    });
    return btn;
  }
  const btnCourse = makeActivityBtn('ps-create-comp-course', false);
  const btnPriv = makeActivityBtn('ps-create-comp-private-lesson', false);
  const btnNone = makeActivityBtn('ps-create-comp-no-lesson', true);
  const choices = makeNode('ps-create-main-activity-choices', {
    _children: [btnCourse, btnPriv, btnNone, courseRadio, privRadio, noneRadio],
  });
  choices.querySelector = function(sel) {
    if (sel && sel.startsWith('[data-create-activity=')) {
      const m = sel.match(/data-create-activity=["']([^"']+)["']/);
      if (!m) return null;
      return this._children.find((c) => c.getAttribute('data-create-activity') === m[1]) || null;
    }
    return null;
  };

  makeNode('ps-create-main-activity-back', { hidden: true, style: { display: 'none' } });
  makeNode('ps-create-main-activity-path', { hidden: true, style: { display: 'none' }, textContent: '' });
  makeNode('ps-create-course-list', { hidden: true, style: { display: 'none' }, innerHTML: '' });
  makeNode('ps-create-private-panel', { hidden: true, style: { display: 'none' } });
  makeNode('ps-create-private-when', { hidden: true, style: { display: 'none' } });
  makeNode('ps-create-course-select', { value: '', selectedIndex: -1 });
  makeNode('ps-create-private-lesson-sessions', { innerHTML: '' });

  // Date range controls
  const trigger = makeNode('ps-create-date-range-trigger', {
    tagName: 'BUTTON',
    _attrs: { 'aria-expanded': 'false' },
  });
  const display = makeNode('ps-create-date-range-display', { textContent: 'Select dates' });
  const popover = makeNode('ps-create-date-range-popover', {
    hidden: true,
    style: { display: 'none' },
  });
  const grid = makeNode('ps-create-date-range-grid', {
    role: 'group',
    _attrs: { role: 'group', 'aria-labelledby': 'ps-create-date-range-month-label' },
    _dayButtons: [],
  });
  const monthLabel = makeNode('ps-create-date-range-month-label', { textContent: '' });
  const prev = makeNode('ps-create-date-range-prev', { tagName: 'BUTTON' });
  const next = makeNode('ps-create-date-range-next', { tagName: 'BUTTON' });
  const cancelBtn = makeNode('ps-create-date-range-cancel', { tagName: 'BUTTON' });
  const applyBtn = makeNode('ps-create-date-range-apply', { tagName: 'BUTTON', disabled: true });
  const dateFrom = makeNode('ps-create-date-from', { value: '2026-07-27', type: 'date' });
  const dateTo = makeNode('ps-create-date-to', { value: '2026-07-29', type: 'date' });
  const field = makeNode('ps-create-date-range', {});
  // outside element for outside-click tests
  const outside = makeNode('outside-click-target', {});

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
  function scheduleTodayIso() { return '2026-07-27'; }
  function portalT(k) {
    const en = STAFF_PORTAL_STRINGS.en || {};
    return en[k] || k;
  }
  function schedulePortalSetVisible(node, vis) {
    if (!node) return;
    node.hidden = !vis;
    node.style.display = vis ? '' : 'none';
  }

  const fnNames = [
    'scheduleCreateDateRangeIsValidIso',
    'scheduleCreateDateRangeSelectDay',
    'scheduleCreateDateRangeAddDays',
    'scheduleCreateDateRangeWeekStartIso',
    'scheduleCreateDateRangeWeekEndIso',
    'scheduleCreateDateRangeSeedDraft',
    'scheduleCreateHeaderRowContract',
    'scheduleCreateDateRangeFormatShort',
    'scheduleCreateDateRangeDisplayText',
    'scheduleCreateDateRangeIsOpen',
    'scheduleSyncCreateDateRangeUi',
    'scheduleCreateDateRangeClosePopover',
    'scheduleCreateDateRangeFocusInto',
    'scheduleCreateDateRangeOpenPopover',
    'scheduleCreateDateRangeTogglePopover',
    'scheduleCreateDateRangeMoveFocus',
    'scheduleRenderCreateDateRangeCalendar',
    'scheduleApplyCreateDateRangeDraft',
    'scheduleCreateDateRangeOnDocumentKeydown',
    'scheduleCreateDateRangeOnDocumentPointer',
    'scheduleWireCreateDateRange',
    'scheduleSyncCreateMainActivityButtons',
    'scheduleWireCreateMainActivityButtons',
  ];
  const portalFnNames = [
    'schedulePortalExitMainActivityDrilldown',
    'schedulePortalExitGroupCourseDrilldown',
  ];

  let bundle = '';
  // Shared mutable state vars used by extracted date-range functions
  bundle += 'var scheduleCreateDateRangeDraft = { start: null, end: null };\n';
  bundle += 'var scheduleCreateDateRangeViewYm = null;\n';
  bundle += 'var scheduleCreateDateRangeFocusIso = null;\n';
  bundle += 'var scheduleCreateDateRangeRestoreFocus = false;\n';
  bundle += 'var scheduleCreateDateRangeDocWired = false;\n';
  bundle += 'var schedulePortalMainActivityView = "root";\n';
  fnNames.forEach((name) => {
    const src = extractFn(apiSrc, name);
    if (!src) throw new Error('missing function ' + name);
    bundle += src + '\n';
  });
  portalFnNames.forEach((name) => {
    const src = extractFn(portalSrc, name);
    if (!src) throw new Error('missing portal function ' + name);
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
    schedulePortalClearSelectedCreateCourse: function() {
      const sel = el('ps-create-course-select');
      if (sel) { sel.value = ''; sel.selectedIndex = -1; }
    },
    schedulePortalClearPrivateSessionDraft: function() {
      const s = el('ps-create-private-lesson-sessions');
      if (s) s.innerHTML = '';
    },
    schedulePortalPrivatePanelNode: function() { return el('ps-create-private-panel'); },
    schedulePortalSyncCreateSubmitEnabled: function() {},
    schedulePortalInvalidateCreateQuoteIntent: function() {},
    Event: function Event(type, init) {
      this.type = type;
      this.bubbles = !!(init && init.bubbles);
    },
    console,
  };

  vm.runInNewContext(bundle, sandbox, { timeout: 5000 });

  // Wire once
  sandbox.scheduleWireCreateDateRange();
  sandbox.scheduleWireCreateMainActivityButtons();
  sandbox.scheduleSyncCreateMainActivityButtons();
  sandbox.scheduleSyncCreateDateRangeUi();

  return {
    nodes,
    el,
    document,
    sandbox,
    getFocused: () => focused,
    setFocused: (n) => { focused = n; },
    outside,
    activityButtons: { course: btnCourse, priv: btnPriv, none: btnNone },
    dayButtons() {
      return (grid._dayButtons || []).slice();
    },
    fireGridKey(iso, key) {
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
    fireGridClick(iso) {
      const btn = grid.querySelector('[data-date="' + iso + '"]');
      if (!btn) throw new Error('no day button for ' + iso);
      grid.dispatchEvent({
        type: 'click',
        target: btn,
        preventDefault() {},
      });
    },
  };
}

const modal = extractCreateModalHtml(apiSrc);
const headerCss = extractCssBlock(apiSrc, '.portal-schedule-create-header{');
const headerTextCss = extractCssBlock(apiSrc, '.portal-schedule-create-header-text{');
const titleCss = extractCssBlock(apiSrc, '.portal-schedule-create-title{');
const chipCss = extractCssBlock(apiSrc, '.portal-schedule-create-school-chip{');
const sectionCss = extractCssBlock(apiSrc, '.portal-schedule-create-section{');
const customAddonCss = extractCssBlock(apiSrc, '.portal-schedule-create-custom-addon-card{');
const activityBtnCss =
  extractCssBlock(apiSrc, '.portal-schedule-create-activity-btn{')
  || extractCssBlock(apiSrc, '.portal-schedule-create-main-activity-btn{');

console.log('\nverify:sunset-create-drawer-polish\n');

// ── A) Header: title + school same row ─────────────────────────────────────
console.log('[A] Header title + school same row; close far right');
assert('header + header-text + close present',
  /portal-schedule-create-header/.test(modal)
  && /portal-schedule-create-header-text/.test(modal)
  && /id="ps-create-close"/.test(modal)
  && /id="ps-create-title"/.test(modal)
  && /id="ps-create-school-context"/.test(modal));
assert('header-text is row layout (title + school same row)',
  /display:\s*flex/.test(headerTextCss)
  && /flex-direction:\s*row/.test(headerTextCss)
  && /align-items:\s*center/.test(headerTextCss));
assert('header aligns items center for single-row chrome',
  /align-items:\s*center/.test(headerCss));
assert('header-text does not wrap title/chip onto second row',
  /flex-wrap:\s*nowrap/.test(headerTextCss)
  && !/flex-wrap:\s*wrap/.test(headerTextCss));
assert('header-text + title use min-width:0 for truncation',
  /min-width:\s*0/.test(headerTextCss)
  && /min-width:\s*0/.test(titleCss));
assert('title truncates with ellipsis when space is tight',
  /text-overflow:\s*ellipsis/.test(titleCss)
  && /white-space:\s*nowrap/.test(titleCss)
  && /overflow:\s*hidden/.test(titleCss));
assert('school chip truncates (ellipsis + nowrap + min-width:0)',
  /text-overflow:\s*ellipsis/.test(chipCss)
  && /white-space:\s*nowrap/.test(chipCss)
  && /min-width:\s*0/.test(chipCss)
  && /overflow:\s*hidden/.test(chipCss));
assert('title precedes school chip precedes close in markup', (() => {
  const t = modal.indexOf('id="ps-create-title"');
  const s = modal.indexOf('id="ps-create-school-context"');
  const c = modal.indexOf('id="ps-create-close"');
  return t >= 0 && s > t && c > s;
})());
assert('school chip not forced onto its own block via column header-text',
  !/flex-direction:\s*column/.test(headerTextCss));
assert('close button flex preserved (44px target)',
  /#ps-create-close\{[^}]*flex:\s*0\s+0\s+auto/.test(apiSrc)
  && /#ps-create-close\{[^}]*min-width:\s*44px/.test(apiSrc));

// ── B) Date range trigger + calendar; hidden from/to ───────────────────────
console.log('\n[B] Compact From–To range + calendar; hidden from/to canonical');
assert('range trigger present',
  /id="ps-create-date-range-trigger"/.test(modal)
  || /id="ps-create-date-range-btn"/.test(modal));
assert('range display present',
  /id="ps-create-date-range-display"/.test(modal));
assert('dynamic range display is JS-owned, not overwritten by generic i18n',
  /id="ps-create-date-range-display"/.test(modal)
  && !/id="ps-create-date-range-display"[^>]*data-i18n=/.test(modal));
assert('range popover/calendar host present',
  /id="ps-create-date-range-popover"/.test(modal)
  || /id="ps-create-date-range-calendar"/.test(modal));
assert('range actions Cancel + Apply/Done present (no Clear)',
  !/id="ps-create-date-range-clear"/.test(modal)
  && !/function scheduleClearCreateDateRangeDraft/.test(apiSrc)
  && (/id="ps-create-date-range-cancel"/.test(modal) || /dateRange\.cancel/.test(modal + apiSrc))
  && (/id="ps-create-date-range-apply"/.test(modal)
    || /id="ps-create-date-range-done"/.test(modal)
    || /dateRange\.(apply|done)/.test(modal + apiSrc)));
assert('canonical date from/to ids preserved once each',
  (modal.match(/id="ps-create-date-from"/g) || []).length === 1
  && (modal.match(/id="ps-create-date-to"/g) || []).length === 1);
assert('date from/to are hidden compatibility inputs (not dual visible natives)', (() => {
  const fromChunk = modal.slice(
    modal.indexOf('id="ps-create-date-from"') - 120,
    modal.indexOf('id="ps-create-date-from"') + 200
  );
  const toChunk = modal.slice(
    modal.indexOf('id="ps-create-date-to"') - 120,
    modal.indexOf('id="ps-create-date-to"') + 200
  );
  const hiddenish = (chunk) =>
    /type="hidden"/.test(chunk)
    || /hidden/.test(chunk)
    || /aria-hidden="true"/.test(chunk)
    || /portal-schedule-create-date-hidden|visually-hidden|sr-only/.test(chunk)
    || /tabindex="-1"/.test(chunk);
  const noDualVisibleLabels =
    !/<label[^>]*for="ps-create-date-from"/.test(modal)
    && !/<label[^>]*for="ps-create-date-to"/.test(modal);
  return hiddenish(fromChunk) && hiddenish(toChunk) && noDualVisibleLabels;
})());
assert('range trigger is a button (not two native date fields)',
  /<(button)[^>]*id="ps-create-date-range-trigger"/.test(modal)
  || /<(button)[^>]*id="ps-create-date-range-btn"/.test(modal));
assert('calendar selection owner functions present',
  /function schedule(Open|Toggle|Wire|Sync)CreateDateRange/.test(apiSrc)
  || /function scheduleCreateDateRange/.test(apiSrc)
  || /scheduleWireCreateDateRange|scheduleSyncCreateDateRange|scheduleApplyCreateDateRange/.test(apiSrc));
assert('selection rules documented in owner (start/end, restart, same-day, inclusive)',
  /restart|re-?start|same[- ]?day|inclusive|draftStart|draftEnd|rangeStart|rangeEnd/.test(apiSrc)
  && (/second.*start|earlier|before.*start|draftStart/.test(apiSrc)));
assert('embedded range validators survive the /staff/ui template layer', (() => {
  const validator = extractFn(apiSrc, 'scheduleCreateDateRangeIsValidIso');
  const owners = [
    extractFn(apiSrc, 'scheduleCreateDateRangeSelectDay'),
    extractFn(apiSrc, 'scheduleCreateDateRangeAddDays'),
    extractFn(apiSrc, 'scheduleCreateDateRangeSeedDraft'),
    extractFn(apiSrc, 'scheduleCreateDateRangeFormatShort'),
    extractFn(apiSrc, 'scheduleCreateDateRangeMoveFocus'),
  ].join('\n');
  return validator.includes('[0-9]{4}-[0-9]{2}-[0-9]{2}')
    && owners.includes('scheduleCreateDateRangeIsValidIso')
    && !validator.includes('\\\\d{4}');
})());
assert('a11y keyboard/focus owners present (focus into, Escape, roving move)',
  /function scheduleCreateDateRangeFocusInto/.test(apiSrc)
  && /function scheduleCreateDateRangeMoveFocus/.test(apiSrc)
  && /function scheduleCreateDateRangeOnDocumentKeydown/.test(apiSrc)
  && /function scheduleCreateDateRangeOnDocumentPointer/.test(apiSrc)
  && /function scheduleCreateDateRangeAddDays/.test(apiSrc));
assert('no invalid ARIA grid roles on calendar (prefer labelled group of buttons)',
  !/role="grid"/.test(modal)
  && !/role="columnheader"/.test(apiSrc)
  && !/role="gridcell"/.test(apiSrc)
  && (/role="group"/.test(modal) || /aria-labelledby="ps-create-date-range-month-label"/.test(modal)));
assert('date buttons expose aria-pressed selected state + accessible labels',
  /aria-pressed=/.test(apiSrc)
  && /aria-label=/.test(apiSrc)
  && /data-date=/.test(apiSrc));
assert('roving keyboard behavior owners present (no grid role required)',
  /ArrowLeft|ArrowRight|ArrowUp|ArrowDown/.test(apiSrc)
  && /scheduleCreateDateRangeMoveFocus/.test(apiSrc)
  && /tabindex/.test(apiSrc));

// Behavioral calendar selection via extracted pure helper if present
{
  const pureName = [
    'scheduleCreateDateRangeSelectDay',
    'scheduleDateRangeSelectDay',
    'scheduleApplyDateRangeDaySelection',
  ].find((n) => extractFn(apiSrc, n));
  if (pureName) {
    const validatorSrc = extractFn(apiSrc, 'scheduleCreateDateRangeIsValidIso');
    const fnSrc = extractFn(apiSrc, pureName);
    const sandbox = {
      result: null,
      scheduleParseIso(s) {
        const p = String(s || '').split('-');
        return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
      },
      scheduleIsoDate(d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      },
    };
    vm.runInNewContext(
      validatorSrc + '\n' + fnSrc + '; result = ' + pureName + ';',
      sandbox
    );
    const select = sandbox.result;
    let st = select({}, '2026-07-27');
    assert('first click sets start only', st.start === '2026-07-27' && !st.end);
    st = select(st, '2026-07-29');
    assert('second later click sets end', st.start === '2026-07-27' && st.end === '2026-07-29');
    st = select({ start: '2026-07-27', end: null }, '2026-07-25');
    assert('earlier second selection restarts as new start',
      st.start === '2026-07-25' && !st.end);
    st = select({ start: '2026-07-27', end: null }, '2026-07-27');
    assert('same-day range supported', st.start === '2026-07-27' && st.end === '2026-07-27');
  } else {
    assert('pure date-range day selection helper exported', false,
      'expected scheduleCreateDateRangeSelectDay (or alias)');
  }
}

// Pure addDays / week bounds
{
  const helpers = ['scheduleCreateDateRangeAddDays', 'scheduleCreateDateRangeWeekStartIso', 'scheduleCreateDateRangeWeekEndIso'];
  const need = helpers.map((n) => extractFn(apiSrc, n));
  if (need.every(Boolean)) {
    const sandbox = {
      scheduleParseIso(s) {
        const p = String(s || '').split('-');
        return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
      },
      scheduleIsoDate(d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      },
    };
    const validatorSrc = extractFn(apiSrc, 'scheduleCreateDateRangeIsValidIso');
    vm.runInNewContext(validatorSrc + '\n' + need.join('\n') + '; this.add = scheduleCreateDateRangeAddDays; this.ws = scheduleCreateDateRangeWeekStartIso; this.we = scheduleCreateDateRangeWeekEndIso;', sandbox);
    assert('addDays +1', sandbox.add('2026-07-27', 1) === '2026-07-28');
    assert('addDays -7', sandbox.add('2026-07-27', -7) === '2026-07-20');
    assert('week start Sunday for Monday 2026-07-27', sandbox.ws('2026-07-27') === '2026-07-26');
    assert('week end Saturday for Monday 2026-07-27', sandbox.we('2026-07-27') === '2026-08-01');
  } else {
    assert('pure date-range keyboard math helpers present', false, 'missing addDays/week helpers');
  }
}

// Inclusive highlight CSS/class
assert('inclusive range highlight class/CSS present',
  /is-in-range|is-range|range-day|date-range-day|is-selected-start|is-selected-end/.test(apiSrc));

// Payload owners still read hidden from/to (unchanged contract)
assert('portal prepare still writes ps-create-date-from/to',
  /ps-create-date-from/.test(portalSrc) && /ps-create-date-to/.test(portalSrc));
assert('create payload/read still uses date from/to elements',
  /ps-create-date-from/.test(apiSrc) && /ps-create-date-to/.test(apiSrc)
  && /scheduleCreateDateSpanForRentals|scheduleReadCreatePayload|date_from/.test(apiSrc + portalSrc));

// ── C) Uniform card padding ────────────────────────────────────────────────
console.log('\n[C] Uniform Create card padding 12px / 14px');
assert('create-section padding is 12px 14px',
  /padding:\s*12px\s+14px/.test(sectionCss));
assert('custom-addon card matches 12px 14px (no extra 14 all-around)',
  /padding:\s*12px\s+14px/.test(customAddonCss)
  || (!/padding:\s*14px[;}]/.test(customAddonCss) && /padding:\s*12px\s+14px/.test(sectionCss)));
assert('main activity choices drop extra top/bottom margin whitespace',
  !/\.portal-schedule-create-components\{[^}]*margin:\s*8px\s+0/.test(
    extractCssBlock(apiSrc, '.portal-schedule-create-main-activity{')
    || ''
  )
  || /portal-schedule-create-main-activity\{[^}]*margin:\s*0/.test(apiSrc)
  || /\.portal-schedule-create-components\.portal-schedule-create-main-activity\{[^}]*margin:\s*0/.test(apiSrc));
assert('activity controls keep ≥44px touch targets',
  /min-height:\s*44px/.test(activityBtnCss)
  || /\.portal-schedule-create-main-activity[\s\S]{0,240}min-height:\s*44px/.test(apiSrc));

// ── D) Main activity real buttons ──────────────────────────────────────────
console.log('\n[D] Main activity real buttons + aria-pressed exclusive');
assert('Group/Private/No lesson ids preserved',
  /id="ps-create-comp-course"/.test(modal)
  && /id="ps-create-comp-private-lesson"/.test(modal)
  && /id="ps-create-comp-no-lesson"/.test(modal));
assert('visible activity controls are buttons (not labeled radio glyphs)',
  /portal-schedule-create-activity-btn|portal-schedule-create-main-activity-btn/.test(modal)
  && /<button[^>]+(portal-schedule-create-activity-btn|portal-schedule-create-main-activity-btn)/.test(modal));
assert('aria-pressed used on activity buttons',
  /aria-pressed=/.test(modal) || /setAttribute\(\s*['"]aria-pressed['"]/.test(apiSrc));
assert('no visible radio glyph on main activity choices', (() => {
  const choicesStart = modal.indexOf('id="ps-create-main-activity-choices"');
  if (choicesStart < 0) return false;
  const choicesEnd = modal.indexOf('id="ps-create-course-list"', choicesStart);
  const chunk = modal.slice(choicesStart, choicesEnd > choicesStart ? choicesEnd : choicesStart + 2000);
  const visibleRadioLabel = /<label[^>]*portal-schedule-create-check[^>]*>\s*<input[^>]*type="radio"/.test(chunk);
  return !visibleRadioLabel;
})());
assert('selected style class for pressed activity button',
  /is-selected|is-pressed|aria-pressed/.test(activityBtnCss + apiSrc));
assert('keyboard/focus-visible support on activity buttons',
  /:focus-visible/.test(activityBtnCss) || /activity-btn:focus/.test(apiSrc));
assert('sync helper keeps aria-pressed exclusive with radio state',
  /function scheduleSyncCreateMainActivity|scheduleSyncMainActivityButtons|aria-pressed/.test(apiSrc)
  && /ps-create-comp-course/.test(apiSrc));
assert('drill-down / Back owners unchanged',
  /schedulePortalEnterGroupCourseDrilldown|schedulePortalExitMainActivityDrilldown|ps-create-main-activity-back/.test(apiSrc + portalSrc));
assert('exit/Back path invokes visible activity button sync', (() => {
  const exitFn = extractFn(portalSrc, 'schedulePortalExitMainActivityDrilldown') || '';
  const exitGroup = extractFn(portalSrc, 'schedulePortalExitGroupCourseDrilldown') || '';
  const backWire = apiSrc.includes('ps-create-main-activity-back')
    && /scheduleSyncCreateMainActivityButtons/.test(apiSrc);
  return /scheduleSyncCreateMainActivityButtons/.test(exitFn)
    && /scheduleSyncCreateMainActivityButtons/.test(exitGroup)
    && backWire;
})());

// ── E) i18n EN/ES (+IT) ────────────────────────────────────────────────────
console.log('\n[E] Localized EN/ES range copy');
const en = STAFF_PORTAL_STRINGS.en || {};
const it = STAFF_PORTAL_STRINGS.it || {};
const requiredKeys = [
  'schedule.create.dateRange',
  'schedule.create.dateRange.cancel',
  'schedule.create.dateRange.apply',
];
requiredKeys.forEach((k) => {
  assert('EN ' + k, !!(en[k] && String(en[k]).trim()));
  assert('ES ' + k, !!(esSunset[k] && String(esSunset[k]).trim() && esSunset[k] !== en[k]));
});
// Clear was removed (booking dates cannot be empty; reset-to-applied was a mislabeled no-op).
assert('no schedule.create.dateRange.clear i18n key (Clear action removed)',
  !en['schedule.create.dateRange.clear']
  && !esSunset['schedule.create.dateRange.clear']
  && !(it && it['schedule.create.dateRange.clear'])
  && !i18nSrc.includes('schedule.create.dateRange.clear')
  && !esSrc.includes('schedule.create.dateRange.clear'));
if (en['schedule.create.dateRange.done'] || esSunset['schedule.create.dateRange.done']) {
  assert('EN/ES dateRange.done pair',
    !!(en['schedule.create.dateRange.done'] && esSunset['schedule.create.dateRange.done']));
}
if (it && Object.keys(it).length) {
  requiredKeys.forEach((k) => {
    if (it[k]) assert('IT ' + k + ' present', String(it[k]).trim().length > 0);
  });
}
assert('i18n source files hold new keys',
  requiredKeys.every((k) => i18nSrc.includes(k) && esSrc.includes(k)));

// ── F) 390px no-overflow still constrained ─────────────────────────────────
console.log('\n[F] Mobile width constraints preserved');
assert('create drawer width constrained (min/100vw mobile)',
  /width:\s*min\(440px,\s*94vw\)/.test(apiSrc)
  && (/@media\(max-width:640px\)\{[^}]*portal-schedule-create-drawer\{[^}]*width:100vw/.test(apiSrc)
    || /\.portal-schedule-drawer,\.portal-schedule-create-drawer\{width:100vw/.test(apiSrc)));
assert('create drawer overflow-x hidden',
  /portal-schedule-create-drawer\{[^}]*overflow-x:\s*hidden/.test(apiSrc)
  || /overflow-x:\s*hidden/.test(extractCssBlock(apiSrc, '.portal-schedule-create-drawer{')));

// ── G) Behavioral: Back/exit → No lesson visible selection ─────────────────
console.log('\n[G] Behavioral: Back from Group/Private syncs No lesson buttons');
{
  let rt;
  try {
    rt = buildPolishRuntime();
  } catch (e) {
    assert('polish runtime boots', false, String(e && e.message || e));
    rt = null;
  }
  if (rt) {
    const { el, sandbox, activityButtons } = rt;
    // Simulate Group selected (stale visible button would stay Group without sync)
    el('ps-create-comp-course').checked = true;
    el('ps-create-comp-private-lesson').checked = false;
    el('ps-create-comp-no-lesson').checked = false;
    activityButtons.course.classList.add('is-selected');
    activityButtons.course.setAttribute('aria-pressed', 'true');
    activityButtons.none.classList.remove('is-selected');
    activityButtons.none.setAttribute('aria-pressed', 'false');
    activityButtons.priv.classList.remove('is-selected');
    activityButtons.priv.setAttribute('aria-pressed', 'false');

    // Real Back/exit path
    sandbox.schedulePortalExitMainActivityDrilldown({ clearCourse: true, clearPrivate: true });

    assert('Back exit: No lesson radio checked', !!el('ps-create-comp-no-lesson').checked);
    assert('Back exit: Group radio unchecked', !el('ps-create-comp-course').checked);
    assert('Back exit: Private radio unchecked', !el('ps-create-comp-private-lesson').checked);
    assert('Back exit: exactly No lesson aria-pressed=true',
      activityButtons.none.getAttribute('aria-pressed') === 'true'
      && activityButtons.course.getAttribute('aria-pressed') === 'false'
      && activityButtons.priv.getAttribute('aria-pressed') === 'false');
    assert('Back exit: exactly No lesson has is-selected',
      activityButtons.none.classList.contains('is-selected')
      && !activityButtons.course.classList.contains('is-selected')
      && !activityButtons.priv.classList.contains('is-selected'));

    // Private path too via group exit alias
    el('ps-create-comp-private-lesson').checked = true;
    el('ps-create-comp-no-lesson').checked = false;
    activityButtons.priv.classList.add('is-selected');
    activityButtons.priv.setAttribute('aria-pressed', 'true');
    activityButtons.none.classList.remove('is-selected');
    activityButtons.none.setAttribute('aria-pressed', 'false');
    sandbox.schedulePortalExitGroupCourseDrilldown({ clearCourse: true, clearPrivate: true });
    assert('Group-exit alias: No lesson aria-pressed=true + is-selected',
      el('ps-create-comp-no-lesson').checked
      && activityButtons.none.getAttribute('aria-pressed') === 'true'
      && activityButtons.none.classList.contains('is-selected')
      && activityButtons.priv.getAttribute('aria-pressed') === 'false'
      && !activityButtons.priv.classList.contains('is-selected'));

    // Programmatic radio mutation without button click still syncs when sync helper used
    el('ps-create-comp-course').checked = true;
    el('ps-create-comp-no-lesson').checked = false;
    sandbox.scheduleSyncCreateMainActivityButtons();
    assert('programmatic sync: Group pressed exclusive',
      activityButtons.course.getAttribute('aria-pressed') === 'true'
      && activityButtons.course.classList.contains('is-selected')
      && activityButtons.none.getAttribute('aria-pressed') === 'false'
      && !activityButtons.none.classList.contains('is-selected'));
  }
}

// ── H) Behavioral: accessible calendar interaction ─────────────────────────
console.log('\n[H] Behavioral: calendar focus / Escape / Cancel / Apply / outside / keys');
{
  let rt;
  try {
    rt = buildPolishRuntime();
  } catch (e) {
    assert('calendar runtime boots', false, String(e && e.message || e));
    rt = null;
  }
  if (rt) {
    const { el, sandbox, getFocused, setFocused, outside, fireGridKey, fireGridClick, dayButtons } = rt;

    // Open: focus moves into calendar/dialog
    setFocused(el('ps-create-date-range-trigger'));
    sandbox.scheduleCreateDateRangeOpenPopover();
    assert('open: popover visible', sandbox.scheduleCreateDateRangeIsOpen());
    assert('open: aria-expanded true', el('ps-create-date-range-trigger').getAttribute('aria-expanded') === 'true');
    const focusedAfterOpen = getFocused();
    assert('open: focus moved into calendar (day cell or nav)',
      !!(focusedAfterOpen
        && focusedAfterOpen !== el('ps-create-date-range-trigger')
        && (focusedAfterOpen.getAttribute('data-date')
          || focusedAfterOpen.id === 'ps-create-date-range-prev'
          || focusedAfterOpen.id === 'ps-create-date-range-next')),
      focusedAfterOpen && (focusedAfterOpen.id || focusedAfterOpen.getAttribute('data-date')));
    assert('open: roving tabindex has exactly one tabbable day', (() => {
      const days = dayButtons();
      const zeros = days.filter((d) => String(d.getAttribute('tabindex')) === '0' || d.tabIndex === 0);
      return days.length > 0 && zeros.length === 1;
    })());

    // Draft seeded from canonical applied range (not empty)
    assert('open: draft seeded from applied from/to',
      sandbox.scheduleCreateDateRangeDraft.start === '2026-07-27'
      && sandbox.scheduleCreateDateRangeDraft.end === '2026-07-29');

    // Mutate draft then Escape: discard, restore trigger focus, no apply
    fireGridClick('2026-07-15');
    assert('click day starts/restarts draft',
      sandbox.scheduleCreateDateRangeDraft.start === '2026-07-15'
      && !sandbox.scheduleCreateDateRangeDraft.end);
    const fromBefore = el('ps-create-date-from').value;
    const toBefore = el('ps-create-date-to').value;
    sandbox.scheduleCreateDateRangeOnDocumentKeydown({
      key: 'Escape',
      preventDefault() { this.defaultPrevented = true; },
    });
    assert('Escape: popover closed', !sandbox.scheduleCreateDateRangeIsOpen());
    assert('Escape: trigger focus restored', getFocused() === el('ps-create-date-range-trigger'));
    assert('Escape: canonical from/to unchanged (no apply)',
      el('ps-create-date-from').value === fromBefore
      && el('ps-create-date-to').value === toBefore);

    // Cancel restores focus, no apply
    sandbox.scheduleCreateDateRangeOpenPopover();
    fireGridClick('2026-07-10');
    setFocused(el('ps-create-date-range-cancel'));
    el('ps-create-date-range-cancel').dispatchEvent({ type: 'click', preventDefault() {} });
    assert('Cancel: closed without applying',
      !sandbox.scheduleCreateDateRangeIsOpen()
      && el('ps-create-date-from').value === '2026-07-27'
      && el('ps-create-date-to').value === '2026-07-29');
    assert('Cancel: trigger focus restored', getFocused() === el('ps-create-date-range-trigger'));

    // One-day: first start click enables Apply; Apply commits from=to=start (production owner)
    sandbox.scheduleCreateDateRangeOpenPopover();
    fireGridClick('2026-07-18');
    assert('one-day draft: start only after first click',
      sandbox.scheduleCreateDateRangeDraft.start === '2026-07-18'
      && !sandbox.scheduleCreateDateRangeDraft.end);
    assert('Apply enabled after one valid start click (one-day)',
      el('ps-create-date-range-apply').disabled === false);
    const appliedOneDay = sandbox.scheduleApplyCreateDateRangeDraft();
    assert('Apply one-day returns true', appliedOneDay === true);
    assert('Apply one-day writes date_from=date_to=start',
      el('ps-create-date-from').value === '2026-07-18'
      && el('ps-create-date-to').value === '2026-07-18');
    assert('Apply one-day closes popover', !sandbox.scheduleCreateDateRangeIsOpen());
    assert('Apply one-day restores trigger focus', getFocused() === el('ps-create-date-range-trigger'));

    // Multi-day: second later click still expands range; Apply writes both
    sandbox.scheduleCreateDateRangeOpenPopover();
    fireGridClick('2026-07-20');
    fireGridClick('2026-07-22');
    assert('draft ready for multi-day apply',
      sandbox.scheduleCreateDateRangeDraft.start === '2026-07-20'
      && sandbox.scheduleCreateDateRangeDraft.end === '2026-07-22');
    assert('Apply enabled when multi-day range complete', el('ps-create-date-range-apply').disabled === false);
    const applied = sandbox.scheduleApplyCreateDateRangeDraft();
    assert('Apply returns true', applied === true);
    assert('Apply writes hidden from/to',
      el('ps-create-date-from').value === '2026-07-20'
      && el('ps-create-date-to').value === '2026-07-22');
    assert('Apply closes popover', !sandbox.scheduleCreateDateRangeIsOpen());
    assert('Apply restores trigger focus', getFocused() === el('ps-create-date-range-trigger'));

    // After start-only, second later click expands; earlier second restarts (range semantics preserved)
    sandbox.scheduleCreateDateRangeOpenPopover();
    fireGridClick('2026-07-12');
    assert('restart start-only before second click',
      sandbox.scheduleCreateDateRangeDraft.start === '2026-07-12'
      && !sandbox.scheduleCreateDateRangeDraft.end);
    fireGridClick('2026-07-14');
    assert('second later click expands end',
      sandbox.scheduleCreateDateRangeDraft.start === '2026-07-12'
      && sandbox.scheduleCreateDateRangeDraft.end === '2026-07-14');
    fireGridClick('2026-07-10');
    assert('click after complete range restarts as new start',
      sandbox.scheduleCreateDateRangeDraft.start === '2026-07-10'
      && !sandbox.scheduleCreateDateRangeDraft.end);
    fireGridClick('2026-07-08');
    assert('earlier second click restarts as new start (no end)',
      sandbox.scheduleCreateDateRangeDraft.start === '2026-07-08'
      && !sandbox.scheduleCreateDateRangeDraft.end);
    // leave open state closed for subsequent outside-click case
    sandbox.scheduleCreateDateRangeClosePopover({ restoreFocus: false, discard: true });

    // Outside click dismisses without applying pending draft
    sandbox.scheduleCreateDateRangeOpenPopover();
    fireGridClick('2026-08-01');
    const fromSnap = el('ps-create-date-from').value;
    const toSnap = el('ps-create-date-to').value;
    sandbox.scheduleCreateDateRangeOnDocumentPointer({ target: outside });
    assert('outside click: closed', !sandbox.scheduleCreateDateRangeIsOpen());
    assert('outside click: no apply (canonical unchanged)',
      el('ps-create-date-from').value === fromSnap
      && el('ps-create-date-to').value === toSnap);
    assert('outside click: trigger focus restored', getFocused() === el('ps-create-date-range-trigger'));

    // Roving arrow-key navigation + Enter select
    sandbox.scheduleCreateDateRangeOpenPopover();
    // Focus starts on seeded start 2026-07-20 (now applied)
    fireGridKey('2026-07-20', 'ArrowRight');
    assert('ArrowRight moves focus +1 day', sandbox.scheduleCreateDateRangeFocusIso === '2026-07-21');
    fireGridKey('2026-07-21', 'ArrowLeft');
    assert('ArrowLeft moves focus -1 day', sandbox.scheduleCreateDateRangeFocusIso === '2026-07-20');
    fireGridKey('2026-07-20', 'ArrowDown');
    assert('ArrowDown moves focus +7 days', sandbox.scheduleCreateDateRangeFocusIso === '2026-07-27');
    fireGridKey('2026-07-27', 'ArrowUp');
    assert('ArrowUp moves focus -7 days', sandbox.scheduleCreateDateRangeFocusIso === '2026-07-20');
    fireGridKey('2026-07-20', 'Home');
    assert('Home moves to week start (Sunday)', sandbox.scheduleCreateDateRangeFocusIso === '2026-07-19');
    fireGridKey('2026-07-19', 'End');
    assert('End moves to week end (Saturday)', sandbox.scheduleCreateDateRangeFocusIso === '2026-07-25');
    // Enter selects
    fireGridKey('2026-07-25', 'Enter');
    assert('Enter selects focused day as draft start/restart',
      sandbox.scheduleCreateDateRangeDraft.start === '2026-07-25');
    fireGridKey('2026-07-25', ' ');
    assert('Space selects same day end (same-day range)',
      sandbox.scheduleCreateDateRangeDraft.start === '2026-07-25'
      && sandbox.scheduleCreateDateRangeDraft.end === '2026-07-25');

    // Month navigation still works + year boundary
    sandbox.scheduleCreateDateRangeViewYm = '2026-01';
    sandbox.scheduleRenderCreateDateRangeCalendar();
    el('ps-create-date-range-prev').dispatchEvent({ type: 'click' });
    assert('prev month crosses year boundary to 2025-12',
      sandbox.scheduleCreateDateRangeViewYm === '2025-12');
    el('ps-create-date-range-next').dispatchEvent({ type: 'click' });
    assert('next month returns to 2026-01',
      sandbox.scheduleCreateDateRangeViewYm === '2026-01');

    // Arrow across month boundary updates viewYm
    sandbox.scheduleCreateDateRangeViewYm = '2026-07';
    sandbox.scheduleCreateDateRangeFocusIso = '2026-07-31';
    sandbox.scheduleRenderCreateDateRangeCalendar();
    fireGridKey('2026-07-31', 'ArrowRight');
    assert('ArrowRight from Jul 31 moves into August view',
      sandbox.scheduleCreateDateRangeFocusIso === '2026-08-01'
      && sandbox.scheduleCreateDateRangeViewYm === '2026-08');
  }
}

// ── I) Behavioral: no Clear; Cancel non-mutating; Apply needs start (one-day ok) ──
console.log('\n[I] Behavioral: no Clear action; Cancel non-mutating; Apply needs start');
{
  let rt;
  try {
    rt = buildPolishRuntime();
  } catch (e) {
    assert('cancel/apply runtime boots', false, String(e && e.message || e));
    rt = null;
  }
  if (rt) {
    const { el, sandbox, fireGridClick, nodes, dayButtons } = rt;
    assert('no Clear control in runtime fixtures', !nodes['ps-create-date-range-clear']);
    assert('no scheduleClearCreateDateRangeDraft helper',
      typeof sandbox.scheduleClearCreateDateRangeDraft !== 'function');
    assert('seed helper never returns empty start/end', (() => {
      const seed = sandbox.scheduleCreateDateRangeSeedDraft();
      return !!(seed.start && seed.end);
    })());

    // Cancel remains non-mutating for canonical
    el('ps-create-date-from').value = '2026-07-27';
    el('ps-create-date-to').value = '2026-07-29';
    sandbox.scheduleCreateDateRangeOpenPopover();
    fireGridClick('2026-07-01');
    assert('draft mutated before Cancel',
      sandbox.scheduleCreateDateRangeDraft.start === '2026-07-01'
      && !sandbox.scheduleCreateDateRangeDraft.end);
    el('ps-create-date-range-cancel').dispatchEvent({ type: 'click', preventDefault() {} });
    assert('Cancel/discard: canonical unchanged',
      el('ps-create-date-from').value === '2026-07-27'
      && el('ps-create-date-to').value === '2026-07-29');
    assert('Cancel closes popover without Apply',
      !sandbox.scheduleCreateDateRangeIsOpen());

    // Apply blocked only when no start at all (start-only is a valid one-day range)
    sandbox.scheduleCreateDateRangeDraft = { start: null, end: null };
    sandbox.scheduleSyncCreateDateRangeUi();
    assert('Apply disabled with empty draft', el('ps-create-date-range-apply').disabled === true);
    const blocked = sandbox.scheduleApplyCreateDateRangeDraft();
    assert('Apply blocked without start', blocked === false);
    assert('Apply blocked leaves canonical intact',
      el('ps-create-date-from').value === '2026-07-27'
      && el('ps-create-date-to').value === '2026-07-29');

    sandbox.scheduleCreateDateRangeDraft = { start: '2026-02-30', end: null };
    sandbox.scheduleSyncCreateDateRangeUi();
    assert('Apply disabled for impossible start date',
      el('ps-create-date-range-apply').disabled === true);
    assert('Apply rejects impossible start date without mutating canonical',
      sandbox.scheduleApplyCreateDateRangeDraft() === false
      && el('ps-create-date-from').value === '2026-07-27'
      && el('ps-create-date-to').value === '2026-07-29');

    sandbox.scheduleCreateDateRangeDraft = { start: '2026-07-10', end: '2026-99-99' };
    sandbox.scheduleSyncCreateDateRangeUi();
    assert('Apply disabled for impossible supplied end date',
      el('ps-create-date-range-apply').disabled === true);
    assert('Apply rejects impossible supplied end instead of silently using start',
      sandbox.scheduleApplyCreateDateRangeDraft() === false
      && el('ps-create-date-from').value === '2026-07-27'
      && el('ps-create-date-to').value === '2026-07-29');

    // Production owner: start-only draft enables Apply and commits same-day from/to
    sandbox.scheduleCreateDateRangeDraft = { start: '2026-07-10', end: null };
    sandbox.scheduleSyncCreateDateRangeUi();
    assert('Apply enabled for start-only draft (one-day)',
      el('ps-create-date-range-apply').disabled === false);
    const oneDayOk = sandbox.scheduleApplyCreateDateRangeDraft();
    assert('Apply start-only commits one-day from/to',
      oneDayOk === true
      && el('ps-create-date-from').value === '2026-07-10'
      && el('ps-create-date-to').value === '2026-07-10');

    // Selected day buttons expose truthful aria-pressed (no gridcell role)
    sandbox.scheduleCreateDateRangeDraft = { start: '2026-07-27', end: '2026-07-29' };
    sandbox.scheduleCreateDateRangeViewYm = '2026-07';
    sandbox.scheduleRenderCreateDateRangeCalendar();
    const days = dayButtons();
    assert('rendered day buttons have no role=gridcell',
      days.length > 0 && days.every((d) => d.getAttribute('role') !== 'gridcell'));
    assert('day buttons keep accessible date labels',
      days.every((d) => !!d.getAttribute('aria-label')));
    const startBtn = days.find((d) => d.getAttribute('data-date') === '2026-07-27');
    const endBtn = days.find((d) => d.getAttribute('data-date') === '2026-07-29');
    const midBtn = days.find((d) => d.getAttribute('data-date') === '2026-07-28');
    const otherBtn = days.find((d) => d.getAttribute('data-date') === '2026-07-15');
    assert('selected start has aria-pressed=true',
      startBtn && startBtn.getAttribute('aria-pressed') === 'true');
    assert('selected end has aria-pressed=true',
      endBtn && endBtn.getAttribute('aria-pressed') === 'true');
    assert('in-range middle is not pressed endpoint (false)',
      midBtn && midBtn.getAttribute('aria-pressed') === 'false');
    assert('unselected day has aria-pressed=false',
      otherBtn && otherBtn.getAttribute('aria-pressed') === 'false');
    assert('calendar host is group not grid',
      el('ps-create-date-range-grid').getAttribute('role') !== 'grid'
      && (el('ps-create-date-range-grid').getAttribute('role') === 'group'
        || el('ps-create-date-range-grid').role === 'group'));
  }
}

// ── J) Computed/layout contract at 390px ───────────────────────────────────
console.log('\n[J] Header layout contract at 390px (no wrap / no overflow)');
{
  const fn = extractFn(apiSrc, 'scheduleCreateHeaderRowContract');
  assert('scheduleCreateHeaderRowContract present', !!fn);
  if (fn) {
    const sandbox = { result: null };
    vm.runInNewContext(fn + '; result = scheduleCreateHeaderRowContract;', sandbox);
    const c390 = sandbox.result({ width: 390 });
    assert('390px contract: single-row nowrap', c390.singleRow === true && c390.noWrap === true);
    assert('390px contract: close ≥44 preserved', c390.closePreserved === true);
    assert('390px contract: fits without overflow (min-width:0 share)',
      c390.fitsWithoutOverflow === true && c390.titleChipShare >= 0);
    assert('390px contract: min-width zero truncation path', c390.minWidthZero === true);
    const c320 = sandbox.result({ width: 320 });
    assert('320px still fits via truncation (no forced wrap)',
      c320.fitsWithoutOverflow === true && c320.singleRow === true);
  }
}

console.log('\n────────────────────────────────────────');
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('verify:sunset-create-drawer-polish OK\n');
