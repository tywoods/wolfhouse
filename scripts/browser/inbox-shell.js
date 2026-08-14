/**
 * Staff Portal Inbox — chrome top bar (mockup slice A) and visual tokens (slice C).
 *
 * Two independent channel-default pills, always visible in Inbox chrome
 * (no thread required):
 *
 *   WhatsApp  Auto | Draft | Off
 *   Email     Draft | Off     (never Auto — email does not auto-send)
 *
 * Replaces the tenant/company select (`#c-client`, "Sunset Surf School") that
 * sat in `.inbox-toolbar-top` under the header. School flip stays
 * Sunset | elSardi on the banner school switch. Live status and
 * the existing refresh control stay in this toolbar; command-palette search and
 * a New button are not invented here.
 *
 * Persist (no new state machine):
 *   Prefer PUT /staff/inbox/luna-mode `{ scope: 'channel', channel, value }`.
 *   If that route is not mounted: Off vs unpaused uses today's
 *   `/staff/bot/global-pause` + `/staff/bot/global-resume` for WhatsApp.
 *   WhatsApp Draft stays unpaused so the existing draft/approvals path
 *   (`luna_outbound_approvals` / POST /staff/inbox/whatsapp/draft) can write
 *   a row instead of sending. This module never calls Graph or Cloud send.
 *
 * Thread-header Auto|Draft|Off (#524, inbox-luna-mode.js) is left in place.
 *
 * Injected at the inbox-views marker (prepended) so it does not need a new
 * staff-query-api.js marker. Fragment spliced into the portal IIFE.
 */

var INBOX_SHELL_LUNA_MODE_PATH = '/staff/inbox/luna-mode';
var INBOX_SHELL_STORAGE_KEY = 'wh_staff_inbox_channel_mode_v1';
var INBOX_SHELL_STYLE_ID = 'inbox-shell-channel-defaults-style';
var INBOX_MOCKUP_THEME_STYLE_ID = 'inbox-mockup-theme-style';
var inboxShellLunaModeRouted = null;
var inboxShellPersistGen = 0;

function inboxShellT(key, fallback){
  try {
    if (typeof t === 'function') {
      var v = t(key);
      if (v && v !== key) return v;
    }
  } catch (_e) { /* fall through */ }
  return fallback;
}

function inboxShellChannelOptions(channel){
  if (channel === 'email') return ['draft', 'off'];
  return ['auto', 'draft', 'off'];
}

function inboxShellNormalizeWhatsApp(value){
  if (value === 'draft' || value === 'off' || value === 'auto') return value;
  return 'auto';
}

function inboxShellNormalizeEmail(value){
  if (value === 'off' || value === 'draft') return value;
  return 'draft';
}

function inboxShellStorageClientKey(){
  try {
    if (typeof getClient === 'function') return String(getClient() || 'default');
  } catch (_e) { /* fall through */ }
  return 'default';
}

function inboxShellLoadStoredModes(){
  var empty = { whatsapp: 'auto', email: 'draft' };
  try {
    var raw = localStorage.getItem(INBOX_SHELL_STORAGE_KEY);
    if (!raw) return empty;
    var parsed = JSON.parse(raw);
    var bag = (parsed && parsed[inboxShellStorageClientKey()]) || parsed || {};
    return {
      whatsapp: inboxShellNormalizeWhatsApp(bag.whatsapp),
      email: inboxShellNormalizeEmail(bag.email),
    };
  } catch (_e) {
    return empty;
  }
}

function inboxShellStoreModes(modes){
  var next = {
    whatsapp: inboxShellNormalizeWhatsApp(modes && modes.whatsapp),
    email: inboxShellNormalizeEmail(modes && modes.email),
  };
  try {
    var raw = localStorage.getItem(INBOX_SHELL_STORAGE_KEY);
    var parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') parsed = {};
    parsed[inboxShellStorageClientKey()] = next;
    localStorage.setItem(INBOX_SHELL_STORAGE_KEY, JSON.stringify(parsed));
  } catch (_e) { /* ignore quota / private mode */ }
  return next;
}

function inboxShellOwlIconSvg(){
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="M8.15 6.55 9.55 3.7 11.15 6.35"/>' +
    '<path d="M15.85 6.55 14.45 3.7 12.85 6.35"/>' +
    '<path d="M6.4 10.6c0-3.15 2.35-5.05 5.6-5.05s5.6 1.9 5.6 5.05c0 3.35-1.55 6.55-3.45 8.05-.7.55-1.45.85-2.15.85s-1.45-.3-2.15-.85C7.95 17.15 6.4 13.95 6.4 10.6z"/>' +
    '<circle cx="9.55" cy="10.55" r="2.05"/>' +
    '<circle cx="14.45" cy="10.55" r="2.05"/>' +
    '<path d="M9.55 9.7 10.2 10.55 9.55 11.4 8.9 10.55z" fill="currentColor" stroke="none"/>' +
    '<path d="M14.45 9.7 15.1 10.55 14.45 11.4 13.8 10.55z" fill="currentColor" stroke="none"/>' +
    '<path d="M12 11.55 13.2 12.85 12 14.2 10.8 12.85z"/>' +
    '<path d="M8.15 15.15c.7 1.15 1.65 1.9 2.55 2.2"/>' +
    '<path d="M15.85 15.15c-.7 1.15-1.65 1.9-2.55 2.2"/>' +
    '</svg>';
}

function inboxShellAdoptGlobalPause(){
  var card = inboxShellById('inbox-shell-channel-defaults');
  var pause = inboxShellById('cc-luna-global-pause');
  if (!card || !pause) return;
  if (pause.parentNode !== card) card.appendChild(pause);
  pause.classList.add('channelModeRow');
  var label = pause.querySelector('.tabs-global-pause-label');
  if (label) label.classList.add('channelModeIdentity');
  if (label && !label.querySelector('.inbox-global-pause-owl')) {
    label.innerHTML = '<span class="channelModeIcon inbox-global-pause-owl" aria-hidden="true">' +
      inboxShellOwlIconSvg() + '</span><span>' + escHtml(inboxShellT('inbox.channelControl.globalPause', 'Global Pause')) + '</span>';
  }
  if (!pause.querySelector('[data-inbox-pause]')) {
    var segs = document.createElement('div');
    segs.className = 'channelModeSegmented';
    segs.setAttribute('role', 'group');
    segs.setAttribute('aria-label', inboxShellT('inbox.channelControl.globalPause', 'Global Pause'));
    segs.innerHTML =
      '<button type="button" class="channelModeBtn" data-inbox-pause="off" aria-pressed="true">Off</button>' +
      '<button type="button" class="channelModeBtn" data-inbox-pause="on" aria-pressed="false">' + escHtml(inboxShellT('inbox.channelControl.on', 'On')) + '</button>';
    pause.appendChild(segs);
    segs.addEventListener('click', function(ev){
      var btn = ev.target && ev.target.closest && ev.target.closest('[data-inbox-pause]');
      if (!btn) return;
      var sw = pause.querySelector('input[type="checkbox"]');
      if (!sw || sw.disabled) return;
      var wantOn = btn.getAttribute('data-inbox-pause') === 'on';
      if (!!sw.checked === wantOn) return;
      sw.checked = wantOn;
      sw.dispatchEvent(new Event('change', { bubbles: true }));
      inboxShellSyncPauseChrome(wantOn);
    });
  }
  inboxShellSyncPauseChrome();
}

function inboxShellSyncPauseChrome(paused){
  var card = inboxShellById('inbox-shell-channel-defaults');
  var pause = inboxShellById('cc-luna-global-pause');
  if (!pause) return;
  var sw = pause.querySelector('input[type="checkbox"]');
  var on = typeof paused === 'boolean' ? paused : !!(sw && sw.checked);
  if (card) card.classList.toggle('is-paused', on);
  var btns = pause.querySelectorAll('[data-inbox-pause]');
  for (var i = 0; i < btns.length; i++) {
    var isOnBtn = btns[i].getAttribute('data-inbox-pause') === 'on';
    var selected = isOnBtn ? on : !on;
    btns[i].classList.toggle('isSelected', selected);
    btns[i].classList.toggle('isAuto', isOnBtn && on);
    btns[i].setAttribute('aria-pressed', selected ? 'true' : 'false');
  }
}

function inboxShellAdoptLayoutControls(){
  var tabs = inboxShellById('tabs') || (typeof document !== 'undefined' ? document.getElementById('tabs') : null);
  var controls = typeof document !== 'undefined'
    ? (document.querySelector('#tab-conversations .inbox-layout-controls')
      || document.querySelector('.inbox-layout-controls'))
    : null;
  if (!tabs || !controls) return;
  if (controls.parentNode === tabs) return;
  var tools = inboxShellById('nav-menu-tools');
  if (tools && tools.parentNode === tabs) tabs.insertBefore(controls, tools);
  else tabs.appendChild(controls);
}

function inboxShellAdoptSearch(){
  var list = inboxShellById('inbox-card');
  var wrap = document.querySelector('#tab-conversations .inbox-conv-search-wrap');
  if (!list || !wrap) return;
  if (wrap.parentNode !== list) list.insertBefore(wrap, list.firstChild);
}

function inboxShellChannelIconSvg(channel){
  if (channel === 'email') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg>';
}

function inboxShellChannelSelectHtml(channel, selected){
  var options = inboxShellChannelOptions(channel);
  var labelKey = channel === 'email' ? 'inbox.badge.email' : 'inbox.badge.whatsapp';
  var labelFallback = channel === 'email' ? 'Email' : 'WhatsApp';
  var label = inboxShellT(labelKey, labelFallback);
  var html = '<label class="inbox-shell-channel inbox-shell-channel-native" data-inbox-shell-channel="' + channel + '">';
  html += '<span class="inbox-shell-channel-ico" aria-hidden="true">' + inboxShellChannelIconSvg(channel) + '</span>';
  html += '<span class="inbox-channel-badge inbox-channel-badge-' + channel + ' inbox-shell-channel-name">' + escHtml(label) + '</span>';
  html += '<span class="inbox-shell-channel-sep" aria-hidden="true">·</span>';
  html += '<select id="inbox-shell-' + channel + '-mode" class="inbox-shell-channel-select"';
  html += ' aria-label="' + escHtml(label) + '">';
  for (var i = 0; i < options.length; i++){
    var opt = options[i];
    var optLabel = inboxShellT('inbox.detail.lunaMode.' + opt, opt === 'auto' ? 'Auto' : (opt === 'draft' ? 'Draft' : 'Off'));
    var help = inboxShellT(
      'inbox.shell.' + channel + '.' + opt + 'Help',
      inboxShellT('inbox.detail.lunaMode.' + opt + 'Help', '')
    );
    html += '<option value="' + opt + '"' + (opt === selected ? ' selected' : '');
    if (help) html += ' title="' + escHtml(help) + '"';
    html += '>' + escHtml(optLabel) + '</option>';
  }
  html += '</select></label>';
  return html;
}

function inboxShellAutonomyRowHtml(channel, selected){
  var isEmail = channel === 'email';
  var label = inboxShellT(isEmail ? 'inbox.badge.email' : 'inbox.badge.whatsapp', isEmail ? 'Email' : 'WhatsApp');
  var visual = selected === 'auto' ? 'auto' : 'draft';
  var html = '<div class="channelModeRow" data-inbox-autonomy-row="' + channel + '">';
  html += '<div class="channelModeIdentity">';
  html += '<span class="channelModeIcon" aria-hidden="true">' + inboxShellChannelIconSvg(channel) + '</span>';
  html += '<span>' + escHtml(label) + '</span>';
  html += '</div>';
  html += '<div class="channelModeSegmented" role="group" aria-label="' + escHtml(label) + ' autonomy">';
  html += '<button type="button" class="channelModeBtn' + (visual === 'draft' ? ' isSelected' : '') + '"';
  html += ' data-inbox-autonomy="draft" data-inbox-autonomy-channel="' + channel + '"';
  html += ' aria-pressed="' + (visual === 'draft' ? 'true' : 'false') + '"';
  html += ' title="Luna prepares replies for staff approval">' + escHtml(inboxShellT('inbox.detail.lunaMode.draft', 'Draft')) + '</button>';
  html += '<button type="button" class="channelModeBtn' + (visual === 'auto' ? ' isSelected isAuto' : '') + '"';
  html += ' data-inbox-autonomy="auto" data-inbox-autonomy-channel="' + channel + '"';
  html += ' aria-pressed="' + (visual === 'auto' ? 'true' : 'false') + '"';
  html += ' title="Luna can reply automatically">Auto</button>';
  html += '</div></div>';
  return html;
}

function inboxShellChannelDefaultsHtml(modes){
  modes = modes || inboxShellLoadStoredModes();
  var wa = inboxShellNormalizeWhatsApp(modes.whatsapp);
  var em = inboxShellNormalizeEmail(modes.email);
  var html = '<div class="inbox-shell-channel-defaults channelAutonomy" id="inbox-shell-channel-defaults">';
  html += '<div class="channelAutonomyLabel">' + escHtml(inboxShellT('inbox.channelControl.title', 'CHANNEL AUTONOMY')) + '</div>';
  html += inboxShellAutonomyRowHtml('whatsapp', wa);
  html += inboxShellAutonomyRowHtml('email', em);
  html += inboxShellChannelSelectHtml('whatsapp', wa);
  html += inboxShellChannelSelectHtml('email', em);
  html += '</div>';
  return html;
}

function inboxShellCssText(){
  return [
    /* Native <select> ignores clip/sr-only and still paints "Sunset Surf School".
       #c-client has no parent id on the toolbar row, so also hide by the select id. */
    '#c-client.inbox-client-select,',
    '#tab-conversations #c-client,',
    '#tab-conversations .inbox-toolbar-top .inbox-client-select,',
    '#tab-conversations #inbox-school-context,',
    '.inbox-shell-toolbar #c-client,',
    '.inbox-shell-toolbar #inbox-school-context,',
    '.inbox-toolbar-top #c-client{',
    'display:none!important;width:0!important;min-width:0!important;height:0!important;',
    'margin:0!important;padding:0!important;border:0!important;overflow:hidden!important;',
    'position:absolute!important;opacity:0!important;pointer-events:none!important;',
    '}',
    /* Keep the tab-row global pause visible so Inbox nav matches Schedule/Admin. */
    '.inbox-shell-channel-defaults{display:block;width:218px;padding:9px;',
    'border:1px solid rgba(47,65,57,.10);border-radius:12px;background:rgba(250,248,242,.88);',
    'box-shadow:0 4px 14px rgba(37,47,42,.06);backdrop-filter:blur(8px);flex:0 0 auto}',
    '.channelAutonomyLabel{margin:0 0 7px 3px;font-size:10px;font-weight:700;letter-spacing:.11em;color:#9aa59d}',
    '.channelModeRow{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:34px}',
    '.channelModeRow + .channelModeRow{margin-top:5px}',
    '.channelAutonomy #cc-luna-global-pause{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:5px;min-height:34px;width:100%}',
    '.channelAutonomy #cc-luna-global-pause .tabs-global-pause-toggle{display:contents!important;width:auto;padding:0;margin:0}',
    '.channelAutonomy #cc-luna-global-pause .tabs-global-pause-label,',
    '.channelAutonomy #cc-luna-global-pause .channelModeIdentity{flex:0 1 auto;min-width:82px;gap:7px}',
    '.inbox-global-pause-owl{width:18px;height:18px;overflow:visible;display:grid;place-items:center;color:#75847c;flex:0 0 auto}',
    '.inbox-global-pause-owl svg{width:20px;height:20px;margin:-1px;display:block}',
    '.channelAutonomy.is-paused{background:rgba(199,74,74,.10);border-color:rgba(199,74,74,.22)}',
    '[data-theme="dark"] .channelAutonomy{background:var(--surface);border-color:var(--border);box-shadow:none}',
    '[data-theme="dark"] .channelAutonomy.is-paused{background:rgba(180,70,65,.24);border-color:rgba(199,74,74,.35)}',
    '.channelModeIdentity{display:flex;align-items:center;gap:7px;min-width:82px;font-size:12px;font-weight:600;color:#31443a}',
    '[data-theme="dark"] .channelModeIdentity{color:#fff}',
    '[data-theme="dark"] .inbox-global-pause .tabs-global-pause-label{color:#fff}',
    '[data-theme="dark"] .channelModeBtn{color:#fff}',
    '[data-theme="dark"] .channelModeSegmented{background:rgba(20,20,20,.45);border-color:rgba(255,255,255,.14)}',
    '[data-theme="dark"] .channelModeBtn.isSelected{background:#3a4a40;color:#fff}',
    '[data-theme="dark"] .channelModeBtn.isSelected.isAuto{background:#31483d;color:#fff}',
    '.channelModeIcon{width:18px;height:18px;display:grid;place-items:center;color:#75847c;flex:0 0 auto}',
    '.channelModeIcon svg{width:16px;height:16px;display:block}',
    '.channelModeIcon.inbox-global-pause-owl{width:18px;height:18px;overflow:visible}',
    '.channelModeIcon.inbox-global-pause-owl svg{width:20px;height:20px;margin:-1px}',
    '.channelModeSegmented{display:inline-flex;padding:2px;border:1px solid rgba(47,65,57,.10);border-radius:9px;background:rgba(235,232,223,.72)}',
    '.channelModeBtn{min-width:47px;height:26px;padding:0 9px;border:0;border-radius:7px;background:transparent;',
    'color:#7c877f;font-size:11px;font-weight:650;cursor:pointer;',
    'transition:background 140ms ease,color 140ms ease,box-shadow 140ms ease}',
    '.channelModeBtn:hover{color:#31443a}',
    '.channelModeBtn.isSelected{background:#f9f7f1;color:#31443a;box-shadow:0 1px 3px rgba(30,42,36,.10)}',
    '.channelModeBtn.isSelected.isAuto{background:#31483d;color:#fff}',
    '.channelModeBtn:focus-visible{outline:2px solid rgba(49,72,61,.35);outline-offset:2px}',
    '.inbox-shell-channel-native{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;',
    'display:none!important;white-space:nowrap;border:0}',
    '.inbox-shell-channel-defaults.is-busy .channelModeBtn{opacity:.7;cursor:not-allowed}',
    '.inbox-toolbar-channels{align-items:center}',
    '.inbox-toolbar-channels .inbox-refresh-btn{margin-left:0;margin-top:0}',
    '.inbox-chat-chrome-slot{justify-content:flex-end}',
    '.inbox-shell-channel{display:inline-flex;align-items:center;gap:6px;height:32px;box-sizing:border-box;',
    'padding:0 10px 0 8px;border:1px solid var(--border);border-radius:8px;background:var(--surface);',
    'cursor:pointer;max-width:100%;position:relative}',
    '.inbox-shell-channel-ico{flex:0 0 auto;width:16px;height:16px;color:var(--text-3);display:inline-flex}',
    '.inbox-shell-channel-ico svg{width:16px;height:16px;display:block}',
    '.inbox-shell-channel .inbox-channel-badge{margin:0;background:transparent;border:0;padding:0;',
    'text-transform:none;letter-spacing:0;font-size:12px;font-weight:600;color:var(--text);line-height:1}',
    '.inbox-shell-channel-sep{color:var(--text-3);font-size:12px;line-height:1;flex:0 0 auto}',
    '.inbox-shell-channel-select{-webkit-appearance:none;appearance:none;border:0;background:transparent;',
    'font:inherit;font-size:12px;font-weight:600;color:var(--text);cursor:pointer;padding:0 14px 0 0;',
    'min-width:3.4em;max-width:7em;line-height:1}',
    '.inbox-shell-channel::after{content:"\\25BE";position:absolute;right:8px;top:50%;transform:translateY(-50%);',
    'font-size:10px;color:var(--text-3);pointer-events:none;line-height:1}',
    '.inbox-shell-channel-select:disabled{opacity:.45;cursor:not-allowed}',
    '.inbox-shell-channel-defaults.is-busy .inbox-shell-channel-select{opacity:.7}',
    '[data-theme="dark"] .inbox-shell-channel{background:var(--surface);border-color:var(--border)}',
    '[data-theme="dark"] .inbox-shell-channel-select{color:var(--text)}',
    '[data-theme="dark"] .inbox-shell-channel .inbox-channel-badge{color:var(--text)}',
  ].join('');
}

function inboxMockupThemeCssText(){
  return [
    '/* cream paper, forest green, sage — Inbox mockup slice C */',
    '#tab-conversations,',
    '#inbox-shell{',
    '--inbox-paper:var(--cream);',
    '--inbox-forest:#2F4A3E;',
    '--inbox-sage:var(--sage);',
    '}',
    '[data-theme="dark"] #tab-conversations,',
    '[data-theme="dark"] #inbox-shell{',
    '--inbox-paper:var(--cream);',
    '--inbox-forest:var(--staff-green-bg,#1e3a28);',
    '--inbox-sage:var(--sage);',
    '}',

    /* Card surfaces sit a step above the cream page so rail + chat read as cards */
    '#inbox-shell.inbox-two-col.inbox-shell-cols .inbox-views-rail{',
    'background:var(--surface);',
    'border-radius:var(--radius);',
    '}',
    '#tab-conversations #cc-luna-global-pause,',
    '#tab-conversations #cc-luna-global-pause .tabs-global-pause-toggle{',
    'display:flex!important;flex-direction:row!important;flex-wrap:nowrap!important;',
    'align-items:center!important;white-space:nowrap;',
    '}',
    '#inbox-shell.inbox-two-col.inbox-shell-cols .inbox-col1{',
    'background:transparent;',
    '}',
    '#inbox-shell .detail-header{',
    'background:var(--surface);',
    'border:1px solid var(--border-soft);',
    'border-radius:var(--radius);',
    'margin-bottom:10px;',
    '}',
    '#inbox-shell .detail-main{',
    'background:transparent;',
    'border:none;',
    'box-shadow:none;',
    'padding:0;',
    'gap:10px;',
    '}',
    '#inbox-shell .thread-section,',
    '#inbox-shell .draft-panel textarea{',
    'background:var(--surface);',
    'border-radius:var(--radius);',
    '}',
    'body:has([data-inbox-preset="chat"][aria-pressed="true"]) #inbox-shell .detail-main,',
    'body:has([data-inbox-preset="all4"][aria-pressed="true"]) #inbox-shell .detail-main{gap:0;padding:0}',
    'body:has([data-inbox-preset="chat"][aria-pressed="true"]) #inbox-shell .detail-header,',
    'body:has([data-inbox-preset="all4"][aria-pressed="true"]) #inbox-shell .detail-header{',
    'background:var(--surface);border:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft);',
    'border-radius:var(--radius) var(--radius) 0 0;margin:0 0 0;box-shadow:none;',
    '}',
    'body:has([data-inbox-preset="chat"][aria-pressed="true"]) #inbox-shell .thread-section,',
    'body:has([data-inbox-preset="all4"][aria-pressed="true"]) #inbox-shell .thread-section{',
    'background:var(--surface);border:1px solid var(--border-soft);border-top:none;',
    'border-radius:0 0 var(--radius) var(--radius);',
    '}',
    'body:has([data-inbox-preset="chat"][aria-pressed="true"]) #inbox-shell .thread-messages,',
    'body:has([data-inbox-preset="all4"][aria-pressed="true"]) #inbox-shell .thread-messages{padding:12px 16px 10px}',
    'body:has([data-inbox-preset="chat"][aria-pressed="true"]) #inbox-shell .msg.inbound,',
    'body:has([data-inbox-preset="all4"][aria-pressed="true"]) #inbox-shell .msg.inbound{margin-left:8px;margin-right:28px}',
    'body:has([data-inbox-preset="chat"][aria-pressed="true"]) #inbox-shell .msg.outbound,',
    'body:has([data-inbox-preset="all4"][aria-pressed="true"]) #inbox-shell .msg.outbound{margin-right:8px;margin-left:28px}',
    'body:has([data-inbox-preset="chat"][aria-pressed="true"]) #inbox-shell .draft-panel,',
    'body:has([data-inbox-preset="all4"][aria-pressed="true"]) #inbox-shell .draft-panel{margin-top:12px;padding-top:8px}',
    'body:has([data-inbox-preset="chat"][aria-pressed="true"]) .inbox-peek-edge-col4,',
    'body:has([data-inbox-preset="chat"][aria-pressed="true"]) #inbox-shell .sidebar-expand-btn,',
    'body:has([data-inbox-preset="chat"][aria-pressed="true"]) #inbox-shell[data-col4="hidden"] .detail-sidebar{',
    'display:none!important;pointer-events:none!important;',
    '}',
    '#inbox-shell .inbox-empty-right{',
    'background:var(--surface);',
    'border-radius:var(--radius);',
    '}',
    '#tab-conversations:has(#inbox-shell[data-col4="wide"]) #inbox-chat-chrome-slot{visibility:hidden}',
    '#inbox-shell.inbox-two-col.inbox-shell-cols .inbox-left{',
    'background:var(--surface-soft);',
    'border-radius:var(--radius);',
    '}',
    '#inbox-shell.inbox-two-col.inbox-shell-cols #inbox-detail-sidebar > .inbox-guest-card,',
    '#inbox-shell #inbox-guest-card.inbox-guest-card,',
    '#inbox-shell .inbox-customer-card{',
    'background:var(--surface);',
    'border-radius:var(--radius);',
    'box-shadow:none;',
    '}',
    '#inbox-shell.inbox-two-col.inbox-shell-cols #inbox-detail-sidebar > .sidebar-card{',
    'background:var(--inbox-paper,var(--cream));',
    'box-shadow:none;',
    'border-radius:var(--radius);',
    '}',

    /* Rail section headers (API group labels, small-caps) */
    '#inbox-shell .inbox-views-group-label{',
    'font-variant:small-caps;',
    'letter-spacing:.14em;',
    'text-transform:uppercase;',
    'color:var(--inbox-sage,var(--sage));',
    'font-size:11px;',
    'font-weight:700;',
    '}',
    '#inbox-shell .inbox-views-item{',
    'border-radius:var(--radius-sm);',
    'color:var(--text);',
    '}',
    '#inbox-shell .inbox-views-item:hover:not(.is-active){',
    'background:rgba(47,74,62,.08);',
    '}',
    '#inbox-shell .inbox-views-item.is-active{',
    'background:var(--inbox-forest);',
    'color:var(--cream);',
    'border-radius:var(--radius-sm);',
    '}',
    '#inbox-shell .inbox-views-item-count{',
    'color:var(--inbox-sage,var(--sage));',
    '}',
    '#inbox-shell .inbox-views-item.is-active .inbox-views-item-count{',
    'color:var(--cream);',
    'opacity:.85;',
    '}',
    '#inbox-shell .inbox-views-empty{',
    'color:var(--inbox-sage,var(--sage));',
    '}',

    /* Name emphasis + sage secondary / dimmed zero-state */
    '#inbox-shell .conv-card-name,',
    '#inbox-shell .inbox-guest-name,',
    '#inbox-shell .detail-name{',
    'color:var(--inbox-forest);',
    '}',
    '#inbox-shell .conv-card-preview{display:none!important}',
    '#inbox-shell .conv-card-time,',
    '#inbox-shell .inbox-guest-tags,',
    '#inbox-shell .detail-meta{',
    'color:var(--text-2);',
    '}',
    '#inbox-shell .inbox-guest-section.is-zero{',
    'opacity:.45;',
    'color:var(--inbox-sage,var(--sage));',
    '}',

    /* Channel selectors (slice A) + layout presets: surface, 8px radius */
    '#tab-conversations .inbox-shell-channel{',
    'background:var(--surface);',
    'border:1px solid var(--border);',
    'border-radius:8px;',
    '}',
    '#tab-conversations .inbox-shell-channel-select{',
    'color:var(--text);',
    '}',
    '#tab-conversations .inbox-layout-presets{',
    'border-radius:var(--radius-pill,999px);',
    'background:var(--inbox-paper,var(--cream));',
    '}',
    '#tabs .inbox-layout-controls{display:none;margin-left:auto;align-self:center}',
    '#tabs .inbox-layout-controls #btn-refresh{display:none!important}',
    '#inbox-shell .detail-header-right #btn-refresh,',
    '#inbox-shell .inbox-header-stack-luna #btn-refresh{',
    'display:inline-flex;align-items:center;justify-content:center;',
    'margin:0;min-width:24px;width:24px;height:24px;padding:0;',
    'border-radius:6px;border:1px solid var(--border);',
    'background:transparent;color:var(--text-2);box-shadow:none;',
    'font-size:13px;line-height:1;',
    '}',
    '#inbox-shell #btn-email-save-draft{display:none!important}',
    '#inbox-shell .inbox-header-stack{display:flex;flex-direction:column;align-items:flex-end;gap:6px}',
    '#inbox-shell .inbox-header-stack-luna{display:flex;align-items:center;justify-content:flex-end;gap:8px}',
    '#inbox-shell .detail-header-id{display:flex;align-items:center;gap:8px;min-width:0}',
    'body:has(.tab-btn[data-tab="conversations"].active) #tabs .inbox-layout-controls{display:flex}',
    '#tab-conversations .inbox-shell-toolbar{display:none!important}',
    '#tab-conversations.active #wrap.inbox-shell-wrap{padding-top:8px!important}',
    '#tab-conversations .inbox-layout-preset-btn{',
    'border-radius:var(--radius-pill,999px);',
    '}',
    '#tab-conversations .inbox-layout-preset-btn[aria-pressed="true"],',
    '#tab-conversations .inbox-layout-preset-btn.is-active{',
    'background:var(--inbox-forest);',
    'color:var(--cream);',
    'border-color:var(--inbox-forest);',
    '}',
    '#inbox-shell .inbox-luna-mode-seg{',
    'border-radius:var(--radius-pill,999px);',
    'background:var(--inbox-paper,var(--cream));',
    '}',
    '#inbox-shell .inbox-luna-mode-btn[data-luna-mode="auto"].is-active,',
    '#inbox-shell .inbox-luna-mode-btn[data-luna-mode="draft"].is-active{',
    'background:#3B7FB0;',
    'color:#fff;',
    '}',
    '#inbox-shell .inbox-luna-mode-btn[data-luna-mode="off"].is-active{',
    'background:#E8C4C4;',
    'color:#9C3D3D;',
    '}',

    '[data-theme="dark"] #inbox-shell .inbox-views-item.is-active{',
    'background:var(--inbox-forest);',
    'color:var(--staff-green-text,#c8dcc8);',
    '}',
    '[data-theme="dark"] #inbox-shell .conv-card-name,',
    '[data-theme="dark"] #inbox-shell .inbox-guest-name,',
    '[data-theme="dark"] #inbox-shell .detail-name{',
    'color:var(--staff-green-text,#c8dcc8);',
    '}',
    '[data-theme="dark"] #tab-conversations .inbox-layout-preset-btn[aria-pressed="true"],',
    '[data-theme="dark"] #tab-conversations .inbox-layout-preset-btn.is-active{',
    'background:var(--inbox-forest);',
    'color:var(--staff-green-text,#c8dcc8);',
    '}',

    /* Density: hide leftover Conversations chrome the mockup does not have */
    '#tab-conversations .inbox-view-switch{display:none!important}',
    '#tab-conversations .detail-conv-toolbar{display:none!important}',
    '#tab-conversations .detail-conv-toolbar.inbox-dev-overflow{display:none!important}',
    '#tab-conversations .inbox-dev-overflow-summary{cursor:pointer;list-style:none;color:var(--inbox-sage,var(--sage));font-size:14px;width:1.5em}',
    '#tab-conversations .inbox-dev-overflow-summary::-webkit-details-marker{display:none}',
    '#tab-conversations .draft-panel{margin-top:8px}',
    '#tab-conversations #inbox-live-status{display:none!important}',
    '#tab-conversations #inbox-open-customer-card{display:none!important}',
    '#inbox-shell .inbox-thread-day{',
    'display:flex;align-items:center;justify-content:center;gap:10px;',
    'margin:14px 12px 10px;font-size:11px;font-weight:600;letter-spacing:.04em;',
    'text-transform:uppercase;color:var(--inbox-sage,var(--sage));',
    '}',
    '#inbox-shell .inbox-thread-day::before,',
    '#inbox-shell .inbox-thread-day::after{content:"";flex:1;height:1px;background:rgba(47,74,62,.16)}',
    '#inbox-shell .inbox-whatsapp-draft-in-timeline{display:flex;justify-content:flex-end;padding:4px 10px 12px}',
    '#inbox-shell .inbox-whatsapp-draft-in-timeline[hidden]{display:none!important}',
    '#inbox-shell .inbox-whatsapp-draft-card{',
    'max-width:min(420px,86%);background:var(--inbox-paper,var(--cream));',
    'border:1px dashed var(--inbox-forest);border-radius:16px 16px 4px 16px;',
    'padding:10px 12px;box-shadow:none;',
    '}',
    '#inbox-shell .inbox-whatsapp-draft-label{font-size:11px;font-weight:700;color:var(--inbox-forest);margin-bottom:6px}',
    '#inbox-shell .inbox-whatsapp-draft-text{font-size:14px;line-height:1.4;color:var(--text);white-space:pre-wrap}',
    '#inbox-shell .inbox-whatsapp-draft-tools{font-size:11px;color:var(--inbox-sage,var(--sage));margin:8px 0 6px}',
    '#inbox-shell .inbox-whatsapp-draft-card .draft-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
    '#inbox-shell .inbox-whatsapp-draft-card .msg-meta,',
    '#inbox-shell .inbox-whatsapp-draft-card .msg-ticks{display:none!important}',
    '#inbox-shell .btn-whatsapp-draft-approve{',
    'background:var(--inbox-forest);color:var(--cream);border:0;border-radius:var(--radius-pill,999px);',
    'padding:6px 12px;font-weight:700;cursor:pointer;',
    '}',
    '#inbox-shell .btn-whatsapp-draft-edit,',
    '#inbox-shell .btn-whatsapp-draft-discard{',
    'background:transparent;color:var(--inbox-forest);border:1px solid var(--inbox-forest);',
    'border-radius:var(--radius-pill,999px);padding:6px 12px;font-weight:600;cursor:pointer;',
    '}',
    '#inbox-shell .inbox-guest-actions .btn.inbox-guest-create-booking{',
    'background:var(--inbox-forest);color:var(--cream);border:0;border-radius:var(--radius-pill,999px);',
    'padding:8px 16px;text-decoration:none;font-weight:700;font-size:13px;',
    '}',
    '#inbox-shell .conv-card-pills,',
    '#inbox-shell .conv-card-delete,',
    '#inbox-shell .conv-card-contact,',
    '#inbox-shell .conv-card-phone{display:none!important}',
    '#inbox-shell .conv-card{',
    'background:var(--surface);border:0;box-shadow:none;border-radius:0;',
    'border-bottom:1px solid var(--border-soft);padding:10px 12px;',
    '}',
    '#inbox-shell .conv-card:hover{background:var(--surface-soft)}',
    '#inbox-shell .conv-card.selected{background:var(--teal)}',
    '#inbox-shell .inbox-row-avatar{',
    'background:var(--inbox-forest);color:var(--cream);',
    '}',
    '#inbox-shell #conv-list,',
    '#inbox-shell.inbox-two-col.inbox-shell-cols .inbox-left{',
    'background:var(--surface-soft);',
    '}',
    '[data-theme="dark"] #inbox-shell .conv-card{background:var(--surface)}',
    '[data-theme="dark"] #inbox-shell .conv-card:hover{background:#2a2a2a}',
    '[data-theme="dark"] #inbox-shell .conv-card.selected{background:var(--staff-green-bg,#1e3a28)}',
    '[data-theme="dark"] #inbox-shell #conv-list,',
    '[data-theme="dark"] #inbox-shell.inbox-two-col.inbox-shell-cols .inbox-left{',
    'background:var(--surface-soft);',
    '}',
    '#tab-conversations .inbox-toolbar-top{',
    'background:var(--inbox-paper,var(--cream));',
    '}',
    '@media(max-width:768px){',
    '#tab-conversations .inbox-toolbar-top{display:flex;flex-wrap:wrap;grid-template-columns:none;gap:8px}',
    '#tab-conversations .inbox-layout-presets{display:none!important}',
    '#tabs .inbox-layout-controls{display:none!important}',
    '#tab-conversations .inbox-shell-channel-defaults{width:100%;max-width:100%;box-sizing:border-box}',
    '}',
    '#inbox-shell .inbox-guest-card{',
    'background:var(--inbox-paper,var(--cream));',
    'border:0;box-shadow:none;',
    '}',
    '.inbox-guest-restore{display:none}',
    '@media(min-width:901px){',
    'body:has([data-inbox-preset="all4"][aria-pressed="true"]) #inbox-shell.inbox-two-col.inbox-shell-cols[data-col4="hidden"] > .inbox-guest-restore{',
    'display:flex;align-items:center;justify-content:center;',
    'position:absolute;top:50%;right:0;z-index:25;transform:translateY(-50%);',
    'width:22px;min-height:88px;padding:10px 0;',
    'border:1px solid var(--border-soft);border-right:none;border-radius:10px 0 0 10px;',
    'background:var(--surface);color:var(--text);',
    'font:inherit;font-size:11px;font-weight:600;letter-spacing:.04em;',
    'writing-mode:vertical-rl;cursor:pointer;',
    '}',
    '#inbox-shell[data-peek="col4"] > .inbox-guest-restore{display:none!important}',
    '#inbox-shell.inbox-guest-drawer > .inbox-guest-restore{display:none!important}',
    '#inbox-shell.inbox-guest-drawer[data-col4="hidden"] .detail-sidebar{',
    'display:flex!important;position:absolute;top:0;bottom:0;right:0;',
    'width:var(--inbox-col4-peek-w,300px);z-index:26;opacity:1;visibility:visible;transform:none;',
    '}',
    '.inbox-layout-preset-btn[data-inbox-preset="chat"]{display:none!important}',
    '}',
  ].join('');
}

function inboxMockupThemeEnsureStyle(){
  if (typeof document === 'undefined') return;
  if (document.getElementById(INBOX_MOCKUP_THEME_STYLE_ID)) return;
  var style = document.createElement('style');
  style.id = INBOX_MOCKUP_THEME_STYLE_ID;
  style.textContent = inboxMockupThemeCssText();
  (document.head || document.documentElement).appendChild(style);
}

function inboxShellEnsureStyle(){
  if (typeof document === 'undefined') return;
  if (!document.getElementById(INBOX_SHELL_STYLE_ID)) {
    var style = document.createElement('style');
    style.id = INBOX_SHELL_STYLE_ID;
    style.textContent = inboxShellCssText();
    (document.head || document.documentElement).appendChild(style);
  }
  inboxMockupThemeEnsureStyle();
}

function inboxShellById(id){
  if (typeof el === 'function') {
    var byId = el(id);
    if (byId) return byId;
  }
  if (typeof document !== 'undefined' && document.getElementById) return document.getElementById(id);
  return null;
}

function inboxShellToolbarEl(){
  var byId = typeof el === 'function' ? el('inbox-toolbar-top') : inboxShellById('inbox-toolbar-top');
  if (byId) return byId;
  if (typeof document === 'undefined' || !document.querySelector) return null;
  return document.querySelector('#tab-conversations .inbox-toolbar-top') ||
    document.querySelector('.inbox-shell-toolbar .inbox-toolbar-top') ||
    document.querySelector('.inbox-toolbar-top');
}

function hideInboxDuplicateSchoolSelector(){
  var sel = inboxShellById('c-client');
  if (sel) {
    sel.classList.add('inbox-client-select-hidden');
    sel.setAttribute('aria-hidden', 'true');
    sel.tabIndex = -1;
    sel.style.setProperty('display', 'none', 'important');
  }
  var school = inboxShellById('inbox-school-context');
  if (school) {
    school.style.setProperty('display', 'none', 'important');
    school.setAttribute('aria-hidden', 'true');
  }
  /* renderInboxSchoolContext later sets display:block on sunset. Keep it off. */
  if (typeof renderInboxSchoolContext === 'function' && !renderInboxSchoolContext._inboxShellHidden) {
    renderInboxSchoolContext = function(){
      var wrap = inboxShellById('inbox-school-context');
      if (wrap) {
        wrap.style.setProperty('display', 'none', 'important');
        wrap.setAttribute('aria-hidden', 'true');
      }
    };
    renderInboxSchoolContext._inboxShellHidden = true;
  }
}

function inboxShellSetBusy(busy){
  var wrap = typeof el === 'function' ? el('inbox-shell-channel-defaults') : null;
  if (!wrap) return;
  wrap.classList.toggle('is-busy', !!busy);
  wrap.querySelectorAll('.inbox-shell-channel-select').forEach(function(sel){
    sel.disabled = !!busy;
  });
}

function inboxShellReadUiModes(){
  var wa = typeof el === 'function' ? el('inbox-shell-whatsapp-mode') : null;
  var em = typeof el === 'function' ? el('inbox-shell-email-mode') : null;
  return {
    whatsapp: inboxShellNormalizeWhatsApp(wa && wa.value),
    email: inboxShellNormalizeEmail(em && em.value),
  };
}

function inboxShellApplyUiModes(modes){
  var wa = typeof el === 'function' ? el('inbox-shell-whatsapp-mode') : null;
  var em = typeof el === 'function' ? el('inbox-shell-email-mode') : null;
  if (wa) wa.value = inboxShellNormalizeWhatsApp(modes && modes.whatsapp);
  if (em) em.value = inboxShellNormalizeEmail(modes && modes.email);
  inboxShellSyncAutonomyButtons();
}

function inboxShellSyncAutonomyButtons(){
  var wrap = typeof el === 'function' ? el('inbox-shell-channel-defaults') : null;
  if (!wrap) return;
  ['whatsapp', 'email'].forEach(function(channel){
    var sel = typeof el === 'function' ? el('inbox-shell-' + channel + '-mode') : null;
    var visual = (sel && sel.value === 'auto') ? 'auto' : 'draft';
    var row = wrap.querySelector('[data-inbox-autonomy-row="' + channel + '"]');
    if (!row) return;
    var btns = row.querySelectorAll('[data-inbox-autonomy]');
    for (var i = 0; i < btns.length; i++){
      var mode = btns[i].getAttribute('data-inbox-autonomy');
      var on = mode === visual;
      btns[i].classList.toggle('isSelected', on);
      btns[i].classList.toggle('isAuto', on && mode === 'auto');
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  });
}

function inboxShellClientQuery(){
  try {
    if (typeof inboxClientQuery === 'function') return inboxClientQuery();
  } catch (_e) { /* fall through */ }
  return '';
}

function inboxShellPutLunaMode(channel, value){
  return fetch(INBOX_SHELL_LUNA_MODE_PATH + inboxShellClientQuery(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ scope: 'channel', channel: channel, value: value }),
  }).then(function(r){
    if (r.status === 404 || r.status === 405 || r.status === 501) {
      inboxShellLunaModeRouted = false;
      return { routed: false, status: r.status };
    }
    return r.text().then(function(raw){
      var data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch (_e) { data = null; }
      var routed = r.ok && !!(data && data.success !== false);
      inboxShellLunaModeRouted = routed || r.status < 500;
      if (r.status >= 400 && r.status !== 401 && r.status !== 403) {
        inboxShellLunaModeRouted = false;
        return { routed: false, status: r.status, data: data };
      }
      return { routed: true, ok: r.ok, status: r.status, data: data };
    });
  }).catch(function(){
    inboxShellLunaModeRouted = false;
    return { routed: false, status: 0 };
  });
}

function inboxShellFallbackWhatsAppPause(wantPaused){
  var path = wantPaused ? '/staff/bot/global-pause' : '/staff/bot/global-resume';
  var client = (typeof getClient === 'function') ? getClient() : '';
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_slug: client }),
  }).then(function(r){
    return r.json().then(function(data){ return { ok: r.ok, status: r.status, data: data || {} }; });
  });
}

function inboxShellLoadGlobalPause(){
  var client = (typeof getClient === 'function') ? getClient() : '';
  return fetch('/staff/bot/global-pause-state?client_slug=' + encodeURIComponent(client), {
    headers: { Accept: 'application/json' },
  }).then(function(r){
    return r.json().then(function(data){ return { ok: r.ok, data: data || {} }; });
  }).catch(function(){
    return { ok: false, data: {} };
  });
}

function persistInboxShellChannelMode(channel, value){
  var gen = ++inboxShellPersistGen;
  inboxShellSetBusy(true);
  var stored = inboxShellLoadStoredModes();
  if (channel === 'email') stored.email = inboxShellNormalizeEmail(value);
  else stored.whatsapp = inboxShellNormalizeWhatsApp(value);
  inboxShellStoreModes(stored);

  function done(ok){
    if (gen !== inboxShellPersistGen) return;
    inboxShellSetBusy(false);
    if (!ok) inboxShellApplyUiModes(inboxShellLoadStoredModes());
  }

  if (inboxShellLunaModeRouted === false) {
    return inboxShellPersistFallback(channel, stored).then(function(ok){ done(ok); return ok; });
  }

  return inboxShellPutLunaMode(channel, stored[channel === 'email' ? 'email' : 'whatsapp'])
    .then(function(res){
      if (gen !== inboxShellPersistGen) return false;
      if (res && res.routed) {
        done(!!(res.ok || (res.data && res.data.success)));
        return !!(res.ok || (res.data && res.data.success));
      }
      return inboxShellPersistFallback(channel, stored).then(function(ok){ done(ok); return ok; });
    });
}

function inboxShellPersistFallback(channel, stored){
  if (channel === 'email') return Promise.resolve(true);
  var wantPaused = stored.whatsapp === 'off';
  return inboxShellFallbackWhatsAppPause(wantPaused).then(function(res){
    var data = (res && res.data) || {};
    if (res && res.status === 403 && (data.error === 'bot_pause_controls_disabled' || data.enabled === false)) {
      return true;
    }
    return !!(res && res.ok && data.success !== false);
  }).catch(function(){
    return false;
  });
}

function inboxShellSyncFromPauseState(){
  return inboxShellLoadGlobalPause().then(function(res){
    var data = (res && res.data) || {};
    var paused = data.paused === true || data.bot_paused === true;
    var stored = inboxShellLoadStoredModes();
    if (paused) stored.whatsapp = 'off';
    else if (stored.whatsapp === 'off') stored.whatsapp = 'auto';
    inboxShellStoreModes(stored);
    inboxShellApplyUiModes(stored);
    return stored;
  }).catch(function(){
    inboxShellApplyUiModes(inboxShellLoadStoredModes());
  });
}

function wireInboxShellChannelDefaults(){
  var wrap = typeof el === 'function' ? el('inbox-shell-channel-defaults') : null;
  if (!wrap || wrap.dataset.wiredInboxShell === '1') return;
  wrap.dataset.wiredInboxShell = '1';
  wrap.addEventListener('change', function(ev){
    var sel = ev.target;
    if (!sel || !sel.getAttribute) return;
    var id = sel.id || '';
    if (id === 'inbox-shell-whatsapp-mode') {
      persistInboxShellChannelMode('whatsapp', sel.value);
      return;
    }
    if (id === 'inbox-shell-email-mode') {
      persistInboxShellChannelMode('email', sel.value);
    }
  });
  wrap.addEventListener('click', function(ev){
    var btn = ev.target && ev.target.closest && ev.target.closest('[data-inbox-autonomy]');
    if (!btn || btn.disabled) return;
    var channel = btn.getAttribute('data-inbox-autonomy-channel');
    var mode = btn.getAttribute('data-inbox-autonomy');
    if (!channel || !mode) return;
    var sel = typeof el === 'function' ? el('inbox-shell-' + channel + '-mode') : null;
    if (!sel) return;
    var next = channel === 'email' ? inboxShellNormalizeEmail(mode) : inboxShellNormalizeWhatsApp(mode);
    if (sel.value === next) return;
    sel.value = next;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    inboxShellSyncAutonomyButtons();
  });
}

function inboxShellGuestApi(){
  return (typeof window !== 'undefined' && window.__inboxColumns) ? window.__inboxColumns : null;
}

function inboxShellIsFullPreset(){
  return !!(typeof document !== 'undefined'
    && document.querySelector('[data-inbox-preset="all4"][aria-pressed="true"]'));
}

function inboxShellGuestDrawerShell(){
  return inboxShellById('inbox-shell');
}

function inboxShellGuestDrawerIsOpen(){
  var shell = inboxShellGuestDrawerShell();
  return !!(shell && shell.classList && shell.classList.contains('inbox-guest-drawer'));
}

function inboxShellGuestDrawerOpen(){
  var shell = inboxShellGuestDrawerShell();
  if (!shell) return;
  shell.classList.add('inbox-guest-drawer');
  inboxShellSyncHideButton();
}

function inboxShellGuestDrawerClose(){
  var shell = inboxShellGuestDrawerShell();
  if (shell) shell.classList.remove('inbox-guest-drawer');
  inboxShellSyncHideButton();
}

function inboxShellGuestPanelPref(){
  return (typeof window !== 'undefined' && window.__staffInboxGuestPanel === 'pinned') ? 'pinned' : 'hidden';
}

function inboxShellRememberGuestPanel(pref){
  var next = pref === 'pinned' ? 'pinned' : 'hidden';
  if (typeof window !== 'undefined') window.__staffInboxGuestPanel = next;
  try {
    fetch('/staff/auth/prefs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ inbox_guest_panel: next })
    });
  } catch (_e) { /* ignore */ }
}

function inboxShellApplyGuestPanelPref(pref){
  if (pref === 'pinned' || pref === 'hidden') {
    if (typeof window !== 'undefined') window.__staffInboxGuestPanel = pref;
  }
  var api = inboxShellGuestApi();
  if (!api || typeof api.setColumn !== 'function' || !inboxShellIsFullPreset()) return;
  if (inboxShellGuestPanelPref() === 'pinned') {
    api.setColumn('col4', 'peek');
  } else {
    api.setColumn('col4', 'hidden');
  }
  if (typeof api.clearPeek === 'function') api.clearPeek();
  inboxShellGuestDrawerClose();
}

function inboxShellDefaultHideGuest(){
  inboxShellApplyGuestPanelPref(inboxShellGuestPanelPref());
}

function inboxShellSyncHideButton(){
  var btn = inboxShellById('inbox-customer-hide');
  if (!btn) return;
  var peeking = inboxShellGuestDrawerIsOpen();
  var label = peeking ? 'Pin guest card' : 'Hide guest card';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

function wireInboxShellGuestHide(){
  if (typeof document === 'undefined') return;
  if (document.documentElement.getAttribute('data-wired-inbox-guest-hide') === '1') return;
  document.documentElement.setAttribute('data-wired-inbox-guest-hide', '1');
  document.addEventListener('click', function(ev){
    var target = ev.target && ev.target.closest ? ev.target : null;
    if (!target || !target.closest) return;
    var api = inboxShellGuestApi();
    if (target.closest('#inbox-guest-restore')) {
      if (ev.preventDefault) ev.preventDefault();
      if (ev.stopPropagation) ev.stopPropagation();
      inboxShellGuestDrawerOpen();
      return;
    }
    if (target.closest('#inbox-customer-hide')) {
      if (ev.preventDefault) ev.preventDefault();
      if (!api || typeof api.setColumn !== 'function') return;
      if (inboxShellGuestDrawerIsOpen()) {
        api.setColumn('col4', 'peek');
        if (typeof api.clearPeek === 'function') api.clearPeek();
        inboxShellGuestDrawerClose();
        inboxShellRememberGuestPanel('pinned');
      } else {
        api.setColumn('col4', 'hidden');
        if (typeof api.clearPeek === 'function') api.clearPeek();
        inboxShellGuestDrawerClose();
        inboxShellRememberGuestPanel('hidden');
      }
      inboxShellSyncHideButton();
      return;
    }
    if (target.closest('[data-inbox-preset="all4"]')) {
      requestAnimationFrame(function(){
        inboxShellApplyGuestPanelPref(inboxShellGuestPanelPref());
      });
    }
  }, true);
}

function inboxShellFinishGuestHide(){
  wireInboxShellGuestHide();
  inboxShellDefaultHideGuest();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(inboxShellDefaultHideGuest);
}

function mountInboxShellChrome(){
  /* Hide the company select even if the toolbar id is missing — that id was
     never on the markup, so a getElementById lookup used to return here and
     leave "Sunset Surf School" painted. */
  inboxShellEnsureStyle();
  hideInboxDuplicateSchoolSelector();
  var toolbar = inboxShellToolbarEl();
  if (!toolbar) return inboxShellFinishGuestHide();
  if (!inboxShellById('inbox-shell-channel-defaults')) {
    var mount = document.createElement('div');
    mount.innerHTML = inboxShellChannelDefaultsHtml(inboxShellLoadStoredModes());
    var node = mount.firstChild;
    var slot = inboxShellById('inbox-channel-autonomy-slot');
    var refresh = inboxShellById('btn-refresh');
    if (slot) slot.appendChild(node);
    else {
      var host = (refresh && refresh.parentNode) || toolbar;
      if (refresh && refresh.parentNode === host) host.insertBefore(node, refresh);
      else host.insertBefore(node, host.firstChild);
    }
  }
  wireInboxShellChannelDefaults();
  inboxShellAdoptGlobalPause();
  inboxShellAdoptSearch();
  inboxShellAdoptLayoutControls();
  inboxShellSyncFromPauseState();
  inboxShellFinishGuestHide();
}

if (typeof window !== 'undefined') {
  window.inboxShellApplyGuestPanelPref = inboxShellApplyGuestPanelPref;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountInboxShellChrome);
  } else {
    mountInboxShellChrome();
  }
}
