#!/usr/bin/env node
'use strict';

/**
 * SUNSET-MOBILE-INBOX-ICON-ONLY-STICKY-NO-GUEST-CARD-001
 * Phone Inbox: icon-only filter rail, sticky Chats|Guests + icons, no guest
 * card on Chats thread (messages load). Desktop ≥901 untouched.
 *
 *   node scripts/verify-sunset-mobile-inbox-icon-only-sticky-no-guest-card-001.js
 */

const fs = require('fs');
const path = require('path');
const {
  buildPortalHtml,
  startFixtureServer,
  loadPlaywright,
  SETTLE_MS,
} = require('./verify-inbox-columns-playwright');

const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'scripts/browser/inbox-shell.js'), 'utf8');
const views = fs.readFileSync(path.join(root, 'scripts/browser/inbox-views.js'), 'utf8');

let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log('ok -', label);
    return;
  }
  failed += 1;
  console.error('FAIL -', label, detail || '');
}

const phoneBlock = api.slice(api.indexOf('staff-portal-mobile:inbox-chrome'));
ok('phone chrome marker exists', phoneBlock.includes('SUNSET-MOBILE-INBOX-ICON-ONLY-STICKY-NO-GUEST-CARD-001'));
ok(
  'phone filter labels are sr-only / clipped',
  phoneBlock.includes('inbox-views-item-label') && phoneBlock.includes('clip:rect(0,0,0,0)')
);
ok(
  'phone filter counts are badge-positioned',
  phoneBlock.includes('.inbox-views-item-count{') && phoneBlock.includes('position:absolute;top:4px;right:4px')
);
ok(
  'phone filter rail does not sideways-scroll',
  phoneBlock.includes('overflow-x:hidden') &&
    !/staff-portal-mobile:inbox-chrome[\s\S]{0,1200}\.inbox-views-rail\{[^}]*overflow-x:auto/.test(api)
);
ok(
  'views buttons expose aria-label and title',
  views.includes("aria-label=\"' + escHtml(label) + '\"") &&
    views.includes("title=\"' + escHtml(label) + '\"")
);
ok(
  'Chats|Guests remain text tabs (not icon-replaced)',
  !api.includes('inbox-folder-tab-ico') &&
    api.includes('data-i18n="inbox.layout.folder.chats"') &&
    phoneBlock.includes('font-size:15px')
);
ok(
  'sticky tabs+icon chrome is present',
  phoneBlock.includes('position:sticky') && phoneBlock.includes('z-index:40')
);
ok(
  'thread open keeps col1 above conv-detail (order fix)',
  phoneBlock.includes('show-thread > #conv-detail') &&
    phoneBlock.includes('order:2') &&
    shell.includes("show-thread > #conv-detail{order:2")
);
ok(
  'Chats thread hides guest card',
  phoneBlock.includes('body:not(:has([data-inbox-preset="guest"][aria-pressed="true"]))') &&
    phoneBlock.includes('.inbox-guest-card{') &&
    phoneBlock.includes('display:none!important') &&
    shell.includes('show-thread .inbox-guest-card{display:none!important}')
);
ok(
  'Guest tab still owns the guest card',
  phoneBlock.includes('data-inbox-preset="guest"') &&
    phoneBlock.includes('#inbox-detail-sidebar') &&
    /guest"\]\[aria-pressed="true"\][\s\S]{0,200}display:flex!important/.test(phoneBlock)
);
ok(
  'thread keeps icon filter rail with tabs',
  phoneBlock.includes(':not(.inbox-folder-tabs):not(.inbox-views-rail)') &&
    shell.includes(':not(.inbox-folder-tabs):not(.inbox-views-rail)')
);
ok(
  'desktop 901 guest block was not rewritten',
  api.includes('@media(min-width:901px){') &&
    api.includes('.inbox-two-col.inbox-shell-cols[data-col4="hidden"] .detail-sidebar{display:none}')
);
ok(
  'one-card tabs-over-icons radii from #1138 remain',
  phoneBlock.includes('border-radius:10px 10px 0 0') &&
    phoneBlock.includes('border-radius:0 0 10px 10px')
);

async function measurePhone(page, tenant) {
  await page.evaluate((name) => {
    window.switchToTab('conversations');
    if (name === 'sunset') document.documentElement.setAttribute('data-portal-client', 'sunset');
    else document.documentElement.removeAttribute('data-portal-client');
    if (window.__inboxColumns && typeof window.__inboxColumns.init === 'function') {
      window.__inboxColumns.init();
    }
    const rail = document.getElementById('inbox-views-rail');
    if (rail) {
      rail.innerHTML = [
        '<button type="button" class="inbox-views-item is-active" data-inbox-view="all" aria-label="All" title="All">',
        '<span class="inbox-views-item-ico" aria-hidden="true"><svg viewBox="0 0 24 24"></svg></span>',
        '<span class="inbox-views-item-label">All</span>',
        '<span class="inbox-views-item-count">4</span>',
        '</button>',
        '<button type="button" class="inbox-views-item" data-inbox-view="whatsapp" aria-label="WhatsApp" title="WhatsApp">',
        '<span class="inbox-views-item-ico" aria-hidden="true"><svg viewBox="0 0 24 24"></svg></span>',
        '<span class="inbox-views-item-label">WhatsApp</span>',
        '<span class="inbox-views-item-count">2</span>',
        '</button>',
        '<button type="button" class="inbox-views-item" data-inbox-view="email" aria-label="Email" title="Email">',
        '<span class="inbox-views-item-ico" aria-hidden="true"><svg viewBox="0 0 24 24"></svg></span>',
        '<span class="inbox-views-item-label">Email</span>',
        '<span class="inbox-views-item-count">1</span>',
        '</button>',
      ].join('');
    }
    const list = document.getElementById('conv-list');
    if (list && !list.querySelector('.conv-card')) {
      list.innerHTML = '<div class="conv-card inbox-row selected" data-id="fixture-1"><div class="conv-card-name">Tyler Woods</div></div>';
    }
  }, tenant);
  await page.waitForTimeout(SETTLE_MS);

  const listMetrics = await page.evaluate(() => {
    const label = document.querySelector('#inbox-views-rail .inbox-views-item-label');
    const count = document.querySelector('#inbox-views-rail .inbox-views-item-count');
    const btn = document.querySelector('#inbox-views-rail .inbox-views-item');
    const tabs = document.querySelector('.inbox-folder-tabs');
    const rail = document.getElementById('inbox-views-rail');
    const col1 = document.getElementById('inbox-col1');
    const chats = document.querySelector('.inbox-folder-tab[data-view="full"]');
    const labelStyle = label ? getComputedStyle(label) : null;
    const countStyle = count ? getComputedStyle(count) : null;
    const clipHidden = !!(labelStyle && (
      labelStyle.clip === 'rect(0px, 0px, 0px, 0px)' ||
      labelStyle.clipPath === 'rect(0px 0px 0px 0px)' ||
      (labelStyle.position === 'absolute' && labelStyle.width === '1px' && labelStyle.height === '1px')
    ));
    return {
      labelHidden: clipHidden || (label && label.offsetParent === null && getComputedStyle(label).position === 'absolute'),
      labelText: label ? label.textContent : '',
      countAbsolute: countStyle ? countStyle.position === 'absolute' : false,
      aria: btn ? btn.getAttribute('aria-label') : null,
      title: btn ? btn.getAttribute('title') : null,
      railScroll: rail ? rail.scrollWidth > rail.clientWidth + 2 : true,
      stickyCol1: col1 ? getComputedStyle(col1).position === 'sticky' : false,
      chatsFont: chats ? parseFloat(getComputedStyle(chats).fontSize) : 0,
      tabsText: chats ? (chats.textContent || '').trim() : '',
      tabsBottom: tabs ? Math.round(tabs.getBoundingClientRect().bottom) : 0,
      railTop: rail ? Math.round(rail.getBoundingClientRect().top) : 0,
    };
  });

  await page.evaluate(() => {
    const shellEl = document.getElementById('inbox-shell');
    if (shellEl) shellEl.classList.add('show-thread');
    const detail = document.getElementById('detail-content');
    if (detail) {
      detail.innerHTML = [
        '<div class="detail-header"><div class="detail-header-main"><div class="detail-name">Tyler Woods</div></div></div>',
        '<div class="detail-layout">',
        '<div class="detail-main"><div class="thread-section"><div class="thread"><div class="thread-messages">',
        '<div class="msg inbound">Hello from email thread</div>',
        '</div></div></div></div>',
        '<aside class="detail-sidebar" id="inbox-detail-sidebar">',
        '<div class="inbox-guest-card" id="inbox-guest-card"><div>No guest yet</div>',
        '<button type="button">Create guest from this email</button></div>',
        '</aside>',
        '</div>',
      ].join('');
    }
  });
  await page.waitForTimeout(SETTLE_MS);

  const threadMetrics = await page.evaluate(() => {
    const guest = document.querySelector('.inbox-guest-card');
    const sidebar = document.getElementById('inbox-detail-sidebar');
    const msg = document.querySelector('.thread-messages .msg');
    const col1 = document.getElementById('inbox-col1');
    const detail = document.getElementById('conv-detail');
    const rail = document.getElementById('inbox-views-rail');
    const tabs = document.querySelector('.inbox-folder-tabs');
    const guestHidden = !guest || getComputedStyle(guest).display === 'none' ||
      (sidebar && getComputedStyle(sidebar).display === 'none');
    const msgVisible = !!(msg && getComputedStyle(msg).display !== 'none' && msg.getBoundingClientRect().height > 0);
    return {
      guestHidden,
      msgVisible,
      msgText: msg ? msg.textContent : '',
      col1Top: col1 ? Math.round(col1.getBoundingClientRect().top) : -1,
      detailTop: detail ? Math.round(detail.getBoundingClientRect().top) : -1,
      railDisplay: rail ? getComputedStyle(rail).display : 'none',
      tabsDisplay: tabs ? getComputedStyle(tabs).display : 'none',
      orderOk: col1 && detail
        ? col1.getBoundingClientRect().bottom <= detail.getBoundingClientRect().top + 2
        : false,
    };
  });

  return { listMetrics, threadMetrics };
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    ok('playwright available', false, 'playwright missing — static checks only');
    console.log(
      failed
        ? `verify:sunset-mobile-inbox-icon-only-sticky-no-guest-card-001 FAILED (${failed})`
        : 'verify:sunset-mobile-inbox-icon-only-sticky-no-guest-card-001 passed'
    );
    process.exit(failed ? 1 : 0);
  }

  const { server, base } = await startFixtureServer(buildPortalHtml());
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    for (const tenant of ['sunset', 'wolfhouse']) {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof window.switchToTab === 'function');
      const { listMetrics, threadMetrics } = await measurePhone(page, tenant);

      ok(
        `${tenant} phone filter labels are not visible text`,
        listMetrics.labelHidden === true && listMetrics.chatsFont >= 14,
        JSON.stringify(listMetrics)
      );
      ok(
        `${tenant} phone filter counts badge on icons`,
        listMetrics.countAbsolute === true,
        JSON.stringify(listMetrics)
      );
      ok(
        `${tenant} phone filter has aria-label`,
        !!(listMetrics.aria && listMetrics.aria.length > 0 && listMetrics.title && listMetrics.title.length > 0),
        JSON.stringify(listMetrics)
      );
      ok(
        `${tenant} phone filter rail does not sideways-scroll`,
        listMetrics.railScroll === false,
        JSON.stringify(listMetrics)
      );
      ok(
        `${tenant} phone chrome is sticky`,
        listMetrics.stickyCol1 === true,
        JSON.stringify(listMetrics)
      );
      ok(
        `${tenant} Chats tab stays text`,
        listMetrics.tabsText.indexOf('Chats') >= 0,
        JSON.stringify(listMetrics)
      );
      ok(
        `${tenant} Chats thread hides guest card and shows messages`,
        threadMetrics.guestHidden === true && threadMetrics.msgVisible === true,
        JSON.stringify(threadMetrics)
      );
      ok(
        `${tenant} sticky chrome stays above thread`,
        threadMetrics.orderOk === true && threadMetrics.tabsDisplay !== 'none',
        JSON.stringify(threadMetrics)
      );
      ok(
        `${tenant} icon rail remains on open thread`,
        threadMetrics.railDisplay !== 'none',
        JSON.stringify(threadMetrics)
      );
      await page.close();
    }

    const desk = await browser.newPage();
    await desk.setViewportSize({ width: 1280, height: 800 });
    await desk.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
    await desk.waitForFunction(() => typeof window.switchToTab === 'function');
    await desk.evaluate(() => {
      document.documentElement.setAttribute('data-portal-client', 'sunset');
      window.switchToTab('conversations');
      const rail = document.getElementById('inbox-views-rail');
      if (rail) {
        rail.innerHTML = [
          '<button type="button" class="inbox-views-item is-active" data-inbox-view="all" aria-label="All" title="All">',
          '<span class="inbox-views-item-label">All</span>',
          '<span class="inbox-views-item-count">4</span>',
          '</button>',
        ].join('');
      }
    });
    await desk.waitForTimeout(SETTLE_MS);
    const desktop = await desk.evaluate(() => {
      const label = document.querySelector('#inbox-views-rail .inbox-views-item-label');
      const col1 = document.getElementById('inbox-col1');
      const style = label ? getComputedStyle(label) : null;
      return {
        labelVisible: !!(label && style && style.position !== 'absolute' && style.width !== '1px'),
        sticky: col1 ? getComputedStyle(col1).position : null,
        fontSize: label ? parseFloat(style.fontSize) : 0,
      };
    });
    ok(
      'desktop ≥901 keeps visible filter labels (not phone icon-only)',
      desktop.labelVisible === true && desktop.sticky !== 'sticky',
      JSON.stringify(desktop)
    );
    await desk.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(
    failed
      ? `verify:sunset-mobile-inbox-icon-only-sticky-no-guest-card-001 FAILED (${failed})`
      : 'verify:sunset-mobile-inbox-icon-only-sticky-no-guest-card-001 passed'
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
