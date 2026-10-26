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
    return new Intl.NumberFormat(financeRedesignLocaleTag(), {
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
    return new Intl.NumberFormat(financeRedesignLocaleTag(), {
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
    if (typeof getStaffLocale === 'function') loc = String(getStaffLocale() || 'en');
    else if (typeof portalLang === 'string' && portalLang) loc = portalLang;
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

function financeRedesignFormatDateTime(value) {
  var raw = String(value || '');
  if (!raw) return '';
  try {
    var d = new Date(raw);
    if (!Number.isFinite(d.getTime())) return financeRedesignFormatIsoDate(raw);
    return d.toLocaleString(financeRedesignLocaleTag(), {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      timeZone: 'Europe/Madrid',
    });
  } catch (_e) {
    return financeRedesignFormatIsoDate(raw);
  }
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
    htmlMonthly = '<div class="pfb-trend-plot pfb-trend-plot--monthly">' + axis + htmlMonthly + '</div>';
    htmlMonthly += legend;
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
  html = '<div class="pfb-trend-plot">' + axis + html + '</div>';
  html += legend;
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
  html += '<style>:is(#admin-finance-body,#wh-admin-finance-body) .portal-admin-finance,:is(#admin-finance-body,#wh-admin-finance-body) .pfb-card,:is(#admin-finance-body,#wh-admin-finance-body) .pfb-two,:is(#admin-finance-body,#wh-admin-finance-body) .pfb-bars{min-width:0;max-width:100%;box-sizing:border-box}' +
    ':is(#admin-finance-body,#wh-admin-finance-body) .pfb-card{justify-content:flex-start;min-height:0;overflow:visible}' +
    ':is(#admin-finance-body,#wh-admin-finance-body) .pfb-booking-context{color:var(--text-2);font-size:13px;line-height:1.4;padding:2px 4px}' +
    ':is(#admin-finance-body,#wh-admin-finance-body) .pfb-bar-name{width:auto;max-width:none;white-space:normal;overflow:visible;text-overflow:clip}' +
    ':is(#admin-finance-body,#wh-admin-finance-body) .pfb-sr,:is(#admin-finance-body,#wh-admin-finance-body) .pfb-trend-sr{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;clip-path:inset(50%)!important;white-space:nowrap!important;border:0!important}' +
    ':is(#admin-finance-body,#wh-admin-finance-body) .pfb-card--trend{position:relative}' +
    ':is(#admin-finance-body,#wh-admin-finance-body) .pfb-trend-plot{display:grid;grid-template-columns:58px minmax(0,1fr);column-gap:6px;align-items:start}' +
    ':is(#admin-finance-body,#wh-admin-finance-body) .pfb-trend-axis{position:relative;height:88px;margin-top:13px;width:58px;font-size:10px;color:var(--text-2)}:is(#admin-finance-body,#wh-admin-finance-body) .pfb-trend-plot--monthly .pfb-trend-axis{height:132px;margin-top:17px}' +
    ':is(#admin-finance-body,#wh-admin-finance-body) .pfb-trend-tick{position:absolute;right:0}:is(#admin-finance-body,#wh-admin-finance-body) .pfb-trend-tick.is-max{top:0}:is(#admin-finance-body,#wh-admin-finance-body) .pfb-trend-tick.is-mid{top:50%;transform:translateY(-50%)}:is(#admin-finance-body,#wh-admin-finance-body) .pfb-trend-tick.is-zero{bottom:0}:is(#admin-finance-body,#wh-admin-finance-body) .pfb-trend-plot--monthly .pfb-trend-tick.is-zero{bottom:-10px}' +
    ':is(#admin-finance-body,#wh-admin-finance-body) .pfb-trend-legend{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:10px}' +
    ':is(#admin-finance-body,#wh-admin-finance-body) .pfb-series-key{display:inline-flex;align-items:center;gap:6px}:is(#admin-finance-body,#wh-admin-finance-body) .pfb-series-key:before{content:\"\";width:10px;height:10px;border-radius:2px}:is(#admin-finance-body,#wh-admin-finance-body) .pfb-series-key.is-current:before{background:#3d8f5a}:is(#admin-finance-body,#wh-admin-finance-body) .pfb-series-key.is-prior:before{background:rgba(74,124,148,.55)}[data-theme="dark"] :is(#admin-finance-body,#wh-admin-finance-body) .pfb-series-key.is-current:before{background:#6fbf88}[data-theme="dark"] :is(#admin-finance-body,#wh-admin-finance-body) .pfb-series-key.is-prior:before{background:rgba(158,224,168,.45)}' +
    ':is(#admin-finance-body,#wh-admin-finance-body) .pfb-today{appearance:none;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text);font:inherit;font-weight:600;padding:7px 11px;cursor:pointer}:is(#admin-finance-body,#wh-admin-finance-body) .pfb-today:focus-visible{outline:2px solid var(--green);outline-offset:2px}' +
    '@media(max-width:640px){#wh-admin-finance-body .pfb-bar-row{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:\"name amount\" \"track share\"}' +
    '#wh-admin-finance-body .pfb-bar-name{grid-area:name}#wh-admin-finance-body .pfb-bar-amt{grid-area:amount}' +
    '#wh-admin-finance-body .pfb-bar-track{grid-area:track}#wh-admin-finance-body .pfb-bar-pct{grid-area:share}#wh-admin-finance-body .pfb-trend-plot{grid-template-columns:48px minmax(0,1fr);column-gap:4px}#wh-admin-finance-body .pfb-trend-axis{width:48px}}' +
    '@media(max-width:640px){#admin-finance-body .pfb-bar-row{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:\"name amount\" \"track share\"}' +
    '#admin-finance-body .pfb-bar-name{grid-area:name}#admin-finance-body .pfb-bar-amt{grid-area:amount}' +
    '#admin-finance-body .pfb-bar-track{grid-area:track}#admin-finance-body .pfb-bar-pct{grid-area:share}#admin-finance-body .pfb-trend-plot{grid-template-columns:48px minmax(0,1fr);column-gap:4px}#admin-finance-body .pfb-trend-axis{width:48px}}' +
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
    financeRedesignEsc(financeRedesignT('admin.finance.today', 'Today')) + '</button>';
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
  html += '<div class="pfb-mid">' + financeRedesignMoneyHtml(pipe.booked_cents) + '</div>';
  html += '<div class="pfb-cmp">' + financeRedesignEsc(String(pipe.bookings_count || 0) + ' ' +
    financeRedesignT('admin.finance.bookings', 'bookings'));
  if (pipe.avg_booking_cents != null) {
    html += ' · ' + financeRedesignEsc(financeRedesignT('admin.finance.avg', 'avg')) + ' ' + financeRedesignMoneyHtml(pipe.avg_booking_cents);
  }
  html += '</div></div>';
  html += '<div class="pfb-card-bot">';
  html += '<div class="pfb-row"><span>' + financeRedesignEsc(financeRedesignT('admin.finance.next30', 'Next 30 days')) +
    '</span><b>' + financeRedesignMoneyHtml(pipe.next_30_days_cents) + '</b></div>';
  html += '<div class="pfb-row"><span>' + financeRedesignEsc(financeRedesignT('admin.finance.deliveredUnpaid', 'Delivered, unpaid')) +
    '</span><b>' + financeRedesignMoneyHtml(pipe.delivered_unpaid_cents) + '</b></div>';
  html += '<div class="pfb-deltas">' +
    '<span class="pfb-delta-wrap"><span class="pfb-delta-lab">' + financeRedesignEsc(financeRedesignT('admin.finance.vsPrior', 'vs last period')) + '</span> ' + financeRedesignDeltaChip(pipe.vs_prior_pct) + '</span>' +
    '<span class="pfb-delta-wrap"><span class="pfb-delta-lab">' + financeRedesignEsc(financeRedesignT('admin.finance.vsYoy', 'vs last year')) + '</span> ' + financeRedesignDeltaChip(pipe.vs_yoy_pct) + '</span>' +
    '</div></div></div>';

  // Outstanding
  html += '<div class="pfb-card pfb-card--hero">';
  html += '<div class="pfb-card-top">';
  html += '<div class="pfb-lbl">' + financeRedesignEsc(financeRedesignT('admin.finance.balanceStillDue', 'Balance still due')) + '</div>';
  html += '<div class="pfb-mid pfb-mid--amber">' + financeRedesignMoneyHtml(out.outstanding_cents) + '</div>';
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
    } else if (p.key === 'unclassified') {
      lab = financeRedesignT('admin.finance.product.unclassified', 'Unclassified adjustment / data incomplete');
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

var WH_FIN_VERSION = 'wolfhouse.creator-finance.v1';
var WH_FIN_CREATORS = ['luna', 'staff', 'other_imported', 'unattributed', 'total'];

function whFinProjection(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  if (envelope.schema_version) return envelope;
  return envelope.wolfhouse_creator_finance || null;
}

function whFinMoney(cents, currency) {
  if (cents == null || cents === '') return null;
  var n = Number(cents);
  if (!Number.isFinite(n)) return null;
  var code = String(currency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  try {
    return new Intl.NumberFormat(financeRedesignLocaleTag(), {
      style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(n / 100);
  } catch (_e) {
    return null;
  }
}

function whFinMoneyHtml(cents, currency) {
  var text = whFinMoney(cents, currency);
  if (text == null) {
    return '<span class="wh-fin-unknown" data-wh-fin-value="unknown">' +
      financeRedesignEsc(financeRedesignT('admin.finance.wh.unknown', 'Not available')) + '</span>';
  }
  return '<span class="wh-fin-amt" data-wh-fin-cents="' + financeRedesignEsc(String(cents)) + '">' +
    financeRedesignEsc(text) + '</span>';
}

function whFinMetric(metrics, key) {
  var m = metrics && metrics[key];
  return m && typeof m === 'object' ? m : null;
}

function whFinCreatorRow(creators, key) {
  var rows = Array.isArray(creators) ? creators : [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].creator === key) return rows[i];
  }
  return null;
}

function whFinReasons(metric) {
  var codes = metric && Array.isArray(metric.reason_codes) ? metric.reason_codes : [];
  if (!codes.length) return '';
  var labels = {
    malformed_money: ['admin.finance.wh.reason.malformed_money', 'A payment amount could not be read.'],
    unsafe_integer: ['admin.finance.wh.reason.unsafe_integer', 'A number was too large to report safely.'],
    unknown_currency: ['admin.finance.wh.reason.unknown_currency', 'An unknown currency was excluded.'],
    mixed_currency: ['admin.finance.wh.reason.mixed_currency', 'Another currency was excluded.'],
    creator_unresolved: ['admin.finance.wh.reason.creator_unresolved', 'The booking creator could not be resolved.'],
    refund_ledger_unavailable: ['admin.finance.wh.reason.refund_ledger_unavailable', 'Refund records could not be read.'],
    refund_row_unreadable: ['admin.finance.wh.reason.refund_row_unreadable', 'A refund row could not be read.'],
    payment_identity_missing: ['admin.finance.wh.reason.payment_identity_missing', 'A payment had no stable identity.'],
    creation_date_missing: ['admin.finance.wh.reason.creation_date_missing', 'A booking had no creation date.'],
    saved_total_unreadable: ['admin.finance.wh.reason.saved_total_unreadable', 'A saved total could not be read.'],
    balance_reconciliation_unavailable: ['admin.finance.wh.reason.balance_reconciliation_unavailable', 'The balance could not be reconciled.'],
    stale_generation: ['admin.finance.wh.reason.stale_generation', 'These figures are from an older refresh.'],
  };
  return '<ul class="wh-fin-reasons">' + codes.map(function (code) {
    var spec = labels[code] || ['admin.finance.wh.reason.other', code];
    return '<li data-wh-fin-reason="' + financeRedesignEsc(code) + '">' +
      financeRedesignEsc(financeRedesignT(spec[0], spec[1])) + '</li>';
  }).join('') + '</ul>';
}

function whFinPeriodNotices(codes) {
  var unique = Array.from(new Set(Array.isArray(codes) ? codes.filter(Boolean) : []));
  if (!unique.length) return '';
  var details = {
    refund_ledger_unavailable: ['admin.finance.wh.notice.refund_ledger_unavailable', 'Recorded refunds and refund-adjusted totals are unavailable; gross receipts remain verified.'],
    unknown_currency: ['admin.finance.wh.notice.unknown_currency', 'Rows without an authoritative currency are excluded from currency-specific totals.'],
    mixed_currency: ['admin.finance.wh.notice.mixed_currency', 'Rows in another currency are excluded from EUR totals.'],
    malformed_money: ['admin.finance.wh.notice.malformed_money', 'Rows with unreadable money amounts are excluded from affected totals.'],
    unsafe_integer: ['admin.finance.wh.notice.unsafe_integer', 'Rows containing amounts too large to report safely are excluded from affected totals.'],
    non_integer_or_unsafe: ['admin.finance.wh.notice.non_integer_or_unsafe', 'Rows containing non-whole or unsafe amounts are excluded from affected totals.'],
    creator_unresolved: ['admin.finance.wh.notice.creator_unresolved', 'Bookings whose creator could not be resolved are excluded from creator-specific totals.'],
    payment_identity_missing: ['admin.finance.wh.notice.payment_identity_missing', 'Payments without a stable identity are excluded to prevent duplicate counting.'],
    conflicting_payment_identity: ['admin.finance.wh.notice.conflicting_payment_identity', 'Payments with conflicting identities are excluded to prevent duplicate counting.'],
    receipt_date_missing: ['admin.finance.wh.notice.receipt_date_missing', 'Payments without a receipt date are excluded from period totals.'],
    creation_date_missing: ['admin.finance.wh.notice.creation_date_missing', 'Bookings without a creation date are excluded from creation-period totals.'],
    saved_total_unreadable: ['admin.finance.wh.notice.saved_total_unreadable', 'Bookings with unreadable saved totals are excluded from booking-value totals.'],
    balance_reconciliation_unavailable: ['admin.finance.wh.notice.balance_reconciliation_unavailable', 'Outstanding balances could not be fully reconciled, so affected totals remain unavailable.'],
    incomplete_inputs_malformed_bsr: ['admin.finance.wh.notice.incomplete_inputs_malformed_bsr', 'Some balances could not be reconciled because required saved inputs were unreadable.'],
    balance_drift: ['admin.finance.wh.notice.balance_drift', 'Some saved balances differ from their component amounts, so affected outstanding totals are reported as partial.'],
    material_balance_drift: ['admin.finance.wh.notice.material_balance_drift', 'Some saved balances differ from their component amounts and are reported as reconciliation exceptions.'],
    conflicting_refund_identity: ['admin.finance.wh.notice.conflicting_refund_identity', 'Refund records with conflicting identities are excluded to prevent duplicate adjustment of receipts.'],
    refund_row_unreadable: ['admin.finance.wh.notice.refund_row_unreadable', 'Unreadable refund rows are excluded and refund-adjusted totals remain partial.'],
    refund_source_unreadable: ['admin.finance.wh.notice.refund_source_unreadable', 'Refund rows with an unreadable source are excluded and refund-adjusted totals remain partial.'],
    stale_generation: ['admin.finance.wh.notice.stale_generation', 'These figures are from an older completed refresh.'],
  };
  return '<section class="wh-fin-panel wh-fin-period-notices" data-wh-fin-period-notices="1" role="note"><h3>' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.periodNotices', 'Period data notes')) + '</h3><ul class="wh-fin-reasons">' +
    unique.map(function (code) {
      var spec = details[code] || ['admin.finance.wh.notice.other', 'An unclassified data-quality issue affects this period; review the warning details.'];
      return '<li data-wh-fin-reason="' + financeRedesignEsc(code) + '">' +
        financeRedesignEsc(financeRedesignT(spec[0], spec[1])) + '</li>';
    }).join('') + '</ul></section>';
}

function whFinStateLabel(state) {
  if (state === 'complete') return financeRedesignT('admin.finance.wh.state.complete', 'Complete');
  if (state === 'partial') return financeRedesignT('admin.finance.wh.state.partial', 'Partial');
  if (state === 'unavailable') return financeRedesignT('admin.finance.wh.state.unavailable', 'Unavailable');
  return financeRedesignT('admin.finance.wh.state.missing', 'Missing');
}

function whFinMetricHtml(metric, currency, opts) {
  opts = opts || {};
  if (!metric) {
    return '<p class="wh-fin-status" data-wh-fin-state="missing">' +
      financeRedesignEsc(whFinStateLabel('missing')) + '</p>';
  }
  var state = String(metric.state || '');
  var valueKey = opts.count ? 'count' : 'amount_cents';
  var raw = metric[valueKey];
  var body;
  if (state === 'unavailable' || raw == null) {
    body = '<span class="wh-fin-unknown" data-wh-fin-value="unknown">' +
      financeRedesignEsc(financeRedesignT('admin.finance.wh.unknown', 'Not available')) + '</span>';
  } else if (opts.count) {
    body = '<span class="wh-fin-count" data-wh-fin-count="' + financeRedesignEsc(String(raw)) + '">' +
      financeRedesignEsc(String(raw)) + '</span>';
  } else {
    body = whFinMoneyHtml(raw, currency);
  }
  var zeroNote = '';
  if (opts.receipts && !opts.count && state === 'complete' && Number(raw) === 0) {
    zeroNote = '<p class="wh-fin-zero">' + financeRedesignEsc(financeRedesignT('admin.finance.wh.noPayments', 'No payments in this period.')) + '</p>';
  }
  var partialNote = state === 'partial'
    ? '<p class="wh-fin-partial">' + financeRedesignEsc(financeRedesignT('admin.finance.wh.partialNote', 'Verified subtotal only. Not a complete split.')) + '</p>'
    : '';
  return body + '<p class="wh-fin-status" data-wh-fin-state="' + financeRedesignEsc(state || 'missing') + '">' +
    financeRedesignEsc(whFinStateLabel(state)) + '</p>' + zeroNote + partialNote;
}


function whFinCreatorLabel(key) {
  var labels = {
    luna: 'Luna-created',
    staff: 'Staff-created',
    other_imported: 'Other / imported',
    unattributed: 'Unattributed',
    total: 'Total',
  };
  return financeRedesignT('admin.finance.wh.creator.' + key, labels[key] || key);
}

function whFinFieldLabel(field) {
  var labels = {
    payment_id: ['admin.finance.wh.field.paymentId', 'Payment'],
    booking_id: ['admin.finance.wh.field.bookingId', 'Booking'],
    receipt_date: ['admin.finance.wh.field.receiptDate', 'Receipt date'],
    amount_cents: ['admin.finance.wh.field.amount', 'Amount'],
    purpose: ['admin.finance.wh.field.purpose', 'Purpose'],
    creator: ['admin.finance.wh.creatorLabel', 'Creator'],
    created_date: ['admin.finance.wh.field.createdDate', 'Created'],
    current_saved_total_cents: ['admin.finance.wh.field.savedTotal', 'Saved total'],
    current_balance_cents: ['admin.finance.wh.field.balance', 'Balance'],
    as_of: ['admin.finance.wh.field.asOf', 'As of'],
    refund_id: ['admin.finance.wh.field.refundId', 'Refund'],
    effective_date: ['admin.finance.wh.field.effectiveDate', 'Effective date'],
    row_id: ['admin.finance.wh.field.rowId', 'Row'],
    product_code: ['admin.finance.wh.field.productCode', 'Product code'],
    product_label: ['admin.finance.wh.field.productLabel', 'Product'],
    service_date: ['admin.finance.wh.field.serviceDate', 'Service date'],
    quantity: ['admin.finance.wh.field.quantity', 'Quantity'],
    component: ['admin.finance.wh.component', 'Component'],
    reason_code: ['admin.finance.wh.field.reason', 'Reason'],
    service_record_id: ['admin.finance.wh.field.serviceRecord', 'Service record'],
    check_in: ['admin.finance.wh.checkIn', 'Check-in'],
    check_out: ['admin.finance.wh.checkOut', 'Check-out'],
  };
  var spec = labels[field] || ['admin.finance.wh.field.' + field, field];
  return financeRedesignT(spec[0], spec[1]);
}

function whFinTrendPartialNote(bucket) {
  if (!bucket || bucket.state !== 'partial') return '';
  return '<p class="wh-fin-trend-note" data-wh-fin-trend-note="partial" role="note">' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.trendPartial', 'This period is partial.')) +
    '</p>' + whFinReasons({ reason_codes: bucket.reason_codes || [] });
}

function whFinAcceptedDetail(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  var proj = envelope.schema_version ? envelope : null;
  if (!proj && envelope.wolfhouse_creator_finance && envelope.wolfhouse_creator_finance.schema_version) {
    proj = envelope.wolfhouse_creator_finance;
  }
  if (!proj || proj.schema_version !== WH_FIN_VERSION) return null;
  if (!proj.detail || typeof proj.detail !== 'object' || proj.detail.kind == null) return null;
  return proj;
}

function whFinCanOpen(proj, kind) {
  var queries = proj && proj.detail_queries;
  return !!(queries && queries[kind] === true);
}

function whFinShare(bps) {
  if (bps == null || bps === '') return '';
  var n = Number(bps);
  if (!Number.isFinite(n)) return '';
  var text = (n / 100).toFixed(2) + '%';
  return '<span class="wh-fin-share" data-wh-fin-share-bps="' + financeRedesignEsc(String(n)) + '">' +
    financeRedesignEsc(text) + '</span>';
}

function whFinOpenButton(label, amountHtml, attrs) {
  attrs = attrs || {};
  var open = attrs['data-wh-fin-open'];
  var headline = attrs['data-wh-fin-headline'];
  var tag = open ? 'button' : 'div';
  var cls = 'wh-fin-card' + (headline ? ' wh-fin-headline wh-fin-headline--' + headline : '');
  var extra = '';
  Object.keys(attrs).forEach(function (key) {
    if (attrs[key] == null || attrs[key] === '') return;
    extra += ' ' + key + '="' + financeRedesignEsc(attrs[key]) + '"';
  });
  return '<' + tag + (tag === 'button' ? ' type="button"' : '') + ' class="' + cls + '"' + extra + '>' +
    '<span class="wh-fin-kicker">' + financeRedesignEsc(label) + '</span>' + amountHtml + '</' + tag + '>';
}

function whFinStyles() {
  return '<style>' +
    '#wh-admin-finance-body .wh-fin{color:var(--text);max-width:100%;min-width:0}' +
    '#wh-admin-finance-body .wh-fin-card,#wh-admin-finance-body .wh-fin-panel{background:var(--surface);color:var(--text);border:1px solid var(--border,#D2D2D7);border-radius:8px;padding:12px;min-width:0;text-align:left}#wh-admin-finance-body .wh-fin-card{display:flex;flex-direction:column;align-items:flex-start;gap:4px}#wh-admin-finance-body .wh-fin-kicker,#wh-admin-finance-body .wh-fin-amt{display:block;max-width:100%}' +
    '#wh-admin-finance-body .wh-fin-headlines{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin:8px 0 12px}' +
    '#wh-admin-finance-body .wh-fin-headline{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-height:128px}' +
    '#wh-admin-finance-body .wh-fin-headline--luna{border-top:4px solid var(--finance-bar-green,#1B4D3E)}' +
    '#wh-admin-finance-body .wh-fin-headline--staff{border-top:4px solid var(--text)}' +
    '#wh-admin-finance-body .wh-fin-kicker{font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}' +
    '#wh-admin-finance-body .wh-fin-hero{margin:4px 0 0;font-size:15px;font-weight:700}' +
    '#wh-admin-finance-body .wh-fin-secondary,#wh-admin-finance-body .wh-fin-also{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:12px}' +
    '#wh-admin-finance-body .wh-fin-amt{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;max-width:100%}' +
    '#wh-admin-finance-body .wh-fin-headline .wh-fin-amt{font-size:40px;line-height:1.05}' +
    '#wh-admin-finance-body .wh-fin button:focus-visible{outline:2px solid var(--finance-bar-green,#1B4D3E);outline-offset:2px}' +
    '#wh-admin-finance-body .wh-fin-table-wrap{max-width:100%;overflow-x:auto}' +
    '#wh-admin-finance-body .wh-fin-table{width:100%;border-collapse:collapse}' +
    '#wh-admin-finance-body .wh-fin-table th,#wh-admin-finance-body .wh-fin-table td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--border,#D2D2D7);white-space:nowrap}' +
    '#wh-admin-finance-body .wh-fin-chart-row{display:grid;grid-template-columns:minmax(6.5em,auto) minmax(0,1fr);gap:8px;align-items:center;margin:2px 0;width:100%}' +
    '#wh-admin-finance-body .wh-fin-bar{display:block;height:8px;min-height:8px;justify-self:start;background:var(--finance-bar-green,#1B4D3E);border-radius:4px;max-width:100%}' +
    '#wh-admin-finance-body .wh-fin-trend-note{display:block;margin:4px 0;color:var(--text);font-size:13px}' +
    '@media(max-width:640px){#wh-admin-finance-body .wh-fin-headlines,#wh-admin-finance-body .wh-fin-secondary,#wh-admin-finance-body .wh-fin-also{grid-template-columns:minmax(0,1fr)}#wh-admin-finance-body .wh-fin-headline .wh-fin-amt{font-size:32px}}' +
    '@media(prefers-reduced-motion:reduce){#wh-admin-finance-body .wh-fin *{transition:none!important;animation:none!important}}' +
    '</style>';
}

var WH_FIN_DETAIL_TOTALS = {
  payments: [
    ['gross_receipts_cents', 'admin.finance.wh.receipts', 'Receipts', 'money'],
    ['deposits_received_cents', 'admin.finance.wh.deposits', 'Deposits received', 'money'],
  ],
  bookings: [
    ['new_booking_count', 'admin.finance.wh.newBookingCount', 'New bookings', 'count'],
    ['new_booking_value_cents', 'admin.finance.wh.newBookingValue', 'New booking value', 'money'],
  ],
  outstanding: [
    ['outstanding_cents', 'admin.finance.wh.outstanding', 'Still to collect today', 'money'],
  ],
  refunds: [
    ['recorded_refunds_cents', 'admin.finance.wh.refunds', 'Recorded refunds', 'money'],
  ],
  products: [
    ['product_amount_cents', 'admin.finance.wh.products', 'Products', 'money'],
    ['row_count', 'admin.finance.wh.rowCount', 'Rows', 'count'],
  ],
  warnings: [
    ['row_count', 'admin.finance.wh.rowCount', 'Rows', 'count'],
  ],
  arrival: [
    ['row_count', 'admin.finance.wh.rowCount', 'Rows', 'count'],
  ],
};

var WH_FIN_ROW_FIELDS = {
  payments: ['payment_id', 'booking_id', 'receipt_date', 'amount_cents', 'purpose', 'creator'],
  bookings: ['booking_id', 'created_date', 'current_saved_total_cents', 'creator'],
  outstanding: ['booking_id', 'current_balance_cents', 'as_of', 'creator'],
  refunds: ['refund_id', 'booking_id', 'effective_date', 'amount_cents', 'creator'],
  products: ['row_id', 'booking_id', 'product_code', 'product_label', 'service_date', 'quantity', 'amount_cents', 'creator'],
  warnings: ['row_id', 'component', 'reason_code', 'booking_id', 'payment_id', 'refund_id', 'service_record_id'],
  arrival: ['booking_id', 'check_in', 'check_out', 'current_saved_total_cents', 'creator'],
};

var WH_FIN_MONEY_FIELDS = {
  amount_cents: 1,
  current_saved_total_cents: 1,
  current_balance_cents: 1,
};

function renderWolfhouseCreatorFinanceHtml(envelope) {
  var proj = whFinProjection(envelope);
  if (!proj || proj.schema_version !== WH_FIN_VERSION) {
    var unsupported = proj && proj.schema_version;
    return '<section class="wh-fin" data-wh-finance="missing" data-wh-fin-state="' +
      (unsupported ? 'unsupported' : 'missing') + '" role="status"><h2>' +
      financeRedesignEsc(financeRedesignT('admin.finance.wh.title', 'Finance · Wolfhouse')) + '</h2><p>' +
      financeRedesignEsc(financeRedesignT(unsupported ? 'admin.finance.wh.unsupported' : 'admin.finance.wh.missingProjection',
        unsupported ? 'This finance version is not supported.' : 'The Wolfhouse finance projection is not available.')) +
      '</p></section>';
  }
  var scope = proj.scope || {};
  var range = scope.range || {};
  var currency = scope.currency;
  var metrics = proj.metrics || {};
  var g = range.granularity || 'month';
  var receiptBasis = financeRedesignT('admin.finance.wh.receiptBasis', 'Receipts by payment date. Creator means who created the booking.');
  var html = whFinStyles();
  html += '<section class="wh-fin" data-wh-finance="' + financeRedesignEsc(WH_FIN_VERSION) + '"' +
    ' data-wh-fin-cohort="' + financeRedesignEsc(proj.cohort_id || '') + '"' +
    ' data-wh-fin-currency="' + financeRedesignEsc(currency || '') + '"' +
    ' data-wh-fin-client="' + financeRedesignEsc(scope.client || '') + '">';
  html += '<h2>' + financeRedesignEsc(financeRedesignT('admin.finance.wh.title', 'Finance · Wolfhouse')) + '</h2>';
  html += '<h3 class="wh-fin-hero">' + financeRedesignEsc(financeRedesignT('admin.finance.wh.moneyReceived', 'Money received')) + '</h3>';
  html += '<div class="wh-fin-headlines" role="group" aria-label="' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.moneyReceived', 'Money received')) + '">';
  ['luna', 'staff'].forEach(function (key) {
    var row = whFinCreatorRow(proj.creators, key);
    var attrs = { 'data-wh-fin-headline': key };
    if (whFinCanOpen(proj, 'payments')) {
      attrs['data-wh-fin-open'] = 'payments';
      attrs['data-wh-fin-creator'] = key;
    }
    var amount = whFinMetricHtml(row && row.gross_receipts, currency, { receipts: true }) + whFinShare(row && row.receipt_share_bps);
    html += whFinOpenButton(
      whFinCreatorLabel(key),
      amount + '<p class="wh-fin-basis">' + financeRedesignEsc(receiptBasis) + '</p>',
      attrs
    );
  });
  html += '</div>';
  html += '<div class="pfb-nav"><button type="button" class="pfb-today" data-finance-nav="today">' +
    financeRedesignEsc(financeRedesignT('admin.finance.today', 'Today')) + '</button>';
  html += '<div class="pfb-gran" role="tablist" aria-label="' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.period', 'Period')) + '">';
  [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year'], ['custom', 'Custom']].forEach(function (row) {
    var on = g === row[0];
    html += '<button type="button" role="tab" class="pfb-gran-btn' + (on ? ' is-on' : '') + '" data-finance-gran="' + row[0] + '"' +
      (row[0] === 'custom' ? ' id="pfb-custom-range-trigger" aria-haspopup="dialog" aria-expanded="false" aria-controls="pfb-custom-range-pop"' : '') +
      ' aria-selected="' + (on ? 'true' : 'false') + '">' +
      financeRedesignEsc(financeRedesignT('admin.finance.gran.' + row[0], row[1])) + '</button>';
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
    financeRedesignEsc(g === 'custom' ? (range.start || '') : '') + '">';
  html += '<input id="pfb-custom-end" type="date" class="portal-schedule-create-date-hidden" tabindex="-1" aria-hidden="true" hidden value="' +
    financeRedesignEsc(g === 'custom' ? (range.end || '') : '') + '">';
  html += '</div></div></div>';
  html += '<p data-wh-fin-freshness="1">' + financeRedesignEsc(financeRedesignT('admin.finance.wh.updated', 'Last update')) +
    ' <time datetime="' + financeRedesignEsc(proj.as_of || proj.generated_at || '') + '">' +
    financeRedesignEsc(financeRedesignFormatDateTime(proj.as_of || proj.generated_at || '')) + '</time></p>';
  html += '<p data-wh-fin-range="1">' + financeRedesignEsc(scope.timezone || '') + ' ' +
    financeRedesignEsc(financeRedesignFormatIsoRange(range.start, range.end)) +
    (currency ? ' · ' + financeRedesignEsc(currency) : '') + '</p>';
  html += whFinPeriodNotices(proj.warnings);

  html += '<div class="wh-fin-also">';
  ['other_imported', 'unattributed', 'total'].forEach(function (key) {
    var row = whFinCreatorRow(proj.creators, key);
    var attrs = { 'data-wh-fin-also': key };
    if (whFinCanOpen(proj, 'payments') && key !== 'total') attrs['data-wh-fin-creator'] = key;
    if (whFinCanOpen(proj, 'payments')) attrs['data-wh-fin-open'] = 'payments';
    html += whFinOpenButton(
      whFinCreatorLabel(key),
      whFinMetricHtml(row && row.gross_receipts, currency, { receipts: true }) + whFinShare(row && row.receipt_share_bps),
      attrs
    );
  });
  html += '</div>';

  var total = whFinCreatorRow(proj.creators, 'total') || {};
  html += '<div class="wh-fin-secondary">';
  var bookingAttrs = { 'data-wh-fin-secondary': 'new-booking-value' };
  if (whFinCanOpen(proj, 'bookings')) bookingAttrs['data-wh-fin-open'] = 'bookings';
  html += whFinOpenButton(
    financeRedesignT('admin.finance.wh.newBookingValue', 'New booking value'),
    whFinMetricHtml(total.new_booking_value || whFinMetric(metrics, 'new_booking_value'), currency) +
      whFinMetricHtml(total.new_booking_count || whFinMetric(metrics, 'new_booking_count'), currency, { count: true }) +
      '<p class="wh-fin-basis">' + financeRedesignEsc(financeRedesignT('admin.finance.wh.createdBasis', 'By creation date. Current saved totals.')) + '</p>',
    bookingAttrs
  );
  html += '<div class="wh-fin-panel" data-wh-fin-secondary="deposits"><p class="wh-fin-card-label">' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.deposits', 'Deposits received')) + '</p>' +
    whFinMetricHtml(whFinMetric(metrics, 'deposits_received'), currency, { receipts: true }) +
    '<p class="wh-fin-basis">' + financeRedesignEsc(financeRedesignT('admin.finance.wh.depositsIncluded', 'Already included in receipts above.')) + '</p></div>';
  var outstanding = whFinMetric(metrics, 'outstanding_today');
  var outstandingAttrs = { 'data-wh-fin-secondary': 'outstanding' };
  if (whFinCanOpen(proj, 'outstanding')) outstandingAttrs['data-wh-fin-open'] = 'outstanding';
  var outstandingAsOf = outstanding && outstanding.as_of
    ? '<time data-wh-fin-outstanding-as-of="1" datetime="' + financeRedesignEsc(outstanding.as_of) + '">' + financeRedesignEsc(financeRedesignFormatDateTime(outstanding.as_of)) + '</time>'
    : '';
  html += whFinOpenButton(
    financeRedesignT('admin.finance.wh.outstanding', 'Still to collect today'),
    whFinMetricHtml(outstanding, currency) + outstandingAsOf +
      '<p class="wh-fin-basis">' + financeRedesignEsc(financeRedesignT('admin.finance.wh.outstandingBasis', 'As of today, across active bookings. Not limited to this period.')) + '</p>',
    outstandingAttrs
  );
  html += '</div>';

  var trend = Array.isArray(proj.trend) ? proj.trend : [];
  var max = 0;
  var trendPartial = false;
  trend.forEach(function (bucket) {
    var n = Number(bucket && bucket.gross_receipts_cents);
    if (Number.isFinite(n) && n > max) max = n;
    if (bucket && bucket.state === 'partial') trendPartial = true;
  });
  var trendLabel = financeRedesignT('admin.finance.wh.trend', 'Receipts over time');
  if (trendPartial) {
    trendLabel += '. ' + financeRedesignT('admin.finance.wh.trendPartialSummary', 'Some periods are partial.');
  }
  html += '<div class="wh-fin-panel" data-wh-fin-trend="1"><h3>' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.trend', 'Receipts over time')) + '</h3>';
  if (trendPartial) {
    html += '<p class="wh-fin-trend-note" data-wh-fin-trend-partial="1" role="note">' +
      financeRedesignEsc(financeRedesignT('admin.finance.wh.trendPartialSummary', 'Some periods are partial. See period data notes.')) +
      '</p>';
  }
  html += '<div class="wh-fin-chart" role="img" aria-label="' + financeRedesignEsc(trendLabel) + '">';
  trend.forEach(function (bucket) {
    var n = bucket ? bucket.gross_receipts_cents : null;
    var width = (max > 0 && n != null && Number.isFinite(Number(n))) ? Math.round((100 * Number(n)) / max) : 0;
    var state = bucket && bucket.state || '';
    html += '<div class="wh-fin-chart-row" data-wh-fin-trend-state="' + financeRedesignEsc(state) + '"><span>' +
      financeRedesignEsc(financeRedesignFormatIsoDate(bucket && bucket.date || '')) + '</span>' +
      (n == null ? '<span class="wh-fin-unknown">—</span>' : '<span class="wh-fin-bar" style="width:' + width + '%"></span>') +
      '</div>';

  });
  html += '</div><div class="wh-fin-table-wrap"><table class="wh-fin-table"><caption>' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.trendTable', 'Receipts over time, table')) +
    '</caption><thead><tr><th>' + financeRedesignEsc(financeRedesignT('admin.finance.wh.date', 'Date')) + '</th><th>' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.receipts', 'Receipts')) + '</th><th>' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.refunds', 'Refunds')) + '</th><th>' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.net', 'Refund-adjusted')) + '</th><th>' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.field.status', 'Status')) + '</th></tr></thead><tbody>';
  trend.forEach(function (bucket) {
    var state = bucket && bucket.state || '';
    html += '<tr data-wh-fin-trend-state="' + financeRedesignEsc(state) + '"><td>' +
      financeRedesignEsc(financeRedesignFormatIsoDate(bucket && bucket.date || '')) + '</td><td>' + whFinMoneyHtml(bucket && bucket.gross_receipts_cents, currency) +
      '</td><td>' + whFinMoneyHtml(bucket && bucket.recorded_refunds_cents, currency) + '</td><td>' +
      whFinMoneyHtml(bucket && bucket.net_receipts_cents, currency) + '</td><td>' +
      financeRedesignEsc(whFinStateLabel(state)) +
      '</td></tr>';
  });
  html += '</tbody></table></div></div>';

  html += '<div class="wh-fin-panel" data-wh-fin-comparison="1"><h3>' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.comparison', 'Creator comparison')) + '</h3><div class="wh-fin-table-wrap"><table class="wh-fin-table"><thead><tr><th>' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.creatorLabel', 'Creator')) + '</th><th>' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.receipts', 'Receipts')) + '</th><th>' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.deposits', 'Deposits received')) + '</th><th>' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.newBookingCount', 'New bookings')) + '</th><th>' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.newBookingValue', 'New booking value')) + '</th></tr></thead><tbody>';
  WH_FIN_CREATORS.forEach(function (key) {
    var row = whFinCreatorRow(proj.creators, key) || {};
    html += '<tr data-wh-fin-creator-row="' + key + '"><th scope="row">' +
      financeRedesignEsc(whFinCreatorLabel(key)) + ' ' + whFinShare(row.receipt_share_bps) +
      '</th><td>' + whFinMetricHtml(row.gross_receipts, currency, { receipts: true }) + '</td><td>' +
      whFinMetricHtml(row.deposits_received, currency, { receipts: true }) + '</td><td data-wh-fin-booking-count="1">' +
      whFinMetricHtml(row.new_booking_count, currency, { count: true }) + '</td><td>' +
      whFinMetricHtml(row.new_booking_value, currency) + '</td></tr>';
  });
  html += '</tbody></table></div></div>';

  var refundAttrs = {};
  if (whFinCanOpen(proj, 'refunds')) refundAttrs['data-wh-fin-open'] = 'refunds';
  html += '<div class="wh-fin-panel" data-wh-fin-refunds="1"><h3>' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.refunds', 'Recorded refunds')) + '</h3>' +
    whFinOpenButton(financeRedesignT('admin.finance.wh.refunds', 'Recorded refunds'),
      whFinMetricHtml(whFinMetric(metrics, 'recorded_refunds'), currency),
      refundAttrs) +
    '<p class="wh-fin-card-label">' + financeRedesignEsc(financeRedesignT('admin.finance.wh.net', 'Refund-adjusted')) + '</p>' +
    whFinMetricHtml(whFinMetric(metrics, 'net_receipts'), currency) + '</div>';

  var productAttrs = {};
  if (whFinCanOpen(proj, 'products')) productAttrs['data-wh-fin-open'] = 'products';
  html += whFinOpenButton(financeRedesignT('admin.finance.wh.products', 'Products'),
    '<p class="wh-fin-basis">' + financeRedesignEsc(financeRedesignT('admin.finance.wh.productsNote', 'Opens the server product rows. No total is calculated here.')) + '</p>',
    productAttrs);

  var warningCodes = Array.isArray(proj.warnings)
    ? proj.warnings.filter(function (code) { return typeof code === 'string' && code; })
    : [];
  var warningAttrs = { 'data-wh-fin-warnings': '1' };
  if (whFinCanOpen(proj, 'warnings')) warningAttrs['data-wh-fin-open'] = 'warnings';
  html += whFinOpenButton(
    financeRedesignT('admin.finance.wh.warnings', 'Data-quality warnings'),
    '<p class="wh-fin-basis">' + financeRedesignEsc(financeRedesignT('admin.finance.wh.warningsBasis', 'See the period data notes above.')) + '</p>',
    warningAttrs
  );

  var arrival = proj.arrival_date_report && typeof proj.arrival_date_report === 'object' ? proj.arrival_date_report : {};
  var arrivalBasis = typeof arrival.date_basis === 'string' ? arrival.date_basis : '';
  html += '<section class="wh-fin-panel" data-wh-fin-arrival="1"><h3>' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.arrival', 'Booking value by arrival date')) + '</h3>';
  if (arrivalBasis) {
    html += '<p class="wh-fin-basis" data-wh-fin-date-basis="' + financeRedesignEsc(arrivalBasis) + '">';
    html += financeRedesignEsc(arrivalBasis === 'arrival_or_service_date'
      ? financeRedesignT('admin.finance.wh.arrivalBasis', 'By arrival or service date. Not newly created bookings.')
      : arrivalBasis);
    html += '</p>';
  }
  if (whFinCanOpen(proj, 'arrival')) {
    html += '<button type="button" data-wh-fin-open="arrival">' +
      financeRedesignEsc(financeRedesignT('admin.finance.wh.arrival', 'Booking value by arrival date')) + '</button>';
  }
  html += '</section>';
  html += '<div data-wh-fin-detail="1"></div></section>';
  return html;
}

function renderWolfhouseCreatorFinanceDetailHtml(detailEnvelope, opts) {
  var accepted = whFinAcceptedDetail(detailEnvelope);
  if (!accepted) {
    return '<div class="wh-fin-detail" data-wh-fin-detail-state="unsupported" role="status"><p>' +
      financeRedesignEsc(financeRedesignT('admin.finance.wh.unsupported', 'This finance version is not supported.')) +
      '</p></div>';
  }
  var detail = accepted.detail;
  var page = detail.page || {};
  var totals = detail.full_cohort_totals || {};
  var currency = detail.currency;
  var echoed = typeof detail.creator === 'string' ? detail.creator : '';
  var creator = echoed || (opts && typeof opts.creator === 'string' ? opts.creator : '');
  var html = '<div class="wh-fin-detail" data-wh-fin-detail-kind="' + financeRedesignEsc(detail.kind) + '"' +
    ' data-wh-fin-detail-creator="' + financeRedesignEsc(creator) + '"' +
    ' data-wh-fin-matched="' + financeRedesignEsc(page.matched_count == null ? '' : String(page.matched_count)) + '"' +
    ' data-wh-fin-page-complete="' + (page.complete === true ? 'true' : 'false') + '">';
  html += '<p>' + financeRedesignEsc(financeRedesignT('admin.finance.wh.matched', 'Matched')) + ' ' +
    financeRedesignEsc(page.matched_count == null ? '—' : String(page.matched_count)) + '</p>';
  (WH_FIN_DETAIL_TOTALS[detail.kind] || []).forEach(function (spec) {
    if (!Object.prototype.hasOwnProperty.call(totals, spec[0])) return;
    var raw = totals[spec[0]];
    var valueHtml;
    if (raw == null) {
      valueHtml = '<span class="wh-fin-unknown" data-wh-fin-value="unknown">' +
        financeRedesignEsc(financeRedesignT('admin.finance.wh.unknown', 'Not available')) + '</span>';
    } else if (spec[3] === 'money') {
      valueHtml = whFinMoneyHtml(raw, currency);
    } else {
      valueHtml = '<span class="wh-fin-count" data-wh-fin-count="' + financeRedesignEsc(String(raw)) + '">' +
        financeRedesignEsc(String(raw)) + '</span>';
    }
    html += '<p data-wh-fin-full-total="' + spec[0] + '">' +
      financeRedesignEsc(financeRedesignT('admin.finance.wh.fullTotal', 'Complete total')) + ' ' +
      financeRedesignEsc(financeRedesignT(spec[1], spec[2])) + ' ' + valueHtml + '</p>';
  });
  var fields = WH_FIN_ROW_FIELDS[detail.kind] || [];
  html += '<div class="wh-fin-table-wrap"><table class="wh-fin-table"><caption>' +
    financeRedesignEsc(financeRedesignT('admin.finance.wh.detailTable', 'Contributing rows')) +
    '</caption><thead><tr>';
  fields.forEach(function (field) {
    html += '<th scope="col" data-wh-fin-col="' + field + '">' + financeRedesignEsc(whFinFieldLabel(field)) + '</th>';
  });
  html += '</tr></thead><tbody>';
  (detail.rows || []).forEach(function (row) {
    html += '<tr data-wh-fin-row="' + financeRedesignEsc(row.payment_id || row.booking_id || row.refund_id || row.row_id || '') + '">';
    fields.forEach(function (field) {
      var present = row && Object.prototype.hasOwnProperty.call(row, field);
      var value = present ? row[field] : '';
      var isDate = ['receipt_date', 'created_date', 'effective_date', 'service_date', 'check_in', 'check_out'].indexOf(field) >= 0;
      var isDateTime = field === 'as_of';
      var cell;
      if (!present) cell = '';
      else if (WH_FIN_MONEY_FIELDS[field]) cell = whFinMoneyHtml(value, currency);
      else if (isDateTime || isDate) {
        cell = '<time datetime="' + financeRedesignEsc(value == null ? '' : String(value)) + '">' +
          financeRedesignEsc(isDateTime ? financeRedesignFormatDateTime(value) : financeRedesignFormatIsoDate(value)) + '</time>';
      } else cell = financeRedesignEsc(value == null ? '' : String(value));
      html += '<td data-wh-fin-field="' + field + '">' + cell + '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  if (page.next_cursor) {
    html += '<button type="button" data-wh-fin-cursor="' + financeRedesignEsc(page.next_cursor) + '"' +
      (creator ? ' data-wh-fin-creator="' + financeRedesignEsc(creator) + '"' : '') + '>' +
      financeRedesignEsc(financeRedesignT('admin.finance.wh.nextPage', 'Next page')) + '</button>';
  }
  html += '</div>';
  return html;
}

// Node offline fixture path
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    renderFinanceRedesignHtml: renderFinanceRedesignHtml,
    renderWolfhouseCreatorFinanceHtml: renderWolfhouseCreatorFinanceHtml,
    renderWolfhouseCreatorFinanceDetailHtml: renderWolfhouseCreatorFinanceDetailHtml,
    financeRedesignFmtEur: financeRedesignFmtEur,
    financeRedesignTitle: financeRedesignTitle,
    financeRedesignCustomDisplay: financeRedesignCustomDisplay,
    financeRedesignFormatIsoDate: financeRedesignFormatIsoDate,
    financeRedesignFormatIsoRange: financeRedesignFormatIsoRange,
  };
}
