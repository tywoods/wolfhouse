/**
 * Sunset Admin Bookings tab (N1) — list, filters, expansion, manual refund UI.
 * Injected with sunset-admin-ui.js. Uses portal globals: el, portalT, escHtml,
 * getClient, getSunsetLocation, fetch, switchToTab.
 * Money display only — all arithmetic is server-authoritative.
 * Guest name opens an in-place peek on Reservas — never switchToTab/Customers/Inbox.
 */
/* global el, portalT, escHtml, getClient, getSunsetLocation,
   openBookingInSchedule, switchToTab, scheduleOpenDayDetail, schedulePrimeOpenDay, openScheduleDetailDrawer,
   adminBookingsState, fetch, getStaffLocale, portalLang */

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
    sort: '',
    dir: '',
  },
  role: null,
  /** Monotonic generation for stale-response suppression across filter/page/location loads. */
  loadGeneration: 0,
  loadAbort: null,
  /** Single-flight refund: one in-flight POST + stable idempotency key per user action. */
  refundInFlight: false,
  refundIdempotencyKey: null,
  refundBookingId: null,
  /** In-place guest peek on Reservas (never navigates to Inbox/Customers). */
  guestPeek: null,
  guestPeekGen: 0,
};

/** Resolve Open-in-Schedule chrome; never expose a raw i18n key (EN + ES). */
function adminBookingsOpenScheduleLabel(code) {
  var KEY = 'admin.bookings.openInSchedule';
  var loc = 'en';
  try {
    if (typeof getStaffLocale === 'function') loc = String(getStaffLocale() || 'en');
    else if (typeof portalLang === 'string' && portalLang) loc = String(portalLang);
  } catch (_l) { loc = 'en'; }
  loc = String(loc || 'en').toLowerCase();
  var fallback = loc.indexOf('es') === 0 ? 'Abrir en Agenda' : 'Open in Schedule';
  function isRawKey(s) {
    var text = String(s || '').trim();
    if (!text) return true;
    if (text === KEY || text.indexOf(KEY) === 0) return true;
    // portalT / window.t miss → return the key path (no spaces).
    if (text.indexOf('admin.bookings.') === 0 && text.indexOf(' ') < 0) return true;
    return false;
  }
  var label = '';
  try {
    if (typeof portalT === 'function') label = String(portalT(KEY) || '');
  } catch (_p) { label = ''; }
  if (isRawKey(label)) {
    try {
      if (typeof window !== 'undefined' && typeof window.t === 'function') {
        label = String(window.t(KEY) || '');
      }
    } catch (_t) { label = ''; }
  }
  if (isRawKey(label)) label = fallback;
  var trimmed = String(code || '').trim();
  return trimmed ? (label + ': ' + trimmed) : label;
}

/** First-click sort direction per column (server defaults). */
var ADMIN_BOOKINGS_SORT_FIRST_DIR = {
  booking: 'desc',
  guest: 'desc',
  created: 'desc',
  type: 'asc',
  total: 'desc',
  paid: 'desc',
  status: 'asc',
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
  if (!isFinite(n)) n = 0;
  return '€' + (n / 100).toFixed(2);
}

/**
 * Stable per-render row key for expand state. The list index is always included,
 * so duplicate IDs/codes and namespace-like values still expand independently.
 */
function adminBookingsRowKey(row, index) {
  var rowIndex = String(index != null ? index : 0);
  var id = String((row && row.booking_id) || '').trim();
  if (id) return 'row:' + rowIndex + ':id:' + id;
  var code = String((row && row.booking_code) || '').trim();
  if (code) return 'row:' + rowIndex + ':code:' + code;
  return 'row:' + rowIndex + ':anonymous';
}

/** Locale display date for Partidas — shared portal formatters; never raw ISO. */
function adminBookingsFormatItemDate(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  var m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  var iso = m ? m[1] : '';
  if (!iso) return '';
  if (typeof scheduleFormatDrawerDateDisplay === 'function') {
    var viaDrawer = scheduleFormatDrawerDateDisplay(iso);
    if (viaDrawer && viaDrawer !== '—') return viaDrawer;
  }
  try {
    var d = null;
    if (typeof scheduleParseIso === 'function') d = scheduleParseIso(iso);
    else {
      var p = iso.split('-').map(Number);
      d = new Date(p[0], p[1] - 1, p[2]);
    }
    if (d && !isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
  } catch (_e) { /* ignore */ }
  return iso;
}

/**
 * Clean booking-item label for Reservas expand.
 * Staff API remains money authority — this only scrub display junk (ISO ranges,
 * JSON payment blobs, snake_case service keys). Never invents amounts.
 */
function adminBookingsCleanItemLabel(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  // Payment / ledger junk dumped as a label.
  if (s.charAt(0) === '{' || s.charAt(0) === '[') return '';
  if (/^(pi_|cs_|price_|txn_|ch_|py_)/i.test(s)) return '';
  // Strip ISO stay ranges embedded in accommodation-style labels.
  s = s.replace(
    /\s*·\s*\d{4}-\d{2}-\d{2}(?:T[\d.:]+Z?)?\s*(?:→|->|–|—|-)\s*\d{4}-\d{2}-\d{2}(?:T[\d.:]+Z?)?/g,
    ''
  );
  // Strip any leftover full ISO timestamps.
  s = s.replace(/\d{4}-\d{2}-\d{2}T[\d.:]+Z?/g, '');
  s = s.replace(/\s*·\s*·\s*/g, ' · ').replace(/\s{2,}/g, ' ').replace(/^·\s*|\s*·$/g, '').trim();
  if (!s) return '';
  // Humanize snake_case service_type fallbacks (board_and_suit_rental → Board and suit rental).
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(s)) {
    var parts = s.split('_');
    s = parts.map(function (w, i) {
      if (!w) return '';
      if (i === 0) return w.charAt(0).toUpperCase() + w.slice(1);
      return w;
    }).join(' ');
  }
  return s;
}

/** True when an expand item looks like payment/ledger junk rather than a booking line. */
function adminBookingsIsJunkExpandItem(it) {
  if (!it || typeof it !== 'object') return true;
  var st = String(it.service_type || '').toLowerCase();
  if (/^(payment|stripe|ledger|fee|surcharge)(_|$)/.test(st)) return true;
  if (st.indexOf('payment_') === 0 || st.indexOf('stripe_') === 0) return true;
  var labelRaw = String(it.label || '').trim();
  if (labelRaw && (labelRaw.charAt(0) === '{' || labelRaw.charAt(0) === '[')) return true;
  return false;
}

/** Booking created_at → YYYY-MM-DD HH:MM in Europe/Madrid. */
function adminBookingsFormatMadridCreated(iso) {
  if (iso == null || iso === '') return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) {
    var s = String(iso);
    return s.length >= 16 ? s.slice(0, 16).replace('T', ' ') : s;
  }
  try {
    var parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Madrid',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    var map = {};
    parts.forEach(function (p) { if (p.type !== 'literal') map[p.type] = p.value; });
    return map.year + '-' + map.month + '-' + map.day + ' ' + map.hour + ':' + map.minute;
  } catch (e) {
    return String(iso).slice(0, 16).replace('T', ' ');
  }
}

function adminBookingsStatusLabel(status) {
  var s = String(status || '').toLowerCase();
  // Deleted is not a booking status — leave unknown labels to fallback.
  if (s === 'canceled') s = 'cancelled';
  var key = 'admin.bookings.status.' + s;
  var translated = portalT(key);
  if (translated && translated !== key) return translated;
  var fallback = {
    paid: 'Paid', unpaid: 'Unpaid', partial: 'Partial', refunded: 'Refunded',
    cancelled: 'Cancelled', hidden: 'Hidden', refund_needed: 'Refund needed',
  };
  if (fallback[s]) return fallback[s];
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—';
}

function adminBookingsStatusChipsHtml(row) {
  var tags = Array.isArray(row && row.status_tags) && row.status_tags.length
    ? row.status_tags.slice()
    : [row && row.status ? row.status : 'unpaid'];
  // Derive tags from flags when API omits status_tags (compat).
  if (row && (row.hidden === true || row.archived === true) && tags.indexOf('hidden') < 0) tags.push('hidden');
  if (row && row.needs_refund === true && tags.indexOf('refund_needed') < 0) tags.push('refund_needed');
  tags = tags.filter(function (tag) {
    var s = String(tag || '').toLowerCase();
    return s && s !== 'deleted';
  }).map(function (tag) {
    var s = String(tag || '').toLowerCase();
    return s === 'canceled' ? 'cancelled' : s;
  });
  if (!tags.length) tags = ['unpaid'];
  return tags.map(function (s) {
    return '<span class="portal-admin-bookings-chip portal-admin-bookings-chip--' + escHtml(s) + '">' +
      escHtml(adminBookingsStatusLabel(s)) + '</span>';
  }).join(' ');
}

function adminBookingsIsLodging() {
  var slug = '';
  try {
    if (typeof getClient === 'function') slug = String(getClient() || '').trim();
  } catch (_g) { slug = ''; }
  if (!slug) {
    try {
      slug = String((typeof window !== 'undefined' && window.PORTAL_DEFAULT_CLIENT) || '').trim();
    } catch (_p) { slug = ''; }
  }
  if (slug === 'wolfhouse-somo') return true;
  try {
    if (typeof portalIsLodgingAdmin === 'function') return !!portalIsLodgingAdmin(slug || undefined);
  } catch (_e) { /* fall through */ }
  return false;
}

function adminBookingsBuildQuery(extra) {
  var f = adminBookingsState.filters;
  var params = new URLSearchParams();
  var client = '';
  try { client = String(getClient() || '').trim(); } catch (_c) { client = ''; }
  var defaultClient = '';
  try { defaultClient = String((typeof window !== 'undefined' && window.PORTAL_DEFAULT_CLIENT) || '').trim(); } catch (_d) { defaultClient = ''; }
  if (!client) client = defaultClient;
  var lodging = client === 'wolfhouse-somo' || defaultClient === 'wolfhouse-somo' || adminBookingsIsLodging();
  params.set('client', lodging ? 'wolfhouse-somo' : (client || 'sunset'));
  if (!lodging) {
    params.set('location', getSunsetLocation() || 'sunset-somo');
  }
  if (f.q) params.set('q', f.q);
  if (f.date_from) params.set('date_from', f.date_from);
  if (f.date_to) params.set('date_to', f.date_to);
  if (f.status) params.set('status', f.status);
  if (f.type) params.set('type', f.type);
  // Hidden filter needs show_hidden. Cancelled stays in the default list.
  var stLower = String(f.status || '').toLowerCase();
  var needHidden = !!f.include_archived || stLower === 'hidden';
  // status=deleted is not a product path — do not map to Hidden.
  if (needHidden) { params.set('include_archived', '1'); params.set('show_hidden', '1'); }
  params.set('limit', String(f.limit || 50));
  params.set('offset', String(f.offset || 0));
  if (f.sort) {
    params.set('sort', String(f.sort));
    params.set('dir', String(f.dir || ADMIN_BOOKINGS_SORT_FIRST_DIR[f.sort] || 'asc'));
  }
  if (extra) {
    Object.keys(extra).forEach(function (k) {
      if (extra[k] != null && extra[k] !== '') params.set(k, String(extra[k]));
    });
  }
  return params.toString();
}

function renderAdminBookingsShell(opts) {
  opts = opts || {};
  var body = el('admin-bookings-body');
  if (!body) return;
  // Remount replaces toolbar nodes; allow wireAdminBookingsPanel to rebind.
  if (body.dataset) delete body.dataset.bookingsWired;
  body.innerHTML =
    '<div class="portal-admin-bookings" data-admin-bookings="1">' +
      '<div id="admin-bookings-summary" class="portal-admin-bookings-summary" aria-live="polite"></div>' +
      '<div class="portal-admin-bookings-toolbar" role="search">' +
        '<label class="portal-admin-bookings-field portal-admin-bookings-search">' +
          '<span class="portal-admin-bookings-label">' + escHtml(portalT('admin.bookings.search')) + '</span>' +
          '<input type="search" id="admin-bookings-q" class="portal-admin-bookings-input" autocomplete="off" ' +
            'placeholder="' + escHtml(portalT('admin.bookings.searchPlaceholder')) + '" />' +
        '</label>' +
        '<div class="portal-admin-bookings-field portal-admin-bookings-date-range" id="admin-bookings-date-range">' +
          '<span class="portal-admin-bookings-label" id="admin-bookings-date-range-label">' +
            escHtml(portalT('admin.bookings.dateRange') || portalT('admin.bookings.dateFrom') || 'Dates') + '</span>' +
          '<button type="button" id="admin-bookings-date-range-trigger" class="portal-admin-bookings-date-range-trigger" ' +
            'aria-haspopup="dialog" aria-expanded="false" aria-controls="admin-bookings-date-range-popover">' +
            '<span id="admin-bookings-date-range-display" class="portal-admin-bookings-date-range-display">' +
              escHtml(portalT('admin.bookings.dateRangeAll') || 'All dates') + '</span>' +
          '</button>' +
          '<input type="hidden" id="admin-bookings-date-from" value="" />' +
          '<input type="hidden" id="admin-bookings-date-to" value="" />' +
          '<div id="admin-bookings-date-range-popover" class="portal-admin-bookings-date-range-popover" role="dialog" ' +
            'aria-modal="false" aria-labelledby="admin-bookings-date-range-label" hidden style="display:none">' +
            '<div class="portal-admin-bookings-date-range-nav">' +
              '<button type="button" id="admin-bookings-date-range-prev" aria-label="Previous month">&#8249;</button>' +
              '<span id="admin-bookings-date-range-month-label" class="portal-admin-bookings-date-range-month" aria-live="polite"></span>' +
              '<button type="button" id="admin-bookings-date-range-next" aria-label="Next month">&#8250;</button>' +
            '</div>' +
            '<div id="admin-bookings-date-range-grid" class="portal-admin-bookings-date-range-grid" role="group" ' +
              'aria-labelledby="admin-bookings-date-range-month-label"></div>' +
            '<div class="portal-admin-bookings-date-range-actions">' +
              '<button type="button" class="btn btn-ghost btn-compact" id="admin-bookings-date-range-clear">' +
                escHtml(portalT('admin.bookings.dateRangeClear') || 'Clear') + '</button>' +
              '<button type="button" class="btn btn-ghost btn-compact" id="admin-bookings-date-range-cancel">' +
                escHtml(portalT('admin.bookings.dateRangeCancel') || 'Cancel') + '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<label class="portal-admin-bookings-field">' +
          '<span class="portal-admin-bookings-label">' + escHtml(portalT('admin.bookings.status')) + '</span>' +
          '<select id="admin-bookings-status" class="portal-admin-bookings-input">' +
            '<option value="">' + escHtml(portalT('admin.bookings.statusAll')) + '</option>' +
            '<option value="paid">' + escHtml(portalT('admin.bookings.status.paid')) + '</option>' +
            '<option value="unpaid">' + escHtml(portalT('admin.bookings.status.unpaid')) + '</option>' +
            '<option value="partial">' + escHtml(portalT('admin.bookings.status.partial')) + '</option>' +
            '<option value="refunded">' + escHtml(portalT('admin.bookings.status.refunded')) + '</option>' +
            '<option value="cancelled">' + escHtml(portalT('admin.bookings.status.cancelled') || 'Cancelled') + '</option>' +
            '<option value="hidden">' + escHtml(portalT('admin.bookings.status.hidden') || 'Hidden') + '</option>' +
          '</select>' +
        '</label>' +
        '<label class="portal-admin-bookings-field">' +
          '<span class="portal-admin-bookings-label">' + escHtml(portalT('admin.bookings.type')) + '</span>' +
          '<select id="admin-bookings-type" class="portal-admin-bookings-input">' +
            '<option value="">' + escHtml(portalT('admin.bookings.typeAll')) + '</option>' +
            '<option value="lessons">' + escHtml(portalT('admin.bookings.type.lessons') || 'Lessons') + '</option>' +
            '<option value="rentals">' + escHtml(portalT('admin.bookings.type.rentals') || 'Rentals') + '</option>' +
            '<option value="accommodation">' + escHtml(portalT('admin.bookings.type.accommodation') || 'Accommodation') + '</option>' +
          '</select>' +
        '</label>' +
        '<div class="portal-admin-bookings-actions">' +
          '<button type="button" class="btn btn-ghost" id="admin-bookings-export">' +
            escHtml(portalT('admin.bookings.exportCsv')) +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div id="admin-bookings-table-wrap" class="portal-admin-bookings-table-wrap"></div>' +
      '<div id="admin-bookings-msg" class="state-msg" style="display:none" role="status"></div>' +
    '</div>';
  // Shell markup resets hidden date inputs to "". Restore state into the new
  // nodes BEFORE wiring so the date-range display and any early reads honor
  // the active range (search ∩ dates). Lodging may hide Type after restore.
  adminBookingsRestoreFiltersToDom();
  wireAdminBookingsPanel();
  if (adminBookingsIsLodging()) {
    var typeSel = el('admin-bookings-type');
    var typeWrap = typeSel && typeSel.closest ? typeSel.closest('.portal-admin-bookings-field') : null;
    if (typeWrap) typeWrap.style.display = 'none';
  }
  if (opts && opts.skipLoad && adminBookingsState.data) {
    renderAdminBookingsSummary();
    renderAdminBookingsTable();
    return;
  }
  loadAdminBookings();
}

function adminBookingsRestoreFiltersToDom() {
  var f = adminBookingsState.filters || {};
  var q = el('admin-bookings-q');
  var df = el('admin-bookings-date-from');
  var dt = el('admin-bookings-date-to');
  var st = el('admin-bookings-status');
  var ty = el('admin-bookings-type');
  if (q) q.value = f.q || '';
  if (df) {
    df.value = f.date_from || '';
    if (f.date_from) df.removeAttribute('data-range-cleared');
  }
  if (dt) {
    dt.value = f.date_to || '';
    if (f.date_to) dt.removeAttribute('data-range-cleared');
  }
  if (st) st.value = f.status || '';
  if (ty) ty.value = f.type || '';
  if (typeof adminBookingsSyncDateRangeDisplay === 'function') adminBookingsSyncDateRangeDisplay();
}

/**
 * Sync toolbar controls → adminBookingsState.filters.
 * Contract: text search must intersect the active date range. Empty hidden
 * date inputs (e.g. after a shell remount) must NOT clear an already-applied
 * range — only an explicit Clear (data-range-cleared) may widen to all dates.
 * When keeping state dates, self-heal the wiped inputs so display/open/search
 * all agree on the same range (no client-only vs query split).
 */
function adminBookingsReadFiltersFromDom() {
  var q = el('admin-bookings-q');
  var df = el('admin-bookings-date-from');
  var dt = el('admin-bookings-date-to');
  var st = el('admin-bookings-status');
  var ty = el('admin-bookings-type');
  var f = adminBookingsState.filters;
  f.q = q ? String(q.value || '').trim() : '';
  var fromVal = df ? String(df.value || '').trim() : '';
  var toVal = dt ? String(dt.value || '').trim() : '';
  var clearedFrom = !!(df && df.getAttribute && df.getAttribute('data-range-cleared') === '1');
  var clearedTo = !!(dt && dt.getAttribute && dt.getAttribute('data-range-cleared') === '1');
  if (fromVal) {
    f.date_from = fromVal;
  } else if (clearedFrom) {
    f.date_from = '';
  } else if (f.date_from && df) {
    // Keep active range + heal remounted empty input (search ∩ dates).
    df.value = f.date_from;
    df.removeAttribute('data-range-cleared');
  }
  if (toVal) {
    f.date_to = toVal;
  } else if (clearedTo) {
    f.date_to = '';
  } else if (f.date_to && dt) {
    dt.value = f.date_to;
    dt.removeAttribute('data-range-cleared');
  } else if (!f.date_to && (fromVal || f.date_from)) {
    f.date_to = fromVal || f.date_from;
    if (dt && f.date_to) {
      dt.value = f.date_to;
      dt.removeAttribute('data-range-cleared');
    }
  }
  f.status = st ? String(st.value || '') : '';
  f.type = ty ? String(ty.value || '') : '';
  // Archived checkbox removed — hidden filter uses show_hidden only.
  f.include_archived = false;
  f.offset = 0;
  if (typeof adminBookingsSyncDateRangeDisplay === 'function') adminBookingsSyncDateRangeDisplay();
}

function adminBookingsRefreshOnLocaleChange() {
  try {
    if (typeof getStaffLocale === 'function') portalLang = getStaffLocale();
  } catch (_e) { /* ignore */ }
  var tab = (typeof el === 'function') ? el('tab-bookings') : null;
  if (tab && typeof applyStaffPortalI18n === 'function') applyStaffPortalI18n(tab);
  var body = (typeof el === 'function') ? el('admin-bookings-body') : null;
  if (!body || !body.querySelector || !body.querySelector('[data-admin-bookings="1"]')) return;
  if (body.dataset) delete body.dataset.bookingsWired;
  renderAdminBookingsShell({ skipLoad: true });
  if (adminBookingsState.guestPeek) adminBookingsRenderGuestPeek();
}

function adminBookingsGuestPeekT(key, fallback) {
  var label = '';
  try { label = String((typeof portalT === 'function' && portalT(key)) || ''); } catch (_e) { label = ''; }
  if (!label || label.indexOf('admin.bookings.') === 0 || label.indexOf('customers.') === 0) {
    return fallback || key;
  }
  return label;
}

function adminBookingsFindRowById(rowKey) {
  var needle = String(rowKey || '');
  var rows = (adminBookingsState.data && adminBookingsState.data.rows) || [];
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    if (adminBookingsRowKey(row, i) === needle) return row;
  }
  // Backward-compatible domain-ID lookup for callers that do not have a row key.
  for (var j = 0; j < rows.length; j += 1) {
    if (String(rows[j].booking_id || '') === needle) return rows[j];
  }
  return null;
}

function adminBookingsRowKeyForBookingId(bookingId) {
  var id = String(bookingId || '').trim();
  if (!id) return '';
  var rows = (adminBookingsState.data && adminBookingsState.data.rows) || [];
  for (var i = 0; i < rows.length; i += 1) {
    if (String(rows[i].booking_id || '') === id) return adminBookingsRowKey(rows[i], i);
  }
  return id;
}

function adminBookingsCloseGuestPeek() {
  adminBookingsState.guestPeek = null;
  adminBookingsState.guestPeekGen = (adminBookingsState.guestPeekGen || 0) + 1;
  var existing = document.querySelector('[data-bookings-guest-peek="1"]');
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
}

/**
 * Open guest facts in a Reservas-local side panel.
 * Never calls openCustomerCardForPhone / switchToTab — stays on Bookings.
 */
function adminBookingsOpenGuestPeek(phone, bookingId) {
  var row = adminBookingsFindRowById(bookingId);
  var phoneNorm = String(phone || (row && row.phone) || '').trim();
  adminBookingsState.guestPeek = {
    phone: phoneNorm,
    bookingId: String(bookingId || (row && row.booking_id) || ''),
    row: row,
    context: null,
    loading: !!phoneNorm,
    error: null,
  };
  adminBookingsRenderGuestPeek();
  if (!phoneNorm) {
    adminBookingsState.guestPeek.loading = false;
    adminBookingsRenderGuestPeek();
    return;
  }
  var gen = (adminBookingsState.guestPeekGen = (adminBookingsState.guestPeekGen || 0) + 1);
  var url = '/staff/customers/' + encodeURIComponent(phoneNorm) + '/context?client=' +
    encodeURIComponent(getClient() || 'sunset') +
    (getClient() === 'sunset' ? ('&location=' + encodeURIComponent(getSunsetLocation() || 'sunset-somo')) : '');
  fetch(url, { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function (data) {
      if (gen !== adminBookingsState.guestPeekGen || !adminBookingsState.guestPeek) return;
      adminBookingsState.guestPeek.context = data;
      adminBookingsState.guestPeek.loading = false;
      adminBookingsState.guestPeek.error = null;
      adminBookingsRenderGuestPeek();
    })
    .catch(function () {
      if (gen !== adminBookingsState.guestPeekGen || !adminBookingsState.guestPeek) return;
      adminBookingsState.guestPeek.loading = false;
      adminBookingsState.guestPeek.error = adminBookingsGuestPeekT(
        'admin.bookings.guestPeek.error',
        'Could not load guest profile. Showing booking details only.'
      );
      adminBookingsRenderGuestPeek();
    });
}

function adminBookingsGuestPeekHost() {
  var body = el('admin-bookings-body') || el('tab-bookings');
  return body || document.body;
}

function adminBookingsRenderGuestPeek() {
  var peek = adminBookingsState.guestPeek;
  var host = adminBookingsGuestPeekHost();
  if (!host) return;
  var existing = host.querySelector
    ? host.querySelector('[data-bookings-guest-peek="1"]')
    : document.querySelector('[data-bookings-guest-peek="1"]');
  if (!peek) {
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    return;
  }
  var row = peek.row || adminBookingsFindRowById(peek.bookingId) || {};
  var identity = (peek.context && peek.context.identity) || {};
  var name = identity.display_name || (row.guest && row.guest.name) || row.guest_name || '—';
  var phone = identity.phone || peek.phone || row.phone || (row.guest && row.guest.phone) || '—';
  var email = identity.email || (row.guest && row.guest.email) || row.email || '';
  var waiver = row.waiver;
  var waiverText = waiver && waiver.status
    ? String(waiver.status) + (waiver.request_mode ? ' (' + waiver.request_mode + ')' : '')
    : adminBookingsGuestPeekT('admin.bookings.waiverUnknown', 'Unknown / not linked');
  var code = row.booking_code || '—';
  var title = adminBookingsGuestPeekT('admin.bookings.guestPeek.title', 'Guest');
  var closeLabel = adminBookingsGuestPeekT('admin.bookings.guestPeek.close', 'Close');
  var bookingLabel = adminBookingsGuestPeekT('admin.bookings.guestPeek.thisBooking', 'This booking');
  var emailLabel = adminBookingsGuestPeekT('customers.detail.email', 'Email');
  var loadingLabel = adminBookingsGuestPeekT('admin.bookings.guestPeek.loading', 'Loading guest…');

  var statusHtml = '';
  if (peek.loading) {
    statusHtml = '<p class="portal-admin-bookings-guest-peek-status" data-bookings-guest-peek-loading="1">' +
      escHtml(loadingLabel) + '</p>';
  } else if (peek.error) {
    statusHtml = '<p class="portal-admin-bookings-guest-peek-status is-error" data-bookings-guest-peek-error="1">' +
      escHtml(peek.error) + '</p>';
  }

  // Identity + this booking only — no invented prices/availability; money stays on the row expand.
  var html =
    '<div class="portal-admin-bookings-guest-peek-backdrop" data-bookings-guest-peek-close="1" tabindex="-1"></div>' +
    '<aside class="portal-admin-bookings-guest-peek-panel" role="dialog" aria-modal="true" ' +
      'aria-label="' + escHtml(title) + '" data-bookings-guest-peek-panel="1">' +
      '<div class="portal-admin-bookings-guest-peek-top">' +
        '<h3 class="portal-admin-bookings-guest-peek-title">' + escHtml(title) + '</h3>' +
        '<button type="button" class="btn btn-ghost btn-compact portal-admin-bookings-guest-peek-close" ' +
          'data-bookings-guest-peek-close="1" aria-label="' + escHtml(closeLabel) + '">' +
          escHtml(closeLabel) + '</button>' +
      '</div>' +
      statusHtml +
      '<div class="portal-admin-bookings-guest-peek-name">' + escHtml(name) + '</div>' +
      '<ul class="portal-admin-bookings-kv portal-admin-bookings-guest-peek-kv">' +
        '<li><span>' + escHtml(adminBookingsGuestPeekT('admin.bookings.phone', 'Phone')) +
          '</span><span data-bookings-guest-peek-phone="1">' + escHtml(phone) + '</span></li>' +
        (email
          ? ('<li><span>' + escHtml(emailLabel) + '</span><span data-bookings-guest-peek-email="1">' +
            escHtml(email) + '</span></li>')
          : '') +
        '<li><span>' + escHtml(adminBookingsGuestPeekT('admin.bookings.waiver', 'Waiver')) +
          '</span><span>' + escHtml(waiverText) + '</span></li>' +
        '<li><span>' + escHtml(bookingLabel) + '</span><span data-bookings-guest-peek-code="1">' +
          escHtml(code) + '</span></li>' +
      '</ul>' +
      '<p class="portal-admin-bookings-muted portal-admin-bookings-guest-peek-hint">' +
        escHtml(adminBookingsGuestPeekT(
          'admin.bookings.guestPeek.stayHint',
          'Staying on Bookings — guest opened here, not in Inbox.'
        )) +
      '</p>' +
    '</aside>';

  if (!existing) {
    existing = document.createElement('div');
    existing.className = 'portal-admin-bookings-guest-peek';
    existing.setAttribute('data-bookings-guest-peek', '1');
    host.appendChild(existing);
  }
  existing.innerHTML = html;

  if (!existing.dataset.wired) {
    existing.dataset.wired = '1';
    existing.addEventListener('click', function (ev) {
      var closer = ev.target && ev.target.closest
        ? ev.target.closest('[data-bookings-guest-peek-close]')
        : null;
      if (!closer) return;
      ev.preventDefault();
      ev.stopPropagation();
      adminBookingsCloseGuestPeek();
    });
  }
  if (!document.body.dataset.bookingsGuestPeekEscWired) {
    document.body.dataset.bookingsGuestPeekEscWired = '1';
    document.addEventListener('keydown', function (ev) {
      if (!ev || (ev.key !== 'Escape' && ev.key !== 'Esc')) return;
      if (!adminBookingsState.guestPeek) return;
      if (ev.preventDefault) ev.preventDefault();
      adminBookingsCloseGuestPeek();
    });
  }
}

function adminBookingsToggleExpandedRow(rowKey) {
  var key = String(rowKey || '');
  if (!key) return;
  adminBookingsCloseGuestPeek();
  adminBookingsState.expandedId = adminBookingsState.expandedId === key ? null : key;
  renderAdminBookingsTable();
}

function adminBookingsOnTableClick(ev) {
  var guestBtn = ev.target && ev.target.closest ? ev.target.closest('[data-bookings-guest-phone]') : null;
  if (guestBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    var guestRow = guestBtn.closest ? guestBtn.closest('[data-bookings-row-id]') : null;
    var guestId = guestRow ? guestRow.getAttribute('data-bookings-row-id') : '';
    var phone = guestBtn.getAttribute('data-bookings-guest-phone') || '';
    adminBookingsOpenGuestPeek(phone, guestId);
    return;
  }
  var refundBtn = ev.target && ev.target.closest ? ev.target.closest('[data-bookings-record-refund]') : null;
  if (refundBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    openAdminBookingsRefundForm(
      refundBtn.getAttribute('data-bookings-record-refund'),
      refundBtn.getAttribute('data-bookings-refund-row-key')
    );
    return;
  }
  var hideBtn = ev.target && ev.target.closest ? ev.target.closest('[data-bookings-hide]') : null;
  if (hideBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    adminBookingsCloseGuestPeek();
    adminBookingsHideBooking(hideBtn.getAttribute('data-bookings-hide'));
    return;
  }
  var unhideBtn = ev.target && ev.target.closest ? ev.target.closest('[data-bookings-unhide]') : null;
  if (unhideBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    adminBookingsCloseGuestPeek();
    adminBookingsUnhideBooking(unhideBtn.getAttribute('data-bookings-unhide'));
    return;
  }
  var restoreBtn = ev.target && ev.target.closest ? ev.target.closest('[data-bookings-restore]') : null;
  if (restoreBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    adminBookingsCloseGuestPeek();
    adminBookingsRestoreBooking(restoreBtn.getAttribute('data-bookings-restore'));
    return;
  }
  var codeBtn = ev.target && ev.target.closest ? ev.target.closest('[data-bookings-open-schedule]') : null;
  if (codeBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    adminBookingsCloseGuestPeek();
    adminBookingsOpenInSchedule(codeBtn.getAttribute('data-bookings-open-schedule'), {
      booking_code: codeBtn.getAttribute('data-booking-code'),
      service_date_start: codeBtn.getAttribute('data-service-date-start'),
    });
    return;
  }
  // Clicks inside the expand panel (detail / refund UI) must not toggle the row.
  var expandHit = ev.target && ev.target.closest ? ev.target.closest('[data-bookings-expand]') : null;
  if (expandHit) return;
  // Nested interactive controls must not toggle expansion.
  var interactive = ev.target && ev.target.closest
    ? ev.target.closest('button, a, input, select, textarea, label')
    : null;
  var rowBtn = ev.target && ev.target.closest ? ev.target.closest('[data-bookings-row-id]') : null;
  if (interactive && rowBtn && interactive !== rowBtn && rowBtn.contains(interactive)) {
    return;
  }
  if (rowBtn) adminBookingsToggleExpandedRow(rowBtn.getAttribute('data-bookings-row-id'));
}

function adminBookingsOnTableKeydown(ev) {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  var target = ev.target;
  if (!target) return;
  var guestBtn = target.closest ? target.closest('[data-bookings-guest-phone]') : null;
  if (guestBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    var guestRowKey = guestBtn.closest ? guestBtn.closest('[data-bookings-row-id]') : null;
    var guestIdKey = guestRowKey ? guestRowKey.getAttribute('data-bookings-row-id') : '';
    var phoneKey = guestBtn.getAttribute('data-bookings-guest-phone') || '';
    adminBookingsOpenGuestPeek(phoneKey, guestIdKey);
    return;
  }
  var codeKeyBtn = target.closest ? target.closest('[data-bookings-open-schedule]') : null;
  if (codeKeyBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    adminBookingsOpenInSchedule(codeKeyBtn.getAttribute('data-bookings-open-schedule'), {
      booking_code: codeKeyBtn.getAttribute('data-booking-code'),
      service_date_start: codeKeyBtn.getAttribute('data-service-date-start'),
    });
    return;
  }
  var refundBtn = target.closest ? target.closest('[data-bookings-record-refund]') : null;
  if (refundBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    openAdminBookingsRefundForm(
      refundBtn.getAttribute('data-bookings-record-refund'),
      refundBtn.getAttribute('data-bookings-refund-row-key')
    );
    return;
  }
  var nestedInteractive = target.closest
    ? target.closest('button, a, input, select, textarea, label, form')
    : null;
  var rowBtn = target.closest ? target.closest('[data-bookings-row-id]') : null;
  if (!rowBtn) return;
  if (nestedInteractive && nestedInteractive !== rowBtn && rowBtn.contains(nestedInteractive)) {
    return;
  }
  if (target !== rowBtn && nestedInteractive) return;
  ev.preventDefault();
  adminBookingsToggleExpandedRow(rowBtn.getAttribute('data-bookings-row-id'));
}

/** Re-bind row expand clicks when the table wrap is replaced without a full shell remount. */
function adminBookingsEnsureTableDelegates() {
  var wrap = el('admin-bookings-table-wrap');
  if (!wrap || wrap.dataset.bookingsTableWired === '1') return;
  wrap.dataset.bookingsTableWired = '1';
  wrap.addEventListener('click', adminBookingsOnTableClick);
  wrap.addEventListener('keydown', adminBookingsOnTableKeydown);
}

function wireAdminBookingsPanel() {
  var root = el('admin-bookings-body');
  if (!root || root.dataset.bookingsWired === '1') return;
  root.dataset.bookingsWired = '1';

  function applyLiveFilters() {
    adminBookingsReadFiltersFromDom();
    loadAdminBookings();
  }

  var qInput = el('admin-bookings-q');
  if (qInput) {
    var searchTimer = null;
    qInput.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        applyLiveFilters();
      }, 220);
    });
  }
  ['admin-bookings-status', 'admin-bookings-type'].forEach(function (id) {
    var node = el(id);
    if (!node) return;
    node.addEventListener('change', function () {
      applyLiveFilters();
    });
  });

  wireAdminBookingsDateRange(applyLiveFilters);

  var exportBtn = el('admin-bookings-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', function () {
      adminBookingsReadFiltersFromDom();
      var url = '/staff/admin/bookings/export.csv?' + adminBookingsBuildQuery();
      window.open(url, '_blank', 'noopener');
    });
  }

  var wrap = el('admin-bookings-table-wrap');
  if (wrap) adminBookingsEnsureTableDelegates();
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
      metric('admin.bookings.metric.bookings', s.bookings_count != null ? String(s.bookings_count) : '0', 'count') +
      metric('admin.bookings.metric.collected', adminBookingsFormatEur(s.collected_cents), 'collected') +
      metric('admin.bookings.metric.refunded', adminBookingsFormatEur(s.refunded_cents), 'refunded') +
      metric('admin.bookings.metric.net', adminBookingsFormatEur(s.net_cents), 'net') +
      metric('admin.bookings.metric.outstanding', adminBookingsFormatEur(s.outstanding_cents), 'outstanding') +
    '</div>';

  function metric(labelKey, value, tone) {
    var toneClass = tone ? (' is-' + String(tone)) : '';
    return '<div class="portal-admin-bookings-metric">' +
      '<div class="portal-admin-bookings-metric-label">' + escHtml(portalT(labelKey)) + '</div>' +
      '<div class="portal-admin-bookings-metric-value' + toneClass + '">' + escHtml(value) + '</div></div>';
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
      adminBookingsTh('admin.bookings.col.booking', 'booking') +
      adminBookingsTh('admin.bookings.col.guest', 'guest') +
      adminBookingsTh('admin.bookings.col.created', 'created') +
      adminBookingsTh(adminBookingsIsLodging() ? 'admin.bookings.col.package' : 'admin.bookings.col.type', 'type') +
      adminBookingsTh('admin.bookings.col.total', 'total', 'num') +
      adminBookingsTh('admin.bookings.col.paid', 'paid', 'num') +
      adminBookingsTh('admin.bookings.col.status', 'status', 'status') +
    '</div></div><div class="portal-admin-bookings-tbody" role="rowgroup">';

  rows.forEach(function (row, rowIndex) {
    var rowKey = adminBookingsRowKey(row, rowIndex);
    var id = String(row.booking_id || '').trim();
    var expanded = adminBookingsState.expandedId === rowKey;
    // Bookings panel: never grey cancelled (schedule greys separately).
    var archived = false;
    var code = String(row.booking_code || '');
    var createdText = adminBookingsFormatMadridCreated(row.created_at);
    // Row block keeps expand OUTSIDE the 7-col grid so line-items never inject
    // into Total/Paid (KPI) columns. data-bookings-row-id stays on the tr so
    // closest() / n1 row clicks hit the compact row, not the expanded block.
    html += '<div class="portal-admin-bookings-row-block' + (expanded ? ' is-expanded' : '') + '">';
    html += '<div class="portal-admin-bookings-tr' + (archived ? ' is-archived' : '') +
      (expanded ? ' is-expanded' : '') + '" role="row" data-bookings-row-id="' + escHtml(rowKey) +
      '" tabindex="0" aria-expanded="' + (expanded ? 'true' : 'false') + '">';
    var openScheduleLabel = adminBookingsOpenScheduleLabel(code);
    html += '<div class="portal-admin-bookings-td portal-admin-bookings-td-code" role="cell">' +
      '<button type="button" class="portal-admin-bookings-code portal-admin-bookings-code-link" ' +
      'data-bookings-open-schedule="' + escHtml(id) + '" ' +
      (id ? '' : 'disabled aria-disabled="true" ') +
      'data-booking-code="' + escHtml(code) + '" ' +
      'data-service-date-start="' + escHtml(String(row.service_date_start || '').slice(0, 10)) + '" ' +
      'title="' + escHtml(openScheduleLabel) + '" ' +
      'aria-label="' + escHtml(openScheduleLabel) + '">' +
      escHtml(code) + '</button></div>';
    html += '<div class="portal-admin-bookings-td portal-admin-bookings-td-guest" role="cell">' +
      '<button type="button" class="portal-admin-bookings-guest-link" data-bookings-guest-phone="' +
      escHtml(String(row.phone || '')) + '">' + escHtml(row.guest_name || '—') + '</button>' +
      '<div class="portal-admin-bookings-sub">' + escHtml(row.phone || '') + '</div></div>';
    html += '<div class="portal-admin-bookings-td portal-admin-bookings-td-created" role="cell">' +
      escHtml(createdText) + '</div>';
    html += '<div class="portal-admin-bookings-td portal-admin-bookings-td-type" role="cell">' +
      adminBookingsTypeChipsHtml(row) + '</div>';
    html += '<div class="portal-admin-bookings-td portal-admin-bookings-td-num" role="cell">' +
      escHtml(adminBookingsFormatEur(row.total_cents != null ? row.total_cents : row.charged_cents)) + '</div>';
    html += '<div class="portal-admin-bookings-td portal-admin-bookings-td-num" role="cell">' +
      escHtml(adminBookingsFormatEur(row.paid_cents != null ? row.paid_cents : row.collected_cents)) + '</div>';
    html += '<div class="portal-admin-bookings-td portal-admin-bookings-td-status" role="cell">' +
      '<div class="portal-admin-bookings-chip-row">' + adminBookingsStatusChipsHtml(row) + '</div></div>';
    html += '</div>';
    if (expanded) {
      html += renderAdminBookingsExpansion(row, rowKey);
    }
    html += '</div>';
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

  adminBookingsEnsureTableDelegates();

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

  // Sortable column headers — server-side sort of the full result set.
  wrap.querySelectorAll('[data-bookings-sort]').forEach(function (btn) {
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var col = String(btn.getAttribute('data-bookings-sort') || '');
      if (!col) return;
      var cur = String(adminBookingsState.filters.sort || '');
      var curDir = String(adminBookingsState.filters.dir || '');
      if (cur === col) {
        adminBookingsState.filters.dir = curDir === 'asc' ? 'desc' : 'asc';
      } else {
        adminBookingsState.filters.sort = col;
        adminBookingsState.filters.dir = ADMIN_BOOKINGS_SORT_FIRST_DIR[col] || 'asc';
      }
      adminBookingsState.filters.offset = 0;
      loadAdminBookings();
    });
  });
}

/**
 * Normalize a booking service-day token to YYYY-MM-DD (or '').
 * Accepts ISO dates, ISO datetimes, and Date-like values — never invents a day.
 */
function adminBookingsServiceDayIso(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'object' && typeof value.getFullYear === 'function' && !isNaN(value.getTime())) {
    var ym = String(value.getMonth() + 1);
    if (ym.length < 2) ym = '0' + ym;
    var yd = String(value.getDate());
    if (yd.length < 2) yd = '0' + yd;
    return value.getFullYear() + '-' + ym + '-' + yd;
  }
  var s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return '';
}

/**
 * Open booking on Schedule at its service start day via the single canonical
 * owners: openBookingInSchedule → scheduleOpenDayDetail + openScheduleDetailDrawer.
 *
 * Before the owner switches to portal-home (which always loadPortalHome's the
 * current forwardOffset — usually today), prime day-mode nav to the booking's
 * service day so Horario lands on that date, not today.
 */
function adminBookingsOpenInSchedule(bookingId, hint) {
  var id = String(bookingId || '').trim();
  if (!id) return;
  hint = hint || {};
  var rows = (adminBookingsState.data && adminBookingsState.data.rows) || [];
  var row = null;
  for (var i = 0; i < rows.length; i += 1) {
    if (String(rows[i].booking_id || '') === id) { row = rows[i]; break; }
  }
  if (!row) {
    row = { booking_id: id };
  }
  var start = adminBookingsServiceDayIso(row.service_date_start)
    || adminBookingsServiceDayIso(hint.service_date_start)
    || adminBookingsServiceDayIso(row.items && row.items[0] && row.items[0].service_date)
    || adminBookingsServiceDayIso(row.check_in)
    || '';
  var code = row.booking_code || hint.booking_code || null;
  var openFn = (typeof window !== 'undefined' && typeof window.openBookingInSchedule === 'function')
    ? window.openBookingInSchedule
    : (typeof openBookingInSchedule === 'function' ? openBookingInSchedule : null);
  if (openFn) {
    // Wrap switchToTab for this call only: portal-home always loadPortalHome()'s
    // current offset. Prime the service day first so that load is the booking day.
    var tabFn = (typeof window !== 'undefined' && typeof window.switchToTab === 'function')
      ? window.switchToTab
      : null;
    var wrapped = false;
    if (start && tabFn) {
      window.switchToTab = function (tab, subtab) {
        if (String(tab || '') === 'portal-home') {
          var primeFn = (typeof window !== 'undefined' && typeof window.schedulePrimeOpenDay === 'function')
            ? window.schedulePrimeOpenDay
            : (typeof schedulePrimeOpenDay === 'function' ? schedulePrimeOpenDay : null);
          if (primeFn) primeFn(start);
        }
        return tabFn(tab, subtab);
      };
      wrapped = true;
    }
    try {
      openFn({
        booking_id: row.booking_id || id,
        booking_code: code,
        guest_name: row.guest_name,
        phone: row.phone || null,
        guest_phone: row.phone || null,
        service_date_start: start || null,
        service_date: start || null,
        check_in: row.check_in || null,
      });
    } finally {
      if (wrapped) window.switchToTab = tabFn;
    }
    return;
  }
  // Fallback if openBookingInSchedule is not on the page (tests / partial loads).
  if (start) {
    var primeFnFb = (typeof window !== 'undefined' && typeof window.schedulePrimeOpenDay === 'function')
      ? window.schedulePrimeOpenDay
      : (typeof schedulePrimeOpenDay === 'function' ? schedulePrimeOpenDay : null);
    if (primeFnFb) primeFnFb(start);
  }
  if (typeof switchToTab === 'function') switchToTab('portal-home', null);
  function openDrawer() {
    if (typeof openScheduleDetailDrawer === 'function') {
      openScheduleDetailDrawer({
        booking_id: row.booking_id || id,
        booking_code: code,
        guest_name: row.guest_name || '',
        phone: row.phone || null,
        guest_phone: row.phone || null,
        service_date: start || null,
        _drawerFromCustomer: true,
      });
    }
  }
  if (start && typeof scheduleOpenDayDetail === 'function') {
    var p = scheduleOpenDayDetail(start);
    if (p && typeof p.then === 'function') {
      p.then(openDrawer).catch(openDrawer);
      return;
    }
  }
  openDrawer();
}

function adminBookingsTypeChipsHtml(row) {
  if (adminBookingsIsLodging()) {
    var pkg = String((row && row.package_code) || '').trim();
    if (!pkg || pkg === 'package_none' || pkg === 'no_package' || pkg === 'none') {
      return '<span class="portal-admin-bookings-muted">—</span>';
    }
    var pkgLabel = pkg.replace(/_/g, ' ');
    pkgLabel = pkgLabel.charAt(0).toUpperCase() + pkgLabel.slice(1);
    return '<span class="portal-admin-bookings-type-text">' + escHtml(pkgLabel) + '</span>';
  }
  // Prefer server-derived type_categories / type_flags (component-based).
  var cats = Array.isArray(row && row.type_categories) ? row.type_categories.slice() : [];
  var flags = row && row.type_flags && typeof row.type_flags === 'object' ? row.type_flags : null;
  if (!cats.length && flags) {
    if (flags.lessons) cats.push('lessons');
    if (flags.rentals) cats.push('rentals');
    if (flags.accommodation) cats.push('accommodation');
  }
  if (!cats.length) {
    // Compat only for older payloads without type_categories/type_flags.
    var what = String((row && row.what_summary) || '');
    if (/lesson/i.test(what)) cats.push('lessons');
    if (/rental/i.test(what)) cats.push('rentals');
    if (/accommodation|stay|lodging/i.test(what)) cats.push('accommodation');
  }
  if (!cats.length) {
    return '<span class="portal-admin-bookings-muted">—</span>';
  }
  var order = ['lessons', 'rentals', 'accommodation'];
  cats = order.filter(function (c) { return cats.indexOf(c) >= 0; });
  var labels = cats.map(function (c) {
    var key = 'admin.bookings.type.' + c;
    var label = portalT(key);
    if (!label || label === key) {
      label = c === 'lessons' ? 'Lessons' : (c === 'rentals' ? 'Rentals' : (c === 'accommodation' ? 'Accommodation' : c));
    }
    return label;
  });
  // Plain text (no type-chip spans) — joined with middle-dot separator.
  return '<span class="portal-admin-bookings-type-text">' + escHtml(labels.join(' · ')) + '</span>';
}

function adminBookingsTh(key, sortKey, align) {
  var label = portalT(key);
  // Fallback if col.type not yet in i18n bundle (keep col.what as alias).
  if ((!label || label === key) && key === 'admin.bookings.col.package') {
    label = 'Package';
  }
  if ((!label || label === key) && key === 'admin.bookings.col.type') {
    label = portalT('admin.bookings.col.what');
    if (!label || label === 'admin.bookings.col.what') label = 'Type';
  }
  if ((!label || label === key) && key === 'admin.bookings.col.created') {
    label = portalT('admin.bookings.col.dates');
    if (!label || label === 'admin.bookings.col.dates') label = 'Created';
  }
  var activeSort = String(adminBookingsState.filters.sort || '');
  var activeDir = String(adminBookingsState.filters.dir || '');
  var isActive = sortKey && activeSort === sortKey;
  var arrow = '';
  if (isActive) {
    arrow = activeDir === 'asc' ? ' ▲' : ' ▼';
  }
  var alignClass = '';
  if (align === 'num') alignClass = ' portal-admin-bookings-th-num';
  if (align === 'status') alignClass = ' portal-admin-bookings-th-status';
  if (!sortKey) {
    return '<div class="portal-admin-bookings-th' + alignClass + '" role="columnheader">' +
      escHtml(label) + '</div>';
  }
  var ariaSort = isActive ? (activeDir === 'asc' ? 'ascending' : 'descending') : 'none';
  return '<div class="portal-admin-bookings-th' + alignClass + (isActive ? ' is-sorted' : '') +
    '" role="columnheader" aria-sort="' + ariaSort + '">' +
    '<button type="button" class="portal-admin-bookings-sort-btn" data-bookings-sort="' +
    escHtml(sortKey) + '" title="' + escHtml(label) + '">' +
    escHtml(label) + '<span class="portal-admin-bookings-sort-arrow" aria-hidden="true">' +
    escHtml(arrow) + '</span></button></div>';
}

function renderAdminBookingsExpansion(row, rowKey) {
  rowKey = String(rowKey || adminBookingsRowKey(row, 0));
  var story = row.payment_story || {};
  var items = Array.isArray(row.items) ? row.items : [];
  var cleanItems = [];
  for (var ii = 0; ii < items.length; ii += 1) {
    var rawItem = items[ii];
    if (adminBookingsIsJunkExpandItem(rawItem)) continue;
    var label = adminBookingsCleanItemLabel(rawItem.label);
    if (!label) label = adminBookingsCleanItemLabel(rawItem.service_type);
    if (!label) label = '—';
    var dateOnly = adminBookingsFormatItemDate(rawItem.service_date);
    cleanItems.push({
      label: label,
      date: dateOnly,
      amount_due_cents: rawItem.amount_due_cents,
    });
  }
  var itemsHtml = cleanItems.length
    ? cleanItems.map(function (it) {
      return '<li><span>' + escHtml(it.label) +
        (it.date ? ' · ' + escHtml(it.date) : '') +
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

  var st = String(row.status || '').toLowerCase();
  var tags = Array.isArray(row.status_tags) ? row.status_tags : [];
  var isCancelled = st === 'cancelled' || st === 'canceled' || tags.indexOf('cancelled') >= 0;
  var isHidden = !!(row.hidden === true || tags.indexOf('hidden') >= 0);
  var storyCollected = Number((row.payment_story && row.payment_story.collected_cents) != null
    ? row.payment_story.collected_cents
    : (row.collected_cents != null ? row.collected_cents : (row.paid_cents || 0)));
  var storyRefunded = Number((row.payment_story && row.payment_story.refunded_cents) != null
    ? row.payment_story.refunded_cents
    : (row.refunded_cents != null ? row.refunded_cents : 0));
  var needsRefund = row.needs_refund === true
    || tags.indexOf('refund_needed') >= 0
    || (isCancelled && storyCollected > 0 && storyRefunded < storyCollected);
  var canRefund = adminBookingsCanWriteRefund() && needsRefund;
  // Show refund block only when cancelled or there are refund records (hide noise on normal bookings).
  var showRefundSection = isCancelled || refunds.length > 0;
  var refundAction = '';
  if (showRefundSection) {
    if (canRefund) {
      refundAction = '<button type="button" class="btn btn-primary btn-compact" data-bookings-record-refund="' +
        escHtml(String(row.booking_id || '')) + '" data-bookings-refund-row-key="' + escHtml(rowKey) + '">' +
        escHtml(portalT('admin.bookings.recordRefund')) + '</button>';
    } else if (adminBookingsCanWriteRefund() && isCancelled) {
      refundAction = ''; // unpaid or fully refunded — no Record Refund
    } else if (adminBookingsCanWriteRefund()) {
      // Belt-and-suspenders: only when section is shown and not cancelled (shouldn't normally hit).
      refundAction = '<p class="portal-admin-bookings-muted">' + escHtml(portalT('admin.bookings.refundNeedsCancel') || 'Cancel the booking before recording a refund.') + '</p>';
    } else {
      refundAction = '<p class="portal-admin-bookings-muted">' + escHtml(portalT('admin.bookings.recordRefundViewer')) + '</p>';
    }
  }
  var rowActions = '';
  if (isCancelled && adminBookingsCanWriteRefund()) {
    // Restore only when cancelled and not hidden — restore endpoint rejects archived/hidden.
    if (!isHidden) {
      rowActions += '<button type="button" class="btn btn-ghost btn-compact" data-bookings-restore="' +
        escHtml(String(row.booking_id || '')) + '">' +
        escHtml(portalT('admin.bookings.action.restore') || 'Restore') + '</button>';
    }
    if (isHidden) {
      rowActions += '<button type="button" class="btn btn-ghost btn-compact" data-bookings-unhide="' +
        escHtml(String(row.booking_id || '')) + '">' + escHtml(portalT('admin.bookings.action.unhide') || 'Unhide') + '</button>';
    } else {
      rowActions += '<button type="button" class="btn btn-ghost btn-compact" data-bookings-hide="' +
        escHtml(String(row.booking_id || '')) + '">' + escHtml(portalT('admin.bookings.action.hide') || 'Hide') + '</button>';
    }
  }

  var refundSectionHtml = '';
  if (showRefundSection) {
    refundSectionHtml =
      '<h4>' + escHtml(portalT('admin.bookings.refunds')) + '</h4><ul class="portal-admin-bookings-list">' + refundsHtml + '</ul>' +
      '<div class="portal-admin-bookings-refund-action" id="admin-bookings-refund-action-' + escHtml(rowKey) + '">' +
        refundAction +
      '</div>';
  }

  return '<div class="portal-admin-bookings-expand" role="region" data-bookings-expand="' +
    escHtml(rowKey) + '">' +
    '<div class="portal-admin-bookings-expand-grid">' +
      '<section data-bookings-section="guest"><h4>' + escHtml(portalT('admin.bookings.guestMeta')) + '</h4>' +
        '<ul class="portal-admin-bookings-kv">' +
          '<li><span>' + escHtml(portalT('admin.bookings.guest')) + '</span><span>' + escHtml((row.guest && row.guest.name) || row.guest_name || '—') + '</span></li>' +
          '<li><span>' + escHtml(portalT('admin.bookings.phone')) + '</span><span>' + escHtml((row.guest && row.guest.phone) || row.phone || '—') + '</span></li>' +
          '<li><span>' + escHtml(portalT('admin.bookings.waiver')) + '</span><span>' + escHtml(waiverText) + '</span></li>' +
          '<li><span>' + escHtml(portalT('admin.bookings.createdBy')) + '</span><span>' + escHtml(
            /^\d{4}-\d{2}-\d{2}/.test(String(row.created_by || ''))
              ? adminBookingsFormatMadridCreated(row.created_by)
              : (row.created_by || '—')
          ) + '</span></li>' +
        '</ul></section>' +
      '<section data-bookings-section="items"><h4>' + escHtml(portalT('admin.bookings.items')) + '</h4><ul class="portal-admin-bookings-kv">' + itemsHtml + '</ul></section>' +
      '<section data-bookings-section="payment"><h4>' + escHtml(portalT('admin.bookings.paymentStory')) + '</h4>' +
        '<ul class="portal-admin-bookings-kv">' +
          '<li><span>' + escHtml(portalT('admin.bookings.charged')) + '</span><span>' + escHtml(adminBookingsFormatEur(story.charged_cents)) + '</span></li>' +
          '<li><span>' + escHtml(portalT('admin.bookings.collected')) + '</span><span>' + escHtml(adminBookingsFormatEur(story.collected_cents)) + '</span></li>' +
          '<li><span>' + escHtml(portalT('admin.bookings.refunded')) + '</span><span>' + escHtml(adminBookingsFormatEur(story.refunded_cents)) + '</span></li>' +
          '<li><span>' + escHtml(portalT('admin.bookings.net')) + '</span><span>' + escHtml(adminBookingsFormatEur(story.net_cents)) + '</span></li>' +
        '</ul>' +
        refundSectionHtml +
        (rowActions
          ? '<div class="portal-admin-bookings-row-actions">' + rowActions + '</div>'
          : '') +
      '</section>' +
    '</div></div>';
}

function openAdminBookingsRefundForm(bookingId, rowKey) {
  adminBookingsCloseGuestPeek();
  rowKey = String(rowKey || adminBookingsRowKeyForBookingId(bookingId));
  var host = el('admin-bookings-refund-action-' + rowKey);
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
      adminBookingsState.expandedId = rowKey;
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
  window.adminBookingsReadFiltersFromDom = adminBookingsReadFiltersFromDom;
  window.adminBookingsRestoreFiltersToDom = adminBookingsRestoreFiltersToDom;
  window.adminBookingsBuildQuery = adminBookingsBuildQuery;
  window.loadAdminBookings = loadAdminBookings;
  window.renderAdminBookingsTable = renderAdminBookingsTable;
  window.renderAdminBookingsSummary = renderAdminBookingsSummary;
  window.adminBookingsRefreshOnLocaleChange = adminBookingsRefreshOnLocaleChange;
  window.adminBookingsCanWriteRefund = adminBookingsCanWriteRefund;
  window.adminBookingsState = adminBookingsState;
  window.openAdminBookingsRefundForm = openAdminBookingsRefundForm;
  window.adminBookingsOpenGuestPeek = adminBookingsOpenGuestPeek;
  window.adminBookingsCloseGuestPeek = adminBookingsCloseGuestPeek;
}


/* ── Bookings date-range picker (reuses scheduleCreateDateRange* select/display) ── */
var adminBookingsDateRangeDraft = { start: null, end: null };
var adminBookingsDateRangeViewYm = null;
var adminBookingsDateRangeDocWired = false;
var adminBookingsDateRangeOnApply = null;

function adminBookingsIsoValid(iso) {
  if (typeof scheduleCreateDateRangeIsValidIso === 'function') {
    return scheduleCreateDateRangeIsValidIso(iso);
  }
  iso = String(iso || '').slice(0, 10);
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(iso);
}

function adminBookingsDateRangeDisplayText(from, to) {
  from = from ? String(from).slice(0, 10) : '';
  to = to ? String(to).slice(0, 10) : from;
  if (!from) {
    var all = portalT('admin.bookings.dateRangeAll');
    return (all && all !== 'admin.bookings.dateRangeAll') ? all : 'All dates';
  }
  if (typeof scheduleCreateDateRangeDisplayText === 'function') {
    return scheduleCreateDateRangeDisplayText(from, to || from);
  }
  if (!to || from === to) return from;
  return from + ' – ' + to;
}

function adminBookingsSyncDateRangeDisplay() {
  var display = el('admin-bookings-date-range-display');
  var df = el('admin-bookings-date-from');
  var dt = el('admin-bookings-date-to');
  var from = df ? String(df.value || '').trim() : '';
  var to = dt ? String(dt.value || '').trim() : '';
  var clearedFrom = !!(df && df.getAttribute && df.getAttribute('data-range-cleared') === '1');
  var clearedTo = !!(dt && dt.getAttribute && dt.getAttribute('data-range-cleared') === '1');
  // Prefer DOM; if remount wiped inputs without Clear, keep state so the
  // chip matches the query search will send (search ∩ active range).
  if (!from && !clearedFrom && adminBookingsState.filters && adminBookingsState.filters.date_from) {
    from = String(adminBookingsState.filters.date_from || '').trim();
    if (df && from) df.value = from;
  }
  if (!to && !clearedTo && adminBookingsState.filters && adminBookingsState.filters.date_to) {
    to = String(adminBookingsState.filters.date_to || '').trim();
    if (dt && to) dt.value = to;
  }
  if (!to) to = from;
  if (display) display.textContent = adminBookingsDateRangeDisplayText(from, to || from);
}

function adminBookingsDateRangeIsOpen() {
  var pop = el('admin-bookings-date-range-popover');
  return !!(pop && !pop.hidden && pop.style && pop.style.display !== 'none');
}

function adminBookingsDateRangeClose(opts) {
  opts = opts || {};
  var pop = el('admin-bookings-date-range-popover');
  var trig = el('admin-bookings-date-range-trigger');
  if (pop) {
    pop.hidden = true;
    pop.style.display = 'none';
  }
  if (trig) trig.setAttribute('aria-expanded', 'false');
  if (opts.discard) {
    adminBookingsDateRangeDraft = {
      start: el('admin-bookings-date-from') ? (el('admin-bookings-date-from').value || null) : null,
      end: el('admin-bookings-date-to') ? (el('admin-bookings-date-to').value || null) : null,
    };
  }
}

function adminBookingsDateRangeMonthLabel(ym) {
  ym = String(ym || '').slice(0, 7);
  var parts = ym.split('-');
  if (parts.length < 2) return ym;
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
  try {
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  } catch (_e) {
    return ym;
  }
}

function adminBookingsDateRangeShiftYm(ym, delta) {
  ym = String(ym || '').slice(0, 7);
  var parts = ym.split('-');
  var y = Number(parts[0]);
  var m = Number(parts[1]) - 1 + Number(delta || 0);
  while (m < 0) { m += 12; y -= 1; }
  while (m > 11) { m -= 12; y += 1; }
  return y + '-' + String(m + 1).padStart(2, '0');
}

function adminBookingsRenderDateRangeCalendar() {
  var grid = el('admin-bookings-date-range-grid');
  var monthLab = el('admin-bookings-date-range-month-label');
  if (!grid) return;
  var ym = adminBookingsDateRangeViewYm || (function () {
    var t = new Date();
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0');
  })();
  adminBookingsDateRangeViewYm = ym;
  if (monthLab) monthLab.textContent = adminBookingsDateRangeMonthLabel(ym);

  var start = adminBookingsDateRangeDraft && adminBookingsDateRangeDraft.start
    ? String(adminBookingsDateRangeDraft.start).slice(0, 10) : null;
  var end = adminBookingsDateRangeDraft && adminBookingsDateRangeDraft.end
    ? String(adminBookingsDateRangeDraft.end).slice(0, 10) : null;

  var y = Number(ym.slice(0, 4));
  var m = Number(ym.slice(5, 7)) - 1;
  var first = new Date(y, m, 1);
  var startPad = first.getDay(); // Su=0
  var daysInMonth = new Date(y, m + 1, 0).getDate();
  var html = '';
  ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].forEach(function (d) {
    html += '<span class="portal-admin-bookings-date-range-dow">' + d + '</span>';
  });
  var i;
  for (i = 0; i < startPad; i++) {
    html += '<span class="portal-admin-bookings-date-range-day is-pad"></span>';
  }
  for (i = 1; i <= daysInMonth; i++) {
    var iso = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(i).padStart(2, '0');
    var cls = 'portal-admin-bookings-date-range-day';
    if (start && iso === start) cls += ' is-start';
    if (end && iso === end) cls += ' is-end';
    if (start && end && iso > start && iso < end) cls += ' is-in-range';
    if (start && !end && iso === start) cls += ' is-end';
    html += '<button type="button" class="' + cls + '" data-bookings-day="' + iso + '">' + i + '</button>';
  }
  grid.innerHTML = html;
}

function adminBookingsDateRangeOpen() {
  var df = el('admin-bookings-date-from');
  var dt = el('admin-bookings-date-to');
  var from = df ? String(df.value || '') : '';
  var to = dt ? String(dt.value || '') : '';
  var clearedFrom = !!(df && df.getAttribute && df.getAttribute('data-range-cleared') === '1');
  var clearedTo = !!(dt && dt.getAttribute && dt.getAttribute('data-range-cleared') === '1');
  if (!adminBookingsIsoValid(from) && !clearedFrom && adminBookingsState.filters) {
    from = String(adminBookingsState.filters.date_from || '');
  }
  if (!adminBookingsIsoValid(to) && !clearedTo && adminBookingsState.filters) {
    to = String(adminBookingsState.filters.date_to || '');
  }
  adminBookingsDateRangeDraft = {
    start: adminBookingsIsoValid(from) ? from : null,
    end: adminBookingsIsoValid(to) ? to : (adminBookingsIsoValid(from) ? from : null),
  };
  var seed = adminBookingsDateRangeDraft.start || (function () {
    var t = new Date();
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  })();
  adminBookingsDateRangeViewYm = String(seed).slice(0, 7);
  var pop = el('admin-bookings-date-range-popover');
  var trig = el('admin-bookings-date-range-trigger');
  if (pop) {
    pop.hidden = false;
    pop.style.display = '';
  }
  if (trig) trig.setAttribute('aria-expanded', 'true');
  adminBookingsRenderDateRangeCalendar();
}

function adminBookingsDateRangeSelectDay(iso) {
  iso = String(iso || '').slice(0, 10);
  if (!adminBookingsIsoValid(iso)) return;
  if (typeof scheduleCreateDateRangeSelectDay === 'function') {
    adminBookingsDateRangeDraft = scheduleCreateDateRangeSelectDay(adminBookingsDateRangeDraft || {}, iso);
  } else {
    var st = adminBookingsDateRangeDraft || {};
    var s = st.start ? String(st.start).slice(0, 10) : null;
    var e = st.end ? String(st.end).slice(0, 10) : null;
    if (!s || (s && e)) adminBookingsDateRangeDraft = { start: iso, end: null };
    else if (iso < s) adminBookingsDateRangeDraft = { start: iso, end: null };
    else adminBookingsDateRangeDraft = { start: s, end: iso };
  }
  adminBookingsRenderDateRangeCalendar();
  // Live-apply: commit as soon as the range is complete (start+end). No Apply button.
  var draft = adminBookingsDateRangeDraft || {};
  if (draft.start && draft.end) {
    adminBookingsDateRangeCommit(adminBookingsDateRangeOnApply);
  }
}

function adminBookingsDateRangeCommit(onApply) {
  var draft = adminBookingsDateRangeDraft || {};
  var start = draft.start ? String(draft.start).slice(0, 10) : '';
  var end = draft.end ? String(draft.end).slice(0, 10) : start;
  if (start && !end) end = start;
  if (start && end && end < start) {
    var tmp = start; start = end; end = tmp;
  }
  var df = el('admin-bookings-date-from');
  var dt = el('admin-bookings-date-to');
  if (df) { df.value = start || ''; df.removeAttribute('data-range-cleared'); }
  if (dt) { dt.value = end || ''; dt.removeAttribute('data-range-cleared'); }
  adminBookingsState.filters.date_from = start || '';
  adminBookingsState.filters.date_to = end || '';
  adminBookingsSyncDateRangeDisplay();
  adminBookingsDateRangeClose({});
  if (typeof onApply === 'function') onApply();
}

function wireAdminBookingsDateRange(onApply) {
  adminBookingsDateRangeOnApply = onApply;
  adminBookingsSyncDateRangeDisplay();

  var trig = el('admin-bookings-date-range-trigger');
  if (trig) {
    trig.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (adminBookingsDateRangeIsOpen()) adminBookingsDateRangeClose({ discard: true });
      else adminBookingsDateRangeOpen();
    });
  }
  var prev = el('admin-bookings-date-range-prev');
  if (prev) {
    prev.addEventListener('click', function () {
      adminBookingsDateRangeViewYm = adminBookingsDateRangeShiftYm(adminBookingsDateRangeViewYm, -1);
      adminBookingsRenderDateRangeCalendar();
    });
  }
  var next = el('admin-bookings-date-range-next');
  if (next) {
    next.addEventListener('click', function () {
      adminBookingsDateRangeViewYm = adminBookingsDateRangeShiftYm(adminBookingsDateRangeViewYm, 1);
      adminBookingsRenderDateRangeCalendar();
    });
  }
  var grid = el('admin-bookings-date-range-grid');
  if (grid) {
    grid.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-bookings-day]') : null;
      if (!btn) return;
      adminBookingsDateRangeSelectDay(btn.getAttribute('data-bookings-day'));
    });
  }
  // No date-range Apply — complete selection commits live via adminBookingsDateRangeSelectDay.
  var cancelBtn = el('admin-bookings-date-range-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', function () {
      adminBookingsDateRangeClose({ discard: true });
    });
  }
  var clearBtn = el('admin-bookings-date-range-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      adminBookingsDateRangeDraft = { start: null, end: null };
      var df = el('admin-bookings-date-from');
      var dt = el('admin-bookings-date-to');
      if (df) { df.value = ''; df.setAttribute('data-range-cleared', '1'); }
      if (dt) { dt.value = ''; dt.setAttribute('data-range-cleared', '1'); }
      adminBookingsState.filters.date_from = '';
      adminBookingsState.filters.date_to = '';
      adminBookingsSyncDateRangeDisplay();
      adminBookingsDateRangeClose({});
      if (typeof onApply === 'function') onApply();
    });
  }
  if (!adminBookingsDateRangeDocWired) {
    adminBookingsDateRangeDocWired = true;
    document.addEventListener('mousedown', function (ev) {
      if (!adminBookingsDateRangeIsOpen()) return;
      var host = el('admin-bookings-date-range');
      if (host && host.contains(ev.target)) return;
      adminBookingsDateRangeClose({ discard: true });
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && adminBookingsDateRangeIsOpen()) {
        adminBookingsDateRangeClose({ discard: true });
      }
    });
  }
}

function adminBookingsSchoolQuery() {
  var q = 'client=' + encodeURIComponent(typeof getClient === 'function' ? getClient() : 'sunset');
  if (typeof getSunsetLocation === 'function') {
    q += '&location=' + encodeURIComponent(getSunsetLocation() || '');
  }
  return q;
}
function adminBookingsHideBooking(bookingId) {
  if (!bookingId) return;
  if (!window.confirm(portalT('schedule.drawer.hideBookingConfirm') || 'Hide this cancelled booking from the schedule?')) return;
  fetch('/staff/schedule/bookings/hide?' + adminBookingsSchoolQuery(), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ booking_id: bookingId }),
  }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (out) {
      if (!out.ok || !out.d || out.d.success !== true) throw new Error((out.d && (out.d.message || out.d.error)) || 'Hide failed');
      loadAdminBookings();
    }).catch(function (err) {
      setAdminBookingsMsg(err.message || 'Hide failed', true);
    });
}
function adminBookingsUnhideBooking(bookingId) {
  if (!bookingId) return;
  fetch('/staff/schedule/bookings/unhide?' + adminBookingsSchoolQuery(), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ booking_id: bookingId }),
  }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (out) {
      if (!out.ok || !out.d || out.d.success !== true) throw new Error((out.d && (out.d.message || out.d.error)) || 'Unhide failed');
      loadAdminBookings();
    }).catch(function (err) {
      setAdminBookingsMsg(err.message || 'Unhide failed', true);
    });
}

/** Cancelled → active. Does not touch money/refund records. */
function adminBookingsRestoreBooking(bookingId) {
  if (!bookingId) return;
  var confirmMsg = portalT('schedule.drawer.restoreBookingConfirm')
    || portalT('admin.bookings.action.restoreConfirm')
    || 'Restore this cancelled booking?';
  if (!window.confirm(confirmMsg)) return;
  fetch('/staff/schedule/bookings/restore?' + adminBookingsSchoolQuery(), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ booking_id: bookingId }),
  }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (out) {
      if (!out.ok || !out.d || out.d.success !== true) {
        var d = out.d || {};
        var msg = d.message || d.error || 'Restore failed';
        if (d.detail) msg += ' (' + String(d.detail).slice(0, 180) + ')';
        throw new Error(msg);
      }
      loadAdminBookings();
    }).catch(function (err) {
      setAdminBookingsMsg(err.message || 'Restore failed', true);
    });
}
