#!/usr/bin/env node
'use strict';

/**
 * INBOX-LIST-HOVER-AND-DELETE-X-001
 *
 * Full-view middle column: hover/selected rows sit on the continuous list
 * panel surface (no stable-gutter void beside the highlight; soft tint not an
 * opaque floating slab). Conversation delete × is plain grey — no red circle.
 *
 * Run:
 *   node scripts/verify-inbox-list-hover-delete-x.js
 */

const fs = require('fs');
const path = require('path');
const {
  buildPortalHtml,
  startFixtureServer,
  loadPlaywright,
  openInbox,
  SETTLE_MS,
} = require('./verify-inbox-columns-playwright');

const ROOT = path.join(__dirname, '..');
const SHELL = path.join(ROOT, 'scripts/browser/inbox-shell.js');
const OUT_DIR = path.join(ROOT, 'tmp', 'inbox-list-hover-delete-x');
const ARTIFACTS = '/opt/cursor/artifacts';

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${label}${detail === undefined ? '' : `  (${detail})`}`);
  return false;
}

function sourceAssertions() {
  console.log('\n[inbox-list-hover-delete-x] 1. Source');
  const shell = fs.readFileSync(SHELL, 'utf8');
  ok('ticket marker present', shell.includes('INBOX-LIST-HOVER-AND-DELETE-X-001'));
  ok('desktop left-rows uses scrollbar-gutter:auto (no stable void strip)',
    /inbox-left-rows\{[^}]*scrollbar-gutter:auto/.test(shell));
  ok('desktop left-rows paints the same panel surface',
    /inbox-left-rows\{[^}]*background:var\(--surface-soft\)/.test(shell));
  ok('dark hover is a soft tint, not opaque #2a2a2a slab',
    /#conv-list \.conv-card:hover\{[\s\S]{0,80}background:rgba\(255,255,255,\.06\)/.test(shell)
    || /conv-card:hover\{background:rgba\(255,255,255,\.06\)\}/.test(shell));
  ok('no opaque dark hover slab remains on Full-view list',
    !/#conv-list \.conv-card:hover\{[\s\S]{0,40}background:#2a2a2a/.test(shell));
  ok('delete × is grey, transparent, no circle radius',
    /border-radius:0;background:transparent!important;color:var\(--text-3\)/.test(shell)
    && !/conv-card-delete\{[^}]*border-radius:999px/.test(shell)
    && !/color:#9C3D3D;background:rgba\(156,61,61/.test(shell));
  ok('mobile 44px tap target kept',
    /@media\(max-width:768px\)[\s\S]{0,320}\.conv-card-delete\{opacity:\.72;width:44px;height:44px;min-width:44px/.test(shell));
}

async function seedShortList(page) {
  await page.evaluate(() => {
    const list = document.getElementById('conv-list');
    if (!list) return;
    const mk = (i, name) => (
      `<button type="button" class="conv-card inbox-row" data-id="r${i}">` +
      `<span class="inbox-row-avatar">G${i}</span>` +
      `<span class="inbox-row-body"><span class="conv-card-header-row">` +
      `<span class="conv-card-name">${name}</span>` +
      `<button type="button" class="conv-card-delete" title="Delete conversation" ` +
      `aria-label="Delete conversation permanently">&times;</button>` +
      `</span></span></button>`
    );
    list.innerHTML = [mk(0, 'Simulate Guest'), mk(1, 'Eva'), mk(2, 'Felipe')].join('');
    const shell = document.getElementById('inbox-shell');
    if (shell) {
      shell.classList.add('inbox-two-col', 'inbox-shell-cols');
      shell.setAttribute('data-col1', 'full');
      shell.setAttribute('data-col2', 'comfortable');
      shell.setAttribute('data-col4', 'peek');
      shell.classList.remove('show-thread');
    }
    if (typeof window.__syncInboxMobileOrder === 'function') window.__syncInboxMobileOrder();
  });
}

async function browserAssertions() {
  console.log('\n[inbox-list-hover-delete-x] 2. Desktop browser');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
  } catch (_) { /* optional */ }

  const playwright = loadPlaywright();
  if (!playwright) {
    ok('playwright available', false, 'run npm ci');
    return;
  }

  const { server, base } = await startFixtureServer(buildPortalHtml());
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await openInbox(page, base);
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-portal-client', 'sunset');
      document.documentElement.setAttribute('data-theme', 'dark');
      document.body.style.background = '#181818';
      const btn = document.querySelector('[data-inbox-preset="all4"]');
      if (btn && typeof btn.click === 'function') btn.click();
    });
    await page.waitForTimeout(SETTLE_MS);
    await seedShortList(page);
    await page.waitForTimeout(80);

    const card = page.locator('#conv-list .conv-card').first();
    await card.hover();
    await page.waitForTimeout(80);

    const measured = await page.evaluate(() => {
      const left = document.querySelector('#inbox-shell .inbox-left');
      const rows = document.querySelector('#inbox-shell .inbox-left-rows');
      const list = document.getElementById('conv-list');
      const cardEl = list && list.querySelector('.conv-card');
      const del = cardEl && cardEl.querySelector('.conv-card-delete');
      if (!left || !rows || !list || !cardEl || !del) return { ok: false, reason: 'missing nodes' };

      const lr = left.getBoundingClientRect();
      const cr = cardEl.getBoundingClientRect();
      const csRows = getComputedStyle(rows);
      const csCard = getComputedStyle(cardEl);
      const csDel = getComputedStyle(del);
      const csLeft = getComputedStyle(left);

      return {
        ok: true,
        gutter: csRows.scrollbarGutter,
        rowsBg: csRows.backgroundColor,
        leftBg: csLeft.backgroundColor,
        cardBg: csCard.backgroundColor,
        cardInsetRight: Math.round(lr.right - cr.right),
        cardInsetLeft: Math.round(cr.left - lr.left),
        listW: Math.round(list.getBoundingClientRect().width),
        rowsContentW: rows.clientWidth,
        del: {
          color: csDel.color,
          bg: csDel.backgroundColor,
          radius: csDel.borderRadius,
          opacity: csDel.opacity,
          boxShadow: csDel.boxShadow,
        },
      };
    });

    ok('hover measure succeeded', measured.ok, JSON.stringify(measured));
    ok('short-list left-rows gutter is auto (not stable)',
      measured.ok && measured.gutter === 'auto',
      JSON.stringify({ gutter: measured.gutter }));
    ok('hovered row reaches near the panel right edge (no 16px void strip)',
      measured.ok && measured.cardInsetRight <= 4,
      JSON.stringify({
        cardInsetRight: measured.cardInsetRight,
        cardInsetLeft: measured.cardInsetLeft,
        listW: measured.listW,
        rowsContentW: measured.rowsContentW,
      }));
    ok('hovered row uses a translucent tint (not opaque #2a2a2a)',
      measured.ok && /rgba\(\s*255,\s*255,\s*255/i.test(measured.cardBg),
      measured.cardBg);
    ok('left-rows panel bg matches column surface',
      measured.ok && measured.rowsBg === measured.leftBg,
      JSON.stringify({ rowsBg: measured.rowsBg, leftBg: measured.leftBg }));
    ok('delete × visible on hover, grey, transparent, no circle',
      measured.ok
      && Number(measured.del.opacity) > 0.5
      && /rgba\(0,\s*0,\s*0,\s*0\)|transparent/i.test(measured.del.bg)
      && (measured.del.radius === '0px' || measured.del.radius === '0')
      && !/rgb\(\s*15[0-9]|rgb\(\s*9[0-9],\s*[3-6][0-9]/.test(measured.del.color)
      && (measured.del.boxShadow === 'none' || !measured.del.boxShadow),
      JSON.stringify(measured.del));

    const hoverPath = path.join(OUT_DIR, 'desktop-hover-delete-x-dark.png');
    await page.screenshot({ path: hoverPath, fullPage: false });
    try {
      fs.copyFileSync(hoverPath, path.join(ARTIFACTS, 'inbox-list-hover-delete-x-dark.png'));
    } catch (_) { /* optional */ }

    console.log('\n[inbox-list-hover-delete-x] 3. Mobile delete chrome');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(SETTLE_MS);
    await seedShortList(page);
    const mobileDel = await page.evaluate(() => {
      const del = document.querySelector('#conv-list .conv-card-delete');
      if (!del) return null;
      const cs = getComputedStyle(del);
      return {
        opacity: cs.opacity,
        width: cs.width,
        height: cs.height,
        bg: cs.backgroundColor,
        radius: cs.borderRadius,
        color: cs.color,
      };
    });
    ok('mobile delete keeps 44px target, grey, no circle fill',
      mobileDel
      && Number.parseFloat(mobileDel.width) >= 44
      && Number.parseFloat(mobileDel.height) >= 44
      && Number(mobileDel.opacity) > 0.5
      && /rgba\(0,\s*0,\s*0,\s*0\)|transparent/i.test(mobileDel.bg)
      && (mobileDel.radius === '0px' || mobileDel.radius === '0'),
      JSON.stringify(mobileDel));

    fs.writeFileSync(
      path.join(OUT_DIR, 'measurements.json'),
      `${JSON.stringify({ desktop: measured, mobile: mobileDel }, null, 2)}\n`,
    );
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

async function main() {
  sourceAssertions();
  await browserAssertions();
  console.log(`\n── verify:inbox-list-hover-delete-x: ${pass} passed, ${fail} failed ──`);
  return fail ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };
