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
 * scheduleRowsCache, scheduleResetNavigationAfterBookingCreate, scheduleRequestPageLoad, scheduleTodayIso,
 * scheduleEnumerateDates, scheduleRefreshCreateFullDayAddon, scheduleUpdateFullDayAddonSummary.
 */

var schedulePortalQuoteState = null;

function schedulePortalClientQuery() {
  return 'client=' + encodeURIComponent(getClient()) + sunsetLocationQuerySuffix();
}

function schedulePortalFetchJson(url, opts) {
  opts = opts || {};
  return fetch(url, opts).then(function(r) {
    return r.json().then(function(data) {
      return { ok: r.ok, status: r.status, data: data };
    });
  });
}

/** GET/POST /staff/schedule/bookings/catalog — canonical offerings (no config-json price fallback). */
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

/** POST /staff/schedule/bookings/quote — authoritative price + provenance. */
function schedulePortalFetchQuote(createPayload) {
  var body = {
    location_id: getSunsetLocation(),
    date_from: createPayload.date_from,
    date_to: createPayload.date_to,
    components: createPayload.components,
    service_dates: schedulePortalServiceDatesFromPayload(createPayload),
  };
  return schedulePortalFetchJson('/staff/schedule/bookings/quote?' + schedulePortalClientQuery(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function(res) {
    var data = res.data || {};
    if (!res.ok || !data.success) {
      return {
        ok: false,
        error: data.error || data.reason || data.reason_code || ('HTTP ' + res.status),
        stale: data.reason_code === 'quote_stale' || data.reason === 'quote_stale',
        body: data,
      };
    }
    schedulePortalQuoteState = {
      quote_provenance: data.quote_provenance || null,
      total_cents: data.total_cents != null ? Number(data.total_cents) : null,
      fetched_at: Date.now(),
    };
    return { ok: true, body: data };
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

/** GET /staff/schedule/bookings/detail */
function schedulePortalFetchDrawerDetail(row) {
  var q = schedulePortalClientQuery();
  if (row.booking_id) q += '&booking_id=' + encodeURIComponent(row.booking_id);
  else if (row.booking_code) q += '&booking_code=' + encodeURIComponent(row.booking_code);
  return schedulePortalFetchJson('/staff/schedule/bookings/detail?' + q).then(function(res) {
    return res.data;
  });
}

/** GET /staff/schedule/bookings/payment-link — canonical payment lifecycle read. */
function schedulePortalFetchPaymentLink(bookingId, bookingCode) {
  var q = schedulePortalClientQuery();
  if (bookingId) q += '&booking_id=' + encodeURIComponent(bookingId);
  else if (bookingCode) q += '&booking_code=' + encodeURIComponent(bookingCode);
  return schedulePortalFetchJson('/staff/schedule/bookings/payment-link?' + q).then(function(res) {
    return res.data;
  });
}

/** Resolve actionable Stripe URL for drawer render — never show invalidated/cancelled links. */
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

/** POST /staff/schedule/bookings with quote provenance from last canonical quote. */
function schedulePortalSubmitCreate(createPayload) {
  var body = Object.assign({}, createPayload, {
    location_id: getSunsetLocation(),
  });
  if (schedulePortalQuoteState && schedulePortalQuoteState.quote_provenance) {
    body.quote_provenance = schedulePortalQuoteState.quote_provenance;
  }
  return schedulePortalFetchJson('/staff/schedule/bookings?' + schedulePortalClientQuery(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Drawer access gates (Staff + Luna persisted rows share canonical drawer) ──

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
  if (!result || !result.ok) {
    var err = (result && result.error) || portalT('schedule.create.quoteFailed') || 'Quote unavailable';
    if (result && result.stale) {
      err = portalT('schedule.create.quoteStale') || 'Price changed — refresh quote before creating.';
    }
    box.innerHTML = '<p class="portal-schedule-drawer-hint" style="margin:0;color:var(--danger,#b33)">' + escHtml(String(err)) + '</p>';
    box.style.display = 'block';
    schedulePortalQuoteState = null;
    return;
  }
  var total = result.body.total_cents != null ? result.body.total_cents : null;
  var label = total != null
    ? (portalT('schedule.create.quoteTotal') || 'Quoted total') + ': \u20ac' + (Number(total) / 100).toFixed(2)
    : (portalT('schedule.create.quoteReady') || 'Quote ready');
  box.innerHTML = '<p class="portal-schedule-drawer-hint" style="margin:0">' + escHtml(label) + '</p>';
  box.style.display = 'block';
}

function schedulePortalRefreshCreateQuote() {
  var payload = scheduleReadCreatePayload();
  if (!Object.keys(payload.components || {}).length) {
    schedulePortalQuoteState = null;
    var box = el('ps-create-quote-preview');
    if (box) { box.innerHTML = ''; box.style.display = 'none'; }
    return Promise.resolve(null);
  }
  return schedulePortalFetchQuote(payload).then(function(result) {
    schedulePortalRenderCreateQuotePreview(result);
    return result;
  }).catch(function(err) {
    schedulePortalRenderCreateQuotePreview({ ok: false, error: err && err.message });
    return null;
  });
}

/** Populate course dropdown from canonical catalog POST (server eligibility flags). */
function schedulePortalPopulateCreateCourseFields() {
  var sel = el('ps-create-course-select');
  if (!sel) return Promise.resolve();
  var dates = scheduleCreateSelectedDates();
  return schedulePortalFetchCatalog({ service_dates: dates, method: 'POST' }).then(function(catalogData) {
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
    var pl = payload.components.private_lesson;
    if (!pl.sessions || pl.sessions.length !== pl.quantity) {
      if (msg) { msg.textContent = portalT('schedule.create.privateLesson.sessionsMismatch'); msg.style.display = 'block'; }
      return;
    }
    for (var si = 0; si < pl.sessions.length; si++) {
      var sess = pl.sessions[si];
      if (!sess.date || !sess.start || !sess.end) {
        if (msg) { msg.textContent = portalT('schedule.create.privateLesson.sessionIncomplete'); msg.style.display = 'block'; }
        return;
      }
    }
  }
  if (submitBtn) submitBtn.disabled = true;
  if (msg) msg.style.display = 'none';

  var quoteP = schedulePortalFetchQuote(payload);
  quoteP.then(function(quoteResult) {
    if (!quoteResult || !quoteResult.ok) {
      var qErr = (quoteResult && quoteResult.error) || (portalT('schedule.create.quoteFailed') || 'Could not quote booking');
      if (quoteResult && quoteResult.stale) {
        qErr = portalT('schedule.create.quoteStale') || 'Price changed — refresh and try again.';
      }
      throw new Error(qErr);
    }
    schedulePortalRenderCreateQuotePreview(quoteResult);
    return schedulePortalSubmitCreate(payload);
  }).then(function(res) {
    if (!res.ok || !res.data || res.data.success !== true) {
      var d = res.data || {};
      if (d.reason_code === 'quote_stale' || d.reason === 'quote_stale') {
        throw new Error(portalT('schedule.create.quoteStale') || 'Quote expired — refresh price and try again.');
      }
      throw new Error(d.error || d.message || ('HTTP ' + res.status));
    }
    var createdCode = res.data.booking_code || (res.data.bookings && res.data.bookings[0] && res.data.bookings[0].booking_code);
    closeScheduleCreateModal();
    scheduleResetNavigationAfterBookingCreate();
    schedulePortalQuoteState = null;
    scheduleRequestPageLoad();
    if (createdCode) {
      setTimeout(function() {
        var row = (scheduleRowsCache || []).find(function(r) { return r.booking_code === createdCode; });
        if (row && typeof openScheduleDetailDrawer === 'function') openScheduleDetailDrawer(row);
      }, 800);
    }
  }).catch(function(err) {
    if (msg) {
      msg.textContent = (portalT('schedule.create.failed') || 'Create failed') + ' ' + (err && err.message ? err.message : String(err));
      msg.style.display = 'block';
    }
  }).finally(function() {
    if (submitBtn) submitBtn.disabled = false;
  });
}
