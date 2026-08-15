'use strict';

/**
 * EMAIL-CONNECT-UI-002 — Microsoft connected-as + last sync if API sends it.
 * Gmail/IMAP stay disabled. Product load-fail. No Inbox / OAuth / language pack.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');

assert.ok(uiSrc.includes('adminEmailLooksLikeAddress'));
assert.ok(uiSrc.includes('adminEmailLastSyncRaw'));
assert.ok(uiSrc.includes('Connected as'));
assert.ok(uiSrc.includes('Conectado como'));
assert.ok(uiSrc.includes('Last sync'));
assert.ok(uiSrc.includes('Última sincronización'));
assert.ok(uiSrc.includes('Not available yet'));
assert.ok(uiSrc.includes('Aún no disponible'));
assert.ok(uiSrc.includes('renderAdminEmailLoadFail'));
assert.ok(uiSrc.includes('data-email-retry'));
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
    last_sync: '2026-08-15T08:30:00.000Z',
  }],
});
assert.match(body.innerHTML, /Connected as/);
assert.match(body.innerHTML, /desk@sunset\.example/);
assert.match(body.innerHTML, /Last sync/);
assert.doesNotMatch(body.innerHTML.replace(/data-email-endpoint-id="[^"]+"/, ''), /11111111-1111-4111-8111-111111111111/);
assert.match(body.innerHTML, /data-email-disconnect/);
assert.match(body.innerHTML, /Not available yet/);
assert.doesNotMatch(body.innerHTML, /type="password"/);

sandbox.renderAdminEmailSettingsData({
  actions: { prepare: false, connect: false, disconnect: true, reauthorize: false },
  locations: [{ location_id: 'sunset-somo', active: true }],
  endpoints: [{
    provider: 'microsoft_graph',
    location_id: 'sunset-somo',
    endpoint_id: '22222222-2222-4222-8222-222222222222',
    public_address: 'desk@sunset.example',
    connection_state: 'connected_health',
  }],
});
assert.match(body.innerHTML, /Connected as/);
assert.doesNotMatch(body.innerHTML, /Last sync/);

sandbox.renderAdminEmailSettingsData({
  actions: {},
  locations: [{ location_id: 'sunset-somo', active: true }],
  endpoints: [{
    provider: 'microsoft_graph',
    public_address: '11111111-1111-4111-8111-111111111111',
    connection_state: 'connected_health',
  }],
});
assert.doesNotMatch(body.innerHTML, /Connected as[\s\S]*11111111/);

sandbox.renderAdminEmailLoadFail();
assert.match(body.innerHTML, /Couldn’t load mailboxes|Couldn't load mailboxes/);
assert.match(body.innerHTML, /Try again/);
assert.match(body.innerHTML, /data-email-state="error"/);
assert.doesNotMatch(body.innerHTML, /email_settings_unavailable|503|stack/);

sandbox.portalLang = 'es';
sandbox.renderAdminEmailLoadFail();
assert.match(body.innerHTML, /No se pudieron cargar los buzones/);
assert.match(body.innerHTML, /Reintentar/);
assert.doesNotMatch(body.innerHTML, /admin\.email\.(loadFail|retry)/);

console.log('PASS EMAIL-CONNECT-UI-002 connected-as + last-sync-if-present + product fail');
