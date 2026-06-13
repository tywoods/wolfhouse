'use strict';
/** Stage 45k — complete Stripe TEST checkout (robust selectors). Temp — do not commit. */

const { chromium } = require('playwright');
const { execSync } = require('child_process');

const SESSION_ID = 'cs_test_a142nxPQn5zl4CusjeAxIpk5b2OX5SalnGnCH8NJGswQdpLZGYfAuT3uAM';

function sk() {
  return execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name stripe-secret-key --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
}

async function resolveCheckoutUrl() {
  const stripe = require('stripe')(sk());
  const sess = await stripe.checkout.sessions.retrieve(SESSION_ID);
  if (!sess.url) throw new Error('checkout session has no url');
  return sess.url;
}

(async () => {
  const started = new Date().toISOString();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const checkoutUrl = await resolveCheckoutUrl();
  await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(6000);

  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/Something went wrong|could not be found|expired/i.test(bodyText)) {
    console.log(JSON.stringify({ ok: false, error: 'checkout_unavailable', body_snip: bodyText.slice(0, 300) }, null, 2));
    await browser.close();
    process.exit(2);
  }

  const email = page.locator('input[type="email"], input[name="email"], input#email');
  if (await email.count()) await email.first().fill('stage45k-proof@example.test', { timeout: 20000 });

  const cardAccordion = page.locator('#payment-method-accordion-item-title-card');
  if (await cardAccordion.count()) await cardAccordion.check({ force: true });
  await page.waitForTimeout(2000);

  const cardFrame = page.frameLocator('iframe').first();
  const numInFrame = cardFrame.locator('input[name="cardnumber"], input[name="cardNumber"], input[placeholder*="1234"]');
  if (await numInFrame.count()) {
    await numInFrame.first().fill('4242424242424242');
    await cardFrame.locator('input[name="exp-date"], input[placeholder*="MM"]').first().fill('12 / 34');
    await cardFrame.locator('input[name="cvc"], input[placeholder*="CVC"]').first().fill('123');
  } else {
    await page.locator('input[placeholder*="1234"], input[name="cardNumber"], input#cardNumber').first().fill('4242424242424242', { timeout: 30000 });
    await page.locator('input[placeholder*="MM"], input[name="expiry"], input#cardExpiry').first().fill('12 / 34');
    await page.locator('input[placeholder*="CVC"], input[name="cvc"], input#cardCvc').first().fill('123');
  }

  const name = page.locator('input#billingName, input[name="billingName"]');
  if (await name.count()) await name.first().fill('Stage45k Webhook Proof');

  const payBtn = page.locator('[data-testid="hosted-payment-submit-button"]');
  if (await payBtn.count()) {
    await payBtn.first().click({ timeout: 60000 });
  } else {
    await page.getByRole('button', { name: /pay/i }).first().click({ timeout: 60000 });
  }

  const stripe = require('stripe')(sk());
  let paid = false;
  let poll = null;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2000);
    const sess = await stripe.checkout.sessions.retrieve(SESSION_ID, { expand: ['payment_intent'] });
    poll = {
      i,
      status: sess.status,
      payment_status: sess.payment_status,
      payment_intent: sess.payment_intent && typeof sess.payment_intent === 'object'
        ? { id: sess.payment_intent.id, status: sess.payment_intent.status }
        : sess.payment_intent,
    };
    if (sess.payment_status === 'paid' || sess.status === 'complete') {
      paid = true;
      break;
    }
  }

  console.log(JSON.stringify({
    started,
    finished: new Date().toISOString(),
    final_url: page.url(),
    body_snip: (await page.locator('body').innerText().catch(() => '')).slice(0, 400),
    stripe_session_paid: paid,
    last_poll: poll,
  }, null, 2));

  await browser.close();
  if (!paid) process.exit(2);
})().catch((e) => { console.error(e); process.exit(1); });
