'use strict';

/**
 * Static checks for Luna Staff automated notifications UI polish (no HTTP, no DB).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');

let pass = 0;
let fail = 0;

function ok(name, cond) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name);
  }
}

const src = fs.readFileSync(STAFF_API, 'utf8');

console.log('verify:staff-automated-notification-ui\n');

console.log('── card copy ──');
ok('Automated Staff Notifications card exists', src.includes('id="cc-automated-staff-notifications"'));
ok('Automated Staff Notifications title present', src.includes('>Automated Staff Notifications</div>'));
ok('Automated Staff Notifications subtitle updated', src.includes('Schedule Luna to answer saved prompts and send them to selected staff.'));
ok('Guest Conversation Alerts title present', src.includes('>Guest Conversation Alerts</div>'));
ok('Guest Conversation Alerts subtitle present', src.includes('Send WhatsApp alerts when Luna starts a guest conversation or needs human help.'));
ok('old visible title Staff WhatsApp Alerts removed', !src.includes('>Staff WhatsApp Alerts</div>'));
ok('prompt placeholder updated', src.includes('How many check-ins, check-outs, and surf packages do we have today?'));
ok('saved automations empty state updated', src.includes('No automated staff notifications yet. Create one above.'));

console.log('\n── nested layout + form polish ──');
ok('asn soft nested blocks present', src.includes('.asn-block{margin-bottom:14px;padding:14px;border:1px solid var(--border-soft)'));
ok('asn schedule row groups time + enabled', src.includes('.asn-schedule-row{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:flex-end'));
ok('asn actions reuse sns-actions alignment', src.includes('sns-actions asn-actions'));
ok('weekday labels grouped in asn-day-check', src.includes('class="asn-day-check"') && src.includes('<span>Mon</span>'));
ok('weekday chips align left not centered', src.includes('.asn-day-check{display:inline-flex!important') && src.includes('justify-content:flex-start'));

console.log('\n── recipient + saved card styling ──');
ok('recipient row class present', src.includes('.asn-recipient-row{display:grid'));
ok('recipient label/phone/group classes present', src.includes('asn-recipient-label') && src.includes('asn-recipient-phone') && src.includes('asn-recipient-group'));
ok('saved automation card class present', src.includes('.asn-item{border:1px solid var(--border-soft)'));
ok('saved automation header row present', src.includes('.asn-item-hdr{display:flex'));
ok('saved automation schedule row present', src.includes('asn-item-schedule'));
ok('saved automation recipients row present', src.includes('asn-item-recipients'));
ok('saved automation item row labels present', src.includes('asn-item-row-label') && src.includes('asn-item-row-value'));

console.log('\n── no live/send/runner UI additions ──');
const forbiddenUi = [
  'asn-send-test',
  'asn-test-send',
  'automatedStaffNotificationsSendTest',
  'automatedStaffNotificationsRunNow',
  'run-staff-automated-notifications',
  '--live',
];
for (const token of forbiddenUi) {
  ok(`no ${token} in staff portal UI`, !src.includes(token));
}

console.log(`\n── staff-automated-notification-ui: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
