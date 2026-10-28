'use strict';

/**
 * Pass 3 leftover Staff ES/IT chrome: catalogues + shared formatters +
 * call sites that still bake English. Does not edit booking-detail payment
 * ledger / paid-pebble (staff-query-api.js stay-off).
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

function pack(loc) {
  return STAFF_PORTAL_STRINGS[loc] || {};
}

const en = pack('en');
const es = pack('es');
const it = pack('it');

assert.equal(it['login.sub'], 'Accesso del personale');
assert.doesNotMatch(it['login.sub'], /\bpersonal\b/i);
assert.equal(it['login.password'], 'Password');
assert.equal(it['login.showPassword'], 'Mostra password');
assert.equal(it['login.hidePassword'], 'Nascondi password');

const acconto = Object.entries(it).filter(([, v]) => /\bAcconto\b/i.test(String(v)));
assert.equal(acconto.length, 0, 'IT still mixes Acconto:\n' + acconto.slice(0, 20).map(([k, v]) => k + '=' + v).join('\n'));
assert.equal(it['drawer.invoice.guestDeposit'], 'Caparra');
assert.equal(it['calendar.create.pay.deposit'], 'Caparra');

const esChips = {
  'calendar.chip.aprMay': 'abr - may',
  'calendar.chip.mayJun': 'may - jun',
  'calendar.chip.junJul': 'jun - jul',
  'calendar.chip.julAug': 'jul - ago',
  'calendar.chip.augSept': 'ago - sep',
  'calendar.chip.sepOct': 'sep - oct',
  'calendar.chip.octNov': 'oct - nov',
};
for (const [k, v] of Object.entries(esChips)) {
  assert.equal(es[k], v, k);
}

const pricingKeys = [
  'admin.wh.pricing.addService',
  'admin.wh.pricing.addAirport',
  'admin.wh.pricing.addExtras',
  'admin.wh.pricing.addSeason',
  'admin.wh.pricing.addPackage',
];
for (const k of pricingKeys) {
  assert.ok(en[k], 'missing EN ' + k);
  assert.ok(es[k] && es[k] !== en[k], 'ES ' + k);
  assert.ok(it[k] && it[k] !== en[k], 'IT ' + k);
}

for (const k of ['app.title.schedule', 'app.title.inbox', 'app.title.bookings', 'app.title.admin', 'app.title.lunaStaff']) {
  assert.ok(en[k], 'missing EN ' + k);
  assert.ok(es[k] && es[k] !== en[k], 'ES ' + k);
  assert.ok(it[k] && it[k] !== en[k], 'IT ' + k);
}
assert.ok(en['app.school'] && es['app.school'] !== en['app.school'] && it['app.school'] !== en['app.school']);
assert.ok(en['lunaStaff.roomSetup'] && es['lunaStaff.roomSetup'] !== en['lunaStaff.roomSetup']);

const inboxThread = fs.readFileSync(path.join(__dirname, 'browser/inbox-thread.js'), 'utf8');
assert.match(inboxThread, /inboxT\('inbox.thread.delete'/);
assert.match(inboxThread, /inboxT\('inbox.thread.spam'/);
assert.match(inboxThread, /inboxT\('inbox.thread.guest'/);
assert.doesNotMatch(inboxThread, />Delete<\/button>/);
assert.doesNotMatch(inboxThread, />Spam<\/button>/);
assert.doesNotMatch(inboxThread, /msg-meta\">Guest &bull;/);

const inboxRows = fs.readFileSync(path.join(__dirname, 'browser/inbox-rows.js'), 'utf8');
assert.match(inboxRows, /formatStaffPortalDate/);
assert.doesNotMatch(inboxRows, /toLocaleDateString\(undefined/);

const cust = fs.readFileSync(path.join(__dirname, 'browser/inbox-customers-profile.js'), 'utf8');
assert.match(cust, /formatStaffPortalDate/);
assert.doesNotMatch(cust, /toLocaleDateString\(undefined/);

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
assert.match(api, /id=\"staff-lang-switch\"[^>]*data-i18n-aria=\"app\.language\"/);
assert.doesNotMatch(api, /id=\"staff-lang-switch\" aria-label=\"Language\"/);
assert.match(api, /id=\"staff-school-switch\"[^>]*data-i18n-aria=\"app\.school\"/);
assert.doesNotMatch(api, /id=\"staff-school-switch\" aria-label=\"School\"/);
assert.match(api, /id=\"bc-load\"[^>]*data-i18n-aria=\"drawer\.toolbar.refresh\"/);
assert.match(api, /id=\"bc-load\"[^>]*data-i18n-title=\"drawer\.toolbar.refresh\"/);
assert.match(api, /function staffPortalSetDocumentTitle\(/);
assert.match(api, /staffPortalSetDocumentTitle\(tab\)/);
assert.match(api, /label\.setAttribute\('data-i18n',\s*'lunaStaff\.roomSetup'\)/);

const i18nSrc = fs.readFileSync(path.join(__dirname, 'lib/staff-portal-i18n.js'), 'utf8');
assert.match(i18nSrc, /window\.formatStaffPortalDateTime\s*=\s*function/);

const loginSrc = fs.readFileSync(path.join(__dirname, 'lib/staff-portal-login-page.js'), 'utf8');
assert.match(loginSrc, /data-i18n=\"login\.sub\"/);

console.log('PASS verify-staff-pass3-es-it-chrome');
