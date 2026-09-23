#!/usr/bin/env node
'use strict';

/**
 * SUNSET-MOBILE-TABS-OVER-ICONS-CARD-001
 * Phone keeps Chats|Guests as text tabs. Icon filters sit under them on the
 * same card. Tabs are not replaced by icons.
 *
 *   node scripts/verify-sunset-mobile-tabs-over-icons-card-001.js
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
ok('phone card marker exists', phoneBlock.includes('SUNSET-MOBILE-TABS-OVER-ICONS-CARD-001'));
ok('sunset and wolfhouse card rules are separate',
  phoneBlock.includes('html[data-portal-client="sunset"] #inbox-col1{gap:0}')
  && phoneBlock.includes('html:not([data-portal-client]) #inbox-col1{gap:0}')
  && !/html\[data-portal-client="sunset"\],\s*html:not/.test(phoneBlock));
ok('text tabs stay a thumb target', phoneBlock.includes('min-height:44px') && phoneBlock.includes('font-size:15px'));
ok('tabs are not replaced by icons',
  !api.includes('inbox-folder-tab-ico')
  && !/\.inbox-folder-tab[^}]*font-size:\s*0/.test(phoneBlock)
  && !/\.inbox-folder-tabs[^}]*font-size:\s*0/.test(phoneBlock)
  && api.includes('data-i18n="inbox.layout.folder.chats"'));
ok('desktop folder chrome was not rewritten',
  /html\[data-portal-client="sunset"\] \.inbox-col1 > \.inbox-folder-tabs\{[^}]*margin:0 0 -11px/.test(api));
ok('shell stacks the text tabs over the icon rail',
  shell.includes('border-radius:10px 10px 0 0')
  && shell.includes('border-radius:0 0 10px 10px'));

async function measure(page, tenant) {
  await page.evaluate((name) => {
    window.switchToTab('conversations');
    if (name === 'sunset') document.documentElement.setAttribute('data-portal-client', 'sunset');
    else document.documentElement.removeAttribute('data-portal-client');
    if (window.__inboxColumns && typeof window.__inboxColumns.init === 'function') window.__inboxColumns.init();
    const rail = document.getElementById('inbox-views-rail');
    if (rail && !rail.querySelector('[data-inbox-view="all"]')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'inbox-views-item is-active';
      btn.setAttribute('data-inbox-view', 'all');
      btn.innerHTML = '<span class="inbox-views-item-label">All</span>';
      rail.appendChild(btn);
    }
  }, tenant);
  await page.waitForTimeout(SETTLE_MS);
  return page.evaluate(() => {
    const tabs = document.querySelector('.inbox-folder-tabs');
    const chats = document.querySelector('.inbox-folder-tab[data-view="full"]');
    const guests = document.querySelector('.inbox-folder-tab[data-view="guest"]');
    const filter = document.querySelector('#inbox-views-rail [data-inbox-view="all"]');
    const rail = document.getElementById('inbox-views-rail');
    const box = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        top: Math.round(b.top),
        bottom: Math.round(b.bottom),
        left: Math.round(b.left),
        right: Math.round(b.right),
        width: Math.round(b.width),
        height: Math.round(b.height),
      };
    };
    const label = chats ? chats.querySelector('[data-i18n]') : null;
    return {
      scrollWidth: document.documentElement.scrollWidth,
      parent: tabs && tabs.parentElement ? tabs.parentElement.id : null,
      chats: box(chats),
      guests: box(guests),
      filter: box(filter),
      rail: box(rail),
      tabs: box(tabs),
      fontSize: chats ? parseFloat(getComputedStyle(chats).fontSize) : 0,
      label: label ? label.textContent : '',
    };
  });
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    ok('playwright available', false, 'playwright missing');
    console.log(failed ? `verify:sunset-mobile-tabs-over-icons-card-001 FAILED (${failed})` : 'verify:sunset-mobile-tabs-over-icons-card-001 passed');
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
      const phone = await measure(page, tenant);
      ok(`${tenant} phone keeps text tabs above the icon rail`,
        phone.parent === 'inbox-col1'
        && phone.chats && phone.filter && phone.rail
        && phone.fontSize >= 14
        && phone.label && phone.label.length > 1
        && phone.filter.top >= phone.tabs.bottom - 2
        && Math.abs(phone.chats.top - phone.filter.top) > 8,
        JSON.stringify(phone));
      ok(`${tenant} phone is one card`,
        phone.tabs && phone.rail
        && Math.abs(phone.tabs.left - phone.rail.left) <= 2
        && Math.abs(phone.tabs.right - phone.rail.right) <= 2
        && Math.abs(phone.tabs.bottom - phone.rail.top) <= 2
        && phone.scrollWidth <= 391,
        JSON.stringify(phone));
      const guestsBox = phone.guests;
      if (guestsBox) {
        await page.mouse.click((guestsBox.left + guestsBox.right) / 2, (guestsBox.top + guestsBox.bottom) / 2);
      }
      try {
        await page.waitForFunction(() => {
          const btn = document.querySelector('.inbox-folder-tab[data-view="guest"]');
          return btn && btn.getAttribute('aria-pressed') === 'true';
        }, null, { timeout: 2000 });
      } catch (_wait) {}
      const guestOn = await page.evaluate(() => {
        const btn = document.querySelector('.inbox-folder-tab[data-view="guest"]');
        return btn ? btn.getAttribute('aria-pressed') : null;
      });
      ok(`${tenant} phone Guests text tab still switches`, guestOn === 'true', guestOn);
      await page.close();
    }

    const desk = await browser.newPage();
    await desk.setViewportSize({ width: 1280, height: 800 });
    await desk.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
    await desk.waitForFunction(() => typeof window.switchToTab === 'function');
    await desk.evaluate(() => {
      document.documentElement.setAttribute('data-portal-client', 'sunset');
      window.switchToTab('conversations');
    });
    await desk.waitForTimeout(SETTLE_MS);
    const desktop = await desk.evaluate(() => {
      const chats = document.querySelector('.inbox-folder-tab[data-view="full"]');
      return {
        fontSize: chats ? parseFloat(getComputedStyle(chats).fontSize) : 0,
        parent: document.querySelector('.inbox-folder-tabs').parentElement.id,
      };
    });
    ok('desktop text tabs were not turned into the phone card',
      desktop.parent === 'inbox-col1' && desktop.fontSize > 0 && desktop.fontSize < 15,
      JSON.stringify(desktop));
    await desk.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(failed ? `verify:sunset-mobile-tabs-over-icons-card-001 FAILED (${failed})` : 'verify:sunset-mobile-tabs-over-icons-card-001 passed');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
