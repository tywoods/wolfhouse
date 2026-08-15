'use strict';

/**
 * BUG-014 — Horario booking drawer phone empty-state.
 * Drawer must only ask to add a phone when the guest actually has no phone.
 * Staff API list/ctx phones count; staff:booking: synthetics do not.
 * Stay off inbox-thread.js, email inbound/Graph, Admin Email backend, production.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const drawerCtrl = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-controller.js'), 'utf8');
const drawerView = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-view-ui.js'), 'utf8');
const drawerEdit = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-edit-ui.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const drawerLib = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-drawer.js'), 'utf8');
const runtimeSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-runtime.js'), 'utf8');
const bookingsUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');

assert.ok(apiSrc.includes('function scheduleResolveGuestPhone'));
assert.ok(apiSrc.includes('function scheduleNormalizeGuestPhone'));
assert.ok(drawerLib.includes('resolveDrawerGuestPhoneFromBundle'));
assert.ok(drawerLib.includes('normalizeDrawerGuestPhone'));
assert.ok(drawerCtrl.includes('scheduleHydrateDrawerCtxPhone'));
assert.ok(drawerCtrl.includes('scheduleResolveGuestPhone(ctx, group, row)'));
assert.ok(drawerView.includes('scheduleResolveGuestPhone(ctx, row)'));
assert.ok(drawerEdit.includes('scheduleWireDrawerConversation(row, group, ctx)'));
assert.ok(runtimeSrc.includes('booking_metadata'));
assert.ok(bookingsUi.includes('phone: row.phone || null'));
assert.ok(!drawerCtrl.includes('inbox-thread'));
assert.ok(!drawerView.includes('inbox-thread'));

const {
  normalizeDrawerGuestPhone,
  resolveDrawerGuestPhoneFromBundle,
} = require('./lib/sunset-schedule-booking-drawer');

assert.strictEqual(normalizeDrawerGuestPhone(null), null);
assert.strictEqual(normalizeDrawerGuestPhone(''), null);
assert.strictEqual(normalizeDrawerGuestPhone('  '), null);
assert.strictEqual(normalizeDrawerGuestPhone('staff:booking:abc'), null);
assert.strictEqual(normalizeDrawerGuestPhone('+34600111222'), '+34600111222');

assert.strictEqual(
  resolveDrawerGuestPhoneFromBundle({
    booking: { phone: null, metadata: {} },
    services: [{ metadata: { guest_phone: '+34600999888' } }],
  }),
  '+34600999888',
);
assert.strictEqual(
  resolveDrawerGuestPhoneFromBundle({
    booking: { phone: null, metadata: { guest_phone: '+34600111222' } },
    services: [],
  }),
  '+34600111222',
);
assert.strictEqual(
  resolveDrawerGuestPhoneFromBundle({
    booking: { phone: 'staff:booking:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', metadata: {} },
    services: [],
  }),
  null,
);

const portalT = (k) => ({
  'schedule.drawer.startConv': 'Start conversation',
  'schedule.drawer.openConv': 'Open conversation',
  'schedule.drawer.conversationNeedPhone': 'Add phone number to start conversation',
  'schedule.drawer.phone': 'Phone',
  'schedule.drawer.source': 'Source',
  'schedule.col.equipment': 'Equipment',
  'schedule.col.date': 'Date',
  'schedule.col.payment': 'Payment',
  'schedule.drawer.notes': 'Notes',
  'schedule.drawer.stripeSoon': 'Soon',
  'schedule.drawer.stripeLink': 'Stripe',
  'schedule.create.guestName': 'Guest',
  'schedule.create.dateFrom': 'From',
  'schedule.create.dateTo': 'To',
  'schedule.create.date': 'Date',
  'schedule.drawer.section.dates': 'Dates',
  'schedule.drawer.bookedItems': 'Items',
}[k] || k);

function extractFunctionSource(src, name) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index;
  let brace = 0;
  let started = false;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') { brace += 1; started = true; }
    else if (ch === '}') {
      brace -= 1;
      if (started && brace === 0) return src.slice(m.index, i + 1);
    }
  }
  return null;
}

const phoneHelpers = [
  'scheduleNormalizePhoneDigits',
  'scheduleNormalizeGuestPhone',
  'schedulePhoneFromSource',
  'scheduleResolveGuestPhone',
  'scheduleGroupHasPhone',
].map((n) => extractFunctionSource(apiSrc, n)).filter(Boolean).join('\n');

assert.ok(phoneHelpers.includes('scheduleResolveGuestPhone'), 'phone helpers extractable');

const wireSrc = extractFunctionSource(drawerCtrl, 'scheduleWireDrawerConversation');
assert.ok(wireSrc, 'wire function extractable');

function runWire(row, group, ctx, inputPhone) {
  const dom = {};
  function makeEl(id, extras) {
    const o = Object.assign({
      id,
      style: { display: 'none' },
      textContent: '',
      title: '',
      disabled: false,
      onclick: null,
      value: '',
      getAttribute: () => '',
      setAttribute() {},
      addEventListener() {},
      querySelector() { return null; },
    }, extras || {});
    dom[id] = o;
    return o;
  }
  makeEl('ps-drawer-conversation-btn');
  makeEl('ps-drawer-conversation-hint');
  if (inputPhone != null) makeEl('ps-drawer-phone', { value: inputPhone });

  const sandbox = {
    console,
    el: (id) => dom[id] || null,
    portalT,
    scheduleConversationsCache: [],
    scheduleFindLinkedConversation: null,
    scheduleOpenOrStartConversationFromBooking: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(`${phoneHelpers}
scheduleFindLinkedConversation = function(group){
  var convs = scheduleConversationsCache || [];
  if (!group) return null;
  var bookingCode = group.booking_code;
  if (bookingCode){
    var byCode = convs.find(function(c){ return c.booking_code === bookingCode; });
    if (byCode) return byCode;
  }
  var phone = scheduleResolveGuestPhone(group);
  if (phone){
    var norm = scheduleNormalizePhoneDigits(phone);
    var byPhone = convs.find(function(c){
      return c.phone && scheduleNormalizePhoneDigits(c.phone) === norm;
    });
    if (byPhone) return byPhone;
  }
  return null;
};
${wireSrc}
this.scheduleWireDrawerConversation = scheduleWireDrawerConversation;
this.scheduleResolveGuestPhone = scheduleResolveGuestPhone;
`, sandbox);

  sandbox.scheduleWireDrawerConversation(row, group, ctx);
  return {
    disabled: dom['ps-drawer-conversation-btn'].disabled,
    title: dom['ps-drawer-conversation-btn'].title,
    hint: dom['ps-drawer-conversation-hint'].textContent,
    hintDisplay: dom['ps-drawer-conversation-hint'].style.display,
  };
}

const listPhone = '+34600111222';

let r = runWire(
  { booking_id: 'b1', phone: listPhone, guest_name: 'Ada' },
  { booking_id: 'b1', phone: listPhone, guest_name: 'Ada' },
  { booking_id: 'b1', guest_name: 'Ada', phone: null },
);
assert.strictEqual(r.disabled, false, 'list phone must enable conversation');
assert.strictEqual(r.hintDisplay, 'none', 'list phone must not show add-phone hint');
assert.ok(!r.hint, 'no need-phone copy when list has phone');

r = runWire(
  { booking_id: 'b1', guest_name: 'Ada' },
  { booking_id: 'b1', guest_name: 'Ada' },
  { booking_id: 'b1', guest_name: 'Ada', phone: listPhone },
);
assert.strictEqual(r.disabled, false, 'ctx phone must enable conversation');
assert.strictEqual(r.hintDisplay, 'none', 'ctx phone must not show add-phone hint');

r = runWire(
  { booking_id: 'b1', guest_name: 'Ada', guest_phone: listPhone },
  { booking_id: 'b1', guest_name: 'Ada' },
  { booking_id: 'b1', guest_name: 'Ada', phone: null },
);
assert.strictEqual(r.disabled, false, 'guest_phone on row counts');
assert.strictEqual(r.hintDisplay, 'none');

r = runWire(
  { booking_id: 'b1', guest_name: 'Ada', phone: 'staff:booking:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
  { booking_id: 'b1', guest_name: 'Ada', phone: 'staff:booking:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
  { booking_id: 'b1', guest_name: 'Ada', phone: 'staff:booking:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
);
assert.strictEqual(r.disabled, true, 'staff: synthetic is not a guest phone');
assert.strictEqual(r.hintDisplay, 'block', 'staff: synthetic shows need-phone empty state');
assert.ok(r.hint.includes('Add phone') || r.hint.includes('conversationNeedPhone'));

r = runWire(
  { booking_id: 'b1', guest_name: 'Ada' },
  { booking_id: 'b1', guest_name: 'Ada' },
  { booking_id: 'b1', guest_name: 'Ada', phone: null },
);
assert.strictEqual(r.disabled, true, 'truly missing phone asks to add');
assert.strictEqual(r.hintDisplay, 'block');

r = runWire(
  { booking_id: 'b1', guest_name: 'Ada' },
  { booking_id: 'b1', guest_name: 'Ada' },
  { booking_id: 'b1', guest_name: 'Ada', phone: null },
  listPhone,
);
assert.strictEqual(r.disabled, false, 'edit input phone counts');
assert.strictEqual(r.hintDisplay, 'none');

const viewDetails = extractFunctionSource(drawerView, 'scheduleRenderDrawerViewBookingDetailsHtml');
assert.ok(viewDetails, 'view details extractable');
const viewSandbox = {
  console,
  portalT,
  escHtml: (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  isSunsetSurfActive: () => true,
  scheduleResolveGuestPhone: (ctx, row) => {
    const p = (ctx && ctx.phone) || (row && (row.phone || row.guest_phone)) || '';
    if (String(p).indexOf('staff:') === 0) return '';
    return String(p || '').trim();
  },
  scheduleRenderDrawerViewDateRow: () => '',
  scheduleRenderDrawerBookedItemsRow: () => '',
  scheduleRowSourceDrawerLabel: () => 'Staff',
};
vm.createContext(viewSandbox);
vm.runInContext(`${viewDetails}\nthis.fn = scheduleRenderDrawerViewBookingDetailsHtml;`, viewSandbox);

const htmlListPhone = viewSandbox.fn(
  { guest_name: 'Ada', phone: null },
  { phone: listPhone, guest_name: 'Ada' },
);
assert.ok(htmlListPhone.includes(listPhone), 'view shows list phone when ctx phone empty');
assert.ok(!htmlListPhone.includes('Add phone'), 'view body must not bake in need-phone copy');

const htmlStaffSynth = viewSandbox.fn(
  { guest_name: 'Ada', phone: 'staff:booking:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
  { guest_name: 'Ada' },
);
assert.ok(htmlStaffSynth.includes('—'), 'staff: synthetic displays as empty dash');
assert.ok(!htmlStaffSynth.includes('staff:booking:'), 'staff: synthetic must not appear as phone');

console.log('PASS BUG-014 drawer phone empty-state (list/ctx only; no invent; staff: ignored)');
