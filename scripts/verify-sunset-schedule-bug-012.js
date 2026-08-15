'use strict';

/**
 * BUG-012 — leftover P2s: Horario day chrome, Finanzas placeholder rows, Admin ×.
 * Stay off Inbox, Admin Email, inbox-thread.js, email-settings, Skipper inbound.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const cockpitSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-day-cockpit-ui.js'), 'utf8');
const financeUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'), 'utf8');
const adminUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');

assert.ok(cockpitSrc.includes('function scheduleCockpitPrepTitle'));
assert.ok(cockpitSrc.includes('weekday: \'short\', month: \'short\', day: \'numeric\''));
assert.ok(!/if \(!isToday\) \{\s*dateLabel = dt\.toLocaleDateString/.test(cockpitSrc));
assert.ok(financeUi.includes('cents === 0 && isPlaceholder'));
assert.ok(adminUi.includes("data-admin-action=\"delete-pack\"") && adminUi.includes("portalT('admin.action.remove')"));
assert.ok(!cockpitSrc.includes('inbox-thread.js'));
assert.ok(!financeUi.includes('staff-email-settings'));

const start = cockpitSrc.indexOf('function scheduleCockpitPrepTitle');
const end = cockpitSrc.indexOf('function scheduleCockpitDisplayName');
const box = { portalLang: 'en', portalT: (k) => k };
vm.createContext(box);
vm.runInContext(
  cockpitSrc.slice(cockpitSrc.indexOf('function scheduleCockpitT'), cockpitSrc.indexOf('function scheduleCockpitPrepTitle'))
  + cockpitSrc.slice(start, end)
  + '\nthis.scheduleCockpitPrepTitle = scheduleCockpitPrepTitle;',
  box
);
assert.ok(box.scheduleCockpitPrepTitle(true).indexOf('TODAY') >= 0 || box.scheduleCockpitPrepTitle(true) === "TODAY'S PREP");
assert.strictEqual(box.scheduleCockpitPrepTitle(false), 'PREP');
box.portalLang = 'es';
assert.strictEqual(box.scheduleCockpitPrepTitle(false), 'PREPARACIÓN');

console.log('PASS BUG-012 Horario chrome + Finanzas placeholders + labeled ×');
