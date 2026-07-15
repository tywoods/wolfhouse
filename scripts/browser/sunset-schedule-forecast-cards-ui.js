'use strict';

/**
 * Sunset Schedule — forecast-card presentation + day navigation (Slice 19).
 *
 * Injected after day ops board module. Owns rich Week/Next-30 forecast card HTML,
 * safe day identity attributes, and rerender-safe pointer/keyboard activation.
 *
 * Consumes presentation-ready card contexts built by the monolith. Does not fetch
 * Schedule data, compute domain aggregates, or mutate view/date state directly.
 *
 * Requires portal globals: portalT, escHtml, scheduleOpenDayDetail.
 */

function scheduleClampForecastPct(value) {
  var n = Number(value);
  if (!isFinite(n) || isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function scheduleValidateForecastCardIso(raw) {
  var iso = String(raw || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  return iso;
}

function scheduleResolveForecastCardFromTarget(target) {
  if (!target || typeof target.closest !== 'function') return null;
  return target.closest('[data-ps-day-open]') || null;
}

function scheduleRenderForecastCardHtml(ctx) {
  ctx = ctx || {};
  var iso = scheduleValidateForecastCardIso(ctx.iso);
  if (!iso) return '';
  var todayCls = ctx.isToday ? ' is-today' : '';
  var slotHtml = '';
  (ctx.sessions || []).forEach(function(s) {
    var staffPct = scheduleClampForecastPct(s.staffPct);
    var lunaPct = scheduleClampForecastPct(s.lunaPct);
    var timeShort = String(s.timeShort || '');
    var label = String(s.label || '');
    slotHtml += '<div class="portal-schedule-wk-slot">' +
      '<div class="portal-schedule-wk-slot-row"><span>' + escHtml((timeShort ? timeShort + ' ' : '') + label) + '</span><b>' + escHtml(String(s.countLabel || '')) + '</b></div>' +
      '<div class="portal-schedule-wk-slot-track" aria-hidden="true">' +
      '<i class="is-staff" style="width:' + staffPct + '%"></i>' +
      '<i class="is-luna" style="width:' + lunaPct + '%"></i>' +
      '</div></div>';
  });
  var metaLine = ctx.seatPct != null
    ? String(ctx.seatPct) + '% · ' + String(ctx.seats || 0) + ' ' + portalT('schedule.glance.seats')
    : String(ctx.equipBoardsTotal || 0) + ' ' + portalT('schedule.summary.boards') + ' · ' + String(ctx.equipWetsuitsTotal || 0) + ' ' + portalT('schedule.summary.wetsuits');
  var flagsHtml = '';
  if (ctx.unpaidCount) flagsHtml += '<span class="portal-schedule-wk-flag is-unpaid">' + escHtml(String(ctx.unpaidCount) + ' ' + portalT('schedule.status.unpaid').toLowerCase()) + '</span>';
  if (ctx.needReplyCount) flagsHtml += '<span class="portal-schedule-wk-flag is-reply">' + escHtml(String(ctx.needReplyCount) + ' ' + portalT('schedule.filter.needsReply').toLowerCase()) + '</span>';
  return '<div class="portal-schedule-week-forecast-card' + todayCls + '" data-ps-day-open="' + escHtml(iso) + '" role="button" tabindex="0">' +
    '<div class="portal-schedule-week-forecast-hdr">' + escHtml(String(ctx.dayLabel || iso)) + '</div>' +
    '<div class="portal-schedule-week-forecast-stat">' + escHtml(String(ctx.surfers != null ? ctx.surfers : 0)) + ' <small>' + escHtml(portalT('schedule.slot.surfers')) + '</small></div>' +
    '<div class="portal-schedule-week-forecast-meta">' + escHtml(metaLine) + '</div>' +
    (slotHtml ? '<div class="portal-schedule-week-forecast-slots">' + slotHtml + '</div>' : '') +
    (flagsHtml ? '<div class="portal-schedule-wk-flags">' + flagsHtml + '</div>' : '') +
    '</div>';
}

function scheduleActivateForecastCard(ev) {
  if (ev.type === 'keydown') {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    if (ev.key === ' ') ev.preventDefault();
  }
  ev.stopPropagation();
  var card = scheduleResolveForecastCardFromTarget(ev.target);
  if (!card) return;
  var iso = scheduleValidateForecastCardIso(card.getAttribute('data-ps-day-open'));
  if (!iso) return;
  scheduleOpenDayDetail(iso);
}

function scheduleWireForecastCardNavigation(container) {
  if (!container) return;
  container.querySelectorAll('[data-ps-day-open]').forEach(function(node) {
    if (node.dataset.psForecastWired) return;
    node.dataset.psForecastWired = '1';
    node.addEventListener('click', scheduleActivateForecastCard);
    node.addEventListener('keydown', scheduleActivateForecastCard);
  });
}
