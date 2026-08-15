'use strict';

/**
 * EMAIL-CONNECT-UI-010 — While Connect is busy, language switch re-paints
 * Connecting Microsoft… / Conectando Microsoft… from cache. No flash to
 * empty, Connected-as, or fail. No refetch. Chrome only — no poller /
 * live revoke.
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

assert.strictEqual(en['admin.email.connectInProgress'], 'Connecting Microsoft…');
assert.strictEqual(es['admin.email.connectInProgress'], 'Conectando Microsoft…');
assert.ok(uiSrc.includes('function setConnectBusy'));
assert.ok(uiSrc.includes('function adminEmailRefreshOnLocaleChange'));
assert.ok(uiSrc.includes("emailUiT('admin.email.connectInProgress'"));
assert.ok(adminUi.includes('adminEmailRefreshOnLocaleChange()'));
const localeFn = adminUi.match(/function adminRefreshOnLocaleChange\(\)\{[\s\S]*?\n\}/);
assert.ok(localeFn, 'adminRefreshOnLocaleChange present');
assert.ok(localeFn[0].includes('adminEmailRefreshOnLocaleChange()'));
assert.ok(!localeFn[0].includes('loadAdminEmailSettings()'), 'admin locale change must not refetch Email');
const emailLocaleFn = uiSrc.match(/function adminEmailRefreshOnLocaleChange\(\)\{[\s\S]*?\n\}/);
assert.ok(emailLocaleFn, 'adminEmailRefreshOnLocaleChange present');
assert.ok(!emailLocaleFn[0].includes('loadAdminEmailSettings()'), 'email locale change must not refetch');
assert.ok(!uiSrc.includes('inbox-thread'));
assert.ok(!/staff-email-oauth-routes/.test(uiSrc));
assert.ok(!/AADSTS|ErrorInvalidMailbox|MailboxNotEnabledForRESTAPI|GraphError/.test(uiSrc));

function makeBody(section) {
  const el = {
    id: 'admin-email-settings-body',
    _html: '',
    paints: [],
    querySelector(sel) {
      if (sel === '[data-email-connect-busy]' && section && section.attrs['data-email-connect-busy'] === '1') {
        return section;
      }
      return null;
    },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get() { return el._html; },
    set(v) {
      el._html = String(v);
      el.paints.push(el._html);
    },
  });
  return el;
}

function makeBusySection() {
  const btn = {
    disabled: false,
    textContent: 'Connect Microsoft email',
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
  };
  const progress = { hidden: true, textContent: '' };
  const section = {
    btn,
    progress,
    attrs: {},
    querySelector(sel) {
      if (sel === '[data-email-connect]') return btn;
      if (sel === '[data-email-connect-progress]') return progress;
      if (sel === '[data-email-prepare-address]') return { disabled: false, value: 'guest@example.com' };
      return null;
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
  };
  return section;
}

const neverConnected = {
  actions: { prepare: true, connect: false, disconnect: false, reauthorize: false },
  provider_actions: {
    microsoft_graph: { prepare: true, connect: false, disconnect: false, reauthorize: false },
  },
  locations: [{ location_id: 'sunset-somo', active: true }],
  endpoints: [],
};

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

const connected = {
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
};

function assertBusyOnly(section, htmlSnaps, label) {
  assert.strictEqual(section.attrs['data-email-connect-busy'], '1', label + ' busy attr');
  assert.strictEqual(section.attrs['aria-busy'], 'true', label + ' aria');
  assert.strictEqual(section.btn.disabled, true, label + ' disabled');
  assert.doesNotMatch(section.btn.textContent, /AADSTS|GraphError|ErrorInvalidMailbox/, label + ' graph');
  htmlSnaps.forEach((snap, i) => {
    assert.doesNotMatch(snap, /Couldn’t connect Microsoft|No se pudo conectar Microsoft/, label + ' fail-paint-' + i);
    assert.doesNotMatch(snap, /Connected as|Conectado como/, label + ' as-paint-' + i);
    assert.doesNotMatch(snap, /Last sync|Última sincronización/, label + ' sync-paint-' + i);
    assert.doesNotMatch(snap, /Loading email status|Cargando estado/, label + ' load-paint-' + i);
    assert.doesNotMatch(snap, /AADSTS|ErrorInvalidMailbox|MailboxNotEnabledForRESTAPI|GraphError/, label + ' graph-paint-' + i);
  });
}

function boot(section) {
  const body = makeBody(section);
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
  return { body, sandbox, fetchCount: () => fetchCalls };
}

const emptySection = makeBusySection();
const empty = boot(emptySection);
empty.sandbox.renderAdminEmailSettingsData(neverConnected);
assert.match(empty.body.innerHTML, /data-email-empty=/);
assert.match(empty.body.innerHTML, /Connect Microsoft email/);
empty.sandbox.setConnectBusy(emptySection, true);
assert.strictEqual(emptySection.btn.textContent, 'Connecting Microsoft…');
assert.strictEqual(emptySection.progress.textContent, 'Connecting Microsoft…');

empty.body.paints.length = 0;
const fetchesEmpty = empty.fetchCount();
empty.sandbox.portalLang = 'es';
empty.sandbox.portalT = (key) => en[key] || key;
empty.sandbox.adminEmailRefreshOnLocaleChange();
assert.strictEqual(empty.fetchCount(), fetchesEmpty, 'busy locale must not refetch');
assert.strictEqual(emptySection.btn.textContent, 'Conectando Microsoft…');
assert.strictEqual(emptySection.progress.textContent, 'Conectando Microsoft…');
assert.doesNotMatch(emptySection.btn.textContent, /Connect Microsoft|Connecting Microsoft…$/);
assertBusyOnly(emptySection, empty.body.paints, 'empty-busy-es');
assert.strictEqual(empty.body.paints.length, 0, 'busy locale must not replace the card');

empty.body.paints.length = 0;
empty.sandbox.portalLang = 'en';
empty.sandbox.portalT = (key) => en[key] || key;
empty.sandbox.adminEmailRefreshOnLocaleChange();
assert.strictEqual(empty.fetchCount(), fetchesEmpty, 'busy locale back to EN must not refetch');
assert.strictEqual(emptySection.btn.textContent, 'Connecting Microsoft…');
assert.strictEqual(emptySection.progress.textContent, 'Connecting Microsoft…');
assertBusyOnly(emptySection, empty.body.paints, 'empty-busy-en');
assert.strictEqual(empty.body.paints.length, 0, 'busy locale EN must not replace the card');

const leftoverSection = makeBusySection();
const leftoverBoot = boot(leftoverSection);
leftoverBoot.sandbox.renderAdminEmailSettingsData(leftover);
leftoverBoot.sandbox.beginAdminEmailConnectAttempt(leftoverSection);
assert.strictEqual(leftoverSection.btn.textContent, 'Connecting Microsoft…');
assert.strictEqual(leftoverSection.attrs['data-email-connect-busy'], '1');
assert.doesNotMatch(leftoverBoot.body.innerHTML, /Connected as|Last sync/);

leftoverBoot.body.paints.length = 0;
const fetchesLeftover = leftoverBoot.fetchCount();
leftoverBoot.sandbox.portalLang = 'es';
leftoverBoot.sandbox.portalT = (key) => en[key] || key;
leftoverBoot.sandbox.adminEmailRefreshOnLocaleChange();
assert.strictEqual(leftoverBoot.fetchCount(), fetchesLeftover, 'leftover busy locale must not refetch');
assert.strictEqual(leftoverSection.btn.textContent, 'Conectando Microsoft…');
assert.strictEqual(leftoverSection.progress.textContent, 'Conectando Microsoft…');
assert.doesNotMatch(leftoverBoot.body.innerHTML, /Connected as|Conectado como/);
assert.doesNotMatch(leftoverBoot.body.innerHTML, /Couldn’t connect Microsoft|No se pudo conectar Microsoft/);
assertBusyOnly(leftoverSection, leftoverBoot.body.paints, 'leftover-busy-es');
assert.strictEqual(leftoverBoot.body.paints.length, 0, 'leftover busy locale must not replace the card');

const settled = boot(makeBusySection());
settled.sandbox.renderAdminEmailSettingsData(connected);
settled.body.paints.length = 0;
const fetchesSettled = settled.fetchCount();
settled.sandbox.portalLang = 'es';
settled.sandbox.portalT = (key) => en[key] || key;
settled.sandbox.adminEmailRefreshOnLocaleChange();
assert.strictEqual(settled.fetchCount(), fetchesSettled, 'settled locale must not refetch');
assert.match(settled.body.innerHTML, /Conectado como/);
assert.match(settled.body.innerHTML, /Última sincronización/);
assert.doesNotMatch(settled.body.innerHTML, /Connecting Microsoft|Conectando Microsoft/);
assert.doesNotMatch(settled.body.innerHTML, /Couldn’t connect Microsoft|No se pudo conectar Microsoft/);

settled.sandbox.renderAdminEmailSettingsData(leftover);
settled.sandbox.renderAdminEmailConnectFailed();
settled.body.paints.length = 0;
settled.sandbox.portalLang = 'en';
settled.sandbox.portalT = (key) => en[key] || key;
settled.sandbox.adminEmailRefreshOnLocaleChange();
assert.strictEqual(settled.fetchCount(), fetchesSettled, 'fail locale must not refetch');
assert.match(settled.body.innerHTML, /Couldn’t connect Microsoft/);
assert.doesNotMatch(settled.body.innerHTML, /Connecting Microsoft|Conectando Microsoft/);
assert.doesNotMatch(settled.body.innerHTML, /Connected as|Conectado como/);

console.log('PASS EMAIL-CONNECT-UI-010 busy Connecting locale re-paint from cache');
