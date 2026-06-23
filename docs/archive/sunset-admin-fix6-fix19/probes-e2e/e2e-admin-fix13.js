'use strict';
const { chromium } = require('playwright');
const BASE = 'https://sunset-staging.lunafrontdesk.com';

async function fetchAdminConfig(page) {
  return page.evaluate(async () => {
    const loc = typeof getSunsetLocation === 'function' ? getSunsetLocation() : 'sunset-somo';
    const res = await fetch('/staff/admin/config?client=sunset&location=' + encodeURIComponent(loc), { credentials: 'same-origin' });
    return res.json();
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const out = { errors: [], api: {} };

  page.on('pageerror', (e) => out.errors.push(String(e.message)));

  await page.goto(`${BASE}/staff/login?client=sunset`);
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', 'SunsetStaging2026!');
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/);
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.locator('.staff-school-btn[data-school="sunset-somo"]').click();
  await page.waitForSelector('[data-admin-action="edit-time"]', { timeout: 60000 });

  const cfgBefore = await fetchAdminConfig(page);
  out.api.hasSurfPacksField = Array.isArray(cfgBefore.surf_packs);
  out.api.packCountBefore = (cfgBefore.surf_packs || []).length;
  out.api.firstLessonBefore = cfgBefore.lesson_times && cfgBefore.lesson_times[0]
    ? { slot_id: cfgBefore.lesson_times[0].slot_id, capacity: cfgBefore.lesson_times[0].capacity }
    : null;

  await page.locator('[data-admin-action="edit-time"]').first().click();
  await page.waitForSelector('#admin-time-capacity');
  const newCap = 17;
  await page.fill('#admin-time-capacity', String(newCap));
  const patchPromise = page.waitForResponse((r) =>
    r.url().includes('/staff/admin/config/lesson-times/') && r.request().method() === 'PATCH',
  );
  await page.locator('[data-admin-action="save-time"]').click();
  const patchResp = await patchPromise;
  out.api.patchStatus = patchResp.status();
  out.api.patchBody = await patchResp.json().catch(() => ({}));
  await page.waitForTimeout(3000);

  const cfgAfterCap = await fetchAdminConfig(page);
  out.api.firstLessonAfterCap = cfgAfterCap.lesson_times && cfgAfterCap.lesson_times[0]
    ? { slot_id: cfgAfterCap.lesson_times[0].slot_id, capacity: cfgAfterCap.lesson_times[0].capacity }
    : null;

  await page.locator('[data-admin-action="add-pack"]').click();
  await page.waitForSelector('#admin-new-pack-label');
  const packLabel = `E2E pack ${Date.now()}`;
  await page.fill('#admin-new-pack-label', packLabel);
  const postPromise = page.waitForResponse((r) =>
    r.url().includes('/staff/admin/config/surf-packs') && r.request().method() === 'POST',
  );
  await page.locator('[data-admin-action="save-new-pack"]').click();
  const postResp = await postPromise;
  out.api.packPostStatus = postResp.status();
  out.api.packPostBody = await postResp.json().catch(() => ({}));
  await page.waitForTimeout(3000);

  const cfgAfterPack = await fetchAdminConfig(page);
  out.api.packCountAfter = (cfgAfterPack.surf_packs || []).length;
  out.api.packLabelsAfter = (cfgAfterPack.surf_packs || []).map((p) => p.label);
  out.api.packFound = (cfgAfterPack.surf_packs || []).some((p) => p.label === packLabel);

  console.log(JSON.stringify(out, null, 2));
  await browser.close();

  const capOk = out.api.firstLessonAfterCap && out.api.firstLessonAfterCap.capacity === newCap;
  const packOk = out.api.packFound === true;
  process.exit(capOk && packOk ? 0 : 1);
})();
