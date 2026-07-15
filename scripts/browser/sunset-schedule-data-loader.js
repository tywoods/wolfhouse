'use strict';

/**
 * Sunset Schedule — data loader + canonical row cache (Slice 22 → runtime.load, Slice 24).
 *
 * Compatibility wrappers only. Implementation lives on SunsetScheduleRuntime.load.
 */

var scheduleDataLoaderState = SunsetScheduleRuntime.load.stateRef;

function scheduleCloneRow(row) { return SunsetScheduleRuntime.load.cloneRow(row); }
function scheduleCloneRows(list) { return SunsetScheduleRuntime.load.cloneRows(list); }
function scheduleGetRowsSnapshot() { return SunsetScheduleRuntime.load.getRowsSnapshot(); }
function scheduleCurrentLoadSnapshot() { return SunsetScheduleRuntime.load.currentLoadSnapshot(); }
function scheduleReplaceRowsSnapshot(rows, navSnapshot) {
  return SunsetScheduleRuntime.load.replaceRowsSnapshot(rows, navSnapshot);
}
function scheduleIsLoadActive(loadGen) { return SunsetScheduleRuntime.load.isLoadActive(loadGen); }
function scheduleFindCachedRowByBookingId(bookingId) {
  return SunsetScheduleRuntime.load.findCachedRowByBookingId(bookingId);
}
function scheduleFindCachedRowByBookingCode(bookingCode) {
  return SunsetScheduleRuntime.load.findCachedRowByBookingCode(bookingCode);
}
function scheduleFindRowById(id) { return SunsetScheduleRuntime.load.findRowById(id); }
function scheduleLoaderNormalizeMode(mode) { return SunsetScheduleRuntime.load.normalizeMode(mode); }
function scheduleLoaderShowLoading(stateNode) { return SunsetScheduleRuntime.load.showLoading(stateNode); }
function scheduleLoaderShowError(stateNode, err) { return SunsetScheduleRuntime.load.showError(stateNode, err); }
function scheduleLoaderHideState(stateNode) { return SunsetScheduleRuntime.load.hideState(stateNode); }
function scheduleFetchDay(client, dateIso) { return SunsetScheduleRuntime.load.fetchDay(client, dateIso); }
function scheduleFetchWeek(client, weekStart) { return SunsetScheduleRuntime.load.fetchWeek(client, weekStart); }
function scheduleFetchNext30(client, startDate) { return SunsetScheduleRuntime.load.fetchNext30(client, startDate); }
function scheduleLoaderSelectDataPromise(client, mode, rangeStart) {
  if (mode === 'next30') return SunsetScheduleRuntime.load.fetchNext30(client, rangeStart);
  return SunsetScheduleRuntime.load.fetchWeek(client, rangeStart);
}
function loadSchedulePage(navSnapshot) { return SunsetScheduleRuntime.load.loadPage(navSnapshot); }
