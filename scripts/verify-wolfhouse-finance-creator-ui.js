'use strict';

/**
 * Wolfhouse Finance creator screen. Presentation fixtures only.
 * Run: node scripts/verify-wolfhouse-finance-creator-ui.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { renderFinanceRedesignHtml, renderWolfhouseCreatorFinanceHtml, renderWolfhouseCreatorFinanceDetailHtml } = require('./browser/sunset-admin-finance-redesign-ui');

const ROOT = path.join(__dirname, '..');
const success = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/wolfhouse-finance-creator-ui/success.json'), 'utf8'));

function check(label, cond) {
  assert.equal(!!cond, true, label);
  console.log('PASS', label);
}

const html = renderWolfhouseCreatorFinanceHtml({ wolfhouse_creator_finance: success, summary: { redesign: { view: {} } } });
check('title', html.includes('Finance · Wolfhouse'));
check('luna headline', /data-wh-fin-headline="luna"[\s\S]*€150\.00/.test(html));
check('staff headline', /data-wh-fin-headline="staff"[\s\S]*€100\.00/.test(html));
check('other visible at zero', /data-wh-fin-also="other_imported"[\s\S]*€0\.00/.test(html) && html.includes('No payments in this period.'));
check('unattributed visible', html.includes('data-wh-fin-also="unattributed"'));
check('total visible', /data-wh-fin-also="total"[\s\S]*€250\.00/.test(html));
check('deposits already included', html.includes('Already included in receipts above.') && html.includes('€80.00'));
check('outstanding independent', html.includes('Not limited to this period.') && html.includes('€400.00'));
check('new booking value opens bookings', /data-wh-fin-open="bookings"[\s\S]*€600\.00/.test(html));
check('month default selected', /data-finance-gran="month"[^>]*aria-selected="true"/.test(html));
check('today week year custom retained', ['today', 'week', 'year', 'custom'].every((k) => html.includes(k === 'today' ? 'data-finance-nav="today"' : `data-finance-gran="${k}"`)));
check('arrival label kept', html.includes('Booking value by arrival date') && html.includes('data-wh-fin-date-basis="arrival_or_service_date"'));
check('chart and table', html.includes('role="img"') && html.includes('<table') && html.includes('€150.00') && html.includes('€90.00'));
check('madrid freshness', html.includes('Europe/Madrid') && html.includes('2026-10-17T21:30:00.000Z'));

const partial = JSON.parse(JSON.stringify(success));
partial.creators[0].gross_receipts = { state: 'partial', amount_cents: 15000, date_basis: 'receipt_paid_at_madrid', reason_codes: ['mixed_currency'], coverage: { excluded_count: 1 } };
const partialHtml = renderWolfhouseCreatorFinanceHtml({ wolfhouse_creator_finance: partial });
check('partial is not a complete split', partialHtml.includes('Not a complete split.') && partialHtml.includes('data-wh-fin-reason="mixed_currency"'));
check('partial does not invent EUR on excluded currency group', !/data-wh-fin-currency="USD"/.test(partialHtml));

const refunds = JSON.parse(JSON.stringify(success));
refunds.metrics.recorded_refunds = { state: 'unavailable', amount_cents: null, date_basis: 'refund_effective_date_madrid', reason_codes: ['refund_ledger_unavailable'], coverage: {} };
refunds.metrics.net_receipts = { state: 'unavailable', amount_cents: null, reason_codes: ['refund_ledger_unavailable'], coverage: {} };
refunds.trend[1].recorded_refunds_cents = null;
refunds.trend[1].net_receipts_cents = null;
refunds.trend[1].state = 'partial';
const refundHtml = renderWolfhouseCreatorFinanceHtml({ wolfhouse_creator_finance: refunds });
check('unreadable refund is not zero', refundHtml.includes('data-wh-fin-reason="refund_ledger_unavailable"') && !/data-wh-fin-refunds="1"[\s\S]{0,400}€0\.00/.test(refundHtml));
check('gross remains when refunds are unavailable', refundHtml.includes('€150.00'));

const empty = JSON.parse(JSON.stringify(success));
empty.metrics.gross_receipts.amount_cents = 0;
empty.creators.forEach((row) => { row.gross_receipts.amount_cents = 0; row.receipt_share_bps = row.creator === 'total' ? 10000 : 0; });
const emptyHtml = renderWolfhouseCreatorFinanceHtml({ wolfhouse_creator_finance: empty });
check('complete zero stays visible', emptyHtml.includes('€0.00') && emptyHtml.includes('No payments in this period.'));

check('missing projection is not inferred', renderWolfhouseCreatorFinanceHtml({ summary: { redesign: { net: { net_collected_cents: 100 } } } }).includes('data-wh-fin-state="missing"'));
check('unsupported version is not inferred', renderWolfhouseCreatorFinanceHtml({ wolfhouse_creator_finance: { schema_version: 'wolfhouse.creator-finance.v0', metrics: { gross_receipts: { amount_cents: 1 } } } }).includes('data-wh-fin-state="unsupported"') && !renderWolfhouseCreatorFinanceHtml({ wolfhouse_creator_finance: { schema_version: 'wolfhouse.creator-finance.v0' } }).includes('€0.01'));

const sunset = renderFinanceRedesignHtml({
  redesign: {
    view: { granularity: 'month', range: { start: '2026-10-01', end: '2026-10-31' } },
    net: { net_collected_cents: 10000, gross_collected_cents: 12000, completed_refunds_cents: 2000 },
    pipeline: { booked_cents: 30000, bookings_count: 2 },
    outstanding: { outstanding_cents: 5000, bookings_count: 1 },
    revenue_by_product: [],
    daily_gross_trend: [],
    monthly_gross_trend: [],
  },
});
check('sunset renderer has no wolfhouse creator screen', sunset.includes('Net collected') && !sunset.includes('data-wh-finance='));

const detail = renderWolfhouseCreatorFinanceDetailHtml({
  schema_version: 'wolfhouse.creator-finance.v1',
  cohort_id: 'whcf1_presentation',
  detail: {
    kind: 'payments',
    creator: 'luna',
    currency: 'EUR',
    rows: [{ payment_id: 'pay-1', booking_id: 'bk-1', receipt_date: '2026-10-03', amount_cents: 15000, purpose: 'deposit', creator: 'luna' }],
    page: { limit: 100, next_cursor: 'page-2', complete: false, matched_count: 2, returned_count: 1 },
    full_cohort_totals: { gross_receipts_cents: 15000, deposits_received_cents: 5000 },
  },
});
check('detail uses full cohort total not page sum', detail.includes('data-wh-fin-full-total="gross_receipts_cents"') && detail.includes('€150.00') && detail.includes('data-wh-fin-matched="2"') && detail.includes('data-wh-fin-page-complete="false"') && detail.includes('data-wh-fin-cursor="page-2"'));

for (const file of ['scripts/lib/staff-portal-i18n.js', 'scripts/lib/staff-portal-i18n-es.js']) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  check(file + ' has wolfhouse finance title', src.includes('admin.finance.wh.title'));
}
check('italian title', fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8').includes('Finanze · Wolfhouse'));
check('spanish title', fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es.js'), 'utf8').includes('Finanzas · Wolfhouse'));

const ui = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
check('wolfhouse load is gated', ui.includes("getClient() === 'wolfhouse-somo') return loadWolfhouseFinanceSummary"));
check('stale cohort refresh', ui.includes('FINANCE_COHORT_STALE'));
check('sunset load string remains', /getClient\(\) === 'sunset' \|\| getClient\(\) === 'wolfhouse-somo'/.test(ui));

async function paint() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html data-theme="light"><head><style>:root{--surface:#fff;--text:#14211c;--line:#d7ddd8;--green:#1f7a4d}[data-theme="dark"]{--surface:#24302b;--text:#f4f1ea;--line:#3d4a44;--green:#8dceb0}body{margin:0;background:var(--surface);color:var(--text)}</style></head><body><div id="wh-admin-finance-body"></div></body></html>');
  await page.addScriptTag({ path: path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js') });
  const locales = { en: 'Finance · Wolfhouse', es: 'Finanzas · Wolfhouse', it: 'Finanze · Wolfhouse' };
  for (const [loc, title] of Object.entries(locales)) {
    await page.evaluate(({ projection, loc }) => {
      window.portalLang = loc;
      window.getStaffLocale = () => loc;
      const dict = loc === 'es'
        ? { 'admin.finance.wh.title': 'Finanzas · Wolfhouse' }
        : loc === 'it'
          ? { 'admin.finance.wh.title': 'Finanze · Wolfhouse' }
          : {};
      window.portalT = (key) => dict[key] || key;
      document.getElementById('wh-admin-finance-body').innerHTML = renderWolfhouseCreatorFinanceHtml({ wolfhouse_creator_finance: projection });
    }, { projection: success, loc });
    const paintedTitle = await page.locator('h2').innerText();
    assert.equal(paintedTitle, title, loc + ' title');
    for (const width of [1280, 390]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((theme) => { document.documentElement.setAttribute('data-theme', theme); }, theme);
        const clipped = await page.evaluate(() => {
          const host = document.getElementById('wh-admin-finance-body');
          const amounts = [...host.querySelectorAll('[data-wh-fin-headline] .wh-fin-amt')];
          return amounts.some((el) => el.getBoundingClientRect().right > host.getBoundingClientRect().right + 1);
        });
        assert.equal(clipped, false, `${loc} ${theme} ${width} clips a headline`);
        console.log('PASS', loc, theme, width);
      }
    }
  }
  await browser.close();
}

paint().then(() => {
  console.log('PASS verify-wolfhouse-finance-creator-ui');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
