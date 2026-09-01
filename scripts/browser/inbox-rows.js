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
  /* Prefer readable names over single-glyph ellipsis ("Sim…") in a crushed col2 */
  '.inbox-row-body .conv-card-name{white-space:normal;overflow:hidden;display:-webkit-box;',
  '-webkit-box-orient:vertical;-webkit-line-clamp:2;text-overflow:ellipsis;word-break:break-word;line-height:1.25}',
  '.inbox-row-body .conv-card-time{flex:0 0 auto;white-space:nowrap;max-width:100%}',
  '.inbox-row-body .conv-card-meta-row{flex-wrap:nowrap;gap:6px;min-width:0;align-items:center}',
  '.inbox-row-body .conv-card-pebbles{flex:0 0 auto;min-width:0}',
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
  /* INBOX-CHANNEL-ICON-STATE-001: unread WA green / email Luna blue; read stays grey. */
  '.conv-card.inbox-row-unread:not(.inbox-row-needs-human) .inbox-channel-badge-whatsapp{color:#25D366}',
  '.conv-card.inbox-row-unread:not(.inbox-row-needs-human) .inbox-channel-badge-email{color:#3B7FB0}',
  '.conv-card.inbox-row-unread:not(.inbox-row-needs-human) .inbox-channel-badge svg{stroke:currentColor}',
  /* Compact / md density: shrink gutters so names+timestamps fit without clip */
  '#inbox-shell[data-col2="compact"] .conv-card.inbox-row{gap:6px;padding:8px 8px}',
  '#inbox-shell[data-col2="compact"] .inbox-row-avatar{width:28px;height:28px;font-size:10px}',
  '@media(max-width:1279px){',
  '#inbox-shell .conv-card.inbox-row{gap:8px;padding:8px 10px}',
  '#inbox-shell .inbox-row-avatar{width:28px;height:28px}',
  '#inbox-shell .inbox-left .inbox-conv-search-wrap{padding:8px 8px 6px}',
  '}',
  /* staff-portal-mobile:inbox-filter-scroll — chip row scroll without native scrollbar chrome */
  '@media(max-width:768px){',
  '#tab-conversations .inbox-filters,',
  '#tab-conversations .inbox-toolbar-channels{',
  'display:flex;flex-wrap:nowrap;align-items:center;gap:6px;',
  'overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;',
  'scrollbar-width:none;-ms-overflow-style:none;',
  'padding-bottom:2px;',
  '-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 18px),transparent);',
  'mask-image:linear-gradient(to right,#000 calc(100% - 18px),transparent);',
  '}',
  '#tab-conversations .inbox-filters::-webkit-scrollbar,',
  '#tab-conversations .inbox-toolbar-channels::-webkit-scrollbar{display:none}',
  '#tab-conversations .inbox-filter-btn{flex:0 0 auto;white-space:nowrap;min-height:44px;padding:8px 12px}',
  '.inbox-two-col.show-thread .detail-header{flex-wrap:wrap;align-items:flex-start;gap:8px;padding:12px 14px}',
  '.inbox-two-col.show-thread .detail-header-main{flex:1 1 100%;min-width:0;order:1}',
  '.inbox-two-col.show-thread .detail-header-pills{flex:1 1 100%;width:100%;margin-left:0!important;order:2;justify-content:flex-start;flex-wrap:wrap;gap:6px}',
  '.inbox-two-col.show-thread .detail-header-right{order:3;width:100%;justify-content:space-between;align-items:center;gap:8px}',
  '.inbox-two-col.show-thread .detail-header-main .detail-name,',
  '.inbox-two-col.show-thread .detail-header-main .detail-meta{white-space:normal;overflow:visible;text-overflow:unset;word-break:break-word}',
  '}',
  /* INBOX-GUESTVIEW-CUSTOMERS-ONLY-001: Guest list is a client directory. */
  'body:has([data-inbox-preset="guest"][aria-pressed="true"]) .conv-card-preview{display:none!important}',
  /* Sunset surf cards omit .conv-card-preview; hide recency time/subject instead. */
  'body:has([data-inbox-preset="guest"][aria-pressed="true"]) .conv-card-time{display:none!important}',
  'body:has([data-inbox-preset="guest"][aria-pressed="true"]) .conv-card-subject{display:none!important}',
  /* INBOX-GUEST-KEEP-CARD-002: never flash the empty skeleton in Guest. */
  'body:has([data-inbox-preset="guest"][aria-pressed="true"]) #detail-content.is-loading-detail .detail-sidebar,',
  'body:has([data-inbox-preset="guest"][aria-pressed="true"]) #detail-content.is-loading-detail .inbox-customer-card{pointer-events:none}',
  'body:has([data-inbox-preset="guest"][aria-pressed="true"]) .detail-header:has(#conv-detail-load-status),',
  'body:has([data-inbox-preset="guest"][aria-pressed="true"]) .sidebar-card-skeleton,',
  'body:has([data-inbox-preset="guest"][aria-pressed="true"]) .conv-detail-load-status{display:none!important}',
].join('');

var inboxRowsRuntime = { wired: false, guestView: undefined };
var inboxRowsGuestPriorViewId = '';
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

/**
 * INBOX-LIST-TIMESTAMP-001 — list row time = newest thread message, not
 * conversations.updated_at / last_activity (stale cache). Same source as
 * renderInboxThreadMessagesHtml (fmtTs(m.created_at)).
 */
var inboxRowsNewestMessageAtByConv = {};

function inboxRowsConsiderTimestamp(best, ts) {
  if (ts == null || ts === '') return best;
  var ms = Date.parse(ts);
  if (isNaN(ms)) return best;
  if (!best || ms > best.ms) {
    return {
      ms: ms,
      iso: typeof ts === 'string' ? ts : new Date(ms).toISOString(),
    };
  }
  return best;
}

function inboxRowsNewestMessageAt(row, messages) {
  var best = null;
  if (row) {
    best = inboxRowsConsiderTimestamp(best, row.last_message_at);
    best = inboxRowsConsiderTimestamp(best, row.last_message_created_at);
  }
  var msgs = messages;
  if (!msgs && row) msgs = row.messages || row.thread_messages;
  if (Array.isArray(msgs)) {
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i]) best = inboxRowsConsiderTimestamp(best, msgs[i].created_at);
    }
  }
  var convId = row && (row.conversation_id || row.id);
  if (convId && inboxRowsNewestMessageAtByConv[convId]) {
    best = inboxRowsConsiderTimestamp(best, inboxRowsNewestMessageAtByConv[convId]);
  }
  return best ? best.iso : '';
}

function inboxRowsFormatTime(ts) {
  if (typeof fmtTs === 'function') return fmtTs(ts);
  if (!ts) return '';
  try {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var diffMs = now - d;
    if (diffMs < 60000) return 'just now';
    if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm ago';
    if (diffMs < 86400000) return Math.floor(diffMs / 3600000) + 'h ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch (_e) {
    return String(ts);
  }
}

function inboxRowsTimeLabel(row, messages) {
  var at = inboxRowsNewestMessageAt(row, messages);
  if (at) return inboxRowsFormatTime(at);
  return (row && row.last_activity_label) || '';
}

function inboxRowsWithNewestMessageTime(row) {
  if (!row || typeof row !== 'object') return row;
  var at = inboxRowsNewestMessageAt(row);
  if (!at) return row;
  var label = inboxRowsFormatTime(at);
  if (row.last_message_at === at && row.last_activity_label === label) return row;
  var next = Object.assign({}, row);
  next.last_message_at = at;
  next.last_activity_label = label;
  return next;
}

function inboxRowsRewriteTime(html, row) {
  html = String(html || '');
  var label = inboxRowsTimeLabel(row);
  if (!label) return html;
  var escaped = inboxRowsEsc(label);
  if (/<div class="conv-card-time">/.test(html)) {
    return html.replace(
      /(<div class="conv-card-time">)([\s\S]*?)(<\/div>)/,
      '$1' + escaped + '$3'
    );
  }
  if (/<div class="conv-card-meta-row">/.test(html)) {
    return html.replace(
      /(<div class="conv-card-meta-row">)/,
      '$1<div class="conv-card-time">' + escaped + '</div>'
    );
  }
  return html;
}

function inboxRowsPaintCardTime(convId, label) {
  if (typeof document === 'undefined' || !convId || !label) return;
  var list = inboxRowsEl('conv-list');
  if (!list || !list.querySelectorAll) return;
  var want = String(convId);
  var cards = list.querySelectorAll('.conv-card[data-id]');
  for (var i = 0; i < cards.length; i++) {
    if (String(cards[i].getAttribute('data-id')) !== want) continue;
    var timeEl = cards[i].querySelector('.conv-card-time');
    if (timeEl) timeEl.textContent = label;
  }
}

function inboxRowsFindCard(convId) {
  if (typeof document === 'undefined' || !convId) return null;
  var list = inboxRowsEl('conv-list');
  if (!list || !list.querySelectorAll) return null;
  var want = String(convId);
  var cards = list.querySelectorAll('.conv-card[data-id]');
  for (var i = 0; i < cards.length; i++) {
    if (String(cards[i].getAttribute('data-id')) === want) return cards[i];
  }
  return null;
}

/** Opening a thread marks it read — patch cache so a later list rebuild does not restore unread color. */
function inboxRowsMarkCacheRead(convId) {
  var id = convId ? String(convId) : '';
  if (!id) return;
  try {
    var cache = (typeof inboxConversationsCache !== 'undefined') ? inboxConversationsCache : null;
    if (!Array.isArray(cache)) return;
    var now = new Date().toISOString();
    for (var i = 0; i < cache.length; i++) {
      if (!cache[i]) continue;
      if (String(cache[i].conversation_id || cache[i].id || '') !== id) continue;
      cache[i].unread = false;
      cache[i].is_unread = false;
      cache[i].unread_count = 0;
      cache[i].last_read_at = now;
    }
  } catch (_e) {}
}

/**
 * INBOX-CHANNEL-ICON-STATE-001 — turn the prior row's channel icon grey
 * without replacing the whole list (no full page refresh).
 */
function inboxRowsPaintCardRead(convId) {
  inboxRowsMarkCacheRead(convId);
  var card = inboxRowsFindCard(convId);
  if (!card || !card.classList) return;
  card.classList.remove('inbox-row-unread');
  var dot = card.querySelector ? card.querySelector('.inbox-row-unread-dot') : null;
  if (dot && dot.parentNode) dot.parentNode.removeChild(dot);
}

/** needs_human flips the pebble orange in place (same class the wrap already paints). */
function inboxRowsPaintCardNeedsHuman(convId, needsHuman) {
  var card = inboxRowsFindCard(convId);
  if (!card || !card.classList) return;
  if (needsHuman) card.classList.add('inbox-row-needs-human');
  else card.classList.remove('inbox-row-needs-human');
}

function inboxRowsRememberThreadMessages(convId, msgs) {
  var id = convId ? String(convId) : '';
  if (!id && Array.isArray(msgs)) {
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i] && msgs[i].conversation_id) {
        id = String(msgs[i].conversation_id);
        break;
      }
    }
  }
  var at = inboxRowsNewestMessageAt({ conversation_id: id, messages: msgs }, msgs);
  if (!id || !at) return at || '';
  inboxRowsNewestMessageAtByConv[id] = at;
  var label = inboxRowsFormatTime(at);
  try {
    var cache = (typeof inboxConversationsCache !== 'undefined') ? inboxConversationsCache : null;
    if (Array.isArray(cache)) {
      for (var j = 0; j < cache.length; j++) {
        if (cache[j] && String(cache[j].conversation_id) === id) {
          cache[j].last_message_at = at;
          cache[j].last_activity_label = label;
        }
      }
    }
  } catch (_e) {}
  inboxRowsPaintCardTime(id, label);
  return at;
}

function inboxRowsPassThroughLastMessage(mapped, row) {
  if (!mapped || !row) return mapped;
  if (row.last_message_at != null) mapped.last_message_at = row.last_message_at;
  if (mapped.last_message_at == null && row.last_message_created_at != null) {
    mapped.last_message_at = row.last_message_created_at;
  }
  if (Array.isArray(row.messages)) mapped.messages = row.messages;
  return mapped;
}

function inboxRowsWrapConvCardHtml(html, row) {
  row = inboxRowsWithNewestMessageTime(row);
  html = inboxRowsRewriteNeedsHumanChip(String(html || ''), row);
  html = inboxRowsRewriteTime(html, row);
  html = inboxRowsStripGuestPreviewHtml(html);
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
  // People rows without a conversation_id still need a stable card id for selection.
  if (key && !(row && row.conversation_id)) {
    newOpen = newOpen.replace(/data-id=""/, 'data-id="' + inboxRowsEsc(key) + '"');
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

/** One list empty state + select-a-thread detail prompt (Bug Finder #18). */
function inboxRowsFixEmptyChrome(convs, opts) {
  if (convs && convs.length > 0) return;
  opts = opts || {};
  var preserveDetail = !!(opts.preserveDetail && (opts.selectedId ||
    (typeof selectedConvId !== 'undefined' && selectedConvId)));
  var stateEl = inboxRowsEl('inbox-state');
  if (stateEl) {
    stateEl.style.display = 'none';
    stateEl.classList.remove('error');
  }
  var list = inboxRowsEl('conv-list');
  if (list && typeof inboxEmptyListMessage === 'function') {
    var emptyMsg = inboxEmptyListMessage();
    list.innerHTML = '<div class="conv-list-empty">' + inboxRowsEsc(emptyMsg) + '</div>';
  }
  if (!preserveDetail) {
    var detail = inboxRowsEl('detail-content');
    if (detail && typeof inboxEmptyDetailHtml === 'function') {
      detail.innerHTML = inboxEmptyDetailHtml();
    }
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

/**
 * INBOX-GUESTVIEW-CUSTOMERS-ONLY-001 — Guest preset list = dedicated clients
 * A–Z by name, no last-message preview. Hide thread-only rows (emailv1:/email:
 * transport keys, or no customer identity). Full + All / WhatsApp / Email stay
 * last-messaged conversation lists.
 *
 * Leftover of #804: live QA still saw all_people / BOOKED_THEN_RECENT order
 * (ordering inversions; first client at position 4). Latch guestView on preset
 * change, pin the customers directory when entering Guest, and sort by the
 * visible name fields rather than collapsing to inboxPersonDisplayName('Guest').
 */
function inboxRowsGuestViewActive() {
  if (inboxRowsRuntime.guestView === true) return true;
  if (inboxRowsRuntime.guestView === false) return false;
  try {
    if (typeof inboxColumnsRuntime !== 'undefined'
        && inboxColumnsRuntime
        && inboxColumnsRuntime.record
        && inboxColumnsRuntime.record.preset === 'guest') {
      return true;
    }
  } catch (_e) {}
  if (typeof document === 'undefined' || !document.querySelector) return false;
  var btn = document.querySelector('[data-inbox-preset="guest"][aria-pressed="true"]');
  return !!(btn);
}

function inboxRowsSyncGuestViewFromColumns() {
  try {
    if (typeof inboxColumnsRuntime !== 'undefined'
        && inboxColumnsRuntime
        && inboxColumnsRuntime.record
        && inboxColumnsRuntime.record.preset) {
      inboxRowsRuntime.guestView = inboxColumnsRuntime.record.preset === 'guest';
      return inboxRowsRuntime.guestView === true;
    }
  } catch (_e) {}
  if (typeof document !== 'undefined' && document.querySelector) {
    if (document.querySelector('[data-inbox-preset="guest"][aria-pressed="true"]')) {
      inboxRowsRuntime.guestView = true;
      return true;
    }
    if (document.querySelector('[data-inbox-preset]')) {
      inboxRowsRuntime.guestView = false;
      return false;
    }
  }
  /* No columns/DOM signal yet — leave an explicit latch alone. */
  return inboxRowsRuntime.guestView === true;
}

function inboxRowsTransportKey(value) {
  var raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  if (/^emailv1:/i.test(raw) || /^email:/i.test(raw)) return raw;
  return '';
}

function inboxRowsIsDedicatedClient(row) {
  if (!row || typeof row !== 'object') return false;
  var source = String(row._inbox_view_source || row.source || '');
  if (source === 'customers') return true;
  var key = String(row._inbox_view_key || row.key || '');
  if (/^customers:/i.test(key)) return true;
  if (row.customer_id || row.customer_phone || row.guest_id
      || row.bound_guest_id || row.matched_guest_id) {
    return true;
  }
  var phone = String(row.phone || '').trim();
  if (inboxRowsTransportKey(phone)) return false;
  if (/^emailcust1:/i.test(phone)) return true;
  var digits = phone.replace(/\D/g, '');
  if (digits.length >= 8) return true;
  var email = String(row.guest_email || row.email || '').trim();
  if (inboxRowsTransportKey(email)) return false;
  if (/^emailcust1:/i.test(email)) return true;
  var convId = String(row.conversation_id || '').trim();
  if (inboxRowsTransportKey(convId)) return false;
  return false;
}

function inboxRowsGuestSortName(row) {
  var name = '';
  if (row) {
    name = String(row.guest_name || row.display_name || '').trim();
  }
  if (!name && typeof inboxPersonDisplayName === 'function') {
    try { name = String(inboxPersonDisplayName(row) || '').trim(); } catch (_e2) { name = ''; }
  }
  if (name && /^guest$/i.test(name)) name = '';
  return name;
}

function inboxRowsGuestViewList(convs) {
  var src = Array.isArray(convs) ? convs : [];
  var list = [];
  for (var i = 0; i < src.length; i++) {
    if (!inboxRowsIsDedicatedClient(src[i])) continue;
    var next = Object.assign({}, src[i]);
    next.last_message_preview = '';
    next.last_activity_label = '';
    next.last_activity = null;
    list.push(next);
  }
  list.sort(function(a, b) {
    var an = inboxRowsGuestSortName(a);
    var bn = inboxRowsGuestSortName(b);
    if (!an && bn) return 1;
    if (an && !bn) return -1;
    var cmp = an.toLocaleLowerCase().localeCompare(bn.toLocaleLowerCase());
    if (cmp) return cmp;
    var ak = String((a && (a._inbox_view_key || a.conversation_id || a.phone)) || '');
    var bk = String((b && (b._inbox_view_key || b.conversation_id || b.phone)) || '');
    return ak.localeCompare(bk);
  });
  return list;
}

function inboxRowsStripGuestPreviewHtml(html) {
  html = String(html || '');
  if (!inboxRowsGuestViewActive()) return html;
  html = html.replace(/<div class="conv-card-preview">[\s\S]*?<\/div>/g, '');
  html = html.replace(/<div class="conv-card-time">[\s\S]*?<\/div>/g, '');
  html = html.replace(/<div class="conv-card-subject">[\s\S]*?<\/div>/g, '');
  return html;
}

function inboxRowsRerenderGuestViewList() {
  if (typeof applyInboxFilter === 'function') {
    applyInboxFilter(inboxRowsPreserveSelectionOpts({ silent: true }));
    return;
  }
  if (typeof renderInbox !== 'function') return;
  var list = [];
  try {
    list = (typeof inboxConversationsCache !== 'undefined' && inboxConversationsCache) || [];
  } catch (_e) { list = []; }
  if (typeof filterInboxConversations === 'function') list = filterInboxConversations(list);
  renderInbox(list, inboxRowsPreserveSelectionOpts({}));
}

function inboxRowsGuestOnCustomersSource() {
  if (inboxRowsActiveView && inboxRowsActiveView.source === 'customers') return true;
  try {
    if (typeof inboxSavedViewId === 'string' && inboxSavedViewId === 'all_people') return true;
  } catch (_e) {}
  return false;
}

function inboxRowsEnterGuestDirectory() {
  if (inboxRowsGuestOnCustomersSource()) {
    inboxRowsRerenderGuestViewList();
    return;
  }
  if (typeof selectInboxSavedView === 'function') {
    try {
      inboxRowsGuestPriorViewId = (typeof inboxSavedViewId === 'string' && inboxSavedViewId)
        ? inboxSavedViewId
        : 'all';
    } catch (_e2) {
      inboxRowsGuestPriorViewId = 'all';
    }
    selectInboxSavedView('all_people');
    return;
  }
  inboxRowsRerenderGuestViewList();
}

function inboxRowsLeaveGuestDirectory() {
  var restore = inboxRowsGuestPriorViewId;
  inboxRowsGuestPriorViewId = '';
  if (restore && typeof selectInboxSavedView === 'function') {
    var current = '';
    try { current = typeof inboxSavedViewId === 'string' ? inboxSavedViewId : ''; } catch (_e) {}
    if (!current || current === 'all_people') {
      selectInboxSavedView(restore);
      return;
    }
  }
  inboxRowsRerenderGuestViewList();
}

function inboxRowsOnGuestPresetChange(name) {
  var wasGuest = inboxRowsGuestViewActive();
  var nowGuest = name === 'guest';
  inboxRowsRuntime.guestView = nowGuest;
  if (nowGuest && !wasGuest) {
    inboxRowsEnterGuestDirectory();
    return;
  }
  if (!nowGuest && wasGuest) {
    inboxRowsLeaveGuestDirectory();
    return;
  }
  inboxRowsRerenderGuestViewList();
}

function inboxRowsWrapGuestViewPreset() {
  if (typeof inboxColumnsSetPreset === 'function' && !inboxColumnsSetPreset._inboxGuestViewWrapped) {
    var _inboxRowsLegacySetPreset = inboxColumnsSetPreset;
    inboxColumnsSetPreset = function(name) {
      /* Capture before legacy write — record.preset flips inside setPreset. */
      var wasGuest = inboxRowsGuestViewActive();
      var result = _inboxRowsLegacySetPreset(name);
      var nowGuest = name === 'guest';
      inboxRowsRuntime.guestView = nowGuest;
      if (nowGuest && !wasGuest) inboxRowsEnterGuestDirectory();
      else if (!nowGuest && wasGuest) inboxRowsLeaveGuestDirectory();
      else inboxRowsRerenderGuestViewList();
      return result;
    };
    inboxColumnsSetPreset._inboxGuestViewWrapped = true;
    try {
      if (typeof window !== 'undefined' && window.__inboxColumns) {
        window.__inboxColumns.setPreset = inboxColumnsSetPreset;
      }
    } catch (_e2) {}
  }
  if (typeof initInboxColumns === 'function' && !initInboxColumns._inboxGuestViewWrapped) {
    var _inboxRowsLegacyInitColumns = initInboxColumns;
    initInboxColumns = function() {
      var result = _inboxRowsLegacyInitColumns.apply(this, arguments);
      inboxRowsSyncGuestViewFromColumns();
      return result;
    };
    initInboxColumns._inboxGuestViewWrapped = true;
    try {
      if (typeof window !== 'undefined' && window.__inboxColumns) {
        window.__inboxColumns.init = initInboxColumns;
      }
    } catch (_e3) {}
  }
  inboxRowsSyncGuestViewFromColumns();
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
      opts = inboxRowsPreserveSelectionOpts(opts);
      if (inboxRowsGuestViewActive()) convs = inboxRowsGuestViewList(convs);
      var result = _inboxRowsLegacyRenderInbox(convs, opts);
      inboxRowsFixEmptyChrome(convs, opts);
      inboxRowsAfterRender();
      return result;
    };
    renderInbox._inboxRowsWrapped = true;
  }
  if (typeof mapInboxPersonRowToConv === 'function' && !mapInboxPersonRowToConv._inboxRowsWrapped) {
    var _inboxRowsLegacyMapPerson = mapInboxPersonRowToConv;
    mapInboxPersonRowToConv = function(row) {
      var mapped = inboxRowsPassThroughUnread(_inboxRowsLegacyMapPerson(row), row);
      mapped = inboxRowsPassThroughLastMessage(mapped, row);
      return inboxRowsWithNewestMessageTime(mapped);
    };
    mapInboxPersonRowToConv._inboxRowsWrapped = true;
  }
  if (typeof renderInboxThreadMessagesHtml === 'function' && !renderInboxThreadMessagesHtml._inboxRowsTimeWrapped) {
    var _inboxRowsLegacyThreadHtml = renderInboxThreadMessagesHtml;
    renderInboxThreadMessagesHtml = function(msgs) {
      var convId = (typeof selectedConvId !== 'undefined' && selectedConvId) ? selectedConvId : '';
      inboxRowsRememberThreadMessages(convId, msgs);
      return _inboxRowsLegacyThreadHtml(msgs);
    };
    renderInboxThreadMessagesHtml._inboxRowsTimeWrapped = true;
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

/* INBOX-GUEST-KEEP-CARD-002 — Guest view must never paint the thread skeleton
 * (grey panel + stray "Loading…"). Keep whatever is already in the right
 * pane — existing guest card, or empty — until loadConvDetail paints. Do not
 * require .inbox-customer-card; first click and slow fetches still showed
 * the skeleton under 001. Full / Chat still use the thread skeleton.
 * Stay off inbox-thread.js. */
function inboxRowsIsGuestPresetOn() {
  if (typeof inboxRowsGuestViewActive === 'function' && inboxRowsGuestViewActive()) return true;
  if (typeof inboxContextIsGuestMode === 'function' && inboxContextIsGuestMode()) return true;
  try {
    if (typeof document === 'undefined' || !document.querySelector) return false;
    if (document.querySelector('[data-inbox-preset="guest"][aria-pressed="true"]')) return true;
    var shell = document.getElementById('inbox-shell');
    if (shell && shell.getAttribute('data-col4') === 'wide') return true;
  } catch (_e) {}
  return false;
}

function inboxRowsShouldKeepGuestCard(targetEl) {
  return inboxRowsIsGuestPresetOn();
}

function inboxRowsWrapGuestKeepCard() {
  if (typeof beginConvDetailLoad !== 'function' || beginConvDetailLoad._inboxRowsGuestKeepCardWrapped) return;
  var _inboxRowsLegacyBeginConvDetailLoad = beginConvDetailLoad;
  beginConvDetailLoad = function(targetEl) {
    if (inboxRowsShouldKeepGuestCard(targetEl)) {
      if (typeof inboxParkRefreshBtn === 'function') inboxParkRefreshBtn();
      if (targetEl && targetEl.classList && targetEl.classList.add) {
        targetEl.classList.add('is-loading-detail');
      }
      return;
    }
    return _inboxRowsLegacyBeginConvDetailLoad.apply(this, arguments);
  };
  beginConvDetailLoad._inboxRowsGuestKeepCardWrapped = true;
}

function inboxRowsWrapIconState() {
  if (typeof loadConvDetail === 'function' && !loadConvDetail._inboxRowsIconStateWrapped) {
    var _inboxRowsLegacyLoadConvDetail = loadConvDetail;
    loadConvDetail = function(convId, targetEl) {
      inboxRowsWrapGuestKeepCard();
      var prev = (typeof selectedConvId !== 'undefined') ? selectedConvId : '';
      var result = _inboxRowsLegacyLoadConvDetail(convId, targetEl);
      if (prev && String(prev) !== String(convId || '')) {
        inboxRowsPaintCardRead(prev);
      }
      return result;
    };
    loadConvDetail._inboxRowsIconStateWrapped = true;
  }
  if (typeof updateInboxConvCardNeedsHuman === 'function' && !updateInboxConvCardNeedsHuman._inboxRowsIconStateWrapped) {
    var _inboxRowsLegacyNeedsHumanCard = updateInboxConvCardNeedsHuman;
    updateInboxConvCardNeedsHuman = function(convId, needsHuman) {
      var result = _inboxRowsLegacyNeedsHumanCard(convId, needsHuman);
      inboxRowsPaintCardNeedsHuman(convId, needsHuman === true);
      return result;
    };
    updateInboxConvCardNeedsHuman._inboxRowsIconStateWrapped = true;
  }
}

function inboxRowsInstall() {
  if (inboxRowsRuntime.wired) return true;
  inboxRowsEnsureStyles();
  inboxRowsWrapRenderers();
  inboxRowsWrapViews();
  inboxRowsWrapFilterReselect();
  inboxRowsWrapIconState();
  inboxRowsWrapGuestKeepCard();
  inboxRowsWrapGuestViewPreset();
  inboxRowsHideLegacyFilterChips();
  inboxRowsAfterRender();
  inboxRowsWrapGuestKeepCard();
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
    rewriteTime: inboxRowsRewriteTime,
    timeLabel: inboxRowsTimeLabel,
    newestMessageAt: inboxRowsNewestMessageAt,
    rememberThreadMessages: inboxRowsRememberThreadMessages,
    withNewestMessageTime: inboxRowsWithNewestMessageTime,
    formatTime: inboxRowsFormatTime,
    needsHumanLabel: inboxRowsNeedsHumanLabel,
    hideLegacyFilterChips: inboxRowsHideLegacyFilterChips,
    fixEmptyChrome: inboxRowsFixEmptyChrome,
    openBroadcast: inboxRowsOpenBroadcast,
    preserveSelectionOpts: inboxRowsPreserveSelectionOpts,
    wrapFilterReselect: inboxRowsWrapFilterReselect,
    wrapIconState: inboxRowsWrapIconState,
    wrapGuestKeepCard: inboxRowsWrapGuestKeepCard,
    shouldKeepGuestCard: inboxRowsShouldKeepGuestCard,
    isGuestPresetOn: inboxRowsIsGuestPresetOn,
    wrapGuestViewPreset: inboxRowsWrapGuestViewPreset,
    guestViewActive: inboxRowsGuestViewActive,
    isDedicatedClient: inboxRowsIsDedicatedClient,
    guestViewList: inboxRowsGuestViewList,
    guestSortName: inboxRowsGuestSortName,
    stripGuestPreviewHtml: inboxRowsStripGuestPreviewHtml,
    syncGuestViewFromColumns: inboxRowsSyncGuestViewFromColumns,
    onGuestPresetChange: inboxRowsOnGuestPresetChange,
    enterGuestDirectory: inboxRowsEnterGuestDirectory,
    leaveGuestDirectory: inboxRowsLeaveGuestDirectory,
    paintCardRead: inboxRowsPaintCardRead,
    paintCardNeedsHuman: inboxRowsPaintCardNeedsHuman,
    markCacheRead: inboxRowsMarkCacheRead,
    findCard: inboxRowsFindCard,
    install: inboxRowsInstall,
    CSS: INBOX_ROWS_CSS,
    runtime: inboxRowsRuntime,
  };
}

inboxRowsInstall();
