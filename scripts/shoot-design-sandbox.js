'use strict';

/**
 * Screenshot the design sandbox.
 *
 * Usage:
 *   node scripts/shoot-design-sandbox.js [--tab=day-schedule] [--out=/tmp/shot.png]
 *                                        [--width=1440] [--height=900] [--full]
 *
 * Env: DESIGN_SANDBOX_URL (default https://design-sunset.lunafrontdesk.com)
 *      DESIGN_SANDBOX_EMAIL, DESIGN_SANDBOX_PASSWORD
 */

const { chromium } = require('playwright');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const BASE = (process.env.DESIGN_SANDBOX_URL || 'https://design-sunset.lunafrontdesk.com').replace(/\/$/, '');
const EMAIL = process.env.DESIGN_SANDBOX_EMAIL || '';
const PASSWORD = process.env.DESIGN_SANDBOX_PASSWORD || '';
const TAB = arg('tab', 'portal-home');
const OUT = arg('out', '/tmp/design-sandbox.png');
const WIDTH = Number(arg('width', 1440));
const HEIGHT = Number(arg('height', 900));

(async () => {
  if (!EMAIL || !PASSWORD) {
    console.error('Set DESIGN_SANDBOX_EMAIL and DESIGN_SANDBOX_PASSWORD.');
    process.exit(1);
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(`${BASE}/staff/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await Promise.all([
    page.waitForURL('**/staff/ui', { timeout: 60000 }),
    page.click('button[type="submit"]'),
  ]);

  // The portal is one page of tabs; click through to the one we want.
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  const tabSel = `[data-tab="${TAB}"]`;
  if (await page.locator(tabSel).count()) {
    await page.locator(tabSel).first().click();
    await page.waitForTimeout(2500);
  } else {
    console.warn(`No tab control matched ${tabSel} — shooting whatever loaded.`);
  }
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);

  await page.screenshot({ path: OUT, fullPage: flag('full') });
  console.log(`saved ${OUT}`);
  if (consoleErrors.length) {
    console.log(`\nconsole errors (${consoleErrors.length}):`);
    consoleErrors.slice(0, 15).forEach((e) => console.log(`  - ${e.slice(0, 200)}`));
  } else {
    console.log('no console errors');
  }

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
