'use strict';
// LOCAL SYNTHETIC ONLY. Actual emitted portal; no server, external forwarding, or writes.
// node scripts/verify-schedule-bed-label-compact-browser.js <output-dir>
// SCHEDULE_HTML_DIR=<frozen .html.gz directory> replays the unmodified RED emission.
// SCHEDULE_BASELINE_DIR=<RED directory> additionally compares non-target DOM/style contracts.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'artifacts/schedule-bed-label-compact-001/browser/current'));
const ORIGIN = 'http://staff.test';
const BEDS = [1, 2, 9, 10, 12, 32];
const WIDTHS = [320, 390, 768, 769, 1024, 1440];
const ledger = [], errors = [], cases = [], failures = [];
const htmlCache = new Map();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const baseline = process.env.SCHEDULE_BASELINE_DIR ? JSON.parse(fs.readFileSync(path.join(process.env.SCHEDULE_BASELINE_DIR, 'results.json'), 'utf8')) : null;
function check(condition, id, message, details) {
  if (!condition) failures.push({ id, message, details });
}
function emit(tenant) {
  if (htmlCache.has(tenant)) return htmlCache.get(tenant);
  let html;
  if (process.env.SCHEDULE_HTML_DIR) {
    const file = path.join(process.env.SCHEDULE_HTML_DIR, tenant + '.html.gz');
    html = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  } else {
    const code = "process.env.NODE_ENV='test';process.env.STAFF_UI_BUILDER_TEST_SEAM='1';process.env.STAFF_AUTH_REQUIRED='false';process.env.STAFF_AUTH_ALLOW_OPEN='true';process.env.DEFAULT_CLIENT_SLUG=process.argv[1];process.stdout.write(require('./scripts/staff-query-api.js').buildUiHtmlForOfflineTest(0,process.argv[1]));";
    const result = spawnSync(process.execPath, ['-e', code, tenant], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr);
    html = result.stdout;
  }
  fs.writeFileSync(path.join(OUT, tenant + '.html.gz'), zlib.gzipSync(html));
  htmlCache.set(tenant, html);
  return html;
}
function calendar(start, end, maxDays) {
  const days = [];
  for (let date = new Date(start + 'T00:00:00Z'); date <= new Date(end + 'T00:00:00Z') && days.length < maxDays; date.setUTCDate(date.getUTCDate() + 1)) {
    days.push({ date: date.toISOString().slice(0, 10) });
    if (days.length > 62) throw new Error('Unexpected fixture range exceeds 62 days');
  }
  const checkout = new Date(start + 'T00:00:00Z'); checkout.setUTCDate(checkout.getUTCDate() + 5);
  const until = checkout.toISOString().slice(0, 10);
  const rooms = [1, 2].map(r => ({ room_code: 'R' + r, room_name: 'R' + r, capacity: 32,
    beds: Array.from({ length: 32 }, (_, i) => ({ bed_code: `R${r}-B${i + 1}`, bed_label: 'Bed ' + (i + 1) })) }));
  const blocks = rooms.flatMap((room, r) => BEDS.map(b => ({
    booking_id: `aaaaaaaa-aaaa-4aaa-8aaa-${String((r + 1) * 100 + b).padStart(12, '0')}`,
    booking_code: `WH-SYNTHETIC-R${r + 1}-B${b}`, guest_name: `Synthetic guest ${r + 1}-${b}`,
    guest_count: 1, status: 'confirmed', check_in: start, check_out: until,
    room_code: room.room_code, bed_code: `${room.room_code}-B${b}`, start_date: start,
    end_date: until, start_offset: 0, span: 5, source: 'staff', invoice_total_cents: 10000,
    ledger_paid_cents: 10000, balance_due_cents: 0, calendar_payment_primary: 'paid'
  })));
  return { success: true, days, rooms, blocks, warnings: [] };
}
async function settle(page) {
  await page.evaluate(() => new Promise(resolve => {
    let frames = 5; function tick() { if (--frames === 0) resolve(); else requestAnimationFrame(tick); } requestAnimationFrame(tick);
  }));
}
async function open(browser, spec) {
  const { width, theme, tenant, id } = spec;
  const html = emit(tenant);
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width <= 768, serviceWorkers: 'block', timezoneId: 'UTC' });
  await ctx.routeWebSocket('**/*', ws => { ledger.push({ id, method: 'WEBSOCKET', url: ws.url(), blocked: true }); ws.close(); });
  const fixtures = {
    '/staff/schedule/day': { success: true, rows: [], rental_label_map: {} },
    '/staff/schedule/bookings/catalog': { success: true, ok: true, courses: [], offerings: [], rentals: [] },
    '/staff/auth/session': { success: true, auth_required: false, role: 'admin', clients: [{ slug: tenant, name: tenant }], client_profiles: { [tenant]: loadClientPortalProfile(tenant) } },
    '/staff/intents': { success: true, intents: [] }, '/staff/inbox/luna-mode': { success: true, mode: 'off' },
    '/staff/bot/global-pause-state': { success: true, paused: false }, '/staff/whatsapp-numbers': { success: true, numbers: [] },
    '/staff/admin/house-notes': { success: true, notes: '' }, '/staff/automated-notifications': { success: true, notifications: [] },
    '/staff/packages': { success: true, packages: [] }, '/staff/conversations': { success: true, conversations: [] },
    '/staff/admin/config': { success: true, ...resolveTenantBusinessConfig(tenant, 'sunset-somo') },
    '/staff/admin/config/rental-offerings': { success: true, offerings: [] }, '/staff/clients': { success: true, clients: [{ slug: tenant, name: tenant }] }
  };
  const assetDir = path.join(ROOT, 'config/staff-portal');
  const assets = new Map(fs.readdirSync(assetDir).filter(f => fs.statSync(path.join(assetDir, f)).isFile()).map(f => ['/staff/assets/' + f, path.join(assetDir, f)]));
  await ctx.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    const entry = { id, method: req.method(), url: req.url(), provenance: 'local intercepted synthetic response; never forwarded' };
    ledger.push(entry);
    if (req.method() === 'GET' && req.url() === 'https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=Instrument+Sans:wght@400;500;600;700&display=swap') {
      entry.optionalFontBlocked = true; return route.abort();
    }
    if (u.origin !== ORIGIN || req.method() !== 'GET') { entry.blocked = true; return route.abort(); }
    if (u.pathname === '/staff/ui') { entry.kind = 'production-emitted-html'; return route.fulfill({ contentType: 'text/html', body: html }); }
    if (assets.has(u.pathname)) { entry.kind = 'local-production-asset'; return route.fulfill({ path: assets.get(u.pathname) }); }
    if (u.pathname === '/staff/bed-calendar' && tenant === 'sunset') { entry.blocked = true; return route.abort(); }
    let data;
    if (u.pathname === '/staff/bed-calendar') {
      // The native Next 30 days requests inclusive today + 30 (31 dates).
      // Deliberately return a 30-column synthetic fixture for the short-grid contract.
      // The real Jul-Aug click supplies all 62 dates for the long-grid contract.
      data = calendar(u.searchParams.get('start'), u.searchParams.get('end'), spec.days);
      entry.days = data.days.length;
    } else data = fixtures[u.pathname];
    if (!data) { entry.unknown = true; return route.abort(); }
    entry.kind = 'synthetic-json'; return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await ctx.addInitScript(() => localStorage.setItem('wh_staff_portal_locale', 'en'));
  const page = await ctx.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push({ id, error: String(error) }));
  await page.clock.setFixedTime(new Date('2026-07-01T12:00:00Z'));
  await page.goto(ORIGIN + '/staff/ui');
  await page.waitForFunction(t => typeof window.switchToTab === 'function' && document.getElementById('c-client').value === t, tenant);
  // The legacy .tab-btn is hidden by the current shell. Use the same public
  // production navigation seam as verify-schedule-chrome-mobile.js, not a renderer.
  await page.evaluate(tab => window.switchToTab(tab), tenant === 'sunset' ? 'portal-home' : 'bed-calendar');
  if (tenant === 'sunset') await page.locator('#tab-portal-home').waitFor();
  else {
    await page.locator('.bc-room-hdr').first().waitFor();
    if (spec.days === 62) {
      const response = page.waitForResponse(r => new URL(r.url()).pathname === '/staff/bed-calendar' && new URL(r.url()).searchParams.get('end') === '2026-08-31');
      await page.locator('#bc-chips [data-chip="jul-aug"]').click(); await response;
    }
    await page.waitForFunction(n => document.querySelectorAll('#bc-grid-wrap thead th').length === n + 1, spec.days);
    await page.waitForFunction(() => !document.getElementById('bc-load').disabled);
  }
  await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
  await page.mouse.move(0, 0); await settle(page);
  return { ctx, page };
}
async function preservation(page) {
  return page.evaluate(() => {
    const style = e => { const s = getComputedStyle(e); return { font: s.font, color: s.color, background: s.backgroundColor, borderRadius: s.borderRadius }; };
    return {
      headers: [...document.querySelectorAll('.bc-room-hdr')].map(e => ({ html: e.innerHTML, style: style(e), colspan: e.colSpan })),
      bars: [...document.querySelectorAll('#bc-grid-wrap .bc-block')].map(e => ({ html: e.outerHTML, style: style(e), colspan: e.closest('td').colSpan })),
      dates: [...document.querySelectorAll('#bc-grid-wrap thead th')].slice(1).map(e => e.textContent)
    };
  });
}
async function measure(page, bed) {
  const row = page.locator('.bc-room-bed-row[data-room="R1"]').nth(bed - 1);
  await row.evaluate(e => {
    const w = document.getElementById('bc-grid-wrap');
    w.scrollTop += e.getBoundingClientRect().top - w.getBoundingClientRect().top - 150;
  });
  await settle(page);
  return row.evaluate(e => {
    const box = r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height });
    const cell = e.querySelector('.bc-bed-cell'), r = cell.getBoundingClientRect(), s = getComputedStyle(cell);
    const number = key => parseFloat(s[key]) || 0;
    const inner = { left: r.left + number('borderLeftWidth') + number('paddingLeft'), right: r.right - number('borderRightWidth') - number('paddingRight'), top: r.top + number('borderTopWidth') + number('paddingTop'), bottom: r.bottom - number('borderBottomWidth') - number('paddingBottom') };
    const range = document.createRange(); range.selectNodeContents(cell);
    const textRects = [...range.getClientRects()].map(box);
    const w = document.getElementById('bc-grid-wrap'), wr = w.getBoundingClientRect();
    const adjacent = cell.nextElementSibling, ar = adjacent.getBoundingClientRect();
    // At horizontal scroll, the booking cell intentionally moves UNDER the sticky bed.
    // Its painted, exposed area begins at the bed's right edge, not its raw left edge.
    const adjacentExposed = { left: Math.max(ar.left, r.right, wr.left), right: Math.min(ar.right, wr.right), top: ar.top, bottom: ar.bottom };
    const overlaps = (a, b) => b.right > b.left && a.right > b.left + 0.5 && a.left < b.right - 0.5 && a.bottom > b.top + 0.5 && a.top < b.bottom - 0.5;
    const inside = (a, b) => a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    const visible = textRects.every(a => inside(a, wr) && cell.contains(document.elementFromPoint((a.left + a.right) / 2, (a.top + a.bottom) / 2)));
    return {
      text: cell.textContent.trim(), cell: box(r), inner, textRects, adjacent: box(ar), adjacentExposed,
      adjacentBooking: !!adjacent.querySelector('.bc-block'), adjacentBookingText: adjacent.textContent,
      containedInInner: textRects.length > 0 && textRects.every(a => inside(a, inner)),
      containedInCell: textRects.length > 0 && textRects.every(a => inside(a, r)),
      overlapsAdjacentExposed: textRects.some(a => overlaps(a, adjacentExposed)),
      visible, scrollLeft: w.scrollLeft, scrollTop: w.scrollTop, scrollWidth: w.scrollWidth, clientWidth: w.clientWidth,
      style: { font: s.font, paddingLeft: s.paddingLeft, paddingRight: s.paddingRight, borderRightWidth: s.borderRightWidth, position: s.position, whiteSpace: s.whiteSpace },
      roomHeader: box(w.querySelector('.bc-room-hdr-inner').getBoundingClientRect())
    };
  });
}
async function wolfhouse(browser, spec) {
  const { ctx, page } = await open(browser, spec);
  const result = { ...spec, geometry: [], screenshots: [], preservation: await preservation(page) };
  cases.push(result);
  try {
    check(result.preservation.headers.length === 2 && result.preservation.headers.every((h, i) => h.html.startsWith('<span class="bc-room-hdr-inner">Room ' + (i + 1))), spec.id, 'Room 1/Room 2 headers retained');
    check(result.preservation.bars.length === 12, spec.id, 'All twelve synthetic bookings retained', result.preservation.bars.length);
    for (const phase of spec.width <= 768 ? ['before', 'after'] : ['before']) {
      await page.locator('#bc-grid-wrap').evaluate((w, phase) => { w.scrollLeft = phase === 'after' ? 440 : 0; }, phase);
      await settle(page);
      for (const bed of BEDS) {
        const m = await measure(page, bed); result.geometry.push({ bed, phase, ...m });
        check(m.text === 'B' + bed, spec.id, 'Compact label ' + phase + ' B' + bed, m.text);
        check(m.containedInInner, spec.id, 'Text DOM Range inside inner box ' + phase + ' B' + bed, { cell: m.cell, inner: m.inner, textRects: m.textRects });
        check(m.containedInCell && !m.overlapsAdjacentExposed, spec.id, 'No text outside cell/over adjacent booking ' + phase + ' B' + bed);
        check(m.visible, spec.id, 'Measured label visible and hit-testable ' + phase + ' B' + bed);
        check(m.adjacentBooking, spec.id, 'Real neighboring booking cell present ' + phase + ' B' + bed);
        if (phase === 'after') {
          const before = result.geometry.find(g => g.bed === bed && g.phase === 'before');
          check(m.scrollLeft > 0 && Math.abs(m.cell.left - before.cell.left) < 1, spec.id, 'Real horizontal scroll with stationary sticky label B' + bed, m.scrollLeft);
        }
        if (bed === 1 || bed === 32) {
          const file = `local-synthetic-${spec.id}-${phase}-B${bed}.png`;
          await page.screenshot({ path: path.join(OUT, file) }); result.screenshots.push(file);
        }
      }
    }
    const after = await preservation(page);
    check(JSON.stringify(after) === JSON.stringify(result.preservation), spec.id, 'Room headers and booking DOM/styles unchanged across scroll');
    if (baseline) {
      const old = baseline.cases.find(c => c.id === spec.id);
      check(!!old && JSON.stringify(old.preservation) === JSON.stringify(result.preservation), spec.id, 'Room headers and booking DOM/styles unchanged from RED');
    }
  } finally { await ctx.close(); }
}
async function sunset(browser, spec) {
  const { ctx, page } = await open(browser, spec);
  try {
    const result = { ...spec, nativeVisible: await page.locator('#tab-portal-home').isVisible(), bedVisible: await page.locator('#tab-bed-calendar').isVisible(),
      nativeDOMSha256: sha(await page.locator('#tab-portal-home').innerHTML()) };
    cases.push(result);
    check(result.nativeVisible && !result.bedVisible, spec.id, 'Sunset retains native surf Schedule; no fabricated bed view');
    check(ledger.some(e => e.id === spec.id && new URL(e.url).pathname === '/staff/schedule/day'), spec.id, 'Native surf schedule requested');
    check(!ledger.some(e => e.id === spec.id && new URL(e.url).pathname === '/staff/bed-calendar'), spec.id, 'No Sunset bed-calendar request');
    if (baseline) check(baseline.cases.find(c => c.id === spec.id)?.nativeDOMSha256 === result.nativeDOMSha256, spec.id, 'Sunset native Schedule DOM unchanged from RED');
    result.screenshots = [`local-synthetic-${spec.id}.png`];
    await page.screenshot({ path: path.join(OUT, result.screenshots[0]) });
  } finally { await ctx.close(); }
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // Freeze both emissions before the matrix; later product edits cannot contaminate cases.
  for (const tenant of ['wolfhouse-somo', 'sunset']) emit(tenant);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of WIDTHS) for (const theme of ['light', 'dark']) for (const days of [30, 62]) {
      const spec = { id: `wolfhouse-${width}-${theme}-${days}d`, tenant: 'wolfhouse-somo', width, theme, days };
      const before = failures.length;
      try { await wolfhouse(browser, spec); } catch (error) { failures.push({ id: spec.id, harnessError: error.stack }); console.error(spec.id, error.stack); }
      console.log(spec.id + ': ' + (failures.length - before) + ' failures');
    }
    for (const width of WIDTHS) for (const theme of ['light', 'dark']) {
      const spec = { id: `sunset-${width}-${theme}`, tenant: 'sunset', width, theme };
      try { await sunset(browser, spec); } catch (error) { failures.push({ id: spec.id, harnessError: error.stack }); console.error(spec.id, error.stack); }
    }
  } finally {
    await browser.close();
    check(cases.filter(c => c.tenant === 'wolfhouse-somo').length === 24, 'coverage', 'All 24 bed-grid cases completed');
    check(cases.filter(c => c.tenant === 'sunset').length === 12, 'coverage', 'All 12 native Sunset cases completed');
    check(cases.reduce((n, c) => n + (c.geometry?.length || 0), 0) === 216, 'coverage', 'All 216 pre/post target label measurements completed');
    check(errors.length === 0, 'runtime', 'No page errors', errors);
    check(!ledger.some(e => e.blocked || e.unknown), 'network', 'No unexpected routes/mutations', ledger.filter(e => e.blocked || e.unknown));
    const result = {
      provenance: 'LOCAL SYNTHETIC ONLY; actual emitted production portal, synthetic rooms/bookings/session, local production assets, all requests intercepted, optional Google font aborted. Chromium emulation, not physical-device or live proof.',
      frozenHtmlDirectory: process.env.SCHEDULE_HTML_DIR || null, baselineDirectory: process.env.SCHEDULE_BASELINE_DIR || null,
      revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
      verifierSha256: sha(fs.readFileSync(__filename)), emittedHtmlSha256: Object.fromEntries([...htmlCache].map(([k, v]) => [k, sha(v)])),
      status: failures.length ? 'FAIL' : 'PASS', failures, errors, cases,
      summary: { cases: cases.length, measurements: cases.reduce((n, c) => n + (c.geometry?.length || 0), 0), failures: failures.length,
        requests: ledger.length, unexpectedRequests: ledger.filter(e => e.blocked || e.unknown).length, pageErrors: errors.length }
    };
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(OUT, 'geometry.json'), JSON.stringify(cases.filter(c => c.geometry).map(({ id, geometry }) => ({ id, geometry })), null, 2));
    fs.writeFileSync(path.join(OUT, 'network-ledger.json'), JSON.stringify({ provenance: result.provenance, ledger }, null, 2));
    console.log(JSON.stringify(result.summary));
    if (failures.length) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
