#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');
const crypto = require('crypto');

const BASE = 'https://sunset-staging.lunafrontdesk.com';
const EMAIL = process.env.SUNSET_STAGING_PORTAL_EMAIL || 'tywoods@gmail.com';
const PASSWORD = process.env.SUNSET_STAGING_PORTAL_PASSWORD;

function track(label, ok, detail) {
  if (ok) console.log('PASS', label, detail || '');
  else console.error('FAIL', label, detail || '');
  return ok;
}

async function main() {
  if (!PASSWORD) { console.error('Missing SUNSET_STAGING_PORTAL_PASSWORD'); process.exit(2); }
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let pass = 0, fail = 0;
  const ok = (l, d) => { if (track(l, true, d)) pass++; else fail++; };
  const bad = (l, d) => { if (track(l, false, d)) pass++; else fail++; };

  await page.goto(`${BASE}/staff/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-form');
  await page.fill('#client', 'sunset');
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('#btn-signin');
  await page.waitForFunction(() => !window.location.pathname.includes('/staff/login'), { timeout: 45000 });
  await page.waitForSelector('#c-client option', { state: 'attached', timeout: 45000 });
  await page.waitForTimeout(3500);

  const needsReplyGone = await page.evaluate(() => !document.getElementById('ps-create-needs-reply'));
  needsReplyGone ? ok('needs-reply checkbox removed') : bad('needs-reply checkbox removed');

  const slotGroups = await page.locator('.portal-schedule-slot-group').count();
  slotGroups >= 1 ? ok('date cards show slot groups', String(slotGroups)) : bad('date cards show slot groups', String(slotGroups));

  const lessonsCard = await page.locator('#ps-lessons-today .schedule-slot-line').count();
  lessonsCard >= 1 ? ok('lessons today per-slot breakdown', String(lessonsCard)) : bad('lessons today per-slot breakdown', String(lessonsCard));

  const slotOptions = await page.evaluate(() => {
    const sel = document.getElementById('ps-create-time-slot');
    return sel ? sel.options.length : 0;
  });
  slotOptions >= 1 ? ok('create form lesson slot select populated', String(slotOptions)) : bad('create form lesson slot select populated', String(slotOptions));

  const guestName = `Slot Smoke ${crypto.randomBytes(3).toString('hex')}`;
  const today = new Date().toISOString().slice(0, 10);
  const chosenSlot = await page.evaluate(() => {
    const sel = document.getElementById('ps-create-time-slot');
    return sel && sel.options.length ? sel.options[0].value : '';
  });

  await page.click('#ps-create-booking');
  await page.fill('#ps-create-guest', guestName);
  await page.selectOption('#ps-create-type', 'lesson');
  await page.fill('#ps-create-date', today);
  if (chosenSlot) await page.selectOption('#ps-create-time-slot', chosenSlot);
  await page.click('#ps-create-submit');
  await page.waitForTimeout(2500);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  const grouped = await page.evaluate(({ name, slot }) => {
    const groups = Array.from(document.querySelectorAll('.portal-schedule-slot-group'));
    for (const g of groups) {
      const hdr = g.querySelector('.portal-schedule-slot-hdr span');
      const hdrText = hdr ? hdr.textContent.trim() : '';
      if (slot && hdrText.indexOf(slot) === 0 && g.textContent.includes(name)) return true;
    }
    return document.body.innerText.includes(name);
  }, { name: guestName, slot: chosenSlot });

  grouped ? ok('lesson booking appears under slot group after reload', chosenSlot) : bad('lesson booking under slot after reload');

  const row = page.locator('.ps-booking-row', { hasText: guestName }).first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(600);
    const drawer = await page.locator('#ps-drawer-body').innerText();
    drawer.includes('Lesson slot') || drawer.includes(chosenSlot) ? ok('drawer shows lesson slot') : bad('drawer shows lesson slot', drawer.slice(0, 120));
  } else bad('booking row after reload');

  await browser.close();
  console.log(`\nTimeslot smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
