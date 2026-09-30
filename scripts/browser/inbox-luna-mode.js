/**
 * Staff Portal Inbox — one Luna mode control in the thread header.
 *
 * Maps onto existing pause / needs_human endpoints. Not a new state machine
 * and not migration 079. Channel options match what is real today:
 *
 *   WhatsApp  Auto | Off     (no Draft — that is Phase 2 / migration 078)
 *   Email     Draft | Off    (no Auto — email is draft-only; never auto-sends)
 *
 * Auto/Draft = unpaused (`POST /staff/bot/resume`). Off = paused
 * (`POST /staff/bot/pause`). Needs human stays a raise/clear action on
 * `POST /staff/conversations/:id/needs-human`, not a competing send toggle.
 *
 * Tenant-global green-box Draft|Auto (inbox-shell.js) does not override these
 * conversation send gates.
 *
 * Hidden native checkboxes keep the existing pause and needs-human wirings.
 *
 * Injected into /staff/ui ahead of inbox-thread. Fragment spliced into the
 * portal IIFE, so it relies on siblings in that scope (`t`, `escHtml`).
 */

function inboxLunaModeOptions(channel){
  if (channel === 'email') return ['draft', 'off'];
  return ['auto', 'off'];
}

function inboxLunaModeFromPaused(channel, paused){
  if (paused) return 'off';
  return channel === 'email' ? 'draft' : 'auto';
}

function inboxLunaModeChannelDefault(channel){
  var email = channel === 'email';
  var fallback = 'draft';
  if (typeof inboxShellLoadStoredModes !== 'function') return fallback;
  try {
    var stored = inboxShellLoadStoredModes() || {};
    if (email) {
      return typeof inboxShellNormalizeEmail === 'function'
        ? inboxShellNormalizeEmail(stored.email)
        : (stored.email === 'auto' ? 'auto' : 'draft');
    }
    return typeof inboxShellNormalizeWhatsApp === 'function'
      ? inboxShellNormalizeWhatsApp(stored.whatsapp)
      : (stored.whatsapp === 'auto' ? 'auto' : 'draft');
  } catch (_e) {
    return fallback;
  }
}

function inboxLunaModeIsInherited(channel, paused){
  return inboxLunaModeChannelDefault(channel) === inboxLunaModeFromPaused(channel, paused);
}

function inboxLunaModeHeaderLabel(channel, paused){
  return t('inbox.detail.lunaMode.label') + ':';
}

function inboxLunaModeBtnCopy(opt){
  if (opt === 'off') return t('inbox.detail.lunaMode.off');
  return (typeof t === 'function' && t('inbox.channelControl.on')) || 'On';
}

function inboxNeedsHumanReasonCode(conv){
  if (!conv) return '';
  var parts = [conv.handoff_reason, conv.needs_human_reason, conv.luna_handoff_reason];
  for (var i = 0; i < parts.length; i++) {
    var raw = parts[i] == null ? '' : String(parts[i]).trim();
    if (raw) return raw;
  }
  return '';
}

function inboxNeedsHumanT(key, fallback){
  if (typeof t === 'function') {
    var via = t(key);
    if (via && via !== key) return String(via);
  }
  if (typeof portalT === 'function') {
    var viaP = portalT(key);
    if (viaP && viaP !== key) return String(viaP);
  }
  return fallback;
}

var INBOX_NEEDS_REASON_KEYS = {
  human_requested: 'inbox.detail.needsHuman.reason.humanRequested',
  complaint: 'inbox.detail.needsHuman.reason.complaint',
  urgent_safety: 'inbox.detail.needsHuman.reason.safety',
  refund: 'inbox.detail.needsHuman.reason.refund',
  cancel_refund: 'inbox.detail.needsHuman.reason.refund',
  refund_request: 'inbox.detail.needsHuman.reason.refund',
  paid_cancellation_or_reschedule: 'inbox.detail.needsHuman.reason.paidChange',
  paid_booking_change: 'inbox.detail.needsHuman.reason.paidChange',
  date_change: 'inbox.detail.needsHuman.reason.dateChange',
  date_change_request: 'inbox.detail.needsHuman.reason.dateChange',
  date_change_requested: 'inbox.detail.needsHuman.reason.dateChange',
  date_change_different_nights: 'inbox.detail.needsHuman.reason.dateChange',
  payment_inquiry: 'inbox.detail.needsHuman.reason.payment',
  payment_claimed: 'inbox.detail.needsHuman.reason.payment',
  payment_state_mismatch: 'inbox.detail.needsHuman.reason.payment',
  cancel_or_change_request: 'inbox.detail.needsHuman.reason.cancelOrChange',
  business_tool_error: 'inbox.detail.needsHuman.reason.toolError',
  staff_manual_handoff: 'inbox.detail.needsHuman.reason.staffMarked',
  rooming_issue: 'inbox.detail.needsHuman.reason.rooming',
  booking_question: 'inbox.detail.needsHuman.reason.booking',
  guest_angry: 'inbox.detail.needsHuman.reason.upset',
  transfer_exception: 'inbox.detail.needsHuman.reason.transfer',
  add_guest_on_paid_booking: 'inbox.detail.needsHuman.reason.addGuest',
  needs_booking_identification: 'inbox.detail.needsHuman.reason.whichBooking',
  bad_weather_lesson_refund: 'inbox.detail.needsHuman.reason.weather',
  bilbao_no_package_request: 'inbox.detail.needsHuman.reason.bilbao',
};

function inboxNeedsHumanReasonText(conv){
  var flagged = !!(conv && (conv.needs_human === true || conv.needs_human === 't' || conv.needs_human === 'true'));
  var open = typeof conversationHasOpenHandoff === 'function' && conversationHasOpenHandoff(conv);
  if (!flagged && !open) return '';
  var raw = inboxNeedsHumanReasonCode(conv);
  var code = raw.split(':')[0].trim().toLowerCase();
  var extra = raw.indexOf(':') >= 0 ? raw.slice(raw.indexOf(':') + 1).trim() : '';
  var key = INBOX_NEEDS_REASON_KEYS[code];
  var label = key ? inboxNeedsHumanT(key, '') : '';
  if (!label && code === 'business_tool_error' && /payment_reported_unresolved/i.test(extra)) {
    label = inboxNeedsHumanT('inbox.detail.needsHuman.reason.paymentReported', '');
  }
  if (!label && code && code !== 'needs_human' && code !== 'luna_safe_handoff' && code !== 'needs_staff_reply') {
    label = code.replace(/[_]+/g, ' ');
  }
  if (!label) label = inboxNeedsHumanT('inbox.detail.needsHuman.reasonFallback', 'Luna asked for a person');
  return inboxNeedsHumanT('inbox.detail.handoff.reason', 'Reason') + ': ' + label;
}

function inboxNeedsHumanRaiseHtml(needsHuman){
  var on = !!needsHuman;
  var label = t('inbox.detail.needsHuman.raise');
  return '<button type="button" class="inbox-needs-human-raise' + (on ? ' is-on' : '') +
    '" id="inbox-needs-human-raise" aria-pressed="' + (on ? 'true' : 'false') +
    '" title="' + escHtml(t('inbox.detail.switch.needsHuman')) + '">' +
    escHtml(label) + '</button>';
}

function inboxNeedsHumanChromeHtml(needsHuman, conv){
  var on = !!needsHuman;
  var reason = on ? inboxNeedsHumanReasonText(conv || { needs_human: true }) : '';
  return '<span class="inbox-needs-human-chrome" id="inbox-needs-human-chrome">' +
    inboxNeedsHumanRaiseHtml(needsHuman) +
    '<span class="inbox-needs-human-reason" id="inbox-needs-human-reason"' +
      (reason ? '' : ' hidden') + '>' + escHtml(reason) + '</span></span>';
}

function inboxLunaModeControlHtml(opts){
  opts = opts || {};
  var channel = opts.channel === 'email' ? 'email' : 'whatsapp';
  var paused = opts.paused === true;
  var needsHuman = opts.needs_human === true;
  var mode = inboxLunaModeFromPaused(channel, paused);
  var options = inboxLunaModeOptions(channel);
  var html = '<div class="detail-header-switches">';
  html += '<input type="checkbox" id="luna-pause-switch" class="inbox-luna-mode-native" tabindex="-1" aria-hidden="true"' +
    (paused ? ' checked' : '') + '>';
  html += '<input type="checkbox" id="conv-needs-human-toggle" class="inbox-luna-mode-native" tabindex="-1" aria-hidden="true"' +
    (needsHuman ? ' checked' : '') + '>';
  html += '<div class="inbox-luna-mode" data-inbox-luna-channel="' + channel + '">';
  html += '<span class="inbox-luna-mode-label">' + escHtml(inboxLunaModeHeaderLabel(channel, paused)) + '</span>';
  html += '<div class="inbox-luna-mode-seg" role="radiogroup" aria-label="' + escHtml(t('inbox.detail.lunaMode.label')) + '">';
  for (var i = 0; i < options.length; i++){
    var opt = options[i];
    var active = opt === mode;
    html += '<button type="button" class="inbox-luna-mode-btn' + (active ? ' is-active' : '') + '"';
    html += ' data-luna-mode="' + opt + '" role="radio" aria-checked="' + (active ? 'true' : 'false') + '"';
    html += ' title="' + escHtml(t('inbox.detail.lunaMode.' + opt + 'Help')) + '">';
    html += escHtml(inboxLunaModeBtnCopy(opt));
    html += '</button>';
  }
  html += '</div></div>';
  html += inboxNeedsHumanChromeHtml(needsHuman, opts);
  html += '</div>';
  return html;
}

function inboxThreadScope(targetEl){
  var slot = typeof document !== 'undefined' ? document.getElementById('inbox-chat-chrome-slot') : null;
  if (!slot) return targetEl;
  return {
    querySelector: function(sel){
      return (slot && slot.querySelector(sel)) || (targetEl && targetEl.querySelector && targetEl.querySelector(sel)) || null;
    },
    querySelectorAll: function(sel){
      var out = [];
      if (slot) Array.prototype.push.apply(out, slot.querySelectorAll(sel));
      if (targetEl && targetEl.querySelectorAll) {
        var more = targetEl.querySelectorAll(sel);
        for (var i = 0; i < more.length; i++) {
          if (out.indexOf(more[i]) < 0) out.push(more[i]);
        }
      }
      return out;
    }
  };
}

function setInboxLunaModeBusy(targetEl, busy){
  targetEl = inboxThreadScope(targetEl);
  if (!targetEl) return;
  targetEl.querySelectorAll('.inbox-luna-mode-btn').forEach(function(btn){
    btn.disabled = !!busy;
  });
}

function syncInboxLunaModeControl(targetEl, paused){
  targetEl = inboxThreadScope(targetEl);
  if (!targetEl) return;
  var wrap = targetEl.querySelector('.inbox-luna-mode');
  var sw = targetEl.querySelector('#luna-pause-switch');
  if (sw) sw.checked = !!paused;
  if (!wrap) return;
  var channel = wrap.getAttribute('data-inbox-luna-channel') === 'email' ? 'email' : 'whatsapp';
  var mode = inboxLunaModeFromPaused(channel, paused);
  wrap.querySelectorAll('.inbox-luna-mode-btn').forEach(function(btn){
    var on = btn.getAttribute('data-luna-mode') === mode;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  var labelEl = wrap.querySelector('.inbox-luna-mode-label');
  if (labelEl) labelEl.textContent = inboxLunaModeHeaderLabel(channel, paused);
}

function syncInboxNeedsHumanRaise(targetEl, needsHuman, conv){
  targetEl = inboxThreadScope(targetEl);
  if (!targetEl) return;
  var btn = targetEl.querySelector('#inbox-needs-human-raise');
  var toggle = targetEl.querySelector('#conv-needs-human-toggle');
  if (toggle) toggle.checked = !!needsHuman;
  if (btn) {
    var on = !!needsHuman;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.textContent = t('inbox.detail.needsHuman.raise');
  }
  var reasonEl = targetEl.querySelector('#inbox-needs-human-reason');
  if (!reasonEl) return;
  if (!needsHuman) {
    reasonEl.textContent = '';
    reasonEl.setAttribute('hidden', '');
    return;
  }
  if (conv) {
    var text = inboxNeedsHumanReasonText(Object.assign({ needs_human: true }, conv));
    reasonEl.textContent = text;
    if (text) reasonEl.removeAttribute('hidden');
    else reasonEl.setAttribute('hidden', '');
    return;
  }
  if (!reasonEl.textContent) {
    var fallback = inboxNeedsHumanReasonText({ needs_human: true });
    reasonEl.textContent = fallback;
  }
  if (reasonEl.textContent) reasonEl.removeAttribute('hidden');
}

function wireInboxLunaModeControl(targetEl){
  targetEl = inboxThreadScope(targetEl);
  var wrap = targetEl && targetEl.querySelector('.inbox-luna-mode');
  var sw = targetEl && targetEl.querySelector('#luna-pause-switch');
  if (!wrap || !sw || wrap.dataset.wiredLunaMode === '1') return;
  wrap.dataset.wiredLunaMode = '1';
  wrap.querySelectorAll('.inbox-luna-mode-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      if (sw.disabled) return;
      var wantPaused = btn.getAttribute('data-luna-mode') === 'off';
      if (sw.checked === wantPaused) return;
      sw.checked = wantPaused;
      sw.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

function wireInboxNeedsHumanRaise(targetEl){
  targetEl = inboxThreadScope(targetEl);
  var btn = targetEl && targetEl.querySelector('#inbox-needs-human-raise');
  var toggle = targetEl && targetEl.querySelector('#conv-needs-human-toggle');
  if (!btn || !toggle || btn.dataset.wiredNeedsHumanRaise === '1') return;
  btn.dataset.wiredNeedsHumanRaise = '1';
  btn.addEventListener('click', function(){
    if (toggle.disabled) return;
    toggle.checked = !toggle.checked;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
