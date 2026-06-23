'use strict';
const { chromium } = require('playwright');
const BASE = 'https://sunset-staging.lunafrontdesk.com';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const out = { errors: [], consoleErrors: [] };
  page.on('pageerror', (e) => out.consoleErrors.push(String(e.message)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') out.consoleErrors.push(msg.text());
  });

  await page.goto(`${BASE}/staff/login?client=sunset`);
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', 'SunsetStaging2026!');
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/);
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.locator('.staff-school-btn[data-school="sunset-somo"]').click();
  await page.waitForSelector('[data-admin-action="edit-time"]', { timeout: 60000 });

  // Pebbles in view mode must not be clickable (pointer-events: none)
  const pebbleStyle = await page.evaluate(() => {
    const pill = document.querySelector('.portal-admin-pill-static');
    if (!pill) return { found: false };
    return { found: true, pointerEvents: getComputedStyle(pill).pointerEvents };
  });
  out.pebbleStatic = pebbleStyle;

  // Pack edit opens without JS error
  await page.locator('[data-admin-action="edit-pack"]').first().click();
  await page.waitForSelector('[data-admin-action="save-pack"]', { timeout: 15000 });
  out.packEditOpened = true;
  const packPatch = page.waitForResponse((r) =>
    r.url().includes('/staff/admin/config/surf-packs/') && r.request().method() === 'PATCH',
  );
  await page.locator('[id^="admin-pack-"][id$="-label"]').first().fill('E2E UI pack save ' + Date.now());
  await page.locator('[data-admin-action="save-pack"]').click();
  const packResp = await packPatch;
  out.packPatchStatus = packResp.status();

  await page.waitForTimeout(2000);
  out.consoleErrorsAfterPack = out.consoleErrors.filter((e) => /renderAdminPackEditForm|lessons render failed/i.test(e));

  // Lesson save
  await page.locator('[data-admin-action="edit-time"]').first().click();
  await page.waitForSelector('[data-admin-action="save-time"]');
  await page.fill('#admin-time-capacity', '22');
  const lessonPatch = page.waitForResponse((r) =>
    r.url().includes('/staff/admin/config/lesson-times/') && r.request().method() === 'PATCH',
  );
  await page.locator('[data-admin-action="save-time"]').click();
  const lessonResp = await lessonPatch;
  out.lessonPatchStatus = lessonResp.status();
  await page.waitForTimeout(2000);
  out.lessonMsg = (await page.locator('#admin-save-msg').textContent().catch(() => ''))?.trim();
  out.consoleErrorsAfterLesson = out.consoleErrors.filter((e) => /renderAdminPackEditForm|lessons render failed/i.test(e));

  console.log(JSON.stringify(out, null, 2));
  await browser.close();

  const ok = out.pebbleStatic.found
    && out.pebbleStatic.pointerEvents === 'none'
    && out.packEditOpened
    && out.packPatchStatus === 200
    && out.lessonPatchStatus === 200
    && out.consoleErrorsAfterLesson.length === 0
    && out.consoleErrorsAfterPack.length === 0;
  process.exit(ok ? 0 : 1);
})();
