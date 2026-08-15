'use strict';

/**
 * EMAIL-CONNECT-UI-006 — After disconnect / first-time never-connected,
 * Admin Email is a clear empty state. No leftover last-sync, connected-as,
 * or previous mailbox chrome. Microsoft Connect CTA is visible and ready
 * in EN/ES. Gmail stays coming-soon. Chrome only — no poller / Graph / live revoke.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const ROOT = path.join(__dirname, '..');
const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');
const adminUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
const en = STAFF_PORTAL_STRINGS.en;
const es = STAFF_PORTAL_STRINGS.es;

assert.strictEqual(en['admin.email.connectButton'], 'Connect Microsoft email');
assert.strictEqual(es['admin.email.connectButton'], 'Conectar email de Microsoft');
assert.ok(uiSrc.includes('function adminEmailIsEmptyState'));
assert.ok(uiSrc.includes('function adminEmailConnectButtonLabel'));
assert.ok(uiSrc.includes('data-email-empty'));
assert.ok(uiSrc.includes('data-i18n="admin.email.connectButton"'));
assert.ok(uiSrc.includes("connected ? adminEmailLooksLikeAddress"));
assert.ok(uiSrc.includes('function adminEmailRefreshOnLocaleChange'));
assert.ok(adminUi.includes('adminEmailRefreshOnLocaleChange()'));
assert.ok(!uiSrc.includes('inbox-thread'));
assert.ok(!/staff-email-oauth-routes/.test(uiSrc));
assert.ok(!/AADSTS|ErrorInvalidMailbox|MailboxNotEnabledForRESTAPI|GraphError/.test(uiSrc));

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

const body = makeBody();
let fetchCalls = 0;
const sandbox = {
  URL,
  Date,
  window: { location: { assign() {} } },
  document: { getElementById(id) { return id === 'admin-email-settings-body' ? body : null; } },
  el(id) { return id === 'admin-email-settings-body' ? body : null; },
  escHtml(s) { return String(s == null ? '' : s); },
  portalT(key) { return en[key] || key; },
  portalLang: 'en',
  fetch() {
    fetchCalls += 1;
    return Promise.resolve({ ok: false, json: async () => ({}) });
  },
  console,
};
vm.runInNewContext(uiSrc, sandbox);

function render(payload) {
  sandbox.renderAdminEmailSettingsData(payload);
  return body.innerHTML;
}

const leftoverAfterDisconnect = {
  actions: { prepare: true, connect: false, disconnect: false, reauthorize: false },
  provider_actions: {
    microsoft_graph: { prepare: true, connect: false, disconnect: false, reauthorize: false },
  },
  locations: [{ location_id: 'sunset-somo', active: true }],
  endpoints: [{
    provider: 'microsoft_graph',
    location_id: 'sunset-somo',
    endpoint_id: '11111111-1111-4111-8111-111111111111',
    public_address: 'support@lunafrontdesk.com',
    connection_state: 'disconnected',
    last_sync: new Date(Date.now() - (14 * 60 * 60 * 1000)).toISOString(),
  }],
};

const neverConnected = {
  actions: { prepare: true, connect: false, disconnect: false, reauthorize: false },
  provider_actions: {
    microsoft_graph: { prepare: true, connect: false, disconnect: false, reauthorize: false },
  },
  locations: [{ location_id: 'sunset-somo', active: true }],
  endpoints: [],
};

sandbox.portalLang = 'en';
sandbox.portalT = (key) => en[key] || key;
let html = render(leftoverAfterDisconnect);
assert.match(html, /data-email-empty="1"/);
assert.match(html, /Not connected/);
assert.match(html, /No email mailbox is registered/);
assert.match(html, /Connect Microsoft email/);
assert.match(html, /data-email-connect="prepare"/);
assert.match(html, /data-i18n="admin\.email\.connectButton"/);
assert.match(html, /Coming soon/);
assert.match(html, /Not available yet/);
assert.doesNotMatch(html, /Connected as/);
assert.doesNotMatch(html, /support@lunafrontdesk\.com/);
assert.doesNotMatch(html, /Last sync/);
assert.doesNotMatch(html, /14 hours ago/);
assert.doesNotMatch(html, /data-email-last-sync/);
assert.doesNotMatch(html, /not receiving/i);
assert.doesNotMatch(html, /data-email-disconnect/);
assert.doesNotMatch(html, /Connect Gmail|Connect Google|Connect IMAP/i);
assert.doesNotMatch(html, /AADSTS|ErrorInvalidMailbox|MailboxNotEnabledForRESTAPI|GraphError|delta|poller/i);

const fetchesBeforeLocale = fetchCalls;
sandbox.portalLang = 'es';
sandbox.portalT = (key) => es[key] || key;
sandbox.adminEmailRefreshOnLocaleChange();
html = body.innerHTML;
assert.strictEqual(fetchCalls, fetchesBeforeLocale, 'locale switch must not refetch');
assert.match(html, /data-email-empty="1"/);
assert.match(html, /No conectado/);
assert.match(html, /No hay ningún buzón registrado/);
assert.match(html, /Conectar email de Microsoft/);
assert.match(html, /Próximamente/);
assert.doesNotMatch(html, /Connect Microsoft email/);
assert.doesNotMatch(html, /Connected as|Conectado como/);
assert.doesNotMatch(html, /support@lunafrontdesk\.com/);
assert.doesNotMatch(html, /Last sync|Última sincronización/);
assert.doesNotMatch(html, /Connect Gmail|Connect Google|Conectar Gmail/i);

sandbox.portalLang = 'en';
sandbox.portalT = (key) => en[key] || key;
html = render(neverConnected);
assert.match(html, /data-email-empty="1"/);
assert.match(html, /Not connected/);
assert.match(html, /No email mailbox is registered/);
assert.match(html, /Connect Microsoft email/);
assert.match(html, /data-email-connect="prepare"/);
assert.doesNotMatch(html, /Connected as/);
assert.doesNotMatch(html, /Last sync/);
assert.doesNotMatch(html, /support@lunafrontdesk\.com/);
assert.doesNotMatch(html, /data-email-disconnect/);
assert.match(html, /Coming soon/);
assert.doesNotMatch(html, /Connect Gmail|Connect Google|Connect IMAP/i);

sandbox.portalLang = 'es';
sandbox.portalT = (key) => en[key] || key;
html = render(neverConnected);
assert.match(html, /Conectar email de Microsoft/);
assert.match(html, /No hay ningún buzón registrado/);
assert.doesNotMatch(html, /Connect Microsoft email/);
assert.doesNotMatch(html, /Connected as|Conectado como/);
assert.doesNotMatch(html, /Last sync|Última sincronización/);

sandbox.portalLang = 'en';
sandbox.portalT = (key) => en[key] || key;
html = render({
  actions: { prepare: false, connect: false, disconnect: true, reauthorize: false },
  provider_actions: {
    microsoft_graph: { prepare: false, connect: false, disconnect: true, reauthorize: false },
  },
  locations: [{ location_id: 'sunset-somo', active: true }],
  endpoints: [{
    provider: 'microsoft_graph',
    location_id: 'sunset-somo',
    endpoint_id: '11111111-1111-4111-8111-111111111111',
    public_address: 'support@lunafrontdesk.com',
    connection_state: 'connected_health',
    last_sync: new Date(Date.now() - (14 * 60 * 60 * 1000)).toISOString(),
  }],
});
assert.doesNotMatch(html, /data-email-empty=/);
assert.match(html, /Connected as/);
assert.match(html, /support@lunafrontdesk\.com/);
assert.match(html, /Last sync/);
assert.match(html, /Disconnect Microsoft/);

assert.strictEqual(fetchCalls, fetchesBeforeLocale, 'empty-state mocks must not hit Graph');

console.log('PASS EMAIL-CONNECT-UI-006 empty not-connected state + EN/ES Connect CTA');
