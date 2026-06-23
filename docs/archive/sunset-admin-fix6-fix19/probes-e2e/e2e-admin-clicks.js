'use strict';
/**
 * Browser E2E: admin rental row save, delete, surf pack add.
 * Run: node tmp/e2e-admin-clicks.js
 */
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

async function openAdmin(page) {
  const adminTab = page.locator('button.tab-btn[data-tab="admin"]');
  await adminTab.waitFor({ state: 'visible', timeout: 15000 });
  await adminTab.click();
  await page.waitForSelector('#tab-admin', { state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => {
    const box = document.getElementById('admin-prices-body');
    return box && box.textContent && box.textContent.trim().length > 10;
  }, { timeout: 20000 });
}

async function msg(page) {
  const el = page.locator('#admin-save-msg');
  if (!(await el.isVisible())) return '';
  return (await el.textContent())?.trim() || '';
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results = {};

  page.on('console', (m) => {
    if (m.type() === 'error') results.consoleErrors = (results.consoleErrors || []).concat(m.text());
  });
  page.on('pageerror', (e) => {
    results.pageErrors = (results.pageErrors || []).concat(String(e.message));
  });

  try {
    await login(page);
    await openAdmin(page);

    // Rental: enter edit mode on first group
    const editBtn = page.locator('#admin-prices-body [data-admin-action="edit-price-group"]').first();
    await editBtn.click();
    await page.waitForSelector('[data-admin-action="save-price-group"]', { timeout: 5000 });
    results.editMode = true;

    // Change first amount field
    const amount = page.locator('#admin-prices-body .portal-admin-price-card-edit input[type="text"]').first();
    await amount.fill('12.34');

    await page.locator('[data-admin-action="save-price-group"]').first().click();
    await page.waitForTimeout(2000);
    results.afterRentalSaveMsg = await msg(page);

    // Re-enter edit, test X delete with confirm
    await page.locator('[data-admin-action="edit-price-group"]').first().click();
    page.once('dialog', (d) => d.accept());
    const cardsBefore = await page.locator('#admin-prices-body [data-admin-price-card]').count();
    await page.locator('[data-admin-action="delete-price"]').first().click();
    await page.waitForTimeout(2500);
    const cardsAfter = await page.locator('#admin-prices-body [data-admin-price-card]').count();
    results.deleteWorked = cardsAfter < cardsBefore;
    results.afterDeleteMsg = await msg(page);

    // Surf pack +
    await page.locator('[data-admin-action="add-pack"]').click();
    await page.waitForSelector('[data-admin-action="save-new-pack"]', { timeout: 5000 });
    await page.fill('#admin-new-pack-label', 'E2E Test Pack');
    await page.locator('[data-admin-action="save-new-pack"]').click();
    await page.waitForTimeout(2500);
    results.afterPackSaveMsg = await msg(page);
    results.packFormVisible = await page.locator('#admin-new-pack-label').count();
  } catch (err) {
    results.error = err.message;
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify(results, null, 2));
  const ok = results.editMode
    && /saved|added|removed/i.test(String(results.afterRentalSaveMsg || ''))
    && results.deleteWorked
    && /added|saved/i.test(String(results.afterPackSaveMsg || ''))
    && !results.error
    && !(results.pageErrors || []).length;
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
