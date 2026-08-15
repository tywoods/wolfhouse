'use strict';

/**
 * EMAIL-LAST-SYNC-001 — Microsoft GET /staff/admin/email-settings last_sync.
 * Exposes a real page_commit timestamp when the poller cursor store has one;
 * omits the field when it does not. Gmail/IMAP never get last_sync.
 * No new poller, no invented clock, no Inbox / draft / Horario paths.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createEmailSettingsRoutes,
  endpointDto,
  normalizeLastSyncIso,
  loadMicrosoftEndpointLastSyncMap,
  SQL_MICROSOFT_ENDPOINT_LAST_SYNC,
} = require('./lib/staff-email-settings-routes');

const LOCATION = 'sunset-somo';
const MS_EP = '22222222-2222-4222-8222-222222222222';
const GMAIL_EP = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const LAST_SYNC = '2026-08-15T08:30:00.000Z';

function response() { return { status: null, body: null }; }
function sendJSON(res, status, body) { res.status = status; res.body = body; return body; }

function atomicRow(patch = {}) {
  return {
    endpoint_id: MS_EP,
    location_id: LOCATION,
    provider: 'microsoft_graph',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
    binding_status: 'verified',
    public_address: 'desk@sunset.example',
    endpoint_active: true,
    location_active: true,
    grant_present: true,
    grant_status: 'active',
    reconcile_state: 'clean',
    scope_version: 'phase_a_v2',
    grant_generation: 1,
    has_active_lease: false,
    lease_token_null: true,
    lease_owner_null: true,
    lease_until_null: true,
    ...patch,
  };
}

function msEndpointRow(patch = {}) {
  return {
    id: MS_EP,
    location_id: LOCATION,
    provider: 'microsoft_graph',
    public_address: 'desk@sunset.example',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
    binding_status: 'verified',
    active: true,
    ...patch,
  };
}

function gmailEndpointRow(patch = {}) {
  return {
    id: GMAIL_EP,
    location_id: LOCATION,
    provider: 'gmail_api',
    public_address: 'desk@gmail.example',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'google_delegated_oauth',
    binding_status: 'unverified_offline',
    active: true,
    ...patch,
  };
}

let count = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { count += 1; console.log(`ok ${count} - ${name}`); });
}

async function main() {
  await test('SQL joins current sealed cursor to committed page_commit only', () => {
    assert.ok(SQL_MICROSOFT_ENDPOINT_LAST_SYNC.includes('tenant_email_inbound_delta_states'));
    assert.ok(SQL_MICROSOFT_ENDPOINT_LAST_SYNC.includes('tenant_email_delta_recovery_operations'));
    assert.ok(SQL_MICROSOFT_ENDPOINT_LAST_SYNC.includes("operation_kind = 'page_commit'"));
    assert.ok(SQL_MICROSOFT_ENDPOINT_LAST_SYNC.includes("outcome = 'committed'"));
    assert.ok(SQL_MICROSOFT_ENDPOINT_LAST_SYNC.includes('cursor_operation_id'));
    assert.ok(SQL_MICROSOFT_ENDPOINT_LAST_SYNC.includes("provider = 'microsoft_graph'"));
    assert.ok(SQL_MICROSOFT_ENDPOINT_LAST_SYNC.includes('is_current = true'));
    // Must not treat lease/pause bumps as last sync.
    assert.ok(!/\bd\.updated_at\b/.test(SQL_MICROSOFT_ENDPOINT_LAST_SYNC));
  });

  await test('normalizeLastSyncIso accepts real ISO/Date and rejects junk', () => {
    assert.strictEqual(normalizeLastSyncIso(LAST_SYNC), LAST_SYNC);
    assert.strictEqual(normalizeLastSyncIso(new Date(LAST_SYNC)), LAST_SYNC);
    assert.strictEqual(normalizeLastSyncIso(''), null);
    assert.strictEqual(normalizeLastSyncIso('not-a-date'), null);
    assert.strictEqual(normalizeLastSyncIso(null), null);
    assert.strictEqual(normalizeLastSyncIso(42), null);
  });

  await test('endpointDto includes last_sync only for microsoft with real value', () => {
    const withSync = endpointDto(msEndpointRow(), { grant_present: true, grant_status: 'active' }, {
      lastSync: LAST_SYNC,
    });
    assert.strictEqual(withSync.last_sync, LAST_SYNC);
    assert.strictEqual(withSync.provider, 'microsoft_graph');

    const without = endpointDto(msEndpointRow(), { grant_present: true, grant_status: 'active' }, {});
    assert.strictEqual(Object.prototype.hasOwnProperty.call(without, 'last_sync'), false);

    const junk = endpointDto(msEndpointRow(), { grant_present: true, grant_status: 'active' }, {
      lastSync: 'bogus',
    });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(junk, 'last_sync'), false);

    const gmail = endpointDto(gmailEndpointRow(), { grant_present: false }, {
      lastSync: LAST_SYNC,
    });
    assert.strictEqual(gmail.provider, 'gmail_api');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(gmail, 'last_sync'), false);
  });

  await test('GET projects last_sync when store map has one; omits when absent', async () => {
    const resPresent = response();
    const routesPresent = createEmailSettingsRoutes({
      runtimeEnv: { SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true' },
      sendJSON,
      assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute() { return { ok: true }; },
      withPgClient: (fn) => fn({ query: async () => ({ rows: [{ client_id: CLIENT_ID }] }) }),
      listTenantLocations: async () => ({
        ok: true,
        value: [{ location_id: LOCATION, display_name: 'Sunset', active: true }],
      }),
      listTenantChannelEndpoints: async () => ({
        ok: true,
        value: [msEndpointRow()],
      }),
      loadPhaseBReauthEligibilityFacts: async () => ([atomicRow()]),
      loadMicrosoftEndpointLastSyncMap: async () => new Map([[MS_EP, LAST_SYNC]]),
    });
    await routesPresent.handleGet({ client: 'sunset' }, {}, resPresent, { role: 'admin' });
    assert.strictEqual(resPresent.status, 200);
    assert.strictEqual(resPresent.body.endpoints[0].last_sync, LAST_SYNC);
    assert.strictEqual(resPresent.body.endpoints[0].connection_state, 'connected_health');

    const resAbsent = response();
    const routesAbsent = createEmailSettingsRoutes({
      runtimeEnv: { SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true' },
      sendJSON,
      assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute() { return { ok: true }; },
      withPgClient: (fn) => fn({ query: async () => ({ rows: [{ client_id: CLIENT_ID }] }) }),
      listTenantLocations: async () => ({
        ok: true,
        value: [{ location_id: LOCATION, display_name: 'Sunset', active: true }],
      }),
      listTenantChannelEndpoints: async () => ({
        ok: true,
        value: [msEndpointRow()],
      }),
      loadPhaseBReauthEligibilityFacts: async () => ([atomicRow()]),
      loadMicrosoftEndpointLastSyncMap: async () => new Map(),
    });
    await routesAbsent.handleGet({ client: 'sunset' }, {}, resAbsent, { role: 'admin' });
    assert.strictEqual(resAbsent.status, 200);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(resAbsent.body.endpoints[0], 'last_sync'), false);
  });

  await test('GET never attaches last_sync to gmail endpoints', async () => {
    const res = response();
    const routes = createEmailSettingsRoutes({
      runtimeEnv: { SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true' },
      sendJSON,
      assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute() { return { ok: true }; },
      withPgClient: (fn) => fn({ query: async () => ({ rows: [{ client_id: CLIENT_ID }] }) }),
      listTenantLocations: async () => ({
        ok: true,
        value: [{ location_id: LOCATION, display_name: 'Sunset', active: true }],
      }),
      listTenantChannelEndpoints: async () => ({
        ok: true,
        value: [msEndpointRow(), gmailEndpointRow()],
      }),
      loadPhaseBReauthEligibilityFacts: async () => ([
        atomicRow(),
        atomicRow({
          endpoint_id: GMAIL_EP,
          provider: 'gmail_api',
          connector_mode: 'google_delegated_oauth',
          binding_status: 'unverified_offline',
          public_address: 'desk@gmail.example',
          grant_present: false,
          grant_status: null,
          reconcile_state: null,
          scope_version: null,
          grant_generation: null,
          has_active_lease: false,
          lease_token_null: true,
          lease_owner_null: true,
          lease_until_null: true,
        }),
      ]),
      // Hostile map that tries to stamp Gmail — DTO must still refuse.
      loadMicrosoftEndpointLastSyncMap: async () => new Map([
        [MS_EP, LAST_SYNC],
        [GMAIL_EP, LAST_SYNC],
      ]),
    });
    await routes.handleGet({ client: 'sunset' }, {}, res, { role: 'admin' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.endpoints.length, 2);
    const ms = res.body.endpoints.find((e) => e.provider === 'microsoft_graph');
    const gmail = res.body.endpoints.find((e) => e.provider === 'gmail_api');
    assert.ok(ms);
    assert.ok(gmail);
    assert.strictEqual(ms.last_sync, LAST_SYNC);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(gmail, 'last_sync'), false);
    assert.strictEqual(gmail.connection_state, 'registered_not_connected');
  });

  await test('loadMicrosoftEndpointLastSyncMap fail-soft and maps SQL rows', async () => {
    const empty = await loadMicrosoftEndpointLastSyncMap(null, CLIENT_ID);
    assert.ok(empty instanceof Map);
    assert.strictEqual(empty.size, 0);

    const boom = await loadMicrosoftEndpointLastSyncMap({
      query: async () => { throw new Error('db down'); },
    }, CLIENT_ID);
    assert.strictEqual(boom.size, 0);

    const pg = {
      query: async (sql, params) => {
        assert.strictEqual(params[0], CLIENT_ID);
        assert.ok(String(sql).includes('page_commit'));
        return {
          rows: [
            { endpoint_id: MS_EP, last_sync: LAST_SYNC },
            { endpoint_id: 'bad', last_sync: 'nope' },
            { endpoint_id: GMAIL_EP, last_sync: null },
          ],
        };
      },
    };
    const map = await loadMicrosoftEndpointLastSyncMap(pg, CLIENT_ID);
    assert.strictEqual(map.size, 1);
    assert.strictEqual(map.get(MS_EP), LAST_SYNC);
  });

  await test('file stay-off: no Inbox/draft/Horario collision in this slice', () => {
    const routesSrc = fs.readFileSync(
      path.join(__dirname, 'lib/staff-email-settings-routes.js'),
      'utf8',
    );
    assert.ok(!routesSrc.includes('inbox-thread'));
    assert.ok(!routesSrc.includes('email-inbound-inbox-bridge'));
    assert.ok(!routesSrc.includes('sunset-schedule-'));
    assert.ok(!routesSrc.includes('sunset-bookings-admin'));
    assert.ok(routesSrc.includes('SQL_MICROSOFT_ENDPOINT_LAST_SYNC'));
    assert.ok(routesSrc.includes('last_sync'));
  });

  console.log(`PASS EMAIL-LAST-SYNC-001 (${count} checks)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
