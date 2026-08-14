'use strict';

/**
 * EMAIL-MATCH-001-UI — Inbox chrome: person on the thread, honest guest card.
 * Does not touch Skipper matching, OAuth, poller, or language packs.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const threadSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
const contextSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-context.js'), 'utf8');

function loadChrome() {
  const sandbox = {
    window: { addEventListener() {}, fetch() { return Promise.resolve({ ok: false, json: async () => null }); } },
    document: {
      documentElement: { dataset: {} },
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createElement() { return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }; },
      head: { appendChild() {} },
      body: { addEventListener() {} },
      addEventListener() {},
    },
    console,
    localStorage: { getItem() { return null; }, setItem() {} },
    escHtml(s) { return String(s == null ? '' : s); },
    t: (k) => k,
    portalT: (k) => k,
    getClient: () => 'sunset',
    normalizeCustomerPhoneClient(phone) {
      const raw = String(phone || '').trim();
      if (!raw) return '';
      if (raw.charAt(0) === '+') return raw.slice(0, 40);
      const digits = raw.replace(/[^\d]/g, '');
      return digits ? ('+' + digits).slice(0, 40) : '';
    },
  };
  sandbox.window.document = sandbox.document;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${threadSrc}\n${contextSrc}\nthis.__inbox = {
    inboxPersonDisplayName,
    inboxIsOpaqueEmailIdentity,
    inboxBoundCustomerPhone,
    inboxCustomerHasBoundGuest,
    inboxCustomerUnmatchedHtml,
    inboxCustomerFromConv,
    inboxCustomerPaint,
  };`, sandbox);
  return sandbox.__inbox;
}

const chrome = loadChrome();
const OPAQUE = 'emailv1:sunset-somo:32cb2f9a0123456789abcdef0123456789abcdef0123456789abcdef01234567';
const leftover = {
  success: true,
  phone: '+34600111222',
  identity: { display_name: 'Wrong Guest', email: 'wrong@sunset.test' },
  bookings: [{ booking_code: 'SUNSET-WRONG' }],
};

assert.strictEqual(chrome.inboxIsOpaqueEmailIdentity(OPAQUE), true);
assert.strictEqual(chrome.inboxIsOpaqueEmailIdentity('+34600111222'), false);
assert.strictEqual(
  chrome.inboxPersonDisplayName({ guest_name: OPAQUE, phone: OPAQUE, guest_email: 'ada@sunset.test' }),
  'ada@sunset.test',
  'header prefers email over opaque id'
);
assert.strictEqual(
  chrome.inboxPersonDisplayName({ guest_name: 'Ada', phone: OPAQUE, email: 'ada@sunset.test' }),
  'Ada'
);
assert.ok(!chrome.inboxCustomerHasBoundGuest({ phone: OPAQUE, guest_email: 'ada@sunset.test' }, leftover));
assert.ok(chrome.inboxCustomerHasBoundGuest({ phone: '+34600111222' }));
assert.ok(chrome.inboxCustomerHasBoundGuest({ phone: OPAQUE, guest_id: 'guest-1' }), 'Skipper guest_id binds');
assert.strictEqual(chrome.inboxBoundCustomerPhone({ phone: OPAQUE }, leftover), '');

const unmatched = chrome.inboxCustomerUnmatchedHtml({
  phone: OPAQUE,
  guest_name: OPAQUE,
  guest_email: 'ada@sunset.test',
});
assert.ok(unmatched.includes('ada@sunset.test'), 'unmatched card shows email');
assert.ok(unmatched.includes('No guest yet'), 'unmatched card is honest');
assert.ok(!unmatched.includes('emailv1:'), 'unmatched card hides opaque id');
assert.ok(!unmatched.includes('Linked bookings'), 'unmatched card has no fake bookings');
assert.ok(!unmatched.includes('Create booking'), 'unmatched card does not invent booking actions');

const fromConv = chrome.inboxCustomerFromConv({
  phone: OPAQUE,
  guest_name: OPAQUE,
  email: 'ada@sunset.test',
});
assert.strictEqual(fromConv.phone, '');
assert.strictEqual(fromConv.identity.display_name, 'ada@sunset.test');
assert.ok(Array.isArray(fromConv.bookings) && fromConv.bookings.length === 0);

const sidebar = { innerHTML: '', querySelector() { return null; }, querySelectorAll() { return []; } };
chrome.inboxCustomerPaint(sidebar, {
  phone: OPAQUE,
  guest_name: OPAQUE,
  guest_email: 'ty@sunset.test',
}, { bookings: [{ booking_code: 'SUNSET-FAKE', booking_status: 'confirmed' }] }, leftover);
assert.ok(sidebar.innerHTML.includes('No guest yet'));
assert.ok(sidebar.innerHTML.includes('ty@sunset.test'));
assert.ok(!sidebar.innerHTML.includes('Wrong Guest'), 'does not paint leftover guest');
assert.ok(!sidebar.innerHTML.includes('SUNSET-FAKE'), 'does not paint contradicting bookings');
assert.ok(!sidebar.innerHTML.includes('SUNSET-WRONG'));
assert.ok(!sidebar.innerHTML.includes(OPAQUE));

const waSidebar = { innerHTML: '', querySelector() { return null; }, querySelectorAll() { return []; } };
chrome.inboxCustomerPaint(waSidebar, {
  guest_name: 'Marea Wolf',
  phone: '+34600040404',
}, { bookings: [] }, {
  success: true,
  phone: '+34600040404',
  identity: { display_name: 'Marea Wolf', email: '' },
  bookings: [],
});
assert.ok(waSidebar.innerHTML.includes('Marea Wolf'));
assert.ok(!waSidebar.innerHTML.includes('No guest yet'), 'WhatsApp bound guest still paints a card');

assert.ok(!threadSrc.includes('email-inbound-inbox-bridge'));
assert.ok(!contextSrc.includes('email-inbound-inbox-bridge'));
assert.ok(threadSrc.includes('inboxPersonDisplayName(c)'));
assert.ok(contextSrc.includes('data-inbox-guest="unmatched"'));

console.log('PASS EMAIL-MATCH-001-UI Inbox chrome person + honest unmatched card');
