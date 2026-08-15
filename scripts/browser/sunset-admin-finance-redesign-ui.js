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

function financeRedesignTitle(view) {
  if (!view || !view.range) return '';
  var g = view.granularity || 'month';
  var start = view.range.start;
  var end = view.range.end;
  try {
    if (g === 'day') {
      var d = new Date(start + 'T12:00:00');
      return d.toLocaleDateString(typeof portalLang === 'string' ? portalLang : 'en', {
        weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
      });
    }
    if (g === 'year') return String(start).slice(0, 4);
    if (g === 'custom') return start + ' – ' + end;
    var m = new Date(start + 'T12:00:00');
    return m.toLocaleDateString(typeof portalLang === 'string' ? portalLang : 'en', {
      month: 'long', year: 'numeric',
    });
  } catch (_e) {
    return start + (end && end !== start ? ' – ' + end : '');
  }
}

function financeRedesignCustomDisplay(view) {
  var start = view && view.range ? String(view.range.start || '') : '';
  var end = view && view.range ? String(view.range.end || '') : '';
  if (!(view && view.granularity === 'custom' && start && end)) {
    return financeRedesignT('admin.finance.gran.custom', 'Custom');
  }
  return start === end ? start : (start + ' – ' + end);
}

function financeRedesignTrendTitle(trendMode) {
  return trendMode === 'year'
    ? financeRedesignT('admin.finance.monthlyGrossTrend', 'Monthly gross vs last year')
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
  var w = Math.max(0, Math.min(100, Number(pct) || 0));
  return '<div class="pfb-bar-row">' +
    '<span class="pfb-bar-name">' + financeRedesignEsc(name) + '</span>' +
    '<span class="pfb-bar-track"><span class="pfb-bar-fill ' + colorClass + '" style="width:' + w + '%"></span></span>' +
    '<span class="pfb-bar-amt">' + financeRedesignEsc(financeRedesignFmtEur(cents)) + '</span>' +
    '<span class="pfb-bar-pct">' + financeRedesignEsc(String(w % 1 ? w.toFixed(1) : w) + '%') + '</span>' +
    '</div>';
}

function financeRedesignUtilRow(name, pct, detail, colorClass) {
  var known = pct != null && Number.isFinite(Number(pct));
  var w = known ? Math.max(0, Math.min(100, Number(pct))) : 0;
  var val = known ? (String(Math.round(w)) + '%') : financeRedesignEsc(detail || '—');
  return '<div class="pfb-util-row">' +
    '<span class="pfb-util-name">' + financeRedesignEsc(name) + '</span>' +
    '<span class="pfb-util-track"><span class="pfb-util-fill ' + colorClass + '" style="width:' + (known ? w : 0) + '%"></span></span>' +
    '<span class="pfb-util-val">' + val + '</span>' +
    '</div>';
}

function financeRedesignTrendHtml(trend, mode) {
  var rows = Array.isArray(trend) ? trend : [];
  if (!rows.length) {
    return '<div class="pfb-trend-empty" data-finance-trend-empty="1">' + financeRedesignEsc(financeRedesignT('admin.finance.empty', 'No activity in this period.')) + '</div>';
  }
  var max = 1;
  rows.forEach(function (r) {
    max = Math.max(max, Number(r.collected_gross_cents) || 0, Number(r.ly_collected_gross_cents) || 0);
  });
  var isYear = mode === 'year' || mode === 'months' || mode === '12m';
  if (isYear) {
    var htmlMonthly = '<div class="pfb-trend pfb-trend--monthly" data-finance-trend-mode="year" role="img" aria-label="' +
      financeRedesignEsc(financeRedesignTrendTitle('year')) + '">';
    rows.forEach(function (r, idx) {
      var cur = Math.max(0, Number(r.collected_gross_cents) || 0);
      var ly = Math.max(0, Number(r.ly_collected_gross_cents) || 0);
      var hCur = Math.round((100 * cur) / max);
      var hLy = Math.round((100 * ly) / max);
      var monthNum = Number(r.month);
      var monthLabel = financeRedesignMonthLabel(((monthNum >= 1 && monthNum <= 12) ? monthNum : (idx + 1)) - 1);
      htmlMonthly += '<div class="pfb-trend-day pfb-trend-day--month" title="' +
        financeRedesignEsc(monthLabel + ' · ' + financeRedesignFmtEurExact(cur) + ' · LY ' + financeRedesignFmtEurExact(ly)) + '">' +
        '<div class="pfb-trend-col">' +
        '<span class="pfb-trend-prev" style="height:' + hLy + '%"></span>' +
        '<span class="pfb-trend-cur" style="height:' + hCur + '%"></span>' +
        '</div>' +
        '<div class="pfb-trend-d">' + financeRedesignEsc(monthLabel) + '</div>' +
        '</div>';
    });
    htmlMonthly += '</div>';
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
    html += '<div class="pfb-trend-day" title="' + financeRedesignEsc((r.month || r.date || '') + ' · ' + financeRedesignFmtEurExact(cur)) + '">' +
      '<div class="pfb-trend-col">' +
      '<span class="pfb-trend-prev" style="height:' + hLy + '%"></span>' +
      '<span class="pfb-trend-cur" style="height:' + hCur + '%"></span>' +
      '</div>' +
      '<div class="pfb-trend-d">' + financeRedesignEsc(lab || '') + '</div>' +
      '</div>';
  });
  html += '</div>';
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
  var g = view.granularity || 'month';

  var title = financeRedesignTitle(view);
  var html = '';
  html += '<div class="portal-admin-finance portal-admin-finance--b" data-finance-redesign="1">';

  // Navigator
  html += '<div class="pfb-nav">';
  html += '<div class="pfb-nav-left">';
  html += '<div class="pfb-range" role="group" aria-label="Period">';
  html += '<button type="button" class="pfb-arw" data-finance-nav="prev" aria-label="Previous">‹</button>';
  html += '<span class="pfb-range-label" data-finance-range-label="1">' + financeRedesignEsc(title) + '</span>';
  html += '<button type="button" class="pfb-arw" data-finance-nav="next" aria-label="Next">›</button>';
  html += '</div></div>';
  html += '<div class="pfb-gran" role="tablist" aria-label="Granularity">';
  [['day', 'Day'], ['month', 'Month'], ['year', 'Year']].forEach(function (row) {
    var key = row[0]; var lab = row[1];
    var on = g === key ? ' is-on' : '';
    html += '<button type="button" role="tab" class="pfb-gran-btn' + on + '" data-finance-gran="' + key + '"' +
      ' aria-selected="' + (g === key ? 'true' : 'false') + '">' +
      financeRedesignEsc(financeRedesignT('admin.finance.gran.' + key, lab)) + '</button>';
  });
  html += '<div class="pfb-custom-wrap">';
  html += '<button type="button" class="pfb-custom' + (g === 'custom' ? ' is-on' : '') + '" id="pfb-custom-range-trigger" data-finance-gran="custom" data-finance-nav="open-custom-range"' +
    ' aria-haspopup="dialog" aria-expanded="false" aria-controls="pfb-custom-range-pop">' +
    '<span id="pfb-custom-display" class="portal-schedule-create-date-range-display">' +
    financeRedesignEsc(financeRedesignCustomDisplay(view)) + '</span></button>';
  html += '<div id="pfb-custom-range-pop" class="portal-schedule-create-date-range-popover pfb-custom-popover" role="dialog" aria-modal="false" aria-labelledby="pfb-custom-month-label" hidden style="display:none">';
  html += '<div class="pfb-custom-head pfb-cal-head">';
  html += '<button type="button" id="pfb-custom-prev" data-pfb-cal="prev" aria-label="Previous month">&#8249;</button>';
  html += '<span id="pfb-custom-month-label" class="portal-schedule-create-date-range-month" aria-live="polite"></span>';
  html += '<button type="button" id="pfb-custom-next" data-pfb-cal="next" aria-label="Next month">&#8250;</button>';
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
  var netCents = Number(net.net_collected_cents);
  if (!Number.isFinite(netCents)) netCents = 0;
  var netBigCls = netCents < 0 ? 'pfb-big pfb-big--amber' : 'pfb-big pfb-big--green';
  html += '<div class="' + netBigCls + '">' + financeRedesignEsc(financeRedesignFmtEur(netCents)) + '</div>';
  html += '<div class="pfb-row"><span>' + financeRedesignEsc(financeRedesignT('admin.finance.grossCollected', 'Gross collected')) +
    '</span><b>' + financeRedesignEsc(financeRedesignFmtEur(net.gross_collected_cents || 0)) + '</b></div>';
  html += '<div class="pfb-row"><span>' + financeRedesignEsc(financeRedesignT('admin.finance.refunds', 'Refunds')) +
    '</span><b class="pfb-muted">' + financeRedesignEsc(financeRedesignFmtEur(
      net.completed_refunds_cents != null ? net.completed_refunds_cents : (net.refunds_cents || 0)
    )) + '</b></div>';
  // Pending cancellation proxy retired in Slice 2 — do not render.
  html += '<div class="pfb-note">' + financeRedesignEsc(
    (R.limitations && R.limitations.note)
      || financeRedesignT('admin.finance.netNote',
        'Net = gross collected − recorded refunds in this period (effective date). Manual records only — not Stripe.')
  ) + '</div>';
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
  html += '<div class="pfb-lbl">' + financeRedesignEsc(financeRedesignT('admin.finance.bookedPipeline', 'Booked (pipeline)')) + '</div>';
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
    financeRedesignDeltaChip(pipe.vs_prior_pct) + ' ' +
    financeRedesignDeltaChip(pipe.vs_yoy_pct) +
    '</div></div></div>';

  // Outstanding
  html += '<div class="pfb-card pfb-card--hero">';
  html += '<div class="pfb-card-top">';
  html += '<div class="pfb-lbl">' + financeRedesignEsc(financeRedesignT('admin.finance.outstanding', 'Outstanding')) + '</div>';
  html += '<div class="pfb-mid pfb-mid--amber">' + financeRedesignEsc(financeRedesignFmtEur(out.outstanding_cents || 0)) + '</div>';
  html += '<div class="pfb-cmp">' + financeRedesignEsc(financeRedesignT('admin.finance.acrossBookings', 'across') + ' ' +
    String(out.bookings_count || 0) + ' ' + financeRedesignT('admin.finance.bookings', 'bookings')) + '</div>';
  html += '</div>';
  html += '<div class="pfb-card-bot">';
  html += '<div class="pfb-age"><span>' + financeRedesignEsc(financeRedesignT('admin.finance.dueSoon', 'Due soon (≤7d)')) +
    '</span><span class="pfb-pill pfb-pill--green">' + financeRedesignEsc(financeRedesignFmtEur(out.due_soon_cents || 0)) + '</span></div>';
  html += '<div class="pfb-age"><span>' + financeRedesignEsc(financeRedesignT('admin.finance.overdue', 'Overdue (>7d)')) +
    '</span><span class="pfb-pill pfb-pill--red">' + financeRedesignEsc(financeRedesignFmtEur(out.overdue_cents || 0)) + '</span></div>';
  html += '<div class="pfb-note">' + financeRedesignEsc(financeRedesignT('admin.finance.agingNote',
    'Aged by last service date (no contractual due date).')) + '</div>';
  html += '</div></div>';

  html += '</div>'; // hero

  // Two-col: product + capacity
  html += '<div class="pfb-two">';
  html += '<div class="pfb-card pfb-card--bars">';
  html += '<div class="pfb-sec">' + financeRedesignEsc(financeRedesignT('admin.finance.revenueByProduct', 'Revenue by product')) + '</div>';
  html += '<div class="pfb-bars pfb-bars--compact">';
  var colorCycle = ['is-green', 'is-blue', 'is-violet', 'is-amber'];
  var colorMap = { lessons: 'is-green', course_included: 'is-blue', boards: 'is-blue', wetsuits: 'is-violet', other: 'is-amber' };
  products.forEach(function (p, idx) {
    var cls = colorMap[p.key] || colorMap[p.slot] || colorCycle[idx % colorCycle.length] || 'is-green';
    var lab = p.label || '\u2014';
    if (/staff\s*accommodation/i.test(lab)) lab = financeRedesignT('admin.finance.product.accommodation', 'Accommodation');
    if (p.slot === 'lessons' || p.key === 'lessons') {
      lab = financeRedesignT('admin.finance.product.lessons', 'Lessons');
    } else if (p.slot === 'course_included' || p.key === 'course_included') {
      lab = p.label && p.label !== 'Course equipment' && !/^\u2014$/.test(p.label)
        ? p.label
        : financeRedesignT('admin.finance.product.courseIncluded', 'Course equipment');
    }
    html += financeRedesignBarRow(lab, p.cents, p.pct, cls);
  });
  html += '</div>';
  html += '<div class="pfb-sub pfb-sub--foot">' + financeRedesignEsc(financeRedesignT('admin.finance.revenueByProductNote', "Where the money's coming from (booked by service date)")) + '</div>';
  html += '</div>';

  html += '<div class="pfb-card pfb-card--bars pfb-card--capacity">';
  html += '<div class="pfb-sec">' + financeRedesignEsc(financeRedesignT('admin.finance.capacityUsed', 'Capacity used')) + '</div>';
  html += '<div class="pfb-cap-top">';
  var seatsPct = cap.seats_pct;
  var ringPct = seatsPct != null && Number.isFinite(Number(seatsPct))
    ? Math.max(0, Math.min(100, Math.round(Number(seatsPct))))
    : 0;
  html += '<div class="pfb-ring" data-finance-cap-ring="1" style="--pfb-ring:' + ringPct + '%" aria-hidden="true">' +
    '<div class="pfb-ring-in"><b>' +
    (seatsPct != null && Number.isFinite(Number(seatsPct))
      ? financeRedesignEsc(String(Math.round(Number(seatsPct))) + '%')
      : '\u2014') +
    '</b><span>' + financeRedesignEsc(financeRedesignT('admin.finance.lessonSeats', 'lesson seats')) + '</span></div></div>';
  html += '<div class="pfb-bars pfb-bars--compact pfb-bars--capacity">';
  var capRows = Array.isArray(cap.by_product) && cap.by_product.length
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
    var w = pct != null && Number.isFinite(Number(pct)) ? Math.max(0, Math.min(100, Number(pct))) : 0;
    var detail = row.detail != null ? String(row.detail) : '\u2014';
    html += '<div class="pfb-bar-row pfb-bar-row--util">';
    html += '<span class="pfb-bar-name">' + financeRedesignEsc(lab) + '</span>';
    html += '<span class="pfb-bar-track"><span class="pfb-bar-fill ' + cls + '" style="width:' + w + '%"></span></span>';
    html += '<span class="pfb-bar-amt">' + financeRedesignEsc(detail) + '</span>';
    html += '<span class="pfb-bar-pct">' + financeRedesignEsc(pct != null ? (String(Math.round(w)) + '%') : '\u2014') + '</span>';
    html += '</div>';
  });
  html += '</div></div>'; // bars + cap-top
  if (cap.unsold_seats != null) {
    html += '<div class="pfb-callout">';
    html += '<span>' + financeRedesignEsc(String(cap.unsold_seats) + ' ' +
      financeRedesignT('admin.finance.unsoldSeats', 'unsold seats this period')) + '</span>';
    if (cap.left_on_table_cents != null) {
      html += '<span>≈ <b>' + financeRedesignEsc(financeRedesignFmtEur(cap.left_on_table_cents)) + '</b> ' +
        financeRedesignEsc(financeRedesignT('admin.finance.leftOnTable', 'left on the table')) + '</span>';
    }
    html += '</div>';
  }
  html += '</div></div>'; // two

  // Gross trend — F3 toggle: month-days vs 12-month year
  // F3: chart mode is independent of top Day/Month/Year period selector.
  var rawTrend = (typeof window !== 'undefined' && window.__financeTrendMode) ? String(window.__financeTrendMode) : '';
  if (!rawTrend && g === 'year') rawTrend = 'year';
  if (!rawTrend) rawTrend = 'days';
  var trendMode = (rawTrend === 'year' || rawTrend === 'months' || rawTrend === '12m') ? 'year' : 'days';
  var trendRows = trendMode === 'year'
    ? (Array.isArray(R.monthly_gross_trend) ? R.monthly_gross_trend : [])
    : (Array.isArray(R.daily_gross_trend) ? R.daily_gross_trend : []);
  html += '<div class="pfb-card pfb-card--trend" data-finance-trend-card="1">';
  html += '<div class="pfb-sec-row">';
  html += '<div class="pfb-sec">' + financeRedesignEsc(financeRedesignTrendTitle(trendMode)) + '</div>';
  html += '<div class="pfb-trend-toggle" role="tablist" aria-label="Trend chart range">';
  html += '<button type="button" class="pfb-trend-btn' + (trendMode === 'days' ? ' is-on' : '') + '" data-finance-trend="days" role="tab" aria-selected="' + (trendMode === 'days' ? 'true' : 'false') + '">' +
    financeRedesignEsc(financeRedesignT('admin.finance.trend.monthDays', 'Days')) + '</button>';
  html += '<button type="button" class="pfb-trend-btn' + (trendMode === 'year' ? ' is-on' : '') + '" data-finance-trend="year" role="tab" aria-selected="' + (trendMode === 'year' ? 'true' : 'false') + '">' +
    financeRedesignEsc(financeRedesignT('admin.finance.trend.yearMonths', '12 months')) + '</button>';
  html += '</div></div>';
  html += financeRedesignTrendHtml(trendRows, trendMode);
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
  };
}
