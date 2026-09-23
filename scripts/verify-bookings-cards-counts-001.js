#!/usr/bin/env node
'use strict';

/**
 * BOOKINGS-CARDS-COUNTS-001
 * Bookings strip shows three counts, never euros.
 * Refund needed matches the refund_needed filter/chip.
 * Unpaid matches Status = Unpaid (partials are not included).
 *
 *   node scripts/verify-bookings-cards-counts-001.js
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOMAIN = require('./lib/sunset-bookings-admin');
const ui = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const i18n = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');

let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log('ok -', label);
    return;
  }
  failed += 1;
  console.error('FAIL -', label, detail || '');
}

const rows = [
  { status: 'unpaid', collected_cents: 0, refunded_cents: 0, outstanding_cents: 368000, needs_refund: false, status_tags: ['unpaid'] },
  { status: 'partial', collected_cents: 1000, refunded_cents: 0, outstanding_cents: 2000, needs_refund: false, status_tags: ['partial'] },
  { status: 'paid', collected_cents: 5000, refunded_cents: 0, outstanding_cents: 0, needs_refund: false, status_tags: ['paid'] },
  {
    status: 'cancelled',
    booking_status: 'cancelled',
    collected_cents: 4000,
    refunded_cents: 1000,
    outstanding_cents: 0,
    needs_refund: true,
    status_tags: ['cancelled', 'refund_needed'],
  },
  {
    status: 'cancelled',
    booking_status: 'cancelled',
    collected_cents: 0,
    refunded_cents: 0,
    outstanding_cents: 9999,
    needs_refund: false,
    status_tags: ['cancelled'],
  },
  {
    status: 'refunded',
    collected_cents: 3000,
    refunded_cents: 3000,
    outstanding_cents: 0,
    needs_refund: false,
    status_tags: ['refunded'],
  },
];

const summary = DOMAIN.computeBookingsSummary(rows);
const refundNeeded = rows.filter((row) => DOMAIN.bookingMatchesStatus(row, 'refund_needed')).length;
const unpaid = rows.filter((row) => DOMAIN.bookingMatchesStatus(row, 'unpaid')).length;

ok('bookings count is the filtered total', summary.bookings_count === rows.length);
ok('refund needed count matches the filter', summary.refund_needed_count === refundNeeded && refundNeeded === 1, JSON.stringify(summary));
ok('unpaid count matches Status=Unpaid and skips partials', summary.unpaid_count === unpaid && unpaid === 1, JSON.stringify(summary));
ok('money fields stay sums, not counts', summary.outstanding_cents === 370000 && summary.refunded_cents === 4000, JSON.stringify(summary));
ok('cancelled outstanding is still excluded from the money sum', summary.outstanding_cents === 368000 + 2000);

const summaryFn = ui.slice(ui.indexOf('function renderAdminBookingsSummary'), ui.indexOf('function adminBookingsRowPayTone'));
ok('strip renders three integer cards',
  summaryFn.includes("metric('admin.bookings.metric.bookings', adminBookingsCountText(s.bookings_count)")
  && summaryFn.includes("metric('admin.bookings.status.refund_needed', adminBookingsCountText(s.refund_needed_count)")
  && summaryFn.includes("metric('admin.bookings.metric.unpaid', adminBookingsCountText(s.unpaid_count)")
  && !summaryFn.includes('adminBookingsFormatEur')
  && !/€|EUR/.test(summaryFn));
ok('labels are Bookings / Refund needed / Unpaid',
  /'admin\.bookings\.metric\.bookings':\s*'Bookings'/.test(i18n)
  && /'admin\.bookings\.status\.refund_needed':\s*'Refund needed'/.test(i18n)
  && /'admin\.bookings\.metric\.unpaid':\s*'Unpaid'/.test(i18n));
ok('desktop strip is three columns and not mobile-hidden',
  /\.portal-admin-bookings-summary-strip\{[^}]*grid-template-columns:repeat\(3,minmax\(0,220px\)\)/.test(api)
  && !/\.portal-admin-bookings-metric--mobile-kpi\{display:none\}/.test(api));

function loadPlaywright() {
  try { return require('playwright'); } catch (_e) { return null; }
}

function extractBookingsCss() {
  const start = api.indexOf('/* Admin Bookings N1');
  const endMarker = '.portal-admin-tabpanel{max-width:100%}';
  const end = api.indexOf(endMarker, start >= 0 ? start : 0);
  if (start < 0 || end < 0) return '';
  return api.slice(start, end + endMarker.length);
}

function fixtureHtml(css) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${css}
body{margin:0;font-family:system-ui,sans-serif}
</style></head><body>
<div class="portal-admin-bookings">
  <div id="admin-bookings-summary" class="portal-admin-bookings-summary">
    <div class="portal-admin-bookings-summary-strip" role="group">
      <div class="portal-admin-bookings-metric"><div class="portal-admin-bookings-metric-label">Bookings</div><div class="portal-admin-bookings-metric-value is-count">18</div></div>
      <div class="portal-admin-bookings-metric"><div class="portal-admin-bookings-metric-label">Refund needed</div><div class="portal-admin-bookings-metric-value is-refund">2</div></div>
      <div class="portal-admin-bookings-metric"><div class="portal-admin-bookings-metric-label">Unpaid</div><div class="portal-admin-bookings-metric-value is-unpaid">7</div></div>
    </div>
  </div>
</div>
</body></html>`;
}

async function measure(page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.portal-admin-bookings-metric'));
    return cards.map((card) => {
      const label = card.querySelector('.portal-admin-bookings-metric-label');
      const value = card.querySelector('.portal-admin-bookings-metric-value');
      const box = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      return {
        label: label ? label.textContent.trim() : '',
        value: value ? value.textContent.trim() : '',
        display: style.display,
        w: Math.round(box.width),
        h: Math.round(box.height),
      };
    });
  });
}

function cardsOk(measured) {
  if (!measured || measured.length !== 3) return false;
  const labels = measured.map((c) => c.label).join('|');
  const values = measured.map((c) => c.value);
  return labels === 'Bookings|Refund needed|Unpaid'
    && values.join('|') === '18|2|7'
    && measured.every((c) => c.display !== 'none' && c.w > 20 && c.h > 16)
    && !values.some((v) => /€|EUR|\./.test(v));
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    ok('playwright available', false, 'static checks only');
    process.exit(failed ? 1 : 0);
  }
  const css = extractBookingsCss();
  ok('bookings css extracted', css.includes('portal-admin-bookings-summary-strip'));
  const html = fixtureHtml(css);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await desktop.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    const desktopMeasured = await measure(desktop);
    ok('desktop shows three integer cards', cardsOk(desktopMeasured), JSON.stringify(desktopMeasured));
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await phone.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    const phoneMeasured = await measure(phone);
    ok('phone shows three integer cards', cardsOk(phoneMeasured), JSON.stringify(phoneMeasured));
    await desktop.close();
    await phone.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log(failed
    ? `verify:bookings-cards-counts-001 FAILED (${failed})`
    : 'verify:bookings-cards-counts-001 passed');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
