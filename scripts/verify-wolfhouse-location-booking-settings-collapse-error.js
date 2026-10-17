'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const UI_PATH = path.join(__dirname, 'browser/wolfhouse-location-booking-settings-ui.js');
const SETTINGS = {
  location: {
    address_text: 'C. Mies de La Ran, 41, 39140 Somo, Cantabria',
    google_maps_url: 'https://maps.google.com/example',
  },
  booking_settings: {
    unpaid_hold_minutes: 60,
    require_each_guest_deposit: false,
    locked: false,
    lock_reason: '',
  },
};

function makeEl(id) {
  return {
    id,
    textContent: '',
    value: '',
    checked: false,
    hidden: false,
    disabled: false,
    href: '',
    dataset: {},
    style: {},
    children: [],
    _listeners: {},
    _attrs: {},
    classList: { toggle() {} },
    addEventListener(type, fn) {
      (this._listeners[type] || (this._listeners[type] = [])).push(fn);
    },
    setAttribute(key, value) { this._attrs[key] = String(value); },
    getAttribute(key) { return this._attrs[key]; },
    removeAttribute(key) { delete this._attrs[key]; },
    contains(other) {
      return this === other || this.children.some((child) => child.contains(other));
    },
    click() {
      (this._listeners.click || []).forEach((fn) => fn());
    },
    input() {
      (this._listeners.input || []).forEach((fn) => fn());
    },
  };
}

function boot() {
  const ids = [
    'al-wrap', 'cc-house-notes', 'wh-location-booking-settings',
    'wh-location-address-text', 'wh-location-map-url', 'wh-map-open',
    'wh-unpaid-hold-minutes', 'wh-require-each-deposit', 'wh-deposit-rule-help',
    'wh-booking-lock-note', 'wh-location-status', 'wh-location-save',
    'wh-booking-status', 'wh-booking-save',
  ];
  const elements = {};
  ids.forEach((id) => { elements[id] = makeEl(id); });
  const locationCard = makeEl('wh-location-settings-card');
  const bookingCard = makeEl('wh-booking-settings-card');
  locationCard.children.push(elements['wh-location-status']);
  bookingCard.children.push(elements['wh-booking-status']);
  locationCard.toggle = makeEl('wh-location-settings-toggle');
  bookingCard.toggle = makeEl('wh-booking-settings-toggle');
  locationCard.toggle.setAttribute('aria-expanded', 'false');
  bookingCard.toggle.setAttribute('aria-expanded', 'false');
  const revealed = [];
  const pending = [];
  const sandbox = {
    window: {
      staffCollapseEnhanceLate() {},
      staffCollapseReveal(node) {
        revealed.push(node);
        [locationCard, bookingCard].forEach((card) => {
          if (card.contains(node)) card.toggle.setAttribute('aria-expanded', 'true');
        });
      },
    },
    document: {
      getElementById(id) { return elements[id] || null; },
      head: makeEl('head'),
      documentElement: makeEl('root'),
    },
    getClient() { return 'wolfhouse-somo'; },
    fetch(url, opts) {
      return new Promise((resolve) => pending.push({ url, opts, resolve }));
    },
    URL,
    Promise,
    console,
  };
  sandbox.document.head.appendChild = () => {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(UI_PATH, 'utf8'), sandbox, { filename: UI_PATH });
  return { sandbox, elements, locationCard, bookingCard, revealed, pending };
}

function release(pending, match, response) {
  const index = pending.findIndex(match);
  assert.ok(index >= 0, 'missing request');
  const item = pending.splice(index, 1)[0];
  item.resolve({
    ok: response.ok !== false,
    json: () => Promise.resolve(response.body),
  });
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function load(session) {
  const loading = session.sandbox.window.loadWolfhouseLocationBookingSettings();
  release(session.pending, (item) => item.url === '/staff/admin/location-booking-settings', {
    ok: true,
    body: SETTINGS,
  });
  await loading;
}

(async () => {
  const booking = boot();
  await load(booking);
  booking.elements['wh-unpaid-hold-minutes'].value = '45';
  booking.elements['wh-unpaid-hold-minutes'].input();
  booking.bookingCard.toggle.setAttribute('aria-expanded', 'false');
  booking.elements['wh-booking-save'].click();
  release(booking.pending, (item) => item.url === '/staff/admin/booking-settings', { ok: false });
  await flush();
  release(booking.pending, (item) => item.url === '/staff/admin/location-booking-settings', {
    ok: true,
    body: SETTINGS,
  });
  await flush();
  assert.strictEqual(booking.bookingCard.toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(booking.revealed.includes(booking.elements['wh-booking-status']));
  assert.match(booking.elements['wh-booking-status'].textContent, /Could not save booking settings/);

  const location = boot();
  await load(location);
  location.elements['wh-location-map-url'].value = 'https://maps.google.com/moved';
  location.elements['wh-location-map-url'].input();
  location.locationCard.toggle.setAttribute('aria-expanded', 'false');
  location.elements['wh-location-save'].click();
  release(location.pending, (item) => item.url === '/staff/admin/location', { ok: false });
  await flush();
  release(location.pending, (item) => item.url === '/staff/admin/location-booking-settings', {
    ok: true,
    body: SETTINGS,
  });
  await flush();
  assert.strictEqual(location.locationCard.toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(location.revealed.includes(location.elements['wh-location-status']));
  assert.match(location.elements['wh-location-status'].textContent, /Could not save location/);

  const stale = boot();
  await load(stale);
  stale.elements['wh-unpaid-hold-minutes'].value = '45';
  stale.elements['wh-booking-save'].click();
  stale.elements['wh-location-booking-settings']._wolfhouseDraftVersion.booking += 1;
  stale.bookingCard.toggle.setAttribute('aria-expanded', 'false');
  const revealedBefore = stale.revealed.length;
  release(stale.pending, (item) => item.url === '/staff/admin/booking-settings', { ok: false });
  await flush();
  release(stale.pending, (item) => item.url === '/staff/admin/location-booking-settings', {
    ok: true,
    body: SETTINGS,
  });
  await flush();
  assert.strictEqual(stale.revealed.length, revealedBefore);
  assert.strictEqual(stale.bookingCard.toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(!/Could not save booking settings/.test(stale.elements['wh-booking-status'].textContent));

  const reconcile = boot();
  await load(reconcile);
  reconcile.elements['wh-unpaid-hold-minutes'].value = '45';
  reconcile.bookingCard.toggle.setAttribute('aria-expanded', 'false');
  reconcile.elements['wh-booking-save'].click();
  release(reconcile.pending, (item) => item.url === '/staff/admin/booking-settings', { ok: false });
  await flush();
  release(reconcile.pending, (item) => item.url === '/staff/admin/location-booking-settings', { ok: false });
  await flush();
  assert.strictEqual(reconcile.bookingCard.toggle.getAttribute('aria-expanded'), 'true');
  assert.match(reconcile.elements['wh-booking-status'].textContent, /Could not reconcile the save/);

  console.log('PASS verify-wolfhouse-location-booking-settings-collapse-error');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
