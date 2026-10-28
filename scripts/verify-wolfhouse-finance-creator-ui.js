'use strict';

/**
 * Wolfhouse Finance creator screen. Consumes Skip's producer fixtures.
 * Run: node scripts/verify-wolfhouse-finance-creator-ui.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { renderFinanceRedesignHtml, renderWolfhouseCreatorFinanceHtml, renderWolfhouseCreatorFinanceDetailHtml } = require('./browser/sunset-admin-finance-redesign-ui');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'fixtures/wolfhouse-finance-creator-data');
const SHOTS = process.env.FINANCE_PROOF_DIR || path.join(ROOT, 'artifacts/finance-ui-01');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
}

function projectionOf(fixture) {
  return fixture.response.body.wolfhouse_creator_finance;
}

function detailOf(example) {
  return example.response.body.wolfhouse_creator_finance;
}

function check(label, cond) {
  assert.equal(!!cond, true, label);
  console.log('PASS', label);
}

const successFixture = loadFixture('success.json');
const success = projectionOf(successFixture);
const html = renderWolfhouseCreatorFinanceHtml(successFixture.response.body);
check('schema is the named v1', success.schema_version === 'wolfhouse.creator-finance.v1');
check('title', html.includes('Finance · Wolfhouse'));
check('booked value is above the legacy period controls', html.indexOf('data-wh-fin-headline="luna"') < html.indexOf('data-finance-nav="today"'));
check('luna headline uses producer cents', /data-wh-fin-headline="luna"[\s\S]*?data-wh-fin-cents="10000"[\s\S]*?€100\.00/.test(html));
check('staff headline uses producer booked cents', /data-wh-fin-headline="staff"[\s\S]*?data-wh-fin-cents="20000"[\s\S]*?€200\.00/.test(html));
check('luna and staff are named, not colour alone', html.includes('Luna-created') && html.includes('Staff-created'));
check('only Luna, Staff, and Total creator rows are shown', ['luna', 'staff', 'total'].every((creator) => html.includes(`data-wh-fin-creator-row="${creator}"`)) && !html.includes('data-wh-fin-creator-row="other_imported"') && !html.includes('data-wh-fin-creator-row="unattributed"'));
check('total visible at producer cents', /data-wh-fin-also="total"[\s\S]*?data-wh-fin-cents="15000"[\s\S]*?€150\.00/.test(html));
check('server share is shown, not invented', html.includes('data-wh-fin-share-bps="6667"') && html.includes('data-wh-fin-share-bps="3333"'));
check('deposits already included', html.includes('Already included in receipts above.') && html.includes('data-wh-fin-cents="3000"'));
check('outstanding independent and as-of', html.includes('Not limited to this period.') && html.includes('data-wh-fin-outstanding-as-of="1"') && html.includes(success.metrics.outstanding_today.as_of));
check('new booking value opens bookings', html.includes('New booking value') && /data-wh-fin-open="bookings"[\s\S]*?data-wh-fin-cents="30000"[\s\S]*?€300\.00/.test(html) && html.includes('data-wh-fin-count="2"'));
check('month default selected', /data-finance-gran="month"[^>]*aria-selected="true"/.test(html));
check('today week year custom retained', ['today', 'week', 'year', 'custom'].every((k) => html.includes(k === 'today' ? 'data-finance-nav="today"' : `data-finance-gran="${k}"`)));
check('arrival basis comes from the named field', html.includes('Booking value by arrival date') && html.includes(`data-wh-fin-date-basis="${success.arrival_date_report.date_basis}"`) && html.includes('data-wh-fin-open="arrival"'));
check('detail queries that are true become links', success.detail_queries.payments === true && html.includes('data-wh-fin-open="payments"') && html.includes('data-wh-fin-open="products"') && html.includes('data-wh-fin-open="warnings"'));
check('chart and table use producer buckets', html.includes('role="img"') && html.includes('<table') && html.includes('2026-10-02') && html.includes('€30.00') && html.includes('2026-10-04') && html.includes('€70.00'));
check('localized Madrid freshness footer', html.includes('<footer class="wh-fin-footer">') && html.includes('Europe/Madrid') && html.includes('Oct') && !html.includes('2026-10-15T12:00:00.000Z'));
check('headline amount is before its status word', (() => {
  const card = html.split('data-wh-fin-headline="staff"')[0];
  return card.lastIndexOf('data-wh-fin-cents="10000"') < card.lastIndexOf('data-wh-fin-state="complete"');
})());

const noArrival = JSON.parse(JSON.stringify(success));
delete noArrival.arrival_date_report.date_basis;
const noArrivalHtml = renderWolfhouseCreatorFinanceHtml({ wolfhouse_creator_finance: noArrival });
check('missing arrival basis is not invented', !noArrivalHtml.includes('data-wh-fin-date-basis='));

const closed = JSON.parse(JSON.stringify(success));
closed.detail_queries = Object.assign({}, success.detail_queries, { payments: false, bookings: false, arrival: false });
const closedHtml = renderWolfhouseCreatorFinanceHtml({ wolfhouse_creator_finance: closed });
check('false detail query is not a dead link', !closedHtml.includes('data-wh-fin-open="payments"') && !closedHtml.includes('data-wh-fin-open="bookings"') && !closedHtml.includes('data-wh-fin-open="arrival"') && closedHtml.includes('€100.00') && closedHtml.includes('€50.00'));

const partial = projectionOf(loadFixture('partial.json'));
const partialHtml = renderWolfhouseCreatorFinanceHtml({ wolfhouse_creator_finance: partial });
check('partial is not a complete split', partialHtml.includes('Not a complete split.') && partialHtml.includes('data-wh-fin-reason="mixed_currency"'));
check('summary warning string is shown', partial.warnings.includes('mixed_currency') && partialHtml.includes('data-wh-fin-open="warnings"'));
check('partial share stays blank', !/data-wh-fin-headline="luna"[\s\S]*?data-wh-fin-share-bps=/.test(partialHtml.split('data-wh-fin-headline="staff"')[0]));
check('partial does not invent EUR on excluded currency group', !/data-wh-fin-currency="USD"/.test(partialHtml));

const refunds = projectionOf(loadFixture('unavailable-refunds.json'));
const refundHtml = renderWolfhouseCreatorFinanceHtml({ wolfhouse_creator_finance: refunds });
check('unreadable refund is not zero', refundHtml.includes('data-wh-fin-reason="refund_ledger_unavailable"') && !/data-wh-fin-refunds="1"[\s\S]{0,700}€0\.00/.test(refundHtml));
check('gross remains when refunds are unavailable', refundHtml.includes('€100.00') && refundHtml.includes('€50.00'));

const empty = projectionOf(loadFixture('complete-empty.json'));
const emptyHtml = renderWolfhouseCreatorFinanceHtml({ wolfhouse_creator_finance: empty });
check('complete zero stays visible', emptyHtml.includes('€0.00') && emptyHtml.includes('No payments in this period.') && emptyHtml.includes('data-wh-fin-headline="luna"') && emptyHtml.includes('data-wh-fin-headline="staff"'));

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

for (const [kind, example] of Object.entries(successFixture.detail_examples)) {
  const detail = renderWolfhouseCreatorFinanceDetailHtml(detailOf(example));
  const totals = detailOf(example).detail.full_cohort_totals;
  check(`${kind} detail keeps the server cohort total`, Object.keys(totals).every((key) => detail.includes(`data-wh-fin-full-total="${key}"`)));
  if (kind === 'arrival') {
    check('arrival rows use named fields', detail.includes('data-wh-fin-field="check_in"') && detail.includes('data-wh-fin-field="check_out"') && detail.includes('2026-10-10'));
  }
  if (kind === 'warnings') {
    check('warning rows use named fields', detail.includes('data-wh-fin-field="reason_code"') && detail.includes('malformed_money') && detail.includes('data-wh-fin-field="component"'));
  }
  if (kind === 'products') {
    // The fixture clock is October 17: the October 20 service is outside MTD.
    check('product total is the MTD server field', detail.includes('data-wh-fin-full-total="product_amount_cents"') && detail.includes('€100.00') && detail.includes('data-wh-fin-count="1"'));
  }
}

const pages = loadFixture('multi-page.json').detail_pages;
const pageOne = renderWolfhouseCreatorFinanceDetailHtml(detailOf(pages[0]));
const pageSumCents = pages[0].response.body.wolfhouse_creator_finance.detail.rows.reduce((sum, row) => sum + row.amount_cents, 0);
check('detail uses full cohort total not page sum', pageOne.includes('data-wh-fin-full-total="gross_receipts_cents"') && pageOne.includes('€150.00') && pageOne.includes('data-wh-fin-matched="3"') && pageOne.includes('data-wh-fin-page-complete="false"') && pageOne.includes('data-wh-fin-cursor="Mg"') && pageSumCents === 8000 && !pageOne.includes('€80.00'));

for (const file of ['scripts/lib/staff-portal-i18n.js', 'scripts/lib/staff-portal-i18n-es.js']) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  check(file + ' has wolfhouse finance title', src.includes('admin.finance.wh.title'));
  check(file + ' has money received label', src.includes('admin.finance.wh.moneyReceived'));
}
check('italian title', fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8').includes('Finanze · Wolfhouse'));
check('spanish title', fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es.js'), 'utf8').includes('Finanzas · Wolfhouse'));

const ui = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
check('wolfhouse load is gated', ui.includes('function loadWolfhouseFinanceSummary') && ui.includes("getClient() === 'wolfhouse-somo'"));
check('stale cohort refresh', ui.includes('FINANCE_COHORT_STALE'));
const detailLoader = ui.slice(ui.indexOf('function loadWolfhouseCreatorFinanceDetail'), ui.indexOf('function loadWolfhouseFinanceSummary'));
const summaryLoader = ui.slice(ui.indexOf('function loadWolfhouseFinanceSummary'), ui.indexOf('function loadAdminFinanceSummary'));
check('detail identity is cohort_id, not request-time as_of', detailLoader.includes("'&cohort_id='") && !detailLoader.includes('as_of=') && !detailLoader.includes('&as_of') && !detailLoader.includes('as_of !==') && !detailLoader.includes('.as_of'));
check('a clock change does not clear the cohort or paint stale', !detailLoader.includes('financeLastCreator = null') && !detailLoader.includes('older refresh') && !detailLoader.includes('stale_generation'));
check('a real 409 refreshes the summary and retries the detail once', detailLoader.includes('financeDetailResume = { kind: kind, creator: creator }') && detailLoader.includes('opts.cohortRefresh') && summaryLoader.includes('pendingResume') && summaryLoader.includes('cohortRefresh: true') && summaryLoader.includes("cursor: ''"));
check('wolfhouse finance requests stay inside the contract query', !detailLoader.includes('_ts=') && !summaryLoader.includes('_ts='));
check('closed detail query does not fetch', ui.includes('queries[kind] === true'));
check('sunset load string remains', /getClient\(\) === 'sunset' \|\| getClient\(\) === 'wolfhouse-somo'/.test(ui));
check('stub presentation fixture is gone', !fs.existsSync(path.join(ROOT, 'fixtures/wolfhouse-finance-creator-ui/success.json')));

check('R1 keeps creator on the next page request', ui.includes("paging ? (financeDetailCreator || '')") && ui.includes("if (creator) q += '&creator='"));
check('R2 language change after a failed refresh refetches', ui.includes('financeWolfhouseLoadFailed') && ui.includes("getClient() === 'wolfhouse-somo' && financeWolfhouseLoadFailed"));
check('R2 pending refresh is not repainted as the last success', ui.includes("financeSummaryPhase === 'pending'") && ui.includes('financePaintSummaryPending') && ui.indexOf("financeSummaryPhase === 'pending'") < ui.indexOf("getClient() === 'wolfhouse-somo' && financeWolfhouseLoadFailed"));
check('R3 chart uses defined Finance-local mockup tokens', html.includes('--whf-blue:#6d9bac') && html.includes('var(--whf-blue)') && html.includes('--whf-line:#e4eaed') && html.includes('var(--whf-line)') && !html.includes('var(--green)') && !html.includes('var(--line)'));
check('R4 partial trend buckets have a visible named note', partialHtml.includes('data-wh-fin-trend-partial="1"') && partialHtml.includes('role="note"') && partialHtml.includes('Some periods are partial.') && partialHtml.includes('This period is partial.') && partialHtml.includes('data-wh-fin-trend-note="partial"') && partialHtml.includes('Another currency was excluded.') && !/wh-fin-trend-note[^>]*aria-hidden="true"/.test(partialHtml) && !/wh-fin-trend-note\{[^}]*display:\s*none/.test(partialHtml));
check('R5 creator comparison shows booking counts', /data-wh-fin-creator-row="luna"[\s\S]*?data-wh-fin-booking-count="1"[\s\S]*?data-wh-fin-count="1"/.test(html) && /data-wh-fin-creator-row="staff"[\s\S]*?data-wh-fin-count="1"/.test(html) && /data-wh-fin-creator-row="total"[\s\S]*?data-wh-fin-count="2"/.test(html) && html.includes('New bookings'));
const paymentsDetail = renderWolfhouseCreatorFinanceDetailHtml(detailOf(successFixture.detail_examples.payments));
check('R6 drilldown table has column headers', paymentsDetail.includes('<thead>') && paymentsDetail.includes('<th scope="col" data-wh-fin-col="payment_id">Payment</th>') && paymentsDetail.includes('<th scope="col" data-wh-fin-col="amount_cents">Amount</th>') && paymentsDetail.includes('data-wh-fin-field="amount_cents"'));
check('R7 detail failure is selection-bound with retry', ui.includes('data-wh-fin-detail-retry="1"') && ui.includes("financeDetailStatusHtml('loading'") && ui.includes('res.status >= 400') && ui.includes("financeDetailStatusHtml('error'"));
check('locale-only repaint keeps the open drilldown', ui.includes('function financeRepaintRetainedDetail') && ui.includes('financeRepaintRetainedDetail()') && ui.includes("financeRememberDetail('loading'") && ui.includes("financeRememberDetail('success'") && ui.includes("financeRememberDetail('error'") && summaryLoader.includes('financeClearRetainedDetail()'));
const rejectedVersions = [
  { schema_version: 'wolfhouse.creator-finance.v0', marker: '99999' },
  { schema_version: 'wolfhouse.creator-finance.v1-extra', marker: '77777' },
  { schema_version: 'wolfhouse.creator-finance.v10', marker: '66666' },
];
check('R8 rejects a detail that is not the exact contract version', rejectedVersions.every((bad) => {
  const rendered = renderWolfhouseCreatorFinanceDetailHtml({
    schema_version: bad.schema_version,
    detail: { kind: 'payments', currency: 'EUR', rows: [{ payment_id: 'x', amount_cents: Number(bad.marker) }], full_cohort_totals: { gross_receipts_cents: Number(bad.marker) } },
  });
  return rendered.includes('data-wh-fin-detail-state="unsupported"') && !rendered.includes(bad.marker) && !rendered.includes('data-wh-fin-row=');
}) && renderWolfhouseCreatorFinanceDetailHtml({ detail: { kind: 'payments', rows: [{ amount_cents: 88888 }] } }).includes('unsupported') && !renderWolfhouseCreatorFinanceDetailHtml({ detail: { kind: 'payments', rows: [{ amount_cents: 88888 }] } }).includes('88888'));

const laterClock = '2026-10-17T12:05:00.000Z';
const clockProjection = JSON.parse(JSON.stringify(success));
clockProjection.as_of = laterClock;
clockProjection.generated_at = laterClock;
clockProjection.metrics.outstanding_today.as_of = laterClock;
const clockHtml = renderWolfhouseCreatorFinanceHtml({ wolfhouse_creator_finance: clockProjection });
check('a later summary clock is not a stale banner', clockHtml.includes('17 Oct 2026') && clockHtml.includes(`data-wh-fin-cohort="${success.cohort_id}"`) && !clockHtml.includes('older refresh') && !clockHtml.includes('stale_generation'));
const clockDetail = renderWolfhouseCreatorFinanceDetailHtml({
  schema_version: 'wolfhouse.creator-finance.v1',
  cohort_id: success.cohort_id,
  detail: {
    kind: 'outstanding',
    currency: 'EUR',
    rows: [{ booking_id: 'b-clock', current_balance_cents: 4400, as_of: laterClock, creator: 'luna' }],
    page: { matched_count: 1, complete: true, returned_count: 1 },
    full_cohort_totals: { outstanding_cents: 4400 },
  },
});
check('an outstanding row clock is data, not a stale banner', clockDetail.includes('data-wh-fin-field="as_of"') && clockDetail.includes(laterClock) && clockDetail.includes('€44.00') && !clockDetail.includes('older refresh'));

async function paint() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setContent('<!doctype html><html data-theme="light"><head><style>:root{--surface:#fff;--text:#14211c;--line:#d7ddd8;--green:#1f7a4d}[data-theme="dark"]{--surface:#24302b;--text:#f4f1ea;--line:#3d4a44;--green:#8dceb0}body{margin:0;background:var(--surface);color:var(--text);font-family:sans-serif}</style></head><body><div id="wh-admin-finance-body"></div></body></html>');
  await page.addScriptTag({ path: path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js') });
  const locales = { en: 'Finance · Wolfhouse', es: 'Finanzas · Wolfhouse', it: 'Finanze · Wolfhouse' };
  for (const [loc, title] of Object.entries(locales)) {
    await page.evaluate(({ envelope, loc }) => {
      window.portalLang = loc;
      window.getStaffLocale = () => loc;
      const dict = loc === 'es'
        ? { 'admin.finance.wh.title': 'Finanzas · Wolfhouse', 'admin.finance.wh.creator.luna': 'Creadas por Luna', 'admin.finance.wh.creator.staff': 'Creadas por el equipo' }
        : loc === 'it'
          ? { 'admin.finance.wh.title': 'Finanze · Wolfhouse', 'admin.finance.wh.creator.luna': 'Create da Luna', 'admin.finance.wh.creator.staff': 'Create dallo staff' }
          : {};
      window.portalT = (key) => dict[key] || key;
      document.getElementById('wh-admin-finance-body').innerHTML = renderWolfhouseCreatorFinanceHtml(envelope);
    }, { envelope: successFixture.response.body, loc });
    const paintedTitle = await page.locator('h2').innerText();
    assert.equal(paintedTitle, title, loc + ' title');
    for (const width of [1280, 390]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((theme) => { document.documentElement.setAttribute('data-theme', theme); }, theme);
        const geometry = await page.evaluate(() => {
          const host = document.getElementById('wh-admin-finance-body');
          const luna = host.querySelector('[data-wh-fin-headline="luna"]');
          const staff = host.querySelector('[data-wh-fin-headline="staff"]');
          const lunaAmt = luna.querySelector('.wh-fin-amt');
          const staffAmt = staff.querySelector('.wh-fin-amt');
          const hostBox = host.getBoundingClientRect();
          const boxes = [lunaAmt, staffAmt].map((el) => el.getBoundingClientRect());
          return {
            lunaText: luna.querySelector('.wh-fin-kicker').textContent,
            staffText: staff.querySelector('.wh-fin-kicker').textContent,
            lunaAmt: lunaAmt.textContent,
            staffAmt: staffAmt.textContent,
            lunaSize: parseFloat(getComputedStyle(lunaAmt).fontSize),
            staffSize: parseFloat(getComputedStyle(staffAmt).fontSize),
            lunaTop: luna.getBoundingClientRect().top,
            staffTop: staff.getBoundingClientRect().top,
            lunaRight: luna.getBoundingClientRect().right,
            staffLeft: staff.getBoundingClientRect().left,
            staffBottom: staff.getBoundingClientRect().bottom,
            clipped: boxes.some((box) => box.right > hostBox.right + 1 || box.left < hostBox.left - 1 || box.width < 20),
            overflow: [lunaAmt, staffAmt].some((el) => el.scrollWidth > el.clientWidth + 1),
          };
        });
        assert.equal(geometry.clipped, false, `${loc} ${theme} ${width} clips a headline`);
        assert.equal(geometry.overflow, false, `${loc} ${theme} ${width} overflows a headline amount`);
        assert.equal(geometry.lunaAmt.includes('100'), true, `${loc} luna amount readable`);
        assert.equal(geometry.staffAmt.includes('200'), true, `${loc} staff amount readable`);
        assert.equal(geometry.lunaSize, geometry.staffSize, `${loc} ${width} headline sizes differ`);
        assert.equal(geometry.lunaSize, width === 390 ? 27 : 29, `${loc} ${width} mockup headline size ${geometry.lunaSize}`);
        if (width === 1280) {
          assert.equal(Math.abs(geometry.lunaTop - geometry.staffTop) < 4, true, '1280 headlines are not side by side');
          assert.equal(geometry.staffLeft >= geometry.lunaRight - 1, true, '1280 staff does not sit beside luna');
          // Part 2 places the labelled month/source controls above the cards (English bottom ~466px).
          assert.equal(geometry.staffBottom < 500, true, '1280 headlines are not up top: ' + geometry.staffBottom);
        } else {
          assert.equal(Math.abs(geometry.staffTop - geometry.lunaTop) < 4, true, '390 source cards follow the mockup two-column grid');
          assert.equal(geometry.staffLeft >= geometry.lunaRight - 1, true, '390 source cards overlap');
          assert.equal(geometry.staffBottom < 900, true, '390 source headlines fall below the first screen');
        }
        if (loc === 'en' && theme === 'light') {
          await page.screenshot({ path: path.join(SHOTS, `wh-finance-${width}-light.png`), fullPage: false });
        }
        console.log('PASS', loc, theme, width, geometry.lunaText, geometry.lunaAmt, geometry.staffText, geometry.staffAmt);
      }
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const motion = await page.evaluate(() => getComputedStyle(document.querySelector('.wh-fin-amt')).animationName);
  assert.equal(motion === 'none' || motion === '', true, 'reduced motion');
  await browser.close();
}

let hasPlaywright = true;
try { require.resolve('playwright'); } catch (_e) { hasPlaywright = false; }
const visualProof = hasPlaywright
  ? paint()
  : Promise.resolve(console.log('SKIP visual proof: playwright is not installed'));
const reviewProof = hasPlaywright
  ? visualProof.then(() => {
    const { proveComposedFinanceReview } = require('./verify-wolfhouse-finance-creator-ui-review');
    return proveComposedFinanceReview({ success, partial });
  })
  : visualProof;
reviewProof.then(() => {
  console.log('PASS verify-wolfhouse-finance-creator-ui');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
