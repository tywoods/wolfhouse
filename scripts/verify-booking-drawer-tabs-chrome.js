'use strict';

// Production /staff/ui, real calendar block + tab clicks; only HTTP data is synthetic.
// No server, live credentials or outbound network. Usage: node scripts/verify-booking-drawer-tabs-chrome.js [artifact-dir]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'tmp/booking-drawer-tabs-chrome'));
const ORIGIN = 'http://staff.test';
const CODE = 'WH-CHROME-TEST';
const booking = { booking_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', booking_code: CODE,
  guest_name: 'Tom (test)', guest_count: 4, status: 'confirmed', check_in: '2026-09-24', check_out: '2026-09-29', nights: 5 };
const calendar = { success: true,
  days: Array.from({ length: 14 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 24 + i)).toISOString().slice(0, 10) })),
  rooms: Array.from({ length: 4 }, (_, i) => ({ room_code: `R${i + 1}`, room_name: `Room ${i + 1}`,
    beds: Array.from({ length: 4 }, (_, j) => ({ bed_code: `R${i + 1}-B${j + 1}`, bed_label: `Bed ${j + 1}` })) })),
  blocks: [{ ...booking, room_code: 'R1', bed_code: 'R1-B1', start_date: '2026-09-24', end_date: '2026-09-29', source: 'staff', start_offset: 0, span: 5 }], warnings: [] };
const detail = { success: true, booking, rooming: { assignments: [] }, booking_guests: [], per_person: [],
  service_records: [], transfers: [], payments: { paid_total_cents: 0, ledger: [] }, pending_manual_services: [], conversation: null };

function emit(tenant) {
  const dest = path.join(OUT, `${tenant}.html`);
  const r = spawnSync(process.execPath, ['scripts/verify-inbox-ui-parity.js', '--emit', tenant, dest], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return fs.readFileSync(dest, 'utf8');
}
function luminance(rgb) {
  const c = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [], failures = [];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const tenant of ['wolfhouse-somo', 'sunset']) {
      const html = emit(tenant);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
      const ledger = [], errors = [];
      await ctx.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        const entry = { method: req.method(), url: req.url() }; ledger.push(entry);
        if (req.method() !== 'GET' || url.origin !== ORIGIN) { entry.blocked = true; return route.abort(); }
        const p = url.pathname;
        if (p === '/staff/ui') return route.fulfill({ contentType: 'text/html', body: html });
        let data;
        if (p === '/staff/bed-calendar') data = calendar;
        else if (p === `/staff/bookings/${CODE}/context`) data = detail;
        else if (p === '/staff/auth/session') data = { success: true, auth_required: false, role: 'admin', clients: [{ slug: tenant, name: tenant }], client_profiles: { [tenant]: loadClientPortalProfile(tenant) } };
        else if (p.startsWith('/staff/assets/')) {
          const asset = path.join(ROOT, 'config/staff-portal', path.basename(p));
          if (fs.existsSync(asset)) return route.fulfill({ path: asset });
          entry.missingAsset = true; return route.abort();
        }
        else if (p === '/staff/intents') data = { success: true, intents: [] };
        else if (p === '/staff/inbox/luna-mode') data = { success: true, mode: 'off' };
        else if (p === '/staff/bot/global-pause-state') data = { success: true, paused: false };
        else if (p === '/staff/whatsapp-numbers') data = { success: true, numbers: [] };
        else if (p === '/staff/admin/house-notes') data = { success: true, notes: '' };
        else if (p === '/staff/automated-notifications') data = { success: true, notifications: [] };
        else if (p === '/staff/packages') data = { success: true, packages: [] };
        else if (p === '/staff/conversations') data = { success: true, conversations: [] };
        else if (p === '/staff/admin/config') data = { success: true, ...resolveTenantBusinessConfig(tenant, 'sunset-somo') };
        else if (p === '/staff/admin/config/rental-offerings') data = { success: true, offerings: [] };
        else if (p === '/staff/schedule/bookings/catalog') data = { success: true, offerings: [], courses: [] };
        else if (p === '/staff/schedule/day') data = { success: true, date: url.searchParams.get('date'), lessons: [], gear: [], rows: [] };
        else if (p === `/staff/bookings/${booking.booking_id}/services`) data = { success: true, paid_requested_services: [], unscheduled_services: [], services_by_date: [] };
        else if (p === `/staff/bookings/${booking.booking_id}/transfers`) data = { success: true, transfers: [] };
        else if (p === '/staff/clients') data = { success: true, clients: [{ slug: tenant, name: tenant }] };
        else { entry.unknown = true; return route.abort(); }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      });
      const page = await ctx.newPage();
      page.on('pageerror', e => errors.push(String(e)));
      try {
        await page.goto(`${ORIGIN}/staff/ui`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(t => typeof window.switchToTab === 'function' && document.getElementById('c-client').value === t, tenant);
        await page.evaluate(() => window.switchToTab('bed-calendar'));
        if (tenant === 'sunset') {
          // Source profile hides the lodging calendar and its four-tab drawer.
          // Do not spoof Wolfhouse's profile to manufacture Sunset acceptance.
          await page.waitForFunction(() => document.getElementById('tab-portal-home').classList.contains('active'));
          assert.equal(await page.locator('#bc-grid-resize-handle').isVisible(), false);
          assert.equal(await page.locator('#bc-side-drawer .bc-drawer-tab').count(), 0);
          await page.screenshot({ path: path.join(OUT, 'sunset-desktop-native-profile.png') });
          results.push({ name: 'sunset-native-profile', defaultTab: 'portal-home', lodgingCalendarHidden: true, note: 'No four-tab lodging drawer in ordinary Sunset entrypoint; not live staging evidence.' });
          continue;
        }
        await page.locator('.bc-block').first().click();
        await page.locator('#bc-side-drawer .bc-drawer-tab').first().waitFor();
        const tabs = await page.locator('#bc-side-drawer .bc-drawer-tab').evaluateAll(els => els.map(e => e.dataset.tab));
        assert.deepEqual(tabs, ['overview', 'services', 'transfers', 'payments']);
        for (const theme of ['light', 'dark']) {
          await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
          for (const tab of tabs) {
            await page.locator(`#bc-side-drawer .bc-drawer-tab[data-tab="${tab}"]`).click();
            await page.mouse.move(20, 20);
            // Wait for the existing 150ms colour transition, without changing production timing.
            await page.waitForTimeout(180);
            const m = await page.evaluate(() => {
              const rail = document.querySelector('#bc-side-drawer');
              const panel = rail.querySelector('.bc-drawer-tab-content-panel');
              const pr = panel.getBoundingClientRect();
              const active = rail.querySelector('.bc-drawer-tab.is-active');
              const ar = active.getBoundingClientRect();
              const bar = document.querySelector('#bc-grid-resize-handle');
              const style = e => { const s = getComputedStyle(e); return { bg: s.backgroundColor, image: s.backgroundImage, fg: s.color, borderBottom: s.borderBottomWidth, bottomColor: s.borderBottomColor, radius: s.borderBottomLeftRadius }; };
              return { active: style(active), inactive: [...rail.querySelectorAll('.bc-drawer-tab:not(.is-active)')].map(style), panel: style(panel), bar: style(bar),
                activeBottom: ar.bottom, panelTop: pr.top, seamOwner: document.elementFromPoint(ar.x + ar.width / 2, pr.top + 0.5)?.className,
                selected: active.getAttribute('aria-selected'), visiblePanels: [...rail.querySelectorAll('.bc-drawer-tab-panel')].filter(e => getComputedStyle(e).display !== 'none').map(e => e.dataset.tab),
                overflow: rail.scrollWidth > rail.clientWidth, title: rail.querySelector('.bc-side-title').textContent };
            });
            const name = `${tenant}-${theme}-${tab}`;
            await page.locator('#bc-side-drawer').screenshot({ path: path.join(OUT, `${name}.png`) });
            results.push({ name, ...m });
            const check = (condition, msg) => { if (!condition) failures.push(`${name}: ${msg}`); };
            check(m.inactive.every(s => luminance(s.bg) < 0.18), 'inactive tabs must be dark grey');
            check(m.inactive.every(s => { const c = s.bg.match(/\d+/g).slice(0, 3).map(Number); return Math.max(...c) - Math.min(...c) <= 12; }), 'inactive colour must be neutral grey');
            check(m.inactive.every(s => contrast(s.bg, s.fg) >= 4.5), 'inactive label contrast >= 4.5');
            check(m.inactive.every(s => s.bg === m.bar.bg) && m.bar.image === 'none', 'resize bar must exactly match inactive tabs');
            check(m.active.bg === m.panel.bg, 'active background must match panel');
            check(m.active.radius === '0px', 'active tab bottom corners must be square');
            check(m.active.borderBottom === '0px' || m.active.bottomColor === 'rgba(0, 0, 0, 0)' || m.active.bottomColor === m.panel.bg, 'no visible active bottom border');
            check(m.activeBottom >= m.panelTop + 1 && String(m.seamOwner).includes('bc-drawer-tab'), 'active must cover panel rail at seam');
            check(m.selected === 'true' && m.visiblePanels.length === 1 && m.visiblePanels[0] === tab, 'real tab click selects exactly its panel');
            check(!m.overflow && m.title.includes('Tom'), 'drawer stays bounded and keeps booking');
          }
        }
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
        await page.locator('#bc-side-drawer .bc-drawer-tab[data-tab="services"]').click();
        await page.mouse.move(20, 20);
        await page.waitForTimeout(180);
        await page.screenshot({ path: path.join(OUT, `${tenant}-desktop.png`) });
        const bar = page.locator('#bc-grid-resize-handle');
        await bar.scrollIntoViewIfNeeded();
        const r = await bar.boundingBox();
        const before = await page.locator('#bc-grid-wrap').evaluate(e => e.getBoundingClientRect().height);
        await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
        await page.mouse.down(); await page.mouse.move(r.x + r.width / 2, r.y - 80, { steps: 8 }); await page.mouse.up();
        const after = await page.locator('#bc-grid-wrap').evaluate(e => e.getBoundingClientRect().height);
        results.push({ name: `${tenant}-resize`, before, after });
        if (!(before - after > 40)) failures.push(`${tenant}: resize drag must still shrink calendar`);
      } catch (e) { failures.push(`${tenant}: ${e.stack}`); }
      finally {
        fs.writeFileSync(path.join(OUT, `${tenant}-network.json`), JSON.stringify({ ledger, errors }, null, 2));
        if (errors.length) failures.push(`${tenant}: JS errors: ${errors.join('; ')}`);
        if (ledger.some(e => e.method !== 'GET')) failures.push(`${tenant}: unexpected mutation attempt`);
        if (ledger.some(e => e.unknown || e.missingAsset)) failures.push(`${tenant}: unmocked paths: ${[...new Set(ledger.filter(e => e.unknown || e.missingAsset).map(e => e.url))].join(', ')}`);
        if (ledger.some(e => /[?&]client(?:_slug)?=undefined/.test(e.url))) failures.push(`${tenant}: invalid tenant in request`);
        await ctx.close();
      }
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, failures }, null, 2));
  console.log(JSON.stringify({ cases: results.length, failures, out: OUT }, null, 2));
  if (failures.length) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
