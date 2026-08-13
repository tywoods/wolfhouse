/**
 * Staff Portal Inbox — chrome top bar (mockup slice A).
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

function inboxShellChannelSelectHtml(channel, selected){
  var options = inboxShellChannelOptions(channel);
  var labelKey = channel === 'email' ? 'inbox.badge.email' : 'inbox.badge.whatsapp';
  var labelFallback = channel === 'email' ? 'Email' : 'WhatsApp';
  var label = inboxShellT(labelKey, labelFallback);
  var html = '<label class="inbox-shell-channel" data-inbox-shell-channel="' + channel + '">';
  html += '<span class="inbox-channel-badge inbox-channel-badge-' + channel + '">' + escHtml(label) + '</span>';
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
    '#tab-conversations #c-client.inbox-client-select-hidden,',
    '.inbox-toolbar-top #c-client.inbox-client-select-hidden{',
    'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;',
    'clip:rect(0,0,0,0);white-space:nowrap;border:0;flex:0;min-width:0;pointer-events:none;',
    '}',
    '.inbox-shell-channel-defaults{display:inline-flex;align-items:center;gap:10px;flex:1;min-width:0;flex-wrap:wrap}',
    '.inbox-shell-channel{display:inline-flex;align-items:center;gap:6px;padding:2px 8px 2px 4px;',
    'border:1px solid var(--border);border-radius:999px;background:var(--surface);cursor:pointer;',
    'max-width:100%}',
    '.inbox-shell-channel .inbox-channel-badge{margin:0}',
    '.inbox-shell-channel-select{border:0;background:transparent;font:inherit;font-size:11px;',
    'font-weight:700;color:var(--text);cursor:pointer;padding:2px 0;min-width:4.5em;max-width:8em}',
    '.inbox-shell-channel-select:disabled{opacity:.45;cursor:not-allowed}',
    '.inbox-shell-channel-defaults.is-busy .inbox-shell-channel-select{opacity:.7}',
    '[data-theme="dark"] .inbox-shell-channel{background:#1e1e1e;border-color:#3c3c3c}',
    '[data-theme="dark"] .inbox-shell-channel-select{color:#cccccc}',
  ].join('');
}

function inboxShellEnsureStyle(){
  if (typeof document === 'undefined') return;
  if (document.getElementById(INBOX_SHELL_STYLE_ID)) return;
  var style = document.createElement('style');
  style.id = INBOX_SHELL_STYLE_ID;
  style.textContent = inboxShellCssText();
  (document.head || document.documentElement).appendChild(style);
}

function hideInboxDuplicateSchoolSelector(){
  var sel = typeof el === 'function' ? el('c-client') : null;
  if (sel) {
    sel.classList.add('inbox-client-select-hidden');
    sel.setAttribute('aria-hidden', 'true');
    sel.tabIndex = -1;
    sel.title = sel.title || 'Company';
  }
  var school = typeof el === 'function' ? el('inbox-school-context') : null;
  if (school) {
    school.style.display = 'none';
    school.setAttribute('aria-hidden', 'true');
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
  if (typeof el !== 'function') return;
  var toolbar = el('inbox-toolbar-top');
  if (!toolbar) return;
  inboxShellEnsureStyle();
  hideInboxDuplicateSchoolSelector();
  if (!el('inbox-shell-channel-defaults')) {
    var mount = document.createElement('div');
    mount.innerHTML = inboxShellChannelDefaultsHtml(inboxShellLoadStoredModes());
    var node = mount.firstChild;
    var refresh = el('btn-refresh');
    if (refresh && refresh.parentNode === toolbar) toolbar.insertBefore(node, refresh);
    else toolbar.insertBefore(node, toolbar.firstChild);
  }
  wireInboxShellChannelDefaults();
  inboxShellSyncFromPauseState();
}

if (typeof document !== 'undefined' && typeof el === 'function') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountInboxShellChrome);
  } else {
    mountInboxShellChrome();
  }
}
