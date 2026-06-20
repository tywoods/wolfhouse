function scheduleDrawerEditableEnabled(row){
  if (!row || row._isDemo) return false;
  if (!(row._isDbManual || row.record_source === 'staff_manual')) return false;
  return !!(row.booking_id || row.booking_code);
}

function scheduleDrawerEur(cents){
  if (cents == null || isNaN(Number(cents))) return '—';
  return '\u20ac' + (Number(cents) / 100).toFixed(2);
}

function scheduleRenderDrawerPaymentSectionHtml(ctx){
  var pay = (ctx && ctx.payment) || {};
  var items = pay.line_items || [];
  var html = '<div class="ctx-pay-box" id="ps-drawer-payment-box" style="margin-top:14px">';
  html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3);margin-bottom:8px">' +
    escHtml(portalT('schedule.drawer.paymentSection')) + '</div>';
  if (pay.pricing_note){
    html += '<p style="font-size:11px;color:var(--text-3);margin:0 0 8px">' + escHtml(portalT('schedule.drawer.livePricingNote')) + '</p>';
  }
  if (!items.length){
    html += '<div class="ctx-inv-line ctx-none">' + escHtml(portalT('schedule.drawer.noLineItems')) + '</div>';
  } else {
    html += '<div class="ctx-inv-group" id="ps-drawer-line-items">';
    items.forEach(function(li){
      html += '<div class="ctx-inv-line ctx-inv-addon-line">' + escHtml(li.label) +
        ' — ' + escHtml(scheduleDrawerEur(li.line_cents)) + '</div>';
    });
    html += '</div>';
  }
  html += '<div class="ctx-inv-group ctx-inv-totals" style="margin-top:10px">';
  html += '<div class="ctx-inv-total-row"><span class="ctx-inv-total-label">' + escHtml(portalT('schedule.drawer.subtotal')) +
    '</span><span class="ctx-inv-total-amount" id="ps-drawer-subtotal">' + escHtml(scheduleDrawerEur(pay.subtotal_cents)) + '</span></div>';
  html += '<div class="ctx-inv-total-row"><span class="ctx-inv-total-label">' + escHtml(portalT('schedule.drawer.paid')) +
    '</span><span class="ctx-inv-total-amount paid" id="ps-drawer-paid">' + escHtml(scheduleDrawerEur(pay.paid_cents)) + '</span></div>';
  html += '<div class="ctx-inv-total-row"><span class="ctx-inv-total-label">' + escHtml(portalT('schedule.drawer.remaining')) +
    '</span><span class="ctx-inv-total-amount owing" id="ps-drawer-remaining">' + escHtml(scheduleDrawerEur(pay.balance_due_cents)) + '</span></div>';
  html += '<div class="ctx-inv-total-row"><span class="ctx-inv-total-label">' + escHtml(portalT('schedule.col.payment')) +
    '</span><span class="ctx-inv-total-amount" id="ps-drawer-pay-status">' + escHtml(pay.payment_status === 'paid' ? portalT('schedule.payment.paid') : portalT('schedule.payment.unpaid')) + '</span></div>';
  html += '</div>';
  html += scheduleRenderDrawerStripeLinkSectionHtml(ctx);
  html += '</div>';
  return html;
}

function scheduleRenderDrawerStripeLinkSectionHtml(ctx){
  var link = ctx && ctx.stripe_link;
  var url = link && link.checkout_url;
  var stale = !!(ctx && (ctx.stripe_link_stale || (link && link.stale)));
  var html = '<div id="ps-drawer-stripe-box" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-soft)">';
  html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3);margin-bottom:8px">' +
    escHtml(portalT('schedule.drawer.stripeSection')) + '</div>';
  if (stale && url){
    html += '<div class="ctx-pay-record ctx-pay-record-stale" style="margin-bottom:8px"><span class="ctx-pay-record-badge ctx-pay-record-badge-outdated">' +
      escHtml(portalT('schedule.drawer.stripeStale')) + '</span>' +
      '<div class="ctx-pay-record-stale-note">' + escHtml(portalT('schedule.drawer.stripeStaleHint')) + '</div></div>';
  }
  if (url){
    html += '<p style="margin:0 0 6px"><strong>' + escHtml(portalT('schedule.drawer.stripeStatus')) + ':</strong> ' +
      escHtml(String((link && link.payment_status) || 'checkout_created')) + '</p>';
    if (link && link.amount_due_cents != null){
      html += '<p style="margin:0 0 6px"><strong>' + escHtml(portalT('schedule.drawer.stripeAmount')) + ':</strong> ' +
        escHtml(scheduleDrawerEur(link.amount_due_cents)) + '</p>';
    }
    html += '<p style="margin:0 0 8px;word-break:break-all"><a id="ps-drawer-stripe-url" href="' + escHtml(url) + '" target="_blank" rel="noopener">' + escHtml(url) + '</a></p>';
    html += '<div class="portal-schedule-drawer-actions" style="margin-top:0">';
    html += '<button type="button" class="btn btn-ghost" id="ps-drawer-stripe-copy">' + escHtml(portalT('schedule.drawer.stripeCopy')) + '</button>';
    html += '<button type="button" class="btn btn-ghost" id="ps-drawer-stripe-open">' + escHtml(portalT('schedule.drawer.stripeOpen')) + '</button>';
    html += '</div>';
  } else {
    html += '<p style="margin:0 0 8px;color:var(--text-3)">' + escHtml(portalT('schedule.drawer.stripeNone')) + '</p>';
  }
  html += '</div>';
  return html;
}

function scheduleRenderEditableDrawerHtml(row, ctx){
  var comps = (ctx && ctx.components) || {};
  var lessonOn = !!comps.lesson;
  var boardOn = !!comps.surfboard;
  var wetsuitOn = !!comps.wetsuit;
  var html = '<form id="ps-drawer-edit-form" class="portal-schedule-drawer-form" autocomplete="off">';
  html += '<div class="portal-schedule-drawer-hero">';
  html += '<p class="portal-schedule-card-sub" style="margin:0 0 8px">' + escHtml(portalT('schedule.drawer.bookingCode')) + ': ' + escHtml(ctx.booking_code || row.booking_code || '—') + '</p>';
  html += '</div>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-guest">' + escHtml(portalT('schedule.create.guestName')) + '</label>';
  html += '<input id="ps-drawer-guest" type="text" value="' + escHtml(ctx.guest_name || '') + '"></div>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-phone">' + escHtml(portalT('schedule.drawer.phone')) + '</label>';
  html += '<input id="ps-drawer-phone" type="tel" value="' + escHtml(ctx.phone || '') + '"></div>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-date-from">' + escHtml(portalT('schedule.create.dateFrom')) + '</label>';
  html += '<input id="ps-drawer-date-from" type="date" value="' + escHtml(ctx.date_from || '') + '"></div>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-date-to">' + escHtml(portalT('schedule.create.dateTo')) + '</label>';
  html += '<input id="ps-drawer-date-to" type="date" value="' + escHtml(ctx.date_to || ctx.date_from || '') + '"></div>';
  html += '<div class="portal-schedule-create-field"><span class="portal-schedule-create-label">' + escHtml(portalT('schedule.create.components')) + '</span>';
  html += '<label class="portal-schedule-create-check"><input type="checkbox" id="ps-drawer-comp-lesson"' + (lessonOn ? ' checked' : '') + '> ' + escHtml(portalT('schedule.type.lesson')) + '</label>';
  html += '<label class="portal-schedule-create-check"><input type="checkbox" id="ps-drawer-comp-surfboard"' + (boardOn ? ' checked' : '') + '> ' + escHtml(portalT('schedule.type.boardRental')) + '</label>';
  html += '<label class="portal-schedule-create-check"><input type="checkbox" id="ps-drawer-comp-wetsuit"' + (wetsuitOn ? ' checked' : '') + '> ' + escHtml(portalT('schedule.type.wetsuitRental')) + '</label></div>';
  html += '<div class="portal-schedule-create-field" id="ps-drawer-lesson-fields"><label for="ps-drawer-time-slot">' + escHtml(portalT('schedule.create.lessonSlot')) + '</label><select id="ps-drawer-time-slot"></select></div>';
  html += '<div class="portal-schedule-create-field" id="ps-drawer-lesson-qty-wrap"><label for="ps-drawer-lesson-qty">' + escHtml(portalT('schedule.create.surferCount')) + '</label>';
  html += '<input id="ps-drawer-lesson-qty" type="number" min="1" max="99" value="' + escHtml(String((comps.lesson && comps.lesson.quantity) || 1)) + '"></div>';
  html += '<div class="portal-schedule-create-field" id="ps-drawer-board-qty-wrap"><label for="ps-drawer-board-qty">' + escHtml(portalT('schedule.create.boardQty')) + '</label>';
  html += '<input id="ps-drawer-board-qty" type="number" min="1" max="99" value="' + escHtml(String((comps.surfboard && comps.surfboard.quantity) || 1)) + '"></div>';
  html += '<div class="portal-schedule-create-field" id="ps-drawer-wetsuit-qty-wrap"><label for="ps-drawer-wetsuit-qty">' + escHtml(portalT('schedule.create.wetsuitQty')) + '</label>';
  html += '<input id="ps-drawer-wetsuit-qty" type="number" min="1" max="99" value="' + escHtml(String((comps.wetsuit && comps.wetsuit.quantity) || 1)) + '"></div>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-payment">' + escHtml(portalT('schedule.create.payment')) + '</label>';
  html += '<select id="ps-drawer-payment"><option value="unpaid"' + (ctx.payment_status !== 'paid' ? ' selected' : '') + '>' + escHtml(portalT('schedule.payment.unpaid')) + '</option>';
  html += '<option value="paid"' + (ctx.payment_status === 'paid' ? ' selected' : '') + '>' + escHtml(portalT('schedule.payment.paid')) + '</option></select></div>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-notes">' + escHtml(portalT('schedule.drawer.notes')) + '</label>';
  html += '<textarea id="ps-drawer-notes" rows="2">' + escHtml(ctx.notes || '') + '</textarea></div>';
  html += scheduleRenderDrawerPaymentSectionHtml(ctx);
  html += '<p id="ps-drawer-save-msg" class="state-msg" style="display:none;margin-top:8px"></p>';
  html += '<p id="ps-drawer-stripe-msg" class="state-msg" style="display:none;margin-top:8px"></p>';
  html += '<div class="portal-schedule-drawer-actions">';
  html += '<button type="button" class="btn btn-primary" id="ps-drawer-save">' + escHtml(portalT('schedule.drawer.save')) + '</button>';
  var stripeAvail = ctx && ctx.stripe_available;
  var stripeLabel = (ctx && ctx.stripe_link && ctx.stripe_link.checkout_url && !ctx.stripe_link_stale)
    ? portalT('schedule.drawer.stripeRegenerate') : portalT('schedule.drawer.stripeLink');
  if (stripeAvail){
    html += '<button type="button" class="btn btn-ghost" id="ps-drawer-stripe-link">' + escHtml(stripeLabel) + '</button>';
  } else {
    html += '<button type="button" class="btn btn-ghost" disabled title="' + escHtml(portalT('schedule.drawer.stripeUnavailable')) + '">' + escHtml(portalT('schedule.drawer.stripeLink')) + '</button>';
  }
  html += '<button type="button" class="btn btn-ghost" id="ps-drawer-conversation-btn">' + escHtml(portalT('schedule.drawer.startConv')) + '</button>';
  html += '</div>';
  html += '<p id="ps-drawer-conversation-hint" class="portal-schedule-drawer-hint" style="display:none"></p>';
  html += '</form>';
  return html;
}

function scheduleDrawerPopulateComponentFields(){
  var lessonOn = !!(el('ps-drawer-comp-lesson') && el('ps-drawer-comp-lesson').checked);
  var boardOn = !!(el('ps-drawer-comp-surfboard') && el('ps-drawer-comp-surfboard').checked);
  var wetsuitOn = !!(el('ps-drawer-comp-wetsuit') && el('ps-drawer-comp-wetsuit').checked);
  var lf = el('ps-drawer-lesson-fields');
  var lq = el('ps-drawer-lesson-qty-wrap');
  var bq = el('ps-drawer-board-qty-wrap');
  var wq = el('ps-drawer-wetsuit-qty-wrap');
  if (lf) lf.style.display = lessonOn ? '' : 'none';
  if (lq) lq.style.display = lessonOn ? '' : 'none';
  if (bq) bq.style.display = boardOn ? '' : 'none';
  if (wq) wq.style.display = wetsuitOn ? '' : 'none';
}

function scheduleDrawerPopulateTimeSlot(selected){
  var sel = el('ps-drawer-time-slot');
  if (!sel) return Promise.resolve();
  return scheduleFetchLessonTimesConfig(getClient()).then(function(times){
    sel.innerHTML = '';
    var slots = scheduleUniqueConfiguredSlots(times);
    if (!slots.length){
      var opt = document.createElement('option');
      opt.value = selected || '';
      opt.textContent = selected || portalT('schedule.slot.noConfiguredTimes');
      sel.appendChild(opt);
      return;
    }
    slots.forEach(function(s){
      var opt = document.createElement('option');
      opt.value = scheduleNormalizeSlotTime(s.slot_time);
      opt.textContent = s.label ? (scheduleNormalizeSlotTime(s.slot_time) + ' — ' + s.label) : scheduleNormalizeSlotTime(s.slot_time);
      sel.appendChild(opt);
    });
    if (selected) sel.value = scheduleNormalizeSlotTime(selected);
  });
}

function scheduleReadDrawerEditPayload(){
  var guest = (el('ps-drawer-guest') && el('ps-drawer-guest').value || '').trim();
  var phone = (el('ps-drawer-phone') && el('ps-drawer-phone').value || '').trim();
  var dateFrom = el('ps-drawer-date-from') ? el('ps-drawer-date-from').value : '';
  var dateTo = el('ps-drawer-date-to') ? el('ps-drawer-date-to').value : dateFrom;
  var payment = el('ps-drawer-payment') ? el('ps-drawer-payment').value : 'unpaid';
  var notes = (el('ps-drawer-notes') && el('ps-drawer-notes').value || '').trim();
  var components = {};
  if (el('ps-drawer-comp-lesson') && el('ps-drawer-comp-lesson').checked){
    components.lesson = {
      quantity: parseInt((el('ps-drawer-lesson-qty') && el('ps-drawer-lesson-qty').value) || '1', 10) || 1,
      slot_time: (el('ps-drawer-time-slot') && el('ps-drawer-time-slot').value) || '',
      category: portalT('schedule.create.lessonCategory'),
    };
  }
  if (el('ps-drawer-comp-surfboard') && el('ps-drawer-comp-surfboard').checked){
    components.surfboard = { quantity: parseInt((el('ps-drawer-board-qty') && el('ps-drawer-board-qty').value) || '1', 10) || 1 };
  }
  if (el('ps-drawer-comp-wetsuit') && el('ps-drawer-comp-wetsuit').checked){
    components.wetsuit = { quantity: parseInt((el('ps-drawer-wetsuit-qty') && el('ps-drawer-wetsuit-qty').value) || '1', 10) || 1 };
  }
  return { guest_name: guest, guest_phone: phone || null, date_from: dateFrom, date_to: dateTo, payment_status: payment, notes: notes, components: components };
}


function scheduleWireEditableDrawer(row, ctx){
  if (!ctx || !ctx.payment) return;
  var pay = ctx.payment;
  var box = el('ps-drawer-payment-box');
  if (!box) return;
  var tmp = document.createElement('div');
  tmp.innerHTML = scheduleRenderDrawerPaymentSectionHtml(ctx);
  var fresh = tmp.firstChild;
  if (fresh) box.parentNode.replaceChild(fresh, box);
  scheduleWireDrawerStripeCopyOpen(ctx);
}

function scheduleWireDrawerStripeCopyOpen(ctx){
  var url = ctx && ctx.stripe_link && ctx.stripe_link.checkout_url;
  var copyBtn = el('ps-drawer-stripe-copy');
  var openBtn = el('ps-drawer-stripe-open');
  if (copyBtn && url){
    copyBtn.onclick = function(){
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url);
    };
  }
  if (openBtn && url){
    openBtn.onclick = function(){ window.open(url, '_blank', 'noopener'); };
  }
}

function scheduleWireDrawerConversation(row, group){
  var linkedConv = scheduleFindLinkedConversation(group || row);
  var hasPhone = scheduleGroupHasPhone(group || row) || !!(el('ps-drawer-phone') && el('ps-drawer-phone').value.trim());
  var convBtn = el('ps-drawer-conversation-btn');
  var convHint = el('ps-drawer-conversation-hint');
  if (!convBtn) return;
  if (linkedConv){
    convBtn.textContent = portalT('schedule.drawer.openConv');
    convBtn.disabled = false;
    convBtn.onclick = function(){ scheduleOpenOrStartConversationFromBooking(group || row); };
  } else if (hasPhone){
    convBtn.textContent = portalT('schedule.drawer.startConv');
    convBtn.disabled = false;
    convBtn.onclick = function(){ scheduleOpenOrStartConversationFromBooking(group || row); };
  } else {
    convBtn.textContent = portalT('schedule.drawer.startConv');
    convBtn.disabled = true;
    convBtn.title = portalT('schedule.drawer.conversationNeedPhone');
    if (convHint){
      convHint.textContent = portalT('schedule.drawer.conversationNeedPhone');
      convHint.style.display = 'block';
    }
  }
}

function scheduleSaveDrawerBooking(row){
  if (!row || !row.booking_id) return;
  var payload = scheduleReadDrawerEditPayload();
  var saveBtn = el('ps-drawer-save');
  var msg = el('ps-drawer-save-msg');
  if (!payload.guest_name){
    if (msg){ msg.className = 'state-msg error'; msg.textContent = portalT('schedule.create.guestRequired'); msg.style.display = 'block'; }
    return;
  }
  if (!Object.keys(payload.components).length){
    if (msg){ msg.className = 'state-msg error'; msg.textContent = portalT('schedule.create.componentsRequired'); msg.style.display = 'block'; }
    return;
  }
  if (saveBtn) saveBtn.disabled = true;
  if (msg) msg.style.display = 'none';
  fetch('/staff/schedule/bookings?client=' + encodeURIComponent(getClient()), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ booking_id: row.booking_id }, payload)),
  }).then(function(r){ return r.json().then(function(data){ return { ok: r.ok, data: data }; }); })
    .then(function(res){
      if (!res.ok || !res.data || res.data.success !== true) throw new Error((res.data && (res.data.error || res.data.message)) || 'Save failed');
      if (res.data.context) scheduleUpdateDrawerPaymentFromContext(res.data.context);
      if (msg){ msg.className = 'state-msg success'; msg.textContent = portalT('schedule.drawer.saved'); msg.style.display = 'block'; }
      loadSchedulePage();
    })
    .catch(function(err){
      if (msg){ msg.className = 'state-msg error'; msg.textContent = portalT('schedule.drawer.saveFailed') + ' ' + err.message; msg.style.display = 'block'; }
    })
    .finally(function(){ if (saveBtn) saveBtn.disabled = false; });
}

function scheduleCreateDrawerStripeLink(row){
  if (!row || !row.booking_id) return;
  var btn = el('ps-drawer-stripe-link');
  var msg = el('ps-drawer-stripe-msg');
  if (btn) btn.disabled = true;
  if (msg){ msg.style.display = 'none'; msg.textContent = ''; }
  fetch('/staff/schedule/bookings/stripe-link?client=' + encodeURIComponent(getClient()), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ booking_id: row.booking_id, idempotency_key: 'sunset-drawer-' + row.booking_id + '-' + Date.now() }),
  }).then(function(r){ return r.json().then(function(data){ return { ok: r.ok, data: data }; }); })
    .then(function(res){
      if (!res.ok || !res.data || res.data.success !== true) throw new Error((res.data && (res.data.error || res.data.message)) || 'Stripe link failed');
      return fetch('/staff/schedule/bookings/detail?client=' + encodeURIComponent(getClient()) + '&booking_id=' + encodeURIComponent(row.booking_id))
        .then(function(r2){ return r2.json(); });
    })
    .then(function(ctxData){
      if (ctxData && ctxData.success) scheduleUpdateDrawerPaymentFromContext(ctxData);
      if (msg){ msg.className = 'state-msg success'; msg.textContent = portalT('schedule.drawer.stripeCreated'); msg.style.display = 'block'; }
      var stripeBtn = el('ps-drawer-stripe-link');
      if (stripeBtn) stripeBtn.textContent = portalT('schedule.drawer.stripeRegenerate');
    })
    .catch(function(err){
      if (msg){ msg.className = 'state-msg error'; msg.textContent = portalT('schedule.drawer.stripeFailed') + ' ' + err.message; msg.style.display = 'block'; }
    })
    .finally(function(){ if (btn) btn.disabled = false; });
}

function scheduleWireEditableDrawer(row, ctx){
  var group = scheduleFindGroupForRow(row) || row;
  scheduleDrawerPopulateComponentFields();
  scheduleDrawerPopulateTimeSlot((ctx && ctx.slot_time) || (ctx.components && ctx.components.lesson && ctx.components.lesson.slot_time) || '');
  ['ps-drawer-comp-lesson','ps-drawer-comp-surfboard','ps-drawer-comp-wetsuit'].forEach(function(id){
    var node = el(id);
    if (node) node.addEventListener('change', scheduleDrawerPopulateComponentFields);
  });
  scheduleWireDrawerStripeCopyOpen(ctx);
  scheduleWireDrawerConversation(row, group);
  var saveBtn = el('ps-drawer-save');
  if (saveBtn) saveBtn.addEventListener('click', function(){ scheduleSaveDrawerBooking(row); });
  var stripeBtn = el('ps-drawer-stripe-link');
  if (stripeBtn) stripeBtn.addEventListener('click', function(){ scheduleCreateDrawerStripeLink(row); });
}

function scheduleOpenEditableDrawer(row, ctx){
  var drawer = el('ps-detail-drawer');
  var backdrop = el('ps-drawer-backdrop');
  var body = el('ps-drawer-body');
  if (!drawer || !body) return;
  body.innerHTML = scheduleRenderEditableDrawerHtml(row, ctx);
  drawer.style.display = 'block';
  if (backdrop) backdrop.style.display = 'block';
  scheduleLastDrawerRowId = row._scheduleId;
  scheduleWireEditableDrawer(row, ctx);
}

function scheduleFetchDrawerContext(row){
  var q = 'client=' + encodeURIComponent(getClient());
  if (row.booking_id) q += '&booking_id=' + encodeURIComponent(row.booking_id);
  else if (row.booking_code) q += '&booking_code=' + encodeURIComponent(row.booking_code);
  return fetch('/staff/schedule/bookings/detail?' + q).then(function(r){ return r.json(); });
}
