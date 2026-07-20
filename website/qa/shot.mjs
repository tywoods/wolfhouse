// Playwright visual QA: screenshots at several viewports + drives the demo.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.QA_URL || 'http://127.0.0.1:8099/';
const OUT = '/tmp/luna-shots';
mkdirSync(OUT, { recursive: true });

const viewports = [
  { name: 'desktop', width: 1440, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
];

const browser = await chromium.launch();
const errors = [];
for (const vp of viewports) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${vp.name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${vp.name}] PAGEERROR ${e.message}`));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${vp.name}-top.png` });

  // Full page
  await page.screenshot({ path: `${OUT}/${vp.name}-full.png`, fullPage: true });

  // Drive the demo: click a scenario and capture mid-conversation.
  try {
    await page.locator('#demo').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const chip = page.locator('.chip--journey').first();
    if (await chip.count()) {
      await chip.click();
      await page.waitForTimeout(3200); // let a couple turns play
      await page.locator('#demo').screenshot({ path: `${OUT}/${vp.name}-demo.png` });
    }
  } catch (e) {
    errors.push(`[${vp.name}] demo drive: ${e.message}`);
  }
  await ctx.close();
}
await browser.close();
console.log('SHOTS_DONE');
if (errors.length) { console.log('CONSOLE_ERRORS:'); errors.forEach((e) => console.log('  ' + e)); }
else console.log('NO_CONSOLE_ERRORS');
