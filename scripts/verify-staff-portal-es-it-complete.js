'use strict';

/**
 * Wolfhouse Staff ES/IT must not fall back to English for chrome Bug Finder found
 * still in Italian, plus dates/plurals. Proper nouns (WhatsApp, Email, Luna) may match EN.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const ALLOW_SAME_AS_EN = new Set([
  'WhatsApp', 'Email', 'Luna', 'Luna Front Desk', 'Lab', 'On', 'Off', 'Auto',
  'OK', 'IBAN', 'Stripe', 'EUR', 'Chats',
]);

const REQUIRED = [
  'customers.openCustomerCard',
  'customers.card.lastSetup',
  'customers.card.balanceDue',
  'customers.detail.createBooking',
  'schedule.createBooking',
  'schedule.drawer.copyCode',
  'schedule.drawer.balanceDue',
  'drawer.invoice.balanceDue',
  'drawer.invoice.paid',
  'drawer.invoice.owe',
  'drawer.invoice.paymentHistory',
  'inbox.filter.allShared',
  'inbox.rail.view.all',
  'inbox.rail.view.needs_human',
  'inbox.rail.view.owner_lab',
  'inbox.layout.folder.chats',
  'inbox.layout.folder.guests',
  'inbox.detail.needsHuman.raise',
  'admin.action.addRental',
  'admin.wh.pricing.addRental',
  'admin.wh.pricing.deposits',
  'admin.wh.pricing.supplements',
  'schedule.cockpit.rel.yesterday',
  'time.yesterday',
  'time.today',
  'booking.stay.night',
  'booking.stay.nights',
  'booking.stay.guest',
  'booking.stay.guests',
  'booking.stay.nightsGuests',
  'admin.finance.wh.updated',
];

function pack(loc) {
  return STAFF_PORTAL_STRINGS[loc] || {};
}

function assertTranslated(loc, key) {
  const en = pack('en')[key];
  const val = pack(loc)[key];
  assert.ok(en, `EN missing ${key}`);
  assert.ok(val, `${loc} missing ${key}`);
  if (ALLOW_SAME_AS_EN.has(en)) return;
  if (String(en).includes('{') && String(val).includes('{')) return;
  assert.notEqual(val, en, `${loc} ${key} still English: ${en}`);
}

for (const key of REQUIRED) {
  assertTranslated('es', key);
  assertTranslated('it', key);
}

const itChats = pack('it')['inbox.layout.folder.chats'];
assert.ok(itChats && itChats !== 'Chats', 'IT Chats must be Italian (Chat / Conversazioni), not English');
const itGuests = pack('it')['inbox.layout.folder.guests'];
assert.match(String(itGuests), /Ospiti|Clienti/i, 'IT Guests folder');
const esOpen = pack('es')['customers.openCustomerCard'];
assert.match(String(esOpen), /cliente|huésped|ficha/i, 'ES Open customer card');
const itOpen = pack('it')['customers.openCustomerCard'];
assert.match(String(itOpen), /cliente|ospite|scheda/i, 'IT Open customer card');

const listSrc = fs.readFileSync(path.join(__dirname, 'browser/inbox-list.js'), 'utf8');
assert.match(listSrc, /t\(['"]time\.yesterday['"]\)|portalT\(['"]time\.yesterday['"]\)|t\(['"]schedule\.cockpit\.rel\.yesterday['"]\)/,
  'inbox-list Yesterday must go through t()');
assert.doesNotMatch(listSrc, /if \(key === yesterday\) return 'Yesterday';/,
  'inbox-list must not hardcode English Yesterday');

const ctxSrc = fs.readFileSync(path.join(__dirname, 'browser/inbox-context.js'), 'utf8');
assert.doesNotMatch(ctxSrc, /INBOX_CONTEXT_MONTHS = \['Jan'/, 'inbox-context must not hardcode English months');
assert.match(ctxSrc, /formatStaffPortalDate|getStaffLocaleTag|toLocaleDateString\(.*getStaffLocale/,
  'inbox-context dates must use staff locale');

const rowsSrc = fs.readFileSync(path.join(__dirname, 'browser/inbox-rows.js'), 'utf8');
assert.match(rowsSrc, /inbox\.detail\.needsHuman\.raise|inbox\.rail\.view\.needs_human/,
  'Needs human chip uses i18n key');
assert.doesNotMatch(rowsSrc, /return 'Needs human';/,
  'Needs human must not hardcode English');

const i18nSrc = fs.readFileSync(path.join(__dirname, 'lib/staff-portal-i18n.js'), 'utf8');
assert.match(i18nSrc, /window\.formatStaffPortalDate\s*=/, 'shared date formatter on i18n bootstrap');
assert.match(i18nSrc, /window\.formatStaffNightsGuests\s*=/, 'shared nights/guests formatter on i18n bootstrap');

console.log('PASS verify-staff-portal-es-it-complete');
