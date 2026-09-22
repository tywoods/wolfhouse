/**
 * Staff Portal Inbox: saved-view rail. Reads GET /staff/inbox/views and loads the
 * conversation list from GET /staff/inbox/list?view=. Injected after inbox-thread
 * so it can wrap loadInbox / pollInboxConversationListLive without rewriting them.
 *
 * Person-rows from the list endpoint are mapped onto the existing conversation
 * card shape; renderInbox / loadConvDetail stay in inbox-thread.js.
 */

var INBOX_DEFAULT_SAVED_VIEW = 'all';
var inboxSavedViewId = INBOX_DEFAULT_SAVED_VIEW;
var inboxViewsListGen = 0;
var inboxViewsRailGen = 0;
var inboxSavedViewRows = [];
var inboxSavedViewHasMore = false;
var inboxSavedViewNextCursor = null;
var inboxSavedViewLoadingMore = false;
var inboxSavedViewExpanded = false;
var INBOX_VIEW_SOURCE_CUSTOMERS = 'customers';
var INBOX_CONV_ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * INBOX-GUEST-SIDEBAR-SPLIT-001: Surface ownership for Sunset.
 * 'inbox' = messenger filters (All, WhatsApp, Email, Needs human, Spam, Owner Lab)
 * 'guest' = people directory filters (All people, Checked in, Lesson today, etc.)
 */
var INBOX_VIEW_SURFACE_INBOX = 'inbox';
var INBOX_VIEW_SURFACE_GUEST = 'guest';
var inboxCurrentSurface = INBOX_VIEW_SURFACE_INBOX;
var inboxLastInboxViewId = 'all';
var inboxLastGuestViewId = 'all_people';

var INBOX_SURFACE_ORDER_INBOX = ['all', 'whatsapp', 'email', 'needs_human', 'spam', 'owner_lab'];
var INBOX_SURFACE_ORDER_GUEST = ['all_people', 'equipment_out', 'lesson_today', 'upcoming', 'hot_leads', 'warm_leads', 'unpaid', 'waiver_due', 'do_not_contact'];
var INBOX_SURFACE_ORDER_GUEST_WOLFHOUSE = ['all_people', 'checked_in', 'lesson_today', 'upcoming', 'hot_leads', 'warm_leads', 'unpaid', 'waiver_due', 'do_not_contact'];

function inboxViewsIsSunsetTenant() {
  try {
    if (typeof document !== 'undefined' && document.documentElement
        && document.documentElement.getAttribute('data-portal-client') === 'sunset') {
      return true;
    }
  } catch (_e) {}
  return false;
}

function inboxViewGetGuestSurfaceOrder() {
  return inboxViewsIsSunsetTenant() ? INBOX_SURFACE_ORDER_GUEST : INBOX_SURFACE_ORDER_GUEST_WOLFHOUSE;
}

function inboxViewGetSurfaceForViewId(viewId) {
  if (INBOX_SURFACE_ORDER_INBOX.indexOf(viewId) >= 0) return INBOX_VIEW_SURFACE_INBOX;
  if (inboxViewGetGuestSurfaceOrder().indexOf(viewId) >= 0) return INBOX_VIEW_SURFACE_GUEST;
  if (INBOX_SURFACE_ORDER_GUEST.indexOf(viewId) >= 0) return INBOX_VIEW_SURFACE_GUEST;
  return INBOX_VIEW_SURFACE_INBOX;
}

function inboxViewGetDefaultViewForSurface(surface) {
  if (surface === INBOX_VIEW_SURFACE_GUEST) return 'all_people';
  return 'all';
}

function inboxViewGetSurfaceOrder(surface) {
  if (surface === INBOX_VIEW_SURFACE_GUEST) return inboxViewGetGuestSurfaceOrder();
  return INBOX_SURFACE_ORDER_INBOX;
}

function inboxViewsSyncSurfaceFromPreset() {
  var isGuest = false;
  try {
    if (typeof inboxColumnsRuntime !== 'undefined'
        && inboxColumnsRuntime
        && inboxColumnsRuntime.record
        && inboxColumnsRuntime.record.preset === 'guest') {
      isGuest = true;
    }
  } catch (_e) {}
  if (!isGuest && typeof document !== 'undefined' && document.querySelector) {
    if (document.querySelector('[data-inbox-preset="guest"][aria-pressed="true"]')) {
      isGuest = true;
    }
  }
  return isGuest ? INBOX_VIEW_SURFACE_GUEST : INBOX_VIEW_SURFACE_INBOX;
}

function inboxViewsConvIdIsUuid(id) {
  return INBOX_CONV_ID_UUID_RE.test(String(id || '').trim());
}

function inboxViewsFindCachedPersonRow(convId) {
  var needle = String(convId || '').trim();
  if (!needle) return null;
  var list = inboxConversationsCache || [];
  for (var i = 0; i < list.length; i++) {
    var row = list[i];
    if (!row) continue;
    if (row.conversation_id && String(row.conversation_id) === needle) return row;
    if (row._inbox_view_key && String(row._inbox_view_key) === needle) return row;
  }
  return null;
}

/**
 * INBOX-EMPTY-CONTACT-729 leftover of PR #729.
 * People rows with no conversation (or no contact) must show empty-thread
 * copy. Do not POST /staff/customers/:phone/create-conversation from Inbox.
 */
function inboxViewsEmptyThreadCopy() {
  var msg = (typeof t === 'function')
    ? t('inbox.detail.thread.empty')
    : 'No message history yet — messages appear here once the guest chats.';
  var body = (typeof escHtml === 'function') ? escHtml(msg) : String(msg);
  return '<div class="thread-empty">' + body + '</div>';
}

function inboxViewsPaintEmptyPersonDetail(row, targetEl) {
  targetEl = targetEl || (typeof el === 'function' ? el('detail-content') : null);
  if (!targetEl) return;
  if (targetEl.classList && targetEl.classList.remove) {
    targetEl.classList.remove('is-loading-detail');
  }
  if (!row) {
    targetEl.innerHTML = (typeof inboxEmptyDetailHtml === 'function')
      ? inboxEmptyDetailHtml()
      : inboxViewsEmptyThreadCopy();
    return;
  }
  var name = row.guest_name || row.display_name || row.phone || '';
  var safeName = (typeof escHtml === 'function') ? escHtml(name) : String(name);
  var html = '<div class="detail-layout"><div class="detail-main">';
  html += '<div class="detail-header"><div class="detail-header-main"><div class="detail-header-id">';
  html += '<div class="detail-name">' + safeName + '</div>';
  html += '</div></div></div>';
  html += '<div class="thread-section"><div class="thread"><div class="thread-messages">';
  html += inboxViewsEmptyThreadCopy();
  html += '</div></div></div></div>';
  html += '<div class="detail-sidebar" id="inbox-detail-sidebar"></div></div>';
  targetEl.innerHTML = html;
}

function inboxViewsPaintPersonCustomerCard(row) {
  var sidebar = typeof inboxContextSidebarEl === 'function'
    ? inboxContextSidebarEl()
    : (typeof el === 'function' ? el('inbox-detail-sidebar') : null);
  if (!sidebar || !row) return;
  var phone = normalizeCustomerPhoneClient(row.phone) || String(row.phone || '').trim();
  if (!phone) return;
  var fallback = {
    success: true,
    phone: phone,
    identity: {
      customer_id: row.customer_id || null,
      phone: phone,
      display_name: row.guest_name || row.display_name || null,
      email: row.email || row.guest_email || null,
      language: row.language || null,
      crm_tags: row.crm_tags || {},
      auto_tags: row.auto_tags || {},
      display_tags: row.display_tags || [],
    },
    bookings: [],
    service_records: [],
    handoffs: [],
    open_handoffs: [],
    messages: [],
    notes: {},
  };
  function paint(data) {
    var payload = data && data.success ? data : fallback;
    sidebar.innerHTML = typeof inboxCustomerFullHtml === 'function'
      ? inboxCustomerFullHtml(payload, { composite: { context: payload, bookings: payload.bookings || [] }, conv: null })
      : '';
    if (typeof inboxContextWireActions === 'function') inboxContextWireActions(sidebar, { conversation: null });
    if (typeof inboxCustomerWireFull === 'function') inboxCustomerWireFull(sidebar, payload);
  }
  paint(fallback);
  var url = '/staff/customers/' + encodeURIComponent(phone) + '/context?client=' + encodeURIComponent(getClient());
  if (getClient() === 'sunset' && typeof getSunsetLocation === 'function') {
    url += '&location=' + encodeURIComponent(getSunsetLocation());
  }
  fetch(url)
    .then(function(r){ return r.json().then(function(data){ if (!r.ok || !data.success) throw new Error((data && data.error) || ('HTTP ' + r.status)); return data; }); })
    .then(paint)
    .catch(function(){ paint(fallback); });
}

function inboxViewsOpenGuestCustomerCard(row, targetEl) {
  if (row && row._inbox_view_key) selectedConvId = row._inbox_view_key;
  inboxViewsPaintEmptyPersonDetail(row, targetEl);
  inboxViewsPaintPersonCustomerCard(row);
}

function inboxViewsOpenPersonWithoutConversation(row, targetEl) {
  inboxViewsOpenGuestCustomerCard(row, targetEl);
}

function inboxViewsResolveLoadConvDetail(convId, targetEl) {
  if (inboxViewsConvIdIsUuid(convId)) {
    _inboxViewsLegacyLoadConvDetail(convId, targetEl);
    return;
  }
  var id = String(convId || '').trim();
  if (!id) {
    inboxViewsPaintEmptyPersonDetail(null, targetEl);
    return;
  }
  var row = inboxViewsFindCachedPersonRow(id);
  if (row && row._inbox_view_source === INBOX_VIEW_SOURCE_CUSTOMERS
      && !inboxViewsConvIdIsUuid(row.conversation_id)) {
    inboxViewsOpenPersonWithoutConversation(row, targetEl);
    return;
  }
  _inboxViewsLegacyLoadConvDetail(convId, targetEl);
}

function inboxSavedViewsUrl(){
  return '/staff/inbox/views' + inboxClientQuery();
}

function inboxSavedViewListUrl(viewId, cursor){
  var url = '/staff/inbox/list' + inboxClientQuery() + '&view=' + encodeURIComponent(viewId || inboxSavedViewId || INBOX_DEFAULT_SAVED_VIEW);
  if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
  return url;
}

function mapInboxPersonRowToConv(row){
  row = row || {};
  return {
    conversation_id: row.conversation_id || '',
    guest_name: row.display_name || row.guest_name || '',
    phone: row.phone || '',
    guest_email: row.email || row.guest_email || '',
    email: row.email || '',
    email_subject: row.email_subject || row.subject || '',
    subject: row.subject || row.email_subject || '',
    channel: row.channel || 'whatsapp',
    last_message_preview: row.last_message_preview || '',
    last_activity: row.last_activity || null,
    last_activity_label: row.last_activity_label || fmtTs(row.last_activity),
    needs_human: !!row.needs_human,
    needs_attention: !!row.needs_attention,
    is_spam: !!row.is_spam,
    handoff_reason: row.handoff_reason || null,
    handoff_priority: row.handoff_priority || null,
    handoff_status: row.handoff_status || null,
    luna_paused: !!row.luna_paused,
    booking_code: row.booking_code || null,
    open_phone_testing: row.open_phone_testing === true,
    guest_tester_class: row.guest_tester_class || null,
    language: row.language || null,
    display_tags: row.display_tags || [],
    crm_tags: row.crm_tags || {},
    auto_tags: row.auto_tags || {},
    _inbox_view_key: row.key || '',
    _inbox_view_source: row.source || '',
  };
}

function applyInboxViewCounts(views){
  var list = views || [];
  var needs = null;
  for (var i = 0; i < list.length; i++){
    if (list[i] && list[i].id === 'needs_human' && list[i].count != null){
      needs = Number(list[i].count) || 0;
      break;
    }
  }
  var badge = el('hq-badge');
  if (badge && needs != null){
    badge.textContent = String(needs);
    badge.classList.toggle('visible', needs > 0);
  }
}

function inboxViewsGroupLabel(groups, groupId){
  var list = groups || [];
  for (var i = 0; i < list.length; i++){
    if (list[i] && list[i].id === groupId) {
      var translated = portalT('inbox.rail.group.' + groupId);
      return translated && translated !== 'inbox.rail.group.' + groupId ? translated : (list[i].label || groupId);
    }
  }
  return groupId;
}

function inboxViewsLabel(view){
  var translated = portalT('inbox.rail.view.' + view.id);
  return translated && translated !== 'inbox.rail.view.' + view.id ? translated : (view.label || view.id);
}

var INBOX_VIEWS_ICON_PATHS = {
  flag: '<path d="M4 21V5"/><path d="M4 5h11l-1.6 4L15 13H4"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/>',
  envelope: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 2.7-5 6-5s6 2 6 5M16 3.6a3 3 0 0 1 0 5.8M21 20c0-2.2-1.3-4-3.4-4.7"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
  flame: '<path d="M12 3c0 4-3 6-3 9a3 3 0 0 0 6 0c0-2 2-3 2-6 2 3 3 5.5 3 8a8 8 0 1 1-16 0c0-4 4-7 8-11z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m6.2 6.2 11.6 11.6"/>',
};

var INBOX_VIEWS_ICON_BY_ID = {
  needs_human: 'flag',
  approvals: 'flag',
  all: 'inbox',
  spam: 'ban',
  whatsapp: 'chat',
  email: 'envelope',
  owner_lab: 'flame',
  all_people: 'people',
  unassigned: 'people',
  equipment_out: 'surfboard',
  checked_in: 'check-circle',
  hot_leads: 'flame',
  warm_leads: 'sun',
  unpaid: 'card',
  waiver_due: 'doc',
  lesson_today: 'calendar',
  arriving_today: 'calendar',
  upcoming: 'clock',
  snoozed: 'clock',
  do_not_contact: 'ban',
};

function inboxViewsItemIconHtml(viewId){
  var key = INBOX_VIEWS_ICON_BY_ID[viewId] || 'inbox';
  var body = INBOX_VIEWS_ICON_PATHS[key] || INBOX_VIEWS_ICON_PATHS.inbox;
  return '<span class="inbox-views-item-ico" aria-hidden="true">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    body + '</svg></span>';
}

function renderInboxViewsRail(data){
  var rail = el('inbox-views-rail');
  if (!rail) return;
  var views = (data && data.views) || [];
  var groups = (data && data.groups) || [];
  if (!views.length){
    rail.innerHTML = '<div class="inbox-views-empty">' + escHtml(portalT('inbox.rail.empty')) + '</div>';
    return;
  }

  /* INBOX-GUEST-SIDEBAR-SPLIT-001: Filter and order views by current surface. */
  var surface = inboxCurrentSurface || inboxViewsSyncSurfaceFromPreset();
  var surfaceOrder = inboxViewGetSurfaceOrder(surface);
  var surfaceViews = views.filter(function(v) {
    return surfaceOrder.indexOf(v.id) >= 0;
  });
  surfaceViews.sort(function(a, b) {
    return surfaceOrder.indexOf(a.id) - surfaceOrder.indexOf(b.id);
  });

  if (!surfaceViews.length) {
    rail.innerHTML = '<div class="inbox-views-empty">' + escHtml(portalT('inbox.rail.empty')) + '</div>';
    return;
  }

  /* If the current selection is not in the visible surface, pick the default. */
  var currentInSurface = surfaceViews.some(function(v) { return v.id === inboxSavedViewId; });
  if (!currentInSurface) {
    inboxSavedViewId = inboxViewGetDefaultViewForSurface(surface);
  }

  /* Build flat list without group headers for the split surfaces. */
  var html = '';
  for (var j = 0; j < surfaceViews.length; j++) {
    var view = surfaceViews[j];
    var active = view.id === inboxSavedViewId;
    var label = inboxViewsLabel(view);
    var countHtml = (view.count == null)
      ? ''
      : '<span class="inbox-views-item-count">' + escHtml(String(view.count)) + '</span>';
    /* aria-label/title keep icon-only phone chrome accessible
       (SUNSET-MOBILE-INBOX-ICON-ONLY-STICKY-NO-GUEST-CARD-001). */
    html += '<button type="button" class="inbox-views-item' + (active ? ' is-active' : '') + '"' +
      ' data-inbox-view="' + escHtml(view.id) + '"' +
      ' data-inbox-view-surface="' + escHtml(surface) + '"' +
      ' aria-label="' + escHtml(label) + '"' +
      ' title="' + escHtml(label) + '"' +
      (active ? ' aria-current="true"' : '') +
      '>';
    html += inboxViewsItemIconHtml(view.id);
    html += '<span class="inbox-views-item-label">' + escHtml(label) + '</span>';
    html += countHtml;
    html += '</button>';
  }
  rail.innerHTML = html;
  applyInboxViewCounts(views);
}

function wireInboxViewsRail(){
  var rail = el('inbox-views-rail');
  if (!rail || rail.dataset.wired) return;
  rail.dataset.wired = '1';
  rail.addEventListener('click', function(ev){
    var target = ev.target;
    if (target && target.nodeType !== 1) target = target.parentElement;
    var btn = target && target.closest ? target.closest('[data-inbox-view]') : null;
    if (!btn) return;
    var viewId = btn.getAttribute('data-inbox-view');
    if (!viewId || viewId === inboxSavedViewId) return;
    selectInboxSavedView(viewId);
  });
}

function refreshInboxViewsRail(){
  var rail = el('inbox-views-rail');
  if (!rail) return Promise.resolve();
  wireInboxViewsRail();
  var gen = ++inboxViewsRailGen;
  return fetch(inboxSavedViewsUrl())
    .then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data){
      if (gen !== inboxViewsRailGen) return;
      if (!data || !data.success) throw new Error((data && data.error) || 'API error');
      renderInboxViewsRail(data);
    })
    .catch(function(){
      if (gen !== inboxViewsRailGen) return;
      if (!rail.innerHTML) rail.innerHTML = '<div class="inbox-views-empty">' + escHtml(portalT('inbox.rail.loadError')) + '</div>';
    });
}

function selectInboxSavedView(viewId){
  viewId = viewId || INBOX_DEFAULT_SAVED_VIEW;
  inboxSavedViewId = viewId;

  /* INBOX-GUEST-SIDEBAR-SPLIT-001: Remember last selection per surface. */
  var viewSurface = inboxViewGetSurfaceForViewId(viewId);
  if (viewSurface === INBOX_VIEW_SURFACE_INBOX) {
    inboxLastInboxViewId = viewId;
  } else if (viewSurface === INBOX_VIEW_SURFACE_GUEST) {
    inboxLastGuestViewId = viewId;
  }

  inboxFilter = 'all';
  if (typeof updateInboxFilterUI === 'function') updateInboxFilterUI();
  var rail = el('inbox-views-rail');
  if (rail){
    rail.querySelectorAll('.inbox-views-item').forEach(function(btn){
      var on = btn.getAttribute('data-inbox-view') === inboxSavedViewId;
      btn.classList.toggle('is-active', on);
      if (on) btn.setAttribute('aria-current', 'true');
      else btn.removeAttribute('aria-current');
    });
  }
  loadInbox(null, { silent: false, preserveDetail: false });
}

function renderInboxSavedViewLoadMore(){
  var list = el('conv-list');
  if (!list) return;
  list.querySelectorAll('.inbox-views-load-more').forEach(function(node){ node.remove(); });
  if (!inboxSavedViewHasMore || !inboxSavedViewNextCursor) return;
  var wrap = document.createElement('div');
  wrap.className = 'inbox-views-load-more';
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'inbox-views-load-more-btn';
  btn.textContent = inboxSavedViewLoadingMore ? 'Loading more…' : 'Load more';
  btn.disabled = !!inboxSavedViewLoadingMore;
  btn.addEventListener('click', function(){ loadInboxSavedViewNextPage(); });
  wrap.appendChild(btn);
  list.appendChild(wrap);
  wireInboxSavedViewInfiniteScroll();
}

var inboxSavedViewScrollWired = false;
var inboxSavedViewScrollHandler = null;

function wireInboxSavedViewInfiniteScroll(){
  var list = el('conv-list');
  if (!list || inboxSavedViewScrollWired) return;
  inboxSavedViewScrollWired = true;
  var scrollEl = list.closest('.inbox-conv-list-wrap') || list.parentElement || list;
  inboxSavedViewScrollHandler = function(){
    if (!inboxSavedViewHasMore || !inboxSavedViewNextCursor || inboxSavedViewLoadingMore) return;
    var remaining = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    if (remaining < 200) loadInboxSavedViewNextPage();
  };
  scrollEl.addEventListener('scroll', inboxSavedViewScrollHandler, { passive: true });
}

function resetInboxSavedViewInfiniteScroll(){
  inboxSavedViewScrollWired = false;
  inboxSavedViewScrollHandler = null;
}

function applyInboxSavedViewRows(rows, opts){
  var mapped = (rows || []).map(mapInboxPersonRowToConv);
  inboxConversationsCache = mergeSurfInboxConversations(mapped, getPortalProfile(getClient()));
  applyInboxFilter(opts || {});
  renderInboxSavedViewLoadMore();
  scheduleInboxSavedViewAutoLoad();
}

var inboxSavedViewAutoLoadScheduled = false;

function scheduleInboxSavedViewAutoLoad(){
  if (inboxSavedViewAutoLoadScheduled) return;
  if (!inboxSavedViewHasMore || !inboxSavedViewNextCursor || inboxSavedViewLoadingMore) return;
  inboxSavedViewAutoLoadScheduled = true;
  setTimeout(function(){
    inboxSavedViewAutoLoadScheduled = false;
    checkInboxSavedViewAutoLoad();
  }, 50);
}

function checkInboxSavedViewAutoLoad(){
  if (!inboxSavedViewHasMore || !inboxSavedViewNextCursor || inboxSavedViewLoadingMore) return;
  var list = el('conv-list');
  if (!list) return;
  var scrollEl = list.closest('.inbox-conv-list-wrap') || list.parentElement || list;
  var remaining = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
  if (remaining < 200) loadInboxSavedViewNextPage();
}

function updateInboxSavedViewPagination(data, append){
  var rows = (data && data.rows) || [];
  inboxSavedViewRows = append ? inboxSavedViewRows.concat(rows) : rows.slice();
  if (append) inboxSavedViewExpanded = true;
  inboxSavedViewHasMore = !!(data && data.has_more);
  inboxSavedViewNextCursor = (data && data.next_cursor) || null;
}

function loadInboxFromSavedView(selectConvIdAfterLoad, opts){
  opts = opts || {};
  var silent = !!opts.silent;
  var preserveDetail = !!opts.preserveDetail;
  var folderSwitchGen = Number(opts.folderSwitchGen) || 0;
  var keepConvId = selectConvIdAfterLoad || (preserveDetail ? selectedConvId : null);
  /* Cold refresh can restore the Guest column preset from localStorage before
   * any preset-click wrapper runs. Treat the preset as authoritative so the
   * first list fetch + rail render use People/all_people together before paint
   * (not Inbox/all + Guest chrome). */
  var presetSurface = inboxViewsSyncSurfaceFromPreset();
  if (presetSurface !== inboxCurrentSurface) {
    inboxCurrentSurface = presetSurface;
    inboxSavedViewId = presetSurface === INBOX_VIEW_SURFACE_GUEST
      ? (inboxLastGuestViewId || 'all_people')
      : (inboxLastInboxViewId || INBOX_DEFAULT_SAVED_VIEW);
  }
  var viewId = inboxSavedViewId || INBOX_DEFAULT_SAVED_VIEW;
  var gen = ++inboxViewsListGen;

  if (!silent){
    el('inbox-state').textContent = portalT('inbox.loading');
    el('inbox-state').classList.remove('error');
    el('inbox-state').style.display = 'block';
    if (el('conv-list')) el('conv-list').innerHTML = '';
    selectedConvId = null;
    el('detail-content').innerHTML = inboxEmptyDetailHtml();
    hideInboxMobileThread();
  }

  refreshInboxViewsRail();
  inboxSavedViewRows = [];
  inboxSavedViewHasMore = false;
  inboxSavedViewNextCursor = null;
  inboxSavedViewLoadingMore = false;
  inboxSavedViewExpanded = false;
  resetInboxSavedViewInfiniteScroll();
  renderInboxSavedViewLoadMore();

  return fetch(inboxSavedViewListUrl(viewId))
    .then(function(r){
      if (r.status === 401){
        el('inbox-state').innerHTML = '⚠ Authentication required &mdash; <strong>POST /staff/auth/login</strong> first.';
        el('inbox-state').classList.add('error');
        el('inbox-state').style.display = 'block';
        return null;
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data){
      if (gen !== inboxViewsListGen) return;
      if (!data) return;
      if (!data.success) throw new Error(data.error || 'API error');
      renderInboxSchoolContext(null);
      if (selectConvIdAfterLoad) selectedConvId = selectConvIdAfterLoad;
      else if (keepConvId) selectedConvId = keepConvId;
      updateInboxSavedViewPagination(data, false);
      applyInboxSavedViewRows(inboxSavedViewRows, {
        preserveDetail: !!(preserveDetail && !selectConvIdAfterLoad),
        selectedId: selectedConvId,
        folderSwitchGen: folderSwitchGen,
      });
      if (selectConvIdAfterLoad){
        var list = el('conv-list');
        var card = list && list.querySelector('.conv-card[data-id="' + selectConvIdAfterLoad + '"]');
        if (card){
          list.querySelectorAll('.conv-card').forEach(function(c){ c.classList.remove('selected'); });
          card.classList.add('selected');
        }
        loadConvDetail(selectConvIdAfterLoad);
      }
    })
    .catch(function(err){
      if (gen !== inboxViewsListGen) return;
      el('inbox-state').textContent = 'Error loading inbox: ' + err.message;
      el('inbox-state').classList.add('error');
      el('inbox-state').style.display = 'block';
    });
}


function inboxViewsMatchGuestRow(row, phone, customerId) {
  if (!row) return false;
  var preferredCustomerId = String(customerId || '').trim();
  if (preferredCustomerId && String(row.customer_id || '').trim() === preferredCustomerId) return true;
  var targetPhone = normalizeCustomerPhoneClient(phone) || String(phone || '').trim();
  if (!targetPhone) return false;
  var rowPhone = normalizeCustomerPhoneClient(row.phone) || normalizeCustomerPhoneClient(row.durable_phone) || String(row.phone || row.durable_phone || '').trim();
  return !!rowPhone && rowPhone === targetPhone;
}

function inboxViewsFindGuestRow(rows, phone, customerId) {
  rows = Array.isArray(rows) ? rows : [];
  for (var i = 0; i < rows.length; i += 1) {
    if (inboxViewsMatchGuestRow(rows[i], phone, customerId)) return rows[i];
  }
  return null;
}

function inboxViewsOpenGuestByPhone(phone, opts) {
  opts = opts || {};
  var preferredCustomerId = String(opts.customer_id || opts.customerId || '').trim();
  var targetPhone = normalizeCustomerPhoneClient(phone) || String(phone || '').trim();
  if (!targetPhone && !preferredCustomerId) return Promise.resolve(false);
  try { if (typeof inboxColumnsSetPreset === 'function') inboxColumnsSetPreset('guest'); } catch (_preset) {}
  inboxCurrentSurface = INBOX_VIEW_SURFACE_GUEST;
  inboxSavedViewId = 'all_people';
  inboxLastGuestViewId = 'all_people';
  refreshInboxViewsRail();
  var q = targetPhone || preferredCustomerId;
  var url = '/staff/inbox/list?client=' + encodeURIComponent(getClient()) +
    '&view=all_people&limit=99&q=' + encodeURIComponent(q || '');
  if (getClient() === 'sunset') url += '&location=' + encodeURIComponent(getSunsetLocation());
  var gen = ++inboxViewsListGen;
  var state = el('inbox-state');
  if (state) {
    state.textContent = 'Loading guest…';
    state.classList.remove('error');
    state.style.display = 'block';
  }
  return fetch(url)
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data){
      if (gen !== inboxViewsListGen) return false;
      if (!data || !data.success) throw new Error((data && data.error) || 'API error');
      renderInboxSchoolContext(null);
      updateInboxSavedViewPagination(data, false);
      var match = inboxViewsFindGuestRow(inboxSavedViewRows, targetPhone, preferredCustomerId);
      if (!match && !preferredCustomerId && targetPhone && Array.isArray(inboxSavedViewRows) && inboxSavedViewRows.length === 1) {
        match = inboxSavedViewRows[0];
      }
      var selectedKey = match ? match.key : null;
      applyInboxSavedViewRows(inboxSavedViewRows, { preserveDetail: false, selectedId: selectedKey });
      if (state) state.style.display = 'none';
      if (!match) {
        var detail = el('detail-content');
        if (detail) {
          detail.innerHTML = '<div class="inbox-empty-right"><p class="main-msg">Guest not found in People</p><p class="sub-msg">Try All people search in Guest mode.</p></div>';
        }
        return false;
      }
      var key = match.key || match._inbox_view_key || match.conversation_id;
      if (key) selectedConvId = key;
      // Bookings guest-name clicks are a People-card action, not a thread-open action.
      // Even when the People row has a conversation_id, keep the right pane on
      // inboxCustomerFullHtml; Start/Open conversation on the card is the only
      // path that may load a message thread.
      inboxViewsOpenGuestCustomerCard(match, el('detail-content'));
      return true;
    })
    .catch(function(err){
      if (state) {
        state.textContent = 'Error loading guest: ' + err.message;
        state.classList.add('error');
        state.style.display = 'block';
      }
      return false;
    });
}

function loadInboxSavedViewNextPage(){
  if (inboxSavedViewLoadingMore || !inboxSavedViewHasMore || !inboxSavedViewNextCursor) return Promise.resolve();
  var viewId = inboxSavedViewId || INBOX_DEFAULT_SAVED_VIEW;
  var cursor = inboxSavedViewNextCursor;
  var gen = inboxViewsListGen;
  inboxSavedViewLoadingMore = true;
  renderInboxSavedViewLoadMore();
  return fetch(inboxSavedViewListUrl(viewId, cursor))
    .then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data){
      if (gen !== inboxViewsListGen) return;
      if (!data || !data.success) throw new Error((data && data.error) || 'API error');
      updateInboxSavedViewPagination(data, true);
      applyInboxSavedViewRows(inboxSavedViewRows, { preserveDetail: true, selectedId: selectedConvId });
    })
    .catch(function(err){
      if (gen !== inboxViewsListGen) return;
      var state = el('inbox-state');
      if (state){
        state.textContent = 'Error loading more people: ' + err.message;
        state.classList.add('error');
        state.style.display = 'block';
      }
    })
    .then(function(){
      if (gen !== inboxViewsListGen) return;
      inboxSavedViewLoadingMore = false;
      renderInboxSavedViewLoadMore();
    });
}

function pollInboxSavedViewListLive(){
  if (!inboxLivePollActive || !isInboxTabVisible()) return;
  if (inboxListPollInFlight) return;
  if (inboxSavedViewExpanded){
    refreshInboxViewsRail();
    setInboxLiveStatus('live', 'Live');
    return;
  }
  inboxListPollInFlight = true;
  var keepConvId = selectedConvId;
  var viewId = inboxSavedViewId || INBOX_DEFAULT_SAVED_VIEW;
  var gen = ++inboxViewsListGen;
  refreshInboxViewsRail();
  fetch(inboxSavedViewListUrl(viewId))
    .then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data){
      if (gen !== inboxViewsListGen) return;
      if (!data || !data.success) throw new Error((data && data.error) || 'API error');
      renderInboxSchoolContext(null);
      if (keepConvId) selectedConvId = keepConvId;
      updateInboxSavedViewPagination(data, false);
      applyInboxSavedViewRows(inboxSavedViewRows, { preserveDetail: true, selectedId: selectedConvId });
      setInboxLiveStatus('live', 'Live');
    })
    .catch(function(){
      setInboxLiveStatus('error', 'Update failed');
      setTimeout(function(){ if (inboxLivePollActive) setInboxLiveStatus('reconnect', 'Reconnecting'); }, 1200);
    })
    .then(function(){ inboxListPollInFlight = false; });
}

var _inboxViewsLegacyLoadInbox = loadInbox;
loadInbox = function(selectConvIdAfterLoad, opts){
  if (!el('inbox-views-rail')) return _inboxViewsLegacyLoadInbox(selectConvIdAfterLoad, opts);
  return loadInboxFromSavedView(selectConvIdAfterLoad, opts);
};

var _inboxViewsLegacyPollList = pollInboxConversationListLive;
pollInboxConversationListLive = function(){
  if (!el('inbox-views-rail')) return _inboxViewsLegacyPollList();
  return pollInboxSavedViewListLive();
};

var _inboxViewsLegacyLoadConvDetail = loadConvDetail;
loadConvDetail = function(convId, targetEl) {
  if (!el('inbox-views-rail')) return _inboxViewsLegacyLoadConvDetail(convId, targetEl);
  return inboxViewsResolveLoadConvDetail(convId, targetEl);
};

/**
 * INBOX-GUEST-SIDEBAR-SPLIT-001: Switch the rail surface and restore the last
 * valid view for that surface. Called by inbox-rows.js when the preset changes.
 *
 * @param {string} surface - 'inbox' or 'guest'
 */
function inboxViewsSwitchSurface(surface) {
  var newSurface = surface === INBOX_VIEW_SURFACE_GUEST
    ? INBOX_VIEW_SURFACE_GUEST
    : INBOX_VIEW_SURFACE_INBOX;

  if (newSurface === inboxCurrentSurface) {
    /* Same surface — just re-render with the correct order. */
    refreshInboxViewsRail();
    return;
  }

  inboxCurrentSurface = newSurface;

  /* Restore the last selected view for this surface. */
  var restoreViewId = newSurface === INBOX_VIEW_SURFACE_GUEST
    ? inboxLastGuestViewId
    : inboxLastInboxViewId;

  /* Validate the restore view is still in the surface order. */
  var surfaceOrder = inboxViewGetSurfaceOrder(newSurface);
  if (surfaceOrder.indexOf(restoreViewId) < 0) {
    restoreViewId = inboxViewGetDefaultViewForSurface(newSurface);
  }

  inboxSavedViewId = restoreViewId;
  refreshInboxViewsRail();
  var folderSwitchGen = 0;
  if (typeof window !== 'undefined' && window.__inboxRows && window.__inboxRows.folderSwitchToken) {
    folderSwitchGen = Number(window.__inboxRows.folderSwitchToken()) || 0;
  }
  loadInbox(null, {
    silent: false,
    preserveDetail: true,
    folderSwitchGen: folderSwitchGen,
  });
}

/**
 * INBOX-GUEST-SIDEBAR-SPLIT-001: Get the current surface state.
 */
function inboxViewsGetCurrentSurface() {
  return inboxCurrentSurface || INBOX_VIEW_SURFACE_INBOX;
}

if (typeof window !== 'undefined') {
  window.__inboxViews = window.__inboxViews || {};
  window.__inboxViews.switchSurface = inboxViewsSwitchSurface;
  window.__inboxViews.getCurrentSurface = inboxViewsGetCurrentSurface;
  window.__inboxViews.SURFACE_INBOX = INBOX_VIEW_SURFACE_INBOX;
  window.__inboxViews.SURFACE_GUEST = INBOX_VIEW_SURFACE_GUEST;
  window.__inboxViews.getSurfaceForViewId = inboxViewGetSurfaceForViewId;
  window.__inboxViews.getDefaultViewForSurface = inboxViewGetDefaultViewForSurface;
  window.__inboxViews.openGuestByPhone = inboxViewsOpenGuestByPhone;
}

wireInboxViewsRail();
