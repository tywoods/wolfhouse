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
  var html = '<label class="inbox-shell-channel" data-inbox-shell-channel="' + channel + '">';
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

function inboxShellChannelDefaultsHtml(modes){
  modes = modes || inboxShellLoadStoredModes();
  var wa = inboxShellNormalizeWhatsApp(modes.whatsapp);
  var em = inboxShellNormalizeEmail(modes.email);
  var html = '<div class="inbox-shell-channel-defaults" id="inbox-shell-channel-defaults">';
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
    '.inbox-shell-channel-defaults{display:inline-flex;align-items:center;gap:8px;flex:1;min-width:0;flex-wrap:wrap}',
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
    '#inbox-shell.inbox-two-col.inbox-shell-cols .inbox-col1{',
    'background:var(--surface);',
    'border-radius:var(--radius);',
    '}',
    '#inbox-shell .detail-main{',
    'background:transparent;',
    'border:none;',
    'box-shadow:none;',
    'padding:0;',
    'gap:8px;',
    '}',
    '#inbox-shell .inbox-chat-body,',
    '#inbox-shell .inbox-empty-right{',
    'background:var(--surface);',
    'border-radius:var(--radius);',
    '}',
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
    '#inbox-shell .conv-card-preview,',
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
    '#inbox-shell .inbox-luna-mode-btn.is-active{',
    'background:var(--inbox-forest);',
    'color:var(--cream);',
    '}',
    '#inbox-shell .inbox-luna-mode-btn[data-luna-mode="off"].is-active{',
    'background:#9C3D3D;',
    'color:var(--cream);',
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
    '#tab-conversations .draft-panel{margin-top:auto}',
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
    '#inbox-shell .inbox-guest-card{',
    'background:var(--inbox-paper,var(--cream));',
    'border:0;box-shadow:none;',
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
}

function mountInboxShellChrome(){
  /* Hide the company select even if the toolbar id is missing — that id was
     never on the markup, so a getElementById lookup used to return here and
     leave "Sunset Surf School" painted. */
  inboxShellEnsureStyle();
  hideInboxDuplicateSchoolSelector();
  var toolbar = inboxShellToolbarEl();
  if (!toolbar) return;
  if (!inboxShellById('inbox-shell-channel-defaults')) {
    var mount = document.createElement('div');
    mount.innerHTML = inboxShellChannelDefaultsHtml(inboxShellLoadStoredModes());
    var node = mount.firstChild;
    var refresh = inboxShellById('btn-refresh');
    if (refresh && refresh.parentNode === toolbar) toolbar.insertBefore(node, refresh);
    else toolbar.insertBefore(node, toolbar.firstChild);
  }
  wireInboxShellChannelDefaults();
  inboxShellSyncFromPauseState();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountInboxShellChrome);
  } else {
    mountInboxShellChrome();
  }
}
