'use strict';

/**
 * verify:portal-tenant-isolation
 *
 * Live staging gate: Wolfhouse and Sunset staff portals must not bleed tenant
 * nav, client dropdown, or demo content across staging hosts.
 *
 * Targets (staging only — no production):
 *   Wolfhouse: https://staff-staging.lunafrontdesk.com
 *   Sunset:    https://sunset-staging.lunafrontdesk.com
 *
 * Required env:
 *   WOLFHOUSE_STAGING_PORTAL_PASSWORD
 *   SUNSET_STAGING_PORTAL_PASSWORD
 *
 * Optional env:
 *   WOLFHOUSE_STAGING_PORTAL_EMAIL  (default: tywoods@gmail.com)
 *   SUNSET_STAGING_PORTAL_EMAIL     (default: tywoods@gmail.com)
 *   PORTAL_TENANT_ISOLATION_ARTIFACTS (default: tmp/verify-portal-tenant-isolation)
 *
 * NOT wired into verify:luna-all or verify:sunset-all — those suites are offline
 * and must not require staging credentials or network access. Run this gate
 * manually before portal merges, or in CI when staging secrets are available.
 *
 * Run:
 *   npm run verify:portal-tenant-isolation
 */

const fs = require('fs');
const path = require('path');

const WOLFHOUSE_BASE = 'https://staff-staging.lunafrontdesk.com';
const SUNSET_BASE = 'https://sunset-staging.lunafrontdesk.com';

const ALLOWED_HOSTS = new Set([
  'staff-staging.lunafrontdesk.com',
  'sunset-staging.lunafrontdesk.com',
]);

const ARTIFACT_DIR = process.env.PORTAL_TENANT_ISOLATION_ARTIFACTS
  || path.join(process.cwd(), 'tmp', 'verify-portal-tenant-isolation');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return true;
  }
  const msg = detail ? `${label} — ${detail}` : label;
  console.error(`  FAIL  ${msg}`);
  fail += 1;
  return false;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    console.error(`\nverify:portal-tenant-isolation — missing required env: ${name}`);
    console.error('Set staging portal passwords before running this gate.');
    console.error('  WOLFHOUSE_STAGING_PORTAL_PASSWORD');
    console.error('  SUNSET_STAGING_PORTAL_PASSWORD');
    process.exit(2);
  }
  return String(value).trim();
}

function guardStagingUrl(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch (err) {
    throw new Error(`Invalid portal URL: ${url}`);
  }
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(`Refusing non-staging portal host: ${host}`);
  }
  if (/prod/i.test(host) || host.includes('production')) {
    throw new Error(`Refusing production-looking portal host: ${host}`);
  }
}

async function loadPlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    console.error('verify:portal-tenant-isolation — Playwright is required.');
    console.error('Install with: npm install --save-dev playwright && npx playwright install chromium');
    process.exit(2);
  }
}

async function captureFailureScreenshot(page, suite, slug) {
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(ARTIFACT_DIR, `${suite}-${slug}-${stamp}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.error(`  screenshot: ${file}`);
    return file;
  } catch (err) {
    console.error(`  screenshot capture failed: ${err.message}`);
    return null;
  }
}

async function fetchSession(context, baseUrl) {
  const resp = await context.request.get(`${baseUrl}/staff/auth/session`);
  if (!resp.ok()) {
    throw new Error(`Session probe failed (${resp.status()})`);
  }
  const data = await resp.json();
  if (!data || data.success !== true) {
    throw new Error('Session probe returned unsuccessful payload');
  }
  return data;
}

async function loginPortal(page, context, baseUrl, { company, email, password }) {
  guardStagingUrl(baseUrl);
  await page.goto(`${baseUrl}/staff/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-form', { timeout: 20000 });
  await page.fill('#client', company);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('#btn-signin');
  await page.waitForFunction(
    () => !window.location.pathname.includes('/staff/login'),
    { timeout: 45000 },
  );
  await page.waitForSelector('#c-client option', { state: 'attached', timeout: 45000 });
  await page.waitForFunction(
    () => {
      const select = document.getElementById('c-client');
      return !!(select && select.value);
    },
    { timeout: 45000 },
  );

  const deadline = Date.now() + 45000;
  let session = null;
  while (Date.now() < deadline) {
    session = await fetchSession(context, baseUrl);
    if (Array.isArray(session.clients) && session.clients.length > 0) break;
    await page.waitForTimeout(500);
  }
  if (!session || !Array.isArray(session.clients) || !session.clients.length) {
    throw new Error('Authenticated session did not expose clients[]');
  }
  return session;
}

async function readPortalState(page, context, baseUrl) {
  const session = await fetchSession(context, baseUrl);

  await page.waitForFunction(
    () => {
      try {
        return localStorage.getItem('staff_portal_client') != null;
      } catch (_) {
        return false;
      }
    },
    { timeout: 15000 },
  ).catch(() => { /* localStorage may remain unset on some builds */ });

  const dom = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.tab-btn[data-tab]'))
      .filter((btn) => {
        const style = window.getComputedStyle(btn);
        return style.display !== 'none' && style.visibility !== 'hidden' && btn.offsetParent !== null;
      })
      .map((btn) => ({
        tab: btn.getAttribute('data-tab') || '',
        text: (btn.textContent || '').replace(/\s+/g, ' ').trim(),
      }));

    const select = document.getElementById('c-client');
    const clients = select
      ? Array.from(select.options).map((opt) => ({
        slug: opt.value,
        name: (opt.textContent || '').trim(),
      }))
      : [];

    let localClient = null;
    try {
      localClient = localStorage.getItem('staff_portal_client');
    } catch (_) { /* ignore */ }

    return {
      tabs,
      tabLabels: tabs.map((t) => t.text),
      clients,
      clientSlugs: clients.map((c) => c.slug),
      clientNames: clients.map((c) => c.name),
      localClient,
      selectedClient: select ? select.value : null,
      bodyText: (document.body && document.body.innerText) || '',
    };
  });

  const sessionClients = Array.isArray(session.clients)
    ? session.clients.map((c) => ({ slug: c.slug, name: c.name || c.slug }))
    : [];

  return {
    ...dom,
    sessionClients,
    sessionClient: dom.selectedClient,
  };
}


function hasExactTabLabel(state, label) {
  return (state.tabs || []).some((t) => t.text === label);
}

function portalHomeTabLabel(state) {
  const tab = (state.tabs || []).find((t) => t.tab === 'portal-home');
  return tab ? tab.text : null;
}

function tabLabelsInclude(state, labels) {
  const hay = state.tabLabels.join(' | ');
  return labels.every((label) => hay.includes(label));
}

function tabLabelsExclude(state, labels) {
  const hay = state.tabLabels.join(' | ');
  return labels.every((label) => !hay.includes(label));
}

async function runWolfhouseSuite(page, context, creds) {
  console.log('\n[Wolfhouse] staff-staging.lunafrontdesk.com');
  const failAtStart = fail;
  guardStagingUrl(WOLFHOUSE_BASE);

  await page.goto(`${WOLFHOUSE_BASE}/staff/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
  });

  await loginPortal(page, context, WOLFHOUSE_BASE, {
    company: 'wolfhouse-somo',
    email: creds.wolfhouseEmail,
    password: creds.wolfhousePassword,
  });

  const state = await readPortalState(page, context, WOLFHOUSE_BASE);

  assert('localStorage staff_portal_client is wolfhouse-somo', state.localClient === 'wolfhouse-somo', state.localClient);
  assert('selected client is wolfhouse-somo', state.sessionClient === 'wolfhouse-somo', state.sessionClient);
  assert(
    'client dropdown slugs are only wolfhouse-somo',
    state.clientSlugs.length === 1 && state.clientSlugs[0] === 'wolfhouse-somo',
    JSON.stringify(state.clientSlugs),
  );
  assert(
    'session clients are only wolfhouse-somo',
    state.sessionClients.length === 1 && state.sessionClients[0].slug === 'wolfhouse-somo',
    JSON.stringify(state.sessionClients),
  );

  assert('nav includes Booking Calendar', tabLabelsInclude(state, ['Booking Calendar']));
  assert('nav includes WhatsApp', tabLabelsInclude(state, ['WhatsApp']));
  assert('nav includes Luna Staff', tabLabelsInclude(state, ['Luna Staff']));
  assert('nav includes Tour Operator', tabLabelsInclude(state, ['Tour Operator']));

  assert('nav excludes Schedule tab label', !hasExactTabLabel(state, 'Schedule'));
  assert('nav excludes Today tab label', !hasExactTabLabel(state, 'Today'));
  assert('nav excludes Customers', tabLabelsExclude(state, ['Customers']));
  assert('nav excludes Day Schedule', tabLabelsExclude(state, ['Day Schedule']));

  assert('page text excludes Sunset Surf School', !state.bodyText.includes('Sunset Surf School'));
  assert('page text excludes demo-preview rows', !/demo-preview-/i.test(state.bodyText));

  const whScheduleUi = await page.evaluate(() => ({
    weekGrid: !!document.getElementById('ps-week-grid'),
    scheduleWrap: !!document.querySelector('.portal-schedule-wrap'),
  }));
  assert('Wolfhouse excludes Sunset Schedule week grid', !whScheduleUi.weekGrid);
  assert('Wolfhouse excludes portal-schedule-wrap', !whScheduleUi.scheduleWrap);

  if (fail > failAtStart) {
    await captureFailureScreenshot(page, 'wolfhouse', 'failure');
  }
}

async function runSunsetSuite(page, context, creds) {
  console.log('\n[Sunset] sunset-staging.lunafrontdesk.com');
  const failAtStart = fail;
  guardStagingUrl(SUNSET_BASE);

  await loginPortal(page, context, SUNSET_BASE, {
    company: 'sunset',
    email: creds.sunsetEmail,
    password: creds.sunsetPassword,
  });

  const state = await readPortalState(page, context, SUNSET_BASE);

  assert(
    'localStorage staff_portal_client is unset or sunset (not Wolfhouse bleed)',
    state.localClient == null || state.localClient === 'sunset',
    state.localClient || '(unset)',
  );
  assert('localStorage is not wolfhouse-somo', state.localClient !== 'wolfhouse-somo', state.localClient);
  assert('selected client is sunset', state.sessionClient === 'sunset', state.sessionClient);
  assert(
    'client dropdown slugs are only sunset',
    state.clientSlugs.length === 1 && state.clientSlugs[0] === 'sunset',
    JSON.stringify(state.clientSlugs),
  );
  assert(
    'client dropdown includes Sunset Surf School label',
    state.clientNames.some((name) => /Sunset Surf School/i.test(name)),
    JSON.stringify(state.clientNames),
  );
  assert(
    'session clients are only sunset',
    state.sessionClients.length === 1 && state.sessionClients[0].slug === 'sunset',
    JSON.stringify(state.sessionClients),
  );

  assert('nav includes Schedule tab (portal-home)', hasExactTabLabel(state, 'Schedule'), portalHomeTabLabel(state));
  assert('nav excludes Today tab label', !hasExactTabLabel(state, 'Today'));
  assert('nav includes Inbox', tabLabelsInclude(state, ['Inbox']));
  assert('nav includes Day Schedule', tabLabelsInclude(state, ['Day Schedule']));
  assert('nav includes Customers', tabLabelsInclude(state, ['Customers']));
  assert('nav includes Luna Staff', tabLabelsInclude(state, ['Luna Staff']));

  assert('nav excludes Booking Calendar', tabLabelsExclude(state, ['Booking Calendar']));
  assert('nav excludes Tour Operator', tabLabelsExclude(state, ['Tour Operator']));
  if (fail > failAtStart) {
    await captureFailureScreenshot(page, 'sunset', 'failure');
  }
}

async function main() {
  const wolfhousePassword = requireEnv('WOLFHOUSE_STAGING_PORTAL_PASSWORD');
  const sunsetPassword = requireEnv('SUNSET_STAGING_PORTAL_PASSWORD');
  const wolfhouseEmail = (process.env.WOLFHOUSE_STAGING_PORTAL_EMAIL || 'tywoods@gmail.com').trim();
  const sunsetEmail = (process.env.SUNSET_STAGING_PORTAL_EMAIL || 'tywoods@gmail.com').trim();

  guardStagingUrl(WOLFHOUSE_BASE);
  guardStagingUrl(SUNSET_BASE);

  const playwright = await loadPlaywright();
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  const page = await context.newPage();

  console.log('\nverify:portal-tenant-isolation — staging portal tenant isolation gate\n');

  try {
    await runWolfhouseSuite(page, context, {
      wolfhouseEmail,
      wolfhousePassword,
      sunsetEmail,
      sunsetPassword,
    });
    await runSunsetSuite(page, context, {
      wolfhouseEmail,
      wolfhousePassword,
      sunsetEmail,
      sunsetPassword,
    });
  } catch (err) {
    console.error(`\nverify:portal-tenant-isolation — ERROR: ${err.message}`);
    await captureFailureScreenshot(page, 'error', 'uncaught');
    fail += 1;
  } finally {
    await browser.close();
  }

  console.log(`\nverify:portal-tenant-isolation — ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('verify:portal-tenant-isolation — FAILED');
    process.exit(1);
  }
  console.log('verify:portal-tenant-isolation — ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(`verify:portal-tenant-isolation — fatal: ${err.stack || err.message}`);
  process.exit(1);
});
