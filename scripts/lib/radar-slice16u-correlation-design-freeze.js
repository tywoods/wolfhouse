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

/** G01-B today: tenant/payment/booking/session metadata only. */
const G01B_CORRELATION_TODAY = 'tenant_payment_booking_session_metadata_only';

const NEXT_SLICE_ID = '16V_candidate_central_capability_boundary_audit_freeze';

const LIVE_CADDY_ROUTES = Object.freeze({
  whatsapp: Object.freeze({
    path_prefix: '/whatsapp/*',
    upstream: 'localhost:8092',
    container: 'hermes-sunset-luna',
  }),
  wolfhouse: Object.freeze({
    path_prefix: '/wolfhouse/*',
    upstream: 'localhost:8090',
    container: 'hermes-luna',
  }),
});

const TRACKED_CADDY_STATUS = 'stale_evidence_not_authority';

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
  'dry_run_implementable_today',
  'tracked_caddy_reference_as_live_authority',
  'invented_single_parent_for_coalesced_burst',
  'inbound_trace_wamid_payment_propagation_today',
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
  'hermes_bind_message_provenance',
  'hermes_post_bot_send_x_request_id',
  'staff_als_accept_same_trace_id',
  'staff_completion_log_emit_trace_id',
]);

const G01B_JOIN_KEYS_TODAY = Object.freeze([
  'client_slug',
  'payment_id',
  'booking_id',
  'stripe_checkout_session_id',
]);

function failClosed(code, errors) {
  return {
    ok: false,
    fail_closed: true,
    code,
    errors: errors || [code],
  };
}

/**
 * Classify a candidate evidence package.
 * Independent same-ID probes across unrelated ingresses are NEVER E2E.
 */
function classifyEvidenceClaim(candidate) {
  const c = candidate || {};
  const errors = [];
  const claim = String(c.claim_class || '');

  if (FORBIDDEN_AS_E2E_EVIDENCE.includes(claim)) {
    return failClosed('independent_same_id_probes_rejected_as_e2e', [
      `claim_class=${claim} is not causal E2E evidence`,
    ]);
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
  if (c.treats_tracked_caddy_as_live_authority === true) {
    errors.push('tracked_caddy_is_stale_not_authority');
  }
  if (c.invented_burst_parent === true || c.invented_single_parent_for_burst === true) {
    errors.push('invented_burst_parent_forbidden');
  }
  if (c.dispersed_suppression_lists_as_sole_control === true) {
    errors.push('dispersed_suppression_lists_rejected');
  }
  if (c.incomplete_mutation_adapter_inventory === true) {
    errors.push('incomplete_mutation_adapter_inventory');
  }
  if (
    c.claims_inbound_trace_wamid_payment_join_today === true
    || c.claims_g01b_trace_wamid_propagation_today === true
  ) {
    errors.push('trace_wamid_payment_overclaim');
  }
  if (c.claims_dry_run_implementable_today === true) {
    errors.push('dry_run_not_implementable_yet');
  }

  if (claim === 'g01a_meta_hermes_staff' || claim === G01A_BOUNDARY) {
    const isBurst = c.message_kind === 'coalesced_sunset_burst' || c.coalesced_burst === true;
    if (isBurst) {
      if (c.parent_event_id && !c.allow_invented_burst_parent) {
        errors.push('burst_must_not_invent_single_parent');
      }
      if (!Array.isArray(c.source_wamid_set) || c.source_wamid_set.length < 2) {
        errors.push('burst_requires_ordered_immutable_source_wamid_set');
      }
      if (c.source_wamid_set_mutable === true) {
        errors.push('source_wamid_set_must_be_immutable');
      }
    } else if (!c.single_trace_id || !c.parent_event_id) {
      errors.push('g01a_requires_trace_id_and_parent_event_id');
    }
    if (c.causal_chain !== true) {
      errors.push('g01a_requires_causal_chain');
    }
    if (c.mutation_performed === true) {
      errors.push('g01a_design_target_is_non_mutating');
    }
  }

  if (claim === 'g01b_stripe_business_join' || claim === G01B_BOUNDARY) {
    if (c.inbound_trace_id_propagation === true || c.inbound_wamid_propagation === true) {
      errors.push('trace_wamid_payment_overclaim');
    }
    if (c.correlation_today && c.correlation_today !== G01B_CORRELATION_TODAY) {
      errors.push('g01b_correlation_today_must_be_metadata_only');
    }
  }

  if (errors.length) {
    return failClosed(errors[0], errors);
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
      note: 'G01-B today is tenant/payment/booking/session metadata only; mutating Checkout required to exercise',
    };
  }

  return failClosed('unknown_claim_class', [`unknown claim_class=${claim}`]);
}

/**
 * Reject designs that treat the tracked Caddy reference as live authority.
 */
function classifyIngressAuthorityClaim(candidate) {
  const c = candidate || {};
  if (c.authority_source === 'tracked_caddy_reference'
    || c.authority_source === 'docker/hermes-staging/lunabox-caddyfile.reference'
    || c.authority_source === 'scripts/_lunabox-caddyfile') {
    return failClosed('stale_caddy_authority_rejected', [
      'tracked Caddy reference is stale evidence, not live authority',
    ]);
  }
  if (c.whatsapp_upstream === 'localhost:8090' && c.claims_live === true) {
    return failClosed('stale_caddy_authority_rejected', [
      'live /whatsapp/* is localhost:8092 hermes-sunset-luna',
    ]);
  }
  if (
    c.whatsapp_upstream === LIVE_CADDY_ROUTES.whatsapp.upstream
    && c.wolfhouse_upstream === LIVE_CADDY_ROUTES.wolfhouse.upstream
    && c.tracked_caddy_status === TRACKED_CADDY_STATUS
  ) {
    return {
      ok: true,
      code: 'live_caddy_authority_accepted',
    };
  }
  return failClosed('ingress_authority_incomplete', [
    'require live /whatsapp→8092, /wolfhouse→8090, tracked=stale',
  ]);
}

/**
 * Reject invented single parent for coalesced Sunset bursts.
 */
function classifyBurstProvenance(candidate) {
  const c = candidate || {};
  if (c.message_kind !== 'coalesced_sunset_burst' && c.coalesced_burst !== true) {
    if (c.parent_event_id && !c.source_wamid_set) {
      return { ok: true, code: 'single_message_wamid_parent_accepted' };
    }
    return failClosed('provenance_shape_unknown', ['expected single or coalesced burst']);
  }
  if (c.parent_event_id || c.invented_single_parent === true) {
    return failClosed('invented_burst_parent_rejected', [
      'coalesced burst must use ordered immutable source-wamid set; no invented single parent',
    ]);
  }
  if (!Array.isArray(c.source_wamid_set) || c.source_wamid_set.length < 2) {
    return failClosed('burst_source_wamid_set_required', [
      'ordered immutable source-wamid set required',
    ]);
  }
  if (c.source_wamid_set_mutable === true) {
    return failClosed('source_wamid_set_must_be_immutable', [
      'source-wamid set must be immutable',
    ]);
  }
  return { ok: true, code: 'burst_source_wamid_set_accepted' };
}

/**
 * Reject dry-run designs that rely on dispersed suppression lists or incomplete
 * mutation-adapter inventories, or that claim implementable without a central
 * capability boundary.
 */
function classifyCapabilityBoundaryDesign(candidate) {
  const c = candidate || {};
  if (c.implementable_today === true && c.central_capability_boundary !== true) {
    return failClosed('dry_run_not_implementable_yet', [
      'dry-run is not implementable before central capability boundary',
    ]);
  }
  if (c.dispersed_suppression_lists_as_sole_control === true) {
    return failClosed('dispersed_suppression_lists_rejected', [
      'dispersed suppression lists are not the control plane',
    ]);
  }
  if (c.incomplete_mutation_adapter_inventory === true) {
    return failClosed('incomplete_mutation_adapter_inventory', [
      'mutation-adapter inventory must be complete under central boundary',
    ]);
  }
  if (
    c.central_capability_boundary === true
    && c.denies_every_whatsapp_send === true
    && c.denies_every_staff_db_stripe_mutation === true
    && c.permits_real_read_dispatch === true
    && c.incomplete_mutation_adapter_inventory !== true
    && c.dispersed_suppression_lists_as_sole_control !== true
  ) {
    return {
      ok: true,
      code: 'capability_boundary_shape_accepted',
      note: 'Shape only — 16U does not implement; 16V audits/freezes this boundary',
    };
  }
  return failClosed('capability_boundary_incomplete', [
    'require central deny-send+deny-mutation+permit-read boundary',
  ]);
}

/**
 * Reject G01-B overclaims that inbound trace/wamid payment join exists today.
 */
function classifyG01BCorrelationClaim(candidate) {
  const c = candidate || {};
  if (
    c.inbound_trace_id_propagation === true
    || c.inbound_wamid_propagation === true
    || c.claims_trace_wamid_payment_join_today === true
  ) {
    return failClosed('trace_wamid_payment_overclaim', [
      'G01-B today is tenant/payment/booking/session metadata only',
    ]);
  }
  const keys = Array.isArray(c.join_keys_today) ? c.join_keys_today : [];
  const missing = G01B_JOIN_KEYS_TODAY.filter((k) => !keys.includes(k));
  if (
    c.correlation_today === G01B_CORRELATION_TODAY
    && missing.length === 0
    && c.inbound_trace_id_propagation === false
    && c.inbound_wamid_propagation === false
  ) {
    return { ok: true, code: 'g01b_metadata_only_accepted' };
  }
  return failClosed('g01b_correlation_incomplete', [
    'require metadata-only join keys and explicit false inbound trace/wamid',
  ]);
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
  G01B_CORRELATION_TODAY,
  NEXT_SLICE_ID,
  LIVE_CADDY_ROUTES,
  TRACKED_CADDY_STATUS,
  FORBIDDEN_AS_E2E_EVIDENCE,
  EXPLICITLY_NOT_CLAIMED,
  GATES_UNCHANGED,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  REQUIRED_INSTRUMENTATION_POINTS,
  G01B_JOIN_KEYS_TODAY,
  classifyEvidenceClaim,
  classifyIngressAuthorityClaim,
  classifyBurstProvenance,
  classifyCapabilityBoundaryDesign,
  classifyG01BCorrelationClaim,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
