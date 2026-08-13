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
    if (list[i] && list[i].id === groupId) return list[i].label || groupId;
  }
  return groupId;
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
      html += '<span class="inbox-views-item-label">' + escHtml(view.label || view.id) + '</span>';
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
    el('inbox-state').textContent = 'Loading conversations…';
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
