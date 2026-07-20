'use strict';

/**
 * verify:fortress-slice15h-meta-ingress-authority-enforce — FORTRESS Slice 15H
 *
 * Offline RED/GREEN tests for Meta WhatsApp ingress authority policy (B02).
 * No network, no live DB/Stripe/WhatsApp/deploy. Does not rewrite tracked evidence.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'fortress-tenant-identity');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice15h-contract.json');
const OVERLAY_PATH = path.join(FIXTURE_DIR, 'slice15h-b02-remediation-overlay.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice15h-findings.md');
const EVIDENCE_PATH = path.join(FIXTURE_DIR, 'slice15h-evidence.json');
const MATRIX_PATH = path.join(FIXTURE_DIR, 'boundary-matrix.json');
const ATTACK_PATH = path.join(FIXTURE_DIR, 'attack-cases.json');
const DOC_PATH = path.join(ROOT, 'docs', 'FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md');
const RUNBOOK_PATH = path.join(ROOT, 'docs', 'MULTICLIENT-STAGING-ROUTING.md');

const {
  loadChannelRoutingConfig,
  buildChannelResolver,
  loadClientRegistry,
} = require('./lib/client-channel-resolver');
const {
  DEFAULT_CLIENT_SLUG,
  normalizeMetaWhatsAppWebhook,
  buildDraftInputFromNormalized,
  buildMetaWebhookSendBody,
  buildMetaInboundIdempotencyKey,
  resolveMetaWebhookSendKind,
  buildMetaWhatsAppWebhookPostResponse,
} = require('./lib/luna-meta-whatsapp-webhook');
const {
  processMetaWhatsAppWebhookInbound,
  processMetaWhatsAppWebhookPostEntry,
} = require('./lib/luna-meta-whatsapp-inbound-process');
const {
  AUTHORITY_ENV_KEY,
  isMetaWhatsAppIngressAuthorityEnabled,
  resolveMetaWhatsAppIngressAuthority,
  applyMetaWhatsAppIngressAuthority,
  shouldBlockMetaWhatsAppIngressDownstream,
  resolveReplayNormalizedIdentity,
  attachEffectiveNormalizedToError,
} = require('./lib/meta-whatsapp-ingress-authority');
const { buildInboundEventSeed } = require('./lib/luna-guest-message-events-sql');
const { buildOpenDemoRequestBodyFromMeta } = require('./lib/meta-open-demo-inbound-adapter');
const { buildOwnerSendBody } = require('./lib/luna-owner-whatsapp-inbound');
const { scanSecretFreeText } = require('./lib/fortress-tenant-identity-boundary');

/** Minimal eligible draft for real send-body builder proofs (no live draft LLM). */
function sampleEligibleDraft() {
  return {
    suggested_reply: 'Could you share your check-in date?',
    next_action: 'ask_missing_field',
    send_eligibility: {
      send_allowed_later: true,
      requires_staff: false,
      allowed_send_kind: 'ask_missing_field',
    },
  };
}

let pass = 0;
let fail = 0;
const redResults = [];
const greenResults = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  return false;
}

function red(id, cond, detail) {
  const passed = ok(`RED ${id}`, cond, detail);
  redResults.push({ id, ok: passed });
  return passed;
}

function green(id, cond, detail) {
  const passed = ok(`GREEN ${id}`, cond, detail);
  greenResults.push({ id, ok: passed });
  return passed;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const SAMPLE_CONFIG = loadChannelRoutingConfig();
const REGISTRY = loadClientRegistry();

function routingOpts(env) {
  return {
    env: env || {},
    allowSampleFallback: true,
    channelConfig: SAMPLE_CONFIG,
    registry: REGISTRY,
    resolver: buildChannelResolver(REGISTRY, SAMPLE_CONFIG),
  };
}

function buildFakeMetaWhatsAppBody(phoneNumberId, opts = {}) {
  const from = opts.from || '34600000001';
  const text = opts.text || 'Hola';
  const waMessageId = opts.wa_message_id || 'wamid.SAMPLE_15H_INBOUND';
  const metadata = {
    display_phone_number: '15550000000',
  };
  if (phoneNumberId !== undefined) {
    metadata.phone_number_id = phoneNumberId;
  }
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_SAMPLE_ENTRY_15G',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata,
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

function makeCountingPg() {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params: params || [] });
      throw new Error('15H zero-downstream: unexpected pg.query');
    },
  };
}

function makeEntryCounters() {
  return {
    pool: 0,
    inbound: 0,
    persist: 0,
    draft: 0,
    send: 0,
    owner: 0,
    demo: 0,
  };
}

function zeroDownstream(counters) {
  return counters.pool === 0
    && counters.inbound === 0
    && counters.persist === 0
    && counters.draft === 0
    && counters.send === 0
    && counters.owner === 0
    && counters.demo === 0;
}

async function runBlockedEntry(normalizedOrBody, opts = {}) {
  const counters = makeEntryCounters();
  const env = opts.env || { [AUTHORITY_ENV_KEY]: '1' };
  const entryInput = {
    env,
    signatureMeta: { verified: false, skipped: true },
    normalizeOptions: opts.normalizeOptions || routingOpts(env),
    withPgClient: async (fn) => {
      counters.pool += 1;
      return fn(makeCountingPg());
    },
    processInbound: async () => {
      counters.inbound += 1;
      counters.persist += 1;
      counters.draft += 1;
      counters.send += 1;
      counters.owner += 1;
      counters.demo += 1;
      throw new Error('15H entry: processInbound must not run when blocked');
    },
  };
  if (opts.normalized) {
    entryInput.normalized = opts.normalized;
  } else {
    entryInput.body = normalizedOrBody;
  }
  const result = await processMetaWhatsAppWebhookPostEntry(entryInput);
  return { result, counters };
}

console.log('verify:fortress-slice15h-meta-ingress-authority-enforce — FORTRESS Slice 15H\n');

console.log('── Artifacts ──');
const contract = readJson(CONTRACT_PATH);
const overlay = readJson(OVERLAY_PATH);
const findings = fs.readFileSync(FINDINGS_PATH, 'utf8');
const matrix = readJson(MATRIX_PATH);
const attacks = readJson(ATTACK_PATH);
const doc = fs.readFileSync(DOC_PATH, 'utf8');
const runbook = fs.readFileSync(RUNBOOK_PATH, 'utf8');
const committedEvidence = readJson(EVIDENCE_PATH);
const policySrc = fs.readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'meta-whatsapp-ingress-authority.js'),
  'utf8',
);
const webhookSrc = fs.readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'luna-meta-whatsapp-webhook.js'),
  'utf8',
);
const inboundSrc = fs.readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  'utf8',
);
const staffApi = fs.readFileSync(
  path.join(ROOT, 'scripts', 'staff-query-api.js'),
  'utf8',
);

ok('contract slice 15H + B02',
  contract.slice === 'FORTRESS-15H'
  && contract.boundary_id === 'B02_meta_normalize_live_client_slug'
  && contract.outcome_id === '15H_meta_ingress_authority_enforce_before_pg'
  && contract.live_mutation === false
  && contract.master_basis === '9a09f479f1a65fec45557cf2c94c5e9628b902dc'
  && contract.activation.default === 'off'
  && contract.activation.deployment_config_edited === false);
ok('overlay remediated B02 historical untouched',
  overlay.boundary_id === 'B02_meta_normalize_live_client_slug'
  && overlay.status === 'remediated_source_default_off'
  && overlay.historical_audit_unchanged === true
  && overlay.live_mutation === false
  && Array.isArray(overlay.historical_artifacts)
  && overlay.historical_artifacts.includes('fixtures/fortress-tenant-identity/boundary-matrix.json')
  && overlay.preserves_deferred_15g === true);
ok('findings cite B02 + default-off + activation gap + replay/error rules',
  /B02/.test(findings)
  && /default-off/i.test(findings)
  && /Activation gap/i.test(findings)
  && /META_WHATSAPP_INGRESS_AUTHORITY/.test(findings)
  && /REPLAY_IDENTITY_COMPARE_REJECT_FILL/.test(findings)
  && /ERROR_IDENTITY_STRUCTURED_EFFECTIVE_NORMALIZED/.test(findings)
  && /tenant-wide/i.test(findings));
ok('findings have no trailing whitespace', (() => {
  const lines = findings.split('\n');
  return lines.every((line) => line === line.replace(/\s+$/g, '') || line === '');
})());
ok('historical matrix still marks B02 vulnerable',
  (matrix.boundaries || []).some((b) => b.id === 'B02_meta_normalize_live_client_slug' && b.verdict === 'vulnerable'));
ok('historical attack cases retained for B02',
  (attacks.cases || []).some((c) => c.id === 'AC_WA_UNKNOWN_PHONE_NO_HARDBLOCK' && c.color === 'RED'));
ok('historical doc still cites B02 vulnerable',
  /B02/.test(doc) && /vulnerable/.test(doc));
ok('policy module has no hardcoded tenant slug literals',
  !/wolfhouse-somo/.test(policySrc)
  && !/'sunset'/.test(policySrc)
  && !/"sunset"/.test(policySrc)
  && !/'wolfhouse'/.test(policySrc));
ok('webhook + inbound wire authority module + replay/error helpers',
  /meta-whatsapp-ingress-authority/.test(webhookSrc)
  && /applyMetaWhatsAppIngressAuthority/.test(webhookSrc)
  && /shouldBlockMetaWhatsAppIngressDownstream/.test(inboundSrc)
  && /buildIngressAuthorityBlockedMetaResponse/.test(inboundSrc)
  && /processMetaWhatsAppWebhookPostEntry/.test(inboundSrc)
  && /resolveReplayNormalizedIdentity/.test(inboundSrc)
  && /attachEffectiveNormalizedToError/.test(inboundSrc)
  && /resolveReplayNormalizedIdentity/.test(policySrc));
ok('staff Meta POST uses entry before withPgClient + structured error audit', (() => {
  const idx = staffApi.indexOf('async function handleMetaWhatsAppWebhookPost');
  if (idx < 0) return false;
  const block = staffApi.slice(idx, idx + 3500);
  return /processMetaWhatsAppWebhookPostEntry/.test(block)
    && /FORTRESS 15H/.test(block)
    && /effective_normalized/.test(block)
    && !/await withPgClient\(\s*\(?\s*pg\s*\)?\s*=>\s*processMetaWhatsAppWebhookInbound/.test(block);
})());
ok('deferred 15G tip not an ancestor of this branch', (() => {
  const { execSync } = require('child_process');
  try {
    execSync('git merge-base --is-ancestor 50f87a1f115ef9ba0c06dc91cd3dfab59c3f7b2b HEAD', {
      cwd: ROOT,
      stdio: 'pipe',
    });
    return false;
  } catch (_) {
    return true;
  }
})());
ok('runbook documents 15H policy default-off + activation gap',
  /FORTRESS 15H|FORTRESS Slice 15H/.test(runbook)
  && /META_WHATSAPP_INGRESS_AUTHORITY/.test(runbook)
  && /default-off|default off/i.test(runbook));
ok('default authority disabled',
  isMetaWhatsAppIngressAuthorityEnabled({}) === false
  && isMetaWhatsAppIngressAuthorityEnabled({ [AUTHORITY_ENV_KEY]: '' }) === false
  && isMetaWhatsAppIngressAuthorityEnabled({ [AUTHORITY_ENV_KEY]: '0' }) === false
  && isMetaWhatsAppIngressAuthorityEnabled({ [AUTHORITY_ENV_KEY]: '1' }) === true);

console.log('\n── Policy RED/GREEN ──');

red('disabled_shadow_only_preserved', (() => {
  const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE');
  const normalized = normalizeMetaWhatsAppWebhook(body, routingOpts({}));
  const shadow = normalized.tenant_channel_shadow;
  return normalized.client_slug === DEFAULT_CLIENT_SLUG
    && normalized.location_id == null
    && normalized.ingress_authority == null
    && shadow
    && shadow.client_slug === 'sunset'
    && shadow.location_id === 'sunset-somo'
    && shadow.channel_resolution_blocked === false
    && shouldBlockMetaWhatsAppIngressDownstream(normalized) === false;
})());

red('unknown_phone_blocked', (() => {
  const body = buildFakeMetaWhatsAppBody('UNKNOWN_META_PHONE_NUMBER_ID_SAMPLE');
  const normalized = normalizeMetaWhatsAppWebhook(
    body,
    routingOpts({ [AUTHORITY_ENV_KEY]: '1' }),
  );
  const ia = normalized.ingress_authority;
  return ia
    && ia.enabled === true
    && ia.active === true
    && ia.blocked === true
    && ia.invoke_downstream === false
    && ia.reason === 'unknown_channel_identity'
    && shouldBlockMetaWhatsAppIngressDownstream(normalized) === true
    && normalized.client_slug === DEFAULT_CLIENT_SLUG;
})());

red('missing_phone_blocked', (() => {
  const body = buildFakeMetaWhatsAppBody(undefined);
  // Force missing metadata phone_number_id
  body.entry[0].changes[0].value.metadata = { display_phone_number: '15550000000' };
  const normalized = normalizeMetaWhatsAppWebhook(
    body,
    routingOpts({ [AUTHORITY_ENV_KEY]: 'true' }),
  );
  return normalized.ingress_authority
    && normalized.ingress_authority.blocked === true
    && normalized.ingress_authority.reason === 'missing_phone_number_id'
    && shouldBlockMetaWhatsAppIngressDownstream(normalized) === true;
})());

red('ambiguous_identity_blocked', (() => {
  const decision = resolveMetaWhatsAppIngressAuthority({
    client_slug: DEFAULT_CLIENT_SLUG,
    phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE',
    tenant_channel_shadow: {
      routing_config_enabled: true,
      channel_resolution_blocked: false,
      channel_resolution_reason: null,
      client_slug: 'sunset',
      location_id: null,
      phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE',
    },
  }, { env: { [AUTHORITY_ENV_KEY]: '1' } });
  return decision.ok === false
    && decision.blocked === true
    && decision.invoke_downstream === false
    && decision.reason === 'ambiguous_channel_identity';
})());

red('conflicting_identity_blocked', (() => {
  const decision = resolveMetaWhatsAppIngressAuthority({
    client_slug: DEFAULT_CLIENT_SLUG,
    phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE',
    tenant_channel_shadow: {
      routing_config_enabled: true,
      channel_resolution_blocked: false,
      channel_resolution_reason: 'stale_conflict_marker',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE',
    },
  }, { env: { [AUTHORITY_ENV_KEY]: '1' }, registry: REGISTRY });
  const registryConflict = resolveMetaWhatsAppIngressAuthority({
    client_slug: DEFAULT_CLIENT_SLUG,
    phone_number_id: 'PNID_BAD_OWNERSHIP',
    tenant_channel_shadow: {
      routing_config_enabled: true,
      channel_resolution_blocked: false,
      channel_resolution_reason: null,
      client_slug: 'sunset',
      location_id: 'wolfhouse-somo',
      phone_number_id: 'PNID_BAD_OWNERSHIP',
    },
  }, { env: { [AUTHORITY_ENV_KEY]: '1' }, registry: REGISTRY });
  return decision.reason === 'conflicting_channel_identity'
    && decision.blocked === true
    && registryConflict.reason === 'conflicting_channel_identity'
    && registryConflict.blocked === true;
})());

green('enabled_known_authoritative', (() => {
  const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE');
  const normalized = normalizeMetaWhatsAppWebhook(
    body,
    routingOpts({ [AUTHORITY_ENV_KEY]: '1' }),
  );
  const ia = normalized.ingress_authority;
  return normalized.client_slug === 'sunset'
    && normalized.location_id === 'sunset-somo'
    && ia
    && ia.active === true
    && ia.blocked === false
    && ia.reason === 'phone_number_id_authoritative'
    && ia.invoke_downstream === true
    && shouldBlockMetaWhatsAppIngressDownstream(normalized) === false;
})());

green('legacy_slug_conflict_resolver_wins', (() => {
  const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE');
  const normalized = normalizeMetaWhatsAppWebhook(body, {
    ...routingOpts({ [AUTHORITY_ENV_KEY]: 'on' }),
    client_slug: DEFAULT_CLIENT_SLUG,
  });
  return normalized.client_slug === 'sunset'
    && normalized.location_id === 'sunset-somo'
    && normalized.ingress_authority.legacy_client_slug === DEFAULT_CLIENT_SLUG
    && normalized.ingress_authority.legacy_slug_conflict === true
    && normalized.ingress_authority.reason === 'phone_number_id_authoritative';
})());

green('enabled_routing_absent_inactive', (() => {
  const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE');
  const normalized = normalizeMetaWhatsAppWebhook(body, {
    env: { [AUTHORITY_ENV_KEY]: '1' },
  });
  return normalized.client_slug === DEFAULT_CLIENT_SLUG
    && normalized.location_id == null
    && normalized.ingress_authority
    && normalized.ingress_authority.enabled === true
    && normalized.ingress_authority.active === false
    && normalized.ingress_authority.reason === 'authority_inactive_routing_absent'
    && shouldBlockMetaWhatsAppIngressDownstream(normalized) === false;
})());

green('default_off_no_env', (() => {
  const base = {
    client_slug: DEFAULT_CLIENT_SLUG,
    phone_number_id: 'x',
    tenant_channel_shadow: {
      routing_config_enabled: true,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    },
  };
  const applied = applyMetaWhatsAppIngressAuthority(base, { env: {} });
  return isMetaWhatsAppIngressAuthorityEnabled(undefined) === false
    && applied === base
    && applied.client_slug === DEFAULT_CLIENT_SLUG
    && applied.ingress_authority == null;
})());

green('real_builders_propagate_location_and_idempotency', (() => {
  const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
    wa_message_id: 'wamid.SAMPLE_15H_BUILDERS',
  });
  const normalized = normalizeMetaWhatsAppWebhook(
    body,
    routingOpts({ [AUTHORITY_ENV_KEY]: '1' }),
  );
  const draft = sampleEligibleDraft();
  const sendKind = resolveMetaWebhookSendKind(draft.next_action);
  const draftInput = buildDraftInputFromNormalized(normalized);
  const sendBody = buildMetaWebhookSendBody(normalized, draft, sendKind);
  const seed = buildInboundEventSeed(normalized, body);
  const expectedKey = 'luna:sunset:sunset-somo:wamid.SAMPLE_15H_BUILDERS:ask_missing_field';
  const response = buildMetaWhatsAppWebhookPostResponse(normalized, { verified: false, skipped: true }, {
    draft,
    draft_called: true,
    send_attempted: true,
    send_result: {
      send_performed: false,
      no_write_performed: true,
      blocked_reasons: ['luna_auto_send_not_enabled'],
    },
    idempotency_key: sendBody.idempotency_key,
    event_persisted: true,
  });
  return normalized.client_slug === 'sunset'
    && normalized.location_id === 'sunset-somo'
    && draftInput
    && draftInput.client_slug === 'sunset'
    && draftInput.location_id === 'sunset-somo'
    && sendBody.client_slug === 'sunset'
    && sendBody.location_id === 'sunset-somo'
    && sendBody.idempotency_key === expectedKey
    && buildMetaInboundIdempotencyKey(
      normalized.client_slug,
      normalized.wa_message_id,
      sendKind,
      normalized.location_id,
    ) === expectedKey
    && seed.client_slug === 'sunset'
    && seed.normalized.location_id === 'sunset-somo'
    && seed.normalized.client_slug === 'sunset'
    && response.normalized.client_slug === 'sunset'
    && response.normalized.location_id === 'sunset-somo'
    && response.idempotency_key === expectedKey
    && response.event_persisted === true;
})());

green('legacy_idempotency_key_unchanged_without_location', (() => {
  const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
    wa_message_id: 'wamid.SAMPLE_15H_LEGACY_KEY',
  });
  const normalized = normalizeMetaWhatsAppWebhook(body, routingOpts({}));
  const draft = sampleEligibleDraft();
  const sendKind = resolveMetaWebhookSendKind(draft.next_action);
  const draftInput = buildDraftInputFromNormalized(normalized);
  const sendBody = buildMetaWebhookSendBody(normalized, draft, sendKind);
  const legacyKey = `luna:${DEFAULT_CLIENT_SLUG}:wamid.SAMPLE_15H_LEGACY_KEY:ask_missing_field`;
  return normalized.location_id == null
    && draftInput
    && draftInput.client_slug === DEFAULT_CLIENT_SLUG
    && !Object.prototype.hasOwnProperty.call(draftInput, 'location_id')
    && sendBody.client_slug === DEFAULT_CLIENT_SLUG
    && !Object.prototype.hasOwnProperty.call(sendBody, 'location_id')
    && sendBody.idempotency_key === legacyKey
    && buildMetaInboundIdempotencyKey(
      DEFAULT_CLIENT_SLUG,
      'wamid.SAMPLE_15H_LEGACY_KEY',
      'ask_missing_field',
    ) === legacyKey
    && buildMetaInboundIdempotencyKey(
      DEFAULT_CLIENT_SLUG,
      'wamid.SAMPLE_15H_LEGACY_KEY',
      'ask_missing_field',
      null,
    ) === legacyKey
    && buildMetaInboundIdempotencyKey(
      DEFAULT_CLIENT_SLUG,
      'wamid.SAMPLE_15H_LEGACY_KEY',
      'ask_missing_field',
      '',
    ) === legacyKey;
})());

console.log('\n── Zero downstream on block + entry-point ──');

async function runEntryAndZeroDownstream() {
  const body = buildFakeMetaWhatsAppBody('UNKNOWN_META_PHONE_NUMBER_ID_SAMPLE', {
    wa_message_id: 'wamid.SAMPLE_15H_BLOCK',
  });
  const normalized = normalizeMetaWhatsAppWebhook(
    body,
    routingOpts({ [AUTHORITY_ENV_KEY]: '1' }),
  );
  const pg = makeCountingPg();
  const processed = await processMetaWhatsAppWebhookInbound({
    pg,
    env: { [AUTHORITY_ENV_KEY]: '1' },
    body,
    normalized,
    signatureMeta: { verified: false, skipped: true },
  });
  red('unknown_zero_downstream_calls',
    pg.queries.length === 0
    && processed.response.ingress_authority_blocked === true
    && processed.response.draft_called === false
    && processed.response.send_attempted === false
    && processed.response.event_persisted === false
    && processed.response.no_write_performed === true
    && processed.event_row == null
    && Array.isArray(processed.response.blocked_reasons)
    && processed.response.blocked_reasons.includes('unknown_channel_identity'));

  const unknownEntry = await runBlockedEntry(body, {
    env: { [AUTHORITY_ENV_KEY]: '1' },
  });
  red('entry_unknown_zero_pool',
    unknownEntry.result.acquired_pg === false
    && zeroDownstream(unknownEntry.counters)
    && unknownEntry.result.response.ingress_authority_blocked === true
    && unknownEntry.result.response.blocked_reasons.includes('unknown_channel_identity')
    && unknownEntry.result.response.draft_called === false
    && unknownEntry.result.response.send_attempted === false
    && unknownEntry.result.response.event_persisted === false
    && unknownEntry.result.response.no_write_performed === true);

  const missingBody = buildFakeMetaWhatsAppBody(undefined, {
    wa_message_id: 'wamid.SAMPLE_15H_MISSING',
  });
  missingBody.entry[0].changes[0].value.metadata = { display_phone_number: '15550000000' };
  const missingEntry = await runBlockedEntry(missingBody, {
    env: { [AUTHORITY_ENV_KEY]: '1' },
  });
  red('entry_missing_zero_pool',
    missingEntry.result.acquired_pg === false
    && zeroDownstream(missingEntry.counters)
    && missingEntry.result.response.ingress_authority_blocked === true
    && missingEntry.result.response.blocked_reasons.includes('missing_phone_number_id'));

  const conflictBase = normalizeMetaWhatsAppWebhook(
    buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_CONFLICT',
    }),
    routingOpts({ [AUTHORITY_ENV_KEY]: '1' }),
  );
  const conflictNormalized = applyMetaWhatsAppIngressAuthority({
    ...conflictBase,
    tenant_channel_shadow: {
      ...conflictBase.tenant_channel_shadow,
      channel_resolution_blocked: false,
      channel_resolution_reason: 'stale_conflict_marker',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    },
  }, { env: { [AUTHORITY_ENV_KEY]: '1' }, registry: REGISTRY });
  const conflictEntry = await runBlockedEntry(null, {
    env: { [AUTHORITY_ENV_KEY]: '1' },
    normalized: conflictNormalized,
  });
  red('entry_conflicting_zero_pool',
    conflictNormalized.ingress_authority
    && conflictNormalized.ingress_authority.reason === 'conflicting_channel_identity'
    && conflictEntry.result.acquired_pg === false
    && zeroDownstream(conflictEntry.counters)
    && conflictEntry.result.response.ingress_authority_blocked === true
    && conflictEntry.result.response.blocked_reasons.includes('conflicting_channel_identity'));

  const knownCounters = makeEntryCounters();
  let seenInbound = null;
  let realDraftInput = null;
  let realSendBody = null;
  let realPersistSeed = null;
  const knownBody = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
    wa_message_id: 'wamid.SAMPLE_15H_KNOWN',
  });
  const knownEnv = { [AUTHORITY_ENV_KEY]: '1' };
  const expectedKnownKey = 'luna:sunset:sunset-somo:wamid.SAMPLE_15H_KNOWN:ask_missing_field';
  const knownEntry = await processMetaWhatsAppWebhookPostEntry({
    body: knownBody,
    env: knownEnv,
    signatureMeta: { verified: false, skipped: true },
    normalizeOptions: routingOpts(knownEnv),
    withPgClient: async (fn) => {
      knownCounters.pool += 1;
      return fn({ query: async () => { knownCounters.persist += 1; return { rows: [] }; } });
    },
    processInbound: async (input) => {
      knownCounters.inbound += 1;
      seenInbound = input;
      // Real builders (same as runDraftAndSendGate / persistence seed path).
      realDraftInput = buildDraftInputFromNormalized(input.normalized);
      const draft = sampleEligibleDraft();
      const sendKind = resolveMetaWebhookSendKind(draft.next_action);
      realSendBody = buildMetaWebhookSendBody(input.normalized, draft, sendKind);
      realPersistSeed = buildInboundEventSeed(input.normalized, knownBody);
      knownCounters.persist += 1;
      knownCounters.draft += 1;
      knownCounters.send += 1;
      const response = buildMetaWhatsAppWebhookPostResponse(
        input.normalized,
        { verified: false, skipped: true },
        {
          draft,
          draft_called: true,
          send_attempted: true,
          send_result: {
            send_performed: false,
            no_write_performed: true,
            blocked_reasons: ['luna_auto_send_not_enabled'],
          },
          idempotency_key: realSendBody.idempotency_key,
          event_persisted: true,
        },
      );
      return {
        response: {
          ...response,
          draft_input: realDraftInput,
          send_input: realSendBody,
          persist_seed: realPersistSeed,
        },
        event_row: {
          client_slug: realPersistSeed.client_slug,
          normalized: realPersistSeed.normalized,
        },
        replay: false,
      };
    },
  });
  green('entry_enabled_known_reaches_downstream',
    knownEntry.acquired_pg === true
    && knownCounters.pool === 1
    && knownCounters.inbound === 1
    && knownCounters.persist === 1
    && knownCounters.draft === 1
    && knownCounters.send === 1
    && knownCounters.owner === 0
    && knownCounters.demo === 0
    && seenInbound
    && seenInbound.normalized.client_slug === 'sunset'
    && seenInbound.normalized.location_id === 'sunset-somo'
    && realDraftInput
    && realDraftInput.client_slug === 'sunset'
    && realDraftInput.location_id === 'sunset-somo'
    && realSendBody
    && realSendBody.client_slug === 'sunset'
    && realSendBody.location_id === 'sunset-somo'
    && realSendBody.idempotency_key === expectedKnownKey
    && realPersistSeed
    && realPersistSeed.client_slug === 'sunset'
    && realPersistSeed.normalized.location_id === 'sunset-somo'
    && knownEntry.response.normalized.client_slug === 'sunset'
    && knownEntry.response.normalized.location_id === 'sunset-somo'
    && knownEntry.response.draft_called === true
    && knownEntry.response.send_attempted === true
    && knownEntry.response.event_persisted === true
    && knownEntry.response.idempotency_key === expectedKnownKey
    && knownEntry.response.draft_input.location_id === 'sunset-somo'
    && knownEntry.response.send_input.location_id === 'sunset-somo'
    && knownEntry.event_row.client_slug === 'sunset'
    && knownEntry.event_row.normalized.location_id === 'sunset-somo');

  // Preserve default-off + enabled-without-routing: entry still acquires pg.
  const offCounters = makeEntryCounters();
  const offEntry = await processMetaWhatsAppWebhookPostEntry({
    body: buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_OFF',
    }),
    env: {},
    signatureMeta: { verified: false, skipped: true },
    normalizeOptions: routingOpts({}),
    withPgClient: async (fn) => {
      offCounters.pool += 1;
      return fn({});
    },
    processInbound: async (input) => {
      offCounters.inbound += 1;
      return {
        response: {
          client_slug: input.normalized.client_slug,
          ingress_authority: input.normalized.ingress_authority || null,
          draft_called: false,
          send_attempted: false,
        },
        event_row: null,
        replay: false,
      };
    },
  });
  green('entry_default_off_acquires_pg',
    offEntry.acquired_pg === true
    && offCounters.pool === 1
    && offCounters.inbound === 1
    && offEntry.normalized.ingress_authority == null
    && offEntry.response.client_slug === DEFAULT_CLIENT_SLUG
    && shouldBlockMetaWhatsAppIngressDownstream(offEntry.normalized) === false);

  const absentCounters = makeEntryCounters();
  const absentEntry = await processMetaWhatsAppWebhookPostEntry({
    body: buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_ABSENT',
    }),
    env: { [AUTHORITY_ENV_KEY]: '1' },
    signatureMeta: { verified: false, skipped: true },
    normalizeOptions: { env: { [AUTHORITY_ENV_KEY]: '1' } },
    withPgClient: async (fn) => {
      absentCounters.pool += 1;
      return fn({});
    },
    processInbound: async (input) => {
      absentCounters.inbound += 1;
      return {
        response: {
          client_slug: input.normalized.client_slug,
          reason: input.normalized.ingress_authority && input.normalized.ingress_authority.reason,
        },
        event_row: null,
        replay: false,
      };
    },
  });
  green('entry_enabled_routing_absent_acquires_pg',
    absentEntry.acquired_pg === true
    && absentCounters.pool === 1
    && absentCounters.inbound === 1
    && absentEntry.normalized.ingress_authority
    && absentEntry.normalized.ingress_authority.active === false
    && absentEntry.normalized.ingress_authority.reason === 'authority_inactive_routing_absent'
    && absentEntry.response.client_slug === DEFAULT_CLIENT_SLUG
    && shouldBlockMetaWhatsAppIngressDownstream(absentEntry.normalized) === false);

  // ── 15H expanded surfaces (replay / error / owner / open-demo / audit) ──
  red('replay_rejects_client_slug_conflict', (() => {
    const identity = resolveReplayNormalizedIdentity(
      { client_slug: 'wolfhouse-somo', location_id: null },
      { client_slug: 'sunset', location_id: 'sunset-somo' },
    );
    return identity.ok === false && identity.reason === 'replay_client_slug_conflict'
      && identity.history_rewritten === false;
  })());

  red('replay_rejects_location_conflict', (() => {
    const identity = resolveReplayNormalizedIdentity(
      { client_slug: 'sunset', location_id: 'sunset-sardinero' },
      { client_slug: 'sunset', location_id: 'sunset-somo' },
    );
    return identity.ok === false && identity.reason === 'replay_location_id_conflict';
  })());

  green('replay_fills_legacy_missing_location_without_history_rewrite', (() => {
    const identity = resolveReplayNormalizedIdentity(
      { client_slug: 'sunset', wa_message_id: 'wamid.LEGACY' },
      { client_slug: 'sunset', location_id: 'sunset-somo' },
    );
    return identity.ok === true
      && identity.history_rewritten === false
      && identity.filled_legacy_missing_location === true
      && identity.response_normalized.location_id === 'sunset-somo'
      && identity.response_normalized.client_slug === 'sunset';
  })());

  green('structured_error_carries_effective_normalized', (() => {
    const norm = { client_slug: 'sunset', location_id: 'sunset-somo', phone_number_id: 'x' };
    const err = attachEffectiveNormalizedToError(new Error('boom'), norm);
    return err instanceof Error
      && err.effective_normalized === norm
      && err.effective_normalized.client_slug === 'sunset'
      && err.effective_normalized.location_id === 'sunset-somo';
  })());

  green('open_demo_no_conflicting_hardcoded_when_authority_active', (() => {
    const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE', {
      wa_message_id: 'wamid.SAMPLE_15H_DEMO',
    });
    const normalized = normalizeMetaWhatsAppWebhook(
      body,
      routingOpts({ [AUTHORITY_ENV_KEY]: '1' }),
    );
    const demoBody = buildOpenDemoRequestBodyFromMeta(normalized);
    return normalized.client_slug === 'sunset'
      && normalized.location_id === 'sunset-somo'
      && demoBody.client_slug === 'sunset'
      && demoBody.location_id === 'sunset-somo'
      && demoBody.client_slug !== 'wolfhouse-somo';
  })());

  green('open_demo_legacy_fallback_when_authority_off', (() => {
    const demoBody = buildOpenDemoRequestBodyFromMeta({
      from: '34600000001',
      client_slug: '',
      wa_message_id: 'wamid.x',
      message_text: 'hi',
    });
    return demoBody.client_slug === 'wolfhouse-somo'
      && !Object.prototype.hasOwnProperty.call(demoBody, 'location_id');
  })());

  green('owner_send_propagates_location_tenant_wide_slug', (() => {
    const sendBody = buildOwnerSendBody(
      {
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        from: '34600000999',
        wa_message_id: 'wamid.SAMPLE_15H_OWNER',
      },
      {
        suggested_reply: 'Here is the answer.',
        send_eligibility: { send_allowed_later: true, requires_staff: false },
      },
    );
    const staffPhoneSrc = fs.readFileSync(
      path.join(ROOT, 'scripts', 'lib', 'staff-phone-access.js'),
      'utf8',
    );
    return sendBody.client_slug === 'sunset'
      && sendBody.location_id === 'sunset-somo'
      && sendBody.idempotency_key === 'luna:sunset:sunset-somo:wamid.SAMPLE_15H_OWNER:staff_reply'
      && /WHERE client_slug = \$1/.test(staffPhoneSrc)
      && !/location_id/.test(staffPhoneSrc.match(/async function lookupStaffPhoneAccess[\s\S]*?\n}/)[0] || '');
  })());

  green('postentry_returns_effective_normalized_for_audit', (() => {
    return knownEntry.normalized.client_slug === 'sunset'
      && knownEntry.normalized.location_id === 'sunset-somo'
      && knownEntry.normalized === seenInbound.normalized;
  })());

  red('authority_active_blocks_before_pg_on_unknown', (() => {
    return unknownEntry.result.acquired_pg === false
      && zeroDownstream(unknownEntry.counters);
  })());


}

console.log('\n── Secret-free + packaging ──');
const pkg = readJson(path.join(ROOT, 'package.json'));
ok('package.json has 15H verify script',
  pkg.scripts['verify:fortress-slice15h-meta-ingress-authority-enforce']
  === 'node scripts/verify-fortress-slice15h-meta-ingress-authority-enforce.js');

const secretScanTargets = [
  FINDINGS_PATH,
  CONTRACT_PATH,
  OVERLAY_PATH,
  path.join(ROOT, 'scripts', 'lib', 'meta-whatsapp-ingress-authority.js'),
  RUNBOOK_PATH,
];
let secretHits = 0;
for (const p of secretScanTargets) {
  const text = fs.readFileSync(p, 'utf8');
  secretHits += scanSecretFreeText(text).length;
}
ok('secret-free artifacts', secretHits === 0, `hits=${secretHits}`);

runEntryAndZeroDownstream().then(() => {
  console.log('\n── Evidence (read-only) ──');
  ok('evidence exists (not rewritten by verifier)', fs.existsSync(EVIDENCE_PATH));
  ok('evidence slice + activation gap',
    committedEvidence.slice === 'FORTRESS-15H'
    && committedEvidence.live_mutation === false
    && committedEvidence.activation_default === 'off'
    && committedEvidence.activation_gap
    && committedEvidence.activation_gap.runtime_enabled === false);

  const expectedRedIds = (contract.red_case_ids || []).map((id) => id.replace(/^RED_/, ''));
  const expectedGreenIds = (contract.green_case_ids || []).map((id) => id.replace(/^GREEN_/, ''));
  const runRedIds = redResults.map((r) => r.id);
  const runGreenIds = greenResults.map((r) => r.id);
  const evidenceRedIds = ((committedEvidence.red && committedEvidence.red.cases) || []).map((c) => c.id);
  const evidenceGreenIds = ((committedEvidence.green && committedEvidence.green.cases) || []).map((c) => c.id);

  ok('evidence RED ids match contract + this run',
    expectedRedIds.length === runRedIds.length
    && expectedRedIds.every((id, i) => id === runRedIds[i])
    && evidenceRedIds.length === runRedIds.length
    && evidenceRedIds.every((id, i) => id === runRedIds[i])
    && redResults.every((r) => r.ok)
    && ((committedEvidence.red && committedEvidence.red.cases) || []).every((c) => c.ok === true));

  ok('evidence GREEN ids match contract + this run',
    expectedGreenIds.length === runGreenIds.length
    && expectedGreenIds.every((id, i) => id === runGreenIds[i])
    && evidenceGreenIds.length === runGreenIds.length
    && evidenceGreenIds.every((id, i) => id === runGreenIds[i])
    && greenResults.every((r) => r.ok)
    && ((committedEvidence.green && committedEvidence.green.cases) || []).every((c) => c.ok === true));

  ok('verifier does not rewrite tracked evidence', (() => {
    const src = fs.readFileSync(__filename, 'utf8');
    const writeHits = src.match(/writeFileSync\s*\(\s*EVIDENCE_PATH/g) || [];
    return writeHits.length === 0;
  })());

  ok('red/green counts',
    evidenceRedIds.length === 12
    && evidenceGreenIds.length === 15
    && redResults.length === 12
    && greenResults.length === 15);

  console.log(`\n── Summary: pass=${pass} fail=${fail} ──`);
  if (fail > 0) process.exit(1);
  console.log('OK fortress-slice15h-meta-ingress-authority-enforce');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
