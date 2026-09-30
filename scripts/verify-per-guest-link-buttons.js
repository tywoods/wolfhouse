'use strict';
// PER-GUEST-BUTTONS-PRICE-LINE-001.
// Name line is the name only. Deposit and Full sit on the price line, left-aligned.
// Wolfhouse keeps Total / Paid / Owe on that same line, to the right.
// Sunset has the same two buttons and no money row. Full only when the share is known.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const i18n = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');

function extractFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing ${name}`);
  let depth = 0;
  let seen = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') { depth++; seen = true; }
    else if (src[i] === '}') {
      depth--;
      if (seen && depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

const names = [
  'pgPayParseMetadata',
  'pgPayGuestSubtotalFromMetadata',
  'bcInvoiceGuestStaffLabel',
  'bcInvoicePaymentRequestDisplay',
  'bcInvoiceTitleCaseStatus',
  'bcRenderPerGuestPaymentsHtml',
  'bcRenderGuestPaymentLinkControlsHtml',
  'bcRequestGuestPaymentLink',
];
function render(client, guests) {
  const sandbox = {
    t(key) {
      const map = {
        'drawer.invoice.guestDeposit': 'Deposit',
        'drawer.invoice.guestFull': 'Full',
        'drawer.invoice.depositLink': 'Deposit Link',
        'drawer.invoice.paymentLink': 'Payment Link',
        'drawer.invoice.createLink': 'Payment Link',
        'drawer.invoice.payStatus.paid': 'Paid',
        'drawer.invoice.payStatus.deposit_paid': 'Deposit paid',
      };
      return map[key] || key;
    },
    escHtml(v) {
      return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
    getClient: () => client,
  };
  vm.createContext(sandbox);
  vm.runInContext(names.map((name) => extractFunctionSource(apiSrc, name)).join('\n\n'), sandbox);
  return sandbox.bcRenderPerGuestPaymentsHtml(guests, [], 'Ada');
}

const open = { guest_number: 1, guest_name: 'Tom', booking_guest_id: 'g1', deposit_amount_cents: 10000, amount_paid_cents: 0, subtotal_cents: 32500, payment_status: 'not_requested' };
const depositPaid = { ...open, guest_number: 2, guest_name: 'Bea', booking_guest_id: 'g2', amount_paid_cents: 10000 };
const settled = { ...open, guest_number: 3, guest_name: 'Cy', booking_guest_id: 'g3', amount_paid_cents: 32500 };
const unknownShare = { guest_number: 4, guest_name: 'No Share', booking_guest_id: 'g4', deposit_amount_cents: 10000, amount_paid_cents: 0, payment_status: 'not_requested' };

const wolf = render('wolfhouse-somo', [open, depositPaid, settled]);
assert(wolf.includes('bc-guest-pay-name-line'), 'Wolfhouse name line');
assert(wolf.includes('bc-guest-pay-price-line'), 'Wolfhouse price line');
assert(wolf.includes('>Deposit<') && wolf.includes('>Full<'), 'Wolfhouse labels');
assert(!wolf.includes('>Deposit Link<') && !wolf.includes('>Payment Link<'), 'old row labels gone');
assert(wolf.includes('bc-guest-pay-money') && wolf.includes('>Total<') && wolf.includes('>Paid<') && wolf.includes('>Owe<') && !wolf.includes('>Price<'), 'money stays on the price line as Total / Paid / Owe');
wolf.split('bc-guest-pay-row').slice(1).forEach((row) => {
  const totalAt = row.indexOf('>Total<');
  const paidAt = row.indexOf('>Paid<');
  const oweAt = row.indexOf('>Owe<');
  assert(totalAt >= 0 && paidAt > totalAt && oweAt > paidAt, 'each guest row is Total then Paid then Owe');
  assert(row.indexOf('bc-guest-pay-price"') < row.indexOf('bc-guest-pay-paid') && row.indexOf('bc-guest-pay-paid') < row.indexOf('bc-guest-pay-owed'), 'Total amount stays the share; Paid and Owe stay on their own amounts');
});
assert(wolf.indexOf('bc-guest-pay-name-line') < wolf.indexOf('bc-guest-pay-price-line'), 'name line precedes the price line');
assert(wolf.indexOf('bc-guest-pay-price-line') < wolf.indexOf('bc-guest-pay-links'), 'buttons sit on the price line');
assert(wolf.indexOf('bc-guest-pay-links') < wolf.indexOf('bc-guest-pay-money'), 'buttons are left of the euros');
assert(!wolf.slice(0, wolf.indexOf('bc-guest-pay-price-line')).includes('bc-create-guest-payment-link-btn'), 'name line has no buttons');
assert((wolf.match(/bc-create-guest-payment-link-btn/g) || []).length === 3, 'hide Deposit when deposit is paid; hide both when the share is paid');
assert(!wolf.includes('data-payment-target="deposit" data-booking-guest-id="g3"'), 'settled guest has no Deposit');
assert(!wolf.includes('data-payment-target="deposit" data-booking-guest-id="g2"'), 'deposit-paid guest has no Deposit');

const sandboxBlocked = {
  t: (key) => key,
  escHtml: (v) => String(v == null ? '' : v),
  getClient: () => 'wolfhouse-somo',
};
vm.createContext(sandboxBlocked);
vm.runInContext(names.map((name) => extractFunctionSource(apiSrc, name)).join('\n\n'), sandboxBlocked);
const fenced = sandboxBlocked.bcRenderPerGuestPaymentsHtml([open], [], 'Ada', true);
assert(!fenced.includes('bc-create-guest-payment-link-btn'), 'booking-level cash receipt still hides both buttons');
assert(fenced.includes('bc-guest-pay-money'), 'fence does not remove the money row');
assert(!fenced.slice(0, fenced.indexOf('bc-guest-pay-price-line')).includes('button'), 'fenced name line stays name-only');

const sunset = render('sunset', [open, depositPaid, unknownShare]);
assert(!sunset.includes('bc-guest-pay-money'), 'Sunset has no money row');
assert(!sunset.includes('bc-guest-pay-row'), 'Sunset does not use the Wolfhouse money row');
assert(sunset.includes('bc-guest-pay-price-line'), 'Sunset buttons still leave the name line');
assert(sunset.includes('>Deposit<') && sunset.includes('>Full<'), 'Sunset gets both labels');
assert(!sunset.slice(0, sunset.indexOf('bc-guest-pay-price-line')).includes('bc-create-guest-payment-link-btn'), 'Sunset name line has no buttons');
const noShare = sunset.slice(sunset.indexOf('No Share'));
assert(noShare.includes('>Deposit<'), 'Sunset Deposit remains when the share is unknown');
assert(!noShare.includes('>Full<') && !noShare.includes('remaining_share'), 'Full only when the remaining share is known');
assert(!sunset.includes('data-payment-target="deposit" data-booking-guest-id="g2"'), 'Sunset hides Deposit once that share is paid');

const dropdown = extractFunctionSource(apiSrc, 'bcRenderGuestPaymentLinkControlsHtml');
assert(dropdown.includes('Guest payment link'), 'dropdown under the list stays');
assert(!dropdown.includes('drawer.invoice.guestDeposit'), 'dropdown is not restyled into Deposit/Full');

const totals = extractFunctionSource(apiSrc, 'bcRenderRunningInvoiceHtml');
assert(totals.includes("t('drawer.invoice.createLink')") || totals.includes("t('drawer.invoice.depositLink')"), 'booking totals keep their own link wording');
assert(!totals.includes('drawer.invoice.guestDeposit'), 'booking totals do not pick up the row labels');

const handler = extractFunctionSource(apiSrc, 'bcRequestGuestPaymentLink');
assert(handler.includes("t('drawer.invoice.guestDeposit')") && handler.includes("t('drawer.invoice.guestFull')"), 'created row link uses Deposit/Full');
assert(handler.includes("t('drawer.invoice.depositLink')") && handler.includes("t('drawer.invoice.paymentLink')"), 'dropdown replacement keeps Deposit Link / Payment Link');
assert(handler.includes('bcInlinePaymentLinkMarkup(link, linkLabel)'), 'copy icon markup stays');

assert(i18n.includes("'drawer.invoice.guestDeposit': 'Deposit'"), 'EN Deposit');
assert(i18n.includes("'drawer.invoice.guestFull': 'Full'"), 'EN Full');
assert(i18n.includes("'drawer.invoice.depositLink': 'Deposit Link'"), 'booking Deposit Link wording stays');
assert(i18n.includes("'drawer.invoice.paymentLink': 'Payment Link'"), 'booking Payment Link wording stays');

assert(apiSrc.includes('.bc-guest-pay-name-line{display:block'), 'name line is the name only');
assert(apiSrc.includes('.bc-guest-pay-price-line{display:flex;align-items:center;justify-content:flex-start;flex-wrap:nowrap'), 'price line keeps buttons and euros on one row');
assert(apiSrc.includes('.bc-guest-pay-links{display:inline-flex;flex:0 0 auto;flex-wrap:nowrap'), 'the two buttons stay together');
assert(apiSrc.includes('margin-left:auto'), 'euros stay on the right of the price line');

async function layoutProof() {
  const { chromium } = require('playwright');
  const cssStart = apiSrc.indexOf('.bc-guest-pay-row{');
  const cssEnd = apiSrc.indexOf(':is(#bc-move-bed');
  const css = apiSrc.slice(cssStart, cssEnd);
  function card(width, name, money) {
    const links = '<span class="bc-guest-pay-links"><span class="bc-guest-pay-action"><button type="button" class="btn btn-ghost bc-create-guest-payment-link-btn">Deposit</button></span><span class="bc-guest-pay-action"><button type="button" class="btn btn-ghost bc-create-guest-payment-link-btn">Full</button></span></span>';
    const moneyHtml = money
      ? '<span class="bc-guest-pay-money"><span class="bc-guest-pay-column"><span class="bc-guest-pay-title">Total</span><span class="bc-guest-pay-price">€325.00</span></span><span class="bc-guest-pay-column"><span class="bc-guest-pay-title">Paid</span><span class="bc-guest-pay-paid">€0.00</span></span><span class="bc-guest-pay-column"><span class="bc-guest-pay-title">Owe</span><span class="bc-guest-pay-owed">€225.00</span></span></span>'
      : '';
    const rowOpen = money ? '<div class="bc-guest-pay-row">' : '';
    const rowClose = money ? '</div>' : '';
    return '<div class="card" data-kind="' + (money ? 'wolf' : 'sunset') + '" style="width:' + width + 'px">' + rowOpen
      + '<div class="bc-guest-pay-name-line"><span class="bc-guest-pay-name">' + name + '</span></div>'
      + '<div class="bc-guest-pay-price-line">' + links + moneyHtml + '</div>'
      + rowClose + '</div>';
  }
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:14px/1.4 system-ui,sans-serif}' + css + '.card{box-sizing:border-box;padding:8px}</style></head><body>'
    + card(388, 'Tom', true)
    + card(320, 'Alexandria Verylongsurname (test)', true)
    + card(230, 'Tom', true)
    + card(320, 'Alexandria Verylongsurname (test)', false)
    + '</body></html>';
  const browser = await chromium.launch({ headless: true });
  async function measure(viewportWidth) {
    const page = await browser.newPage({ viewport: { width: viewportWidth, height: 800 } });
    await page.setContent(html);
    const rows = await page.locator('.card').evaluateAll((els) => els.map((card) => {
      const name = card.querySelector('.bc-guest-pay-name').getBoundingClientRect();
      const line = card.querySelector('.bc-guest-pay-price-line').getBoundingClientRect();
      const links = card.querySelector('.bc-guest-pay-links').getBoundingClientRect();
      const buttons = [...card.querySelectorAll('button')].map((b) => b.getBoundingClientRect().toJSON());
      const money = card.querySelector('.bc-guest-pay-money');
      const moneyBox = money ? money.getBoundingClientRect() : null;
      const price = card.querySelector('.bc-guest-pay-price');
      const owed = card.querySelector('.bc-guest-pay-owed');
      const titles = [...card.querySelectorAll('.bc-guest-pay-title')].map((el) => ({
        text: el.textContent,
        left: el.getBoundingClientRect().left,
      }));
      return {
        width: Math.round(card.getBoundingClientRect().width),
        kind: card.getAttribute('data-kind'),
        name: name.toJSON(),
        line: line.toJSON(),
        links: links.toJSON(),
        buttons,
        money: moneyBox ? moneyBox.toJSON() : null,
        oweRight: owed ? owed.getBoundingClientRect().right : null,
        priceLeft: price ? price.getBoundingClientRect().left : null,
        titles,
        lineRight: line.right,
        overflow: card.scrollWidth > card.clientWidth + 1,
        nameHasButton: !!card.querySelector('.bc-guest-pay-name-line button'),
      };
    }));
    await page.close();
    return rows;
  }
  const pc = await measure(1440);
  const phone = await measure(390);
  await browser.close();
  const [shortPc] = pc;
  const [, longPhone, tightPhone, sunsetPhone] = phone;
  function sameLine(row) {
    assert(row.money, 'Wolfhouse price line has money');
    assert(Math.abs(row.buttons[0].top - row.money.top) < 8, 'Deposit shares the price line with Total/Paid/Owe');
    assert(row.buttons[0].right <= row.money.left + 1, 'buttons sit left of the euros');
    assert(row.links.left - row.line.left <= 2, 'Deposit/Full are left-aligned');
    assert(row.oweRight >= row.lineRight - 2, 'Owe stays on the right');
    assert(row.titles.map((t) => t.text).join(',') === 'Total,Paid,Owe', 'labels read Total then Paid then Owe');
    assert(row.titles[0].left < row.titles[1].left && row.titles[1].left < row.titles[2].left, 'Total is left of Paid is left of Owe');
    assert(row.priceLeft < row.titles[1].left, 'Total amount stays with the Total label, left of Paid');
    assert(row.name.bottom <= row.buttons[0].top + 1, 'name line is above the price line');
    assert(Math.abs(row.buttons[0].top - row.buttons[1].top) < 2, 'Deposit and Full stay together');
    assert(!row.nameHasButton, 'name line has no buttons');
    assert(!row.overflow, 'row does not overflow at ' + row.width);
  }
  sameLine(shortPc);
  sameLine(longPhone);
  sameLine(tightPhone);
  assert(sunsetPhone.money == null, 'Sunset fixture has no money row');
  assert(sunsetPhone.links.left - sunsetPhone.line.left <= 2, 'Sunset buttons are left-aligned');
  assert(sunsetPhone.name.bottom <= sunsetPhone.buttons[0].top + 1, 'Sunset name is above the buttons');
  assert(Math.abs(sunsetPhone.buttons[0].top - sunsetPhone.buttons[1].top) < 2, 'Sunset buttons stay together');
  assert(!sunsetPhone.nameHasButton, 'Sunset name line has no buttons');
  assert(!sunsetPhone.overflow, 'Sunset row does not overflow');
  console.log(JSON.stringify({
    pc: { width: shortPc.width, linksLeft: Math.round(shortPc.links.left - shortPc.line.left), btnTop: Math.round(shortPc.buttons[0].top), moneyTop: Math.round(shortPc.money.top) },
    phone320: { width: longPhone.width, btnTop: Math.round(longPhone.buttons[0].top), moneyTop: Math.round(longPhone.money.top), overflow: longPhone.overflow },
    phone230: { width: tightPhone.width, overflow: tightPhone.overflow },
    sunset: { width: sunsetPhone.width, linksLeft: Math.round(sunsetPhone.links.left - sunsetPhone.line.left) },
  }));
}

layoutProof().then(() => {
  console.log('verify-per-guest-link-buttons: ok');
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
