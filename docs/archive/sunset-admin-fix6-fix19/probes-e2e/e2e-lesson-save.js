'use strict';
const { chromium } = require('playwright');

const BASE = 'https://sunset-staging.lunafrontdesk.com';
const EMAIL = 'tywoods@gmail.com';
const PASSWORD = process.env.SUNSET_STAGING_PORTAL_PASSWORD || 'SunsetStaging2026!';

async function login(page) {
  await page.goto(`${BASE}/staff/login?client=sunset`, { waitUntil: 'domcontentloaded' });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/, { timeout: 30000 });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results = { consoleErrors: [], pageErrors: [] };
  page.on('console', (m) => { if (m.type() === 'error') results.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => results.pageErrors.push(String(e.message)));

  try {
    await login(page);
    await page.locator('button.tab-btn[data-tab="admin"]').click();
    await page.waitForSelector('#admin-times-body', { timeout: 15000 });
    await page.waitForFunction(() => document.getElementById('admin-times-body')?.textContent?.length > 5, { timeout: 20000 });

    // Add lesson
    await page.locator('[data-admin-action="add-time"]').click();
    await page.waitForTimeout(500);
    results.addTimeForm = await page.locator('#admin-add-time-form').count();
    results.afterAddTimeErrors = results.consoleErrors.slice();

    if (results.addTimeForm) {
      await page.fill('#admin-new-time-label', 'E2E New Lesson');
      await page.fill('#admin-new-time-start', '11:00');
      await page.fill('#admin-new-time-cost', '45.00');
      await page.locator('[data-admin-action="save-new-time"]').click();
      await page.waitForTimeout(2500);
      results.afterNewLessonMsg = await page.locator('#admin-save-msg').textContent().catch(() => '');
    }

    // Edit existing lesson save
    const editLesson = page.locator('[data-admin-action="edit-time"]').first();
    if (await editLesson.count()) {
      await editLesson.click();
      await page.waitForTimeout(500);
      results.editLessonForm = await page.locator('#admin-time-label').count();
      results.afterEditOpenErrors = results.consoleErrors.slice();
      if (results.editLessonForm) {
        await page.fill('#admin-time-label', 'E2E Edited Lesson');
        await page.locator('[data-admin-action="save-time"]').click();
        await page.waitForTimeout(2500);
        results.afterEditLessonMsg = await page.locator('#admin-save-msg').textContent().catch(() => '');
      }
    }
  } catch (e) {
    results.error = e.message;
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(results, null, 2));
})();
