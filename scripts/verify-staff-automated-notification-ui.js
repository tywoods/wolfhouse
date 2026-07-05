'use strict';

/**
 * Static verifier for Automated Staff Notifications UI (scaffold + CRUD wiring).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const apiPath = path.join(ROOT, 'scripts', 'staff-query-api.js');
const src = fs.readFileSync(apiPath, 'utf8');

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

function cardIndex(id) {
  const needle = 'id="' + id + '"';
  const idx = src.indexOf(needle);
  return idx >= 0 ? idx : -1;
}

function appearsBefore(beforeId, afterId) {
  const a = cardIndex(beforeId);
  const b = cardIndex(afterId);
  return a >= 0 && b >= 0 && a < b;
}

function asnBlock() {
  const start = src.indexOf('function automatedStaffNotificationsQuery');
  const end = src.indexOf('function staffWhatsappNumbersRender', start);
  return start >= 0 && end > start ? src.slice(start, end) : '';
}

console.log('verify:staff-automated-notification-ui\n');

console.log('── card order ──');
ok('staff numbers before automated notifications', appearsBefore('cc-staff-whatsapp-numbers', 'cc-automated-staff-notifications'));
ok('automated notifications before owner insights', appearsBefore('cc-automated-staff-notifications', 'cc-owner-insights'));
ok('owner insights before staff whatsapp alerts', appearsBefore('cc-owner-insights', 'cc-staff-notification-settings'));

console.log('\n── automated notifications card markup ──');
ok('card id present', src.includes('id="cc-automated-staff-notifications"'));
ok('prompt title input', src.includes('id="asn-prompt-title"'));
ok('prompt textarea', src.includes('id="asn-prompt-text"'));
ok('enabled toggle', src.includes('id="asn-enabled"'));
ok('recipient checklist container', src.includes('id="asn-recipients"'));
ok('Mon–Sun day checkboxes with 0–6 values', src.includes('id="asn-day-mon" value="0"') && src.includes('id="asn-day-sun" value="6"'));
ok('time input', src.includes('id="asn-time"') && src.includes('type="time"'));
ok('save button enabled for CRUD', src.includes('id="asn-save-btn"') && src.includes('Save automation') && !/id="asn-save-btn"[^>]*disabled[^>]*>Coming next/.test(src));
ok('clear/reset button', src.includes('id="asn-reset-btn"') && src.includes('automatedStaffNotificationsResetForm'));
ok('saved automations list container', src.includes('id="asn-list"'));
ok('subtitle copy', src.includes('Schedule Luna to answer a saved prompt and WhatsApp selected staff on selected days/times.'));

console.log('\n── frontend CRUD wiring ──');
const block = asnBlock();
ok('automatedStaffNotificationsLoad function', /function automatedStaffNotificationsLoad/.test(src));
ok('automatedStaffNotificationsSave function', /function automatedStaffNotificationsSave/.test(src));
ok('automatedStaffNotificationsEdit function', /function automatedStaffNotificationsEdit/.test(src));
ok('automatedStaffNotificationsDelete function', /function automatedStaffNotificationsDelete/.test(src));
ok('automatedStaffNotificationsListRender function', /function automatedStaffNotificationsListRender/.test(src));
ok('automatedStaffNotificationsValidateForm function', /function automatedStaffNotificationsValidateForm/.test(src));
ok('GET /staff/automated-notifications fetch', /fetch\('\/staff\/automated-notifications' \+ automatedStaffNotificationsQuery\(\)/.test(block));
ok('POST create fetch', /method: isEdit \? 'PUT' : 'POST'/.test(block) && /'\/staff\/automated-notifications' \+ automatedStaffNotificationsQuery\(\)/.test(block));
ok('PUT update fetch', /'\/staff\/automated-notifications\/' \+ encodeURIComponent\(staffAutomatedNotificationsEditingId\)/.test(block));
ok('DELETE fetch', /method: 'DELETE'/.test(block) && /encodeURIComponent\(id\)/.test(block));
ok('query helper reuses client/location pattern', /function automatedStaffNotificationsQuery[\s\S]*staffWhatsappNumberQuery/.test(src));
ok('load wired on Luna Staff tab', /wireLunaStaffTabCards[\s\S]*automatedStaffNotificationsLoad/.test(src));
ok('load wired on owner gate', /applyOwnerInsightsGate[\s\S]*automatedStaffNotificationsLoad/.test(src));
ok('form payload includes title prompt enabled recipients days local_time', /title: title/.test(block) && /prompt: prompt/.test(block) && /enabled: enabled/.test(block) && /days_of_week: days/.test(block) && /local_time:/.test(block) && /staff_number_id/.test(block));
ok('client validation messages', block.includes('Title is required.') && block.includes('Prompt is required.') && block.includes('Select at least one recipient.') && block.includes('Select at least one day.') && block.includes('Time is required.'));
ok('empty staff numbers copy', src.includes('Add staff numbers first.'));
ok('empty automations copy', block.includes('No automations yet. Create one above.'));

console.log('\n── recipient cache wiring ──');
ok('staffWhatsappNumbersCache variable', src.includes('var staffWhatsappNumbersCache'));
ok('active-only filter helper', src.includes('function staffWhatsappNumbersCacheActive'));
ok('recipient render uses cache', /function automatedStaffNotificationsRecipientsRender[\s\S]*staffWhatsappNumbersCacheActive/.test(src));

console.log('\n── visibility gate ──');
ok('applyOwnerInsightsGate toggles automated card', /applyOwnerInsightsGate[\s\S]*cc-automated-staff-notifications[\s\S]*canUseOwnerInsightsPortal/.test(src));

console.log('\n── styling ──');
ok('desktop CSS for automated card', src.includes('#cc-automated-staff-notifications .asn-recipient-row'));
ok('saved automation item CSS', src.includes('#cc-automated-staff-notifications .asn-item'));
ok('mobile CSS for automated card', src.includes('#cc-automated-staff-notifications .asn-day-check'));

console.log('\n── safety (no live send/runner) ──');
ok('no send test now button', !/send test now/i.test(block));
ok('ASN block does not call sendLunaWhatsAppMessage', !/sendLunaWhatsAppMessage/.test(block));
ok('ASN block does not call executeStaffAskLunaQuestion', !/executeStaffAskLunaQuestion/.test(block));
ok('ASN block has no setInterval', !/setInterval/.test(block));
ok('ASN block has no cron/scheduler hooks', !/cron|scheduler|due-check/i.test(block));

console.log(`\n── staff-automated-notification-ui: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
