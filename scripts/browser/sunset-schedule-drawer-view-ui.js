'use strict';

/**
 * Sunset Schedule drawer — read-only view rendering (Slice 12).
 *
 * Injected into staff-query-api.js portal IIFE. Consumes canonical drawer-detail
 * ctx only; no fetch, price authority, or payment lifecycle decisions.
 *
 * Requires portal globals: portalT, escHtml, isSunsetSurfActive, getClient,
 * getPortalProfile, portalHasCustomersCrm, getSunsetLocation, getSunsetLocationLabel,
 * scheduleRowSourceDrawerLabel, scheduleResolveDrawerSchoolLabel,
 * scheduleResolveCourseDisplayLabel, scheduleFormatRange, scheduleParseIso,
 * schedulePortalStripeLinkFromCtx, scheduleDrawerCanEdit, scheduleDrawerPaymentShortUrl.
 */

function scheduleRenderDrawerLoadingHtml() {
  return '<div class="state-msg">' + escHtml(portalT('schedule.drawer.loading')) + '</div>';
}

function scheduleRenderDrawerErrorHtml(errMsg, reasonCode) {
  var msg = errMsg || portalT('schedule.drawer.loadFailed');
  var code = reasonCode ? (' <span class="portal-schedule-drawer-error-code">(' + escHtml(String(reasonCode)) + ')</span>') : '';
  return '<div class="state-msg error">' + escHtml(msg) + code + '</div>';
}

function scheduleDrawerViewResolveStripe(ctx) {
  if (typeof schedulePortalStripeLinkFromCtx === 'function') {
    return schedulePortalStripeLinkFromCtx(ctx);
  }
  var link = ctx && ctx.stripe_link;
  return {
    url: (link && link.checkout_url) || '',
    actionable: !!(link && link.checkout_url && link.actionable !== false),
    stale: !!(ctx && (ctx.stripe_link_stale || ctx.payment_link_invalidated)),
    payment_id: link && link.payment_id,
  };
}

function scheduleDrawerSectionHtml(titleKey, innerHtml){
  return '<section class="portal-schedule-drawer-section">' +
    '<h4 class="portal-schedule-drawer-section-title">' + escHtml(portalT(titleKey)) + '</h4>' +
    innerHtml + '</section>';
}

function scheduleRenderDeleteBookingRowHtml(ctx){
  if (!(ctx && ctx.booking_id)) return '';
  return '<div class="portal-schedule-drawer-danger-row">' +
    '<button type="button" class="btn portal-schedule-delete-booking-btn" id="ps-drawer-delete-booking">' +
    escHtml(portalT('schedule.drawer.deleteBooking')) + '</button></div>';
}

function scheduleFormatComponentsView(comps){
  if (!comps || typeof comps !== 'object') return '—';
  var parts = [];
  if (comps.course){
    var courseLabel = scheduleResolveCourseDisplayLabel(comps.course.course_id, comps.course.course_label);
    parts.push(portalT('schedule.type.course') + ' · ' + courseLabel + ' × ' + String(comps.course.quantity || 1));
  } else if (comps.private_lesson){
    parts.push(portalT('schedule.type.privateCourse') + ' × ' + String(comps.private_lesson.quantity || comps.private_lesson.surfer_count || 1));
  } else if (comps.lesson){
    var slot = comps.lesson.slot_time ? (' @ ' + comps.lesson.slot_time) : '';
    parts.push(portalT('schedule.type.course') + slot + ' × ' + String(comps.lesson.quantity || 1));
  }
  if (comps.surfboard) parts.push(portalT('schedule.type.boardRental') + ' × ' + String(comps.surfboard.quantity || 1));
  if (comps.wetsuit) parts.push(portalT('schedule.type.wetsuitRental') + ' × ' + String(comps.wetsuit.quantity || 1));
  return parts.length ? parts.join(' · ') : '—';
}

function scheduleRenderDrawerOpenCustomerBtnHtml(ctx){
  var profile = getPortalProfile(getClient());
  if (!portalHasCustomersCrm(profile)) return '';
  var phone = ctx && ctx.phone;
  if (!phone) return '';
  return '<button type="button" class="btn btn-ghost" id="ps-drawer-open-customer" data-customer-phone="' + escHtml(String(phone)) + '">' +
    escHtml(portalT('schedule.drawer.openCustomer')) + '</button>';
}

function scheduleRenderDrawerWaiverSectionHtml(ctx){
  if (!isSunsetSurfActive() || getClient() !== 'sunset') return '';
  if (!(ctx && ctx.booking_id)) return '';
  return scheduleDrawerSectionHtml('schedule.drawer.waiverTitle',
    '<div id="ps-drawer-waiver-box"><p class="portal-schedule-drawer-hint" style="margin:0">' +
    escHtml(portalT('schedule.drawer.waiverLoading')) + '</p></div>');
}

function scheduleDateOnlyLabel(val){
  if (!val) return '—';
  var s = String(val).trim();
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function scheduleDrawerSameDay(ctx){
  var from = scheduleDateOnlyLabel(ctx && ctx.date_from);
  var to = scheduleDateOnlyLabel(ctx && ctx.date_to) || from;
  if (!from || from === '—') return true;
  return from === to;
}

function scheduleFormatDrawerDateDisplay(iso){
  if (!iso) return '—';
  var s = scheduleDateOnlyLabel(iso);
  if (s === '—') return '—';
  try {
    return scheduleParseIso(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (_) { return s; }
}

function scheduleFormatDrawerDateRangeText(ctx){
  var from = scheduleDateOnlyLabel(ctx && ctx.date_from);
  var to = scheduleDateOnlyLabel(ctx && ctx.date_to) || from;
  if (!from || from === '—') return '—';
  if (from === to) return scheduleFormatDrawerDateDisplay(from);
  try {
    return scheduleFormatRange(scheduleParseIso(from), scheduleParseIso(to));
  } catch (_) { return from + ' – ' + to; }
}

function scheduleRenderDrawerHeroMetadataLine(ctx, row){
  var parts = [
    scheduleResolveDrawerSchoolLabel(ctx, row),
    scheduleFormatDrawerDateRangeText(ctx),
    scheduleRowSourceDrawerLabel(row),
  ];
  return parts.filter(function(p){ return p && p !== '—'; }).join(' · ');
}

function scheduleRenderDrawerViewDateRow(ctx){
  var sameDay = scheduleDrawerSameDay(ctx);
  var labelKey = sameDay ? 'schedule.create.date' : 'schedule.drawer.section.dates';
  var value = sameDay ? scheduleFormatDrawerDateDisplay(ctx.date_from) : scheduleFormatDrawerDateRangeText(ctx);
  return '<p class="portal-schedule-drawer-kv portal-schedule-drawer-summary-kv"><strong>' +
    escHtml(portalT(labelKey)) + ':</strong> ' + escHtml(value) + '</p>';
}

function scheduleRenderDrawerBookedItemsRow(comps){
  var summary = scheduleFormatComponentsView(comps);
  if (!summary || summary === '—') return '';
  return '<p class="portal-schedule-drawer-kv portal-schedule-drawer-summary-kv portal-schedule-drawer-booked-items"><strong>' +
    escHtml(portalT('schedule.drawer.bookedItems')) + ':</strong> ' + escHtml(summary) + '</p>';
}

function scheduleRenderDrawerViewBookingDetailsHtml(ctx, row){
  if (!isSunsetSurfActive()) {
    return '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.create.guestName')) + ':</strong> ' + escHtml(ctx.guest_name || '—') + '</p>' +
      '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.drawer.phone')) + ':</strong> ' + escHtml(ctx.phone || '—') + '</p>' +
      '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.drawer.source')) + ':</strong> ' + escHtml(scheduleRowSourceDrawerLabel(row)) + '</p>' +
      '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.create.dateFrom')) + ':</strong> ' + escHtml(ctx.date_from || '—') + '</p>' +
      '<p class="portal-schedule-drawer-kv" style="margin:0"><strong>' + escHtml(portalT('schedule.create.dateTo')) + ':</strong> ' + escHtml(ctx.date_to || ctx.date_from || '—') + '</p>';
  }
  return '<p class="portal-schedule-drawer-kv portal-schedule-drawer-summary-kv"><strong>' + escHtml(portalT('schedule.drawer.phone')) + ':</strong> ' + escHtml(ctx.phone || '—') + '</p>' +
    scheduleRenderDrawerViewDateRow(ctx) +
    scheduleRenderDrawerBookedItemsRow((ctx && ctx.components) || {});
}

function scheduleRenderDrawerHeroHtml(ctx, row){
  var code = (ctx && ctx.booking_code) || (row && row.booking_code) || '—';
  var name = (ctx && ctx.guest_name) || (row && row.guest_name) || 'Guest';
  var sunset = isSunsetSurfActive();
  var html = '<div class="portal-schedule-drawer-hero">';
  html += '<div class="portal-schedule-drawer-hero-inner">';
  html += '<div class="portal-schedule-drawer-hero-text">';
  var titleAttr = (sunset && code !== '—')
    ? ' title="' + escHtml(portalT('schedule.drawer.bookingCode') + ': ' + code) + '"'
    : '';
  html += '<h3 class="portal-schedule-drawer-hero-title"' + titleAttr + '>' + escHtml(name) + '</h3>';
  if (sunset) {
    // Meta line (school · dates · source) removed — dates live in the booking card; source is rarely needed.
    if (code !== '—') {
      html += '<div class="portal-schedule-drawer-booking-code portal-schedule-drawer-booking-code-subtle ps-code-row">' +
        '<span>' + escHtml(code) + '</span>' +
        '<button type="button" class="btn btn-ghost ps-copy-icon ps-code-copy" id="ps-drawer-copy-code" data-copy="' + escHtml(code) + '" title="' + escHtml(portalT('schedule.drawer.copyCode')) + '" aria-label="' + escHtml(portalT('schedule.drawer.copyCode')) + '">&#10697;</button></div>';
    }
  } else {
    html += '<p class="portal-schedule-drawer-booking-code">' + escHtml(code) + '</p>';
  }
  html += '</div>';
  html += '<div class="portal-schedule-drawer-hero-actions">';
  html += '<button type="button" class="btn btn-ghost portal-schedule-refresh-btn" id="ps-drawer-refresh" title="' + escHtml(portalT('schedule.refresh')) + '" aria-label="' + escHtml(portalT('schedule.refresh')) + '">&#8635;</button>';
  if (sunset) {
    html += '<button type="button" class="btn btn-ghost portal-schedule-drawer-close-btn" id="ps-drawer-close" title="' + escHtml(portalT('schedule.drawer.close')) + '" aria-label="' + escHtml(portalT('schedule.drawer.close')) + '">&#10005;</button>';
  } else {
    html += '<button type="button" class="btn btn-ghost" id="ps-drawer-close">' + escHtml(portalT('schedule.drawer.close')) + '</button>';
  }
  html += '</div></div></div>';
  return html;
}

function scheduleDrawerStripLabelDate(label){
  // NB: regex literals with \d/\s break when this client JS is embedded in the /staff/ui
  // template bundle (backslashes are eaten). Use [0-9] classes — no backslashes — so it survives.
  return String(label == null ? '' : label)
    .replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}/g, '')
    .replace(/[^0-9A-Za-z)]+$/, '')
    .replace(/  +/g, ' ')
    .trim();
}

function scheduleDrawerDDMMYY(iso){
  var s = scheduleDateOnlyLabel(iso);
  if (!s || s === '—' || s.length < 10) return '';
  return s.slice(8, 10) + '-' + s.slice(5, 7) + '-' + s.slice(2, 4);
}

function scheduleDrawerCopyIconBtnHtml(id, labelKey){
  var key = labelKey || 'schedule.drawer.copyLink';
  return '<button type="button" class="btn btn-ghost ps-copy-icon" id="' + id + '" title="' +
    escHtml(portalT(key)) + '" aria-label="' + escHtml(portalT(key)) + '">&#10697;</button>';
}

function scheduleDrawerPaidMethodLabel(method){
  var m = String(method || '').toLowerCase();
  if (m === 'bank_transfer') return portalT('schedule.drawer.methodBankTransfer');
  if (m === 'in_store') return portalT('schedule.drawer.methodInShop');
  if (m === 'link') return portalT('schedule.drawer.methodCard');
  return '';
}

function scheduleDrawerServiceTypeLabel(t){
  var s = String(t || '').toLowerCase();
  if (s.indexOf('lesson') >= 0 || s.indexOf('course') >= 0) return portalT('schedule.type.course');
  if (s.indexOf('board') >= 0) return portalT('schedule.type.boardRental');
  if (s.indexOf('suit') >= 0) return portalT('schedule.type.wetsuitRental');
  return String(t || '—');
}

function scheduleDrawerServiceOrder(t){
  var s = String(t || '').toLowerCase();
  if (s.indexOf('lesson') >= 0 || s.indexOf('course') >= 0 || s.indexOf('private') >= 0) return 0;
  if (s.indexOf('board') >= 0) return 1;
  if (s.indexOf('suit') >= 0) return 2;
  return 3;
}

function scheduleDrawerSortItems(items){
  return (items || []).slice().sort(function(a, b){
    return scheduleDrawerServiceOrder(a.service_type) - scheduleDrawerServiceOrder(b.service_type);
  });
}

function scheduleDrawerDayHeaderLabel(iso){
  var s = scheduleDateOnlyLabel(iso);
  if (!s || s === '—') return '—';
  try { return scheduleParseIso(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); }
  catch (_) { return s; }
}

function scheduleRenderMoneyHeadlineHtml(ctx){
  var pay = (ctx && ctx.payment) || {};
  var paid = Number(pay.paid_cents || 0);
  var sub = Number(pay.subtotal_cents || 0);
  var due = (pay.balance_due_cents != null) ? Number(pay.balance_due_cents) : null;
  var fullyPaid = pay.payment_status === 'paid' || (sub > 0 && due != null && due <= 0 && paid > 0);
  var cls = fullyPaid ? 'is-paid' : (paid > 0 ? 'is-partial' : 'is-due');
  var big;
  if (fullyPaid){
    var method = scheduleDrawerPaidMethodLabel(ctx && ctx.payment_method);
    big = portalT('schedule.drawer.paidInFull') + (method ? ' · ' + method : '');
  } else {
    big = (due != null ? scheduleDrawerEur(due) : '—') + ' ' + portalT('schedule.drawer.dueSuffix');
  }
  return '<div class="ps-money-headline ' + cls + '">' + escHtml(big) + '</div>' +
    '<div class="ps-money-sub">' + escHtml(portalT('schedule.drawer.subtotal') + ' ' + scheduleDrawerEur(sub) +
      ' · ' + portalT('schedule.drawer.paid') + ' ' + scheduleDrawerEur(paid)) + '</div>';
}

function scheduleRenderSunsetMoneyActionsHtml(ctx){
  var stripeAvail = ctx && ctx.stripe_available;
  var resolved = scheduleDrawerViewResolveStripe(ctx);
  var url = resolved.actionable ? resolved.url : '';
  var stale = resolved.stale;
  var displayUrl = (typeof scheduleDrawerPaymentShortUrl === 'function' ? scheduleDrawerPaymentShortUrl(ctx) : '') || url;
  var html = '';
  if (url){
    html += '<p class="ps-money-linkmeta"><span class="ps-money-linkactive">' + escHtml(portalT('schedule.drawer.paymentLinkActive')) + '</span></p>';
    if (stale){ html += '<p class="portal-schedule-drawer-hint" style="color:#9C5742;margin:2px 0 0">' + escHtml(portalT('schedule.drawer.stripeStaleHint')) + '</p>'; }
    html += '<div class="ps-money-link-row"><a id="ps-drawer-stripe-url" href="' + escHtml(displayUrl) + '" target="_blank" rel="noopener" class="ps-money-link-a">' + escHtml(displayUrl) + '</a>' + scheduleDrawerCopyIconBtnHtml('ps-drawer-stripe-copy') + '</div>';
    html += '<details class="ps-drawer-details"><summary>' + escHtml(portalT('schedule.drawer.moreStripeOptions')) + '</summary><div class="ps-overflow-actions ps-overflow-row"><button type="button" class="btn btn-ghost portal-schedule-stripe-delete-btn" id="ps-drawer-stripe-delete">' + escHtml(portalT('schedule.drawer.stripeDelete')) + '</button></div></details>';
  } else if (stripeAvail){
    html += '<div class="ps-money-actions"><button type="button" class="btn btn-primary" id="ps-drawer-stripe-link">' + escHtml(portalT('schedule.drawer.createPaymentLink')) + '</button></div>';
  } else {
    html += '<div class="ps-money-actions"><button type="button" class="btn btn-ghost" disabled title="' + escHtml(portalT('schedule.drawer.stripeUnavailable')) + '">' + escHtml(portalT('schedule.drawer.createPaymentLink')) + '</button></div>';
  }
  return html;
}

function scheduleRenderSunsetRecordPaymentHtml(ctx){
  if (!(ctx && ctx.booking_id)) return '';
  var html = '<details class="ps-drawer-details"><summary>' + escHtml(portalT('schedule.drawer.recordPayment')) + '</summary>';
  html += '<div id="ps-drawer-manual-pay" style="margin-top:8px">';
  html += '<div class="portal-schedule-manual-pay-grid">';
  html += '<label>' + escHtml(portalT('schedule.drawer.manualPayAmount')) +
    '<input id="ps-drawer-manual-amount" type="number" min="0" step="0.01" inputmode="decimal"></label>';
  html += '<label>' + escHtml(portalT('schedule.drawer.manualPayMethod')) +
    '<select id="ps-drawer-manual-method">' +
    '<option value="bank_transfer">' + escHtml(portalT('schedule.payment.paidBankTransfer')) + '</option>' +
    '<option value="in_store">' + escHtml(portalT('schedule.payment.paidInStore')) + '</option>' +
    '</select></label>';
  html += '</div>';
  html += '<label class="portal-schedule-manual-pay-note">' + escHtml(portalT('schedule.drawer.manualPayNote')) +
    '<input id="ps-drawer-manual-note" type="text" maxlength="200"></label>';
  html += '<button type="button" class="btn btn-ghost" id="ps-drawer-manual-submit" style="margin-top:8px">' +
    escHtml(portalT('schedule.drawer.manualPaySubmit')) + '</button>';
  html += '<p id="ps-drawer-manual-msg" class="state-msg" style="display:none;margin-top:6px"></p>';
  html += '</div></details>';
  return html;
}

function scheduleRenderSunsetMoneyCardHtml(ctx){
  var pay = (ctx && ctx.payment) || {};
  var html = '<div class="ctx-pay-box ps-money-card" id="ps-drawer-payment-box" style="margin-top:0">';
  html += '<div class="ps-card-eyebrow">' + escHtml(portalT('schedule.drawer.paymentsTitle')) + '</div>';
  html += scheduleRenderMoneyHeadlineHtml(ctx);
  html += scheduleRenderSunsetMoneyActionsHtml(ctx);
  html += scheduleRenderSunsetRecordPaymentHtml(ctx);
  html += '</div>';
  return html;
}

function scheduleRenderSunsetBookingCardHtml(ctx){
  var pay = (ctx && ctx.payment) || {};
  var items = pay.line_items || [];
  var comps = (ctx && ctx.components) || {};
  if (!items.length){
    var summary = scheduleFormatComponentsView(comps);
    if (!summary || summary === '—') return '';
    return scheduleDrawerSectionHtml('schedule.drawer.section.booking',
      '<p class="portal-schedule-drawer-kv" style="margin:0">' + escHtml(summary) + '</p>');
  }
  var dayMap = {};
  items.forEach(function(li){ var d = String(li.service_date || '').slice(0, 10); if (d) dayMap[d] = true; });
  var dayKeys = Object.keys(dayMap).sort();
  var dayCount = dayKeys.length || 1;
  // Surfers: course/private/lesson quantity, else max lesson line qty, else guest count.
  var surfers = (comps.course && comps.course.quantity)
    || (comps.private_lesson && (comps.private_lesson.surfer_count || comps.private_lesson.quantity))
    || (comps.lesson && comps.lesson.quantity) || 0;
  if (!surfers){ items.forEach(function(li){ var t = String(li.service_type || ''); if (t.indexOf('lesson') >= 0 || t.indexOf('course') >= 0) surfers = Math.max(surfers, Number(li.quantity) || 0); }); }
  if (!surfers) surfers = Number(ctx && ctx.guest_count) || 1;
  var hasCourse = !!(comps.course || comps.private_lesson || comps.lesson);
  if (!hasCourse){ items.forEach(function(li){ var t = String(li.service_type || ''); if (t.indexOf('lesson') >= 0 || t.indexOf('course') >= 0) hasCourse = true; }); }
  var daysLabel = dayCount + ' ' + (dayCount === 1 ? portalT('schedule.drawer.dayWordCap') : portalT('schedule.drawer.daysWordCap'));
  var title = hasCourse
    ? (surfers + ' ' + (surfers === 1 ? portalT('schedule.drawer.surferWord') : portalT('schedule.drawer.surfersWord')) + ' · ' + daysLabel)
    : daysLabel;
  var from = scheduleDrawerDDMMYY(ctx && ctx.date_from);
  var to = scheduleDrawerDDMMYY((ctx && ctx.date_to) || (ctx && ctx.date_from));
  var subtitle = from ? (portalT('schedule.drawer.dateLabel') + ': ' + from + (to && to !== from ? ' - ' + to : '')) : '';
  var head = '<h4 class="portal-schedule-drawer-section-title">' + escHtml(title) + '</h4>' +
    (subtitle ? '<p class="ps-card-subtitle">' + escHtml(subtitle) + '</p>' : '');
  var body = '';
  if (dayCount <= 1){
    scheduleDrawerSortItems(items).forEach(function(li){
      body += '<div class="ps-day-row"><span>' + escHtml(scheduleDrawerStripLabelDate(li.label)) +
        '</span><span class="ps-day-amt">' + escHtml(scheduleDrawerEur(li.line_cents)) + '</span></div>';
    });
  } else {
    var byType = {}, order = [];
    items.forEach(function(li){
      var t = String(li.service_type || '');
      if (!byType[t]){ byType[t] = { name: scheduleDrawerServiceTypeLabel(t), cents: 0 }; order.push(t); }
      byType[t].cents += Number(li.line_cents || 0);
    });
    order.sort(function(a, b){ return scheduleDrawerServiceOrder(a) - scheduleDrawerServiceOrder(b); });
    var courseLabel = (comps.course && comps.course.course_label) || '';
    order.forEach(function(t){
      var b = byType[t];
      var detail = String(t).indexOf('lesson') >= 0 && courseLabel ? courseLabel : '';
      body += '<div class="ps-svc-summary-row"><span class="ps-svc-name">' + escHtml(b.name) +
        (detail ? ' <span class="ps-svc-detail">· ' + escHtml(detail) + '</span>' : '') +
        '</span><span class="ps-svc-amt">' + escHtml(scheduleDrawerEur(b.cents)) + '</span></div>';
    });
    var daily = '';
    dayKeys.forEach(function(d){
      daily += '<div class="ps-day-group"><div class="ps-day-header">' + escHtml(scheduleDrawerDayHeaderLabel(d)) + '</div>';
      scheduleDrawerSortItems(items.filter(function(li){ return String(li.service_date || '').slice(0, 10) === d; })).forEach(function(li){
        daily += '<div class="ps-day-row"><span>' + escHtml(scheduleDrawerStripLabelDate(li.label)) +
          '</span><span class="ps-day-amt">' + escHtml(scheduleDrawerEur(li.line_cents)) + '</span></div>';
      });
      daily += '</div>';
    });
    body += '<details class="ps-drawer-details"><summary>' + escHtml(portalT('schedule.drawer.showDaily')) + '</summary>' + daily + '</details>';
  }
  return '<section class="portal-schedule-drawer-section">' + head + body + '</section>';
}

function scheduleRenderSunsetViewDrawerHtml(row, ctx, canEdit){
  var html = scheduleRenderDrawerHeroHtml(ctx, row);
  html += scheduleRenderSunsetBookingCardHtml(ctx);
  html += scheduleRenderDrawerPaymentSectionHtml(ctx);
  html += scheduleRenderDrawerWaiverSectionHtml(ctx);
  if (ctx.notes) {
    html += scheduleDrawerSectionHtml('schedule.drawer.section.notes',
      '<p class="portal-schedule-drawer-kv" style="margin:0">' + escHtml(ctx.notes) + '</p>');
  }
  html += '<p id="ps-drawer-save-msg" class="state-msg" style="display:none;margin-top:8px"></p>';
  html += '<p id="ps-drawer-stripe-msg" class="state-msg" style="display:none;margin-top:8px"></p>';
  html += '<div class="portal-schedule-drawer-actions">';
  if (canEdit) html += '<button type="button" class="btn btn-primary" id="ps-drawer-edit">' + escHtml(portalT('schedule.drawer.edit')) + '</button>';
  html += '<button type="button" class="btn btn-ghost" id="ps-drawer-conversation-btn">' + escHtml(portalT('schedule.drawer.startConv')) + '</button>';
  html += scheduleRenderDrawerOpenCustomerBtnHtml(ctx);
  html += '</div>';
  html += '<p id="ps-drawer-conversation-hint" class="portal-schedule-drawer-hint" style="display:none"></p>';
  html += scheduleRenderDeleteBookingRowHtml(ctx);
  return html;
}

function scheduleRenderViewDrawerHtml(row, ctx, canEdit){
  if (isSunsetSurfActive()) return scheduleRenderSunsetViewDrawerHtml(row, ctx, canEdit);
  var html = scheduleRenderDrawerHeroHtml(ctx, row);
  // Booking details: phone, dates, booked items (Sunset view mode). Source lives in the hero metadata line.
  html += scheduleDrawerSectionHtml('schedule.drawer.section.booking', scheduleRenderDrawerViewBookingDetailsHtml(ctx, row));
  if (ctx.notes) {
    html += scheduleDrawerSectionHtml('schedule.drawer.section.notes',
      '<p class="portal-schedule-drawer-kv" style="margin:0">' + escHtml(ctx.notes) + '</p>');
  }
  html += scheduleRenderDrawerPaymentSectionHtml(ctx);
  html += scheduleRenderDrawerWaiverSectionHtml(ctx);
  html += '<p id="ps-drawer-save-msg" class="state-msg" style="display:none;margin-top:8px"></p>';
  html += '<p id="ps-drawer-stripe-msg" class="state-msg" style="display:none;margin-top:8px"></p>';
  html += '<div class="portal-schedule-drawer-actions">';
  if (canEdit) html += '<button type="button" class="btn btn-primary" id="ps-drawer-edit">' + escHtml(portalT('schedule.drawer.edit')) + '</button>';
  html += scheduleRenderDrawerOpenCustomerBtnHtml(ctx);
  // Stripe "Create link" button now lives inside the payment area (see stripe subsection).
  html += '<button type="button" class="btn btn-ghost" id="ps-drawer-conversation-btn">' + escHtml(portalT('schedule.drawer.startConv')) + '</button>';
  html += '</div>';
  html += '<p id="ps-drawer-conversation-hint" class="portal-schedule-drawer-hint" style="display:none"></p>';
  html += scheduleRenderDeleteBookingRowHtml(ctx);
  return html;
}

function scheduleDrawerEur(cents){
  if (cents == null || isNaN(Number(cents))) return '—';
  return '\u20ac' + (Number(cents) / 100).toFixed(2);
}


function scheduleRenderDrawerPaymentSectionViewHtml(ctx){
  if (isSunsetSurfActive()) return scheduleRenderSunsetMoneyCardHtml(ctx);
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
  var effPaid = (Number(pay.paid_cents || 0) > 0 && pay.balance_due_cents != null && Number(pay.balance_due_cents) <= 0);
  var effStatus = effPaid ? 'paid' : pay.payment_status;
  html += '<div class="ctx-inv-total-row"><span class="ctx-inv-total-label">' + escHtml(portalT('schedule.col.payment')) +
    '</span><span class="ctx-inv-total-amount' + (effPaid ? ' paid' : '') + '" id="ps-drawer-pay-status">' + escHtml(schedulePaymentStatusLabel(effStatus, ctx && ctx.payment_method)) + '</span></div>';
  html += '</div>';
  html += scheduleRenderDrawerManualPaymentHtml(ctx);
  html += scheduleRenderDrawerStripeLinkSectionHtml(ctx);
  html += '</div>';
  return html;
}

