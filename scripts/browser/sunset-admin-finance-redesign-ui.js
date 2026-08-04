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
  if (typeof portalT === 'function') {
    var v = portalT(key);
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

function financeRedesignTrendHtml(trend) {
  var rows = Array.isArray(trend) ? trend : [];
  if (!rows.length) {
    return '<div class="pfb-trend-empty">' + financeRedesignEsc(financeRedesignT('admin.finance.empty', 'No activity in this period.')) + '</div>';
  }
  var max = 1;
  rows.forEach(function (r) {
    max = Math.max(max, Number(r.collected_gross_cents) || 0, Number(r.ly_collected_gross_cents) || 0);
  });
  var html = '<div class="pfb-trend" role="img" aria-label="' +
    financeRedesignEsc(financeRedesignT('admin.finance.trendTitle', 'Daily net revenue — vs last year')) + '">';
  rows.forEach(function (r) {
    var cur = Math.max(0, Number(r.collected_gross_cents) || 0);
    var ly = Math.max(0, Number(r.ly_collected_gross_cents) || 0);
    var hCur = Math.round((100 * cur) / max);
    var hLy = Math.round((100 * ly) / max);
    var dayNum = String(r.date || '').slice(8, 10);
    if (dayNum.charAt(0) === '0') dayNum = dayNum.slice(1);
    html += '<div class="pfb-trend-day" title="' + financeRedesignEsc(r.date + ' · ' + financeRedesignFmtEurExact(cur)) + '">' +
      '<div class="pfb-trend-col">' +
      '<span class="pfb-trend-prev" style="height:' + hLy + '%"></span>' +
      '<span class="pfb-trend-cur" style="height:' + hCur + '%"></span>' +
      '</div>' +
      '<div class="pfb-trend-d">' + financeRedesignEsc(dayNum || '') + '</div>' +
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
  html += '<div class="pfb-kick">' + financeRedesignEsc(financeRedesignT('admin.finance.kick', 'Sunset · Finance')) + '</div>';
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
  html += '<button type="button" class="pfb-custom' + (g === 'custom' ? ' is-on' : '') + '" data-finance-gran="custom">' +
    financeRedesignEsc(financeRedesignT('admin.finance.gran.custom', 'Custom')) + '</button>';
  html += '</div></div>';

  // Custom range inputs (shown when custom)
  if (g === 'custom') {
    html += '<div class="pfb-custom-row">';
    html += '<label class="pfb-custom-field">From <input type="date" id="pfb-custom-start" value="' +
      financeRedesignEsc((view.range && view.range.start) || '') + '"></label>';
    html += '<label class="pfb-custom-field">To <input type="date" id="pfb-custom-end" value="' +
      financeRedesignEsc((view.range && view.range.end) || '') + '"></label>';
    html += '<button type="button" class="btn btn-primary pfb-custom-apply" data-finance-nav="apply-custom">' +
      financeRedesignEsc(financeRedesignT('admin.action.apply', 'Apply')) + '</button>';
    html += '</div>';
  }

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
  html += '<div class="pfb-card">';
  html += '<div class="pfb-sec">' + financeRedesignEsc(financeRedesignT('admin.finance.revenueByProduct', 'Revenue by product')) + '</div>';
  html += '<div class="pfb-sub">' + financeRedesignEsc(financeRedesignT('admin.finance.revenueByProductNote', "Where the money's coming from (booked by service date)")) + '</div>';
  html += '<div class="pfb-bars">';
  var colorCycle = ['is-green', 'is-blue', 'is-violet', 'is-amber', 'is-green'];
  var colorMap = { lessons: 'is-green', course_included: 'is-blue', boards: 'is-blue', wetsuits: 'is-violet', retail: 'is-amber', other: 'is-amber' };
  products.forEach(function (p, idx) {
    var cls = colorMap[p.key] || colorMap[p.slot] || colorCycle[idx % colorCycle.length] || 'is-green';
    var lab = p.label;
    if (p.slot === 'lessons' || p.key === 'lessons') {
      lab = financeRedesignT('admin.finance.product.lessons', p.label || 'Lessons');
    } else if (p.slot === 'course_included' || p.key === 'course_included') {
      lab = p.label && p.label !== 'Course equipment'
        ? p.label
        : financeRedesignT('admin.finance.product.courseIncluded', 'Course equipment');
    } else if (p.slot === 'other' || p.key === 'other') {
      lab = financeRedesignT('admin.finance.product.other', 'Other');
    }
    html += financeRedesignBarRow(lab, p.cents, p.pct, cls);
  });
  html += '</div></div>';

  html += '<div class="pfb-card">';
  html += '<div class="pfb-sec">' + financeRedesignEsc(financeRedesignT('admin.finance.capacityUsed', 'Capacity used')) + '</div>';
  html += '<div class="pfb-sub">' + financeRedesignEsc(financeRedesignT('admin.finance.capacityNote',
    'Empty seats & idle gear = money you can\'t get back')) + '</div>';
  html += '<div class="pfb-cap-top">';
  var seatsPct = cap.seats_pct;
  html += '<div class="pfb-ring" style="--pfb-ring:' + (seatsPct != null ? Math.max(0, Math.min(100, Math.round(seatsPct))) : 0) + '%" aria-hidden="true"><div class="pfb-ring-in"><b>' +
    (seatsPct != null ? financeRedesignEsc(String(Math.round(seatsPct)) + '%') : '—') +
    '</b><span>' + financeRedesignEsc(financeRedesignT('admin.finance.lessonSeats', 'lesson seats')) + '</span></div></div>';
  html += '<div class="pfb-utils">';
  var seatsDetail = (cap.seats_filled != null && cap.seats_capacity != null)
    ? (cap.seats_filled + '/' + cap.seats_capacity)
    : (cap.seats_filled != null ? String(cap.seats_filled) : '—');
  html += financeRedesignUtilRow(financeRedesignT('admin.finance.seats', 'Seats'), seatsPct, seatsDetail, 'is-green');
  var boardDetail = cap.boards_stock != null
    ? (String(cap.boards_out || 0) + '/' + cap.boards_stock)
    : (financeRedesignT('admin.finance.out', 'out') + ' ' + String(cap.boards_out || 0));
  html += financeRedesignUtilRow(financeRedesignT('admin.finance.boards', 'Boards'), cap.boards_pct, boardDetail, 'is-blue');
  var suitDetail = cap.wetsuits_stock != null
    ? (String(cap.wetsuits_out || 0) + '/' + cap.wetsuits_stock)
    : (financeRedesignT('admin.finance.out', 'out') + ' ' + String(cap.wetsuits_out || 0));
  html += financeRedesignUtilRow(financeRedesignT('admin.finance.wetsuits', 'Wetsuits'), cap.wetsuits_pct, suitDetail, 'is-violet');
  html += '</div></div>';
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

  // Daily trend
  html += '<div class="pfb-card pfb-card--trend">';
  html += '<div class="pfb-sec">' + financeRedesignEsc(financeRedesignT('admin.finance.dailyGrossTrend',
    'Daily gross collected — vs last year')) + '</div>';
  html += financeRedesignTrendHtml(R.daily_gross_trend);
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
