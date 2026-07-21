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

green('active_wolfhouse_ingress_frozen',
  callGraph.active_ingress.wolfhouse.meta_callback_url
    === 'https://lunabox.lunafrontdesk.com/whatsapp/webhook'
  && callGraph.active_ingress.wolfhouse.client_slug === 'wolfhouse-somo'
  && callGraph.active_ingress.wolfhouse.staff_app === 'wh-staging-staff-api');

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

green('instrumentation_points_complete',
  locks.REQUIRED_INSTRUMENTATION_POINTS.every((id) =>
    (design.minimum_instrumentation.points || []).some((p) => p.id === id)));

green('dry_run_hard_disabled_default',
  design.hard_disabled_dry_run_mode.default === 'hard_disabled'
  && Array.isArray(design.hard_disabled_dry_run_mode.suppressions)
  && design.hard_disabled_dry_run_mode.suppressions.length >= 4
  && /RADAR-16U-CORRELATION-DRY-RUN/.test(
    JSON.stringify(design.hard_disabled_dry_run_mode.activation_authority),
  ));

green('replaces_deferred_independent_probe_concept',
  /16T|independent same-id|same_id_probe/i.test(String(design.replaces_deferred || ''))
  && (design.evidence_schema_design.rejected_as_e2e || []).includes(
    'deferred_16t_style_multi_ingress_same_id_harness',
  ));

green('design_accepts_g01a_shape',
  locks.classifyEvidenceClaim({
    claim_class: 'g01a_meta_hermes_staff',
    single_trace_id: true,
    parent_event_id: 'wamid.EXAMPLE',
    causal_chain: true,
    mutation_performed: false,
  }).ok === true);

green('design_accepts_g01b_shape',
  locks.classifyEvidenceClaim({
    claim_class: 'g01b_stripe_business_join',
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

// --- Ledger / matrix ---
green('matrix_tip_16u',
  matrix.slice === locks.SLICE
  && matrix.branch === locks.BRANCH
  && matrix.master_basis === locks.MASTER_BASIS
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
  opsContract.slice === locks.SLICE
  && opsContract.selected_16u
  && opsContract.selected_16u.outcome_id === locks.OUTCOME_ID
  && /open|g01a/i.test(String(opsContract.correlation_drill || '')));

green('ledger_mentions_16u_design',
  /16U_correlation_design_freeze/.test(ledger)
  && /G01-A|meta_hermes_staff/i.test(ledger)
  && /independent same-id|same-ID probe/i.test(ledger)
  && /RADAR-16U-CORRELATION-DRY-RUN/.test(ledger)
  && /cannot be exercised without mutation/i.test(ledger));

green('findings_mentions_16u',
  /16U/.test(findings)
  && /design freeze|audit-only/i.test(findings)
  && /G01-A/i.test(findings));

green('branch_pin', currentBranch() === locks.BRANCH, currentBranch());

const rt = runtimePathsUnchanged();
green('runtime_paths_unchanged', rt.ok, rt.detail);

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
];
const requiredGreen = [
  'fixtures_present',
  'pins',
  'contract_pins',
  'active_wolfhouse_ingress_frozen',
  'hermes_no_x_request_id_today_cited',
  'staff_accepts_uuid_header_today',
  'staff_meta_not_active_path',
  'stripe_webhook_not_active_inbound',
  'stripe_cannot_without_mutation',
  'g01a_g01b_redefined',
  'instrumentation_points_complete',
  'dry_run_hard_disabled_default',
  'replaces_deferred_independent_probe_concept',
  'design_accepts_g01a_shape',
  'design_accepts_g01b_shape',
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
