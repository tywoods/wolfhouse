'use strict';

// Desktop Schedule stays inside the viewport. The grid and booking rail scroll.
// Phones still scroll the page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const marker = 'SCHEDULE-VIEWPORT-LOCK-001';
const at = api.indexOf(marker);
assert.ok(at > 0, 'viewport lock marker');

const desktopStart = api.lastIndexOf('@media (min-width:769px){', at);
assert.ok(desktopStart > 0 && desktopStart < at, 'lock lives in the desktop media query');
const desktopEnd = api.indexOf('@media (max-width:768px){', at);
assert.ok(desktopEnd > at, 'phone block follows the lock');
const desktop = api.slice(desktopStart, desktopEnd);

assert.match(desktop, /html:has\(#tab-bed-calendar\.active\)/);
assert.match(desktop, /body:has\(#tab-bed-calendar\.active\)/);
assert.match(desktop, /height:100vh/);
assert.match(desktop, /height:100dvh/);
assert.match(desktop, /overflow:hidden/);
assert.match(desktop, /#tab-bed-calendar\.active\{[^}]*overflow:hidden/);
assert.match(desktop, /#tab-bed-calendar\.active #bc-grid-wrap\{[^}]*min-height:0/);
assert.match(desktop, /#tab-bed-calendar\.active #bc-grid-wrap\{[^}]*overflow-y:auto/);
assert.match(desktop, /#tab-bed-calendar\.active #bc-grid-resize-handle\{[^}]*flex:0 0 auto/);
assert.match(desktop, /#bc-side-drawer \.bc-side-body\{[^}]*overflow-y:auto/);
assert.match(desktop, /#bc-side-drawer \.bc-side-body\{[^}]*min-height:0/);
assert.match(desktop, /#bc-side-drawer \.bc-side-body\{[^}]*padding-bottom:24px/);
assert.match(desktop, /#bc-side-drawer\.is-open\{[^}]*bottom:12px/);

const phone = api.slice(desktopEnd, desktopEnd + 900);
assert.equal(phone.includes(marker), false, 'phone block must not lock the page');
assert.match(phone, /#tab-bed-calendar #bc-grid-wrap,#tab-bed-calendar \.bc-grid-wrap-inner\{overflow-x:auto/);
assert.match(api, /body > \.tab-panel\.active\{[^}]*overflow:auto/);
assert.match(api, /id="bc-grid-resize-handle"/);
assert.match(api, /id="bc-side-drawer"/);

console.log('PASS schedule viewport lock');
