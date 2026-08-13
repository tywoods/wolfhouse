/**
 * Staff Portal Inbox — WhatsApp Luna draft card (Approve / Edit).
 *
 * Loads GET /staff/inbox/whatsapp/draft when a WhatsApp thread opens.
 * Edit POSTs the same path. Approve POSTs /staff/inbox/whatsapp/approve-send.
 * Staff always Approve — this is not WhatsApp Auto-send of drafts.
 *
 * Injected into /staff/ui ahead of inbox-thread. Fragment spliced into the portal
 * IIFE, so it relies on siblings (`escHtml`, `inboxClientQuery`, `getClient`,
 * `selectedConvId`, `showDraftSendStatus`, `loadConvDetail`).
 */

var WHATSAPP_DRAFT_MAX_UTF8_BYTES = 8000;
var WHATSAPP_DRAFT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var _whatsappDraftStateByConv = Object.create(null);
var _whatsappDraftUtf8Encoder = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;

function whatsappDraftState(convId){
  var id = String(convId || '');
  if (!_whatsappDraftStateByConv[id]) {
    _whatsappDraftStateByConv[id] = {
      approvalId: null,
      draftText: '',
      editing: false,
      inFlight: false,
      sent: false,
      seq: 0,
    };
  }
  return _whatsappDraftStateByConv[id];
}

function whatsappDraftUtf8ByteLength(text){
  var s = String(text == null ? '' : text);
  try {
    if (_whatsappDraftUtf8Encoder) return _whatsappDraftUtf8Encoder.encode(s).length;
  } catch (_e) { /* fall through */ }
  try { return unescape(encodeURIComponent(s)).length; } catch (_e2) { return s.length; }
}

function whatsappDraftCanonicalUuid(raw){
  if (typeof raw !== 'string') return null;
  var t = raw.trim().toLowerCase();
  return WHATSAPP_DRAFT_UUID_RE.test(t) ? t : null;
}

function whatsappDraftGetUrl(convId){
  return '/staff/inbox/whatsapp/draft' + inboxClientQuery() +
    '&conversation_id=' + encodeURIComponent(convId);
}

function inboxWhatsAppDraftMountHtml(){
  return '<div id="inbox-whatsapp-draft" class="inbox-whatsapp-draft" hidden></div>';
}

function inboxWhatsAppDraftCardHtml(st){
  st = st || {};
  var html = '<div class="inbox-whatsapp-draft-card">';
  html += '<div class="inbox-whatsapp-draft-label">Luna draft</div>';
  if (st.editing) {
    html += '<textarea id="whatsapp-draft-textarea"' +
      (st.inFlight || st.sent ? ' disabled' : '') + '>' +
      escHtml(st.draftText || '') + '</textarea>';
  } else {
    html += '<div class="inbox-whatsapp-draft-text" id="whatsapp-draft-text">' +
      escHtml(st.draftText || '') + '</div>';
  }
  html += '<div class="draft-actions">';
  if (st.editing) {
    html += '<button type="button" class="btn-whatsapp-draft-edit" id="btn-whatsapp-draft-save"' +
      (st.inFlight || st.sent ? ' disabled' : '') + '>Save</button>';
  } else {
    html += '<button type="button" class="btn-whatsapp-draft-edit" id="btn-whatsapp-draft-edit"' +
      (st.inFlight || st.sent ? ' disabled' : '') + '>Edit</button>';
  }
  html += '<button type="button" class="btn-whatsapp-draft-approve" id="btn-whatsapp-draft-approve"' +
    (st.inFlight || st.sent ? ' disabled' : '') + '>Approve</button>';
  html += '</div>';
  html += '<div id="whatsapp-draft-status" class="draft-send-status" role="status" aria-live="polite"></div>';
  html += '</div>';
  return html;
}

function whatsappDraftParseFetchJson(r){
  return r.text().then(function(raw){
    try {
      return { status: r.status, data: (raw == null || raw === '') ? null : JSON.parse(raw), parseOk: true };
    } catch (_e) { return { status: r.status, data: null, parseOk: false }; }
  });
}

function whatsappDraftErrorCode(data){
  try {
    if (!data || typeof data !== 'object') return '';
    var err = data.error;
    return typeof err === 'string' ? err : '';
  } catch (_e) { return ''; }
}

function whatsappDraftFailureCopy(op, status, errorCode){
  if (errorCode === 'whatsapp_dry_run') {
    return 'WhatsApp dry run is on (whatsapp_dry_run) — draft was not sent.';
  }
  if (errorCode === 'luna_auto_send_disabled') {
    return 'Luna auto-send is off (luna_auto_send_disabled) — draft was not sent.';
  }
  if (status === 409 || errorCode === 'approval_conflict') {
    return 'Conflict (409) — reload and try again';
  }
  if (status === 404 || errorCode === 'not_found') return 'No pending draft to approve.';
  if (status === 401 || status === 403) return 'Unauthorized';
  if (status === 400) return 'Request rejected';
  if (status === 502 || errorCode === 'send_failed') return 'Send failed — draft was not sent twice.';
  if (status === 503) return 'Temporarily unavailable';
  return op === 'approve' ? 'Approve failed' : (op === 'save' ? 'Save failed' : 'Could not load draft');
}

function whatsappDraftMount(targetEl){
  return targetEl && targetEl.querySelector('#inbox-whatsapp-draft');
}

function whatsappDraftStatusEl(targetEl){
  var mount = whatsappDraftMount(targetEl);
  return mount ? mount.querySelector('#whatsapp-draft-status') : null;
}

function renderInboxWhatsAppDraftCard(targetEl, st){
  var mount = whatsappDraftMount(targetEl);
  if (!mount) return;
  if (!st || st.sent || !st.draftText) {
    mount.hidden = true;
    mount.innerHTML = '';
    return;
  }
  mount.hidden = false;
  mount.innerHTML = inboxWhatsAppDraftCardHtml(st);
}

function applyWhatsAppDraftFromGet(st, data){
  if (!data || data.success !== true || data.draft_available !== true) {
    st.approvalId = null;
    st.draftText = '';
    st.editing = false;
    return false;
  }
  var text = data.edited_text != null && String(data.edited_text).length
    ? String(data.edited_text)
    : String(data.draft_text == null ? '' : data.draft_text);
  if (!text) {
    st.approvalId = null;
    st.draftText = '';
    st.editing = false;
    return false;
  }
  st.approvalId = whatsappDraftCanonicalUuid(data.approval_id);
  st.draftText = text;
  st.editing = false;
  st.sent = false;
  return true;
}

function loadInboxWhatsAppDraft(convId, targetEl){
  var st = whatsappDraftState(convId);
  var snapConv = String(convId);
  var mySeq = ++st.seq;
  st.editing = false;
  st.inFlight = false;
  fetch(whatsappDraftGetUrl(convId), { headers: { Accept: 'application/json' } })
    .then(whatsappDraftParseFetchJson)
    .then(function(out){
      if (mySeq !== st.seq) return;
      if (selectedConvId !== snapConv) return;
      if (!out.parseOk || out.status !== 200 || !applyWhatsAppDraftFromGet(st, out.data)) {
        st.approvalId = null;
        st.draftText = '';
        st.editing = false;
        st.sent = false;
      }
      renderInboxWhatsAppDraftCard(targetEl, st);
    })
    .catch(function(){
      if (mySeq !== st.seq) return;
      if (selectedConvId !== snapConv) return;
      st.approvalId = null;
      st.draftText = '';
      st.editing = false;
      renderInboxWhatsAppDraftCard(targetEl, st);
    });
}

function performWhatsAppDraftEdit(convId, targetEl){
  var st = whatsappDraftState(convId);
  if (st.inFlight || st.sent || !st.draftText) return;
  st.editing = true;
  renderInboxWhatsAppDraftCard(targetEl, st);
}

function performWhatsAppDraftSave(convId, targetEl){
  var st = whatsappDraftState(convId);
  var mount = whatsappDraftMount(targetEl);
  var ta = mount && mount.querySelector('#whatsapp-draft-textarea');
  if (!ta || st.inFlight || st.sent) return;
  var messageText = String(ta.value == null ? '' : ta.value);
  if (!messageText.length) {
    showDraftSendStatus(whatsappDraftStatusEl(targetEl), 'error', 'Enter draft text before saving.');
    return;
  }
  if (whatsappDraftUtf8ByteLength(messageText) > WHATSAPP_DRAFT_MAX_UTF8_BYTES) {
    showDraftSendStatus(whatsappDraftStatusEl(targetEl), 'error', 'Message exceeds 8,000 UTF-8 bytes.');
    return;
  }
  var snapConv = String(convId);
  var mySeq = ++st.seq;
  st.draftText = messageText;
  st.inFlight = true;
  renderInboxWhatsAppDraftCard(targetEl, st);
  showDraftSendStatus(whatsappDraftStatusEl(targetEl), '', 'Saving draft…');
  fetch('/staff/inbox/whatsapp/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_id: convId,
      draft_text: messageText,
      client_slug: getClient(),
    }),
  })
    .then(whatsappDraftParseFetchJson)
    .then(function(out){
      if (mySeq !== st.seq) return;
      st.inFlight = false;
      if (selectedConvId !== snapConv) return;
      var accepted = out.parseOk && out.status === 200 && out.data && out.data.success === true
        && out.data.draft_text === messageText
        && whatsappDraftCanonicalUuid(out.data.approval_id);
      if (accepted) {
        st.approvalId = whatsappDraftCanonicalUuid(out.data.approval_id);
        st.draftText = messageText;
        st.editing = false;
        renderInboxWhatsAppDraftCard(targetEl, st);
        showDraftSendStatus(whatsappDraftStatusEl(targetEl), 'ok', 'Draft saved');
        return;
      }
      st.editing = true;
      st.draftText = messageText;
      renderInboxWhatsAppDraftCard(targetEl, st);
      var taKeep = whatsappDraftMount(targetEl) && whatsappDraftMount(targetEl).querySelector('#whatsapp-draft-textarea');
      if (taKeep) taKeep.value = messageText;
      showDraftSendStatus(
        whatsappDraftStatusEl(targetEl),
        'error',
        whatsappDraftFailureCopy('save', out.status, whatsappDraftErrorCode(out.data)),
      );
    })
    .catch(function(){
      if (mySeq !== st.seq) return;
      st.inFlight = false;
      if (selectedConvId !== snapConv) return;
      st.editing = true;
      st.draftText = messageText;
      renderInboxWhatsAppDraftCard(targetEl, st);
      showDraftSendStatus(whatsappDraftStatusEl(targetEl), 'error', whatsappDraftFailureCopy('save', 0, ''));
    });
}

function performWhatsAppDraftApprove(convId, targetEl){
  var st = whatsappDraftState(convId);
  if (st.inFlight || st.sent) return;
  if (st.editing) {
    var ta = whatsappDraftMount(targetEl) && whatsappDraftMount(targetEl).querySelector('#whatsapp-draft-textarea');
    var live = ta ? String(ta.value == null ? '' : ta.value) : '';
    if (live !== st.draftText) {
      showDraftSendStatus(whatsappDraftStatusEl(targetEl), 'error', 'Save the current text before approving.');
      return;
    }
  }
  if (!st.draftText) {
    showDraftSendStatus(whatsappDraftStatusEl(targetEl), 'error', 'No pending draft to approve.');
    return;
  }
  var snapConv = String(convId);
  var snapApprovalId = st.approvalId;
  var mySeq = ++st.seq;
  st.inFlight = true;
  renderInboxWhatsAppDraftCard(targetEl, st);
  showDraftSendStatus(whatsappDraftStatusEl(targetEl), '', 'Approving…');
  var body = {
    conversation_id: convId,
    client_slug: getClient(),
  };
  if (snapApprovalId) body.approval_id = snapApprovalId;
  fetch('/staff/inbox/whatsapp/approve-send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(whatsappDraftParseFetchJson)
    .then(function(out){
      if (mySeq !== st.seq) return;
      st.inFlight = false;
      if (selectedConvId !== snapConv) return;
      var code = whatsappDraftErrorCode(out.data);
      if (out.parseOk && out.status === 200 && out.data && out.data.success === true && out.data.status === 'sent') {
        st.sent = true;
        st.editing = false;
        renderInboxWhatsAppDraftCard(targetEl, st);
        try { loadConvDetail(convId, targetEl); } catch (_reload) { /* ignore */ }
        return;
      }
      renderInboxWhatsAppDraftCard(targetEl, st);
      var kind = (out.status === 503 || code === 'whatsapp_dry_run' || code === 'luna_auto_send_disabled')
        ? 'blocked'
        : 'error';
      showDraftSendStatus(
        whatsappDraftStatusEl(targetEl),
        kind,
        whatsappDraftFailureCopy('approve', out.status, code),
      );
    })
    .catch(function(){
      if (mySeq !== st.seq) return;
      st.inFlight = false;
      if (selectedConvId !== snapConv) return;
      renderInboxWhatsAppDraftCard(targetEl, st);
      showDraftSendStatus(whatsappDraftStatusEl(targetEl), 'error', whatsappDraftFailureCopy('approve', 0, ''));
    });
}

function wireInboxWhatsAppDraft(convId, targetEl){
  var mount = whatsappDraftMount(targetEl);
  if (!mount) return;
  if (mount.dataset.wiredWhatsappDraft !== '1') {
    mount.dataset.wiredWhatsappDraft = '1';
    mount.addEventListener('click', function(ev){
      var btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!btn || !mount.contains(btn)) return;
      if (btn.id === 'btn-whatsapp-draft-edit') performWhatsAppDraftEdit(convId, targetEl);
      else if (btn.id === 'btn-whatsapp-draft-save') performWhatsAppDraftSave(convId, targetEl);
      else if (btn.id === 'btn-whatsapp-draft-approve') performWhatsAppDraftApprove(convId, targetEl);
    });
  }
  loadInboxWhatsAppDraft(convId, targetEl);
}
