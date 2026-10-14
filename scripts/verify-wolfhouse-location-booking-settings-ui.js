'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const UI_PATH = path.join(ROOT, 'scripts/browser/wolfhouse-location-booking-settings-ui.js');
const INJECTOR_PATH = path.join(ROOT, 'scripts/lib/wolfhouse-admin-browser-source.js');
const ADMIN_PATH = path.join(ROOT, 'scripts/browser/wolfhouse-admin-ui.js');

const source = fs.readFileSync(UI_PATH, 'utf8');
const injector = fs.readFileSync(INJECTOR_PATH, 'utf8');
const admin = fs.readFileSync(ADMIN_PATH, 'utf8');

assert.match(injector, /wolfhouse-location-booking-settings-ui\.js/);
assert.match(admin, /loadWolfhouseLocationBookingSettings/);
assert.match(source, /\/staff\/admin\/location-booking-settings/);
assert.match(source, /\/staff\/admin\/location/);
assert.match(source, /\/staff\/admin\/booking-settings/);
assert.ok(!/payment.?link.?expir/i.test(source));
assert.ok(!/lesson.?schedule/i.test(source));
assert.match(source, /https:\/\/maps\.app\.goo\.gl\/oPRckhqozVBvXxL16/);

const sandbox = {
  window: {},
  document: {},
  URL,
  Promise,
  console,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: UI_PATH });

const normalized = sandbox.normalizeWolfhouseLocationBookingSettings({
  location: {
    address_text: '  C. Mies de La Ran, 41  ',
    google_maps_url: 'https://maps.google.com/example',
  },
  booking_settings: {
    unpaid_hold_minutes: 90,
    require_each_guest_deposit: true,
    locked: true,
    lock_reason: 'deposit_received',
  },
});
assert.deepStrictEqual(JSON.parse(JSON.stringify(normalized)), {
  location: {
    address_text: 'C. Mies de La Ran, 41',
    google_maps_url: 'https://maps.google.com/example',
  },
  booking_settings: {
    unpaid_hold_minutes: 90,
    require_each_guest_deposit: true,
    locked: true,
    lock_reason: 'deposit_received',
  },
});

const blankMap = sandbox.normalizeWolfhouseLocationBookingSettings({
  location: { address_text: 'TEST address', google_maps_url: '' },
  booking_settings: { unpaid_hold_minutes: 60, require_each_guest_deposit: false },
});
assert.strictEqual(blankMap.location.google_maps_url, '');
assert.throws(() => sandbox.normalizeWolfhouseLocationBookingSettings({}), /invalid_settings_response/);
assert.throws(() => sandbox.normalizeWolfhouseLocationBookingSettings({
  location: { address_text: 'TEST address', google_maps_url: 'javascript:alert(1)' },
  booking_settings: { unpaid_hold_minutes: 60, require_each_guest_deposit: false },
}), /invalid_settings_response/);
assert.throws(() => sandbox.normalizeWolfhouseLocationBookingSettings({
  location: { address_text: 'TEST address', google_maps_url: 'https://' },
  booking_settings: { unpaid_hold_minutes: 60, require_each_guest_deposit: false },
}), /invalid_settings_response/);
for (const unsafeMap of [
  'https://user:pass@maps.google.com/example',
  'https://maps.google.com/example\n',
  'https://maps.google.com/\u0000example',
]) {
  assert.strictEqual(sandbox.isSafeWolfhouseMapUrl(unsafeMap), false, unsafeMap);
  assert.throws(() => sandbox.normalizeWolfhouseLocationBookingSettings({
    location: { address_text: 'TEST address', google_maps_url: unsafeMap },
    booking_settings: { unpaid_hold_minutes: 60, require_each_guest_deposit: false },
  }), /invalid_settings_response/);
}

assert.deepStrictEqual(
  JSON.parse(JSON.stringify(sandbox.wolfhouseLocationPayload(' Calle Test ', ''))),
  { address_text: 'Calle Test', google_maps_url: '' },
);
assert.strictEqual(sandbox.isSafeWolfhouseMapUrl(''), true);
assert.strictEqual(sandbox.isSafeWolfhouseMapUrl('https://maps.google.com/test'), true);
assert.strictEqual(sandbox.isSafeWolfhouseMapUrl('https://'), false);
assert.strictEqual(sandbox.isSafeWolfhouseMapUrl('javascript:alert(1)'), false);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(sandbox.wolfhouseBookingSettingsPayload('75', true))),
  { unpaid_hold_minutes: 75, require_each_guest_deposit: true },
);
assert.throws(() => sandbox.wolfhouseBookingSettingsPayload('0', false), /hold_minutes/);
assert.throws(() => sandbox.wolfhouseBookingSettingsPayload('abc', false), /hold_minutes/);

const hold = { disabled: false };
const each = { disabled: false };
const note = { hidden: true, textContent: '' };
sandbox.applyWolfhouseBookingSettingsLock({ hold, each, note }, {
  locked: true,
  lock_reason: 'deposit_received',
});
assert.strictEqual(hold.disabled, true);
assert.strictEqual(each.disabled, true);
assert.strictEqual(note.hidden, false);
assert.match(note.textContent, /deposit/i);

sandbox.applyWolfhouseBookingSettingsLock({ hold, each, note }, {
  locked: false,
  lock_reason: '',
});
assert.strictEqual(hold.disabled, false);
assert.strictEqual(each.disabled, false);
assert.strictEqual(note.hidden, true);

console.log('PASS verify-wolfhouse-location-booking-settings-ui');
