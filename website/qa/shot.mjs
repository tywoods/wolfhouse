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

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const step = Math.round(window.innerHeight * 0.7);
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        y += step;
        if (y >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          setTimeout(resolve, 250);
        }
      }, 90);
    });
  });
}

const browser = await chromium.launch();
const errors = [];
for (const vp of viewports) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${vp.name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${vp.name}] PAGEERROR ${e.message}`));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${vp.name}-top.png` });

  await autoScroll(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${vp.name}-full.png`, fullPage: true });

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
