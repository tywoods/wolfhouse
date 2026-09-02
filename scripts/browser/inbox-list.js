/**
 * Staff Portal Inbox, Conversations tab: conversation list filtering, the live
 * list/thread refresh (SSE in inbox-stream.js, with these poll timers as
 * fallback), and thread message bubble rendering.
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
    list = list.filter(conversationNeedsHuman);
  } else if (inboxFilter === 'email'){
    list = list.filter(function(c){ return c.channel === 'email'; });
  } else if (inboxFilter === 'whatsapp'){
    list = list.filter(function(c){ return (c.channel || 'whatsapp') === 'whatsapp'; });
  }
  var qEl = typeof el === 'function' ? el('inbox-conv-search') : null;
  var q = qEl && qEl.value ? String(qEl.value).trim().toLowerCase() : '';
  if (q) {
    list = list.filter(function(c){
      var hay = [
        c && c.guest_name,
        c && c.phone,
        c && c.guest_email,
        c && c.email,
        c && c.last_message_preview,
        c && c.booking_code,
      ].join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
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

function stopInboxPollTimers(){
  if (inboxListPollTimer) { clearInterval(inboxListPollTimer); inboxListPollTimer = null; }
  if (inboxThreadPollTimer) { clearInterval(inboxThreadPollTimer); inboxThreadPollTimer = null; }
}

function startInboxPollTimers(){
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

function stopInboxLivePolling(){
  inboxLivePollActive = false;
  stopInboxPollTimers();
}

function startInboxLivePolling(){
  if (!isInboxTabVisible()) {
    stopInboxLivePolling();
    return;
  }
  if (inboxLivePollActive) return;
  inboxLivePollActive = true;
  setInboxLiveStatus('live', 'Live');
  startInboxPollTimers();
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
function inboxThreadDayKey(ts){
  if (!ts) return '';
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1) + '-' + String(d.getDate());
}

function inboxThreadDayLabel(ts){
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  var now = new Date();
  var today = now.getFullYear() + '-' + String(now.getMonth() + 1) + '-' + String(now.getDate());
  var y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  var yesterday = y.getFullYear() + '-' + String(y.getMonth() + 1) + '-' + String(y.getDate());
  var key = inboxThreadDayKey(ts);
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  try {
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (_e) {
    return key;
  }
}

function renderInboxThreadMessagesHtml(msgs){
  var html = '';
  if (!msgs || !msgs.length){
    return '<div class="thread-empty">' + escHtml(t('inbox.detail.thread.empty')) + '</div>';
  }
  var lastDay = '';
  msgs.forEach(function(m){
    var day = inboxThreadDayKey(m.created_at);
    if (day && day !== lastDay) {
      lastDay = day;
      html += '<div class="inbox-thread-day" role="separator">' + escHtml(inboxThreadDayLabel(m.created_at)) + '</div>';
    }
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
  var wrap = (typeof inboxThreadScrollEl === 'function' ? inboxThreadScrollEl() : null)
    || el('thread-container') || container;
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
      var detailEl = (typeof el === 'function' ? el('detail-content') : null) || document.getElementById('detail-content');
      if (sig === inboxThreadMessageSig) {
        setInboxLiveStatus('live', 'Live');
        if (typeof loadInboxWhatsAppDraft === 'function' && detailEl) {
          loadInboxWhatsAppDraft(convId, detailEl);
        }
        return;
      }
      inboxThreadMessageSig = sig;
      var selected = null;
      try {
        selected = (inboxConversationsCache || []).find(function(c){ return String(c.conversation_id) === String(convId); });
      } catch (_e) { selected = null; }
      if (selected && typeof inboxFillComposerThread === 'function') {
        inboxFillComposerThread(selected, msgs);
      } else {
        container.innerHTML = renderInboxThreadMessagesHtml(msgs);
      }
      if (wrap) {
        if (stickToBottom) wrap.scrollTop = wrap.scrollHeight;
        else wrap.scrollTop = prevScrollTop;
      }
      setInboxLiveStatus('live', 'Live');
      if (typeof loadInboxWhatsAppDraft === 'function' && detailEl) {
        loadInboxWhatsAppDraft(convId, detailEl);
      }
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
  wireInboxConvSearch();
  renderInbox(filterInboxConversations(inboxConversationsCache || []), opts);
}

function wireInboxConvSearch(){
  var input = typeof el === 'function' ? el('inbox-conv-search') : null;
  if (!input || input.dataset.inboxSearchWired === '1') return;
  input.dataset.inboxSearchWired = '1';
  input.addEventListener('input', function(){
    applyInboxFilter({ preserveDetail: true, selectedId: typeof selectedConvId !== 'undefined' ? selectedConvId : null });
  });
}
