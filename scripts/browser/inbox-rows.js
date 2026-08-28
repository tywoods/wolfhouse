/**
 * Staff Portal Inbox — column 2 list rows (mockup slice D).
 *
 * Wraps renderInboxConvCardHtml after inbox-thread exists (this module is
 * concatenated onto the views inject: shell, views, context, rows). Keeps the
 * original card HTML (name, WHATSAPP/EMAIL badge, preview, relative time) and
 * prepends an initials avatar, optional multi-select checkbox, and a real
 * unread class only when the row already carries unread / last_read.
 *
 * Visual tokens (cream/forest) are slice C. This file only adds structural
 * classes and hides the old Conversations filter chips when the saved-view
 * rail is present.
 */

var INBOX_ROWS_STYLE_ID = 'inbox-rows-styles';
var INBOX_ROWS_FILTER_DEBOUNCE_MS = 280;
var INBOX_ROWS_CSS = [
  '#inbox-shell.inbox-legacy-filters-hidden .inbox-left-toolbar,',
  '#tab-conversations.inbox-legacy-filters-hidden .inbox-left-toolbar,',
  '#inbox-shell.inbox-legacy-filters-hidden .inbox-filter-btn,',
  '#tab-conversations.inbox-legacy-filters-hidden .inbox-filter-btn{display:none!important}',
  '.conv-card.inbox-row{display:flex;align-items:flex-start;gap:10px;min-width:0;max-width:100%;overflow:hidden;box-sizing:border-box}',
  '.inbox-row-select{flex:0 0 auto;display:none;align-items:center;padding-top:8px}',
  '.inbox-row-avatar{flex:0 0 auto;width:32px;height:32px;border-radius:50%;',
  'display:inline-flex;align-items:center;justify-content:center;',
  'font-size:11px;font-weight:700;letter-spacing:.02em;',
  'background:var(--surface-soft);color:var(--text-2);margin-top:2px}',
  '.inbox-row-body{flex:1 1 auto;min-width:0;overflow:hidden}',
  '.inbox-row-body .conv-card-name,.inbox-row-body .conv-card-header-row{min-width:0;max-width:100%}',
  '#conv-list{overflow-x:hidden}',
  '.inbox-row-unread-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;',
  'background:currentColor;opacity:.7;margin-top:10px}',
  '.inbox-filter-this-view-wrap{display:none!important}',
  '.inbox-filter-this-view-label{display:block;font-size:10px;font-weight:700;',
  'letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:4px}',
  '.inbox-filter-this-view{width:100%;box-sizing:border-box;padding:8px 10px;',
  'border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;',
  'background:var(--surface);color:var(--text)}',
  '.inbox-row-select-footer{flex-shrink:0;display:flex;align-items:center;gap:10px;',
  'padding:8px 12px;border-top:1px solid var(--border-soft);font-size:12px;color:var(--text-2)}',
  '.inbox-row-select-footer[hidden]{display:none!important}',
  '.inbox-row-broadcast-btn{margin-left:auto;border:1px solid var(--border);',
  'border-radius:8px;background:var(--surface);padding:6px 10px;font-size:12px;',
  'font-weight:600;cursor:pointer}',
  '#inbox-shell[data-inbox-multiselect="false"] .inbox-row-select,',
  '#tab-conversations[data-inbox-multiselect="false"] .inbox-row-select,',
  '#inbox-shell .inbox-row-select,',
  '#tab-conversations .inbox-row-select{display:none!important}',
  /* Needs-human attention: same orange as .inbox-needs-human-raise.is-on */
  '.conv-card.inbox-row-needs-human .inbox-channel-badge{color:#E8893A}',
  '.conv-card.inbox-row-needs-human .inbox-channel-badge svg{stroke:currentColor}',
].join('');

var inboxRowsRuntime = { wired: false };
var inboxRowsViewsCache = [];
var inboxRowsActiveView = {
  id: '',
  source: '',
  multiSelect: false,
  searchSupported: false,
};
var inboxRowsSelected = {};
var inboxRowsFilterQuery = '';
var inboxRowsFilterTimer = null;

function inboxRowsEsc(value) {
  if (typeof escHtml === 'function') return escHtml(value);
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inboxRowsEl(id) {
  if (typeof el === 'function') return el(id);
  if (typeof document === 'undefined' || !document.getElementById) return null;
  return document.getElementById(id);
}

function inboxRowInitials(name) {
  var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function inboxRowHasUnread(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.unread === true || row.is_unread === true) return true;
  if (typeof row.unread_count === 'number' && row.unread_count > 0) return true;
  if (row.last_read_at && row.last_activity) {
    var readAt = Date.parse(row.last_read_at);
    var activity = Date.parse(row.last_activity);
    if (!isNaN(readAt) && !isNaN(activity) && activity > readAt) return true;
  }
  return false;
}

/** Same Needs human copy as the thread header raise control (EN/ES via existing keys). */
function inboxRowsNeedsHumanLabel() {
  var key = 'inbox.detail.needsHuman.raise';
  if (typeof t === 'function') {
    var viaT = t(key);
    if (viaT && viaT !== key) return String(viaT);
  }
  if (typeof portalT === 'function') {
    var viaPortal = portalT(key);
    if (viaPortal && viaPortal !== key) return String(viaPortal);
  }
  return 'Needs human';
}

/** Legacy list-row chip text that disagreed with the header Needs human pill. */
function inboxRowsStaffReplyChipLabel() {
  var key = 'inbox.detail.meta.needsStaffReply';
  if (typeof t === 'function') {
    var viaT = t(key);
    if (viaT && viaT !== key) return String(viaT);
  }
  if (typeof portalT === 'function') {
    var viaPortal = portalT(key);
    if (viaPortal && viaPortal !== key) return String(viaPortal);
  }
  return 'Needs staff reply';
}

/**
 * When conversations.needs_human is true, rewrite the list-row handoff chip
 * from "Needs staff reply" to the existing Needs human label. Unflagged rows
 * and chips with other handoff reasons are left alone.
 */
function inboxRowsRewriteNeedsHumanChip(html, row) {
  html = String(html || '');
  if (!row || row.needs_human !== true) return html;
  var staffReply = inboxRowsStaffReplyChipLabel();
  var needsHuman = inboxRowsNeedsHumanLabel();
  var escapedNeeds = inboxRowsEsc(needsHuman);
  // handoffLabel() still hardcodes EN "Needs staff reply" for some reasons.
  var legacyExact = {
    'Needs staff reply': true,
  };
  if (staffReply) legacyExact[staffReply] = true;
  legacyExact[inboxRowsEsc(staffReply)] = true;
  return html.replace(
    /(<div class="conv-card-handoff">)([\s\S]*?)(<\/div>)/g,
    function(match, open, inner, close) {
      var text = String(inner || '').trim();
      if (!legacyExact[text]) return match;
      return open + escapedNeeds + close;
    }
  );
}

function inboxRowKey(row) {
  if (!row) return '';
  return String(row._inbox_view_key || row.conversation_id || row.phone || row.guest_email || '');
}

function inboxRowsSearchSupported() {
  return inboxRowsActiveView.searchSupported === true;
}

function inboxRowsMultiSelectActive() {
  return inboxRowsActiveView.multiSelect === true;
}

function inboxRowsViewById(viewId) {
  var id = String(viewId || '');
  var list = inboxRowsViewsCache || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === id) return list[i];
  }
  return null;
}

function inboxRowsPublishActiveView() {
  var shell = inboxRowsEl('inbox-shell');
  var tab = inboxRowsEl('tab-conversations');
  var hosts = [shell, tab];
  for (var i = 0; i < hosts.length; i++) {
    if (!hosts[i] || !hosts[i].setAttribute) continue;
    hosts[i].setAttribute('data-inbox-view', inboxRowsActiveView.id || '');
    hosts[i].setAttribute('data-inbox-view-source', inboxRowsActiveView.source || '');
    hosts[i].setAttribute('data-inbox-multiselect', inboxRowsActiveView.multiSelect ? 'true' : 'false');
    hosts[i].setAttribute('data-inbox-search-supported', inboxRowsActiveView.searchSupported ? 'true' : 'false');
  }
  if (typeof window !== 'undefined') {
    window.__inboxActiveSavedView = inboxRowsActiveView;
  }
}

function inboxRowsSyncActiveView(viewId) {
  var id = viewId || (typeof inboxSavedViewId === 'string' ? inboxSavedViewId : '') || inboxRowsActiveView.id;
  var view = inboxRowsViewById(id) || {};
  var source = view.source || '';
  inboxRowsActiveView = {
    id: id,
    source: source,
    multiSelect: view.multi_select === true && source === 'customers',
    searchSupported: source === 'customers',
  };
  inboxRowsPublishActiveView();
}

function inboxRowsRememberViews(data) {
  inboxRowsViewsCache = (data && data.views) || [];
  inboxRowsSyncActiveView();
}

function inboxRowsWrapConvCardHtml(html, row) {
  html = inboxRowsRewriteNeedsHumanChip(String(html || ''), row);
  var openMatch = html.match(/^(\s*<div\b[^>]*class="[^"]*conv-card[^"]*"[^>]*>)/);
  if (!openMatch) return html;
  var open = openMatch[1];
  var rest = html.slice(open.length);
  var closeMatch = rest.match(/<\/div>\s*$/);
  if (!closeMatch) return html;
  var inner = rest.slice(0, rest.length - closeMatch[0].length);
  var unread = inboxRowHasUnread(row);
  var multi = inboxRowsMultiSelectActive();
  var key = inboxRowKey(row);
  var extras = ' inbox-row';
  if (unread) extras += ' inbox-row-unread';
  if (multi) extras += ' inbox-row-multiselect';
  if (row && row.needs_human === true) extras += ' inbox-row-needs-human';
  var newOpen = open.replace(/class="([^"]*)"/, 'class="$1' + extras + '"');
  if (key && newOpen.indexOf('data-inbox-row-key=') < 0) {
    newOpen = newOpen.replace(/<div\b/, '<div data-inbox-row-key="' + inboxRowsEsc(key) + '"');
  }
  var prefix = '';
  if (multi) {
    prefix += '<label class="inbox-row-select" hidden>' +
      '<input type="checkbox" class="inbox-row-checkbox" data-inbox-row-key="' +
      inboxRowsEsc(key) + '"' + (key && inboxRowsSelected[key] ? ' checked' : '') + '>' +
      '</label>';
  }
  prefix += '<div class="inbox-row-avatar" aria-hidden="true">' +
    inboxRowsEsc(inboxRowInitials(
      (typeof inboxPersonDisplayName === 'function') ? inboxPersonDisplayName(row) : (row && row.guest_name)
    )) + '</div>';
  prefix += '<div class="inbox-row-body">';
  var suffix = '</div>';
  if (unread) suffix += '<span class="inbox-row-unread-dot" aria-hidden="true"></span>';
  return newOpen + prefix + inner + suffix + closeMatch[0];
}

function inboxRowsHideLegacyFilterChips() {
  if (typeof document === 'undefined') return;
  var rail = inboxRowsEl('inbox-views-rail');
  if (!rail) return;
  var shell = inboxRowsEl('inbox-shell');
  var tab = inboxRowsEl('tab-conversations');
  if (shell && shell.classList) shell.classList.add('inbox-legacy-filters-hidden');
  if (tab && tab.classList) tab.classList.add('inbox-legacy-filters-hidden');
}

function inboxRowsEnsureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(INBOX_ROWS_STYLE_ID)) return;
  var style = document.createElement('style');
  style.id = INBOX_ROWS_STYLE_ID;
  style.textContent = INBOX_ROWS_CSS;
  var head = document.head || document.getElementsByTagName('head')[0];
  if (head) head.appendChild(style);
}

function inboxRowsApplyFilterQuery() {
  inboxRowsFilterQuery = String(inboxRowsFilterQuery || '').trim();
  if (typeof loadInbox === 'function') {
    loadInbox(null, { silent: true, preserveDetail: true });
  }
}

function inboxRowsOnFilterInput(ev) {
  var input = ev && ev.target;
  inboxRowsFilterQuery = input ? String(input.value || '') : '';
  if (inboxRowsFilterTimer) clearTimeout(inboxRowsFilterTimer);
  inboxRowsFilterTimer = setTimeout(inboxRowsApplyFilterQuery, INBOX_ROWS_FILTER_DEBOUNCE_MS);
}

function inboxRowsEnsureFilterField() {
  if (typeof document === 'undefined') return;
  var card = inboxRowsEl('inbox-card');
  if (!card) return;
  var wrap = inboxRowsEl('inbox-filter-this-view-wrap');
  var supported = inboxRowsSearchSupported();
  if (!supported) {
    if (wrap) wrap.hidden = true;
    inboxRowsFilterQuery = '';
    return;
  }
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'inbox-filter-this-view-wrap';
    wrap.className = 'inbox-filter-this-view-wrap';
    wrap.innerHTML = '<label class="inbox-filter-this-view-label" for="inbox-filter-this-view">Filter this view</label>' +
      '<input type="search" id="inbox-filter-this-view" class="inbox-filter-this-view" placeholder="Filter this view" autocomplete="off">';
    var rows = card.querySelector ? card.querySelector('.inbox-left-rows') : null;
    if (rows && rows.parentNode === card) card.insertBefore(wrap, rows);
    else card.insertBefore(wrap, card.firstChild);
    var input = wrap.querySelector('#inbox-filter-this-view');
    if (input) input.addEventListener('input', inboxRowsOnFilterInput);
  }
  wrap.hidden = false;
  var field = wrap.querySelector('#inbox-filter-this-view');
  if (field && field.value !== inboxRowsFilterQuery) field.value = inboxRowsFilterQuery;
}

function inboxRowsSelectedCount() {
  var n = 0;
  for (var key in inboxRowsSelected) {
    if (Object.prototype.hasOwnProperty.call(inboxRowsSelected, key) && inboxRowsSelected[key]) n += 1;
  }
  return n;
}

function inboxRowsOpenBroadcast() {
  if (typeof inboxBroadcastOpen === 'function') {
    inboxBroadcastOpen();
    return true;
  }
  return false;
}

function inboxRowsEnsureSelectFooter() {
  if (typeof document === 'undefined') return;
  var card = inboxRowsEl('inbox-card');
  if (!card) return;
  var footer = inboxRowsEl('inbox-row-select-footer');
  var multi = inboxRowsMultiSelectActive();
  if (!multi) {
    if (footer) footer.hidden = true;
    return;
  }
  if (!footer) {
    footer = document.createElement('div');
    footer.id = 'inbox-row-select-footer';
    footer.className = 'inbox-row-select-footer';
    footer.innerHTML = '<span id="inbox-row-selected-count" hidden>0 selected</span>';
    if (typeof inboxBroadcastOpen === 'function') {
      footer.innerHTML += '<button type="button" class="inbox-row-broadcast-btn" id="inbox-row-broadcast">Email broadcast</button>';
    }
    card.appendChild(footer);
    var btn = footer.querySelector('#inbox-row-broadcast');
    if (btn) {
      btn.addEventListener('click', function(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        inboxRowsOpenBroadcast();
      });
    }
  }
  footer.hidden = false;
  inboxRowsSyncFooter();
}

function inboxRowsSyncFooter() {
  var countEl = inboxRowsEl('inbox-row-selected-count');
  if (countEl) countEl.textContent = String(inboxRowsSelectedCount()) + ' selected';
}

function inboxRowsOnToggle(box) {
  var key = box && box.getAttribute ? box.getAttribute('data-inbox-row-key') : '';
  if (!key) return;
  if (box.checked) inboxRowsSelected[key] = true;
  else delete inboxRowsSelected[key];
  inboxRowsSyncFooter();
}

function inboxRowsWireCheckboxes() {
  var list = inboxRowsEl('conv-list');
  if (!list || !list.querySelectorAll) return;
  var labels = list.querySelectorAll('.inbox-row-select');
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].dataset.inboxRowsWired === '1') continue;
    labels[i].dataset.inboxRowsWired = '1';
    labels[i].addEventListener('click', function(ev) { ev.stopPropagation(); });
  }
  var boxes = list.querySelectorAll('.inbox-row-checkbox');
  for (var j = 0; j < boxes.length; j++) {
    if (boxes[j].dataset.inboxRowsWired === '1') continue;
    boxes[j].dataset.inboxRowsWired = '1';
    boxes[j].addEventListener('click', function(ev) { ev.stopPropagation(); });
    boxes[j].addEventListener('change', function(ev) {
      ev.stopPropagation();
      inboxRowsOnToggle(ev.target);
    });
  }
}

function inboxRowsAfterRender() {
  inboxRowsEnsureStyles();
  inboxRowsHideLegacyFilterChips();
  inboxRowsEnsureFilterField();
  inboxRowsEnsureSelectFooter();
  inboxRowsWireCheckboxes();
  if (!inboxRowsMultiSelectActive()) {
    inboxRowsSelected = {};
    var footer = inboxRowsEl('inbox-row-select-footer');
    if (footer) footer.hidden = true;
  }
}

function inboxRowsOnViewChange(viewId) {
  var prevId = inboxRowsActiveView.id;
  inboxRowsSyncActiveView(viewId);
  if (inboxRowsActiveView.id !== prevId) {
    inboxRowsSelected = {};
    inboxRowsFilterQuery = '';
  }
  if (!inboxRowsSearchSupported()) inboxRowsFilterQuery = '';
  inboxRowsAfterRender();
}

function inboxRowsPassThroughUnread(mapped, row) {
  if (!mapped || !row) return mapped;
  if (row.unread != null) mapped.unread = row.unread;
  if (row.is_unread != null) mapped.is_unread = row.is_unread;
  if (row.unread_count != null) mapped.unread_count = row.unread_count;
  if (row.last_read_at != null) mapped.last_read_at = row.last_read_at;
  return mapped;
}

/* INBOX-FILTER-RESELECT-001: filter/search must not silently open the first
 * remaining thread. Initial Inbox load (no selection) may still pick the top
 * row; a later filter, search, or rail view must keep the open guest or drop
 * to a neutral pane — never loadConvDetail(convs[0]). */
function inboxRowsPreserveSelectionOpts(opts) {
  opts = opts || {};
  var keepId = opts.selectedId;
  if (keepId == null && typeof selectedConvId !== 'undefined') keepId = selectedConvId;
  if (!keepId) return opts;
  return Object.assign({}, opts, { preserveDetail: true, selectedId: keepId });
}

function inboxRowsWrapFilterReselect() {
  if (typeof loadInbox === 'function' && !loadInbox._inboxFilterReselectWrapped) {
    var _inboxRowsLegacyLoadInbox = loadInbox;
    loadInbox = function(selectConvIdAfterLoad, opts) {
      opts = opts || {};
      if (!selectConvIdAfterLoad && typeof selectedConvId !== 'undefined' && selectedConvId) {
        opts = Object.assign({}, opts, { silent: true, preserveDetail: true });
      }
      return _inboxRowsLegacyLoadInbox(selectConvIdAfterLoad, opts);
    };
    loadInbox._inboxFilterReselectWrapped = true;
  }
  if (typeof applyInboxFilter === 'function' && !applyInboxFilter._inboxFilterReselectWrapped) {
    var _inboxRowsLegacyApplyFilter = applyInboxFilter;
    applyInboxFilter = function(opts) {
      return _inboxRowsLegacyApplyFilter(inboxRowsPreserveSelectionOpts(opts));
    };
    applyInboxFilter._inboxFilterReselectWrapped = true;
  }
}

function inboxRowsWrapRenderers() {
  if (typeof renderInboxConvCardHtml === 'function' && !renderInboxConvCardHtml._inboxRowsWrapped) {
    var _inboxRowsLegacyRenderConvCardHtml = renderInboxConvCardHtml;
    renderInboxConvCardHtml = function(c, profile) {
      return inboxRowsWrapConvCardHtml(_inboxRowsLegacyRenderConvCardHtml(c, profile), c);
    };
    renderInboxConvCardHtml._inboxRowsWrapped = true;
  }
  if (typeof renderInbox === 'function' && !renderInbox._inboxRowsWrapped) {
    var _inboxRowsLegacyRenderInbox = renderInbox;
    renderInbox = function(convs, opts) {
      var result = _inboxRowsLegacyRenderInbox(convs, inboxRowsPreserveSelectionOpts(opts));
      inboxRowsAfterRender();
      return result;
    };
    renderInbox._inboxRowsWrapped = true;
  }
  if (typeof mapInboxPersonRowToConv === 'function' && !mapInboxPersonRowToConv._inboxRowsWrapped) {
    var _inboxRowsLegacyMapPerson = mapInboxPersonRowToConv;
    mapInboxPersonRowToConv = function(row) {
      return inboxRowsPassThroughUnread(_inboxRowsLegacyMapPerson(row), row);
    };
    mapInboxPersonRowToConv._inboxRowsWrapped = true;
  }
}

function inboxRowsWrapViews() {
  if (typeof renderInboxViewsRail === 'function' && !renderInboxViewsRail._inboxRowsWrapped) {
    var _inboxRowsLegacyRenderRail = renderInboxViewsRail;
    renderInboxViewsRail = function(data) {
      _inboxRowsLegacyRenderRail(data);
      inboxRowsRememberViews(data);
      inboxRowsAfterRender();
    };
    renderInboxViewsRail._inboxRowsWrapped = true;
  }
  if (typeof selectInboxSavedView === 'function' && !selectInboxSavedView._inboxRowsWrapped) {
    var _inboxRowsLegacySelect = selectInboxSavedView;
    selectInboxSavedView = function(viewId) {
      inboxRowsOnViewChange(viewId);
      _inboxRowsLegacySelect(viewId);
    };
    selectInboxSavedView._inboxRowsWrapped = true;
  }
  if (typeof inboxSavedViewListUrl === 'function' && !inboxSavedViewListUrl._inboxRowsWrapped) {
    var _inboxRowsLegacyListUrl = inboxSavedViewListUrl;
    inboxSavedViewListUrl = function(viewId) {
      var url = _inboxRowsLegacyListUrl(viewId);
      if (inboxRowsSearchSupported() && inboxRowsFilterQuery) {
        url += '&q=' + encodeURIComponent(inboxRowsFilterQuery);
      }
      return url;
    };
    inboxSavedViewListUrl._inboxRowsWrapped = true;
  }
}

function inboxRowsInstall() {
  if (inboxRowsRuntime.wired) return true;
  inboxRowsEnsureStyles();
  inboxRowsWrapRenderers();
  inboxRowsWrapViews();
  inboxRowsWrapFilterReselect();
  inboxRowsHideLegacyFilterChips();
  inboxRowsAfterRender();
  inboxRowsRuntime.wired = true;
  return true;
}

if (typeof window !== 'undefined') {
  window.__inboxRows = {
    initials: inboxRowInitials,
    hasUnread: inboxRowHasUnread,
    rowKey: inboxRowKey,
    wrapConvCardHtml: inboxRowsWrapConvCardHtml,
    rewriteNeedsHumanChip: inboxRowsRewriteNeedsHumanChip,
    needsHumanLabel: inboxRowsNeedsHumanLabel,
    hideLegacyFilterChips: inboxRowsHideLegacyFilterChips,
    openBroadcast: inboxRowsOpenBroadcast,
    preserveSelectionOpts: inboxRowsPreserveSelectionOpts,
    wrapFilterReselect: inboxRowsWrapFilterReselect,
    install: inboxRowsInstall,
    CSS: INBOX_ROWS_CSS,
    runtime: inboxRowsRuntime,
  };
}

inboxRowsInstall();
