'use strict';

var scheduleDrawerSaveInFlight = false;
var scheduleDrawerPriceStale = false;
var scheduleDrawerValidationState = { ok: true, errorKey: null };
var scheduleDrawerCustomLines = [];
var scheduleDrawerCustomLineSeq = 0;
var scheduleDrawerCustomLineEditorOpen = false;
var scheduleDrawerAccommodation = null; // { enabled, check_in, check_out } | null
// Edit-local quote preview state (do not share Create's schedulePortalQuote* globals).
var scheduleDrawerQuoteState = null;
var scheduleDrawerQuoteGen = 0;
var scheduleDrawerQuoteAbort = null;
var scheduleDrawerQuoteTimer = null;
var scheduleDrawerQuoteDebounceMs = 400;
// Edit date-range draft state (Create pure helpers are shared; state is Edit-local).
var scheduleDrawerDateRangeDraft = { start: null, end: null };
var scheduleDrawerDateRangeViewYm = null;
var scheduleDrawerDateRangeFocusIso = null;
var scheduleDrawerDateRangeRestoreFocus = false;
var scheduleDrawerDateRangeDocWired = false;
// Main activity drill-down view: root | group-courses | private-sessions
var scheduleDrawerMainActivityView = 'root';

function scheduleDrawerMainActivityValue(){
  if(el('ps-drawer-comp-course')&&el('ps-drawer-comp-course').checked) return 'group';
  if(el('ps-drawer-comp-private-lesson')&&el('ps-drawer-comp-private-lesson').checked) return 'private';
  return 'none';
}
function scheduleDrawerSetMainActivity(mode){
  var m=String(mode||'none');
  if(el('ps-drawer-comp-course')) el('ps-drawer-comp-course').checked=m==='group';
  if(el('ps-drawer-comp-private-lesson')) el('ps-drawer-comp-private-lesson').checked=m==='private';
  if(el('ps-drawer-comp-no-lesson')) el('ps-drawer-comp-no-lesson').checked=m==='none'||(m!=='group'&&m!=='private');
  if (typeof scheduleSyncDrawerMainActivityButtons === 'function') scheduleSyncDrawerMainActivityButtons();
}

function scheduleDrawerSetVisible(node, show) {
  if (!node) return;
  if (typeof schedulePortalSetVisible === 'function') {
    schedulePortalSetVisible(node, show);
    return;
  }
  if (show) {
    node.style.display = '';
    node.hidden = false;
    try { node.removeAttribute('hidden'); } catch (_h) { /* ignore */ }
    try { node.setAttribute('aria-hidden', 'false'); } catch (_a) { /* ignore */ }
  } else {
    node.style.display = 'none';
    node.hidden = true;
    try { node.setAttribute('hidden', ''); } catch (_h2) { /* ignore */ }
    try { node.setAttribute('aria-hidden', 'true'); } catch (_a2) { /* ignore */ }
  }
}

/* ── Compact date-range (Create parity; Edit IDs + local draft state) ───── */

function scheduleDrawerDateRangeSeedDraft(){
  var from = el('ps-drawer-date-from') ? String(el('ps-drawer-date-from').value || '').slice(0, 10) : '';
  var to = el('ps-drawer-date-to') ? String(el('ps-drawer-date-to').value || '').slice(0, 10) : '';
  var valid = typeof scheduleCreateDateRangeIsValidIso === 'function'
    ? scheduleCreateDateRangeIsValidIso
    : function(iso){ return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(iso || '').slice(0, 10)); };
  if (valid(from)) {
    if (!valid(to)) to = from;
    return { start: from, end: to };
  }
  var today = typeof scheduleTodayIso === 'function' ? scheduleTodayIso() : '';
  return { start: today, end: today };
}

function scheduleDrawerDateRangeIsOpen(){
  var pop = el('ps-drawer-date-range-popover');
  return !!(pop && !pop.hidden && pop.style && pop.style.display !== 'none');
}

function scheduleSyncDrawerDateRangeUi(){
  var display = el('ps-drawer-date-range-display');
  var from = el('ps-drawer-date-from') ? el('ps-drawer-date-from').value : '';
  var to = el('ps-drawer-date-to') ? el('ps-drawer-date-to').value : from;
  var textFn = typeof scheduleCreateDateRangeDisplayText === 'function'
    ? scheduleCreateDateRangeDisplayText
    : function(a, b){ return a === b || !b ? String(a || '') : (a + ' – ' + b); };
  if (display) display.textContent = textFn(from, to || from);
  var apply = el('ps-drawer-date-range-apply');
  if (apply) {
    var draft = scheduleDrawerDateRangeDraft || {};
    var valid = typeof scheduleCreateDateRangeIsValidIso === 'function'
      ? scheduleCreateDateRangeIsValidIso
      : function(iso){ return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(iso || '').slice(0, 10)); };
    var ready = !!(valid(draft.start) && (!draft.end || valid(draft.end)));
    apply.disabled = !ready;
  }
}

function scheduleDrawerDateRangeClosePopover(opts){
  opts = opts || {};
  var pop = el('ps-drawer-date-range-popover');
  var trigger = el('ps-drawer-date-range-trigger');
  if (pop) {
    pop.hidden = true;
    if (pop.style) pop.style.display = 'none';
  }
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  if (opts.discard !== false && opts.applied !== true) {
    scheduleDrawerDateRangeDraft = scheduleDrawerDateRangeSeedDraft();
  }
  var shouldRestore = opts.restoreFocus !== false && scheduleDrawerDateRangeRestoreFocus;
  scheduleDrawerDateRangeRestoreFocus = false;
  if (shouldRestore && trigger && typeof trigger.focus === 'function') {
    try { trigger.focus(); } catch (_f) { /* ignore */ }
  }
}

function scheduleDrawerDateRangeFocusInto(){
  var grid = el('ps-drawer-date-range-grid');
  var focusIso = scheduleDrawerDateRangeFocusIso
    || (scheduleDrawerDateRangeDraft && scheduleDrawerDateRangeDraft.start)
    || null;
  var btn = null;
  if (grid && focusIso && typeof grid.querySelector === 'function') {
    try { btn = grid.querySelector('[data-date="' + focusIso + '"]'); } catch (_q) { btn = null; }
  }
  if (!btn && grid && typeof grid.querySelector === 'function') {
    btn = grid.querySelector('.portal-schedule-create-date-range-day:not(.is-outside)')
      || grid.querySelector('[data-date]');
  }
  if (btn && typeof btn.focus === 'function') {
    try { btn.focus(); } catch (_f) { /* ignore */ }
    return;
  }
  var pop = el('ps-drawer-date-range-popover');
  var first = pop && typeof pop.querySelector === 'function'
    ? (pop.querySelector('#ps-drawer-date-range-prev') || pop.querySelector('button'))
    : null;
  if (first && typeof first.focus === 'function') {
    try { first.focus(); } catch (_f2) { /* ignore */ }
  }
}

function scheduleDrawerDateRangeOpenPopover(){
  scheduleDrawerDateRangeDraft = scheduleDrawerDateRangeSeedDraft();
  scheduleDrawerDateRangeFocusIso = scheduleDrawerDateRangeDraft.start
    || (typeof scheduleTodayIso === 'function' ? scheduleTodayIso() : null);
  var seed = (scheduleDrawerDateRangeFocusIso
    || (typeof scheduleTodayIso === 'function' ? scheduleTodayIso() : '')
    || '').slice(0, 7);
  scheduleDrawerDateRangeViewYm = seed
    || (typeof scheduleTodayIso === 'function' ? scheduleTodayIso().slice(0, 7) : '');
  var pop = el('ps-drawer-date-range-popover');
  var trigger = el('ps-drawer-date-range-trigger');
  if (pop) {
    pop.hidden = false;
    if (pop.style) pop.style.display = '';
  }
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
  scheduleDrawerDateRangeRestoreFocus = true;
  scheduleRenderDrawerDateRangeCalendar();
  scheduleSyncDrawerDateRangeUi();
  scheduleDrawerDateRangeFocusInto();
}

function scheduleDrawerDateRangeTogglePopover(){
  if (scheduleDrawerDateRangeIsOpen()) scheduleDrawerDateRangeClosePopover({ restoreFocus: true, discard: true });
  else scheduleDrawerDateRangeOpenPopover();
}

function scheduleDrawerDateRangeMoveFocus(iso, key){
  if (typeof scheduleCreateDateRangeMoveFocus === 'function') {
    return scheduleCreateDateRangeMoveFocus(iso, key);
  }
  if (typeof scheduleCreateDateRangeAddDays !== 'function') return null;
  iso = String(iso || '').slice(0, 10);
  if (key === 'ArrowLeft') return scheduleCreateDateRangeAddDays(iso, -1);
  if (key === 'ArrowRight') return scheduleCreateDateRangeAddDays(iso, 1);
  if (key === 'ArrowUp') return scheduleCreateDateRangeAddDays(iso, -7);
  if (key === 'ArrowDown') return scheduleCreateDateRangeAddDays(iso, 7);
  if (key === 'Home' && typeof scheduleCreateDateRangeWeekStartIso === 'function') {
    return scheduleCreateDateRangeWeekStartIso(iso);
  }
  if (key === 'End' && typeof scheduleCreateDateRangeWeekEndIso === 'function') {
    return scheduleCreateDateRangeWeekEndIso(iso);
  }
  return null;
}

function scheduleDrawerStaffLocaleTag(){
  var loc = 'en';
  try {
    if (typeof getStaffLocale === 'function') loc = String(getStaffLocale() || 'en');
  } catch (_l) { loc = 'en'; }
  loc = String(loc || 'en').toLowerCase();
  if (loc.indexOf('es') === 0) return 'es';
  if (loc.indexOf('it') === 0) return 'it';
  return 'en';
}

function scheduleDrawerDateCellAriaLabel(iso, localeTag){
  var s = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var y = Number(s.slice(0, 4));
  var m = Number(s.slice(5, 7));
  var d = Number(s.slice(8, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return s;
  try {
    var dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    return new Intl.DateTimeFormat(localeTag || 'en', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    }).format(dt);
  } catch (_e) {
    return s;
  }
}

function scheduleRenderDrawerDateRangeCalendar(){
  var grid = el('ps-drawer-date-range-grid');
  var monthLabel = el('ps-drawer-date-range-month-label');
  if (!grid) return;
  var today = typeof scheduleTodayIso === 'function' ? scheduleTodayIso() : '2026-01-01';
  var ym = scheduleDrawerDateRangeViewYm || today.slice(0, 7);
  var parts = ym.split('-');
  var year = Number(parts[0]) || new Date().getFullYear();
  var month = Number(parts[1]) || (new Date().getMonth() + 1);
  if (month < 1) { month = 12; year -= 1; }
  if (month > 12) { month = 1; year += 1; }
  scheduleDrawerDateRangeViewYm = year + '-' + String(month).padStart(2, '0');
  var localeTag = scheduleDrawerStaffLocaleTag();
  var first = new Date(year, month - 1, 1);
  if (monthLabel) {
    try {
      monthLabel.textContent = first.toLocaleDateString(localeTag, { month: 'long', year: 'numeric' });
    } catch (_e) {
      monthLabel.textContent = scheduleDrawerDateRangeViewYm;
    }
  }
  var startDow = first.getDay();
  var daysInMonth = new Date(year, month, 0).getDate();
  var prevDays = new Date(year, month - 1, 0).getDate();
  var draft = scheduleDrawerDateRangeDraft || {};
  var dStart = draft.start || null;
  var dEnd = draft.end || null;
  var rangeLo = dStart && dEnd ? (dStart < dEnd ? dStart : dEnd) : dStart;
  var rangeHi = dStart && dEnd ? (dStart < dEnd ? dEnd : dStart) : dEnd;
  var html = '';
  var dayKeys = [
    'calendar.day.sun', 'calendar.day.mon', 'calendar.day.tue', 'calendar.day.wed',
    'calendar.day.thu', 'calendar.day.fri', 'calendar.day.sat',
  ];
  for (var d = 0; d < 7; d += 1) {
    var dowLabel = typeof portalT === 'function' ? portalT(dayKeys[d]) : dayKeys[d];
    html += '<span class="portal-schedule-create-date-range-dow" aria-hidden="true">'
      + escHtml(dowLabel) + '</span>';
  }
  var cells = [];
  for (var i = 0; i < startDow; i += 1) {
    var pd = prevDays - startDow + i + 1;
    var pMonth = month - 1;
    var pYear = year;
    if (pMonth < 1) { pMonth = 12; pYear -= 1; }
    cells.push({
      iso: pYear + '-' + String(pMonth).padStart(2, '0') + '-' + String(pd).padStart(2, '0'),
      day: pd,
      outside: true,
    });
  }
  for (var day = 1; day <= daysInMonth; day += 1) {
    cells.push({
      iso: year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0'),
      day: day,
      outside: false,
    });
  }
  while (cells.length % 7 !== 0) {
    var nd = cells.length - (startDow + daysInMonth) + 1;
    var nMonth = month + 1;
    var nYear = year;
    if (nMonth > 12) { nMonth = 1; nYear += 1; }
    cells.push({
      iso: nYear + '-' + String(nMonth).padStart(2, '0') + '-' + String(nd).padStart(2, '0'),
      day: nd,
      outside: true,
    });
  }
  var focusIso = scheduleDrawerDateRangeFocusIso;
  var hasFocusCell = focusIso && cells.some(function(c){ return c.iso === focusIso; });
  if (!hasFocusCell) {
    focusIso = null;
    if (dStart && cells.some(function(c){ return c.iso === dStart; })) focusIso = dStart;
    else {
      for (var fi = 0; fi < cells.length; fi += 1) {
        if (!cells[fi].outside) { focusIso = cells[fi].iso; break; }
      }
    }
    scheduleDrawerDateRangeFocusIso = focusIso;
  }
  var valid = typeof scheduleCreateDateRangeIsValidIso === 'function'
    ? scheduleCreateDateRangeIsValidIso
    : function(iso){ return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(iso || '').slice(0, 10)); };
  cells.forEach(function(c){
    var cls = 'portal-schedule-create-date-range-day';
    var selected = false;
    if (c.outside) cls += ' is-outside';
    if (dStart && c.iso === dStart) { cls += ' is-selected-start is-selected'; selected = true; }
    if (dEnd && c.iso === dEnd) { cls += ' is-selected-end is-selected'; selected = true; }
    if (rangeLo && rangeHi && c.iso > rangeLo && c.iso < rangeHi) cls += ' is-in-range';
    var tab = (focusIso && c.iso === focusIso) ? '0' : '-1';
    var cellAria = scheduleDrawerDateCellAriaLabel(c.iso, localeTag);
    html += '<button type="button" class="' + cls + '" tabindex="' + tab
      + '" data-date="' + escHtml(c.iso) + '" aria-label="' + escHtml(cellAria)
      + '" aria-pressed="' + (selected ? 'true' : 'false') + '">'
      + escHtml(String(c.day)) + '</button>';
  });
  grid.innerHTML = html;
  grid._dateRangeCells = cells;
  var apply = el('ps-drawer-date-range-apply');
  if (apply) apply.disabled = !(valid(dStart) && (!dEnd || valid(dEnd)));
}

function scheduleApplyDrawerDateRangeDraft(){
  var draft = scheduleDrawerDateRangeDraft || {};
  var valid = typeof scheduleCreateDateRangeIsValidIso === 'function'
    ? scheduleCreateDateRangeIsValidIso
    : function(iso){ return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(iso || '').slice(0, 10)); };
  var start = draft.start ? String(draft.start).slice(0, 10) : '';
  if (!valid(start)) return false;
  var end = draft.end ? String(draft.end).slice(0, 10) : start;
  if (!valid(end)) return false;
  var df = el('ps-drawer-date-from');
  var dt = el('ps-drawer-date-to');
  if (df) df.value = start;
  if (dt) dt.value = end;
  try {
    if (df) df.dispatchEvent(new Event('change', { bubbles: true }));
    if (dt) dt.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (_e) {
    if (typeof scheduleDrawerMarkPriceStale === 'function') scheduleDrawerMarkPriceStale();
    if (scheduleDrawerMainActivityValue() === 'private'
      && typeof scheduleDrawerSyncPrivateSessions === 'function') {
      scheduleDrawerSyncPrivateSessions({ skipCtxSeed: true });
    }
    if (typeof scheduleDrawerRefreshDurationConfirm === 'function') scheduleDrawerRefreshDurationConfirm();
    if (typeof scheduleDrawerRefreshWhenSummary === 'function') scheduleDrawerRefreshWhenSummary();
    if (typeof scheduleRenderDrawerRentals === 'function') scheduleRenderDrawerRentals();
    if (typeof scheduleRefreshDrawerFullDayAddon === 'function') scheduleRefreshDrawerFullDayAddon();
    if (typeof scheduleDrawerSyncFooter === 'function') scheduleDrawerSyncFooter();
  }
  scheduleSyncDrawerDateRangeUi();
  scheduleDrawerDateRangeClosePopover({ restoreFocus: true, applied: true, discard: false });
  return true;
}

function scheduleDrawerDateRangeOnDocumentKeydown(ev){
  if (!ev) return;
  if (ev.key !== 'Escape' && ev.key !== 'Esc') return;
  if (!scheduleDrawerDateRangeIsOpen()) return;
  if (ev.preventDefault) ev.preventDefault();
  scheduleDrawerDateRangeClosePopover({ restoreFocus: true, discard: true });
}

function scheduleDrawerDateRangeOnDocumentPointer(ev){
  if (!scheduleDrawerDateRangeIsOpen()) return;
  var t = ev && ev.target;
  var field = el('ps-drawer-date-range');
  var pop = el('ps-drawer-date-range-popover');
  var trigger = el('ps-drawer-date-range-trigger');
  if (field && t && field.contains && field.contains(t)) return;
  if (pop && t && pop.contains && pop.contains(t)) return;
  if (trigger && t && (t === trigger || (trigger.contains && trigger.contains(t)))) return;
  scheduleDrawerDateRangeClosePopover({ restoreFocus: true, discard: true });
}

function scheduleWireDrawerDateRange(){
  var trigger = el('ps-drawer-date-range-trigger');
  if (!trigger || trigger.dataset.wired === '1') {
    scheduleSyncDrawerDateRangeUi();
    return;
  }
  trigger.dataset.wired = '1';
  trigger.addEventListener('click', function(ev){
    if (ev && ev.preventDefault) ev.preventDefault();
    scheduleDrawerDateRangeTogglePopover();
  });
  var prev = el('ps-drawer-date-range-prev');
  var next = el('ps-drawer-date-range-next');
  if (prev && !prev.dataset.wired) {
    prev.dataset.wired = '1';
    prev.addEventListener('click', function(){
      var today = typeof scheduleTodayIso === 'function' ? scheduleTodayIso() : '2026-01-01';
      var ym = (scheduleDrawerDateRangeViewYm || today.slice(0, 7)).split('-');
      var y = Number(ym[0]); var m = Number(ym[1]) - 1;
      if (m < 1) { m = 12; y -= 1; }
      scheduleDrawerDateRangeViewYm = y + '-' + String(m).padStart(2, '0');
      scheduleRenderDrawerDateRangeCalendar();
    });
  }
  if (next && !next.dataset.wired) {
    next.dataset.wired = '1';
    next.addEventListener('click', function(){
      var today = typeof scheduleTodayIso === 'function' ? scheduleTodayIso() : '2026-01-01';
      var ym = (scheduleDrawerDateRangeViewYm || today.slice(0, 7)).split('-');
      var y = Number(ym[0]); var m = Number(ym[1]) + 1;
      if (m > 12) { m = 1; y += 1; }
      scheduleDrawerDateRangeViewYm = y + '-' + String(m).padStart(2, '0');
      scheduleRenderDrawerDateRangeCalendar();
    });
  }
  var grid = el('ps-drawer-date-range-grid');
  if (grid && !grid.dataset.wired) {
    grid.dataset.wired = '1';
    grid.addEventListener('click', function(ev){
      var t = ev && ev.target;
      var btn = t && t.closest ? t.closest('[data-date]') : null;
      if (!btn || !(grid.contains ? grid.contains(btn) : true)) return;
      var iso = btn.getAttribute('data-date');
      var select = typeof scheduleCreateDateRangeSelectDay === 'function'
        ? scheduleCreateDateRangeSelectDay
        : null;
      if (select) scheduleDrawerDateRangeDraft = select(scheduleDrawerDateRangeDraft, iso);
      else scheduleDrawerDateRangeDraft = { start: iso, end: null };
      scheduleDrawerDateRangeFocusIso = iso;
      scheduleRenderDrawerDateRangeCalendar();
      scheduleSyncDrawerDateRangeUi();
      scheduleDrawerDateRangeFocusInto();
    });
    grid.addEventListener('keydown', function(ev){
      if (!ev) return;
      var t = ev.target;
      var btn = t && t.closest ? t.closest('[data-date]') : null;
      if (!btn || !(grid.contains ? grid.contains(btn) : true)) return;
      var iso = btn.getAttribute('data-date');
      var key = ev.key || ev.code;
      if (key === 'Enter' || key === ' ' || key === 'Spacebar' || key === 'Space') {
        if (ev.preventDefault) ev.preventDefault();
        var select = typeof scheduleCreateDateRangeSelectDay === 'function'
          ? scheduleCreateDateRangeSelectDay
          : null;
        if (select) scheduleDrawerDateRangeDraft = select(scheduleDrawerDateRangeDraft, iso);
        else scheduleDrawerDateRangeDraft = { start: iso, end: null };
        scheduleDrawerDateRangeFocusIso = iso;
        scheduleRenderDrawerDateRangeCalendar();
        scheduleSyncDrawerDateRangeUi();
        scheduleDrawerDateRangeFocusInto();
        return;
      }
      var nextIso = scheduleDrawerDateRangeMoveFocus(iso, key);
      if (!nextIso) return;
      if (ev.preventDefault) ev.preventDefault();
      scheduleDrawerDateRangeFocusIso = nextIso;
      var nextYm = String(nextIso).slice(0, 7);
      if (nextYm && nextYm !== scheduleDrawerDateRangeViewYm) {
        scheduleDrawerDateRangeViewYm = nextYm;
      }
      scheduleRenderDrawerDateRangeCalendar();
      scheduleDrawerDateRangeFocusInto();
    });
  }
  var cancelBtn = el('ps-drawer-date-range-cancel');
  if (cancelBtn && !cancelBtn.dataset.wired) {
    cancelBtn.dataset.wired = '1';
    cancelBtn.addEventListener('click', function(){
      scheduleDrawerDateRangeClosePopover({ restoreFocus: true, discard: true });
    });
  }
  var applyBtn = el('ps-drawer-date-range-apply');
  if (applyBtn && !applyBtn.dataset.wired) {
    applyBtn.dataset.wired = '1';
    applyBtn.addEventListener('click', function(){ scheduleApplyDrawerDateRangeDraft(); });
  }
  if (!scheduleDrawerDateRangeDocWired) {
    scheduleDrawerDateRangeDocWired = true;
    try {
      document.addEventListener('keydown', scheduleDrawerDateRangeOnDocumentKeydown);
      document.addEventListener('mousedown', scheduleDrawerDateRangeOnDocumentPointer);
    } catch (_doc) { /* non-DOM sandbox */ }
  }
  scheduleSyncDrawerDateRangeUi();
}

/* ── Main activity buttons + group/private drill-down (Create parity) ───── */

function scheduleSyncDrawerMainActivityButtons(){
  var map = [
    'ps-drawer-comp-course',
    'ps-drawer-comp-private-lesson',
    'ps-drawer-comp-no-lesson',
  ];
  var host = el('ps-drawer-main-activity-choices');
  if (!host) return;
  map.forEach(function(id){
    var radio = el(id);
    var on = !!(radio && radio.checked);
    var btn = null;
    try {
      btn = host.querySelector('[data-edit-activity="' + id + '"]')
        || host.querySelector('[data-create-activity="' + id + '"]');
    } catch (_q) { btn = null; }
    if (!btn) return;
    try { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); } catch (_a) { /* ignore */ }
    if (on) btn.classList.add('is-selected');
    else btn.classList.remove('is-selected');
  });
}

function scheduleWireDrawerMainActivityButtons(){
  var host = el('ps-drawer-main-activity-choices');
  if (!host || host.dataset.activityBtnsWired === '1') {
    scheduleSyncDrawerMainActivityButtons();
    return;
  }
  host.dataset.activityBtnsWired = '1';
  host.addEventListener('click', function(ev){
    var t = ev && ev.target;
    var btn = t && t.closest
      ? (t.closest('[data-edit-activity]') || t.closest('[data-create-activity]'))
      : null;
    if (!btn || !host.contains(btn)) return;
    var id = btn.getAttribute('data-edit-activity') || btn.getAttribute('data-create-activity');
    var radio = el(id);
    if (!radio) return;
    radio.checked = true;
    ['ps-drawer-comp-course', 'ps-drawer-comp-private-lesson', 'ps-drawer-comp-no-lesson'].forEach(function(rid){
      var r = el(rid);
      if (r && rid !== id) r.checked = false;
    });
    scheduleSyncDrawerMainActivityButtons();
    try {
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_e) {
      if (typeof scheduleDrawerOnComponentChange === 'function') scheduleDrawerOnComponentChange(id);
    }
  });
  scheduleSyncDrawerMainActivityButtons();
}

function scheduleDrawerIsGroupCourseDrilldown() {
  return scheduleDrawerMainActivityView === 'group-courses';
}
function scheduleDrawerIsPrivateSessionsDrilldown() {
  return scheduleDrawerMainActivityView === 'private-sessions';
}
function scheduleDrawerPrivatePanelNode() {
  return el('ps-drawer-private-panel') || el('ps-drawer-private-when');
}
function scheduleDrawerClearPrivateSessionDraft() {
  var sessions = el('ps-drawer-private-sessions');
  if (sessions) {
    try { sessions.innerHTML = ''; } catch (_s) { /* ignore */ }
  }
}

/**
 * Selected Group course product IDs from Edit course buttons (multi-select, Create parity).
 * Button aria-pressed is authoritative; hidden checkboxes/select mirror for payload.
 */
function scheduleDrawerGetSelectedCourseIds() {
  var list = el('ps-drawer-course-list');
  var ids = [];
  var seen = {};
  function pushId(raw) {
    var id = String(raw || '').trim();
    if (!id || seen[id]) return;
    seen[id] = true;
    ids.push(id);
  }
  if (list) {
    try {
      list.querySelectorAll('button[data-course-id][aria-pressed="true"]').forEach(function(btn) {
        pushId(btn.getAttribute('data-course-id'));
      });
    } catch (_b) { /* ignore */ }
    if (!ids.length) {
      try {
        list.querySelectorAll(
          'input[type="checkbox"][name="ps-drawer-course-pick"]:checked, input[type="radio"][name="ps-drawer-course-pick"]:checked'
        ).forEach(function(inp) {
          pushId(inp.value);
        });
      } catch (_c) { /* ignore */ }
    }
  }
  if (!ids.length) {
    var sel = el('ps-drawer-course-select');
    if (sel && sel.multiple && sel.selectedOptions) {
      try {
        Array.prototype.forEach.call(sel.selectedOptions, function(opt) { pushId(opt.value); });
      } catch (_m) { /* ignore */ }
    } else if (sel) {
      var fromSel = String(sel.value || '').trim();
      if (fromSel) pushId(fromSel);
      else {
        // Compatibility seed when select value blanked (disabled option).
        try {
          var multiSeed = sel.getAttribute('data-selected-courses') || '';
          if (multiSeed) {
            try {
              var parsed = JSON.parse(multiSeed);
              if (Array.isArray(parsed)) parsed.forEach(pushId);
            } catch (_j) {
              multiSeed.split(',').forEach(pushId);
            }
          } else {
            pushId(sel.getAttribute('data-selected') || '');
          }
        } catch (_d) { /* ignore */ }
      }
    }
  }
  return ids;
}

/** First selected course id (compat for single-course readers / duration confirm). */
function scheduleDrawerGetSelectedCourseId() {
  var ids = scheduleDrawerGetSelectedCourseIds();
  return ids.length ? ids[0] : '';
}

/** Keep visible course buttons + hidden inputs in sync with multi selected ids. */
function scheduleDrawerSyncCourseButtons(selectedIds) {
  var list = el('ps-drawer-course-list');
  var ids = [];
  var seen = {};
  var raw = selectedIds;
  if (raw == null || raw === '') raw = [];
  if (!Array.isArray(raw)) raw = [raw];
  raw.forEach(function(v) {
    var id = String(v || '').trim();
    if (!id || seen[id]) return;
    seen[id] = true;
    ids.push(id);
  });
  if (list) {
    try {
      list.querySelectorAll('button[data-course-id]').forEach(function(btn) {
        var cid = String(btn.getAttribute('data-course-id') || '').trim();
        var on = !!(cid && seen[cid]);
        try { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); } catch (_a) { /* ignore */ }
        if (on) btn.classList.add('is-selected');
        else btn.classList.remove('is-selected');
      });
    } catch (_bt) { /* ignore */ }
    try {
      list.querySelectorAll(
        'input[type="checkbox"][name="ps-drawer-course-pick"], input[type="radio"][name="ps-drawer-course-pick"]'
      ).forEach(function(inp) {
        inp.checked = !!(seen[String(inp.value || '')]);
      });
    } catch (_r) { /* ignore */ }
  }
  var sel = el('ps-drawer-course-select');
  if (sel) {
    try {
      if (sel.options && sel.options.length) {
        for (var i = 0; i < sel.options.length; i++) {
          sel.options[i].selected = !!seen[String(sel.options[i].value || '')];
        }
      }
      sel.value = ids.length ? ids[0] : '';
      sel.setAttribute('data-selected', ids.length ? ids[0] : '');
      sel.setAttribute('data-selected-courses', JSON.stringify(ids));
    } catch (_s) { /* ignore */ }
  }
}

function scheduleDrawerEnsureCourseSelectOption(courseId, courseLabel) {
  var id = String(courseId || '').trim();
  if (!id) return;
  var label = courseLabel != null ? String(courseLabel).trim() : '';
  var sel = el('ps-drawer-course-select');
  if (!sel) return;
  var found = false;
  if (sel.options && sel.options.length) {
    for (var i = 0; i < sel.options.length; i++) {
      if (String(sel.options[i].value) === id) {
        found = true;
        if (label && typeof sel.options[i].setAttribute === 'function') {
          try { sel.options[i].setAttribute('data-label', label); } catch (_l) { /* ignore */ }
        }
        break;
      }
    }
  }
  if (!found) {
    try {
      sel.innerHTML = (sel.innerHTML || '')
        + '<option value="' + escHtml(id) + '" data-label="' + escHtml(label || id) + '"'
        + ' data-eligible="1">'
        + escHtml(label || id) + '</option>';
    } catch (_i) { /* ignore */ }
  }
}

function scheduleDrawerClearSelectedCourse() {
  var sel = el('ps-drawer-course-select');
  if (sel) {
    sel.value = '';
    try {
      if (sel.options && sel.options.length) {
        for (var i = 0; i < sel.options.length; i++) sel.options[i].selected = false;
      } else {
        sel.selectedIndex = -1;
      }
    } catch (_s) { /* ignore */ }
    try { sel.setAttribute('data-selected', ''); } catch (_d) { /* ignore */ }
    try { sel.setAttribute('data-selected-courses', '[]'); } catch (_m) { /* ignore */ }
    try { sel.removeAttribute('data-compatibility-unavailable'); } catch (_c) { /* ignore */ }
  }
  scheduleDrawerSyncCourseButtons([]);
  if (typeof scheduleDrawerRenderMainActivityPath === 'function') scheduleDrawerRenderMainActivityPath();
  if (typeof scheduleRefreshDrawerFullDayAddon === 'function') scheduleRefreshDrawerFullDayAddon();
}

/**
 * Select one course (additive multi-select). Button clicks use toggle.
 * opts.exclusive replaces the full set with this single id.
 */
function scheduleDrawerSelectCourse(courseId, courseLabel, opts) {
  opts = opts || {};
  var id = String(courseId || '').trim();
  if (!id) return false;
  var label = courseLabel != null ? String(courseLabel).trim() : '';
  var quiet = opts.quiet === true;
  var exclusive = opts.exclusive === true;
  scheduleDrawerEnsureCourseSelectOption(id, label);
  var next = exclusive ? [id] : scheduleDrawerGetSelectedCourseIds().slice();
  if (next.indexOf(id) < 0) next.push(id);
  scheduleDrawerSyncCourseButtons(next);
  try {
    var sel = el('ps-drawer-course-select');
    if (sel) sel.removeAttribute('data-compatibility-unavailable');
  } catch (_rc) { /* ignore */ }
  if (typeof scheduleDrawerRenderMainActivityPath === 'function') scheduleDrawerRenderMainActivityPath();
  if (typeof scheduleRefreshDrawerFullDayAddon === 'function') scheduleRefreshDrawerFullDayAddon();
  if (!quiet) {
    if (typeof scheduleDrawerMarkPriceStale === 'function') scheduleDrawerMarkPriceStale();
    if (typeof scheduleDrawerRefreshDurationConfirm === 'function') scheduleDrawerRefreshDurationConfirm();
    if (typeof scheduleDrawerSyncFooter === 'function') scheduleDrawerSyncFooter();
  }
  return scheduleDrawerGetSelectedCourseIds().indexOf(id) >= 0;
}

/** Toggle a course product button on/off (multi-select, Create parity). */
function scheduleDrawerToggleCourse(courseId, courseLabel, opts) {
  opts = opts || {};
  var id = String(courseId || '').trim();
  if (!id) return false;
  var label = courseLabel != null ? String(courseLabel).trim() : '';
  var quiet = opts.quiet === true;
  scheduleDrawerEnsureCourseSelectOption(id, label);
  var cur = scheduleDrawerGetSelectedCourseIds().slice();
  var idx = cur.indexOf(id);
  if (idx >= 0) cur.splice(idx, 1);
  else cur.push(id);
  scheduleDrawerSyncCourseButtons(cur);
  try {
    var sel = el('ps-drawer-course-select');
    if (sel) {
      if (cur.length) sel.removeAttribute('data-compatibility-unavailable');
    }
  } catch (_rc) { /* ignore */ }
  if (typeof scheduleDrawerRenderMainActivityPath === 'function') scheduleDrawerRenderMainActivityPath();
  if (typeof scheduleRefreshDrawerFullDayAddon === 'function') scheduleRefreshDrawerFullDayAddon();
  if (!quiet) {
    if (typeof scheduleDrawerMarkPriceStale === 'function') scheduleDrawerMarkPriceStale();
    if (typeof scheduleDrawerRefreshDurationConfirm === 'function') scheduleDrawerRefreshDurationConfirm();
    if (typeof scheduleDrawerSyncFooter === 'function') scheduleDrawerSyncFooter();
  }
  return scheduleDrawerGetSelectedCourseIds().indexOf(id) >= 0;
}

/** Replace the full multi-selected course set. */
function scheduleDrawerSetSelectedCourses(courseIds, opts) {
  opts = opts || {};
  var quiet = opts.quiet === true;
  var next = [];
  var seen = {};
  (Array.isArray(courseIds) ? courseIds : []).forEach(function(raw) {
    var id = String(raw || '').trim();
    if (!id || seen[id]) return;
    seen[id] = true;
    next.push(id);
    scheduleDrawerEnsureCourseSelectOption(id, '');
  });
  scheduleDrawerSyncCourseButtons(next);
  if (typeof scheduleDrawerRenderMainActivityPath === 'function') scheduleDrawerRenderMainActivityPath();
  if (typeof scheduleRefreshDrawerFullDayAddon === 'function') scheduleRefreshDrawerFullDayAddon();
  if (!quiet) {
    if (typeof scheduleDrawerMarkPriceStale === 'function') scheduleDrawerMarkPriceStale();
    if (typeof scheduleDrawerRefreshDurationConfirm === 'function') scheduleDrawerRefreshDurationConfirm();
    if (typeof scheduleDrawerSyncFooter === 'function') scheduleDrawerSyncFooter();
  }
  return scheduleDrawerGetSelectedCourseIds().slice();
}

/**
 * Canonical selected course IDs for Edit seed from detail readback:
 * selected_courses → unique group lessons course_ids → single course_id.
 */
function scheduleDrawerSeedCourseIdsFromCtx(ctx) {
  var ids = [];
  var seen = {};
  function pushId(raw) {
    var id = String(raw || '').trim();
    if (!id || seen[id]) return;
    seen[id] = true;
    ids.push(id);
  }
  var comps = (ctx && ctx.components) || {};
  if (comps.course && Array.isArray(comps.course.selected_courses)) {
    comps.course.selected_courses.forEach(function(sc) {
      if (sc && sc.course_id) pushId(sc.course_id);
    });
  }
  if (!ids.length && ctx && Array.isArray(ctx.lessons)) {
    ctx.lessons.forEach(function(L) {
      if (L && L.kind === 'group' && L.course_id) pushId(L.course_id);
    });
  }
  if (!ids.length && comps.course && comps.course.course_id) {
    pushId(comps.course.course_id);
  }
  return ids;
}

function scheduleDrawerRenderMainActivityPath() {
  // Selected course/private/equipment is already visible on the activity buttons — no path crumb.
  var path = el('ps-drawer-main-activity-path');
  if (!path) return;
  path.textContent = '';
  scheduleDrawerSetVisible(path, false);
}

function scheduleDrawerEnterGroupCourseDrilldown() {
  var leavingPrivate = scheduleDrawerIsPrivateSessionsDrilldown()
    || !!(el('ps-drawer-comp-private-lesson') && el('ps-drawer-comp-private-lesson').checked);
  if (leavingPrivate) scheduleDrawerClearPrivateSessionDraft();
  scheduleDrawerMainActivityView = 'group-courses';
  if (el('ps-drawer-comp-course')) el('ps-drawer-comp-course').checked = true;
  if (el('ps-drawer-comp-private-lesson')) el('ps-drawer-comp-private-lesson').checked = false;
  if (el('ps-drawer-comp-no-lesson')) el('ps-drawer-comp-no-lesson').checked = false;
  scheduleDrawerSetVisible(el('ps-drawer-main-activity-choices'), false);
  scheduleDrawerSetVisible(el('ps-drawer-course-list'), true);
  var panelHide = scheduleDrawerPrivatePanelNode();
  scheduleDrawerSetVisible(panelHide, false);
  if (el('ps-drawer-private-panel') && el('ps-drawer-private-when')) {
    scheduleDrawerSetVisible(el('ps-drawer-private-when'), false);
  }
  scheduleDrawerSetVisible(el('ps-drawer-main-activity-back'), true);
  var cf = el('ps-drawer-course-fields');
  if (cf) scheduleDrawerSetVisible(cf, false);
  scheduleSyncDrawerMainActivityButtons();
  scheduleDrawerRenderMainActivityPath();
}

function scheduleDrawerEnterPrivateSessionsDrilldown() {
  var leavingGroup = scheduleDrawerIsGroupCourseDrilldown()
    || !!(el('ps-drawer-comp-course') && el('ps-drawer-comp-course').checked);
  if (leavingGroup) scheduleDrawerClearSelectedCourse();
  scheduleDrawerMainActivityView = 'private-sessions';
  if (el('ps-drawer-comp-course')) el('ps-drawer-comp-course').checked = false;
  if (el('ps-drawer-comp-private-lesson')) el('ps-drawer-comp-private-lesson').checked = true;
  if (el('ps-drawer-comp-no-lesson')) el('ps-drawer-comp-no-lesson').checked = false;
  scheduleDrawerSetVisible(el('ps-drawer-main-activity-choices'), false);
  scheduleDrawerSetVisible(el('ps-drawer-course-list'), false);
  var panel = scheduleDrawerPrivatePanelNode();
  scheduleDrawerSetVisible(panel, true);
  if (el('ps-drawer-private-panel') && el('ps-drawer-private-when')) {
    scheduleDrawerSetVisible(el('ps-drawer-private-when'), true);
  }
  scheduleDrawerSetVisible(el('ps-drawer-main-activity-back'), true);
  var cf = el('ps-drawer-course-fields');
  if (cf) scheduleDrawerSetVisible(cf, false);
  scheduleSyncDrawerMainActivityButtons();
  scheduleDrawerRenderMainActivityPath();
}

function scheduleDrawerExitMainActivityDrilldown(opts) {
  opts = opts || {};
  var clearCourse = opts.clearCourse !== false;
  var clearPrivate = opts.clearPrivate !== false;
  var restoreRootOnly = opts.restoreRootOnly === true;
  scheduleDrawerMainActivityView = 'root';
  if (clearCourse) scheduleDrawerClearSelectedCourse();
  if (clearPrivate) scheduleDrawerClearPrivateSessionDraft();
  scheduleDrawerSetVisible(el('ps-drawer-main-activity-choices'), true);
  scheduleDrawerSetVisible(el('ps-drawer-course-list'), false);
  var panelHide = scheduleDrawerPrivatePanelNode();
  scheduleDrawerSetVisible(panelHide, false);
  if (el('ps-drawer-private-panel') && el('ps-drawer-private-when')) {
    scheduleDrawerSetVisible(el('ps-drawer-private-when'), false);
  }
  scheduleDrawerSetVisible(el('ps-drawer-main-activity-back'), false);
  scheduleDrawerSetVisible(el('ps-drawer-main-activity-path'), false);
  var path = el('ps-drawer-main-activity-path');
  if (path) path.textContent = '';
  if (!restoreRootOnly) {
    if (el('ps-drawer-comp-course')) el('ps-drawer-comp-course').checked = false;
    if (el('ps-drawer-comp-private-lesson')) el('ps-drawer-comp-private-lesson').checked = false;
    if (el('ps-drawer-comp-no-lesson')) el('ps-drawer-comp-no-lesson').checked = true;
  }
  scheduleSyncDrawerMainActivityButtons();
}

function scheduleDrawerRenderCourseList(courses, opts) {
  opts = opts || {};
  var list = el('ps-drawer-course-list');
  var sel = el('ps-drawer-course-select');
  if (!list && !sel) return null;
  var prevIds = [];
  var seenPrev = {};
  function pushPrev(raw) {
    var id = String(raw || '').trim();
    if (!id || seenPrev[id]) return;
    seenPrev[id] = true;
    prevIds.push(id);
  }
  if (Array.isArray(opts.selectedIds) && opts.selectedIds.length) {
    opts.selectedIds.forEach(pushPrev);
  } else if (opts.selectedId != null && String(opts.selectedId).trim()) {
    pushPrev(opts.selectedId);
  } else {
    scheduleDrawerGetSelectedCourseIds().forEach(pushPrev);
  }
  if (!prevIds.length && sel) {
    try {
      var multiSeed = sel.getAttribute('data-selected-courses') || '';
      if (multiSeed) {
        try {
          var parsed = JSON.parse(multiSeed);
          if (Array.isArray(parsed)) parsed.forEach(pushPrev);
        } catch (_j) {
          multiSeed.split(',').forEach(pushPrev);
        }
      }
      if (!prevIds.length) pushPrev(sel.getAttribute('data-selected') || '');
    } catch (_s) { /* ignore */ }
  }
  var html = '';
  var selHtml = '';
  var availableIds = {};
  var catalogIds = {};
  var unavailSuffix = portalT('schedule.create.courseNotOnSelectedDates');
  (courses || []).forEach(function(c) {
    var id = String((c && c.course_id) || '').trim();
    if (!id) return;
    catalogIds[id] = true;
    var eligible = c.eligible_on_requested_dates !== false;
    var disabled = c.eligible_on_requested_dates === false;
    if (!disabled) availableIds[id] = true;
    var summary = c.schedule_summary ? (' — ' + c.schedule_summary) : '';
    var baseLabel = c.label || id;
    var showLabel = baseLabel + summary + (disabled
      ? (' (' + unavailSuffix + ')')
      : '');
    // Multi-select product buttons: several may be aria-pressed simultaneously.
    // Eligible only; unavailable seed stays as compatibility (data-selected), not pressed.
    var checked = !disabled && !!seenPrev[id];
    html += '<button type="button" class="portal-schedule-create-activity-btn'
      + (checked ? ' is-selected' : '')
      + (disabled ? ' is-disabled' : '') + '"'
      + ' data-course-id="' + escHtml(id) + '"'
      + ' data-label="' + escHtml(baseLabel) + '"'
      + ' data-eligible="' + (eligible ? '1' : '0') + '"'
      + (disabled ? ' data-compatibility="1"' : '')
      + ' aria-pressed="' + (checked ? 'true' : 'false') + '"'
      + (disabled ? ' disabled' : '')
      + '><span>' + escHtml(showLabel) + '</span></button>'
      + '<input type="checkbox" name="ps-drawer-course-pick" value="' + escHtml(id) + '"'
      + ' class="portal-schedule-create-visually-hidden" tabindex="-1" aria-hidden="true"'
      + (checked ? ' checked' : '')
      + (disabled ? ' disabled' : '')
      + '>';
    selHtml += '<option value="' + escHtml(id) + '" data-label="' + escHtml(baseLabel) + '"'
      + (disabled ? ' disabled' : '')
      + (checked ? ' selected' : '')
      + ' data-eligible="' + (eligible ? '1' : '0') + '"'
      + (disabled ? ' data-compatibility="1"' : '')
      + '>'
      + escHtml(baseLabel + (disabled ? (' (' + unavailSuffix + ')') : '')) + '</option>';
  });
  // Fail-closed Edit: preserve seeded canonical courses missing from catalog as compatibility.
  // Never silently clear/replace — staff must explicitly pick catalog courses.
  var missingSeedIds = prevIds.filter(function(id) { return !catalogIds[id]; });
  var unavailableSeedIds = prevIds.filter(function(id) { return !availableIds[id]; });
  var compatibilityUnavailable = unavailableSeedIds.length > 0;
  missingSeedIds.forEach(function(prev) {
    var seedLab = prev;
    try {
      if (sel) {
        var prior = sel.getAttribute('data-label') || '';
        if (prior && prior !== prev && missingSeedIds.length === 1) seedLab = prior;
      }
    } catch (_sl) { /* ignore */ }
    html += '<button type="button" class="portal-schedule-create-activity-btn is-disabled is-unavailable"'
      + ' data-course-id="' + escHtml(prev) + '"'
      + ' data-label="' + escHtml(seedLab) + '"'
      + ' data-eligible="0" data-compatibility="1"'
      + ' aria-pressed="false" disabled'
      + '><span>' + escHtml(seedLab + ' (' + unavailSuffix + ')') + '</span></button>';
    selHtml += '<option value="' + escHtml(prev) + '" data-label="' + escHtml(seedLab) + '"'
      + ' data-eligible="0" data-compatibility="1" disabled>'
      + escHtml(seedLab + ' (' + unavailSuffix + ')') + '</option>';
  });
  if (!html) {
    html = '<p class="portal-schedule-create-activity-hint" style="margin:0">'
      + escHtml(portalT('schedule.courses.noneConfigured'))
      + '</p>';
  }
  if (!selHtml) {
    selHtml = '<option value="">' + escHtml(portalT('schedule.courses.noneConfigured')) + '</option>';
  }
  if (list) list.innerHTML = html;
  if (sel) {
    sel.innerHTML = selHtml;
    try { sel.multiple = true; } catch (_sm) { /* ignore */ }
    try {
      if (compatibilityUnavailable) sel.setAttribute('data-compatibility-unavailable', '1');
      else sel.removeAttribute('data-compatibility-unavailable');
    } catch (_cu) { /* ignore */ }
  }
  // Press only available seeds; keep full prevIds identity for data-selected-courses.
  var pressedIds = prevIds.filter(function(id) { return !!availableIds[id]; });
  if (prevIds.length) {
    if (sel) {
      try { sel.setAttribute('data-selected', prevIds[0]); } catch (_d) { /* ignore */ }
      try { sel.setAttribute('data-selected-courses', JSON.stringify(prevIds)); } catch (_m) { /* ignore */ }
      try {
        if (pressedIds.length) sel.value = pressedIds[0];
        else sel.value = prevIds[0];
      } catch (_v) { /* ignore */ }
    }
    scheduleDrawerSyncCourseButtons(pressedIds);
    // Restore full seed identity after sync (sync writes only pressed ids).
    if (sel) {
      try { sel.setAttribute('data-selected', prevIds[0]); } catch (_d2) { /* ignore */ }
      try { sel.setAttribute('data-selected-courses', JSON.stringify(prevIds)); } catch (_m2) { /* ignore */ }
    }
  } else {
    if (sel) {
      sel.value = '';
      try { sel.setAttribute('data-selected', ''); } catch (_e) { /* ignore */ }
      try { sel.setAttribute('data-selected-courses', '[]'); } catch (_e2) { /* ignore */ }
      try { sel.removeAttribute('data-compatibility-unavailable'); } catch (_r) { /* ignore */ }
    }
    scheduleDrawerSyncCourseButtons([]);
  }
  if (list) {
    try {
      list.querySelectorAll('button[data-course-id]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          if (btn.disabled || btn.classList.contains('is-disabled')) return;
          var cid = String(btn.getAttribute('data-course-id') || '').trim();
          if (!cid) return;
          var lab = String(btn.getAttribute('data-label') || '').trim();
          if (typeof scheduleDrawerToggleCourse === 'function') {
            scheduleDrawerToggleCourse(cid, lab);
          } else {
            scheduleDrawerSelectCourse(cid, lab);
          }
        });
      });
    } catch (_wb) { /* ignore */ }
    try {
      list.querySelectorAll('input[type="checkbox"][name="ps-drawer-course-pick"]').forEach(function(box) {
        box.addEventListener('change', function() {
          if (box.disabled) return;
          var cid = String(box.value || '').trim();
          if (!cid) return;
          var lab = '';
          try {
            var row = list.querySelector('button[data-course-id="' + cid + '"]');
            if (row) lab = String(row.getAttribute('data-label') || '').trim();
          } catch (_l) { /* ignore */ }
          if (typeof scheduleDrawerToggleCourse === 'function') {
            // Align toggle to checkbox state without double-toggle race.
            var cur = scheduleDrawerGetSelectedCourseIds();
            var has = cur.indexOf(cid) >= 0;
            if (box.checked && !has) scheduleDrawerSelectCourse(cid, lab);
            else if (!box.checked && has) scheduleDrawerToggleCourse(cid, lab);
          } else {
            scheduleDrawerSelectCourse(cid, lab);
          }
        });
      });
    } catch (_w) { /* ignore */ }
  }
  scheduleDrawerRenderMainActivityPath();
  return {
    availableIds: availableIds,
    selectedIds: scheduleDrawerGetSelectedCourseIds(),
    selectedId: scheduleDrawerGetSelectedCourseId(),
    compatibilityUnavailable: compatibilityUnavailable,
  };
}

/** Seed drill-down view from current radios / selected courses (Edit open only). */
function scheduleDrawerSeedMainActivityView() {
  var mode = scheduleDrawerMainActivityValue();
  if (mode === 'group') {
    scheduleDrawerEnterGroupCourseDrilldown();
    var sel = el('ps-drawer-course-select');
    var selectedIds = [];
    if (sel) {
      try {
        var multiSeed = sel.getAttribute('data-selected-courses') || '';
        if (multiSeed) {
          try {
            var parsed = JSON.parse(multiSeed);
            if (Array.isArray(parsed)) {
              parsed.forEach(function(v) {
                var id = String(v || '').trim();
                if (id && selectedIds.indexOf(id) < 0) selectedIds.push(id);
              });
            }
          } catch (_j) {
            multiSeed.split(',').forEach(function(v) {
              var id = String(v || '').trim();
              if (id && selectedIds.indexOf(id) < 0) selectedIds.push(id);
            });
          }
        }
        if (!selectedIds.length) {
          var one = String(sel.getAttribute('data-selected') || sel.value || '').trim();
          if (one) selectedIds = [one];
        }
      } catch (_s) { /* ignore */ }
    }
    if (!selectedIds.length && typeof scheduleDrawerSeedCourseIdsFromCtx === 'function') {
      selectedIds = scheduleDrawerSeedCourseIdsFromCtx(scheduleDrawerState && scheduleDrawerState.ctx);
    }
    var courses = scheduleCoursesCache || [];
    // Empty catalog: preserve seeded identities as unavailable compatibility — never invent eligible:true.
    if (!courses.length && selectedIds.length) {
      courses = selectedIds.map(function(id) {
        return { course_id: id, label: id, eligible_on_requested_dates: false };
      });
    }
    scheduleDrawerRenderCourseList(courses, { selectedIds: selectedIds });
  } else if (mode === 'private') {
    scheduleDrawerEnterPrivateSessionsDrilldown();
  } else {
    scheduleDrawerMainActivityView = 'root';
    scheduleDrawerSetVisible(el('ps-drawer-main-activity-choices'), true);
    scheduleDrawerSetVisible(el('ps-drawer-course-list'), false);
    scheduleDrawerSetVisible(scheduleDrawerPrivatePanelNode(), false);
    scheduleDrawerSetVisible(el('ps-drawer-main-activity-back'), false);
    scheduleDrawerSetVisible(el('ps-drawer-main-activity-path'), false);
    scheduleSyncDrawerMainActivityButtons();
  }
}
function scheduleDrawerPaymentSelectValue(ctx){
  if (!ctx) return 'unpaid';
  // Prefer nested canonical payment truth; legacy top-level is fallback only.
  var pay = ctx.payment && typeof ctx.payment === 'object' ? ctx.payment : null;
  var status = pay && pay.payment_status != null && String(pay.payment_status).trim() !== ''
    ? String(pay.payment_status).trim()
    : (ctx.payment_status != null ? String(ctx.payment_status).trim() : '');
  if (String(status).toLowerCase() !== 'paid') return 'unpaid';
  var method = pay && pay.payment_method != null && String(pay.payment_method).trim() !== ''
    ? String(pay.payment_method).trim()
    : (ctx.payment_method != null ? String(ctx.payment_method).trim() : '');
  if (method === 'bank_transfer') return 'paid_bank_transfer';
  if (method === 'in_store') return 'paid_in_store';
  if (method === 'link') return 'paid_via_link';
  return 'paid_bank_transfer';
}
function scheduleRenderDrawerPaymentSelectHtml(ctx) {
  var cur = scheduleDrawerPaymentSelectValue(ctx);
  function opt(val, key) {
    return '<option value="' + val + '"' + (cur === val ? ' selected' : '') + '>' + escHtml(portalT(key)) + '</option>';
  }
  return '<div class="portal-schedule-create-field"><label for="ps-drawer-payment">' +
    escHtml(portalT('schedule.create.paymentStatus') || portalT('schedule.create.payment')) + '</label>' +
    '<select id="ps-drawer-payment">' +
    opt('unpaid', 'schedule.payment.unpaid') +
    opt('paid_bank_transfer', 'schedule.payment.paidBankTransfer') +
    opt('paid_in_store', 'schedule.payment.paidInStore') +
    opt('paid_via_link', 'schedule.payment.paidViaLink') +
    '</select></div>';
}

function scheduleRenderDrawerPaymentSectionEditHtml(ctx) {
  var pay = (ctx && ctx.payment) || {};
  var items = pay.line_items || [];
  var html = '<div class="ctx-pay-box portal-schedule-drawer-edit-pay-snapshot" id="ps-drawer-payment-box">';
  html += '<div class="ps-card-eyebrow">' + escHtml(portalT('schedule.drawer.paymentSection')) + '</div>';
  if (pay.pricing_note) {
    html += '<p class="portal-schedule-drawer-hint" style="margin:0 0 8px">' + escHtml(portalT('schedule.drawer.livePricingNote')) + '</p>';
  }
  var commercial = (typeof scheduleDrawerBuildCommercialLines === 'function')
    ? scheduleDrawerBuildCommercialLines(items, pay.rental_pricing || (ctx && ctx.rental_pricing) || null)
    : null;
  if (commercial && commercial.lines && commercial.lines.length) {
    html += '<div class="ctx-inv-group" id="ps-drawer-line-items" data-commercial="1">';
    commercial.lines.forEach(function(line) {
      html += '<div class="ctx-inv-line ctx-inv-addon-line' + (line.is_bundle ? ' is-bundle-line' : '') + '">' +
        escHtml(line.label) + ' — ' + escHtml(scheduleDrawerEur(line.line_cents)) + '</div>';
    });
    html += '</div>';
  } else if (!items.length) {
    html += '<div class="ctx-inv-line ctx-none">' + escHtml(portalT('schedule.drawer.noLineItems')) + '</div>';
  } else {
    html += '<div class="ctx-inv-group" id="ps-drawer-line-items">';
    items.forEach(function(li) {
      html += '<div class="ctx-inv-line ctx-inv-addon-line">' + escHtml(li.label) +
        ' — ' + escHtml(scheduleDrawerEur(li.line_cents)) + '</div>';
    });
    html += '</div>';
  }
  var effPaid=(Number(pay.paid_cents||0)>0&&pay.balance_due_cents!=null&&Number(pay.balance_due_cents)<=0);
  function tot(id,lab,amt,cls){return '<div class="ctx-inv-total-row"><span class="ctx-inv-total-label">'+escHtml(lab)+'</span><span class="ctx-inv-total-amount'+(cls?(' '+cls):'')+'" id="'+id+'">'+escHtml(scheduleDrawerEur(amt))+'</span></div>';}
  html+='<div class="ctx-inv-group ctx-inv-totals" style="margin-top:10px">'+tot('ps-drawer-subtotal',portalT('schedule.drawer.subtotal'),pay.subtotal_cents,'')+tot('ps-drawer-paid',portalT('schedule.drawer.paid'),pay.paid_cents,'paid')+tot('ps-drawer-remaining',portalT('schedule.drawer.remaining'),pay.balance_due_cents,'owing')+'<div class="ctx-inv-total-row"><span class="ctx-inv-total-label">'+escHtml(portalT('schedule.col.payment'))+'</span><span class="ctx-inv-total-amount'+(effPaid?' paid':'')+'" id="ps-drawer-pay-status">'+escHtml(schedulePaymentStatusLabel(effPaid?'paid':pay.payment_status,ctx&&ctx.payment_method))+'</span></div></div></div>';
  return html;
}

function scheduleRenderEditableDrawerHtml(row, ctx) {
  var comps = (ctx && ctx.components) || {};
  var courseOn = !!(comps.course || comps.lesson);
  var privateOn = !!comps.private_lesson;
  var boardOn = !!comps.surfboard;
  var wetsuitOn = !!comps.wetsuit;
  var selectedCourseIds = typeof scheduleDrawerSeedCourseIdsFromCtx === 'function'
    ? scheduleDrawerSeedCourseIdsFromCtx(ctx)
    : ((comps.course && comps.course.course_id) ? [String(comps.course.course_id)] : []);
  var selectedCourseId = selectedCourseIds.length ? selectedCourseIds[0] : '';
  var courseQty = (comps.course && comps.course.quantity) || (comps.lesson && comps.lesson.quantity) || 1;
  var code = (ctx && ctx.booking_code) || (row && row.booking_code) || '';
  var statusLabel = schedulePaymentStatusLabel(
    (ctx && ctx.payment && ctx.payment.payment_status) || (ctx && ctx.payment_status) || 'unpaid',
    ctx && ctx.payment_method
  );
  var mainMode = privateOn ? 'private' : (courseOn ? 'group' : 'none');
  // Booking surfer authority for no-lesson equipment qty (mirrors Create #ps-create-surfers).
  var seedSurfers = 1;
  if (courseOn) seedSurfers = parseInt(courseQty, 10) || 1;
  else if (privateOn) seedSurfers = parseInt((comps.private_lesson && comps.private_lesson.surfer_count) || 1, 10) || 1;
  else {
    var seedQtys = [];
    if (comps.surfboard && comps.surfboard.quantity) seedQtys.push(parseInt(comps.surfboard.quantity, 10) || 1);
    if (comps.wetsuit && comps.wetsuit.quantity) seedQtys.push(parseInt(comps.wetsuit.quantity, 10) || 1);
    if (Array.isArray(ctx.rentals)) {
      ctx.rentals.forEach(function(r) {
        if (r && r.quantity != null) seedQtys.push(parseInt(r.quantity, 10) || 1);
      });
    }
    if (ctx.guest_count != null) seedQtys.push(parseInt(ctx.guest_count, 10) || 1);
    if (seedQtys.length) seedSurfers = Math.max.apply(null, seedQtys);
  }
  var html = '<form id="ps-drawer-edit-form" class="portal-schedule-drawer-edit" autocomplete="off">';
  html += '<header class="portal-schedule-create-header portal-schedule-drawer-edit-header">';
  html += '<div class="portal-schedule-create-header-text">';
  html += '<h2 id="ps-drawer-edit-title" class="portal-schedule-create-title">' +
    escHtml(portalT('schedule.drawer.editTitle')) + '</h2>';
  html += '<span class="portal-schedule-create-school-chip" id="ps-drawer-edit-meta">';
  if (code) html += '<strong>' + escHtml(code) + '</strong>';
  if (statusLabel) html += (code ? ' · ' : '') + escHtml(statusLabel);
  html += '</span></div>';
  html += '<button type="button" class="btn btn-ghost portal-schedule-drawer-close-btn" id="ps-drawer-close" title="' +
    escHtml(portalT('schedule.drawer.close')) + '" aria-label="' + escHtml(portalT('schedule.drawer.close')) + '">&#10005;</button>';
  html += '</header>';
  html += '<div class="portal-schedule-create-body portal-schedule-drawer-edit-body">';
  html += '<section class="portal-schedule-create-section" data-edit-section="guest" aria-labelledby="ps-drawer-section-guest-title">';
  html += '<h3 id="ps-drawer-section-guest-title" class="portal-schedule-create-section-title">' +
    escHtml(portalT('schedule.create.section.guest')) + '</h3>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-guest">' +
    escHtml(portalT('schedule.create.guestName')) + '</label>' +
    '<input id="ps-drawer-guest" type="text" value="' + escHtml(ctx.guest_name || '') + '"></div>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-phone">' +
    escHtml(portalT('schedule.drawer.phone')) + '</label>' +
    '<input id="ps-drawer-phone" type="tel" value="' + escHtml(ctx.phone || '') + '"></div>';
  // Compact date range (Create parity). Hidden from/to remain canonical until Apply.
  html += '<div id="ps-drawer-date-range" class="portal-schedule-create-date-range-field">';
  html += '<span id="ps-drawer-date-range-label" class="portal-schedule-create-label">' +
    escHtml(portalT('schedule.create.dateRange') || 'Dates') + '</span>';
  html += '<button type="button" id="ps-drawer-date-range-trigger" class="portal-schedule-create-date-range-trigger" aria-haspopup="dialog" aria-expanded="false" aria-controls="ps-drawer-date-range-popover">';
  html += '<span id="ps-drawer-date-range-display" class="portal-schedule-create-date-range-display">' +
    escHtml((function(){
      var df = ctx.date_from || '';
      var dt = ctx.date_to || ctx.date_from || '';
      if (typeof scheduleCreateDateRangeDisplayText === 'function') {
        return scheduleCreateDateRangeDisplayText(df, dt);
      }
      if (!df) return portalT('schedule.create.dateRange.placeholder') || 'Select dates';
      if (!dt || df === dt) return df;
      return df + ' – ' + dt;
    })()) + '</span>';
  html += '</button>';
  html += '<div id="ps-drawer-date-range-popover" class="portal-schedule-create-date-range-popover" role="dialog" aria-modal="false" aria-labelledby="ps-drawer-date-range-label" hidden style="display:none">';
  html += '<div class="portal-schedule-create-date-range-cal-nav">';
  html += '<button type="button" id="ps-drawer-date-range-prev" aria-label="' +
    escHtml(portalT('schedule.create.dateRange.prevMonth') || 'Previous month') + '">&#8249;</button>';
  html += '<span id="ps-drawer-date-range-month-label" class="portal-schedule-create-date-range-month" aria-live="polite"></span>';
  html += '<button type="button" id="ps-drawer-date-range-next" aria-label="' +
    escHtml(portalT('schedule.create.dateRange.nextMonth') || 'Next month') + '">&#8250;</button>';
  html += '</div>';
  html += '<div id="ps-drawer-date-range-grid" class="portal-schedule-create-date-range-grid" role="group" aria-labelledby="ps-drawer-date-range-month-label"></div>';
  html += '<div class="portal-schedule-create-date-range-actions">';
  html += '<button type="button" class="btn btn-ghost" id="ps-drawer-date-range-cancel">' +
    escHtml(portalT('schedule.create.dateRange.cancel') || 'Cancel') + '</button>';
  html += '<button type="button" class="btn btn-primary" id="ps-drawer-date-range-apply">' +
    escHtml(portalT('schedule.create.dateRange.apply') || 'Apply') + '</button>';
  html += '</div></div>';
  html += '<input id="ps-drawer-date-from" type="date" class="portal-schedule-create-date-hidden" tabindex="-1" aria-hidden="true" hidden value="' +
    escHtml(ctx.date_from || '') + '">';
  html += '<input id="ps-drawer-date-to" type="date" class="portal-schedule-create-date-hidden" tabindex="-1" aria-hidden="true" hidden value="' +
    escHtml(ctx.date_to || ctx.date_from || '') + '">';
  html += '</div>';
  // Booking-level Number of surfers — Create #ps-create-surfers parity (visible for no-lesson only).
  html += '<div class="portal-schedule-create-field" id="ps-drawer-surfers-field"' +
    (mainMode === 'none' ? '' : ' style="display:none" hidden aria-hidden="true"') + '>' +
    '<label for="ps-drawer-surfers">' + escHtml(portalT('schedule.create.surferCount')) + '</label>' +
    '<input id="ps-drawer-surfers" type="number" min="1" max="99" value="' +
    escHtml(String(seedSurfers)) + '" inputmode="numeric"></div>';
  html += '</section>';
  html += '<section class="portal-schedule-create-section" data-edit-section="what" aria-labelledby="ps-drawer-section-what-title">';
  html += '<h3 id="ps-drawer-section-what-title" class="portal-schedule-create-section-title">' +
    escHtml(portalT('schedule.create.section.what')) + '</h3>';
  // Main activity: native buttons + in-place Group/Private drill-down (Create parity).
  html += '<div class="portal-schedule-create-field" id="ps-drawer-main-activity-field">';
  html += '<div class="portal-schedule-create-main-activity-header">';
  html += '<span id="ps-drawer-main-activity-label" class="portal-schedule-create-label">' +
    escHtml(portalT('schedule.create.mainActivity')) + '</span>';
  html += '<button type="button" id="ps-drawer-main-activity-back" class="btn btn-ghost portal-schedule-create-main-activity-back" style="display:none" hidden aria-hidden="true">' +
    escHtml(portalT('schedule.create.mainActivityBack') || 'Back') + '</button>';
  html += '</div>';
  html += '<div id="ps-drawer-main-activity-path" class="portal-schedule-create-main-activity-path" style="display:none" hidden aria-live="polite"></div>';
  html += '<div id="ps-drawer-main-activity-choices" class="portal-schedule-create-components portal-schedule-create-main-activity" role="group" aria-labelledby="ps-drawer-main-activity-label">';
  html += '<button type="button" class="portal-schedule-create-activity-btn' + (mainMode === 'group' ? ' is-selected' : '') +
    '" data-edit-activity="ps-drawer-comp-course" aria-pressed="' + (mainMode === 'group' ? 'true' : 'false') + '">' +
    '<span>' + escHtml(portalT('schedule.type.course')) + '</span></button>';
  html += '<input id="ps-drawer-comp-course" type="radio" name="ps-drawer-main-activity" value="group" class="portal-schedule-create-visually-hidden" tabindex="-1" aria-hidden="true"' +
    (mainMode === 'group' ? ' checked' : '') + '>';
  html += '<button type="button" class="portal-schedule-create-activity-btn' + (mainMode === 'private' ? ' is-selected' : '') +
    '" data-edit-activity="ps-drawer-comp-private-lesson" aria-pressed="' + (mainMode === 'private' ? 'true' : 'false') + '">' +
    '<span>' + escHtml(portalT('schedule.type.privateLesson') || portalT('schedule.type.privateCourse')) + '</span></button>';
  html += '<input id="ps-drawer-comp-private-lesson" type="radio" name="ps-drawer-main-activity" value="private" class="portal-schedule-create-visually-hidden" tabindex="-1" aria-hidden="true"' +
    (mainMode === 'private' ? ' checked' : '') + '>';
  html += '<button type="button" class="portal-schedule-create-activity-btn' + (mainMode === 'none' ? ' is-selected' : '') +
    '" data-edit-activity="ps-drawer-comp-no-lesson" aria-pressed="' + (mainMode === 'none' ? 'true' : 'false') + '">' +
    '<span>' + escHtml(portalT('schedule.type.noLesson')) + '</span></button>';
  html += '<input id="ps-drawer-comp-no-lesson" type="radio" name="ps-drawer-main-activity" value="none" class="portal-schedule-create-visually-hidden" tabindex="-1" aria-hidden="true"' +
    (mainMode === 'none' ? ' checked' : '') + '>';
  html += '</div>';
  html += '<div id="ps-drawer-course-list" class="portal-schedule-create-components portal-schedule-create-course-list" role="group" aria-labelledby="ps-drawer-main-activity-label" style="display:none" hidden aria-hidden="true"></div>';
  // Private sessions drill-down panel (same replacement region as course list).
  html += '<div id="ps-drawer-private-panel" class="portal-schedule-create-private-panel"' +
    (privateOn ? '' : ' style="display:none" hidden aria-hidden="true"') + '>';
  html += '<div id="ps-drawer-private-when" class="portal-schedule-create-private-when"' +
    (privateOn ? '' : ' style="display:none"') + '>';
  html += '<span class="portal-schedule-create-label">' + escHtml(portalT('schedule.create.privateLesson.sessionsHelp')) + '</span>';
  // Free multi private sessions (same-day multi preserved) — seed from lessons[] / sessions.
  var privateSeed = [];
  if (Array.isArray(ctx.lessons)) {
    privateSeed = ctx.lessons.filter(function(L) { return L && L.kind === 'private'; }).map(function(L) {
      return { date: L.date, start: L.start || '', end: L.end || '' };
    });
  }
  if (!privateSeed.length && comps.private_lesson && Array.isArray(comps.private_lesson.sessions)) {
    privateSeed = comps.private_lesson.sessions.map(function(s) {
      return { date: s.date, start: s.start || '', end: s.end || '' };
    });
  }
  html += '<div id="ps-drawer-private-sessions" class="portal-schedule-private-sessions" aria-live="polite" data-seed="' +
    escHtml(JSON.stringify(privateSeed)) + '"></div>';
  html += '<button type="button" class="btn btn-ghost portal-schedule-add-session-btn" id="ps-drawer-add-private-session">' +
    escHtml(portalT('schedule.create.privateLesson.addSession') || '+ Add session') + '</button>';
  html += '</div></div>';
  html += '</div>'; // main-activity-field
  // Legacy course select — hidden compatibility owner for payload / duration.
  html += '<div id="ps-drawer-course-section"' + (courseOn || privateOn ? '' : ' style="display:none"') + '>';
  html += '<div class="portal-schedule-create-field" id="ps-drawer-course-fields" style="display:none" hidden aria-hidden="true">' +
    '<label for="ps-drawer-course-select" hidden>' + escHtml(portalT('schedule.create.courseSelect')) + '</label>' +
    '<select id="ps-drawer-course-select" multiple data-selected="' + escHtml(selectedCourseId) +
    '" data-selected-courses="' + escHtml(JSON.stringify(selectedCourseIds)) +
    '" tabindex="-1" aria-hidden="true"></select></div>';
  html += '<div id="ps-drawer-course-duration-confirm" class="portal-schedule-drawer-duration-confirm" role="status" aria-live="polite"' +
    (courseOn ? '' : ' style="display:none"') + '></div>';
  html += '<div class="portal-schedule-create-field" id="ps-drawer-course-qty-wrap"' + (courseOn ? '' : ' style="display:none"') +
    '><label for="ps-drawer-course-qty">' + escHtml(portalT('schedule.create.surferCount')) + '</label>' +
    '<input id="ps-drawer-course-qty" type="number" min="1" max="99" value="' + escHtml(String(courseQty)) + '"></div>';
  // Group Edit uses multi-select course product buttons only — no lesson-builder rows/dates/times.
  html += '<div id="ps-drawer-private-lesson-fields"' + (privateOn ? '' : ' style="display:none"') + '>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-private-lesson-surfers">' +
    escHtml(portalT('schedule.create.surferCount')) + '</label>' +
    '<input id="ps-drawer-private-lesson-surfers" type="number" min="1" max="99" value="' +
    escHtml(String((comps.private_lesson && comps.private_lesson.surfer_count) || 1)) + '"></div>';
  html += '</div></div>';
  html += '<div class="portal-schedule-create-field portal-schedule-drawer-gear-secondary">';
  html += '<span class="portal-schedule-create-label">' + escHtml(portalT('schedule.drawer.section.rentals') || 'Gear') + '</span>';
  html += '<div id="ps-drawer-rentals" class="portal-schedule-create-rentals portal-schedule-drawer-rentals" aria-live="polite"';
  html += ' data-seed-board="' + (boardOn ? '1' : '0') + '" data-seed-wetsuit="' + (wetsuitOn ? '1' : '0') + '"';
  html += ' data-seed-board-qty="' + escHtml(String((comps.surfboard && comps.surfboard.quantity) || 1)) + '"';
  html += ' data-seed-wetsuit-qty="' + escHtml(String((comps.wetsuit && comps.wetsuit.quantity) || 1)) + '"';
  html += ' data-seed-surfers="' + escHtml(String(seedSurfers)) + '"';
  html += ' data-seed-rentals="' + escHtml(JSON.stringify(Array.isArray(ctx.rentals) ? ctx.rentals : [])) + '"></div>';
  var equipmentSeed = ctx.course_equipment || [];
  /* A short-lived singleton detail shape is read-only compatibility. */
  if (equipmentSeed && !Array.isArray(equipmentSeed) && equipmentSeed.mode) {
    equipmentSeed = [{ offering_key: equipmentSeed.offering_key || '', mode: equipmentSeed.mode, quantity: equipmentSeed.quantity }];
  }
  /* Legacy full-day rows remain read-compatible, but the obsolete checkbox/menu is not rendered. */
  if (!equipmentSeed && comps.full_day_equipment_extension && comps.full_day_equipment_extension.dates) {
    var legacyQtys = Object.keys(comps.full_day_equipment_extension.dates).map(function(d){ return parseInt(comps.full_day_equipment_extension.dates[d], 10) || 1; });
    equipmentSeed = [{ offering_key: '', mode: 'all_day', quantity: legacyQtys.length ? Math.max.apply(null, legacyQtys) : seedSurfers }];
  }
  html += '<div class="portal-schedule-course-equipment" id="ps-drawer-course-equipment" style="display:none" hidden data-seed="' + escHtml(JSON.stringify(equipmentSeed)) + '"></div>';
  html += '</section>';
  // When shell: non-private date summary (private sessions live in Main activity drill-down).
  html += '<section class="portal-schedule-create-section" data-edit-section="when" aria-labelledby="ps-drawer-section-when-title">';
  html += '<h3 id="ps-drawer-section-when-title" class="portal-schedule-create-section-title">' +
    escHtml(portalT('schedule.create.section.when')) + '</h3>';
  html += '<div id="ps-drawer-when-summary" class="portal-schedule-drawer-when-summary" role="status" aria-live="polite"></div>';
  html += '</section>';
  // Custom add-on card (same Create contract) — editable commercial adjustments.
  html += '<section class="portal-schedule-create-section portal-schedule-create-custom-addon-card" data-edit-section="custom-addon" aria-labelledby="ps-drawer-section-custom-addon-title" data-testid="ps-drawer-custom-addon-card">';
  html += '<div class="portal-schedule-create-custom-addon-header">';
  html += '<h3 id="ps-drawer-section-custom-addon-title" class="portal-schedule-create-section-title" data-i18n="schedule.create.section.customAddon">' +
    escHtml(portalT('schedule.create.section.customAddon') || 'Custom add-on') + '</h3>';
  html += '<div id="ps-drawer-custom-lines-collapsed" class="portal-schedule-create-custom-lines-collapsed">';
  html += '<button type="button" id="ps-drawer-custom-line-add-btn" class="portal-schedule-create-custom-line-plus" data-i18n-aria="schedule.create.customLine.add" aria-label="' +
    escHtml(portalT('schedule.create.customLine.add') || 'Add custom line') + '" title="' +
    escHtml(portalT('schedule.create.customLine.add') || 'Add custom line') + '">+</button>';
  html += '</div></div>';
  html += '<div id="ps-drawer-custom-lines" class="portal-schedule-create-custom-lines" data-testid="ps-drawer-custom-lines">';
  html += '<div id="ps-drawer-custom-lines-list" class="portal-schedule-create-custom-lines-list" aria-live="polite"></div>';
  html += '<div id="ps-drawer-custom-lines-editor" class="portal-schedule-create-custom-lines-editor" style="display:none" hidden aria-hidden="true">';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-custom-line-label" data-i18n="schedule.create.customLine.label">' +
    escHtml(portalT('schedule.create.customLine.label') || 'Label') + '</label>';
  html += '<input id="ps-drawer-custom-line-label" type="text" maxlength="120" autocomplete="off"></div>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-custom-line-price" data-i18n="schedule.create.customLine.price">' +
    escHtml(portalT('schedule.create.customLine.price') || 'Price') + '</label>';
  html += '<div class="portal-schedule-create-custom-line-price-row">';
  html += '<span class="portal-schedule-create-custom-line-currency" aria-hidden="true">€</span>';
  html += '<input id="ps-drawer-custom-line-price" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00">';
  html += '</div></div>';
  html += '<div class="portal-schedule-create-custom-line-actions">';
  html += '<button type="button" class="btn btn-primary" id="ps-drawer-custom-line-confirm" data-i18n="schedule.create.customLine.confirm">' +
    escHtml(portalT('schedule.create.customLine.confirm') || 'Add') + '</button>';
  html += '<button type="button" class="btn btn-ghost" id="ps-drawer-custom-line-cancel" data-i18n="schedule.create.customLine.cancel">' +
    escHtml(portalT('schedule.create.customLine.cancel') || 'Cancel') + '</button>';
  html += '</div>';
  html += '<p id="ps-drawer-custom-line-error" class="portal-schedule-create-custom-line-error" style="display:none" role="alert"></p>';
  html += '</div>';
  // Accommodation under Custom add-on (Edit parity with Create).
  html += '<div id="ps-drawer-accommodation-wrap" class="portal-schedule-create-accommodation" data-testid="ps-drawer-accommodation" data-seed-accommodation="' +
    escHtml(JSON.stringify(ctx && ctx.accommodation ? {
      enabled: true,
      check_in: ctx.accommodation.check_in,
      check_out: ctx.accommodation.check_out,
    } : null)) + '">';
  html += '<div class="portal-schedule-create-custom-addon-header" style="margin-top:10px">';
  html += '<h4 class="portal-schedule-create-section-title" data-i18n="schedule.create.accommodation.title">' +
    escHtml(portalT('schedule.create.accommodation.title') || 'Accommodation') + '</h4>';
  html += '<button type="button" id="ps-drawer-accommodation-add-btn" class="portal-schedule-create-custom-line-plus" data-i18n-aria="schedule.create.accommodation.add" aria-label="' +
    escHtml(portalT('schedule.create.accommodation.add') || 'Accommodation +') + '">+</button>';
  html += '</div>';
  html += '<div id="ps-drawer-accommodation-editor" class="portal-schedule-create-accommodation-editor" style="display:none" hidden aria-hidden="true" data-testid="ps-drawer-accommodation-editor">';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-accommodation-check-in" data-i18n="schedule.create.accommodation.checkIn">' +
    escHtml(portalT('schedule.create.accommodation.checkIn') || 'Check in') + '</label>';
  html += '<input id="ps-drawer-accommodation-check-in" type="date" autocomplete="off"></div>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-accommodation-check-out" data-i18n="schedule.create.accommodation.checkOut">' +
    escHtml(portalT('schedule.create.accommodation.checkOut') || 'Check out') + '</label>';
  html += '<input id="ps-drawer-accommodation-check-out" type="date" autocomplete="off"></div>';
  html += '<div class="portal-schedule-create-custom-line-actions">';
  html += '<button type="button" class="btn btn-ghost" id="ps-drawer-accommodation-remove" data-i18n="schedule.create.accommodation.remove">' +
    escHtml(portalT('schedule.create.accommodation.remove') || 'Remove') + '</button>';
  html += '</div>';
  html += '<p class="portal-admin-muted" data-i18n="schedule.create.accommodation.serverPriced">' +
    escHtml(portalT('schedule.create.accommodation.serverPriced') || 'Price is calculated from Admin seasonal rates.') + '</p>';
  html += '</div></div>';
  html += '</section>';
  html += '<section class="portal-schedule-create-section" data-edit-section="payment" aria-labelledby="ps-drawer-section-payment-title">';
  html += '<h3 id="ps-drawer-section-payment-title" class="portal-schedule-create-section-title">' +
    escHtml(portalT('schedule.create.section.paymentNotes')) + '</h3>';
  html += scheduleRenderDrawerPaymentSelectHtml(ctx);
  html += scheduleRenderDrawerPaymentSectionEditHtml(ctx);
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-notes">' +
    escHtml(portalT('schedule.drawer.notes')) + '</label>' +
    '<textarea id="ps-drawer-notes" rows="2">' + escHtml(ctx.notes || '') + '</textarea></div>';
  html += '</section>';
  html += '</div>'; // body
  html += '<footer class="portal-schedule-create-footer portal-schedule-drawer-edit-footer">';
  html += '<div id="ps-drawer-summary" class="portal-schedule-create-summary" aria-live="polite">' +
    '<span class="portal-schedule-create-summary-placeholder">—</span></div>';
  html += '<div id="ps-drawer-quote-preview" class="portal-schedule-create-field" style="display:none" role="status" aria-live="polite"></div>';
  html += '<p id="ps-drawer-save-msg" class="state-msg" style="display:none;margin:0" role="status" aria-live="polite"></p>';
  html += '<div class="portal-schedule-create-actions">';
  html += '<button type="button" class="btn btn-ghost" id="ps-drawer-cancel">' + escHtml(portalT('schedule.drawer.cancel')) + '</button>';
  html += '<button type="button" class="btn btn-primary" id="ps-drawer-save">' + escHtml(portalT('schedule.drawer.save')) + '</button>';
  html += '</div></footer>';
  html += '</form>';
  return html;
}

function scheduleDrawerSeedRentalsFromCtx(){
  var wrap=el('ps-drawer-rentals'); if(!wrap) return [];
  var seed=[]; try{seed=JSON.parse(wrap.getAttribute('data-seed-rentals')||'[]');}catch(_e){seed=[];}
  if(Array.isArray(seed)&&seed.length) return seed.slice();
  // Prefer catalog rental_pricing; never invent board_and_suit without it.
  var ctx=scheduleDrawerState&&scheduleDrawerState.ctx, rp=ctx&&(ctx.rental_pricing||(ctx.payment&&ctx.payment.rental_pricing));
  if(rp&&rp.offering_key) return [{offering_key:String(rp.offering_key),duration_key:rp.duration||rp.duration_key||null,quantity:parseInt(rp.quantity,10)||1}];
  var board=wrap.getAttribute('data-seed-board')==='1', wet=wrap.getAttribute('data-seed-wetsuit')==='1';
  var bq=parseInt(wrap.getAttribute('data-seed-board-qty')||'1',10)||1, wq=parseInt(wrap.getAttribute('data-seed-wetsuit-qty')||'1',10)||1, out=[];
  if(board) out.push({offering_key:'board_rental',quantity:bq}); if(wet) out.push({offering_key:'wetsuit_rental',quantity:wq}); return out;
}

function scheduleDrawerDateSpan(){
  var from=el('ps-drawer-date-from')?el('ps-drawer-date-from').value:'';
  var to=el('ps-drawer-date-to')?el('ps-drawer-date-to').value:from;
  return {from:from,to:to||from};
}

/**
 * Surfer count authority for Edit:
 *  - group → #ps-drawer-course-qty
 *  - private → #ps-drawer-private-lesson-surfers
 *  - no-lesson → #ps-drawer-surfers (Create #ps-create-surfers parity)
 * Blank/invalid/fraction returns null — never silent-clamp to 1.
 */
function scheduleDrawerReadSurferCount() {
  function parseRaw(raw) {
    if (raw === '' || raw == null) return null;
    var s = String(raw).trim();
    if (!s) return null;
    // Integer digits only (reject 1.5 / 2e1 / leading junk); fail closed outside 1..99.
    if (!/^\d{1,3}$/.test(s)) return null;
    var n = parseInt(s, 10);
    if (!Number.isInteger(n) || n < 1 || n > 99) return null;
    return n;
  }
  var mode = scheduleDrawerMainActivityValue();
  if (mode === 'group') {
    var cq = el('ps-drawer-course-qty');
    return parseRaw(cq ? cq.value : '');
  }
  if (mode === 'private') {
    var ps = el('ps-drawer-private-lesson-surfers');
    return parseRaw(ps ? ps.value : '');
  }
  // Equipment only: live booking-level Surfers input (not immutable data-seed).
  var s = el('ps-drawer-surfers');
  return parseRaw(s ? s.value : '');
}

/** Force hidden no-lesson rental qty mirrors to live booking Surfers (when valid). */
function scheduleDrawerSyncRentalQtyFromSurfers() {
  var sn = scheduleDrawerReadSurferCount();
  if (sn == null) return;
  var wrap = el('ps-drawer-rentals');
  if (!wrap) return;
  var forceAll = scheduleDrawerMainActivityValue() === 'none';
  wrap.querySelectorAll('input.ps-drawer-rental-qty-input').forEach(function(inp) {
    if (forceAll || inp.getAttribute('data-qty-owner') !== 'user') {
      inp.value = String(sn);
      inp.setAttribute('data-qty-owner', 'surfers');
    }
  });
  try { wrap.setAttribute('data-seed-surfers', String(sn)); } catch (_s) { /* ignore */ }
}

function scheduleReadDrawerRentalSelectionFromDom() {
  var wrap = el('ps-drawer-rentals');
  if (!wrap) return [];
  var duration = String(wrap.getAttribute('data-duration-key') || '').trim();
  var noLesson = scheduleDrawerMainActivityValue() === 'none';
  var selection = [];
  wrap.querySelectorAll('[data-rental-offering]').forEach(function(row) {
    var key = String(row.getAttribute('data-rental-offering') || '').trim();
    var check = row.querySelector('.ps-drawer-rental-check');
    var qtyEl = row.querySelector('input.ps-drawer-rental-qty-input');
    if (!check || !check.checked || !key) return;
    // Per-item duration (Create parity) — never a shared wrap-only key.
    var durSel = row.querySelector('select.ps-drawer-rental-duration');
    var rowDuration = '';
    if (durSel && durSel.value) rowDuration = String(durSel.value).trim();
    if (!rowDuration) rowDuration = String(row.getAttribute('data-rental-duration-key') || duration).trim();
    var qty;
    if (noLesson) {
      // Equipment only: never trust independently edited equipment qty — surfer-owned only.
      var snNo = scheduleDrawerReadSurferCount();
      if (snNo == null) return;
      qty = snNo;
    } else {
      qty = parseInt(qtyEl && qtyEl.value, 10);
      if (!Number.isInteger(qty) || qty < 1) {
        var sn = scheduleDrawerReadSurferCount();
        if (sn == null) return;
        qty = sn;
      }
    }
    selection.push({ offering_key: key, duration_key: rowDuration, quantity: qty });
  });
  if (typeof scheduleSerializeRentalsSelection === 'function') {
    var genericOfferingKeys = selection.map(function(s) { return s.offering_key; });
    return scheduleSerializeRentalsSelection(selection, duration, {
      expandCombinedShort: false,
      genericOfferingKeys: genericOfferingKeys,
    });
  }
  return selection;
}

function scheduleDrawerApplyRentalExclusionUi(wrap, selectedKeys) {
  if (!wrap) return;
  var selected = selectedKeys || [];
  var bundleOn = selected.indexOf('board_and_suit_rental') >= 0;
  var separateOn = selected.indexOf('board_rental') >= 0 || selected.indexOf('wetsuit_rental') >= 0;
  // Equipment only: equipment qty owned by booking surfer count — hide independent Surfers control.
  var noLesson = scheduleDrawerMainActivityValue() === 'none';
  wrap.querySelectorAll('[data-rental-offering]').forEach(function(row) {
    var key = String(row.getAttribute('data-rental-offering') || '');
    var check = row.querySelector('.ps-drawer-rental-check');
    var qtyWrap = row.querySelector('.portal-schedule-create-rental-qty');
    var durSel = row.querySelector('select.ps-drawer-rental-duration');
    var label = row.querySelector('.portal-schedule-create-check');
    if (!check) return;
    var isOn = selected.indexOf(key) >= 0;
    check.checked = isOn;
    if (key === 'board_and_suit_rental') check.disabled = separateOn && !isOn;
    else if (key === 'board_rental' || key === 'wetsuit_rental') check.disabled = bundleOn && !isOn;
    else check.disabled = false;
    if (label) {
      if (check.disabled) label.classList.add('is-disabled');
      else label.classList.remove('is-disabled');
    }
    if (durSel) {
      durSel.disabled = !isOn || row.getAttribute('data-compatibility') === '1';
      if (isOn && durSel.value) {
        try { row.setAttribute('data-rental-duration-key', String(durSel.value).trim()); } catch (_d) { /* ignore */ }
      }
    }
    if (qtyWrap) {
      // Group/Private keep independent gear Surfers control; Equipment only never shows it.
      qtyWrap.style.display = (!noLesson && isOn) ? '' : 'none';
      try {
        qtyWrap.setAttribute('aria-hidden', (noLesson || !isOn) ? 'true' : 'false');
        if (noLesson || !isOn) qtyWrap.setAttribute('hidden', '');
        else qtyWrap.removeAttribute('hidden');
      } catch (_q) { /* ignore */ }
    }
  });
}

function scheduleDrawerIsCombinedBoardWetsuit(selectedKeys) {
  var sel = selectedKeys || [];
  if (sel.indexOf('board_and_suit_rental') >= 0) return true;
  return sel.indexOf('board_rental') >= 0 && sel.indexOf('wetsuit_rental') >= 0;
}

function scheduleWireDrawerRentals(wrap) {
  if (!wrap || wrap.dataset.rentalWired === '1') return;
  wrap.dataset.rentalWired = '1';
  wrap.addEventListener('change', function(ev) {
    var t = ev && ev.target;
    if (!t) return;
    if (t.classList && t.classList.contains('ps-drawer-rental-duration')) {
      var rowDur = t.closest ? t.closest('[data-rental-offering]') : null;
      if (rowDur) {
        try { rowDur.setAttribute('data-rental-duration-key', String(t.value || '').trim()); } catch (_rd) { /* ignore */ }
        var opt = t.options && t.selectedIndex >= 0 ? t.options[t.selectedIndex] : null;
        var cents = opt ? opt.getAttribute('data-amount-cents') : '';
        var priceEl = rowDur.querySelector('.portal-schedule-create-rental-price');
        if (priceEl && cents && typeof scheduleFormatCentsMoney === 'function') {
          priceEl.setAttribute('data-amount-cents', cents);
          priceEl.textContent = scheduleFormatCentsMoney(Number(cents));
        }
        if (cents) try { rowDur.setAttribute('data-amount-cents', cents); } catch (_ac) { /* ignore */ }
      }
      scheduleDrawerMarkPriceStale();
      scheduleDrawerSyncFooter();
      return;
    }
    if (t.classList && t.classList.contains('ps-drawer-rental-check')) {
      var key = String(t.getAttribute('data-offering-key') || '');
      var selected = [];
      wrap.querySelectorAll('.ps-drawer-rental-check').forEach(function(c) {
        if (c.checked) selected.push(String(c.getAttribute('data-offering-key') || ''));
      });
      var next = typeof scheduleApplyRentalMutualExclusion === 'function'
        ? scheduleApplyRentalMutualExclusion(selected.filter(function(k) { return k !== key; }), key, !!t.checked)
        : (t.checked ? selected.concat([key]) : selected.filter(function(k) { return k !== key; }));
      scheduleDrawerApplyRentalExclusionUi(wrap, next);
      if (t.checked) {
        var row = t.closest ? t.closest('[data-rental-offering]') : null;
        var qtyEl = row && row.querySelector('input.ps-drawer-rental-qty-input');
        var sn = scheduleDrawerReadSurferCount();
        if (qtyEl && qtyEl.getAttribute('data-qty-owner') !== 'user' && sn != null) {
          qtyEl.value = String(sn);
          qtyEl.setAttribute('data-qty-owner', 'surfers');
        }
      }
      scheduleDrawerMarkPriceStale();
      scheduleRefreshDrawerFullDayAddon();
      scheduleDrawerSyncFooter();
      return;
    }
    if (t.classList && t.classList.contains('ps-drawer-rental-qty-input')) {
      t.setAttribute('data-qty-owner', 'user');
      scheduleDrawerMarkPriceStale();
      scheduleRefreshDrawerFullDayAddon();
      scheduleDrawerSyncFooter();
    }
  });
  wrap.addEventListener('input', function(ev) {
    var t = ev && ev.target;
    if (t && t.classList && t.classList.contains('ps-drawer-rental-qty-input')) {
      t.setAttribute('data-qty-owner', 'user');
      scheduleDrawerMarkPriceStale();
      scheduleRefreshDrawerFullDayAddon();
      scheduleDrawerSyncFooter();
    }
  });
}

function scheduleRenderDrawerRentals() {
  var wrap = el('ps-drawer-rentals');
  if (!wrap) return;
  // Group/Private course gear is owned by #ps-drawer-course-equipment — hide catalog rental rows.
  var mode = typeof scheduleDrawerMainActivityValue === 'function' ? scheduleDrawerMainActivityValue() : '';
  if (mode === 'group' || mode === 'private') {
    wrap.innerHTML = '';
    wrap.style.display = 'none';
    wrap.hidden = true;
    wrap.setAttribute('aria-hidden', 'true');
    return;
  }
  wrap.style.display = '';
  wrap.hidden = false;
  wrap.setAttribute('aria-hidden', 'false');
  var prev = {};
  var prevDuration = String(wrap.getAttribute('data-duration-key') || '').trim();
  wrap.querySelectorAll('[data-rental-offering]').forEach(function(row) {
    var key = String(row.getAttribute('data-rental-offering') || '');
    var check = row.querySelector('.ps-drawer-rental-check');
    var qtyEl = row.querySelector('input.ps-drawer-rental-qty-input');
    var durSel = row.querySelector('select.ps-drawer-rental-duration');
    if (!key) return;
    var qty = parseInt(qtyEl && qtyEl.value, 10);
    var prevDur = '';
    if (durSel && durSel.value) prevDur = String(durSel.value).trim();
    if (!prevDur) prevDur = String(row.getAttribute('data-rental-duration-key') || '').trim();
    prev[key] = {
      checked: !!(check && check.checked),
      quantity: (Number.isInteger(qty) && qty >= 1) ? qty : null,
      qtyOwner: qtyEl ? String(qtyEl.getAttribute('data-qty-owner') || '') : '',
      duration_key: prevDur,
      compatibility: row.getAttribute('data-compatibility') === '1'
        || (check && check.getAttribute('data-compatibility') === '1'),
    };
  });
  if (!Object.keys(prev).length) {
    scheduleDrawerSeedRentalsFromCtx().forEach(function(r) {
      if (!r || !r.offering_key) return;
      prev[r.offering_key] = {
        checked: true,
        quantity: parseInt(r.quantity, 10) || 1,
        qtyOwner: 'surfers',
        duration_key: r.duration_key || r.duration || null,
        compatibility: false,
      };
    });
  }
  var span = scheduleDrawerDateSpan();
  var dateDuration = typeof scheduleRentalDurationKeyFromDates === 'function'
    ? scheduleRentalDurationKeyFromDates(span.from, span.to, scheduleEnumerateDates)
    : null;
  var locationId = typeof getSunsetLocation === 'function' ? getSunsetLocation() : '';
  var clientSlug = typeof getClient === 'function' ? String(getClient() || '').trim() : '';
  var prices = (typeof scheduleAdminPricesCache !== 'undefined' && scheduleAdminPricesCache) || [];
  var noLesson = scheduleDrawerMainActivityValue() === 'none';
  var duration = dateDuration || '1_day';
  var identityCatalog = (typeof scheduleRentalOfferingsCache !== 'undefined'
    && Array.isArray(scheduleRentalOfferingsCache) && scheduleRentalOfferingsCache.length)
    ? scheduleRentalOfferingsCache
    : null;
  // Create/Edit parity: same projection + per-item duration ownership.
  var offerings = (typeof scheduleProjectStandaloneRentals === 'function')
    ? scheduleProjectStandaloneRentals({
      offerings: identityCatalog,
      prices: prices,
      locationId: locationId,
      clientSlug: clientSlug,
      dateDurationKey: duration,
    })
    : ((dateDuration && typeof scheduleActiveRentalsForDuration === 'function')
      ? scheduleActiveRentalsForDuration(prices, dateDuration, locationId)
      : []);
  var catalogKeys = {};
  (offerings || []).forEach(function(o) {
    if (o && o.offering_key) catalogKeys[String(o.offering_key)] = true;
  });
  var compatibilityKeys = [];
  Object.keys(prev).forEach(function(key) {
    if (!prev[key] || !prev[key].checked) return;
    if (!catalogKeys[key]) {
      compatibilityKeys.push(key);
      offerings = offerings.concat([{
        offering_key: key,
        label: (typeof scheduleRentalOfferingDisplayLabel === 'function')
          ? scheduleRentalOfferingDisplayLabel(key, '', portalT)
          : key,
        duration_key: prev[key].duration_key || duration || prevDuration || '',
        durations: prev[key].duration_key
          ? [{ duration_key: prev[key].duration_key, amount_cents: null, label: prev[key].duration_key }]
          : [],
        _compatibility: true,
      }]);
    }
  });
  var mode = typeof scheduleRentalOfferingsMode === 'function'
    ? scheduleRentalOfferingsMode(offerings.filter(function(o) { return !o._compatibility; }))
    : (Object.keys(catalogKeys).length ? 'separate_only' : 'none');
  wrap.setAttribute('data-duration-key', duration || '');
  wrap.setAttribute('data-rental-mode', mode);
  wrap.setAttribute('data-short-rental', duration === '1_day' ? '1' : '0');
  wrap.setAttribute('data-common-short-keys', '[]');
  wrap.setAttribute('data-rental-compatibility', compatibilityKeys.length ? '1' : '0');
  if (compatibilityKeys.length) {
    try {
      wrap.setAttribute('data-compatibility-rentals', JSON.stringify(compatibilityKeys));
    } catch (_cr) { /* ignore */ }
  } else {
    try { wrap.removeAttribute('data-compatibility-rentals'); } catch (_rr) { /* ignore */ }
  }
  wrap.dataset.rentalWired = '';
  if (!offerings.length) {
    wrap.innerHTML = '<p class="portal-schedule-create-rentals-empty" data-i18n="schedule.create.noRentalsAvailable">'
      + escHtml(portalT('schedule.create.noRentalsAvailable')) + '</p>';
    return;
  }
  var surfers = scheduleDrawerReadSurferCount();
  var html = '';
  var unavailHint = portalT('schedule.create.noRentalsAvailable');
  offerings.forEach(function(o) {
    var key = o.offering_key;
    var isCompat = !!o._compatibility;
    var durs = Array.isArray(o.durations) ? o.durations.slice() : [];
    var was = prev[key] || {};
    var checked = !!was.checked || isCompat;
    var rowDuration = String(was.duration_key || o.duration_key
      || (durs[0] && durs[0].duration_key) || duration || '').trim();
    if (durs.length && !durs.some(function(d) { return d.duration_key === rowDuration; })) {
      if (was.duration_key) {
        durs = [{
          duration_key: was.duration_key,
          amount_cents: null,
          label: was.duration_key,
        }].concat(durs);
        rowDuration = was.duration_key;
      } else if (durs[0]) {
        rowDuration = durs[0].duration_key;
      }
    }
    var offeringLabel = (typeof scheduleRentalOfferingDisplayLabel === 'function')
      ? scheduleRentalOfferingDisplayLabel(key, o.label, portalT)
      : (String(o.label || '').trim() || key);
    if (isCompat) offeringLabel = offeringLabel + ' (' + unavailHint + ')';
    var qty;
    var owner;
    if (noLesson) {
      qty = surfers != null ? surfers : 1;
      owner = 'surfers';
    } else {
      qty = (was.quantity != null && was.quantity >= 1)
        ? was.quantity
        : (surfers != null ? surfers : 1);
      if (!checked) qty = surfers != null ? surfers : 1;
      owner = (checked && was.quantity != null && was.qtyOwner === 'user') ? 'user' : 'surfers';
    }
    var qtyHtml = '';
    if (!noLesson) {
      qtyHtml = '<div class="portal-schedule-create-rental-qty"' + (checked ? '' : ' style="display:none"') + '>'
        + '<label><span data-i18n="schedule.create.rentalQty">'
        + escHtml(portalT('schedule.create.rentalQty') || 'Surfers') + '</span>'
        + '<input type="number" min="1" max="99" class="ps-drawer-rental-qty-input" data-qty-owner="'
        + escHtml(owner) + '" value="' + escHtml(String(qty)) + '"></label>'
        + '</div>';
    } else {
      qtyHtml = '<div class="portal-schedule-create-rental-qty" style="display:none" hidden aria-hidden="true">'
        + '<input type="number" min="1" max="99" class="ps-drawer-rental-qty-input" data-qty-owner="surfers" tabindex="-1" value="'
        + escHtml(String(qty)) + '"></div>';
    }
    var selectedDur = null;
    for (var di = 0; di < durs.length; di++) {
      if (durs[di].duration_key === rowDuration) { selectedDur = durs[di]; break; }
    }
    if (!selectedDur) selectedDur = durs[0] || null;
    var unitCents = selectedDur && selectedDur.amount_cents != null ? selectedDur.amount_cents : null;
    var priceHtml = (unitCents != null && typeof scheduleFormatCentsMoney === 'function')
      ? ('<span class="portal-schedule-create-rental-price" data-amount-cents="' + escHtml(String(unitCents)) + '">'
        + escHtml(scheduleFormatCentsMoney(unitCents)) + '</span>')
      : '';
    var durationHtml = '';
    if (durs.length && !isCompat) {
      durationHtml = '<label class="portal-schedule-create-rental-duration-label">'
        + '<span class="portal-visually-hidden" data-i18n="schedule.create.rentalDuration">Duration</span>'
        + '<select class="ps-drawer-rental-duration" data-rental-duration-select'
        + (checked ? '' : ' disabled') + '>';
      durs.forEach(function(d) {
        var dLab = String(d.label || d.duration_key);
        var euro = (d.amount_cents != null && typeof scheduleFormatCentsMoney === 'function')
          ? (' — ' + scheduleFormatCentsMoney(d.amount_cents)) : '';
        durationHtml += '<option value="' + escHtml(d.duration_key) + '" data-amount-cents="'
          + escHtml(String(d.amount_cents == null ? '' : d.amount_cents)) + '"'
          + (d.duration_key === rowDuration ? ' selected' : '') + '>'
          + escHtml(dLab + euro) + '</option>';
      });
      durationHtml += '</select></label>';
    } else if (isCompat && rowDuration) {
      durationHtml = '<span class="portal-schedule-drawer-rental-unavailable-duration">'
        + escHtml(rowDuration) + '</span>';
    }
    html += '<div class="portal-schedule-create-rental-row'
      + (isCompat ? ' is-unavailable' : '') + '" data-rental-offering="' + escHtml(key) + '"'
      + ' data-rental-duration-key="' + escHtml(rowDuration) + '"'
      + ' data-eligible="' + (isCompat ? '0' : '1') + '"'
      + (isCompat ? ' data-compatibility="1"' : '')
      + (unitCents != null ? (' data-amount-cents="' + escHtml(String(unitCents)) + '"') : '') + '>'
      + '<label class="portal-schedule-create-check"><input type="checkbox" class="ps-drawer-rental-check" data-offering-key="'
      + escHtml(key) + '"' + (checked ? ' checked' : '')
      + ' data-eligible="' + (isCompat ? '0' : '1') + '"'
      + (isCompat ? ' data-compatibility="1"' : '')
      + '> <span>' + escHtml(offeringLabel) + '</span></label>'
      + durationHtml + priceHtml + qtyHtml + '</div>';
  });
  wrap.innerHTML = html;
  var selected = [];
  offerings.forEach(function(o) {
    if (prev[o.offering_key] && prev[o.offering_key].checked) selected.push(o.offering_key);
    else if (o._compatibility) selected.push(o.offering_key);
  });
  if (selected.indexOf('board_and_suit_rental') >= 0
    && (selected.indexOf('board_rental') >= 0 || selected.indexOf('wetsuit_rental') >= 0)) {
    selected = typeof scheduleApplyRentalMutualExclusion === 'function'
      ? scheduleApplyRentalMutualExclusion(selected, 'board_and_suit_rental', true)
      : ['board_and_suit_rental'];
  }
  scheduleDrawerApplyRentalExclusionUi(wrap, selected);
  scheduleWireDrawerRentals(wrap);
}


function scheduleDrawerPopulateComponentFields() {
  var mode = scheduleDrawerMainActivityValue();
  var courseOn = mode === 'group';
  var privateOn = mode === 'private';
  var noLesson = mode === 'none';
  var cf = el('ps-drawer-course-fields');
  var cq = el('ps-drawer-course-qty-wrap');
  var pf = el('ps-drawer-private-lesson-fields');
  var courseSection = el('ps-drawer-course-section');
  var durationConfirm = el('ps-drawer-course-duration-confirm');
  var privateWhen = el('ps-drawer-private-when');
  var privatePanel = el('ps-drawer-private-panel');
  var surfersField = el('ps-drawer-surfers-field');
  // Legacy course select stays hidden — drill-down owns visible course pick.
  if (cf) scheduleDrawerSetVisible(cf, false);
  if (cq) cq.style.display = courseOn ? '' : 'none';
  if (pf) pf.style.display = privateOn ? '' : 'none';
  if (courseSection) courseSection.style.display = (courseOn || privateOn) ? '' : 'none';
  if (durationConfirm) durationConfirm.style.display = courseOn ? '' : 'none';
  // Private sessions live in main-activity drill-down panel.
  if (scheduleDrawerIsPrivateSessionsDrilldown() || privateOn) {
    if (privatePanel) scheduleDrawerSetVisible(privatePanel, true);
    if (privateWhen) scheduleDrawerSetVisible(privateWhen, true);
  } else {
    if (privatePanel) scheduleDrawerSetVisible(privatePanel, false);
    if (privateWhen) scheduleDrawerSetVisible(privateWhen, false);
  }
  // Booking-level Surfers is the no-lesson authority only — hide when group/private own theirs.
  if (surfersField) {
    surfersField.style.display = noLesson ? '' : 'none';
    try {
      if (noLesson) {
        surfersField.removeAttribute('hidden');
        surfersField.setAttribute('aria-hidden', 'false');
      } else {
        surfersField.setAttribute('hidden', '');
        surfersField.setAttribute('aria-hidden', 'true');
      }
    } catch (_sf) { /* ignore */ }
  }
  var dateRange = el('ps-drawer-date-range');
  if (dateRange) dateRange.style.display = '';
  if (typeof scheduleSyncDrawerMainActivityButtons === 'function') scheduleSyncDrawerMainActivityButtons();
  if (typeof scheduleSyncDrawerDateRangeUi === 'function') scheduleSyncDrawerDateRangeUi();
  if (privateOn) scheduleDrawerSyncPrivateSessions();
  if (courseOn) {
    scheduleDrawerPopulateCourseSelect();
    scheduleDrawerRefreshDurationConfirm();
  }
  scheduleRenderDrawerRentals();
  scheduleRefreshDrawerFullDayAddon();
  scheduleDrawerRefreshWhenSummary();
  scheduleDrawerSyncFooter();
}

function scheduleDrawerRefreshDurationConfirm(){
  var box=el('ps-drawer-course-duration-confirm'); if(!box) return;
  if(scheduleDrawerMainActivityValue()!=='group'){ box.innerHTML=''; box.style.display='none'; return; }
  box.style.display='';
  var courseSel=el('ps-drawer-course-select'), courseId=courseSel?String(courseSel.value||'').trim():'', span=scheduleDrawerDateSpan();
  var derived=typeof schedulePortalResolveDerivedCourseTier==='function'
    ? schedulePortalResolveDerivedCourseTier(courseId,span.from,span.to)
    : {ok:false,errorKey:'schedule.create.courseDurationUnavailable'};
  if(!derived||!derived.ok){
    box.innerHTML='<p class="portal-schedule-drawer-hint" style="margin:0;color:var(--danger,#b33)">'+escHtml(portalT((derived&&derived.errorKey)||'schedule.create.courseDurationUnavailable'))+'</p>';
    return;
  }
  var lab=derived.tier_label||(typeof schedulePortalDurationLabel==='function'?schedulePortalDurationLabel(derived.tier_key):'')||derived.tier_key;
  box.innerHTML='<p class="portal-schedule-drawer-hint portal-schedule-drawer-duration-ok" style="margin:0">'+escHtml(portalT('schedule.drawer.durationConfirm')+': '+lab)+'</p>';
}

function scheduleDrawerRefreshWhenSummary(){
  var box=el('ps-drawer-when-summary'); if(!box) return;
  if(scheduleDrawerMainActivityValue()==='private'){ box.innerHTML=''; box.style.display='none'; return; }
  box.style.display='';
  var span=scheduleDrawerDateSpan(), df=span.from?String(span.from).slice(0,10):'', dt=span.to?String(span.to).slice(0,10):df;
  if(!df){ box.innerHTML='<p class="portal-schedule-drawer-hint" style="margin:0">'+escHtml(portalT('schedule.drawer.whenPickDates'))+'</p>'; return; }
  var days=typeof schedulePortalInclusiveDateCount==='function'?schedulePortalInclusiveDateCount(df,dt):0;
  var range=df===dt?df:(df+'\u2013'+dt);
  var dayWord=days===1?portalT('schedule.drawer.dayWordCap'):portalT('schedule.drawer.daysWordCap');
  box.innerHTML='<p class="portal-schedule-drawer-hint" style="margin:0">'+escHtml(portalT('schedule.drawer.whenRange')+': '+range+(days>0?(' · '+days+' '+dayWord):''))+'</p>';
}

function scheduleRefreshDrawerFullDayAddon() {
  var field = el('ps-drawer-course-equipment');
  if (!field) return;
  var mode = scheduleDrawerMainActivityValue();
  var selectedCourseIds = [];
  if (typeof scheduleDrawerGetSelectedCourseIds === 'function') {
    selectedCourseIds = scheduleDrawerGetSelectedCourseIds().slice();
  } else if (typeof scheduleDrawerGetSelectedCourseId === 'function') {
    var oneId = String(scheduleDrawerGetSelectedCourseId() || '').trim();
    if (oneId) selectedCourseIds = [oneId];
  } else {
    var dsel = el('ps-drawer-course-select');
    var oneSel = dsel ? String(dsel.value || '').trim() : '';
    if (oneSel) selectedCourseIds = [oneSel];
  }
  var selectedCourseId = selectedCourseIds.length ? selectedCourseIds[0] : '';
  // Stage 3B Group equipment is catalog-owned + historical unavailable/removable.
  // Multi-course product set: only offerings authorized by EVERY selected course.
  if (mode === 'group') {
    var options = [];
    var lessonCourseIds = selectedCourseIds.slice();
    if (!lessonCourseIds.length && selectedCourseId) lessonCourseIds = [selectedCourseId];
    if (lessonCourseIds.length > 1) {
      var optionMaps = [];
      lessonCourseIds.forEach(function(cid) {
        var map = {};
        (scheduleCoursesCache || []).forEach(function(course) {
          if (String(course && course.course_id || '') !== cid) return;
          (Array.isArray(course.equipment_options) ? course.equipment_options : []).forEach(function(opt) {
            var k = String(opt && opt.offering_key || '').trim();
            if (k) map[k] = opt;
          });
        });
        optionMaps.push(map);
      });
      if (optionMaps.length) {
        Object.keys(optionMaps[0]).forEach(function(k) {
          if (optionMaps.every(function(m) { return !!m[k]; })) {
            options.push(optionMaps[0][k]);
          }
        });
      }
    } else {
      (scheduleCoursesCache || []).some(function(course) {
        if (String(course && course.course_id || '') !== String(lessonCourseIds[0] || selectedCourseId || '')) return false;
        options = Array.isArray(course.equipment_options) ? course.equipment_options : [];
        return true;
      });
    }
    var seedG = [];
    try { seedG = JSON.parse(field.getAttribute('data-seed') || '[]'); } catch (_ge) { seedG = []; }
    if (!Array.isArray(seedG)) seedG = seedG && seedG.mode ? [seedG] : [];
    var state = {};
    var knownHistoricalG = {};
    field.querySelectorAll('.portal-schedule-course-equipment-item').forEach(function(item) {
      var key = item.getAttribute('data-offering-key');
      if (key == null) key = '';
      var check = item.querySelector('[data-course-equipment-enabled]');
      var pressed = item.querySelector('[data-drawer-course-equipment-mode][aria-pressed="true"]');
      var qty = item.querySelector('[data-course-equipment-quantity]');
      var unavailable = item.classList.contains('is-unavailable');
      if (unavailable) {
        knownHistoricalG[key] = {
          offering_key: key,
          label: (item.querySelector('.portal-schedule-course-equipment-name') || {}).textContent || '',
        };
      }
      if (check && check.checked) {
        state[key] = {
          mode: pressed ? pressed.getAttribute('data-drawer-course-equipment-mode') : 'during_course',
          quantity: parseInt(qty && qty.value, 10) || 1,
          label: (item.querySelector('.portal-schedule-course-equipment-name') || {}).textContent || '',
        };
      }
    });
    if (!field.children.length) {
      seedG.forEach(function(s) {
        if (s && s.offering_key) state[String(s.offering_key)] = s;
      });
    }
    var configuredKeysG = {};
    options.forEach(function(option) {
      var k = String(option && option.offering_key || '').trim();
      if (k) configuredKeysG[k] = true;
    });
    var historicalG = [];
    var seenHistoricalG = {};
    function pushHistoricalG(s) {
      if (!s) return;
      var k = s.offering_key != null ? String(s.offering_key) : '';
      if (!k || configuredKeysG[k] || seenHistoricalG[k]) return;
      seenHistoricalG[k] = true;
      historicalG.push(s);
    }
    seedG.forEach(pushHistoricalG);
    Object.keys(knownHistoricalG).forEach(function(k) { pushHistoricalG(knownHistoricalG[k]); });
    var showGroup = (lessonCourseIds.length > 0 || !!selectedCourseId)
      && (options.length > 0 || historicalG.length > 0);
    field.style.display = showGroup ? '' : 'none'; field.hidden = !showGroup;
    if (!showGroup) { field.innerHTML = ''; return; }
    var maxQty = scheduleDrawerReadSurferCount() || 1;
    var unavailLabelG = portalT('schedule.courseEquipment.unavailable')
      || portalT('admin.courseEquipment.unavailable') || 'Unavailable';
    function renderGroupEquipmentItem(option, selected, flags) {
      flags = flags || {};
      var key = String(option.offering_key != null ? option.offering_key : '');
      var unavailable = !!flags.unavailable;
      var checked = !!selected;
      var eqMode = selected && selected.mode === 'all_day' ? 'all_day' : 'during_course';
      // During Course always tracks participant count; All Day keeps explicit set qty.
      var qty = eqMode === 'all_day'
        ? Math.max(1, Math.min(maxQty, parseInt(selected && selected.quantity, 10) || maxQty))
        : maxQty;
      var name = String((option && option.label) || (selected && selected.label) || key || unavailLabelG);
      var disabled = unavailable && !checked;
      return '<div class="portal-schedule-course-equipment-item' + (unavailable ? ' is-unavailable' : '') +
        '" data-offering-key="' + escHtml(key) + '">' +
        '<div class="portal-schedule-course-equipment-row"><div class="portal-schedule-course-equipment-left">' +
        '<label class="portal-schedule-course-equipment-check" aria-label="' + escHtml(name) + '">' +
        '<input type="checkbox" data-course-equipment-enabled' + (checked ? ' checked' : '') +
        (disabled ? ' disabled' : '') + '></label>' +
        '<span class="portal-schedule-course-equipment-name">' + escHtml(name) + '</span></div>' +
        '<div class="portal-schedule-course-equipment-modes" role="group" aria-label="' +
        escHtml(portalT('schedule.courseEquipment.title') + ': ' + name) + '"' +
        (checked ? '' : ' hidden style="display:none"') + '>' +
        '<button type="button" class="portal-schedule-create-activity-btn" data-drawer-course-equipment-mode="during_course" aria-pressed="' +
        (checked && eqMode === 'during_course' ? 'true' : 'false') + '">' +
        escHtml(portalT('schedule.courseEquipment.during')) + '</button>' +
        '<button type="button" class="portal-schedule-create-activity-btn" data-drawer-course-equipment-mode="all_day" aria-pressed="' +
        (checked && eqMode === 'all_day' ? 'true' : 'false') + '">' +
        escHtml(portalT('schedule.courseEquipment.allDay')) + '</button></div>' +
        '<div class="portal-schedule-course-equipment-sets"' +
        (checked && eqMode === 'all_day' ? '' : ' hidden style="display:none"') + '>' +
        '<label><span class="portal-schedule-course-equipment-qty-label">' +
        escHtml(portalT('schedule.courseEquipment.quantity')) + '</span>' +
        '<input type="number" min="1" max="' + escHtml(String(maxQty)) + '" value="' +
        escHtml(String(qty)) + '" data-course-equipment-quantity inputmode="numeric"></label></div></div></div>';
    }
    var htmlG = options.map(function(option) {
      var key = String(option.offering_key || '');
      return renderGroupEquipmentItem(option, state[key] || null, {});
    }).join('');
    historicalG.forEach(function(s) {
      var k = s && s.offering_key != null ? String(s.offering_key) : '';
      var selected = Object.prototype.hasOwnProperty.call(state, k) ? state[k] : null;
      var label = (selected && selected.label) || (s && s.label) || '';
      htmlG += renderGroupEquipmentItem(
        { offering_key: k, label: label },
        selected,
        { unavailable: true },
      );
    });
    field.innerHTML = htmlG;
    return;
  }
  // Private multi-item equipment: catalog-owned options + historical unavailable/removable rows.
  if (mode === 'private') {
    var privateOptions = (typeof schedulePrivateEquipmentOptionsCache !== 'undefined'
      && Array.isArray(schedulePrivateEquipmentOptionsCache))
      ? schedulePrivateEquipmentOptionsCache : [];
    var seedRows = [];
    try { seedRows = JSON.parse(field.getAttribute('data-seed') || '[]'); } catch (_ps) { seedRows = []; }
    if (!Array.isArray(seedRows)) seedRows = seedRows && seedRows.mode ? [seedRows] : [];
    var stateP = {};
    var knownHistorical = {};
    field.querySelectorAll('.portal-schedule-course-equipment-item').forEach(function(item) {
      var key = item.getAttribute('data-offering-key');
      if (key == null) key = '';
      var stateKey = key === '' ? '__empty__' : key;
      var check = item.querySelector('[data-course-equipment-enabled]');
      var pressed = item.querySelector('[data-drawer-course-equipment-mode][aria-pressed="true"]');
      var qtyNode = item.querySelector('[data-course-equipment-quantity]');
      var unavailable = item.classList.contains('is-unavailable') || item.getAttribute('data-legacy-empty') === '1';
      if (unavailable) knownHistorical[stateKey] = {
        offering_key: key,
        label: (item.querySelector('.portal-schedule-course-equipment-name') || {}).textContent || '',
      };
      if (check && check.checked) {
        stateP[stateKey] = {
          offering_key: key,
          mode: pressed ? pressed.getAttribute('data-drawer-course-equipment-mode') : 'during_course',
          quantity: parseInt(qtyNode && qtyNode.value, 10) || 1,
          label: (item.querySelector('.portal-schedule-course-equipment-name') || {}).textContent || '',
        };
      }
    });
    if (!field.children.length) {
      seedRows.forEach(function(s) {
        if (!s) return;
        var k = s.offering_key != null ? String(s.offering_key) : '';
        stateP[k === '' ? '__empty__' : k] = s;
      });
    }
    var configuredKeys = {};
    privateOptions.forEach(function(option) {
      var k = String(option && option.offering_key || '').trim();
      if (k) configuredKeys[k] = true;
    });
    var historical = [];
    var seenHistorical = {};
    function pushHistorical(s) {
      if (!s) return;
      var k = s.offering_key != null ? String(s.offering_key) : '';
      var stateKey = k === '' ? '__empty__' : k;
      if (k && configuredKeys[k]) return;
      if (seenHistorical[stateKey]) return;
      seenHistorical[stateKey] = true;
      historical.push(s);
    }
    seedRows.forEach(pushHistorical);
    Object.keys(knownHistorical).forEach(function(stateKey) { pushHistorical(knownHistorical[stateKey]); });
    var showPrivate = privateOptions.length > 0 || historical.length > 0;
    field.style.display = showPrivate ? '' : 'none';
    field.hidden = !showPrivate;
    field.classList.remove('is-off');
    if (!showPrivate) { field.innerHTML = ''; return; }
    var maxQtyP = scheduleDrawerReadSurferCount() || 1;
    var unavailLabel = portalT('schedule.courseEquipment.unavailable')
      || portalT('admin.courseEquipment.unavailable') || 'Unavailable';
    function renderPrivateEquipmentItem(option, selected, flags) {
      flags = flags || {};
      var key = String(option.offering_key != null ? option.offering_key : '');
      var unavailable = !!flags.unavailable;
      var legacyEmpty = !!flags.legacyEmpty || key === '';
      var checked = !!selected;
      var eqMode = selected && selected.mode === 'all_day' ? 'all_day' : 'during_course';
      var qty = Math.max(1, Math.min(maxQtyP, parseInt(selected && selected.quantity, 10) || maxQtyP));
      var name = String((option && option.label) || (selected && selected.label) || key || unavailLabel);
      // Never invent money labels for historical/empty rows — display-only name.
      var disabled = unavailable && !checked;
      return '<div class="portal-schedule-course-equipment-item' + (unavailable ? ' is-unavailable' : '') +
        '" data-offering-key="' + escHtml(key) + '"' +
        (legacyEmpty ? ' data-legacy-empty="1"' : '') +
        '><div class="portal-schedule-course-equipment-row"><div class="portal-schedule-course-equipment-left">' +
        '<label class="portal-schedule-course-equipment-check" aria-label="' + escHtml(name) + '">' +
        '<input type="checkbox" data-course-equipment-enabled' + (checked ? ' checked' : '') +
        (disabled ? ' disabled' : '') + '></label>' +
        '<span class="portal-schedule-course-equipment-name">' + escHtml(name) + '</span></div>' +
        '<div class="portal-schedule-course-equipment-modes" role="group" aria-label="' +
        escHtml(portalT('schedule.courseEquipment.title') + ': ' + name) + '"' +
        (checked ? '' : ' hidden style="display:none"') + '>' +
        '<button type="button" class="portal-schedule-create-activity-btn" data-drawer-course-equipment-mode="during_course" aria-pressed="' +
        (checked && eqMode === 'during_course' ? 'true' : 'false') + '">' +
        escHtml(portalT('schedule.courseEquipment.during')) + '</button>' +
        '<button type="button" class="portal-schedule-create-activity-btn" data-drawer-course-equipment-mode="all_day" aria-pressed="' +
        (checked && eqMode === 'all_day' ? 'true' : 'false') + '">' +
        escHtml(portalT('schedule.courseEquipment.allDay')) + '</button></div>' +
        '<div class="portal-schedule-course-equipment-sets"' +
        (checked && eqMode === 'all_day' ? '' : ' hidden style="display:none"') + '>' +
        '<label><span class="portal-schedule-course-equipment-qty-label">' +
        escHtml(portalT('schedule.courseEquipment.quantity')) + '</span>' +
        '<input type="number" min="1" max="' + escHtml(String(maxQtyP)) + '" value="' +
        escHtml(String(qty)) + '" data-course-equipment-quantity inputmode="numeric"></label></div></div></div>';
    }
    var htmlP = privateOptions.map(function(option) {
      var key = String(option.offering_key || '');
      return renderPrivateEquipmentItem(option, stateP[key] || null, {});
    }).join('');
    historical.forEach(function(s) {
      var k = s && s.offering_key != null ? String(s.offering_key) : '';
      var stateKey = k === '' ? '__empty__' : k;
      // Only keep selected when still checked in state — deselected historical stays removable-disabled.
      var selected = Object.prototype.hasOwnProperty.call(stateP, stateKey) ? stateP[stateKey] : null;
      var label = (selected && selected.label) || (s && s.label) || '';
      htmlP += renderPrivateEquipmentItem(
        { offering_key: k, label: label },
        selected,
        { unavailable: true, legacyEmpty: k === '' }
      );
    });
    field.innerHTML = htmlP;
    return;
  }
  // No group/private activity — hide equipment owner entirely.
  field.style.display = 'none';
  field.hidden = true;
  field.innerHTML = '';
  field.classList.remove('is-off');
}

function scheduleUpdateDrawerTotalPreview(){
  scheduleUpdateFullDayAddonSummary('ps-drawer-fullday-rows','ps-drawer-fullday-summary');
  scheduleDrawerSyncFooter();
}

function scheduleDrawerOnComponentChange(changedId){
  var course = el('ps-drawer-comp-course');
  var privateLesson = el('ps-drawer-comp-private-lesson');
  var noLesson = el('ps-drawer-comp-no-lesson');
  if (changedId === 'ps-drawer-comp-course' && course && course.checked) {
    if (privateLesson) privateLesson.checked = false;
    if (noLesson) noLesson.checked = false;
    if (typeof scheduleDrawerEnterGroupCourseDrilldown === 'function') {
      scheduleDrawerEnterGroupCourseDrilldown();
    } else {
      scheduleDrawerSetMainActivity('group');
    }
  } else if (changedId === 'ps-drawer-comp-private-lesson' && privateLesson && privateLesson.checked) {
    if (course) course.checked = false;
    if (noLesson) noLesson.checked = false;
    if (typeof scheduleDrawerEnterPrivateSessionsDrilldown === 'function') {
      scheduleDrawerEnterPrivateSessionsDrilldown();
    } else {
      scheduleDrawerSetMainActivity('private');
    }
  } else if (changedId === 'ps-drawer-comp-no-lesson' && noLesson && noLesson.checked) {
    if (course) course.checked = false;
    if (privateLesson) privateLesson.checked = false;
    if (typeof scheduleDrawerExitMainActivityDrilldown === 'function') {
      scheduleDrawerExitMainActivityDrilldown({ clearCourse: true, clearPrivate: true });
    } else {
      scheduleDrawerSetMainActivity('none');
    }
  } else {
    if (changedId === 'ps-drawer-comp-course') scheduleDrawerSetMainActivity('group');
    else if (changedId === 'ps-drawer-comp-private-lesson') scheduleDrawerSetMainActivity('private');
    else if (changedId === 'ps-drawer-comp-no-lesson') scheduleDrawerSetMainActivity('none');
  }
  if (typeof scheduleSyncDrawerMainActivityButtons === 'function') scheduleSyncDrawerMainActivityButtons();
  scheduleDrawerMarkPriceStale();
  scheduleDrawerPopulateComponentFields();
}

function scheduleDrawerPopulateCourseSelect() {
  var sel = el('ps-drawer-course-select');
  if (!sel) return Promise.resolve();
  var selectedIds = [];
  try {
    var multiSeed = sel.getAttribute('data-selected-courses') || '';
    if (multiSeed) {
      try {
        var parsed = JSON.parse(multiSeed);
        if (Array.isArray(parsed)) {
          parsed.forEach(function(v) {
            var id = String(v || '').trim();
            if (id && selectedIds.indexOf(id) < 0) selectedIds.push(id);
          });
        }
      } catch (_j) {
        multiSeed.split(',').forEach(function(v) {
          var id = String(v || '').trim();
          if (id && selectedIds.indexOf(id) < 0) selectedIds.push(id);
        });
      }
    }
  } catch (_m) { /* ignore */ }
  if (!selectedIds.length) {
    var one = String(sel.getAttribute('data-selected') || sel.value || '').trim();
    if (one) selectedIds = [one];
  }
  if (!selectedIds.length && typeof scheduleDrawerGetSelectedCourseIds === 'function') {
    selectedIds = scheduleDrawerGetSelectedCourseIds().slice();
  }
  var openGen = scheduleDrawerState && scheduleDrawerState.openGen;
  var mountGen = scheduleDrawerState && scheduleDrawerState.mountGen;
  var bookingKey = (typeof scheduleDrawerBookingKey === 'function' && scheduleDrawerState)
    ? scheduleDrawerBookingKey(scheduleDrawerState.row)
    : (scheduleDrawerState && scheduleDrawerState.activeBookingKey) || null;
  return scheduleFetchLessonTimesConfig(getClient()).then(function() {
    if (typeof scheduleDrawerIsRequestActive === 'function'
      && !scheduleDrawerIsRequestActive(openGen, bookingKey)) return sel;
    if (scheduleDrawerState && mountGen != null
      && scheduleDrawerState.mountGen !== mountGen) return sel;
    var courses = scheduleCoursesCache || [];
    // Prefer drill-down course list (Create parity); keep hidden select synchronized.
    if (typeof scheduleDrawerRenderCourseList === 'function'
      && (scheduleDrawerIsGroupCourseDrilldown() || scheduleDrawerMainActivityValue() === 'group')) {
      scheduleDrawerRenderCourseList(courses, { selectedIds: selectedIds });
    } else {
      var html = '';
      courses.forEach(function(c) {
        var id = String(c.course_id || '').trim();
        if (!id) return;
        html += '<option value="' + escHtml(id) + '" data-label="' + escHtml(c.label || id) + '">' +
          escHtml(c.label || id) + '</option>';
      });
      if (!html) html = '<option value="">' + escHtml(portalT('schedule.courses.noneConfigured')) + '</option>';
      sel.innerHTML = html;
      try { sel.multiple = true; } catch (_sm) { /* ignore */ }
      if (selectedIds.length) {
        try { sel.setAttribute('data-selected', selectedIds[0]); } catch (_s) { /* ignore */ }
        try { sel.setAttribute('data-selected-courses', JSON.stringify(selectedIds)); } catch (_s2) { /* ignore */ }
        sel.value = selectedIds[0];
      }
    }
    if (!sel._editBound) {
      sel._editBound = true;
      sel.addEventListener('change', function() {
        try { sel.removeAttribute('data-compatibility-unavailable'); } catch (_c) { /* ignore */ }
        var next = [];
        try {
          if (sel.multiple && sel.selectedOptions) {
            Array.prototype.forEach.call(sel.selectedOptions, function(opt) {
              var id = String(opt.value || '').trim();
              if (id) next.push(id);
            });
          } else if (sel.value) {
            next = [String(sel.value).trim()];
          }
        } catch (_n) {
          if (sel.value) next = [String(sel.value).trim()];
        }
        scheduleDrawerMarkPriceStale();
        if (typeof scheduleDrawerSyncCourseButtons === 'function') {
          scheduleDrawerSyncCourseButtons(next);
        }
        if (typeof scheduleDrawerRenderMainActivityPath === 'function') {
          scheduleDrawerRenderMainActivityPath();
        }
        scheduleDrawerRefreshDurationConfirm();
        scheduleDrawerSyncFooter();
      });
    }
    scheduleDrawerRefreshDurationConfirm();
    return sel;
  });
}

function scheduleDrawerReadPrivateSessionsFromDom() {
  var wrap = el('ps-drawer-private-sessions');
  var out = [];
  if (!wrap) return out;
  wrap.querySelectorAll('.portal-schedule-private-session-row').forEach(function(row) {
    var dateAttr = row.getAttribute('data-session-date') || '';
    var d = row.querySelector('.ps-pl-session-date');
    var s = row.querySelector('.ps-pl-session-start');
    var e = row.querySelector('.ps-pl-session-end');
    var dateVal = (d && d.value) ? String(d.value).slice(0, 10) : (dateAttr || '');
    out.push({
      date: dateVal,
      start: s ? s.value : '',
      end: e ? e.value : '',
    });
  });
  return out;
}

function scheduleDrawerDefaultPrivateSessionTimes(start, end) {
  var s = start != null ? String(start) : '';
  var e = end != null ? String(end) : '';
  if (!s && !e) return { start: '10:00', end: '12:00' };
  if (s && !e && typeof schedulePrivateLessonDefaultEnd === 'function') {
    return { start: s, end: schedulePrivateLessonDefaultEnd(s) || '12:00' };
  }
  return { start: s || '10:00', end: e || '12:00' };
}

function scheduleDrawerAppendPrivateSessionRow(seed) {
  var wrap = el('ps-drawer-private-sessions');
  if (!wrap) return;
  seed = seed || {};
  var span = scheduleDrawerDateSpan();
  var date = seed.date || span.from || '';
  var times = scheduleDrawerDefaultPrivateSessionTimes(seed.start, seed.end);
  var row = document.createElement('div');
  row.className = 'portal-schedule-private-session-row';
  row.setAttribute('data-session-date', date);
  row.innerHTML = ''
    + '<div class="portal-schedule-create-field"><label>'
    + escHtml(portalT('schedule.create.date') || 'Date') + '</label>'
    + '<input type="date" class="ps-pl-session-date" value="' + escHtml(date) + '"></div>'
    + '<div class="portal-schedule-private-session-grid">'
    + '<label><span>' + escHtml(portalT('schedule.create.privateLesson.start')) + '</span>'
    + '<input class="ps-pl-session-start" type="time" value="' + escHtml(times.start) + '"></label>'
    + '<label><span>' + escHtml(portalT('schedule.create.privateLesson.end')) + '</span>'
    + '<input class="ps-pl-session-end" type="time" value="' + escHtml(times.end) + '"></label>'
    + '</div>'
    + '<button type="button" class="btn btn-ghost portal-schedule-group-lesson-remove" data-private-session-remove aria-label="Remove session">\u2212</button>';
  wrap.appendChild(row);
  var dateEl = row.querySelector('.ps-pl-session-date');
  if (dateEl) {
    dateEl.addEventListener('change', function() {
      row.setAttribute('data-session-date', String(dateEl.value || '').slice(0, 10));
      scheduleDrawerMarkPriceStale();
      scheduleRefreshDrawerFullDayAddon();
      scheduleDrawerSyncFooter();
    });
  }
  var startEl = row.querySelector('.ps-pl-session-start');
  var endEl = row.querySelector('.ps-pl-session-end');
  if (startEl) {
    startEl.addEventListener('change', function() {
      if (endEl && (!endEl.value || endEl.value === schedulePrivateLessonDefaultEnd(startEl.defaultValue || ''))) {
        if (typeof schedulePrivateLessonDefaultEnd === 'function') {
          endEl.value = schedulePrivateLessonDefaultEnd(startEl.value) || endEl.value;
        }
      }
      startEl.defaultValue = startEl.value;
      scheduleDrawerMarkPriceStale();
      scheduleRefreshDrawerFullDayAddon();
      scheduleDrawerSyncFooter();
    });
  }
  if (endEl) {
    endEl.addEventListener('change', function() {
      scheduleDrawerMarkPriceStale();
      scheduleRefreshDrawerFullDayAddon();
      scheduleDrawerSyncFooter();
    });
  }
  var rem = row.querySelector('[data-private-session-remove]');
  if (rem) {
    rem.addEventListener('click', function() {
      if (wrap.querySelectorAll('.portal-schedule-private-session-row').length <= 1) return;
      row.remove();
      scheduleDrawerMarkPriceStale();
      scheduleRefreshDrawerFullDayAddon();
      scheduleDrawerSyncFooter();
    });
  }
}

/**
 * Free multi private sessions for Edit.
 * Preserves same-day multi from readback lessons[] / sessions; supports add/remove.
 * Does NOT unique-date collapse — two sessions on the same day stay two rows.
 */
function scheduleDrawerSyncPrivateSessions(opts) {
  opts = opts || {};
  var wrap = el('ps-drawer-private-sessions');
  if (!wrap) return;
  if (scheduleDrawerMainActivityValue() !== 'private') {
    wrap.innerHTML = '';
    return;
  }
  // Keep existing free rows once staff has edited (skipCtxSeed / re-entry).
  if (wrap.querySelector('.portal-schedule-private-session-row') && opts.skipCtxSeed) return;
  if (wrap.querySelector('.portal-schedule-private-session-row') && !opts.force) return;

  var seed = [];
  try { seed = JSON.parse(wrap.getAttribute('data-seed') || '[]'); } catch (_s) { seed = []; }
  if ((!Array.isArray(seed) || !seed.length) && !opts.skipCtxSeed) {
    var ctx = scheduleDrawerState.ctx || {};
    if (Array.isArray(ctx.lessons)) {
      seed = ctx.lessons.filter(function(L) { return L && L.kind === 'private'; }).map(function(L) {
        return { date: L.date, start: L.start || '', end: L.end || '' };
      });
    }
    if ((!seed || !seed.length) && ctx.components && ctx.components.private_lesson
      && Array.isArray(ctx.components.private_lesson.sessions)) {
      seed = ctx.components.private_lesson.sessions.map(function(s) {
        return { date: s.date, start: s.start || '', end: s.end || '' };
      });
    }
  }
  // Fall back to date-range expand only when no multi/session seed (single blank day).
  if (!Array.isArray(seed) || !seed.length) {
    var span = scheduleDrawerDateSpan();
    var from = typeof schedulePortalCanonicalDateIso === 'function'
      ? schedulePortalCanonicalDateIso(span.from) : String(span.from || '').slice(0, 10);
    var to = typeof schedulePortalCanonicalDateIso === 'function'
      ? schedulePortalCanonicalDateIso(span.to || span.from) : String(span.to || span.from || '').slice(0, 10);
    var dates = [];
    if (from && to && from <= to && typeof scheduleEnumerateDates === 'function') {
      dates = scheduleEnumerateDates(from, to) || [];
    }
    if (dates.length > 30) dates = dates.slice(0, 1);
    seed = dates.map(function(d) { return { date: d, start: '', end: '' }; });
  }
  wrap.innerHTML = '';
  if (seed && seed.length) {
    seed.forEach(function(s) { scheduleDrawerAppendPrivateSessionRow(s); });
  } else {
    scheduleDrawerAppendPrivateSessionRow({});
  }
  var addBtn = el('ps-drawer-add-private-session');
  if (addBtn && !addBtn.dataset.wired) {
    addBtn.dataset.wired = '1';
    addBtn.addEventListener('click', function() {
      scheduleDrawerAppendPrivateSessionRow({});
      scheduleDrawerMarkPriceStale();
      scheduleRefreshDrawerFullDayAddon();
      scheduleDrawerSyncFooter();
    });
  }
}

// Back-compat alias used by older date-range wiring.
function scheduleDrawerRenderPrivateSessions(sessions) {
  var wrap = el('ps-drawer-private-sessions');
  if (!wrap) return;
  wrap.innerHTML = '';
  (sessions || []).forEach(function(s) { scheduleDrawerAppendPrivateSessionRow(s); });
  if (!(sessions || []).length) scheduleDrawerAppendPrivateSessionRow({});
}

function scheduleDrawerMarkPriceStale(){
  scheduleDrawerPriceStale=true;
  var msg=el('ps-drawer-save-msg');
  if(msg&&msg.dataset&&msg.dataset.reprice==='1'){ msg.style.display='none'; msg.textContent=''; msg.dataset.reprice=''; }
  // Invalidate any painted € total immediately when pricing intent drifts.
  scheduleDrawerQuoteState = null;
}

function scheduleDrawerQuotePricingIntentKey(payload) {
  if (typeof schedulePortalQuotePricingIntentKey === 'function') {
    return schedulePortalQuotePricingIntentKey(payload);
  }
  return JSON.stringify({
    date_from: payload && payload.date_from,
    date_to: payload && payload.date_to,
    rentals: payload && payload.rentals,
    components: payload && payload.components,
    surfer_count: payload && payload.surfer_count,
    custom_line_items: payload && payload.custom_line_items,
  });
}

function scheduleDrawerClearQuotePreviewUi() {
  scheduleDrawerQuoteState = null;
  var box = el('ps-drawer-quote-preview');
  if (box) { box.innerHTML = ''; box.style.display = 'none'; }
}

function scheduleDrawerShowQuoteChecking() {
  var box = el('ps-drawer-quote-preview');
  if (!box) return;
  try { box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); } catch (_e) { /* ignore */ }
  box.innerHTML = '<p class="portal-schedule-drawer-hint portal-schedule-quote-checking" style="margin:0">'
    + escHtml(portalT('schedule.create.checkingPrice') || 'Checking price\u2026') + '</p>';
  box.style.display = 'block';
}

/**
 * Drop quote state + € display when pricing intent drifted (date/surfer/rental).
 * Leaves "Checking price…" alone so in-flight requote UI is preserved.
 */
function scheduleDrawerDropStaleQuoteUi(payload) {
  var key = scheduleDrawerQuotePricingIntentKey(payload || {});
  if (scheduleDrawerQuoteState && scheduleDrawerQuoteState.intent_key === key) return false;
  scheduleDrawerQuoteState = null;
  var box = el('ps-drawer-quote-preview');
  if (!box) return true;
  var html = String(box.innerHTML || '');
  if (/portal-schedule-quote-checking|checkingPrice|Checking price/i.test(html)) return true;
  if (/€\d|Quoted total|quoteTotal/i.test(html)) {
    box.innerHTML = '';
    box.style.display = 'none';
  }
  return true;
}

function scheduleDrawerRenderQuotePreview(result) {
  var box = el('ps-drawer-quote-preview');
  if (!box) return;
  if (result && (result.superseded || result.aborted)) return;
  try { box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); } catch (_e) { /* ignore */ }
  if (result && (result.idle || result.softInvalid)) {
    scheduleDrawerQuoteState = null;
    box.innerHTML = '';
    box.style.display = 'none';
    return;
  }
  if (result && result.checking) { scheduleDrawerShowQuoteChecking(); return; }
  if (!result || !result.ok) {
    var err = portalT('schedule.create.quoteFailed') || 'Quote unavailable';
    if (result && result.stale) err = portalT('schedule.create.quoteStale') || 'Price changed — refresh quote before saving.';
    else if (result && result.status === 503) err = portalT('schedule.create.quoteBusy') || 'Price check is busy — wait a moment and try again.';
    box.innerHTML = '<p class="portal-schedule-drawer-hint" style="margin:0;color:var(--danger,#b33)">' + escHtml(String(err)) + '</p>';
    box.style.display = 'block';
    return;
  }
  // Never paint a total whose pricing intent no longer matches the live Edit form.
  if (result.intent_key != null || (scheduleDrawerQuoteState && scheduleDrawerQuoteState.intent_key != null)) {
    var livePayload = null;
    try { livePayload = scheduleReadDrawerEditPayload(); } catch (_lp) { livePayload = null; }
    var liveIntent = livePayload ? scheduleDrawerQuotePricingIntentKey(livePayload) : null;
    var resultIntent = result.intent_key != null
      ? result.intent_key
      : (scheduleDrawerQuoteState && scheduleDrawerQuoteState.intent_key);
    if (liveIntent != null && resultIntent != null && liveIntent !== resultIntent) {
      scheduleDrawerQuoteState = null;
      box.innerHTML = '';
      box.style.display = 'none';
      return;
    }
  }
  var raw = typeof schedulePortalStrictQuoteTotalCents === 'function'
    ? schedulePortalStrictQuoteTotalCents(result.body)
    : (result.body && result.body.total_cents);
  if (raw == null || (typeof schedulePortalStrictQuoteTotalCents !== 'function'
    && (typeof raw !== 'number' || !Number.isFinite(raw) || Math.floor(raw) !== raw || raw < 0 || raw > Number.MAX_SAFE_INTEGER))) {
    box.innerHTML = '<p class="portal-schedule-drawer-hint" style="margin:0;color:var(--danger,#b33)">'
      + escHtml(portalT('schedule.create.quoteFailed') || 'Quote unavailable') + '</p>';
    box.style.display = 'block';
    return;
  }
  box.innerHTML = '<p class="portal-schedule-drawer-hint" style="margin:0">'
    + escHtml((portalT('schedule.create.quoteTotal') || 'Quoted total') + ': \u20ac' + (raw / 100).toFixed(2)) + '</p>';
  box.style.display = 'block';
}

function scheduleDrawerHumanCourseBit(course) {
  var id = course && course.course_id != null ? String(course.course_id).trim() : '';
  var sel = el('ps-drawer-course-select');
  var opt = (sel && sel.options && sel.selectedIndex >= 0) ? sel.options[sel.selectedIndex] : null;
  var cands = [
    opt ? String((opt.getAttribute && opt.getAttribute('data-label')) || opt.textContent || '').trim() : '',
    course && course.course_label != null ? String(course.course_label).trim() : '',
  ];
  if (typeof scheduleResolveCourseDisplayLabel === 'function') {
    cands.push(String(scheduleResolveCourseDisplayLabel(id, cands[1]) || '').trim());
  }
  for (var i = 0; i < cands.length; i++) {
    var lab = cands[i];
    if (!lab || (id && lab === id) || (course && course.tier_key && lab === String(course.tier_key))) continue;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lab)) continue;
    return lab;
  }
  return '';
}

/**
 * Compact two-row Edit footer summary — same hierarchy as Create.
 * Primary: identity/qty/gear/custom; secondary: one duration + compact date + guest.
 * Payment status is owned by the Payment Status control — never repeated here.
 */
function scheduleDrawerRenderIntentSummary(payload) {
  var box = el('ps-drawer-summary');
  if (!box) return;
  var p = payload || {};
  var comps = p.components || {};
  var rentals = Array.isArray(p.rentals) ? p.rentals : [];
  var customLines = Array.isArray(p.custom_line_items) ? p.custom_line_items : [];
  var hasLesson = !!(comps.course || comps.private_lesson);
  var hasGear = rentals.length > 0 || !!(comps.surfboard || comps.wetsuit || comps.full_day_equipment_extension);
  var hasCustom = customLines.some(function(l) { return l && String(l.label || '').trim(); });
  if (!hasLesson && !hasGear && !hasCustom) {
    box.innerHTML = '<span class="portal-schedule-create-summary-placeholder">'
      + escHtml(portalT('schedule.create.summary.chooseLessonOrGear') || 'Choose a lesson or add gear') + '</span>';
    return;
  }

  var primary = [];
  var secondary = [];
  var durationLab = '';

  if (comps.course) {
    var cLab = scheduleDrawerHumanCourseBit(comps.course);
    if (cLab) primary.push(cLab);
    else primary.push(portalT('schedule.type.course') || 'Group course');
    var tierLab = comps.course.tier_label != null ? String(comps.course.tier_label).trim() : '';
    if (!tierLab && comps.course.tier_key) {
      tierLab = (typeof schedulePortalDurationLabel === 'function'
        ? schedulePortalDurationLabel(comps.course.tier_key) : '') || '';
    }
    if (tierLab && tierLab !== String(comps.course.tier_key || '')) durationLab = tierLab;
    if (comps.course.quantity) primary.push('\u00d7' + String(comps.course.quantity));
  } else if (comps.private_lesson) {
    var pl = comps.private_lesson;
    primary.push(portalT('schedule.type.privateLesson') || 'Private course');
    var sessN = Array.isArray(pl.sessions) ? pl.sessions.length : (pl.quantity || 0);
    if (sessN) primary.push((portalT('schedule.create.summary.sessions') || 'Sessions') + ': ' + String(sessN));
    if (pl.surfer_count) primary.push((portalT('schedule.create.summary.surfers') || 'Surfers') + ': ' + String(pl.surfer_count));
    var dates = (pl.sessions || []).map(function(s) {
      return s && s.date ? String(s.date).slice(0, 10) : '';
    }).filter(Boolean).sort();
    if (dates.length && typeof schedulePortalFormatCompactDateRange === 'function') {
      var plCompact = schedulePortalFormatCompactDateRange(
        dates[0],
        dates.length > 1 ? dates[dates.length - 1] : dates[0],
      );
      if (plCompact) secondary.push(plCompact);
    }
  } else {
    primary.push(portalT('schedule.type.noLesson') || 'Equipment only');
  }

  function gearLabelOnly(key, q) {
    var lab = typeof schedulePortalRentalLabel === 'function'
      ? schedulePortalRentalLabel(key) : '';
    if (!lab && typeof scheduleRentalOfferingLabelKey === 'function') {
      var ik = scheduleRentalOfferingLabelKey(key);
      lab = ik ? portalT(ik) : '';
      if (lab === ik) lab = '';
    }
    if (!lab) return '';
    return (Number(q) > 1) ? (lab + ' \u00d7' + q) : lab;
  }
  if (rentals.length) {
    var gearBits = [];
    for (var ri = 0; ri < rentals.length; ri++) {
      var r = rentals[ri];
      if (!r || !r.offering_key) continue;
      var gLab = gearLabelOnly(r.offering_key, r.quantity);
      if (gLab) gearBits.push(gLab);
      if (!durationLab && r.duration_key) {
        var gDur = typeof schedulePortalDurationLabel === 'function'
          ? schedulePortalDurationLabel(r.duration_key) : '';
        if (gDur && gDur !== String(r.duration_key)) durationLab = gDur;
      }
    }
    if (gearBits.length) primary.push(gearBits.join(', '));
  } else {
    if (comps.surfboard) {
      var sb = gearLabelOnly('board_rental', comps.surfboard.quantity);
      if (sb) primary.push(sb);
    }
    if (comps.wetsuit) {
      var ws = gearLabelOnly('wetsuit_rental', comps.wetsuit.quantity);
      if (ws) primary.push(ws);
    }
  }
  if (comps.full_day_equipment_extension) {
    primary.push(portalT('schedule.type.fullDayEquipment') || 'Full-day gear');
  }
  for (var ci = 0; ci < customLines.length; ci++) {
    var cl = customLines[ci];
    var clLab = cl && cl.label != null ? String(cl.label).trim() : '';
    if (clLab) primary.push(clLab);
  }

  if (durationLab) secondary.push(durationLab);
  if (!comps.private_lesson) {
    var df = p.date_from ? String(p.date_from).slice(0, 10) : '';
    var dt = p.date_to ? String(p.date_to).slice(0, 10) : df;
    var compact = (df && typeof schedulePortalFormatCompactDateRange === 'function')
      ? schedulePortalFormatCompactDateRange(df, dt) : '';
    if (compact) secondary.push(compact);
  }
  var guestName = p.guest_name != null ? String(p.guest_name).trim() : '';
  if (guestName) secondary.push(guestName);

  var html = '';
  if (primary.length) {
    html += '<span class="portal-schedule-create-summary-primary">' + escHtml(primary.join(' \u00b7 ')) + '</span>';
  }
  if (secondary.length) {
    html += '<span class="portal-schedule-create-summary-secondary">' + escHtml(secondary.join(' \u00b7 ')) + '</span>';
  }
  if (!html) {
    html = '<span class="portal-schedule-create-summary-placeholder">'
      + escHtml(portalT('schedule.create.summary.chooseLessonOrGear') || 'Choose a lesson or add gear') + '</span>';
  }
  box.innerHTML = html;
}

function scheduleDrawerRefreshQuote() {
  if (scheduleDrawerSaveInFlight) return Promise.resolve(null);
  if (scheduleDrawerQuoteTimer != null) {
    clearTimeout(scheduleDrawerQuoteTimer);
    scheduleDrawerQuoteTimer = null;
  }
  var payload = null;
  try { payload = scheduleReadDrawerEditPayload(); } catch (_r) { payload = null; }
  var gate = scheduleDrawerValidateEditPayload(payload || {});
  if (!gate.ok) {
    if (scheduleDrawerQuoteAbort) {
      try { scheduleDrawerQuoteAbort.abort(); } catch (_a) { /* ignore */ }
      scheduleDrawerQuoteAbort = null;
    }
    scheduleDrawerQuoteGen += 1;
    scheduleDrawerClearQuotePreviewUi();
    return Promise.resolve(null);
  }
  if (scheduleDrawerQuoteAbort) {
    try { scheduleDrawerQuoteAbort.abort(); } catch (_a2) { /* ignore */ }
    scheduleDrawerQuoteAbort = null;
  }
  scheduleDrawerQuoteGen += 1;
  // Invalidate prior total immediately so a stale €40 cannot linger beside a multi-day summary.
  scheduleDrawerQuoteState = null;
  scheduleDrawerShowQuoteChecking();
  var wait = Number(scheduleDrawerQuoteDebounceMs);
  if (!(wait >= 0 && wait <= 500)) wait = 400;
  var myGen = scheduleDrawerQuoteGen;
  var intentKey = scheduleDrawerQuotePricingIntentKey(payload);
  var scheduleLater = typeof setTimeout === 'function'
    ? setTimeout
    : function(fn) { try { fn(); } catch (_f) { /* ignore */ } return null; };
  return new Promise(function(resolve) {
    scheduleDrawerQuoteTimer = scheduleLater(function() {
      scheduleDrawerQuoteTimer = null;
      if (myGen !== scheduleDrawerQuoteGen) { resolve({ ok: false, superseded: true }); return; }
      var controller = null;
      if (typeof AbortController !== 'undefined') {
        controller = new AbortController();
        scheduleDrawerQuoteAbort = controller;
      }
      var body = {
        location_id: typeof getSunsetLocation === 'function' ? getSunsetLocation() : null,
        guest_name: payload.guest_name != null ? payload.guest_name : '',
        guest_phone: payload.guest_phone != null ? payload.guest_phone : '',
        date_from: payload.date_from,
        date_to: payload.date_to,
        components: payload.components,
        lessons: Array.isArray(payload.lessons) ? payload.lessons : [],
        rentals: Array.isArray(payload.rentals) ? payload.rentals : [],
        course_equipment: Array.isArray(payload.course_equipment) ? payload.course_equipment : [],
        surfer_count: payload.surfer_count != null ? payload.surfer_count : null,
        custom_line_items: Array.isArray(payload.custom_line_items) ? payload.custom_line_items : [],
      };
      var url = '/staff/schedule/bookings/quote?client=' + encodeURIComponent(
        typeof getClient === 'function' ? getClient() : 'sunset',
      ) + (typeof sunsetLocationQuerySuffix === 'function' ? sunsetLocationQuerySuffix() : '');
      var fetchOpts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      };
      if (controller) fetchOpts.signal = controller.signal;
      var run = typeof fetch === 'function' ? fetch(url, fetchOpts) : Promise.reject(new Error('no fetch'));
      run.then(function(r) {
        return r.json().then(function(data) { return { ok: r.ok, status: r.status, data: data }; });
      }).then(function(res) {
        if (myGen !== scheduleDrawerQuoteGen) return { ok: false, superseded: true };
        var data = (res && res.data) || {};
        if (!res.ok || !data.success) {
          scheduleDrawerQuoteState = null;
          scheduleDrawerRenderQuotePreview({
            ok: false,
            error: data.error || data.reason || data.reason_code,
            stale: data.reason_code === 'quote_stale',
            status: res.status,
            body: data,
          });
          return { ok: false, body: data };
        }
        var totalCents = typeof schedulePortalStrictQuoteTotalCents === 'function'
          ? schedulePortalStrictQuoteTotalCents(data)
          : data.total_cents;
        if (totalCents == null) {
          scheduleDrawerQuoteState = null;
          scheduleDrawerRenderQuotePreview({ ok: false, error: 'invalid_quote_total', body: data });
          return { ok: false, body: data };
        }
        // Reject apply when pricing intent already drifted mid-flight.
        var livePayload = null;
        try { livePayload = scheduleReadDrawerEditPayload(); } catch (_lp) { livePayload = null; }
        var liveKey = livePayload ? scheduleDrawerQuotePricingIntentKey(livePayload) : intentKey;
        if (liveKey != null && intentKey != null && liveKey !== intentKey) {
          scheduleDrawerQuoteState = null;
          scheduleDrawerClearQuotePreviewUi();
          return { ok: false, superseded: true };
        }
        scheduleDrawerQuoteState = { intent_key: intentKey, total_cents: totalCents };
        scheduleDrawerRenderQuotePreview({
          ok: true,
          body: data,
          intent_key: intentKey,
        });
        return { ok: true, body: data, intent_key: intentKey };
      }).catch(function(err) {
        if (myGen !== scheduleDrawerQuoteGen) return { ok: false, superseded: true };
        if (err && err.name === 'AbortError') return { ok: false, aborted: true };
        scheduleDrawerRenderQuotePreview({ ok: false, error: err && err.message });
        return null;
      }).then(function(result) {
        if (scheduleDrawerQuoteAbort === controller) scheduleDrawerQuoteAbort = null;
        resolve(result);
      });
    }, wait);
  });
}

function scheduleDrawerValidateEditPayload(payload) {
  var p = payload || {}, comps = p.components || {};
  if (!(p.guest_name && String(p.guest_name).trim())) return { ok: false, errorKey: 'schedule.create.guestRequired' };
  if (!Object.keys(comps).length && !(Array.isArray(p.rentals) && p.rentals.length)) return { ok: false, errorKey: 'schedule.create.componentsRequired' };
  if (comps.course) {
    var selectedCoursesV = Array.isArray(comps.course.selected_courses)
      ? comps.course.selected_courses
      : [];
    var hasSelectedCoursesV = selectedCoursesV.length > 0;
    if (!hasSelectedCoursesV && !String(comps.course.course_id || '').trim()) {
      return { ok: false, errorKey: 'schedule.create.courseRequired' };
    }
    // Seeded course missing/ineligible in catalog: preserve identity but block Save until staff re-picks.
    try {
      var courseSel = el('ps-drawer-course-select');
      if (courseSel && courseSel.getAttribute('data-compatibility-unavailable') === '1') {
        return { ok: false, errorKey: 'schedule.create.courseNotOnSelectedDates' };
      }
      var checkIds = hasSelectedCoursesV
        ? selectedCoursesV.map(function(sc) { return String((sc && sc.course_id) || '').trim(); }).filter(Boolean)
        : [String(comps.course.course_id || '').trim()].filter(Boolean);
      var courseList = el('ps-drawer-course-list');
      for (var ci = 0; ci < checkIds.length; ci++) {
        var courseId = checkIds[ci];
        if (courseSel && courseId) {
          var opt = null;
          if (courseSel.options) {
            for (var oi = 0; oi < courseSel.options.length; oi++) {
              if (String(courseSel.options[oi].value) === courseId) { opt = courseSel.options[oi]; break; }
            }
          }
          if (opt && (opt.getAttribute && (opt.getAttribute('data-eligible') === '0'
            || opt.getAttribute('data-compatibility') === '1' || opt.disabled))) {
            return { ok: false, errorKey: 'schedule.create.courseNotOnSelectedDates' };
          }
        }
        if (courseList && courseId) {
          var crow = courseList.querySelector
            ? courseList.querySelector('button[data-course-id="' + courseId + '"]')
            : null;
          if (crow && (crow.getAttribute('data-eligible') === '0'
            || crow.getAttribute('data-compatibility') === '1'
            || crow.disabled || crow.classList.contains('is-disabled'))) {
            return { ok: false, errorKey: 'schedule.create.courseNotOnSelectedDates' };
          }
        }
      }
    } catch (_cu) { /* ignore DOM probe */ }
    if (hasSelectedCoursesV) {
      for (var sci = 0; sci < selectedCoursesV.length; sci++) {
        var scv = selectedCoursesV[sci] || {};
        if (!String(scv.course_id || '').trim()) return { ok: false, errorKey: 'schedule.create.courseRequired' };
        if (!String(scv.tier_key || '').trim()) return { ok: false, errorKey: 'schedule.create.courseDurationUnavailable' };
      }
    } else if (!String(comps.course.tier_key || '').trim()) {
      return { ok: false, errorKey: 'schedule.create.courseDurationUnavailable' };
    }
  }
  if (comps.private_lesson) {
    var plSpan = typeof schedulePortalInclusiveDateCount === 'function'
      ? schedulePortalInclusiveDateCount(p.date_from, p.date_to != null ? p.date_to : p.date_from) : 0;
    if (plSpan > 30) return { ok: false, errorKey: 'schedule.create.privateLesson.rangeTooLong' };
    if (typeof schedulePortalValidatePrivateLessonCreate === 'function') {
      var plCheck = schedulePortalValidatePrivateLessonCreate(comps.private_lesson);
      if (!plCheck || plCheck.ok !== true) return { ok: false, errorKey: (plCheck && plCheck.errorKey) || 'schedule.create.privateLesson.sessionIncomplete' };
    }
  }
  // Blank/invalid Surfers cannot Save or quote (no silent fallback to 1).
  var rentals = Array.isArray(p.rentals) ? p.rentals : [];
  var needsSurfers = !!(comps.course || comps.private_lesson || rentals.length
    || comps.full_day_equipment_extension);
  if (!needsSurfers) {
    // No-lesson with checked rental but invalid surfer may serialize empty rentals —
    // still block when the live input is invalid and a rental is checked.
    try {
      if (scheduleDrawerMainActivityValue() === 'none') {
        var wrapNeed = el('ps-drawer-rentals');
        if (wrapNeed) {
          wrapNeed.querySelectorAll('.ps-drawer-rental-check').forEach(function(c) {
            if (c && c.checked) needsSurfers = true;
          });
        }
      }
    } catch (_n) { /* ignore */ }
  }
  // Compatibility rentals (seeded missing from catalog) block Save until staff resolves.
  try {
    var rentWrap = el('ps-drawer-rentals');
    if (rentWrap) {
      var blockedCompat = false;
      rentWrap.querySelectorAll('.ps-drawer-rental-check').forEach(function(c) {
        if (c && c.checked && (c.getAttribute('data-compatibility') === '1'
          || c.getAttribute('data-eligible') === '0')) blockedCompat = true;
      });
      if (!blockedCompat) {
        // Single-attr selector (avoid compound attr selectors) then filter.
        rentWrap.querySelectorAll('[data-rental-offering]').forEach(function(row) {
          if (row.getAttribute('data-compatibility') !== '1'
            && row.getAttribute('data-eligible') !== '0') return;
          var chk2 = row.querySelector ? row.querySelector('.ps-drawer-rental-check') : null;
          if (chk2 && chk2.checked) blockedCompat = true;
        });
      }
      // Wrap-level flag only blocks when a compatibility seed is still selected in payload.
      if (!blockedCompat && rentWrap.getAttribute('data-rental-compatibility') === '1') {
        var compatKeys = [];
        try {
          compatKeys = JSON.parse(rentWrap.getAttribute('data-compatibility-rentals') || '[]') || [];
        } catch (_jk) { compatKeys = []; }
        if (compatKeys.length && rentals.some(function(r) {
          return r && compatKeys.indexOf(String(r.offering_key || '')) >= 0;
        })) {
          blockedCompat = true;
        }
      }
      if (blockedCompat) return { ok: false, errorKey: 'schedule.create.noRentalsAvailable' };
    }
  } catch (_rc) { /* ignore */ }
  if (needsSurfers) {
    var sn = null;
    try { sn = scheduleDrawerReadSurferCount(); } catch (_s) { sn = null; }
    if (sn == null && p.surfer_count != null) {
      var fromPayload = Number(p.surfer_count);
      if (Number.isFinite(fromPayload) && Math.floor(fromPayload) === fromPayload && fromPayload >= 1) {
        sn = fromPayload;
      }
    }
    if (!(Number.isInteger(sn) && sn >= 1 && sn <= 99)) {
      return { ok: false, errorKey: 'schedule.create.surfersRequired' };
    }
  }
  return { ok: true };
}

function scheduleReadDrawerEditPayload() {
  var guest = (el('ps-drawer-guest') && el('ps-drawer-guest').value || '').trim();
  var phone = (el('ps-drawer-phone') && el('ps-drawer-phone').value || '').trim();
  var span = scheduleDrawerDateSpan();
  var dateFrom = span.from;
  var dateTo = span.to || dateFrom;
  var paymentSel = el('ps-drawer-payment') ? el('ps-drawer-payment').value : 'unpaid';
  var pm = scheduleParsePaymentSelectValue(paymentSel);
  var notes = (el('ps-drawer-notes') && el('ps-drawer-notes').value || '').trim();
  var components = {};
  var mode = scheduleDrawerMainActivityValue();
  if (mode === 'group') {
    // Multi-select product buttons: exact course IDs + derived tier identities only.
    // No Group lessons[] / custom dates/times/schedules from Edit (Create parity).
    var selectedCourseIds = typeof scheduleDrawerGetSelectedCourseIds === 'function'
      ? scheduleDrawerGetSelectedCourseIds()
      : [];
    if (!selectedCourseIds.length) {
      var courseSelFallback = el('ps-drawer-course-select');
      var fallbackId = courseSelFallback
        ? String(courseSelFallback.value || courseSelFallback.getAttribute('data-selected') || '').trim()
        : '';
      if (fallbackId) selectedCourseIds = [fallbackId];
    }
    var selectedCourses = [];
    var courseSel = el('ps-drawer-course-select');
    selectedCourseIds.forEach(function(courseId) {
      courseId = String(courseId || '').trim();
      if (!courseId) return;
      var courseLabel = '';
      try {
        var btn = el('ps-drawer-course-list')
          && el('ps-drawer-course-list').querySelector('button[data-course-id="' + courseId + '"]');
        if (btn) courseLabel = String(btn.getAttribute('data-label') || '').trim();
      } catch (_bl) { /* ignore */ }
      if (!courseLabel && courseSel && courseSel.options) {
        for (var oi = 0; oi < courseSel.options.length; oi++) {
          if (String(courseSel.options[oi].value) === courseId) {
            courseLabel = courseSel.options[oi].getAttribute('data-label')
              || courseSel.options[oi].textContent || '';
            break;
          }
        }
      }
      var row = {
        course_id: courseId,
        course_label: courseLabel || '',
      };
      var derivedOne = typeof schedulePortalResolveDerivedCourseTier === 'function'
        ? schedulePortalResolveDerivedCourseTier(courseId, dateFrom, dateTo)
        : null;
      if (derivedOne && derivedOne.ok && derivedOne.tier_key) {
        row.tier_key = derivedOne.tier_key;
        row.offering_id = derivedOne.offering_id || ('surf_pack_' + courseId + '__' + derivedOne.tier_key);
        if (derivedOne.tier_label) row.tier_label = derivedOne.tier_label;
      }
      selectedCourses.push(row);
    });
    var primary = selectedCourses[0] || null;
    components.course = {
      quantity: parseInt((el('ps-drawer-course-qty') && el('ps-drawer-course-qty').value) || '1', 10) || 1,
      course_id: primary ? primary.course_id : '',
      course_label: primary ? (primary.course_label || '') : '',
      selected_courses: selectedCourses,
    };
    if (primary && primary.tier_key) {
      components.course.tier_key = primary.tier_key;
      components.course.offering_id = primary.offering_id
        || ('surf_pack_' + primary.course_id + '__' + primary.tier_key);
      if (primary.tier_label) components.course.tier_label = primary.tier_label;
    }
  }
  if (mode === 'private') {
    var plSurfers = parseInt((el('ps-drawer-private-lesson-surfers') && el('ps-drawer-private-lesson-surfers').value) || '1', 10) || 1;
    var plSessions = scheduleDrawerReadPrivateSessionsFromDom().filter(function(s) { return s.date; });
    components.private_lesson = {
      enabled: true,
      quantity: plSessions.length,
      surfer_count: plSurfers,
      sessions: plSessions,
    };
  }
  var rentals = scheduleReadDrawerRentalSelectionFromDom();
  if (typeof scheduleRentalsToLegacyComponents === 'function') {
    var rentalComponents = scheduleRentalsToLegacyComponents(rentals);
    Object.keys(rentalComponents).forEach(function(k) { components[k] = rentalComponents[k]; });
  }
  var equipmentField = el('ps-drawer-course-equipment');
  var course_equipment = [];
  if (mode === 'group') {
    // During Course quantity always tracks participant count (never stale hidden sets).
    // All Day uses explicit set quantity. Never empty offering_key, cents, or labels.
    var groupSurfers = scheduleDrawerReadSurferCount() || 1;
    if (equipmentField) equipmentField.querySelectorAll('.portal-schedule-course-equipment-item').forEach(function(item) {
      var enabled = item.querySelector('[data-course-equipment-enabled]');
      var pressed = item.querySelector('[data-drawer-course-equipment-mode][aria-pressed="true"]');
      if (!enabled || !enabled.checked || !pressed) return;
      var offeringKey = String(item.getAttribute('data-offering-key') || '').trim();
      if (!offeringKey) return;
      var modeKey = String(pressed.getAttribute('data-drawer-course-equipment-mode') || 'during_course');
      var quantityNode = item.querySelector('[data-course-equipment-quantity]');
      var quantity = modeKey === 'all_day'
        ? Math.max(1, Math.min(groupSurfers, parseInt(quantityNode && quantityNode.value, 10) || 1))
        : groupSurfers;
      course_equipment.push({ offering_key: offeringKey, mode: modeKey, quantity: quantity });
    });
  } else if (mode === 'private') {
    // Exact non-empty identity/intent/count only — never empty offering_key, cents, or labels.
    var privateSurfers = scheduleDrawerReadSurferCount() || 1;
    if (equipmentField) equipmentField.querySelectorAll('.portal-schedule-course-equipment-item').forEach(function(item) {
      var enabled = item.querySelector('[data-course-equipment-enabled]');
      var pressed = item.querySelector('[data-drawer-course-equipment-mode][aria-pressed="true"]');
      if (!enabled || !enabled.checked || !pressed) return;
      var offeringKey = String(item.getAttribute('data-offering-key') || '').trim();
      if (!offeringKey) return;
      var modeKey = String(pressed.getAttribute('data-drawer-course-equipment-mode') || 'during_course');
      var quantityNode = item.querySelector('[data-course-equipment-quantity]');
      var quantity = modeKey === 'all_day'
        ? Math.max(1, Math.min(privateSurfers, parseInt(quantityNode && quantityNode.value, 10) || 1))
        : privateSurfers;
      course_equipment.push({ offering_key: offeringKey, mode: modeKey, quantity: quantity });
    });
  }
  var custom_line_items = (scheduleDrawerCustomLines || []).map(function(l) {
    return {
      client_line_id: String(l.client_line_id),
      label: String(l.label),
      amount_cents: Number(l.amount_cents),
    };
  });
  // Always send accommodation key so omit-preserve server path is not needed when
  // the editor explicitly removes it (null). Unrelated fields keep it when seeded.
  var accommodation = null;
  if (scheduleDrawerAccommodation && scheduleDrawerAccommodation.enabled) {
    var acIn = el('ps-drawer-accommodation-check-in');
    var acOut = el('ps-drawer-accommodation-check-out');
    accommodation = {
      enabled: true,
      check_in: acIn ? String(acIn.value || '').slice(0, 10) : String(scheduleDrawerAccommodation.check_in || '').slice(0, 10),
      check_out: acOut ? String(acOut.value || '').slice(0, 10) : String(scheduleDrawerAccommodation.check_out || '').slice(0, 10),
    };
  }
  var surferCount = scheduleDrawerReadSurferCount();
  // Private sessions keep canonical lessons[]. Group Edit uses selected course product
  // buttons only — never invent Group lessons[] / custom dates / times / schedules.
  var lessons = [];
  if (components.private_lesson && Array.isArray(components.private_lesson.sessions)) {
    components.private_lesson.sessions.forEach(function(s) {
      if (!s || !s.date) return;
      lessons.push({ kind: 'private', date: s.date, start: s.start, end: s.end });
    });
  }
  return {
    guest_name: guest,
    guest_phone: phone || null,
    date_from: dateFrom,
    date_to: dateTo,
    payment_status: pm.status,
    payment_method: pm.method,
    notes: notes,
    components: components,
    rentals: rentals,
    custom_line_items: custom_line_items,
    accommodation: accommodation,
    // No-lesson equipment qty authority (server forces rentals to this when present).
    surfer_count: surferCount,
    course_equipment: course_equipment,
    lessons: lessons,
  };
}

function scheduleDrawerSeedAccommodationFromCtx(ctx) {
  scheduleDrawerAccommodation = null;
  var seed = null;
  if (ctx && ctx.accommodation && ctx.accommodation.check_in && ctx.accommodation.check_out) {
    seed = {
      enabled: true,
      check_in: String(ctx.accommodation.check_in).slice(0, 10),
      check_out: String(ctx.accommodation.check_out).slice(0, 10),
    };
  } else {
    var wrap = el('ps-drawer-accommodation-wrap');
    if (wrap) {
      try { seed = JSON.parse(wrap.getAttribute('data-seed-accommodation') || 'null'); } catch (_e) { seed = null; }
    }
  }
  if (seed && seed.check_in && seed.check_out) {
    scheduleDrawerAccommodation = {
      enabled: true,
      check_in: String(seed.check_in).slice(0, 10),
      check_out: String(seed.check_out).slice(0, 10),
    };
  }
}

function scheduleDrawerRenderAccommodation() {
  var editor = el('ps-drawer-accommodation-editor');
  var addBtn = el('ps-drawer-accommodation-add-btn');
  var productOn = typeof scheduleAccommodationEnabledCache !== 'undefined'
    ? !!scheduleAccommodationEnabledCache
    : true;
  // Historical stay: always show editor when seeded even if product is now disabled.
  var hasExisting = !!(scheduleDrawerAccommodation && scheduleDrawerAccommodation.enabled);
  var wrap = el('ps-drawer-accommodation-wrap');
  if (wrap) {
    if (productOn || hasExisting) {
      wrap.style.display = '';
      wrap.removeAttribute('hidden');
    } else {
      wrap.style.display = 'none';
      wrap.setAttribute('hidden', '');
    }
  }
  if (!editor) return;
  if (hasExisting) {
    editor.style.display = '';
    editor.removeAttribute('hidden');
    editor.setAttribute('aria-hidden', 'false');
    var cin = el('ps-drawer-accommodation-check-in');
    var cout = el('ps-drawer-accommodation-check-out');
    if (cin) cin.value = scheduleDrawerAccommodation.check_in || '';
    if (cout) cout.value = scheduleDrawerAccommodation.check_out || '';
    if (addBtn) addBtn.style.display = 'none';
  } else {
    editor.style.display = 'none';
    editor.setAttribute('hidden', '');
    editor.setAttribute('aria-hidden', 'true');
    if (addBtn) addBtn.style.display = productOn ? '' : 'none';
  }
}

function scheduleDrawerAddAccommodation() {
  var productOn = typeof scheduleAccommodationEnabledCache !== 'undefined'
    ? !!scheduleAccommodationEnabledCache
    : true;
  if (!productOn && !(scheduleDrawerAccommodation && scheduleDrawerAccommodation.enabled)) return;
  var dateFrom = el('ps-drawer-date-from') ? el('ps-drawer-date-from').value
    : (el('ps-drawer-date') ? el('ps-drawer-date').value : '');
  var dateTo = el('ps-drawer-date-to') ? el('ps-drawer-date-to').value : dateFrom;
  scheduleDrawerAccommodation = {
    enabled: true,
    check_in: String(dateFrom || '').slice(0, 10),
    check_out: String(dateTo || dateFrom || '').slice(0, 10),
  };
  scheduleDrawerRenderAccommodation();
  if (typeof scheduleDrawerSyncFooter === 'function') scheduleDrawerSyncFooter();
}

function scheduleDrawerRemoveAccommodation() {
  scheduleDrawerAccommodation = null;
  scheduleDrawerRenderAccommodation();
  if (typeof scheduleDrawerSyncFooter === 'function') scheduleDrawerSyncFooter();
}

function scheduleWireDrawerAccommodation() {
  var addBtn = el('ps-drawer-accommodation-add-btn');
  var removeBtn = el('ps-drawer-accommodation-remove');
  var cin = el('ps-drawer-accommodation-check-in');
  var cout = el('ps-drawer-accommodation-check-out');
  if (addBtn && !addBtn._accomBound) {
    addBtn._accomBound = true;
    addBtn.addEventListener('click', function(){ scheduleDrawerAddAccommodation(); });
  }
  if (removeBtn && !removeBtn._accomBound) {
    removeBtn._accomBound = true;
    removeBtn.addEventListener('click', function(){ scheduleDrawerRemoveAccommodation(); });
  }
  function onCh() {
    if (!scheduleDrawerAccommodation) return;
    scheduleDrawerAccommodation.check_in = cin ? String(cin.value || '').slice(0, 10) : scheduleDrawerAccommodation.check_in;
    scheduleDrawerAccommodation.check_out = cout ? String(cout.value || '').slice(0, 10) : scheduleDrawerAccommodation.check_out;
    if (typeof scheduleDrawerSyncFooter === 'function') scheduleDrawerSyncFooter();
  }
  if (cin && !cin._accomBound) { cin._accomBound = true; cin.addEventListener('change', onCh); }
  if (cout && !cout._accomBound) { cout._accomBound = true; cout.addEventListener('change', onCh); }
  scheduleDrawerRenderAccommodation();
}

function scheduleDrawerSeedCustomLinesFromCtx(ctx) {
  scheduleDrawerCustomLines = [];
  scheduleDrawerCustomLineSeq = 0;
  scheduleDrawerCustomLineEditorOpen = false;
  var seed = [];
  if (ctx && Array.isArray(ctx.custom_line_items) && ctx.custom_line_items.length) {
    seed = ctx.custom_line_items;
  } else if (ctx && ctx.payment && Array.isArray(ctx.payment.line_items)) {
    seed = ctx.payment.line_items.filter(function(li) {
      return li && (li.component === 'staff_custom_line' || li.price_source === 'staff_custom_line'
        || (li.client_line_id && String(li.client_line_id).indexOf('cl_') === 0));
    }).map(function(li) {
      return {
        client_line_id: String(li.client_line_id || ('cl_seed_' + String(li.service_record_id || Math.random()).slice(0, 8))),
        label: String(li.label || 'Custom line'),
        amount_cents: Number(li.line_cents != null ? li.line_cents : li.total_cents) || 0,
      };
    });
  }
  seed.forEach(function(l) {
    if (!l || !l.client_line_id || !l.label) return;
    scheduleDrawerCustomLineSeq += 1;
    scheduleDrawerCustomLines.push({
      client_line_id: String(l.client_line_id),
      label: String(l.label),
      amount_cents: Number(l.amount_cents) || 0,
    });
  });
}

function scheduleDrawerSetCustomLineEditorOpen(open) {
  scheduleDrawerCustomLineEditorOpen = !!open;
  var collapsed = el('ps-drawer-custom-lines-collapsed');
  var editor = el('ps-drawer-custom-lines-editor');
  var err = el('ps-drawer-custom-line-error');
  if (collapsed) collapsed.style.display = open ? 'none' : 'flex';
  if (editor) {
    editor.style.display = open ? 'flex' : 'none';
    if (open) { editor.removeAttribute('hidden'); editor.setAttribute('aria-hidden', 'false'); }
    else { editor.setAttribute('hidden', ''); editor.setAttribute('aria-hidden', 'true'); }
  }
  if (err) { err.style.display = 'none'; err.textContent = ''; }
  if (open) {
    var lab = el('ps-drawer-custom-line-label');
    var price = el('ps-drawer-custom-line-price');
    if (lab) lab.value = '';
    if (price) price.value = '';
    try { if (lab) lab.focus(); } catch (_f) { /* ignore */ }
  }
}

function scheduleDrawerRenderCustomLines() {
  var list = el('ps-drawer-custom-lines-list');
  if (!list) return;
  if (!scheduleDrawerCustomLines.length) {
    list.innerHTML = '';
    return;
  }
  var removeLab = (typeof portalT === 'function' ? portalT('schedule.create.customLine.remove') : '') || 'Remove';
  var esc = typeof scheduleEscapeHtmlLite === 'function' ? scheduleEscapeHtmlLite : escHtml;
  var fmt = typeof scheduleFormatCentsMoney === 'function'
    ? scheduleFormatCentsMoney
    : function(c) { return '€' + (Number(c) / 100).toFixed(2); };
  list.innerHTML = scheduleDrawerCustomLines.map(function(line) {
    return '<div class="portal-schedule-create-custom-line-row" data-client-line-id="'
      + esc(line.client_line_id) + '">'
      + '<span class="ps-cl-label">' + esc(line.label) + '</span>'
      + '<span class="ps-cl-amount">' + esc(fmt(line.amount_cents)) + '</span>'
      + '<button type="button" class="ps-cl-remove" data-remove-drawer-custom-line="'
      + esc(line.client_line_id) + '" aria-label="' + esc(removeLab) + '">\u00d7</button></div>';
  }).join('');
}

function scheduleDrawerConfirmCustomLine() {
  var err = el('ps-drawer-custom-line-error');
  function fail(msg) {
    if (err) { err.textContent = msg; err.style.display = 'block'; }
  }
  var labelRaw = el('ps-drawer-custom-line-label') ? el('ps-drawer-custom-line-label').value : '';
  var label = String(labelRaw || '').trim();
  if (!label) {
    return fail((typeof portalT === 'function' ? portalT('schedule.create.customLine.labelRequired') : '') || 'Label is required');
  }
  if (label.length > 120) {
    return fail((typeof portalT === 'function' ? portalT('schedule.create.customLine.labelTooLong') : '') || 'Label max 120 characters');
  }
  var priceRaw = el('ps-drawer-custom-line-price') ? el('ps-drawer-custom-line-price').value : '';
  var parsed = typeof scheduleParseCreateMoneyToCents === 'function'
    ? scheduleParseCreateMoneyToCents(priceRaw)
    : { ok: false };
  if (!parsed.ok) {
    return fail((typeof portalT === 'function' ? portalT('schedule.create.customLine.priceInvalid') : '') || 'Enter a valid price (max 2 decimals)');
  }
  if (scheduleDrawerCustomLines.length >= 20) {
    return fail((typeof portalT === 'function' ? portalT('schedule.create.customLine.tooMany') : '') || 'Too many custom lines');
  }
  scheduleDrawerCustomLineSeq += 1;
  scheduleDrawerCustomLines.push({
    client_line_id: 'cl_' + String(Date.now()) + '_' + String(scheduleDrawerCustomLineSeq),
    label: label,
    amount_cents: parsed.amount_cents,
  });
  scheduleDrawerRenderCustomLines();
  scheduleDrawerSetCustomLineEditorOpen(false);
  scheduleDrawerMarkPriceStale();
  scheduleDrawerSyncFooter();
}

function scheduleDrawerRemoveCustomLine(clientLineId) {
  var id = String(clientLineId || '');
  scheduleDrawerCustomLines = scheduleDrawerCustomLines.filter(function(l) {
    return String(l.client_line_id) !== id;
  });
  scheduleDrawerRenderCustomLines();
  scheduleDrawerMarkPriceStale();
  scheduleDrawerSyncFooter();
}

function scheduleWireDrawerCustomLines() {
  var plus = el('ps-drawer-custom-line-add-btn');
  var confirm = el('ps-drawer-custom-line-confirm');
  var cancel = el('ps-drawer-custom-line-cancel');
  var list = el('ps-drawer-custom-lines-list');
  if (plus && !plus._clBound) {
    plus._clBound = true;
    plus.addEventListener('click', function() { scheduleDrawerSetCustomLineEditorOpen(true); });
  }
  if (confirm && !confirm._clBound) {
    confirm._clBound = true;
    confirm.addEventListener('click', function() { scheduleDrawerConfirmCustomLine(); });
  }
  if (cancel && !cancel._clBound) {
    cancel._clBound = true;
    cancel.addEventListener('click', function() { scheduleDrawerSetCustomLineEditorOpen(false); });
  }
  if (list && !list._clBound) {
    list._clBound = true;
    list.addEventListener('click', function(ev) {
      var t = ev && ev.target;
      var btn = t && t.closest ? t.closest('[data-remove-drawer-custom-line]') : null;
      if (!btn) return;
      scheduleDrawerRemoveCustomLine(btn.getAttribute('data-remove-drawer-custom-line'));
    });
  }
}

function scheduleParsePaymentSelectValue(val){
  switch(String(val||'')){
    case 'paid_bank_transfer': return {status:'paid',method:'bank_transfer'};
    case 'paid_in_store': return {status:'paid',method:'in_store'};
    case 'paid_via_link': return {status:'paid',method:'link'};
    case 'paid': return {status:'paid',method:null};
    default: return {status:'unpaid',method:null};
  }
}

function scheduleDrawerHumanSaveError(data,fallback){
  var code=data&&(data.reason_code||data.reason||data.error);
  if(code==='paid_booking_reprice_required') return portalT('schedule.drawer.paidRepriceRequired');
  return (data&&(data.error||data.message||data.reason_code))||fallback||'Save failed';
}

function scheduleDrawerSyncFooter(opts) {
  opts = opts || {};
  var payload = null;
  try { payload = scheduleReadDrawerEditPayload(); } catch (_e) { payload = null; }
  var gate = scheduleDrawerValidateEditPayload(payload || {});
  scheduleDrawerValidationState = gate;
  var box = el('ps-drawer-summary');
  if (box) {
    if (!gate.ok) {
      box.innerHTML = '<span class="portal-schedule-create-summary-text">' +
        escHtml(portalT(gate.errorKey || 'schedule.create.componentsRequired')) + '</span>';
    } else {
      scheduleDrawerRenderIntentSummary(payload);
    }
  }
  // Drop stale € totals before painting a new date/rental intent.
  scheduleDrawerDropStaleQuoteUi(payload);
  var saveBtn = el('ps-drawer-save');
  if (saveBtn) {
    saveBtn.disabled = !gate.ok || scheduleDrawerSaveInFlight;
  }
  if (opts.quote === false) return;
  if (gate.ok) scheduleDrawerRefreshQuote();
  else scheduleDrawerClearQuotePreviewUi();
}

function scheduleSaveDrawerBooking(row) {
  if (!row || !row.booking_id) return;
  if (scheduleDrawerSaveInFlight) return;
  var openGen = scheduleDrawerState && scheduleDrawerState.openGen;
  var mountGen = scheduleDrawerState && scheduleDrawerState.mountGen;
  var bookingKey = (typeof scheduleDrawerBookingKey === 'function')
    ? scheduleDrawerBookingKey(row)
    : (scheduleDrawerState && scheduleDrawerState.activeBookingKey) || null;
  function saveStillActive() {
    if (typeof scheduleDrawerIsRequestActive === 'function'
      && !scheduleDrawerIsRequestActive(openGen, bookingKey)) return false;
    if (scheduleDrawerState && mountGen != null
      && scheduleDrawerState.mountGen !== mountGen) return false;
    return true;
  }
  var payload = scheduleReadDrawerEditPayload();
  var saveBtn = el('ps-drawer-save');
  var msg = el('ps-drawer-save-msg');
  var gate = scheduleDrawerValidateEditPayload(payload);
  if (!gate.ok) {
    if (msg) {
      msg.className = 'state-msg error';
      msg.textContent = portalT(gate.errorKey || 'schedule.create.guestRequired');
      msg.style.display = 'block';
    }
    scheduleDrawerSyncFooter();
    return;
  }
  scheduleDrawerSaveInFlight = true;
  if (saveBtn) saveBtn.disabled = true;
  if (msg) msg.style.display = 'none';
  fetch('/staff/schedule/bookings?client=' + encodeURIComponent(getClient()) + sunsetLocationQuerySuffix(), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ booking_id: row.booking_id }, payload)),
  }).then(function(r) {
    return r.json().then(function(data) { return { ok: r.ok, data: data }; });
  }).then(function(res) {
    if (!saveStillActive()) return null;
    if (!res.ok || !res.data || res.data.success !== true) {
      var human = scheduleDrawerHumanSaveError(res.data, 'Save failed');
      throw new Error(human);
    }
    scheduleDrawerPriceStale = false;
    var refetch = (typeof scheduleFetchDrawerContext === 'function')
      ? scheduleFetchDrawerContext(row)
      : schedulePortalFetchDrawerDetail(row);
    return refetch.then(function(detail) {
      if (!saveStillActive()) return null;
      if (!detail || !detail.success) throw new Error((detail && (detail.error || detail.reason_code)) || 'Refetch failed');
      scheduleDrawerState.ctx = scheduleCloneDrawerCtx(detail);
      scheduleDrawerState.editing = false;
      scheduleMountDrawerBody(scheduleDrawerState.row, scheduleDrawerState.ctx, false);
      if (msg) {
        msg.className = 'state-msg success';
        msg.textContent = portalT('schedule.drawer.saved');
        msg.style.display = 'block';
      }
      loadSchedulePage();
    });
  }).catch(function(err) {
    if (!saveStillActive()) return;
    if (msg) {
      msg.className = 'state-msg error';
      msg.textContent = portalT('schedule.drawer.saveFailed') + ' ' + String(err.message || err);
      msg.style.display = 'block';
      if (/paid_booking_reprice|already paid|payment adjustment/i.test(String(err.message || ''))) {
        msg.dataset.reprice = '1';
      }
    }
  }).finally(function() {
    scheduleDrawerSaveInFlight = false;
    if (saveStillActive()) scheduleDrawerSyncFooter();
  });
}

function scheduleWireEditableDrawer(row, ctx) {
  var group = scheduleFindGroupForRow(row) || row;
  // Capture booking/mount generation so late catalog callbacks cannot mutate another booking.
  var openGen = scheduleDrawerState && scheduleDrawerState.openGen;
  var mountGen = scheduleDrawerState && scheduleDrawerState.mountGen;
  var bookingKey = (typeof scheduleDrawerBookingKey === 'function')
    ? scheduleDrawerBookingKey(row)
    : (scheduleDrawerState && scheduleDrawerState.activeBookingKey) || null;
  function editMountStillActive() {
    if (typeof scheduleDrawerIsRequestActive === 'function'
      && !scheduleDrawerIsRequestActive(openGen, bookingKey)) return false;
    if (scheduleDrawerState && mountGen != null
      && scheduleDrawerState.mountGen !== mountGen) return false;
    return true;
  }
  scheduleWireDrawerHeaderActions();
  // Create-parity chrome: compact date range + activity buttons + drill-down.
  if (typeof scheduleWireDrawerDateRange === 'function') scheduleWireDrawerDateRange();
  if (typeof scheduleWireDrawerMainActivityButtons === 'function') scheduleWireDrawerMainActivityButtons();
  scheduleDrawerSeedCustomLinesFromCtx(ctx || {});
  scheduleDrawerRenderCustomLines();
  scheduleWireDrawerCustomLines();
  scheduleDrawerSetCustomLineEditorOpen(false);
  scheduleDrawerSeedAccommodationFromCtx(ctx || {});
  scheduleWireDrawerAccommodation();
  scheduleFetchLessonTimesConfig(getClient()).then(function() {
    if (!editMountStillActive()) return;
    // After catalog load: seed drill-down view + course list from booking.
    if (typeof scheduleDrawerSeedMainActivityView === 'function') scheduleDrawerSeedMainActivityView();
    scheduleDrawerPopulateComponentFields();
    scheduleRenderDrawerRentals();
    scheduleRefreshDrawerFullDayAddon();
    scheduleDrawerRefreshDurationConfirm();
    scheduleDrawerSyncFooter();
    if (typeof scheduleEnhanceIntSteppersIn === 'function') {
      scheduleEnhanceIntSteppersIn(el('ps-drawer-edit-form') || el('ps-drawer-body'));
    }
  });
  // Seed view immediately (radios already checked in HTML) before catalog arrives.
  if (typeof scheduleDrawerSeedMainActivityView === 'function') scheduleDrawerSeedMainActivityView();
  scheduleDrawerPopulateComponentFields();
  if (typeof scheduleEnhanceIntSteppersIn === 'function') {
    scheduleEnhanceIntSteppersIn(el('ps-drawer-edit-form') || el('ps-drawer-body'));
  }
  ['ps-drawer-comp-course', 'ps-drawer-comp-private-lesson', 'ps-drawer-comp-no-lesson'].forEach(function(id) {
    var node = el(id);
    if (node) node.addEventListener('change', function() { scheduleDrawerOnComponentChange(id); });
  });
  var backBtn = el('ps-drawer-main-activity-back');
  if (backBtn && !backBtn.dataset.wired) {
    backBtn.dataset.wired = '1';
    backBtn.addEventListener('click', function() {
      // Back is draft-only — never writes persisted booking values.
      if (typeof scheduleDrawerExitMainActivityDrilldown === 'function') {
        scheduleDrawerExitMainActivityDrilldown({ clearCourse: true, clearPrivate: true });
      }
      scheduleDrawerMarkPriceStale();
      scheduleDrawerPopulateComponentFields();
    });
  }
  var equipmentField = el('ps-drawer-course-equipment');
  if (equipmentField && !equipmentField.dataset.multiWired) {
    equipmentField.dataset.multiWired = '1';
    equipmentField.addEventListener('change', function(event) {
      var item = event.target && event.target.closest && event.target.closest('.portal-schedule-course-equipment-item');
      if (!item) return;
      var check = item.querySelector('[data-course-equipment-enabled]');
      if (event.target === check) {
        var modes = item.querySelector('.portal-schedule-course-equipment-modes');
        if (modes) { modes.hidden = !check.checked; modes.style.display = check.checked ? '' : 'none'; }
        item.querySelectorAll('[data-drawer-course-equipment-mode]').forEach(function(button) {
          button.setAttribute('aria-pressed', check.checked && button.getAttribute('data-drawer-course-equipment-mode') === 'during_course' ? 'true' : 'false');
        });
        var setsOnCheck = item.querySelector('.portal-schedule-course-equipment-sets');
        if (setsOnCheck) { setsOnCheck.hidden = true; setsOnCheck.style.display = 'none'; }
        // Historical/unavailable: removable once, never newly selectable after uncheck.
        if (!check.checked && (item.classList.contains('is-unavailable') || item.getAttribute('data-legacy-empty') === '1')) {
          check.disabled = true;
        }
      }
      scheduleDrawerMarkPriceStale(); scheduleDrawerSyncFooter();
    });
    equipmentField.addEventListener('click', function(event) {
      var button = event.target && event.target.closest && event.target.closest('[data-drawer-course-equipment-mode]');
      if (!button) return;
      var item = button.closest('.portal-schedule-course-equipment-item');
      var enable = item && item.querySelector('[data-course-equipment-enabled]');
      if (enable && !enable.checked) return;
      item.querySelectorAll('[data-drawer-course-equipment-mode]').forEach(function(peer) { peer.setAttribute('aria-pressed', peer === button ? 'true' : 'false'); });
      var sets = item.querySelector('.portal-schedule-course-equipment-sets');
      var allDay = button.getAttribute('data-drawer-course-equipment-mode') === 'all_day';
      if (sets) { sets.hidden = !allDay; sets.style.display = allDay ? '' : 'none'; }
      // Re-render keeps During qty locked to surfers and All Day sets visible state consistent.
      scheduleDrawerMarkPriceStale();
      scheduleRefreshDrawerFullDayAddon();
      scheduleDrawerSyncFooter();
    });
  }
  // Multi-item equipment is owned by #ps-drawer-course-equipment event delegation above.
  // Legacy singleton IDs (ps-drawer-equipment-enabled / quantity / sets-qty) are no longer rendered.
  ['ps-drawer-date-from', 'ps-drawer-date-to', 'ps-drawer-course-qty', 'ps-drawer-private-lesson-surfers', 'ps-drawer-surfers'].forEach(function(id) {
    var node = el(id);
    if (!node) return;
    var fire = function() {
      if (!editMountStillActive()) return;
      scheduleDrawerMarkPriceStale();
      if (id === 'ps-drawer-surfers' || id === 'ps-drawer-course-qty' || id === 'ps-drawer-private-lesson-surfers') {
        // Keep hidden rental mirrors + serialized qty in lockstep with booking Surfers.
        scheduleDrawerSyncRentalQtyFromSurfers();
      }
      if (id === 'ps-drawer-date-from' || id === 'ps-drawer-date-to') {
        if (typeof scheduleSyncDrawerDateRangeUi === 'function') scheduleSyncDrawerDateRangeUi();
        if (scheduleDrawerMainActivityValue() === 'private') scheduleDrawerSyncPrivateSessions({ skipCtxSeed: true });
        if (scheduleDrawerMainActivityValue() === 'group'
          && typeof scheduleDrawerPopulateCourseSelect === 'function') {
          scheduleDrawerPopulateCourseSelect();
        }
        scheduleDrawerRefreshDurationConfirm();
        scheduleDrawerRefreshWhenSummary();
        scheduleRenderDrawerRentals();
      }
      scheduleRefreshDrawerFullDayAddon();
      scheduleDrawerSyncFooter();
    };
    node.addEventListener('change', fire);
    node.addEventListener('input', fire);
  });
  var guestNode = el('ps-drawer-guest');
  if (guestNode) {
    guestNode.addEventListener('input', scheduleDrawerSyncFooter);
    guestNode.addEventListener('change', scheduleDrawerSyncFooter);
  }
  scheduleWireDrawerStripeCopyOpen(ctx);
  scheduleWireDrawerConversation(row, group);
  scheduleWireDrawerOpenCustomer();
  scheduleWireDrawerManualPayment(row);
  scheduleLoadDrawerWaiver(ctx);
  scheduleWireDrawerDeleteBooking();
  var saveBtn = el('ps-drawer-save');
  if (saveBtn) saveBtn.addEventListener('click', function() {
    if (!editMountStillActive()) return;
    scheduleSaveDrawerBooking(row);
  });
  var cancelBtn = el('ps-drawer-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', function() { scheduleCancelDrawerEditMode(); });
  var stripeBtn = el('ps-drawer-stripe-link');
  if (stripeBtn) stripeBtn.addEventListener('click', function() {
    if (!editMountStillActive()) return;
    scheduleCreateDrawerStripeLink(row);
  });
  scheduleDrawerSyncFooter();
}

function scheduleDrawerResetQuoteRuntime(){
  try { scheduleDrawerQuoteState = null; } catch (_s) { /* ignore */ }
  try { scheduleDrawerQuoteGen = (Number(scheduleDrawerQuoteGen) || 0) + 1; } catch (_g) { /* ignore */ }
  try {
    if (typeof scheduleDrawerQuoteTimer !== 'undefined' && scheduleDrawerQuoteTimer != null) {
      clearTimeout(scheduleDrawerQuoteTimer);
      scheduleDrawerQuoteTimer = null;
    }
  } catch (_t) { /* ignore */ }
  try {
    if (typeof scheduleDrawerQuoteAbort !== 'undefined' && scheduleDrawerQuoteAbort) {
      scheduleDrawerQuoteAbort.abort();
      scheduleDrawerQuoteAbort = null;
    }
  } catch (_a) { /* ignore */ }
}
function scheduleEnterDrawerEditMode(){
  if(!scheduleDrawerState.row||!scheduleDrawerState.ctx) return;
  scheduleDrawerState.editing=true; scheduleDrawerPriceStale=false;
  scheduleDrawerResetQuoteRuntime();
  scheduleMountDrawerBody(scheduleDrawerState.row,scheduleDrawerState.ctx,true);
}
function scheduleCancelDrawerEditMode(){
  if(!scheduleDrawerState.row||!scheduleDrawerState.ctx) return;
  scheduleDrawerState.editing=false; scheduleDrawerPriceStale=false;
  scheduleDrawerResetQuoteRuntime();
  scheduleMountDrawerBody(scheduleDrawerState.row,scheduleDrawerState.ctx,false);
}
