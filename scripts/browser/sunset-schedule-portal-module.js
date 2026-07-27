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
  var custom = Array.isArray(p.custom_line_items) ? p.custom_line_items.map(function(l) {
    return {
      client_line_id: String((l && l.client_line_id) || ''),
      label: String((l && l.label) || ''),
      amount_cents: Number(l && l.amount_cents),
    };
  }).sort(function(a, b) { return a.client_line_id.localeCompare(b.client_line_id); }) : [];
  return JSON.stringify({
    guest_name: String(p.guest_name || ''),
    guest_phone: p.guest_phone != null ? String(p.guest_phone) : '',
    date_from: p.date_from || null,
    date_to: p.date_to || null,
    payment_status: p.payment_status || 'unpaid',
    components: ordered,
    rentals: schedulePortalNormalizeRentalsIntent(p.rentals),
    custom_line_items: custom,
    notes: p.notes != null ? String(p.notes) : '',
    location_id: typeof getSunsetLocation === 'function' ? getSunsetLocation() : null,
  });
}

/**
 * Pricing-relevant fingerprint for quote display/state binding.
 * Guest name/phone do not affect Admin totals; dates + rentals + components +
 * surfer_count + custom lines + location do. Stale €40 must not sit beside a
 * 5-day summary that came from a different payload.
 */
function schedulePortalQuotePricingIntentKey(payload) {
  var p = payload || {};
  var comps = p.components || {};
  var ordered = {};
  Object.keys(comps).sort().forEach(function(k) { ordered[k] = comps[k]; });
  var custom = Array.isArray(p.custom_line_items) ? p.custom_line_items.map(function(l) {
    return {
      client_line_id: String((l && l.client_line_id) || ''),
      label: String((l && l.label) || ''),
      amount_cents: Number(l && l.amount_cents),
    };
  }).sort(function(a, b) { return a.client_line_id.localeCompare(b.client_line_id); }) : [];
  var sc = p.surfer_count;
  if (sc != null && sc !== '') {
    sc = Number(sc);
    if (!Number.isFinite(sc)) sc = null;
  } else {
    sc = null;
  }
  return JSON.stringify({
    date_from: p.date_from || null,
    date_to: p.date_to || null,
    components: ordered,
    rentals: schedulePortalNormalizeRentalsIntent(p.rentals),
    custom_line_items: custom,
    surfer_count: sc,
    location_id: typeof getSunsetLocation === 'function' ? getSunsetLocation() : null,
  });
}

/** True when quote state was produced for the same pricing intent as payload. */
function schedulePortalQuoteMatchesPricingIntent(payload) {
  if (!schedulePortalQuoteState || schedulePortalQuoteState.intent_key == null) return false;
  var key = schedulePortalQuotePricingIntentKey(payload || {});
  return schedulePortalQuoteState.intent_key === key;
}

/**
 * Drop quote state + € display when pricing intent drifted (date/surfer/rental).
 * Leaves "Checking price…" alone so in-flight requote UI is preserved.
 */
function schedulePortalDropStaleQuoteUi(payload) {
  if (schedulePortalQuoteMatchesPricingIntent(payload)) return false;
  schedulePortalQuoteState = null;
  var box = el('ps-create-quote-preview');
  if (!box) return true;
  var html = String(box.innerHTML || '');
  if (/portal-schedule-quote-checking|checkingPrice|Checking price/i.test(html)) return true;
  if (/€\d|Quoted total|quoteTotal/i.test(html)) {
    box.innerHTML = '';
    box.style.display = 'none';
  }
  return true;
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
  set('ps-create-surfers', '1'); set('ps-create-course-qty', '1'); set('ps-create-private-lesson-qty', '1'); set('ps-create-private-lesson-surfers', '1');
  var courseSel = el('ps-create-course-select'); if (courseSel) courseSel.value = '';
  var tier = el('ps-create-course-tier'); if (tier) { try { tier.innerHTML = ''; } catch (_t) {} tier.value = ''; }
  var sessions = el('ps-create-private-lesson-sessions'); if (sessions) sessions.innerHTML = '';
  var fd = el('ps-create-comp-fullday'); if (fd) fd.checked = false;
  var rentals = el('ps-create-rentals'); if (rentals) rentals.innerHTML = '';
  var quote = el('ps-create-quote-preview'); if (quote) { quote.innerHTML = ''; quote.style.display = 'none'; }
  var summary = el('ps-create-summary'); if (summary) summary.innerHTML = '<span class="portal-schedule-create-summary-placeholder">—</span>';
  var msg = el('ps-create-msg'); if (msg) { msg.textContent = ''; msg.style.display = 'none'; }
  // Reset staff custom commercial lines mini-section.
  try {
    if (typeof scheduleCreateCustomLines !== 'undefined') scheduleCreateCustomLines = [];
    if (typeof scheduleRenderCreateCustomLines === 'function') scheduleRenderCreateCustomLines();
    if (typeof scheduleSetCustomLineEditorOpen === 'function') scheduleSetCustomLineEditorOpen(false);
  } catch (_cl) { /* ignore */ }
  schedulePortalQuoteState = null;
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
  schedulePortalWireCreateFooter();
  try { if (typeof scheduleWireCreateCustomLines === 'function') scheduleWireCreateCustomLines(); } catch (_w) { /* ignore */ }
  schedulePortalRenderCreateIntentSummary();
  // Start disabled until guest name + valid phone (quote may still run blank).
  schedulePortalSyncCreateSubmitEnabled();
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
  schedulePortalSyncCreateSubmitEnabled();
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

/** Own total_cents: typeof number, finite int, 0..MAX_SAFE. Else null. */
function schedulePortalStrictQuoteTotalCents(body) {
  var v = body && Object.prototype.hasOwnProperty.call(body, 'total_cents') ? body.total_cents : null;
  return (typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v && v >= 0 && v <= Number.MAX_SAFE_INTEGER) ? v : null;
}
/** POST quote — gen/abort guarded; strict total_cents before state/success. */
function schedulePortalFetchQuote(createPayload, opts) {
  opts = opts || {};
  var body = {
    location_id: getSunsetLocation(),
    // Quote must not require guest name/phone — send blanks as-is (no fake placeholders).
    guest_name: createPayload.guest_name != null ? createPayload.guest_name : '',
    guest_phone: createPayload.guest_phone != null ? createPayload.guest_phone : '',
    date_from: createPayload.date_from,
    date_to: createPayload.date_to,
    components: createPayload.components,
    rentals: Array.isArray(createPayload.rentals) ? createPayload.rentals : [],
    service_dates: schedulePortalServiceDatesFromPayload(createPayload),
    // No-lesson equipment qty authority (server forces rentals to this when present).
    surfer_count: createPayload.surfer_count != null ? createPayload.surfer_count : null,
    // Staff commercial adjustments — server revalidates signed cents; never Admin course/rental prices.
    custom_line_items: Array.isArray(createPayload.custom_line_items) ? createPayload.custom_line_items : [],
  };
  var intentKey = typeof schedulePortalQuotePricingIntentKey === 'function'
    ? schedulePortalQuotePricingIntentKey(createPayload)
    : null;
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
    var totalCents = schedulePortalStrictQuoteTotalCents(data);
    if (totalCents == null) {
      if (applyState && myGen === schedulePortalQuoteGen) schedulePortalQuoteState = null;
      return { ok: false, error: 'invalid_quote_total', body: data };
    }
    // Reject apply when pricing intent already drifted (date/surfer/rental changed mid-flight).
    var liveKey = typeof schedulePortalQuotePricingIntentKey === 'function'
      && typeof scheduleReadCreatePayload === 'function'
      ? (function() {
        try { return schedulePortalQuotePricingIntentKey(scheduleReadCreatePayload()); }
        catch (_i) { return intentKey; }
      }())
      : intentKey;
    if (intentKey != null && liveKey != null && intentKey !== liveKey) {
      if (applyState && myGen === schedulePortalQuoteGen) schedulePortalQuoteState = null;
      return { ok: false, superseded: true, error: 'intent_stale', body: data };
    }
    if (applyState && myGen === schedulePortalQuoteGen) {
      schedulePortalQuoteState = {
        quote_provenance: data.quote_provenance || null,
        total_cents: totalCents,
        fetched_at: Date.now(),
        gen: myGen,
        intent_key: intentKey,
      };
    }
    return { ok: true, body: data, gen: myGen, intent_key: intentKey };
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

function schedulePortalHasSellableIntent(payload) {
  var p = payload || {}, c = p.components || {};
  return !!(c.course || c.private_lesson || c.full_day_equipment_extension || c.surfboard || c.wetsuit
    || (Array.isArray(p.rentals) && p.rentals.length));
}

/** Staff Create phone: nonblank + at least 6 digits (matches server isValidStaffCreateGuestPhone). */
function schedulePortalIsValidCreatePhone(raw) {
  var phone = raw != null ? String(raw).trim() : '';
  if (!phone || phone.length > 40) return false;
  var digits = phone.replace(/\D/g, '');
  return digits.length >= 6;
}

/**
 * Shared create validation for submit (hard) and quote soft gates.
 * Sellable intent includes rental-only (No lesson + gear). Does not re-price.
 * opts.soft: skip guest name/phone; return softInvalid/idle rather than hard block.
 * Quote recalculates while name/phone are blank; Create stays fail-closed.
 */
function schedulePortalValidateCreatePayload(payload, opts) {
  opts = opts || {};
  var soft = opts.soft === true;
  var p = payload || {};
  var comps = p.components || {};
  var rentals = Array.isArray(p.rentals) ? p.rentals : [];
  function fail(key, extra) {
    var out = { ok: false, errorKey: key };
    if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k]; } }
    // Soft non-idle → softInvalid (no raw keys in UI).
    if (soft && !out.idle) out.softInvalid = true;
    return out;
  }

  // Soft (quote): guest name/phone not required. Hard (create): both required + phone valid.
  if (!soft) {
    var guest = p.guest_name != null ? String(p.guest_name).trim() : '';
    if (!guest) return fail('schedule.create.guestRequired');
    var phone = p.guest_phone != null ? String(p.guest_phone).trim() : '';
    if (!schedulePortalIsValidCreatePhone(phone)) return fail('schedule.create.phoneRequired');
  }
  if (comps.course) {
    if (!String(comps.course.course_id || '').trim()) return fail('schedule.create.courseRequired');
    // Tier is derived data from inclusive dates + sellable catalog match — never free-typed.
    if (!String(comps.course.tier_key || '').trim()) return fail('schedule.create.courseDurationUnavailable');
  }

  if (!schedulePortalHasSellableIntent(p)) {
    return fail('schedule.create.componentsRequired', { idle: true });
  }

  if (comps.private_lesson) {
    // Fail closed when outer range exceeds session max — do not quote/create partial sets.
    var plSpan = typeof schedulePortalInclusiveDateCount === 'function'
      ? schedulePortalInclusiveDateCount(p.date_from, p.date_to != null ? p.date_to : p.date_from)
      : 0;
    if (plSpan > 30) return fail('schedule.create.privateLesson.rangeTooLong');
    var plCheck = schedulePortalValidatePrivateLessonCreate(comps.private_lesson);
    if (!plCheck || plCheck.ok !== true) {
      return fail((plCheck && plCheck.errorKey) || 'schedule.create.privateLesson.sessionIncomplete');
    }
  } else {
    var df = schedulePortalCanonicalDateIso(p.date_from);
    var dt = schedulePortalCanonicalDateIso(p.date_to != null ? p.date_to : p.date_from);
    var today = schedulePortalMadridTodayIso();
    if (!df || !dt || df < today || dt < today || df > dt) return fail('calendar.state.invalidDateRange');
  }

  if (rentals.length) {
    var known = (typeof SCHEDULE_CANONICAL_RENTAL_OFFERINGS !== 'undefined' && SCHEDULE_CANONICAL_RENTAL_OFFERINGS)
      || ['board_rental', 'wetsuit_rental', 'board_and_suit_rental'];
    for (var i = 0; i < rentals.length; i++) {
      var r = rentals[i] || {};
      var off = String(r.offering_key || '').trim();
      var dur = String(r.duration_key || '').trim();
      var qty = Number(r.quantity);
      // Nonempty duration (catalog-driven). Canonical offerings.
      if (known.indexOf(off) < 0 || !dur || !(Number.isFinite(qty) && Math.floor(qty) === qty && qty >= 1)) {
        return fail('schedule.create.componentsRequired');
      }
    }
  }

  // Blank/invalid Number of surfers cannot quote or create (no stale quantity).
  var needsSurfers = !!(comps.course || comps.private_lesson || rentals.length
    || comps.full_day_equipment_extension);
  if (needsSurfers) {
    var sn = null;
    if (comps.course && comps.course.quantity != null) sn = Number(comps.course.quantity);
    else if (comps.private_lesson && comps.private_lesson.surfer_count != null) {
      sn = Number(comps.private_lesson.surfer_count);
    } else if (rentals.length && rentals[0] && rentals[0].quantity != null) {
      sn = Number(rentals[0].quantity);
    }
    // Prefer live input when present (payload may omit during soft preview).
    try {
      if (typeof scheduleReadCreateSurferCount === 'function') {
        var live = scheduleReadCreateSurferCount();
        if (live == null) return fail('schedule.create.surfersRequired');
        sn = live;
      }
    } catch (_s) { /* ignore */ }
    if (!(Number.isFinite(sn) && Math.floor(sn) === sn && sn >= 1)) {
      return fail('schedule.create.surfersRequired');
    }
  }

  return { ok: true };
}

function schedulePortalInvalidateCreateQuoteIntent(result) {
  schedulePortalInvalidatePreviewWork();
  schedulePortalQuoteState = null;
  if (result) schedulePortalRenderCreateQuotePreview(result);
  else { var b = el('ps-create-quote-preview'); if (b) { b.innerHTML = ''; b.style.display = 'none'; } }
  return schedulePortalQuoteGen;
}

function schedulePortalShowQuoteChecking() {
  var box = el('ps-create-quote-preview'); if (!box) return;
  try { box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); } catch (_e) { /* ignore */ }
  box.innerHTML = '<p class="portal-schedule-drawer-hint portal-schedule-quote-checking" style="margin:0">'
    + escHtml(portalT('schedule.create.checkingPrice') || 'Checking price\u2026') + '</p>';
  box.style.display = 'block';
}

function schedulePortalRenderCreateQuotePreview(result) {
  var box = el('ps-create-quote-preview'); if (!box) return;
  if (result && (result.superseded || result.aborted)) return;
  try { box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); } catch (_e) { /* ignore */ }
  if (result && (result.idle || result.softInvalid)) {
    schedulePortalQuoteState = null; box.innerHTML = ''; box.style.display = 'none'; return;
  }
  if (result && result.checking) { schedulePortalShowQuoteChecking(); return; }
  if (!result || !result.ok) {
    var err = portalT('schedule.create.quoteFailed') || 'Quote unavailable';
    if (result && result.stale) err = portalT('schedule.create.quoteStale') || 'Price changed — refresh quote before creating.';
    else if (result && result.status === 503) err = portalT('schedule.create.quoteBusy') || 'Price check is busy — wait a moment and try again.';
    box.innerHTML = '<p class="portal-schedule-drawer-hint" style="margin:0;color:var(--danger,#b33)">' + escHtml(String(err)) + '</p>';
    box.style.display = 'block'; return;
  }
  // Never paint a total whose pricing intent no longer matches the live Create form.
  if (result.intent_key != null || (schedulePortalQuoteState && schedulePortalQuoteState.intent_key != null)) {
    var livePayload = null;
    try { livePayload = typeof scheduleReadCreatePayload === 'function' ? scheduleReadCreatePayload() : null; } catch (_lp) { livePayload = null; }
    var liveIntent = typeof schedulePortalQuotePricingIntentKey === 'function' && livePayload
      ? schedulePortalQuotePricingIntentKey(livePayload) : null;
    var resultIntent = result.intent_key != null
      ? result.intent_key
      : (schedulePortalQuoteState && schedulePortalQuoteState.intent_key);
    if (liveIntent != null && resultIntent != null && liveIntent !== resultIntent) {
      schedulePortalQuoteState = null;
      box.innerHTML = '';
      box.style.display = 'none';
      return;
    }
  }
  var raw = typeof schedulePortalStrictQuoteTotalCents === 'function' ? schedulePortalStrictQuoteTotalCents(result.body) : (result.body && result.body.total_cents);
  if (raw == null || (typeof schedulePortalStrictQuoteTotalCents !== 'function' && (typeof raw !== 'number' || !Number.isFinite(raw) || Math.floor(raw) !== raw || raw < 0 || raw > Number.MAX_SAFE_INTEGER))) {
    box.innerHTML = '<p class="portal-schedule-drawer-hint" style="margin:0;color:var(--danger,#b33)">'
      + escHtml(portalT('schedule.create.quoteFailed') || 'Quote unavailable') + '</p>';
    box.style.display = 'block'; return;
  }
  box.innerHTML = '<p class="portal-schedule-drawer-hint" style="margin:0">'
    + escHtml((portalT('schedule.create.quoteTotal') || 'Quoted total') + ': \u20ac' + (raw / 100).toFixed(2)) + '</p>';
  box.style.display = 'block';
}

function schedulePortalRentalLabel(offeringKey) {
  var key = String(offeringKey || '');
  var i18nKey = (typeof scheduleRentalOfferingLabelKey === 'function' && scheduleRentalOfferingLabelKey(key))
    || (key === 'wetsuit_rental' ? 'schedule.type.wetsuitRental' : key === 'board_and_suit_rental' ? 'schedule.ops.rentalBoth'
      : key === 'board_rental' ? 'schedule.type.boardRental' : '');
  var lab = i18nKey ? portalT(i18nKey) : '';
  return (lab && lab !== i18nKey) ? lab : '';
}
function schedulePortalDurationLabel(durationKey) {
  var key = String(durationKey || '').trim(); if (!key) return '';
  if (typeof adminPeriodLabel === 'function') { var al = adminPeriodLabel(key); if (al && al !== '???' && al !== key) return al; }
  var tKey = 'admin.period.' + key, t = portalT(tKey); return (t && t !== tKey) ? t : '';
}
function schedulePortalHumanCourseBit(course) {
  var id = course && course.course_id != null ? String(course.course_id).trim() : '';
  var sel = el('ps-create-course-select');
  var opt = (sel && sel.options && sel.selectedIndex >= 0) ? sel.options[sel.selectedIndex] : null;
  var cands = [opt ? String((opt.getAttribute && opt.getAttribute('data-label')) || opt.textContent || '').trim() : '',
    course && course.course_label != null ? String(course.course_label).trim() : ''];
  if (typeof scheduleResolveCourseDisplayLabel === 'function') cands.push(String(scheduleResolveCourseDisplayLabel(id, cands[1]) || '').trim());
  for (var i = 0; i < cands.length; i++) {
    var lab = cands[i];
    if (!lab || (id && lab === id) || (course && course.tier_key && lab === String(course.tier_key))) continue;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lab)) continue;
    return lab;
  }
  return '';
}

/**
 * Compact sticky-footer date without years.
 * Same month: "27–31 Jul"; cross-month: "30 Jul–2 Aug". Never includes YYYY.
 * Locale via getStaffLocale() when present (en/es/it).
 */
function schedulePortalFormatCompactDateRange(fromIso, toIso) {
  var from = String(fromIso || '').slice(0, 10);
  var to = String(toIso == null || toIso === '' ? from : toIso).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) to = from;
  var loc = 'en';
  try {
    if (typeof getStaffLocale === 'function') loc = String(getStaffLocale() || 'en');
  } catch (_l) { loc = 'en'; }
  var localeTag = loc === 'es' ? 'es' : loc === 'it' ? 'it' : 'en';
  function part(iso) {
    var y = Number(iso.slice(0, 4));
    var m = Number(iso.slice(5, 7));
    var d = Number(iso.slice(8, 10));
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    // UTC noon avoids TZ day-shift when formatting calendar dates.
    var dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    var mon = '';
    try {
      mon = new Intl.DateTimeFormat(localeTag, { month: 'short', timeZone: 'UTC' }).format(dt);
    } catch (_e) {
      mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] || '';
    }
    mon = String(mon || '').replace(/\.$/, '');
    if (mon) mon = mon.charAt(0).toUpperCase() + mon.slice(1);
    return { day: d, mon: mon, month: m, year: y };
  }
  var a = part(from); if (!a || !a.mon) return '';
  var b = part(to); if (!b || !b.mon) b = a;
  if (from === to) return String(a.day) + ' ' + a.mon;
  if (a.month === b.month && a.year === b.year) {
    return String(a.day) + '\u2013' + String(b.day) + ' ' + a.mon;
  }
  return String(a.day) + ' ' + a.mon + '\u2013' + String(b.day) + ' ' + b.mon;
}

function schedulePortalRenderCreateIntentSummary(payload) {
  var box = el('ps-create-summary'); if (!box) return;
  var p = payload;
  if (!p && typeof scheduleReadCreatePayload === 'function') { try { p = scheduleReadCreatePayload(); } catch (_e) { p = null; } }
  p = p || {};
  var comps = p.components || {}, rentals = Array.isArray(p.rentals) ? p.rentals : [];
  if (comps.private_lesson) {
    var plGate = null;
    try { plGate = schedulePortalValidatePrivateLessonCreate(comps.private_lesson); } catch (_pl) { plGate = { ok: false }; }
    if (!plGate || plGate.ok !== true) {
      box.innerHTML = '<span class="portal-schedule-create-summary-text">'
        + escHtml(portalT('schedule.create.summary.completeSessions') || 'Complete session details') + '</span>'; return;
    }
  }
  var hasLesson = !!(comps.course || comps.private_lesson);
  var hasGear = rentals.length > 0 || !!(comps.surfboard || comps.wetsuit || comps.full_day_equipment_extension);
  var customLines = Array.isArray(p.custom_line_items) ? p.custom_line_items : [];
  var hasCustom = customLines.some(function(l) { return l && String(l.label || '').trim(); });
  if (!hasLesson && !hasGear && !hasCustom) {
    box.innerHTML = '<span class="portal-schedule-create-summary-placeholder">'
      + escHtml(portalT('schedule.create.summary.chooseLessonOrGear') || 'Choose a lesson or add gear') + '</span>'; return;
  }

  // Two-row sticky summary: primary = identity/qty/gear/custom; secondary = one duration + compact date + guest.
  // Payment status is owned by the Payment Status control above — never repeated here.
  var primary = [];
  var secondary = [];
  var durationLab = '';

  if (comps.course) {
    var cLab = schedulePortalHumanCourseBit(comps.course);
    // Prefer the selected course name; only fall back to generic "Group course" when unnamed.
    if (cLab) primary.push(cLab);
    else primary.push(portalT('schedule.type.course') || 'Group course');
    // Duration label from derived payload/catalog state only — never hidden #ps-create-course-tier.
    var tierLab = comps.course.tier_label != null ? String(comps.course.tier_label).trim() : '';
    if (!tierLab && comps.course.tier_key) {
      tierLab = schedulePortalDurationLabel(comps.course.tier_key) || '';
    }
    if (tierLab && tierLab !== String(comps.course.tier_key || '')) durationLab = tierLab;
    if (comps.course.quantity) primary.push('\u00d7' + String(comps.course.quantity));
  } else if (comps.private_lesson) {
    var pl = comps.private_lesson;
    primary.push(portalT('schedule.type.privateLesson') || 'Private course');
    var sessN = Array.isArray(pl.sessions) ? pl.sessions.length : (pl.quantity || 0);
    if (sessN) primary.push((portalT('schedule.create.summary.sessions') || 'Sessions') + ': ' + String(sessN));
    if (pl.surfer_count) primary.push((portalT('schedule.create.summary.surfers') || 'Surfers') + ': ' + String(pl.surfer_count));
    var dates = (pl.sessions || []).map(function(s) { return s && s.date ? String(s.date).slice(0, 10) : ''; }).filter(Boolean).sort();
    if (dates.length && typeof schedulePortalFormatCompactDateRange === 'function') {
      var plCompact = schedulePortalFormatCompactDateRange(
        dates[0],
        dates.length > 1 ? dates[dates.length - 1] : dates[0],
      );
      if (plCompact) secondary.push(plCompact);
    }
  } else {
    primary.push(portalT('schedule.type.noLesson') || 'No lesson');
  }

  function gearLabelOnly(key, q) {
    var lab = schedulePortalRentalLabel(key); if (!lab) return '';
    return (Number(q) > 1) ? (lab + ' \u00d7' + q) : lab;
  }
  if (rentals.length) {
    var gearBits = [];
    for (var ri = 0; ri < rentals.length; ri++) {
      var r = rentals[ri];
      if (!r || !r.offering_key) continue;
      var gLab = gearLabelOnly(r.offering_key, r.quantity);
      if (gLab) gearBits.push(gLab);
      // One shared duration only — do not repeat per gear line or after course duration.
      if (!durationLab && r.duration_key) {
        var gDur = schedulePortalDurationLabel(r.duration_key);
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
  var guest = p.guest_name != null ? String(p.guest_name).trim() : '';
  if (guest) secondary.push(guest);

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

/** Disable Create until guest name nonblank and phone valid; quote may still run while blank. */
function schedulePortalSyncCreateSubmitEnabled() {
  var btn = el('ps-create-submit');
  if (!btn) return;
  if (schedulePortalSubmitInFlight) {
    btn.disabled = true;
    return;
  }
  var guest = (el('ps-create-guest') && el('ps-create-guest').value || '').trim();
  var phone = (el('ps-create-phone') && el('ps-create-phone').value || '').trim();
  btn.disabled = !guest || !schedulePortalIsValidCreatePhone(phone);
}

function schedulePortalSyncCreateFooter(opts) {
  opts = opts || {};
  var payload = null;
  try { payload = typeof scheduleReadCreatePayload === 'function' ? scheduleReadCreatePayload() : null; } catch (_p) { payload = null; }
  schedulePortalRenderCreateIntentSummary(payload);
  // Drop stale € totals before painting summary for a new date/rental intent.
  if (typeof schedulePortalDropStaleQuoteUi === 'function') schedulePortalDropStaleQuoteUi(payload);
  schedulePortalSyncCreateSubmitEnabled();
  if (opts.quote === false) return;
  if (typeof schedulePortalRefreshCreateQuote === 'function') schedulePortalRefreshCreateQuote();
}

function schedulePortalWireCreateFooter() {
  // Guest name/phone: summary + Create enable only (quote soft-gate ignores blanks).
  // Payment: summary only (no quote).
  [['ps-create-guest', true], ['ps-create-phone', true], ['ps-create-payment', false]].forEach(function(pair) {
    var node = el(pair[0]); if (!node || node.dataset.footerWired === '1') return;
    node.dataset.footerWired = '1';
    var fire = function() {
      schedulePortalRenderCreateIntentSummary();
      schedulePortalSyncCreateSubmitEnabled();
    };
    node.addEventListener('change', fire);
    if (pair[1]) node.addEventListener('input', fire);
  });
  schedulePortalSyncCreateSubmitEnabled();
}

function schedulePortalSetCreateStatus(text, isError) {
  var msg = el('ps-create-msg'); if (!msg) return;
  if (!text) { msg.textContent = ''; msg.style.display = 'none'; return; }
  msg.textContent = text; msg.style.display = 'block';
  try { if (isError) msg.classList.add('error'); else msg.classList.remove('error'); } catch (_e) { /* ignore */ }
}

function schedulePortalClearQuotePreviewUi() {
  schedulePortalQuoteState = null;
  var box = el('ps-create-quote-preview'); if (box) { box.innerHTML = ''; box.style.display = 'none'; }
}

function schedulePortalRunPreviewQuote() {
  if (schedulePortalSubmitInFlight) return Promise.resolve(null);
  var payload = scheduleReadCreatePayload();
  // Shared soft gate; inline abort/clear (Slice 4 harnesses lack Invalidate).
  var softGate = null;
  try { softGate = schedulePortalValidateCreatePayload(payload || {}, { soft: true }); }
  catch (_sg) { softGate = { ok: false, softInvalid: true }; }
  if (!softGate || softGate.ok !== true) {
    if (schedulePortalQuoteTimer != null) { clearTimeout(schedulePortalQuoteTimer); schedulePortalQuoteTimer = null; }
    if (schedulePortalQuoteAbort) { try { schedulePortalQuoteAbort.abort(); } catch (_i) { /* ignore */ } schedulePortalQuoteAbort = null; }
    schedulePortalQuoteGen += 1;
    schedulePortalClearQuotePreviewUi();
    if (softGate && softGate.idle === true) {
      if (typeof schedulePortalRenderCreateQuotePreview === 'function') schedulePortalRenderCreateQuotePreview({ idle: true });
      return Promise.resolve(null);
    }
    if (payload && payload.components && payload.components.private_lesson
      && typeof schedulePortalRenderCreateIntentSummary === 'function') {
      schedulePortalRenderCreateIntentSummary(payload);
    }
    if (typeof schedulePortalRenderCreateQuotePreview === 'function') {
      schedulePortalRenderCreateQuotePreview({ ok: false, softInvalid: true });
    }
    return Promise.resolve({ ok: false, softInvalid: true, errorKey: softGate && softGate.errorKey });
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
  if (typeof schedulePortalShowQuoteChecking === 'function') schedulePortalShowQuoteChecking();

  return schedulePortalFetchQuote(payload, {
    gen: myGen,
    signal: controller ? controller.signal : undefined,
    applyState: true,
  }).then(function(result) {
    if (myGen !== schedulePortalQuoteGen || schedulePortalSubmitInFlight) return { ok: false, superseded: true };
    if (result && result.aborted) return result;
    if (typeof schedulePortalRenderCreateQuotePreview === 'function') {
      schedulePortalRenderCreateQuotePreview(result);
    }
    return result;
  }).catch(function(err) {
    if (myGen !== schedulePortalQuoteGen || schedulePortalSubmitInFlight) return { ok: false, superseded: true };
    if (typeof schedulePortalRenderCreateQuotePreview === 'function') {
      schedulePortalRenderCreateQuotePreview({ ok: false, error: err && err.message });
    }
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
  var payload = null;
  try { payload = typeof scheduleReadCreatePayload === 'function' ? scheduleReadCreatePayload() : null; } catch (_r) { payload = null; }
  // Immediate soft gate: abort, clear Ready, zero network.
  var softGate = null;
  try { softGate = schedulePortalValidateCreatePayload(payload || {}, { soft: true }); }
  catch (_sg) { softGate = { ok: false, softInvalid: true }; }
  if (!softGate || softGate.ok !== true) {
    var inv = (softGate && softGate.idle === true) ? { idle: true } : { ok: false, softInvalid: true };
    schedulePortalInvalidateCreateQuoteIntent(inv);
    if (!inv.idle && payload && payload.components && payload.components.private_lesson) {
      try { schedulePortalRenderCreateIntentSummary(payload); } catch (_s) { /* ignore */ }
    }
    return Promise.resolve(null);
  }
  if (schedulePortalQuoteAbort) {
    try { schedulePortalQuoteAbort.abort(); } catch (_a) { /* ignore */ }
    schedulePortalQuoteAbort = null;
  }
  schedulePortalQuoteGen += 1;
  // Invalidate prior total immediately so a 1-day €40 cannot linger beside a
  // multi-day summary while the debounced requote is in flight.
  schedulePortalQuoteState = null;
  schedulePortalShowQuoteChecking();
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

/* Date-driven duration + private sessions */

/** Inclusive calendar-day count (DST-safe noon enumeration). */
function schedulePortalInclusiveDateCount(dateFrom, dateTo) {
  var df = schedulePortalCanonicalDateIso(dateFrom);
  var dt = schedulePortalCanonicalDateIso(dateTo != null ? dateTo : dateFrom);
  if (!df || !dt || df > dt) return 0;
  if (typeof scheduleEnumerateDates !== 'function') return 0;
  return (scheduleEnumerateDates(df, dt) || []).length;
}

/** Exact sellable matches by projected duration_days only (no key guessing/nearest). */
function schedulePortalMatchSellableCourseTiersByDurationDays(course, durationDays) {
  var n = Number(durationDays);
  if (!course || !Number.isFinite(n) || n < 1) return [];
  var tiers = Array.isArray(course.price_tiers) ? course.price_tiers : [];
  var out = [];
  for (var i = 0; i < tiers.length; i++) {
    var t = tiers[i];
    if (!t || t.bookable === false) continue;
    if (Number(t.duration_days) === n) out.push(t);
  }
  return out;
}

/** Resolve tier from inclusive dates + catalog duration_days. 0→unavailable; >1→ambiguous. */
function schedulePortalResolveDerivedCourseTier(courseId, dateFrom, dateTo) {
  var id = String(courseId || '').trim();
  if (!id) return { ok: false, errorKey: 'schedule.create.courseRequired' };
  var days = schedulePortalInclusiveDateCount(dateFrom, dateTo);
  if (days < 1) return { ok: false, errorKey: 'calendar.state.invalidDateRange' };
  // Group courses: max 14 inclusive days. Price for 8–14 is server-owned from Admin 7_days.
  if (days > 14) {
    return { ok: false, errorKey: 'schedule.create.courseDurationUnavailable', duration_days: days };
  }
  var course = null;
  var cache = (typeof scheduleCoursesCache !== 'undefined' && scheduleCoursesCache) || [];
  for (var i = 0; i < cache.length; i++) {
    if (String((cache[i] && cache[i].course_id) || '').trim() === id) { course = cache[i]; break; }
  }
  // Days 8–14: identity is the Admin 7_days row only (no 8–14 Admin options / no client math).
  if (days >= 8 && days <= 14) {
    var tiers814 = Array.isArray(course && course.price_tiers) ? course.price_tiers : [];
    var seven = null;
    for (var j = 0; j < tiers814.length; j++) {
      var t814 = tiers814[j];
      if (!t814 || t814.bookable === false) continue;
      if (String(t814.key || '').trim() === '7_days') { seven = t814; break; }
    }
    if (!seven) {
      return { ok: false, errorKey: 'schedule.create.courseDurationUnavailable', duration_days: days };
    }
    return {
      ok: true,
      tier_key: '7_days',
      duration_days: days,
      offering_id: seven.offering_id || ('surf_pack_' + id + '__7_days'),
      tier_label: seven.label != null ? String(seven.label) : '',
      pricing_basis: '7_days_prorate',
    };
  }
  var matches = schedulePortalMatchSellableCourseTiersByDurationDays(course, days);
  if (!matches.length) {
    return { ok: false, errorKey: 'schedule.create.courseDurationUnavailable', duration_days: days };
  }
  if (matches.length > 1) {
    return { ok: false, errorKey: 'schedule.create.courseDurationAmbiguous', duration_days: days };
  }
  var tier = matches[0];
  return {
    ok: true,
    tier_key: String(tier.key),
    duration_days: days,
    offering_id: tier.offering_id || ('surf_pack_' + id + '__' + tier.key),
    tier_label: tier.label != null ? String(tier.label) : '',
  };
}

/** Fixed Create default start — never wall-clock/current time. Local wall-clock HH:MM only. */
function schedulePrivateLessonDefaultStartHm() {
  return '10:00';
}

function schedulePrivateLessonDefaultEnd(startHm, durationMin) {
  var startM = scheduleSlotMinutesFromToken(startHm);
  if (startM == null) return '';
  return scheduleMinutesLabel(startM + (durationMin || schedulePrivateLessonDurationCache || 120));
}

/**
 * Apply Create defaults only for blank private times (new selection / new date row).
 * Never invent clock-now; never overwrite non-blank user/edit values.
 * Default window: 10:00 → +duration (120 → 12:00) on the session's local service date.
 */
function schedulePrivateLessonApplyBlankTimeDefaults(startRaw, endRaw) {
  var start = startRaw != null ? String(startRaw).trim() : '';
  var end = endRaw != null ? String(endRaw).trim() : '';
  if (start && end) return { start: start, end: end };
  if (!start) {
    start = schedulePrivateLessonDefaultStartHm();
    if (!end) end = schedulePrivateLessonDefaultEnd(start);
    return { start: start, end: end };
  }
  // Start present, end blank → duration-based end only (same as start-change wiring).
  if (!end) end = schedulePrivateLessonDefaultEnd(start);
  return { start: start, end: end || '' };
}

function scheduleReadPrivateLessonSessionsFromDom() {
  var wrap = el('ps-create-private-lesson-sessions'), sessions = [];
  if (!wrap) return sessions;
  wrap.querySelectorAll('.portal-schedule-private-session-row').forEach(function(row) {
    var dateAttr = row.getAttribute('data-session-date') || '';
    var dateEl = row.querySelector('.ps-pl-session-date');
    var startEl = row.querySelector('.ps-pl-session-start');
    var endEl = row.querySelector('.ps-pl-session-end');
    sessions.push({
      date: dateAttr || (dateEl ? dateEl.value : ''),
      start: startEl ? startEl.value : '',
      end: endEl ? endEl.value : '',
    });
  });
  return sessions;
}

/** After DOM finals: rentals + full-day + one total-preview/quote. Outer dates stay authoritative. */
function schedulePrivateLessonSessionsRefreshDependents() {
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
      if (!curEnd || curEnd === schedulePrivateLessonDefaultEnd(startEl.defaultValue || '')) endEl.value = defEnd;
      startEl.defaultValue = startEl.value;
    });
  }
  ['.ps-pl-session-start', '.ps-pl-session-end'].forEach(function(sel) {
    var f = row.querySelector(sel);
    if (!f || f.dataset.sessionFieldWired) return;
    f.dataset.sessionFieldWired = '1';
    f.addEventListener('change', schedulePrivateLessonSessionsRefreshDependents);
  });
}

/**
 * Owner: reconcile private session rows from authoritative top-level From/To.
 * Preserve times for dates that remain; blank times for new dates; drop outside range.
 * No Add/Remove controls — rows are date-range-derived only.
 */
function scheduleSyncPrivateLessonSessions(opts) {
  opts = opts || {};
  var wrap = el('ps-create-private-lesson-sessions');
  var qtyEl = el('ps-create-private-lesson-qty');
  if (!wrap) return;
  var df = el('ps-create-date-from') && el('ps-create-date-from').value;
  var dt = el('ps-create-date-to') && el('ps-create-date-to').value;
  var from = schedulePortalCanonicalDateIso(df);
  var to = schedulePortalCanonicalDateIso(dt || df);
  var dates = [];
  if (from && to && from <= to && typeof scheduleEnumerateDates === 'function') {
    dates = scheduleEnumerateDates(from, to) || [];
  }
  // Fail closed >30: no partial rows; outer From/To preserved for validation.
  var rangeTooLong = dates.length > 30;
  if (rangeTooLong) dates = [];
  var existing = rangeTooLong ? [] : scheduleReadPrivateLessonSessionsFromDom();
  var byDate = Object.create(null);
  for (var e = 0; e < existing.length; e++) {
    var ed = schedulePortalCanonicalDateIso(existing[e] && existing[e].date);
    if (ed && byDate[ed] == null) byDate[ed] = existing[e];
  }
  var html = '';
  for (var i = 0; i < dates.length; i++) {
    var date = dates[i];
    var prev = byDate[date] || {};
    // Blank (new Private / new date in range) → 10:00–12:00 local defaults.
    // Non-blank times for a date that remains are preserved across re-render/toggle.
    var applied = schedulePrivateLessonApplyBlankTimeDefaults(prev.start, prev.end);
    var start = applied.start;
    var end = applied.end;
    html += '<div class="portal-schedule-private-session-row" data-session-index="' + String(i + 1)
      + '" data-session-date="' + escHtml(date) + '">'
      + '<p class="portal-schedule-card-sub" style="margin:8px 0 4px">'
      + escHtml(portalT('schedule.create.privateLesson.sessionLabel')) + ' '
      + escHtml(date) + '</p>'
      + '<div class="portal-schedule-private-session-grid">'
      + '<label><span data-i18n="schedule.create.privateLesson.start">Start</span>'
      + '<input class="ps-pl-session-start" type="time" value="' + escHtml(start) + '"></label>'
      + '<label><span data-i18n="schedule.create.privateLesson.end">End</span>'
      + '<input class="ps-pl-session-end" type="time" value="' + escHtml(end) + '"></label>'
      + '</div></div>';
  }
  wrap.innerHTML = html;
  try {
    if (rangeTooLong) wrap.setAttribute('data-range-too-long', '1');
    else wrap.removeAttribute('data-range-too-long');
  } catch (_r) { /* ignore */ }
  if (qtyEl) qtyEl.value = String(dates.length || 0);
  wrap.querySelectorAll('.portal-schedule-private-session-row').forEach(scheduleWirePrivateLessonSessionRow);
  var modal = el('ps-create-modal');
  if (modal && typeof window.applyStaffPortalI18n === 'function') window.applyStaffPortalI18n(modal);
  if (!opts.deferSideEffects) schedulePrivateLessonSessionsRefreshDependents();
}

/** Outer dates are authoritative — sessions never rewrite From/To. */
function scheduleUpdatePrivateLessonDateRangeFromSessions() {
  return;
}

function scheduleAddPrivateLessonSession() {
  return;
}

function scheduleRemovePrivateLessonSession() {
  return;
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
    if (prev) sel.value = prev;
    schedulePortalApplyDesiredCourseSelect();
    if (!sel._tierBound) {
      sel._tierBound = true;
      sel.addEventListener('change', function() {
        // Duration is date-derived; do not rely on hidden tier selector state.
        schedulePortalSyncCreateFooter();
      });
    }
    if (!sel._dateBound) {
      sel._dateBound = true;
      ['ps-create-date-from', 'ps-create-date-to'].forEach(function(id) {
        var node = el(id);
        if (!node || node._courseEligBound) return;
        node._courseEligBound = true;
        node.addEventListener('change', function() {
          // Date change: clear Ready immediately via footer soft-gate; re-resolve after catalog.
          schedulePortalSyncCreateFooter();
          schedulePortalPopulateCreateCourseFields().then(function() { schedulePortalSyncCreateFooter(); });
        });
      });
    }
    return courses;
  });
}

function scheduleUpdateCreateTotalPreview() {
  scheduleUpdateFullDayAddonSummary('ps-create-fullday-rows', 'ps-create-fullday-summary');
  schedulePortalSyncCreateFooter();
}

function submitScheduleManualBooking() {
  if (schedulePortalSubmitInFlight) return;

  var payload = scheduleReadCreatePayload();
  var submitBtn = el('ps-create-submit');
  var msg = el('ps-create-msg');
  // Shared owner: sellable (rental-only ok), guest, course/tier, dates, private
  // (schedulePortalValidatePrivateLessonCreate), rental rows.
  var gate = null;
  try { gate = schedulePortalValidateCreatePayload(payload, { soft: false }); }
  catch (_g) { gate = { ok: false, errorKey: 'schedule.create.componentsRequired' }; }
  if (!gate || gate.ok !== true) {
    if (msg) {
      msg.textContent = portalT((gate && gate.errorKey) || 'schedule.create.componentsRequired');
      msg.style.display = 'block';
    }
    return;
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
    if (!succeeded) schedulePortalSyncCreateSubmitEnabled();
  });
}
