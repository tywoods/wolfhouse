'use strict';

const fs = require('fs');
const path = require('path');

const state = JSON.parse(fs.readFileSync(path.join(__dirname, '.tmp-stage106e1-state.json'), 'utf8'));
const url = state.payment_link_url;

(async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  console.log('navigating', url.slice(0, 80) + '...');
  await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForTimeout(3000);
  const title = await page.title();
  const text = await page.locator('body').innerText().catch(() => '');
  console.log('title', title);
  console.log('body_snip', text.slice(0, 300));

  if (/Something went wrong|could not be found/i.test(text)) {
    console.log(JSON.stringify({ ok: false, error: 'checkout_page_not_found' }));
    await browser.close();
    process.exit(2);
  }

  const email = page.locator('input[type="email"], input[name="email"], input#email');
  if (await email.count()) {
    await email.first().fill('checkout-proof@example.test');
  }

  const cardFrame = page.frameLocator('iframe').first();
  const num = cardFrame.locator('input[name="cardnumber"], input[name="cardNumber"], input[placeholder*="1234"]');
  if (await num.count()) {
    await num.first().fill('4242424242424242');
    await cardFrame.locator('input[name="exp-date"], input[placeholder*="MM"]').first().fill('12 / 34');
    await cardFrame.locator('input[name="cvc"], input[placeholder*="CVC"]').first().fill('123');
  } else {
    await page.locator('input[placeholder*="1234"], input[name="cardNumber"]').first().fill('4242424242424242', { timeout: 15000 });
    await page.locator('input[placeholder*="MM"], input[name="expiry"]').first().fill('1234');
    await page.locator('input[placeholder*="CVC"], input[name="cvc"]').first().fill('123');
  }

  const zip = page.locator('input[name="postal"], input[name="postalCode"], input[placeholder*="ZIP"]');
  if (await zip.count()) await zip.first().fill('12345');

  const payBtn = page.getByRole('button', { name: /pay/i });
  await payBtn.first().click({ timeout: 30000 });
  await page.waitForTimeout(8000);

  const finalUrl = page.url();
  const finalText = await page.locator('body').innerText().catch(() => '');
  console.log(JSON.stringify({
    ok: true,
    final_url: finalUrl,
    final_snip: finalText.slice(0, 400),
    success_hint: /success|thank|paid|complete/i.test(finalText + finalUrl),
  }, null, 2));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
