#!/usr/bin/env node
'use strict';

/** MOBILE-AUTONOMY-HAMBURGER-20261108
 * Proves the original Luna Autonomy card lives at the bottom of the existing
 * mobile hamburger, immediately before tools, with no standalone Inbox handle
 * or chat footprint. Exercises portrait, constrained landscape and reduced
 * height while preserving stored modes/lock and desktop source ownership.
 */
const fs = require('fs');
const path = require('path');
const { buildPortalHtml, startFixtureServer, loadPlaywright, SETTLE_MS } = require('./verify-inbox-columns-playwright');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const root = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(root, 'scripts/browser/inbox-shell.js'), 'utf8');
let failed = 0;
function ok(label, cond, detail) { if (cond) console.log('ok -', label); else { failed += 1; console.error('FAIL -', label, detail || ''); } }

ok('hamburger marker exists', shell.includes('MOBILE-AUTONOMY-HAMBURGER-20261108'));
ok('mobile code adopts original card immediately before tools', shell.includes("mobileMenu.insertBefore(card, mobileMenuTools)"));
ok('left drawer marker and fixed Autonomy handle CSS removed', !shell.includes('SHARED-PHONE-INBOX-AUTONOMY-LEFT-DRAWER-001') && !shell.includes('.is-inbox-mobile-docked .inbox-autonomy-bottom-tab{position:absolute'));
ok('stored mode and lock keys remain owned by existing card', shell.includes("wh_staff_inbox_channel_mode_v1") && shell.includes("wh_staff_inbox_autonomy_lock_v1"));
ok('desktop slot restoration remains explicit', shell.includes('defaultSlot.appendChild(card)'));
ok('Spanish title remains localized', STAFF_PORTAL_STRINGS.es['inbox.channelControl.title'] === 'AUTONOMÍA LUNA');

async function inspect(page) {
  return page.evaluate(() => {
    const card = document.getElementById('inbox-shell-channel-defaults');
    const tabs = document.getElementById('tabs');
    const tools = document.getElementById('nav-menu-tools');
    const shellEl = document.getElementById('inbox-shell');
    const lock = document.getElementById('inbox-autonomy-lock');
    const waAuto = card && card.querySelector('[data-inbox-autonomy-channel="whatsapp"][data-inbox-autonomy="auto"]');
    const emailDraft = card && card.querySelector('[data-inbox-autonomy-channel="email"][data-inbox-autonomy="draft"]');
    const title = card && card.querySelector('.channelAutonomyLabel');
    const r = card && card.getBoundingClientRect();
    function reachable(el) {
      if (!el) return false;
      const b = el.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return b.width > 0 && b.height > 0 && b.left >= 0 && b.right <= innerWidth && !!(hit && (hit === el || el.contains(hit)));
    }
    return {
      menuOpen: document.body.classList.contains('nav-menu-open'),
      tabsRect: tabs ? (() => { const b = tabs.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom) }; })() : null,
      directChild: !!(card && card.parentNode === tabs),
      immediatelyBeforeTools: !!(card && card.nextElementSibling === tools),
      mobileClass: !!(card && card.classList.contains('is-nav-menu-mobile')),
      dockClass: !!(card && card.classList.contains('is-inbox-mobile-docked')),
      standaloneHandle: !!document.querySelector('.inbox-autonomy-bottom-tab'),
      shellPaddingBottom: shellEl ? Math.round(parseFloat(getComputedStyle(shellEl).paddingBottom) || 0) : -1,
      title: title ? title.textContent.trim() : '',
      lockPressed: lock && lock.getAttribute('aria-pressed'),
      lockRect: lock ? (() => { const b = lock.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom) }; })() : null,
      lockReachable: reachable(lock),
      waAutoPressed: waAuto && waAuto.getAttribute('aria-pressed'),
      waAutoReachable: reachable(waAuto),
      emailDraftPressed: emailDraft && emailDraft.getAttribute('aria-pressed'),
      cardInsideViewport: !!(r && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight),
      cardTop: r ? Math.round(r.top) : -1,
      cardHeight: r ? Math.round(r.height) : -1,
      cardBottom: r ? Math.round(r.bottom) : -1,
      toolsTop: tools ? Math.round(tools.getBoundingClientRect().top) : -1,
    };
  });
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) { ok('playwright available', false); process.exit(1); }
  const { server, base } = await startFixtureServer(buildPortalHtml());
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    for (const vp of [
      { name: 'portrait', width: 390, height: 844 },
      { name: 'landscape', width: 844, height: 390 },
      { name: 'reduced', width: 390, height: 500 },
    ]) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      await page.addInitScript(() => {
        localStorage.setItem('wh_staff_portal_locale', 'es');
        localStorage.setItem('wh_staff_inbox_channel_mode_v1', JSON.stringify({ whatsapp: 'auto', email: 'draft' }));
        localStorage.setItem('wh_staff_inbox_autonomy_lock_v1', JSON.stringify('unlocked'));
      });
      await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof window.switchToTab === 'function');
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-portal-client', 'sunset');
        if (typeof window.setStaffLocale === 'function') window.setStaffLocale('es');
        window.switchToTab('conversations');
        if (typeof window.__syncInboxMobileOrder === 'function') window.__syncInboxMobileOrder();
      });
      await page.waitForTimeout(SETTLE_MS);
      const closed = await inspect(page);
      ok(`${vp.name}: no standalone handle or Inbox footprint while menu closed`, !closed.standaloneHandle && !closed.dockClass && closed.shellPaddingBottom === 0, JSON.stringify(closed));
      await page.click('#nav-menu-toggle');
      await page.waitForSelector('body.nav-menu-open #tabs > #inbox-shell-channel-defaults.is-nav-menu-mobile');
      await page.waitForTimeout(SETTLE_MS);
      const open = await inspect(page);
      ok(`${vp.name}: original card is immediately before hamburger tools`, open.menuOpen && open.directChild && open.immediatelyBeforeTools && open.mobileClass, JSON.stringify(open));
      ok(`${vp.name}: controls preserve localized title, lock and stored modes`, open.title === 'AUTONOMÍA LUNA' && open.lockPressed === 'false' && open.waAutoPressed === 'true' && open.emailDraftPressed === 'true', JSON.stringify(open));
      await page.evaluate(() => {
        const card = document.getElementById('inbox-shell-channel-defaults');
        const tabs = document.getElementById('tabs');
        const target = document.getElementById('inbox-autonomy-lock');
        if (tabs && card) tabs.scrollTop = Math.max(0, card.offsetTop - 120);
        if (card && target) card.scrollTop = Math.max(0, target.offsetTop - 12);
      });
      let lockPointerReachable = true;
      let lockPointerError = '';
      try { await page.locator('#inbox-autonomy-lock').click({ trial: true, timeout: 5000 }); } catch (e) { lockPointerReachable = false; lockPointerError = String(e && e.message || e).split('\n').slice(-6).join(' | '); }
      await page.evaluate(() => {
        const card = document.getElementById('inbox-shell-channel-defaults');
        const tabs = document.getElementById('tabs');
        const target = card && card.querySelector('[data-inbox-autonomy-channel="whatsapp"][data-inbox-autonomy="auto"]');
        if (tabs && card) tabs.scrollTop = Math.max(0, card.offsetTop - 120);
        if (card && target) card.scrollTop = Math.max(0, target.offsetTop - 12);
      });
      let modePointerReachable = true;
      let modePointerError = '';
      try { await page.locator('[data-inbox-autonomy-channel="whatsapp"][data-inbox-autonomy="auto"]').click({ trial: true, timeout: 5000 }); } catch (e) { modePointerReachable = false; modePointerError = String(e && e.message || e).split('\n').slice(-6).join(' | '); }
      ok(`${vp.name}: menu controls are pointer reachable through the menu scroller`, lockPointerReachable && modePointerReachable, JSON.stringify({ lockPointerReachable, modePointerReachable, lockPointerError, modePointerError, initialLockRect: open.lockRect, initialCardTop: open.cardTop, tabsRect: open.tabsRect }));
      await page.locator('#inbox-autonomy-lock').focus();
      ok(`${vp.name}: lock is keyboard reachable`, await page.evaluate(() => document.activeElement && document.activeElement.id === 'inbox-autonomy-lock'));
      ok(`${vp.name}: Autonomy remains ordered before tools in the constrained menu`, open.cardBottom <= open.toolsTop + 1, JSON.stringify(open));
      await page.close();
    }
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
  console.log(failed ? `verify:mobile-autonomy-hamburger FAILED (${failed})` : 'verify:mobile-autonomy-hamburger passed');
  process.exit(failed ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(1); });
