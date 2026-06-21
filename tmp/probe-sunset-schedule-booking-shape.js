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
  await page.fill('#client', 'sunset');
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('#btn-signin');
  await page.waitForFunction(() => !window.location.pathname.includes('/staff/login'), { timeout: 45000 });
  await page.waitForTimeout(4000);

  const summary = await page.evaluate(() => ({
    wetsuits: !!document.getElementById('ps-wetsuits-today'),
    surfboards: !!document.getElementById('ps-surfboards-today'),
    lessonsSurfers: !!document.getElementById('ps-lessons-surfers-today'),
    emailReply: !!document.getElementById('ps-need-reply-email'),
    whatsReply: !!document.getElementById('ps-need-reply-whatsapp'),
    rentalsGone: !document.getElementById('ps-rentals-today'),
    next30: !!document.querySelector('[data-ps-view="next30"]'),
    compLesson: !!document.getElementById('ps-create-comp-lesson'),
    dateFrom: !!document.getElementById('ps-create-date-from'),
  }));
  summary.wetsuits ? ok('wetsuits summary card') : bad('wetsuits summary card');
  summary.surfboards ? ok('surfboards summary card') : bad('surfboards summary card');
  summary.lessonsSurfers ? ok('lessons surfer count card') : bad('lessons surfer count card');
  summary.emailReply && summary.whatsReply ? ok('need reply split cards') : bad('need reply split cards');
  summary.rentalsGone ? ok('generic rentals card removed') : bad('generic rentals card removed');
  summary.next30 ? ok('next 30 days toggle') : bad('next 30 days toggle');
  summary.compLesson && summary.dateFrom ? ok('component + multi-date create form') : bad('component create form');

  const guestName = `Shape Smoke ${crypto.randomBytes(3).toString('hex')}`;
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const iso = (d) => d.toISOString().slice(0, 10);
  const slot = await page.evaluate(() => {
    const sel = document.getElementById('ps-create-time-slot');
    return sel && sel.options.length ? sel.options[0].value : '';
  });

  await page.click('#ps-create-booking');
  await page.waitForTimeout(300);
  await page.fill('#ps-create-guest', guestName);
  await page.check('#ps-create-comp-lesson');
  await page.check('#ps-create-comp-surfboard');
  await page.check('#ps-create-comp-wetsuit');
  await page.fill('#ps-create-lesson-qty', '2');
  await page.fill('#ps-create-board-qty', '2');
  await page.fill('#ps-create-wetsuit-qty', '2');
  await page.fill('#ps-create-date-from', iso(today));
  await page.fill('#ps-create-date-to', iso(tomorrow));
  if (slot) await page.selectOption('#ps-create-time-slot', slot);
  await page.click('#ps-create-submit');
  await page.waitForTimeout(3500);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  for (const day of [iso(today), iso(tomorrow)]) {
    const onDay = await page.evaluate(({ name, day }) => document.body.innerText.includes(name) && document.body.innerText.includes(day.slice(5)), { name: guestName, day });
    onDay ? ok('booking visible on date ' + day) : bad('booking visible on date ' + day);
  }

  const row = page.locator('.ps-booking-row', { hasText: guestName }).first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(700);
    const drawer = await page.locator('#ps-drawer-body').innerText();
    drawer.includes('Staff') || drawer.includes('staff') ? ok('drawer shows staff source') : bad('drawer staff source');
    /Lesson/i.test(drawer) && /Surfboard|Board/i.test(drawer) && /Wetsuit/i.test(drawer) ? ok('drawer shows all components') : bad('drawer components', drawer.slice(0, 160));
    drawer.includes('2') ? ok('drawer shows surfer/qty') : bad('drawer surfer/qty');
  } else bad('booking row in list');

  const staffChip = await page.locator('.portal-schedule-pebble.source-staff, .portal-schedule-item-card.source-staff').count();
  staffChip >= 1 ? ok('staff source styling present', String(staffChip)) : bad('staff source styling');

  await browser.close();
  console.log(`\nBooking shape smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
