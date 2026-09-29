'use strict';

/**
 * LAB-DURABLE-PHONE-DISPLAY-001
 *
 * Staff chrome must show the durable lab phone (+999…) and must not rewrite it
 * to a real-looking source number (+34…). Guest drawer, profile, and schedule
 * agree on that string. A later opaque field must not blank or replace it.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const {
  staffChromeDurablePhone,
} = require('./lib/staff-durable-phone-display');
const { projectInboxPersonRow } = require('./lib/staff-inbox-view-routes');
const {
  getConversationInboxQuery,
  getConversationDetailQuery,
} = require('./lib/staff-conversation-queries');
const { resolveDrawerGuestPhoneFromBundle } = require('./lib/sunset-schedule-booking-drawer');

const ROOT = path.join(__dirname, '..');
const DURABLE = '+9995550001';
const SOURCE = '+34612345678';
const ORDINARY = '+34699887766';

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name);
  if (start < 0) return '';
  let brace = 0;
  let started = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') {
      brace += 1;
      started = true;
    } else if (ch === '}') {
      brace -= 1;
      if (started && brace === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

function loadBrowserHelper() {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-columns.js'), 'utf8');
  const names = [
    'staffChromeHonestPhone',
    'staffChromeIsDurableLabPhone',
    'staffChromeCollectPhones',
    'staffChromeDurablePhone',
  ];
  const body = names.map((n) => extractFunction(src, n)).join('\n');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(body + '\nthis.staffChromeDurablePhone = staffChromeDurablePhone;', ctx);
  return ctx.staffChromeDurablePhone;
}

function loadScheduleResolver() {
  const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const names = [
    'scheduleNormalizeGuestPhone',
    'scheduleIsDurableLabPhone',
    'scheduleResolveGuestPhone',
  ];
  const body = names.map((n) => extractFunction(api, n)).join('\n');
  const ctx = { el: function () { return null; } };
  vm.createContext(ctx);
  vm.runInContext(body + '\nthis.scheduleResolveGuestPhone = scheduleResolveGuestPhone;', ctx);
  return ctx.scheduleResolveGuestPhone;
}

function main() {
  const browserPhone = loadBrowserHelper();
  const schedulePhone = loadScheduleResolver();

  const masked = {
    phone: SOURCE,
    display_phone: SOURCE,
    simulator_source_phone: SOURCE,
    durable_phone: DURABLE,
  };
  assert.equal(staffChromeDurablePhone(masked), DURABLE, 'server helper prefers durable over source');
  assert.equal(browserPhone(masked), DURABLE, 'browser helper prefers durable over source');
  assert.equal(staffChromeDurablePhone(masked), browserPhone(masked), 'server and browser chrome agree');

  assert.equal(staffChromeDurablePhone({ phone: ORDINARY }), ORDINARY, 'ordinary guest stays ordinary');
  assert.equal(browserPhone({ phone: ORDINARY }), ORDINARY);
  assert.equal(staffChromeDurablePhone({ phone: '' }, { guest_phone: ORDINARY }), ORDINARY, 'does not blank a known phone');
  assert.equal(staffChromeDurablePhone('staff:booking:abc', { phone: DURABLE }), DURABLE, 'staff synthetic is not a guest phone');
  assert.equal(staffChromeDurablePhone({ display_phone: SOURCE, simulator_source_phone: SOURCE }), '', 'mask fields alone are not a phone');

  const projected = projectInboxPersonRow(
    { source: 'conversations', id: 'owner_lab' },
    { conversation_id: 'conv-sim', phone: DURABLE, display_phone: SOURCE, last_activity: new Date(0) },
  );
  assert.equal(projected.phone, DURABLE, 'inbox list phone is durable');
  assert.equal(projected.durable_phone, DURABLE);
  assert.notEqual(projected.phone, SOURCE);

  const inboxSql = getConversationInboxQuery();
  const detailSql = getConversationDetailQuery();
  assert.equal(inboxSql.includes('simulator_source_phone'), false, 'list SQL does not select source phone');
  assert.equal(detailSql.includes('simulator_source_phone'), false, 'detail SQL does not select source phone');
  assert.equal(/conv\.phone\s+AS phone/.test(detailSql), true, 'detail phone column is conv.phone');

  const drawer = resolveDrawerGuestPhoneFromBundle({
    booking: {
      phone: SOURCE,
      metadata: { guest_phone: SOURCE, durable_phone: DURABLE },
    },
    services: [{ metadata: { guest_phone: SOURCE } }],
  });
  assert.equal(drawer, DURABLE, 'guest drawer shows durable phone');

  const ordinaryDrawer = resolveDrawerGuestPhoneFromBundle({
    booking: { phone: ORDINARY, metadata: {} },
    services: [],
  });
  assert.equal(ordinaryDrawer, ORDINARY, 'ordinary drawer phone unchanged');

  const scheduleShown = schedulePhone(
    { phone: SOURCE, guest_phone: SOURCE },
    { durable_phone: DURABLE, phone: SOURCE },
  );
  assert.equal(scheduleShown, DURABLE, 'schedule chrome shows the same durable phone');
  assert.equal(schedulePhone({ phone: ORDINARY }), ORDINARY, 'schedule ordinary phone unchanged');
  assert.equal(schedulePhone({ phone: DURABLE }, { phone: SOURCE }), DURABLE, 'later opaque field does not replace durable');
  assert.equal(schedulePhone({ phone: ORDINARY }), staffChromeDurablePhone({ phone: ORDINARY }));

  const thread = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
  const profile = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-customers-profile.js'), 'utf8');
  const context = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-context.js'), 'utf8');
  assert.equal(thread.includes('inboxChromePhone(c)'), true, 'inbox header uses durable chrome phone');
  assert.equal(profile.includes('phoneShown'), true, 'profile renders the chrome phone');
  assert.equal(context.includes('staffChromeDurablePhone'), true, 'guest card contact uses durable chrome phone');

  console.log('PASS verify-durable-phone-display-001');
}

main();
