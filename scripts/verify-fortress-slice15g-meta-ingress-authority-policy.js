'use strict';

/**
 * verify:fortress-slice15g-meta-ingress-authority-policy — FORTRESS Slice 15G
 *
 * Offline RED/GREEN tests for Meta WhatsApp ingress authority policy (B02).
 * No network, no live DB/Stripe/WhatsApp/deploy. Does not rewrite 15A artifacts.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'fortress-tenant-identity');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice15g-contract.json');
const OVERLAY_PATH = path.join(FIXTURE_DIR, 'slice15g-b02-remediation-overlay.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice15g-findings.md');
const EVIDENCE_PATH = path.join(FIXTURE_DIR, 'slice15g-evidence.json');
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
} = require('./lib/luna-meta-whatsapp-webhook');
const {
  processMetaWhatsAppWebhookInbound,
} = require('./lib/luna-meta-whatsapp-inbound-process');
const {
  AUTHORITY_ENV_KEY,
  isMetaWhatsAppIngressAuthorityEnabled,
  resolveMetaWhatsAppIngressAuthority,
  applyMetaWhatsAppIngressAuthority,
  shouldBlockMetaWhatsAppIngressDownstream,
} = require('./lib/meta-whatsapp-ingress-authority');
const { scanSecretFreeText } = require('./lib/fortress-tenant-identity-boundary');

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
  const waMessageId = opts.wa_message_id || 'wamid.SAMPLE_15G_INBOUND';
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
      throw new Error('15G zero-downstream: unexpected pg.query');
    },
  };
}

console.log('verify:fortress-slice15g-meta-ingress-authority-policy — FORTRESS Slice 15G\n');

console.log('── Artifacts ──');
const contract = readJson(CONTRACT_PATH);
const overlay = readJson(OVERLAY_PATH);
const findings = fs.readFileSync(FINDINGS_PATH, 'utf8');
const matrix = readJson(MATRIX_PATH);
const attacks = readJson(ATTACK_PATH);
const doc = fs.readFileSync(DOC_PATH, 'utf8');
const runbook = fs.readFileSync(RUNBOOK_PATH, 'utf8');
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

ok('contract slice 15G + B02',
  contract.slice === 'FORTRESS-15G'
  && contract.boundary_id === 'B02_meta_normalize_live_client_slug'
  && contract.outcome_id === '15G_meta_whatsapp_ingress_authority_policy'
  && contract.live_mutation === false
  && contract.master_basis === 'a684422903fec3093ac0bb7e13e50f674aec3b7a'
  && contract.activation.default === 'off'
  && contract.activation.deployment_config_edited === false);
ok('overlay remediated B02 historical untouched',
  overlay.boundary_id === 'B02_meta_normalize_live_client_slug'
  && overlay.status === 'remediated_source_default_off'
  && overlay.historical_audit_unchanged === true
  && overlay.live_mutation === false
  && Array.isArray(overlay.historical_artifacts)
  && overlay.historical_artifacts.includes('fixtures/fortress-tenant-identity/boundary-matrix.json'));
ok('findings cite B02 + default-off + activation gap',
  /B02/.test(findings)
  && /default-off/i.test(findings)
  && /Activation gap/i.test(findings)
  && /META_WHATSAPP_INGRESS_AUTHORITY/.test(findings));
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
ok('webhook + inbound wire authority module',
  /meta-whatsapp-ingress-authority/.test(webhookSrc)
  && /applyMetaWhatsAppIngressAuthority/.test(webhookSrc)
  && /shouldBlockMetaWhatsAppIngressDownstream/.test(inboundSrc)
  && /buildIngressAuthorityBlockedMetaResponse/.test(inboundSrc));
ok('runbook documents 15G policy default-off + activation gap',
  /FORTRESS Slice 15G|15G/.test(runbook)
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

console.log('\n── Zero downstream on block ──');

async function runZeroDownstream() {
  const body = buildFakeMetaWhatsAppBody('UNKNOWN_META_PHONE_NUMBER_ID_SAMPLE', {
    wa_message_id: 'wamid.SAMPLE_15G_BLOCK',
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
}

console.log('\n── Secret-free + packaging ──');
const pkg = readJson(path.join(ROOT, 'package.json'));
ok('package.json has 15G verify script',
  pkg.scripts['verify:fortress-slice15g-meta-ingress-authority-policy']
  === 'node scripts/verify-fortress-slice15g-meta-ingress-authority-policy.js');

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

runZeroDownstream().then(() => {
  const evidence = {
    schema_version: 1,
    slice: 'FORTRESS-15G',
    generated_at: new Date().toISOString(),
    master_basis: contract.master_basis,
    live_mutation: false,
    activation_default: 'off',
    red: {
      total: redResults.length,
      passed: redResults.filter((r) => r.ok).length,
      cases: redResults,
    },
    green: {
      total: greenResults.length,
      passed: greenResults.filter((r) => r.ok).length,
      cases: greenResults,
    },
    pass,
    fail,
    activation_gap: overlay.activation_gap,
  };
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  ok('evidence written', fs.existsSync(EVIDENCE_PATH));
  ok('red/green counts',
    evidence.red.total === 6
    && evidence.green.total === 4
    && evidence.red.passed === evidence.red.total
    && evidence.green.passed === evidence.green.total);

  console.log(`\n── Summary: pass=${pass} fail=${fail} ──`);
  if (fail > 0) process.exit(1);
  console.log('OK fortress-slice15g-meta-ingress-authority-policy');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
