/**
 * Staff Portal Inbox — column layout model and presets.
 *
 * Canonical rules: docs/INBOX-PORTAL-REDESIGN.md, "Column layout model". Columns are
 * 1 views rail, 2 list, 3 chat, 4 guest card. Only column 3 is elastic: 1, 2 and 4 snap
 * between fixed widths and 3 absorbs the remainder, so every combination of collapses is
 * a valid layout with no width arithmetic anywhere.
 *
 * This module owns the state, not the geometry. It flips data-col1 / data-col2 / data-col4
 * (and data-peek) on the shell container; the grid template in /staff/ui reads the matching
 * custom properties. Nothing here measures an element, reads a computed style or writes a
 * pixel value — scripts/verify-inbox-columns.js asserts that.
 *
 * Injected into /staff/ui at the inbox-columns marker. The fragment is spliced into the
 * portal IIFE but depends on no portal sibling, so the gate can execute it standalone.
 *
 * Keyboard: Alt (never Ctrl — Chrome owns Ctrl+1..4 for tab switching).
 *   Alt+0 / Alt+3 / Alt+4   presets: all four, chat, guest
 *   Alt+1 / Alt+2           collapse or restore column 1 / column 2
 *   Alt+Shift+4             collapse or restore column 4 (Alt+4 is the guest preset)
 *   Escape                  dismiss a peek, then exit any zoom back to all four
 * Peek-on-demand: hovering the edge strip of a collapsed column, or focusing its top-bar
 * toggle, slides that column in as an overlay above column 3 without changing the layout.
 */

/* ── inbox-columns model: begin ─────────────────────────────────────────────── */

var INBOX_COLUMNS_SHELL_ID = 'inbox-shell';
var INBOX_COLUMNS_COLS = ['col1', 'col2', 'col4'];

/** Every state a snapping column can hold, and the width the grid gives it. */
var INBOX_COLUMNS_WIDTHS = {
  col1: { full: '240px', icons: '56px' },
  col2: { comfortable: '252px', compact: '196px', hidden: '0px' },
  col4: { wide: '460px', peek: '300px', hidden: '0px' },
};

/** Column 3 is flexible; this is the floor it keeps while the others snap. */
var INBOX_COLUMNS_COL3_MIN = '480px';

var INBOX_COLUMNS_PRESETS = {
  all4: { col1: 'full', col2: 'comfortable', col4: 'peek' },
  chat: { col1: 'full', col2: 'comfortable', col4: 'hidden' },
  guest: { col1: 'full', col2: 'comfortable', col4: 'wide' },
};

var INBOX_COLUMNS_PRESET_ORDER = ['all4', 'chat', 'guest'];
var INBOX_COLUMNS_DEFAULT_PRESET = 'all4';

/** Column 1 is never hidden: icons is as small as navigation is allowed to get. */
var INBOX_COLUMNS_COLLAPSED = { col1: 'icons', col2: 'hidden', col4: 'hidden' };
var INBOX_COLUMNS_EXPANDED = { col1: 'full', col2: 'comfortable', col4: 'peek' };

/**
 * Viewport buckets drive the same attributes rather than a parallel set of CSS rules.
 * Ordered widest first; a bucket claims every viewport at or above its minWidth.
 */
var INBOX_COLUMNS_BUCKETS = [
  { name: 'lg', minWidth: 1280, clamp: {} },
  { name: 'md', minWidth: 900, clamp: { col4: 'hidden' } },
  { name: 'sm', minWidth: 0, clamp: { col2: 'hidden', col4: 'hidden' } },
];

var INBOX_COLUMNS_STORAGE_PREFIX = 'wh_staff_inbox_columns_v1';
var INBOX_COLUMNS_CLIENT_STORAGE_KEY = 'staff_portal_client';

/** Where a peeked column lives, so a pointer inside it does not dismiss it. */
var INBOX_COLUMNS_PEEK_HOSTS = {
  col1: '#inbox-col1',
  col2: '#inbox-card',
  col4: '#inbox-detail-sidebar',
};

var inboxColumnsRuntime = { bucket: null, record: null, peek: null, wired: false };

function inboxColumnsBucketForWidth(width) {
  var w = Number(width);
  if (!isFinite(w) || w < 0) w = 0;
  for (var i = 0; i < INBOX_COLUMNS_BUCKETS.length; i += 1) {
    if (w >= INBOX_COLUMNS_BUCKETS[i].minWidth) return INBOX_COLUMNS_BUCKETS[i].name;
  }
  return INBOX_COLUMNS_BUCKETS[INBOX_COLUMNS_BUCKETS.length - 1].name;
}

function inboxColumnsBucketDef(name) {
  for (var i = 0; i < INBOX_COLUMNS_BUCKETS.length; i += 1) {
    if (INBOX_COLUMNS_BUCKETS[i].name === name) return INBOX_COLUMNS_BUCKETS[i];
  }
  return INBOX_COLUMNS_BUCKETS[INBOX_COLUMNS_BUCKETS.length - 1];
}

/** Bucket of the live viewport, asked as a media query so no pixel is read. */
function inboxColumnsCurrentBucket() {
  if (typeof window === 'undefined') return inboxColumnsBucketForWidth(0);
  if (typeof window.matchMedia === 'function') {
    for (var i = 0; i < INBOX_COLUMNS_BUCKETS.length; i += 1) {
      var bucket = INBOX_COLUMNS_BUCKETS[i];
      if (!bucket.minWidth) return bucket.name;
      var mq = window.matchMedia('(min-width:' + bucket.minWidth + 'px)');
      if (mq && mq.matches) return bucket.name;
    }
  }
  return inboxColumnsBucketForWidth(window.innerWidth);
}

function inboxColumnsEmptyRecord(preset) {
  return {
    preset: INBOX_COLUMNS_PRESETS[preset] ? preset : INBOX_COLUMNS_DEFAULT_PRESET,
    overrides: {},
    restore: {},
  };
}

function inboxColumnsPickStates(raw) {
  var out = {};
  if (!raw || typeof raw !== 'object') return out;
  INBOX_COLUMNS_COLS.forEach(function (col) {
    var value = raw[col];
    if (value && INBOX_COLUMNS_WIDTHS[col][value]) out[col] = value;
  });
  return out;
}

function inboxColumnsNormalizeRecord(raw) {
  var record = inboxColumnsEmptyRecord(raw && raw.preset);
  if (raw) {
    record.overrides = inboxColumnsPickStates(raw.overrides);
    record.restore = inboxColumnsPickStates(raw.restore);
  }
  return record;
}

/** localStorage is per browser profile, which is what "per user" means client-side here. */
function inboxColumnsScope() {
  try {
    return localStorage.getItem(INBOX_COLUMNS_CLIENT_STORAGE_KEY) || 'default';
  } catch (_e) { return 'default'; }
}

function inboxColumnsStorageKey(bucket) {
  return INBOX_COLUMNS_STORAGE_PREFIX + ':' + inboxColumnsScope() + ':' + bucket;
}

function inboxColumnsReadRecord(bucket) {
  try {
    return inboxColumnsNormalizeRecord(JSON.parse(localStorage.getItem(inboxColumnsStorageKey(bucket))));
  } catch (_e) { return inboxColumnsEmptyRecord(); }
}

function inboxColumnsWriteRecord(bucket, record) {
  try {
    localStorage.setItem(inboxColumnsStorageKey(bucket), JSON.stringify({
      preset: record.preset,
      overrides: record.overrides,
      restore: record.restore,
    }));
  } catch (_e) { /* private mode: layout still works, it just does not persist */ }
}

/**
 * Preset, clamped by the bucket, with manual overrides on top — a manual choice wins
 * over the bucket until the viewport crosses a boundary and the overrides are dropped.
 *
 * At md (~900–1279), forcing column 4 open beside full rail + comfortable list crushes
 * both list names and guest-card fields (~1024px Bug Finder). Unless the operator already
 * overrode col1/col2, snap those to icons + compact so peek/wide still fits.
 */
function inboxColumnsResolve(bucket, record) {
  var preset = INBOX_COLUMNS_PRESETS[record && record.preset] || INBOX_COLUMNS_PRESETS[INBOX_COLUMNS_DEFAULT_PRESET];
  var clamp = inboxColumnsBucketDef(bucket).clamp;
  var overrides = (record && record.overrides) || {};
  var state = {};
  INBOX_COLUMNS_COLS.forEach(function (col) {
    var value = preset[col];
    // Guest *is* the customer card. Do not auto-collapse col4 or the Guest
    // preset paints an empty cream pane (md 900–1279 used to clamp hidden).
    if (clamp[col] && !(record && record.preset === 'guest' && col === 'col4')) value = clamp[col];
    if (overrides[col]) value = overrides[col];
    state[col] = value;
  });
  if (bucket === 'md' && state.col4 && state.col4 !== 'hidden') {
    if (!overrides.col1) state.col1 = 'icons';
    if (!overrides.col2) state.col2 = 'compact';
  }
  return state;
}

function inboxColumnsState() {
  if (!inboxColumnsRuntime.record) inboxColumnsRuntime.record = inboxColumnsEmptyRecord();
  if (!inboxColumnsRuntime.bucket) inboxColumnsRuntime.bucket = inboxColumnsCurrentBucket();
  return inboxColumnsResolve(inboxColumnsRuntime.bucket, inboxColumnsRuntime.record);
}

function inboxColumnsShellEl() {
  if (typeof document === 'undefined') return null;
  return document.getElementById(INBOX_COLUMNS_SHELL_ID);
}

function inboxColumnsReflectControls(state) {
  if (typeof document === 'undefined') return;
  var presetBtns = document.querySelectorAll('[data-inbox-preset]');
  for (var i = 0; i < presetBtns.length; i += 1) {
    var isCurrent = presetBtns[i].getAttribute('data-inbox-preset') === inboxColumnsRuntime.record.preset;
    presetBtns[i].setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
    presetBtns[i].classList.toggle('is-active', isCurrent);
  }
  var toggles = document.querySelectorAll('[data-inbox-col-toggle]');
  for (var j = 0; j < toggles.length; j += 1) {
    var col = toggles[j].getAttribute('data-inbox-col-toggle');
    var collapsed = !!(state[col] && state[col] === INBOX_COLUMNS_COLLAPSED[col]);
    toggles[j].setAttribute('aria-pressed', collapsed ? 'true' : 'false');
    toggles[j].classList.toggle('is-collapsed', collapsed);
  }
}

/** The only DOM write the layout needs: three column attributes and the peek flag. */
function inboxColumnsApply() {
  var shell = inboxColumnsShellEl();
  var state = inboxColumnsState();
  if (!shell) return state;
  INBOX_COLUMNS_COLS.forEach(function (col) {
    shell.setAttribute('data-' + col, state[col]);
  });
  if (inboxColumnsRuntime.peek) shell.setAttribute('data-peek', inboxColumnsRuntime.peek);
  else shell.removeAttribute('data-peek');
  inboxColumnsReflectControls(state);
  return state;
}

function inboxColumnsPersist() {
  inboxColumnsWriteRecord(inboxColumnsRuntime.bucket, inboxColumnsRuntime.record);
}

function inboxColumnsSetPreset(name) {
  if (!INBOX_COLUMNS_PRESETS[name]) return inboxColumnsState();
  inboxColumnsRuntime.record = inboxColumnsEmptyRecord(name);
  inboxColumnsRuntime.peek = null;
  inboxColumnsPersist();
  return inboxColumnsApply();
}

function inboxColumnsSetColumn(col, value) {
  if (!INBOX_COLUMNS_WIDTHS[col] || !INBOX_COLUMNS_WIDTHS[col][value]) return inboxColumnsState();
  inboxColumnsState();
  inboxColumnsRuntime.record.overrides[col] = value;
  inboxColumnsPersist();
  return inboxColumnsApply();
}

/** Collapse a column, or put back the width it had before it was collapsed. */
function inboxColumnsToggleColumn(col) {
  if (!INBOX_COLUMNS_COLLAPSED[col]) return inboxColumnsState();
  var state = inboxColumnsState();
  var record = inboxColumnsRuntime.record;
  if (state[col] === INBOX_COLUMNS_COLLAPSED[col]) {
    var back = record.restore[col] || INBOX_COLUMNS_PRESETS[record.preset][col];
    if (back === INBOX_COLUMNS_COLLAPSED[col]) back = INBOX_COLUMNS_EXPANDED[col];
    delete record.restore[col];
    record.overrides[col] = back;
  } else {
    record.restore[col] = state[col];
    record.overrides[col] = INBOX_COLUMNS_COLLAPSED[col];
  }
  inboxColumnsRuntime.peek = null;
  inboxColumnsPersist();
  return inboxColumnsApply();
}

function inboxColumnsPeekable(col) {
  if (!INBOX_COLUMNS_COLLAPSED[col]) return false;
  return inboxColumnsState()[col] === INBOX_COLUMNS_COLLAPSED[col];
}

function inboxColumnsPeek(col) {
  if (!inboxColumnsPeekable(col) || inboxColumnsRuntime.peek === col) return inboxColumnsState();
  inboxColumnsRuntime.peek = col;
  return inboxColumnsApply();
}

function inboxColumnsClearPeek() {
  if (!inboxColumnsRuntime.peek) return inboxColumnsState();
  inboxColumnsRuntime.peek = null;
  return inboxColumnsApply();
}

function inboxColumnsZoomed() {
  var record = inboxColumnsRuntime.record || inboxColumnsEmptyRecord();
  if (record.preset !== INBOX_COLUMNS_DEFAULT_PRESET) return true;
  return INBOX_COLUMNS_COLS.some(function (col) { return !!record.overrides[col]; });
}

function inboxColumnsExitZoom() {
  if (inboxColumnsRuntime.peek) return inboxColumnsClearPeek();
  if (!inboxColumnsZoomed()) return inboxColumnsState();
  return inboxColumnsSetPreset(INBOX_COLUMNS_DEFAULT_PRESET);
}

/**
 * Re-derive on a bucket crossing: the new bucket keeps its own persisted preset and
 * starts without overrides, so the clamps apply again.
 */
function inboxColumnsSyncViewport() {
  var bucket = inboxColumnsCurrentBucket();
  if (bucket === inboxColumnsRuntime.bucket) return false;
  inboxColumnsRuntime.bucket = bucket;
  inboxColumnsRuntime.record = inboxColumnsEmptyRecord(inboxColumnsReadRecord(bucket).preset);
  inboxColumnsRuntime.peek = null;
  inboxColumnsPersist();
  inboxColumnsApply();
  return true;
}

function inboxColumnsInboxTabActive() {
  if (typeof document === 'undefined') return false;
  var panel = document.getElementById('tab-conversations');
  return !!(panel && panel.classList && panel.classList.contains('active'));
}

function inboxColumnsTargetIsTyping(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  var tag = String(target.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

/** Escape is shared with drawers and menus; leave it to them when one is open. */
function inboxColumnsOverlayOpen() {
  if (typeof document === 'undefined') return false;
  return !!document.querySelector(
    '.customers-outreach-drawer.open, .portal-schedule-drawer.open, .cust-outreach-confirm-modal.open, #nav-menu.open',
  );
}

function inboxColumnsShortcutFor(ev) {
  var code = String(ev.code || '');
  var digit = code.indexOf('Digit') === 0 ? code.slice(5) : String(ev.key || '');
  if (ev.shiftKey) return digit === '4' ? { kind: 'toggle', col: 'col4' } : null;
  if (digit === '0') return { kind: 'preset', preset: 'all4' };
  if (digit === '1') return { kind: 'toggle', col: 'col1' };
  if (digit === '2') return { kind: 'toggle', col: 'col2' };
  if (digit === '3') return { kind: 'preset', preset: 'chat' };
  if (digit === '4') return { kind: 'preset', preset: 'guest' };
  return null;
}

function inboxColumnsHandleKeydown(ev) {
  if (!ev || ev.ctrlKey || ev.metaKey) return;
  if (!inboxColumnsInboxTabActive()) return;
  if (inboxColumnsTargetIsTyping(ev.target)) return;
  if (ev.key === 'Escape' || ev.key === 'Esc') {
    if (inboxColumnsOverlayOpen()) return;
    if (!inboxColumnsRuntime.peek && !inboxColumnsZoomed()) return;
    inboxColumnsExitZoom();
    return;
  }
  if (!ev.altKey) return;
  var action = inboxColumnsShortcutFor(ev);
  if (!action) return;
  if (action.kind === 'preset') inboxColumnsSetPreset(action.preset);
  else inboxColumnsToggleColumn(action.col);
  if (typeof ev.preventDefault === 'function') ev.preventDefault();
}

function inboxColumnsClosest(node, selector) {
  if (!node || typeof node.closest !== 'function') return null;
  return node.closest(selector);
}

function inboxColumnsHandleControlClick(ev) {
  var preset = inboxColumnsClosest(ev.target, '[data-inbox-preset]');
  if (preset) {
    inboxColumnsSetPreset(preset.getAttribute('data-inbox-preset'));
    return;
  }
  var toggle = inboxColumnsClosest(ev.target, '[data-inbox-col-toggle]');
  if (toggle) {
    inboxColumnsToggleColumn(toggle.getAttribute('data-inbox-col-toggle'));
    return;
  }
  /* A peeked column slides away as soon as it has been used. */
  if (inboxColumnsRuntime.peek && inboxColumnsClosest(ev.target, INBOX_COLUMNS_PEEK_HOSTS[inboxColumnsRuntime.peek])) {
    inboxColumnsClearPeek();
  }
}

function inboxColumnsPeekTargetFor(node) {
  var edge = inboxColumnsClosest(node, '[data-inbox-peek-edge]');
  if (edge) return edge.getAttribute('data-inbox-peek-edge');
  var toggle = inboxColumnsClosest(node, '[data-inbox-col-toggle]');
  if (toggle) return toggle.getAttribute('data-inbox-col-toggle');
  return null;
}

function inboxColumnsHandlePointerOver(ev) {
  var wanted = inboxColumnsPeekTargetFor(ev.target);
  if (wanted) {
    inboxColumnsPeek(wanted);
    return;
  }
  if (!inboxColumnsRuntime.peek) return;
  if (inboxColumnsClosest(ev.target, INBOX_COLUMNS_PEEK_HOSTS[inboxColumnsRuntime.peek])) return;
  inboxColumnsClearPeek();
}

function inboxColumnsHandleFocusIn(ev) {
  var wanted = inboxColumnsPeekTargetFor(ev.target);
  if (wanted) {
    inboxColumnsPeek(wanted);
    return;
  }
  if (!inboxColumnsRuntime.peek) return;
  if (inboxColumnsClosest(ev.target, INBOX_COLUMNS_PEEK_HOSTS[inboxColumnsRuntime.peek])) return;
  inboxColumnsClearPeek();
}

function inboxColumnsWatchViewport() {
  if (typeof window === 'undefined') return;
  if (typeof window.matchMedia === 'function') {
    INBOX_COLUMNS_BUCKETS.forEach(function (bucket) {
      if (!bucket.minWidth) return;
      var mq = window.matchMedia('(min-width:' + bucket.minWidth + 'px)');
      if (!mq) return;
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', inboxColumnsSyncViewport);
      else if (typeof mq.addListener === 'function') mq.addListener(inboxColumnsSyncViewport);
    });
    return;
  }
  window.addEventListener('resize', inboxColumnsSyncViewport);
}

function initInboxColumns() {
  var shell = inboxColumnsShellEl();
  if (!shell || inboxColumnsRuntime.wired) return inboxColumnsRuntime.wired;
  inboxColumnsRuntime.wired = true;
  inboxColumnsRuntime.bucket = inboxColumnsCurrentBucket();
  inboxColumnsRuntime.record = inboxColumnsReadRecord(inboxColumnsRuntime.bucket);
  inboxColumnsRuntime.peek = null;
  inboxColumnsApply();
  document.addEventListener('click', inboxColumnsHandleControlClick);
  document.addEventListener('keydown', inboxColumnsHandleKeydown);
  document.addEventListener('focusin', inboxColumnsHandleFocusIn);
  shell.addEventListener('mouseover', inboxColumnsHandlePointerOver);
  shell.addEventListener('mouseleave', inboxColumnsClearPeek);
  inboxColumnsWatchViewport();
  return true;
}

if (typeof window !== 'undefined') {
  window.__inboxColumns = {
    SHELL_ID: INBOX_COLUMNS_SHELL_ID,
    COLS: INBOX_COLUMNS_COLS,
    WIDTHS: INBOX_COLUMNS_WIDTHS,
    COL3_MIN: INBOX_COLUMNS_COL3_MIN,
    PRESETS: INBOX_COLUMNS_PRESETS,
    PRESET_ORDER: INBOX_COLUMNS_PRESET_ORDER,
    DEFAULT_PRESET: INBOX_COLUMNS_DEFAULT_PRESET,
    COLLAPSED: INBOX_COLUMNS_COLLAPSED,
    EXPANDED: INBOX_COLUMNS_EXPANDED,
    BUCKETS: INBOX_COLUMNS_BUCKETS,
    STORAGE_PREFIX: INBOX_COLUMNS_STORAGE_PREFIX,
    runtime: inboxColumnsRuntime,
    bucketForWidth: inboxColumnsBucketForWidth,
    currentBucket: inboxColumnsCurrentBucket,
    storageKey: inboxColumnsStorageKey,
    readRecord: inboxColumnsReadRecord,
    resolve: inboxColumnsResolve,
    state: inboxColumnsState,
    apply: inboxColumnsApply,
    setPreset: inboxColumnsSetPreset,
    setColumn: inboxColumnsSetColumn,
    toggle: inboxColumnsToggleColumn,
    peek: inboxColumnsPeek,
    clearPeek: inboxColumnsClearPeek,
    zoomed: inboxColumnsZoomed,
    exitZoom: inboxColumnsExitZoom,
    syncViewport: inboxColumnsSyncViewport,
    init: initInboxColumns,
  };
}

/* ── inbox-columns model: end ──────────────────────────────────────────────── */
