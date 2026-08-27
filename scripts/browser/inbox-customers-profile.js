/**
 * Staff Portal Inbox, Customers tab: tag rendering, profile card, linked bookings,
 * waiver forms, detail load and render, add-customer form, and tab wiring.
 *
 * Injected into /staff/ui at the inbox-customers-profile marker. Fragment spliced into
 * the portal IIFE; depends on siblings there and on the server-interpolated
 * CUSTOMER_CRM_TAG_KEYS / CUSTOMER_AUTO_TAG_KEYS / CUSTOMER_DISPLAY_TAG_ORDER, which
 * stay in the template.
 */

function refreshCustomerDisplayTags(identity) {
  if (!identity) return [];
  var crm = identity.crm_tags || {};
  var auto = identity.auto_tags || {};
  var display = [];
  CUSTOMER_DISPLAY_TAG_ORDER.forEach(function(key) {
    if (crm[key] || auto[key]) display.push(key);
  });
  identity.display_tags = display;
  return display;
}

function customerTagIsAuto(tagKey, identity) {
  var auto = (identity && identity.auto_tags) || {};
  return !!auto[tagKey];
}

function formatCustomerWhen(iso) {
  if (!iso) return '—';
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (_) { return '—'; }
}

function renderCustomersList(rows) {
  var box = el('cust-list');
  if (!box) return;
  if (!rows || !rows.length) {
    box.innerHTML = '<div class="customers-detail-empty"><p class="main-msg">' + escHtml(portalT('customers.empty.main')) + '</p>' +
      '<p class="sub-msg" style="margin-top:8px;font-size:12px">' + escHtml(portalT('customers.empty.sub')) + '</p></div>';
    updateCustomersBulkSelectionUI();
    return;
  }
  box.innerHTML = rows.map(function(c) {
    var name = c.display_name || c.phone || 'Guest';
    var contact = [];
    if (c.email) contact.push(c.email);
    if (c.phone) contact.push(c.phone);
    var tagChips = customerDisplayTags(c).map(function(tagKey) {
      return customerTagChipHtml(tagKey, { auto: customerTagIsAuto(tagKey, c), compact: true });
    }).join('');
    var sel = selectedCustomerPhone === c.phone ? ' selected' : '';
    var bulkSel = customersBulkSelected[c.phone] ? ' bulk-selected' : '';
    var bulkChecked = customersBulkSelected[c.phone] ? ' checked' : '';
    return '<div class="customers-card' + sel + bulkSel + '" data-phone="' + escHtml(c.phone) + '">' +
      '<label class="customers-card-check" title="' + escHtml(portalT('customers.outreach.selectCustomer')) + '"><input type="checkbox" class="cust-bulk-check" data-phone="' + escHtml(c.phone) + '"' + bulkChecked + ' aria-label="' + escHtml(portalT('customers.outreach.selectCustomer')) + '"></label>' +
      '<div class="customers-card-body">' +
      '<div class="customers-card-heading"><div class="customers-card-name">' + escHtml(name) + '</div>' +
      (c.phone
        ? '<span class="customers-card-phone cust-conv-link" role="button" tabindex="0" title="Open conversation">' + escHtml(c.phone) + '</span>'
        : '<span class="customers-card-phone"></span>') +
      '</div>' +
      (c.email
        ? '<div class="customers-card-contact cust-conv-link" role="button" tabindex="0" title="Open conversation">' + escHtml(c.email) + '</div>'
        : '') +
      (tagChips ? '<div class="customers-badges">' + tagChips + '</div>' : '') +
      '</div></div>';
  }).join('');
  updateCustomersBulkSelectionUI();
}

var customerDetailState = { phone: null, data: null, editing: false, tagsEditing: false };

function renderCustomerTagsSection(data) {
  var identity = (data && data.identity) || {};
  var tags = identity.crm_tags || {};
  var autoTags = identity.auto_tags || {};
  var displayTags = customerDisplayTags(identity).length ? customerDisplayTags(identity) : refreshCustomerDisplayTags(identity);
  var html = '<details class="customers-section customers-collapsible" id="cust-tags-section"' + (customerDetailState.tagsEditing ? ' open' : '') + '>';
  html += '<summary class="customers-section-hdr customers-collapsible-summary">' + escHtml(portalT('customers.tags.title')) +
    (displayTags.length
      ? '<span class="customers-tags-summary-chips">' + displayTags.map(function(tagKey) {
          return customerTagChipHtml(tagKey, { auto: customerTagIsAuto(tagKey, identity) });
        }).join('') + '</span>'
      : '<span class="customers-collapsible-count">0</span>') +
    '</summary>';
  html += '<div class="customers-section-body customers-collapsible-body">';
  if (!customerDetailState.tagsEditing) {
    html += '<div class="customers-tags-view">';
    if (displayTags.length) {
      html += '<div class="customers-tags-chips">' + displayTags.map(function(tagKey) {
        return customerTagChipHtml(tagKey, { auto: customerTagIsAuto(tagKey, identity) });
      }).join('') + '</div>';
    } else {
      html += '<span class="customers-tags-empty">' + escHtml(portalT('customers.tags.none')) + '</span>';
    }
    html += '<button type="button" class="btn btn-ghost" id="cust-tags-edit-toggle">' + escHtml(portalT('customers.tags.edit')) + '</button>';
    html += '</div>';
  } else {
    html += '<div class="customers-tags-edit">';
    html += '<div class="customers-tags-unified-row">';
    CUSTOMER_CRM_TAG_KEYS.forEach(function(key) {
      if (customerTagIsAuto(key, identity)) {
        html += customerTagChipHtml(key, { auto: true });
        return;
      }
      var checked = tags[key] ? ' checked' : '';
      html += '<label class="customers-tag-toggle" data-tag-tone="' + customerTagTone(key) + '"><input type="checkbox" data-crm-tag="' + escHtml(key) + '"' + checked + '> ' + escHtml(portalT('customers.tags.' + key)) + '</label>';
    });
    displayTags.forEach(function(tagKey) {
      if (customerTagIsAuto(tagKey, identity) && CUSTOMER_CRM_TAG_KEYS.indexOf(tagKey) === -1) {
        html += customerTagChipHtml(tagKey, { auto: true });
      }
    });
    html += '</div>';

    html += '<div class="customers-profile-actions">';
    html += '<button type="button" class="btn btn-primary" id="cust-tags-save">' + escHtml(portalT('customers.tags.save')) + '</button>';
    html += '<button type="button" class="btn btn-ghost" id="cust-tags-cancel">' + escHtml(portalT('customers.cancel')) + '</button>';
    html += '</div></div>';
  }
  html += '<p id="cust-tags-msg" class="state-msg" style="display:none;margin-top:8px"></p></div></details>';
  return html;
}

function wireCustomerTagsActions() {
  var editBtn = el('cust-tags-edit-toggle');
  if (editBtn && !editBtn.dataset.wired) {
    editBtn.dataset.wired = '1';
    editBtn.addEventListener('click', function() {
      customerDetailState.tagsEditing = true;
      if (customerDetailState.data) renderCustomerDetail(customerDetailState.data);
    });
  }
  var cancelBtn = el('cust-tags-cancel');
  if (cancelBtn && !cancelBtn.dataset.wired) {
    cancelBtn.dataset.wired = '1';
    cancelBtn.addEventListener('click', function() {
      customerDetailState.tagsEditing = false;
      if (customerDetailState.data) renderCustomerDetail(customerDetailState.data);
    });
  }
  var saveBtn = el('cust-tags-save');
  if (saveBtn && !saveBtn.dataset.wired) {
    saveBtn.dataset.wired = '1';
    saveBtn.addEventListener('click', function(){ customerSaveTags(); });
  }
}

function customerSaveTags() {
  if (!customerDetailState.data || !customerDetailState.phone) return;
  var msg = el('cust-tags-msg');
  var saveBtn = el('cust-tags-save');
  var tags = {};
  CUSTOMER_CRM_TAG_KEYS.forEach(function(key) {
    var input = document.querySelector('#cust-tags-section input[data-crm-tag="' + key + '"]');
    tags[key] = !!(input && input.checked);
  });
  if (saveBtn) saveBtn.disabled = true;
  if (msg) msg.style.display = 'none';
  fetch('/staff/customers/' + encodeURIComponent(customerDetailState.phone) + '/tags?client=' + encodeURIComponent(getClient()), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: tags }),
  }).then(function(r){ return r.json().then(function(body){ return { ok: r.ok, body: body }; }); })
    .then(function(res){
      if (!res.ok || !res.body || !res.body.success) {
        throw new Error((res.body && res.body.error) || 'save failed');
      }
      if (customerDetailState.data && customerDetailState.data.identity) {
        customerDetailState.data.identity.crm_tags = res.body.crm_tags || tags;
        refreshCustomerDisplayTags(customerDetailState.data.identity);
      }
      customerDetailState.tagsEditing = false;
      var reloadPhone = customerDetailState.phone;
      loadCustomerDetail(reloadPhone).then(function() {
        loadCustomersList();
      });
    })
    .catch(function(err){
      if (msg) { msg.className = 'state-msg error'; msg.textContent = portalT('customers.tags.saveFailed') + ' ' + err.message; msg.style.display = 'block'; }
    })
    .finally(function(){ if (saveBtn) saveBtn.disabled = false; });
}

function customerProfileNotes(data) {
  if (!data) return '';
  var notes = data.notes;
  if (typeof notes === 'string') return notes.trim();
  notes = notes && typeof notes === 'object' ? notes : {};
  return (notes.internal_staff_notes || notes.human_notes || '').trim();
}

function normalizeCustomerPhoneClient(phone) {
  var raw = String(phone || '').trim();
  if (!raw) return '';
  if (/^emailcust1:/i.test(raw)) return raw.slice(0, 96);
  if (/^(emailv1|email):/i.test(raw)) return raw.slice(0, 200);
  if (raw.charAt(0) === '+') return raw.slice(0, 40);
  var digits = raw.replace(/[^\d]/g, '');
  return digits ? ('+' + digits).slice(0, 40) : '';
}

function customerResolveConversationId(data) {
  if (!data) return null;
  var id = data.identity && data.identity.conversation_id;
  if (id) return id;
  var cs = data.conversation_summary;
  return cs && cs.conversation_id ? cs.conversation_id : null;
}

function customerPaymentStatusLabel(raw) {
  var s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/\s+/g, '_');
  if (!s || s === '—' || s === '-') return '—';
  if (s === 'canceled') s = 'cancelled';
  // Display-only aliases → Reservas status chips (paid|unpaid|partial|…). Staff API enum stays unchanged.
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
  // Never show snake_case enums to staff — humanize unknown API values without inventing status.
  return s.replace(/_/g, ' ').replace(/\b\w/g, function(ch) { return ch.toUpperCase(); });
}

function customerBookingDateLabel(val) {
  if (!val) return '';
  var s = String(val).trim();
  if (!s) return '';
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function renderCustomerLinkedBookingsSection(data) {
  var bookings = (data && data.bookings) || [];
  var html = '<div class="customers-section" id="cust-linked-bookings-section">';
  html += '<div class="customers-section-hdr">' + escHtml(portalT('customers.detail.linkedBookings')) + '</div>';
  if (bookings.length) {
    html += '<table class="customers-row-table"><thead><tr>' +
      '<th>' + escHtml(portalT('customers.detail.bookingCode')) + '</th>' +
      '<th>' + escHtml(portalT('customers.detail.bookingDates')) + '</th>' +
      '<th>' + escHtml(portalT('customers.detail.bookingStatus')) + '</th>' +
      '<th>' + escHtml(portalT('customers.detail.paymentStatus')) + '</th>' +
      '<th class="cust-booking-open-cell" aria-hidden="true"></th>' +
      '</tr></thead><tbody>';
    bookings.forEach(function(b) {
      var checkIn = customerBookingDateLabel(b.check_in);
      var checkOut = customerBookingDateLabel(b.check_out);
      var dates = '';
      if (checkIn || checkOut) {
        dates = escHtml(checkIn || '—') + ' → ' + escHtml(checkOut || '—');
      } else {
        dates = '—';
      }
      var payStatus = customerPaymentStatusLabel(b.payment_status || b.payment_payment_status);
      var openTitle = escHtml(portalT('customers.detail.openBookingTitle'));
      var openLabel = escHtml(portalT('customers.detail.openBooking'));
      html += '<tr><td>' + escHtml(String(b.booking_code || '—')) + '</td>' +
        '<td>' + dates + '</td>' +
        '<td>' + escHtml(String(b.booking_status || '—')) + '</td>' +
        '<td>' + escHtml(String(payStatus)) + '</td>' +
        '<td class="cust-booking-open-cell">' +
        '<button type="button" class="customers-booking-open-link cust-booking-open-link" ' +
        'title="' + openTitle + '" ' +
        'data-booking-id="' + escHtml(String(b.booking_id || '')) + '" ' +
        'data-booking-code="' + escHtml(String(b.booking_code || '')) + '" ' +
        'data-check-in="' + escHtml(checkIn) + '" ' +
        'data-check-out="' + escHtml(checkOut) + '" ' +
        'data-guest-name="' + escHtml(String(b.guest_name || '')) + '">' +
        openLabel + '</button></td></tr>';
    });
    html += '</tbody></table>';
  } else {
    html += '<div class="customers-section-empty">' + escHtml(portalT('customers.detail.noLinkedBookings')) + '</div>';
  }
  html += '</div>';
  return html;
}

function wireCustomerLinkedBookingsActions() {
  document.querySelectorAll('.cust-booking-open-link').forEach(function(btn) {
    btn.addEventListener('click', function() {
      openBookingInCalendar({
        booking_id: btn.dataset.bookingId || null,
        booking_code: btn.dataset.bookingCode || null,
        check_in: btn.dataset.checkIn || null,
        check_out: btn.dataset.checkOut || null,
        guest_name: btn.dataset.guestName || '',
      });
    });
  });
}

function customerWaiverFormUrl(publicId) {
  var base = (typeof window !== 'undefined' && window.location) ? window.location.origin : '';
  return base + '/forms/waiver/' + encodeURIComponent(publicId);
}

// Shared collapsed <details> section used across the customer detail card so
// Waivers / Previous services / Recent WhatsApp + Email / Open handoffs all look + behave
// identically. Collapsed by default.
function renderCollapsibleCustomerSection(opts) {
  opts = opts || {};
  var countHtml = (opts.count != null)
    ? '<span class="customers-collapsible-count">' + escHtml(String(opts.count)) + '</span>'
    : '';
  return '<details class="customers-section customers-collapsible"' +
    (opts.id ? ' id="' + escHtml(opts.id) + '"' : '') + (opts.open ? ' open' : '') + '>' +
    '<summary class="customers-section-hdr customers-collapsible-summary">' +
    escHtml(opts.title || '') + countHtml + '</summary>' +
    '<div class="customers-section-body customers-collapsible-body">' + (opts.body || '') + '</div>' +
    '</details>';
}

function renderCustomerWaiverFormsSection(data) {
  if (!isSunsetSurfActive()) return '';
  var waivers = (data && data.waivers) || [];
  var body = '';
  if (waivers.length) {
    waivers.forEach(function(w) {
      if (!w || !w.public_id) return;
      var url = customerWaiverFormUrl(w.public_id);
      var st = String(w.status || '').toLowerCase();
      var done = st === 'completed';
      var stLabel = done ? portalT('customers.detail.waiverSigned') : portalT('customers.detail.waiverPending');
      body += '<div class="customers-waiver-row">' +
        '<div class="customers-waiver-meta">' +
        '<span class="customers-waiver-code">' + escHtml(String(w.booking_code || '—')) + '</span>' +
        (w.participant_key ? '<span class="customers-waiver-part">' + escHtml(String(w.participant_key)) + '</span>' : '') +
        '<span class="customers-waiver-status' + (done ? ' is-done' : '') + '">' + escHtml(stLabel) + '</span>' +
        '</div>' +
        '<a class="customers-waiver-link" href="' + escHtml(url) + '" target="_blank" rel="noopener">' +
        escHtml(portalT('customers.detail.openWaiver')) + '</a>' +
        '</div>';
    });
  } else {
    body = '<div class="customers-section-empty">' + escHtml(portalT('customers.detail.noWaivers')) + '</div>';
  }
  return renderCollapsibleCustomerSection({
    id: 'cust-waivers-section',
    title: portalT('customers.detail.waiverForms'),
    count: waivers.length,
    body: body,
  });
}

function renderCustomerProfileSection(data, editing) {
  var id = data.identity || {};
  var notes = customerProfileNotes(data);
  var lastSetup = (data && data.last_setup_summary) || '';
  var displayName = id.display_name || data.phone || 'Guest';
  var convId = customerResolveConversationId(data);
  var convLabel = convId ? portalT('customers.conversation.open') : portalT('customers.conversation.start');
  if (!editing) {
    var contactBits = [];
    if (data.phone) contactBits.push(data.phone);
    if (id.email) contactBits.push(id.email);
    return '<div class="customers-profile-summary" id="cust-profile-section">' +
      '<div class="customers-profile-summary-hdr">' +
      '<div class="customers-profile-avatar" aria-hidden="true">' + escHtml(customerProfileInitials(displayName)) + '</div>' +
      '<div class="customers-profile-identity">' +
      '<h3 class="customers-profile-name">' + escHtml(displayName) + '</h3>' +
      '<div class="customers-profile-contact">' + escHtml(contactBits.join(' · ') || portalT('customers.contact.unknown')) + '</div>' +
      '</div>' +
      '<div class="customers-profile-hdr-actions">' +
      '<button type="button" class="btn btn-ghost" id="cust-profile-create-booking">' + escHtml(portalT('customers.detail.createBooking')) + '</button>' +
      '<button type="button" class="btn btn-primary" id="cust-conversation-btn">' + escHtml(convLabel) + '</button>' +
      '<button type="button" class="btn btn-ghost" id="cust-profile-edit-btn">' + escHtml(portalT('customers.editProfile')) + '</button>' +
      '</div></div>' +
      '<div class="customers-profile-fields">' +
      '<div class="customers-profile-field"><span class="customers-profile-field-label">' + escHtml(portalT('customers.detail.phone')) + '</span><span class="customers-profile-field-value' + (data.phone ? ' cust-conv-link cust-detail-conv-open' : '') + '"' + (data.phone ? ' role="button" tabindex="0" title="' + escHtml(portalT('customers.conversation.open')) + '"' : '') + '>' + escHtml(data.phone || '—') + '</span></div>' +
      '<div class="customers-profile-field"><span class="customers-profile-field-label">' + escHtml(portalT('customers.detail.email')) + '</span><span class="customers-profile-field-value' + (id.email ? '' : ' is-muted') + ((id.email && data.phone) ? ' cust-conv-link cust-detail-conv-open' : '') + '"' + ((id.email && data.phone) ? ' role="button" tabindex="0" title="' + escHtml(portalT('customers.conversation.open')) + '"' : '') + '>' + escHtml(id.email || '—') + '</span></div>' +
      (isSunsetSurfActive() ? '<div class="customers-profile-field"><span class="customers-profile-field-label">' + escHtml(t('customers.detail.school')) + '</span><span class="customers-profile-field-value">' + escHtml(getSunsetLocationLabel()) + '</span></div>' : '') +
      '<div class="customers-profile-field"><span class="customers-profile-field-label">' + escHtml(portalT('customers.detail.language')) + '</span><span class="customers-profile-field-value' + (id.language ? '' : ' is-muted') + '">' + escHtml(id.language || '—') + '</span></div>' +
      '<div class="customers-profile-field"><span class="customers-profile-field-label">' + escHtml(portalT('customers.detail.lastSetup')) + '</span><span class="customers-profile-field-value' + (lastSetup ? '' : ' is-muted') + '">' + escHtml(lastSetup || portalT('customers.detail.noServices')) + '</span></div>' +
      '<div class="customers-profile-field"><span class="customers-profile-field-label">' + escHtml(portalT('customers.detail.notes')) + '</span><span class="customers-profile-field-value' + (notes ? '' : ' is-muted') + '">' + escHtml(notes || portalT('customers.detail.noNotes')) + '</span></div>' +
      '</div>' +
      '<p id="cust-profile-msg" class="state-msg" style="display:none;margin-top:8px"></p>' +
      '</div>';
  }
  return '<div class="customers-section" id="cust-profile-section">' +
    '<div class="customers-section-hdr">' + escHtml(portalT('customers.editProfile')) + '</div>' +
    '<div class="customers-section-body customers-profile-edit-form">' +
    '<label class="customers-edit-field"><span>' + escHtml(portalT('customers.detail.name')) + '</span><input id="cust-edit-name" type="text" value="' + escHtml(id.display_name || '') + '"></label>' +
    '<label class="customers-edit-field"><span>' + escHtml(portalT('customers.detail.phone')) + '</span><input id="cust-edit-phone" type="tel" value="' + escHtml(data.phone || '') + '"></label>' +
    '<label class="customers-edit-field"><span>' + escHtml(portalT('customers.detail.email')) + '</span><input id="cust-edit-email" type="email" value="' + escHtml(id.email || '') + '"></label>' +
    '<label class="customers-edit-field"><span>' + escHtml(portalT('customers.detail.language')) + '</span><input id="cust-edit-language" type="text" value="' + escHtml(id.language || '') + '" placeholder="en, es, …"></label>' +
    '<label class="customers-edit-field"><span>' + escHtml(portalT('customers.detail.notes')) + '</span><textarea id="cust-edit-notes" rows="3">' + escHtml(notes) + '</textarea></label>' +
    '</div>' +
    '<div class="customers-profile-actions">' +
    '<button type="button" class="btn btn-primary" id="cust-profile-save">' + escHtml(portalT('customers.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" id="cust-profile-cancel">' + escHtml(portalT('customers.cancel')) + '</button>' +
    '</div>' +
    '<p id="cust-profile-msg" class="state-msg" style="display:none;margin-top:8px"></p>' +
    '</div>';
}

function wireCustomerProfileActions(data) {
  var editBtn = el('cust-profile-edit-btn');
  if (editBtn) editBtn.addEventListener('click', function(){ customerEnterEditMode(); });
  var convBtn = el('cust-conversation-btn');
  if (convBtn) convBtn.addEventListener('click', function(){ customerOpenOrStartConversation(); });
  // Phone / email rows in the detail panel open (or create) the conversation too.
  var section = el('cust-profile-section');
  if (section) {
    var convOpeners = section.querySelectorAll('.cust-detail-conv-open');
    for (var oi = 0; oi < convOpeners.length; oi++) {
      convOpeners[oi].addEventListener('click', function(){ customerOpenOrStartConversation(); });
      convOpeners[oi].addEventListener('keydown', function(ev){
        if (ev && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); customerOpenOrStartConversation(); }
      });
    }
  }
  var createBookingBtn = el('cust-profile-create-booking');
  if (createBookingBtn) createBookingBtn.addEventListener('click', function(){
    var id = (customerDetailState.data && customerDetailState.data.identity) || {};
    var custNotes = customerDetailState.data && customerDetailState.data.notes;
    openCreateBookingFromContact({
      display_name: id.display_name,
      phone: customerDetailState.data ? customerDetailState.data.phone : null,
      email: id.email,
      language: id.language,
      internal_staff_notes: custNotes ? custNotes.internal_staff_notes : null
    });
  });
  var saveBtn = el('cust-profile-save');
  if (saveBtn) saveBtn.addEventListener('click', function(){ customerSaveProfile(); });
  var cancelBtn = el('cust-profile-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', function(){ customerCancelEditMode(); });
}

function customerOpenOrStartConversation() {
  if (!customerDetailState.data || !customerDetailState.phone) return;
  var convId = customerResolveConversationId(customerDetailState.data);
  if (convId) {
    openInboxToConversation(convId);
    return;
  }
  customerStartConversationFromProfile();
}

function customerStartConversationFromProfile() {
  if (!customerDetailState.data || !customerDetailState.phone) return;
  var btn = el('cust-conversation-btn');
  var msg = el('cust-profile-msg');
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;
  if (msg) msg.style.display = 'none';
  var idemKey = 'customer-profile-conv-' + customerDetailState.phone;
  fetch('/staff/customers/' + encodeURIComponent(customerDetailState.phone) + '/create-conversation?client=' + encodeURIComponent(getClient()), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idempotency_key: idemKey,
      reason: 'Created from customer profile',
    }),
  }).then(function(r){ return r.json().then(function(body){ return { ok: r.ok, body: body }; }); })
    .then(function(res){
      if (!res.ok || !res.body || !res.body.success) {
        throw new Error((res.body && res.body.error) || 'conversation failed');
      }
      var convId = res.body.conversation_id;
      if (convId && customerDetailState.data) {
        if (customerDetailState.data.identity) customerDetailState.data.identity.conversation_id = convId;
        if (!customerDetailState.data.conversation_summary) customerDetailState.data.conversation_summary = {};
        customerDetailState.data.conversation_summary.conversation_id = convId;
      }
      if (convId) openInboxToConversation(convId);
    })
    .catch(function(err){
      if (msg) {
        msg.className = 'state-msg error';
        msg.textContent = portalT('customers.conversation.failed') + ' ' + err.message;
        msg.style.display = 'block';
      }
    })
    .finally(function(){ if (btn) btn.disabled = false; });
}

function customerEnterEditMode() {
  if (!customerDetailState.data) return;
  customerDetailState.editing = true;
  renderCustomerDetail(customerDetailState.data);
}

function customerCancelEditMode() {
  if (!customerDetailState.data) return;
  customerDetailState.editing = false;
  renderCustomerDetail(customerDetailState.data);
}

function customerSaveProfile() {
  if (!customerDetailState.data || !customerDetailState.phone) return;
  var msg = el('cust-profile-msg');
  var saveBtn = el('cust-profile-save');
  var payload = {
    display_name: (el('cust-edit-name') && el('cust-edit-name').value || '').trim(),
    phone: (el('cust-edit-phone') && el('cust-edit-phone').value || '').trim(),
    email: (el('cust-edit-email') && el('cust-edit-email').value || '').trim(),
    language: (el('cust-edit-language') && el('cust-edit-language').value || '').trim(),
    notes: (el('cust-edit-notes') && el('cust-edit-notes').value || '').trim(),
  };
  if (!payload.display_name || !payload.phone) {
    if (msg) { msg.className = 'state-msg error'; msg.textContent = portalT('customers.saveRequired'); msg.style.display = 'block'; }
    return;
  }
  if (saveBtn) saveBtn.disabled = true;
  if (msg) msg.style.display = 'none';
  fetch('/staff/customers/' + encodeURIComponent(customerDetailState.phone) + '?client=' + encodeURIComponent(getClient()), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(function(r){ return r.json().then(function(body){ return { ok: r.ok, body: body }; }); })
    .then(function(res){
      if (!res.ok || !res.body || res.body.success !== true) throw new Error((res.body && (res.body.error || res.body.message)) || 'Save failed');
      var newPhone = normalizeCustomerPhoneClient(res.body.phone || payload.phone);
      customerDetailState.editing = false;
      customerDetailState.phone = newPhone;
      return loadCustomerDetail(newPhone).then(function() {
        loadCustomersList();
      });
    })
    .catch(function(err){
      if (msg) { msg.className = 'state-msg error'; msg.textContent = portalT('customers.saveFailed') + ' ' + err.message; msg.style.display = 'block'; }
    })
    .finally(function(){ if (saveBtn) saveBtn.disabled = false; });
}

function renderCustomerDetail(data) {
  var box = el('cust-detail');
  if (!box) return;
  if (!data || !data.success) {
    box.innerHTML = '<div class="customers-detail-empty">' + escHtml(portalT('customers.detail.error')) + '</div>';
    return;
  }
  customerDetailState.data = data;
  if (!customerDetailState.phone) customerDetailState.phone = data.phone;
  var id = data.identity || {};
  var name = id.display_name || data.phone || 'Guest';
  var html = renderCustomerProfileSection(data, customerDetailState.editing);
  html += renderCustomerLinkedBookingsSection(data);
  html += renderCustomerTagsSection(data);

  var svcBody = '';
  if (data.service_records && data.service_records.length) {
    svcBody = '<table class="customers-row-table"><thead><tr><th>Date</th><th>Service</th><th>Qty</th><th>Status</th></tr></thead><tbody>';
    data.service_records.forEach(function(r) {
      svcBody += '<tr><td>' + escHtml(String(r.service_date || '—')) + '</td><td>' + escHtml(String(r.service_type || '—').replace(/_/g, ' ')) + '</td><td>' + escHtml(String(r.quantity != null ? r.quantity : '—')) + '</td><td>' + escHtml(String(r.service_status || '—')) + '</td></tr>';
    });
    svcBody += '</tbody></table>';
  } else {
    svcBody = '<div class="customers-section-empty">' + escHtml(portalT('customers.detail.noServices')) + '</div>';
  }
  html += renderCollapsibleCustomerSection({ title: portalT('customers.detail.services'), count: (data.service_records || []).length, body: svcBody });

  function customerMsgIsEmail(m) {
    var ch = String((m && m.channel) || '').toLowerCase();
    if (ch === 'email') return true;
    if (ch === 'whatsapp') return false;
    var src = String((m && m.source) || '').toLowerCase();
    // staff_inbox_reply is WhatsApp staff-send — not email.
    return src === 'email_inbound'
      || src === 'staff_email_reply'
      || src === 'email_outbound'
      || String((m && m.route) || '').toLowerCase() === 'email';
  }
  function customerMsgDisplayText(m) {
    var body = String((m && m.body_text) || '').trim();
    if (body) return body;
    var subj = String((m && m.email_subject) || '').trim();
    if (subj) return subj;
    return String((m && m.message_text) || '');
  }

  var waMsgs = [];
  var emailMsgs = [];
  if (Array.isArray(data.email_messages) && data.email_messages.length) {
    emailMsgs = data.email_messages.slice();
    (data.messages || []).forEach(function(m) {
      if (!customerMsgIsEmail(m)) waMsgs.push(m);
    });
  } else {
    (data.messages || []).forEach(function(m) {
      if (customerMsgIsEmail(m)) emailMsgs.push(m);
      else waMsgs.push(m);
    });
  }

  var waBody = '';
  if (waMsgs.length) {
    waMsgs.forEach(function(m) {
      waBody += '<div class="customers-msg"><div class="customers-msg-dir">' + escHtml(m.direction || '') + ' · ' + escHtml(formatCustomerWhen(m.created_at)) + '</div><div>' + escHtml(customerMsgDisplayText(m)) + '</div></div>';
    });
  } else {
    waBody = '<div class="customers-section-empty">' + escHtml(portalT('customers.detail.noWhatsAppMessages')) + '</div>';
  }
  html += renderCollapsibleCustomerSection({ title: portalT('customers.detail.messagesWhatsApp'), count: waMsgs.length, body: waBody });

  var emailBody = '';
  if (emailMsgs.length) {
    emailMsgs.forEach(function(m) {
      emailBody += '<div class="customers-msg"><div class="customers-msg-dir">' + escHtml(m.direction || '') + ' · ' + escHtml(formatCustomerWhen(m.created_at)) + '</div><div>' + escHtml(customerMsgDisplayText(m)) + '</div></div>';
    });
  } else {
    emailBody = '<div class="customers-section-empty">' + escHtml(portalT('customers.detail.noEmailMessages')) + '</div>';
  }
  html += renderCollapsibleCustomerSection({ title: portalT('customers.detail.messagesEmail'), count: emailMsgs.length, body: emailBody });

  html += renderCustomerWaiverFormsSection(data);

  box.innerHTML = html;
  wireCustomerProfileActions(data);
  wireCustomerTagsActions();
  wireCustomerLinkedBookingsActions();
}

function loadCustomersList() {
  var profile = getPortalProfile(getClient());
  if (!portalHasCustomersCrm(profile)) return Promise.resolve();
  var state = el('cust-state');
  var q = (el('cust-search') && el('cust-search').value) ? el('cust-search').value.trim() : '';
  var url = '/staff/customers' + customersClientQuery() +
    '&filter=' + encodeURIComponent(customersFilter) +
    '&limit=50&offset=0';
  if (q) url += '&q=' + encodeURIComponent(q);
  if (state) { state.textContent = portalT('customers.loading'); state.style.display = 'block'; state.classList.remove('error'); }
  return fetch(url).then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function(data) {
      customersCache = (data && data.customers) || [];
      renderCustomersList(getCustomersVisibleRows());
      if (state) state.style.display = customersCache.length ? 'none' : 'block';
      if (state && !customersCache.length) state.textContent = '';
      return data;
    })
    .catch(function(e) {
      if (state) { state.textContent = portalT('customers.error') + ' ' + e.message; state.className = 'state-msg error'; state.style.display = 'block'; }
      throw e;
    });
}

function waitForCustomersDom(maxTries) {
  maxTries = maxTries || 40;
  return new Promise(function(resolve) {
    var tries = 0;
    function check() {
      if (el('cust-search') && el('tab-customers')) return resolve();
      if (++tries >= maxTries) return resolve();
      setTimeout(check, 50);
    }
    check();
  });
}

function openCustomerCardForPhone(phone, opts) {
  opts = opts || {};
  phone = normalizeCustomerPhoneClient(phone);
  if (!phone) return Promise.resolve();
  var profile = getPortalProfile(getClient());
  if (!portalHasCustomersCrm(profile)) return Promise.resolve();
  var search = el('cust-search');
  if (search) search.value = phone;
  switchToTab('customers');
  return waitForCustomersDom().then(function() {
    var searchEl = el('cust-search');
    if (searchEl) searchEl.value = phone;
    return loadCustomersList();
  }).then(function() {
    return loadCustomerDetail(phone);
  });
}

function loadCustomerDetail(phone) {
  phone = normalizeCustomerPhoneClient(phone);
  if (!phone) return Promise.resolve();
  customerDetailState = { phone: phone, data: null, editing: false, tagsEditing: false };
  selectedCustomerPhone = phone;
  renderCustomersList(getCustomersVisibleRows());
  var box = el('cust-detail');
  if (box) box.innerHTML = '<div class="customers-detail-empty">' + escHtml(portalT('customers.loading')) + '</div>';
  var url = '/staff/customers/' + encodeURIComponent(phone) + '/context?client=' + encodeURIComponent(getClient()) +
    (getClient() === 'sunset' ? ('&location=' + encodeURIComponent(getSunsetLocation())) : '');
  return fetch(url).then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function(data) { renderCustomerDetail(data); return data; })
    .catch(function() {
      if (box) box.innerHTML = '<div class="customers-detail-empty">' + escHtml(portalT('customers.detail.error')) + '</div>';
    });
}

function selectCustomerCard(phone) { loadCustomerDetail(phone); }

function setCustomersFilter(mode) {
  customersFilter = mode || 'all';
  customersBulkSelected = {};
  closeCustomersOutreachDrawer();
  renderCustomersFilterUI();
  loadCustomersList();
}

function wireCustomersFiltersUI() {
  var trigger = el('cust-filters-btn');
  if (trigger && !trigger.dataset.wired) {
    trigger.dataset.wired = '1';
    trigger.addEventListener('click', function(ev) {
      ev.stopPropagation();
      toggleCustomersFiltersMenu();
    });
  }
  var menu = el('cust-filters-menu');
  if (menu && !menu.dataset.wired) {
    menu.dataset.wired = '1';
    menu.addEventListener('click', function(ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      var statusBtn = ev.target && ev.target.closest ? ev.target.closest('[data-cust-status-filter]') : null;
      if (statusBtn) {
        setCustomersFilter(statusBtn.getAttribute('data-cust-status-filter'));
        closeCustomersFiltersMenu();
        return;
      }
      var clearBtn = ev.target && ev.target.closest ? ev.target.closest('[data-cust-clear-filters]') : null;
      if (clearBtn) {
        clearCustomersFilters();
        closeCustomersFiltersMenu();
      }
    });
    menu.addEventListener('change', function(ev) {
      var tagInput = ev.target;
      if (!tagInput || !tagInput.matches || !tagInput.matches('[data-cust-tag-filter]')) return;
      var id = tagInput.getAttribute('data-cust-tag-filter');
      if (!id) return;
      if (tagInput.checked) customersTagFilters[id] = true;
      else delete customersTagFilters[id];
      renderCustomersFilterUI();
      renderCustomersList(getCustomersVisibleRows());
    });
  }
  var chips = el('cust-filter-chips');
  if (chips && !chips.dataset.wired) {
    chips.dataset.wired = '1';
    chips.addEventListener('click', function(ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-cust-chip-remove]') : null;
      if (!btn) return;
      var token = btn.getAttribute('data-cust-chip-remove') || '';
      var parts = token.split(':');
      if (parts[0] === 'status') setCustomersFilter('all');
      else if (parts[0] === 'tag') toggleCustomersTagFilter(parts[1]);
    });
  }
  if (!document.body.dataset.custFiltersDocWired) {
    document.body.dataset.custFiltersDocWired = '1';
    document.addEventListener('click', function(ev) {
      if (!customersFiltersMenuOpen) return;
      var wrap = ev.target && ev.target.closest ? ev.target.closest('.customers-filters-wrap') : null;
      if (!wrap) closeCustomersFiltersMenu();
    });
    document.addEventListener('keydown', function(ev) {
      if (!ev || (ev.key !== 'Escape' && ev.key !== 'Esc')) return;
      if (!customersFiltersMenuOpen) return;
      if (ev.preventDefault) ev.preventDefault();
      if (ev.stopPropagation) ev.stopPropagation();
      closeCustomersFiltersMenu();
    });
    window.addEventListener('resize', function() {
      if (customersFiltersMenuOpen) positionCustomersFiltersMenu();
    });
    document.addEventListener('scroll', function() {
      if (customersFiltersMenuOpen) positionCustomersFiltersMenu();
    }, true);
  }
}

function wireCustomersTab() {
  if (!el('tab-customers')) return;
  wireCustomersFiltersUI();
  renderCustomersFilterUI();
  wireCustomerAddForm();
  wireCustomersOutreachDrawer();
  updateCustomersBulkSelectionUI();
  var selectAllBtn = el('cust-select-all-shown');
  if (selectAllBtn && !selectAllBtn.dataset.wired) {
    selectAllBtn.dataset.wired = '1';
    selectAllBtn.addEventListener('click', function() { selectAllShownCustomers(); });
  }
  var clearBtn = el('cust-clear-selection');
  if (clearBtn && !clearBtn.dataset.wired) {
    clearBtn.dataset.wired = '1';
    clearBtn.addEventListener('click', function() { clearCustomersBulkSelection(); });
  }
  var deleteBtn = el('cust-delete-selected-btn');
  if (deleteBtn && !deleteBtn.dataset.wired) {
    deleteBtn.dataset.wired = '1';
    deleteBtn.addEventListener('click', deleteSelectedCustomerProfiles);
  }
  var search = el('cust-search');
  if (search && !search.dataset.wired) {
    search.dataset.wired = '1';
    search.addEventListener('input', function() {
      clearTimeout(customersSearchTimer);
      customersSearchTimer = setTimeout(loadCustomersList, 280);
    });
  }
  var list = el('cust-list');
  if (list && !list.dataset.wired) {
    list.dataset.wired = '1';
    list.addEventListener('click', function(ev) {
      if (ev.target && ev.target.closest && (ev.target.closest('.customers-card-check') || ev.target.closest('.cust-bulk-check'))) return;
      // Slice 1: phone/email → open existing Inbox conversation (no create).
      var convLink = ev.target && ev.target.closest ? ev.target.closest('.cust-conv-link') : null;
      if (convLink) {
        var linkCard = convLink.closest('.customers-card');
        var linkPhone = linkCard && linkCard.dataset ? linkCard.dataset.phone : '';
        if (linkPhone) {
          if (ev.stopPropagation) ev.stopPropagation();
          if (ev.preventDefault) ev.preventDefault();
          openInboxToPhone(linkPhone, linkCard);
        }
        return;
      }
      var card = ev.target && ev.target.closest ? ev.target.closest('.customers-card') : null;
      if (card && card.dataset && card.dataset.phone) loadCustomerDetail(card.dataset.phone);
    });
    list.addEventListener('keydown', function(ev) {
      if (!ev || (ev.key !== 'Enter' && ev.key !== ' ')) return;
      var convLink = ev.target && ev.target.closest ? ev.target.closest('.cust-conv-link') : null;
      if (!convLink) return;
      var linkCard = convLink.closest('.customers-card');
      var linkPhone = linkCard && linkCard.dataset ? linkCard.dataset.phone : '';
      if (!linkPhone) return;
      if (ev.preventDefault) ev.preventDefault();
      openInboxToPhone(linkPhone, linkCard);
    });
    list.addEventListener('change', function(ev) {
      var cb = ev.target;
      if (!cb || !cb.classList || !cb.classList.contains('cust-bulk-check')) return;
      var phone = cb.getAttribute('data-phone');
      if (!phone) return;
      if (cb.checked) customersBulkSelected[phone] = true;
      else delete customersBulkSelected[phone];
      updateCustomersBulkSelectionUI();
    });
  }
}

function customerToggleAddPanel(show) {
  var panel = el('cust-add-panel');
  var btn = el('cust-add-btn');
  if (!panel) return;
  var open = show === true || (show !== false && panel.style.display === 'none');
  panel.style.display = open ? 'block' : 'none';
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open) {
    var msg = el('cust-add-msg');
    if (msg) msg.style.display = 'none';
  }
}

function submitCustomerAdd() {
  var nameEl = el('cust-add-name');
  var phoneEl = el('cust-add-phone');
  var notesEl = el('cust-add-notes');
  var msg = el('cust-add-msg');
  var submitBtn = el('cust-add-submit');
  var name = (nameEl && nameEl.value || '').trim();
  var phone = (phoneEl && phoneEl.value || '').trim();
  var notes = (notesEl && notesEl.value || '').trim();
  if (!name || !phone) {
    if (msg) {
      msg.className = 'state-msg error';
      msg.textContent = portalT('customers.saveRequired');
      msg.style.display = 'block';
    }
    return;
  }
  if (msg) msg.style.display = 'none';
  if (submitBtn) submitBtn.disabled = true;
  var payload = { display_name: name, phone: phone };
  if (notes) payload.notes = notes;
  fetch('/staff/customers' + customersClientQuery(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(function(r) {
    return r.json().then(function(body) { return { ok: r.ok, body: body }; });
  }).then(function(res) {
    if (!res.ok || !res.body || res.body.success !== true) {
      throw new Error((res.body && (res.body.error || res.body.message)) || 'Create failed');
    }
    if (nameEl) nameEl.value = '';
    if (phoneEl) phoneEl.value = '';
    if (notesEl) notesEl.value = '';
    customerToggleAddPanel(false);
    var newPhone = res.body.phone || phone;
    return loadCustomersList().then(function() { loadCustomerDetail(newPhone); });
  }).catch(function(err) {
    if (msg) {
      msg.className = 'state-msg error';
      msg.textContent = portalT('customers.addFailed') + ' ' + err.message;
      msg.style.display = 'block';
    }
  }).finally(function() {
    if (submitBtn) submitBtn.disabled = false;
  });
}

function wireCustomerAddForm() {
  var btn = el('cust-add-btn');
  var panel = el('cust-add-panel');
  var cancel = el('cust-add-cancel');
  var submit = el('cust-add-submit');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', function() { customerToggleAddPanel(); });
  if (cancel && !cancel.dataset.wired) {
    cancel.dataset.wired = '1';
    cancel.addEventListener('click', function() { customerToggleAddPanel(false); });
  }
  if (submit && !submit.dataset.wired) {
    submit.dataset.wired = '1';
    submit.addEventListener('click', function() { submitCustomerAdd(); });
  }
  if (panel && !panel.dataset.wired) {
    panel.dataset.wired = '1';
    panel.addEventListener('keydown', function(ev) {
      if (ev.key === 'Escape') customerToggleAddPanel(false);
    });
  }
}

function loadCustomersTab() {
  wireCustomersTab();
  renderCustomersSchoolContext();
  loadCustomersList();
}
