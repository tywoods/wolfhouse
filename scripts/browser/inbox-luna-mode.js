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
  var fallback = email ? 'draft' : 'auto';
  if (typeof inboxShellLoadStoredModes !== 'function') return fallback;
  try {
    var stored = inboxShellLoadStoredModes() || {};
    if (email) {
      return typeof inboxShellNormalizeEmail === 'function'
        ? inboxShellNormalizeEmail(stored.email)
        : (stored.email === 'off' ? 'off' : 'draft');
    }
    return typeof inboxShellNormalizeWhatsApp === 'function'
      ? inboxShellNormalizeWhatsApp(stored.whatsapp)
      : (stored.whatsapp === 'draft' || stored.whatsapp === 'off' ? stored.whatsapp : 'auto');
  } catch (_e) {
    return fallback;
  }
}

function inboxLunaModeIsInherited(channel, paused){
  return inboxLunaModeChannelDefault(channel) === inboxLunaModeFromPaused(channel, paused);
}

function inboxLunaModeHeaderLabel(channel, paused){
  var mode = inboxLunaModeFromPaused(channel, paused);
  var label = t('inbox.detail.lunaMode.label') + ': ' + t('inbox.detail.lunaMode.' + mode);
  if (inboxLunaModeIsInherited(channel, paused)) {
    label += ' (' + t('inbox.detail.lunaMode.inherited') + ')';
  }
  return label;
}

function inboxNeedsHumanRaiseHtml(needsHuman){
  var on = !!needsHuman;
  var label = t('inbox.detail.needsHuman.raise');
  return '<button type="button" class="inbox-needs-human-raise' + (on ? ' is-on' : '') +
    '" id="inbox-needs-human-raise" aria-pressed="' + (on ? 'true' : 'false') +
    '" title="' + escHtml(t('inbox.detail.switch.needsHuman')) + '">' +
    escHtml(label) + '</button>';
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
    html += escHtml(t('inbox.detail.lunaMode.' + opt));
    html += '</button>';
  }
  html += '</div></div>';
  html += inboxNeedsHumanRaiseHtml(needsHuman);
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

function syncInboxNeedsHumanRaise(targetEl, needsHuman){
  targetEl = inboxThreadScope(targetEl);
  if (!targetEl) return;
  var btn = targetEl.querySelector('#inbox-needs-human-raise');
  var toggle = targetEl.querySelector('#conv-needs-human-toggle');
  if (toggle) toggle.checked = !!needsHuman;
  if (!btn) return;
  var on = !!needsHuman;
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.textContent = t('inbox.detail.needsHuman.raise');
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
