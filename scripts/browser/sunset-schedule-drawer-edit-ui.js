'use strict';

var scheduleDrawerSaveInFlight = false;
var scheduleDrawerPriceStale = false;
var scheduleDrawerValidationState = { ok: true, errorKey: null };
var scheduleDrawerCustomLines = [];
var scheduleDrawerCustomLineSeq = 0;
var scheduleDrawerCustomLineEditorOpen = false;
// Edit-local quote preview state (do not share Create's schedulePortalQuote* globals).
var scheduleDrawerQuoteState = null;
var scheduleDrawerQuoteGen = 0;
var scheduleDrawerQuoteAbort = null;
var scheduleDrawerQuoteTimer = null;
var scheduleDrawerQuoteDebounceMs = 400;
function scheduleDrawerMainActivityValue(){
  if(el('ps-drawer-comp-course')&&el('ps-drawer-comp-course').checked) return 'group';
  if(el('ps-drawer-comp-private-lesson')&&el('ps-drawer-comp-private-lesson').checked) return 'private';
  return 'none';
}
function scheduleDrawerSetMainActivity(mode){
  var m=String(mode||'none');
  if(el('ps-drawer-comp-course')) el('ps-drawer-comp-course').checked=m==='group';
  if(el('ps-drawer-comp-private-lesson')) el('ps-drawer-comp-private-lesson').checked=m==='private';
  if(el('ps-drawer-comp-no-lesson')) el('ps-drawer-comp-no-lesson').checked=m==='none'||(m!=='group'&&m!=='private');
}
function scheduleDrawerPaymentSelectValue(ctx){
  if(!ctx||ctx.payment_status!=='paid') return 'unpaid';
  if(ctx.payment_method==='bank_transfer') return 'paid_bank_transfer';
  if(ctx.payment_method==='in_store') return 'paid_in_store';
  if(ctx.payment_method==='link') return 'paid_via_link';
  return 'paid_bank_transfer';
}
function scheduleRenderDrawerPaymentSelectHtml(ctx) {
  var cur = scheduleDrawerPaymentSelectValue(ctx);
  function opt(val, key) {
    return '<option value="' + val + '"' + (cur === val ? ' selected' : '') + '>' + escHtml(portalT(key)) + '</option>';
  }
  return '<div class="portal-schedule-create-field"><label for="ps-drawer-payment">' +
    escHtml(portalT('schedule.create.paymentStatus') || portalT('schedule.create.payment')) + '</label>' +
    '<select id="ps-drawer-payment">' +
    opt('unpaid', 'schedule.payment.unpaid') +
    opt('paid_bank_transfer', 'schedule.payment.paidBankTransfer') +
    opt('paid_in_store', 'schedule.payment.paidInStore') +
    opt('paid_via_link', 'schedule.payment.paidViaLink') +
    '</select></div>';
}

function scheduleRenderDrawerPaymentSectionEditHtml(ctx) {
  var pay = (ctx && ctx.payment) || {};
  var items = pay.line_items || [];
  var html = '<div class="ctx-pay-box portal-schedule-drawer-edit-pay-snapshot" id="ps-drawer-payment-box">';
  html += '<div class="ps-card-eyebrow">' + escHtml(portalT('schedule.drawer.paymentSection')) + '</div>';
  if (pay.pricing_note) {
    html += '<p class="portal-schedule-drawer-hint" style="margin:0 0 8px">' + escHtml(portalT('schedule.drawer.livePricingNote')) + '</p>';
  }
  var commercial = (typeof scheduleDrawerBuildCommercialLines === 'function')
    ? scheduleDrawerBuildCommercialLines(items, pay.rental_pricing || (ctx && ctx.rental_pricing) || null)
    : null;
  if (commercial && commercial.lines && commercial.lines.length) {
    html += '<div class="ctx-inv-group" id="ps-drawer-line-items" data-commercial="1">';
    commercial.lines.forEach(function(line) {
      html += '<div class="ctx-inv-line ctx-inv-addon-line' + (line.is_bundle ? ' is-bundle-line' : '') + '">' +
        escHtml(line.label) + ' — ' + escHtml(scheduleDrawerEur(line.line_cents)) + '</div>';
    });
    html += '</div>';
  } else if (!items.length) {
    html += '<div class="ctx-inv-line ctx-none">' + escHtml(portalT('schedule.drawer.noLineItems')) + '</div>';
  } else {
    html += '<div class="ctx-inv-group" id="ps-drawer-line-items">';
    items.forEach(function(li) {
      html += '<div class="ctx-inv-line ctx-inv-addon-line">' + escHtml(li.label) +
        ' — ' + escHtml(scheduleDrawerEur(li.line_cents)) + '</div>';
    });
    html += '</div>';
  }
  var effPaid=(Number(pay.paid_cents||0)>0&&pay.balance_due_cents!=null&&Number(pay.balance_due_cents)<=0);
  function tot(id,lab,amt,cls){return '<div class="ctx-inv-total-row"><span class="ctx-inv-total-label">'+escHtml(lab)+'</span><span class="ctx-inv-total-amount'+(cls?(' '+cls):'')+'" id="'+id+'">'+escHtml(scheduleDrawerEur(amt))+'</span></div>';}
  html+='<div class="ctx-inv-group ctx-inv-totals" style="margin-top:10px">'+tot('ps-drawer-subtotal',portalT('schedule.drawer.subtotal'),pay.subtotal_cents,'')+tot('ps-drawer-paid',portalT('schedule.drawer.paid'),pay.paid_cents,'paid')+tot('ps-drawer-remaining',portalT('schedule.drawer.remaining'),pay.balance_due_cents,'owing')+'<div class="ctx-inv-total-row"><span class="ctx-inv-total-label">'+escHtml(portalT('schedule.col.payment'))+'</span><span class="ctx-inv-total-amount'+(effPaid?' paid':'')+'" id="ps-drawer-pay-status">'+escHtml(schedulePaymentStatusLabel(effPaid?'paid':pay.payment_status,ctx&&ctx.payment_method))+'</span></div></div></div>';
  return html;
}

function scheduleRenderEditableDrawerHtml(row, ctx) {
  var comps = (ctx && ctx.components) || {};
  var courseOn = !!(comps.course || comps.lesson);
  var privateOn = !!comps.private_lesson;
  var boardOn = !!comps.surfboard;
  var wetsuitOn = !!comps.wetsuit;
  var selectedCourseId = (comps.course && comps.course.course_id) || '';
  var courseQty = (comps.course && comps.course.quantity) || (comps.lesson && comps.lesson.quantity) || 1;
  var code = (ctx && ctx.booking_code) || (row && row.booking_code) || '';
  var statusLabel = schedulePaymentStatusLabel(
    (ctx && ctx.payment && ctx.payment.payment_status) || (ctx && ctx.payment_status) || 'unpaid',
    ctx && ctx.payment_method
  );
  var mainMode = privateOn ? 'private' : (courseOn ? 'group' : 'none');
  // Booking surfer authority for no-lesson equipment qty (mirrors Create #ps-create-surfers).
  var seedSurfers = 1;
  if (courseOn) seedSurfers = parseInt(courseQty, 10) || 1;
  else if (privateOn) seedSurfers = parseInt((comps.private_lesson && comps.private_lesson.surfer_count) || 1, 10) || 1;
  else {
    var seedQtys = [];
    if (comps.surfboard && comps.surfboard.quantity) seedQtys.push(parseInt(comps.surfboard.quantity, 10) || 1);
    if (comps.wetsuit && comps.wetsuit.quantity) seedQtys.push(parseInt(comps.wetsuit.quantity, 10) || 1);
    if (Array.isArray(ctx.rentals)) {
      ctx.rentals.forEach(function(r) {
        if (r && r.quantity != null) seedQtys.push(parseInt(r.quantity, 10) || 1);
      });
    }
    if (ctx.guest_count != null) seedQtys.push(parseInt(ctx.guest_count, 10) || 1);
    if (seedQtys.length) seedSurfers = Math.max.apply(null, seedQtys);
  }
  var html = '<form id="ps-drawer-edit-form" class="portal-schedule-drawer-edit" autocomplete="off">';
  html += '<header class="portal-schedule-create-header portal-schedule-drawer-edit-header">';
  html += '<div class="portal-schedule-create-header-text">';
  html += '<h2 id="ps-drawer-edit-title" class="portal-schedule-create-title">' +
    escHtml(portalT('schedule.drawer.editTitle')) + '</h2>';
  html += '<span class="portal-schedule-create-school-chip" id="ps-drawer-edit-meta">';
  if (code) html += '<strong>' + escHtml(code) + '</strong>';
  if (statusLabel) html += (code ? ' · ' : '') + escHtml(statusLabel);
  html += '</span></div>';
  html += '<button type="button" class="btn btn-ghost portal-schedule-drawer-close-btn" id="ps-drawer-close" title="' +
    escHtml(portalT('schedule.drawer.close')) + '" aria-label="' + escHtml(portalT('schedule.drawer.close')) + '">&#10005;</button>';
  html += '</header>';
  html += '<div class="portal-schedule-create-body portal-schedule-drawer-edit-body">';
  html += '<section class="portal-schedule-create-section" data-edit-section="guest" aria-labelledby="ps-drawer-section-guest-title">';
  html += '<h3 id="ps-drawer-section-guest-title" class="portal-schedule-create-section-title">' +
    escHtml(portalT('schedule.create.section.guest')) + '</h3>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-guest">' +
    escHtml(portalT('schedule.create.guestName')) + '</label>' +
    '<input id="ps-drawer-guest" type="text" value="' + escHtml(ctx.guest_name || '') + '"></div>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-phone">' +
    escHtml(portalT('schedule.drawer.phone')) + '</label>' +
    '<input id="ps-drawer-phone" type="tel" value="' + escHtml(ctx.phone || '') + '"></div>';
  html += '<div id="ps-drawer-date-range">';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-date-from">' +
    escHtml(portalT('schedule.create.dateFrom')) + '</label>' +
    '<input id="ps-drawer-date-from" type="date" value="' + escHtml(ctx.date_from || '') + '"></div>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-date-to">' +
    escHtml(portalT('schedule.create.dateTo')) + '</label>' +
    '<input id="ps-drawer-date-to" type="date" value="' + escHtml(ctx.date_to || ctx.date_from || '') + '"></div>';
  html += '</div>';
  // Booking-level Number of surfers — Create #ps-create-surfers parity (visible for no-lesson only).
  html += '<div class="portal-schedule-create-field" id="ps-drawer-surfers-field"' +
    (mainMode === 'none' ? '' : ' style="display:none" hidden aria-hidden="true"') + '>' +
    '<label for="ps-drawer-surfers">' + escHtml(portalT('schedule.create.surferCount')) + '</label>' +
    '<input id="ps-drawer-surfers" type="number" min="1" max="99" value="' +
    escHtml(String(seedSurfers)) + '" inputmode="numeric"></div>';
  html += '</section>';
  html += '<section class="portal-schedule-create-section" data-edit-section="what" aria-labelledby="ps-drawer-section-what-title">';
  html += '<h3 id="ps-drawer-section-what-title" class="portal-schedule-create-section-title">' +
    escHtml(portalT('schedule.create.section.what')) + '</h3>';
  html += '<div class="portal-schedule-create-field"><span id="ps-drawer-main-activity-label" class="portal-schedule-create-label">' +
    escHtml(portalT('schedule.create.mainActivity')) + '</span>';
  html += '<div class="portal-schedule-create-components portal-schedule-create-main-activity" role="radiogroup" aria-labelledby="ps-drawer-main-activity-label">';
  html += '<label class="portal-schedule-create-check"><input type="radio" name="ps-drawer-main-activity" id="ps-drawer-comp-course" value="group"' +
    (mainMode === 'group' ? ' checked' : '') + '> ' + escHtml(portalT('schedule.type.course')) + '</label>';
  html += '<label class="portal-schedule-create-check"><input type="radio" name="ps-drawer-main-activity" id="ps-drawer-comp-private-lesson" value="private"' +
    (mainMode === 'private' ? ' checked' : '') + '> ' + escHtml(portalT('schedule.type.privateLesson') || portalT('schedule.type.privateCourse')) + '</label>';
  html += '<label class="portal-schedule-create-check"><input type="radio" name="ps-drawer-main-activity" id="ps-drawer-comp-no-lesson" value="none"' +
    (mainMode === 'none' ? ' checked' : '') + '> ' + escHtml(portalT('schedule.type.noLesson')) + '</label>';
  html += '</div></div>';
  html += '<div id="ps-drawer-course-section"' + (courseOn || privateOn ? '' : ' style="display:none"') + '>';
  html += '<div class="portal-schedule-create-field" id="ps-drawer-course-fields"' + (courseOn ? '' : ' style="display:none"') +
    '><label for="ps-drawer-course-select">' + escHtml(portalT('schedule.create.courseSelect')) + '</label>' +
    '<select id="ps-drawer-course-select" data-selected="' + escHtml(selectedCourseId) + '"></select></div>';
  html += '<div id="ps-drawer-course-duration-confirm" class="portal-schedule-drawer-duration-confirm" role="status" aria-live="polite"' +
    (courseOn ? '' : ' style="display:none"') + '></div>';
  html += '<div class="portal-schedule-create-field" id="ps-drawer-course-qty-wrap"' + (courseOn ? '' : ' style="display:none"') +
    '><label for="ps-drawer-course-qty">' + escHtml(portalT('schedule.create.surferCount')) + '</label>' +
    '<input id="ps-drawer-course-qty" type="number" min="1" max="99" value="' + escHtml(String(courseQty)) + '"></div>';
  html += '<div id="ps-drawer-private-lesson-fields"' + (privateOn ? '' : ' style="display:none"') + '>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-private-lesson-surfers">' +
    escHtml(portalT('schedule.create.surferCount')) + '</label>' +
    '<input id="ps-drawer-private-lesson-surfers" type="number" min="1" max="99" value="' +
    escHtml(String((comps.private_lesson && comps.private_lesson.surfer_count) || 1)) + '"></div>';
  html += '</div></div>';
  html += '<div class="portal-schedule-create-field portal-schedule-drawer-gear-secondary">';
  html += '<span class="portal-schedule-create-label">' + escHtml(portalT('schedule.drawer.section.rentals') || 'Gear') + '</span>';
  html += '<div id="ps-drawer-rentals" class="portal-schedule-create-rentals portal-schedule-drawer-rentals" aria-live="polite"';
  html += ' data-seed-board="' + (boardOn ? '1' : '0') + '" data-seed-wetsuit="' + (wetsuitOn ? '1' : '0') + '"';
  html += ' data-seed-board-qty="' + escHtml(String((comps.surfboard && comps.surfboard.quantity) || 1)) + '"';
  html += ' data-seed-wetsuit-qty="' + escHtml(String((comps.wetsuit && comps.wetsuit.quantity) || 1)) + '"';
  html += ' data-seed-surfers="' + escHtml(String(seedSurfers)) + '"';
  html += ' data-seed-rentals="' + escHtml(JSON.stringify(Array.isArray(ctx.rentals) ? ctx.rentals : [])) + '"></div>';
  var addonSeed = (comps.full_day_equipment_extension && comps.full_day_equipment_extension.dates) || {};
  var addonOn = Object.keys(addonSeed).length > 0;
  html += '<div class="portal-schedule-create-field portal-schedule-addon-field" id="ps-drawer-addon-fullday-field" style="display:none" data-addon-seed="' +
    escHtml(JSON.stringify(addonSeed)) + '">';
  html += '<label class="portal-schedule-create-check portal-schedule-addon-toggle" style="min-height:44px;display:flex;align-items:center">' +
    '<input type="checkbox" id="ps-drawer-comp-fullday"' + (addonOn ? ' checked' : '') + '> ' +
    escHtml(portalT('schedule.type.fullDayEquipment')) + '</label>';
  html += '<div id="ps-drawer-fullday-rows" class="portal-schedule-addon-rows" style="display:none"></div>';
  html += '<div id="ps-drawer-fullday-summary" class="portal-schedule-addon-summary" style="display:none" aria-live="polite"></div>';
  html += '</div></div></section>';
  html += '<section class="portal-schedule-create-section" data-edit-section="when" aria-labelledby="ps-drawer-section-when-title">';
  html += '<h3 id="ps-drawer-section-when-title" class="portal-schedule-create-section-title">' +
    escHtml(portalT('schedule.create.section.when')) + '</h3>';
  html += '<div id="ps-drawer-when-summary" class="portal-schedule-drawer-when-summary" role="status" aria-live="polite"></div>';
  html += '<div id="ps-drawer-private-when" class="portal-schedule-create-private-when"' + (privateOn ? '' : ' style="display:none"') + '>';
  html += '<span class="portal-schedule-create-label">' + escHtml(portalT('schedule.create.privateLesson.sessionsHelp')) + '</span>';
  html += '<div id="ps-drawer-private-sessions" class="portal-schedule-private-sessions"></div>';
  html += '</div></section>';
  // Custom add-on card (same Create contract) — editable commercial adjustments.
  html += '<section class="portal-schedule-create-section portal-schedule-create-custom-addon-card" data-edit-section="custom-addon" aria-labelledby="ps-drawer-section-custom-addon-title" data-testid="ps-drawer-custom-addon-card">';
  html += '<h3 id="ps-drawer-section-custom-addon-title" class="portal-schedule-create-section-title" data-i18n="schedule.create.section.customAddon">' +
    escHtml(portalT('schedule.create.section.customAddon') || 'Custom add-on') + '</h3>';
  html += '<div id="ps-drawer-custom-lines" class="portal-schedule-create-custom-lines" data-testid="ps-drawer-custom-lines">';
  html += '<div id="ps-drawer-custom-lines-list" class="portal-schedule-create-custom-lines-list" aria-live="polite"></div>';
  html += '<div id="ps-drawer-custom-lines-collapsed" class="portal-schedule-create-custom-lines-collapsed">';
  html += '<button type="button" id="ps-drawer-custom-line-add-btn" class="portal-schedule-create-custom-line-plus" data-i18n-aria="schedule.create.customLine.add" aria-label="' +
    escHtml(portalT('schedule.create.customLine.add') || 'Add custom line') + '" title="' +
    escHtml(portalT('schedule.create.customLine.add') || 'Add custom line') + '">+</button>';
  html += '</div>';
  html += '<div id="ps-drawer-custom-lines-editor" class="portal-schedule-create-custom-lines-editor" style="display:none" hidden aria-hidden="true">';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-custom-line-label" data-i18n="schedule.create.customLine.label">' +
    escHtml(portalT('schedule.create.customLine.label') || 'Label') + '</label>';
  html += '<input id="ps-drawer-custom-line-label" type="text" maxlength="120" autocomplete="off"></div>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-custom-line-price" data-i18n="schedule.create.customLine.price">' +
    escHtml(portalT('schedule.create.customLine.price') || 'Price') + '</label>';
  html += '<div class="portal-schedule-create-custom-line-price-row">';
  html += '<span class="portal-schedule-create-custom-line-currency" aria-hidden="true">€</span>';
  html += '<input id="ps-drawer-custom-line-price" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00">';
  html += '</div></div>';
  html += '<div class="portal-schedule-create-custom-line-actions">';
  html += '<button type="button" class="btn btn-primary" id="ps-drawer-custom-line-confirm" data-i18n="schedule.create.customLine.confirm">' +
    escHtml(portalT('schedule.create.customLine.confirm') || 'Add') + '</button>';
  html += '<button type="button" class="btn btn-ghost" id="ps-drawer-custom-line-cancel" data-i18n="schedule.create.customLine.cancel">' +
    escHtml(portalT('schedule.create.customLine.cancel') || 'Cancel') + '</button>';
  html += '</div>';
  html += '<p id="ps-drawer-custom-line-error" class="portal-schedule-create-custom-line-error" style="display:none" role="alert"></p>';
  html += '</div></div></section>';
  html += '<section class="portal-schedule-create-section" data-edit-section="payment" aria-labelledby="ps-drawer-section-payment-title">';
  html += '<h3 id="ps-drawer-section-payment-title" class="portal-schedule-create-section-title">' +
    escHtml(portalT('schedule.create.section.paymentNotes')) + '</h3>';
  html += scheduleRenderDrawerPaymentSelectHtml(ctx);
  html += scheduleRenderDrawerPaymentSectionEditHtml(ctx);
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-notes">' +
    escHtml(portalT('schedule.drawer.notes')) + '</label>' +
    '<textarea id="ps-drawer-notes" rows="2">' + escHtml(ctx.notes || '') + '</textarea></div>';
  html += '</section>';
  html += '</div>'; // body
  html += '<footer class="portal-schedule-create-footer portal-schedule-drawer-edit-footer">';
  html += '<div id="ps-drawer-summary" class="portal-schedule-create-summary" aria-live="polite">' +
    '<span class="portal-schedule-create-summary-placeholder">—</span></div>';
  html += '<div id="ps-drawer-quote-preview" class="portal-schedule-create-field" style="display:none" role="status" aria-live="polite"></div>';
  html += '<p id="ps-drawer-save-msg" class="state-msg" style="display:none;margin:0" role="status" aria-live="polite"></p>';
  html += '<div class="portal-schedule-create-actions">';
  html += '<button type="button" class="btn btn-ghost" id="ps-drawer-cancel">' + escHtml(portalT('schedule.drawer.cancel')) + '</button>';
  html += '<button type="button" class="btn btn-primary" id="ps-drawer-save">' + escHtml(portalT('schedule.drawer.save')) + '</button>';
  html += '</div></footer>';
  html += '</form>';
  return html;
}

function scheduleDrawerSeedRentalsFromCtx(){
  var wrap=el('ps-drawer-rentals'); if(!wrap) return [];
  var seed=[]; try{seed=JSON.parse(wrap.getAttribute('data-seed-rentals')||'[]');}catch(_e){seed=[];}
  if(Array.isArray(seed)&&seed.length) return seed.slice();
  // Prefer catalog rental_pricing; never invent board_and_suit without it.
  var ctx=scheduleDrawerState&&scheduleDrawerState.ctx, rp=ctx&&(ctx.rental_pricing||(ctx.payment&&ctx.payment.rental_pricing));
  if(rp&&rp.offering_key) return [{offering_key:String(rp.offering_key),duration_key:rp.duration||rp.duration_key||null,quantity:parseInt(rp.quantity,10)||1}];
  var board=wrap.getAttribute('data-seed-board')==='1', wet=wrap.getAttribute('data-seed-wetsuit')==='1';
  var bq=parseInt(wrap.getAttribute('data-seed-board-qty')||'1',10)||1, wq=parseInt(wrap.getAttribute('data-seed-wetsuit-qty')||'1',10)||1, out=[];
  if(board) out.push({offering_key:'board_rental',quantity:bq}); if(wet) out.push({offering_key:'wetsuit_rental',quantity:wq}); return out;
}

function scheduleDrawerDateSpan(){
  var from=el('ps-drawer-date-from')?el('ps-drawer-date-from').value:'';
  var to=el('ps-drawer-date-to')?el('ps-drawer-date-to').value:from;
  return {from:from,to:to||from};
}

/**
 * Surfer count authority for Edit:
 *  - group → #ps-drawer-course-qty
 *  - private → #ps-drawer-private-lesson-surfers
 *  - no-lesson → #ps-drawer-surfers (Create #ps-create-surfers parity)
 * Blank/invalid/fraction returns null — never silent-clamp to 1.
 */
function scheduleDrawerReadSurferCount() {
  function parseRaw(raw) {
    if (raw === '' || raw == null) return null;
    var s = String(raw).trim();
    if (!s) return null;
    // Integer digits only (reject 1.5 / 2e1 / leading junk); fail closed outside 1..99.
    if (!/^\d{1,3}$/.test(s)) return null;
    var n = parseInt(s, 10);
    if (!Number.isInteger(n) || n < 1 || n > 99) return null;
    return n;
  }
  var mode = scheduleDrawerMainActivityValue();
  if (mode === 'group') {
    var cq = el('ps-drawer-course-qty');
    return parseRaw(cq ? cq.value : '');
  }
  if (mode === 'private') {
    var ps = el('ps-drawer-private-lesson-surfers');
    return parseRaw(ps ? ps.value : '');
  }
  // No lesson: live booking-level Surfers input (not immutable data-seed).
  var s = el('ps-drawer-surfers');
  return parseRaw(s ? s.value : '');
}

/** Force hidden no-lesson rental qty mirrors to live booking Surfers (when valid). */
function scheduleDrawerSyncRentalQtyFromSurfers() {
  var sn = scheduleDrawerReadSurferCount();
  if (sn == null) return;
  var wrap = el('ps-drawer-rentals');
  if (!wrap) return;
  var forceAll = scheduleDrawerMainActivityValue() === 'none';
  wrap.querySelectorAll('input.ps-drawer-rental-qty-input').forEach(function(inp) {
    if (forceAll || inp.getAttribute('data-qty-owner') !== 'user') {
      inp.value = String(sn);
      inp.setAttribute('data-qty-owner', 'surfers');
    }
  });
  try { wrap.setAttribute('data-seed-surfers', String(sn)); } catch (_s) { /* ignore */ }
}

function scheduleReadDrawerRentalSelectionFromDom() {
  var wrap = el('ps-drawer-rentals');
  if (!wrap) return [];
  var duration = String(wrap.getAttribute('data-duration-key') || '').trim();
  var shortMode = wrap.getAttribute('data-short-rental') === '1';
  var noLesson = scheduleDrawerMainActivityValue() === 'none';
  var selection = [];
  wrap.querySelectorAll('[data-rental-offering]').forEach(function(row) {
    var key = String(row.getAttribute('data-rental-offering') || '').trim();
    var check = row.querySelector('.ps-drawer-rental-check');
    var qtyEl = row.querySelector('input.ps-drawer-rental-qty-input');
    if (!check || !check.checked || !key) return;
    var qty;
    if (noLesson) {
      // No lesson: never trust independently edited equipment qty — surfer-owned only.
      var snNo = scheduleDrawerReadSurferCount();
      if (snNo == null) return;
      qty = snNo;
    } else {
      qty = parseInt(qtyEl && qtyEl.value, 10);
      if (!Number.isInteger(qty) || qty < 1) {
        var sn = scheduleDrawerReadSurferCount();
        if (sn == null) return;
        qty = sn;
      }
    }
    selection.push({ offering_key: key, duration_key: duration, quantity: qty });
  });
  if (typeof scheduleSerializeRentalsSelection === 'function') {
    return scheduleSerializeRentalsSelection(selection, duration, {
      expandCombinedShort: shortMode,
    });
  }
  return selection;
}

function scheduleDrawerApplyRentalExclusionUi(wrap, selectedKeys) {
  if (!wrap) return;
  var selected = selectedKeys || [];
  var bundleOn = selected.indexOf('board_and_suit_rental') >= 0;
  var separateOn = selected.indexOf('board_rental') >= 0 || selected.indexOf('wetsuit_rental') >= 0;
  // No lesson: equipment qty owned by booking surfer count — hide independent Surfers control.
  var noLesson = scheduleDrawerMainActivityValue() === 'none';
  wrap.querySelectorAll('[data-rental-offering]').forEach(function(row) {
    var key = String(row.getAttribute('data-rental-offering') || '');
    var check = row.querySelector('.ps-drawer-rental-check');
    var qtyWrap = row.querySelector('.portal-schedule-create-rental-qty');
    var label = row.querySelector('.portal-schedule-create-check');
    if (!check) return;
    var isOn = selected.indexOf(key) >= 0;
    check.checked = isOn;
    if (key === 'board_and_suit_rental') check.disabled = separateOn && !isOn;
    else if (key === 'board_rental' || key === 'wetsuit_rental') check.disabled = bundleOn && !isOn;
    else check.disabled = false;
    if (label) {
      if (check.disabled) label.classList.add('is-disabled');
      else label.classList.remove('is-disabled');
    }
    if (qtyWrap) {
      // Group/Private keep independent gear Surfers control; No lesson never shows it.
      qtyWrap.style.display = (!noLesson && isOn) ? '' : 'none';
      try {
        qtyWrap.setAttribute('aria-hidden', (noLesson || !isOn) ? 'true' : 'false');
        if (noLesson || !isOn) qtyWrap.setAttribute('hidden', '');
        else qtyWrap.removeAttribute('hidden');
      } catch (_q) { /* ignore */ }
    }
  });
}

function scheduleDrawerIsCombinedBoardWetsuit(selectedKeys) {
  var sel = selectedKeys || [];
  if (sel.indexOf('board_and_suit_rental') >= 0) return true;
  return sel.indexOf('board_rental') >= 0 && sel.indexOf('wetsuit_rental') >= 0;
}

function scheduleWireDrawerRentals(wrap) {
  if (!wrap || wrap.dataset.rentalWired === '1') return;
  wrap.dataset.rentalWired = '1';
  wrap.addEventListener('click', function(ev) {
    var t = ev && ev.target;
    if (!t) return;
    var btn = t.closest ? t.closest('[data-rental-duration]') : null;
    if (!btn || !wrap.contains(btn)) return;
    var dur = String(btn.getAttribute('data-rental-duration') || '').trim();
    if (!dur) return;
    wrap.setAttribute('data-duration-key', dur);
    wrap.querySelectorAll('[data-rental-duration]').forEach(function(b) {
      var on = String(b.getAttribute('data-rental-duration') || '') === dur;
      if (on) b.classList.add('is-selected'); else b.classList.remove('is-selected');
      try { b.setAttribute('aria-checked', on ? 'true' : 'false'); } catch (_a) { /* ignore */ }
    });
    scheduleDrawerMarkPriceStale();
    scheduleDrawerSyncFooter();
  });
  wrap.addEventListener('change', function(ev) {
    var t = ev && ev.target;
    if (!t) return;
    if (t.classList && t.classList.contains('ps-drawer-rental-check')) {
      var key = String(t.getAttribute('data-offering-key') || '');
      var selected = [];
      wrap.querySelectorAll('.ps-drawer-rental-check').forEach(function(c) {
        if (c.checked) selected.push(String(c.getAttribute('data-offering-key') || ''));
      });
      var next = typeof scheduleApplyRentalMutualExclusion === 'function'
        ? scheduleApplyRentalMutualExclusion(selected.filter(function(k) { return k !== key; }), key, !!t.checked)
        : (t.checked ? selected.concat([key]) : selected.filter(function(k) { return k !== key; }));
      scheduleDrawerApplyRentalExclusionUi(wrap, next);
      if (t.checked) {
        var row = t.closest ? t.closest('[data-rental-offering]') : null;
        var qtyEl = row && row.querySelector('input.ps-drawer-rental-qty-input');
        var sn = scheduleDrawerReadSurferCount();
        if (qtyEl && qtyEl.getAttribute('data-qty-owner') !== 'user' && sn != null) {
          qtyEl.value = String(sn);
          qtyEl.setAttribute('data-qty-owner', 'surfers');
        }
      }
      // Combined Board and wetsuit in No-lesson short mode: show/refresh duration pebbles.
      if (wrap.getAttribute('data-short-rental') === '1') {
        var common = [];
        try { common = JSON.parse(wrap.getAttribute('data-common-short-keys') || '[]'); } catch (_j) { common = []; }
        if (scheduleDrawerIsCombinedBoardWetsuit(next) && common.length
          && typeof scheduleRenderCreateRentalDurationPebbles === 'function') {
          scheduleRenderCreateRentalDurationPebbles(
            wrap, common, wrap.getAttribute('data-duration-key'),
          );
        } else {
          var host = wrap.querySelector('[data-rental-duration-pebbles]');
          if (host) { host.innerHTML = ''; host.style.display = 'none'; }
          if (next.length === 1 && common.length) {
            wrap.setAttribute('data-duration-key', common[0]);
          }
        }
      }
      scheduleDrawerMarkPriceStale();
      scheduleRefreshDrawerFullDayAddon();
      scheduleDrawerSyncFooter();
      return;
    }
    if (t.classList && t.classList.contains('ps-drawer-rental-qty-input')) {
      t.setAttribute('data-qty-owner', 'user');
      scheduleDrawerMarkPriceStale();
      scheduleRefreshDrawerFullDayAddon();
      scheduleDrawerSyncFooter();
    }
  });
  wrap.addEventListener('input', function(ev) {
    var t = ev && ev.target;
    if (t && t.classList && t.classList.contains('ps-drawer-rental-qty-input')) {
      t.setAttribute('data-qty-owner', 'user');
      scheduleDrawerMarkPriceStale();
      scheduleRefreshDrawerFullDayAddon();
      scheduleDrawerSyncFooter();
    }
  });
}

function scheduleRenderDrawerRentals() {
  var wrap = el('ps-drawer-rentals');
  if (!wrap) return;
  var prev = {};
  var prevDuration = String(wrap.getAttribute('data-duration-key') || '').trim();
  wrap.querySelectorAll('[data-rental-offering]').forEach(function(row) {
    var key = String(row.getAttribute('data-rental-offering') || '');
    var check = row.querySelector('.ps-drawer-rental-check');
    var qtyEl = row.querySelector('input.ps-drawer-rental-qty-input');
    if (!key) return;
    var qty = parseInt(qtyEl && qtyEl.value, 10);
    prev[key] = {
      checked: !!(check && check.checked),
      quantity: (Number.isInteger(qty) && qty >= 1) ? qty : null,
      qtyOwner: qtyEl ? String(qtyEl.getAttribute('data-qty-owner') || '') : '',
    };
  });
  if (!Object.keys(prev).length) {
    scheduleDrawerSeedRentalsFromCtx().forEach(function(r) {
      if (!r || !r.offering_key) return;
      prev[r.offering_key] = {
        checked: true,
        quantity: parseInt(r.quantity, 10) || 1,
        qtyOwner: 'surfers',
      };
    });
  }
  var span = scheduleDrawerDateSpan();
  var dateDuration = typeof scheduleRentalDurationKeyFromDates === 'function'
    ? scheduleRentalDurationKeyFromDates(span.from, span.to, scheduleEnumerateDates)
    : null;
  var locationId = typeof getSunsetLocation === 'function' ? getSunsetLocation() : '';
  var prices = (typeof scheduleAdminPricesCache !== 'undefined' && scheduleAdminPricesCache) || [];
  var noLesson = scheduleDrawerMainActivityValue() === 'none';
  var commonShort = (typeof scheduleCommonShortRentalDurationKeys === 'function')
    ? scheduleCommonShortRentalDurationKeys(prices, locationId)
    : [];
  // No-lesson short-rental pebbles only on a single-day span (same Create contract).
  var shortMode = noLesson && commonShort.length > 0 && dateDuration === '1_day';
  var offerings = [];
  var duration = dateDuration;
  if (shortMode) {
    offerings = (typeof scheduleActiveShortRentalOfferings === 'function')
      ? scheduleActiveShortRentalOfferings(prices, locationId)
      : [];
    if (prevDuration && commonShort.indexOf(prevDuration) >= 0) duration = prevDuration;
    else duration = commonShort[0] || '';
  } else {
    offerings = (dateDuration && typeof scheduleActiveRentalsForDuration === 'function')
      ? scheduleActiveRentalsForDuration(prices, dateDuration, locationId)
      : [];
    duration = dateDuration;
  }
  if (!offerings.length) {
    offerings = [
      { offering_key: 'board_rental', duration_key: duration || '1_day' },
      { offering_key: 'wetsuit_rental', duration_key: duration || '1_day' },
      { offering_key: 'board_and_suit_rental', duration_key: duration || '1_day' },
    ];
  }
  var mode = typeof scheduleRentalOfferingsMode === 'function'
    ? scheduleRentalOfferingsMode(offerings)
    : (offerings.length ? 'all_three' : 'none');
  wrap.setAttribute('data-duration-key', duration || '');
  wrap.setAttribute('data-rental-mode', mode);
  wrap.setAttribute('data-short-rental', shortMode ? '1' : '0');
  wrap.setAttribute('data-common-short-keys', JSON.stringify(commonShort));
  wrap.dataset.rentalWired = '';
  var surfers = scheduleDrawerReadSurferCount();
  var html = '';
  offerings.forEach(function(o) {
    var key = o.offering_key;
    var labelKey = typeof scheduleRentalOfferingLabelKey === 'function'
      ? scheduleRentalOfferingLabelKey(key) : 'schedule.type.boardRental';
    var fallback = key === 'wetsuit_rental' ? 'Wetsuit'
      : (key === 'board_and_suit_rental' ? 'Board and wetsuit' : 'Surfboard');
    var was = prev[key] || {};
    var checked = !!was.checked;
    var qty;
    var owner;
    if (noLesson) {
      // No lesson: always derive from booking surfer count; clear stale user-owned qty.
      qty = surfers != null ? surfers : 1;
      owner = 'surfers';
    } else {
      qty = (was.quantity != null && was.quantity >= 1)
        ? was.quantity
        : (surfers != null ? surfers : 1);
      if (!checked) qty = surfers != null ? surfers : 1;
      // Group/Private: preserve independent equipment qty when only some surfers need gear.
      owner = (checked && was.quantity != null && was.qtyOwner === 'user') ? 'user' : 'surfers';
    }
    // Same anatomy as Create: checkbox offering card + Surfers numeric (hidden for no-lesson).
    var qtyHtml = '';
    if (!noLesson) {
      qtyHtml = '<div class="portal-schedule-create-rental-qty"' + (checked ? '' : ' style="display:none"') + '>'
        + '<label><span data-i18n="schedule.create.rentalQty">'
        + escHtml(portalT('schedule.create.rentalQty') || 'Surfers') + '</span>'
        + '<input type="number" min="1" max="99" class="ps-drawer-rental-qty-input" data-qty-owner="'
        + escHtml(owner) + '" value="' + escHtml(String(qty)) + '"></label>'
        + '</div>';
    } else {
      // Hidden mirror so payload readers still see surfer-derived qty (not user-editable).
      qtyHtml = '<div class="portal-schedule-create-rental-qty" style="display:none" hidden aria-hidden="true">'
        + '<input type="number" min="1" max="99" class="ps-drawer-rental-qty-input" data-qty-owner="surfers" tabindex="-1" value="'
        + escHtml(String(qty)) + '"></div>';
    }
    html += '<div class="portal-schedule-create-rental-row" data-rental-offering="' + escHtml(key) + '">'
      + '<label class="portal-schedule-create-check"><input type="checkbox" class="ps-drawer-rental-check" data-offering-key="'
      + escHtml(key) + '"' + (checked ? ' checked' : '') + '> <span data-i18n="' + escHtml(labelKey) + '">'
      + escHtml(portalT(labelKey) || fallback) + '</span></label>'
      + qtyHtml + '</div>';
  });
  // One pebble strip beneath offerings for combined short mode (filled after selection).
  html += '<div data-rental-duration-pebbles class="portal-schedule-create-rental-pebbles-host" style="display:none"></div>';
  wrap.innerHTML = html;
  var selected = [];
  offerings.forEach(function(o) {
    if (prev[o.offering_key] && prev[o.offering_key].checked) selected.push(o.offering_key);
  });
  if (selected.indexOf('board_and_suit_rental') >= 0
    && (selected.indexOf('board_rental') >= 0 || selected.indexOf('wetsuit_rental') >= 0)) {
    selected = typeof scheduleApplyRentalMutualExclusion === 'function'
      ? scheduleApplyRentalMutualExclusion(selected, 'board_and_suit_rental', true)
      : ['board_and_suit_rental'];
  }
  scheduleDrawerApplyRentalExclusionUi(wrap, selected);
  if (shortMode && scheduleDrawerIsCombinedBoardWetsuit(selected) && commonShort.length
    && typeof scheduleRenderCreateRentalDurationPebbles === 'function') {
    scheduleRenderCreateRentalDurationPebbles(wrap, commonShort, duration);
  }
  scheduleWireDrawerRentals(wrap);
}

function scheduleDrawerPopulateComponentFields() {
  var mode = scheduleDrawerMainActivityValue();
  var courseOn = mode === 'group';
  var privateOn = mode === 'private';
  var noLesson = mode === 'none';
  var cf = el('ps-drawer-course-fields');
  var cq = el('ps-drawer-course-qty-wrap');
  var pf = el('ps-drawer-private-lesson-fields');
  var courseSection = el('ps-drawer-course-section');
  var durationConfirm = el('ps-drawer-course-duration-confirm');
  var privateWhen = el('ps-drawer-private-when');
  var surfersField = el('ps-drawer-surfers-field');
  if (cf) cf.style.display = courseOn ? '' : 'none';
  if (cq) cq.style.display = courseOn ? '' : 'none';
  if (pf) pf.style.display = privateOn ? '' : 'none';
  if (courseSection) courseSection.style.display = (courseOn || privateOn) ? '' : 'none';
  if (durationConfirm) durationConfirm.style.display = courseOn ? '' : 'none';
  if (privateWhen) privateWhen.style.display = privateOn ? '' : 'none';
  // Booking-level Surfers is the no-lesson authority only — hide when group/private own theirs.
  if (surfersField) {
    surfersField.style.display = noLesson ? '' : 'none';
    try {
      if (noLesson) {
        surfersField.removeAttribute('hidden');
        surfersField.setAttribute('aria-hidden', 'false');
      } else {
        surfersField.setAttribute('hidden', '');
        surfersField.setAttribute('aria-hidden', 'true');
      }
    } catch (_sf) { /* ignore */ }
  }
  var dateRange = el('ps-drawer-date-range');
  if (dateRange) dateRange.style.display = '';
  if (privateOn) scheduleDrawerSyncPrivateSessions();
  if (courseOn) {
    scheduleDrawerPopulateCourseSelect();
    scheduleDrawerRefreshDurationConfirm();
  }
  scheduleRenderDrawerRentals();
  scheduleRefreshDrawerFullDayAddon();
  scheduleDrawerRefreshWhenSummary();
  scheduleDrawerSyncFooter();
}

function scheduleDrawerRefreshDurationConfirm(){
  var box=el('ps-drawer-course-duration-confirm'); if(!box) return;
  if(scheduleDrawerMainActivityValue()!=='group'){ box.innerHTML=''; box.style.display='none'; return; }
  box.style.display='';
  var courseSel=el('ps-drawer-course-select'), courseId=courseSel?String(courseSel.value||'').trim():'', span=scheduleDrawerDateSpan();
  var derived=typeof schedulePortalResolveDerivedCourseTier==='function'
    ? schedulePortalResolveDerivedCourseTier(courseId,span.from,span.to)
    : {ok:false,errorKey:'schedule.create.courseDurationUnavailable'};
  if(!derived||!derived.ok){
    box.innerHTML='<p class="portal-schedule-drawer-hint" style="margin:0;color:var(--danger,#b33)">'+escHtml(portalT((derived&&derived.errorKey)||'schedule.create.courseDurationUnavailable'))+'</p>';
    return;
  }
  var lab=derived.tier_label||(typeof schedulePortalDurationLabel==='function'?schedulePortalDurationLabel(derived.tier_key):'')||derived.tier_key;
  box.innerHTML='<p class="portal-schedule-drawer-hint portal-schedule-drawer-duration-ok" style="margin:0">'+escHtml(portalT('schedule.drawer.durationConfirm')+': '+lab)+'</p>';
}

function scheduleDrawerRefreshWhenSummary(){
  var box=el('ps-drawer-when-summary'); if(!box) return;
  if(scheduleDrawerMainActivityValue()==='private'){ box.innerHTML=''; box.style.display='none'; return; }
  box.style.display='';
  var span=scheduleDrawerDateSpan(), df=span.from?String(span.from).slice(0,10):'', dt=span.to?String(span.to).slice(0,10):df;
  if(!df){ box.innerHTML='<p class="portal-schedule-drawer-hint" style="margin:0">'+escHtml(portalT('schedule.drawer.whenPickDates'))+'</p>'; return; }
  var days=typeof schedulePortalInclusiveDateCount==='function'?schedulePortalInclusiveDateCount(df,dt):0;
  var range=df===dt?df:(df+'\u2013'+dt);
  var dayWord=days===1?portalT('schedule.drawer.dayWordCap'):portalT('schedule.drawer.daysWordCap');
  box.innerHTML='<p class="portal-schedule-drawer-hint" style="margin:0">'+escHtml(portalT('schedule.drawer.whenRange')+': '+range+(days>0?(' · '+days+' '+dayWord):''))+'</p>';
}

function scheduleRefreshDrawerFullDayAddon() {
  var field = el('ps-drawer-addon-fullday-field');
  if (!field) return;
  var mode = scheduleDrawerMainActivityValue();
  var courseOn = mode === 'group';
  var privateOn = mode === 'private';
  var rentals = scheduleReadDrawerRentalSelectionFromDom();
  var boardOn = rentals.some(function(r) {
    return r.offering_key === 'board_rental' || r.offering_key === 'board_and_suit_rental';
  });
  var wetsuitOn = rentals.some(function(r) {
    return r.offering_key === 'wetsuit_rental' || r.offering_key === 'board_and_suit_rental';
  });
  var hasEligibleBase = courseOn || privateOn || boardOn || wetsuitOn;
  var eligibleDates = [];
  var defaultQty = 1;
  if (privateOn) {
    var sessions = scheduleDrawerReadPrivateSessionsFromDom();
    var seen = {};
    for (var i = 0; i < sessions.length; i++) {
      var d = sessions[i].date;
      if (d && !seen[d]) { seen[d] = 1; eligibleDates.push(d); }
    }
    eligibleDates.sort();
    defaultQty = parseInt((el('ps-drawer-private-lesson-surfers') && el('ps-drawer-private-lesson-surfers').value) || '1', 10) || 1;
  } else {
    var span = scheduleDrawerDateSpan();
    eligibleDates = typeof scheduleEnumerateDates === 'function'
      ? (scheduleEnumerateDates(span.from, span.to || span.from) || []) : [];
    var qtys = [];
    if (courseOn) qtys.push(parseInt((el('ps-drawer-course-qty') && el('ps-drawer-course-qty').value) || '1', 10) || 1);
    rentals.forEach(function(r) { qtys.push(parseInt(r.quantity, 10) || 1); });
    defaultQty = qtys.length ? Math.max.apply(null, qtys) : 1;
  }
  var show = scheduleFullDayAddonEnabled && hasEligibleBase && eligibleDates.length > 0;
  var checkbox = el('ps-drawer-comp-fullday');
  var rows = el('ps-drawer-fullday-rows');
  var summary = el('ps-drawer-fullday-summary');
  var seed = null;
  var domSeed = scheduleReadFullDayAddonRows('ps-drawer-fullday-rows');
  if (Object.keys(domSeed).length) seed = domSeed;
  else {
    try { seed = JSON.parse(field.getAttribute('data-addon-seed') || '{}'); } catch (_e) { seed = {}; }
  }
  var seedDates = seed ? Object.keys(seed) : [];
  if (!scheduleFullDayAddonEnabled && seedDates.length) show = true;
  var mergedDates = eligibleDates.slice();
  for (var s = 0; s < seedDates.length; s++) {
    if (mergedDates.indexOf(seedDates[s]) < 0) mergedDates.push(seedDates[s]);
  }
  mergedDates.sort();
  field.style.display = show ? '' : 'none';
  if (!show) {
    if (checkbox) checkbox.checked = false;
    if (rows) rows.style.display = 'none';
    if (summary) summary.style.display = 'none';
    return;
  }
  var on = !!(checkbox && checkbox.checked);
  if (rows) rows.style.display = on ? '' : 'none';
  if (on) {
    scheduleRenderFullDayAddonRows('ps-drawer-fullday-rows', 'ps-drawer-fullday-summary', mergedDates, defaultQty, seed, scheduleUpdateDrawerTotalPreview);
  } else if (summary) {
    summary.style.display = 'none';
  }
}

function scheduleUpdateDrawerTotalPreview(){
  scheduleUpdateFullDayAddonSummary('ps-drawer-fullday-rows','ps-drawer-fullday-summary');
  scheduleDrawerSyncFooter();
}

function scheduleDrawerOnComponentChange(changedId){
  if(changedId==='ps-drawer-comp-course') scheduleDrawerSetMainActivity('group');
  else if(changedId==='ps-drawer-comp-private-lesson') scheduleDrawerSetMainActivity('private');
  else if(changedId==='ps-drawer-comp-no-lesson') scheduleDrawerSetMainActivity('none');
  scheduleDrawerMarkPriceStale(); scheduleDrawerPopulateComponentFields();
}

function scheduleDrawerPopulateCourseSelect() {
  var sel = el('ps-drawer-course-select');
  if (!sel) return Promise.resolve();
  var selected = sel.getAttribute('data-selected') || sel.value || '';
  return scheduleFetchLessonTimesConfig(getClient()).then(function() {
    var courses = scheduleCoursesCache || [];
    var html = '';
    courses.forEach(function(c) {
      var id = String(c.course_id || '').trim();
      if (!id) return;
      html += '<option value="' + escHtml(id) + '" data-label="' + escHtml(c.label || id) + '">' +
        escHtml(c.label || id) + '</option>';
    });
    if (!html) html = '<option value="">' + escHtml(portalT('schedule.courses.noneConfigured')) + '</option>';
    sel.innerHTML = html;
    if (selected) sel.value = selected;
    if (!sel._editBound) {
      sel._editBound = true;
      sel.addEventListener('change', function() {
        scheduleDrawerMarkPriceStale();
        scheduleDrawerRefreshDurationConfirm();
        scheduleDrawerSyncFooter();
      });
    }
    scheduleDrawerRefreshDurationConfirm();
    return sel;
  });
}

function scheduleDrawerReadPrivateSessionsFromDom() {
  var wrap = el('ps-drawer-private-sessions');
  var out = [];
  if (!wrap) return out;
  wrap.querySelectorAll('.portal-schedule-private-session-row').forEach(function(row) {
    var dateAttr = row.getAttribute('data-session-date') || '';
    var d = row.querySelector('.ps-pl-session-date');
    var s = row.querySelector('.ps-pl-session-start');
    var e = row.querySelector('.ps-pl-session-end');
    out.push({
      date: dateAttr || (d ? d.value : ''),
      start: s ? s.value : '',
      end: e ? e.value : '',
    });
  });
  return out;
}

function scheduleDrawerRenderPrivateSessions(sessions) {
  var wrap = el('ps-drawer-private-sessions');
  if (!wrap) return;
  var html = '';
  (sessions || []).forEach(function(sess, i) {
    var date = sess.date || '';
    html += '<div class="portal-schedule-private-session-row" data-session-index="' + String(i + 1) +
      '" data-session-date="' + escHtml(date) + '">' +
      '<p class="portal-schedule-card-sub" style="margin:8px 0 4px">' + escHtml(date) + '</p>' +
      '<div class="portal-schedule-private-session-grid">' +
      '<label><span>' + escHtml(portalT('schedule.create.privateLesson.start')) + '</span>' +
      '<input class="ps-pl-session-start" type="time" value="' + escHtml(sess.start || '') + '"></label>' +
      '<label><span>' + escHtml(portalT('schedule.create.privateLesson.end')) + '</span>' +
      '<input class="ps-pl-session-end" type="time" value="' + escHtml(sess.end || '') + '"></label>' +
      '</div></div>';
  });
  wrap.innerHTML = html;
  wrap.querySelectorAll('.ps-pl-session-start, .ps-pl-session-end').forEach(function(node) {
    if (node.dataset.editWired) return;
    node.dataset.editWired = '1';
    node.addEventListener('change', function() {
      scheduleDrawerMarkPriceStale();
      scheduleRefreshDrawerFullDayAddon();
      scheduleDrawerSyncFooter();
    });
  });
}

function scheduleDrawerSyncPrivateSessions(opts) {
  opts = opts || {};
  var wrap = el('ps-drawer-private-sessions');
  if (!wrap) return;
  var span = scheduleDrawerDateSpan();
  var from = typeof schedulePortalCanonicalDateIso === 'function'
    ? schedulePortalCanonicalDateIso(span.from) : String(span.from || '').slice(0, 10);
  var to = typeof schedulePortalCanonicalDateIso === 'function'
    ? schedulePortalCanonicalDateIso(span.to || span.from) : String(span.to || span.from || '').slice(0, 10);
  var dates = [];
  if (from && to && from <= to && typeof scheduleEnumerateDates === 'function') {
    dates = scheduleEnumerateDates(from, to) || [];
  }
  var rangeTooLong = dates.length > 30;
  if (rangeTooLong) dates = [];
  var existing = rangeTooLong ? [] : scheduleDrawerReadPrivateSessionsFromDom();
  if (!existing.length && !opts.skipCtxSeed) {
    var ctx = scheduleDrawerState.ctx || {};
    var pl = (ctx.components && ctx.components.private_lesson) || null;
    if (pl && Array.isArray(pl.sessions)) {
      existing = pl.sessions.map(function(s) {
        return { date: s.date, start: s.start || '', end: s.end || '' };
      });
    }
  }
  var byDate = Object.create(null);
  for (var e = 0; e < existing.length; e++) {
    var ed = existing[e] && existing[e].date
      ? (typeof schedulePortalCanonicalDateIso === 'function'
        ? schedulePortalCanonicalDateIso(existing[e].date)
        : String(existing[e].date).slice(0, 10))
      : '';
    if (ed && byDate[ed] == null) byDate[ed] = existing[e];
  }
  var sessions = [];
  for (var i = 0; i < dates.length; i++) {
    var date = dates[i];
    var prev = byDate[date] || {};
    sessions.push({
      date: date,
      start: prev.start != null ? String(prev.start) : '',
      end: prev.end != null ? String(prev.end) : '',
    });
  }
  try {
    if (rangeTooLong) wrap.setAttribute('data-range-too-long', '1');
    else wrap.removeAttribute('data-range-too-long');
  } catch (_r) { /* ignore */ }
  scheduleDrawerRenderPrivateSessions(sessions);
  if (rangeTooLong) {
    scheduleDrawerValidationState = { ok: false, errorKey: 'schedule.create.privateLesson.rangeTooLong' };
  }
}

function scheduleDrawerMarkPriceStale(){
  scheduleDrawerPriceStale=true;
  var msg=el('ps-drawer-save-msg');
  if(msg&&msg.dataset&&msg.dataset.reprice==='1'){ msg.style.display='none'; msg.textContent=''; msg.dataset.reprice=''; }
  // Invalidate any painted € total immediately when pricing intent drifts.
  scheduleDrawerQuoteState = null;
}

function scheduleDrawerQuotePricingIntentKey(payload) {
  if (typeof schedulePortalQuotePricingIntentKey === 'function') {
    return schedulePortalQuotePricingIntentKey(payload);
  }
  return JSON.stringify({
    date_from: payload && payload.date_from,
    date_to: payload && payload.date_to,
    rentals: payload && payload.rentals,
    components: payload && payload.components,
    surfer_count: payload && payload.surfer_count,
    custom_line_items: payload && payload.custom_line_items,
  });
}

function scheduleDrawerClearQuotePreviewUi() {
  scheduleDrawerQuoteState = null;
  var box = el('ps-drawer-quote-preview');
  if (box) { box.innerHTML = ''; box.style.display = 'none'; }
}

function scheduleDrawerShowQuoteChecking() {
  var box = el('ps-drawer-quote-preview');
  if (!box) return;
  try { box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); } catch (_e) { /* ignore */ }
  box.innerHTML = '<p class="portal-schedule-drawer-hint portal-schedule-quote-checking" style="margin:0">'
    + escHtml(portalT('schedule.create.checkingPrice') || 'Checking price\u2026') + '</p>';
  box.style.display = 'block';
}

/**
 * Drop quote state + € display when pricing intent drifted (date/surfer/rental).
 * Leaves "Checking price…" alone so in-flight requote UI is preserved.
 */
function scheduleDrawerDropStaleQuoteUi(payload) {
  var key = scheduleDrawerQuotePricingIntentKey(payload || {});
  if (scheduleDrawerQuoteState && scheduleDrawerQuoteState.intent_key === key) return false;
  scheduleDrawerQuoteState = null;
  var box = el('ps-drawer-quote-preview');
  if (!box) return true;
  var html = String(box.innerHTML || '');
  if (/portal-schedule-quote-checking|checkingPrice|Checking price/i.test(html)) return true;
  if (/€\d|Quoted total|quoteTotal/i.test(html)) {
    box.innerHTML = '';
    box.style.display = 'none';
  }
  return true;
}

function scheduleDrawerRenderQuotePreview(result) {
  var box = el('ps-drawer-quote-preview');
  if (!box) return;
  if (result && (result.superseded || result.aborted)) return;
  try { box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); } catch (_e) { /* ignore */ }
  if (result && (result.idle || result.softInvalid)) {
    scheduleDrawerQuoteState = null;
    box.innerHTML = '';
    box.style.display = 'none';
    return;
  }
  if (result && result.checking) { scheduleDrawerShowQuoteChecking(); return; }
  if (!result || !result.ok) {
    var err = portalT('schedule.create.quoteFailed') || 'Quote unavailable';
    if (result && result.stale) err = portalT('schedule.create.quoteStale') || 'Price changed — refresh quote before saving.';
    else if (result && result.status === 503) err = portalT('schedule.create.quoteBusy') || 'Price check is busy — wait a moment and try again.';
    box.innerHTML = '<p class="portal-schedule-drawer-hint" style="margin:0;color:var(--danger,#b33)">' + escHtml(String(err)) + '</p>';
    box.style.display = 'block';
    return;
  }
  // Never paint a total whose pricing intent no longer matches the live Edit form.
  if (result.intent_key != null || (scheduleDrawerQuoteState && scheduleDrawerQuoteState.intent_key != null)) {
    var livePayload = null;
    try { livePayload = scheduleReadDrawerEditPayload(); } catch (_lp) { livePayload = null; }
    var liveIntent = livePayload ? scheduleDrawerQuotePricingIntentKey(livePayload) : null;
    var resultIntent = result.intent_key != null
      ? result.intent_key
      : (scheduleDrawerQuoteState && scheduleDrawerQuoteState.intent_key);
    if (liveIntent != null && resultIntent != null && liveIntent !== resultIntent) {
      scheduleDrawerQuoteState = null;
      box.innerHTML = '';
      box.style.display = 'none';
      return;
    }
  }
  var raw = typeof schedulePortalStrictQuoteTotalCents === 'function'
    ? schedulePortalStrictQuoteTotalCents(result.body)
    : (result.body && result.body.total_cents);
  if (raw == null || (typeof schedulePortalStrictQuoteTotalCents !== 'function'
    && (typeof raw !== 'number' || !Number.isFinite(raw) || Math.floor(raw) !== raw || raw < 0 || raw > Number.MAX_SAFE_INTEGER))) {
    box.innerHTML = '<p class="portal-schedule-drawer-hint" style="margin:0;color:var(--danger,#b33)">'
      + escHtml(portalT('schedule.create.quoteFailed') || 'Quote unavailable') + '</p>';
    box.style.display = 'block';
    return;
  }
  box.innerHTML = '<p class="portal-schedule-drawer-hint" style="margin:0">'
    + escHtml((portalT('schedule.create.quoteTotal') || 'Quoted total') + ': \u20ac' + (raw / 100).toFixed(2)) + '</p>';
  box.style.display = 'block';
}

function scheduleDrawerHumanCourseBit(course) {
  var id = course && course.course_id != null ? String(course.course_id).trim() : '';
  var sel = el('ps-drawer-course-select');
  var opt = (sel && sel.options && sel.selectedIndex >= 0) ? sel.options[sel.selectedIndex] : null;
  var cands = [
    opt ? String((opt.getAttribute && opt.getAttribute('data-label')) || opt.textContent || '').trim() : '',
    course && course.course_label != null ? String(course.course_label).trim() : '',
  ];
  if (typeof scheduleResolveCourseDisplayLabel === 'function') {
    cands.push(String(scheduleResolveCourseDisplayLabel(id, cands[1]) || '').trim());
  }
  for (var i = 0; i < cands.length; i++) {
    var lab = cands[i];
    if (!lab || (id && lab === id) || (course && course.tier_key && lab === String(course.tier_key))) continue;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lab)) continue;
    return lab;
  }
  return '';
}

/**
 * Compact two-row Edit footer summary — same hierarchy as Create.
 * Primary: identity/qty/gear/custom; secondary: one duration + compact date + guest.
 * Payment status is owned by the Payment Status control — never repeated here.
 */
function scheduleDrawerRenderIntentSummary(payload) {
  var box = el('ps-drawer-summary');
  if (!box) return;
  var p = payload || {};
  var comps = p.components || {};
  var rentals = Array.isArray(p.rentals) ? p.rentals : [];
  var customLines = Array.isArray(p.custom_line_items) ? p.custom_line_items : [];
  var hasLesson = !!(comps.course || comps.private_lesson);
  var hasGear = rentals.length > 0 || !!(comps.surfboard || comps.wetsuit || comps.full_day_equipment_extension);
  var hasCustom = customLines.some(function(l) { return l && String(l.label || '').trim(); });
  if (!hasLesson && !hasGear && !hasCustom) {
    box.innerHTML = '<span class="portal-schedule-create-summary-placeholder">'
      + escHtml(portalT('schedule.create.summary.chooseLessonOrGear') || 'Choose a lesson or add gear') + '</span>';
    return;
  }

  var primary = [];
  var secondary = [];
  var durationLab = '';

  if (comps.course) {
    var cLab = scheduleDrawerHumanCourseBit(comps.course);
    if (cLab) primary.push(cLab);
    else primary.push(portalT('schedule.type.course') || 'Group course');
    var tierLab = comps.course.tier_label != null ? String(comps.course.tier_label).trim() : '';
    if (!tierLab && comps.course.tier_key) {
      tierLab = (typeof schedulePortalDurationLabel === 'function'
        ? schedulePortalDurationLabel(comps.course.tier_key) : '') || '';
    }
    if (tierLab && tierLab !== String(comps.course.tier_key || '')) durationLab = tierLab;
    if (comps.course.quantity) primary.push('\u00d7' + String(comps.course.quantity));
  } else if (comps.private_lesson) {
    var pl = comps.private_lesson;
    primary.push(portalT('schedule.type.privateLesson') || 'Private course');
    var sessN = Array.isArray(pl.sessions) ? pl.sessions.length : (pl.quantity || 0);
    if (sessN) primary.push((portalT('schedule.create.summary.sessions') || 'Sessions') + ': ' + String(sessN));
    if (pl.surfer_count) primary.push((portalT('schedule.create.summary.surfers') || 'Surfers') + ': ' + String(pl.surfer_count));
    var dates = (pl.sessions || []).map(function(s) {
      return s && s.date ? String(s.date).slice(0, 10) : '';
    }).filter(Boolean).sort();
    if (dates.length && typeof schedulePortalFormatCompactDateRange === 'function') {
      var plCompact = schedulePortalFormatCompactDateRange(
        dates[0],
        dates.length > 1 ? dates[dates.length - 1] : dates[0],
      );
      if (plCompact) secondary.push(plCompact);
    }
  } else {
    primary.push(portalT('schedule.type.noLesson') || 'No lesson');
  }

  function gearLabelOnly(key, q) {
    var lab = typeof schedulePortalRentalLabel === 'function'
      ? schedulePortalRentalLabel(key) : '';
    if (!lab && typeof scheduleRentalOfferingLabelKey === 'function') {
      var ik = scheduleRentalOfferingLabelKey(key);
      lab = ik ? portalT(ik) : '';
      if (lab === ik) lab = '';
    }
    if (!lab) return '';
    return (Number(q) > 1) ? (lab + ' \u00d7' + q) : lab;
  }
  if (rentals.length) {
    var gearBits = [];
    for (var ri = 0; ri < rentals.length; ri++) {
      var r = rentals[ri];
      if (!r || !r.offering_key) continue;
      var gLab = gearLabelOnly(r.offering_key, r.quantity);
      if (gLab) gearBits.push(gLab);
      if (!durationLab && r.duration_key) {
        var gDur = typeof schedulePortalDurationLabel === 'function'
          ? schedulePortalDurationLabel(r.duration_key) : '';
        if (gDur && gDur !== String(r.duration_key)) durationLab = gDur;
      }
    }
    if (gearBits.length) primary.push(gearBits.join(', '));
  } else {
    if (comps.surfboard) {
      var sb = gearLabelOnly('board_rental', comps.surfboard.quantity);
      if (sb) primary.push(sb);
    }
    if (comps.wetsuit) {
      var ws = gearLabelOnly('wetsuit_rental', comps.wetsuit.quantity);
      if (ws) primary.push(ws);
    }
  }
  if (comps.full_day_equipment_extension) {
    primary.push(portalT('schedule.type.fullDayEquipment') || 'Full-day gear');
  }
  for (var ci = 0; ci < customLines.length; ci++) {
    var cl = customLines[ci];
    var clLab = cl && cl.label != null ? String(cl.label).trim() : '';
    if (clLab) primary.push(clLab);
  }

  if (durationLab) secondary.push(durationLab);
  if (!comps.private_lesson) {
    var df = p.date_from ? String(p.date_from).slice(0, 10) : '';
    var dt = p.date_to ? String(p.date_to).slice(0, 10) : df;
    var compact = (df && typeof schedulePortalFormatCompactDateRange === 'function')
      ? schedulePortalFormatCompactDateRange(df, dt) : '';
    if (compact) secondary.push(compact);
  }
  var guestName = p.guest_name != null ? String(p.guest_name).trim() : '';
  if (guestName) secondary.push(guestName);

  var html = '';
  if (primary.length) {
    html += '<span class="portal-schedule-create-summary-primary">' + escHtml(primary.join(' \u00b7 ')) + '</span>';
  }
  if (secondary.length) {
    html += '<span class="portal-schedule-create-summary-secondary">' + escHtml(secondary.join(' \u00b7 ')) + '</span>';
  }
  if (!html) {
    html = '<span class="portal-schedule-create-summary-placeholder">'
      + escHtml(portalT('schedule.create.summary.chooseLessonOrGear') || 'Choose a lesson or add gear') + '</span>';
  }
  box.innerHTML = html;
}

function scheduleDrawerRefreshQuote() {
  if (scheduleDrawerSaveInFlight) return Promise.resolve(null);
  if (scheduleDrawerQuoteTimer != null) {
    clearTimeout(scheduleDrawerQuoteTimer);
    scheduleDrawerQuoteTimer = null;
  }
  var payload = null;
  try { payload = scheduleReadDrawerEditPayload(); } catch (_r) { payload = null; }
  var gate = scheduleDrawerValidateEditPayload(payload || {});
  if (!gate.ok) {
    if (scheduleDrawerQuoteAbort) {
      try { scheduleDrawerQuoteAbort.abort(); } catch (_a) { /* ignore */ }
      scheduleDrawerQuoteAbort = null;
    }
    scheduleDrawerQuoteGen += 1;
    scheduleDrawerClearQuotePreviewUi();
    return Promise.resolve(null);
  }
  if (scheduleDrawerQuoteAbort) {
    try { scheduleDrawerQuoteAbort.abort(); } catch (_a2) { /* ignore */ }
    scheduleDrawerQuoteAbort = null;
  }
  scheduleDrawerQuoteGen += 1;
  // Invalidate prior total immediately so a stale €40 cannot linger beside a multi-day summary.
  scheduleDrawerQuoteState = null;
  scheduleDrawerShowQuoteChecking();
  var wait = Number(scheduleDrawerQuoteDebounceMs);
  if (!(wait >= 0 && wait <= 500)) wait = 400;
  var myGen = scheduleDrawerQuoteGen;
  var intentKey = scheduleDrawerQuotePricingIntentKey(payload);
  var scheduleLater = typeof setTimeout === 'function'
    ? setTimeout
    : function(fn) { try { fn(); } catch (_f) { /* ignore */ } return null; };
  return new Promise(function(resolve) {
    scheduleDrawerQuoteTimer = scheduleLater(function() {
      scheduleDrawerQuoteTimer = null;
      if (myGen !== scheduleDrawerQuoteGen) { resolve({ ok: false, superseded: true }); return; }
      var controller = null;
      if (typeof AbortController !== 'undefined') {
        controller = new AbortController();
        scheduleDrawerQuoteAbort = controller;
      }
      var body = {
        location_id: typeof getSunsetLocation === 'function' ? getSunsetLocation() : null,
        guest_name: payload.guest_name != null ? payload.guest_name : '',
        guest_phone: payload.guest_phone != null ? payload.guest_phone : '',
        date_from: payload.date_from,
        date_to: payload.date_to,
        components: payload.components,
        rentals: Array.isArray(payload.rentals) ? payload.rentals : [],
        surfer_count: payload.surfer_count != null ? payload.surfer_count : null,
        custom_line_items: Array.isArray(payload.custom_line_items) ? payload.custom_line_items : [],
      };
      var url = '/staff/schedule/bookings/quote?client=' + encodeURIComponent(
        typeof getClient === 'function' ? getClient() : 'sunset',
      ) + (typeof sunsetLocationQuerySuffix === 'function' ? sunsetLocationQuerySuffix() : '');
      var fetchOpts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      };
      if (controller) fetchOpts.signal = controller.signal;
      var run = typeof fetch === 'function' ? fetch(url, fetchOpts) : Promise.reject(new Error('no fetch'));
      run.then(function(r) {
        return r.json().then(function(data) { return { ok: r.ok, status: r.status, data: data }; });
      }).then(function(res) {
        if (myGen !== scheduleDrawerQuoteGen) return { ok: false, superseded: true };
        var data = (res && res.data) || {};
        if (!res.ok || !data.success) {
          scheduleDrawerQuoteState = null;
          scheduleDrawerRenderQuotePreview({
            ok: false,
            error: data.error || data.reason || data.reason_code,
            stale: data.reason_code === 'quote_stale',
            status: res.status,
            body: data,
          });
          return { ok: false, body: data };
        }
        var totalCents = typeof schedulePortalStrictQuoteTotalCents === 'function'
          ? schedulePortalStrictQuoteTotalCents(data)
          : data.total_cents;
        if (totalCents == null) {
          scheduleDrawerQuoteState = null;
          scheduleDrawerRenderQuotePreview({ ok: false, error: 'invalid_quote_total', body: data });
          return { ok: false, body: data };
        }
        // Reject apply when pricing intent already drifted mid-flight.
        var livePayload = null;
        try { livePayload = scheduleReadDrawerEditPayload(); } catch (_lp) { livePayload = null; }
        var liveKey = livePayload ? scheduleDrawerQuotePricingIntentKey(livePayload) : intentKey;
        if (liveKey != null && intentKey != null && liveKey !== intentKey) {
          scheduleDrawerQuoteState = null;
          scheduleDrawerClearQuotePreviewUi();
          return { ok: false, superseded: true };
        }
        scheduleDrawerQuoteState = { intent_key: intentKey, total_cents: totalCents };
        scheduleDrawerRenderQuotePreview({
          ok: true,
          body: data,
          intent_key: intentKey,
        });
        return { ok: true, body: data, intent_key: intentKey };
      }).catch(function(err) {
        if (myGen !== scheduleDrawerQuoteGen) return { ok: false, superseded: true };
        if (err && err.name === 'AbortError') return { ok: false, aborted: true };
        scheduleDrawerRenderQuotePreview({ ok: false, error: err && err.message });
        return null;
      }).then(function(result) {
        if (scheduleDrawerQuoteAbort === controller) scheduleDrawerQuoteAbort = null;
        resolve(result);
      });
    }, wait);
  });
}

function scheduleDrawerValidateEditPayload(payload) {
  var p = payload || {}, comps = p.components || {};
  if (!(p.guest_name && String(p.guest_name).trim())) return { ok: false, errorKey: 'schedule.create.guestRequired' };
  if (!Object.keys(comps).length && !(Array.isArray(p.rentals) && p.rentals.length)) return { ok: false, errorKey: 'schedule.create.componentsRequired' };
  if (comps.course) {
    if (!String(comps.course.course_id || '').trim()) return { ok: false, errorKey: 'schedule.create.courseRequired' };
    if (!String(comps.course.tier_key || '').trim()) return { ok: false, errorKey: 'schedule.create.courseDurationUnavailable' };
  }
  if (comps.private_lesson) {
    var plSpan = typeof schedulePortalInclusiveDateCount === 'function'
      ? schedulePortalInclusiveDateCount(p.date_from, p.date_to != null ? p.date_to : p.date_from) : 0;
    if (plSpan > 30) return { ok: false, errorKey: 'schedule.create.privateLesson.rangeTooLong' };
    if (typeof schedulePortalValidatePrivateLessonCreate === 'function') {
      var plCheck = schedulePortalValidatePrivateLessonCreate(comps.private_lesson);
      if (!plCheck || plCheck.ok !== true) return { ok: false, errorKey: (plCheck && plCheck.errorKey) || 'schedule.create.privateLesson.sessionIncomplete' };
    }
  }
  // Blank/invalid Surfers cannot Save or quote (no silent fallback to 1).
  var rentals = Array.isArray(p.rentals) ? p.rentals : [];
  var needsSurfers = !!(comps.course || comps.private_lesson || rentals.length
    || comps.full_day_equipment_extension);
  if (!needsSurfers) {
    // No-lesson with checked rental but invalid surfer may serialize empty rentals —
    // still block when the live input is invalid and a rental is checked.
    try {
      if (scheduleDrawerMainActivityValue() === 'none') {
        var wrap = el('ps-drawer-rentals');
        if (wrap) {
          wrap.querySelectorAll('.ps-drawer-rental-check').forEach(function(c) {
            if (c && c.checked) needsSurfers = true;
          });
        }
      }
    } catch (_n) { /* ignore */ }
  }
  if (needsSurfers) {
    var sn = null;
    try { sn = scheduleDrawerReadSurferCount(); } catch (_s) { sn = null; }
    if (sn == null && p.surfer_count != null) {
      var fromPayload = Number(p.surfer_count);
      if (Number.isFinite(fromPayload) && Math.floor(fromPayload) === fromPayload && fromPayload >= 1) {
        sn = fromPayload;
      }
    }
    if (!(Number.isInteger(sn) && sn >= 1 && sn <= 99)) {
      return { ok: false, errorKey: 'schedule.create.surfersRequired' };
    }
  }
  return { ok: true };
}

function scheduleReadDrawerEditPayload() {
  var guest = (el('ps-drawer-guest') && el('ps-drawer-guest').value || '').trim();
  var phone = (el('ps-drawer-phone') && el('ps-drawer-phone').value || '').trim();
  var span = scheduleDrawerDateSpan();
  var dateFrom = span.from;
  var dateTo = span.to || dateFrom;
  var paymentSel = el('ps-drawer-payment') ? el('ps-drawer-payment').value : 'unpaid';
  var pm = scheduleParsePaymentSelectValue(paymentSel);
  var notes = (el('ps-drawer-notes') && el('ps-drawer-notes').value || '').trim();
  var components = {};
  var mode = scheduleDrawerMainActivityValue();
  if (mode === 'group') {
    var courseSel = el('ps-drawer-course-select');
    var courseOpt = courseSel && courseSel.selectedIndex >= 0 ? courseSel.options[courseSel.selectedIndex] : null;
    var courseId = courseSel ? String(courseSel.value || '').trim() : '';
    components.course = {
      quantity: parseInt((el('ps-drawer-course-qty') && el('ps-drawer-course-qty').value) || '1', 10) || 1,
      course_id: courseId,
      course_label: courseOpt ? (courseOpt.getAttribute('data-label') || courseOpt.textContent || '') : '',
    };
    var derived = typeof schedulePortalResolveDerivedCourseTier === 'function'
      ? schedulePortalResolveDerivedCourseTier(courseId, dateFrom, dateTo)
      : null;
    if (derived && derived.ok && derived.tier_key) {
      components.course.tier_key = derived.tier_key;
      components.course.offering_id = derived.offering_id || ('surf_pack_' + courseId + '__' + derived.tier_key);
      if (derived.tier_label) components.course.tier_label = derived.tier_label;
    }
  }
  if (mode === 'private') {
    var plSurfers = parseInt((el('ps-drawer-private-lesson-surfers') && el('ps-drawer-private-lesson-surfers').value) || '1', 10) || 1;
    var plSessions = scheduleDrawerReadPrivateSessionsFromDom().filter(function(s) { return s.date; });
    components.private_lesson = {
      enabled: true,
      quantity: plSessions.length,
      surfer_count: plSurfers,
      sessions: plSessions,
    };
  }
  var rentals = scheduleReadDrawerRentalSelectionFromDom();
  if (typeof scheduleRentalsToLegacyComponents === 'function') {
    var rentalComponents = scheduleRentalsToLegacyComponents(rentals);
    Object.keys(rentalComponents).forEach(function(k) { components[k] = rentalComponents[k]; });
  }
  if (el('ps-drawer-comp-fullday') && el('ps-drawer-comp-fullday').checked) {
    var addonDates = scheduleReadFullDayAddonRows('ps-drawer-fullday-rows');
    if (Object.keys(addonDates).length) {
      components.full_day_equipment_extension = { enabled: true, dates: addonDates };
    }
  }
  var custom_line_items = (scheduleDrawerCustomLines || []).map(function(l) {
    return {
      client_line_id: String(l.client_line_id),
      label: String(l.label),
      amount_cents: Number(l.amount_cents),
    };
  });
  var surferCount = scheduleDrawerReadSurferCount();
  return {
    guest_name: guest,
    guest_phone: phone || null,
    date_from: dateFrom,
    date_to: dateTo,
    payment_status: pm.status,
    payment_method: pm.method,
    notes: notes,
    components: components,
    rentals: rentals,
    custom_line_items: custom_line_items,
    // No-lesson equipment qty authority (server forces rentals to this when present).
    surfer_count: surferCount,
  };
}

function scheduleDrawerSeedCustomLinesFromCtx(ctx) {
  scheduleDrawerCustomLines = [];
  scheduleDrawerCustomLineSeq = 0;
  scheduleDrawerCustomLineEditorOpen = false;
  var seed = [];
  if (ctx && Array.isArray(ctx.custom_line_items) && ctx.custom_line_items.length) {
    seed = ctx.custom_line_items;
  } else if (ctx && ctx.payment && Array.isArray(ctx.payment.line_items)) {
    seed = ctx.payment.line_items.filter(function(li) {
      return li && (li.component === 'staff_custom_line' || li.price_source === 'staff_custom_line'
        || (li.client_line_id && String(li.client_line_id).indexOf('cl_') === 0));
    }).map(function(li) {
      return {
        client_line_id: String(li.client_line_id || ('cl_seed_' + String(li.service_record_id || Math.random()).slice(0, 8))),
        label: String(li.label || 'Custom line'),
        amount_cents: Number(li.line_cents != null ? li.line_cents : li.total_cents) || 0,
      };
    });
  }
  seed.forEach(function(l) {
    if (!l || !l.client_line_id || !l.label) return;
    scheduleDrawerCustomLineSeq += 1;
    scheduleDrawerCustomLines.push({
      client_line_id: String(l.client_line_id),
      label: String(l.label),
      amount_cents: Number(l.amount_cents) || 0,
    });
  });
}

function scheduleDrawerSetCustomLineEditorOpen(open) {
  scheduleDrawerCustomLineEditorOpen = !!open;
  var collapsed = el('ps-drawer-custom-lines-collapsed');
  var editor = el('ps-drawer-custom-lines-editor');
  var err = el('ps-drawer-custom-line-error');
  if (collapsed) collapsed.style.display = open ? 'none' : 'flex';
  if (editor) {
    editor.style.display = open ? 'flex' : 'none';
    if (open) { editor.removeAttribute('hidden'); editor.setAttribute('aria-hidden', 'false'); }
    else { editor.setAttribute('hidden', ''); editor.setAttribute('aria-hidden', 'true'); }
  }
  if (err) { err.style.display = 'none'; err.textContent = ''; }
  if (open) {
    var lab = el('ps-drawer-custom-line-label');
    var price = el('ps-drawer-custom-line-price');
    if (lab) lab.value = '';
    if (price) price.value = '';
    try { if (lab) lab.focus(); } catch (_f) { /* ignore */ }
  }
}

function scheduleDrawerRenderCustomLines() {
  var list = el('ps-drawer-custom-lines-list');
  if (!list) return;
  if (!scheduleDrawerCustomLines.length) {
    list.innerHTML = '';
    return;
  }
  var removeLab = (typeof portalT === 'function' ? portalT('schedule.create.customLine.remove') : '') || 'Remove';
  var esc = typeof scheduleEscapeHtmlLite === 'function' ? scheduleEscapeHtmlLite : escHtml;
  var fmt = typeof scheduleFormatCentsMoney === 'function'
    ? scheduleFormatCentsMoney
    : function(c) { return '€' + (Number(c) / 100).toFixed(2); };
  list.innerHTML = scheduleDrawerCustomLines.map(function(line) {
    return '<div class="portal-schedule-create-custom-line-row" data-client-line-id="'
      + esc(line.client_line_id) + '">'
      + '<span class="ps-cl-label">' + esc(line.label) + '</span>'
      + '<span class="ps-cl-amount">' + esc(fmt(line.amount_cents)) + '</span>'
      + '<button type="button" class="ps-cl-remove" data-remove-drawer-custom-line="'
      + esc(line.client_line_id) + '" aria-label="' + esc(removeLab) + '">\u00d7</button></div>';
  }).join('');
}

function scheduleDrawerConfirmCustomLine() {
  var err = el('ps-drawer-custom-line-error');
  function fail(msg) {
    if (err) { err.textContent = msg; err.style.display = 'block'; }
  }
  var labelRaw = el('ps-drawer-custom-line-label') ? el('ps-drawer-custom-line-label').value : '';
  var label = String(labelRaw || '').trim();
  if (!label) {
    return fail((typeof portalT === 'function' ? portalT('schedule.create.customLine.labelRequired') : '') || 'Label is required');
  }
  if (label.length > 120) {
    return fail((typeof portalT === 'function' ? portalT('schedule.create.customLine.labelTooLong') : '') || 'Label max 120 characters');
  }
  var priceRaw = el('ps-drawer-custom-line-price') ? el('ps-drawer-custom-line-price').value : '';
  var parsed = typeof scheduleParseCreateMoneyToCents === 'function'
    ? scheduleParseCreateMoneyToCents(priceRaw)
    : { ok: false };
  if (!parsed.ok) {
    return fail((typeof portalT === 'function' ? portalT('schedule.create.customLine.priceInvalid') : '') || 'Enter a valid price (max 2 decimals)');
  }
  if (scheduleDrawerCustomLines.length >= 20) {
    return fail((typeof portalT === 'function' ? portalT('schedule.create.customLine.tooMany') : '') || 'Too many custom lines');
  }
  scheduleDrawerCustomLineSeq += 1;
  scheduleDrawerCustomLines.push({
    client_line_id: 'cl_' + String(Date.now()) + '_' + String(scheduleDrawerCustomLineSeq),
    label: label,
    amount_cents: parsed.amount_cents,
  });
  scheduleDrawerRenderCustomLines();
  scheduleDrawerSetCustomLineEditorOpen(false);
  scheduleDrawerMarkPriceStale();
  scheduleDrawerSyncFooter();
}

function scheduleDrawerRemoveCustomLine(clientLineId) {
  var id = String(clientLineId || '');
  scheduleDrawerCustomLines = scheduleDrawerCustomLines.filter(function(l) {
    return String(l.client_line_id) !== id;
  });
  scheduleDrawerRenderCustomLines();
  scheduleDrawerMarkPriceStale();
  scheduleDrawerSyncFooter();
}

function scheduleWireDrawerCustomLines() {
  var plus = el('ps-drawer-custom-line-add-btn');
  var confirm = el('ps-drawer-custom-line-confirm');
  var cancel = el('ps-drawer-custom-line-cancel');
  var list = el('ps-drawer-custom-lines-list');
  if (plus && !plus._clBound) {
    plus._clBound = true;
    plus.addEventListener('click', function() { scheduleDrawerSetCustomLineEditorOpen(true); });
  }
  if (confirm && !confirm._clBound) {
    confirm._clBound = true;
    confirm.addEventListener('click', function() { scheduleDrawerConfirmCustomLine(); });
  }
  if (cancel && !cancel._clBound) {
    cancel._clBound = true;
    cancel.addEventListener('click', function() { scheduleDrawerSetCustomLineEditorOpen(false); });
  }
  if (list && !list._clBound) {
    list._clBound = true;
    list.addEventListener('click', function(ev) {
      var t = ev && ev.target;
      var btn = t && t.closest ? t.closest('[data-remove-drawer-custom-line]') : null;
      if (!btn) return;
      scheduleDrawerRemoveCustomLine(btn.getAttribute('data-remove-drawer-custom-line'));
    });
  }
}

function scheduleParsePaymentSelectValue(val){
  switch(String(val||'')){
    case 'paid_bank_transfer': return {status:'paid',method:'bank_transfer'};
    case 'paid_in_store': return {status:'paid',method:'in_store'};
    case 'paid_via_link': return {status:'paid',method:'link'};
    case 'paid': return {status:'paid',method:null};
    default: return {status:'unpaid',method:null};
  }
}

function scheduleDrawerHumanSaveError(data,fallback){
  var code=data&&(data.reason_code||data.reason||data.error);
  if(code==='paid_booking_reprice_required') return portalT('schedule.drawer.paidRepriceRequired');
  return (data&&(data.error||data.message||data.reason_code))||fallback||'Save failed';
}

function scheduleDrawerSyncFooter(opts) {
  opts = opts || {};
  var payload = null;
  try { payload = scheduleReadDrawerEditPayload(); } catch (_e) { payload = null; }
  var gate = scheduleDrawerValidateEditPayload(payload || {});
  scheduleDrawerValidationState = gate;
  var box = el('ps-drawer-summary');
  if (box) {
    if (!gate.ok) {
      box.innerHTML = '<span class="portal-schedule-create-summary-text">' +
        escHtml(portalT(gate.errorKey || 'schedule.create.componentsRequired')) + '</span>';
    } else {
      scheduleDrawerRenderIntentSummary(payload);
    }
  }
  // Drop stale € totals before painting a new date/rental intent.
  scheduleDrawerDropStaleQuoteUi(payload);
  var saveBtn = el('ps-drawer-save');
  if (saveBtn) {
    saveBtn.disabled = !gate.ok || scheduleDrawerSaveInFlight;
  }
  if (opts.quote === false) return;
  if (gate.ok) scheduleDrawerRefreshQuote();
  else scheduleDrawerClearQuotePreviewUi();
}

function scheduleSaveDrawerBooking(row) {
  if (!row || !row.booking_id) return;
  if (scheduleDrawerSaveInFlight) return;
  var payload = scheduleReadDrawerEditPayload();
  var saveBtn = el('ps-drawer-save');
  var msg = el('ps-drawer-save-msg');
  var gate = scheduleDrawerValidateEditPayload(payload);
  if (!gate.ok) {
    if (msg) {
      msg.className = 'state-msg error';
      msg.textContent = portalT(gate.errorKey || 'schedule.create.guestRequired');
      msg.style.display = 'block';
    }
    scheduleDrawerSyncFooter();
    return;
  }
  scheduleDrawerSaveInFlight = true;
  if (saveBtn) saveBtn.disabled = true;
  if (msg) msg.style.display = 'none';
  fetch('/staff/schedule/bookings?client=' + encodeURIComponent(getClient()) + sunsetLocationQuerySuffix(), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ booking_id: row.booking_id }, payload)),
  }).then(function(r) {
    return r.json().then(function(data) { return { ok: r.ok, data: data }; });
  }).then(function(res) {
    if (!res.ok || !res.data || res.data.success !== true) {
      var human = scheduleDrawerHumanSaveError(res.data, 'Save failed');
      throw new Error(human);
    }
    scheduleDrawerPriceStale = false;
    var refetch = (typeof scheduleFetchDrawerContext === 'function')
      ? scheduleFetchDrawerContext(row)
      : schedulePortalFetchDrawerDetail(row);
    return refetch.then(function(detail) {
      if (!detail || !detail.success) throw new Error((detail && (detail.error || detail.reason_code)) || 'Refetch failed');
      scheduleDrawerState.ctx = scheduleCloneDrawerCtx(detail);
      scheduleDrawerState.editing = false;
      scheduleMountDrawerBody(scheduleDrawerState.row, scheduleDrawerState.ctx, false);
      if (msg) {
        msg.className = 'state-msg success';
        msg.textContent = portalT('schedule.drawer.saved');
        msg.style.display = 'block';
      }
      loadSchedulePage();
    });
  }).catch(function(err) {
    if (msg) {
      msg.className = 'state-msg error';
      msg.textContent = portalT('schedule.drawer.saveFailed') + ' ' + String(err.message || err);
      msg.style.display = 'block';
      if (/paid_booking_reprice|already paid|payment adjustment/i.test(String(err.message || ''))) {
        msg.dataset.reprice = '1';
      }
    }
  }).finally(function() {
    scheduleDrawerSaveInFlight = false;
    scheduleDrawerSyncFooter();
  });
}

function scheduleWireEditableDrawer(row, ctx) {
  var group = scheduleFindGroupForRow(row) || row;
  scheduleWireDrawerHeaderActions();
  scheduleDrawerSeedCustomLinesFromCtx(ctx || {});
  scheduleDrawerRenderCustomLines();
  scheduleWireDrawerCustomLines();
  scheduleDrawerSetCustomLineEditorOpen(false);
  scheduleFetchLessonTimesConfig(getClient()).then(function() {
    scheduleRenderDrawerRentals();
    scheduleRefreshDrawerFullDayAddon();
    scheduleDrawerRefreshDurationConfirm();
    scheduleDrawerSyncFooter();
  });
  scheduleDrawerPopulateComponentFields();
  ['ps-drawer-comp-course', 'ps-drawer-comp-private-lesson', 'ps-drawer-comp-no-lesson'].forEach(function(id) {
    var node = el(id);
    if (node) node.addEventListener('change', function() { scheduleDrawerOnComponentChange(id); });
  });
  var drawerFulldayToggle = el('ps-drawer-comp-fullday');
  if (drawerFulldayToggle) drawerFulldayToggle.addEventListener('change', function() {
    scheduleDrawerMarkPriceStale();
    scheduleRefreshDrawerFullDayAddon();
    scheduleDrawerSyncFooter();
  });
  ['ps-drawer-date-from', 'ps-drawer-date-to', 'ps-drawer-course-qty', 'ps-drawer-private-lesson-surfers', 'ps-drawer-surfers'].forEach(function(id) {
    var node = el(id);
    if (!node) return;
    var fire = function() {
      scheduleDrawerMarkPriceStale();
      if (id === 'ps-drawer-surfers' || id === 'ps-drawer-course-qty' || id === 'ps-drawer-private-lesson-surfers') {
        // Keep hidden rental mirrors + serialized qty in lockstep with booking Surfers.
        scheduleDrawerSyncRentalQtyFromSurfers();
      }
      if (id === 'ps-drawer-date-from' || id === 'ps-drawer-date-to') {
        if (scheduleDrawerMainActivityValue() === 'private') scheduleDrawerSyncPrivateSessions({ skipCtxSeed: true });
        scheduleDrawerRefreshDurationConfirm();
        scheduleDrawerRefreshWhenSummary();
        scheduleRenderDrawerRentals();
      }
      scheduleRefreshDrawerFullDayAddon();
      scheduleDrawerSyncFooter();
    };
    node.addEventListener('change', fire);
    node.addEventListener('input', fire);
  });
  var guestNode = el('ps-drawer-guest');
  if (guestNode) {
    guestNode.addEventListener('input', scheduleDrawerSyncFooter);
    guestNode.addEventListener('change', scheduleDrawerSyncFooter);
  }
  scheduleWireDrawerStripeCopyOpen(ctx);
  scheduleWireDrawerConversation(row, group);
  scheduleWireDrawerOpenCustomer();
  scheduleWireDrawerManualPayment(row);
  scheduleLoadDrawerWaiver(ctx);
  scheduleWireDrawerDeleteBooking();
  var saveBtn = el('ps-drawer-save');
  if (saveBtn) saveBtn.addEventListener('click', function() { scheduleSaveDrawerBooking(row); });
  var cancelBtn = el('ps-drawer-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', function() { scheduleCancelDrawerEditMode(); });
  var stripeBtn = el('ps-drawer-stripe-link');
  if (stripeBtn) stripeBtn.addEventListener('click', function() { scheduleCreateDrawerStripeLink(row); });
  scheduleDrawerSyncFooter();
}

function scheduleDrawerResetQuoteRuntime(){
  try { scheduleDrawerQuoteState = null; } catch (_s) { /* ignore */ }
  try { scheduleDrawerQuoteGen = (Number(scheduleDrawerQuoteGen) || 0) + 1; } catch (_g) { /* ignore */ }
  try {
    if (typeof scheduleDrawerQuoteTimer !== 'undefined' && scheduleDrawerQuoteTimer != null) {
      clearTimeout(scheduleDrawerQuoteTimer);
      scheduleDrawerQuoteTimer = null;
    }
  } catch (_t) { /* ignore */ }
  try {
    if (typeof scheduleDrawerQuoteAbort !== 'undefined' && scheduleDrawerQuoteAbort) {
      scheduleDrawerQuoteAbort.abort();
      scheduleDrawerQuoteAbort = null;
    }
  } catch (_a) { /* ignore */ }
}
function scheduleEnterDrawerEditMode(){
  if(!scheduleDrawerState.row||!scheduleDrawerState.ctx) return;
  scheduleDrawerState.editing=true; scheduleDrawerPriceStale=false;
  scheduleDrawerResetQuoteRuntime();
  scheduleMountDrawerBody(scheduleDrawerState.row,scheduleDrawerState.ctx,true);
}
function scheduleCancelDrawerEditMode(){
  if(!scheduleDrawerState.row||!scheduleDrawerState.ctx) return;
  scheduleDrawerState.editing=false; scheduleDrawerPriceStale=false;
  scheduleDrawerResetQuoteRuntime();
  scheduleMountDrawerBody(scheduleDrawerState.row,scheduleDrawerState.ctx,false);
}
