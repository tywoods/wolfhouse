'use strict';

/**
 * EMAIL-CONNECT-UI-008 — Hard-refresh while Microsoft is connected must not
 * flash Connect busy or failed-consent copy. After a failed Connect, retry
 * leaves the fail copy, shows busy, then lands on Connected-as or the same
 * fail copy. EN/ES. No leftover Graph codes. Gmail stays coming-soon.
 * Chrome only — no poller / live revoke.
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

assert.ok(uiSrc.includes('function setConnectBusy'));
assert.ok(uiSrc.includes('function renderAdminEmailConnectFailed'));
assert.ok(uiSrc.includes('function beginAdminEmailConnectAttempt'));
assert.ok(uiSrc.includes('beginAdminEmailConnectAttempt(section)'));
assert.ok(uiSrc.includes('function loadAdminEmailSettings'));
assert.ok(!/setConnectBusy|renderAdminEmailConnectFailed/.test(loadFnSrc(uiSrc)));
assert.ok(!uiSrc.includes('inbox-thread'));
assert.ok(!/staff-email-oauth-routes/.test(uiSrc));
assert.ok(!/AADSTS|ErrorInvalidMailbox|MailboxNotEnabledForRESTAPI|GraphError/.test(uiSrc));

function loadFnSrc(src) {
  const start = src.indexOf('function loadAdminEmailSettings');
  assert.ok(start >= 0, 'loadAdminEmailSettings missing');
  const next = src.indexOf('\nfunction adminEmailRefreshOnLocaleChange', start + 1);
  assert.ok(next > start, 'loadAdminEmailSettings bounds');
  return src.slice(start, next);
}

function makeBody() {
  const el = {
    id: 'admin-email-settings-body',
    _html: '',
    paints: [],
    querySelector() { return null; },
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

function assertNoBusyOrFailCopy(html) {
  assert.doesNotMatch(html, /Connecting Microsoft/);
  assert.doesNotMatch(html, /Conectando Microsoft/);
  assert.doesNotMatch(html, /Couldn’t connect Microsoft/);
  assert.doesNotMatch(html, /No se pudo conectar Microsoft/);
  assert.doesNotMatch(html, /data-email-connect-busy/);
  assert.doesNotMatch(html, /data-email-connect-failed/);
  assert.doesNotMatch(html, /AADSTS|ErrorInvalidMailbox|MailboxNotEnabledForRESTAPI|GraphError/i);
}

function run() {
  const body = makeBody();
  const paints = body.paints;

  let fetchImpl = () => Promise.resolve({ ok: true, json: async () => connected });
  const sandbox = {
    URL,
    Date,
    window: { location: { assign() {} } },
    document: { getElementById(id) { return id === 'admin-email-settings-body' ? body : null; } },
    el(id) { return id === 'admin-email-settings-body' ? body : null; },
    escHtml(s) { return String(s == null ? '' : s); },
    portalT(key) { return en[key] || key; },
    portalLang: 'en',
    getClient() { return 'sunset'; },
    fetch() { return fetchImpl(); },
    console,
  };
  vm.runInNewContext(uiSrc, sandbox);

  sandbox.portalLang = 'en';
  sandbox.portalT = (key) => en[key] || key;
  paints.length = 0;
  sandbox.adminEmailSettingsLastData = null;
  sandbox.adminEmailSettingsConnectFailed = false;
  sandbox.adminEmailSettingsView = '';
  sandbox.loadAdminEmailSettings();
  const loadingHtml = body.innerHTML;
  assert.match(loadingHtml, /Loading email status/);
  assertNoBusyOrFailCopy(loadingHtml);

  return Promise.resolve().then(() => Promise.resolve()).then(() => {
    const html = body.innerHTML;
    assert.match(html, /Connected as/);
    assert.match(html, /support@lunafrontdesk\.com/);
    assert.match(html, /Last sync/);
    assert.match(html, /14 hours ago/);
    assert.doesNotMatch(html, /data-email-empty=/);
    assert.match(html, /Coming soon/);
    assert.doesNotMatch(html, /Connect Gmail|Connect Google|Connect IMAP/i);
    paints.forEach((snap) => assertNoBusyOrFailCopy(snap));
    assertNoBusyOrFailCopy(html);

    sandbox.portalLang = 'es';
    sandbox.portalT = (key) => en[key] || key;
    paints.length = 0;
    sandbox.adminEmailSettingsLastData = null;
    sandbox.adminEmailSettingsConnectFailed = false;
    sandbox.loadAdminEmailSettings();
    assertNoBusyOrFailCopy(body.innerHTML);
    return Promise.resolve().then(() => Promise.resolve());
  }).then(() => {
    const html = body.innerHTML;
    assert.match(html, /Conectado como/);
    assert.match(html, /Última sincronización/);
    assert.doesNotMatch(html, /Connected as|Last sync|Connecting Microsoft|Couldn’t connect Microsoft/);
    paints.forEach((snap) => assertNoBusyOrFailCopy(snap));

    sandbox.portalLang = 'en';
    sandbox.portalT = (key) => en[key] || key;
    sandbox.renderAdminEmailSettingsData(leftover);
    sandbox.renderAdminEmailConnectFailed();
    let htmlFail = body.innerHTML;
    assert.match(htmlFail, /Couldn’t connect Microsoft/);
    assert.match(htmlFail, /data-email-connect-failed/);
    assert.match(htmlFail, /Connect Microsoft email/);

    const section = makeBusySection();
    sandbox.beginAdminEmailConnectAttempt(section);
    const afterRetry = body.innerHTML;
    assert.doesNotMatch(afterRetry, /Couldn’t connect Microsoft/);
    assert.doesNotMatch(afterRetry, /No se pudo conectar Microsoft/);
    assert.doesNotMatch(afterRetry, /data-email-connect-failed/);
    assert.match(afterRetry, /Connect Microsoft email|Connecting Microsoft/);
    assert.match(afterRetry, /data-email-connect="prepare"/);
    assert.doesNotMatch(afterRetry, /Connected as/);
    assert.doesNotMatch(afterRetry, /Last sync/);
    assert.doesNotMatch(afterRetry, /support@lunafrontdesk\.com/);
    assert.strictEqual(section.btn.disabled, true);
    assert.strictEqual(section.btn.textContent, 'Connecting Microsoft…');
    assert.strictEqual(section.attrs['data-email-connect-busy'], '1');
    assert.strictEqual(section.attrs['aria-busy'], 'true');
    assert.strictEqual(section.progress.hidden, false);
    assert.strictEqual(section.progress.textContent, 'Connecting Microsoft…');
    assert.doesNotMatch(section.btn.textContent, /AADSTS|GraphError|ErrorInvalidMailbox/);

    sandbox.renderAdminEmailConnectFailed();
    htmlFail = body.innerHTML;
    assert.match(htmlFail, /Couldn’t connect Microsoft/);
    assert.match(htmlFail, /data-email-connect-failed/);
    assert.match(htmlFail, /Connect Microsoft email/);

    sandbox.adminEmailSettingsConnectFailed = false;
    sandbox.renderAdminEmailSettingsData(connected);
    const landed = body.innerHTML;
    assert.match(landed, /Connected as/);
    assert.match(landed, /support@lunafrontdesk\.com/);
    assert.match(landed, /Last sync/);
    assertNoBusyOrFailCopy(landed);

    sandbox.portalLang = 'es';
    sandbox.portalT = (key) => en[key] || key;
    sandbox.renderAdminEmailSettingsData(leftover);
    sandbox.renderAdminEmailConnectFailed();
    assert.match(body.innerHTML, /No se pudo conectar Microsoft/);
    const sectionEs = makeBusySection();
    sandbox.beginAdminEmailConnectAttempt(sectionEs);
    assert.doesNotMatch(body.innerHTML, /No se pudo conectar Microsoft/);
    assert.doesNotMatch(body.innerHTML, /Couldn’t connect Microsoft/);
    assert.doesNotMatch(body.innerHTML, /data-email-connect-failed/);
    assert.match(body.innerHTML, /Conectar email de Microsoft|Conectando Microsoft/);
    assert.strictEqual(sectionEs.btn.textContent, 'Conectando Microsoft…');
    assert.strictEqual(sectionEs.progress.textContent, 'Conectando Microsoft…');
    sandbox.renderAdminEmailConnectFailed();
    assert.match(body.innerHTML, /No se pudo conectar Microsoft/);
    assert.match(body.innerHTML, /Conectar email de Microsoft/);
    assert.doesNotMatch(body.innerHTML, /Couldn’t connect Microsoft|Connect Microsoft email/);

    console.log('PASS EMAIL-CONNECT-UI-008 no busy/fail flash on connected load + retry after fail');
  });
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
