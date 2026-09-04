/**
 * Staff Portal Inbox — column 4 guest card (mockup slice B).
 *
 * Replaces the bulky BOOKINGS rail inside #inbox-detail-sidebar after
 * loadConvDetail paints it. Injected after inbox-views (same concatenation
 * pattern as inbox-whatsapp-draft.js ahead of inbox-thread) so it can wrap
 * wireInboxSidebarToggle without editing inbox-thread.js.
 *
 * Canonical density: docs/INBOX-PORTAL-REDESIGN.md "Density rules for the
 * context panel". Facts come from GET /staff/inbox/thread/:id only; missing
 * fields are omitted. No prices, balances, lessons, waivers or broadcasts are
 * invented. The panel is read-only for bookings — rows deep-link to the
 * existing Bookings tab.
 */

var INBOX_CONTEXT_STORAGE_PREFIX = 'wh_staff_inbox_context_v1';
var INBOX_CONTEXT_STYLE_ID = 'inbox-context-styles';
var INBOX_CONTEXT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var INBOX_CONTEXT_CHECKED_IN = { checked_in: true, in_house: true, staying: true };
var INBOX_CONTEXT_UNPAID = {
  unpaid: true,
  partial: true,
  partially_paid: true,
  payment_pending: true,
  pending: true,
  failed: true,
};

var INBOX_CONTEXT_CSS = [
  '.inbox-two-col.inbox-shell-cols #inbox-detail-sidebar > .inbox-guest-card{',
  'overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;',
  'max-height:none;min-height:0;flex:1 1 auto;height:100%;margin:0;',
  'box-sizing:border-box;padding:12px 14px;background:var(--surface);',
  'border:1px solid var(--border-soft);border-radius:var(--radius-sm);',
  'display:flex;flex-direction:column;gap:12px;',
  '}',
  '.inbox-guest-card .inbox-guest-collections,',
  '.inbox-guest-card .inbox-guest-stay,',
  '.inbox-guest-card .customers-collapsible-body,',
  '.inbox-guest-card .inbox-guest-booking-body{overflow:visible;max-height:none}',
  '.inbox-guest-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}',
  '.inbox-guest-name{font-size:15px;font-weight:700;color:var(--text);line-height:1.25}',
  '.inbox-guest-tags{font-size:12px;color:var(--text-2);margin-top:2px}',
  '.inbox-guest-stay{display:flex;flex-direction:column;gap:2px;font-size:13px;color:var(--text);line-height:1.4}',
  '.inbox-guest-stay-fact{color:var(--text-1)}',
  '.inbox-guest-section.is-zero{opacity:.45}',
  '.inbox-guest-booking{border-top:1px solid var(--border-soft);padding:6px 0}',
  '.inbox-guest-booking:first-child{border-top:none;padding-top:0}',
  '.inbox-guest-booking-summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;font-size:12px}',
  '.inbox-guest-booking-summary::-webkit-details-marker{display:none}',
  '.inbox-guest-booking-summary::before{content:"\\25B8";font-size:10px;color:var(--text-3);flex-shrink:0}',
  '.inbox-guest-booking[open] > .inbox-guest-booking-summary::before{transform:rotate(90deg)}',
  '.inbox-guest-booking-dates{flex:1 1 auto;min-width:0}',
  '.inbox-guest-booking-amount,.inbox-guest-booking-pay{flex:0 0 auto;color:var(--text-2)}',
  '.inbox-guest-booking-body{margin-top:8px}',
  '.inbox-guest-actions{display:flex;flex-direction:column;align-items:flex-end;gap:8px;margin-top:auto;padding-top:8px;width:100%}',
  '.inbox-guest-actions .btn{padding:0;border:none;background:none;color:var(--primary);font-size:12px;font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:2px}',
  '.inbox-guest-actions .btn.inbox-guest-create-booking{',
  'padding:8px 16px;border:none;background:#2F4A3E;color:#F3EBDD;',
  'border-radius:999px;text-decoration:none;font-weight:700;font-size:13px;',
  '}',
  '.inbox-two-col.inbox-shell-cols #inbox-detail-sidebar > .inbox-client-info{',
  'flex:0 0 auto;height:auto;max-height:none;margin:0 0 10px;padding:12px;',
  'background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius-sm);',
  'box-sizing:border-box;overflow:visible;',
  '}',
  '.inbox-client-info-head{display:flex;align-items:center;gap:10px;min-width:0}',
  '.inbox-client-info-avatar{flex:0 0 auto;width:32px;height:32px;border-radius:8px;',
  'background:var(--surface-soft);border:1px solid var(--border-soft);display:flex;',
  'align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--text-2);letter-spacing:.02em}',
  '.inbox-client-info-id{min-width:0;flex:1 1 auto}',
  '.inbox-client-info-name{font-size:14px;font-weight:700;color:var(--text);line-height:1.25;',
  'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.inbox-client-info-contact{font-size:11.5px;color:var(--text-2);margin-top:2px;line-height:1.35;',
  'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.inbox-client-info-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}',
  '.inbox-client-info-kv{margin-top:8px;display:flex;flex-direction:column;gap:4px}',
  '.inbox-client-info-kv .kv{flex-direction:row;align-items:baseline;justify-content:space-between;gap:8px}',
  '.inbox-client-info-kv .k{font-size:10px}',
  '.inbox-client-info-kv .v{font-size:12px;text-align:right}',
  '.inbox-client-info-open{display:inline-block;margin-top:8px;font-size:12px;font-weight:600;',
  'color:var(--primary);background:none;border:none;padding:0;cursor:pointer;text-decoration:underline;',
  'text-underline-offset:2px}',
  '.inbox-two-col.inbox-shell-cols #inbox-detail-sidebar > .inbox-customer-card{',
  'overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;',
  'max-height:none;min-height:0;flex:1 1 auto;height:100%;margin:0;',
  'box-sizing:border-box;padding:12px 14px;background:var(--surface);',
  'border:1px solid var(--border-soft);border-radius:var(--radius-sm);',
  'display:flex;flex-direction:column;gap:10px;',
  '}',
  '.inbox-customer-card.is-full{padding:16px 18px;gap:14px}',
  '.inbox-customer-card .customers-profile-summary{margin-bottom:0;padding-bottom:12px}',
  '.inbox-customer-card .customers-profile-hdr-actions{margin-left:auto;display:flex;flex-wrap:wrap;gap:6px}',
  '.inbox-customer-card .customers-section{margin-top:4px}',
  '.inbox-customer-card .customers-section-hdr{font-size:11px}',
  '.inbox-customer-head{display:flex;align-items:flex-start;gap:10px;min-width:0}',
  '.inbox-customer-hide{display:none;margin-left:auto;flex:0 0 auto;align-items:center;justify-content:center;',
  'min-width:28px;min-height:28px;padding:0;border:1px solid var(--border-soft);border-radius:8px;',
  'background:var(--surface-soft);color:var(--text-2);cursor:pointer;font-size:15px;line-height:1}',
  'body:has([data-inbox-preset="all4"][aria-pressed="true"]) .inbox-customer-card:not(.is-full) .inbox-customer-hide{display:inline-flex}',
  '.inbox-customer-hide-pin{display:none;align-items:center;justify-content:center}',
  '.inbox-customer-hide-pin svg{display:block;transform:rotate(45deg)}',
  '#inbox-shell[data-peek="col4"] .inbox-customer-hide-arrow{display:none}',
  '#inbox-shell[data-peek="col4"] .inbox-customer-hide-pin{display:inline-flex}',
  '#inbox-shell.inbox-guest-drawer .inbox-customer-hide-arrow{display:none}',
  '#inbox-shell.inbox-guest-drawer .inbox-customer-hide-pin{display:inline-flex}',
  '.inbox-customer-hide:hover{color:var(--text);background:var(--surface)}',
  '.inbox-customer-edit{margin-left:auto;flex:0 0 auto;padding:0;border:none;background:none;',
  'color:var(--primary);font-size:12px;font-weight:600;cursor:pointer;text-decoration:underline;',
  'text-underline-offset:2px;white-space:nowrap}',
  '.inbox-customer-card .customers-profile-fields{display:flex;flex-direction:column;gap:8px}',
  '.inbox-customer-card .customers-profile-field-value,.inbox-guest-inline-display{min-width:0;overflow-wrap:anywhere;word-break:break-word}',
  '.inbox-customer-card .customers-profile-field-label{min-width:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word}',
  '.inbox-customer-card .inbox-client-info-name,.inbox-customer-card .customers-profile-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.inbox-customer-card .customers-profile-field{display:grid;grid-template-columns:minmax(4.5em,7.6em) minmax(0,1fr);gap:6px 10px;align-items:start}',
  '.inbox-customer-card:not(.is-full) .inbox-guest-inline:has(.inbox-guest-inline-edit:not([hidden])){',
  'grid-template-columns:max-content minmax(0,1fr)}',
  '.inbox-guest-inline-display[hidden]{display:none!important}',
  '.inbox-customer-head .inbox-client-info-id{display:flex;flex-direction:column;gap:6px;min-width:0}',
  '.inbox-customer-card:not(.is-full) .inbox-guest-tags{margin:10px 0 8px}',
  '.inbox-customer-card.is-full .inbox-guest-tags{margin:10px 0 8px}',
  '.inbox-customer-stats{margin-top:8px}',
  '.inbox-customer-bookings{margin-top:10px;display:flex;flex-direction:column;gap:4px}',
  '.inbox-customer-booking-link{display:block;width:100%;text-align:left;padding:6px 0;border:none;',
  'border-top:1px solid var(--border-soft);background:none;color:var(--primary);font-size:12px;',
  'font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:2px}',
  '.inbox-customer-booking-link:first-child{border-top:none}',
  '.inbox-customer-booking-meta{display:block;font-size:11px;font-weight:500;color:var(--text-3);',
  'text-decoration:none;margin-top:1px}',
  '.inbox-customer-card > .inbox-guest-actions{margin-top:auto}',
  '#tab-conversations .inbox-chat-chrome{display:flex;align-items:center;justify-content:flex-end;',
  'gap:6px;flex:0 0 auto;min-height:32px;padding:0 2px}',
  '#tab-conversations .inbox-chat-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;',
  'overflow:hidden;background:var(--surface);border:1px solid var(--border-soft);',
  'border-radius:var(--radius);}',
  '#inbox-shell .inbox-left .inbox-conv-search-wrap{flex:0 0 auto;padding:10px 12px 8px;',
  'border-bottom:1px solid var(--border-soft);background:var(--surface)}',
  '#inbox-shell .inbox-conv-search{width:100%;box-sizing:border-box;height:32px;padding:0 10px;',
  'border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);',
  'font-size:13px}',
  '.inbox-customer-card.is-editing .customers-profile-edit-form{display:flex;flex-direction:column;gap:10px;margin-top:8px}',
  '.inbox-customer-card.is-editing .customers-edit-field{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--text-2)}',
  '.inbox-customer-card.is-editing .customers-edit-field input,.inbox-customer-card.is-editing .customers-edit-field textarea{font:inherit;font-weight:500;color:var(--text);padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);width:100%;box-sizing:border-box}',
  '.inbox-customer-edit-actions{display:flex;gap:8px;margin-top:12px}',
  '.inbox-guest-linked-bookings .customers-row-table{width:100%;table-layout:fixed}',
  '.inbox-guest-booking-row{cursor:pointer}',
  '.inbox-guest-booking-row:hover{background:var(--surface-soft)}',
  '.inbox-customer-card.is-full .customers-profile-name{font-size:18px}',
  '.inbox-customer-card.is-full .customers-profile-avatar{font-size:16px}',
  '.inbox-customer-card.is-full .customers-profile-identity{display:flex;flex-direction:column;gap:6px;min-width:0}',
  '.inbox-customer-card.is-full .customers-profile-fields{display:flex;flex-direction:column;gap:8px;margin-top:10px}',
  '.inbox-customer-card.is-full .customers-profile-field{display:grid;grid-template-columns:minmax(4.5em,7.6em) minmax(0,1fr);gap:6px 10px;align-items:start;font-size:14px}',
  '.inbox-customer-card.is-full .customers-profile-field-label{font-size:12px;line-height:1.25;padding-top:2px}',
  '.inbox-customer-card.is-full .customers-profile-field-value{font-size:14px}',
  '.inbox-customer-card.is-full .customers-section-hdr{font-size:13px}',
  '.inbox-customer-card.is-full .customers-section-empty,.inbox-customer-card.is-full .customers-section-body{font-size:14px}',
  '.inbox-customer-card.is-full .customers-badge{font-size:12px}',
  '.inbox-guest-inline-title{display:inline;width:auto;max-width:7.6em;text-align:left;border:none;background:none;',
  'padding:0;margin:0;cursor:pointer;text-decoration:none;white-space:normal;overflow-wrap:anywhere}',
  '.inbox-guest-inline-edit{grid-column:2;display:flex;flex-direction:row;align-items:center;gap:8px;min-width:0}',
  '.inbox-guest-inline-edit[hidden]{display:none!important}',
  '.inbox-guest-inline-edit input,.inbox-guest-inline-edit textarea{flex:1 1 auto;min-width:0;min-height:36px;height:38px;',
  'box-sizing:border-box;font:inherit;font-size:14px;padding:6px 10px;border:1px solid var(--border);border-radius:8px}',
  '.inbox-guest-inline-save{flex:0 0 auto;padding:9px 16px;font-size:12px;font-weight:600}',
  '.inbox-guest-notes-title{max-width:7.6em}',
  '.inbox-guest-notes-display.is-empty,.inbox-guest-inline-display.is-empty{color:var(--text-3)}',
  '.inbox-guest-tags-label{font-size:11px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3);margin:0 8px 0 0}',
  '.inbox-guest-tags-add{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;',
  'border:1px solid var(--border);border-radius:6px;font-size:16px;line-height:1;color:var(--text-2);background:var(--surface)}',
  '.inbox-guest-tags-open{display:flex;flex-wrap:wrap;gap:4px;align-items:center;border:none;background:none;',
  'padding:0;margin:0;cursor:pointer;text-align:left}',
  '.inbox-guest-tags-edit{display:flex;flex-direction:column;gap:10px;margin-top:6px}',
  '.inbox-guest-tags-edit[hidden]{display:none!important}',
  '.inbox-guest-tags-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
  '.inbox-guest-tags-toggle{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;',
  'border:1px solid var(--border);border-radius:999px;font-size:12px;cursor:pointer;background:var(--surface);position:relative}',
  '.inbox-guest-tags-toggle input{position:absolute;opacity:0;width:1px;height:1px}',
  '.inbox-guest-tags-toggle.is-on{border-color:var(--primary);background:var(--surface-soft)}',
  '.inbox-guest-tags-toggle.is-auto{cursor:default;opacity:.75}',
  '.inbox-guest-tags-save{align-self:flex-start;padding:9px 16px;font-size:12px;font-weight:600}',
  '.inbox-customer-card.is-editing{max-width:100%;width:100%;box-sizing:border-box}',
  '.inbox-guest-link{margin-top:12px;display:flex;flex-direction:column;gap:8px}',
  '.inbox-guest-link-search{width:100%;box-sizing:border-box;height:34px;padding:0 10px;',
  'border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-size:13px}',
  '.inbox-guest-link-results{display:flex;flex-direction:column;gap:4px;max-height:180px;overflow:auto}',
  '.inbox-guest-link-hit{display:block;width:100%;text-align:left;padding:8px 10px;border:1px solid var(--border-soft);',
  'border-radius:8px;background:var(--surface);color:var(--text);cursor:pointer;font-size:13px}',
  '.inbox-guest-link-hit:hover{border-color:var(--primary);background:var(--surface-soft)}',
  '.inbox-guest-link-hit-name{font-weight:600;display:block}',
  '.inbox-guest-link-hit-meta{font-size:12px;color:var(--text-3);display:block;margin-top:2px}',
  '.inbox-guest-link-empty,.inbox-guest-link-msg{font-size:12px;color:var(--text-3)}',
  '.inbox-guest-link-msg.is-error{color:var(--danger, #b42318)}',
  '.inbox-guest-link-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
  /* ~1024px / peek / drawer: stack TELÉFONO·EMAIL·ESCUELA ACTIVA so values stay readable */
  '#inbox-detail-sidebar{container-type:inline-size;container-name:inbox-col4}',
  '.inbox-customer-card,.inbox-guest-card{container-type:inline-size;container-name:inbox-guest}',
  '@container inbox-guest (max-width:340px){',
  '.inbox-customer-card .customers-profile-field,',
  '.inbox-customer-card.is-full .customers-profile-field,',
  '.inbox-customer-card:not(.is-full) .inbox-guest-inline:has(.inbox-guest-inline-edit:not([hidden])){',
  'grid-template-columns:minmax(0,1fr);gap:2px 0}',
  '.inbox-guest-inline-title,.inbox-guest-notes-title{max-width:none}',
  '.inbox-guest-inline-edit{grid-column:1}',
  '.inbox-two-col.inbox-shell-cols #inbox-detail-sidebar > .inbox-customer-card,',
  '.inbox-two-col.inbox-shell-cols #inbox-detail-sidebar > .inbox-guest-card{padding:10px 10px;gap:8px}',
  '}',
  '@container inbox-col4 (max-width:340px){',
  '.inbox-customer-card .customers-profile-field,',
  '.inbox-customer-card.is-full .customers-profile-field{grid-template-columns:minmax(0,1fr);gap:2px 0}',
  '.inbox-guest-inline-title,.inbox-guest-notes-title{max-width:none}',
  '.inbox-guest-inline-edit{grid-column:1}',
  '}',
  /* md viewport only (901–1279): shrink gutters so list + peek keep usable tracks.
   * Do NOT re-apply the 4-col grid under 900px — that pinned a 240px rail on phones
   * and hid the conversation list (overflow:hidden). */
  '@media(max-width:1279px) and (min-width:901px){',
  '.inbox-two-col.inbox-shell-cols{gap:8px;--inbox-col-gap:8px;',
  'grid-template-columns:minmax(0,var(--inbox-col1-w)) minmax(0,var(--inbox-col2-w)) minmax(0,1fr) minmax(0,var(--inbox-col4-w))}',
  '}',
  '@media(max-width:1279px){',
  '#tab-conversations.active #wrap.inbox-shell-wrap{padding-left:12px!important;padding-right:12px!important}',
  '#inbox-shell[data-col4="peek"] .inbox-customer-card .customers-profile-field,',
  '#inbox-shell[data-col4="peek"] .inbox-customer-card.is-full .customers-profile-field,',
  '#inbox-shell.inbox-guest-drawer .inbox-customer-card .customers-profile-field,',
  '#inbox-shell.inbox-guest-drawer .inbox-customer-card.is-full .customers-profile-field,',
  '#inbox-shell[data-peek="col4"] .inbox-customer-card .customers-profile-field,',
  '#inbox-shell[data-peek="col4"] .inbox-customer-card.is-full .customers-profile-field{',
  'grid-template-columns:minmax(0,1fr);gap:2px 0}',
  '#inbox-shell[data-col4="peek"] .inbox-guest-inline-title,',
  '#inbox-shell[data-col4="peek"] .inbox-guest-notes-title,',
  '#inbox-shell.inbox-guest-drawer .inbox-guest-inline-title,',
  '#inbox-shell.inbox-guest-drawer .inbox-guest-notes-title,',
  '#inbox-shell[data-peek="col4"] .inbox-guest-inline-title,',
  '#inbox-shell[data-peek="col4"] .inbox-guest-notes-title{max-width:none}',
  '#inbox-shell[data-col4="peek"] .inbox-guest-inline-edit,',
  '#inbox-shell.inbox-guest-drawer .inbox-guest-inline-edit,',
  '#inbox-shell[data-peek="col4"] .inbox-guest-inline-edit{grid-column:1}',
  '}',
].join('');

var inboxContextLastComposite = null;
var inboxContextRuntime = { wired: false, fetchHooked: false };

function inboxContextEsc(value) {
  if (typeof escHtml === 'function') return escHtml(value);
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inboxContextT(key, fallback) {
  if (typeof portalT === 'function') {
    var translated = portalT(key);
    if (translated && translated !== key) return translated;
  }
  if (typeof t === 'function') {
    var local = t(key);
    if (local && local !== key) return local;
  }
  return fallback || key;
}

function inboxContextHasOwn(obj, key) {
  return !!(obj && Object.prototype.hasOwnProperty.call(obj, key));
}

function inboxContextIsoDay(value) {
  if (value == null || value === '') return '';
  var s = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function inboxContextDayMonth(iso) {
  var s = inboxContextIsoDay(iso);
  if (!s) return '';
  var month = INBOX_CONTEXT_MONTHS[Number(s.slice(5, 7)) - 1];
  if (!month) return s;
  return String(Number(s.slice(8, 10))) + ' ' + month;
}

function inboxContextStayRange(checkIn, checkOut) {
  var aIso = inboxContextIsoDay(checkIn);
  var bIso = inboxContextIsoDay(checkOut);
  var a = inboxContextDayMonth(aIso);
  var b = inboxContextDayMonth(bIso);
  if (a && b) {
    if (aIso.slice(0, 7) === bIso.slice(0, 7)) {
      return String(Number(aIso.slice(8, 10))) + '\u2013' + b;
    }
    return a + ' \u2013 ' + b;
  }
  return a || b || '';
}

function inboxContextCentsNumber(value) {
  if (value == null || value === '') return null;
  var n = Number(value);
  if (!isFinite(n)) return null;
  return n;
}

function inboxContextEuroFromCents(cents) {
  var n = inboxContextCentsNumber(cents);
  if (n == null) return null;
  var formatted = (n / 100).toFixed(2);
  if (formatted.slice(-3) === '.00') formatted = formatted.slice(0, -3);
  return '\u20ac' + formatted;
}

function inboxContextSumDueCents(bookings) {
  var list = bookings || [];
  var sum = 0;
  var seen = false;
  for (var i = 0; i < list.length; i++) {
    var due = inboxContextCentsNumber(list[i] && list[i].payment_amount_due_cents);
    if (due == null) continue;
    seen = true;
    sum += due;
  }
  return seen ? sum : null;
}

function inboxContextPaymentLabel(row) {
  var raw = row && (row.booking_payment_status || row.payment_record_status);
  if (!raw) return '';
  if (typeof inboxHumanizeStatus === 'function') return inboxHumanizeStatus(raw);
  return String(raw).replace(/[_-]+/g, ' ');
}

function inboxContextStatusKey(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function inboxContextBookingHasOutstanding(row) {
  if (!row) return false;
  var due = inboxContextCentsNumber(row.payment_amount_due_cents);
  if (due != null && due > 0) return true;
  var pay = inboxContextStatusKey(row.booking_payment_status || row.payment_record_status);
  return !!(pay && INBOX_CONTEXT_UNPAID[pay]);
}

function inboxContextOutstandingSection(model) {
  var bookings = (model && model.bookings) || [];
  for (var i = 0; i < bookings.length; i++) {
    if (inboxContextBookingHasOutstanding(bookings[i])) return 'bookings';
  }
  var waivers = model && model.waivers;
  if (waivers && waivers.length) {
    for (var w = 0; w < waivers.length; w++) {
      var st = inboxContextStatusKey(waivers[w] && waivers[w].status);
      if (st && st !== 'completed' && st !== 'complete' && st !== 'signed') return 'waivers';
    }
  }
  return null;
}

function inboxContextCurrentStay(bookings, nowIso) {
  var list = bookings || [];
  if (!list.length) return null;
  var today = inboxContextIsoDay(nowIso) || inboxContextIsoDay(new Date().toISOString());
  var inStay = null;
  var linked = null;
  var checkedIn = null;
  for (var i = 0; i < list.length; i++) {
    var row = list[i];
    if (!row) continue;
    if (row.is_linked) linked = row;
    if (INBOX_CONTEXT_CHECKED_IN[inboxContextStatusKey(row.booking_status)]) checkedIn = row;
    var cin = inboxContextIsoDay(row.check_in);
    var cout = inboxContextIsoDay(row.check_out);
    if (today && cin && cin <= today && (!cout || today < cout)) inStay = row;
  }
  return checkedIn || inStay || linked || list[0];
}

function inboxContextRoomLabel(row) {
  if (!row) return '';
  var code = row.assigned_room_code || row.primary_room_code || '';
  if (!code) return '';
  var text = String(code);
  if (/room/i.test(text)) return text;
  return 'Room ' + text;
}

function inboxContextStayFacts(row) {
  var facts = [];
  if (!row) return facts;
  if (INBOX_CONTEXT_CHECKED_IN[inboxContextStatusKey(row.booking_status)]) facts.push('Checked in');
  var room = inboxContextRoomLabel(row);
  var dates = inboxContextStayRange(row.check_in, row.check_out);
  if (room && dates) facts.push(room + ' \u00b7 ' + dates);
  else if (room) facts.push(room);
  else if (dates) facts.push(dates);
  var paid = inboxContextEuroFromCents(row.payment_amount_paid_cents);
  var due = inboxContextEuroFromCents(row.payment_amount_due_cents);
  var dueN = inboxContextCentsNumber(row.payment_amount_due_cents);
  if (due && dueN != null && dueN > 0) facts.push(due + ' due');
  else if (paid) facts.push('Paid ' + paid);
  else {
    var pay = inboxContextStatusKey(row.booking_payment_status);
    if (pay === 'paid') facts.push('Paid');
  }
  return facts;
}

function inboxContextBookingsSummary(bookings) {
  var list = bookings || [];
  var n = list.length;
  var noun = n === 1 ? 'booking' : 'bookings';
  var line = String(n) + ' ' + noun;
  var due = inboxContextSumDueCents(list);
  var euro = due != null && due > 0 ? inboxContextEuroFromCents(due) : null;
  if (euro) line += ' \u00b7 ' + euro + ' due';
  return line;
}

function inboxContextCountSummary(count, noun, dueCents) {
  var n = Number(count) || 0;
  var word = n === 1 ? noun : noun + 's';
  var line = String(n) + ' ' + word;
  var euro = dueCents != null && dueCents > 0 ? inboxContextEuroFromCents(dueCents) : null;
  if (euro) line += ' \u00b7 ' + euro + ' due';
  return line;
}

function inboxContextPickArray(root, names) {
  if (!root) return null;
  var bags = [root];
  if (root.context) bags.push(root.context);
  if (root.context && root.context.context) bags.push(root.context.context);
  if (root.detail) bags.push(root.detail);
  if (root.detail && root.detail.conversation) bags.push(root.detail.conversation);
  for (var i = 0; i < names.length; i++) {
    for (var b = 0; b < bags.length; b++) {
      var obj = bags[b];
      if (inboxContextHasOwn(obj, names[i]) && Array.isArray(obj[names[i]])) return obj[names[i]];
    }
  }
  return null;
}

function inboxContextActiveBookings(rows) {
  var list = rows || [];
  if (typeof filterActiveInboxBookings === 'function') return filterActiveInboxBookings(list);
  return list.filter(function(row) {
    var st = inboxContextStatusKey(row && row.booking_status);
    return st !== 'cancelled' && st !== 'canceled' && st !== 'expired';
  });
}

function inboxContextBookingsFromComposite(composite) {
  var ctxData = (composite && composite.context) || {};
  var ctx = ctxData.context || null;
  if (ctxData.success && ctxData.bookings && ctxData.bookings.length) {
    return inboxContextActiveBookings(ctxData.bookings);
  }
  if (ctx && (ctx.booking_code || ctx.booking_id)) return inboxContextActiveBookings([ctx]);
  return [];
}

/** Stable key for de-duping Staff API booking rows (customer context vs thread composite). */
function inboxCustomerBookingKey(b) {
  if (!b) return '';
  var id = String(b.booking_id || '').trim();
  if (id) return 'id:' + id;
  var code = String(b.booking_code || '').trim();
  if (code) return 'code:' + code;
  return '';
}

/**
 * Union booking rows from customer context and thread composite without inventing rows.
 * Thread composite includes current_hold_booking_id links that phone-only context can miss.
 */
function inboxCustomerMergeBookings(primary, secondary) {
  var out = [];
  var seen = {};
  function pushAll(list) {
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (!row) continue;
      var key = inboxCustomerBookingKey(row);
      if (key && seen[key]) continue;
      if (key) seen[key] = true;
      out.push(row);
    }
  }
  pushAll(primary);
  pushAll(secondary);
  return out;
}

/**
 * Bookings for the guest / person card: existing Staff API rows only.
 * Prefer customer-context bookings; fill gaps from thread composite (already fetched).
 */
function inboxCustomerResolveBookings(data, composite) {
  var fromCustomer = inboxContextActiveBookings((data && data.bookings) || []);
  var fromComposite = inboxContextBookingsFromComposite(composite);
  if (!fromComposite.length) return fromCustomer;
  if (!fromCustomer.length) return fromComposite;
  return inboxCustomerMergeBookings(fromCustomer, fromComposite);
}

/**
 * Count for BOOKINGS / LESSONS chips.
 * Never prefer a CRM-cache 0 over a real Staff API list; never invent when both empty.
 */
function inboxCustomerStatCount(listLen, cacheCount) {
  var fromList = Number(listLen) || 0;
  if (fromList > 0) return fromList;
  if (cacheCount != null && cacheCount !== '') {
    var fromCache = Number(cacheCount) || 0;
    if (fromCache > 0) return fromCache;
  }
  return fromList;
}

function inboxContextNotesFromConv(conv) {
  var notes = [];
  if (!conv) return notes;
  if (conv.human_notes) notes.push({ kind: 'human', text: String(conv.human_notes) });
  if (conv.conversation_summary) notes.push({ kind: 'summary', text: String(conv.conversation_summary) });
  if (conv.internal_staff_notes) notes.push({ kind: 'internal', text: String(conv.internal_staff_notes) });
  return notes;
}

function inboxContextTagLabel(key) {
  var k = String(key || '');
  if (!k) return '';
  var translated = inboxContextT('customers.tags.' + k, '');
  if (translated) return translated;
  return k.replace(/[_-]+/g, ' ').replace(/\b\w/g, function(ch) { return ch.toUpperCase(); });
}

function inboxContextTagsForConv(conv) {
  if (conv && Array.isArray(conv.display_tags) && conv.display_tags.length) return conv.display_tags;
  if (typeof inboxConversationsCache !== 'undefined' && inboxConversationsCache && conv) {
    var id = conv.conversation_id;
    for (var i = 0; i < inboxConversationsCache.length; i++) {
      var row = inboxConversationsCache[i];
      if (row && id && row.conversation_id === id && Array.isArray(row.display_tags) && row.display_tags.length) {
        return row.display_tags;
      }
    }
  }
  return [];
}

function inboxContextModelFromComposite(composite) {
  var detail = (composite && composite.detail) || {};
  var conv = detail.conversation || {};
  return {
    conversation: conv,
    bookings: inboxContextBookingsFromComposite(composite),
    lessons: inboxContextPickArray(composite, ['lessons', 'service_records']),
    waivers: inboxContextPickArray(composite, ['waivers']),
    broadcasts: inboxContextPickArray(composite, ['broadcasts', 'broadcast_receipts']),
    notes: inboxContextNotesFromConv(conv),
    tags: inboxContextTagsForConv(conv),
  };
}

function inboxContextNormalizeModel(input) {
  if (!input) return { conversation: {}, bookings: [], lessons: null, waivers: null, broadcasts: null, notes: [], tags: [] };
  if (input.detail || input.context || input.success) return inboxContextModelFromComposite(input);
  return {
    conversation: input.conversation || {},
    bookings: input.bookings || [],
    lessons: inboxContextHasOwn(input, 'lessons') ? input.lessons : null,
    waivers: inboxContextHasOwn(input, 'waivers') ? input.waivers : null,
    broadcasts: inboxContextHasOwn(input, 'broadcasts') ? input.broadcasts : null,
    notes: input.notes || inboxContextNotesFromConv(input.conversation),
    tags: input.tags || inboxContextTagsForConv(input.conversation),
  };
}

function inboxContextScope() {
  try {
    if (typeof getClient === 'function') return String(getClient() || 'default');
    return localStorage.getItem('staff_portal_client') || 'default';
  } catch (_e) { return 'default'; }
}

function inboxContextStorageKey() {
  return INBOX_CONTEXT_STORAGE_PREFIX + ':' + inboxContextScope();
}

function inboxContextReadExpanded() {
  try {
    var raw = JSON.parse(localStorage.getItem(inboxContextStorageKey()) || '{}');
    return raw && raw.sections && typeof raw.sections === 'object' ? raw.sections : {};
  } catch (_e) { return {}; }
}

function inboxContextWriteExpanded(sections) {
  try {
    localStorage.setItem(inboxContextStorageKey(), JSON.stringify({ sections: sections }));
  } catch (_e) { /* private mode: expand still works for the session */ }
}

function inboxContextSectionOpen(key, outstandingKey, saved) {
  saved = saved || {};
  if (inboxContextHasOwn(saved, key)) return !!saved[key];
  return key === outstandingKey;
}

function inboxContextCollapsibleHtml(opts) {
  opts = opts || {};
  if (typeof renderCollapsibleCustomerSection === 'function') {
    return renderCollapsibleCustomerSection({
      id: opts.id,
      title: opts.title,
      count: opts.count,
      open: opts.open,
      body: opts.body,
    });
  }
  return '<details class="customers-section customers-collapsible"' +
    (opts.id ? ' id="' + inboxContextEsc(opts.id) + '"' : '') +
    (opts.open ? ' open' : '') + '>' +
    '<summary class="customers-section-hdr customers-collapsible-summary">' +
    inboxContextEsc(opts.title || '') +
    '</summary>' +
    '<div class="customers-section-body customers-collapsible-body">' + (opts.body || '') + '</div>' +
    '</details>';
}

function inboxContextKv(label, value) {
  if (value == null || value === '') return '';
  if (typeof kv === 'function') return kv(label, value);
  return '<div class="kv"><span class="k">' + inboxContextEsc(label) + '</span><span class="v">' +
    inboxContextEsc(value) + '</span></div>';
}

function inboxContextFormatDateField(value) {
  if (!value) return '';
  if (typeof fmtDateOnly === 'function') {
    var formatted = fmtDateOnly(value);
    return formatted && formatted !== '\u2014' ? formatted : inboxContextStayRange(value, null);
  }
  return inboxContextDayMonth(value) || String(value).slice(0, 10);
}

function inboxContextBookingRowHtml(row, guestName) {
  row = row || {};
  var dates = inboxContextStayRange(row.check_in, row.check_out);
  var amount = inboxContextEuroFromCents(row.payment_amount_due_cents) ||
    inboxContextEuroFromCents(row.payment_amount_paid_cents);
  var pay = inboxContextPaymentLabel(row);
  var html = '<details class="inbox-guest-booking">';
  html += '<summary class="inbox-guest-booking-summary">';
  if (dates) html += '<span class="inbox-guest-booking-dates">' + inboxContextEsc(dates) + '</span>';
  if (amount) html += '<span class="inbox-guest-booking-amount">' + inboxContextEsc(amount) + '</span>';
  if (pay) html += '<span class="inbox-guest-booking-pay">' + inboxContextEsc(pay) + '</span>';
  html += '</summary>';
  html += '<div class="inbox-guest-booking-body">';
  html += '<div class="kv2">';
  html += inboxContextKv('Status', row.booking_status ? (typeof inboxHumanizeStatus === 'function' ? inboxHumanizeStatus(row.booking_status) : row.booking_status) : '');
  html += inboxContextKv('Payment', pay);
  if (row.check_in || row.check_out) {
    html += inboxContextKv('Dates', inboxContextFormatDateField(row.check_in) + ' \u2192 ' + inboxContextFormatDateField(row.check_out));
  }
  if (row.guest_count != null && row.guest_count !== '') html += inboxContextKv('Guests', row.guest_count);
  if (row.confirmation_sent_at) html += inboxContextKv('Confirm', typeof fmtTs === 'function' ? fmtTs(row.confirmation_sent_at) : String(row.confirmation_sent_at));
  var room = inboxContextRoomLabel(row);
  if (room) html += inboxContextKv('Room', room);
  html += '</div>';
  html += '<button type="button" class="inbox-booking-cal-link inbox-open-booking-cal" ' +
    'data-booking-id="' + inboxContextEsc(row.booking_id || '') + '" ' +
    'data-booking-code="' + inboxContextEsc(row.booking_code || '') + '" ' +
    'data-check-in="' + inboxContextEsc(row.check_in || '') + '" ' +
    'data-check-out="' + inboxContextEsc(row.check_out || '') + '" ' +
    'data-guest-name="' + inboxContextEsc(row.booking_guest_name || guestName || '') + '">' +
    inboxContextEsc(inboxContextT('inbox.booking.openInCalendar', 'Open booking')) + '</button>';
  html += '</div></details>';
  return html;
}

function inboxContextSectionHtml(opts) {
  var cls = 'inbox-guest-section' + (opts.zero ? ' is-zero' : '');
  return '<div class="' + cls + '" data-inbox-context-section="' + inboxContextEsc(opts.key) + '">' +
    inboxContextCollapsibleHtml({
      id: 'inbox-context-' + opts.key,
      title: opts.title,
      open: opts.open,
      body: opts.body,
    }) +
    '</div>';
}

function inboxContextNotesBody(notes) {
  var html = '';
  (notes || []).forEach(function(note) {
    if (!note || !note.text) return;
    html += '<div class="inbox-guest-note" style="font-size:12px;white-space:pre-wrap;margin-bottom:6px">' +
      inboxContextEsc(note.text) + '</div>';
  });
  return html;
}

function inboxContextListBody(rows, emptyCopy, renderRow) {
  if (!rows || !rows.length) {
    return '<div class="customers-section-empty">' + inboxContextEsc(emptyCopy) + '</div>';
  }
  var html = '';
  for (var i = 0; i < rows.length; i++) html += renderRow(rows[i], i);
  return html;
}

function inboxContextCollectionsHtml(model, saved, outstandingKey) {
  var html = '';
  var bookings = model.bookings || [];
  html += inboxContextSectionHtml({
    key: 'bookings',
    title: inboxContextBookingsSummary(bookings),
    zero: bookings.length === 0,
    open: inboxContextSectionOpen('bookings', outstandingKey, saved),
    body: bookings.length
      ? bookings.map(function(row) { return inboxContextBookingRowHtml(row, model.conversation && model.conversation.guest_name); }).join('')
      : '<div class="customers-section-empty">' + inboxContextEsc(inboxContextT('inbox.detail.bookings.none', 'No bookings for this guest yet.')) + '</div>',
  });

  if (model.lessons) {
    html += inboxContextSectionHtml({
      key: 'lessons',
      title: inboxContextCountSummary(model.lessons.length, 'lesson'),
      zero: model.lessons.length === 0,
      open: inboxContextSectionOpen('lessons', outstandingKey, saved),
      body: inboxContextListBody(model.lessons, 'No lessons', function(row) {
        if (typeof renderCollapsibleCustomerSection === 'function' && row && row.service_type) {
          return '<div class="inbox-guest-lesson">' + inboxContextEsc(String(row.service_date || '')) +
            ' \u00b7 ' + inboxContextEsc(String(row.service_type || '').replace(/_/g, ' ')) + '</div>';
        }
        return '<div class="inbox-guest-lesson">' + inboxContextEsc(String((row && (row.label || row.service_type || '')) || '')) + '</div>';
      }),
    });
  }

  if (model.waivers) {
    var waiverBody = '';
    if (typeof renderCustomerWaiverFormsSection === 'function') {
      waiverBody = renderCustomerWaiverFormsSection({ waivers: model.waivers });
    } else {
      waiverBody = inboxContextListBody(model.waivers, 'No waivers', function(row) {
        return '<div class="inbox-guest-waiver">' + inboxContextEsc(String((row && (row.status || row.booking_code)) || '')) + '</div>';
      });
    }
    html += inboxContextSectionHtml({
      key: 'waivers',
      title: inboxContextCountSummary(model.waivers.length, 'waiver'),
      zero: model.waivers.length === 0,
      open: inboxContextSectionOpen('waivers', outstandingKey, saved),
      body: waiverBody,
    });
  }

  var notes = model.notes || [];
  html += inboxContextSectionHtml({
    key: 'notes',
    title: notes.length ? (String(notes.length) + (notes.length === 1 ? ' note' : ' notes')) : 'Notes',
    zero: notes.length === 0,
    open: inboxContextSectionOpen('notes', outstandingKey, saved),
    body: notes.length ? inboxContextNotesBody(notes) : '<div class="customers-section-empty">No notes</div>',
  });

  if (model.broadcasts) {
    html += inboxContextSectionHtml({
      key: 'broadcasts',
      title: inboxContextCountSummary(model.broadcasts.length, 'broadcast'),
      zero: model.broadcasts.length === 0,
      open: inboxContextSectionOpen('broadcasts', outstandingKey, saved),
      body: inboxContextListBody(model.broadcasts, 'No broadcasts', function(row) {
        return '<div class="inbox-guest-broadcast">' + inboxContextEsc(String((row && (row.subject || row.title || '')) || '')) + '</div>';
      }),
    });
  }
  return html;
}

function inboxContextGuestCardHtml(input, opts) {
  opts = opts || {};
  var model = inboxContextNormalizeModel(input);
  var conv = model.conversation || {};
  var name = conv.guest_name || conv.phone || 'Guest';
  if (typeof inboxPersonDisplayName === 'function') name = inboxPersonDisplayName(conv);
  else if (typeof inboxIsOpaqueEmailIdentity === 'function' && inboxIsOpaqueEmailIdentity(name)) {
    name = conv.guest_email || conv.email || 'Guest';
  }
  var tags = (model.tags || []).map(inboxContextTagLabel).filter(Boolean);
  var stay = inboxContextStayFacts(inboxContextCurrentStay(model.bookings, opts.nowIso));
  var saved = opts.expanded || inboxContextReadExpanded();
  var outstandingKey = inboxContextOutstandingSection(model);
  var hideLabel = inboxContextT('inbox.detail.sidebar.hide', 'Hide bookings');

  var html = '<div class="inbox-guest-card" id="inbox-guest-card">';
  html += '<div class="inbox-guest-card-head">';
  html += '<div>';
  html += '<div class="inbox-guest-name">' + inboxContextEsc(name) + '</div>';
  if (tags.length) html += '<div class="inbox-guest-tags">' + inboxContextEsc(tags.join(' \u00b7 ')) + '</div>';
  html += '</div>';
  html += '<button type="button" class="detail-sidebar-toggle" id="inbox-sidebar-toggle" aria-controls="inbox-detail-sidebar" aria-expanded="true" title="' +
    inboxContextEsc(hideLabel) + '" aria-label="' + inboxContextEsc(hideLabel) + '">&#8594;</button>';
  html += '</div>';

  if (stay.length) {
    html += '<div class="inbox-guest-stay">';
    for (var i = 0; i < stay.length; i++) {
      html += '<div class="inbox-guest-stay-fact">' + inboxContextEsc(stay[i]) + '</div>';
    }
    html += '</div>';
  }

  html += '<div class="inbox-guest-collections">';
  html += inboxContextCollectionsHtml(model, saved, outstandingKey);
  html += '</div>';

  html += '<div class="inbox-guest-actions">';
  html += '<button type="button" class="btn inbox-guest-create-booking" id="inbox-create-booking-for-guest">' +
    inboxContextEsc(inboxContextT('customers.detail.createBooking', 'Create booking')) + '</button>';
  html += '</div>';
  html += '</div>';
  return html;
}

function inboxContextSidebarEl(targetEl) {
  if (targetEl && targetEl.querySelector) {
    var nested = targetEl.querySelector('#inbox-detail-sidebar');
    if (nested) return nested;
  }
  if (typeof el === 'function') return el('inbox-detail-sidebar');
  if (typeof document !== 'undefined') return document.getElementById('inbox-detail-sidebar');
  return null;
}

function inboxClientInfoInitials(name) {
  if (typeof customerProfileInitials === 'function') return customerProfileInitials(name);
  if (typeof inboxRowInitials === 'function') return inboxRowInitials(name);
  var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function inboxClientInfoHasRecord(data) {
  if (!data || data.success === false) return false;
  var id = data.identity || {};
  var tags = id.display_tags || [];
  if (id.display_name || id.email || id.language) return true;
  if ((data.bookings && data.bookings.length) || (data.service_records && data.service_records.length)) return true;
  if (tags.length) return true;
  if (typeof customersCache !== 'undefined' && customersCache && data.phone) {
    for (var i = 0; i < customersCache.length; i++) {
      if (customersCache[i] && customersCache[i].phone === data.phone) return true;
    }
  }
  return false;
}

function inboxClientInfoCacheRow(phone) {
  if (typeof customersCache === 'undefined' || !customersCache || !phone) return null;
  for (var i = 0; i < customersCache.length; i++) {
    if (customersCache[i] && customersCache[i].phone === phone) return customersCache[i];
  }
  return null;
}

function inboxClientInfoCheckedIn(data, cacheRow) {
  if (cacheRow && cacheRow.checked_in_now) return 'Yes';
  var bookings = (data && data.bookings) || [];
  for (var i = 0; i < bookings.length; i++) {
    if (INBOX_CONTEXT_CHECKED_IN[inboxContextStatusKey(bookings[i].booking_status)]) return 'Yes';
  }
  return 'No';
}

function inboxClientInfoUnpaid(data, composite) {
  if (composite) {
    var due = inboxContextSumDueCents(inboxContextBookingsFromComposite(composite));
    if (due != null && due > 0) return inboxContextEuroFromCents(due);
  }
  var bookings = (data && data.bookings) || [];
  var unpaid = 0;
  for (var i = 0; i < bookings.length; i++) {
    var st = inboxContextStatusKey(bookings[i].payment_status || bookings[i].booking_payment_status);
    if (st && INBOX_CONTEXT_UNPAID[st]) unpaid += 1;
  }
  if (unpaid) return String(unpaid);
  return '—';
}

function inboxClientInfoWaiver(data) {
  var waivers = (data && data.waivers) || [];
  if (!waivers.length) return '—';
  var pending = 0;
  var signed = 0;
  for (var i = 0; i < waivers.length; i++) {
    var st = inboxContextStatusKey(waivers[i] && waivers[i].status);
    if (st === 'completed' || st === 'complete' || st === 'signed') signed += 1;
    else pending += 1;
  }
  if (pending) return pending === 1 ? 'Due' : (String(pending) + ' due');
  if (signed) return 'Signed';
  return '—';
}

function inboxClientInfoChipsHtml(data, cacheRow) {
  var tags = [];
  var id = (data && data.identity) || {};
  if (id.display_tags && id.display_tags.length) tags = id.display_tags;
  else if (cacheRow && cacheRow.display_tags && cacheRow.display_tags.length) tags = cacheRow.display_tags;
  if (!tags.length) return '';
  var html = '<div class="inbox-client-info-chips">';
  for (var i = 0; i < tags.length; i++) {
    if (typeof customerTagChipHtml === 'function') {
      html += customerTagChipHtml(tags[i], { auto: typeof customerTagIsAuto === 'function' ? customerTagIsAuto(tags[i], id) : false, compact: true });
    } else {
      html += '<span class="customers-badge customers-badge-tag">' + inboxContextEsc(inboxContextTagLabel(tags[i])) + '</span>';
    }
  }
  html += '</div>';
  return html;
}

function inboxClientInfoHtml(data, opts) {
  opts = opts || {};
  var id = (data && data.identity) || {};
  var cacheRow = inboxClientInfoCacheRow(data.phone);
  var name = id.display_name || (cacheRow && cacheRow.display_name) || data.phone || 'Guest';
  var phone = data.phone || '';
  var email = id.email || (cacheRow && cacheRow.email) || '';
  var contact = [];
  if (phone) contact.push(phone);
  if (email) contact.push(email);
  var bookings = inboxCustomerResolveBookings(data, opts.composite);
  var bookingsN = inboxCustomerStatCount(bookings.length, cacheRow && cacheRow.booking_count);
  var lessonsN = inboxCustomerStatCount(
    ((data.service_records || []).length),
    cacheRow && cacheRow.service_count
  );
  var language = id.language || (cacheRow && cacheRow.language) || '—';
  var dataForFacts = data;
  if (bookings.length && (!(data && data.bookings) || !data.bookings.length)) {
    dataForFacts = Object.assign({}, data, { bookings: bookings });
  }
  var html = '<div class="inbox-client-info" id="inbox-client-info" data-phone="' + inboxContextEsc(phone) + '">';
  html += '<div class="inbox-client-info-head">';
  html += '<div class="inbox-client-info-avatar" aria-hidden="true">' + inboxContextEsc(inboxClientInfoInitials(name)) + '</div>';
  html += '<div class="inbox-client-info-id">';
  html += '<div class="inbox-client-info-name">' + inboxContextEsc(name) + '</div>';
  if (contact.length) html += '<div class="inbox-client-info-contact">' + inboxContextEsc(contact.join(' · ')) + '</div>';
  html += '</div></div>';
  html += inboxClientInfoChipsHtml(dataForFacts, cacheRow);
  html += '<div class="inbox-client-info-kv">';
  html += inboxContextKv(inboxContextT('customers.card.checkedIn', 'Checked in'), inboxClientInfoCheckedIn(dataForFacts, cacheRow));
  html += inboxContextKv(inboxContextT('customers.card.bookings', 'Bookings'), String(bookingsN));
  html += inboxContextKv(inboxContextT('customers.card.classes', 'Lessons'), String(lessonsN));
  html += inboxContextKv(inboxContextT('customers.card.balanceDue', 'Unpaid balance'), inboxClientInfoUnpaid(dataForFacts, opts.composite));
  html += inboxContextKv(inboxContextT('customers.card.waiverStatus', 'Waiver status'), inboxClientInfoWaiver(dataForFacts));
  html += inboxContextKv('Language', language);
  html += '</div>';
  html += '<button type="button" class="inbox-client-info-open" id="inbox-client-info-open">' +
    inboxContextEsc(inboxContextT('inbox.detail.clientInfo.openProfile', 'Open full profile')) + '</button>';
  html += '</div>';
  return html;
}

function inboxContextIsGuestMode() {
  var shell = typeof document !== 'undefined' ? document.getElementById('inbox-shell') : null;
  if (shell && shell.getAttribute('data-col4') === 'wide') return true;
  if (typeof document === 'undefined') return false;
  var btn = document.querySelector('[data-inbox-preset="guest"][aria-pressed="true"]');
  return !!(btn);
}

function inboxCustomerFromConv(conv) {
  conv = conv || {};
  var email = (typeof inboxGuestEmailOf === 'function')
    ? inboxGuestEmailOf(conv)
    : (conv.email || conv.guest_email || '');
  var name = (typeof inboxPersonDisplayName === 'function')
    ? inboxPersonDisplayName(conv)
    : (conv.guest_name || conv.display_name || '');
  if (typeof inboxIsOpaqueEmailIdentity === 'function' && inboxIsOpaqueEmailIdentity(name)) name = email || '';
  var phone = inboxCustomerResolvePhone(conv, null);
  return {
    success: true,
    phone: phone,
    customer_id: conv.customer_id || null,
    identity: {
      display_name: name,
      email: email,
      language: conv.language || '',
    },
    bookings: [],
    service_records: [],
    messages: [],
    waivers: [],
  };
}

function inboxCustomerMerge(base, extra) {
  var out = extra && extra.success !== false ? extra : (base || inboxCustomerFromConv({}));
  if (base && base.phone && !out.phone) out.phone = base.phone;
  if (base && base.identity) {
    out.identity = out.identity || {};
    if (!out.identity.display_name && base.identity.display_name) out.identity.display_name = base.identity.display_name;
    if (!out.identity.email && base.identity.email) out.identity.email = base.identity.email;
    if (!out.identity.language && base.identity.language) out.identity.language = base.identity.language;
  }
  return out;
}

function inboxCustomerCondensedHtml(data, opts) {
  opts = opts || {};
  var id = (data && data.identity) || {};
  var cacheRow = inboxClientInfoCacheRow(data && data.phone);
  var name = id.display_name || (cacheRow && cacheRow.display_name) || (data && data.phone) || 'Guest';
  var phone = (data && data.phone) || '';
  var email = id.email || (cacheRow && cacheRow.email) || '';
  var notes = '';
  if (data && data.notes) notes = data.notes.internal_staff_notes || data.notes.notes || '';
  if (!notes && opts.conv && opts.conv.internal_staff_notes) notes = opts.conv.internal_staff_notes;
  var lastSetup = (data && data.last_setup_summary) || '';
  var school = '';
  try {
    if (typeof isSunsetSurfActive === 'function' && isSunsetSurfActive() && typeof getSunsetLocationLabel === 'function') {
      school = getSunsetLocationLabel() || '';
    }
  } catch (_e) { school = ''; }
  var bookings = inboxCustomerResolveBookings(data, opts.composite);
  var dataForBookings = (bookings.length && (!(data && data.bookings) || data.bookings.length !== bookings.length))
    ? Object.assign({}, data, { bookings: bookings })
    : data;
  var html = '<div class="inbox-customer-card" id="inbox-customer-card">';
  html += '<div class="inbox-customer-head">';
  html += '<div class="inbox-client-info-avatar" aria-hidden="true">' + inboxContextEsc(inboxClientInfoInitials(name)) + '</div>';
  html += '<div class="inbox-client-info-id">';
  html += '<div class="inbox-client-info-name">' + inboxContextEsc(name) + '</div>';
  html += '</div>';
  html += '<button type="button" class="inbox-customer-hide" id="inbox-customer-hide" title="Hide guest card" aria-label="Hide guest card">';
  html += '<span class="inbox-customer-hide-arrow" aria-hidden="true">&#8594;</span>';
  html += '<span class="inbox-customer-hide-pin" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg></span>';
  html += '</button>';
  html += '</div>';
  html += '<div class="customers-profile-fields">';
  html += inboxCustomerInlineFieldHtml('phone', inboxContextEsc(inboxContextT('customers.detail.phone', 'Phone')), phone, '—', false);
  html += inboxCustomerInlineFieldHtml('email', inboxContextEsc(inboxContextT('customers.detail.email', 'Email')), email, '—', false);
  if (school) html += inboxCustomerField(inboxContextT('customers.detail.school', 'Active school'), school, false);
  html += inboxCustomerField(inboxContextT('customers.card.lastSetup', 'Last setup'), lastSetup || inboxContextT('customers.detail.noServices', 'No services yet'), !lastSetup);
  html += inboxCustomerNotesFieldHtml(notes);
  html += '</div>';
  html += '<div class="inbox-client-info-kv inbox-customer-stats">';
  html += inboxContextKv(inboxContextT('customers.card.checkedIn', 'Checked in'), inboxClientInfoCheckedIn(dataForBookings, cacheRow));
  var bookingsN = inboxCustomerStatCount(bookings.length, cacheRow && cacheRow.booking_count);
  var lessonsN = inboxCustomerStatCount(
    ((data && data.service_records) || []).length,
    cacheRow && cacheRow.service_count
  );
  html += inboxContextKv(inboxContextT('customers.card.bookings', 'Bookings'), String(bookingsN));
  html += inboxContextKv(inboxContextT('customers.card.classes', 'Lessons'), String(lessonsN));
  html += inboxContextKv(inboxContextT('customers.card.balanceDue', 'Unpaid balance'), inboxClientInfoUnpaid(dataForBookings, opts.composite));
  html += inboxContextKv(inboxContextT('customers.card.waiverStatus', 'Waiver status'), inboxClientInfoWaiver(dataForBookings));
  html += '</div>';
  html += inboxCustomerGuestTagsHtml(dataForBookings);
  html += inboxCustomerBookingsListHtml(dataForBookings);
  html += '<div class="inbox-guest-actions">';
  html += '<button type="button" class="btn inbox-guest-create-booking" id="inbox-create-booking-for-guest">' +
    inboxContextEsc(inboxContextT('customers.detail.createBooking', 'Create booking')) + '</button>';
  html += '</div></div>';
  return html;
}

function inboxCustomerBookingsListHtml(data) {
  var bookings = (data && data.bookings) || [];
  var html = '<div class="inbox-customer-bookings">';
  html += '<div class="customers-section-hdr">' + inboxContextEsc(inboxContextT('customers.detail.linkedBookings', 'Linked bookings')) + '</div>';
  if (!bookings.length) {
    html += '<div class="customers-section-empty">' + inboxContextEsc(inboxContextT('customers.detail.noLinkedBookings', 'No linked bookings yet')) + '</div>';
    html += '</div>';
    return html;
  }
  for (var i = 0; i < bookings.length; i++) {
    var b = bookings[i] || {};
    var code = b.booking_code || b.booking_id || 'Booking';
    var checkIn = b.check_in ? String(b.check_in).slice(0, 10) : '';
    var checkOut = b.check_out ? String(b.check_out).slice(0, 10) : '';
    var dates = (checkIn || checkOut) ? (checkIn || '—') + ' → ' + (checkOut || '—') : '';
    html += '<button type="button" class="inbox-customer-booking-link" data-inbox-open-booking="1"';
    html += ' data-booking-id="' + inboxContextEsc(String(b.booking_id || '')) + '"';
    html += ' data-booking-code="' + inboxContextEsc(String(b.booking_code || '')) + '"';
    html += ' data-check-in="' + inboxContextEsc(checkIn) + '"';
    html += ' data-check-out="' + inboxContextEsc(checkOut) + '"';
    html += ' data-guest-name="' + inboxContextEsc(String(b.guest_name || '')) + '">';
    html += inboxContextEsc(String(code));
    if (dates) html += '<span class="inbox-customer-booking-meta">' + inboxContextEsc(dates) + '</span>';
    html += '</button>';
  }
  html += '</div>';
  return html;
}

function inboxCustomerField(label, value, muted) {
  return '<div class="customers-profile-field"><span class="customers-profile-field-label">' +
    inboxContextEsc(label) + '</span><span class="customers-profile-field-value' +
    (muted ? ' is-empty' : '') + '">' + inboxContextEsc(value) + '</span></div>';
}

function inboxCustomerInlineFieldHtml(key, labelHtml, value, emptyCopy, asArea) {
  var text = String(value || '').trim();
  var empty = !text;
  var html = '<div class="customers-profile-field inbox-guest-inline" data-inbox-inline="' + inboxContextEsc(key) + '">';
  html += '<button type="button" class="customers-profile-field-label inbox-guest-inline-title' +
    (key === 'notes' ? ' inbox-guest-notes-title' : '') + '"' +
    (key === 'notes' ? ' id="inbox-guest-notes-open"' : '') + '>';
  html += labelHtml;
  html += '</button>';
  html += '<span class="customers-profile-field-value inbox-guest-inline-display' + (empty ? ' is-empty' : '') + '"' +
    (key === 'notes' ? ' id="inbox-guest-notes-text-display"' : '') + '>';
  html += inboxContextEsc(empty ? emptyCopy : text);
  html += '</span>';
  html += '<div class="inbox-guest-inline-edit inbox-guest-notes-edit" hidden' +
    (key === 'notes' ? ' id="inbox-guest-notes-edit"' : '') + '>';
  if (asArea) {
    html += '<textarea rows="2"' + (key === 'notes' ? ' id="inbox-guest-notes-text"' : '') + '>' + inboxContextEsc(text) + '</textarea>';
  } else {
    html += '<input type="text" value="' + inboxContextEsc(text) + '">';
  }
  html += '<button type="button" class="btn btn-primary inbox-guest-inline-save"' +
    (key === 'notes' ? ' id="inbox-guest-notes-save"' : '') + '>' +
    inboxContextEsc(inboxContextT('common.save', 'Save')) + '</button>';
  html += '</div></div>';
  return html;
}

function inboxCustomerNotesLabelHtml() {
  var label = inboxContextT('customers.detail.notes', 'Notes for next time');
  if (label === 'Notes for next time') return 'Notes for<br>next time';
  return inboxContextEsc(label);
}

function inboxCustomerNotesFieldHtml(notes) {
  return inboxCustomerInlineFieldHtml(
    'notes',
    inboxCustomerNotesLabelHtml(),
    notes,
    inboxContextT('customers.detail.noNotes', 'No notes yet'),
    true
  );
}

/** Staff-facing payment label for linked bookings (EN/ES). Prefer Customers helper; never invent status. */
function inboxCustomerPaymentStatusLabel(raw) {
  if (typeof customerPaymentStatusLabel === 'function') {
    return customerPaymentStatusLabel(raw);
  }
  var s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/\s+/g, '_');
  if (!s || s === '—' || s === '-') return '—';
  if (s === 'canceled') s = 'cancelled';
  if (s === 'fully_paid' || s === 'paid_in_full' || s === 'succeeded' || s === 'complete' || s === 'completed') s = 'paid';
  if (
    s === 'waiting_payment' || s === 'pending' || s === 'not_requested' || s === 'unpaid'
    || s === 'pending_deposit' || s === 'payment_pending' || s === 'payment_link_sent'
    || s === 'checkout_created' || s === 'draft' || s === 'failed'
  ) s = 'unpaid';
  if (s === 'deposit_paid' || s === 'partially_paid' || s === 'balance_due') s = 'partial';
  var key = 'admin.bookings.status.' + s;
  var t = '';
  try { t = String((typeof portalT === 'function' && portalT(key)) || ''); } catch (_e) { t = ''; }
  if (t && t !== key && t.indexOf('admin.bookings.') !== 0) return t;
  var es = false;
  try { es = String((typeof portalLang === 'string' && portalLang) || '') === 'es'; } catch (_l) { es = false; }
  var en = { paid: 'Paid', unpaid: 'Unpaid', partial: 'Partial', refunded: 'Refunded', cancelled: 'Cancelled' };
  var esMap = { paid: 'Pagado', unpaid: 'Sin pagar', partial: 'Parcial', refunded: 'Reembolsado', cancelled: 'Cancelado' };
  if (es && esMap[s]) return esMap[s];
  if (en[s]) return en[s];
  return s.replace(/_/g, ' ').replace(/\b\w/g, function(ch) { return ch.toUpperCase(); });
}

function inboxCustomerGuestBookingsHtml(data) {
  var bookings = (data && data.bookings) || [];
  var html = '<div class="customers-section inbox-guest-linked-bookings">';
  html += '<div class="customers-section-hdr">' + inboxContextEsc(inboxContextT('customers.detail.linkedBookings', 'Linked bookings')) + '</div>';
  if (!bookings.length) {
    html += '<div class="customers-section-empty">' + inboxContextEsc(inboxContextT('customers.detail.noLinkedBookings', 'No linked bookings yet')) + '</div>';
    html += '</div>';
    return html;
  }
  html += '<table class="customers-row-table"><thead><tr>';
  html += '<th>' + inboxContextEsc(inboxContextT('customers.detail.bookingCode', 'Booking')) + '</th>';
  html += '<th>' + inboxContextEsc(inboxContextT('customers.detail.bookingDates', 'Dates')) + '</th>';
  html += '<th>' + inboxContextEsc(inboxContextT('customers.detail.paymentStatus', 'Payment')) + '</th>';
  html += '</tr></thead><tbody>';
  for (var i = 0; i < bookings.length; i++) {
    var b = bookings[i] || {};
    var checkIn = b.check_in ? String(b.check_in).slice(0, 10) : '';
    var checkOut = b.check_out ? String(b.check_out).slice(0, 10) : '';
    var dates = (checkIn || checkOut) ? ((checkIn || '—') + ' → ' + (checkOut || '—')) : '—';
    var pay = inboxCustomerPaymentStatusLabel(b.payment_status || b.payment_payment_status || '—');
    var guestName = b.guest_name || b.booking_guest_name || '';
    html += '<tr class="inbox-guest-booking-row" data-inbox-open-booking="1"';
    html += ' data-booking-id="' + inboxContextEsc(String(b.booking_id || '')) + '"';
    html += ' data-booking-code="' + inboxContextEsc(String(b.booking_code || '')) + '"';
    html += ' data-check-in="' + inboxContextEsc(checkIn) + '"';
    html += ' data-check-out="' + inboxContextEsc(checkOut) + '"';
    html += ' data-guest-name="' + inboxContextEsc(guestName) + '"';
    html += ' tabindex="0" role="button">';
    html += '<td>' + inboxContextEsc(String(b.booking_code || '—')) + '</td>';
    html += '<td>' + inboxContextEsc(dates) + '</td>';
    html += '<td>' + inboxContextEsc(String(pay)) + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

var INBOX_GUEST_CRM_TAG_KEYS = ['lead', 'warm_lead', 'hot_lead', 'repeat_guest', 'vip', 'local', 'surf_school', 'accommodation', 'do_not_contact', 'newsletter_ok'];
var INBOX_GUEST_AUTO_TAG_KEYS = ['hot_lead', 'warm_lead', 'rental', 'surf_school', 'needs_attention'];

function inboxGuestCrmTagKeys() {
  if (typeof CUSTOMER_CRM_TAG_KEYS !== 'undefined' && CUSTOMER_CRM_TAG_KEYS && CUSTOMER_CRM_TAG_KEYS.length) {
    return CUSTOMER_CRM_TAG_KEYS;
  }
  return INBOX_GUEST_CRM_TAG_KEYS;
}

function inboxGuestAutoTagKeys() {
  if (typeof CUSTOMER_AUTO_TAG_KEYS !== 'undefined' && CUSTOMER_AUTO_TAG_KEYS && CUSTOMER_AUTO_TAG_KEYS.length) {
    return CUSTOMER_AUTO_TAG_KEYS;
  }
  return INBOX_GUEST_AUTO_TAG_KEYS;
}

function inboxGuestTagIsAuto(key, identity) {
  if (typeof customerTagIsAuto === 'function') return customerTagIsAuto(key, identity);
  var auto = (identity && identity.auto_tags) || {};
  return !!auto[key];
}

function inboxGuestTagChip(key, identity) {
  if (typeof customerTagChipHtml === 'function') {
    return customerTagChipHtml(key, { auto: inboxGuestTagIsAuto(key, identity), compact: true });
  }
  return '<span class="customers-badge customers-badge-tag">' + inboxContextEsc(inboxContextTagLabel(key)) + '</span>';
}

function inboxCustomerGuestTagsHtml(data) {
  var id = (data && data.identity) || {};
  var crm = id.crm_tags || {};
  var display = id.display_tags || [];
  var keys = inboxGuestCrmTagKeys();
  var autoKeys = inboxGuestAutoTagKeys();
  var html = '<div class="inbox-guest-tags" id="inbox-guest-tags">';
  html += '<span class="inbox-guest-tags-label">' +
    inboxContextEsc(inboxContextT('customers.detail.addTags', 'Add Tags:')) + '</span>';
  html += '<button type="button" class="inbox-guest-tags-open" id="inbox-guest-tags-open" aria-label="' +
    inboxContextEsc(inboxContextT('customers.detail.addTags', 'Add Tags:')) + '">';
  if (display.length) {
    for (var d = 0; d < display.length; d++) html += inboxGuestTagChip(display[d], id);
  }
  html += '<span class="inbox-guest-tags-add" aria-hidden="true">+</span>';
  html += '</button>';
  html += '<div class="inbox-guest-tags-edit" id="inbox-guest-tags-edit" hidden>';
  html += '<div class="inbox-guest-tags-row">';
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var isAuto = inboxGuestTagIsAuto(key, id);
    if (isAuto) {
      html += '<span class="inbox-guest-tags-toggle is-auto is-on" title="' +
        inboxContextEsc(inboxContextT('customers.tags.autoTitle', 'Set automatically from bookings or services')) + '">' +
        inboxContextEsc(inboxContextTagLabel(key)) + '</span>';
      continue;
    }
    var on = !!crm[key];
    html += '<label class="inbox-guest-tags-toggle' + (on ? ' is-on' : '') + '">';
    html += '<input type="checkbox" data-inbox-guest-tag="' + inboxContextEsc(key) + '"' + (on ? ' checked' : '') + '>';
    html += inboxContextEsc(inboxContextTagLabel(key));
    html += '</label>';
  }
  for (var a = 0; a < autoKeys.length; a++) {
    var autoKey = autoKeys[a];
    if (keys.indexOf(autoKey) >= 0) continue;
    if (!inboxGuestTagIsAuto(autoKey, id) && display.indexOf(autoKey) < 0) continue;
    html += '<span class="inbox-guest-tags-toggle is-auto is-on" title="' +
      inboxContextEsc(inboxContextT('customers.tags.autoTitle', 'Set automatically from bookings or services')) + '">' +
      inboxContextEsc(inboxContextTagLabel(autoKey)) + '</span>';
  }
  html += '</div>';
  html += '<button type="button" class="btn btn-primary inbox-guest-tags-save" id="inbox-guest-tags-save">' +
    inboxContextEsc(inboxContextT('customers.tags.save', 'Save tags')) + '</button>';
  html += '</div></div>';
  return html;
}

function inboxCustomerFullHtml(data, opts) {
  opts = opts || {};
  var id = (data && data.identity) || {};
  var cacheRow = inboxClientInfoCacheRow(data && data.phone);
  var name = id.display_name || (cacheRow && cacheRow.display_name) || (data && data.phone) || 'Guest';
  var phone = (data && data.phone) || '';
  var email = id.email || (cacheRow && cacheRow.email) || '';
  var language = id.language || (cacheRow && cacheRow.language) || '';
  var notes = '';
  if (data && data.notes) notes = data.notes.internal_staff_notes || data.notes.notes || '';
  if (!notes && opts.conv && opts.conv.internal_staff_notes) notes = opts.conv.internal_staff_notes;
  var lastSetup = (data && data.last_setup_summary) || '';
  var school = '';
  try {
    if (typeof isSunsetSurfActive === 'function' && isSunsetSurfActive() && typeof getSunsetLocationLabel === 'function') {
      school = getSunsetLocationLabel() || '';
    }
  } catch (_e) { school = ''; }
  var bookings = inboxCustomerResolveBookings(data, opts.composite);
  var dataForBookings = (bookings.length && (!(data && data.bookings) || data.bookings.length !== bookings.length))
    ? Object.assign({}, data, { bookings: bookings })
    : data;
  var html = '<div class="inbox-customer-card is-full" id="inbox-customer-card">';
  html += '<div class="customers-profile-summary">';
  html += '<div class="customers-profile-summary-hdr">';
  html += '<div class="customers-profile-avatar" aria-hidden="true">' + inboxContextEsc(inboxClientInfoInitials(name)) + '</div>';
  html += '<div class="customers-profile-identity">';
  html += '<h3 class="customers-profile-name">' + inboxContextEsc(name) + '</h3>';
  html += '</div>';
  html += '<div class="customers-profile-hdr-actions">';
  html += '<button type="button" class="btn btn-ghost" id="inbox-create-booking-for-guest">' +
    inboxContextEsc(inboxContextT('customers.detail.createBooking', 'Create booking')) + '</button>';
  html += '</div></div>';
  html += '<div class="customers-profile-fields">';
  html += inboxCustomerInlineFieldHtml('phone', inboxContextEsc(inboxContextT('customers.detail.phone', 'Phone')), phone, '—', false);
  html += inboxCustomerInlineFieldHtml('email', inboxContextEsc(inboxContextT('customers.detail.email', 'Email')), email, '—', false);
  if (school) html += inboxCustomerField(inboxContextT('customers.detail.school', 'Active school'), school, false);
  html += inboxCustomerInlineFieldHtml('language', inboxContextEsc(inboxContextT('customers.detail.language', 'Language')), language, '—', false);
  html += inboxCustomerField(inboxContextT('customers.card.lastSetup', 'Last setup'), lastSetup || inboxContextT('customers.detail.noServices', 'No services yet'), !lastSetup);
  html += inboxCustomerNotesFieldHtml(notes);
  html += '</div></div>';

  html += inboxCustomerGuestTagsHtml(dataForBookings);
  html += inboxCustomerGuestBookingsHtml(dataForBookings);

  function collapse(title, count, body) {
    if (typeof renderCollapsibleCustomerSection === 'function') {
      return renderCollapsibleCustomerSection({ title: title, count: count, body: body });
    }
    return '<details class="customers-collapsible"><summary>' + inboxContextEsc(title) +
      ' <span>' + inboxContextEsc(String(count)) + '</span></summary>' + body + '</details>';
  }

  var services = (data && data.service_records) || [];
  var svcBody = '';
  if (services.length) {
    svcBody = '<table class="customers-row-table"><thead><tr><th>Date</th><th>Service</th><th>Qty</th><th>Status</th></tr></thead><tbody>';
    for (var si = 0; si < services.length; si++) {
      var r = services[si];
      svcBody += '<tr><td>' + inboxContextEsc(String(r.service_date || '—')) + '</td><td>' +
        inboxContextEsc(String(r.service_type || '—').replace(/_/g, ' ')) + '</td><td>' +
        inboxContextEsc(String(r.quantity != null ? r.quantity : '—')) + '</td><td>' +
        inboxContextEsc(String(r.service_status || '—')) + '</td></tr>';
    }
    svcBody += '</tbody></table>';
  } else {
    svcBody = '<div class="customers-section-empty">' + inboxContextEsc(inboxContextT('customers.detail.noServices', 'No services yet')) + '</div>';
  }
  html += collapse(inboxContextT('customers.detail.services', 'Previous lessons and rentals'), services.length, svcBody);

  if (typeof renderCustomerWaiverFormsSection === 'function') {
    html += renderCustomerWaiverFormsSection(data);
  }
  html += '</div>';
  return html;
}

function inboxCustomerUnmatchedHtml(conv) {
  conv = conv || {};
  var name = (typeof inboxPersonDisplayName === 'function')
    ? inboxPersonDisplayName(conv)
    : (conv.guest_email || conv.email || 'Guest');
  var email = (typeof inboxGuestEmailOf === 'function')
    ? inboxGuestEmailOf(conv)
    : (conv.email || conv.guest_email || '');
  var html = '<div class="inbox-customer-card" id="inbox-customer-card" data-inbox-guest="unmatched"';
  if (conv.conversation_id) html += ' data-conversation-id="' + inboxContextEsc(conv.conversation_id) + '"';
  if (email) html += ' data-guest-email="' + inboxContextEsc(email) + '"';
  if (name) html += ' data-guest-name="' + inboxContextEsc(name) + '"';
  html += '>';
  html += '<div class="inbox-customer-head">';
  html += '<div class="inbox-client-info-avatar" aria-hidden="true">' + inboxContextEsc(inboxClientInfoInitials(name)) + '</div>';
  html += '<div class="inbox-client-info-id">';
  html += '<div class="inbox-client-info-name">' + inboxContextEsc(name) + '</div>';
  html += '</div>';
  html += '</div>';
  html += '<div class="customers-section-empty" data-inbox-guest-unmatched="1">' +
    inboxContextEsc(inboxContextT('inbox.guest.noGuestYet', 'No guest yet')) + '</div>';
  if (email && email !== name) {
    html += inboxCustomerField(inboxContextT('customers.detail.email', 'Email'), email, false);
  }
  html += '<div class="inbox-guest-link" data-inbox-guest-link="1">';
  html += '<label class="customers-edit-field" for="inbox-guest-link-search"><span>' +
    inboxContextEsc(inboxContextT('inbox.guest.linkSearch', 'Find an existing guest')) + '</span></label>';
  html += '<input id="inbox-guest-link-search" class="inbox-guest-link-search" type="search" autocomplete="off" placeholder="' +
    inboxContextEsc(inboxContextT('customers.searchPlaceholder', 'Search by name, email, or phone')) + '">';
  html += '<div id="inbox-guest-link-results" class="inbox-guest-link-results" hidden></div>';
  html += '<div class="inbox-guest-link-actions">';
  html += '<button type="button" class="btn btn-primary" id="inbox-guest-link-create"' +
    (email ? '' : ' disabled') + '>' +
    inboxContextEsc(inboxContextT('inbox.guest.createFromEmail', 'Create guest from this email')) + '</button>';
  html += '</div>';
  html += '<p id="inbox-guest-link-msg" class="inbox-guest-link-msg" hidden></p>';
  html += '</div>';
  html += '</div>';
  return html;
}

function inboxCustomerPaint(sidebar, conv, composite, customer) {
  if (!sidebar) return;
  var bound = (typeof inboxCustomerHasBoundGuest === 'function')
    ? inboxCustomerHasBoundGuest(conv, customer)
    : !!(customer && customer.success !== false && customer.phone);
  if (!bound) {
    inboxContextLastConv = conv;
    inboxContextLastCustomer = null;
    sidebar.innerHTML = inboxCustomerUnmatchedHtml(conv);
    inboxContextWireActions(sidebar, { conversation: conv });
    return;
  }
  var data = inboxCustomerMerge(inboxCustomerFromConv(conv), customer || inboxContextLastCustomer);
  var resolvedBookings = inboxCustomerResolveBookings(data, composite);
  if (resolvedBookings.length) {
    data = Object.assign({}, data, { bookings: resolvedBookings });
  }
  inboxContextLastCustomer = data;
  inboxContextLastConv = conv;
  var full = inboxContextIsGuestMode() || inboxCustomerEditing;
  sidebar.innerHTML = full
    ? (inboxCustomerEditing
      ? inboxCustomerEditHtml(data, { composite: composite, conv: conv })
      : inboxCustomerFullHtml(data, { composite: composite, conv: conv }))
    : inboxCustomerCondensedHtml(data, { composite: composite });
  inboxContextWireActions(sidebar, { conversation: conv });
  inboxCustomerWireFull(sidebar, data);
}

var inboxCustomerEditing = false;

function inboxCustomerFormRoot() {
  if (typeof inboxChatGuestIsShowing === 'function' && inboxChatGuestIsShowing()) {
    var host = typeof document !== 'undefined' ? document.getElementById('inbox-chat-guest-host') : null;
    if (host) return host;
  }
  return inboxContextSidebarEl();
}

function inboxCustomerStartEdit() {
  inboxCustomerEditing = true;
  if (typeof inboxChatGuestIsShowing === 'function' && inboxChatGuestIsShowing()) {
    if (typeof inboxChatPaintGuest === 'function') inboxChatPaintGuest();
    return;
  }
  if (typeof inboxColumnsSetPreset === 'function' && !inboxContextIsGuestMode()) {
    inboxColumnsSetPreset('guest');
  }
  var sidebar = inboxContextSidebarEl();
  if (sidebar) inboxCustomerPaint(sidebar, inboxContextLastConv, inboxContextLastComposite, inboxContextLastCustomer);
}

function inboxCustomerCancelEdit() {
  inboxCustomerEditing = false;
  if (typeof inboxChatGuestIsShowing === 'function' && inboxChatGuestIsShowing() && typeof inboxChatPaintGuest === 'function') {
    inboxChatPaintGuest();
    return;
  }
  var sidebar = inboxContextSidebarEl();
  if (sidebar) inboxCustomerPaint(sidebar, inboxContextLastConv, inboxContextLastComposite, inboxContextLastCustomer);
}

function inboxCustomerEditHtml(data, opts) {
  opts = opts || {};
  var id = (data && data.identity) || {};
  var cacheRow = inboxClientInfoCacheRow(data && data.phone);
  var name = id.display_name || (cacheRow && cacheRow.display_name) || '';
  var phone = (data && data.phone) || '';
  var email = id.email || (cacheRow && cacheRow.email) || '';
  var language = id.language || (cacheRow && cacheRow.language) || '';
  var notes = '';
  if (data && data.notes) notes = data.notes.internal_staff_notes || data.notes.notes || '';
  if (!notes && opts.conv && opts.conv.internal_staff_notes) notes = opts.conv.internal_staff_notes;
  var html = '<div class="inbox-customer-card is-full is-editing" id="inbox-customer-card">';
  html += '<div class="customers-section-hdr">' + inboxContextEsc(inboxContextT('customers.editProfile', 'Edit profile')) + '</div>';
  html += '<div class="customers-section-body customers-profile-edit-form">';
  html += '<label class="customers-edit-field"><span>' + inboxContextEsc(inboxContextT('customers.detail.name', 'Name')) + '</span>';
  html += '<input id="inbox-cust-edit-name" type="text" value="' + inboxContextEsc(name) + '"></label>';
  html += '<label class="customers-edit-field"><span>' + inboxContextEsc(inboxContextT('customers.detail.phone', 'Phone')) + '</span>';
  html += '<input id="inbox-cust-edit-phone" type="tel" value="' + inboxContextEsc(phone) + '"></label>';
  html += '<label class="customers-edit-field"><span>' + inboxContextEsc(inboxContextT('customers.detail.email', 'Email')) + '</span>';
  html += '<input id="inbox-cust-edit-email" type="email" value="' + inboxContextEsc(email) + '"></label>';
  html += '<label class="customers-edit-field"><span>' + inboxContextEsc(inboxContextT('customers.detail.language', 'Language')) + '</span>';
  html += '<input id="inbox-cust-edit-language" type="text" value="' + inboxContextEsc(language) + '" placeholder="en, es, …"></label>';
  html += '<label class="customers-edit-field"><span>' + inboxContextEsc(inboxContextT('customers.detail.notes', 'Notes for next time')) + '</span>';
  html += '<textarea id="inbox-cust-edit-notes" rows="4">' + inboxContextEsc(notes) + '</textarea></label>';
  html += '</div>';
  html += '<div class="customers-profile-actions inbox-customer-edit-actions">';
  html += '<button type="button" class="btn btn-primary" id="inbox-cust-edit-save">' + inboxContextEsc(inboxContextT('customers.save', 'Save')) + '</button>';
  html += '<button type="button" class="btn btn-ghost" id="inbox-cust-edit-cancel">' + inboxContextEsc(inboxContextT('customers.cancel', 'Cancel')) + '</button>';
  html += '</div>';
  html += '<p id="inbox-cust-edit-msg" class="state-msg" style="display:none;margin-top:8px"></p>';
  html += '</div>';
  return html;
}

function inboxCustomerSaveEdit(data) {
  var sidebar = inboxCustomerFormRoot();
  var msg = sidebar && sidebar.querySelector('#inbox-cust-edit-msg');
  var saveBtn = sidebar && sidebar.querySelector('#inbox-cust-edit-save');
  var nameEl = sidebar && sidebar.querySelector('#inbox-cust-edit-name');
  var phoneEl = sidebar && sidebar.querySelector('#inbox-cust-edit-phone');
  var emailEl = sidebar && sidebar.querySelector('#inbox-cust-edit-email');
  var langEl = sidebar && sidebar.querySelector('#inbox-cust-edit-language');
  var notesEl = sidebar && sidebar.querySelector('#inbox-cust-edit-notes');
  var payload = {
    display_name: nameEl ? String(nameEl.value || '').trim() : '',
    phone: phoneEl ? String(phoneEl.value || '').trim() : '',
    email: emailEl ? String(emailEl.value || '').trim() : '',
    language: langEl ? String(langEl.value || '').trim() : '',
    notes: notesEl ? String(notesEl.value || '').trim() : '',
  };
  if (!payload.display_name || !payload.phone) {
    if (msg) { msg.className = 'state-msg error'; msg.textContent = inboxContextT('customers.saveRequired', 'Name and phone are required.'); msg.style.display = 'block'; }
    return;
  }
  var currentPhone = (data && data.phone) || payload.phone;
  if (saveBtn) saveBtn.disabled = true;
  if (msg) msg.style.display = 'none';
  var url = '/staff/customers/' + encodeURIComponent(currentPhone) + '?client=' + encodeURIComponent(typeof getClient === 'function' ? getClient() : '');
  fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(function(r) {
    return r.json().then(function(body) { return { ok: r.ok, body: body }; });
  }).then(function(res) {
    if (!res.ok || !res.body || res.body.success !== true) {
      throw new Error((res.body && (res.body.error || res.body.message)) || 'Save failed');
    }
    inboxCustomerEditing = false;
    if (inboxContextLastCustomer && inboxContextLastCustomer.identity) {
      inboxContextLastCustomer.identity.display_name = payload.display_name;
      inboxContextLastCustomer.identity.email = payload.email;
      inboxContextLastCustomer.identity.language = payload.language;
    }
    if (inboxContextLastCustomer) inboxContextLastCustomer.phone = res.body.phone || payload.phone;
    if (inboxContextLastCustomer && inboxContextLastCustomer.notes) {
      inboxContextLastCustomer.notes.internal_staff_notes = payload.notes;
    }
    var sidebarNow = inboxCustomerFormRoot();
    if (typeof inboxChatGuestIsShowing === 'function' && inboxChatGuestIsShowing() && typeof inboxChatPaintGuest === 'function') {
      inboxChatPaintGuest();
    } else if (sidebarNow) inboxCustomerLoad(sidebarNow, inboxContextLastConv, inboxContextLastComposite);
  }).catch(function(err) {
    if (msg) { msg.className = 'state-msg error'; msg.textContent = inboxContextT('customers.saveFailed', 'Could not save.') + ' ' + (err.message || ''); msg.style.display = 'block'; }
  }).finally(function() {
    if (saveBtn) saveBtn.disabled = false;
  });
}

function inboxOpenBookingDrawerHere(booking) {
  booking = booking || {};
  var drawerFn = (typeof window !== 'undefined' && typeof window.openScheduleDetailDrawer === 'function')
    ? window.openScheduleDetailDrawer
    : (typeof openScheduleDetailDrawer === 'function' ? openScheduleDetailDrawer : null);
  if (!drawerFn) return false;
  inboxEnsureScheduleDrawerOnBody();
  var start = booking.service_date_start || booking.service_date || booking.check_in || '';
  drawerFn({
    booking_id: booking.booking_id || null,
    booking_code: booking.booking_code || null,
    guest_name: booking.guest_name || booking.booking_guest_name || '',
    service_date: start ? String(start).slice(0, 10) : null,
    check_in: booking.check_in || null,
    check_out: booking.check_out || null,
    _drawerFromCustomer: true,
  });
  return true;
}

function inboxEnsureScheduleDrawerOnBody() {
  if (typeof document === 'undefined' || !document.body) return;
  var drawer = typeof el === 'function' ? el('ps-detail-drawer') : document.getElementById('ps-detail-drawer');
  var backdrop = typeof el === 'function' ? el('ps-drawer-backdrop') : document.getElementById('ps-drawer-backdrop');
  if (backdrop && backdrop.parentNode !== document.body) document.body.appendChild(backdrop);
  if (drawer && drawer.parentNode !== document.body) document.body.appendChild(drawer);
}

function inboxCustomerEnsureBookingDelegate() {
  if (typeof document === 'undefined' || document.documentElement.dataset.inboxBookingDelegate === '1') return;
  document.documentElement.dataset.inboxBookingDelegate = '1';
  document.addEventListener('click', function(ev) {
    var btn = ev.target && ev.target.closest && ev.target.closest('[data-inbox-open-booking]');
    if (!btn) return;
    if (ev.preventDefault) ev.preventDefault();
    inboxOpenBookingDrawerHere({
      booking_id: btn.getAttribute('data-booking-id'),
      booking_code: btn.getAttribute('data-booking-code'),
      check_in: btn.getAttribute('data-check-in'),
      check_out: btn.getAttribute('data-check-out'),
      guest_name: btn.getAttribute('data-guest-name'),
    });
  });
}

function inboxCustomerWireNotes(root) {
  inboxCustomerWireInlineFields(root);
}

function inboxCustomerWireInlineFields(root) {
  if (!root || !root.querySelectorAll) return;
  var fields = root.querySelectorAll('.inbox-guest-inline');
  for (var i = 0; i < fields.length; i++) {
    inboxCustomerWireOneInline(fields[i]);
  }
}

function inboxCustomerWireOneInline(field) {
  if (!field || field.dataset.inboxCustomerWired === '1') return;
  field.dataset.inboxCustomerWired = '1';
  var title = field.querySelector('.inbox-guest-inline-title');
  var display = field.querySelector('.inbox-guest-inline-display');
  var edit = field.querySelector('.inbox-guest-inline-edit');
  var save = field.querySelector('.inbox-guest-inline-save');
  var input = edit && (edit.querySelector('textarea') || edit.querySelector('input'));
  if (title) {
    title.addEventListener('click', function() {
      if (display) display.hidden = true;
      if (edit) edit.hidden = false;
      if (input) input.focus();
    });
  }
  if (save) {
    save.addEventListener('click', function() {
      inboxCustomerSaveInline(field.getAttribute('data-inbox-inline'), input ? input.value : '', field.closest('.inbox-customer-card') || field.parentNode);
    });
  }
}

function inboxCustomerSaveInline(key, value, root) {
  if (key === 'notes') return inboxCustomerSaveNotes(value, root);
  var data = inboxContextLastCustomer || {};
  var id = data.identity || {};
  var phone = data.phone || '';
  if (!phone) return;
  var next = String(value || '').trim();
  var payload = {
    display_name: id.display_name || '',
    phone: key === 'phone' ? next : phone,
    email: key === 'email' ? next : (id.email || ''),
    language: key === 'language' ? next : (id.language || ''),
    notes: ((data.notes && (data.notes.internal_staff_notes || data.notes.notes)) || ''),
  };
  var field = root && root.querySelector('.inbox-guest-inline[data-inbox-inline="' + key + '"]');
  var saveBtn = field && field.querySelector('.inbox-guest-inline-save');
  if (saveBtn) saveBtn.disabled = true;
  var url = '/staff/customers/' + encodeURIComponent(phone) + '?client=' + encodeURIComponent(typeof getClient === 'function' ? getClient() : '');
  fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(function(r) {
    return r.json().then(function(body) { return { ok: r.ok, body: body }; });
  }).then(function(res) {
    if (!res.ok || !res.body || res.body.success !== true) {
      throw new Error((res.body && (res.body.error || res.body.message)) || 'Save failed');
    }
    if (!inboxContextLastCustomer) inboxContextLastCustomer = data;
    if (!inboxContextLastCustomer.identity) inboxContextLastCustomer.identity = id;
    if (key === 'phone') inboxContextLastCustomer.phone = payload.phone;
    if (key === 'email') inboxContextLastCustomer.identity.email = payload.email;
    if (key === 'language') inboxContextLastCustomer.identity.language = payload.language;
    if (field) {
      var display = field.querySelector('.inbox-guest-inline-display');
      var edit = field.querySelector('.inbox-guest-inline-edit');
      var empty = !next;
      if (display) {
        display.textContent = empty ? '—' : next;
        display.classList.toggle('is-empty', empty);
        display.hidden = false;
      }
      if (edit) edit.hidden = true;
    }
  }).catch(function() {
    /* leave the box open so staff can retry */
  }).finally(function() {
    if (saveBtn) saveBtn.disabled = false;
  });
}

function inboxCustomerSaveNotes(notes, root) {
  var data = inboxContextLastCustomer || {};
  var id = data.identity || {};
  var phone = data.phone || '';
  if (!phone) return;
  var payload = {
    display_name: id.display_name || '',
    phone: phone,
    email: id.email || '',
    language: id.language || '',
    notes: String(notes || '').trim(),
  };
  var saveBtn = root && root.querySelector('#inbox-guest-notes-save');
  if (saveBtn) saveBtn.disabled = true;
  var url = '/staff/customers/' + encodeURIComponent(phone) + '?client=' + encodeURIComponent(typeof getClient === 'function' ? getClient() : '');
  fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(function(r) {
    return r.json().then(function(body) { return { ok: r.ok, body: body }; });
  }).then(function(res) {
    if (!res.ok || !res.body || res.body.success !== true) {
      throw new Error((res.body && (res.body.error || res.body.message)) || 'Save failed');
    }
    if (!inboxContextLastCustomer) inboxContextLastCustomer = data;
    inboxContextLastCustomer.notes = inboxContextLastCustomer.notes || {};
    inboxContextLastCustomer.notes.internal_staff_notes = payload.notes;
    if (inboxContextLastCustomer.identity) inboxContextLastCustomer.identity.display_name = payload.display_name;
    var display = root && root.querySelector('#inbox-guest-notes-text-display');
    var edit = root && root.querySelector('#inbox-guest-notes-edit');
    if (display) {
      var empty = !payload.notes;
      display.textContent = empty ? inboxContextT('customers.detail.noNotes', 'No notes yet') : payload.notes;
      display.classList.toggle('is-empty', empty);
      display.hidden = false;
    }
    if (edit) edit.hidden = true;
  }).catch(function() {
    /* leave the box open so staff can retry */
  }).finally(function() {
    if (saveBtn) saveBtn.disabled = false;
  });
}

function inboxCustomerWireTags(root) {
  if (!root || !root.querySelector) return;
  var open = root.querySelector('#inbox-guest-tags-open');
  var edit = root.querySelector('#inbox-guest-tags-edit');
  var save = root.querySelector('#inbox-guest-tags-save');
  if (open && open.dataset.inboxCustomerWired !== '1') {
    open.dataset.inboxCustomerWired = '1';
    open.addEventListener('click', function() {
      open.hidden = true;
      if (edit) edit.hidden = false;
    });
  }
  var boxes = root.querySelectorAll('input[data-inbox-guest-tag]');
  for (var i = 0; i < boxes.length; i++) {
    if (boxes[i].dataset.inboxCustomerWired === '1') continue;
    boxes[i].dataset.inboxCustomerWired = '1';
    boxes[i].addEventListener('change', function(ev) {
      var label = ev.target && ev.target.closest ? ev.target.closest('.inbox-guest-tags-toggle') : null;
      if (label) label.classList.toggle('is-on', !!ev.target.checked);
    });
  }
  if (save && save.dataset.inboxCustomerWired !== '1') {
    save.dataset.inboxCustomerWired = '1';
    save.addEventListener('click', function() { inboxCustomerSaveTags(root); });
  }
}

function inboxCustomerApplySavedTags(root, tags) {
  var data = inboxContextLastCustomer || {};
  if (!data.identity) data.identity = {};
  data.identity.crm_tags = tags || {};
  if (typeof refreshCustomerDisplayTags === 'function') {
    refreshCustomerDisplayTags(data.identity);
  } else {
    var display = [];
    var order = inboxGuestCrmTagKeys().concat(inboxGuestAutoTagKeys());
    var seen = {};
    for (var i = 0; i < order.length; i++) {
      var key = order[i];
      if (seen[key]) continue;
      seen[key] = true;
      if (data.identity.crm_tags[key] || (data.identity.auto_tags && data.identity.auto_tags[key])) display.push(key);
    }
    data.identity.display_tags = display;
  }
  inboxContextLastCustomer = data;
  var host = root && root.querySelector('#inbox-guest-tags');
  if (host) {
    var wrap = document.createElement('div');
    wrap.innerHTML = inboxCustomerGuestTagsHtml(data);
    var next = wrap.firstChild;
    if (next) host.replaceWith(next);
    inboxCustomerWireTags(root);
  }
}

function inboxCustomerSaveTags(root) {
  var data = inboxContextLastCustomer || {};
  var phone = data.phone || '';
  if (!phone) return;
  var tags = {};
  var keys = inboxGuestCrmTagKeys();
  for (var i = 0; i < keys.length; i++) {
    var box = root && root.querySelector('input[data-inbox-guest-tag="' + keys[i] + '"]');
    if (box) tags[keys[i]] = !!box.checked;
    else tags[keys[i]] = !!(data.identity && data.identity.crm_tags && data.identity.crm_tags[keys[i]]);
  }
  var saveBtn = root && root.querySelector('#inbox-guest-tags-save');
  if (saveBtn) saveBtn.disabled = true;
  var url = '/staff/customers/' + encodeURIComponent(phone) + '/tags?client=' + encodeURIComponent(typeof getClient === 'function' ? getClient() : '');
  fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: tags }),
  }).then(function(r) {
    return r.json().then(function(body) { return { ok: r.ok, body: body }; });
  }).then(function(res) {
    if (!res.ok || !res.body || res.body.success !== true) {
      throw new Error((res.body && (res.body.error || res.body.message)) || 'Save failed');
    }
    inboxCustomerApplySavedTags(root, res.body.crm_tags || tags);
  }).catch(function() {
    /* leave the picker open so staff can retry */
  }).finally(function() {
    if (saveBtn) saveBtn.disabled = false;
  });
}

function inboxCustomerWireFull(sidebar, data) {
  var edit = sidebar && sidebar.querySelector('#inbox-customer-edit-profile');
  if (edit && edit.dataset.inboxCustomerWired !== '1') {
    edit.dataset.inboxCustomerWired = '1';
    edit.addEventListener('click', function() {
      inboxCustomerStartEdit();
    });
  }
  inboxCustomerWireNotes(sidebar);
  inboxCustomerWireTags(sidebar);
  var save = sidebar && sidebar.querySelector('#inbox-cust-edit-save');
  if (save && save.dataset.inboxCustomerWired !== '1') {
    save.dataset.inboxCustomerWired = '1';
    save.addEventListener('click', function() { inboxCustomerSaveEdit(data); });
  }
  var cancel = sidebar && sidebar.querySelector('#inbox-cust-edit-cancel');
  if (cancel && cancel.dataset.inboxCustomerWired !== '1') {
    cancel.dataset.inboxCustomerWired = '1';
    cancel.addEventListener('click', function() { inboxCustomerCancelEdit(); });
  }
  if (!sidebar || !sidebar.querySelectorAll) return;
  var links = sidebar.querySelectorAll('[data-inbox-open-booking]');
  for (var i = 0; i < links.length; i++) {
    (function(btn) {
      if (btn.dataset.inboxCustomerWired === '1') return;
      btn.dataset.inboxCustomerWired = '1';
      btn.addEventListener('click', function(ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        if (ev && ev.stopPropagation) ev.stopPropagation();
        inboxOpenBookingDrawerHere({
          booking_id: btn.getAttribute('data-booking-id'),
          booking_code: btn.getAttribute('data-booking-code'),
          check_in: btn.getAttribute('data-check-in'),
          check_out: btn.getAttribute('data-check-out'),
          guest_name: btn.getAttribute('data-guest-name'),
        });
      });
    })(links[i]);
  }
}

function inboxCustomerSyncDensity() {
  var sidebar = inboxContextSidebarEl();
  if (!sidebar || !inboxContextLastConv) return;
  var wantFull = inboxContextIsGuestMode();
  var card = sidebar.querySelector('#inbox-customer-card');
  if (card && card.classList.contains('is-full') === wantFull) return;
  inboxCustomerPaint(sidebar, inboxContextLastConv, inboxContextLastComposite, inboxContextLastCustomer);
}

function inboxContextWrapColumnsApply() {
  if (typeof inboxColumnsApply !== 'function' || inboxColumnsApply._inboxCustomerWrapped) return;
  var legacy = inboxColumnsApply;
  function wrapped() {
    var out = legacy.apply(this, arguments);
    if (typeof inboxIsChatPreset === 'function' && typeof inboxChatHideGuest === 'function' && !inboxIsChatPreset()) {
      inboxChatHideGuest();
    }
    inboxCustomerSyncDensity();
    return out;
  }
  wrapped._inboxCustomerWrapped = true;
  inboxColumnsApply = wrapped;
}

function inboxClientInfoRemove(sidebar) {
  if (!sidebar || !sidebar.querySelector) return;
  var old = sidebar.querySelector('#inbox-client-info');
  if (old && old.parentNode) old.parentNode.removeChild(old);
}

function inboxClientInfoWire(sidebar, phone) {
  var btn = sidebar && sidebar.querySelector('#inbox-client-info-open');
  if (!btn || btn.dataset.inboxClientInfoWired === '1') return;
  btn.dataset.inboxClientInfoWired = '1';
  btn.addEventListener('click', function() {
    if (typeof openCustomerCardForPhone === 'function' && phone) openCustomerCardForPhone(phone);
  });
}

var inboxClientInfoFetchGen = 0;
var inboxContextLastCustomer = null;
var inboxContextLastConv = null;

function inboxClientInfoMount(sidebar, conv, composite) {
  inboxCustomerLoad(sidebar, conv, composite);
}

function inboxCustomerResolvePhone(conv, customer) {
  conv = conv || {};
  var linked = String(conv.customer_phone || '').trim();
  if (linked && typeof inboxIsOpaqueEmailIdentity === 'function' && inboxIsOpaqueEmailIdentity(linked)) {
    linked = '';
  }
  if (linked && typeof inboxIsEmailcustIdentity === 'function' && inboxIsEmailcustIdentity(linked)) {
    linked = '';
  }
  if (linked && typeof normalizeCustomerPhoneClient === 'function') {
    var normalizedLinked = normalizeCustomerPhoneClient(linked);
    if (normalizedLinked) return normalizedLinked;
  } else if (linked) {
    return linked;
  }
  var phone = (typeof inboxBoundCustomerPhone === 'function')
    ? inboxBoundCustomerPhone(conv, customer)
    : (conv.phone || conv.guest_phone || '');
  if (phone && typeof normalizeCustomerPhoneClient === 'function' &&
      (typeof inboxIsOpaqueEmailIdentity !== 'function' || !inboxIsOpaqueEmailIdentity(phone)) &&
      (typeof inboxIsEmailcustIdentity !== 'function' || !inboxIsEmailcustIdentity(phone))) {
    phone = normalizeCustomerPhoneClient(phone);
  }
  if (typeof inboxIsOpaqueEmailIdentity === 'function' && inboxIsOpaqueEmailIdentity(phone)) phone = '';
  if (typeof inboxIsEmailcustIdentity === 'function' && inboxIsEmailcustIdentity(phone)) phone = '';
  return phone || '';
}

function inboxCustomerLoad(sidebar, conv, composite) {
  if (!sidebar) return;
  var phone = inboxCustomerResolvePhone(conv, inboxContextLastCustomer);
  if (inboxContextLastCustomer && phone && inboxContextLastCustomer.phone
      && String(inboxContextLastCustomer.phone) !== String(phone)) {
    inboxContextLastCustomer = null;
  }
  if (!phone && (typeof inboxCustomerHasBoundGuest !== 'function' || !inboxCustomerHasBoundGuest(conv, inboxContextLastCustomer))) {
    inboxCustomerPaint(sidebar, conv, composite, null);
    return;
  }
  if (!phone && conv && conv.customer_id) {
    // Bound by customer_id but phone not yet on the row — keep unmatched false via paint.
    inboxCustomerPaint(sidebar, conv, composite, inboxContextLastCustomer || {
      success: true,
      customer_id: conv.customer_id,
      phone: '',
      identity: {
        display_name: (typeof inboxPersonDisplayName === 'function') ? inboxPersonDisplayName(conv) : (conv.guest_name || ''),
        email: conv.email || conv.guest_email || '',
        language: conv.language || '',
      },
    });
    return;
  }
  inboxCustomerPaint(sidebar, conv, composite, inboxContextLastCustomer);
  if (!phone) return;
  var gen = ++inboxClientInfoFetchGen;
  var url = '/staff/customers/' + encodeURIComponent(phone) + '/context?client=' +
    encodeURIComponent(typeof getClient === 'function' ? getClient() : '');
  try {
    if (typeof getClient === 'function' && getClient() === 'sunset' && typeof getSunsetLocation === 'function') {
      url += '&location=' + encodeURIComponent(getSunsetLocation());
    }
  } catch (_e) { /* ignore */ }
  fetch(url, { headers: { Accept: 'application/json' } })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (gen !== inboxClientInfoFetchGen) return;
      if (!data || data.success === false) return;
      if (!data.phone) data.phone = phone;
      if (conv && conv.customer_id && !data.customer_id) data.customer_id = conv.customer_id;
      inboxContextLastCustomer = data;
      inboxCustomerPaint(sidebar, conv, composite, data);
    })
    .catch(function() { /* keep condensed fallback */ });
}

function inboxContextEnsureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(INBOX_CONTEXT_STYLE_ID)) return;
  var style = document.createElement('style');
  style.id = INBOX_CONTEXT_STYLE_ID;
  style.textContent = INBOX_CONTEXT_CSS;
  var head = document.head || document.getElementsByTagName('head')[0];
  if (head) head.appendChild(style);
}

function inboxContextInstallFetchHook() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function' || inboxContextRuntime.fetchHooked) return;
  var orig = window.fetch.bind(window);
  function hooked(url, init) {
    var p = orig.apply(this, arguments);
    var href = typeof url === 'string' ? url : (url && url.url) || '';
    if (!/\/staff\/inbox\/thread\//.test(String(href))) return p;
    var match = String(href).match(/\/staff\/inbox\/thread\/([^?\/]+)/);
    var convId = match ? decodeURIComponent(match[1]) : null;
    var selectionGeneration = typeof inboxSelectionGeneration !== 'undefined' ? inboxSelectionGeneration : null;
    return p.then(function(res) {
      return res.clone().json().then(function(body) {
        if (!convId || typeof inboxSelectionIsCurrent !== 'function' ||
            !inboxSelectionIsCurrent(convId, selectionGeneration)) return res;
        inboxContextLastComposite = body;
        return res;
      }, function() { return res; });
    });
  }
  hooked._inboxContextHooked = true;
  inboxContextRuntime.fetchHooked = true;
  window.fetch = hooked;
}

function inboxContextFill(targetEl) {
  var sidebar = inboxContextSidebarEl(targetEl);
  if (!sidebar) return false;
  var composite = inboxContextLastComposite;
  if (!composite || composite.success === false) return false;
  var model = inboxContextModelFromComposite(composite);
  var conv = model.conversation || {};
  if (typeof selectedConvId !== 'undefined' && selectedConvId && conv.conversation_id &&
      String(conv.conversation_id) !== String(selectedConvId)) {
    return false;
  }
  inboxContextEnsureStyles();
  inboxCustomerLoad(sidebar, conv, composite);
  return true;
}

function inboxGuestLinkClientQuery() {
  var q = '?client=' + encodeURIComponent(typeof getClient === 'function' ? getClient() : '');
  try {
    if (typeof getClient === 'function' && getClient() === 'sunset' && typeof getSunsetLocation === 'function') {
      q += '&location=' + encodeURIComponent(getSunsetLocation());
    }
  } catch (_e) { /* ignore */ }
  return q;
}

function inboxGuestLinkSetMsg(root, text, isError) {
  var msg = root && root.querySelector('#inbox-guest-link-msg');
  if (!msg) return;
  if (!text) {
    msg.hidden = true;
    msg.textContent = '';
    msg.classList.remove('is-error');
    return;
  }
  msg.hidden = false;
  msg.textContent = text;
  if (isError) msg.classList.add('is-error');
  else msg.classList.remove('is-error');
}

function inboxGuestLinkApplyResult(conv, body) {
  var nextConv = Object.assign({}, conv || {});
  if (body && body.customer_id) nextConv.customer_id = body.customer_id;
  if (body && body.phone) nextConv.customer_phone = body.phone;
  if (body && body.display_name && !nextConv.guest_name) nextConv.guest_name = body.display_name;
  if (body && body.email && !(nextConv.email || nextConv.guest_email)) {
    nextConv.email = body.email;
    nextConv.guest_email = body.email;
  }
  inboxContextLastConv = nextConv;
  if (inboxContextLastComposite && inboxContextLastComposite.detail) {
    inboxContextLastComposite.detail.conversation = Object.assign(
      {},
      inboxContextLastComposite.detail.conversation || {},
      {
        customer_id: nextConv.customer_id || null,
        customer_phone: nextConv.customer_phone || null,
      }
    );
  }
  var customer = {
    success: true,
    customer_id: body && body.customer_id,
    phone: body && body.phone,
    identity: {
      display_name: (body && body.display_name) || nextConv.guest_name || '',
      email: (body && body.email) || nextConv.email || nextConv.guest_email || '',
      language: nextConv.language || '',
    },
    bookings: [],
    service_records: [],
    messages: [],
    waivers: [],
  };
  inboxContextLastCustomer = customer;
  var sidebar = inboxContextSidebarEl();
  if (sidebar) inboxCustomerLoad(sidebar, nextConv, inboxContextLastComposite);
}

function inboxGuestLinkPostCustomer(payload) {
  return fetch('/staff/customers' + inboxGuestLinkClientQuery(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload || {}),
  }).then(function(r) {
    return r.json().then(function(body) {
      return { status: r.status, ok: r.ok, body: body || {} };
    }).catch(function() {
      return { status: r.status, ok: r.ok, body: {} };
    });
  });
}

function inboxGuestLinkRenderHits(root, customers, conv) {
  var box = root && root.querySelector('#inbox-guest-link-results');
  if (!box) return;
  box.innerHTML = '';
  var rows = Array.isArray(customers) ? customers : [];
  if (!rows.length) {
    box.hidden = false;
    box.innerHTML = '<div class="inbox-guest-link-empty">' +
      inboxContextEsc(inboxContextT('inbox.guest.linkNoMatches', 'No matching guests. Create one from this email.')) +
      '</div>';
    return;
  }
  box.hidden = false;
  for (var i = 0; i < rows.length; i++) {
    (function(row) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'inbox-guest-link-hit';
      btn.setAttribute('data-inbox-guest-link-phone', String(row.phone || ''));
      var name = row.display_name || row.phone || row.email || 'Guest';
      var meta = [];
      if (row.email) meta.push(row.email);
      if (row.phone && !(typeof inboxIsEmailcustIdentity === 'function' && inboxIsEmailcustIdentity(row.phone))) {
        meta.push(row.phone);
      }
      btn.innerHTML = '<span class="inbox-guest-link-hit-name">' + inboxContextEsc(name) + '</span>' +
        (meta.length ? '<span class="inbox-guest-link-hit-meta">' + inboxContextEsc(meta.join(' · ')) + '</span>' : '');
      btn.addEventListener('click', function() {
        inboxGuestLinkSetMsg(root, inboxContextT('inbox.guest.linking', 'Linking…'), false);
        inboxGuestLinkPostCustomer({
          phone: row.phone,
          display_name: row.display_name || name,
          email: row.email || null,
          conversation_id: conv && conv.conversation_id,
        }).then(function(res) {
          if (!res.ok || !res.body || res.body.success === false) {
            var err = (res.body && res.body.error) || inboxContextT('inbox.guest.linkFailed', 'Could not link guest.');
            if (res.status === 409) err = inboxContextT('inbox.guest.alreadyLinked', 'This conversation is already linked.');
            inboxGuestLinkSetMsg(root, err, true);
            return;
          }
          inboxGuestLinkApplyResult(conv, res.body);
        }).catch(function() {
          inboxGuestLinkSetMsg(root, inboxContextT('inbox.guest.linkFailed', 'Could not link guest.'), true);
        });
      });
      box.appendChild(btn);
    })(rows[i]);
  }
}

var inboxGuestLinkSearchTimer = null;
var inboxGuestLinkSearchGen = 0;

function inboxGuestLinkSearch(root, conv, query) {
  var q = String(query || '').trim();
  var box = root && root.querySelector('#inbox-guest-link-results');
  if (!q) {
    if (box) { box.hidden = true; box.innerHTML = ''; }
    inboxGuestLinkSetMsg(root, '', false);
    return;
  }
  var gen = ++inboxGuestLinkSearchGen;
  inboxGuestLinkSetMsg(root, inboxContextT('inbox.guest.searching', 'Searching…'), false);
  var url = '/staff/customers' + inboxGuestLinkClientQuery() +
    '&filter=all&limit=8&q=' + encodeURIComponent(q);
  fetch(url, { headers: { Accept: 'application/json' } })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (gen !== inboxGuestLinkSearchGen) return;
      if (!data || data.success === false) {
        inboxGuestLinkSetMsg(root, inboxContextT('inbox.guest.searchFailed', 'Could not search guests.'), true);
        return;
      }
      inboxGuestLinkSetMsg(root, '', false);
      inboxGuestLinkRenderHits(root, data.customers || [], conv);
    })
    .catch(function() {
      if (gen !== inboxGuestLinkSearchGen) return;
      inboxGuestLinkSetMsg(root, inboxContextT('inbox.guest.searchFailed', 'Could not search guests.'), true);
    });
}

function inboxGuestLinkWire(sidebar, conv) {
  var root = sidebar && sidebar.querySelector('[data-inbox-guest-link="1"]');
  if (!root || root.dataset.inboxGuestLinkWired === '1') return;
  root.dataset.inboxGuestLinkWired = '1';
  var search = root.querySelector('#inbox-guest-link-search');
  var createBtn = root.querySelector('#inbox-guest-link-create');
  if (search) {
    search.addEventListener('input', function() {
      var value = search.value;
      if (inboxGuestLinkSearchTimer) clearTimeout(inboxGuestLinkSearchTimer);
      inboxGuestLinkSearchTimer = setTimeout(function() {
        inboxGuestLinkSearch(root, conv, value);
      }, 220);
    });
  }
  if (createBtn) {
    createBtn.addEventListener('click', function() {
      var email = (conv && (conv.email || conv.guest_email)) || root.getAttribute('data-guest-email') || '';
      var name = (typeof inboxPersonDisplayName === 'function')
        ? inboxPersonDisplayName(conv)
        : ((conv && (conv.guest_name || conv.display_name)) || email || 'Guest');
      if (!email) {
        inboxGuestLinkSetMsg(root, inboxContextT('inbox.guest.emailRequired', 'This thread has no email to create a guest from.'), true);
        return;
      }
      if (typeof inboxIsOpaqueEmailIdentity === 'function' && inboxIsOpaqueEmailIdentity(name)) name = email;
      createBtn.disabled = true;
      inboxGuestLinkSetMsg(root, inboxContextT('inbox.guest.creating', 'Creating guest…'), false);
      inboxGuestLinkPostCustomer({
        email: email,
        display_name: name,
        conversation_id: conv && conv.conversation_id,
      }).then(function(res) {
        createBtn.disabled = false;
        if (!res.ok || !res.body || res.body.success === false) {
          var err = (res.body && res.body.error) || inboxContextT('inbox.guest.createFailed', 'Could not create guest.');
          if (res.status === 409) err = inboxContextT('inbox.guest.alreadyLinked', 'This conversation is already linked.');
          inboxGuestLinkSetMsg(root, err, true);
          return;
        }
        inboxGuestLinkApplyResult(conv, res.body);
      }).catch(function() {
        createBtn.disabled = false;
        inboxGuestLinkSetMsg(root, inboxContextT('inbox.guest.createFailed', 'Could not create guest.'), true);
      });
    });
  }
}

function inboxContextWireActions(sidebar, model) {
  var conv = (model && model.conversation) || {};
  var createBtn = sidebar.querySelector('#inbox-create-booking-for-guest');
  if (createBtn && createBtn.dataset.inboxContextWired !== '1') {
    createBtn.dataset.inboxContextWired = '1';
    createBtn.addEventListener('click', function() {
      if (typeof openCreateBookingFromContact === 'function') {
        openCreateBookingFromContact({
          display_name: conv.guest_name,
          phone: conv.phone,
          email: conv.email,
          language: conv.language,
          internal_staff_notes: conv.internal_staff_notes,
        });
      }
    });
  }
  inboxGuestLinkWire(sidebar, conv);
}

function inboxContextWireSectionMemory(sidebar) {
  var nodes = sidebar.querySelectorAll('[data-inbox-context-section]');
  for (var i = 0; i < nodes.length; i++) {
    (function(wrap) {
      var details = wrap.querySelector('details');
      if (!details || details.dataset.inboxContextWired === '1') return;
      details.dataset.inboxContextWired = '1';
      details.addEventListener('toggle', function() {
        var saved = inboxContextReadExpanded();
        saved[wrap.getAttribute('data-inbox-context-section')] = !!details.open;
        inboxContextWriteExpanded(saved);
      });
    })(nodes[i]);
  }
}

function inboxContextWrapSidebarToggle() {
  if (typeof wireInboxSidebarToggle !== 'function' || wireInboxSidebarToggle._inboxContextWrapped) return;
  var legacy = wireInboxSidebarToggle;
  wireInboxSidebarToggle = function(targetEl) {
    inboxContextFill(targetEl);
    return legacy(targetEl);
  };
  wireInboxSidebarToggle._inboxContextWrapped = true;
}

function inboxContextInstall() {
  if (inboxContextRuntime.wired) return true;
  inboxContextEnsureStyles();
  inboxContextInstallFetchHook();
  inboxContextWrapSidebarToggle();
  inboxContextWrapColumnsApply();
  inboxCustomerEnsureBookingDelegate();
  inboxContextRuntime.wired = true;
  return true;
}

if (typeof window !== 'undefined') {
  window.__inboxContext = {
    STORAGE_PREFIX: INBOX_CONTEXT_STORAGE_PREFIX,
    CSS: INBOX_CONTEXT_CSS,
    runtime: inboxContextRuntime,
    euroFromCents: inboxContextEuroFromCents,
    sumDueCents: inboxContextSumDueCents,
    bookingsSummary: inboxContextBookingsSummary,
    stayFacts: inboxContextStayFacts,
    currentStay: inboxContextCurrentStay,
    outstandingSection: inboxContextOutstandingSection,
    sectionOpen: inboxContextSectionOpen,
    guestCardHtml: inboxContextGuestCardHtml,
    clientInfoHtml: inboxClientInfoHtml,
    clientInfoHasRecord: inboxClientInfoHasRecord,
    customerCondensedHtml: inboxCustomerCondensedHtml,
    customerFullHtml: inboxCustomerFullHtml,
    customerUnmatchedHtml: inboxCustomerUnmatchedHtml,
    customerPaymentStatusLabel: inboxCustomerPaymentStatusLabel,
    customerFromConv: inboxCustomerFromConv,
    customerResolvePhone: inboxCustomerResolvePhone,
    customerResolveBookings: inboxCustomerResolveBookings,
    customerStatCount: inboxCustomerStatCount,
    guestLinkPostCustomer: inboxGuestLinkPostCustomer,
    isGuestMode: inboxContextIsGuestMode,
    modelFromComposite: inboxContextModelFromComposite,
    normalizeModel: inboxContextNormalizeModel,
    fill: inboxContextFill,
    install: inboxContextInstall,
  };
}

if (typeof document !== 'undefined' && typeof wireInboxSidebarToggle === 'function') {
  inboxContextInstall();
}
