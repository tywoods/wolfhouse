'use strict';

/**
 * Luna Staff — Staff & Owner Numbers empty state.
 *
 * "No numbers yet" must only appear when there are actually no numbers:
 * neither DB staff numbers nor Guest Conversation Alert recipients.
 * Overlapping loads / Sunset school switches must not leave empty chrome stuck.
 *
 * Stay off inbox-thread.js, email inbound/poller/Graph, Admin Email backend, production.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const i18nEn = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const i18nEs = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');

assert.ok(!/tbody\.innerHTML = '<tr><td colspan="5" style="opacity:\.7">No numbers yet\.<\/td><\/tr>'/.test(api),
  'hardcoded English empty row assignment must stay gone');
assert.ok(api.includes('function staffNotificationAllRecipients'), 'alert recipient fallback helper');
assert.ok(api.includes('rows = staffNotificationAllRecipients()'), 'render falls back to alert recipients');
assert.ok(api.includes('function staffWhatsappNumbersPendingLoad'), 'pending-load gate');
assert.ok(api.includes('staffWhatsappNumbersPendingLoad()'), 'empty paint defers while pending');
assert.ok(api.includes('staffWhatsappNumbersLoadSeq'), 'numbers load seq guard');
assert.ok(api.includes('staffNotificationSettingsLoadSeq'), 'settings load seq guard');
assert.ok(!/if \(staffNotificationSettingsFetchInFlight\) return;/.test(api),
  'settings load must not drop overlapping school-switch fetches');
assert.ok(
  /function setSunsetLocation[\s\S]*?wireLunaStaffTabCards\(\);\n    \}\n  \}\n\}/.test(api)
    || /school switches so "No numbers yet" cannot stick/.test(api),
  'Sunset school switch reloads Luna Staff cards',
);
assert.ok(api.includes("portalT('lunaStaff.numbers.empty')"), 'empty label uses i18n');
assert.ok(api.includes("portalT('lunaStaff.numbers.loading')"), 'loading label uses i18n');
assert.ok(i18nEn.includes("'lunaStaff.numbers.empty': 'No numbers yet.'"));
assert.ok(i18nEn.includes("'lunaStaff.numbers.loading':"));
assert.ok(i18nEs.includes("'lunaStaff.numbers.empty': 'Aún no hay números.'"));
assert.ok(i18nEs.includes("'lunaStaff.numbers.loading':"));
assert.ok(!api.includes('inbox-thread.js'), 'stay off inbox-thread.js');

// Behavioral slice: empty vs alert recipients vs pending load.
const start = api.indexOf('function staffNotificationAllRecipients');
const end = api.indexOf('function staffWhatsappNumberAdd');
assert.ok(start >= 0 && end > start, 'extract numbers render helpers');
const slice = api.slice(start, end);

const box = {
  staffNotificationSettingsCache: {
    new_conversation: { enabled: true, recipients: [{ staff_number_id: 'staff-1', name: 'Alex', phone: '+346****0001', permission_group: 'owner' }] },
    human_needed: { enabled: false, recipients: [] },
  },
  staffWhatsappNumbersLoading: false,
  staffNotificationSettingsFetchInFlight: false,
  staffWhatsappNumbersCache: [],
  portalLang: 'en',
  portalT: function (k) { return k; },
  el: function (id) {
    if (id === 'swn-tbody') return box._tbody;
    return null;
  },
  escHtml: function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },
  automatedStaffNotificationsRecipientsRender: function () {},
  _tbody: { innerHTML: '', querySelectorAll: function () { return []; } },
};

vm.createContext(box);
vm.runInContext(
  slice
    + '\nthis.staffNotificationAllRecipients = staffNotificationAllRecipients;'
    + '\nthis.staffWhatsappNumbersEmptyLabel = staffWhatsappNumbersEmptyLabel;'
    + '\nthis.staffWhatsappNumbersLoadingLabel = staffWhatsappNumbersLoadingLabel;'
    + '\nthis.staffWhatsappNumbersPendingLoad = staffWhatsappNumbersPendingLoad;'
    + '\nthis.staffWhatsappNumbersRenderRow = staffWhatsappNumbersRenderRow;'
    + '\nthis.staffWhatsappNumbersRender = staffWhatsappNumbersRender;',
  box,
);

box.staffWhatsappNumbersRender([]);
assert.ok(!/No numbers yet/.test(box._tbody.innerHTML), 'alert recipients clear empty chrome');
assert.ok(box._tbody.innerHTML.includes('+346****0001'), 'alert recipient phone rendered');
assert.ok(box._tbody.innerHTML.includes('data-swn-id="staff-1"'), 'recipient staff_number_id survives fallback row');
assert.ok(box._tbody.innerHTML.includes('swn-edit-btn'), 'recipient with staff_number_id keeps edit pen');
assert.ok(box._tbody.innerHTML.includes('Owner'), 'recipient permission_group survives fallback row');

box.staffWhatsappNumbersRender([
  { staff_number_id: 'api-staff-2', display_name: 'Herbie', phone: '+346****0004', permission_group: 'staff', active: true },
]);
assert.ok(box._tbody.innerHTML.includes('data-swn-id="api-staff-2"'), 'API/fallback rows with staff_number_id but no id keep their DOM id');
assert.ok(box._tbody.innerHTML.includes('swn-edit-btn'), 'API/fallback rows with staff_number_id but no id keep edit pen');

box.staffWhatsappNumbersRender([
  { staff_number_id: 'api-staff-3', display_name: 'Herbie', phone: '+346****0005', permission_group: 'owner', active: true, from_alerts: true },
]);
assert.ok(box._tbody.innerHTML.includes('data-swn-id="api-staff-3"'), 'staff_number_id beats from_alerts when the row is a real staff number');
assert.ok(box._tbody.innerHTML.includes('swn-edit-btn'), 'real staff-number row remains editable even if from_alerts is set');
assert.ok(box._tbody.innerHTML.includes('Owner'), 'real staff-number row keeps its group label, not Guest alerts');
const editRow = box.staffWhatsappNumbersRenderRow(
  { staff_number_id: 'api-staff-4', display_name: 'Herbie', phone: '+346****0006', permission_group: 'owner', active: true },
  true,
);
assert.ok(editRow.includes('class="swn-edit-input swn-edit-name"'), 'editing row exposes name input');
assert.ok(editRow.includes('class="swn-edit-input swn-edit-phone"'), 'editing row exposes phone input');
assert.ok(editRow.includes('class="swn-edit-select swn-edit-group"'), 'editing row exposes group select');
assert.ok(editRow.includes('class="swn-edit-active"'), 'editing row exposes active checkbox');
assert.ok(editRow.includes('class="swn-delete-btn"'), 'editing row exposes Delete');

box.staffNotificationSettingsCache = {
  new_conversation: { enabled: true, recipients: [{ name: 'Fallback only', phone: '+346****0003' }] },
  human_needed: { enabled: false, recipients: [] },
};
box.staffWhatsappNumbersRender([]);
assert.ok(box._tbody.innerHTML.includes('+346****0003'), 'legacy alert-only recipient still renders');
assert.ok(!box._tbody.innerHTML.includes('swn-edit-btn'), 'legacy alert-only recipient without id stays non-editable');

box.staffNotificationSettingsCache = {
  new_conversation: { enabled: false, recipients: [] },
  human_needed: { enabled: false, recipients: [] },
};
box.staffWhatsappNumbersLoading = true;
box.staffWhatsappNumbersRender([]);
assert.ok(!/No numbers yet/.test(box._tbody.innerHTML), 'pending load must not paint durable empty');
assert.ok(/Loading numbers/.test(box._tbody.innerHTML), 'pending load shows loading chrome');

box.staffWhatsappNumbersLoading = false;
box.staffNotificationSettingsFetchInFlight = false;
box.staffWhatsappNumbersRender([]);
assert.ok(/No numbers yet/.test(box._tbody.innerHTML), 'empty only when settled and no numbers');

box.staffWhatsappNumbersRender([
  { id: 'a', display_name: 'Sam', phone: '+34600000002', permission_group: 'staff', active: true },
]);
assert.ok(!/No numbers yet/.test(box._tbody.innerHTML), 'DB numbers clear empty chrome');
assert.ok(box._tbody.innerHTML.includes('+34600000002'), 'DB number phone rendered');

console.log('PASS luna-staff numbers empty state (alert fallback + pending + seq guards)');
