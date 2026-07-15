'use strict';

/**
 * Sunset Schedule — closure-scoped runtime container (Slice 24).
 *
 * Owns navigation state, load generation, and canonical row cache.
 * Exposes runtime.rows, runtime.load, runtime.nav — not attached to window.
 *
 * Migrated: row normalizer, data loader, navigation UI (implementation lives here).
 * Compatibility globals are defined in the thin module files injected after this script.
 */

var SunsetScheduleRuntime = (function scheduleRuntimeFactory() {
  var navState = {
    mode: 'day',
    forwardOffset: 0,
    navigationGen: 0,
    loadGen: 0,
  };

  var loaderState = {
    rowsSnapshot: [],
    loadSnapshot: null,
  };

  // ── rows (canonical normalization) ─────────────────────────────────────

  function rowClone(raw) {
    if (!raw) return null;
    try { return JSON.parse(JSON.stringify(raw)); } catch (_) { return Object.assign({}, raw); }
  }

  function rowFreeze(row) {
    if (!row || typeof row !== 'object') return row;
    try { return Object.freeze(row); } catch (_) { return row; }
  }

  function rowMetaParse(row) {
    if (!row) return {};
    if (row.metadata && typeof row.metadata === 'object') return row.metadata;
    if (row.metadata) {
      try { return JSON.parse(row.metadata); } catch (_) { return {}; }
    }
    return {};
  }

  function ensureRowMeta(row) {
    if (!row || typeof row !== 'object') return row;
    if (row._meta && typeof row._meta === 'object') return row;
    row._meta = rowMetaParse(row);
    return row;
  }

  function rowMeta(row) {
    if (!row) return {};
    if (row._meta && typeof row._meta === 'object') return row._meta;
    var meta = rowMetaParse(row);
    if (Object.isFrozen(row)) return meta;
    row._meta = meta;
    return meta;
  }

  function rowIsPrivateLesson(row) {
    if (!row) return false;
    if (row._scheduleType === 'private_lesson') return true;
    var meta = rowMetaParse(row);
    if (String(meta.component || row.metadata_component || '').toLowerCase() === 'private_lesson') return true;
    if (String(meta.staff_ui_service_type || row.staff_ui_service_type || '').toLowerCase() === 'private_lesson') return true;
    return String(row.service_type || '').toLowerCase() === 'private_lesson';
  }

  function rowIsCourse(row) {
    if (!row) return false;
    var meta = rowMetaParse(row);
    if (String(meta.component || '').toLowerCase() === 'course') return true;
    if (String(meta.staff_ui_service_type || '').toLowerCase() === 'course') return true;
    var ui = String(row.staff_ui_service_type || meta.staff_ui_service_type || row.service_type || '').toLowerCase();
    return ui === 'course' || row._scheduleType === 'course';
  }

  function rowEffectivePaid(r) {
    if (!r) return false;
    if (String(r.booking_payment_status || '').toLowerCase() === 'paid') return true;
    var paid = Number(r.booking_amount_paid_cents || 0);
    var bal = r.booking_balance_due_cents;
    return paid > 0 && bal != null && Number(bal) <= 0;
  }

  function deriveStableRowId(row, meta) {
    if (!row) return 'row:missing';
    if (row.service_record_id) return String(row.service_record_id);
    if (row._scheduleId && String(row._scheduleId).indexOf('demo-') === 0) return String(row._scheduleId);
    var bookingId = String(row.booking_id || '').trim();
    var dateIso = String(row.service_date || '').slice(0, 10);
    var component = String(meta.component || row.staff_ui_service_type || row.service_type || 'svc').toLowerCase();
    if (bookingId && dateIso) return 'bk:' + bookingId + ':' + dateIso + ':' + component;
    if (bookingId) return 'bk:' + bookingId;
    return 'row:' + dateIso + ':' + component + ':' + String(row.booking_code || 'anon').trim();
  }

  function ensureRowId(row) {
    if (!row) return row;
    if (!row._scheduleId) {
      var meta = rowMetaParse(row);
      row._scheduleId = deriveStableRowId(row, meta);
    }
    return row;
  }

  function rowSourceKind(row) {
    if (row && row._isDemo) return 'demo';
    if (row && (row._isDbManual || row.record_source === 'staff_manual')) return 'staff';
    if (row && (row._isLuna || row.record_source === 'luna_guest' || row.record_source === 'stripe')) return 'luna';
    return 'unknown';
  }

  function normalizerApplyTrustFlags(r, ctx) {
    ctx = ctx || {};
    var trustedLocation = ctx.locationId || ctx.location_id || null;
    var meta = rowMetaParse(r);
    var rowLocation = r.location_id || meta.location_id || null;
    if (trustedLocation && rowLocation && String(rowLocation) !== String(trustedLocation)) {
      r._canonicalBlocked = true;
      r._canonicalBlockReason = 'location_conflict';
    }
    if (!String(r.booking_id || '').trim() && !r._isDemo) {
      r._canonicalBlocked = true;
      r._canonicalBlockReason = r._canonicalBlockReason || 'missing_booking_id';
    }
    if (r.record_source === 'staff_manual') r._isDbManual = true;
    else if (r.record_source === 'luna_guest' || r.record_source === 'stripe') r._isLuna = true;
    r._trustSource = rowSourceKind(r);
    return r;
  }

  function normalizerApplyDisplayFields(r) {
    var meta = rowMetaParse(r);
    if (!r.slot_time) r.slot_time = meta.slot_time || null;
    if (!r.notes) r.notes = r.notes || meta.notes || null;
    if (r.needs_reply === true || r.needs_reply === 't') r._needsReply = true;
    if (meta.component) r.component = meta.component;
    if (String(meta.component || '').toLowerCase() === 'course' || String(meta.staff_ui_service_type || '').toLowerCase() === 'course') {
      r._scheduleType = 'course';
    } else if (String(meta.component || '').toLowerCase() === 'private_lesson' || String(meta.staff_ui_service_type || '').toLowerCase() === 'private_lesson') {
      r._scheduleType = 'private_lesson';
    } else if (String(meta.component || '').toLowerCase() === 'lesson' || String(meta.staff_ui_service_type || '').toLowerCase() === 'lesson') {
      r._scheduleType = 'lesson';
    }
    if (meta.lesson_category) r.lesson_category = meta.lesson_category;
    if (meta.course_id) r.course_id = meta.course_id;
    if (meta.course_label) r.course_label = meta.course_label;
    if (rowIsCourse(r)) r._scheduleType = 'course';
    if (rowIsPrivateLesson(r)) r._scheduleType = 'private_lesson';
    if (meta.bundle_id) r.bundle_id = meta.bundle_id;
    if (r.staff_ui_service_type) r.service_type = r.staff_ui_service_type;
    if (!r._scheduleType) {
      if (/lesson|surf_lesson/.test(String(r.service_type || ''))) r._scheduleType = 'lesson';
      else r._scheduleType = 'rental';
    }
    if (r._needsReply == null) r._needsReply = false;
    if (!r.phone && meta.guest_phone) r.phone = meta.guest_phone;
    if (r.service_time_local && !r.service_time) r.service_time = r.service_time_local;
    var ps = String(r.payment_status || '').toLowerCase();
    if (rowEffectivePaid(r)) r.payment_status = 'paid';
    else if (ps === 'pending' || ps === 'waiting_payment' || ps === 'not_requested') r.payment_status = 'unpaid';
    return r;
  }

  function normalizeApiRow(raw, ctx, opts) {
    if (!raw || typeof raw !== 'object') return null;
    opts = opts || {};
    var r = rowClone(raw);
    if (!r) return null;
    ensureRowId(r);
    if (r.service_record_id) r._scheduleId = String(r.service_record_id);
    normalizerApplyDisplayFields(r);
    normalizerApplyTrustFlags(r, ctx);
    ensureRowMeta(r);
    if (opts.freeze === false) return r;
    return rowFreeze(r);
  }

  function normalizeApiRowsBatch(rawRows, ctx) {
    var pending = [];
    var presentationOnlyRows = [];
    var errors = [];
    var serviceRecordIndex = {};

    (rawRows || []).forEach(function(raw, idx) {
      if (!raw || typeof raw !== 'object') {
        errors.push({ index: idx, reason: 'malformed_record' });
        return;
      }
      try {
        var norm = normalizeApiRow(raw, ctx, { freeze: false });
        if (!norm) {
          errors.push({ index: idx, reason: 'normalize_failed' });
          return;
        }
        var srKey = norm.service_record_id ? String(norm.service_record_id) : null;
        if (srKey && serviceRecordIndex[srKey]) return;
        if (srKey) serviceRecordIndex[srKey] = norm._scheduleId;
        pending.push(norm);
      } catch (_) {
        errors.push({ index: idx, reason: 'normalize_exception' });
      }
    });

    var bookingCodeToId = {};
    var bookingIdLocation = {};
    pending.forEach(function(norm) {
      var code = String(norm.booking_code || '').trim();
      var bid = String(norm.booking_id || '').trim();
      if (code) {
        if (bookingCodeToId[code] && bookingCodeToId[code] !== bid) {
          norm._canonicalBlocked = true;
          norm._canonicalBlockReason = norm._canonicalBlockReason || 'booking_code_conflict';
          pending.forEach(function(other) {
            if (String(other.booking_code || '').trim() === code) {
              other._canonicalBlocked = true;
              other._canonicalBlockReason = other._canonicalBlockReason || 'booking_code_conflict';
            }
          });
        }
        if (!bookingCodeToId[code]) bookingCodeToId[code] = bid;
      }
      if (bid) {
        var loc = String(norm.location_id || '').trim();
        if (bookingIdLocation[bid] && loc && bookingIdLocation[bid] !== loc) {
          norm._canonicalBlocked = true;
          norm._canonicalBlockReason = 'tenant_location_conflict';
        }
        if (!bookingIdLocation[bid] && loc) bookingIdLocation[bid] = loc;
      }
    });

    var canonicalRows = pending.map(function(norm) { return rowFreeze(norm); });

    return {
      canonicalRows: canonicalRows,
      presentationOnlyRows: presentationOnlyRows,
      errors: errors,
    };
  }

  function normalizerContextFromRuntime(profile) {
    return {
      client: typeof getClient === 'function' ? getClient() : null,
      locationId: typeof getSunsetLocation === 'function' ? getSunsetLocation() : null,
      profile: profile || null,
    };
  }

  function normalizeLoadedScheduleResponse(weekData, profile, ctx) {
    ctx = ctx || normalizerContextFromRuntime(profile);
    var rawRows = [];
    (weekData || []).forEach(function(p) {
      (p.rows || []).forEach(function(r) { rawRows.push(r); });
    });
    var batch = normalizeApiRowsBatch(rawRows, ctx);
    var normByDate = {};
    batch.canonicalRows.forEach(function(r) {
      var iso = String(r.service_date || '').slice(0, 10);
      if (!iso) return;
      if (!normByDate[iso]) normByDate[iso] = [];
      normByDate[iso].push(r);
    });
    var rebuiltWeek = (weekData || []).map(function(p) {
      var iso = p.dateIso;
      var dayRows = normByDate[iso] || [];
      var lessons = dayRows.filter(function(r) {
        return r._scheduleType === 'lesson' || r._scheduleType === 'course' || r._scheduleType === 'private_lesson';
      });
      var gear = dayRows.filter(function(r) { return r._scheduleType === 'rental'; });
      return {
        dateIso: iso,
        lessons: lessons,
        gear: gear,
        rows: dayRows,
      };
    });
    return {
      weekData: rebuiltWeek,
      canonicalRows: batch.canonicalRows,
      presentationOnlyRows: [],
      errors: batch.errors,
    };
  }

  function normalizePresentationDemoRow(raw, ctx) {
    if (!raw || typeof raw !== 'object') return null;
    var r = rowClone(raw);
    r._isDemo = true;
    ensureRowId(r);
    if (!r._scheduleType) {
      if (/lesson|private_lesson|course/.test(String(r.service_type || ''))) r._scheduleType = 'lesson';
      else r._scheduleType = 'rental';
    }
    if (r._needsReply == null) r._needsReply = false;
    r._trustSource = 'demo';
    ensureRowMeta(r);
    return rowFreeze(r);
  }

  var rows = {
    clone: rowClone,
    freeze: rowFreeze,
    metaParse: rowMetaParse,
    ensureMeta: ensureRowMeta,
    meta: rowMeta,
    isPrivateLesson: rowIsPrivateLesson,
    isCourse: rowIsCourse,
    effectivePaid: rowEffectivePaid,
    deriveStableId: deriveStableRowId,
    ensureId: ensureRowId,
    sourceKind: rowSourceKind,
    applyTrustFlags: normalizerApplyTrustFlags,
    applyDisplayFields: normalizerApplyDisplayFields,
    normalizeApiRow: normalizeApiRow,
    normalizeApiRowsBatch: normalizeApiRowsBatch,
    normalizerContextFromRuntime: normalizerContextFromRuntime,
    normalizeLoadedScheduleResponse: normalizeLoadedScheduleResponse,
    normalizePresentationDemoRow: normalizePresentationDemoRow,
  };

  // ── load (fetch + canonical cache) ───────────────────────────────────────

  function loaderCloneRow(row) {
    return rowClone(row);
  }

  function loaderCloneRows(list) {
    return (list || []).map(loaderCloneRow);
  }

  function getRowsSnapshot() {
    return loaderCloneRows(loaderState.rowsSnapshot);
  }

  function currentLoadSnapshot() {
    if (!loaderState.loadSnapshot) return null;
    return Object.assign({}, loaderState.loadSnapshot);
  }

  function replaceRowsSnapshot(list, navSnapshot) {
    loaderState.rowsSnapshot = loaderCloneRows(list);
    loaderState.loadSnapshot = navSnapshot ? Object.assign({}, navSnapshot) : null;
  }

  function isLoadActive(loadGen) {
    return loadGen === navState.loadGen;
  }

  function findCachedRowByBookingId(bookingId) {
    var id = String(bookingId || '').trim();
    if (!id) return null;
    var matches = (loaderState.rowsSnapshot || []).filter(function(r) {
      return String(r.booking_id || '').trim() === id;
    });
    if (matches.length !== 1) return null;
    return loaderCloneRow(matches[0]);
  }

  function findCachedRowByBookingCode(bookingCode) {
    var code = String(bookingCode || '').trim();
    if (!code) return null;
    var matches = (loaderState.rowsSnapshot || []).filter(function(r) {
      return String(r.booking_code || '').trim() === code;
    });
    if (matches.length !== 1) return null;
    return loaderCloneRow(matches[0]);
  }

  function findRowById(id) {
    if (!id) return null;
    var row = (loaderState.rowsSnapshot || []).find(function(r) { return r._scheduleId === id; });
    return loaderCloneRow(row);
  }

  function loaderNormalizeMode(mode) {
    if (mode === 'day' || mode === 'week' || mode === 'next30') return mode;
    return 'day';
  }

  function loaderShowLoading(stateNode) {
    if (!stateNode) return;
    stateNode.textContent = portalT('daySchedule.loading');
    stateNode.className = 'state-msg';
    stateNode.style.display = 'block';
  }

  function loaderShowError(stateNode, err) {
    if (!stateNode) return;
    var msg = (err && err.message) ? String(err.message) : String(err || '');
    stateNode.textContent = portalT('daySchedule.error') + ' ' + msg;
    stateNode.className = 'state-msg error';
    stateNode.style.display = 'block';
  }

  function loaderHideState(stateNode) {
    if (stateNode) stateNode.style.display = 'none';
  }

  function fetchDay(client, dateIso) {
    if (client === 'sunset') {
      return fetch('/staff/schedule/day?client=sunset&date=' + encodeURIComponent(dateIso) + sunsetLocationQuerySuffix())
        .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function(data){
          var dayRows = (data && data.rows) || [];
          dayRows.forEach(function(r){
            if (!r._scheduleType) {
              if (/course/.test(String((r.metadata && r.metadata.component) || r.service_type || ''))) r._scheduleType = 'course';
              else if (/private_lesson/.test(String((r.metadata && r.metadata.component) || r.service_type || ''))) r._scheduleType = 'private_lesson';
              else if (/lesson|surf_lesson/.test(String(r.service_type || ''))) r._scheduleType = 'lesson';
              else r._scheduleType = 'rental';
            }
            if (r.service_time_local && !r.service_time) r.service_time = r.service_time_local;
            r.service_date = r.service_date || dateIso;
          });
          var lessons = dayRows.filter(function(r){ return r._scheduleType === 'lesson'; });
          var gear = dayRows.filter(function(r){ return r._scheduleType === 'rental'; });
          return { dateIso: dateIso, lessons: lessons, gear: gear, rows: dayRows };
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

  function fetchWeek(client, weekStart) {
    var days = [];
    for (var i = 0; i < 7; i++) days.push(scheduleAddDays(weekStart, i));
    return Promise.all(days.map(function(d){ return fetchDay(client, scheduleIsoDate(d)); }));
  }

  function fetchNext30(client, startDate) {
    var days = [];
    for (var i = 0; i < 30; i++) days.push(scheduleAddDays(startDate, i));
    return Promise.all(days.map(function(d){ return fetchDay(client, scheduleIsoDate(d)); }));
  }

  function loaderSelectDataPromise(client, mode, rangeStart) {
    if (mode === 'next30') return fetchNext30(client, rangeStart);
    return fetchWeek(client, rangeStart);
  }

  function loadPage(navSnapshot) {
    if (!navSnapshot) return nav.requestPageLoad();
    var client = getClient();
    var profile = getPortalProfile(client);
    if (!profile.is_surf_vertical) return;
    renderScheduleSchoolContext();
    var mode = loaderNormalizeMode(navSnapshot.mode);
    var forwardOffset = Number(navSnapshot.forwardOffset);
    if (!isFinite(forwardOffset) || forwardOffset < 0) forwardOffset = 0;
    var loadGen = navSnapshot.loadGen != null ? navSnapshot.loadGen : navState.loadGen;
    var snap = Object.assign({}, navSnapshot, { mode: mode, forwardOffset: forwardOffset, loadGen: loadGen });
    var stateNode = el('ps-state');
    loaderShowLoading(stateNode);
    var rangeStart = scheduleAddDays(scheduleParseIso(snap.todayIso || scheduleTodayIso()), forwardOffset);
    var convP = fetch('/staff/conversations' + inboxClientQuery())
      .then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; });
    var configP = scheduleFetchLessonTimesConfig(client);
    var dataP = loaderSelectDataPromise(client, mode, rangeStart);
    return Promise.all([convP, dataP, configP]).then(function(results){
      if (!isLoadActive(loadGen)) return;
      var viewModel = scheduleBuildLoadedViewModel(results[1], results[0], profile, rangeStart, snap);
      if (!isLoadActive(loadGen)) return;
      replaceRowsSnapshot(viewModel.canonicalRows || viewModel.rows, snap);
      scheduleRenderLoadedViewModel(viewModel, loadGen, snap);
      loaderHideState(stateNode);
    }).catch(function(e){
      if (!isLoadActive(loadGen)) return;
      loaderShowError(stateNode, e);
    });
  }

  var load = {
    cloneRow: loaderCloneRow,
    cloneRows: loaderCloneRows,
    getRowsSnapshot: getRowsSnapshot,
    currentLoadSnapshot: currentLoadSnapshot,
    replaceRowsSnapshot: replaceRowsSnapshot,
    isLoadActive: isLoadActive,
    findCachedRowByBookingId: findCachedRowByBookingId,
    findCachedRowByBookingCode: findCachedRowByBookingCode,
    findRowById: findRowById,
    normalizeMode: loaderNormalizeMode,
    fetchDay: fetchDay,
    fetchWeek: fetchWeek,
    fetchNext30: fetchNext30,
    showLoading: loaderShowLoading,
    showError: loaderShowError,
    hideState: loaderHideState,
    loadPage: loadPage,
  };
  Object.freeze(load);

  // ── nav (view mode + load generation) ────────────────────────────────────

  function normalizeNavigationMode(mode) {
    var m = String(mode || '').trim();
    if (m === 'day' || m === 'week' || m === 'next30') return m;
    return 'day';
  }

  function validateNavigationIso(iso) {
    var s = String(iso || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    return s;
  }

  function rangeStartFromOffset(forwardOffset) {
    var off = Number(forwardOffset);
    if (!isFinite(off) || off < 0) off = 0;
    return scheduleAddDays(scheduleParseIso(scheduleTodayIso()), off);
  }

  function rangeStartFromSnapshot(snap) {
    snap = snap || getNavigationSnapshot();
    return rangeStartFromOffset(snap.forwardOffset);
  }

  function getNavigationSnapshot(loadGenOverride) {
    var off = Number(navState.forwardOffset);
    if (!isFinite(off) || off < 0) off = 0;
    var rangeStart = rangeStartFromOffset(off);
    return {
      mode: normalizeNavigationMode(navState.mode),
      forwardOffset: off,
      focusDateIso: scheduleIsoDate(rangeStart),
      navigationGen: navState.navigationGen,
      loadGen: loadGenOverride != null ? loadGenOverride : navState.loadGen,
      todayIso: scheduleTodayIso(),
      rangeStartIso: scheduleIsoDate(rangeStart),
    };
  }

  function navigationStep(mode) {
    if (mode === 'next30') return 30;
    if (mode === 'week') return 7;
    return 1;
  }

  function bumpLoad() {
    navState.navigationGen += 1;
    navState.loadGen += 1;
    return navState.loadGen;
  }

  function applyNavigationPresentation(snap) {
    snap = snap || getNavigationSnapshot();
    var rangeStart = rangeStartFromOffset(snap.forwardOffset);
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

  function requestPageLoad() {
    var loadGen = bumpLoad();
    var snap = getNavigationSnapshot(loadGen);
    applyNavigationPresentation(snap);
    return load.loadPage(snap);
  }

  function setView(mode) {
    navState.mode = normalizeNavigationMode(mode);
    navState.forwardOffset = 0;
    requestPageLoad();
  }

  function navigatePrev() {
    var mode = normalizeNavigationMode(navState.mode);
    var step = navigationStep(mode);
    navState.forwardOffset = Math.max(0, (navState.forwardOffset || 0) - step);
    requestPageLoad();
  }

  function navigateNext() {
    var mode = normalizeNavigationMode(navState.mode);
    var step = navigationStep(mode);
    navState.forwardOffset = (navState.forwardOffset || 0) + step;
    requestPageLoad();
  }

  function navigateToday() {
    navState.forwardOffset = 0;
    requestPageLoad();
  }

  function openDayDetail(iso) {
    iso = validateNavigationIso(iso);
    if (!iso) return;
    var offset = scheduleDaysFromToday(iso);
    if (offset < 0) offset = 0;
    navState.mode = 'day';
    navState.forwardOffset = offset;
    requestPageLoad();
  }

  function wireNavigationControls() {
    var navIds = [
      ['ps-prev-week', navigatePrev],
      ['ps-next-week', navigateNext],
      ['ps-today', navigateToday],
      ['ps-refresh-schedule', requestPageLoad],
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
        setView(btn.getAttribute('data-ps-view'));
      });
    });
  }

  function resetAfterBookingCreate() {
    navState.mode = 'day';
    navState.forwardOffset = 0;
  }

  var nav = {
    normalizeMode: normalizeNavigationMode,
    validateIso: validateNavigationIso,
    getSnapshot: getNavigationSnapshot,
    currentViewMode: function() { return getNavigationSnapshot().mode; },
    loadGen: function() { return navState.loadGen; },
    rangeStartDate: function() { return rangeStartFromSnapshot(); },
    activeDayIso: function() {
      var snap = getNavigationSnapshot();
      if (snap.mode === 'day') return snap.focusDateIso;
      return snap.todayIso;
    },
    bumpLoad: bumpLoad,
    requestPageLoad: requestPageLoad,
    applyPresentation: applyNavigationPresentation,
    setView: setView,
    navigatePrev: navigatePrev,
    navigateNext: navigateNext,
    navigateToday: navigateToday,
    openDayDetail: openDayDetail,
    wireControls: wireNavigationControls,
    resetAfterBookingCreate: resetAfterBookingCreate,
  };
  Object.freeze(nav);

  Object.freeze(rows);
  return Object.freeze({ rows: rows, load: load, nav: nav });
})();
