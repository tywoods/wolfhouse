#!/usr/bin/env node
'use strict';

// Fast source + isolated pointer lifecycle gate. Real native touch and layout
// acceptance lives in verify-phone-scroll-anywhere-refix-001.js, not this mock.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const root = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(root, 'scripts/browser/inbox-shell.js'), 'utf8');
const ui = require('./lib/staff-portal-ui-source').readStaffPortalUiSource();
let passed = 0;
function ok(label, condition) { assert(condition, label); passed++; console.log('PASS', label); }
ok('phone list permits document scroll chaining without blocking native touch', shell.includes('overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:auto;touch-action:pan-y'));
ok('phone-width mouse drag wiring is mounted', shell.includes('wireInboxShellPhoneListDrag();'));
ok('portal runtime contains refix', ui.includes('PHONE-SCROLL-ANYWHERE-REFIX-001'));
const fnStart = shell.indexOf('function wireInboxShellPhoneListDrag(){');
const fnEnd = shell.indexOf('\nfunction mountInboxShellChrome(){', fnStart);
assert(fnStart > 0 && fnEnd > fnStart);
const fnSource = shell.slice(fnStart, fnEnd);
function harness({ width = 390, bounded = true, overflow = 'auto', documentRange = true, action = false, inside = true } = {}) {
  const listeners = {}, attrs = {}, classes = new Set();
  const body = {};
  const rootScroller = { scrollHeight: documentRange ? 3000 : 844, clientHeight: 844, scrollTop: 300 };
  const surface = { scrollHeight: bounded ? 1200 : 400, clientHeight: 400, scrollTop: 300, parentElement: body, isConnected: true,
    classList: { add: s => classes.add(s), remove: s => classes.delete(s) },
    setPointerCapture() {}, releasePointerCapture() {}, contains: t => t === target || t === surface };
  const target = { closest: selector => selector.startsWith('#tab-conversations') ? (inside ? surface : null) : (action ? target : null) };
  function add(name, fn) { (listeners[name] ||= []).push(fn); }
  const win = { innerWidth: width, addEventListener: add, getComputedStyle: () => ({ overflowY: overflow }) };
  const document = { body, scrollingElement: rootScroller,
    documentElement: { getAttribute: n => attrs[n] || null, setAttribute: (n, v) => { attrs[n] = v; } }, addEventListener: add };
  const context = vm.createContext({ window: win, document, Date, Math });
  vm.runInContext(fnSource + '\nwireInboxShellPhoneListDrag();wireInboxShellPhoneListDrag();', context);
  ok('wiring is idempotent', listeners.pointerdown.length === 1);
  function emit(type, extra = {}) {
    const ev = { target, pointerType: 'mouse', button: 0, buttons: 1, pointerId: 7, clientY: 300, detail: 1,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
    (listeners[type] || []).forEach(fn => fn(ev)); return ev;
  }
  return { emit, surface, rootScroller, classes, win, target };
}
for (const bounded of [true, false]) {
  const h = harness({ bounded });
  h.emit('pointerdown'); h.emit('pointermove', { clientY: 297 });
  ok('small jitter preserves click/selection', !h.classes.size && h.surface.scrollTop === 300 && h.rootScroller.scrollTop === 300);
  h.emit('pointermove', { clientY: 220 });
  ok(bounded ? 'bounded pane owns drag' : 'auto-height surface delegates drag to document', (bounded ? h.surface : h.rootScroller).scrollTop === 380);
  h.emit('pointerup');
  const click = h.emit('click');
  ok('only dragged activation is suppressed', click.prevented && click.stopped && !h.classes.size);
  ok('suppression is consumed', !h.emit('click').prevented);
  h.emit('pointerdown'); h.emit('pointerup');
  ok('next ordinary tap remains usable', !h.emit('click').prevented);
}
for (const options of [{ width: 1500 }, { action: true }, { inside: false }, { bounded: false, documentRange: false }]) {
  const h = harness(options); h.emit('pointerdown'); h.emit('pointermove', { clientY: 220 }); h.emit('pointerup');
  ok('no interception: ' + JSON.stringify(options), h.surface.scrollTop === 300 && h.rootScroller.scrollTop === 300 && !h.emit('click').prevented);
}
for (const pointerType of ['touch', 'pen']) {
  const h = harness(); h.emit('pointerdown', { pointerType });
  const move = h.emit('pointermove', { pointerType, clientY: 220 });
  ok(pointerType + ' stays native', h.surface.scrollTop === 300 && !move.prevented);
}
{
  const h = harness({ overflow: 'hidden' }); h.emit('pointerdown'); h.emit('pointermove', { clientY: 220 });
  ok('hidden overflow ancestor is not a user scroll owner', h.surface.scrollTop === 300 && h.rootScroller.scrollTop === 380);
}
for (const cancel of ['pointercancel', 'lostpointercapture', 'blur']) {
  const h = harness(); h.emit('pointerdown'); h.emit('pointermove', { clientY: 220 }); h.emit(cancel);
  h.emit('pointermove', { clientY: 180 });
  ok(cancel + ' stops dragging and clears state', !h.classes.size && h.surface.scrollTop === 380 && !h.emit('click').prevented);
}
{
  const h = harness(); h.emit('pointerdown'); h.emit('pointermove', { pointerId: 9, clientY: 200 });
  ok('unrelated pointer cannot move owner', h.surface.scrollTop === 300);
  h.win.innerWidth = 1500; h.emit('pointermove', { clientY: 200 });
  ok('resize to desktop cancels drag', h.surface.scrollTop === 300 && !h.classes.size);
}
{
  const h = harness(); h.emit('pointerdown'); h.emit('pointermove', { clientY: 220 }); h.emit('pointerup');
  ok('keyboard activation bypasses mouse suppression', !h.emit('click', { detail: 0 }).prevented);
  h.emit('pointerdown'); h.emit('pointerup');
  ok('immediate fresh click clears old suppression', !h.emit('click').prevented);
}
console.log(`verify-phone-inbox-scroll-anywhere-001: PASS (${passed} assertions)`);
