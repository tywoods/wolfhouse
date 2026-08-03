/**
 * Sunset Admin Bookings tab (N1) — list, filters, expansion, manual refund UI.
 * Injected with sunset-admin-ui.js. Uses portal globals: el, portalT, escHtml,
 * getClient, getSunsetLocation, fetch, openCustomerCardForPhone, switchToTab.
 * Money display only — all arithmetic is server-authoritative.
 */
/* global el, portalT, escHtml, getClient, getSunsetLocation, openCustomerCardForPhone,
   adminBookingsState, fetch */

var adminBookingsState = {
  loading: false,
  error: null,
  data: null,
  expandedId: null,
  filters: {
    q: '',
    date_from: '',
    date_to: '',
    status: '',
    type: '',
    include_archived: false,
    limit: 50,
    offset: 0,
  },
  role: null,
  /** Monotonic generation for stale-response suppression across filter/page/location loads. */
  loadGeneration: 0,
  loadAbort: null,
  /** Single-flight refund: one in-flight POST + stable idempotency key per user action. */
  refundInFlight: false,
  refundIdempotencyKey: null,
  refundBookingId: null,
};

function adminBookingsCanWriteRefund() {
  var session = (typeof staffPortalSession !== 'undefined') ? staffPortalSession : null;
  var sessionRole = (session && session.role) ? session.role : '';
  var role = String(adminBookingsState.role || sessionRole || window.__STAFF_PORTAL_ROLE__ || '').toLowerCase();
  // Server still enforces operator+ on POST; UI only hides for known viewers.
  if (role === 'viewer') return false;
  if (role === 'operator' || role === 'admin' || role === 'owner') return true;
  return !!(session && session.auth_required === false);
}

function adminBookingsFormatEur(cents) {
  var n = Number(cents || 0);
  if (!Number.isFinite(n)) n = 0;
  var neg = n < 0;
  var abs = Math.abs(Math.round(n));
  var whole = Math.floor(abs / 100);
  var frac = String(abs % 100).padStart(2, '0');
  return (neg ? '-' : '') + '€' + whole + '.' + frac;
}

function adminBookingsStatusLabel(status) {
  var s = String(status || '').toLowerCase();
  var key = 'admin.bookings.status.' + s;
  var t = portalT(key);
  if (t && t !== key) return t;
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—';
}

function adminBookingsBuildQuery(extra) {
  var f = adminBookingsState.filters;
  var params = new URLSearchParams();
  params.set('client', getClient() || 'sunset');
  params.set('location', getSunsetLocation() || 'sunset-somo');
  if (f.q) params.set('q', f.q);
  if (f.date_from) params.set('date_from', f.date_from);
  if (f.date_to) params.set('date_to', f.date_to);
  if (f.status) params.set('status', f.status);
  if (f.type) params.set('type', f.type);
  if (f.include_archived) params.set('include_archived', '1');
  params.set('limit', String(f.limit || 50));
  params.set('offset', String(f.offset || 0));
  if (extra) {
    Object.keys(extra).forEach(function (k) {
      if (extra[k] != null && extra[k] !== '') params.set(k, String(extra[k]));
    });
  }
  return params.toString();
}

function renderAdminBookingsShell() {
  var body = el('admin-bookings-body');
  if (!body) return;
  body.innerHTML =
    '<div class="portal-admin-bookings" data-admin-bookings="1">' +
      '<div class="portal-admin-bookings-toolbar" role="search">' +
        '<label class="portal-admin-bookings-field portal-admin-bookings-search">' +
          '<span class="portal-admin-bookings-label">' + escHtml(portalT('admin.bookings.search')) + '</span>' +
          '<input type="search" id="admin-bookings-q" class="portal-admin-bookings-input" autocomplete="off" ' +
            'placeholder="' + escHtml(portalT('admin.bookings.searchPlaceholder')) + '" />' +
        '</label>' +
        '<label class="portal-admin-bookings-field">' +
          '<span class="portal-admin-bookings-label">' + escHtml(portalT('admin.bookings.dateFrom')) + '</span>' +
          '<input type="date" id="admin-bookings-date-from" class="portal-admin-bookings-input" />' +
        '</label>' +
        '<label class="portal-admin-bookings-field">' +
          '<span class="portal-admin-bookings-label">' + escHtml(portalT('admin.bookings.dateTo')) + '</span>' +
          '<input type="date" id="admin-bookings-date-to" class="portal-admin-bookings-input" />' +
        '</label>' +
        '<label class="portal-admin-bookings-field">' +
          '<span class="portal-admin-bookings-label">' + escHtml(portalT('admin.bookings.status')) + '</span>' +
          '<select id="admin-bookings-status" class="portal-admin-bookings-input">' +
            '<option value="">' + escHtml(portalT('admin.bookings.statusAll')) + '</option>' +
            '<option value="paid">' + escHtml(portalT('admin.bookings.status.paid')) + '</option>' +
            '<option value="unpaid">' + escHtml(portalT('admin.bookings.status.unpaid')) + '</option>' +
            '<option value="partial">' + escHtml(portalT('admin.bookings.status.partial')) + '</option>' +
            '<option value="refunded">' + escHtml(portalT('admin.bookings.status.refunded')) + '</option>' +
            '<option value="cancelled">' + escHtml(portalT('admin.bookings.status.cancelled')) + '</option>' +
            '<option value="deleted">' + escHtml(portalT('admin.bookings.status.deleted')) + '</option>' +
          '</select>' +
        '</label>' +
        '<label class="portal-admin-bookings-field">' +
          '<span class="portal-admin-bookings-label">' + escHtml(portalT('admin.bookings.type')) + '</span>' +
          '<select id="admin-bookings-type" class="portal-admin-bookings-input">' +
            '<option value="">' + escHtml(portalT('admin.bookings.typeAll')) + '</option>' +
            '<option value="surf_lesson">' + escHtml(portalT('admin.bookings.type.surf_lesson')) + '</option>' +
            '<option value="wetsuit">' + escHtml(portalT('admin.bookings.type.wetsuit')) + '</option>' +
            '<option value="surfboard">' + escHtml(portalT('admin.bookings.type.surfboard')) + '</option>' +
            '<option value="yoga">' + escHtml(portalT('admin.bookings.type.yoga')) + '</option>' +
            '<option value="meal">' + escHtml(portalT('admin.bookings.type.meal')) + '</option>' +
          '</select>' +
        '</label>' +
        '<label class="portal-admin-bookings-check">' +
          '<input type="checkbox" id="admin-bookings-archived" />' +
          '<span>' + escHtml(portalT('admin.bookings.includeArchived')) + '</span>' +
        '</label>' +
        '<div class="portal-admin-bookings-actions">' +
          '<button type="button" class="btn btn-primary" id="admin-bookings-apply">' +
            escHtml(portalT('admin.bookings.applyFilters')) +
          '</button>' +
          '<button type="button" class="btn btn-ghost" id="admin-bookings-export">' +
            escHtml(portalT('admin.bookings.exportCsv')) +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div id="admin-bookings-summary" class="portal-admin-bookings-summary" aria-live="polite"></div>' +
      '<div id="admin-bookings-table-wrap" class="portal-admin-bookings-table-wrap"></div>' +
      '<div id="admin-bookings-msg" class="state-msg" style="display:none" role="status"></div>' +
    '</div>';
  wireAdminBookingsPanel();
  loadAdminBookings();
}

function wireAdminBookingsPanel() {
  var root = el('admin-bookings-body');
  if (!root || root.dataset.bookingsWired === '1') return;
  root.dataset.bookingsWired = '1';

  function readFiltersFromDom() {
    var q = el('admin-bookings-q');
    var df = el('admin-bookings-date-from');
    var dt = el('admin-bookings-date-to');
    var st = el('admin-bookings-status');
    var ty = el('admin-bookings-type');
    var ar = el('admin-bookings-archived');
    adminBookingsState.filters.q = q ? String(q.value || '').trim() : '';
    adminBookingsState.filters.date_from = df ? String(df.value || '') : '';
    adminBookingsState.filters.date_to = dt ? String(dt.value || '') : '';
    adminBookingsState.filters.status = st ? String(st.value || '') : '';
    adminBookingsState.filters.type = ty ? String(ty.value || '') : '';
    adminBookingsState.filters.include_archived = !!(ar && ar.checked);
    adminBookingsState.filters.offset = 0;
  }

  var applyBtn = el('admin-bookings-apply');
  if (applyBtn) {
    applyBtn.addEventListener('click', function () {
      readFiltersFromDom();
      loadAdminBookings();
    });
  }
  var qInput = el('admin-bookings-q');
  if (qInput) {
    var searchTimer = null;
    qInput.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        readFiltersFromDom();
        loadAdminBookings();
      }, 220);
    });
  }
  ['admin-bookings-date-from', 'admin-bookings-date-to', 'admin-bookings-status', 'admin-bookings-type', 'admin-bookings-archived']
    .forEach(function (id) {
      var node = el(id);
      if (!node) return;
      node.addEventListener('change', function () {
        readFiltersFromDom();
        loadAdminBookings();
      });
    });

  var exportBtn = el('admin-bookings-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', function () {
      readFiltersFromDom();
      var url = '/staff/admin/bookings/export.csv?' + adminBookingsBuildQuery();
      window.open(url, '_blank', 'noopener');
    });
  }

  var wrap = el('admin-bookings-table-wrap');
  if (wrap) {
    wrap.addEventListener('click', function (ev) {
      var guestBtn = ev.target && ev.target.closest ? ev.target.closest('[data-bookings-guest-phone]') : null;
      if (guestBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        var phone = guestBtn.getAttribute('data-bookings-guest-phone') || '';
        var openCust = (typeof window !== 'undefined' && typeof window.openCustomerCardForPhone === 'function')
          ? window.openCustomerCardForPhone
          : (typeof openCustomerCardForPhone === 'function' ? openCustomerCardForPhone : null);
        if (phone && openCust) openCust(phone, { from: 'admin-bookings' });
        return;
      }
      var refundBtn = ev.target && ev.target.closest ? ev.target.closest('[data-bookings-record-refund]') : null;
      if (refundBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        var bookingId = refundBtn.getAttribute('data-bookings-record-refund');
        openAdminBookingsRefundForm(bookingId);
        return;
      }
      // Nested interactive controls must not toggle expansion.
      var interactive = ev.target && ev.target.closest
        ? ev.target.closest('button, a, input, select, textarea, label')
        : null;
      var rowBtn = ev.target && ev.target.closest ? ev.target.closest('[data-bookings-row-id]') : null;
      if (interactive && rowBtn && interactive !== rowBtn && rowBtn.contains(interactive)) {
        return;
      }
      if (rowBtn) {
        var id = rowBtn.getAttribute('data-bookings-row-id');
        adminBookingsState.expandedId = adminBookingsState.expandedId === id ? null : id;
        renderAdminBookingsTable();
      }
    });
    wrap.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var target = ev.target;
      if (!target) return;
      // Guest / refund / form controls: activate their own action; never expand the row.
      var guestBtn = target.closest ? target.closest('[data-bookings-guest-phone]') : null;
      if (guestBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        var phoneKey = guestBtn.getAttribute('data-bookings-guest-phone') || '';
        var openCustKey = (typeof window !== 'undefined' && typeof window.openCustomerCardForPhone === 'function')
          ? window.openCustomerCardForPhone
          : (typeof openCustomerCardForPhone === 'function' ? openCustomerCardForPhone : null);
        if (phoneKey && openCustKey) openCustKey(phoneKey, { from: 'admin-bookings' });
        return;
      }
      var refundBtn = target.closest ? target.closest('[data-bookings-record-refund]') : null;
      if (refundBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        openAdminBookingsRefundForm(refundBtn.getAttribute('data-bookings-record-refund'));
        return;
      }
      var nestedInteractive = target.closest
        ? target.closest('button, a, input, select, textarea, label')
        : null;
      var rowBtn = target.closest ? target.closest('[data-bookings-row-id]') : null;
      if (!rowBtn) return;
      if (nestedInteractive && nestedInteractive !== rowBtn && rowBtn.contains(nestedInteractive)) {
        return;
      }
      // Only expand when the row itself (or non-interactive descendant) has focus.
      if (target !== rowBtn && nestedInteractive) return;
      ev.preventDefault();
      var id = rowBtn.getAttribute('data-bookings-row-id');
      adminBookingsState.expandedId = adminBookingsState.expandedId === id ? null : id;
      renderAdminBookingsTable();
    });
  }
}

function setAdminBookingsMsg(text, isError) {
  var msg = el('admin-bookings-msg');
  if (!msg) return;
  if (!text) {
    msg.style.display = 'none';
    msg.textContent = '';
    return;
  }
  msg.style.display = 'block';
  msg.className = 'state-msg' + (isError ? ' error' : '');
  msg.textContent = text;
}

function loadAdminBookings() {
  var wrap = el('admin-bookings-table-wrap');
  var summary = el('admin-bookings-summary');
  if (!wrap) return;
  adminBookingsState.loading = true;
  adminBookingsState.error = null;
  wrap.innerHTML = '<div class="portal-admin-bookings-loading" role="status">' +
    escHtml(portalT('admin.bookings.loading')) + '</div>';
  if (summary) summary.innerHTML = '';
  setAdminBookingsMsg('');

  // Stale-response protection: only the latest generation may paint.
  var gen = (adminBookingsState.loadGeneration = (adminBookingsState.loadGeneration || 0) + 1);
  if (adminBookingsState.loadAbort && typeof adminBookingsState.loadAbort.abort === 'function') {
    try { adminBookingsState.loadAbort.abort(); } catch (_e) { /* ignore */ }
  }
  var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  adminBookingsState.loadAbort = controller;

  var url = '/staff/admin/bookings?' + adminBookingsBuildQuery();
  var fetchOpts = { credentials: 'same-origin' };
  if (controller) fetchOpts.signal = controller.signal;
  fetch(url, fetchOpts)
    .then(function (r) {
      return r.json().then(function (body) {
        return { status: r.status, body: body };
      });
    })
    .then(function (res) {
      if (gen !== adminBookingsState.loadGeneration) return; // stale
      adminBookingsState.loading = false;
      if (!res.body || res.body.success !== true) {
        adminBookingsState.error = (res.body && res.body.error) || 'load failed';
        wrap.innerHTML = '<div class="portal-admin-bookings-error" role="alert">' +
          escHtml(portalT('admin.bookings.loadError')) +
          ' <button type="button" class="btn btn-ghost" id="admin-bookings-retry">' +
          escHtml(portalT('admin.bookings.retry')) + '</button></div>';
        var retry = el('admin-bookings-retry');
        if (retry) retry.addEventListener('click', function () { loadAdminBookings(); });
        return;
      }
      adminBookingsState.data = res.body;
      // Session role is authoritative for write UI; response may hint but must not
      // override a live staffPortalSession.role (viewer vs operator/admin/owner).
      var sess = (typeof staffPortalSession !== 'undefined') ? staffPortalSession : null;
      if (sess && sess.role) adminBookingsState.role = sess.role;
      else if (res.body.role) adminBookingsState.role = res.body.role;
      renderAdminBookingsSummary();
      renderAdminBookingsTable();
    })
    .catch(function (err) {
      if (gen !== adminBookingsState.loadGeneration) return; // stale / aborted
      if (err && (err.name === 'AbortError' || err.code === 20)) return;
      adminBookingsState.loading = false;
      adminBookingsState.error = 'network';
      wrap.innerHTML = '<div class="portal-admin-bookings-error" role="alert">' +
        escHtml(portalT('admin.bookings.loadError')) + '</div>';
    });
}

function renderAdminBookingsSummary() {
  var node = el('admin-bookings-summary');
  if (!node) return;
  var s = (adminBookingsState.data && adminBookingsState.data.summary) || {};
  node.innerHTML =
    '<div class="portal-admin-bookings-summary-strip" role="group" aria-label="' +
      escHtml(portalT('admin.bookings.summaryLabel')) + '">' +
      metric('admin.bookings.metric.bookings', s.bookings_count != null ? String(s.bookings_count) : '0') +
      metric('admin.bookings.metric.collected', adminBookingsFormatEur(s.collected_cents)) +
      metric('admin.bookings.metric.refunded', adminBookingsFormatEur(s.refunded_cents)) +
      metric('admin.bookings.metric.net', adminBookingsFormatEur(s.net_cents)) +
      metric('admin.bookings.metric.outstanding', adminBookingsFormatEur(s.outstanding_cents)) +
    '</div>';

  function metric(labelKey, value) {
    return '<div class="portal-admin-bookings-metric">' +
      '<div class="portal-admin-bookings-metric-label">' + escHtml(portalT(labelKey)) + '</div>' +
      '<div class="portal-admin-bookings-metric-value">' + escHtml(value) + '</div></div>';
  }
}

function renderAdminBookingsTable() {
  var wrap = el('admin-bookings-table-wrap');
  if (!wrap) return;
  var data = adminBookingsState.data;
  var rows = (data && data.rows) || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="portal-admin-bookings-empty">' +
      escHtml(portalT('admin.bookings.empty')) + '</div>';
    return;
  }

  var html = '<div class="portal-admin-bookings-table" role="table" aria-label="' +
    escHtml(portalT('admin.bookings.tableLabel')) + '">';
  html += '<div class="portal-admin-bookings-thead" role="rowgroup">' +
    '<div class="portal-admin-bookings-tr" role="row">' +
      adminBookingsTh('admin.bookings.col.booking') +
      adminBookingsTh('admin.bookings.col.guest') +
      adminBookingsTh('admin.bookings.col.dates') +
      adminBookingsTh('admin.bookings.col.what') +
      adminBookingsTh('admin.bookings.col.total') +
      adminBookingsTh('admin.bookings.col.paid') +
      adminBookingsTh('admin.bookings.col.status') +
    '</div></div><div class="portal-admin-bookings-tbody" role="rowgroup">';

  rows.forEach(function (row) {
    var id = String(row.booking_id || '');
    var expanded = adminBookingsState.expandedId === id;
    var archived = !!row.archived;
    var code = String(row.booking_code || '');
    var created = row.created_at ? String(row.created_at).slice(0, 10) : '';
    var dates = '';
    if (row.service_date_start && row.service_date_end && row.service_date_start !== row.service_date_end) {
      dates = row.service_date_start + ' → ' + row.service_date_end;
    } else {
      dates = row.service_date_start || row.service_date_end || '—';
    }
    html += '<div class="portal-admin-bookings-tr' + (archived ? ' is-archived' : '') +
      (expanded ? ' is-expanded' : '') + '" role="row" data-bookings-row-id="' + escHtml(id) +
      '" tabindex="0" aria-expanded="' + (expanded ? 'true' : 'false') + '">';
    html += '<div class="portal-admin-bookings-td portal-admin-bookings-td-code" role="cell">' +
      '<div class="portal-admin-bookings-code" title="' + escHtml(code) + '">' + escHtml(code) + '</div>' +
      '<div class="portal-admin-bookings-sub">' + escHtml(created) + '</div></div>';
    html += '<div class="portal-admin-bookings-td" role="cell">' +
      '<button type="button" class="portal-admin-bookings-guest-link" data-bookings-guest-phone="' +
      escHtml(String(row.phone || '')) + '">' + escHtml(row.guest_name || '—') + '</button>' +
      '<div class="portal-admin-bookings-sub">' + escHtml(row.phone || '') + '</div></div>';
    html += '<div class="portal-admin-bookings-td" role="cell">' + escHtml(dates) + '</div>';
    html += '<div class="portal-admin-bookings-td" role="cell">' + escHtml(row.what_summary || '—') + '</div>';
    html += '<div class="portal-admin-bookings-td portal-admin-bookings-td-num" role="cell">' +
      escHtml(adminBookingsFormatEur(row.total_cents != null ? row.total_cents : row.charged_cents)) + '</div>';
    html += '<div class="portal-admin-bookings-td portal-admin-bookings-td-num" role="cell">' +
      escHtml(adminBookingsFormatEur(row.paid_cents != null ? row.paid_cents : row.collected_cents)) + '</div>';
    html += '<div class="portal-admin-bookings-td" role="cell">' +
      '<span class="portal-admin-bookings-chip portal-admin-bookings-chip--' + escHtml(String(row.status || 'unpaid')) +
      '">' + escHtml(adminBookingsStatusLabel(row.status)) + '</span></div>';
    html += '</div>';
    if (expanded) {
      html += renderAdminBookingsExpansion(row);
    }
  });

  html += '</div></div>';

  var total = data.total_count != null ? data.total_count : rows.length;
  var offset = (data.filters && data.filters.offset) || 0;
  var limit = (data.filters && data.filters.limit) || 50;
  if (total > limit) {
    html += '<div class="portal-admin-bookings-pager">';
    html += '<button type="button" class="btn btn-ghost" id="admin-bookings-prev" ' +
      (offset <= 0 ? 'disabled' : '') + '>' + escHtml(portalT('admin.bookings.prev')) + '</button>';
    html += '<span class="portal-admin-bookings-pager-meta">' +
      escHtml(String(offset + 1) + '–' + String(Math.min(offset + rows.length, total)) + ' / ' + String(total)) +
      '</span>';
    html += '<button type="button" class="btn btn-ghost" id="admin-bookings-next" ' +
      (offset + rows.length >= total ? 'disabled' : '') + '>' + escHtml(portalT('admin.bookings.next')) + '</button>';
    html += '</div>';
  }

  wrap.innerHTML = html;

  var prev = el('admin-bookings-prev');
  var next = el('admin-bookings-next');
  if (prev) {
    prev.addEventListener('click', function () {
      adminBookingsState.filters.offset = Math.max(0, offset - limit);
      loadAdminBookings();
    });
  }
  if (next) {
    next.addEventListener('click', function () {
      adminBookingsState.filters.offset = offset + limit;
      loadAdminBookings();
    });
  }
}

function adminBookingsTh(key) {
  return '<div class="portal-admin-bookings-th" role="columnheader">' + escHtml(portalT(key)) + '</div>';
}

function renderAdminBookingsExpansion(row) {
  var story = row.payment_story || {};
  var items = row.items || [];
  var itemsHtml = items.length
    ? items.map(function (it) {
      return '<li><span>' + escHtml(it.label || it.service_type || '—') +
        (it.service_date ? ' · ' + escHtml(String(it.service_date).slice(0, 10)) : '') +
        '</span><span>' + escHtml(adminBookingsFormatEur(it.amount_due_cents)) + '</span></li>';
    }).join('')
    : '<li class="portal-admin-bookings-muted">' + escHtml(portalT('admin.bookings.noItems')) + '</li>';

  var waiver = row.waiver;
  var waiverText = waiver && waiver.status
    ? String(waiver.status) + (waiver.request_mode ? ' (' + waiver.request_mode + ')' : '')
    : portalT('admin.bookings.waiverUnknown');

  var refunds = row.refunds || [];
  var refundsHtml = refunds.length
    ? refunds.map(function (rf) {
      return '<li>' + escHtml(adminBookingsFormatEur(rf.amount_cents)) +
        ' · ' + escHtml(rf.effective_date || '') +
        ' · ' + escHtml(rf.reason || '') +
        ' <span class="portal-admin-bookings-muted">(' + escHtml(portalT('admin.bookings.manualRecord')) + ')</span></li>';
    }).join('')
    : '<li class="portal-admin-bookings-muted">' + escHtml(portalT('admin.bookings.noRefunds')) + '</li>';

  var canRefund = adminBookingsCanWriteRefund();
  var refundAction = canRefund
    ? '<button type="button" class="btn btn-primary btn-compact" data-bookings-record-refund="' +
      escHtml(String(row.booking_id || '')) + '">' + escHtml(portalT('admin.bookings.recordRefund')) + '</button>' +
      '<p class="portal-admin-bookings-muted portal-admin-bookings-refund-note">' +
      escHtml(portalT('admin.bookings.recordRefundNote')) + '</p>'
    : '<p class="portal-admin-bookings-muted">' + escHtml(portalT('admin.bookings.recordRefundViewer')) + '</p>';

  return '<div class="portal-admin-bookings-expand" role="region" data-bookings-expand="' +
    escHtml(String(row.booking_id || '')) + '">' +
    '<div class="portal-admin-bookings-expand-grid">' +
      '<section><h4>' + escHtml(portalT('admin.bookings.items')) + '</h4><ul class="portal-admin-bookings-kv">' + itemsHtml + '</ul></section>' +
      '<section><h4>' + escHtml(portalT('admin.bookings.paymentStory')) + '</h4>' +
        '<ul class="portal-admin-bookings-kv">' +
          '<li><span>' + escHtml(portalT('admin.bookings.charged')) + '</span><span>' + escHtml(adminBookingsFormatEur(story.charged_cents)) + '</span></li>' +
          '<li><span>' + escHtml(portalT('admin.bookings.collected')) + '</span><span>' + escHtml(adminBookingsFormatEur(story.collected_cents)) + '</span></li>' +
          '<li><span>' + escHtml(portalT('admin.bookings.refunded')) + '</span><span>' + escHtml(adminBookingsFormatEur(story.refunded_cents)) + '</span></li>' +
          '<li><span>' + escHtml(portalT('admin.bookings.net')) + '</span><span>' + escHtml(adminBookingsFormatEur(story.net_cents)) + '</span></li>' +
        '</ul>' +
        '<h4>' + escHtml(portalT('admin.bookings.refunds')) + '</h4><ul class="portal-admin-bookings-list">' + refundsHtml + '</ul>' +
        '<div class="portal-admin-bookings-refund-action" id="admin-bookings-refund-action-' + escHtml(String(row.booking_id || '')) + '">' +
          refundAction +
        '</div>' +
      '</section>' +
      '<section><h4>' + escHtml(portalT('admin.bookings.guestMeta')) + '</h4>' +
        '<ul class="portal-admin-bookings-kv">' +
          '<li><span>' + escHtml(portalT('admin.bookings.guest')) + '</span><span>' + escHtml((row.guest && row.guest.name) || row.guest_name || '—') + '</span></li>' +
          '<li><span>' + escHtml(portalT('admin.bookings.phone')) + '</span><span>' + escHtml((row.guest && row.guest.phone) || row.phone || '—') + '</span></li>' +
          '<li><span>' + escHtml(portalT('admin.bookings.waiver')) + '</span><span>' + escHtml(waiverText) + '</span></li>' +
          '<li><span>' + escHtml(portalT('admin.bookings.createdBy')) + '</span><span>' + escHtml(row.created_by || '—') + '</span></li>' +
        '</ul></section>' +
    '</div></div>';
}

function openAdminBookingsRefundForm(bookingId) {
  var host = el('admin-bookings-refund-action-' + bookingId);
  if (!host) return;
  if (!adminBookingsCanWriteRefund()) {
    setAdminBookingsMsg(portalT('admin.bookings.recordRefundViewer'), true);
    return;
  }
  // New form open: reset single-flight key for this booking action.
  if (adminBookingsState.refundBookingId !== bookingId || !adminBookingsState.refundIdempotencyKey) {
    adminBookingsState.refundBookingId = bookingId;
    adminBookingsState.refundIdempotencyKey = 'ui-' + bookingId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    adminBookingsState.refundInFlight = false;
  }
  var today = new Date().toISOString().slice(0, 10);
  host.innerHTML =
    '<form class="portal-admin-bookings-refund-form" data-bookings-refund-form="' + escHtml(bookingId) + '">' +
      '<p class="portal-admin-bookings-refund-note">' + escHtml(portalT('admin.bookings.recordRefundNote')) + '</p>' +
      '<label><span>' + escHtml(portalT('admin.bookings.refundAmount')) + '</span>' +
        '<input type="number" min="0.01" step="0.01" name="amount_eur" required class="portal-admin-bookings-input" /></label>' +
      '<label><span>' + escHtml(portalT('admin.bookings.refundDate')) + '</span>' +
        '<input type="date" name="effective_date" required value="' + escHtml(today) + '" class="portal-admin-bookings-input" /></label>' +
      '<label><span>' + escHtml(portalT('admin.bookings.refundReason')) + '</span>' +
        '<input type="text" name="reason" required maxlength="500" class="portal-admin-bookings-input" /></label>' +
      '<div class="portal-admin-bookings-refund-form-actions">' +
        '<button type="submit" class="btn btn-primary btn-compact" data-bookings-refund-submit="1">' +
          escHtml(portalT('admin.bookings.recordRefund')) + '</button>' +
        '<button type="button" class="btn btn-ghost btn-compact" data-bookings-refund-cancel="' + escHtml(bookingId) + '">' +
          escHtml(portalT('admin.bookings.cancel')) + '</button>' +
      '</div>' +
      '<p class="portal-admin-bookings-muted">' + escHtml(portalT('admin.bookings.recordRefundNote')) + '</p>' +
    '</form>';

  var form = host.querySelector('form');
  var cancel = host.querySelector('[data-bookings-refund-cancel]');
  if (cancel) {
    cancel.addEventListener('click', function () {
      if (adminBookingsState.refundInFlight) return;
      adminBookingsState.refundIdempotencyKey = null;
      adminBookingsState.refundBookingId = null;
      adminBookingsState.expandedId = bookingId;
      renderAdminBookingsTable();
    });
  }
  if (form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (adminBookingsState.refundInFlight) return;
      var fd = new FormData(form);
      var amountEur = Number(fd.get('amount_eur'));
      if (!Number.isFinite(amountEur) || amountEur <= 0) {
        setAdminBookingsMsg(portalT('admin.bookings.refundAmountInvalid'), true);
        return;
      }
      var amountCents = Math.round(amountEur * 100);
      if (!adminBookingsState.refundIdempotencyKey || adminBookingsState.refundBookingId !== bookingId) {
        adminBookingsState.refundBookingId = bookingId;
        adminBookingsState.refundIdempotencyKey = 'ui-' + bookingId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      }
      var payload = {
        amount_cents: amountCents,
        effective_date: String(fd.get('effective_date') || ''),
        reason: String(fd.get('reason') || '').trim(),
        idempotency_key: adminBookingsState.refundIdempotencyKey,
        location_id: getSunsetLocation() || 'sunset-somo',
      };
      var url = '/staff/admin/bookings/' + encodeURIComponent(bookingId) + '/refunds?client=' +
        encodeURIComponent(getClient() || 'sunset') + '&location=' + encodeURIComponent(getSunsetLocation() || 'sunset-somo');
      adminBookingsState.refundInFlight = true;
      var submitBtn = form.querySelector('[data-bookings-refund-submit]');
      var inputs = form.querySelectorAll('input, button');
      for (var i = 0; i < inputs.length; i++) {
        if (inputs[i].getAttribute('data-bookings-refund-cancel') != null) continue;
        inputs[i].disabled = true;
      }
      if (submitBtn) submitBtn.disabled = true;
      setAdminBookingsMsg(portalT('admin.bookings.recordingRefund'), false);
      fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
        .then(function (res) {
          if (!res.body || res.body.success !== true) {
            adminBookingsState.refundInFlight = false;
            for (var j = 0; j < inputs.length; j++) inputs[j].disabled = false;
            if (submitBtn) submitBtn.disabled = false;
            setAdminBookingsMsg((res.body && (res.body.message || res.body.error)) || portalT('admin.bookings.refundFailed'), true);
            // Keep same idempotency key for retry of this user action.
            return;
          }
          // Authoritative success — clear key and rotate only after success.
          adminBookingsState.refundInFlight = false;
          adminBookingsState.refundIdempotencyKey = null;
          adminBookingsState.refundBookingId = null;
          setAdminBookingsMsg(portalT('admin.bookings.refundRecorded'), false);
          loadAdminBookings();
        })
        .catch(function () {
          adminBookingsState.refundInFlight = false;
          for (var k = 0; k < inputs.length; k++) inputs[k].disabled = false;
          if (submitBtn) submitBtn.disabled = false;
          setAdminBookingsMsg(portalT('admin.bookings.refundFailed'), true);
        });
    });
  }
}

// Expose production owners for adminSelectSubTab / loadAdminTab / generated-UI gates.
if (typeof window !== 'undefined') {
  window.renderAdminBookingsShell = renderAdminBookingsShell;
  window.loadAdminBookings = loadAdminBookings;
  window.renderAdminBookingsTable = renderAdminBookingsTable;
  window.renderAdminBookingsSummary = renderAdminBookingsSummary;
  window.adminBookingsCanWriteRefund = adminBookingsCanWriteRefund;
  window.adminBookingsState = adminBookingsState;
  window.openAdminBookingsRefundForm = openAdminBookingsRefundForm;
}
