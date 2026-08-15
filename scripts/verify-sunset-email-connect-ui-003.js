'use strict';

/**
 * EMAIL-CONNECT-UI-003 — Honest stale last-sync chrome on Admin → Email.
 * Connected mailbox + last_sync older than ~10 minutes: relative time +
 * stale/not-receiving warning. No invented Graph codes. No fake fresh sync.
 * Stay off Inbox / poller / Graph / delta worker files.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

assert.ok(uiSrc.includes('adminEmailLastSyncRaw'));
assert.ok(uiSrc.includes('Last sync'));
assert.ok(uiSrc.includes('Última sincronización'));
assert.ok(uiSrc.includes('not receiving') || uiSrc.includes('Not receiving'));
assert.ok(uiSrc.includes('no está llegando') || uiSrc.includes('no llegan'));
assert.ok(uiSrc.includes('data-email-last-sync-warn') || uiSrc.includes('data-email-last-sync-stale'));
assert.ok(!uiSrc.includes('inbox-thread'));
assert.ok(!/staff-email-oauth-routes/.test(uiSrc));
assert.ok(!/AADSTS|ErrorInvalidMailbox|MailboxNotEnabledForRESTAPI|GraphError/.test(uiSrc));
assert.ok(/portal-admin-email-last-sync\.is-stale|portal-admin-email-last-sync-warn/.test(apiSrc));

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
  Date,
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
const justOverTen = new Date(now - (11 * 60 * 1000)).toISOString();
const justUnderTen = new Date(now - (9 * 60 * 1000)).toISOString();

sandbox.portalLang = 'en';
let html = render({ last_sync: staleIso });
assert.match(html, /Last sync/);
assert.match(html, /14 hours ago/);
assert.match(html, /data-email-last-sync/);
assert.match(html, /data-email-last-sync-(warn|stale)/);
assert.match(html, /not receiving/i);
assert.doesNotMatch(html, /just now/i);
assert.doesNotMatch(html, /AADSTS|ErrorInvalidMailbox|MailboxNotEnabledForRESTAPI|GraphError|delta|poller/i);
assert.doesNotMatch(html.replace(/data-email-endpoint-id="[^"]+"/, ''), /11111111-1111-4111-8111-111111111111/);

html = render({ last_sync: justOverTen });
assert.match(html, /11 minutes ago/);
assert.match(html, /not receiving/i);

html = render({ last_sync: freshIso });
assert.match(html, /Last sync/);
assert.match(html, /2 minutes ago/);
assert.doesNotMatch(html, /not receiving/i);
assert.doesNotMatch(html, /data-email-last-sync-warn|data-email-last-sync-stale="1"/);

html = render({ last_sync: justUnderTen });
assert.match(html, /9 minutes ago/);
assert.doesNotMatch(html, /not receiving/i);

html = render({ last_sync: staleIso, connection_state: 'disconnected' }, {
  prepare: true, connect: false, disconnect: false, reauthorize: false,
});
assert.match(html, /Last sync/);
assert.match(html, /14 hours ago/);
assert.doesNotMatch(html, /not receiving/i);

html = render({});
assert.doesNotMatch(html, /Last sync/);
assert.doesNotMatch(html, /not receiving/i);

sandbox.portalLang = 'es';
html = render({ last_sync: staleIso });
assert.match(html, /Última sincronización/);
assert.match(html, /hace 14 horas/);
assert.match(html, /no está llegando|no llegan/i);
assert.doesNotMatch(html.replace(/\sdata-i18n="admin\.email\.[^"]+"/g, ''), /admin\.email\.(lastSync|lastSyncStale)/);

console.log('PASS EMAIL-CONNECT-UI-003 honest stale last-sync chrome');
