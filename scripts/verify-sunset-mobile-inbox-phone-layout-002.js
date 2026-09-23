#!/usr/bin/env node
'use strict';

/**
 * SUNSET-MOBILE-INBOX-PHONE-LAYOUT-002
 * Phone Inbox (~390px): Autonomy docked to viewport bottom + safe-area;
 * default CLOSED on list and chat (slim bottom tab only until opened);
 * lock is panel content (own pill), never on the slim dock title;
 * Chats|Guests as classic folder tabs; search pinned with padding under filters;
 * name+tag | WA/Email on one row; action row (← Spam Clear Delete refresh Luna);
 * taller transcript.
 *
 *   node scripts/verify-sunset-mobile-inbox-phone-layout-002.js
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

const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'scripts/browser/inbox-shell.js'), 'utf8');
const rows = fs.readFileSync(path.join(root, 'scripts/browser/inbox-rows.js'), 'utf8');

let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log('ok -', label);
    return;
  }
  failed += 1;
  console.error('FAIL -', label, detail || '');
}

const marker = 'SUNSET-MOBILE-INBOX-PHONE-LAYOUT-002 — phone Inbox';
const blockStart = api.indexOf(marker);
const phoneBlock = blockStart >= 0 ? api.slice(blockStart, blockStart + 28000) : '';
const phoneEnd = phoneBlock.indexOf('/* ── Top-bar layout controls');
const phoneCss = phoneEnd > 0 ? phoneBlock.slice(0, phoneEnd) : phoneBlock;

ok('marker exists in staff-query-api.js', api.includes('SUNSET-MOBILE-INBOX-PHONE-LAYOUT-002') && blockStart >= 0);
ok('marker exists in inbox-shell CSS', shell.includes('SUNSET-MOBILE-INBOX-PHONE-LAYOUT-002'));
ok('marker exists in inbox-rows chrome CSS', rows.includes('SUNSET-MOBILE-INBOX-PHONE-LAYOUT-002'));
ok(
  'Autonomy docks with position:fixed + safe-area',
  phoneCss.includes('position:fixed!important') &&
    phoneCss.includes('bottom:0') &&
    phoneCss.includes('env(safe-area-inset-bottom')
);
ok(
  'list pins search under filters and scrolls the list',
  phoneCss.includes('inbox-conv-search-wrap.is-inbox-mobile-order') &&
    phoneCss.includes('grid-template-rows:auto auto minmax(0,1fr)!important') &&
    phoneCss.includes('.inbox-left-rows') &&
    phoneCss.includes('overflow-y:auto!important')
);
ok(
  'search has vertical padding gap before the chat list',
  phoneCss.includes('SHARED-PHONE-INBOX-SEARCH-004') &&
    /inbox-conv-search-wrap\.is-inbox-mobile-order\{[^}]*margin:0 0 14px!important/.test(phoneCss)
);
ok(
  'Chats|Guests use classic folder tabs (not fat segmented buttons)',
  phoneCss.includes('SHARED-PHONE-INBOX-FOLDER-TABS-004') &&
    phoneCss.includes('border-radius:10px 10px 0 0') &&
    phoneCss.includes('align-items:flex-end') &&
    phoneCss.includes('border-bottom:none') &&
    !/SHARED-PHONE-INBOX-FOLDER-TABS-004[\s\S]*padding:2px/.test(phoneCss.slice(phoneCss.indexOf('SHARED-PHONE-INBOX-FOLDER-TABS-004')))
);
ok(
  'Autonomy lock is panel pill, not dock title',
  (() => {
    const fn = shell.slice(
      shell.indexOf('function inboxShellChannelDefaultsHtml'),
      shell.indexOf('function inboxShellChannelDefaultsHtml') + 1200
    );
    const headAt = fn.indexOf('channelAutonomyHead');
    const toolbarAt = fn.indexOf('channelAutonomyToolbar');
    const lockAt = fn.indexOf('id="inbox-autonomy-lock"');
    return (
      fn.includes('channelAutonomyLockLabel') &&
      headAt >= 0 &&
      toolbarAt > headAt &&
      lockAt > toolbarAt
    );
  })()
);
ok(
  'phone CSS hides lock on slim Autonomy tab',
  phoneCss.includes('.inbox-autonomy-bottom-tab .channelAutonomyLock') &&
    phoneCss.includes('channelAutonomyToolbar')
);
ok(
  'slim quiet back control',
  phoneCss.includes('.inbox-mobile-back') &&
    phoneCss.includes('min-height:28px') &&
    phoneCss.includes('background:transparent') &&
    phoneCss.includes('width:max-content')
);
ok(
  'taller transcript via flex fill (no oversized min overlap)',
  phoneCss.includes('.thread-messages') &&
    phoneCss.includes('flex:1 1 auto!important') &&
    phoneCss.includes('min-height:0!important') &&
    phoneCss.includes('.draft-actions') &&
    phoneCss.includes('flex-wrap:nowrap')
);
ok(
  'sunset and wolfhouse Autonomy dock rules are not comma-combined',
  phoneCss.includes('html[data-portal-client="sunset"]') &&
    phoneCss.includes('html:not([data-portal-client])') &&
    !/html\[data-portal-client="sunset"\]\s*,\s*html:not/.test(phoneCss)
);
ok(
  'SHARED-PHONE-INBOX-AUTONOMY-003 tenant-agnostic closed hide exists',
  phoneCss.includes('SHARED-PHONE-INBOX-AUTONOMY-003') &&
    /#tab-conversations #inbox-shell:not\(\.show-thread\) > \.is-inbox-mobile-docked:not\(\.is-autonomy-open\) > :not\(\.inbox-autonomy-bottom-tab\)/.test(
      phoneCss
    ) &&
    shell.includes('SHARED-PHONE-INBOX-AUTONOMY-003')
);
ok(
  'list closed Autonomy hides panel content (slim tab only)',
  phoneCss.includes('#inbox-shell:not(.show-thread) > .is-inbox-mobile-docked:not(.is-autonomy-open)') &&
    phoneCss.includes(':not(.is-autonomy-open) > :not(.inbox-autonomy-bottom-tab)') &&
    phoneCss.includes('padding-bottom:calc(44px + env(safe-area-inset-bottom,0px))') &&
    /:not\(\.show-thread\):has\(> \.is-inbox-mobile-docked\.is-autonomy-open\)/.test(phoneCss)
);
ok(
  'SHARED-PHONE-INBOX-HEADER-004 grid: name row + action wrap (no h-scroll)',
  phoneCss.includes('SHARED-PHONE-INBOX-HEADER-004') &&
    phoneCss.includes('display:grid!important') &&
    phoneCss.includes('grid-template-columns:minmax(0,1fr) auto') &&
    phoneCss.includes('display:contents!important') &&
    phoneCss.includes('overflow-x:hidden') &&
    phoneCss.includes('flex-wrap:wrap') &&
    !/inbox-header-stack\{[^}]*overflow-x:auto/.test(phoneCss)
);
ok(
  'JS defaults Autonomy closed on list and chat phone dock',
  shell.includes('inboxShellAutonomyPhoneDocked') &&
    shell.includes('Default closed on list AND chat') &&
    /data-autonomy-keep-open/.test(shell)
);
ok(
  'JS cooks phone action row order (back, spam, clear, delete, refresh, luna)',
  (() => {
    const threadSrc = fs.readFileSync(path.join(root, 'scripts/browser/inbox-thread.js'), 'utf8');
    const cook = threadSrc.slice(
      threadSrc.indexOf('function inboxCookSelectedConversationHeaderActions'),
      threadSrc.indexOf('function inboxCookSelectedConversationHeaderActions') + 1200
    );
    return (
      /row\.appendChild\(back\)/.test(cook) &&
      /row\.appendChild\(spam\)/.test(cook) &&
      /row\.appendChild\(clearBtn\)/.test(cook) &&
      /row\.appendChild\(deleteBtn\)/.test(cook) &&
      /row\.appendChild\(refresh\)/.test(cook) &&
      /row\.appendChild\(chrome\)/.test(cook) &&
      cook.indexOf('appendChild(back)') < cook.indexOf('appendChild(spam)') &&
      cook.indexOf('appendChild(spam)') < cook.indexOf('appendChild(chrome)')
    );
  })()
);
ok(
  'desktop 901 guest block was not rewritten',
  api.includes('@media(min-width:901px){') &&
    api.includes('.inbox-two-col.inbox-shell-cols[data-col4="hidden"] .detail-sidebar{display:none}')
);

async function measureList(page) {
  return page.evaluate(() => {
    const search = document.querySelector('#inbox-shell > .inbox-conv-search-wrap.is-inbox-mobile-order');
    const tabs = document.querySelector('.inbox-folder-tabs');
    const chats = document.querySelector('.inbox-folder-tab[data-inbox-preset="all4"], .inbox-folder-tab[data-view="full"]');
    const autonomy = document.querySelector('#inbox-shell > .inbox-shell-channel-defaults.is-inbox-mobile-docked');
    const autoTab = autonomy && autonomy.querySelector('.inbox-autonomy-bottom-tab');
    const lock = autonomy && autonomy.querySelector('#inbox-autonomy-lock, .channelAutonomyLock');
    const lockInTab = autoTab && autoTab.querySelector('.channelAutonomyLock, #inbox-autonomy-lock');
    const panelKids = autonomy
      ? Array.from(autonomy.children).filter((el) => !el.classList.contains('inbox-autonomy-bottom-tab'))
      : [];
    const list = document.querySelector('#inbox-shell > #inbox-card .inbox-left-rows, #inbox-shell #conv-list');
    const firstCard = document.querySelector('#conv-list .conv-card');
    function box(el) {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        height: Math.round(r.height),
        position: s.position,
        marginTop: s.marginTop,
        paddingBottom: s.paddingBottom,
        borderRadius: s.borderRadius,
        display: s.display,
      };
    }
    return {
      vh: window.innerHeight,
      search: box(search),
      tabs: box(tabs),
      chats: box(chats),
      autonomy: box(autonomy),
      autoTab: box(autoTab),
      open: !!(autonomy && autonomy.classList.contains('is-autonomy-open')),
      panelVisible: panelKids.some((el) => getComputedStyle(el).display !== 'none'),
      lockVisibleClosed: !!(lock && getComputedStyle(lock).display !== 'none' && lock.getClientRects().length > 0),
      lockInsideTab: !!lockInTab,
      searchListGap: search && firstCard
        ? Math.round(firstCard.getBoundingClientRect().top - search.getBoundingClientRect().bottom)
        : null,
      list: box(list),
    };
  });
}

async function measureThread(page) {
  return page.evaluate(() => {
    const back = document.querySelector('#inbox-header-luna-row > .inbox-mobile-back, #inbox-mobile-back, .inbox-mobile-back');
    const autoTab = document.querySelector('#inbox-shell.show-thread > .is-inbox-mobile-docked .inbox-autonomy-bottom-tab');
    const autonomy = document.querySelector('#inbox-shell > .inbox-shell-channel-defaults.is-inbox-mobile-docked');
    const panelKids = autonomy
      ? Array.from(autonomy.children).filter((el) => !el.classList.contains('inbox-autonomy-bottom-tab'))
      : [];
    const msgs = document.querySelector('#thread-container, .thread-messages');
    const stack = document.querySelector('#inbox-shell.show-thread .inbox-header-stack-luna');
    const channel = document.querySelector('#inbox-shell.show-thread .inbox-header-stack-channel');
    const name = document.querySelector('#inbox-shell.show-thread .detail-header-main .detail-name, #inbox-shell.show-thread .detail-name');
    const header = document.querySelector('#inbox-shell.show-thread .detail-header');
    const headerRight = document.querySelector('#inbox-shell.show-thread .detail-header-right');
    function box(el) {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
        height: Math.round(r.height),
        width: Math.round(r.width),
        position: s.position,
        minHeight: s.minHeight,
        background: s.backgroundColor,
        flexDir: s.flexDirection,
        flexWrap: s.flexWrap,
        overflowX: s.overflowX,
        display: s.display,
        paddingLeft: s.paddingLeft,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      };
    }
    const nameBox = box(name);
    const channelBox = box(channel);
    return {
      vh: window.innerHeight,
      vw: window.innerWidth,
      back: box(back),
      autoTab: box(autoTab),
      autonomy: box(autonomy),
      msgs: box(msgs),
      stack: box(stack),
      channel: channelBox,
      name: nameBox,
      header: box(header),
      headerRight: box(headerRight),
      open: !!(autonomy && autonomy.classList.contains('is-autonomy-open')),
      panelVisible: panelKids.some((el) => getComputedStyle(el).display !== 'none'),
      stackOverflow: !!(stack && stack.scrollWidth > stack.clientWidth + 1),
      headerOverflow: !!(header && header.scrollWidth > header.clientWidth + 1),
      docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      channelRightOfName: !!(nameBox && channelBox && channelBox.left >= nameBox.right - 4 && Math.abs(channelBox.top - nameBox.top) <= 24),
      headerPadLeft: header ? parseFloat(getComputedStyle(header).paddingLeft) || 0 : 0,
    };
  });
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    ok('playwright available', false, 'playwright missing — static checks only');
    console.log(failed
      ? `verify:sunset-mobile-inbox-phone-layout-002 FAILED (${failed})`
      : 'verify:sunset-mobile-inbox-phone-layout-002 passed (static)');
    process.exit(failed ? 1 : 0);
  }

  const { server, base } = await startFixtureServer(buildPortalHtml());
  const browser = await playwright.chromium.launch({ headless: true });
  /* Sunset stamp + lodging (no attr) + accidental wolfhouse-somo stamp must all pass. */
  const portalStamps = [
    { name: 'sunset', value: 'sunset' },
    { name: 'wolfhouse-unscoped', value: null },
    { name: 'wolfhouse-somo-stamp', value: 'wolfhouse-somo' },
  ];
  try {
    for (const stamp of portalStamps) {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof window.switchToTab === 'function');
      await page.evaluate((portalValue) => {
        if (portalValue == null) document.documentElement.removeAttribute('data-portal-client');
        else document.documentElement.setAttribute('data-portal-client', portalValue);
        document.documentElement.setAttribute('data-theme', 'dark');
        window.switchToTab('conversations');
        if (typeof window.__syncInboxMobileOrder === 'function') window.__syncInboxMobileOrder();
      }, stamp.value);
      await page.waitForSelector('#conv-list .conv-card', { timeout: 15000 });
      await page.waitForTimeout(SETTLE_MS);
      const list = await measureList(page);

      ok(
        `390 list [${stamp.name}]: Autonomy fixed to viewport bottom`,
        list.autonomy &&
          list.autonomy.position === 'fixed' &&
          Math.abs(list.autonomy.bottom - list.vh) <= 8,
        JSON.stringify(list.autonomy)
      );
      ok(
        `390 list [${stamp.name}]: Autonomy closed by default (slim tab only, panel hidden)`,
        list.open === false &&
          list.panelVisible === false &&
          list.autoTab &&
          list.autoTab.height >= 28 &&
          list.autoTab.height <= 44 &&
          list.autonomy &&
          list.autonomy.height <= 56 &&
          list.lockVisibleClosed === false &&
          list.lockInsideTab === false,
        JSON.stringify({ open: list.open, panelVisible: list.panelVisible, autoTab: list.autoTab, autonomy: list.autonomy, lockVisibleClosed: list.lockVisibleClosed, lockInsideTab: list.lockInsideTab })
      );
      if (stamp.name === 'sunset') {
        ok(
          '390 list: search sits under Chats|Guests / icon filters',
          list.search && list.tabs && list.search.top >= list.tabs.bottom - 2,
          JSON.stringify({ searchTop: list.search && list.search.top, tabsBottom: list.tabs && list.tabs.bottom })
        );
        ok(
          '390 list: search has gap above first chat row',
          list.searchListGap != null && list.searchListGap >= 8,
          JSON.stringify({ searchListGap: list.searchListGap, search: list.search })
        );
ok(
  '390 list: Chats tab is classic folder height (not fat 48px+ button)',
  list.chats && list.chats.height >= 28 && list.chats.height <= 48,
  JSON.stringify(list.chats)
);
      }

      await page.evaluate((id) => {
        const card = document.querySelector(`#conv-list .conv-card[data-id="${id}"]`) ||
          document.querySelector('#conv-list .conv-card');
        if (card) card.click();
      }, CONV_ID);
      await page.waitForSelector('#inbox-shell.show-thread .detail-header', { timeout: 15000 });
      await page.evaluate(() => {
        if (typeof window.__syncInboxMobileOrder === 'function') window.__syncInboxMobileOrder();
        if (typeof window.inboxCookSelectedConversationHeaderActions === 'function') {
          window.inboxCookSelectedConversationHeaderActions();
        }
      });
      await page.waitForTimeout(SETTLE_MS);
      const thread = await measureThread(page);

      ok(
        `390 chat [${stamp.name}]: Autonomy slim tab docked to viewport bottom`,
        thread.autonomy &&
          thread.autonomy.position === 'fixed' &&
          Math.abs(thread.autonomy.bottom - thread.vh) <= 8 &&
          thread.open === false &&
          thread.panelVisible === false &&
          thread.autoTab &&
          thread.autoTab.height >= 28 &&
          thread.autoTab.height <= 44,
        JSON.stringify(thread)
      );
      ok(
        `390 chat [${stamp.name}]: action stack is row-wrapped toolbar (no h-scroll)`,
        thread.stack &&
          thread.stack.flexDir === 'row' &&
          (thread.stack.flexWrap === 'wrap' || thread.stack.flexWrap === 'wrap-reverse') &&
          thread.stack.overflowX === 'hidden' &&
          thread.stackOverflow === false &&
          thread.headerOverflow === false &&
          thread.docOverflow === false,
        JSON.stringify({
          stack: thread.stack,
          header: thread.header,
          stackOverflow: thread.stackOverflow,
          headerOverflow: thread.headerOverflow,
          docOverflow: thread.docOverflow,
        })
      );
      if (stamp.name === 'sunset') {
        ok(
          '390 chat: header has edge padding; WA/Email right of name',
          thread.headerPadLeft >= 8 &&
            thread.channelRightOfName === true,
          JSON.stringify({
            headerPadLeft: thread.headerPadLeft,
            channelRightOfName: thread.channelRightOfName,
            name: thread.name,
            channel: thread.channel,
          })
        );
        ok(
          '390 chat: back control is slim (not fat banner)',
          thread.back &&
            thread.back.height <= 34 &&
            thread.back.width <= 40,
          JSON.stringify(thread.back)
        );
        ok(
          '390 chat: transcript taller than chrome+draft leftovers',
          thread.msgs && thread.msgs.height >= 160 &&
            thread.header && thread.msgs.height > thread.header.height * 0.7,
          JSON.stringify({ msgs: thread.msgs, header: thread.header })
        );
      }
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failed
    ? `verify:sunset-mobile-inbox-phone-layout-002 FAILED (${failed})`
    : 'verify:sunset-mobile-inbox-phone-layout-002 passed');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
