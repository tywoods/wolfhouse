'use strict';

/**
 * Sunset Schedule — navigation state + toolbar lifecycle (Slice 21).
 *
 * Injected after view-grid module. Owns view mode, range offset, load generation,
 * toolbar wiring, and narrow callbacks into loadSchedulePage(snapshot).
 *
 * Does not fetch data, normalize rows, or render grids.
 *
 * Requires: dsTodayIso, scheduleTodayIso, scheduleIsoDate, scheduleParseIso,
 * scheduleAddDays, scheduleDaysFromToday, scheduleFormatRangeLabel, el, portalT,
 * loadSchedulePage, document.
 */

var scheduleNavigationState = {
  mode: 'day',
  forwardOffset: 0,
  navigationGen: 0,
  loadGen: 0,
};

function scheduleNormalizeNavigationMode(mode) {
  var m = String(mode || '').trim();
  if (m === 'day' || m === 'week' || m === 'next30') return m;
  return 'day';
}

function scheduleValidateNavigationIso(iso) {
  var s = String(iso || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function scheduleNavigationRangeStartFromOffset(forwardOffset) {
  var off = Number(forwardOffset);
  if (!isFinite(off) || off < 0) off = 0;
  return scheduleAddDays(scheduleParseIso(scheduleTodayIso()), off);
}

function scheduleNavigationRangeStartFromSnapshot(snap) {
  snap = snap || scheduleGetNavigationSnapshot();
  return scheduleNavigationRangeStartFromOffset(snap.forwardOffset);
}

function scheduleGetNavigationSnapshot(loadGenOverride) {
  var off = Number(scheduleNavigationState.forwardOffset);
  if (!isFinite(off) || off < 0) off = 0;
  var rangeStart = scheduleNavigationRangeStartFromOffset(off);
  return {
    mode: scheduleNormalizeNavigationMode(scheduleNavigationState.mode),
    forwardOffset: off,
    focusDateIso: scheduleIsoDate(rangeStart),
    navigationGen: scheduleNavigationState.navigationGen,
    loadGen: loadGenOverride != null ? loadGenOverride : scheduleNavigationState.loadGen,
    todayIso: scheduleTodayIso(),
    rangeStartIso: scheduleIsoDate(rangeStart),
  };
}

function scheduleCurrentViewMode() {
  return scheduleGetNavigationSnapshot().mode;
}

function scheduleNavigationLoadGen() {
  return scheduleNavigationState.loadGen;
}

function scheduleRangeStartDate() {
  return scheduleNavigationRangeStartFromSnapshot();
}

function scheduleActiveDayIso() {
  var snap = scheduleGetNavigationSnapshot();
  if (snap.mode === 'day') return snap.focusDateIso;
  return snap.todayIso;
}

function scheduleNavigationStep(mode) {
  if (mode === 'next30') return 30;
  if (mode === 'week') return 7;
  return 1;
}

function scheduleNavigationBumpLoad() {
  scheduleNavigationState.navigationGen += 1;
  scheduleNavigationState.loadGen += 1;
  return scheduleNavigationState.loadGen;
}

function scheduleRequestPageLoad() {
  var loadGen = scheduleNavigationBumpLoad();
  var snap = scheduleGetNavigationSnapshot(loadGen);
  scheduleApplyNavigationPresentation(snap);
  return loadSchedulePage(snap);
}

function scheduleApplyNavigationPresentation(snap) {
  snap = snap || scheduleGetNavigationSnapshot();
  var rangeStart = scheduleNavigationRangeStartFromOffset(snap.forwardOffset);
  var span = snap.mode === 'next30' ? 29 : (snap.mode === 'day' ? 0 : 6);
  var rangeEnd = scheduleAddDays(rangeStart, span);
  var labelNode = el('ps-range-label');
  if (labelNode) {
    labelNode.textContent = scheduleFormatRangeLabel(rangeStart, rangeEnd, snap.mode);
  }
  var psTodayBtn = el('ps-today');
  if (psTodayBtn) {
    var tIso = scheduleTodayIso();
    var showsToday = tIso >= scheduleIsoDate(rangeStart) && tIso <= scheduleIsoDate(rangeEnd);
    psTodayBtn.classList.toggle('btn-primary', showsToday);
    psTodayBtn.classList.toggle('btn-ghost', !showsToday);
  }
  document.querySelectorAll('.portal-schedule-view-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-ps-view') === snap.mode);
  });
}

function setScheduleView(mode) {
  scheduleNavigationState.mode = scheduleNormalizeNavigationMode(mode);
  scheduleNavigationState.forwardOffset = 0;
  scheduleRequestPageLoad();
}

function scheduleNavigatePrev() {
  var mode = scheduleCurrentViewMode();
  var step = scheduleNavigationStep(mode);
  scheduleNavigationState.forwardOffset = Math.max(0, (scheduleNavigationState.forwardOffset || 0) - step);
  scheduleRequestPageLoad();
}

function scheduleNavigateNext() {
  var mode = scheduleCurrentViewMode();
  var step = scheduleNavigationStep(mode);
  scheduleNavigationState.forwardOffset = (scheduleNavigationState.forwardOffset || 0) + step;
  scheduleRequestPageLoad();
}

function scheduleNavigateToday() {
  scheduleNavigationState.forwardOffset = 0;
  scheduleRequestPageLoad();
}

function scheduleOpenDayDetail(iso) {
  iso = scheduleValidateNavigationIso(iso);
  if (!iso) return;
  var offset = scheduleDaysFromToday(iso);
  if (offset < 0) offset = 0;
  scheduleNavigationState.mode = 'day';
  scheduleNavigationState.forwardOffset = offset;
  scheduleRequestPageLoad();
}

function scheduleWireScheduleNavigationControls() {
  var navIds = [
    ['ps-prev-week', scheduleNavigatePrev],
    ['ps-next-week', scheduleNavigateNext],
    ['ps-today', scheduleNavigateToday],
    ['ps-refresh-schedule', scheduleRequestPageLoad],
  ];
  navIds.forEach(function(pair) {
    var node = el(pair[0]);
    if (!node || !node.dataset || node.dataset.psNavWired) return;
    node.dataset.psNavWired = '1';
    node.addEventListener('click', pair[1]);
  });
  document.querySelectorAll('.portal-schedule-view-btn').forEach(function(btn) {
    if (!btn.dataset || btn.dataset.psNavWired) return;
    btn.dataset.psNavWired = '1';
    btn.addEventListener('click', function() {
      setScheduleView(btn.getAttribute('data-ps-view'));
    });
  });
}

function scheduleResetNavigationAfterBookingCreate() {
  scheduleNavigationState.mode = 'day';
  scheduleNavigationState.forwardOffset = 0;
}
