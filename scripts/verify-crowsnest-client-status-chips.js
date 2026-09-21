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
const {
  authorizeCrowsnestStatusRead,
  resolveCrowsnestStatusClientSlug,
  buildStaffLunaStatusSummary,
} = require('./lib/staff-crowsnest-status-read');
const { resolveCrowsnestStaffStatusConfig, createCrowsnestStaffStatusReader } = require('./lib/crowsnest/crowsnest-staff-status-reader');
const { renderCrowsnestPage } = require('./lib/crowsnest/crowsnest-page');

async function main() {
  assert.deepEqual(STATUS, {
    CONNECTED: 'Connected', NOT_CONNECTED: 'Not connected', UNKNOWN: 'Unknown',
  });

  assert.equal(deriveWhatsAppStatus({ ok: true, route: { target_id: 'sunset' } }, 'sunset'), STATUS.CONNECTED);
  assert.equal(deriveWhatsAppStatus({ ok: true, route: { target_luna: 'wolfhouse' } }, 'wolfhouse'), STATUS.CONNECTED);
  assert.equal(deriveWhatsAppStatus({ ok: true, route: { target_id: 'wolfhouse' } }, 'sunset'), STATUS.NOT_CONNECTED);
  assert.equal(deriveWhatsAppStatus({ configured: false }), STATUS.NOT_CONNECTED);
  assert.equal(deriveWhatsAppStatus({ error: 'forbidden' }), STATUS.UNKNOWN);

  assert.equal(deriveEmailStatus({ endpoints: [{ active: true, binding_status: 'verified' }] }), STATUS.CONNECTED);
  assert.equal(deriveEmailStatus({ endpoints: [{ grant_status: 'active', public_address: 'support@lunafrontdesk.com' }] }), STATUS.CONNECTED);
  assert.equal(deriveEmailStatus({ endpoints: [{ grant_status: 'revoked' }] }), STATUS.NOT_CONNECTED);
  assert.equal(deriveEmailStatus({ endpoints: [{ active: true, binding_status: 'reauthorization_required' }] }), STATUS.NOT_CONNECTED);
  assert.equal(deriveEmailStatus(null), STATUS.UNKNOWN);

  assert.equal(deriveStripeStatus({ enabled: true, key_mode: 'test', verified: true }), STATUS.CONNECTED);
  assert.equal(deriveStripeStatus({ enabled: false }), STATUS.NOT_CONNECTED);
  assert.equal(deriveStripeStatus({ enabled: true, key_mode: 'test', verified: false }), STATUS.NOT_CONNECTED);
  assert.equal(deriveStripeStatus({ enabled: true, key_mode: 'live', verified: true }), STATUS.CONNECTED);
  assert.equal(deriveStripeStatus(null), STATUS.UNKNOWN);

  assert.equal(deriveLunaStatus({ identity: true, routing: true, paused: false }), STATUS.CONNECTED);
  assert.equal(deriveLunaStatus({ identity: true, routing: true, paused: true }), STATUS.CONNECTED);
  assert.equal(deriveLunaStatus({ revoked: true }), STATUS.NOT_CONNECTED);
  assert.equal(deriveLunaStatus({ identity: true, routing: false, paused: false }), STATUS.NOT_CONNECTED);
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
  assert.equal(resolveCrowsnestStatusClientSlug({ DEFAULT_CLIENT_SLUG: 'sunset', STAFF_API_INGRESS_TENANT_SLUG: 'ignored' }), 'sunset');
  assert.equal(resolveCrowsnestStatusClientSlug({ STAFF_API_INGRESS_TENANT_SLUG: 'wolfhouse-somo' }), 'wolfhouse-somo');
  assert.equal(resolveCrowsnestStatusClientSlug({}), '');
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
  assert.equal((staffApiSource.match(/resolveCrowsnestStatusClientSlug\(process\.env\)/g) || []).length, 3);

  const calls = [];
  const statuses = await collectClientConnectionStatuses({
    clients: getCrowsnestClients(),
    readWhatsApp: async () => ({ configured: true, number_e164: '+346****9419', number_display: '+34 663 43 94 19', route: { client_slug: 'sunset' } }),
    readLunaEvidence: async (client, environment, whatsapp) => ({
      identity: client.client_slug === 'sunset',
      routing: whatsapp.route.client_slug === client.client_slug,
      paused: false,
      environment,
    }),
    requestJson: async (url) => {
      calls.push(url);
      if (url.includes('email-settings')) return { endpoints: [{ active: true, binding_status: 'verified', public_address: 'hello@sunsetsurfschool.com' }] };
      if (url.includes('luna-status-summary')) return { schema_version: 'staff.luna_status_summary.v1', identity_configured: true, routing_configured: true, paused: false };
      return { enabled: true, key_mode: 'test', verified: true };
    },
    staffOrigins: { sunset: 'https://sunset-staging.lunafrontdesk.com' },
  });
  assert.ok(calls.every((url) => url.startsWith('https://sunset-staging.lunafrontdesk.com/staff/admin/')));
  assert.equal(statuses['sunset-somo'].staging.Email, STATUS.CONNECTED);
  assert.equal(statuses['sunset-somo'].staging.EmailDetail, 'hello@sunsetsurfschool.com');
  assert.equal(statuses['sunset-somo'].staging.WhatsAppDetail, '+34 663 43 94 19');
  assert.equal(statuses['sunset-somo'].staging.WhatsApp, STATUS.CONNECTED);
  assert.equal(statuses['wolfhouse-somo'].staging.WhatsApp, STATUS.NOT_CONNECTED);
  assert.equal(statuses['wolfhouse-somo'].staging.WhatsAppDetail, '');
  assert.equal(statuses['sunset-somo'].staging.Stripe, STATUS.CONNECTED);
  assert.equal(statuses['wolfhouse-somo'].live.Email, STATUS.UNKNOWN);
  assert.equal(statuses['wolfhouse-somo'].staging.Email, STATUS.UNKNOWN);

  const wolfhouseStaffCalls = [];
  const wolfhouseStaffStatuses = await collectClientConnectionStatuses({
    clients: getCrowsnestClients(),
    requestJson: async (url) => {
      wolfhouseStaffCalls.push(url);
      if (url.includes('payment-summary')) return { enabled: true, key_mode: 'test', verified: true };
      if (url.includes('luna-status-summary')) return { schema_version: 'staff.luna_status_summary.v1', identity_configured: true, routing_configured: true, paused: false };
      return { error: 'not_found' };
    },
    staffOrigins: { 'wolfhouse-somo': { staging: 'https://staff-staging.lunafrontdesk.com' } },
  });
  assert.ok(wolfhouseStaffCalls.length === 3);
  assert.ok(wolfhouseStaffCalls.every((url) => url.endsWith('?client=wolfhouse-somo')));
  assert.equal(wolfhouseStaffStatuses['wolfhouse-somo'].staging.Stripe, STATUS.CONNECTED);
  assert.equal(wolfhouseStaffStatuses['wolfhouse-somo'].staging.Luna, STATUS.CONNECTED);

  const wolfhouseRoutedStatuses = await collectClientConnectionStatuses({
    clients: getCrowsnestClients(),
    readWhatsApp: async () => ({
      configured: true,
      number_e164: '+346****9419',
      number_display: '+34 663 43 94 19',
      route: { client_slug: 'wolfhouse' },
    }),
  });
  assert.equal(wolfhouseRoutedStatuses['wolfhouse-somo'].staging.WhatsApp, STATUS.CONNECTED);
  assert.equal(wolfhouseRoutedStatuses['wolfhouse-somo'].staging.WhatsAppDetail, '+34 663 43 94 19');
  assert.equal(wolfhouseRoutedStatuses['sunset-somo'].staging.WhatsApp, STATUS.NOT_CONNECTED);
  assert.equal(wolfhouseRoutedStatuses['sunset-somo'].staging.WhatsAppDetail, '');

  const unknownStatuses = await collectClientConnectionStatuses({
    clients: getCrowsnestClients(),
    readWhatsApp: async () => ({ denied: true, number_display: '+34 000 00 00 00' }),
    requestJson: async (url) => url.includes('email-settings')
      ? { denied: true, endpoints: [{ active: true, binding_status: 'verified', public_address: 'must-not-render@example.com' }] }
      : { denied: true },
    staffOrigins: { sunset: 'https://sunset-staging.lunafrontdesk.com' },
  });
  assert.equal(unknownStatuses['sunset-somo'].staging.WhatsApp, STATUS.UNKNOWN);
  assert.equal(unknownStatuses['sunset-somo'].staging.WhatsAppDetail, '');
  assert.equal(unknownStatuses['sunset-somo'].staging.Email, STATUS.UNKNOWN);
  assert.equal(unknownStatuses['sunset-somo'].staging.EmailDetail, '');
  const unknownHtml = renderCrowsnestPage({ view: 'clients', clientStatuses: unknownStatuses });
  assert.doesNotMatch(unknownHtml, /\+34 000 00 00 00|must-not-render@example\.com/);

  const malformedEmailStatuses = await collectClientConnectionStatuses({
    clients: getCrowsnestClients(),
    requestJson: async (url) => url.includes('email-settings')
      ? { endpoints: [{ active: true, binding_status: 'verified', public_address: 'not-an-email' }] }
      : { denied: true },
    staffOrigins: { sunset: 'https://sunset-staging.lunafrontdesk.com' },
  });
  assert.equal(malformedEmailStatuses['sunset-somo'].staging.Email, STATUS.CONNECTED);
  assert.equal(malformedEmailStatuses['sunset-somo'].staging.EmailDetail, '');
  assert.doesNotMatch(renderCrowsnestPage({ view: 'clients', clientStatuses: malformedEmailStatuses }), /not-an-email/);

  const html = renderCrowsnestPage({ view: 'clients', clientStatuses: statuses });
  for (const label of ['WhatsApp', 'Email', 'Stripe', 'Luna']) assert.ok(html.includes(`>${label}<`), label);
  assert.ok(html.indexOf('connection-chips') < html.indexOf('Staff portals'));
  assert.match(html, /Wolfhouse Somo[\s\S]*?Connections[\s\S]*?Staff portals/);
  assert.doesNotMatch(html, /Live connections|Staging connections/);
  assert.match(html, /hello@sunsetsurfschool\.com/);
  assert.match(html, /\+34 663 43 94 19/);
  assert.doesNotMatch(html, /Configured|Configured-test|Needs attention|live status unknown|>Off</);
  assert.doesNotMatch(html, /Production and staging staff portals are available\./);
  assert.match(html, /Sunset Somo[\s\S]*?Live[\s\S]*?https:\/\/sunset\.lunafrontdesk\.com/);
  assert.ok(!/Calendar|Microsoft Graph/.test(html));
  assert.ok(!/Create client|Onboard client|Client template/.test(html));

  function clientCard(page, name) {
    const cards = page.match(/<article class="card client-card">[\s\S]*?<\/article>/g) || [];
    return cards.find((card) => card.includes(name)) || '';
  }
  function envRow(card, label) {
    const rows = card.match(/<li class="env-row[^"]*">[\s\S]*?<\/li>/g) || [];
    return rows.find((row) => row.includes(`>${label}<`)) || '';
  }
  function connectionLabels(card) {
    const start = card.indexOf('connection-chips');
    const end = card.indexOf('env-section', start);
    const slice = card.slice(start, end > start ? end : start + 800);
    return [...slice.matchAll(/connection-chip-label">([^<]+)</g)].map((m) => m[1]);
  }

  for (const name of ['Wolfhouse Somo', 'Sunset Somo', 'Sunset Sardinero']) {
    assert.deepEqual(connectionLabels(clientCard(html, name)), ['Luna', 'WhatsApp', 'Email', 'Stripe'], name);
  }
  assert.match(html, /\.connection-chips\{[^}]*flex-direction:\s*column/);
  assert.ok(html.indexOf('>Staff staging<') < html.indexOf('>Staff production<'));

  const evidenced = renderCrowsnestPage({
    view: 'clients',
    portalEvidence: {
      'sunset-somo': { 'https://sunset-staging.lunafrontdesk.com': 'live' },
      'wolfhouse-somo': { 'https://wolfhouse.lunafrontdesk.com': 'live' },
    },
  });
  const sunsetStaging = envRow(clientCard(evidenced, 'Sunset Somo'), 'Staff staging');
  const sunsetProduction = envRow(clientCard(evidenced, 'Sunset Somo'), 'Staff production');
  const wolfhouseStaging = envRow(clientCard(evidenced, 'Wolfhouse Somo'), 'Staff staging');
  const wolfhouseProduction = envRow(clientCard(evidenced, 'Wolfhouse Somo'), 'Staff production');
  assert.match(sunsetStaging, /pill--success/);
  assert.match(sunsetStaging, />Live</);
  assert.match(sunsetStaging, /target="_blank" rel="noopener noreferrer"/);
  assert.match(sunsetProduction, />Unknown</);
  assert.doesNotMatch(sunsetProduction, /pill--success/);
  assert.match(wolfhouseProduction, /pill--success/);
  assert.match(wolfhouseProduction, />Live</);
  assert.match(wolfhouseStaging, />Unknown</);
  assert.doesNotMatch(wolfhouseStaging, />Live</);
  assert.match(sunsetStaging, />Staff staging</);
  assert.match(wolfhouseProduction, />Staff production</);

  const ignored = renderCrowsnestPage({
    view: 'clients',
    portalEvidence: {
      'sunset-somo': { 'https://sunset-staging.lunafrontdesk.com': 'healthy-looking' },
    },
  });
  const ignoredRow = envRow(clientCard(ignored, 'Sunset Somo'), 'Staff staging');
  assert.match(ignoredRow, />Unknown</);
  assert.doesNotMatch(ignoredRow, />Live</);
  assert.doesNotMatch(ignoredRow, /healthy-looking/);

  const pageOwner = fs.readFileSync(require.resolve('./lib/crowsnest/crowsnest-page'), 'utf8');
  const availabilityOwner = pageOwner.slice(
    pageOwner.indexOf('function renderEnvironmentRow'),
    pageOwner.indexOf('function renderConnectionGroup'),
  );
  assert.doesNotMatch(availabilityOwner, /\bfetch\s*\(|requestJson|http\.request/);

  console.log('verify:crowsnest-client-status-chips OK');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
