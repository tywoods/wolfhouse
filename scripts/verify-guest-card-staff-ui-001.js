'use strict';

/**
 * Focused verifier for GUEST-CARD-STAFF-UI-001.
 * Run: node scripts/verify-guest-card-staff-ui-001.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const file = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

let pass = 0;
let fail = 0;
function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

console.log('\nverify:guest-card-staff-ui-001 — focused Staff UI checks\n');

const customerProfile = file('scripts', 'browser', 'inbox-customers-profile.js');
const drawerController = file('scripts', 'browser', 'sunset-schedule-drawer-controller.js');
const drawerView = file('scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const staffApi = file('scripts', 'staff-query-api.js');
const bookingWrites = file('scripts', 'lib', 'sunset-schedule-booking-writes.js');
const i18nEn = file('scripts', 'lib', 'staff-portal-i18n.js');
const i18nEs = file('scripts', 'lib', 'staff-portal-i18n-es-sunset.js');

console.log('[1] People/customer card header actions');
assert('Create booking action is visible in customer card header', customerProfile.includes('id="cust-profile-create-booking"'));
assert('Start/Open conversation action is visible in customer card header', customerProfile.includes('id="cust-conversation-btn"')
  && customerProfile.includes('customers.conversation.start')
  && customerProfile.includes('customers.conversation.open'));
assert('Edit profile action is explicit in customer card header', customerProfile.includes('id="cust-profile-edit-btn"')
  && customerProfile.includes('customers.editProfile'));

console.log('\n[2] Message/Start conversation phone hardening + i18n');
assert('customer card validates real WhatsApp phones', customerProfile.includes('function customerHasWhatsappMessagePhone')
  && customerProfile.includes('emailcust1|emailv1|email')
  && customerProfile.includes("raw.indexOf('staff:') === 0")
  && customerProfile.includes('/[A-Za-z]/')
  && customerProfile.includes('digits.length >= 6'));
assert('invalid customer phone disables conversation button with guidance', customerProfile.includes('customers.conversation.needPhone')
  && customerProfile.includes('disabled title="')
  && customerProfile.includes('cust-profile-msg'));
assert('schedule drawer normalizes away synthetic/email/alpha/short phones', staffApi.includes('function scheduleNormalizeGuestPhone')
  && staffApi.includes('emailcust1|emailv1|email')
  && staffApi.includes('/[A-Za-z]/')
  && staffApi.includes("p.indexOf('staff:') === 0")
  && staffApi.includes("p.replace(/\\D/g, '').length < 6"));
assert('EN/ES invalid phone guidance present', i18nEn.includes("'customers.conversation.needPhone'")
  && i18nEn.includes("'schedule.drawer.conversationNeedPhone'")
  && i18nEs.includes("'customers.conversation.needPhone'")
  && i18nEs.includes("'schedule.drawer.conversationNeedPhone'"));

console.log('\n[3] Schedule drawer Open customer stays in /staff/ui customer-card path');
assert('schedule drawer renders Open customer action', drawerView.includes('id="ps-drawer-open-customer"')
  && drawerView.includes('schedule.drawer.openCustomer'));
assert('Open customer calls openCustomerCardForPhone', drawerController.includes('openCustomerCardForPhone(phone)'));
assert('Open customer does not navigate to legacy /staff/guest page', !/\/staff\/guest\//.test(drawerController + drawerView));

console.log('\n[4] Manual schedule booking links People only, no Inbox side effect');
const linkIdx = bookingWrites.indexOf('createOrMergeManualCustomer');
const serviceInsertIdx = bookingWrites.indexOf('INSERT INTO booking_service_records', linkIdx);
const commitIdx = bookingWrites.indexOf("await pg.query('COMMIT')", linkIdx);
const linkBlock = bookingWrites.slice(linkIdx, Math.max(commitIdx, linkIdx + 1));
assert('manual booking with guest_phone calls createOrMergeManualCustomer inside txn', linkIdx > 0 && serviceInsertIdx > linkIdx && commitIdx > serviceInsertIdx);
assert('manual booking customer link is People-only (no conversation insert/create)', linkBlock.includes('createOrMergeManualCustomer')
  && !/createConversation|conversation_id|INSERT INTO\s+conversations/i.test(linkBlock));
assert('create response exposes customer link proof', bookingWrites.includes('customer: customerLink')
  && bookingWrites.includes('customer_id: customerResult.body.customer_id'));

console.log('\n[5] Booking drawer Message/Mensaje uses create-or-open behavior');
assert('drawer conversation button labels Start/Open through i18n', drawerController.includes('schedule.drawer.startConv')
  && drawerController.includes('schedule.drawer.openConv'));
assert('existing linked conversation opens instead of POSTing create', drawerController.includes('scheduleFindLinkedConversation')
  && drawerController.includes('scheduleOpenOrStartConversationFromBooking(linkedSource)'));
assert('new booking conversation uses create-or-open booking behavior', staffApi.includes("fetch('/staff/bookings/create-conversation")
  && staffApi.includes('booking_id: group.booking_id || undefined')
  && staffApi.includes('idempotency_key: idemKey')
  && staffApi.includes('scheduleStartConversationFromBooking')
  && staffApi.includes('scheduleOpenOrStartConversationFromBooking'));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail) {
  console.error('verify:guest-card-staff-ui-001 — FAILED');
  process.exit(1);
}
console.log('verify:guest-card-staff-ui-001 — ALL CHECKS PASSED');
