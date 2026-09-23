#!/usr/bin/env node
'use strict';

/**
 * SUNSET-NEW-BOOKING-POLISH-001
 * New booking panel: no Create New Booking banner, Block sits next to the pin,
 * bed chips show the bed id only.
 *
 *   node scripts/verify-sunset-new-booking-polish-001.js
 */

const fs = require('fs');
const path = require('path');
const {
  buildPortalHtml,
  startFixtureServer,
  loadPlaywright,
} = require('./verify-inbox-columns-playwright');

const root = path.join(__dirname, '..');
const proofDir = process.env.NEW_BOOKING_PROOF_DIR
  || path.join(root, 'tmp', 'sunset-new-booking-polish-001');
const api = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');

let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log('ok -', label);
    return;
  }
  failed += 1;
  console.error('FAIL -', label, detail || '');
}

ok('banner hide rule exists', api.includes('#bc-sel-panel .bc-sel-title{display:none!important}'));
ok('block moves next to the pin', api.includes('function bcPlaceBlockNextToPin') && api.includes('actions.insertBefore(btn, pin)'));
ok('block action id is unchanged', api.includes('id="bc-sel-block"') && api.includes("_blockBtn.onclick = runCalendarBedBlock"));
ok(
  'selected stay and guest hints use the bed id only',
  api.includes("escHtml(bcBedIdLabel(b))") &&
    api.includes("escHtml(bcBedIdLabel(bed))") &&
    !api.includes("b.room_code) + '&thinsp;/&thinsp;' + escHtml(b.bed_code)") &&
    !api.includes("bed.room_code + '/' + bed.bed_code")
);

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    ok('playwright available', false, 'playwright missing — static checks only');
    process.exit(failed ? 1 : 0);
  }
  fs.mkdirSync(proofDir, { recursive: true });
  const { server, base } = await startFixtureServer(buildPortalHtml());
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
    await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.switchToTab === 'function' && typeof window.bcDockCreatePanel === 'function');
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-portal-client', 'sunset');
      window.switchToTab('bed-calendar');
      const cin = document.getElementById('bc-sel-cin');
      const cout = document.getElementById('bc-sel-cout');
      if (cin) cin.value = '2026-09-24';
      if (cout) cout.value = '2026-09-26';
      window.bcDockCreatePanel();
      const list = document.getElementById('bc-sel-beds-list');
      const bed = { room_code: 'R8', bed_code: 'R8-B2' };
      if (list) {
        list.innerHTML = '<span class="bc-sel-bed-tag">' + window.bcBedIdLabel(bed) + '</span>';
      }
    });
    await page.waitForTimeout(300);
    const measured = await page.evaluate(() => {
      const title = document.querySelector('#bc-sel-panel .bc-sel-title');
      const block = document.getElementById('bc-sel-block');
      const pin = document.getElementById('bc-side-pin');
      const chip = document.querySelector('#bc-sel-beds-list .bc-sel-bed-tag');
      const titleStyle = title ? getComputedStyle(title) : null;
      const blockBox = block ? block.getBoundingClientRect() : null;
      const pinBox = pin ? pin.getBoundingClientRect() : null;
      return {
        titleDisplay: titleStyle ? titleStyle.display : 'missing',
        titleText: title ? (title.textContent || '').trim() : '',
        blockParent: block && block.parentElement ? block.parentElement.className : '',
        blockBeforePin: !!(block && pin && block.nextElementSibling === pin),
        blockW: blockBox ? Math.round(blockBox.width) : 0,
        blockH: blockBox ? Math.round(blockBox.height) : 0,
        pinW: pinBox ? Math.round(pinBox.width) : 0,
        sameRow: !!(blockBox && pinBox && Math.abs(blockBox.top - pinBox.top) < 8),
        chip: chip ? (chip.textContent || '').trim() : '',
        drawerOpen: document.getElementById('bc-side-drawer').classList.contains('is-open'),
      };
    });
    const drawer = page.locator('#bc-side-drawer');
    await drawer.screenshot({ path: path.join(proofDir, 'new-booking-drawer.png') });
    ok('drawer opens the new booking panel', measured.drawerOpen === true, JSON.stringify(measured));
    ok('Create New Booking banner is hidden', measured.titleDisplay === 'none', JSON.stringify(measured));
    ok(
      'Block sits next to the pin and stays tappable',
      measured.blockBeforePin === true && measured.sameRow === true &&
        measured.blockW > 20 && measured.blockH > 20 && measured.pinW > 20,
      JSON.stringify(measured)
    );
    ok('bed chip shows R8-B2, not R8 / R8-B2', measured.chip === 'R8-B2', JSON.stringify(measured));
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await phone.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
    await phone.waitForFunction(() => typeof window.switchToTab === 'function' && typeof window.bcDockCreatePanel === 'function');
    await phone.evaluate(() => {
      document.documentElement.setAttribute('data-portal-client', 'sunset');
      window.switchToTab('bed-calendar');
      const panel = document.getElementById('bc-sel-panel');
      if (panel) panel.style.display = 'block';
      window.bcDockCreatePanel();
      const list = document.getElementById('bc-sel-beds-list');
      const bed = { room_code: 'R8', bed_code: 'R8-B2' };
      if (list) list.innerHTML = '<span class="bc-sel-bed-tag">' + window.bcBedIdLabel(bed) + '</span>';
    });
    await phone.waitForTimeout(200);
    const phoneMeasured = await phone.evaluate(() => {
      const title = document.querySelector('#bc-sel-panel .bc-sel-title');
      const block = document.getElementById('bc-sel-block');
      const chip = document.querySelector('#bc-sel-beds-list .bc-sel-bed-tag');
      const titleStyle = title ? getComputedStyle(title) : null;
      const blockStyle = block ? getComputedStyle(block) : null;
      const blockBox = block ? block.getBoundingClientRect() : null;
      const drawer = document.getElementById('bc-side-drawer');
      return {
        titleDisplay: titleStyle ? titleStyle.display : 'missing',
        blockParent: block && block.parentElement ? block.parentElement.className : '',
        inDrawer: !!(block && drawer && drawer.contains(block)),
        blockDisplay: blockStyle ? blockStyle.display : 'missing',
        blockW: blockBox ? Math.round(blockBox.width) : 0,
        blockH: blockBox ? Math.round(blockBox.height) : 0,
        chip: chip ? (chip.textContent || '').trim() : '',
      };
    });
    await phone.locator('#bc-sel-panel').screenshot({ path: path.join(proofDir, 'new-booking-phone.png') });
    ok(
      'phone hides the banner and keeps Block on the form',
      phoneMeasured.titleDisplay === 'none' &&
        phoneMeasured.blockParent.indexOf('bc-sel-header-row') !== -1 &&
        phoneMeasured.inDrawer === false &&
        phoneMeasured.blockDisplay !== 'none' &&
        phoneMeasured.blockW > 20 &&
        phoneMeasured.blockH > 16 &&
        phoneMeasured.chip === 'R8-B2',
      JSON.stringify(phoneMeasured)
    );
    console.log('proof', proofDir);
    await page.close();
    await phone.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log(failed
    ? `verify:sunset-new-booking-polish-001 FAILED (${failed})`
    : 'verify:sunset-new-booking-polish-001 passed');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
