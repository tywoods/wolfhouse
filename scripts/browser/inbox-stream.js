/**
 * Staff Portal Inbox: live activity via GET /staff/inbox/stream (SSE).
 *
 * Injected after inbox-list.js so it can wrap startInboxLivePolling without
 * rewriting the poll functions. On conversation-updated the existing list and
 * selected-thread fetchers run once. If EventSource is missing or the stream
 * errors, the 5s/3s poll timers stay as fallback. EventSource is closed on
 * error so it cannot auto-reconnect in a loop.
 *
 * Fragment spliced into the portal IIFE (strict mode, sibling scope).
 */

var inboxEventSource = null;
var inboxStreamFailed = false;
var inboxStreamRefetchTimer = null;
var INBOX_STREAM_REFETCH_DEBOUNCE_MS = 50;

function inboxStreamUrl(){
  return '/staff/inbox/stream' + inboxClientQuery();
}

function stopInboxEventSource(){
  if (inboxStreamRefetchTimer) {
    clearTimeout(inboxStreamRefetchTimer);
    inboxStreamRefetchTimer = null;
  }
  if (inboxEventSource) {
    try { inboxEventSource.close(); } catch (_err) {}
    inboxEventSource = null;
  }
}

function scheduleInboxStreamRefetch(conversationId){
  if (inboxStreamRefetchTimer) clearTimeout(inboxStreamRefetchTimer);
  inboxStreamRefetchTimer = setTimeout(function(){
    inboxStreamRefetchTimer = null;
    pollInboxConversationListLive();
    if (!conversationId || conversationId === selectedConvId) {
      pollInboxSelectedThreadLive();
    }
  }, INBOX_STREAM_REFETCH_DEBOUNCE_MS);
}

function onInboxStreamConversationUpdated(ev){
  var payload = {};
  try { payload = JSON.parse(ev && ev.data ? ev.data : '{}'); } catch (_err) { payload = {}; }
  setInboxLiveStatus('live', 'Live');
  scheduleInboxStreamRefetch(payload.conversation_id || '');
}

function onInboxStreamHeartbeat(){
  setInboxLiveStatus('live', 'Live');
}

function fallbackInboxLiveToPolling(){
  stopInboxEventSource();
  inboxStreamFailed = true;
  if (!inboxLivePollActive || !isInboxTabVisible()) return;
  setInboxLiveStatus('reconnect', 'Reconnecting');
  startInboxPollTimers();
}

function startInboxEventSource(){
  if (typeof EventSource !== 'function') return false;
  stopInboxEventSource();
  try {
    inboxEventSource = new EventSource(inboxStreamUrl());
  } catch (_err) {
    inboxEventSource = null;
    return false;
  }
  inboxEventSource.addEventListener('conversation-updated', onInboxStreamConversationUpdated);
  inboxEventSource.addEventListener('heartbeat', onInboxStreamHeartbeat);
  inboxEventSource.onopen = function(){
    setInboxLiveStatus('live', 'Live');
    stopInboxPollTimers();
  };
  inboxEventSource.onerror = function(){
    fallbackInboxLiveToPolling();
  };
  return true;
}

var _inboxStreamLegacyStart = startInboxLivePolling;
var _inboxStreamLegacyStop = stopInboxLivePolling;

startInboxLivePolling = function(){
  if (!isInboxTabVisible()) {
    stopInboxLivePolling();
    return;
  }
  if (inboxLivePollActive) return;
  if (!inboxStreamFailed && startInboxEventSource()) {
    inboxLivePollActive = true;
    setInboxLiveStatus('reconnect', 'Connecting');
    return;
  }
  return _inboxStreamLegacyStart();
};

stopInboxLivePolling = function(){
  stopInboxEventSource();
  inboxStreamFailed = false;
  return _inboxStreamLegacyStop();
};
