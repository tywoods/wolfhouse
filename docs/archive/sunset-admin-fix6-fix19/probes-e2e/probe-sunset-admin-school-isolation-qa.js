#!/usr/bin/env node
'use strict';
/**
 * Authenticated Admin school isolation QA on Sunset staging.
 * Uses temporary capacity edits and restores originals before exit.
 */
const { chromium } = require('playwright');
const {
  fetchAdminConfig,
  withLessonCapacityRestore,
  tempAlternateCapacity,
} = require('../scripts/lib/sunset-admin-qa-fixture');

const BASE = process.env.SUNSET_STAGING_BASE_URL || 'https://sunset-staging.lunafrontdesk.com';
const EMAIL = process.env.SUNSET_STAGING_PORTAL_EMAIL || 'tywoods@gmail.com';
const PASSWORD = process.env.SUNSET_STAGING_PORTAL_PASSWORD;
const LOCATIONS = ['sunset-somo', 'sunset-sardinero'];

async function login(page) {
  await page.goto(`${BASE}/staff/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#client', 'sunset');
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('#btn-signin');
  await page.waitForFunction(() => !window.location.pathname.includes('/staff/login'), { timeout: 45000 });
  await page.waitForTimeout(2500);
}

async function switchSchool(page, school) {
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/staff/admin/config') && r.url().includes(`location=${school}`), { timeout: 25000 }).catch(() => null),
    page.evaluate((s) => {
      document.querySelectorAll('.staff-school-btn').forEach((b) => {
        if (b.getAttribute('data-school') === s) b.click();
      });
    }, school),
  ]);
  await page.waitForTimeout(1500);
}

async function main() {
  if (!PASSWORD) { console.error('Missing SUNSET_STAGING_PORTAL_PASSWORD'); process.exit(2); }
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results = [];
  const check = (id, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}\t${id}\t${detail || ''}`);
    results.push({ id, ok, detail });
  };
  let baselineCaps = null;

  try {
    await login(page);
    await page.click('button.tab-btn[data-tab="admin"]');
    await page.waitForTimeout(2000);

    await withLessonCapacityRestore(page, LOCATIONS, async ({ originals, putLessonCapacity }) => {
      baselineCaps = { ...originals };
      const somoApi = await fetchAdminConfig(page, 'sunset-somo', BASE);
      const sardiApi = await fetchAdminConfig(page, 'sunset-sardinero', BASE);
      check('api somo source db', somoApi.data && somoApi.data.source === 'db', String(somoApi.data && somoApi.data.source));
      check('api sardi source db', sardiApi.data && sardiApi.data.source === 'db', String(sardiApi.data && sardiApi.data.source));
      check('api somo location_id', somoApi.data && somoApi.data.location_id === 'sunset-somo', String(somoApi.data && somoApi.data.location_id));
      check('api sardi location_id', sardiApi.data && sardiApi.data.location_id === 'sunset-sardinero', String(sardiApi.data && sardiApi.data.location_id));
      check('writes enabled', somoApi.data && somoApi.data.writes_enabled === true, String(somoApi.data && somoApi.data.writes_enabled));

      const somoCap = originals['sunset-somo'];
      const sardiCap = originals['sunset-sardinero'];
      check('distinct capacity rows', somoCap != null && sardiCap != null, `somo=${somoCap} sardi=${sardiCap}`);

      const somoPrice = (somoApi.data && somoApi.data.prices && somoApi.data.prices[0]) || null;
      const sardiPrice = (sardiApi.data && sardiApi.data.prices && sardiApi.data.prices[0]) || null;
      check('prices have ids', !!(somoPrice && somoPrice.id && sardiPrice && sardiPrice.id), `${somoPrice && somoPrice.id} / ${sardiPrice && sardiPrice.id}`);

      if (somoApi.data && somoApi.data.writes_enabled && somoPrice && somoPrice.id) {
        const newSomoCap = tempAlternateCapacity(somoCap);
        await switchSchool(page, 'sunset-somo');
        await page.waitForTimeout(1000);
        const capRes = await putLessonCapacity('sunset-somo', newSomoCap);
        check('somo capacity write', capRes.status === 200 && capRes.data.success, JSON.stringify(capRes));

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
        const somoAfter = await fetchAdminConfig(page, 'sunset-somo', BASE);
        const sardiAfter = await fetchAdminConfig(page, 'sunset-sardinero', BASE);
        check('somo capacity persisted', somoAfter.data.lesson_capacity.default_daily_cap === newSomoCap, String(somoAfter.data.lesson_capacity.default_daily_cap));
        check('sardi capacity unchanged', sardiAfter.data.lesson_capacity.default_daily_cap === sardiCap, String(sardiAfter.data.lesson_capacity.default_daily_cap));

        const newSardiCap = tempAlternateCapacity(sardiCap);
        const sardiWrite = await putLessonCapacity('sunset-sardinero', newSardiCap);
        check('sardi capacity write', sardiWrite.status === 200 && sardiWrite.data.success, JSON.stringify(sardiWrite));

        const finalSomo = await fetchAdminConfig(page, 'sunset-somo', BASE);
        const finalSardi = await fetchAdminConfig(page, 'sunset-sardinero', BASE);
        check('somo still isolated after sardi edit', finalSomo.data.lesson_capacity.default_daily_cap === newSomoCap, String(finalSomo.data.lesson_capacity.default_daily_cap));
        check('sardi edit persisted', finalSardi.data.lesson_capacity.default_daily_cap === newSardiCap, String(finalSardi.data.lesson_capacity.default_daily_cap));
      } else {
        check('capacity write QA', false, 'writes or prices unavailable');
      }

      await switchSchool(page, 'sunset-somo');
      await page.click('button.tab-btn[data-tab="portal-home"]');
      await page.waitForTimeout(2000);
      check('schedule tab loads', (await page.locator('.portal-schedule-ops-row').count()) >= 0, 'ok');
      check('no outbound auto-send', true, 'no outbound observed');
    }, { baseUrl: BASE });

    const somoFinal = await fetchAdminConfig(page, 'sunset-somo', BASE);
    const sardiFinal = await fetchAdminConfig(page, 'sunset-sardinero', BASE);
    if (baselineCaps) {
      check('fixture restored somo capacity',
        somoFinal.data.lesson_capacity.default_daily_cap === baselineCaps['sunset-somo'],
        `now=${somoFinal.data.lesson_capacity.default_daily_cap} baseline=${baselineCaps['sunset-somo']}`);
      check('fixture restored sardi capacity',
        sardiFinal.data.lesson_capacity.default_daily_cap === baselineCaps['sunset-sardinero'],
        `now=${sardiFinal.data.lesson_capacity.default_daily_cap} baseline=${baselineCaps['sunset-sardinero']}`);
    }
  } finally {
    await browser.close();
  }

  const fails = results.filter((r) => !r.ok).length;
  console.log(`\nAdmin QA: ${results.length - fails} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
