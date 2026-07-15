'use strict';

/**
 * Sunset Schedule — Day / Week / Next-30 view-grid orchestration (Slice 20).
 *
 * Injected after forecast cards module. Selects one primary Schedule container and
 * delegates to day ops board (Slice 18) and forecast cards (Slice 19).
 *
 * Consumes presentation-ready view-grid contexts built by the monolith. Does not
 * fetch data, compute domain aggregates, or own global navigation state.
 *
 * Requires: el, escHtml, scheduleNavigationLoadGen, renderScheduleDayOpsBoard,
 * scheduleRenderForecastCardHtml, scheduleWireForecastCardNavigation.
 */

function scheduleNormalizeViewGridMode(mode) {
  var m = String(mode || '').trim();
  if (m === 'day' || m === 'week' || m === 'next30') return m;
  return 'day';
}

function scheduleApplyViewGridVisibility(opsBox, weekBox, monthBox, mode) {
  if (opsBox) opsBox.style.display = mode === 'day' ? '' : 'none';
  if (weekBox) weekBox.style.display = mode === 'week' ? '' : 'none';
  if (monthBox) monthBox.style.display = mode === 'next30' ? '' : 'none';
}

function scheduleRenderViewGridWeekHtml(cards, emptyDayText) {
  var html = '';
  (cards || []).forEach(function(cardCtx) {
    html += scheduleRenderForecastCardHtml(cardCtx);
  });
  return html || ('<div class="state-msg">' + escHtml(emptyDayText || '') + '</div>');
}

function scheduleRenderViewGridNext30Html(cards, emptyDayText) {
  return scheduleRenderViewGridWeekHtml(cards, emptyDayText);
}

function scheduleMountViewGridForecastCards(box, cards, emptyDayText) {
  if (!box) return;
  box.className = 'portal-schedule-week-forecast';
  box.style.gridTemplateColumns = 'repeat(7, minmax(0, 1fr))';
  box.innerHTML = scheduleRenderViewGridWeekHtml(cards, emptyDayText);
  scheduleWireForecastCardNavigation(box);
}

function renderScheduleViewGrid(ctx) {
  ctx = ctx || {};
  if (ctx.renderGen == null || ctx.renderGen !== scheduleNavigationLoadGen()) return;
  var mode = scheduleNormalizeViewGridMode(ctx.mode);
  var weekBox = el('ps-week-grid');
  var monthBox = el('ps-month-grid');
  var opsBox = el('ps-ops-board');
  if (!weekBox && !monthBox && !opsBox) return;
  scheduleApplyViewGridVisibility(opsBox, weekBox, monthBox, mode);
  if (mode === 'day') {
    var dayPack = ctx.dayPack || { lessons: [], gear: [], rows: [] };
    var activeIso = String(ctx.activeDayIso || '').trim();
    if (opsBox) renderScheduleDayOpsBoard(dayPack, activeIso);
    return;
  }
  if (mode === 'next30') {
    if (monthBox) scheduleMountViewGridForecastCards(monthBox, ctx.next30Cards, ctx.emptyDayText);
    return;
  }
  if (weekBox) scheduleMountViewGridForecastCards(weekBox, ctx.weekCards, ctx.emptyDayText);
}
