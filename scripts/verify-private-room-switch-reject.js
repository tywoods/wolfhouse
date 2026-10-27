'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

function extractFunction(name) {
  const start = api.indexOf('function ' + name + '(');
  assert.ok(start > 0, name);
  let i = api.indexOf('{', start);
  let depth = 0;
  for (; i < api.length; i += 1) {
    if (api[i] === '{') depth += 1;
    else if (api[i] === '}') {
      depth -= 1;
      if (depth === 0) return api.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

const bundle = [
  'bcFieldEditPrivateRoomReadEnabled',
  'bcFieldEditPrivateRoomEditEnabled',
  'bcFieldEditSavedPrivateRoomEnabled',
  'bcFieldEditSetPrivateRoomToggle',
  'bcFieldEditResetPrivateRoomSwitchToSaved',
  'bcFieldEditRenderGuestsSaveResult',
  'bcFieldEditRunGuestsSave',
].map(extractFunction).join('\n');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/staff/ui' || url.pathname === '/') {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
      }
      if (url.pathname === '/staff/bookings/edit') return route.abort();
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    const page = await context.newPage();
    await page.goto('http://staff.test/staff/ui', { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async (code) => {
      document.body.innerHTML =
        '<input type="checkbox" id="bc-field-private-room-read-switch">' +
        '<input type="checkbox" id="bc-field-private-room-switch">' +
        '<div id="bc-field-guests-preview-result"></div>' +
        '<button id="bc-field-save-guests"></button>' +
        '<select id="bc-field-guests-select"><option value="2" selected>2</option></select>';
      window.el = function (id) { return document.getElementById(id); };
      window.escHtml = function (s) { return String(s == null ? '' : s); };
      window.getBcClient = function () { return 'wolfhouse-somo'; };
      window.bcNewPrivateRoomEditIdempotencyKey = function () { return 'idem'; };
      window.bcFieldEditBuildGuestsWritePayload = function () { return { guest_count: 2 }; };
      window.bcFieldEditGuestsCountLowerThanCurrent = function () { return false; };
      window.bcFieldEditUpdateGuestsSaveState = function () {};
      window.bcFieldEditState = {
        snapshot: { private_room: false },
        guestCount: 2,
        clientSlug: 'wolfhouse-somo',
        bookingId: 'booking-1',
        bookingCode: 'WH-20261108-1281',
      };
      eval(code);
      document.getElementById('bc-field-private-room-read-switch').checked = false;
      document.getElementById('bc-field-private-room-switch').checked = true;
      bcFieldEditRunGuestsSave();
      await new Promise(function (resolve) { setTimeout(resolve, 120); });
      return {
        read: document.getElementById('bc-field-private-room-read-switch').checked,
        edit: document.getElementById('bc-field-private-room-switch').checked,
      };
    }, bundle);
    assert.equal(result.read, false, 'rejected fetch must restore the visible Invoice switch, got ' + JSON.stringify(result));
    assert.equal(result.edit, false, 'rejected fetch must restore the edit switch, got ' + JSON.stringify(result));
    await context.close();
  } finally {
    await browser.close();
  }
  console.log('PASS private-room switch rejected fetch');
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
