'use strict';

/**
 * radar-slice16u-correlation-design-freeze — RADAR Slice 16U locks.
 *
 * Audit-only design freeze for a genuine non-mutating G01 correlation drill.
 * Does not implement, deploy, or execute live. Does not reuse any deferred
 * independent same-ID probe harness. Runtime behavior unchanged.
 */

const path = require('path');

const MASTER_BASIS = '87121456db90a9f80ff8b3679596bc49c235cbfc';
const SLICE = 'RADAR-16U';
const OUTCOME_ID = '16U_correlation_design_freeze';
const GATE_ID = 'G01_correlation_structured_logs';
const PROGRESS_CLASS = 'audit_only_design_freeze';
const BRANCH = 'radar/slice-16u-correlation-design-freeze';

const CALL_GRAPH_REL = 'fixtures/radar-operations/slice16u-call-graph.json';
const DESIGN_REL = 'fixtures/radar-operations/slice16u-correlation-design-freeze.json';
const CONTRACT_REL = 'fixtures/radar-operations/slice16u-expected-contract.json';

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';

/** Provable G01-A causal chain (same immutable trace_id). */
const G01A_BOUNDARY = 'meta_hermes_staff_correlated_read_path';

/** Stripe is business-ID join only — not same HTTP ALS as Meta ingress. */
const G01B_BOUNDARY = 'stripe_business_id_join_not_inbound_als';

const FORBIDDEN_AS_E2E_EVIDENCE = Object.freeze([
  'independent_same_id_healthz_probe',
  'independent_same_id_stripe_preverify_probe',
  'independent_same_id_staff_meta_unsigned_probe',
  'parallel_unrelated_http_calls_sharing_uuid',
  'deferred_16t_style_multi_ingress_same_id_harness',
]);

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'live_correlation_drill_executed',
  'any_gate_verdict_proven',
  'g02_g09_score_changes',
  'runtime_behavior_change',
  'hermes_x_request_id_propagation_implemented',
  'stripe_checkout_without_mutation',
  'single_als_spanning_meta_to_stripe_webhook',
  'production',
  'independent_same_id_probes_as_e2e',
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
  CALL_GRAPH_REL,
  DESIGN_REL,
  CONTRACT_REL,
  'scripts/lib/radar-slice16u-correlation-design-freeze.js',
  'scripts/verify-radar-slice16u-correlation-design-freeze.js',
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
  'fixtures/radar-operations/gate-matrix.json',
  'fixtures/radar-operations/contract.json',
  'fixtures/radar-operations/findings.md',
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

const REQUIRED_INSTRUMENTATION_POINTS = Object.freeze([
  'hermes_meta_admit_mint_trace_id',
  'hermes_bind_parent_event_id_wamid',
  'hermes_post_bot_send_x_request_id',
  'staff_als_accept_same_trace_id',
  'staff_completion_log_emit_trace_id',
  'optional_stripe_metadata_copy_on_mutating_create_only',
]);

/**
 * Classify a candidate evidence package.
 * Independent same-ID probes across unrelated ingresses are NEVER E2E.
 */
function classifyEvidenceClaim(candidate) {
  const c = candidate || {};
  const errors = [];
  const claim = String(c.claim_class || '');

  if (FORBIDDEN_AS_E2E_EVIDENCE.includes(claim)) {
    return {
      ok: false,
      fail_closed: true,
      code: 'independent_same_id_probes_rejected_as_e2e',
      errors: [`claim_class=${claim} is not causal E2E evidence`],
    };
  }

  if (c.independent_probes === true) {
    errors.push('independent_probes_flag');
  }
  if (Array.isArray(c.hops) && c.hops.length >= 2) {
    const kinds = c.hops.map((h) => h && h.ingress_kind).filter(Boolean);
    const hasHealthz = kinds.includes('staff_healthz') || kinds.includes('healthz');
    const hasStripePre = kinds.includes('stripe_preverify') || kinds.includes('stripe_unsigned');
    const hasStaffMeta = kinds.includes('staff_meta_unsigned');
    const hasHermes = kinds.includes('hermes_meta') || kinds.includes('hermes_webhook');
    const hasStaffBot = kinds.includes('hermes_staff_bot') || kinds.includes('staff_bot');
    if ((hasHealthz || hasStripePre || hasStaffMeta) && !hasHermes && !hasStaffBot) {
      errors.push('independent_same_id_probe_pattern');
    }
    if (hasHealthz && hasStripePre && !hasHermes) {
      errors.push('healthz_plus_stripe_preverify_not_e2e');
    }
  }

  if (c.claims_stripe_on_inbound_als === true) {
    errors.push('stripe_cannot_share_inbound_als');
  }
  if (c.claims_stripe_without_mutation === true) {
    errors.push('stripe_checkout_requires_mutation');
  }
  if (c.runtime_changed === true) {
    errors.push('runtime_must_remain_unchanged_in_16u');
  }

  if (claim === 'g01a_meta_hermes_staff' || claim === G01A_BOUNDARY) {
    if (!c.single_trace_id || !c.parent_event_id) {
      errors.push('g01a_requires_trace_id_and_parent_event_id');
    }
    if (c.causal_chain !== true) {
      errors.push('g01a_requires_causal_chain');
    }
    if (c.mutation_performed === true) {
      errors.push('g01a_design_target_is_non_mutating');
    }
  }

  if (errors.length) {
    return {
      ok: false,
      fail_closed: true,
      code: errors[0],
      errors,
    };
  }

  if (claim === 'g01a_meta_hermes_staff' || claim === G01A_BOUNDARY) {
    return {
      ok: true,
      code: 'design_accepts_g01a_shape',
      note: 'Shape only — 16U does not execute or prove live G01-A',
    };
  }

  if (claim === 'g01b_stripe_business_join' || claim === G01B_BOUNDARY) {
    return {
      ok: true,
      code: 'design_accepts_g01b_business_join_shape',
      note: 'Stripe join is metadata/business-id only; mutating Checkout create required to exercise',
    };
  }

  return {
    ok: false,
    fail_closed: true,
    code: 'unknown_claim_class',
    errors: [`unknown claim_class=${claim}`],
  };
}

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  PROGRESS_CLASS,
  BRANCH,
  CALL_GRAPH_REL,
  DESIGN_REL,
  CONTRACT_REL,
  SUBSCRIPTION_ID,
  G01A_BOUNDARY,
  G01B_BOUNDARY,
  FORBIDDEN_AS_E2E_EVIDENCE,
  EXPLICITLY_NOT_CLAIMED,
  GATES_UNCHANGED,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  REQUIRED_INSTRUMENTATION_POINTS,
  classifyEvidenceClaim,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
