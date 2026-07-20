'use strict';

/**
 * verify:fortress-slice15g2-meta-authority-path-audit — FORTRESS Slice 15G2
 *
 * Read-only design freeze for B02 Meta POST authority path.
 * No network, no live DB/Stripe/WhatsApp/deploy. Does not change runtime
 * behavior and does not rewrite 15A historical artifacts.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'fortress-tenant-identity');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice15g2-contract.json');
const OVERLAY_PATH = path.join(FIXTURE_DIR, 'slice15g2-b02-design-overlay.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice15g2-findings.md');
const ATTACK_PATH = path.join(FIXTURE_DIR, 'slice15g2-attack-cases.json');
const BRANCH_PATH = path.join(FIXTURE_DIR, 'slice15g2-branch-matrix.json');
const EVIDENCE_PATH = path.join(FIXTURE_DIR, 'slice15g2-evidence.json');
const MATRIX_PATH = path.join(FIXTURE_DIR, 'boundary-matrix.json');
const HISTORICAL_ATTACK_PATH = path.join(FIXTURE_DIR, 'attack-cases.json');
const DOC_PATH = path.join(ROOT, 'docs', 'FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md');

const {
  loadChannelRoutingConfig,
  buildChannelResolver,
  loadClientRegistry,
  resolveWhatsAppTenantShadow,
} = require('./lib/client-channel-resolver');
const {
  DEFAULT_CLIENT_SLUG,
  normalizeMetaWhatsAppWebhook,
  buildDraftInputFromNormalized,
  buildMetaWebhookSendBody,
  buildMetaInboundIdempotencyKey,
} = require('./lib/luna-meta-whatsapp-webhook');
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

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

function buildFakeMetaWhatsAppBody(phoneNumberId, opts = {}) {
  const from = opts.from || '34600000001';
  const text = opts.text || 'Hola';
  const waMessageId = opts.wa_message_id || 'wamid.SAMPLE_15G2_INBOUND';
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

const SAMPLE_CONFIG = loadChannelRoutingConfig();
const REGISTRY = loadClientRegistry();

function shadowOpts() {
  return {
    allowSampleFallback: true,
    channelConfig: SAMPLE_CONFIG,
    registry: REGISTRY,
    resolver: buildChannelResolver(REGISTRY, SAMPLE_CONFIG),
  };
}

console.log('verify:fortress-slice15g2-meta-authority-path-audit — FORTRESS Slice 15G2\n');

console.log('── Artifacts ──');
const contract = readJson(CONTRACT_PATH);
const overlay = readJson(OVERLAY_PATH);
const findings = readText(FINDINGS_PATH);
const attacks = readJson(ATTACK_PATH);
const branches = readJson(BRANCH_PATH);
const matrix = readJson(MATRIX_PATH);
const historicalAttacks = readJson(HISTORICAL_ATTACK_PATH);
const doc = readText(DOC_PATH);
const staffApi = readText(path.join(ROOT, 'scripts', 'staff-query-api.js'));
const webhookSrc = readText(path.join(ROOT, 'scripts', 'lib', 'luna-meta-whatsapp-webhook.js'));
const inboundSrc = readText(path.join(ROOT, 'scripts', 'lib', 'luna-meta-whatsapp-inbound-process.js'));
const openDemoSrc = readText(path.join(ROOT, 'scripts', 'lib', 'meta-open-demo-inbound-adapter.js'));
const staffPhoneSrc = readText(path.join(ROOT, 'scripts', 'lib', 'staff-phone-access.js'));
const eventsSqlSrc = readText(path.join(ROOT, 'scripts', 'lib', 'luna-guest-message-events-sql.js'));
const authorityModulePath = path.join(ROOT, 'scripts', 'lib', 'meta-whatsapp-ingress-authority.js');
const committedEvidence = readJson(EVIDENCE_PATH);

const sourceByRelPath = {
  'scripts/staff-query-api.js': staffApi,
  'scripts/lib/luna-meta-whatsapp-webhook.js': webhookSrc,
  'scripts/lib/luna-meta-whatsapp-inbound-process.js': inboundSrc,
  'scripts/lib/meta-open-demo-inbound-adapter.js': openDemoSrc,
  'scripts/lib/staff-phone-access.js': staffPhoneSrc,
  'scripts/lib/luna-guest-message-events-sql.js': eventsSqlSrc,
};

ok('contract slice 15G2 design freeze',
  contract.slice === 'FORTRESS-15G2'
  && contract.boundary_id === 'B02_meta_normalize_live_client_slug'
  && contract.outcome_id === '15G2_meta_authority_path_design_freeze'
  && contract.status === 'design_frozen'
  && contract.live_mutation === false
  && contract.runtime_behavior_changed === false);

ok('overlay design_frozen + historical untouched',
  overlay.boundary_id === 'B02_meta_normalize_live_client_slug'
  && overlay.status === 'design_frozen'
  && overlay.historical_audit_unchanged === true
  && overlay.runtime_behavior_changed === false
  && Array.isArray(overlay.historical_artifacts)
  && overlay.historical_artifacts.includes('fixtures/fortress-tenant-identity/boundary-matrix.json'));

ok('findings cite shared owner + supersession + 15H + taxonomy',
  /processMetaWhatsAppWebhookPostEntry/.test(findings)
  && /before.*PG|before PostgreSQL|before_withPgClient|before `withPgClient`/i.test(findings)
  && /supersede|supersedes/i.test(findings)
  && /FORTRESS-15H|15H_meta_ingress/.test(findings)
  && /50f87a1/.test(findings)
  && /pre_normalize|pre-normalize/i.test(findings)
  && /post_normalize|post-normalize/i.test(findings)
  && /GUEST_MESSAGE_EVENT_TABLE_UNAVAILABLE|guest-message-event-table-unavailable/i.test(findings)
  && /tenant-wide/i.test(findings)
  && /source-anchor/i.test(findings));

ok('historical matrix still marks B02 vulnerable',
  (matrix.boundaries || []).some((b) => b.id === 'B02_meta_normalize_live_client_slug' && b.verdict === 'vulnerable'));

ok('historical 15A attack cases retained for B02',
  (historicalAttacks.cases || []).some((c) => c.id === 'AC_WA_SHADOW_SUNSET_LIVE_WOLFHOUSE' && c.color === 'RED'));

ok('historical doc still cites B02 vulnerable',
  /B02/.test(doc) && /vulnerable/.test(doc));

ok('no authority module on master tree (design-only slice)',
  !fs.existsSync(authorityModulePath));

ok('inbound has no PostEntry on master',
  !/processMetaWhatsAppWebhookPostEntry/.test(inboundSrc));

ok('contract supersedes deferred 15G tip',
  contract.supersedes
  && contract.supersedes.branch === 'fortress/slice-15g-meta-ingress-authority-policy'
  && contract.supersedes.tip_sha === '50f87a1f115ef9ba0c06dc91cd3dfab59c3f7b2b'
  && contract.supersedes.policy === 'do_not_merge_do_not_modify');

ok('replacement slice bounded to 15H',
  contract.replacement_implementation_slice
  && contract.replacement_implementation_slice.slice === 'FORTRESS-15H'
  && contract.replacement_implementation_slice.outcome_id === '15H_meta_ingress_authority_enforce_before_pg'
  && Array.isArray(contract.replacement_implementation_slice.acceptance_boundary.must_pass)
  && contract.replacement_implementation_slice.acceptance_boundary.must_pass.length >= 12);

ok('taxonomy separates pre vs post normalize ids',
  contract.taxonomy
  && Array.isArray(contract.taxonomy.pre_normalize_branch_ids)
  && Array.isArray(contract.taxonomy.post_normalize_branch_ids)
  && contract.taxonomy.pre_normalize_branch_ids.every((id) => /^BR_HTTP_ERROR_/.test(id))
  && !contract.taxonomy.post_normalize_branch_ids.some((id) => /^BR_HTTP_ERROR_/.test(id))
  && contract.taxonomy.post_normalize_branch_ids.includes('BR_GUEST_MESSAGE_EVENT_TABLE_UNAVAILABLE')
  && !contract.taxonomy.post_normalize_branch_ids.includes('BR_NO_PERSISTENCE_FALLBACK')
  && contract.taxonomy.completeness_method === 'source_anchor_driven');

ok('rename documented: no-persistence → guest-message-event-table-unavailable',
  (contract.taxonomy.renames || []).some((r) => r.from === 'BR_NO_PERSISTENCE_FALLBACK'
    && r.to === 'BR_GUEST_MESSAGE_EVENT_TABLE_UNAVAILABLE')
  && (branches.post_normalize_branches || []).some((b) => b.id === 'BR_GUEST_MESSAGE_EVENT_TABLE_UNAVAILABLE'
    && b.other_reads_writes_may_continue === true
    && Array.isArray(b.entry_points) && b.entry_points.length >= 2));

ok('owner read scope decision is tenant_wide',
  contract.owner_read_scope_decision
  && contract.owner_read_scope_decision.decision === 'tenant_wide'
  && contract.owner_read_scope_decision.not === 'location_scoped'
  && branches.owner_read_scope_decision
  && branches.owner_read_scope_decision.decision === 'tenant_wide');

ok('PostEntry must return effective normalized for audit',
  contract.shared_authority_owner
  && contract.shared_authority_owner.must_return_effective_normalized === true
  && branches.shared_authority_choke_point
  && branches.shared_authority_choke_point.must_return_effective_normalized === true);

ok('shared choke point named before_withPgClient',
  branches.shared_authority_choke_point
  && branches.shared_authority_choke_point.required_symbol === 'processMetaWhatsAppWebhookPostEntry'
  && branches.shared_authority_choke_point.enforcement === 'before_withPgClient'
  && branches.shared_authority_choke_point.present_on_master === false);

ok('attack fixture case count',
  Array.isArray(attacks.cases) && attacks.cases.length === 10);

console.log('\n── Source-anchor completeness ──');
const sourceAnchors = branches.source_anchors || [];
const postIds = (branches.post_normalize_branches || []).map((b) => b.id);
const preIds = (branches.pre_normalize_http_errors || []).map((b) => b.id);
const allBranchIds = new Set([...postIds, ...preIds]);
const missingAnchors = [];
const taxonomyMismatches = [];
for (const anchor of sourceAnchors) {
  const src = sourceByRelPath[anchor.path];
  if (!src || !anchor.pattern || !src.includes(anchor.pattern)) {
    missingAnchors.push(anchor.id);
  }
  if (!allBranchIds.has(anchor.branch_id)) {
    taxonomyMismatches.push(`${anchor.id}->${anchor.branch_id}`);
  }
  if (anchor.taxonomy === 'pre_normalize' && !preIds.includes(anchor.branch_id)) {
    taxonomyMismatches.push(`${anchor.id}:pre`);
  }
  if (anchor.taxonomy === 'post_normalize' && !postIds.includes(anchor.branch_id)) {
    taxonomyMismatches.push(`${anchor.id}:post`);
  }
}
ok('source anchors present in named source files',
  sourceAnchors.length >= 15 && missingAnchors.length === 0,
  missingAnchors.join(',') || `n=${sourceAnchors.length}`);
ok('source anchors map into taxonomy branch ids',
  taxonomyMismatches.length === 0,
  taxonomyMismatches.join(','));
ok('completeness method is source_anchor_driven (not self-authored list)',
  branches.completeness
  && branches.completeness.method === 'source_anchor_driven'
  && contract.taxonomy.completeness_method === 'source_anchor_driven');

console.log('\n── Master path audit (RED = current vulnerable posture) ──');

const handlerSlice = staffApi.slice(
  staffApi.indexOf('async function handleMetaWhatsAppWebhookPost'),
  staffApi.indexOf('async function handleStripeWebhook'),
);
const normalizeThenPg = /normalizeMetaWhatsAppWebhook\(body\)[\s\S]*?withPgClient\(\(pg\)\s*=>\s*processMetaWhatsAppWebhookInbound/.test(handlerSlice);
red('AC15G2_MASTER_PG_BEFORE_AUTHORITY',
  normalizeThenPg === true
  && !/processMetaWhatsAppWebhookPostEntry/.test(handlerSlice),
  'expected normalize→withPgClient and no PostEntry');

{
  const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_SUNSET_SOMO_SAMPLE');
  const normalized = normalizeMetaWhatsAppWebhook(body, shadowOpts());
  const shadow = normalized.tenant_channel_shadow || {};
  red('AC15G2_SHADOW_SUNSET_LIVE_DEFAULT',
    normalized.client_slug === DEFAULT_CLIENT_SLUG
    && normalized.client_slug === 'wolfhouse-somo'
    && normalized.location_id == null
    && shadow.client_slug === 'sunset'
    && shadow.location_id === 'sunset-somo',
    `live=${normalized.client_slug} loc=${normalized.location_id} shadow=${shadow.client_slug}/${shadow.location_id}`);
}

{
  const body = buildFakeMetaWhatsAppBody('WHATSAPP_PHONE_NUMBER_ID_UNKNOWN_SAMPLE');
  const normalized = normalizeMetaWhatsAppWebhook(body, shadowOpts());
  const shadow = normalized.tenant_channel_shadow || {};
  red('AC15G2_UNKNOWN_NO_HARDBLOCK',
    normalized.client_slug === 'wolfhouse-somo'
    && shadow.channel_resolution_blocked === true
    && !normalized.ingress_authority,
    `live=${normalized.client_slug} blocked=${shadow.channel_resolution_blocked}`);
}

{
  const draft = buildDraftInputFromNormalized({
    client_slug: 'wolfhouse-somo',
    from: '34600000001',
    message_text: 'Hola',
    wa_message_id: 'wamid.SAMPLE_15G2',
    supported: true,
    location_id: null,
    tenant_channel_shadow: { client_slug: 'sunset', location_id: 'sunset-somo' },
  });
  const sendBody = buildMetaWebhookSendBody(
    {
      client_slug: 'wolfhouse-somo',
      from: '34600000001',
      wa_message_id: 'wamid.SAMPLE_15G2',
      location_id: null,
    },
    {
      suggested_reply: 'Could you share your check-in date?',
      next_action: 'ask_missing_field',
      send_eligibility: {
        send_allowed_later: true,
        requires_staff: false,
        allowed_send_kind: 'ask_missing_field',
      },
    },
    'ask_missing_field',
  );
  const key = buildMetaInboundIdempotencyKey(
    'wolfhouse-somo',
    'wamid.SAMPLE_15G2',
    'ask_missing_field',
  );
  red('AC15G2_DRAFT_SEND_NO_LOCATION',
    draft && draft.location_id == null
    && sendBody.location_id == null
    && key === 'luna:wolfhouse-somo:wamid.SAMPLE_15G2:ask_missing_field'
    && !/location_id/.test(webhookSrc.match(/function buildDraftInputFromNormalized[\s\S]*?^}/m)[0] || ''),
    `draft.loc=${draft && draft.location_id} key=${key}`);
}

red('AC15G2_OPEN_DEMO_HARDCODED_FALLBACK',
  /client_slug:\s*trimStr\(n\.client_slug\)\s*\|\|\s*'wolfhouse-somo'/.test(openDemoSrc)
  || /trimStr\(n\.client_slug\) \|\| 'wolfhouse-somo'/.test(openDemoSrc),
  'open-demo fallback literal missing');

console.log('\n── Design contract (GREEN) ──');

green('AC15G2_SHARED_OWNER_NAMED',
  contract.shared_authority_owner
  && contract.shared_authority_owner.id === 'processMetaWhatsAppWebhookPostEntry'
  && contract.shared_authority_owner.must_return_effective_normalized === true
  && Array.isArray(contract.shared_authority_owner.enforcement_order)
  && contract.shared_authority_owner.enforcement_order.some((s) => /blocked/i.test(s))
  && contract.shared_authority_owner.enforcement_order.some((s) => /withPgClient/i.test(s))
  && (contract.taxonomy.post_normalize_branch_ids || []).includes('BR_GUEST_PERSIST_DRAFT_SEND')
  && (contract.taxonomy.post_normalize_branch_ids || []).includes('BR_OWNER_COMMAND_CENTER')
  && (contract.taxonomy.post_normalize_branch_ids || []).includes('BR_OPEN_DEMO')
  && (contract.taxonomy.post_normalize_branch_ids || []).includes('BR_TERMINAL_NO_DRAFT_SEND')
  && (contract.taxonomy.post_normalize_branch_ids || []).includes('BR_GUEST_MESSAGE_EVENT_TABLE_UNAVAILABLE'));

{
  const acc = contract.replacement_implementation_slice.acceptance_boundary;
  const mustPass = (acc.must_pass || []).join('\n');
  const mustNot = (acc.must_not || []).join('\n');
  green('AC15G2_REPLACEMENT_ACCEPTANCE_BOUNDED',
    /acquired_pg=false/.test(mustPass)
    && /location_id/.test(mustPass)
    && /default-off/.test(mustPass)
    && /HTTP audit/i.test(mustPass)
    && /owner lookup/i.test(mustPass)
    && /open-demo/i.test(mustPass)
    && /blocked-phone/i.test(mustPass)
    && /replay/i.test(mustPass)
    && /table_missing/i.test(mustPass)
    && /terminal no-draft/i.test(mustPass)
    && /tenant-wide/i.test(mustPass)
    && /merge deferred 15G/i.test(mustNot)
    && /acquire PG before authority/i.test(mustNot)
    && /location-scoped owner/i.test(mustNot)
    && /pre-authority normalized/i.test(mustNot)
    && (contract.replacement_implementation_slice.explicitly_excluded_from_15h || [])
      .some((x) => /activation/i.test(x)));
}

green('AC15G2_DEFERRED_15G_SUPERSEDED',
  overlay.supersedes_deferred
  && overlay.supersedes_deferred.tip_sha === '50f87a1f115ef9ba0c06dc91cd3dfab59c3f7b2b'
  && overlay.supersedes_deferred.policy === 'do_not_merge_do_not_modify'
  && contract.runtime_behavior_changed === false
  && !fs.existsSync(authorityModulePath));

{
  const shadow = resolveWhatsAppTenantShadow(
    { phone_number_id: 'WHATSAPP_PHONE_NUMBER_ID_UNKNOWN_SAMPLE' },
    shadowOpts(),
  );
  green('AC15G2_RESOLVER_STILL_FAIL_CLOSED',
    shadow.channel_resolution_blocked === true
    && shadow.channel_resolution_reason === 'unknown_channel_identity'
    && shadow.client_slug == null);
}

green('AC15G2_BRANCH_MATRIX_COMPLETE',
  missingAnchors.length === 0
  && taxonomyMismatches.length === 0
  && postIds.includes('BR_TERMINAL_NO_DRAFT_SEND')
  && postIds.includes('BR_UNPROCESSED_DUPLICATE_CONFLICT_CONTINUE')
  && postIds.includes('BR_OPEN_DEMO_VALIDATION_FAILURE')
  && postIds.includes('BR_PG_OR_DOWNSTREAM_ERROR')
  && postIds.includes('BR_GUEST_MESSAGE_EVENT_TABLE_UNAVAILABLE')
  && !postIds.includes('BR_NO_PERSISTENCE_FALLBACK')
  && preIds.every((id) => /^BR_HTTP_ERROR_/.test(id))
  && !postIds.some((id) => /^BR_HTTP_ERROR_/.test(id))
  && (branches.post_normalize_branches || []).every((b) => b.replacement_required
    && b.replacement_required.authority_gate_before_pg === true)
  && branches.owner_read_scope_decision.decision === 'tenant_wide'
  && (branches.authority_surface_map.http_audit || []).length >= 1
  && (branches.authority_surface_map.owner || []).length >= 1
  && (branches.authority_surface_map.open_demo || []).length >= 1
  && (branches.authority_surface_map.persistence || []).length >= 2
  && (branches.authority_surface_map.draft || []).length >= 1
  && (branches.authority_surface_map.send || []).length >= 1
  && (branches.authority_surface_map.idempotency || []).length >= 1
  && (branches.authority_surface_map.response || []).length >= 1);

console.log('\n── Source ownership anchors ──');
ok('staff handler owns Meta POST',
  /async function handleMetaWhatsAppWebhookPost/.test(staffApi)
  && /normalizeMetaWhatsAppWebhook\(body\)/.test(handlerSlice)
  && /processMetaWhatsAppWebhookInbound/.test(handlerSlice));
ok('inbound owns guest/owner/demo/gate/table-missing branches',
  /async function processWithoutPersistence/.test(inboundSrc)
  && /processOwnerWhatsAppCommandCenterInbound/.test(inboundSrc)
  && /shouldBlockMetaGuestInboundAfterOpenDemo/.test(inboundSrc)
  && /shouldRouteMetaInboundToOpenDemo/.test(inboundSrc)
  && /runDraftAndSendGate/.test(inboundSrc)
  && /isGuestMessageEventProcessed/.test(inboundSrc)
  && /existing\.table_missing/.test(inboundSrc)
  && /inserted\.table_missing/.test(inboundSrc)
  && /normalized\.supported && normalized\.message_text/.test(inboundSrc));
ok('open-demo validation failure path present',
  /if \(!validation\.ok\)/.test(openDemoSrc));
ok('unprocessed conflict path present in SQL',
  /ON CONFLICT \(client_slug, wa_message_id\) DO NOTHING/.test(eventsSqlSrc));
ok('webhook DEFAULT_CLIENT_SLUG remains wolfhouse-somo',
  /const DEFAULT_CLIENT_SLUG = 'wolfhouse-somo'/.test(webhookSrc));

console.log('\n── Secret-free + evidence ──');
const secretScanTargets = [
  findings,
  JSON.stringify(contract),
  JSON.stringify(attacks),
  JSON.stringify(branches),
  JSON.stringify(overlay),
];
let secretHits = 0;
for (const text of secretScanTargets) {
  const hits = scanSecretFreeText(text);
  if (hits && hits.length) secretHits += hits.length;
}
ok('artifacts secret-free', secretHits === 0, `hits=${secretHits}`);

ok('committed evidence matches slice + master basis',
  committedEvidence.slice === 'FORTRESS-15G2'
  && committedEvidence.master_basis === 'a684422903fec3093ac0bb7e13e50f674aec3b7a'
  && committedEvidence.live_mutation === false
  && committedEvidence.runtime_behavior_changed === false);

ok('committed evidence red/green totals',
  committedEvidence.red && committedEvidence.red.total === 5
  && committedEvidence.green && committedEvidence.green.total === 5);

const redOk = redResults.every((r) => r.ok) && redResults.length === 5;
const greenOk = greenResults.every((r) => r.ok) && greenResults.length === 5;
ok('all RED cases passed', redOk, `n=${redResults.length}`);
ok('all GREEN cases passed', greenOk, `n=${greenResults.length}`);

ok('attack case ids covered by verifier',
  (attacks.cases || []).every((c) => [...redResults, ...greenResults].some((r) => r.id === c.id)));

console.log(`\n── Summary: ${pass} pass / ${fail} fail ──`);
if (fail > 0) {
  process.exitCode = 1;
}
