#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');
const crypto = require('crypto');

const BASE = 'https://sunset-staging.lunafrontdesk.com';
const EMAIL = process.env.SUNSET_STAGING_PORTAL_EMAIL || 'tywoods@gmail.com';
const PASSWORD = process.env.SUNSET_STAGING_PORTAL_PASSWORD;

async function clickLang(page, lang) {
  await page.locator(`.staff-lang-btn[data-lang="${lang}"]`).click();
  await page.waitForTimeout(800);
}

async function scheduleLabelSnapshot(page) {
  return page.evaluate(() => {
    const card = document.querySelector('[data-i18n="schedule.card.unpaid"]');
    const viewBtn = document.querySelector('.portal-schedule-view-btn[data-ps-view="week"]');
    const createBtn = document.getElementById('ps-create-booking');
    return {
      unpaidCard: card ? card.textContent.trim() : '',
      weekView: viewBtn ? viewBtn.textContent.trim() : '',
      createBooking: createBtn ? createBtn.textContent.trim() : '',
      calmBg: !!document.querySelector('#tab-portal-home') && getComputedStyle(document.getElementById('tab-portal-home')).backgroundColor !== '',
    };
  });
}

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

  const en0 = await scheduleLabelSnapshot(page);
  en0.unpaidCard === 'Unpaid' ? ok('EN unpaid card label', en0.unpaidCard) : bad('EN unpaid card label', en0.unpaidCard);

  await clickLang(page, 'es');
  const es1 = await scheduleLabelSnapshot(page);
  (es1.unpaidCard === 'Sin pagar' || es1.unpaidCard === 'Impagado') ? ok('ES unpaid card live', es1.unpaidCard) : bad('ES unpaid card live', es1.unpaidCard);
  es1.weekView && es1.weekView !== en0.weekView ? ok('ES week view label live', es1.weekView) : bad('ES week view label live', es1.weekView);

  await clickLang(page, 'en');
  const en2 = await scheduleLabelSnapshot(page);
  en2.unpaidCard === 'Unpaid' ? ok('EN restored without reload', en2.unpaidCard) : bad('EN restored without reload', en2.unpaidCard);

  await page.click('#ps-create-booking');
  await page.waitForTimeout(400);
  const pendingCount = await page.locator('#ps-create-payment option[value="pending"]').count();
  pendingCount === 0 ? ok('no pending payment option') : bad('pending option still present');

  const guestName = `Calm ${crypto.randomBytes(3).toString('hex')}`;
  const phone = '+34600' + String(Math.floor(Math.random() * 900000 + 100000));
  const today = new Date().toISOString().slice(0, 10);
  const slot = await page.evaluate(() => {
    const sel = document.getElementById('ps-create-time-slot');
    return sel && sel.options.length ? sel.options[0].value : '';
  });

  await page.fill('#ps-create-guest', guestName);
  await page.fill('#ps-create-phone', phone);
  await page.evaluate(() => {
    ['ps-create-comp-lesson', 'ps-create-comp-surfboard'].forEach((id) => {
      const n = document.getElementById(id);
      if (n) { n.checked = true; n.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    const w = document.getElementById('ps-create-comp-wetsuit');
    if (w) { w.checked = false; w.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.fill('#ps-create-lesson-qty', '1');
  await page.fill('#ps-create-board-qty', '1');
  await page.fill('#ps-create-date-from', today);
  await page.fill('#ps-create-date-to', today);
  await page.selectOption('#ps-create-payment', 'unpaid');
  if (slot) await page.selectOption('#ps-create-time-slot', slot);
  await page.click('#ps-create-submit');
  await page.waitForTimeout(5000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const row = page.locator('.portal-schedule-ops-row', { hasText: guestName }).first();
  if (await row.count()) {
    ok('booking row after reload');
    await row.click();
    await page.waitForTimeout(700);
    const drawer = await page.evaluate(() => ({
      body: document.getElementById('ps-drawer-body')?.innerText || '',
      phoneField: document.getElementById('ps-drawer-body')?.innerText.includes('+346') || false,
      convBtn: document.getElementById('ps-drawer-conversation-btn')?.textContent?.trim() || '',
      convDisabled: document.getElementById('ps-drawer-conversation-btn')?.disabled,
    }));
    drawer.body.includes(guestName) ? ok('drawer guest') : bad('drawer guest');
    drawer.phoneField ? ok('drawer phone shown') : bad('drawer phone shown', drawer.body.slice(0, 200));
    drawer.convBtn && !drawer.convDisabled ? ok('conversation button enabled', drawer.convBtn) : bad('conversation button', JSON.stringify(drawer));

    await page.click('#ps-drawer-conversation-btn');
    await page.waitForTimeout(2500);
    const inboxActive = await page.evaluate(() => {
      const tab = document.querySelector('.tab-btn[data-tab="conversations"]');
      return !!(tab && tab.classList.contains('active'));
    });
    inboxActive ? ok('switched to Inbox tab') : bad('Inbox tab not active');
  } else {
    bad('booking row visible after reload');
  }

  const unpaidStat = await page.evaluate(() => document.getElementById('ps-unpaid-pending-today')?.textContent?.trim());
  unpaidStat && unpaidStat !== '…' ? ok('unpaid top card count', unpaidStat) : bad('unpaid top card count');

  await browser.close();
  console.log(`\nCalm/i18n/conversation smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
