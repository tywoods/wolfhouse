'use strict';

/**
 * EMAIL-SMTP-UI-003 — IMAP/SMTP registered-not-connected card paints like
 * Microsoft/Gmail registered cards: address + Not connected / state copy + Offs.
 * No password. No connect/send. Gmail/Microsoft cards unchanged. No secret leaks.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');

const LOCATION = 'sunset-somo';
const SMTP_ID = '44444444-4444-4444-8444-444444444444';
const MS_ID = '22222222-2222-4222-8222-222222222222';
const GMAIL_ID = '33333333-3333-4333-8333-333333333333';
const MAILBOX = 'tywoods@gmail.com';
const PLANTED = 'super-secret-smtp-password-LEAK-003';

assert.ok(uiSrc.includes('data-email-registered-as') || uiSrc.includes('adminEmailImapCardHtml'));
assert.doesNotMatch(uiSrc, /type="password"/);
assert.ok(!uiSrc.includes('inbox-thread'));
assert.ok(!uiSrc.includes(PLANTED));

function cardHtml(html, provider) {
  const start = html.indexOf('data-email-provider="' + provider + '"');
  assert.ok(start >= 0, 'missing card ' + provider);
  const from = html.lastIndexOf('<section', start);
  const next = html.indexOf('<section', from + 8);
  return html.slice(from, next === -1 ? html.length : next);
}

function makeBody() {
  const children = [];
  const el = {
    id: 'admin-email-settings-body',
    _html: '',
    children,
    querySelector(sel) {
      if (sel === '.portal-admin-email-settings') return children[0] || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.portal-admin-email-settings') return children.slice();
      return [];
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) {
      el._html = String(v);
      children.length = 0;
      const providers = [...String(v).matchAll(/data-email-provider="([^"]+)"/g)].map((m) => m[1]);
      providers.forEach((p) => {
        children.push({
          className: 'portal-admin-email-settings portal-admin-email-card',
          getAttribute(name) { return name === 'data-email-provider' ? p : null; },
          querySelector() { return null; },
        });
      });
    },
  });
  return el;
}

function boot(i18n) {
  const body = makeBody();
  const keys = i18n || {
    'admin.email.state.registered_not_connected': 'Mailbox registered, not connected.',
    'admin.email.state.connected_health': 'Mailbox connected. Email processing remains off.',
    'admin.email.endpointActive': 'Mailbox connection',
    'admin.email.inbound': 'Inbound',
    'admin.email.outbound': 'Outbound',
    'admin.email.staffReplies': 'Staff replies',
    'admin.email.on': 'On',
    'admin.email.automation': 'Automation',
    'admin.email.off': 'Off',
  };
  const sandbox = {
    URL,
    window: { location: { assign() {} } },
    document: { getElementById(id) { return id === 'admin-email-settings-body' ? body : null; } },
    el(id) { return id === 'admin-email-settings-body' ? body : null; },
    escHtml(s) { return String(s == null ? '' : s); },
    portalT(key) { return Object.prototype.hasOwnProperty.call(keys, key) ? keys[key] : key; },
    portalLang: 'en',
    fetch() { return Promise.resolve({ ok: false, json: async () => ({}) }); },
    console,
  };
  vm.runInNewContext(uiSrc, sandbox);
  return { body, sandbox };
}

function baseActions(imapPrepare) {
  return {
    actions: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    provider_actions: {
      microsoft_graph: { prepare: false, connect: false, disconnect: false, reauthorize: false },
      gmail_api: { prepare: false, connect: false, disconnect: false, reauthorize: false },
      imap_smtp: { prepare: !!imapPrepare, connect: false, disconnect: false, reauthorize: false },
    },
    smtp_secret_status: { configured: true, missing_secret_names: [] },
    locations: [{ location_id: LOCATION, active: true }],
  };
}

// (1) no endpoint → Register form
{
  const { body, sandbox } = boot();
  sandbox.renderAdminEmailSettingsData({
    ...baseActions(true),
    endpoints: [],
  });
  const html = body.innerHTML;
  const imap = cardHtml(html, 'imap_smtp');
  assert.match(imap, /Register mailbox/);
  assert.match(imap, /data-email-connect="prepare"/);
  assert.match(imap, /data-email-prepare-address/);
  assert.doesNotMatch(imap, /type="password"/);
  assert.doesNotMatch(imap, /Coming soon/);
  assert.doesNotMatch(imap, /data-email-registered-as/);
  assert.match(cardHtml(html, 'gmail_api'), /Coming soon/);
  assert.doesNotMatch(html, new RegExp(PLANTED));
}

// (2) imap_smtp registered_not_connected → address visible, no form, no password, Offs
{
  const { body, sandbox } = boot();
  sandbox.renderAdminEmailSettingsData({
    ...baseActions(false),
    endpoints: [{
      provider: 'imap_smtp',
      location_id: LOCATION,
      endpoint_id: SMTP_ID,
      public_address: MAILBOX,
      connection_state: 'registered_not_connected',
      inbound_enabled: false,
      outbound_enabled: false,
      endpoint_active: false,
      automation_enabled: false,
      secret_ref: 'kv:sunset-smtp-password',
    }],
  });
  const html = body.innerHTML;
  const imap = cardHtml(html, 'imap_smtp');
  assert.match(imap, /data-email-state="registered_not_connected"/);
  assert.match(imap, /Not connected/);
  assert.match(imap, /Mailbox registered, not connected/);
  assert.match(imap, /data-email-registered-as/);
  assert.match(imap, /data-email-disconnect/);
  assert.match(imap, /Disconnect IMAP/);
  assert.match(imap, new RegExp(MAILBOX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(imap, /Mailbox connection/);
  assert.match(imap, /Inbound/);
  assert.match(imap, /Staff replies/);
  assert.match(imap, /Automation/);
  assert.match(imap, /Off/);
  assert.doesNotMatch(imap, /data-email-prepare-address/);
  assert.doesNotMatch(imap, /data-email-connect=/);
  assert.doesNotMatch(imap, /Register mailbox/);
  assert.doesNotMatch(imap, /type="password"/);
  assert.doesNotMatch(imap, /Coming soon/);
  assert.doesNotMatch(html.replace(/data-email-endpoint-id="[^"]+"/g, ''), new RegExp(SMTP_ID));
  assert.doesNotMatch(html, /kv:sunset-smtp-password/);
  assert.doesNotMatch(html, new RegExp(PLANTED));
}

// connected_health later → Connected (+ address), still no connect/send, Offs
{
  const { body, sandbox } = boot();
  sandbox.renderAdminEmailSettingsData({
    ...baseActions(false),
    endpoints: [{
      provider: 'imap_smtp',
      location_id: LOCATION,
      endpoint_id: SMTP_ID,
      public_address: MAILBOX,
      connection_state: 'connected_health',
      inbound_enabled: false,
      outbound_enabled: false,
    }],
  });
  const html = body.innerHTML;
  const imap = cardHtml(html, 'imap_smtp');
  assert.match(imap, /data-email-state="connected_health"/);
  assert.match(imap, /Connected/);
  assert.match(imap, /data-email-connected-as/);
  assert.match(imap, /data-email-disconnect/);
  assert.match(imap, /Disconnect IMAP/);
  assert.match(imap, new RegExp(MAILBOX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(imap, /Off/);
  assert.doesNotMatch(imap, /data-email-connect=/);
  assert.doesNotMatch(imap, /type="password"/);
  assert.doesNotMatch(html.replace(/data-email-endpoint-id="[^"]+"/g, ''), new RegExp(SMTP_ID));
}

// (3) Gmail/Microsoft cards unchanged when IMAP is registered
{
  const { body, sandbox } = boot();
  sandbox.renderAdminEmailSettingsData({
    ...baseActions(false),
    provider_actions: {
      microsoft_graph: { prepare: false, connect: false, disconnect: true, reauthorize: false },
      gmail_api: { prepare: false, connect: false, disconnect: false, reauthorize: false },
      imap_smtp: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    },
    actions: { prepare: false, connect: false, disconnect: true, reauthorize: false },
    endpoints: [
      {
        provider: 'microsoft_graph',
        location_id: LOCATION,
        endpoint_id: MS_ID,
        public_address: 'desk@sunset.example',
        connection_state: 'connected_health',
        inbound_enabled: false,
        outbound_enabled: false,
      },
      {
        provider: 'imap_smtp',
        location_id: LOCATION,
        endpoint_id: SMTP_ID,
        public_address: MAILBOX,
        connection_state: 'registered_not_connected',
      },
    ],
  });
  const html = body.innerHTML;
  const ms = cardHtml(html, 'microsoft_graph');
  const gmail = cardHtml(html, 'gmail_api');
  const imap = cardHtml(html, 'imap_smtp');
  assert.match(ms, /Connected/);
  assert.match(ms, /desk@sunset\.example/);
  assert.match(ms, /data-email-disconnect/);
  assert.match(gmail, /Coming soon/);
  assert.doesNotMatch(gmail, /Connect Google/);
  assert.match(imap, new RegExp(MAILBOX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(imap, /Not connected/);
  assert.doesNotMatch(imap, /data-email-connect=/);
  // Microsoft may carry endpoint_id on disconnect controls; IMAP must never paint ids/refs as copy.
  const copyOnly = html.replace(/data-email-endpoint-id="[^"]+"/g, '');
  assert.doesNotMatch(copyOnly, new RegExp(SMTP_ID));
  assert.doesNotMatch(copyOnly, new RegExp(MS_ID));
  assert.doesNotMatch(html, new RegExp(GMAIL_ID));
}

// (4) no secret values / kv: refs / endpoint ids leaked (source + painted HTML)
{
  assert.doesNotMatch(uiSrc, /type="password"/);
  assert.ok(!uiSrc.includes(PLANTED));
  const { body, sandbox } = boot();
  sandbox.renderAdminEmailSettingsData({
    ...baseActions(false),
    smtp_secret_status: {
      configured: false,
      missing_secret_names: ['sunset-smtp-password', PLANTED, 'kv:sunset-smtp-host'],
    },
    endpoints: [{
      provider: 'imap_smtp',
      location_id: LOCATION,
      endpoint_id: SMTP_ID,
      public_address: MAILBOX,
      connection_state: 'registered_not_connected',
      secret_ref: 'kv:sunset-smtp-password',
    }],
  });
  const html = body.innerHTML;
  assert.match(cardHtml(html, 'imap_smtp'), new RegExp(MAILBOX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(html, new RegExp(PLANTED));
  assert.doesNotMatch(html, /kv:sunset-smtp/);
  assert.doesNotMatch(html.replace(/data-email-endpoint-id="[^"]+"/g, ''), new RegExp(SMTP_ID));
}

console.log('PASS EMAIL-SMTP-UI-003 IMAP registered card paint');
