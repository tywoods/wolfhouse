#!/usr/bin/env node
'use strict';

/**
 * SUNSET-MOBILE-AUTONOMY-BOTTOM-TAB-001
 * Phone chat: Chats stay at the top. The tall Autonomy card starts closed
 * behind a small green bottom tab. Header action chrome stays tappable.
 * Bookings expand is hidden on phone Chats (guest card off). The tab label
 * is the dictionary string (AUTONOMÍA LUNA in es), not hardcoded English.
 *
 *   node scripts/verify-sunset-mobile-autonomy-bottom-tab-001.js
 */

const fs = require('fs');
const path = require('path');
const {
  buildPortalHtml,
  startFixtureServer,
  loadPlaywright,
  CONV_ID,
  SETTLE_MS,
} = require('./verify-inbox-columns-playwright');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const root = path.join(__dirname, '..');
const proofDir = process.env.AUTONOMY_TAB_PROOF_DIR
  || path.join(root, 'tmp', 'sunset-mobile-autonomy-bottom-tab-001');
const api = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'scripts/browser/inbox-shell.js'), 'utf8');
const ES_TITLE = STAFF_PORTAL_STRINGS.es['inbox.channelControl.title'];

let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log('ok -', label);
    return;
  }
  failed += 1;
  console.error('FAIL -', label, detail || '');
}

const marker = 'SUNSET-MOBILE-AUTONOMY-BOTTOM-TAB-001';
const blockStart = api.indexOf(marker);
const phoneBlock = blockStart >= 0 ? api.slice(blockStart, blockStart + 42000) : '';
const phoneLayoutMarker = 'SHARED-PHONE-INBOX-HEADER-005';
const phoneLayoutStart = api.indexOf(phoneLayoutMarker);
const phoneLayoutCss = phoneLayoutStart >= 0 ? api.slice(Math.max(0, phoneLayoutStart - 4000), phoneLayoutStart + 8000) : '';

ok('marker exists in staff-query-api.js', blockStart >= 0);
ok('marker exists in inbox-shell CSS', shell.includes(marker));
ok(
  'phone chat keeps Chats at the top and adds a bottom Autonomy tab',
  phoneBlock.includes('order:1;grid-row:1;position:sticky!important') &&
    phoneBlock.includes('.inbox-autonomy-bottom-tab') &&
    phoneBlock.includes('max-height:44px')
);
ok(
  'phone chat keeps Autonomy closed until the bottom tab opens',
  phoneBlock.includes(':not(.is-autonomy-open)') &&
    phoneBlock.includes(':not(.inbox-autonomy-bottom-tab)') &&
    shell.includes('inboxShellToggleAutonomyPhoneTab')
);
ok(
  'phone chat keeps header chrome inside the clip',
  phoneLayoutCss.includes('SHARED-PHONE-INBOX-HEADER-005') &&
    phoneLayoutCss.includes('display:contents!important') &&
    phoneLayoutCss.includes('overflow-x:hidden') &&
    !phoneLayoutCss.includes('#inbox-header-luna-row{display:none') &&
    !/\.detail-header-right\{display:none/.test(phoneLayoutCss)
);
ok(
  'tab label comes from the dictionary, not hardcoded Autonomy',
  shell.includes("inboxShellT('inbox.channelControl.title', 'LUNA AUTONOMY')") &&
    !shell.includes("textContent = phoneChat ? 'Autonomy'") &&
    !shell.includes("label.textContent = 'Autonomy'")
);
ok(
  'sunset and wolfhouse rules are not comma-combined',
  phoneBlock.includes('html[data-portal-client="sunset"]') &&
    phoneBlock.includes('html:not([data-portal-client])') &&
    !/html\[data-portal-client="sunset"\],\s*html:not/.test(phoneBlock)
);
ok(
  'desktop 901 guest block was not rewritten',
  api.includes('@media(min-width:901px){') &&
    api.includes('.inbox-two-col.inbox-shell-cols[data-col4="hidden"] .detail-sidebar{display:none}')
);
ok('Spanish dictionary title is AUTONOMÍA LUNA', ES_TITLE === 'AUTONOMÍA LUNA');

function boxOf(sel) {
  const el = document.querySelector(sel);
  if (!el) return { missing: true, w: 0, h: 0, display: 'missing' };
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return {
    missing: false,
    w: Math.round(r.width),
    h: Math.round(r.height),
    display: s.display,
    text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
  };
}

async function measure(page) {
  return page.evaluate((expectedTitle) => {
    const chats = document.querySelector('.inbox-folder-tab[data-inbox-preset="all4"]');
    const rail = document.getElementById('inbox-views-rail');
    const autoTab = document.querySelector('#inbox-shell.show-thread > .is-inbox-mobile-docked .inbox-autonomy-bottom-tab');
    const autonomy = document.querySelector('#inbox-shell > .inbox-shell-channel-defaults.is-inbox-mobile-docked');
    const row = autonomy ? autonomy.querySelector('.channelModeRow') : null;
    const headerRight = document.querySelector('#conv-detail .detail-header-right, #inbox-shell .detail-header-right');
    const lunaRow = document.getElementById('inbox-header-luna-row');
    const chrome = document.getElementById('inbox-chat-chrome-slot');
    const expand = document.getElementById('inbox-sidebar-expand');
    const spam = document.getElementById('btn-inbox-spam');
    const clear = document.getElementById('btn-inbox-clear-thread');
    const channel = document.querySelector('#inbox-chat-chrome-slot .inbox-composer-channel, #inbox-shell .inbox-header-stack-channel');
    function box(el) {
      if (!el) return { missing: true, w: 0, h: 0, display: 'missing', text: '' };
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        missing: false,
        w: Math.round(r.width),
        h: Math.round(r.height),
        display: s.display,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      };
    }
    const tabBox = autoTab ? autoTab.getBoundingClientRect() : null;
    const rowBox = row ? row.getBoundingClientRect() : null;
    const chatsBox = chats ? chats.getBoundingClientRect() : null;
    const cardBox = autonomy ? autonomy.getBoundingClientRect() : null;
    return {
      chatsTop: chatsBox ? Math.round(chatsBox.top) : -1,
      chatsText: chats ? (chats.textContent || '').trim() : '',
      railDisplay: rail ? getComputedStyle(rail).display : 'none',
      tabText: autoTab ? (autoTab.textContent || '').replace(/\s+/g, ' ').trim() : '',
      tabW: tabBox ? Math.round(tabBox.width) : 0,
      tabH: tabBox ? Math.round(tabBox.height) : 0,
      tabTop: tabBox ? Math.round(tabBox.top) : -1,
      rowH: rowBox ? Math.round(rowBox.height) : 0,
      rowTop: rowBox ? Math.round(rowBox.top) : -1,
      rowDisplay: row ? getComputedStyle(row).display : 'missing',
      cardH: cardBox ? Math.round(cardBox.height) : 0,
      open: !!(autonomy && autonomy.classList.contains('is-autonomy-open')),
      headerRight: box(headerRight),
      lunaRow: box(lunaRow),
      chrome: box(chrome),
      expand: box(expand),
      spam: box(spam),
      clear: box(clear),
      channel: box(channel),
      expectedTitle,
      locale: document.documentElement.getAttribute('lang'),
    };
  }, ES_TITLE);
}

function chromeVisible(metrics) {
  /* Phone Chats hides bookings expand (guest card off). header-right is display:contents. */
  return ['lunaRow', 'chrome', 'spam', 'clear', 'channel'].every((key) => {
    const box = metrics[key];
    return box && !box.missing && box.display !== 'none' && box.w > 0 && box.h > 0;
  });
}

async function actionHit(page, sel) {
  return page.evaluate((selector) => {
    const btn = document.querySelector(selector);
    if (!btn) return { missing: true, selector };
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      missing: false,
      selector,
      left: Math.round(r.left),
      right: Math.round(r.right),
      top: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      cx,
      cy,
      hitId: hit ? (hit.id || hit.className || hit.tagName) : '',
      hitMatches: !!(hit && hit.closest && hit.closest(selector)),
      insideViewport: r.left >= -0.5 && r.right <= window.innerWidth + 0.5 && r.width > 0 && r.height > 0,
      display: getComputedStyle(btn).display,
    };
  }, sel);
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    ok('playwright available', false, 'playwright missing — static checks only');
    console.log(failed
      ? `verify:sunset-mobile-autonomy-bottom-tab-001 FAILED (${failed})`
      : 'verify:sunset-mobile-autonomy-bottom-tab-001 passed');
    process.exit(failed ? 1 : 0);
  }

  fs.mkdirSync(proofDir, { recursive: true });
  const { server, base } = await startFixtureServer(buildPortalHtml());
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      try { window.localStorage.setItem('wh_staff_portal_locale', 'es'); } catch (_e) { /* ignore */ }
    });
    await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.switchToTab === 'function');
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-portal-client', 'sunset');
      if (typeof window.setStaffLocale === 'function') window.setStaffLocale('es');
      window.switchToTab('conversations');
    });
    await page.waitForSelector(`#conv-list .conv-card[data-id="${CONV_ID}"]`, { timeout: 15000 });
    await page.evaluate((id) => {
      const card = document.querySelector(`#conv-list .conv-card[data-id="${id}"]`);
      if (card) card.click();
    }, CONV_ID);
    await page.waitForSelector('#inbox-shell.show-thread .detail-header-right', { timeout: 15000 });
    await page.evaluate(() => {
      if (typeof window.setStaffLocale === 'function') window.setStaffLocale('es');
      if (typeof window.inboxShellRefreshAutonomyLabel === 'function') window.inboxShellRefreshAutonomyLabel();
      if (typeof window.__syncInboxMobileOrder === 'function') window.__syncInboxMobileOrder();
    });
    await page.waitForTimeout(SETTLE_MS);
    const closed = await measure(page);
    await page.screenshot({ path: path.join(proofDir, 'closed-es-390.png') });

    ok(
      'es 390 closed: Chats stay at the top',
      closed.chatsTop >= 0 && closed.chatsTop < 180 && closed.chatsText.indexOf('Chat') >= 0 &&
        closed.railDisplay !== 'none',
      JSON.stringify(closed)
    );
    ok(
      'es 390 closed: tab uses AUTONOMÍA LUNA, not hardcoded Autonomy',
      closed.tabText === ES_TITLE && closed.tabText !== 'Autonomy' && closed.tabText.indexOf('autonom') < 0,
      JSON.stringify({ tabText: closed.tabText, expected: ES_TITLE })
    );
    ok(
      'es 390 closed: small bottom tab, tall card hidden',
      closed.open === false && closed.rowDisplay === 'none' && closed.cardH <= 48 &&
        closed.tabH >= 28 && closed.tabH <= 44 && closed.tabW >= 80 && closed.tabW <= 230,
      JSON.stringify(closed)
    );
    ok(
      'es 390 closed: header chrome is tappable',
      chromeVisible(closed) && closed.expand && closed.expand.display === 'none',
      JSON.stringify({
        headerRight: closed.headerRight,
        lunaRow: closed.lunaRow,
        chrome: closed.chrome,
        spam: closed.spam,
        clear: closed.clear,
        expand: closed.expand,
        channel: closed.channel,
      })
    );
    const closedSpam = await actionHit(page, '#btn-inbox-spam');
    const closedClear = await actionHit(page, '#btn-inbox-clear-thread');
    ok(
      'es 390 closed: Spam/Clear action chrome is hittable (bookings expand hidden on Chats)',
      closedSpam.hitMatches === true && closedSpam.insideViewport === true &&
        closedClear.hitMatches === true && closedClear.insideViewport === true,
      JSON.stringify({ closedSpam, closedClear })
    );

    const opened = await page.evaluate(() => {
      const label = document.querySelector('#inbox-shell.show-thread > .is-inbox-mobile-docked .inbox-autonomy-bottom-tab .channelAutonomyLabel');
      if (!label) return false;
      label.click();
      const card = document.querySelector('#inbox-shell.show-thread > .inbox-shell-channel-defaults.is-inbox-mobile-docked');
      return !!(card && card.classList.contains('is-autonomy-open'));
    });
    await page.waitForTimeout(SETTLE_MS);
    const open = await measure(page);
    await page.screenshot({ path: path.join(proofDir, 'open-es-390.png') });
    ok('es 390 tap opens Autonomy', opened === true && open.open === true, JSON.stringify(open));
    ok(
      'es 390 open: rows show above the tab and chrome stays visible',
      open.rowH >= 20 && open.rowDisplay !== 'none' && open.rowTop < open.tabTop &&
        open.tabText === ES_TITLE && chromeVisible(open) &&
        open.expand && open.expand.display === 'none',
      JSON.stringify(open)
    );
    const openSpam = await actionHit(page, '#btn-inbox-spam');
    const openLuna = await actionHit(page, '#inbox-chat-chrome-slot .inbox-luna-mode-btn, #inbox-header-luna-row .inbox-luna-mode-btn');
    ok(
      'es 390 open: Spam/Luna action chrome stays hittable (bookings expand hidden on Chats)',
      openSpam.hitMatches === true && openSpam.insideViewport === true &&
        openLuna.hitMatches === true && openLuna.insideViewport === true,
      JSON.stringify({ openSpam, openLuna })
    );
    console.log('proof', proofDir);
    await page.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(failed
    ? `verify:sunset-mobile-autonomy-bottom-tab-001 FAILED (${failed})`
    : 'verify:sunset-mobile-autonomy-bottom-tab-001 passed');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
