'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const state = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.tmp-stage106e1-state.json'), 'utf8'));
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(state.payment_link_url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(6000);
  await page.locator('#email').fill('test@example.com');
  await page.locator('#payment-method-accordion-item-title-card').check({ force: true });
  await page.waitForTimeout(4000);
  for (const frame of page.frames()) {
    const inputs = await frame.locator('input').evaluateAll((els) =>
      els.map((e) => ({ name: e.name, type: e.type, ph: e.placeholder, ac: e.autocomplete, id: e.id })));
    if (inputs.length) console.log(frame.url().slice(0, 100), inputs);
  }
  await browser.close();
})();
