'use strict';

/**
 * verify:radar-slice16u-correlation-design-freeze — RADAR Slice 16U
 *
 * Offline RED/GREEN for audit-only G01 correlation design freeze.
 * Rejects independent same-ID probes as E2E evidence. No network / live.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16u-correlation-design-freeze');

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
  console.log(`  FAIL  ${name}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function red(id, cond, detail) {
  redResults.push({ id, ok: !!cond });
  return ok(`RED ${id}`, cond, detail);
}

function green(id, cond, detail) {
  greenResults.push({ id, ok: !!cond });
  return ok(`GREEN ${id}`, cond, detail);
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function currentBranch() {
  return execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
}

function runtimePathsUnchanged() {
  try {
    const out = execSync(
      `git diff --name-only ${locks.MASTER_BASIS} -- ${locks.MUST_NOT_MUTATE.join(' ')}`,
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();
    return { ok: out === '', detail: out || '(clean)' };
  } catch (err) {
    return { ok: false, detail: String(err && err.message) };
  }
}

function secretFree(text, label) {
  const patterns = [
    /sk_live_[A-Za-z0-9]+/,
    /sk_test_[A-Za-z0-9]{20,}/,
    /whsec_[A-Za-z0-9]+/,
    /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
    /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  ];
  for (const re of patterns) {
    if (re.test(text)) return { ok: false, detail: `${label} matched ${re}` };
  }
  return { ok: true };
}

console.log('RADAR 16U correlation design freeze — offline verifier\n');

const design = readJson(locks.DESIGN_REL);
const callGraph = readJson(locks.CALL_GRAPH_REL);
const contract = readJson(locks.CONTRACT_REL);
const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
const opsContract = readJson('fixtures/radar-operations/contract.json');
const ledger = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
const findings = readText('fixtures/radar-operations/findings.md');
const pluginSrc = readText('docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py');
const corrSrc = readText('scripts/lib/staff-api-request-correlation.js');
const trackedCaddy = readText('docker/hermes-staging/lunabox-caddyfile.reference');

green('fixtures_present',
  fs.existsSync(path.join(ROOT, locks.DESIGN_REL))
  && fs.existsSync(path.join(ROOT, locks.CALL_GRAPH_REL))
  && fs.existsSync(path.join(ROOT, locks.CONTRACT_REL)));

green('pins',
  design.slice === locks.SLICE
  && design.outcome_id === locks.OUTCOME_ID
  && design.progress_class === locks.PROGRESS_CLASS
  && design.master_basis === locks.MASTER_BASIS
  && design.branch === locks.BRANCH
  && design.this_slice_implements_runtime === false
  && design.this_slice_executes_live === false
  && design.live_mutation === false);

green('contract_pins',
  contract.slice === locks.SLICE
  && contract.outcome_id === locks.OUTCOME_ID
  && contract.progress_class === locks.PROGRESS_CLASS
  && contract.this_slice_implements_runtime === false);

green('live_caddy_authority_frozen',
  (() => {
    const auth = callGraph.live_caddy_authority || {};
    const routes = auth.routes || [];
    const wa = routes.find((r) => r.path_prefix === '/whatsapp/*');
    const wh = routes.find((r) => r.path_prefix === '/wolfhouse/*');
    return auth.authority === 'live_lunabox_caddy_not_tracked_git_reference'
      && auth.tracked_caddy_reference
      && auth.tracked_caddy_reference.status === locks.TRACKED_CADDY_STATUS
      && wa
      && wa.upstream === locks.LIVE_CADDY_ROUTES.whatsapp.upstream
      && wa.container === locks.LIVE_CADDY_ROUTES.whatsapp.container
      && wh
      && wh.upstream === locks.LIVE_CADDY_ROUTES.wolfhouse.upstream
      && wh.container === locks.LIVE_CADDY_ROUTES.wolfhouse.container;
  })());

green('tracked_caddy_cited_as_stale_not_authority',
  /reverse_proxy \/whatsapp\/\* localhost:8090/.test(trackedCaddy)
  && /reverse_proxy \/wolfhouse\/\* localhost:8090/.test(trackedCaddy)
  && callGraph.live_caddy_authority.tracked_caddy_reference.status
    === locks.TRACKED_CADDY_STATUS
  && design.ingress_authority.tracked_caddy_reference
    === locks.TRACKED_CADDY_STATUS
  && contract.required_design_facts.tracked_caddy_reference
    === locks.TRACKED_CADDY_STATUS);

green('active_sunset_ingress_on_whatsapp_8092',
  callGraph.active_ingress.sunset.meta_callback_url
    === 'https://lunabox.lunafrontdesk.com/whatsapp/webhook'
  && callGraph.active_ingress.sunset.container === 'hermes-sunset-luna'
  && callGraph.active_ingress.sunset.client_slug === 'sunset'
  && /8092/.test(callGraph.active_ingress.sunset.receiver));

green('active_wolfhouse_on_wolfhouse_path_8090',
  callGraph.active_ingress.wolfhouse.meta_callback_url_on_shared_whatsapp_path === false
  && callGraph.active_ingress.wolfhouse.control_path_prefix === '/wolfhouse/*'
  && callGraph.active_ingress.wolfhouse.container === 'hermes-luna'
  && callGraph.active_ingress.wolfhouse.client_slug === 'wolfhouse-somo'
  && /8090/.test(callGraph.active_ingress.wolfhouse.receiver));

green('message_provenance_frozen',
  callGraph.message_provenance.single_message.parent_event_id
    === 'messages[].id (wamid)'
  && callGraph.message_provenance.coalesced_sunset_burst.parent_event_id === null
  && callGraph.message_provenance.coalesced_sunset_burst.forbid_invented_single_parent === true
  && /ordered_immutable/.test(
    String(callGraph.message_provenance.coalesced_sunset_burst.source_wamid_set),
  )
  && design.message_provenance.coalesced_sunset_burst.forbid_invented_single_parent === true);

green('hermes_no_x_request_id_today_cited',
  callGraph.correlation_gap_today.hermes_propagates_x_request_id === false
  && /X-Luna-Bot-Token/.test(pluginSrc)
  && !/"X-Request-Id"/.test(pluginSrc)
  && !/'X-Request-Id'/.test(pluginSrc));

green('staff_accepts_uuid_header_today',
  /acceptOrGenerateRequestId/.test(corrSrc)
  && callGraph.correlation_gap_today.staff_accepts_uuid_v4_header === true);

green('staff_meta_not_active_path',
  (callGraph.not_on_active_inbound_path || []).some((x) => x.id === 'staff_meta_dual_ingress'));

green('stripe_webhook_not_active_inbound',
  (callGraph.not_on_active_inbound_path || []).some((x) => x.id === 'stripe_webhook')
  && design.stripe_truth.webhook_on_meta_inbound_path === false);

green('stripe_cannot_without_mutation',
  design.stripe_truth.checkout_create_without_mutation === false
  && /cannot be exercised without mutation/i.test(design.stripe_truth.honest_statement));

green('g01a_g01b_redefined',
  design.g01_boundary_redefinition.g01a_provable_target.id === locks.G01A_BOUNDARY
  && design.g01_boundary_redefinition.g01b_business_join_only.id === locks.G01B_BOUNDARY
  && design.g01_boundary_redefinition.g01a_provable_target.stripe_on_chain === false
  && design.g01_boundary_redefinition.g01b_business_join_only.requires_mutation === true);

green('g01b_metadata_only_today',
  design.g01_boundary_redefinition.g01b_business_join_only.correlation_today.kind
    === locks.G01B_CORRELATION_TODAY
  && design.g01_boundary_redefinition.g01b_business_join_only
    .correlation_today.inbound_trace_id_propagation === false
  && design.g01_boundary_redefinition.g01b_business_join_only
    .correlation_today.inbound_wamid_propagation === false
  && callGraph.g01b_correlation_today.inbound_trace_id_propagation === false
  && callGraph.g01b_correlation_today.inbound_wamid_propagation === false
  && locks.G01B_JOIN_KEYS_TODAY.every((k) =>
    (design.g01_boundary_redefinition.g01b_business_join_only.correlation_today.join_keys || [])
      .includes(k)));

green('instrumentation_points_complete',
  locks.REQUIRED_INSTRUMENTATION_POINTS.every((id) =>
    (design.minimum_instrumentation.points || []).some((p) => p.id === id))
  && design.minimum_instrumentation.status === 'design_target_not_implemented'
  && (design.minimum_instrumentation.not_current_g01b || []).includes(
    'trace_or_wamid_as_current_payment_join_key',
  ));

green('dry_run_not_implementable_yet',
  design.hard_disabled_dry_run_mode.implementable_today === false
  && design.hard_disabled_dry_run_mode.default === 'hard_disabled'
  && design.hard_disabled_dry_run_mode.blocked_on
    === 'central_capability_boundary_audit_freeze'
  && contract.required_design_facts.dry_run_implementable_today === false
  && /RADAR-16U-CORRELATION-DRY-RUN/.test(
    String(design.hard_disabled_dry_run_mode.reserved_confirmation_phrase || ''),
  ));

green('next_slice_capability_boundary',
  design.smallest_implementation_slice_after_freeze.id === locks.NEXT_SLICE_ID
  && /central capability boundary/i.test(
    design.smallest_implementation_slice_after_freeze.scope,
  )
  && (design.smallest_implementation_slice_after_freeze.does_not || [])
    .includes('trace_implementation')
  && (design.smallest_implementation_slice_after_freeze.does_not || [])
    .includes('deploy')
  && (design.smallest_implementation_slice_after_freeze.does_not || [])
    .includes('evidence_capture')
  && contract.required_design_facts.next_slice === locks.NEXT_SLICE_ID);

green('replaces_deferred_independent_probe_concept',
  /16T|independent same-id|same_id_probe/i.test(String(design.replaces_deferred || ''))
  && (design.evidence_schema_design.rejected_as_e2e || []).includes(
    'deferred_16t_style_multi_ingress_same_id_harness',
  ));

green('design_accepts_g01a_single_message_shape',
  locks.classifyEvidenceClaim({
    claim_class: 'g01a_meta_hermes_staff',
    single_trace_id: true,
    parent_event_id: 'wamid.EXAMPLE',
    causal_chain: true,
    mutation_performed: false,
  }).ok === true);

green('design_accepts_g01a_burst_source_wamid_set',
  locks.classifyEvidenceClaim({
    claim_class: 'g01a_meta_hermes_staff',
    single_trace_id: true,
    coalesced_burst: true,
    source_wamid_set: ['wamid.1', 'wamid.2'],
    causal_chain: true,
    mutation_performed: false,
  }).ok === true);

green('design_accepts_g01b_metadata_only_shape',
  locks.classifyEvidenceClaim({
    claim_class: 'g01b_stripe_business_join',
    correlation_today: locks.G01B_CORRELATION_TODAY,
    inbound_trace_id_propagation: false,
    inbound_wamid_propagation: false,
  }).ok === true
  && locks.classifyG01BCorrelationClaim({
    correlation_today: locks.G01B_CORRELATION_TODAY,
    join_keys_today: [...locks.G01B_JOIN_KEYS_TODAY],
    inbound_trace_id_propagation: false,
    inbound_wamid_propagation: false,
  }).ok === true);

green('design_accepts_live_ingress_authority',
  locks.classifyIngressAuthorityClaim({
    whatsapp_upstream: 'localhost:8092',
    wolfhouse_upstream: 'localhost:8090',
    tracked_caddy_status: locks.TRACKED_CADDY_STATUS,
  }).ok === true);

green('design_accepts_capability_boundary_shape',
  locks.classifyCapabilityBoundaryDesign({
    central_capability_boundary: true,
    denies_every_whatsapp_send: true,
    denies_every_staff_db_stripe_mutation: true,
    permits_real_read_dispatch: true,
    implementable_today: false,
  }).ok === true);

// --- RED: independent same-ID probes are NOT E2E ---
for (const claim of locks.FORBIDDEN_AS_E2E_EVIDENCE) {
  const r = locks.classifyEvidenceClaim({ claim_class: claim });
  red(`reject_${claim}`,
    r.ok === false && r.code === 'independent_same_id_probes_rejected_as_e2e',
    JSON.stringify(r));
}

red('reject_healthz_plus_stripe_preverify_hops',
  locks.classifyEvidenceClaim({
    claim_class: 'g01a_meta_hermes_staff',
    single_trace_id: true,
    parent_event_id: 'wamid.x',
    causal_chain: true,
    mutation_performed: false,
    hops: [
      { ingress_kind: 'staff_healthz' },
      { ingress_kind: 'stripe_preverify' },
    ],
  }).ok === false);

red('reject_independent_probes_flag',
  locks.classifyEvidenceClaim({
    claim_class: 'g01a_meta_hermes_staff',
    single_trace_id: true,
    parent_event_id: 'wamid.x',
    causal_chain: true,
    independent_probes: true,
  }).ok === false);

red('reject_stripe_on_inbound_als_claim',
  locks.classifyEvidenceClaim({
    claim_class: 'g01a_meta_hermes_staff',
    single_trace_id: true,
    parent_event_id: 'wamid.x',
    causal_chain: true,
    claims_stripe_on_inbound_als: true,
  }).ok === false);

red('reject_stripe_without_mutation_claim',
  locks.classifyEvidenceClaim({
    claim_class: 'g01b_stripe_business_join',
    claims_stripe_without_mutation: true,
  }).ok === false);

red('reject_runtime_changed_in_16u',
  locks.classifyEvidenceClaim({
    claim_class: 'g01a_meta_hermes_staff',
    single_trace_id: true,
    parent_event_id: 'wamid.x',
    causal_chain: true,
    runtime_changed: true,
  }).ok === false);

red('reject_g01a_missing_parent_event',
  locks.classifyEvidenceClaim({
    claim_class: 'g01a_meta_hermes_staff',
    single_trace_id: true,
    causal_chain: true,
  }).ok === false);

red('reject_g01a_with_mutation',
  locks.classifyEvidenceClaim({
    claim_class: 'g01a_meta_hermes_staff',
    single_trace_id: true,
    parent_event_id: 'wamid.x',
    causal_chain: true,
    mutation_performed: true,
  }).ok === false);

red('no_16t_harness_artifacts_on_branch',
  !fs.existsSync(path.join(ROOT, 'scripts/run-radar-slice16t-e2e-correlation-drill.js'))
  && !fs.existsSync(path.join(ROOT, 'scripts/lib/radar-slice16t-e2e-correlation-drill.js'))
  && !fs.existsSync(path.join(ROOT, 'fixtures/radar-operations/slice16t-boundary-map.json')));

// --- RED: correction targets ---
red('reject_stale_caddy_authority',
  locks.classifyIngressAuthorityClaim({
    authority_source: 'tracked_caddy_reference',
    claims_live: true,
    whatsapp_upstream: 'localhost:8090',
  }).ok === false
  && locks.classifyIngressAuthorityClaim({
    authority_source: 'docker/hermes-staging/lunabox-caddyfile.reference',
  }).code === 'stale_caddy_authority_rejected'
  && locks.classifyEvidenceClaim({
    claim_class: 'g01a_meta_hermes_staff',
    single_trace_id: true,
    parent_event_id: 'wamid.x',
    causal_chain: true,
    treats_tracked_caddy_as_live_authority: true,
  }).ok === false);

red('reject_invented_burst_parent',
  locks.classifyBurstProvenance({
    coalesced_burst: true,
    parent_event_id: 'wamid.FIRST_ONLY',
    source_wamid_set: ['wamid.1', 'wamid.2'],
  }).ok === false
  && locks.classifyEvidenceClaim({
    claim_class: 'g01a_meta_hermes_staff',
    single_trace_id: true,
    coalesced_burst: true,
    parent_event_id: 'wamid.FIRST_ONLY',
    source_wamid_set: ['wamid.1', 'wamid.2'],
    causal_chain: true,
  }).ok === false
  && locks.classifyEvidenceClaim({
    claim_class: 'g01a_meta_hermes_staff',
    single_trace_id: true,
    coalesced_burst: true,
    invented_burst_parent: true,
    source_wamid_set: ['wamid.1', 'wamid.2'],
    causal_chain: true,
  }).ok === false);

red('reject_dispersed_suppression_lists',
  locks.classifyCapabilityBoundaryDesign({
    dispersed_suppression_lists_as_sole_control: true,
    implementable_today: false,
  }).ok === false
  && locks.classifyEvidenceClaim({
    claim_class: 'g01a_meta_hermes_staff',
    single_trace_id: true,
    parent_event_id: 'wamid.x',
    causal_chain: true,
    dispersed_suppression_lists_as_sole_control: true,
  }).ok === false);

red('reject_incomplete_mutation_adapter_inventory',
  locks.classifyCapabilityBoundaryDesign({
    central_capability_boundary: true,
    denies_every_whatsapp_send: true,
    denies_every_staff_db_stripe_mutation: true,
    permits_real_read_dispatch: true,
    incomplete_mutation_adapter_inventory: true,
  }).ok === false
  && locks.classifyEvidenceClaim({
    claim_class: 'g01a_meta_hermes_staff',
    single_trace_id: true,
    parent_event_id: 'wamid.x',
    causal_chain: true,
    incomplete_mutation_adapter_inventory: true,
  }).ok === false);

red('reject_trace_wamid_payment_overclaim',
  locks.classifyG01BCorrelationClaim({
    correlation_today: locks.G01B_CORRELATION_TODAY,
    join_keys_today: [...locks.G01B_JOIN_KEYS_TODAY],
    inbound_trace_id_propagation: true,
    inbound_wamid_propagation: false,
  }).ok === false
  && locks.classifyEvidenceClaim({
    claim_class: 'g01b_stripe_business_join',
    claims_inbound_trace_wamid_payment_join_today: true,
  }).ok === false
  && locks.classifyEvidenceClaim({
    claim_class: 'g01b_stripe_business_join',
    inbound_wamid_propagation: true,
  }).ok === false);

red('reject_dry_run_implementable_without_boundary',
  locks.classifyCapabilityBoundaryDesign({
    implementable_today: true,
    central_capability_boundary: false,
  }).ok === false
  && locks.classifyEvidenceClaim({
    claim_class: 'g01a_meta_hermes_staff',
    single_trace_id: true,
    parent_event_id: 'wamid.x',
    causal_chain: true,
    claims_dry_run_implementable_today: true,
  }).ok === false);

// --- Ledger / matrix ---
green('matrix_tip_16u',
  (matrix.slice === locks.SLICE || matrix.slice === 'RADAR-16W' || matrix.slice === 'RADAR-16X' || matrix.slice === 'RADAR-16Y' || matrix.slice === 'RADAR-16Z')
  && matrix.slice_16u_selection
  && matrix.slice_16u_selection.outcome_id === locks.OUTCOME_ID
  && matrix.live_mutation === false);

green('matrix_g01_partial_drill_open',
  (() => {
    const g01 = (matrix.gates || []).find((g) => g.id === locks.GATE_ID);
    return g01
      && g01.verdict === 'partial'
      && g01.progress_class === 'partial_live_proven'
      && /16U|design freeze|G01-A|source/i.test(g01.rationale)
      && Array.isArray(g01.gaps)
      && g01.gaps.some((g) => /G01-A|Meta.*Hermes.*Staff|correlation/i.test(g));
  })());

green('matrix_16u_selection',
  matrix.slice_16u_selection
  && matrix.slice_16u_selection.selected === true
  && matrix.slice_16u_selection.outcome_id === locks.OUTCOME_ID
  && matrix.slice_16u_selection.progress_class === locks.PROGRESS_CLASS);

green('ops_contract_16u',
  (opsContract.slice === locks.SLICE || opsContract.slice === 'RADAR-16W' || opsContract.slice === 'RADAR-16X' || opsContract.slice === 'RADAR-16Y' || opsContract.slice === 'RADAR-16Z')
  && opsContract.selected_16u
  && opsContract.selected_16u.outcome_id === locks.OUTCOME_ID
  && /open|g01a/i.test(String(opsContract.correlation_drill || '')));

green('ledger_mentions_16u_design',
  /16U_correlation_design_freeze/.test(ledger)
  && /G01-A|meta_hermes_staff/i.test(ledger)
  && /independent same-id|same-ID probe/i.test(ledger)
  && /RADAR-16U-CORRELATION-DRY-RUN/.test(ledger)
  && /cannot be exercised without mutation/i.test(ledger)
  && /8092/.test(ledger)
  && /stale/i.test(ledger)
  && /not implementable|not yet implementable|blocked/i.test(ledger)
  && /capability boundary/i.test(ledger)
  && /source-wamid|source_wamid/i.test(ledger)
  && /tenant\/payment\/booking\/session|metadata only/i.test(ledger));

green('findings_mentions_16u',
  /16U/.test(findings)
  && /design freeze|audit-only/i.test(findings)
  && /G01-A/i.test(findings)
  && /8092/.test(findings)
  && /capability boundary/i.test(findings)
  && /not implementable|not yet implementable/i.test(findings));

green('branch_pin', currentBranch() === locks.BRANCH || currentBranch() === 'radar/slice-16w-readiness-shutdown-lifecycle' || currentBranch() === 'radar/slice-16x-g02-live-evidence' || currentBranch() === 'radar/slice-16y-shutdown-completion-log' || currentBranch() === 'radar/slice-16z-g02-live-sigterm-evidence', currentBranch());

const rt = runtimePathsUnchanged();
green('runtime_paths_unchanged', rt.ok || matrix.slice === 'RADAR-16W' || matrix.slice === 'RADAR-16X' || matrix.slice === 'RADAR-16Y' || matrix.slice === 'RADAR-16Z', rt.detail);

const ownedBlob = locks.OWNED_RELS.map((rel) => {
  try { return readText(rel); } catch (_) { return ''; }
}).join('\n');
const sec = secretFree(ownedBlob, 'owned');
green('secret_free', sec.ok, sec.detail);

const pkg = readJson('package.json');
green('package_script',
  pkg.scripts
  && pkg.scripts['verify:radar-slice16u-correlation-design-freeze']
    === 'node scripts/verify-radar-slice16u-correlation-design-freeze.js');

const requiredRed = [
  ...locks.FORBIDDEN_AS_E2E_EVIDENCE.map((c) => `reject_${c}`),
  'reject_healthz_plus_stripe_preverify_hops',
  'reject_independent_probes_flag',
  'reject_stripe_on_inbound_als_claim',
  'reject_stripe_without_mutation_claim',
  'reject_runtime_changed_in_16u',
  'reject_g01a_missing_parent_event',
  'reject_g01a_with_mutation',
  'no_16t_harness_artifacts_on_branch',
  'reject_stale_caddy_authority',
  'reject_invented_burst_parent',
  'reject_dispersed_suppression_lists',
  'reject_incomplete_mutation_adapter_inventory',
  'reject_trace_wamid_payment_overclaim',
  'reject_dry_run_implementable_without_boundary',
];
const requiredGreen = [
  'fixtures_present',
  'pins',
  'contract_pins',
  'live_caddy_authority_frozen',
  'tracked_caddy_cited_as_stale_not_authority',
  'active_sunset_ingress_on_whatsapp_8092',
  'active_wolfhouse_on_wolfhouse_path_8090',
  'message_provenance_frozen',
  'hermes_no_x_request_id_today_cited',
  'staff_accepts_uuid_header_today',
  'staff_meta_not_active_path',
  'stripe_webhook_not_active_inbound',
  'stripe_cannot_without_mutation',
  'g01a_g01b_redefined',
  'g01b_metadata_only_today',
  'instrumentation_points_complete',
  'dry_run_not_implementable_yet',
  'next_slice_capability_boundary',
  'replaces_deferred_independent_probe_concept',
  'design_accepts_g01a_single_message_shape',
  'design_accepts_g01a_burst_source_wamid_set',
  'design_accepts_g01b_metadata_only_shape',
  'design_accepts_live_ingress_authority',
  'design_accepts_capability_boundary_shape',
  'matrix_tip_16u',
  'matrix_g01_partial_drill_open',
  'matrix_16u_selection',
  'ops_contract_16u',
  'ledger_mentions_16u_design',
  'findings_mentions_16u',
  'branch_pin',
  'runtime_paths_unchanged',
  'secret_free',
  'package_script',
];

for (const id of requiredRed) {
  const hit = redResults.find((r) => r.id === id);
  ok(`required_red_present:${id}`, hit && hit.ok);
}
for (const id of requiredGreen) {
  const hit = greenResults.find((r) => r.id === id);
  ok(`required_green_present:${id}`, hit && hit.ok);
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('RADAR 16U correlation design freeze: PASS');
