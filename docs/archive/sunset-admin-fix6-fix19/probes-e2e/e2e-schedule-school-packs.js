'use strict';
const { chromium } = require('playwright');
const BASE = 'https://sunset-staging.lunafrontdesk.com';

async function fetchConfig(page, location) {
  return page.evaluate(async (loc) => {
    const res = await fetch('/staff/admin/config?client=sunset&location=' + encodeURIComponent(loc), { credentials: 'same-origin' });
    return res.json();
  }, location);
}

async function fetchPackCounts(page, location) {
  const today = new Date().toISOString().slice(0, 10);
  return page.evaluate(async ({ loc, dateIso }) => {
    const res = await fetch('/staff/schedule/surf-pack-counts?client=sunset&location=' + encodeURIComponent(loc) + '&date=' + encodeURIComponent(dateIso), { credentials: 'same-origin' });
    return res.json();
  }, { loc: location, dateIso: today });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const out = { errors: [] };
  page.on('pageerror', (e) => out.errors.push(String(e.message)));

  await page.goto(`${BASE}/staff/login?client=sunset`);
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', 'SunsetStaging2026!');
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/);
  await page.locator('button.tab-btn[data-tab="portal-home"]').click();

  // elSardi
  await page.locator('.staff-school-btn[data-school="sunset-sardinero"]').click();
  await page.waitForTimeout(4000);
  const sardiCfg = await fetchConfig(page, 'sunset-sardinero');
  const sardiCounts = await fetchPackCounts(page, 'sunset-sardinero');
  out.sardi = {
    lessonCount: (sardiCfg.lesson_times || []).length,
    packCount: (sardiCfg.surf_packs || []).length,
    packLabels: (sardiCfg.surf_packs || []).map((p) => p.label),
    countsOk: sardiCounts.success === true,
    lessonRows: await page.locator('#ps-lessons-slot-sub .portal-schedule-lesson-time-row').count(),
    packRows: await page.locator('#ps-surf-packs-sub .portal-schedule-lesson-time-row').count(),
    packCardExists: !!(await page.$('#ps-surf-packs-sub')),
  };

  // Sunset (somo)
  await page.locator('.staff-school-btn[data-school="sunset-somo"]').click();
  await page.waitForTimeout(4000);
  const somoCfg = await fetchConfig(page, 'sunset-somo');
  out.somo = {
    lessonCount: (somoCfg.lesson_times || []).length,
    packCount: (somoCfg.surf_packs || []).length,
    packLabels: (somoCfg.surf_packs || []).map((p) => p.label),
    lessonRows: await page.locator('#ps-lessons-slot-sub .portal-schedule-lesson-time-row').count(),
    packRows: await page.locator('#ps-surf-packs-sub .portal-schedule-lesson-time-row').count(),
  };

  out.lessonGroupsCapped = out.sardi.lessonRows <= 4 && out.somo.lessonRows <= 4;
  out.schoolsDiffer = JSON.stringify(out.sardi.packLabels) !== JSON.stringify(out.somo.packLabels)
    || out.sardi.lessonCount !== out.somo.lessonCount
    || out.sardi.lessonRows !== out.somo.lessonRows;

  console.log(JSON.stringify(out, null, 2));
  await browser.close();

  const ok = out.sardi.packCardExists
    && out.sardi.countsOk
    && out.sardi.packRows === out.sardi.packCount
    && out.lessonGroupsCapped
    && !out.errors.some((e) => /renderAdminPackEditForm|lessons render failed/i.test(e));
  process.exit(ok ? 0 : 1);
})();
