'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');
const notifications = fs.readFileSync(path.join(root, 'scripts/lib/staff-whatsapp-notifications.js'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const genEs = fs.readFileSync(path.join(root, 'scripts/gen-staff-portal-es.js'), 'utf8');

assert.match(api, /\['cc-staff-notification-settings', 'staff-alerts-toggle'\]/,
  'Guest Conversation Alerts must use the shared disclosure system');
assert.match(api, /#tab-ask-luna\{font-family:var\(--font-sans\)/,
  'Luna Staff must use the shared Pricing/body sans family');
assert.doesNotMatch(api, /#tab-ask-luna\{[^}]*--luna-staff-serif/,
  'Luna Staff must not retain the one-off serif family');
assert.match(api, /staffWhatsappNumbersI18n\('lunaStaff\.alerts\.loadFailed'/,
  'notification read failures must use Staff localization');
const loadUiBody = api.slice(
  api.indexOf('function maybeLoadStaffNotificationSettings'),
  api.indexOf('function staffNotificationSettingsLoad'),
);
assert.doesNotMatch(loadUiBody, /staffNotificationShowMsg\('error', \(data && data\.error\)/,
  'raw backend notification read errors must never be shown');
assert.match(i18n, /'lunaStaff\.alerts\.loadFailed': 'Could not load guest conversation alerts\. Try again\.'/,
  'English load-failure copy missing');
assert.match(i18n, /'lunaStaff\.alerts\.loadFailed': 'Impossibile caricare gli avvisi delle conversazioni degli ospiti\. Riprova\.'/,
  'Italian load-failure copy missing');
assert.match(genEs, /'lunaStaff\.alerts\.loadFailed': 'No se pudieron cargar las alertas de conversaciones con huéspedes\. Inténtalo de nuevo\.'/,
  'Spanish generator override missing');
const getBody = notifications.slice(
  notifications.indexOf('async function getNotificationSettings'),
  notifications.indexOf('async function putNotificationSettings'),
);
assert.doesNotMatch(getBody, /ensureNotificationTables/,
  'read path must not execute unrelated event/canary DDL before selecting migrated settings');
console.log('PASS luna-staff-alerts-softs-001');
