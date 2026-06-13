'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const state = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.tmp-stage106e1-state.json'), 'utf8'));
const url = state.payment_link_url;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(4000);

  await page.locator('#email').fill('checkout-proof@example.test', { timeout: 20000 });
  await page.locator('#payment-method-accordion-item-title-card').check({ force: true });
  await page.waitForTimeout(2000);

  await page.locator('#cardNumber').fill('4242424242424242');
  await page.locator('#cardExpiry').fill('12 / 34');
  await page.locator('#cardCvc').fill('123');
  await page.locator('#billingName').fill('Stage106e1 Checkout Proof');

  const submit = page.locator('[data-testid="hosted-payment-submit-button"]');
  await submit.click({ timeout: 60000 });

  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    const stripe = require('stripe')(execSync(
      'az keyvault secret show --vault-name wh-staging-kv --name stripe-secret-key --query value -o tsv',
      { encoding: 'utf8' },
    ).trim());
    const sess = await stripe.checkout.sessions.retrieve(state.session_id);
    if (sess.payment_status === 'paid' || sess.status === 'complete') {
      console.log(JSON.stringify({
        ok: true,
        poll_i: i,
        final_url: page.url(),
        stripe_session: { status: sess.status, payment_status: sess.payment_status },
      }, null, 2));
      await browser.close();
      return;
    }
  }

  const stripe = require('stripe')(execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name stripe-secret-key --query value -o tsv',
    { encoding: 'utf8' },
  ).trim());
  const sess = await stripe.checkout.sessions.retrieve(state.session_id);
  console.log(JSON.stringify({
    ok: false,
    final_url: page.url(),
    body_snip: (await page.locator('body').innerText()).slice(0, 400),
    stripe_session: { status: sess.status, payment_status: sess.payment_status },
  }, null, 2));
  await browser.close();
  process.exit(2);
})().catch((e) => { console.error(e); process.exit(1); });
