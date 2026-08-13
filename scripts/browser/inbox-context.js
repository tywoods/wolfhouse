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
  '.inbox-customer-edit{margin-left:auto;flex:0 0 auto;padding:0;border:none;background:none;',
  'color:var(--primary);font-size:12px;font-weight:600;cursor:pointer;text-decoration:underline;',
  'text-underline-offset:2px;white-space:nowrap}',
  '.inbox-customer-card .customers-profile-fields{margin-top:2px}',
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
  '#inbox-shell .inbox-left .inbox-conv-search-wrap{flex:0 0 auto;padding:10px 12px 8px}',
  '#inbox-shell .inbox-conv-search{width:100%;box-sizing:border-box;height:32px;padding:0 10px;',
  'border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);',
  'font-size:13px}',
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
  var bookingsN = cacheRow && cacheRow.booking_count != null
    ? Number(cacheRow.booking_count) || 0
    : ((data.bookings || []).length);
  var lessonsN = cacheRow && cacheRow.service_count != null
    ? Number(cacheRow.service_count) || 0
    : ((data.service_records || []).length);
  var language = id.language || (cacheRow && cacheRow.language) || '—';
  var html = '<div class="inbox-client-info" id="inbox-client-info" data-phone="' + inboxContextEsc(phone) + '">';
  html += '<div class="inbox-client-info-head">';
  html += '<div class="inbox-client-info-avatar" aria-hidden="true">' + inboxContextEsc(inboxClientInfoInitials(name)) + '</div>';
  html += '<div class="inbox-client-info-id">';
  html += '<div class="inbox-client-info-name">' + inboxContextEsc(name) + '</div>';
  if (contact.length) html += '<div class="inbox-client-info-contact">' + inboxContextEsc(contact.join(' · ')) + '</div>';
  html += '</div></div>';
  html += inboxClientInfoChipsHtml(data, cacheRow);
  html += '<div class="inbox-client-info-kv">';
  html += inboxContextKv('Checked in', inboxClientInfoCheckedIn(data, cacheRow));
  html += inboxContextKv('Bookings', String(bookingsN));
  html += inboxContextKv('Lessons', String(lessonsN));
  html += inboxContextKv('Unpaid balance', inboxClientInfoUnpaid(data, opts.composite));
  html += inboxContextKv('Waiver status', inboxClientInfoWaiver(data));
  html += inboxContextKv('Language', language);
  html += '</div>';
  html += '<button type="button" class="inbox-client-info-open" id="inbox-client-info-open">' +
    inboxContextEsc(inboxContextT('inbox.detail.clientInfo.openProfile', 'Open full profile')) + '</button>';
  html += '</div>';
  return html;
}

function inboxContextIsGuestMode() {
  var shell = typeof document !== 'undefined' ? document.getElementById('inbox-shell') : null;
  return !!(shell && shell.getAttribute('data-col4') === 'wide');
}

function inboxCustomerFromConv(conv) {
  conv = conv || {};
  return {
    success: true,
    phone: conv.phone || conv.guest_phone || '',
    identity: {
      display_name: conv.guest_name || conv.display_name || '',
      email: conv.email || '',
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
  var contact = [];
  if (phone) contact.push(phone);
  if (email) contact.push(email);
  var html = '<div class="inbox-customer-card" id="inbox-customer-card">';
  html += '<div class="inbox-customer-head">';
  html += '<div class="inbox-client-info-avatar" aria-hidden="true">' + inboxContextEsc(inboxClientInfoInitials(name)) + '</div>';
  html += '<div class="inbox-client-info-id">';
  html += '<div class="inbox-client-info-name">' + inboxContextEsc(name) + '</div>';
  if (contact.length) html += '<div class="inbox-client-info-contact">' + inboxContextEsc(contact.join(' · ')) + '</div>';
  html += '</div>';
  html += '<button type="button" class="inbox-customer-edit" id="inbox-customer-edit-profile">' +
    inboxContextEsc(inboxContextT('customers.editProfile', 'Edit profile')) + '</button>';
  html += '</div>';
  html += inboxClientInfoChipsHtml(data, cacheRow);
  html += '<div class="customers-profile-fields">';
  html += inboxCustomerField(inboxContextT('customers.detail.phone', 'Phone'), phone || '—', !phone);
  html += inboxCustomerField(inboxContextT('customers.detail.email', 'Email'), email || '—', !email);
  if (school) html += inboxCustomerField(inboxContextT('customers.detail.school', 'Active school'), school, false);
  html += inboxCustomerField(inboxContextT('customers.detail.language', 'Language'), language || '—', !language);
  html += inboxCustomerField(inboxContextT('customers.detail.lastSetup', 'Last setup'), lastSetup || inboxContextT('customers.detail.noServices', 'No services yet'), !lastSetup);
  html += inboxCustomerField(inboxContextT('customers.detail.notes', 'Notes for next time'), notes || inboxContextT('customers.detail.noNotes', 'No notes yet'), !notes);
  html += '</div>';
  html += '<div class="inbox-client-info-kv inbox-customer-stats">';
  html += inboxContextKv('Checked in', inboxClientInfoCheckedIn(data, cacheRow));
  var bookingsN = cacheRow && cacheRow.booking_count != null
    ? Number(cacheRow.booking_count) || 0
    : ((data && data.bookings) || []).length;
  var lessonsN = cacheRow && cacheRow.service_count != null
    ? Number(cacheRow.service_count) || 0
    : ((data && data.service_records) || []).length;
  html += inboxContextKv('Bookings', String(bookingsN));
  html += inboxContextKv('Lessons', String(lessonsN));
  html += inboxContextKv('Unpaid balance', inboxClientInfoUnpaid(data, opts.composite));
  html += inboxContextKv('Waiver status', inboxClientInfoWaiver(data));
  html += inboxContextKv('Language', language || '—');
  html += '</div>';
  html += inboxCustomerBookingsListHtml(data);
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
    (muted ? ' is-muted' : '') + '">' + inboxContextEsc(value) + '</span></div>';
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
  var html = '<div class="inbox-customer-card is-full" id="inbox-customer-card">';
  html += '<div class="customers-profile-summary">';
  html += '<div class="customers-profile-summary-hdr">';
  html += '<div class="customers-profile-avatar" aria-hidden="true">' + inboxContextEsc(inboxClientInfoInitials(name)) + '</div>';
  html += '<div class="customers-profile-identity">';
  html += '<h3 class="customers-profile-name">' + inboxContextEsc(name) + '</h3>';
  html += '<div class="customers-profile-contact">' + inboxContextEsc([phone, email].filter(Boolean).join(' · ') || '—') + '</div>';
  html += '</div>';
  html += '<div class="customers-profile-hdr-actions">';
  html += '<button type="button" class="btn btn-ghost" id="inbox-create-booking-for-guest">' +
    inboxContextEsc(inboxContextT('customers.detail.createBooking', 'Create booking')) + '</button>';
  html += '<button type="button" class="btn btn-ghost" id="inbox-customer-edit-profile">' +
    inboxContextEsc(inboxContextT('customers.editProfile', 'Edit profile')) + '</button>';
  html += '</div></div>';
  html += inboxClientInfoChipsHtml(data, cacheRow);
  html += '<div class="customers-profile-fields">';
  html += inboxCustomerField(inboxContextT('customers.detail.phone', 'Phone'), phone || '—', !phone);
  html += inboxCustomerField(inboxContextT('customers.detail.email', 'Email'), email || '—', !email);
  if (school) html += inboxCustomerField(inboxContextT('customers.detail.school', 'Active school'), school, false);
  html += inboxCustomerField(inboxContextT('customers.detail.language', 'Language'), language || '—', !language);
  html += inboxCustomerField(inboxContextT('customers.detail.lastSetup', 'Last setup'), lastSetup || inboxContextT('customers.detail.noServices', 'No services yet'), !lastSetup);
  html += inboxCustomerField(inboxContextT('customers.detail.notes', 'Notes for next time'), notes || inboxContextT('customers.detail.noNotes', 'No notes yet'), !notes);
  html += '</div></div>';

  var bookings = (data && data.bookings) || [];
  if (typeof renderCustomerLinkedBookingsSection === 'function') {
    html += String(renderCustomerLinkedBookingsSection(data) || '').replace('id="cust-linked-bookings-section"', '');
  } else {
    html += '<div class="customers-section">';
    html += '<div class="customers-section-hdr">' + inboxContextEsc(inboxContextT('customers.detail.linkedBookings', 'Linked bookings')) + '</div>';
    html += '<div class="customers-section-empty">' + inboxContextEsc(inboxContextT('customers.detail.noLinkedBookings', 'No linked bookings yet')) + '</div>';
    html += '</div>';
  }

  function collapse(title, count, body) {
    if (typeof renderCollapsibleCustomerSection === 'function') {
      return renderCollapsibleCustomerSection({ title: title, count: count, body: body });
    }
    return '<details class="customers-collapsible"><summary>' + inboxContextEsc(title) +
      ' <span>' + inboxContextEsc(String(count)) + '</span></summary>' + body + '</details>';
  }

  var tagsHtml = inboxClientInfoChipsHtml(data, cacheRow) ||
    '<div class="customers-section-empty">' + inboxContextEsc(inboxContextT('customers.detail.noTags', 'No tags')) + '</div>';
  html += collapse(inboxContextT('customers.detail.tags', 'Tags'), ((id.display_tags || []).length), tagsHtml);

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

  var messages = (data && data.messages) || [];
  var msgBody = '';
  if (messages.length) {
    for (var mi = 0; mi < messages.length; mi++) {
      var m = messages[mi];
      msgBody += '<div class="customers-msg"><div class="customers-msg-dir">' +
        inboxContextEsc(m.direction || '') + '</div><div>' + inboxContextEsc(m.message_text || '') + '</div></div>';
    }
  } else {
    msgBody = '<div class="customers-section-empty">' + inboxContextEsc(inboxContextT('customers.detail.noMessages', 'No messages')) + '</div>';
  }
  html += collapse(inboxContextT('customers.detail.messages', 'Recent messages'), messages.length, msgBody);

  if (typeof renderCustomerWaiverFormsSection === 'function') {
    html += renderCustomerWaiverFormsSection(data);
  }
  html += '</div>';
  return html;
}

function inboxCustomerPaint(sidebar, conv, composite, customer) {
  if (!sidebar) return;
  var data = inboxCustomerMerge(inboxCustomerFromConv(conv), customer || inboxContextLastCustomer);
  inboxContextLastCustomer = data;
  inboxContextLastConv = conv;
  var full = inboxContextIsGuestMode();
  sidebar.innerHTML = full
    ? inboxCustomerFullHtml(data, { composite: composite, conv: conv })
    : inboxCustomerCondensedHtml(data, { composite: composite });
  inboxContextWireActions(sidebar, { conversation: conv });
  inboxCustomerWireFull(sidebar, data);
}

function inboxOpenBookingDrawerHere(booking) {
  booking = booking || {};
  var drawerFn = (typeof window !== 'undefined' && typeof window.openScheduleDetailDrawer === 'function')
    ? window.openScheduleDetailDrawer
    : (typeof openScheduleDetailDrawer === 'function' ? openScheduleDetailDrawer : null);
  if (!drawerFn) return false;
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

function inboxCustomerWireFull(sidebar, data) {
  var edit = sidebar && sidebar.querySelector('#inbox-customer-edit-profile');
  if (edit && edit.dataset.inboxCustomerWired !== '1') {
    edit.dataset.inboxCustomerWired = '1';
    edit.addEventListener('click', function() {
      var phone = data && data.phone;
      if (typeof normalizeCustomerPhoneClient === 'function') phone = normalizeCustomerPhoneClient(phone);
      if (typeof openCustomerCardForPhone === 'function' && phone) openCustomerCardForPhone(phone);
    });
  }
  if (!sidebar || !sidebar.querySelectorAll) return;
  var links = sidebar.querySelectorAll('[data-inbox-open-booking]');
  for (var i = 0; i < links.length; i++) {
    (function(btn) {
      if (btn.dataset.inboxCustomerWired === '1') return;
      btn.dataset.inboxCustomerWired = '1';
      btn.addEventListener('click', function(ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
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

function inboxCustomerLoad(sidebar, conv, composite) {
  if (!sidebar) return;
  var phone = conv && (conv.phone || conv.guest_phone);
  if (typeof normalizeCustomerPhoneClient === 'function') phone = normalizeCustomerPhoneClient(phone);
  if (inboxContextLastCustomer && phone && inboxContextLastCustomer.phone
      && String(inboxContextLastCustomer.phone) !== String(phone)) {
    inboxContextLastCustomer = null;
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
    return p.then(function(res) {
      return res.clone().json().then(function(body) {
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
