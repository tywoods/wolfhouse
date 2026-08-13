/**
 * Staff Portal Inbox — Phase 4 email broadcast composer.
 *
 * Opens from a PEOPLE saved view (multi_select). Creates a draft via
 * POST /staff/broadcasts, then Send POSTs /staff/broadcasts/:id/send.
 * Send is expected to snapshot recipients and return 501
 * email_broadcast_send_not_implemented — the UI shows that honestly
 * ("queued locally, email delivery not wired yet") and never claims mail
 * went out. Email only: no WhatsApp channel picker.
 *
 * Injected after inbox-views so it can wrap renderInboxViewsRail /
 * selectInboxSavedView. Overlay sits on columns 3–4 without flipping
 * data-col* (four-column layout, Luna control, WhatsApp draft, SSE stay).
 */

var INBOX_BROADCAST_SUBJECT_MAX = 200;
var INBOX_BROADCAST_BODY_MIN = 5;
var INBOX_BROADCAST_BODY_MAX = 20000;
var INBOX_BROADCAST_SEND_NOT_IMPLEMENTED = 'email_broadcast_send_not_implemented';
var INBOX_BROADCAST_QUEUED_COPY = 'queued locally, email delivery not wired yet';

var inboxBroadcastViewsCache = [];
var inboxBroadcastState = {
  viewId: '',
  viewLabel: '',
  viewCount: null,
  broadcastId: null,
  inFlight: false,
  sendFinished: false,
};

function inboxBroadcastCreateUrl(){
  return '/staff/broadcasts' + inboxClientQuery();
}

function inboxBroadcastGetUrl(broadcastId){
  return '/staff/broadcasts/' + encodeURIComponent(broadcastId) + inboxClientQuery();
}

function inboxBroadcastSendUrl(broadcastId){
  return '/staff/broadcasts/' + encodeURIComponent(broadcastId) + '/send' + inboxClientQuery();
}

function inboxBroadcastViewById(viewId){
  var id = String(viewId || '');
  var list = inboxBroadcastViewsCache || [];
  for (var i = 0; i < list.length; i++){
    if (list[i] && list[i].id === id) return list[i];
  }
  return null;
}

function inboxBroadcastIsEmailableView(view){
  return !!(view && view.multi_select === true && view.group === 'people');
}

function inboxBroadcastActiveEmailableView(){
  var view = inboxBroadcastViewById(typeof inboxSavedViewId === 'string' ? inboxSavedViewId : '');
  return inboxBroadcastIsEmailableView(view) ? view : null;
}

function inboxBroadcastParseFetchJson(r){
  return r.text().then(function(raw){
    try {
      return { status: r.status, data: (raw == null || raw === '') ? null : JSON.parse(raw), parseOk: true };
    } catch (_e) { return { status: r.status, data: null, parseOk: false }; }
  });
}

function inboxBroadcastErrorCode(data){
  try {
    if (!data || typeof data !== 'object') return '';
    return typeof data.error === 'string' ? data.error : '';
  } catch (_e) { return ''; }
}

function inboxBroadcastSendFailureCopy(status, errorCode, summary){
  var code = String(errorCode || '');
  if (status === 501 || code === INBOX_BROADCAST_SEND_NOT_IMPLEMENTED) {
    var pending = summary && summary.pending != null ? Number(summary.pending) : null;
    var skipped = summary && summary.skipped != null ? Number(summary.skipped) : null;
    var msg = INBOX_BROADCAST_QUEUED_COPY;
    if (pending != null && !isNaN(pending)) {
      msg += ' — ' + String(pending) + (pending === 1 ? ' recipient' : ' recipients') + ' pending';
    }
    if (skipped != null && !isNaN(skipped) && skipped > 0) {
      msg += ', ' + String(skipped) + ' skipped';
    }
    return msg;
  }
  if (status === 401 || status === 403) return 'Unauthorized';
  if (code === 'staff_actions_disabled') return 'Staff write actions are disabled.';
  if (code === 'no_sendable_recipients') return 'No sendable recipients (email missing or do-not-contact).';
  if (code === 'recipient_cap_exceeded') return 'Too many sendable recipients (cap 50).';
  if (code === 'view_not_broadcastable') return 'This view cannot be used for email broadcast.';
  if (status === 409 || code === 'broadcast_not_draft') return 'Broadcast is no longer a draft.';
  if (status === 400) return code ? ('Request rejected (' + code + ')') : 'Request rejected';
  if (status === 404) return 'Broadcast not found.';
  return 'Send failed';
}

function inboxBroadcastCreateFailureCopy(status, errorCode){
  var code = String(errorCode || '');
  if (status === 401 || status === 403) return 'Unauthorized';
  if (code === 'staff_actions_disabled') return 'Staff write actions are disabled.';
  if (code === 'subject_required') return 'Subject is required.';
  if (code === 'body_too_short') return 'Body is too short.';
  if (code === 'view_not_broadcastable') return 'This view cannot be used for email broadcast.';
  if (code === 'view_required') return 'Pick a People saved view first.';
  if (status === 400) return code ? ('Request rejected (' + code + ')') : 'Request rejected';
  return 'Could not create draft';
}

function inboxBroadcastRecipientCountHtml(viewCount, summary){
  if (summary && summary.pending != null) {
    var pending = Number(summary.pending) || 0;
    var skipped = Number(summary.skipped) || 0;
    return 'Queued recipients: ' + pending +
      (skipped ? (' · skipped: ' + skipped) : '');
  }
  if (viewCount == null) return 'Recipient count is confirmed when you send.';
  return 'People in this view: ' + String(viewCount) +
    ' (sendable count is confirmed on send; do-not-contact excluded, cap 50)';
}

function inboxBroadcastComposerHtml(st){
  st = st || {};
  var locked = !!(st.broadcastId || st.inFlight || st.sendFinished);
  var sendReady = !!(st.broadcastId && !st.inFlight && !st.sendFinished);
  var html = '<div class="inbox-broadcast-card" id="inbox-broadcast-card">';
  html += '<div class="inbox-broadcast-header">';
  html += '<div class="inbox-broadcast-title">Email broadcast</div>';
  html += '<button type="button" class="inbox-broadcast-close" id="inbox-broadcast-close">Close</button>';
  html += '</div>';
  html += '<p class="inbox-broadcast-segment">Segment: ' +
    escHtml(st.viewLabel || st.viewId || '') +
    (st.viewCount == null ? '' : ' (' + escHtml(String(st.viewCount)) + ')') +
    '</p>';
  html += '<p class="inbox-broadcast-channel">Channel: Email</p>';
  html += '<p class="inbox-broadcast-count" id="inbox-broadcast-count">' +
    escHtml(inboxBroadcastRecipientCountHtml(st.viewCount, st.summary)) + '</p>';
  html += '<label class="inbox-broadcast-label" for="inbox-broadcast-subject">Subject</label>';
  html += '<input type="text" id="inbox-broadcast-subject" maxlength="' +
    INBOX_BROADCAST_SUBJECT_MAX + '"' + (locked ? ' disabled' : '') +
    ' value="' + escHtml(st.subject || '') + '">';
  html += '<label class="inbox-broadcast-label" for="inbox-broadcast-body">Body</label>';
  html += '<textarea id="inbox-broadcast-body" maxlength="' +
    INBOX_BROADCAST_BODY_MAX + '"' + (locked ? ' disabled' : '') + '>' +
    escHtml(st.body || '') + '</textarea>';
  html += '<div class="inbox-broadcast-actions">';
  html += '<button type="button" class="inbox-broadcast-create" id="inbox-broadcast-create"' +
    (st.broadcastId || st.inFlight || st.sendFinished ? ' disabled' : '') + '>Create draft</button>';
  html += '<button type="button" class="inbox-broadcast-send" id="inbox-broadcast-send"' +
    (sendReady ? '' : ' disabled') + '>Send</button>';
  html += '</div>';
  html += '<div id="inbox-broadcast-status" class="inbox-broadcast-status" role="status" aria-live="polite"></div>';
  html += '</div>';
  return html;
}

function inboxBroadcastRoot(){
  return el('inbox-broadcast-root');
}

function inboxBroadcastEnsureRoot(){
  var root = inboxBroadcastRoot();
  if (root) return root;
  var shell = el('inbox-shell');
  if (!shell) return null;
  root = document.createElement('div');
  root.id = 'inbox-broadcast-root';
  root.className = 'inbox-broadcast-root';
  root.hidden = true;
  shell.appendChild(root);
  return root;
}

function inboxBroadcastSetStatus(kind, text){
  var statusEl = el('inbox-broadcast-status');
  if (!statusEl) return;
  statusEl.className = 'inbox-broadcast-status' + (kind ? ' is-' + kind : '');
  statusEl.textContent = text || '';
}

function inboxBroadcastReadFields(){
  var subjectEl = el('inbox-broadcast-subject');
  var bodyEl = el('inbox-broadcast-body');
  return {
    subject: subjectEl ? String(subjectEl.value || '').trim() : '',
    body: bodyEl ? String(bodyEl.value || '').trim() : '',
  };
}

function inboxBroadcastRender(){
  var root = inboxBroadcastEnsureRoot();
  if (!root) return;
  root.innerHTML = inboxBroadcastComposerHtml(inboxBroadcastState);
  inboxBroadcastWireComposer();
}

function inboxBroadcastOpen(){
  var view = inboxBroadcastActiveEmailableView();
  if (!view) return;
  inboxBroadcastState = {
    viewId: view.id,
    viewLabel: view.label || view.id,
    viewCount: view.count == null ? null : view.count,
    broadcastId: null,
    inFlight: false,
    sendFinished: false,
    subject: inboxBroadcastState.subject || '',
    body: inboxBroadcastState.body || '',
    summary: null,
  };
  var root = inboxBroadcastEnsureRoot();
  if (!root) return;
  root.hidden = false;
  inboxBroadcastRender();
}

function inboxBroadcastClose(){
  var root = inboxBroadcastRoot();
  if (root) {
    root.hidden = true;
    root.innerHTML = '';
  }
  inboxBroadcastState.broadcastId = null;
  inboxBroadcastState.inFlight = false;
  inboxBroadcastState.sendFinished = false;
  inboxBroadcastState.summary = null;
}

function inboxBroadcastCreate(){
  if (inboxBroadcastState.inFlight || inboxBroadcastState.broadcastId) return;
  var view = inboxBroadcastActiveEmailableView();
  if (!view || view.id !== inboxBroadcastState.viewId) {
    inboxBroadcastSetStatus('error', 'Pick a People saved view first.');
    return;
  }
  var fields = inboxBroadcastReadFields();
  if (!fields.subject) {
    inboxBroadcastSetStatus('error', 'Subject is required.');
    return;
  }
  if (!fields.body || fields.body.length < INBOX_BROADCAST_BODY_MIN) {
    inboxBroadcastSetStatus('error', 'Body is too short.');
    return;
  }
  inboxBroadcastState.inFlight = true;
  inboxBroadcastState.subject = fields.subject;
  inboxBroadcastState.body = fields.body;
  inboxBroadcastRender();
  inboxBroadcastSetStatus('', 'Saving draft…');
  fetch(inboxBroadcastCreateUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      view_id: inboxBroadcastState.viewId,
      channel: 'email',
      email_subject: fields.subject,
      email_body: fields.body,
    }),
  })
    .then(inboxBroadcastParseFetchJson)
    .then(function(out){
      inboxBroadcastState.inFlight = false;
      if (!out.parseOk) {
        inboxBroadcastRender();
        inboxBroadcastSetStatus('error', 'Invalid response');
        return;
      }
      var data = out.data;
      if (out.status >= 200 && out.status < 300 && data && data.broadcast && data.broadcast.id) {
        inboxBroadcastState.broadcastId = data.broadcast.id;
        inboxBroadcastState.summary = data.summary || null;
        inboxBroadcastRender();
        inboxBroadcastSetStatus('', 'Draft saved. ' +
          inboxBroadcastRecipientCountHtml(inboxBroadcastState.viewCount, null));
        return;
      }
      inboxBroadcastRender();
      inboxBroadcastSetStatus('error', inboxBroadcastCreateFailureCopy(out.status, inboxBroadcastErrorCode(data)));
    })
    .catch(function(){
      inboxBroadcastState.inFlight = false;
      inboxBroadcastRender();
      inboxBroadcastSetStatus('error', inboxBroadcastCreateFailureCopy(0, ''));
    });
}

function inboxBroadcastSend(){
  if (inboxBroadcastState.inFlight || inboxBroadcastState.sendFinished) return;
  var id = inboxBroadcastState.broadcastId;
  if (!id) {
    inboxBroadcastSetStatus('error', 'Create a draft first.');
    return;
  }
  inboxBroadcastState.inFlight = true;
  inboxBroadcastRender();
  inboxBroadcastSetStatus('', 'Snapshotting recipients…');
  fetch(inboxBroadcastSendUrl(id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
    .then(inboxBroadcastParseFetchJson)
    .then(function(out){
      inboxBroadcastState.inFlight = false;
      var data = out.parseOk ? out.data : null;
      var code = inboxBroadcastErrorCode(data);
      var summary = data && data.summary ? data.summary : null;
      if (summary) inboxBroadcastState.summary = summary;
      if (out.status === 501 || code === INBOX_BROADCAST_SEND_NOT_IMPLEMENTED) {
        inboxBroadcastState.sendFinished = true;
        inboxBroadcastRender();
        inboxBroadcastSetStatus('blocked', inboxBroadcastSendFailureCopy(out.status, code, summary));
        var countEl = el('inbox-broadcast-count');
        if (countEl) countEl.textContent = inboxBroadcastRecipientCountHtml(inboxBroadcastState.viewCount, summary);
        return;
      }
      inboxBroadcastRender();
      inboxBroadcastSetStatus('error', inboxBroadcastSendFailureCopy(out.status, code, summary));
    })
    .catch(function(){
      inboxBroadcastState.inFlight = false;
      inboxBroadcastRender();
      inboxBroadcastSetStatus('error', inboxBroadcastSendFailureCopy(0, '', null));
    });
}

function inboxBroadcastWireComposer(){
  var root = inboxBroadcastRoot();
  if (!root || root.dataset.wired === '1') return;
  root.dataset.wired = '1';
  root.addEventListener('click', function(ev){
    var target = ev.target;
    if (target && target.nodeType !== 1) target = target.parentElement;
    if (!target) return;
    if (target.id === 'inbox-broadcast-close') inboxBroadcastClose();
    else if (target.id === 'inbox-broadcast-create') inboxBroadcastCreate();
    else if (target.id === 'inbox-broadcast-send') inboxBroadcastSend();
  });
}

function inboxBroadcastSyncOpenButton(){
  var btn = el('inbox-broadcast-open');
  if (!btn) return;
  var view = inboxBroadcastActiveEmailableView();
  if (view) {
    btn.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Email broadcast';
  } else {
    btn.hidden = true;
    btn.disabled = true;
  }
}

function inboxBroadcastOnViewsRendered(data){
  inboxBroadcastViewsCache = (data && data.views) || [];
  var rail = el('inbox-views-rail');
  if (!rail) return;
  var people = rail.querySelector('[data-inbox-view-group="people"]');
  if (!people) return;
  var btn = people.querySelector('#inbox-broadcast-open');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'inbox-broadcast-open';
    btn.className = 'inbox-broadcast-open';
    btn.textContent = 'Email broadcast';
    btn.addEventListener('click', function(ev){
      ev.preventDefault();
      ev.stopPropagation();
      inboxBroadcastOpen();
    });
    people.appendChild(btn);
  }
  inboxBroadcastSyncOpenButton();
}

if (typeof renderInboxViewsRail === 'function') {
  var _inboxBroadcastLegacyRenderRail = renderInboxViewsRail;
  renderInboxViewsRail = function(data){
    _inboxBroadcastLegacyRenderRail(data);
    inboxBroadcastOnViewsRendered(data);
  };
}

if (typeof selectInboxSavedView === 'function') {
  var _inboxBroadcastLegacySelect = selectInboxSavedView;
  selectInboxSavedView = function(viewId){
    var prev = typeof inboxSavedViewId === 'string' ? inboxSavedViewId : '';
    _inboxBroadcastLegacySelect(viewId);
    inboxBroadcastSyncOpenButton();
    if (viewId && viewId !== prev) inboxBroadcastClose();
  };
}

inboxBroadcastEnsureRoot();
