'use strict';

/**
 * Meta WhatsApp ingress tenant shadow resolution gate.
 *
 * Fake payloads + sample routing IDs only. No network, no DB, no secrets.
 * Exit 0 on pass, nonzero on failure.
 */

const fs = require('fs');
const path = require('path');
const {
  loadChannelRoutingConfig,
  loadRuntimeChannelRoutingConfig,
  buildChannelResolver,
  loadClientRegistry,
} = require('./lib/client-channel-resolver');
const {
  DEFAULT_CLIENT_SLUG,
  normalizeMetaWhatsAppWebhook,
  resolveMetaWhatsAppTenantShadow,
  buildMetaWhatsAppWebhookPostResponse,
} = require('./lib/luna-meta-whatsapp-webhook');

const SAMPLE_CONFIG = loadChannelRoutingConfig();
const REGISTRY = loadClientRegistry();

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

function shadowOpts() {
  return {
    allowSampleFallback: true,
    channelConfig: SAMPLE_CONFIG,
    registry: REGISTRY,
    resolver: buildChannelResolver(REGISTRY, SAMPLE_CONFIG),
  };
}

function buildFakeMetaWhatsAppBody(phoneNumberId, opts = {}) {
  const from = opts.from || '34600000001';
  const text = opts.text || 'Hola';
  const waMessageId = opts.wa_message_id || 'wamid.SAMPLE_INBOUND_MSG';
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_SAMPLE_ENTRY',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: '15550000000',
            phone_number_id: phoneNumberId,
          },
          contacts: [{ profile: { name: 'Sample Guest' }, wa_id: from }],
          messages: [{
            from,
            id: waMessageId,
            timestamp: '1700000000',
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

function expectShadowResolved(name, shadow, expected) {
  ok(name, shadow
    && shadow.channel === 'whatsapp'
    && shadow.channel_identity_source === 'phone_number_id'
    && shadow.channel_resolution_blocked === false
    && shadow.client_slug === expected.client_slug
    && shadow.location_id === expected.location_id
    && shadow.routing_config_enabled === true, JSON.stringify(shadow));
}

console.log('verify:meta-whatsapp-tenant-shadow — Meta ingress shadow resolution\n');

const opts = shadowOpts();

// 1–5 WhatsApp sample phone_number_id → tenant shadow
const cases = [
  ['1 wolfhouse whatsapp shadow', 'WHATSAPP_PHONE_NUMBER_ID_WOLFHOUSE_SAMPLE', 'wolfhouse', 'wolfhouse-somo'],
  ['2 sunset somo whatsapp shadow', 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', 'sunset', 'sunset-somo'],
  ['3 elSardi whatsapp shadow', 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SARDINERO_SAMPLE', 'sunset', 'sunset-sardinero'],
  ['4 mirleft whatsapp shadow', 'WHATSAPP_PHONE_NUMBER_ID_MIRLEFT_SAMPLE', 'mirleft', 'mirleft-main'],
  ['5 lawave whatsapp shadow', 'WHATSAPP_PHONE_NUMBER_ID_LAWAVE_SAMPLE', 'lawave', 'lawave-main'],
];

for (const [label, phoneId, clientSlug, locationId] of cases) {
  const body = buildFakeMetaWhatsAppBody(phoneId);
  const normalized = normalizeMetaWhatsAppWebhook(body, opts);
  expectShadowResolved(label, normalized.tenant_channel_shadow, {
    client_slug: clientSlug,
    location_id: locationId,
  });
}

// 6 unknown phone_number_id blocked in shadow (legacy client_slug unchanged)
{
  const body = buildFakeMetaWhatsAppBody('UNKNOWN_META_PHONE_NUMBER_ID_SAMPLE');
  const normalized = normalizeMetaWhatsAppWebhook(body, opts);
  const shadow = normalized.tenant_channel_shadow;
  ok('6 unknown phone_number_id shadow blocked', shadow
    && shadow.channel_resolution_blocked === true
    && shadow.channel_resolution_reason === 'unknown_channel_identity'
    && shadow.client_slug == null
    && shadow.location_id == null);
  ok('6 legacy client_slug preserved on unknown', normalized.client_slug === DEFAULT_CLIENT_SLUG);
}

// 7 missing routing config — legacy-compatible, no crash
{
  const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_WOLFHOUSE_SAMPLE');
  const normalized = normalizeMetaWhatsAppWebhook(body, { env: {} });
  const shadow = normalized.tenant_channel_shadow;
  ok('7 missing routing config does not crash', !!normalized && !!shadow);
  ok('7 routing_config_enabled false when absent', shadow.routing_config_enabled === false);
  ok('7 shadow not blocked when routing absent', shadow.channel_resolution_blocked === false);
  ok('7 shadow reason routing_config_absent', shadow.channel_resolution_reason === 'routing_config_absent');
  ok('7 legacy client_slug still wolfhouse-somo default', normalized.client_slug === DEFAULT_CLIENT_SLUG);
}

// 8 unknown never defaults to wolfhouse in shadow client_slug
{
  const shadow = resolveMetaWhatsAppTenantShadow('UNKNOWN_META_PHONE_NUMBER_ID_SAMPLE', opts);
  ok('8 shadow client_slug null for unknown', shadow.client_slug == null);
  ok('8 shadow not wolfhouse tenant on unknown', shadow.client_slug !== 'wolfhouse');
}

function assertCommittedRoutingConfigSafe(filePath, label) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const ids = Object.keys(raw.whatsapp_phone_number_ids || {});
  const numericOnly = ids.filter((id) => /^\d{10,}$/.test(id));
  ok(`${label} uses non-numeric fake IDs only`, numericOnly.length === 0, numericOnly.join(', '));
  return ids;
}

// 9 sample IDs only (no numeric Meta IDs in test fixtures)
{
  const samplePath = path.join(__dirname, '..', 'config', 'clients', 'channel-routing.sample.json');
  const ids = assertCommittedRoutingConfigSafe(samplePath, '9 routing sample');
  const sampleLike = ids.filter((id) => /_SAMPLE$/i.test(id));
  ok('9 routing sample keys end with _SAMPLE', sampleLike.length === ids.length, ids.join(', '));
}

// 11 staging example template — REPLACE_WITH placeholders only
{
  const stagingExamplePath = path.join(__dirname, '..', 'config', 'clients', 'channel-routing.staging.example.json');
  const ids = assertCommittedRoutingConfigSafe(stagingExamplePath, '11 staging example');
  const placeholderKeys = ids.filter((id) => id.startsWith('REPLACE_WITH_'));
  ok('11 staging example keys are REPLACE_WITH placeholders', placeholderKeys.length === ids.length, ids.join(', '));
}

// 10 backward-compatible webhook API shape
{
  const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE');
  const normalized = normalizeMetaWhatsAppWebhook(body, opts);
  ok('10 normalized keeps client_slug field', typeof normalized.client_slug === 'string');
  ok('10 normalized keeps phone_number_id field', normalized.phone_number_id === 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE');
  ok('10 normalized keeps supported flag', normalized.supported === true);
  ok('10 adds tenant_channel_shadow without removing fields', !!normalized.tenant_channel_shadow);

  const response = buildMetaWhatsAppWebhookPostResponse(normalized, {}, { draft_called: false });
  ok('10 response envelope still has normalized', !!response.normalized);
  ok('10 response success unchanged', response.success === true && response.received === true);
}

// invalid routing JSON is explicit
let invalidJsonThrows = false;
try {
  loadRuntimeChannelRoutingConfig({
    env: { CLIENT_CHANNEL_ROUTING_JSON: '{not-json' },
  });
} catch (err) {
  invalidJsonThrows = /CLIENT_CHANNEL_ROUTING_JSON invalid/i.test(String(err.message));
}
ok('invalid CLIENT_CHANNEL_ROUTING_JSON throws explicit error', invalidJsonThrows);

console.log(`\n── meta-whatsapp-tenant-shadow: ${pass} passed, ${fail} failed ──`);
if (fail === 0) {
  console.log('verify:meta-whatsapp-tenant-shadow — ALL CHECKS PASSED');
}
process.exit(fail ? 1 : 0);
