'use strict';

/**
 * Sunset Admin Finance — Option B redesign renderer (browser).
 * Pure display only: no money arithmetic beyond Intl formatting.
 * Injected before sunset-admin-ui.js so loadAdminFinanceSummary can call it.
 *
 * @module sunset-admin-finance-redesign-ui
 */

function financeRedesignFmtEur(cents) {
  var n = Number(cents);
  if (!Number.isFinite(n)) n = 0;
  try {
    return new Intl.NumberFormat(typeof portalLang === 'string' ? portalLang : 'en', {
      style: 'currency',
      currency: 'EUR',
      maximumFractionDigits: 0,
    }).format(n / 100);
  } catch (_e) {
    return '€' + String(Math.round(n / 100));
  }
}

function financeRedesignFmtEurExact(cents) {
  var n = Number(cents);
  if (!Number.isFinite(n)) n = 0;
  try {
    return new Intl.NumberFormat(typeof portalLang === 'string' ? portalLang : 'en', {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n / 100);
  } catch (_e) {
    return '€' + (n / 100).toFixed(2);
  }
}

function financeRedesignMoneyHtml(cents, compactClass) {
  var known = cents != null && Number.isFinite(Number(cents));
  if (!known) return '—';
  return '<span class="' + financeRedesignEsc(compactClass || '') + '" aria-hidden="true">' +
    financeRedesignEsc(financeRedesignFmtEur(cents)) + '</span>' +
    '<span class="pfb-sr">' + financeRedesignEsc(financeRedesignFmtEurExact(cents)) + '</span>';
}

function financeRedesignEsc(s) {
  if (typeof escHtml === 'function') return escHtml(s);
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function financeRedesignT(key, fallback) {
  var fn = null;
  try {
    if (typeof portalT === 'function') fn = portalT;
    else if (typeof globalThis !== 'undefined' && typeof globalThis.portalT === 'function') fn = globalThis.portalT;
  } catch (_e) { fn = null; }
  if (fn) {
    var v = fn(key);
    if (v && v !== key) return v;
  }
  return fallback || key;
}

function financeRedesignDeltaChip(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) {
    return '<span class="pfb-delta is-flat">—</span>';
  }
  var n = Number(pct);
  var up = n > 0;
  var down = n < 0;
  var cls = up ? 'is-up' : (down ? 'is-down' : 'is-flat');
  var arrow = up ? '▲' : (down ? '▼' : '·');
  var abs = Math.abs(n);
  var label = (abs % 1 === 0 ? String(abs) : abs.toFixed(1)) + '%';
  return '<span class="pfb-delta ' + cls + '">' + arrow + ' ' + financeRedesignEsc(label) + '</span>';
}

function financeRedesignLocaleTag() {
  var loc = 'en';
  try {
    if (typeof portalLang === 'string' && portalLang) loc = portalLang;
    else if (typeof getStaffLocale === 'function') loc = String(getStaffLocale() || 'en');
  } catch (_e) { loc = 'en'; }
  loc = String(loc || 'en').toLowerCase();
  if (loc.indexOf('es') === 0) return 'es-ES';
  if (loc.indexOf('it') === 0) return 'it-IT';
  return 'en-GB';
}

/** Locale-aware short date for Custom range chrome (never raw ISO). */
function financeRedesignFormatIsoDate(iso) {
  var s = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  try {
    var parts = s.split('-').map(Number);
    var d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
    return d.toLocaleDateString(financeRedesignLocaleTag(), {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });
  } catch (_e) {
    return s;
  }
}

function financeRedesignFormatIsoRange(start, end) {
  var a = financeRedesignFormatIsoDate(start);
  var b = financeRedesignFormatIsoDate(end);
  if (!a) return b || '';
  if (!b || String(start).slice(0, 10) === String(end).slice(0, 10)) return a;
  return a + ' – ' + b;
}

function financeRedesignTitle(view) {
  if (!view || !view.range) return '';
  var g = view.granularity || 'month';
  var start = view.range.start;
  var end = view.range.end;
  try {
    if (g === 'day') {
      var dayParts = String(start).slice(0, 10).split('-').map(Number);
      var d = new Date(Date.UTC(dayParts[0], dayParts[1] - 1, dayParts[2], 12, 0, 0));
      return d.toLocaleDateString(financeRedesignLocaleTag(), {
        weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
      });
    }
    if (g === 'week') return financeRedesignFormatIsoRange(start, end);
    if (g === 'year') return String(start).slice(0, 4);
    if (g === 'custom') return financeRedesignFormatIsoRange(start, end);
    var m = new Date(start + 'T12:00:00');
    return m.toLocaleDateString(financeRedesignLocaleTag(), {
      month: 'long', year: 'numeric',
    });
  } catch (_e) {
    return start && end && end !== start
      ? financeRedesignFormatIsoRange(start, end)
      : financeRedesignFormatIsoDate(start);
  }
}

function financeRedesignCustomDisplay(view) {
  var start = view && view.range ? String(view.range.start || '') : '';
  var end = view && view.range ? String(view.range.end || '') : '';
  if (!(view && view.granularity === 'custom' && start && end)) {
    return financeRedesignT('admin.finance.gran.custom', 'Custom');
  }
  return financeRedesignFormatIsoRange(start, end);
}

function financeRedesignTrendTitle(trendMode, useBooked) {
  return trendMode === 'year'
    ? (useBooked
      ? financeRedesignT('admin.finance.monthlyBookedTrend', 'Monthly booked sales vs last year')
      : financeRedesignT('admin.finance.monthlyGrossTrend', 'Monthly gross vs last year'))
    : financeRedesignT('admin.finance.dailyGrossTrend', 'Daily gross vs last year');
}

function financeRedesignMonthLabel(idx) {
  try {
    var d = new Date(2020, idx, 1);
    var loc = typeof portalLang === 'string' ? portalLang : (typeof getStaffLocale === 'function' ? getStaffLocale() : 'en');
    return d.toLocaleDateString(loc, { month: 'short' });
  } catch (_e) {
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][idx] || '';
  }
}

function financeRedesignBarRow(name, cents, pct, colorClass) {
  var amountKnown = cents != null && Number.isFinite(Number(cents));
  var shareKnown = pct != null && Number.isFinite(Number(pct));
  var rawPct = shareKnown ? Number(pct) : null;
  var w = shareKnown ? Math.max(0, Math.min(100, rawPct)) : 0;
  return '<div class="pfb-bar-row">' +
    '<span class="pfb-bar-name">' + financeRedesignEsc(name) + '</span>' +
    '<span class="pfb-bar-track"><span class="pfb-bar-fill ' + colorClass + '" style="width:' + w + '%"></span></span>' +
    '<span class="pfb-bar-amt">' + (amountKnown ? financeRedesignMoneyHtml(cents) : '—') + '</span>' +
    '<span class="pfb-bar-pct">' + (shareKnown ? financeRedesignEsc(String(rawPct % 1 ? rawPct.toFixed(1) : rawPct) + '%') : financeRedesignEsc(financeRedesignT('admin.finance.shareUnknown', 'share unknown'))) + '</span>' +
    '</div>';
}

function financeRedesignUtilRow(name, pct, detail, colorClass) {
  var known = pct != null && Number.isFinite(Number(pct));
  var rawPct = known ? Number(pct) : null;
  // Visual fill clamps at 100%; label stays truthful when over capacity.
  var w = rawPct != null ? Math.max(0, Math.min(100, rawPct)) : 0;
  var over = rawPct != null && rawPct > 100;
  var val = rawPct != null
    ? financeRedesignEsc(String(Math.round(rawPct)) + '%')
    : financeRedesignEsc(detail || '—');
  var fillCls = (colorClass || '') + (over ? ' is-over' : '');
  return '<div class="pfb-util-row' + (over ? ' is-over' : '') + '">' +
    '<span class="pfb-util-name">' + financeRedesignEsc(name) + '</span>' +
    '<span class="pfb-util-track"><span class="pfb-util-fill ' + fillCls + '" style="width:' + (known ? w : 0) + '%"></span></span>' +
    '<span class="pfb-util-val">' + val + '</span>' +
    '</div>';
}

function financeRedesignCapacityDetail(detail) {
  var raw = String(detail == null ? '' : detail).trim();
  var match = raw.match(/^([\d.,\s]+)\s*\/\s*([\d.,\s]+)$/);
  if (!match) return raw || '\u2014';
  var template = financeRedesignT('admin.finance.capacityCount', '{used} of {capacity}');
  return template.replace('{used}', match[1]).replace('{capacity}', match[2]);
}

function financeRedesignTrendHtml(trend, mode, opts) {
  var rows = Array.isArray(trend) ? trend : [];
  if (!rows.length) {
    return '<div class="pfb-trend-empty" data-finance-trend-empty="1">' + financeRedesignEsc(financeRedesignT('admin.finance.empty', 'No activity in this period.')) + '</div>';
  }
  // Year period + 12-month chart: paint Staff API BSR dues so bars reconcile to Booked.
  var useBooked = !!(opts && opts.useBooked);
  var max = 1;
  rows.forEach(function (r) {
    if (useBooked) {
      max = Math.max(max, Number(r.booked_cents) || 0, Number(r.ly_booked_cents) || 0);
    } else {
      max = Math.max(max, Number(r.collected_gross_cents) || 0, Number(r.ly_collected_gross_cents) || 0);
    }
  });
  var isYear = mode === 'year' || mode === 'months' || mode === '12m';
  var axis = '<div class="pfb-trend-axis" aria-label="' + financeRedesignEsc(financeRedesignT('admin.finance.eurAxis', 'EUR scale')) + '">' +
    '<span class="pfb-trend-tick is-max">' + financeRedesignEsc(financeRedesignFmtEur(max)) + '</span>' +
    '<span class="pfb-trend-tick is-mid">' + financeRedesignEsc(financeRedesignFmtEur(Math.round(max / 2))) + '</span>' +
    '<span class="pfb-trend-tick is-zero">' + financeRedesignEsc(financeRedesignFmtEur(0)) + '</span></div>';
  var legend = '<div class="pfb-trend-legend"><span class="pfb-series-key is-current">' + financeRedesignEsc(financeRedesignT('admin.finance.currentSeries', 'Current period')) + '</span><span class="pfb-series-key is-prior">' + financeRedesignEsc(financeRedesignT('admin.finance.priorYearSeries', 'Same period last year')) + '</span></div>';
  if (isYear) {
    var htmlMonthly = '<div class="pfb-trend pfb-trend--monthly" data-finance-trend-mode="year"' +
      (useBooked ? ' data-finance-trend-basis="booked"' : ' data-finance-trend-basis="collected"') +
      ' role="img" aria-label="' +
      financeRedesignEsc(financeRedesignTrendTitle('year', useBooked)) + '">';
    rows.forEach(function (r, idx) {
      var cur = Math.max(0, Number(useBooked ? r.booked_cents : r.collected_gross_cents) || 0);
      var ly = Math.max(0, Number(useBooked ? r.ly_booked_cents : r.ly_collected_gross_cents) || 0);
      var hCur = Math.round((100 * cur) / max);
      var hLy = Math.round((100 * ly) / max);
      var monthNum = Number(r.month);
      var monthLabel = financeRedesignMonthLabel(((monthNum >= 1 && monthNum <= 12) ? monthNum : (idx + 1)) - 1);
      var monthDetail = monthLabel + ': ' + financeRedesignT('admin.finance.currentSeries', 'Current period') + ' ' + financeRedesignFmtEurExact(cur) + ', ' + financeRedesignT('admin.finance.priorYearSeries', 'Same period last year') + ' ' + financeRedesignFmtEurExact(ly);
      htmlMonthly += '<div class="pfb-trend-day pfb-trend-day--month" title="' +
        financeRedesignEsc(monthLabel + ' · ' + financeRedesignFmtEurExact(cur) + ' · LY ' + financeRedesignFmtEurExact(ly)) + '">' +
        '<div class="pfb-trend-col">' +
        '<span class="pfb-trend-prev" style="height:' + hLy + '%"></span>' +
        '<span class="pfb-trend-cur" style="height:' + hCur + '%"></span>' +
        '</div>' +
        '<div class="pfb-trend-d">' + financeRedesignEsc(monthLabel) + '</div><span class="pfb-trend-sr">' + financeRedesignEsc(monthDetail) + '</span>' +
        '</div>';
    });
    htmlMonthly += '</div>';
    htmlMonthly += axis + legend;
    return htmlMonthly;
  }
  var html = '<div class="pfb-trend" data-finance-trend-mode="days" role="img" aria-label="' +
    financeRedesignEsc(financeRedesignTrendTitle('days')) + '">';
  rows.forEach(function (r) {
    var cur = Math.max(0, Number(r.collected_gross_cents) || 0);
    var ly = Math.max(0, Number(r.ly_collected_gross_cents) || 0);
    var hCur = Math.round((100 * cur) / max);
    var hLy = Math.round((100 * ly) / max);
    var lab = String(r.date || '').slice(8, 10);
    if (lab.charAt(0) === '0') lab = lab.slice(1);
    var dayDetail = String(r.date || '') + ': ' + financeRedesignT('admin.finance.currentSeries', 'Current period') + ' ' + financeRedesignFmtEurExact(cur) + ', ' + financeRedesignT('admin.finance.priorYearSeries', 'Same period last year') + ' ' + financeRedesignFmtEurExact(ly);
    html += '<div class="pfb-trend-day" title="' + financeRedesignEsc(dayDetail) + '">' +
      '<div class="pfb-trend-col">' +
      '<span class="pfb-trend-prev" style="height:' + hLy + '%"></span>' +
      '<span class="pfb-trend-cur" style="height:' + hCur + '%"></span>' +
      '</div>' +
      '<div class="pfb-trend-d">' + financeRedesignEsc(lab || '') + '</div><span class="pfb-trend-sr">' + financeRedesignEsc(dayDetail) + '</span>' +
      '</div>';
  });
  html += '</div>';
  html += axis + legend;
  return html;
}

/**
 * Render Option B Finance redesign from server summary.redesign (+ fallbacks).
 * @param {object} summary
 * @returns {string} HTML
 */
function renderFinanceRedesignHtml(summary) {
  if (!summary || !summary.redesign) {
    return '<div class="portal-admin-finance-unavailable"><p>' +
      financeRedesignEsc(financeRedesignT('admin.finance.summaryUnavailable', 'Finance summary is not available.')) +
      '</p></div>';
  }
  var R = summary.redesign;
  var view = R.view || {};
  var net = R.net || {};
  var pipe = R.pipeline || {};
  var out = R.outstanding || {};
  var cap = R.capacity || {};
  var products = Array.isArray(R.revenue_by_product) ? R.revenue_by_product : [];
  var lunaBookings = R.luna_bookings || { total_bookings: 0, by_service: [] };
  var g = view.granularity || 'month';

  var title = financeRedesignTitle(view);
  var html = '';
  html += '<style>#wh-admin-finance-body .portal-admin-finance,#wh-admin-finance-body .pfb-card,#wh-admin-finance-body .pfb-two,#wh-admin-finance-body .pfb-bars{min-width:0;max-width:100%;box-sizing:border-box}' +
    '#wh-admin-finance-body .pfb-card{justify-content:flex-start;min-height:0;overflow:visible}' +
    '#wh-admin-finance-body .pfb-booking-context{color:var(--text-2);font-size:13px;line-height:1.4;padding:2px 4px}' +
    '#wh-admin-finance-body .pfb-bar-name{width:auto;max-width:none;white-space:normal;overflow:visible;text-overflow:clip}' +
    '#wh-admin-finance-body .pfb-sr,#wh-admin-finance-body .pfb-trend-sr{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}' +
    '#wh-admin-finance-body .pfb-card--trend{position:relative;padding-left:76px}' +
    '#wh-admin-finance-body .pfb-trend-axis{position:absolute;left:12px;top:62px;bottom:50px;width:58px;font-size:10px;color:var(--text-2)}' +
    '#wh-admin-finance-body .pfb-trend-tick{position:absolute;right:0}#wh-admin-finance-body .pfb-trend-tick.is-max{top:0}#wh-admin-finance-body .pfb-trend-tick.is-mid{top:50%;transform:translateY(-50%)}#wh-admin-finance-body .pfb-trend-tick.is-zero{bottom:0}' +
    '#wh-admin-finance-body .pfb-trend-legend{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:10px}' +
    '#wh-admin-finance-body .pfb-series-key{display:inline-flex;align-items:center;gap:6px}#wh-admin-finance-body .pfb-series-key:before{content:\"\";width:10px;height:10px;border-radius:2px;background:var(--green)}#wh-admin-finance-body .pfb-series-key.is-prior:before{background:var(--tan)}' +
    '#wh-admin-finance-body .pfb-today{appearance:none;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text);font:inherit;font-weight:600;padding:7px 11px;cursor:pointer}#wh-admin-finance-body .pfb-today:focus-visible{outline:2px solid var(--green);outline-offset:2px}' +
    '@media(max-width:640px){#wh-admin-finance-body .pfb-bar-row{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:\"name amount\" \"track share\"}' +
    '#wh-admin-finance-body .pfb-bar-name{grid-area:name}#wh-admin-finance-body .pfb-bar-amt{grid-area:amount}' +
    '#wh-admin-finance-body .pfb-bar-track{grid-area:track}#wh-admin-finance-body .pfb-bar-pct{grid-area:share}#wh-admin-finance-body .pfb-card--trend{padding-left:62px}}' +
    '</style>';
  html += '<div class="portal-admin-finance portal-admin-finance--b" data-finance-redesign="1"' +
    ' data-finance-view-gran="' + financeRedesignEsc(g) + '"' +
    ' data-finance-range-start="' + financeRedesignEsc(view.range && view.range.start ? view.range.start : '') + '"' +
    ' data-finance-range-end="' + financeRedesignEsc(view.range && view.range.end ? view.range.end : '') + '">';

  // Navigator
  html += '<div class="pfb-nav">';
  html += '<div class="pfb-nav-left">';
  html += '<div class="pfb-range" role="group" aria-label="Period">';
  html += '<button type="button" class="pfb-arw" data-finance-nav="prev" aria-label="' +
    financeRedesignEsc(financeRedesignT('schedule.nav.prev', 'Previous')) + '">‹</button>';
  html += '<span class="pfb-range-label" data-finance-range-label="1">' + financeRedesignEsc(title) + '</span>';
  html += '<button type="button" class="pfb-arw" data-finance-nav="next" aria-label="' +
    financeRedesignEsc(financeRedesignT('schedule.nav.next', 'Next')) + '">›</button>';
  html += '<button type="button" class="pfb-today" data-finance-nav="today">' +
    financeRedesignEsc(financeRedesignT('schedule.today', 'Today')) + '</button>';
  html += '</div></div>';
  html += '<div class="pfb-gran" role="tablist" aria-label="Granularity">';
  [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year'], ['custom', 'Custom']].forEach(function (row) {
    var key = row[0]; var lab = row[1];
    var on = g === key ? ' is-on' : '';
    html += '<button type="button" role="tab" class="pfb-gran-btn' + on + '" data-finance-gran="' + key + '"' +
      (key === 'custom' ? ' id="pfb-custom-range-trigger" aria-haspopup="dialog" aria-expanded="false" aria-controls="pfb-custom-range-pop"' : '') +
      ' aria-selected="' + (g === key ? 'true' : 'false') + '">' +
      financeRedesignEsc(financeRedesignT('admin.finance.gran.' + key, lab)) + '</button>';
  });
  html += '<div class="pfb-custom-wrap">';
  html += '<div id="pfb-custom-range-pop" class="portal-schedule-create-date-range-popover pfb-custom-popover" role="dialog" aria-modal="false" aria-labelledby="pfb-custom-month-label" hidden style="display:none">';
  html += '<div class="pfb-custom-head pfb-cal-head">';
  html += '<button type="button" id="pfb-custom-prev" data-pfb-cal="prev" aria-label="' +
    financeRedesignEsc(financeRedesignT('schedule.create.dateRange.prevMonth', 'Previous month')) + '">&#8249;</button>';
  html += '<span id="pfb-custom-month-label" class="portal-schedule-create-date-range-month" aria-live="polite"></span>';
  html += '<button type="button" id="pfb-custom-next" data-pfb-cal="next" aria-label="' +
    financeRedesignEsc(financeRedesignT('schedule.create.dateRange.nextMonth', 'Next month')) + '">&#8250;</button>';
  html += '</div>';
  html += '<div id="pfb-custom-grid" class="portal-schedule-create-date-range-grid pfb-cal-grid" role="group" aria-labelledby="pfb-custom-month-label"></div>';
  html += '<div class="portal-schedule-create-date-range-actions">';
  html += '<button type="button" class="btn btn-ghost" id="pfb-custom-clear" data-pfb-cal="clear">' +
    financeRedesignEsc(financeRedesignT('calendar.create.clearSelection', 'Clear Selection')) + '</button>';
  html += '<button type="button" class="btn btn-primary" id="pfb-custom-close" data-pfb-cal="close">' +
    financeRedesignEsc(financeRedesignT('schedule.drawer.close', 'Close')) + '</button>';
  html += '</div></div>';
  html += '<input id="pfb-custom-start" type="date" class="portal-schedule-create-date-hidden" tabindex="-1" aria-hidden="true" hidden value="' +
    financeRedesignEsc(g === 'custom' && view.range ? (view.range.start || '') : '') + '">';
  html += '<input id="pfb-custom-end" type="date" class="portal-schedule-create-date-hidden" tabindex="-1" aria-hidden="true" hidden value="' +
    financeRedesignEsc(g === 'custom' && view.range ? (view.range.end || '') : '') + '">';
  html += '</div>';
  html += '</div></div>';

  // Hero cards
  html += '<div class="pfb-hero">';

  // Net
  html += '<div class="pfb-card pfb-card--hero">';
  html += '<div class="pfb-card-top">';
  html += '<div class="pfb-lbl">' + financeRedesignEsc(financeRedesignT('admin.finance.netCollected', 'Net collected')) + '</div>';
  var netUnavailable = net.status === 'unavailable' || net.net_collected_cents == null;
  var netCents = Number(net.net_collected_cents);
  var netBigCls = netUnavailable ? 'pfb-big pfb-big--neutral' : (netCents < 0 ? 'pfb-big pfb-big--amber' : 'pfb-big pfb-big--green');
  html += '<div class="' + netBigCls + '">' + (netUnavailable
    ? '—'
    : financeRedesignMoneyHtml(netCents)) + '</div>';
  html += '<div class="pfb-row"><span>' + financeRedesignEsc(financeRedesignT('admin.finance.grossCollected', 'Gross collected')) +
    '</span><b>' + financeRedesignMoneyHtml(net.gross_collected_cents != null ? net.gross_collected_cents : 0) + '</b></div>';
  html += '<div class="pfb-row"><span>' + financeRedesignEsc(financeRedesignT('admin.finance.refunds', 'Refunds')) +
    '</span><b class="pfb-muted">' + (netUnavailable
      ? financeRedesignEsc(financeRedesignT('admin.finance.unavailable', 'Unavailable'))
      : financeRedesignMoneyHtml(net.completed_refunds_cents != null ? net.completed_refunds_cents : 0)) + '</b></div>';
  // Pending cancellation proxy retired in Slice 2 — do not render.
  html += '<div class="pfb-note">' + financeRedesignEsc(financeRedesignT('admin.finance.netNote',
    'Net = gross collected − recorded refunds in this period (effective date). Manual records only — not Stripe.')) + '</div>';
  if (netUnavailable && net.unavailable_reason) {
    var reasonKey = net.unavailable_reason === 'refund_source_unreadable' ? 'admin.finance.refundSourceUnavailable' : 'admin.finance.unavailable';
    html += '<div class="pfb-note" data-finance-unavailable-reason="' + financeRedesignEsc(net.unavailable_reason) + '">' + financeRedesignEsc(financeRedesignT(reasonKey, 'Refund data is unavailable.')) + '</div>';
  }
  html += '</div>';
  html += '<div class="pfb-deltas">' +
    '<span class="pfb-delta-wrap"><span class="pfb-delta-lab">' + financeRedesignEsc(financeRedesignT('admin.finance.vsPrior', 'vs last period')) +
    '</span> ' + financeRedesignDeltaChip(net.vs_prior_pct) + '</span>' +
    '<span class="pfb-delta-wrap"><span class="pfb-delta-lab">' + financeRedesignEsc(financeRedesignT('admin.finance.vsYoy', 'vs last year')) +
    '</span> ' + financeRedesignDeltaChip(net.vs_yoy_pct) + '</span>' +
    '</div></div>';

  // Pipeline
  html += '<div class="pfb-card pfb-card--hero">';
  html += '<div class="pfb-card-top">';
  html += '<div class="pfb-lbl">' + financeRedesignEsc(financeRedesignT('admin.finance.bookedSales', 'Booked sales')) + '</div>';
  html += '<div class="pfb-mid">' + financeRedesignEsc(financeRedesignFmtEur(pipe.booked_cents || 0)) + '</div>';
  html += '<div class="pfb-cmp">' + financeRedesignEsc(String(pipe.bookings_count || 0) + ' ' +
    financeRedesignT('admin.finance.bookings', 'bookings'));
  if (pipe.avg_booking_cents != null) {
    html += ' · ' + financeRedesignT('admin.finance.avg', 'avg') + ' ' + financeRedesignFmtEur(pipe.avg_booking_cents);
  }
  html += '</div></div>';
  html += '<div class="pfb-card-bot">';
  html += '<div class="pfb-row"><span>' + financeRedesignEsc(financeRedesignT('admin.finance.next30', 'Next 30 days')) +
    '</span><b>' + financeRedesignEsc(financeRedesignFmtEur(pipe.next_30_days_cents || 0)) + '</b></div>';
  html += '<div class="pfb-row"><span>' + financeRedesignEsc(financeRedesignT('admin.finance.deliveredUnpaid', 'Delivered, unpaid')) +
    '</span><b>' + financeRedesignEsc(financeRedesignFmtEur(pipe.delivered_unpaid_cents || 0)) + '</b></div>';
  html += '<div class="pfb-deltas">' +
    '<span class="pfb-delta-wrap"><span class="pfb-delta-lab">' + financeRedesignEsc(financeRedesignT('admin.finance.vsPrior', 'vs last period')) + '</span> ' + financeRedesignDeltaChip(pipe.vs_prior_pct) + '</span>' +
    '<span class="pfb-delta-wrap"><span class="pfb-delta-lab">' + financeRedesignEsc(financeRedesignT('admin.finance.vsYoy', 'vs last year')) + '</span> ' + financeRedesignDeltaChip(pipe.vs_yoy_pct) + '</span>' +
    '</div></div></div>';

  // Outstanding
  html += '<div class="pfb-card pfb-card--hero">';
  html += '<div class="pfb-card-top">';
  html += '<div class="pfb-lbl">' + financeRedesignEsc(financeRedesignT('admin.finance.balanceStillDue', 'Balance still due')) + '</div>';
  html += '<div class="pfb-mid pfb-mid--amber">' + financeRedesignEsc(financeRedesignFmtEur(out.outstanding_cents || 0)) + '</div>';
  html += '<div class="pfb-cmp">' + financeRedesignEsc(financeRedesignT('admin.finance.acrossBookings', 'across') + ' ' +
    String(out.bookings_count || 0) + ' ' + financeRedesignT('admin.finance.bookings', 'bookings')) + '</div>';
  html += '</div>';
  html += '<div class="pfb-card-bot">';
  html += '<div class="pfb-age"><span>' + financeRedesignEsc(financeRedesignT('admin.finance.dueDatesNotRecorded', 'Due dates not recorded')) + '</span></div>';
  html += '<div class="pfb-note">' + financeRedesignEsc(financeRedesignT('admin.finance.dateBasis', 'Current balance for selected cohort; contractual due dates unavailable.')) + '</div>';
  html += '<div class="pfb-scope-note" data-finance-kpi-scope="1" style="margin-top:8px;font-size:12px;line-height:1.35;opacity:0.78">' +
    financeRedesignEsc(financeRedesignT('admin.finance.kpiScopeNote',
      'Net uses paid cash in this period (excludes deleted-booking payments). Outstanding excludes cancelled, expired, and hold bookings — same Staff ledger rules as Bookings KPIs.')) +
    '</div>';
  html += '</div></div>';

  html += '</div>'; // hero

  html += '<div class="pfb-booking-context" data-finance-luna-bookings="1"><strong>' + financeRedesignEsc(financeRedesignT('admin.finance.lunaBookings', 'Luna-created')) + ':</strong> ' + financeRedesignEsc(String(lunaBookings.total_bookings || 0));
  if (Number(lunaBookings.staff_count) > 0) {
    html += ' · <span>' + financeRedesignEsc(String(lunaBookings.staff_count) + ' ' + financeRedesignT('admin.finance.staffCreated', 'Staff-created')) + '</span>';
  }
  if (Number(lunaBookings.unknown_origin_count) > 0) {
    html += ' · <span>' + financeRedesignEsc(String(lunaBookings.unknown_origin_count) + ' ' +
      financeRedesignT('admin.finance.originUnknown', 'bookings with unknown origin')) + '</span>';
  }
  html += '</div>';

  // Two-col: product + capacity
  html += '<div class="pfb-two">';
  html += '<div class="pfb-card pfb-card--bars">';
  html += '<div class="pfb-sec">' + financeRedesignEsc(financeRedesignT('admin.finance.bookedSalesByProduct', 'Booked sales by product')) + '</div>';
  html += '<div class="pfb-bars pfb-bars--compact">';
  var colorCycle = ['is-green', 'is-blue', 'is-violet', 'is-amber'];
  var colorMap = { lessons: 'is-green', course_included: 'is-blue', boards: 'is-blue', wetsuits: 'is-violet', other: 'is-amber' };
  products.forEach(function (p, idx) {
    var centsKnown = !!p && p.cents != null && Number.isFinite(Number(p.cents));
    var cents = centsKnown ? Number(p.cents) : null;
    var rawLab = p && p.label != null ? String(p.label) : '';
    var isPlaceholder = !rawLab || rawLab === '\u2014' || rawLab === '—' || p.key === 'item_1' || p.key === 'item_2';
    if (centsKnown && cents === 0 && isPlaceholder) return;
    var cls = colorMap[p.key] || colorMap[p.slot] || colorCycle[idx % colorCycle.length] || 'is-green';
    var lab = p.label || '\u2014';
    if (/staff\s*accommodation/i.test(lab)) lab = financeRedesignT('admin.finance.product.accommodation', 'Accommodation');
    if (p.slot === 'lessons' || p.key === 'lessons') {
      lab = financeRedesignT('admin.finance.product.lessons', 'Lessons');
    } else if (p.slot === 'course_included' || p.key === 'course_included') {
      lab = p.label && p.label !== 'Course equipment' && !/^\u2014$/.test(p.label)
        ? p.label
        : financeRedesignT('admin.finance.product.courseIncluded', 'Course equipment');
    } else if (p.slot === 'other' || p.key === 'other') {
      lab = financeRedesignT('admin.finance.product.other', 'Other');
    } else if (p.slot === 'accommodation' || p.key === 'pkg:none') {
      lab = financeRedesignT('admin.finance.product.accommodation', 'Accommodation');
    } else if (p.key === 'services') {
      lab = financeRedesignT('admin.finance.product.services', 'Services');
    } else if (p.key === 'camps') {
      lab = financeRedesignT('admin.finance.product.camps', 'Camps');
    }
    html += financeRedesignBarRow(lab, p.cents, p.pct, cls);
    (Array.isArray(p.details) ? p.details : []).forEach(function (detail) {
      html += '<div class="pfb-note pfb-product-detail">' + financeRedesignEsc(detail.label || detail.key || '—') +
        ' · ' + financeRedesignEsc(financeRedesignFmtEur(detail.cents || 0)) + '</div>';
    });
  });
  html += '</div>';
  html += '</div>';

  html += '<div class="pfb-card pfb-card--bars pfb-card--capacity">';
  html += '<div class="pfb-sec">' + financeRedesignEsc(financeRedesignT('admin.finance.bedOccupancy', 'Bed occupancy')) + '</div>';
  html += '<div class="pfb-cap-top">';
  var seatsPct = cap.metric === 'bed_occupancy' ? (cap.pct != null ? cap.pct : cap.observed_pct) : cap.seats_pct;
  var seatsPctKnown = seatsPct != null && Number.isFinite(Number(seatsPct));
  var seatsPctNum = seatsPctKnown ? Number(seatsPct) : null;
  // Ring fill clamps at 100% so overflow never paints a clipped/broken conic arc.
  var ringPct = seatsPctNum != null
    ? Math.max(0, Math.min(100, Math.round(seatsPctNum)))
    : 0;
  var ringOver = seatsPctNum != null && seatsPctNum > 100;
  html += '<div class="pfb-ring' + (ringOver ? ' is-over' : '') + '" data-finance-cap-ring="1"' +
    (ringOver ? ' data-capacity-over="1"' : '') +
    ' style="--pfb-ring:' + ringPct + '%" aria-hidden="true">' +
    '<div class="pfb-ring-in"><b>' +
    (seatsPctNum != null
      ? financeRedesignEsc(String(seatsPctNum % 1 ? seatsPctNum.toFixed(1) : seatsPctNum) + '%')
      : '\u2014') +
    '</b><span>' + financeRedesignEsc(cap.metric === 'bed_occupancy' ? financeRedesignT('admin.finance.bedNights', 'bed-nights') : financeRedesignT('admin.finance.lessonSeats', 'lesson seats')) + '</span></div></div>';
  html += '<div class="pfb-bars pfb-bars--compact pfb-bars--capacity">';
  var capRows = cap.metric === 'bed_occupancy'
    ? [{ slot: 'beds', label: financeRedesignT('admin.finance.occupiedBeds', 'Occupied / sellable bed-nights'), pct: cap.pct != null ? cap.pct : cap.observed_pct, detail: (cap.occupied_bed_nights != null && cap.sellable_bed_nights != null) ? (Number(cap.occupied_bed_nights).toLocaleString(financeRedesignLocaleTag()) + '/' + Number(cap.sellable_bed_nights).toLocaleString(financeRedesignLocaleTag())) : financeRedesignT('admin.finance.unavailable', 'Unavailable') }]
    : Array.isArray(cap.by_product) && cap.by_product.length
    ? cap.by_product
    : [
        { slot: 'lessons', label: financeRedesignT('admin.finance.product.lessons', 'Lessons'), pct: cap.seats_pct,
          detail: (cap.seats_filled != null && cap.seats_capacity != null) ? (cap.seats_filled + '/' + cap.seats_capacity) : '\u2014' },
      ];
  var colorCycle2 = ['is-green', 'is-blue', 'is-violet', 'is-amber'];
  capRows.forEach(function (row, idx) {
    var cls = colorCycle2[idx % colorCycle2.length];
    var lab = row.label || '\u2014';
    if (row.slot === 'lessons') lab = financeRedesignT('admin.finance.product.lessons', 'Lessons');
    if (/staff\s*accommodation/i.test(lab)) lab = financeRedesignT('admin.finance.product.accommodation', 'Accommodation');
    var pct = row.pct;
    var rawPct = (pct != null && Number.isFinite(Number(pct))) ? Number(pct) : null;
    // Track fill clamps at 100%; label/detail stay truthful (e.g. 132/100 · 132%).
    var w = rawPct != null ? Math.max(0, Math.min(100, rawPct)) : 0;
    var over = rawPct != null && rawPct > 100;
    var detail = row.detail != null ? String(row.detail) : '\u2014';
    if ((!detail || detail === '\u2014') && row.used != null) {
      detail = String(row.used);
    }
    var pctLabel = rawPct != null ? (String(rawPct % 1 ? rawPct.toFixed(1) : rawPct) + '%') : '';
    var fillCls = cls + (over ? ' is-over' : '');
    html += '<div class="pfb-bar-row pfb-bar-row--util' + (over ? ' is-over' : '') + '"' +
      (over ? ' data-capacity-over="1"' : '') + '>';
    html += '<span class="pfb-bar-name">' + financeRedesignEsc(lab) + '</span>';
    html += '<span class="pfb-bar-track"><span class="pfb-bar-fill ' + fillCls + '" style="width:' + w + '%"></span></span>';
    var capacityDetail = financeRedesignCapacityDetail(detail);
    html += '<span class="pfb-bar-amt" aria-label="' + financeRedesignEsc(capacityDetail) + '">' + financeRedesignEsc(capacityDetail) + '</span>';
    html += '<span class="pfb-bar-pct">' + financeRedesignEsc(pctLabel) + '</span>';
    html += '</div>';
  });
  html += '</div></div>'; // bars + cap-top
  if (cap.metric === 'bed_occupancy' && cap.pct == null && cap.observed_pct != null) {
    html += '<div class="pfb-note pfb-note--provisional">' + financeRedesignEsc(financeRedesignT('admin.finance.provisionalOccupancy', 'Provisional — based on current sellable beds; historical availability incomplete')) + '</div>';
  }
  if (cap.metric === 'bed_occupancy' && cap.exception_count != null) {
    html += '<div class="pfb-note pfb-note--exceptions">' + financeRedesignEsc(financeRedesignT('admin.finance.assignmentExceptions', '{n} assignment exceptions').replace('{n}', String(cap.exception_count))) + '</div>';
  }
  if (cap.unsold_seats != null) {
    var spotsN = String(cap.unsold_seats);
    var spotsCopy = g === 'year'
      ? financeRedesignT('admin.finance.spotsAvailableYear', '{n} spots available this year').replace('{n}', spotsN)
      : (g === 'day'
        ? financeRedesignT('admin.finance.spotsAvailableToday', '{n} spots available today').replace('{n}', spotsN)
        : financeRedesignT('admin.finance.spotsAvailableMonth', '{n} spots available this month').replace('{n}', spotsN));
    html += '<div class="pfb-callout pfb-callout--spots" style="justify-content:flex-end;text-align:right">';
    html += '<span>' + financeRedesignEsc(spotsCopy) + '</span>';
    html += '</div>';
  }
  html += '</div></div>'; // two

  // Gross trend — Days vs 12-month. Live wire: 12-month adopts Year period + refetch
  // so KPIs match the year window (P2). Renderer still accepts any period + chart mode.
  var rawTrend = (typeof window !== 'undefined' && window.__financeTrendMode) ? String(window.__financeTrendMode) : '';
  if (g === 'year') rawTrend = 'year';
  if (!rawTrend) rawTrend = 'days';
  var trendMode = (rawTrend === 'year' || rawTrend === 'months' || rawTrend === '12m') ? 'year' : 'days';
  var trendRows = trendMode === 'year'
    ? (Array.isArray(R.monthly_gross_trend) ? R.monthly_gross_trend : [])
    : (Array.isArray(R.daily_gross_trend) ? R.daily_gross_trend : []);
  html += '<div class="pfb-card pfb-card--trend" data-finance-trend-card="1">';
  html += '<div class="pfb-sec-row">';
  var trendUsesBooked = g === 'year' && trendMode === 'year';
  html += '<div class="pfb-sec">' + financeRedesignEsc(financeRedesignTrendTitle(trendMode, trendUsesBooked)) + '</div>';
  html += '<div class="pfb-trend-toggle" role="tablist" aria-label="Trend chart range">';
  html += '<button type="button" class="pfb-trend-btn' + (trendMode === 'days' ? ' is-on' : '') + '" data-finance-trend="days" role="tab" aria-selected="' + (trendMode === 'days' ? 'true' : 'false') + '">' +
    financeRedesignEsc(financeRedesignT('admin.finance.trend.monthDays', 'Days')) + '</button>';
  html += '<button type="button" class="pfb-trend-btn' + (trendMode === 'year' ? ' is-on' : '') + '" data-finance-trend="year" role="tab" aria-selected="' + (trendMode === 'year' ? 'true' : 'false') + '">' +
    financeRedesignEsc(financeRedesignT('admin.finance.trend.yearMonths', '12 months')) + '</button>';
  html += '</div></div>';
  html += financeRedesignTrendHtml(trendRows, trendMode, { useBooked: trendUsesBooked });
  html += '</div>';

  html += '</div>'; // root
  return html;
}

// Node offline fixture path
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    renderFinanceRedesignHtml: renderFinanceRedesignHtml,
    financeRedesignFmtEur: financeRedesignFmtEur,
    financeRedesignTitle: financeRedesignTitle,
    financeRedesignCustomDisplay: financeRedesignCustomDisplay,
    financeRedesignFormatIsoDate: financeRedesignFormatIsoDate,
    financeRedesignFormatIsoRange: financeRedesignFormatIsoRange,
  };
}
