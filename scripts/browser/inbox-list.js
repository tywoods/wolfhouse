/**
 * Staff Portal Inbox, Conversations tab: conversation list filtering, the live polling
 * loop for the list and the selected thread, and thread message bubble rendering.
 *
 * Injected into /staff/ui at the inbox-list marker. Fragment spliced into the portal
 * IIFE, so it is already in strict mode and relies on siblings in that scope
 * (el, escHtml, portalT, inboxClientQuery, selectedConvId, inboxFilter).
 */

function isInactiveInboxBookingStatus(status){
  var s = String(status || '').toLowerCase();
  return s === 'cancelled' || s === 'canceled' || s === 'expired';
}

function filterActiveInboxBookings(rows){
  return (rows || []).filter(function(b){ return !isInactiveInboxBookingStatus(b.booking_status); });
}

function sanitizeConversationContextForInbox(row){
  if (!row || !isInactiveInboxBookingStatus(row.booking_status)) return row;
  return Object.assign({}, row, {
    booking_id: null,
    booking_code: null,
    booking_status: null,
    booking_payment_status: null,
    check_in: null,
    check_out: null,
    guest_count: null,
    package_code: null,
    assigned_room_code: null,
    assigned_bed_code: null,
  });
}

function conversationHasOpenHandoff(conv){
  if (!conv) return false;
  var st = String(conv.handoff_status || '').toLowerCase();
  if (st === 'open' || st === 'assigned' || st === 'waiting_guest') return true;
  return !!(conv.handoff_reason && conv.needs_human);
}

function filterInboxConversations(convs){
  var list = convs || [];
  if (inboxFilter === 'needs-human'){
    return list.filter(conversationNeedsHuman);
  }
  if (inboxFilter === 'email'){
    return list.filter(function(c){ return c.channel === 'email'; });
  }
  if (inboxFilter === 'whatsapp'){
    return list.filter(function(c){ return (c.channel || 'whatsapp') === 'whatsapp'; });
  }
  return list;
}

function updateInboxFilterUI(){
  document.querySelectorAll('.inbox-filter-btn').forEach(function(btn){
    btn.classList.toggle('active', btn.dataset.inboxFilter === inboxFilter);
  });
}

function ensureInboxLoadedForTab(opts){
  if (inboxConversationsCache != null) applyInboxFilter(opts || {});
  else loadInbox(null, opts || {});
  startInboxLivePolling();
}

function refreshInboxIfConversationsTabActive(){
  var panel = el('tab-conversations');
  if (panel && panel.classList.contains('active')) {
    loadInbox(null, { silent: !!inboxConversationsCache, preserveDetail: true });
    startInboxLivePolling();
  } else {
    stopInboxLivePolling();
  }
}

var INBOX_LIST_POLL_MS = 5000;
var INBOX_THREAD_POLL_MS = 3000;
var inboxListPollTimer = null;
var inboxThreadPollTimer = null;
var inboxListPollInFlight = false;
var inboxThreadPollInFlight = false;
var inboxLivePollActive = false;
var inboxThreadMessageSig = null;

function setInboxLiveStatus(kind, label){
  var node = el('inbox-live-status');
  if (!node) return;
  node.textContent = label || 'Live';
  node.classList.remove('is-live', 'is-reconnect', 'is-error');
  if (kind === 'error') node.classList.add('is-error');
  else if (kind === 'reconnect') node.classList.add('is-reconnect');
  else node.classList.add('is-live');
}

function isInboxTabVisible(){
  var panel = el('tab-conversations');
  return !!(panel && panel.classList.contains('active'));
}

function stopInboxLivePolling(){
  inboxLivePollActive = false;
  if (inboxListPollTimer) { clearInterval(inboxListPollTimer); inboxListPollTimer = null; }
  if (inboxThreadPollTimer) { clearInterval(inboxThreadPollTimer); inboxThreadPollTimer = null; }
}

function startInboxLivePolling(){
  if (!isInboxTabVisible()) {
    stopInboxLivePolling();
    return;
  }
  if (inboxLivePollActive) return;
  inboxLivePollActive = true;
  setInboxLiveStatus('live', 'Live');
  if (!inboxListPollTimer) {
    inboxListPollTimer = setInterval(function(){
      pollInboxConversationListLive();
    }, INBOX_LIST_POLL_MS);
  }
  if (!inboxThreadPollTimer) {
    inboxThreadPollTimer = setInterval(function(){
      pollInboxSelectedThreadLive();
    }, INBOX_THREAD_POLL_MS);
  }
}

function pollInboxConversationListLive(){
  if (!inboxLivePollActive || !isInboxTabVisible()) return;
  if (inboxListPollInFlight) return;
  inboxListPollInFlight = true;
  var keepConvId = selectedConvId;
  fetch('/staff/conversations' + inboxClientQuery())
    .then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data){
      if (!data || !data.success) throw new Error((data && data.error) || 'API error');
      renderInboxSchoolContext(data.channel_config || null);
      inboxConversationsCache = mergeSurfInboxConversations(data.conversations || [], getPortalProfile(getClient()));
      var nhCount = inboxConversationsCache.filter(conversationNeedsHuman).length;
      var badge = el('hq-badge');
      if (badge){ badge.textContent = nhCount; badge.classList.toggle('visible', nhCount > 0); }
      if (keepConvId) selectedConvId = keepConvId;
      applyInboxFilter({ preserveDetail: true, selectedId: selectedConvId });
      setInboxLiveStatus('live', 'Live');
    })
    .catch(function(){
      setInboxLiveStatus('error', 'Update failed');
      setTimeout(function(){ if (inboxLivePollActive) setInboxLiveStatus('reconnect', 'Reconnecting'); }, 1200);
    })
    .then(function(){ inboxListPollInFlight = false; });
}

function threadMessagesFingerprint(msgs){
  return (msgs || []).map(function(m){
    return String(m.message_id || '') + ':' + String(m.direction || '') + ':' + String(m.created_at || '') + ':' + String((m.message_text || '').length);
  }).join('|');
}

function isThreadNearBottom(scrollEl){
  if (!scrollEl) return true;
  var remaining = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
  return remaining < 80;
}

/** Email thread body ownership: prefer body_text when present; else message_text. */
function inboxThreadMessageBodyText(m){
  if (!m) return '';
  if (Object.prototype.hasOwnProperty.call(m, 'body_text') && m.body_text != null) return String(m.body_text);
  return String(m.message_text || '');
}
function inboxThreadMessageSubjectText(m){
  if (!m) return '';
  if (m.email_subject != null && String(m.email_subject).length) return String(m.email_subject);
  if (m.subject != null && String(m.subject).length) return String(m.subject);
  return '';
}
function formatInboxThreadBubbleHtml(m){
  var subject = inboxThreadMessageSubjectText(m);
  var body = inboxThreadMessageBodyText(m);
  // Distinct subject + body: retain subject chrome and render truthful body.
  if (subject && body && subject !== body) {
    return '<div class="msg-email-subject">' + escHtml(subject) + '</div>' + formatThreadMessageHtml(body);
  }
  // Subject-only inbound (bridge stores subject in message_text; body empty):
  // show subject once — never a blank body content area.
  if (subject && (!body || subject === body)) {
    return '<div class="msg-email-subject">' + escHtml(subject) + '</div>';
  }
  return formatThreadMessageHtml(body || '');
}
function renderInboxThreadMessagesHtml(msgs){
  var html = '';
  if (!msgs || !msgs.length){
    return '<div class="thread-empty">' + escHtml(t('inbox.detail.thread.empty')) + '</div>';
  }
  msgs.forEach(function(m){
    var dir = (m.direction === 'inbound') ? 'inbound' : 'outbound';
    var sender = dir === 'inbound' ? 'Guest' : (m.source === 'staff_inbox_reply' || m.source === 'staff_email_reply' ? 'Staff' : (m.source || 'Luna'));
    var msgClass = 'msg ' + dir;
    if (dir === 'outbound') {
      msgClass += (m.source === 'staff_inbox_reply' || m.source === 'staff_email_reply') ? ' msg-staff' : ' msg-luna';
    }
    // Map hermes reply source to a short guest-facing sender label.
    if (dir === 'outbound' && m.source === 'hermes_luna_whatsapp_reply') sender = 'Luna';
    html += '<div class="' + msgClass + '">';
    html +=   '<div class="msg-bubble">' + formatInboxThreadBubbleHtml(m) + '</div>';
    html +=   '<div class="msg-meta">' + escHtml(sender) + ' &bull; ' + escHtml(fmtTs(m.created_at));
    html +=   '</div>';
    html += '</div>';
  });
  return html;
}

function pollInboxSelectedThreadLive(){
  if (!inboxLivePollActive || !isInboxTabVisible()) return;
  if (!selectedConvId || isSurfInboxDemoThread(selectedConvId)) return;
  if (inboxThreadPollInFlight) return;
  var convId = selectedConvId;
  var container = el('thread-container');
  if (!container) return;
  inboxThreadPollInFlight = true;
  var wrap = el('inbox-thread-wrap') || container;
  var stickToBottom = isThreadNearBottom(wrap);
  var prevScrollTop = wrap ? wrap.scrollTop : 0;
  fetch('/staff/conversations/' + encodeURIComponent(convId) + '/messages' + inboxClientQuery())
    .then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data){
      if (!data || !data.success) throw new Error((data && data.error) || 'API error');
      if (selectedConvId !== convId) return;
      var msgs = data.messages || [];
      var sig = threadMessagesFingerprint(msgs);
      if (sig === inboxThreadMessageSig) {
        setInboxLiveStatus('live', 'Live');
        return;
      }
      inboxThreadMessageSig = sig;
      container.innerHTML = renderInboxThreadMessagesHtml(msgs);
      if (wrap) {
        if (stickToBottom) wrap.scrollTop = wrap.scrollHeight;
        else wrap.scrollTop = prevScrollTop;
      }
      setInboxLiveStatus('live', 'Live');
    })
    .catch(function(){
      setInboxLiveStatus('error', 'Update failed');
      setTimeout(function(){ if (inboxLivePollActive) setInboxLiveStatus('reconnect', 'Reconnecting'); }, 1200);
    })
    .then(function(){ inboxThreadPollInFlight = false; });
}

function setInboxFilter(mode){
  var allowed = ['all', 'email', 'whatsapp', 'needs-human'];
  inboxFilter = allowed.indexOf(mode) >= 0 ? mode : 'all';
  updateInboxFilterUI();
  if (inboxConversationsCache) applyInboxFilter();
  else loadInbox();
}

function applyInboxFilter(opts){
  renderInbox(filterInboxConversations(inboxConversationsCache || []), opts);
}
