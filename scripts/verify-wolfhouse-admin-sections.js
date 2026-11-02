'use strict';

/**
 * Lock Wolfhouse Admin wiring. Room Setup has no navigation state; its real
 * card is owned by Luna Staff.
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

assert.ok(!html.includes('id="wh-admin-tab-room-setup"'), 'Room Setup button is absent from Admin nav');
assert.ok(html.includes('id="wh-admin-panel-room-setup"'), 'inert compatibility panel may remain');
assert.ok(!ui.includes("'room-setup'"), 'Room Setup is absent from Admin navigation state and branches');
const combine = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-luna-cards-combine.js'), 'utf8');
assert.ok(combine.includes("salccPlaceWolfhouse(host, notes, styleWrap, room, numbersWrap)"), 'Luna Staff combiner owns Room Setup and notifications');
assert.ok(combine.includes("host.insertBefore(room, styleWrap.nextSibling)"), 'Luna Staff places Room Setup after personal cards');
assert.ok(combine.includes("host.insertBefore(numbersWrap, room.nextSibling)"), 'Luna Staff places notifications after Room Setup');
assert.ok(!combine.includes("function salccPlaceWolfhouseRoomSetup"), 'retired parallel Room Setup mover stays absent');
assert.ok(html.includes("staff-coming-soon-section"), 'notifications stay greyed/off');

console.log('PASS wolfhouse admin sections', REQUIRED.join(', '));
