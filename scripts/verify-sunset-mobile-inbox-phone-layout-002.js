#!/usr/bin/env node
'use strict';

/**
 * SUNSET-MOBILE-INBOX-PHONE-LAYOUT-002
 * Phone Inbox (~390px): Autonomy docked to viewport bottom + safe-area;
 * default CLOSED on list and chat (slim bottom tab only until opened);
 * lock is panel content (own pill), never on the slim dock title;
 * Chats|Guests as classic folder tabs (shared baseline, same width as icon card);
 * equal 8px stack gaps on list + thread; search pinned under filters;
 * name+tag with ← on the left | WA/Email/… on the right (no Refresh on phone);
 * ⋯ menu holds plain-text Spam / Clear / Delete / Luna On|Off;
 * taller transcript fills leftover; back survives conversation switches;
 * Guests + selected guest hides conversation pane (beats THREAD-FILL flex).
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
const phoneBlock = blockStart >= 0 ? api.slice(blockStart, blockStart + 42000) : '';
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
  'search uses equal stack gap (no 14px margin leftover)',
  phoneCss.includes('SHARED-PHONE-INBOX-STACK-GAP-005') &&
    /inbox-conv-search-wrap\.is-inbox-mobile-order\{[^}]*margin:0!important/.test(phoneCss) &&
    phoneCss.includes('#tab-conversations #inbox-shell:not(.show-thread){') &&
    phoneCss.includes('gap:8px!important')
);
ok(
  'Chats|Guests share baseline + match icon-card width',
  phoneCss.includes('SHARED-PHONE-INBOX-FOLDER-TABS-005') &&
    phoneCss.includes('align-items:stretch!important') &&
    phoneCss.includes('margin-bottom:0!important') &&
    phoneCss.includes('.inbox-views-rail{') &&
    /inbox-folder-tabs\{[^}]*width:100%!important/.test(phoneCss) &&
    /inbox-views-rail\{[^}]*width:100%!important/.test(phoneCss)
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
  'SHARED-PHONE-INBOX-HEADER-007: ← name | WA Email … ; no phone Refresh',
  phoneCss.includes('SHARED-PHONE-INBOX-HEADER-007') &&
    phoneCss.includes('display:grid!important') &&
    phoneCss.includes('grid-template-columns:minmax(0,1fr) auto') &&
    phoneCss.includes('display:contents!important') &&
    phoneCss.includes('.detail-header-id') &&
    phoneCss.includes('.inbox-header-stack-channel #btn-refresh') &&
    /#btn-refresh\{[^}]*display:none!important/.test(phoneCss) &&
    /#inbox-header-luna-row/.test(phoneCss) &&
    /inbox-header-stack-luna\{[^}]*display:none!important/.test(phoneCss) &&
    shell.includes('SHARED-PHONE-INBOX-HEADER-007')
);
ok(
  'SHARED-PHONE-INBOX-FILTER-HEADER-GAP-001: margin above open-thread card only',
  phoneCss.includes('SHARED-PHONE-INBOX-FILTER-HEADER-GAP-001') &&
    /\.detail-header\{[^}]*margin:8px 0 0!important/.test(phoneCss) &&
    shell.includes('SHARED-PHONE-INBOX-FILTER-HEADER-GAP-001') &&
    shell.includes('.detail-header{margin:8px 0 0!important}')
);
ok(
  'SHARED-PHONE-INBOX-GUESTS-HIDE-FILTERS-001: Guests hides icon filter rail',
  phoneCss.includes('SHARED-PHONE-INBOX-GUESTS-HIDE-FILTERS-001') &&
    /data-inbox-preset="guest"\]\[aria-pressed="true"\]\) #tab-conversations \.inbox-col1 > \.inbox-views-rail\{[^}]*display:none!important/.test(
      phoneCss
    ) &&
    shell.includes('SHARED-PHONE-INBOX-GUESTS-HIDE-FILTERS-001')
);
ok(
  'SHARED-PHONE-INBOX-GUESTS-HIDE-THREAD-001: Guests hides conversation pane (beats THREAD-FILL)',
  phoneCss.includes('SHARED-PHONE-INBOX-GUESTS-HIDE-THREAD-001') &&
    /data-inbox-preset="guest"\]\[aria-pressed="true"\]\) #tab-conversations #inbox-shell\.show-thread \.detail-main\{[\s\S]{0,80}display:none!important/.test(
      phoneCss
    ) &&
    shell.includes('SHARED-PHONE-INBOX-GUESTS-HIDE-THREAD-001') &&
    shell.includes(
      'body:has([data-inbox-preset="guest"][aria-pressed="true"]) #tab-conversations #inbox-shell.show-thread .detail-main{display:none!important}'
    )
);
ok(
  'SHARED-PHONE-INBOX-THREAD-FILL-005 grows messages into leftover space',
  phoneCss.includes('SHARED-PHONE-INBOX-THREAD-FILL-005') &&
    phoneCss.includes('height:100%!important') &&
    phoneCss.includes('.thread-messages') &&
    phoneCss.includes('flex:1 1 auto!important')
);
ok(
  'JS parks mobile back outside detail-content (survives switches)',
  (() => {
    const threadSrc = fs.readFileSync(path.join(root, 'scripts/browser/inbox-thread.js'), 'utf8');
    return (
      threadSrc.includes('function inboxParkMobileBackBtn') &&
      threadSrc.includes('inboxParkMobileBackBtn()') &&
      /inboxParkRefreshBtn\(\);\s*inboxParkMobileBackBtn\(\);/.test(threadSrc)
    );
  })()
);
ok(
  'JS defaults Autonomy closed on list and chat phone dock',
  shell.includes('inboxShellAutonomyPhoneDocked') &&
    shell.includes('Default closed on list AND chat') &&
    /data-autonomy-keep-open/.test(shell)
);
ok(
  'SHARED-PHONE-INBOX-OVERFLOW-007 CSS: plain-text menu + desktop inline',
  phoneCss.includes('SHARED-PHONE-INBOX-OVERFLOW-007') &&
    phoneCss.includes('.inbox-thread-overflow') &&
    phoneCss.includes('.inbox-thread-overflow-btn') &&
    phoneCss.includes('.inbox-thread-overflow-panel') &&
    phoneCss.includes('background:transparent!important') &&
    phoneCss.includes('.inbox-luna-mode-label') &&
    api.includes('@media(min-width:769px)') &&
    /inbox-thread-overflow-btn\{display:none!important\}/.test(api) &&
    shell.includes('SHARED-PHONE-INBOX-OVERFLOW-007')
);
ok(
  'JS cooks phone header: ← beside name, … in channel, no Refresh; menu holds actions',
  (() => {
    const threadSrc = fs.readFileSync(path.join(root, 'scripts/browser/inbox-thread.js'), 'utf8');
    const cook = threadSrc.slice(
      threadSrc.indexOf('function inboxCookSelectedConversationHeaderActions'),
      threadSrc.indexOf('function inboxCookSelectedConversationHeaderActions') + 4200
    );
    return (
      /function inboxEnsureThreadOverflowMenu\(/.test(threadSrc) &&
      /function inboxPhoneThreadOverflow\(/.test(threadSrc) &&
      /function inboxCloseThreadOverflowMenu\(/.test(threadSrc) &&
      /function inboxSyncPhoneOverflowPlainLabels\(/.test(threadSrc) &&
      /nameHost\.insertBefore\(back/.test(cook) &&
      /channel\.appendChild\(overflow\)/.test(cook) &&
      /inboxParkRefreshBtn\(\)/.test(cook) &&
      /panel\.appendChild\(spam\)/.test(cook) &&
      /panel\.appendChild\(clearBtn\)/.test(cook) &&
      /panel\.appendChild\(deleteBtn\)/.test(cook) &&
      /panel\.appendChild\(chrome\)/.test(cook) &&
      /Luna On/.test(threadSrc) &&
      /Luna Off/.test(threadSrc)
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
    const guests = document.querySelector('.inbox-folder-tab[data-inbox-preset="guest"], .inbox-folder-tab[data-view="guest"]');
    const rail = document.querySelector('#inbox-views-rail, .inbox-views-rail');
    const wrap = document.querySelector('#wrap.inbox-shell-wrap, #wrap');
    const header = document.querySelector('#site-header, header, .portal-topbar, #topbar');
    const autonomy = document.querySelector('#inbox-shell > .inbox-shell-channel-defaults.is-inbox-mobile-docked');
    const autoTab = autonomy && autonomy.querySelector('.inbox-autonomy-bottom-tab');
    const lock = autonomy && autonomy.querySelector('#inbox-autonomy-lock, .channelAutonomyLock');
    const lockInTab = autoTab && autoTab.querySelector('.channelAutonomyLock, #inbox-autonomy-lock');
    const panelKids = autonomy
      ? Array.from(autonomy.children).filter((el) => !el.classList.contains('inbox-autonomy-bottom-tab'))
      : [];
    const list = document.querySelector('#inbox-shell > #inbox-card .inbox-left-rows, #inbox-shell #conv-list');
    const firstCard = document.querySelector('#conv-list .conv-card');
    const inboxCard = document.querySelector('#inbox-shell > #inbox-card');
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
        marginTop: s.marginTop,
        paddingBottom: s.paddingBottom,
        borderRadius: s.borderRadius,
        display: s.display,
      };
    }
    const wrapBox = box(wrap);
    const tabsBox = box(tabs);
    const chatsBox = box(chats);
    const guestsBox = box(guests);
    const railBox = box(rail);
    const searchBox = box(search);
    const listTopEl = inboxCard || firstCard;
    const listTop = listTopEl ? Math.round(listTopEl.getBoundingClientRect().top) : null;
    const headerBottom = header ? Math.round(header.getBoundingClientRect().bottom) : (wrapBox ? wrapBox.top : null);
    const wrapPadTop = wrap ? parseFloat(getComputedStyle(wrap).paddingTop) || 0 : null;
    const shellEl = document.getElementById('inbox-shell');
    const shellGap = shellEl
      ? (parseFloat(getComputedStyle(shellEl).rowGap) || parseFloat(getComputedStyle(shellEl).gap) || 0)
      : null;
    return {
      vh: window.innerHeight,
      search: searchBox,
      tabs: tabsBox,
      chats: chatsBox,
      guests: guestsBox,
      rail: railBox,
      autonomy: box(autonomy),
      autoTab: box(autoTab),
      open: !!(autonomy && autonomy.classList.contains('is-autonomy-open')),
      panelVisible: panelKids.some((el) => getComputedStyle(el).display !== 'none'),
      lockVisibleClosed: !!(lock && getComputedStyle(lock).display !== 'none' && lock.getClientRects().length > 0),
      lockInsideTab: !!lockInTab,
      searchListGap: searchBox && listTop != null ? listTop - searchBox.bottom : null,
      iconSearchGap: railBox && searchBox ? searchBox.top - railBox.bottom : null,
      headerTabsGap: headerBottom != null && tabsBox ? tabsBox.top - headerBottom : null,
      wrapPadTop: wrapPadTop == null ? null : Math.round(wrapPadTop),
      shellGap: shellGap == null ? null : Math.round(shellGap),
      tabsRailWidthDelta: tabsBox && railBox ? Math.abs(tabsBox.width - railBox.width) : null,
      tabsRailLeftDelta: tabsBox && railBox ? Math.abs(tabsBox.left - railBox.left) : null,
      tabsBaselineDelta: chatsBox && guestsBox ? Math.abs(chatsBox.bottom - guestsBox.bottom) : null,
      list: box(list),
    };
  });
}

async function measureThread(page) {
  return page.evaluate(() => {
    const back = document.querySelector('#inbox-shell.show-thread .detail-header-id > .inbox-mobile-back, #inbox-header-luna-row > .inbox-mobile-back, #inbox-mobile-back, .inbox-mobile-back');
    const autoTab = document.querySelector('#inbox-shell.show-thread > .is-inbox-mobile-docked .inbox-autonomy-bottom-tab');
    const autonomy = document.querySelector('#inbox-shell > .inbox-shell-channel-defaults.is-inbox-mobile-docked');
    const panelKids = autonomy
      ? Array.from(autonomy.children).filter((el) => !el.classList.contains('inbox-autonomy-bottom-tab'))
      : [];
    const msgs = document.querySelector('#thread-container, .thread-messages');
    const stack = document.querySelector('#inbox-shell.show-thread .inbox-header-stack-luna');
    const channel = document.querySelector('#inbox-shell.show-thread .inbox-header-stack-channel');
    const name = document.querySelector('#inbox-shell.show-thread .detail-header-main .detail-name, #inbox-shell.show-thread .detail-name');
    const nameHost = document.querySelector('#inbox-shell.show-thread .detail-header-id');
    const header = document.querySelector('#inbox-shell.show-thread .detail-header');
    const headerRight = document.querySelector('#inbox-shell.show-thread .detail-header-right');
    const refresh = document.querySelector('#btn-refresh');
    const draft = document.querySelector('#inbox-shell.show-thread .draft-panel');
    const threadSection = document.querySelector('#inbox-shell.show-thread .thread-section, #inbox-shell.show-thread .thread');
    const overflow = document.getElementById('inbox-thread-overflow');
    const overflowBtn = document.getElementById('inbox-thread-overflow-btn');
    const overflowPanel = document.getElementById('inbox-thread-overflow-panel');
    const spam = document.getElementById('btn-inbox-spam');
    const clearBtn = document.getElementById('btn-inbox-clear-thread');
    const deleteBtn = document.getElementById('btn-inbox-conv-delete');
    const chrome = document.getElementById('inbox-chat-chrome-slot');
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
    function visible(el) {
      return !!(el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0);
    }
    const nameBox = box(name);
    const channelBox = box(channel);
    const headerBox = box(header);
    const msgsBox = box(msgs);
    const draftBox = box(draft);
    const backBox = box(back);
    const rail = document.querySelector('#inbox-views-rail, .inbox-views-rail');
    const railBox = box(rail);
    const railDisplay = rail ? getComputedStyle(rail).display : null;
    const refreshInChannel = !!(refresh && channel && channel.contains(refresh) && visible(refresh));
    const refreshInLuna = !!(refresh && stack && stack.contains(refresh) && visible(refresh));
    const refreshVisible = visible(refresh);
    const backVisible = visible(back);
    const backBesideName = !!(back && nameHost && nameHost.contains(back));
    const overflowInChannel = !!(overflow && channel && channel.contains(overflow));
    const overflowOpen = !!(overflow && overflow.classList.contains('is-open') && overflowPanel && !overflowPanel.hidden);
    const spamInPanel = !!(spam && overflowPanel && overflowPanel.contains(spam));
    const clearInPanel = !!(clearBtn && overflowPanel && overflowPanel.contains(clearBtn));
    const deleteInPanel = !!(deleteBtn && overflowPanel && overflowPanel.contains(deleteBtn));
    const chromeInPanel = !!(chrome && overflowPanel && overflowPanel.contains(chrome));
    const lunaRowVisible = !!(stack && getComputedStyle(stack).display !== 'none' && stack.getClientRects().length > 0);
    const nameIconsRowGap =
      nameBox && channelBox ? Math.abs(channelBox.top - nameBox.top) : null;
    return {
      vh: window.innerHeight,
      vw: window.innerWidth,
      back: backBox,
      backVisible,
      backBesideName,
      autoTab: box(autoTab),
      autonomy: box(autonomy),
      msgs: msgsBox,
      stack: box(stack),
      channel: channelBox,
      name: nameBox,
      header: headerBox,
      headerRight: box(headerRight),
      draft: draftBox,
      threadSection: box(threadSection),
      rail: railBox,
      railDisplay,
      railVisible: visible(rail),
      open: !!(autonomy && autonomy.classList.contains('is-autonomy-open')),
      panelVisible: panelKids.some((el) => getComputedStyle(el).display !== 'none'),
      stackOverflow: !!(stack && stack.scrollWidth > stack.clientWidth + 1),
      headerOverflow: !!(header && header.scrollWidth > header.clientWidth + 1),
      docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      channelRightOfName: !!(nameBox && channelBox && channelBox.left >= nameBox.right - 4 && Math.abs(channelBox.top - nameBox.top) <= 24),
      headerPadLeft: header ? parseFloat(getComputedStyle(header).paddingLeft) || 0 : 0,
      refreshInChannel,
      refreshInLuna,
      refreshVisible,
      filterHeaderGap: railBox && headerBox && railDisplay !== 'none'
        ? headerBox.top - railBox.bottom
        : null,
      nameIconsRowGap,
      headerMsgsGap: headerBox && (threadSection || msgs) ? Math.round((threadSection || msgs).getBoundingClientRect().top - headerBox.bottom) : null,
      msgsDraftGap: msgsBox && draftBox ? draftBox.top - msgsBox.bottom : null,
      deadBandBelowDraft: draftBox && autoTab
        ? Math.round(autoTab.getBoundingClientRect().top - draftBox.bottom)
        : (draftBox ? Math.round(window.innerHeight - draftBox.bottom) : null),
      overflowBtn: box(overflowBtn),
      overflowBtnVisible: visible(overflowBtn),
      overflowInChannel,
      overflowOpen,
      overflowPanelVisible: visible(overflowPanel),
      spamInPanel,
      clearInPanel,
      deleteInPanel,
      chromeInPanel,
      spamVisibleClosed: visible(spam),
      clearVisibleClosed: visible(clearBtn),
      lunaRowVisible,
      backLeftOfName: !!(backBox && nameBox && backBox.right <= nameBox.left + 2 && Math.abs(backBox.top - nameBox.top) <= 20),
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
          '390 list: Chats|Guests share the same baseline',
          list.tabsBaselineDelta != null && list.tabsBaselineDelta <= 1,
          JSON.stringify({ tabsBaselineDelta: list.tabsBaselineDelta, chats: list.chats, guests: list.guests })
        );
        ok(
          '390 list: icon filter card matches folder-tabs width',
          list.tabsRailWidthDelta != null && list.tabsRailWidthDelta <= 2 &&
            list.tabsRailLeftDelta != null && list.tabsRailLeftDelta <= 2,
          JSON.stringify({
            tabsRailWidthDelta: list.tabsRailWidthDelta,
            tabsRailLeftDelta: list.tabsRailLeftDelta,
            tabs: list.tabs,
            rail: list.rail,
          })
        );
        ok(
          '390 list: equal 8px stack gaps (wrap pad, shell gap, search→list)',
          list.wrapPadTop != null && list.shellGap != null && list.searchListGap != null &&
            Math.abs(list.wrapPadTop - 8) <= 1 &&
            Math.abs(list.shellGap - 8) <= 1 &&
            Math.abs(list.searchListGap - 8) <= 2 &&
            (list.iconSearchGap == null || Math.abs(list.iconSearchGap - 8) <= 2),
          JSON.stringify({
            wrapPadTop: list.wrapPadTop,
            shellGap: list.shellGap,
            iconSearchGap: list.iconSearchGap,
            searchListGap: list.searchListGap,
          })
        );
        ok(
          '390 list: Chats tab is classic folder height (not fat 48px+ button)',
          list.chats && list.chats.height >= 28 && list.chats.height <= 48,
          JSON.stringify(list.chats)
        );
        ok(
          '390 list: Chats keeps icon filter rail visible',
          list.rail && list.rail.height >= 36 && list.rail.display !== 'none',
          JSON.stringify(list.rail)
        );
        /* Guests must hide the Chats-style icon filter strip entirely. */
        await page.evaluate(() => {
          const guests = document.querySelector(
            '.inbox-folder-tab[data-inbox-preset="guest"], .inbox-folder-tab[data-view="guest"]'
          );
          if (guests) guests.click();
        });
        await page.waitForTimeout(SETTLE_MS);
        const guestsList = await measureList(page);
        ok(
          '390 list: Guests hides chat icon filter rail',
          guestsList.rail == null ||
            guestsList.rail.display === 'none' ||
            guestsList.rail.height === 0,
          JSON.stringify(guestsList.rail)
        );
        await page.evaluate(() => {
          const chats = document.querySelector(
            '.inbox-folder-tab[data-inbox-preset="all4"], .inbox-folder-tab[data-view="full"]'
          );
          if (chats) chats.click();
        });
        await page.waitForTimeout(SETTLE_MS);
        const chatsAgain = await measureList(page);
        ok(
          '390 list: Chats restores icon filter rail after Guests',
          chatsAgain.rail && chatsAgain.rail.height >= 36 && chatsAgain.rail.display !== 'none',
          JSON.stringify(chatsAgain.rail)
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
        thread.header &&
          thread.headerOverflow === false &&
          thread.docOverflow === false &&
          (thread.stack == null || thread.lunaRowVisible === false ||
            ((thread.stack.flexWrap === 'wrap' || thread.stack.flexWrap === 'wrap-reverse' || thread.stack.display === 'none') &&
              thread.stackOverflow === false)),
        JSON.stringify({
          stack: thread.stack,
          header: thread.header,
          lunaRowVisible: thread.lunaRowVisible,
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
          '390 chat: no Refresh on phone open-thread header',
          thread.refreshVisible === false &&
            thread.refreshInChannel === false &&
            thread.refreshInLuna === false,
          JSON.stringify({
            refreshVisible: thread.refreshVisible,
            refreshInChannel: thread.refreshInChannel,
            refreshInLuna: thread.refreshInLuna,
          })
        );
        ok(
          '390 chat: ← sits left of guest name; … in channel top-right',
          thread.backVisible === true &&
            thread.backBesideName === true &&
            thread.backLeftOfName === true &&
            thread.overflowBtnVisible === true &&
            thread.overflowInChannel === true &&
            thread.lunaRowVisible === false,
          JSON.stringify({
            backVisible: thread.backVisible,
            backBesideName: thread.backBesideName,
            backLeftOfName: thread.backLeftOfName,
            overflowBtnVisible: thread.overflowBtnVisible,
            overflowInChannel: thread.overflowInChannel,
            lunaRowVisible: thread.lunaRowVisible,
            back: thread.back,
            name: thread.name,
          })
        );
        ok(
          '390 chat: Spam/Clear/Delete/Luna tucked in closed … menu',
          thread.overflowOpen === false &&
            thread.overflowPanelVisible === false &&
            thread.spamInPanel === true &&
            thread.clearInPanel === true &&
            thread.deleteInPanel === true &&
            thread.chromeInPanel === true &&
            thread.spamVisibleClosed === false &&
            thread.clearVisibleClosed === false,
          JSON.stringify({
            overflowOpen: thread.overflowOpen,
            spamInPanel: thread.spamInPanel,
            clearInPanel: thread.clearInPanel,
            deleteInPanel: thread.deleteInPanel,
            chromeInPanel: thread.chromeInPanel,
            spamVisibleClosed: thread.spamVisibleClosed,
            clearVisibleClosed: thread.clearVisibleClosed,
          })
        );
        /* Open ⋯ and confirm plain-text menu actions. */
        await page.click('#inbox-thread-overflow-btn');
        await page.waitForTimeout(200);
        const menuOpen = await page.evaluate(() => {
          const wrap = document.getElementById('inbox-thread-overflow');
          const panel = document.getElementById('inbox-thread-overflow-panel');
          const spam = document.getElementById('btn-inbox-spam');
          const clearBtn = document.getElementById('btn-inbox-clear-thread');
          const deleteBtn = document.getElementById('btn-inbox-conv-delete');
          const lunaBtns = Array.from(document.querySelectorAll('#inbox-thread-overflow-panel .inbox-luna-mode-btn'));
          function vis(el) {
            return !!(el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0);
          }
          function plain(el) {
            if (!el) return false;
            const s = getComputedStyle(el);
            const bg = s.backgroundColor;
            const transparent = !bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)';
            return transparent && (s.borderStyle === 'none' || s.borderWidth === '0px' || parseFloat(s.borderWidth) === 0);
          }
          return {
            open: !!(wrap && wrap.classList.contains('is-open') && panel && !panel.hidden),
            spam: vis(spam),
            clear: vis(clearBtn),
            del: vis(deleteBtn),
            lunaTexts: lunaBtns.map((b) => (b.textContent || '').trim()),
            lunaPlain: lunaBtns.length > 0 && lunaBtns.every((b) => plain(b)),
            spamPlain: plain(spam),
            clearPlain: plain(clearBtn),
            delPlain: plain(deleteBtn),
            labelHidden: (() => {
              const lab = document.querySelector('#inbox-thread-overflow-panel .inbox-luna-mode-label');
              return !lab || getComputedStyle(lab).display === 'none';
            })(),
          };
        });
        ok(
          '390 chat: ⋯ menu opens plain-text Spam/Clear/Delete/Luna On|Off',
          menuOpen.open === true &&
            menuOpen.spam === true &&
            menuOpen.clear === true &&
            menuOpen.del === true &&
            menuOpen.labelHidden === true &&
            menuOpen.spamPlain === true &&
            menuOpen.clearPlain === true &&
            menuOpen.delPlain === true &&
            menuOpen.lunaPlain === true &&
            menuOpen.lunaTexts.some((t) => /Luna On/i.test(t)) &&
            menuOpen.lunaTexts.some((t) => /Luna Off/i.test(t)),
          JSON.stringify(menuOpen)
        );
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        const menuClosed = await page.evaluate(() => {
          const wrap = document.getElementById('inbox-thread-overflow');
          const panel = document.getElementById('inbox-thread-overflow-panel');
          return {
            open: !!(wrap && wrap.classList.contains('is-open')),
            panelHidden: !!(panel && panel.hidden),
          };
        });
        ok(
          '390 chat: Escape closes ⋯ menu',
          menuClosed.open === false && menuClosed.panelHidden === true,
          JSON.stringify(menuClosed)
        );
        ok(
          '390 chat: equal stack gaps around header/messages/reply',
          thread.headerMsgsGap != null && thread.msgsDraftGap != null &&
            Math.abs(thread.headerMsgsGap - 8) <= 3 &&
            Math.abs(thread.msgsDraftGap - 8) <= 3,
          JSON.stringify({ headerMsgsGap: thread.headerMsgsGap, msgsDraftGap: thread.msgsDraftGap })
        );
        ok(
          '390 chat: vertical gap between icon filter strip and open-thread card',
          thread.filterHeaderGap != null &&
            thread.filterHeaderGap >= 6 &&
            thread.filterHeaderGap <= 14 &&
            thread.railVisible === true,
          JSON.stringify({
            filterHeaderGap: thread.filterHeaderGap,
            rail: thread.rail,
            header: thread.header,
            railVisible: thread.railVisible,
          })
        );
        ok(
          '390 chat: no extra gap inside header between name and WA/Email icons',
          thread.nameIconsRowGap != null && thread.nameIconsRowGap <= 24,
          JSON.stringify({ nameIconsRowGap: thread.nameIconsRowGap, name: thread.name, channel: thread.channel })
        );
        ok(
          '390 chat: transcript fills leftover (no huge dead band above Autonomy)',
          thread.msgs && thread.msgs.height >= 200 &&
            thread.header && thread.msgs.height > thread.header.height * 0.9 &&
            (thread.deadBandBelowDraft == null || thread.deadBandBelowDraft <= 52),
          JSON.stringify({ msgs: thread.msgs, header: thread.header, deadBandBelowDraft: thread.deadBandBelowDraft })
        );

        /* Guests+selected CSS: flip folder preset without folder-switch list reload
           (fixture Guests directory filters out non-customer rows). Keeps the open
           thread DOM so we prove THREAD-FILL no longer beats Guests hide. */
        await page.evaluate(() => {
          document.querySelectorAll('[data-inbox-preset]').forEach((btn) => {
            const isGuest = btn.getAttribute('data-inbox-preset') === 'guest';
            btn.setAttribute('aria-pressed', isGuest ? 'true' : 'false');
            btn.classList.toggle('is-active', isGuest);
          });
          try {
            if (window.inboxColumnsRuntime && window.inboxColumnsRuntime.record) {
              window.inboxColumnsRuntime.record.preset = 'guest';
            }
          } catch (_e) { /* ignore */ }
        });
        await page.waitForTimeout(SETTLE_MS);
        const guestOpen = await page.evaluate(() => {
          function visible(el) {
            return !!(el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0);
          }
          const main = document.querySelector('#inbox-shell.show-thread .detail-main');
          const header = document.querySelector('#inbox-shell.show-thread .detail-header');
          const msgs = document.querySelector('#inbox-shell.show-thread .thread-messages, #thread-container');
          const draft = document.querySelector('#inbox-shell.show-thread .draft-panel');
          const sidebar = document.querySelector(
            '#inbox-shell.show-thread #inbox-detail-sidebar, #inbox-shell.show-thread .detail-sidebar'
          );
          const guestCard = document.querySelector(
            '#inbox-shell.show-thread .inbox-guest-card, #inbox-shell.show-thread .inbox-customer-card'
          );
          const rail = document.querySelector('#inbox-views-rail, .inbox-views-rail');
          const guestPreset = document.querySelector('[data-inbox-preset="guest"][aria-pressed="true"]');
          return {
            guestPresetOn: !!guestPreset,
            shellShowThread: !!(document.getElementById('inbox-shell') &&
              document.getElementById('inbox-shell').classList.contains('show-thread')),
            mainDisplay: main ? getComputedStyle(main).display : null,
            mainVisible: visible(main),
            headerVisible: visible(header),
            msgsVisible: visible(msgs),
            draftVisible: visible(draft),
            sidebarVisible: visible(sidebar),
            guestCardVisible: visible(guestCard),
            railVisible: visible(rail),
            railDisplay: rail ? getComputedStyle(rail).display : null,
          };
        });
        ok(
          '390 Guests+selected: hides conversation thread (header/messages/reply)',
          guestOpen.guestPresetOn === true &&
            guestOpen.shellShowThread === true &&
            guestOpen.mainDisplay === 'none' &&
            guestOpen.mainVisible === false &&
            guestOpen.headerVisible === false &&
            guestOpen.msgsVisible === false &&
            guestOpen.draftVisible === false,
          JSON.stringify(guestOpen)
        );
        ok(
          '390 Guests+selected: guest card/sidebar remains; icon filter rail stays hidden',
          (guestOpen.sidebarVisible === true || guestOpen.guestCardVisible === true) &&
            (guestOpen.railVisible === false || guestOpen.railDisplay === 'none'),
          JSON.stringify(guestOpen)
        );
        await page.evaluate(() => {
          document.querySelectorAll('[data-inbox-preset]').forEach((btn) => {
            const isChat = btn.getAttribute('data-inbox-preset') === 'all4' ||
              btn.getAttribute('data-inbox-preset') === 'chat';
            const isGuest = btn.getAttribute('data-inbox-preset') === 'guest';
            btn.setAttribute('aria-pressed', isChat && !isGuest ? 'true' : (isGuest ? 'false' : btn.getAttribute('aria-pressed')));
            if (btn.getAttribute('data-inbox-preset') === 'all4') {
              btn.setAttribute('aria-pressed', 'true');
              btn.classList.add('is-active');
            }
            if (isGuest) {
              btn.setAttribute('aria-pressed', 'false');
              btn.classList.remove('is-active');
            }
          });
          try {
            if (window.inboxColumnsRuntime && window.inboxColumnsRuntime.record) {
              window.inboxColumnsRuntime.record.preset = 'all4';
            }
          } catch (_e2) { /* ignore */ }
        });
        await page.waitForTimeout(SETTLE_MS);
        const chatsRestored = await page.evaluate(() => {
          function visible(el) {
            return !!(el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0);
          }
          const main = document.querySelector('#inbox-shell.show-thread .detail-main');
          const header = document.querySelector('#inbox-shell.show-thread .detail-header');
          const msgs = document.querySelector('#inbox-shell.show-thread .thread-messages, #thread-container');
          return {
            mainDisplay: main ? getComputedStyle(main).display : null,
            headerVisible: visible(header),
            msgsVisible: visible(msgs),
          };
        });
        ok(
          '390 Chats after Guests: conversation thread restored',
          chatsRestored.mainDisplay !== 'none' &&
            chatsRestored.headerVisible === true &&
            chatsRestored.msgsVisible === true,
          JSON.stringify(chatsRestored)
        );

        /* Back must survive opening a second conversation (park/restore). */
        const cards = await page.$$('#conv-list .conv-card');
        if (cards.length >= 2) {
          await page.evaluate(() => {
            const backBtn = document.querySelector('#inbox-mobile-back, .inbox-mobile-back');
            if (backBtn) backBtn.click();
          });
          await page.waitForTimeout(SETTLE_MS);
          await page.evaluate(() => {
            const second = document.querySelectorAll('#conv-list .conv-card')[1];
            if (second) second.click();
          });
          await page.waitForSelector('#inbox-shell.show-thread .detail-header', { timeout: 15000 });
          await page.evaluate(() => {
            if (typeof window.inboxCookSelectedConversationHeaderActions === 'function') {
              window.inboxCookSelectedConversationHeaderActions();
            }
          });
          await page.waitForTimeout(SETTLE_MS);
          const thread2 = await measureThread(page);
          ok(
            '390 chat: back still visible after opening a second conversation',
            thread2.backVisible === true && thread2.back && thread2.back.height <= 34,
            JSON.stringify(thread2.back)
          );
        }
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
