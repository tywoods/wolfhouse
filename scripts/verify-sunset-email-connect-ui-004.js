'use strict';

/**
 * EMAIL-CONNECT-UI-004 — Admin Email last-sync + stale warning are real EN/ES
 * strings. Language switch updates labels from the cached payload. Relative
 * time must not jump to a fake just now. Chrome only — no poller / Graph.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const ROOT = path.join(__dirname, '..');
const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');
const adminUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const en = STAFF_PORTAL_STRINGS.en;
const es = STAFF_PORTAL_STRINGS.es;

assert.strictEqual(en['admin.email.lastSync'], 'Last sync');
assert.strictEqual(es['admin.email.lastSync'], 'Última sincronización');
assert.strictEqual(en['admin.email.lastSyncStale'], 'Stale — not receiving new email.');
assert.strictEqual(es['admin.email.lastSyncStale'], 'Desactualizado — no está llegando correo nuevo.');
assert.strictEqual(en['admin.email.lastSyncHoursAgo'], '{n} hours ago');
assert.strictEqual(es['admin.email.lastSyncHoursAgo'], 'hace {n} horas');
assert.ok(uiSrc.includes('data-i18n="admin.email.lastSync"'));
assert.ok(uiSrc.includes('data-i18n="admin.email.lastSyncStale"'));
assert.ok(uiSrc.includes('data-email-last-sync-iso'));
assert.ok(uiSrc.includes('function adminEmailRefreshOnLocaleChange'));
assert.ok(adminUi.includes('adminEmailRefreshOnLocaleChange()'));
const localeFn = adminUi.match(/function adminRefreshOnLocaleChange\(\)\{[\s\S]*?\n\}/);
assert.ok(localeFn, 'adminRefreshOnLocaleChange present');
assert.ok(localeFn[0].includes('adminEmailRefreshOnLocaleChange()'));
assert.ok(!localeFn[0].includes('loadAdminEmailSettings()'), 'locale change must not refetch Email');
assert.ok(!uiSrc.includes('inbox-thread'));
assert.ok(!/staff-email-oauth-routes/.test(uiSrc));
assert.ok(!/AADSTS|ErrorInvalidMailbox|MailboxNotEnabledForRESTAPI|GraphError/.test(uiSrc));
assert.ok(/portal-admin-email-last-sync\\.is-stale|portal-admin-email-last-sync-warn/.test(apiSrc));

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
const freshIso = new Date(now - (2 * 60 * 1000)).toISOString();

sandbox.portalLang = 'en';
sandbox.portalT = (key) => en[key] || key;
let html = render({ last_sync: staleIso });
assert.match(html, /Last sync/);
assert.match(html, /14 hours ago/);
assert.match(html, /data-email-last-sync-iso="/);
assert.match(html, /data-i18n="admin\.email\.lastSync"/);
assert.match(html, /not receiving/i);
assert.match(html, /Connected as/);
assert.match(html, /support@lunafrontdesk\.com/);
assert.match(html, /data-email-disconnect/);
assert.match(html, /Coming soon/);
assert.match(html, /Not available yet/);
assert.doesNotMatch(html, /just now/i);
assert.doesNotMatch(html, /AADSTS|ErrorInvalidMailbox|MailboxNotEnabledForRESTAPI|GraphError|delta|poller/i);
assert.doesNotMatch(html.replace(/data-email-endpoint-id="[^"]+"/, ''), /11111111-1111-4111-8111-111111111111/);

const fetchesBeforeLocale = fetchCalls;
sandbox.portalLang = 'es';
sandbox.portalT = (key) => es[key] || key;
sandbox.adminEmailRefreshOnLocaleChange();
html = body.innerHTML;
assert.strictEqual(fetchCalls, fetchesBeforeLocale, 'locale switch must not refetch');
assert.match(html, /Última sincronización/);
assert.match(html, /hace 14 horas/);
assert.match(html, /no está llegando|no llegan/i);
assert.match(html, /Conectado como/);
assert.match(html, /support@lunafrontdesk\.com/);
assert.match(html, /data-email-disconnect/);
assert.match(html, /Próximamente/);
assert.doesNotMatch(html, /just now|ahora mismo/i);
assert.doesNotMatch(html, /Last sync/);
assert.doesNotMatch(html.replace(/\sdata-i18n="admin\.email\.[^"]+"/g, ''), /admin\.email\.(lastSync|lastSyncStale)/);
assert.doesNotMatch(html, /AADSTS|ErrorInvalidMailbox|MailboxNotEnabledForRESTAPI|GraphError|delta|poller/i);

sandbox.portalLang = 'en';
sandbox.portalT = (key) => en[key] || key;
sandbox.adminEmailRefreshOnLocaleChange();
html = body.innerHTML;
assert.match(html, /Last sync/);
assert.match(html, /14 hours ago/);
assert.doesNotMatch(html, /just now/i);
assert.doesNotMatch(html, /Última sincronización/);

html = render({ last_sync: freshIso });
assert.match(html, /Last sync/);
assert.match(html, /2 minutes ago/);
assert.doesNotMatch(html, /not receiving/i);
assert.doesNotMatch(html, /just now/i);

html = render({});
assert.doesNotMatch(html, /Last sync/);
assert.doesNotMatch(html, /just now/i);
assert.doesNotMatch(html, /not receiving/i);

// EN pack fallback while locale is ES must still paint Spanish last-sync chrome.
sandbox.portalLang = 'es';
sandbox.portalT = (key) => en[key] || key;
html = render({ last_sync: staleIso });
assert.match(html, /Última sincronización/);
assert.match(html, /hace 14 horas/);
assert.match(html, /no está llegando|no llegan/i);
assert.doesNotMatch(html, /just now|ahora mismo/i);

console.log('PASS EMAIL-CONNECT-UI-004 EN/ES last-sync chrome without fake just now');
