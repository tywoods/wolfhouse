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
  'bcFieldEditCommitSavedPrivateRoom',
  'bcFieldEditSetPrivateRoomToggle',
  'bcFieldEditResetPrivateRoomSwitchToSaved',
  'bcFieldEditRenderGuestsSaveResult',
  'bcFieldEditRunGuestsSave',
  'bcFieldEditSaveInlineAll',
].map(extractFunction).join('\n');

const setupSrc = `
  document.body.innerHTML =
    '<div id="bc-side-drawer"><div id="bc-drawer-card-booking">' +
    '<input type="checkbox" id="bc-field-private-room-read-switch">' +
    '<input type="checkbox" id="bc-field-private-room-switch">' +
    '<div id="bc-field-guests-preview-result"></div>' +
    '<button id="bc-field-save-guests"></button>' +
    '<button id="bc-inline-save"></button>' +
    '<select id="bc-field-guests-select"><option value="1" selected>1</option></select>' +
    '<input id="bc-field-contact-name" value="Ada">' +
    '<input id="bc-field-contact-phone" value="">' +
    '<input id="bc-field-contact-email" value="">' +
    '</div></div>';
  window.el = function (id) { return document.getElementById(id); };
  window.escHtml = function (s) { return String(s == null ? '' : s); };
  window.getBcClient = function () { return 'wolfhouse-somo'; };
  window.bcNewPrivateRoomEditIdempotencyKey = function () { return 'idem-pr'; };
  window.bcNewContactEditIdempotencyKey = function () { return 'idem-c'; };
  window.bcFieldEditGuestsCountLowerThanCurrent = function () { return true; };
  window.bcFieldEditBuildGuestsWritePayload = function () {
    return { edit_type: 'guests', guest_count: 1, booking_id: 'booking-1' };
  };
  window.bcFieldEditUpdateGuestsSaveState = function () {};
  window.bcFieldEditDatesChanged = function () { return false; };
  window.bcFieldEditReadPackageGuestSelects = function () { return []; };
  window.bcFieldEditPackageChanged = function () { return false; };
  window.bcFieldEditPostGuestPackages = function () { return Promise.resolve(); };
  window.bcFieldEditPostEdit = function () { return Promise.resolve({ success: true }); };
  window.bcFieldEditCloseAll = function () {};
  window.loadBlockDetail = function () {};
  window.alerts = [];
  window.alert = function (msg) { window.alerts.push(String(msg || '')); };
`;

function switches() {
  return {
    read: document.getElementById('bc-field-private-room-read-switch').checked,
    edit: document.getElementById('bc-field-private-room-switch').checked,
    saved: !!(window.bcFieldEditState.snapshot && window.bcFieldEditState.snapshot.private_room),
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/staff/ui' || url.pathname === '/') {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
      }
      if (url.pathname === '/staff/bookings/edit') {
        let post = {};
        try { post = route.request().postDataJSON() || {}; } catch (_) { post = {}; }
        if (post.edit_type === 'private_room') {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, message: 'Private room updated.' }),
          });
        }
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'guest_save_failed' }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    const page = await context.newPage();
    await page.goto('http://staff.test/staff/ui', { waitUntil: 'domcontentloaded' });

    const validationOff = await page.evaluate(async ({ code, setup }) => {
      eval(setup);
      eval(code);
      window.bcFieldEditState = {
        snapshot: { private_room: false, guest_name: 'Old' },
        guestCount: 2,
        clientSlug: 'wolfhouse-somo',
        bookingId: 'booking-1',
        bookingCode: 'WH-20261108-1281',
        inlineSession: 1,
      };
      window.bcFieldEditBuildContactWritePayload = function () { return { error: 'Phone is required.' }; };
      document.getElementById('bc-field-private-room-read-switch').checked = true;
      document.getElementById('bc-field-private-room-switch').checked = true;
      bcFieldEditSaveInlineAll();
      return {
        read: document.getElementById('bc-field-private-room-read-switch').checked,
        edit: document.getElementById('bc-field-private-room-switch').checked,
        alerts: window.alerts.slice(),
      };
    }, { code: bundle, setup: setupSrc });
    assert.equal(validationOff.read, false, 'inline validation saved-OFF must restore Invoice switch, got ' + JSON.stringify(validationOff));
    assert.equal(validationOff.edit, false, 'inline validation saved-OFF must restore edit switch, got ' + JSON.stringify(validationOff));
    assert.ok(validationOff.alerts.length, 'inline validation still reports the error');

    const validationOn = await page.evaluate(async ({ code, setup }) => {
      eval(setup);
      eval(code);
      window.bcFieldEditState = {
        snapshot: { private_room: true, guest_name: 'Old' },
        guestCount: 2,
        clientSlug: 'wolfhouse-somo',
        bookingId: 'booking-1',
        bookingCode: 'WH-20261108-1281',
        inlineSession: 1,
      };
      window.bcFieldEditBuildContactWritePayload = function () { return { error: 'Phone is required.' }; };
      document.getElementById('bc-field-private-room-read-switch').checked = false;
      document.getElementById('bc-field-private-room-switch').checked = false;
      bcFieldEditSaveInlineAll();
      return {
        read: document.getElementById('bc-field-private-room-read-switch').checked,
        edit: document.getElementById('bc-field-private-room-switch').checked,
      };
    }, { code: bundle, setup: setupSrc });
    assert.equal(validationOn.read, true, 'inline validation saved-ON must restore Invoice switch, got ' + JSON.stringify(validationOn));
    assert.equal(validationOn.edit, true, 'inline validation saved-ON must restore edit switch, got ' + JSON.stringify(validationOn));

    const guestFailOff = await page.evaluate(async ({ code, setup }) => {
      eval(setup);
      eval(code);
      window.bcFieldEditState = {
        snapshot: { private_room: false },
        guestCount: 2,
        clientSlug: 'wolfhouse-somo',
        bookingId: 'booking-1',
        bookingCode: 'WH-20261108-1281',
      };
      document.getElementById('bc-field-private-room-read-switch').checked = false;
      document.getElementById('bc-field-private-room-switch').checked = true;
      bcFieldEditRunGuestsSave();
      await new Promise(function (resolve) { setTimeout(resolve, 150); });
      return {
        read: document.getElementById('bc-field-private-room-read-switch').checked,
        edit: document.getElementById('bc-field-private-room-switch').checked,
        saved: !!(window.bcFieldEditState.snapshot && window.bcFieldEditState.snapshot.private_room),
      };
    }, { code: bundle, setup: setupSrc });
    assert.equal(guestFailOff.saved, true, 'successful private-room write must become the saved value when guest save later fails, got ' + JSON.stringify(guestFailOff));
    assert.equal(guestFailOff.read, true, 'Invoice switch must keep the newly saved ON, got ' + JSON.stringify(guestFailOff));
    assert.equal(guestFailOff.edit, true, 'edit switch must keep the newly saved ON, got ' + JSON.stringify(guestFailOff));

    const guestFailOn = await page.evaluate(async ({ code, setup }) => {
      eval(setup);
      eval(code);
      window.bcFieldEditState = {
        snapshot: { private_room: true },
        guestCount: 2,
        clientSlug: 'wolfhouse-somo',
        bookingId: 'booking-1',
        bookingCode: 'WH-20261108-1281',
      };
      document.getElementById('bc-field-private-room-read-switch').checked = true;
      document.getElementById('bc-field-private-room-switch').checked = false;
      bcFieldEditRunGuestsSave();
      await new Promise(function (resolve) { setTimeout(resolve, 150); });
      return {
        read: document.getElementById('bc-field-private-room-read-switch').checked,
        edit: document.getElementById('bc-field-private-room-switch').checked,
        saved: !!(window.bcFieldEditState.snapshot && window.bcFieldEditState.snapshot.private_room),
      };
    }, { code: bundle, setup: setupSrc });
    assert.equal(guestFailOn.saved, false, 'successful private-room write must become the saved value when turning OFF, got ' + JSON.stringify(guestFailOn));
    assert.equal(guestFailOn.read, false, 'Invoice switch must keep the newly saved OFF, got ' + JSON.stringify(guestFailOn));
    assert.equal(guestFailOn.edit, false, 'edit switch must keep the newly saved OFF, got ' + JSON.stringify(guestFailOn));

    await context.close();
  } finally {
    await browser.close();
  }
  console.log('PASS private-room switch saved paths');
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
