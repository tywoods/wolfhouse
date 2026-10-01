#!/usr/bin/env node
'use strict';

// BOOKING-DRAWER-REMOVE-START-CONVO-BOTTOM-001
// Shared booking drawer footer must not render the bottom Start Conversation
// button. Cancel Booking stays. The header Inbox icon stays the start/open entry.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const api = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing function ' + name);
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unclosed function ' + name);
}

const footerSrc = extractFunction(api, 'bcRenderBookingDrawerFooterHtml');
const headerSrc = extractFunction(api, 'bcBookingHeaderIconButtonsHtml');
const cancelSrc = extractFunction(api, 'bcBookingStatusIsCancelled');

assert.ok(!footerSrc.includes('bc-new-conversation-btn'), 'footer must not render the bottom Start Conversation button');
assert.ok(!footerSrc.includes('drawer.footer.startConv'), 'footer must not use the Start Conversation label');
assert.ok(!footerSrc.includes('bc-new-conversation-result'), 'footer must not keep the start-conversation result slot');
assert.ok(footerSrc.includes('id="bc-cancel-reservation-btn"'), 'Cancel Booking button must stay in the footer');
assert.ok(footerSrc.includes("t('drawer.footer.cancelBooking')"), 'Cancel Booking label must stay');
assert.ok(footerSrc.includes('id="bc-open-conv-btn"'), 'existing Open Conversation footer button stays; only Start Conversation is removed');
assert.ok(headerSrc.includes('id="bc-open-conversation-toolbar"'), 'header Inbox icon remains the conversation entry');
assert.ok(headerSrc.includes('BC_HEADER_INBOX_SVG'), 'header Inbox glyph must stay');

function renderFooterHtml(data) {
  const context = {
    data,
    escHtml: (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    t: (key) => ({
      'drawer.footer.openConv': 'Open Conversation',
      'drawer.footer.cancelBooking': 'Cancel Booking',
      'drawer.footer.startConv': 'Start Conversation',
    }[key] || key),
  };
  vm.createContext(context);
  return vm.runInContext(cancelSrc + '\n' + footerSrc + '\nbcRenderBookingDrawerFooterHtml(data);', context);
}

const noConv = renderFooterHtml({ booking: { booking_id: 'b1', booking_code: 'WH-2026-10-01-abc', status: 'confirmed' } });
const withConv = renderFooterHtml({
  booking: { booking_id: 'b1', booking_code: 'WH-2026-10-01-abc', status: 'confirmed' },
  conversation: { conversation_id: 'c1' },
});
const cancelled = renderFooterHtml({ booking: { status: 'cancelled' } });

assert.ok(!noConv.includes('bc-new-conversation-btn'), 'no-conversation footer still painted Start Conversation');
assert.ok(!noConv.includes('Start Conversation'), 'no-conversation footer still shows the Start Conversation label');
assert.ok(noConv.includes('bc-cancel-reservation-btn'), 'no-conversation footer dropped Cancel Booking');
assert.ok(noConv.includes('Cancel Booking'), 'no-conversation footer dropped the Cancel Booking label');
assert.ok(!withConv.includes('bc-new-conversation-btn'), 'linked footer must not add Start Conversation');
assert.ok(withConv.includes('bc-open-conv-btn'), 'linked footer must keep Open Conversation');
assert.ok(withConv.includes('bc-cancel-reservation-btn'), 'linked footer must keep Cancel Booking');
assert.ok(!cancelled.includes('bc-cancel-reservation-btn'), 'cancelled booking must still hide Cancel Booking');
assert.ok(!cancelled.includes('bc-new-conversation-btn'), 'cancelled booking must not grow a Start Conversation button');

async function main() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const css = [
      '.bc-drawer-footer{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-top:24px;padding-top:16px}',
      '.bc-drawer-footer-left{display:flex;flex-direction:column;align-items:flex-start;gap:6px;flex:1;min-width:0}',
      '.bc-drawer-footer-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px;margin-left:auto;flex-shrink:0}',
      '#bc-side-drawer .bc-drawer-footer{flex-direction:row;align-items:flex-start;flex-wrap:nowrap}',
      '#bc-side-drawer .bc-drawer-footer-right{align-items:flex-end;margin-left:auto;flex:0 0 auto}',
      '#bc-side-drawer #bc-cancel-reservation-btn{width:auto;align-self:flex-end;white-space:nowrap}',
      '.btn{padding:8px 14px}',
    ].join('\n');
    for (const viewport of [
      { name: 'pc', width: 1280, height: 800, host: 'bc-side-drawer' },
      { name: 'mobile', width: 390, height: 844, host: 'bc-detail' },
    ]) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      await page.setContent('<!doctype html><style>' + css + '</style><div id="' + viewport.host + '" style="width:' + Math.min(viewport.width, 420) + 'px">' + noConv + '</div>');
      const layout = await page.evaluate(() => {
        const start = document.getElementById('bc-new-conversation-btn');
        const cancel = document.getElementById('bc-cancel-reservation-btn');
        const text = document.body.innerText || '';
        const box = cancel ? cancel.getBoundingClientRect() : null;
        return {
          startCount: start ? 1 : 0,
          hasStartLabel: text.includes('Start Conversation'),
          cancelVisible: !!(box && box.width > 0 && box.height > 0),
          cancelText: cancel ? cancel.textContent : '',
        };
      });
      assert.strictEqual(layout.startCount, 0, viewport.name + ' still shows the bottom Start Conversation button');
      assert.strictEqual(layout.hasStartLabel, false, viewport.name + ' still shows the Start Conversation label');
      assert.strictEqual(layout.cancelVisible, true, viewport.name + ' hid Cancel Booking');
      assert.strictEqual(layout.cancelText, 'Cancel Booking', viewport.name + ' changed the Cancel Booking label');
      console.log('PASS ' + viewport.name + ' ' + JSON.stringify(layout));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log('BOOKING_DRAWER_REMOVE_START_CONVO_BOTTOM_001=PASS');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
