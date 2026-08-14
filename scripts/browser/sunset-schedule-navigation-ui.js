'use strict';

/**
 * Sunset Schedule — navigation state + toolbar lifecycle (Slice 21 → runtime.nav, Slice 24B).
 *
 * Compatibility wrappers only. Implementation lives on SunsetScheduleRuntime.nav.
 * Nav state is private inside the runtime closure — no stateRef / global aliases.
 */

function scheduleNormalizeNavigationMode(mode) { return SunsetScheduleRuntime.nav.normalizeMode(mode); }
function scheduleValidateNavigationIso(iso) { return SunsetScheduleRuntime.nav.validateIso(iso); }
function scheduleNavigationRangeStartFromOffset(forwardOffset) {
  var off = Number(forwardOffset);
  if (!isFinite(off)) off = 0;
  off = Math.trunc(off);
  return scheduleAddDays(scheduleParseIso(scheduleTodayIso()), off);
}
function scheduleNavigationRangeStartFromSnapshot(snap) {
  snap = snap || scheduleGetNavigationSnapshot();
  var off = Number(snap.forwardOffset);
  if (!isFinite(off)) off = 0;
  off = Math.trunc(off);
  return scheduleAddDays(scheduleParseIso(scheduleTodayIso()), off);
}
function scheduleGetNavigationSnapshot(loadGenOverride) {
  return SunsetScheduleRuntime.nav.getSnapshot(loadGenOverride);
}
function scheduleCurrentViewMode() { return SunsetScheduleRuntime.nav.currentViewMode(); }
function scheduleNavigationLoadGen() { return SunsetScheduleRuntime.nav.loadGen(); }
function scheduleRangeStartDate() { return SunsetScheduleRuntime.nav.rangeStartDate(); }
function scheduleActiveDayIso() { return SunsetScheduleRuntime.nav.activeDayIso(); }
function scheduleNavigationStep(mode) {
  if (mode === 'next30') return 30;
  if (mode === 'week') return 7;
  return 1;
}
function scheduleNavigationBumpLoad() { return SunsetScheduleRuntime.nav.bumpLoad(); }
function scheduleRequestPageLoad() { return SunsetScheduleRuntime.nav.requestPageLoad(); }
function scheduleApplyNavigationPresentation(snap) { return SunsetScheduleRuntime.nav.applyPresentation(snap); }
function setScheduleView(mode) { return SunsetScheduleRuntime.nav.setView(mode); }
function scheduleNavigatePrev() { return SunsetScheduleRuntime.nav.navigatePrev(); }
function scheduleNavigateNext() { return SunsetScheduleRuntime.nav.navigateNext(); }
function scheduleNavigateToday() { return SunsetScheduleRuntime.nav.navigateToday(); }
function scheduleOpenDayDetail(iso) { return SunsetScheduleRuntime.nav.openDayDetail(iso); }
if (typeof window !== 'undefined') window.scheduleOpenDayDetail = scheduleOpenDayDetail;
function scheduleWireScheduleNavigationControls() { return SunsetScheduleRuntime.nav.wireControls(); }
function scheduleResetNavigationAfterBookingCreate() {
  return SunsetScheduleRuntime.nav.resetAfterBookingCreate();
}
