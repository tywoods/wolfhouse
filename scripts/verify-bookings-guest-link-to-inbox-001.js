#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function ok(label, condition, detail) {
  if (!condition) {
    console.error('FAIL', label, detail || '');
    process.exitCode = 1;
    return;
  }
  console.log('PASS', label);
}

const ui = read('scripts/browser/sunset-admin-bookings-ui.js');
const data = read('scripts/lib/sunset-bookings-admin-data.js');
const domain = read('scripts/lib/sunset-bookings-admin.js');
const customers = read('scripts/browser/inbox-customers-profile.js');
const customerRoutes = read('scripts/lib/staff-customers-routes.js');
const customerQueries = read('scripts/lib/staff-customer-queries.js');

const openFn = /function adminBookingsOpenGuestInInbox\([\s\S]*?\n}\n\n\/\*\*/.exec(ui);
ok('Bookings has guest-link Inbox opener', !!openFn);
const openSrc = openFn ? openFn[0] : '';
ok('Bookings opener calls canonical openCustomerCardForPhone', /openCustomerCardForPhone/.test(openSrc));
ok('Bookings opener passes customer_id option', /customer_id:\s*customerId/.test(openSrc));
ok('Bookings opener gracefully handles missing phone', /No phone on this booking/.test(openSrc) && /return Promise\.resolve\(false\)/.test(openSrc));
ok('Bookings opener never navigates to /staff/guest', !/\/staff\/guest\//.test(openSrc));

ok('Guest column emits data-bookings-customer-id', /data-bookings-customer-id=/.test(ui));
ok('Guest click handlers use adminBookingsOpenGuestInInbox', (ui.match(/adminBookingsOpenGuestInInbox\(/g) || []).length >= 3);
ok('Guest click handlers no longer call local peek directly', !/adminBookingsOpenGuestPeek\(phone(Key)?, guestId(Key)?\)/.test(ui));

ok('Bookings admin list selects b.customer_id', /b\.customer_id::text AS customer_id/.test(data));
ok('Bookings admin domain returns customer_id', /customer_id:\s*booking\.customer_id \|\| src\.customer_id/.test(domain));
ok('Customer list API exposes customer_id', /customer_id:\s*row\.customer_id/.test(customerRoutes));
ok('Customer list query projects cu.id as customer_id', /cu\.id::text AS customer_id/.test(customerQueries));
ok('openCustomerCardForPhone passes opts.customer_id into Guest People helper', /preferredCustomerId/.test(customers) && /inboxViewsOpenGuestByPhone\(phone, \{ customer_id: preferredCustomerId \}\)/.test(customers));

if (process.exitCode) process.exit(process.exitCode);
console.log('PASS BOOKINGS-GUEST-LINK-TO-INBOX-001');
