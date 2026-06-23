'use strict';
const { chromium } = require('playwright');
const BASE = 'https://sunset-staging.lunafrontdesk.com';
const EMAIL = 'tywoods@gmail.com';
const PASSWORD = process.env.SUNSET_STAGING_PORTAL_PASSWORD || 'SunsetStaging2026!';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const out = { pageErrors: [], consoleErrors: [] };
  page.on('pageerror', (e) => out.pageErrors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') out.consoleErrors.push(m.text()); });

  await page.goto(`${BASE}/staff/login?client=sunset`, { waitUntil: 'domcontentloaded' });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/, { timeout: 30000 });
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.waitForSelector('#admin-business-body h1', { timeout: 20000 });

  out.sectionOrder = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.portal-admin-sections > section')).map((s) => s.id);
  });
  out.hasCapacity = await page.evaluate(() => !!document.getElementById('admin-sec-capacity'));
  out.lessonCards = await page.locator('#admin-lesson-card-grid .portal-admin-lesson-card').count();
  out.packCards = await page.locator('#admin-pack-card-grid .portal-admin-pack-card').count();
  out.lessonsTitle = await page.locator('text=Lessons').first().isVisible().catch(() => false);
  out.packsTitle = await page.locator('text=Surf packs').first().isVisible().catch(() => false);

  const editBtn = page.locator('#admin-prices-body [data-admin-action="edit-price-group"]').first();
  if (await editBtn.count()) {
    const box = await editBtn.boundingBox();
    out.rentalEditBtnSize = box ? { w: box.width, h: box.height } : null;
  }

  await page.locator('[data-admin-action="add-pack"]').click();
  await page.waitForSelector('[data-admin-action="save-new-pack"]', { timeout: 8000 });
  await page.fill('#admin-new-pack-label', 'E2E Pack ' + Date.now());
  await page.locator('[data-admin-action="save-new-pack"]').click();
  await page.waitForTimeout(3000);
  const msg = await page.locator('#admin-save-msg').textContent().catch(() => '');
  out.packSaveMsg = (msg || '').trim();
  out.packCountAfter = await page.locator('#admin-pack-card-grid .portal-admin-pack-card').count();

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
  const ok = out.sectionOrder[0] === 'admin-sec-business'
    && !out.hasCapacity
    && out.lessonCards > 0
    && /added|saved/i.test(out.packSaveMsg || '')
    && !out.pageErrors.length;
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
