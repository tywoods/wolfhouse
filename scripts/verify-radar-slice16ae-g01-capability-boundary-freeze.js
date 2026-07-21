'use strict';

/**
 * verify:radar-slice16ae-g01-capability-boundary-freeze — RADAR Slice 16AE
 *
 * Offline RED/GREEN for audit-only central capability boundary freeze.
 * No network / live / runtime wiring.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16ae-g01-capability-boundary-freeze');

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

console.log('RADAR 16AE capability boundary freeze — offline verifier\n');

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

green('identity_rule_frozen',
  design.identity_rule
  && design.identity_rule.id === locks.IDENTITY_RULE.id
  && design.identity_rule.completeness_method === locks.IDENTITY_RULE.completeness_method
  && inventory.identity_rule_id === locks.IDENTITY_RULE.id
  && inventory.completeness_method === locks.IDENTITY_RULE.completeness_method
  && contract.required_design_facts.identity_rule_id === locks.IDENTITY_RULE.id
  && contract.required_design_facts.completeness_method
    === locks.IDENTITY_RULE.completeness_method);

green('contract_pins',
  contract.slice === locks.SLICE
  && contract.outcome_id === locks.OUTCOME_ID
  && contract.progress_class === locks.PROGRESS_CLASS
  && contract.this_slice_implements_runtime === false
  && contract.required_design_facts.whatsapp_send_count === locks.EXPECTED_COUNTS.whatsapp_send
  && contract.required_design_facts.mutation_count === locks.EXPECTED_COUNTS.mutation
  && contract.required_design_facts.read_dispatch_count === locks.EXPECTED_COUNTS.read_dispatch
  && contract.required_design_facts.total_count === locks.EXPECTED_COUNTS.total);

green('inventory_pins',
  inventory.slice === locks.SLICE
  && inventory.independently_pinned === true
  && inventory.completeness_method === locks.IDENTITY_RULE.completeness_method
  && inventory.complete !== true
  && inventory.counts.whatsapp_send === locks.EXPECTED_COUNTS.whatsapp_send
  && inventory.counts.mutation === locks.EXPECTED_COUNTS.mutation
  && inventory.counts.read_dispatch === locks.EXPECTED_COUNTS.read_dispatch
  && inventory.counts.total === locks.EXPECTED_COUNTS.total
  && inventory.whatsapp_send_adapters.length === locks.EXPECTED_COUNTS.whatsapp_send
  && inventory.mutation_adapters.length === locks.EXPECTED_COUNTS.mutation
  && inventory.read_dispatch_adapters.length === locks.EXPECTED_COUNTS.read_dispatch);

const invClass = locks.classifyInventoryDocument(inventory, ROOT);
green('inventory_classifier_accepts', invClass.ok === true, JSON.stringify(invClass));

const exact = locks.compareInventoryExactSet(inventory, ROOT);
green('source_derived_exact_set', exact.ok === true, JSON.stringify(exact));

green('bidirectional_exact_set',
  (() => {
    const d = locks.deriveExpectedAdapterIdsFromSource(ROOT);
    if (!d.ok) return false;
    const sends = inventory.whatsapp_send_adapters.map((a) => a.adapter_id).sort();
    const muts = inventory.mutation_adapters.map((a) => a.adapter_id).sort();
    const reads = inventory.read_dispatch_adapters.map((a) => a.adapter_id).sort();
    const ds = [...d.whatsapp_send].sort();
    const dm = [...d.mutation].sort();
    const dr = [...d.read_dispatch].sort();
    return JSON.stringify(sends) === JSON.stringify(ds)
      && JSON.stringify(muts) === JSON.stringify(dm)
      && JSON.stringify(reads) === JSON.stringify(dr)
      && sends.length === locks.EXPECTED_COUNTS.whatsapp_send
      && muts.length === locks.EXPECTED_COUNTS.mutation
      && reads.length === locks.EXPECTED_COUNTS.read_dispatch;
  })());

const derived = locks.deriveExpectedAdapterIdsFromSource(ROOT);
green('source_derivation_ok', derived.ok === true, (derived.errors || []).slice(0, 6).join(' | '));

const needleMiss = needlesPresent(inventory);
green('inventory_source_needles_present', needleMiss.length === 0, needleMiss.slice(0, 8).join(' | '));

green('central_decision_point_frozen',
  design.central_capability_boundary.decision_point === locks.DECISION_POINT
  && design.central_capability_boundary.decision_before_acquisition === true
  && design.central_capability_boundary.unknown_adapters_deny === true
  && design.central_capability_boundary.inventory_lookup_required === true
  && design.central_capability_boundary.effect_from_pinned_entry === true
  && design.central_capability_boundary.exact_tenant_binding === true
  && design.central_capability_boundary.exact_location_binding === true
  && design.central_capability_boundary.immutable_tenant_location_adapter_context === true
  && design.central_capability_boundary.immutable_per_turn_decision === true
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
    inventory_lookup_required: true,
    effect_from_pinned_entry: true,
    exact_tenant_binding: true,
    exact_location_binding: true,
    immutable_per_turn_decision: true,
    immutable_tenant_location_adapter_context: true,
    this_slice_implements_runtime: false,
    dry_run_implementable_today: false,
  }).ok === true);

green('decide_permits_read',
  (() => {
    const r = locks.decideCapability({
      adapter_id: 'hermes_post_bot_availability_check',
      tenant: locks.TENANT_WOLFHOUSE,
      location: locks.LOCATION_WOLFHOUSE,
      turn_id: 'turn-read-1',
      effect: 'mutation', // spoof ignored
      acquisition_already_held: false,
    }, inventory);
    return r.ok && r.decision === 'permit' && r.effect === 'read_dispatch'
      && r.adapter_id === 'hermes_post_bot_availability_check'
      && r.tenant === locks.TENANT_WOLFHOUSE
      && r.location === locks.LOCATION_WOLFHOUSE
      && r.context
      && r.context.tenant === locks.TENANT_WOLFHOUSE
      && r.context.location === locks.LOCATION_WOLFHOUSE
      && r.context.adapter_id === 'hermes_post_bot_availability_check'
      && Object.isFrozen(r)
      && Object.isFrozen(r.context);
  })());

green('decide_denies_whatsapp_send',
  (() => {
    const r = locks.decideCapability({
      adapter_id: 'hermes_whatsapp_cloud_graph_send',
      tenant: locks.TENANT_SUNSET,
      location: locks.LOCATION_SUNSET,
      turn_id: 'turn-send-1',
      effect: 'read_dispatch',
      acquisition_already_held: false,
    }, inventory);
    return r.ok && r.decision === 'deny' && r.effect === 'whatsapp_send'
      && r.location === locks.LOCATION_SUNSET
      && Object.isFrozen(r);
  })());

green('decide_denies_mutation',
  (() => {
    const r = locks.decideCapability({
      adapter_id: 'hermes_post_bot_booking_create_from_plan',
      tenant: locks.TENANT_WOLFHOUSE,
      location: locks.LOCATION_WOLFHOUSE,
      turn_id: 'turn-mut-1',
      effect: 'read_dispatch',
      acquisition_already_held: false,
    }, inventory);
    return r.ok && r.decision === 'deny' && r.effect === 'mutation' && Object.isFrozen(r);
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

green('demonstrated_reads_present',
  locks.DEMONSTRATED_OMISSION_IDS.every((id) =>
    inventory.read_dispatch_adapters.some((a) => a.adapter_id === id)));

green('demonstrated_extra_absent',
  !inventory.read_dispatch_adapters.some((a) => a.adapter_id === 'staff_bot_booking_dry_run')
  && locks.DEMONSTRATED_EXTRA_IDS.every((id) =>
    ![...inventory.whatsapp_send_adapters, ...inventory.mutation_adapters, ...inventory.read_dispatch_adapters]
      .some((a) => a.adapter_id === id)));

// --- RED ---
red('reject_omission',
  locks.classifyInventoryDocument({
    ...inventory,
    omits_known_reachable_adapter: true,
  }, ROOT).ok === false);

red('reject_self_reported_complete_flag',
  locks.compareInventoryExactSet({
    ...inventory,
    complete: true,
    completeness_method: 'self_reported',
  }, ROOT).ok === false);

red('reject_demonstrated_omission',
  (() => {
    const truncated = {
      ...inventory,
      read_dispatch_adapters: inventory.read_dispatch_adapters.filter(
        (a) => a.adapter_id !== 'hermes_post_bot_sunset_full_day_addon',
      ),
      counts: {
        ...inventory.counts,
        read_dispatch: inventory.counts.read_dispatch - 1,
        total: inventory.counts.total - 1,
      },
    };
    return locks.compareInventoryExactSet(truncated, ROOT).ok === false;
  })());

red('reject_demonstrated_extra_booking_dry_run',
  (() => {
    const withExtra = {
      ...inventory,
      read_dispatch_adapters: [
        ...inventory.read_dispatch_adapters,
        {
          adapter_id: 'staff_bot_booking_dry_run',
          effect: 'read_dispatch',
          category: 'direct',
          allowed_tenants: [locks.TENANT_WOLFHOUSE],
          path: 'scripts/staff-query-api.js',
          symbol: 'booking-dry-run',
          source_needle: 'booking-dry-run',
          acquisition_point: 'db_pool_client',
        },
      ],
    };
    return locks.compareInventoryExactSet(withExtra, ROOT).ok === false;
  })());

red('reject_collapsed_duplicate_present',
  (() => {
    const withDup = {
      ...inventory,
      whatsapp_send_adapters: [
        ...inventory.whatsapp_send_adapters,
        {
          adapter_id: 'hermes_whatsapp_cloud_media_send',
          effect: 'whatsapp_send',
          category: 'direct',
          allowed_tenants: [locks.TENANT_WOLFHOUSE, locks.TENANT_SUNSET],
          path: 'docker/hermes-staging/apply_gateway_patches.py',
          symbol: 'media',
          source_needle: 'async def _patched_whatsapp_cloud_send',
          acquisition_point: 'meta_graph_http_client',
        },
      ],
    };
    return locks.compareInventoryExactSet(withDup, ROOT).ok === false;
  })());

red('reject_duplicate_adapter_ids',
  locks.classifyInventoryDocument({
    independently_pinned: true,
    identity_rule_id: locks.IDENTITY_RULE.id,
    completeness_method: locks.IDENTITY_RULE.completeness_method,
    whatsapp_send_adapters: [
      inventory.whatsapp_send_adapters[0],
      { ...inventory.whatsapp_send_adapters[0] },
    ],
    mutation_adapters: inventory.mutation_adapters,
    read_dispatch_adapters: inventory.read_dispatch_adapters,
  }, ROOT).ok === false);

red('reject_dispersed_env_checks',
  locks.decideCapability({
    adapter_id: 'hermes_whatsapp_cloud_graph_send',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    dispersed_env_checks_as_sole_control: true,
  }, inventory).ok === false
  && locks.classifyCapabilityBoundaryFreeze({
    dispersed_env_checks_as_sole_control: true,
  }).ok === false
  && locks.classifyInventoryDocument({
    ...inventory,
    dispersed_env_checks_as_sole_control: true,
  }, ROOT).ok === false);

red('reject_bypass',
  locks.decideCapability({
    adapter_id: 'hermes_whatsapp_cloud_graph_send',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    bypass_central_decision: true,
  }, inventory).ok === false);

red('reject_post_acquisition_denial',
  locks.decideCapability({
    adapter_id: 'hermes_whatsapp_cloud_graph_send',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    acquisition_already_held: true,
  }, inventory).ok === false
  && locks.classifyCapabilityBoundaryFreeze({
    post_acquisition_denial: true,
    central_decision_point: locks.DECISION_POINT,
    denies_every_whatsapp_send: true,
    denies_every_staff_db_stripe_mutation: true,
    permits_real_read_dispatch: true,
    unknown_adapters_deny: true,
    decision_before_acquisition: true,
    inventory_lookup_required: true,
    effect_from_pinned_entry: true,
    exact_tenant_binding: true,
    exact_location_binding: true,
    immutable_per_turn_decision: true,
    immutable_tenant_location_adapter_context: true,
  }).ok === false);

red('reject_mutable_capability_state',
  locks.decideCapability({
    adapter_id: 'hermes_whatsapp_cloud_graph_send',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    mutable_capability_state: true,
  }, inventory).ok === false);

red('reject_arbitrary_read_id',
  locks.decideCapability({
    adapter_id: 'arbitrary_not_in_inventory_read',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    effect: 'read_dispatch',
  }, inventory).ok === false
  && locks.decideCapability({
    adapter_id: 'arbitrary_not_in_inventory_read',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    effect: 'read_dispatch',
  }, inventory).code === 'unknown_adapter_denied');

red('reject_missing_tenant',
  locks.decideCapability({
    adapter_id: 'hermes_post_bot_availability_check',
    turn_id: 't',
  }, inventory).ok === false
  && locks.decideCapability({
    adapter_id: 'hermes_post_bot_availability_check',
    turn_id: 't',
  }, inventory).code === 'missing_tenant_denied');

red('reject_wrong_tenant',
  locks.decideCapability({
    adapter_id: 'hermes_post_bot_availability_check',
    tenant: locks.TENANT_SUNSET,
    location: locks.LOCATION_SUNSET,
    turn_id: 't',
  }, inventory).ok === false
  && locks.decideCapability({
    adapter_id: 'hermes_post_bot_sunset_rental_price',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
  }, inventory).code === 'cross_tenant_denied');

red('reject_caller_effect_spoofing',
  (() => {
    const r = locks.decideCapability({
      adapter_id: 'hermes_post_bot_booking_create_from_plan',
      tenant: locks.TENANT_WOLFHOUSE,
      location: locks.LOCATION_WOLFHOUSE,
      turn_id: 't',
      effect: 'read_dispatch',
      inventory_class: 'read_dispatch',
    }, inventory);
    return r.ok === true
      && r.decision === 'deny'
      && r.effect === 'mutation'
      && r.caller_effect_ignored === 'read_dispatch';
  })());

red('reject_post_decision_mutation',
  (() => {
    const r = locks.decideCapability({
      adapter_id: 'hermes_post_bot_availability_check',
      tenant: locks.TENANT_WOLFHOUSE,
      location: locks.LOCATION_WOLFHOUSE,
      turn_id: 'turn-frozen',
    }, inventory);
    if (!Object.isFrozen(r)) return false;
    let threw = false;
    try {
      r.decision = 'deny';
      r.effect = 'mutation';
      r.tenant = locks.TENANT_SUNSET;
      r.location = locks.LOCATION_SUNSET;
      r.adapter_id = 'tampered';
      if (r.context) r.context.tenant = locks.TENANT_SUNSET;
    } catch (_) {
      threw = true;
    }
    return (threw || r.decision === 'permit')
      && r.decision === 'permit'
      && r.effect === 'read_dispatch'
      && r.tenant === locks.TENANT_WOLFHOUSE
      && r.location === locks.LOCATION_WOLFHOUSE
      && r.adapter_id === 'hermes_post_bot_availability_check'
      && r.turn_id === 'turn-frozen';
  })());

red('reject_tenant_confusion',
  locks.decideCapability({
    adapter_id: 'hermes_whatsapp_cloud_graph_send',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    tenant_confusion: true,
  }, inventory).ok === false);

red('reject_unknown_adapter',
  locks.decideCapability({
    adapter_id: '',
    tenant: locks.TENANT_WOLFHOUSE,
    turn_id: 't',
    effect: 'unknown',
  }, inventory).ok === false
  && locks.decideCapability({
    effect: 'read_dispatch',
    tenant: locks.TENANT_WOLFHOUSE,
    turn_id: 't',
  }, inventory).decision !== 'permit');

red('reject_trace_deploy_live_overclaim',
  locks.decideCapability({
    adapter_id: 'hermes_post_bot_availability_check',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    claims_trace_implemented: true,
  }, inventory).ok === false
  && locks.decideCapability({
    adapter_id: 'hermes_post_bot_availability_check',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    claims_deploy: true,
  }, inventory).ok === false
  && locks.decideCapability({
    adapter_id: 'hermes_post_bot_availability_check',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    claims_live_evidence: true,
  }, inventory).ok === false
  && locks.decideCapability({
    adapter_id: 'hermes_post_bot_availability_check',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    claims_runtime_wired: true,
  }, inventory).ok === false);

red('reject_runtime_implemented_claim',
  locks.classifyCapabilityBoundaryFreeze({
    this_slice_implements_runtime: true,
    central_decision_point: locks.DECISION_POINT,
    denies_every_whatsapp_send: true,
    denies_every_staff_db_stripe_mutation: true,
    permits_real_read_dispatch: true,
    unknown_adapters_deny: true,
    decision_before_acquisition: true,
    inventory_lookup_required: true,
    effect_from_pinned_entry: true,
    exact_tenant_binding: true,
    exact_location_binding: true,
    immutable_per_turn_decision: true,
    immutable_tenant_location_adapter_context: true,
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
    inventory_lookup_required: true,
    effect_from_pinned_entry: true,
    exact_tenant_binding: true,
    exact_location_binding: true,
    immutable_per_turn_decision: true,
    immutable_tenant_location_adapter_context: true,
  }).ok === false);

red('reject_missing_send_category',
  locks.classifyInventoryDocument({
    independently_pinned: true,
    identity_rule_id: locks.IDENTITY_RULE.id,
    completeness_method: locks.IDENTITY_RULE.completeness_method,
    whatsapp_send_adapters: inventory.whatsapp_send_adapters.filter((a) => a.category !== 'queued'),
    mutation_adapters: inventory.mutation_adapters,
    read_dispatch_adapters: inventory.read_dispatch_adapters,
  }, ROOT).ok === false);


red('reject_missing_location',
  locks.decideCapability({
    adapter_id: 'hermes_post_bot_availability_check',
    tenant: locks.TENANT_WOLFHOUSE,
    turn_id: 't',
  }, inventory).ok === false
  && locks.decideCapability({
    adapter_id: 'hermes_post_bot_availability_check',
    tenant: locks.TENANT_WOLFHOUSE,
    turn_id: 't',
  }, inventory).code === 'missing_location_denied');

red('reject_tenant_location_mismatch',
  locks.decideCapability({
    adapter_id: 'hermes_whatsapp_cloud_graph_send',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_SUNSET,
    turn_id: 't',
  }, inventory).ok === false
  && locks.decideCapability({
    adapter_id: 'hermes_whatsapp_cloud_graph_send',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_SUNSET,
    turn_id: 't',
  }, inventory).code === 'tenant_location_mismatch');

red('reject_context_tamper_flag',
  locks.decideCapability({
    adapter_id: 'hermes_post_bot_availability_check',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    context_tamper: true,
  }, inventory).ok === false
  && locks.decideCapability({
    adapter_id: 'hermes_post_bot_availability_check',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    context_tamper: true,
  }, inventory).code === 'context_tamper_forbidden');

red('reject_extra_adapter_set',
  (() => {
    const withExtra = {
      ...inventory,
      mutation_adapters: [
        ...inventory.mutation_adapters,
        {
          adapter_id: 'invented_extra_mutation_adapter',
          effect: 'mutation',
          category: 'direct',
          allowed_tenants: [locks.TENANT_WOLFHOUSE],
          allowed_locations: [locks.LOCATION_WOLFHOUSE],
          path: 'scripts/staff-query-api.js',
          symbol: 'invented',
          source_needle: 'invented',
          acquisition_point: 'db_pool_client',
        },
      ],
    };
    return locks.compareInventoryExactSet(withExtra, ROOT).ok === false;
  })());

red('reject_bidirectional_missing_expected_id',
  (() => {
    const truncated = {
      ...inventory,
      whatsapp_send_adapters: inventory.whatsapp_send_adapters.filter(
        (a) => a.adapter_id !== 'hermes_busy_text_queue_send',
      ),
      counts: {
        ...inventory.counts,
        whatsapp_send: inventory.counts.whatsapp_send - 1,
        total: inventory.counts.total - 1,
      },
    };
    return locks.compareInventoryExactSet(truncated, ROOT).ok === false;
  })());

// --- Ledger / matrix ---
green('matrix_tip_16ae',
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
      && /16AE|capability boundary/i.test(g01.rationale)
      && /16U|provenance|design freeze/i.test(g01.rationale)
      && Array.isArray(g01.gaps)
      && g01.gaps.some((g) => /G01-A|Meta.*Hermes.*Staff|correlation/i.test(g));
  })());

green('matrix_16ae_selection',
  matrix.slice_16ae_selection
  && matrix.slice_16ae_selection.selected === true
  && matrix.slice_16ae_selection.outcome_id === locks.OUTCOME_ID
  && matrix.slice_16ae_selection.progress_class === locks.PROGRESS_CLASS
  && matrix.slice_16ae_selection.inventory_counts
  && matrix.slice_16ae_selection.inventory_counts.whatsapp_send === locks.EXPECTED_COUNTS.whatsapp_send
  && matrix.slice_16ae_selection.inventory_counts.mutation === locks.EXPECTED_COUNTS.mutation
  && matrix.slice_16ae_selection.inventory_counts.read_dispatch === locks.EXPECTED_COUNTS.read_dispatch
  && matrix.slice_16ae_selection.inventory_counts.total === locks.EXPECTED_COUNTS.total);

green('ops_contract_16ae',
  opsContract.slice === locks.SLICE
  && opsContract.selected_16ae
  && opsContract.selected_16ae.outcome_id === locks.OUTCOME_ID
  && opsContract.selected_16ae.inventory_counts
  && opsContract.selected_16ae.inventory_counts.total === locks.EXPECTED_COUNTS.total
  && opsContract.selected_16u
  && opsContract.selected_16u.outcome_id === '16U_correlation_design_freeze'
  && opsContract.capability_boundary_design === 'frozen_via_16AE'
  && opsContract.selected_16ad
  && opsContract.selected_16ad.g02_verdict === 'partial');

green('ledger_mentions_16ae',
  /16AE_g01_capability_boundary_freeze|16AE/.test(ledger)
  && /decideCapability|capability boundary/i.test(ledger)
  && /source_derived_exact_set|identity rule|ADAPTER_IDENTITY/i.test(ledger)
  && new RegExp(String(locks.EXPECTED_COUNTS.whatsapp_send)).test(ledger)
  && new RegExp(String(locks.EXPECTED_COUNTS.mutation)).test(ledger)
  && new RegExp(String(locks.EXPECTED_COUNTS.read_dispatch)).test(ledger)
  && /16U/.test(ledger)
  && /16AD/.test(ledger)
  && /partial/i.test(ledger)
  && /not implement|runtime apply|not wired|not activatable/i.test(ledger));

green('findings_mentions_16ae',
  /16AE/.test(findings)
  && /capability boundary/i.test(findings)
  && /decideCapability|adapter inventory|exact-set|identity/i.test(findings)
  && /16U/.test(findings)
  && /16AD/.test(findings));

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
  && pkg.scripts['verify:radar-slice16ae-g01-capability-boundary-freeze']
    === 'node scripts/verify-radar-slice16ae-g01-capability-boundary-freeze.js');

const requiredRed = [
  'reject_omission',
  'reject_self_reported_complete_flag',
  'reject_demonstrated_omission',
  'reject_demonstrated_extra_booking_dry_run',
  'reject_collapsed_duplicate_present',
  'reject_duplicate_adapter_ids',
  'reject_dispersed_env_checks',
  'reject_bypass',
  'reject_post_acquisition_denial',
  'reject_mutable_capability_state',
  'reject_arbitrary_read_id',
  'reject_missing_tenant',
  'reject_wrong_tenant',
  'reject_caller_effect_spoofing',
  'reject_post_decision_mutation',
  'reject_tenant_confusion',
  'reject_unknown_adapter',
  'reject_trace_deploy_live_overclaim',
  'reject_runtime_implemented_claim',
  'reject_dry_run_implementable_today',
  'reject_missing_send_category',
  'reject_missing_location',
  'reject_tenant_location_mismatch',
  'reject_context_tamper_flag',
  'reject_extra_adapter_set',
  'reject_bidirectional_missing_expected_id',
];
const requiredGreen = [
  'fixtures_present',
  'pins',
  'identity_rule_frozen',
  'contract_pins',
  'inventory_pins',
  'inventory_classifier_accepts',
  'source_derived_exact_set',
  'bidirectional_exact_set',
  'source_derivation_ok',
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
  'demonstrated_reads_present',
  'demonstrated_extra_absent',
  'matrix_tip_16ae',
  'matrix_g01_partial_preserved',
  'matrix_16ae_selection',
  'ops_contract_16ae',
  'ledger_mentions_16ae',
  'findings_mentions_16ae',
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
console.log('RADAR 16AE capability boundary freeze: PASS');
