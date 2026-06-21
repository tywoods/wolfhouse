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
  const bad = (l, d) => { track(l, false, d); fail++; };

  await page.goto(`${BASE}/staff/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#client', 'sunset');
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('#btn-signin');
  await page.waitForFunction(() => !window.location.pathname.includes('/staff/login'), { timeout: 45000 });
  await page.waitForTimeout(4000);

  const guestName = `Drawer Pay ${crypto.randomBytes(3).toString('hex')}`;
  const phone = '+34600' + String(Math.floor(Math.random() * 900000) + 100000);
  const today = new Date().toISOString().slice(0, 10);

  await page.click('#ps-create-booking');
  await page.waitForTimeout(400);
  await page.fill('#ps-create-guest', guestName);
  await page.fill('#ps-create-phone', phone);
  await page.evaluate(() => {
    ['ps-create-comp-lesson', 'ps-create-comp-surfboard', 'ps-create-comp-wetsuit'].forEach((id) => {
      const n = document.getElementById(id);
      if (n) { n.checked = true; n.dispatchEvent(new Event('change', { bubbles: true })); }
    });
  });
  await page.fill('#ps-create-lesson-qty', '1');
  await page.fill('#ps-create-board-qty', '2');
  await page.fill('#ps-create-wetsuit-qty', '1');
  await page.fill('#ps-create-date-from', today);
  await page.fill('#ps-create-date-to', today);
  await page.selectOption('#ps-create-payment', 'unpaid');
  await page.click('#ps-create-submit');
  await page.waitForTimeout(4500);
  await page.evaluate(function(){
    var close = document.getElementById('ps-drawer-close');
    if (close) close.click();
    var modal = document.getElementById('ps-create-modal');
    if (modal) modal.style.display = 'none';
    var backdrop = document.getElementById('ps-drawer-backdrop');
    if (backdrop) backdrop.style.display = 'none';
    var drawer = document.getElementById('ps-detail-drawer');
    if (drawer) drawer.style.display = 'none';
  });
  await page.waitForTimeout(500);

  const row = page.locator('.portal-schedule-ops-row', { hasText: guestName }).first();
  if (!(await row.count())) { bad('booking row on ops board', guestName); await browser.close(); process.exit(1); }
  ok('booking created on schedule', guestName);
  await row.click();
  await page.waitForTimeout(1500);

  const drawerHtml = await page.locator('#ps-drawer-body').innerHTML();
  drawerHtml.includes('ps-drawer-guest') ? ok('drawer editable guest field') : bad('drawer editable guest field');
  drawerHtml.includes('ps-drawer-payment-box') ? ok('drawer payment section') : bad('drawer payment section');
  drawerHtml.includes('Subtotal') || drawerHtml.includes('Subtotal') ? ok('drawer subtotal label') : bad('drawer subtotal');
  drawerHtml.includes('Remaining') || drawerHtml.includes('Pendiente') ? ok('drawer remaining label') : bad('drawer remaining');

  const subtotalBefore = await page.locator('#ps-drawer-subtotal').innerText().catch(() => '');
  ok('subtotal before edit', subtotalBefore);

  await page.fill('#ps-drawer-board-qty', '3');
  await page.click('#ps-drawer-save');
  await page.waitForTimeout(3500);
  const subtotalAfter = await page.locator('#ps-drawer-subtotal').innerText().catch(() => '');
  subtotalAfter && subtotalAfter !== subtotalBefore ? ok('totals updated after board qty save', `${subtotalBefore} -> ${subtotalAfter}`) : bad('totals updated after save', `${subtotalBefore} -> ${subtotalAfter}`);

  const stripeBtn = page.locator('#ps-drawer-stripe-link');
  if (!(await stripeBtn.count())) bad('create test stripe link button');
  else if (await stripeBtn.isDisabled()) ok('stripe button disabled when env missing', 'graceful');
  else {
    ok('stripe button enabled');
    await stripeBtn.click();
    await page.waitForTimeout(6000);
    const bodyText = await page.locator('#ps-drawer-body').innerText();
    const hasLink = /https:\/\/checkout\.stripe\.com\//.test(bodyText);
    hasLink ? ok('stripe checkout url in drawer') : bad('stripe checkout url', bodyText.slice(0, 300));
    (await page.locator('#ps-drawer-stripe-copy').count()) ? ok('stripe copy button') : bad('stripe copy button');
    (await page.locator('#ps-drawer-stripe-open').count()) ? ok('stripe open button') : bad('stripe open button');
    bodyText.includes('Nothing was sent') || bodyText.includes('No se envió') || !bodyText.includes('sent to guest via') ? ok('no auto guest send in UI') : bad('auto send copy');
    await page.click('#ps-drawer-close');
    await page.waitForTimeout(400);
    await row.click({ force: true });
    await page.waitForTimeout(1200);
    const afterReload = await page.locator('#ps-drawer-body').innerText();
    /https:\/\/checkout\.stripe\.com\//.test(afterReload) ? ok('stripe link persists after reload') : bad('stripe link after reload');
    await page.fill('#ps-drawer-board-qty', '4');
    await page.click('#ps-drawer-save');
    await page.waitForTimeout(2500);
    const staleText = await page.locator('#ps-drawer-body').innerText();
    staleText.includes('Outdated') || staleText.includes('desactualizado') ? ok('stale link warning after edit') : bad('stale link warning', staleText.slice(0, 250));
  }

  const convBtn = page.locator('#ps-drawer-conversation-btn');
  (await convBtn.count()) ? ok('conversation action present') : bad('conversation action');
  if (await convBtn.count() && !(await convBtn.isDisabled())) {
    await convBtn.click();
    await page.waitForTimeout(2500);
    const onInbox = await page.evaluate(() => {
      const tabBtn = document.querySelector('.tab-btn[data-tab="conversations"]');
      const panel = document.getElementById('tab-conversations');
      return !!(tabBtn && tabBtn.classList.contains('active'))
        || !!(panel && panel.classList.contains('is-active'));
    });
    onInbox ? ok('conversation opens inbox context') : bad('inbox context after conversation click');
  }

  await browser.close();
  console.log(`\nDrawer payments smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
