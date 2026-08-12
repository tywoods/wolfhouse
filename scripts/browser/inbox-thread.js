/**
 * Staff Portal Inbox, Conversations tab: thread detail. Status pebbles, Luna pause
 * controls, needs-human handling, conversation list and detail rendering, WhatsApp send,
 * the email draft and approve-send flow, and booking cross-links.
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

function convHeaderStatusPillsHtml(conv, lunaPaused){
  var html = inboxLunaStaffPill(lunaPaused);
  if (conversationHasOpenHandoff(conv)){
    html += '<span class="pill pill-orange" id="conv-handoff-pill">' + escHtml(t('inbox.list.pill.handoff')) + '</span>';
  } else if (conv && conv.needs_human){
    html += '<span class="pill pill-orange" id="conv-needs-human-pill">' + escHtml(t('inbox.list.pill.needsHuman')) + '</span>';
  }
  return html;
}

function detailHeaderSwitchesHtml(c, lunaGuestPaused){
  return (lunaGuestPaused ? inboxLunaPausedPillHtml(true) : '') +
    '<div class="detail-header-switches">' +
    '<label class="inbox-header-switch-item" for="conv-needs-human-toggle" title="' + escHtml(t('inbox.detail.switch.needsHuman')) + '">' +
      '<span class="inbox-header-switch-label">' + escHtml(t('inbox.detail.switch.needsHuman')) + '</span>' +
      '<span class="inbox-switch inbox-switch-orange inbox-header-switch">' +
        '<input type="checkbox" id="conv-needs-human-toggle"' + (c.needs_human ? ' checked' : '') + '>' +
        '<span class="inbox-switch-slider"></span>' +
      '</span>' +
    '</label>' +
    '<label class="inbox-header-switch-item" for="luna-pause-switch" title="' + escHtml(t('inbox.detail.switch.pauseLuna')) + '">' +
      '<span class="inbox-header-switch-label">' + escHtml(t('inbox.detail.switch.pauseLuna')) + '</span>' +
      '<span class="inbox-switch inbox-switch-red inbox-header-switch">' +
        '<input type="checkbox" id="luna-pause-switch"' + (lunaGuestPaused ? ' checked' : '') + '>' +
        '<span class="inbox-switch-slider"></span>' +
      '</span>' +
    '</label>' +
  '</div>';
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
  updateLunaPausedPillInPlace(targetEl, paused);
}

function updateLunaPausedPillInPlace(targetEl, paused){
  var right = targetEl.querySelector('.detail-header-right');
  if (!right) return;
  var existing = right.querySelector('#conv-luna-paused-pill');
  if (paused){
    if (!existing){
      var switches = right.querySelector('.detail-header-switches');
      var pill = document.createElement('span');
      pill.className = 'pill pill-luna-paused';
      pill.id = 'conv-luna-paused-pill';
      pill.textContent = t('inbox.detail.pill.lunaPaused');
      if (switches) right.insertBefore(pill, switches);
      else right.appendChild(pill);
    }
  } else if (existing) {
    existing.remove();
  }
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

function updateConvHeaderPillsInPlace(targetEl, needsHuman, lunaPaused){
  var hdrPills = targetEl.querySelector('.detail-header-pills');
  if (hdrPills){
    hdrPills.innerHTML = convHeaderStatusPillsHtml({ needs_human: needsHuman }, lunaPaused);
  }
}

function updateNeedsHumanBadgeInPlace(targetEl, needsHuman, opts){
  opts = opts || {};
  var pauseSw = targetEl.querySelector('#luna-pause-switch');
  var lunaPaused = (typeof opts.conversation_paused === 'boolean')
    ? opts.conversation_paused
    : (pauseSw ? pauseSw.checked : false);
  if (typeof opts.conversation_paused === 'boolean' && pauseSw) {
    pauseSw.checked = !!opts.conversation_paused;
  }
  updateConvHeaderPillsInPlace(targetEl, needsHuman, lunaPaused);
  updateLunaPausedPillInPlace(targetEl, lunaPaused);
}

function wireNeedsHumanToggle(convId, targetEl){
  var toggle = targetEl.querySelector('#conv-needs-human-toggle');
  if (!toggle || toggle.dataset.wiredNeedsHuman === '1') return;
  toggle.dataset.wiredNeedsHuman = '1';

  toggle.addEventListener('change', function(){
    var want = toggle.checked;
    toggle.disabled = true;
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
        alert(err.message || 'Could not update needs human flag');
      })
      .finally(function(){ toggle.disabled = false; });
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

function beginConvDetailLoad(targetEl){
  if (convDetailHasLayout(targetEl)){
    targetEl.classList.add('is-loading-detail');
    var slot = targetEl.querySelector('#conv-detail-load-status');
    if (!slot){
      slot = document.createElement('span');
      slot.id = 'conv-detail-load-status';
      slot.className = 'conv-detail-load-status';
      var hdrRight = targetEl.querySelector('.detail-header > div:last-child');
      if (hdrRight) hdrRight.appendChild(slot);
    }
    slot.classList.remove('error');
    slot.textContent = 'Loading…';
    slot.style.display = '';
    return;
  }
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
          setLunaPauseActionStatus(targetEl, 'Pause controls are disabled.', true);
          sw.disabled = false;
          return;
        }
        if (!res.ok || !data.success){
          sw.checked = !wantPaused;
          setLunaPauseActionStatus(targetEl, data.error || 'Could not update Luna status.', true);
          sw.disabled = false;
          return;
        }
        setLunaPauseActionStatus(targetEl, '', false);
        updateLunaPauseUiInPlace(targetEl, wantPaused);
        patchInboxConvRow(convId, { luna_paused: wantPaused });
        updateInboxConvCardStatusPills(convId);
        bcUpdateDrawerConvBotModePebble(convId, wantPaused);
        sw.disabled = false;
      })
      .catch(function(err){
        sw.checked = !wantPaused;
        setLunaPauseActionStatus(targetEl, err.message || 'Could not update Luna status.', true);
        sw.disabled = false;
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
    var subjectLine = channel === 'email' && c.email_subject
      ? '<div class="conv-card-subject">' + escHtml(c.email_subject) + '</div>'
      : '';
    var previewLine = c.last_message_preview
      ? '<div class="conv-card-preview">' + escHtml(c.last_message_preview) + '</div>'
      : '';
    var timeLine = c.last_activity_label
      ? '<div class="conv-card-time">' + escHtml(c.last_activity_label) + '</div>'
      : '';
    return '<div class="conv-card' + demoClass + '" data-id="' + escHtml(c.conversation_id) + '">' +
      delBtn +
      '<div class="conv-card-header-row">' +
        '<div class="conv-card-name">' + escHtml(c.guest_name || '—') + '</div>' +
        inboxChannelBadgeHtml(channel) +
      '</div>' +
      subjectLine +
      (contactLine ? '<div class="conv-card-contact">' + escHtml(contactLine) + '</div>' : '') +
      previewLine +
      '<div class="conv-card-pills">' + convListPill(c) + '</div>' +
      handoffLine +
      timeLine +
    '</div>';
  }
  return '<div class="conv-card conv-card-mobile-dense' + demoClass + '" data-id="' + escHtml(c.conversation_id) + '">' +
    delBtn +
    '<div class="conv-card-header-row">' +
      '<div class="conv-card-name">' + escHtml(c.guest_name || '—') + '</div>' +
      inboxChannelBadgeHtml('whatsapp') +
    '</div>' +
    (c.phone ? '<div class="conv-card-phone">' + escHtml(c.phone) + '</div>' : '') +
    (c.last_message_preview ? '<div class="conv-card-preview">' + escHtml(c.last_message_preview) + '</div>' : '') +
    '<div class="conv-card-pills">' + convListPill(c) + '</div>' +
    handoffLine +
    (c.last_activity_label ? '<div class="conv-card-time">' + escHtml(c.last_activity_label) + '</div>' : '') +
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
    if (opts.preserveDetail){
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
    /* Auto-select top conversation (or keep current if still in filtered list) */
    var pickId = null;
    if (selectedConvId && convs.some(function(c){ return c.conversation_id === selectedConvId; })){
      pickId = selectedConvId;
    } else {
      pickId = convs[0].conversation_id;
    }
    if (pickId && !isPortalMobile()){
      var pickCard = list.querySelector('.conv-card[data-id="' + pickId + '"]');
      if (pickCard){
        list.querySelectorAll('.conv-card').forEach(function(c){ c.classList.remove('selected'); });
        pickCard.classList.add('selected');
        loadConvDetail(pickId);
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

function showDraftSendStatus(el, kind, message){
  if (!el) return;
  el.className = 'draft-send-status is-visible ' + (kind || '');
  el.textContent = message || '';
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
var EMAIL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var EMAIL_DRAFT_OK_KEYS = ['success','conversation_id','message_text','approval_id'];
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
function emailUiFailureCopy(op, status){
  var c = (typeof status === 'number' && isFinite(status)) ? status : 0;
  if (c === 400) return 'Request rejected';
  if (c === 401 || c === 403) return 'Unauthorized';
  if (c === 404) return 'Conversation unavailable';
  if (c === 409) return 'Conflict — reload and try again';
  if (c === 503) return 'Temporarily unavailable';
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
    _emailReplyStateByConv[id] = { approvalId: null, locked: false, sent: false, savedText: '', seq: 0, inFlight: false, generationUncertain: false };
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
  var saveBtn = targetEl.querySelector('#btn-email-save-draft');
  var apprBtn = targetEl.querySelector('#btn-email-approve-send');
  var lunaBtn = targetEl.querySelector('#btn-email-generate-luna-draft');
  var freeze = !!(disabled || locked);
  if (ta) ta.disabled = freeze;
  if (saveBtn) saveBtn.disabled = freeze;
  if (apprBtn) apprBtn.disabled = freeze;
  if (lunaBtn) lunaBtn.disabled = freeze;
}
function emailReplyActionPanel(buttonEl, targetEl){
  if (!buttonEl || !targetEl || typeof buttonEl.closest !== 'function') return null;
  var panel = buttonEl.closest('.draft-panel');
  if (!panel || !targetEl.contains(panel)) return null;
  if (panel.querySelectorAll('#draft-textarea').length !== 1) return null;
  if (panel.querySelectorAll('#btn-email-save-draft').length !== 1) return null;
  return panel;
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
    var outcomeUnknown=!out.parseOk||(out.status===200&&!accepted)||(out.status===503&&emailOwnData(out.data,'error')==='draft_save_outcome_unknown');
    if(accepted){st.approvalId=accepted.approval_id;st.savedText=accepted.message_text;st.generationUncertain=false;}
    if(outcomeUnknown){st.approvalId=null;st.savedText='';st.generationUncertain=true;}
    if(selectedConvId!==snapConv)return;
    if(accepted){ta.value=accepted.message_text;updateEmailDraftByteCount(targetEl,ta.value);showDraftSendStatus(statusEl,'ok','Luna draft generated — review and edit before approval.');}
    else if(out.status===422)showDraftSendStatus(statusEl,'blocked','Luna handoff required; draft was not changed.');
    else if(outcomeUnknown)showDraftSendStatus(statusEl,'blocked','Draft save outcome is unknown. Reload the conversation or page before generating again.');
    else showDraftSendStatus(statusEl,'error','Draft generation failed.');
    setEmailReplyControlsDisabled(targetEl,st.generationUncertain,st.locked);
  }).catch(function(){if(mySeq!==st.seq)return;st.inFlight=false;st.approvalId=null;st.savedText='';st.generationUncertain=true;if(selectedConvId!==snapConv)return;showDraftSendStatus(statusEl,'blocked','Draft save outcome is unknown. Reload the conversation or page before generating again.');setEmailReplyControlsDisabled(targetEl,true,st.locked);});
}
function performEmailDraftSave(convId, targetEl){
  var st = emailReplyState(convId);
  var ta = targetEl.querySelector('#draft-textarea');
  var statusEl = targetEl.querySelector('#draft-send-status');
  if (!ta || st.locked || st.inFlight) return;
  var messageText = String(ta.value == null ? '' : ta.value);
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
      approval_id: st.approvalId == null ? null : st.approvalId,
    }),
  })
    .then(emailParseFetchJson)
    .then(function(out){
      if (mySeq !== st.seq) return;
      st.inFlight = false;
      if (selectedConvId !== snapConv) return;
      if (!out.parseOk) {
        showDraftSendStatus(statusEl, 'error', 'Invalid response');
        setEmailReplyControlsDisabled(targetEl, false, st.locked);
        return;
      }
      var accepted = (out.status >= 200 && out.status < 300) ? acceptEmailDraftSuccess(out.data, snapConv, snapText) : null;
      if (accepted) {
        st.approvalId = accepted.approval_id;
        st.savedText = snapText;
        showDraftSendStatus(statusEl, 'ok', 'Draft saved');
        setEmailReplyControlsDisabled(targetEl, false, st.locked);
        return;
      }
      showDraftSendStatus(statusEl, 'error', emailUiFailureCopy('draft', out.status));
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
  if (!st.approvalId) {
    showDraftSendStatus(statusEl, 'error', 'Save a draft before approving.');
    return;
  }
  if (messageText !== st.savedText) {
    showDraftSendStatus(statusEl, 'error', 'Save the current text before approving.');
    return;
  }
  var bytes = emailUtf8ByteLength(messageText);
  if (!messageText.length || bytes > EMAIL_DRAFT_MAX_UTF8_BYTES) {
    showDraftSendStatus(statusEl, 'error', !messageText.length ? 'Enter a reply before approving.' : 'Message exceeds 8,000 UTF-8 bytes.');
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
          if (ta.value !== snapText) ta.value = snapText;
          updateEmailDraftByteCount(targetEl, snapText);
          st.savedText = snapText;
          st.locked = true;
          st.sent = true;
          showDraftSendStatus(statusEl, 'ok', 'Email sent');
          setEmailReplyControlsDisabled(targetEl, false, true);
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
        showDraftSendStatus(statusEl, 'error', emailUiFailureCopy('approve', out.status));
        setEmailReplyControlsDisabled(targetEl, false, st.locked);
        return;
      }
      if (out.status === 503) {
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
      showDraftSendStatus(statusEl, 'error', emailUiFailureCopy('approve', out.status));
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
  html += '</div></div>';
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


function inboxSidebarCollapsedPreferred() {
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
  inboxSetSidebarCollapsed(layout, inboxSidebarCollapsedPreferred());
  function toggleSidebar() {
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
  showInboxMobileThread();
  if (targetEl === el('detail-content')) el('conv-detail').classList.add('visible');
  if (isSurfInboxDemoThread(convId) && loadSurfInboxDemoDetail(convId, targetEl)) return;
  beginConvDetailLoad(targetEl);

  var qs   = inboxClientQuery();

  /* One snapshot for every section; each keeps the body its own endpoint returns. */
  fetch('/staff/inbox/thread/' + encodeURIComponent(convId) + qs)
  .then(function(r){ return r.json(); })
  .then(function(composite){
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

    /* ── Header ── */
    var convPhone = normalizeCustomerPhoneClient(c.phone);

    /* ── Three-card layout: list | conversation | bookings ── */
    var html = '<div class="detail-layout">';

    /* ═══ MIDDLE — conversation card: header (controls) + thread + reply ═══ */
    html += '<div class="detail-main">';

    html +=   '<div class="detail-header">';
    html +=     '<div class="detail-header-main">';
    html +=       '<div class="detail-name">' + escHtml(c.guest_name || c.phone) + '</div>';
    html +=       '<div class="detail-meta">' + escHtml(c.phone);
    if (conversationHasOpenHandoff(c) && c.handoff_reason)     html += ' &bull; ' + escHtml(handoffLabel(c.handoff_reason));
    else if (c.needs_human) html += ' &bull; ' + escHtml(t('inbox.detail.meta.needsStaffReply'));
    html +=       '</div>';
    html +=     '</div>';
    html +=     '<div class="detail-header-right">';
    if (convPhone && portalHasCustomersCrm(getPortalProfile(getClient()))) {
      html += '<button type="button" class="btn btn-soft-grey btn-compact" id="inbox-open-customer-card">' + escHtml(portalT('customers.openCustomerCard')) + '</button>';
    }
    html +=       '<span class="detail-header-pills">' + convHeaderStatusPillsHtml(c, lunaGuestPaused) + '</span>';
    html +=       detailHeaderSwitchesHtml(c, lunaGuestPaused);
    html +=       '<button type="button" class="sidebar-expand-btn" id="inbox-sidebar-expand" aria-controls="inbox-detail-sidebar" title="' + escHtml(t('inbox.detail.sidebar.show') || portalT('inbox.detail.sidebar.show') || 'Show bookings') + '" aria-label="' + escHtml(t('inbox.detail.sidebar.show') || 'Show bookings') + '">&#8592;</button>';
    html +=     '</div>';
    html +=   '</div>';

    /* Message thread — Clear floats above box; box top aligns with Bot state */
    html += '<div class="thread-section">';
    html += '<div class="thread">';
    html +=   '<div class="inbox-thread-shell" id="inbox-thread-shell">';
    html +=   '<div class="inbox-thread-wrap" id="inbox-thread-wrap">';
    html +=   '<div class="thread-messages" id="thread-container">';
    if (msgs.length === 0){
      html += '<div class="thread-empty">' + escHtml(t('inbox.detail.thread.empty')) + '</div>';
    } else {
      html += renderInboxThreadMessagesHtml(msgs);
    }
    html +=   '</div>'; /* /thread-messages */
    html +=   '</div>'; /* /inbox-thread-wrap */
    html +=   '</div>'; /* /inbox-thread-shell */
    html += '<div class="luna-pause-action-status" id="luna-pause-action-status" style="display:none"></div>';
    html += '</div>'; /* /thread */
    html += '</div>'; /* /thread-section */

    /* Reply panel — WhatsApp send, gated email draft/approve, or fail-closed email read-only */
    var draftText = (draft && draft.draft_text) ? draft.draft_text : (c.staff_reply_draft || '');
    var isEmailConversation = isAuthoritativeEmailConversation(c);
    var useEmailReplyUi = staffEmailDraftsUiEnabled() && isEmailConversation;
    var emailSt = useEmailReplyUi ? emailReplyState(convId) : null;
    // Prefer per-conversation held draft/approval text (never shared across conversations).
    if (emailSt && emailSt.savedText) draftText = emailSt.savedText;

    html += '<div class="draft-panel">';
    html +=   '<div class="draft-label">';
    if (useEmailReplyUi) {
      html += '<label for="draft-textarea" style="font-size:11px;color:var(--text-3)">' + escHtml(t('inbox.detail.reply.label')) + '</label>';
    } else {
      html +=     '<span style="font-size:11px;color:var(--text-3)">' + escHtml(t('inbox.detail.reply.label')) + '</span>';
    }
    html +=   '</div>';
    html += '<textarea id="draft-textarea" placeholder="' + escHtml(t('inbox.detail.reply.editPlaceholder')) + '"' +
            ((isEmailConversation && !useEmailReplyUi) || (useEmailReplyUi && emailSt && emailSt.locked) ? ' disabled' : '') + '>' +
            escHtml(draftText) + '</textarea>';
    if (useEmailReplyUi) {
      html += '<div id="email-draft-byte-count" class="email-draft-byte-count" aria-live="polite">0 / 8000 bytes</div>';
      html += '<div class="draft-actions">';
      if (staffEmailLunaDraftUiEnabled() && isAuthoritativeEmailConversation(c)) {
        html += '<button type="button" class="btn-email-save-draft" id="btn-email-generate-luna-draft"' +
                (emailSt && emailSt.locked ? ' disabled' : '') + '>Generate Luna draft</button>';
      }
      html +=   '<button type="button" class="btn-email-save-draft" id="btn-email-save-draft"' +
              (emailSt && emailSt.locked ? ' disabled' : '') + '>Save draft</button>';
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
    html += '</div>'; /* /draft-panel */

    /* Dev/testing tools — discreet footer, out of the header */
    html += '<div class="detail-conv-toolbar">';
    html += '<button type="button" class="pill pill-agent-session-reset" id="btn-agent-session-reset" title="Delete Hermes state.db session + messages for this guest. Portal thread and bookings unchanged. Use after SOUL edits.">Reset Luna session</button>';
    html += '<button type="button" class="pill pill-guest-context-reset" id="btn-guest-context-reset" title="Full wipe for testing: Hermes memory + all message history/logs + cached context. Bookings cancelled.">Full Wipe (testing)</button>';
    html += '</div>';

    html += '</div>'; /* /detail-main */

    /* ═══ RIGHT — context sidebar ═══ */
    html += '<div class="detail-sidebar" id="inbox-detail-sidebar">';

    /* ── Guest bookings (stacked) — hide-arrow sits inline next to the title ── */
    html += '<div class="sidebar-card">';
    html +=   '<div class="sidebar-card-head">';
    html +=     '<h3>' + escHtml(t('inbox.detail.bookings.title')) + '</h3>';
    html +=     '<button type="button" class="detail-sidebar-toggle" id="inbox-sidebar-toggle" aria-controls="inbox-detail-sidebar" aria-expanded="true" title="' + escHtml(t('inbox.detail.sidebar.hide') || portalT('inbox.detail.sidebar.hide') || 'Hide bookings') + '" aria-label="' + escHtml(t('inbox.detail.sidebar.hide') || 'Hide bookings') + '">&#8594;</button>';
    html +=   '</div>';
    if (!bookingRows.length){
      html += '<div class="inbox-no-bookings">' + escHtml(t('inbox.detail.bookings.none')) + '</div>';
    } else {
      html += '<div class="inbox-booking-stack">';
      bookingRows.forEach(function(bctx){
        html += renderInboxBookingStackItemHtml(bctx, c.guest_name);
      });
      html += '</div>';
    }
    html += '<button type="button" class="btn btn-ghost" id="inbox-create-booking-for-guest" style="margin-top:10px">' + escHtml(t('inbox.detail.bookings.createForGuest')) + '</button>';
    html += '</div>'; /* /sidebar-card */

    /* Notes / summary */
    if (c.human_notes || c.conversation_summary){
      html += '<div class="sidebar-card">';
      html +=   '<h3>' + escHtml(t('inbox.detail.notes.title')) + '</h3>';
      if (c.human_notes)          html += '<div style="font-size:12px;color:#2c3e50;white-space:pre-wrap;margin-bottom:6px">' + escHtml(c.human_notes) + '</div>';
      if (c.conversation_summary) html += '<div style="font-size:11px;color:#7f8c8d;white-space:pre-wrap">' + escHtml(c.conversation_summary) + '</div>';
      html += '</div>';
    }

    html += '</div>'; /* /detail-sidebar */
    html += '</div>'; /* /detail-layout */

    targetEl.innerHTML = html;
    targetEl.classList.remove('is-loading-detail');

    if (useEmailReplyUi) wireInboxEmailReply(convId, targetEl);
    else if (!isEmailConversation) wireInboxSendReply(convId, c.phone, targetEl);
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
    wireLunaPauseSwitch(convId, targetEl);
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
