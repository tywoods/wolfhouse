'use strict';

/**
 * verify:sunset-finance-custom-range-picker
 *
 * Release authority is a real production-generated /staff/ui Playwright journey:
 * - createSunsetAdminVerifyServer → cooked /staff/ui
 * - intercept only /staff/admin/finance/summary backend responses
 * - enter Admin Finance through real DOM controls
 * - click actual Custom / calendar day buttons (no financeOpenCustomRangePicker calls)
 *
 * Unit / source-shape checks remain supplementary only (false confidence alone).
 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');

process.env.STAFF_AUTH_REQUIRED = String(false);
process.env.STAFF_AUTH_ALLOW_OPEN = String(true);
process.env.NODE_ENV = 'test';
process.env.DEFAULT_CLIENT_SLUG = 'sunset';
process.env.STAFF_PORTAL_LOCALES = 'en,es,it';
process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'false';
process.env.SUNSET_ADMIN_WRITES_ENABLED = 'true';

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${extra != null ? ` — ${extra}` : ''}`);
  }
}
function equal(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
function loadPlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    const shared = '/opt/wolfhouse/WH/node_modules/playwright';
    if (fs.existsSync(path.join(shared, 'package.json'))) return require(shared);
    console.error('Playwright required: install playwright and Chromium; verifier fails closed.');
    process.exit(2);
  }
}

// ── Shared summary fixtures (server-shape, no UI reconstruction) ──
const { computeSunsetFinanceSummary } = require('./lib/sunset-finance-summary');

function baseArgs(view) {
  return {
    now: new Date('2026-08-15T12:00:00Z'),
    timeZone: 'Europe/Madrid',
    view: view || { granularity: 'month', anchor: '2026-08-15' },
    bsr: [
      {
        booking_id: 'B1',
        service_date: '2026-08-12',
        service_type: 'surf_lesson',
        amount_due_cents: 9900,
        quantity: 1,
        metadata: { component: 'course' },
      },
      {
        booking_id: 'B2',
        service_date: '2026-08-20',
        service_type: 'surf_lesson',
        amount_due_cents: 5500,
        quantity: 1,
        metadata: { component: 'course' },
      },
    ],
    payments: [
      { booking_id: 'B1', amount_paid_cents: 9900, paid_at: '2026-08-12T10:00:00Z', status: 'paid' },
      { booking_id: 'B2', amount_paid_cents: 5500, paid_at: '2026-08-20T10:00:00Z', status: 'paid' },
    ],
    bookings: [
      { booking_id: 'B1', total_amount_cents: 9900 },
      { booking_id: 'B2', total_amount_cents: 5500 },
    ],
    surf_packs: [],
    rental_stock: [],
  };
}

/** Mirror resolvePrimaryRange: incomplete custom falls through to month. */
function resolveLikeServer(query) {
  const g = String(query.granularity || 'month').toLowerCase();
  const start = query.start ? String(query.start).slice(0, 10) : '';
  const end = query.end ? String(query.end).slice(0, 10) : '';
  const anchor = query.anchor ? String(query.anchor).slice(0, 10) : '2026-08-15';
  if (g === 'custom' && start && end && start <= end) {
    return { granularity: 'custom', start, end, anchor: start };
  }
  if (g === 'day') return { granularity: 'day', anchor };
  if (g === 'year') return { granularity: 'year', anchor };
  // custom without valid start+end → month (root-cause fallthrough)
  return { granularity: 'month', anchor: anchor || '2026-08-15' };
}

function summaryForQuery(query) {
  const view = resolveLikeServer(query);
  return computeSunsetFinanceSummary(baseArgs(view));
}

function parseFinanceUrl(rawUrl) {
  const u = new URL(rawUrl, 'http://local.test');
  const q = {};
  u.searchParams.forEach((v, k) => {
    q[k] = v;
  });
  return q;
}

function isIncompleteCustom(q) {
  return String(q.granularity || '').toLowerCase() === 'custom' && !(q.start && q.end);
}

function isCompleteCustom(q, start, end) {
  return (
    String(q.granularity || '').toLowerCase() === 'custom' &&
    q.start === start &&
    q.end === end
  );
}

// ── Supplementary unit / source-shape checks (not release authority) ──
function runSupplementaryUnitChecks() {
  console.log('\n[supplementary] unit/source-shape (not release authority)\n');

  function scheduleCreateDateRangeIsValidIso(iso) {
    iso = String(iso || '').slice(0, 10);
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(iso)) return false;
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d;
  }
  function scheduleCreateDateRangeSelectDay(state, iso) {
    state = state || {};
    var start = state.start ? String(state.start).slice(0, 10) : null;
    var end = state.end ? String(state.end).slice(0, 10) : null;
    iso = String(iso || '').slice(0, 10);
    if (!scheduleCreateDateRangeIsValidIso(iso)) return { start: start, end: end };
    if (!start || (start && end)) return { start: iso, end: null };
    if (iso < start) return { start: iso, end: null };
    return { start: start, end: iso };
  }

  let st = scheduleCreateDateRangeSelectDay({}, '2026-08-10');
  ok('helper first click holds start only', st.start === '2026-08-10' && st.end == null);
  st = scheduleCreateDateRangeSelectDay(st, '2026-08-15');
  ok('helper second later click sets end', st.start === '2026-08-10' && st.end === '2026-08-15');
  st = scheduleCreateDateRangeSelectDay({}, '2026-08-10');
  st = scheduleCreateDateRangeSelectDay(st, '2026-08-10');
  ok('helper same-day second click start===end', st.start === '2026-08-10' && st.end === '2026-08-10');
  st = scheduleCreateDateRangeSelectDay({ start: '2026-08-15', end: null }, '2026-08-10');
  ok('helper reverse second click restarts start', st.start === '2026-08-10' && st.end == null);

  const adminSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
  ok(
    'source uses (state, iso) order',
    /scheduleCreateDateRangeSelectDay\(\s*financeCustomRangeDraft[^,]*,\s*iso\s*\)/.test(adminSrc)
  );
  ok(
    'source does not use (iso, state) order',
    !/scheduleCreateDateRangeSelectDay\(\s*iso\s*,\s*financeCustomRangeDraft/.test(adminSrc)
  );
  ok(
    'source Custom gran opens client picker (no openCustomPicker reload)',
    /gran\s*!==\s*['"]custom['"][\s\S]{0,1200}financeOpenCustomRangePicker\(\s*body\s*\)/.test(adminSrc) &&
      !/loadAdminFinanceSummary\(\s*\{\s*openCustomPicker\s*:\s*true\s*\}\s*\)/.test(adminSrc)
  );
  ok(
    'source does not request incomplete custom via openCustomPicker on gran click',
    !/loadAdminFinanceSummary\(\s*\{\s*openCustomPicker\s*:\s*true\s*\}\s*\)/.test(adminSrc)
  );
  ok(
    'source ensure/host path for custom pop (client overlay)',
    /function\s+financeEnsureCustomRangePop/.test(adminSrc) &&
      /pfb-custom-row--client-host/.test(adminSrc)
  );
  ok(
    'source Clear does not load incomplete custom summary',
    /act\s*===\s*['"]clear['"][\s\S]{0,200}financeCustomRangeDraft\s*=\s*\{\s*start:\s*null/.test(adminSrc) &&
      !/act\s*===\s*['"]clear['"][\s\S]{0,180}loadAdminFinanceSummary\s*\(/.test(adminSrc)
  );
}

async function waitPortal(page) {
  await page.waitForFunction(
    () => {
      const select = document.getElementById('c-client');
      return (
        document.body &&
        !document.body.classList.contains('portal-profile-pending') &&
        select &&
        select.value === 'sunset' &&
        select.options.length > 1
      );
    },
    null,
    { timeout: 30000 }
  );
  await page.locator('button.tab-btn[data-tab="admin"]').waitFor({ state: 'visible', timeout: 20000 });
}

async function openAdminFinance(page) {
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.waitForSelector('#tab-admin.tab-panel.active');
  await page.waitForSelector('#admin-finance-body .portal-admin-finance--b, #admin-finance-body .pf-card, #admin-finance-body .pfb-card', {
    timeout: 15000,
  });
}

async function clickCustom(page) {
  await page.locator('#admin-finance-body [data-finance-gran="custom"]').click();
}

async function calendarVisible(page) {
  return page.evaluate(() => {
    const pop = document.getElementById('pfb-custom-range-pop');
    if (!pop) return { ok: false, reason: 'no-pop' };
    const style = window.getComputedStyle(pop);
    const hidden = pop.hidden || style.display === 'none' || style.visibility === 'hidden';
    const days = pop.querySelectorAll('[data-pfb-day]').length;
    const cal = !!pop.querySelector('.pfb-cal, .pfb-cal-grid');
    return {
      ok: !hidden && days >= 28 && cal,
      hidden,
      days,
      cal,
      display: style.display,
      htmlLen: (pop.innerHTML || '').length,
    };
  });
}

async function waitCalendar(page, timeout = 2500) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    last = await calendarVisible(page);
    if (last.ok) return last;
    await sleep(40);
  }
  return last || { ok: false, reason: 'timeout' };
}

async function clickDay(page, iso) {
  await page.locator(`#pfb-custom-range-pop [data-pfb-day="${iso}"]`).click();
}

async function main() {
  runSupplementaryUnitChecks();

  console.log('\n[real-page] production /staff/ui Playwright journey\n');

  const playwright = loadPlaywright();
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const requests = [];
  const pageErrors = [];
  const consoleErrors = [];
  const shotDir = path.join(ROOT, 'tmp', 'finance-custom-range-picker');
  fs.mkdirSync(shotDir, { recursive: true });

  page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await context.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });

  await page.route('**/staff/admin/finance/summary**', async (route) => {
    const reqUrl = route.request().url();
    const q = parseFinanceUrl(reqUrl);
    const entry = {
      url: reqUrl,
      query: q,
      incompleteCustom: isIncompleteCustom(q),
      at: Date.now(),
    };
    requests.push(entry);
    const summary = summaryForQuery(q);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, summary }),
    });
  });

  try {
    // ── Cooked page identity ──
    const uiRes = await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    ok('served /staff/ui 200', uiRes && uiRes.status() === 200);
    const uiHtml = await page.content();
    ok('cooked page includes financeOpenCustomRangePicker module', uiHtml.includes('financeOpenCustomRangePicker'));
    ok('cooked page includes renderFinanceRedesignHtml', uiHtml.includes('renderFinanceRedesignHtml'));
    ok(
      'cooked page includes scheduleCreateDateRangeSelectDay',
      uiHtml.includes('function scheduleCreateDateRangeSelectDay') ||
        uiHtml.includes('scheduleCreateDateRangeSelectDay=') ||
        /scheduleCreateDateRangeSelectDay\s*=\s*function|function\s+scheduleCreateDateRangeSelectDay/.test(uiHtml)
    );

    await waitPortal(page);
    const beforeOpen = requests.length;
    await openAdminFinance(page);
    ok('Admin Finance open issues summary request', requests.length > beforeOpen);
    ok(
      'initial paint is redesign (month home)',
      (await page.locator('#admin-finance-body .portal-admin-finance--b').count()) > 0
    );
    ok(
      'Month gran selected on home',
      await page.locator('#admin-finance-body [data-finance-gran="month"].is-on, #admin-finance-body [data-finance-gran="month"][aria-selected="true"]').count().then((n) => n > 0)
    );
    const monthLabelBefore = await page.locator('#admin-finance-body [data-finance-range-label]').innerText().catch(() => '');
    ok('range label present before Custom', !!monthLabelBefore && monthLabelBefore.length > 2);

    // ── Listener survival pre-check: note wired flag + real body identity ──
    const bodyIdentityBefore = await page.evaluate(() => {
      const body = document.getElementById('admin-finance-body');
      if (!body) return null;
      const token = `verify-body-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      body.dataset.verifyBodyIdentity = token;
      return {
        wired: body.dataset.financeNavWired === '1',
        token,
      };
    });
    ok('stable #admin-finance-body listener wired after first paint', !!(bodyIdentityBefore && bodyIdentityBefore.wired));
    ok('stamped real #admin-finance-body identity token', !!(bodyIdentityBefore && bodyIdentityBefore.token));

    // ── PRIMARY: one click Custom → visible calendar, no incomplete custom request ──
    const reqBeforeCustom = requests.length;
    const cardsTextBefore = await page.locator('#admin-finance-body .pfb-hero, #admin-finance-body .pfb-card').first().innerText().catch(() => '');
    await clickCustom(page);
    const cal = await waitCalendar(page, 3000);
    await page.screenshot({ path: path.join(shotDir, '01-after-custom-click.png'), fullPage: false }).catch(() => {});

    ok(
      'Custom click opens visible populated real calendar (primary product behavior)',
      !!(cal && cal.ok),
      cal ? JSON.stringify(cal) : 'no result'
    );

    // Allow a brief moment for any buggy deferred fetch
    await sleep(350);
    const afterCustomReqs = requests.slice(reqBeforeCustom);
    const incomplete = afterCustomReqs.filter((r) => r.incompleteCustom);
    ok(
      'Custom click does not issue incomplete custom summary request (granularity=custom without start+end)',
      incomplete.length === 0,
      incomplete.map((r) => r.url).join(' | ') || 'none'
    );
    ok(
      'Custom click does not refetch finance summary before dates chosen',
      afterCustomReqs.length === 0,
      afterCustomReqs.map((r) => r.url).join(' | ') || `${afterCustomReqs.length} reqs`
    );

    // Cards may remain underneath
    if (cal && cal.ok) {
      const stillHasCards = (await page.locator('#admin-finance-body .pfb-card, #admin-finance-body .pfb-hero').count()) > 0;
      ok('current summary/cards remain while picker open', stillHasCards);
      // Month still the painted gran until complete range applied
      const customOn = await page.locator('#admin-finance-body [data-finance-gran="custom"].is-on').count();
      // Either month still on (preferred) or custom shell — both acceptable if calendar is open without invalid fetch
      ok('picker open without throw', pageErrors.length === 0, pageErrors.join('; '));
      void customOn;
      void cardsTextBefore;
    } else {
      // RED diagnostics: prove base bug sequence
      ok(
        'RED evidence: base issues incomplete custom request after Custom click',
        incomplete.length >= 1 || afterCustomReqs.some((r) => String(r.query.granularity) === 'custom'),
        afterCustomReqs.map((r) => r.url).join(' | ')
      );
      const popAfter = await page.evaluate(() => {
        const pop = document.getElementById('pfb-custom-range-pop');
        const gOn = Array.from(document.querySelectorAll('#admin-finance-body [data-finance-gran].is-on')).map((b) =>
          b.getAttribute('data-finance-gran')
        );
        return { hasPop: !!pop, granOn: gOn };
      });
      ok(
        'RED evidence: repaint has no usable custom pop / calendar',
        !popAfter.hasPop || !(cal && cal.ok),
        JSON.stringify(popAfter)
      );
    }

    // If calendar did not open, remaining journey cannot run productively — still assert fail counts and exit.
    if (!(cal && cal.ok)) {
      await page.screenshot({ path: path.join(shotDir, '99-red-no-calendar.png'), fullPage: true }).catch(() => {});
      console.log('\n  (journey short-circuited: calendar not open — RED)\n');
    } else {
      // ── Month navigation inside calendar ──
      const headBefore = await page.locator('#pfb-custom-range-pop .pfb-cal-head span').innerText();
      await page.locator('#pfb-custom-range-pop [data-pfb-cal="next"]').click();
      const headNext = await page.locator('#pfb-custom-range-pop .pfb-cal-head span').innerText();
      ok('calendar next month navigates', headNext !== headBefore, `${headBefore} → ${headNext}`);
      await page.locator('#pfb-custom-range-pop [data-pfb-cal="prev"]').click();
      const headBack = await page.locator('#pfb-custom-range-pop .pfb-cal-head span').innerText();
      ok('calendar prev month navigates back', headBack === headBefore, `${headNext} → ${headBack}`);

      // Ensure Aug 2026 for deterministic day buttons (navigate if needed)
      async function ensureYm(ym) {
        for (let i = 0; i < 24; i += 1) {
          const cur = await page.locator('#pfb-custom-range-pop .pfb-cal-head span').innerText();
          if (cur.trim() === ym) return true;
          // compare YYYY-MM
          if (cur.trim() < ym) await page.locator('#pfb-custom-range-pop [data-pfb-cal="next"]').click();
          else await page.locator('#pfb-custom-range-pop [data-pfb-cal="prev"]').click();
          await sleep(20);
        }
        return false;
      }
      ok('navigate calendar to 2026-08', await ensureYm('2026-08'));

      // ── Reverse first/second date reset ──
      const reqBeforeReverse = requests.length;
      await clickDay(page, '2026-08-15');
      await sleep(50);
      await clickDay(page, '2026-08-10'); // earlier → restart start
      await sleep(50);
      // Should still be open, no fetch yet
      ok(
        'reverse earlier day keeps picker open (no complete range yet)',
        (await calendarVisible(page)).ok
      );
      ok(
        'reverse earlier day issues no summary request',
        requests.length === reqBeforeReverse
      );
      // complete with later day
      await clickDay(page, '2026-08-18');
      await sleep(100);
      // wait for custom summary paint
      await page.waitForFunction(
        () => {
          const on = document.querySelector('#admin-finance-body [data-finance-gran="custom"].is-on');
          return !!on;
        },
        null,
        { timeout: 8000 }
      ).catch(() => {});

      const reverseReqs = requests.slice(reqBeforeReverse);
      const completeRev = reverseReqs.find((r) => isCompleteCustom(r.query, '2026-08-10', '2026-08-18'));
      ok(
        'complete range after reverse issues exact custom&start&end',
        !!completeRev,
        reverseReqs.map((r) => r.url).join(' | ')
      );
      if (completeRev) {
        const qs = completeRev.url.split('?')[1] || '';
        ok(
          'authenticated-shape query has granularity=custom&start=2026-08-10&end=2026-08-18',
          /granularity=custom/.test(qs) && /start=2026-08-10/.test(qs) && /end=2026-08-18/.test(qs)
        );
        ok('request includes client=sunset scope', /[?&]client=sunset(?:&|$)/.test(completeRev.url));
      }

      const customSelected = await page.locator('#admin-finance-body [data-finance-gran="custom"].is-on').count();
      ok('custom remains selected after complete range', customSelected > 0);
      const rangeLabel = await page.locator('#admin-finance-body [data-finance-range-label]').innerText();
      ok(
        'range label shows custom start – end',
        /2026-08-10/.test(rangeLabel) && /2026-08-18/.test(rangeLabel),
        rangeLabel
      );
      const triggerText = await page.locator('#pfb-custom-range-trigger').innerText().catch(() => '');
      ok(
        'custom trigger label matches range',
        /2026-08-10/.test(triggerText) && /2026-08-18/.test(triggerText),
        triggerText
      );
      ok(
        'cards repaint under custom view',
        (await page.locator('#admin-finance-body .pfb-card').count()) > 0
      );
      await page.screenshot({ path: path.join(shotDir, '02-after-range-applied.png'), fullPage: false }).catch(() => {});

      // ── Reopen trigger after rerender ──
      const reqBeforeReopen = requests.length;
      await page.locator('#pfb-custom-range-trigger, #admin-finance-body [data-finance-nav="open-custom-range"]').first().click();
      const cal2 = await waitCalendar(page, 2500);
      ok('reopening trigger after rerender opens calendar', !!(cal2 && cal2.ok), cal2 ? JSON.stringify(cal2) : '');
      ok('reopen does not issue summary request', requests.length === reqBeforeReopen);

      // Close
      await page.locator('#pfb-custom-range-pop [data-pfb-cal="close"]').click();
      await sleep(80);
      const closed = await calendarVisible(page);
      ok('Close hides calendar', !closed.ok);

      // ── Clear semantics: open, pick one day, Clear — picker stays, draft cleared, zero request ──
      await page.locator('#pfb-custom-range-trigger, #admin-finance-body [data-finance-nav="open-custom-range"]').first().click();
      ok('calendar reopens for Clear test', (await waitCalendar(page, 2000)).ok);
      ok('ensure 2026-08 for Clear', await ensureYm('2026-08'));
      const reqBeforeClear = requests.length;
      await clickDay(page, '2026-08-12');
      await sleep(40);
      const draftAfterPick = await page.evaluate(() => {
        const pop = document.getElementById('pfb-custom-range-pop');
        return {
          starts: pop ? pop.querySelectorAll('.is-start').length : 0,
          ends: pop ? pop.querySelectorAll('.is-end').length : 0,
        };
      });
      ok('first Clear-prep click paints start selection', draftAfterPick.starts >= 1, JSON.stringify(draftAfterPick));
      await page.locator('#pfb-custom-range-pop [data-pfb-cal="clear"]').click();
      await sleep(200);
      const clearReqs = requests.slice(reqBeforeClear);
      const calAfterClear = await calendarVisible(page);
      ok('Clear keeps picker visible', !!(calAfterClear && calAfterClear.ok), JSON.stringify(calAfterClear));
      const draftAfterClear = await page.evaluate(() => {
        const pop = document.getElementById('pfb-custom-range-pop');
        if (!pop) return { ok: false, reason: 'no-pop' };
        return {
          ok: true,
          starts: pop.querySelectorAll('.is-start').length,
          ends: pop.querySelectorAll('.is-end').length,
          mids: pop.querySelectorAll('.is-mid').length,
        };
      });
      ok(
        'Clear clears draft selection classes',
        !!(draftAfterClear && draftAfterClear.ok && draftAfterClear.starts === 0 && draftAfterClear.ends === 0 && draftAfterClear.mids === 0),
        JSON.stringify(draftAfterClear)
      );
      ok(
        'Clear issues zero finance summary requests',
        clearReqs.length === 0,
        clearReqs.map((r) => r.url).join(' | ') || 'none'
      );
      ok(
        'Clear does not issue incomplete custom summary request',
        clearReqs.filter((r) => r.incompleteCustom).length === 0,
        clearReqs.map((r) => r.url).join(' | ') || 'none'
      );

      // Close so next flows are clean
      if ((await calendarVisible(page)).ok) {
        await page.locator('#pfb-custom-range-pop [data-pfb-cal="close"]').click().catch(() => {});
      }

      // ── Single-day range (two-click same day) ──
      // Start from Month then Custom for clean client picker
      const reqBeforeMonth = requests.length;
      await page.locator('#admin-finance-body [data-finance-gran="month"]').click();
      await page.waitForFunction(
        () => !!document.querySelector('#admin-finance-body [data-finance-gran="month"].is-on'),
        null,
        { timeout: 8000 }
      );
      ok('Month gran reload after custom', requests.length > reqBeforeMonth);

      // Custom → Month → Custom
      await clickCustom(page);
      ok('Custom → Month → Custom reopens calendar', (await waitCalendar(page, 2500)).ok);
      ok('ensure 2026-08 for single-day', await ensureYm('2026-08'));
      const reqBeforeSame = requests.length;
      await clickDay(page, '2026-08-20');
      await sleep(40);
      ok('first same-day click no fetch', requests.length === reqBeforeSame);
      await clickDay(page, '2026-08-20');
      await page.waitForFunction(
        () => !!document.querySelector('#admin-finance-body [data-finance-gran="custom"].is-on'),
        null,
        { timeout: 8000 }
      ).catch(() => {});
      const sameReqs = requests.slice(reqBeforeSame);
      const sameComplete = sameReqs.find((r) => isCompleteCustom(r.query, '2026-08-20', '2026-08-20'));
      ok(
        'single-day two-click issues granularity=custom&start=2026-08-20&end=2026-08-20',
        !!sameComplete,
        sameReqs.map((r) => r.url).join(' | ')
      );
      const sameLabel = await page.locator('#admin-finance-body [data-finance-range-label]').innerText().catch(() => '');
      ok('single-day range label includes 2026-08-20', /2026-08-20/.test(sameLabel), sameLabel);

      // ── Listener survival across repeated finance rerenders (real body identity) ──
      const bodyAfterRange = await page.evaluate(() => {
        const body = document.getElementById('admin-finance-body');
        return {
          wired: !!(body && body.dataset.financeNavWired === '1'),
          token: body ? body.dataset.verifyBodyIdentity || null : null,
        };
      });
      ok('listener flag still set after custom/month/custom rerenders', bodyAfterRange.wired);
      ok(
        'same #admin-finance-body node identity survives range repaint',
        !!(bodyIdentityBefore && bodyAfterRange.token && bodyAfterRange.token === bodyIdentityBefore.token),
        `before=${bodyIdentityBefore && bodyIdentityBefore.token} after=${bodyAfterRange.token}`
      );

      // Force several month/day toggles then Custom still works
      for (let i = 0; i < 2; i += 1) {
        await page.locator('#admin-finance-body [data-finance-gran="day"]').click();
        await page.waitForSelector('#admin-finance-body [data-finance-gran="day"].is-on', { timeout: 8000 });
        await page.locator('#admin-finance-body [data-finance-gran="month"]').click();
        await page.waitForSelector('#admin-finance-body [data-finance-gran="month"].is-on', { timeout: 8000 });
      }
      const bodyAfterToggles = await page.evaluate(() => {
        const body = document.getElementById('admin-finance-body');
        return {
          wired: !!(body && body.dataset.financeNavWired === '1'),
          token: body ? body.dataset.verifyBodyIdentity || null : null,
        };
      });
      ok('listener survives repeated finance gran rerenders', bodyAfterToggles.wired);
      ok(
        'same #admin-finance-body node identity survives repeated gran rerenders',
        !!(bodyIdentityBefore && bodyAfterToggles.token && bodyAfterToggles.token === bodyIdentityBefore.token),
        `before=${bodyIdentityBefore && bodyIdentityBefore.token} after=${bodyAfterToggles.token}`
      );
      await clickCustom(page);
      ok('Custom still opens calendar after repeated rerenders', (await waitCalendar(page, 2500)).ok);
      if ((await calendarVisible(page)).ok) {
        await page.locator('#pfb-custom-range-pop [data-pfb-cal="close"]').click().catch(() => {});
      }

      // ── Runtime helper presence (actual cooked modules) ──
      // Production modules are IIFE-scoped (not window globals). Prove presence in
      // the cooked page artifact + product single-day journey (above) exercises the
      // real call path. Fallback branch must remain in source for safety.
      const cookedHasHelper = await page.evaluate(() => {
        const html = document.documentElement && document.documentElement.innerHTML
          ? document.documentElement.innerHTML
          : '';
        return {
          decl: /function\s+scheduleCreateDateRangeSelectDay\s*\(\s*state\s*,\s*iso\s*\)/.test(html),
          callSite: /scheduleCreateDateRangeSelectDay\(\s*financeCustomRangeDraft/.test(html),
          fallback: /typeof scheduleCreateDateRangeSelectDay\s*===\s*['"]function['"]/.test(html),
        };
      });
      ok(
        'actual scheduleCreateDateRangeSelectDay present in cooked injected modules (state, iso)',
        !!(cookedHasHelper && cookedHasHelper.decl),
        JSON.stringify(cookedHasHelper)
      );
      ok(
        'finance picker call site uses (state, iso) against cooked helper',
        !!(cookedHasHelper && cookedHasHelper.callSite)
      );
      ok(
        'fallback typeof guard present if production runtime lacks helper',
        !!(cookedHasHelper && cookedHasHelper.fallback)
      );
    }

    // ── No pageerror / console.error from journey ──
    // Filter noisy third-party if any; finance journey should be clean
    const relevantPageErrors = pageErrors.filter((e) => !/favicon/i.test(e));
    const relevantConsole = consoleErrors.filter((e) => !/favicon|Download the React/i.test(e));
    ok('no pageerror during journey', relevantPageErrors.length === 0, relevantPageErrors.join(' | '));
    ok('no console.error during journey', relevantConsole.length === 0, relevantConsole.join(' | '));

    // Gate must fail if old behavior returns: prove we never accepted incomplete custom as success path
    const anyIncomplete = requests.filter((r) => r.incompleteCustom);
    ok(
      'entire journey issued zero incomplete custom summary requests',
      anyIncomplete.length === 0,
      anyIncomplete.map((r) => r.url).join(' | ') || 'none'
    );

    console.log(`\n  screenshots: ${shotDir}`);
    console.log(`  finance requests captured: ${requests.length}`);
    if (anyIncomplete.length) {
      console.log('  incomplete custom URLs:');
      anyIncomplete.forEach((r) => console.log('   ', r.url));
    }

    // ── FALLBACK PATH: real DOM with scheduleCreateDateRangeSelectDay unavailable ──
    // Separate fresh context. Disable the cooked helper at runtime by rewriting the
    // served /staff/ui (no production source change). Prove fallback via real clicks.
    console.log('\n[real-page] fallback path: helper unavailable at runtime\n');

    const fbContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const fbPage = await fbContext.newPage();
    const fbRequests = [];
    const fbPageErrors = [];
    const fbConsoleErrors = [];

    fbPage.on('pageerror', (err) => fbPageErrors.push(String(err && err.message ? err.message : err)));
    fbPage.on('console', (msg) => {
      if (msg.type() === 'error') fbConsoleErrors.push(msg.text());
    });

    await fbContext.addInitScript(() => {
      localStorage.setItem('staff_portal_client', 'sunset');
      localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
      localStorage.setItem('wh_staff_portal_locale', 'en');
    });

    // Rewrite cooked HTML: rename helper so typeof scheduleCreateDateRangeSelectDay
    // is undefined inside the portal IIFE; inject an in-scope typeof probe.
    await fbPage.route('**/staff/ui', async (route) => {
      const res = await route.fetch();
      let html = await res.text();
      const hadDecl = /function\s+scheduleCreateDateRangeSelectDay\s*\(/.test(html);
      if (hadDecl) {
        html = html.replace(
          /function\s+scheduleCreateDateRangeSelectDay\s*\(/,
          'window.__typeofScheduleCreateDateRangeSelectDay=function(){return typeof scheduleCreateDateRangeSelectDay;};' +
            'function __disabled_scheduleCreateDateRangeSelectDay('
        );
      }
      await route.fulfill({
        status: res.status(),
        contentType: 'text/html; charset=utf-8',
        body: html,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });

    await fbPage.route('**/staff/admin/finance/summary**', async (route) => {
      const reqUrl = route.request().url();
      const q = parseFinanceUrl(reqUrl);
      fbRequests.push({
        url: reqUrl,
        query: q,
        incompleteCustom: isIncompleteCustom(q),
        at: Date.now(),
      });
      const summary = summaryForQuery(q);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, summary }),
      });
    });

    try {
      const fbUiRes = await fbPage.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      ok('fallback served /staff/ui 200', fbUiRes && fbUiRes.status() === 200);

      // Prove helper is undefined in cooked IIFE scope (probe injected with rewrite only)
      const helperTypeof = await fbPage.evaluate(() => {
        if (typeof window.__typeofScheduleCreateDateRangeSelectDay === 'function') {
          return window.__typeofScheduleCreateDateRangeSelectDay();
        }
        return 'probe-missing';
      });
      ok(
        'fallback runtime typeof scheduleCreateDateRangeSelectDay === undefined',
        helperTypeof === 'undefined',
        `got ${JSON.stringify(helperTypeof)}`
      );
      // Window-level also undefined (helper is not a cooked window global after disable)
      const windowTypeof = await fbPage.evaluate(() => typeof scheduleCreateDateRangeSelectDay);
      ok(
        'fallback window typeof scheduleCreateDateRangeSelectDay === undefined',
        windowTypeof === 'undefined',
        `got ${JSON.stringify(windowTypeof)}`
      );
      // Confirm disabled rename present and original decl absent in live DOM HTML
      const liveHtmlShape = await fbPage.evaluate(() => {
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        return {
          hasDisabled: /function\s+__disabled_scheduleCreateDateRangeSelectDay\s*\(/.test(html),
          hasOriginal: /function\s+scheduleCreateDateRangeSelectDay\s*\(/.test(html),
          hasFallbackGuard: /typeof scheduleCreateDateRangeSelectDay\s*===\s*['"]function['"]/.test(html),
        };
      });
      ok(
        'fallback rewrite disabled cooked helper declaration',
        !!(liveHtmlShape.hasDisabled && !liveHtmlShape.hasOriginal && liveHtmlShape.hasFallbackGuard),
        JSON.stringify(liveHtmlShape)
      );

      await waitPortal(fbPage);
      await openAdminFinance(fbPage);
      await clickCustom(fbPage);
      const fbCal = await waitCalendar(fbPage, 3000);
      ok('fallback Custom opens real calendar', !!(fbCal && fbCal.ok), fbCal ? JSON.stringify(fbCal) : '');

      async function fbEnsureYm(ym) {
        for (let i = 0; i < 24; i += 1) {
          const cur = await fbPage.locator('#pfb-custom-range-pop .pfb-cal-head span').innerText();
          if (cur.trim() === ym) return true;
          if (cur.trim() < ym) await fbPage.locator('#pfb-custom-range-pop [data-pfb-cal="next"]').click();
          else await fbPage.locator('#pfb-custom-range-pop [data-pfb-cal="prev"]').click();
          await sleep(20);
        }
        return false;
      }

      if (fbCal && fbCal.ok) {
        ok('fallback navigate to 2026-08', await fbEnsureYm('2026-08'));

        // Same-day: first click must NOT commit (blocking bug: extra iso===start block)
        const reqBeforeFbSame = fbRequests.length;
        await clickDay(fbPage, '2026-08-14');
        await sleep(120);
        const calAfterFirst = await calendarVisible(fbPage);
        ok(
          'fallback first same-day click keeps picker open',
          !!(calAfterFirst && calAfterFirst.ok),
          JSON.stringify(calAfterFirst)
        );
        ok(
          'fallback first same-day click issues zero finance requests',
          fbRequests.length === reqBeforeFbSame,
          fbRequests
            .slice(reqBeforeFbSame)
            .map((r) => r.url)
            .join(' | ') || 'none'
        );
        const startOnlyPaint = await fbPage.evaluate(() => {
          const pop = document.getElementById('pfb-custom-range-pop');
          if (!pop) return null;
          const startBtn = pop.querySelector('[data-pfb-day="2026-08-14"]');
          return {
            isStart: !!(startBtn && startBtn.classList.contains('is-start')),
            isEnd: !!(startBtn && startBtn.classList.contains('is-end')),
            endCount: pop.querySelectorAll('.is-end').length,
          };
        });
        ok(
          'fallback first same-day click paints start only (no end yet)',
          !!(startOnlyPaint && startOnlyPaint.isStart && !startOnlyPaint.isEnd && startOnlyPaint.endCount === 0),
          JSON.stringify(startOnlyPaint)
        );

        // Second click same day completes start=end
        let secondClickOk = false;
        try {
          await clickDay(fbPage, '2026-08-14');
          secondClickOk = true;
        } catch (err) {
          ok(
            'fallback second same-day click reachable (picker still open)',
            false,
            String(err && err.message ? err.message : err)
          );
        }
        if (secondClickOk) {
          await fbPage
            .waitForFunction(
              () => !!document.querySelector('#admin-finance-body [data-finance-gran="custom"].is-on'),
              null,
              { timeout: 8000 }
            )
            .catch(() => {});
        }
        const fbSameReqs = fbRequests.slice(reqBeforeFbSame);
        const fbSameComplete = fbSameReqs.find((r) => isCompleteCustom(r.query, '2026-08-14', '2026-08-14'));
        ok(
          'fallback second same-day click issues exact custom start=end',
          !!fbSameComplete && secondClickOk,
          fbSameReqs.map((r) => r.url).join(' | ')
        );
        ok(
          'fallback same-day only one complete custom request',
          secondClickOk &&
            fbSameReqs.filter((r) => isCompleteCustom(r.query, '2026-08-14', '2026-08-14')).length === 1 &&
            fbSameReqs.filter((r) => r.incompleteCustom).length === 0,
          fbSameReqs.map((r) => r.url).join(' | ')
        );

        // Compact: first later second via fallback
        await fbPage.locator('#admin-finance-body [data-finance-gran="month"]').click();
        await fbPage.waitForSelector('#admin-finance-body [data-finance-gran="month"].is-on', { timeout: 8000 });
        await clickCustom(fbPage);
        ok('fallback reopen for later-end', (await waitCalendar(fbPage, 2500)).ok);
        ok('fallback ensure 2026-08 for later-end', await fbEnsureYm('2026-08'));
        const reqBeforeLater = fbRequests.length;
        await clickDay(fbPage, '2026-08-10');
        await sleep(40);
        await clickDay(fbPage, '2026-08-18');
        await fbPage
          .waitForFunction(
            () => !!document.querySelector('#admin-finance-body [data-finance-gran="custom"].is-on'),
            null,
            { timeout: 8000 }
          )
          .catch(() => {});
        const laterReqs = fbRequests.slice(reqBeforeLater);
        ok(
          'fallback first+later second issues exact custom 10→18',
          !!laterReqs.find((r) => isCompleteCustom(r.query, '2026-08-10', '2026-08-18')),
          laterReqs.map((r) => r.url).join(' | ')
        );
        ok(
          'fallback first later: no request until second click',
          laterReqs.length === 1 && isCompleteCustom(laterReqs[0].query, '2026-08-10', '2026-08-18'),
          laterReqs.map((r) => r.url).join(' | ')
        );

        // Compact: reverse/reset via fallback
        await fbPage.locator('#admin-finance-body [data-finance-gran="month"]').click();
        await fbPage.waitForSelector('#admin-finance-body [data-finance-gran="month"].is-on', { timeout: 8000 });
        await clickCustom(fbPage);
        ok('fallback reopen for reverse', (await waitCalendar(fbPage, 2500)).ok);
        ok('fallback ensure 2026-08 for reverse', await fbEnsureYm('2026-08'));
        const reqBeforeRev = fbRequests.length;
        await clickDay(fbPage, '2026-08-15');
        await sleep(40);
        await clickDay(fbPage, '2026-08-10'); // earlier → restart
        await sleep(40);
        ok('fallback reverse keeps picker open', (await calendarVisible(fbPage)).ok);
        ok('fallback reverse issues zero requests mid-draft', fbRequests.length === reqBeforeRev);
        await clickDay(fbPage, '2026-08-18');
        await fbPage
          .waitForFunction(
            () => !!document.querySelector('#admin-finance-body [data-finance-gran="custom"].is-on'),
            null,
            { timeout: 8000 }
          )
          .catch(() => {});
        const revReqs = fbRequests.slice(reqBeforeRev);
        ok(
          'fallback reverse then complete issues exact custom 10→18',
          !!revReqs.find((r) => isCompleteCustom(r.query, '2026-08-10', '2026-08-18')),
          revReqs.map((r) => r.url).join(' | ')
        );
      }

      const fbIncomplete = fbRequests.filter((r) => r.incompleteCustom);
      ok(
        'fallback journey issued zero incomplete custom summary requests',
        fbIncomplete.length === 0,
        fbIncomplete.map((r) => r.url).join(' | ') || 'none'
      );
      ok(
        'fallback no pageerror',
        fbPageErrors.filter((e) => !/favicon/i.test(e)).length === 0,
        fbPageErrors.join(' | ')
      );
      ok(
        'fallback no console.error',
        fbConsoleErrors.filter((e) => !/favicon|Download the React/i.test(e)).length === 0,
        fbConsoleErrors.join(' | ')
      );
      console.log(`  fallback finance requests captured: ${fbRequests.length}`);
    } finally {
      await fbContext.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
    await close(server).catch(() => {});
  }

  console.log(`\n── verify:sunset-finance-custom-range-picker: ${pass} passed, ${fail} failed ──`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
