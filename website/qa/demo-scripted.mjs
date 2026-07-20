// Browser checks for Slice D scripted demo isolation + mobile a11y.
import { chromium } from 'playwright';

const BASE = process.env.QA_URL || 'http://127.0.0.1:8099/';
const TRUTH =
  'Interactive scripted demo — stays in this browser; no WhatsApp, live availability, booking, payment or staff write';

const browser = await chromium.launch({
  args: ['--disable-dev-shm-usage', '--no-sandbox'],
});

const failures = [];

async function assertMinSize(locator, label, min = 44) {
  const box = await locator.boundingBox();
  if (!box) {
    failures.push(`${label}: missing box`);
    return;
  }
  if (box.width < min - 0.5 || box.height < min - 0.5) {
    failures.push(`${label}: ${Math.round(box.width)}x${Math.round(box.height)} < ${min}`);
  }
}

async function runViewport(width, height, name) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  const network = [];
  const storageWrites = [];

  page.on('request', (req) => {
    const url = req.url();
    // Allow document + same-origin static assets only; flag XHR/fetch/websocket/beacon.
    const type = req.resourceType();
    if (['xhr', 'fetch', 'websocket', 'ping', 'eventsource'].includes(type)) {
      network.push(`${type} ${req.method()} ${url}`);
    }
  });

  await page.addInitScript(() => {
    const wrap = (proto, key, bag) => {
      const orig = proto[key];
      proto[key] = function (...args) {
        bag.push(`${key}`);
        return orig.apply(this, args);
      };
    };
    window.__demoStorageWrites = [];
    wrap(Storage.prototype, 'setItem', window.__demoStorageWrites);
    wrap(Storage.prototype, 'removeItem', window.__demoStorageWrites);
    wrap(Storage.prototype, 'clear', window.__demoStorageWrites);
  });

  await page.goto(new URL('/', BASE).href, { waitUntil: 'load' });
  await page.locator('#demo').scrollIntoViewIfNeeded();
  await page.getByTestId('demo-studio').waitFor({ state: 'visible', timeout: 15000 });

  const truth = page.getByTestId('demo-truth-label');
  if (!(await truth.isVisible()) || !(await truth.innerText()).includes(TRUTH.slice(0, 40))) {
    failures.push(`[${name}] truth label missing/hidden`);
  }

  // No free-text controls
  if ((await page.locator('#demo input, #demo textarea').count()) > 0) {
    failures.push(`[${name}] free-text control present in demo`);
  }

  // Interactive demo nav
  const live = page.getByRole('link', { name: /Live demo/i });
  if ((await live.count()) > 0) failures.push(`[${name}] Live demo link still present`);

  // Drive flagship scenario
  const scenario = page.getByTestId('demo-scenario-hostel-accommodation');
  await scenario.click();
  await page.waitForTimeout(800);

  // Continue scripted path through completion
  for (let i = 0; i < 6; i++) {
    const cont = page.getByTestId('demo-continue');
    if (await cont.isEnabled()) {
      await cont.click();
      await page.waitForTimeout(500);
    } else {
      const chip = page.locator('.chip--reply').first();
      if ((await chip.count()) && (await chip.isEnabled())) {
        await chip.click();
        await page.waitForTimeout(500);
      } else break;
    }
  }

  const opsText = await page.getByTestId('demo-ops-list').innerText();
  if (!/Simulated/i.test(opsText)) failures.push(`[${name}] ops missing Simulated qualification`);
  if (/https?:\/\//i.test(opsText)) failures.push(`[${name}] checkout/http URL in ops`);
  if ((await page.locator('#demo a[href*="checkout"], #demo a[href*="stripe"], #demo a[href*="pay"]').count()) > 0) {
    failures.push(`[${name}] checkout control present`);
  }

  const panelTitle = page.locator('.ops__title');
  if (!(await panelTitle.innerText()).match(/Simulated operations summary/i)) {
    failures.push(`[${name}] staff panel title wrong`);
  }

  // Touch targets
  await assertMinSize(page.locator('.studio__biz-tab').first(), `[${name}] biz tab`);
  await assertMinSize(page.locator('.chip--journey').first(), `[${name}] scenario chip`);
  await assertMinSize(page.getByTestId('demo-continue'), `[${name}] continue`);
  if ((await page.getByTestId('demo-reset').count()) > 0) {
    await assertMinSize(page.getByTestId('demo-reset'), `[${name}] reset`);
  }

  if (width <= 720) {
    const tabs = page.getByTestId('demo-panel-tabs');
    if (!(await tabs.isVisible())) failures.push(`[${name}] panel tabs not visible`);
    await assertMinSize(page.getByTestId('demo-tab-chat'), `[${name}] chat tab`);
    await assertMinSize(page.getByTestId('demo-tab-ops'), `[${name}] ops tab`);

    // Roving tabindex + arrows
    const chatTab = page.getByTestId('demo-tab-chat');
    const opsTab = page.getByTestId('demo-tab-ops');
    await chatTab.focus();
    await page.keyboard.press('ArrowRight');
    if ((await opsTab.getAttribute('aria-selected')) !== 'true') {
      failures.push(`[${name}] ArrowRight did not select Operations`);
    }
    if ((await opsTab.getAttribute('tabindex')) !== '0') {
      failures.push(`[${name}] Operations tabIndex not 0 after arrow`);
    }
    await page.keyboard.press('Home');
    if ((await chatTab.getAttribute('aria-selected')) !== 'true') {
      failures.push(`[${name}] Home did not select Chat`);
    }
    await page.keyboard.press('End');
    if ((await opsTab.getAttribute('aria-selected')) !== 'true') {
      failures.push(`[${name}] End did not select Operations`);
    }

    // Both contexts reachable
    await page.getByTestId('demo-tab-chat').click();
    if (!(await page.getByTestId('demo-chat-panel').isVisible())) {
      failures.push(`[${name}] chat panel not visible`);
    }
    await page.getByTestId('demo-tab-ops').click();
    if (!(await page.getByTestId('demo-ops-panel').isVisible())) {
      failures.push(`[${name}] ops panel not visible`);
    }
  }

  // Overflow: studio should not exceed viewport width
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="demo-studio"]');
    if (!el) return 'missing studio';
    const r = el.getBoundingClientRect();
    return r.width > window.innerWidth + 1 ? `studio width ${r.width} > ${window.innerWidth}` : null;
  });
  if (overflow) failures.push(`[${name}] ${overflow}`);

  const writes = await page.evaluate(() => window.__demoStorageWrites || []);
  storageWrites.push(...writes);
  if (network.length) failures.push(`[${name}] unexpected network: ${network.join('; ')}`);
  if (storageWrites.length) failures.push(`[${name}] storage writes: ${storageWrites.join(',')}`);

  await ctx.close();
}

await runViewport(390, 844, 'mobile-390');
await runViewport(320, 568, 'mobile-320');
await runViewport(1440, 1024, 'desktop');

await browser.close();

if (failures.length) {
  console.error('DEMO_QA_FAIL');
  for (const f of failures) console.error(' -', f);
  process.exit(1);
}
console.log('DEMO_QA_OK');
