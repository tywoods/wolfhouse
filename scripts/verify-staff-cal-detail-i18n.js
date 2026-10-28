'use strict';

/**
 * Calendar booking-detail panel copy goes through Staff i18n (EN/ES/IT),
 * not hardcoded English months / nights / Paid.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

function sliceFn(name) {
  const start = api.indexOf('function ' + name + '(');
  assert.ok(start > 0, 'missing ' + name);
  let i = api.indexOf('{', start);
  let depth = 0;
  for (; i < api.length; i++) {
    if (api[i] === '{') depth++;
    else if (api[i] === '}') {
      depth--;
      if (depth === 0) return api.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

const stayFn = sliceFn('bcSideStayMetaHtml');
const dateFn = sliceFn('bcSideHeaderDateLabel');
const headerFn = sliceFn('bcDetailHeaderMetaHtml');

assert.doesNotMatch(stayFn, /' nights'|\" nights\"/);
assert.doesNotMatch(stayFn, /' guest'|\" guest\"/);
assert.match(stayFn, /booking\.stay\.nights/);
assert.match(stayFn, /booking\.stay\.guest/);

assert.doesNotMatch(dateFn, /\['Jan','Feb','Mar'/);
assert.match(dateFn, /formatStaffPortalDate/);

assert.match(headerFn, /t\('drawer\.invoice\.paid'\)/);
assert.doesNotMatch(headerFn, />Paid</);

assert.match(api, /<title[^>]*data-i18n=/);
assert.doesNotMatch(api, /<title>Luna Front Desk<\/title>/);

const guestPay = api.includes("t('drawer.invoice.paid')") && api.includes("t('drawer.invoice.owe')");
assert.ok(guestPay, 'guest pay Paid/Owe through t()');

const en = STAFF_PORTAL_STRINGS.en;
const es = STAFF_PORTAL_STRINGS.es;
const it = STAFF_PORTAL_STRINGS.it;
for (const key of [
  'booking.stay.nights',
  'booking.stay.guest',
  'booking.stay.guests',
  'drawer.invoice.paid',
  'drawer.invoice.owe',
  'drawer.invoice.total',
  'drawer.invoice.balanceDue',
  'drawer.invoice.payStatus.deposit_paid',
  'drawer.invoice.refundReview',
  'calendar.detail.newBooking',
  'drawer.invoice.perGuest',
]) {
  assert.ok(en[key], 'EN ' + key);
  assert.ok(es[key], 'ES ' + key);
  assert.ok(it[key], 'IT ' + key);
  if (key !== 'drawer.invoice.total') {
    assert.notEqual(es[key], en[key], 'ES ' + key + ' not EN');
    assert.notEqual(it[key], en[key], 'IT ' + key + ' not EN');
  }
}

assert.doesNotMatch(it['login.needHelpDetail'] || '', /\bstaff\b/i);

console.log('PASS verify-staff-cal-detail-i18n');
