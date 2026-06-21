#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');
const crypto = require('crypto');

const BASE = 'https://sunset-staging.lunafrontdesk.com';
const EMAIL = process.env.SUNSET_STAGING_PORTAL_EMAIL || 'tywoods@gmail.com';
const PASSWORD = process.env.SUNSET_STAGING_PORTAL_PASSWORD;

async function main() {
  if (!PASSWORD) { console.error('Missing SUNSET_STAGING_PORTAL_PASSWORD'); process.exit(2); }
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let pass = 0, fail = 0;
  const ok = (l, d) => { pass++; console.log('PASS', l, d || ''); };
  const bad = (l, d) => { fail++; console.error('FAIL', l, d || ''); };

  await page.goto(`${BASE}/staff/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#client', 'sunset');
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('#btn-signin');
  await page.waitForFunction(() => !window.location.pathname.includes('/staff/login'), { timeout: 45000 });
  await page.waitForTimeout(3500);

  const layout = await page.evaluate(() => ({
    hdrPrep: !!document.querySelector('.portal-schedule-ops-lesson-hdr-prep'),
    colHdr: !!document.querySelector('.portal-schedule-ops-col-hdr'),
    equipCol: document.querySelectorAll('.portal-schedule-ops-row-equip').length,
    rentalPickups: !!document.querySelector('.portal-schedule-ops-rental-pickups'),
    pebbles: document.querySelectorAll('.portal-schedule-pebble').length,
  }));
  layout.hdrPrep ? ok('lesson header prep line') : bad('lesson header prep line');
  layout.colHdr ? ok('column headers') : bad('column headers');
  layout.equipCol > 0 ? ok('equipment column rows', String(layout.equipCol)) : bad('equipment column rows');
  layout.pebbles === 0 ? ok('no pebbles') : bad('pebbles visible', String(layout.pebbles));

  const guestName = `Prep ${crypto.randomBytes(3).toString('hex')}`;
  const today = new Date().toISOString().slice(0, 10);
  const slot = await page.evaluate(() => {
    const sel = document.getElementById('ps-create-time-slot');
    return sel && sel.options.length ? sel.options[0].value : '';
  });

  await page.click('#ps-create-booking');
  await page.waitForTimeout(300);
  await page.fill('#ps-create-guest', guestName);
  await page.evaluate(() => {
    ['ps-create-comp-lesson', 'ps-create-comp-surfboard', 'ps-create-comp-wetsuit'].forEach((id) => {
      const n = document.getElementById(id);
      if (n) { n.checked = true; n.dispatchEvent(new Event('change', { bubbles: true })); }
    });
  });
  await page.fill('#ps-create-lesson-qty', '2');
  await page.fill('#ps-create-board-qty', '2');
  await page.fill('#ps-create-wetsuit-qty', '2');
  await page.fill('#ps-create-date-from', today);
  await page.fill('#ps-create-date-to', today);
  if (slot) await page.selectOption('#ps-create-time-slot', slot);
  await page.click('#ps-create-submit');
  await page.waitForTimeout(4500);

  const row = page.locator('.portal-schedule-ops-row', { hasText: guestName }).first();
  if (await row.count()) {
    const equip = await row.locator('.portal-schedule-ops-row-equip').innerText();
    /board.*wetsuit/i.test(equip) ? ok('lesson row equipment', equip) : bad('lesson row equipment', equip);
    await row.click();
    await page.waitForTimeout(600);
    const drawer = await page.locator('#ps-drawer-body').innerText();
    drawer.includes(guestName) ? ok('drawer opens') : bad('drawer opens');
  } else bad('created booking row visible');

  await browser.close();
  console.log(`\nPrep sheet smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
