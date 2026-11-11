'use strict';

// Full production page, native month-chip clicks, synthetic GET-only calendar.
// No live server, credentials, writes, or forwarded network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'http://staff.test';
const OUT = process.argv[2] && path.resolve(process.argv[2]);
const tenant = 'wolfhouse-somo';
const src = readStaffPortalUiSource();
for (const key of ['feb-mar', 'mar-apr']) {
  assert.ok(src.includes('data-chip="' + key + '"'), key + ' month shortcut exists');
}

function calendar(start, end) {
  const days = [];
  for (let d = new Date(start + 'T00:00:00Z'); d < new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push({ date: d.toISOString().slice(0, 10) });
  }
  return { success: true, days, rooms: [{ room_code: 'R1', room_name: 'R1', beds: [{ bed_code: 'R1-B1', bed_label: 'Bed 1' }] }], blocks: [], warnings: [] };
}

async function main() {
  const built = spawnSync(process.execPath, ['-e', "process.env.NODE_ENV='test';process.env.STAFF_UI_BUILDER_TEST_SEAM='1';process.env.STAFF_AUTH_REQUIRED='false';process.env.STAFF_AUTH_ALLOW_OPEN='true';process.env.DEFAULT_CLIENT_SLUG='wolfhouse-somo';process.stdout.write(require('./scripts/staff-query-api').buildUiHtmlForOfflineTest(0,'wolfhouse-somo'));"], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(built.status, 0, built.stderr);
  const fixtures = {
    '/staff/auth/session': { success: true, auth_required: false, role: 'admin', clients: [{ slug: tenant, name: tenant }], client_profiles: { [tenant]: loadClientPortalProfile(tenant) } },
    '/staff/schedule/day': { success: true, rows: [], rental_label_map: {} },
    '/staff/schedule/bookings/catalog': { success: true, ok: true, courses: [], offerings: [], rentals: [] },
    '/staff/intents': { success: true, intents: [] },
    '/staff/inbox/luna-mode': { success: true, mode: 'off' },
    '/staff/bot/global-pause-state': { success: true, paused: false },
    '/staff/whatsapp-numbers': { success: true, numbers: [] },
    '/staff/admin/house-notes': { success: true, notes: '' },
    '/staff/automated-notifications': { success: true, notifications: [] },
    '/staff/packages': { success: true, packages: [] },
    '/staff/conversations': { success: true, conversations: [] },
    '/staff/admin/config': { success: true, ...resolveTenantBusinessConfig(tenant, 'sunset-somo') },
    '/staff/admin/config/rental-offerings': { success: true, offerings: [] },
    '/staff/clients': { success: true, clients: [{ slug: tenant, name: tenant }] },
  };
  const errors = [], blocked = [], observations = [];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [390, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', timezoneId: 'UTC' });
      await context.routeWebSocket('**/*', ws => { blocked.push(ws.url()); ws.close(); });
      await context.route('**/*', async route => {
        const req = route.request(), u = new URL(req.url());
        if (u.origin === 'https://fonts.googleapis.com' && req.method() === 'GET') return route.abort();
        if (u.origin !== ORIGIN || req.method() !== 'GET') { blocked.push(req.method() + ' ' + req.url()); return route.abort(); }
        if (u.pathname === '/staff/ui') return route.fulfill({ contentType: 'text/html', body: built.stdout });
        if (u.pathname.startsWith('/staff/assets/') && path.basename(u.pathname) === u.pathname.slice('/staff/assets/'.length)) {
          const asset = path.join(ROOT, 'config/staff-portal', path.basename(u.pathname));
          if (fs.existsSync(asset)) return route.fulfill({ path: asset });
        }
        const data = u.pathname === '/staff/bed-calendar' ? calendar(u.searchParams.get('start'), u.searchParams.get('end')) : fixtures[u.pathname];
        if (!data) { blocked.push(req.url()); return route.abort(); }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      });
      await context.addInitScript(() => localStorage.setItem('wh_staff_portal_locale', 'en'));
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(String(e)));
      await page.clock.setFixedTime(new Date('2027-02-10T12:00:00Z'));
      await page.goto(ORIGIN + '/staff/ui');
      await page.waitForFunction(t => typeof window.switchToTab === 'function' && document.getElementById('c-client').value === t, tenant);
      await page.evaluate(() => window.switchToTab('bed-calendar'));
      await page.locator('.bc-room-hdr').first().waitFor();
      assert.equal(await page.locator('#bc-chips .bc-chip').count(), 11);
      assert.deepEqual(await page.evaluate(() => [bcChipKeyForCheckIn('2027-02-10'), bcChipKeyForCheckIn('2027-03-10')]), ['feb-mar', 'mar-apr']);
      for (const [key, start, end] of [['feb-mar', '2027-02-01', '2027-04-01'], ['mar-apr', '2027-03-01', '2027-05-01'], ['apr-may', '2027-04-01', '2027-06-01']]) {
        const chip = page.locator('[data-chip="' + key + '"]');
        await chip.scrollIntoViewIfNeeded();
        const response = page.waitForResponse(r => {
          const u = new URL(r.url());
          return u.pathname === '/staff/bed-calendar' && u.searchParams.get('start') === start && u.searchParams.get('end') === end;
        });
        await chip.click();
        await response;
        await page.waitForFunction(start => bcData && bcData.days[0].date === start && !document.getElementById('bc-load').disabled, start);
        assert.equal(await page.locator('.bc-chip-active').getAttribute('data-chip'), key);
        const dates = await page.evaluate(() => bcData.days.map(d => d.date));
        const expected = calendar(start, end).days.map(d => d.date);
        assert.deepEqual(dates, expected);
        assert.equal(await page.locator('#bc-grid-wrap thead th').count(), expected.length + 1, 'real calendar renders every day');
        observations.push({ width, key, start, end, renderedDays: dates.length });
        if (OUT && key !== 'apr-may') {
          fs.mkdirSync(OUT, { recursive: true });
          await page.screenshot({ path: path.join(OUT, key + '-' + width + '.png') });
        }
      }
      for (const [locale, expected] of [['en', ['Feb - Mar', 'Mar - Apr']], ['es', ['feb - mar', 'mar - abr']], ['it', ['Feb - Mar', 'Mar - Apr']]]) {
        await page.evaluate(locale => window.setStaffLocale(locale), locale);
        assert.deepEqual(await page.locator('[data-chip="feb-mar"], [data-chip="mar-apr"]').allTextContents(), expected);
      }
      await context.close();
    }
    assert.deepEqual(errors, [], 'no browser JS errors');
    assert.deepEqual(blocked, [], 'no unapproved requests');
    console.log(JSON.stringify(observations, null, 2));
    console.log('PASS February/March full-page native clicks, selected-year date windows, calendar days, EN/ES/IT labels, existing April shortcut, desktop/mobile; zero live traffic or writes');
  } finally {
    await browser.close();
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
