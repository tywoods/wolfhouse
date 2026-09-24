#!/usr/bin/env node
'use strict';

/** PHONE-INBOX-SCROLL-ANYWHERE-001 — offline source + behavior gate. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(root, 'scripts/browser/inbox-shell.js'), 'utf8');
const ui = require('./lib/staff-portal-ui-source').readStaffPortalUiSource();

let pass = 0;
let fail = 0;
function ok(label, condition) {
  if (condition) { pass += 1; console.log('  PASS ', label); }
  else { fail += 1; console.error('  FAIL ', label); }
}

ok('shared phone list keeps native vertical touch scrolling',
  shell.includes('overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y'));
ok('phone-width mouse drag wiring is mounted',
  shell.includes('wireInboxShellPhoneListDrag();') && shell.includes('function wireInboxShellPhoneListDrag(){'));
ok('drag targets the shared list scroller used by Chats and Guests',
  shell.includes("#tab-conversations #inbox-shell:not(.show-thread) > #inbox-card .inbox-left-rows"));
ok('native touch remains authoritative', shell.includes("ev.pointerType !== 'mouse'"));
ok('drag has a movement threshold and updates scrollTop',
  shell.includes('Math.abs(delta) < 6') && shell.includes('drag.scroller.scrollTop = drag.startTop - delta'));
ok('drag does not activate the row after scrolling',
  shell.includes('suppressDraggedRowClick') && shell.includes('stopImmediatePropagation'));
ok('portal runtime contains the behavior',
  ui.includes('PHONE-INBOX-SCROLL-ANYWHERE-001') && ui.includes('wireInboxShellPhoneListDrag'));

const listeners = {};
const rootAttrs = {};
const classNames = new Set();
const scroller = {
  scrollHeight: 1200,
  clientHeight: 400,
  scrollTop: 300,
  classList: {
    add(name) { classNames.add(name); },
    remove(name) { classNames.delete(name); },
  },
  setPointerCapture() {},
};
const target = {
  closest(selector) {
    if (selector.startsWith('#tab-conversations')) return scroller;
    return null;
  },
};
const documentMock = {
  documentElement: {
    getAttribute(name) { return rootAttrs[name] || null; },
    setAttribute(name, value) { rootAttrs[name] = value; },
  },
  addEventListener(name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); },
};
const fnStart = shell.indexOf('function wireInboxShellPhoneListDrag(){');
const fnEnd = shell.indexOf('\nfunction mountInboxShellChrome(){', fnStart);
const fnSource = shell.slice(fnStart, fnEnd);
vm.runInNewContext(`${fnSource}\nwireInboxShellPhoneListDrag();`, {
  document: documentMock,
  window: { innerWidth: 390 },
  Date,
  Math,
});
function emit(name, event) { (listeners[name] || []).forEach((fn) => fn(event)); }
emit('pointerdown', { pointerType: 'mouse', button: 0, pointerId: 7, clientY: 300, target });
emit('pointermove', { pointerId: 7, clientY: 220, target, preventDefault() {} });
emit('pointerup', { pointerId: 7, target });
ok('390px mid-row mouse drag scrolls the shared list', scroller.scrollTop === 380);
let clickPrevented = false;
emit('click', {
  target,
  preventDefault() { clickPrevented = true; },
  stopImmediatePropagation() {},
});
ok('post-drag row activation is suppressed', clickPrevented);

console.log(`\nverify-phone-inbox-scroll-anywhere-001: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
