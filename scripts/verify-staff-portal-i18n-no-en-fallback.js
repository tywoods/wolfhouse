'use strict';

/**
 * Every EN Staff portal key must have ES and IT values that are not English
 * fallbacks. Proper nouns / loanwords may match EN via ALLOW_SAME_AS_EN.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const ALLOW_SAME_AS_EN = new Set([
  'WhatsApp', 'Email', 'Luna', 'Luna Front Desk', 'Lab', 'On', 'Off', 'Auto',
  'OK', 'IBAN', 'Stripe', 'EUR', 'Chats', 'IMAP', 'SMTP', 'Gmail', 'Microsoft',
  'Graph', 'CSV', 'PDF', 'QR', 'PIN', 'ID', 'URL', 'API', 'HTTP', 'JSON', 'VIP',
  'Check-in', 'Check-out', 'Yoga', 'Tour Operator', 'Wolfhouse', 'Somo',
  'Sunset', 'elSardi', 'El Sardinero', 'Liencres', 'Surf House', 'Moonlight',
  'Demo', 'Chat', 'Spam', 'Extra', 'Error', 'Transfer', 'Tour', 'Prompt', 'Prep',
  'Lead', 'Newsletter OK', '1h', '2h', 'off', 'No', 'Yes', 'SUP', 'Surfer',
  'Flexible', 'Normal', 'Local', 'Ref', 'Subtotal', 'Total', 'Sunset Surf School',
]);

function isPlaceholderOnly(s) {
  return String(s || '').replace(/\{[^}]+\}/g, '').replace(/[\s.,:;!?'"()\-–—·/\\]+/g, '') === '';
}

function pack(loc) {
  return STAFF_PORTAL_STRINGS[loc] || {};
}

const en = pack('en');
assert.ok(Object.keys(en).length > 1000, 'EN pack loaded');

const leftover = { es: [], it: [] };
for (const loc of ['es', 'it']) {
  const p = pack(loc);
  for (const [key, enVal] of Object.entries(en)) {
    const val = p[key];
    if (val == null || val === '') {
      leftover[loc].push(`MISSING ${key}`);
      continue;
    }
    if (val === enVal) {
      if (ALLOW_SAME_AS_EN.has(enVal) || isPlaceholderOnly(enVal)) continue;
      leftover[loc].push(`${key} = ${JSON.stringify(enVal)}`);
    }
  }
}

assert.equal(leftover.es.length, 0, `ES still English/missing (${leftover.es.length}):\n${leftover.es.slice(0, 40).join('\n')}`);
assert.equal(leftover.it.length, 0, `IT still English/missing (${leftover.it.length}):\n${leftover.it.slice(0, 40).join('\n')}`);

assert.ok(en['login.showPassword'], 'EN login.showPassword');
assert.ok(pack('es')['login.showPassword'] && pack('es')['login.showPassword'] !== en['login.showPassword']);
assert.ok(pack('it')['login.showPassword'] && pack('it')['login.showPassword'] !== en['login.showPassword']);
assert.ok(en['login.hidePassword'], 'EN login.hidePassword');
assert.ok(pack('es')['login.hidePassword'] && pack('es')['login.hidePassword'] !== en['login.hidePassword']);
assert.ok(pack('it')['login.hidePassword'] && pack('it')['login.hidePassword'] !== en['login.hidePassword']);

const loginSrc = fs.readFileSync(path.join(__dirname, 'lib/staff-portal-login-page.js'), 'utf8');
assert.match(loginSrc, /data-i18n-aria="login\.showPassword"/);
assert.match(loginSrc, /window\.t\('login\.showPassword'\)/);
assert.match(loginSrc, /window\.t\('login\.hidePassword'\)/);
assert.doesNotMatch(loginSrc, /ACCESO STAFF|ACCESSO STAFF/);

assert.match(loginSrc, /<title[^>]*data-i18n="login\.documentTitle"/);
assert.doesNotMatch(loginSrc, /<title>Luna Front Desk — Sign in<\/title>/);
assert.ok(en['login.documentTitle'], 'EN login.documentTitle');
assert.ok(pack('es')['login.documentTitle'] && pack('es')['login.documentTitle'] !== en['login.documentTitle']);
assert.ok(pack('it')['login.documentTitle'] && pack('it')['login.documentTitle'] !== en['login.documentTitle']);

const i18nSrc = fs.readFileSync(path.join(__dirname, 'lib/staff-portal-i18n.js'), 'utf8');
assert.match(i18nSrc, /document\.title = window\.t\(/);

const itStaffHits = [];
for (const [key, val] of Object.entries(pack('it'))) {
  if (/\bstaff\b/i.test(String(val))) itStaffHits.push(`${key} = ${JSON.stringify(val)}`);
}
assert.equal(itStaffHits.length, 0, `IT pack still has English loanword staff (${itStaffHits.length}):\n${itStaffHits.slice(0, 40).join('\n')}`);

assert.match(loginSrc, /data-i18n-aria="app\.language"/);
assert.doesNotMatch(loginSrc, /aria-label="Language"/);
assert.ok(en['app.language'], 'EN app.language');
assert.ok(pack('es')['app.language'] && pack('es')['app.language'] !== en['app.language']);
assert.ok(pack('it')['app.language'] && pack('it')['app.language'] !== en['app.language']);

console.log('PASS verify-staff-portal-i18n-no-en-fallback');
