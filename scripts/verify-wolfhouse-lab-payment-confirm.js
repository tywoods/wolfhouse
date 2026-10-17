'use strict';

/**
 * Wolfhouse Lab payment confirmation.
 *
 * Sunset's Staff Lab already shows a Confirmation step after a test booking
 * is paid. Wolfhouse Lab must show the same step, and must not invent it
 * when the test booking is not paid. Sunset's confirmation_sent_at path
 * stays the only way a non-Lab or Sunset thread grows that step.
 *
 * Confirm path and not-paid path are painted at 1280 and 390.
 * Run: node scripts/verify-wolfhouse-lab-payment-confirm.js
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const LIST = path.join(ROOT, 'scripts/browser/inbox-list.js');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const ROWS = path.join(ROOT, 'scripts/browser/inbox-rows.js');
const QUERIES = path.join(ROOT, 'scripts/lib/staff-conversation-queries.js');

function functionSlice(src, name, nextName) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const end = nextName ? src.indexOf(`function ${nextName}(`, start + 1) : src.length;
  if (end < 0) throw new Error(`Missing function ${nextName}`);
  return src.slice(start, end);
}

function extractFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') depth -= 1;
    if (depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

function loadRealHelpers() {
  const listSrc = fs.readFileSync(LIST, 'utf8');
  const rowsSrc = fs.readFileSync(ROWS, 'utf8');
  const names = [
    'inboxConfirmationEventsFromBookings',
    'inboxRememberConfirmationEvents',
    'inboxMergeConfirmationEvents',
    'renderInboxThreadMessagesHtml',
    'inboxConversationIsWolfhouseLab',
    'inboxBookingPaymentConfirmed',
  ];
  const sandbox = {
    console,
    t(key) { return key; },
    escHtml(v) { return String(v == null ? '' : v); },
    fmtTs(v) { return String(v || ''); },
    formatInboxThreadBubbleHtml(m) { return sandbox.escHtml(m && m.message_text || ''); },
    inboxThreadDayKey(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return '';
      return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
    },
    inboxThreadDayLabel(ts) { return sandbox.inboxThreadDayKey(ts); },
    getClient() { return sandbox.client; },
    client: 'wolfhouse-somo',
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const pieces = [extractFunctionSource(rowsSrc, 'inboxRowIsOwnerLab')];
  for (const name of names) pieces.push(extractFunctionSource(listSrc, name));
  vm.runInContext(pieces.join('\n'), sandbox);
  return sandbox;
}

const PAID_AT = '2026-10-17T18:04:00.000Z';
const GUEST_AT = '2026-10-17T17:40:00.000Z';

function paidBooking() {
  return {
    booking_code: 'WH-LAB-1',
    booking_payment_status: 'deposit_paid',
    payment_record_status: 'paid',
    payment_amount_paid_cents: 20000,
    payment_paid_at: PAID_AT,
    confirmation_sent_at: null,
  };
}

function unpaidBooking() {
  return {
    booking_code: 'WH-LAB-1',
    booking_payment_status: 'payment_pending',
    payment_record_status: 'checkout_created',
    payment_amount_paid_cents: 0,
    confirmation_sent_at: null,
  };
}

function guestMessages() {
  return [{
    direction: 'inbound',
    source: 'whatsapp',
    message_text: 'We paid the test link',
    created_at: GUEST_AT,
  }];
}

function paint(sandbox, bookings, opts) {
  sandbox.inboxRememberConfirmationEvents(bookings, opts || {});
  return sandbox.renderInboxThreadMessagesHtml(guestMessages());
}

function assertConfirmStep(html, label) {
  assert.match(html, /Booking confirmed/, `${label} shows Booking confirmed`);
  assert.match(html, /WH-LAB-1/, `${label} names the test booking`);
  assert.match(html, /Confirmation/, `${label} labels the step Confirmation`);
  assert.match(html, /We paid the test link/, `${label} keeps the guest message`);
}

function assertNoConfirmStep(html, label) {
  assert.doesNotMatch(html, /Booking confirmed/, `${label} does not invent a confirmation`);
  assert.doesNotMatch(html, /WH-LAB-1/, `${label} does not name an unconfirmed booking`);
  assert.match(html, /We paid the test link/, `${label} keeps the guest message`);
}

function unitChecks() {
  const sandbox = loadRealHelpers();
  const threadSrc = fs.readFileSync(THREAD, 'utf8');
  const querySrc = fs.readFileSync(QUERIES, 'utf8');
  const detailSql = functionSlice(querySrc, 'getConversationDetailQuery', 'getConversationMessagesQuery');
  const bookingsSql = functionSlice(querySrc, 'getConversationBookingsQuery', 'getConversationDraftQuery');

  assert.match(detailSql, /open_phone_testing/, 'Lab flag is on the thread detail row');
  assert.match(detailSql, /guest_tester_class/, 'Lab class is on the thread detail row');
  assert.match(bookingsSql, /payment_paid_at/, 'paid time is available to the Lab step');
  assert.match(
    threadSrc,
    /inboxRememberConfirmationEvents\(bookingRows,\s*\{[\s\S]*wolfhouseLab/,
    'thread load asks the real helper for the Wolfhouse Lab step',
  );

  sandbox.client = 'wolfhouse-somo';
  assert.equal(sandbox.inboxConversationIsWolfhouseLab({
    open_phone_testing: true,
  }), true, 'Wolfhouse Lab conversation is in scope');
  assert.equal(sandbox.inboxConversationIsWolfhouseLab({
    guest_tester_class: 'Simulator',
  }), true, 'Wolfhouse simulator class is in scope');
  assert.equal(sandbox.inboxConversationIsWolfhouseLab({
    open_phone_testing: false,
  }), false, 'a real Wolfhouse conversation is not Lab');
  sandbox.client = 'sunset';
  assert.equal(sandbox.inboxConversationIsWolfhouseLab({
    open_phone_testing: true,
  }), false, 'Sunset Lab is not this Wolfhouse path');
  sandbox.client = 'wolfhouse-somo';

  const paidHtml = paint(sandbox, [paidBooking()], { wolfhouseLab: true });
  assertConfirmStep(paidHtml, 'paid Wolfhouse Lab');
  const unpaidHtml = paint(sandbox, [unpaidBooking()], { wolfhouseLab: true });
  assertNoConfirmStep(unpaidHtml, 'not-paid Wolfhouse Lab');
  const partialHtml = paint(sandbox, [{
    ...unpaidBooking(),
    booking_payment_status: 'partial',
    payment_record_status: 'partial',
    payment_amount_paid_cents: 1000,
  }], { wolfhouseLab: true });
  assertNoConfirmStep(partialHtml, 'partial Wolfhouse Lab');

  const realPaid = paint(sandbox, [paidBooking()], { wolfhouseLab: false });
  assertNoConfirmStep(realPaid, 'paid non-Lab Wolfhouse');

  sandbox.client = 'sunset';
  const sunsetPaid = paint(sandbox, [paidBooking()], { wolfhouseLab: false });
  assertNoConfirmStep(sunsetPaid, 'Sunset without confirmation_sent_at');
  const sunsetSent = paint(sandbox, [{
    ...paidBooking(),
    booking_code: 'SUN-LAB-1',
    confirmation_sent_at: '2026-10-17T18:05:00.000Z',
  }], { wolfhouseLab: false });
  assert.match(sunsetSent, /Booking confirmed/, 'Sunset sent confirmation still shows');
  assert.match(sunsetSent, /SUN-LAB-1/, 'Sunset sent confirmation keeps its code');

  return { paidHtml, unpaidHtml };
}

function pageHtml(threadHtml, width) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body{margin:0;font:14px/1.4 system-ui,sans-serif;background:#f6f1ea;color:#1c1c1e}
  .lab-shell{box-sizing:border-box;width:${width}px;min-height:100vh;padding:12px}
  .inbox-owner-lab-chip{display:inline-flex;margin-bottom:10px;padding:2px 8px;border-radius:999px;background:#e7f4f3;color:#1f6f6b;font-size:12px;font-weight:700}
  .thread{display:flex;flex-direction:column;gap:8px}
  .msg{max-width:100%}
  .msg-bubble{display:inline-block;max-width:100%;padding:8px 10px;border-radius:12px;background:#fff;border:1px solid #e6dfd4;white-space:pre-wrap;overflow-wrap:anywhere}
  .msg.outbound .msg-bubble{background:#e7f4f3}
  .msg-meta{font-size:11px;color:#6e6e73;margin-top:2px}
  .inbox-thread-day{font-size:11px;color:#6e6e73;text-align:center}
</style>
</head>
<body>
  <div class="lab-shell" id="lab-shell">
    <div class="inbox-owner-lab-chip">Lab</div>
    <div class="thread" id="thread">${threadHtml}</div>
  </div>
</body>
</html>`;
}

async function paintWidths(paidHtml, unpaidHtml) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.setContent(pageHtml(paidHtml, width), { waitUntil: 'load' });
      const paid = await page.evaluate(() => {
        const shell = document.getElementById('lab-shell');
        const step = [...document.querySelectorAll('.msg')].find((node) => /Booking confirmed/.test(node.textContent || ''));
        const bubble = step && step.querySelector('.msg-bubble');
        const box = bubble ? bubble.getBoundingClientRect() : null;
        return {
          lab: /Lab/.test(document.body.innerText),
          confirmed: /Booking confirmed/.test(document.body.innerText),
          sender: step ? (step.querySelector('.msg-meta') || {}).textContent : '',
          box,
          overflow: shell.scrollWidth > shell.clientWidth + 1,
          inView: !!(box && box.width > 0 && box.left >= -1 && box.right <= window.innerWidth + 1),
        };
      });
      assert.equal(paid.lab, true, `${width}px Lab chrome is visible`);
      assert.equal(paid.confirmed, true, `${width}px confirm path shows the step`);
      assert.match(paid.sender || '', /Confirmation/, `${width}px step is labeled Confirmation`);
      assert.equal(paid.overflow, false, `${width}px confirm path does not overflow`);
      assert.equal(paid.inView, true, `${width}px confirmation bubble is in view`);

      await page.setContent(pageHtml(unpaidHtml, width), { waitUntil: 'load' });
      const unpaid = await page.evaluate(() => ({
        confirmed: /Booking confirmed/.test(document.body.innerText),
        guest: /We paid the test link/.test(document.body.innerText),
        overflow: document.getElementById('lab-shell').scrollWidth
          > document.getElementById('lab-shell').clientWidth + 1,
      }));
      assert.equal(unpaid.confirmed, false, `${width}px not-paid path hides the step`);
      assert.equal(unpaid.guest, true, `${width}px not-paid path keeps the guest message`);
      assert.equal(unpaid.overflow, false, `${width}px not-paid path does not overflow`);
      console.log(`PASS ${width}px confirm path and not-paid path`);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const painted = unitChecks();
  console.log('PASS unit confirm path and not-paid path');
  await paintWidths(painted.paidHtml, painted.unpaidHtml);
  console.log('PASS verify-wolfhouse-lab-payment-confirm');
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
