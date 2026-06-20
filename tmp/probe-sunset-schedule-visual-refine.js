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

  await page.click('button[data-tab="portal-home"]');
  await page.waitForTimeout(2000);

  const layout = await page.evaluate(() => {
    const row = document.querySelector('.portal-schedule-ops-row');
    const pebbles = document.querySelectorAll('.portal-schedule-pebble:not([style*="display: none"])').length;
    const summaries = document.querySelectorAll('.portal-schedule-ops-row-summary').length;
    const status = document.querySelectorAll('.portal-schedule-ops-row-status').length;
    const rails = document.querySelectorAll('.portal-schedule-ops-row-rail').length;
    return { row: !!row, pebbles, summaries, status, rails };
  });
  layout.row ? ok('ops rows render') : bad('ops rows render');
  layout.pebbles === 0 ? ok('no visible component pebbles', String(layout.pebbles)) : bad('component pebbles visible', String(layout.pebbles));
  layout.summaries > 0 ? ok('service summary lines', String(layout.summaries)) : bad('service summary lines');
  layout.rails > 0 ? ok('source rails present', String(layout.rails)) : bad('source rails');

  const guestName = `Visual ${crypto.randomBytes(3).toString('hex')}`;
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

  const rowText = await page.evaluate((name) => {
    const row = Array.from(document.querySelectorAll('.portal-schedule-ops-row')).find((n) => n.innerText.includes(name));
    return row ? row.innerText.replace(/\s+/g, ' ').trim() : '';
  }, guestName);
  rowText.includes(guestName) ? ok('created booking on board', guestName) : bad('created booking on board');
  /lesson|board|wetsuit/i.test(rowText) ? ok('row shows service summary', rowText.slice(0, 80)) : bad('row summary', rowText.slice(0, 80));

  const row = page.locator('.portal-schedule-ops-row', { hasText: guestName }).first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(700);
    const drawer = await page.locator('#ps-drawer-body').innerText();
    drawer.includes(guestName) ? ok('drawer opens') : bad('drawer opens');
    /Lesson:|Surfboard|Wetsuit/i.test(drawer) ? ok('drawer component list') : bad('drawer component list', drawer.slice(0, 120));
    (await page.locator('#ps-drawer-body .portal-schedule-pebble').count()) === 0
      ? ok('drawer has no pebble pile')
      : bad('drawer pebble pile');
  } else bad('row for drawer');

  await browser.close();
  console.log(`\nVisual refine smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
