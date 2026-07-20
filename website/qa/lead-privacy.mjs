// Browser checks for lead truth/privacy on a built preview.
import { chromium } from 'playwright';

const BASE = process.env.QA_URL || 'http://127.0.0.1:8099/';

const browser = await chromium.launch({
  args: ['--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage();
const network = [];

page.on('request', (req) => {
  const url = req.url();
  if (req.method() === 'POST' || url.includes('/api/leads')) {
    network.push(`${req.method()} ${url}`);
  }
});

const failures = [];

await page.goto(new URL('/', BASE).href, { waitUntil: 'load' });
await page.locator('#lead').scrollIntoViewIfNeeded();
// client:visible hydrates when the island enters the viewport.
await page.locator('.lf-form').waitFor({ state: 'visible', timeout: 15000 });
await page.getByTestId('lead-disabled-truth').waitFor({ state: 'visible', timeout: 15000 });

const truth = page.getByTestId('lead-disabled-truth');
if (!(await truth.innerText()).match(/will not send or save/i)) {
  failures.push('truth copy missing send/save denial');
}

const privacyBeside = page.getByTestId('lead-privacy-link');
if (!(await privacyBeside.count()) || (await privacyBeside.getAttribute('href')) !== '/privacy/') {
  failures.push('privacy link beside submit missing');
}

const maxName = await page.locator('#name').getAttribute('maxlength');
const maxBiz = await page.locator('#businessName').getAttribute('maxlength');
const maxContact = await page.locator('#contact').getAttribute('maxlength');
const maxFree = await page.locator('#freeText').getAttribute('maxlength');
if (maxName !== '100' || maxBiz !== '150' || maxContact !== '254' || maxFree !== '1000') {
  failures.push(`unexpected maxlengths: ${maxName}/${maxBiz}/${maxContact}/${maxFree}`);
}

await page.fill('#name', 'QA Tester');
await page.fill('#businessName', 'QA Hostel');
await page.fill('#contact', 'qa@example.com');
await page.selectOption('#businessType', 'hostel');
await page.locator('.lf-submit').click();

try {
  await page.getByTestId('lead-local-outcome').waitFor({ state: 'visible', timeout: 10000 });
} catch {
  failures.push('post-submit local outcome never appeared (hydration/submit?)');
}

if (await page.getByTestId('lead-local-outcome').count()) {
  const outcomeText = await page.getByTestId('lead-local-outcome').innerText();
  if (!/Nothing was sent or saved/i.test(outcomeText)) {
    failures.push('post-submit missing honest local outcome');
  }
  if (/you're on the list|we've noted|captured/i.test(outcomeText)) {
    failures.push('post-submit used success/captured language');
  }

  if ((await page.inputValue('#name')) !== 'QA Tester') {
    failures.push('name not retained after submit');
  }
  if ((await page.inputValue('#businessName')) !== 'QA Hostel') {
    failures.push('business name not retained after submit');
  }

  const mailto = page.getByTestId('lead-mailto');
  const href = await mailto.getAttribute('href');
  if (!href || !href.startsWith('mailto:hello@lunafrontdesk.com?')) {
    failures.push(`bad mailto href: ${href}`);
  } else if (!href.includes(encodeURIComponent('QA Tester'))) {
    failures.push('mailto not encoded with form values');
  }
}

if (network.length) {
  failures.push(`unexpected lead network calls: ${network.join(', ')}`);
}

await page.goto(new URL('/privacy/', BASE).href, { waitUntil: 'load' });
const body = await page.locator('main').innerText();
const required = [
  'Controller',
  'What we may collect',
  'Purpose',
  'Recipients',
  'Retention',
  'rights',
  'sale',
  'disabled',
  'analytics',
  '/api/leads',
];
for (const needle of required) {
  if (!new RegExp(needle, 'i').test(body)) {
    failures.push(`privacy page missing section cue: ${needle}`);
  }
}

const footerLink = page.getByTestId('footer-privacy-link');
if (!(await footerLink.count())) failures.push('footer privacy link missing');

await browser.close();

if (failures.length) {
  console.error('LEAD_PRIVACY_QA_FAIL');
  failures.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('LEAD_PRIVACY_QA_OK');
console.log('NO_LEAD_NETWORK');
