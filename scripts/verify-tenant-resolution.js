'use strict';

/**
 * Tenant/channel resolution gate — read-only spine verifier.
 *
 * Exercises scripts/lib/client-channel-resolver.js against
 * config/clients/channel-routing.sample.json and clients.json.
 *
 * Exit 0 on pass, nonzero on failure.
 */

const {
  loadClientRegistry,
  loadChannelRoutingConfig,
  buildChannelResolver,
  resolveInboundTenant,
  validateRouteAgainstRegistry,
} = require('./lib/client-channel-resolver');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name);
    if (detail) console.log(`        ${detail}`);
  }
}

function assertResolved(name, result, expected) {
  ok(name, !result.blocked
    && result.client_slug === expected.client_slug
    && result.location_id === expected.location_id
    && result.source === expected.source
    && result.confidence === 'exact', JSON.stringify(result));
}

function assertBlocked(name, result) {
  ok(name, result.blocked === true && result.reason === 'unknown_channel_identity', JSON.stringify(result));
}

console.log('verify:tenant-resolution — client-channel-resolver spine\n');

const registry = loadClientRegistry();
const channelConfig = loadChannelRoutingConfig();
const resolver = buildChannelResolver(registry, channelConfig);

// 1–5 WhatsApp samples
assertResolved('1 wolfhouse whatsapp → wolfhouse/wolfhouse-somo', resolveInboundTenant({
  channel: 'whatsapp',
  phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_WOLFHOUSE_SAMPLE',
}, { registry, resolver }), {
  client_slug: 'wolfhouse',
  location_id: 'wolfhouse-somo',
  source: 'phone_number_id',
});

assertResolved('2 sunset somo whatsapp → sunset/sunset-somo', resolveInboundTenant({
  channel: 'whatsapp',
  phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE',
}, { registry, resolver }), {
  client_slug: 'sunset',
  location_id: 'sunset-somo',
  source: 'phone_number_id',
});

assertResolved('3 elSardi whatsapp → sunset/sunset-sardinero', resolveInboundTenant({
  channel: 'whatsapp',
  phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SARDINERO_SAMPLE',
}, { registry, resolver }), {
  client_slug: 'sunset',
  location_id: 'sunset-sardinero',
  source: 'phone_number_id',
});

assertResolved('4 mirleft whatsapp → mirleft/mirleft-main', resolveInboundTenant({
  channel: 'whatsapp',
  phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_MIRLEFT_SAMPLE',
}, { registry, resolver }), {
  client_slug: 'mirleft',
  location_id: 'mirleft-main',
  source: 'phone_number_id',
});

assertResolved('5 lawave whatsapp → lawave/lawave-main', resolveInboundTenant({
  channel: 'whatsapp',
  phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_LAWAVE_SAMPLE',
}, { registry, resolver }), {
  client_slug: 'lawave',
  location_id: 'lawave-main',
  source: 'phone_number_id',
});

// 6–8 email samples
assertResolved('6 wolfhouse email → wolfhouse/wolfhouse-somo', resolveInboundTenant({
  channel: 'email',
  to: 'wolfhouse@example.invalid',
}, { registry, resolver }), {
  client_slug: 'wolfhouse',
  location_id: 'wolfhouse-somo',
  source: 'email_to',
});

assertResolved('7 sunset somo email → sunset/sunset-somo', resolveInboundTenant({
  channel: 'email',
  to: 'sunset-somo@example.invalid',
}, { registry, resolver }), {
  client_slug: 'sunset',
  location_id: 'sunset-somo',
  source: 'email_to',
});

assertResolved('8 elSardi email → sunset/sunset-sardinero', resolveInboundTenant({
  channel: 'email',
  to: 'elsardi@example.invalid',
}, { registry, resolver }), {
  client_slug: 'sunset',
  location_id: 'sunset-sardinero',
  source: 'email_to',
});

// 9–11 blocked unknowns
assertBlocked('9 unknown phone_number_id blocked', resolveInboundTenant({
  channel: 'whatsapp',
  phone_number_id: 'UNKNOWN_META_PHONE_NUMBER_ID_SAMPLE',
}, { registry, resolver }));

assertBlocked('10 unknown email destination blocked', resolveInboundTenant({
  channel: 'email',
  to: 'nobody@example.invalid',
}, { registry, resolver }));

assertBlocked('11 unsupported channel blocked', resolveInboundTenant({
  channel: 'sms',
  to: '+34000000000',
}, { registry, resolver }));

// 12 registry validation
let registryValidationThrows = false;
try {
  validateRouteAgainstRegistry(registry, {
    client_slug: 'not-a-client',
    location_id: 'wolfhouse-somo',
  }, 'test.invalid_client');
} catch (err) {
  registryValidationThrows = /unknown client_slug/i.test(String(err.message));
}
ok('12 rejects unknown client_slug against registry', registryValidationThrows);

let locationValidationThrows = false;
try {
  validateRouteAgainstRegistry(registry, {
    client_slug: 'wolfhouse',
    location_id: 'sunset-somo',
  }, 'test.wrong_location');
} catch (err) {
  locationValidationThrows = /does not belong/i.test(String(err.message));
}
ok('12b rejects location_id not owned by client', locationValidationThrows);

// 13 duplicate channel identities
let duplicateThrows = false;
try {
  buildChannelResolver(registry, {
    whatsapp_phone_number_ids: {
      DUP_SAMPLE_A: { client_slug: 'wolfhouse', location_id: 'wolfhouse-somo' },
      ' DUP_SAMPLE_A ': { client_slug: 'sunset', location_id: 'sunset-somo' },
    },
    email_to: {},
  });
} catch (err) {
  duplicateThrows = /duplicate channel identity/i.test(String(err.message));
}
ok('13 refuses duplicate whatsapp phone_number_id (trim-normalized)', duplicateThrows);

let duplicateEmailThrows = false;
try {
  buildChannelResolver(registry, {
    whatsapp_phone_number_ids: {},
    email_to: {
      'dup@example.invalid': { client_slug: 'wolfhouse', location_id: 'wolfhouse-somo' },
      'DUP@example.invalid': { client_slug: 'sunset', location_id: 'sunset-somo' },
    },
  });
} catch (err) {
  duplicateEmailThrows = /duplicate channel identity/i.test(String(err.message));
}
ok('13b refuses duplicate email_to (case-insensitive)', duplicateEmailThrows);

// 14 never wolfhouse fallback for unknown identity
const unknownWa = resolveInboundTenant({
  channel: 'whatsapp',
  phone_number_id: 'TOTALLY_UNKNOWN_WA_ID_SAMPLE',
}, { registry, resolver });
ok('14 unknown whatsapp is blocked (not wolfhouse)', unknownWa.blocked === true);
ok('14 unknown whatsapp has no client_slug', !unknownWa.client_slug);
ok('14 unknown whatsapp is not wolfhouse fallback', unknownWa.client_slug !== 'wolfhouse');

const unknownEmail = resolveInboundTenant({
  channel: 'email',
  to: 'unknown-inbox@example.invalid',
}, { registry, resolver });
ok('14b unknown email is blocked (not wolfhouse)', unknownEmail.blocked === true);
ok('14c unknown email is not wolfhouse fallback', unknownEmail.client_slug !== 'wolfhouse');

console.log(`\n── tenant-resolution: ${pass} passed, ${fail} failed ──`);
if (fail === 0) {
  console.log('verify:tenant-resolution — ALL CHECKS PASSED');
}
process.exit(fail ? 1 : 0);
