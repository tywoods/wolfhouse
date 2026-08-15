'use strict';

/**
 * EMAIL-CONNECT-UI-001 — Admin Email connect chrome.
 * Microsoft stays live. Gmail and IMAP are honest coming-soon.
 * Stay off Inbox, Skipper OAuth/poller, language packs, production.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

assert.ok(uiSrc.includes('data-email-provider="gmail_api"') || uiSrc.includes("data-email-provider=\"' + escHtml(provider)"));
assert.ok(uiSrc.includes('imap_smtp'));
assert.ok(uiSrc.includes('Coming soon'));
assert.ok(uiSrc.includes('Próximamente'));
assert.ok(uiSrc.includes('No password is stored here'));
assert.ok(uiSrc.includes('postMicrosoftOAuthStart'));
assert.ok(uiSrc.includes('postMicrosoftOAuthDisconnect'));
assert.ok(uiSrc.includes("data-email-disconnect"));
assert.ok(!uiSrc.includes('inbox-thread'));
assert.ok(!apiSrc.includes('type="password"') || !/portal-admin-email[\s\S]{0,400}type=\"password\"/.test(apiSrc));

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
sandbox.renderAdminEmailSettingsData({
  actions: { prepare: false, connect: false, disconnect: true, reauthorize: false },
  provider_actions: { microsoft_graph: { prepare: false, connect: false, disconnect: true, reauthorize: false } },
  locations: [{ location_id: 'sunset-somo', active: true }],
  endpoints: [{
    provider: 'microsoft_graph',
    location_id: 'sunset-somo',
    endpoint_id: '11111111-1111-4111-8111-111111111111',
    public_address: 'desk@sunset.example',
    connection_state: 'connected_health',
    inbound_enabled: false,
    outbound_enabled: false,
  }],
});

const html = body.innerHTML;
assert.ok(/data-email-provider="microsoft_graph"/.test(html), 'Microsoft card');
assert.ok(/data-email-provider="gmail_api"/.test(html), 'Gmail card');
assert.ok(/data-email-provider="imap_smtp"/.test(html), 'IMAP card');
assert.ok(/Microsoft 365/.test(html), 'Microsoft product name');
assert.ok(/Gmail/.test(html), 'Gmail title');
assert.ok(/IMAP \/ SMTP/.test(html), 'IMAP title');
assert.ok(/Coming soon/.test(html), 'coming chrome');
assert.ok(/desk@sunset.example/.test(html), 'honest Microsoft address');
assert.ok(!/11111111-1111-4111-8111-111111111111/.test(html.replace(/data-email-endpoint-id="[^"]+"/, '')), 'no raw ids as copy');
assert.ok(!/Connect Google/.test(html), 'Gmail cannot fake connect');
assert.ok(!/type="password"/.test(html), 'IMAP collects no password');
assert.ok(/data-email-disconnect/.test(html), 'Microsoft disconnect stays');
assert.ok(/Connected/.test(html), 'Microsoft connected pill');
assert.ok(!/Temporarily unavailable/.test(html), 'no false unavailable');

sandbox.portalLang = 'es';
sandbox.renderAdminEmailSettingsData({
  actions: { prepare: false, connect: false, disconnect: false, reauthorize: false },
  locations: [{ location_id: 'sunset-somo', active: true }],
  endpoints: [],
});
assert.ok(/Próximamente/.test(body.innerHTML), 'ES coming soon');
assert.ok(/No conectado/.test(body.innerHTML), 'ES not connected');
assert.ok(!/admin\.email\.(comingSoon|notConnected|lead)/.test(body.innerHTML), 'no leftover ES keys');

console.log('PASS EMAIL-CONNECT-UI-001 Microsoft/Gmail/IMAP honest cards');
