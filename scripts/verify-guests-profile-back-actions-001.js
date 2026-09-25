#!/usr/bin/env node
'use strict';

/**
 * GUESTS-PROFILE-BACK-ACTIONS-001
 * Back arrow sits immediately left of the guest name and returns to the list
 * without changing the Guests tab or filters. Create booking is the solid
 * primary. Open conversation and Edit profile stay outline, all on one row.
 *
 *   node scripts/verify-guests-profile-back-actions-001.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const context = read('scripts/browser/inbox-context.js');
const profile = read('scripts/browser/inbox-customers-profile.js');
const api = read('scripts/staff-query-api.js');
const views = read('scripts/browser/inbox-views.js');

let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log('ok -', label);
    return;
  }
  failed += 1;
  console.error('FAIL -', label, detail || '');
}

function between(src, start, end) {
  const i = src.indexOf(start);
  const j = end ? src.indexOf(end, i + start.length) : src.length;
  return i >= 0 && j > i ? src.slice(i, j) : '';
}

const full = between(context, 'function inboxCustomerFullHtml', 'function inboxCustomerUnmatchedHtml');
const backBeforeName = full.indexOf('id="inbox-guest-profile-back"');
const nameAt = full.indexOf('class="customers-profile-name"');
ok('inbox guest back arrow is immediately left of the name', backBeforeName > 0 && nameAt > backBeforeName && nameAt - backBeforeName < 280);
ok('inbox Create booking is the primary button', full.includes('class="btn btn-primary" id="inbox-create-booking-for-guest"'));
ok('inbox Open conversation is outline, not primary', full.includes('class="btn btn-ghost" id="cust-conversation-btn"') && !full.includes('class="btn btn-primary" id="cust-conversation-btn"'));
ok('inbox Edit profile stays outline', full.includes('class="btn btn-ghost" id="cust-profile-edit-btn"'));
ok('inbox action row does not wrap', context.includes('.inbox-customer-card .customers-profile-hdr-actions{flex:1 1 100%;width:100%;margin-left:0;display:flex;flex-wrap:nowrap;gap:6px}'));
ok('inbox back returns to the list without switching folder', context.includes('function inboxGuestProfileBackToList') && context.includes('hideInboxMobileThread()') && !between(context, 'function inboxGuestProfileBackToList', 'function inboxCustomerWireFull').includes('inboxViewsSwitchSurface') && !between(context, 'function inboxGuestProfileBackToList', 'function inboxCustomerWireFull').includes('setCustomersFilter'));

const profileHead = between(profile, 'function renderCustomerProfileSection', 'function wireCustomerProfileActions');
const profileBack = profileHead.indexOf('id="cust-profile-back"');
const profileName = profileHead.indexOf('class="customers-profile-name"');
ok('customers profile back arrow is immediately left of the name', profileBack > 0 && profileName > profileBack && profileName - profileBack < 280);
ok('customers Create booking is the primary button', profileHead.includes('class="btn btn-primary" id="cust-profile-create-booking"'));
ok('customers Open conversation is outline', profileHead.includes('class="btn btn-ghost" id="cust-conversation-btn"') && !profileHead.includes('class="btn btn-primary" id="cust-conversation-btn"'));
ok('customers back does not reload filters', profile.includes('function customerProfileBackToList') && !between(profile, 'function customerProfileBackToList', 'function wireCustomerProfileActions').includes('setCustomersFilter') && !between(profile, 'function customerProfileBackToList', 'function wireCustomerProfileActions').includes('loadCustomersList('));
ok('shared action row is nowrap', api.includes('.customers-profile-hdr-actions{display:flex;flex-wrap:nowrap;gap:6px;flex:1 1 100%;width:100%;align-items:center}'));
ok('phone action buttons stay on one row', api.includes('.customers-profile-hdr-actions .btn{flex:1 1 0;min-width:0;justify-content:center;min-height:36px;white-space:nowrap}'));
ok('opening a guest without a thread still shows the phone profile', views.includes('if (typeof showInboxMobileThread === \'function\') showInboxMobileThread();'));

console.log(failed
  ? `verify:guests-profile-back-actions-001 FAILED (${failed})`
  : 'verify:guests-profile-back-actions-001 passed');
process.exit(failed ? 1 : 0);
