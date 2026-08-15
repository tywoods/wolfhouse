'use strict';

/**
 * BUG-005 — Horario drawer Escape, scroll restore, Aplicar above footer.
 * Stay off Inbox, email, language packs, production.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const drawerSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-controller.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

assert.ok(drawerSrc.includes('function scheduleOverlayIsOpen'));
assert.ok(drawerSrc.includes('closeScheduleCreateModal'));
assert.ok(drawerSrc.includes("document.documentElement.style.overflow = ''"));
assert.ok(drawerSrc.includes('if (schedulePageHasOverlay()) return;'));
assert.ok(apiSrc.includes('scheduleDrawerLockPage'));
assert.ok(apiSrc.includes('scheduleDrawerUnlockPage'));
assert.ok(apiSrc.includes('scheduleDrawerWireDismiss'));
assert.ok(apiSrc.includes('padding:14px 18px 220px'));
assert.ok(apiSrc.includes('scroll-margin-bottom:168px'));
assert.ok(apiSrc.includes("applyBtn.scrollIntoView"));
assert.ok(!drawerSrc.includes('inbox-thread.js'));
assert.ok(!/staff-email-oauth|inbox-thread/.test(apiSrc.slice(
  apiSrc.indexOf('function openScheduleCreateModal'),
  apiSrc.indexOf('function openScheduleCreateModal') + 1800
)));

const start = drawerSrc.indexOf('function scheduleOverlayIsOpen');
const end = drawerSrc.indexOf('function scheduleDrawerEnsureDocumentLayer');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(drawerSrc.slice(start, end) + '\nthis.scheduleOverlayIsOpen = scheduleOverlayIsOpen;', sandbox);

function node(attrs) {
  return {
    hidden: !!attrs.hidden,
    style: { display: attrs.display || '' },
    getAttribute(k) { return k === 'aria-hidden' ? (attrs.aria || null) : null; },
  };
}
assert.strictEqual(sandbox.scheduleOverlayIsOpen(null), false);
assert.strictEqual(sandbox.scheduleOverlayIsOpen(node({ display: 'none', aria: 'true' })), false);
assert.strictEqual(sandbox.scheduleOverlayIsOpen(node({ display: 'flex', aria: 'false' })), true);
assert.strictEqual(sandbox.scheduleOverlayIsOpen(node({ display: 'block' })), true);
assert.strictEqual(sandbox.scheduleOverlayIsOpen(node({ display: '', aria: 'true' })), false);

console.log('PASS BUG-005 Escape + scroll unlock + Aplicar clearance');
