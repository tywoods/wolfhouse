'use strict';

/**
 * Acceptance: Phase B reauthorize control on real generated /staff/ui in Chromium.
 * Unit DOM harness in verify-sunset-email-settings.js is unit-only; this is acceptance.
 *
 * Uses production buildUiHtmlForOfflineTest HTML/JS/CSS via sunset-admin-verify-server.
 * Playwright route interception for settings GET + reauthorize POST.
 * Exercises real production transitions (client selector, Email reload, lang buttons)
 * — never private cancel-only shortcuts for client/rerender isolation.
 *
 * Browser binary (local, not committed):
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/data/playwright-browsers npx playwright install chromium
 * Run with the same env.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.SUNSET_EMAIL_SETTINGS_UI_ENABLED = 'true';
process.env.DEFAULT_CLIENT_SLUG = 'sunset';
process.env.LUNA_DEPLOYMENT = 'sunset-staging';
process.env.LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED = 'true';
// Production language set for ES + IT reauth safety acceptance (deployment-owned).
process.env.STAFF_PORTAL_LOCALES = 'es,en,it';

// Prefer local ignored browser cache when present (host env may point elsewhere).
// Do not commit browser binaries; install with:
//   PLAYWRIGHT_BROWSERS_PATH=/opt/data/playwright-browsers npx playwright install chromium
(function pinPlaywrightBrowsersPath() {
  const preferred = '/opt/data/playwright-browsers';
  try {
    if (fs.existsSync(preferred) && fs.readdirSync(preferred).some((n) => /^chromium/i.test(n))) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = preferred;
      return;
    }
  } catch (_) { /* fall through */ }
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = preferred;
  }
})();

const LOCATION = 'sunset-somo';
const ENDPOINT_ID = '22222222-2222-4222-8222-222222222222';
const MAILBOX = 'desk@sunset.example';
const APP_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CANON_AUTH = 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize';
const CANON_REDIR = 'https://sunset-staging.lunafrontdesk.com/staff/email/oauth/microsoft/callback';
const CANON_SCOPES = 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send';
const B64_32 = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'; // 43 chars

// Exact production i18n safety notes (English fallback must fail for ES/IT asserts).
const ES_SAFETY = 'Se están actualizando los permisos de Microsoft para las respuestas aprobadas por el personal. La autorización en sí no envía ningún correo.';
const ES_BUTTON = 'Reautorizar Microsoft';
const IT_SAFETY = 'Le autorizzazioni Microsoft vengono aggiornate per le risposte approvate dallo staff. L\u2019autorizzazione stessa non invia alcuna email.';
const IT_BUTTON = 'Riautorizza Microsoft';
const EN_SAFETY = 'Microsoft permissions are being upgraded for staff-approved replies. Authorization itself does not send any email.';
// Exact fixed bounded error copy from staff-portal-i18n EN admin.email.state.error.
const EN_ERROR = 'Email status is temporarily unavailable.';
const MS_ORIGIN = 'https://login.microsoftonline.com';
const MS_PATH = '/organizations/oauth2/v2.0/authorize';

/**
 * Exact console.error allowlist. Every console.error fails the gate unless listed here
 * as a full exact message string (never broad regexes).
 *
 * Known benign:
 * - Chromium logs a failed-network console.error when the table-driven non-2xx case
 *   intentionally fulfills the reauthorize POST with HTTP 503. That is the product
 *   bounded-error path under test, not an unexpected runtime failure.
 * @type {string[]}
 */
const CONSOLE_ERROR_ALLOWLIST = [
  'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
];

function buildValidReauthUrl(mut) {
  const u = new URL(CANON_AUTH);
  const pairs = [
    ['client_id', APP_ID], ['response_type', 'code'], ['redirect_uri', CANON_REDIR],
    ['response_mode', 'query'], ['scope', CANON_SCOPES], ['state', B64_32],
    ['nonce', B64_32], ['code_challenge', B64_32], ['code_challenge_method', 'S256'],
    ['prompt', 'consent'],
  ];
  for (const [k, v] of pairs) u.searchParams.set(k, v);
  if (typeof mut === 'function') mut(u);
  return u.toString();
}

function futureExpires(msFromNow = 600000) {
  return new Date(Date.now() + msFromNow).toISOString();
}

function eligibleSettingsDto() {
  return {
    success: true,
    client: 'sunset',
    read_only: true,
    actions: { prepare: false, connect: false, disconnect: false, reauthorize: true },
    locations: [{ location_id: LOCATION, display_name: 'Somo', active: true }],
    endpoints: [{
      endpoint_id: ENDPOINT_ID,
      location_id: LOCATION,
      provider: 'microsoft_graph',
      public_address: MAILBOX,
      connection_state: 'connected_health',
      grant_status: 'active',
      reconcile_state: 'clean',
      endpoint_active: false,
      inbound_enabled: false,
      outbound_enabled: false,
      automation_enabled: false,
      start_eligible: false,
      reauthorize_eligible: true,
    }],
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (_) {
    try {
      return require('/opt/data/workspaces/wolfhouse-grok/node_modules/playwright');
    } catch (e) {
      console.error('Playwright package required. npm install playwright');
      throw e;
    }
  }
}

async function openAdminEmail(page) {
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.locator('#admin-tab-email').click();
  await page.locator('[data-email-reauthorize]').waitFor({ state: 'visible', timeout: 15000 });
}

async function ensureAdminEmail(page) {
  const emailSelected = await page.locator('#admin-tab-email').getAttribute('aria-selected');
  if (emailSelected !== 'true') {
    await openAdminEmail(page);
  } else {
    const n = await page.locator('[data-email-reauthorize]').count();
    if (n < 1) {
      await page.locator('#admin-tab-email').click();
      await page.locator('[data-email-reauthorize]').waitFor({ state: 'visible', timeout: 15000 });
    }
  }
}

/**
 * Production client switch via real Playwright selectOption on generated #c-client.
 * Proves the production change listener (cancelAdminEmailReauthorization) runs.
 * Never assigns via page.evaluate or synthetic-only dispatch.
 * force:true is required because the generated select is CSS-hidden on some layouts
 * (same pattern as finance Playwright); selectOption still fires the real change event.
 */
async function selectClientViaProductionControl(page, value) {
  const sel = page.locator('#c-client');
  await sel.waitFor({ state: 'attached', timeout: 10000 });
  await sel.selectOption(value, { force: true });
  const now = await sel.inputValue();
  assert.strictEqual(now, value, `production #c-client selectOption → ${value}`);
  return now;
}

async function firstNonSunsetClientOption(page) {
  return page.locator('#c-client').evaluate((el) => {
    const hit = Array.from(el.options || []).find((o) => o.value && o.value !== 'sunset');
    return hit ? hit.value : null;
  });
}

(async () => {
  // Clear require cache so staff-query-api sees SUNSET_EMAIL_SETTINGS_UI_ENABLED=true.
  const apiPath = require.resolve('./staff-query-api');
  delete require.cache[apiPath];
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const pw = loadPlaywright();
  let browser;
  try {
    browser = await pw.chromium.launch({ headless: true });
  } catch (e) {
    console.error(
      'Chromium browser binary missing. Install local (ignored) browser:\n'
      + '  PLAYWRIGHT_BROWSERS_PATH=/opt/data/playwright-browsers npx playwright install chromium\n'
      + 'then re-run with the same PLAYWRIGHT_BROWSERS_PATH.',
    );
    await new Promise((r) => server.close(r));
    throw e;
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const reauthPosts = [];
  // Same-tab top-level Microsoft navigation captures only (isNavigationRequest + mainFrame).
  const msMainFrameNavs = [];
  const popups = [];
  const pageErrors = [];
  const consoleErrors = [];
  let holdSuccess = null; // { release, reject } when holding a delayed reauth success
  let reauthResponseMode = 'success';
  let reauthResponseMut = null; // optional mutator for success body/url

  // Collectors BEFORE any interaction (goto/clicks). Fail on unexpected page/console errors.
  page.on('pageerror', (err) => {
    pageErrors.push(String(err && err.message ? err.message : err));
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  context.on('page', (p) => { popups.push(p); });

  function assertCleanBrowserErrors(label) {
    assert.strictEqual(
      pageErrors.length,
      0,
      `${label}: unexpected pageerror: ${pageErrors.join(' | ')}`,
    );
    const unexpected = consoleErrors.filter((t) => !CONSOLE_ERROR_ALLOWLIST.includes(t));
    assert.strictEqual(
      unexpected.length,
      0,
      `${label}: unexpected console.error: ${unexpected.join(' | ')}`,
    );
  }

  function assertNoMsNavigation(label) {
    assert.strictEqual(msMainFrameNavs.length, 0, `${label}: zero same-tab MS main-frame navigations`);
  }

  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });

  // Block external Microsoft navigation. Capture ONLY top-level main-frame navigation requests.
  await page.route('https://login.microsoftonline.com/**', async (route) => {
    const req = route.request();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      msMainFrameNavs.push(req.url());
    }
    // Controlled fulfillment keeps page.url() at the Microsoft request URL (origin+path evidence).
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>intercepted-ms-oauth</body></html>',
    });
  });

  await page.route('**/staff/admin/email-settings?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(eligibleSettingsDto()),
    });
  });

  await page.route('**/staff/admin/email-settings/oauth/microsoft/reauthorize', async (route) => {
    const req = route.request();
    assert.strictEqual(req.method(), 'POST');
    let body = null;
    try { body = JSON.parse(req.postData() || 'null'); } catch (_) { body = req.postData(); }
    reauthPosts.push({ body, headers: req.headers() });

    if (reauthResponseMode === 'hold') {
      await new Promise((resolve, reject) => {
        holdSuccess = {
          release: async (override) => {
            const mode = override && override.mode ? override.mode : 'success';
            if (mode === 'success') {
              const url = buildValidReauthUrl(override && override.mut);
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                  authorization_url: url,
                  expires_at: futureExpires(600000),
                }),
              });
            } else if (mode === 'malformed') {
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: 'not-json{',
              });
            } else {
              await route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, error: 'oauth_reauthorization_unavailable' }),
              });
            }
            resolve();
          },
          reject,
        };
      });
      return;
    }

    if (reauthResponseMode === 'non2xx') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'oauth_reauthorization_unavailable', token: 'leak' }),
      });
      return;
    }
    if (reauthResponseMode === 'malformed') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: 'not-json{',
      });
      return;
    }
    if (reauthResponseMode === 'timeout') {
      // Never fulfill — client abort/cancel must not navigate.
      await new Promise((resolve, reject) => {
        holdSuccess = {
          release: async () => {
            try { await route.abort('timedout'); } catch (_) { /* */ }
            resolve();
          },
          reject,
        };
      });
      return;
    }

    // Build success body from mode table.
    let status = 200;
    let payload = null;
    let rawBody = null;

    function okBody(url, exp) {
      return { authorization_url: url, expires_at: exp };
    }

    switch (reauthResponseMode) {
      case 'extra_keys':
        payload = {
          authorization_url: buildValidReauthUrl(),
          expires_at: futureExpires(600000),
          authorization_intent: 'phase_b_reauthorization',
        };
        break;
      case 'missing_keys':
        payload = { authorization_url: buildValidReauthUrl() };
        break;
      case 'bad_authority':
        payload = okBody('https://evil.example/oauth', futureExpires(600000));
        break;
      case 'bad_path':
        payload = okBody(
          buildValidReauthUrl((u) => { u.pathname = '/common/oauth2/v2.0/authorize'; }),
          futureExpires(600000),
        );
        break;
      case 'credentials':
        payload = okBody(
          buildValidReauthUrl((u) => { u.username = 'user'; u.password = 'pass'; }),
          futureExpires(600000),
        );
        break;
      case 'fragment':
        payload = okBody(
          buildValidReauthUrl((u) => { u.hash = '#frag'; }),
          futureExpires(600000),
        );
        break;
      case 'bad_redirect':
        payload = okBody(
          buildValidReauthUrl((u) => {
            u.searchParams.set('redirect_uri', 'https://evil.example/callback');
          }),
          futureExpires(600000),
        );
        break;
      case 'bad_response_type':
        payload = okBody(
          buildValidReauthUrl((u) => { u.searchParams.set('response_type', 'token'); }),
          futureExpires(600000),
        );
        break;
      case 'bad_response_mode':
        payload = okBody(
          buildValidReauthUrl((u) => { u.searchParams.set('response_mode', 'fragment'); }),
          futureExpires(600000),
        );
        break;
      case 'bad_state':
        payload = okBody(
          buildValidReauthUrl((u) => { u.searchParams.set('state', 'short'); }),
          futureExpires(600000),
        );
        break;
      case 'bad_challenge':
        payload = okBody(
          buildValidReauthUrl((u) => { u.searchParams.set('code_challenge', '!!!'); }),
          futureExpires(600000),
        );
        break;
      case 'narrow_scopes':
        payload = okBody(
          buildValidReauthUrl((u) => { u.searchParams.set('scope', 'openid'); }),
          futureExpires(600000),
        );
        break;
      case 'broad_scopes':
        payload = okBody(
          buildValidReauthUrl((u) => {
            u.searchParams.set('scope', CANON_SCOPES + ' Directory.Read.All');
          }),
          futureExpires(600000),
        );
        break;
      case 'mixed_scopes':
        payload = okBody(
          buildValidReauthUrl((u) => {
            u.searchParams.set('scope', 'openid Mail.Send User.ReadWrite.All');
          }),
          futureExpires(600000),
        );
        break;
      case 'unknown_scope':
        payload = okBody(
          buildValidReauthUrl((u) => {
            u.searchParams.set('scope', 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send Files.Read');
          }),
          futureExpires(600000),
        );
        break;
      case 'duplicate_scope_key':
        // Build URL with duplicated scope query key via string surgery.
        {
          const baseUrl = buildValidReauthUrl();
          payload = okBody(baseUrl + '&scope=openid', futureExpires(600000));
        }
        break;
      case 'expired':
        payload = okBody(buildValidReauthUrl(), new Date(Date.now() - 1000).toISOString());
        break;
      case 'far_expiry':
        payload = okBody(
          buildValidReauthUrl(),
          new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1h > 15m max
        );
        break;
      case 'malformed_expiry':
        payload = okBody(buildValidReauthUrl(), 'not-a-date');
        break;
      case 'success':
      default:
        payload = okBody(
          buildValidReauthUrl(typeof reauthResponseMut === 'function' ? reauthResponseMut : undefined),
          futureExpires(600000),
        );
        break;
    }

    if (rawBody != null) {
      await route.fulfill({ status, contentType: 'application/json', body: rawBody });
    } else {
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    }
  });

  try {
    // ── Generated production UI ──
    await page.goto(base + '/staff/ui', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const sel = document.querySelector('#c-client');
      return sel && sel.value === 'sunset';
    }, null, { timeout: 20000 });

    // Confirm production sources mounted: cancel is window-exposed; email tab IDs unique.
    const mounts = await page.evaluate(() => ({
      hasCancel: typeof window.cancelAdminEmailReauthorization === 'function',
      emailTabIds: document.querySelectorAll('#admin-tab-email').length,
      emailBodyIds: document.querySelectorAll('#admin-email-settings-body').length,
      srcHasLoad: document.documentElement.innerHTML.indexOf('function loadAdminEmailSettings') >= 0,
      srcHasWire: document.documentElement.innerHTML.indexOf('wireReauthorizeHandlers') >= 0,
      srcHasValidate: document.documentElement.innerHTML.indexOf('validatePhaseBReauthorizeSuccessDto') >= 0,
      langEs: document.querySelectorAll('.staff-lang-btn[data-lang="es"]').length,
      langIt: document.querySelectorAll('.staff-lang-btn[data-lang="it"]').length,
    }));
    assert.strictEqual(mounts.emailTabIds, 1, 'exactly one admin-tab-email id');
    assert.strictEqual(mounts.emailBodyIds, 1, 'exactly one admin-email-settings-body id');
    assert.strictEqual(mounts.hasCancel, true, 'production cancelAdminEmailReauthorization mounted on window');
    assert.strictEqual(mounts.srcHasLoad, true, 'loadAdminEmailSettings present in generated UI');
    assert.strictEqual(mounts.srcHasWire, true, 'wireReauthorizeHandlers present in generated UI');
    assert.strictEqual(mounts.srcHasValidate, true, 'validatePhaseBReauthorizeSuccessDto present in generated UI');
    assert.ok(mounts.langEs >= 1, 'ES language control present');
    assert.ok(mounts.langIt >= 1, 'IT language control present');

    await openAdminEmail(page);

    // No POST on load
    assert.strictEqual(reauthPosts.length, 0, 'no reauthorize POST on Email panel load');

    // EN safety copy from actual DOM
    const enSafety = (await page.locator('[data-email-reauth-safety]').innerText()).trim();
    assert.strictEqual(enSafety, EN_SAFETY, 'exact EN safety copy');
    const enBtn = (await page.locator('[data-email-reauthorize]').innerText()).trim();
    assert.ok(/reauthorize microsoft/i.test(enBtn), 'EN button label');

    // ── Layout/clipping: desktop ──
    async function assertTouchAndNoClip(label) {
      const box = await page.locator('[data-email-reauthorize]').boundingBox();
      assert.ok(box, `${label}: button bounding box`);
      assert.ok(box.height >= 44, `${label}: height >=44, got ${box.height}`);
      assert.ok(box.width >= 44, `${label}: width >=44, got ${box.width}`);
      const layout = await page.locator('[data-email-reauthorize]').evaluate((el) => {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible = style.visibility !== 'hidden'
          && style.display !== 'none'
          && Number(style.opacity) !== 0
          && r.width >= 1 && r.height >= 1
          && r.bottom > 0 && r.top < window.innerHeight
          && r.right > 0 && r.left < window.innerWidth;
        let clipped = false;
        let node = el.parentElement;
        while (node && node !== document.documentElement) {
          const cs = window.getComputedStyle(node);
          const nr = node.getBoundingClientRect();
          const ox = cs.overflowX;
          const oy = cs.overflowY;
          if (ox === 'hidden' || ox === 'auto' || ox === 'scroll') {
            if (r.left < nr.left - 0.5 || r.right > nr.right + 0.5) clipped = true;
          }
          if (oy === 'hidden' || oy === 'auto' || oy === 'scroll') {
            if (r.top < nr.top - 0.5 || r.bottom > nr.bottom + 0.5) clipped = true;
          }
          node = node.parentElement;
        }
        const docOverflowX = document.documentElement.scrollWidth
          > document.documentElement.clientWidth + 1;
        const panel = document.getElementById('admin-panel-email')
          || document.getElementById('admin-email-settings-body');
        let panelOverflowX = false;
        if (panel) {
          panelOverflowX = panel.scrollWidth > panel.clientWidth + 1;
        }
        // Attribute horizontal overflow to control only if button exceeds viewport/panel.
        const controlCausesOverflow = (docOverflowX || panelOverflowX)
          && (r.right > window.innerWidth + 1 || (panel && r.right > panel.getBoundingClientRect().right + 1));
        return { visible, clipped, controlCausesOverflow, docOverflowX, panelOverflowX };
      });
      assert.strictEqual(layout.visible, true, `${label}: button visible`);
      assert.strictEqual(layout.clipped, false, `${label}: ancestors do not clip button rect`);
      assert.strictEqual(layout.controlCausesOverflow, false, `${label}: no horizontal overflow from control`);
    }
    await assertTouchAndNoClip('desktop');

    // ── Layout/clipping: narrow viewport ──
    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForTimeout(150);
    await ensureAdminEmail(page);
    await assertTouchAndNoClip('narrow');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(100);
    await ensureAdminEmail(page);

    // ── Same-tab success: top-level mainFrame nav only; exact URL; page.url origin/path ──
    reauthResponseMode = 'success';
    reauthResponseMut = null;
    msMainFrameNavs.length = 0;
    reauthPosts.length = 0;
    popups.length = 0;
    const pagesBefore = context.pages().length;
    const expectedAuthUrl = buildValidReauthUrl();
    await page.locator('[data-email-reauthorize]').click();
    await page.waitForURL(
      (url) => url.origin === MS_ORIGIN && url.pathname === MS_PATH,
      { timeout: 10000 },
    );
    assert.strictEqual(reauthPosts.length, 1, 'one reauth POST on click');
    assert.deepStrictEqual(Object.keys(reauthPosts[0].body).sort(), ['endpoint_id', 'location_id']);
    assert.strictEqual(reauthPosts[0].body.location_id, LOCATION);
    assert.strictEqual(reauthPosts[0].body.endpoint_id, ENDPOINT_ID);
    assert.ok(!Object.prototype.hasOwnProperty.call(reauthPosts[0].body, 'client_id'));
    assert.ok(!Object.prototype.hasOwnProperty.call(reauthPosts[0].body, 'scope'));
    // Capture only main-frame navigation requests; exact request URL.
    assert.strictEqual(msMainFrameNavs.length, 1, 'exactly one same-tab main-frame MS navigation');
    assert.strictEqual(msMainFrameNavs[0], expectedAuthUrl, 'exact Microsoft authorize request URL');
    // After controlled fulfill, originating page.url has exact Microsoft origin/path.
    const landed = new URL(page.url());
    assert.strictEqual(landed.origin, MS_ORIGIN, 'page.url Microsoft origin');
    assert.strictEqual(landed.pathname, MS_PATH, 'page.url Microsoft authorize path');
    assert.strictEqual(page.url(), expectedAuthUrl, 'page.url exact validated authorize URL');
    assert.strictEqual(popups.length, 0, 'zero new pages/popups');
    assert.strictEqual(context.pages().length, 1, 'context page count remains 1');
    assert.strictEqual(context.pages().length, pagesBefore, 'no extra pages in browserContext');
    // Opener must remain null on originating page (no window.open path).
    const openerNull = await page.evaluate(() => window.opener === null || window.opener === undefined);
    assert.strictEqual(openerNull, true, 'originating page has no opener');
    assertCleanBrowserErrors('after same-tab MS success');

    // Re-open Email after navigation intercept left page — reload UI
    await page.goto(base + '/staff/ui', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset', null, { timeout: 20000 });
    await openAdminEmail(page);

    // Double-click: one POST; button disabled pending
    reauthResponseMode = 'hold';
    reauthPosts.length = 0;
    msMainFrameNavs.length = 0;
    holdSuccess = null;
    const clickPromise = page.locator('[data-email-reauthorize]').click();
    await page.waitForTimeout(100);
    await clickPromise;
    for (let i = 0; i < 50 && !holdSuccess; i += 1) await page.waitForTimeout(20);
    assert.ok(holdSuccess, 'reauth POST held');
    assert.strictEqual(reauthPosts.length, 1);
    const disabledPending = await page.locator('[data-email-reauthorize]').isDisabled();
    assert.strictEqual(disabledPending, true, 'button disabled while pending');
    let forcedDoubleClickOutcome = 'completed';
    try {
      await page.locator('[data-email-reauthorize]').click({ force: true });
    } catch (error) {
      forcedDoubleClickOutcome = 'rejected';
      assert.ok(error instanceof Error, 'forced disabled double-click rejects with Error');
    }
    assert.ok(
      forcedDoubleClickOutcome === 'completed' || forcedDoubleClickOutcome === 'rejected',
      'forced double-click has an observed outcome',
    );
    await page.waitForTimeout(100);
    assert.strictEqual(reauthPosts.length, 1, 'double-click does not re-POST');

    // Leave Email tab (Finance) while held → release → zero navigation; quiet (no error on new surface)
    await page.locator('#admin-tab-finance').click();
    await page.waitForTimeout(100);
    msMainFrameNavs.length = 0;
    await holdSuccess.release();
    await page.waitForTimeout(300);
    assertNoMsNavigation('after leaving Email tab');
    // Quiet abort: new surface must not paint reauth error copy/state.
    const financeLocator = page.locator('#admin-panel-finance:not([hidden]), #admin-finance-body:visible').first();
    await financeLocator.waitFor({ state: 'visible', timeout: 5000 });
    assert.strictEqual(await financeLocator.count(), 1, 'Finance surface exists after leaving Email');
    const financeSurface = await financeLocator.innerText();
    assert.ok(!financeSurface.includes(EN_ERROR), 'leave Email: no reauth error copy on Finance surface');
    const emailBodyAfterLeave = await page.locator('#admin-email-settings-body').innerHTML();
    assert.ok(
      !emailBodyAfterLeave.includes('data-email-state="error"'),
      'leave Email quiet abort: email body not forced to error',
    );

    // Re-enter Email, hold again, leave Admin top-level, release → zero nav + quiet
    await page.locator('#admin-tab-email').click();
    await page.locator('[data-email-reauthorize]').waitFor({ state: 'visible', timeout: 15000 });
    reauthResponseMode = 'hold';
    holdSuccess = null;
    reauthPosts.length = 0;
    await page.locator('[data-email-reauthorize]').click();
    for (let i = 0; i < 50 && !holdSuccess; i += 1) await page.waitForTimeout(20);
    assert.ok(holdSuccess, 'second hold registered');
    await page.locator('button.tab-btn[data-tab="conversations"]').click().catch(async () => {
      await page.locator('button.tab-btn[data-tab="bed-calendar"]').click();
    });
    await page.waitForTimeout(100);
    msMainFrameNavs.length = 0;
    await holdSuccess.release();
    await page.waitForTimeout(300);
    assertNoMsNavigation('after leaving Admin');
    const activeSurface = page.locator('.tab-panel.active');
    await activeSurface.waitFor({ state: 'visible', timeout: 5000 });
    assert.strictEqual(await activeSurface.count(), 1, 'one active non-Admin surface exists');
    const nonAdminSurface = await activeSurface.innerText();
    assert.ok(!nonAdminSurface.includes(EN_ERROR), 'leave Admin: no reauth error copy on new surface');

    // ── Client change: real Playwright selectOption on generated #c-client (never evaluate) ──
    await page.locator('button.tab-btn[data-tab="admin"]').click();
    await page.locator('#admin-tab-email').click();
    await page.locator('[data-email-reauthorize]').waitFor({ state: 'visible', timeout: 15000 });
    reauthResponseMode = 'hold';
    holdSuccess = null;
    reauthPosts.length = 0;
    msMainFrameNavs.length = 0;
    await page.locator('[data-email-reauthorize]').click();
    for (let i = 0; i < 50 && !holdSuccess; i += 1) await page.waitForTimeout(20);
    assert.ok(holdSuccess, 'client-change hold registered');
    const switched = await firstNonSunsetClientOption(page);
    assert.ok(switched, 'another client option exists for production selector');
    // Real selectOption exercises production change listener → cancelAdminEmailReauthorization.
    await selectClientViaProductionControl(page, switched);
    await page.waitForTimeout(150);
    msMainFrameNavs.length = 0;
    popups.length = 0;
    await holdSuccess.release();
    await page.waitForTimeout(300);
    assertNoMsNavigation('client change release');
    assert.strictEqual(popups.length, 0, 'client change: zero popups');
    assert.strictEqual(await page.locator('#c-client').inputValue(), switched, 'client-change surface owns selected client');
    const clientActiveSurface = page.locator('.tab-panel.active:visible');
    await clientActiveSurface.waitFor({ state: 'visible', timeout: 5000 });
    assert.strictEqual(await clientActiveSurface.count(), 1, 'client change leaves one concrete visible surface');
    const clientSurface = await clientActiveSurface.innerText();
    assert.ok(!clientSurface.includes(EN_ERROR), 'client change quiet abort: no reauth error copy on new surface');
    // Restore sunset via real Playwright selectOption again
    await selectClientViaProductionControl(page, 'sunset');
    await page.waitForTimeout(200);
    await page.locator('button.tab-btn[data-tab="admin"]').click();
    await page.locator('#admin-tab-email').click();
    await page.locator('[data-email-reauthorize]').waitFor({ state: 'visible', timeout: 15000 });

    // ── Rerender: stay on Admin Email; production reload path ──
    reauthResponseMode = 'hold';
    holdSuccess = null;
    reauthPosts.length = 0;
    msMainFrameNavs.length = 0;
    await page.locator('[data-email-reauthorize]').click();
    for (let i = 0; i < 50 && !holdSuccess; i += 1) await page.waitForTimeout(20);
    assert.ok(holdSuccess, 'rerender hold registered');
    // Production path: re-activate Email sub-tab while already selected → loadAdminEmailSettings.
    // Do NOT leave Email first.
    const stillEmail = await page.locator('#admin-tab-email').getAttribute('aria-selected');
    assert.strictEqual(stillEmail, 'true', 'still on Email before rerender');
    await page.locator('#admin-tab-email').click();
    await page.waitForTimeout(250);
    const stillEmailAfter = await page.locator('#admin-tab-email').getAttribute('aria-selected');
    assert.strictEqual(stillEmailAfter, 'true', 'still on Email after production reload click');
    msMainFrameNavs.length = 0;
    await holdSuccess.release();
    await page.waitForTimeout(300);
    assert.strictEqual(msMainFrameNavs.length, 0, 'rerender/reload cancels pending; zero navigation');
    const rerenderBody = page.locator('#admin-email-settings-body:visible');
    await rerenderBody.waitFor({ state: 'visible', timeout: 5000 });
    assert.strictEqual(await rerenderBody.count(), 1, 'rerender leaves concrete Email surface visible');
    assert.ok(!(await rerenderBody.innerHTML()).includes('data-email-state="error"'), 'rerender quiet abort does not paint error state');

    // ── Table-driven invalid response modes (real click, exact bounded error, zero nav) ──
    async function assertInvalidMode(mode, label) {
      reauthResponseMode = mode;
      reauthResponseMut = null;
      msMainFrameNavs.length = 0;
      reauthPosts.length = 0;
      popups.length = 0;
      await ensureAdminEmail(page);
      // Recover from prior error state via production Email re-entry (reloads eligible DTO).
      const count = await page.locator('[data-email-reauthorize]').count();
      if (count < 1) {
        await page.locator('#admin-tab-finance').click();
        await page.locator('#admin-tab-email').click();
        await page.locator('[data-email-reauthorize]').waitFor({ state: 'visible', timeout: 10000 });
      }
      const btnBefore = page.locator('[data-email-reauthorize]');
      assert.strictEqual(await btnBefore.isDisabled(), false, `${label}: button enabled before click`);
      await btnBefore.click();
      await page.waitForTimeout(450);
      assertNoMsNavigation(label);
      assert.strictEqual(reauthPosts.length, 1, `${label}: one POST`);
      assert.strictEqual(popups.length, 0, `${label}: zero popups`);
      assert.strictEqual(context.pages().length, 1, `${label}: context page count remains 1`);
      // Exact fixed bounded error state + EN copy in live DOM — no permissive alternatives.
      const body = page.locator('#admin-email-settings-body');
      const bodyHtml = await body.innerHTML();
      assert.ok(!bodyHtml.includes('leak'), `${label}: no token leak`);
      const errorSection = body.locator('[data-email-state="error"]');
      assert.strictEqual(await errorSection.count(), 1, `${label}: exactly one error surface`);
      const status = errorSection.locator('p[role="status"]');
      assert.strictEqual(await status.count(), 1, `${label}: exactly one fixed status owner`);
      assert.strictEqual((await status.innerText()).trim(), EN_ERROR, `${label}: exact fixed error copy`);
      // Error rendering removes the consent action entirely; no stale or disabled control survives.
      assert.strictEqual(
        await page.locator('[data-email-reauthorize]').count(),
        0,
        `${label}: reauthorize control absent on fixed error surface`,
      );
    }

    const invalidCases = [
      ['malformed', 'malformed JSON'],
      ['non2xx', 'non-2xx'],
      ['extra_keys', 'extra keys'],
      ['missing_keys', 'missing keys'],
      ['bad_authority', 'invalid authority'],
      ['bad_path', 'invalid path'],
      ['credentials', 'credentials in URL'],
      ['fragment', 'fragment'],
      ['bad_redirect', 'invalid redirect'],
      ['bad_response_type', 'invalid response_type'],
      ['bad_response_mode', 'invalid response_mode'],
      ['bad_state', 'invalid state'],
      ['bad_challenge', 'invalid challenge'],
      ['narrow_scopes', 'narrow/missing scopes'],
      ['broad_scopes', 'broad scopes'],
      ['mixed_scopes', 'mixed scopes'],
      ['unknown_scope', 'unknown scope'],
      ['duplicate_scope_key', 'duplicate scope key'],
      ['expired', 'expiry past'],
      ['far_expiry', 'expiry far'],
      ['malformed_expiry', 'expiry malformed'],
    ];
    for (const [mode, label] of invalidCases) {
      await assertInvalidMode(mode, label);
    }

    // Timeout/abort: hold never fulfills; production client change aborts; zero nav; quiet new surface.
    reauthResponseMode = 'timeout';
    holdSuccess = null;
    msMainFrameNavs.length = 0;
    reauthPosts.length = 0;
    await ensureAdminEmail(page);
    // Leave prior error via production re-entry if needed.
    if ((await page.locator('[data-email-reauthorize]').count()) < 1) {
      await page.locator('#admin-tab-finance').click();
      await page.locator('#admin-tab-email').click();
      await page.locator('[data-email-reauthorize]').waitFor({ state: 'visible', timeout: 10000 });
    }
    await page.locator('[data-email-reauthorize]').click();
    for (let i = 0; i < 50 && !holdSuccess; i += 1) await page.waitForTimeout(20);
    assert.ok(holdSuccess, 'timeout hold registered');
    const switchAway = await firstNonSunsetClientOption(page);
    assert.ok(switchAway, 'timeout/abort: non-Sunset client available');
    await selectClientViaProductionControl(page, switchAway);
    await page.waitForTimeout(100);
    msMainFrameNavs.length = 0;
    // Abort the held route after leave — quiet; no error on the new client surface.
    await holdSuccess.release();
    await page.waitForTimeout(200);
    assertNoMsNavigation('timeout/abort');
    assert.strictEqual(await page.locator('#c-client').inputValue(), switchAway, 'timeout surface owns selected client');
    const timeoutSurface = page.locator('.tab-panel.active:visible');
    await timeoutSurface.waitFor({ state: 'visible', timeout: 5000 });
    assert.strictEqual(await timeoutSurface.count(), 1, 'timeout/abort leaves one concrete visible surface');
    const bodyAfterTimeout = await timeoutSurface.innerText();
    assert.ok(
      !bodyAfterTimeout.includes(EN_ERROR),
      'timeout/abort due leaving surface: quiet — no reauth error copy on new surface',
    );
    // Restore sunset via real selectOption
    await selectClientViaProductionControl(page, 'sunset');
    await page.waitForTimeout(200);
    await page.locator('button.tab-btn[data-tab="admin"]').click();
    await page.locator('#admin-tab-email').click();
    await page.locator('[data-email-reauthorize]').waitFor({ state: 'visible', timeout: 15000 });

    // ── ES and IT localization via actual generated language controls ──
    async function switchLangAndReloadEmail(lang) {
      const btn = page.locator(`.staff-lang-btn[data-lang="${lang}"]`).first();
      await btn.click();
      await page.waitForTimeout(150);
      // Production language switch does not always remount Email panel; re-enter
      // Email via production sub-tab path so portalT re-renders reauth copy.
      await page.locator('#admin-tab-finance').click();
      await page.locator('#admin-tab-email').click();
      await page.locator('[data-email-reauthorize]').waitFor({ state: 'visible', timeout: 15000 });
      await page.waitForTimeout(200);
    }

    await switchLangAndReloadEmail('es');
    const esSafety = (await page.locator('[data-email-reauth-safety]').innerText()).trim();
    const esBtn = (await page.locator('[data-email-reauthorize]').innerText()).trim();
    assert.strictEqual(esSafety, ES_SAFETY, 'exact Spanish reauthorization safety copy');
    assert.strictEqual(esBtn, ES_BUTTON, 'exact Spanish reauthorize button');
    assert.notStrictEqual(esSafety, EN_SAFETY, 'ES must not fall back to English safety');
    assert.ok(!/Microsoft permissions are being upgraded/i.test(esSafety), 'no EN fallback in ES DOM');

    await switchLangAndReloadEmail('it');
    const itSafety = (await page.locator('[data-email-reauth-safety]').innerText()).trim();
    const itBtn = (await page.locator('[data-email-reauthorize]').innerText()).trim();
    assert.strictEqual(itSafety, IT_SAFETY, 'exact Italian reauthorization safety copy');
    assert.strictEqual(itBtn, IT_BUTTON, 'exact Italian reauthorize button');
    assert.notStrictEqual(itSafety, EN_SAFETY, 'IT must not fall back to English safety');
    assert.ok(!/Microsoft permissions are being upgraded/i.test(itSafety), 'no EN fallback in IT DOM');

    // Restore EN
    await switchLangAndReloadEmail('en');

    // Flag-off / non-Sunset production HTML concealment (exact builder seam).
    process.env.SUNSET_EMAIL_SETTINGS_UI_ENABLED = 'false';
    delete require.cache[require.resolve('./staff-query-api')];
    delete require.cache[require.resolve('./lib/sunset-admin-verify-ui-html')];
    const { buildVerifyStaffUiHtml } = require('./lib/sunset-admin-verify-ui-html');
    const htmlOff = buildVerifyStaffUiHtml();
    assert.ok(!htmlOff.includes('id="admin-tab-email"'), 'flag off: no Email tab in production HTML');
    assert.ok(!htmlOff.includes('id="admin-panel-email"'), 'flag off: no Email panel in production HTML');
    process.env.SUNSET_EMAIL_SETTINGS_UI_ENABLED = 'true';
    process.env.DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
    delete require.cache[require.resolve('./staff-query-api')];
    delete require.cache[require.resolve('./lib/sunset-admin-verify-ui-html')];
    const { buildVerifyStaffUiHtml: build2 } = require('./lib/sunset-admin-verify-ui-html');
    const htmlNonSunset = build2();
    assert.ok(!htmlNonSunset.includes('id="admin-tab-email"'), 'non-Sunset default: no Email tab');
    assert.ok(!htmlNonSunset.includes('id="admin-panel-email"'), 'non-Sunset default: no Email panel');
    process.env.DEFAULT_CLIENT_SLUG = 'sunset';

    // No duplicate IDs for email controls in production HTML
    const idDupes = await page.evaluate(() => {
      const ids = ['admin-tab-email', 'admin-panel-email', 'admin-email-settings-body'];
      return ids.map((id) => ({ id, n: document.querySelectorAll('#' + id).length }));
    });
    for (const row of idDupes) {
      assert.ok(row.n <= 1, `no duplicate #${row.id}`);
    }

    assertCleanBrowserErrors('final Chromium acceptance');
    assert.strictEqual(context.pages().length, 1, 'final: context page count remains 1');
    assert.strictEqual(popups.length, 0, 'final: zero popups across suite');

    console.log('PASS verify-sunset-email-phase-b-reauthorize-ui-playwright: Chromium acceptance');
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
