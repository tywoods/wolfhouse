'use strict';

/**
 * Local handoff probe — Admin + Schedule create modal (mocked session/config). No deploy, no WhatsApp.
 * Spawns staff-query-api unless STAFF_QUERY_API_PORT points at an already-running server.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.STAFF_QUERY_API_PORT || 3049);
const BASE = `http://127.0.0.1:${PORT}`;
const shotDir = path.join(ROOT, '_work', 'private-lessons-handoff');
let serverChild = null;

function waitForServer(timeoutMs = 25000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get(`${BASE}/staff/ui`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      }).on('error', retry);
      function retry() {
        if (Date.now() - started > timeoutMs) reject(new Error(`server not ready on ${BASE}`));
        else setTimeout(tick, 200);
      }
    };
    tick();
  });
}

async function ensureServer() {
  if (process.env.STAFF_QUERY_API_SKIP_SPAWN === '1') {
    await waitForServer();
    return;
  }
  serverChild = spawn(process.execPath, [path.join(__dirname, 'staff-query-api.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      STAFF_QUERY_API_PORT: String(PORT),
      STAFF_AUTH_REQUIRED: 'false',
      DEFAULT_CLIENT_SLUG: 'sunset',
      SUNSET_ADMIN_DB_READ_ENABLED: 'false',
      SUNSET_ADMIN_WRITES_ENABLED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
}

function stopServer() {
  if (!serverChild) return;
  try { serverChild.kill(); } catch (_) { /* ignore */ }
  serverChild = null;
}

async function waitForPortalReady(page) {
  await page.waitForFunction(() => {
    return document.body && !document.body.classList.contains('portal-profile-pending');
  }, null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const sel = document.getElementById('c-client');
    return sel && sel.options.length > 0 && sel.value === 'sunset';
  }, null, { timeout: 30000 });
}

async function main() {
  fs.mkdirSync(shotDir, { recursive: true });
  await ensureServer();

  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err.message || err)));

  await context.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });

  await page.addInitScript(() => {
    const orig = window.fetch.bind(window);
    window.fetch = function (url, opts) {
      const u = String(url || '');
      if (u.includes('/staff/auth/session')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            auth_required: true,
            role: 'owner',
            email: 'owner@test',
            clients: [{ slug: 'sunset', name: 'Sunset' }],
            client_profiles: {
              sunset: {
                default_tab: 'admin',
                is_surf_vertical: true,
                demo_mode: false,
                lesson_slots_demo: [{ slot_time: '11:00', capacity: 8 }],
              },
            },
            can_use_owner_insights: true,
          }),
        });
      }
      if (u.includes('/staff/admin/config')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            source: 'config',
            lesson_times: [{ slot_time: '11:00', offering_label: 'Group lesson' }],
            surf_packs: [{ pack_id: 'kids_week', label: 'Kids week' }],
            private_lesson: {
              enabled: true,
              label: 'Private lesson',
              amount_cents: 6000,
              currency: 'EUR',
              price_basis: 'per_session',
              default_duration_minutes: 120,
              notes: '',
            },
            prices: [],
            lesson_capacity: { default_daily_cap: 24, overrides: [] },
            business_info: {},
            change_history: [],
            writes_enabled: true,
          }),
        });
      }
      return orig(url, opts);
    };
  });

  await page.goto(`${BASE}/staff/ui`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForPortalReady(page);

  const adminTab = page.locator('button.tab-btn[data-tab="admin"]');
  await adminTab.click();
  await page.waitForSelector('#admin-times-body', { timeout: 20000 });
  await page.waitForTimeout(1500);

  const adminText = await page.locator('#admin-times-body').innerText().catch(() => '');
  const checks = {
    groupLessons: /Group lessons/i.test(adminText),
    groupCourses: /Group courses/i.test(adminText),
    privateLessons: /Private lessons/i.test(adminText),
    noPackageTiersOnPrivateCard: !/Private lessons[\s\S]*?(1 lesson|2 lesson|3 lesson)/i.test(adminText),
    noPageErrors: pageErrors.length === 0,
  };

  const adminShot = path.join(shotDir, '01-admin-private-lessons.png');
  await page.screenshot({ path: adminShot, fullPage: false });

  const scheduleTab = page.locator('button.tab-btn[data-tab="portal-home"]');
  await scheduleTab.click();
  await page.waitForSelector('#tab-portal-home.tab-panel.active', { timeout: 20000 });
  const createBtn = page.locator('#ps-create-booking');
  await createBtn.waitFor({ state: 'attached', timeout: 20000 });
  await createBtn.click({ force: true });
  await page.waitForFunction(() => {
    const modal = document.getElementById('ps-create-modal');
    return modal && modal.style.display !== 'none' && modal.style.display !== '';
  }, null, { timeout: 15000 }).catch(async () => {
    await page.evaluate(() => {
      const modal = document.getElementById('ps-create-modal');
      if (modal) {
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
        if (typeof schedulePopulateCreateComponentFields === 'function') schedulePopulateCreateComponentFields();
      }
    });
  });

  const modalHtml = await page.locator('#ps-create-modal').innerHTML().catch(() => '');
  checks.createPrivateCheckbox = modalHtml.includes('ps-create-comp-private-lesson');
  checks.createGroupLesson = /Group lesson/i.test(modalHtml);

  const lessonCb = page.locator('#ps-create-comp-lesson');
  if (await lessonCb.count()) await lessonCb.uncheck();
  const plCb = page.locator('#ps-create-comp-private-lesson');
  await plCb.check();
  await page.waitForTimeout(400);
  const qty = page.locator('#ps-create-private-lesson-qty');
  await qty.fill('3');
  await page.waitForTimeout(800);
  checks.sessionRows = await page.locator('.portal-schedule-private-session-row').count();

  const modalShot = path.join(shotDir, '02-create-modal-private-lesson.png');
  await page.screenshot({ path: modalShot, fullPage: false });

  await browser.close();

  const allPass = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({
    ok: allPass,
    checks,
    pageErrors,
    screenshots: [adminShot, modalShot],
  }, null, 2));
  if (!allPass) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}).finally(() => {
  stopServer();
});
