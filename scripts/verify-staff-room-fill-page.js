'use strict';

/** Offline ordinary-entrypoint proof. No server, credentials, allocator or writes.
 * Run: node scripts/verify-staff-room-fill-page.js [evidence-directory]
 * Real buildUiHtml output/CSS; synthetic Wolfhouse session, inventory and preview.
 * Unknown requests are aborted AND fail the gate. Known external fonts are blocked.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const BASELINE = process.argv.includes('--baseline-head');
const OUT = path.resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) || '/opt/data/workspace/sandbox-repos/WH-captain/artifacts/room-placement-ui-001/page');
const ORIGIN = 'http://staff.test';
const CLIENT = 'wolfhouse-somo';
const NOTICE = 'Settings and preview only — not connected to booking placement.';
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const policy = { contractVersion: 1, fillMode: 'house', roomPriority: [R1, R2], roomPrioritySource: 'custom' };
const envelope = {
  success: true, activationStatus: 'not_connected', configured: true, policyStatus: 'saved', policy,
  suggestedPolicy: { ...policy, roomPrioritySource: 'default_numeric' },
  settingsRevision: 'a'.repeat(64), catalogRevision: 'b'.repeat(64),
  requiresReview: false, removedRoomIds: [], unrankedRoomIds: [],
  catalogue: [
    { roomId: R1, roomCode: 'R1', roomNumber: 1, capacity: 4, active: true, label: 'Room 1', genderLabel: 'Mixed', roomType: 'mixed' },
    { roomId: R2, roomCode: 'R2', roomNumber: 2, capacity: 2, active: true, label: 'Room 2', genderLabel: 'Female', roomType: 'female_only', restrictionLabel: null },
  ],
  legacyNote: NOTICE,
};
const report = {
  fixtureNotice: 'OFFLINE SYNTHETIC Wolfhouse owner/session, two catalogue rooms and fixed read-only preview. No real auth, inventory, allocation, persistence, booking or deployment proof. External fonts are blocked; browser fallback fonts apply. Production HTML/CSS is unmodified.',
  entrypoint: '/staff/ui → mobile Menu (390px only) → Admin → Luna Staff → Room placement',
  checks: [], requests: [], pageErrors: [], screenshots: [], cases: [],
};
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
function check(name, ok, detail) {
  report.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ': ' + JSON.stringify(detail) : ''}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  Object.assign(process.env, {
    NODE_ENV: 'test', STAFF_UI_BUILDER_TEST_SEAM: '1', STAFF_AUTH_REQUIRED: 'false',
    STAFF_AUTH_ALLOW_OPEN: 'true', DEFAULT_CLIENT_SLUG: CLIENT, STAFF_PORTAL_LOCALES: 'en,es,it',
  });
  delete process.env.LUNA_DEPLOYMENT;
  const modulePath = path.join(__dirname, 'browser/staff-room-fill.js');
  // Concurrent owner edits may land before the first browser run. Optional replay
  // reads the exact committed module through the REAL production injection seam;
  // it never edits the module or reconstructs/replaces emitted markup or CSS.
  const moduleSource = BASELINE
    ? execFileSync('git', ['show', 'HEAD:scripts/browser/staff-room-fill.js'], { cwd: ROOT, encoding: 'utf8' })
    : fs.readFileSync(modulePath, 'utf8');
  if (BASELINE) {
    const changed = execFileSync('git', ['diff', 'HEAD', '--name-only', '--', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    if (changed.some((file) => file !== 'scripts/browser/staff-room-fill.js' && !file.startsWith('scripts/verify-'))) throw new Error('Baseline replay requires unchanged production shell/injectors');
  }
  const readFileSync = fs.readFileSync;
  let html;
  try {
    fs.readFileSync = function (file, options) {
      if (typeof file === 'string' && path.resolve(file) === modulePath) return options === 'utf8' ? moduleSource : Buffer.from(moduleSource);
      return readFileSync.apply(this, arguments);
    };
    const { buildUiHtmlForOfflineTest } = require('./staff-query-api');
    html = buildUiHtmlForOfflineTest(0, CLIENT);
  } finally { fs.readFileSync = readFileSync; }
  report.source = BASELINE ? 'HEAD committed module replay through production buildUiHtml/injector (not first working-tree run)' : 'working tree';
  report.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  report.productionModuleSha256 = hash(moduleSource);
  report.scriptSha256 = hash(fs.readFileSync(__filename));
  report.htmlSha256 = hash(html);
  fs.writeFileSync(path.join(OUT, 'staff-ui.html'), html);
  const { buildClientProfilesMap, getAccessibleClients } = require('./lib/staff-portal-clients');
  const profiles = buildClientProfilesMap(null);
  const fixtures = {
    '/staff/auth/session': {
      success: true, auth_required: false, role: 'owner', email: null, display_name: 'Offline fixture',
      clients: getAccessibleClients(null).filter((c) => (typeof c === 'string' ? c : c.slug) === CLIENT),
      client_profiles: { [CLIENT]: profiles[CLIENT] }, can_use_owner_insights: true,
    },
    '/staff/luna-intelligence/room-fill': envelope,
    '/staff/intents': { success: true, intents: [] },
    '/staff/inbox/luna-mode': { success: true, modes: { whatsapp: 'draft', email: 'draft' } },
    '/staff/bot/global-pause-state': { success: true, paused: false, client_slug: CLIENT },
    '/staff/whatsapp-numbers': { success: true, rows: [], numbers: [] },
    '/staff/admin/house-notes': { success: true, notes: 'Offline synthetic fixture. No live operational notes.' },
    '/staff/automated-notifications': { success: true, rows: [], notifications: [] },
    '/staff/notification-settings': { success: true, new_conversation: { enabled: false, recipients: [] }, human_needed: { enabled: false, recipients: [] } },
    '/staff/bed-calendar': { success: true, rooms: [], beds: [], bookings: [], rows: [], days: [] },
    // Finance is visited only as the Admin default; explicitly unavailable, not fake revenue.
    '/staff/admin/finance/summary': { success: false, error: 'Finance outside this offline Room Placement fixture' },
    '/staff/luna-personality': { success: true, personality_id: 'sunny' },
    '/staff/luna-intelligence': { success: true, enabled: false, client_slug: CLIENT },
  };
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [390, 1280]) {
      for (const theme of ['light', 'dark']) {
        const tag = `${theme}-${width}`;
        const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', colorScheme: theme });
        context.setDefaultTimeout(5000);
        await context.routeWebSocket('**/*', (socket) => {
          report.requests.push({ tag, method: 'WEBSOCKET', url: socket.url(), disposition: 'unexpected-blocked' });
          socket.close();
        });
        await context.addInitScript(({ client }) => {
          localStorage.setItem('staff_portal_client', client);
          localStorage.setItem('wh_staff_portal_locale', 'en');
        }, { client: CLIENT });
        await context.route('**/*', async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          const entry = { tag, method: request.method(), url: request.url(), body: request.postData(), disposition: 'unexpected-blocked' };
          report.requests.push(entry);
          const json = (body) => { entry.disposition = 'synthetic-read-only'; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }); };
          if (url.origin !== ORIGIN) {
            if (request.method() === 'GET' && ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'].includes(url.origin)) entry.disposition = 'known-font-blocked';
            return route.abort('blockedbyclient');
          }
          if (request.method() === 'GET' && url.pathname === '/staff/ui') {
            entry.disposition = 'production-html';
            return route.fulfill({ status: 200, contentType: 'text/html', body: html });
          }
          if (request.method() === 'GET' && url.pathname === '/staff/assets/luna-front-desk-logo.png' && url.search === '?v=2') {
            entry.disposition = 'production-asset';
            return route.fulfill({ contentType: 'image/png', body: fs.readFileSync(path.join(ROOT, 'config/staff-portal/luna-front-desk-logo.png')) });
          }
          if (request.method() === 'GET' && Object.hasOwn(fixtures, url.pathname)
              && ['client', 'client_slug'].every((key) => !url.searchParams.has(key) || url.searchParams.get(key) === CLIENT)) return json(fixtures[url.pathname]);
          if (request.method() === 'POST' && url.pathname === '/staff/luna-intelligence/room-fill/rooms') {
            const roomId = '12121212-1212-4121-8121-121212121212';
            const saved = JSON.parse(JSON.stringify(envelope));
            saved.catalogue.push({ roomId, roomCode: 'R12', roomNumber: 12, capacity: 6, active: true, label: 'Room 12', genderLabel: 'Mixed', bedIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddd01'] });
            saved.policy = { ...saved.policy, roomPriority: saved.policy.roomPriority.concat(roomId) };
            saved.roomId = roomId;
            saved.bedIds = ['dddddddd-dddd-4ddd-8ddd-dddddddddd01'];
            saved.calendarRoomId = roomId;
            saved.calendarBedIds = saved.bedIds;
            entry.disposition = 'synthetic-room-create';
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(saved) });
          }
          if (request.method() === 'POST' && url.pathname === '/staff/luna-intelligence/room-fill/preview') {
            let body;
            try { body = JSON.parse(request.postData() || '{}'); } catch (_) { return route.abort(); }
            const expectedKeys = ['policySource', 'expectedCatalogRevision', 'draftPolicy', 'checkIn', 'checkOut', 'partySize', 'groupGender', 'roomPreference'];
            const valid = Object.keys(body).every((key) => expectedKeys.includes(key)) && body.policySource === 'draft'
              && body.expectedCatalogRevision === envelope.catalogRevision
              && Array.isArray(body.draftPolicy?.roomPriority)
              && body.draftPolicy.roomPriority.includes(R1)
              && body.draftPolicy.roomPriority.includes(R2)
              && ['house', 'room'].includes(body.draftPolicy?.fillMode)
              && Object.keys(body.draftPolicy).every((key) => ['contractVersion', 'fillMode', 'roomPriority', 'roomPrioritySource'].includes(key))
              && body.checkIn === '2026-10-10' && body.checkOut === '2026-10-11' && body.partySize === 1;
            check(`${tag} preview payload uses only saved catalogue (no builder fields/IDs)`, valid, body);
            if (!valid) return route.abort('blockedbyclient');
            return json({ success: true, mode: body.draftPolicy.fillMode, source: 'draft', reservationCreated: false,
              notice: NOTICE,
              decision: { status: 'placed', selected: [{ roomId: R1, roomCode: 'R1', beds: [{ bedCode: 'R1-B1' }] }],
                rationale: [{ code: 'house_lowest_projected_occupancy', text: 'Synthetic preview selected an eligible saved room.' }], rooms: [] } });
          }
          return route.abort('blockedbyclient');
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => report.pageErrors.push({ tag, message: error.message }));
        const detail = { tag, width, theme };
        report.cases.push(detail);
        try {
          await page.goto(`${ORIGIN}/staff/ui`, { waitUntil: 'domcontentloaded' });
          await page.waitForFunction((client) => !document.body.classList.contains('portal-profile-pending') && document.getElementById('c-client')?.value === client, CLIENT);
          if (await page.locator('#nav-menu-toggle').isVisible()) await page.locator('#nav-menu-toggle').click();
          await page.locator('button.tab-btn[data-tab="admin"]').click();
          await page.locator('#wh-admin-tab-luna-staff').click();
          const root = page.locator('#staff-room-fill');
          await root.waitFor({ state: 'visible' });
          await root.locator('#staff-room-fill-list [data-room-id]').first().waitFor({ state: 'visible' });
          const actualTheme = await page.locator('html').getAttribute('data-theme');
          if ((actualTheme === 'dark') !== (theme === 'dark')) {
            if (!await page.locator('#staff-theme-toggle').isVisible()) await page.locator('#nav-menu-toggle').click();
            await page.locator('#staff-theme-toggle').click();
            if (await page.locator('body').evaluate((el) => el.classList.contains('nav-menu-open'))) await page.keyboard.press('Escape');
          }
          check(`${tag} ordinary Admin → Luna Staff entrypoint`, await root.isVisible());
          check(`${tag} intended theme`, (await page.locator('html').getAttribute('data-theme') === 'dark') === (theme === 'dark'));
          // Resolve inherited production tokens with a hidden measurement probe: no stylesheet overrides.
          detail.cards = await root.locator('.rf-card').evaluateAll((cards) => cards.map((card) => {
            const cs = getComputedStyle(card);
            const tokenProbe = document.createElement('span');
            tokenProbe.style.cssText = 'position:absolute;visibility:hidden;background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius-sm);box-shadow:var(--shadow-soft)';
            card.appendChild(tokenProbe);
            const probe = getComputedStyle(tokenProbe);
            const expected = { background: probe.backgroundColor, border: probe.borderTopColor, radius: probe.borderTopLeftRadius, shadow: probe.boxShadow };
            tokenProbe.remove();
            return { title: card.querySelector('h4')?.textContent, background: cs.backgroundColor, border: cs.borderTopColor, radius: cs.borderTopLeftRadius, shadow: cs.boxShadow, padding: cs.paddingTop, expected };
          }));
          check(`${tag} placement cards exist`, detail.cards.length >= 3, detail.cards.length);
          check(`${tag} locked native card CSS`, detail.cards.length >= 3 && detail.cards.every((card) => theme === 'dark'
            ? card.background === 'rgb(45, 45, 45)' && card.border === 'rgb(60, 60, 60)' && card.shadow === 'none' && card.radius === card.expected.radius
            : ['background', 'border', 'radius', 'shadow'].every((key) => card[key] === card.expected[key])), detail.cards);
          check(`${tag} card padding`, detail.cards.length >= 3 && detail.cards.every((card) => width === 390 ? [14, 15, 16].includes(parseFloat(card.padding)) : card.padding === '20px'), detail.cards);
          check(`${tag} obsolete banner absent initially`, !(await root.innerText()).includes(NOTICE) && await root.locator('#staff-room-fill-notice').count() === 0);
          const builder = root.locator('#rf-builder-number');
          const hasBuilder = await builder.count() === 1;
          check(`${tag} room builder available`, hasBuilder);
          if (hasBuilder) {
            detail.genderControls = await root.locator('.rf-genders label').evaluateAll(labels => labels.map(label => {
              const input = label.querySelector('input');
              const cs = getComputedStyle(input);
              return { labelWidth: label.getBoundingClientRect().width, inputWidth: input.getBoundingClientRect().width, minWidth: cs.minWidth, flex: cs.flex };
            }));
            check(`${tag} compact gender pebbles`, detail.genderControls.every(control => control.labelWidth <= 140 && control.inputWidth <= 24), detail.genderControls);
            check(`${tag} gender not silently preselected`, await root.locator('input[name="rf-builder-gender"]:checked').count() === 0);
            const requestsBefore = report.requests.length;
            await builder.fill('12');
            await root.locator('#rf-builder-beds').fill('6');
            await root.locator('input[name="rf-builder-gender"][value="mixed"]').check();
            await root.locator('#rf-builder-add').click();
            await root.locator('#staff-room-fill-list').getByText('Room 12').waitFor({ state: 'visible' });
            const savedText = await root.locator('#staff-room-fill-list').innerText();
            check(`${tag} saved room is in priority with gender`, /Room 12/i.test(savedText) && /Mixed/i.test(savedText), savedText);
            check(`${tag} builder save is the only new write`, report.requests.slice(requestsBefore).some((item) => item.method === 'POST' && item.url.includes('/rooms')));
            check(`${tag} no detached draft`, await root.locator('.rf-draft').count() === 0);
            check(`${tag} save disclosure`, (await root.innerText()).includes('Add room & save creates the beds and saves the current placement order.'));
          }
          // Existing form selectors keep the baseline preview runnable before the builder lands.
          const mode = root.locator('input[name="rf-mode"][value="house"],input[name="staff-room-fill-mode"][value="house"]');
          await mode.check();
          const form = root.locator('#staff-room-fill-preview-form');
          await form.locator('[name="checkIn"]').fill('2026-10-10');
          await form.locator('[name="checkOut"]').fill('2026-10-11');
          await form.locator('[name="partySize"]').fill('1');
          await form.locator('button[type="submit"]').click();
          await page.waitForFunction(() => document.getElementById('staff-room-fill-preview-out')?.innerText.includes('R1-B1'));
          detail.previewText = await root.locator('#staff-room-fill-preview-out').innerText();
          check(`${tag} synthetic preview outcome rendered`, detail.previewText.includes('R1-B1') && detail.previewText.includes('Synthetic preview selected an eligible saved room.'), detail.previewText);
          check(`${tag} preview does not claim reservation`, (await root.innerText()).includes('Preview only · no beds reserved.') && !/reservation created|booked/i.test(detail.previewText));
          check(`${tag} obsolete banner absent after preview`, !(await root.innerText()).includes(NOTICE) && await root.locator('#staff-room-fill-notice').count() === 0);
          if (hasBuilder) check(`${tag} saved room remains after preview`, (await root.locator('#staff-room-fill-list').innerText()).includes('Room 12'));
          detail.geometry = await root.evaluate((node) => ({ viewport: innerWidth, rootWidth: node.clientWidth, rootScrollWidth: node.scrollWidth,
            overflowing: [...node.querySelectorAll('.rf-card, input, select, button')].filter((el) => {
              const r = el.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
            }).map((el) => ({ tag: el.tagName, id: el.id, text: el.textContent?.slice(0, 60) })) }));
          check(`${tag} Room Placement has no horizontal overflow`, detail.geometry.rootScrollWidth <= detail.geometry.rootWidth + 1 && detail.geometry.overflowing.length === 0, detail.geometry);
          const screenshot = path.join(OUT, `room-placement-${tag}.png`);
          if (width >= 850) {
            // Tall locator screenshots resize the viewport and mis-crop Staff's
            // nested desktop scroll panel. Capture ordinary viewport pixels instead.
            await root.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
            await page.screenshot({ path: screenshot });
            const previewShot = path.join(OUT, `room-placement-preview-${tag}.png`);
            await root.locator('#staff-room-fill-preview-out').scrollIntoViewIfNeeded();
            await page.screenshot({ path: previewShot });
            report.screenshots.push(previewShot);
          } else {
            await root.scrollIntoViewIfNeeded();
            await root.screenshot({ path: screenshot });
          }
          report.screenshots.push(screenshot);
          const pageShot = path.join(OUT, `staff-page-${tag}.png`);
          await page.screenshot({ path: pageShot, fullPage: true });
          report.screenshots.push(pageShot);
        } catch (error) {
          check(`${tag} browser flow completed`, false, error.message);
          const screenshot = path.join(OUT, `failure-${tag}.png`);
          await page.screenshot({ path: screenshot, fullPage: true }).then(() => report.screenshots.push(screenshot)).catch(() => {});
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  check('no unknown/external/write requests escaped fixture allowlist', !report.requests.some((r) => r.disposition === 'unexpected-blocked'), report.requests.filter((r) => r.disposition === 'unexpected-blocked'));
  check('no uncaught page errors', report.pageErrors.length === 0, report.pageErrors);
}

main().catch((error) => check('harness completed', false, error.stack)).finally(() => {
  report.verdict = report.checks.some((c) => !c.ok) ? 'RED' : 'PASS';
  report.failures = report.checks.filter((c) => !c.ok);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.verdict === 'RED' && !fs.existsSync(path.join(OUT, 'first-red.json'))) {
    fs.writeFileSync(path.join(OUT, 'first-red.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(`${report.verdict}: ${report.failures.length} failures; evidence ${OUT}`);
  process.exitCode = report.verdict === 'PASS' ? 0 : 1;
});
