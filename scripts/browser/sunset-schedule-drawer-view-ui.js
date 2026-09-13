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

function scheduleDrawerBookingIsCancelled(ctx, row){
  // Prefer explicit booking lifecycle fields — never treat payment_status as cancelled.
  var st = String(
    (ctx && (ctx.booking_status || ctx.bookingStatus))
    || (row && (row.booking_status || row.bookingStatus))
    || ''
  ).toLowerCase();
  if (st === 'cancelled' || st === 'canceled') return true;
  if (ctx && (ctx.schedule_ghost === true || ctx.schedule_ghost === 'true')) return true;
  if (row && (row.schedule_ghost === true || row.schedule_ghost === 'true' || row._isCancelled === true)) return true;
  return false;
}

function scheduleDrawerHasCapturedMoney(ctx){
  if (typeof scheduleDrawerPaymentFullyPaid === 'function' && scheduleDrawerPaymentFullyPaid(ctx)) return true;
  if (!ctx) return false;
  var pay = ctx.payment || {};
  var paid = Number(pay.paid_cents != null ? pay.paid_cents : (ctx.amount_paid_cents != null ? ctx.amount_paid_cents : 0));
  if (paid > 0) return true;
  if (Number(ctx.payments_paid_cents || 0) > 0) return true;
  return false;
}

function scheduleRenderDeleteBookingRowHtml(ctx, row){
  var r = row || (typeof scheduleDrawerState !== 'undefined' && scheduleDrawerState && scheduleDrawerState.row);
  if (!(ctx && ctx.booking_id)) return '';
  var cancelled = scheduleDrawerBookingIsCancelled(ctx, r);
  var canCancel = typeof scheduleDrawerCanCancelBooking === 'function'
    ? scheduleDrawerCanCancelBooking(r, ctx)
    : !cancelled;
  var canRestore = typeof scheduleDrawerCanRestoreBooking === 'function'
    ? scheduleDrawerCanRestoreBooking(r, ctx)
    : cancelled;
  var canArchive = typeof scheduleDrawerCanDeleteBooking === 'function'
    ? scheduleDrawerCanDeleteBooking(r, ctx)
    : cancelled;
  // Active → Cancel only. Cancelled → Restore + Hide (unhide also on Bookings tab). Never hard-delete.
  if (!cancelled && !canCancel) return '';
  if (cancelled && !canArchive && !canRestore) return '';
  var html = '<div class="portal-schedule-drawer-danger-row">';
  if (cancelled) {
    if (canRestore) {
      html += '<button type="button" class="btn portal-schedule-restore-booking-btn" id="ps-drawer-restore-booking" data-action="restore-booking">' +
        escHtml(portalT('schedule.drawer.restoreBooking') || 'Restore booking') + '</button>';
    }
    if (canArchive) {
      html += '<button type="button" class="btn portal-schedule-delete-booking-btn" id="ps-drawer-delete-booking" data-action="hide-booking">' +
        escHtml(portalT('schedule.drawer.hideBooking') || portalT('schedule.drawer.deleteBooking') || 'Hide booking') + '</button>';
    }
  } else {
    html += '<button type="button" class="btn portal-schedule-cancel-booking-btn" id="ps-drawer-cancel-booking">' +
      escHtml(portalT('schedule.drawer.cancelBooking')) + '</button>';
  }
  html += '</div>';
  return html;
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

function scheduleRenderDrawerOpenCustomerBtnHtml(ctx, row){
  var profile = getPortalProfile(getClient());
  if (!portalHasCustomersCrm(profile)) return '';
  var phone = (typeof scheduleResolveGuestPhone === 'function')
    ? scheduleResolveGuestPhone(ctx, row)
    : (ctx && ctx.phone);
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
  var phone = (typeof scheduleResolveGuestPhone === 'function')
    ? scheduleResolveGuestPhone(ctx, row)
    : ((ctx && ctx.phone) || '');
  if (!isSunsetSurfActive()) {
    return '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.create.guestName')) + ':</strong> ' + escHtml(ctx.guest_name || '—') + '</p>' +
      '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.drawer.phone')) + ':</strong> ' + escHtml(phone || '—') + '</p>' +
      '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.drawer.source')) + ':</strong> ' + escHtml(scheduleRowSourceDrawerLabel(row)) + '</p>' +
      '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.create.dateFrom')) + ':</strong> ' + escHtml(ctx.date_from || '—') + '</p>' +
      '<p class="portal-schedule-drawer-kv" style="margin:0"><strong>' + escHtml(portalT('schedule.create.dateTo')) + ':</strong> ' + escHtml(ctx.date_to || ctx.date_from || '—') + '</p>';
  }
  return '<p class="portal-schedule-drawer-kv portal-schedule-drawer-summary-kv"><strong>' + escHtml(portalT('schedule.drawer.phone')) + ':</strong> ' + escHtml(phone || '—') + '</p>' +
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
  // Display rank: accommodation → course/service → rental/equipment → other.
  if (s.indexOf('accommodation') >= 0) return 0;
  if (s.indexOf('lesson') >= 0 || s.indexOf('course') >= 0 || s.indexOf('private') >= 0) return 1;
  if (s.indexOf('board') >= 0 || s.indexOf('suit') >= 0 || s.indexOf('rental') >= 0
    || s.indexOf('equipment') >= 0 || s === 'addon_service') return 2;
  return 3;
}

function scheduleDrawerSortItems(items){
  return (items || []).slice().sort(function(a, b){
    return scheduleDrawerServiceOrder(a.service_type) - scheduleDrawerServiceOrder(b.service_type);
  });
}

/** Invoice display order only — never changes money. */
function scheduleDrawerCommercialLineRank(line){
  if (!line) return 9;
  if (line.staff_accommodation || String(line.component || '') === 'staff_accommodation'
    || /^Accommodation\b/i.test(String(line.label || ''))) return 0;
  if (line.staff_custom_line || String(line.component || '') === 'staff_custom_line') return 4;
  var s = String(line.service_type || '').toLowerCase();
  var c = String(line.component || '').toLowerCase();
  if (c === 'course' || c === 'private_lesson' || c === 'lesson'
    || s.indexOf('lesson') >= 0 || s.indexOf('course') >= 0 || s === 'private_lesson') return 1;
  if (line.course_equipment || c === 'course_equipment' || line.is_bundle
    || s === 'surfboard' || s === 'wetsuit' || s === 'addon_service'
    || c.indexOf('rental') >= 0 || s.indexOf('rental') >= 0 || s.indexOf('equipment') >= 0) return 2;
  return 3;
}

/** Compact multi-day coverage (legacy helper). Invoice equipment no longer uses date ranges. */
function scheduleDrawerEquipmentCoverageLabel(dayKeys){
  var keys = (dayKeys || []).map(function(d){ return String(d || '').slice(0, 10); })
    .filter(function(d){ return /^\d{4}-\d{2}-\d{2}$/.test(d); })
    .sort();
  if (!keys.length) return '';
  var n = keys.length;
  return n === 1
    ? ('1 ' + portalT('schedule.drawer.dayWordCap'))
    : (String(n) + ' ' + portalT('schedule.drawer.daysWordCap'));
}

/** Strip raw ISO stay dates from accommodation labels (invoice line owns its own DD-MM range). */
function scheduleDrawerStripAccommodationIsoDates(label) {
  return String(label || '')
    .replace(/\s*·\s*\d{4}-\d{2}-\d{2}\s*(?:→|->|–|—|-)\s*\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\s*·\s*·\s*/g, ' · ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** ISO YYYY-MM-DD → DD-MM (no year). Empty when unavailable — never invent. */
function scheduleDrawerFormatAccommodationDdMm(iso) {
  var s = scheduleDateOnlyLabel(iso);
  if (!s || s === '\u2014' || s.length < 10 || !/^\d{4}-\d{2}-\d{2}/.test(s)) return '';
  return s.slice(8, 10) + '-' + s.slice(5, 7);
}

/**
 * Primary accommodation commercial label: stay dates only (no night count, no season math).
 * Example shape: Accommodation · 25-08 - 30-08
 * Uses line-specific check_in/check_out only — never invoice header dates.
 * Season / nights / rate live on scheduleDrawerFormatAccommodationSeasonSubtitle.
 */
function scheduleDrawerFormatAccommodationInvoiceLabel(line) {
  if (!line) return 'Accommodation';
  var ci = scheduleDrawerFormatAccommodationDdMm(line.check_in);
  var co = scheduleDrawerFormatAccommodationDdMm(line.check_out);
  if (ci && co) {
    return 'Accommodation \u00b7 ' + ci + ' - ' + co;
  }
  // Fail closed: omit missing dates rather than inventing nights or header fallbacks.
  var cleaned = scheduleDrawerStripAccommodationIsoDates(line.label || 'Accommodation');
  cleaned = cleaned
    .replace(/\s*·\s*\d{1,2}-\d{2}\s*-\s*\d{1,2}-\d{2}/g, '')
    .replace(/\s*·\s*\d+\s*nights?/gi, '')
    .replace(/\s*·\s*[^·]+?\s+\u00d7\s*€[\d.,]+(?:\/night)?/g, '')
    .replace(/\s*·\s*·\s*/g, ' \u00b7 ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!/^Accommodation\b/i.test(cleaned)) cleaned = 'Accommodation';
  return cleaned || 'Accommodation';
}

/**
 * One season segment for the grey secondary line.
 * Shape: N nights × €X.XX/night · Season Name
 * Omits unavailable pieces; never invents an average rate.
 */
function scheduleDrawerFormatAccommodationSeasonSegment(group) {
  var g = group || {};
  var title = String(g.title || '').trim();
  var gn = Number(g.nights);
  if (!Number.isFinite(gn) || gn <= 0) gn = 0;
  var nightsPart = gn > 0
    ? (String(gn) + ' night' + (gn === 1 ? '' : 's'))
    : '';
  var ratePart = '';
  if (g.nightly_cents != null && Number.isFinite(Number(g.nightly_cents))) {
    ratePart = scheduleDrawerEur(g.nightly_cents) + '/night';
  }
  var left = '';
  if (nightsPart && ratePart) left = nightsPart + ' \u00d7 ' + ratePart;
  else if (nightsPart) left = nightsPart;
  else if (ratePart) left = ratePart;
  if (left && title) return left + ' \u00b7 ' + title;
  if (left) return left;
  return title;
}

/**
 * Secondary accommodation subtitle from authoritative season_groups only.
 * Single season:
 *   5 nights × €100.00/night · High Season
 * Cross-season keeps every segment on this one secondary line (no invented average):
 *   2 nights × €80.00/night · Low Season; 3 nights × €100.00/night · High Season
 */
function scheduleDrawerFormatAccommodationSeasonSubtitle(line) {
  if (!line) return '';
  var groups = Array.isArray(line.season_groups) ? line.season_groups : [];
  if (!groups.length) return '';
  var parts = [];
  for (var i = 0; i < groups.length; i++) {
    var seg = scheduleDrawerFormatAccommodationSeasonSegment(groups[i]);
    if (seg) parts.push(seg);
  }
  return parts.join('; ');
}

function scheduleDrawerIsCourseLikeLine(line) {
  if (!line || line.course_equipment || String(line.component || '') === 'course_equipment') return false;
  var s = String(line.service_type || '').toLowerCase();
  var c = String(line.component || '').toLowerCase();
  return c === 'course' || c === 'private_lesson' || c === 'lesson'
    || s.indexOf('lesson') >= 0 || s.indexOf('course') >= 0 || s === 'private_lesson';
}

function scheduleDrawerIsEquipmentLikeLine(line) {
  return !!(line && (line.course_equipment || String(line.component || '') === 'course_equipment'));
}

/** True when commercial math uses the stacked ps-svc-detail secondary line (not inline " · math"). */
function scheduleDrawerUsesStackedSvcDetail(line) {
  if (!line) return false;
  if (line.staff_accommodation || String(line.component || '') === 'staff_accommodation') return true;
  if (scheduleDrawerIsEquipmentLikeLine(line)) return true;
  if (scheduleDrawerIsCourseLikeLine(line)) return true;
  return false;
}

/** Course primary label only (service name). Arithmetic lives on the secondary line. */
function scheduleDrawerFormatCourseInvoiceLabel(line) {
  if (!line) return '\u2014';
  var raw = String(line.label || '').trim();
  if (!raw) return '\u2014';
  return raw
    .replace(/\s*·\s*\d+\s*$/, '')
    .replace(/\s*x\s*\d+\s*$/i, '')
    .trim() || raw;
}

function scheduleDrawerCourseEquipmentModeLabel(mode) {
  var key = mode === 'all_day' ? 'schedule.courseEquipment.allDay' : 'schedule.courseEquipment.during';
  var lab = portalT(key);
  if (!lab || lab === key) return mode === 'all_day' ? 'All Day' : 'During Course';
  return lab;
}

/**
 * Equipment primary: service name + mode (e.g. Surfboard + Wetsuit · During Course).
 * Mode stays on the primary label; days × unit/day is secondary only.
 */
function scheduleDrawerFormatEquipmentInvoiceLabel(line) {
  if (!line) return '\u2014';
  var base = String(line.label || '').trim() || 'Equipment';
  base = base
    .replace(/\s*·\s*\d+\s*$/, '')
    .replace(/\s*x\s*\d+\s*$/i, '')
    .trim() || 'Equipment';
  var mode = line.course_equipment_mode === 'all_day' ? 'all_day' : 'during_course';
  var modeLab = scheduleDrawerCourseEquipmentModeLabel(mode);
  if (/\bDuring Course\b/i.test(base) || /\bAll Day\b/i.test(base) || base.indexOf(modeLab) >= 0) {
    return base;
  }
  return base + ' \u00b7 ' + modeLab;
}

/** "8 days × €5.00/day" — uses existing drawer/addon i18n keys. */
function scheduleDrawerFormatDaysTimesUnit(days, unitCents) {
  var n = Math.max(1, Math.round(Number(days) || 1));
  var dayWord = n === 1
    ? (portalT('schedule.drawer.daysWord') === 'días' ? 'día' : 'day')
    : portalT('schedule.drawer.daysWord');
  var suffix = portalT('schedule.addon.perDaySuffix');
  if (!suffix || suffix === 'schedule.addon.perDaySuffix') suffix = '/day';
  return String(n) + ' ' + dayWord + ' \u00d7 ' + scheduleDrawerEur(unitCents) + suffix;
}

/** "8 days · avg €28.57/day" when unit×days cannot reconcile cents exactly. */
function scheduleDrawerFormatDaysAvgUnit(days, avgCents) {
  var n = Math.max(1, Math.round(Number(days) || 1));
  var dayWord = n === 1
    ? (portalT('schedule.drawer.daysWord') === 'días' ? 'día' : 'day')
    : portalT('schedule.drawer.daysWord');
  var avgWord = portalT('schedule.drawer.avgWord');
  if (!avgWord || avgWord === 'schedule.drawer.avgWord') avgWord = 'avg';
  var suffix = portalT('schedule.addon.perDaySuffix');
  if (!suffix || suffix === 'schedule.addon.perDaySuffix') suffix = '/day';
  return String(n) + ' ' + dayWord + ' \u00b7 ' + avgWord + ' ' + scheduleDrawerEur(avgCents) + suffix;
}

/** Presentation-only: collapse truthful bundle/group peers; never invent money. */
function scheduleDrawerBuildCommercialLines(items, rentalPricing) {
  var list = Array.isArray(items) ? items : [], rp = rentalPricing || null;
  var groups = Object.create(null), order = [], singles = [], hiddenIds = Object.create(null), lines = [];
  function st(li) { return String((li && li.service_type) || '').toLowerCase(); }
  function gid(li) { return String((li && (li.pricing_group_id || li.rental_bundle_id)) || '').trim(); }
  function off(li) { return String((li && li.offering_key) || '').trim(); }
  function isRent(s) { return s === 'surfboard' || s === 'wetsuit'; }
  function isLes(s) { return s.indexOf('lesson') >= 0 || s.indexOf('course') >= 0 || s === 'private_lesson'; }
  function isAccom(li) {
    return !!(li && (li.staff_accommodation || String(li.component || '') === 'staff_accommodation'));
  }
  function isCustom(li) {
    return !!(li && (li.staff_custom_line || String(li.component || '') === 'staff_custom_line'));
  }
  function isCourseEquip(li) {
    return !!(li && (li.course_equipment === true || String(li.component || '') === 'course_equipment'));
  }
  function ceMode(li) {
    if (!li) return 'during_course';
    if (li.course_equipment_mode === 'all_day') return 'all_day';
    if (li.course_equipment_mode === 'during_course') return 'during_course';
    var lab = String(li.label || '').toLowerCase();
    if (lab.indexOf('all day') >= 0) return 'all_day';
    return 'during_course';
  }
  function currencyKey(li) {
    return String((li && li.currency) || 'EUR').toUpperCase();
  }
  function readUnit(li) {
    if (!li) return null;
    if (li.unit_amount_cents != null && li.unit_amount_cents !== '') {
      var u = Number(li.unit_amount_cents);
      if (Number.isFinite(u) && u >= 0) return Math.round(u);
    }
    if (li.unit_cents != null && li.unit_cents !== '') {
      var u2 = Number(li.unit_cents);
      if (Number.isFinite(u2) && u2 >= 0) return Math.round(u2);
    }
    return null;
  }
  function attachMath(line) {
    var total = Math.round(Number(line.line_cents || 0));
    var qty = Math.max(1, Math.round(Number(line.quantity) || 1));
    var days = Math.max(1, Math.round(Number(line.billable_days) || (line.covered_dates && line.covered_dates.length) || 1));
    var unit = line.unit_cents != null ? Math.round(Number(line.unit_cents)) : null;
    var mathMode = 'total_only';
    if (unit != null && Number.isFinite(unit) && unit >= 0) {
      if (unit * qty * days === total) mathMode = 'linear';
      else if (unit * qty === total) mathMode = 'package';
      else unit = null;
    }
    line.quantity = qty;
    line.billable_days = days;
    line.unit_cents = unit;
    line.math_mode = mathMode;
    return line;
  }
  function bKey(li) {
    var g = gid(li); if (!g) return '';
    if (off(li) === 'board_and_suit_rental') return 'b:' + g;
    if (li.bundle_part === 'surfboard' || li.bundle_part === 'wetsuit' || li.rental_pricing_role === 'surfboard' || li.rental_pricing_role === 'wetsuit') return 'b:' + g;
    if (rp && rp.offering_key === 'board_and_suit_rental' && String(rp.pricing_group_id || '') === g && isRent(st(li))) return 'b:' + g;
    return '';
  }
  function itemBaseName(li, qty) {
    var s = st(li);
    if (isRent(s)) return (s === 'wetsuit' ? portalT('schedule.type.wetsuitRental') : portalT('schedule.type.boardRental'));
    var raw = (typeof scheduleDrawerStripLabelDate === 'function') ? scheduleDrawerStripLabelDate(li.label) : li.label;
    // Drop trailing " · qty" from compact labels — quantity is shown in math.
    return String(raw || '')
      .replace(/\s*·\s*\d+\s*$/, '')
      .replace(/\s*x\s*\d+\s*$/i, '')
      .trim() || String(raw || '—');
  }
  function pKey(li) {
    if (bKey(li)) return '';
    // Never merge accommodation or staff custom commercial lines.
    if (isAccom(li) || isCustom(li)) return '';
    var o = off(li), s = st(li), c = String((li && li.component) || '').toLowerCase();
    if (o === 'board_rental' || o === 'wetsuit_rental') return 'o:' + o + '|' + String(li.duration_key || (rp && rp.duration) || '');
    if (c === 'course' || (isLes(s) && c !== 'private_lesson' && s !== 'private_lesson' && !isCourseEquip(li)))
      return 'c:' + s + '|' + String(Number(li.quantity) || 1) + '|' + String((li && (li.course_id || li.offering_id)) || '').trim() + '|' + String((li && li.tier_key) || '');
    if (c === 'private_lesson' || s === 'private_lesson') return 'p:' + String(Number(li.quantity) || 1);
    if (isRent(s) && !o) return 'r:' + s + '|' + String(Number(li.quantity) || 1) + '|' + String(li.duration_key || '');
    // Per-day course equipment: group only when identity + unit + qty + currency + mode match.
    if (isCourseEquip(li)) {
      var unitCe = readUnit(li);
      if (unitCe == null) {
        var qCe = Math.max(1, Number(li.quantity) || 1);
        var lineCe = Number(li.line_cents);
        if (Number.isFinite(lineCe) && qCe > 0) unitCe = Math.round(lineCe / qCe);
      }
      if (unitCe == null || !Number.isFinite(unitCe)) return '';
      return 'ce:' + o + '|' + ceMode(li) + '|' + String(Number(li.quantity) || 1)
        + '|' + String(unitCe) + '|' + itemBaseName(li).toLowerCase() + '|' + currencyKey(li);
    }
    // Generic multi-day equipment/rental rows with stable offering identity.
    if (o && (s === 'addon_service' || li.rental_offering === true || li.generic_rental === true
      || c === 'addon_service' || /^rental/.test(c))) {
      var unitGe = readUnit(li);
      if (unitGe == null || !Number.isFinite(unitGe)) return '';
      return 'ge:' + o + '|' + String(li.duration_key || '') + '|' + String(Number(li.quantity) || 1)
        + '|' + String(unitGe) + '|' + itemBaseName(li).toLowerCase() + '|' + currencyKey(li);
    }
    return '';
  }
  function itemLab(li, qty) {
    var base = itemBaseName(li, qty);
    if (qty != null && isRent(st(li))) return base + ' · ' + String(qty);
    return base;
  }
  list.forEach(function(li) {
    var ik = bKey(li) || pKey(li);
    if (!ik) { singles.push(li); return; }
    if (!groups[ik]) {
      groups[ik] = {
        items: [], total: 0, qty: 0, dates: {}, duration_key: null,
        is_bundle: ik.indexOf('b:') === 0,
        is_equipment_group: ik.indexOf('ce:') === 0 || ik.indexOf('ge:') === 0,
        unit_amount_cents: null,
      };
      order.push(ik);
    }
    var g = groups[ik]; g.items.push(li); g.total += Number(li.line_cents || 0);
    var q = Number(li.quantity) || 0; if (q > g.qty) g.qty = q;
    if (li.duration_key) g.duration_key = li.duration_key;
    var u = readUnit(li);
    if (u != null && Number(li.line_cents || 0) > 0) g.unit_amount_cents = u;
    else if (u != null && g.unit_amount_cents == null) g.unit_amount_cents = u;
    var d = String(li.service_date || '').slice(0, 10); if (d) g.dates[d] = true;
    (Array.isArray(li.rental_service_dates) ? li.rental_service_dates : []).forEach(function(x) { var iso = String(x || '').slice(0, 10); if (iso) g.dates[iso] = true; });
  });
  function doCollapse(g) {
    if (g.items.length < 2) return false;
    if (g.is_bundle) { var t = {}; g.items.forEach(function(li) { t[st(li)] = true; }); return !!(t.surfboard && t.wetsuit); }
    // Equipment groups: only collapse when every peer matches unit×qty line amount
    // (or zero companions) and multi-day coverage is present.
    if (g.is_equipment_group) {
      var dayN = Object.keys(g.dates).length;
      if (dayN < 2) return false;
      var expected = null;
      for (var ei = 0; ei < g.items.length; ei++) {
        var row = g.items[ei];
        var rowUnit = readUnit(row);
        var rowQty = Math.max(1, Number(row.quantity) || 1);
        var rowLine = Math.round(Number(row.line_cents || 0));
        if (rowUnit == null) return false;
        if (rowLine !== 0 && rowLine !== rowUnit * rowQty) return false;
        if (expected == null) expected = rowUnit * rowQty;
        else if (rowLine !== 0 && rowLine !== expected) return false;
      }
      return true;
    }
    var z = 0, p = 0; g.items.forEach(function(li) { if (Number(li.line_cents || 0) === 0) z += 1; else p += 1; });
    return (p >= 1 && z >= 1) || Object.keys(g.dates).length > 1;
  }
  order.forEach(function(ik) {
    var g = groups[ik];
    if (!doCollapse(g)) { g.items.forEach(function(li) { singles.push(li); }); return; }
    var dayKeys = Object.keys(g.dates).sort(), n = dayKeys.length || 0, durKey = g.duration_key || (rp && rp.duration) || null, durLab = '';
    if (durKey && typeof schedulePortalDurationLabel === 'function') durLab = schedulePortalDurationLabel(durKey) || '';
    if (!durLab && n > 0) durLab = n === 1 ? ('1 ' + portalT('schedule.drawer.dayWordCap')) : (String(n) + ' ' + portalT('schedule.drawer.daysWordCap'));
    // Equipment groups: never put date coverage on the invoice (day numbers look like prices).
    // Explicit unit×days math owns the subtitle via attachMath + formatCommercialMathLabel.
    if (g.is_equipment_group) durLab = '';
    var ids = g.items.map(function(li) { return li.service_record_id; });
    g.items.forEach(function(li) { if (li.service_record_id) hiddenIds[li.service_record_id] = true; });
    if (g.is_bundle) {
      var parts = [portalT('schedule.ops.rentalBoth')];
      // Name only in label — qty/days/unit go through math presentation (no ISO dates).
      if (g.qty === 1 && !g.unit_amount_cents) parts.push(portalT('schedule.drawer.bundleOneSet'));
      lines.push(attachMath({
        label: parts.join(' · '),
        line_cents: g.total,
        is_bundle: true,
        pricing_group_id: ik.slice(2),
        quantity: g.qty,
        billable_days: n || 1,
        unit_cents: g.unit_amount_cents,
        covered_dates: dayKeys,
        member_ids: ids,
        duration_label: durLab || null,
      }));
      return;
    }
    var primary = null;
    g.items.forEach(function(li) { if (!primary || Number(li.line_cents || 0) > Number(primary.line_cents || 0)) primary = li; });
    var lab = itemBaseName(primary, g.qty);
    // Presentation primary labels: course = service name; equipment = name · mode.
    if (isCourseEquip(primary)) {
      lab = scheduleDrawerFormatEquipmentInvoiceLabel({
        label: lab,
        course_equipment: true,
        course_equipment_mode: ceMode(primary),
      });
    } else if (scheduleDrawerIsCourseLikeLine(primary)) {
      lab = scheduleDrawerFormatCourseInvoiceLabel({ label: lab, component: primary.component, service_type: primary.service_type });
    }
    var collapsed = attachMath({
      label: lab,
      line_cents: g.total,
      is_bundle: false,
      service_type: primary.service_type,
      component: primary.component || null,
      course_equipment: isCourseEquip(primary) || undefined,
      course_equipment_mode: isCourseEquip(primary) ? ceMode(primary) : undefined,
      offering_key: primary.offering_key || null,
      quantity: g.qty,
      billable_days: n || 1,
      unit_cents: g.unit_amount_cents != null ? g.unit_amount_cents : readUnit(primary),
      covered_dates: dayKeys,
      member_ids: ids,
      duration_label: durLab || null,
    });
    lines.push(collapsed);
  });
  singles.forEach(function(li) {
    if (li.service_record_id && hiddenIds[li.service_record_id]) return;
    var days = 1;
    var cov = [];
    var d0 = String(li.service_date || '').slice(0, 10);
    if (d0) cov.push(d0);
    (Array.isArray(li.rental_service_dates) ? li.rental_service_dates : []).forEach(function(x) {
      var iso = String(x || '').slice(0, 10); if (iso && cov.indexOf(iso) < 0) cov.push(iso);
    });
    if (cov.length) days = cov.length;
    var accomLabel = isAccom(li)
      ? scheduleDrawerFormatAccommodationInvoiceLabel({
        label: li.label,
        nights: li.nights,
        check_in: li.check_in,
        check_out: li.check_out,
        season_groups: li.season_groups || null,
      })
      : null;
    var baseLab = accomLabel != null ? accomLabel : itemBaseName(li, li.quantity);
    if (isCourseEquip(li)) {
      baseLab = scheduleDrawerFormatEquipmentInvoiceLabel({
        label: baseLab,
        course_equipment: true,
        course_equipment_mode: ceMode(li),
      });
    } else if (!isAccom(li) && scheduleDrawerIsCourseLikeLine(li)) {
      baseLab = scheduleDrawerFormatCourseInvoiceLabel({
        label: baseLab,
        component: li.component,
        service_type: li.service_type,
      });
    }
    var singleLine = attachMath({
      label: baseLab,
      line_cents: Number(li.line_cents || 0),
      is_bundle: false,
      service_type: li.service_type,
      component: li.component || null,
      course_equipment: isCourseEquip(li) || undefined,
      course_equipment_mode: isCourseEquip(li) ? ceMode(li) : undefined,
      offering_key: li.offering_key || null,
      quantity: li.quantity,
      billable_days: days,
      unit_cents: readUnit(li),
      covered_dates: cov,
      service_record_id: li.service_record_id,
      staff_accommodation: isAccom(li) || undefined,
      staff_custom_line: isCustom(li) || undefined,
      check_in: li.check_in || null,
      check_out: li.check_out || null,
      nights: li.nights,
      season_groups: li.season_groups || null,
    });
    lines.push(singleLine);
  });
  lines.sort(function(a, b){
    var ra = scheduleDrawerCommercialLineRank(a);
    var rb = scheduleDrawerCommercialLineRank(b);
    if (ra !== rb) return ra - rb;
    return 0;
  });
  return { lines: lines, hidden_ids: hiddenIds };
}

/** Build truthful arithmetic subtitle: linear unit×qty×days, package unit×qty + duration, or empty. */
function scheduleDrawerFormatCommercialMathLabel(line) {
  if (!line) return '';
  // Accommodation: season math is the secondary subtitle (still one right-side amount).
  if (line.staff_accommodation || String(line.component || '') === 'staff_accommodation') {
    return scheduleDrawerFormatAccommodationSeasonSubtitle(line);
  }
  var mode = line.math_mode || 'total_only';
  var unit = line.unit_cents;
  var qty = Math.max(1, Math.round(Number(line.quantity) || 1));
  var days = Math.max(1, Math.round(Number(line.billable_days) || 1));
  var total = Math.round(Number(line.line_cents || 0));
  var isCourse = scheduleDrawerIsCourseLikeLine(line);
  var isCe = scheduleDrawerIsEquipmentLikeLine(line);

  // Course equipment: explicit reconciled days × unit/day (never date coverage).
  if (isCe && mode === 'linear' && unit != null && Number.isFinite(unit) && unit >= 0) {
    if (qty === 1) return scheduleDrawerFormatDaysTimesUnit(days, unit);
    return scheduleDrawerFormatDaysTimesUnit(days, unit) + ' \u00d7 ' + String(qty);
  }

  // Multi-day course package / total_only: exact daily when cents divide; else labeled avg.
  // Never claim rounded average × days equals the right-side amount.
  if (isCourse && days > 1 && (mode === 'package' || mode === 'total_only')) {
    var denom = days * qty;
    if (denom > 0 && Number.isFinite(total) && total % denom === 0) {
      return scheduleDrawerFormatDaysTimesUnit(days, total / denom);
    }
    if (denom > 0 && Number.isFinite(total) && total > 0) {
      return scheduleDrawerFormatDaysAvgUnit(days, Math.round(total / denom));
    }
  }

  var parts = [];
  if (mode === 'linear' && unit != null) {
    parts.push(scheduleDrawerEur(unit));
    if (line.is_bundle) {
      parts.push(String(qty) + ' ' + (qty === 1 ? portalT('schedule.drawer.bundleOneSet') : portalT('schedule.drawer.bundleSets')));
    } else if (isCourse || /surfers?/i.test(String(line.label || ''))) {
      parts.push(String(qty) + ' ' + (qty === 1 ? portalT('schedule.drawer.surferWord') : portalT('schedule.drawer.surfersWord')));
    } else {
      parts.push('\u00d7 ' + String(qty));
    }
    if (days > 1) {
      parts.push(String(days) + ' ' + portalT('schedule.drawer.daysWordCap'));
    } else if (days === 1 && mode === 'linear') {
      parts.push(String(days) + ' ' + portalT('schedule.drawer.dayWordCap'));
    }
    // Format as €30.00 × 2 surfers × 5 Days
    if (parts.length >= 2) {
      var out = parts[0];
      for (var i = 1; i < parts.length; i++) {
        var p = parts[i];
        out += (p.indexOf('\u00d7') === 0 ? ' ' + p : ' \u00d7 ' + p);
      }
      return out;
    }
    return parts.join(' \u00d7 ');
  }
  if (mode === 'package' && unit != null) {
    var pkg = scheduleDrawerEur(unit);
    if (qty > 1) pkg += ' \u00d7 ' + String(qty);
    if (line.duration_label) pkg += ' \u00b7 ' + line.duration_label;
    else if (days > 1) pkg += ' \u00b7 ' + String(days) + ' ' + portalT('schedule.drawer.daysWordCap');
    return pkg;
  }
  // total_only: optional duration context only — never invent unit math, never dates
  if (line.duration_label) {
    // Guard: drop accidental date fragments (e.g. "30 Jul") from duration labels.
    var dur = String(line.duration_label);
    if (/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(dur)
      || /\d{4}-\d{2}-\d{2}/.test(dur)) {
      if (days > 1) return String(days) + ' ' + portalT('schedule.drawer.daysWordCap');
      return '';
    }
    return line.duration_label;
  }
  if (days > 1) return String(days) + ' ' + portalT('schedule.drawer.daysWordCap');
  return '';
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
    html += '<div class="ps-money-actions"><button type="button" class="btn btn-primary" id="ps-drawer-stripe-link">' + escHtml(portalT(stale ? 'schedule.drawer.createNewPaymentLink' : 'schedule.drawer.createPaymentLink')) + '</button></div>';
  } else {
    html += '<div class="ps-money-actions"><button type="button" class="btn btn-ghost" disabled title="' + escHtml(portalT('schedule.drawer.stripeUnavailable')) + '">' + escHtml(portalT('schedule.drawer.createPaymentLink')) + '</button></div>';
  }
  return html;
}

function scheduleRenderSunsetRecordPaymentHtml(ctx){
  if (!(ctx && ctx.booking_id)) return '';
  var pay = (ctx && ctx.payment) || {};
  var defaultAmount = scheduleDrawerEurInputValue(pay.balance_due_cents);
  var html = '<details class="ps-drawer-details"><summary>' + escHtml(portalT('schedule.drawer.recordPayment')) + '</summary>';
  html += '<div id="ps-drawer-manual-pay" style="margin-top:8px">';
  html += '<div class="portal-schedule-manual-pay-grid">';
  html += '<label>' + escHtml(portalT('schedule.drawer.manualPayAmount')) +
    '<input id="ps-drawer-manual-amount" type="number" min="0" step="0.01" inputmode="decimal"' +
    (defaultAmount ? ' value="' + escHtml(defaultAmount) + '"' : '') + '></label>';
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

function scheduleRenderSunsetInvoiceCreditLabel(row) {
  var method = scheduleDrawerPaidMethodLabel(row && row.method);
  var base = portalT('schedule.drawer.paymentCredit');
  if (method) return base + ' · ' + method;
  if (row && row.kind === 'card') return base + ' · ' + portalT('schedule.drawer.methodCard');
  return base;
}

function scheduleRenderSunsetInvoiceCardHtml(ctx){
  var pay = (ctx && ctx.payment) || {};
  var items = pay.line_items || [];
  var comps = (ctx && ctx.components) || {};
  var html = '<div class="ctx-pay-box ps-invoice-card" id="ps-drawer-payment-box" style="margin-top:0">';

  // Header: date range once (no per-line dates)
  var from = scheduleDrawerDDMMYY(ctx && ctx.date_from);
  var to = scheduleDrawerDDMMYY((ctx && ctx.date_to) || (ctx && ctx.date_from));
  var dayMap = {};
  items.forEach(function(li){ var d = String(li.service_date || '').slice(0, 10); if (d) dayMap[d] = true; });
  var dayCount = Object.keys(dayMap).length || ((from && to && from !== to) ? 2 : 1);
  var surfers = (comps.course && comps.course.quantity)
    || (comps.private_lesson && (comps.private_lesson.surfer_count || comps.private_lesson.quantity))
    || (comps.lesson && comps.lesson.quantity) || 0;
  if (!surfers) {
    items.forEach(function(li) {
      var t = String(li.service_type || '');
      if (t.indexOf('lesson') >= 0 || t.indexOf('course') >= 0) surfers = Math.max(surfers, Number(li.quantity) || 0);
    });
  }
  if (!surfers) surfers = Number(ctx && ctx.guest_count) || 0;
  var hasCourse = !!(comps.course || comps.private_lesson || comps.lesson);
  if (!hasCourse) {
    items.forEach(function(li) {
      var t = String(li.service_type || '');
      if (t.indexOf('lesson') >= 0 || t.indexOf('course') >= 0) hasCourse = true;
    });
  }
  var daysLabel = dayCount + ' ' + (dayCount === 1 ? portalT('schedule.drawer.dayWordCap') : portalT('schedule.drawer.daysWordCap'));
  var title = hasCourse && surfers
    ? (surfers + ' ' + (surfers === 1 ? portalT('schedule.drawer.surferWord') : portalT('schedule.drawer.surfersWord')) + ' · ' + daysLabel)
    : (portalT('schedule.drawer.invoiceTitle') + (dayCount ? (' · ' + daysLabel) : ''));
  var subtitle = from ? (from + (to && to !== from ? ' \u2013 ' + to : '')) : '';
  html += '<div class="ps-invoice-header">';
  html += '<div class="ps-card-eyebrow">' + escHtml(portalT('schedule.drawer.invoiceTitle')) + '</div>';
  html += '<h4 class="portal-schedule-drawer-section-title" style="margin:0 0 4px">' + escHtml(title) + '</h4>';
  if (subtitle) html += '<p class="ps-card-subtitle" style="margin:0 0 10px">' + escHtml(subtitle) + '</p>';
  html += '</div>';

  var commercial = scheduleDrawerBuildCommercialLines(items, (pay && pay.rental_pricing) || (ctx && ctx.rental_pricing) || null);
  var commercialLines = (commercial && commercial.lines) || [];
  // Enrich each accommodation commercial line with its own snapshot season groups.
  // Match by service_record_id, then check_in/check_out — never first-label-only (multi-stay).
  commercialLines = commercialLines.map(function(line) {
    if (!line) return line;
    var isAccomLine = !!(line.staff_accommodation || line.component === 'staff_accommodation'
      || String(line.label || '').indexOf('Accommodation') === 0);
    if (!isAccomLine && !(line.check_in && line.check_out)) return line;
    var src = null;
    items.forEach(function(li) {
      if (!li) return;
      if (!(li.staff_accommodation || li.component === 'staff_accommodation')) return;
      if (src) return;
      if (line.service_record_id && li.service_record_id
        && String(line.service_record_id) === String(li.service_record_id)) {
        src = li;
        return;
      }
      if (line.check_in && line.check_out && li.check_in && li.check_out
        && String(line.check_in).slice(0, 10) === String(li.check_in).slice(0, 10)
        && String(line.check_out).slice(0, 10) === String(li.check_out).slice(0, 10)) {
        src = li;
      }
    });
    if (!src && isAccomLine) {
      // Last resort: match unused accommodation item by date identity on the line.
      items.forEach(function(li) {
        if (src || !li) return;
        if (!(li.staff_accommodation || li.component === 'staff_accommodation')) return;
        if (line.check_in && li.check_in
          && String(line.check_in).slice(0, 10) === String(li.check_in).slice(0, 10)) {
          src = li;
        }
      });
    }
    if (!src) return line;
    var enriched = Object.assign({}, line, {
      staff_accommodation: true,
      season_groups: src.season_groups || line.season_groups || null,
      check_in: src.check_in || line.check_in || null,
      check_out: src.check_out || line.check_out || null,
      nights: src.nights != null ? src.nights : line.nights,
      line_cents: src.line_cents != null ? src.line_cents : line.line_cents,
    });
    // Primary label = stay DD-MM range; season/nights/rate math is secondary (no child amounts).
    enriched.label = scheduleDrawerFormatAccommodationInvoiceLabel(enriched);
    return enriched;
  });
  if (commercialLines.length) {
    html += '<div class="ps-invoice-lines" data-testid="ps-invoice-lines">';
    commercialLines.forEach(function(line) {
      var math = scheduleDrawerFormatCommercialMathLabel(line);
      var isAccomLine = !!(line.staff_accommodation || line.component === 'staff_accommodation');
      var isCeLine = !isAccomLine && scheduleDrawerIsEquipmentLikeLine(line);
      var isCourseLine = !isAccomLine && !isCeLine && scheduleDrawerIsCourseLikeLine(line);
      var stackedDetail = scheduleDrawerUsesStackedSvcDetail(line);
      var displayLabel;
      if (isAccomLine) displayLabel = scheduleDrawerFormatAccommodationInvoiceLabel(line);
      else if (isCeLine) displayLabel = scheduleDrawerFormatEquipmentInvoiceLabel(line);
      else if (isCourseLine) displayLabel = scheduleDrawerFormatCourseInvoiceLabel(line);
      else displayLabel = line.label || '—';
      html += '<div class="ps-svc-summary-row ps-invoice-line' + (line.is_bundle ? ' is-bundle-line' : '') +
        (isAccomLine ? ' is-accommodation-line' : '') +
        (isCourseLine ? ' is-course-line' : '') +
        (isCeLine ? ' is-equipment-line' : '') + '" data-testid="' +
        (isAccomLine ? 'ps-invoice-accommodation' : 'ps-invoice-line') + '"'
        + (line.check_in ? ' data-check-in="' + escHtml(String(line.check_in).slice(0, 10)) + '"' : '')
        + (line.check_out ? ' data-check-out="' + escHtml(String(line.check_out).slice(0, 10)) + '"' : '')
        + '>';
      html += '<span class="ps-svc-name">' + escHtml(displayLabel);
      // Accommodation / course / equipment: existing ps-svc-detail as a second text line;
      // other lines keep the inline " · math" subtitle.
      if (math) {
        if (stackedDetail) {
          html += '<span class="ps-svc-detail">' + escHtml(math) + '</span>';
        } else {
          html += '<span class="ps-svc-detail"> · ' + escHtml(math) + '</span>';
        }
      }
      html += '</span>';
      html += '<span class="ps-svc-amt ps-invoice-amt">' + escHtml(scheduleDrawerEur(line.line_cents)) + '</span>';
      html += '</div>';
      // Season / service arithmetic stay on the parent item secondary line only — never extra commercial totals.
    });
    html += '</div>';
  } else if (!items.length) {
    var summary = scheduleFormatComponentsView(comps);
    if (summary && summary !== '—') {
      html += '<p class="portal-schedule-drawer-kv" style="margin:0 0 8px">' + escHtml(summary) + '</p>';
    }
  }

  // Footer: Subtotal → payment credits (negative) → balance / paid / refund
  var sub = Number(pay.subtotal_cents || 0);
  var paid = Number(pay.paid_cents || 0);
  var due = (pay.balance_due_cents != null) ? Number(pay.balance_due_cents) : null;
  var refund = Number(pay.refund_credit_cents || 0);
  if (!(refund > 0) && paid > sub && sub >= 0) refund = paid - sub;
  // Chip ↔ drawer parity: never label Pagado from status enums when paid cents are €0.
  var fullyPaid = paid > 0 && refund <= 0 && (due == null || due <= 0);
  var overpaid = refund > 0;

  html += '<div class="ps-invoice-totals">';
  html += '<div class="ctx-inv-total-row ps-invoice-total-row"><span class="ctx-inv-total-label">' +
    escHtml(portalT('schedule.drawer.subtotal')) + '</span><span class="ctx-inv-total-amount ps-invoice-amt" id="ps-drawer-subtotal">' +
    escHtml(scheduleDrawerEur(sub)) + '</span></div>';

  var credits = Array.isArray(pay.paid_payments) ? pay.paid_payments : [];
  credits.forEach(function(row) {
    var amt = Number(row && row.amount_cents) || 0;
    if (!(amt > 0)) return;
    html += '<div class="ctx-inv-total-row ps-invoice-total-row ps-invoice-credit"><span class="ctx-inv-total-label">' +
      escHtml(scheduleRenderSunsetInvoiceCreditLabel(row)) +
      '</span><span class="ctx-inv-total-amount paid ps-invoice-amt">\u2212' + escHtml(scheduleDrawerEur(amt)) + '</span></div>';
  });
  var remainder = Number(pay.paid_ledger_remainder_cents || 0);
  if (remainder > 0) {
    html += '<div class="ctx-inv-total-row ps-invoice-total-row ps-invoice-credit"><span class="ctx-inv-total-label">' +
      escHtml(portalT('schedule.drawer.otherPayments')) +
      '</span><span class="ctx-inv-total-amount paid ps-invoice-amt">\u2212' + escHtml(scheduleDrawerEur(remainder)) + '</span></div>';
  }

  if (overpaid) {
    html += '<div class="ctx-inv-total-row ps-invoice-total-row ps-invoice-balance is-refund"><span class="ctx-inv-total-label">' +
      escHtml(portalT('schedule.drawer.refundCredit')) +
      '</span><span class="ctx-inv-total-amount paid ps-invoice-amt" id="ps-drawer-remaining">' +
      escHtml(scheduleDrawerEur(refund)) + '</span></div>';
  } else if (fullyPaid) {
    html += '<div class="ctx-inv-total-row ps-invoice-total-row ps-invoice-balance is-paid"><span class="ctx-inv-total-label">' +
      escHtml(portalT('schedule.drawer.paidInFull')) +
      '</span><span class="ctx-inv-total-amount paid ps-invoice-amt" id="ps-drawer-remaining">' +
      escHtml(scheduleDrawerEur(paid)) + '</span></div>';
  } else {
    html += '<div class="ctx-inv-total-row ps-invoice-total-row ps-invoice-balance is-due"><span class="ctx-inv-total-label">' +
      escHtml(portalT('schedule.drawer.balanceDue')) +
      '</span><span class="ctx-inv-total-amount owing ps-invoice-amt" id="ps-drawer-remaining">' +
      escHtml(scheduleDrawerEur(due != null ? due : null)) + '</span></div>';
  }
  html += '<span id="ps-drawer-paid" class="ps-invoice-paid-sr" style="position:absolute;left:-9999px" aria-hidden="true">' +
    escHtml(scheduleDrawerEur(paid)) + '</span>';
  html += '</div>';

  // Payment link + collapsible manual payment stay inside the invoice card
  html += scheduleRenderSunsetMoneyActionsHtml(ctx);
  html += scheduleRenderSunsetRecordPaymentHtml(ctx);
  html += '</div>';
  return html;
}

function scheduleRenderSunsetViewDrawerHtml(row, ctx, canEdit){
  var html = scheduleRenderDrawerHeroHtml(ctx, row);
  html += scheduleRenderSunsetInvoiceCardHtml(ctx);
  html += scheduleRenderDrawerWaiverSectionHtml(ctx);
  if (ctx && ctx.notes) {
    html += scheduleDrawerSectionHtml('schedule.drawer.section.notes',
      '<p class="portal-schedule-drawer-kv" style="margin:0">' + escHtml(ctx.notes) + '</p>');
  }
  html += '<p id="ps-drawer-save-msg" class="state-msg" style="display:none;margin-top:8px"></p>';
  html += '<p id="ps-drawer-stripe-msg" class="state-msg" style="display:none;margin-top:8px"></p>';
  html += '<div class="portal-schedule-drawer-actions">';
  if (canEdit) html += '<button type="button" class="btn btn-primary" id="ps-drawer-edit">' + escHtml(portalT('schedule.drawer.edit')) + '</button>';
  html += '<button type="button" class="btn btn-ghost" id="ps-drawer-conversation-btn">' + escHtml(portalT('schedule.drawer.startConv')) + '</button>';
  html += scheduleRenderDrawerOpenCustomerBtnHtml(ctx, row);
  html += '</div>';
  html += '<p id="ps-drawer-conversation-hint" class="portal-schedule-drawer-hint" style="display:none"></p>';
  html += scheduleRenderDeleteBookingRowHtml(ctx, row);
  return html;
}

function scheduleRenderViewDrawerHtml(row, ctx, canEdit){
  if (isSunsetSurfActive()) return scheduleRenderSunsetViewDrawerHtml(row, ctx, canEdit);
  var html = scheduleRenderDrawerHeroHtml(ctx, row);

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
  html += scheduleRenderDrawerOpenCustomerBtnHtml(ctx, row);

  html += '<button type="button" class="btn btn-ghost" id="ps-drawer-conversation-btn">' + escHtml(portalT('schedule.drawer.startConv')) + '</button>';
  html += '</div>';
  html += '<p id="ps-drawer-conversation-hint" class="portal-schedule-drawer-hint" style="display:none"></p>';
  html += scheduleRenderDeleteBookingRowHtml(ctx, row);
  return html;
}

function scheduleDrawerEur(cents){
  if (cents == null || isNaN(Number(cents))) return '—';
  return '\u20ac' + (Number(cents) / 100).toFixed(2);
}

function scheduleDrawerEurInputValue(cents){
  if (cents == null || isNaN(Number(cents))) return '';
  var n = Number(cents);
  if (n <= 0) return '';
  return (n / 100).toFixed(2);
}

function scheduleRenderDrawerPaymentSectionViewHtml(ctx){
  if (isSunsetSurfActive()) return scheduleRenderSunsetInvoiceCardHtml(ctx);
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
  var effPaid = (Number(pay.paid_cents || 0) > 0 && (pay.balance_due_cents == null || Number(pay.balance_due_cents) <= 0));
  // Never label Pagado from status enums when paid cents are €0 (chip ↔ drawer parity).
  var effStatus = effPaid ? 'paid' : (Number(pay.paid_cents || 0) > 0 ? pay.payment_status : 'unpaid');
  html += '<div class="ctx-inv-total-row"><span class="ctx-inv-total-label">' + escHtml(portalT('schedule.col.payment')) +
    '</span><span class="ctx-inv-total-amount' + (effPaid ? ' paid' : '') + '" id="ps-drawer-pay-status">' + escHtml(schedulePaymentStatusLabel(effStatus, ctx && ctx.payment_method)) + '</span></div>';
  html += '</div>';
  html += scheduleRenderDrawerManualPaymentHtml(ctx);
  html += scheduleRenderDrawerStripeLinkSectionHtml(ctx);
  html += '</div>';
  return html;
}
