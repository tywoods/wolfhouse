'use strict';

/**
 * Cap review regressions for the Wolfhouse Finance creator screen.
 * Calls the real composed portal functions. Does not stub the loader.
 */
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function buildPortalHtml() {
  process.env.NODE_ENV = 'test';
  process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
  process.env.STAFF_AUTH_REQUIRED = 'false';
  process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
  process.env.STAFF_PORTAL_LOCALES = 'en,es,it';
  process.env.DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}scripts${path.sep}`)) delete require.cache[key];
  }
  const api = require('./staff-query-api');
  if (typeof api.buildUiHtmlForOfflineTest !== 'function') {
    throw new Error('Production staff UI builder seam is unavailable');
  }
  return api.buildUiHtmlForOfflineTest(0, 'wolfhouse-somo');
}

function rgb(value) {
  const text = String(value || '').trim();
  const hex = text.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const match = text.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function sameRgb(a, b) {
  const left = rgb(a);
  const right = rgb(b);
  return !!left && !!right && left.every((n, i) => n === right[i]);
}

async function proveComposedFinanceReview(fixtures) {
  const success = fixtures.success;
  const partial = fixtures.partial;
  const summaryBody = {
    success: true,
    client: 'wolfhouse-somo',
    location_id: '',
    summary: { redesign: { view: { granularity: 'month', range: success.scope.range } } },
    wolfhouse_creator_finance: success,
  };
  function envelopeFor(amountCents, granularity, start, end) {
    const proj = JSON.parse(JSON.stringify(success));
    proj.scope.range = Object.assign({}, proj.scope.range, { granularity, start, end });
    const luna = proj.creators.find((row) => row.creator === 'luna');
    luna.gross_receipts.amount_cents = amountCents;
    return {
      success: true,
      client: 'wolfhouse-somo',
      location_id: '',
      summary: { redesign: { view: { granularity, range: proj.scope.range } } },
      wolfhouse_creator_finance: proj,
    };
  }
  const weekEnvelope = envelopeFor(11100, 'week', '2026-10-12', '2026-10-18');
  const monthEnvelope = envelopeFor(22200, 'month', '2026-10-01', '2026-10-31');
  const html = buildPortalHtml();
  assert.equal(html.includes('--finance-bar-green:'), true, 'composed portal defines --finance-bar-green');
  assert.equal(/--green\s*:/.test(html), false, 'composed portal must not define --green');
  assert.equal(/--line\s*:/.test(html), false, 'composed portal must not define --line');

  const { buildClientProfilesMap, getAccessibleClients } = require('./lib/staff-portal-clients');
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (pathname === '/staff/ui') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (pathname === '/staff/auth/session') {
      const body = JSON.stringify({
        success: true,
        auth_required: false,
        role: 'owner',
        email: null,
        display_name: null,
        clients: getAccessibleClients(null),
        client_profiles: buildClientProfilesMap(null),
        can_use_owner_insights: true,
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(body);
    }
    if (pathname.startsWith('/staff/')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ success: true, rows: [], conversations: [], offerings: [], services: [] }));
    }
    res.writeHead(204);
    return res.end();
  });
  const base = await listen(server);
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const requests = [];
  const summaryCount = () => requests.filter((url) => !url.includes('creator_detail=')).length;
  let summaryMode = 'ok';
  let summaryHold = false;
  let detailMode = 'page1';
  const held = [];
  const heldSummaries = [];
  function detailEnvelope(detail, schema, cohortId) {
    return {
      success: true,
      summary: summaryBody.summary,
      wolfhouse_creator_finance: {
        schema_version: schema || 'wolfhouse.creator-finance.v1',
        cohort_id: cohortId || success.cohort_id,
        detail,
      },
    };
  }
  const pageOne = detailEnvelope({
    kind: 'payments',
    creator: null,
    currency: 'EUR',
    rows: [{ payment_id: 'p-page', booking_id: 'b-luna', receipt_date: '2026-10-02', amount_cents: 3000, purpose: 'deposit', creator: 'luna' }],
    page: { limit: 100, next_cursor: 'Mg', complete: false, matched_count: 2, returned_count: 1 },
    full_cohort_totals: { gross_receipts_cents: 15000, deposits_received_cents: 3000 },
  });
  const pageTwo = detailEnvelope({
    kind: 'payments',
    creator: null,
    currency: 'EUR',
    rows: [{ payment_id: 'p-next', booking_id: 'b-luna', receipt_date: '2026-10-04', amount_cents: 12000, purpose: 'balance', creator: 'luna' }],
    page: { limit: 100, next_cursor: null, complete: true, matched_count: 2, returned_count: 1 },
    full_cohort_totals: { gross_receipts_cents: 15000, deposits_received_cents: 3000 },
  });
  await page.route('**/staff/admin/finance/summary**', async (route) => {
    const url = route.request().url();
    requests.push(url);
    if (url.includes('creator_detail=')) {
      if (detailMode === 'hold') {
        await new Promise((resolve) => held.push({ route, url, resolve }));
        return;
      }
      if (detailMode === 'abort') return route.abort('failed');
      if (detailMode === '500') {
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'read failed' }) });
      }
      if (detailMode === 'bad-version') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(detailEnvelope({
            kind: 'payments',
            creator: 'luna',
            currency: 'EUR',
            rows: [{ payment_id: 'bad', amount_cents: 99999 }],
            page: { matched_count: 1, complete: true, returned_count: 1 },
            full_cohort_totals: { gross_receipts_cents: 99999 },
          }, 'wolfhouse.creator-finance.v0')),
        });
      }
      if (detailMode === 'missing-version') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, summary: summaryBody.summary, detail: { kind: 'payments', rows: [{ amount_cents: 88888 }] } }),
        });
      }
      if (detailMode === 'clock') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(detailEnvelope({
            kind: 'outstanding',
            creator: null,
            currency: 'EUR',
            rows: [{ booking_id: 'b-clock', current_balance_cents: 4400, as_of: '2026-10-17T12:05:00.000Z', creator: 'luna' }],
            page: { limit: 100, next_cursor: null, complete: true, matched_count: 1, returned_count: 1 },
            full_cohort_totals: { outstanding_cents: 4400 },
          })),
        });
      }
      if (detailMode === 'stale-once') {
        const asked = new URL(url).searchParams.get('cohort_id');
        if (asked !== 'whcf1_balance_changed_01') {
          return route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ success: false, error: 'finance summary refresh required', code: 'FINANCE_COHORT_STALE' }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(detailEnvelope({
            kind: 'payments',
            creator: 'luna',
            currency: 'EUR',
            rows: [{ payment_id: 'p-refreshed', booking_id: 'b-luna', receipt_date: '2026-10-02', amount_cents: 8800, purpose: 'other', creator: 'luna' }],
            page: { limit: 100, next_cursor: null, complete: true, matched_count: 1, returned_count: 1 },
            full_cohort_totals: { gross_receipts_cents: 33300, deposits_received_cents: 3000 },
          }, 'wolfhouse.creator-finance.v1', 'whcf1_balance_changed_01')),
        });
      }
      const cursor = new URL(url).searchParams.get('cursor');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(cursor ? pageTwo : pageOne),
      });
    }
    if (summaryMode === 'abort') return route.abort('failed');
    if (summaryMode === '500') {
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'read failed' }) });
    }
    if (summaryHold) {
      await new Promise((resolve) => heldSummaries.push({ route, url, resolve }));
      return;
    }
    if (summaryMode === 'week') {
      const gran = new URL(url).searchParams.get('granularity');
      if (gran === 'week') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(weekEnvelope),
        });
      }
    }
    if (summaryMode === 'refreshed') {
      const refreshed = JSON.parse(JSON.stringify(success));
      refreshed.cohort_id = 'whcf1_balance_changed_01';
      refreshed.as_of = '2026-10-17T12:05:00.000Z';
      refreshed.generated_at = '2026-10-17T12:05:00.000Z';
      if (refreshed.metrics && refreshed.metrics.outstanding_today) {
        refreshed.metrics.outstanding_today.as_of = '2026-10-17T12:05:00.000Z';
      }
      const luna = refreshed.creators.find((row) => row.creator === 'luna');
      luna.gross_receipts.amount_cents = 33300;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          client: 'wolfhouse-somo',
          location_id: '',
          summary: summaryBody.summary,
          wolfhouse_creator_finance: refreshed,
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(summaryBody) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'wolfhouse-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });
  await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.getElementById('c-client') && document.getElementById('c-client').value === 'wolfhouse-somo', null, { timeout: 30000 });
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.waitForSelector('#wh-admin-finance-body [data-wh-finance]', { timeout: 30000 });

  async function barProof(width, theme) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((next) => document.documentElement.setAttribute('data-theme', next), theme);
    const measured = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const bars = Array.from(document.querySelectorAll('#wh-admin-finance-body .wh-fin-bar'));
      const widest = bars.map((el) => {
        const box = el.getBoundingClientRect();
        return { width: box.width, height: box.height, background: getComputedStyle(el).backgroundColor, inline: el.style.width };
      }).filter((bar) => bar.inline && bar.inline !== '0%').sort((a, b) => b.width - a.width)[0];
      const card = document.querySelector('#wh-admin-finance-body .wh-fin-card');
      return {
        green: root.getPropertyValue('--green').trim(),
        line: root.getPropertyValue('--line').trim(),
        barToken: root.getPropertyValue('--finance-bar-green').trim(),
        borderToken: root.getPropertyValue('--border').trim(),
        bar: widest || null,
        cardBorder: card ? getComputedStyle(card).borderLeftColor : '',
      };
    });
    assert.equal(measured.green, '', `${theme} ${width} composed portal defines --green`);
    assert.equal(measured.line, '', `${theme} ${width} composed portal defines --line`);
    assert.equal(!!measured.barToken, true, `${theme} ${width} missing --finance-bar-green`);
    assert.equal(measured.bar && measured.bar.width > 4 && measured.bar.height >= 8, true, `${theme} ${width} chart bar is invisible ${JSON.stringify(measured.bar)}`);
    assert.equal(sameRgb(measured.bar.background, measured.barToken), true, `${theme} ${width} bar ${measured.bar.background} is not portal ${measured.barToken}`);
    assert.equal(sameRgb(measured.cardBorder, measured.borderToken), true, `${theme} ${width} card border ${measured.cardBorder} is not portal ${measured.borderToken}`);
    console.log('PASS R3 composed', theme, width, measured.bar.background, measured.bar.width);
  }
  for (const width of [1280, 390]) {
    for (const theme of ['light', 'dark']) await barProof(width, theme);
  }

  const counts = await page.locator('[data-wh-fin-creator-row="luna"] [data-wh-fin-booking-count]').innerText();
  const totalCount = await page.locator('[data-wh-fin-creator-row="total"] [data-wh-fin-booking-count]').innerText();
  assert.equal(counts.includes('1'), true, `R5 luna booking count missing: ${counts}`);
  assert.equal(totalCount.includes('2'), true, `R5 total booking count missing: ${totalCount}`);
  console.log('PASS R5 composed booking counts');

  const { renderWolfhouseCreatorFinanceHtml } = require('./browser/sunset-admin-finance-redesign-ui');
  const partialMarkup = renderWolfhouseCreatorFinanceHtml({ wolfhouse_creator_finance: partial });
  await page.evaluate((markup) => {
    document.getElementById('wh-admin-finance-body').insertAdjacentHTML('beforeend', `<div id="wh-fin-partial-proof">${markup}</div>`);
  }, partialMarkup);
  const partialNote = await page.evaluate(() => {
    const note = document.querySelector('#wh-fin-partial-proof [data-wh-fin-trend-partial="1"]');
    const rowNote = document.querySelector('#wh-fin-partial-proof [data-wh-fin-trend-note="partial"]');
    const style = note ? getComputedStyle(note) : null;
    return {
      text: note ? note.innerText : '',
      role: note ? note.getAttribute('role') : '',
      hidden: note ? note.getAttribute('aria-hidden') : 'missing',
      display: style ? style.display : '',
      height: note ? note.getBoundingClientRect().height : 0,
      rowText: rowNote ? rowNote.innerText : '',
    };
  });
  assert.equal(partialNote.role, 'note', 'R4 note is not accessible');
  assert.equal(partialNote.hidden, null, 'R4 note is hidden from assistive tech');
  assert.equal(partialNote.display === 'none' || partialNote.height < 1, false, `R4 note is not visible ${JSON.stringify(partialNote)}`);
  assert.equal(partialNote.text.includes('Some periods are partial.'), true, partialNote.text);
  assert.equal(partialNote.rowText.includes('This period is partial.'), true, partialNote.rowText);
  await page.evaluate(() => document.getElementById('wh-fin-partial-proof').remove());
  console.log('PASS R4 composed partial note');

  await page.setViewportSize({ width: 1280, height: 900 });
  const beforeDetail = requests.length;
  await page.locator('[data-wh-fin-headline="luna"]').click();
  await page.waitForSelector('[data-wh-fin-detail] [data-wh-fin-full-total="gross_receipts_cents"]', { timeout: 10000 });
  const firstDetail = requests.slice(beforeDetail).find((url) => url.includes('creator_detail=payments'));
  assert.equal(firstDetail.includes('creator=luna'), true, `R1 first detail dropped creator: ${firstDetail}`);
  assert.equal(firstDetail.includes('cursor='), false, `R1 first page sent a cursor: ${firstDetail}`);
  const pageOneTotal = await page.locator('[data-wh-fin-full-total="gross_receipts_cents"]').innerText();
  assert.equal(pageOneTotal.includes('150.00'), true, `R1 page one total changed: ${pageOneTotal}`);
  assert.equal(pageOneTotal.includes('30.00'), false, `R1 page one summed the page: ${pageOneTotal}`);
  await page.locator('[data-wh-fin-cursor="Mg"]').click();
  await page.waitForFunction(() => {
    const row = document.querySelector('[data-wh-fin-row="p-next"]');
    return !!row;
  }, null, { timeout: 10000 });
  const secondDetail = requests.filter((url) => url.includes('creator_detail=payments')).pop();
  assert.equal(secondDetail.includes('creator=luna'), true, `R1 More dropped creator: ${secondDetail}`);
  assert.equal(secondDetail.includes('cursor=Mg'), true, `R1 More dropped cursor: ${secondDetail}`);
  const pageTwoTotal = await page.locator('[data-wh-fin-full-total="gross_receipts_cents"]').innerText();
  assert.equal(pageTwoTotal.includes('150.00'), true, `R1 full cohort total changed after More: ${pageTwoTotal}`);
  const headers = await page.locator('[data-wh-fin-detail] th').allTextContents();
  assert.equal(headers.includes('Payment') && headers.includes('Amount') && headers.includes('Creator'), true, `R6 headers missing: ${headers.join('|')}`);
  console.log('PASS R1 creator scope and unchanged cohort total');
  console.log('PASS R6 composed column headers');

  async function clickFinanceLang(lang, title) {
    const clicked = await page.locator(`.staff-lang-btn[data-lang="${lang}"]`).count();
    if (clicked) await page.locator(`.staff-lang-btn[data-lang="${lang}"]`).click();
    else await page.evaluate((next) => window.setStaffLocale(next), lang);
    await page.waitForFunction((expected) => {
      const heading = document.querySelector('#wh-admin-finance-body h2');
      return !!(heading && heading.textContent === expected);
    }, title, { timeout: 10000 });
  }

  // Cap witness: page two + Spanish keeps page two, with no new Finance request.
  const beforePageLocale = requests.length;
  await clickFinanceLang('es', 'Finanzas · Wolfhouse');
  assert.equal(requests.length, beforePageLocale, 'page-two language change started a Finance request');
  assert.equal(await page.locator('#wh-admin-finance-body [data-wh-fin-row="p-next"]').count(), 1, 'Spanish dropped page two');
  const spanishDetail = await page.locator('#wh-admin-finance-body [data-wh-fin-detail]').innerText();
  assert.equal(spanishDetail.includes('Total completo'), true, `page two was not repainted in Spanish: ${spanishDetail.slice(0, 240)}`);
  assert.equal(await page.locator('#wh-admin-finance-body [data-wh-fin-detail] [data-wh-fin-cents="15000"]').count(), 1, 'page two lost the server cohort total');
  assert.equal(await page.locator('#wh-admin-finance-body [data-wh-fin-detail-creator="luna"]').count(), 1, 'page two lost Luna');
  await clickFinanceLang('en', 'Finance · Wolfhouse');
  assert.equal(requests.length, beforePageLocale, 'restoring English refetched page two');
  assert.equal(await page.locator('#wh-admin-finance-body [data-wh-fin-row="p-next"]').count(), 1, 'English dropped page two');
  console.log('PASS locale change keeps loaded page two');

  // Cap witness: a pending detail keeps its loading indicator across a language change.
  detailMode = 'hold';
  await page.locator('#wh-admin-finance-body [data-wh-fin-headline="luna"]').click();
  await page.waitForSelector('#wh-admin-finance-body [data-wh-fin-detail-state="loading"][data-wh-fin-detail-creator="luna"]', { timeout: 10000 });
  const beforePendingDetail = requests.length;
  await clickFinanceLang('it', 'Finanze · Wolfhouse');
  assert.equal(requests.length, beforePendingDetail, 'pending detail language change started a Finance request');
  assert.equal(await page.locator('#wh-admin-finance-body [data-wh-fin-detail-state="loading"]').count(), 1, 'pending detail language change dropped the loading indicator');
  const pendingText = await page.locator('#wh-admin-finance-body [data-wh-fin-detail-state="loading"]').innerText();
  assert.equal(pendingText.includes('Caricamento'), true, `loading indicator was not translated: ${pendingText}`);
  const heldDetail = held.shift();
  assert.equal(!!heldDetail, true, 'pending detail was not held');
  detailMode = 'page1';
  await heldDetail.route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pageOne) });
  heldDetail.resolve();
  await page.waitForSelector('#wh-admin-finance-body [data-wh-fin-row="p-page"]', { timeout: 10000 });
  console.log('PASS locale change keeps a pending detail loading');

  // Cap correction: an error detail stays, translated, and does not refetch.
  detailMode = '500';
  await page.locator('#wh-admin-finance-body [data-wh-fin-headline="staff"]').click();
  await page.waitForSelector('#wh-admin-finance-body [data-wh-fin-detail-state="error"][data-wh-fin-detail-creator="staff"]', { timeout: 10000 });
  const beforeErrorLocale = requests.length;
  await clickFinanceLang('es', 'Finanzas · Wolfhouse');
  assert.equal(requests.length, beforeErrorLocale, 'error detail language change started a Finance request');
  assert.equal(await page.locator('#wh-admin-finance-body [data-wh-fin-detail-state="error"][data-wh-fin-detail-creator="staff"]').count(), 1, 'language change dropped the detail error');
  assert.equal(await page.locator('#wh-admin-finance-body [data-wh-fin-detail-retry="1"]').count(), 1, 'language change dropped the detail retry');
  const errorText = await page.locator('#wh-admin-finance-body [data-wh-fin-detail-state="error"]').innerText();
  assert.equal(errorText.includes('No se pudieron cargar'), true, `detail error was not translated: ${errorText}`);
  detailMode = 'page1';
  await clickFinanceLang('en', 'Finance · Wolfhouse');
  assert.equal(requests.length, beforeErrorLocale, 'restoring English refetched the detail error');
  assert.equal(await page.locator('#wh-admin-finance-body [data-wh-fin-detail-state="error"][data-wh-fin-detail-creator="staff"]').count(), 1, 'English dropped the detail error');
  console.log('PASS locale change keeps a detail error');

  detailMode = 'abort';
  await page.locator('[data-wh-fin-headline="luna"]').click();
  await page.waitForSelector('[data-wh-fin-detail-state="error"][data-wh-fin-detail-creator="luna"]', { timeout: 10000 });
  const networkError = await page.locator('[data-wh-fin-detail-state="error"]').getAttribute('data-wh-fin-detail-kind');
  assert.equal(networkError, 'payments', 'R7 network error is not bound to payments');
  detailMode = 'page1';
  await page.locator('[data-wh-fin-detail-retry="1"]').click();
  await page.waitForSelector('[data-wh-fin-row="p-page"]', { timeout: 10000 });
  const retryUrl = requests.filter((url) => url.includes('creator_detail=payments')).pop();
  assert.equal(retryUrl.includes('creator=luna'), true, `R7 retry dropped creator: ${retryUrl}`);
  console.log('PASS R7 network fail retry');

  detailMode = '500';
  await page.locator('[data-wh-fin-headline="staff"]').click();
  await page.waitForSelector('[data-wh-fin-detail-state="error"][data-wh-fin-detail-creator="staff"]', { timeout: 10000 });
  assert.equal(await page.locator('[data-wh-fin-detail-retry="1"]').count(), 1, 'R7 HTTP 500 has no retry');
  console.log('PASS R7 HTTP 500');

  detailMode = 'hold';
  await page.locator('[data-wh-fin-headline="luna"]').click();
  await page.waitForSelector('[data-wh-fin-detail-state="loading"][data-wh-fin-detail-creator="luna"]', { timeout: 10000 });
  detailMode = '500';
  await page.locator('[data-wh-fin-headline="staff"]').click();
  await page.waitForSelector('[data-wh-fin-detail-state="error"][data-wh-fin-detail-creator="staff"]', { timeout: 10000 });
  const late = held.shift();
  await late.route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pageOne) });
  late.resolve();
  await page.waitForTimeout(50);
  const afterLate = await page.locator('[data-wh-fin-detail] [data-wh-fin-detail-state]').getAttribute('data-wh-fin-detail-creator');
  assert.equal(afterLate, 'staff', `R7 late luna response overwrote staff: ${afterLate}`);
  assert.equal(await page.locator('[data-wh-fin-row="p-page"]').count(), 0, 'R7 late luna rows painted over staff');
  console.log('PASS R7 selection-bound');

  detailMode = 'bad-version';
  await page.locator('[data-wh-fin-headline="luna"]').click();
  await page.waitForSelector('[data-wh-fin-detail-state="unsupported"]', { timeout: 10000 });
  const rejected = await page.locator('[data-wh-fin-detail]').innerText();
  assert.equal(rejected.includes('999'), false, `R8 painted a rejected amount: ${rejected}`);
  detailMode = 'missing-version';
  await page.locator('[data-wh-fin-headline="luna"]').click();
  await page.waitForSelector('[data-wh-fin-detail-state="unsupported"]', { timeout: 10000 });
  const missingVersion = await page.locator('[data-wh-fin-detail]').innerText();
  assert.equal(missingVersion.includes('888'), false, `R8 painted an unversioned amount: ${missingVersion}`);
  console.log('PASS R8 composed version reject');

  summaryMode = 'week';
  const beforeWeek = summaryCount();
  await page.locator('#wh-admin-finance-body [data-finance-gran="week"]').click();
  await page.waitForSelector('#wh-admin-finance-body [data-wh-fin-headline="luna"] [data-wh-fin-cents="11100"]', { timeout: 10000 });
  assert.equal(await page.locator('#wh-admin-finance-body [data-finance-gran="week"]').getAttribute('aria-selected'), 'true', 'week did not become the current result');
  assert.equal(summaryCount() > beforeWeek, true, 'week click made no request');
  summaryHold = true;
  const beforeMonth = summaryCount();
  await page.locator('#wh-admin-finance-body [data-finance-gran="month"]').click();
  await page.waitForSelector('#wh-admin-finance-body .portal-admin-finance-loading', { timeout: 10000 });
  assert.equal(heldSummaries.length, 1, 'month refresh was not held');
  assert.equal(heldSummaries[0].url.includes('granularity=month'), true, `held request was not month: ${heldSummaries[0].url}`);
  assert.equal(heldSummaries[0].url.includes('creator_detail='), false, `held request was a detail: ${heldSummaries[0].url}`);
  assert.equal(summaryCount(), beforeMonth + 1, 'month click did not start exactly one read');
  const beforePendingLang = summaryCount();
  const pendingLangClicked = await page.locator('.staff-lang-btn[data-lang="es"]').count();
  if (pendingLangClicked) await page.locator('.staff-lang-btn[data-lang="es"]').click();
  else await page.evaluate(() => window.setStaffLocale('es'));
  const pendingLangStart = Date.now();
  while (Date.now() - pendingLangStart < 400) await page.waitForTimeout(50);
  const duringPending = await page.locator('#wh-admin-finance-body').innerText();
  assert.equal(summaryCount(), beforePendingLang, 'R2 language change during a pending refresh started a new read');
  assert.equal(await page.locator('#wh-admin-finance-body .portal-admin-finance-loading').count(), 1, `R2 language change dropped loading: ${duringPending.slice(0, 220)}`);
  assert.equal(await page.locator('#wh-admin-finance-body [data-wh-fin-cents="11100"]').count(), 0, 'R2 language change restored the older week figures');
  assert.equal(duringPending.includes('Completo'), false, `R2 language change marked the older week result complete: ${duringPending.slice(0, 220)}`);
  assert.equal(await page.locator('#wh-admin-finance-body [data-wh-fin-state="complete"]').count(), 0, 'R2 language change restored a complete summary');
  const heldMonth = heldSummaries.shift();
  await heldMonth.route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(monthEnvelope),
  });
  heldMonth.resolve();
  await page.waitForSelector('#wh-admin-finance-body [data-wh-fin-headline="luna"] [data-wh-fin-cents="22200"]', { timeout: 10000 });
  const releasedMonth = await page.locator('#wh-admin-finance-body').innerText();
  assert.equal(await page.locator('#wh-admin-finance-body [data-wh-fin-cents="11100"]').count(), 0, 'released month response kept week figures');
  assert.equal(releasedMonth.includes('Completo'), true, `released month response did not paint in Spanish: ${releasedMonth.slice(0, 180)}`);
  assert.equal(await page.locator('#wh-admin-finance-body [data-finance-gran="month"]').getAttribute('aria-selected'), 'true', 'released response did not show month');
  console.log('PASS R2 language change during a pending refresh keeps loading');
  summaryHold = false;
  summaryMode = 'ok';
  await page.locator('#wh-admin-finance-body [data-finance-gran="month"]').click();
  await page.waitForSelector('#wh-admin-finance-body [data-wh-fin-headline="luna"] [data-wh-fin-cents="10000"]', { timeout: 10000 });
  if (await page.locator('.staff-lang-btn[data-lang="en"]').count()) await page.locator('.staff-lang-btn[data-lang="en"]').click();
  else await page.evaluate(() => window.setStaffLocale('en'));
  await page.waitForFunction(() => {
    const host = document.querySelector('#wh-admin-finance-body');
    return !!(host && host.innerText.includes('Complete') && !host.innerText.includes('Completo'));
  }, null, { timeout: 10000 });

  detailMode = 'clock';
  const beforeClock = summaryCount();
  const clockStart = requests.length;
  await page.locator('#wh-admin-finance-body [data-wh-fin-open="outstanding"]').click();
  await page.waitForSelector('#wh-admin-finance-body [data-wh-fin-row="b-clock"] [data-wh-fin-field="as_of"]', { timeout: 10000 });
  const clockUrl = requests.slice(clockStart).find((url) => url.includes('creator_detail=outstanding'));
  assert.equal(!!clockUrl, true, 'clock change made no outstanding detail request');
  assert.equal(clockUrl.includes('as_of='), false, `clock detail sent as_of: ${clockUrl}`);
  assert.equal(clockUrl.includes('_ts='), false, `clock detail sent a rejected cache key: ${clockUrl}`);
  assert.equal(clockUrl.includes(`cohort_id=${encodeURIComponent(success.cohort_id)}`), true, `clock detail dropped the cohort: ${clockUrl}`);
  assert.equal(summaryCount(), beforeClock, 'a later clock started a summary refresh');
  const clockText = await page.locator('#wh-admin-finance-body').innerText();
  assert.equal(clockText.includes('2026-10-17T12:05:00.000Z'), true, 'later outstanding clock was not shown as data');
  assert.equal(clockText.includes('older refresh'), false, `clock change painted stale: ${clockText.slice(0, 240)}`);
  assert.equal(await page.locator('#wh-admin-finance-body [data-wh-fin-detail-state="error"]').count(), 0, 'clock change painted a detail error');
  console.log('PASS clock change keeps the cohort and does not paint stale');

  detailMode = 'stale-once';
  summaryMode = 'refreshed';
  const staleStart = requests.length;
  await page.locator('#wh-admin-finance-body [data-wh-fin-headline="luna"]').click();
  await page.waitForSelector('#wh-admin-finance-body [data-wh-fin-row="p-refreshed"]', { timeout: 10000 });
  await page.waitForSelector('#wh-admin-finance-body [data-wh-fin-headline="luna"] [data-wh-fin-cents="33300"]', { timeout: 10000 });
  const staleUrls = requests.slice(staleStart);
  const staleDetails = staleUrls.filter((url) => url.includes('creator_detail='));
  const staleSummaries = staleUrls.filter((url) => !url.includes('creator_detail='));
  assert.equal(staleDetails.length, 2, `real 409 did not refresh then retry: ${staleDetails.join(' | ')}`);
  assert.equal(staleSummaries.length, 1, `real 409 did not make one summary refresh: ${staleSummaries.join(' | ')}`);
  assert.equal(staleDetails[0].includes(`cohort_id=${encodeURIComponent(success.cohort_id)}`), true, `first detail was not the old cohort: ${staleDetails[0]}`);
  assert.equal(staleDetails[1].includes('cohort_id=whcf1_balance_changed_01'), true, `retry did not use the refreshed cohort: ${staleDetails[1]}`);
  assert.equal(staleDetails[1].includes('creator=luna'), true, `retry dropped creator: ${staleDetails[1]}`);
  assert.equal(staleDetails[1].includes('as_of='), false, `retry sent as_of: ${staleDetails[1]}`);
  assert.equal(staleDetails[1].includes('cursor='), false, `retry reused the old cursor: ${staleDetails[1]}`);
  assert.equal(staleSummaries[0].includes('creator_detail='), false, `refresh was a detail: ${staleSummaries[0]}`);
  assert.equal(staleSummaries[0].includes('as_of='), false, `refresh sent as_of: ${staleSummaries[0]}`);
  const refreshedText = await page.locator('#wh-admin-finance-body').innerText();
  assert.equal(refreshedText.includes('88.00'), true, `refreshed detail did not paint: ${refreshedText.slice(0, 240)}`);
  assert.equal(refreshedText.includes('older refresh'), false, `real 409 left a stale banner: ${refreshedText.slice(0, 240)}`);
  assert.equal(await page.locator('#wh-admin-finance-body [data-wh-fin-detail-state="error"]').count(), 0, 'real 409 left a detail error');
  console.log('PASS real 409 refreshes the summary then paints the 200 detail');

  summaryMode = 'ok';
  detailMode = 'page1';
  await page.locator('#wh-admin-finance-body [data-finance-nav="today"]').click();
  await page.waitForSelector('#wh-admin-finance-body [data-wh-fin-headline="luna"] [data-wh-fin-cents="10000"]', { timeout: 10000 });

  summaryMode = 'abort';
  const beforeFail = summaryCount();
  await page.locator('#wh-admin-finance-body [data-finance-nav="today"]').click();
  await page.waitForSelector('#wh-admin-finance-body [role="alert"]', { timeout: 10000 });
  assert.equal(summaryCount() > beforeFail, true, 'R2 failed refresh made no request');
  const failedText = await page.locator('#wh-admin-finance-body').innerText();
  assert.equal(failedText.includes('100.00'), false, 'R2 failed refresh still shows cached figures');
  const beforeLang = summaryCount();
  const langClicked = await page.locator('.staff-lang-btn[data-lang="es"]').count();
  if (langClicked) await page.locator('.staff-lang-btn[data-lang="es"]').click();
  else await page.evaluate(() => window.setStaffLocale('es'));
  const langStart = Date.now();
  while (summaryCount() <= beforeLang && Date.now() - langStart < 8000) {
    await page.waitForTimeout(50);
  }
  assert.equal(summaryCount() > beforeLang, true, 'R2 language change made no new summary request');
  const langRequest = requests.filter((url) => !url.includes('creator_detail=')).pop();
  assert.equal(langRequest.includes('creator_detail='), false, `R2 language change fetched a detail: ${langRequest}`);
  await page.waitForSelector('#wh-admin-finance-body [role="alert"]', { timeout: 10000 });
  const afterText = await page.locator('#wh-admin-finance-body').innerText();
  assert.equal(afterText.includes('100.00'), false, `R2 language change showed cached figures: ${afterText.slice(0, 220)}`);
  assert.equal(/Could not|No se pudo|Impossibile|error/i.test(afterText), true, `R2 language change dropped the error: ${afterText.slice(0, 220)}`);
  console.log('PASS R2 language change refetches and keeps the error');

  while (held.length) {
    const late = held.shift();
    await late.route.abort('failed').catch(() => {});
    late.resolve();
  }
  while (heldSummaries.length) {
    const late = heldSummaries.shift();
    await late.route.abort('failed').catch(() => {});
    late.resolve();
  }
  await browser.close();
  await close(server);
}

module.exports = { proveComposedFinanceReview };
