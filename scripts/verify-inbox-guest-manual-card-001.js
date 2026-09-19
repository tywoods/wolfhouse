'use strict';

/**
 * Focused verifier for INBOX-GUEST-MANUAL-CARD-001.
 * Run: node scripts/verify-inbox-guest-manual-card-001.js
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

console.log('\nverify:inbox-guest-manual-card-001 — manual booking People card linkage\n');

const createService = file('scripts', 'lib', 'luna-front-desk-accommodation-booking-create-service.js');
const scheduleWrites = file('scripts', 'lib', 'sunset-schedule-booking-writes.js');
const staffApi = file('scripts', 'staff-query-api.js');
const inboxViews = file('scripts', 'browser', 'inbox-views.js');

console.log('[1] Accommodation manual booking create materializes and links People row');
assert('create service imports createOrMergeManualCustomer',
  createService.includes("const { createOrMergeManualCustomer } = require('./staff-customer-queries');"));
assert('manual staff create calls ensureManualBookingCustomerLink after booking insert',
  /const customerLink = await ensureManualBookingCustomerLink\(pg, command, result\.booking_id\);/.test(createService));
assert('manual staff create writes bookings.customer_id inside transaction',
  /UPDATE bookings[\s\S]*SET customer_id = \$3::uuid[\s\S]*AND \(customer_id IS NULL OR customer_id = \$3::uuid\)/.test(createService));
assert('manual staff create is People-only and does not create a conversation side effect',
  !/ensureManualBookingCustomerLink[\s\S]*create-conversation/i.test(createService)
  && !/ensureManualBookingCustomerLink[\s\S]*INSERT INTO\s+conversations/i.test(createService));
assert('manual booking response returns customer link proof',
  staffApi.includes('customer:          row._customer_link || null')
  && staffApi.includes('customer_id:       row._customer_link && row._customer_link.customer_id'));

console.log('\n[2] Sunset schedule manual booking also stores bookings.customer_id');
const scheduleLinkIdx = scheduleWrites.indexOf('createOrMergeManualCustomer');
const scheduleUpdateIdx = scheduleWrites.indexOf('SET customer_id = $2::uuid', scheduleLinkIdx);
const scheduleCommitIdx = scheduleWrites.indexOf("await pg.query('COMMIT')", scheduleLinkIdx);
assert('schedule manual booking updates customer_id before commit',
  scheduleLinkIdx > 0 && scheduleUpdateIdx > scheduleLinkIdx && scheduleCommitIdx > scheduleUpdateIdx);

console.log('\n[3] Guest-mode People row without a conversation renders the right Guest card');
assert('empty-person detail keeps a right sidebar mount',
  inboxViews.includes('id="inbox-detail-sidebar"'));
assert('customer-only People rows fetch customer context, not a conversation thread',
  inboxViews.includes("'/staff/customers/' + encodeURIComponent(phone) + '/context?client='")
  && !/function inboxViewsPaintPersonCustomerCard[\s\S]*\/staff\/inbox\/thread/.test(inboxViews));
assert('customer-only People rows render through inboxCustomerFullHtml and wire actions',
  inboxViews.includes('function inboxViewsPaintPersonCustomerCard(row)')
  && inboxViews.includes('inboxCustomerFullHtml(payload')
  && inboxViews.includes('inboxCustomerWireFull(sidebar, payload)'));
assert('opening a People row with no conversation paints the customer card',
  /function inboxViewsOpenPersonWithoutConversation\(row, targetEl\)[\s\S]*inboxViewsPaintEmptyPersonDetail\(row, targetEl\);[\s\S]*inboxViewsPaintPersonCustomerCard\(row\);/.test(inboxViews));

console.log('\n' + '─'.repeat(64));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail) {
  console.error('verify:inbox-guest-manual-card-001 — FAILED');
  process.exit(1);
}
console.log('verify:inbox-guest-manual-card-001 — ALL CHECKS PASSED');
