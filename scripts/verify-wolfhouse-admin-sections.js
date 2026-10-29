'use strict';

/**
 * Lock Wolfhouse Admin sections. Fails if Room Setup (or any required section)
 * disappears from the shared nav / shell.
 *
 *   node scripts/verify-wolfhouse-admin-sections.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REQUIRED = [
  'finance',
  'pricing',
  'room-setup',
  'luna-staff',
  'services',
  'tour-operator',
  'email',
];
const I18N = {
  en: 'Room Setup',
  es: 'Configuración de habitaciones',
  it: 'Configurazione camere',
};

const ui = fs.readFileSync(path.join(ROOT, 'scripts/browser/wolfhouse-admin-ui.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n.js');

const listMatch = ui.match(/WH_ADMIN_REQUIRED_SUBTABS = \[([^\]]+)\]/);
assert.ok(listMatch, 'WH_ADMIN_REQUIRED_SUBTABS is declared');
const keys = listMatch[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
assert.deepEqual(keys, REQUIRED, 'required Admin sections must stay in this order');

for (const key of REQUIRED) {
  assert.ok(
    html.includes(`id="wh-admin-tab-${key}"`) && html.includes(`data-wh-admin-tab="${key}"`),
    `shell tab ${key}`,
  );
  assert.ok(html.includes(`id="wh-admin-panel-${key}"`), `shell panel ${key}`);
}

assert.equal(STAFF_PORTAL_STRINGS.en['admin.tabs.roomSetup'], I18N.en);
assert.equal(STAFF_PORTAL_STRINGS.es['admin.tabs.roomSetup'], I18N.es);
assert.equal(STAFF_PORTAL_STRINGS.it['admin.tabs.roomSetup'], I18N.it);
assert.notEqual(STAFF_PORTAL_STRINGS.es['admin.tabs.roomSetup'], I18N.en);
assert.notEqual(STAFF_PORTAL_STRINGS.it['admin.tabs.roomSetup'], I18N.en);

assert.ok(html.includes("getElementById('wh-admin-panel-room-setup')"), 'collapse mounts Room Setup into the Admin panel');
const combine = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-luna-cards-combine.js'), 'utf8');
assert.ok(combine.includes("function salccPlaceWolfhouseNotifications"), 'one owner places notifications under Room Setup');
assert.ok(combine.includes("staff-coming-soon-card"), 'coming-soon card is the Room Setup owner');
assert.ok(!combine.includes('host.appendChild(numbersWrap)'), 'Luna Staff regroup does not steal notifications');
assert.ok(html.includes("staff-coming-soon-section"), 'notifications stay greyed/off');

console.log('PASS wolfhouse admin sections', REQUIRED.join(', '));
