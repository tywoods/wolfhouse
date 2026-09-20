'use strict';

const assert = require('assert');
const fs = require('fs');
const { getCrowsnestClients } = require('./lib/crowsnest/crowsnest-clients');
const {
  STATUS,
  deriveWhatsAppStatus,
  deriveEmailStatus,
  deriveStripeStatus,
  deriveLunaStatus,
  normalizeLunaEvidenceResponse,
  collectClientConnectionStatuses,
} = require('./lib/crowsnest/crowsnest-client-status');
const { buildStaffPaymentSummary } = require('./lib/staff-payment-summary');
const { authorizeCrowsnestStatusRead, buildStaffLunaStatusSummary } = require('./lib/staff-crowsnest-status-read');
const { resolveCrowsnestStaffStatusConfig, createCrowsnestStaffStatusReader } = require('./lib/crowsnest/crowsnest-staff-status-reader');
const { renderCrowsnestPage } = require('./lib/crowsnest/crowsnest-page');

async function main() {
  assert.deepEqual(STATUS, {
    CONFIGURED_TEST: 'Configured-test', OFF: 'Off', NOT_CONNECTED: 'Not connected',
    NEEDS_ATTENTION: 'Needs attention', UNKNOWN: 'Unknown',
    CONFIGURED_LIVE_UNKNOWN: 'Configured — live status unknown', CONFIGURED: 'Configured',
  });

  assert.equal(deriveWhatsAppStatus({ ok: true, route: { target_id: 'sunset' } }, 'sunset'), STATUS.CONFIGURED);
  assert.equal(deriveWhatsAppStatus({ ok: true, route: { target_id: 'wolfhouse' } }, 'sunset'), STATUS.NOT_CONNECTED);
  assert.equal(deriveWhatsAppStatus({ configured: false }), STATUS.NOT_CONNECTED);
  assert.equal(deriveWhatsAppStatus({ error: 'forbidden' }), STATUS.UNKNOWN);

  assert.equal(deriveEmailStatus({ endpoints: [{ active: true, binding_status: 'verified' }] }), STATUS.CONFIGURED);
  assert.equal(deriveEmailStatus({ endpoints: [{ grant_status: 'revoked' }] }), STATUS.NOT_CONNECTED);
  assert.equal(deriveEmailStatus({ endpoints: [{ active: true, binding_status: 'reauthorization_required' }] }), STATUS.NEEDS_ATTENTION);
  assert.equal(deriveEmailStatus(null), STATUS.UNKNOWN);

  assert.equal(deriveStripeStatus({ enabled: true, key_mode: 'test', verified: true }), STATUS.CONFIGURED_TEST);
  assert.equal(deriveStripeStatus({ enabled: false }), STATUS.OFF);
  assert.equal(deriveStripeStatus({ enabled: true, key_mode: 'test', verified: false }), STATUS.NEEDS_ATTENTION);
  assert.equal(deriveStripeStatus({ enabled: true, key_mode: 'live', verified: true }), STATUS.UNKNOWN);
  assert.equal(deriveStripeStatus(null), STATUS.UNKNOWN);

  assert.equal(deriveLunaStatus({ identity: true, routing: true, paused: false }), STATUS.CONFIGURED_LIVE_UNKNOWN);
  assert.equal(deriveLunaStatus({ revoked: true }), STATUS.NOT_CONNECTED);
  assert.equal(deriveLunaStatus({ identity: true, routing: false, paused: false }), STATUS.NEEDS_ATTENTION);
  assert.equal(deriveLunaStatus(null), STATUS.UNKNOWN);
  assert.equal(normalizeLunaEvidenceResponse({ success: false, error: 'status_unknown' }), null);
  assert.equal(normalizeLunaEvidenceResponse({ schema_version: 'staff.luna_status_summary.v1', identity_configured: true, routing_configured: true }), null);
  assert.deepEqual(normalizeLunaEvidenceResponse({ schema_version: 'staff.luna_status_summary.v1', identity_configured: true, routing_configured: true, paused: false }), { identity: true, routing: true, paused: false });

  assert.deepEqual(buildStaffPaymentSummary({ STRIPE_LINKS_ENABLED: 'false', STRIPE_SECRET_KEY: '***', STRIPE_MODE: 'test' }), {
    schema_version: 'staff.payment_summary.v1', enabled: false, key_mode: 'test', verified: false,
  });
  assert.deepEqual(buildStaffPaymentSummary({ STRIPE_LINKS_ENABLED: 'true', STRIPE_SECRET_KEY: '***', STRIPE_MODE: 'test', STRIPE_ACCOUNT_VERIFIED: 'true' }), {
    schema_version: 'staff.payment_summary.v1', enabled: true, key_mode: 'test', verified: true,
  });
  assert.ok(!JSON.stringify(buildStaffPaymentSummary(process.env)).includes('secret'));

  const statusToken = 'x'.repeat(32);
  assert.equal(authorizeCrowsnestStatusRead({ headers: { 'x-crowsnest-status-token': statusToken } }, { CROWSNEST_STATUS_READ_TOKEN: statusToken }), true);
  assert.equal(authorizeCrowsnestStatusRead({ headers: { 'x-crowsnest-status-token': 'wrong'.repeat(8) } }, { CROWSNEST_STATUS_READ_TOKEN: statusToken }), false);
  assert.deepEqual(await buildStaffLunaStatusSummary({
    clientSlug: 'sunset', identityConfigured: true, routingConfigured: true,
    readGlobalPause: async () => ({ row: null }),
  }), {
    schema_version: 'staff.luna_status_summary.v1', client_slug: 'sunset',
    identity_configured: true, routing_configured: true, paused: false,
  });

  const readerConfig = resolveCrowsnestStaffStatusConfig({
    CROWSNEST_SUNSET_STAGING_STAFF_ORIGIN: 'https://sunset-staging.lunafrontdesk.com',
    CROWSNEST_SUNSET_STAGING_STATUS_TOKEN: statusToken,
    CROWSNEST_WOLFHOUSE_LIVE_STAFF_ORIGIN: 'https://wolfhouse.lunafrontdesk.com',
    CROWSNEST_WOLFHOUSE_LIVE_STATUS_TOKEN: statusToken,
  });
  assert.deepEqual(readerConfig.origins, { sunset: { staging: 'https://sunset-staging.lunafrontdesk.com' } });
  let readerHeaders;
  const reader = createCrowsnestStaffStatusReader(readerConfig, async (_url, options) => {
    readerHeaders = options.headers;
    return { ok: true, json: async () => ({ ok: true }) };
  });
  assert.deepEqual(await reader('https://sunset-staging.lunafrontdesk.com/staff/admin/payment-summary?client=sunset'), { ok: true });
  assert.equal(readerHeaders['x-crowsnest-status-token'], statusToken);

  const crowsnestApiSource = fs.readFileSync(require.resolve('./crowsnest-api'), 'utf8');
  assert.match(crowsnestApiSource, /staffOrigins:\s*staffStatus\.origins/);
  assert.match(crowsnestApiSource, /requestJson:\s*createCrowsnestStaffStatusReader\(staffStatus\)/);
  const staffApiSource = fs.readFileSync(require.resolve('./staff-query-api'), 'utf8');
  assert.match(staffApiSource, /pathname === PAYMENT_SUMMARY_PATH/);
  assert.match(staffApiSource, /pathname === LUNA_STATUS_SUMMARY_PATH/);
  assert.match(staffApiSource, /authorizeCrowsnestStatusRead/);

  const calls = [];
  const statuses = await collectClientConnectionStatuses({
    clients: getCrowsnestClients(),
    readWhatsApp: async () => ({ configured: true, route: { client_slug: 'sunset' } }),
    readLunaEvidence: async (client, environment, whatsapp) => ({
      identity: client.client_slug === 'sunset',
      routing: whatsapp.route.client_slug === client.client_slug,
      paused: false,
      environment,
    }),
    requestJson: async (url) => {
      calls.push(url);
      if (url.includes('email-settings')) return { endpoints: [{ active: true, binding_status: 'verified' }] };
      if (url.includes('luna-status-summary')) return { schema_version: 'staff.luna_status_summary.v1', identity_configured: true, routing_configured: true, paused: false };
      return { enabled: true, key_mode: 'test', verified: true };
    },
    staffOrigins: { sunset: 'https://sunset-staging.lunafrontdesk.com' },
  });
  assert.ok(calls.every((url) => url.startsWith('https://sunset-staging.lunafrontdesk.com/staff/admin/')));
  assert.equal(statuses['sunset-somo'].staging.Email, STATUS.CONFIGURED);
  assert.equal(statuses['sunset-somo'].staging.Stripe, STATUS.CONFIGURED_TEST);
  assert.equal(statuses['wolfhouse-somo'].live.Email, STATUS.UNKNOWN);
  assert.equal(statuses['wolfhouse-somo'].staging.Email, STATUS.UNKNOWN);

  const html = renderCrowsnestPage({ view: 'clients', clientStatuses: statuses });
  for (const label of ['WhatsApp', 'Email', 'Stripe', 'Luna']) assert.ok(html.includes(`>${label}<`), label);
  assert.ok(html.indexOf('connection-chips') < html.indexOf('Staff portals'));
  assert.match(html, /Wolfhouse Somo[\s\S]*?Live connections[\s\S]*?Staging connections[\s\S]*?Staff portals/);
  assert.ok(!/Calendar|Microsoft Graph/.test(html));
  assert.ok(!/Create client|Onboard client|Client template/.test(html));

  console.log('verify:crowsnest-client-status-chips OK');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
