'use strict';

/**
 * Sunset Schedule portal — canonical API / data layer (Slice 11).
 *
 * Injected into staff-query-api.js portal IIFE. View rendering lives in
 * sunset-schedule-drawer-view-ui.js (Slice 12).
 *
 * Requires portal globals: getClient, getSunsetLocation, sunsetLocationQuerySuffix,
 * portalT, escHtml, el, fetch, scheduleFindGroupForRow, scheduleRowBookingRef,
 * scheduleEnsureRowId, scheduleBuildDisplayGroups, scheduleCloneDrawerCtx,
 * scheduleMountDrawerBody, scheduleReadCreatePayload, scheduleCreateSelectedDates,
 * schedulePopulateCreateCourseTierFields, closeScheduleCreateModal, loadSchedulePage,
 * scheduleFindCachedRowByBookingCode, scheduleResetNavigationAfterBookingCreate, scheduleRequestPageLoad, scheduleTodayIso,
 * scheduleEnumerateDates, scheduleRefreshCreateFullDayAddon, scheduleUpdateFullDayAddonSummary.
 *
 */

var schedulePortalQuoteState = null;
var schedulePortalQuoteGen = 0;
var schedulePortalQuoteAbort = null;
var schedulePortalQuoteTimer = null;
var schedulePortalQuoteDebounceMs = 400;
var schedulePortalSubmitInFlight = false;
var schedulePortalSubmitIdemKey = null;
var schedulePortalSubmitIdemIntent = null;

function schedulePortalClientQuery() {
  return 'client=' + encodeURIComponent(getClient()) + sunsetLocationQuerySuffix();
}

function schedulePortalFetchJson(url, opts) {
  opts = opts || {};
  return fetch(url, opts).then(function(r) {
    return r.json().then(function(data) {
      return { ok: r.ok, status: r.status, data: data };
    });
  }).catch(function(err) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      return { ok: false, aborted: true, status: 0, data: { success: false, error: 'aborted' } };
    }
    throw err;
  });
}

function schedulePortalInvalidatePreviewWork() {
  if (schedulePortalQuoteTimer != null) {
    clearTimeout(schedulePortalQuoteTimer);
    schedulePortalQuoteTimer = null;
  }
  if (schedulePortalQuoteAbort) {
    try { schedulePortalQuoteAbort.abort(); } catch (_e) { /* ignore */ }
    schedulePortalQuoteAbort = null;
  }
  schedulePortalQuoteGen += 1;
  return schedulePortalQuoteGen;
}

function schedulePortalNewIdempotencyKey() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch (_e) { /* ignore */ }
  return 'scb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function schedulePortalNormalizeRentalsIntent(rentals) {
  if (!Array.isArray(rentals) || !rentals.length) return [];
  return rentals.map(function(r) {
    r = r || {};
    return {
      offering_key: String(r.offering_key || '').trim(),
      duration_key: String(r.duration_key || '').trim(),
      quantity: Number(r.quantity) || 0,
    };
  }).filter(function(r) { return !!r.offering_key; })
    .sort(function(a, b) { return a.offering_key < b.offering_key ? -1 : (a.offering_key > b.offering_key ? 1 : 0); });
}

function schedulePortalCreateIntentKey(payload) {
  var p = payload || {};
  var comps = p.components || {};
  var ordered = {};
  Object.keys(comps).sort().forEach(function(k) { ordered[k] = comps[k]; });
  return JSON.stringify({
    guest_name: String(p.guest_name || ''),
    guest_phone: p.guest_phone != null ? String(p.guest_phone) : '',
    date_from: p.date_from || null,
    date_to: p.date_to || null,
    payment_status: p.payment_status || 'unpaid',
    components: ordered,
    rentals: schedulePortalNormalizeRentalsIntent(p.rentals),
    notes: p.notes != null ? String(p.notes) : '',
    location_id: typeof getSunsetLocation === 'function' ? getSunsetLocation() : null,
  });
}

function schedulePortalEnsureIdempotencyKey(payload) {
  var intent = schedulePortalCreateIntentKey(payload);
  if (!schedulePortalSubmitIdemKey || schedulePortalSubmitIdemIntent !== intent) {
    schedulePortalSubmitIdemKey = schedulePortalNewIdempotencyKey();
    schedulePortalSubmitIdemIntent = intent;
    schedulePortalCreateAmbiguous = false;
  }
  return schedulePortalSubmitIdemKey;
}

function schedulePortalClearSubmitIdempotency() {
  schedulePortalSubmitIdemKey = null;
  schedulePortalSubmitIdemIntent = null;
  schedulePortalCreateAmbiguous = false;
}

function schedulePortalMadridTodayIso(refDate) {
  var d = refDate || new Date();
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch (_e) {
    return typeof scheduleTodayIso === 'function' ? scheduleTodayIso() : (d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
  }
}

function schedulePortalCanonicalDateIso(raw) {
  var s = String(raw == null ? '' : raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  var y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  var dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || (dt.getUTCMonth() + 1) !== m || dt.getUTCDate() !== d) return null;
  return s;
}

function schedulePortalSanitizeCreateLaunchContext(context) {
  if (context == null || typeof context !== 'object') return null;
  if (typeof Event !== 'undefined' && typeof Event === 'function' && context instanceof Event) return null;
  if (typeof context.preventDefault === 'function' || typeof context.stopPropagation === 'function') return null;
  if (Object.prototype.toString.call(context) !== '[object Object]') return null;
  var today = schedulePortalMadridTodayIso();
  var hasExplicitDate = context.date_from != null || context.date_to != null || context.date != null;
  var dateFrom = null, dateTo = null;
  if (hasExplicitDate) {
    dateFrom = schedulePortalCanonicalDateIso(context.date_from != null ? context.date_from : context.date);
    dateTo = schedulePortalCanonicalDateIso(context.date_to != null ? context.date_to : (dateFrom || context.date));
    if (!dateFrom || !dateTo || dateFrom < today || dateTo < dateFrom) return null;
  }
  var out = {};
  var activity = String(context.activity || context.main_activity || '').toLowerCase().trim();
  if (activity) out.activity = activity;
  var courseId = context.course_id != null ? String(context.course_id).trim() : '';
  if (courseId) out.course_id = courseId;
  if (dateFrom) { out.date_from = dateFrom; out.date_to = dateTo; }
  if (!out.activity && !out.course_id && !out.date_from) return null;
  return out;
}

function schedulePortalResolveCreateDefaultDate(ctx) {
  var today = schedulePortalMadridTodayIso();
  if (ctx && ctx.date_from) return ctx.date_from;
  var active = '';
  try { if (typeof scheduleActiveDayIso === 'function') active = String(scheduleActiveDayIso() || '').slice(0, 10); } catch (_a) { active = ''; }
  if (schedulePortalCanonicalDateIso(active) && active >= today) return active;
  return today;
}

var schedulePortalPendingCourseId = null;
var schedulePortalPendingCourseGen = 0;
var schedulePortalOpenGen = 0;
var schedulePortalCreateAmbiguous = false;

function schedulePortalApplyDesiredCourseSelect() {
  var id = schedulePortalPendingCourseId;
  if (!id || schedulePortalPendingCourseGen !== schedulePortalOpenGen) return false;
  var sel = el('ps-create-course-select');
  if (!sel || !sel.options || !sel.options.length) return false;
  var match = false;
  for (var i = 0; i < sel.options.length; i++) {
    if (String(sel.options[i].value) === String(id)) { match = true; break; }
  }
  if (!match) return false;
  sel.value = String(id);
  return sel.value === String(id);
}

function schedulePortalClearCreateDraftFields() {
  var set = function(id, val) { var n = el(id); if (n) n.value = val; };
  set('ps-create-guest', ''); set('ps-create-phone', ''); set('ps-create-notes', '');
  var pay = el('ps-create-payment'); if (pay) pay.value = 'unpaid';
  var course = el('ps-create-comp-course'), priv = el('ps-create-comp-private-lesson'), none = el('ps-create-comp-no-lesson');
  if (course) course.checked = false; if (priv) priv.checked = false; if (none) none.checked = true;
  set('ps-create-course-qty', '1'); set('ps-create-private-lesson-qty', '1'); set('ps-create-private-lesson-surfers', '1');
  var courseSel = el('ps-create-course-select'); if (courseSel) courseSel.value = '';
  var tier = el('ps-create-course-tier'); if (tier) { try { tier.innerHTML = ''; } catch (_t) {} tier.value = ''; }
  var sessions = el('ps-create-private-lesson-sessions'); if (sessions) sessions.innerHTML = '';
  var fd = el('ps-create-comp-fullday'); if (fd) fd.checked = false;
  var rentals = el('ps-create-rentals'); if (rentals) rentals.innerHTML = '';
  var quote = el('ps-create-quote-preview'); if (quote) { quote.innerHTML = ''; quote.style.display = 'none'; }
  var summary = el('ps-create-summary'); if (summary) summary.innerHTML = '<span class="portal-schedule-create-summary-placeholder">—</span>';
  var msg = el('ps-create-msg'); if (msg) { msg.textContent = ''; msg.style.display = 'none'; }
  schedulePortalPendingCourseId = null;
  schedulePortalPendingCourseGen = 0;
}

function schedulePortalApplyCreateLaunchContext(ctx) {
  if (!ctx) return;
  var courseId = ctx.course_id != null ? String(ctx.course_id).trim() : '';
  if (courseId) {
    schedulePortalPendingCourseId = courseId;
    schedulePortalPendingCourseGen = schedulePortalOpenGen;
  }
  var activity = String(ctx.activity || ctx.main_activity || '').toLowerCase();
  var pick = null;
  if (activity === 'group' || activity === 'course') pick = 'ps-create-comp-course';
  else if (activity === 'private' || activity === 'private_lesson') pick = 'ps-create-comp-private-lesson';
  else if (activity === 'none' || activity === 'no_lesson' || activity === 'rental') pick = 'ps-create-comp-no-lesson';
  if (pick) {
    var node = el(pick);
    if (node) {
      node.checked = true;
      if (typeof scheduleOnCreateComponentChange === 'function') scheduleOnCreateComponentChange(pick);
    }
  }
  schedulePortalApplyDesiredCourseSelect();
}

function schedulePortalPrepareCreateOpen(context) {
  if (schedulePortalSubmitInFlight || schedulePortalCreateAmbiguous) {
    schedulePortalInvalidatePreviewWork();
    var lockedBtn = el('ps-create-submit');
    if (lockedBtn) lockedBtn.disabled = !!schedulePortalSubmitInFlight;
    return { preserved: true, ambiguous: !!schedulePortalCreateAmbiguous };
  }
  schedulePortalOpenGen += 1;
  schedulePortalInvalidatePreviewWork();
  schedulePortalQuoteState = null;
  schedulePortalClearCreateDraftFields();
  var ctx = schedulePortalSanitizeCreateLaunchContext(context);
  var dateIso = schedulePortalResolveCreateDefaultDate(ctx);
  var dateTo = (ctx && ctx.date_to) ? ctx.date_to : dateIso;
  var df = el('ps-create-date-from'), dt = el('ps-create-date-to');
  if (df) df.value = dateIso; if (dt) dt.value = dateTo;
  schedulePortalApplyCreateLaunchContext(ctx);
  var submitBtn = el('ps-create-submit');
  if (submitBtn) submitBtn.disabled = false;
  return { preserved: false, pending_course_id: schedulePortalPendingCourseId };
}

function schedulePortalResetCreateFormRuntime() {
  if (schedulePortalSubmitInFlight || schedulePortalCreateAmbiguous) {
    schedulePortalInvalidatePreviewWork();
    var lockedBtn = el('ps-create-submit');
    if (lockedBtn) lockedBtn.disabled = !!schedulePortalSubmitInFlight;
    return;
  }
  schedulePortalInvalidatePreviewWork();
  schedulePortalQuoteState = null;
  var submitBtn = el('ps-create-submit');
  if (submitBtn) submitBtn.disabled = false;
  var msg = el('ps-create-msg');
  if (msg) { msg.textContent = ''; msg.style.display = 'none'; }
}

function schedulePortalFetchCatalog(opts) {
  opts = opts || {};
  var url = '/staff/schedule/bookings/catalog?' + schedulePortalClientQuery();
  var body = {
    location_id: getSunsetLocation(),
    require_db: true,
  };
  if (opts.service_dates && opts.service_dates.length) {
    body.service_dates = opts.service_dates;
  }
  if (opts.method === 'GET' && !(opts.service_dates && opts.service_dates.length)) {
    return schedulePortalFetchJson(url).then(function(res) {
      return res.data || { ok: false, success: false };
    });
  }
  return schedulePortalFetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function(res) {
    return res.data || { ok: false, success: false };
  });
}

/** POST quote — gen/abort guarded. */
function schedulePortalFetchQuote(createPayload, opts) {
  opts = opts || {};
  var body = {
    location_id: getSunsetLocation(),
    guest_name: createPayload.guest_name,
    date_from: createPayload.date_from,
    date_to: createPayload.date_to,
    components: createPayload.components,
    rentals: Array.isArray(createPayload.rentals) ? createPayload.rentals : [],
    service_dates: schedulePortalServiceDatesFromPayload(createPayload),
  };
  var myGen = opts.gen != null ? Number(opts.gen) : schedulePortalQuoteGen;
  var applyState = opts.applyState !== false;
  var fetchOpts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  if (opts.signal) fetchOpts.signal = opts.signal;

  return schedulePortalFetchJson('/staff/schedule/bookings/quote?' + schedulePortalClientQuery(), fetchOpts).then(function(res) {
    if (myGen !== schedulePortalQuoteGen) {
      return { ok: false, superseded: true, error: 'superseded', body: res.data || {} };
    }
    if (res.aborted) {
      return { ok: false, aborted: true, error: 'aborted', body: res.data || {} };
    }
    var data = res.data || {};
    if (!res.ok || !data.success) {
      if (applyState && myGen === schedulePortalQuoteGen) {
        schedulePortalQuoteState = null;
      }
      return {
        ok: false,
        error: data.error || data.reason || data.reason_code || ('HTTP ' + res.status),
        stale: data.reason_code === 'quote_stale' || data.reason === 'quote_stale',
        status: res.status,
        body: data,
      };
    }
    if (applyState && myGen === schedulePortalQuoteGen) {
      schedulePortalQuoteState = {
        quote_provenance: data.quote_provenance || null,
        total_cents: data.total_cents != null ? Number(data.total_cents) : null,
        fetched_at: Date.now(),
        gen: myGen,
      };
    }
    return { ok: true, body: data, gen: myGen };
  }).catch(function(err) {
    if (myGen !== schedulePortalQuoteGen) {
      return { ok: false, superseded: true, error: 'superseded' };
    }
    throw err;
  });
}

function schedulePortalServiceDatesFromPayload(payload) {
  if (!payload) return [];
  if (payload.components && payload.components.private_lesson && payload.components.private_lesson.sessions) {
    var out = [];
    payload.components.private_lesson.sessions.forEach(function(s) {
      if (s && s.date) out.push(String(s.date).slice(0, 10));
    });
    return out.sort();
  }
  return scheduleEnumerateDates(payload.date_from, payload.date_to || payload.date_from);
}

function schedulePortalFetchDrawerDetail(row) {
  var q = schedulePortalClientQuery();
  if (row.booking_id) q += '&booking_id=' + encodeURIComponent(row.booking_id);
  else if (row.booking_code) q += '&booking_code=' + encodeURIComponent(row.booking_code);
  return schedulePortalFetchJson('/staff/schedule/bookings/detail?' + q).then(function(res) {
    return res.data;
  });
}

function schedulePortalFetchPaymentLink(bookingId, bookingCode) {
  var q = schedulePortalClientQuery();
  if (bookingId) q += '&booking_id=' + encodeURIComponent(bookingId);
  else if (bookingCode) q += '&booking_code=' + encodeURIComponent(bookingCode);
  return schedulePortalFetchJson('/staff/schedule/bookings/payment-link?' + q).then(function(res) {
    return res.data;
  });
}

function schedulePortalStripeLinkFromCtx(ctx) {
  if (!ctx) return { url: '', actionable: false, stale: false, payment_id: null };
  var link = ctx.stripe_link;
  var metaStale = !!(ctx.stripe_link_stale || (link && link.stale));
  if (ctx.payment_link_invalidated === true) {
    return { url: '', actionable: false, stale: true, payment_id: null };
  }
  if (!link || !link.checkout_url) {
    return { url: '', actionable: false, stale: metaStale, payment_id: link && link.payment_id };
  }
  if (link.actionable === false) {
    return { url: '', actionable: false, stale: true, payment_id: link.payment_id || null };
  }
  var paid = ctx.payment_status === 'paid'
    || (ctx.payment && ctx.payment.payment_status === 'paid')
    || (ctx.payment && Number(ctx.payment.paid_cents || 0) > 0 && Number(ctx.payment.balance_due_cents || 0) <= 0);
  if (paid) {
    return { url: '', actionable: false, stale: false, payment_id: link.payment_id || null };
  }
  return {
    url: link.checkout_url,
    actionable: true,
    stale: metaStale,
    payment_id: link.payment_id || null,
    amount_due_cents: link.amount_due_cents,
    payment_status: link.payment_status,
  };
}

function schedulePortalSubmitCreate(createPayload, opts) {
  opts = opts || {};
  var body = Object.assign({}, createPayload, {
    location_id: getSunsetLocation(),
  });
  if (schedulePortalQuoteState && schedulePortalQuoteState.quote_provenance) {
    body.quote_provenance = schedulePortalQuoteState.quote_provenance;
  }
  var idem = opts.idempotency_key || schedulePortalEnsureIdempotencyKey(createPayload);
  if (idem) body.idempotency_key = idem;
  return schedulePortalFetchJson('/staff/schedule/bookings?' + schedulePortalClientQuery(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function scheduleDrawerTrustedPersistedSource(row) {
  if (!row) return null;
  if (row._isDbManual || row.record_source === 'staff_manual') return 'staff_manual';
  if (row.record_source === 'luna_guest') return 'luna_guest';
  return null;
}

function scheduleDrawerGroupHasTrustedPersistedSource(group) {
  if (!(group && group.records && group.records.length)) return false;
  for (var i = 0; i < group.records.length; i++) {
    if (scheduleDrawerTrustedPersistedSource(group.records[i])) return true;
  }
  return false;
}

function scheduleDrawerCanLoadCanonical(row) {
  if (!row || row._isDemo) return false;
  var group = scheduleFindGroupForRow(row);
  var trusted = !!scheduleDrawerTrustedPersistedSource(row) || scheduleDrawerGroupHasTrustedPersistedSource(group);
  if (!trusted) return false;
  var ref = scheduleRowBookingRef(row, group);
  return !!(ref.booking_id || ref.booking_code);
}

function scheduleDrawerCanEdit(row) {
  if (!row || row._isDemo) return false;
  return scheduleDrawerCanLoadCanonical(row);
}

function scheduleFetchDrawerContext(row) {
  return schedulePortalFetchDrawerDetail(row);
}

function schedulePortalRenderCreateQuotePreview(result) {
  var box = el('ps-create-quote-preview');
  if (!box) return;
  if (result && (result.superseded || result.aborted)) return;
  if (!result || !result.ok) {
    var err = (result && result.error) || portalT('schedule.create.quoteFailed') || 'Quote unavailable';
    if (result && result.stale) {
      err = portalT('schedule.create.quoteStale') || 'Price changed — refresh quote before creating.';
    }
    if (result && result.status === 503) {
      err = portalT('schedule.create.quoteBusy') || 'Price check is busy — wait a moment and try again.';
    }
    box.innerHTML = '<p class="portal-schedule-drawer-hint" style="margin:0;color:var(--danger,#b33)">' + escHtml(String(err)) + '</p>';
    box.style.display = 'block';
    return;
  }
  var total = result.body.total_cents != null ? result.body.total_cents : null;
  var label = total != null
    ? (portalT('schedule.create.quoteTotal') || 'Quoted total') + ': \u20ac' + (Number(total) / 100).toFixed(2)
    : (portalT('schedule.create.quoteReady') || 'Quote ready');
  box.innerHTML = '<p class="portal-schedule-drawer-hint" style="margin:0">' + escHtml(label) + '</p>';
  box.style.display = 'block';
}

function schedulePortalSetCreateStatus(text, isError) {
  var msg = el('ps-create-msg');
  if (!msg) return;
  if (!text) {
    msg.textContent = '';
    msg.style.display = 'none';
    return;
  }
  msg.textContent = text;
  msg.style.display = 'block';
  try {
    if (isError) msg.classList.add('error');
    else msg.classList.remove('error');
  } catch (_e) { /* ignore */ }
}

function schedulePortalClearQuotePreviewUi() {
  schedulePortalQuoteState = null;
  var box = el('ps-create-quote-preview');
  if (box) { box.innerHTML = ''; box.style.display = 'none'; }
}

function schedulePortalRunPreviewQuote() {
  if (schedulePortalSubmitInFlight) return Promise.resolve(null);
  var payload = scheduleReadCreatePayload();
  if (!Object.keys(payload.components || {}).length) {
    schedulePortalClearQuotePreviewUi();
    return Promise.resolve(null);
  }
  // Private sessions: shared validator gate before quote fetch (soft-invalid, no toast).
  if (payload.components && payload.components.private_lesson) {
    var plGate = null;
    try { plGate = schedulePortalValidatePrivateLessonCreate(payload.components.private_lesson); }
    catch (_pl) { plGate = { ok: false, errorKey: 'schedule.create.privateLesson.sessionIncomplete' }; }
    if (!plGate || plGate.ok !== true) {
      if (schedulePortalQuoteAbort) {
        try { schedulePortalQuoteAbort.abort(); } catch (_a) { /* ignore */ }
        schedulePortalQuoteAbort = null;
      }
      schedulePortalQuoteGen += 1;
      schedulePortalClearQuotePreviewUi();
      return Promise.resolve({ ok: false, softInvalid: true, errorKey: (plGate && plGate.errorKey) || 'schedule.create.privateLesson.sessionIncomplete' });
    }
  }

  if (schedulePortalQuoteAbort) {
    try { schedulePortalQuoteAbort.abort(); } catch (_e) { /* ignore */ }
    schedulePortalQuoteAbort = null;
  }
  var myGen = ++schedulePortalQuoteGen;
  var controller = null;
  if (typeof AbortController !== 'undefined') {
    controller = new AbortController();
    schedulePortalQuoteAbort = controller;
  }

  return schedulePortalFetchQuote(payload, {
    gen: myGen,
    signal: controller ? controller.signal : undefined,
    applyState: true,
  }).then(function(result) {
    if (myGen !== schedulePortalQuoteGen || schedulePortalSubmitInFlight) {
      return { ok: false, superseded: true };
    }
    if (result && result.aborted) return result;
    schedulePortalRenderCreateQuotePreview(result);
    return result;
  }).catch(function(err) {
    if (myGen !== schedulePortalQuoteGen || schedulePortalSubmitInFlight) {
      return { ok: false, superseded: true };
    }
    schedulePortalRenderCreateQuotePreview({ ok: false, error: err && err.message });
    return null;
  }).then(function(result) {
    if (schedulePortalQuoteAbort === controller) schedulePortalQuoteAbort = null;
    return result;
  });
}

function schedulePortalRefreshCreateQuote() {
  if (schedulePortalSubmitInFlight) return Promise.resolve(null);
  if (schedulePortalQuoteTimer != null) {
    clearTimeout(schedulePortalQuoteTimer);
    schedulePortalQuoteTimer = null;
  }
  var wait = Number(schedulePortalQuoteDebounceMs);
  if (!(wait >= 300 && wait <= 500)) wait = 400;
  if (Number(schedulePortalQuoteDebounceMs) > 0 && Number(schedulePortalQuoteDebounceMs) < 300) {
    wait = Number(schedulePortalQuoteDebounceMs);
  }
  return new Promise(function(resolve) {
    schedulePortalQuoteTimer = setTimeout(function() {
      schedulePortalQuoteTimer = null;
      schedulePortalRunPreviewQuote().then(resolve, function() { resolve(null); });
    }, wait);
  });
}

/* ── Private multi-session editor (Kaya Slice 4; When section) ─────────── */

function schedulePrivateLessonDefaultEnd(startHm, durationMin) {
  var startM = scheduleSlotMinutesFromToken(startHm);
  if (startM == null) return '';
  return scheduleMinutesLabel(startM + (durationMin || schedulePrivateLessonDurationCache || 120));
}

function scheduleReadPrivateLessonSessionsFromDom() {
  var wrap = el('ps-create-private-lesson-sessions'), sessions = [];
  if (!wrap) return sessions;
  wrap.querySelectorAll('.portal-schedule-private-session-row').forEach(function(row) {
    var dateEl = row.querySelector('.ps-pl-session-date');
    var startEl = row.querySelector('.ps-pl-session-start');
    var endEl = row.querySelector('.ps-pl-session-end');
    sessions.push({ date: dateEl ? dateEl.value : '', start: startEl ? startEl.value : '', end: endEl ? endEl.value : '' });
  });
  return sessions;
}

/** Outer range → rentals → full-day → one total-preview/quote (after DOM finals). */
function schedulePrivateLessonSessionsRefreshDependents() {
  scheduleUpdatePrivateLessonDateRangeFromSessions();
  if (typeof scheduleRenderCreateRentals === 'function') scheduleRenderCreateRentals();
  if (typeof scheduleRefreshCreateFullDayAddon === 'function') scheduleRefreshCreateFullDayAddon();
  if (typeof scheduleUpdateCreateTotalPreview === 'function') scheduleUpdateCreateTotalPreview();
}

function scheduleWirePrivateLessonSessionRow(row) {
  if (!row || row.dataset.wired) return;
  row.dataset.wired = '1';
  var startEl = row.querySelector('.ps-pl-session-start');
  var endEl = row.querySelector('.ps-pl-session-end');
  if (startEl) {
    startEl.addEventListener('change', function() {
      if (!endEl) return;
      var curEnd = endEl.value, defEnd = schedulePrivateLessonDefaultEnd(startEl.value);
      if (!curEnd || curEnd === schedulePrivateLessonDefaultEnd(startEl.defaultValue || '10:00')) endEl.value = defEnd;
      startEl.defaultValue = startEl.value;
    });
  }
  ['.ps-pl-session-date', '.ps-pl-session-start', '.ps-pl-session-end'].forEach(function(sel) {
    var f = row.querySelector(sel);
    if (!f || f.dataset.sessionFieldWired) return;
    f.dataset.sessionFieldWired = '1';
    f.addEventListener('change', schedulePrivateLessonSessionsRefreshDependents);
  });
}

function scheduleSyncPrivateLessonSessions(opts) {
  opts = opts || {};
  var wrap = el('ps-create-private-lesson-sessions');
  var qtyEl = el('ps-create-private-lesson-qty');
  if (!wrap || !qtyEl) return;
  var qty = parseInt(qtyEl.value, 10) || 1;
  if (qty < 1) qty = 1;
  if (qty > 30) qty = 30;
  qtyEl.value = String(qty);
  var existing = scheduleReadPrivateLessonSessionsFromDom();
  var dateFrom = (el('ps-create-date-from') && el('ps-create-date-from').value) || scheduleTodayIso();
  var html = '';
  var removeLabel = portalT('schedule.create.privateLesson.removeSession') || 'Remove';
  for (var i = 0; i < qty; i++) {
    var prev = existing[i] || {};
    var date = prev.date || dateFrom;
    var start = prev.start || '10:00';
    var end = prev.end || schedulePrivateLessonDefaultEnd(start);
    var removeBtn = qty > 1
      ? '<button type="button" class="btn btn-ghost portal-schedule-session-remove" data-session-remove="' + String(i) + '" data-i18n="schedule.create.privateLesson.removeSession" data-i18n-aria="schedule.create.privateLesson.removeSession" aria-label="' + escHtml(removeLabel) + '">Remove</button>'
      : '';
    html += '<div class="portal-schedule-private-session-row" data-session-index="' + String(i + 1) + '">'
      + '<p class="portal-schedule-card-sub" style="margin:8px 0 4px">' + escHtml(portalT('schedule.create.privateLesson.sessionLabel')) + ' ' + String(i + 1) + '</p>'
      + '<div class="portal-schedule-private-session-grid">'
      + '<label><span data-i18n="schedule.create.privateLesson.date">Date</span><input class="ps-pl-session-date" type="date" value="' + escHtml(date) + '"></label>'
      + '<label><span data-i18n="schedule.create.privateLesson.start">Start</span><input class="ps-pl-session-start" type="time" value="' + escHtml(start) + '"></label>'
      + '<label><span data-i18n="schedule.create.privateLesson.end">End</span><input class="ps-pl-session-end" type="time" value="' + escHtml(end) + '"></label>'
      + '</div>' + removeBtn + '</div>';
  }
  wrap.innerHTML = html;
  wrap.querySelectorAll('.portal-schedule-private-session-row').forEach(scheduleWirePrivateLessonSessionRow);
  wrap.querySelectorAll('.portal-schedule-session-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      scheduleRemovePrivateLessonSession(parseInt(btn.getAttribute('data-session-remove'), 10));
    });
  });
  var modal = el('ps-create-modal');
  if (modal && typeof window.applyStaffPortalI18n === 'function') window.applyStaffPortalI18n(modal);
  if (!opts.deferSideEffects) schedulePrivateLessonSessionsRefreshDependents();
}

/** Canonical non-past Madrid dates only; clear outer if none (no stale leak). */
function scheduleUpdatePrivateLessonDateRangeFromSessions() {
  var sessions = scheduleReadPrivateLessonSessionsFromDom(), today = schedulePortalMadridTodayIso(), dates = [];
  for (var i = 0; i < sessions.length; i++) {
    var canon = schedulePortalCanonicalDateIso(sessions[i] && sessions[i].date != null ? String(sessions[i].date) : '');
    if (canon && canon >= today) dates.push(canon);
  }
  var df = el('ps-create-date-from'), dt = el('ps-create-date-to');
  if (!dates.length) { if (df) df.value = ''; if (dt) dt.value = ''; return; }
  dates.sort();
  if (df) df.value = dates[0];
  if (dt) dt.value = dates[dates.length - 1];
}

function scheduleAddPrivateLessonSession() {
  var qtyEl = el('ps-create-private-lesson-qty');
  if (!qtyEl) return;
  var existing = scheduleReadPrivateLessonSessionsFromDom();
  var last = existing[existing.length - 1] || {};
  var nextDate = (el('ps-create-date-from') && el('ps-create-date-from').value) || scheduleTodayIso();
  if (last.date) {
    var parsed = typeof scheduleParseIso === 'function' ? scheduleParseIso(last.date) : null;
    if (parsed) nextDate = scheduleIsoDate(scheduleAddDays(parsed, 1));
  }
  var nextStart = last.start || '10:00';
  var nextEnd = last.end || schedulePrivateLessonDefaultEnd(nextStart);
  qtyEl.value = String(Math.min((parseInt(qtyEl.value, 10) || existing.length || 1) + 1, 30));
  scheduleSyncPrivateLessonSessions({ deferSideEffects: true });
  var wrap = el('ps-create-private-lesson-sessions');
  var row = wrap && wrap.querySelectorAll('.portal-schedule-private-session-row');
  row = row && row[row.length - 1];
  if (row) {
    var dEl = row.querySelector('.ps-pl-session-date'), sEl = row.querySelector('.ps-pl-session-start'), eEl = row.querySelector('.ps-pl-session-end');
    if (dEl) dEl.value = nextDate;
    if (sEl) sEl.value = nextStart;
    if (eEl) eEl.value = nextEnd;
  }
  schedulePrivateLessonSessionsRefreshDependents();
}

function scheduleRemovePrivateLessonSession(index) {
  var qtyEl = el('ps-create-private-lesson-qty'), wrap = el('ps-create-private-lesson-sessions');
  if (!qtyEl || !wrap) return;
  var rows = wrap.querySelectorAll('.portal-schedule-private-session-row');
  if (index < 0 || index >= rows.length || rows.length <= 1) return;
  var target = rows[index];
  if (target && target.parentNode) target.parentNode.removeChild(target);
  qtyEl.value = String(Math.max(wrap.querySelectorAll('.portal-schedule-private-session-row').length, 1));
  scheduleSyncPrivateLessonSessions();
}

/** Client-side private session validation before quote/create (localized keys). */
function schedulePortalValidatePrivateLessonCreate(pl) {
  if (!pl || pl.enabled === false) return { ok: true };
  var max = 30;
  var qty = parseInt(pl.quantity, 10);
  if (!Number.isFinite(qty) || qty < 1 || qty > max) {
    return { ok: false, errorKey: 'schedule.create.privateLesson.sessionMax' };
  }
  var sessions = Array.isArray(pl.sessions) ? pl.sessions : null;
  if (!sessions || sessions.length !== qty) {
    return { ok: false, errorKey: 'schedule.create.privateLesson.sessionsMismatch' };
  }
  var today = schedulePortalMadridTodayIso();
  var seen = Object.create(null);
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i] || {};
    var dateRaw = s.date != null ? String(s.date).trim() : '';
    var start = s.start != null ? String(s.start).trim() : '';
    var end = s.end != null ? String(s.end).trim() : '';
    if (!dateRaw || !start || !end) {
      return { ok: false, errorKey: 'schedule.create.privateLesson.sessionIncomplete' };
    }
    var date = schedulePortalCanonicalDateIso(dateRaw);
    if (!date) {
      return { ok: false, errorKey: 'schedule.create.privateLesson.sessionDateInvalid' };
    }
    if (date < today) {
      return { ok: false, errorKey: 'schedule.create.privateLesson.sessionDatePast' };
    }
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(start) || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(end)) {
      return { ok: false, errorKey: 'schedule.create.privateLesson.sessionIncomplete' };
    }
    var startM = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5));
    var endM = Number(end.slice(0, 2)) * 60 + Number(end.slice(3, 5));
    if (!(endM > startM)) {
      return { ok: false, errorKey: 'schedule.create.privateLesson.sessionEndAfterStart' };
    }
    var key = date + '|' + start + '|' + end;
    if (seen[key]) {
      return { ok: false, errorKey: 'schedule.create.privateLesson.sessionDuplicate' };
    }
    seen[key] = 1;
  }
  return { ok: true };
}

function schedulePortalPopulateCreateCourseFields() {
  var sel = el('ps-create-course-select');
  if (!sel) return Promise.resolve();
  var myOpenGen = schedulePortalOpenGen;
  var dates = scheduleCreateSelectedDates();
  return schedulePortalFetchCatalog({ service_dates: dates, method: 'POST' }).then(function(catalogData) {
    if (myOpenGen !== schedulePortalOpenGen) return;
    var courses = (catalogData && Array.isArray(catalogData.courses)) ? catalogData.courses : [];
    if (typeof scheduleCoursesCache !== 'undefined') scheduleCoursesCache = courses.slice();
    var prev = sel.value;
    var html = '';
    courses.forEach(function(c) {
      var id = String(c.course_id || '').trim();
      if (!id) return;
      var eligible = c.eligible_on_requested_dates !== false;
      var summary = c.schedule_summary ? (' — ' + c.schedule_summary) : '';
      var disabled = dates.length && c.eligible_on_requested_dates === false;
      var label = (c.label || id) + summary + (disabled
        ? (' (' + (portalT('schedule.create.courseNotOnSelectedDates') || 'not available on selected dates') + ')')
        : '');
      html += '<option value="' + escHtml(id) + '" data-label="' + escHtml(c.label || id) + '"'
        + (disabled ? ' disabled' : '')
        + ' data-eligible="' + (eligible ? '1' : '0') + '">'
        + escHtml(label) + '</option>';
    });
    if (!html) html = '<option value="">' + escHtml(portalT('schedule.courses.noneConfigured')) + '</option>';
    sel.innerHTML = html;
    if (prev) {
      sel.value = prev;
      if (sel.value !== prev) schedulePopulateCreateCourseTierFields('');
    }
    schedulePortalApplyDesiredCourseSelect();
    if (!sel._tierBound) {
      sel._tierBound = true;
      sel.addEventListener('change', function() {
        schedulePopulateCreateCourseTierFields('');
        schedulePortalRefreshCreateQuote();
      });
    }
    if (!sel._dateBound) {
      sel._dateBound = true;
      ['ps-create-date-from', 'ps-create-date-to'].forEach(function(id) {
        var node = el(id);
        if (!node || node._courseEligBound) return;
        node._courseEligBound = true;
        node.addEventListener('change', function() {
          schedulePortalPopulateCreateCourseFields().then(function() { schedulePortalRefreshCreateQuote(); });
        });
      });
    }
    schedulePopulateCreateCourseTierFields();
    return courses;
  });
}

function scheduleUpdateCreateTotalPreview() {
  scheduleUpdateFullDayAddonSummary('ps-create-fullday-rows', 'ps-create-fullday-summary');
  schedulePortalRefreshCreateQuote();
}

function submitScheduleManualBooking() {
  if (schedulePortalSubmitInFlight) return;

  var payload = scheduleReadCreatePayload();
  var submitBtn = el('ps-create-submit');
  var msg = el('ps-create-msg');
  if (!payload.guest_name) {
    if (msg) { msg.textContent = portalT('schedule.create.guestRequired'); msg.style.display = 'block'; }
    return;
  }
  if (!Object.keys(payload.components).length) {
    if (msg) { msg.textContent = portalT('schedule.create.componentsRequired'); msg.style.display = 'block'; }
    return;
  }
  if (payload.components.course) {
    var coursePart = payload.components.course;
    if (!coursePart.course_id) {
      if (msg) { msg.textContent = portalT('schedule.create.courseRequired') || 'Select a group course.'; msg.style.display = 'block'; }
      return;
    }
    if (!coursePart.tier_key) {
      if (msg) { msg.textContent = portalT('schedule.create.courseTierRequired') || 'Select a course duration.'; msg.style.display = 'block'; }
      return;
    }
  }
  if (payload.components.private_lesson) {
    var plCheck = schedulePortalValidatePrivateLessonCreate(payload.components.private_lesson);
    if (!plCheck.ok) {
      if (msg) {
        msg.textContent = portalT(plCheck.errorKey || 'schedule.create.privateLesson.sessionIncomplete');
        msg.style.display = 'block';
      }
      return;
    }
  }

  schedulePortalSubmitInFlight = true;
  if (submitBtn) submitBtn.disabled = true;

  if (schedulePortalQuoteTimer != null) {
    clearTimeout(schedulePortalQuoteTimer);
    schedulePortalQuoteTimer = null;
  }
  if (schedulePortalQuoteAbort) {
    try { schedulePortalQuoteAbort.abort(); } catch (_e) { /* ignore */ }
    schedulePortalQuoteAbort = null;
  }
  var submitGen = ++schedulePortalQuoteGen;
  var idemKey = schedulePortalEnsureIdempotencyKey(payload);

  schedulePortalSetCreateStatus(
    portalT('schedule.create.checkingPrice') || 'Checking price…',
    false
  );

  var createSent = false;
  var succeeded = false;

  var quoteP = schedulePortalFetchQuote(payload, {
    gen: submitGen,
    applyState: true,
  });
  quoteP.then(function(quoteResult) {
    if (!schedulePortalSubmitInFlight || submitGen !== schedulePortalQuoteGen) {
      return { ok: false, superseded: true };
    }
    if (!quoteResult || !quoteResult.ok) {
      if (quoteResult && (quoteResult.superseded || quoteResult.aborted)) {
        return quoteResult;
      }
      var qErr = (quoteResult && quoteResult.error) || (portalT('schedule.create.quoteFailed') || 'Could not quote booking');
      if (quoteResult && quoteResult.stale) {
        qErr = portalT('schedule.create.quoteStale') || 'Price changed — refresh and try again.';
      }
      if (quoteResult && quoteResult.status === 503) {
        qErr = portalT('schedule.create.quoteBusy') || 'Price check is busy — wait a moment and try again.';
      }
      throw new Error(qErr);
    }
    schedulePortalRenderCreateQuotePreview(quoteResult);
    schedulePortalSetCreateStatus(
      portalT('schedule.create.creating') || 'Creating booking…',
      false
    );
    createSent = true;
    schedulePortalCreateAmbiguous = true;
    return schedulePortalSubmitCreate(payload, { idempotency_key: idemKey });
  }).then(function(res) {
    if (!res || res.superseded) return;
    if (!createSent) return;
    if (res.aborted) return;
    schedulePortalCreateAmbiguous = false;
    if (!res.ok || !res.data || res.data.success !== true) {
      var d = res.data || {};
      if (d.reason_code === 'quote_stale' || d.reason === 'quote_stale') {
        throw new Error(portalT('schedule.create.quoteStale') || 'Quote expired — refresh price and try again.');
      }
      if (d.reason_code === 'idempotency_key_intent_conflict' || d.error === 'idempotency_key_intent_conflict') {
        throw new Error(portalT('schedule.create.idempotencyConflict') || 'This create request conflicts with a previous booking. Close and start a new create.');
      }
      var httpErr = d.error || d.message || ('HTTP ' + res.status);
      if (res.status === 503) {
        httpErr = portalT('schedule.create.createBusy') || 'Create is temporarily unavailable — retry with the same form; it will not double-book.';
      }
      throw new Error(httpErr);
    }
    succeeded = true;
    var createdCode = res.data.booking_code || (res.data.bookings && res.data.bookings[0] && res.data.bookings[0].booking_code);
    schedulePortalClearSubmitIdempotency();
    schedulePortalQuoteState = null;
    closeScheduleCreateModal();
    scheduleResetNavigationAfterBookingCreate();
    scheduleRequestPageLoad();
    if (createdCode) {
      setTimeout(function() {
        var row = scheduleFindCachedRowByBookingCode(createdCode);
        if (row && typeof openScheduleDetailDrawer === 'function') openScheduleDetailDrawer(row);
      }, 800);
    }
  }).catch(function(err) {
    if (msg) {
      var base = portalT('schedule.create.failed') || 'Create failed';
      var detail = err && err.message ? err.message : String(err);
      msg.textContent = base + ' ' + detail;
      msg.style.display = 'block';
      try { msg.classList.add('error'); } catch (_e) { /* ignore */ }
    }
  }).finally(function() {
    schedulePortalSubmitInFlight = false;
    if (!succeeded && submitBtn) submitBtn.disabled = false;
  });
}
