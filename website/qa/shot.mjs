// Playwright visual QA: screenshots at several viewports + drives the demo.
// Scrolls through the page first so IntersectionObserver reveal fires before the
// full-page capture (otherwise below-fold [data-animate] blocks read as blank).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.QA_URL || 'http://127.0.0.1:8099/';
const OUT = '/tmp/luna-shots';
mkdirSync(OUT, { recursive: true });

const viewports = [
  { name: 'desktop', width: 1440, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
];

// Section anchors/selectors worth an individual capture.
const sections = [
  { id: 'demo', file: 'demo' },
  { sel: '#how', file: 'how' },
  { sel: '.section:has(.eyebrow)', file: null },
];

/** Bounded Node-driven scroll — avoids in-page setInterval hangs and OOM loops. */
async function autoScroll(page) {
  for (let i = 0; i < 48; i++) {
    const done = await page.evaluate(() => {
      const max = Math.max(
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0,
      );
      const next = window.scrollY + Math.round(window.innerHeight * 0.85);
      window.scrollTo(0, next);
      return window.scrollY + window.innerHeight >= max - 4;
    });
    await page.waitForTimeout(70);
    if (done) break;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
}

const browser = await chromium.launch({
  args: ['--disable-dev-shm-usage', '--no-sandbox'],
});
const errors = [];
for (const vp of viewports) {
  // deviceScaleFactor 1 keeps full-page captures under Chromium's texture limit
  // on this long marketing page; section crops still read clearly for QA.
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${vp.name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${vp.name}] PAGEERROR ${e.message}`));
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${vp.name}-top.png` });

  try {
    await autoScroll(page);
  } catch (e) {
    errors.push(`[${vp.name}] autoscroll: ${e.message}`);
  }
  await page.waitForTimeout(400);
  try {
    await page.screenshot({ path: `${OUT}/${vp.name}-full.png`, fullPage: true });
  } catch (e) {
    // Long-page full capture can OOM headless Chromium; viewport shot still exists.
    errors.push(`[${vp.name}] full-shot: ${e.message}`);
    await page.screenshot({ path: `${OUT}/${vp.name}-full.png` }).catch(() => {});
  }

  // Named sections
  for (const s of sections) {
    if (!s.file) continue;
    try {
      const loc = page.locator(s.id ? `#${s.id}` : s.sel).first();
      await loc.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await loc.screenshot({ path: `${OUT}/${vp.name}-${s.file}.png` });
    } catch (e) { errors.push(`[${vp.name}] ${s.file}: ${e.message}`); }
  }

  // Drive the demo interaction
  try {
    await page.locator('#demo').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const chip = page.locator('.chip--journey').first();
    if (await chip.count()) {
      await chip.click();
      await page.waitForTimeout(3400);
      await page.locator('#demo').screenshot({ path: `${OUT}/${vp.name}-demo-active.png` });
    }
  } catch (e) { errors.push(`[${vp.name}] demo drive: ${e.message}`); }

  await ctx.close();
}
await browser.close();
console.log('SHOTS_DONE');
if (errors.length) { console.log('CONSOLE_ERRORS:'); errors.forEach((e) => console.log('  ' + e)); }
else console.log('NO_CONSOLE_ERRORS');
