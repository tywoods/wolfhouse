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
    new_conversation: { enabled: true, recipients: [{ name: 'Alex', phone: '+34600000001' }] },
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
    + '\nthis.staffWhatsappNumbersRender = staffWhatsappNumbersRender;',
  box,
);

box.staffWhatsappNumbersRender([]);
assert.ok(!/No numbers yet/.test(box._tbody.innerHTML), 'alert recipients clear empty chrome');
assert.ok(box._tbody.innerHTML.includes('+34600000001'), 'alert recipient phone rendered');

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
