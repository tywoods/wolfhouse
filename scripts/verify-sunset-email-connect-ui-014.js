'use strict';

/**
 * EMAIL-CONNECT-UI-014 — make the live Inbox mailbox obvious.
 * Microsoft connected + last_sync → Active Inbox.
 * IMAP connected → Connected, not used for guest Inbox.
 * Gmail stays Coming soon. No OAuth / Disconnect / send.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');

assert.ok(uiSrc.includes('adminEmailLooksLikeAddress'));
assert.ok(uiSrc.includes('Active Inbox'));
assert.ok(uiSrc.includes('Bandeja activa'));
assert.ok(uiSrc.includes('Not used for guest Inbox'));
assert.ok(uiSrc.includes('No se usa para la bandeja de huéspedes'));
assert.ok(uiSrc.includes('data-email-active-inbox'));
assert.ok(uiSrc.includes('data-email-not-inbox'));
assert.ok(!uiSrc.includes('inbox-thread'));
assert.ok(!/staff-email-oauth-routes/.test(uiSrc));

function makeBody() {
  const el = {
    id: 'admin-email-settings-body',
    _html: '',
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = String(v); },
  });
  return el;
}

function boot(lang) {
  const body = makeBody();
  const sandbox = {
    URL,
    window: { location: { assign() {} } },
    document: { getElementById(id) { return id === 'admin-email-settings-body' ? body : null; } },
    el(id) { return id === 'admin-email-settings-body' ? body : null; },
    escHtml(s) { return String(s == null ? '' : s); },
    portalT(key) {
      const pack = {
        'admin.email.state.connected_health': 'Mailbox connected. Email processing remains off.',
        'admin.email.endpointActive': 'Mailbox connection',
        'admin.email.inbound': 'Inbound',
        'admin.email.outbound': 'Outbound',
        'admin.email.staffReplies': 'Staff replies',
        'admin.email.on': 'On',
        'admin.email.automation': 'Automation',
        'admin.email.off': 'Off',
      };
      return pack[key] || key;
    },
    portalLang: lang || 'en',
    fetch() { return Promise.resolve({ ok: false, json: async () => ({}) }); },
    console,
  };
  vm.runInNewContext(uiSrc, sandbox);
  return { body, sandbox };
}

function cardHtml(html, provider) {
  const re = new RegExp(
    '<section class="portal-admin-email-settings portal-admin-email-card[^"]*" data-email-provider="'
    + provider + '"[\\s\\S]*?</section>'
  );
  const m = html.match(re);
  return m ? m[0] : '';
}

const payload = {
  actions: { prepare: false, connect: false, disconnect: true, reauthorize: false },
  provider_actions: {
    microsoft_graph: { prepare: false, connect: false, disconnect: true, reauthorize: false },
    gmail_api: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    imap_smtp: { prepare: false, connect: false, disconnect: false, reauthorize: false },
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
    },
    {
      provider: 'imap_smtp',
      location_id: 'sunset-somo',
      endpoint_id: '22222222-2222-4222-8222-222222222222',
      public_address: 'ops@sunset.example',
      connection_state: 'connected_health',
    },
  ],
};

{
  const { body, sandbox } = boot('en');
  sandbox.renderAdminEmailSettingsData(payload);
  const html = body.innerHTML;
  const ms = cardHtml(html, 'microsoft_graph');
  const imap = cardHtml(html, 'imap_smtp');
  const gmail = cardHtml(html, 'gmail_api');
  assert.match(ms, /data-email-active-inbox="1"/);
  assert.match(ms, /Active Inbox/);
  assert.match(ms, /This is the mailbox Luna uses for guest Inbox/);
  assert.match(ms, /Connected as/);
  assert.match(ms, /support@sunset\.example/);
  assert.match(ms, /Last sync/);
  assert.match(ms, /Mailbox connection/);
  assert.doesNotMatch(ms, /Email processing remains off/);
  assert.doesNotMatch(ms, /data-email-not-inbox/);
  assert.match(imap, /data-email-not-inbox="1"/);
  assert.match(imap, /Connected/);
  assert.match(imap, /Not used for guest Inbox/);
  assert.doesNotMatch(imap, /Active Inbox/);
  assert.doesNotMatch(imap, /data-email-active-inbox/);
  assert.match(gmail, /Coming soon/);
  assert.doesNotMatch(html.replace(/data-email-endpoint-id="[^"]+"/g, ''), /11111111-1111-4111-8111-111111111111/);
}

{
  const { body, sandbox } = boot('es');
  sandbox.renderAdminEmailSettingsData(payload);
  const html = body.innerHTML;
  const ms = cardHtml(html, 'microsoft_graph');
  const imap = cardHtml(html, 'imap_smtp');
  assert.match(ms, /Bandeja activa/);
  assert.match(ms, /Este es el buzón que Luna usa para la bandeja de huéspedes/);
  assert.match(imap, /No se usa para la bandeja de huéspedes/);
  assert.doesNotMatch(ms, /Email processing remains off/);
}

{
  const { body, sandbox } = boot('en');
  sandbox.renderAdminEmailSettingsData({
    actions: { prepare: false, connect: false, disconnect: true, reauthorize: false },
    locations: [{ location_id: 'sunset-somo', active: true }],
    endpoints: [{
      provider: 'microsoft_graph',
      location_id: 'sunset-somo',
      endpoint_id: '33333333-3333-4333-8333-333333333333',
      public_address: 'support@sunset.example',
      connection_state: 'connected_health',
    }],
  });
  const ms = cardHtml(body.innerHTML, 'microsoft_graph');
  assert.doesNotMatch(ms, /data-email-active-inbox/);
  assert.match(ms, /Connected/);
  assert.match(ms, /Mailbox connected. Email processing remains off/);
  assert.match(ms, /Mailbox connection/);
}

console.log('PASS EMAIL-CONNECT-UI-014 active Inbox mailbox vs IMAP not-in-use');
