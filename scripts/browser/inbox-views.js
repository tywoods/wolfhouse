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

function inboxSavedViewsUrl(){
  return '/staff/inbox/views' + inboxClientQuery();
}

function inboxSavedViewListUrl(viewId){
  return '/staff/inbox/list' + inboxClientQuery() + '&view=' + encodeURIComponent(viewId || inboxSavedViewId || INBOX_DEFAULT_SAVED_VIEW);
}

function mapInboxPersonRowToConv(row){
  row = row || {};
  return {
    conversation_id: row.conversation_id || '',
    guest_name: row.display_name || row.guest_name || '',
    phone: row.phone || '',
    guest_email: row.email || row.guest_email || '',
    email: row.email || '',
    channel: row.channel || 'whatsapp',
    last_message_preview: row.last_message_preview || '',
    last_activity: row.last_activity || null,
    last_activity_label: row.last_activity_label || fmtTs(row.last_activity),
    needs_human: !!row.needs_human,
    needs_attention: !!row.needs_attention,
    handoff_reason: row.handoff_reason || null,
    handoff_priority: row.handoff_priority || null,
    handoff_status: row.handoff_status || null,
    luna_paused: !!row.luna_paused,
    booking_code: row.booking_code || null,
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
  whatsapp: 'chat',
  email: 'envelope',
  all_people: 'people',
  unassigned: 'people',
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
    rail.innerHTML = '<div class="inbox-views-empty">No views</div>';
    return;
  }
  var known = {};
  var order = [];
  for (var g = 0; g < groups.length; g++){
    if (groups[g] && groups[g].id && !known[groups[g].id]){
      known[groups[g].id] = true;
      order.push(groups[g].id);
    }
  }
  for (var v = 0; v < views.length; v++){
    var gid = views[v] && views[v].group;
    if (gid && !known[gid]){
      known[gid] = true;
      order.push(gid);
    }
  }
  if (views.every(function(view){ return view.id !== inboxSavedViewId; })){
    inboxSavedViewId = (views[0] && views[0].id) || INBOX_DEFAULT_SAVED_VIEW;
  }
  var html = '';
  for (var i = 0; i < order.length; i++){
    var groupId = order[i];
    var items = views.filter(function(view){ return view.group === groupId; });
    if (!items.length) continue;
    html += '<div class="inbox-views-group" data-inbox-view-group="' + escHtml(groupId) + '">';
    html += '<div class="inbox-views-group-label">' + escHtml(inboxViewsGroupLabel(groups, groupId)) + '</div>';
    for (var j = 0; j < items.length; j++){
      var view = items[j];
      var active = view.id === inboxSavedViewId;
      var countHtml = (view.count == null)
        ? ''
        : '<span class="inbox-views-item-count">' + escHtml(String(view.count)) + '</span>';
      html += '<button type="button" class="inbox-views-item' + (active ? ' is-active' : '') + '"' +
        ' data-inbox-view="' + escHtml(view.id) + '"' +
        (active ? ' aria-current="true"' : '') +
        '>';
      html += inboxViewsItemIconHtml(view.id);
      html += '<span class="inbox-views-item-label">' + escHtml(inboxViewsLabel(view)) + '</span>';
      html += countHtml;
      html += '</button>';
    }
    html += '</div>';
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
      if (!rail.innerHTML) rail.innerHTML = '<div class="inbox-views-empty">Couldn’t load views</div>';
    });
}

function selectInboxSavedView(viewId){
  inboxSavedViewId = viewId || INBOX_DEFAULT_SAVED_VIEW;
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

function applyInboxSavedViewRows(rows, opts){
  var mapped = (rows || []).map(mapInboxPersonRowToConv);
  inboxConversationsCache = mergeSurfInboxConversations(mapped, getPortalProfile(getClient()));
  applyInboxFilter(opts || {});
}

function loadInboxFromSavedView(selectConvIdAfterLoad, opts){
  opts = opts || {};
  var silent = !!opts.silent;
  var preserveDetail = !!opts.preserveDetail;
  var keepConvId = selectConvIdAfterLoad || (preserveDetail ? selectedConvId : null);
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

  fetch(inboxSavedViewListUrl(viewId))
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
      applyInboxSavedViewRows(data.rows || [], {
        preserveDetail: !!(preserveDetail && !selectConvIdAfterLoad),
        selectedId: selectedConvId,
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

function pollInboxSavedViewListLive(){
  if (!inboxLivePollActive || !isInboxTabVisible()) return;
  if (inboxListPollInFlight) return;
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
      applyInboxSavedViewRows(data.rows || [], { preserveDetail: true, selectedId: selectedConvId });
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

wireInboxViewsRail();
