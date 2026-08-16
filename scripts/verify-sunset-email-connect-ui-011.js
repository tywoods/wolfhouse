'use strict';

/**
 * EMAIL-CONNECT-UI-011 — Registered-not-connected Remove/Disconnect chrome.
 *
 * Microsoft + Gmail cards in registered_not_connected show Remove (same
 * disconnect family). IMAP stays Coming soon. Connected Microsoft disconnect
 * chrome still present. No inbox-thread / poller / invent status.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const {
  isEligibleRegisteredEndpointRemove,
  isEligibleDisconnectEndpoint,
  endpointDto,
  computeProviderEmailSettingsActions,
  DISCONNECT_ENABLED_ENV,
} = require('./lib/staff-email-settings-routes');
const {
  SQL_DELETE_REGISTERED_NOT_CONNECTED,
  tryRemoveRegisteredNotConnectedEndpoint,
} = require('./lib/email-registered-endpoint-remove');
const {
  GOOGLE_OAUTH_DISCONNECT_PATH,
  isGoogleOAuthDisconnectEnabled,
} = require('./lib/staff-email-google-oauth-routes');
const {
  GOOGLE_DISCONNECT_PATH,
  isGoogleDisconnectRouteEnabled,
} = require('./lib/staff-google-oauth-production-integration');

const ROOT = path.join(__dirname, '..');
const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');
const en = STAFF_PORTAL_STRINGS.en;
const es = STAFF_PORTAL_STRINGS.es;

assert.equal(GOOGLE_OAUTH_DISCONNECT_PATH, '/staff/admin/email-settings/oauth/google/disconnect');
assert.equal(GOOGLE_DISCONNECT_PATH, GOOGLE_OAUTH_DISCONNECT_PATH);
assert.ok(uiSrc.includes('GOOGLE_DISCONNECT_UI_PATH'));
assert.ok(uiSrc.includes('admin.email.removeMicrosoftButton'));
assert.ok(uiSrc.includes('admin.email.removeGoogleButton'));
assert.ok(uiSrc.includes('admin.email.removeSafetyNote'));
assert.ok(!uiSrc.includes('inbox-thread'));
assert.match(SQL_DELETE_REGISTERED_NOT_CONNECTED, /unverified_offline/);
assert.match(SQL_DELETE_REGISTERED_NOT_CONNECTED, /pending_manual_validation/);
assert.match(SQL_DELETE_REGISTERED_NOT_CONNECTED, /g\.endpoint_id IS NULL/);

assert.equal(en['admin.email.removeMicrosoftButton'], 'Remove Microsoft mailbox');
assert.equal(es['admin.email.removeMicrosoftButton'], 'Quitar buzón Microsoft');
assert.equal(en['admin.email.removeGoogleButton'], 'Remove Gmail');
assert.equal(es['admin.email.removeGoogleButton'], 'Quitar Gmail');
assert.equal(en['admin.email.removeSafetyNote'], 'Removes this mailbox registration. Email processing stays off.');
assert.equal(es['admin.email.removeSafetyNote'], 'Elimina el registro de este buzón. El procesamiento de email sigue desactivado.');

const unverifiedMs = {
  provider: 'microsoft_graph',
  auth_mode: 'delegated_authorization_code',
  connector_mode: 'microsoft_delegated_oauth',
  binding_status: 'unverified_offline',
  public_address: 'support@example.com',
  location_active: true,
  id: '11111111-1111-4111-8111-111111111111',
  location_id: 'sunset-somo',
};
const unverifiedGmail = {
  provider: 'gmail_api',
  auth_mode: 'delegated_authorization_code',
  connector_mode: 'google_delegated_oauth',
  binding_status: 'unverified_offline',
  public_address: 'desk@gmail.example',
  location_active: true,
  id: '22222222-2222-4222-8222-222222222222',
  location_id: 'sunset-somo',
};
const noGrant = {
  grant_present: false,
  grant_status: null,
  reconcile_state: null,
  has_active_lease: false,
  grant_generation: null,
  scope_version: null,
  lease_clear: false,
};
const connectedGrant = {
  grant_present: true,
  grant_status: 'active',
  reconcile_state: 'clean',
  has_active_lease: false,
  grant_generation: 1,
  scope_version: 'phase_a_v2',
  lease_clear: true,
};
const verifiedMs = Object.assign({}, unverifiedMs, { binding_status: 'verified' });

assert.equal(isEligibleRegisteredEndpointRemove(unverifiedMs, noGrant), true);
assert.equal(isEligibleRegisteredEndpointRemove(unverifiedGmail, noGrant), true);
assert.equal(isEligibleRegisteredEndpointRemove(verifiedMs, connectedGrant), false);
assert.equal(isEligibleRegisteredEndpointRemove(unverifiedMs, connectedGrant), false);
assert.equal(isEligibleDisconnectEndpoint(verifiedMs, connectedGrant), true);
assert.equal(isEligibleDisconnectEndpoint(unverifiedMs, noGrant), false);

const gateEnv = {
  SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true',
  LUNA_DEPLOYMENT: 'sunset-staging',
  [DISCONNECT_ENABLED_ENV]: 'true',
  LUNA_EMAIL_OAUTH_START_ENABLED: 'true',
  LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED: 'true',
};
const msDto = endpointDto(unverifiedMs, { grant_present: false }, {
  disconnectGateOn: true,
  grantFact: noGrant,
});
assert.equal(msDto.connection_state, 'registered_not_connected');
assert.equal(msDto.start_eligible, true);
assert.equal(msDto.disconnect_eligible, true);

const gmailDto = endpointDto(unverifiedGmail, { grant_present: false }, {
  disconnectGateOn: true,
  grantFact: noGrant,
});
assert.equal(gmailDto.connection_state, 'registered_not_connected');
assert.equal(gmailDto.disconnect_eligible, true);

const actions = computeProviderEmailSettingsActions(gateEnv, [
  { location_id: 'sunset-somo', active: true },
], [msDto, gmailDto]);
assert.equal(actions.microsoft_graph.connect, true);
assert.equal(actions.microsoft_graph.disconnect, true);
assert.equal(actions.gmail_api.connect, true);
assert.equal(actions.gmail_api.disconnect, true);

assert.equal(isGoogleOAuthDisconnectEnabled(gateEnv), true);
assert.equal(isGoogleOAuthDisconnectEnabled({ LUNA_DEPLOYMENT: 'sunset-staging' }), false);
assert.equal(isGoogleDisconnectRouteEnabled(gateEnv), true);

async function removeHelperSmoke() {
  const calls = [];
  const pg = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  const miss = await tryRemoveRegisteredNotConnectedEndpoint(pg, Object.freeze({
    locationId: 'sunset-somo',
    endpointId: '11111111-1111-4111-8111-111111111111',
    provider: 'microsoft_graph',
  }));
  assert.equal(miss.kind, 'not_applicable');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /DELETE FROM tenant_channel_endpoints/);

  const hitPg = {
    async query() {
      return { rows: [{ endpoint_id: '11111111-1111-4111-8111-111111111111' }] };
    },
  };
  const hit = await tryRemoveRegisteredNotConnectedEndpoint(hitPg, Object.freeze({
    locationId: 'sunset-somo',
    endpointId: '11111111-1111-4111-8111-111111111111',
    provider: 'gmail_api',
  }));
  assert.equal(hit.kind, 'removed');
  assert.equal(hit.result.status, 'disconnected');
}

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

function cardHtml(html, provider) {
  const start = html.indexOf('data-email-provider="' + provider + '"');
  assert.ok(start >= 0, 'missing ' + provider);
  const from = html.lastIndexOf('<section', start);
  const next = html.indexOf('<section', from + 8);
  return html.slice(from, next === -1 ? html.length : next);
}

const body = makeBody();
const sandbox = {
  URL,
  Date,
  window: { location: { assign() {} } },
  document: { getElementById(id) { return id === 'admin-email-settings-body' ? body : null; } },
  el(id) { return id === 'admin-email-settings-body' ? body : null; },
  escHtml(s) { return String(s == null ? '' : s); },
  portalT(key) { return en[key] || key; },
  portalLang: 'en',
  fetch() { return Promise.resolve({ ok: false, json: async () => ({}) }); },
  console,
};
vm.runInNewContext(uiSrc, sandbox);

sandbox.renderAdminEmailSettingsData({
  actions: { prepare: false, connect: true, disconnect: true, reauthorize: false },
  provider_actions: {
    microsoft_graph: { prepare: false, connect: true, disconnect: true, reauthorize: false },
    gmail_api: { prepare: false, connect: true, disconnect: true, reauthorize: false },
  },
  locations: [{ location_id: 'sunset-somo', active: true }],
  endpoints: [
    {
      provider: 'microsoft_graph',
      location_id: 'sunset-somo',
      endpoint_id: '11111111-1111-4111-8111-111111111111',
      public_address: 'support@example.com',
      connection_state: 'registered_not_connected',
      disconnect_eligible: true,
      start_eligible: true,
    },
    {
      provider: 'gmail_api',
      location_id: 'sunset-somo',
      endpoint_id: '22222222-2222-4222-8222-222222222222',
      public_address: 'desk@gmail.example',
      connection_state: 'registered_not_connected',
      disconnect_eligible: true,
      start_eligible: true,
    },
  ],
});

const html = body.innerHTML;
const ms = cardHtml(html, 'microsoft_graph');
const gmail = cardHtml(html, 'gmail_api');
const imap = cardHtml(html, 'imap_smtp');

assert.match(ms, /Mailbox registered, not connected/);
assert.match(ms, /Remove Microsoft mailbox/);
assert.match(ms, /data-email-disconnect="1"/);
assert.match(ms, /data-email-provider="microsoft_graph"/);
assert.match(ms, /Removes this mailbox registration/);
assert.match(ms, /Connect Microsoft email/);
assert.match(gmail, /Mailbox registered, not connected/);
assert.match(gmail, /Remove Gmail/);
assert.match(gmail, /data-email-disconnect="1"/);
assert.match(gmail, /data-email-provider="gmail_api"/);
assert.match(gmail, /Removes this mailbox registration/);
assert.match(gmail, /Connect Google email/);
assert.match(imap, /Coming soon/);
assert.match(imap, /Not available yet/);
assert.doesNotMatch(imap, /data-email-disconnect/);
assert.doesNotMatch(html, /inbox-thread/);

sandbox.renderAdminEmailSettingsData({
  actions: { prepare: false, connect: false, disconnect: true, reauthorize: false },
  provider_actions: {
    microsoft_graph: { prepare: false, connect: false, disconnect: true, reauthorize: false },
    gmail_api: { prepare: true, connect: false, disconnect: false, reauthorize: false },
  },
  locations: [{ location_id: 'sunset-somo', active: true }],
  endpoints: [{
    provider: 'microsoft_graph',
    location_id: 'sunset-somo',
    endpoint_id: '11111111-1111-4111-8111-111111111111',
    public_address: 'support@example.com',
    connection_state: 'connected_health',
    disconnect_eligible: true,
  }],
});
assert.match(cardHtml(body.innerHTML, 'microsoft_graph'), /Disconnect Microsoft/);
assert.match(cardHtml(body.innerHTML, 'microsoft_graph'), /Disconnect revokes Microsoft mailbox access/);

removeHelperSmoke().then(() => {
  console.log('PASS EMAIL-CONNECT-UI-011 registered-not-connected Remove/Disconnect');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
