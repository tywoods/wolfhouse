#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function ok(label, condition) {
  if (!condition) {
    console.error('FAIL', label);
    process.exitCode = 1;
    return;
  }
  console.log('PASS', label);
}

const api = read('scripts/staff-query-api.js');
const profile = read('scripts/browser/inbox-customers-profile.js');
const openCustomerMatch = /function openCustomerCardForPhone\([\s\S]*?\n}\n\nfunction loadCustomerDetail/.exec(profile);
const openCustomerSrc = openCustomerMatch ? openCustomerMatch[0] : '';
const views = read('scripts/browser/inbox-views.js');
const columns = read('scripts/browser/inbox-columns.js');
const bookings = read('scripts/browser/sunset-admin-bookings-ui.js');
const schedule = read('scripts/browser/sunset-schedule-drawer-controller.js');
const inboxContext = read('scripts/browser/inbox-context.js');
const inboxThread = read('scripts/browser/inbox-thread.js');
const routes = read('scripts/lib/staff-inbox-view-routes.js');
const allUi = [api, profile, views, columns, bookings, schedule, inboxContext, inboxThread].join('\n');

ok('old Customers nav button removed', !/class="tab-btn"[^>]*data-tab="customers"/.test(api));
ok('old Customers panel removed', !/id="tab-customers"/.test(api));
ok('old Customers toolbar/add/filter surface removed from template',
  !/id="cust-search"/.test(api) && !/id="cust-add-btn"/.test(api) && !/id="cust-filters-btn"/.test(api));
ok('visible Inbox switch is Full/Guest, not Conversations/Customers destination',
  /data-view="full"/.test(api) && /data-view="guest"/.test(api) && !/data-view="customers"/.test(api));
ok('no UI caller can switch to retired customers tab', !/switchToTab\('customers'\)/.test(allUi));
ok('switchToTab defensively redirects customers to conversations',
  /if \(tab === 'customers'\) \{\n\s*tab = 'conversations';/.test(api));
ok('canonical customer opener targets Guest People helper',
  /inboxViewsOpenGuestByPhone/.test(openCustomerSrc));
ok('canonical customer opener does not touch retired Customers DOM/list/detail',
  !/cust-search|loadCustomersList|waitForCustomersDom/.test(openCustomerSrc));
ok('Guest People helper exported', /openGuestByPhone = inboxViewsOpenGuestByPhone/.test(views));
ok('Guest People helper forces guest preset and all_people',
  /inboxColumnsSetPreset\('guest', \{ immediate: true \}\)/.test(views) && /inboxSavedViewId = 'all_people'/.test(views));
ok('Guest People helper searches Inbox People endpoint',
  /\/staff\/inbox\/list\?client=/.test(views) && /view=all_people/.test(views));
ok('Inbox People rows carry customer_id for exact guest matching',
  /'customer_id'/.test(routes) && /row\.customer_id = raw\.customer_id/.test(routes));
ok('Bookings guest click uses canonical opener', /openCustomerCardForPhone/.test(bookings));
ok('Schedule Open customer uses canonical opener', /openCustomerCardForPhone\(phone\)/.test(schedule));
ok('no Staff UI path navigates to /staff/guest/', !/\/staff\/guest\//.test(allUi));

if (process.exitCode) process.exit(process.exitCode);
console.log('PASS INBOX-CUSTOMERS-DESTINATION-RETIRED');
