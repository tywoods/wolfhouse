'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const URL = 'https://staff-staging.lunafrontdesk.com/pay/WH-G27-F88DB3CBBD';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForTimeout(8000);
  const png = path.join(__dirname, '.tmp-stage45k-checkout-debug.png');
  await page.screenshot({ path: png, fullPage: true });
  const html = await page.content();
  fs.writeFileSync(path.join(__dirname, '.tmp-stage45k-checkout-debug.html'), html.slice(0, 50000));
  console.log(JSON.stringify({
    url: page.url(),
    title: await page.title(),
    body_snip: (await page.locator('body').innerText()).slice(0, 800),
    has_email: await page.locator('#email').count(),
    has_card: await page.locator('#cardNumber').count(),
    frames: page.frames().map((f) => f.url()).slice(0, 10),
    screenshot: png,
  }, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
