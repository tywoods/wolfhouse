'use strict';

/**
 * verify:radar-slice16v-capability-boundary-freeze — RADAR Slice 16V
 *
 * Offline RED/GREEN for audit-only central capability boundary freeze.
 * No network / live / runtime wiring.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16v-capability-boundary-freeze');

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

function needlesPresent(inventory) {
  const missing = [];
  for (const a of [
    ...(inventory.whatsapp_send_adapters || []),
    ...(inventory.mutation_adapters || []),
    ...(inventory.read_dispatch_adapters || []),
  ]) {
    const abs = path.join(ROOT, a.path);
    if (!fs.existsSync(abs)) {
      missing.push(`${a.adapter_id}:missing_file:${a.path}`);
      continue;
    }
    const text = fs.readFileSync(abs, 'utf8');
    if (!text.includes(a.source_needle)) {
      missing.push(`${a.adapter_id}:needle_absent:${a.source_needle}`);
    }
  }
  return missing;
}

console.log('RADAR 16V capability boundary freeze — offline verifier\n');

const design = readJson(locks.DESIGN_REL);
const inventory = readJson(locks.INVENTORY_REL);
const contract = readJson(locks.CONTRACT_REL);
const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
const opsContract = readJson('fixtures/radar-operations/contract.json');
const ledger = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
const findings = readText('fixtures/radar-operations/findings.md');
const design16u = readJson('fixtures/radar-operations/slice16u-correlation-design-freeze.json');
const callGraph16u = readJson('fixtures/radar-operations/slice16u-call-graph.json');

green('fixtures_present',
  fs.existsSync(path.join(ROOT, locks.DESIGN_REL))
  && fs.existsSync(path.join(ROOT, locks.INVENTORY_REL))
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
  && contract.this_slice_implements_runtime === false
  && contract.required_design_facts.whatsapp_send_count === 18
  && contract.required_design_facts.mutation_count === 23
  && contract.required_design_facts.read_dispatch_count === 15);

green('inventory_pins',
  inventory.slice === locks.SLICE
  && inventory.independently_pinned === true
  && inventory.complete === true
  && inventory.counts.whatsapp_send === 18
  && inventory.counts.mutation === 23
  && inventory.counts.read_dispatch === 15
  && inventory.counts.total === 56
  && inventory.whatsapp_send_adapters.length === 18
  && inventory.mutation_adapters.length === 23
  && inventory.read_dispatch_adapters.length === 15);

const invClass = locks.classifyInventoryDocument(inventory);
green('inventory_classifier_accepts', invClass.ok === true, JSON.stringify(invClass));

const needleMiss = needlesPresent(inventory);
green('inventory_source_needles_present', needleMiss.length === 0, needleMiss.slice(0, 8).join(' | '));

green('central_decision_point_frozen',
  design.central_capability_boundary.decision_point === locks.DECISION_POINT
  && design.central_capability_boundary.decision_before_acquisition === true
  && design.central_capability_boundary.unknown_adapters_deny === true
  && design.central_capability_boundary.denies_every_whatsapp_send === true
  && design.central_capability_boundary.denies_every_staff_db_stripe_mutation === true
  && design.central_capability_boundary.permits_real_read_dispatch === true
  && contract.required_design_facts.central_decision_point === locks.DECISION_POINT);

green('design_freeze_classifier_accepts',
  locks.classifyCapabilityBoundaryFreeze({
    central_decision_point: locks.DECISION_POINT,
    denies_every_whatsapp_send: true,
    denies_every_staff_db_stripe_mutation: true,
    permits_real_read_dispatch: true,
    unknown_adapters_deny: true,
    decision_before_acquisition: true,
    this_slice_implements_runtime: false,
    dry_run_implementable_today: false,
  }).ok === true);

green('decide_permits_read',
  (() => {
    const r = locks.decideCapability({
      adapter_id: 'hermes_post_bot_availability_check',
      effect: 'read_dispatch',
      inventory_class: 'read_dispatch',
      acquisition_already_held: false,
    });
    return r.ok && r.decision === 'permit';
  })());

green('decide_denies_whatsapp_send',
  (() => {
    const r = locks.decideCapability({
      adapter_id: 'hermes_whatsapp_cloud_text_send',
      effect: 'whatsapp_send',
      acquisition_already_held: false,
    });
    return r.ok && r.decision === 'deny';
  })());

green('decide_denies_mutation',
  (() => {
    const r = locks.decideCapability({
      adapter_id: 'hermes_post_bot_booking_create_from_plan',
      effect: 'mutation',
      acquisition_already_held: false,
    });
    return r.ok && r.decision === 'deny';
  })());

green('later_owner_specified_not_created',
  design.later_implementation_owner.primary.module === locks.LATER_OWNER_MODULE
  && design.later_implementation_owner.primary.symbol === locks.LATER_OWNER_SYMBOL
  && design.later_implementation_owner.primary.tests === locks.LATER_OWNER_TESTS
  && design.later_implementation_owner.staff_defense_in_depth.module
    === locks.LATER_STAFF_OWNER_MODULE
  && design.later_implementation_owner.separate_from_deployment_evidence === true
  && !fs.existsSync(path.join(ROOT, locks.LATER_OWNER_MODULE))
  && !fs.existsSync(path.join(ROOT, locks.LATER_STAFF_OWNER_MODULE)));

green('dry_run_still_not_implementable',
  design.dry_run_status.implementable_today === false
  && design.dry_run_status.audit_boundary_frozen === true
  && design.dry_run_status.blocked_on === 'capability_boundary_runtime_apply'
  && contract.required_design_facts.dry_run_implementable_today === false);

green('next_slice_runtime_apply',
  design.smallest_implementation_slice_after_freeze.id === locks.NEXT_SLICE_ID
  && contract.required_design_facts.next_slice === locks.NEXT_SLICE_ID);

green('preserved_16u_provenance',
  design.preserved_16u_provenance.g01a_boundary === locks.PRESERVED_16U_TRUTHS.g01a_boundary
  && design.preserved_16u_provenance.g01b_correlation_today
    === locks.PRESERVED_16U_TRUTHS.g01b_correlation_today
  && design.preserved_16u_provenance.burst_provenance
    === locks.PRESERVED_16U_TRUTHS.burst_provenance
  && design.preserved_16u_provenance.inbound_trace_wamid_propagation_today === false
  && design.preserved_16u_provenance.hermes_propagates_x_request_id_today === false
  && design.preserved_16u_provenance.g01_verdict === 'partial'
  && design16u.g01_boundary_redefinition.g01a_provable_target.id
    === locks.PRESERVED_16U_TRUTHS.g01a_boundary
  && callGraph16u.message_provenance.coalesced_sunset_burst.forbid_invented_single_parent === true
  && callGraph16u.live_caddy_authority.routes.some((r) =>
    r.path_prefix === '/whatsapp/*' && r.upstream === 'localhost:8092'));

green('required_categories_covered',
  locks.REQUIRED_SEND_CATEGORIES.every((c) =>
    inventory.whatsapp_send_adapters.some((a) => a.category === c))
  && locks.REQUIRED_MUTATION_CATEGORIES.every((c) =>
    inventory.mutation_adapters.some((a) => a.category === c)));

// --- RED ---
red('reject_omission',
  locks.classifyInventoryDocument({
    ...inventory,
    omits_known_reachable_adapter: true,
  }).ok === false);

red('reject_incomplete_inventory_flag',
  locks.classifyInventoryDocument({
    independently_pinned: true,
    complete: false,
    whatsapp_send_adapters: inventory.whatsapp_send_adapters,
    mutation_adapters: inventory.mutation_adapters,
    read_dispatch_adapters: inventory.read_dispatch_adapters,
  }).ok === false);

red('reject_duplicate_adapter_ids',
  locks.classifyInventoryDocument({
    independently_pinned: true,
    complete: true,
    whatsapp_send_adapters: [
      inventory.whatsapp_send_adapters[0],
      { ...inventory.whatsapp_send_adapters[0] },
    ],
    mutation_adapters: inventory.mutation_adapters,
    read_dispatch_adapters: inventory.read_dispatch_adapters,
  }).ok === false);

red('reject_dispersed_env_checks',
  locks.decideCapability({
    adapter_id: 'x',
    effect: 'whatsapp_send',
    dispersed_env_checks_as_sole_control: true,
  }).ok === false
  && locks.classifyCapabilityBoundaryFreeze({
    dispersed_env_checks_as_sole_control: true,
  }).ok === false
  && locks.classifyInventoryDocument({
    ...inventory,
    dispersed_env_checks_as_sole_control: true,
  }).ok === false);

red('reject_bypass',
  locks.decideCapability({
    adapter_id: 'hermes_whatsapp_cloud_text_send',
    effect: 'whatsapp_send',
    bypass_central_decision: true,
  }).ok === false);

red('reject_post_acquisition_denial',
  locks.decideCapability({
    adapter_id: 'hermes_whatsapp_cloud_text_send',
    effect: 'whatsapp_send',
    acquisition_already_held: true,
  }).ok === false
  && locks.classifyCapabilityBoundaryFreeze({
    post_acquisition_denial: true,
    central_decision_point: locks.DECISION_POINT,
    denies_every_whatsapp_send: true,
    denies_every_staff_db_stripe_mutation: true,
    permits_real_read_dispatch: true,
    unknown_adapters_deny: true,
    decision_before_acquisition: true,
  }).ok === false);

red('reject_mutable_capability_state',
  locks.decideCapability({
    adapter_id: 'hermes_whatsapp_cloud_text_send',
    effect: 'whatsapp_send',
    mutable_capability_state: true,
  }).ok === false);

red('reject_tenant_confusion',
  locks.decideCapability({
    adapter_id: 'hermes_whatsapp_cloud_text_send',
    effect: 'whatsapp_send',
    tenant_confusion: true,
  }).ok === false);

red('reject_unknown_adapter',
  locks.decideCapability({
    adapter_id: '',
    effect: 'unknown',
  }).ok === false
  && locks.decideCapability({
    effect: 'read_dispatch',
  }).decision !== 'permit');

red('reject_trace_deploy_live_overclaim',
  locks.decideCapability({
    adapter_id: 'hermes_post_bot_availability_check',
    effect: 'read_dispatch',
    inventory_class: 'read_dispatch',
    claims_trace_implemented: true,
  }).ok === false
  && locks.decideCapability({
    adapter_id: 'hermes_post_bot_availability_check',
    effect: 'read_dispatch',
    inventory_class: 'read_dispatch',
    claims_deploy: true,
  }).ok === false
  && locks.decideCapability({
    adapter_id: 'hermes_post_bot_availability_check',
    effect: 'read_dispatch',
    inventory_class: 'read_dispatch',
    claims_live_evidence: true,
  }).ok === false
  && locks.decideCapability({
    adapter_id: 'hermes_post_bot_availability_check',
    effect: 'read_dispatch',
    inventory_class: 'read_dispatch',
    claims_runtime_wired: true,
  }).ok === false);

red('reject_runtime_implemented_claim',
  locks.classifyCapabilityBoundaryFreeze({
    this_slice_implements_runtime: true,
    central_decision_point: locks.DECISION_POINT,
    denies_every_whatsapp_send: true,
    denies_every_staff_db_stripe_mutation: true,
    permits_real_read_dispatch: true,
    unknown_adapters_deny: true,
    decision_before_acquisition: true,
  }).ok === false);

red('reject_dry_run_implementable_today',
  locks.classifyCapabilityBoundaryFreeze({
    dry_run_implementable_today: true,
    central_decision_point: locks.DECISION_POINT,
    denies_every_whatsapp_send: true,
    denies_every_staff_db_stripe_mutation: true,
    permits_real_read_dispatch: true,
    unknown_adapters_deny: true,
    decision_before_acquisition: true,
  }).ok === false);

red('reject_missing_send_category',
  locks.classifyInventoryDocument({
    independently_pinned: true,
    complete: true,
    whatsapp_send_adapters: inventory.whatsapp_send_adapters.filter((a) => a.category !== 'queued'),
    mutation_adapters: inventory.mutation_adapters,
    read_dispatch_adapters: inventory.read_dispatch_adapters,
  }).ok === false);

// --- Ledger / matrix ---
green('matrix_tip_16v',
  matrix.slice === locks.SLICE
  && matrix.branch === locks.BRANCH
  && matrix.master_basis === locks.MASTER_BASIS
  && matrix.live_mutation === false);

green('matrix_g01_partial_preserved',
  (() => {
    const g01 = (matrix.gates || []).find((g) => g.id === locks.GATE_ID);
    return g01
      && g01.verdict === 'partial'
      && g01.progress_class === 'partial_live_proven'
      && /16V|capability boundary/i.test(g01.rationale)
      && /16U|provenance|design freeze/i.test(g01.rationale)
      && Array.isArray(g01.gaps)
      && g01.gaps.some((g) => /G01-A|Meta.*Hermes.*Staff|correlation/i.test(g));
  })());

green('matrix_16v_selection',
  matrix.slice_16v_selection
  && matrix.slice_16v_selection.selected === true
  && matrix.slice_16v_selection.outcome_id === locks.OUTCOME_ID
  && matrix.slice_16v_selection.progress_class === locks.PROGRESS_CLASS);

green('ops_contract_16v',
  opsContract.slice === locks.SLICE
  && opsContract.selected_16v
  && opsContract.selected_16v.outcome_id === locks.OUTCOME_ID
  && opsContract.selected_16u
  && opsContract.selected_16u.outcome_id === '16U_correlation_design_freeze');

green('ledger_mentions_16v',
  /16V_central_capability_boundary_audit_freeze|16V/.test(ledger)
  && /decideCapability|capability boundary/i.test(ledger)
  && /18/.test(ledger)
  && /23/.test(ledger)
  && /16U/.test(ledger)
  && /partial/i.test(ledger)
  && /not implement|runtime apply|not wired/i.test(ledger));

green('findings_mentions_16v',
  /16V/.test(findings)
  && /capability boundary/i.test(findings)
  && /decideCapability|adapter inventory/i.test(findings)
  && /16U/.test(findings));

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
  && pkg.scripts['verify:radar-slice16v-capability-boundary-freeze']
    === 'node scripts/verify-radar-slice16v-capability-boundary-freeze.js');

const requiredRed = [
  'reject_omission',
  'reject_incomplete_inventory_flag',
  'reject_duplicate_adapter_ids',
  'reject_dispersed_env_checks',
  'reject_bypass',
  'reject_post_acquisition_denial',
  'reject_mutable_capability_state',
  'reject_tenant_confusion',
  'reject_unknown_adapter',
  'reject_trace_deploy_live_overclaim',
  'reject_runtime_implemented_claim',
  'reject_dry_run_implementable_today',
  'reject_missing_send_category',
];
const requiredGreen = [
  'fixtures_present',
  'pins',
  'contract_pins',
  'inventory_pins',
  'inventory_classifier_accepts',
  'inventory_source_needles_present',
  'central_decision_point_frozen',
  'design_freeze_classifier_accepts',
  'decide_permits_read',
  'decide_denies_whatsapp_send',
  'decide_denies_mutation',
  'later_owner_specified_not_created',
  'dry_run_still_not_implementable',
  'next_slice_runtime_apply',
  'preserved_16u_provenance',
  'required_categories_covered',
  'matrix_tip_16v',
  'matrix_g01_partial_preserved',
  'matrix_16v_selection',
  'ops_contract_16v',
  'ledger_mentions_16v',
  'findings_mentions_16v',
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
console.log('RADAR 16V capability boundary freeze: PASS');
