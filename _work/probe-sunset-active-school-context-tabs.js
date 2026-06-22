#!/usr/bin/env node
'use strict';
/**
 * Sunset staging — active school context stays consistent across portal tabs.
 * Read-only UI checks after school switch; no outbound WhatsApp/email.
 */
const { chromium } = require('playwright');

const BASE = process.env.SUNSET_STAGING_BASE_URL || 'https://sunset-staging.lunafrontdesk.com';
const EMAIL = process.env.SUNSET_STAGING_PORTAL_EMAIL || 'tywoods@gmail.com';
const PASSWORD = process.env.SUNSET_STAGING_PORTAL_PASSWORD;

async function login(page) {
  await page.goto(`${BASE}/staff/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#client', 'sunset');
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('#btn-signin');
  await page.waitForFunction(() => !window.location.pathname.includes('/staff/login'), { timeout: 45000 });
  await page.waitForTimeout(2000);
}

async function switchSchool(page, school) {
  await page.evaluate((s) => {
    document.querySelectorAll('.staff-school-btn').forEach((b) => {
      if (b.getAttribute('data-school') === s) b.click();
    });
  }, school);
  await page.waitForTimeout(1500);
}

async function readLabel(page, id) {
  return page.evaluate((elId) => {
    const n = document.getElementById(elId);
    return n ? String(n.textContent || '').trim() : '';
  }, id);
}

async function main() {
  if (!PASSWORD) {
    console.error('Missing SUNSET_STAGING_PORTAL_PASSWORD');
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results = [];
  const check = (id, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}\t${id}\t${detail || ''}`);
    results.push({ id, ok, detail });
  };

  try {
    await login(page);
    await switchSchool(page, 'sunset-sardinero');

    await page.click('button.tab-btn[data-tab="portal-home"]');
    await page.waitForTimeout(1200);
    const scheduleLabel = await readLabel(page, 'schedule-school-label');
    check('schedule-school-label elSardi', /elSardi/i.test(scheduleLabel), scheduleLabel);

    await page.click('button.tab-btn[data-tab="conversations"]');
    await page.waitForTimeout(1200);
    const inboxLabel = await readLabel(page, 'inbox-school-label');
    check('inbox-school-label elSardi', /elSardi/i.test(inboxLabel), inboxLabel);

    await page.click('button.tab-btn[data-tab="customers"]');
    await page.waitForTimeout(1200);
    const customersLabel = await readLabel(page, 'customers-school-label');
    check('customers-school-label elSardi', /elSardi/i.test(customersLabel), customersLabel);

    await page.click('button.tab-btn[data-tab="admin"]');
    await page.waitForTimeout(2000);
    const adminLabel = await readLabel(page, 'admin-school-label');
    check('admin-school-label elSardi', /elSardi/i.test(adminLabel), adminLabel);

    const stored = await page.evaluate(() => localStorage.getItem('staff_portal_sunset_location'));
    check('localStorage staff_portal_sunset_location', stored === 'sunset-sardinero', stored || '');

    await page.click('#ps-create-booking');
    await page.waitForTimeout(600);
    const createLabel = await readLabel(page, 'ps-create-school-label');
    check('ps-create-school-label elSardi', /elSardi/i.test(createLabel), createLabel);
    await page.evaluate(() => {
      const close = document.getElementById('ps-create-cancel');
      if (close) close.click();
    });

    await switchSchool(page, 'sunset-somo');
    await page.click('button.tab-btn[data-tab="portal-home"]');
    await page.waitForTimeout(1000);
    const somoLabel = await readLabel(page, 'schedule-school-label');
    check('schedule-school-label Sunset after switch back', /Sunset/i.test(somoLabel) && !/elSardi/i.test(somoLabel), somoLabel);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n── Results: ${results.length - failed.length} passed, ${failed.length} failed ──`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
