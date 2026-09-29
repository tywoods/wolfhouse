'use strict';
// PER-GUEST-LINK-BUTTONS-REDESIGN-001 option 1.
// Deposit and Full sit on the name line. Paid / Owe / Price are the next line.
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
assert(wolf.includes('>Deposit<') && wolf.includes('>Full<'), 'Wolfhouse labels');
assert(!wolf.includes('>Deposit Link<') && !wolf.includes('>Payment Link<'), 'old row labels gone');
assert(wolf.includes('bc-guest-pay-money') && wolf.includes('>Paid<') && wolf.includes('>Owe<') && wolf.includes('>Price<'), 'money stays, on its own row markup');
assert(wolf.indexOf('bc-guest-pay-name-line') < wolf.indexOf('bc-guest-pay-money'), 'buttons markup precedes the money row');
assert((wolf.match(/bc-create-guest-payment-link-btn/g) || []).length === 3, 'hide Deposit when deposit is paid; hide both when the share is paid');
assert(!wolf.includes('data-payment-target="deposit" data-booking-guest-id="g3"'), 'settled guest has no Deposit');
assert(!wolf.includes('data-booking-guest-id="g2"') || !wolf.includes('data-payment-target="deposit" data-booking-guest-id="g2"'), 'deposit-paid guest has no Deposit');

const blocked = render('wolfhouse-somo', [open]);
// collectionBlocked is the 4th arg.
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

const sunset = render('sunset', [open, depositPaid, unknownShare]);
assert(!sunset.includes('bc-guest-pay-money'), 'Sunset has no money row');
assert(!sunset.includes('bc-guest-pay-row'), 'Sunset does not use the Wolfhouse money row');
assert(sunset.includes('>Deposit<') && sunset.includes('>Full<'), 'Sunset gets both labels');
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

assert(apiSrc.includes('.bc-guest-pay-name-line{display:flex;flex-wrap:wrap'), 'name line wraps');
assert(apiSrc.includes('.bc-guest-pay-links{display:inline-flex;flex:0 0 auto;flex-wrap:nowrap'), 'the two buttons stay together');
assert(apiSrc.includes('min-width:min(100%,max-content)'), 'a long name takes the line so the buttons drop under it');

async function layoutProof() {
  const { chromium } = require('playwright');
  const cssStart = apiSrc.indexOf('.bc-guest-pay-row{');
  const cssEnd = apiSrc.indexOf(':is(#bc-move-bed');
  const css = apiSrc.slice(cssStart, cssEnd);
  const btn = 'padding:2px 9px;font-size:11px;line-height:1.5;white-space:nowrap';
  function card(width, name, money) {
    const links = '<span class="bc-guest-pay-links"><button type="button" class="btn btn-ghost" style="' + btn + '">Deposit</button><button type="button" class="btn btn-ghost" style="' + btn + '">Full</button></span>';
    const moneyHtml = money
      ? '<span class="bc-guest-pay-money"><span class="bc-guest-pay-column"><span class="bc-guest-pay-title">Paid</span><span class="bc-guest-pay-paid">€0.00</span></span><span class="bc-guest-pay-column"><span class="bc-guest-pay-title">Owe</span><span class="bc-guest-pay-owed">€225.00</span></span><span class="bc-guest-pay-column"><span class="bc-guest-pay-title">Price</span><span class="bc-guest-pay-price">€325.00</span></span></span>'
      : '';
    return '<div class="card" style="width:' + width + 'px"><div class="bc-guest-pay-row"><div class="bc-guest-pay-name-line"><span class="bc-guest-pay-name">' + name + '</span>' + links + '</div>' + moneyHtml + '</div></div>';
  }
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:14px/1.4 system-ui,sans-serif}' + css + '.card{box-sizing:border-box;padding:8px}</style></head><body>'
    + card(388, 'Tom', true)
    + card(272, 'Alexandria Verylongsurname (test)', true)
    + card(272, 'Alexandria Verylongsurname (test)', false)
    + '</body></html>';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 480, height: 800 } });
  await page.setContent(html);
  const rows = await page.locator('.bc-guest-pay-row').evaluateAll((els) => els.map((e) => {
    const box = (s) => e.querySelector(s).getBoundingClientRect().toJSON();
    const buttons = [...e.querySelectorAll('button')].map((b) => b.getBoundingClientRect().toJSON());
    const money = e.querySelector('.bc-guest-pay-money');
    return {
      width: Math.round(e.getBoundingClientRect().width),
      name: box('.bc-guest-pay-name'),
      links: box('.bc-guest-pay-links'),
      buttons,
      money: money ? money.getBoundingClientRect().toJSON() : null,
      overflow: e.scrollWidth > e.clientWidth + 1,
    };
  }));
  await browser.close();
  const [shortPc, longPhone, sunsetPhone] = rows;
  assert(Math.abs(shortPc.buttons[0].top - shortPc.name.top) < 8, 'short name keeps Deposit on the name line');
  assert(shortPc.buttons[0].left >= shortPc.name.right - 1, 'short-name buttons sit after the name');
  assert(shortPc.money.top >= shortPc.name.bottom - 1, 'PC money is on the next line');
  assert(shortPc.buttons[1].bottom <= shortPc.money.top + 1, 'PC buttons are not on the euro line');
  assert(Math.abs(longPhone.buttons[0].top - longPhone.buttons[1].top) < 2, 'long-name buttons stay together');
  assert(longPhone.buttons[0].top >= longPhone.name.bottom - 1, 'long name wraps and the buttons sit under it');
  assert(longPhone.money.top >= longPhone.buttons[0].bottom - 1, 'phone money stays under the buttons');
  assert(sunsetPhone.money == null, 'Sunset fixture has no money row');
  assert(Math.abs(sunsetPhone.buttons[0].top - sunsetPhone.buttons[1].top) < 2, 'Sunset buttons stay together');
  assert(sunsetPhone.buttons[0].top >= sunsetPhone.name.bottom - 1, 'Sunset long name puts both buttons under the name');
  assert(rows.every((row) => !row.overflow), 'rows do not overflow');
  console.log(JSON.stringify({ shortPc: { nameTop: shortPc.name.top, btnTop: shortPc.buttons[0].top, moneyTop: shortPc.money.top }, longPhone: { nameBottom: longPhone.name.bottom, btnTop: longPhone.buttons[0].top, moneyTop: longPhone.money.top } }));
}

layoutProof().then(() => {
  console.log('verify-per-guest-link-buttons: ok');
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
