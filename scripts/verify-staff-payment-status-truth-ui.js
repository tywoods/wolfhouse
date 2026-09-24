'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'rendered helper missing: ' + name);
  return src.slice(start, src.indexOf('\n}', start) + 2);
}

async function verifyRenderedPaymentTruth(fixtures) {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ headless: true });
  try {
    for (const client of ['wolfhouse-somo', 'sunset']) {
      const dest = path.join(root, 'tmp', 'staff-payment-truth-' + client + '.html');
      const emit = spawnSync(process.execPath, ['scripts/verify-inbox-ui-parity.js', '--emit', client, dest], {
        cwd: root, encoding: 'utf8',
      });
      assert.equal(emit.status, 0, emit.stderr);
      const html = fs.readFileSync(dest, 'utf8');
      const baselinePath = path.join(root, 'tmp', 'inbox-ui-parity', 'baseline-' + client + '.html');
      if (fs.existsSync(baselinePath)) {
        const baseline = fs.readFileSync(baselinePath, 'utf8');
        let normalized = html.replace(extractFunction(html, 'staffPaymentDisplayStatus') + '\n\n', '');
        for (const name of ['bcRunningInvoiceAccommodationCents', 'bcComputeBookingInvoiceTotals']) {
          normalized = normalized.replace(extractFunction(html, name), extractFunction(baseline, name));
        }
        assert.equal(normalized === baseline, true, client + ': only the approved invoice/status functions change emitted HTML');
      }
      const page = await browser.newPage();
      await page.route('**/*', (route) => route.abort());
      await page.setContent('<main id="fixture"></main>');
      const names = ['staffPaymentDisplayStatus', 'bcRunningInvoiceAccommodationCents', 'bcComputeBookingInvoiceTotals',
        'bcServiceRecordBillableCents', 'bcInvoiceAccCentsWithSupplement', 'bcPaymentLedgerPaidTotalCents',
        'bcPaymentLedgerIsPaidStatus', 'bcSumActiveTransferChargesCents', 'bcIsActiveTransferForInvoice',
        'inboxCustomerGuestBookingsHtml', 'inboxCustomerPaymentStatusLabel'];
      // Only shell helpers are supplied. The actual Guests renderer and all invoice
      // money functions come from the production-emitted tenant HTML, in Chromium.
      await page.addScriptTag({ content: `var BC_RUNNING_INVOICE_ACCOMM_CODES = { guest_package: true };
        var portalLang = 'en';
        function inboxContextEsc(s) { var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
        function inboxContextT(k, fallback) { return fallback; }
        ` + names.map((n) => extractFunction(html, n)).join('\n') });
      for (const row of fixtures[client]) {
        await page.evaluate((b) => { document.getElementById('fixture').innerHTML = inboxCustomerGuestBookingsHtml({ bookings: [b] }); }, row);
        const text = await page.locator('#fixture').innerText();
        assert.match(text, /Partial/);
        assert.match(text, /2026-09-19 → 2026-09-23/);
        // These are Guests payloads, not invoice-loader responses. Invoice
        // integration is separately exercised by verifyRawInvoiceTruth below.
        console.log('PASS Chromium ' + client + ': ' + (row.fixture_label || 'original deposit/stay') + ' Guests Partial');
      }
      await page.close();
      console.log('PASS Chromium ' + client + ': emitted Guests dates + Partial, approved-only UI delta');
    }
  } finally { await browser.close(); }
}
// Raw context/bundle payloads only: never hydrate invoice bookings from Guests,
// prefilter services, or manufacture quote_snapshot/payment rows in the browser.
async function verifyRawInvoiceTruth(fixtures) {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  try {
    for (const client of [...new Set(fixtures.map((f) => f.client))]) {
      const dest = path.join(root, 'tmp', 'invoice-continuation-' + client + '.html');
      const emit = spawnSync(process.execPath, ['scripts/verify-inbox-ui-parity.js', '--emit', client, dest], { cwd: root, encoding: 'utf8' });
      assert.equal(emit.status, 0, emit.stderr);
      const html = fs.readFileSync(dest, 'utf8');
      const page = await browser.newPage();
      await page.route('**/*', (route) => route.abort());
      await page.setContent('<main id="fixture"></main>');
      const names = client === 'sunset'
        ? ['scheduleRenderMoneyHeadlineHtml', 'scheduleDrawerEur', 'scheduleDrawerPaidMethodLabel']
        : ['staffPaymentDisplayStatus', 'bcRunningInvoiceAccommodationCents', 'bcComputeBookingInvoiceTotals',
          'bcServiceRecordBillableCents', 'bcInvoiceAccCentsWithSupplement', 'bcPaymentLedgerPaidTotalCents',
          'bcPaymentLedgerIsPaidStatus', 'bcSumActiveTransferChargesCents', 'bcIsActiveTransferForInvoice',
          'bcQuoteRoomSupplementCents', 'bcQuoteRoomSupplementLine'];
      await page.addScriptTag({ content: `var BC_RUNNING_INVOICE_ACCOMM_CODES = { guest_package: true };
        function escHtml(s) { var d=document.createElement('div'); d.textContent=String(s); return d.innerHTML; }
        function portalT(k) { return k; }
        ` + names.map((name) => extractFunction(html, name)).join('\n') });
      for (const fixture of fixtures.filter((f) => f.client === client)) {
        try {
          if (client === 'sunset') {
            await page.evaluate((payload) => { document.getElementById('fixture').innerHTML = scheduleRenderMoneyHeadlineHtml(payload); }, fixture.payload);
            const payment = fixture.payload.payment;
            assert.equal(payment.total_cents, fixture.total);
            assert.equal(payment.paid_cents, fixture.paid);
            assert.equal(payment.balance_due_cents, fixture.due);
            assert.equal(payment.payment_status, fixture.status);
            const expectedClass = fixture.status === 'paid' ? 'is-paid' : (fixture.paid > 0 ? 'is-partial' : 'is-due');
            assert.equal(await page.locator('.ps-money-headline.' + expectedClass).count(), 1);
          } else {
            const money = await page.evaluate((payload) => bcComputeBookingInvoiceTotals(payload.booking,
              payload.service_records, payload.payments, payload.transfers, payload.guest_accommodation_lines), fixture.payload);
            assert.equal(money.invoiceTotal, fixture.total, 'raw context invoice total');
            assert.equal(money.paidCents, fixture.paid);
            assert.equal(money.balanceDue, fixture.due);
            assert.equal(money.payStatus, fixture.status);
          }
          console.log('PASS Chromium RAW ' + client + ': ' + fixture.label);
        } catch (err) { failures.push(client + ' / ' + fixture.label + ': ' + err.message); }
      }
      await page.close();
    }
    assert.equal(failures.length, 0, failures.join('\n'));
  } finally { await browser.close(); }
}
module.exports = { verifyRenderedPaymentTruth, verifyRawInvoiceTruth };
