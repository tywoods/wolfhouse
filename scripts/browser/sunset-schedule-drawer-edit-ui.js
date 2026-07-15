'use strict';

/**
 * Sunset Schedule drawer — edit controller (Slice 13).
 *
 * Injected after portal + view modules. Owns edit-mode presentation, validation,
 * save orchestration and payment-status select. Consumes canonical drawer ctx;
 * no authoritative price/eligibility/payment validity decisions.
 *
 * Compatibility hooks (monolith): none — delete controller injected before orchestration module.
 * Orchestration (open/close/mount/wire view): sunset-schedule-drawer-controller.js (Slice 16).
 */

var scheduleDrawerSaveInFlight = false;

function scheduleRenderDrawerPaymentSectionEditHtml(ctx){
  var pay = (ctx && ctx.payment) || {};
  var items = pay.line_items || [];
  var html = '<div class="ctx-pay-box" id="ps-drawer-payment-box" style="margin-top:14px">';
  html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3);margin-bottom:8px">' +
    escHtml(portalT('schedule.drawer.paymentSection')) + '</div>';
  html += scheduleRenderDrawerPaymentSelectHtml(ctx);
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

function scheduleDrawerPaymentSelectValue(ctx){
  if (!ctx || ctx.payment_status !== 'paid') return 'unpaid';
  if (ctx.payment_method === 'bank_transfer') return 'paid_bank_transfer';
  if (ctx.payment_method === 'in_store') return 'paid_in_store';
  if (ctx.payment_method === 'link') return 'paid_via_link';
  return 'paid_bank_transfer';
}

function scheduleRenderDrawerPaymentSelectHtml(ctx){
  var cur = scheduleDrawerPaymentSelectValue(ctx);
  function opt(val, key){
    return '<option value="' + val + '"' + (cur === val ? ' selected' : '') + '>' + escHtml(portalT(key)) + '</option>';
  }
  return '<div class="portal-schedule-create-field" style="margin-bottom:10px"><label for="ps-drawer-payment">' + escHtml(portalT('schedule.create.payment')) + '</label>' +
    '<select id="ps-drawer-payment">' +
    opt('unpaid', 'schedule.payment.unpaid') +
    opt('paid_bank_transfer', 'schedule.payment.paidBankTransfer') +
    opt('paid_in_store', 'schedule.payment.paidInStore') +
    opt('paid_via_link', 'schedule.payment.paidViaLink') +
    '</select></div>';
}

function scheduleRenderEditableDrawerHtml(row, ctx){
  var comps = (ctx && ctx.components) || {};
  var courseOn = !!(comps.course || comps.lesson);
  var privateOn = !!comps.private_lesson;
  var boardOn = !!comps.surfboard;
  var wetsuitOn = !!comps.wetsuit;
  var selectedCourseId = (comps.course && comps.course.course_id) || '';
  var selectedTierKey = (comps.course && comps.course.tier_key) || '';
  var courseQty = (comps.course && comps.course.quantity) || (comps.lesson && comps.lesson.quantity) || 1;
  var html = '<form id="ps-drawer-edit-form" class="portal-schedule-drawer-form" autocomplete="off">';
  html += scheduleRenderDrawerHeroHtml(ctx, row);
  // One consolidated "Edit booking" card: guest + dates + components + course/surfers + rentals.
  html += '<section class="portal-schedule-drawer-section">';
  html += '<h4 class="portal-schedule-drawer-section-title">' + escHtml(portalT('schedule.drawer.editTitle')) + '</h4>';
  html += '<div class="portal-schedule-create-field"><label for="ps-drawer-guest">' + escHtml(portalT('schedule.create.guestName')) + '</label>' +
    '<input id="ps-drawer-guest" type="text" value="' + escHtml(ctx.guest_name || '') + '"></div>' +
    '<div class="portal-schedule-create-field"><label for="ps-drawer-phone">' + escHtml(portalT('schedule.drawer.phone')) + '</label>' +
    '<input id="ps-drawer-phone" type="tel" value="' + escHtml(ctx.phone || '') + '"></div>';
  html += '<div id="ps-drawer-date-range"' + (privateOn ? ' style="display:none"' : '') + '>' +
    '<div class="portal-schedule-create-field"><label for="ps-drawer-date-from">' + escHtml(portalT('schedule.create.dateFrom')) + '</label>' +
    '<input id="ps-drawer-date-from" type="date" value="' + escHtml(ctx.date_from || '') + '"></div>' +
    '<div class="portal-schedule-create-field"><label for="ps-drawer-date-to">' + escHtml(portalT('schedule.create.dateTo')) + '</label>' +
    '<input id="ps-drawer-date-to" type="date" value="' + escHtml(ctx.date_to || ctx.date_from || '') + '"></div>' +
    '</div>' +
    '<div id="ps-drawer-private-sessions-wrap"' + (privateOn ? '' : ' style="display:none"') + '>' +
    '<span class="portal-schedule-create-label" data-i18n="schedule.create.privateLesson.sessionsHelp">' + escHtml(portalT('schedule.create.privateLesson.sessionsHelp')) + '</span>' +
    '<div id="ps-drawer-private-sessions" class="portal-schedule-private-sessions"></div>' +
    '<button type="button" class="btn btn-ghost portal-schedule-add-session-btn" id="ps-drawer-add-session">' + escHtml(portalT('schedule.create.privateLesson.addSession')) + '</button>' +
    '</div>';
  html += '<div class="portal-schedule-create-components">' +
    '<label class="portal-schedule-create-check"><input type="checkbox" id="ps-drawer-comp-wetsuit"' + (wetsuitOn ? ' checked' : '') + '> ' + escHtml(portalT('schedule.type.wetsuitRental')) + '</label>' +
    '<label class="portal-schedule-create-check"><input type="checkbox" id="ps-drawer-comp-surfboard"' + (boardOn ? ' checked' : '') + '> ' + escHtml(portalT('schedule.type.boardRental')) + '</label>' +
    '<label class="portal-schedule-create-check"><input type="checkbox" id="ps-drawer-comp-course"' + (courseOn ? ' checked' : '') + '> ' + escHtml(portalT('schedule.type.course')) + '</label>' +
    '<label class="portal-schedule-create-check"><input type="checkbox" id="ps-drawer-comp-private-lesson"' + (privateOn ? ' checked' : '') + '> ' + escHtml(portalT('schedule.type.privateCourse')) + '</label>' +
    '</div>';
  html += '<div id="ps-drawer-course-section"' + ((courseOn || privateOn) ? '' : ' style="display:none"') + '>' +
    '<div class="portal-schedule-create-field" id="ps-drawer-course-fields"><label for="ps-drawer-course-select">' + escHtml(portalT('schedule.create.courseSelect')) + '</label><select id="ps-drawer-course-select" data-selected="' + escHtml(selectedCourseId) + '"></select></div>' +
    '<div class="portal-schedule-create-field" id="ps-drawer-course-tier-wrap"><label for="ps-drawer-course-tier">' + escHtml(portalT('schedule.create.courseTier') || 'Course duration') + '</label><select id="ps-drawer-course-tier" data-selected="' + escHtml(selectedTierKey) + '"></select></div>' +
    '<div class="portal-schedule-create-field" id="ps-drawer-course-qty-wrap"><label for="ps-drawer-course-qty">' + escHtml(portalT('schedule.create.surferCount')) + '</label>' +
    '<input id="ps-drawer-course-qty" type="number" min="1" max="99" value="' + escHtml(String(courseQty)) + '"></div>' +
    '<div id="ps-drawer-private-lesson-fields" style="display:none">' +
    '<div class="portal-schedule-create-field"><label for="ps-drawer-private-lesson-surfers">' + escHtml(portalT('schedule.create.surferCount')) + '</label>' +
    '<input id="ps-drawer-private-lesson-surfers" type="number" min="1" max="99" value="' + escHtml(String((comps.private_lesson && comps.private_lesson.surfer_count) || 1)) + '"></div>' +
    '</div></div>';
  html += '<div id="ps-drawer-rentals-section"' + ((boardOn || wetsuitOn) ? '' : ' style="display:none"') + '>' +
    '<div class="portal-schedule-create-field" id="ps-drawer-board-qty-wrap"><label for="ps-drawer-board-qty">' + escHtml(portalT('schedule.create.boardQty')) + '</label>' +
    '<input id="ps-drawer-board-qty" type="number" min="1" max="99" value="' + escHtml(String((comps.surfboard && comps.surfboard.quantity) || 1)) + '"></div>' +
    '<div class="portal-schedule-create-field" id="ps-drawer-wetsuit-qty-wrap"><label for="ps-drawer-wetsuit-qty">' + escHtml(portalT('schedule.create.wetsuitQty')) + '</label>' +
    '<input id="ps-drawer-wetsuit-qty" type="number" min="1" max="99" value="' + escHtml(String((comps.wetsuit && comps.wetsuit.quantity) || 1)) + '"></div></div>';
  // Full-day equipment add-on (per person, per date). Seeded from ctx.components; rendered by JS after config load.
  var addonSeed = (comps.full_day_equipment_extension && comps.full_day_equipment_extension.dates) || {};
  var addonOn = Object.keys(addonSeed).length > 0;
  html += '<div class="portal-schedule-create-field portal-schedule-addon-field" id="ps-drawer-addon-fullday-field" style="display:none" data-addon-seed="' + escHtml(JSON.stringify(addonSeed)) + '">' +
    '<label class="portal-schedule-create-check portal-schedule-addon-toggle" style="min-height:44px;display:flex;align-items:center"><input type="checkbox" id="ps-drawer-comp-fullday"' + (addonOn ? ' checked' : '') + '> ' + escHtml(portalT('schedule.type.fullDayEquipment')) + '</label>' +
    '<div id="ps-drawer-fullday-rows" class="portal-schedule-addon-rows" style="display:none"></div>' +
    '<div id="ps-drawer-fullday-summary" class="portal-schedule-addon-summary" style="display:none" aria-live="polite"></div>' +
    '</div>';
  html += '</section>';
  // Payment: edit mode only sets the status (line items / manual payment / Stripe link live in the view).
  html += '<section class="portal-schedule-drawer-section"><div class="ps-card-eyebrow">' +
    escHtml(portalT('schedule.drawer.paymentsTitle')) + '</div>' + scheduleRenderDrawerPaymentSelectHtml(ctx) + '</section>';
  html += scheduleDrawerSectionHtml('schedule.drawer.section.notes',
    '<div class="portal-schedule-create-field"><label for="ps-drawer-notes">' + escHtml(portalT('schedule.drawer.notes')) + '</label>' +
    '<textarea id="ps-drawer-notes" rows="2">' + escHtml(ctx.notes || '') + '</textarea></div>');
  html += '<p id="ps-drawer-save-msg" class="state-msg" style="display:none;margin-top:8px"></p>';
  html += '<div class="portal-schedule-drawer-actions">';
  html += '<button type="button" class="btn btn-primary" id="ps-drawer-save">' + escHtml(portalT('schedule.drawer.save')) + '</button>';
  html += '<button type="button" class="btn btn-ghost" id="ps-drawer-cancel">' + escHtml(portalT('schedule.drawer.cancel')) + '</button>';
  html += '</div>';
  html += '</form>';
  return html;
}

function scheduleDrawerPopulateComponentFields(){
  var courseOn = !!(el('ps-drawer-comp-course') && el('ps-drawer-comp-course').checked);
  var privateOn = !!(el('ps-drawer-comp-private-lesson') && el('ps-drawer-comp-private-lesson').checked);
  var boardOn = !!(el('ps-drawer-comp-surfboard') && el('ps-drawer-comp-surfboard').checked);
  var wetsuitOn = !!(el('ps-drawer-comp-wetsuit') && el('ps-drawer-comp-wetsuit').checked);
  var cf = el('ps-drawer-course-fields');
  var ct = el('ps-drawer-course-tier-wrap');
  var cq = el('ps-drawer-course-qty-wrap');
  var pf = el('ps-drawer-private-lesson-fields');
  var bq = el('ps-drawer-board-qty-wrap');
  var wq = el('ps-drawer-wetsuit-qty-wrap');
  if (cf) cf.style.display = courseOn ? '' : 'none';
  if (ct) ct.style.display = courseOn ? '' : 'none';
  if (cq) cq.style.display = courseOn ? '' : 'none';
  if (pf) pf.style.display = privateOn ? '' : 'none';
  if (bq) bq.style.display = boardOn ? '' : 'none';
  if (wq) wq.style.display = wetsuitOn ? '' : 'none';
  // Compact: hide whole Course/Rentals cards unless a relevant component is checked.
  var courseSection = el('ps-drawer-course-section');
  if (courseSection) courseSection.style.display = (courseOn || privateOn) ? '' : 'none';
  var rentalsSection = el('ps-drawer-rentals-section');
  if (rentalsSection) rentalsSection.style.display = (boardOn || wetsuitOn) ? '' : 'none';
  // Private Course uses per-session dates: hide the group date range and show sessions.
  var dateRange = el('ps-drawer-date-range');
  if (dateRange) dateRange.style.display = privateOn ? 'none' : '';
  var sessionsWrap = el('ps-drawer-private-sessions-wrap');
  if (sessionsWrap) sessionsWrap.style.display = privateOn ? '' : 'none';
  if (privateOn) scheduleDrawerSyncPrivateSessions();
  if (courseOn) scheduleDrawerPopulateCourseSelect();
  scheduleRefreshDrawerFullDayAddon();
}

function scheduleRefreshDrawerFullDayAddon(){
  var field = el('ps-drawer-addon-fullday-field');
  if (!field) return;
  var courseOn = !!(el('ps-drawer-comp-course') && el('ps-drawer-comp-course').checked);
  var privateOn = !!(el('ps-drawer-comp-private-lesson') && el('ps-drawer-comp-private-lesson').checked);
  var boardOn = !!(el('ps-drawer-comp-surfboard') && el('ps-drawer-comp-surfboard').checked);
  var wetsuitOn = !!(el('ps-drawer-comp-wetsuit') && el('ps-drawer-comp-wetsuit').checked);
  var hasEligibleBase = courseOn || privateOn || boardOn || wetsuitOn;
  var eligibleDates = [];
  var defaultQty = 1;
  if (privateOn){
    var sessions = scheduleDrawerReadPrivateSessionsFromDom();
    var seen = {};
    for (var i=0;i<sessions.length;i++){ var d = sessions[i].date; if (d && !seen[d]){ seen[d]=1; eligibleDates.push(d); } }
    eligibleDates.sort();
    defaultQty = parseInt((el('ps-drawer-private-lesson-surfers') && el('ps-drawer-private-lesson-surfers').value) || '1', 10) || 1;
  } else {
    var from = el('ps-drawer-date-from') ? el('ps-drawer-date-from').value : '';
    var to = el('ps-drawer-date-to') ? el('ps-drawer-date-to').value : from;
    eligibleDates = scheduleEnumerateDates(from, to || from);
    var qtys = [];
    if (courseOn) qtys.push(parseInt((el('ps-drawer-course-qty') && el('ps-drawer-course-qty').value)||'1',10)||1);
    if (boardOn) qtys.push(parseInt((el('ps-drawer-board-qty') && el('ps-drawer-board-qty').value)||'1',10)||1);
    if (wetsuitOn) qtys.push(parseInt((el('ps-drawer-wetsuit-qty') && el('ps-drawer-wetsuit-qty').value)||'1',10)||1);
    defaultQty = qtys.length ? Math.max.apply(null, qtys) : 1;
  }
  var show = scheduleFullDayAddonEnabled && hasEligibleBase && eligibleDates.length > 0;
  var checkbox = el('ps-drawer-comp-fullday');
  var rows = el('ps-drawer-fullday-rows');
  var summary = el('ps-drawer-fullday-summary');
  // Seed prior selections: current DOM rows, else the ctx seed embedded on the field.
  var seed = null;
  var domSeed = scheduleReadFullDayAddonRows('ps-drawer-fullday-rows');
  if (Object.keys(domSeed).length) seed = domSeed;
  else {
    try { seed = JSON.parse(field.getAttribute('data-addon-seed') || '{}'); } catch(_) { seed = {}; }
  }
  // Historical add-on rows may include dates no longer eligible; disabled add-on still shows existing rows.
  var seedDates = seed ? Object.keys(seed) : [];
  if (!scheduleFullDayAddonEnabled && seedDates.length) show = true;
  var mergedDates = eligibleDates.slice();
  for (var s=0;s<seedDates.length;s++){ if (mergedDates.indexOf(seedDates[s]) < 0) mergedDates.push(seedDates[s]); }
  mergedDates.sort();
  field.style.display = show ? '' : 'none';
  if (!show){
    if (checkbox) checkbox.checked = false;
    if (rows) rows.style.display = 'none';
    if (summary) summary.style.display = 'none';
    return;
  }
  var on = !!(checkbox && checkbox.checked);
  if (rows) rows.style.display = on ? '' : 'none';
  if (on){
    scheduleRenderFullDayAddonRows('ps-drawer-fullday-rows', 'ps-drawer-fullday-summary', mergedDates, defaultQty, seed, scheduleUpdateDrawerTotalPreview);
  } else if (summary){
    summary.style.display = 'none';
  }
}

function scheduleUpdateDrawerTotalPreview(){
  scheduleUpdateFullDayAddonSummary('ps-drawer-fullday-rows', 'ps-drawer-fullday-summary');
}

function scheduleDrawerOnComponentChange(changedId){
  var course = el('ps-drawer-comp-course');
  var privateLesson = el('ps-drawer-comp-private-lesson');
  if (changedId === 'ps-drawer-comp-course' && course && course.checked && privateLesson) privateLesson.checked = false;
  if (changedId === 'ps-drawer-comp-private-lesson' && privateLesson && privateLesson.checked && course) course.checked = false;
  scheduleDrawerPopulateComponentFields();
}

function scheduleDrawerPopulateCourseSelect(){
  var sel = el('ps-drawer-course-select');
  if (!sel) return Promise.resolve();
  var selected = sel.getAttribute('data-selected') || sel.value || '';
  return scheduleFetchLessonTimesConfig(getClient()).then(function(){
    var courses = scheduleCoursesCache || [];
    var html = '';
    courses.forEach(function(c){
      var id = String(c.course_id || '').trim();
      if (!id) return;
      html += '<option value="' + escHtml(id) + '" data-label="' + escHtml(c.label || id) + '">' + escHtml(c.label || id) + '</option>';
    });
    if (!html) html = '<option value="">' + escHtml(portalT('schedule.courses.noneConfigured')) + '</option>';
    sel.innerHTML = html;
    if (selected) sel.value = selected;
    if (!sel._tierBound){
      sel._tierBound = true;
      sel.addEventListener('change', function(){ scheduleDrawerPopulateCourseTierFields(); });
    }
    scheduleDrawerPopulateCourseTierFields();
    return sel;
  });
}

function scheduleDrawerPopulateCourseTierFields(){
  var tierSel = el('ps-drawer-course-tier');
  if (!tierSel) return;
  var courseSel = el('ps-drawer-course-select');
  var courseId = courseSel ? String(courseSel.value || '').trim() : '';
  var course = null;
  (scheduleCoursesCache || []).forEach(function(c){
    if (String(c.course_id || '').trim() === courseId) course = c;
  });
  var tiers = (course && Array.isArray(course.price_tiers)) ? course.price_tiers : [];
  var pref = tierSel.getAttribute('data-selected') || String(tierSel.value || '').trim();
  var html = '';
  tiers.forEach(function(t){
    var key = String(t.key || '').trim();
    if (!key) return;
    html += '<option value="' + escHtml(key) + '">' + escHtml(t.label || key) + '</option>';
  });
  if (!html) html = '<option value="">' + escHtml(portalT('schedule.create.courseTierNone') || 'No duration configured') + '</option>';
  tierSel.innerHTML = html;
  if (pref) tierSel.value = pref;
  if (!tierSel.value && tiers.length) tierSel.value = String(tiers[0].key || '');
  tierSel.removeAttribute('data-selected');
}

function scheduleDrawerReadPrivateSessionsFromDom(){
  var wrap = el('ps-drawer-private-sessions');
  var out = [];
  if (!wrap) return out;
  wrap.querySelectorAll('.portal-schedule-private-session-row').forEach(function(row){
    var d = row.querySelector('.ps-pl-session-date');
    var s = row.querySelector('.ps-pl-session-start');
    var e = row.querySelector('.ps-pl-session-end');
    out.push({ date: d ? d.value : '', start: s ? s.value : '', end: e ? e.value : '' });
  });
  return out;
}

function scheduleDrawerRenderPrivateSessions(sessions){
  var wrap = el('ps-drawer-private-sessions');
  if (!wrap) return;
  var html = '';
  (sessions || []).forEach(function(sess, i){
    var removeBtn = i > 0
      ? '<button type="button" class="btn btn-ghost portal-schedule-session-remove" data-session-remove="' + String(i) + '">' + escHtml(portalT('schedule.create.privateLesson.removeSession')) + '</button>'
      : '';
    html += '<div class="portal-schedule-private-session-row" data-session-index="' + String(i + 1) + '">' +
      '<p class="portal-schedule-card-sub" style="margin:8px 0 4px">' + escHtml(portalT('schedule.create.privateLesson.sessionLabel')) + ' ' + String(i + 1) + '</p>' +
      '<div class="portal-schedule-private-session-grid">' +
      '<label><span>' + escHtml(portalT('schedule.create.privateLesson.date')) + '</span><input class="ps-pl-session-date" type="date" value="' + escHtml(sess.date || '') + '"></label>' +
      '<label><span>' + escHtml(portalT('schedule.create.privateLesson.start')) + '</span><input class="ps-pl-session-start" type="time" value="' + escHtml(sess.start || '10:00') + '"></label>' +
      '<label><span>' + escHtml(portalT('schedule.create.privateLesson.end')) + '</span><input class="ps-pl-session-end" type="time" value="' + escHtml(sess.end || '12:00') + '"></label>' +
      '</div>' + removeBtn + '</div>';
  });
  wrap.innerHTML = html;
  wrap.querySelectorAll('.portal-schedule-session-remove').forEach(function(btn){
    btn.addEventListener('click', function(){
      var idx = parseInt(btn.getAttribute('data-session-remove'), 10);
      var cur = scheduleDrawerReadPrivateSessionsFromDom();
      if (cur.length <= 1) return;
      cur.splice(idx, 1);
      scheduleDrawerRenderPrivateSessions(cur);
    });
  });
}

function scheduleDrawerSyncPrivateSessions(){
  var wrap = el('ps-drawer-private-sessions');
  if (!wrap) return;
  // Preserve current rows if already rendered; otherwise seed from ctx (or one default row).
  var existing = scheduleDrawerReadPrivateSessionsFromDom();
  if (!existing.length){
    var ctx = scheduleDrawerState.ctx || {};
    var pl = (ctx.components && ctx.components.private_lesson) || null;
    existing = (pl && Array.isArray(pl.sessions) && pl.sessions.length)
      ? pl.sessions.map(function(s){ return { date: s.date, start: s.start || '10:00', end: s.end || '12:00' }; })
      : [{ date: (ctx.date_from || scheduleTodayIso()), start: '10:00', end: '12:00' }];
  }
  scheduleDrawerRenderPrivateSessions(existing);
}

function scheduleDrawerAddPrivateSession(){
  var cur = scheduleDrawerReadPrivateSessionsFromDom();
  if (!cur.length){ scheduleDrawerSyncPrivateSessions(); cur = scheduleDrawerReadPrivateSessionsFromDom(); }
  var last = cur[cur.length - 1] || {};
  var nextDate = last.date ? scheduleIsoDate(scheduleAddDays(scheduleParseIso(last.date), 1)) : scheduleTodayIso();
  if (cur.length >= 30) return;
  cur.push({ date: nextDate, start: last.start || '10:00', end: last.end || '12:00' });
  scheduleDrawerRenderPrivateSessions(cur);
}

function scheduleReadDrawerEditPayload(){
  var guest = (el('ps-drawer-guest') && el('ps-drawer-guest').value || '').trim();
  var phone = (el('ps-drawer-phone') && el('ps-drawer-phone').value || '').trim();
  var dateFrom = el('ps-drawer-date-from') ? el('ps-drawer-date-from').value : '';
  var dateTo = el('ps-drawer-date-to') ? el('ps-drawer-date-to').value : dateFrom;
  var paymentSel = el('ps-drawer-payment') ? el('ps-drawer-payment').value : 'unpaid';
  var pm = scheduleParsePaymentSelectValue(paymentSel);
  var notes = (el('ps-drawer-notes') && el('ps-drawer-notes').value || '').trim();
  var components = {};
  var ctx = scheduleDrawerState.ctx || {};
  var existingPrivate = (ctx.components && ctx.components.private_lesson) || null;
  if (el('ps-drawer-comp-course') && el('ps-drawer-comp-course').checked){
    var courseSel = el('ps-drawer-course-select');
    var courseOpt = courseSel && courseSel.selectedIndex >= 0 ? courseSel.options[courseSel.selectedIndex] : null;
    var tierSel = el('ps-drawer-course-tier');
    var tierKey = tierSel && tierSel.value ? String(tierSel.value).trim() : '';
    var courseId = courseSel ? String(courseSel.value || '').trim() : '';
    components.course = {
      quantity: parseInt((el('ps-drawer-course-qty') && el('ps-drawer-course-qty').value) || '1', 10) || 1,
      course_id: courseId,
      course_label: courseOpt ? (courseOpt.getAttribute('data-label') || courseOpt.textContent || '') : '',
    };
    if (tierKey) {
      components.course.tier_key = tierKey;
      components.course.offering_id = 'surf_pack_' + courseId + '__' + tierKey;
    }
  }
  if (el('ps-drawer-comp-private-lesson') && el('ps-drawer-comp-private-lesson').checked){
    var plSurfers = parseInt((el('ps-drawer-private-lesson-surfers') && el('ps-drawer-private-lesson-surfers').value) || '1', 10) || 1;
    var domSessions = scheduleDrawerReadPrivateSessionsFromDom().filter(function(s){ return s.date; });
    var plSessions = domSessions.length
      ? domSessions
      : (existingPrivate && Array.isArray(existingPrivate.sessions) && existingPrivate.sessions.length
        ? existingPrivate.sessions.slice()
        : [{ date: dateFrom || scheduleTodayIso(), start: '10:00', end: '12:00' }]);
    components.private_lesson = {
      enabled: true,
      quantity: plSessions.length,
      surfer_count: plSurfers,
      sessions: plSessions,
    };
  }
  if (el('ps-drawer-comp-surfboard') && el('ps-drawer-comp-surfboard').checked){
    components.surfboard = { quantity: parseInt((el('ps-drawer-board-qty') && el('ps-drawer-board-qty').value) || '1', 10) || 1 };
  }
  if (el('ps-drawer-comp-wetsuit') && el('ps-drawer-comp-wetsuit').checked){
    components.wetsuit = { quantity: parseInt((el('ps-drawer-wetsuit-qty') && el('ps-drawer-wetsuit-qty').value) || '1', 10) || 1 };
  }
  // Full-day equipment add-on: per-date people map. When unchecked, omit so the row is dropped on save.
  if (el('ps-drawer-comp-fullday') && el('ps-drawer-comp-fullday').checked){
    var addonDates = scheduleReadFullDayAddonRows('ps-drawer-fullday-rows');
    if (Object.keys(addonDates).length){
      components.full_day_equipment_extension = { enabled: true, dates: addonDates };
    }
  }
  return { guest_name: guest, guest_phone: phone || null, date_from: dateFrom, date_to: dateTo, payment_status: pm.status, payment_method: pm.method, notes: notes, components: components };
}

function scheduleParsePaymentSelectValue(val){
  switch (String(val || '')){
    case 'paid_bank_transfer': return { status: 'paid', method: 'bank_transfer' };
    case 'paid_in_store': return { status: 'paid', method: 'in_store' };
    case 'paid_via_link': return { status: 'paid', method: 'link' };
    case 'paid': return { status: 'paid', method: null };
    default: return { status: 'unpaid', method: null };
  }
}

function scheduleSaveDrawerBooking(row){
  if (!row || !row.booking_id) return;
  if (scheduleDrawerSaveInFlight) return;
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
  scheduleDrawerSaveInFlight = true;
  if (saveBtn) saveBtn.disabled = true;
  if (msg) msg.style.display = 'none';
  fetch('/staff/schedule/bookings?client=' + encodeURIComponent(getClient()) + sunsetLocationQuerySuffix(), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ booking_id: row.booking_id }, payload)),
  }).then(function(r){ return r.json().then(function(data){ return { ok: r.ok, data: data }; }); })
    .then(function(res){
      if (!res.ok || !res.data || res.data.success !== true) throw new Error((res.data && (res.data.error || res.data.message || res.data.reason_code)) || 'Save failed');
      var refetch = (typeof scheduleFetchDrawerContext === 'function')
        ? scheduleFetchDrawerContext(row)
        : schedulePortalFetchDrawerDetail(row);
      return refetch.then(function(detail){
        if (!detail || !detail.success) throw new Error((detail && (detail.error || detail.reason_code)) || 'Refetch failed');
        scheduleDrawerState.ctx = scheduleCloneDrawerCtx(detail);
        scheduleDrawerState.editing = false;
        scheduleMountDrawerBody(scheduleDrawerState.row, scheduleDrawerState.ctx, false);
        if (msg){ msg.className = 'state-msg success'; msg.textContent = portalT('schedule.drawer.saved'); msg.style.display = 'block'; }
        loadSchedulePage();
      });
    })
    .catch(function(err){
      if (msg){ msg.className = 'state-msg error'; msg.textContent = portalT('schedule.drawer.saveFailed') + ' ' + String(err.message || err); msg.style.display = 'block'; }
    })
    .finally(function(){
      scheduleDrawerSaveInFlight = false;
      if (saveBtn) saveBtn.disabled = false;
    });
}

function scheduleWireEditableDrawer(row, ctx){
  var group = scheduleFindGroupForRow(row) || row;
  scheduleWireDrawerHeaderActions();
  // Ensure the add-on price/enabled state is loaded before component fields render its control.
  scheduleFetchLessonTimesConfig(getClient()).then(function(){ scheduleRefreshDrawerFullDayAddon(); });
  scheduleDrawerPopulateComponentFields();
  ['ps-drawer-comp-course','ps-drawer-comp-private-lesson','ps-drawer-comp-surfboard','ps-drawer-comp-wetsuit'].forEach(function(id){
    var node = el(id);
    if (node) node.addEventListener('change', function(){ scheduleDrawerOnComponentChange(id); });
  });
  // Full-day add-on: toggle + inputs affecting eligible dates / default people.
  var drawerFulldayToggle = el('ps-drawer-comp-fullday');
  if (drawerFulldayToggle) drawerFulldayToggle.addEventListener('change', scheduleRefreshDrawerFullDayAddon);
  ['ps-drawer-comp-course','ps-drawer-comp-surfboard','ps-drawer-comp-wetsuit','ps-drawer-comp-private-lesson','ps-drawer-date-from','ps-drawer-date-to','ps-drawer-course-qty','ps-drawer-board-qty','ps-drawer-wetsuit-qty','ps-drawer-private-lesson-surfers'].forEach(function(id){
    var node = el(id);
    if (node){ node.addEventListener('change', scheduleRefreshDrawerFullDayAddon); node.addEventListener('input', scheduleRefreshDrawerFullDayAddon); }
  });
  var addSessionBtn = el('ps-drawer-add-session');
  if (addSessionBtn) addSessionBtn.addEventListener('click', scheduleDrawerAddPrivateSession);
  scheduleWireDrawerStripeCopyOpen(ctx);
  scheduleWireDrawerConversation(row, group);
  scheduleWireDrawerOpenCustomer();
  scheduleWireDrawerManualPayment(row);
  scheduleLoadDrawerWaiver(ctx);
  scheduleWireDrawerDeleteBooking();
  var saveBtn = el('ps-drawer-save');
  if (saveBtn) saveBtn.addEventListener('click', function(){ scheduleSaveDrawerBooking(row); });
  var cancelBtn = el('ps-drawer-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', function(){ scheduleCancelDrawerEditMode(); });
  var stripeBtn = el('ps-drawer-stripe-link');
  if (stripeBtn) stripeBtn.addEventListener('click', function(){ scheduleCreateDrawerStripeLink(row); });
}

function scheduleEnterDrawerEditMode(){
  if (!scheduleDrawerState.row || !scheduleDrawerState.ctx) return;
  scheduleDrawerState.editing = true;
  scheduleMountDrawerBody(scheduleDrawerState.row, scheduleDrawerState.ctx, true);
}

function scheduleCancelDrawerEditMode(){
  if (!scheduleDrawerState.row || !scheduleDrawerState.ctx) return;
  scheduleDrawerState.editing = false;
  scheduleMountDrawerBody(scheduleDrawerState.row, scheduleDrawerState.ctx, false);
}
