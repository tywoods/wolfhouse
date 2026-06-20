#!/usr/bin/env node
'use strict';

/**
 * Sunset staging smoke — create manual schedule booking, reload, verify persistence.
 * Run on lunabox with SUNSET_STAGING_PORTAL_PASSWORD set.
 */

const { chromium } = require('playwright');
const crypto = require('crypto');

const BASE = 'https://sunset-staging.lunafrontdesk.com';
const EMAIL = process.env.SUNSET_STAGING_PORTAL_EMAIL || 'tywoods@gmail.com';
const PASSWORD = process.env.SUNSET_STAGING_PORTAL_PASSWORD;

function assert(label, ok, detail) {
  if (ok) {
    console.log('PASS', label, detail || '');
    return true;
  }
  console.error('FAIL', label, detail || '');
  return false;
}

async function login(page) {
  await page.goto(`${BASE}/staff/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-form', { timeout: 20000 });
  await page.fill('#client', 'sunset');
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('#btn-signin');
  await page.waitForFunction(() => !window.location.pathname.includes('/staff/login'), { timeout: 45000 });
  await page.waitForSelector('#c-client option', { timeout: 45000 });
}

async function main() {
  if (!PASSWORD) {
    console.error('Missing SUNSET_STAGING_PORTAL_PASSWORD');
    process.exit(2);
  }

  const guestName = `Persist Smoke ${crypto.randomBytes(3).toString('hex')}`;
  const today = new Date().toISOString().slice(0, 10);
  let pass = 0;
  let fail = 0;
  const track = (label, condition, detail) => {
    if (assert(label, condition, detail)) pass += 1;
    else fail += 1;
  };

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await login(page);
    await page.waitForTimeout(2000);

    await page.click('#ps-create-booking');
    await page.fill('#ps-create-guest', guestName);
    await page.selectOption('#ps-create-type', 'lesson');
    await page.fill('#ps-create-date', today);
    await page.fill('#ps-create-time', '11:00');
    await page.fill('#ps-create-count', '2');
    await page.selectOption('#ps-create-payment', 'unpaid');
    await page.fill('#ps-create-notes', 'Real manual booking persistence smoke');
    await page.click('#ps-create-submit');
    await page.waitForTimeout(2500);

    const visibleBefore = await page.evaluate((name) => (document.body.innerText || '').includes(name), guestName);
    visibleBefore ? track('booking visible after create', true, guestName) : track('booking visible after create', false);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);

    const visibleAfter = await page.evaluate((name) => (document.body.innerText || '').includes(name), guestName);
    visibleAfter ? track('booking persists after reload', true, guestName) : track('booking persists after reload', false);

    const row = page.locator('.ps-booking-row', { hasText: guestName }).first();
    if (await row.count()) {
      track('booking in actions list after reload', true);
      await row.click();
      await page.waitForTimeout(700);
      const drawer = await page.evaluate(() => {
        const d = document.getElementById('ps-detail-drawer');
        return d && window.getComputedStyle(d).display !== 'none';
      });
      track('drawer opens for persisted booking', drawer);
      const body = await page.locator('#ps-drawer-body').innerText();
      track('drawer shows Saved booking badge', /Saved booking/i.test(body), body.slice(0, 120));
      track('drawer shows record id', /Record ID/i.test(body));
    } else {
      track('booking row in list after reload', false);
    }
  } catch (err) {
    track('smoke exception', false, err.message);
  } finally {
    await browser.close();
  }

  console.log(`\nPersist smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
