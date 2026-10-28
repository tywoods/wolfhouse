'use strict';
// CAP-PROD-PLAN-FIN8: real composed portal + native locale controls, entirely offline.
// Run: FINANCE_PROOF_DIR=/path/to/evidence node scripts/verify-wolfhouse-finance-locale-ui.js
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { computeWolfhouseCreatorFinance: compute, computeSunsetFinanceSummary: legacy } = require('./lib/sunset-finance-summary');
const { chromium } = require('playwright');

const out = process.env.FINANCE_PROOF_DIR || path.resolve(__dirname, '../artifacts/finance-locale');
const locales = { en: 'en-GB', es: 'es-ES', it: 'it-IT' };
const unavailable = { en: 'Not available', es: 'No disponible', it: 'Non disponibile' };
const stamp = '2026-10-28T10:14:51.905Z';
const input = { now: new Date(stamp), clientSlug: 'wolfhouse-somo', currency: 'EUR',
  view: { granularity: 'month' }, bookings: [], payments: [], refund_records: [],
  bsr: [], booked_services: [], booked_transfers: [] };

async function main() {
  fs.mkdirSync(out, { recursive: true });
  Object.assign(process.env, { NODE_ENV: 'test', STAFF_UI_BUILDER_TEST_SEAM: '1',
    STAFF_AUTH_REQUIRED: 'false', STAFF_AUTH_ALLOW_OPEN: 'true',
    STAFF_PORTAL_LOCALES: 'en,es,it', DEFAULT_CLIENT_SLUG: 'wolfhouse-somo' });
  const portal = require('./staff-query-api').buildUiHtmlForOfflineTest(0, 'wolfhouse-somo');
  const { buildClientProfilesMap, getAccessibleClients } = require('./lib/staff-portal-clients');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 },
    serviceWorkers: 'block', timezoneId: 'America/Los_Angeles' });
  const page = await context.newPage();
  await page.clock.setFixedTime(input.now);
  const requests = [], unexpected = [], errors = [], cases = [], observations = [];
  let projection = compute(input), completed = false;
  page.on('pageerror', e => errors.push(String(e)));
  await context.route('**/*', async route => {
    const r = route.request(), u = new URL(r.url());
    requests.push(r.method() + ' ' + u.href);
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (u.origin === 'https://fonts.googleapis.com' && r.resourceType() === 'stylesheet') {
      return route.fulfill({ contentType: 'text/css', body: '/* offline fallback fonts */' });
    }
    if (u.origin !== 'http://finance.test' || r.method() !== 'GET') {
      unexpected.push(r.method() + ' ' + u.href); return route.abort();
    }
    if (u.pathname === '/staff/ui') return route.fulfill({ contentType: 'text/html', body: portal });
    if (['/staff/assets/luna-front-desk-logo.png', '/staff/assets/luna-header-sign.png', '/favicon.ico'].includes(u.pathname)) return route.fulfill({ status: 204, body: '' });
    if (u.pathname === '/staff/auth/session') return json({ success: true, auth_required: false, role: 'owner',
      clients: getAccessibleClients(null), client_profiles: buildClientProfilesMap(null), can_use_owner_insights: true });
    if (u.pathname === '/staff/admin/finance/summary') return json({ success: true, client: 'wolfhouse-somo', summary: legacy({ ...input, productMode: 'lodging_packages' }), wolfhouse_creator_finance: projection });
    // Read-only shell dependencies from the native portal fixture; never forward traffic.
    if (['/staff/inbox', '/staff/admin', '/staff/config', '/staff/bookings', '/staff/notifications', '/staff/owner', '/staff/calendar', '/staff/luna', '/staff/clients', '/staff/health', '/staff/me', '/staff/settings', '/staff/luna-intelligence/room-fill', '/staff/intents', '/staff/bot/global-pause-state', '/staff/whatsapp-numbers', '/staff/automated-notifications', '/staff/bed-calendar'].some(prefix => u.pathname === prefix || u.pathname.startsWith(prefix + '/'))) {
      return json({ success: true, rows: [], conversations: [], offerings: [], services: [] });
    }
    unexpected.push(r.method() + ' ' + u.href); return route.abort();
  });
  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'wolfhouse-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });
  const host = page.locator('#wh-admin-finance-body');
  const settle = () => host.locator('[data-wh-fin-headline="total"]').waitFor();
  const reload = async () => {
    await page.locator('[data-wh-admin-tab="finance"]').click(); await settle();
  };
  const switchLocale = async locale => {
    const before = requests.filter(r => r.includes('/finance/summary')).length;
    await page.locator('.staff-lang-btn[data-lang="' + locale + '"]').click();
    await settle();
    assert.equal(requests.filter(r => r.includes('/finance/summary')).length, before, 'locale repaint must not fetch or change data');
  };
  const pass = label => { cases.push(label); console.log('PASS', label); };
  try {
    await page.goto('http://finance.test/staff/ui', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('c-client')?.value === 'wolfhouse-somo');
    await page.locator('button.tab-btn[data-tab="admin"]').click(); await reload();
    assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'America/Los_Angeles');
    for (const value of [stamp, '2026-07-01T23:30:00Z', 'invalid-finance-clock']) {
      projection = compute(input);
      // Timestamp fault injection only; real producer metrics remain unchanged.
      projection.as_of = value; projection.generated_at = value; projection.metrics.outstanding_today.as_of = value;
      await reload();
      for (const [locale, tag] of Object.entries(locales)) {
        await switchLocale(locale);
        const expected = value.startsWith('invalid') ? unavailable[locale] :
          new Intl.DateTimeFormat(tag, { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
        for (const selector of ['[data-wh-fin-freshness] time', '[data-wh-fin-outstanding-as-of]']) {
          const actual = await host.locator(selector).textContent();
          observations.push({ type: 'timestamp', locale, value, selector, actual, expected });
          assert.equal(actual, expected, selector + ' uses active locale and Madrid, not browser timezone/raw ISO');
          assert.equal(await host.locator(selector).getAttribute('datetime'), value, 'machine timestamp preserved');
        }
        assert.ok(!(await host.innerText()).includes(value), 'raw timestamp must not be visible');
        pass('Madrid timestamps ' + locale + ' ' + value);
      }
    }
    const bookings = Array.from({ length: 12345 }, (_, i) => ({ booking_id: 'synthetic-' + i,
      created_at: '2026-10-03', total_amount_cents: 1, currency: 'EUR', metadata: { source: 'luna_guest' } }));
    bookings.push({ booking_id: 'synthetic-staff', created_at: '2026-10-03', total_amount_cents: 6789, currency: 'EUR', metadata: {} });
    const payments = [
      { payment_id: 'synthetic-luna-pay', booking_id: 'synthetic-0', amount_paid_cents: 12345,
        paid_at: stamp, currency: 'EUR', payment_kind: 'full_amount', booking_metadata: { source: 'luna_guest' } },
      { payment_id: 'synthetic-staff-pay', booking_id: 'synthetic-staff', amount_paid_cents: 6789,
        paid_at: stamp, currency: 'EUR', payment_kind: 'balance', booking_metadata: {} },
    ];
    projection = compute({ ...input, bookings, payments }); await reload();
    const numberFailures = [];
    for (const [locale, tag] of Object.entries(locales)) {
      await switchLocale(locale);
      const snapshot = await host.locator('[data-wh-fin-cents], [data-wh-fin-count], [data-wh-fin-share-bps]').evaluateAll(es => es.map(e => ({
        type: e.hasAttribute('data-wh-fin-cents') ? 'money' : e.hasAttribute('data-wh-fin-count') ? 'count' : 'percent',
        raw: e.getAttribute('data-wh-fin-cents') || e.getAttribute('data-wh-fin-count') || e.getAttribute('data-wh-fin-share-bps'), text: e.textContent,
      })));
      assert.ok(snapshot.some(v => v.type === 'count' && v.raw === '12345'), 'real producer large count exercised');
      for (const value of snapshot) {
        const expected = value.type === 'money' ? new Intl.NumberFormat(tag, { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value.raw) / 100) :
          value.type === 'percent' ? new Intl.NumberFormat(tag, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value.raw) / 10000) : new Intl.NumberFormat(tag).format(Number(value.raw));
        observations.push({ locale, ...value, expected });
        if (value.text !== expected) numberFailures.push({ locale, ...value, expected });
      }
      for (const row of projection.creators.filter(r => ['luna', 'staff', 'total'].includes(r.creator))) {
        const card = host.locator('[data-wh-fin-also="' + row.creator + '"]');
        assert.equal(await card.locator('[data-wh-fin-cents]').getAttribute('data-wh-fin-cents'), String(row.gross_receipts.amount_cents));
        assert.equal(await card.locator('[data-wh-fin-share-bps]').getAttribute('data-wh-fin-share-bps'), String(row.receipt_share_bps));
        assert.equal(await host.locator('[data-wh-fin-headline="' + row.creator + '"] [data-wh-fin-count]').getAttribute('data-wh-fin-count'), String(row.new_booking_count.count));
      }
    }
    assert.deepEqual(numberFailures, [], 'all displayed currency/percent/count strings follow active locale; raw data unchanged');
    pass('native EN/ES/IT currency, percent and grouped counts preserve producer data');
    const copy = {
      en: { partial: 'Incomplete data', note: 'Verified deposits only. Incomplete receipt data; the full deposit total is not known.', zero: 'No deposits in this period.' },
      es: { partial: 'Datos incompletos', note: 'Solo depósitos verificados. Datos de cobros incompletos; se desconoce el total de depósitos.', zero: 'No hay depósitos en este periodo.' },
      it: { partial: 'Dati incompleti', note: 'Solo depositi verificati. Dati degli incassi incompleti; il totale dei depositi non è noto.', zero: 'Nessun deposito in questo periodo.' },
    };
    const depositFailures = [];
    for (const scenario of ['partial-zero', 'partial-nonzero', 'complete-zero', 'unavailable']) {
      const scenarioPayments = payments.map(p => ({ ...p }));
      if (scenario.startsWith('partial')) delete scenarioPayments[0].payment_kind;
      if (scenario === 'partial-nonzero') scenarioPayments[1].payment_kind = 'deposit';
      projection = compute({ ...input, bookings, payments: scenarioPayments });
      if (scenario === 'unavailable') {
        // Transport fault injection: the producer currently returns partial, not unavailable deposits.
        for (const metric of [projection.metrics.deposits_received, ...projection.creators.map(r => r.deposits_received)]) {
          metric.state = 'unavailable'; metric.amount_cents = null;
        }
      }
      assert.ok(projection.metrics.gross_receipts.amount_cents > 0, 'zero deposits must not imply no receipts');
      assert.equal(projection.metrics.deposits_received.state, scenario.startsWith('partial') ? 'partial' : scenario === 'unavailable' ? 'unavailable' : 'complete');
      assert.equal(projection.metrics.deposits_received.amount_cents, scenario === 'partial-nonzero' ? 6789 : scenario === 'unavailable' ? null : 0);
      await reload();
      for (const [locale, tag] of Object.entries(locales)) {
        await page.setViewportSize({ width: 1280, height: 950 }); await switchLocale(locale);
        for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
          await page.setViewportSize({ width: 1280, height: 950 });
          if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#staff-theme-toggle').click();
          await page.setViewportSize({ width, height: 950 });
          assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
          const targets = [[host.locator('[data-wh-fin-secondary="deposits"]'), projection.metrics.deposits_received]];
          for (const row of projection.creators.filter(r => ['luna', 'staff', 'total'].includes(r.creator))) {
            targets.push([host.locator('[data-wh-fin-creator-row="' + row.creator + '"] td').nth(1), row.deposits_received]);
          }
          for (const [target, metric] of targets) {
            const status = await target.locator('[data-wh-fin-state]').textContent();
            assert.equal(await target.locator('[data-wh-fin-state]').getAttribute('data-wh-fin-state'), metric.state, 'completeness contract stays unchanged');
            const text = await target.innerText();
            observations.push({ type: 'deposit', scenario, locale, width, theme, metric, text });
            if (metric.state === 'unavailable') {
              assert.equal(await target.locator('[data-wh-fin-cents]').count(), 0, 'unavailable never becomes invented zero');
              assert.equal(await target.locator('[data-wh-fin-value="unknown"]').textContent(), unavailable[locale]);
              assert.equal(await target.locator('.wh-fin-zero,.wh-fin-partial').count(), 0);
            } else {
              assert.equal(await target.locator('[data-wh-fin-cents]').getAttribute('data-wh-fin-cents'), String(metric.amount_cents));
              assert.equal(await target.locator('[data-wh-fin-cents]').textContent(), new Intl.NumberFormat(tag, { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(metric.amount_cents / 100));
              if (metric.state === 'partial') {
                if (status !== copy[locale].partial || await target.locator('.wh-fin-partial').textContent() !== copy[locale].note) depositFailures.push({ scenario, locale, width, theme, status, text, expected: copy[locale] });
                assert.equal(await target.locator('.wh-fin-zero').count(), 0, 'partial zero is not a complete empty period');
              } else {
                if (await target.locator('.wh-fin-zero').textContent() !== copy[locale].zero) depositFailures.push({ scenario, locale, width, theme, text, expected: copy[locale].zero });
                assert.equal(await target.locator('.wh-fin-partial').count(), 0);
              }
            }
          }
          assert.equal(await host.locator('[data-wh-fin-month], [data-wh-fin-source], [data-wh-fin-trend], [data-wh-fin-warnings], [data-wh-fin-arrival], [data-wh-fin-refunds]').count(), 0, 'trim remains structural, not CSS-hidden');
          assert.equal(await host.locator('[data-finance-gran]').count(), 5);
          const geometry = await host.evaluate(root => {
            const box = root.getBoundingClientRect();
            return { overflow: [...root.querySelectorAll('.wh-fin-card,.wh-fin-panel,.pfb-gran-btn')].some(e => { const r = e.getBoundingClientRect(); return r.left < box.left - 1 || r.right > box.right + 1 || r.width <= 0; }),
              navFirst: root.querySelector('.pfb-nav').getBoundingClientRect().bottom <= root.querySelector('[data-wh-fin-headline]').getBoundingClientRect().top };
          });
          assert.deepEqual(geometry, { overflow: false, navFirst: true });
          await host.locator('[data-wh-fin-secondary="deposits"]').evaluate(e => e.scrollIntoView({ block: 'start' }));
          await page.screenshot({ path: path.join(out, scenario + '-' + locale + '-' + width + '-' + theme + '.png') });
          pass('deposit values and trim ' + scenario + ' ' + locale + ' ' + width + ' ' + theme);
        }
      }
    }
    assert.deepEqual(depositFailures, [], 'deposits distinguish incomplete data from partial payment and no deposits from no payments');
    pass('deposit-specific copy on card and every comparison row in EN/ES/IT');
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []); completed = true;
  } finally {
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ completed, fixture: 'synthetic; real compute + composed portal; invalid timestamps and unavailable deposits are explicit transport fault injections', timezone: 'America/Los_Angeles', actualFonts: false, cases, observations, requests, unexpected, errors }, null, 2));
    await browser.close();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
