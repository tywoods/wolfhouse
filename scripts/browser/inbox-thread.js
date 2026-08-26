/**
 * Staff Portal Inbox, Conversations tab: thread detail. Status pebbles, Luna pause
 * controls, needs-human handling, conversation list and detail rendering, WhatsApp send,
 * the email draft and approve-send flow, WhatsApp Luna draft Approve/Edit,
 * and booking cross-links.
 *
 * Injected into /staff/ui at the inbox-thread marker. Fragment spliced into the portal
 * IIFE, so it is already in strict mode and relies on siblings in that scope.
 */

/* Status pebbles — Luna/Staff always; Needs Human optional second pill */
function convSourcePill(conv){
  conv = conv || {};
  var paused = conv.luna_paused === true || conv.luna_paused === 't';
  if (paused){
    return '<span class="pill pill-staff-source conv-list-status-pill">' + escHtml(t('inbox.detail.pill.staff')) + '</span>';
  }
  return '<span class="pill pill-luna conv-list-status-pill">' + escHtml(t('inbox.detail.pill.luna')) + '</span>';
}

function convListPill(conv){
  conv = conv || {};
  var html = convSourcePill(conv);
  if (conversationHasOpenHandoff(conv)){
    html += '<span class="pill pill-orange conv-list-status-pill conv-list-handoff-pill">' + escHtml(t('inbox.list.pill.handoff')) + '</span>';
  } else if (conv.needs_human){
    html += '<span class="pill pill-orange conv-list-status-pill conv-list-needs-human-pill">' + escHtml(t('inbox.list.pill.needsHuman')) + '</span>';
  }
  return html;
}

function convHeaderStatusPillsHtml(conv, _lunaPaused){
  var html = '';
  if (conversationHasOpenHandoff(conv)){
    html += '<span class="pill pill-orange" id="conv-handoff-pill">' + escHtml(t('inbox.list.pill.handoff')) + '</span>';
  } else if (conv && conv.needs_human){
    html += '<span class="pill pill-orange" id="conv-needs-human-pill">' + escHtml(t('inbox.list.pill.needsHuman')) + '</span>';
  }
  return html;
}

function detailHeaderSwitchesHtml(c, lunaGuestPaused){
  return inboxLunaModeControlHtml({
    channel: c && c.channel,
    paused: !!lunaGuestPaused,
    needs_human: !!(c && c.needs_human),
  });
}

/* Inbox header — Luna active vs Staff (pause Luna) source pebble */
function inboxLunaPausedPillHtml(paused){
  if (!paused) return '';
  return '<span class="pill pill-luna-paused" id="conv-luna-paused-pill">' + escHtml(t('inbox.detail.pill.lunaPaused')) + '</span>';
}

function inboxLunaStaffPill(paused){
  if (paused){
    return '<span class="pill pill-staff-source" id="conv-luna-staff-pill">' + escHtml(t('inbox.detail.pill.staff')) + '</span>';
  }
  return '<span class="pill pill-luna" id="conv-luna-staff-pill">' + escHtml(t('inbox.detail.pill.luna')) + '</span>';
}

/* Mode badge (legacy — prefer inboxLunaStaffPill in Inbox detail header) */
function modePill(mode){
  if (mode === 'staff') return '<span class="pill pill-orange">STAFF</span>';
  if (mode === 'paused') return '<span class="pill pill-grey">PAUSED</span>';
  return '<span class="pill pill-green">BOT</span>';
}

/* Friendly handoff reason labels (hides raw codes from normal staff UI) */
function handoffLabel(code){
  if (!code) return '';
  var labels = {
    'date_change_requested':  'Date change request',
    'date_change_request':    'Date change request',
    'payment_inquiry':        'Payment question',
    'cancel_refund':          'Cancellation / refund',
    'needs_human':            'Needs staff reply',
    'staff_manual_handoff':   'Needs staff reply',
    'human_requested':        'Guest asked for a human',
    'rooming_issue':          'Rooming issue',
    'payment_claimed':        'Payment claimed',
    'booking_question':       'Booking question',
    'refund_request':         'Refund request',
    'guest_angry':            'Upset guest',
    'date_change':            'Date change request',
  };
  return labels[code] || 'Needs review';
}

/* Phase 9.3 — read-only Luna guest automation pause signal from API payloads */
function isLunaGuestAutomationPaused(sources){
  var list = sources || [];
  for (var i = 0; i < list.length; i++){
    var o = list[i];
    if (!o || typeof o !== 'object') continue;
    if (o.luna_paused === true || o.luna_paused === 't') return true;
    if (o.bot_paused === true) return true;
    if (o.paused === true) return true;
    if (o.pause_state && o.pause_state.paused === true) return true;
    if (o.pauseState && o.pauseState.paused === true) return true;
  }
  return false;
}

/* Phase 9.5b — Inbox Luna pause/resume controls (bot_pause_states via Staff API) */
function setLunaPauseActionStatus(targetEl, msg, isError){
  var statusEl = targetEl.querySelector('#luna-pause-action-status');
  if (!statusEl) return;
  if (!msg){
    statusEl.style.display = 'none';
    statusEl.textContent = '';
    statusEl.classList.remove('error');
    return;
  }
  statusEl.style.display = 'block';
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', !!isError);
}

function updateLunaPauseUiInPlace(targetEl, paused){
  targetEl = inboxThreadScope(targetEl);
  var statusWrap = targetEl.querySelector('.luna-auto-status');
  var label = targetEl.querySelector('.luna-auto-status-label');
  var help = targetEl.querySelector('.luna-auto-status-help');
  var sw = targetEl.querySelector('#luna-pause-switch');
  if (statusWrap) statusWrap.classList.toggle('luna-auto-status-paused', !!paused);
  if (label) label.textContent = paused ? 'Luna paused' : 'Luna active';
  if (help){
    help.textContent = paused
      ? 'Automated guest replies should stay blocked while paused.'
      : 'Automation status: active.';
  }
  if (sw) sw.checked = !!paused;
  var nhToggle = targetEl.querySelector('#conv-needs-human-toggle');
  var needsHuman = nhToggle ? nhToggle.checked : false;
  var hdrPills = targetEl.querySelector('.detail-header-pills');
  if (hdrPills){
    hdrPills.innerHTML = convHeaderStatusPillsHtml({ needs_human: needsHuman }, paused);
  }
  syncInboxLunaModeControl(targetEl, paused);
}

function updateLunaPausedPillInPlace(targetEl, paused){
  syncInboxLunaModeControl(targetEl, paused);
}

function patchInboxConvRow(convId, patch){
  if (!inboxConversationsCache) return;
  inboxConversationsCache = inboxConversationsCache.map(function(row){
    var id = row.conversation_id || row.id;
    if (id === convId) return Object.assign({}, row, patch);
    return row;
  });
}

function updateInboxConvCardStatusPills(convId){
  var row = (inboxConversationsCache || []).find(function(c){
    return (c.conversation_id || c.id) === convId;
  });
  var card = el('conv-list') && el('conv-list').querySelector('.conv-card[data-id="' + convId + '"]');
  if (!card || !row) return;
  var pills = card.querySelector('.conv-card-pills');
  if (pills) pills.innerHTML = convListPill(row);
}

function updateInboxConvCardNeedsHuman(convId, needsHuman){
  patchInboxConvRow(convId, { needs_human: needsHuman });
  updateInboxConvCardStatusPills(convId);
}

function inboxComposerChannelFor(conv){
  var id = conv && (conv.conversation_id || conv.id);
  if (id && inboxComposerChannelByConv[id]) return inboxComposerChannelByConv[id];
  return (conv && conv.channel === 'email') ? 'email' : 'whatsapp';
}

function inboxGuestEmailOf(conv){
  return String((conv && (conv.email || conv.guest_email)) || '').trim();
}

function inboxIsOpaqueEmailIdentity(value){
  return /^(emailv1|email):/i.test(String(value == null ? '' : value).trim());
}

function inboxIsEmailcustIdentity(value){
  return /^emailcust1:/i.test(String(value == null ? '' : value).trim());
}

function inboxIsHonestPersonLabel(value){
  var s = String(value == null ? '' : value).trim();
  if (!s) return false;
  if (inboxIsOpaqueEmailIdentity(s)) return false;
  if (inboxIsEmailcustIdentity(s)) return false;
  return true;
}

function inboxConversationBoundGuestId(conv, customer){
  var c = conv || {};
  var own = String(c.guest_id || c.customer_id || c.bound_guest_id || c.matched_guest_id || '').trim();
  if (own) return own;
  if (!customer) return '';
  var id = customer.identity || {};
  return String(customer.guest_id || customer.customer_id || id.guest_id || id.customer_id || '').trim();
}

function inboxNormalizeHonestPhone(raw){
  raw = String(raw == null ? '' : raw).trim();
  if (!raw || inboxIsOpaqueEmailIdentity(raw)) return '';
  if (inboxIsEmailcustIdentity(raw)) return raw;
  if (typeof normalizeCustomerPhoneClient === 'function') {
    var normalized = normalizeCustomerPhoneClient(raw);
    if (normalized && normalized.length >= 11) return normalized;
    return '';
  }
  return /^\+[1-9]\d{9,14}$/.test(raw) ? raw : '';
}

function inboxBoundCustomerPhone(conv, customer){
  var c = conv || {};
  var own = inboxNormalizeHonestPhone(c.phone || c.guest_phone || '');
  if (own) return own;
  if (!customer || customer.success === false) return '';
  var convId = String(c.guest_id || c.customer_id || c.bound_guest_id || c.matched_guest_id || '').trim();
  var custId = inboxConversationBoundGuestId(null, customer);
  var convEmail = String(c.email || c.guest_email || '').trim().toLowerCase();
  var custEmail = String(((customer.identity && customer.identity.email) || customer.email) || '').trim().toLowerCase();
  var match = (convId && custId && convId === custId) || (convEmail && custEmail && convEmail === custEmail);
  if (!match) return '';
  return inboxNormalizeHonestPhone(customer.phone || '');
}

function inboxEmailSubjectOf(conv, msgs){
  var c = conv || {};
  var direct = String(c.email_subject || c.subject || c.last_email_subject || '').trim();
  if (direct) return direct;
  var list = msgs || [];
  var i;
  for (i = list.length - 1; i >= 0; i--) {
    var m = list[i] || {};
    var sub = String(m.email_subject || m.subject || '').trim();
    if (sub) return sub;
  }
  for (i = list.length - 1; i >= 0; i--) {
    var inbound = list[i] || {};
    if (inbound.source === 'email_inbound' && inbound.message_text) {
      return String(inbound.message_text).trim();
    }
  }
  if ((c.channel === 'email') && c.last_message_preview) {
    return String(c.last_message_preview).trim();
  }
  return '';
}

function inboxEmailReplySubjectDefault(subject){
  var s = String(subject == null ? '' : subject).trim();
  if (!s) return 'Re: ';
  if (/^re\s*:/i.test(s)) return s;
  return 'Re: ' + s;
}

/** Honest open-draft body from current Skipper/staff fields. Never invents copy. */
function inboxEmailDraftBodyOf(draft, conv){
  var d = draft || {};
  var c = conv || {};
  var candidates = [d.draft_text, d.body, d.message_text, d.luna_draft_body, d.luna_body, c.staff_reply_draft];
  var i;
  for (i = 0; i < candidates.length; i++) {
    if (candidates[i] != null && String(candidates[i]).trim()) return String(candidates[i]);
  }
  return '';
}

function inboxEmailDraftNeedsReply(conv){
  var c = conv || {};
  return !!(c.needs_human || c.needs_attention || (typeof conversationHasOpenHandoff === 'function' && conversationHasOpenHandoff(c)));
}

function inboxEmailDraftIsPending(draft, conv, body){
  if (String(body || '').trim()) return false;
  if (!inboxEmailDraftNeedsReply(conv)) return false;
  var d = draft || {};
  var status = String(d.status || d.draft_status || '').toLowerCase();
  if (status === 'draft_ready') return false;
  return true;
}

function inboxEmailOpenDraftSubject(draft, conv, msgs){
  var d = draft || {};
  var sub = String(d.subject || d.email_subject || '').trim();
  if (sub) return inboxEmailReplySubjectDefault(sub);
  return inboxEmailReplySubjectDefault(inboxEmailSubjectOf(conv, msgs));
}

function inboxPersonDisplayName(conv, extras){
  extras = extras || {};
  var customer = extras.customer || {};
  var id = customer.identity || {};
  var useCustomer = !!(extras.customer && inboxCustomerHasBoundGuest(conv, extras.customer));
  var candidates = [];
  if (useCustomer) {
    candidates.push(id.display_name, customer.display_name, id.email, customer.email);
  }
  candidates.push(
    conv && conv.guest_name,
    conv && conv.display_name,
    extras.display_name,
    extras.email,
    conv && conv.guest_email,
    conv && conv.email
  );
  for (var i = 0; i < candidates.length; i++) {
    if (inboxIsHonestPersonLabel(candidates[i])) return String(candidates[i]).trim();
  }
  var ownEmail = String((conv && (conv.email || conv.guest_email)) || '').trim();
  return inboxIsHonestPersonLabel(ownEmail) ? ownEmail : 'Guest';
}

function inboxCustomerHasBoundGuest(conv, customer){
  if (inboxConversationBoundGuestId(conv, null)) return true;
  if (inboxBoundCustomerPhone(conv, null)) return true;
  if (customer && customer.success !== false) {
    var convId = inboxConversationBoundGuestId(conv, null);
    var custId = inboxConversationBoundGuestId(null, customer);
    if (convId && custId && String(convId) === String(custId)) return true;
    var convEmail = String((conv && (conv.email || conv.guest_email)) || '').trim().toLowerCase();
    var custEmail = String(((customer.identity && customer.identity.email) || customer.email) || '').trim().toLowerCase();
    if (convEmail && custEmail && convEmail === custEmail) return true;
  }
  return false;
}

function inboxComposerChannelIcon(channel){
  if (typeof inboxShellChannelIconSvg === 'function') return inboxShellChannelIconSvg(channel);
  if (channel === 'email') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg>';
}

function inboxComposerChannelSwitchHtml(selected){
  var html = '<div class="inbox-composer-channel" role="group" aria-label="Reply channel">';
  html += '<button type="button" class="inbox-composer-channel-btn' + (selected === 'whatsapp' ? ' is-active' : '') + '" data-inbox-composer-channel="whatsapp">';
  html += '<span class="inbox-composer-channel-ico" aria-hidden="true">' + inboxComposerChannelIcon('whatsapp') + '</span><span>WhatsApp</span></button>';
  html += '<button type="button" class="inbox-composer-channel-btn' + (selected === 'email' ? ' is-active' : '') + '" data-inbox-composer-channel="email">';
  html += '<span class="inbox-composer-channel-ico" aria-hidden="true">' + inboxComposerChannelIcon('email') + '</span><span>Email</span></button>';
  html += '</div>';
  return html;
}

function inboxFindGuestConversation(conv, channel){
  var list = (typeof inboxConversationsCache !== 'undefined' && inboxConversationsCache) ? inboxConversationsCache : [];
  var phone = conv && conv.phone ? String(conv.phone) : '';
  var email = inboxGuestEmailOf(conv).toLowerCase();
  var selfId = conv && (conv.conversation_id || conv.id);
  for (var i = 0; i < list.length; i++) {
    var row = list[i] || {};
    var rowCh = row.channel === 'email' ? 'email' : 'whatsapp';
    if (rowCh !== channel) continue;
    if (selfId && String(row.conversation_id || row.id || '') === String(selfId)) return row;
    if (phone && row.phone && String(row.phone) === phone) return row;
    var rowEmail = String(row.email || row.guest_email || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail === email) return row;
  }
  return null;
}

function inboxMessageChannelOf(m){
  if (!m) return 'whatsapp';
  if (m.channel === 'email' || m.message_channel === 'email') return 'email';
  if (m.source === 'staff_email_reply' || m.message_type === 'email' || m.email_subject) return 'email';
  return 'whatsapp';
}

function inboxFilterMessagesByChannel(msgs, channel){
  var want = channel === 'email' ? 'email' : 'whatsapp';
  var out = [];
  for (var i = 0; i < (msgs || []).length; i++) {
    if (inboxMessageChannelOf(msgs[i]) === want) out.push(msgs[i]);
  }
  return out;
}

function inboxNoEmailThreadHtml(){
  return '<div class="inbox-composer-no-email" role="status">Update email address in guest profile to email.</div>';
}

function inboxFillComposerThread(conv, nativeMsgs){
  var channel = inboxComposerChannelFor(conv);
  var container = typeof el === 'function' ? el('thread-container') : null;
  if (!container) return;
  var nativeCh = (conv && conv.channel === 'email') ? 'email' : 'whatsapp';
  if (channel === nativeCh) {
    var filtered = inboxFilterMessagesByChannel(nativeMsgs, channel);
    if (channel === 'email' && !filtered.length) {
      container.innerHTML = inboxNoEmailThreadHtml();
      return;
    }
    container.innerHTML = filtered.length ? renderInboxThreadMessagesHtml(filtered) : '<div class="thread-empty">' + escHtml(t('inbox.detail.thread.empty')) + '</div>';
    return;
  }
  var sibling = inboxFindGuestConversation(conv, channel);
  if (!sibling || !sibling.conversation_id) {
    container.innerHTML = channel === 'email' ? inboxNoEmailThreadHtml() : '<div class="thread-empty">' + escHtml(t('inbox.detail.thread.empty')) + '</div>';
    return;
  }
  fetch('/staff/conversations/' + encodeURIComponent(sibling.conversation_id) + '/messages' + inboxClientQuery())
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (!container) return;
      var msgs = inboxFilterMessagesByChannel((data && data.messages) || [], channel);
      if (channel === 'email' && !msgs.length) {
        container.innerHTML = inboxNoEmailThreadHtml();
        return;
      }
      container.innerHTML = msgs.length ? renderInboxThreadMessagesHtml(msgs) : '<div class="thread-empty">' + escHtml(t('inbox.detail.thread.empty')) + '</div>';
    })
    .catch(function(){
      if (container && channel === 'email') container.innerHTML = inboxNoEmailThreadHtml();
    });
}

function wireInboxComposerChannelSwitch(conv, targetEl){
  if (!targetEl || !targetEl.querySelectorAll) return;
  var btns = targetEl.querySelectorAll('[data-inbox-composer-channel]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function(){
      var next = this.getAttribute('data-inbox-composer-channel');
      var id = conv && (conv.conversation_id || conv.id);
      if (id) inboxComposerChannelByConv[id] = next;
      loadConvDetail(id, targetEl);
    });
  }
}

var inboxComposerChannelByConv = {};

function inboxIsChatPreset(){
  try {
    if (typeof inboxColumnsRuntime !== 'undefined' && inboxColumnsRuntime && inboxColumnsRuntime.record) {
      return inboxColumnsRuntime.record.preset === 'chat';
    }
  } catch (_e) { /* ignore */ }
  var btn = typeof document !== 'undefined' ? document.querySelector('[data-inbox-preset="chat"][aria-pressed="true"]') : null;
  return !!btn;
}

function inboxChatGuestTab(){
  return typeof document !== 'undefined' ? document.getElementById('tab-conversations') : null;
}

function inboxChatGuestIsShowing(){
  var tab = inboxChatGuestTab();
  return !!(tab && tab.classList.contains('inbox-chat-showing-guest'));
}

function inboxChatHideGuest(){
  var tab = inboxChatGuestTab();
  if (tab) tab.classList.remove('inbox-chat-showing-guest');
  var host = typeof document !== 'undefined' ? document.getElementById('inbox-chat-guest-host') : null;
  if (host) host.hidden = true;
}

function inboxChatPaintGuest(){
  var host = typeof document !== 'undefined' ? document.getElementById('inbox-chat-guest-host') : null;
  if (!host) return;
  var data = (typeof inboxCustomerMerge === 'function')
    ? inboxCustomerMerge(
      typeof inboxCustomerFromConv === 'function' ? inboxCustomerFromConv(inboxContextLastConv) : {},
      inboxContextLastCustomer
    )
    : inboxContextLastCustomer;
  var body = '';
  if (typeof inboxCustomerEditing !== 'undefined' && inboxCustomerEditing && typeof inboxCustomerEditHtml === 'function') {
    body = inboxCustomerEditHtml(data, { composite: inboxContextLastComposite, conv: inboxContextLastConv });
  } else if (typeof inboxCustomerFullHtml === 'function') {
    body = inboxCustomerFullHtml(data, { composite: inboxContextLastComposite, conv: inboxContextLastConv });
  }
  host.innerHTML = '<div class="inbox-chat-guest-toolbar"><button type="button" class="inbox-chat-guest-back" id="inbox-chat-guest-back">BACK</button></div>' + (body || '');
  if (typeof inboxContextWireActions === 'function') inboxContextWireActions(host, { conversation: inboxContextLastConv });
  if (typeof inboxCustomerWireFull === 'function') inboxCustomerWireFull(host, data);
  var back = host.querySelector('#inbox-chat-guest-back');
  if (back) back.addEventListener('click', function(){ inboxChatHideGuest(); });
}

function inboxChatShowGuest(){
  if (!inboxIsChatPreset()) return;
  var tab = inboxChatGuestTab();
  if (tab) tab.classList.add('inbox-chat-showing-guest');
  var host = typeof document !== 'undefined' ? document.getElementById('inbox-chat-guest-host') : null;
  if (host) host.hidden = false;
  inboxChatPaintGuest();
}

function inboxRefreshBtn(){
  return typeof document !== 'undefined' ? document.getElementById('btn-refresh') : null;
}

function inboxParkRefreshBtn(){
  var btn = inboxRefreshBtn();
  var park = typeof document !== 'undefined'
    ? (document.querySelector('.inbox-layout-controls') || document.getElementById('tabs'))
    : null;
  if (!btn || !park) return;
  if (btn.parentNode !== park) park.insertBefore(btn, park.firstChild);
}

function inboxAdoptRefreshToHeader(){
  var btn = inboxRefreshBtn();
  var row = typeof document !== 'undefined' ? document.getElementById('inbox-header-luna-row') : null;
  if (!btn || !row) return;
  if (btn.parentNode !== row || row.lastChild !== btn) row.appendChild(btn);
}

function inboxPaintChatChromeSlot(conv, lunaGuestPaused){
  var row = typeof document !== 'undefined' ? document.getElementById('inbox-header-luna-row') : null;
  var right = typeof document !== 'undefined' ? document.querySelector('#inbox-shell .detail-header-right') : null;
  var host = row || right;
  var slot = typeof el === 'function' ? el('inbox-chat-chrome-slot') : (typeof document !== 'undefined' ? document.getElementById('inbox-chat-chrome-slot') : null);
  if (host) {
    if (!slot || !host.contains(slot)) {
      if (slot && slot.parentNode) slot.parentNode.removeChild(slot);
      slot = document.createElement('div');
      slot.id = 'inbox-chat-chrome-slot';
      slot.className = 'inbox-chat-chrome-slot';
      host.appendChild(slot);
    }
  }
  if (!slot) return;
  slot.innerHTML = detailHeaderSwitchesHtml(conv, lunaGuestPaused);
  var raise = slot.querySelector('#inbox-needs-human-raise');
  var nh = typeof document !== 'undefined' ? document.getElementById('inbox-needs-human-slot') : null;
  if (raise && nh && raise.parentNode !== nh) nh.appendChild(raise);
  inboxAdoptRefreshToHeader();
}

function updateConvHeaderPillsInPlace(targetEl, needsHuman, lunaPaused){
  targetEl = inboxThreadScope(targetEl);
  var hdrPills = targetEl.querySelector('.detail-header-pills');
  if (hdrPills){
    hdrPills.innerHTML = convHeaderStatusPillsHtml({ needs_human: needsHuman }, lunaPaused);
  }
}

function updateNeedsHumanBadgeInPlace(targetEl, needsHuman, opts){
  opts = opts || {};
  targetEl = inboxThreadScope(targetEl);
  var pauseSw = targetEl.querySelector('#luna-pause-switch');
  var lunaPaused = (typeof opts.conversation_paused === 'boolean')
    ? opts.conversation_paused
    : (pauseSw ? pauseSw.checked : false);
  if (typeof opts.conversation_paused === 'boolean' && pauseSw) {
    pauseSw.checked = !!opts.conversation_paused;
  }
  updateConvHeaderPillsInPlace(targetEl, needsHuman, lunaPaused);
  updateLunaPausedPillInPlace(targetEl, lunaPaused);
  syncInboxNeedsHumanRaise(targetEl, needsHuman);
}

function wireNeedsHumanToggle(convId, targetEl){
  targetEl = inboxThreadScope(targetEl);
  var toggle = targetEl.querySelector('#conv-needs-human-toggle');
  if (!toggle || toggle.dataset.wiredNeedsHuman === '1') return;
  toggle.dataset.wiredNeedsHuman = '1';

  toggle.addEventListener('change', function(){
    var want = toggle.checked;
    toggle.disabled = true;
    var raise = targetEl.querySelector('#inbox-needs-human-raise');
    if (raise) raise.disabled = true;
    fetch('/staff/conversations/' + encodeURIComponent(convId) + '/needs-human', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_slug: getClient(), needs_human: want }),
    })
      .then(function(r){
        if (r.status === 401) throw new Error('Authentication required');
        if (r.status === 403) throw new Error('Not allowed for this client');
        return r.json().then(function(data){ return { status: r.status, data: data }; });
      })
      .then(function(out){
        var d = out.data || {};
        if (!d.success) throw new Error(d.error || ('HTTP ' + out.status));
        updateNeedsHumanBadgeInPlace(targetEl, d.needs_human === true, {
          conversation_paused: d.conversation_paused === true,
        });
        if (inboxConversationsCache){
          inboxConversationsCache = inboxConversationsCache.map(function(row){
            var id = row.conversation_id || row.id;
            if (id !== convId) return row;
            return Object.assign({}, row, {
              needs_human: d.needs_human === true,
              handoff_reason: d.handoff_reason || null,
              handoff_status: d.handoff_status || (d.handoff && d.handoff.status) || null,
              luna_paused: d.conversation_paused === true ? true : row.luna_paused,
            });
          });
          if (inboxFilter === 'needs-human' && !d.needs_human){
            refreshInboxListPreserveDetail(convId);
          } else {
            updateInboxConvCardNeedsHuman(convId, d.needs_human === true);
            updateInboxConvCardStatusPills(convId);
            var nhCount = inboxConversationsCache.filter(conversationNeedsHuman).length;
            var badge = el('hq-badge');
            if (badge){ badge.textContent = nhCount; badge.classList.toggle('visible', nhCount > 0); }
          }
        }
      })
      .catch(function(err){
        toggle.checked = !want;
        syncInboxNeedsHumanRaise(targetEl, toggle.checked);
        alert(err.message || 'Could not update needs human flag');
      })
      .finally(function(){ toggle.disabled = false; var raise = targetEl.querySelector('#inbox-needs-human-raise'); if (raise) raise.disabled = false; });
  });
}

function refreshInboxListPreserveDetail(convId){
  var list = el('conv-list');
  var scrollEl = list && list.closest('.inbox-left-rows');
  var scrollTop = scrollEl ? scrollEl.scrollTop : (list ? list.scrollTop : 0);
  applyInboxFilter({ preserveDetail: true, selectedId: convId || selectedConvId });
  if (scrollEl) scrollEl.scrollTop = scrollTop;
  else if (list) list.scrollTop = scrollTop;
  var nhCount = (inboxConversationsCache || []).filter(conversationNeedsHuman).length;
  var badge = el('hq-badge');
  if (badge){ badge.textContent = nhCount; badge.classList.toggle('visible', nhCount > 0); }
}

function openBookingInSchedule(booking){
  booking = booking || {};
  var code = String(booking.booking_code || '').trim();
  var id = String(booking.booking_id || '').trim();
  if (!code && !id) return;
  // Prefer window.* owners so portal surfaces share one interceptable boundary
  // (parity with window.openBookingInCalendar). Free-name fallback keeps IIFE scope.
  var tabFn = (typeof window !== 'undefined' && typeof window.switchToTab === 'function')
    ? window.switchToTab
    : (typeof switchToTab === 'function' ? switchToTab : null);
  if (tabFn) tabFn('portal-home', null);
  // Canonical Schedule day nav owner: scheduleOpenDayDetail → openScheduleDetailDrawer.
  // Prefer service window start, then check_in. No second navigation owner.
  var start = booking.service_date_start || booking.service_date || booking.check_in || '';
  start = start ? String(start).slice(0, 10) : '';
  var dayFn = (typeof window !== 'undefined' && typeof window.scheduleOpenDayDetail === 'function')
    ? window.scheduleOpenDayDetail
    : (typeof scheduleOpenDayDetail === 'function' ? scheduleOpenDayDetail : null);
  var drawerFn = (typeof window !== 'undefined' && typeof window.openScheduleDetailDrawer === 'function')
    ? window.openScheduleDetailDrawer
    : (typeof openScheduleDetailDrawer === 'function' ? openScheduleDetailDrawer : null);
  function openDrawer(){
    if (!drawerFn) return;
    drawerFn({
      booking_id: id || null,
      booking_code: code || null,
      guest_name: booking.guest_name || booking.booking_guest_name || '',
      service_date: start || null,
      _drawerFromCustomer: true,
    });
  }
  if (start && dayFn) {
    var navResult = dayFn(start);
    if (navResult && typeof navResult.then === 'function') {
      navResult.then(function(){ openDrawer(); }).catch(function(){ openDrawer(); });
      return;
    }
  }
  openDrawer();
}
// Portal owner export (same pattern as openBookingInCalendar).
window.openBookingInSchedule = openBookingInSchedule;

function openBookingInCalendar(booking){
  if (isSunsetSurfActive()) {
    openBookingInSchedule(booking);
    return;
  }
  booking = booking || {};
  var code = String(booking.booking_code || '').trim();
  var id = String(booking.booking_id || '').trim();
  var checkIn = booking.check_in ? String(booking.check_in).slice(0, 10) : '';
  var checkOut = booking.check_out ? String(booking.check_out).slice(0, 10) : '';
  if (!code && !id) return;

  function openBlockAndScroll(block){
    bcPendingScrollToOverview = true;
    bcOpenBookingDrawerOverview(block);
    bcScrollToBookingOverview();
  }

  function tryOpenBlock(blocks){
    if (!blocks || !blocks.length) return false;
    for (var i = 0; i < blocks.length; i++){
      var b = blocks[i];
      if (id && b.booking_id === id){ openBlockAndScroll(b); return true; }
      if (code && b.booking_code === code){ openBlockAndScroll(b); return true; }
    }
    return false;
  }

  function loadAndOpen(start, end, chipKey){
    bcSetDateField(el('bc-start'), start);
    bcSetDateField(el('bc-end'), end);
    bcUpdateCalendarTitle();
    /* Select the season pebble that contains this booking so the calendar lands
       in the right window (not just an unlabelled custom range). */
    document.querySelectorAll('.bc-chip').forEach(function(c){ c.classList.remove('bc-chip-active'); });
    if (chipKey){
      var activeChip = document.querySelector('.bc-chip[data-chip="' + chipKey + '"]');
      if (activeChip) activeChip.classList.add('bc-chip-active');
    }
    loadBedCalendar(function(data){
      if (!tryOpenBlock(data.blocks) && code){
        openBlockAndScroll({
          booking_code: code,
          booking_id: id || undefined,
          start_date: checkIn,
          end_date: checkOut,
          guest_name: booking.guest_name || booking.booking_guest_name || '',
        });
      }
    });
  }

  switchToTabOnly('bed-calendar');

  if (checkIn){
    var win = bcTwoMonthWindowForCheckIn(checkIn);
    if (win){
      loadAndOpen(win.start, win.end, bcChipKeyForCheckIn(checkIn));
    } else {
      var rangeStart = bcAddDaysISO(checkIn, -3);
      var rangeEnd = checkOut ? bcAddDaysISO(checkOut, 3) : bcAddDaysISO(checkIn, 30);
      loadAndOpen(rangeStart, rangeEnd, null);
    }
    return;
  }

  var sEl = el('bc-start');
  var eEl = el('bc-end');
  if (bcReadDateField(sEl) && bcReadDateField(eEl)){
    loadBedCalendar(function(data){
      if (!tryOpenBlock(data.blocks) && code){
        openBlockAndScroll({ booking_code: code, booking_id: id || undefined, guest_name: booking.guest_name || '' });
      }
    });
  } else {
    bcOnBedCalendarTabOpen();
    setTimeout(function(){
      loadBedCalendar(function(data){
        if (!tryOpenBlock(data.blocks) && code){
          openBlockAndScroll({ booking_code: code, booking_id: id || undefined, guest_name: booking.guest_name || '' });
        }
      });
    }, 0);
  }
}

window.openBookingInCalendar = openBookingInCalendar;

function wireInboxLeftListWheel(){
  var rows = document.querySelector('.inbox-left-rows');
  var left = el('inbox-card');
  if (!rows || !left || left.dataset.wheelWired === '1') return;
  left.dataset.wheelWired = '1';

  function scrollInboxLeftList(ev){
    if (ev.target.closest && ev.target.closest('.inbox-left-toolbar')) return;
    if (!ev.target.closest || !ev.target.closest('.inbox-left')) return;
    var scroller = rows;
    if (scroller.scrollHeight <= scroller.clientHeight + 1) return;
    var max = scroller.scrollHeight - scroller.clientHeight;
    var next = scroller.scrollTop + ev.deltaY;
    if (next < 0) next = 0;
    if (next > max) next = max;
    if (Math.abs(next - scroller.scrollTop) >= 0.5) scroller.scrollTop = next;
    ev.preventDefault();
    ev.stopPropagation();
  }

  left.addEventListener('wheel', scrollInboxLeftList, { passive: false, capture: true });
}

function convDetailHasLayout(targetEl){
  return !!(targetEl && targetEl.querySelector('.detail-layout'));
}

function buildConvDetailSkeleton(){
  return '<div class="detail-header">' +
    '<div><div class="detail-name conv-skeleton-line">&nbsp;</div>' +
    '<div class="detail-meta conv-skeleton-line short">&nbsp;</div></div>' +
    '<span id="conv-detail-load-status" class="conv-detail-load-status">Loading…</span></div>' +
    '<div class="detail-layout detail-layout-skeleton">' +
    '<div class="detail-main">' +
    '<div class="thread-section"><div class="thread"><div class="thread-messages thread-skeleton"></div></div></div>' +
    '<div class="draft-panel"><div class="draft-label">' +
    '<span style="font-size:11px;color:var(--text-3)">Reply:</span></div></div></div>' +
    '<div class="detail-sidebar"><div class="sidebar-card sidebar-card-skeleton"></div></div></div>';
}

/* A selection generation invalidates every pending detail completion for the prior row. */
var inboxSelectionGeneration = 0;
function inboxSelectionIsCurrent(convId, generation){
  return selectedConvId === convId && inboxSelectionGeneration === generation;
}
function clearInboxSelection(targetEl){
  selectedConvId = null;
  inboxSelectionGeneration += 1;
  targetEl = targetEl || el('detail-content');
  if (targetEl){
    targetEl.classList.remove('is-loading-detail');
    inboxParkRefreshBtn();
    targetEl.innerHTML = inboxEmptyDetailHtml();
  }
  hideInboxMobileThread();
}
function beginConvDetailLoad(targetEl){
  /* Do not leave the old guest actionable while a new selection loads. */
  inboxParkRefreshBtn();
  targetEl.innerHTML = buildConvDetailSkeleton();
  targetEl.classList.add('is-loading-detail');
}

var bcLastBookingContext = null;

function bcResolveConversationId(data){
  data = data || bcLastBookingContext || {};
  if (data.conversation && data.conversation.conversation_id) return data.conversation.conversation_id;
  return null;
}

function bcHasLinkedConversation(data){
  return !!bcResolveConversationId(data);
}

function bcShowOpenConversationStatus(msg){
  var statusEl = el('bc-open-conversation-status');
  if (statusEl) statusEl.textContent = msg || '';
}

function bcStartConversationFromBooking(data){
  data = data || bcLastBookingContext;
  if (!data || !data.booking) return;
  var bk = data.booking;
  var resultEl = el('bc-new-conversation-result');
  var toolbarBtn = el('bc-open-conversation-toolbar');
  var footerBtn = el('bc-new-conversation-btn');
  var openBtn = el('bc-open-conv-btn');
  var buttons = [toolbarBtn, footerBtn, openBtn].filter(Boolean);
  if (buttons.some(function(b){ return b.disabled; })) return;
  buttons.forEach(function(b){ b.disabled = true; });
  bcShowOpenConversationStatus('Starting conversation…');
  if (resultEl) resultEl.textContent = 'Starting conversation…';
  var client = getBcClient() || getClient();
  var idemKey = 'booking-drawer-conv-' + (bk.booking_id || bk.booking_code || 'unknown');
  fetch('/staff/bookings/create-conversation?client=' + encodeURIComponent(client), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      client_slug: client,
      booking_id: bk.booking_id || undefined,
      booking_code: bk.booking_code || undefined,
      location_id: client === 'sunset' ? getSunsetLocation() : undefined,
      idempotency_key: idemKey,
      reason: 'Created from booking drawer',
    }),
  })
    .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, data: j }; }); })
    .then(function(res){
      buttons.forEach(function(b){ b.disabled = false; });
      if (!res.ok || !res.data || !res.data.success){
        var errMsg = (res.data && res.data.error) || 'Could not start conversation';
        bcShowOpenConversationStatus(errMsg);
        if (resultEl){
          resultEl.innerHTML = '<span class="state-msg error">' + escHtml(errMsg) + '</span>';
        }
        return;
      }
      bcShowOpenConversationStatus('');
      if (resultEl) resultEl.textContent = '';
      var convId = res.data.conversation_id;
      if (!convId) return;
      bcLastBookingContext = Object.assign({}, data, {
        conversation: { conversation_id: convId, phone: bk.phone || null },
      });
      bcSyncConversationButtons(bcLastBookingContext);
      openInboxToConversation(convId);
    })
    .catch(function(e){
      buttons.forEach(function(b){ b.disabled = false; });
      var errMsg = e.message || 'Network error';
      bcShowOpenConversationStatus(errMsg);
      if (resultEl){
        resultEl.innerHTML = '<span class="state-msg error">' + escHtml(errMsg) + '</span>';
      }
    });
}

function bcOpenOrStartConversationFromBooking(data){
  data = data || bcLastBookingContext;
  var convId = bcResolveConversationId(data);
  if (convId){
    bcShowOpenConversationStatus('');
    openInboxToConversation(convId);
    return;
  }
  bcStartConversationFromBooking(data);
}

function bcSyncConversationButtons(data){
  if (data) bcLastBookingContext = data;
  var ctx = data || bcLastBookingContext;
  var toolbarBtn = el('bc-open-conversation-toolbar');
  if (!ctx){
    if (toolbarBtn){
      toolbarBtn.textContent = t('drawer.footer.startConv');
      toolbarBtn.disabled = true;
      toolbarBtn.onclick = null;
    }
    return;
  }
  var hasConv = bcHasLinkedConversation(ctx);
  var label = hasConv ? t('drawer.footer.openConv') : t('drawer.footer.startConv');
  var handler = function(){ bcOpenOrStartConversationFromBooking(ctx); };
  if (toolbarBtn){
    toolbarBtn.textContent = label;
    toolbarBtn.disabled = false;
    toolbarBtn.onclick = handler;
  }
  var openBtn = el('bc-open-conv-btn');
  if (openBtn){
    openBtn.textContent = t('drawer.footer.openConv');
    openBtn.onclick = handler;
  }
  var startBtn = el('bc-new-conversation-btn');
  if (startBtn){
    startBtn.textContent = t('drawer.footer.startConv');
    startBtn.onclick = handler;
  }
}

function bcWireOpenConversationButtons(data){
  bcSyncConversationButtons(data);
  bcSyncCustomerCardButton(data);
}

function bcResolveGuestPhone(data, blk) {
  data = data || bcLastBookingContext || null;
  blk = blk || bcLastOpenedBlock || null;
  var bk = (data && data.booking) || {};
  var raw = bk.phone
    || (data && data.conversation && data.conversation.phone)
    || (blk && blk.phone)
    || '';
  return normalizeCustomerPhoneClient(raw);
}

function bcSyncCustomerCardButton(data) {
  var btn = el('bc-open-customer-card');
  if (!btn) return;
  var phone = bcResolveGuestPhone(data);
  var show = !!phone && portalHasCustomersCrm(getPortalProfile(getClient()));
  btn.style.display = show ? '' : 'none';
  btn.disabled = !show;
  if (show) {
    btn.onclick = function() { openCustomerCardForPhone(phone); };
  } else {
    btn.onclick = null;
  }
}

function wireLunaPauseSwitch(convId, targetEl){
  targetEl = inboxThreadScope(targetEl);
  var sw = targetEl.querySelector('#luna-pause-switch');
  if (!sw) return;
  sw.addEventListener('change', function(){
    if (sw.disabled) return;
    var wantPaused = sw.checked;
    var path = wantPaused ? '/staff/bot/pause' : '/staff/bot/resume';
    var body = {
      client_slug: getClient(),
      conversation_id: convId,
    };
    if (wantPaused) body.pause_reason = 'Paused from Staff Portal Inbox';
    sw.disabled = true;
    setInboxLunaModeBusy(targetEl, true);
    setLunaPauseActionStatus(targetEl, 'Updating Luna status…', false);

    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function(r){
        return r.json().then(function(data){ return { ok: r.ok, status: r.status, data: data || {} }; });
      })
      .then(function(res){
        var data = res.data || {};
        if (res.status === 403 && (data.error === 'bot_pause_controls_disabled' || data.enabled === false)){
          sw.checked = !wantPaused;
          syncInboxLunaModeControl(targetEl, sw.checked);
          setLunaPauseActionStatus(targetEl, 'Pause controls are disabled.', true);
          sw.disabled = false;
          setInboxLunaModeBusy(targetEl, false);
          return;
        }
        if (!res.ok || !data.success){
          sw.checked = !wantPaused;
          syncInboxLunaModeControl(targetEl, sw.checked);
          setLunaPauseActionStatus(targetEl, data.error || 'Could not update Luna status.', true);
          sw.disabled = false;
          setInboxLunaModeBusy(targetEl, false);
          return;
        }
        setLunaPauseActionStatus(targetEl, '', false);
        updateLunaPauseUiInPlace(targetEl, wantPaused);
        patchInboxConvRow(convId, { luna_paused: wantPaused });
        updateInboxConvCardStatusPills(convId);
        bcUpdateDrawerConvBotModePebble(convId, wantPaused);
        sw.disabled = false;
        setInboxLunaModeBusy(targetEl, false);
      })
      .catch(function(err){
        sw.checked = !wantPaused;
        syncInboxLunaModeControl(targetEl, sw.checked);
        setLunaPauseActionStatus(targetEl, err.message || 'Could not update Luna status.', true);
        sw.disabled = false;
        setInboxLunaModeBusy(targetEl, false);
      });
  });
}

/* Render inbox conversation cards (left column) */
function renderInboxConvCardHtml(c, profile){
  var delBtn = (staffIsAdmin() && !c._is_demo_preview)
    ? '<button type="button" class="conv-card-delete" title="Delete conversation" aria-label="Delete conversation">&times;</button>'
    : '';
  var handoffLine = '';
  if (conversationHasOpenHandoff(c) && c.handoff_reason){
    handoffLine = '<div class="conv-card-handoff">' + escHtml(handoffLabel(c.handoff_reason)) + '</div>';
  } else if (c.needs_human && !conversationHasOpenHandoff(c)){
    handoffLine = '<div class="conv-card-handoff">' + escHtml(t('inbox.detail.meta.needsStaffReply')) + '</div>';
  }
  var demoClass = c._is_demo_preview ? ' conv-card-demo-preview' : '';
  if (profile && profile.is_surf_vertical) {
    var channel = c.channel || 'whatsapp';
    var contactLine = channel === 'email'
      ? (c.guest_email || c.email || '')
      : (c.phone || '');
    var subjectText = inboxEmailSubjectOf(c);
    var subjectLine = channel === 'email' && subjectText
      ? '<div class="conv-card-subject">' + escHtml(subjectText) + '</div>'
      : '';
    var previewLine = '';
    var timeLine = c.last_activity_label
      ? '<div class="conv-card-time">' + escHtml(c.last_activity_label) + '</div>'
      : '';
    return '<div class="conv-card' + demoClass + '" data-id="' + escHtml(c.conversation_id) + '">' +
      delBtn +
      '<div class="conv-card-header-row">' +
        '<div class="conv-card-name">' + escHtml(inboxPersonDisplayName(c)) + '</div>' +
      '</div>' +
      subjectLine +
      (contactLine ? '<div class="conv-card-contact">' + escHtml(contactLine) + '</div>' : '') +
      previewLine +
      '<div class="conv-card-meta-row">' +
        timeLine +
        '<div class="conv-card-pebbles">' +
          '<div class="conv-card-pills">' + convListPill(c) + '</div>' +
          inboxChannelBadgeHtml(channel) +
        '</div>' +
      '</div>' +
      handoffLine +
    '</div>';
  }
  return '<div class="conv-card conv-card-mobile-dense' + demoClass + '" data-id="' + escHtml(c.conversation_id) + '">' +
    delBtn +
    '<div class="conv-card-header-row">' +
      '<div class="conv-card-name">' + escHtml(inboxPersonDisplayName(c)) + '</div>' +
    '</div>' +
    ((c.phone && !inboxIsOpaqueEmailIdentity(c.phone)) ? '<div class="conv-card-phone">' + escHtml(c.phone) + '</div>' : '') +
    '<div class="conv-card-meta-row">' +
      (c.last_activity_label ? '<div class="conv-card-time">' + escHtml(c.last_activity_label) + '</div>' : '') +
      '<div class="conv-card-pebbles">' +
        '<div class="conv-card-pills">' + convListPill(c) + '</div>' +
        inboxChannelBadgeHtml('whatsapp') +
      '</div>' +
    '</div>' +
    handoffLine +
  '</div>';
}

function renderInbox(convs, opts){
  opts = opts || {};
  var list = el('conv-list');
  var profile = getPortalProfile(getClient());
  updateInboxPreviewBanner(convs);
  if (!convs || convs.length === 0){
    var emptyMsg = inboxEmptyListMessage();
    if (opts.preserveDetail && (opts.selectedId || selectedConvId)){
      el('inbox-state').style.display = 'none';
      if (list) list.innerHTML = '<div class="conv-list-empty">' + escHtml(emptyMsg) + '</div>';
      updateInboxPreviewBanner([]);
      return;
    }
    el('inbox-state').textContent = emptyMsg;
    el('inbox-state').classList.remove('error');
    el('inbox-state').style.display = 'block';
    if (list) list.innerHTML = '<div class="conv-list-empty">' + escHtml(emptyMsg) + '</div>';
    selectedConvId = null;
    el('detail-content').innerHTML = inboxEmptyDetailHtml();
    hideInboxMobileThread();
    updateInboxPreviewBanner([]);
    return;
  }
  el('inbox-state').style.display = 'none';

  /* A filter must never leave an invisible guest selected or choose a replacement. */
  var selectionDropped = false;
  if (selectedConvId && !convs.some(function(c){ return c.conversation_id === selectedConvId; })){
    clearInboxSelection();
    selectionDropped = true;
  }

  var cards = convs.map(function(c){
    return renderInboxConvCardHtml(c, profile);
  }).join('');

  if (list) {
    list.innerHTML = cards;
    list.querySelectorAll('.conv-card').forEach(function(card){
      var del = card.querySelector('.conv-card-delete');
      if (del){
        del.addEventListener('click', function(ev){
          ev.stopPropagation();
          wireDeleteConversation(card.dataset.id);
        });
      }
      card.addEventListener('click', function(){
        list.querySelectorAll('.conv-card').forEach(function(c){ c.classList.remove('selected'); });
        this.classList.add('selected');
        loadConvDetail(this.dataset.id);
      });
    });
    if (opts.preserveDetail && !selectionDropped){
      var keepId = opts.selectedId || selectedConvId;
      if (keepId){
        var keepCard = list.querySelector('.conv-card[data-id="' + keepId + '"]');
        if (keepCard){
          list.querySelectorAll('.conv-card').forEach(function(c){ c.classList.remove('selected'); });
          keepCard.classList.add('selected');
        }
      }
      return;
    }
    /* Initial load may select the top row; a filter may not replace a dropped selection. */
    var pickId = null;
    var selectionRetained = false;
    if (!selectionDropped){
      if (selectedConvId && convs.some(function(c){ return c.conversation_id === selectedConvId; })){
        pickId = selectedConvId;
        selectionRetained = true;
      } else {
        pickId = convs[0].conversation_id;
      }
    }
    if (pickId && !isPortalMobile()){
      var pickCard = list.querySelector('.conv-card[data-id="' + pickId + '"]');
      if (pickCard){
        list.querySelectorAll('.conv-card').forEach(function(c){ c.classList.remove('selected'); });
        pickCard.classList.add('selected');
        if (!selectionRetained) loadConvDetail(pickId);
      }
    }
  }
}

/* Switch to Inbox, reload list, and open the given conversation in the detail panel. */
function openInboxToConversation(convId){
  if (!convId) return;
  switchToTab('conversations', 'inbox');
  selectedConvId = convId;
  var detailEl = el('detail-content');
  if (detailEl){
    el('conv-detail').classList.add('visible');
    beginConvDetailLoad(detailEl);
  }
  loadInbox(convId);
}

/**
 * Customers card phone/email (Slice 1): open existing conversation by digits-only phone match.
 * No conversation create — leave on Customers and flash quiet empty state.
 */
function openInboxToPhone(phone, cardEl){
  var norm = String(phone || '').replace(/\D/g, '');
  if (!norm) return;
  function flashNote(txt){
    if (!cardEl) return;
    var old = cardEl.querySelector('.customers-card-conv-empty');
    if (old) old.remove();
    var note = document.createElement('div');
    note.className = 'customers-card-conv-empty';
    note.textContent = txt;
    var body = cardEl.querySelector('.customers-card-body') || cardEl;
    body.appendChild(note);
    setTimeout(function(){
      if (note.parentNode) note.parentNode.removeChild(note);
    }, 3200);
  }
  if (cardEl) {
    var old = cardEl.querySelector('.customers-card-conv-empty');
    if (old) old.remove();
  }
  fetch('/staff/conversations' + inboxClientQuery())
    .then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data){
      var list = (data && data.success && data.conversations) ? data.conversations : [];
      for (var i = 0; i < list.length; i++) {
        var cDigits = String(list[i].phone || '').replace(/\D/g, '');
        if (cDigits && cDigits === norm && list[i].conversation_id) {
          openInboxToConversation(list[i].conversation_id);
          return;
        }
      }
      // Slice 2: no existing conversation — create it for this contact, then open.
      flashNote('Starting conversation…');
      fetch('/staff/customers/' + encodeURIComponent(phone) + '/create-conversation?client=' + encodeURIComponent(getClient()), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          idempotency_key: 'customers-card-conv-' + norm,
          reason: 'Created from Customers card',
        }),
      })
        .then(function(r){ return r.json().then(function(body){ return { ok: r.ok, body: body }; }); })
        .then(function(res){
          if (!res.ok || !res.body || !res.body.success || !res.body.conversation_id) {
            throw new Error((res.body && res.body.error) || 'create failed');
          }
          openInboxToConversation(res.body.conversation_id);
        })
        .catch(function(){ flashNote('Couldn’t start conversation'); });
    })
    .catch(function(){ flashNote('Couldn’t open conversation'); });
}

/* Load inbox — optional selectConvIdAfterLoad opens that conversation after refresh. */
function loadInbox(selectConvIdAfterLoad, opts){
  opts = opts || {};
  var silent = !!opts.silent;
  var preserveDetail = !!opts.preserveDetail;
  var keepConvId = selectConvIdAfterLoad || (preserveDetail ? selectedConvId : null);

  if (!silent){
    el('inbox-state').textContent = 'Loading conversations…';
    el('inbox-state').classList.remove('error');
    el('inbox-state').style.display = 'block';
    if (el('conv-list')) el('conv-list').innerHTML = '';
    selectedConvId = null;
    el('detail-content').innerHTML = inboxEmptyDetailHtml();
    hideInboxMobileThread();
  }

  fetch('/staff/conversations' + inboxClientQuery())
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
      if (!data) return;
      if (!data.success) throw new Error(data.error || 'API error');
      renderInboxSchoolContext(data.channel_config || null);
      inboxConversationsCache = mergeSurfInboxConversations(data.conversations || [], getPortalProfile(getClient()));
      var nhCount = inboxConversationsCache.filter(conversationNeedsHuman).length;
      var badge = el('hq-badge');
      if (badge){ badge.textContent = nhCount; badge.classList.toggle('visible', nhCount > 0); }
      if (selectConvIdAfterLoad) selectedConvId = selectConvIdAfterLoad;
      else if (keepConvId) selectedConvId = keepConvId;
      applyInboxFilter({
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
      el('inbox-state').textContent = 'Error loading inbox: ' + err.message;
      el('inbox-state').classList.add('error');
      el('inbox-state').style.display = 'block';
    });
}

function simpleDraftHash(text){
  var s = String(text || '').trim();
  var h = 0;
  for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function buildStaffReplyIdempotencyKey(clientSlug, convId, messageText){
  return 'staff-reply:' + clientSlug + ':' + convId + ':' + simpleDraftHash(messageText);
}

function inboxEmailSentStatusMs(){
  var override = (typeof window !== 'undefined') ? window.__INBOX_EMAIL_SENT_STATUS_MS : null;
  var n = Number(override);
  if (n > 0 && isFinite(n)) return n;
  return INBOX_EMAIL_SENT_STATUS_MS;
}

function showDraftSendStatus(el, kind, message){
  if (!el) return;
  if (el._inboxStatusTimer) {
    clearTimeout(el._inboxStatusTimer);
    el._inboxStatusTimer = null;
  }
  el.className = 'draft-send-status is-visible ' + (kind || '');
  el.textContent = message || '';
  if (kind === 'ok' && message === 'Email sent') {
    el._inboxStatusTimer = setTimeout(function(){
      el._inboxStatusTimer = null;
      if (el.textContent === 'Email sent') {
        el.className = 'draft-send-status';
        el.textContent = '';
      }
    }, inboxEmailSentStatusMs());
  }
}

function performInboxSend(convId, phone, targetEl){
  var sendBtn = targetEl.querySelector('#btn-send-reply');
  var textaEl = targetEl.querySelector('#draft-textarea');
  var statusEl = targetEl.querySelector('#draft-send-status');
  if (!sendBtn || !textaEl || sendBtn.disabled) return;

  var messageText = (textaEl.value || '').trim();
  if (!messageText) return;

  sendBtn.disabled = true;
  showDraftSendStatus(statusEl, '', 'Sending…');

  var client = getClient();
  var idemKey = buildStaffReplyIdempotencyKey(client, convId, messageText);

  fetch('/staff/inbox/send-reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_slug: client,
      conversation_id: convId,
      to: phone || '',
      message_text: messageText,
      idempotency_key: idemKey,
    }),
  })
    .then(function(r){
      if (r.status === 401) throw new Error('Authentication required');
      return r.json().then(function(data){ return { status: r.status, data: data }; });
    })
    .then(function(out){
      var d = out.data || {};
      if (d.send_performed === true || (d.success === true && d.whatsapp_message_id)){
        var sentMsg = 'Sent';
        if (d.whatsapp_message_id) sentMsg += ' (' + d.whatsapp_message_id + ')';
        showDraftSendStatus(statusEl, 'ok', sentMsg);
        loadConvDetail(convId, targetEl);
        return;
      }
      if (d.duplicate === true || d.idempotent_replay === true){
        showDraftSendStatus(statusEl, 'ok', 'Already sent');
        loadConvDetail(convId, targetEl);
        return;
      }
      if (d.blocked_reasons && d.blocked_reasons.length){
        showDraftSendStatus(statusEl, 'blocked', 'Send blocked: ' + d.blocked_reasons.join(', '));
        sendBtn.disabled = false;
        return;
      }
      throw new Error(d.error || ('HTTP ' + out.status));
    })
    .catch(function(err){
      showDraftSendStatus(statusEl, 'error', err.message || 'Send failed');
      sendBtn.disabled = false;
    });
}

/* ── Gate 3 email draft/approve UI (default-off; channel==='email' only) ── */
var EMAIL_DRAFT_MAX_UTF8_BYTES = 8000;
var INBOX_EMAIL_SENT_STATUS_MS = 20000;
var EMAIL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var EMAIL_DRAFT_OK_KEYS = ['success','conversation_id','message_text','approval_id'];
var EMAIL_CREATE_DRAFT_OK_KEYS = ['success','conversation_id','message_text'];
var EMAIL_APPROVE_503_KEYS = ['success','error','conversation_id','approval_id','approval_state'];
var EMAIL_APPROVE_OK_KEYS = ['success','conversation_id','approval_id','approval_state'];
var _emailReplyStateByConv = Object.create(null);
var _emailUtf8Encoder = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
function staffEmailDraftsUiEnabled(){ return window.__EMAIL_STAFF_EMAIL_DRAFTS_ENABLED__ === true; }
function staffEmailOutboundUiEnabled(){ return window.__EMAIL_STAFF_OUTBOUND_ENABLED__ === true; }
function staffEmailLunaDraftUiEnabled(){ return window.__EMAIL_STAFF_LUNA_DRAFT_ENABLED__ === true; }
/** Authoritative email channel only — never infer. */
function isAuthoritativeEmailConversation(c){
  return !!(c && c.channel === 'email');
}
function emailUtf8ByteLength(text){
  var s = String(text == null ? '' : text);
  try {
    if (_emailUtf8Encoder) return _emailUtf8Encoder.encode(s).length;
  } catch (_e) { /* fall through */ }
  try { return unescape(encodeURIComponent(s)).length; } catch (_e2) { return s.length; }
}
function emailOwnData(o, k){
  try {
    if (!o || typeof o !== 'object' || !Object.prototype.hasOwnProperty.call(o, k)) return undefined;
    var d = Object.getOwnPropertyDescriptor(o, k);
    return (d && Object.prototype.hasOwnProperty.call(d, 'value') && !d.get && !d.set && d.enumerable) ? d.value : undefined;
  } catch (_e) { return undefined; }
}
function emailIsPlainOwnObject(o){
  try { return !!(o && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype); }
  catch (_e) { return false; }
}
function emailExactPlainKeys(o, keys){
  try {
    if (!emailIsPlainOwnObject(o)) return false;
    var actual = Object.keys(o);
    if (actual.length !== keys.length) return false;
    for (var i = 0; i < keys.length; i++) {
      if (actual.indexOf(keys[i]) < 0) return false;
      var d = Object.getOwnPropertyDescriptor(o, keys[i]);
      if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || !d.enumerable) return false;
    }
    return true;
  } catch (_e) { return false; }
}
function emailCanonicalUuid(raw){
  if (typeof raw !== 'string') return null;
  var t = raw.trim().toLowerCase();
  return EMAIL_UUID_RE.test(t) ? t : null;
}
function acceptEmailDraftSuccess(data, reqConvId, reqText){
  try {
    if (!emailExactPlainKeys(data, EMAIL_DRAFT_OK_KEYS) || emailOwnData(data, 'success') !== true) return null;
    var cid = emailCanonicalUuid(emailOwnData(data, 'conversation_id'));
    var ap = emailCanonicalUuid(emailOwnData(data, 'approval_id'));
    if (!cid || cid !== String(reqConvId || '').toLowerCase() || emailOwnData(data, 'message_text') !== reqText || !ap) return null;
    return { conversation_id: cid, message_text: reqText, approval_id: ap };
  } catch (_e) { return null; }
}
function acceptEmailCreateDraftSuccess(data, reqConvId){
  try {
    if (!emailExactPlainKeys(data, EMAIL_CREATE_DRAFT_OK_KEYS) || emailOwnData(data, 'success') !== true) return null;
    var cid = emailCanonicalUuid(emailOwnData(data, 'conversation_id'));
    var text = emailOwnData(data, 'message_text');
    if (!cid || cid !== String(reqConvId || '').toLowerCase() || typeof text !== 'string' || !text.length) return null;
    return { conversation_id: cid, message_text: text };
  } catch (_e) { return null; }
}
function acceptEmailApproveDisabled503(data, reqConvId, savedApprovalId){
  try {
    if (!emailExactPlainKeys(data, EMAIL_APPROVE_503_KEYS) || emailOwnData(data, 'success') !== false) return null;
    if (emailOwnData(data, 'error') !== 'email_send_disabled') return null;
    var st = emailOwnData(data, 'approval_state');
    if (st !== 'draft' && st !== 'approved') return null;
    var cid = emailCanonicalUuid(emailOwnData(data, 'conversation_id'));
    var ap = emailCanonicalUuid(emailOwnData(data, 'approval_id'));
    var want = emailCanonicalUuid(savedApprovalId);
    if (!cid || cid !== String(reqConvId || '').toLowerCase() || !ap || !want || ap !== want) return null;
    return { conversation_id: cid, approval_id: ap, approval_state: st };
  } catch (_e) { return null; }
}
/** Exact production approve-send 200 committed DTO only — conversation+approval ownership. */
function acceptEmailApproveSuccess(data, reqConvId, savedApprovalId){
  try {
    if (!emailExactPlainKeys(data, EMAIL_APPROVE_OK_KEYS) || emailOwnData(data, 'success') !== true) return null;
    if (emailOwnData(data, 'approval_state') !== 'approved') return null;
    var cid = emailCanonicalUuid(emailOwnData(data, 'conversation_id'));
    var ap = emailCanonicalUuid(emailOwnData(data, 'approval_id'));
    var want = emailCanonicalUuid(savedApprovalId);
    if (!cid || cid !== String(reqConvId || '').toLowerCase() || !ap || !want || ap !== want) return null;
    return { conversation_id: cid, approval_id: ap, approval_state: 'approved' };
  } catch (_e) { return null; }
}
function emailUiFailureCopy(op, status, data){
  var c = (typeof status === 'number' && isFinite(status)) ? status : 0;
  var err = emailOwnData(data, 'error');
  if (c === 400) return 'Request rejected';
  if (c === 401 || c === 403) return 'Unauthorized';
  if (c === 404 && err === 'email_drafts_unavailable') return 'Email drafting is unavailable.';
  if (c === 404 && err === 'email_staff_replies_unavailable') return 'Staff email replies are currently disabled.';
  if (c === 404) return 'Conversation unavailable';
  if (c === 409 && err === 'email_mailbox_not_sendable') {
    return 'This conversation is not on the Microsoft Inbox mailbox, so it cannot be sent.';
  }
  if (c === 409) return 'Conflict — reload and try again';
  if (c === 503 && err === 'email_send_disabled') return 'Staff email replies are currently disabled.';
  if (c === 503 && err === 'email_send_outcome_unknown') {
    return 'Send outcome is unknown. Reload this conversation — do not retry.';
  }
  if (c === 503 && err === 'email_create_draft_unavailable') return 'Could not create draft. Reload and try again.';
  if (c === 503) return 'Temporarily unavailable';
  if (op === 'create') return 'Create draft failed';
  return op === 'approve' ? 'Approve failed' : 'Save failed';
}
function emailParseFetchJson(r){
  return r.text().then(function(raw){
    try {
      return { status: r.status, data: (raw == null || raw === '') ? null : JSON.parse(raw), parseOk: true };
    } catch (_e) { return { status: r.status, data: null, parseOk: false }; }
  });
}
function emailReplyState(convId){
  var id = String(convId || '');
  if (!_emailReplyStateByConv[id]) {
    _emailReplyStateByConv[id] = { approvalId: null, locked: false, sent: false, savedText: '', savedSubject: '', seq: 0, inFlight: false, generationUncertain: false };
  }
  return _emailReplyStateByConv[id];
}
function updateEmailDraftByteCount(targetEl, text){
  var elCount = targetEl && targetEl.querySelector('#email-draft-byte-count');
  if (!elCount) return 0;
  var n = emailUtf8ByteLength(text);
  elCount.textContent = n + ' / ' + EMAIL_DRAFT_MAX_UTF8_BYTES + ' bytes';
  if (n > EMAIL_DRAFT_MAX_UTF8_BYTES) elCount.classList.add('is-over');
  else elCount.classList.remove('is-over');
  return n;
}
function setEmailReplyControlsDisabled(targetEl, disabled, locked){
  if (!targetEl) return;
  var ta = targetEl.querySelector('#draft-textarea');
  var subjectEl = targetEl.querySelector('#inbox-email-reply-subject');
  var saveBtn = targetEl.querySelector('#btn-email-save-draft');
  var apprBtn = targetEl.querySelector('#btn-email-approve-send');
  var lunaBtn = targetEl.querySelector('#btn-email-generate-luna-draft');
  var createBtn = targetEl.querySelector('#btn-email-create-draft');
  var contextEl = targetEl.querySelector('#inbox-email-create-draft-context');
  var freeze = !!(disabled || locked);
  if (ta) ta.disabled = freeze;
  if (subjectEl) subjectEl.disabled = freeze;
  if (saveBtn) saveBtn.disabled = freeze;
  if (apprBtn) apprBtn.disabled = freeze;
  if (lunaBtn) lunaBtn.disabled = freeze;
  if (createBtn) createBtn.disabled = freeze;
  if (contextEl) contextEl.disabled = freeze;
}
function emailReplyActionPanel(buttonEl, targetEl){
  if (!buttonEl || !targetEl || typeof buttonEl.closest !== 'function') return null;
  var panel = buttonEl.closest('.draft-panel');
  if (!panel || !targetEl.contains(panel)) return null;
  if (panel.querySelectorAll('#draft-textarea').length !== 1) return null;
  if (panel.querySelectorAll('#btn-email-save-draft').length !== 1) return null;
  return panel;
}
function performEmailCreateDraft(convId, targetEl){
  var st = emailReplyState(convId);
  var ta = targetEl.querySelector('#draft-textarea');
  var statusEl = targetEl.querySelector('#draft-send-status');
  var contextEl = targetEl.querySelector('#inbox-email-create-draft-context');
  if (!ta || st.locked || st.inFlight || st.generationUncertain) return;
  var snapConv = String(convId);
  var mySeq = ++st.seq;
  st.inFlight = true;
  setEmailReplyControlsDisabled(targetEl, true, false);
  showDraftSendStatus(statusEl, '', 'Creating draft…');
  var contextText = contextEl ? String(contextEl.value == null ? '' : contextEl.value) : '';
  fetch('/staff/inbox/email/create-draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: convId, context: contextText }),
  })
  .then(emailParseFetchJson).then(function(out){
    if (mySeq !== st.seq) return;
    st.inFlight = false;
    var accepted = out.parseOk && out.status === 200 ? acceptEmailCreateDraftSuccess(out.data, snapConv) : null;
    if (accepted) { st.approvalId = null; st.savedText = accepted.message_text; st.generationUncertain = false; }
    if (selectedConvId !== snapConv) return;
    if (accepted) {
      ta.value = accepted.message_text;
      updateEmailDraftByteCount(targetEl, ta.value);
      showDraftSendStatus(statusEl, 'ok', 'Draft created — review before sending.');
    } else if (out.status === 409) {
      showDraftSendStatus(statusEl, 'blocked', 'Conflict — reload and try again');
    } else if (!out.parseOk || (out.status === 200 && !accepted)) {
      st.approvalId = null; st.savedText = ''; st.generationUncertain = true;
      showDraftSendStatus(statusEl, 'blocked', 'Draft save outcome is unknown. Reload the conversation or page before creating again.');
    } else {
      showDraftSendStatus(statusEl, 'error', emailUiFailureCopy('create', out.status, out.data));
    }
    setEmailReplyControlsDisabled(targetEl, st.generationUncertain, st.locked);
  }).catch(function(){
    if (mySeq !== st.seq) return;
    st.inFlight = false;
    st.approvalId = null;
    st.savedText = '';
    st.generationUncertain = true;
    if (selectedConvId !== snapConv) return;
    showDraftSendStatus(statusEl, 'blocked', 'Draft save outcome is unknown. Reload the conversation or page before creating again.');
    setEmailReplyControlsDisabled(targetEl, true, st.locked);
  });
}
function performEmailLunaDraftGenerate(convId, targetEl){
  var st=emailReplyState(convId),ta=targetEl.querySelector('#draft-textarea'),statusEl=targetEl.querySelector('#draft-send-status');
  if(!ta||st.locked||st.inFlight||st.generationUncertain)return;
  var snapConv=String(convId),mySeq=++st.seq;st.inFlight=true;setEmailReplyControlsDisabled(targetEl,true,false);
  showDraftSendStatus(statusEl,'','Generating Luna draft…');
  fetch('/staff/inbox/email/generate-luna-draft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({conversation_id:convId})})
  .then(emailParseFetchJson).then(function(out){
    if(mySeq!==st.seq)return;st.inFlight=false;
    var text=out.parseOk?emailOwnData(out.data,'message_text'):null;
    var accepted=out.status===200?acceptEmailDraftSuccess(out.data,snapConv,text):null;
    var unavailable=out.status===503&&emailOwnData(out.data,'error')==='luna_email_generation_capability_unavailable'&&emailOwnData(out.data,'reason')==='authoritative_content_and_grounded_policy_not_configured';
    var outcomeUnknown=!out.parseOk||(out.status===200&&!accepted)||(out.status===503&&emailOwnData(out.data,'error')==='draft_save_outcome_unknown');
    if(accepted){st.approvalId=accepted.approval_id;st.savedText=accepted.message_text;st.generationUncertain=false;}
    if(outcomeUnknown||unavailable){st.approvalId=null;st.savedText='';st.generationUncertain=true;}
    if(selectedConvId!==snapConv)return;
    if(accepted){ta.value=accepted.message_text;updateEmailDraftByteCount(targetEl,ta.value);showDraftSendStatus(statusEl,'ok','Luna draft generated — review and edit before approval.');}
    else if(out.status===422)showDraftSendStatus(statusEl,'blocked','Luna handoff required; draft was not changed.');
    else if(unavailable)showDraftSendStatus(statusEl,'blocked','Luna email generation is unavailable: authoritative email content and grounded policy are not configured. Reload the conversation or page before trying again.');
    else if(outcomeUnknown)showDraftSendStatus(statusEl,'blocked','Draft save outcome is unknown. Reload the conversation or page before generating again.');
    else showDraftSendStatus(statusEl,'error','Draft generation failed.');
    setEmailReplyControlsDisabled(targetEl,st.generationUncertain,st.locked);
  }).catch(function(){if(mySeq!==st.seq)return;st.inFlight=false;st.approvalId=null;st.savedText='';st.generationUncertain=true;if(selectedConvId!==snapConv)return;showDraftSendStatus(statusEl,'blocked','Draft save outcome is unknown. Reload the conversation or page before generating again.');setEmailReplyControlsDisabled(targetEl,true,st.locked);});
}
function performEmailDraftSave(convId, targetEl, thenApprove){
  var st = emailReplyState(convId);
  var ta = targetEl.querySelector('#draft-textarea');
  var statusEl = targetEl.querySelector('#draft-send-status');
  if (!ta || st.locked || st.inFlight) return;
  var messageText = String(ta.value == null ? '' : ta.value);
  var subjectEl = targetEl.querySelector('#inbox-email-reply-subject');
  var subjectText = subjectEl ? String(subjectEl.value == null ? '' : subjectEl.value).trim() : '';
  var bytes = emailUtf8ByteLength(messageText);
  if (!messageText.length) {
    showDraftSendStatus(statusEl, 'error', 'Enter a reply before saving a draft.');
    return;
  }
  if (bytes > EMAIL_DRAFT_MAX_UTF8_BYTES) {
    showDraftSendStatus(statusEl, 'error', 'Message exceeds 8,000 UTF-8 bytes.');
    return;
  }
  var snapConv = String(convId);
  var snapText = messageText;
  var mySeq = ++st.seq;
  st.inFlight = true;
  setEmailReplyControlsDisabled(targetEl, true, false);
  showDraftSendStatus(statusEl, '', 'Saving draft…');
  fetch('/staff/inbox/email/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_id: convId,
      message_text: messageText,
      subject: subjectText,
      email_subject: subjectText,
      approval_id: st.approvalId == null ? null : st.approvalId,
    }),
  })
    .then(emailParseFetchJson)
    .then(function(out){
      if (mySeq !== st.seq) return;
      st.inFlight = false;
      if (!out.parseOk) {
        if (selectedConvId !== snapConv) return;
        showDraftSendStatus(statusEl, 'error', 'Invalid response');
        setEmailReplyControlsDisabled(targetEl, false, st.locked);
        return;
      }
      var accepted = (out.status >= 200 && out.status < 300) ? acceptEmailDraftSuccess(out.data, snapConv, snapText) : null;
      if (accepted) {
        st.approvalId = accepted.approval_id;
        st.savedText = snapText;
        st.savedSubject = subjectText;
      }
      if (selectedConvId !== snapConv) return;
      if (accepted) {
        if (thenApprove) {
          setEmailReplyControlsDisabled(targetEl, false, st.locked);
          performEmailApproveSend(convId, targetEl);
          return;
        }
        showDraftSendStatus(statusEl, 'ok', 'Draft saved');
        setEmailReplyControlsDisabled(targetEl, false, st.locked);
        return;
      }
      showDraftSendStatus(statusEl, 'error', emailUiFailureCopy('draft', out.status, out.data));
      setEmailReplyControlsDisabled(targetEl, false, st.locked);
    })
    .catch(function(){
      if (mySeq !== st.seq) return;
      st.inFlight = false;
      if (selectedConvId !== snapConv) return;
      showDraftSendStatus(statusEl, 'error', emailUiFailureCopy('draft', 0));
      setEmailReplyControlsDisabled(targetEl, false, st.locked);
    });
}
function performEmailApproveSend(convId, targetEl){
  var st = emailReplyState(convId);
  var ta = targetEl.querySelector('#draft-textarea');
  var statusEl = targetEl.querySelector('#draft-send-status');
  if (!ta || st.locked || st.sent || st.inFlight || st.generationUncertain) return;
  if (!staffEmailOutboundUiEnabled()) {
    showDraftSendStatus(statusEl, 'blocked', 'Email sending is disabled; draft not approved.');
    return;
  }
  var messageText = String(ta.value == null ? '' : ta.value);
  var subjectEl = targetEl.querySelector('#inbox-email-reply-subject');
  var subjectText = subjectEl ? String(subjectEl.value == null ? '' : subjectEl.value).trim() : (st.savedSubject || '');
  var bytes = emailUtf8ByteLength(messageText);
  if (!messageText.length || bytes > EMAIL_DRAFT_MAX_UTF8_BYTES) {
    showDraftSendStatus(statusEl, 'error', !messageText.length ? 'Enter a reply before approving.' : 'Message exceeds 8,000 UTF-8 bytes.');
    return;
  }
  if (!st.approvalId || messageText !== st.savedText || subjectText !== String(st.savedSubject || '')) {
    performEmailDraftSave(convId, targetEl, true);
    return;
  }
  var snapConv = String(convId);
  var snapApprovalId = st.approvalId;
  var snapText = messageText;
  var mySeq = ++st.seq;
  st.inFlight = true;
  setEmailReplyControlsDisabled(targetEl, true, true);
  showDraftSendStatus(statusEl, '', 'Approving…');
  fetch('/staff/inbox/email/approve-send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_id: convId,
      message_text: messageText,
      subject: subjectText,
      email_subject: subjectText,
      approval_id: snapApprovalId,
    }),
  })
    .then(emailParseFetchJson)
    .then(function(out){
      if (mySeq !== st.seq) return;
      st.inFlight = false;
      if (selectedConvId !== snapConv) return;
      if (st.approvalId !== snapApprovalId || st.savedText !== snapText) {
        setEmailReplyControlsDisabled(targetEl, false, st.locked);
        return;
      }
      if (!out.parseOk) {
        showDraftSendStatus(statusEl, 'error', 'Invalid response');
        setEmailReplyControlsDisabled(targetEl, false, st.locked);
        return;
      }
      if (out.status === 200) {
        var committed = acceptEmailApproveSuccess(out.data, snapConv, snapApprovalId);
        if (committed) {
          ta.value = '';
          updateEmailDraftByteCount(targetEl, '');
          st.savedText = '';
          st.approvalId = null;
          st.locked = false;
          st.sent = false;
          showDraftSendStatus(statusEl, 'ok', 'Email sent');
          setEmailReplyControlsDisabled(targetEl, false, false);
          // Refresh thread bubbles only — do not rebuild the draft panel (status/locks).
          try {
            fetch('/staff/conversations/' + encodeURIComponent(snapConv) + '/messages' + inboxClientQuery())
              .then(function(r){ return r.json(); })
              .then(function(data){
                if (selectedConvId !== snapConv) return;
                var container = el('thread-container');
                if (!container || !data || !data.success) return;
                var msgs = data.messages || [];
                container.innerHTML = renderInboxThreadMessagesHtml(msgs);
                inboxThreadMessageSig = threadMessagesFingerprint(msgs);
              }).catch(function(){ /* best-effort thread mirror refresh */ });
          } catch (_reload) { /* ignore */ }
          return;
        }
        showDraftSendStatus(statusEl, 'error', emailUiFailureCopy('approve', out.status, out.data));
        setEmailReplyControlsDisabled(targetEl, false, st.locked);
        return;
      }
      if (out.status === 503) {
        if (emailOwnData(out.data, 'error') === 'email_send_outcome_unknown') {
          st.locked = true;
          showDraftSendStatus(statusEl, 'blocked', emailUiFailureCopy('approve', 503, out.data));
          setEmailReplyControlsDisabled(targetEl, false, true);
          return;
        }
        var accepted = acceptEmailApproveDisabled503(out.data, snapConv, snapApprovalId);
        if (accepted && accepted.approval_state === 'approved') {
          if (ta.value !== snapText) ta.value = snapText;
          updateEmailDraftByteCount(targetEl, snapText);
          st.savedText = snapText;
          st.locked = true;
          showDraftSendStatus(statusEl, 'blocked', 'Approved — email sending is currently disabled');
          setEmailReplyControlsDisabled(targetEl, false, true);
          return;
        }
        if (accepted && accepted.approval_state === 'draft') {
          showDraftSendStatus(statusEl, 'blocked', 'Email sending is disabled; draft not approved.');
          setEmailReplyControlsDisabled(targetEl, false, false);
          return;
        }
        showDraftSendStatus(statusEl, 'error', emailUiFailureCopy('approve', 503));
        setEmailReplyControlsDisabled(targetEl, false, st.locked);
        return;
      }
      showDraftSendStatus(statusEl, 'error', emailUiFailureCopy('approve', out.status, out.data));
      setEmailReplyControlsDisabled(targetEl, false, st.locked);
    })
    .catch(function(){
      if (mySeq !== st.seq) return;
      st.inFlight = false;
      if (selectedConvId !== snapConv) return;
      showDraftSendStatus(statusEl, 'error', emailUiFailureCopy('approve', 0));
      setEmailReplyControlsDisabled(targetEl, false, st.locked);
    });
}
function wireInboxEmailReply(convId, targetEl){
  var ta = targetEl.querySelector('#draft-textarea');
  var saveBtn = targetEl.querySelector('#btn-email-save-draft');
  var apprBtn = targetEl.querySelector('#btn-email-approve-send');
  var lunaBtn = targetEl.querySelector('#btn-email-generate-luna-draft');
  var createBtn = targetEl.querySelector('#btn-email-create-draft');
  if (!ta || !saveBtn) return;
  var st = emailReplyState(convId);
  if (st.locked || st.sent) {
    ta.value = st.savedText || ta.value;
    setEmailReplyControlsDisabled(targetEl, false, true);
  } else if (st.generationUncertain) {
    ta.value = '';
    showDraftSendStatus(targetEl.querySelector('#draft-send-status'), 'blocked', 'Draft save outcome is unknown. Reload the conversation or page before generating again.');
    setEmailReplyControlsDisabled(targetEl, true, false);
  } else if (st.inFlight) {
    setEmailReplyControlsDisabled(targetEl, true, false);
  } else if (st.savedText) {
    ta.value = st.savedText;
  }
  updateEmailDraftByteCount(targetEl, ta.value);
  ta.addEventListener('input', function(){
    updateEmailDraftByteCount(targetEl, ta.value);
  });
  saveBtn.addEventListener('click', function(){
    var panel = emailReplyActionPanel(saveBtn, targetEl);
    if (panel) performEmailDraftSave(convId, panel);
  });
  if (lunaBtn) lunaBtn.addEventListener('click', function(){
    var panel = emailReplyActionPanel(lunaBtn, targetEl);
    if (panel) performEmailLunaDraftGenerate(convId, panel);
  });
  if (createBtn) createBtn.addEventListener('click', function(){
    var panel = emailReplyActionPanel(createBtn, targetEl);
    if (panel) performEmailCreateDraft(convId, panel);
  });
  if (apprBtn) apprBtn.addEventListener('click', function(){
    var panel = emailReplyActionPanel(apprBtn, targetEl);
    if (panel) performEmailApproveSend(convId, panel);
  });
}

function wireInboxSendReply(convId, phone, targetEl){
  var sendBtn = targetEl.querySelector('#btn-send-reply');
  var textaEl = targetEl.querySelector('#draft-textarea');
  if (!sendBtn || !textaEl) return;

  sendBtn.addEventListener('click', function(){
    var messageText = (textaEl.value || '').trim();
    if (!messageText){
      showDraftSendStatus(targetEl.querySelector('#draft-send-status'), 'error', 'Enter a reply before sending.');
      return;
    }
    performInboxSend(convId, phone, targetEl);
  });

  textaEl.addEventListener('keydown', function(ev){
    if (ev.key !== 'Enter' || ev.shiftKey) return;
    ev.preventDefault();
    if (sendBtn.disabled) return;
    if (!(textaEl.value || '').trim()) return;
    performInboxSend(convId, phone, targetEl);
  });
}

/* Load conversation detail — Stage 7.7d: fetches all 5 sub-endpoints.
   targetEl: optional DOM element to render into (defaults to el('detail-content')). */
function inboxBookingIsLunaSource(bctx){
  bctx = bctx || {};
  var src = String(bctx.booking_source || '').toLowerCase();
  var metaSrc = String(bctx.metadata_source || bctx.source || '').toLowerCase();
  var botSrc = String(bctx.bot_source || '').toLowerCase();
  var createdBy = String(bctx.metadata_created_by || bctx.created_by || '').toLowerCase();
  var channel = String(bctx.metadata_channel || bctx.channel || '').toLowerCase();
  var staffSrc = String(bctx.staff_source || '').toLowerCase();
  var hay = [src, metaSrc, botSrc, createdBy, channel, staffSrc].join('|');
  var lunaMarkers = [
    'luna', 'bot', 'whatsapp', 'guest_bot', 'n8n', 'bot_', 'luna_',
    'bot_booking', 'bot_stage', 'luna_guest', 'luna_whatsapp',
  ];
  if (lunaMarkers.some(function(m){ return hay.indexOf(m) >= 0; })) return true;
  if (src === 'whatsapp') return true;
  if (src === 'manual_staff' || src === 'manual' || src === 'staff' ||
      src === 'staff_manual' || src === 'operator' || src === 'tour_operator' ||
      src.indexOf('operator') >= 0) return false;
  return false;
}

function inboxBookingSourceToneClass(bctx){
  return inboxBookingIsLunaSource(bctx) ? 'inbox-booking-luna' : 'inbox-booking-staff';
}

function inboxHumanizeStatus(raw){
  var s = String(raw || '').trim();
  if (!s || s === '—' || s === '-') return '—';
  var key = s.toLowerCase().replace(/\s+/g, '_');
  var map = {
    payment_pending: 'Payment pending',
    payment_link_sent: 'Payment link sent',
    link_sent: 'Payment link sent',
    paid: 'Paid',
    unpaid: 'Unpaid',
    partial: 'Partially paid',
    partially_paid: 'Partially paid',
    confirmed: 'Confirmed',
    hold: 'Hold',
    cancelled: 'Cancelled',
    canceled: 'Cancelled',
    needs_review: 'Needs review',
    pending: 'Pending',
    failed: 'Failed',
    expired: 'Expired',
    open: 'Open',
    complete: 'Complete',
    completed: 'Complete'
  };
  if (map[key]) return map[key];
  // snake_case / camelCase → Title words
  return s.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, function(ch){ return ch.toUpperCase(); });
}

function renderInboxBookingStackItemHtml(bctx, guestName){
  var linked = !!bctx.is_linked;
  var toneCls = inboxBookingSourceToneClass(bctx);
  var isSurf = getPortalProfile(getClient()).is_surf_vertical;
  var openLabel = isSurf
    ? (portalT('inbox.booking.openInSchedule') || 'Open booking')
    : (portalT('inbox.booking.openInCalendar') || 'Open booking in calendar');
  var html = '<div class="inbox-booking-stack-item ' + toneCls + '">';
  html += '<h4><button type="button" class="inbox-booking-code-link inbox-open-booking-cal" ' +
    'data-booking-id="' + escHtml(bctx.booking_id || '') + '" ' +
    'data-booking-code="' + escHtml(bctx.booking_code || '') + '" ' +
    'data-check-in="' + escHtml(bctx.check_in || '') + '" ' +
    'data-check-out="' + escHtml(bctx.check_out || '') + '" ' +
    'data-guest-name="' + escHtml(bctx.booking_guest_name || guestName || '') + '">' +
    escHtml(bctx.booking_code || 'Booking') + '</button>';
  if (linked) html += ' <span class="inbox-booking-linked-tag">Linked</span>';
  html += '</h4>';
  html += '<div class="kv2">';
  html +=   kv('Status',      inboxHumanizeStatus(bctx.booking_status)) +
            kv('Payment',     inboxHumanizeStatus(bctx.booking_payment_status));
  if (!isSurf) {
    html += kv('Stay',        fmtDateOnly(bctx.check_in) + ' → ' + fmtDateOnly(bctx.check_out)) +
            kv('Guests',      bctx.guest_count) +
            kv('Package',     bctx.package_code) +
            kv('Room pref',   bctx.room_preference || bctx.requested_room_type || '—') +
            kv('Assigned',    (bctx.assigned_room_code || '—') + (bctx.assigned_bed_code ? ' / ' + bctx.assigned_bed_code : ''));
  } else {
    html += kv('Dates',       fmtDateOnly(bctx.check_in) + ' → ' + fmtDateOnly(bctx.check_out)) +
            kv('Guests',      bctx.guest_count);
  }
  html += kv('Confirm',     bctx.confirmation_sent_at ? fmtTs(bctx.confirmation_sent_at) : '—');
  html += '</div>';
  if (bctx.payment_amount_due_cents != null){
    html += '<div style="margin-top:10px;padding-top:10px;border-top:1px solid #eef0f3">';
    html +=   '<div style="font-size:11px;font-weight:700;color:#5a6a85;margin-bottom:6px">Payment</div>';
    html +=   '<div class="kv2">';
    html +=     kv('Due',    '€' + (bctx.payment_amount_due_cents / 100).toFixed(2)) +
              kv('Paid',   '€' + ((bctx.payment_amount_paid_cents || 0) / 100).toFixed(2));
    html +=   '</div>';
    html += '</div>';
  }
  html += '<button type="button" class="inbox-booking-cal-link inbox-open-booking-cal" ' +
    'data-booking-id="' + escHtml(bctx.booking_id || '') + '" ' +
    'data-booking-code="' + escHtml(bctx.booking_code || '') + '" ' +
    'data-check-in="' + escHtml(bctx.check_in || '') + '" ' +
    'data-check-out="' + escHtml(bctx.check_out || '') + '" ' +
    'data-guest-name="' + escHtml(bctx.booking_guest_name || guestName || '') + '">' +
    escHtml(openLabel) + '</button>';
  html += '</div>';
  return html;
}

function loadSurfInboxDemoDetail(convId, targetEl){
  var profile = getPortalProfile(getClient());
  var row = surfInboxDemoThreadsForProfile(profile).find(function(c){ return c.conversation_id === convId; });
  if (!row) return false;
  targetEl = targetEl || el('detail-content');
  selectedConvId = convId;
  if (targetEl === el('detail-content')) el('conv-detail').classList.add('visible');
  targetEl.classList.remove('is-loading-detail');
  var channel = row.channel || 'whatsapp';
  var html = '<div class="inbox-preview-detail-note">' + escHtml(portalT('inbox.preview.detailNote')) + '</div>';
  html += '<div class="detail-header"><div>';
  html += '<div class="detail-name">' + escHtml(row.guest_name || '—') + '</div>';
  html += '<div class="detail-meta">';
  if (channel === 'email') {
    html += escHtml(row.guest_email || '');
    if (row.email_subject) html += '<div style="margin-top:6px;font-weight:600;color:var(--text)">Subject: ' + escHtml(row.email_subject) + '</div>';
  } else {
    html += escHtml(row.phone || '');
  }
  html += '</div></div>';
  html += '<div class="detail-header-pills" style="margin-left:auto;display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap">';
  html += inboxChannelBadgeHtml(channel);
  html += convHeaderStatusPillsHtml(row, !!row.luna_paused);
  html += '</div>';
  html += '</div>';
  html += '<div class="detail-layout"><div class="detail-main">';
  html += '<div class="thread-section"><div class="thread"><div class="thread-messages">';
  html += '<div class="msg inbound"><div class="msg-bubble">' + escHtml(row.last_message_preview || '') + '</div>';
  html += '<div class="msg-meta">Guest &bull; ' + escHtml(row.last_activity_label || portalT('inbox.preview.exampleLabel')) + '</div></div>';
  html += '</div></div></div>';
  html += '<div class="draft-panel"><div class="draft-label"><span style="font-size:11px;color:var(--text-3)">' + escHtml(portalT('inbox.detail.reply.label')) + '</span></div>';
  html += '<textarea disabled placeholder="' + escHtml(portalT('inbox.preview.detailNote')) + '"></textarea></div>';
  html += '</div></div>';
  targetEl.innerHTML = html;
  return true;
}


/*
 * Above 900px the column model owns column 4 (data-col4 on the shell), so the bookings
 * hide/show buttons drive that instead of the legacy is-sidebar-collapsed class — one
 * owner, and the collapsed track disappears with the card. Below 901px the shell grid is
 * a single stack and the legacy class still runs the toggle.
 */
function inboxColumnsOwnSidebar() {
  if (!window.__inboxColumns || typeof window.__inboxColumns.toggle !== 'function') return false;
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(min-width:901px)').matches;
}

function inboxSidebarCollapsedPreferred() {
  if (inboxColumnsOwnSidebar()) return window.__inboxColumns.state().col4 === 'hidden';
  try {
    return sessionStorage.getItem('inbox-detail-sidebar-collapsed') === '1';
  } catch (_e) { return false; }
}
function inboxSetSidebarCollapsed(layout, collapsed) {
  if (!layout) return;
  if (collapsed) layout.classList.add('is-sidebar-collapsed');
  else layout.classList.remove('is-sidebar-collapsed');
  var btn = layout.querySelector('#inbox-sidebar-toggle') || layout.parentElement && layout.parentElement.querySelector('#inbox-sidebar-toggle');
  // toggle may be sibling before sidebar inside layout
  if (!btn && layout.previousElementSibling && layout.previousElementSibling.id === 'inbox-sidebar-toggle') btn = layout.previousElementSibling;
  // Our HTML puts button inside layout before sidebar
  btn = layout.querySelector('#inbox-sidebar-toggle');
  if (btn) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  // Arrow glyphs are static in markup (→ hide on bookings, ← show in header); CSS shows the right one per state.
  try { sessionStorage.setItem('inbox-detail-sidebar-collapsed', collapsed ? '1' : '0'); } catch (_s) { /* ignore */ }
}
function wireInboxSidebarToggle(targetEl) {
  targetEl = targetEl || (typeof el === 'function' ? el('detail-content') : null);
  if (!targetEl) return;
  var layout = targetEl.querySelector('.detail-layout');
  var btn = targetEl.querySelector('#inbox-sidebar-toggle');
  if (!layout || !btn || btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';
  if (inboxColumnsOwnSidebar()) btn.setAttribute('aria-expanded', inboxSidebarCollapsedPreferred() ? 'false' : 'true');
  else inboxSetSidebarCollapsed(layout, inboxSidebarCollapsedPreferred());
  function toggleSidebar() {
    if (inboxColumnsOwnSidebar()) {
      window.__inboxColumns.toggle('col4');
      btn.setAttribute('aria-expanded', inboxSidebarCollapsedPreferred() ? 'false' : 'true');
      return;
    }
    inboxSetSidebarCollapsed(layout, !layout.classList.contains('is-sidebar-collapsed'));
  }
  btn.addEventListener('click', toggleSidebar);
  var expandBtn = targetEl.querySelector('#inbox-sidebar-expand');
  if (expandBtn && expandBtn.dataset.wired !== '1') {
    expandBtn.dataset.wired = '1';
    expandBtn.addEventListener('click', toggleSidebar);
  }
}

function loadConvDetail(convId, targetEl){
  targetEl = targetEl || el('detail-content');
  selectedConvId = convId;
  var selectionGeneration = ++inboxSelectionGeneration;
  showInboxMobileThread();
  if (targetEl === el('detail-content')) el('conv-detail').classList.add('visible');
  if (isSurfInboxDemoThread(convId) && loadSurfInboxDemoDetail(convId, targetEl)) return;
  beginConvDetailLoad(targetEl);

  var qs   = inboxClientQuery();

  /* One snapshot for every section; each keeps the body its own endpoint returns. */
  fetch('/staff/inbox/thread/' + encodeURIComponent(convId) + qs)
  .then(function(r){ return r.json(); })
  .then(function(composite){
    if (!inboxSelectionIsCurrent(convId, selectionGeneration)) return;
    if (!composite.success) throw new Error(composite.error || 'detail error');
    var results = [
      composite.detail,
      composite.messages,
      composite.context,
      composite.draft,
      composite.pause_state,
    ];
    var detailData = results[0];
    var msgsData   = results[1];
    var ctxData    = results[2];
    var draftData  = results[3];
    var pauseData  = results[4];

    if (!detailData.success) throw new Error(detailData.error || 'detail error');

    var c     = detailData.conversation;
    var msgs  = (msgsData.success  && msgsData.messages)  ? msgsData.messages  : [];
    inboxThreadMessageSig = threadMessagesFingerprint(msgs);
    var ctx   = (ctxData.success   && ctxData.context)    ? sanitizeConversationContextForInbox(ctxData.context) : null;
    var bookingRows = (ctxData.success && ctxData.bookings && ctxData.bookings.length)
      ? filterActiveInboxBookings(ctxData.bookings)
      : (ctx && (ctx.booking_code || ctx.booking_id) ? [ctx] : []);
    var draft = (draftData.success && draftData.draft)     ? draftData.draft    : null;
    var lunaGuestPaused = isLunaGuestAutomationPaused([pauseData, detailData, c]);
    var composerChannel = inboxComposerChannelFor(c);
    var guestEmail = inboxGuestEmailOf(c);
    var isEmailConversation = composerChannel === 'email';
    var missingEmail = isEmailConversation && !guestEmail;

    /* ── Header ── */
    var convPhone = normalizeCustomerPhoneClient(c.phone);

    /* ── Three-card layout: list | conversation | bookings ── */
    var html = '<div class="detail-layout">';

    /* ═══ MIDDLE — conversation card: header (controls) + thread + reply ═══ */
    html += '<div class="detail-main">';

    html +=   '<div class="detail-header">';
    html +=     '<div class="detail-header-main">';
    html +=     '<div class="detail-header-id">';
    if (inboxIsChatPreset()) {
      html +=     '<button type="button" class="detail-name inbox-chat-guest-name" id="inbox-chat-guest-name">' + escHtml(inboxPersonDisplayName(c)) + '</button>';
    } else {
      html +=     '<div class="detail-name">' + escHtml(inboxPersonDisplayName(c)) + '</div>';
    }
    html +=       '<span class="inbox-needs-human-slot" id="inbox-needs-human-slot"></span>';
    html +=     '</div>';
    if (composerChannel === 'email') {
      var headerSubject = inboxEmailSubjectOf(c, msgs);
      if (headerSubject) {
        html += '<div class="detail-email-subject" id="inbox-thread-email-subject">' + escHtml(headerSubject) + '</div>';
      }
    }
    html +=       '<div class="detail-meta">';
    var contactLine = composerChannel === 'email' ? guestEmail : (c.phone || '');
    var channelLabel = composerChannel === 'email' ? 'Email' : 'WhatsApp';
    if (contactLine) html += escHtml(contactLine) + ' · ';
    html += escHtml(channelLabel);
    if (conversationHasOpenHandoff(c) && c.handoff_reason)     html += ' · ' + escHtml(handoffLabel(c.handoff_reason));
    else if (c.needs_human) html += ' · ' + escHtml(t('inbox.detail.meta.needsStaffReply'));
    html +=       '</div>';
    html +=     '</div>';
    html +=     '<div class="detail-header-right">';
    html +=       '<div class="inbox-header-stack">';
    html +=         '<div class="inbox-header-stack-channel">' + inboxComposerChannelSwitchHtml(composerChannel) + '</div>';
    html +=         '<div class="inbox-header-stack-luna" id="inbox-header-luna-row"></div>';
    html +=       '</div>';
    html +=       '<button type="button" class="sidebar-expand-btn" id="inbox-sidebar-expand" aria-controls="inbox-detail-sidebar" title="' + escHtml(t('inbox.detail.sidebar.show') || portalT('inbox.detail.sidebar.show') || 'Show bookings') + '" aria-label="' + escHtml(t('inbox.detail.sidebar.show') || 'Show bookings') + '">&#8592;</button>';
    html +=     '</div>';
    html +=   '</div>';

    /* Message thread — Clear floats above box; box top aligns with Bot state */
    html += '<div class="thread-section">';
    html += '<div class="thread">';
    html +=   '<div class="inbox-thread-shell" id="inbox-thread-shell">';
    html +=   '<div class="inbox-thread-wrap" id="inbox-thread-wrap">';
    html +=   '<div class="thread-messages" id="thread-container">';
    var nativeCh = (c.channel === 'email') ? 'email' : 'whatsapp';
    if (composerChannel !== nativeCh || (isEmailConversation && !guestEmail)) {
      html += (isEmailConversation && !inboxFindGuestConversation(c, 'email'))
        ? inboxNoEmailThreadHtml()
        : '<div class="thread-empty">' + escHtml(t('inbox.detail.thread.empty')) + '</div>';
    } else if (msgs.length === 0){
      html += '<div class="thread-empty">' + escHtml(t('inbox.detail.thread.empty')) + '</div>';
    } else {
      html += renderInboxThreadMessagesHtml(inboxFilterMessagesByChannel(msgs, composerChannel));
    }
    html +=   '</div>'; /* /thread-messages */
    if (!isEmailConversation) html += inboxWhatsAppDraftMountHtml();
    html +=   '</div>'; /* /inbox-thread-wrap */
    html +=   '</div>'; /* /inbox-thread-shell */
    html += '<div class="luna-pause-action-status" id="luna-pause-action-status" style="display:none"></div>';
    html += '</div>'; /* /thread */
    html += '</div>'; /* /thread-section */

    /* Reply panel — WhatsApp send, gated email draft/approve, or fail-closed email read-only */
    var draftText = inboxEmailDraftBodyOf(draft, c);
    var useEmailReplyUi = staffEmailDraftsUiEnabled() && isEmailConversation;
    var emailSt = useEmailReplyUi ? emailReplyState(convId) : null;
    var emailDraftPending = useEmailReplyUi && inboxEmailDraftIsPending(draft, c, (emailSt && emailSt.savedText) || draftText);
    // Prefer per-conversation held draft/approval text (never shared across conversations).
    if (emailSt && emailSt.savedText) draftText = emailSt.savedText;

    html += '<div class="draft-panel">';
    html +=   '<div class="draft-label">';
    html +=     '<label for="draft-textarea" style="font-size:11px;color:var(--text-3)">' + escHtml(t('inbox.detail.reply.label')) + '</label>';
    html +=   '</div>';
    if (missingEmail) {
      html += '<div class="inbox-composer-no-email" role="status">Update email address in guest profile to email.</div>';
    } else {
    if (useEmailReplyUi) {
      var replySubject = (emailSt && emailSt.savedSubject)
        ? emailSt.savedSubject
        : inboxEmailOpenDraftSubject(draft, c, msgs);
      html += '<label class="inbox-email-subject-label" for="inbox-email-reply-subject">Subject</label>';
      html += '<input type="text" id="inbox-email-reply-subject" class="inbox-email-reply-subject" maxlength="200" value="' +
        escHtml(replySubject) + '"' + (emailSt && emailSt.locked ? ' disabled' : '') + '>';
    }
    html += '<textarea id="draft-textarea" placeholder="' + escHtml(t('inbox.detail.reply.editPlaceholder')) + '"' +
            ((isEmailConversation && !useEmailReplyUi) || (useEmailReplyUi && emailSt && emailSt.locked) ? ' disabled' : '') + '>' +
            escHtml(draftText) + '</textarea>';
    if (useEmailReplyUi) {
      html += '<div id="email-draft-byte-count" class="email-draft-byte-count" aria-live="polite">0 / 8000 bytes</div>';
      html += '<div class="draft-actions">';
      if (staffEmailLunaDraftUiEnabled() && isAuthoritativeEmailConversation(c)) {
        html += '<button type="button" class="btn-email-save-draft" id="btn-email-generate-luna-draft" hidden' +
                (emailSt && emailSt.locked ? ' disabled' : '') + '>Generate Luna draft</button>';
      }
      html +=   '<button type="button" class="btn-email-save-draft" id="btn-email-save-draft" hidden' +
              (emailSt && emailSt.locked ? ' disabled' : '') + '>Save draft</button>';
      html += '<input type="text" id="inbox-email-create-draft-context" class="inbox-email-create-draft-context" maxlength="500" placeholder="Context (optional)" aria-label="Draft context"' +
              (emailSt && emailSt.locked ? ' disabled' : '') + '>';
      html += '<button type="button" class="btn-email-create-draft" id="btn-email-create-draft"' +
              (emailSt && emailSt.locked ? ' disabled' : '') + '>Create Draft</button>';
      if (staffEmailOutboundUiEnabled()) {
        html += '<button type="button" class="btn-email-approve-send" id="btn-email-approve-send"' +
                (emailSt && emailSt.locked ? ' disabled' : '') + '>Approve &amp; send</button>';
      }
      html += '</div>';
      html += '<div id="draft-send-status" class="draft-send-status" role="status" aria-live="polite"></div>';
    } else if (isEmailConversation) {
      html += '<div id="email-drafting-disabled" class="draft-warning" role="status">Email drafting is currently disabled. This conversation is read-only.</div>';
    } else {
      html += '<div class="draft-actions">';
      html +=   '<button type="button" class="btn-send-reply" id="btn-send-reply">' + escHtml(t('inbox.detail.reply.send')) + '</button>';
      html += '</div>';
      html += '<div id="draft-send-status" class="draft-send-status"></div>';
    }
    }
    html += '</div>'; /* /draft-panel */

    /* Dev/testing tools — discreet footer, out of the header */
    html += '<details class="detail-conv-toolbar inbox-dev-overflow">';
    html += '<summary class="inbox-dev-overflow-summary" title="Testing tools">⋯</summary>';
    html += '<button type="button" class="pill pill-agent-session-reset" id="btn-agent-session-reset" title="Delete Hermes state.db session + messages for this guest. Portal thread and bookings unchanged. Use after SOUL edits.">Reset Luna session</button>';
    html += '<button type="button" class="pill pill-guest-context-reset" id="btn-guest-context-reset" title="Full wipe for testing: Hermes memory + all message history and logs + cached context. Bookings cancelled.">Full Wipe (testing)</button>';
    html += '</details>';

    html += '</div>'; /* /detail-main */
    html += '<div class="inbox-chat-guest-host" id="inbox-chat-guest-host" hidden></div>';

    /* ═══ RIGHT — context sidebar ═══ */
    html += '<div class="detail-sidebar" id="inbox-detail-sidebar"></div>';
    html += '</div>'; /* /detail-layout */

    inboxParkRefreshBtn();
    targetEl.innerHTML = html;
    inboxChatHideGuest();
    inboxPaintChatChromeSlot(c, lunaGuestPaused);
    inboxAdoptRefreshToHeader();
    targetEl.classList.remove('is-loading-detail');
    wireInboxComposerChannelSwitch(c, targetEl);
    inboxFillComposerThread(c, msgs);
    var chatName = targetEl.querySelector('#inbox-chat-guest-name');
    if (chatName) chatName.addEventListener('click', function(){ inboxChatShowGuest(); });

    if (missingEmail) { /* composer shows the update-email note */ }
    else if (useEmailReplyUi) {
      wireInboxEmailReply(convId, targetEl);
      if (emailDraftPending) {
        showDraftSendStatus(targetEl.querySelector('#draft-send-status'), '', 'Luna draft pending');
      }
    }
    else if (!isEmailConversation) {
      wireInboxSendReply(convId, c.phone, targetEl);
      wireInboxWhatsAppDraft(convId, targetEl);
    }
    var inboxCustBtn = targetEl.querySelector('#inbox-open-customer-card');
    if (inboxCustBtn && convPhone) {
      inboxCustBtn.addEventListener('click', function() { openCustomerCardForPhone(convPhone); });
    }
    var cbBtn = targetEl.querySelector('#inbox-create-booking-for-guest');
    if (cbBtn) cbBtn.addEventListener('click', function(){
      openCreateBookingFromContact({
        display_name: c.guest_name,
        phone: c.phone,
        email: c.email,
        language: c.language,
        internal_staff_notes: c.internal_staff_notes
      });
    });
    wireInboxSidebarToggle(targetEl);
    wireNeedsHumanToggle(convId, targetEl);
    wireInboxNeedsHumanRaise(targetEl);
    wireLunaPauseSwitch(convId, targetEl);
    wireInboxLunaModeControl(targetEl);
    wireFreshStart(convId, targetEl);
    wireAgentSessionReset(convId, targetEl);

    var calLinks = targetEl.querySelectorAll('.inbox-open-booking-cal');
    calLinks.forEach(function(calLink){
      calLink.addEventListener('click', function(){
        openBookingInCalendar({
          booking_id: calLink.dataset.bookingId || null,
          booking_code: calLink.dataset.bookingCode || null,
          check_in: calLink.dataset.checkIn || null,
          check_out: calLink.dataset.checkOut || null,
          guest_name: calLink.dataset.guestName || c.guest_name,
        });
      });
    });
    targetEl.querySelectorAll('.inbox-booking-stack-item').forEach(function(item){
      item.addEventListener('dblclick', function(e){
        if (e.target.closest('.inbox-open-booking-cal')) return;
        var link = item.querySelector('.inbox-open-booking-cal');
        if (!link) return;
        e.preventDefault();
        openBookingInCalendar({
          booking_id: link.dataset.bookingId || null,
          booking_code: link.dataset.bookingCode || null,
          check_in: link.dataset.checkIn || null,
          check_out: link.dataset.checkOut || null,
          guest_name: link.dataset.guestName || c.guest_name,
        });
      });
    });

    inboxInitThreadResize();
    inboxScrollThreadToBottom(targetEl);
  })
  .catch(function(err){
    if (!inboxSelectionIsCurrent(convId, selectionGeneration)) return;
    if (convDetailHasLayout(targetEl)){
      targetEl.classList.remove('is-loading-detail');
      var slot = targetEl.querySelector('#conv-detail-load-status');
      if (slot){
        slot.textContent = 'Error: ' + (err.message || 'load failed');
        slot.classList.add('error');
        return;
      }
    }
    targetEl.classList.remove('is-loading-detail');
    inboxParkRefreshBtn();
    targetEl.innerHTML = '<div class="state-msg error">Error loading conversation: ' + escHtml(err.message) + '</div>';
  });
}

function wireAgentSessionReset(convId, targetEl){
  var btn = targetEl.querySelector('#btn-agent-session-reset');
  if (!btn) return;
  btn.addEventListener('click', function(){
    if (!window.confirm('Reset Luna session: delete Hermes agent history for this guest (state.db sessions + messages). Portal thread, bookings, and Staff API logs are kept. Next WhatsApp message starts fresh with current SOUL. Continue?')) return;
    btn.disabled = true;
    fetch('/staff/conversations/' + encodeURIComponent(convId) + '/reset-agent-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_slug: getClient() }),
    })
      .then(function(r){
        if (r.status === 401) throw new Error('Authentication required');
        return r.json().then(function(data){ return { status: r.status, data: data }; });
      })
      .then(function(out){
        var d = out.data || {};
        if (!d.success) throw new Error(d.error || ('HTTP ' + out.status));
        alert('Luna session reset — deleted ' + (d.hermes_session_reset && d.hermes_session_reset.deleted_count != null ? d.hermes_session_reset.deleted_count : 0) + ' Hermes session(s). Next guest message uses a brand-new session.');
      })
      .catch(function(err){
        alert(err.message || 'Could not reset Luna session');
      })
      .finally(function(){ btn.disabled = false; });
  });
}

function wireFreshStart(convId, targetEl){
  var btn = targetEl.querySelector('#btn-guest-context-reset');
  if (!btn) return;
  btn.addEventListener('click', function(){
    if (!window.confirm('Full Wipe (testing): CANCELS all bookings for this number and clears Luna chat memory, all message history and logs, and cached context - a true blank slate. Beds are freed; records kept; staging only. Continue?')) return;
    btn.disabled = true;
    fetch('/staff/conversations/' + encodeURIComponent(convId) + '/reset-luna-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_slug: getClient() }),
    })
      .then(function(r){
        if (r.status === 401) throw new Error('Authentication required');
        return r.json().then(function(data){ return { status: r.status, data: data }; });
      })
      .then(function(out){
        var d = out.data || {};
        if (!d.success) throw new Error(d.error || ('HTTP ' + out.status));
        alert('Full wipe result -- hermes_deleted: ' + (d.hermes_session_reset && d.hermes_session_reset.deleted_count != null ? d.hermes_session_reset.deleted_count : JSON.stringify(d.hermes_session_reset)) + ' | bookings: ' + JSON.stringify(d.bookings_cleared) + ' | events: ' + JSON.stringify(d.phone_events_reset) + ' | messages_deleted: ' + d.messages_deleted);
        loadConvDetail(convId, targetEl);
      })
      .catch(function(err){
        alert(err.message || 'Could not reset Luna context');
      })
      .finally(function(){ btn.disabled = false; });
  });
}

function wireDeleteConversation(convId){
  if (!convId) return;
  if (!window.confirm('Delete this conversation permanently? This cannot be undone.')) return;
  fetch('/staff/conversations/' + encodeURIComponent(convId) + inboxClientQuery(), {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  })
    .then(function(r){
      if (r.status === 401) throw new Error('Authentication required');
      if (r.status === 403) throw new Error('Admin access required');
      return r.json().then(function(data){ return { status: r.status, data: data }; });
    })
    .then(function(out){
      var d = out.data || {};
      if (!d.success) throw new Error(d.error || ('HTTP ' + out.status));
      if (selectedConvId === convId){
        selectedConvId = null;
        el('detail-content').innerHTML = inboxEmptyDetailHtml();
        hideInboxMobileThread();
      }
      inboxConversationsCache = (inboxConversationsCache || []).filter(function(c){
        return (c.conversation_id || c.id) !== convId;
      });
      applyInboxFilter({ preserveDetail: true, selectedId: selectedConvId });
      var nhCount = (inboxConversationsCache || []).filter(conversationNeedsHuman).length;
      var badge = el('hq-badge');
      if (badge){ badge.textContent = nhCount; badge.classList.toggle('visible', nhCount > 0); }
    })
    .catch(function(err){
      alert(err.message || 'Could not delete conversation');
    });
}
