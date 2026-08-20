'use strict';

/**
 * EMAIL-SMTP-002 UI — IMAP/SMTP is no longer Coming soon only.
 * Missing-secret cards name the exact KV secret, never a value.
 * Gmail/Microsoft remain independent. No password fields. No Inbox.
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
const PLANTED = 'super-secret-smtp-password-LEAK-001';

assert.ok(uiSrc.includes('/staff/admin/email-settings/smtp/endpoint'));
assert.ok(uiSrc.includes('postSmtpIdentityRegister') || uiSrc.includes('smtp/endpoint'));
assert.ok(uiSrc.includes('https://sunset-staging.lunafrontdesk.com/staff/email/google/callback'));
assert.ok(!uiSrc.includes('inbox-thread'));
assert.doesNotMatch(uiSrc, /type="password"/);
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

function boot() {
  const body = makeBody();
  const sandbox = {
    URL,
    window: { location: { assign() {} } },
    document: { getElementById(id) { return id === 'admin-email-settings-body' ? body : null; } },
    el(id) { return id === 'admin-email-settings-body' ? body : null; },
    escHtml(s) { return String(s == null ? '' : s); },
    portalT(key) { return key; },
    portalLang: 'en',
    fetch() { return Promise.resolve({ ok: false, json: async () => ({}) }); },
    console,
  };
  vm.runInNewContext(uiSrc, sandbox);
  return { body, sandbox };
}

{
  const { body, sandbox } = boot();
  sandbox.renderAdminEmailSettingsData({
    actions: { prepare: false, connect: false, disconnect: true, reauthorize: false },
    provider_actions: {
      microsoft_graph: { prepare: false, connect: false, disconnect: true, reauthorize: false },
      gmail_api: { prepare: false, connect: false, disconnect: false, reauthorize: false },
      imap_smtp: { prepare: true, connect: false, disconnect: false, reauthorize: false },
    },
    smtp_secret_status: { configured: true, missing_secret_names: [] },
    locations: [{ location_id: LOCATION, active: true }],
    endpoints: [{
      provider: 'microsoft_graph',
      location_id: LOCATION,
      endpoint_id: MS_ID,
      public_address: 'desk@sunset.example',
      connection_state: 'connected_health',
      inbound_enabled: false,
      outbound_enabled: false,
    }],
  });
  const html = body.innerHTML;
  const imap = cardHtml(html, 'imap_smtp');
  assert.match(imap, /IMAP \/ SMTP/);
  assert.match(imap, /data-email-connect="prepare"/);
  assert.match(imap, /data-email-prepare-address/);
  assert.match(imap, /inbound, outbound and automation remain off/);
  assert.doesNotMatch(imap, /Coming soon/);
  assert.doesNotMatch(imap, /type="password"/);
  assert.doesNotMatch(imap, /data-email-disconnect/);
  assert.doesNotMatch(imap, /data-email-reauthorize/);
  assert.match(cardHtml(html, 'gmail_api'), /Coming soon/);
  assert.match(cardHtml(html, 'microsoft_graph'), /Connected/);
  assert.doesNotMatch(html, new RegExp(PLANTED));
}

{
  const { body, sandbox } = boot();
  sandbox.renderAdminEmailSettingsData({
    actions: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    provider_actions: {
      microsoft_graph: { prepare: false, connect: false, disconnect: false, reauthorize: false },
      gmail_api: { prepare: false, connect: false, disconnect: false, reauthorize: false },
      imap_smtp: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    },
    smtp_secret_status: {
      configured: false,
      missing_secret_names: ['sunset-smtp-password'],
    },
    locations: [{ location_id: LOCATION, active: true }],
    endpoints: [],
  });
  const html = body.innerHTML;
  const imap = cardHtml(html, 'imap_smtp');
  assert.match(imap, /sunset-smtp-password/);
  assert.doesNotMatch(imap, /Coming soon/);
  assert.doesNotMatch(imap, /type="password"/);
  assert.doesNotMatch(imap, /data-email-connect=/);
  assert.doesNotMatch(html, new RegExp(PLANTED));
  assert.doesNotMatch(html, /kv:sunset-smtp-password/);
}

{
  const { body, sandbox } = boot();
  sandbox.renderAdminEmailSettingsData({
    actions: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    provider_actions: {
      microsoft_graph: { prepare: false, connect: false, disconnect: false, reauthorize: false },
      gmail_api: { prepare: false, connect: false, disconnect: false, reauthorize: false },
      imap_smtp: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    },
    locations: [{ location_id: LOCATION, active: true }],
    endpoints: [{
      provider: 'imap_smtp',
      location_id: LOCATION,
      endpoint_id: SMTP_ID,
      public_address: 'desk@sunset.example',
      connection_state: 'registered_not_connected',
      inbound_enabled: false,
      outbound_enabled: false,
      endpoint_active: false,
      automation_enabled: false,
    }],
  });
  const html = body.innerHTML;
  const imap = cardHtml(html, 'imap_smtp');
  assert.doesNotMatch(imap, /Coming soon/);
  assert.match(imap, /admin\.email\.off|Off/);
  assert.match(imap, /desk@sunset\.example/);
  assert.match(imap, /Not connected|registered_not_connected/);
  assert.doesNotMatch(imap, /data-email-connect=/);
  assert.doesNotMatch(imap, /data-email-prepare-address/);
  assert.doesNotMatch(imap, /type="password"/);
  assert.doesNotMatch(html, new RegExp(SMTP_ID));
}

{
  const { body, sandbox } = boot();
  sandbox.portalLang = 'es';
  sandbox.renderAdminEmailSettingsData({
    actions: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    provider_actions: {
      microsoft_graph: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    },
    smtp_secret_status: {
      configured: false,
      missing_secret_names: ['sunset-smtp-host'],
    },
    locations: [{ location_id: LOCATION, active: true }],
    endpoints: [],
  });
  const html = body.innerHTML;
  assert.match(cardHtml(html, 'imap_smtp'), /sunset-smtp-host/);
  assert.doesNotMatch(html, /admin\.email\.(comingSoon|notConnected)/);
}

{
  const { body, sandbox } = boot();
  sandbox.renderAdminEmailSettingsData({
    actions: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    provider_actions: {
      microsoft_graph: { prepare: false, connect: false, disconnect: false, reauthorize: false },
      gmail_api: { prepare: false, connect: false, disconnect: false, reauthorize: false },
      imap_smtp: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    },
    smtp_secret_status: {
      configured: false,
      missing_secret_names: ['sunset-smtp-password', PLANTED, 'kv:sunset-smtp-host', 'other-secret'],
    },
    locations: [{ location_id: LOCATION, active: true }],
    endpoints: [],
  });
  const html = body.innerHTML;
  const imap = cardHtml(html, 'imap_smtp');
  assert.match(imap, /sunset-smtp-password/);
  assert.doesNotMatch(html, new RegExp(PLANTED));
  assert.doesNotMatch(html, /kv:sunset-smtp-host/);
  assert.doesNotMatch(html, /other-secret/);
}

{
  const { body, sandbox } = boot();
  sandbox.renderAdminEmailSettingsData({
    actions: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    provider_actions: {
      microsoft_graph: { prepare: false, connect: false, disconnect: false, reauthorize: false },
      gmail_api: { prepare: false, connect: false, disconnect: false, reauthorize: false },
      imap_smtp: { prepare: true, connect: false, disconnect: false, reauthorize: false },
    },
    smtp_secret_status: { configured: true, missing_secret_names: [] },
    locations: [{ location_id: LOCATION, active: true }],
    endpoints: [],
  });
  sandbox.renderAdminEmailConnectFailed('imap_smtp');
  const html = body.innerHTML;
  const imap = cardHtml(html, 'imap_smtp');
  assert.match(imap, /Couldn’t register IMAP \/ SMTP|Couldn't register IMAP \/ SMTP/);
  assert.doesNotMatch(html, /Couldn’t connect Microsoft|Couldn't connect Microsoft/);
  assert.doesNotMatch(cardHtml(html, 'gmail_api'), /IMAP \/ SMTP/);
}

console.log('PASS EMAIL-SMTP-002 UI missing-secret and live IMAP card');
