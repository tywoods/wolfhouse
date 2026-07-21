'use strict';

/**
 * radar-slice16v-capability-boundary-freeze — RADAR Slice 16V locks.
 *
 * Audit-only freeze of the central capability boundary required before any
 * G01-A dry-run. Inventories every WhatsApp send + Staff/DB/Stripe mutation
 * adapter reachable from active Hermes guest turns. Defines one fail-closed
 * decideCapability decision point (permit reads; deny sends/writes before
 * provider/pool/client/queue acquisition; unknown denies). Does NOT implement
 * runtime behavior, deploy, or capture live evidence.
 */

const path = require('path');

const MASTER_BASIS = 'd904481de6ef8e7ad65d84241577796cbb5ad1c4';
const SLICE = 'RADAR-16V';
const OUTCOME_ID = '16V_central_capability_boundary_audit_freeze';
const GATE_ID = 'G01_correlation_structured_logs';
const PROGRESS_CLASS = 'audit_only_capability_boundary_freeze';
const BRANCH = 'radar/slice-16v-capability-boundary-freeze';

const INVENTORY_REL = 'fixtures/radar-operations/slice16v-adapter-inventory.json';
const DESIGN_REL = 'fixtures/radar-operations/slice16v-capability-boundary-freeze.json';
const CONTRACT_REL = 'fixtures/radar-operations/slice16v-expected-contract.json';

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';

/** Single fail-closed decision point (design freeze — not wired at runtime). */
const DECISION_POINT = 'decideCapability';

/** Later runtime owner (not created in 16V). */
const LATER_OWNER_MODULE = 'docker/hermes-staging/wolfhouse/capability_boundary.py';
const LATER_OWNER_SYMBOL = 'decide_capability';
const LATER_OWNER_TESTS = 'docker/hermes-staging/wolfhouse/test_capability_boundary.py';
const LATER_STAFF_OWNER_MODULE = 'scripts/lib/g01-capability-boundary.js';
const LATER_STAFF_OWNER_SYMBOL = 'decideCapability';
const LATER_STAFF_OWNER_TESTS = 'scripts/verify-g01-capability-boundary.js';

const NEXT_SLICE_ID = '16W_candidate_capability_boundary_runtime_apply';

/** Effects decided by the central boundary. */
const EFFECT_WHATSAPP_SEND = 'whatsapp_send';
const EFFECT_MUTATION = 'mutation';
const EFFECT_READ = 'read_dispatch';
const EFFECT_UNKNOWN = 'unknown';

const REQUIRED_SEND_CATEGORIES = Object.freeze([
  'direct',
  'queued',
  'mirror',
  'handoff',
  'booking_payment',
  'reset_error_fallback',
  'future_tool_registration',
]);

const REQUIRED_MUTATION_CATEGORIES = Object.freeze([
  'direct',
  'queued',
  'mirror',
  'handoff',
  'booking_payment',
  'reset_error_fallback',
  'future_tool_registration',
  'session',
]);

const ACQUISITION_KINDS = Object.freeze([
  'meta_graph_http_client',
  'staff_http_client',
  'db_pool_client',
  'stripe_sdk',
  'in_process_queue',
  'hermes_session_store',
]);

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'runtime_behavior_change',
  'capability_boundary_wired_at_runtime',
  'dry_run_implementable_today',
  'live_correlation_drill_executed',
  'any_gate_verdict_proven',
  'g02_g09_score_changes',
  'hermes_x_request_id_propagation_implemented',
  'trace_implementation',
  'deploy',
  'evidence_capture',
  'live_drill',
  'production',
  'dispersed_env_checks_as_sole_control',
  'post_acquisition_denial_accepted',
  'mutable_capability_state_accepted',
]);

const GATES_UNCHANGED = Object.freeze([
  'G02_readiness_dependencies',
  'G03_actionable_tenant_aware_alerts',
  'G04_webhook_payment_worker_backlog',
  'G05_retry_replay_safety',
  'G06_scaling_capacity',
  'G07_rollback_incident_runbooks',
  'G08_retention_privacy',
  'G09_cost_controls',
]);

const OWNED_RELS = Object.freeze([
  INVENTORY_REL,
  DESIGN_REL,
  CONTRACT_REL,
  'scripts/lib/radar-slice16v-capability-boundary-freeze.js',
  'scripts/verify-radar-slice16v-capability-boundary-freeze.js',
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
  'fixtures/radar-operations/gate-matrix.json',
  'fixtures/radar-operations/contract.json',
  'fixtures/radar-operations/findings.md',
  'package.json',
  'scripts/verify-radar-slice16a-operations-gate-ledger.js',
  'scripts/verify-radar-slice16u-correlation-design-freeze.js',
  'scripts/verify-radar-slice16s-request-log-live-evidence.js',
]);

const MUST_NOT_MUTATE = Object.freeze([
  'database/',
  'docker/hermes-staging/',
  'docker/hermes-sunset/',
  'scripts/staff-query-api.js',
  'scripts/lib/staff-api-request-correlation.js',
  'scripts/lib/staff-api-request-completion-log.js',
  'scripts/lib/stripe-webhook-public-errors.js',
  'infra/azure/staging/main.bicep',
  'infra/azure/sunset-staging/main.bicep',
  'infra/azure/staging-staff-api-metric-alerts/',
  'infra/azure/staging-cost-budgets/',
]);

/** 16U provenance truths that 16V must preserve. */
const PRESERVED_16U_TRUTHS = Object.freeze({
  live_whatsapp_upstream: 'localhost:8092 hermes-sunset-luna',
  live_wolfhouse_upstream: 'localhost:8090 hermes-luna',
  tracked_caddy_reference: 'stale_evidence_not_authority',
  g01a_boundary: 'meta_hermes_staff_correlated_read_path',
  g01b_boundary: 'stripe_business_id_join_not_inbound_als',
  g01b_correlation_today: 'tenant_payment_booking_session_metadata_only',
  burst_provenance: 'ordered_immutable_source_wamid_set_no_invented_parent',
  inbound_trace_wamid_propagation_today: false,
  hermes_propagates_x_request_id_today: false,
});

function failClosed(code, errors) {
  return {
    ok: false,
    fail_closed: true,
    code,
    errors: errors || [code],
  };
}

/**
 * Audit-only classifier for the central capability decision.
 * Shape only — 16V does not wire this into runtime.
 */
function decideCapability(candidate) {
  const c = candidate || {};
  const errors = [];

  if (c.acquisition_already_held === true || c.decision_timing === 'after_acquisition') {
    return failClosed('post_acquisition_denial_forbidden', [
      'capability decision must occur before provider/pool/client/queue acquisition',
    ]);
  }
  if (c.mutable_capability_state === true) {
    return failClosed('mutable_capability_state_forbidden', [
      'capability decision state must be immutable for the turn',
    ]);
  }
  if (c.dispersed_env_checks_as_sole_control === true) {
    return failClosed('dispersed_env_checks_rejected', [
      'dispersed per-adapter env checks are not the control plane',
    ]);
  }
  if (c.bypass_central_decision === true) {
    return failClosed('capability_bypass_forbidden', [
      'adapters must not bypass the central decideCapability point',
    ]);
  }
  if (c.tenant_confusion === true || c.cross_tenant === true) {
    return failClosed('tenant_confusion_forbidden', [
      'tenant must be explicit wolfhouse-somo or sunset; never confuse tenants',
    ]);
  }
  if (c.claims_runtime_wired === true || c.claims_live_enforcement === true) {
    return failClosed('runtime_overclaim', [
      '16V is audit-only; runtime enforcement is not claimed',
    ]);
  }
  if (c.claims_trace_implemented === true || c.claims_deploy === true || c.claims_live_evidence === true) {
    return failClosed('trace_deploy_live_overclaim', [
      '16V forbids trace/deploy/live evidence claims',
    ]);
  }

  const effect = String(c.effect || c.capability_class || '');
  const adapterId = String(c.adapter_id || '');

  if (!adapterId || effect === EFFECT_UNKNOWN || effect === '') {
    return failClosed('unknown_adapter_denied', [
      'unknown or unclassified adapters deny fail-closed',
    ]);
  }

  if (effect === EFFECT_READ) {
    if (c.inventory_class !== 'read_dispatch' && c.inventory_class !== EFFECT_READ) {
      errors.push('read_effect_requires_read_inventory_class');
    }
    if (errors.length) return failClosed(errors[0], errors);
    return {
      ok: true,
      decision: 'permit',
      fail_closed: true,
      code: 'permit_read_dispatch',
      note: 'Shape only — runtime not wired in 16V',
    };
  }

  if (effect === EFFECT_WHATSAPP_SEND || effect === EFFECT_MUTATION) {
    return {
      ok: true,
      decision: 'deny',
      fail_closed: true,
      code: effect === EFFECT_WHATSAPP_SEND ? 'deny_whatsapp_send' : 'deny_mutation',
      note: 'Shape only — runtime not wired in 16V',
    };
  }

  return failClosed('unknown_adapter_denied', [
    `unclassified effect=${effect}`,
  ]);
}

/**
 * Validate an independently pinned adapter inventory document.
 */
function classifyInventoryDocument(inventory) {
  const inv = inventory || {};
  const errors = [];
  const sends = Array.isArray(inv.whatsapp_send_adapters) ? inv.whatsapp_send_adapters : [];
  const muts = Array.isArray(inv.mutation_adapters) ? inv.mutation_adapters : [];
  const reads = Array.isArray(inv.read_dispatch_adapters) ? inv.read_dispatch_adapters : [];

  if (inv.independently_pinned !== true) {
    errors.push('inventory_must_be_independently_pinned');
  }
  if (inv.complete !== true) {
    errors.push('inventory_must_claim_complete');
  }

  const ids = [];
  for (const a of [...sends, ...muts, ...reads]) {
    if (!a || !a.adapter_id) {
      errors.push('adapter_missing_id');
      continue;
    }
    ids.push(a.adapter_id);
    if (!a.path || !a.symbol || !a.source_needle) {
      errors.push(`adapter_pin_incomplete:${a.adapter_id}`);
    }
    if (!a.acquisition_point || !a.category || !a.effect) {
      errors.push(`adapter_fields_incomplete:${a.adapter_id}`);
    }
  }

  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) errors.push(`duplicate_adapter_id:${id}`);
    seen.add(id);
  }

  for (const cat of REQUIRED_SEND_CATEGORIES) {
    if (!sends.some((a) => a.category === cat)) {
      errors.push(`missing_send_category:${cat}`);
    }
  }
  for (const cat of REQUIRED_MUTATION_CATEGORIES) {
    if (!muts.some((a) => a.category === cat)) {
      errors.push(`missing_mutation_category:${cat}`);
    }
  }
  if (reads.length < 1) errors.push('missing_read_adapters');

  if (inv.omits_known_reachable_adapter === true) {
    errors.push('omission_rejected');
  }
  if (inv.dispersed_env_checks_as_sole_control === true) {
    errors.push('dispersed_env_checks_rejected');
  }

  if (errors.length) {
    return failClosed(errors[0], errors);
  }

  return {
    ok: true,
    code: 'inventory_accepted',
    counts: {
      whatsapp_send: sends.length,
      mutation: muts.length,
      read_dispatch: reads.length,
      total: sends.length + muts.length + reads.length,
    },
  };
}

/**
 * Reject capability designs that are incomplete or overclaim.
 */
function classifyCapabilityBoundaryFreeze(candidate) {
  const c = candidate || {};
  if (c.this_slice_implements_runtime === true) {
    return failClosed('runtime_must_not_be_implemented_in_16v', [
      '16V is audit-only',
    ]);
  }
  if (c.dispersed_env_checks_as_sole_control === true) {
    return failClosed('dispersed_env_checks_rejected', [
      'central decideCapability is required',
    ]);
  }
  if (c.incomplete_adapter_inventory === true) {
    return failClosed('incomplete_adapter_inventory', [
      'adapter inventory must be complete',
    ]);
  }
  if (c.post_acquisition_denial === true) {
    return failClosed('post_acquisition_denial_forbidden', [
      'denial after provider/pool/client/queue acquisition is forbidden',
    ]);
  }
  if (c.mutable_capability_state === true) {
    return failClosed('mutable_capability_state_forbidden', [
      'capability state must be immutable for the turn',
    ]);
  }
  if (c.dry_run_implementable_today === true) {
    return failClosed('dry_run_not_implementable_yet', [
      'dry-run awaits runtime apply of the frozen boundary',
    ]);
  }
  if (
    c.central_decision_point === DECISION_POINT
    && c.denies_every_whatsapp_send === true
    && c.denies_every_staff_db_stripe_mutation === true
    && c.permits_real_read_dispatch === true
    && c.unknown_adapters_deny === true
    && c.decision_before_acquisition === true
    && c.incomplete_adapter_inventory !== true
  ) {
    return {
      ok: true,
      code: 'capability_boundary_freeze_accepted',
      note: 'Audit freeze only — runtime owner not wired',
    };
  }
  return failClosed('capability_boundary_freeze_incomplete', [
    'require central decideCapability deny-send+deny-mutation+permit-read before acquisition',
  ]);
}

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  PROGRESS_CLASS,
  BRANCH,
  INVENTORY_REL,
  DESIGN_REL,
  CONTRACT_REL,
  SUBSCRIPTION_ID,
  DECISION_POINT,
  LATER_OWNER_MODULE,
  LATER_OWNER_SYMBOL,
  LATER_OWNER_TESTS,
  LATER_STAFF_OWNER_MODULE,
  LATER_STAFF_OWNER_SYMBOL,
  LATER_STAFF_OWNER_TESTS,
  NEXT_SLICE_ID,
  EFFECT_WHATSAPP_SEND,
  EFFECT_MUTATION,
  EFFECT_READ,
  EFFECT_UNKNOWN,
  REQUIRED_SEND_CATEGORIES,
  REQUIRED_MUTATION_CATEGORIES,
  ACQUISITION_KINDS,
  EXPLICITLY_NOT_CLAIMED,
  GATES_UNCHANGED,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  PRESERVED_16U_TRUTHS,
  decideCapability,
  classifyInventoryDocument,
  classifyCapabilityBoundaryFreeze,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
