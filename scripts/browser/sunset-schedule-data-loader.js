'use strict';

/**
 * Sunset Schedule — data loader + canonical row cache (Slice 22).
 *
 * Injected after navigation module. Owns authenticated fetch orchestration,
 * loading/error lifecycle, stale-generation guards, and canonical row cache.
 *
 * Does not own navigation state, domain normalization, aggregates, or grid rendering.
 *
 * Requires: scheduleNavigationLoadGen, scheduleRequestPageLoad, getClient, getPortalProfile,
 * renderScheduleSchoolContext, scheduleTodayIso, scheduleParseIso, scheduleAddDays,
 * scheduleIsoDate, sunsetLocationQuerySuffix, inboxClientQuery, scheduleFetchLessonTimesConfig,
 * scheduleNormalizeLoadedScheduleResponse, scheduleBuildLoadedViewModel, scheduleRenderLoadedViewModel, portalT, el, fetch.
 */

var scheduleDataLoaderState = {
  rowsSnapshot: [],
  loadSnapshot: null,
};

function scheduleCloneRow(row) {
  if (!row) return null;
  try { return JSON.parse(JSON.stringify(row)); } catch (_) { return Object.assign({}, row); }
}

function scheduleCloneRows(rows) {
  return (rows || []).map(scheduleCloneRow);
}

function scheduleGetRowsSnapshot() {
  return scheduleCloneRows(scheduleDataLoaderState.rowsSnapshot);
}

function scheduleCurrentLoadSnapshot() {
  if (!scheduleDataLoaderState.loadSnapshot) return null;
  return Object.assign({}, scheduleDataLoaderState.loadSnapshot);
}

function scheduleReplaceRowsSnapshot(rows, navSnapshot) {
  scheduleDataLoaderState.rowsSnapshot = scheduleCloneRows(rows);
  scheduleDataLoaderState.loadSnapshot = navSnapshot ? Object.assign({}, navSnapshot) : null;
}

function scheduleIsLoadActive(loadGen) {
  return loadGen === scheduleNavigationLoadGen();
}

function scheduleFindCachedRowByBookingId(bookingId) {
  var id = String(bookingId || '').trim();
  if (!id) return null;
  var matches = (scheduleDataLoaderState.rowsSnapshot || []).filter(function(r) {
    return String(r.booking_id || '').trim() === id;
  });
  if (matches.length !== 1) return null;
  return scheduleCloneRow(matches[0]);
}

function scheduleFindCachedRowByBookingCode(bookingCode) {
  var code = String(bookingCode || '').trim();
  if (!code) return null;
  var matches = (scheduleDataLoaderState.rowsSnapshot || []).filter(function(r) {
    return String(r.booking_code || '').trim() === code;
  });
  if (matches.length !== 1) return null;
  return scheduleCloneRow(matches[0]);
}

function scheduleFindRowById(id) {
  if (!id) return null;
  var row = (scheduleDataLoaderState.rowsSnapshot || []).find(function(r) { return r._scheduleId === id; });
  return scheduleCloneRow(row);
}

function scheduleLoaderNormalizeMode(mode) {
  if (mode === 'day' || mode === 'week' || mode === 'next30') return mode;
  return 'day';
}

function scheduleLoaderShowLoading(stateNode) {
  if (!stateNode) return;
  stateNode.textContent = portalT('daySchedule.loading');
  stateNode.className = 'state-msg';
  stateNode.style.display = 'block';
}

function scheduleLoaderShowError(stateNode, err) {
  if (!stateNode) return;
  var msg = (err && err.message) ? String(err.message) : String(err || '');
  stateNode.textContent = portalT('daySchedule.error') + ' ' + msg;
  stateNode.className = 'state-msg error';
  stateNode.style.display = 'block';
}

function scheduleLoaderHideState(stateNode) {
  if (stateNode) stateNode.style.display = 'none';
}

function scheduleFetchDay(client, dateIso) {
  if (client === 'sunset') {
    return fetch('/staff/schedule/day?client=sunset&date=' + encodeURIComponent(dateIso) + sunsetLocationQuerySuffix())
      .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function(data){
        var rows = (data && data.rows) || [];
        rows.forEach(function(r){
          if (!r._scheduleType) {
            if (/course/.test(String((r.metadata && r.metadata.component) || r.service_type || ''))) r._scheduleType = 'course';
            else if (/private_lesson/.test(String((r.metadata && r.metadata.component) || r.service_type || ''))) r._scheduleType = 'private_lesson';
            else if (/lesson|surf_lesson/.test(String(r.service_type || ''))) r._scheduleType = 'lesson';
            else r._scheduleType = 'rental';
          }
          if (r.service_time_local && !r.service_time) r.service_time = r.service_time_local;
          r.service_date = r.service_date || dateIso;
        });
        var lessons = rows.filter(function(r){ return r._scheduleType === 'lesson'; });
        var gear = rows.filter(function(r){ return r._scheduleType === 'rental'; });
        return { dateIso: dateIso, lessons: lessons, gear: gear, rows: rows };
      });
  }
  var base = '/staff/query?client=' + encodeURIComponent(client) + '&date=' + encodeURIComponent(dateIso);
  return Promise.all([
    fetch(base + '&intent=services.lessons_today').then(function(r){ return r.json(); }),
    fetch(base + '&intent=services.gear_today').then(function(r){ return r.json(); }),
  ]).then(function(res){
    var lessons = (res[0] && res[0].rows) || [];
    var gear = (res[1] && res[1].rows) || [];
    lessons.forEach(function(r){ r._scheduleType = 'lesson'; r.service_date = r.service_date || dateIso; });
    gear.forEach(function(r){ r._scheduleType = 'rental'; r.service_date = r.service_date || dateIso; });
    return { dateIso: dateIso, lessons: lessons, gear: gear, rows: lessons.concat(gear) };
  });
}

function scheduleFetchWeek(client, weekStart) {
  var days = [];
  for (var i = 0; i < 7; i++) days.push(scheduleAddDays(weekStart, i));
  return Promise.all(days.map(function(d){ return scheduleFetchDay(client, scheduleIsoDate(d)); }));
}

function scheduleFetchNext30(client, startDate) {
  var days = [];
  for (var i = 0; i < 30; i++) days.push(scheduleAddDays(startDate, i));
  return Promise.all(days.map(function(d){ return scheduleFetchDay(client, scheduleIsoDate(d)); }));
}

function scheduleLoaderSelectDataPromise(client, mode, rangeStart) {
  if (mode === 'next30') return scheduleFetchNext30(client, rangeStart);
  return scheduleFetchWeek(client, rangeStart);
}

function loadSchedulePage(navSnapshot) {
  if (!navSnapshot) return scheduleRequestPageLoad();
  var client = getClient();
  var profile = getPortalProfile(client);
  if (!profile.is_surf_vertical) return;
  renderScheduleSchoolContext();
  var mode = scheduleLoaderNormalizeMode(navSnapshot.mode);
  var forwardOffset = Number(navSnapshot.forwardOffset);
  if (!isFinite(forwardOffset) || forwardOffset < 0) forwardOffset = 0;
  var loadGen = navSnapshot.loadGen != null ? navSnapshot.loadGen : scheduleNavigationLoadGen();
  var snap = Object.assign({}, navSnapshot, { mode: mode, forwardOffset: forwardOffset, loadGen: loadGen });
  var state = el('ps-state');
  scheduleLoaderShowLoading(state);
  var rangeStart = scheduleAddDays(scheduleParseIso(snap.todayIso || scheduleTodayIso()), forwardOffset);
  var convP = fetch('/staff/conversations' + inboxClientQuery())
    .then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; });
  var configP = scheduleFetchLessonTimesConfig(client);
  var dataP = scheduleLoaderSelectDataPromise(client, mode, rangeStart);
  return Promise.all([convP, dataP, configP]).then(function(results){
    if (!scheduleIsLoadActive(loadGen)) return;
    var viewModel = scheduleBuildLoadedViewModel(results[1], results[0], profile, rangeStart, snap);
    if (!scheduleIsLoadActive(loadGen)) return;
    scheduleReplaceRowsSnapshot(viewModel.canonicalRows || viewModel.rows, snap);
    scheduleRenderLoadedViewModel(viewModel, loadGen, snap);
    scheduleLoaderHideState(state);
  }).catch(function(e){
    if (!scheduleIsLoadActive(loadGen)) return;
    scheduleLoaderShowError(state, e);
  });
}
