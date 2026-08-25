#!/usr/bin/env node
'use strict';

/**
 * EMAIL-SEND-COMPLETION vertical 5.
 *
 * Admin Email paints authoritative capability DTO values (connected identity,
 * endpoint active, inbound, explicit staff replies, automation) while preserving
 * Deckhand Active Inbox pebble + IMAP/SMTP disconnect card/grid.
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const UI = path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js');
const {
  endpointDto,
  createEmailSettingsRoutes,
} = require('./lib/staff-email-settings-routes');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const uiSrc = fs.readFileSync(UI, 'utf8');

function makeBody() {
  const el = { id: 'admin-email-settings-body', _html: '', querySelector() { return null; }, querySelectorAll() { return []; } };
  Object.defineProperty(el, 'innerHTML', { get() { return el._html; }, set(v) { el._html = String(v); } });
  return el;
}
function boot() {
  const body = makeBody();
  const sandbox = {
    URL,
    window: { location: { assign() {} } },
    document: { getElementById(id) { return id === 'admin-email-settings-body' ? body : null; } },
    el(id) { return id === 'admin-email-settings-body' ? body : null; },
    escHtml(s) { return String(s == null ? '' : s); },
    portalT(key) {
      const pack = {
        'admin.email.endpointActive': 'Mailbox connection',
        'admin.email.inbound': 'Inbound',
        'admin.email.outbound': 'Outbound',
        'admin.email.staffReplies': 'Staff replies',
        'admin.email.automation': 'Automation',
        'admin.email.off': 'Off',
        'admin.email.on': 'On',
        'admin.email.state.connected_health': 'Mailbox connected. Email processing remains off.',
      };
      return pack[key] || key;
    },
    portalLang: 'en',
    fetch() { return Promise.resolve({ ok: false, json: async () => ({}) }); },
    console,
  };
  vm.runInNewContext(uiSrc, sandbox);
  return { body, sandbox };
}
function cardHtml(html, provider) {
  const re = new RegExp(
    '<section class="portal-admin-email-settings portal-admin-email-card[^"]*" data-email-provider="'
    + provider + '"[\\s\\S]*?</section>',
  );
  const m = html.match(re);
  return m ? m[0] : '';
}

function msRow(extra) {
  return Object.assign({
    id: '11111111-1111-4111-8111-111111111111',
    location_id: 'sunset-somo',
    provider: 'microsoft_graph',
    public_address: 'support@sunset.example',
    binding_status: 'verified',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
    active: false,
    inbound_enabled: false,
    outbound_enabled: false,
    default_automation_mode: 'off',
  }, extra || {});
}

function grantActive() {
  return { grant_present: true, grant_status: 'active', reconcile_state: 'clean' };
}

async function main() {
  console.log('verify:admin-email-capability-dto\n');

  ok('Deckhand pebble/disconnect selectors preserved',
    uiSrc.includes('data-email-active-inbox')
    && uiSrc.includes('Active Inbox')
    && uiSrc.includes('data-email-not-inbox')
    && uiSrc.includes('SMTP_DISCONNECT_UI_PATH')
    && uiSrc.includes('Disconnect IMAP / SMTP')
    && uiSrc.includes('Disconnect Microsoft'));

  const off = endpointDto(msRow(), grantActive());
  ok('connected-off: identity present, capabilities false',
    off.public_address === 'support@sunset.example'
    && off.endpoint_active === false
    && off.inbound_enabled === false
    && off.staff_replies_enabled === false
    && off.automation_enabled === false);

  const inbound = endpointDto(msRow({ active: true, inbound_enabled: true }), grantActive());
  ok('inbound-only: endpoint+inbound true, staff replies/automation false',
    inbound.endpoint_active === true
    && inbound.inbound_enabled === true
    && inbound.staff_replies_enabled === false
    && inbound.automation_enabled === false);

  const reply = endpointDto(msRow({
    active: true, inbound_enabled: true, outbound_enabled: true,
  }), grantActive());
  ok('inbound+reply: staff replies true, automation still false',
    reply.endpoint_active === true
    && reply.inbound_enabled === true
    && reply.staff_replies_enabled === true
    && reply.automation_enabled === false);

  const auto = endpointDto(msRow({
    active: true, inbound_enabled: true, outbound_enabled: true,
    default_automation_mode: 'automatic',
  }), grantActive());
  ok('automation true only for exact automatic mode',
    auto.automation_enabled === true);

  const getter = msRow();
  Object.defineProperty(getter, 'inbound_enabled', { get() { return true; }, enumerable: true });
  const hostile = endpointDto(getter, grantActive());
  ok('malformed getter fail-closed inbound',
    hostile.inbound_enabled === false && hostile.staff_replies_enabled === false);

  const inherited = Object.create({ inbound_enabled: true, outbound_enabled: true, active: true, default_automation_mode: 'automatic' });
  inherited.id = msRow().id;
  inherited.location_id = 'sunset-somo';
  inherited.provider = 'microsoft_graph';
  inherited.public_address = 'support@sunset.example';
  inherited.binding_status = 'verified';
  inherited.auth_mode = 'delegated_authorization_code';
  inherited.connector_mode = 'microsoft_delegated_oauth';
  inherited.active = false;
  inherited.inbound_enabled = false;
  inherited.outbound_enabled = false;
  inherited.default_automation_mode = 'off';
  const inh = endpointDto(inherited, grantActive());
  ok('inherited true does not open capabilities',
    inh.inbound_enabled === false && inh.staff_replies_enabled === false && inh.automation_enabled === false);

  const { body, sandbox } = boot();
  sandbox.renderAdminEmailSettingsData({
    actions: { prepare: false, connect: false, disconnect: true, reauthorize: false },
    provider_actions: {
      microsoft_graph: { prepare: false, connect: false, disconnect: true, reauthorize: false },
      gmail_api: { prepare: false, connect: false, disconnect: false, reauthorize: false },
      imap_smtp: { prepare: false, connect: false, disconnect: true, reauthorize: false },
    },
    locations: [{ location_id: 'sunset-somo', active: true }],
    endpoints: [
      {
        provider: 'microsoft_graph',
        location_id: 'sunset-somo',
        endpoint_id: '11111111-1111-4111-8111-111111111111',
        public_address: 'support@sunset.example',
        connection_state: 'connected_health',
        last_sync: '2026-08-22T18:00:00.000Z',
        endpoint_active: true,
        inbound_enabled: true,
        staff_replies_enabled: true,
        automation_enabled: false,
      },
      {
        provider: 'imap_smtp',
        location_id: 'sunset-somo',
        endpoint_id: '22222222-2222-4222-8222-222222222222',
        public_address: 'ops@sunset.example',
        connection_state: 'connected_health',
        endpoint_active: false,
        inbound_enabled: false,
        staff_replies_enabled: false,
        automation_enabled: false,
      },
    ],
  });
  const html = body.innerHTML;
  const ms = cardHtml(html, 'microsoft_graph');
  const imap = cardHtml(html, 'imap_smtp');
  ok('pebble preserved on Microsoft Active Inbox',
    /data-email-active-inbox="1"/.test(ms) && /Active Inbox/.test(ms)
    && /support@sunset\.example/.test(ms)
    && /Disconnect Microsoft/.test(ms));
  ok('Microsoft paints DTO inbound on + staff replies on + automation off',
    /Mailbox connection/.test(ms) && /Inbound/.test(ms) && /Staff replies/.test(ms)
    && /data-email-cap="endpoint_active">On</.test(ms)
    && /data-email-cap="inbound">On</.test(ms)
    && /data-email-cap="staff_replies">On</.test(ms)
    && /data-email-cap="automation">Off</.test(ms));
  ok('IMAP connected-off capabilities + disconnect preserved',
    /data-email-not-inbox="1"/.test(imap)
    && /Not used for guest Inbox/.test(imap)
    && /Disconnect IMAP \/ SMTP/.test(imap)
    && /data-email-cap="endpoint_active">Off</.test(imap)
    && /data-email-cap="staff_replies">Off</.test(imap));
  ok('card/grid classes preserved',
    /portal-admin-email-card is-active-inbox/.test(ms)
    && /portal-admin-email-card/.test(imap));

  sandbox.renderAdminEmailSettingsData({
    actions: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    locations: [{ location_id: 'sunset-somo', active: true }],
    endpoints: [{
      provider: 'microsoft_graph',
      location_id: 'sunset-somo',
      endpoint_id: '11111111-1111-4111-8111-111111111111',
      public_address: 'support@sunset.example',
      connection_state: 'connected_health',
      inbound_enabled: 'yes',
      staff_replies_enabled: 1,
      endpoint_active: 'true',
      automation_enabled: 'automatic',
    }],
  });
  const bad = cardHtml(body.innerHTML, 'microsoft_graph');
  ok('malformed DTO capabilities fail-closed to Off',
    /data-email-cap="endpoint_active">Off</.test(bad)
    && /data-email-cap="inbound">Off</.test(bad)
    && /data-email-cap="staff_replies">Off</.test(bad)
    && /data-email-cap="automation">Off</.test(bad));

  sandbox.renderAdminEmailSettingsData(null);
  ok('unavailable payload fail-closed does not throw and keeps empty card host',
    typeof body.innerHTML === 'string');

  console.log(`\n── verify:admin-email-capability-dto ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
