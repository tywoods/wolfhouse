'use strict';

/**
 * EMAIL-CONNECT-UI-005 — Admin Email disconnect/revoke chrome is real EN/ES.
 * Language switch updates the button/label from the cached payload.
 * Disconnected/revoked chrome must not show last-sync or a stale warning
 * as if still connected. Gmail/IMAP stay coming-soon. Chrome only —
 * no poller / Graph / live revoke.
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

assert.strictEqual(en['admin.email.disconnectButton'], 'Disconnect Microsoft');
assert.strictEqual(es['admin.email.disconnectButton'], 'Desconectar Microsoft');
assert.strictEqual(en['admin.email.disconnectLabel'], 'Microsoft disconnect');
assert.strictEqual(es['admin.email.disconnectLabel'], 'Desconexión de Microsoft');
assert.strictEqual(en['admin.email.disconnectSafetyNote'], 'Disconnect revokes Microsoft mailbox access. Email processing stays off.');
assert.strictEqual(es['admin.email.disconnectSafetyNote'], 'La desconexión revoca el acceso al buzón de Microsoft. El procesamiento de email sigue desactivado.');
assert.strictEqual(en['admin.email.state.disconnected'], 'No email mailbox is registered.');
assert.strictEqual(es['admin.email.state.disconnected'], 'No hay ningún buzón registrado.');
assert.strictEqual(en['admin.email.state.revoked'], 'Authorization revoked.');
assert.strictEqual(es['admin.email.state.revoked'], 'Autorización revocada.');
assert.ok(uiSrc.includes("admin.email.disconnectButton"));
assert.ok(uiSrc.includes('data-i18n="admin.email.disconnectSafetyNote"') || uiSrc.includes("admin.email.disconnectSafetyNote"));
assert.ok(uiSrc.includes("emailUiT('admin.email.disconnectButton'"));
assert.ok(uiSrc.includes("emailUiT('admin.email.disconnectLabel'"));
assert.ok(uiSrc.includes("emailUiT('admin.email.disconnectSafetyNote'"));
assert.ok(uiSrc.includes('admin.email.removeMicrosoftButton'));
assert.ok(uiSrc.includes('admin.email.removeSafetyNote'));
assert.ok(uiSrc.includes('function adminEmailStateCopy'));
assert.ok(uiSrc.includes("connected ? adminEmailLastSyncRaw(data) : ''"));
assert.ok(uiSrc.includes('function adminEmailRefreshOnLocaleChange'));
assert.ok(adminUi.includes('adminEmailRefreshOnLocaleChange()'));
const localeFn = adminUi.match(/function adminRefreshOnLocaleChange\(\)\{[\s\S]*?\n\}/);
assert.ok(localeFn, 'adminRefreshOnLocaleChange present');
assert.ok(localeFn[0].includes('adminEmailRefreshOnLocaleChange()'));
assert.ok(!localeFn[0].includes('loadAdminEmailSettings()'), 'locale change must not refetch Email');
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

function render(endpointExtra, actions) {
  sandbox.renderAdminEmailSettingsData({
    actions: actions || { prepare: false, connect: false, disconnect: true, reauthorize: false },
    provider_actions: {
      microsoft_graph: actions || { prepare: false, connect: false, disconnect: true, reauthorize: false },
    },
    locations: [{ location_id: 'sunset-somo', active: true }],
    endpoints: [Object.assign({
      provider: 'microsoft_graph',
      location_id: 'sunset-somo',
      endpoint_id: '11111111-1111-4111-8111-111111111111',
      public_address: 'support@lunafrontdesk.com',
      connection_state: 'connected_health',
    }, endpointExtra || {})],
  });
  return body.innerHTML;
}

const now = Date.now();
const staleIso = new Date(now - (14 * 60 * 60 * 1000)).toISOString();

sandbox.portalLang = 'en';
sandbox.portalT = (key) => en[key] || key;
let html = render({ last_sync: staleIso });
assert.match(html, /Disconnect Microsoft/);
assert.match(html, /Microsoft disconnect/);
assert.match(html, /Disconnect revokes Microsoft mailbox access/);
assert.match(html, /data-email-disconnect="1"/);
assert.match(html, /data-i18n="admin\.email\.disconnectButton"/);
assert.match(html, /data-i18n="admin\.email\.disconnectSafetyNote"/);
assert.match(html, /Last sync/);
assert.match(html, /14 hours ago/);
assert.match(html, /not receiving/i);
assert.match(html, /Connected as/);
assert.match(html, /support@lunafrontdesk\.com/);
assert.match(html, /Coming soon/);
assert.match(html, /Not available yet/);
assert.doesNotMatch(html, /Connect Gmail|Connect Google|Connect IMAP/i);
assert.doesNotMatch(html, /just now/i);
assert.doesNotMatch(html, /AADSTS|ErrorInvalidMailbox|MailboxNotEnabledForRESTAPI|GraphError|delta|poller/i);
assert.doesNotMatch(html.replace(/data-email-endpoint-id="[^"]+"/, ''), /11111111-1111-4111-8111-111111111111/);

const fetchesBeforeLocale = fetchCalls;
sandbox.portalLang = 'es';
sandbox.portalT = (key) => es[key] || key;
sandbox.adminEmailRefreshOnLocaleChange();
html = body.innerHTML;
assert.strictEqual(fetchCalls, fetchesBeforeLocale, 'locale switch must not refetch');
assert.match(html, /Desconectar Microsoft/);
assert.match(html, /Desconexión de Microsoft/);
assert.match(html, /La desconexión revoca el acceso al buzón de Microsoft/);
assert.match(html, /data-email-disconnect="1"/);
assert.match(html, /Última sincronización/);
assert.match(html, /hace 14 horas/);
assert.match(html, /no está llegando|no llegan/i);
assert.match(html, /Conectado como/);
assert.match(html, /support@lunafrontdesk\.com/);
assert.match(html, /Próximamente/);
assert.doesNotMatch(html, /Disconnect Microsoft/);
assert.doesNotMatch(html, /just now|ahora mismo/i);
assert.doesNotMatch(html.replace(/\sdata-i18n="admin\.email\.[^"]+"/g, ''), /admin\.email\.(disconnectButton|disconnectSafetyNote)/);
assert.doesNotMatch(html, /AADSTS|ErrorInvalidMailbox|MailboxNotEnabledForRESTAPI|GraphError|delta|poller/i);

sandbox.portalLang = 'en';
sandbox.portalT = (key) => en[key] || key;
sandbox.adminEmailRefreshOnLocaleChange();
html = body.innerHTML;
assert.match(html, /Disconnect Microsoft/);
assert.match(html, /Disconnect revokes Microsoft mailbox access/);
assert.doesNotMatch(html, /Desconectar Microsoft/);

// EN pack fallback while locale is ES must still paint Spanish disconnect chrome.
sandbox.portalLang = 'es';
sandbox.portalT = (key) => en[key] || key;
html = render({ last_sync: staleIso });
assert.match(html, /Desconectar Microsoft/);
assert.match(html, /Desconexión de Microsoft/);
assert.match(html, /La desconexión revoca/);
assert.doesNotMatch(html, /Disconnect Microsoft/);

const disconnectedActions = { prepare: true, connect: false, disconnect: false, reauthorize: false };
html = render({ last_sync: staleIso, connection_state: 'disconnected' }, disconnectedActions);
assert.match(html, /No hay ningún buzón registrado/);
assert.doesNotMatch(html, /Last sync|Última sincronización/);
assert.doesNotMatch(html, /14 hours ago|hace 14 horas/);
assert.doesNotMatch(html, /data-email-last-sync/);
assert.doesNotMatch(html, /not receiving|no está llegando|no llegan/i);
assert.doesNotMatch(html, /data-email-disconnect/);
assert.match(html, /Próximamente/);
assert.doesNotMatch(html, /Connect Gmail|Connect Google|Connect IMAP/i);

sandbox.portalLang = 'en';
sandbox.portalT = (key) => en[key] || key;
html = render({ last_sync: staleIso, connection_state: 'revoked' }, {
  prepare: false, connect: false, disconnect: false, reauthorize: false,
});
assert.match(html, /Authorization revoked/);
assert.doesNotMatch(html, /Last sync/);
assert.doesNotMatch(html, /14 hours ago/);
assert.doesNotMatch(html, /data-email-last-sync/);
assert.doesNotMatch(html, /not receiving/i);
assert.doesNotMatch(html, /just now/i);

assert.strictEqual(fetchCalls, fetchesBeforeLocale, 'disconnected/revoked mocks must not hit Graph');

console.log('PASS EMAIL-CONNECT-UI-005 EN/ES disconnect chrome without stale disconnected last-sync');
