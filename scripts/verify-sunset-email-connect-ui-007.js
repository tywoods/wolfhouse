'use strict';

/**
 * EMAIL-CONNECT-UI-007 — Connect Microsoft shows honest in-progress chrome.
 * Prepare/consent failure is a real EN/ES error with the Connect CTA still
 * available. No leftover connected-as / last-sync. No invented Graph codes.
 * Gmail stays coming-soon. Chrome only — no poller / live revoke.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const ROOT = path.join(__dirname, '..');
const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');
const en = STAFF_PORTAL_STRINGS.en;
const es = STAFF_PORTAL_STRINGS.es;

assert.strictEqual(en['admin.email.connectInProgress'], 'Connecting Microsoft…');
assert.strictEqual(es['admin.email.connectInProgress'], 'Conectando Microsoft…');
assert.strictEqual(en['admin.email.connectFailed'], 'Couldn’t connect Microsoft. Nothing was changed. Try again.');
assert.strictEqual(es['admin.email.connectFailed'], 'No se pudo conectar Microsoft. No se ha cambiado nada. Inténtalo de nuevo.');
assert.ok(uiSrc.includes('function setConnectBusy'));
assert.ok(uiSrc.includes('function renderAdminEmailConnectFailed'));
assert.ok(uiSrc.includes('data-email-connect-progress'));
assert.ok(uiSrc.includes('data-email-connect-busy'));
assert.ok(uiSrc.includes('data-email-connect-failed'));
assert.ok(uiSrc.includes("emailUiT('admin.email.connectInProgress'"));
assert.ok(uiSrc.includes("emailUiT('admin.email.connectFailed'"));
assert.ok(uiSrc.includes('renderAdminEmailConnectFailed()'));
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

const leftover = {
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
sandbox.renderAdminEmailSettingsData(neverConnected);
assert.match(body.innerHTML, /data-email-connect-progress/);
assert.match(body.innerHTML, /Connect Microsoft email/);

const btn = {
  disabled: false,
  textContent: 'Connect Microsoft email',
  attrs: {},
  setAttribute(k, v) { this.attrs[k] = v; },
  removeAttribute(k) { delete this.attrs[k]; },
};
const progress = { hidden: true, textContent: '' };
const section = {
  attrs: {},
  querySelector(sel) {
    if (sel === '[data-email-connect]') return btn;
    if (sel === '[data-email-connect-progress]') return progress;
    if (sel === '[data-email-prepare-address]') return { disabled: false };
    return null;
  },
  setAttribute(k, v) { this.attrs[k] = v; },
  removeAttribute(k) { delete this.attrs[k]; },
};
sandbox.setConnectBusy(section, true);
assert.strictEqual(btn.disabled, true);
assert.strictEqual(btn.textContent, 'Connecting Microsoft…');
assert.strictEqual(btn.attrs['aria-busy'], 'true');
assert.strictEqual(section.attrs['data-email-connect-busy'], '1');
assert.strictEqual(section.attrs['aria-busy'], 'true');
assert.strictEqual(progress.hidden, false);
assert.strictEqual(progress.textContent, 'Connecting Microsoft…');
assert.doesNotMatch(btn.textContent, /AADSTS|GraphError|ErrorInvalidMailbox/);

sandbox.portalLang = 'es';
sandbox.portalT = (key) => es[key] || key;
sandbox.setConnectBusy(section, true);
assert.strictEqual(btn.textContent, 'Conectando Microsoft…');
assert.strictEqual(progress.textContent, 'Conectando Microsoft…');

sandbox.portalLang = 'en';
sandbox.portalT = (key) => en[key] || key;
const fetchesBeforeFail = fetchCalls;
sandbox.renderAdminEmailSettingsData(leftover);
sandbox.renderAdminEmailConnectFailed();
let html = body.innerHTML;
assert.strictEqual(fetchCalls, fetchesBeforeFail, 'failed chrome must not hit Graph');
assert.match(html, /Couldn’t connect Microsoft/);
assert.match(html, /Nothing was changed/);
assert.match(html, /data-email-connect-failed/);
assert.match(html, /data-i18n="admin\.email\.connectFailed"/);
assert.match(html, /Connect Microsoft email/);
assert.match(html, /data-email-connect="prepare"/);
assert.match(html, /Coming soon/);
assert.doesNotMatch(html, /Connected as/);
assert.doesNotMatch(html, /support@lunafrontdesk\.com/);
assert.doesNotMatch(html, /Last sync/);
assert.doesNotMatch(html, /14 hours ago/);
assert.doesNotMatch(html, /AADSTS|ErrorInvalidMailbox|MailboxNotEnabledForRESTAPI|GraphError|delta|poller/i);
assert.doesNotMatch(html, /Connect Gmail|Connect Google|Connect IMAP/i);

sandbox.portalLang = 'es';
sandbox.portalT = (key) => es[key] || key;
sandbox.adminEmailRefreshOnLocaleChange();
html = body.innerHTML;
assert.match(html, /No se pudo conectar Microsoft/);
assert.match(html, /No se ha cambiado nada/);
assert.match(html, /Conectar email de Microsoft/);
assert.match(html, /Próximamente/);
assert.doesNotMatch(html, /Couldn’t connect Microsoft/);
assert.doesNotMatch(html, /Connect Microsoft email/);
assert.doesNotMatch(html, /Connected as|Conectado como/);
assert.doesNotMatch(html, /Last sync|Última sincronización/);
assert.doesNotMatch(html, /AADSTS|GraphError/);

sandbox.portalLang = 'es';
sandbox.portalT = (key) => en[key] || key;
sandbox.renderAdminEmailConnectFailed();
html = body.innerHTML;
assert.match(html, /No se pudo conectar Microsoft/);
assert.match(html, /Conectar email de Microsoft/);
assert.doesNotMatch(html, /Couldn’t connect Microsoft/);

console.log('PASS EMAIL-CONNECT-UI-007 Connect busy + failed-consent EN/ES chrome');
